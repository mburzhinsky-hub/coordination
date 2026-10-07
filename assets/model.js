'use strict';
function deriveEvents(currentTasks, previousTasks, asOf, allKnownIds = new Set()) {
  const current = new Map(currentTasks.map(t => [String(t.id), t]));
  const previous = new Map(previousTasks.map(t => [String(t.id), t]));
  const events = [];
  const push = (type, severity, task, label, detail = '') => events.push({ id: `${snapshotId(asOf)}:${type}:${task.id}`, type, severity, taskId: task.id, project: task.project, responsible: task.responsible, label, detail, at: asOf.toISOString() });

  for (const task of currentTasks) {
    const prev = previous.get(String(task.id));
    if (!prev) {
      if (allKnownIds.has(String(task.id))) push('TASK_RETURNED', 'watch', task, 'задача вернулась в выгрузку');
      else push('TASK_ADDED', 'info', task, 'новая задача');
      if (task.noDeadline && task.debt === 'none') push('DEADLINE_MISSING_NEW', 'watch', task, 'новая задача без срока');
      if (task.overdue && task.debt === 'none' && task.overdueDays <= 7) push('BECAME_OVERDUE', 'critical', task, `новая просрочка ${task.overdueDays} дн.`);
      continue;
    }
    const deadlineChanged = dateKey(task.deadline) !== dateKey(prev.deadline);
    const responsibleChanged = personKey(task.responsible) !== personKey(prev.responsible);
    const statusChanged = normalizeHeader(task.status) !== normalizeHeader(prev.status);
    const bitrixChanged = dateKey(task.changed) !== dateKey(prev.changed);
    const meaningfulChange = deadlineChanged || responsibleChanged || statusChanged || bitrixChanged;

    if (task.overdue && !prev.overdue) push('BECAME_OVERDUE', 'critical', task, `новая просрочка ${task.overdueDays} дн.`);
    if (!prev.isCompleted && task.isCompleted) push('TASK_COMPLETED', 'success', task, 'задача завершена');
    if (prev.overdue && task.isCompleted) push('OVERDUE_RESOLVED_BY_COMPLETION', 'success', task, 'просрочка закрыта завершением');
    if (deadlineChanged) {
      if (prev.deadline && !task.deadline) push('DEADLINE_REMOVED', 'critical', task, 'срок удалён');
      else if (prev.overdue && !task.overdue && !task.isCompleted) push('OVERDUE_DEADLINE_MOVED', 'watch', task, 'просрочка снята переносом срока');
      else push('DEADLINE_CHANGED', 'watch', task, 'срок изменён');
    }
    if (responsibleChanged) push('RESPONSIBLE_CHANGED', 'watch', task, `сменился ответственный: ${prev.responsible} → ${task.responsible}`);
    if (statusChanged) push('STATUS_CHANGED', 'info', task, `статус: ${prev.status || '—'} → ${task.status || '—'}`);
    if (task.isWaitingControl && !prev.isWaitingControl) push('BECAME_WAITING_CONTROL', 'watch', task, 'результат передан на контроль');
    if (!task.isWaitingControl && prev.isWaitingControl && !task.isCompleted) push('LEFT_CONTROL', 'watch', task, 'задача вышла из контроля — проверить следующий ход');
    if (task.isWaitingControl && prev.waitingControlDays < CONTROL_WATCH_DAYS && task.waitingControlDays >= CONTROL_WATCH_DAYS) push('CONTROL_3_DAYS', 'watch', task, `контроль ${CONTROL_WATCH_DAYS} дня — подключить наблюдение`);
    if (task.isWaitingControl && prev.waitingControlDays < CONTROL_CRITICAL_DAYS && task.waitingControlDays >= CONTROL_CRITICAL_DAYS) push('CONTROL_5_DAYS', 'critical', task, `приёмка ждёт ${CONTROL_CRITICAL_DAYS} дней`);
    if (prev.activity !== 'stale' && task.activity === 'stale') push('BECAME_STALE', 'info', task, 'нет движения больше 14 дней');
    if (prev.debt === 'none' && task.debt === 'chronic') push('BECAME_CHRONIC', 'info', task, 'перешла в накопленный долг');
    if (prev.debt !== 'legacy' && task.debt === 'legacy') push('BECAME_LEGACY', 'info', task, 'перешла в старый долг');
    if (prev.debt !== 'none' && meaningfulChange) push('REACTIVATED', 'critical', task, 'старая задача снова активна');

    const recentChanges = deadlineChangesWithin(task, asOf, DEADLINE_CHURN_DAYS);
    const prevRecentChanges = deadlineChangesWithin(prev, new Date(prev.snapshotAsOf || asOf), DEADLINE_CHURN_DAYS);
    if (recentChanges >= DEADLINE_CHURN_COUNT && prevRecentChanges < DEADLINE_CHURN_COUNT) push('DEADLINE_CHURN', 'critical', task, `срок перенесён ${recentChanges}-й раз за ${DEADLINE_CHURN_DAYS} дней`);
  }

  for (const task of previousTasks) {
    if (!current.has(String(task.id))) push('TASK_REMOVED', 'neutral', task, 'ушла из выгрузки', 'Причина неизвестна: закрытие, фильтр, отложенная задача или изменение структуры.');
  }
  return events;
}

