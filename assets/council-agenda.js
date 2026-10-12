'use strict';
/*
 * Tech council model, part 3: the agenda (management questions built from real registry data), the meeting draft,
 * closing a meeting, the protocol draft and the xlsx export. Pure functions.
 *
 * Wording rule: every sentence is built from fields of the registry or from what people entered. When something is not known the
 * text says so ("не указано") instead of filling the gap.
 */

const COUNCIL_PRIORITY_LABELS = {
  1: 'Требует решения', 2: 'Просрочена контрольная точка', 3: 'Нет владельца', 4: 'Нет подтверждённого движения', 5: 'Срок близко', 6: 'Решение без результата'
};
const COUNCIL_MOVE_TYPES = new Set(['status-note', 'decision', 'edit', 'owner', 'deadline', 'state', 'done', 'block-added', 'block-resolved', 'import-update']);
const COUNCIL_NEGATIVE_RE = /не\s+(подтвержд|получен|уточнен|определен|разобран|закрыт|решен|начат|согласован|поступил)|отдельно\s+не|нет\s+(новой\s+информации|подтверждения|ответа)|пока\s+(отсутствует|не\s)|затруднен/;

function councilEventDay(e) { return cdValid(e.asOf) ? String(e.asOf).slice(0, 10) : String(e.at || '').slice(0, 10); }

function councilLastMovement(order) {
  const days = (order.events || []).filter(e => COUNCIL_MOVE_TYPES.has(e.type)).map(councilEventDay).filter(cdValid).sort();
  if (days.length) return days.at(-1);
  const first = (order.source?.seenAt || []).filter(cdValid).sort()[0] || String(order.createdAt || '').slice(0, 10);
  return cdValid(first) ? first : '';
}

function councilLatestUpdate(order) {
  const list = [...(order.updates || [])].sort((a, b) => String(a.asOf || a.at).localeCompare(String(b.asOf || b.at)));
  return list.at(-1) || null;
}

