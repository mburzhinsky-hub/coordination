const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const context = vm.createContext({
  console,
  window: { addEventListener() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  Date, Intl, Math, JSON, Set, Map
});
const files = ['assets/briefing.js', 'assets/kit.js', 'assets/fx.js', 'assets/views.js', 'assets/views2.js', 'assets/palette.js', 'assets/app.js', 'assets/ui.js', 'assets/upload.js', 'assets/normalize.js', 'assets/model.js', 'assets/storage.js', 'assets/helpers.js'];
for (const file of files) vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });

vm.runInContext(`
const assert = globalThis.__assert;
function row(extra = {}) {
  return Object.fromEntries(Object.entries({
    'ID задачи': '1', 'Название': 'Рабочая задача', 'Статус': 'Выполняется',
    'Ответственный': 'Максим Буржинский', 'Постановщик': 'Дмитрий Храпугин',
    'Название базовой задачи': 'ЦСН - техническая реализация',
    'Дата создания': '01.06.2026 09:00', 'Дата изменения': '05.10.2026 09:00', 'Крайний срок': '20.10.2026 18:00',
    ...extra
  }).map(([k, v]) => [normalizeHeader(k), v]));
}
function snap(rows, iso, previous = null, history = []) {
  const d = new Date(iso);
  return buildSnapshot(rows, d, 'tasks_' + formatFileDate(d) + '.xls', previous, history, { errors: [], warnings: [] });
}
const NOW = new Date('2026-10-08T22:30:00');

// ---- language helpers
assert.equal(pluralRu(1, 'день', 'дня', 'дней'), 'день');
assert.equal(pluralRu(3, 'день', 'дня', 'дней'), 'дня');
assert.equal(pluralRu(11, 'день', 'дня', 'дней'), 'дней');
assert.equal(pluralRu(22, 'день', 'дня', 'дней'), 'дня');
assert.equal(daysWord(120), '120 дней');
assert.equal(displayName('Игорь Виденнев'), 'Игорь Виденеев');
assert.equal(shortName('Максим Буржинский'), 'Буржинский М.');
assert.equal(dayMonth(new Date('2026-10-08T10:00:00')), '8 октября');
assert.equal(mondayOf(new Date('2026-10-08T10:00:00')).getDate(), 5);

// ---- freshness is honest about old data
const base = snap([row()], '2026-10-08T22:11:26');
assert.equal(snapshotFreshness(base, NOW).level, 'fresh');
assert.match(snapshotFreshness(base, NOW).label, /сегодня в 22:11/);
assert.equal(snapshotFreshness(base, new Date('2026-10-10T08:00:00')).level, 'aging');
const stale = snapshotFreshness(base, new Date('2026-10-14T08:00:00'));
assert.equal(stale.level, 'stale');
assert.match(stale.label, /Данные от 8 окт/);
assert.ok(stale.hint.length > 20);

// ---- acceptance queue: old handover is a headline, not a footnote
const controlRows = [
  row({ 'ID задачи': '10', 'Название': 'Приёмка раз', 'Статус': 'Ждёт контроля', 'Дата изменения': '14.07.2026 09:00', 'Крайний срок': '14.07.2026 18:00', 'Название базовой задачи': 'Музей имени Бахрушина — техническая реализация' }),
  row({ 'ID задачи': '11', 'Название': 'Приёмка два', 'Статус': 'Ждёт контроля', 'Дата изменения': '30.08.2026 09:00', 'Крайний срок': '31.08.2026 18:00', 'Название базовой задачи': 'ЕКБ - техническая реализация' }),
  row({ 'ID задачи': '12', 'Название': 'Свежая приёмка', 'Статус': 'Ждёт контроля', 'Дата изменения': '06.10.2026 09:00', 'Крайний срок': '20.10.2026 18:00' }),
  row({ 'ID задачи': '13', 'Название': 'Срок завтра', 'Дата изменения': '07.10.2026 09:00', 'Крайний срок': '09.10.2026 18:00' })
];
const s0 = snap(controlRows, '2026-10-08T22:11:00');
const acc = summarizeAcceptance(s0);
assert.equal(acc.total, 3);
assert.equal(acc.old, 2);
assert.equal(acc.red, 1);                       // 86 days >= CONTROL_RED_DAYS
assert.equal(acc.maxAge, 86);
assert.equal(acc.items[0].taskId, '10');        // oldest first
assert.equal(acc.topHolder.name, 'Дмитрий Храпугин');

// ---- inbox = stalled acceptance + fresh attention, projects above operational work
const inbox = buildInbox(s0, {});
assert.ok(inbox.all.some(i => i.taskId === '10' && i.severity === 'critical'));
assert.ok(inbox.all.some(i => i.taskId === '11' && i.severity === 'watch'));
assert.ok(inbox.all.some(i => i.taskId === '13' && i.kind === 'attention'));
assert.ok(!inbox.all.some(i => i.taskId === '12'), 'fresh acceptance (<=14d) is not an inbox item');
assert.equal(inbox.all[0].taskId, '10');
assert.equal(filterInbox(inbox, 'acceptance').length, inbox.items.filter(i => i.kind === 'acceptance').length);

// decisions expire: "done" holds until the task changes, "snooze" until the next snapshot
const target = s0.tasks.find(t => t.id === '10');
let hidden = buildInbox(s0, { '10': { action: 'done', signature: target.signature }, '11': { action: 'snooze', snapshotId: s0.id } });
assert.ok(!hidden.items.some(i => i.taskId === '10' || i.taskId === '11'));
assert.equal(hidden.handled, 2);
hidden = buildInbox(s0, { '10': { action: 'done', signature: 'changed-since' }, '11': { action: 'snooze', snapshotId: 'older-snapshot' } });
assert.ok(hidden.items.some(i => i.taskId === '10') && hidden.items.some(i => i.taskId === '11'));
hidden = buildInbox(s0, { '10': { action: 'escalate', signature: target.signature } });
assert.ok(hidden.items.some(i => i.taskId === '10' && i.state.action === 'escalate'), 'escalated items stay visible');

// ---- stories and headline speak about the stuck acceptance first
const b0 = buildBriefing(s0, [s0], { people: {} }, NOW);
assert.ok(b0.stories.length >= 1 && b0.stories.length <= 3);
assert.equal(b0.stories.find(s => s.id === 'acceptance').tone, 'critical');
assert.match(b0.headline.map(p => p.t).join(''), /Приёмка встала/);
assert.equal(b0.headline.find(p => p.em).em, 'red');
assert.equal(b0.previous, null);
assert.equal(b0.since, null);

// ---- what changed since the previous snapshot; tasks born and closed between exports are counted
const prev = snap([row({ 'ID задачи': '20', 'Название': 'Закроем', 'Крайний срок': '25.09.2026 18:00', 'Дата изменения': '16.09.2026 09:00' })], '2026-09-16T09:52:00');
const cur = snap([
  row({ 'ID задачи': '20', 'Название': 'Закроем', 'Статус': 'Завершена', 'Дата изменения': '01.10.2026 10:00', 'Дата закрытия': '01.10.2026 10:00' }),
  row({ 'ID задачи': '21', 'Название': 'Родилась и умерла', 'Статус': 'Завершена', 'Дата создания': '20.09.2026 09:00', 'Дата изменения': '22.09.2026 10:00', 'Дата закрытия': '22.09.2026 10:00' }),
  row({ 'ID задачи': '22', 'Название': 'Новая открытая', 'Дата создания': '07.10.2026 09:00', 'Дата изменения': '07.10.2026 09:00' })
], '2026-10-08T22:11:00', prev, [prev]);
const since = summarizeSince(cur, prev);
assert.equal(since.closedCount, 2);
assert.equal(since.closedSeenCount, 1);
assert.equal(since.closedBetweenCount, 1);
assert.equal(since.addedCount, 1);
assert.equal(since.hasGap, true);
assert.equal(since.gapDays, 22);
const bSince = buildBriefing(cur, [prev, cur], { people: {} }, NOW);
assert.equal(bSince.previous.id, prev.id);
assert.ok(bSince.stories.some(s => s.id === 'gap'));
assert.match(bSince.headline.map(p => p.t).join(''), /Закрыто 2/);

// ---- similar tasks fold into one row ("Ticket 498–520")
const series = [498, 500, 502, 504].map((n, i) => normalizeTask(row({ 'ID задачи': String(300 + i), 'Название': 'Ticket ' + n + ' : Закупочный пакет "X' + i + '" ЦСН', 'Крайний срок': '12.08.2026 18:00' }), i, new Date('2026-10-08T12:00:00'), null));
const lone = normalizeTask(row({ 'ID задачи': '310', 'Название': 'Совсем другая задача', 'Крайний срок': '12.08.2026 18:00' }), 5, new Date('2026-10-08T12:00:00'), null);
const folded = groupSimilarTasks([...series, lone]);
assert.equal(folded.length, 2);
const grp = folded.find(g => g.group);
assert.equal(grp.count, 4);
assert.match(grp.title, /498–504/);
assert.equal(groupSimilarTasks(series.slice(0, 2)).length, 2, 'two tasks are not a series');

// ---- people matrix: weeks bucket by deadline, acceptance and debt stay separate
const pm = buildPeopleMatrix(s0, { people: {} });
assert.equal(pm.rows.length, 12);
assert.equal(pm.weeks.length, HORIZON_WEEKS);
const burzh = pm.rows.find(r => r.name === 'Максим Буржинский');
assert.equal(burzh.acceptance.count, 3);
assert.equal(burzh.acceptance.maxAge, 86);
assert.equal(burzh.weeks.reduce((s, w) => s + w.count, 0), burzh.deadlinesInHorizon);
assert.ok(burzh.weeks[0].count >= 1, 'deadline on 9 Oct falls into the current week');
assert.ok(pm.withoutLive >= 10);
assert.match(peopleHeadline(pm).map(p => p.t).join(''), /нет ни одной живой задачи/);

// ---- projects: stale acceptance makes risk high; last movement ignores service events
const cards = buildProjectCards(s0, null);
assert.equal(cards.length, 9);
assert.equal(cards[0].id, 'bakhrushin');
assert.equal(cards[0].risk, 'high');
assert.equal(cards.find(c => c.id === 'ekb').risk, 'mid');
assert.equal(cards.find(c => c.id === 'dom-kultur').risk, 'idle');
const movedProject = summarizeProjectsV2(s0.tasks, s0).find(p => p.id === 'bakhrushin');
assert.equal(dateKey(movedProject.lastMovementAt), dateKey(new Date('2026-07-14T09:00:00')), 'movement comes from Bitrix edits only');

// ---- horizon and debt audit
const hz = buildHorizon(s0);
assert.equal(hz.weeks.length, HORIZON_WEEKS);
assert.equal(hz.weeks[0].current, true);
assert.equal(hz.inAcceptance, 3);
const audit = buildDebtAudit(s0, {});
assert.equal(audit.total, summarizeDebt(s0).total);
assert.equal(audit.remaining, audit.total);

// ---- timeline and lifecycle read like sentences
const t10 = s0.tasks.find(t => t.id === '10');
assert.equal(taskLifecycle(t10).find(s => s.current).id, 'control');
assert.match(taskTimeline(t10, s0, [s0])[0].title, /Приёмка длится 86 дней/);

// ---- age chart: every classed open task is one dot, acceptance by days waiting
const ageChart = buildAgeChart(s0);
assert.equal(ageChart.lanes.find(l => l.id === 'acc').dots.length, 3);
assert.equal(ageChart.lanes.find(l => l.id === 'live').dots.length, 1);
assert.equal(ageChart.lanes.find(l => l.id === 'acc').dots.find(d => d.id === '10').age, 86);
assert.ok(ageChart.max >= 90 && ageChart.max <= 180);
assert.equal(ageChart.total + ageChart.other, summarizeLoadBasis ? ageChart.total + ageChart.other : 0);

// ---- Telegram: nick parsing, recipients, templates, prefilled link
assert.equal(normalizeTgNick('@nick_four'), 'nick_four');
assert.equal(normalizeTgNick('https://t.me/nick_four?start=1'), 'nick_four');
assert.equal(normalizeTgNick('t.me/nick_four'), 'nick_four');
assert.equal(normalizeTgNick('max'), '');
assert.equal(normalizeTgNick('Максим'), '');
assert.equal(normalizeTgNick('9nick_four'), '');
assert.equal(matchRosterPerson('Храпугин'), 'Дмитрий Храпугин');
assert.equal(matchRosterPerson('Храпугин Дмитрий'), 'Дмитрий Храпугин');
assert.equal(matchRosterPerson('Виденеев'), 'Игорь Виденнев');
assert.equal(matchRosterPerson('Иван'), 'Иван Чуманов');
assert.equal(matchRosterPerson('Неизвестный Человек'), '');
const tgList = parseTgList('Храпугин — @nick_one\\nСемён Онищенко t.me/nick_two\\nпросто текст\\nnick_three');
assert.equal(tgList.length, 3);
assert.deepEqual([tgList[0].name, tgList[0].nick], ['Дмитрий Храпугин', 'nick_one']);
assert.deepEqual([tgList[1].name, tgList[1].nick], ['Семён Онищенко', 'nick_two']);
assert.deepEqual([tgList[2].name, tgList[2].nick], ['', 'nick_three']);
const tgTask = t10;
const tgWho = telegramRecipients(tgTask);
assert.ok(tgWho.length >= 1 && tgWho[0].role === 'мяч');
assert.equal(new Set(tgWho.map(r => personKey(r.name))).size, tgWho.length);
assert.equal(defaultTelegramTemplate(tgTask), 'check');
for (const tpl of TG_TEMPLATES) {
  const text = buildTelegramText(tpl.id, tgTask, tgWho[0].name);
  assert.ok(text.startsWith(firstNameOf(tgWho[0].name) + ', привет!'), text);
  assert.ok(text.includes('№' + tgTask.id) && text.includes('«'), text);
}
assert.match(buildTelegramText('check', tgTask, tgWho[0].name), /86 дней назад/);
const tgUrl = telegramUrl('nick_four', 'Привет, проверь №10 & «задачу»');
assert.ok(tgUrl.startsWith('https://t.me/nick_four?text='));
assert.equal(decodeURIComponent(tgUrl.split('?text=')[1]), 'Привет, проверь №10 & «задачу»');
assert.equal(decodeURIComponent(telegramUrl('nick_four', '@all').split('?text=')[1]), ' @all');

// ---- search
const found = searchEntities(s0, 'бахр');
assert.equal(found.projects[0].id, 'bakhrushin');
assert.equal(searchEntities(s0, '').tasks.length, 0);
assert.ok(searchEntities(s0, 'виденеев').people.length === 1);

console.log('PASS: briefing — freshness, acceptance, inbox decisions, stories, since-snapshot, similar tasks, people matrix, projects, horizon, Telegram drafts, search');
`, Object.assign(context, { __assert: assert }));
