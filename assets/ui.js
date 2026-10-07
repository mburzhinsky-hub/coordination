'use strict';
function renderOverview(snapshot) {
  const presence = state.presence || { people: {} };
  const people = summarizePeopleV2(snapshot.tasks, presence, ITO_ROSTER);
  const projects = summarizeProjectsV2(snapshot.tasks, snapshot);
  const attention = buildAttentionItems(snapshot);
  const operational = summarizeOperationalWork(snapshot.tasks);
  const quality = summarizeDataQuality(snapshot, presence);
  const changes = summarizeChanges(snapshot);
  const possibleOverload = summarizePossibleOverload(snapshot.tasks, people);
  const overloadMap = new Map(possibleOverload.map(item => [item.name, item]));
  people.forEach(person => { person.possibleOverload = overloadMap.get(person.name) || null; });
  const debtCount = snapshot.tasks.filter(t => t.debt && t.debt !== 'none').length;
  const waitingControlCount = snapshot.tasks.filter(t => !t.isCompleted && t.isWaitingControl).length;
  const firstSnapshot = state.snapshots.length < 2;
  document.getElementById('viewRoot').innerHTML = `
    ${renderTodayStrip(attention.length, waitingControlCount, debtCount, changes.counts.completed, firstSnapshot)}
    <div class="dashboard-grid management-grid overview-signal-grid">
      ${renderChangesPanel(changes, firstSnapshot)}
      ${renderPossibleOverloadPanel(possibleOverload)}
    </div>
    <div class="dashboard-grid management-grid">
      ${renderAttentionPanel(attention.slice(0, 5), debtCount)}
      ${renderPresenceSummary(people, presence)}
    </div>
    ${renderProjectsPanel(projects, snapshot)}
    ${renderTeamPanel(people)}
    <div class="dashboard-grid management-grid">
      ${renderOperationalPanel(operational)}
      ${renderQualityPanel(quality)}
    </div>`;
}

function renderTodayStrip(attention, control, debt, completed, firstSnapshot) {
  return `<section class="today-strip">
    <div class="today-label">Сегодня</div>
    <div class="today-metric"><strong>${attention}</strong><span>свежих сигналов</span></div>
    <div class="today-metric"><strong>${control}</strong><span>ждут контроля</span></div>
    <div class="today-metric"><strong>${debt}</strong><span>старый долг</span></div>
    <div class="today-metric"><strong>${firstSnapshot ? '—' : completed}</strong><span>${firstSnapshot ? 'первый срез' : 'закрыто со вчера'}</span></div>
  </section>`;
}

function renderChangesPanel(changes, firstSnapshot) {
  if (firstSnapshot) return `<section class="panel change-panel"><div class="panel-head"><h2 class="panel-title">Что изменилось</h2></div><div class="attention-empty">Это первый срез. Изменения появятся после следующей ежедневной выгрузки.</div></section>`;
  const c = changes.counts;
  return `<section class="panel change-panel">
    <div class="panel-head"><h2 class="panel-title">Что изменилось</h2></div>
    <div class="change-summary">
      <span><strong>${c.completed}</strong> закрыто</span><span><strong>${c.added}</strong> новых</span><span><strong>${c.newOverdue}</strong> новых просрочек</span><span><strong>${c.deadlineMoved}</strong> изменений срока</span><span><strong>${c.control}</strong> ушли на контроль</span>
    </div>
    <div class="change-list">${changes.meaningful.map(event => `<button class="change-row" type="button" data-task-id="${escapeAttr(event.taskId)}"><span class="signal-dot ${event.severity === 'critical' ? 'critical' : event.severity === 'watch' ? 'watch' : 'none'}"></span><span class="change-project">${escapeHtml(event.project || 'Операционная работа')}</span><span class="change-text"><strong>${escapeHtml(event.taskTitle || 'Задача')}</strong><small>${escapeHtml(event.label)}${event.detail ? ' · '+escapeHtml(event.detail) : ''}</small></span></button>`).join('') || '<div class="attention-empty">Значимых изменений нет.</div>'}</div>
  </section>`;
}


