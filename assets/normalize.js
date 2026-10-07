'use strict';
function buildSnapshot(rows, asOf, fileName, previousSnapshot = null, historySnapshots = [], quality = {errors:[],warnings:[]}) {
  const previousById = new Map((previousSnapshot?.tasks || []).map(task => [String(task.id), task]));
  const allKnownIds = new Set(historySnapshots.flatMap(s => (s.tasks || []).map(t => String(t.id))));
  const allNormalized = rows.map((row, index) => normalizeTask(row, index, asOf, previousById.get(String(getRowValue(row, 'ID', 'ID задачи', 'Идентификатор'))) || null));
  const included = allNormalized.filter(task => !task.ignoreForDashboard);
  const events = deriveEvents(included, previousSnapshot?.tasks || [], asOf, allKnownIds);
  applyEventsToAttention(included, events);
  const snapshot = {
    id: snapshotId(asOf),
    asOf: asOf.toISOString(),
    fileName,
    importedAt: new Date().toISOString(),
    rawCount: rows.length,
    ignoredCount: allNormalized.length - included.length,
    tasks: included,
    events,
    quality
  };
  return snapshot;
}

function validateRows(rows, headers = [], previousSnapshot = null) {
  const errors = [];
  const warnings = [];
  const idHeader = findHeader(headers, ['ID','ID задачи','Идентификатор']);
  const titleHeader = findHeader(headers, ['Название','Задача','Наименование']);
  const statusHeader = findHeader(headers, ['Статус']);
  if (!idHeader) errors.push('В выгрузке нет стабильного ID задачи. История и сравнение между днями недоступны.');
  if (!titleHeader) errors.push('В выгрузке не найден столбец «Название».');
  if (!statusHeader) errors.push('В выгрузке не найден столбец «Статус».');
  const ids = rows.map(row => cleanText(row[idHeader] || '')).filter(Boolean);
  if (idHeader && ids.length !== rows.length) errors.push(`У ${rows.length - ids.length} строк отсутствует ID задачи.`);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) errors.push(`В выгрузке есть повторяющиеся ID: ${unique(duplicates).slice(0,5).join(', ')}.`);
  const responsibleMissing = rows.filter(row => !getRowValue(row, 'Ответственный','Исполнитель')).length;
  if (responsibleMissing && responsibleMissing / Math.max(1, rows.length) > .1) warnings.push(`У ${responsibleMissing} задач не указан ответственный.`);
  if (previousSnapshot?.rawCount && rows.length < previousSnapshot.rawCount * .6) {
    const drop = Math.round((1 - rows.length / previousSnapshot.rawCount) * 100);
    warnings.push(`Количество строк уменьшилось на ${drop}%. Возможно, выгрузка сделана с другим фильтром.`);
  }
  return { errors, warnings, requiresConfirmation: warnings.some(w => /уменьшилось/.test(w)) };
}

function parseBitrixHtmlExport(text) {
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser недоступен в этой среде.');
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(text || ''), 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('В выгрузке не найдена HTML-таблица. Проверьте экспорт задач Bitrix24.');
  const matrix = Array.from(table.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => String(td.textContent || '').replace(/\u00a0/g, ' ').trim())).filter(row => row.some(value => cleanText(value)));
  if (matrix.length < 2) throw new Error('В выгрузке нет строк с задачами.');
  const headerIndex = findHeaderRow(matrix);
  const headers = matrix[headerIndex].map(normalizeHeader);
  const rows = matrix.slice(headerIndex + 1).map(row => {
    const obj = {};
    headers.forEach((header, i) => { obj[header] = header === normalizeHeader('Описание') ? cleanMultilineText(row[i] || '') : cleanText(row[i] || ''); });
    return obj;
  }).filter(row => Object.values(row).some(Boolean));
  return { rows, headers };
}

function findHeaderRow(rows) {
  const hints = ['id','название','статус','ответствен','крайний'];
  let bestIndex = 0, bestScore = -1;
  rows.forEach((row, index) => {
    const joined = normalizeHeader(row.join(' '));
    const score = hints.reduce((sum, hint) => sum + (joined.includes(hint) ? 1 : 0), 0) + Math.min(20, row.length) / 100;
    if (score > bestScore) { bestScore = score; bestIndex = index; }
  });
  return bestIndex;
}

