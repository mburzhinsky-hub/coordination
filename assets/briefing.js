'use strict';
/*
 * Briefing layer.
 * Turns a snapshot (and the history around it) into the facts the interface speaks in:
 * what is stuck, what grows, who is busy, what to decide today. Pure functions, no DOM.
 */

const CONTROL_OLD_DAYS = 14;      // acceptance older than this is "stalled"
const CONTROL_RED_DAYS = 60;      // acceptance older than this is "critical"
const LIVE_WINDOW_DAYS = 14;      // a task is "live" if it moved within this window
const HORIZON_WEEKS = 6;          // planning horizon shown in people/horizon views
const FRESH_HOURS = 30;           // snapshot younger than this is green
const STALE_HOURS = 72;           // snapshot older than this is red

const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_SHORT = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
const WEEKDAYS_LONG = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
const WEEKDAYS_CAP = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];

/* ---------- small language helpers ---------- */

function pluralRu(n, one, few, many) {
  const a = Math.abs(Number(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
function daysWord(n) { return `${n} ${pluralRu(n, 'день', 'дня', 'дней')}`; }
function shortDays(n) { return `${n} дн.`; }
function dayMonth(value) { const d = new Date(value); return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; }
function dayMonthShort(value) { const d = new Date(value); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`; }
function weekdayCap(value) { return WEEKDAYS_CAP[new Date(value).getDay()]; }
function weekdayLower(value) { return WEEKDAYS_LONG[new Date(value).getDay()]; }
function clockTime(value) { const d = new Date(value); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function addDays(value, n) { const d = new Date(value); d.setDate(d.getDate() + n); return d; }
function mondayOf(value) { const d = startOfDay(value); const shift = (d.getDay() + 6) % 7; return addDays(d, -shift); }

/** Roster keeps the spelling the matching logic relies on; people see the Bitrix spelling. */
function displayName(name) { return name === 'Игорь Виденнев' ? 'Игорь Виденеев' : cleanText(name); }
function surnameOf(name) { const parts = displayName(name).split(' ').filter(Boolean); return parts.length > 1 ? parts[parts.length - 1] : parts[0] || ''; }
function shortName(name) {
  const parts = displayName(name).split(' ').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[parts.length - 1]} ${parts[0][0]}.`;
}
function personInitials(name) { return initials(displayName(name)).toUpperCase(); }
function ageLabel(days) { return days == null ? '' : days === 0 ? 'сегодня' : `${days} дн.`; }

/* ---------- facts about a single snapshot ---------- */

function openTasks(snapshot) { return (snapshot?.tasks || []).filter(t => !t.isCompleted); }

function snapshotCounts(snapshot) {
  const open = openTasks(snapshot);
  return {
    open: open.length,
    acceptance: open.filter(t => t.isWaitingControl).length,
    debt: open.filter(t => t.debt !== 'none').length,
    overdue: open.filter(t => t.overdue).length,
    live: open.filter(t => t.loadRelevant).length
  };
}

function snapshotFreshness(snapshot, now = new Date()) {
  const asOf = new Date(snapshot.asOf);
  const hours = Math.max(0, (now - asOf) / 36e5);
  const days = Math.max(0, diffDays(now, asOf));
  const level = hours < FRESH_HOURS ? 'fresh' : hours < STALE_HOURS ? 'aging' : 'stale';
  let label;
  if (days === 0) label = `Обновлено сегодня в ${clockTime(asOf)}`;
  else if (days === 1) label = `Срез вчера, ${clockTime(asOf)}`;
  else label = `Данные от ${dayMonthShort(asOf)} · ${daysWord(days)}`;
  const hint = level === 'stale'
    ? `Срез устарел на ${daysWord(days)}: экран показывает ${dayMonth(asOf)}. Загрузите свежую выгрузку Bitrix — сравнение с прошлым срезом пересчитается.`
    : level === 'aging' ? 'Срез не сегодняшний. Если выгрузка уже сделана — загрузите её.' : '';
  return { level, hours, days, label, hint };
}

/** Acceptance queue: tasks the executor handed over and that wait for a check ("Ждёт контроля"). */
function buildAcceptanceQueue(snapshot) {
  return openTasks(snapshot).filter(t => t.isWaitingControl).map(task => {
    const age = task.waitingControlDays || 0;
    return {
      task,
      taskId: task.id,
      ageDays: age,
      estimated: Boolean(task.controlAgeEstimated),
      level: age >= CONTROL_RED_DAYS ? 'red' : age > CONTROL_OLD_DAYS ? 'amber' : 'ok',
      holders: task.ballOwner?.people || []
    };
  }).sort((a, b) => b.ageDays - a.ageDays);
}

function summarizeAcceptance(snapshot) {
  const items = buildAcceptanceQueue(snapshot);
  const old = items.filter(i => i.ageDays > CONTROL_OLD_DAYS);
  const holderCounts = {};
  items.forEach(i => { const key = i.task.author || i.holders[0]; if (key) holderCounts[key] = (holderCounts[key] || 0) + 1; });
  const topHolder = Object.entries(holderCounts).sort((a, b) => b[1] - a[1])[0] || null;
  return {
    items,
    total: items.length,
    old: old.length,
    red: items.filter(i => i.level === 'red').length,
    maxAge: items[0]?.ageDays || 0,
    averageAge: items.length ? Math.round(items.reduce((s, i) => s + i.ageDays, 0) / items.length) : 0,
    topHolder: topHolder ? { name: topHolder[0], count: topHolder[1] } : null,
    inDebt: items.filter(i => i.task.debt !== 'none').length
  };
}

function summarizeDebt(snapshot) {
  const open = openTasks(snapshot);
  const debt = open.filter(t => t.debt !== 'none');
  const byProject = Object.entries(groupBy(debt, t => t.project || 'Без проекта'))
    .map(([name, rows]) => ({ name: name === '__empty__' ? 'Без проекта' : name, count: rows.length, projectId: rows[0]?.projectId || '' }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  return {
    total: debt.length,
    open: open.length,
    share: open.length ? debt.length / open.length : 0,
    quiet30: debt.filter(t => t.inactivityDays > 30).length,
    quiet90: debt.filter(t => t.inactivityDays > 90).length,
    overdue: open.filter(t => t.overdue).length,
    overdueInDebt: open.filter(t => t.overdue && t.debt !== 'none').length,
    acceptanceInDebt: debt.filter(t => t.isWaitingControl).length,
    byProject,
    tasks: debt
  };
}

/** How honest can "workload" be? Counts the fields a workload estimate would need. */
function summarizeLoadBasis(snapshot) {
  const open = openTasks(snapshot);
  return {
    open: open.length,
    estimateFilled: open.filter(t => t.estimate > 0).length,
    spentFilled: open.filter(t => t.spent > 0).length
  };
}

/* ---------- what changed since the previous snapshot ---------- */

function summarizeSince(snapshot, previous) {
  if (!snapshot || !previous) return null;
  const since = new Date(previous.asOf);
  const prevIds = new Set((previous.tasks || []).map(t => String(t.id)));
  const prevOpenIds = new Set(openTasks(previous).map(t => String(t.id)));
  const events = snapshot.events || [];

  const closedSet = new Map();
  (snapshot.tasks || []).forEach(t => { if (t.isCompleted && t.closed && new Date(t.closed) > since) closedSet.set(String(t.id), t); });
  events.filter(e => e.type === 'TASK_COMPLETED').forEach(e => {
    const task = (snapshot.tasks || []).find(t => String(t.id) === String(e.taskId));
    if (task) closedSet.set(String(task.id), task);
  });
  const closed = [...closedSet.values()];
  const closedSeen = closed.filter(t => prevOpenIds.has(String(t.id)));
  const closedBetween = closed.filter(t => !prevIds.has(String(t.id)));
  const closers = Object.entries(groupBy(closed, t => canonicalItoName(t.responsible) || t.responsible))
    .map(([name, rows]) => ({ name, count: rows.length })).sort((a, b) => b.count - a.count);

  const added = openTasks(snapshot).filter(t => !prevIds.has(String(t.id)));
  const deadlineMoves = events.filter(e => ['DEADLINE_CHANGED', 'OVERDUE_DEADLINE_MOVED', 'DEADLINE_REMOVED', 'DEADLINE_CHURN'].includes(e.type));
  const moveTasks = unique(deadlineMoves.map(e => String(e.taskId)));

  const now = snapshotCounts(snapshot);
  const was = snapshotCounts(previous);
  const gapDays = Math.max(0, diffDays(new Date(snapshot.asOf), since));

  return {
    since: previous.asOf,
    sinceId: previous.id,
    gapDays,
    hasGap: gapDays > 2,
    closed, closedCount: closed.length, closedSeenCount: closedSeen.length, closedBetweenCount: closedBetween.length,
    closers, topCloser: closers[0] || null,
    added, addedCount: added.length,
    deadlineMoveCount: moveTasks.length,
    deadlineMoves,
    now, was,
    delta: {
      acceptance: now.acceptance - was.acceptance,
      debt: now.debt - was.debt,
      overdue: now.overdue - was.overdue,
      live: now.live - was.live,
      open: now.open - was.open
    }
  };
}

/* ---------- people ---------- */

function weekIndexFor(date, week0) {
  const diff = Math.floor((startOfDay(date) - week0) / (7 * 86400000));
  return Math.max(0, diff);
}

function buildPeopleMatrix(snapshot, presence = { people: {} }) {
  const asOf = new Date(snapshot.asOf);
  const week0 = mondayOf(asOf);
  const weeks = Array.from({ length: HORIZON_WEEKS }, (_, i) => addDays(week0, i * 7));
  const open = openTasks(snapshot);
  const rows = ITO_ROSTER.map(name => {
    const mine = open.filter(t => canonicalItoName(t.responsible) === name);
    const acceptance = mine.filter(t => t.isWaitingControl);
    const debtOnly = mine.filter(t => t.debt !== 'none' && !t.isWaitingControl);
    const live = mine.filter(t => t.loadRelevant);
    const planned = mine.filter(t => !t.isWaitingControl && t.debt === 'none' && t.deadline);
    const cells = weeks.map(() => []);
    planned.forEach(t => {
      const idx = weekIndexFor(t.deadline, week0);
      if (idx < HORIZON_WEEKS) cells[idx].push(t);
    });
    const entry = presenceForPerson(presence, name);
    const project = entry.mode === 'site' ? itoProjectById(entry.projectId) : null;
    const debtAll = mine.filter(t => t.debt !== 'none').length;
    return {
      name,
      display: displayName(name),
      short: shortName(name),
      initials: personInitials(name),
      presence: { mode: entry.mode, label: presenceModeLabel(entry.mode), project: project?.name || '', projectId: project?.id || '' },
      openCount: mine.length,
      acceptance: { count: acceptance.length, maxAge: Math.max(0, ...acceptance.map(t => t.waitingControlDays || 0)), tasks: acceptance },
      debt: { count: debtOnly.length, tasks: debtOnly },
      live: { count: live.length, tasks: live },
      weeks: cells.map(rowsInWeek => ({ count: rowsInWeek.length, tasks: rowsInWeek })),
      deadlinesInHorizon: cells.reduce((s, c) => s + c.length, 0),
      debtShare: mine.length ? debtAll / mine.length : 0,
      weight: debtAll + acceptance.length * 1.5 + live.length * 0.1
    };
  }).sort((a, b) => b.weight - a.weight || a.display.localeCompare(b.display, 'ru'));

  const withoutLive = rows.filter(r => r.live.count === 0).length;
  const deadlinesTotal = rows.reduce((s, r) => s + r.deadlinesInHorizon, 0);
  const noDeadlines = rows.filter(r => r.deadlinesInHorizon === 0).length;
  return {
    rows,
    weeks: weeks.map(w => ({ start: w, label: dayMonthShort(w) })),
    withoutLive,
    withLive: rows.length - withoutLive,
    deadlinesTotal,
    noDeadlines,
    liveTotal: rows.reduce((s, r) => s + r.live.count, 0),
    basis: summarizeLoadBasis(snapshot)
  };
}

function peopleHeadline(matrix) {
  const n = matrix.rows.length;
  const weeksText = `${HORIZON_WEEKS} ${pluralRu(HORIZON_WEEKS, 'неделю', 'недели', 'недель')}`;
  if (matrix.withoutLive >= 4) {
    return [{ t: `У ${matrix.withoutLive} из ${n} нет ни одной живой задачи`, em: 'red' }, { t: `, а сроков на ${weeksText} всего ${matrix.deadlinesTotal}` }];
  }
  return [{ t: `${matrix.liveTotal} живых ${pluralRu(matrix.liveTotal, 'задача', 'задачи', 'задач')} у ${matrix.withLive} из ${n}` }, { t: `, сроков на ${weeksText} — ${matrix.deadlinesTotal}` }];
}

/* ---------- similar tasks ("Ticket 498…520") ---------- */

function similarityKey(task) {
  const words = normalizeHeader(task.title).replace(/[«»"“”„:;,.()\[\]]/g, ' ').split(/\s+/).filter(Boolean);
  const numbered = words.slice(0, 2).some(w => /\d/.test(w));
  const head = (numbered ? words.slice(0, 2) : words.slice(0, 3)).map(w => w.replace(/\d+/g, '#')).join(' ');
  return [canonicalItoName(task.responsible) || task.responsible, task.deadline ? dateKey(task.deadline).slice(0, 10) : 'nodl', head].join('|');
}

/** Folds series of near-identical tasks (same executor, same deadline day, same title opening) into one row. */
function groupSimilarTasks(tasks, minSize = 3) {
  const buckets = new Map();
  tasks.forEach(t => { const key = similarityKey(t); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(t); });
  const out = [];
  buckets.forEach((rows, key) => {
    if (rows.length >= minSize) {
      const sorted = [...rows].sort((a, b) => String(a.title).localeCompare(String(b.title), 'ru', { numeric: true }));
      out.push({ group: true, key, tasks: sorted, count: sorted.length, title: groupTitle(sorted), deadline: sorted[0].deadline, responsible: sorted[0].responsible, project: sorted[0].project, ageDays: Math.max(...sorted.map(t => t.overdueDays || 0)), idleDays: Math.min(...sorted.map(t => t.inactivityDays || 0)) });
    } else rows.forEach(t => out.push({ group: false, key: String(t.id), tasks: [t], count: 1, title: t.title, deadline: t.deadline, responsible: t.responsible, project: t.project, ageDays: t.overdueDays || 0, idleDays: t.inactivityDays || 0, task: t }));
  });
  return out;
}

function groupTitle(tasks) {
  const first = cleanText(tasks[0].title);
  const m = first.match(/^(.*?)(\d+)(.*)$/);
  const nums = tasks.map(t => (cleanText(t.title).match(/\d+/) || [])[0]).filter(Boolean).map(Number);
  if (m && nums.length === tasks.length) {
    const prefix = cleanText(m[1]);
    const rest = cleanText(first.slice(m[1].length + m[2].length).replace(/^\s*[:\-–—]\s*/, '')).split(/\s+/).slice(0, 2).join(' ');
    return `${prefix ? prefix + ' ' : ''}${Math.min(...nums)}–${Math.max(...nums)}${rest ? ' · ' + rest : ''}`;
  }
  return shortLabel(first, 60);
}

/* ---------- projects ---------- */

function buildProjectCards(snapshot, previous = null) {
  const asOf = new Date(snapshot.asOf);
  const since = previous ? new Date(previous.asOf) : null;
  const cards = ITO_PROJECTS.map(def => {
    const all = (snapshot.tasks || []).filter(t => t.projectId === def.id);
    const open = all.filter(t => !t.isCompleted);
    const acceptance = open.filter(t => t.isWaitingControl).sort((a, b) => (b.waitingControlDays || 0) - (a.waitingControlDays || 0));
    const debtOnly = open.filter(t => t.debt !== 'none' && !t.isWaitingControl);
    const live = open.filter(t => t.loadRelevant);
    const signals = open.filter(t => t.attention === 'critical' || t.attention === 'watch');
    const rest = open.filter(t => !acceptance.includes(t) && !debtOnly.includes(t) && !live.includes(t));
    const upcoming = open.filter(t => t.deadline && t.debt === 'none' && !t.isWaitingControl && startOfDay(t.deadline) >= startOfDay(asOf)).sort((a, b) => a.deadline - b.deadline);
    const next = upcoming[0] || null;
    const nextInDays = next ? diffDays(next.deadline, asOf) : null;
    const oldestAcceptance = acceptance[0]?.waitingControlDays || 0;
    const movement = all.flatMap(t => [t.changed, t.closed]).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const closedRecent = all.filter(t => t.isCompleted && t.closed && (since ? new Date(t.closed) > since : diffDays(asOf, t.closed) <= 21));
    const reasons = [];
    if (oldestAcceptance > CONTROL_OLD_DAYS) reasons.push(`приёмка ${shortDays(oldestAcceptance)}`);
    if (next && nextInDays <= 1) reasons.push(nextInDays === 0 ? 'срок сегодня' : 'срок завтра');
    const freshOverdue = open.filter(t => t.overdue && t.debt === 'none' && !t.isWaitingControl);
    if (freshOverdue.length) reasons.push(`просрочка: ${freshOverdue.length}`);
    let risk = 'ok';
    if (!open.length) risk = 'idle';
    else if (oldestAcceptance >= CONTROL_RED_DAYS || signals.some(t => t.attention === 'critical' && !t.isWaitingControl)) risk = 'high';
    else if (oldestAcceptance > CONTROL_OLD_DAYS || signals.length || (nextInDays != null && nextInDays <= 3)) risk = 'mid';
    return {
      id: def.id, name: def.name, type: def.type, fullName: def.fullName,
      all, open, acceptance, debtOnly, live, signals, rest, closedRecent,
      counts: { open: open.length, live: live.length, acceptance: acceptance.length, debt: debtOnly.length, signals: signals.length, rest: rest.length },
      next, nextInDays, oldestAcceptance, lastMovement: movement,
      conflicts: open.filter(t => t.projectConflict).length,
      risk, reasons,
      label: { high: 'Риск высокий', mid: 'Следить', ok: 'Спокойно', idle: 'Нет открытых' }[risk]
    };
  });
  const order = { high: 0, mid: 1, ok: 2, idle: 3 };
  return cards.sort((a, b) => order[a.risk] - order[b.risk] || b.oldestAcceptance - a.oldestAcceptance || b.counts.open - a.counts.open || a.name.localeCompare(b.name, 'ru'));
}

/** Closed-per-week rhythm of a project for the last four weeks (weeks start on Monday). */
function projectRhythm(card, asOf, weeks = 4) {
  const week0 = mondayOf(asOf);
  const buckets = Array.from({ length: weeks }, (_, i) => ({ start: addDays(week0, -(weeks - 1 - i) * 7), count: 0 }));
  card.all.filter(t => t.isCompleted && t.closed).forEach(t => {
    const idx = Math.floor((startOfDay(t.closed) - buckets[0].start) / (7 * 86400000));
    if (idx >= 0 && idx < weeks) buckets[idx].count += 1;
  });
  return buckets.map(b => ({ ...b, label: dayMonthShort(b.start) }));
}

/* ---------- horizon ---------- */

function buildHorizon(snapshot) {
  const asOf = new Date(snapshot.asOf);
  const week0 = mondayOf(asOf);
  const open = openTasks(snapshot);
  const dated = open.filter(t => t.deadline && t.debt === 'none' && !t.isWaitingControl);
  const weeks = Array.from({ length: HORIZON_WEEKS }, (_, i) => ({ start: addDays(week0, i * 7), end: addDays(week0, i * 7 + 6), tasks: [] }));
  const later = [];
  dated.forEach(t => {
    const idx = Math.floor((startOfDay(t.deadline) - week0) / (7 * 86400000));
    if (idx < HORIZON_WEEKS) weeks[Math.max(0, idx)].tasks.push(t); else later.push(t);
  });
  weeks.forEach(w => w.tasks.sort((a, b) => a.deadline - b.deadline));
  weeks.forEach((w, i) => { w.label = i === 0 ? 'Эта неделя' : i === 1 ? 'Следующая' : `${dayMonthShort(w.start)} — ${dayMonthShort(w.end)}`; w.current = i === 0; });
  return {
    weeks, later: later.sort((a, b) => a.deadline - b.deadline),
    total: weeks.reduce((s, w) => s + w.tasks.length, 0),
    noDeadline: open.filter(t => t.noDeadline).length,
    inDebt: open.filter(t => t.debt !== 'none').length,
    inAcceptance: open.filter(t => t.isWaitingControl).length
  };
}

/* ---------- decision inbox ---------- */

const INBOX_NEWS_ONLY = ['DEADLINE_CHANGED', 'OVERDUE_DEADLINE_MOVED', 'RESPONSIBLE_CHANGED', 'STATUS_CHANGED', 'LEFT_CONTROL', 'TASK_ADDED', 'TASK_RETURNED'];
const TRIAGE_ACTIONS = { assign: 'Назначено', escalate: 'Эскалация', snooze: 'Отложено до следующего среза', done: 'Разобрано' };

/** Is this item hidden by a decision someone already made? Decisions expire when the task changes or a new snapshot arrives. */
function triageVisible(entry, task, snapshot) {
  if (!entry) return true;
  if (entry.action === 'done') return entry.signature !== task.signature;
  if (entry.action === 'snooze') return entry.snapshotId !== snapshot.id;
  return true;
}

function buildInbox(snapshot, triage = {}) {
  const items = new Map();
  const taskLabel = task => cleanText(task.title);
  const add = item => items.set(String(item.taskId), item);
  buildAcceptanceQueue(snapshot).filter(q => q.ageDays > CONTROL_OLD_DAYS).forEach(q => {
    const task = q.task;
    add({
      taskId: task.id, task, kind: 'acceptance',
      severity: q.level === 'red' ? 'critical' : 'watch',
      title: taskLabel(task), project: task.project, projectId: task.projectId, operational: task.workstream === 'operational',
      who: task.responsible, ageDays: q.ageDays, ageLabel: shortDays(q.ageDays),
      reason: `приёмка${task.deadline ? `, срок был ${dayMonthShort(task.deadline)}` : ''}`,
      holders: q.holders
    });
  });
  buildAttentionItems(snapshot).forEach(a => {
    if (items.has(String(a.taskId))) return;
    // A moved deadline or a new status is news ("what changed"), not a decision someone has to make today.
    if (a.severity === 'watch' && INBOX_NEWS_ONLY.includes(a.eventType)) return;
    const task = snapshot.tasks.find(t => String(t.id) === String(a.taskId));
    if (!task) return;
    add({
      taskId: task.id, task, kind: 'attention', severity: a.severity,
      title: taskLabel(task), project: task.project, projectId: task.projectId, operational: task.workstream === 'operational',
      who: task.responsible, ageDays: task.waitingControlDays || task.overdueDays || 0, ageLabel: a.when,
      reason: `${a.label}${task.deadline ? `, срок ${task.dueToday ? 'сегодня' : (task.overdue ? 'был ' : '') + dayMonthShort(task.deadline)}` : ''}`,
      holders: task.ballOwner?.people || []
    });
  });
  const sevOrder = { critical: 0, watch: 1 };
  const all = [...items.values()].map(item => ({ ...item, state: triage[String(item.taskId)] || null }))
    .sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]
      || Number(a.operational) - Number(b.operational)
      || (a.kind === 'attention' ? 0 : 1) - (b.kind === 'attention' ? 0 : 1)
      || b.ageDays - a.ageDays);
  const visible = all.filter(item => triageVisible(item.state, item.task, snapshot));
  const handled = all.length - visible.length;
  return {
    all, items: visible, handled, total: all.length,
    counts: {
      all: visible.length,
      projects: visible.filter(i => !i.operational).length,
      operational: visible.filter(i => i.operational).length,
      acceptance: visible.filter(i => i.kind === 'acceptance').length
    }
  };
}

function filterInbox(inbox, filter) {
  if (filter === 'projects') return inbox.items.filter(i => !i.operational);
  if (filter === 'operational') return inbox.items.filter(i => i.operational);
  if (filter === 'acceptance') return inbox.items.filter(i => i.kind === 'acceptance');
  return inbox.items;
}

/* ---------- debt audit ---------- */

/** Open tasks as dots on an age axis: acceptance by days waiting, the rest by days without movement. */
const AGE_LANES = [
  { id: 'acc', label: 'Приёмка' },
  { id: 'debt', label: 'Долг' },
  { id: 'live', label: 'В работе' }
];
function buildAgeChart(snapshot) {
  const lanes = AGE_LANES.map(l => ({ ...l, dots: [] }));
  let other = 0;
  for (const t of openTasks(snapshot)) {
    const lane = t.isWaitingControl ? 'acc' : t.debt !== 'none' ? 'debt' : t.loadRelevant ? 'live' : '';
    if (!lane) { other++; continue; }
    const age = Math.max(0, Math.round(lane === 'acc' ? (t.waitingControlDays || t.inactivityDays || 0) : (t.inactivityDays || 0)));
    lanes.find(l => l.id === lane).dots.push({ id: String(t.id), title: t.title, age, who: t.responsible || '' });
  }
  const oldest = Math.max(0, ...lanes.flatMap(l => l.dots.map(d => d.age)));
  const max = Math.min(180, Math.max(90, Math.ceil(oldest / 30) * 30));
  return { lanes, other, max, oldest, total: lanes.reduce((s, l) => s + l.dots.length, 0) };
}

function buildDebtAudit(snapshot, triage = {}) {
  const debt = summarizeDebt(snapshot);
  const rows = debt.tasks.map(task => ({ task, state: triage[String(task.id)] || null })).filter(r => triageVisible(r.state, r.task, snapshot));
  const handled = debt.total - rows.length;
  const tasks = rows.map(r => r.task);
  const byProject = Object.entries(groupBy(tasks, t => t.project || 'Без проекта')).map(([name, list]) => ({
    name: name === '__empty__' ? 'Без проекта' : name,
    projectId: list[0].projectId || '',
    count: list.length,
    rows: groupSimilarTasks(list).sort((a, b) => b.count - a.count || b.ageDays - a.ageDays)
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  return { ...debt, remaining: tasks.length, handled, byProject };
}

/* ---------- stories and headline ---------- */

function buildStories(b) {
  const stories = [];
  const a = b.acceptance;
  const open = b.counts.open;

  const fire = b.attention.filter(i => i.severity === 'critical' && !(b.snapshot.tasks.find(t => String(t.id) === String(i.taskId))?.isWaitingControl));
  if (fire.length) {
    stories.push({
      id: 'fire', tone: 'critical', score: 120, kicker: 'Горит сегодня',
      title: fire.length === 1 ? fire[0].detail : `${fire.length} ${pluralRu(fire.length, 'задача требует', 'задачи требуют', 'задач требуют')} решения сегодня`,
      text: fire.length === 1 ? `${String(fire[0].label || '').replace(/\.+$/, '').replace(/^./, c => c.toUpperCase())}.` : fire.slice(0, 2).map(i => `«${shortLabel(i.detail, 64)}» — ${String(i.label || '').replace(/\.+$/, '').toLowerCase()}`).join('; ') + (fire.length > 2 ? ` и ещё ${fire.length - 2}` : '') + '.',
      action: { label: 'Открыть очередь', route: 'inbox' }
    });
  }
  if (a.old > 0) {
    const holder = a.topHolder ? `Мяч чаще всего у ${shortName(canonicalItoName(a.topHolder.name) || a.topHolder.name)} (${a.topHolder.count} из ${a.total}).` : '';
    const was = b.since && b.since.was.acceptance !== a.total ? ` В прошлом срезе (${dayMonthShort(b.since.since)}) приёмок было ${b.since.was.acceptance}.` : '';
    stories.push({
      id: 'acceptance', tone: a.red > 0 || a.old === a.total ? 'critical' : 'watch', score: 100 + a.old, kicker: 'Застряла приёмка',
      title: a.old === 1 ? `Приёмка ждёт больше ${CONTROL_OLD_DAYS} дней: ${a.maxAge} дн.` : `${a.old} из ${a.total} приёмок ждут больше ${CONTROL_OLD_DAYS} дней, самая старая — ${a.maxAge} дн.`,
      text: `${holder}${was}`.trim() || `Самая давняя приёмка висит ${a.maxAge} дн.`,
      action: { label: 'Открыть приёмки', route: 'inbox', filter: 'acceptance' }
    });
  }
  const d = b.debt;
  if (d.total >= 5 && d.share >= 0.35) {
    const growing = b.since && b.since.delta.debt > 0;
    const tops = d.byProject.slice(0, 3).map(p => `${p.name} (${p.count})`).join(', ');
    stories.push({
      id: 'debt', tone: growing && d.share >= 0.5 ? 'critical' : 'watch', score: 90 + Math.round(d.share * 20), kicker: growing ? 'Растёт долг' : 'Накопленный долг',
      title: `${d.total} из ${d.open} открытых задач — старый долг`,
      text: `${d.quiet30} ${pluralRu(d.quiet30, 'задача не менялась', 'задачи не менялись', 'задач не менялись')} больше 30 дней${d.quiet90 ? `, ${d.quiet90} — больше 90` : ''}. Больше всего: ${tops}.`,
      action: { label: 'Провести ревизию', route: 'debt' }
    });
  }
  const p = b.people;
  if (p.withoutLive >= 4 || (b.counts.open && b.counts.live / b.counts.open < 0.25)) {
    const topDebt = [...p.rows].sort((x, y) => y.debt.count - x.debt.count)[0];
    const basis = p.basis;
    const basisNote = basis.open && basis.estimateFilled === 0
      ? ' Поле «Оценка» не заполнено ни у одной задачи, нагрузку считать нечем.'
      : '';
    stories.push({
      id: 'live', tone: 'watch', score: 80, kicker: 'Мало живой работы',
      title: `За ${LIVE_WINDOW_DAYS} дней менялись только ${b.counts.live} ${pluralRu(b.counts.live, 'задача', 'задачи', 'задач')}, у ${p.withoutLive} из ${p.rows.length} нет ни одной`,
      text: `${topDebt && topDebt.debt.count ? `Больше всего долга у ${surnameOf(topDebt.name)}: ${topDebt.debt.count}. ` : ''}Сроков на ближайшие ${HORIZON_WEEKS} недель — ${p.deadlinesTotal} на весь отдел.${basisNote}`,
      action: { label: 'Открыть людей', route: 'people' }
    });
  }
  if (b.since && b.since.hasGap) {
    stories.push({
      id: 'gap', tone: 'watch', score: 70, kicker: 'Дыра в данных',
      title: `Между срезами ${daysWord(b.since.gapDays)}: детали этого периода не видны`,
      text: `${b.since.closedBetweenCount} ${pluralRu(b.since.closedBetweenCount, 'задача создана и закрыта', 'задачи созданы и закрыты', 'задач создано и закрыто')} между выгрузками и в срезах не появляется. Выгружайте ежедневно, чтобы не терять события.`,
      action: { label: 'Показать срезы', route: 'history' }
    });
  }
  if (b.since && b.since.closedCount) {
    const c = b.since.topCloser;
    stories.push({
      id: 'closed', tone: 'ok', score: 40, kicker: 'Что закрыто',
      title: `Закрыто ${b.since.closedCount} с ${dayMonth(b.since.since)}`,
      text: c ? `Больше всего закрытых задач у ${surnameOf(canonicalItoName(c.name) || c.name)}: ${c.count}.` : '',
      action: { label: 'Что изменилось', route: 'history' }
    });
  }
  return stories.sort((x, y) => y.score - x.score).slice(0, 3);
}

function buildHeadline(b) {
  const parts = [];
  const a = b.acceptance;
  const crit = b.attention.filter(i => i.severity === 'critical').length;
  if (a.total > 1 && a.old > 0 && a.old / a.total >= 0.5) {
    parts.push({ t: 'Приёмка встала: ' }, { t: `${a.old} из ${a.total} задач ждут дольше двух недель`, em: 'red' });
  } else if (crit > 0) {
    parts.push({ t: `Сегодня на решение: ` }, { t: `${crit} ${pluralRu(crit, 'сигнал', 'сигнала', 'сигналов')}`, em: 'red' });
  } else {
    parts.push({ t: 'Срочного нет: ' }, { t: `${b.counts.open} открытых задач, из них ${b.debt.total} — старый долг`, em: 'amber' });
  }
  if (b.since) {
    const c = b.since.closedCount;
    const dd = b.since.delta.debt;
    parts.push({ t: `. Закрыто ${c}` + (dd > 0 ? `, но долг вырос до ${b.debt.total}` : dd < 0 ? `, долг сократился до ${b.debt.total}` : `, долг ${b.debt.total}`) + '.' });
  } else {
    parts.push({ t: `. Старый долг — ${b.debt.total} из ${b.counts.open}.` });
  }
  return parts;
}

/* ---------- the whole briefing ---------- */

function previousSnapshotOf(snapshot, history = []) {
  const asOf = new Date(snapshot.asOf);
  return history.filter(s => new Date(s.asOf) < asOf).sort((x, y) => new Date(x.asOf) - new Date(y.asOf)).at(-1) || null;
}

function buildBriefing(snapshot, history = [], presence = { people: {} }, now = new Date()) {
  const previous = previousSnapshotOf(snapshot, history);
  const counts = snapshotCounts(snapshot);
  const b = {
    snapshot, previous, now,
    counts,
    freshness: snapshotFreshness(snapshot, now),
    acceptance: summarizeAcceptance(snapshot),
    debt: summarizeDebt(snapshot),
    attention: buildAttentionItems(snapshot),
    since: summarizeSince(snapshot, previous),
    people: buildPeopleMatrix(snapshot, presence),
    projects: buildProjectCards(snapshot, previous),
    horizon: buildHorizon(snapshot),
    presence
  };
  b.stories = buildStories(b);
  b.headline = buildHeadline(b);
  return b;
}

/** Lifecycle of one task, for the stepper in the task sheet. */
function taskLifecycle(task) {
  const steps = [
    { id: 'created', label: task.created ? `Создана ${dayMonthShort(task.created)}` : 'Создана', done: true },
    { id: 'work', label: task.actualStart ? `В работе с ${dayMonthShort(task.actualStart)}` : 'В работе', done: Boolean(task.actualStart || task.isInProgress || task.isWaitingControl || task.isCompleted) },
    { id: 'control', label: task.isWaitingControl && task.controlSince ? `Приёмка с ${dayMonthShort(task.controlSince)}` : 'Приёмка', done: Boolean(task.isWaitingControl || task.isCompleted), current: Boolean(task.isWaitingControl) },
    { id: 'closed', label: task.closed ? `Завершена ${dayMonthShort(task.closed)}` : 'Завершена', done: Boolean(task.isCompleted), current: Boolean(task.isCompleted) }
  ];
  if (!task.isWaitingControl && !task.isCompleted) steps[1].current = true;
  return steps;
}

/** Human-readable timeline of one task from the facts the snapshots hold. */
function taskTimeline(task, snapshot, history = []) {
  const out = [];
  const asOf = new Date(snapshot.asOf);
  if (task.isWaitingControl) out.push({ tone: 'critical', icon: 'alert', title: `Приёмка длится ${daysWord(task.waitingControlDays || 0)}`, text: task.deadline && task.overdue ? `срок прошёл ${dayMonth(task.deadline)}, статус не менялся` : 'ждёт проверки', when: 'сегодня' });
  else if (task.overdue) out.push({ tone: 'critical', icon: 'alert', title: `Просрочка ${daysWord(task.overdueDays)}`, text: `срок был ${dayMonth(task.deadline)}`, when: 'сегодня' });
  else if (task.dueToday) out.push({ tone: 'critical', icon: 'cal', title: 'Срок сегодня', text: dayMonth(task.deadline), when: 'сегодня' });
  else if (task.deadline) out.push({ tone: 'watch', icon: 'cal', title: `Срок ${dayMonth(task.deadline)}`, text: task.deadlineDeltaDays != null ? `через ${daysWord(task.deadlineDeltaDays)}` : '', when: '' });
  (snapshot.events || []).filter(e => String(e.taskId) === String(task.id) && !['BECAME_STALE', 'BECAME_CHRONIC', 'BECAME_LEGACY'].includes(e.type)).forEach(e => {
    out.push({ tone: e.severity === 'critical' ? 'critical' : e.severity === 'watch' ? 'watch' : 'info', icon: 'bolt', title: e.label, text: e.detail || '', when: dayMonthShort(e.at) });
  });
  const earlier = history.filter(s => new Date(s.asOf) < asOf).sort((x, y) => new Date(y.asOf) - new Date(x.asOf));
  const before = earlier.map(s => ({ s, t: (s.tasks || []).find(x => String(x.id) === String(task.id)) })).find(x => x.t);
  if (before && before.t.isWaitingControl && task.isWaitingControl) {
    out.push({ tone: 'clock', icon: 'clock', title: `В прошлом срезе приёмка длилась ${daysWord(before.t.waitingControlDays || 0)}`, text: 'задача не сдвинулась между срезами', when: dayMonthShort(before.s.asOf) });
  }
  (task.deadlineHistory || []).slice(-3).forEach(h => out.push({ tone: 'watch', icon: 'cal', title: 'Срок переносился', text: `новый срок ${h.value ? dayMonth(h.value) : 'удалён'}`, when: dayMonthShort(h.at) }));
  if (task.changed) out.push({ tone: 'info', icon: 'check', title: 'Последнее изменение задачи', text: task.inactivityDays ? `${daysWord(task.inactivityDays)} назад` : 'сегодня', when: dayMonthShort(task.changed) });
  if (task.created) out.push({ tone: 'neutral', icon: 'user', title: `Постановка: ${shortName(canonicalItoName(task.author) || task.author || '—')} → ${shortName(canonicalItoName(task.responsible) || task.responsible)}`, text: '', when: dayMonthShort(task.created) });
  return out;
}

/** Search index for the command palette. */
function searchEntities(snapshot, query, limit = 5) {
  const q = normalizeHeader(query);
  if (!q) return { projects: [], people: [], tasks: [] };
  const has = text => normalizeHeader(text).includes(q);
  const projects = ITO_PROJECTS.filter(p => has(p.name) || has(p.fullName) || (p.aliases || []).some(has)).slice(0, limit);
  const people = ITO_ROSTER.filter(n => has(n) || has(displayName(n))).slice(0, limit);
  const tasks = openTasks(snapshot).filter(t => has(t.title) || has(t.id) || has(t.project)).sort((a, b) => (b.waitingControlDays || b.overdueDays || 0) - (a.waitingControlDays || a.overdueDays || 0)).slice(0, limit);
  return { projects, people, tasks };
}
