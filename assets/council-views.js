'use strict';
/*
 * Tech council views, part 1: shared pieces, overview, registry, order card, history, import preview, dialogs.
 * Every function returns an HTML string; behaviour lives in council-app.js. Facts are shown as facts, guesses are marked as guesses.
 */

const CS_TABS = [
  { id: 'overview', label: 'Обзор', icon: 'today' },
  { id: 'registry', label: 'Реестр', icon: 'list' },
  { id: 'agenda', label: 'Повестка', icon: 'council' },
  { id: 'history', label: 'Заседания', icon: 'rewind' },
  { id: 'import', label: 'Загрузка реестра', icon: 'upload' }
];

function csSub() {
  const arg = state.route?.arg || '';
  const parts = arg.split('/');
  const head = parts[0];
  const tab = ['overview', 'registry', 'agenda', 'meeting', 'history', 'import', 'order'].includes(head) ? head : 'overview';
  return { tab, arg: parts.slice(1).join('/') };
}

function csHref(tab, arg) { return `#/council/${tab}${arg ? '/' + encodeURIComponent(arg) : ''}`; }

function csNow() {
  const today = cdLocalToday();
  const c = state.council;
  const orders = c.orders;
  const stats = councilStats(orders, today);
  const dates = councilMeetingDates(c.meetings, c.imports, today);
  const live = c.meetings.find(m => m.status === 'live') || null;
  return { c, today, orders, stats, dates, live };
}

/* ---------- small pieces ---------- */

const CS_STATE_TONE = { open: 'muted', in_progress: 'blue', decision: 'amber', blocked: 'red', control: 'blue', done: 'green', cancelled: 'muted' };

function csStateTag(order) {
  const st = councilState(order.state);
  return `<span class="tag tag-${CS_STATE_TONE[order.state] || 'muted'}">${escapeHtml(st.label)}</span>`;
}

function csOwnerHtml(order, opts = {}) {
  const names = councilOwnerNames(order);
  if (councilHasOwner(order) && names.length) {
    const first = names.slice(0, 2).map(n => `<span class="person-line">${avatarHtml(n, 22)}<span>${escapeHtml(shortName(canonicalItoName(n) || n))}</span></span>`).join('');
    return `<span class="cs-owner">${first}${names.length > 2 ? `<span class="tag tag-muted">+${names.length - 2}</span>` : ''}</span>`;
  }
  const label = { unassigned: 'Не назначен', ambiguous: 'Назван не полностью', group: 'Назначена группа', none: 'Не указан' }[order.owners?.state] || 'Не указан';
  return `<span class="cs-owner"><span class="tag tag-amber">${escapeHtml(label)}</span>${opts.raw && order.owners?.raw ? `<small class="muted">${escapeHtml(councilShort(order.owners.raw, 90))}</small>` : ''}</span>`;
}

function csDueHtml(order, today) {
  const due = order.due || {};
  const label = councilDueLabel(due);
  const date = councilDueDate(due);
  if (!label || due.kind === 'none') return '<span class="tag tag-muted">срок не задан</span>';
  if (councilIsOverdue(order, today)) return `<span class="tag tag-red" title="${escapeAttr(due.raw)}">${escapeHtml(label)} · просрочено ${escapeHtml(daysWord(councilOverdueDays(order, today)))}</span>`;
  if (date && !due.inferred && cdDiff(date, today) >= 0 && cdDiff(date, today) <= 3) return `<span class="tag tag-amber" title="${escapeAttr(due.raw)}">${escapeHtml(label)}</span>`;
  if (due.kind === 'condition') return `<span class="tag" title="${escapeAttr(due.raw)}">условие: ${escapeHtml(councilShort(due.raw, 40))}</span>`;
  return `<span class="tag" title="${escapeAttr(due.raw)}">${escapeHtml(label)}</span>`;
}

function csSourceMark(order, key) {
  const by = (order.by || {})[key];
  if (!by || by === 'import') return '';
  return `<small class="cs-src" title="${by === 'meeting' ? 'Записано на техсовете' : 'Изменено вручную в Coordination'}">${by === 'meeting' ? 'на совете' : 'вручную'}</small>`;
}

function csProjectTag(order) {
  const name = councilGroupName(order);
  const unknown = !order.projectId && order.projectRaw;
  return `<span class="tag ${unknown ? 'tag-amber' : ''}" title="${unknown ? 'Название проекта не распознано: сопоставьте его с проектом' : ''}">${escapeHtml(shortLabel(name, 26))}</span>`;
}

function csOrderRow(order, today, opts = {}) {
  const blocks = councilActiveBlocks(order);
  const sev = order.state === 'blocked' ? 'critical' : councilIsOverdue(order, today) || councilNeedsDecision(order) ? 'watch' : order.state === 'done' ? 'ok' : 'neutral';
  return `<a class="cs-row ${order.state === 'done' ? 'is-done' : ''}" href="${csHref('order', order.orderId)}" data-id="${escapeAttr(order.orderId)}">
    <span class="cs-no">${order.no ? '№' + escapeHtml(order.no) : '+'}</span>
    <span class="cs-row-main"><b class="cs-row-title">${escapeHtml(order.title)}</b>
      ${blocks.length ? `<span class="cs-row-sub">${icon('lock')}${escapeHtml(blocks.map(b => b.kind === 'order' ? 'ждёт другое поручение' : councilBlockKind(b.kind).label.toLowerCase()).join(', '))}</span>` : order.result && opts.result !== false ? `<span class="cs-row-sub">${escapeHtml(councilShort(order.result, 130))}</span>` : ''}</span>
    <span class="cs-row-owner">${csOwnerHtml(order)}</span>
    <span class="cs-row-due">${csDueHtml(order, today)}</span>
    <span class="cs-row-state">${order.critical ? '<span class="tag tag-red">критично</span>' : ''}${csStateTag(order)}<span class="cs-row-sev">${sevIcon(sev, 16)}</span></span>
  </a>`;
}

function csHead(title, note, actions = '', eyebrow = 'Техсовет ИТО') {
  return `<header class="view-head cs-head"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1 class="view-title">${title}</h1>${note ? `<p class="muted cs-note">${note}</p>` : ''}</div><div class="cs-actions">${actions}</div></header>`;
}

function csTabs(active) {
  const { c, orders } = csNow();
  const open = orders.filter(councilIsOpen).length;
  const sel = active === 'order' ? 'registry' : active;
  return `<nav class="cs-tabs" aria-label="Разделы техсовета">${CS_TABS.map(t => `<a class="cs-tab ${t.id === sel ? 'is-active' : ''}" href="${csHref(t.id)}" ${t.id === sel ? 'aria-current="page"' : ''}>${icon(t.icon)}<span>${t.label}</span>${t.id === 'registry' && open ? `<span class="count">${open}</span>` : ''}</a>`).join('')}</nav>`;
}

function csNoData() {
  return `<section class="view cs"><div class="onboard cs-onboard">${logoMark(72)}
    <h1>Загрузите реестр поручений</h1>
    <p>Техсовет работает с еженедельным реестром поручений в Excel (.xlsx). Файл разберётся сам, сначала покажем, что изменится, и только после вашего подтверждения запишем. Номера, статусы и комментарии сохранятся как в файле.</p>
    <label class="btn btn-dark" for="councilFileInput">${icon('upload')}Выбрать файл .xlsx</label>
    <ol class="onboard-steps"><li><b>1</b>Загрузите реестр. Каждому поручению присвоится постоянный номер TS-…, не зависящий от строки в Excel.</li><li><b>2</b>Откройте «Повестку»: вопросы соберутся из реестра по приоритетам.</li><li><b>3</b>Нажмите «Начать техсовет», записывайте решения. Следующий реестр дополнит историю, а не заменит её.</li></ol>
    <p class="muted cs-fine">Данные хранятся только в дашборде (браузер или общий сервер) и не попадают в репозиторий.</p></div></section>`;
}

/* ---------- shell for pages that render before Bitrix data exists ---------- */

function csView() {
  const c = state.council;
  if (!c.loaded) return `<section class="view cs"><div class="loading-state" role="status">${dotLoader(7)}<p>${c.error ? escapeHtml(c.error) : 'Загружаю поручения…'}</p></div></section>`;
  const sub = csSub();
  if (!c.orders.length && !['import', 'history'].includes(sub.tab)) return csNoData();
  const body = {
    overview: csOverview, registry: csRegistry, order: csOrderPage, agenda: csAgenda, history: csHistory, import: csImport
  }[sub.tab] || csOverview;
  return body(sub);
}

/* ---------- overview ---------- */

