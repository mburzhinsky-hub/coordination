'use strict';
/* Shell: loading/empty/error states, navigation badges, freshness chip, task sheet, toasts, glossary popovers. */

function viewRootEl() { return document.getElementById('viewRoot'); }

function renderLoading(text) {
  const root = viewRootEl();
  if (root) root.innerHTML = `<div class="loading-state" role="status">${dotLoader(7)}<p>${escapeHtml(text || 'Загрузка…')}</p></div>`;
}

function renderEmpty() {
  const root = viewRootEl();
  if (!root) return;
  root.innerHTML = `<div class="onboard">${logoMark(72)}
    <h1>Загрузите первую выгрузку</h1>
    <p>Дашборд читает ежедневную выгрузку задач из Bitrix24 в Excel (.xls). Перетащите файл в это окно или нажмите кнопку.</p>
    <label class="btn btn-dark" for="uploadInput">${icon('upload')}Выбрать файл</label>
    <ol class="onboard-steps"><li><b>1</b>Выгрузите задачи из Bitrix в Excel.</li><li><b>2</b>Загрузите файл сюда. Через день загрузите следующий.</li><li><b>3</b>Со второй выгрузки появятся «что изменилось» и динамика.</li></ol></div>`;
  const updated = document.getElementById('freshChip');
  if (updated) { updated.className = 'chip chip-muted'; updated.textContent = 'Нет данных'; }
}

function renderError(message) {
  const root = viewRootEl();
  if (root) root.innerHTML = `<div class="error-state" role="alert"><h2>Не удалось обработать данные</h2><p>${escapeHtml(message)}</p><label class="btn btn-ghost" for="uploadInput">${icon('upload')}Загрузить другой файл</label></div>`;
}

function renderQuality(quality) {
  const banner = document.getElementById('qualityBanner');
  if (!banner) return;
  const warnings = quality?.warnings || [];
  banner.hidden = !warnings.length;
  banner.innerHTML = warnings.length ? `${sevIcon('watch', 18)}<span>${warnings.map(escapeHtml).join(' · ')}</span>` : '';
}

