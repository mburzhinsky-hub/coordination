'use strict';

const DB_NAME = 'coordination.daily.v2';
const DB_VERSION = 1;
const LEGACY_EXPORTS_KEY = 'bitrixTaskDashboard.localExports.v1';
const CONTROL_WATCH_DAYS = 3;
const CONTROL_CRITICAL_DAYS = 5;
const DUE_SOON_DAYS = 3;
const CHRONIC_OVERDUE_DAYS = 14;
const LEGACY_OVERDUE_DAYS = 30;
const QUIET_CHRONIC_DAYS = 7;
const QUIET_LEGACY_DAYS = 14;
const DEADLINE_CHURN_DAYS = 14;
const DEADLINE_CHURN_COUNT = 3;
const SIGNAL_FRESH_DAYS = 7;

const ITO_ROSTER = [
  'Дмитрий Храпугин',
  'Семён Онищенко',
  'Максим Буржинский',
  'Павел Сергеев',
  'Иван Чуманов',
  'Александр Филин',
  'Игорь Виденнев',
  'Евгения Розанова',
  'Денис Якушев',
  'Константин Грачков',
  'Петр Априков',
  'Владимир Васильев'
];


const ITO_PROJECTS = [
  { id: 'kazan', name: 'Казанский ЦУМ', type: 'Техническая реализация', fullName: 'Казанский ЦУМ — техническая реализация', aliases: ['Казанский ЦУМ', 'Казанский ЦУМ Навигатор будущего', 'Навигатор будущего', 'ЦУМ. Профцентр в Казани', 'ЦУМ Казань Профцентр', 'ЦУМ_Казань_Профцентр', 'Казань Навигатор будущего'] },
  { id: 'grozny', name: 'Грозный планетарий', type: 'Техническая реализация', fullName: 'Грозный планетарий — техническая реализация', aliases: ['Грозный планетарий', 'Грозный Музей космоса', 'Музей космоса Грозный', 'Грозный. Музей космонавтики', 'Грозный, Музей космоса', 'Музей космоса'] },
  { id: 'bakhrushin', name: 'Музей Бахрушина', type: 'Техническая реализация', fullName: 'Музей Бахрушина — техническая реализация', aliases: ['Музей Бахрушина', 'Музей имени Бахрушина', 'Бахрушина', 'Бахрушинский музей', 'М. Бахрушина'] },
  { id: 'csn', name: 'ЦСН', type: 'Техническая реализация', fullName: 'ЦСН — техническая реализация', aliases: ['ЦСН', 'Музей ЦСН', 'Музей ФСБ', 'ЦСН (ФСБ)', 'ФСБ Балашиха'] },
  { id: 'ekb', name: 'ЕКБ', type: 'Техническая реализация', fullName: 'ЕКБ — техническая реализация', aliases: ['ЕКБ', 'Екатеринбург'] },
  { id: 'luzhniki', name: 'Лужники', type: 'Техническое сопровождение', fullName: 'Лужники — техническое сопровождение', aliases: ['Лужники', 'Лужники БСА'] },
  { id: 'tapiau', name: 'Музей Тапиау', type: 'Тех поддержка', fullName: 'Музей Тапиау — тех поддержка', aliases: ['Музей Тапиау', 'Тапиау'] },
  { id: 'kresty', name: 'Кресты', type: 'Техническая реализация', fullName: 'Кресты — техническая реализация', aliases: ['Кресты', 'Кресты музей СПБ', 'Кресты Музей СПБ', 'Кресты музей спб техническая реализация', 'Кресты Музей СПБ - техническая реализация', 'Кресты Музей СПБ — техническая реализация'] },
  { id: 'dom-kultur', name: 'Дом культур', type: 'Обслуживание', fullName: 'Дом культур — обслуживание', aliases: ['Дом культур'] }
];

const PRESENCE_MODES = [
  { id: 'office', label: 'В офисе' },
  { id: 'site', label: 'На объекте' },
  { id: 'remote', label: 'Удалённо' },
  { id: 'vacation', label: 'В отпуске' }
];