function csDateKpi(o) {
  return `<article class="kpi cs-kpi tone-${o.tone || 'ink'} rise" style="--i:${o.i || 0}"><div class="kpi-label">${o.label}</div>
    <div class="kpi-body"><div><div class="cs-kpi-date">${o.value}</div><div class="kpi-delta tone-muted">${escapeHtml(o.delta || '')}</div></div></div><div class="kpi-sub">${o.sub || ''}</div></article>`;
}

function csWhen(date, today) {
  if (!cdValid(date)) return '';
  const d = cdDiff(date, today);
  return d === 0 ? 'сегодня' : d === 1 ? 'завтра' : d > 1 ? `через ${daysWord(d)}` : `${daysWord(-d)} назад`;
}

function csOverview() {
  const { c, today, orders, stats, dates, live } = csNow();
  const next = live ? live.date : dates.next;
  const nextClosed = c.meetings.find(m => m.date === next && m.status === 'closed');
  const meetingToday = next === today;
  const agenda = councilBuildAgenda(orders, next, (councilMeetingByDate(next) || {}).agendaMeta || {});
  const first = agenda.counts.find(x => x.count && x.priority === 1);
  const headline = live ? [{ t: `Идёт техсовет от ${cdFmt(live.date)}` }]
    : meetingToday ? [{ t: 'Сегодня техсовет. ' }, stats.needsDecision ? { t: `${stats.needsDecision} ${pluralRu(stats.needsDecision, 'вопрос ждёт', 'вопроса ждут', 'вопросов ждут')} решения`, em: 'red' } : { t: 'Блокеров на решение нет', em: 'amber' }]
      : [{ t: `Техсовет ${cdLong(next)}. ` }, stats.needsDecision ? { t: `${stats.needsDecision} ${pluralRu(stats.needsDecision, 'вопрос ждёт', 'вопроса ждут', 'вопросов ждут')} решения`, em: 'red' } : { t: 'решений не ждёт никто', em: 'amber' }];
  const lastImport = c.imports.at(-1);
  const kpis = [
    csDateKpi({ i: 1, label: 'Последний техсовет', value: dates.lastHeld ? cdFmtFull(dates.lastHeld) : 'ещё не проводился', delta: dates.lastHeld ? csWhen(dates.lastHeld, today) : '', sub: dates.baseline ? `Реестр от ${cdFmtFull(dates.baseline)} загружен как исходный` : 'Реестр ещё не загружен' }),
    csDateKpi({ i: 2, label: 'Следующий техсовет', value: cdFmtFull(next), delta: csWhen(next, today), sub: `${agenda.total} ${pluralRu(agenda.total, 'вопрос', 'вопроса', 'вопросов')} в повестке` , tone: meetingToday ? 'red' : 'ink' }),
    kpiCard({ i: 3, tone: 'ink', label: 'Открытых поручений', value: stats.open, delta: { text: `всего в реестре ${stats.total}`, tone: 'muted' }, sub: `${stats.critical ? `${stats.critical} с пометкой «критично»` : 'критичных нет'}` }),
    kpiCard({ i: 4, tone: 'red', label: 'Требуют решения', value: stats.needsDecision, delta: { text: '', tone: 'muted' }, sub: stats.needsDecision ? 'нужен ответ техсовета' : 'ничего не ждёт решения' }),
    kpiCard({ i: 5, tone: 'red', label: 'Заблокированы', value: stats.blocked, delta: { text: '', tone: 'muted' }, sub: stats.blocked ? 'есть блокер: кто решает и что разблокируется — в карточке' : 'блокеров нет' }),
    kpiCard({ i: 6, tone: 'ink', label: 'Просрочены', value: stats.overdue, delta: { text: '', tone: 'muted' }, sub: stats.overdue ? 'срок или контрольная точка прошли' : 'просрочек нет' }),
    kpiCard({ i: 7, tone: 'ink', label: 'Без владельца', value: stats.noOwner, delta: { text: '', tone: 'muted' }, sub: stats.noOwner ? 'не назначен, назван не полностью или группой' : 'у всех есть ответственный' }),
    kpiCard({ i: 8, tone: 'green', label: 'Выполнено, подтверждено', value: stats.done, delta: { text: '', tone: 'muted' }, sub: stats.done ? 'подтверждено человеком' : 'выполнение из файла не считается' })
  ];
  const groups = agenda.groups.slice(0, 8);
  const unmapped = csUnmappedProjects(orders);
  const actions = `${live ? `<a class="btn btn-dark" href="${csHref('meeting')}">${icon('play')}Продолжить техсовет</a>` : nextClosed ? `<a class="btn btn-dark" href="${csHref('history', next)}">${icon('file')}Итоги техсовета</a>` : `<button class="btn btn-dark" type="button" data-action="cs-start-meeting" data-date="${escapeAttr(next)}">${icon('play')}Начать техсовет</button>`}<a class="btn btn-ghost" href="${csHref('agenda')}">Повестка</a>`;
  return `<section class="view cs cs-overview">
    <div class="hero cs-hero" data-glitch>
      <canvas class="hero-dots" data-dotfield aria-hidden="true"></canvas>
      <div class="hero-main">
        <div class="eyebrow">Техсовет ИТО · ${WEEKDAYS_CAP[cdWeekday(next)]}, ${cdLong(next)}</div>
        <h1 class="hero-title" data-reveal data-glitch>${headlineHtml(headline)}</h1>
        <p class="hero-note">${lastImport ? `Реестр от ${cdFmtFull(lastImport.asOf)}, загружен ${escapeHtml(formatDateTime(lastImport.importedAt))}. ` : ''}${first ? `Первыми в повестке: заблокированные вопросы, ${first.count}.` : 'Заблокированных вопросов нет.'}</p>
        <div class="cs-hero-actions">${actions}</div>
      </div>
      ${csHeroSummary(stats, agenda)}
    </div>
    ${csTabs('overview')}
    ${unmapped.length ? csUnmappedBanner(unmapped) : ''}
    <div class="kpis cs-kpis">${kpis.map((k, i) => i < 2 ? k : `<a class="cs-kpi-wrap" href="${csHref('registry')}" data-action="cs-filter-state" data-state="${['', '', 'open', 'needsDecision', 'blocked', 'overdue', 'noOwner', 'done'][i]}">${k}</a>`).join('')}</div>
    <section class="cs-block" aria-labelledby="csQ"><header class="block-head"><h2 id="csQ">Ключевые вопросы по проектам</h2><p class="muted">Сверху то, где без решения техсовета работа стоит. Источник каждого вопроса — реестр, предположения помечены.</p></header>
      <div class="cs-groups">${groups.map(csGroupCard).join('') || emptyState('Вопросов к техсовету нет', 'Все открытые поручения идут по плану: срок не горит, блокеров и просрочек нет.')}</div>
      ${agenda.groups.length > groups.length ? `<p class="muted cs-fine">Ещё проектов: ${agenda.groups.length - groups.length}. Все — в <a href="${csHref('agenda')}">повестке</a>.</p>` : ''}
    </section>
    <section class="cs-block"><header class="block-head"><h2>Последние заседания</h2></header>${csMeetingList(true)}</section>
  </section>`;
}

function csHeroSummary(stats, agenda) {
  const rows = agenda.counts.filter(x => x.count);
  const max = Math.max(1, ...rows.map(x => x.count));
  return `<figure class="cs-hero-fig" aria-label="Повестка по приоритетам"><figcaption><b>Из чего сложится повестка</b><span>Приоритет идёт сверху вниз</span></figcaption>
    <ol class="cs-prio">${(rows.length ? rows : []).map(x => `<li class="cs-prio-row p${x.priority}"><span class="cs-prio-n">${x.priority}</span><span class="cs-prio-label">${escapeHtml(x.label)}</span><span class="cs-prio-bar"><i style="width:${Math.max(6, Math.round(x.count / max * 100))}%"></i></span><b>${x.count}</b></li>`).join('') || '<li class="cs-prio-empty">Поводов для обсуждения нет</li>'}</ol></figure>`;
}

function csGroupCard(group) {
  const top = group.items.slice(0, 3);
  const blocked = group.items.filter(i => i.priority === 1).length;
  return `<article class="cs-group card rise"><header><div><h3>${escapeHtml(group.name)}</h3><span class="muted">${group.items.length} ${pluralRu(group.items.length, 'вопрос', 'вопроса', 'вопросов')}${blocked ? ` · ${blocked} на решение` : ''}</span></div>${group.projectId ? `<a class="more-link" href="#/projects/${encodeURIComponent(group.projectId)}">Проект${icon('arrow')}</a>` : ''}</header>
    <ul>${top.map(i => `<li><a href="${i.orderId ? csHref('order', i.orderId) : csHref('agenda')}"><span class="cs-prio-dot p${i.priority}" aria-hidden="true">${i.priority || '+'}</span><span class="cs-gq"><b>${escapeHtml(councilShort(i.headline, 110))}</b><small>${escapeHtml(i.reasons?.[0]?.text || i.kicker)}</small></span></a></li>`).join('')}</ul>
    ${group.items.length > 3 ? `<footer class="muted">и ещё ${group.items.length - 3} в повестке</footer>` : ''}</article>`;
}

