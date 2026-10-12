'use strict';
/*
 * Tech council: persistence and shared state.
 *
 * Everything lives in two stores, separate from Bitrix snapshots:
 *   council       orders ("order:TS-…"), meetings ("meeting:YYYY-MM-DD"), imports ("import:<hash>"), settings ("settings:main").
 *                 Every record has a "rev". A write names the rev it was based on; if somebody saved in between, nothing is written
 *                 and the caller gets the current versions back, merges and tries again (optimistic locking, all-or-nothing batches).
 *   councilfiles  attached files (protocols, the imported registry itself), content-addressed, written as they are.
 * The same rules run on the shared Node server and in the browser's IndexedDB, so the two modes behave alike.
 */

const COUNCIL_STORE = 'council';
const COUNCIL_FILES = 'councilfiles';
const COUNCIL_REVISIONED = new Set([COUNCIL_STORE]);
const COUNCIL_SCHEMA = 1;
const COUNCIL_FILE_LIMIT = 8 * 1024 * 1024;

function councilBlank() {
  return {
    loaded: false, loading: false, error: '', stale: false,
    orders: [], meetings: [], imports: [],
    settings: { id: 'settings:main', kind: 'settings', rev: 0, schema: COUNCIL_SCHEMA, projectMap: {}, dismissedDeps: {} },
    ui: { tab: 'overview', filter: { project: '', owner: '', state: 'open', q: '' }, orderSel: '', edit: null, pending: null, meetingSel: 0, meetingDate: '', draftDirty: null, conflict: null, agendaDate: '' }
  };
}

/* ---------- pure: batch rules shared by the browser store (and mirrored by server/server.js) ---------- */

/**
 * writes: [{ store, key, value, expectedRev, delete }]. currentOf(store, key) returns the stored record or null.
 * Returns { conflicts, stamped, revs }. Nothing is stamped when anything conflicts.
 */
function councilCheckBatch(writes, currentOf, now) {
  const conflicts = [];
  const stamped = [];
  const revs = {};
  writes.forEach(w => {
    if (!COUNCIL_REVISIONED.has(w.store)) { stamped.push({ ...w }); return; }
    const current = currentOf(w.store, w.key) || null;
    const currentRev = current ? Number(current.rev || 0) : 0;
    const expected = Number(w.expectedRev || 0);
    if (currentRev !== expected || (current && expected === 0 && !w.delete)) { conflicts.push({ store: w.store, key: w.key, expected, current }); return; }
    stamped.push({ ...w, value: w.delete ? undefined : { ...w.value, rev: expected + 1, savedAt: now || new Date().toISOString() } });
    revs[w.key] = expected + 1;
  });
  return { conflicts, stamped: conflicts.length ? [] : stamped, revs: conflicts.length ? {} : revs };
}

/** Brings an older record up to the current shape. Never drops data. Unknown kinds are kept out of the lists but not deleted. */
function councilUpgrade(record) {
  if (!record || typeof record !== 'object' || !record.id) return null;
  const rec = record;
  rec.schema = rec.schema || 1;
  rec.rev = Number(rec.rev || 0);
  if (rec.kind === 'order') {
    rec.events = Array.isArray(rec.events) ? rec.events : [];
    rec.blocks = Array.isArray(rec.blocks) ? rec.blocks : [];
    rec.updates = Array.isArray(rec.updates) ? rec.updates : [];
    rec.by = rec.by && typeof rec.by === 'object' ? rec.by : {};
    rec.owners = rec.owners || { raw: '', state: 'none', people: [], decider: '', joint: false, notes: [] };
    rec.due = rec.due || { raw: '', kind: 'none', date: '', items: [], note: '', inferred: false };
    rec.source = rec.source || { importId: '', row: 0, last: {}, seenAt: [] };
    rec.statusTags = rec.statusTags || [];
  } else if (rec.kind === 'meeting') {
    rec.agendaMeta = rec.agendaMeta || { excluded: {}, order: [], manual: [] };
    rec.agendaMeta.excluded = rec.agendaMeta.excluded || {};
    rec.agendaMeta.order = rec.agendaMeta.order || [];
    rec.agendaMeta.manual = rec.agendaMeta.manual || [];
    rec.protocol = rec.protocol || { text: '', files: [] };
    rec.protocol.files = rec.protocol.files || [];
    if (rec.status === 'imported') rec.status = 'planned';
  } else if (rec.kind === 'settings') {
    rec.projectMap = rec.projectMap || {};
    rec.dismissedDeps = rec.dismissedDeps || {};
  }
  return rec;
}