const KNOWN_PROJECT_CONTAINERS = [
  'Грозный Музей космоса — техническая реализация',
  'Музей имени Бахрушина — техническая реализация',
  'ЦЗН "Печатники" — гарантийное сопровождение',
  'Дом культур — обслуживание',
  'Автопоезд 2.0 — обслуживание',
  'Лужники — техническое сопровождение',
  'Проекты маркетинга — техническое сопровождение',
  'Общие офисные и внутренние задачи',
  'Кресты Музей СПБ - техническая реализация',
  'ЭКСПО 2027 - техническая реализация',
  'Нац центр Рязань - техническая реализация',
  'Музей Тапиау - тех поддержка',
  'Просчеты ИТО',
  'Задачи руководителя ИТО',
  'Пресейл и техническая экспертиза (уровень Технического директора)',
  'ЦСН - техническая реализация',
  'Казанский ЦУМ "Навигатор будущего" — техническая реализация'
];

const IGNORED_DAILY_TASKS = [
  'Ежедневная проверка статусов закупок/договоров',
  'Ежедневный контроль выполнения задач'
];

const state = {
  db: null,
  snapshots: [],
  currentSnapshot: null,
  latestSnapshot: null,
  historyMode: false,
  currentView: 'today',
  route: { name: 'today', arg: '' },
  briefing: null,
  presence: { people: {} },
  roster: [],
  triage: {},
  pendingPresence: null,
  pendingPresenceSnapshotId: null,
  busy: false,
  localDb: null,
  sharedMode: false,
  sharedRevision: 0,
  syncTimer: null,
  syncing: false,
  tvOpen: false,
  tvTimer: 0,
  ui: { inboxFilter: 'all', sel: 0, assignFor: '', peopleSel: '', projectSel: '', debtFilter: 'all', histSel: '', introSeen: false, sheetTask: '', toastUndo: null, tvScene: 0, prevRoute: 'today' }
};

function viewFor(name) {
  return { today: viewToday, inbox: viewInbox, people: viewPeople, projects: viewProjects, horizon: viewHorizon, debt: viewDebt, history: viewHistory }[name] || viewToday;
}
const INTRO_KEY = 'coordination.intro';
const TRIAGE_KEEP_DAYS = 90;

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('DOMContentLoaded', init);
}

async function init() {
  try { state.ui.introSeen = localStorage.getItem(INTRO_KEY) === 'seen'; } catch (_) {}
  fx.apply();
  renderChrome();
  bindUi();
  renderLoading('Загружаю историю…');
  try {
    state.db = await openDb();
    if (state.sharedMode) await migrateIndexedDbToSharedIfEmpty();
    else await migrateLegacyExports();
    await seedRepositorySnapshots();
    await refreshSnapshots();
    if (!state.snapshots.length) {
      renderEmpty();
      return;
    }
    state.latestSnapshot = state.snapshots[state.snapshots.length - 1];
    state.currentSnapshot = state.latestSnapshot;
    state.roster = await loadRoster();
    state.presence = await loadPresence(state.currentSnapshot.id) || { people: {} };
    state.triage = await loadTriage();
    applyRoute(parseRoute(), { first: true });
    startSharedSync();
    startClock();
  } catch (error) {
    console.error(error);
    renderError(error.message || String(error));
  }
}

/* ---------- chrome (rail, top bar, tab bar) ---------- */