function applyEventsToAttention(tasks, events) {
  const byId = groupBy(events.filter(e => e.severity === 'critical' || e.severity === 'watch'), e => String(e.taskId));
  for (const task of tasks) {
    const taskEvents = byId[String(task.id)] || [];
    if (taskEvents.some(e => e.severity === 'critical')) {
      task.attention = 'critical';
      task.attentionReason = taskEvents.find(e => e.severity === 'critical').label;
    } else if (taskEvents.some(e => e.severity === 'watch') && task.attention === 'none') {
      task.attention = 'watch';
      task.attentionReason = taskEvents.find(e => e.severity === 'watch').label;
    }
    if (task.debt !== 'none' && !taskEvents.some(e => e.type === 'REACTIVATED')) task.attention = 'none';
  }
}

function deriveBallOwner(task) {
  if (task.isCompleted) return { type: 'none', people: [] };
  if (task.isWaitingControl) {
    const people = unique([task.author, ...(task.observers || [])]).filter(Boolean);
    return { type: task.observers?.length ? 'control' : 'author', people };
  }
  return { type: 'responsible', people: task.responsible && task.responsible !== 'Не указан' ? [task.responsible] : [] };
}

function buildAttentionItems(snapshot) {
  const taskMap = new Map(snapshot.tasks.map(t => [String(t.id), t]));
  const eventMap = groupBy((snapshot.events || []).filter(e => e.severity === 'critical' || e.severity === 'watch'), e => String(e.taskId));
  const items = snapshot.tasks.filter(t => t.attention === 'critical' || t.attention === 'watch').map(task => {
    const events = eventMap[String(task.id)] || [];
    const event = events.sort((a,b) => severityWeight(b.severity) - severityWeight(a.severity))[0];
    const severity = task.attention;
    const label = event?.label || task.attentionReason || 'требует внимания';
    return {
      taskId: task.id,
      project: task.project || 'Без проекта',
      label,
      detail: task.title,
      severity,
      when: attentionWhen(task, event),
      owner: task.ballOwner?.people?.join(', ') || task.responsible,
      score: attentionScore(task, event)
    };
  });
  return items.sort((a,b) => b.score - a.score || a.project.localeCompare(b.project));
}

function attentionScore(task, event) {
  let score = task.attention === 'critical' ? 100 : 50;
  if (event?.type === 'REACTIVATED') score += 35;
  if (event?.type === 'BECAME_OVERDUE') score += 30;
  if (event?.type === 'DEADLINE_CHURN') score += 25;
  if (task.dueToday) score += 22;
  if (task.overdue && task.overdueDays <= 7) score += Math.max(0, 15 - task.overdueDays);
  if (task.waitingControlDays >= CONTROL_CRITICAL_DAYS) score += 10;
  return score;
}

