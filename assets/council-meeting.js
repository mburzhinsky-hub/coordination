'use strict';
/*
 * Tech council views, part 2: the agenda and the meeting mode.
 * Meeting mode is a full-screen layer (like the office screen): the list of questions on the left, the current question big in the middle,
 * the decision form on the right. Three things stay visibly apart: a draft, an accepted decision, a confirmed completion.
 */

/* ---------- agenda ---------- */

const CS_PRIORITY_HELP = [
  'Заблокировано и нужно решение: без ответа техсовета работа стоит',
  'Просрочена контрольная точка или срок',
  'Нет однозначно назначенного владельца',
  'Нет подтверждённого движения',
  'Срок или контрольная точка приближаются',
  'Прошлое решение есть, результата не видно'
];

function csAgendaDate() {
  const { c, dates, live } = csNow();
  return live ? live.date : (c.ui.agendaDate && cdValid(c.ui.agendaDate) ? c.ui.agendaDate : dates.next);
}

function csAgendaItemHtml(item, i, count, editable) {
  const gaps = item.gaps || [];
  const fact = f => `<li class="${f.kind === 'guess' ? 'is-guess' : ''}"><b>${escapeHtml(f.label)}</b>${f.kind === 'guess' ? '<span class="tag tag-amber">предположительно</span>' : ''}<span>${escapeHtml(f.text)}</span></li>`;
  const manual = item.kind === 'manual';
  const tools = editable ? `<div class="cs-ai-tools"><button class="icon-btn" type="button" data-action="cs-agenda-move" data-id="${escapeAttr(item.id)}" data-delta="-1" ${i === 0 ? 'disabled' : ''} aria-label="Выше">${icon('up')}</button><button class="icon-btn" type="button" data-action="cs-agenda-move" data-id="${escapeAttr(item.id)}" data-delta="1" ${i === count - 1 ? 'disabled' : ''} aria-label="Ниже">${icon('down')}</button>${manual ? `<button class="btn btn-quiet btn-sm" type="button" data-action="cs-agenda-unmanual" data-id="${escapeAttr(item.id)}">Убрать</button>` : `<button class="btn btn-quiet btn-sm" type="button" data-action="cs-agenda-exclude" data-id="${escapeAttr(item.orderId)}">Не выносить</button>`}</div>` : '';
  return `<article class="cs-ai card p${item.priority}" id="ai-${escapeAttr(item.id)}">
    <header><span class="cs-prio-dot p${item.priority}" aria-hidden="true">${item.priority || '+'}</span><span class="cs-kicker">${escapeHtml(item.kicker)}</span>${tools}</header>
    <h3><span class="cs-ai-group">${escapeHtml(item.group.name)}</span> — ${escapeHtml(item.headline)}</h3>
    <dl class="cs-q">
      <div><dt>Причина</dt><dd>${item.reason ? escapeHtml(item.reason) : '<span class="muted">в реестре не указана</span>'}</dd></div>
      <div><dt>Последствие</dt><dd>${item.impact ? escapeHtml(item.impact) : '<span class="muted">в реестре не описано</span>'}</dd></div>
      <div class="is-main"><dt>Вопрос техсовету</dt><dd>${escapeHtml(item.question || 'Что нужно решить?')}</dd></div>
      <div><dt>Предлагаемое действие</dt><dd>${item.action ? escapeHtml(item.action) : '<span class="muted">не сформулировано</span>'}</dd></div>
    </dl>
    ${gaps.length ? `<p class="cs-gaps">${sevIcon('watch', 14)}<span>Не хватает данных: ${gaps.map(escapeHtml).join('; ')}.</span></p>` : ''}
    ${item.reasons?.length ? `<ul class="cs-why">${item.reasons.map(r => `<li><span class="cs-prio-dot p${r.priority}" aria-hidden="true">${r.priority}</span>${escapeHtml(r.text)}</li>`).join('')}</ul>` : ''}
    ${item.facts?.length ? `<details class="cs-facts-more"><summary>Что известно из реестра</summary><ul>${item.facts.map(fact).join('')}</ul></details>` : ''}
    <footer>${item.orderId ? `<a class="more-link" href="${csHref('order', item.orderId)}">Карточка поручения${icon('arrow')}</a>` : '<span class="muted">Вопрос добавлен вручную</span>'}${item.note ? `<span class="muted">${escapeHtml(item.note)}</span>` : ''}</footer>
  </article>`;
}