function renderChrome() {
  const link = (route, label, ic, badgeId) => `<a class="rail-link" data-route="${route}" href="#/${route}">${icon(ic)}<span>${label}</span>${badgeId ? `<span id="${badgeId}" class="badge" hidden></span>` : ''}</a>`;
  document.getElementById('rail').innerHTML = `
    <a class="brand" href="#/today" aria-label="ИТО — на главную">${logoMark(38)}<span><b>ИТО</b><small>Координация</small></span></a>
    <nav class="rail-nav">
      <p class="rail-group">Сейчас</p>${link('today', 'Сегодня', 'today')}${link('inbox', 'Входящие', 'alert', 'badgeInbox')}
      <p class="rail-group">Отдел</p>${link('people', 'Люди и нагрузка', 'users')}${link('projects', 'Проекты', 'folder')}${link('horizon', 'Горизонт', 'cal')}
      <p class="rail-group">Ритуалы</p>${link('debt', 'Ревизия долга', 'layers', 'badgeDebt')}${link('history', 'История срезов', 'rewind')}
    </nav>
    <div class="rail-foot">
      <div class="rail-card">
        <div class="sync-line"><i class="dot"></i><span id="syncStatus" class="sync-status">Локально</span></div>
        <b id="railWhen">Срез</b><small id="railRows"></small>
        <label class="drop" for="uploadInput">${icon('upload')}<span>Перетащите выгрузку Bitrix<small>.xls, структуру проверим сами</small></span></label>
      </div>
      <div class="rail-tools">
        <button type="button" class="tool" data-action="tv-open">${icon('tv')}<span>Экран</span></button>
        <button type="button" class="tool" data-action="help-open">${icon('help')}<span>Справка</span></button>
        <button type="button" class="tool" id="fxToggle" data-action="fx-toggle" aria-pressed="false">${icon('spark')}<span>Эффекты</span></button>
      </div>
    </div>`;
  document.getElementById('topbar').innerHTML = `
    <a class="topbar-brand" href="#/today" aria-label="На главную">${logoMark(30)}</a>
    <button class="search" type="button" data-action="palette-open" aria-label="Поиск и команды">${icon('search')}<span>Поиск: задачи, люди, проекты</span><kbd class="kbd">⌘K</kbd></button>
    <span class="topbar-spacer"></span>
    <span id="freshChip" class="chip chip-muted"><i class="dot"></i>Загружаю…</span>
    <label class="btn btn-dark btn-refresh" for="uploadInput">${icon('refresh')}<span>Обновить</span></label>
    <input id="uploadInput" class="visually-hidden" type="file" accept=".xls,.html,.htm,.txt" />`;
  document.getElementById('tabbar').innerHTML = `
    <a data-route="today" href="#/today">${icon('today')}<span>Сегодня</span></a>
    <a data-route="inbox" href="#/inbox">${icon('alert')}<span>Входящие</span><i id="tabBadgeInbox" class="badge badge-red" hidden></i></a>
    <a data-route="people" href="#/people">${icon('users')}<span>Люди</span></a>
    <a data-route="projects" href="#/projects">${icon('folder')}<span>Проекты</span></a>
    <button type="button" data-action="palette-open">${icon('more')}<span>Ещё</span></button>`;
  syncFxToggle();
}

function syncFxToggle() {
  const btn = document.getElementById('fxToggle');
  if (!btn) return;
  const on = fx.enabled();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Анимации включены. Нажмите, чтобы выключить' : 'Анимации выключены. Нажмите, чтобы включить';
  btn.classList.toggle('is-on', on);
}

/* ---------- routing ---------- */

function parseRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/');
  const name = parts[0] || 'today';
  let arg = '';
  try { arg = decodeURIComponent(parts.slice(1).join('/')); } catch (_) { arg = ''; }
  if (name === 'tv') return { name, arg };
  return ROUTES[name] ? { name, arg } : { name: 'today', arg: '' };
}

function navigate(name, arg = '') {
  const target = `#/${name}${arg ? '/' + encodeURIComponent(arg) : ''}`;
  if (location.hash === target) applyRoute(parseRoute());
  else location.hash = target;
}

function applyRoute(route, opts = {}) {
  if (!state.currentSnapshot) return;
  if (route.name === 'tv') { openTv(); return; }
  if (state.tvOpen) closeTv(false);
  const previous = state.route;
  state.route = route;
  state.currentView = route.name;
  const ui = state.ui;
  ui.assignFor = '';
  if (route.name === 'today' || route.name === 'inbox') {
    if (['all', 'projects', 'acceptance', 'operational'].includes(route.arg)) ui.inboxFilter = route.arg;
    else if (!route.arg) ui.inboxFilter = 'all';
    ui.sel = 0;
  }
  if (route.name === 'people' && route.arg) ui.peopleSel = canonicalItoName(route.arg) || route.arg;
  if (route.name === 'projects' && route.arg) ui.projectSel = route.arg;
  closeTaskSheet();
  renderCurrentView({ sweep: !opts.first });
  if (previous.name !== route.name || previous.arg !== route.arg) window.scrollTo({ top: 0 });
  if (!opts.first) document.getElementById('viewRoot')?.focus({ preventScroll: true });
}