/* ---------- councils list ---------- */

function csMeetingList(compact) {
  const { c, dates, today } = csNow();
  const rows = [];
  c.meetings.slice().sort((a, b) => b.date.localeCompare(a.date)).forEach(m => rows.push({ kind: 'meeting', date: m.date, m }));
  c.imports.slice().sort((a, b) => b.asOf.localeCompare(a.asOf)).forEach(i => rows.push({ kind: 'import', date: i.asOf, i }));
  if (!c.meetings.some(m => m.date === dates.next)) rows.push({ kind: 'planned', date: dates.next });
  rows.sort((a, b) => b.date.localeCompare(a.date) || (a.kind === 'import' ? 1 : -1));
  const list = compact ? rows.slice(0, 5) : rows;
  if (!list.length) return emptyState('Заседаний ещё не было', 'Загрузите реестр и начните первый техсовет.');
  return `<ul class="cs-meetings">${list.map(r => {
    if (r.kind === 'import') return `<li class="cs-sitting is-import"><span class="cs-md">${cdFmt(r.date)}</span><div><b>Реестр от ${cdFmtFull(r.date)}</b><small>${escapeHtml(r.i.fileName || 'файл')} · строк ${r.i.rowCount}, создано ${r.i.summary.created}, обновлено ${r.i.summary.updated}</small></div><span class="tag tag-muted">исходные обязательства</span></li>`;
    if (r.kind === 'planned') return `<li class="cs-sitting is-planned"><span class="cs-md">${cdFmt(r.date)}</span><div><b>Техсовет ${cdFmtFull(r.date)}</b><small>${csWhen(r.date, today)} · ещё не проводился</small></div><a class="btn btn-ghost btn-sm" href="${csHref('agenda')}">Повестка</a></li>`;
    const m = r.m;
    const res = m.result;
    return `<li class="cs-sitting is-${m.status}"><span class="cs-md">${cdFmt(m.date)}</span><div><b>Техсовет ${cdFmtFull(m.date)}</b><small>${m.status === 'closed' && res ? escapeHtml(res.summaryText || '') : m.status === 'live' ? 'Идёт сейчас' : 'Запланирован'}</small></div>${m.status === 'closed' ? `<a class="btn btn-ghost btn-sm" href="${csHref('history', m.date)}">Итоги</a>` : m.status === 'live' ? `<a class="btn btn-dark btn-sm" href="${csHref('meeting')}">Продолжить</a>` : `<a class="btn btn-ghost btn-sm" href="${csHref('agenda')}">Повестка</a>`}</li>`;
  }).join('')}</ul>`;
}

/* ---------- project names that were not recognized ---------- */

function csUnmappedProjects(orders) {
  const map = new Map();
  orders.filter(o => !o.projectId && o.projectRaw && councilIsOpen(o)).forEach(o => { const k = projectKey(o.projectRaw); (map.get(k) || map.set(k, { raw: o.projectRaw, ids: [] }).get(k)).ids.push(o.orderId); });
  return [...map.values()];
}

function csUnmappedBanner(list) {
  return `<div class="banner banner-amber cs-banner" role="note">${sevIcon('watch', 18)}<span><b>Названия проектов не распознаны: ${list.map(x => `«${escapeHtml(x.raw)}»`).join(', ')}.</b> Поручения показаны под своим названием и не попадают в карточки проектов, пока вы не сопоставите их.</span><button class="btn btn-dark btn-sm" type="button" data-action="cs-map-projects">Сопоставить</button></div>`;
}

/* ---------- registry ---------- */

function csFilterBar() {
  const { c, orders, today } = csNow();
  const f = c.ui.filter;
  const projects = councilGroups(orders).map(g => ({ key: g.projectId || g.key, name: g.name, n: g.orders.filter(councilIsOpen).length }));
  const owners = [...new Set(orders.flatMap(councilInvolvedNames))].sort((a, b) => a.localeCompare(b, 'ru'));
  const chip = (id, label) => `<button type="button" class="fchip ${f.state === id ? 'is-on' : ''}" data-action="cs-filter-state" data-state="${id}" aria-pressed="${f.state === id}">${label}${(() => { const n = councilFilter(orders, { ...f, state: id, q: f.q, today }).length; return `<span class="count">${n}</span>`; })()}</button>`;
  return `<div class="cs-filters"><label class="cs-search">${icon('search')}<input id="csSearch" type="search" value="${escapeAttr(f.q)}" placeholder="Поиск по поручениям, людям, решениям" autocomplete="off" aria-label="Поиск по реестру" /></label>
    <select class="cs-select" data-filter="project" aria-label="Проект"><option value="">Все проекты</option>${projects.map(p => `<option value="${escapeAttr(p.key)}" ${f.project === p.key ? 'selected' : ''}>${escapeHtml(p.name)} · ${p.n}</option>`).join('')}</select>
    <select class="cs-select" data-filter="owner" aria-label="Ответственный"><option value="">Все ответственные</option><option value="__none__" ${f.owner === '__none__' ? 'selected' : ''}>Без владельца</option>${owners.map(o => `<option value="${escapeAttr(o)}" ${f.owner === o ? 'selected' : ''}>${escapeHtml(displayName(o))}</option>`).join('')}</select>
    <div class="cs-chips" role="group" aria-label="Состояние">${chip('open', 'Открытые')}${chip('needsDecision', 'Требуют решения')}${chip('blocked', 'Заблокированы')}${chip('overdue', 'Просрочены')}${chip('noOwner', 'Без владельца')}${chip('done', 'Выполнены')}${chip('all', 'Все')}</div></div>`;
}

function csRegistryList() {
  const { c, orders, today } = csNow();
  const list = councilFilter(orders, { ...c.ui.filter, today });
  if (!list.length) return emptyState('Ничего не найдено', 'Смените фильтр или поиск. Закрытые и снятые поручения скрыты в фильтре «Открытые».');
  return councilGroups(list).map(g => {
    const open = g.orders.filter(councilIsOpen).length;
    const blocked = g.orders.filter(o => o.state === 'blocked' && councilIsOpen(o)).length;
    const overdue = g.orders.filter(o => councilIsOverdue(o, today)).length;
    const sorted = g.orders.slice().sort((a, b) => (councilIsOpen(b) - councilIsOpen(a)) || Number(a.no || 9999) - Number(b.no || 9999));
    return `<section class="cs-proj"><header><h2>${escapeHtml(g.name)}</h2><span class="muted">${g.orders.length} ${pluralRu(g.orders.length, 'поручение', 'поручения', 'поручений')}${open !== g.orders.length ? `, открыто ${open}` : ''}${blocked ? ` · заблокировано ${blocked}` : ''}${overdue ? ` · просрочено ${overdue}` : ''}</span></header>
      <div class="cs-rows">${sorted.map(o => csOrderRow(o, today)).join('')}</div></section>`;
  }).join('');
}

function csRegistry() {
  const { orders, c } = csNow();
  const unmapped = csUnmappedProjects(orders);
  return `<section class="view cs cs-registry">
    ${csHead('Реестр поручений', `Каждое поручение живёт под постоянным номером TS-…, даже если в Excel оно переедет на другую строку.`, `<button class="btn btn-ghost" type="button" data-action="cs-new-order">${icon('plus')}Добавить поручение</button><button class="btn btn-ghost" type="button" data-action="cs-export">${icon('download')}Выгрузить в Excel</button>`)}
    ${csTabs('registry')}
    ${unmapped.length ? csUnmappedBanner(unmapped) : ''}
    ${csFilterBar()}
    <div id="csList" class="cs-list">${csRegistryList()}</div>
  </section>`;
}

/* ---------- order card ---------- */

function csFact(label, value, extra = '') {
  return `<div class="cs-fact"><dt>${escapeHtml(label)}</dt><dd>${value || '<span class="muted">не указано</span>'}${extra}</dd></div>`;
}