/* ---------- base64 for files kept inside JSON records ---------- */

function councilBytesToB64(bytes) {
  const data = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < data.length; i += 0x8000) out += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
  return btoa(out);
}

function councilB64ToBytes(text) {
  const raw = atob(text || '');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A file record, addressed by its content. The same file attached twice is one record. */
function councilFileRecord(name, type, bytes, now) {
  const hash = councilSha256(bytes);
  return { id: 'file:' + hash.slice(0, 24), kind: 'file', name, type: type || 'application/octet-stream', size: bytes.length, hash, addedAt: now || new Date().toISOString(), data: councilBytesToB64(bytes) };
}

function councilFileMeta(record, by) {
  return { id: record.id, name: record.name, type: record.type, size: record.size, addedAt: record.addedAt, by: by || '' };
}

/* ---------- backend: shared server or this browser's IndexedDB ---------- */

const councilBackend = {
  async read(store, key) {
    return state.sharedMode ? await sharedRequest(`/api/store/${encodeURIComponent(store)}/${encodeURIComponent(key)}`) : await localGetRecord(store, key);
  },
  async list(store) {
    return state.sharedMode ? await sharedRequest(`/api/store/${encodeURIComponent(store)}`) : await localGetAllRecords(store);
  },
  async batch(writes) {
    return state.sharedMode ? await councilSharedBatch(writes) : await councilLocalBatch(writes);
  }
};

async function councilSharedBatch(writes) {
  const before = state.sharedRevision;
  const response = await fetch('/api/council/batch', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  const revision = Number(response.headers.get('x-coordination-revision') || 0);
  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, conflicts: body.conflicts || [] };
  }
  if (!response.ok) throw new Error((await response.text().catch(() => '')) || `Общий сервер ответил ${response.status}`);
  const body = await response.json();
  /* a revision that jumped by more than our own write means somebody else saved meanwhile: let the next poll reload everything */
  if (revision) state.sharedRevision = revision === before + 1 ? revision : before;
  return { ok: true, revs: body.revs || {} };
}

function councilLocalBatch(writes) {
  return new Promise((resolve, reject) => {
    const names = [...new Set(writes.map(w => w.store))];
    const tx = state.localDb.transaction(names, 'readwrite');
    const current = new Map();
    let pending = writes.length;
    let outcome = null;
    const decide = () => {
      const out = councilCheckBatch(writes, (s, k) => current.get(s + '\u0000' + k), new Date().toISOString());
      if (out.conflicts.length) { outcome = { ok: false, conflicts: out.conflicts }; return; }
      out.stamped.forEach(w => { const os = tx.objectStore(w.store); if (w.delete) os.delete(w.key); else os.put(w.value); });
      outcome = { ok: true, revs: out.revs };
    };
    writes.forEach(w => {
      const rq = tx.objectStore(w.store).get(w.key);
      rq.onsuccess = () => { current.set(w.store + '\u0000' + w.key, rq.result || null); if (--pending === 0) decide(); };
      rq.onerror = () => reject(rq.error);
    });
    tx.oncomplete = () => resolve(outcome || { ok: false, conflicts: [], error: 'Транзакция не выполнена' });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Запись в базу браузера отменена'));
  });
}

/* ---------- loading ---------- */

async function councilLoad() {
  const c = state.council;
  c.loading = true;
  try {
    const rows = await councilBackend.list(COUNCIL_STORE);
    const orders = [], meetings = [], imports = [];
    let settings = null;
    (rows || []).forEach(raw => {
      const rec = councilUpgrade(raw);
      if (!rec) return;
      if (rec.kind === 'order') orders.push(rec);
      else if (rec.kind === 'meeting') meetings.push(rec);
      else if (rec.kind === 'import') imports.push(rec);
      else if (rec.kind === 'settings') settings = rec;
    });
    orders.sort((a, b) => Number(a.no || 99999) - Number(b.no || 99999) || String(a.createdAt).localeCompare(String(b.createdAt)));
    meetings.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    imports.sort((a, b) => String(a.asOf).localeCompare(String(b.asOf)) || String(a.importedAt).localeCompare(String(b.importedAt)));
    c.orders = orders; c.meetings = meetings; c.imports = imports;
    if (settings) c.settings = settings;
    c.loaded = true; c.error = ''; c.stale = false;
  } catch (error) {
    console.error(error);
    c.error = error.message || String(error);
  } finally {
    c.loading = false;
  }
  return c;
}

