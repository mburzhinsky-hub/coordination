'use strict';

const state = {
  manifest: null,
  exportName: null,
  exportDate: new Date(),
  tasks: [],
  allRows: [],
  previousTasks: [],
  previousExportName: null,
  localExports: [],
  ignoredCount: 0,
  filters: {
    responsible: '',
    project: '',
    status: '',
    risk: '',
    search: ''
  }
};

const settings = {
  stale7Days: 7,
  stale14Days: 14,
  dueSoonDays: 3,
  workload: {
    active: 1,
    overdue: 2.5,
    dueToday: 2,
    dueSoon: 1.5,
    inProgress: 1.2,
    waitingControl: 0.8,
    noDeadline: 0.7
  }
};


const LOCAL_EXPORTS_STORAGE_KEY = 'bitrixTaskDashboard.localExports.v1';

const PROJECT_CONTAINER_TITLES = [
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

const IGNORED_DAILY_TASK_TITLES = [
  'Ежедневная проверка статусов закупок/договоров',
  'Ежедневный контроль выполнения задач'
];

const PROJECT_CONTAINER_KEYS = new Set(PROJECT_CONTAINER_TITLES.map(projectKey));
const IGNORED_DAILY_TASK_KEYS = new Set(IGNORED_DAILY_TASK_TITLES.map(projectKey));

const el = (id) => document.getElementById(id);

window.addEventListener('DOMContentLoaded', init);

async function init() {
  bindUi();
  await loadManifest();
}

function bindUi() {
  document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  ['filterResponsible', 'filterProject', 'filterStatus', 'filterRisk'].forEach(id => {
    el(id).addEventListener('change', () => {
      const map = {
        filterResponsible: 'responsible',
        filterProject: 'project',
        filterStatus: 'status',
        filterRisk: 'risk'
      };
      state.filters[map[id]] = el(id).value;
      renderAll();
    });
  });

  el('searchBox').addEventListener('input', () => {
    state.filters.search = el('searchBox').value.trim().toLowerCase();
    renderAll();
  });

  el('exportSelect').addEventListener('change', async () => {
    await loadExport(el('exportSelect').value);
  });

  el('reloadBtn').addEventListener('click', async () => {
    await loadExport(state.exportName);
  });

  el('uploadInput').addEventListener('change', async (event) => {
    await handleUploadFiles(event.target.files);
    event.target.value = '';
  });

  el('clearLocalBtn').addEventListener('click', async () => {
    clearLocalExports();
    await loadManifest();
  });

  document.querySelectorAll('[data-export]').forEach(button => {
    button.addEventListener('click', () => exportCsv(button.dataset.export));
  });
}

async function loadManifest(preferredFile = null) {
  try {
    loadLocalExports();
    let repoFiles = [];

    try {
      const res = await fetch(cacheBust('data/exports.json'));
      if (!res.ok) throw new Error(`Не найден data/exports.json (${res.status})`);
      state.manifest = await res.json();
      repoFiles = [...(state.manifest.files || [])].filter(Boolean);
    } catch (manifestError) {
      state.manifest = { files: [] };
      console.warn('Не удалось загрузить manifest:', manifestError);
    }

    const localFiles = state.localExports.map(item => item.name).filter(Boolean);
    const files = unique([...repoFiles, ...localFiles]).sort(compareExportNames);
    if (!files.length) {
      showError('Нет выгрузок. Добавьте файл через кнопку “Загрузить выгрузку” или положите файл в data/raw/ и data/exports.json.');
      return;
    }

    el('exportSelect').innerHTML = files.map(file => {
      const source = getLocalExport(file) ? ' · с сайта' : '';
      return `<option value="${escapeAttr(file)}">${escapeHtml(file + source)}</option>`;
    }).join('');
    const latest = preferredFile && files.includes(preferredFile) ? preferredFile : files[files.length - 1];
    el('exportSelect').value = latest;
    await loadExport(latest);
  } catch (error) {
    showError(error.message);
  }
}

async function loadExport(fileName) {
  try {
    state.exportName = fileName;
    state.exportDate = parseDateFromFileName(fileName) || new Date();
    showStatus(`Загружается выгрузка ${fileName}...`);

    const text = await fetchExportText(fileName);
    state.tasks = normalizeRows(parseBitrixHtmlExport(text), state.exportDate, fileName);
    state.ignoredCount = state.tasks.ignoredCount || 0;
    state.allRows = [...state.tasks];

    await loadPreviousExport(fileName);
    fillFilters();
    renderAll();
    showStatus(`Загружено задач в расчет: ${state.tasks.length}. Исключено: ${state.ignoredCount} (отложенные, проектные контейнеры, ежедневные задачи). Расчетная дата контроля: ${formatDateTime(state.exportDate)}.`);
  } catch (error) {
    showError(error.message);
  }
}

async function loadPreviousExport(currentFile) {
  state.previousTasks = [];
  state.previousExportName = null;
  const files = unique([...(state.manifest.files || []), ...state.localExports.map(item => item.name)]).filter(Boolean).sort(compareExportNames);
  const idx = files.indexOf(currentFile);
  if (idx <= 0) return;
  const previousFile = files[idx - 1];
  state.previousExportName = previousFile;
  try {
    const text = await fetchExportText(previousFile);
    const previousDate = parseDateFromFileName(previousFile) || state.exportDate;
    state.previousTasks = normalizeRows(parseBitrixHtmlExport(text), previousDate, previousFile);
  } catch (error) {
    console.warn('Не удалось загрузить предыдущую выгрузку:', error);
  }
}

async function fetchText(url) {
  const res = await fetch(cacheBust(url));
  if (!res.ok) throw new Error(`Не удалось открыть ${url}. Проверь, что файл есть в репозитории и добавлен в data/exports.json.`);
  return await res.text();
}

async function fetchExportText(fileName) {
  const local = getLocalExport(fileName);
  if (local) return local.text;
  return await fetchText(`data/raw/${fileName}`);
}

function loadLocalExports() {
  try {
    const raw = localStorage.getItem(LOCAL_EXPORTS_STORAGE_KEY);
    state.localExports = raw ? JSON.parse(raw).filter(item => item && item.name && item.text) : [];
  } catch (error) {
    console.warn('Не удалось прочитать локальные выгрузки:', error);
    state.localExports = [];
  }
}

function saveLocalExports() {
  try {
    localStorage.setItem(LOCAL_EXPORTS_STORAGE_KEY, JSON.stringify(state.localExports));
  } catch (error) {
    showStatus('Выгрузка загружена в текущую сессию, но браузер не смог сохранить ее надолго. Возможно, файл слишком большой.');
  }
}

function getLocalExport(fileName) {
  return state.localExports.find(item => item.name === fileName);
}

async function handleUploadFiles(fileList) {
  const files = Array.from(fileList || []).filter(file => /\.(xls|html?|txt)$/i.test(file.name));
  if (!files.length) {
    showError('Выберите выгрузку Битрикс24 в формате .xls.');
    return;
  }

  let lastUploadedName = '';
  for (const file of files) {
    const text = await readFileAsText(file);
    const name = normalizeUploadFileName(file.name);
    lastUploadedName = name;
    state.localExports = state.localExports.filter(item => item.name !== name);
    state.localExports.push({ name, text, savedAt: new Date().toISOString() });
  }

  state.localExports.sort((a, b) => compareExportNames(a.name, b.name));
  const lastUploaded = state.localExports.find(item => item.name === lastUploadedName);
  state.localExports = state.localExports.filter(item => item.name !== lastUploadedName).slice(-11);
  if (lastUploaded) state.localExports.push(lastUploaded);
  state.localExports.sort((a, b) => compareExportNames(a.name, b.name));
  saveLocalExports();
  await loadManifest(lastUploadedName);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл.'));
    reader.readAsText(file);
  });
}

