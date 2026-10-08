'use strict';
/* Command palette (⌘K / Ctrl+K): any screen, project, person, task or action in two keystrokes. */

const PALETTE_SCREENS = [
  { id: 'today', label: 'Сегодня', hint: 'Главное за день', icon: 'today', words: 'главная обзор сегодня что происходит' },
  { id: 'inbox', label: 'Входящие', hint: 'Очередь решений', icon: 'alert', words: 'внимание входящие решить сигналы очередь' },
  { id: 'people', label: 'Люди и нагрузка', hint: 'Кто чем занят', icon: 'users', words: 'люди нагрузка сотрудники команда' },
  { id: 'projects', label: 'Проекты', hint: 'Девять объектов', icon: 'folder', words: 'проекты объекты' },
  { id: 'horizon', label: 'Горизонт', hint: 'Сроки на недели вперёд', icon: 'cal', words: 'горизонт сроки план календарь' },
  { id: 'debt', label: 'Ревизия долга', hint: 'Закрыть, списать, вернуть', icon: 'layers', words: 'ревизия долг списать' },
  { id: 'history', label: 'История срезов', hint: 'Машина времени', icon: 'rewind', words: 'история срезы машина времени сравнить' }
];

const PALETTE_ACTIONS = [
  { id: 'acc-old', label: `Показать все приёмки старше ${CONTROL_OLD_DAYS} дней`, icon: 'bolt', route: 'inbox', arg: 'acceptance', words: 'приёмки контроль застряли' },
  { id: 'upload', label: 'Загрузить выгрузку Bitrix', icon: 'upload', fn: 'upload', words: 'обновить загрузить выгрузка файл xls' },
  { id: 'presence', label: 'Отметить, кто где сегодня', icon: 'pin', fn: 'presence', words: 'кто где присутствие офис объект отпуск' },
  { id: 'telegram', label: 'Ники сотрудников в Telegram', icon: 'send', fn: 'telegram', words: 'телеграм telegram ники контакты написать сообщение' },
  { id: 'tv', label: 'Экран для офиса (на весь экран)', icon: 'tv', fn: 'tv', words: 'экран телевизор стена tv' },
  { id: 'fx', label: 'Эффекты: включить или выключить', icon: 'spark', fn: 'fx', words: 'анимации глич точки эффекты' },
  { id: 'help', label: 'Справка: что значат слова', icon: 'help', fn: 'help', words: 'справка помощь термины словарь' }
];

function paletteTaskMeta(task) {
  const who = shortName(canonicalItoName(task.responsible) || task.responsible);
  if (task.isWaitingControl) return `приёмка ${shortDays(task.waitingControlDays || 0)} · ${who}`;
  if (task.overdue) return `просрочка ${shortDays(task.overdueDays)} · ${who}`;
  return `${task.project === 'Операционная работа' ? 'Операционка' : task.project} · ${who}`;
}

/** Pure: returns groups of result descriptors for a query. */
function paletteResults(snapshot, query, triage = {}) {
  const q = normalizeHeader(query);
  const has = text => normalizeHeader(text).includes(q);
  const groups = [];
  const screenItem = s => ({ kind: 'route', route: s.id, title: s.label, meta: s.hint, icon: s.icon });
  const actionItem = a => ({ kind: a.fn ? 'fn' : 'route', fn: a.fn, route: a.route, arg: a.arg, title: a.label, meta: '', icon: a.icon });
  if (!q) {
    const urgent = buildInbox(snapshot, triage).items.slice(0, 3).map(i => ({ kind: 'task', id: i.taskId, title: i.title, meta: paletteTaskMeta(i.task), icon: 'check' }));
    if (urgent.length) groups.push({ title: 'Срочное', items: urgent });
    groups.push({ title: 'Экраны', items: PALETTE_SCREENS.map(screenItem) });
    groups.push({ title: 'Действия', items: PALETTE_ACTIONS.map(actionItem) });
    return groups;
  }
  const found = searchEntities(snapshot, query, 5);
  if (found.projects.length) groups.push({ title: 'Проекты', items: found.projects.map(p => {
    const card = buildProjectCards(snapshot, null).find(c => c.id === p.id);
    return { kind: 'route', route: 'projects', arg: p.id, title: p.name, meta: card ? `${card.counts.open} открытых · ${card.counts.acceptance} в приёмке · ${card.label.toLowerCase()}` : p.type, icon: 'folder' };
  }) });
  if (found.people.length) groups.push({ title: 'Люди', items: found.people.map(n => ({ kind: 'route', route: 'people', arg: n, title: displayName(n), meta: 'Люди и нагрузка', icon: 'user' })) });
  if (found.tasks.length) groups.push({ title: 'Задачи', items: found.tasks.map(t => ({ kind: 'task', id: t.id, title: t.title, meta: paletteTaskMeta(t), icon: 'check' })) });
  const screens = PALETTE_SCREENS.filter(s => has(s.label) || has(s.words));
  if (screens.length) groups.push({ title: 'Экраны', items: screens.map(screenItem) });
  const actions = PALETTE_ACTIONS.filter(a => has(a.label) || has(a.words));
  if (actions.length) groups.push({ title: 'Действия', items: actions.map(actionItem) });
  return groups;
}

