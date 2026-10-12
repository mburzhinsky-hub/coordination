'use strict';
/*
 * Tech council: behaviour. Routing hooks, actions, forms, the import flow, the meeting (draft autosave, finishing), export.
 * Loaded after app.js: it adds its actions to ACTIONS and binds its own listeners.
 */

function isCouncilRoute() { return state.route?.name === 'council'; }
function csCtx(extra = {}) { return { now: new Date().toISOString(), by: 'user', today: cdLocalToday(), projectMap: state.council.settings.projectMap || {}, ...extra }; }
function csRoot() { return document.getElementById('viewRoot'); }

/* ---------- start-up ---------- */

async function councilInit() {
  try {
    if (state.sharedMode) await councilMigrateLocalToShared();
    await councilLoad();
  } catch (error) {
    console.error(error);
    state.council.error = error.message || String(error);
  }
  councilRenderBadge();
}

/* ---------- render ---------- */

function renderCouncilView(opts = {}) {
  const root = csRoot();
  if (!root) return;
  const sub = csSub();
  if (sub.tab === 'meeting') {
    if (!csMeetingEnter()) return;
  } else if (csMeetingUi()) csMeetingLeave();
  root.classList.toggle('no-anim', Boolean(opts.soft));
  root.innerHTML = sub.tab === 'meeting' ? '' : csView();
  renderCouncilShell();
  if (sub.tab !== 'meeting' && !state.tvOpen) fx.mount(root, { soft: Boolean(opts.soft) });
  if (opts.sweep) fx.sweep();
}

function renderCouncilShell() {
  document.title = 'Техсовет — ИТО';
  document.querySelectorAll('[data-route]').forEach(link => {
    const on = link.dataset.route === 'council';
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  ['freshBanner', 'historyBanner', 'qualityBanner'].forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  const c = state.council;
  const chip = document.getElementById('freshChip');
  if (chip) {
    const last = c.imports.at(-1);
    chip.className = `chip ${last ? 'chip-blue' : 'chip-muted'}`;
    chip.innerHTML = `<i class="dot"></i>${last ? `Реестр от ${escapeHtml(cdFmt(last.asOf))}` : 'Реестра нет'}`;
    chip.title = last ? `Последний загруженный реестр поручений: ${cdFmtFull(last.asOf)}` : 'Реестр поручений ещё не загружен';
  }
  if (!state.currentSnapshot) {
    const when = document.getElementById('railWhen'); if (when) when.textContent = 'Выгрузки Bitrix нет';
    const rows = document.getElementById('railRows'); if (rows) rows.textContent = '';
  }
  councilRenderBadge();
  renderSyncStatus();
}

function councilRenderBadge() {
  const c = state.council;
  const n = c.loaded ? councilStats(c.orders, cdLocalToday()).needsDecision : 0;
  setBadge('badgeCouncil', n, 'red');
  setBadge('tabBadgeCouncil', n, 'red');
}

/** Called by the shared-server poll when something changed. Never throws away what a person is typing. */
async function councilOnSharedChange() {
  if (!state.council.loaded && !state.council.loading) return;
  const ui = csMeetingUi();
  await councilLoad();
  if (ui) { csMeetingMergeRemote(); councilRenderBadge(); return; }
  councilRenderBadge();
  if (!isCouncilRoute()) return;
  const busy = anyDialogOpen() || document.activeElement?.closest?.('#viewRoot input, #viewRoot textarea, #viewRoot select');
  if (busy) { state.council.stale = true; return; }
  renderCouncilView({ soft: true });
}

/* ---------- dialog helpers ---------- */

function csOpenDialog(html) {
  const dialog = document.getElementById('councilDialog');
  if (!dialog) return;
  document.getElementById('councilDialogBody').innerHTML = html;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('input:not([type=hidden]), textarea, select')?.focus({ preventScroll: true });
}

function csCloseDialog() {
  const dialog = document.getElementById('councilDialog');
  if (dialog?.open) dialog.close();
  if (state.council.stale && isCouncilRoute() && !csMeetingUi()) { state.council.stale = false; renderCouncilView({ soft: true }); }
}

function csFail(res, fallback) {
  if (res.conflict) return showToast('Поручение одновременно изменили. Откройте его заново и повторите.');
  if (res.reason === 'missing') return showToast('Поручение не найдено. Возможно, список ещё не обновился.');
  showToast(res.error ? `${fallback} ${res.error}` : fallback);
}

async function csRefresh(opts = {}) {
  if (isCouncilRoute()) renderCouncilView({ soft: true, ...opts });
  councilRenderBadge();
}

/* ---------- registry: filters and search ---------- */

function csUpdateList() {
  const list = document.getElementById('csList');
  if (list) list.innerHTML = csRegistryList();
  document.querySelectorAll('.cs-chips .fchip').forEach(btn => {
    const on = btn.dataset.state === state.council.ui.filter.state;
    btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on));
  });
}

let csSearchTimer = 0;

/* ---------- orders: create, edit, confirm, cancel, blocks ---------- */

function csFormSnapshot(form) {
  const f = new FormData(form);
  return Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]).concat([['critical', f.has('critical') ? '1' : '']]));
}

function csPatchFromForm(form, initial) {
  const now = csFormSnapshot(form);
  const patch = {};
  const changed = k => !initial || now[k] !== initial[k];
  if (changed('title')) patch.title = now.title;
  if (changed('result')) patch.result = now.result;
  if (changed('blockerRaw')) patch.blockerRaw = now.blockerRaw;
  if (changed('comment')) patch.comment = now.comment;
  if (changed('critical')) patch.critical = Boolean(now.critical);
  if (changed('project')) {
    if (now.project === '') { patch.projectRaw = ''; patch.projectId = ''; }
    else if (now.project !== '__raw__') { const pr = itoProjectById(now.project); patch.projectRaw = pr?.name || now.project; patch.projectId = now.project; }
  }
  if (changed('ownerName') || changed('ownerText')) {
    if (now.ownerName) patch.ownerName = now.ownerName; else patch.ownerText = now.ownerText;
  }
  if (changed('dueDate') || changed('dueText')) {
    if (now.dueDate) patch.dueDate = now.dueDate; else patch.dueText = now.dueText;
  }
  return patch;
}