function switchView(view) { navigate(view || 'today'); }

/* ---------- render ---------- */

function renderCurrentView(opts = {}) {
  const snapshot = state.currentSnapshot;
  if (!snapshot) { renderEmpty(); return; }
  const root = document.getElementById('viewRoot');
  const b = buildBriefing(snapshot, state.snapshots, state.presence, new Date());
  state.briefing = b;
  const view = viewFor(state.route.name);
  root.classList.toggle('no-anim', Boolean(opts.soft));
  root.innerHTML = view(b);
  renderShell(b);
  syncFxToggle();
  if (!state.tvOpen) fx.mount(root, { soft: Boolean(opts.soft) });
  if (opts.sweep) fx.sweep();
  if (state.tvOpen) renderTvNow();
  const dialog = document.getElementById('taskDialog');
  if (dialog?.open && state.ui.sheetTask) renderTaskSheetBody(state.ui.sheetTask);
}

function softRender() { renderCurrentView({ soft: true }); }

/* ---------- triage: decisions kept in the dashboard ---------- */

async function loadTriage() {
  try { const rec = await getRecord('settings', 'triage'); return rec?.value && typeof rec.value === 'object' ? rec.value : {}; } catch (_) { return {}; }
}

async function saveTriageEntries(entries) {
  const base = state.sharedMode ? await loadTriage() : { ...state.triage };
  const limit = Date.now() - TRIAGE_KEEP_DAYS * 86400000;
  for (const [id, entry] of Object.entries(entries)) { if (entry === null) delete base[id]; else base[id] = entry; }
  for (const [id, entry] of Object.entries(base)) { if (new Date(entry.at).getTime() < limit) delete base[id]; }
  state.triage = base;
  await putRecord('settings', { id: 'triage', value: base });
}

async function applyTriage(ids, kind, extra = {}) {
  if (state.historyMode || !state.currentSnapshot) return;
  const snapshot = state.currentSnapshot;
  const list = (Array.isArray(ids) ? ids : [ids]).map(String);
  const before = {};
  const entries = {};
  list.forEach(id => {
    const task = snapshot.tasks.find(t => String(t.id) === id);
    if (!task) return;
    before[id] = state.triage[id] || null;
    entries[id] = kind === 'reopen' ? null : { action: kind, at: new Date().toISOString(), signature: task.signature, snapshotId: snapshot.id, person: extra.person || '' };
  });
  if (!Object.keys(entries).length) return;
  try { await saveTriageEntries(entries); } catch (error) { console.error(error); showToast('Не удалось сохранить решение. Попробуйте ещё раз.'); return; }
  state.ui.assignFor = '';
  const first = snapshot.tasks.find(t => String(t.id) === list[0]);
  const label = first ? shortLabel(first.title, 42) : '';
  const messages = {
    done: list.length > 1 ? `Готово: ${list.length} задач` : `Готово: ${label}`,
    snooze: list.length > 1 ? `Оставлено до следующего среза: ${list.length}` : 'Отложено до следующего среза',
    escalate: 'Отмечено как эскалация',
    assign: `Назначено: ${shortName(extra.person || '')}`
  };
  if (kind !== 'reopen') showToast(messages[kind] || 'Сохранено', { undoLabel: 'Отменить', onUndo: async () => { await saveTriageEntries(before); softRender(); } });
  const hidden = kind === 'done' || kind === 'snooze';
  if (hidden && state.ui.sheetTask && list.includes(state.ui.sheetTask)) closeTaskSheet();
  softRender();
}

function currentInboxList() {
  if (!state.currentSnapshot) return [];
  return filterInbox(buildInbox(state.currentSnapshot, state.triage), state.ui.inboxFilter);
}

/* ---------- history mode, TV, help ---------- */

async function showSnapshot(snapshot) {
  state.historyMode = Boolean(state.latestSnapshot && snapshot.id !== state.latestSnapshot.id);
  state.currentSnapshot = snapshot;
  state.presence = await loadPresence(snapshot.id) || { people: {} };
}

