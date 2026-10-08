'use strict';
/*
 * UI kit: small pure functions that return HTML strings (icons, severity marks, avatars, rings, chips, glossary).
 * Severity is always shape + colour, never colour alone.
 */

const ICON_PATHS = {
  today: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17.5 14c2.7 0 4 1.8 4 4.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4"/><path d="M12 17v.01"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  arrow: '<path d="M7 17 17 7M8 7h9v9"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  home: '<path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  wifi: '<path d="M3 9a14 14 0 0 1 18 0M6 12.5a9.5 9.5 0 0 1 12 0M9.2 16a5 5 0 0 1 5.6 0M12 19.5v.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  rewind: '<path d="M11 6 4 12l7 6zM20 6l-7 6 7 6z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1"/>',
  tv: '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.1.9-1.1 1.8M12 17v.01"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'
};

function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
}

/** Severity mark. Critical = filled circle with "!", watch = triangle, ok = rounded square with tick, neutral = diamond. */
function sevIcon(kind, size = 18) {
  if (kind === 'critical') return `<svg class="sev sev-critical" width="${size}" height="${size}" viewBox="0 0 18 18" role="img" aria-label="Срочно"><circle cx="9" cy="9" r="7.5" fill="currentColor"/><path d="M9 4.8v5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="12.7" r="1.15" fill="#fff"/></svg>`;
  if (kind === 'watch') return `<svg class="sev sev-watch" width="${size}" height="${size}" viewBox="0 0 18 18" role="img" aria-label="Следить"><path d="M9 1.8 16.8 15.2H1.2z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 6.8v3.6" stroke="#14140F" stroke-width="1.8" stroke-linecap="round"/><circle cx="9" cy="12.9" r="1" fill="#14140F"/></svg>`;
  if (kind === 'ok') return `<svg class="sev sev-ok" width="${size}" height="${size}" viewBox="0 0 18 18" role="img" aria-label="В порядке"><rect x="1.5" y="1.5" width="15" height="15" rx="4.5" fill="currentColor"/><path d="M5.2 9.2l2.6 2.6 5-5.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<svg class="sev sev-neutral" width="${size}" height="${size}" viewBox="0 0 18 18" role="img" aria-label="Фон"><rect x="4.2" y="4.2" width="9.6" height="9.6" rx="2.4" fill="currentColor" transform="rotate(45 9 9)"/></svg>`;
}

