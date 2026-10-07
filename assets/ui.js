'use strict';
function renderOverview(snapshot) {
  const presence = state.presence || { people: {} };
  const roster = mergeRoster(snapshot.tasks, state.roster, presence);
  const people = summarizePeopleV2(snapshot.tasks, presence, roster);
  const projects = summarizeProjectsV2(snapshot.tasks);
  const attention = buildAttentionItems(snapshot);
  const debtCount = snapshot.tasks.filter(t => t.debt && t.debt !== 'none').length;
  const reserveCount = people.filter(p => p.status === 'reserve').length;
  const root = document.getElementById('viewRoot');
  root.innerHTML = `
    <div class="kpi-grid">
      ${kpiCard(people.length, 'сотрудников', '♙', 'people')}
      ${kpiCard(projects.length, 'проектов', '□', 'projects')}
      ${kpiCard(attention.length, 'требуют внимания', '!', 'attention')}
      ${kpiCard(reserveCount, 'есть резерв', '▥', 'reserve')}
    </div>
    <div class="dashboard-grid">
      ${renderTeamPanel(people)}
      ${renderAttentionPanel(attention.slice(0, 4), debtCount)}
    </div>
    <div class="dashboard-grid dashboard-grid-bottom">
      ${renderProjectsPanel(projects)}
      ${renderPresencePanel(people, projects, presence)}
    </div>`;
}

function kpiCard(value, label, icon, kind) {
  return `<article class="kpi-card" data-kind="${escapeAttr(kind)}"><div><div class="kpi-value">${escapeHtml(value)}</div><div class="kpi-label">${escapeHtml(label)}</div></div><div class="kpi-icon">${escapeHtml(icon)}</div></article>`;
}

function renderTeamPanel(people) {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Команда</h2><button class="panel-link" data-open-view="people">все →</button></div>
    <table class="data-table team-table"><thead><tr><th style="width:27%">Сотрудник</th><th style="width:30%">Сейчас в работе</th><th style="width:11%">Проекты</th><th style="width:10%">Задач</th><th style="width:22%">Статус</th></tr></thead><tbody>
      ${people.map(person => `<tr>
        <td><div class="person-cell"><span class="avatar">${escapeHtml(initials(person.name))}</span><span class="person-name">${escapeHtml(person.name)}</span></div></td>
        <td>${person.focusTaskId ? `<button class="task-link task-link-compact" type="button" data-task-id="${escapeAttr(person.focusTaskId)}" title="${escapeAttr(person.focus)}">${escapeHtml(person.focus || '—')}</button>` : escapeHtml(person.focus || '—')}</td>
        <td>${person.projectCount}</td><td>${person.liveCount}</td>
        <td>${statusPill(person.status)}</td>
      </tr>`).join('') || `<tr><td colspan="5">Нет сотрудников в текущем срезе.</td></tr>`}
    </tbody></table>
  </section>`;
}

function renderAttentionPanel(items, debtCount) {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Требует внимания</h2><button class="panel-link" data-open-view="attention">все →</button></div>
    ${items.length ? `<div class="attention-list">${items.map(item => `<button class="attention-row attention-row-button" type="button" data-task-id="${escapeAttr(item.taskId)}"><span class="signal-dot ${item.severity}"></span><div class="attention-main"><div class="attention-project">${escapeHtml(item.project)}</div><div class="attention-task-title">${escapeHtml(item.detail)}</div><div class="attention-reason">${escapeHtml(item.label)}</div></div><div class="attention-age ${item.severity}">${escapeHtml(item.when)}</div></button>`).join('')}</div>` : `<div class="attention-empty">Новых оперативных сигналов нет.</div>`}
    <div class="debt-link"><span>Старый долг</span><span>${debtCount}</span></div>
  </section>`;
}

function renderProjectsPanel(projects) {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Проекты</h2><button class="panel-link" data-open-view="projects">все →</button></div>
    <table class="data-table"><thead><tr><th style="width:27%">Проект</th><th style="width:29%">Ответственный</th><th style="width:28%">Этап</th><th style="width:16%">Риск</th></tr></thead><tbody>
      ${projects.map(p => `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td>${escapeHtml(p.responsible || '—')}</td><td>${escapeHtml(p.stage)}</td><td>${projectRisk(p.risk)}</td></tr>`).join('') || `<tr><td colspan="4">Нет активных проектов.</td></tr>`}
    </tbody></table>
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
  const people = summarizePeopleV2(snapshot.tasks, state.presence, mergeRoster(snapshot.tasks, state.roster, state.presence));
  const overloaded = people.filter(p => p.status === 'overload').length;
  const risk = people.filter(p => p.status === 'risk').length;
  const reserve = people.filter(p => p.status === 'reserve').length;
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>Люди</h2><p>Старый долг не считается текущей нагрузкой.</p></div><div class="summary-strip"><span class="summary-chip">перегруз ${overloaded}</span><span class="summary-chip">риск ${risk}</span><span class="summary-chip">резерв ${reserve}</span></div></div>
    <table class="data-table detail-table"><thead><tr><th>Сотрудник</th><th>Сейчас в работе</th><th>Проекты</th><th>Живых задач</th><th>Часы</th><th>Свежие сигналы</th><th>Старый долг</th><th>Статус</th></tr></thead><tbody>
      ${people.map(p => `<tr><td><div class="person-cell"><span class="avatar">${escapeHtml(initials(p.name))}</span><span>${escapeHtml(p.name)}</span></div></td><td>${p.focusTaskId ? `<button class="task-link task-link-table" type="button" data-task-id="${escapeAttr(p.focusTaskId)}" title="${escapeAttr(p.focus)}">${escapeHtml(p.focus || '—')}</button>` : escapeHtml(p.focus || '—')}</td><td>${p.projectCount}</td><td>${p.liveCount}</td><td>${p.hours ? escapeHtml(formatHours(p.hours)) : '—'}</td><td>${p.attentionCount}</td><td>${p.debtCount}</td><td>${statusPill(p.status)}</td></tr>`).join('')}
    </tbody></table></section>`;
}

function renderProjectsView(snapshot) {
  const projects = summarizeProjectsV2(snapshot.tasks);
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>Проекты</h2><p>Project identity берётся из родительской / базовой задачи Bitrix.</p></div><div class="summary-strip"><span class="summary-chip">активных ${projects.length}</span><span class="summary-chip">с вниманием ${projects.filter(p => p.attentionCount).length}</span></div></div>
    <table class="data-table detail-table"><thead><tr><th>Проект</th><th>Ответственный</th><th>Этап</th><th>Живых задач</th><th>Людей</th><th>Ближайший срок</th><th>Свежие сигналы</th><th>Старый долг</th><th>Риск</th></tr></thead><tbody>
      ${projects.map(p => `<tr><td><strong>${escapeHtml(p.name)}</strong><div class="secondary">${escapeHtml(p.fullName)}</div></td><td>${escapeHtml(p.responsible || '—')}</td><td>${escapeHtml(p.stage)}</td><td>${p.liveTasks}</td><td>${p.peopleCount}</td><td>${escapeHtml(p.nextDeadline ? formatDateShort(p.nextDeadline) : '—')}</td><td>${p.attentionCount}</td><td>${p.debtCount}</td><td>${projectRisk(p.risk)}</td></tr>`).join('')}
    </tbody></table></section>`;
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
    task.id ? `ID · ${task.id}` : ''
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