let csEditSession = null;

function csOpenEdit(id) {
  const order = councilOrder(id);
  if (!order) return;
  csOpenDialog(csOrderForm(order));
  const form = document.getElementById('csOrderForm');
  csEditSession = { id, base: councilClone(order), initial: csFormSnapshot(form) };
}

async function csSubmitOrderForm(form) {
  const title = form.elements.title.value.trim();
  if (!title) { form.elements.title.focus(); form.elements.title.setAttribute('aria-invalid', 'true'); return; }
  const id = form.dataset.id;
  if (!id) {
    const data = csFormSnapshot(form);
    const pr = data.project && data.project !== '__raw__' ? itoProjectById(data.project) : null;
    const res = await csCreateOrder({ title, project: pr?.name || '', ownerName: data.ownerName, owner: data.ownerText, dueDate: data.dueDate, dueText: data.dueText, result: data.result }, { blockerRaw: data.blockerRaw, comment: data.comment, critical: Boolean(data.critical), projectId: pr?.id || '' });
    if (res.ok) { csCloseDialog(); showToast('Поручение добавлено'); navigate('council', 'order/' + res.value); } else csFail(res, 'Не удалось добавить поручение.');
    return;
  }
  const session = csEditSession && csEditSession.id === id ? csEditSession : { id, base: councilOrder(id), initial: null };
  const patch = csPatchFromForm(form, session.initial);
  if (!Object.keys(patch).length) { csCloseDialog(); showToast('Изменений нет'); return; }
  const res = await councilSaveEdit(id, session.base, patch, csCtx());
  csAfterEdit(res, session, patch);
}

function csAfterEdit(res, session, patch) {
  if (res.ok) { csCloseDialog(); showToast(res.nothing ? 'Изменений нет' : 'Сохранено'); csRefresh(); return; }
  if (res.aborted && res.reason === 'field-conflict') {
    csEditSession = { ...session, patch, current: res.details.current };
    csOpenDialog(csConflictForm(res.details.conflicts, res.details.current));
    return;
  }
  csFail(res, 'Не удалось сохранить.');
}

async function csSubmitConflict(form) {
  const s = csEditSession;
  if (!s) return;
  const resolution = {};
  [...form.querySelectorAll('input[type=radio]:checked')].forEach(r => { resolution[r.name.replace(/^r_/, '')] = r.value; });
  /* the person has now seen the newest version: what they chose is based on it */
  const res = await councilSaveEdit(s.id, s.current, s.patch, csCtx(), Object.fromEntries(Object.entries(resolution)));
  csAfterEdit(res, { ...s, base: s.current }, s.patch);
}

async function csCreateOrder(data, extra = {}) {
  const taken = new Set(state.council.orders.map(o => o.orderId));
  const ctx = csCtx();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = councilNewId(taken);
    taken.add(id);
    const key = 'order:' + id;
    const res = await councilMutate([key], current => {
      if (current.get(key)) return { abort: true, reason: 'id-taken' };
      const order = councilOrderFromManual(data, ctx, id);
      if (extra.blockerRaw) order.blockerRaw = extra.blockerRaw;
      if (extra.comment) order.comment = extra.comment;
      if (extra.critical) order.critical = true;
      if (extra.projectId) { order.projectId = extra.projectId; order.projectVia = 'override'; }
      return { records: [order], value: id };
    });
    if (res.ok || res.reason !== 'id-taken') return res;
  }
  return { ok: false, error: 'Не удалось подобрать номер.' };
}

async function csOrderMutation(id, fn, doneMessage) {
  const key = 'order:' + id;
  const res = await councilMutate([key], current => {
    const order = current.get(key);
    if (!order) return { abort: true, reason: 'missing' };
    const next = fn(order);
    return next ? { records: [next] } : null;
  });
  if (res.ok) { csCloseDialog(); if (doneMessage) showToast(doneMessage); csRefresh(); } else csFail(res, 'Не удалось сохранить.');
  return res;
}

/* ---------- agenda ---------- */

async function csAgendaMeta(date, mutate) {
  const key = 'meeting:' + date;
  const ctx = csCtx();
  const res = await councilMutate([key], current => {
    const found = current.get(key);
    const m = found ? councilClone(found) : councilNewMeeting(date, ctx.now);
    if (m.status === 'live' || m.status === 'closed') return { abort: true, reason: 'frozen' };
    mutate(m.agendaMeta, m);
    return { records: [m] };
  });
  if (res.ok) csRefresh(); else if (res.reason === 'frozen') showToast('Повестка этого заседания уже зафиксирована.'); else csFail(res, 'Не удалось изменить повестку.');
  return res;
}

function csNewUid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }

/* ---------- starting a meeting ---------- */

async function csStartMeeting(date) {
  await councilLoad();
  const other = state.council.meetings.find(m => m.status === 'live' && m.date !== date);
  if (other) { showToast(`Уже идёт техсовет от ${cdFmt(other.date)}. Завершите его или продолжите.`); navigate('council', 'meeting'); return; }
  const key = 'meeting:' + date;
  const ctx = csCtx();
  const res = await councilMutate([key], current => {
    const found = current.get(key);
    if (found?.status === 'closed') return { abort: true, reason: 'closed' };
    if (found?.status === 'live') return null;
    const base = found || councilNewMeeting(date, ctx.now);
    const started = councilStartMeeting(base, state.council.orders, ctx.now, ctx.by);
    return { records: [started] };
  });
  if (res.ok) navigate('council', 'meeting');
  else if (res.reason === 'closed') { showToast('Этот техсовет уже завершён.'); navigate('council', 'history/' + date); }
  else csFail(res, 'Не удалось начать техсовет.');
}

/* ---------- meeting mode ---------- */

function csMeetingEl() { return document.getElementById('councilMeeting'); }