function councilOrder(id) { return state.council.orders.find(o => o.orderId === id) || null; }
function councilMeetingById(id) { return state.council.meetings.find(m => m.id === id) || null; }
function councilMeetingByDate(date) { return state.council.meetings.find(m => m.date === date) || null; }

function councilPutCache(record) {
  const c = state.council;
  const list = record.kind === 'order' ? c.orders : record.kind === 'meeting' ? c.meetings : record.kind === 'import' ? c.imports : null;
  if (record.kind === 'settings') { c.settings = record; return; }
  if (!list) return;
  const at = list.findIndex(x => x.id === record.id);
  if (at >= 0) list[at] = record; else list.push(record);
  if (record.kind === 'meeting') list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (record.kind === 'import') list.sort((a, b) => String(a.asOf).localeCompare(String(b.asOf)));
}

/* ---------- writing ---------- */

/**
 * Saves records in one all-or-nothing batch. items: [{ store?, record, delete? }]; record.rev is the revision it was built on.
 * Returns { ok:true, saved:[records] } or { ok:false, conflicts:[{key,current}] } or { ok:false, error }.
 */
async function councilCommit(items) {
  const writes = items.map(it => {
    const store = it.store || COUNCIL_STORE;
    const record = it.record;
    return { store, key: record.id, value: it.delete ? undefined : record, expectedRev: Number(record.rev || 0), delete: Boolean(it.delete) };
  });
  let res;
  try { res = await councilBackend.batch(writes); }
  catch (error) { console.error(error); return { ok: false, error: error.message || String(error) }; }
  if (!res.ok) return { ok: false, conflicts: res.conflicts || [], error: res.error || '' };
  const saved = [];
  items.forEach(it => {
    if ((it.store || COUNCIL_STORE) !== COUNCIL_STORE || it.delete) return;
    const rec = { ...it.record, rev: res.revs[it.record.id], savedAt: new Date().toISOString() };
    councilPutCache(rec);
    saved.push(rec);
  });
  return { ok: true, saved };
}

async function councilReadFresh(keys) {
  const found = new Map();
  await Promise.all(keys.map(async key => { found.set(key, councilUpgrade(await councilBackend.read(COUNCIL_STORE, key))); }));
  return found;
}

/**
 * Runs a change against the freshest versions of the records it touches and saves it. build(current) must be a pure function of the
 * records it is given: after a conflict it runs again on the newer versions (this is the merge). It returns
 *   null                                  nothing to save
 *   { records:[…], files:[…], value }     records to write (new ones with rev 0), file records to add
 *   { abort: true, reason, details }      stop and tell the caller (for example a field-level conflict that needs a person)
 */
async function councilMutate(keys, build, opts = {}) {
  const attempts = opts.attempts || 4;
  let lastConflict = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let current;
    try { current = await councilReadFresh(keys); } catch (error) { return { ok: false, error: error.message || String(error) }; }
    const out = build(current);
    if (!out) return { ok: true, nothing: true };
    if (out.abort) return { ok: false, aborted: true, reason: out.reason || '', details: out.details };
    const items = [...(out.files || []).map(record => ({ store: COUNCIL_FILES, record })), ...(out.records || []).map(record => ({ record }))];
    if (!items.length) return { ok: true, nothing: true, value: out.value };
    const res = await councilCommit(items);
    if (res.ok) return { ok: true, saved: res.saved, value: out.value, attempts: attempt + 1 };
    if (!res.conflicts) return res;
    lastConflict = res.conflicts;
    res.conflicts.forEach(cf => { if (cf.current) councilPutCache(councilUpgrade(cf.current)); });
  }
  return { ok: false, conflict: true, conflicts: lastConflict || [] };
}

/* ---------- field-level conflicts for manual edits ---------- */

