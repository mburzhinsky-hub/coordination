'use strict';
/* Views, part 2: Projects, Horizon, Debt audit, History, TV wall screen. */

const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/* ---------- PROJECTS ---------- */

function timelineMarkers(card, snapshot) {
  const asOf = new Date(snapshot.asOf);
  const out = [];
  groupSimilarTasks(card.debtOnly).forEach(g => {
    if (!g.deadline) return;
    const when = dayMonthShort(g.deadline);
    out.push({ date: g.deadline, tone: 'muted', prio: 2, id: g.tasks[0].id, text: `${g.group ? `${g.title} ×${g.count}` : shortLabel(g.title, 44)} · срок ${when}${g.ageDays ? ` · просрочено ${g.ageDays} дн.` : ''}` });
  });
  card.acceptance.forEach(t => {
    const date = t.deadline || t.controlSince;
    if (!date) return;
    out.push({ date: new Date(date), tone: 'blue', prio: 0, id: t.id, text: `${shortLabel(t.title, 44)} · приёмка ${shortDays(t.waitingControlDays || 0)}` });
  });
  card.open.filter(t => t.debt === 'none' && !t.isWaitingControl && t.deadline).forEach(t => {
    const delta = diffDays(t.deadline, asOf);
    const quiet = (t.inactivityDays || 0) > 30;
    out.push({ date: t.deadline, tone: delta <= 1 ? 'red' : quiet ? 'muted' : 'ink', prio: delta <= 1 ? 0 : 1, id: t.id, text: `${shortLabel(t.title, 44)} · ${delta < 0 ? `просрочено ${shortDays(-delta)}` : delta === 0 ? 'срок сегодня' : delta === 1 ? 'срок завтра' : `срок ${dayMonthShort(t.deadline)}`}${quiet ? ` · ${shortDays(t.inactivityDays)} без движения` : ''}` });
  });
  card.closedRecent.slice().sort((a, b) => b.closed - a.closed).slice(0, 3).forEach(t => out.push({ date: t.closed, tone: 'green', prio: 3, id: t.id, text: `${shortLabel(t.title, 44)} · закрыта ${dayMonthShort(t.closed)}` }));
  const picked = out.sort((a, b) => a.prio - b.prio || Math.abs(diffDays(a.date, asOf)) - Math.abs(diffDays(b.date, asOf))).slice(0, 11);
  return picked.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function projectTimelineHtml(card, snapshot) {
  const asOf = new Date(snapshot.asOf);
  const markers = timelineMarkers(card, snapshot);
  if (!markers.length) return '<p class="muted pad">У проекта нет задач со сроками.</p>';
  const dates = markers.map(m => new Date(m.date).getTime());
  const min = Math.min(...dates, asOf.getTime()) - 8 * 86400000;
  const max = Math.max(...dates, asOf.getTime() + 40 * 86400000) + 8 * 86400000;
  const pct = d => ((new Date(d).getTime() - min) / (max - min)) * 100;
  const ticks = [];
  for (let d = new Date(new Date(min).getFullYear(), new Date(min).getMonth() + 1, 1); d.getTime() < max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) ticks.push(d);
  const rowH = 46;
  return `<div class="tlh" style="height:${markers.length * rowH + 88}px">
    ${ticks.map(d => `<div class="tlh-tick" style="left:${pct(d).toFixed(2)}%"><span>${MONTHS_NOM[d.getMonth()]}</span></div>`).join('')}
    <div class="tlh-today" style="left:${pct(asOf).toFixed(2)}%"><span>${dayMonthShort(asOf)}</span></div>
    ${markers.map((m, i) => `<button type="button" class="tlh-m tone-${m.tone} ${pct(m.date) > 66 ? 'is-left' : ''}" style="left:${pct(m.date).toFixed(2)}%;top:${44 + i * rowH}px" data-action="task" data-id="${escapeAttr(m.id)}"><i></i><span>${escapeHtml(m.text)}</span></button>`).join('')}
  </div>`;
}

function kanbanCol(title, tone, rows, renderRow, empty) {
  return `<div class="kcol"><header><span class="kdot tone-${tone}"></span><b>${title}</b><span class="count">${rows.length}</span></header><div class="kbody">${rows.length ? rows.map(renderRow).join('') : `<p class="muted kempty">${empty}</p>`}</div></div>`;
}

function projectTeam(card) {
  const byPerson = {};
  const touch = (name, key, t) => { const k = canonicalItoName(name) || name; (byPerson[k] ||= { acc: [], live: [], debt: [], closed: [] })[key].push(t); };
  card.acceptance.forEach(t => touch(t.responsible, 'acc', t));
  card.live.forEach(t => touch(t.responsible, 'live', t));
  card.debtOnly.forEach(t => touch(t.responsible, 'debt', t));
  card.closedRecent.forEach(t => touch(t.responsible, 'closed', t));
  return Object.entries(byPerson).map(([name, v]) => {
    const parts = [];
    if (v.acc.length) parts.push(`приёмка ${shortDays(Math.max(...v.acc.map(t => t.waitingControlDays || 0)))}`);
    if (v.live.length) parts.push(`в работе ${v.live.length}`);
    if (v.debt.length) parts.push(`долг ${v.debt.length}`);
    if (v.closed.length) parts.push(`закрыто ${v.closed.length}`);
    return { name, line: parts.join(' · '), weight: v.acc.length * 3 + v.live.length * 2 + v.debt.length + v.closed.length };
  }).sort((a, b) => b.weight - a.weight);
}

function viewProjects(b) {
  const snapshot = b.snapshot;
  const asOf = new Date(snapshot.asOf);
  const selId = state.ui.projectSel && b.projects.some(p => p.id === state.ui.projectSel) ? state.ui.projectSel : b.projects[0].id;
  const card = b.projects.find(p => p.id === selId);
  const active = b.projects.filter(p => p.risk !== 'idle');
  const idle = b.projects.filter(p => p.risk === 'idle');
  const sinceLabel = b.previous ? fmtDM(b.previous.asOf) : '3 недели';
  const silentDays = card.lastMovement ? diffDays(asOf, card.lastMovement) : null;
  const rhythm = projectRhythm(card, asOf, 4);
  const maxR = Math.max(1, ...rhythm.map(r => r.count));
  const zero = rhythm.filter(r => r.count === 0).at(-1);
  const groupedDebt = groupSimilarTasks(card.debtOnly).sort((x, y) => y.count - x.count || y.ageDays - x.ageDays);
  const signalsOnly = card.signals.filter(t => !t.isWaitingControl);
  const liveOnly = card.live.filter(t => !signalsOnly.includes(t));
  const team = projectTeam(card);
  const stat = (label, value, tone = '') => `<div class="stat ${tone ? 'tone-' + tone : ''}"><small>${label}</small><b>${value}</b></div>`;
  return `<section class="view projects">
    <div class="proj-grid">
      <nav class="proj-rail" aria-label="Проекты"><div class="rail-title"><h2>Проекты</h2><span class="count">${b.projects.length}</span></div>
        ${active.map(p => `<a class="rail-proj ${p.id === selId ? 'is-sel' : ''}" href="${hashLink('projects', p.id)}" aria-current="${p.id === selId ? 'page' : 'false'}"><span class="rp-top"><i class="kdot tone-${toneForRisk(p.risk)}"></i><b>${escapeHtml(p.name)}</b><span class="rp-n">${p.counts.open}</span></span>${segBar([{ n: p.counts.live, cls: 'live' }, { n: p.counts.acceptance, cls: 'acc' }, { n: p.counts.debt, cls: 'debt' }, { n: p.counts.rest, cls: 'rest' }], 'segbar-thin')}</a>`).join('')}
        ${idle.length ? `<p class="muted rail-idle">Ещё ${idle.length} без открытых задач: ${idle.map(p => escapeHtml(p.name)).join(', ')}.</p>` : ''}
      </nav>
      <div class="proj-main">
        <header class="proj-head"><div><div class="eyebrow">${escapeHtml(card.type)}</div><h1 class="view-title" data-reveal data-glitch>${escapeHtml(card.name)}</h1></div>
          <div class="proj-chips"><span class="pill pill-${toneForRisk(card.risk)}">${card.risk === 'idle' ? '' : sevIcon(toneForRisk(card.risk), 14)}${escapeHtml(card.label)}${card.reasons.length ? ': ' + escapeHtml(card.reasons.join(', ')) : ''}</span>
          ${silentDays != null && silentDays > 14 && card.counts.open ? `<span class="pill pill-watch">${sevIcon('watch', 14)}проект молчит: последняя правка ${shortDays(silentDays)} назад</span>` : ''}
          <span class="pill pill-neutral">${card.conflicts} ${pluralRu(card.conflicts, 'конфликт', 'конфликта', 'конфликтов')} проекта</span></div></header>
        <div class="stats">${stat('В работе', card.counts.live)}${stat('Приёмка', card.counts.acceptance, card.counts.acceptance ? 'blue' : '')}${stat('Сигналы', card.counts.signals, card.counts.signals ? 'red' : '')}${stat('Долг', card.counts.debt)}${stat('Последнее движение', card.lastMovement ? `<span class="stat-text">${dayMonth(card.lastMovement)}</span><small>${silentDays === 0 ? 'сегодня' : shortDays(silentDays) + ' назад'}</small>` : '<span class="stat-text">нет</span>')}</div>
        <section class="card tl-card"><header class="card-head"><h2>Горизонт проекта</h2><p class="muted">сроки задач, одинаковые схлопнуты в группу</p></header>${projectTimelineHtml(card, snapshot)}</section>
        <section class="card kan-card"><header class="card-head"><h2>Задачи по состоянию</h2></header>
          <div class="kanban">
            ${kanbanCol('Сигналы', 'red', signalsOnly, t => taskCardHtml(t, snapshot), 'Свежих сигналов нет')}
            ${kanbanCol('В работе', 'ink', liveOnly, t => taskCardHtml(t, snapshot), 'Живых задач нет')}
            ${kanbanCol('Приёмка', 'blue', card.acceptance, t => taskCardHtml(t, snapshot, { chip: t.ballOwner?.people?.length ? `<span class="tag tag-muted">мяч: ${escapeHtml(shortName(canonicalItoName(t.ballOwner.people[0]) || t.ballOwner.people[0]))}</span>` : '' }), 'Ничего не ждёт приёмки')}
            ${kanbanCol('Долг', 'muted', groupedDebt, g => g.group ? groupCardHtml(g, snapshot) : taskCardHtml(g.task, snapshot, { chip: `<span class="tag tag-red">${g.ageDays ? shortDays(g.ageDays) : 'без срока'}</span>` }), 'Долга нет')}
            ${kanbanCol(`Закрыто с ${sinceLabel}`, 'green', card.closedRecent, t => `<button class="tcard tcard-done" type="button" data-action="task" data-id="${escapeAttr(t.id)}"><span class="tcard-title">${icon('check')}${escapeHtml(t.title)}</span><span class="tcard-meta">${personLine(t.responsible)}<span class="tag">${escapeHtml(dayMonthShort(t.closed))}</span></span></button>`, 'Ничего не закрыто')}
          </div></section>
        <div class="proj-bottom">
          <section class="card"><header class="card-head"><h2>Команда на проекте</h2></header><ul class="team">${team.length ? team.map(p => `<li><button type="button" data-action="person" data-person="${escapeAttr(p.name)}">${avatarHtml(p.name, 34)}<span><b>${escapeHtml(displayName(p.name))}</b><small>${escapeHtml(p.line)}</small></span></button></li>`).join('') : '<li class="muted pad">Никто не занят.</li>'}</ul></section>
          <section class="card"><header class="card-head"><h2>Ритм проекта</h2><p class="muted">закрыто по неделям</p></header>
            <div class="rhythm">${rhythm.map(r => `<div class="rh-col"><b>${r.count}</b><span class="rh-track"><i class="${r.count ? '' : 'is-zero'}" style="height:${r.count ? Math.max(14, Math.round(r.count / maxR * 100)) : 3}%"></i></span><small>${escapeHtml(r.label)}</small></div>`).join('')}</div>
            <p class="muted pad">${zero ? `Неделя с ${escapeHtml(zero.label)} прошла без закрытых задач. Затишье дольше 7 дней при открытых задачах — повод спросить, что мешает.` : 'Задачи закрываются каждую неделю.'}</p></section>
        </div>
      </div>
    </div>
  </section>`;
}

/* ---------- HORIZON ---------- */

function viewHorizon(b) {
  const h = b.horizon;
  const today = startOfDay(b.snapshot.asOf);
  const col = w => `<section class="hcol ${w.current ? 'is-now' : ''}"><header><b>${escapeHtml(w.label)}</b><span class="count">${w.tasks.length}</span></header>
    ${w.tasks.length ? w.tasks.map(t => `<button class="hrow" type="button" data-action="task" data-id="${escapeAttr(t.id)}"><span class="hdate ${diffDays(t.deadline, today) <= 1 ? 'tone-red' : ''}">${WEEKDAYS_SHORT[new Date(t.deadline).getDay()]} ${new Date(t.deadline).getDate()}</span><span class="hbody"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(operationalLabel(t.project))} · ${escapeHtml(shortName(canonicalItoName(t.responsible) || t.responsible))}</small></span></button>`).join('') : '<div class="hempty" aria-hidden="true">'+Array.from({ length: 24 }, () => '<i></i>').join('')+'</div><p class="muted">нет сроков</p>'}</section>`;
  const maxCount = Math.max(1, ...h.weeks.map(w => w.tasks.length));
  return `<section class="view horizon">
    <header class="view-head"><div><div class="eyebrow">Горизонт · ${HORIZON_WEEKS} ${pluralRu(HORIZON_WEEKS, 'неделя', 'недели', 'недель')} вперёд ${termHtml('horizon')}</div><h1 class="view-title" data-reveal data-glitch>${h.total ? `Сроков на ${HORIZON_WEEKS} ${pluralRu(HORIZON_WEEKS, 'неделю', 'недели', 'недель')} всего ${h.total}` : 'На ближайшие недели сроков нет'}</h1></div>
      <div class="chips"><span class="chip">без срока: <b>${h.noDeadline}</b></span><a class="chip" href="#/debt">в долге: <b>${h.inDebt}</b></a><a class="chip" href="#/inbox/acceptance">в приёмке: <b>${h.inAcceptance}</b></a></div></header>
    <div class="card hbars"><div class="hbars-row">${h.weeks.map(w => `<div class="hbar ${w.current ? 'is-now' : ''}"><b>${w.tasks.length}</b><span class="hb-track"><i style="height:${w.tasks.length ? Math.max(8, Math.round(w.tasks.length / maxCount * 100)) : 3}%"></i></span><small>${escapeHtml(dayMonthShort(w.start))}</small></div>`).join('')}</div>
      <p class="muted pad">Считаются только задачи не в долге и не в приёмке: у них срок ещё что-то значит. Пустые недели — не обязательно отпуск, чаще сроки просто не заведены.</p></div>
    <div class="hcols">${h.weeks.map(col).join('')}${h.later.length ? col({ label: 'Позже', tasks: h.later, current: false }) : ''}</div>
  </section>`;
}