function csAgenda() {
  const { c, today, orders, dates, live } = csNow();
  const date = csAgendaDate();
  const meeting = councilMeetingByDate(date);
  const meta = meeting?.agendaMeta || { excluded: {}, order: [], manual: [] };
  const agenda = councilBuildAgenda(orders, date, meta);
  const closed = meeting?.status === 'closed';
  const running = meeting?.status === 'live';
  const editable = !closed && !running;
  const start = running ? `<a class="btn btn-dark" href="${csHref('meeting')}">${icon('play')}Продолжить техсовет</a>` : closed ? `<a class="btn btn-dark" href="${csHref('history', date)}">${icon('file')}Итоги</a>` : `<button class="btn btn-dark" type="button" data-action="cs-start-meeting" data-date="${escapeAttr(date)}" ${agenda.total ? '' : 'disabled'}>${icon('play')}Начать техсовет</button>`;
  const picker = `<label class="cs-asof">Дата техсовета<input type="date" id="csAgendaDate" value="${escapeAttr(date)}" ${live && live.date !== date ? '' : ''} ${running ? 'disabled' : ''}/><small class="muted">${csWhen(date, today)}</small></label>`;
  let index = 0;
  const groupsHtml = agenda.groups.map(g => `<section class="cs-ag"><header><h2>${escapeHtml(g.name)}</h2><span class="muted">${g.items.length} ${pluralRu(g.items.length, 'вопрос', 'вопроса', 'вопросов')}</span>${g.projectId ? `<a class="more-link" href="#/projects/${encodeURIComponent(g.projectId)}">Проект${icon('arrow')}</a>` : ''}</header>
    <div class="cs-ai-list">${g.items.map((it, i) => csAgendaItemHtml(it, i, g.items.length, editable)).join('')}</div></section>`).join('');
  return `<section class="view cs cs-agenda">
    ${csHead('Повестка техсовета', `Вопросы собраны из реестра по приоритетам. Всё, что реестр не сообщает, помечено как «не хватает данных», ничего не придумано.`, `${picker}${editable ? `<button class="btn btn-ghost" type="button" data-action="cs-manual-dialog" data-date="${escapeAttr(date)}">${icon('plus')}Добавить вопрос</button>` : ''}${start}`)}
    ${csTabs('agenda')}
    ${running ? `<div class="banner banner-blue cs-banner">${icon('play')}<span><b>Техсовет идёт.</b> Повестка зафиксирована на момент начала. Новые вопросы добавляйте на самом заседании.</span></div>` : ''}
    ${closed ? `<div class="banner banner-blue cs-banner">${icon('check')}<span><b>Техсовет ${escapeHtml(cdFmtFull(date))} завершён.</b> Повестка только для чтения.</span></div>` : ''}
    <div class="cs-prio-strip" role="list" aria-label="Приоритеты повестки">${agenda.counts.map(x => `<div class="cs-prio-chip ${x.count ? '' : 'is-zero'}" role="listitem" title="${escapeAttr(CS_PRIORITY_HELP[x.priority - 1])}"><span class="cs-prio-dot p${x.priority}">${x.priority}</span><span>${escapeHtml(x.label)}</span><b>${x.count}</b></div>`).join('')}</div>
    ${agenda.total ? groupsHtml : emptyState('Вопросов к техсовету нет', 'Все открытые поручения идут по плану. Можно добавить вопрос вручную.')}
    ${agenda.dropped.length ? `<section class="cs-block"><header class="block-head"><h2>Не выносим</h2><p class="muted">Эти поручения подпадают под условия повестки, но вы их исключили.</p></header><ul class="cs-dropped">${agenda.dropped.map(d => `<li><span>${escapeHtml(d.group.name)} — ${escapeHtml(councilShort(d.headline, 120))}<small>${escapeHtml(d.reasons[0]?.text || '')}</small></span>${editable ? `<button class="btn btn-ghost btn-sm" type="button" data-action="cs-agenda-restore" data-id="${escapeAttr(d.orderId)}">Вернуть</button>` : ''}</li>`).join('')}</ul></section>` : ''}
    <details class="cs-legend"><summary>Как собирается повестка</summary><ol>${CS_PRIORITY_HELP.map((t, i) => `<li><span class="cs-prio-dot p${i + 1}">${i + 1}</span>${escapeHtml(t)}</li>`).join('')}</ol></details>
  </section>`;
}