function councilShort(text, max = 220) {
  const t = cleanText(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')) + '…';
}

function councilLastDecision(order) {
  return (order.events || []).filter(e => e.type === 'decision').sort((a, b) => String(a.asOf || a.at).localeCompare(String(b.asOf || b.at))).at(-1) || null;
}

/* ---------- reasons to discuss an order ---------- */

function councilReasons(order, orders, date) {
  const reasons = [];
  const due = order.due || {};
  const dueDate = councilDueDate(due);
  const blocks = councilActiveBlocks(order);
  if (order.state === 'blocked' || councilNeedsDecision(order)) {
    const kinds = blocks.map(b => councilBlockKind(b.kind).label.toLowerCase());
    const text = order.state === 'blocked'
      ? `Заблокировано${kinds.length ? ': ' + [...new Set(kinds)].join(', ') : ''}`
      : 'В реестре стоит «Требует решения»';
    reasons.push({ code: 'decision', priority: 1, text });
  }
  if (councilIsOverdue(order, date)) {
    const days = cdDiff(date, dueDate);
    const noun = due.kind === 'checkpoint' ? 'Контрольная точка' : due.kind === 'horizon' ? 'Горизонт' : 'Срок';
    const verb = noun === 'Срок' ? 'прошёл' : 'прошла';
    reasons.push({ code: 'overdue', priority: 2, text: `${noun} ${cdFmt(dueDate)} ${verb} ${daysWord(days)} назад` });
  } else if (due.kind === 'relative' && due.inferred && cdValid(due.date) && cdDiff(date, due.date) > 0 && councilIsOpen(order)) {
    reasons.push({ code: 'overdue', priority: 2, soft: true, text: `Срок записан как «${due.raw}» от даты реестра: это неделя до ${cdFmt(due.date)}, она прошла. Точная дата не названа` });
  }
  if (!councilHasOwner(order)) {
    const st = order.owners?.state;
    const text = st === 'unassigned' ? 'Владелец формально не назначен' : st === 'group' ? 'Ответственный указан группой, не человеком' : st === 'ambiguous' ? 'Ответственный назван не полностью' : 'Ответственный не указан';
    reasons.push({ code: 'owner', priority: 3, text });
  }
  const last = councilLastMovement(order);
  const quiet = last ? cdDiff(date, last) : null;
  const latest = councilLatestUpdate(order);
  const negative = latest && COUNCIL_NEGATIVE_RE.test(normalizeHeader(latest.text));
  const tags = order.statusTags || [];
  if (order.claimedDone) reasons.push({ code: 'movement', priority: 4, text: `В реестре стоит «${order.statusRaw}», но выполнение не подтверждено` });
  else if (negative) reasons.push({ code: 'movement', priority: 4, text: `В последнем обновлении подтверждения нет: «${councilShort(latest.text, 120)}»` });
  else if (quiet !== null && quiet >= 7) reasons.push({ code: 'movement', priority: 4, text: tags.includes('established') ? `Статус «${order.statusRaw}» не означает выполнения, обновлений после ${cdFmt(last)} нет` : `После ${cdFmt(last)} подтверждённого движения нет (${daysWord(quiet)})` });
  if (['exact', 'checkpoint', 'horizon'].includes(due.kind) && councilIsOpen(order)) {
    const upcoming = due.kind === 'checkpoint' && due.items?.length ? due.items.map(i => i.date).sort().find(d => cdDiff(d, date) >= 0) : dueDate;
    const left = upcoming ? cdDiff(upcoming, date) : -1;
    if (left >= 0 && left <= 7) reasons.push({ code: 'soon', priority: 5, text: left === 0 ? `Срок сегодня (${cdFmt(upcoming)})` : `${due.kind === 'checkpoint' ? 'Контрольная точка' : 'Срок'} ${cdFmt(upcoming)}, через ${daysWord(left)}` });
  }
  const dec = councilLastDecision(order);
  if (dec && councilIsOpen(order)) {
    const age = cdDiff(date, councilEventDay(dec));
    const after = (order.events || []).some(e => COUNCIL_MOVE_TYPES.has(e.type) && e.type !== 'decision' && councilEventDay(e) > councilEventDay(dec));
    if (age >= 7 && !after) reasons.push({ code: 'stale', priority: 6, text: `Решение от ${cdFmt(councilEventDay(dec))} «${councilShort(dec.text, 100)}»: результата нет` });
  }
  return reasons.sort((a, b) => a.priority - b.priority);
}

/* ---------- the management question ---------- */

function councilOrderRef(o) { return `№${o.no || '?'} «${councilShort(o.title, 70)}»`; }

function councilQuestionFor(order, orders, reasons, date) {
  const primary = reasons[0];
  const code = primary?.code || 'movement';
  const blocks = councilActiveBlocks(order);
  const decider = cleanText(order.owners?.decider || blocks.find(b => b.decider)?.decider || '');
  const group = councilGroupName(order);
  const latest = councilLatestUpdate(order);
  const gaps = [];
  if (!councilHasOwner(order)) gaps.push(order.owners?.state === 'unassigned' ? 'владелец не назначен' : order.owners?.state === 'group' ? 'отвечает группа, не человек' : order.owners?.raw ? 'ответственный назван не полностью' : 'ответственный не указан');
  if (order.due?.kind === 'none' || !order.due) gaps.push('срок не задан');
  if (order.due?.kind === 'condition') gaps.push(`срок задан условием: «${order.due.raw}»`);
  if (order.due?.kind === 'relative') gaps.push(`срок «${order.due.raw}» без даты`);
  if (order.state === 'blocked' && !cleanText(order.blockerRaw) && !blocks.some(b => cleanText(b.text) && b.by !== 'import')) gaps.push('причина блокировки в реестре не указана');
  if (order.state === 'blocked' && !decider) gaps.push('не указано, кто принимает решение');

  const dependents = councilDependents(order.orderId, orders);
  const guessed = councilSuggestDependenciesTo(order, orders).filter(o => !dependents.some(d => d.orderId === o.orderId));
  const impactParts = [];
  if (dependents.length) impactParts.push(`Ждут этого результата (подтверждено): ${dependents.slice(0, 4).map(councilOrderRef).join('; ')}`);
  if (guessed.length) impactParts.push(`Предположительно ждут, не подтверждено: ${guessed.slice(0, 3).map(councilOrderRef).join('; ')}`);
  if (!impactParts.length) gaps.push('последствия задержки в реестре не описаны');

  let reason = '';
  const blockText = cleanText(order.blockerRaw) || cleanText(blocks.find(b => b.text && b.text !== order.statusRaw)?.text || '');
  if (code === 'decision') reason = blockText || (latest ? councilShort(latest.text, 260) : '') || 'причина в реестре не указана';
  else if (code === 'movement' || code === 'stale') reason = latest ? councilShort(latest.text, 260) : order.statusRaw ? `Статус в реестре: «${order.statusRaw}»` : 'обновлений нет';
  else reason = primary ? primary.text : '';

  const blockKinds = new Set(blocks.map(b => b.kind));
  let question, action;
  if (code === 'decision') {
    if (blockKinds.has('order')) { const dep = blocks.find(b => b.kind === 'order' && orders.some(o => o.orderId === b.ref)); const target = dep ? orders.find(o => o.orderId === dep.ref) : null; question = target ? `Когда будет выполнено ${councilOrderRef(target)}, от которого это зависит, и кто за это отвечает?` : 'От какого поручения это зависит и когда оно будет выполнено?'; }
    else if (blockKinds.has('delivery')) question = 'Когда ожидается поставка и что можно сделать до неё?';
    else if (blockKinds.has('finance')) question = decider ? `Когда будет решение по финансированию (по реестру решает: ${decider}) и кто его добивается?` : 'Кто принимает решение по финансированию и к какой дате?';
    else if (blockKinds.has('approval')) question = decider ? `Кто согласует (по реестру: ${decider}) и к какой дате?` : 'Кто должен согласовать и к какой дате?';
    else question = decider ? `Кто принимает решение (по реестру: ${decider}) и к какой дате?` : 'Кто принимает решение и к какой дате?';
    action = councilHasOwner(order) ? 'Зафиксировать решение или контрольную дату решения.' : 'Назначить внутреннего владельца и зафиксировать контрольную дату.';
  } else if (code === 'overdue') {
    question = `Срок «${order.due.raw}» прошёл. Выполнено, переносим (на какую дату) или снимаем?`;
    action = 'Подтвердить выполнение или установить новую дату.';
  } else if (code === 'owner') {
    question = order.owners?.state === 'group' ? 'Кто именно в группе ведёт это поручение?' : order.owners?.state === 'ambiguous' ? `Кто отвечает за результат? В реестре: «${order.owners.raw}».` : 'Кто владелец этого поручения?';
    action = 'Назначить владельца.';
  } else if (code === 'soon') {
    question = 'Срок близко. Успеваем? Что нужно, чтобы уложиться?';
    action = 'Подтвердить готовность к сроку или перенести его.';
  } else if (code === 'stale') {
    question = 'Что помешало получить результат по принятому решению?';
    action = 'Назначить срок результата или пересмотреть решение.';
  } else {
    question = order.claimedDone ? 'Работа действительно выполнена? Чем это подтверждается?' : 'Что сделано с прошлого совета? Подтверждаем статус или меняем?';
    action = order.claimedDone ? 'Подтвердить выполнение или оставить открытым.' : 'Получить статус у ответственного и поставить дату следующей проверки.';
  }

  const facts = [];
  if (order.statusRaw) facts.push({ label: `Статус в реестре`, text: order.statusRaw, kind: 'fact' });
  if (cleanText(order.blockerRaw)) facts.push({ label: 'Блокер / примечание', text: order.blockerRaw, kind: 'fact' });
  (order.updates || []).slice(-2).forEach(u => facts.push({ label: u.label + (u.asOf ? ` (${cdFmt(u.asOf)}${u.asOfInferred ? ', по оценке' : ''})` : ''), text: councilShort(u.text, 420), kind: 'fact' }));
  if (order.result) facts.push({ label: 'Ожидаемый результат', text: order.result, kind: 'fact' });
  if (order.owners?.raw) facts.push({ label: 'Ответственный в реестре', text: order.owners.raw, kind: 'fact' });
  if (order.due?.kind === 'relative' && order.due.inferred) facts.push({ label: 'Оценка срока', text: `«${order.due.raw}» от реестра ${cdFmt(order.source?.seenAt?.[0] || '')} означает неделю до ${cdFmt(order.due.date)}. Это расчёт, не дата из реестра.`, kind: 'guess' });
  if (order.owners?.people?.some(p => p.matched && p.confidence !== 'exact')) facts.push({ label: 'Кто имеется в виду', text: order.owners.people.filter(p => p.matched && p.confidence !== 'exact').map(p => `«${p.raw}» → ${displayName(p.name)}`).join('; ') + ' (сопоставлено по имени, не подтверждено)', kind: 'guess' });

  const dec = councilLastDecision(order);
  return {
    kicker: `${group} · ${COUNCIL_PRIORITY_LABELS[primary?.priority] || 'К обсуждению'}`,
    headline: order.title,
    reason: reason || 'не указана',
    impact: impactParts.join('. '),
    question, action, gaps, facts,
    prev: dec ? { date: councilEventDay(dec), text: dec.text, meetingId: dec.meetingId || '' } : null
  };
}

/** Orders that this order's condition points to are found by councilSuggestDependencies; here the other direction: who may wait for this one. */
function councilSuggestDependenciesTo(order, orders) {
  return orders.filter(o => o.orderId !== order.orderId).filter(o => councilSuggestDependencies(o, orders).some(s => s.orderId === order.orderId));
}

/* ---------- the agenda ---------- */

function councilAgendaItem(order, orders, date) {
  const reasons = councilReasons(order, orders, date);
  if (!reasons.length) return null;
  const q = councilQuestionFor(order, orders, reasons, date);
  const dueDate = councilDueDate(order.due);
  return {
    id: 'ag:' + order.orderId, kind: 'auto', orderId: order.orderId, no: order.no,
    group: { key: order.projectId || 'raw:' + projectKey(order.projectRaw || 'Без проекта'), name: councilGroupName(order), projectId: order.projectId || '' },
    priority: reasons[0].priority, reasons, ...q,
    owner: { raw: order.owners?.raw || '', state: order.owners?.state || 'none' },
    due: { label: councilDueLabel(order.due), date: dueDate, kind: order.due?.kind || 'none' },
    sort: dueDate || '9999-12-31'
  };
}

/**
 * Builds the agenda for a meeting date.
 * meta: meeting.agendaMeta = { excluded: { orderId: true }, order: [ids], manual: [{ id, title, note, orderId }] }
 */
function councilBuildAgenda(orders, date, meta = {}) {
  const open = orders.filter(councilIsOpen);
  const excluded = meta.excluded || {};
  const auto = open.map(o => councilAgendaItem(o, orders, date)).filter(Boolean);
  const manual = (meta.manual || []).map(m => {
    const order = m.orderId ? orders.find(o => o.orderId === m.orderId) : null;
    const base = order ? councilAgendaItem(order, orders, date) || councilManualItemFromOrder(order, orders, date) : null;
    return { ...(base || {}), id: m.id, kind: 'manual', orderId: m.orderId || '', manualTitle: m.title, note: m.note || '', priority: 0,
      group: base?.group || { key: 'manual', name: m.group || 'Прочие вопросы', projectId: '' },
      headline: m.title || base?.headline || 'Вопрос без названия', kicker: `${base?.group?.name || m.group || 'Прочие вопросы'} · Добавлено вручную`, reasons: base?.reasons || [], gaps: base?.gaps || [], facts: base?.facts || [], question: m.note || base?.question || 'Что нужно решить?', action: base?.action || '', reason: base?.reason || '', impact: base?.impact || '', sort: base?.sort || '0000-00-00' };
  });
  const manualOrders = new Set(manual.map(m => m.orderId).filter(Boolean));
  const kept = auto.filter(i => !excluded[i.orderId] && !manualOrders.has(i.orderId));
  const dropped = auto.filter(i => excluded[i.orderId]);
  const all = [...manual, ...kept];
  const groups = new Map();
  all.forEach(i => { (groups.get(i.group.key) || groups.set(i.group.key, { key: i.group.key, name: i.group.name, projectId: i.group.projectId, items: [] }).get(i.group.key)).items.push(i); });
  const overlay = meta.order || [];
  const idx = i => { const at = overlay.indexOf(i.id); return at >= 0 ? at : 100000; };
  const baseRank = (a, b) => a.priority - b.priority || String(a.sort).localeCompare(String(b.sort)) || Number(a.no || 0) - Number(b.no || 0);
  const list = [...groups.values()].map(g => {
    g.items.sort((a, b) => idx(a) - idx(b) || baseRank(a, b));
    g.best = Math.min(...g.items.map(i => i.priority || 0));
    return g;
  }).sort((a, b) => (a.best || 9) - (b.best || 9) || b.items.length - a.items.length || a.name.localeCompare(b.name, 'ru'));
  const items = list.flatMap(g => g.items);
  return { items, groups: list, dropped, total: items.length, counts: [1, 2, 3, 4, 5, 6].map(p => ({ priority: p, label: COUNCIL_PRIORITY_LABELS[p], count: items.filter(i => i.priority === p).length })) };
}

function councilManualItemFromOrder(order, orders, date) {
  const q = councilQuestionFor(order, orders, [], date);
  return { id: 'ag:' + order.orderId, orderId: order.orderId, no: order.no, group: { key: order.projectId || 'raw:' + projectKey(order.projectRaw || 'Без проекта'), name: councilGroupName(order), projectId: order.projectId || '' }, priority: 0, reasons: [], ...q };
}

/** Moves an item inside its group. Returns the new overlay (full list of ids in agenda order). */
function councilMoveAgendaItem(agenda, id, delta, meta = {}) {
  const group = agenda.groups.find(g => g.items.some(i => i.id === id));
  if (!group) return meta.order || [];
  const ids = group.items.map(i => i.id);
  const from = ids.indexOf(id);
  const to = delta === 'top' ? 0 : Math.max(0, Math.min(ids.length - 1, from + delta));
  if (from === to) return meta.order || [];
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const rest = (meta.order || []).filter(x => !ids.includes(x));
  return [...rest, ...ids];
}

/* ---------- meeting: dates, draft, closing ---------- */

function councilMeetingDates(meetings, imports, today) {
  const held = meetings.filter(m => m.status === 'closed').map(m => m.date).sort();
  const lastHeld = held.at(-1) || '';
  const baseline = (imports || []).map(i => i.asOf).filter(Boolean).sort().at(-1) || '';
  const planned = meetings.filter(m => m.status === 'planned' || m.status === 'live').map(m => m.date).filter(d => d >= (lastHeld || '0000')).sort();
  let next = planned[0] || '';
  if (!next) next = lastHeld ? cdAdd(lastHeld, 7) : cdThisOrNextMonday(today);
  return { lastHeld, baseline, next };
}

function councilNewMeeting(date, now) {
  return { id: 'meeting:' + date, kind: 'meeting', schema: 1, rev: 0, date, status: 'planned', createdAt: now || '', agendaMeta: { excluded: {}, order: [], manual: [] }, agenda: [], draft: null, protocol: { text: '', files: [] } };
}

/** Freezes the agenda at the start of the meeting: what was on the table stays readable even if the registry changes later. */
function councilStartMeeting(meeting, orders, now, by) {
  const m = councilClone(meeting);
  const agenda = councilBuildAgenda(orders, m.date, m.agendaMeta);
  m.agenda = agenda.items.map(i => councilClone(i));
  m.status = 'live'; m.startedAt = now; m.startedBy = by || '';
  m.draft = councilEmptyDraft();
  return m;
}

function councilEmptyDraft() { return { items: {}, newOrders: [], notes: '', updatedAt: '' }; }

function councilDraftItem(draft, itemId) {
  return draft.items[itemId] || (draft.items[itemId] = { decision: '', ownerName: '', ownerText: '', dueText: '', dueDate: '', state: '', blockNote: '', accepted: false, acceptedAt: '', acceptedBy: '', doneConfirm: false, doneNote: '', mark: '', updatedAt: '' });
}

function councilDraftTouched(d) {
  return Boolean(d && ((d.decision || '').trim() || d.ownerName || (d.ownerText || '').trim() || (d.dueText || '').trim() || d.dueDate || d.state || d.accepted || d.doneConfirm || d.mark));
}

/**
 * What closing the meeting would do, in plain terms. Changes nothing.
 * Three things are kept strictly apart:
 *   draft               typed during the meeting, not accepted: never applied, only listed;
 *   accepted decision   the person pressed "Принять": becomes a decision on the order, with owner/deadline/state changes;
 *   confirmed completion  its own explicit confirmation: the only way an order becomes "Выполнено".
 */
function councilBuildClosePlan(meeting, orders, ctx) {
  const draft = meeting.draft || councilEmptyDraft();
  const agenda = meeting.agenda || [];
  const byId = new Map(orders.map(o => [o.orderId, o]));
  const decisions = [], skipped = [], untouched = [], drafts = [];
  agenda.forEach(item => {
    const d = draft.items[item.id];
    const order = item.orderId ? byId.get(item.orderId) : null;
    const base = { itemId: item.id, orderId: item.orderId, title: item.headline, group: item.group?.name || '' };
    if (!d || !councilDraftTouched(d)) { untouched.push(base); return; }
    const text = (d.decision || '').trim();
    const proposes = Boolean(text || d.ownerName || (d.ownerText || '').trim() || (d.dueText || '').trim() || d.dueDate || d.state);
    if (!d.accepted && !d.doneConfirm) {
      if (d.mark === 'skip' && !proposes) skipped.push(base); else drafts.push({ ...base, text, owner: d.ownerName || (d.ownerText || '').trim(), due: d.dueDate ? cdFmtFull(d.dueDate) : (d.dueText || '').trim(), state: d.state });
      return;
    }
    const changes = [];
    if (order) {
      if (d.accepted) {
        const ownerNew = d.ownerName || ((d.ownerText || '').trim() ? councilParseOwners(d.ownerText).raw : '');
        if (ownerNew && ownerNew !== (order.owners?.raw || '')) changes.push({ field: 'owner', label: 'Ответственный', from: order.owners?.raw || 'не назначен', to: ownerNew });
        const dueNew = d.dueDate ? cdFmtFull(d.dueDate) : (d.dueText || '').trim();
        if (dueNew && dueNew !== (order.due?.raw || '')) changes.push({ field: 'due', label: 'Срок', from: councilDueLabel(order.due), to: dueNew });
        if (d.state && d.state !== order.state && d.state !== 'done') changes.push({ field: 'state', label: 'Состояние', from: councilState(order.state).label, to: councilState(d.state).label });
      }
      if (d.doneConfirm) changes.push({ field: 'done', label: 'Выполнение', from: councilState(order.state).label, to: 'Выполнено, подтверждено на совете' });
    }
    decisions.push({ ...base, no: order?.no || '', text: d.accepted ? text : '', accepted: Boolean(d.accepted), changes, done: Boolean(d.doneConfirm), doneNote: (d.doneNote || '').trim(), draft: d, manual: item.kind === 'manual' && !item.orderId });
  });
  const newOrders = (draft.newOrders || []).filter(n => n.title && n.title.trim());
  const warnings = [];
  decisions.forEach(x => { if (x.done && !x.doneNote) warnings.push(`№${x.no || '?'}: выполнение подтверждено без пояснения, чем оно подтверждено`); });
  decisions.forEach(x => { if (x.accepted && !x.text && !x.changes.length) warnings.push(`«${councilShort(x.title, 60)}»: решение принято, но не записано`); });
  if (drafts.length) warnings.push(`Черновиков без «Принять»: ${drafts.length}. Они не применятся к поручениям, но попадут в протокол как незавершённое.`);
  return {
    date: meeting.date, decisions, newOrders, skipped, untouched, drafts, warnings,
    counts: { agenda: agenda.length, discussed: decisions.length, decisions: decisions.filter(x => x.accepted && x.text).length, owners: decisions.filter(x => x.changes.some(c => c.field === 'owner')).length, dues: decisions.filter(x => x.changes.some(c => c.field === 'due')).length, done: decisions.filter(x => x.done).length, created: newOrders.length, skipped: skipped.length, untouched: untouched.length, drafts: drafts.length }
  };
}

function councilOrderFromManual(data, ctx, id) {
  const project = councilProjectFor(data.project || '', ctx.projectMap || {});
  const created = ctx.now;
  const ownerRaw = cleanText(data.ownerName || data.owner || '');
  const owners = data.ownerName
    ? { raw: data.ownerName, state: 'assigned', people: [{ raw: data.ownerName, name: data.ownerName, matched: true, confidence: 'exact', external: false, role: 'owner' }], decider: '', joint: false, notes: [], by: 'user' }
    : councilParseOwners(ownerRaw);
  const due = data.dueDate ? { raw: cdFmtFull(data.dueDate), kind: 'exact', date: data.dueDate, items: [], note: '', inferred: false } : councilParseDue(data.dueText || '', ctx.today);
  const order = {
    id: 'order:' + id, kind: 'order', orderId: id, rev: 0, createdAt: created, updatedAt: created, no: '',
    title: cleanText(data.title), projectRaw: cleanText(data.project || ''), projectId: project.projectId, projectVia: project.via,
    owners, result: cleanText(data.result || ''), due, statusRaw: '', state: 'open', critical: false, claimedDone: false, statusTags: [],
    blockerRaw: '', blocks: [], comment: '', done: null, cancelled: null, updates: [],
    by: { title: 'meeting', project: 'meeting', owners: 'meeting', result: 'meeting', due: 'meeting', state: 'meeting', blocker: 'meeting' },
    source: { importId: '', row: 0, last: {}, seenAt: [] }, events: []
  };
  order.events.push(councilNewEvent('created', ctx, { id: councilEventId('ev', ctx.meetingId || 'manual', id, 'created'), by: ctx.by || 'user', meetingId: ctx.meetingId || '', asOf: ctx.today, text: ctx.meetingId ? `Создано на техсовете ${cdFmt(ctx.today)}` : 'Добавлено вручную' }));
  return order;
}

/**
 * Applies the close plan: orders get decision, owner, deadline, state and confirmed completion events tied to the meeting;
 * new orders are created; the meeting becomes "closed" with a frozen summary. Event ids are tied to the meeting, so a second
 * attempt after a failure does not duplicate anything.
 */
function councilApplyClose(plan, meeting, orders, ctx) {
  const byId = new Map(orders.map(o => [o.orderId, o]));
  const c = { ...ctx, meetingId: meeting.id, today: meeting.date };
  const touched = [];
  const decided = [];
  plan.decisions.forEach(x => {
    if (!x.orderId || !byId.has(x.orderId)) { decided.push({ ...x, draft: undefined }); return; }
    let order = byId.get(x.orderId);
    const d = x.draft;
    const patch = {};
    if (x.accepted) {
      if (d.ownerName) patch.ownerName = d.ownerName; else if ((d.ownerText || '').trim()) patch.ownerText = d.ownerText.trim();
      if (d.dueDate) patch.dueDate = d.dueDate; else if ((d.dueText || '').trim()) patch.dueText = d.dueText.trim();
      if (d.state && d.state !== 'done') { patch.state = d.state; if (d.state === 'blocked' && d.blockNote?.trim()) patch.blockText = d.blockNote.trim(); }
    }
    if (Object.keys(patch).length) order = councilEdit(order, patch, { ...c, by: ctx.by || 'meeting' }).order;
    if (x.accepted && x.text) order = councilRecordDecision(order, { text: x.text, meetingId: meeting.id, date: meeting.date, owner: d.ownerName || d.ownerText, due: d.dueDate ? cdFmtFull(d.dueDate) : d.dueText, eventId: councilEventId('ev', meeting.id, x.itemId, 'decision') }, c);
    if (x.done && order.state !== 'done') order = councilConfirmDone(order, { note: x.doneNote, eventId: councilEventId('ev', meeting.id, x.itemId, 'done') }, c);
    touched.push(order);
    decided.push({ itemId: x.itemId, orderId: x.orderId, no: x.no, title: x.title, group: x.group, text: x.text, accepted: x.accepted, changes: x.changes, done: x.done, doneNote: x.doneNote });
  });
  const created = [];
  const taken = new Set([...orders.map(o => o.orderId), ...touched.map(o => o.orderId)]);
  plan.newOrders.forEach(n => {
    const id = n.id && councilIsOrderId(n.id) && !byId.has(n.id) ? n.id : councilNewId(taken);
    taken.add(id);
    const order = councilOrderFromManual(n, c, id);
    created.push(order);
  });
  const summaryText = councilSummaryText(plan, decided, created, meeting);
  const closed = {
    ...councilClone(meeting), status: 'closed', closedAt: ctx.now, closedBy: ctx.by || '', draft: null,
    result: {
      counts: plan.counts, decisions: decided, newOrders: created.map(o => ({ orderId: o.orderId, title: o.title, project: o.projectRaw, owner: o.owners.raw, due: o.due.raw })),
      skipped: plan.skipped, drafts: plan.drafts, untouched: plan.untouched.map(u => ({ itemId: u.itemId, orderId: u.orderId, title: u.title })), notes: (meeting.draft?.notes || '').trim(), summaryText
    }
  };
  closed.protocol = { ...(meeting.protocol || { text: '', files: [] }) };
  if (!closed.protocol.text) closed.protocol.text = councilProtocolDraft(closed);
  return { orders: [...touched, ...created], meeting: closed };
}

/* ---------- texts ---------- */

function councilSummaryText(plan, decided, created, meeting) {
  const c = plan.counts;
  const lines = [`Техсовет ${cdFmtFull(meeting.date)}: рассмотрено ${c.discussed} из ${c.agenda} ${pluralRu(c.agenda, 'вопроса', 'вопросов', 'вопросов')}.`];
  const parts = [];
  if (c.decisions) parts.push(`решений записано: ${c.decisions}`);
  if (c.owners) parts.push(`назначено ответственных: ${c.owners}`);
  if (c.dues) parts.push(`изменено сроков: ${c.dues}`);
  if (c.done) parts.push(`подтверждено выполнение: ${c.done}`);
  if (c.created) parts.push(`новых поручений: ${c.created}`);
  if (parts.length) { const t = parts.join(', '); lines.push(t.charAt(0).toUpperCase() + t.slice(1) + '.'); }
  else lines.push('Решений и изменений не записано.');
  if (c.drafts) lines.push(`Черновики без решения: ${c.drafts}. К поручениям не применены.`);
  if (c.untouched) lines.push(`Не рассмотрено: ${c.untouched}. Эти вопросы остаются открытыми.`);
  return lines.join(' ');
}

/** Protocol draft from what was entered during the meeting. Nothing is added from outside. */
function councilProtocolDraft(meeting) {
  const r = meeting.result;
  if (!r) return '';
  const out = [`ПРОТОКОЛ ТЕХНИЧЕСКОГО СОВЕТА ИТО (ЧЕРНОВИК)`, `Дата: ${cdFmtFull(meeting.date)}`, '', r.summaryText || ''];
  const byGroup = new Map();
  (r.decisions || []).forEach(d => { (byGroup.get(d.group || 'Прочее') || byGroup.set(d.group || 'Прочее', []).get(d.group || 'Прочее')).push(d); });
  if (byGroup.size) out.push('', 'РЕШЕНИЯ И ДОГОВОРЁННОСТИ');
  byGroup.forEach((list, group) => {
    out.push('', group);
    list.forEach((d, i) => {
      out.push(`${i + 1}. ${d.no ? `№${d.no} ` : ''}${councilShort(d.title, 160)}${d.orderId ? ` [${d.orderId}]` : ''}`);
      if (d.text) out.push(`   Решение: ${d.text}`);
      (d.changes || []).forEach(ch => out.push(`   ${ch.label}: ${ch.from} → ${ch.to}`));
      if (d.done) out.push(`   Выполнено (подтверждено на совете)${d.doneNote ? ': ' + d.doneNote : ''}`);
    });
  });
  if ((r.newOrders || []).length) {
    out.push('', 'НОВЫЕ ПОРУЧЕНИЯ');
    r.newOrders.forEach((n, i) => out.push(`${i + 1}. ${n.project ? n.project + ': ' : ''}${n.title} [${n.orderId}]`, `   Ответственный: ${n.owner || 'не назначен'}. Срок: ${n.due || 'не задан'}.`));
  }
  if ((r.drafts || []).length) { out.push('', 'ЧЕРНОВИКИ БЕЗ ПРИНЯТОГО РЕШЕНИЯ (к поручениям не применены)'); r.drafts.forEach((u, i) => out.push(`${i + 1}. ${councilShort(u.title, 120)}${u.text ? ': ' + u.text : ''}`)); }
  if ((r.untouched || []).length) { out.push('', 'НЕ РАССМОТРЕНО (остаётся открытым)'); r.untouched.forEach((u, i) => out.push(`${i + 1}. ${councilShort(u.title, 140)}`)); }
  if (r.notes) out.push('', 'ЗАМЕТКИ', r.notes);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ---------- timeline of one order ---------- */

function councilTimeline(order, meetings = []) {
  const meetingByDate = new Map(meetings.map(m => [m.date, m]));
  return councilEventsSorted(order).map(e => {
    const day = councilEventDay(e);
    const meeting = e.meetingId ? meetings.find(m => m.id === e.meetingId) : null;
    const tone = e.type === 'done' ? 'ok' : e.type === 'block-added' ? 'bad' : e.type === 'decision' ? 'info' : e.type === 'cancelled' ? 'muted' : 'plain';
    let title = '', text = e.text || '';
    switch (e.type) {
      case 'created': title = 'Появилось'; break;
      case 'status-note': title = e.label || 'Обновление статуса'; break;
      case 'import-update': title = `Изменено в реестре: ${(e.label || e.field || '').toLowerCase()}`; text = `${councilShort(e.from, 140) || '—'} → ${councilShort(e.to, 140) || '—'}`; break;
      case 'source-note': title = `В реестре иначе: ${(e.label || e.field || '').toLowerCase()}`; text = `${e.text}. В файле: ${councilShort(e.to, 140)}`; break;
      case 'edit': title = `Изменено вручную: ${(e.label || e.field || '').toLowerCase()}`; text = `${councilShort(e.from, 140) || '—'} → ${councilShort(e.to, 140) || '—'}`; break;
      case 'owner': title = 'Ответственный'; text = `${e.from || 'не назначен'} → ${e.to || 'не назначен'}`; break;
      case 'deadline': title = 'Срок'; text = `${e.from || 'не задан'} → ${e.to || 'не задан'}`; break;
      case 'state': title = 'Состояние'; text = `${e.from} → ${e.to}`; break;
      case 'decision': title = meeting ? `Решение техсовета ${cdFmt(meeting.date)}` : 'Решение'; break;
      case 'done': title = 'Выполнено, подтверждено'; break;
      case 'reopened': title = 'Возвращено в работу'; break;
      case 'cancelled': title = 'Снято'; break;
      case 'block-added': title = 'Появился блокер'; break;
      case 'block-resolved': title = 'Блокер снят'; break;
      case 'matched': title = 'Сопоставлено вручную'; break;
      default: title = e.type;
    }
    return { id: e.id, type: e.type, day, tone, title, text, by: e.by, meetingId: e.meetingId || '', meetingDate: meeting?.date || (meetingByDate.has(day) ? day : ''), inferred: Boolean(e.asOfInferred) };
  });
}

/** Everything the card of a project needs: counts of open assignments and the nearest control date. */
function councilProjectBlock(orders, projectId, today) {
  const mine = orders.filter(o => o.projectId === projectId && councilIsOpen(o));
  if (!mine.length) return null;
  const dates = mine.map(o => { const d = councilDueDate(o.due); return d && cdDiff(d, today) >= 0 ? d : ''; }).filter(Boolean).sort();
  const items = mine.filter(o => councilNeedsDecision(o) || o.state === 'blocked');
  return { open: mine.length, needsDecision: mine.filter(councilNeedsDecision).length, blocked: mine.filter(o => o.state === 'blocked').length, nearest: dates[0] || '', ids: items.map(o => o.orderId) };
}

/* ---------- export ---------- */

function councilStatusLabel(order) {
  if (order.state === 'done') return `Выполнено, подтверждено ${cdFmt(order.done?.day || String(order.done?.at || '').slice(0, 10))}${order.done?.note ? ': ' + order.done.note : ''}`;
  if (order.state === 'cancelled') return `Снято${order.cancelled?.reason ? ': ' + order.cancelled.reason : ''}`;
  const base = councilState(order.state).label;
  const blocks = councilActiveBlocks(order).filter(b => b.kind !== 'order' || b.ref);
  return blocks.length ? `${base}: ${blocks.map(b => b.kind === 'order' ? 'ждёт другое поручение' : councilBlockKind(b.kind).label.toLowerCase()).join(', ')}` : base;
}

/** Book for xlsxWrite: the registry the way the team keeps it, plus ID, current status and the latest decision. */
function councilExportBook(orders, meetings, opts = {}) {
  const today = opts.today || cdLocalToday();
  const list = (opts.hideClosed ? orders.filter(councilIsOpen) : orders).slice();
  const groups = councilGroups(list);
  const labels = [];
  list.forEach(o => (o.updates || []).forEach(u => { if (!labels.includes(u.label)) labels.push(u.label); }));
  const updateLabels = labels.length ? labels : ['Статус на среду', 'Статус на пятницу'];
  const headers = ['№', 'Проект', 'Задача', 'Ответственный', 'Ожидаемый результат', 'Срок / контрольная точка', `Статус на ${cdFmt(today)}`, 'Блокер / примечание', ...updateLabels, 'ID', 'Текущий статус', 'Решение техсовета', 'Изменено'];
  const widths = [5, 16, 52, 26, 38, 20, 24, 36, ...updateLabels.map(() => 44), 13, 30, 44, 12];
  const styles = {
    head: { bold: true, color: '#FFFFFF', fill: '#1F2937', wrap: true, valign: 'center', border: '#D8D6CC' },
    cell: { wrap: true, valign: 'top', border: '#D8D6CC' },
    band: { wrap: true, valign: 'top', border: '#D8D6CC', fill: '#F3F2EE' },
    date: { valign: 'top', border: '#D8D6CC', numFmt: 'dd.mm', align: 'left' },
    dateBand: { valign: 'top', border: '#D8D6CC', numFmt: 'dd.mm', align: 'left', fill: '#F3F2EE' },
    bad: { wrap: true, valign: 'top', border: '#D8D6CC', fill: '#FDE9E7', color: '#8A1914' },
    warn: { wrap: true, valign: 'top', border: '#D8D6CC', fill: '#FFF3D6', color: '#8A5A00' },
    ok: { wrap: true, valign: 'top', border: '#D8D6CC', fill: '#E3F2EA', color: '#1B6B49' },
    id: { valign: 'top', border: '#D8D6CC', color: '#66665D' },
    idBand: { valign: 'top', border: '#D8D6CC', color: '#66665D', fill: '#F3F2EE' }
  };
  const rows = [headers.map(h => ({ v: h, style: 'head' }))];
  let n = 0;
  groups.forEach((g, gi) => {
    const band = gi % 2 === 1;
    const sorted = g.orders.slice().sort((a, b) => Number(a.no || 9999) - Number(b.no || 9999) || String(a.createdAt).localeCompare(String(b.createdAt)));
    sorted.forEach(o => {
      n++;
      const cell = band ? 'band' : 'cell';
      const dec = councilLastDecision(o);
      const dueExact = o.due?.kind === 'exact' && cdValid(o.due.date) && !o.due.note;
      const overdue = councilIsOverdue(o, today);
      const manualBlocks = councilActiveBlocks(o).filter(b => b.by !== 'import').map(b => b.kind === 'order' ? `Ждёт поручение ${(orders.find(x => x.orderId === b.ref) || {}).no ? '№' + orders.find(x => x.orderId === b.ref).no : b.ref}` : `${councilBlockKind(b.kind).label}${b.text ? ': ' + b.text : ''}`);
      const blocker = [o.blockerRaw, ...manualBlocks].filter(Boolean).join('\n');
      const statusStyle = o.state === 'done' ? 'ok' : (o.state === 'blocked' || overdue || o.critical) ? 'bad' : (o.state === 'decision' || !councilHasOwner(o)) ? 'warn' : cell;
      const row = [
        { v: n, style: cell }, { v: o.projectRaw || '', style: cell }, { v: o.title, style: cell },
        { v: o.owners?.raw || '', style: cell }, { v: o.result || '', style: cell },
        dueExact ? { v: o.due.date, t: 'd', style: band ? 'dateBand' : 'date' } : { v: o.due?.raw || '', style: overdue ? 'bad' : cell },
        { v: o.statusRaw || '', style: cell }, { v: blocker, style: cell },
        ...updateLabels.map(label => { const u = (o.updates || []).filter(x => x.label === label).at(-1); return { v: u ? u.text : '', style: cell }; }),
        { v: o.orderId, style: band ? 'idBand' : 'id' },
        { v: councilStatusLabel(o) + (overdue ? `. Просрочено на ${daysWord(councilOverdueDays(o, today))}` : ''), style: statusStyle },
        { v: dec ? `${cdFmt(councilEventDay(dec))}: ${dec.text}` : '', style: cell },
        { v: String(o.updatedAt || '').slice(0, 10), t: 'd', style: band ? 'dateBand' : 'date' }
      ];
      rows.push(row);
    });
  });
  const history = [['Дата', 'Заседание', 'ID', '№', 'Проект', 'Поручение', 'Событие', 'Описание', 'Кто'].map(h => ({ v: h, style: 'head' }))];
  const entries = [];
  list.forEach(o => councilTimeline(o, meetings).forEach(e => { if (e.type !== 'status-note' || true) entries.push({ o, e }); }));
  entries.sort((a, b) => String(a.e.day).localeCompare(String(b.e.day)) || String(a.o.orderId).localeCompare(String(b.o.orderId)));
  entries.forEach(({ o, e }) => {
    const m = meetings.find(x => x.id === e.meetingId);
    history.push([
      e.day && cdValid(e.day) ? { v: e.day, t: 'd', style: 'date' } : '', { v: m ? `Техсовет ${cdFmt(m.date)}` : '', style: 'cell' }, { v: o.orderId, style: 'id' }, { v: o.no || '', style: 'cell' },
      { v: o.projectRaw || '', style: 'cell' }, { v: councilShort(o.title, 120), style: 'cell' }, { v: e.title, style: 'cell' }, { v: e.text || '', style: 'cell' }, { v: e.by || '', style: 'cell' }
    ]);
  });
  return {
    props: { creator: 'Coordination ИТО', created: opts.now || new Date().toISOString() }, styles,
    sheets: [
      { name: 'Реестр', widths, freeze: { rows: 1 }, filter: true, rows },
      { name: 'История', widths: [11, 16, 12, 5, 18, 44, 28, 60, 10], freeze: { rows: 1 }, filter: true, rows: history }
    ]
  };
}

/* ---------- protocol text: suggestions only, nothing is created without a person ---------- */

/**
 * Lines like "Поручение: подготовить спецификацию, Павел, до 15.10" are offered as new orders. This is a plain rule, not a guess engine:
 * the person sees every suggestion and decides.
 */
function councilProtocolSuggestions(text, refDate) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = /^\s*(?:[-•*]|\d+[.)])?\s*(?:поручение|поручить|задача|действие)\s*[:—-]\s*(.{6,})$/i.exec(line);
    if (!m) return;
    const rest = cleanText(m[1]);
    const dueMatch = /(?:^|[\s,;(])до\s+(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/i.exec(rest);
    let due = '';
    if (dueMatch) {
      const year = dueMatch[3] ? (dueMatch[3].length === 2 ? 2000 + Number(dueMatch[3]) : Number(dueMatch[3])) : 0;
      due = year ? `${year}-${String(dueMatch[2]).padStart(2, '0')}-${String(dueMatch[1]).padStart(2, '0')}` : councilInferYear(Number(dueMatch[1]), Number(dueMatch[2]), refDate || cdLocalToday());
    }
    const people = councilParseOwners(rest).people.filter(p => p.matched && !p.external);
    const owner = people.length === 1 ? people[0].name : '';
    const title = cleanText(rest.replace(/(?:^|[\s,;(])до\s+\d{1,2}\.\d{1,2}(?:\.\d{2,4})?/ig, '').replace(/[,;]\s*$/, ''));
    if (title.length >= 6) out.push({ title, owner, due: due ? cdFmtFull(due) : '', dueDate: due });
  });
  return out;
}