function csBlocksHtml(order, orders) {
  const active = councilActiveBlocks(order);
  const resolved = (order.blocks || []).filter(b => !b.active && b.resolvedAt);
  const dependents = councilDependents(order.orderId, orders);
  const suggestions = councilSuggestDependencies(order, orders).filter(s => !state.council.settings.dismissedDeps[order.orderId + ':' + s.orderId]);
  const decider = order.owners?.decider || active.map(b => b.decider).filter(Boolean)[0] || '';
  const answers = `<div class="cs-answers">
    <div><small>Что мешает</small><b>${active.length ? escapeHtml(active.map(b => b.text || councilBlockKind(b.kind).label).join('; ')) : order.state === 'blocked' ? 'Причина не записана' : 'Ничего не мешает'}</b></div>
    <div><small>Кто должен решить</small><b>${decider ? escapeHtml(decider) : active.length ? '<span class="tone-amber">не указано</span>' : '—'}</b></div>
    <div><small>Что разблокируется</small><b>${dependents.length ? dependents.map(d => `<a href="${csHref('order', d.orderId)}">№${escapeHtml(d.no || '?')}</a>`).join(', ') : active.length ? 'зависимых поручений не отмечено' : '—'}</b></div></div>`;
  return `<section class="card cs-card"><header class="card-head"><h2>Блокеры и зависимости</h2><button class="btn btn-ghost btn-sm" type="button" data-action="cs-block-dialog" data-id="${escapeAttr(order.orderId)}">${icon('plus')}Добавить блокер</button></header>
    <div class="pad">${answers}
    ${active.length ? `<ul class="cs-blocks">${active.map(b => { const ref = b.kind === 'order' ? orders.find(o => o.orderId === b.ref) : null; return `<li><span class="tag tag-red">${escapeHtml(councilBlockKind(b.kind).label)}</span><span class="cs-block-text">${ref ? `<a href="${csHref('order', ref.orderId)}">№${escapeHtml(ref.no || '?')} «${escapeHtml(councilShort(ref.title, 80))}»</a> (${escapeHtml(councilState(ref.state).label.toLowerCase())})` : escapeHtml(b.text || 'без описания')}${b.decider ? `<small>Решает: ${escapeHtml(b.decider)}</small>` : ''}<small>${b.by === 'import' ? 'из реестра' : 'добавлено вручную'}${b.since ? ', с ' + cdFmt(b.since) : ''}</small></span><button class="btn btn-ghost btn-sm" type="button" data-action="cs-block-resolve" data-id="${escapeAttr(order.orderId)}" data-block="${escapeAttr(b.id)}">${icon('unlock')}Снять</button></li>`; }).join('')}</ul>` : '<p class="muted">Активных блокеров нет.</p>'}
    ${suggestions.length ? `<div class="cs-suggest"><b>Предположительно зависит от</b><small>Это догадка по тексту срока. В реестр она не записана, пока вы не подтвердите.</small>${suggestions.map(s => `<div class="cs-suggest-row"><span>№${escapeHtml(s.no || '?')} «${escapeHtml(councilShort(s.title, 90))}»<small>${escapeHtml(s.reason)}</small></span><button class="btn btn-ghost btn-sm" type="button" data-action="cs-dep-accept" data-id="${escapeAttr(order.orderId)}" data-ref="${escapeAttr(s.orderId)}">Подтвердить</button><button class="btn btn-quiet btn-sm" type="button" data-action="cs-dep-dismiss" data-id="${escapeAttr(order.orderId)}" data-ref="${escapeAttr(s.orderId)}">Не то</button></div>`).join('')}</div>` : ''}
    ${resolved.length ? `<details class="cs-resolved"><summary>Снятые блокеры: ${resolved.length}</summary><ul>${resolved.map(b => `<li>${escapeHtml(councilBlockKind(b.kind).label)}${b.text ? ': ' + escapeHtml(b.text) : ''} <small>снят ${escapeHtml(cdFmt(String(b.resolvedAt).slice(0, 10)))}${b.resolvedNote ? ', ' + escapeHtml(b.resolvedNote) : ''}</small></li>`).join('')}</ul></details>` : ''}</div></section>`;
}

function csTimelineHtml(order) {
  const { c } = csNow();
  const items = councilTimeline(order, c.meetings).reverse();
  if (!items.length) return '<p class="muted pad">История пока пуста.</p>';
  return `<ol class="cs-tl">${items.map(e => `<li class="cs-tl-${e.tone}"><i aria-hidden="true"></i><div><div class="cs-tl-top"><b>${escapeHtml(e.title)}</b><span class="muted">${escapeHtml(cdFmtFull(e.day))}${e.inferred ? ' · дата по оценке' : ''}${e.by ? ' · ' + escapeHtml({ import: 'реестр', meeting: 'техсовет', user: 'вручную' }[e.by] || e.by) : ''}</span></div>${e.text ? `<p>${escapeHtml(e.text)}</p>` : ''}</div></li>`).join('')}</ol>`;
}

function csFirstSeen(order) {
  const created = (order.events || []).find(e => e.type === 'created');
  return created ? `${cdFmtFull(created.asOf || String(created.at).slice(0, 10))}${created.by === 'import' ? ', из реестра' : ''}` : '';
}

function csMeetingsOf(order) {
  const { c } = csNow();
  const ids = new Set((order.events || []).filter(e => e.meetingId).map(e => e.meetingId));
  (c.meetings || []).forEach(m => { if ((m.result?.decisions || []).some(d => d.orderId === order.orderId) || (m.agenda || []).some(a => a.orderId === order.orderId)) ids.add(m.id); });
  return c.meetings.filter(m => ids.has(m.id) && m.status !== 'planned').map(m => m.date).sort();
}

function csOrderPage(sub) {
  const { c, today, orders } = csNow();
  const order = councilOrder(sub.arg);
  if (!order) return `<section class="view cs">${csHead('Поручение не найдено', 'Возможно, его ещё не успели загрузить с общего сервера.', `<a class="btn btn-ghost" href="${csHref('registry')}">К реестру</a>`)}${csTabs('registry')}${emptyState('Нет такого поручения', 'Откройте реестр и найдите его по названию.')}</section>`;
  const reasons = councilIsOpen(order) ? councilReasons(order, orders, today) : [];
  const list = councilFilter(orders, { ...c.ui.filter, today });
  const at = list.findIndex(o => o.orderId === order.orderId);
  const prev = at > 0 ? list[at - 1] : null, next = at >= 0 && at < list.length - 1 ? list[at + 1] : null;
  const meetings = csMeetingsOf(order);
  const open = councilIsOpen(order);
  const actions = open
    ? `<button class="btn btn-ghost" type="button" data-action="cs-edit-order" data-id="${escapeAttr(order.orderId)}">${icon('edit')}Изменить</button><button class="btn btn-dark" type="button" data-action="cs-done-dialog" data-id="${escapeAttr(order.orderId)}">${icon('check')}Подтвердить выполнение</button>`
    : `<button class="btn btn-ghost" type="button" data-action="cs-reopen" data-id="${escapeAttr(order.orderId)}">${icon('undo')}Вернуть в работу</button>`;
  const upd = (order.updates || []).slice().sort((a, b) => String(b.asOf).localeCompare(String(a.asOf)));
  return `<section class="view cs cs-order">
    <div class="cs-crumbs"><a href="${csHref('registry')}">${icon('back')}Реестр</a><span>/</span><span>${escapeHtml(councilGroupName(order))}</span><span class="cs-pager">${prev ? `<a href="${csHref('order', prev.orderId)}" aria-label="Предыдущее">${icon('up')}</a>` : ''}${next ? `<a href="${csHref('order', next.orderId)}" aria-label="Следующее">${icon('down')}</a>` : ''}</span></div>
    <header class="cs-order-head"><div class="cs-order-tags"><span class="cs-no cs-no-lg">${order.no ? '№' + escapeHtml(order.no) : 'Новое'}</span>${csProjectTag(order)}${csStateTag(order)}${order.critical ? '<span class="tag tag-red">критично</span>' : ''}${order.state === 'done' ? `<span class="tag tag-green">подтверждено ${escapeHtml(cdFmtFull(order.done?.day || ''))}</span>` : ''}<span class="tag tag-muted" title="Постоянный номер: не меняется при повторной загрузке реестра">${escapeHtml(order.orderId)}</span></div>
      <h1 class="cs-order-title">${escapeHtml(order.title)}</h1><div class="cs-actions">${actions}${open ? `<button class="btn btn-quiet" type="button" data-action="cs-cancel-dialog" data-id="${escapeAttr(order.orderId)}">Снять поручение</button>` : ''}</div></header>
    <div class="cs-order-grid">
      <div class="cs-order-main">
        ${reasons.length ? `<section class="card cs-card cs-attn"><header class="card-head"><h2>Почему это на повестке</h2></header><ul class="pad cs-reasons">${reasons.map(r => `<li><span class="cs-prio-dot p${r.priority}" aria-hidden="true">${r.priority}</span>${escapeHtml(r.text)}${r.soft ? ' <small class="muted">(оценка)</small>' : ''}</li>`).join('')}</ul></section>` : ''}
        ${csBlocksHtml(order, orders)}
        <section class="card cs-card"><header class="card-head"><h2>История поручения</h2><p class="muted">${csFirstSeen(order) ? `Впервые в реестре: ${escapeHtml(csFirstSeen(order))}. ` : ''}${meetings.length ? `Обсуждалось на советах: ${meetings.map(cdFmt).join(', ')}.` : 'На техсовете пока не обсуждалось.'}</p></header>${csTimelineHtml(order)}</section>
      </div>
      <aside class="cs-order-side">
        <section class="card cs-card"><header class="card-head"><h2>Поручение</h2></header><dl class="cs-facts pad">
          ${csFact('Ответственный', csOwnerHtml(order, { raw: true }), csSourceMark(order, 'owners'))}
          ${csFact('Срок', `${csDueHtml(order, today)}${order.due?.raw && order.due.raw !== councilDueLabel(order.due) ? `<small class="cs-orig">В реестре: «${escapeHtml(order.due.raw)}»</small>` : ''}<small class="cs-orig">${escapeHtml(COUNCIL_DUE_KINDS[order.due?.kind] || '')}${order.due?.inferred ? ', дата по оценке' : ''}</small>`, csSourceMark(order, 'due'))}
          ${csFact('Ожидаемый результат', escapeHtml(order.result), csSourceMark(order, 'result'))}
          ${csFact('Статус в реестре', escapeHtml(order.statusRaw))}
          ${csFact('Блокер / примечание из реестра', escapeHtml(order.blockerRaw), csSourceMark(order, 'blocker'))}
          ${csFact('Комментарий', escapeHtml(order.comment), csSourceMark(order, 'comment'))}
          ${csFact('Где в реестре', order.source?.row ? `строка ${order.source.row} файла от ${escapeHtml(cdFmtFull((state.council.imports.find(i => i.id === order.source.importId) || {}).asOf || ''))}` : '<span class="muted">добавлено вручную</span>')}
        </dl></section>
        ${upd.length ? `<section class="card cs-card"><header class="card-head"><h2>Статусы из реестра</h2><p class="muted">Текст как в файле</p></header><ul class="cs-updates pad">${upd.map(u => `<li><b>${escapeHtml(u.label)}</b><small>${escapeHtml(cdFmtFull(u.asOf))}${u.asOfInferred ? ', дата по оценке' : ''}</small><p>${escapeHtml(u.text)}</p></li>`).join('')}</ul></section>` : ''}
        <section class="card cs-card"><header class="card-head"><h2>Повестка</h2></header><div class="pad"><button class="btn btn-ghost" type="button" data-action="cs-agenda-add-order" data-id="${escapeAttr(order.orderId)}">${icon('plus')}Добавить в повестку ${escapeHtml(cdFmt(csAgendaDate()))}</button></div></section>
      </aside>
    </div></section>`;
}

