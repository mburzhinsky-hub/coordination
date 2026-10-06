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
      ${renderProjectsPanel(projects.slice(0, 6))}
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
        <td title="${escapeAttr(person.focus)}">${escapeHtml(person.focus || '—')}</td>
        <td>${person.projectCount}</td><td>${person.liveCount}</td>
        <td>${statusPill(person.status)}</td>
      </tr>`).join('') || `<tr><td colspan="5">Нет сотрудников в текущем срезе.</td></tr>`}
    </tbody></table>
  </section>`;
}

function renderAttentionPanel(items, debtCount) {
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Требует внимания</h2><button class="panel-link" data-open-view="attention">все →</button></div>
    ${items.length ? `<div class="attention-list">${items.map(item => `<div class="attention-row"><span class="signal-dot ${item.severity}"></span><div class="attention-main"><strong>${escapeHtml(item.project)}</strong> — ${escapeHtml(item.label)}</div><div class="attention-age ${item.severity}">${escapeHtml(item.when)}</div></div>`).join('')}</div>` : `<div class="attention-empty">Новых оперативных сигналов нет.</div>`}
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
  const rankedProjects = [...projects].sort((a,b) => presenceProjectWeight(presence, b.name) - presenceProjectWeight(presence, a.name) || b.liveTasks - a.liveTasks).slice(0, 4);
  const shownPeople = people;
  return `<section class="panel">
    <div class="panel-head"><h2 class="panel-title">Кто где занят</h2><span class="panel-menu">•••</span></div>
    ${rankedProjects.length ? `<table class="presence-table"><thead><tr><th></th>${rankedProjects.map(p => `<th title="${escapeAttr(p.name)}">${escapeHtml(shortLabel(p.name, 14))}</th>`).join('')}</tr></thead><tbody>
      ${shownPeople.map(person => `<tr><td>${escapeHtml(person.name)}</td>${rankedProjects.map(project => `<td class="presence-cell level-${presenceLevel(presence, person.name, project.name)}"></td>`).join('')}</tr>`).join('')}
    </tbody></table>` : `<div class="attention-empty">Матрица появится после заполнения ежедневного контекста.</div>`}
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
      ${people.map(p => `<tr><td><div class="person-cell"><span class="avatar">${escapeHtml(initials(p.name))}</span><span>${escapeHtml(p.name)}</span></div></td><td>${escapeHtml(p.focus || '—')}</td><td>${p.projectCount}</td><td>${p.liveCount}</td><td>${p.hours ? escapeHtml(formatHours(p.hours)) : '—'}</td><td>${p.attentionCount}</td><td>${p.debtCount}</td><td>${statusPill(p.status)}</td></tr>`).join('')}
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
    <div class="attention-full-list">${items.map(item => `<article class="attention-card"><i class="signal-dot ${item.severity}"></i><div><h3>${escapeHtml(item.project)} — ${escapeHtml(item.label)}</h3><p>${escapeHtml(item.detail)}${item.owner ? ` · Мяч: ${escapeHtml(item.owner)}` : ''}</p></div><div class="attention-meta">${escapeHtml(item.when)}</div></article>`).join('') || '<div class="attention-empty">Оперативных сигналов нет.</div>'}</div>
    <details class="debt-section"><summary>Старый долг · ${debt.length}</summary>${debt.length ? `<table class="data-table detail-table"><thead><tr><th>Задача</th><th>Проект</th><th>Ответственный</th><th>Просрочка</th><th>Без движения</th><th>Класс</th></tr></thead><tbody>${debt.map(t => `<tr><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.project)}</td><td>${escapeHtml(t.responsible)}</td><td>${t.overdueDays ? `${t.overdueDays} дн.` : '—'}</td><td>${t.inactivityDays} дн.</td><td>${escapeHtml(t.debt)}</td></tr>`).join('')}</tbody></table>` : ''}</details>
  </section>`;
}

function renderPlanView(snapshot) {
  const tasks = snapshot.tasks.filter(t => !t.isCompleted && t.deadline && t.debt === 'none').sort((a,b) => a.deadline - b.deadline).slice(0, 40);
  const maxDays = Math.max(1, ...tasks.map(t => Math.max(0, diffDays(t.deadline, new Date(snapshot.asOf)))));
  document.getElementById('viewRoot').innerHTML = `<section class="view-card">
    <div class="view-head"><div><h2>План</h2><p>Ближайшие сроки без legacy-задач.</p></div><div class="summary-strip"><span class="summary-chip">на шкале ${tasks.length}</span></div></div>
    <div class="plan-list">${tasks.map(t => { const days = diffDays(t.deadline, new Date(snapshot.asOf)); const width = Math.max(5, Math.min(100, ((Math.max(0, days) + 1) / (maxDays + 1)) * 100)); return `<div class="plan-row ${t.attention === 'critical' ? 'critical' : ''}"><div class="plan-date">${escapeHtml(formatDateShort(t.deadline))}</div><div>${escapeHtml(shortLabel(t.project, 24))}</div><div><div>${escapeHtml(t.title)}</div><div class="plan-bar"><span style="width:${width}%"></span></div></div><div>${escapeHtml(t.responsible)}</div></div>`; }).join('') || '<div class="attention-empty">Нет задач со сроками.</div>'}</div>
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