/** Opens the meeting layer for the live meeting. Returns false (and redirects) when there is none. */
function csMeetingEnter() {
  const c = state.council;
  const live = c.meetings.find(m => m.status === 'live');
  if (!live) {
    showToast(c.meetings.some(m => m.status === 'planned') ? 'Заседание ещё не начато. Откройте повестку и нажмите «Начать техсовет».' : 'Сейчас нет идущего заседания.');
    setTimeout(() => navigate('council', 'agenda'), 0);
    return false;
  }
  if (!csMeetingUi() || csMeetingUi().date !== live.date) {
    let sel = 0;
    try { sel = Number(sessionStorage.getItem('coordination.council.sel.' + live.date) || 0); } catch (_) {}
    const ui = c.ui.meeting = { date: live.date, sel: Math.max(0, Math.min((live.agenda || []).length - 1, sel)), draft: councilClone(live.draft || councilEmptyDraft()), dirty: { items: {}, notes: false, newOrders: false, removed: [] }, version: 0, save: { state: 'idle', at: '' }, newForm: false, timer: 0, saving: false };
    const backup = councilBackupLoad(live.id);
    const un = councilDraftUnsaved(live.draft, backup);
    if (un.count) {
      Object.keys(un.items).forEach(id => { ui.draft.items[id] = backup.draft.items[id]; ui.dirty.items[id] = true; });
      if (un.notes) { ui.draft.notes = backup.draft.notes; ui.dirty.notes = true; }
      if (un.newOrders) { ui.draft.newOrders = backup.draft.newOrders; ui.dirty.newOrders = true; }
      ui.version++;
      setTimeout(() => { showToast(`Восстановлено из копии в браузере: ${un.count}. Сохраняю на сервер.`); csScheduleSave(0); }, 300);
    }
  }
  const el = csMeetingEl();
  if (el.hidden || !el.firstElementChild) el.innerHTML = csMeetingRoot();
  el.hidden = false;
  document.body.classList.add('cs-meeting-open');
  return true;
}

function csMeetingLeave() {
  const ui = csMeetingUi();
  if (ui) { clearTimeout(ui.timer); if (ui.dirty.items && Object.keys(ui.dirty.items).length) csSaveDraft(); }
  state.council.ui.meeting = null;
  const el = csMeetingEl();
  if (el) { el.hidden = true; el.innerHTML = ''; }
  document.body.classList.remove('cs-meeting-open');
}

function csMeetingRerender(parts) {
  const ui = csMeetingUi();
  const m = csMeetingView();
  if (!ui || !m) return;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  if (parts.bar) set('csMBar', csMBarHtml(m, ui));
  if (parts.nav) { const nav = document.getElementById('csMNav'); const top = nav?.scrollTop || 0; set('csMNav', csMNavHtml(m, ui)); if (nav) nav.scrollTop = top; }
  if (parts.main) { set('csMMain', csMMainHtml(m, ui)); document.getElementById('csMMain')?.scrollTo?.(0, 0); }
  if (parts.form) set('csMForm', csMFormHtml(m, ui));
  if (parts.keepNav) document.querySelector('#csMNav .is-sel')?.scrollIntoView({ block: 'nearest' });
}

function csMeetingGo(index) {
  const ui = csMeetingUi();
  const m = csMeetingView();
  if (!ui || !m) return;
  const next = Math.max(0, Math.min((m.agenda || []).length - 1, index));
  ui.sel = next; ui.newForm = false;
  try { sessionStorage.setItem('coordination.council.sel.' + ui.date, String(next)); } catch (_) {}
  csMeetingRerender({ nav: true, main: true, form: true, keepNav: true });
}

function csCurrentItem() {
  const ui = csMeetingUi();
  const m = csMeetingView();
  return ui && m ? (m.agenda || [])[ui.sel] || null : null;
}

function csDraftTouch(itemId) {
  const ui = csMeetingUi();
  const d = councilDraftItem(ui.draft, itemId);
  d.updatedAt = new Date().toISOString();
  ui.dirty.items[itemId] = true;
  ui.version++;
  councilBackupSave('meeting:' + ui.date, ui.draft);
  csScheduleSave(700);
  return d;
}

function csDraftSet(itemId, field, value) {
  const ui = csMeetingUi();
  if (!ui) return;
  const d = councilDraftItem(ui.draft, itemId);
  if (d.accepted && field !== 'doneNote') return;
  // A blur fires "change" after "input" with the same value; repainting the list then would swallow the click that caused the blur.
  if ((d[field] ?? '') === value) return;
  const before = csItemStatus(d);
  d[field] = value;
  csDraftTouch(itemId);
  if (csItemStatus(d) !== before) csMeetingRerender({ nav: true, bar: true });
  const accept = document.querySelector('[data-action="cs-m-accept"]');
  if (accept) accept.disabled = !councilDraftTouched(d);
}

function csScheduleSave(delay) {
  const ui = csMeetingUi();
  if (!ui) return;
  clearTimeout(ui.timer);
  ui.timer = setTimeout(csSaveDraft, delay);
}

function csSetSave(stateName, at) {
  const ui = csMeetingUi();
  if (!ui) return;
  ui.save = { state: stateName, at: at || ui.save.at };
  const el = document.getElementById('csSaveState');
  const m = csMeetingView();
  if (el && m) { const tmp = document.createElement('div'); tmp.innerHTML = csMBarHtml(m, ui); const fresh = tmp.querySelector('#csSaveState'); if (fresh) { el.className = fresh.className; el.textContent = fresh.textContent; } }
}