/* ---------- history of councils ---------- */

function csHistory(sub) {
  const { c } = csNow();
  if (sub.arg) { const m = c.meetings.find(x => x.date === sub.arg); if (m) return csMeetingPage(m); }
  return `<section class="view cs cs-history">
    ${csHead('Заседания и версии реестра', 'Каждый техсовет сохраняется отдельно: вопросы, решения, кто и когда. Загруженные реестры лежат рядом как исходные обязательства.', `<button class="btn btn-ghost" type="button" data-action="cs-export">${icon('download')}Выгрузить реестр в Excel</button>`)}
    ${csTabs('history')}
    ${csMeetingList(false)}
    ${c.imports.length ? `<section class="cs-block"><header class="block-head"><h2>Загруженные реестры</h2><p class="muted">Каждая версия хранится целиком. Повторная загрузка того же файла ничего не меняет.</p></header><ul class="cs-imports">${c.imports.slice().reverse().map(i => `<li><span class="cs-md">${cdFmt(i.asOf)}</span><div><b>${escapeHtml(i.fileName || 'реестр')}</b><small>реестр от ${cdFmtFull(i.asOf)}, загружен ${escapeHtml(formatDateTime(i.importedAt))}${i.importedBy ? ', ' + escapeHtml(i.importedBy) : ''} · строк ${i.rowCount}, создано ${i.summary.created}, обновлено ${i.summary.updated}</small></div>${i.fileId ? `<button class="btn btn-ghost btn-sm" type="button" data-action="cs-file-download" data-id="${escapeAttr(i.fileId)}">${icon('download')}Файл</button>` : ''}</li>`).join('')}</ul></section>` : ''}
  </section>`;
}

function csDecisionRows(decisions) {
  const groups = new Map();
  decisions.forEach(d => (groups.get(d.group || 'Прочее') || groups.set(d.group || 'Прочее', []).get(d.group || 'Прочее')).push(d));
  return [...groups.entries()].map(([name, list]) => `<section class="cs-res-group"><h3>${escapeHtml(name)}</h3><ul>${list.map(d => `<li>${d.orderId ? `<a class="cs-res-t" href="${csHref('order', d.orderId)}">${d.no ? '№' + escapeHtml(d.no) + ' ' : ''}${escapeHtml(councilShort(d.title, 140))}</a>` : `<span class="cs-res-t">${escapeHtml(councilShort(d.title, 140))}</span>`}
    ${d.text ? `<p class="cs-res-decision"><span class="tag tag-blue">решение</span>${escapeHtml(d.text)}</p>` : ''}
    ${(d.changes || []).filter(ch => ch.field !== 'done').map(ch => `<p class="cs-res-change"><b>${escapeHtml(ch.label)}:</b> ${escapeHtml(councilShort(ch.from, 80))} → ${escapeHtml(councilShort(ch.to, 80))}</p>`).join('')}
    ${d.done ? `<p class="cs-res-done"><span class="tag tag-green">выполнение подтверждено</span>${escapeHtml(d.doneNote || 'без пояснения')}</p>` : ''}</li>`).join('')}</ul></section>`).join('');
}

function csMeetingPage(m) {
  const res = m.result;
  const files = m.protocol?.files || [];
  return `<section class="view cs cs-meeting-page">
    <div class="cs-crumbs"><a href="${csHref('history')}">${icon('back')}Заседания</a><span>/</span><span>${escapeHtml(cdFmtFull(m.date))}</span></div>
    ${csHead(`Техсовет ${escapeHtml(cdFmtFull(m.date))}`, res ? escapeHtml(res.summaryText) : 'Заседание ещё не завершено.', m.status === 'closed' ? '' : `<a class="btn btn-dark" href="${csHref('meeting')}">${icon('play')}${m.status === 'live' ? 'Продолжить' : 'К повестке'}</a>`)}
    ${csTabs('history')}
    ${res ? `<div class="cs-order-grid"><div class="cs-order-main"><section class="card cs-card"><header class="card-head"><h2>Решения и договорённости</h2><p class="muted">Принятые на совете. Черновики и непринятое показаны отдельно.</p></header><div class="pad">${(res.decisions || []).length ? csDecisionRows(res.decisions) : '<p class="muted">Решений записано не было.</p>'}</div></section>
      ${(res.newOrders || []).length ? `<section class="card cs-card"><header class="card-head"><h2>Новые поручения</h2></header><ul class="pad cs-newlist">${res.newOrders.map(n => `<li><a href="${csHref('order', n.orderId)}">${escapeHtml(n.title)}</a><small>${escapeHtml(n.project || 'без проекта')} · ${escapeHtml(n.owner || 'ответственный не назначен')} · ${escapeHtml(n.due || 'срок не задан')}</small></li>`).join('')}</ul></section>` : ''}
      ${(res.drafts || []).length ? `<section class="card cs-card"><header class="card-head"><h2>Черновики без принятого решения</h2><p class="muted">К поручениям не применены</p></header><ul class="pad cs-newlist">${res.drafts.map(d => `<li>${escapeHtml(councilShort(d.title, 120))}<small>${escapeHtml(d.text || 'без текста')}</small></li>`).join('')}</ul></section>` : ''}
      ${(res.untouched || []).length ? `<section class="card cs-card"><header class="card-head"><h2>Не рассмотрено</h2><p class="muted">Остаются открытыми и придут на следующий совет</p></header><ul class="pad cs-newlist">${res.untouched.map(u => `<li>${u.orderId ? `<a href="${csHref('order', u.orderId)}">${escapeHtml(councilShort(u.title, 120))}</a>` : escapeHtml(councilShort(u.title, 120))}</li>`).join('')}</ul></section>` : ''}
      </div>
      <aside class="cs-order-side">${csProtocolCard(m, files)}</aside></div>` : csProtocolCard(m, files)}
  </section>`;
}

