'use strict';
/*
 * Tech council ("Техсовет") model, part 1: reading the weekly registry and keeping assignments as long-lived entities.
 * Pure functions, no DOM, no storage. Dates inside the model are ISO day strings ("2026-10-15"), times are ISO timestamps.
 *
 * Principles:
 *  - raw cell text is always kept next to what was understood from it;
 *  - a status from the file ("УСТАНОВЛЕНА", "В РАБОТЕ", "ОЖИДАНИЕ РЕШЕНИЯ") is never completion; completion exists only after explicit confirmation;
 *  - empty cells and missing rows never close, cancel or delete anything;
 *  - every field remembers who wrote it last (file, person, meeting) so a re-import cannot silently overwrite a manual edit.
 */

const COUNCIL_STATES = [
  { id: 'open', label: 'Открыто' },
  { id: 'in_progress', label: 'В работе' },
  { id: 'decision', label: 'Требует решения' },
  { id: 'blocked', label: 'Заблокировано' },
  { id: 'control', label: 'На контроле' },
  { id: 'done', label: 'Выполнено' },
  { id: 'cancelled', label: 'Отменено' }
];
const COUNCIL_BLOCK_KINDS = [
  { id: 'order', label: 'Зависит от другого поручения' },
  { id: 'external', label: 'Ждём внешнее решение' },
  { id: 'delivery', label: 'Ждём поставку' },
  { id: 'approval', label: 'Ждём согласование' },
  { id: 'finance', label: 'Финансовая блокировка' },
  { id: 'other', label: 'Другая блокировка' }
];
const COUNCIL_DUE_KINDS = {
  none: 'Срок не задан', exact: 'Срок', checkpoint: 'Контрольная точка', horizon: 'Горизонт', relative: 'Относительный срок', condition: 'Условие'
};
const COUNCIL_OWNER_STATES = {
  assigned: 'Владелец назначен', unassigned: 'Владелец не назначен', ambiguous: 'Владелец назван не полностью', group: 'Ответственная группа', none: 'Владелец не указан'
};
const COUNCIL_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function councilState(id) { return COUNCIL_STATES.find(s => s.id === id) || COUNCIL_STATES[0]; }
function councilBlockKind(id) { return COUNCIL_BLOCK_KINDS.find(k => k.id === id) || COUNCIL_BLOCK_KINDS[5]; }

/* ---------- ISO day helpers (no time zones, no Date parsing surprises) ---------- */