/* ---------- meeting mode ---------- */

function csMeetingUi() { return state.council.ui.meeting || null; }

function csItemStatus(d) {
  if (!d || !councilDraftTouched(d)) return 'none';
  if (d.doneConfirm) return 'done';
  if (d.accepted) return 'accepted';
  if (d.mark === 'skip' && !(d.decision || '').trim()) return 'skip';
  return 'draft';
}

const CS_STATUS_LABEL = { none: '', draft: 'Черновик', accepted: 'Принято', done: 'Выполнено', skip: 'Пропущено' };

function csMeetingCounts(m) {
  const items = m.agenda || [];
  const draft = m.draft || councilEmptyDraft();
  const c = { total: items.length, accepted: 0, done: 0, draft: 0, skip: 0, none: 0 };
  items.forEach(it => { c[csItemStatus(draft.items[it.id])]++; });
  c.reviewed = c.total - c.none;
  return c;
}

function csMNavHtml(m, ui) {
  const draft = m.draft || councilEmptyDraft();
  const items = m.agenda || [];
  const groups = [];
  items.forEach((it, i) => {
    let g = groups.find(x => x.name === it.group.name);
    if (!g) groups.push(g = { name: it.group.name, items: [] });
    g.items.push({ it, i });
  });
  return groups.map(g => `<section class="cs-mg"><h3>${escapeHtml(g.name)}<span>${g.items.filter(x => csItemStatus(draft.items[x.it.id]) !== 'none').length}/${g.items.length}</span></h3>${g.items.map(({ it, i }) => {
    const st = csItemStatus(draft.items[it.id]);
    return `<button type="button" class="cs-mi st-${st} ${i === ui.sel ? 'is-sel' : ''}" data-action="cs-m-go" data-i="${i}" ${i === ui.sel ? 'aria-current="true"' : ''}><span class="cs-mi-n">${it.no ? escapeHtml(it.no) : '+'}</span><span class="cs-mi-t">${escapeHtml(councilShort(it.headline, 84))}</span><span class="cs-mi-s" title="${CS_STATUS_LABEL[st]}">${st === 'done' ? icon('check') : st === 'accepted' ? '<i class="cs-dot is-blue"></i>' : st === 'draft' ? '<i class="cs-dot is-grey"></i>' : st === 'skip' ? '<i class="cs-dot is-ring"></i>' : it.priority === 1 ? '<i class="cs-dot is-red"></i>' : ''}</span></button>`;
  }).join('')}</section>`).join('');
}

function csMBarHtml(m, ui) {
  const cts = csMeetingCounts(m);
  const pct = cts.total ? Math.round(cts.reviewed / cts.total * 100) : 0;
  const saveText = ui.save.state === 'saving' ? 'Сохраняю…' : ui.save.state === 'error' ? 'Не сохранено на сервере. Копия есть в этом браузере' : ui.save.state === 'conflict' ? 'Обновлено другим участником' : ui.save.at ? `Черновик сохранён в ${formatTime(ui.save.at)}` : 'Черновик сохраняется автоматически';
  return `<div class="cs-m-title"><span class="cs-m-live"><i></i>Идёт</span><b>Техсовет ${escapeHtml(cdFmtFull(m.date))}</b></div>
    <div class="cs-m-prog" role="img" aria-label="Рассмотрено ${cts.reviewed} из ${cts.total}"><div class="cs-m-prog-bar"><i style="width:${pct}%"></i></div><span><b>${cts.reviewed}</b> из ${cts.total} рассмотрено · принято ${cts.accepted + cts.done}${cts.draft ? ` · черновиков ${cts.draft}` : ''}</span></div>
    <div class="cs-m-save is-${ui.save.state}" id="csSaveState" role="status">${escapeHtml(saveText)}</div>
    <div class="cs-m-btns"><button class="btn btn-ghost-dark" type="button" data-action="cs-m-exit">Выйти, черновик сохранён</button><button class="btn btn-light" type="button" data-action="cs-m-finish">Завершить техсовет</button></div>`;
}