const COUNCIL_EDIT_FIELDS = {
  title: { label: 'Формулировка', get: o => o.title || '' },
  result: { label: 'Ожидаемый результат', get: o => o.result || '' },
  blockerRaw: { label: 'Блокер', get: o => o.blockerRaw || '' },
  comment: { label: 'Комментарий', get: o => o.comment || '' },
  projectRaw: { label: 'Проект', get: o => o.projectRaw || '' },
  ownerText: { label: 'Ответственный', get: o => o.owners?.raw || '' },
  ownerName: { label: 'Ответственный', get: o => o.owners?.raw || '' },
  dueText: { label: 'Срок', get: o => o.due?.raw || '' },
  dueDate: { label: 'Срок', get: o => o.due?.raw || '' },
  critical: { label: 'Критичность', get: o => String(Boolean(o.critical)) },
  state: { label: 'Состояние', get: o => o.state || '' }
};

function councilPatchValue(key, value) {
  if (key === 'dueDate') return value ? cdFmtFull(value) : '';
  if (key === 'critical') return String(Boolean(value));
  return String(value ?? '');
}

/**
 * base: the order as the person saw it when the form opened. current: the order now. patch: what the person changed.
 * A field conflicts when somebody else changed it since base AND to something different from what the person typed.
 * resolution: { field: 'mine' | 'theirs' } for conflicts the person already decided.
 */
function councilEditConflicts(base, current, patch, resolution = {}) {
  const conflicts = [];
  const apply = {};
  Object.keys(patch).forEach(key => {
    const spec = COUNCIL_EDIT_FIELDS[key];
    if (!spec) return;
    const mine = councilPatchValue(key, patch[key]);
    const was = spec.get(base), now = spec.get(current);
    const theirsChanged = councilNorm(was) !== councilNorm(now) || was !== now;
    if (!theirsChanged || councilNorm(now) === councilNorm(mine)) { apply[key] = patch[key]; return; }
    const pick = resolution[key];
    if (pick === 'mine') apply[key] = patch[key];
    else if (pick === 'theirs') return;
    else conflicts.push({ key, label: spec.label, mine, theirs: now, base: was });
  });
  return { conflicts, apply };
}

/** Saves a manual edit of one order, merging with whatever others saved meanwhile. */
async function councilSaveEdit(orderId, base, patch, ctx, resolution = {}) {
  const key = 'order:' + orderId;
  const res = await councilMutate([key], current => {
    const order = current.get(key);
    if (!order) return { abort: true, reason: 'missing' };
    const { conflicts, apply } = councilEditConflicts(base, order, patch, resolution);
    if (conflicts.length) return { abort: true, reason: 'field-conflict', details: { conflicts, current: order } };
    const out = councilEdit(order, apply, ctx);
    if (!out.changed.length) return null;
    return { records: [out.order], value: out };
  });
  return res;
}

/* ---------- meeting drafts: merge, so two people can type in the same meeting ---------- */

/**
 * remote: the draft as it is stored now. local: this browser's draft. dirty: { items:{id:true}, notes:bool, newOrders:bool, removed:[uid] }.
 * Items this browser touched win; everything else stays as others wrote it.
 */
function councilMergeDraft(remote, local, dirty, now) {
  const out = councilClone(remote || councilEmptyDraft());
  out.items = out.items || {};
  Object.keys(dirty.items || {}).forEach(id => { if (local.items[id]) out.items[id] = councilClone(local.items[id]); });
  if (dirty.notes) out.notes = local.notes || '';
  if (dirty.newOrders) {
    const byUid = new Map((out.newOrders || []).map(n => [n.uid, n]));
    (local.newOrders || []).forEach(n => byUid.set(n.uid, councilClone(n)));
    (dirty.removed || []).forEach(uid => byUid.delete(uid));
    out.newOrders = [...byUid.values()];
  }
  out.updatedAt = now || new Date().toISOString();
  return out;
}

/* ---------- local backup of a draft: survives a dead connection and a page refresh ---------- */

function councilBackupKey(meetingId) { return 'coordination.council.draft.' + meetingId; }

function councilBackupSave(meetingId, draft) {
  try { localStorage.setItem(councilBackupKey(meetingId), JSON.stringify({ at: new Date().toISOString(), draft })); } catch (_) {}
}