function normalizeTask(row, index, asOf, previousTask = null) {
  const get = (...names) => getRowValue(row, ...names);
  const id = get('ID','ID задачи','Идентификатор');
  const title = get('Название','Задача','Наименование') || `Без названия ${index + 1}`;
  const description = cleanMultilineText(row[normalizeHeader('Описание')] || '');
  const status = get('Статус');
  const responsible = get('Ответственный','Исполнитель') || 'Не указан';
  const creator = get('Создатель');
  const author = get('Постановщик','Автор') || creator || '';
  const coExecutors = splitPeople(get('Соисполнители','Соисполнитель','Участники'));
  const observers = splitPeople(get('Наблюдатели','Наблюдатель'));
  const parentTitle = get('Название базовой задачи','Базовая задача','Родительская задача');
  const parentId = get('ID базовой задачи','ID родительской задачи');
  const projectRaw = get('Проект','Группа','Рабочая группа');
  const assignment = resolveProjectAssignment(projectRaw, parentTitle, title);
  const resolvedProject = assignment.project;
  const projectId = resolvedProject?.id || '';
  const projectFullName = resolvedProject?.fullName || projectRaw || parentTitle || 'Операционная работа';
  const project = resolvedProject?.name || 'Операционная работа';
  const workstream = projectId ? 'project' : 'operational';
  const operationalBucket = projectId ? '' : classifyOperationalBucket(title, parentTitle, projectRaw);
  const deadline = parseBitrixDate(get('Крайний срок','Срок','Дедлайн'));
  const actualStart = parseBitrixDate(get('Дата начала работы','Дата старта','Фактическая дата начала'));
  const plannedStart = parseBitrixDate(get('Планируемая дата начала','Плановая дата начала'));
  const plannedEnd = parseBitrixDate(get('Планируемая дата окончания','Плановая дата окончания'));
  const created = parseBitrixDate(get('Создана','Дата создания'));
  const changed = parseBitrixDate(get('Изменена','Дата изменения','Последняя активность'));
  const closed = parseBitrixDate(get('Закрыта','Дата закрытия'));
  const estimate = parseNumber(get('Оценка','Оценка времени'));
  const spent = parseNumber(get('Затраченное время','Затрачено'));
  const planned = parseNumber(get('Плановая длительность'));
  const normalizedStatus = normalizeHeader(status);
  const isCompleted = /^(завершена|завершено|завершен|закрыта|закрыто|выполнена|выполнено|completed)$/.test(normalizedStatus);
  const isWaitingControl = /контрол/.test(normalizedStatus);
  const isInProgress = /выполня|работ|идет/.test(normalizedStatus);
  const isDeferred = /отлож/.test(normalizedStatus);
  const isProjectContainer = isProjectContainerTitle(title);
  const isIgnoredDaily = IGNORED_DAILY_TASKS.some(name => projectKey(name) === projectKey(title));
  const ignoreForDashboard = isDeferred || isProjectContainer || isIgnoredDaily;
  const noDeadline = !isCompleted && !deadline;
  const overdue = Boolean(!isCompleted && deadline && deadline < asOf);
  const overdueDays = overdue ? Math.max(0, diffDays(asOf, deadline)) : 0;
  const deadlineDeltaDays = deadline ? diffDays(deadline, asOf) : null;
  const dueToday = Boolean(!isCompleted && deadline && sameDay(deadline, asOf));
  const dueSoon = Boolean(!isCompleted && deadline && deadlineDeltaDays > 0 && deadlineDeltaDays <= DUE_SOON_DAYS);
  const signature = JSON.stringify([normalizedStatus, personKey(responsible), dateKey(deadline), dateKey(changed), projectKey(projectFullName)]);
  const unchanged = !previousTask || previousTask.signature === signature;
  const previousAsOf = previousTask?.snapshotAsOf ? new Date(previousTask.snapshotAsOf) : null;
  const stepDays = previousAsOf ? Math.max(0, diffDays(asOf, previousAsOf)) : 0;
  const quietSince = previousTask && unchanged ? new Date(previousTask.quietSince || previousTask.snapshotAsOf) : asOf;
  const observedQuietDays = Math.max(0, diffDays(asOf, quietSince));
  const bitrixInactiveDays = Math.max(0, diffDays(asOf, changed || created || asOf));
  const inactivityDays = Math.max(observedQuietDays, bitrixInactiveDays);
  let controlAgeEstimated = false;
  let controlSince = null;
  if (isWaitingControl) {
    if (previousTask?.isWaitingControl) {
      controlSince = new Date(previousTask.controlSince || previousTask.snapshotAsOf);
      controlAgeEstimated = Boolean(previousTask.controlAgeEstimated);
    } else {
      const fallback = changed && changed <= asOf ? changed : asOf;
      controlSince = fallback;
      controlAgeEstimated = Boolean(changed && changed < asOf);
    }
  }
  const waitingControlDays = isWaitingControl && controlSince ? Math.max(0, diffDays(asOf, controlSince)) : 0;
  let deadlineHistory = Array.isArray(previousTask?.deadlineHistory) ? previousTask.deadlineHistory.map(x => ({...x})) : [];
  if (previousTask && dateKey(previousTask.deadline) !== dateKey(deadline)) deadlineHistory.push({ at: asOf.toISOString(), value: dateKey(deadline) });
  deadlineHistory = deadlineHistory.filter(item => diffDays(asOf, new Date(item.at)) <= 90);
  let activity = inactivityDays > 14 ? 'stale' : inactivityDays > 7 ? 'quiet' : 'fresh';
  let debt = 'none';
  if (!isCompleted) {
    if (overdueDays > LEGACY_OVERDUE_DAYS && inactivityDays > QUIET_LEGACY_DAYS && unchanged) debt = 'legacy';
    else if (overdueDays > CHRONIC_OVERDUE_DAYS && inactivityDays > QUIET_CHRONIC_DAYS && unchanged) debt = 'chronic';
    else if (noDeadline && inactivityDays > QUIET_LEGACY_DAYS) debt = 'chronic';
    else if (isWaitingControl && waitingControlDays > 14 && activity === 'stale') debt = 'chronic';
  }
  let attention = 'none';
  let attentionReason = '';
  if (!isCompleted && debt === 'none') {
    if (dueToday) { attention = 'critical'; attentionReason = 'Срок сегодня'; }
    else if (overdue && overdueDays <= 7) { attention = 'critical'; attentionReason = `Просрочка ${overdueDays} дн.`; }
    else if (isWaitingControl && waitingControlDays >= CONTROL_CRITICAL_DAYS && waitingControlDays <= 14) { attention = 'critical'; attentionReason = `Приёмка ждёт ${waitingControlDays} дн.`; }
    else if (isWaitingControl && waitingControlDays >= CONTROL_WATCH_DAYS) { attention = 'watch'; attentionReason = `Контроль ${waitingControlDays} дн.`; }
    else if (overdue && overdueDays <= 30 && activity === 'fresh') { attention = 'watch'; attentionReason = `Активная просрочка ${overdueDays} дн.`; }
    else if (dueSoon) { attention = 'watch'; attentionReason = `Срок через ${deadlineDeltaDays} дн.`; }
  }
  const ballOwner = deriveBallOwner({ isWaitingControl, responsible, author, observers, attention, noDeadline, isCompleted });
  const loadRelevant = Boolean(!isCompleted && !isDeferred && !isProjectContainer && !isWaitingControl && debt === 'none' && activity !== 'stale');
  return {
    id: String(id || ''), title, description, status, responsible, author, creator, coExecutors, observers,
    parentTitle, parentId, projectRaw, projectId, projectFullName, project, workstream, operationalBucket,
    projectFromField: assignment.projectFromField, projectFromParent: assignment.projectFromParent, projectFromTitle: assignment.projectFromTitle, projectConflict: assignment.projectConflict,
    deadline, actualStart, plannedStart, plannedEnd, created, changed, closed, estimate, spent, planned,
    isCompleted, isWaitingControl, isInProgress, isDeferred, isProjectContainer, isIgnoredDaily, ignoreForDashboard,
    noDeadline, overdue, overdueDays, deadlineDeltaDays, dueToday, dueSoon,
    signature, snapshotAsOf: asOf.toISOString(), quietSince: quietSince.toISOString(), observedQuietDays, bitrixInactiveDays, inactivityDays,
    controlSince: controlSince ? controlSince.toISOString() : null, controlAgeEstimated, waitingControlDays, deadlineHistory,
    activity, debt, attention, attentionReason, ballOwner, loadRelevant
  };
}