function csMMainHtml(m, ui) {
  const item = (m.agenda || [])[ui.sel];
  if (!item) return emptyState('В повестке нет вопросов', 'Добавьте вопрос или завершите заседание.');
  const order = item.orderId ? councilOrder(item.orderId) : null;
  const orders = state.council.orders;
  const today = m.date;
  const latest = order ? councilLatestUpdate(order) : null;
  const dec = order ? councilLastDecision(order) : item.prev;
  const blocks = order ? councilActiveBlocks(order) : [];
  const dependents = order ? councilDependents(order.orderId, orders) : [];
  const gaps = item.gaps || [];
  const strip = order ? `<dl class="cs-m-strip">
    <div><dt>Ответственный</dt><dd>${csOwnerHtml(order, { raw: true })}</dd></div>
    <div><dt>Контрольная дата</dt><dd>${csDueHtml(order, today)}</dd></div>
    <div><dt>Состояние</dt><dd>${csStateTag(order)}${order.critical ? ' <span class="tag tag-red">критично</span>' : ''}</dd></div></dl>` : '';
  const orderIndex = (m.agenda || []).findIndex(x => x.id === item.id);
  return `<div class="cs-m-q">
    <div class="cs-m-kicker"><span class="cs-prio-dot p${item.priority}">${item.priority || '+'}</span>${escapeHtml(item.kicker)}<span class="muted">${orderIndex + 1} из ${(m.agenda || []).length}</span></div>
    <h2 class="cs-m-headline"><span>${escapeHtml(item.group.name)}</span> — ${escapeHtml(item.headline)}</h2>
    ${strip}
    <div class="cs-m-asks">
      <section><h3>Причина</h3><p>${item.reason ? escapeHtml(item.reason) : '<span class="muted">в реестре не указана</span>'}</p></section>
      <section><h3>Последствие</h3><p>${item.impact ? escapeHtml(item.impact) : '<span class="muted">в реестре не описано</span>'}</p></section>
      <section class="is-main"><h3>Вопрос техсовету</h3><p>${escapeHtml(item.question || 'Что нужно решить?')}</p></section>
      <section><h3>Предлагаемое действие</h3><p>${item.action ? escapeHtml(item.action) : '<span class="muted">не сформулировано</span>'}</p></section></div>
    ${gaps.length ? `<p class="cs-gaps">${sevIcon('watch', 16)}<span>Не хватает данных: ${gaps.map(escapeHtml).join('; ')}.</span></p>` : ''}
    <div class="cs-m-context">
      <section><h3>Прошлая договорённость</h3>${dec ? `<p><b>${escapeHtml(cdFmtFull(dec.date || councilEventDay(dec)))}</b> ${escapeHtml(dec.text)}</p>` : '<p class="muted">Раньше на техсовете не обсуждалось.</p>'}</section>
      <section><h3>Последний статус</h3>${latest ? `<p><b>${escapeHtml(latest.label)}${latest.asOf ? ', ' + escapeHtml(cdFmt(latest.asOf)) : ''}${latest.asOfInferred ? ' (дата по оценке)' : ''}.</b> ${escapeHtml(councilShort(latest.text, 420))}</p>` : order?.statusRaw ? `<p>${escapeHtml(order.statusRaw)}</p>` : '<p class="muted">Статусов в реестре нет.</p>'}</section>
      <section><h3>Блокеры</h3>${blocks.length ? `<ul>${blocks.map(b => `<li><span class="tag tag-red">${escapeHtml(councilBlockKind(b.kind).label)}</span> ${escapeHtml(b.text || '')}${b.decider ? `<small>Решает: ${escapeHtml(b.decider)}</small>` : ''}</li>`).join('')}</ul>${dependents.length ? `<p class="cs-fine">Разблокирует: ${dependents.map(d => '№' + escapeHtml(d.no || '?')).join(', ')}</p>` : ''}` : '<p class="muted">Блокеров не записано.</p>'}</section></div>
    ${item.facts?.length ? `<details class="cs-facts-more"><summary>Что известно из реестра</summary><ul>${item.facts.map(f => `<li class="${f.kind === 'guess' ? 'is-guess' : ''}"><b>${escapeHtml(f.label)}</b>${f.kind === 'guess' ? '<span class="tag tag-amber">предположительно</span>' : ''}<span>${escapeHtml(f.text)}</span></li>`).join('')}</ul></details>` : ''}
    <div class="cs-m-pager"><button class="btn btn-ghost" type="button" data-action="cs-m-prev" ${ui.sel === 0 ? 'disabled' : ''}>${icon('back')}Назад</button>${item.orderId ? `<a class="more-link" href="${csHref('order', item.orderId)}" target="_blank" rel="noopener">Карточка поручения${icon('arrow')}</a>` : ''}<button class="btn btn-dark" type="button" data-action="cs-m-next" ${ui.sel >= (m.agenda || []).length - 1 ? 'disabled' : ''}>Дальше${icon('chev')}</button></div>
  </div>`;
}