/* ---------- DEBT AUDIT ---------- */

function debtDoneIds(snapshot) {
  const byId = new Map(snapshot.tasks.map(t => [String(t.id), t]));
  return Object.entries(state.triage).filter(([id, e]) => e.action === 'done' && byId.get(id) && byId.get(id).debt !== 'none' && byId.get(id).signature === e.signature).map(([id]) => id);
}

function debtRowHtml(g) {
  const id = escapeAttr(g.tasks[0].id);
  const ids = escapeAttr(g.tasks.map(t => t.id).join(','));
  const idle = g.idleDays;
  return `<div class="drow ${g.group ? 'is-group' : ''}">
    <div class="drow-main">${g.group ? `<span class="gcard-count">${g.count}</span>` : ''}<div><button class="drow-title" type="button" data-action="task" data-id="${id}">${escapeHtml(g.title)}</button>
      <small>${escapeHtml(shortName(canonicalItoName(g.responsible) || g.responsible))} · ${g.deadline ? `срок был ${escapeHtml(dayMonthShort(g.deadline))}` : 'без срока'} · без движения ${shortDays(idle)}</small></div></div>
    <div class="drow-age ${g.ageDays >= 60 ? 'tone-red' : ''}">${g.ageDays ? shortDays(g.ageDays) : '—'}</div>
    <div class="drow-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-action="${g.group ? 'triage-batch' : 'triage'}" data-kind="done" ${g.group ? `data-ids="${ids}"` : `data-id="${id}"`}>${icon('check')}${g.group ? 'Списать все' : 'Списать'}</button>
      <button class="btn btn-ghost btn-sm" type="button" data-action="assign-open" data-id="${id}">${icon('user')}Вернуть в работу</button>
      <button class="btn btn-quiet btn-sm" type="button" data-action="${g.group ? 'triage-batch' : 'triage'}" data-kind="snooze" ${g.group ? `data-ids="${ids}"` : `data-id="${id}"`}>Оставить</button>
    </div>
    ${state.ui.assignFor === String(g.tasks[0].id) ? `<div class="assign-pop">${ITO_ROSTER.map(n => `<button type="button" class="assign-chip" data-action="triage" data-kind="assign" data-id="${id}" data-person="${escapeAttr(n)}">${avatarHtml(n, 22)}${escapeHtml(shortName(n))}</button>`).join('')}<p class="assign-note">Отметка остаётся в дашборде, в Bitrix задача не меняется.</p></div>` : ''}
  </div>`;
}