function councilBackupLoad(meetingId) {
  try { const raw = localStorage.getItem(councilBackupKey(meetingId)); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
}

function councilBackupClear(meetingId) {
  try { localStorage.removeItem(councilBackupKey(meetingId)); } catch (_) {}
}

/** Draft items in the backup that are newer than what the server has: they were typed but never saved. */
function councilDraftUnsaved(serverDraft, backup) {
  if (!backup?.draft) return { items: {}, notes: false, newOrders: false, count: 0 };
  const items = {};
  Object.entries(backup.draft.items || {}).forEach(([id, item]) => {
    const theirs = serverDraft?.items?.[id];
    if (!councilDraftTouched(item)) return;
    if (!theirs || String(item.updatedAt || '') > String(theirs.updatedAt || '')) items[id] = true;
  });
  const notes = Boolean((backup.draft.notes || '').trim()) && (backup.draft.notes || '') !== (serverDraft?.notes || '') && String(backup.draft.updatedAt || backup.at || '') > String(serverDraft?.updatedAt || '');
  const have = new Set((serverDraft?.newOrders || []).map(n => n.uid));
  const newOrders = (backup.draft.newOrders || []).some(n => !have.has(n.uid));
  return { items, notes, newOrders, count: Object.keys(items).length + (notes ? 1 : 0) + (newOrders ? 1 : 0) };
}

/* ---------- import: one batch, with the file itself kept as a source ---------- */

/** What a plan would do, as a short fingerprint: if it differs at commit time, the person looks at the preview again. */
function councilPlanSignature(plan) {
  return councilFnv(JSON.stringify(plan.items.map(i => [i.rowIndex, i.verdict, i.orderId || '', i.same ? 1 : 0, (i.changes || []).map(c => c.field + ':' + c.mode)])) + '|' + plan.missing.length);
}

/**
 * Applies an import. The plan is computed again against the freshest data first: if a colleague changed anything the file touches since
 * the preview was shown, nothing is written and the person is asked to look at the preview again. Orders, the import record and the
 * source file go in one all-or-nothing batch.
 */
async function councilCommitImport(parsed, previewPlan, decisions, ctx, fileInfo, fileBytes) {
  await councilLoad();
  const importKey = 'import:' + fileInfo.hash.slice(0, 24);
  const plan = councilPlanImport(parsed, state.council.orders, { ...ctx, importId: importKey });
  if (councilPlanSignature(plan) !== councilPlanSignature(previewPlan)) return { ok: false, aborted: true, reason: 'plan-changed' };
  const baseRevs = new Map(state.council.orders.map(o => [o.orderId, o.rev]));
  const touched = [...new Set(plan.items.map(i => i.orderId).filter(Boolean).concat(Object.values(decisions.matches || {}).filter(v => v && v !== 'new')))];
  const file = fileBytes ? councilFileRecord(fileInfo.fileName, fileInfo.mime || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileBytes, ctx.now) : null;
  return councilMutate([importKey, ...touched.map(id => 'order:' + id)], current => {
    if (current.get(importKey)) return { abort: true, reason: 'already-imported', details: { import: current.get(importKey) } };
    const orders = touched.map(id => current.get('order:' + id)).filter(Boolean);
    if (orders.some(o => o.rev !== baseRevs.get(o.orderId))) return { abort: true, reason: 'plan-changed' };
    const out = councilApplyImport(plan, decisions, { ...ctx, orders, importId: importKey }, fileInfo);
    const records = [...out.orders, { ...out.importRecord, fileId: file?.id || '' }];
    return { records, files: file ? [file] : [], value: out };
  });
}

/* ---------- local IndexedDB to the shared server, once ---------- */

async function councilMigrateLocalToShared() {
  if (!state.sharedMode || !state.localDb) return { moved: 0 };
  let local = [];
  try { local = await localGetAllRecords(COUNCIL_STORE); } catch (_) { return { moved: 0 }; }
  if (!local.length) return { moved: 0 };
  const shared = await councilBackend.list(COUNCIL_STORE);
  if ((shared || []).length) return { moved: 0 };
  let moved = 0;
  for (let i = 0; i < local.length; i += 100) {
    const chunk = local.slice(i, i + 100).map(r => ({ store: COUNCIL_STORE, key: r.id, value: { ...r }, expectedRev: 0 }));
    const res = await councilBackend.batch(chunk);
    if (!res.ok) throw new Error('Не удалось перенести поручения на общий сервер');
    moved += chunk.length;
  }
  try {
    const files = await localGetAllRecords(COUNCIL_FILES);
    for (const f of files) await councilBackend.batch([{ store: COUNCIL_FILES, key: f.id, value: f, expectedRev: 0 }]);
  } catch (_) {}
  return { moved };
}

/* ---------- files ---------- */

async function councilGetFile(id) {
  return await councilBackend.read(COUNCIL_FILES, id);
}