/** Navigation badges, freshness chip, history banner, document title. */
function renderShell(b) {
  const route = state.route.name;
  const meta = ROUTES[route] || ROUTES.today;
  document.title = `${meta.title} — ИТО`;
  document.querySelectorAll('[data-route]').forEach(link => {
    const on = link.dataset.route === route || (route === 'tv' && link.dataset.route === 'today');
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const inbox = buildInbox(b.snapshot, state.triage);
  const audit = buildDebtAudit(b.snapshot, state.triage);
  setBadge('badgeInbox', inbox.items.length, 'red');
  setBadge('badgeDebt', audit.remaining, 'ink');
  setBadge('tabBadgeInbox', inbox.items.length, 'red');

  const chip = document.getElementById('freshChip');
  if (chip) {
    const fresh = b.freshness;
    if (state.historyMode) {
      chip.className = 'chip chip-blue';
      chip.innerHTML = `<i class="dot"></i>Срез от ${escapeHtml(dayMonthShort(b.snapshot.asOf))} (история)`;
      chip.title = 'Вы смотрите прошлый срез';
    } else {
      chip.className = `chip chip-${fresh.level === 'fresh' ? 'green' : fresh.level === 'aging' ? 'amber' : 'red'}`;
      chip.innerHTML = `<i class="dot"></i>${escapeHtml(fresh.label)}`;
      chip.title = fresh.hint || 'Срез свежий';
    }
  }
  const stale = document.getElementById('freshBanner');
  if (stale) {
    const show = !state.historyMode && b.freshness.level === 'stale';
    stale.hidden = !show;
    stale.innerHTML = show ? `${sevIcon('critical', 22)}<div><b>Срез устарел на ${daysWord(b.freshness.days)}.</b> ${escapeHtml(b.freshness.hint.replace(/^Срез устарел на [^:]+: /, ''))}</div><label class="btn btn-dark btn-sm" for="uploadInput">${icon('upload')}Загрузить выгрузку</label>` : '';
  }
  const hist = document.getElementById('historyBanner');
  if (hist) {
    hist.hidden = !state.historyMode;
    hist.innerHTML = state.historyMode ? `${icon('rewind')}<div><b>Вы смотрите срез ${escapeHtml(dayMonth(b.snapshot.asOf))}, ${clockTime(b.snapshot.asOf)}.</b> Кнопки решений отключены.</div><button class="btn btn-dark btn-sm" type="button" data-action="history-live">Вернуться к актуальному</button>` : '';
  }
  const rows = document.getElementById('railRows');
  if (rows) {
    const raw = b.snapshot.rawCount || 0;
    const used = b.snapshot.tasks.length;
    rows.textContent = `${raw} строк в файле · в расчёте ${used}`;
    rows.title = `${Math.max(0, raw - used)} строк исключено: контейнеры проектов, отложенные и служебные ежедневные задачи.`;
  }
  const when = document.getElementById('railWhen');
  if (when) when.textContent = `Срез ${dayMonthShort(b.snapshot.asOf)}, ${clockTime(b.snapshot.asOf)}`;
  renderSyncStatus();
  renderQuality(b.snapshot.quality);
}

function setBadge(id, count, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !count;
  el.textContent = count || '';
  el.className = `badge badge-${tone}`;
}

/* ---------- Telegram draft for the open task: who, which template, the (editable) text ---------- */

function tgDraftFor(task) {
  const recipients = telegramRecipients(task);
  let draft = state.ui.tg;
  const valid = draft && draft.taskId === String(task.id) && recipients.some(r => personKey(r.name) === personKey(draft.who));
  if (!valid) {
    const who = recipients[0]?.name || '';
    const tpl = defaultTelegramTemplate(task);
    draft = state.ui.tg = { taskId: String(task.id), who, tpl, text: buildTelegramText(tpl, task, who) };
  }
  return draft;
}

/* ---------- task sheet ---------- */

function inboxItemFor(task) {
  return buildInbox(state.currentSnapshot, state.triage).all.find(i => String(i.taskId) === String(task.id)) || null;
}

function renderTaskSheetBody(taskId) {
  const task = state.currentSnapshot?.tasks?.find(item => String(item.id) === String(taskId));
  const body = document.getElementById('taskSheetBody');
  if (!task || !body) return false;
  const b = state.briefing || buildBriefing(state.currentSnapshot, state.snapshots, state.presence, new Date());
  body.innerHTML = taskDetailHtml(task, b, { item: inboxItemFor(task) });
  return true;
}

function openTaskSheet(taskId) {
  const dialog = document.getElementById('taskDialog');
  if (!dialog) return;
  if (!renderTaskSheetBody(taskId)) return;
  state.ui.sheetTask = String(taskId);
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('.sheet-body')?.scrollTo?.(0, 0);
}

function closeTaskSheet() {
  const dialog = document.getElementById('taskDialog');
  state.ui.sheetTask = '';
  if (dialog?.open) dialog.close();
}

/* ---------- toasts and glossary popovers ---------- */

let toastTimer = 0;
function showToast(message, opts = {}) {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast" role="status"><span>${escapeHtml(message)}</span>${opts.undoLabel ? `<button type="button" class="toast-undo" data-action="toast-undo">${escapeHtml(opts.undoLabel)}</button>` : ''}</div>`;
  root.classList.add('is-on');
  state.ui.toastUndo = opts.onUndo || null;
  toastTimer = setTimeout(() => { root.classList.remove('is-on'); state.ui.toastUndo = null; }, opts.ms || 6000);
}

function hideTermPopover() { document.getElementById('termPop')?.remove(); }

function showTermPopover(anchor, key) {
  const term = GLOSSARY[key];
  if (!term) return;
  const already = document.getElementById('termPop');
  hideTermPopover();
  if (already && already.dataset.key === key) return;
  const pop = document.createElement('div');
  pop.id = 'termPop';
  pop.className = 'termpop';
  pop.dataset.key = key;
  pop.setAttribute('role', 'tooltip');
  pop.innerHTML = `<b>${escapeHtml(term.title)}</b><p>${escapeHtml(term.text)}</p><button type="button" class="termpop-more" data-action="help-open">Все термины</button>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2));
  const top = r.bottom + 10 + pop.offsetHeight > window.innerHeight ? r.top - pop.offsetHeight - 10 : r.bottom + 10;
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${top + window.scrollY}px`;
}

/* ---------- task hover card for the age squares ---------- */

const AGE_LANE_LABEL = { acc: 'ждёт приёмки', debt: 'старый долг', live: 'в работе' };

function hideAgePop() { document.getElementById('agePop')?.remove(); }

function showAgePop(anchor) {
  hideAgePop();
  const d = anchor.dataset;
  const pop = document.createElement('div');
  pop.id = 'agePop';
  pop.className = 'agepop';
  pop.setAttribute('role', 'tooltip');
  pop.innerHTML = `<b>${escapeHtml(d.title)}</b>
    <div class="agepop-row"><span class="agepop-chip lane-${escapeAttr(d.lane)}">${escapeHtml(AGE_LANE_LABEL[d.lane] || '')}</span><span>${escapeHtml(daysWord(Number(d.age)))} без движения</span></div>
    ${d.who ? `<div class="agepop-line">${escapeHtml(d.who)}</div>` : ''}
    <div class="agepop-line">${escapeHtml(d.proj)}${d.due ? ` · срок был ${escapeHtml(d.due)}` : ''}</div>
    <div class="agepop-cta">Нажмите, чтобы открыть</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 12 + h < window.innerHeight;
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${(below ? r.bottom + 12 : Math.max(12, r.top - h - 12)) + window.scrollY}px`;
}

function renderHelpBody() {
  return Object.values(GLOSSARY).map(t => `<div class="help-term"><b>${escapeHtml(t.title)}</b><p>${escapeHtml(t.text)}</p></div>`).join('');
}