function renderPossibleOverloadPanel(items) {
  return `<section class="panel overload-panel">
    <div class="panel-head"><div><h2 class="panel-title">Возможный перегруз</h2><p class="panel-note">Эвристика: активные задачи, параллельные проекты, свежие сигналы и близкие сроки.</p></div><strong class="overload-count">${items.length}</strong></div>
    ${items.length ? `<div class="overload-list">${items.slice(0,4).map(item => `<button class="overload-row" type="button" data-person="${escapeAttr(item.name)}"><span class="avatar">${escapeHtml(initials(item.name))}</span><span class="overload-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.reasons.join(' · '))}</small></span><span class="overload-tag ${item.level}">проверить</span></button>`).join('')}</div>` : '<div class="attention-empty">Явных признаков перегруза сейчас нет.</div>'}
  </section>`;
}


function kpiCard(value, label, icon, kind) {
  return `<article class="kpi-card" data-kind="${escapeAttr(kind)}"><div><div class="kpi-value">${escapeHtml(value)}</div><div class="kpi-label">${escapeHtml(label)}</div></div><div class="kpi-icon">${escapeHtml(icon)}</div></article>`;
}

function renderTeamPanel(people) {
  return `<section class="panel management-panel">
    <div class="panel-head"><h2 class="panel-title">Команда</h2><button class="panel-link" data-open-view="people">все →</button></div>
    <div class="table-scroll"><table class="data-table team-table management-table"><thead><tr><th>Сотрудник</th><th>Где</th><th>Текущий фокус</th><th>Активно</th><th>Контроль</th><th>Сигналы</th><th>Долг</th><th>Нагрузка</th></tr></thead><tbody>
      ${people.map(person => `<tr class="clickable-row" data-person="${escapeAttr(person.name)}">
        <td><div class="person-cell"><span class="avatar">${escapeHtml(initials(person.name))}</span><span class="person-name">${escapeHtml(person.name)}</span></div></td>
        <td>${escapeHtml(person.location)}</td>
        <td>${person.focusTaskId ? `<button class="task-link task-link-compact" type="button" data-task-id="${escapeAttr(person.focusTaskId)}" title="${escapeAttr(person.focus)}">${escapeHtml(person.focus)}</button>` : '—'}</td>
        <td>${person.activeCount}</td><td>${person.waitingControlCount}</td><td>${person.freshAttentionCount}</td><td>${person.debtCount}</td><td>${person.possibleOverload ? `<span class="overload-inline ${person.possibleOverload.level}">проверить</span>` : '—'}</td>
      </tr>`).join('')}
    </tbody></table></div>
  </section>`;
}