function openTv() {
  if (!state.currentSnapshot) return;
  const root = document.getElementById('tvRoot');
  if (!state.tvOpen) state.ui.prevRoute = state.route.name === 'tv' ? 'today' : state.route.name;
  state.tvOpen = true;
  root.hidden = false;
  document.body.classList.add('tv-open');
  state.ui.tvScene = 0;
  renderTvNow();
  clearInterval(state.tvTimer);
  state.tvTimer = setInterval(() => { state.ui.tvScene = (state.ui.tvScene + 1) % TV_SCENES; renderTvNow(); }, 20000);
  try { if (!document.fullscreenElement && root.requestFullscreen) root.requestFullscreen().catch(() => {}); } catch (_) {}
}

function renderTvNow() {
  const root = document.getElementById('tvRoot');
  if (!root || !state.currentSnapshot) return;
  const b = buildBriefing(state.currentSnapshot, state.snapshots, state.presence, new Date());
  root.innerHTML = renderTv(b, state.ui.tvScene);
  fx.mount(root, { soft: false });
}

function closeTv(updateHash = true) {
  if (!state.tvOpen) return;
  state.tvOpen = false;
  clearInterval(state.tvTimer);
  const root = document.getElementById('tvRoot');
  root.hidden = true;
  root.innerHTML = '';
  document.body.classList.remove('tv-open');
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
  if (updateHash) navigate(state.ui.prevRoute || 'today');
}

function openHelp() {
  document.getElementById('helpBody').innerHTML = renderHelpBody();
  const dialog = document.getElementById('helpDialog');
  if (!dialog.open) dialog.showModal();
}

function runAppFunction(name) {
  if (name === 'upload') document.getElementById('uploadInput')?.click();
  else if (name === 'presence') { if (state.currentSnapshot) preparePresenceEditor(state.currentSnapshot, true); }
  else if (name === 'tv') navigate('tv');
  else if (name === 'fx') ACTIONS['fx-toggle']();
  else if (name === 'help') openHelp();
}

function startClock() {
  setInterval(() => {
    if (!state.briefing || !state.currentSnapshot || state.historyMode) return;
    state.briefing.freshness = snapshotFreshness(state.currentSnapshot, new Date());
    renderShell(state.briefing);
  }, 60000);
}

async function copyText(text, okMessage) {
  try { await navigator.clipboard.writeText(text); showToast(okMessage || 'Скопировано'); }
  catch (_) { showToast('Браузер не дал скопировать. Выделите текст вручную.'); }
}

/* ---------- actions (delegated clicks) ---------- */