function normalizeUploadFileName(name) {
  const safe = cleanText(name).replace(/[^0-9A-Za-zА-Яа-яЁё_.\-]/g, '_');
  return safe || `tasks_${new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')}.xls`;
}

function clearLocalExports() {
  state.localExports = [];
  try { localStorage.removeItem(LOCAL_EXPORTS_STORAGE_KEY); } catch (_) {}
}

function cacheBust(path) {
  return `${path}?v=${Date.now()}`;
}

function parseBitrixHtmlExport(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');
  const table = doc.querySelector('table');
  if (!table) throw new Error('В выгрузке не найдена HTML-таблица. Проверь экспорт из Битрикс24.');

  const rows = Array.from(table.querySelectorAll('tr'))
    .map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => cleanText(td.textContent)))
    .filter(row => row.some(Boolean));

  if (rows.length < 2) throw new Error('В выгрузке нет строк с задачами.');

  const headerIndex = findHeaderRow(rows);
  const headers = rows[headerIndex].map(normalizeHeader);
  const dataRows = rows.slice(headerIndex + 1);

  return dataRows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cleanText(row[i] || ''); });
    return obj;
  }).filter(obj => Object.values(obj).some(Boolean));
}

function findHeaderRow(rows) {
  const requiredHints = ['название', 'статус', 'ответственный', 'крайний'];
  let bestIndex = 0;
  let bestScore = -1;
  rows.forEach((row, idx) => {
    const joined = row.join(' ').toLowerCase();
    const score = requiredHints.reduce((acc, hint) => acc + (joined.includes(hint) ? 1 : 0), 0) + Math.min(row.length, 12) / 100;
    if (score > bestScore) { bestScore = score; bestIndex = idx; }
  });
  return bestIndex;
}

function normalizeRows(rows, asOf, exportFile) {
  const normalized = rows
    .map((row, index) => normalizeTask(row, index, asOf, exportFile))
    .filter(task => task.title || task.id);
  const included = normalized.filter(task => !task.ignoreForDashboard);
  included.ignoredCount = normalized.length - included.length;
  return included;
}

