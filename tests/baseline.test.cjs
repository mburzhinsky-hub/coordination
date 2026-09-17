const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const storage = new Map();
const context = vm.createContext({
  console, window: {addEventListener() {}},
  localStorage: {getItem: key => storage.get(key), setItem: (key,value) => storage.set(key,value)},
  assert
});
vm.runInContext(readFileSync('assets/app.js','utf8'),context);
vm.runInContext(`
const row = (status = 'Ждёт контроля', extra = {}) => Object.fromEntries(Object.entries({
  ID: '1', Название: 'Рабочая задача', Статус: status, Исполнитель: 'Инженер', Постановщик: 'Координатор',
  'Дата создания': '01.07.2026 10:00', 'Дата изменения': '02.07.2026 10:00',
  'Крайний срок': '10.07.2026 10:00', ...extra
}).map(([k,v]) => [normalizeHeader(k),v]));
let history = new Map();
function snapshot(rows, day) {
  const date = new Date(2026,8,day,9,52,52);
  const name = 'tasks_2026-09-' + day + '_09-52-52.xls';
  history = observeSnapshot(rows,date,name,history);
  return normalizeRows(rows,date,name,history);
}
const base = snapshot([row()],16);
assert.equal(base[0].waitingControlDays,0);
assert.equal(base[0].overdueDays,0);
assert.equal(base[0].staleDays,0);
assert.equal(base[0].overdue,true);
assert.equal(base[0].deadline.getMonth(),6); // Keep the real deadline.
state.tasks=base;
state.exportName=BASELINE_FILE;
state.exportDate=BASELINE_DATE;
assert.equal(buildExportReport().movementRows.length,0);
assert.equal(buildExportReport().diff.added.length,0);
assert.ok(buildExportReport().peopleRows.every(p=>p.totalDelta===0));
assert.ok(buildExportReport().projectRows.every(p=>p.totalDelta===0));
let next = snapshot([row()],17);
assert.equal(next[0].waitingControlDays,1);
assert.equal(next[0].overdueDays,1);
assert.equal(next[0].staleDays,1);
next = snapshot([row('Ждёт контроля',{'Дата изменения':'18.09.2026 09:00'})],18);
assert.equal(next[0].waitingControlDays,2); // Edits do not reset status age.
assert.equal(next[0].staleDays,0);
next = snapshot([row('Выполняется')],19);
assert.equal(next[0].waitingControlDays,0);
next = snapshot([row()],20);
assert.equal(next[0].waitingControlDays,0); // Re-entry resets status clock.
next = snapshot([row()],25);
assert.equal(next[0].waitingControlDays,5);
assert.equal(next[0].isLongWaitingControl,true);
assert.equal(normalizeRows([row('Ждёт выполнения')],BASELINE_DATE,BASELINE_FILE)[0].isCompleted,false);
assert.equal(normalizeRows([row('Завершена',{'Дата закрытия':'15.09.2026 10:00'})],BASELINE_DATE,BASELINE_FILE).length,0);
const completed = normalizeRows([row('Завершена',{'Дата закрытия':'17.09.2026 10:00'})],new Date(2026,8,17,12), 'tasks_2026-09-17_12-00.xls');
assert.equal(completed[0].riskScore,0);
assert.equal(summarizePeople(completed).length,0);
assert.equal(normalizeRows([row('Отложена')],BASELINE_DATE,BASELINE_FILE).length,0);
assert.equal(isAllowedExport('tasks_2026-07-08_10-43-28.xls'),false);
assert.equal(isAllowedExport('tasks_2026-09-17_10-00.xls'),true);
assert.equal(isAllowedExport('unknown.xls'),false);
localStorage.setItem(LOCAL_EXPORTS_STORAGE_KEY,JSON.stringify([
 {name:'tasks_2026-07-08_10-43-28.xls',text:'old'},
 {name:'tasks_2026-09-17_10-00.xls',text:'new'}
]));
loadLocalExports();
assert.equal(state.localExports.length,1);
assert.equal(state.localExports[0].text,'new');
assert.equal(JSON.parse(localStorage.getItem(LOCAL_EXPORTS_STORAGE_KEY)).length,1);
state.tasks=next; state.previousTasks=[]; state.previousLoaded=true;
assert.equal(buildExportReport().diff.added.length,1); // An empty earlier snapshot is valid.
state.exportDate=BASELINE_DATE;
assert.ok(buildGanttWindow(base,'year').start >= startOfDay(BASELINE_DATE));
console.log('PASS: baseline, history, status transitions, completions, cache migration, empty comparison, Gantt');
`, context);
// Optional full export fixture, extracted without altering source data.
if (process.env.EXPORT_ROWS) {
  context.rawRows = JSON.parse(readFileSync(process.env.EXPORT_ROWS,'utf8'));
  vm.runInContext(`
  const realRows=rawRows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[normalizeHeader(k),v])));
  const realHistory=observeSnapshot(realRows,BASELINE_DATE,BASELINE_FILE,new Map());
  const tasks=normalizeRows(realRows,BASELINE_DATE,BASELINE_FILE,realHistory);
  assert.ok(tasks.length>0);
  assert.ok(tasks.every(t=>t.waitingControlDays===0 && t.staleDays===0 && t.overdueDays===0));
  assert.ok(tasks.filter(t=>t.status==='Ждёт выполнения').every(t=>!t.isCompleted));
  console.log(JSON.stringify({source:realRows.length,included:tasks.length,excluded:tasks.ignoredCount,control:tasks.filter(t=>t.isWaitingControl).length,overdue:tasks.filter(t=>t.overdue).length}));
  `,context);
}