function viewDebt(b) {
  const audit = buildDebtAudit(b.snapshot, state.triage);
  const filter = state.ui.debtFilter;
  const apply = rows => rows.filter(r => filter === 'quiet30' ? r.idleDays > 30 : filter === 'quiet90' ? r.idleDays > 90 : filter === 'legacy' ? r.tasks.every(t => t.debt === 'legacy') : true);
  const groups = audit.byProject.map(p => ({ ...p, rows: apply(p.rows) })).filter(p => p.rows.length);
  const handled = audit.handled;
  const total = audit.total;
  const dots = Array.from({ length: Math.min(total, 80) }, (_, i) => `<i class="${i < Math.round(handled / Math.max(1, total) * Math.min(total, 80)) ? 'is-on' : ''}"></i>`).join('');
  const doneIds = debtDoneIds(b.snapshot);
  const filters = [['all', 'Весь долг'], ['quiet30', 'Тишина 30+ дней'], ['quiet90', 'Тишина 90+ дней'], ['legacy', 'Самый старый']];
  return `<section class="view debt">
    <header class="view-head"><div><div class="eyebrow">Ритуал раз в неделю · ${total} ${pluralRu(total, 'задача', 'задачи', 'задач')} в долге ${termHtml('debt')}</div><h1 class="view-title" data-reveal data-glitch>${audit.remaining ? `Ревизия долга: осталось разобрать ${audit.remaining} из ${total}` : 'Долг разобран. Хорошая работа'}</h1></div>
      <p class="muted view-note">Для каждой задачи три хода: списать, вернуть в работу кому-то, оставить до следующей выгрузки. Решения хранятся в дашборде. Закрыть задачу в Bitrix нужно отдельно: список «к закрытию» можно скопировать.</p></header>
    <div class="card audit-bar"><div class="dotbar" role="img" aria-label="Разобрано ${handled} из ${total}">${dots}</div>
      <div class="audit-meta"><span><b>${handled}</b> разобрано</span><span><b>${audit.quiet30}</b> молчат 30+ дней</span><span><b>${audit.quiet90}</b> молчат 90+ дней</span>
        <button class="btn btn-dark btn-sm" type="button" data-action="copy-done" data-ids="${escapeAttr(doneIds.join(','))}" ${doneIds.length ? '' : 'disabled'}>${icon('copy')}Скопировать список к закрытию (${doneIds.length})</button></div></div>
    <div class="filters" role="tablist" aria-label="Фильтр долга">${filters.map(([k, label]) => `<button type="button" role="tab" aria-selected="${filter === k}" class="fchip ${filter === k ? 'is-on' : ''}" data-action="debt-filter" data-filter="${k}">${label}</button>`).join('')}</div>
    <div class="debt-groups">${groups.length ? groups.map(p => `<section class="card debt-group"><header class="card-head"><h2>${escapeHtml(operationalLabel(p.name))}</h2><span class="count">${p.count}</span></header>${p.rows.map(debtRowHtml).join('')}</section>`).join('') : emptyState('Здесь пусто', 'По этому фильтру задач не осталось.')}</div>
  </section>`;
}