function normalizeTask(row, index, asOf, exportFile) {
  const get = (...names) => {
    for (const name of names) {
      const value = row[normalizeHeader(name)];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };

  const id = get('ID', 'ID задачи', 'Идентификатор') || `row-${index + 1}`;
  const title = get('Название', 'Задача', 'Наименование');
  const status = get('Статус');
  const responsible = get('Ответственный', 'Исполнитель') || 'Не указан';
  const creator = get('Создатель');
  const author = get('Постановщик', 'Автор') || creator;
  const parentTitle = get('Название базовой задачи', 'Базовая задача', 'Родительская задача');
  const parentId = get('ID базовой задачи', 'ID родительской задачи');
  const projectRaw = get('Проект', 'Группа', 'Рабочая группа');
  const project = parentTitle || projectRaw || 'Без проекта / без родительской задачи';
  const deadline = parseBitrixDate(get('Крайний срок', 'Срок', 'Дедлайн'));
  const created = parseBitrixDate(get('Создана', 'Дата создания'));
  const changed = parseBitrixDate(get('Изменена', 'Дата изменения', 'Последняя активность'));
  const closed = parseBitrixDate(get('Закрыта', 'Дата закрытия'));
  const priority = get('Приоритет');
  const estimate = parseNumber(get('Оценка', 'Оценка времени'));
  const spent = parseNumber(get('Затраченное время', 'Затрачено'));
  const planned = parseNumber(get('Плановая длительность'));

  const normalizedStatus = status.toLowerCase();
  const isCompleted = Boolean(closed) || /заверш|закрыт|выполнен/.test(normalizedStatus);
  const isWaitingControl = /контрол/.test(normalizedStatus);
  const isInProgress = /выполня|работ|идет|идёт/.test(normalizedStatus);
  const isDeferred = /отлож/.test(normalizedStatus);
  const isProjectContainer = PROJECT_CONTAINER_KEYS.has(projectKey(title));
  const isIgnoredDaily = IGNORED_DAILY_TASK_KEYS.has(projectKey(title));
  const ignoreForDashboard = isDeferred || isProjectContainer || isIgnoredDaily;
  const noDeadline = !deadline;
  const overdue = !isCompleted && deadline && deadline.getTime() < asOf.getTime();
  const deadlineDeltaDays = deadline ? diffDays(deadline, asOf) : null;
  const dueToday = !isCompleted && deadline && sameDay(deadline, asOf) && !overdue;
  const dueSoon = !isCompleted && deadline && deadlineDeltaDays !== null && deadlineDeltaDays >= 0 && deadlineDeltaDays <= settings.dueSoonDays;
  const lastActivity = changed || created;
  const staleDays = lastActivity ? Math.max(0, Math.floor((asOf - lastActivity) / 86400000)) : null;
  const stale7 = staleDays !== null && staleDays > settings.stale7Days;
  const stale14 = staleDays !== null && staleDays > settings.stale14Days;
  const noParent = !parentTitle && !parentId;
  const overdueDays = overdue ? Math.max(0, Math.ceil((asOf - deadline) / 86400000)) : 0;

  const task = {
    id, title, status, responsible, author, creator, parentTitle, parentId, project,
    deadline, created, changed, closed, priority, estimate, spent, planned,
    exportFile, exportDate: asOf,
    isCompleted, isWaitingControl, isInProgress, isDeferred, isProjectContainer, isIgnoredDaily, ignoreForDashboard,
    noDeadline, overdue, overdueDays, dueToday, dueSoon, deadlineDeltaDays,
    lastActivity, staleDays, stale7, stale14, noParent
  };

  const risk = calculateRisk(task);
  task.riskScore = risk.score;
  task.riskColor = risk.color;
  task.riskLabel = risk.label;
  task.recommendedAction = recommendAction(task);
  task.systemComment = buildSystemComment(task);
  return task;
}

function calculateRisk(task) {
  let score = 0;
  if (task.overdue) score += 50 + Math.min(30, task.overdueDays);
  if (task.dueToday) score += 35;
  if (task.dueSoon && !task.dueToday) score += 25;
  if (task.isWaitingControl) score += 20;
  if (task.noDeadline) score += 15;
  if (task.stale7) score += 10;
  if (task.stale14) score += 20;
  if (task.noParent) score += 10;
  score = Math.min(100, Math.round(score));

  if (score >= 80) return { score, color: 'red', label: 'Красный' };
  if (score >= 50) return { score, color: 'orange', label: 'Оранжевый' };
  if (score >= 25) return { score, color: 'yellow', label: 'Желтый' };
  if (score >= 1) return { score, color: 'gray', label: 'Серый' };
  return { score, color: 'green', label: 'Зеленый' };
}

function recommendAction(task) {
  if (task.overdue) return 'Запросить результат, блокер или новый срок';
  if (task.isWaitingControl) return 'Проверить результат и закрыть или вернуть на доработку';
  if (task.noDeadline) return 'Назначить крайний срок';
  if (task.stale14) return 'Запросить актуальный статус';
  if (task.noParent) return 'Привязать к проекту / родительской задаче';
  if (task.dueToday) return 'Проверить готовность до конца дня';
  if (task.dueSoon) return 'Проверить риски срока заранее';
  return 'Без срочного действия';
}

function buildSystemComment(task) {
  const parts = [];
  if (task.overdue) parts.push(`просрочено ${task.overdueDays} дн.`);
  if (task.noDeadline) parts.push('нет срока');
  if (task.stale14) parts.push(`нет активности ${task.staleDays} дн.`);
  if (task.noParent) parts.push('нет родителя');
  if (task.isWaitingControl) parts.push('ждёт контроля');
  return parts.join('; ') || 'норма';
}

function renderAll() {
  renderUploadReport();
  const tasks = getFilteredTasks();
  renderKpis(tasks);
  renderPushList(tasks);
  renderPeople(tasks);
  renderProjects(tasks);
  renderControl(tasks);
  renderHygiene(tasks);
  renderDynamic();
  renderAllTasks(tasks);
}

function getFilteredTasks() {
  return state.tasks.filter(task => {
    if (state.filters.responsible && task.responsible !== state.filters.responsible) return false;
    if (state.filters.project && task.project !== state.filters.project) return false;
    if (state.filters.status && task.status !== state.filters.status) return false;
    if (state.filters.risk && task.riskColor !== state.filters.risk) return false;
    if (state.filters.search) {
      const haystack = [task.title, task.project, task.responsible, task.status, task.author, task.id].join(' ').toLowerCase();
      if (!haystack.includes(state.filters.search)) return false;
    }
    return true;
  });
}

function renderUploadReport() {
  const target = el('uploadReportContent');
  if (!target) return;

  const report = buildExportReport();
  const compareText = report.hasPrevious
    ? `Сравнение с предыдущей выгрузкой: ${report.previousFile}`
    : 'Предыдущая выгрузка не найдена — показан базовый срез без динамики.';

  const movementHtml = report.hasPrevious
    ? tableHtml(report.movementRows.slice(0, 80), [
      ['Событие', r => badge(r.type, r.color)],
      ['Деталь', r => escapeHtml(r.detail)],
      ['Ответственный', r => escapeHtml(r.responsible)],
      ['Проект', r => `<div class="project-name">${escapeHtml(r.project)}</div>`],
      ['Задача', r => `<div class="task-title">${escapeHtml(r.title)}</div><div class="small">ID: ${escapeHtml(r.id)}</div>`],
      ['Статус', r => escapeHtml(r.status)],
      ['Срок', r => formatDateTime(r.deadline)],
      ['Риск', r => r.riskScore ? `${r.riskScore}<div class="small">${escapeHtml(r.riskLabel)}</div>` : '']
    ])
    : '<div class="status-box">Для журнала движения нужна минимум одна предыдущая выгрузка. После следующей загрузки здесь появятся новые задачи, снятые просрочки, смены сроков, ответственных и статусов.</div>';

  target.innerHTML = `
    <div class="report-meta">
      <span><b>Текущая выгрузка:</b> ${escapeHtml(report.currentFile || 'не выбрана')}</span>
      <span><b>Дата контроля:</b> ${formatDateTime(state.exportDate)}</span>
      <span><b>${escapeHtml(compareText)}</b></span>
    </div>

    <div class="report-kpi-grid">
      ${reportMetricHtml('Всего задач', report.metrics.total, reportDelta(report, 'total'), 'В расчете после исключений', 'blue', 'neutral')}
      ${reportMetricHtml('Новые задачи', report.diff.added.length, null, 'Появились с прошлого среза', report.diff.added.length ? 'blue' : 'green')}
      ${reportMetricHtml('Ушли из выгрузки', report.diff.removed.length, null, 'Вероятно закрыты или не попали в фильтр Битрикс24', report.diff.removed.length ? 'green' : 'gray')}
      ${reportMetricHtml('Новые просрочки', report.diff.newOverdue.length, null, 'Стали просроченными между срезами', report.diff.newOverdue.length ? 'red' : 'green')}
      ${reportMetricHtml('Просрочки сняты', report.diff.resolvedOverdue.length, null, 'Были просрочены, теперь нет', report.diff.resolvedOverdue.length ? 'green' : 'gray')}
      ${reportMetricHtml('Ждёт контроля', report.metrics.waitingControl, reportDelta(report, 'waitingControl'), 'Нужно принять или вернуть', report.metrics.waitingControl ? 'blue' : 'green')}
      ${reportMetricHtml('Красный/оранжевый риск', report.metrics.highRisk, reportDelta(report, 'highRisk'), 'Задачи с риском 50+', report.metrics.highRisk ? 'orange' : 'green')}
      ${reportMetricHtml('Без срока', report.metrics.noDeadline, reportDelta(report, 'noDeadline'), 'Нужно назначить дедлайн', report.metrics.noDeadline ? 'gray' : 'green')}
      ${reportMetricHtml('Средний риск', report.metrics.avgRisk, reportDelta(report, 'avgRisk'), 'Средний индекс риска', riskColor(report.metrics.avgRisk), 'neutral')}
    </div>

    <div class="report-layout">
      <div class="report-panel">
        <h3>Управленческое резюме</h3>
        <ul class="insight-list">${report.insights.map(item => `<li class="${escapeAttr(item.color || '')}">${escapeHtml(item.text)}</li>`).join('')}</ul>
      </div>
      <div class="report-panel">
        <h3>Топ рисковых задач</h3>
        ${tableHtml(report.topRiskTasks, [
          ['Риск', t => badge(t.riskLabel, t.riskColor) + `<div class="small">${t.riskScore}</div>`],
          ['Задача', t => `<div class="task-title">${escapeHtml(t.title)}</div>`],
          ['Ответственный', t => escapeHtml(t.responsible)],
          ['Срок', t => formatDateTime(t.deadline)],
          ['Действие', t => escapeHtml(t.recommendedAction)]
        ])}
      </div>
    </div>

    <div class="report-layout">
      <div class="report-panel">
        <h3>Где проседает по людям</h3>
        ${tableHtml(report.peopleRows.slice(0, 8), [
          ['Ответственный', p => escapeHtml(p.responsible)],
          ['Всего', p => formatDeltaValue(p.total, p.totalDelta)],
          ['Просрочено', p => formatDeltaValue(p.overdue, p.overdueDelta, true)],
          ['Загрузка', p => `${p.workloadScore.toFixed(1)}<div class="small">${escapeHtml(p.workloadCategory)}</div>`],
          ['Доступность', p => badge(p.availabilityCategory, p.availabilityColor) + `<div class="small">${p.availabilityScore}</div>`],
          ['Рекомендация', p => escapeHtml(p.recommendation)]
        ])}
      </div>
      <div class="report-panel">
        <h3>Где проседает по проектам</h3>
        ${tableHtml(report.projectRows.slice(0, 8), [
          ['Проект', p => `<div class="project-name">${escapeHtml(p.project)}</div>`],
          ['Всего', p => formatDeltaValue(p.total, p.totalDelta)],
          ['Просрочено', p => formatDeltaValue(p.overdue, p.overdueDelta, true)],
          ['Ждёт контроля', p => formatDeltaValue(p.waitingControl, p.waitingControlDelta, true)],
          ['Риск', p => formatDeltaValue(p.riskScore, p.riskDelta, true)]
        ])}
      </div>
    </div>

    <div class="report-panel report-panel-full">
      <h3>Журнал движения задач</h3>
      <p class="muted">Показывает события между текущей и предыдущей выгрузкой: новые задачи, исчезнувшие задачи, новые и снятые просрочки, смену статусов, сроков, ответственных и резкие изменения риска.</p>
      <div class="table-wrap">${movementHtml}</div>
    </div>
  `;
}

function buildExportReport() {
  const current = state.tasks || [];
  const previous = state.previousTasks || [];
  const hasPrevious = previous.length > 0;
  const diff = compareTaskSnapshots(current, previous);
  const metrics = buildMetricSnapshot(current);
  const previousMetrics = hasPrevious ? buildMetricSnapshot(previous) : null;
  const peopleRows = buildReportPeopleRows(current, previous);
  const projectRows = buildReportProjectRows(current, previous);
  const movementRows = buildMovementRows(diff);
  const topRiskTasks = [...current]
    .filter(t => t.riskScore > 0)
    .sort((a, b) => b.riskScore - a.riskScore || b.overdueDays - a.overdueDays)
    .slice(0, 8);

  const report = {
    currentFile: state.exportName,
    previousFile: state.previousExportName,
    hasPrevious,
    metrics,
    previousMetrics,
    diff,
    movementRows,
    peopleRows,
    projectRows,
    topRiskTasks,
    insights: []
  };
  report.insights = buildReportInsights(report);
  return report;
}

function buildMetricSnapshot(tasks) {
  return {
    total: tasks.length,
    overdue: count(tasks, t => t.overdue),
    dueToday: count(tasks, t => t.dueToday),
    dueSoon: count(tasks, t => t.dueSoon),
    waitingControl: count(tasks, t => t.isWaitingControl),
    noDeadline: count(tasks, t => t.noDeadline),
    stale14: count(tasks, t => t.stale14),
    redRisk: count(tasks, t => t.riskColor === 'red'),
    highRisk: count(tasks, t => t.riskScore >= 50),
    avgRisk: Math.round(avg(tasks.map(t => t.riskScore)))
  };
}

function compareTaskSnapshots(current, previous) {
  const currentById = mapByStableId(current);
  const prevById = mapByStableId(previous);
  const currentIds = new Set(Object.keys(currentById));
  const prevIds = new Set(Object.keys(prevById));
  const commonIds = [...currentIds].filter(id => prevIds.has(id));

  return {
    added: [...currentIds].filter(id => !prevIds.has(id)).map(id => currentById[id]),
    removed: [...prevIds].filter(id => !currentIds.has(id)).map(id => prevById[id]),
    newOverdue: commonIds.filter(id => currentById[id].overdue && !prevById[id].overdue).map(id => ({ current: currentById[id], previous: prevById[id] })),
    resolvedOverdue: commonIds.filter(id => !currentById[id].overdue && prevById[id].overdue).map(id => ({ current: currentById[id], previous: prevById[id] })),
    becameControl: commonIds.filter(id => currentById[id].isWaitingControl && !prevById[id].isWaitingControl).map(id => ({ current: currentById[id], previous: prevById[id] })),
    leftControl: commonIds.filter(id => !currentById[id].isWaitingControl && prevById[id].isWaitingControl).map(id => ({ current: currentById[id], previous: prevById[id] })),
    statusChanged: commonIds.filter(id => currentById[id].status !== prevById[id].status).map(id => ({ current: currentById[id], previous: prevById[id] })),
    deadlineChanged: commonIds.filter(id => dateKey(currentById[id].deadline) !== dateKey(prevById[id].deadline)).map(id => ({ current: currentById[id], previous: prevById[id] })),
    responsibleChanged: commonIds.filter(id => currentById[id].responsible !== prevById[id].responsible).map(id => ({ current: currentById[id], previous: prevById[id] })),
    riskUp: commonIds.filter(id => currentById[id].riskScore - prevById[id].riskScore >= 25).map(id => ({ current: currentById[id], previous: prevById[id] })),
    riskDown: commonIds.filter(id => prevById[id].riskScore - currentById[id].riskScore >= 25).map(id => ({ current: currentById[id], previous: prevById[id] }))
  };
}

function buildMovementRows(diff) {
  const rows = [];
  const push = (priority, type, color, task, previous, detail) => {
    rows.push({
      priority,
      type,
      color,
      id: task.id,
      title: task.title,
      responsible: task.responsible,
      project: task.project,
      status: task.status,
      deadline: task.deadline,
      riskScore: task.riskScore,
      riskLabel: task.riskLabel,
      detail
    });
  };

  diff.newOverdue.forEach(({ current, previous }) => push(1, 'Новая просрочка', 'red', current, previous, `Было: ${formatDateTime(previous.deadline) || 'без срока'}; стало просрочено на ${current.overdueDays} дн.`));
  diff.added.forEach(task => push(2, 'Новая задача', 'blue', task, null, 'Появилась в текущей выгрузке'));
  diff.becameControl.forEach(({ current, previous }) => push(3, 'Стала ждать контроля', 'blue', current, previous, `Статус: ${previous.status || 'пусто'} → ${current.status || 'пусто'}`));
  diff.riskUp.forEach(({ current, previous }) => push(4, 'Риск вырос', 'orange', current, previous, `Риск: ${previous.riskScore} → ${current.riskScore}`));
  diff.deadlineChanged.forEach(({ current, previous }) => push(5, 'Изменился срок', 'yellow', current, previous, `Срок: ${formatDateTime(previous.deadline) || 'пусто'} → ${formatDateTime(current.deadline) || 'пусто'}`));
  diff.responsibleChanged.forEach(({ current, previous }) => push(6, 'Сменился ответственный', 'yellow', current, previous, `${previous.responsible || 'пусто'} → ${current.responsible || 'пусто'}`));
  diff.statusChanged.forEach(({ current, previous }) => push(7, 'Изменился статус', 'gray', current, previous, `${previous.status || 'пусто'} → ${current.status || 'пусто'}`));
  diff.resolvedOverdue.forEach(({ current, previous }) => push(8, 'Просрочка снята', 'green', current, previous, `Было просрочено на ${previous.overdueDays} дн.; текущий срок: ${formatDateTime(current.deadline) || 'без срока'}`));
  diff.leftControl.forEach(({ current, previous }) => push(9, 'Вышла из контроля', 'green', current, previous, `Статус: ${previous.status || 'пусто'} → ${current.status || 'пусто'}`));
  diff.riskDown.forEach(({ current, previous }) => push(10, 'Риск снизился', 'green', current, previous, `Риск: ${previous.riskScore} → ${current.riskScore}`));
  diff.removed.forEach(task => push(11, 'Ушла из выгрузки', 'green', task, task, 'Нет в текущей выгрузке: вероятно закрыта, отложена, стала контейнером или не попала в фильтр экспорта'));

  return rows.sort((a, b) => a.priority - b.priority || b.riskScore - a.riskScore || String(a.title).localeCompare(String(b.title)));
}

function buildReportPeopleRows(current, previous) {
  const prevMap = Object.fromEntries(summarizePeople(previous).map(p => [p.responsible, p]));
  return summarizePeople(current).map(p => {
    const prev = prevMap[p.responsible] || {};
    return {
      ...p,
      totalDelta: p.total - (prev.total || 0),
      overdueDelta: p.overdue - (prev.overdue || 0),
      workloadDelta: p.workloadScore - (prev.workloadScore || 0),
      availabilityDelta: p.availabilityScore - (prev.availabilityScore || 0)
    };
  }).sort((a, b) => b.overdue - a.overdue || b.overdueDelta - a.overdueDelta || b.workloadScore - a.workloadScore || a.availabilityScore - b.availabilityScore);
}

function buildReportProjectRows(current, previous) {
  const prevMap = Object.fromEntries(summarizeProjects(previous).map(p => [p.project, p]));
  return summarizeProjects(current).map(p => {
    const prev = prevMap[p.project] || {};
    return {
      ...p,
      totalDelta: p.total - (prev.total || 0),
      overdueDelta: p.overdue - (prev.overdue || 0),
      waitingControlDelta: p.waitingControl - (prev.waitingControl || 0),
      riskDelta: p.riskScore - (prev.riskScore || 0)
    };
  }).sort((a, b) => b.overdue - a.overdue || b.riskDelta - a.riskDelta || b.riskScore - a.riskScore || b.total - a.total);
}

function buildReportInsights(report) {
  const insights = [];
  const m = report.metrics;
  const pm = report.previousMetrics;
  const d = report.diff;

  if (!report.hasPrevious) {
    insights.push({ color: 'blue', text: 'Это базовый срез. Следующая выгрузка включит полноценную динамику: новые задачи, закрытия, смену сроков, ответственных и статусов.' });
  } else {
    const totalDelta = m.total - pm.total;
    insights.push({ color: totalDelta > 0 ? 'blue' : totalDelta < 0 ? 'green' : 'gray', text: `Объем активных задач: ${m.total} (${formatSigned(totalDelta)} к прошлой выгрузке).` });

    if (d.newOverdue.length) insights.push({ color: 'red', text: `Появились новые просрочки: ${d.newOverdue.length}. Их нужно разобрать первыми.` });
    if (d.resolvedOverdue.length) insights.push({ color: 'green', text: `Просрочки сняты по ${d.resolvedOverdue.length} задачам.` });
    if (d.becameControl.length) insights.push({ color: 'blue', text: `${d.becameControl.length} задач перешли в “Ждёт контроля” — нужен быстрый прием результата или возврат.` });
    if (d.deadlineChanged.length) insights.push({ color: 'yellow', text: `Срок изменился у ${d.deadlineChanged.length} задач. Это стоит проверить на предмет переносов без фактического прогресса.` });
    if (m.highRisk - pm.highRisk > 0) insights.push({ color: 'orange', text: `Красных/оранжевых задач стало больше на ${m.highRisk - pm.highRisk}.` });
    if (d.added.length || d.removed.length) insights.push({ color: 'gray', text: `Поток задач: новых ${d.added.length}, ушло из выгрузки ${d.removed.length}.` });
  }

  const worstPerson = report.peopleRows.find(p => p.overdue > 0 || p.workloadScore >= 21 || p.availabilityScore < 35);
  if (worstPerson) {
    insights.push({ color: worstPerson.overdue ? 'red' : 'orange', text: `Главная зона внимания по людям: ${worstPerson.responsible} — просрочек ${worstPerson.overdue}, загрузка ${worstPerson.workloadScore.toFixed(1)}, доступность ${worstPerson.availabilityScore}.` });
  }

  const worstProject = report.projectRows.find(p => p.overdue > 0 || p.riskScore >= 50);
  if (worstProject) {
    insights.push({ color: worstProject.overdue ? 'red' : 'orange', text: `Главная зона внимания по проектам: ${worstProject.project} — просрочек ${worstProject.overdue}, риск ${worstProject.riskScore}.` });
  }

  if (m.noDeadline) insights.push({ color: 'gray', text: `Задач без срока: ${m.noDeadline}. Это снижает управляемость и искажает прогноз загрузки.` });
  if (m.stale14) insights.push({ color: 'orange', text: `Зависших без активности больше 14 дней: ${m.stale14}. Нужен запрос актуального статуса.` });

  if (insights.length === 1 && report.hasPrevious) {
    insights.push({ color: 'green', text: 'Критических ухудшений между выгрузками не найдено.' });
  }
  return insights.slice(0, 8);
}

function reportMetricHtml(label, value, delta, hint, color = 'blue', impact = 'lowerIsBetter') {
  const deltaHtml = delta === null || delta === undefined
    ? ''
    : `<div class="metric-delta ${escapeAttr(delta.color)}">${escapeHtml(delta.text)}</div>`;
  return `<div class="report-metric ${escapeAttr(color)}">
    <div class="label">${escapeHtml(label)}</div>
    <div class="value">${escapeHtml(String(value))}</div>
    ${deltaHtml}
    <div class="hint">${escapeHtml(hint || '')}</div>
  </div>`;
}

function reportDelta(report, key) {
  if (!report.previousMetrics) return null;
  const diff = report.metrics[key] - report.previousMetrics[key];
  const color = diff < 0 ? 'good' : diff > 0 ? 'bad' : 'neutral';
  return { value: diff, color, text: `${formatSigned(diff)} к прошлой` };
}

function formatDeltaValue(value, delta, lowerIsBetter = false) {
  const color = delta === 0 ? 'neutral' : lowerIsBetter ? (delta < 0 ? 'good' : 'bad') : (delta > 0 ? 'bad' : 'good');
  const deltaHtml = delta ? `<div class="small metric-delta ${color}">${formatSigned(delta)}</div>` : '<div class="small metric-delta neutral">0</div>';
  return `${escapeHtml(String(value))}${deltaHtml}`;
}

function formatSigned(value) {
  const num = Number(value) || 0;
  return num > 0 ? `+${num}` : String(num);
}

function buildReportCsvRows(report) {
  const metricRows = [
    ['Всего задач', 'total'],
    ['Просрочено', 'overdue'],
    ['Срок сегодня', 'dueToday'],
    ['Ближайшие 3 дня', 'dueSoon'],
    ['Ждёт контроля', 'waitingControl'],
    ['Без срока', 'noDeadline'],
    ['Нет активности >14', 'stale14'],
    ['Красный/оранжевый риск', 'highRisk'],
    ['Средний риск', 'avgRisk']
  ].map(([label, key]) => ({
    section: 'metric',
    type: label,
    value: report.metrics[key],
    delta: report.previousMetrics ? report.metrics[key] - report.previousMetrics[key] : '',
    responsible: '',
    project: '',
    task: '',
    status: '',
    deadline: '',
    risk_score: '',
    detail: ''
  }));

  const insightRows = report.insights.map(item => ({
    section: 'insight',
    type: item.color || '',
    value: '',
    delta: '',
    responsible: '',
    project: '',
    task: '',
    status: '',
    deadline: '',
    risk_score: '',
    detail: item.text
  }));

  const movementRows = report.movementRows.map(row => ({
    section: 'movement',
    type: row.type,
    value: '',
    delta: '',
    responsible: row.responsible,
    project: row.project,
    task: row.title,
    status: row.status,
    deadline: formatDateTime(row.deadline),
    risk_score: row.riskScore,
    detail: row.detail
  }));

  return [...metricRows, ...insightRows, ...movementRows];
}

function renderKpis(tasks) {
  const kpis = [
    ['Всего задач', tasks.length, 'Активный срез выгрузки', 'blue'],
    ['Просрочено', count(tasks, t => t.overdue), 'Пуш сегодня', 'red'],
    ['Срок сегодня', count(tasks, t => t.dueToday), 'Проверить готовность', 'orange'],
    ['Ближайшие 3 дня', count(tasks, t => t.dueSoon), 'Профилактика срыва', 'yellow'],
    ['Ждёт контроля', count(tasks, t => t.isWaitingControl), 'Принять / вернуть', 'blue'],
    ['Без срока', count(tasks, t => t.noDeadline), 'Нужно назначить дедлайн', 'gray'],
    ['Нет активности > 14 дн.', count(tasks, t => t.stale14), 'Зависшие задачи', 'gray'],
    ['Без родителя', count(tasks, t => t.noParent), 'Нет проектной привязки', 'gray'],
    ['Средний риск', avg(tasks.map(t => t.riskScore)).toFixed(0), 'Индекс по задачам', riskColor(avg(tasks.map(t => t.riskScore)))]
  ];
  el('kpiCards').innerHTML = kpis.map(([label, value, hint, color]) => kpiHtml(label, value, hint, color)).join('');
}

function renderPushList(tasks) {
  const rows = [...tasks]
    .filter(t => t.riskScore > 0 || t.isWaitingControl || t.overdue || t.noDeadline || t.stale14)
    .sort((a, b) => b.riskScore - a.riskScore || b.overdueDays - a.overdueDays)
    .slice(0, 100);

  el('pushList').innerHTML = tableHtml(rows, [
    ['Риск', t => badge(t.riskLabel, t.riskColor) + `<div class="small">${t.riskScore}</div>`],
    ['Действие', t => `<div class="action">${escapeHtml(t.recommendedAction)}</div>`],
    ['Ответственный', t => escapeHtml(t.responsible)],
    ['Проект', t => `<div class="project-name">${escapeHtml(t.project)}</div>`],
    ['Задача', t => `<div class="task-title">${escapeHtml(t.title)}</div><div class="small">ID: ${escapeHtml(t.id)}</div>`],
    ['Статус', t => escapeHtml(t.status)],
    ['Срок', t => formatDateTime(t.deadline)],
    ['Просрочка', t => t.overdue ? `${t.overdueDays} дн.` : ''],
    ['Активность', t => t.lastActivity ? `${formatDate(t.lastActivity)}<div class="small">${t.staleDays} дн.</div>` : ''],
    ['Комментарий', t => escapeHtml(t.systemComment)]
  ]);

  const available = summarizePeople(tasks)
    .filter(p => p.availabilityScore >= 55)
    .sort((a, b) => b.availabilityScore - a.availabilityScore)
    .slice(0, 12);
  el('availablePeople').innerHTML = tableHtml(available, [
    ['Сотрудник', p => escapeHtml(p.responsible)],
    ['Доступность', p => badge(p.availabilityCategory, p.availabilityColor) + `<div class="small">${p.availabilityScore}</div>`],
    ['Загрузка', p => `${p.workloadScore.toFixed(1)}<div class="small">${escapeHtml(p.workloadCategory)}</div>`],
    ['Рекомендация', p => escapeHtml(p.recommendation)]
  ]);
}

function renderPeople(tasks) {
  const people = summarizePeople(tasks);
  const canUse = people.filter(p => p.availabilityScore >= 75).length;
  const overloaded = people.filter(p => p.workloadScore >= 21 || p.overdue > 0 && p.availabilityScore < 35).length;
  el('peopleSummary').innerHTML = [
    `Сотрудников: ${people.length}`,
    `Можно рассчитывать: ${canUse}`,
    `Перегруз / высокий риск: ${overloaded}`,
    `Всего просрочек: ${sum(people.map(p => p.overdue))}`
  ].map(x => `<span class="summary-pill">${escapeHtml(x)}</span>`).join('');

  el('peopleBars').innerHTML = barChartHtml(people.slice(0, 12), 'responsible', 'workloadScore', 'Индекс загрузки');
  el('peopleTable').innerHTML = tableHtml(people, [
    ['Ответственный', p => escapeHtml(p.responsible)],
    ['Всего', p => p.total],
    ['В работе', p => p.inProgress],
    ['Ждёт вып.', p => p.waiting],
    ['Ждёт контроля', p => p.waitingControl],
    ['Просрочено', p => badge(String(p.overdue), p.overdue ? 'red' : 'green')],
    ['Сегодня', p => p.dueToday],
    ['3 дня', p => p.dueSoon],
    ['Без срока', p => p.noDeadline],
    ['Нет акт. >14', p => p.stale14],
    ['Загрузка', p => `${p.workloadScore.toFixed(1)}<div class="small">${escapeHtml(p.workloadCategory)}</div>`],
    ['Надежность', p => `${p.reliabilityScore}<div class="small">${escapeHtml(p.reliabilityCategory)}</div>`],
    ['Доступность', p => badge(p.availabilityCategory, p.availabilityColor) + `<div class="small">${p.availabilityScore}</div>`],
    ['Рекомендация', p => escapeHtml(p.recommendation)]
  ]);
}

function summarizePeople(tasks) {
  const groups = groupBy(tasks, t => t.responsible || 'Не указан');
  return Object.entries(groups).map(([responsible, rows]) => {
    const total = rows.length;
    const overdue = count(rows, t => t.overdue);
    const dueToday = count(rows, t => t.dueToday);
    const dueSoon = count(rows, t => t.dueSoon);
    const inProgress = count(rows, t => t.isInProgress);
    const waitingControl = count(rows, t => t.isWaitingControl);
    const noDeadline = count(rows, t => t.noDeadline);
    const stale14 = count(rows, t => t.stale14);
    const stale7 = count(rows, t => t.stale7);
    const waiting = count(rows, t => /жд.т выполн|ждет выполн|ждёт выполн/i.test(t.status));
    const projectTasks = count(rows, t => !t.noParent);
    const nonProjectTasks = total - projectTasks;
    const avgOverdue = overdue ? avg(rows.filter(t => t.overdue).map(t => t.overdueDays)) : 0;
    const maxOverdue = Math.max(0, ...rows.map(t => t.overdueDays || 0));
    const risky = count(rows, t => t.riskScore >= 50);

    const workloadScore = total * settings.workload.active
      + overdue * settings.workload.overdue
      + dueToday * settings.workload.dueToday
      + dueSoon * settings.workload.dueSoon
      + inProgress * settings.workload.inProgress
      + waitingControl * settings.workload.waitingControl
      + noDeadline * settings.workload.noDeadline;

    const reliabilityPenalty = ratio(overdue, total) * 35
      + ratio(stale14, total) * 25
      + ratio(noDeadline, total) * 20
      + ratio(waitingControl, total) * 10
      + Math.min(10, avgOverdue / 3);
    const reliabilityScore = clamp(Math.round(100 - reliabilityPenalty), 0, 100);
    const workloadPenalty = Math.min(30, workloadScore * 1.15);
    const urgentPenalty = Math.min(20, dueToday * 4 + dueSoon * 2);
    const overduePenalty = Math.min(30, overdue * 6 + avgOverdue);
    const recentActivityBonus = stale14 === 0 ? 5 : 0;
    const availabilityScore = clamp(Math.round(reliabilityScore - workloadPenalty - urgentPenalty - overduePenalty + recentActivityBonus), 0, 100);

    const workloadCategory = workloadScore <= 5 ? 'низкая загрузка' : workloadScore <= 12 ? 'нормальная загрузка' : workloadScore <= 20 ? 'высокая загрузка' : 'перегруз';
    const reliabilityCategory = reliabilityScore >= 80 ? 'высокая надежность' : reliabilityScore >= 60 ? 'нормальная надежность' : reliabilityScore >= 40 ? 'нестабильно' : 'высокий риск';
    const availabilityCategory = availabilityScore >= 75 ? 'Можно рассчитывать' : availabilityScore >= 55 ? 'Ограниченно' : availabilityScore >= 35 ? 'Лучше уточнить' : 'Не нагружать';
    const availabilityColor = availabilityScore >= 75 ? 'green' : availabilityScore >= 55 ? 'yellow' : availabilityScore >= 35 ? 'orange' : 'red';
    const recommendation = buildPeopleRecommendation({ availabilityScore, overdue, noDeadline, stale14, workloadScore, dueToday, dueSoon });

    return { responsible, total, inProgress, waiting, waitingControl, overdue, dueToday, dueSoon, noDeadline, stale7, stale14, projectTasks, nonProjectTasks, avgOverdue, maxOverdue, risky, workloadScore, workloadCategory, reliabilityScore, reliabilityCategory, availabilityScore, availabilityCategory, availabilityColor, recommendation };
  }).sort((a, b) => b.workloadScore - a.workloadScore || b.overdue - a.overdue);
}

function buildPeopleRecommendation(p) {
  if (p.overdue > 0 && p.availabilityScore < 35) return 'Не нагружать, сначала разобрать просрочки';
  if (p.workloadScore >= 21) return 'Не нагружать без снятия части задач';
  if (p.noDeadline > 3) return 'Сначала назначить сроки текущим задачам';
  if (p.stale14 > 2) return 'Сначала уточнить статус зависших задач';
  if (p.availabilityScore >= 75) return 'Можно дать новую задачу';
  if (p.availabilityScore >= 55) return 'Можно дать короткую задачу';
  return 'Сначала уточнить статус и загрузку';
}

function renderProjects(tasks) {
  const projects = summarizeProjects(tasks);
  el('projectBars').innerHTML = barChartHtml(projects.slice(0, 12), 'project', 'riskScore', 'Индекс риска');
  el('projectTable').innerHTML = tableHtml(projects, [
    ['Проект / родительская задача', p => `<div class="project-name">${escapeHtml(p.project)}</div>`],
    ['Всего', p => p.total],
    ['Просрочено', p => badge(String(p.overdue), p.overdue ? 'red' : 'green')],
    ['Сегодня', p => p.dueToday],
    ['3 дня', p => p.dueSoon],
    ['Ждёт контроля', p => p.waitingControl],
    ['Без срока', p => p.noDeadline],
    ['Нет акт. >14', p => p.stale14],
    ['Ответственных', p => p.peopleCount],
    ['Главный ответственный', p => escapeHtml(p.mainResponsible)],
    ['Риск', p => badge(p.riskLabel, p.riskColor) + `<div class="small">${p.riskScore}</div>`]
  ]);
}

function summarizeProjects(tasks) {
  const groups = groupBy(tasks, t => t.project || 'Без проекта / без родительской задачи');
  return Object.entries(groups).map(([project, rows]) => {
    const total = rows.length;
    const overdue = count(rows, t => t.overdue);
    const dueToday = count(rows, t => t.dueToday);
    const dueSoon = count(rows, t => t.dueSoon);
    const waitingControl = count(rows, t => t.isWaitingControl);
    const noDeadline = count(rows, t => t.noDeadline);
    const stale14 = count(rows, t => t.stale14);
    const people = groupBy(rows, t => t.responsible);
    const peopleCount = Object.keys(people).length;
    const mainResponsible = Object.entries(people).sort((a, b) => b[1].length - a[1].length)[0]?.[0] || '';
    const riskScore = Math.round(avg(rows.map(t => t.riskScore)) + overdue * 4 + waitingControl * 2 + noDeadline * 1.5);
    const color = riskColor(riskScore);
    return { project, total, overdue, dueToday, dueSoon, waitingControl, noDeadline, stale14, peopleCount, mainResponsible, riskScore: Math.min(100, riskScore), riskColor: color, riskLabel: riskLabel(color) };
  }).sort((a, b) => b.riskScore - a.riskScore || b.total - a.total);
}

function renderControl(tasks) {
  const rows = tasks.filter(t => t.isWaitingControl).sort((a, b) => b.riskScore - a.riskScore);
  el('controlTable').innerHTML = tableHtml(rows, [
    ['Риск', t => badge(t.riskLabel, t.riskColor)],
    ['Задача', t => `<div class="task-title">${escapeHtml(t.title)}</div>`],
    ['Проект', t => `<div class="project-name">${escapeHtml(t.project)}</div>`],
    ['Ответственный', t => escapeHtml(t.responsible)],
    ['Постановщик', t => escapeHtml(t.author)],
    ['Срок', t => formatDateTime(t.deadline)],
    ['Последнее изменение', t => formatDateTime(t.changed)],
    ['Действие', t => 'Проверить результат и закрыть или вернуть на доработку']
  ]);
}

function renderHygiene(tasks) {
  const issues = buildHygieneIssues(tasks);
  const kpis = [
    ['Нет срока', count(tasks, t => t.noDeadline), 'Назначить дедлайн', 'gray'],
    ['Нет родителя', count(tasks, t => t.noParent), 'Привязать к проекту', 'gray'],
    ['Нет активности >14', count(tasks, t => t.stale14), 'Запросить статус', 'orange'],
    ['Ждёт контроля', count(tasks, t => t.isWaitingControl), 'Разобрать inbox', 'blue'],
    ['Нет оценки', count(tasks, t => !t.estimate), 'Нет данных по трудозатратам', 'gray']
  ];
  el('hygieneCards').innerHTML = kpis.map(([label, value, hint, color]) => kpiHtml(label, value, hint, color)).join('');
  el('hygieneTable').innerHTML = tableHtml(issues, [
    ['Нарушение', i => badge(i.issue, i.color)],
    ['Ответственный', i => escapeHtml(i.responsible)],
    ['Проект', i => `<div class="project-name">${escapeHtml(i.project)}</div>`],
    ['Задача', i => `<div class="task-title">${escapeHtml(i.title)}</div>`],
    ['Статус', i => escapeHtml(i.status)],
    ['Действие', i => escapeHtml(i.action)]
  ]);
}

function buildHygieneIssues(tasks) {
  const issues = [];
  tasks.forEach(t => {
    if (t.noDeadline) issues.push(issueRow(t, 'Нет срока', 'gray', 'Назначить крайний срок'));
    if (t.noParent) issues.push(issueRow(t, 'Нет родителя', 'gray', 'Привязать к проекту / родительской задаче'));
    if (t.stale14) issues.push(issueRow(t, 'Нет активности >14 дн.', 'orange', 'Запросить актуальный статус'));
    if (t.isWaitingControl) issues.push(issueRow(t, 'Ждёт контроля', 'blue', 'Принять или вернуть'));
    if (!t.estimate) issues.push(issueRow(t, 'Нет оценки', 'gray', 'Оценить трудозатраты, если это проектная задача'));
  });
  return issues.sort((a, b) => colorWeight(b.color) - colorWeight(a.color));
}

function issueRow(t, issue, color, action) {
  return { issue, color, action, responsible: t.responsible, project: t.project, title: t.title, status: t.status, id: t.id };
}

function renderDynamic() {
  if (!state.previousTasks.length) {
    el('dynamicContent').innerHTML = '<p class="muted">Для динамики нужно минимум две выгрузки. Добавьте следующую выгрузку в data/raw/ и data/exports.json.</p>';
    return;
  }
  const currentById = mapByStableId(state.tasks);
  const prevById = mapByStableId(state.previousTasks);
  const currentIds = new Set(Object.keys(currentById));
  const prevIds = new Set(Object.keys(prevById));
  const added = [...currentIds].filter(id => !prevIds.has(id)).map(id => currentById[id]);
  const removed = [...prevIds].filter(id => !currentIds.has(id)).map(id => prevById[id]);
  const newOverdue = [...currentIds].filter(id => prevIds.has(id) && currentById[id].overdue && !prevById[id].overdue).map(id => currentById[id]);
  const becameControl = [...currentIds].filter(id => prevIds.has(id) && currentById[id].isWaitingControl && !prevById[id].isWaitingControl).map(id => currentById[id]);
  const deadlineChanged = [...currentIds].filter(id => prevIds.has(id) && dateKey(currentById[id].deadline) !== dateKey(prevById[id].deadline)).map(id => currentById[id]);
  const responsibleChanged = [...currentIds].filter(id => prevIds.has(id) && currentById[id].responsible !== prevById[id].responsible).map(id => currentById[id]);

  const blocks = [
    ['Новые задачи', added],
    ['Исчезли из выгрузки', removed],
    ['Новые просрочки', newOverdue],
    ['Стали “Ждёт контроля”', becameControl],
    ['Изменился срок', deadlineChanged],
    ['Изменился ответственный', responsibleChanged]
  ];
  el('dynamicContent').innerHTML = `
    <div class="kpi-grid">${blocks.map(([label, rows]) => kpiHtml(label, rows.length, 'между соседними выгрузками', rows.length ? 'orange' : 'green')).join('')}</div>
    ${blocks.map(([label, rows]) => `<h3>${escapeHtml(label)}</h3>${tableHtml(rows.slice(0, 50), [
      ['Задача', t => `<div class="task-title">${escapeHtml(t.title)}</div>`],
      ['Ответственный', t => escapeHtml(t.responsible)],
      ['Проект', t => `<div class="project-name">${escapeHtml(t.project)}</div>`],
      ['Статус', t => escapeHtml(t.status)],
      ['Срок', t => formatDateTime(t.deadline)]
    ])}`).join('')}`;
}

function renderAllTasks(tasks) {
  const rows = [...tasks].sort((a, b) => b.riskScore - a.riskScore);
  el('allTasksTable').innerHTML = tableHtml(rows, [
    ['Риск', t => badge(t.riskLabel, t.riskColor) + `<div class="small">${t.riskScore}</div>`],
    ['ID', t => escapeHtml(t.id)],
    ['Задача', t => `<div class="task-title">${escapeHtml(t.title)}</div>`],
    ['Ответственный', t => escapeHtml(t.responsible)],
    ['Проект', t => `<div class="project-name">${escapeHtml(t.project)}</div>`],
    ['Статус', t => escapeHtml(t.status)],
    ['Срок', t => formatDateTime(t.deadline)],
    ['Активность', t => formatDateTime(t.lastActivity)],
    ['Действие', t => `<div class="action">${escapeHtml(t.recommendedAction)}</div>`]
  ]);
}

function fillFilters() {
  fillSelect('filterResponsible', unique(state.tasks.map(t => t.responsible)).sort());
  fillSelect('filterProject', unique(state.tasks.map(t => t.project)).sort());
  fillSelect('filterStatus', unique(state.tasks.map(t => t.status)).sort());
}

function fillSelect(id, values) {
  const current = el(id).value;
  el(id).innerHTML = '<option value="">Все</option>' + values.map(v => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('');
  if (values.includes(current)) el(id).value = current;
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
}

function tableHtml(rows, columns) {
  if (!rows || !rows.length) return '<div class="status-box">Нет данных по выбранным фильтрам.</div>';
  return `<table><thead><tr>${columns.map(([name]) => `<th>${escapeHtml(name)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(([, fn]) => `<td>${fn(row) ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function kpiHtml(label, value, hint, color = 'blue') {
  return `<div class="kpi ${color}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div><div class="hint">${escapeHtml(hint || '')}</div></div>`;
}

function badge(text, color = 'gray') {
  return `<span class="badge ${color}">${escapeHtml(String(text || ''))}</span>`;
}

function barChartHtml(rows, labelKey, valueKey, title) {
  if (!rows.length) return '';
  const max = Math.max(1, ...rows.map(r => Number(r[valueKey]) || 0));
  return `<h3>${escapeHtml(title)}</h3>` + rows.map(r => {
    const value = Number(r[valueKey]) || 0;
    const width = Math.max(2, Math.round(value / max * 100));
    return `<div class="bar-row"><div class="bar-label" title="${escapeAttr(r[labelKey])}">${escapeHtml(r[labelKey])}</div><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div><div class="bar-value">${value.toFixed(1)}</div></div>`;
  }).join('');
}

function exportCsv(kind) {
  const tasks = getFilteredTasks();
  let rows = [];
  if (kind === 'push') rows = [...tasks].filter(t => t.riskScore > 0).sort((a, b) => b.riskScore - a.riskScore).map(taskCsvRow);
  if (kind === 'all') rows = [...tasks].sort((a, b) => b.riskScore - a.riskScore).map(taskCsvRow);
  if (kind === 'people') rows = summarizePeople(tasks).map(p => ({
    responsible: p.responsible, total: p.total, overdue: p.overdue, due_today: p.dueToday, due_soon: p.dueSoon, no_deadline: p.noDeadline, stale_14: p.stale14, workload_score: p.workloadScore.toFixed(1), reliability_score: p.reliabilityScore, availability_score: p.availabilityScore, recommendation: p.recommendation
  }));
  if (kind === 'projects') rows = summarizeProjects(tasks).map(p => ({
    project: p.project, total: p.total, overdue: p.overdue, due_today: p.dueToday, due_soon: p.dueSoon, waiting_control: p.waitingControl, no_deadline: p.noDeadline, stale_14: p.stale14, risk_score: p.riskScore, main_responsible: p.mainResponsible
  }));
  if (kind === 'hygiene') rows = buildHygieneIssues(tasks).map(i => ({ issue: i.issue, responsible: i.responsible, project: i.project, task: i.title, status: i.status, action: i.action }));
  if (kind === 'report') rows = buildReportCsvRows(buildExportReport());
  downloadCsv(rows, `${kind}_${state.exportName.replace(/\.xls$/i, '')}.csv`);
}

function taskCsvRow(t) {
  return {
    risk_score: t.riskScore,
    risk: t.riskLabel,
    action: t.recommendedAction,
    responsible: t.responsible,
    project: t.project,
    title: t.title,
    status: t.status,
    deadline: formatDateTime(t.deadline),
    overdue_days: t.overdueDays,
    last_activity: formatDateTime(t.lastActivity),
    author: t.author,
    id: t.id,
    comment: t.systemComment
  };
}

function downloadCsv(rows, fileName) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = '\uFEFF' + headers.join(';') + '\n' + rows.map(row => headers.map(h => csvEscape(row[h])).join(';')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function csvEscape(value) {
  const str = String(value ?? '');
  return `"${str.replace(/"/g, '""')}"`;
}

function projectKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[«»„“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/[ё]/g, 'е');
}

function parseBitrixDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDateFromFileName(fileName) {
  const m = fileName.match(/(\d{4})-(\d{2})-(\d{2})[_-](\d{2})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
}

function parseNumber(value) {
  const text = cleanText(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return text ? Number(text[0]) : 0;
}

function compareExportNames(a, b) {
  const da = parseDateFromFileName(a)?.getTime() || 0;
  const db = parseDateFromFileName(b)?.getTime() || 0;
  return da - db || a.localeCompare(b);
}

function formatDateTime(date) {
  if (!date) return '';
  return date.toLocaleString('ru-RU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDate(date) {
  if (!date) return '';
  return date.toLocaleDateString('ru-RU');
}

function diffDays(date, base) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  return Math.round((d - b) / 86400000);
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function count(rows, fn) { return rows.reduce((acc, row) => acc + (fn(row) ? 1 : 0), 0); }
function sum(values) { return values.reduce((a, b) => a + (Number(b) || 0), 0); }
function avg(values) { const nums = values.filter(v => Number.isFinite(Number(v))); return nums.length ? sum(nums) / nums.length : 0; }
function ratio(value, total) { return total ? value / total : 0; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function groupBy(rows, fn) { return rows.reduce((acc, row) => { const key = fn(row) || 'Не указано'; (acc[key] ||= []).push(row); return acc; }, {}); }
function riskColor(score) { return score >= 80 ? 'red' : score >= 50 ? 'orange' : score >= 25 ? 'yellow' : score >= 1 ? 'gray' : 'green'; }
function riskLabel(color) { return { red: 'Красный', orange: 'Оранжевый', yellow: 'Желтый', gray: 'Серый', green: 'Зеленый', blue: 'Синий' }[color] || color; }
function colorWeight(color) { return { red: 5, orange: 4, yellow: 3, blue: 2, gray: 1, green: 0 }[color] || 0; }
function dateKey(date) { return date ? date.toISOString().slice(0, 16) : ''; }
function mapByStableId(tasks) { return Object.fromEntries(tasks.map(t => [String(t.id || t.title), t])); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function escapeAttr(value) { return escapeHtml(value); }

function showStatus(message) {
  el('statusBox').classList.remove('error');
  el('statusBox').textContent = message;
}

function showError(message) {
  el('statusBox').classList.add('error');
  el('statusBox').textContent = message;
}