function csProtocolCard(m, files) {
  const text = m.protocol?.text || '';
  const sug = typeof councilProtocolSuggestions === 'function' ? councilProtocolSuggestions(text) : [];
  return `<section class="card cs-card cs-protocol"><header class="card-head"><div><h2>Протокол</h2><p class="muted">${m.protocol?.final ? 'Утверждён' : 'Черновик'}${m.protocol?.updatedAt ? ' · изменён ' + escapeHtml(formatDateTime(m.protocol.updatedAt)) : ''}</p></div></header>
    <div class="pad"><textarea id="csProtocolText" class="cs-textarea" rows="12" data-date="${escapeAttr(m.date)}" placeholder="Текст протокола. Можно составить из принятых решений или вставить свой." aria-label="Текст протокола">${escapeHtml(text)}</textarea>
      <div class="cs-row-actions"><button class="btn btn-dark btn-sm" type="button" data-action="cs-protocol-save" data-date="${escapeAttr(m.date)}">Сохранить</button>${m.result ? `<button class="btn btn-ghost btn-sm" type="button" data-action="cs-protocol-draft" data-date="${escapeAttr(m.date)}">Составить из решений</button>` : ''}<button class="btn btn-ghost btn-sm" type="button" data-action="cs-protocol-final" data-date="${escapeAttr(m.date)}">${m.protocol?.final ? 'Вернуть в черновик' : 'Отметить утверждённым'}</button></div>
      <h3 class="cs-sub">Файлы протокола</h3>
      ${files.length ? `<ul class="cs-files">${files.map(f => `<li>${icon('file')}<span><b>${escapeHtml(f.name)}</b><small>${escapeHtml(Math.max(1, Math.round(f.size / 1024)) + ' КБ')} · ${escapeHtml(formatDateTime(f.addedAt))}</small></span><button class="btn btn-ghost btn-sm" type="button" data-action="cs-file-download" data-id="${escapeAttr(f.id)}">${icon('download')}</button><button class="btn btn-quiet btn-sm" type="button" data-action="cs-file-remove" data-date="${escapeAttr(m.date)}" data-id="${escapeAttr(f.id)}" aria-label="Убрать файл">${icon('close')}</button></li>`).join('')}</ul>` : '<p class="muted">Файлов нет.</p>'}
      <label class="btn btn-ghost btn-sm cs-attach" for="councilAttachInput" data-date="${escapeAttr(m.date)}">${icon('upload')}Прикрепить файл</label>
      ${sug.length ? `<h3 class="cs-sub">Предложения из текста</h3><p class="muted cs-fine">Найдены строки, похожие на поручения. Ничего не создаётся, пока вы не подтвердите.</p><ul class="cs-sug">${sug.map((s, i) => `<li><span>${escapeHtml(s.title)}<small>${escapeHtml(s.owner || 'ответственный не найден')} · ${escapeHtml(s.due || 'срок не найден')}</small></span><button class="btn btn-ghost btn-sm" type="button" data-action="cs-sug-create" data-i="${i}" data-date="${escapeAttr(m.date)}">Создать поручение</button></li>`).join('')}</ul>` : ''}
    </div></section>`;
}

/* ---------- import ---------- */

function csImport() {
  const { c } = csNow();
  const p = c.ui.pending;
  return `<section class="view cs cs-import">
    ${csHead('Загрузка реестра', 'Выберите файл .xlsx. Пока вы не нажмёте «Применить», ничего не меняется: сначала показываем, что в файле нового и изменённого.', `<label class="btn btn-dark" for="councilFileInput">${icon('upload')}Выбрать файл .xlsx</label>`)}
    ${csTabs('import')}
    ${p ? csImportPreview(p) : `<div class="cs-drop card"><div>${icon('upload')}<h3>Перетащите реестр сюда или выберите файл</h3><p class="muted">Подойдёт тот же файл, в котором вы ведёте поручения: заголовки колонок распознаются сами. Одинаковый файл повторно загрузить безопасно.</p></div>${c.imports.length ? `<p class="muted cs-fine">Последняя загрузка: реестр от ${escapeHtml(cdFmtFull(c.imports.at(-1).asOf))}, ${escapeHtml(c.imports.at(-1).fileName || '')}.</p>` : ''}</div>`}
  </section>`;
}

