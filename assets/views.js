'use strict';
/* Views, part 1: shared pieces, Today, Inbox ("Входящие"), task sheet, People. Each view returns an HTML string. */

const ROUTES = {
  today: { title: 'Сегодня', subtitle: 'Что происходит в отделе' },
  inbox: { title: 'Входящие', subtitle: 'Очередь решений' },
  people: { title: 'Люди и нагрузка', subtitle: 'Кто чем занят' },
  projects: { title: 'Проекты', subtitle: 'Девять объектов' },
  horizon: { title: 'Горизонт', subtitle: 'Сроки на ближайшие недели' },
  debt: { title: 'Ревизия долга', subtitle: 'Закрыть, списать или вернуть' },
  history: { title: 'История срезов', subtitle: 'Что менялось между выгрузками' }
};

function fmtDM(value) { const d = new Date(value); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`; }
function toneForRisk(risk) { return risk === 'high' ? 'critical' : risk === 'mid' ? 'watch' : risk === 'ok' ? 'ok' : 'neutral'; }
function hashLink(route, arg) { return `#/${route}${arg ? '/' + encodeURIComponent(arg) : ''}`; }

/* ---------- shared pieces ---------- */

function pairBars(prevValue, nowValue, tone, prevLabel, nowLabel) {
  const max = Math.max(prevValue, nowValue, 1);
  const bar = (v, cls, label) => `<span class="pair-col"><b>${v}</b><span class="pair-track"><i class="pair-bar ${cls}" style="height:${Math.max(6, Math.round(v / max * 100))}%"></i></span><small>${escapeHtml(label)}</small></span>`;
  return `<span class="pair" aria-hidden="true">${bar(prevValue, 'is-prev', prevLabel)}${bar(nowValue, 'is-now tone-' + tone, nowLabel)}</span>`;
}

function kpiCard(o) {
  return `<article class="kpi tone-${o.tone} rise" style="--i:${o.i || 0}">
    <div class="kpi-label">${o.label}</div>
    <div class="kpi-body">
      <div><div class="kpi-num">${o.value === null ? '<span class="kpi-dash">—</span>' : dotNumberHtml(o.value, { pitch: 8 })}</div>
      <div class="kpi-delta tone-${o.delta.tone}">${escapeHtml(o.delta.text)}</div></div>
      ${o.pair || ''}
    </div>
    <div class="kpi-sub">${o.sub}</div>
  </article>`;
}

function taskCardHtml(task, snapshot, opts = {}) {
  const who = task.responsible && task.responsible !== 'Не указан' ? personLine(task.responsible) : '';
  const chips = [];
  if (task.isWaitingControl) chips.push(`<span class="tag tag-blue">${escapeHtml(shortDays(task.waitingControlDays || 0))}</span>`);
  else if (task.deadline) chips.push(dateChip(task, snapshot));
  if (opts.chip) chips.push(opts.chip);
  return `<button class="tcard" type="button" data-action="task" data-id="${escapeAttr(task.id)}">
    <span class="tcard-title">${escapeHtml(task.title)}</span>
    <span class="tcard-meta">${who}${chips.join('')}</span>
  </button>`;
}

function groupCardHtml(group, snapshot) {
  const ids = group.tasks.map(t => t.id).join(',');
  return `<div class="gcard">
    <div class="gcard-head"><span class="gcard-count">${group.count}</span><b>${escapeHtml(group.title)}</b></div>
    <div class="gcard-meta">${group.deadline ? `срок был ${escapeHtml(dayMonthShort(group.deadline))}` : 'без срока'} · ${group.ageDays ? `просрочка до ${group.ageDays} дн.` : 'без просрочки'} · ${escapeHtml(shortName(canonicalItoName(group.responsible) || group.responsible))}</div>
    <div class="gcard-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="triage-batch" data-kind="done" data-ids="${escapeAttr(ids)}">${icon('layers')}Закрыть пакетом</button>
    <button class="btn btn-ghost btn-sm" type="button" data-action="task" data-id="${escapeAttr(group.tasks[0].id)}">Открыть первую</button></div>
  </div>`;
}

/* ---------- inbox rows (used by Today and Inbox) ---------- */

function triageChip(state) {
  if (!state) return '';
  if (state.action === 'assign') return `<span class="tag tag-ink">Назначено: ${escapeHtml(shortName(state.person || ''))}</span>`;
  if (state.action === 'escalate') return '<span class="tag tag-red">Эскалация</span>';
  return '';
}

function inboxActionsHtml(item) {
  if (state.historyMode) return '';
  const id = escapeAttr(item.taskId);
  const hasState = item.state && (item.state.action === 'assign' || item.state.action === 'escalate');
  const picking = state.ui.assignFor === String(item.taskId);
  return `<div class="irow-actions" role="group" aria-label="Решение по задаче">
    <button class="btn btn-dark" type="button" data-action="assign-open" data-id="${id}">${icon('user')}Назначить ${kbdHtml('A')}</button>
    <button class="btn btn-ghost" type="button" data-action="triage" data-kind="snooze" data-id="${id}">${icon('pause')}Позже ${kbdHtml('S')}</button>
    <button class="btn btn-ghost" type="button" data-action="triage" data-kind="escalate" data-id="${id}">${icon('flag')}Эскалация ${kbdHtml('E')}</button>
    <button class="btn btn-ghost" type="button" data-action="triage" data-kind="done" data-id="${id}">${icon('check')}Готово ${kbdHtml('⏎')}</button>
    <button class="btn btn-quiet only-narrow" type="button" data-action="task" data-id="${id}">${icon('chev')}Подробнее</button>
    ${hasState ? `<button class="btn btn-quiet" type="button" data-action="triage" data-kind="reopen" data-id="${id}">${icon('undo')}Снять отметку</button>` : ''}
    ${picking ? `<div class="assign-pop" role="listbox" aria-label="Кому назначить">${ITO_ROSTER.map(n => `<button type="button" class="assign-chip" data-action="triage" data-kind="assign" data-id="${id}" data-person="${escapeAttr(n)}">${avatarHtml(n, 22)}${escapeHtml(shortName(n))}</button>`).join('')}<p class="assign-note">Отметка остаётся в дашборде, в Bitrix задача не меняется.</p></div>` : ''}
  </div>`;
}

function inboxRowHtml(item, index, selected, expand) {
  const id = escapeAttr(item.taskId);
  return `<div class="irow sev-${item.severity} ${selected ? 'is-sel' : ''} rise" style="--i:${index}" data-item="${id}">
    <button class="irow-main" type="button" data-action="select-item" data-id="${id}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="irow-sev">${sevIcon(item.severity, 20)}</span>
      <span class="irow-body">
        <span class="irow-title">${escapeHtml(item.title)}</span>
        <span class="irow-meta">${projectTag(operationalLabel(item.project))}${personLine(item.who)}<span class="irow-reason">${escapeHtml(item.reason)}</span>${triageChip(item.state)}</span>
      </span>
      <span class="irow-age tone-${item.severity}">${escapeHtml(item.ageLabel)}</span>
    </button>
    ${selected && expand ? inboxActionsHtml(item) : ''}
  </div>`;
}

function inboxFilters(inbox, active) {
  const defs = [['all', 'Все'], ['projects', 'Проекты'], ['acceptance', 'Приёмка'], ['operational', 'Операционка']];
  return `<div class="filters" role="tablist" aria-label="Фильтр очереди">${defs.map(([key, label]) => `<button type="button" class="fchip ${active === key ? 'is-on' : ''}" role="tab" aria-selected="${active === key}" data-action="inbox-filter" data-filter="${key}">${label} <b>${inbox.counts[key] ?? 0}</b></button>`).join('')}</div>`;
}

/* ---------- TODAY ---------- */

function whoRowHtml(r) {
  const tone = r.debtShare >= 0.8 ? 'red' : r.debtShare >= 0.5 ? 'amber' : 'ink';
  const focus = [...r.live.tasks].sort((a, b) => taskFocusRank(b) - taskFocusRank(a))[0];
  let sub = '';
  if (focus) sub = focus.title;
  else if (!r.openCount) sub = 'нет открытых задач';
  else if (r.debtShare >= 0.99) sub = `все ${r.openCount} в долге`;
  else sub = `${r.acceptance.count ? r.acceptance.count + ' в приёмке' : ''}${r.acceptance.count && r.debt.count ? ', ' : ''}${r.debt.count ? r.debt.count + ' в долге' : ''}` || 'нет живых задач';
  const trio = (n, cls) => `<i class="${n ? cls : 'is-zero'}">${n}</i>`;
  return `<button class="who-row" type="button" data-action="person" data-person="${escapeAttr(r.name)}">
    ${avatarHtml(r.name, 34, r.openCount ? r.debtShare : 0, tone)}
    <span class="who-main"><b>${escapeHtml(r.display)}</b><small class="${!focus && r.debtShare >= 0.8 ? 'tone-red' : ''}">${escapeHtml(shortLabel(sub, 38))}</small></span>
    <span class="trio" aria-label="В работе ${r.live.count}, приёмка ${r.acceptance.count}, долг ${r.debt.count}">${trio(r.live.count, 'is-live')}${trio(r.acceptance.count, 'is-acc')}${trio(r.debt.count, 'is-debt')}</span>
  </button>`;
}

function whoCardHtml(b) {
  const groups = [['office', 'В офисе', 'home'], ['site', 'На объектах', 'pin'], ['remote', 'Удалённо', 'wifi'], ['vacation', 'В отпуске', 'sun'], ['', 'Не указано', 'user']]
    .map(([mode, label, ic]) => ({ mode, label, ic, rows: b.people.rows.filter(r => r.presence.mode === mode) })).filter(g => g.rows.length);
  const marked = b.people.rows.filter(r => r.presence.mode).length;
  return `<section class="card who-card rise" style="--i:4" aria-labelledby="whoTitle">
    <header class="card-head"><div><h2 id="whoTitle">Кто где и чем занят</h2>
      <p class="muted">Числа: <b class="k-live">в работе</b> · <b class="k-acc">приёмка</b> · <b class="k-debt">долг</b>. Кольцо — доля задач в долге. Отмечено ${marked} из ${b.people.rows.length}.</p></div>
      <button class="btn btn-ghost btn-sm" type="button" data-action="edit-presence">${icon('refresh')}${marked ? 'Изменить' : 'Отметить, кто где'}</button></header>
    <div class="who-groups ${groups.length === 1 ? 'is-single' : ''}">${groups.map(g => `<div class="who-group"><h3>${icon(g.ic)}${g.label}<span class="count">${g.rows.length}</span></h3><div class="who-rows">${g.rows.map(whoRowHtml).join('')}</div></div>`).join('')}</div>
  </section>`;
}

function decideCardHtml(b, inbox) {
  const list = filterInbox(inbox, state.ui.inboxFilter);
  const sel = Math.min(state.ui.sel, Math.max(0, list.length - 1));
  const shown = list.slice(0, 4);
  return `<section class="card decide-card rise" style="--i:5" aria-labelledby="decTitle">
    <header class="card-head"><div><h2 id="decTitle">Решить сегодня ${termHtml('decide')}</h2><p class="muted">Проекты выше операционки, внутри — по возрасту</p></div></header>
    ${inboxFilters(inbox, state.ui.inboxFilter)}
    <div class="irows">${shown.length ? shown.map((item, i) => inboxRowHtml(item, i, i === sel, true)).join('') : emptyState('Входящие пусты', 'Всё, что требовало решения, разобрано. Новые сигналы появятся с очередной выгрузкой.')}</div>
    <footer class="card-foot"><span class="muted">${kbdHtml('J')} ${kbdHtml('K')} навигация</span>${list.length > shown.length ? `<a class="more-link" href="#/inbox">Ещё ${list.length - shown.length} ${icon('chev')}</a>` : `<a class="more-link" href="#/inbox">Открыть очередь ${icon('chev')}</a>`}</footer>
  </section>`;
}

function projectMiniHtml(card, i) {
  const bar = segBar([{ n: card.counts.live, cls: 'live', label: 'в работе' }, { n: card.counts.acceptance, cls: 'acc', label: 'приёмка' }, { n: card.counts.debt, cls: 'debt', label: 'долг' }, { n: card.counts.rest, cls: 'rest', label: 'прочее' }]);
  return `<a class="pcard risk-${card.risk} rise" style="--i:${i}" href="${hashLink('projects', card.id)}">
    <div class="pcard-head"><div><b>${escapeHtml(card.name)}</b><small>${escapeHtml(card.type)}</small></div><span class="pill pill-${toneForRisk(card.risk)}">${escapeHtml(card.label)}</span></div>
    ${bar}
    <div class="pcard-counts"><span><b>${card.counts.live}</b> в работе</span><span class="k-acc"><b>${card.counts.acceptance}</b> приёмка</span><span><b>${card.counts.debt}</b> долг без приёмки</span></div>
    <div class="pcard-foot"><div><small>Ближайший срок</small><b>${card.next ? (card.nextInDays === 0 ? 'сегодня' : card.nextInDays === 1 ? 'завтра, ' + dayMonth(card.next.deadline) : dayMonth(card.next.deadline)) : 'нет сроков'}</b></div>
      <div class="pcard-old ${card.oldestAcceptance > CONTROL_RED_DAYS ? 'tone-red' : card.oldestAcceptance > CONTROL_OLD_DAYS ? 'tone-amber' : ''}"><small>Старейшая приёмка</small><b>${card.oldestAcceptance ? shortDays(card.oldestAcceptance) : '—'}</b></div></div>
  </a>`;
}

function changesCardHtml(b) {
  const s = b.since;
  if (!s) return `<section class="card changes-card rise" style="--i:7"><header class="card-head"><h2>Что изменилось</h2></header>${emptyState('Это первый срез', 'Изменения появятся после следующей выгрузки: дашборд сравнит её с этой.')}</section>`;
  const meaningful = summarizeChanges(b.snapshot).meaningful;
  const closerLine = s.topCloser ? `<li><span class="when">${fmtDM(s.closed.map(t => t.closed).sort((x, y) => y - x)[0])}</span><span class="ev ev-ok">${icon('check')}</span><span class="what"><b>${escapeHtml(surnameOf(canonicalItoName(s.topCloser.name) || s.topCloser.name))} · ${s.topCloser.count} ${pluralRu(s.topCloser.count, 'закрытая задача', 'закрытые задачи', 'закрытых задач')}</b><small>за ${daysWord(s.gapDays)} закрыто ${s.closedCount}, ${s.closedBetweenCount} из них между выгрузками</small></span></li>` : '';
  const evIcon = e => e.severity === 'critical' ? 'alert' : e.type.includes('DEADLINE') ? 'cal' : e.type.includes('CONTROL') ? 'bolt' : 'check';
  return `<section class="card changes-card rise" style="--i:7">
    <header class="card-head"><div><h2>Что изменилось</h2><p class="muted">с ${dayMonth(s.since)}, ${clockTime(s.since)}</p></div><a class="btn btn-ghost btn-sm" href="#/history">${icon('rewind')}Сравнить</a></header>
    <div class="change-line"><span><b>${s.closedCount}</b> закрыто</span><span><b>${s.addedCount}</b> новых открытых</span><span><b>${s.deadlineMoveCount}</b> ${pluralRu(s.deadlineMoveCount, 'перенос срока', 'переноса срока', 'переносов срока')}</span></div>
    <div class="change-line change-flow"><b>${s.was.acceptance}</b> ${icon('chev')} <b>${s.now.acceptance}</b> ${pluralRu(s.now.acceptance, 'приёмка', 'приёмки', 'приёмок')}</div>
    <ul class="timeline">${closerLine}${meaningful.slice(0, 4).map(e => `<li><span class="when">${fmtDM(e.at)}</span><span class="ev ev-${e.severity}">${icon(evIcon(e))}</span><span class="what"><b>${escapeHtml(shortLabel(e.taskTitle || 'Задача', 70))}</b><small>${escapeHtml(e.label)}${e.detail ? ' · ' + escapeHtml(e.detail) : ''}</small></span></li>`).join('')}</ul>
  </section>`;
}

function introHtml() {
  return `<aside class="intro rise" style="--i:1" role="note" aria-label="Как читать экран">
    <div class="intro-dots" aria-hidden="true">${dotLoader(7)}</div>
    <div class="intro-body"><b>Как читать этот экран</b>
      <ol><li><span class="n">1</span><span class="t">Заголовок — главное за день одной фразой.</span></li><li><span class="n">2</span><span class="t">Три карточки ниже — что именно застряло и что с этим делать.</span></li><li><span class="n">3</span><span class="t">В «Решить сегодня» нажимайте ${kbdHtml('A')} назначить, ${kbdHtml('S')} позже, ${kbdHtml('E')} эскалация, ${kbdHtml('⏎')} готово. ${kbdHtml('⌘K')} — поиск по всему.</span></li></ol></div>
    <button class="btn btn-ghost btn-sm" type="button" data-action="intro-dismiss">Понятно</button>
  </aside>`;
}

/* Dot plot: every open task is a dot, placed by how long it has been without movement. */
function ageChartHtml(b) {
  const chart = buildAgeChart(b.snapshot);
  if (!chart.total) return '';
  const narrow = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches;
  const W = narrow ? 380 : 560, padL = narrow ? 62 : 74, padR = 22, laneH = narrow ? 62 : 74, top = 34, axisH = 34;
  const H = top + laneH * chart.lanes.length + axisH;
  const R = narrow ? 5.2 : 5.8;
  const x0 = padL + 12;
  const x = age => x0 + Math.min(1, age / chart.max) * (W - x0 - padR);
  const ticks = [0, 14, 30, 60, 90, 120, 150, 180].filter(v => v <= chart.max && (v === 0 || x(v) - x(0) > 26));
  let k = 0;
  const lanes = chart.lanes.map((lane, li) => {
    const cy = top + laneH * li + laneH / 2 + 4;
    const placed = [];
    const dots = [...lane.dots].sort((a, b) => a.age - b.age).map(d => {
      const px = x(d.age), step = R * 2 + 1.4;
      let py = 0;
      for (let n = 0; n < 9; n++) {
        const off = n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * step;
        if (Math.abs(off) > laneH / 2 - R) continue;
        if (!placed.some(p => Math.hypot(p.x - px, p.y - off) < step - 0.2)) { py = off; break; }
        py = off;
      }
      placed.push({ x: px, y: py });
      const old = lane.id === 'acc' ? d.age >= CONTROL_RED_DAYS : d.age >= 90;
      return `<circle class="age-dot lane-${lane.id} ${old ? 'is-old' : ''}" style="--k:${k++}" cx="${px.toFixed(1)}" cy="${(cy + py).toFixed(1)}" r="${R}" tabindex="0" role="button" data-action="task" data-id="${escapeAttr(d.id)}" aria-label="${escapeAttr(`${d.title}, ${shortDays(d.age)}`)}"><title>${escapeHtml(`${shortLabel(d.title, 60)} · ${shortDays(d.age)}`)}</title></circle>`;
    }).join('');
    return `<g class="age-lane"><line class="age-rule" x1="0" x2="${W}" y1="${top + laneH * li + laneH}" y2="${top + laneH * li + laneH}"/><text class="age-lane-label" x="0" y="${cy - 3}">${escapeHtml(lane.label)}</text><text class="age-lane-count" x="0" y="${cy + 13}">${lane.dots.length} ${pluralRu(lane.dots.length, 'задача', 'задачи', 'задач')}</text>${dots}</g>`;
  }).join('');
  const marks = [[CONTROL_OLD_DAYS, narrow ? '14 дн.' : 'приёмка встала'], [CONTROL_RED_DAYS, narrow ? '60 дн.' : 'красная зона']].filter(([v]) => v < chart.max);
  const guides = marks.map(([v, label]) => `<g class="age-guide"><line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${top - 6}" y2="${top + laneH * chart.lanes.length}"/><text x="${(x(v) + 5).toFixed(1)}" y="${top - 12}">${escapeHtml(label)}</text></g>`).join('');
  const axis = ticks.map(v => `<text class="age-tick" x="${x(v).toFixed(1)}" y="${H - 8}" text-anchor="${v === 0 ? 'start' : 'middle'}">${v}</text>`).join('');
  return `<figure class="age-chart" aria-label="Возраст открытых задач">
    <figcaption><b>Сколько дней задачи стоят без движения</b><span>Одна точка — одна задача. Нажмите на точку, чтобы открыть её.</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Диаграмма возраста задач">${guides}${lanes}${axis}</svg>
  </figure>`;
}

function viewToday(b) {
  const snapshot = b.snapshot;
  const s = b.since;
  const asOf = new Date(snapshot.asOf);
  const inbox = buildInbox(snapshot, state.triage);
  const prevLabel = s ? fmtDM(s.since) : '';
  const nowLabel = fmtDM(snapshot.asOf);
  const accDelta = s ? deltaText(s.delta.acceptance, true, ` к ${prevLabel}`) : { text: '', tone: 'muted' };
  const debtDelta = s ? deltaText(s.delta.debt, true, ` к ${prevLabel}`) : { text: '', tone: 'muted' };
  const overDelta = s ? deltaText(s.delta.overdue, true, ` к ${prevLabel}`) : { text: '', tone: 'muted' };
  const overdueAllInDebt = b.debt.overdue === b.debt.overdueInDebt;
  const kpis = [
    kpiCard({ i: 3, tone: 'blue', label: `Ждут приёмки · в среднем ${b.acceptance.averageAge} дн.`, value: b.acceptance.total, delta: accDelta, pair: s ? pairBars(s.was.acceptance, s.now.acceptance, 'blue', prevLabel, nowLabel) : '', sub: b.acceptance.total ? `самая старая — ${shortDays(b.acceptance.maxAge)}` : 'очередь приёмки пуста' }),
    kpiCard({ i: 4, tone: 'red', label: `Старый долг · из ${b.counts.open} открытых ${termHtml('debt')}`, value: b.debt.total, delta: debtDelta, pair: s ? pairBars(s.was.debt, s.now.debt, 'red', prevLabel, nowLabel) : '', sub: b.debt.acceptanceInDebt ? `из них ${b.debt.acceptanceInDebt} — в приёмке` : `${Math.round(b.debt.share * 100)}% открытых задач` }),
    kpiCard({ i: 5, tone: 'ink', label: `Просрочено сейчас · ${overdueAllInDebt ? 'все в долге' : `из них в долге ${b.debt.overdueInDebt}`}`, value: b.debt.overdue, delta: overDelta, pair: s ? pairBars(s.was.overdue, s.now.overdue, 'ink', prevLabel, nowLabel) : '', sub: b.counts.live ? `${b.counts.live} живых задач` : 'живых задач нет' }),
    s ? kpiCard({ i: 6, tone: 'green', label: `Закрыто с ${prevLabel}${s.topCloser ? ` · ${s.topCloser.count} из них ${escapeHtml(surnameOf(canonicalItoName(s.topCloser.name) || s.topCloser.name))}` : ''}`, value: s.closedCount, delta: { text: `${s.closedSeenCount} видны по срезам, ${s.closedBetweenCount} между ними`, tone: 'muted' }, pair: pairBars(s.closedSeenCount, s.closedBetweenCount, 'green', 'по срезам', 'между'), sub: s.hasGap ? `между срезами ${daysWord(s.gapDays)}` : '' })
      : kpiCard({ i: 6, tone: 'green', label: 'Закрыто', value: null, delta: { text: 'первый срез', tone: 'muted' }, sub: 'сравнение появится после второй выгрузки' })
  ];
  const projects = b.projects.filter(p => p.risk !== 'idle');
  const idle = b.projects.filter(p => p.risk === 'idle');
  return `<section class="view today">
    <div class="hero" data-glitch>
      <canvas class="hero-dots" data-dotfield aria-hidden="true"></canvas>
      <div class="hero-main">
        <div class="eyebrow">${weekdayCap(asOf)}, ${dayMonth(asOf)} · срез ${clockTime(asOf)}</div>
        <h1 class="hero-title" data-reveal data-glitch>${headlineHtml(b.headline)}</h1>
        <p class="hero-note">${s ? `Динамика — к срезу ${dayMonthShort(s.since)}${s.hasGap ? ` (${daysWord(s.gapDays)} назад)` : ''}.` : 'Динамика появится после второй выгрузки.'}</p>
      </div>
      ${ageChartHtml(b)}
    </div>
    ${state.ui.introSeen ? '' : introHtml()}
    <div class="stories">${b.stories.map((st, i) => `<article class="story tone-${st.tone} rise" style="--i:${i + 1}">
      <div class="story-kicker">${sevIcon(st.tone === 'ok' ? 'ok' : st.tone, 18)}<span>${escapeHtml(st.kicker)}</span></div>
      <h3>${escapeHtml(st.title)}</h3><p>${escapeHtml(st.text)}</p>
      <a class="story-link" href="${hashLink(st.action.route, st.action.filter)}">${escapeHtml(st.action.label)}${icon('arrow')}</a></article>`).join('')}</div>
    <div class="kpis">${kpis.join('')}</div>
    <div class="today-grid">${whoCardHtml(b)}${decideCardHtml(b, inbox)}</div>
    <div class="today-bottom">
      <section class="projects-block" aria-labelledby="prTitle"><header class="block-head"><h2 id="prTitle">Проекты</h2><p class="muted">Красный — приёмка старше ${CONTROL_RED_DAYS} дней, жёлтый — старше ${CONTROL_OLD_DAYS} дней или срок завтра</p></header>
        <div class="pgrid">${projects.map(projectMiniHtml).join('')}${idle.length ? `<div class="pcard pcard-idle"><b>Без открытых задач · ${idle.length}</b><p>${idle.map(p => escapeHtml(p.name)).join(', ')}.</p></div>` : ''}</div></section>
      ${changesCardHtml(b)}
    </div>
  </section>`;
}

/* ---------- INBOX ---------- */

function lifecycleHtml(task) {
  return `<ol class="life">${taskLifecycle(task).map(step => `<li class="${step.done ? 'is-done' : ''} ${step.current ? 'is-current' : ''}"><i></i><span>${escapeHtml(step.label)}</span></li>`).join('')}</ol>`;
}

function chainHtml(task) {
  const ball = task.ballOwner?.people || [];
  const holds = name => ball.some(p => personKey(p) === personKey(name));
  const node = (role, name, extra = '') => {
    if (!name) return `<div class="chain-node"><small>${role}</small><span class="muted">нет</span></div>`;
    const canon = canonicalItoName(name) || name;
    return `<div class="chain-node ${holds(name) ? 'has-ball' : ''}">${holds(name) ? '<span class="ball">мяч здесь</span>' : ''}<small>${role}</small>${avatarHtml(canon, 40, holds(name) ? 1 : null, 'red')}<b>${escapeHtml(shortName(canon))}</b>${extra}</div>`;
  };
  const observers = (task.observers || []).filter(o => o !== task.author && o !== task.responsible);
  return `<div class="chain">${node('Постановщик', task.author)}<span class="chain-arrow">${icon('chev')}</span>${node(task.isWaitingControl ? 'Исполнитель · сдал' : 'Исполнитель', task.responsible)}<span class="chain-arrow">${icon('chev')}</span>
    <div class="chain-node"><small>Наблюдатели</small>${observers.length ? `<div class="obs">${observers.slice(0, 4).map(o => `<span class="obs-p">${avatarHtml(canonicalItoName(o) || o, 26)}<b>${escapeHtml(shortName(canonicalItoName(o) || o))}</b></span>`).join('')}${observers.length > 4 ? `<span class="muted">+${observers.length - 4}</span>` : ''}</div>` : '<span class="muted">нет</span>'}</div></div>`;
}

function taskDetailHtml(task, b, opts = {}) {
  const snapshot = b.snapshot;
  const timeline = taskTimeline(task, snapshot, state.snapshots);
  const sevKind = task.isWaitingControl ? ((task.waitingControlDays || 0) >= CONTROL_RED_DAYS ? 'critical' : (task.waitingControlDays || 0) > CONTROL_OLD_DAYS ? 'watch' : 'neutral') : task.attention !== 'none' ? task.attention : (task.debt !== 'none' ? 'neutral' : '');
  const statusChip = task.isWaitingControl ? `приёмка ${shortDays(task.waitingControlDays || 0)}${task.controlAgeEstimated ? ' (оценка)' : ''}` : task.overdue ? `просрочка ${shortDays(task.overdueDays)}` : task.dueToday ? 'срок сегодня' : task.noDeadline ? 'без срока' : '';
  const desc = cleanMultilineText(task.description || '');
  const item = opts.item;
  const deadlineHistory = task.deadlineHistory || [];
  return `<div class="td">
    <div class="td-top">${projectTag(operationalLabel(task.project))}<span class="tag tag-muted">№${escapeHtml(task.id)}</span>${statusChip ? `<span class="pill pill-${sevKind === 'critical' ? 'critical' : sevKind === 'watch' ? 'watch' : 'neutral'}">${sevKind && sevKind !== 'neutral' ? sevIcon(sevKind, 14) : ''}${escapeHtml(statusChip)}</span>` : ''}${task.debt !== 'none' ? '<span class="pill pill-neutral">старый долг</span>' : ''}</div>
    <h2 class="td-title" id="tdTitle">${escapeHtml(task.title)}</h2>
    ${item ? inboxActionsHtml(item) : ''}
    ${lifecycleHtml(task)}
    <section class="td-sec"><h4>Чей ход ${termHtml('ball')}</h4>${chainHtml(task)}</section>
    <section class="td-sec"><h4>История срока</h4>${deadlineHistory.length ? deadlineHistory.map(h => `<p class="dl"><span class="tag tag-amber">${escapeHtml(h.value ? dayMonthShort(h.value) : 'без срока')}</span> срок переносили, перенос зафиксирован ${escapeHtml(dayMonthShort(h.at))}</p>`).join('') : `<p class="dl">${task.deadline ? `<span class="tag ${task.overdue ? 'tag-red' : ''}">${escapeHtml(dayMonthShort(task.deadline))}</span> срок не переносился${task.overdue ? ` · просрочка ${shortDays(task.overdueDays)}` : ''}` : 'Срок не задан'}</p>`}</section>
    <section class="td-sec"><h4>Лента событий</h4><ul class="tl">${timeline.map(e => `<li class="tl-${e.tone}"><span class="tl-ico">${icon(e.icon)}</span><span class="tl-body"><b>${escapeHtml(e.title)}</b>${e.text ? `<small>${escapeHtml(e.text)}</small>` : ''}</span><span class="tl-when">${escapeHtml(e.when || '')}</span></li>`).join('')}</ul></section>
    ${desc ? `<details class="td-sec td-desc"><summary>Описание из Bitrix</summary><div class="td-desc-body">${escapeHtml(desc)}</div></details>` : ''}
    ${task.parentTitle ? `<section class="td-sec"><h4>Родительская задача</h4><p class="dl">${escapeHtml(task.parentTitle)}</p></section>` : ''}
    <div class="td-foot"><button class="btn btn-quiet btn-sm" type="button" data-action="copy" data-text="${escapeAttr(`№${task.id} · ${task.title}`)}">${icon('copy')}Скопировать название</button></div>
  </div>`;
}

function viewInbox(b) {
  const inbox = buildInbox(b.snapshot, state.triage);
  const list = filterInbox(inbox, state.ui.inboxFilter);
  const sel = Math.min(state.ui.sel, Math.max(0, list.length - 1));
  const current = list[sel];
  const minutes = Math.max(5, Math.ceil(inbox.items.length * 0.9 / 5) * 5);
  const heading = inbox.items.length ? `Разобрать за ${minutes} минут` : 'Входящие пусты';
  return `<section class="view inbox">
    <header class="view-head"><div><div class="eyebrow">Входящие · ${inbox.items.length} ${pluralRu(inbox.items.length, 'сигнал', 'сигнала', 'сигналов')}</div><h1 class="view-title" data-reveal data-glitch>${heading}</h1></div>
      <p class="muted view-note">Очередь собирается из срезов Bitrix: приёмки старше ${CONTROL_OLD_DAYS} дней и свежие сигналы. Решения хранятся здесь, Bitrix они не меняют.</p></header>
    <div class="inbox-grid">
      <section class="card inbox-list" aria-label="Очередь решений">
        <div class="inbox-bar">${inboxFilters(inbox, state.ui.inboxFilter)}<span class="muted keys">${kbdHtml('J')} ${kbdHtml('K')} навигация · ${kbdHtml('A')} назначить · ${kbdHtml('S')} позже · ${kbdHtml('E')} эскалация</span></div>
        <div class="irows">${list.length ? list.map((item, i) => inboxRowHtml(item, i, i === sel, false)).join('') : emptyState('Ноль входящих', inbox.total ? 'Все сигналы разобраны. Новые появятся с очередной выгрузкой.' : 'Срочного нет. Приёмки не застряли, сроки не горят.')}</div>
        <footer class="card-foot"><span class="muted">Разобрано в этом срезе: ${inbox.handled} из ${inbox.total}</span><span class="muted">цель — ноль к 18:00</span></footer>
      </section>
      <aside class="card inbox-detail" aria-label="Выбранная задача">${current ? taskDetailHtml(current.task, b, { item: current }) : `<div class="inbox-empty">${logoMark(54)}<p>Выберите задачу слева — здесь появятся её история и кому ходить.</p></div>`}</aside>
    </div>
  </section>`;
}

/* ---------- PEOPLE ---------- */

function matrixCell(count, kind) {
  if (!count) return '<td class="mc"><span class="mcell is-zero">·</span></td>';
  return `<td class="mc"><span class="mcell ${kind}${kind === 'm-debt' && count >= 10 ? ' is-hot' : ''}">${count}</span></td>`;
}

function viewPeople(b) {
  const m = b.people;
  const rows = m.rows;
  const selName = state.ui.peopleSel && rows.some(r => r.name === state.ui.peopleSel) ? state.ui.peopleSel : rows[0].name;
  const sel = rows.find(r => r.name === selName);
  const basis = m.basis;
  const blind = basis.open && basis.estimateFilled / basis.open < 0.2;
  const groupedDebt = groupSimilarTasks(sel.debt.tasks).sort((x, y) => y.count - x.count || y.ageDays - x.ageDays);
  const headline = peopleHeadline(m);
  const tone = sel.debtShare >= 0.8 ? 'red' : sel.debtShare >= 0.5 ? 'amber' : 'ink';
  const holders = [...new Set(sel.acceptance.tasks.flatMap(t => (t.ballOwner?.people || []).map(p => shortName(canonicalItoName(p) || p))))];
  return `<section class="view people">
    <header class="view-head"><div><div class="eyebrow">Отдел · ${rows.length} человек · срез ${dayMonth(b.snapshot.asOf)}</div><h1 class="view-title" data-reveal data-glitch>${headlineHtml(headline)}</h1></div></header>
    <div class="people-grid">
      <section class="card matrix-card" aria-label="Матрица нагрузки">
        <div class="table-wrap"><table class="matrix"><thead><tr><th class="m-name">Сотрудник</th><th class="m-h m-acc">Приёмка ${termHtml('acceptance')}</th><th class="m-h">Долг</th><th class="m-h">В работе ${termHtml('live')}</th>${m.weeks.map((w, i) => `<th class="m-h m-week ${i === 0 ? 'is-now' : ''}">${escapeHtml(w.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.name === selName ? 'is-sel' : ''}" data-action="person" data-person="${escapeAttr(r.name)}"><td class="m-name"><button class="m-person" type="button" data-action="person" data-person="${escapeAttr(r.name)}">${avatarHtml(r.name, 30)}<span><b>${escapeHtml(r.display)}</b><small>${icon(r.presence.mode === 'office' ? 'home' : r.presence.mode === 'site' ? 'pin' : r.presence.mode === 'remote' ? 'wifi' : r.presence.mode === 'vacation' ? 'sun' : 'user')}${escapeHtml(r.presence.project ? r.presence.project : r.presence.mode ? r.presence.label : 'не указано')}</small></span></button></td>
          <td class="mc">${r.acceptance.count ? `<span class="mcell m-acc"><b>${r.acceptance.count}</b><small>до ${shortDays(r.acceptance.maxAge)}</small></span>` : '<span class="mcell is-zero">·</span>'}</td>
          ${matrixCell(r.debt.count, 'm-debt')}${matrixCell(r.live.count, 'm-live')}
          ${r.weeks.map(w => `<td class="mc">${w.count ? `<span class="mcell m-w${Math.min(3, w.count)}">${w.count}</span>` : '<span class="mcell is-zero">·</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <footer class="card-foot legend"><span>Долг — без приёмки. Недели — по срокам задач не в долге.</span><span class="lg"><i class="mcell m-w1">1</i><i class="mcell m-w2">2</i><i class="mcell m-w3">3+</i><i class="mcell m-debt is-hot">10+</i> долг</span></footer>
      </section>
      <div class="people-side">
        <section class="card person-card" aria-live="polite">
          <header class="person-head">${avatarHtml(sel.name, 52, sel.openCount ? sel.debtShare : 0, tone)}<div><h2>${escapeHtml(sel.display)}</h2><p class="muted">${escapeHtml(sel.presence.label)} · ${sel.openCount} ${pluralRu(sel.openCount, 'открытая', 'открытых', 'открытых')} · ${sel.live.count ? `живых ${sel.live.count}` : 'живых нет'}</p></div></header>
          ${sel.openCount && sel.debtShare >= 0.8 ? `<div class="callout callout-red">${sevIcon('critical', 20)}<p><b>Почти весь список — долг.</b> ${Math.round(sel.debtShare * 100)}% открытых задач: ${sel.debt.count} в долге${sel.acceptance.count ? ` и ${sel.acceptance.count} в приёмке` : ''}.${groupedDebt.some(g => g.group) ? ` Есть серия из ${groupedDebt.find(g => g.group).count} похожих задач.` : ''}</p></div>` : ''}
          ${sel.acceptance.count ? `<h4 class="side-h">Приёмка · ждёт ${escapeHtml(holders.slice(0, 3).join(', ') || 'постановщика')}</h4><ul class="side-list">${sel.acceptance.tasks.slice(0, 3).map(t => `<li><button type="button" data-action="task" data-id="${escapeAttr(t.id)}"><span>${escapeHtml(t.title)}</span><b class="tone-${(t.waitingControlDays || 0) >= CONTROL_RED_DAYS ? 'red' : 'amber'}">${shortDays(t.waitingControlDays || 0)}</b></button></li>`).join('')}</ul>` : ''}
          ${sel.live.count ? `<h4 class="side-h">В работе</h4><ul class="side-list">${sel.live.tasks.slice(0, 4).map(t => `<li><button type="button" data-action="task" data-id="${escapeAttr(t.id)}"><span>${escapeHtml(t.title)}</span><b>${t.deadline ? escapeHtml(dayMonthShort(t.deadline)) : '—'}</b></button></li>`).join('')}</ul>` : ''}
          ${groupedDebt.length ? `<h4 class="side-h">Долг, сгруппирован</h4><div class="side-groups">${groupedDebt.slice(0, 4).map(g => g.group ? groupCardHtml(g, b.snapshot) : `<button class="side-single" type="button" data-action="task" data-id="${escapeAttr(g.task.id)}"><span>${escapeHtml(g.title)}</span><b class="tone-red">${g.ageDays ? shortDays(g.ageDays) : '—'}</b></button>`).join('')}${groupedDebt.length > 4 ? `<a class="more-link" href="#/debt">Ещё ${groupedDebt.length - 4} в ревизии долга ${icon('chev')}</a>` : ''}</div>` : ''}
          ${!sel.openCount ? '<p class="muted">Открытых задач нет.</p>' : ''}
        </section>
        ${blind ? `<section class="card callout-card"><header>${sevIcon('watch', 20)}<h3>Нагрузку нельзя считать честно</h3></header><p>В выгрузке «Оценка» заполнена у ${basis.estimateFilled} из ${basis.open} открытых задач, «Затрачено» — у ${basis.spentFilled}. У ${m.noDeadlines} из ${rows.length} нет срока в горизонте ${HORIZON_WEEKS} недель. Сейчас «нагрузка» — это число задач, а не часы. Заполняйте оценку в Bitrix — и здесь появятся часы.</p></section>` : ''}
      </div>
    </div>
  </section>`;
}