/** Saves the draft: this browser's changes are merged into whatever is stored now, so two people can type in one meeting. */
async function csSaveDraft() {
  const ui = csMeetingUi();
  if (!ui || ui.saving) return;
  const dirty = ui.dirty;
  if (!Object.keys(dirty.items).length && !dirty.notes && !dirty.newOrders) return;
  ui.saving = true;
  const version = ui.version;
  const snapshot = { items: { ...dirty.items }, notes: dirty.notes, newOrders: dirty.newOrders, removed: [...dirty.removed] };
  csSetSave('saving');
  const key = 'meeting:' + ui.date;
  const mine = councilClone(ui.draft);
  const now = new Date().toISOString();
  let res;
  try {
    res = await councilMutate([key], current => {
      const m = current.get(key);
      if (!m) return { abort: true, reason: 'missing' };
      if (m.status !== 'live') return { abort: true, reason: 'not-live' };
      return { records: [{ ...m, draft: councilMergeDraft(m.draft, mine, snapshot, now) }] };
    });
  } catch (error) { res = { ok: false, error: error.message }; }
  ui.saving = false;
  if (!csMeetingUi()) return;
  if (res.ok) {
    if (ui.version === version) ui.dirty = { items: {}, notes: false, newOrders: false, removed: [] };
    else { Object.keys(snapshot.items).forEach(id => { /* typed again meanwhile: stays dirty */ }); csScheduleSave(300); }
    csSetSave('saved', now);
    csMeetingMergeRemote();
  } else if (res.reason === 'not-live') {
    csSetSave('conflict');
    showToast('Заседание уже завершено или закрыто другим участником.');
  } else {
    csSetSave('error');
    csScheduleSave(5000);
  }
}

/** Takes in what others wrote in the shared draft, except for the items this browser is still typing in. */
function csMeetingMergeRemote() {
  const ui = csMeetingUi();
  if (!ui) return;
  const m = councilMeetingById('meeting:' + ui.date);
  if (!m) return;
  if (m.status === 'closed') {
    showToast('Техсовет завершён другим участником.');
    csMeetingLeave();
    navigate('council', 'history/' + m.date);
    return;
  }
  const remote = m.draft || councilEmptyDraft();
  let formChanged = false;
  const cur = csCurrentItem();
  Object.entries(remote.items || {}).forEach(([id, item]) => {
    if (ui.dirty.items[id]) return;
    if (JSON.stringify(ui.draft.items[id] || null) !== JSON.stringify(item)) { ui.draft.items[id] = councilClone(item); if (cur && cur.id === id) formChanged = true; }
  });
  if (!ui.dirty.notes) ui.draft.notes = remote.notes || '';
  if (!ui.dirty.newOrders && JSON.stringify(ui.draft.newOrders || []) !== JSON.stringify(remote.newOrders || [])) { ui.draft.newOrders = councilClone(remote.newOrders || []); formChanged = true; }
  const typing = document.activeElement?.closest?.('#csMForm input, #csMForm textarea, #csMForm select');
  csMeetingRerender({ nav: true, bar: true, form: formChanged && !typing });
}

async function csMeetingFlush() {
  const ui = csMeetingUi();
  if (!ui) return;
  clearTimeout(ui.timer);
  for (let i = 0; i < 4 && (Object.keys(ui.dirty.items).length || ui.dirty.notes || ui.dirty.newOrders); i++) { await csSaveDraft(); if (ui.saving) await new Promise(r => setTimeout(r, 150)); }
}

/* ---------- finishing ---------- */

async function csFinishOpen() {
  const ui = csMeetingUi();
  if (!ui) return;
  await csMeetingFlush();
  const m = csMeetingView();
  const plan = councilBuildClosePlan(m, state.council.orders, csCtx());
  csOpenDialog(csFinishForm(plan, m));
}

async function csFinishSubmit(form) {
  const ui = csMeetingUi();
  if (!ui) return;
  const date = ui.date;
  ui.draft.notes = form.elements.notes.value;
  ui.dirty.notes = true;
  const submit = form.querySelector('button[type=submit]');
  if (submit) submit.disabled = true;
  const key = 'meeting:' + date;
  const ctx = csCtx();
  const allMine = { items: Object.fromEntries(Object.keys(ui.draft.items).map(id => [id, true])), notes: true, newOrders: true, removed: [] };
  let result = null;
  for (let round = 0; round < 3 && !result?.ok; round++) {
    const fresh = await councilReadFresh([key]);
    const meeting = fresh.get(key);
    if (!meeting) { showToast('Заседание не найдено.'); break; }
    if (meeting.status === 'closed') { showToast('Техсовет уже завершён.'); csMeetingLeave(); navigate('council', 'history/' + date); return; }
    const merged = councilMergeDraft(meeting.draft, ui.draft, allMine, ctx.now);
    const ids = [...new Set((meeting.agenda || []).filter(a => a.orderId && councilDraftTouched(merged.items[a.id])).map(a => a.orderId))];
    result = await councilMutate([key, ...ids.map(id => 'order:' + id)], current => {
      const m = current.get(key);
      if (!m || m.status !== 'live') return { abort: true, reason: 'not-live' };
      const draft = councilMergeDraft(m.draft, ui.draft, allMine, ctx.now);
      const need = [...new Set((m.agenda || []).filter(a => a.orderId && councilDraftTouched(draft.items[a.id])).map(a => a.orderId))];
      if (need.length !== ids.length || need.some(id => !ids.includes(id))) return { abort: true, reason: 'retry' };
      const orders = ids.map(id => current.get('order:' + id)).filter(Boolean);
      const withDraft = { ...m, draft };
      const plan = councilBuildClosePlan(withDraft, orders, ctx);
      const out = councilApplyClose(plan, withDraft, orders, ctx);
      return { records: [...out.orders, out.meeting], value: out };
    });
    if (!result.ok && result.reason !== 'retry') break;
  }
  if (submit) submit.disabled = false;
  if (result?.ok) {
    councilBackupClear('meeting:' + date);
    ui.dirty = { items: {}, notes: false, newOrders: false, removed: [] };
    csCloseDialog();
    csMeetingLeave();
    showToast('Техсовет завершён. Решения записаны в поручения.');
    navigate('council', 'history/' + date);
  } else if (result) csFail(result, 'Не удалось завершить техсовет. Черновик сохранён, повторите.');
}

/* ---------- import ---------- */