const ACTIONS = {
  'palette-open': () => openPalette(),
  task: el => openTaskSheet(el.dataset.id),
  'sheet-close': () => closeTaskSheet(),
  person: el => {
    const name = el.dataset.person;
    if (state.route.name === 'people') { state.ui.peopleSel = name; try { history.replaceState(null, '', `#/people/${encodeURIComponent(name)}`); } catch (_) {} softRender(); }
    else navigate('people', name);
  },
  'select-item': el => {
    const list = currentInboxList();
    const idx = list.findIndex(i => String(i.taskId) === el.dataset.id);
    if (idx < 0) return;
    state.ui.sel = idx; state.ui.assignFor = '';
    /* narrow screens have no side pane: the task opens as a bottom sheet with the same decision buttons */
    if (state.route.name === 'inbox' && window.matchMedia?.('(max-width: 900px)').matches) { softRender(); openTaskSheet(el.dataset.id); return; }
    softRender();
    if (state.route.name === 'inbox') document.getElementById('viewRoot').querySelector('.inbox-detail')?.scrollTo?.(0, 0);
  },
  'inbox-filter': el => {
    state.ui.inboxFilter = el.dataset.filter; state.ui.sel = 0; state.ui.assignFor = '';
    if (state.route.name === 'inbox') { try { history.replaceState(null, '', `#/inbox${el.dataset.filter === 'all' ? '' : '/' + el.dataset.filter}`); } catch (_) {} }
    softRender();
  },
  'assign-open': el => {
    const id = el.dataset.id;
    const list = currentInboxList();
    const idx = list.findIndex(i => String(i.taskId) === id);
    if (idx >= 0) state.ui.sel = idx;
    state.ui.assignFor = state.ui.assignFor === id ? '' : id;
    softRender();
    if (document.getElementById('taskDialog')?.open) renderTaskSheetBody(state.ui.sheetTask);
  },
  triage: el => applyTriage(el.dataset.id, el.dataset.kind, { person: el.dataset.person || '' }),
  'triage-batch': el => applyTriage((el.dataset.ids || '').split(',').filter(Boolean), el.dataset.kind),
  'toast-undo': async () => { const fn = state.ui.toastUndo; document.getElementById('toastRoot')?.classList.remove('is-on'); state.ui.toastUndo = null; if (fn) await fn(); },
  'intro-dismiss': () => { state.ui.introSeen = true; try { localStorage.setItem(INTRO_KEY, 'seen'); } catch (_) {} softRender(); },
  'edit-presence': () => { if (state.currentSnapshot && !state.historyMode) preparePresenceEditor(state.currentSnapshot, true); },
  term: el => showTermPopover(el, el.dataset.term),
  copy: el => copyText(el.dataset.text),
  'copy-done': el => {
    const ids = (el.dataset.ids || '').split(',').filter(Boolean);
    const lines = ids.map(id => state.currentSnapshot.tasks.find(t => String(t.id) === id)).filter(Boolean).map(t => `№${t.id} · ${t.title} · ${t.project} · ${canonicalItoName(t.responsible) || t.responsible}`);
    copyText(lines.join('\n'), `Скопировано: ${lines.length} ${pluralRu(lines.length, 'задача', 'задачи', 'задач')}`);
  },
  'debt-filter': el => { state.ui.debtFilter = el.dataset.filter; softRender(); },
  'history-select': el => { state.ui.histSel = el.dataset.id; softRender(); },
  'history-open': async el => {
    const snap = state.snapshots.find(s => s.id === el.dataset.id);
    if (!snap) return;
    await showSnapshot(snap);
    navigate('today');
    if (location.hash === '#/today') renderCurrentView({ sweep: true });
  },
  'history-live': async () => { if (state.latestSnapshot) { await showSnapshot(state.latestSnapshot); renderCurrentView({ sweep: true }); } },
  'tv-open': () => navigate('tv'),
  'tv-exit': () => closeTv(true),
  'fx-toggle': () => {
    const on = !fx.enabled();
    fx.setEnabled(on);
    syncFxToggle();
    renderCurrentView({ soft: !on });
    showToast(on ? 'Анимации включены' : 'Анимации выключены');
  },
  'help-open': () => { hideTermPopover(); openHelp(); },
  'help-close': () => document.getElementById('helpDialog')?.close()
};

/* ---------- wiring ---------- */

function bindUi() {
  const upload = document.getElementById('uploadInput');
  if (upload) upload.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handleUpload(file);
  });

  document.addEventListener('click', async event => {
    const target = event.target;
    if (!target.closest('.termpop') && !target.closest('[data-action="term"]')) hideTermPopover();
    const el = target.closest('[data-action]');
    if (!el || el.disabled) return;
    const handler = ACTIONS[el.dataset.action];
    if (!handler) return;
    event.preventDefault();
    try { await handler(el, event); } catch (error) { console.error(error); showToast('Что-то пошло не так. Подробности в консоли.'); }
  });

  window.addEventListener('hashchange', () => applyRoute(parseRoute()));
  document.addEventListener('keydown', onKeydown);
  bindPalette();
  bindDialogs();
  bindPresence();
  bindDrop();
}

function bindDialogs() {
  const task = document.getElementById('taskDialog');
  if (task) {
    task.addEventListener('click', event => { if (event.target === task) closeTaskSheet(); });
    task.addEventListener('close', () => { state.ui.sheetTask = ''; });
  }
  const help = document.getElementById('helpDialog');
  if (help) help.addEventListener('click', event => { if (event.target === help) help.close(); });
}