function renderAttentionPanel(items, debtCount) {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Требует внимания</h2><button class="panel-link" data-open-view="attention">все →</button></div>
    ${items.length ? `<div class="attention-list">${items.map(item => `<button class="attention-row attention-row-button" type="button" data-task-id="${escapeAttr(item.taskId)}"><span class="signal-dot ${item.severity}"></span><div class="attention-main"><div class="attention-project">${escapeHtml(item.project)}</div><div class="attention-task-title">${escapeHtml(item.detail)}</div><div class="attention-reason">${escapeHtml(item.label)}</div></div><div class="attention-age ${item.severity}">${escapeHtml(item.when)}</div></button>`).join('')}</div>` : `<div class="attention-empty">Новых оперативных сигналов нет.</div>`}
    <div class="debt-link"><span>Старый долг</span><span>${debtCount}</span></div>
  </section>`;
}

function renderProjectsPanel(projects, snapshot = state.currentSnapshot) {
  return `<section class="panel management-panel">
    <div class="panel-head"><h2 class="panel-title">Проекты</h2><button class="panel-link" data-open-view="projects">все →</button></div>
    <div class="table-scroll"><table class="data-table management-table"><thead><tr><th>Проект</th><th>Активно</th><th>Контроль</th><th>Сигналы</th><th>Долг</th><th>Ближайший срок</th><th>Последнее движение</th></tr></thead><tbody>
      ${projects.map(p => `<tr class="clickable-row" data-project-id="${escapeAttr(p.id)}"><td><strong>${escapeHtml(p.name)}</strong><div class="secondary">${escapeHtml(p.type)}</div></td><td>${p.activeCount}</td><td>${p.waitingControlCount}</td><td><span class="project-risk"><i class="signal-dot ${p.risk === 'high' ? 'critical' : p.risk === 'medium' ? 'watch' : 'none'}"></i>${p.attentionCount}</span></td><td>${p.debtCount}</td><td>${escapeHtml(p.nextDeadline ? formatDateShort(p.nextDeadline) : '—')}</td><td>${escapeHtml(relativeMovement(p.lastMovementAt, snapshot.asOf))}</td></tr>`).join('')}
    </tbody></table></div>
  </section>`;
}

function renderPresenceSummary(people, presence) {
  const groups = { site: [], office: [], remote: [], vacation: [], '': [] };
  people.forEach(person => (groups[person.presenceMode] || groups['']).push(person));
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Кто где</h2><button class="panel-link" data-edit-presence="1">изменить →</button></div>
    <div class="location-summary">
      ${groups.site.map(p => `<div class="location-site"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.location)}</span></div>`).join('')}
      <div class="location-counts"><span>В офисе <strong>${groups.office.length}</strong></span><span>Удалённо <strong>${groups.remote.length}</strong></span><span>В отпуске <strong>${groups.vacation.length}</strong></span><span>Не указано <strong>${groups[''].length}</strong></span></div>
    </div>
  </section>`;
}

function renderOperationalPanel(data) {
  return `<section class="panel"><div class="panel-head"><h2 class="panel-title">Операционная работа</h2></div>
    <div class="operational-stats"><span><strong>${data.totalCount}</strong> текущих</span><span><strong>${data.activeCount}</strong> активно</span><span><strong>${data.waitingControlCount}</strong> контроль</span><span><strong>${data.attentionCount}</strong> сигналы</span><span><strong>${data.debtCount}</strong> долг</span></div>
    <div class="operational-buckets">${data.buckets.map(x=>`<span>${escapeHtml(x.name)} · ${x.count}</span>`).join('')}</div>
  </section>`;
}

function renderQualityPanel(data) {
  return `<section class="panel"><div class="panel-head"><h2 class="panel-title">Качество данных</h2></div>
    <div class="quality-list"><div><strong>${data.noDeadlineCount}</strong><span>задач без срока</span></div><div><strong>${data.outsideProjectsCount}</strong><span>вне основных проектов</span></div><div><strong>${data.projectConflictCount}</strong><span>конфликтов проекта</span></div><div><strong>${data.missingPresenceCount}</strong><span>не заполнено «Кто где»</span></div></div>
  </section>`;
}

