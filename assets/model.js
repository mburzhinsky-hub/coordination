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
    if (prev.overdue && task.isCompleted) push('OVERDUE_RESOLVED_BY_COMPLETION', 'success', task, 'просрочка закрыта завершением');
    if (deadlineChanged) {
      if (prev.deadline && !task.deadline) push('DEADLINE_REMOVED', 'critical', task, 'срок удалён');
      else if (prev.overdue && !task.overdue && !task.isCompleted) push('OVERDUE_DEADLINE_MOVED', 'watch', task, 'просрочка снята переносом срока');
      else push('DEADLINE_CHANGED', 'watch', task, 'срок изменён');
    }
    if (responsibleChanged) push('RESPONSIBLE_CHANGED', 'watch', task, `сменился ответственный: ${prev.responsible} → ${task.responsible}`);
    if (statusChanged) push('STATUS_CHANGED', 'info', task, `статус: ${prev.status || '—'} → ${task.status || '—'}`);
    if (task.isWaitingControl && !prev.isWaitingControl) push('BECAME_WAITING_CONTROL', 'watch', task, 'результат передан на контроль');
    if (!task.isWaitingControl && prev.isWaitingControl) push('LEFT_CONTROL', 'success', task, 'задача вышла из контроля');
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
  const people = [...ITO_ROSTER];
  return people.map(name => {
    const owned = tasks.filter(t => canonicalItoName(t.responsible) === name);
    const live = owned.filter(t => t.loadRelevant);
    const attentionTasks = tasks.filter(t => (t.attention === 'critical' || t.attention === 'watch') && (t.ballOwner?.people || []).some(p => canonicalItoName(p) === name));
    const debtCount = owned.filter(t => t.debt !== 'none').length;
    const manual = presenceForPerson(presence, name);
    const taskProjects = unique(live.map(t => t.projectId).filter(Boolean));
    const projectCount = taskProjects.length;
    const hours = sum(live.map(t => taskPlannedHours(t)));
    const topTask = [...live].sort((a,b) => taskFocusRank(b) - taskFocusRank(a))[0];
    const locationProject = manual.mode === 'site' ? itoProjectById(manual.projectId) : null;
    const location = manual.mode === 'site' && locationProject ? `На объекте · ${locationProject.name}` : presenceModeLabel(manual.mode);
    const focus = topTask?.title || '—';
    let status = 'normal';
    if (hours >= 32 || live.length >= 7) status = 'overload';
    else if (attentionTasks.length) status = 'risk';
    else if (manual.mode === 'vacation') status = 'normal';
    else if (live.length <= 2) status = 'reserve';
    return { name, liveCount: live.length, hours, attentionCount: attentionTasks.length, debtCount, projectCount, focus, location, presenceMode: manual.mode, presenceProjectId: manual.projectId, status };
  });
}

function summarizeProjectsV2(tasks) {
  return ITO_PROJECTS.map(projectDef => {
    const rows = tasks.filter(t => !t.isCompleted && t.projectId === projectDef.id);
    const live = rows.filter(t => t.loadRelevant);
    const attention = rows.filter(t => t.attention === 'critical' || t.attention === 'watch');
    const debt = rows.filter(t => t.debt !== 'none');
    const critical = attention.filter(t => t.attention === 'critical').length;
    const responsible = mode((live.length ? live : rows).map(t => canonicalItoName(t.responsible)).filter(Boolean)) || '—';
    const peopleCount = unique(live.map(t => canonicalItoName(t.responsible)).filter(Boolean)).length;
    const now = rows[0]?.snapshotAsOf ? new Date(rows[0].snapshotAsOf) : new Date();
    const deadlines = rows.map(t => t.deadline).filter(Boolean).filter(d => d >= now).sort((a,b) => a-b);
    const stage = rows.length ? deriveProjectStage(rows) : 'Нет активных задач';
    const risk = critical ? 'high' : attention.length ? 'medium' : 'none';
    return {
      id: projectDef.id,
      name: projectDef.name,
      fullName: projectDef.fullName,
      type: projectDef.type,
      responsible,
      stage,
      liveTasks: live.length,
      peopleCount,
      nextDeadline: deadlines[0] || null,
      attentionCount: attention.length,
      debtCount: debt.length,
      risk
    };
  }).sort((a,b) => riskWeight(b.risk) - riskWeight(a.risk) || b.liveTasks - a.liveTasks || a.name.localeCompare(b.name, 'ru'));
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