function csMFormHtml(m, ui) {
  const item = (m.agenda || [])[ui.sel];
  const draft = m.draft || councilEmptyDraft();
  if (!item) return '';
  const d = draft.items[item.id] || { decision: '', ownerName: '', ownerText: '', dueText: '', dueDate: '', state: '', blockNote: '', accepted: false, doneConfirm: false, doneNote: '', mark: '' };
  const st = csItemStatus(draft.items[item.id]);
  const order = item.orderId ? councilOrder(item.orderId) : null;
  const canChange = Boolean(order);
  const lock = d.accepted ? 'disabled' : '';
  const stateBtn = (id, label) => `<button type="button" class="cs-seg ${d.state === id ? 'is-on' : ''}" data-action="cs-m-state" data-state="${id}" aria-pressed="${d.state === id}" ${lock}>${label}</button>`;
  const badge = { none: '<span class="tag tag-muted">Не рассмотрено</span>', draft: '<span class="tag">Черновик</span>', accepted: `<span class="tag tag-blue">Решение принято${d.acceptedAt ? ' · ' + escapeHtml(formatTime(d.acceptedAt)) : ''}</span>`, done: `<span class="tag tag-green">Выполнение подтверждено</span>`, skip: '<span class="tag tag-muted">Пропущено</span>' }[st];
  return `<div class="cs-m-f" data-item="${escapeAttr(item.id)}">
    <header><h3>Решение</h3>${badge}</header>
    <label class="cs-field"><span>Что решили${d.accepted ? ' (принято, чтобы изменить, верните в черновик)' : ''}</span><textarea id="csDecision" data-field="decision" rows="5" ${lock} placeholder="Запишите договорённость так, как её услышали на совете">${escapeHtml(d.decision || '')}</textarea></label>
    ${canChange ? `<div class="cs-two"><label class="cs-field"><span>Ответственный</span><select class="cs-select" data-field="ownerName" ${lock}>${csOwnerOptions(d.ownerName)}</select></label>
      <label class="cs-field"><span>Срок</span><input type="date" data-field="dueDate" value="${escapeAttr(d.dueDate || '')}" ${lock} /></label></div>
    <label class="cs-field"><span>Срок словами (контрольная точка, условие)</span><input type="text" data-field="dueText" value="${escapeAttr(d.dueText || '')}" placeholder="Например: после решения заказчика" ${lock} autocomplete="off" /></label>
    <div class="cs-field"><span>Состояние после совета</span><div class="cs-segs" role="group" aria-label="Состояние">${stateBtn('', 'Без изменений')}${stateBtn('in_progress', 'В работе')}${stateBtn('decision', 'Нужно решение')}${stateBtn('blocked', 'Блокер')}${stateBtn('control', 'На контроле')}</div></div>
    ${d.state === 'blocked' ? `<label class="cs-field"><span>Что мешает</span><input type="text" data-field="blockNote" value="${escapeAttr(d.blockNote || '')}" ${lock} autocomplete="off" /></label>` : ''}` : '<p class="muted cs-fine">Вопрос без поручения: решение попадёт в протокол.</p>'}
    <div class="cs-m-accept">${d.accepted ? `<button class="btn btn-ghost" type="button" data-action="cs-m-unaccept">${icon('undo')}Вернуть в черновик</button>` : `<button class="btn btn-dark" type="button" data-action="cs-m-accept" ${councilDraftTouched(d) ? '' : 'disabled'}>${icon('check')}Принять решение<kbd class="kbd">Ctrl ⏎</kbd></button>`}<button class="btn btn-quiet" type="button" data-action="cs-m-skip">${d.mark === 'skip' ? 'Снять пометку' : 'Не обсуждали'}</button></div>
    ${canChange ? `<section class="cs-m-done ${d.doneConfirm ? 'is-on' : ''}"><h4>Выполнение</h4><p class="muted">Только если на совете подтвердили, что поручение выполнено. Статус в реестре этого не доказывает.</p>
      ${d.doneConfirm ? `<label class="cs-field"><span>Чем подтверждено</span><input type="text" data-field="doneNote" value="${escapeAttr(d.doneNote || '')}" autocomplete="off" /></label><button class="btn btn-ghost" type="button" data-action="cs-m-done">Снять подтверждение</button>` : `<button class="btn btn-ghost" type="button" data-action="cs-m-done">${icon('check')}Подтвердить выполнение</button>`}</section>` : ''}
    <section class="cs-m-new"><h4>Новые поручения${(draft.newOrders || []).length ? ` · ${draft.newOrders.length}` : ''}</h4>
      ${(draft.newOrders || []).map(n => `<div class="cs-m-newrow"><span><b>${escapeHtml(n.title)}</b><small>${escapeHtml(n.project || 'без проекта')} · ${escapeHtml(n.ownerName || 'ответственный не назначен')} · ${escapeHtml(n.dueDate ? cdFmtFull(n.dueDate) : n.dueText || 'срок не задан')}</small></span><button class="btn btn-quiet btn-sm" type="button" data-action="cs-m-new-remove" data-uid="${escapeAttr(n.uid)}" aria-label="Убрать">${icon('close')}</button></div>`).join('')}
      ${ui.newForm ? csMNewForm(item) : `<button class="btn btn-ghost btn-sm" type="button" data-action="cs-m-new-open">${icon('plus')}Создать поручение</button>`}</section>
  </div>`;
}

