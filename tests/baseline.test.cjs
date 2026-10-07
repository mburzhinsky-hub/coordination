const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const context = vm.createContext({
  console,
  window: { addEventListener() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  Date,
  Intl,
  Math,
  JSON,
  Set,
  Map
});
for (const file of ['assets/app.js','assets/ui.js','assets/upload.js','assets/normalize.js','assets/model.js','assets/storage.js','assets/helpers.js']) vm.runInContext(readFileSync(file,'utf8'), context);

vm.runInContext(`
const assert = globalThis.__assert;
function row(extra = {}) {
  return Object.fromEntries(Object.entries({
    'ID задачи':'1',
    'Название':'Рабочая задача',
    'Статус':'Выполняется',
    'Ответственный':'Инженер',
    'Постановщик':'Координатор',
    'Название базовой задачи':'ЦСН - техническая реализация',
    'Дата создания':'01.09.2026 09:00',
    'Дата изменения':'01.10.2026 09:00',
    'Крайний срок':'02.10.2026 18:00',
    ...extra
  }).map(([k,v])=>[normalizeHeader(k),v]));
}
function snap(rows, iso, previous=null, history=[]) {
  const d = new Date(iso);
  return buildSnapshot(rows,d,'tasks_'+formatFileDate(d)+'.xls',previous,history,{errors:[],warnings:[]});
}

// ITO roster is closed: external Bitrix participants never become department employees.
assert.equal(ITO_ROSTER.length, 12);
assert.deepEqual(mergeRoster([], ['Внешний сотрудник'], {people:{'Внешний сотрудник':{}}}), ITO_ROSTER);
assert.equal(canonicalItoName('Буржинский Максим'), 'Максим Буржинский');
assert.equal(canonicalItoName('Игорь Виденеев'), 'Игорь Виденнев');
assert.equal(isItoMember('Внешний сотрудник'), false);
// Bitrix reverse name order is assigned to the correct ITO employee.
const reversed = normalizeTask(row({'Ответственный':'Буржинский Максим'}),0,new Date('2026-10-06T09:00:00'),null);
const reversedPeople = summarizePeopleV2([reversed], {people:{}}, []);
assert.equal(reversedPeople.find(p => p.name === 'Максим Буржинский').liveCount, 1);
const externalPeople = summarizePeopleV2([normalizeTask(row({'Ответственный':'Внешний сотрудник'}),0,new Date('2026-10-06T09:00:00'),null)], {people:{}}, ['Внешний сотрудник']);
assert.equal(externalPeople.length, 12);
assert.ok(!externalPeople.some(p => p.name === 'Внешний сотрудник'));

// Project identity comes from the Bitrix parent/base task and normalizes display suffixes.
let s1 = snap([row()], '2026-10-01T09:00:00');
assert.equal(s1.tasks[0].project, 'ЦСН');
assert.equal(s1.tasks[0].projectFullName, 'ЦСН — техническая реализация');
assert.equal(projectKey('ЦСН — техническая реализация'), projectKey('ЦСН - техническая реализация'));

// Real 07 October export aliases resolve into the fixed active projects.
assert.equal(resolveItoProject('ЦУМ. Профцентр в Казани')?.id, 'kazan');
assert.equal(resolveItoProject('Грозный. Музей космонавтики(308)')?.id, 'grozny');
assert.equal(resolveItoProject('P211-24-09 Музей ЦСН (ФСБ) Балашиха')?.id, 'csn');
assert.equal(resolveItoProject('Лужники БСА')?.id, 'luzhniki');

const described = normalizeTask(row({
  'Описание':'Первая строка\n\nВторая строка'
}),0,new Date('2026-10-06T09:00:00'),null);
assert.equal(described.description, 'Первая строка\n\nВторая строка');

// Active project registry is fixed to eight projects.
assert.equal(ITO_PROJECTS.length, 8);
const fixedProjects = summarizeProjectsV2(s1.tasks);
assert.equal(fixedProjects.length, 8);
assert.ok(fixedProjects.some(p => p.name === 'Казанский ЦУМ'));
assert.ok(fixedProjects.some(p => p.name === 'Грозный планетарий'));
assert.ok(fixedProjects.some(p => p.name === 'Музей Бахрушина'));
assert.ok(fixedProjects.some(p => p.name === 'ЦСН'));
assert.ok(fixedProjects.some(p => p.name === 'ЕКБ'));
assert.ok(fixedProjects.some(p => p.name === 'Лужники'));
assert.ok(fixedProjects.some(p => p.name === 'Музей Тапиау'));
assert.ok(fixedProjects.some(p => p.name === 'Дом культур'));

// Explicit Bitrix project has priority over an unrelated parent/base task.
const explicitProject = normalizeTask(row({
  'Проект':'Лужники',
  'Название базовой задачи':'Общие офисные и внутренние задачи'
}),0,new Date('2026-10-06T09:00:00'),null);
assert.equal(explicitProject.projectId, 'luzhniki');
assert.equal(explicitProject.project, 'Лужники');

// Parent/base task is the fallback when the explicit project field is empty.
const parentProject = normalizeTask(row({
  'Проект':'',
  'Название базовой задачи':'Музей имени Бахрушина — техническая реализация'
}),0,new Date('2026-10-06T09:00:00'),null);
assert.equal(parentProject.projectId, 'bakhrushin');
assert.equal(parentProject.project, 'Музей Бахрушина');

// Unknown internal parents do not create extra active projects.
const internalTask = normalizeTask(row({
  'Название базовой задачи':'Просчеты ИТО'
}),0,new Date('2026-10-06T09:00:00'),null);
assert.equal(internalTask.projectId, '');
assert.equal(internalTask.project, 'Вне активных проектов');

// Daily location answers office/site/remote/vacation, and site is linked to one active project.
assert.deepEqual(normalizePresenceEntry({mode:'site',projectId:'csn'}), {mode:'site',projectId:'csn'});
assert.deepEqual(normalizePresenceEntry({mode:'remote',projectId:'csn'}), {mode:'remote',projectId:''});
assert.equal(presenceModeLabel('vacation'), 'В отпуске');

// New overdue is current attention.
let s2 = snap([row()], '2026-10-03T09:00:00', s1, [s1]);
assert.equal(s2.tasks[0].overdue, true);
assert.equal(s2.tasks[0].overdueDays, 1);
assert.ok(s2.events.some(e=>e.type==='BECAME_OVERDUE' && e.severity==='critical'));
assert.equal(s2.tasks[0].attention, 'critical');

// Old unchanged overdue becomes legacy debt and is removed from current attention.
let old = snap([row({
  'Дата изменения':'01.07.2026 09:00',
  'Крайний срок':'01.07.2026 18:00'
})], '2026-10-06T09:00:00');
assert.equal(old.tasks[0].debt, 'legacy');
assert.equal(old.tasks[0].attention, 'none');
assert.equal(buildAttentionItems(old).length, 0);
assert.equal(old.tasks[0].loadRelevant, false);

// Legacy task reactivated by a meaningful change returns to attention.
let reactivated = snap([row({
  'Статус':'Выполняется',
  'Ответственный':'Новый инженер',
  'Дата изменения':'06.10.2026 08:00',
  'Крайний срок':'01.07.2026 18:00'
})], '2026-10-06T12:00:00', old, [old]);
assert.ok(reactivated.events.some(e=>e.type==='REACTIVATED'));
assert.equal(reactivated.tasks[0].attention, 'critical');

// Moving the deadline forward is not treated as a successful overdue resolution.
let moved = snap([row({
  'Дата изменения':'06.10.2026 09:00',
  'Крайний срок':'20.10.2026 18:00'
})], '2026-10-06T13:00:00', s2, [s1,s2]);
assert.ok(moved.events.some(e=>e.type==='OVERDUE_DEADLINE_MOVED'));
assert.ok(!moved.events.some(e=>e.type==='OVERDUE_RESOLVED_BY_COMPLETION'));

// Completion is a real resolution.
let completed = snap([row({
  'Статус':'Завершена',
  'Дата изменения':'06.10.2026 10:00',
  'Дата закрытия':'06.10.2026 10:00',
  'Крайний срок':'02.10.2026 18:00'
})], '2026-10-06T14:00:00', s2, [s1,s2]);
assert.ok(completed.events.some(e=>e.type==='OVERDUE_RESOLVED_BY_COMPLETION'));

// Waiting control transfers the ball and does not count as the executor's live load.
let control1 = snap([row({'Статус':'Ждёт контроля','Дата изменения':'01.10.2026 09:00'})], '2026-10-01T09:00:00');
let control3 = snap([row({'Статус':'Ждёт контроля','Дата изменения':'01.10.2026 09:00'})], '2026-10-04T09:00:00', control1, [control1]);
assert.equal(control3.tasks[0].waitingControlDays, 3);
assert.ok(control3.events.some(e=>e.type==='CONTROL_3_DAYS'));
assert.equal(control3.tasks[0].ballOwner.type, 'author');
assert.equal(control3.tasks[0].loadRelevant, false);
let control5 = snap([row({'Статус':'Ждёт контроля','Дата изменения':'01.10.2026 09:00'})], '2026-10-06T09:00:00', control3, [control1,control3]);
assert.ok(control5.events.some(e=>e.type==='CONTROL_5_DAYS'));

// Deadline churn becomes a dedicated attention signal.
let d1 = snap([row({'Крайний срок':'10.10.2026 18:00'})], '2026-10-01T09:00:00');
let d2 = snap([row({'Крайний срок':'12.10.2026 18:00','Дата изменения':'02.10.2026 09:00'})], '2026-10-02T09:00:00', d1, [d1]);
let d3 = snap([row({'Крайний срок':'14.10.2026 18:00','Дата изменения':'03.10.2026 09:00'})], '2026-10-03T09:00:00', d2, [d1,d2]);
let d4 = snap([row({'Крайний срок':'16.10.2026 18:00','Дата изменения':'04.10.2026 09:00'})], '2026-10-04T09:00:00', d3, [d1,d2,d3]);
assert.ok(d4.events.some(e=>e.type==='DEADLINE_CHURN'));

// Removed task is neutral/unknown, never automatic success.
let empty = snap([], '2026-10-07T09:00:00', s2, [s1,s2]);
const removed = empty.events.find(e=>e.type==='TASK_REMOVED');
assert.ok(removed);
assert.equal(removed.severity, 'neutral');

// Project containers are structure, not work.
let containers = snap([row({'ID задачи':'2','Название':'ЦСН - техническая реализация','Название базовой задачи':''})], '2026-10-06T09:00:00');
assert.equal(containers.tasks.length, 0);

// Missing stable task ID blocks history.
const headers = ['ID задачи','Название','Статус','Ответственный'].map(normalizeHeader);
const missingIdQuality = validateRows([row({'ID задачи':''})], headers, null);
assert.ok(missingIdQuality.errors.some(x=>x.includes('ID')));

// Suspicious export shrink requires confirmation.
const q = validateRows([row()], headers, { rawCount: 10 });
assert.equal(q.requiresConfirmation, true);

console.log('PASS: fixed ITO roster/projects, daily location, events, debt separation, control lifecycle, quality gate');
`, Object.assign(context, { __assert: assert }));