function attentionWhen(task, event) {
  if (event?.type === 'BECAME_OVERDUE' || event?.type === 'REACTIVATED' || event?.type === 'DEADLINE_CHURN' || event?.type === 'RESPONSIBLE_CHANGED') return 'Сегодня';
  if (task.dueToday) return 'Сегодня';
  if (task.overdue) return `${task.overdueDays} дн.`;
  if (task.waitingControlDays) return `${task.waitingControlDays} дн.`;
  if (task.deadlineDeltaDays != null && task.deadlineDeltaDays > 0) return `через ${task.deadlineDeltaDays} дн.`;
  return 'Сегодня';
}

function summarizePeopleV2(tasks, presence = {people:{}}, roster = []) {
  return ITO_ROSTER.map(name => {
    const owned = tasks.filter(t => canonicalItoName(t.responsible) === name);
    const active = owned.filter(t => t.loadRelevant);
    const waitingControl = owned.filter(t => t.isWaitingControl && !t.isCompleted);
    const attentionTasks = tasks.filter(t => (t.attention === 'critical' || t.attention === 'watch') && (t.ballOwner?.people || []).some(p => canonicalItoName(p) === name));
    const debt = owned.filter(t => t.debt !== 'none');
    const manual = presenceForPerson(presence, name);
    const topTask = [...active].sort((a,b) => taskFocusRank(b) - taskFocusRank(a))[0];
    const locationProject = manual.mode === 'site' ? itoProjectById(manual.projectId) : null;
    const location = manual.mode === 'site' && locationProject ? `На объекте · ${locationProject.name}` : presenceModeLabel(manual.mode);
    return {
      name,
      activeCount: active.length,
      waitingControlCount: waitingControl.length,
      freshAttentionCount: attentionTasks.length,
      debtCount: debt.length,
      projectCount: unique(active.map(t => t.projectId).filter(Boolean)).length,
      focus: topTask?.title || '—',
      focusTaskId: topTask?.id || '',
      location,
      presenceMode: manual.mode,
      presenceProjectId: manual.projectId
    };
  });
}


function summarizeProjectsV2(tasks, snapshot = state?.currentSnapshot || null) {
  const eventsByProject = groupBy((snapshot?.events || []).filter(e => e.project), e => e.project);
  return ITO_PROJECTS.map(projectDef => {
    const rows = tasks.filter(t => !t.isCompleted && t.projectId === projectDef.id);
    const active = rows.filter(t => t.loadRelevant);
    const waitingControl = rows.filter(t => t.isWaitingControl);
    const attention = rows.filter(t => t.attention === 'critical' || t.attention === 'watch');
    const debt = rows.filter(t => t.debt !== 'none');
    const deadlines = rows.map(t => t.deadline).filter(Boolean).filter(d => d >= new Date(rows[0]?.snapshotAsOf || Date.now())).sort((a,b) => a-b);
    const critical = attention.some(t => t.attention === 'critical');
    const lastMovementCandidates = [
      ...rows.flatMap(t => [t.changed, t.closed].filter(Boolean)),
      ...(eventsByProject[projectDef.name] || []).map(e => new Date(e.at))
    ].filter(Boolean);
    const lastMovementAt = lastMovementCandidates.sort((a,b) => b-a)[0] || null;
    return {
      id: projectDef.id,
      name: projectDef.name,
      fullName: projectDef.fullName,
      type: projectDef.type,
      activeCount: active.length,
      waitingControlCount: waitingControl.length,
      attentionCount: attention.length,
      debtCount: debt.length,
      nextDeadline: deadlines[0] || null,
      lastMovementAt,
      risk: critical ? 'high' : attention.length ? 'medium' : 'none'
    };
  }).sort((a,b) => riskWeight(b.risk) - riskWeight(a.risk) || b.attentionCount - a.attentionCount || a.name.localeCompare(b.name, 'ru'));
}