/* ---------- HISTORY ---------- */

function viewHistory(b) {
  const snaps = state.snapshots;
  const selId = state.ui.histSel && snaps.some(s => s.id === state.ui.histSel) ? state.ui.histSel : snaps[snaps.length - 1].id;
  const idx = snaps.findIndex(s => s.id === selId);
  const sel = snaps[idx];
  const prev = idx > 0 ? snaps[idx - 1] : null;
  const diff = prev ? summarizeSince(sel, prev) : null;
  const counts = snapshotCounts(sel);
  const nodes = snaps.map((s, i) => {
    const gap = i > 0 ? diffDays(new Date(s.asOf), new Date(snaps[i - 1].asOf)) : 0;
    return `${i > 0 ? `<div class="hist-gap ${gap > 2 ? 'is-hole' : ''}">${gap > 2 ? `<span>${daysWord(gap)} без выгрузок</span>` : ''}</div>` : ''}<button type="button" class="hist-node ${s.id === selId ? 'is-sel' : ''}" data-action="history-select" data-id="${escapeAttr(s.id)}"><i></i><b>${escapeHtml(dayMonthShort(s.asOf))}</b><small>${clockTime(s.asOf)}</small></button>`;
  }).join('');
  const events = diff ? summarizeChanges(sel).meaningful : [];
  return `<section class="view history">
    <header class="view-head"><div><div class="eyebrow">Машина времени · ${snaps.length} ${pluralRu(snaps.length, 'срез', 'среза', 'срезов')} ${termHtml('snapshot')}</div><h1 class="view-title" data-reveal data-glitch>${snaps.length > 1 ? `Что менялось между выгрузками` : 'Пока один срез'}</h1></div></header>
    <div class="card hist-strip" role="listbox" aria-label="Срезы">${nodes}</div>
    <div class="hist-grid">
      <section class="card"><header class="card-head"><div><h2>Срез ${escapeHtml(dayMonth(sel.asOf))}, ${clockTime(sel.asOf)}</h2><p class="muted">${counts.open} открытых · ${counts.acceptance} в приёмке · ${counts.debt} в долге · ${counts.overdue} просрочено</p></div>
        <div class="row-actions"><button class="btn btn-dark btn-sm" type="button" data-action="history-open" data-id="${escapeAttr(sel.id)}">${icon('rewind')}Показать экран на эту дату</button></div></header>
        ${diff ? `<div class="diff-tiles"><div class="dt dt-green"><b>${diff.closedCount}</b><span>закрыто</span></div><div class="dt dt-blue"><b>${diff.addedCount}</b><span>новых открытых</span></div><div class="dt dt-amber"><b>${diff.deadlineMoveCount}</b><span>переносов срока</span></div><div class="dt dt-red"><b>${diff.delta.debt > 0 ? '+' : ''}${diff.delta.debt}</b><span>в долге</span></div></div>
          <ul class="timeline">${diff.hasGap ? `<li><span class="when">пауза</span><span class="ev ev-watch">${icon('alert')}</span><span class="what"><b>${daysWord(diff.gapDays)} без выгрузок</b><small>${diff.closedBetweenCount} ${pluralRu(diff.closedBetweenCount, 'задача создана и закрыта', 'задачи созданы и закрыты', 'задач создано и закрыто')} между срезами, в срезах их нет</small></span></li>` : ''}
          ${events.map(e => `<li><span class="when">${fmtDM(e.at)}</span><span class="ev ev-${e.severity}">${icon(e.severity === 'critical' ? 'alert' : e.type.includes('DEADLINE') ? 'cal' : 'check')}</span><span class="what"><b>${escapeHtml(shortLabel(e.taskTitle || 'Задача', 80))}</b><small>${escapeHtml(e.label)}${e.detail ? ' · ' + escapeHtml(e.detail) : ''}</small></span></li>`).join('')}</ul>` : '<p class="muted pad">Это самый ранний срез: сравнивать пока не с чем.</p>'}
      </section>
      <section class="card"><header class="card-head"><h2>Как не терять события</h2></header><p class="pad">Дашборд видит только то, что есть в выгрузках. Если между двумя срезами прошло много дней, всё, что произошло внутри промежутка, видно лишь итогом. Выгружайте задачи из Bitrix каждый рабочий день, и дыры исчезнут.</p></section>
    </div>
  </section>`;
}