function cdParse(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN; }
function cdValid(iso) { return Number.isFinite(cdParse(iso)); }
function cdFrom(ms) { const d = new Date(ms); return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
function cdAdd(iso, n) { return cdFrom(cdParse(iso) + n * 86400000); }
function cdDiff(a, b) { return Math.round((cdParse(a) - cdParse(b)) / 86400000); }
function cdWeekday(iso) { return new Date(cdParse(iso)).getUTCDay(); }
function cdFmt(iso) { return cdValid(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : ''; }
function cdFmtFull(iso) { return cdValid(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : ''; }
function cdLong(iso) { return cdValid(iso) ? `${Number(iso.slice(8, 10))} ${MONTHS_GEN[Number(iso.slice(5, 7)) - 1]}` : ''; }
function cdLocalToday(now = new Date()) { const d = new Date(now); return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function cdNextMonday(iso) { const wd = cdWeekday(iso); return cdAdd(iso, wd === 1 ? 7 : (8 - wd) % 7 || 7); }
function cdThisOrNextMonday(iso) { return cdWeekday(iso) === 1 ? iso : cdNextMonday(iso); }

/* ---------- ids ---------- */

function councilNewId(taken = new Set(), random) {
  const rnd = random || (() => {
    try { const a = new Uint8Array(1); crypto.getRandomValues(a); return a[0] / 256; } catch (_) { return Math.random(); }
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = 'TS-';
    for (let i = 0; i < 6; i++) id += COUNCIL_ID_ALPHABET[Math.floor(rnd() * COUNCIL_ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
  throw new Error('Не удалось подобрать свободный ID поручения');
}
function councilIsOrderId(value) { return /^TS-[A-Z0-9]{6}$/.test(String(value || '').trim().toUpperCase()); }
function councilEventId(...parts) { return parts.map(p => String(p).replace(/[^\w.:-]+/g, '_')).join(':'); }
function councilFnv(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) { h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0; h2 = (Math.imul(h2 ^ text.charCodeAt(i), 0x85ebca6b) + i) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/* ---------- status text ---------- */

/**
 * Reads the free-text status of the registry. Only describes what the text says: the result is never "done".
 * claimedDone: the text says the work is finished, which still has to be confirmed by a person.
 */
function councilParseStatus(raw) {
  const text = cleanText(raw);
  const up = normalizeHeader(text);
  const out = { raw: text, known: false, state: 'open', critical: false, blockKind: '', tags: [], claimedDone: false };
  if (!text) return out;
  const has = re => re.test(up);
  if (has(/критическ[а-я]*\s+зон/)) { out.critical = true; out.known = true; }
  if (has(/ожидание\s+согласован/)) Object.assign(out, { state: 'blocked', blockKind: 'approval', known: true });
  else if (has(/зависит\s+от\s+финансирован/)) Object.assign(out, { state: 'blocked', blockKind: 'finance', known: true });
  else if (has(/ожидание\s+поставк/)) Object.assign(out, { state: 'blocked', blockKind: 'delivery', known: true });
  else if (has(/ожидание/)) Object.assign(out, { state: 'blocked', blockKind: 'external', known: true });
  else if (has(/требует\s+решени/)) Object.assign(out, { state: 'decision', known: true });
  else if (has(/требует\s+действи/)) { Object.assign(out, { state: 'open', known: true }); out.tags.push('needs-action'); }
  else if (has(/в\s+работе/)) Object.assign(out, { state: 'in_progress', known: true });
  else if (has(/контрол[а-я]*\s+риск|условн/)) Object.assign(out, { state: 'control', known: true });
  else if (has(/финансов[а-я]*\s+контрол/)) { Object.assign(out, { state: 'control', known: true }); out.tags.push('finance'); }
  else if (has(/установлен/)) { out.known = true; out.tags.push('established'); }
  if (!/(^|\s)не\s+(выполнен|завершен|закрыт|готов)/.test(up) && has(/(^|[^а-я])(выполнен[а-я]*|завершен[а-я]*|закрыт[а-я]*|готов[а-я]*|сдан[а-я]*)([^а-я]|$)/) && !out.critical) { out.claimedDone = true; out.known = true; }
  return out;
}

/* ---------- people ---------- */

const COUNCIL_NICKNAMES = {
  саша: 'александр', саня: 'александр', алекс: 'александр', сашка: 'александр',
  сеня: 'семен', макс: 'максим', паша: 'павел', пашка: 'павел', ваня: 'иван', женя: 'евгения',
  костя: 'константин', дима: 'дмитрий', митя: 'дмитрий', петя: 'петр', вова: 'владимир', володя: 'владимир'
};
const COUNCIL_GROUP_RE = /команд|состав|отдел|групп|инженер|руковод|подрядчик|бригад|смен/;
const COUNCIL_ROLE_RE = /контрол|фиксаци|координаци|помощь|участник|согласован|по обсуждению|по контексту|поддержк|наблюда/;

function councilRosterWords() {
  return ITO_ROSTER.map(name => {
    const parts = normalizeHeader(name).split(' ');
    return { name, first: parts[0], last: parts[parts.length - 1], full: normalizeHeader(name), shown: normalizeHeader(displayName(name)) };
  });
}

/** One mention from the "Ответственный" cell: "Павел", "Саша", "Павел Сергеев", "Иван Иванов" (not ours). */
function councilMatchPerson(piece) {
  const raw = cleanText(piece);
  const base = { raw, name: '', matched: false, confidence: '', external: false };
  const tokens = normalizeHeader(raw).split(' ').filter(Boolean);
  if (!tokens.length || tokens.length > 3) return base;
  const roster = councilRosterWords();
  if (tokens.length === 1) {
    const t = COUNCIL_NICKNAMES[tokens[0]] || tokens[0];
    const alias = t !== tokens[0];
    const byFirst = roster.filter(r => r.first === t);
    const bySurname = roster.filter(r => r.last === tokens[0] || r.shown.endsWith(' ' + tokens[0]));
    const hit = byFirst.length === 1 ? byFirst : bySurname.length === 1 && !byFirst.length ? bySurname : [];
    if (hit.length === 1) return { ...base, name: hit[0].name, matched: true, confidence: alias ? 'alias' : byFirst.length ? 'name' : 'surname' };
    return base;
  }
  const exact = matchRosterPerson(raw);
  if (exact) return { ...base, name: exact, matched: true, confidence: 'exact' };
  const first = COUNCIL_NICKNAMES[tokens[0]] || tokens[0];
  if (roster.some(r => r.first === first)) return { ...base, external: true };
  return { ...base, external: true };
}

function councilMentions(text) {
  const out = [];
  String(text || '').split(/\s*(?:,|\/|\sи\s|&|\+)\s*/).forEach(part => {
    const piece = cleanText(part).replace(/^(?:и|а также)\s+/i, '');
    if (!/^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?$/.test(piece)) return;
    if (COUNCIL_GROUP_RE.test(normalizeHeader(piece))) return;
    out.push(piece);
  });
  return out;
}

/**
 * Who is responsible according to the free text. Never invents an owner:
 * "Владелец не назначен" stays unassigned even when people are named as coordinators.
 */
function councilParseOwners(raw) {
  const text = cleanText(raw);
  const out = { raw: text, state: 'none', people: [], decider: '', joint: false, notes: [] };
  if (!text) return out;
  const segments = text.split(/;|\.\s+(?=[А-ЯЁA-Z])/).map(s => s.trim().replace(/\.$/, '')).filter(Boolean);
  let unassigned = false, unidentified = false, hasGroup = false;
  const add = (piece, role) => {
    const person = councilMatchPerson(piece);
    if (!out.people.some(p => p.raw === person.raw && p.role === role)) out.people.push({ ...person, role });
  };
  for (const seg of segments) {
    const low = normalizeHeader(seg);
    const dash = seg.search(/\s[—–-]\s/);
    const head = dash >= 0 ? seg.slice(0, dash).trim() : seg;
    const tail = dash >= 0 ? seg.slice(dash).replace(/^\s[—–-]\s/, '').trim() : '';
    const lowHead = normalizeHeader(head), lowTail = normalizeHeader(tail);
    if (/не\s+назначен/.test(low) || /формальн[а-я]*\s+назначени[а-я]*.*не\s+прозвуч/.test(low)) unassigned = true;
    if (/фамили[а-я]*\s+не\s+назван|не\s+идентифицирован/.test(low)) unidentified = true;
    if (/источник\s+решени|решени[а-я]*\s+принима/.test(lowHead)) { out.decider = cleanText(tail || head.replace(/^.*?решени[а-я]*\s*/i, '')); continue; }
    if (/не\s+назначен/.test(low) && !councilMentions(tail).length) continue;
    if (COUNCIL_GROUP_RE.test(lowHead) && !councilMentions(head).length) { hasGroup = true; continue; }
    if (/(владелец|ответственн)/.test(lowHead) && !/не\s+назначен/.test(lowHead) && tail) {
      councilMentions(tail).forEach(p => add(p, 'owner'));
      continue;
    }
    const headMentions = councilMentions(head);
    const tailMentions = councilMentions(tail);
    const people = headMentions.length ? headMentions : tailMentions;
    const roleText = headMentions.length ? lowTail : lowHead;
    const role = COUNCIL_ROLE_RE.test(roleText) ? (/контрол|фиксаци|координаци|наблюда/.test(roleText) ? 'control' : 'participant') : 'owner';
    people.forEach(p => add(p, role));
  }
  const owners = out.people.filter(p => p.role === 'owner' && !p.external);
  out.joint = owners.length > 1;
  if (unassigned) out.state = 'unassigned';
  else if (owners.some(p => p.matched) && !unidentified) out.state = 'assigned';
  else if (hasGroup && !owners.length) out.state = 'group';
  else out.state = 'ambiguous';
  if (unidentified) out.notes.push('в реестре отмечено, что человек назван не полностью');
  return out;
}

function councilOwnerNames(order) {
  const people = order.owners?.people || [];
  const pick = people.filter(p => p.matched && p.role === 'owner');
  return [...new Set((pick.length ? pick : people.filter(p => p.matched)).map(p => p.name))];
}
function councilInvolvedNames(order) { return [...new Set((order.owners?.people || []).filter(p => p.matched).map(p => p.name))]; }
function councilHasOwner(order) { return order.owners?.state === 'assigned'; }

/* ---------- deadline text ---------- */

function councilInferYear(day, month, ref) {
  const base = ref && cdValid(ref) ? Number(ref.slice(0, 4)) : new Date().getFullYear();
  let iso = `${base}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (cdValid(ref) && cdDiff(ref, iso) > 200) iso = `${base + 1}-${iso.slice(5)}`;
  else if (cdValid(ref) && cdDiff(iso, ref) > 300) iso = `${base - 1}-${iso.slice(5)}`;
  const d = new Date(cdParse(iso));
  return d.getUTCMonth() + 1 === Number(month) && d.getUTCDate() === Number(day) ? iso : '';
}

/**
 * Splits a "Срок / контрольная точка" cell into what it really is:
 *   exact       - one date (a real date cell, "15.10", "05.10 вечером")
 *   checkpoint  - "Первый статус 06.10", "07.10 — решение; 08.10 — подготовка": a point to check, not necessarily the end of the work
 *   horizon     - "Оперативно; горизонт до 15.10": a soft limit
 *   relative    - "Текущая неделя": counted from the registry date, so the date is only an estimate
 *   condition   - "После решения по оборудованию": no date at all
 *   none        - empty or "Срок не установлен"
 * `raw` always keeps the text as the person saw it.
 */
function councilParseDue(cell, ref) {
  const out = { raw: '', kind: 'none', date: '', items: [], note: '', inferred: false };
  if (cell === null || cell === undefined || cell === '') return out;
  if (typeof cell === 'object' && cell.t === 'd') {
    out.raw = cleanText(cell.text || cdFmt(String(cell.v).slice(0, 10)));
    out.kind = 'exact';
    out.date = String(cell.v).slice(0, 10);
    if (String(cell.v).length > 10) out.note = String(cell.v).slice(11, 16);
    return out;
  }
  const text = cleanText(typeof cell === 'object' ? (cell.text ?? cell.v) : cell);
  out.raw = text;
  if (!text) return out;
  const low = normalizeHeader(text);
  if (/^(срок\s+)?не\s+установлен|^без\s+срока|^не\s+определен|^нет$|^-+$/.test(low)) return out;
  const dateRe = /(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?/g;
  const dates = [];
  let m;
  while ((m = dateRe.exec(text))) {
    let iso = '';
    if (m[3]) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); iso = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; if (!cdValid(iso) || new Date(cdParse(iso)).getUTCDate() !== Number(m[1])) iso = ''; }
    else iso = councilInferYear(Number(m[1]), Number(m[2]), ref);
    if (iso) dates.push({ iso, at: m.index, end: m.index + m[0].length });
  }
  const conditionRe = /(^|[\s;,])(после|до\s+(внесения|получения|решения|подтверждения|согласования)|через|при\s|в\s+случае|когда|по\s+готовности|по\s+факту|пока|если)/;
  const checkpointRe = /статус|контрол|проверк|созвон|решени|подготовк|отчет|обсужд/;
  if (/текущ[а-я]*\s+недел|эт[а-я]*\s+недел|на\s+неделе/.test(low) && !dates.length) {
    const wd = ref && cdValid(ref) ? cdWeekday(ref) : 1;
    out.kind = 'relative';
    if (ref && cdValid(ref)) { out.date = cdAdd(ref, wd === 0 ? 0 : 7 - wd); out.inferred = true; }
    return out;
  }
  if (/^(сегодня|завтра)$/.test(low) && ref && cdValid(ref)) { out.kind = 'relative'; out.date = cdAdd(ref, low === 'завтра' ? 1 : 0); out.inferred = true; return out; }
  if (!dates.length) { out.kind = /^оперативно\s*$/.test(low) ? 'relative' : 'condition'; return out; }
  // "17.10 если подрядчик не ответит — эскалация": the date is a real control point and the condition says what happens then.
  const dateThenIf = /^\d{1,2}\.\d{1,2}(\.\d{2,4})?\s*[,—–:-]*\s*(если|в\s+случае|при\s)/.test(low);
  if (conditionRe.test(low) && !checkpointRe.test(low) && !/горизонт/.test(low) && !dateThenIf) {
    out.kind = 'condition'; out.items = dates.map(d => ({ date: d.iso, label: '' })); return out;
  }
  if (/горизонт|до\s+\d{1,2}\.\d{1,2}/.test(low) && dates.length === 1) { out.kind = 'horizon'; out.date = dates[0].iso; return out; }
  if (dates.length > 1 || checkpointRe.test(low) || dateThenIf) {
    out.kind = 'checkpoint';
    out.items = dates.map((d, i) => {
      const next = dates[i + 1] ? dates[i + 1].at : text.length;
      const before = i === 0 ? text.slice(0, d.at) : '';
      const label = cleanText((text.slice(d.end, next) + ' ' + before).replace(/[—–\-;:,]+/g, ' ')).replace(/^[^а-яёa-z0-9]+/i, '');
      return { date: d.iso, label };
    });
    out.date = out.items.map(i => i.date).sort()[0];
    return out;
  }
  const rest = cleanText(text.replace(dateRe, ' ').replace(/[—–\-;:,]+/g, ' '));
  out.kind = 'exact';
  out.date = dates[0].iso;
  out.note = rest;
  return out;
}

/** The date that matters for "is it late": the last date of a checkpoint series, or the single date. */
function councilDueDate(due) {
  if (!due || !['exact', 'checkpoint', 'horizon'].includes(due.kind)) return '';
  if (due.kind === 'checkpoint' && due.items?.length) return due.items.map(i => i.date).sort().at(-1);
  return due.date || '';
}
function councilDueLabel(due) {
  if (!due || due.kind === 'none') return 'Срок не задан';
  return due.raw || cdFmt(due.date);
}

/* ---------- projects ---------- */

const COUNCIL_PROJECT_ALIASES = {
  kazan: ['казань', 'цум', 'казанский цум', 'цум казань'],
  grozny: [], bakhrushin: ['бахрушин', 'музей бахрушина'], csn: ['цсн'], ekb: ['екб', 'екатеринбург'],
  luzhniki: ['лужники'], tapiau: ['тапиау'], kresty: ['кресты'], 'dom-kultur': ['дом культур']
};
const COUNCIL_PROJECT_SOFT = { grozny: ['грозный'] };

function councilProjectIndex() {
  const exact = new Map();
  const soft = new Map();
  for (const p of ITO_PROJECTS) {
    const names = [p.name, p.fullName, ...(p.aliases || []), ...(COUNCIL_PROJECT_ALIASES[p.id] || [])];
    names.forEach(n => exact.set(projectKey(n), p));
    (COUNCIL_PROJECT_SOFT[p.id] || []).forEach(n => soft.set(projectKey(n), p));
  }
  return { exact, soft };
}

/**
 * Registry project name -> project of the dashboard.
 * via: 'alias' (known name), 'override' (confirmed by a person), 'suggest' (probably this one, not applied), 'direction' (not a project) or 'none'.
 */
function councilProjectFor(raw, overrides = {}) {
  const text = cleanText(raw);
  const out = { raw: text, projectId: '', name: '', via: 'none', suggestion: '' };
  if (!text) return out;
  const key = projectKey(text);
  const ov = overrides[key];
  if (ov === 'direction') return { ...out, via: 'direction' };
  if (ov && itoProjectById(ov)) return { ...out, projectId: ov, name: itoProjectById(ov).name, via: 'override' };
  const { exact, soft } = councilProjectIndex();
  if (exact.has(key)) { const p = exact.get(key); return { ...out, projectId: p.id, name: p.name, via: 'alias' }; }
  const firstPart = projectKey(text.split(/[\/,(]/)[0]);
  if (soft.has(firstPart) || (firstPart !== key && exact.has(firstPart))) { const p = soft.get(firstPart) || exact.get(firstPart); return { ...out, suggestion: p.id, via: 'suggest' }; }
  return out;
}

/* ---------- text similarity ---------- */

const COUNCIL_STOP = new Set(['для', 'при', 'под', 'над', 'без', 'или', 'как', 'что', 'это', 'все', 'его', 'она', 'они', 'так', 'уже', 'еще', 'нет', 'был', 'была', 'были', 'быть', 'есть', 'после', 'перед', 'также', 'чтобы', 'если', 'когда', 'которые', 'который', 'которая', 'всех', 'всем', 'свой', 'нужно', 'необходимо']);
function councilStems(text) {
  const words = normalizeHeader(text).replace(/[^a-zа-я0-9\s]+/g, ' ').split(' ').filter(Boolean);
  return new Set(words.filter(w => (w.length >= 3 || /^\d+$/.test(w) || /^[a-z]{2}$/.test(w)) && !COUNCIL_STOP.has(w)).map(w => w.slice(0, 6)));
}
function councilSimilarity(a, b) {
  const x = councilStems(a), y = councilStems(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  x.forEach(s => { if (y.has(s)) common++; });
  return (2 * common) / (x.size + y.size);
}
function councilKey(project, title) { return projectKey(project) + '|' + normalizeHeader(title).replace(/[^a-zа-я0-9]+/g, ' ').trim(); }

/* ---------- reading the registry sheet ---------- */

const COUNCIL_COLUMN_RULES = [
  ['id', /^(id|ид|идентификатор)(\s|$)|^id\s*пор|^постоянный\s*id/],
  ['no', /^(№|n|no|номер)(\s|$|\.)/],
  ['project', /^(проект|направлени)/],
  ['title', /^(задач|поручен|формулировк)/],
  ['owner', /^(ответственн|исполнител|владел)/],
  ['result', /^ожидаем/],
  ['due', /^(срок|контрольн)/],
  ['current', /^текущ[а-я]*\s+статус/],
  ['decision', /^(решени[а-я]*\s+техсовет|последнее\s+решени|дата\s+решени)/],
  ['blocker', /^(блокер|примечани)/],
  ['status', /^статус\s+на\s+\d/],
  ['update', /^статус\s+на\s+\D/],
  ['status', /^статус$/]
];

function councilCellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return cleanMultilineText(cell.text ?? (cell.v === undefined ? '' : String(cell.v)));
  return cleanMultilineText(String(cell));
}

/**
 * Finds the header of a registry sheet and reads the rows under it.
 * Returns { ok, errors, warnings, columns, rows, asOfGuess } and never throws on ugly data.
 */
function councilParseRegistry(sheet, opts = {}) {
  const rows = sheet?.rows || [];
  const result = { ok: false, errors: [], warnings: [], columns: [], rows: [], headerRow: -1, asOfGuess: null, sheetName: sheet?.name || '' };
  let header = -1, map = null;
  for (let r = 0; r < Math.min(rows.length, 12); r++) {
    const found = {};
    (rows[r] || []).forEach((cell, c) => {
      const h = normalizeHeader(councilCellText(cell));
      if (!h) return;
      for (const [key, re] of COUNCIL_COLUMN_RULES) if (re.test(h)) { if (key === 'update' || key === 'status' || !found[key]) (found[key] ||= []).push(c); break; }
    });
    const score = ['project', 'title', 'owner', 'due', 'result'].filter(k => found[k]).length;
    if (score >= 3 && found.title) { header = r; map = found; break; }
  }
  if (header < 0) {
    result.errors.push('Не нашёл заголовок реестра. Ожидаются колонки «Проект», «Задача», «Ответственный», «Срок / контрольная точка».');
    return result;
  }
  result.headerRow = header;
  const headers = (rows[header] || []).map(councilCellText);
  const col = key => (map[key] || [])[0];
  const statusCols = map.status || [];
  const updateCols = [...(map.update || []), ...statusCols.slice(1)].sort((a, b) => a - b);
  const known = new Set(Object.values(map).flat());
  result.columns = headers.map((h, c) => ({ index: c, header: h, role: Object.entries(map).find(([k, list]) => list.includes(c))?.[0] || '' })).filter(c => c.header);
  if (updateCols.length) result.columns.forEach(c => { if (updateCols.includes(c.index)) c.role = 'update'; });
  if (col('title') === undefined) result.errors.push('Не нашёл колонку с формулировкой поручения («Задача»).');
  if (col('project') === undefined) result.warnings.push('Нет колонки «Проект»: поручения попадут в группу «Без проекта».');
  const baseHeader = statusCols.length ? headers[statusCols[0]] : '';
  const baseDate = /(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/.exec(baseHeader || '');
  if (baseDate) {
    const ref = opts.today || cdLocalToday();
    const iso = baseDate[3] ? `${baseDate[3]}-${String(baseDate[2]).padStart(2, '0')}-${String(baseDate[1]).padStart(2, '0')}` : councilInferYear(Number(baseDate[1]), Number(baseDate[2]), opts.fileDate || ref);
    if (iso) result.asOfGuess = { date: iso, source: 'header', header: baseHeader };
  }
  if (!result.asOfGuess && opts.fileDate) result.asOfGuess = { date: opts.fileDate, source: 'file', header: '' };
  if (!result.asOfGuess) result.asOfGuess = { date: opts.today || cdLocalToday(), source: 'today', header: '' };
  if (result.errors.length) return result;

  let group = '';
  let blank = 0;
  for (let r = header + 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const texts = cells.map(councilCellText);
    const filled = texts.filter(Boolean).length;
    if (!filled) { blank++; continue; }
    const title = col('title') !== undefined ? texts[col('title')] || '' : '';
    const project = col('project') !== undefined ? texts[col('project')] || '' : '';
    if (!title) {
      if (filled === 1 && (project || texts[0])) { group = project || texts[0]; continue; }
      result.warnings.push(`Строка ${r + 1}: нет формулировки поручения, строка пропущена.`);
      continue;
    }
    const dueCell = col('due') !== undefined ? cells[col('due')] : null;
    const row = {
      rowIndex: r + 1,
      no: col('no') !== undefined ? texts[col('no')] : '',
      id: col('id') !== undefined ? texts[col('id')].toUpperCase() : '',
      project: project || group,
      title,
      owner: col('owner') !== undefined ? texts[col('owner')] : '',
      result: col('result') !== undefined ? texts[col('result')] : '',
      dueCell: dueCell && typeof dueCell === 'object' ? { t: dueCell.t, v: dueCell.v, text: dueCell.text, fmt: dueCell.fmt } : dueCell ?? null,
      dueText: col('due') !== undefined ? texts[col('due')] : '',
      status: statusCols.length ? texts[statusCols[0]] || '' : '',
      statusLabel: baseHeader,
      blocker: col('blocker') !== undefined ? texts[col('blocker')] : '',
      updates: updateCols.map(c => ({ col: c, label: headers[c], text: texts[c] || '' })).filter(u => u.text),
      extra: Object.fromEntries(headers.map((h, c) => [h, texts[c]]).filter(([h, v], i) => h && v && !known.has(i)))
    };
    row.no = String(row.no).replace(/\.0+$/, '');
    result.rows.push(row);
  }
  if (!result.rows.length) { result.errors.push('Под заголовком нет ни одного поручения.'); return result; }
  const numbers = result.rows.map(r => r.no).filter(Boolean);
  if (new Set(numbers).size !== numbers.length) result.warnings.push('В колонке «№» есть повторы. Это не мешает: поручения сопоставляются по постоянному ID и тексту.');
  const missingProject = result.rows.filter(r => !r.project).length;
  if (missingProject) result.warnings.push(`Без проекта: ${missingProject} ${pluralRu(missingProject, 'строка', 'строки', 'строк')}.`);
  result.ok = true;
  return result;
}

/* ---------- an order built from a registry row ---------- */

function councilNewEvent(type, ctx, extra = {}) {
  return { id: extra.id || councilEventId('ev', ctx.now, type, Math.random().toString(36).slice(2, 7)), type, at: ctx.now, by: ctx.by || 'user', ...extra };
}

function councilRowValues(row, ctx) {
  const project = councilProjectFor(row.project, ctx.projectMap || {});
  const due = councilParseDue(row.dueCell ?? row.dueText, ctx.asOf);
  if (!due.raw && row.dueText) due.raw = row.dueText;
  return { project, owners: councilParseOwners(row.owner), due, status: councilParseStatus(row.status) };
}

function councilSourceSnapshot(row) {
  return { title: row.title, project: row.project, owner: row.owner, result: row.result, due: row.dueText || '', status: row.status, blocker: row.blocker };
}

function councilBlocksFromStatus(status, blockerRaw, ctx) {
  if (status.state !== 'blocked') return [];
  return [{ id: councilEventId('blk', ctx.importId || ctx.now, 'status'), kind: status.blockKind || 'other', text: cleanText(blockerRaw) || status.raw, ref: '', decider: '', active: true, since: ctx.asOf, by: 'import', confirmed: true }];
}

/** A new order from a registry row. Everything the file says is kept; nothing is marked done. */
function councilOrderFromRow(row, ctx, id) {
  const v = councilRowValues(row, ctx);
  const created = ctx.now;
  const order = {
    id: 'order:' + id, kind: 'order', orderId: id, rev: 0,
    createdAt: created, updatedAt: created,
    no: row.no || '',
    title: row.title,
    projectRaw: row.project, projectId: v.project.projectId, projectVia: v.project.via,
    owners: v.owners,
    result: row.result,
    due: v.due,
    statusRaw: row.status,
    state: v.status.state, critical: v.status.critical, claimedDone: v.status.claimedDone,
    statusTags: v.status.tags,
    blockerRaw: row.blocker,
    blocks: councilBlocksFromStatus(v.status, row.blocker, ctx),
    comment: '',
    done: null, cancelled: null,
    updates: [],
    by: { title: 'import', project: 'import', owners: 'import', result: 'import', due: 'import', state: 'import', blocker: 'import' },
    source: { importId: ctx.importId, row: row.rowIndex, last: councilSourceSnapshot(row), seenAt: [ctx.asOf] },
    events: []
  };
  order.events.push(councilNewEvent('created', ctx, { id: councilEventId('ev', ctx.importId, id, 'created'), by: 'import', asOf: ctx.asOf, importId: ctx.importId, text: `Появилось в реестре от ${cdFmt(ctx.asOf)}, ${row.no ? '№' + row.no : 'строка ' + row.rowIndex}` }));
  councilAddUpdates(order, row, ctx);
  return order;
}

function councilUpdateKey(importId, label, text) { return councilFnv(normalizeHeader(label) + '|' + normalizeHeader(text)); }

/** Free-text updates ("Статус на среду") become dated entries of the history; the same text is never added twice. */
function councilAddUpdates(order, row, ctx) {
  let added = 0;
  (row.updates || []).forEach(u => {
    const key = councilUpdateKey(ctx.importId, u.label, u.text);
    if ((order.updates || []).some(x => x.key === key)) return;
    const asOf = councilUpdateDate(u.label, ctx.asOf);
    order.updates.push({ key, label: u.label, text: u.text, asOf: asOf.date, asOfInferred: asOf.inferred, importId: ctx.importId, at: ctx.now });
    order.events.push(councilNewEvent('status-note', ctx, { id: councilEventId('ev', 'upd', key), by: 'import', asOf: asOf.date, importId: ctx.importId, label: u.label, text: u.text }));
    added++;
  });
  return added;
}

const COUNCIL_WEEKDAYS = { понедельник: 1, вторник: 2, среду: 3, среда: 3, четверг: 4, пятницу: 5, пятница: 5, субботу: 6, воскресенье: 0 };
/** "Статус на среду" -> the Wednesday after the registry date (an estimate, marked as inferred). */
function councilUpdateDate(label, asOf) {
  const m = /(\d{1,2})\.(\d{1,2})/.exec(label || '');
  if (m) { const iso = councilInferYear(Number(m[1]), Number(m[2]), asOf); return { date: iso, inferred: false }; }
  const word = normalizeHeader(label || '').split(/\s+/).pop();
  if (COUNCIL_WEEKDAYS[word] !== undefined && asOf && cdValid(asOf)) {
    const want = COUNCIL_WEEKDAYS[word];
    let d = cdAdd(asOf, 1);
    for (let i = 0; i < 7 && cdWeekday(d) !== want; i++) d = cdAdd(d, 1);
    return { date: d, inferred: true };
  }
  return { date: '', inferred: false };
}
