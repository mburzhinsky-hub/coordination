// Техсовет: import, matching, history, agenda, meeting, export, storage.
// The registry here is synthetic (tests/support/fixtures.cjs). The real registry is never part of the repository.
const assert = require('node:assert/strict');
const { createContext, run } = require('./support/load.cjs');
const fixtures = require('./support/fixtures.cjs');

const context = createContext();

const out = run(context, fixtures + `
(async () => {
const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ ok: true, name }); }
  catch (error) { results.push({ ok: false, name, error: String(error && error.stack || error) }); }
}
const NOW1 = '2026-10-05T09:00:00.000Z';
const NOW2 = '2026-10-12T07:00:00.000Z';

/* in-memory backend with the same revision rules as the browser store and the server */
function memBackend() {
  const db = { council: new Map(), councilfiles: new Map() };
  councilBackend.read = async (s, k) => db[s].has(k) ? councilClone(db[s].get(k)) : null;
  councilBackend.list = async s => [...db[s].values()].map(councilClone);
  councilBackend.batch = async writes => {
    const o = councilCheckBatch(writes, (s, k) => db[s].get(k), NOW2);
    if (o.conflicts.length) return { ok: false, conflicts: o.conflicts };
    o.stamped.forEach(w => { if (w.delete) db[w.store].delete(w.key); else db[w.store].set(w.key, councilClone(w.value)); });
    return { ok: true, revs: o.revs };
  };
  state.council = councilBlank();
  state.sharedMode = false;
  return db;
}

async function prepare(bytes, asOf, now, projectMap) {
  const book = xlsxRead(bytes);
  const parsed = councilParseRegistry(book.sheets[0], { today: asOf });
  const hash = councilSha256(bytes);
  const info = { fileName: 'registry.xlsx', size: bytes.length, hash, sheetName: book.sheets[0].name, columns: parsed.columns };
  const ctx = { asOf, now, by: 'test', projectMap: projectMap || {} };
  await councilLoad();
  const plan = councilPlanImport(parsed, state.council.orders, { ...ctx, importId: 'import:' + hash.slice(0, 24) });
  return { parsed, plan, info, ctx, bytes };
}
async function commit(p, decisions) {
  const res = await councilCommitImport(p.parsed, p.plan, decisions || councilDefaultDecisions(p.plan), p.ctx, p.info, p.bytes);
  await councilLoad();
  return res;
}
const byNo = no => state.council.orders.find(o => o.no === String(no));
const byTitle = part => state.council.orders.find(o => o.title.includes(part));
const evTypes = o => (o.events || []).map(e => e.type);

/* ============ reading the registry ============ */

await t('xlsx: a registry made by xlsxWrite is read back with structure, dates and original text', async () => {
  const bytes = fixBook('05.10', FIX_W1);
  const book = xlsxRead(bytes);
  const parsed = councilParseRegistry(book.sheets[0], { today: '2026-10-12' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.headerRow, 2, 'header is found under the title line and an empty row');
  assert.equal(parsed.rows.length, 6);
  assert.equal(parsed.asOfGuess.date, '2026-10-05');
  assert.equal(parsed.asOfGuess.source, 'header');
  assert.deepEqual(parsed.columns.map(c => c.role), ['no', 'project', 'title', 'owner', 'result', 'due', 'status', 'blocker', 'update']);
  assert.equal(parsed.rows[0].dueCell.t, 'd');
  assert.equal(parsed.rows[1].dueText, 'до 14.10');
  assert.equal(parsed.rows[2].dueText, '17.10 если подрядчик не ответит — эскалация');
});

await t('structure: missing header, empty sheet and broken input give a message and never throw', async () => {
  assert.equal(councilParseRegistry({ rows: [['просто', 'текст']] }).ok, false);
  assert.equal(councilParseRegistry({ rows: [] }).ok, false);
  assert.equal(councilParseRegistry(null).ok, false);
  assert.ok(councilParseRegistry({ rows: [['просто']] }).errors.length > 0);
  let threw = false;
  try { xlsxRead(new Uint8Array([1, 2, 3, 4])); } catch (e) { threw = true; assert.ok(String(e.message).length > 0); }
  assert.equal(threw, true, 'garbage is rejected with an error the UI can show');
});

await t('deadlines: exact date, range, checkpoint with condition, condition and relative are told apart; original text is kept', async () => {
  const ref = '2026-10-05';
  const upTo = councilParseDue('до 14.10', ref);
  assert.equal(upTo.kind, 'horizon', '«до 14.10» is a horizon, not a promise of that exact day'); assert.equal(upTo.date, '2026-10-14'); assert.equal(upTo.raw, 'до 14.10');
  const exact = councilParseDue('14.10', ref);
  assert.equal(exact.kind, 'exact'); assert.equal(exact.date, '2026-10-14'); assert.equal(exact.raw, '14.10');
  const dated = councilParseDue({ t: 'd', v: '2026-10-09', text: '09.10.2026', fmt: 'dd.mm.yyyy' }, ref);
  assert.equal(dated.date, '2026-10-09'); assert.equal(dated.kind, 'exact');
  const cp = councilParseDue('17.10 если подрядчик не ответит — эскалация', ref);
  assert.equal(cp.kind, 'checkpoint'); assert.equal(cp.date, '2026-10-17');
  assert.equal(cp.raw, '17.10 если подрядчик не ответит — эскалация', 'the condition text survives');
  const cond = councilParseDue('после устранения документальных вопросов', ref);
  assert.equal(cond.kind, 'condition'); assert.equal(councilDueDate(cond), '');
  const rel = councilParseDue('Текущая неделя', ref);
  assert.equal(rel.kind, 'relative'); assert.equal(rel.inferred, true);
  const multi = councilParseDue('07.10 — решение; 08.10 — подготовка', ref);
  assert.equal(multi.kind, 'checkpoint'); assert.equal(multi.items.length, 2);
  const none = councilParseDue('', ref);
  assert.equal(none.kind, 'none'); assert.equal(none.raw, '');
});

await t('status: «выполнено» in the file is a claim, never a confirmed completion', async () => {
  const st = councilParseStatus('ВЫПОЛНЕНО');
  assert.equal(st.claimedDone, true);
  assert.notEqual(st.state, 'done');
  assert.equal(councilParseStatus('КРИТИЧЕСКАЯ ЗОНА / ОЖИДАНИЕ').critical, true);
  assert.equal(councilParseStatus('ТРЕБУЕТ РЕШЕНИЯ').state, 'decision');
});

await t('owners: a person, a group, nobody and two people are told apart', async () => {
  assert.equal(councilParseOwners('Максим Буржинский').state, 'assigned');
  assert.equal(councilParseOwners('Группа проектирования').state, 'group');
  assert.equal(councilParseOwners('').state, 'none');
  assert.equal(councilParseOwners('Не назначен').state, 'unassigned');
  assert.equal(councilHasOwner({ owners: councilParseOwners('') }), false);
  assert.notEqual(councilParseOwners('Максим Буржинский / Павел Сергеев').state, 'none');
});

await t('projects: aliases map to known projects, unknown names stay raw, a manual map resolves them', async () => {
  assert.equal(councilProjectFor('Казань').projectId, 'kazan');
  assert.equal(councilProjectFor('ЦСН').projectId, 'csn');
  const unknown = councilProjectFor('Проектирование');
  assert.equal(unknown.projectId, '');
  assert.equal(councilProjectFor('Проектирование', { 'Проектирование': 'csn' }).projectId === 'csn' || councilProjectFor('Проектирование', { [projectKey('Проектирование')]: 'csn' }).projectId === 'csn', true);
});

/* ============ import ============ */

await t('import: the first file creates permanent ids and keeps every original value; a plan alone changes nothing', async () => {
  memBackend();
  const p = await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1);
  assert.equal(p.plan.summary.new, 6); assert.equal(p.plan.summary.changed, 0);
  await councilLoad();
  assert.equal(state.council.orders.length, 0, 'preview wrote nothing');
  const res = await commit(p);
  assert.equal(res.ok, true);
  assert.equal(state.council.orders.length, 6);
  const ids = state.council.orders.map(o => o.orderId);
  assert.equal(new Set(ids).size, 6);
  ids.forEach(id => assert.match(id, /^TS-[A-Z0-9]{6}$/));
  const o2 = byNo(2);
  assert.equal(o2.due.raw, 'до 14.10'); assert.equal(o2.statusRaw, 'КРИТИЧЕСКАЯ ЗОНА / ОЖИДАНИЕ');
  assert.equal(o2.blockerRaw, 'Ждём решение заказчика по финансированию');
  assert.equal(o2.state, 'blocked'); assert.equal(o2.critical, true);
  assert.equal(o2.owners.state, 'none', 'an empty owner stays empty, nobody is guessed');
  assert.equal(councilHasOwner(o2), false);
  assert.equal(byNo(3).due.raw, '17.10 если подрядчик не ответит — эскалация');
  assert.equal(byNo(4).projectRaw, 'Проектирование', 'an unknown project name is kept as written');
  assert.equal(byNo(1).due.date, '2026-10-09');
  assert.equal(state.council.imports.length, 1);
  assert.equal(state.council.imports[0].asOf, '2026-10-05');
  assert.equal(state.council.imports[0].rows.length, 6, 'the whole file is kept as the baseline version');
});

await t('import: an identical file imported again creates no orders and no events', async () => {
  memBackend();
  const bytes = fixBook('05.10', FIX_W1);
  await commit(await prepare(bytes, '2026-10-05', NOW1));
  const before = JSON.stringify(state.council.orders);
  const again = await prepare(bytes, '2026-10-05', NOW2);
  assert.equal(again.plan.summary.nothingToDo, true);
  assert.equal(again.plan.summary.same, 6);
  const res = await commit(again);
  assert.equal(res.ok, false); assert.equal(res.reason, 'already-imported');
  assert.equal(JSON.stringify(state.council.orders), before, 'not a byte changed');
  assert.equal(state.council.imports.length, 1);
});

await t('import: the same content saved as a different file (same rows, new bytes) is still "nothing to do"', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const before = JSON.stringify(state.council.orders);
  const resaved = await prepare(fixBook('05.10', FIX_W1, 'Реестр, пересохранён другим человеком'), '2026-10-05', NOW2);
  assert.equal(resaved.plan.summary.nothingToDo, true);
  assert.equal(resaved.plan.summary.new, 0);
  const res = await commit(resaved);
  assert.equal(JSON.stringify(state.council.orders.map(o => o.orderId)), JSON.stringify(JSON.parse(before).map(o => o.orderId)));
  assert.equal(state.council.orders.length, 6);
});

await t('matching across weeks: renumbered and reworded rows keep their permanent ids, nothing is duplicated', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const idsBefore = Object.fromEntries(state.council.orders.map(o => [o.title, o.orderId]));
  const w2 = await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2);
  const sum = w2.plan.summary;
  assert.equal(sum.new, 1, 'exactly one row is new (the cable acceptance act)');
  assert.equal(sum.missing, 1, 'the HDMI row is absent from the new file');
  const sameTitle = w2.plan.items.filter(i => i.verdict === 'match' && i.matchedBy === 'key');
  assert.ok(sameTitle.length >= 4);
  const reworded = w2.plan.items.find(i => i.row.title.startsWith('Получить окончательное решение'));
  assert.equal(reworded.verdict, 'ambiguous', 'a changed wording is not merged silently');
  assert.equal(reworded.orderId, idsBefore['Получить решение по составу оборудования'], 'the likely candidate is proposed');
  const res = await commit(w2); // default decision keeps the proposed match
  assert.equal(res.ok, true);
  assert.equal(state.council.orders.length, 7, '6 old + 1 new, none duplicated');
  assert.equal(byTitle('кабельные трассы').orderId, idsBefore['Согласовать с подрядчиком кабельные трассы']);
  assert.equal(state.council.imports.length, 2, 'the old version is still there');
  assert.equal(state.council.imports[0].asOf, '2026-10-05');
});

await t('matching: a below-confidence candidate is only proposed; the person can say "new" and a new order appears', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const w2 = await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2);
  const item = w2.plan.items.find(i => i.verdict === 'ambiguous');
  assert.ok(item);
  const decisions = councilDefaultDecisions(w2.plan);
  decisions.matches[item.rowIndex] = 'new';
  const res = await commit(w2, decisions);
  assert.equal(res.ok, true);
  assert.equal(state.council.orders.length, 8, 'the person chose "new": one more order, the old one stays');
});

await t('no false closure: a row missing from the new file closes nothing; «выполнено» in the file does not close either', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const hdmi = byNo(6);
  assert.equal(hdmi.claimedDone, true);
  assert.equal(hdmi.state === 'done', false, 'the file said ВЫПОЛНЕНО but nobody confirmed it');
  await commit(await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2));
  const after = byTitle('HDMI');
  assert.ok(after, 'the order is still there');
  assert.notEqual(after.state, 'done'); assert.notEqual(after.state, 'cancelled');
  assert.equal(councilIsOpen(after), true);
  const video = byTitle('видеостену');
  assert.equal(video.claimedDone, true); assert.equal(video.state === 'done', false);
  assert.equal(councilStats(state.council.orders, '2026-10-12').done, 0, 'nothing is counted as confirmed done');
});

await t('empty cells never erase: an empty owner or deadline in a new file leaves the stored value alone', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const rows = FIX_W1.map(r => r.slice());
  rows[2][3] = ''; rows[2][5] = ''; // №3: owner and deadline emptied
  await commit(await prepare(fixBook('12.10', rows), '2026-10-12', NOW2));
  const o3 = byTitle('кабельные трассы');
  assert.equal(o3.owners.raw, 'Павел Сергеев');
  assert.equal(o3.due.raw, '17.10 если подрядчик не ответит — эскалация');
});

await t('changes from a later file are recorded as events with before and after; the original text stays in history', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  await commit(await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2));
  const o = byTitle('кабельные трассы');
  const dueEvent = o.events.find(e => e.type === 'import-update' && e.field === 'due');
  assert.ok(dueEvent);
  assert.equal(dueEvent.from, '17.10 если подрядчик не ответит — эскалация');
  assert.equal(dueEvent.to, '19.10');
  assert.equal(o.due.raw, '19.10');
  assert.equal(o.source.last.due, '19.10');
  assert.ok(o.source.seenAt.includes('2026-10-05') && o.source.seenAt.includes('2026-10-12'));
});

await t('import: a colleague changes a field the file touches between preview and apply, the apply stops instead of overwriting', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const preview = await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2);
  const target = byTitle('кабельные трассы');
  const edited = councilEdit(target, { dueDate: '2026-10-23' }, { now: NOW2, by: 'colleague', today: '2026-10-12' }).order;
  assert.equal((await councilCommit([{ record: edited }])).ok, true);
  const res = await councilCommitImport(preview.parsed, preview.plan, councilDefaultDecisions(preview.plan), preview.ctx, preview.info, preview.bytes);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'plan-changed');
  await councilLoad();
  assert.equal(state.council.imports.length, 1, 'nothing of the second file was written');
  assert.equal(byTitle('кабельные трассы').due.date, '2026-10-23');
});

await t('import: a colleague changes a field the file does not touch, the import still applies and both changes survive', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const preview = await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2);
  const target = byTitle('кабельные трассы');
  const edited = councilEdit(target, { comment: 'Звонили подрядчику' }, { now: NOW2, by: 'colleague', today: '2026-10-12' }).order;
  assert.equal((await councilCommit([{ record: edited }])).ok, true);
  const res = await councilCommitImport(preview.parsed, preview.plan, councilDefaultDecisions(preview.plan), preview.ctx, preview.info, preview.bytes);
  assert.equal(res.ok, true);
  await councilLoad();
  assert.equal(byTitle('кабельные трассы').comment, 'Звонили подрядчику', 'the colleague note is not lost');
  assert.equal(byTitle('кабельные трассы').due.raw, '19.10', 'and the new deadline from the file is there');
});

/* ============ manual edit and history ============ */

await t('manual edit: result, deadline, owner, comment and blocker are changed by a person and each change is an event', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const o = byNo(5);
  const ctx = { now: NOW2, by: 'maria', today: '2026-10-12' };
  const edited = councilEdit(o, { result: 'Платёж проведён, ждём акт', dueDate: '2026-10-20', ownerName: 'Павел Сергеев', comment: 'Согласовано по телефону', blockerRaw: 'Нет акта' }, ctx);
  assert.deepEqual(edited.changed.sort(), ['blocker', 'comment', 'due', 'owner', 'result']);
  const n = edited.order;
  assert.equal(n.result, 'Платёж проведён, ждём акт');
  assert.equal(n.due.date, '2026-10-20'); assert.equal(n.due.kind, 'exact');
  assert.equal(n.owners.raw, 'Павел Сергеев'); assert.equal(n.owners.state, 'assigned');
  assert.equal(n.by.owners, 'maria');
  assert.equal(n.events.filter(e => e.by === 'maria').length, 5);
  const noop = councilEdit(n, { result: 'Платёж проведён, ждём акт' }, ctx);
  assert.equal(noop.changed.length, 0, 'saving the same value again is not a change');
});

await t('manual edit wins over the next file: a changed value is a conflict the person decides, not an overwrite', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const o = byTitle('кабельные трассы');
  const edited = councilEdit(o, { dueDate: '2026-10-23' }, { now: NOW2, by: 'maria', today: '2026-10-12' }).order;
  await councilCommit([{ record: edited }]);
  await councilLoad();
  const w2 = await prepare(fixBook('12.10', FIX_W2), '2026-10-12', NOW2);
  const item = w2.plan.items.find(i => i.orderId === o.orderId);
  const dueChange = item.changes.find(c => c.field === 'due');
  assert.equal(dueChange.mode, 'conflict');
  await commit(w2);
  assert.equal(byTitle('кабельные трассы').due.date, '2026-10-23', 'the person\\'s value is still there');
  assert.ok(byTitle('кабельные трассы').events.some(e => e.type === 'source-note' && e.field === 'due'), 'the file value is kept as a note');
});

await t('confirmed completion is explicit, has a note and can be undone; cancelled is separate from done', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const o = byNo(1);
  const done = councilConfirmDone(o, { note: 'Принято заказчиком', eventId: 'ev:t:done' }, { now: NOW2, by: 'maria', today: '2026-10-12' });
  assert.equal(done.state, 'done'); assert.equal(done.done.confirmed, true); assert.equal(done.done.note, 'Принято заказчиком');
  assert.ok(evTypes(done).includes('done'));
  const back = councilReopen(done, 'Нашли замечания', { now: NOW2, by: 'maria', today: '2026-10-12' });
  assert.equal(councilIsOpen(back), true); assert.equal(back.done, null);
  const gone = councilCancel(o, 'Не нужно', { now: NOW2, by: 'maria', today: '2026-10-12' });
  assert.equal(gone.state, 'cancelled');
});

await t('blocks: kinds, dependency on another order, cycles refused, suggestions are never saved by themselves', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const a = byNo(3), b = byNo(2);
  const ctx = { now: NOW2, by: 'maria', today: '2026-10-12' };
  const blocked = councilAddBlock(a, { kind: 'order', ref: b.orderId, text: 'Ждём решения по составу оборудования', decider: 'Заказчик' }, ctx);
  assert.equal(blocked.state, 'blocked');
  assert.equal(councilActiveBlocks(blocked).some(x => x.kind === 'order' && x.ref === b.orderId), true);
  const orders = state.council.orders.map(o => o.orderId === blocked.orderId ? blocked : o);
  assert.equal(councilDependents(b.orderId, orders).length, 1, 'what unblocks when the first order is done');
  assert.equal(councilWouldCycle(orders, b.orderId, blocked.orderId), true, 'a loop is refused');
  assert.equal(councilWouldCycle(orders, b.orderId, b.orderId), true);
  const resolved = councilResolveBlock(blocked, councilActiveBlocks(blocked)[0].id, 'Решение получено', ctx);
  assert.equal(councilActiveBlocks(resolved).length, 0);
  const before = JSON.stringify(state.council.orders);
  councilSuggestDependencies(byNo(5), state.council.orders);
  assert.equal(JSON.stringify(state.council.orders), before, 'suggesting changes nothing');
  ['dependency', 'external', 'delivery', 'approval', 'financial', 'other'].forEach(k => assert.ok(councilBlockKind(k).label, 'kind ' + k));
});

/* ============ agenda ============ */

await t('agenda: the six reasons appear in the required order and the question has all five parts built from real data', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const orders = state.council.orders;
  const agenda = councilBuildAgenda(orders, '2026-10-12', {});
  assert.equal(agenda.total >= 5, true);
  const o2 = agenda.items.find(i => i.orderId === byNo(2).orderId);
  assert.equal(o2.priority, 1, 'blocked and needs a decision comes first');
  assert.ok(o2.reasons.some(r => r.priority === 5), 'its horizon of 14.10 is within a week');
  assert.ok(councilReasons(byNo(2), orders, '2026-10-16').some(r => r.priority === 2), 'two days later it is overdue');
  assert.ok(o2.reasons.some(r => r.priority === 3), 'and it has no owner');
  assert.equal(agenda.items[0].priority, 1);
  const prios = agenda.items.map(i => i.priority);
  const grouped = agenda.groups.map(g => g.best);
  assert.deepEqual([...grouped].sort((x, y) => (x || 9) - (y || 9)), grouped, 'groups are ordered by their most urgent question');
  assert.ok(o2.headline.length > 0 && o2.question && o2.action, 'question and proposed action exist');
  assert.ok(o2.reason && o2.reason.includes('Ждём решение заказчика'), 'the reason comes from the registry');
  const o4 = agenda.items.find(i => i.orderId === byNo(4).orderId);
  assert.ok(o4.reasons.some(r => r.priority === 3 && /группой/.test(r.text)), 'a group is not an owner');
  assert.ok(o4.reasons.some(r => r.soft), 'a relative deadline that has passed is flagged, with no invented date');
  const soon = councilReasons(byNo(3), orders, '2026-10-12');
  assert.ok(soon.some(r => r.code === 'soon'), 'a checkpoint within 7 days is an approaching deadline');
});

await t('agenda: missing information is marked as missing, not invented', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const agenda = councilBuildAgenda(state.council.orders, '2026-10-12', {});
  const o2 = agenda.items.find(i => i.orderId === byNo(2).orderId);
  assert.ok(o2.gaps.some(g => /ответственный не указан/i.test(g)), JSON.stringify(o2.gaps));
  const o3 = agenda.items.find(i => i.orderId === byNo(3).orderId);
  assert.ok(o3.gaps.length > 0, 'an order with a decision status but no reason lists what is missing');
  const text = JSON.stringify(o3);
  assert.equal(/Иванов|Петров/.test(text), false);
});

await t('agenda: a decision without a result after a week becomes priority 6; manual add, exclude and reorder work', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const target = byNo(3);
  const decided = councilRecordDecision(target, { text: 'Закончить до пятницы', meetingId: 'meeting:2026-10-05', date: '2026-10-05', eventId: 'ev:d1' }, { now: NOW1, by: 'maria', today: '2026-10-05' });
  const orders = state.council.orders.map(o => o.orderId === target.orderId ? decided : o);
  const reasons = councilReasons(decided, orders, '2026-10-12');
  assert.ok(reasons.some(r => r.code === 'stale' && r.priority === 6), reasons.map(r => r.code).join(','));
  const base = councilBuildAgenda(orders, '2026-10-12', {});
  const some = base.items[0];
  const excluded = councilBuildAgenda(orders, '2026-10-12', { excluded: { [some.orderId]: true } });
  assert.equal(excluded.total, base.total - 1); assert.equal(excluded.dropped.length, 1);
  const manual = councilBuildAgenda(orders, '2026-10-12', { manual: [{ id: 'man:1', title: 'Обсудить график монтажа', group: 'Прочие вопросы' }] });
  assert.equal(manual.items.find(i => i.id === 'man:1').kind, 'manual');
  const group = base.groups[0];
  if (group.items.length > 1) {
    const moved = councilMoveAgendaItem(base, group.items[1].id, 'top', {});
    const re = councilBuildAgenda(orders, '2026-10-12', { order: moved });
    assert.equal(re.groups.find(g => g.key === group.key).items[0].id, group.items[1].id);
  }
});

/* ============ meeting ============ */

async function runMeeting() {
  const orders = state.council.orders;
  let meeting = councilNewMeeting('2026-10-12', NOW2);
  meeting = councilStartMeeting(meeting, orders, NOW2, 'maria');
  return meeting;
}

await t('meeting: draft, accepted decision and confirmed completion stay apart; untouched questions stay open', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const meeting = await runMeeting();
  assert.equal(meeting.status, 'live');
  assert.ok(meeting.agenda.length >= 5, 'the agenda is frozen at the start');
  const [i1, i2, i3] = [byNo(2), byNo(3), byNo(1)].map(o => meeting.agenda.find(a => a.orderId === o.orderId));
  const draft = meeting.draft;
  const a = councilDraftItem(draft, i1.id); a.decision = 'Решение: заказчик подтверждает состав до 16.10'; a.ownerName = 'Павел Сергеев'; a.dueDate = '2026-10-16'; a.accepted = true;
  const b = councilDraftItem(draft, i2.id); b.decision = 'Черновик, ещё не принято';
  const c = councilDraftItem(draft, i3.id); c.doneConfirm = true; c.doneNote = 'Принято на совете'; c.accepted = true;
  draft.newOrders.push({ uid: 'n1', title: 'Проверить акт сдачи линий', project: 'ЦСН', ownerName: 'Семён Онищенко', dueDate: '2026-10-21', dueText: '' });
  const plan = councilBuildClosePlan(meeting, state.council.orders, { today: '2026-10-12' });
  assert.equal(plan.drafts.length, 1, 'the draft is listed, not applied');
  assert.equal(plan.decisions.length, 2);
  assert.equal(plan.counts.decisions, 1); assert.equal(plan.counts.done, 1); assert.equal(plan.counts.created, 1);
  assert.equal(plan.untouched.length, meeting.agenda.length - 3);
  const closed = councilApplyClose(plan, meeting, state.council.orders, { now: NOW2, by: 'maria' });
  const o2 = closed.orders.find(o => o.orderId === byNo(2).orderId);
  assert.equal(o2.owners.raw, 'Павел Сергеев'); assert.equal(o2.due.date, '2026-10-16');
  assert.ok(o2.events.some(e => e.type === 'decision' && e.meetingId === 'meeting:2026-10-12' && /подтверждает состав/.test(e.text)));
  assert.equal(closed.orders.find(o => o.orderId === byNo(3).orderId), undefined, 'the draft changed nothing on its order');
  const o1 = closed.orders.find(o => o.orderId === byNo(1).orderId);
  assert.equal(o1.state, 'done'); assert.equal(o1.done.meetingId, 'meeting:2026-10-12');
  assert.equal(closed.orders.filter(o => !state.council.orders.some(x => x.orderId === o.orderId)).length, 1, 'one new order');
  assert.equal(closed.meeting.status, 'closed'); assert.equal(closed.meeting.draft, null);
  assert.ok(closed.meeting.result.summaryText.includes('рассмотрено 2 из'));
  assert.ok(closed.meeting.protocol.text.length > 0);
  assert.equal(closed.meeting.agenda.length, meeting.agenda.length, 'the agenda stays readable after the registry moves on');
});

await t('meeting: closing twice (a retry after a failure) writes each event once and adds no second order', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const meeting = await runMeeting();
  const item = meeting.agenda.find(a => a.orderId === byNo(2).orderId);
  const d = councilDraftItem(meeting.draft, item.id); d.decision = 'Решено'; d.ownerName = 'Павел Сергеев'; d.accepted = true;
  meeting.draft.newOrders.push({ uid: 'n1', id: 'TS-AAAAAA', title: 'Новое', project: 'ЦСН' });
  const plan = councilBuildClosePlan(meeting, state.council.orders, { today: '2026-10-12' });
  const first = councilApplyClose(plan, meeting, state.council.orders, { now: NOW2, by: 'maria' });
  const second = councilApplyClose(plan, meeting, first.orders.concat(state.council.orders.filter(o => !first.orders.some(x => x.orderId === o.orderId))), { now: NOW2, by: 'maria' });
  const e1 = first.orders.find(o => o.orderId === byNo(2).orderId).events.map(e => e.id);
  const e2 = second.orders.find(o => o.orderId === byNo(2).orderId).events.map(e => e.id);
  assert.equal(new Set(e2).size, e2.length, 'event ids are unique');
  assert.equal(e2.filter(id => /decision/.test(id)).length, 1);
  assert.deepEqual(e2.sort(), e1.sort());
});

await t('meeting stored: finishing saves the meeting and the orders together; the next council is a week later; history stays', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  let meeting = await runMeeting();
  const item = meeting.agenda.find(a => a.orderId === byNo(2).orderId);
  const d = councilDraftItem(meeting.draft, item.id); d.decision = 'Решено'; d.ownerName = 'Павел Сергеев'; d.accepted = true;
  const rec = await councilCommit([{ record: meeting }]);
  assert.equal(rec.ok, true);
  await councilLoad();
  meeting = councilMeetingByDate('2026-10-12');
  meeting.draft = councilClone(meeting.draft || councilEmptyDraft());
  const dd = councilDraftItem(meeting.draft, item.id); dd.decision = 'Решено'; dd.ownerName = 'Павел Сергеев'; dd.accepted = true;
  const plan = councilBuildClosePlan(meeting, state.council.orders, { today: '2026-10-12' });
  const closed = councilApplyClose(plan, meeting, state.council.orders, { now: NOW2, by: 'maria' });
  const res = await councilCommit([...closed.orders.map(record => ({ record })), { record: closed.meeting }]);
  assert.equal(res.ok, true);
  await councilLoad();
  assert.equal(councilMeetingByDate('2026-10-12').status, 'closed');
  const dates = councilMeetingDates(state.council.meetings, state.council.imports, '2026-10-12');
  assert.equal(dates.lastHeld, '2026-10-12'); assert.equal(dates.next, '2026-10-19');
  assert.equal(dates.baseline, '2026-10-05');
});

await t('history of an order: first appearance, councils that discussed it, decisions, owner and deadline changes, blockers', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const meeting = await runMeeting();
  const item = meeting.agenda.find(a => a.orderId === byNo(2).orderId);
  const d = councilDraftItem(meeting.draft, item.id); d.decision = 'Решено: ждём заказчика'; d.ownerName = 'Павел Сергеев'; d.dueDate = '2026-10-16'; d.accepted = true;
  const plan = councilBuildClosePlan(meeting, state.council.orders, { today: '2026-10-12' });
  const closed = councilApplyClose(plan, meeting, state.council.orders, { now: NOW2, by: 'maria' });
  const order = closed.orders.find(o => o.orderId === byNo(2).orderId);
  const timeline = councilTimeline(order, [closed.meeting]);
  const kinds = timeline.map(x => x.type || x.kind);
  assert.ok(timeline.length >= 4);
  assert.ok(JSON.stringify(timeline).includes('Решено: ждём заказчика'));
  assert.ok(JSON.stringify(timeline).includes('Павел Сергеев'));
  assert.ok(JSON.stringify(timeline).includes('2026-10-16') || JSON.stringify(timeline).includes('16.10'));
  assert.ok(order.events.some(e => e.type === 'created' && e.asOf === '2026-10-05'), 'first appearance with the registry date');
  assert.ok(order.events.some(e => e.meetingId === 'meeting:2026-10-12'), 'tied to the council that discussed it');
});

/* ============ export ============ */

await t('export: current registry becomes a readable .xlsx that reads back and re-imports with nothing to do', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const book = councilExportBook(state.council.orders, state.council.meetings, { today: '2026-10-12' });
  const bytes = xlsxWrite(book);
  const back = xlsxRead(bytes);
  assert.ok(back.sheets.length >= 2);
  assert.equal(back.sheets[0].name, 'Реестр');
  const parsed = councilParseRegistry(back.sheets[0], { today: '2026-10-12' });
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  assert.equal(parsed.rows.length, 6);
  assert.ok(parsed.columns.some(c => c.role === 'id'), 'a permanent id column is added');
  const roles = parsed.columns.map(c => c.role);
  ['no', 'project', 'title', 'owner', 'result', 'due'].forEach(r => assert.ok(roles.includes(r), 'column ' + r));
  parsed.rows.forEach(r => assert.match(r.id, /^TS-/));
  const again = await prepare(bytes, '2026-10-12', NOW2);
  assert.equal(again.plan.summary.new, 0, 'an exported file never creates duplicates');
  assert.equal(again.plan.summary.ambiguous, 0);
  const hdmi = parsed.rows.find(r => r.title.includes('HDMI'));
  assert.ok(hdmi, 'project structure and rows survive');
  const projects = new Set(parsed.rows.map(r => r.project));
  assert.ok(projects.has('Казанский ЦУМ') || projects.has('Казань'));
});

/* ============ store: revisions, conflicts, drafts ============ */

await t('store: a write based on an old revision is refused and nothing of the batch is written', async () => {
  const db = memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const o = byNo(1);
  const stale = councilClone(o);
  const fresh = councilEdit(o, { result: 'Новый результат' }, { now: NOW2, by: 'a', today: '2026-10-12' }).order;
  assert.equal((await councilCommit([{ record: fresh }])).ok, true);
  const second = councilEdit(stale, { result: 'Чужая правка' }, { now: NOW2, by: 'b', today: '2026-10-12' }).order;
  const other = councilEdit(byNo(2), { result: 'Соседняя правка' }, { now: NOW2, by: 'b', today: '2026-10-12' }).order;
  const res = await councilCommit([{ record: other }, { record: second }]);
  assert.equal(res.ok, false);
  assert.ok(res.conflicts.length >= 1);
  assert.equal(db.council.get('order:' + byNo(2).orderId).result, byNo(2).result, 'the other record in the batch was not written either');
});

await t('store: simultaneous edits of different fields merge; the same field is reported as a conflict with both values', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const o = byNo(5);
  const base = councilClone(o);
  const a = await councilSaveEdit(o.orderId, base, { ownerName: 'Павел Сергеев' }, { now: NOW2, by: 'a', today: '2026-10-12' });
  assert.equal(a.ok, true);
  const b = await councilSaveEdit(o.orderId, base, { result: 'Новый результат' }, { now: NOW2, by: 'b', today: '2026-10-12' });
  assert.equal(b.ok, true, 'a different field merges onto the fresh version');
  await councilLoad();
  assert.equal(byNo(5).owners.raw, 'Павел Сергеев'); assert.equal(byNo(5).result, 'Новый результат');
  const c = await councilSaveEdit(o.orderId, base, { ownerName: 'Максим Буржинский' }, { now: NOW2, by: 'c', today: '2026-10-12' });
  assert.equal(c.ok, false);
  const conflict = c.details.conflicts.find(x => x.key === 'owner' || /owner|Ответственный/.test(x.key + x.label));
  assert.ok(conflict, JSON.stringify(c.details));
  const forced = await councilSaveEdit(o.orderId, base, { ownerName: 'Максим Буржинский' }, { now: NOW2, by: 'c', today: '2026-10-12' }, { ownerName: 'mine' });
  assert.equal(forced.ok, true);
  await councilLoad();
  assert.equal(byNo(5).owners.raw, 'Максим Буржинский');
});

await t('store: meeting draft from two screens merges field by field and keeps both people\\'s new orders', async () => {
  const merged = councilMergeDraft(
    { items: { a: { decision: 'на сервере', updatedAt: '1' }, b: { decision: 'чужое' } }, notes: 'заметка', newOrders: [{ uid: 'u1', title: 'чужое поручение' }] },
    { items: { a: { decision: 'моё' } }, notes: 'моя', newOrders: [{ uid: 'u2', title: 'моё поручение' }] },
    { items: { a: true }, notes: false, newOrders: true, removed: [] }, 'now');
  assert.equal(merged.items.a.decision, 'моё');
  assert.equal(merged.items.b.decision, 'чужое');
  assert.equal(merged.notes, 'заметка');
  assert.deepEqual(merged.newOrders.map(n => n.uid).sort(), ['u1', 'u2']);
});

await t('store: old records are upgraded without losing fields; unknown kinds are neither loaded as orders nor deleted', async () => {
  const old = { id: 'order:TS-OLD001', kind: 'order', orderId: 'TS-OLD001', title: 'Старая запись', events: [{ id: 'e1', type: 'created', at: NOW1 }], customField: 'keep me' };
  const up = councilUpgrade(old);
  assert.equal(up.title, 'Старая запись'); assert.equal(up.customField, 'keep me');
  assert.ok(Array.isArray(up.blocks) && Array.isArray(up.updates) && up.owners && up.due, 'missing parts get safe defaults');
  const db = memBackend();
  db.council.set('order:TS-OLD001', old);
  db.council.set('x', { id: 'x', kind: 'something-new', rev: 1 });
  await councilLoad();
  assert.equal(state.council.orders.length, 1);
  assert.equal(state.council.orders[0].title, 'Старая запись');
  assert.equal(db.council.has('x'), true, 'a record from a newer version is left alone');
});

await t('store: the file bytes are kept with the import (content-addressed) and read back identical', async () => {
  const db = memBackend();
  const bytes = fixBook('05.10', FIX_W1);
  await commit(await prepare(bytes, '2026-10-05', NOW1));
  assert.equal(db.councilfiles.size, 1);
  const rec = [...db.councilfiles.values()][0];
  const back = councilB64ToBytes(rec.data);
  assert.equal(back.length, bytes.length);
  assert.equal(councilSha256(back), councilSha256(bytes));
});

await t('protocol: text suggestions are only suggestions; nothing is applied without a person', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const before = JSON.stringify(state.council.orders);
  const found = councilProtocolSuggestions('Поручить Павлу Сергееву подготовить акт до 21.10. Срок по кабельным трассам перенести на 19.10.', '2026-10-12');
  assert.ok(Array.isArray(found));
  assert.equal(JSON.stringify(state.council.orders), before);
});

await t('project block: counts for a project card come from the council registry and never touch Bitrix tasks', async () => {
  memBackend();
  await commit(await prepare(fixBook('05.10', FIX_W1), '2026-10-05', NOW1));
  const info = councilProjectBlock(state.council.orders, 'csn', '2026-10-12');
  assert.equal(info.open, 2); assert.ok(info.needsDecision >= 1); assert.ok(info.blocked >= 1);
  assert.equal(councilProjectBlock(state.council.orders, 'luzhniki', '2026-10-12'), null, 'a project without council orders shows no block');
});

await t('view: dashboard state starts empty and old snapshots do not need the council store', async () => {
  const blank = councilBlank();
  assert.equal(blank.orders.length, 0); assert.equal(blank.loaded, false);
  assert.equal(typeof state.council, 'object');
});

return results;
})()
`, { assert });

out.then(results => {
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log('  ok   ' + r.name);
    else { failed++; console.log('  FAIL ' + r.name + '\n' + r.error.split('\n').slice(0, 6).map(l => '       ' + l).join('\n')); }
  }
  if (failed) { console.log(`\n${failed} of ${results.length} failed`); process.exit(1); }
  console.log(`PASS: council — ${results.length} checks`);
}, error => { console.error(error); process.exit(1); });