/* ---------- TV WALL SCREEN ---------- */

function tvKpi(label, value, delta, tone, prevLabel) {
  return `<div class="tv-kpi tone-${tone}"><div class="tv-kpi-label">${escapeHtml(label)}</div><div class="tv-kpi-num">${dotNumberHtml(value, { pitch: 10, cls: 'is-tv' })}</div><div class="tv-kpi-delta tone-${delta.tone}">${escapeHtml(delta.text)}${prevLabel && delta.text ? ` <span>к ${prevLabel}</span>` : ''}</div></div>`;
}

function tvPerson(r) {
  const tone = r.debtShare >= 0.8 ? 'red' : r.debtShare >= 0.5 ? 'amber' : 'ink';
  const loc = r.presence.project || r.presence.label;
  return `<div class="tv-person">${avatarHtml(r.name, 40, r.openCount ? r.debtShare : 0, tone)}<div><b>${escapeHtml(shortName(r.name))}</b><small>${escapeHtml(loc)} · раб. ${r.live.count} · приёмка ${r.acceptance.count} · долг ${r.debt.count}</small></div></div>`;
}

function tvDecision(item) {
  return `<div class="tv-dec sev-${item.severity}">${sevIcon(item.severity, 26)}<div><b>${escapeHtml(shortLabel(item.title, 90))}</b><small>${escapeHtml(operationalLabel(item.project))} · ${escapeHtml(shortName(canonicalItoName(item.who) || item.who))} · ${escapeHtml(item.reason)}</small></div><span class="tv-age tone-${item.severity}">${escapeHtml(item.ageLabel)}</span></div>`;
}