function bindPresence() {
  document.getElementById('presenceClose')?.addEventListener('click', () => document.getElementById('presenceDialog')?.close());
  document.getElementById('presenceSkip')?.addEventListener('click', async () => savePendingPresence(false));
  document.getElementById('presenceSave')?.addEventListener('click', async () => savePendingPresence(true));
  document.getElementById('presenceMatrix')?.addEventListener('change', event => {
    if (!state.pendingPresence) return;
    const modeSelect = event.target.closest('[data-presence-person]');
    if (modeSelect) {
      const person = modeSelect.dataset.presencePerson;
      if (!state.pendingPresence.people[person]) state.pendingPresence.people[person] = { mode: 'office', projectId: '' };
      state.pendingPresence.people[person].mode = modeSelect.value;
      updatePresenceRow(person);
      return;
    }
    const projectSelect = event.target.closest('[data-presence-project-person]');
    if (projectSelect) {
      const person = projectSelect.dataset.presenceProjectPerson;
      if (!state.pendingPresence.people[person]) state.pendingPresence.people[person] = { mode: 'site', projectId: '' };
      state.pendingPresence.people[person].projectId = projectSelect.value;
    }
  });
}

function bindDrop() {
  const veil = document.getElementById('dropVeil');
  let depth = 0;
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', event => { if (!hasFiles(event)) return; depth++; veil.hidden = false; });
  window.addEventListener('dragleave', event => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
  window.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', async event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0; veil.hidden = true;
    const file = event.dataTransfer.files?.[0];
    if (file) await handleUpload(file);
  });
}

function anyDialogOpen() { return [...document.querySelectorAll('dialog')].some(d => d.open); }
function isTyping(target) { return target && (target.closest?.('input, textarea, select, [contenteditable="true"]')); }

function onKeydown(event) {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.code === 'KeyK') { event.preventDefault(); if (document.getElementById('paletteDialog').open) closePalette(); else openPalette(); return; }
  if (isTyping(event.target)) return;
  if (state.tvOpen) {
    if (event.key === 'Escape') { event.preventDefault(); closeTv(true); }
    else if (event.key === 'ArrowRight') { state.ui.tvScene = (state.ui.tvScene + 1) % TV_SCENES; renderTvNow(); }
    else if (event.key === 'ArrowLeft') { state.ui.tvScene = (state.ui.tvScene + TV_SCENES - 1) % TV_SCENES; renderTvNow(); }
    return;
  }
  if (event.key === 'Escape') { hideTermPopover(); return; }
  if (mod || event.altKey || anyDialogOpen() || !state.currentSnapshot) return;
  if (event.key === '/') { event.preventDefault(); openPalette(); return; }
  const screens = ['today', 'inbox', 'people', 'projects', 'horizon', 'debt', 'history'];
  const digit = /^Digit([1-7])$/.exec(event.code);
  if (digit) { event.preventDefault(); navigate(screens[Number(digit[1]) - 1]); return; }
  if (state.route.name !== 'today' && state.route.name !== 'inbox') return;
  const list = currentInboxList();
  if (!list.length) return;
  const move = delta => { event.preventDefault(); state.ui.sel = Math.max(0, Math.min(list.length - 1, state.ui.sel + delta)); state.ui.assignFor = ''; softRender(); document.getElementById('viewRoot').querySelector('.irow.is-sel')?.scrollIntoView({ block: 'nearest' }); };
  if (event.code === 'KeyJ') return move(1);
  if (event.code === 'KeyK') return move(-1);
  const item = list[Math.min(state.ui.sel, list.length - 1)];
  if (!item) return;
  if (event.code === 'KeyA') { event.preventDefault(); ACTIONS['assign-open']({ dataset: { id: String(item.taskId) } }); }
  else if (event.code === 'KeyS') { event.preventDefault(); applyTriage(item.taskId, 'snooze'); }
  else if (event.code === 'KeyE') { event.preventDefault(); applyTriage(item.taskId, 'escalate'); }
  else if (event.key === 'Enter' && !document.activeElement?.closest?.('button, a, summary, input, select, textarea, [role="button"]')) { event.preventDefault(); applyTriage(item.taskId, 'done'); }
}