function csImportPreview(p) {
  const { plan, parsed } = p;
  const s = plan.summary;
  const roles = { no: '№', project: 'Проект', title: 'Задача', owner: 'Ответственный', result: 'Результат', due: 'Срок', status: 'Статус', blocker: 'Блокер', update: 'Статус на дату', id: 'ID' };
  const cols = parsed.columns.map(col => `<li><span class="tag ${col.role === 'extra' ? 'tag-muted' : 'tag-blue'}">${escapeHtml(roles[col.role] || (col.role === 'extra' ? 'как есть' : col.role))}</span> ${escapeHtml(col.header || '(без названия)')}</li>`).join('');
  const needMap = [...new Map(plan.items.filter(i => i.project && !i.project.projectId && i.row.project).map(i => [projectKey(i.row.project), i.row.project])).values()];
  const chips = [['new', 'Новых', s.new, ''], ['changed', 'Изменено', s.changed, ''], ['same', 'Без изменений', s.same, 'muted'], ['ambiguous', 'Нужно решить вам', s.ambiguous, s.ambiguous ? 'amber' : 'muted'], ['missing', 'Нет в файле', s.missing, 'muted']];
  const itemsHtml = plan.items.filter(i => i.verdict !== 'match' || !i.same).map(i => csImportItem(i, p)).join('');
  return `<div class="cs-preview">
    <section class="card cs-card"><header class="card-head"><div><h2>${escapeHtml(p.file.name)}</h2><p class="muted">Лист «${escapeHtml(p.sheetName)}» · строк ${parsed.rows.length} · ${(p.file.size / 1024).toFixed(0)} КБ</p></div>
      <label class="cs-asof">Реестр на дату<input type="date" id="csAsOf" value="${escapeAttr(p.asOf)}" /><small class="muted">${escapeHtml(parsed.asOfGuess?.source === 'file' ? 'найдена в файле' : parsed.asOfGuess?.source === 'name' ? 'из названия файла' : 'проверьте дату')}</small></label></header>
      <div class="pad"><div class="cs-sumrow">${chips.map(([id, label, n, tone]) => `<div class="cs-sum ${tone ? 'is-' + tone : ''}"><b>${n}</b><span>${label}</span></div>`).join('')}</div>
      ${s.nothingToDo ? `<p class="cs-ok">${sevIcon('ok', 16)}В файле нет ничего нового или изменённого. Применять нечего.</p>` : ''}
      ${s.missing ? `<p class="muted cs-fine">${s.missing} ${pluralRu(s.missing, 'поручение', 'поручения', 'поручений')} из Coordination нет в этом файле. Это не значит, что они выполнены: они остаются открытыми.</p>` : ''}
      ${parsed.warnings?.length ? `<ul class="cs-warn">${parsed.warnings.map(w => `<li>${sevIcon('watch', 14)}${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      <details class="cs-cols"><summary>Как распознаны колонки (${parsed.columns.length})</summary><ul>${cols}</ul></details></div></section>
    ${needMap.length ? `<section class="card cs-card"><header class="card-head"><h2>Названия проектов</h2><p class="muted">Эти названия не удалось определить. Выберите проект или оставьте как есть: поручения останутся под своим названием.</p></header><div class="pad cs-map">${needMap.map(raw => csMapRow(raw, p.projectMap[projectKey(raw)] || '')).join('')}</div></section>` : ''}
    ${itemsHtml ? `<section class="card cs-card"><header class="card-head"><h2>Что изменится</h2><p class="muted">Показаны только строки с изменениями. Пустые ячейки в файле ничего не стирают.</p></header><ul class="cs-items">${itemsHtml}</ul></section>` : ''}
    <div class="cs-applybar"><div><b>${s.nothingToDo ? 'Изменений нет' : `Будет создано: ${s.new}, обновлено: ${s.changed + (plan.items.filter(i => i.verdict === 'ambiguous' && p.decisions.matches[i.rowIndex] !== 'new').length)}`}</b><span class="muted">${s.ambiguous ? 'Сначала решите спорные строки.' : 'Каждое изменение запишется в историю поручения.'}</span></div>
      <button class="btn btn-ghost" type="button" data-action="cs-import-cancel">Отмена</button>
      <button class="btn btn-dark" type="button" data-action="cs-import-apply" ${s.nothingToDo ? 'disabled' : ''}>${icon('check')}Применить</button></div>
  </div>`;
}

function csMapRow(raw, selected) {
  return `<label class="cs-map-row"><span>«${escapeHtml(raw)}»</span><select class="cs-select" data-map="${escapeAttr(projectKey(raw))}" data-raw="${escapeAttr(raw)}"><option value="">Оставить как есть</option>${ITO_PROJECTS.map(pr => `<option value="${escapeAttr(pr.id)}" ${selected === pr.id ? 'selected' : ''}>${escapeHtml(pr.name)}</option>`).join('')}</select></label>`;
}

function csImportItem(i, p) {
  const label = i.verdict === 'new' ? '<span class="tag tag-green">новое</span>' : i.verdict === 'ambiguous' ? '<span class="tag tag-amber">спорное</span>' : '<span class="tag tag-blue">изменено</span>';
  const head = `<div class="cs-item-head">${label}<b>${i.row.no ? '№' + escapeHtml(i.row.no) + ' ' : ''}${escapeHtml(councilShort(i.row.title, 150))}</b><small class="muted">${escapeHtml(i.row.project || 'без проекта')}</small></div>`;
  if (i.verdict === 'new') return `<li>${head}<small class="muted">Получит постоянный номер ${escapeHtml(i.proposedId)}. ${i.owners?.state !== 'assigned' ? 'Ответственный не определён однозначно, это будет в повестке.' : ''}</small></li>`;
  if (i.verdict === 'ambiguous') {
    const choice = p.decisions.matches[i.rowIndex] || 'new';
    return `<li class="is-ask">${head}<p class="cs-ask">Формулировка изменилась. Это то же поручение?</p><div class="cs-choices" role="radiogroup">
      ${i.candidates.map(cn => `<label class="cs-choice"><input type="radio" name="m${i.rowIndex}" value="${escapeAttr(cn.orderId)}" data-match="${i.rowIndex}" ${choice === cn.orderId ? 'checked' : ''}><span>Да, это №${escapeHtml(cn.no || '?')} «${escapeHtml(councilShort(cn.title, 100))}» <small class="muted">похоже на ${Math.round(cn.score * 100)}%</small></span></label>`).join('')}
      <label class="cs-choice"><input type="radio" name="m${i.rowIndex}" value="new" data-match="${i.rowIndex}" ${choice === 'new' ? 'checked' : ''}><span>Нет, это новое поручение</span></label></div></li>`;
  }
  const rows = i.changes.filter(ch => ch.mode !== 'ignore-empty' && ch.mode !== 'same').map(ch => {
    const pick = p.decisions.conflicts[`${i.rowIndex}:${ch.field}`] || 'keep';
    const text = `<span class="cs-diff"><s>${escapeHtml(councilShort(ch.from, 120) || '—')}</s><i>→</i><b>${escapeHtml(councilShort(ch.to, 120))}</b></span>`;
    if (ch.mode === 'conflict') return `<div class="cs-change is-conflict"><span class="cs-change-l">${escapeHtml(ch.label)}</span>${text}<span class="cs-conf">Это поле меняли вручную. <label><input type="radio" name="c${i.rowIndex}${ch.field}" value="keep" data-conflict="${i.rowIndex}:${ch.field}" ${pick === 'keep' ? 'checked' : ''}> Оставить моё</label> <label><input type="radio" name="c${i.rowIndex}${ch.field}" value="file" data-conflict="${i.rowIndex}:${ch.field}" ${pick === 'file' ? 'checked' : ''}> Взять из файла</label></span></div>`;
    if (ch.mode === 'note') return `<div class="cs-change"><span class="cs-change-l">${escapeHtml(ch.label)}</span>${text}<small class="muted">Поручение подтверждено как выполненное: изменение только в историю</small></div>`;
    return `<div class="cs-change"><span class="cs-change-l">${escapeHtml(ch.label)}</span>${text}</div>`;
  }).join('');
  return `<li>${head}${rows}${i.newUpdates ? `<small class="muted">Новых статусов по датам: ${i.newUpdates}</small>` : ''}</li>`;
}

/* ---------- dialogs ---------- */

function csOwnerOptions(selected) {
  const names = [...ITO_ROSTER];
  return `<option value="">Не назначен</option>${names.map(n => `<option value="${escapeAttr(n)}" ${selected === n ? 'selected' : ''}>${escapeHtml(displayName(n))}</option>`).join('')}`;
}

function csProjectOptions(order) {
  const raw = order?.projectRaw || '';
  const sel = order?.projectId || '';
  const custom = raw && !sel ? `<option value="__raw__" selected>${escapeHtml(raw)} (как в реестре)</option>` : '';
  return `<option value="">Без проекта</option>${custom}${ITO_PROJECTS.map(p => `<option value="${escapeAttr(p.id)}" ${sel === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}`;
}

function csOrderForm(order) {
  const isNew = !order;
  const o = order || { title: '', result: '', blockerRaw: '', comment: '', owners: { raw: '' }, due: { raw: '', date: '', kind: 'none' }, critical: false, state: 'open' };
  const ownerName = councilHasOwner(o) && councilOwnerNames(o)[0] && ITO_ROSTER.includes(councilOwnerNames(o)[0]) && o.owners.raw === councilOwnerNames(o)[0] ? councilOwnerNames(o)[0] : '';
  return `<form id="csOrderForm" class="cs-form" data-id="${escapeAttr(order?.orderId || '')}" novalidate>
    <div class="modal-head"><div><div class="eyebrow">${isNew ? 'Новое поручение' : escapeHtml(order.orderId)}</div><h2>${isNew ? 'Добавить поручение' : 'Изменить поручение'}</h2><p class="muted">${isNew ? 'Оно сразу получит постоянный номер и попадёт в реестр.' : 'Каждая правка попадёт в историю поручения. Повторная загрузка реестра не затрёт изменённое вами без вашего решения.'}</p></div><button class="icon-btn" type="button" data-action="cs-dialog-close" aria-label="Закрыть">${icon('close')}</button></div>
    <label class="cs-field"><span>Формулировка поручения</span><textarea name="title" rows="3" required>${escapeHtml(o.title)}</textarea></label>
    <div class="cs-two"><label class="cs-field"><span>Проект</span><select name="project" class="cs-select">${csProjectOptions(order)}</select></label>
      <label class="cs-field"><span>Ответственный</span><select name="ownerName" class="cs-select">${csOwnerOptions(ownerName)}</select></label></div>
    <label class="cs-field"><span>Ответственный, если нужно иначе</span><input name="ownerText" type="text" value="${escapeAttr(ownerName ? '' : o.owners.raw)}" placeholder="Например: подрядчик + Павел Сергеев" autocomplete="off" /></label>
    <div class="cs-two"><label class="cs-field"><span>Срок (дата)</span><input name="dueDate" type="date" value="${escapeAttr(o.due?.kind === 'exact' ? o.due.date || '' : '')}" /></label>
      <label class="cs-field"><span>Срок текстом</span><input name="dueText" type="text" value="${escapeAttr(o.due?.kind === 'exact' ? '' : o.due?.raw || '')}" placeholder="Контрольная точка, условие…" autocomplete="off" /></label></div>
    <label class="cs-field"><span>Ожидаемый результат</span><textarea name="result" rows="2">${escapeHtml(o.result)}</textarea></label>
    <label class="cs-field"><span>Блокер или примечание</span><textarea name="blockerRaw" rows="2">${escapeHtml(o.blockerRaw)}</textarea></label>
    <label class="cs-field"><span>Комментарий</span><textarea name="comment" rows="2">${escapeHtml(o.comment)}</textarea></label>
    <label class="cs-check"><input name="critical" type="checkbox" ${o.critical ? 'checked' : ''}> Критично</label>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Отмена</button><button class="btn btn-dark" type="submit">${isNew ? 'Добавить' : 'Сохранить'}</button></div></form>`;
}

function csConflictForm(conflicts, current) {
  return `<form id="csConflictForm" class="cs-form" data-id="${escapeAttr(current.orderId)}"><div class="modal-head"><div><div class="eyebrow">Одновременная правка</div><h2>Поручение уже изменили</h2><p class="muted">Пока вы редактировали, кто-то сохранил другие значения тех же полей. Выберите, что оставить. Остальное сохранится как есть.</p></div></div>
    ${conflicts.map(cf => `<fieldset class="cs-conflict"><legend>${escapeHtml(cf.label)}</legend><label class="cs-choice"><input type="radio" name="r_${escapeAttr(cf.key)}" value="theirs" checked><span><b>Оставить чужое</b><small>${escapeHtml(cf.theirs || 'пусто')}</small></span></label><label class="cs-choice"><input type="radio" name="r_${escapeAttr(cf.key)}" value="mine"><span><b>Оставить моё</b><small>${escapeHtml(cf.mine || 'пусто')}</small></span></label></fieldset>`).join('')}
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Отмена</button><button class="btn btn-dark" type="submit">Сохранить выбор</button></div></form>`;
}

function csDoneForm(order) {
  return `<form id="csDoneForm" class="cs-form" data-id="${escapeAttr(order.orderId)}"><div class="modal-head"><div><div class="eyebrow">Подтверждение выполнения</div><h2>Поручение выполнено?</h2><p class="muted">№${escapeHtml(order.no || '?')} «${escapeHtml(councilShort(order.title, 140))}». Статус в файле сам по себе выполнением не считается: его отмечает человек.</p></div><button class="icon-btn" type="button" data-action="cs-dialog-close" aria-label="Закрыть">${icon('close')}</button></div>
    <label class="cs-field"><span>Чем подтверждено</span><textarea name="note" rows="3" placeholder="Например: акт подписан, оборудование запущено, проверил Павел" required></textarea></label>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Ещё нет</button><button class="btn btn-dark" type="submit">${icon('check')}Подтверждаю</button></div></form>`;
}

function csCancelForm(order) {
  return `<form id="csCancelForm" class="cs-form" data-id="${escapeAttr(order.orderId)}"><div class="modal-head"><div><div class="eyebrow">Снять поручение</div><h2>Поручение больше не нужно?</h2><p class="muted">№${escapeHtml(order.no || '?')} «${escapeHtml(councilShort(order.title, 140))}». Оно останется в истории, но уйдёт из открытых. Вернуть можно в любой момент.</p></div></div>
    <label class="cs-field"><span>Почему снимаем</span><textarea name="reason" rows="3" required></textarea></label>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Отмена</button><button class="btn btn-dark" type="submit">Снять</button></div></form>`;
}

function csBlockForm(order, orders) {
  const others = orders.filter(o => o.orderId !== order.orderId && councilIsOpen(o));
  return `<form id="csBlockForm" class="cs-form" data-id="${escapeAttr(order.orderId)}"><div class="modal-head"><div><div class="eyebrow">Блокер</div><h2>Что мешает этому поручению?</h2><p class="muted">№${escapeHtml(order.no || '?')} «${escapeHtml(councilShort(order.title, 120))}»</p></div><button class="icon-btn" type="button" data-action="cs-dialog-close" aria-label="Закрыть">${icon('close')}</button></div>
    <label class="cs-field"><span>Тип</span><select name="kind" class="cs-select">${COUNCIL_BLOCK_KINDS.map(k => `<option value="${k.id}">${escapeHtml(k.label)}</option>`).join('')}</select></label>
    <label class="cs-field" data-for="order"><span>Зависит от поручения</span><select name="ref" class="cs-select"><option value="">Выберите поручение</option>${others.map(o => `<option value="${escapeAttr(o.orderId)}">${o.no ? '№' + escapeHtml(o.no) + ' ' : ''}${escapeHtml(councilShort(o.title, 90))}</option>`).join('')}</select></label>
    <label class="cs-field"><span>Что именно мешает</span><textarea name="text" rows="2" placeholder="Например: ждём решения заказчика по оборудованию"></textarea></label>
    <label class="cs-field"><span>Кто должен решить</span><input name="decider" type="text" autocomplete="off" placeholder="Имя или организация" /></label>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Отмена</button><button class="btn btn-dark" type="submit">Добавить блокер</button></div></form>`;
}

function csResolveForm(order, blockId) {
  const b = (order.blocks || []).find(x => x.id === blockId);
  return `<form id="csResolveForm" class="cs-form" data-id="${escapeAttr(order.orderId)}" data-block="${escapeAttr(blockId)}"><div class="modal-head"><div><div class="eyebrow">Снять блокер</div><h2>Блокер больше не мешает?</h2><p class="muted">${escapeHtml(b ? (b.text || councilBlockKind(b.kind).label) : '')}</p></div></div>
    <label class="cs-field"><span>Что изменилось</span><textarea name="note" rows="2" placeholder="Например: заказчик согласовал спецификацию"></textarea></label>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Отмена</button><button class="btn btn-dark" type="submit">Снять блокер</button></div></form>`;
}

function csMapDialog(list) {
  return `<form id="csMapForm" class="cs-form"><div class="modal-head"><div><div class="eyebrow">Проекты</div><h2>Сопоставить названия</h2><p class="muted">Выбранное сопоставление запомнится и применится к этим поручениям и к будущим загрузкам.</p></div><button class="icon-btn" type="button" data-action="cs-dialog-close" aria-label="Закрыть">${icon('close')}</button></div>
    <div class="cs-map">${list.map(x => csMapRow(x.raw, '')).join('')}</div><div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Позже</button><button class="btn btn-dark" type="submit">Применить</button></div></form>`;
}

function csManualQuestionForm(date) {
  return `<form id="csManualForm" class="cs-form" data-date="${escapeAttr(date)}"><div class="modal-head"><div><div class="eyebrow">Повестка ${escapeHtml(cdFmt(date))}</div><h2>Добавить вопрос вручную</h2></div><button class="icon-btn" type="button" data-action="cs-dialog-close" aria-label="Закрыть">${icon('close')}</button></div>
    <label class="cs-field"><span>Вопрос</span><textarea name="title" rows="2" required placeholder="Что нужно обсудить"></textarea></label>
    <div class="cs-two"><label class="cs-field"><span>Проект</span><input name="group" type="text" list="csGroups" autocomplete="off" placeholder="Например: ЦСН" /></label>
    <label class="cs-field"><span>Связанное поручение</span><select name="orderId" class="cs-select"><option value="">Без привязки</option>${state.council.orders.filter(councilIsOpen).map(o => `<option value="${escapeAttr(o.orderId)}">${o.no ? '№' + escapeHtml(o.no) + ' ' : ''}${escapeHtml(councilShort(o.title, 70))}</option>`).join('')}</select></label></div>
    <label class="cs-field"><span>Что нужно решить</span><textarea name="note" rows="2"></textarea></label>
    <datalist id="csGroups">${ITO_PROJECTS.map(p => `<option value="${escapeAttr(p.name)}"></option>`).join('')}</datalist>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Отмена</button><button class="btn btn-dark" type="submit">Добавить</button></div></form>`;
}

/* ---------- compact block for the project card ---------- */

/** Assignments of the tech council for one project. A separate registry: nothing is merged with Bitrix tasks. */
function councilProjectCardHtml(projectId) {
  const c = state.council;
  if (!c || !c.loaded || !c.orders.length) return '';
  const today = cdLocalToday();
  const info = councilProjectBlock(c.orders, projectId, today);
  if (!info) return '';
  const dates = councilMeetingDates(c.meetings, c.imports, today);
  const agenda = councilBuildAgenda(c.orders, dates.next, (councilMeetingByDate(dates.next) || {}).agendaMeta || {});
  const group = agenda.groups.find(g => g.projectId === projectId);
  const urgent = c.orders.filter(o => o.projectId === projectId && councilIsOpen(o)).sort((a, b) => (councilNeedsDecision(b) - councilNeedsDecision(a)) || (Number(b.state === 'blocked') - Number(a.state === 'blocked')) || Number(a.no || 9999) - Number(b.no || 9999)).slice(0, 3);
  const stat = (label, value, tone = '') => `<div class="stat ${tone ? 'tone-' + tone : ''}"><small>${label}</small><b>${value}</b></div>`;
  return `<section class="card cs-projblock" aria-label="Поручения техсовета"><header class="card-head"><div><h2>Поручения техсовета</h2><p class="muted">Отдельный реестр: с задачами Bitrix не смешивается</p></div><button class="more-link" type="button" data-action="cs-project-open" data-project="${escapeAttr(projectId)}">Все поручения${icon('arrow')}</button></header>
    <div class="stats cs-projstats">${stat('Открыто', info.open)}${stat('Требуют решения', info.needsDecision, info.needsDecision ? 'red' : '')}${stat('Заблокировано', info.blocked, info.blocked ? 'red' : '')}${stat('Ближайшая дата', info.nearest ? `<span class="stat-text">${escapeHtml(cdFmt(info.nearest))}</span>` : '<span class="stat-text">нет</span>')}</div>
    <ul class="cs-projlist">${urgent.map(o => `<li><a href="${csHref('order', o.orderId)}"><span class="cs-no">${o.no ? '№' + escapeHtml(o.no) : '+'}</span><span>${escapeHtml(councilShort(o.title, 120))}</span>${csStateTag(o)}</a></li>`).join('')}</ul>
    <p class="cs-fine pad">${group ? `В повестке ${escapeHtml(cdFmt(dates.next))}: <a href="${csHref('agenda')}">${group.items.length} ${pluralRu(group.items.length, 'вопрос', 'вопроса', 'вопросов')}</a>.` : 'В ближайшую повестку вопросов по проекту нет.'}</p></section>`;
}
