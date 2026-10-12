'use strict';
/*
 * Tech council model, part 2: matching a new registry file with what is already known, the import plan and its application,
 * manual edits, confirmations, blocks and statistics. Pure functions: orders in, orders out. Storage lives elsewhere.
 */

/* ---------- sha-256 for the "this file was already imported" check (crypto.subtle is missing on plain http over LAN) ---------- */

const COUNCIL_SHA_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

function councilSha256(bytes) {
  const data = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const total = data.length;
  const padded = new Uint8Array(((total + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[total] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((total * 8) / 4294967296), false);
  view.setUint32(padded.length - 4, (total * 8) >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + COUNCIL_SHA_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('');
}

/* ---------- small helpers ---------- */

function councilClone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function councilNorm(text) { return normalizeHeader(text).replace(/[^a-zа-я0-9]+/g, ' ').trim(); }

function councilPushEvent(order, event) {
  order.events = order.events || [];
  if (event.id && order.events.some(e => e.id === event.id)) return false;
  order.events.push(event);
  order.updatedAt = event.at || order.updatedAt;
  return true;
}

function councilEventsSorted(order) {
  return [...(order.events || [])].sort((a, b) => String(a.asOf || a.at || '').localeCompare(String(b.asOf || b.at || '')) || String(a.at).localeCompare(String(b.at)));
}

const COUNCIL_FIELD_LABELS = { title: 'Формулировка', project: 'Проект', owner: 'Ответственный', result: 'Ожидаемый результат', due: 'Срок', status: 'Статус', blocker: 'Блокер', comment: 'Комментарий', state: 'Состояние' };

/** Text of a field as it is in the order now, in the same terms as the registry columns. */
function councilFieldText(order, field) {
  return { title: order.title, project: order.projectRaw, owner: order.owners?.raw, result: order.result, due: order.due?.raw, status: order.statusRaw, blocker: order.blockerRaw }[field] || '';
}
const COUNCIL_ROW_FIELDS = { title: 'title', project: 'project', owner: 'owner', result: 'result', due: 'dueText', status: 'status', blocker: 'blocker' };
const COUNCIL_BY_KEY = { title: 'title', project: 'project', owner: 'owners', result: 'result', due: 'due', status: 'state', blocker: 'blocker' };

/* ---------- matching rows with known orders ---------- */

/**
 * Matches registry rows with stored orders. Never merges on a guess:
 *  - "id": the file carries the permanent ID (our own export);
 *  - "key": the same project and the same formulation, and nothing else claims it;
 *  - "fuzzy": similar wording, shown to the person as a question.
 * Rows with nothing similar are "new". Orders no row points to are "missing": that proves nothing, they stay open.
 */
function councilMatchRows(rows, orders) {
  const byId = new Map(orders.map(o => [o.orderId, o]));
  const claimed = new Map();
  const result = new Map();
  const claim = (row, order, by, score) => { claimed.set(order.orderId, row.rowIndex); result.set(row.rowIndex, { by, order, score, candidates: [] }); };
  rows.forEach(row => {
    const id = councilIsOrderId(row.id) ? row.id.trim().toUpperCase() : '';
    const order = id ? byId.get(id) : null;
    if (order && !claimed.has(order.orderId)) claim(row, order, 'id', 1);
  });
  const byKey = new Map();
  orders.forEach(o => { const k = councilKey(o.projectRaw, o.title); (byKey.get(k) || byKey.set(k, []).get(k)).push(o); });
  rows.forEach(row => {
    if (result.has(row.rowIndex)) return;
    const list = (byKey.get(councilKey(row.project, row.title)) || []).filter(o => !claimed.has(o.orderId));
    if (list.length) claim(row, list[0], 'key', 1);
  });
  const free = orders.filter(o => !claimed.has(o.orderId));
  const pairs = [];
  rows.forEach(row => {
    if (result.has(row.rowIndex)) return;
    const candidates = free.map(o => {
      let score = councilSimilarity(row.title, o.title);
      if (projectKey(row.project) === projectKey(o.projectRaw)) score = Math.min(1, score + 0.05);
      return { orderId: o.orderId, score: Math.round(score * 100) / 100, title: o.title, projectRaw: o.projectRaw, no: o.no };
    }).filter(c => c.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 3);
    if (candidates.length) pairs.push({ row, candidates });
  });
  pairs.forEach(({ row, candidates }) => {
    const best = candidates[0];
    const second = candidates[1];
    const confident = best.score >= 0.75 && (!second || best.score - second.score >= 0.12);
    result.set(row.rowIndex, { by: 'fuzzy', order: confident ? byId.get(best.orderId) : null, score: best.score, candidates, suggested: confident ? best.orderId : '' });
  });
  const missing = orders.filter(o => !claimed.has(o.orderId) && !pairs.some(p => p.candidates.some(c => c.orderId === o.orderId)));
  return { result, missing };
}

function councilChangesFor(order, row, ctx) {
  const last = order.source?.last || {};
  const changes = [];
  Object.keys(COUNCIL_ROW_FIELDS).forEach(field => {
    const incoming = String(row[COUNCIL_ROW_FIELDS[field]] ?? '');
    const before = String(last[field === 'project' ? 'project' : field === 'due' ? 'due' : field] ?? '');
    if (councilNorm(incoming) === councilNorm(before)) return;
    const current = councilFieldText(order, field);
    const key = COUNCIL_BY_KEY[field];
    let mode = 'apply';
    if (!incoming.trim()) mode = 'ignore-empty';
    else if (councilNorm(current) === councilNorm(incoming)) mode = 'same';
    else if (order.state === 'done' && (field === 'status' || field === 'blocker')) mode = 'note';
    else if ((order.by || {})[key] && order.by[key] !== 'import' && councilNorm(current) !== councilNorm(incoming)) mode = 'conflict';
    changes.push({ field, label: COUNCIL_FIELD_LABELS[field], from: current, to: incoming, mode, fileBefore: before });
  });
  return changes;
}

/**
 * What would happen if this file were imported. Changes nothing.
 * parsed: result of councilParseRegistry. orders: stored orders. ctx: { asOf, now, projectMap }.
 */
function councilPlanImport(parsed, orders, ctx) {
  const { result, missing } = councilMatchRows(parsed.rows, orders);
  const taken = new Set(orders.map(o => o.orderId));
  const items = parsed.rows.map(row => {
    const m = result.get(row.rowIndex);
    const values = councilRowValues(row, ctx);
    const base = { rowIndex: row.rowIndex, row, project: values.project, owners: values.owners, due: values.due, status: values.status, warnings: [], candidates: [], changes: [], newUpdates: 0, same: false };
    if (!m) {
      const wanted = councilIsOrderId(row.id) ? row.id.trim().toUpperCase() : '';
      const proposedId = wanted && !taken.has(wanted) ? wanted : councilNewId(taken);
      taken.add(proposedId);
      return { ...base, verdict: 'new', proposedId };
    }
    if (m.by === 'fuzzy' && !m.suggested) {
      const proposedId = councilNewId(taken);
      taken.add(proposedId);
      return { ...base, verdict: 'ambiguous', matchedBy: 'fuzzy', score: m.score, candidates: m.candidates, orderId: '', proposedId, choice: 'new' };
    }
    if (m.by === 'fuzzy') {
      const proposedId = councilNewId(taken);
      taken.add(proposedId);
      return { ...base, verdict: 'ambiguous', matchedBy: 'fuzzy', score: m.score, candidates: m.candidates, orderId: m.order.orderId, proposedId, choice: m.order.orderId, changes: councilChangesFor(m.order, row, ctx) };
    }
    const changes = councilChangesFor(m.order, row, ctx);
    const known = new Set((m.order.updates || []).map(u => u.key));
    const newUpdates = (row.updates || []).filter(u => !known.has(councilUpdateKey(ctx.importId, u.label, u.text))).length;
    return { ...base, verdict: 'match', matchedBy: m.by, score: m.score, orderId: m.order.orderId, changes, newUpdates, same: !changes.some(c => c.mode !== 'ignore-empty' && c.mode !== 'same') && !newUpdates };
  });
  const summary = {
    total: items.length,
    new: items.filter(i => i.verdict === 'new').length,
    ambiguous: items.filter(i => i.verdict === 'ambiguous').length,
    changed: items.filter(i => i.verdict === 'match' && !i.same).length,
    same: items.filter(i => i.verdict === 'match' && i.same).length,
    missing: missing.length
  };
  summary.nothingToDo = !summary.new && !summary.ambiguous && !summary.changed;
  return { items, missing: missing.map(o => ({ orderId: o.orderId, title: o.title, projectRaw: o.projectRaw, no: o.no })), summary };
}

function councilDefaultDecisions(plan) {
  const matches = {};
  plan.items.forEach(i => { if (i.verdict === 'ambiguous') matches[i.rowIndex] = i.choice || 'new'; });
  return { matches, conflicts: {}, skip: {}, projectMap: {} };
}

function councilApplyField(order, change, row, ctx, importId) {
  const { field } = change;
  const asOf = ctx.asOf;
  const evId = councilEventId('ev', importId, order.orderId, field);
  const event = councilNewEvent('import-update', ctx, { id: evId, by: 'import', field, label: change.label, from: change.from, to: change.to, asOf, importId });
  if (field === 'title') { order.title = row.title; }
  else if (field === 'project') { const p = councilProjectFor(row.project, ctx.projectMap || {}); order.projectRaw = row.project; order.projectId = p.projectId; order.projectVia = p.via; }
  else if (field === 'owner') { order.owners = councilParseOwners(row.owner); }
  else if (field === 'result') { order.result = row.result; }
  else if (field === 'due') { const due = councilParseDue(row.dueCell ?? row.dueText, asOf); if (!due.raw) due.raw = row.dueText; order.due = due; }
  else if (field === 'blocker') { order.blockerRaw = row.blocker; }
  else if (field === 'status') {
    const st = councilParseStatus(row.status);
    order.statusRaw = row.status; order.critical = st.critical; order.claimedDone = st.claimedDone; order.statusTags = st.tags;
    if (order.state !== 'done' && order.state !== 'cancelled') {
      order.state = st.state;
      const manual = (order.blocks || []).filter(b => b.by !== 'import');
      order.blocks = [...manual, ...councilBlocksFromStatus(st, row.blocker || order.blockerRaw, { ...ctx, importId })];
    }
  }
  order.by = { ...(order.by || {}), [COUNCIL_BY_KEY[field]]: 'import' };
  councilPushEvent(order, event);
}

/**
 * Applies a plan with the person's decisions. Returns the records to save: changed or new orders and the import record
 * (the whole file kept as a version: it is the baseline of that registry date). Applying the same plan twice gives the same ids,
 * so nothing is duplicated.
 */
function councilApplyImport(plan, decisions, ctx, fileInfo = {}) {
  const importId = 'import:' + (fileInfo.hash || councilFnv(JSON.stringify(plan.items.map(i => i.row)))).slice(0, 24);
  const c = { ...ctx, importId };
  const orders = [];
  let created = 0, updated = 0, unchanged = 0, events = 0;
  const decide = decisions || councilDefaultDecisions(plan);
  const byId = new Map((ctx.orders || []).map(o => [o.orderId, o]));
  const orderIds = [];
  plan.items.forEach(item => {
    if ((decide.skip || {})[item.rowIndex]) return;
    let target = item.orderId;
    if (item.verdict === 'ambiguous') target = decide.matches?.[item.rowIndex] || 'new';
    if (item.verdict === 'new' || target === 'new') {
      const order = councilOrderFromRow(item.row, c, item.proposedId);
      orders.push(order); orderIds.push(order.orderId); created++; events += order.events.length;
      return;
    }
    const base = byId.get(target);
    if (!base) return;
    const order = councilClone(base);
    const changes = item.verdict === 'ambiguous' ? councilChangesFor(order, item.row, c) : item.changes;
    let touched = false;
    changes.forEach(change => {
      const pick = (decide.conflicts || {})[`${item.rowIndex}:${change.field}`];
      if (change.mode === 'apply' || (change.mode === 'conflict' && pick === 'file')) {
        if (change.mode === 'conflict') change.label += ' (по выбору: из файла)';
        councilApplyField(order, change, item.row, c, importId); touched = true; events++;
      } else if (change.mode === 'conflict' || change.mode === 'note') {
        const ev = councilNewEvent('source-note', c, { id: councilEventId('ev', importId, order.orderId, change.field, 'note'), by: 'import', field: change.field, label: change.label, from: change.from, to: change.to, asOf: c.asOf, importId, text: change.mode === 'note' ? 'В реестре изменилось, но поручение уже подтверждено как выполненное: оставлено как есть' : 'В реестре изменилось, но оставлено значение из Coordination' });
        if (councilPushEvent(order, ev)) { touched = true; events++; }
      }
    });
    const before = order.updates.length;
    councilAddUpdates(order, item.row, c);
    if (order.updates.length !== before) { touched = true; events += order.updates.length - before; }
    const seen = new Set([...(order.source?.seenAt || []), c.asOf]);
    order.source = { importId, row: item.row.rowIndex, last: councilSourceSnapshot(item.row), seenAt: [...seen] };
    if (item.verdict === 'ambiguous' && !(order.events || []).some(e => e.id === councilEventId('ev', importId, order.orderId, 'matched'))) {
      councilPushEvent(order, councilNewEvent('matched', c, { id: councilEventId('ev', importId, order.orderId, 'matched'), by: 'import', asOf: c.asOf, importId, text: 'Сопоставлено с строкой реестра вручную (формулировка изменилась)' })); touched = true; events++;
    }
    orderIds.push(order.orderId);
    if (touched) { orders.push(order); updated++; } else unchanged++;
  });
  const importRecord = {
    id: importId, kind: 'import', rev: 0,
    fileName: fileInfo.fileName || '', size: fileInfo.size || 0, hash: fileInfo.hash || '', sheetName: fileInfo.sheetName || '',
    importedAt: ctx.now, importedBy: ctx.by || '', asOf: ctx.asOf,
    columns: (fileInfo.columns || []).map(x => ({ index: x.index, header: x.header, role: x.role })),
    rowCount: plan.items.length,
    summary: { created, updated, unchanged, events, missing: plan.missing.length },
    rows: plan.items.map(i => ({ rowIndex: i.row.rowIndex, no: i.row.no, id: i.row.id, project: i.row.project, title: i.row.title, owner: i.row.owner, result: i.row.result, due: i.row.dueText, status: i.row.status, blocker: i.row.blocker, updates: i.row.updates, extra: i.row.extra })),
    orderIds
  };
  return { orders, importRecord, stats: { created, updated, unchanged, events } };
}

/* ---------- derived facts ---------- */

function councilIsOpen(order) { return order.state !== 'done' && order.state !== 'cancelled'; }
function councilActiveBlocks(order) { return (order.blocks || []).filter(b => b.active); }
function councilNeedsDecision(order) {
  if (!councilIsOpen(order)) return false;
  if (order.state === 'decision') return true;
  return order.state === 'blocked' && councilActiveBlocks(order).some(b => ['external', 'approval', 'finance'].includes(b.kind));
}
function councilIsOverdue(order, today) {
  if (!councilIsOpen(order)) return false;
  const d = councilDueDate(order.due);
  return Boolean(d) && !order.due.inferred && cdDiff(today, d) > 0;
}
function councilOverdueDays(order, today) { const d = councilDueDate(order.due); return d ? Math.max(0, cdDiff(today, d)) : 0; }
function councilGroupName(order) { return order.projectId ? itoProjectById(order.projectId)?.name || order.projectRaw : order.projectRaw || 'Без проекта'; }

function councilStats(orders, today) {
  const open = orders.filter(councilIsOpen);
  return {
    total: orders.length,
    open: open.length,
    needsDecision: open.filter(councilNeedsDecision).length,
    blocked: open.filter(o => o.state === 'blocked').length,
    overdue: open.filter(o => councilIsOverdue(o, today)).length,
    noOwner: open.filter(o => !councilHasOwner(o)).length,
    done: orders.filter(o => o.state === 'done' && o.done?.confirmed).length,
    critical: open.filter(o => o.critical).length
  };
}

function councilGroups(orders) {
  const groups = new Map();
  orders.forEach(o => {
    const key = o.projectId || 'raw:' + projectKey(o.projectRaw || 'Без проекта');
    if (!groups.has(key)) groups.set(key, { key, projectId: o.projectId || '', name: councilGroupName(o), orders: [] });
    groups.get(key).orders.push(o);
  });
  const rank = key => { const i = ITO_PROJECTS.findIndex(p => p.id === key); return i < 0 ? 1000 : i; };
  return [...groups.values()].sort((a, b) => rank(a.projectId) - rank(b.projectId));
}

function councilFilter(orders, f = {}) {
  const q = normalizeHeader(f.q || '');
  return orders.filter(o => {
    if (f.project && (o.projectId || 'raw:' + projectKey(o.projectRaw)) !== f.project) return false;
    if (f.owner === '__none__' && councilHasOwner(o)) return false;
    if (f.owner && f.owner !== '__none__' && !councilInvolvedNames(o).includes(f.owner)) return false;
    if (f.state && f.state !== 'all') {
      if (f.state === 'open' && !councilIsOpen(o)) return false;
      else if (f.state === 'needsDecision' && !councilNeedsDecision(o)) return false;
      else if (f.state === 'overdue' && !councilIsOverdue(o, f.today || cdLocalToday())) return false;
      else if (f.state === 'noOwner' && (councilHasOwner(o) || !councilIsOpen(o))) return false;
      else if (!['open', 'needsDecision', 'overdue', 'noOwner'].includes(f.state) && o.state !== f.state) return false;
    }
    if (q) {
      const hay = normalizeHeader([o.orderId, o.title, o.result, o.owners?.raw, o.blockerRaw, o.comment, o.statusRaw, o.due?.raw, ...(o.updates || []).map(u => u.text), ...(o.events || []).filter(e => e.type === 'decision').map(e => e.text)].join(' '));
      if (!q.split(' ').every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

/* ---------- edits (every edit leaves an event) ---------- */

function councilEdit(order, patch, ctx) {
  const next = councilClone(order);
  next.by = next.by || {};
  const by = ctx.by || 'user';
  const meta = { by, meetingId: ctx.meetingId || '', asOf: ctx.today || '' };
  // Inside a meeting the event id is fixed by (meeting, order, field): a retried close never writes the same change twice
  const log = (field, from, to, extra = {}) => councilPushEvent(next, councilNewEvent(extra.type || 'edit', ctx, { ...(ctx.meetingId ? { id: councilEventId('ev', ctx.meetingId, next.orderId, field) } : {}), ...meta, field, label: COUNCIL_FIELD_LABELS[field] || field, from, to, ...extra }));
  const changed = [];
  const setText = (field, key, getter, setter, value) => {
    const v = String(value ?? '').trim();
    const old = getter();
    if (councilNorm(v) === councilNorm(old) && v === old) return;
    setter(v); next.by[key] = by; log(field, old, v); changed.push(field);
  };
  if ('title' in patch) setText('title', 'title', () => next.title, v => { if (v) next.title = v; }, patch.title);
  if ('result' in patch) setText('result', 'result', () => next.result, v => { next.result = v; }, patch.result);
  if ('blockerRaw' in patch) setText('blocker', 'blocker', () => next.blockerRaw, v => { next.blockerRaw = v; }, patch.blockerRaw);
  if ('comment' in patch) setText('comment', 'comment', () => next.comment, v => { next.comment = v; }, patch.comment);
  if ('projectRaw' in patch) {
    const v = String(patch.projectRaw || '').trim();
    const pid = patch.projectId !== undefined ? patch.projectId : councilProjectFor(v, ctx.projectMap || {}).projectId;
    if (v !== next.projectRaw || pid !== next.projectId) { const old = next.projectRaw; next.projectRaw = v; next.projectId = pid || ''; next.projectVia = pid ? 'override' : 'direction'; next.by.project = by; log('project', old, v + (pid ? ` → ${itoProjectById(pid)?.name || pid}` : '')); changed.push('project'); }
  }
  if ('ownerName' in patch || 'ownerText' in patch) {
    const old = next.owners?.raw || '';
    let owners;
    if (patch.ownerName) owners = { raw: patch.ownerName, state: 'assigned', people: [{ raw: patch.ownerName, name: patch.ownerName, matched: true, confidence: 'exact', external: false, role: 'owner' }], decider: next.owners?.decider || '', joint: false, notes: [], by };
    else { owners = councilParseOwners(patch.ownerText || ''); owners.by = by; owners.decider = owners.decider || next.owners?.decider || ''; }
    if (owners.raw !== old || owners.state !== next.owners?.state) { next.owners = owners; next.by.owners = by; log('owner', old, owners.raw, { type: 'owner' }); changed.push('owner'); }
  }
  if ('dueText' in patch || 'dueDate' in patch) {
    const old = councilDueLabel(next.due);
    let due;
    if (patch.dueDate) { due = { raw: cdFmt(patch.dueDate), kind: patch.dueKind || 'exact', date: patch.dueDate, items: [], note: '', inferred: false }; due.raw = cdFmtFull(patch.dueDate); }
    else due = councilParseDue(patch.dueText || '', ctx.today || cdLocalToday());
    if (due.raw !== next.due?.raw || due.date !== next.due?.date || due.kind !== next.due?.kind) { next.due = due; next.by.due = by; log('due', old, councilDueLabel(due), { type: 'deadline' }); changed.push('due'); }
  }
  if ('critical' in patch && Boolean(patch.critical) !== Boolean(next.critical)) { next.critical = Boolean(patch.critical); next.by.critical = by; log('critical', String(!next.critical), String(next.critical), { label: 'Критичность' }); changed.push('critical'); }
  if ('state' in patch && patch.state !== next.state && patch.state !== 'done') {
    const old = next.state;
    next.state = patch.state;
    next.by.state = by;
    if (patch.state === 'blocked' && !councilActiveBlocks(next).length) next.blocks = [...(next.blocks || []), { id: councilEventId('blk', ctx.meetingId || ctx.now, 'manual'), kind: patch.blockKind || 'other', text: patch.blockText || '', ref: '', decider: '', active: true, since: ctx.today || '', by, confirmed: true }];
    if (patch.state !== 'blocked') next.blocks = (next.blocks || []).map(b => b.active && b.kind !== 'order' ? { ...b, active: false, resolvedAt: ctx.now, resolvedNote: 'Состояние изменено' } : b);
    if (patch.state !== 'cancelled') next.cancelled = null;
    log('state', councilState(old).label, councilState(next.state).label, { type: 'state' }); changed.push('state');
  }
  return { order: next, changed };
}

/** The only way to "done": a person confirms it. The file never does it. */
function councilConfirmDone(order, info, ctx) {
  const next = councilClone(order);
  const note = String(info.note || '').trim();
  next.done = { confirmed: true, at: ctx.now, day: ctx.today || '', by: ctx.by || 'user', note, meetingId: ctx.meetingId || '', previousState: order.state === 'done' ? order.done?.previousState || 'open' : order.state };
  next.state = 'done';
  next.by = { ...(next.by || {}), state: ctx.by || 'user' };
  councilPushEvent(next, councilNewEvent('done', ctx, { id: info.eventId, by: ctx.by || 'user', meetingId: ctx.meetingId || '', asOf: ctx.today || '', text: note || 'Выполнение подтверждено' }));
  return next;
}

function councilReopen(order, reason, ctx) {
  const next = councilClone(order);
  const back = order.done?.previousState && !['done', 'cancelled'].includes(order.done.previousState) ? order.done.previousState : 'open';
  next.state = back; next.done = null; next.cancelled = null;
  next.by = { ...(next.by || {}), state: ctx.by || 'user' };
  councilPushEvent(next, councilNewEvent('reopened', ctx, { by: ctx.by || 'user', asOf: ctx.today || '', text: reason || 'Возвращено в работу' }));
  return next;
}

function councilCancel(order, reason, ctx) {
  const next = councilClone(order);
  next.cancelled = { at: ctx.now, by: ctx.by || 'user', reason: reason || '', meetingId: ctx.meetingId || '', previousState: order.state };
  next.state = 'cancelled';
  next.by = { ...(next.by || {}), state: ctx.by || 'user' };
  councilPushEvent(next, councilNewEvent('cancelled', ctx, { by: ctx.by || 'user', meetingId: ctx.meetingId || '', asOf: ctx.today || '', text: reason || 'Поручение снято' }));
  return next;
}

function councilRecordDecision(order, info, ctx) {
  const next = councilClone(order);
  councilPushEvent(next, councilNewEvent('decision', ctx, { id: info.eventId, by: ctx.by || 'user', meetingId: info.meetingId || '', asOf: info.date || ctx.today || '', text: String(info.text || '').trim(), owner: info.owner || '', due: info.due || '' }));
  return next;
}

/* ---------- blocks and dependencies ---------- */

function councilWouldCycle(orders, orderId, refId) {
  if (orderId === refId) return true;
  const byId = new Map(orders.map(o => [o.orderId, o]));
  const seen = new Set();
  const walk = id => {
    if (id === orderId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const o = byId.get(id);
    return Boolean(o) && (o.blocks || []).filter(b => b.active && b.kind === 'order' && b.ref).some(b => walk(b.ref));
  };
  return walk(refId);
}

function councilAddBlock(order, block, ctx) {
  const next = councilClone(order);
  const entry = { id: councilEventId('blk', ctx.now, Math.random().toString(36).slice(2, 7)), kind: block.kind || 'other', text: String(block.text || '').trim(), ref: block.ref || '', decider: String(block.decider || '').trim(), active: true, since: ctx.today || '', by: ctx.by || 'user', confirmed: true };
  next.blocks = [...(next.blocks || []), entry];
  if (councilIsOpen(next)) { next.state = 'blocked'; next.by = { ...(next.by || {}), state: ctx.by || 'user' }; }
  councilPushEvent(next, councilNewEvent('block-added', ctx, { by: ctx.by || 'user', asOf: ctx.today || '', text: `${councilBlockKind(entry.kind).label}${entry.text ? ': ' + entry.text : ''}`, blockId: entry.id, ref: entry.ref, meetingId: ctx.meetingId || '' }));
  return next;
}

function councilResolveBlock(order, blockId, note, ctx) {
  const next = councilClone(order);
  const block = (next.blocks || []).find(b => b.id === blockId);
  if (!block || !block.active) return next;
  block.active = false; block.resolvedAt = ctx.now; block.resolvedNote = note || '';
  if (next.state === 'blocked' && !councilActiveBlocks(next).length) { next.state = 'in_progress'; next.by = { ...(next.by || {}), state: ctx.by || 'user' }; }
  councilPushEvent(next, councilNewEvent('block-resolved', ctx, { by: ctx.by || 'user', asOf: ctx.today || '', text: `Блокировка снята: ${block.text || councilBlockKind(block.kind).label}${note ? '. ' + note : ''}`, blockId, meetingId: ctx.meetingId || '' }));
  return next;
}

/** Orders that wait for this one (confirmed dependencies only). */
function councilDependents(orderId, orders) {
  return orders.filter(o => councilIsOpen(o) && (o.blocks || []).some(b => b.active && b.kind === 'order' && b.ref === orderId));
}

/**
 * Dependencies the registry text hints at ("После решения по оборудованию"). Suggestions only: they are never saved
 * without a person's confirmation, and they are shown as "предположительно".
 */
function councilSuggestDependencies(order, orders) {
  if (!councilIsOpen(order)) return [];
  const confirmed = new Set((order.blocks || []).filter(b => b.kind === 'order').map(b => b.ref));
  const phrase = order.due?.kind === 'condition' && /(^|\s)(после|до\s+(получения|решения|подтверждения|согласования))/i.test(order.due.raw || '') ? order.due.raw : '';
  if (!phrase) return [];
  const want = [...councilStems(phrase)].filter(s => !['после', 'внесен', 'получ', 'решен', 'подтве'].includes(s));
  if (want.length < 1) return [];
  const needsDecisionWord = /решени/.test(normalizeHeader(phrase));
  return orders.filter(o => o.orderId !== order.orderId && councilIsOpen(o) && !confirmed.has(o.orderId) && projectKey(o.projectRaw) === projectKey(order.projectRaw))
    .map(o => {
      const stems = councilStems(o.title);
      const common = want.filter(s => stems.has(s));
      const decisionTitle = /решени|согласован|утвержден|получить/.test(normalizeHeader(o.title));
      return { orderId: o.orderId, title: o.title, no: o.no, score: common.length / want.length, reason: `в сроке написано «${phrase}»`, ok: common.length >= Math.min(2, want.length) && (!needsDecisionWord || decisionTitle) };
    })
    .filter(s => s.ok).sort((a, b) => b.score - a.score).slice(0, 2);
}