function csMNewForm(item) {
  return `<form class="cs-m-newform" id="csNewOrderForm"><label class="cs-field"><span>Что нужно сделать</span><textarea name="title" rows="2" required></textarea></label>
    <div class="cs-two"><label class="cs-field"><span>Проект</span><select name="project" class="cs-select"><option value="">Без проекта</option>${ITO_PROJECTS.map(p => `<option value="${escapeAttr(p.name)}" ${item?.group?.name === p.name ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>
    <label class="cs-field"><span>Ответственный</span><select name="ownerName" class="cs-select">${csOwnerOptions('')}</select></label></div>
    <div class="cs-two"><label class="cs-field"><span>Срок</span><input name="dueDate" type="date" /></label><label class="cs-field"><span>Или словами</span><input name="dueText" type="text" autocomplete="off" /></label></div>
    <div class="cs-row-actions"><button class="btn btn-dark btn-sm" type="submit">Добавить в черновик</button><button class="btn btn-quiet btn-sm" type="button" data-action="cs-m-new-cancel">Отмена</button></div></form>`;
}

/** The stored meeting with this browser's working draft on top of it. */
function csMeetingView() {
  const ui = csMeetingUi();
  const m = ui && councilMeetingById('meeting:' + ui.date);
  return m ? { ...m, draft: ui.draft } : null;
}

function csMeetingRoot() {
  const ui = csMeetingUi();
  const m = ui && csMeetingView();
  if (!ui || !m) return '';
  return `<div class="cs-m" role="dialog" aria-label="Техсовет ${escapeAttr(cdFmtFull(m.date))}">
    <header class="cs-m-bar" id="csMBar">${csMBarHtml(m, ui)}</header>
    <div class="cs-m-body"><nav class="cs-m-nav" id="csMNav" aria-label="Вопросы заседания">${csMNavHtml(m, ui)}</nav>
      <main class="cs-m-main" id="csMMain">${csMMainHtml(m, ui)}</main>
      <aside class="cs-m-form" id="csMForm" aria-label="Решение по вопросу">${csMFormHtml(m, ui)}</aside></div></div>`;
}

/* ---------- finishing the meeting ---------- */

function csFinishForm(plan, m) {
  const c = plan.counts;
  const list = (title, items, render) => items.length ? `<section class="cs-fin-sec"><h3>${title} <span class="count">${items.length}</span></h3><ul>${items.map(render).join('')}</ul></section>` : '';
  return `<form id="csFinishForm" class="cs-form cs-finish" data-date="${escapeAttr(m.date)}"><div class="modal-head"><div><div class="eyebrow">Техсовет ${escapeHtml(cdFmtFull(m.date))}</div><h2>Завершить и сохранить?</h2><p class="muted">Вот что запишется в поручения. После завершения заседание станет новой версией реестра и появится в истории. Черновики без «Принять» к поручениям не применяются.</p></div><button class="icon-btn" type="button" data-action="cs-dialog-close" aria-label="Закрыть">${icon('close')}</button></div>
    <div class="cs-sumrow"><div class="cs-sum"><b>${c.decisions}</b><span>решений принято</span></div><div class="cs-sum"><b>${c.owners}</b><span>ответственных назначено</span></div><div class="cs-sum"><b>${c.dues}</b><span>сроков изменено</span></div><div class="cs-sum is-green"><b>${c.done}</b><span>выполнение подтверждено</span></div><div class="cs-sum"><b>${c.created}</b><span>новых поручений</span></div></div>
    ${plan.warnings.length ? `<ul class="cs-warn">${plan.warnings.map(w => `<li>${sevIcon('watch', 14)}${escapeHtml(w)}</li>`).join('')}</ul>` : ''}
    ${list('Принятые решения', plan.decisions.filter(d => d.accepted && (d.text || d.changes.some(ch => ch.field !== 'done'))), d => `<li><b>${escapeHtml(d.group)}</b> ${d.no ? '№' + escapeHtml(d.no) + ' ' : ''}${escapeHtml(councilShort(d.title, 90))}${d.text ? `<p>${escapeHtml(d.text)}</p>` : ''}${d.changes.filter(ch => ch.field !== 'done').map(ch => `<small>${escapeHtml(ch.label)}: ${escapeHtml(councilShort(ch.from, 60))} → ${escapeHtml(councilShort(ch.to, 60))}</small>`).join('')}</li>`)}
    ${list('Подтверждено выполнение', plan.decisions.filter(d => d.done), d => `<li class="${d.doneNote ? '' : 'is-warn'}"><b>${escapeHtml(d.group)}</b> ${d.no ? '№' + escapeHtml(d.no) + ' ' : ''}${escapeHtml(councilShort(d.title, 90))}<small>${escapeHtml(d.doneNote || 'пояснения нет')}</small></li>`)}
    ${list('Новые поручения', plan.newOrders, n => `<li><b>${escapeHtml(n.project || 'без проекта')}</b> ${escapeHtml(n.title)}<small>${escapeHtml(n.ownerName || 'ответственный не назначен')} · ${escapeHtml(n.dueDate ? cdFmtFull(n.dueDate) : n.dueText || 'срок не задан')}</small></li>`)}
    ${list('Черновики без принятия: не будут применены', plan.drafts, d => `<li class="is-warn"><b>${escapeHtml(d.group)}</b> ${escapeHtml(councilShort(d.title, 90))}<small>${escapeHtml(d.text || 'без текста')}</small></li>`)}
    ${plan.untouched.length ? `<p class="muted cs-fine">Не рассмотрено вопросов: ${plan.untouched.length}. Они остаются открытыми и попадут в повестку следующего совета.</p>` : ''}
    <label class="cs-field"><span>Заметки к протоколу (необязательно)</span><textarea name="notes" rows="3">${escapeHtml(m.draft?.notes || '')}</textarea></label>
    <div class="modal-actions"><button class="btn btn-ghost" type="button" data-action="cs-dialog-close">Вернуться к заседанию</button><button class="btn btn-dark" type="submit">${icon('check')}Завершить и сохранить</button></div></form>`;
}