function ringSvg(frac, size = 40, stroke = 4, cls = '') {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  return `<svg class="ring ${cls}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/><circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
}

/** Avatar with optional ring (share of the person's tasks that are debt). */
function avatarHtml(name, size = 30, ringFrac = null, tone = '') {
  const ini = escapeHtml(personInitials(name));
  if (ringFrac == null) return `<span class="av" style="--s:${size}px" aria-hidden="true">${ini}</span>`;
  const outer = size + 10;
  return `<span class="av-ring tone-${tone || 'ink'}" style="--s:${size}px;--o:${outer}px" aria-hidden="true">${ringSvg(ringFrac, outer, 3.5)}<span class="av">${ini}</span></span>`;
}

function chipHtml(text, tone = '', extra = '') {
  return `<span class="chip ${tone ? 'chip-' + tone : ''}">${extra}${escapeHtml(text)}</span>`;
}

function kbdHtml(text) { return `<kbd class="kbd">${escapeHtml(text)}</kbd>`; }

/** Stacked horizontal bar: segments [{n, cls}] */
function segBar(parts, cls = '') {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return `<div class="segbar ${cls}"><i class="seg seg-empty" style="flex:1"></i></div>`;
  return `<div class="segbar ${cls}" role="img" aria-label="${escapeAttr(parts.filter(p => p.n).map(p => `${p.label || p.cls}: ${p.n}`).join(', '))}">${parts.filter(p => p.n).map(p => `<i class="seg seg-${p.cls}" style="flex:${p.n}"></i>`).join('')}</div>`;
}

/* ---------- glossary: every term the interface uses is explained in plain words ---------- */

const GLOSSARY = {
  acceptance: { title: 'Приёмка', text: 'Исполнитель сдал работу, задача в статусе «Ждёт контроля». Теперь ход за постановщиком: проверить и закрыть или вернуть.' },
  debt: { title: 'Старый долг', text: 'Задача давно просрочена и давно не менялась. Она не мешает сегодняшней работе, но копится. Раз в неделю её стоит закрыть, списать или вернуть в работу.' },
  live: { title: 'Живая задача', text: `Открытая задача, которую трогали за последние ${LIVE_WINDOW_DAYS} дней, не в долге и не в приёмке. Это то, чем отдел занят сейчас.` },
  ball: { title: 'Мяч', text: 'Чей сейчас ход. Пока задача в работе, мяч у исполнителя. Когда исполнитель сдал её на приёмку, мяч у постановщика и наблюдателей.' },
  snapshot: { title: 'Срез', text: 'Снимок всех задач на момент выгрузки из Bitrix. Сравнивая два среза, дашборд видит, что закрыли, что просрочили и что перенесли.' },
  signal: { title: 'Сигнал', text: 'Свежее событие, которое требует решения: срок сегодня, новая просрочка, приёмка ждёт, срок переносили несколько раз.' },
  horizon: { title: 'Горизонт', text: `Сроки задач на ближайшие ${HORIZON_WEEKS} недель. Задачи в долге и в приёмке не входят: их срок уже не ориентир.` },
  decide: { title: 'Решить сегодня', text: 'Очередь из задач, где нужно ваше решение: назначить, отложить до следующего среза, эскалировать или отметить разобранной. Решения хранятся в дашборде и не меняют Bitrix.' }
};

function termHtml(key) {
  const term = GLOSSARY[key];
  if (!term) return '';
  return `<button class="term" type="button" data-action="term" data-term="${escapeAttr(key)}" aria-label="Что такое: ${escapeAttr(term.title)}">?</button>`;
}

/* ---------- brand ---------- */

/** Round dot-matrix mark. Each dot gets a delay by distance from the centre, so CSS can run a radial wave. */
function logoMark(size = 36) {
  const n = 9;
  const c = (n - 1) / 2;
  const pitch = size / n;
  const dots = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dist = Math.hypot(x - c, y - c);
      if (dist > c + 0.35) continue;
      dots.push(`<circle cx="${(x + 0.5) * pitch}" cy="${(y + 0.5) * pitch}" r="${pitch * 0.3}" style="--d:${Math.round(dist * 110)}ms"/>`);
    }
  }
  return `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${dots.join('')}</svg>`;
}

function dotLoader(count = 5) {
  return `<span class="dot-loader" aria-hidden="true">${Array.from({ length: count }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</span>`;
}

/* ---------- people and tasks ---------- */

function personLine(name) {
  const canon = canonicalItoName(name);
  return `<span class="person-line">${avatarHtml(canon || name, 24)}<span>${escapeHtml(shortName(canon || name))}</span></span>`;
}

function projectTag(name) { return `<span class="tag">${escapeHtml(shortLabel(name || 'Операционка', 22))}</span>`; }
function operationalLabel(name) { return name === 'Операционная работа' ? 'Операционка' : name; }

function dateChip(task, snapshot) {
  if (!task.deadline) return '<span class="tag tag-muted">без срока</span>';
  const delta = diffDays(task.deadline, new Date(snapshot.asOf));
  if (task.dueToday || delta === 0) return '<span class="tag tag-red">срок сегодня</span>';
  if (delta === 1) return '<span class="tag tag-amber">срок завтра</span>';
  if (delta > 1) return `<span class="tag">срок ${escapeHtml(dayMonthShort(task.deadline))}</span>`;
  return `<span class="tag tag-muted">срок был ${escapeHtml(dayMonthShort(task.deadline))}</span>`;
}

function deltaText(value, goodWhenNegative = true, suffix = '') {
  if (value == null) return { text: '', tone: 'muted' };
  if (value === 0) return { text: `без изменений${suffix}`, tone: 'muted' };
  const sign = value > 0 ? '+' : '−';
  const good = goodWhenNegative ? value < 0 : value > 0;
  return { text: `${sign}${Math.abs(value)}${suffix}`, tone: good ? 'good' : 'bad' };
}

function headlineHtml(parts) {
  return parts.map(p => p.em ? `<em class="em-${escapeAttr(p.em)}" data-scramble>${escapeHtml(p.t)}</em>` : escapeHtml(p.t)).join('');
}

function emptyState(title, text, actionHtml = '') {
  return `<div class="empty"><div class="empty-mark">${logoMark(44)}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${actionHtml}</div>`;
}
