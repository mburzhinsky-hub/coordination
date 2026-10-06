'use strict';

const DB_NAME = 'coordination.daily.v2';
const DB_VERSION = 1;
const LEGACY_EXPORTS_KEY = 'bitrixTaskDashboard.localExports.v1';
const CONTROL_WATCH_DAYS = 3;
const CONTROL_CRITICAL_DAYS = 5;
const DUE_SOON_DAYS = 3;
const CHRONIC_OVERDUE_DAYS = 14;
const LEGACY_OVERDUE_DAYS = 30;
const QUIET_CHRONIC_DAYS = 7;
const QUIET_LEGACY_DAYS = 14;
const DEADLINE_CHURN_DAYS = 14;
const DEADLINE_CHURN_COUNT = 3;

const KNOWN_PROJECT_CONTAINERS = [
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

const IGNORED_DAILY_TASKS = [
  'Ежедневная проверка статусов закупок/договоров',
  'Ежедневный контроль выполнения задач'
];

const state = {
  db: null,
  snapshots: [],
  currentSnapshot: null,
  currentView: 'overview',
  presence: { people: {} },
  roster: [],
  pendingPresence: null,
  pendingPresenceSnapshotId: null,
  busy: false
};

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('DOMContentLoaded', init);
}

async function init() {
  bindUi();
  renderLoading('Загружаю историю…');
  try {
    state.db = await openDb();
    await migrateLegacyExports();
    await seedRepositorySnapshots();
    await refreshSnapshots();
    if (!state.snapshots.length) {
      renderEmpty();
      return;
    }
    state.currentSnapshot = state.snapshots[state.snapshots.length - 1];
    state.roster = await loadRoster();
    state.presence = await loadPresence(state.currentSnapshot.id) || { people: {} };
    renderCurrentView();
  } catch (error) {
    console.error(error);
    renderError(error.message || String(error));
  }
}

function bindUi() {
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
  const upload = document.getElementById('uploadInput');
  if (upload) upload.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await handleUpload(file);
  });
  const close = document.getElementById('presenceClose');
  if (close) close.addEventListener('click', () => document.getElementById('presenceDialog')?.close());
  const skip = document.getElementById('presenceSkip');
  if (skip) skip.addEventListener('click', async () => savePendingPresence(false));
  const save = document.getElementById('presenceSave');
  if (save) save.addEventListener('click', async () => savePendingPresence(true));
  const matrix = document.getElementById('presenceMatrix');
  if (matrix) matrix.addEventListener('click', event => {
    const button = event.target.closest('[data-presence-person][data-presence-project]');
    if (!button || !state.pendingPresence) return;
    const person = button.dataset.presencePerson;
    const project = button.dataset.presenceProject;
    const current = Number(state.pendingPresence.people?.[person]?.[project] || 0);
    const next = (current + 1) % 4;
    if (!state.pendingPresence.people[person]) state.pendingPresence.people[person] = {};
    state.pendingPresence.people[person][project] = next;
    updatePresenceButton(button, next);
  });
  document.getElementById('viewRoot')?.addEventListener('click', event => {
    const link = event.target.closest('[data-open-view]');
    if (link) switchView(link.dataset.openView);
  });
}

function switchView(view) {
  state.currentView = view || 'overview';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === state.currentView));
  renderCurrentView();
}

function pageMeta(view) {
  return {
    overview: ['ИТО — Обзор', 'Ежедневный срез инженерно-технического отдела'],
    people: ['ИТО — Люди', 'Текущая работа, живой объём и свежие сигналы'],
    projects: ['ИТО — Проекты', 'Активные проекты без шума старого долга'],
    attention: ['ИТО — Внимание', 'То, что требует действия сейчас'],
    plan: ['ИТО — План', 'Ближайшие сроки и рабочий горизонт']
  }[view] || ['ИТО', ''];
}

function renderCurrentView() {
  const snapshot = state.currentSnapshot;
  if (!snapshot) return renderEmpty();
  const [title, subtitle] = pageMeta(state.currentView);
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = subtitle;
  document.getElementById('updatedAt').textContent = `Обновлено ${formatTime(snapshot.asOf)}`;
  const attention = buildAttentionItems(snapshot);
  const navBadge = document.getElementById('navAttentionCount');
  navBadge.hidden = !attention.length;
  navBadge.textContent = attention.length;
  renderQuality(snapshot.quality);
  if (state.currentView === 'people') return renderPeopleView(snapshot);
  if (state.currentView === 'projects') return renderProjectsView(snapshot);
  if (state.currentView === 'attention') return renderAttentionView(snapshot);
  if (state.currentView === 'plan') return renderPlanView(snapshot);
  renderOverview(snapshot);
}