async function councilHandleFile(file) {
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { showToast('Для реестра нужен файл Excel .xlsx. Выгрузки Bitrix (.xls) загружаются кнопкой «Обновить».'); return; }
  if (!state.council.loaded) await councilLoad();
  let bytes, book;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    book = xlsxRead(bytes);
  } catch (error) {
    console.error(error);
    showToast('Не удалось прочитать файл: он не похож на книгу Excel (.xlsx).');
    return;
  }
  const today = cdLocalToday();
  const fileDate = file.lastModified ? cdLocalToday(new Date(file.lastModified)) : '';
  let parsed = null, sheetName = '';
  const errors = [];
  for (const sheet of book.sheets.filter(s => !s.hidden)) {
    const p = councilParseRegistry(sheet, { today, fileDate });
    if (p.ok && p.rows.length) { parsed = p; sheetName = sheet.name; break; }
    errors.push(...(p.errors || []));
  }
  if (!parsed) { showToast(errors[0] || 'В файле не нашлось таблицы поручений: нужны колонки «Задача» и «Ответственный».'); return; }
  const hash = councilSha256(bytes);
  const c = state.council;
  const known = c.imports.find(i => i.hash === hash);
  const asOf = parsed.asOfGuess?.date || today;
  const projectMap = { ...(c.settings.projectMap || {}) };
  const ctx = { asOf, now: new Date().toISOString(), by: 'user', projectMap, importId: 'import:' + hash.slice(0, 24) };
  const plan = councilPlanImport(parsed, c.orders, ctx);
  c.ui.pending = { file: { name: file.name, size: file.size, hash, mime: file.type }, bytes, parsed, plan, asOf, projectMap, sheetName, decisions: councilDefaultDecisions(plan), known: Boolean(known) };
  if (known) showToast(`Этот файл уже загружен ${formatDateTime(known.importedAt)}. Повторно применять нечего.`);
  navigate('council', 'import');
  if (location.hash === '#/council/import') renderCouncilView({ soft: true });
}

function csReplan() {
  const p = state.council.ui.pending;
  if (!p) return;
  const ctx = { asOf: p.asOf, now: new Date().toISOString(), by: 'user', projectMap: p.projectMap, importId: 'import:' + p.file.hash.slice(0, 24) };
  p.plan = councilPlanImport(p.parsed, state.council.orders, ctx);
  const keep = p.decisions;
  p.decisions = councilDefaultDecisions(p.plan);
  Object.keys(p.decisions.matches).forEach(k => { if (keep.matches[k]) p.decisions.matches[k] = keep.matches[k]; });
  p.decisions.conflicts = keep.conflicts;
}

async function csImportApply() {
  const c = state.council;
  const p = c.ui.pending;
  if (!p) return;
  if (p.plan.summary.nothingToDo) { showToast('Применять нечего.'); return; }
  const btn = document.querySelector('[data-action="cs-import-apply"]');
  if (btn) btn.disabled = true;
  const ctx = { asOf: p.asOf, now: new Date().toISOString(), by: 'user', projectMap: p.projectMap };
  const info = { fileName: p.file.name, size: p.file.size, hash: p.file.hash, sheetName: p.sheetName, columns: p.parsed.columns, mime: p.file.mime };
  const res = await councilCommitImport(p.parsed, p.plan, p.decisions, ctx, info, p.bytes);
  if (btn) btn.disabled = false;
  if (res.ok) {
    const mapChanged = JSON.stringify(p.projectMap) !== JSON.stringify(c.settings.projectMap || {});
    if (mapChanged) await csSaveProjectMap(p.projectMap);
    const st = res.value.stats;
    c.ui.pending = null;
    showToast(`Реестр загружен: создано ${st.created}, обновлено ${st.updated}${st.unchanged ? `, без изменений ${st.unchanged}` : ''}.`);
    navigate('council', 'overview');
    csRefresh();
  } else if (res.reason === 'already-imported') {
    showToast('Этот файл уже загружен. Ничего не изменилось.');
    c.ui.pending = null; csRefresh();
  } else if (res.reason === 'plan-changed') {
    await councilLoad();
    csReplan();
    showToast('Пока вы смотрели предпросмотр, поручения изменились. Проверьте список ещё раз.');
    csRefresh();
  } else csFail(res, 'Не удалось загрузить реестр.');
}

async function csSaveProjectMap(map) {
  return councilMutate(['settings:main'], current => {
    const found = current.get('settings:main') || { ...state.council.settings, rev: 0 };
    return { records: [{ ...found, projectMap: { ...(found.projectMap || {}), ...map } }] };
  });
}

/* ---------- export and files ---------- */