function deriveProjectStage(rows) {
  if (rows.some(t => t.isWaitingControl)) return 'Приёмка';
  if (rows.some(t => t.isInProgress)) return 'В работе';
  if (rows.some(t => t.plannedStart && t.plannedStart > new Date(t.snapshotAsOf))) return 'Планирование';
  return 'Текущие работы';
}

function collectPeople(tasks) {
  return unique(tasks.flatMap(t => [t.responsible, t.author, ...(t.coExecutors || []), ...(t.observers || [])]).filter(v => v && v !== 'Не указан'));
}

function mergeRoster(tasks, storedRoster = [], presence = {people:{}}) {
  return [...ITO_ROSTER];
}

function taskPlannedHours(task) {
  const raw = task.planned || task.estimate || 0;
  if (!raw) return 0;
  return raw > 1000 ? raw / 3600 : raw > 100 ? raw / 60 : raw;
}

function taskFocusRank(task) {
  let score = 0;
  if (task.dueToday) score += 50;
  if (task.dueSoon) score += 30;
  if (task.isInProgress) score += 20;
  if (task.changed) score += Math.max(0, 10 - task.bitrixInactiveDays);
  return score;
}

function formatHours(hours) { return `${Math.round(hours * 10) / 10} ч`; }


function summarizeOperationalWork(tasks) {
  const rows = tasks.filter(t => !t.isCompleted && t.workstream === 'operational');
  const buckets = groupBy(rows, t => t.operationalBucket || 'Прочее');
  return {
    totalCount: rows.length,
    activeCount: rows.filter(t => t.loadRelevant).length,
    waitingControlCount: rows.filter(t => t.isWaitingControl).length,
    attentionCount: rows.filter(t => t.attention === 'critical' || t.attention === 'watch').length,
    debtCount: rows.filter(t => t.debt !== 'none').length,
    buckets: Object.entries(buckets).map(([name, items]) => ({name, count: items.length})).sort((a,b)=>b.count-a.count)
  };
}

function summarizeDataQuality(snapshot, presence = {people:{}}) {
  const active = snapshot.tasks.filter(t => !t.isCompleted && !t.ignoreForDashboard);
  return {
    noDeadlineCount: active.filter(t => t.noDeadline).length,
    outsideProjectsCount: active.filter(t => t.workstream === 'operational').length,
    projectConflictCount: active.filter(t => t.projectConflict).length,
    missingPresenceCount: ITO_ROSTER.filter(name => !presenceForPerson(presence, name).mode).length
  };
}

function summarizeChanges(snapshot) {
  const events = snapshot.events || [];
  const counts = {
    completed: events.filter(e => e.type === 'TASK_COMPLETED').length,
    added: events.filter(e => e.type === 'TASK_ADDED' || e.type === 'TASK_RETURNED').length,
    newOverdue: events.filter(e => e.type === 'BECAME_OVERDUE').length,
    deadlineMoved: events.filter(e => e.type === 'DEADLINE_CHANGED' || e.type === 'OVERDUE_DEADLINE_MOVED' || e.type === 'DEADLINE_REMOVED' || e.type === 'DEADLINE_CHURN').length,
    control: events.filter(e => e.type === 'BECAME_WAITING_CONTROL').length
  };
  const priority = { critical: 4, watch: 3, success: 2, info: 1, neutral: 0 };
  const meaningful = events.filter(e => !['STATUS_CHANGED','TASK_REMOVED','BECAME_STALE','BECAME_CHRONIC','BECAME_LEGACY'].includes(e.type))
    .sort((a,b) => (priority[b.severity]||0)-(priority[a.severity]||0))
    .slice(0,5);
  return { counts, meaningful };
}

function relativeMovement(value, asOf) {
  if (!value) return 'нет движения';
  const days = Math.max(0, diffDays(new Date(asOf), new Date(value)));
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} дн. назад`;
}