function renderPresencePanel(people, projects, presence) {
  const rows = people.map(person => {
    const entry = presenceForPerson(presence, person.name);
    const project = entry.mode === 'site' ? itoProjectById(entry.projectId) : null;
    return { name: person.name, mode: entry.mode, label: presenceModeLabel(entry.mode), project: project?.name || '' };
  });
  const order = { site: 0, office: 1, remote: 2, vacation: 3, '': 4 };
  rows.sort((a,b) => (order[a.mode] ?? 4) - (order[b.mode] ?? 4) || a.name.localeCompare(b.name, 'ru'));
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Кто где</h2><button class="panel-link" data-edit-presence="1">изменить →</button></div>
    <div class="where-list">${rows.map(row => `<div class="where-row"><div class="person-cell"><span class="avatar">${escapeHtml(initials(row.name))}</span><span class="person-name">${escapeHtml(row.name)}</span></div><span class="where-status ${escapeAttr(row.mode || 'unknown')}">${escapeHtml(row.label)}</span><span class="where-project">${row.project ? escapeHtml(row.project) : '—'}</span></div>`).join('')}</div>
  </section>`;
}

function statusPill(status) {
  const labels = { overload: 'перегруз', risk: 'риск', normal: 'норма', reserve: 'есть резерв' };
  return `<span class="status-pill ${escapeAttr(status)}"><i class="status-dot"></i>${escapeHtml(labels[status] || status)}</span>`;
}

function projectRisk(risk) {
  const labels = { high: 'Высокий', medium: 'Средний', none: 'Нет' };
  const cls = risk === 'high' ? 'critical' : risk === 'medium' ? 'watch' : 'none';
  return `<span class="project-risk"><i class="signal-dot ${cls}"></i>${escapeHtml(labels[risk] || 'Нет')}</span>`;
}

function renderPeopleView(snapshot) {
  const people = summarizePeopleV2(snapshot.tasks, state.presence, ITO_ROSTER);
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>Люди</h2><p>Фактические состояния без синтетической оценки «перегруз / резерв».</p></div></div>
    ${renderTeamPanel(people)}
  </section>`;
}

function renderProjectsView(snapshot) {
  const projects = summarizeProjectsV2(snapshot.tasks, snapshot);
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>Проекты</h2><p>Восемь основных проектов: движение, контроль, свежие сигналы и долг.</p></div></div>
    ${renderProjectsPanel(projects, snapshot)}
  </section>`;
}

function renderAttentionView(snapshot) {
  const items = buildAttentionItems(snapshot);
  const debt = snapshot.tasks.filter(t => t.debt && t.debt !== 'none').sort((a,b) => b.overdueDays - a.overdueDays);
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>Внимание</h2><p>Fresh attention отделён от накопленного долга.</p></div><div class="summary-strip"><span class="summary-chip">сейчас ${items.length}</span><span class="summary-chip">старый долг ${debt.length}</span></div></div>
    <div class="attention-full-list">${items.map(item => `<button class="attention-card task-card-button" type="button" data-task-id="${escapeAttr(item.taskId)}"><i class="signal-dot ${item.severity}"></i><div><div class="attention-project">${escapeHtml(item.project)}</div><h3>${escapeHtml(item.detail)}</h3><p>${escapeHtml(item.label)}${item.owner ? ` · Мяч: ${escapeHtml(item.owner)}` : ''}</p></div><div class="attention-meta">${escapeHtml(item.when)}</div></button>`).join('') || '<div class="attention-empty">Оперативных сигналов нет.</div>'}</div>
    <details class="debt-section"><summary>Старый долг · ${debt.length}</summary>${debt.length ? `<table class="data-table detail-table"><thead><tr><th>Задача</th><th>Проект</th><th>Ответственный</th><th>Просрочка</th><th>Без движения</th><th>Класс</th></tr></thead><tbody>${debt.map(t => `<tr><td><button class="task-link task-link-table" type="button" data-task-id="${escapeAttr(t.id)}" title="${escapeAttr(t.title)}">${escapeHtml(t.title)}</button></td><td>${escapeHtml(t.project)}</td><td>${escapeHtml(t.responsible)}</td><td>${t.overdueDays ? `${t.overdueDays} дн.` : '—'}</td><td>${t.inactivityDays} дн.</td><td>${escapeHtml(t.debt)}</td></tr>`).join('')}</tbody></table>` : ''}</details>
  </section>`;
}