function csDownload(bytes, name, type) {
  const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function csExport() {
  const c = state.council;
  if (!c.orders.length) { showToast('Выгружать пока нечего: реестр пуст.'); return; }
  const today = cdLocalToday();
  const book = councilExportBook(c.orders, c.meetings, { today, now: new Date().toISOString() });
  const bytes = xlsxWrite(book);
  csDownload(bytes, `Реестр поручений техсовета ${today}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  showToast('Реестр выгружен. В файле те же колонки, плюс ID и текущий статус.');
}

async function csFileDownload(id) {
  const rec = await councilGetFile(id);
  if (!rec) { showToast('Файл не найден на сервере.'); return; }
  csDownload(councilB64ToBytes(rec.data), rec.name, rec.type);
}

async function csAttachFile(file, date) {
  if (!file) return;
  if (file.size > COUNCIL_FILE_LIMIT) { showToast(`Файл больше ${Math.round(COUNCIL_FILE_LIMIT / 1048576)} МБ. Прикрепите файл поменьше.`); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const rec = councilFileRecord(file.name, file.type, bytes, new Date().toISOString());
  const key = 'meeting:' + date;
  const res = await councilMutate([key], current => {
    const m = current.get(key);
    if (!m) return { abort: true, reason: 'missing' };
    if ((m.protocol?.files || []).some(f => f.id === rec.id)) return null;
    const next = councilClone(m);
    next.protocol = { ...(next.protocol || { text: '' }), files: [...(next.protocol?.files || []), councilFileMeta(rec, 'user')] };
    return { records: [next], files: [rec] };
  });
  if (res.ok) { showToast(res.nothing ? 'Этот файл уже прикреплён' : 'Файл прикреплён'); csRefresh(); } else csFail(res, 'Не удалось прикрепить файл.');
}

async function csProtocolMutate(date, fn, message) {
  const key = 'meeting:' + date;
  const res = await councilMutate([key], current => {
    const m = current.get(key);
    if (!m) return { abort: true, reason: 'missing' };
    const next = councilClone(m);
    next.protocol = { text: '', files: [], ...(next.protocol || {}) };
    fn(next.protocol, next);
    next.protocol.updatedAt = new Date().toISOString();
    return { records: [next] };
  });
  if (res.ok) { if (message) showToast(message); csRefresh(); } else csFail(res, 'Не удалось сохранить протокол.');
  return res;
}

/* ---------- actions ---------- */

Object.assign(ACTIONS, {
  'cs-filter-state': el => { state.council.ui.filter.state = el.dataset.state; state.council.ui.filter.project = ''; state.council.ui.filter.owner = ''; if (csSub().tab === 'registry') { csUpdateList(); } else navigate('council', 'registry'); },
  'cs-project-open': el => { const f = state.council.ui.filter; f.project = el.dataset.project; f.state = 'open'; f.owner = ''; f.q = ''; navigate('council', 'registry'); },
  'cs-new-order': () => csOpenDialog(csOrderForm(null)),
  'cs-edit-order': el => csOpenEdit(el.dataset.id),
  'cs-dialog-close': () => csCloseDialog(),
  'cs-done-dialog': el => { const o = councilOrder(el.dataset.id); if (o) csOpenDialog(csDoneForm(o)); },
  'cs-cancel-dialog': el => { const o = councilOrder(el.dataset.id); if (o) csOpenDialog(csCancelForm(o)); },
  'cs-reopen': el => csOrderMutation(el.dataset.id, o => councilReopen(o, 'Возвращено в работу', csCtx()), 'Поручение возвращено в работу'),
  'cs-block-dialog': el => { const o = councilOrder(el.dataset.id); if (o) csOpenDialog(csBlockForm(o, state.council.orders)); },
  'cs-block-resolve': el => { const o = councilOrder(el.dataset.id); if (o) csOpenDialog(csResolveForm(o, el.dataset.block)); },
  'cs-dep-accept': async el => {
    const ref = councilOrder(el.dataset.ref);
    if (!ref) return;
    if (councilWouldCycle(state.council.orders, el.dataset.id, el.dataset.ref)) { showToast('Так получится круг: эти поручения ждут друг друга.'); return; }
    await csOrderMutation(el.dataset.id, o => councilAddBlock(o, { kind: 'order', ref: ref.orderId, text: `Ждёт поручение №${ref.no || '?'}` }, csCtx()), 'Зависимость сохранена');
  },
  'cs-dep-dismiss': async el => {
    await councilMutate(['settings:main'], current => {
      const found = current.get('settings:main') || { ...state.council.settings, rev: 0 };
      return { records: [{ ...found, dismissedDeps: { ...(found.dismissedDeps || {}), [el.dataset.id + ':' + el.dataset.ref]: true } }] };
    });
    csRefresh();
  },
  'cs-agenda-add-order': async el => {
    const date = csAgendaDate();
    const id = el.dataset.id;
    const res = await csAgendaMeta(date, meta => { if (!meta.manual.some(x => x.orderId === id)) meta.manual.push({ id: 'ag:' + id, orderId: id, title: '', note: '' }); delete meta.excluded[id]; });
    if (res.ok) showToast(`Добавлено в повестку на ${cdFmt(date)}`);
  },
  'cs-agenda-move': el => {
    const date = csAgendaDate();
    return csAgendaMeta(date, meta => {
      const agenda = councilBuildAgenda(state.council.orders, date, meta);
      meta.order = councilMoveAgendaItem(agenda, el.dataset.id, Number(el.dataset.delta), meta);
    });
  },
  'cs-agenda-exclude': el => { const id = el.dataset.id; return csAgendaMeta(csAgendaDate(), meta => { meta.excluded[id] = true; }); },
  'cs-agenda-restore': el => { const id = el.dataset.id; return csAgendaMeta(csAgendaDate(), meta => { delete meta.excluded[id]; }); },
  'cs-agenda-unmanual': el => { const id = el.dataset.id; return csAgendaMeta(csAgendaDate(), meta => { meta.manual = meta.manual.filter(x => x.id !== id); }); },
  'cs-manual-dialog': el => csOpenDialog(csManualQuestionForm(el.dataset.date)),
  'cs-start-meeting': el => csStartMeeting(el.dataset.date),
  'cs-m-go': el => csMeetingGo(Number(el.dataset.i)),
  'cs-m-prev': () => csMeetingGo(csMeetingUi().sel - 1),
  'cs-m-next': () => csMeetingGo(csMeetingUi().sel + 1),
  'cs-m-state': el => { const it = csCurrentItem(); if (it) { csDraftSet(it.id, 'state', el.dataset.state); csMeetingRerender({ form: true }); } },
  'cs-m-accept': () => {
    const it = csCurrentItem(); if (!it) return;
    const ui = csMeetingUi(); const d = councilDraftItem(ui.draft, it.id);
    if (!councilDraftTouched(d)) return;
    d.accepted = true; d.acceptedAt = new Date().toISOString(); d.acceptedBy = 'user'; d.mark = d.mark === 'skip' ? '' : d.mark;
    csDraftTouch(it.id);
    csMeetingRerender({ nav: true, bar: true, form: true });
  },
  'cs-m-unaccept': () => { const it = csCurrentItem(); if (!it) return; const ui = csMeetingUi(); const d = councilDraftItem(ui.draft, it.id); d.accepted = false; d.acceptedAt = ''; csDraftTouch(it.id); csMeetingRerender({ nav: true, bar: true, form: true }); },
  'cs-m-skip': () => { const it = csCurrentItem(); if (!it) return; const ui = csMeetingUi(); const d = councilDraftItem(ui.draft, it.id); d.mark = d.mark === 'skip' ? '' : 'skip'; csDraftTouch(it.id); csMeetingRerender({ nav: true, bar: true, form: true }); },
  'cs-m-done': () => {
    const it = csCurrentItem(); if (!it) return;
    const ui = csMeetingUi(); const d = councilDraftItem(ui.draft, it.id);
    d.doneConfirm = !d.doneConfirm; if (!d.doneConfirm) d.doneNote = '';
    csDraftTouch(it.id); csMeetingRerender({ nav: true, bar: true, form: true });
    if (d.doneConfirm) document.querySelector('[data-field="doneNote"]')?.focus();
  },
  'cs-m-new-open': () => { csMeetingUi().newForm = true; csMeetingRerender({ form: true }); document.querySelector('#csNewOrderForm textarea')?.focus(); },
  'cs-m-new-cancel': () => { csMeetingUi().newForm = false; csMeetingRerender({ form: true }); },
  'cs-m-new-remove': el => {
    const ui = csMeetingUi();
    ui.draft.newOrders = (ui.draft.newOrders || []).filter(n => n.uid !== el.dataset.uid);
    ui.dirty.newOrders = true; ui.dirty.removed.push(el.dataset.uid); ui.version++;
    councilBackupSave('meeting:' + ui.date, ui.draft); csScheduleSave(300); csMeetingRerender({ form: true, bar: true });
  },
  'cs-m-exit': async () => { await csMeetingFlush(); navigate('council', 'overview'); },
  'cs-m-finish': () => csFinishOpen(),
  'cs-import-pick': () => document.getElementById('councilFileInput')?.click(),
  'cs-import-apply': () => csImportApply(),
  'cs-import-cancel': () => { state.council.ui.pending = null; csRefresh(); },
  'cs-export': () => csExport(),
  'cs-map-projects': () => { const list = csUnmappedProjects(state.council.orders); if (list.length) csOpenDialog(csMapDialog(list)); },
  'cs-file-download': el => csFileDownload(el.dataset.id),
  'cs-file-remove': el => csProtocolMutate(el.dataset.date, p => { p.files = (p.files || []).filter(f => f.id !== el.dataset.id); }, 'Файл убран из протокола'),
  'cs-protocol-save': el => csProtocolMutate(el.dataset.date, p => { p.text = document.getElementById('csProtocolText')?.value || ''; }, 'Протокол сохранён'),
  'cs-protocol-draft': el => {
    const m = councilMeetingByDate(el.dataset.date);
    if (!m?.result) return;
    const text = councilProtocolDraft(m);
    const area = document.getElementById('csProtocolText');
    if (area && area.value.trim() && area.value.trim() !== (m.protocol?.text || '').trim() && !window.confirm('В поле уже есть несохранённый текст. Заменить его черновиком из решений?')) return;
    return csProtocolMutate(el.dataset.date, p => { p.text = text; p.final = false; }, 'Черновик протокола составлен из принятых решений');
  },
  'cs-protocol-final': el => csProtocolMutate(el.dataset.date, p => { p.text = document.getElementById('csProtocolText')?.value ?? p.text; p.final = !p.final; }, 'Готово'),
  'cs-sug-create': async el => {
    const m = councilMeetingByDate(el.dataset.date);
    const sug = councilProtocolSuggestions(m?.protocol?.text || '', m?.date)[Number(el.dataset.i)];
    if (!sug) return;
    const res = await csCreateOrder({ title: sug.title, ownerName: sug.owner, dueDate: sug.dueDate, project: '' });
    if (res.ok) { showToast('Поручение создано из текста протокола. Проверьте проект и срок.'); navigate('council', 'order/' + res.value); } else csFail(res, 'Не удалось создать поручение.');
  }
});

/* ---------- listeners ---------- */

function bindCouncil() {
  document.getElementById('councilFileInput')?.addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (file) await councilHandleFile(file);
  });
  document.getElementById('councilAttachInput')?.addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    const sub = csSub();
    if (file && sub.tab === 'history' && sub.arg) await csAttachFile(file, sub.arg);
  });
  const dialog = document.getElementById('councilDialog');
  if (dialog) {
    dialog.addEventListener('click', event => { if (event.target === dialog) csCloseDialog(); });
    dialog.addEventListener('close', () => { if (state.council.stale && isCouncilRoute() && !csMeetingUi()) { state.council.stale = false; renderCouncilView({ soft: true }); } });
    dialog.addEventListener('submit', async event => {
      const form = event.target;
      event.preventDefault();
      try {
        if (form.id === 'csOrderForm') await csSubmitOrderForm(form);
        else if (form.id === 'csConflictForm') await csSubmitConflict(form);
        else if (form.id === 'csDoneForm') {
          const note = form.elements.note.value.trim();
          if (!note) { form.elements.note.focus(); form.elements.note.setAttribute('aria-invalid', 'true'); return; }
          await csOrderMutation(form.dataset.id, o => councilConfirmDone(o, { note }, csCtx()), 'Выполнение подтверждено');
        } else if (form.id === 'csCancelForm') {
          const reason = form.elements.reason.value.trim();
          if (!reason) { form.elements.reason.focus(); return; }
          await csOrderMutation(form.dataset.id, o => councilCancel(o, reason, csCtx()), 'Поручение снято');
        } else if (form.id === 'csBlockForm') {
          const f = csFormSnapshot(form);
          if (f.kind === 'order') {
            if (!f.ref) { showToast('Выберите поручение, от которого зависит это.'); return; }
            if (councilWouldCycle(state.council.orders, form.dataset.id, f.ref)) { showToast('Так получится круг: эти поручения ждут друг друга.'); return; }
          } else if (!f.text.trim()) { form.elements.text.focus(); return; }
          await csOrderMutation(form.dataset.id, o => councilAddBlock(o, { kind: f.kind, ref: f.kind === 'order' ? f.ref : '', text: f.text, decider: f.decider }, csCtx()), 'Блокер добавлен');
        } else if (form.id === 'csResolveForm') {
          await csOrderMutation(form.dataset.id, o => councilResolveBlock(o, form.dataset.block, form.elements.note.value.trim(), csCtx()), 'Блокер снят');
        } else if (form.id === 'csMapForm') {
          await csApplyProjectMapping([...form.querySelectorAll('select[data-map]')].map(s => ({ key: s.dataset.map, raw: s.dataset.raw, id: s.value })).filter(x => x.id));
        } else if (form.id === 'csManualForm') {
          const f = csFormSnapshot(form);
          if (!f.title.trim()) { form.elements.title.focus(); return; }
          const manual = { id: csNewUid('ag:m-'), title: f.title.trim(), group: f.group.trim(), orderId: f.orderId, note: f.note.trim() };
          const res = await csAgendaMeta(form.dataset.date, meta => { meta.manual.push(manual); });
          if (res.ok) csCloseDialog();
        } else if (form.id === 'csFinishForm') await csFinishSubmit(form);
      } catch (error) { console.error(error); showToast('Что-то пошло не так. Подробности в консоли.'); }
    });
  }

  document.addEventListener('change', async event => {
    const t = event.target;
    if (t.matches?.('.cs-select[data-filter]')) { state.council.ui.filter[t.dataset.filter] = t.value; csUpdateList(); return; }
    if (t.id === 'csAgendaDate') { if (cdValid(t.value)) { state.council.ui.agendaDate = t.value; csRefresh(); } return; }
    const p = state.council.ui.pending;
    if (p && t.id === 'csAsOf') { if (cdValid(t.value)) { p.asOf = t.value; csReplan(); csRefresh(); } return; }
    if (p && t.matches?.('select[data-map]')) { if (t.value) p.projectMap[t.dataset.map] = t.value; else delete p.projectMap[t.dataset.map]; csReplan(); csRefresh(); return; }
    if (p && t.dataset?.match !== undefined) { p.decisions.matches[t.dataset.match] = t.value; csRefresh(); return; }
    if (p && t.dataset?.conflict) { p.decisions.conflicts[t.dataset.conflict] = t.value; return; }
    if (t.matches?.('#csMForm [data-field]')) csFieldInput(t);
  });

  document.addEventListener('input', event => {
    const t = event.target;
    if (t.id === 'csSearch') { clearTimeout(csSearchTimer); csSearchTimer = setTimeout(() => { state.council.ui.filter.q = t.value; csUpdateList(); }, 120); return; }
    if (t.matches?.('#csMForm [data-field]')) csFieldInput(t);
    else if (t.id === 'csNotes') { /* reserved */ }
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.id !== 'csNewOrderForm') return;
    event.preventDefault();
    const ui = csMeetingUi();
    const f = csFormSnapshot(form);
    if (!f.title.trim()) { form.elements.title.focus(); return; }
    ui.draft.newOrders = [...(ui.draft.newOrders || []), { uid: csNewUid('n-'), title: f.title.trim(), project: f.project, ownerName: f.ownerName, dueDate: f.dueDate, dueText: f.dueText.trim(), createdAt: new Date().toISOString() }];
    ui.dirty.newOrders = true; ui.version++; ui.newForm = false;
    councilBackupSave('meeting:' + ui.date, ui.draft); csScheduleSave(300);
    csMeetingRerender({ form: true, bar: true });
  });

  document.addEventListener('keydown', csMeetingKeys, true);
  window.addEventListener('beforeunload', () => { const ui = csMeetingUi(); if (ui) councilBackupSave('meeting:' + ui.date, ui.draft); });
}

function csFieldInput(el) {
  const it = csCurrentItem();
  if (!it) return;
  const field = el.dataset.field;
  csDraftSet(it.id, field, el.value);
  if (field === 'ownerName' || field === 'dueDate') csMeetingRerender({ form: false });
}

function csMeetingKeys(event) {
  if (!csMeetingUi()) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key === 'Enter') { event.preventDefault(); const accept = document.querySelector('[data-action="cs-m-accept"]'); if (accept && !accept.disabled) accept.click(); return; }
  if (document.getElementById('councilDialog')?.open || mod || event.altKey) return;
  const typing = event.target.closest?.('input, textarea, select');
  if (typing) { if (event.key === 'Escape') typing.blur(); return; }
  if (event.key === 'ArrowRight' || event.code === 'KeyJ') { event.preventDefault(); csMeetingGo(csMeetingUi().sel + 1); }
  else if (event.key === 'ArrowLeft' || event.code === 'KeyK') { event.preventDefault(); csMeetingGo(csMeetingUi().sel - 1); }
  else if (event.code === 'KeyD') { event.preventDefault(); document.getElementById('csDecision')?.focus(); }
}

async function csApplyProjectMapping(list) {
  if (!list.length) { csCloseDialog(); return; }
  const c = state.council;
  const ctx = csCtx();
  const ids = [];
  list.forEach(x => c.orders.filter(o => projectKey(o.projectRaw) === x.key && !o.projectId).forEach(o => ids.push([o.orderId, x])));
  const keys = ['settings:main', ...ids.map(([id]) => 'order:' + id)];
  const res = await councilMutate(keys, current => {
    const settings = current.get('settings:main') || { ...c.settings, rev: 0 };
    const map = { ...(settings.projectMap || {}) };
    list.forEach(x => { map[x.key] = x.id; });
    const records = [{ ...settings, projectMap: map }];
    ids.forEach(([id, x]) => {
      const o = current.get('order:' + id);
      if (!o || o.projectId) return;
      const next = councilEdit(o, { projectRaw: o.projectRaw, projectId: x.id }, ctx).order;
      records.push(next);
    });
    return { records };
  });
  if (res.ok) { csCloseDialog(); showToast('Названия сопоставлены'); csRefresh(); } else csFail(res, 'Не удалось сопоставить.');
}

if (typeof document !== 'undefined' && document.getElementById('councilDialog')) bindCouncil();