/* ---------- DOM part ---------- */

const paletteState = { items: [], sel: 0 };

function openPalette() {
  const dialog = document.getElementById('paletteDialog');
  if (!dialog || !state.currentSnapshot) return;
  if (!dialog.open) dialog.showModal();
  const input = document.getElementById('paletteInput');
  input.value = '';
  renderPaletteList();
  input.focus();
}

function closePalette() { document.getElementById('paletteDialog')?.close(); }

function renderPaletteList() {
  const query = document.getElementById('paletteInput').value;
  const groups = paletteResults(state.currentSnapshot, query, state.triage);
  paletteState.items = groups.flatMap(g => g.items);
  paletteState.sel = Math.min(paletteState.sel, Math.max(0, paletteState.items.length - 1));
  let index = 0;
  const html = groups.map(g => `<div class="pgroup" role="group" aria-label="${escapeAttr(g.title)}"><div class="eyebrow">${escapeHtml(g.title)}</div>${g.items.map(item => {
    const i = index++;
    return `<div class="pitem ${i === paletteState.sel ? 'is-sel' : ''}" role="option" id="pitem-${i}" aria-selected="${i === paletteState.sel}" data-index="${i}"><span class="pitem-ico">${icon(item.icon)}</span><span class="pitem-body"><b>${escapeHtml(shortLabel(item.title, 90))}</b>${item.meta ? `<small>${escapeHtml(item.meta)}</small>` : ''}</span>${i === paletteState.sel ? `<kbd class="kbd">⏎</kbd>` : ''}</div>`;
  }).join('')}</div>`).join('');
  document.getElementById('paletteList').innerHTML = html || '<div class="pempty">Ничего не найдено. Попробуйте часть названия задачи, проекта или фамилию.</div>';
  document.getElementById('paletteInput').setAttribute('aria-activedescendant', paletteState.items.length ? `pitem-${paletteState.sel}` : '');
}

function movePalette(delta) {
  if (!paletteState.items.length) return;
  paletteState.sel = (paletteState.sel + delta + paletteState.items.length) % paletteState.items.length;
  renderPaletteList();
  document.getElementById(`pitem-${paletteState.sel}`)?.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(item) {
  if (!item) return;
  closePalette();
  if (item.kind === 'task') { openTaskSheet(item.id); return; }
  if (item.kind === 'route') { navigate(item.route, item.arg || ''); return; }
  if (item.kind === 'fn') runAppFunction(item.fn);
}

function bindPalette() {
  const input = document.getElementById('paletteInput');
  const dialog = document.getElementById('paletteDialog');
  const list = document.getElementById('paletteList');
  if (!input || !dialog) return;
  input.addEventListener('input', () => { paletteState.sel = 0; renderPaletteList(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(paletteState.items[paletteState.sel]); }
  });
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-index]');
    if (row) runPaletteItem(paletteState.items[Number(row.dataset.index)]);
  });
  list.addEventListener('pointermove', event => {
    const row = event.target.closest('[data-index]');
    if (row && Number(row.dataset.index) !== paletteState.sel) { paletteState.sel = Number(row.dataset.index); renderPaletteList(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) closePalette(); });
}