function renderPlanView(snapshot) {
  const tasks = snapshot.tasks.filter(t => !t.isCompleted && t.deadline && t.debt === 'none').sort((a,b) => a.deadline - b.deadline).slice(0, 40);
  const maxDays = Math.max(1, ...tasks.map(t => Math.max(0, diffDays(t.deadline, new Date(snapshot.asOf)))));
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>План</h2><p>Ближайшие сроки без legacy-задач.</p></div><div class="summary-strip"><span class="summary-chip">на шкале ${tasks.length}</span></div></div>
    <div class="plan-list">${tasks.map(t => { const days = diffDays(t.deadline, new Date(snapshot.asOf)); const width = Math.max(5, Math.min(100, ((Math.max(0, days) + 1) / (maxDays + 1)) * 100)); return `<div class="plan-row ${t.attention === 'critical' ? 'critical' : ''}"><div class="plan-date">${escapeHtml(formatDateShort(t.deadline))}</div><div>${escapeHtml(shortLabel(t.project, 24))}</div><div><button class="task-link task-link-plan" type="button" data-task-id="${escapeAttr(t.id)}" title="${escapeAttr(t.title)}">${escapeHtml(t.title)}</button><div class="plan-bar"><span style="width:${width}%"></span></div></div><div>${escapeHtml(t.responsible)}</div></div>`; }).join('') || '<div class="attention-empty">Нет задач со сроками.</div>'}</div>
  </section>`;
}

function renderQuality(quality) {
  const banner = document.getElementById('qualityBanner');
  const warnings = quality?.warnings || [];
  banner.hidden = !warnings.length;
  banner.textContent = warnings.join(' · ');
}

function renderLoading(text) { document.getElementById('viewRoot').innerHTML = `<div class="loading-state">${escapeHtml(text || 'Загрузка…')}</div>`; }
function renderEmpty() { document.getElementById('viewRoot').innerHTML = `<div class="loading-state">Нет данных. Нажмите «Обновить» и выберите выгрузку задач из Bitrix.</div>`; document.getElementById('updatedAt').textContent = 'Нет данных'; }
function renderError(message) { document.getElementById('viewRoot').innerHTML = `<div class="error-state"><strong>Не удалось обработать данные.</strong><div style="margin-top:8px">${escapeHtml(message)}</div></div>`; }



function renderProjectDetail(projectId) {
  const def = itoProjectById(projectId);
  const snapshot = state.currentSnapshot;
  if (!def || !snapshot) return;
  const rows = snapshot.tasks.filter(t => t.projectId === projectId && !t.isCompleted);
  const summary = summarizeProjectsV2(snapshot.tasks, snapshot).find(p => p.id === projectId);
  const active = rows.filter(t => t.loadRelevant);
  const control = rows.filter(t => t.isWaitingControl);
  const attention = rows.filter(t => t.attention === 'critical' || t.attention === 'watch');
  const debt = rows.filter(t => t.debt !== 'none');
  document.getElementById('viewRoot').innerHTML = `<section class="view-card"><div class="view-head"><div><button class="panel-link" data-open-view="projects">← проекты</button><h2>${escapeHtml(def.name)}</h2><p>${escapeHtml(def.type)} · ближайший срок ${escapeHtml(summary?.nextDeadline ? formatDateShort(summary.nextDeadline) : '—')} · последнее движение ${escapeHtml(relativeMovement(summary?.lastMovementAt, snapshot.asOf))}</p></div><div class="summary-strip"><span class="summary-chip">активно ${active.length}</span><span class="summary-chip">контроль ${control.length}</span><span class="summary-chip">сигналы ${attention.length}</span><span class="summary-chip">долг ${debt.length}</span></div></div>
    ${renderTaskGroup('Требует внимания', attention)}
    ${renderTaskGroup('Активные задачи', active)}
    ${renderTaskGroup('Ждёт контроля', control)}
    ${renderTaskGroup('Старый долг', debt)}
  </section>`;
}

function renderPersonDetail(personName) {
  const snapshot = state.currentSnapshot;
  if (!snapshot) return;
  const person = summarizePeopleV2(snapshot.tasks, state.presence, ITO_ROSTER).find(p => p.name === personName);
  if (!person) return;
  const owned = snapshot.tasks.filter(t => canonicalItoName(t.responsible) === personName && !t.isCompleted);
  const active = owned.filter(t => t.loadRelevant);
  const control = owned.filter(t => t.isWaitingControl);
  const attention = snapshot.tasks.filter(t => (t.attention === 'critical' || t.attention === 'watch') && (t.ballOwner?.people || []).some(p => canonicalItoName(p) === personName));
  const debt = owned.filter(t => t.debt !== 'none');
  document.getElementById('viewRoot').innerHTML = `<section class="view-card"><div class="view-head"><div><button class="panel-link" data-open-view="people">← люди</button><h2>${escapeHtml(personName)}</h2><p>${escapeHtml(person.location)}</p></div><div class="summary-strip"><span class="summary-chip">активно ${active.length}</span><span class="summary-chip">контроль ${control.length}</span><span class="summary-chip">сигналы ${attention.length}</span><span class="summary-chip">долг ${debt.length}</span></div></div>
    ${renderTaskGroup('Активно сейчас', active)}
    ${renderTaskGroup('Ждёт контроля', control)}
    ${renderTaskGroup('Свежие сигналы', attention)}
    ${renderTaskGroup('Старый долг', debt)}
  </section>`;
}

function renderTaskGroup(title, rows) {
  return `<section class="detail-group"><h3>${escapeHtml(title)}</h3>${rows.length ? rows.map(t=>`<button class="detail-task-row" type="button" data-task-id="${escapeAttr(t.id)}"><span>${escapeHtml(t.title)}</span><small>${escapeHtml(t.project)} · ${escapeHtml(t.responsible)}${t.deadline ? ' · '+formatDateShort(t.deadline) : ''}</small></button>`).join('') : '<div class="attention-empty">Нет задач.</div>'}</section>`;
}

function openTaskDetail(taskId) {
  const task = state.currentSnapshot?.tasks?.find(item => String(item.id) === String(taskId));
  if (!task) return;
  const dialog = document.getElementById('taskDialog');
  if (!dialog) return;
  document.getElementById('taskDetailProject').textContent =
    task.project && task.project !== 'Вне активных проектов' ? task.project : 'ЗАДАЧА';
  document.getElementById('taskDetailTitle').textContent = task.title || 'Без названия';
  const meta = [
    task.responsible ? `Ответственный · ${task.responsible}` : '',
    task.status ? `Статус · ${task.status}` : '',
    task.deadline ? `Срок · ${formatDateTime(task.deadline)}` : 'Без срока',
    task.id ? `ID · ${task.id}` : '',
    task.changed ? `Изменена · ${formatDateTime(task.changed)}` : '',
    task.inactivityDays ? `Без движения · ${task.inactivityDays} дн.` : '',
    task.attention !== 'none' ? `Attention · ${task.attentionReason || task.attention}` : '',
    task.debt !== 'none' ? `Debt · ${task.debt}` : '',
    task.ballOwner?.people?.length ? `Мяч · ${task.ballOwner.people.join(', ')}` : '',
    task.loadRelevant ? 'Класс · live' : ''
  ].filter(Boolean);
  document.getElementById('taskDetailMeta').innerHTML =
    meta.map(value => `<span>${escapeHtml(value)}</span>`).join('');
  const description = cleanMultilineText(task.description || '');
  document.getElementById('taskDetailDescription').textContent =
    description || 'Описание в выгрузке не заполнено.';
  const parentWrap = document.getElementById('taskDetailParentWrap');
  const parent = document.getElementById('taskDetailParent');
  if (task.parentTitle) {
    parent.textContent = task.parentTitle;
    parentWrap.hidden = false;
  } else {
    parent.textContent = '';
    parentWrap.hidden = true;
  }
  dialog.showModal();
}