function tvProject(card) {
  return `<div class="tv-proj"><div class="tv-proj-head"><i class="kdot tone-${toneForRisk(card.risk)}"></i><b>${escapeHtml(card.name)}</b><span>раб. ${card.counts.live} · приёмка ${card.counts.acceptance} · долг ${card.counts.debt}</span><strong class="tone-${toneForRisk(card.risk)}">${card.oldestAcceptance ? shortDays(card.oldestAcceptance) : '—'}</strong></div>
    ${segBar([{ n: card.counts.live, cls: 'live' }, { n: card.counts.acceptance, cls: 'acc' }, { n: card.counts.debt, cls: 'debt' }, { n: card.counts.rest, cls: 'rest' }])}</div>`;
}

const TV_SCENES = 3;

function renderTv(b, scene) {
  const s = b.since;
  const prevLabel = s ? fmtDM(s.since) : '';
  const inbox = buildInbox(b.snapshot, state.triage);
  const asOf = new Date(b.snapshot.asOf);
  const risky = b.projects.filter(p => p.risk === 'high' || p.risk === 'mid').slice(0, 3);
  const ticker = [];
  if (s) { [...s.closed].sort((x, y) => y.closed - x.closed).slice(0, 3).forEach(t => ticker.push(`<span><i class="tone-green">●</i> ${fmtDM(t.closed)} закрыта «${escapeHtml(shortLabel(t.title, 48))}» · ${escapeHtml(surnameOf(canonicalItoName(t.responsible) || t.responsible))}</span>`)); }
  summarizeChanges(b.snapshot).meaningful.slice(0, 3).forEach(e => ticker.push(`<span><i class="tone-${e.severity === 'critical' ? 'red' : 'amber'}">●</i> ${fmtDM(e.at)} ${escapeHtml(shortLabel(e.taskTitle || '', 48))} · ${escapeHtml(e.label)}</span>`));
  if (!ticker.length) ticker.push('<span><i class="tone-muted">●</i> Новых событий нет</span>');
  let body = '';
  if (scene === 0) {
    body = `<div class="tv-grid"><section class="tv-card"><h2>Кто где</h2><p>Кольцо — доля задач в долге</p><div class="tv-people">${b.people.rows.map(tvPerson).join('')}</div></section>
      <div class="tv-col"><section class="tv-card"><h2>Решить сегодня</h2>${inbox.items.slice(0, 3).map(tvDecision).join('') || '<p class="tv-ok">Входящие пусты</p>'}</section>
      <section class="tv-card"><h2>Проекты в риске</h2>${risky.map(tvProject).join('') || '<p class="tv-ok">Рисков нет</p>'}</section></div></div>`;
  } else if (scene === 1) {
    body = `<div class="tv-projects">${b.projects.filter(p => p.risk !== 'idle').map(p => `<section class="tv-card">${tvProject(p)}<p class="tv-next">${p.next ? `Ближайший срок: ${escapeHtml(dayMonth(p.next.deadline))}` : 'Сроков нет'} · ${escapeHtml(p.reasons.join(', ') || p.label)}</p></section>`).join('')}</div>`;
  } else {
    body = `<div class="tv-grid"><section class="tv-card"><h2>Очередь решений</h2>${inbox.items.slice(0, 6).map(tvDecision).join('') || '<p class="tv-ok">Входящие пусты</p>'}</section>
      <section class="tv-card"><h2>Что изменилось</h2>${s ? `<p class="tv-big"><b>${s.closedCount}</b> закрыто · <b>${s.addedCount}</b> новых · <b>${s.deadlineMoveCount}</b> переносов срока</p><p class="tv-note">С ${dayMonth(s.since)}${s.hasGap ? `, между срезами ${daysWord(s.gapDays)}` : ''}</p>${summarizeChanges(b.snapshot).meaningful.slice(0, 5).map(e => `<div class="tv-ev tone-${e.severity === 'critical' ? 'red' : 'amber'}"><b>${escapeHtml(shortLabel(e.taskTitle || '', 70))}</b><small>${escapeHtml(e.label)}${e.detail ? ' · ' + escapeHtml(e.detail) : ''}</small></div>`).join('')}` : '<p class="tv-ok">Первый срез: изменений пока нет</p>'}</section></div>`;
  }
  const fresh = b.freshness;
  return `<div class="tv-wrap">
    <header class="tv-head"><div class="tv-title">${logoMark(54)}<div><h1>${weekdayCap(asOf)}, ${dayMonth(asOf)}</h1><p>Инженерно-технический отдел · срез ${clockTime(asOf)}</p></div></div>
      <div class="tv-right"><span class="chip chip-${fresh.level === 'fresh' ? 'green' : fresh.level === 'aging' ? 'amber' : 'red'}"><i class="dot"></i>${escapeHtml(fresh.label)}</span><span class="tv-scenes" aria-hidden="true">${Array.from({ length: TV_SCENES }, (_, i) => `<i class="${i === scene ? 'is-on' : ''}"></i>`).join('')}</span><button class="btn btn-ghost btn-sm" type="button" data-action="tv-exit">${icon('close')}Выйти ${kbdHtml('Esc')}</button></div></header>
    <div class="tv-kpis">${tvKpi('Ждут приёмки', b.acceptance.total, s ? deltaText(s.delta.acceptance, true) : { text: '', tone: 'muted' }, 'blue', prevLabel)}${tvKpi('Старый долг', b.debt.total, s ? deltaText(s.delta.debt, true) : { text: '', tone: 'muted' }, 'red', prevLabel)}${tvKpi('Просрочено', b.debt.overdue, s ? deltaText(s.delta.overdue, true) : { text: '', tone: 'muted' }, 'ink', prevLabel)}${tvKpi(s ? `Закрыто с ${prevLabel}` : 'Закрыто', s ? s.closedCount : 0, { text: s && s.topCloser ? `${s.topCloser.count} — ${surnameOf(canonicalItoName(s.topCloser.name) || s.topCloser.name)}` : '', tone: 'muted' }, 'green', '')}</div>
    <div class="tv-body">${body}</div>
    <footer class="tv-ticker"><b>ЛЕНТА</b><div class="tv-ticker-clip"><div class="tv-ticker-track">${ticker.join('')}${ticker.join('')}</div></div></footer>
  </div>`;
}
