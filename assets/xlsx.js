'use strict';
/*
 * Minimal .xlsx reader and writer with no dependencies and no network: the dashboard must keep working from the local server.
 * Reader: zip + raw inflate in plain JS, shared strings, styles (to tell dates from numbers), several sheets.
 * Writer: zip with stored entries, shared strings, a small style table (bold, fills, wrap, borders, number formats), column widths, frozen header, filter.
 * Everything here is pure: bytes in, plain objects out, and the other way round.
 */

/* ---------- inflate (RFC 1951, same algorithm as zlib's "puff") ---------- */

const XL_LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const XL_LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const XL_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const XL_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const XL_CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function xlHuffman(lengths) {
  const count = new Array(16).fill(0);
  for (const len of lengths) count[len]++;
  count[0] = 0;
  const offs = new Array(16).fill(0);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbols = new Array(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { count, symbols };
}

let XL_FIXED = null;
function xlFixedTables() {
  if (XL_FIXED) return XL_FIXED;
  const lit = new Array(288);
  for (let i = 0; i < 288; i++) lit[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
  XL_FIXED = { lit: xlHuffman(lit), dist: xlHuffman(new Array(30).fill(5)) };
  return XL_FIXED;
}

function xlInflate(data) {
  const st = { d: data, p: 0, bitBuf: 0, bitCnt: 0 };
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let op = 0;
  const need = extra => {
    if (op + extra <= out.length) return;
    const next = new Uint8Array(Math.max(out.length * 2, op + extra));
    next.set(out.subarray(0, op));
    out = next;
  };
  const bits = n => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (!st.bitCnt) {
        if (st.p >= st.d.length) throw new Error('Файл .xlsx повреждён: неожиданный конец данных');
        st.bitBuf = st.d[st.p++];
        st.bitCnt = 8;
      }
      v |= (st.bitBuf & 1) << i;
      st.bitBuf >>= 1;
      st.bitCnt--;
    }
    return v;
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('Файл .xlsx повреждён: неверный код сжатия');
  };
  const codes = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { need(1); out[op++] = sym; continue; }
      if (sym === 256) return;
      const li = sym - 257;
      if (li >= 29) throw new Error('Файл .xlsx повреждён: неверная длина');
      const len = XL_LEN_BASE[li] + bits(XL_LEN_EXTRA[li]);
      const di = decode(dist);
      if (di >= 30) throw new Error('Файл .xlsx повреждён: неверное расстояние');
      const distance = XL_DIST_BASE[di] + bits(XL_DIST_EXTRA[di]);
      if (distance > op) throw new Error('Файл .xlsx повреждён: расстояние за пределами данных');
      need(len);
      for (let i = 0; i < len; i++) { out[op] = out[op - distance]; op++; }
    }
  };
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      st.bitBuf = 0; st.bitCnt = 0;
      const len = st.d[st.p] | (st.d[st.p + 1] << 8);
      const nlen = st.d[st.p + 2] | (st.d[st.p + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('Файл .xlsx повреждён: неверный блок');
      st.p += 4;
      need(len);
      out.set(st.d.subarray(st.p, st.p + len), op);
      op += len; st.p += len;
    } else if (type === 1) {
      const fixed = xlFixedTables();
      codes(fixed.lit, fixed.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const lengths = new Array(19).fill(0);
      for (let i = 0; i < ncode; i++) lengths[XL_CL_ORDER[i]] = bits(3);
      const clh = xlHuffman(lengths);
      const all = [];
      while (all.length < nlen + ndist) {
        const sym = decode(clh);
        if (sym < 16) all.push(sym);
        else {
          let prev = 0, rep = 0;
          if (sym === 16) { if (!all.length) throw new Error('Файл .xlsx повреждён'); prev = all[all.length - 1]; rep = 3 + bits(2); }
          else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          for (let i = 0; i < rep; i++) all.push(prev);
        }
      }
      codes(xlHuffman(all.slice(0, nlen)), xlHuffman(all.slice(nlen, nlen + ndist)));
    } else throw new Error('Файл .xlsx повреждён: неизвестный блок');
  } while (!last);
  return out.slice(0, op);
}

/* ---------- crc32 and zip ---------- */

let XL_CRC_TABLE = null;
function xlCrc32(bytes) {
  if (!XL_CRC_TABLE) {
    XL_CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      XL_CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = XL_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function xlUtf8(text) { return new TextEncoder().encode(String(text)); }
function xlFromUtf8(bytes) { return new TextDecoder('utf-8').decode(bytes); }

/** Reads a zip into { "path/in/zip": Uint8Array }. Verifies CRC of every entry. */
function xlUnzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не файл .xlsx: не найден список файлов архива. Сохраните реестр из Excel как «Книга Excel (.xlsx)».');
  const total = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < total; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Файл .xlsx повреждён: сломан список файлов.');
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = xlFromUtf8(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('Файл .xlsx повреждён: сломан заголовок ' + name);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = xlInflate(raw);
    else throw new Error('Файл .xlsx использует неподдерживаемое сжатие.');
    if (xlCrc32(data) !== crc) throw new Error('Файл .xlsx повреждён: не сошлась контрольная сумма ' + name);
    files[name] = data;
  }
  return files;
}

function xlConcat(chunks) {
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Writes { name: string|Uint8Array } as a zip with stored (uncompressed) entries. */
function xlZip(files, when = new Date()) {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = (Math.max(0, when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = xlUtf8(name);
    const data = typeof content === 'string' ? xlUtf8(content) : content;
    const crc = xlCrc32(data);
    const head = new Uint8Array(30);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 0x0800, true); hv.setUint16(8, 0, true);
    hv.setUint16(10, dosTime, true); hv.setUint16(12, dosDate, true); hv.setUint32(14, crc, true);
    hv.setUint32(18, data.length, true); hv.setUint32(22, data.length, true); hv.setUint16(26, nameBytes.length, true); hv.setUint16(28, 0, true);
    chunks.push(head, nameBytes, data);
    const cen = new Uint8Array(46);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.push(cen, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = xlConcat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, Object.keys(files).length, true); ev.setUint16(10, Object.keys(files).length, true);
  ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, offset, true);
  return xlConcat([...chunks, centralBytes, end]);
}

/* ---------- xml helpers ---------- */

function xlUnescape(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function xlEscape(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function xlAttrs(text) {
  const out = {};
  String(text || '').replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (m, k, v, v2) => { out[k] = xlUnescape(v !== undefined ? v : v2); return m; });
  return out;
}

function xlColIndex(ref) {
  const letters = /^[A-Za-z]+/.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlColName(index) {
  let n = index + 1, name = '';
  while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
  return name;
}

/* ---------- reader ---------- */

function xlSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const inner = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const tre = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let t;
    while ((t = tre.exec(inner))) text += xlUnescape(t[1] || '');
    out.push(text);
  }
  return out;
}

const XL_BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const XL_BUILTIN_CODES = { 14: 'dd.mm.yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd.mm.yyyy h:mm', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0' };

function xlIsDateFormat(code) {
  const c = String(code || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
  if (/^general$/i.test(c.trim())) return false;
  return /[dmyhs]/i.test(c);
}

function xlStyles(xml) {
  const formats = {};
  const xfs = [];
  if (!xml) return { xfs, formats };
  const fre = /<numFmt\b([^>]*?)\/?>/g;
  let m;
  while ((m = fre.exec(xml))) { const a = xlAttrs(m[1]); if (a.numFmtId !== undefined) formats[a.numFmtId] = a.formatCode || ''; }
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (block) {
    const xre = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
    while ((m = xre.exec(block[1]))) {
      const a = xlAttrs(m[1]);
      const id = Number(a.numFmtId || 0);
      const code = formats[id] !== undefined ? formats[id] : XL_BUILTIN_CODES[id] || '';
      xfs.push({ numFmtId: id, code, isDate: XL_BUILTIN_DATE_IDS.has(id) || (formats[id] !== undefined && xlIsDateFormat(formats[id])) });
    }
  }
  return { xfs, formats };
}

function xlSerialToParts(serial, date1904) {
  const s = date1904 ? serial + 1462 : serial;
  const days = Math.floor(s);
  const frac = s - days;
  const base = days < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const d = new Date(base + days * 86400000);
  const secs = Math.round(frac * 86400) % 86400;
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: Math.floor(secs / 3600), mi: Math.floor((secs % 3600) / 60), s: secs % 60 };
}

const XL_MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Display text of a date the way Excel showed it in that cell ("15.10", "05.10.2026"), for the formats that matter here. */
function xlFormatDate(parts, code) {
  const pad = n => String(n).padStart(2, '0');
  const fmt = String(code || 'dd.mm.yyyy');
  const tokens = fmt.match(/\[[^\]]*\]|"[^"]*"|\\.|[ymdhs]+|AM\/PM|A\/P|./gi) || [];
  const sig = i => { for (let j = i - 1; j >= 0; j--) if (/^[ymdhs]/i.test(tokens[j])) return tokens[j][0].toLowerCase(); return ''; };
  const sigNext = i => { for (let j = i + 1; j < tokens.length; j++) if (/^[ymdhs]/i.test(tokens[j])) return tokens[j][0].toLowerCase(); return ''; };
  let out = '';
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase();
    if (/^\[.*\]$/.test(tok)) return;
    if (tok[0] === '"') { out += tok.slice(1, -1); return; }
    if (tok[0] === '\\') { out += tok.slice(1); return; }
    if (/^y+$/.test(t)) out += t.length <= 2 ? pad(parts.y % 100) : String(parts.y);
    else if (/^d+$/.test(t)) out += t.length === 1 ? String(parts.d) : pad(parts.d);
    else if (/^m+$/.test(t)) {
      const minute = sig(i) === 'h' || sigNext(i) === 's';
      if (minute) out += t.length === 1 ? String(parts.mi) : pad(parts.mi);
      else if (t.length === 1) out += String(parts.mo);
      else if (t.length === 2) out += pad(parts.mo);
      else out += XL_MONTHS_RU[parts.mo - 1] || '';
    } else if (/^h+$/.test(t)) out += t.length === 1 ? String(parts.h) : pad(parts.h);
    else if (/^s+$/.test(t)) out += t.length === 1 ? String(parts.s) : pad(parts.s);
    else out += tok;
  });
  return out;
}

function xlIsoFromParts(p) {
  const date = `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return p.h || p.mi || p.s ? `${date}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` : date;
}

function xlParseSheet(xml, shared, styles, date1904) {
  const rows = [];
  const merges = [];
  const mre = /<mergeCell\b[^>]*\bref="([^"]+)"/g;
  let m;
  while ((m = mre.exec(xml))) merges.push(m[1]);
  const rre = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let nextRow = 0;
  while ((m = rre.exec(xml))) {
    const a = xlAttrs(m[1]);
    const rowIndex = a.r ? Number(a.r) - 1 : nextRow;
    nextRow = rowIndex + 1;
    const cells = [];
    const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    let nextCol = 0;
    while ((c = cre.exec(m[2] || ''))) {
      const ca = xlAttrs(c[1]);
      let col = ca.r ? xlColIndex(ca.r) : nextCol;
      if (col < 0) col = nextCol;
      nextCol = col + 1;
      const body = c[2] || '';
      const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      const raw = vMatch ? xlUnescape(vMatch[1]) : '';
      const type = ca.t || 'n';
      let cell = null;
      if (type === 's') {
        const text = shared[Number(raw)];
        if (text !== undefined && text !== '') cell = { t: 's', v: text, text };
      } else if (type === 'inlineStr') {
        let text = '';
        const tre = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
        let t;
        while ((t = tre.exec(body))) text += xlUnescape(t[1] || '');
        if (text !== '') cell = { t: 's', v: text, text };
      } else if (type === 'str') {
        if (raw !== '') cell = { t: 's', v: raw, text: raw };
      } else if (type === 'b') {
        if (raw !== '') cell = { t: 'b', v: raw === '1', text: raw === '1' ? 'ИСТИНА' : 'ЛОЖЬ' };
      } else if (type === 'e') {
        if (raw !== '') cell = { t: 'e', v: raw, text: raw };
      } else if (type === 'd') {
        if (raw !== '') cell = { t: 'd', v: raw.slice(0, 16), text: raw.slice(8, 10) + '.' + raw.slice(5, 7), fmt: 'dd.mm' };
      } else if (raw !== '') {
        const num = Number(raw);
        if (Number.isFinite(num)) {
          const xf = styles.xfs[Number(ca.s || 0)];
          if (xf && xf.isDate) {
            const parts = xlSerialToParts(num, date1904);
            cell = { t: 'd', v: xlIsoFromParts(parts), text: xlFormatDate(parts, xf.code), fmt: xf.code, serial: num };
          } else cell = { t: 'n', v: num, text: String(num) };
        }
      }
      cells[col] = cell;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = Array.from(cells, v => v || null);
  }
  return { rows: rows.map(r => r || []), merges };
}

/** Reads an .xlsx. Returns { sheets: [{ name, hidden, rows: [[cell|null]], merges }], props: { created, modified, creator } }. */
function xlsxRead(input) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  const files = xlUnzip(bytes);
  const text = name => (files[name] ? xlFromUtf8(files[name]) : '');
  if (!files['xl/workbook.xml']) throw new Error('Это не книга Excel: в архиве нет xl/workbook.xml.');
  const wb = text('xl/workbook.xml');
  const rels = {};
  const rre = /<Relationship\b([^>]*?)\/?>/g;
  let m;
  const relXml = text('xl/_rels/workbook.xml.rels');
  while ((m = rre.exec(relXml))) { const a = xlAttrs(m[1]); if (a.Id) rels[a.Id] = a.Target || ''; }
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(wb);
  const shared = xlSharedStrings(text('xl/sharedStrings.xml'));
  const styles = xlStyles(text('xl/styles.xml'));
  const sheets = [];
  const sre = /<sheet\b([^>]*?)\/?>/g;
  while ((m = sre.exec(wb))) {
    const a = xlAttrs(m[1]);
    const target = rels[a['r:id']] || '';
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    if (!files[path]) continue;
    const parsed = xlParseSheet(xlFromUtf8(files[path]), shared, styles, date1904);
    sheets.push({ name: a.name || path, hidden: a.state === 'hidden' || a.state === 'veryHidden', rows: parsed.rows, merges: parsed.merges });
  }
  const core = text('docProps/core.xml');
  const pick = tag => { const r = new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`).exec(core); return r ? xlUnescape(r[1]) : ''; };
  return { sheets, props: { created: pick('dcterms:created'), modified: pick('dcterms:modified'), creator: pick('dc:creator') } };
}

/* ---------- writer ---------- */

function xlArgb(color) { return 'FF' + String(color || '000000').replace('#', '').toUpperCase(); }

function xlDateSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso));
  if (!m) return null;
  const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86400000);
  return days + (m[4] ? (Number(m[4]) * 60 + Number(m[5])) / 1440 : 0);
}

/**
 * book = { sheets: [{ name, widths: [chars], freeze: { rows: 1 }, filter: true, rows: [[cell]] }], styles: { key: {...} }, props: { creator, created } }
 * cell = null | string | number | boolean | { v, t?: 'd' (ISO date string) | 's' | 'n', style?: key }
 * style = { bold, italic, size, color, fill, wrap, align, valign, numFmt, border: color }
 */
function xlsxWrite(book) {
  const styleKeys = Object.keys(book.styles || {});
  const fonts = [{ key: '|11||', xml: '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' }];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts = [];
  const xfs = [{ numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, align: '' }];
  const xfIndex = {};
  const indexOf = (list, xml) => { const i = list.indexOf(xml); if (i >= 0) return i; list.push(xml); return list.length - 1; };
  for (const key of styleKeys) {
    const s = book.styles[key] || {};
    const fontXml = `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="${s.size || 11}"/>${s.color ? `<color rgb="${xlArgb(s.color)}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`;
    let fontId = fonts.findIndex(f => f.xml === fontXml);
    if (fontId < 0) { fonts.push({ xml: fontXml }); fontId = fonts.length - 1; }
    const fillId = s.fill ? indexOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${xlArgb(s.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = n => `<${n} style="thin"><color rgb="${xlArgb(s.border)}"/></${n}>`;
    const borderId = s.border ? indexOf(borders, `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`) : 0;
    let numFmtId = 0;
    if (s.numFmt) {
      { let at = numFmts.indexOf(s.numFmt); if (at < 0) { numFmts.push(s.numFmt); at = numFmts.length - 1; } numFmtId = 164 + at; }
    }
    const align = (s.wrap || s.align || s.valign) ? `<alignment${s.align ? ` horizontal="${s.align}"` : ''}${s.valign ? ` vertical="${s.valign}"` : ''}${s.wrap ? ' wrapText="1"' : ''}/>` : '';
    xfIndex[key] = xfs.length;
    xfs.push({ numFmtId, fontId, fillId, borderId, align });
  }
  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xlEscape(c)}"/>`).join('')}</numFmts>` : '') +
    `<fonts count="${fonts.length}">${fonts.map(f => f.xml).join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.map(x => `<xf numFmtId="${x.numFmtId}" fontId="${x.fontId}" fillId="${x.fillId}" borderId="${x.borderId}" xfId="0"${x.numFmtId ? ' applyNumberFormat="1"' : ''}${x.fontId ? ' applyFont="1"' : ''}${x.fillId ? ' applyFill="1"' : ''}${x.borderId ? ' applyBorder="1"' : ''}${x.align ? ` applyAlignment="1">${x.align}</xf>` : '/>'}`).join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const sharedList = [];
  const sharedMap = new Map();
  const sst = text => { if (!sharedMap.has(text)) { sharedMap.set(text, sharedList.length); sharedList.push(text); } return sharedMap.get(text); };

  const sheets = book.sheets || [];
  const sheetXml = sheets.map(sheet => {
    const rows = sheet.rows || [];
    let maxCol = 0;
    const rowXml = rows.map((row, ri) => {
      const cells = (row || []).map((cell, ci) => {
        if (cell === null || cell === undefined || cell === '') return '';
        const o = typeof cell === 'object' && !(cell instanceof Date) ? cell : { v: cell };
        const ref = xlColName(ci) + (ri + 1);
        maxCol = Math.max(maxCol, ci + 1);
        const s = o.style && xfIndex[o.style] !== undefined ? ` s="${xfIndex[o.style]}"` : '';
        if (o.t === 'd' || o.v instanceof Date) {
          const iso = o.v instanceof Date ? o.v.toISOString().slice(0, 10) : o.v;
          const serial = xlDateSerial(iso);
          return serial === null ? '' : `<c r="${ref}"${s}><v>${serial}</v></c>`;
        }
        if (typeof o.v === 'number' && o.t !== 's') return `<c r="${ref}"${s}><v>${o.v}</v></c>`;
        if (typeof o.v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${o.v ? 1 : 0}</v></c>`;
        return `<c r="${ref}"${s} t="s"><v>${sst(String(o.v))}</v></c>`;
      }).join('');
      return cells ? `<row r="${ri + 1}">${cells}</row>` : '';
    }).join('');
    const widths = sheet.widths || [];
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const freeze = sheet.freeze && sheet.freeze.rows ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freeze.rows}" topLeftCell="A${sheet.freeze.rows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freeze.rows + 1}" sqref="A${sheet.freeze.rows + 1}"/></sheetView></sheetViews>` : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const lastCol = Math.max(maxCol, widths.length, 1);
    const filter = sheet.filter && rows.length ? `<autoFilter ref="A1:${xlColName(lastCol - 1)}${rows.length}"/>` : '';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
      `<dimension ref="A1:${xlColName(lastCol - 1)}${Math.max(rows.length, 1)}"/>${freeze}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowXml}</sheetData>${filter}` +
      '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  });

  const sstXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedList.length}" uniqueCount="${sharedList.length}">${sharedList.map(t => `<si><t xml:space="preserve">${xlEscape(t)}</t></si>`).join('')}</sst>`;
  const created = (book.props && book.props.created) || new Date().toISOString();
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${xlEscape((book.props && book.props.creator) || 'Coordination ИТО')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${xlEscape(created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xlEscape(created)}</dcterms:modified></cp:coreProperties>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xlEscape(String(s.name || 'Лист' + (i + 1)).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    'xl/styles.xml': stylesXml,
    'xl/sharedStrings.xml': sstXml
  };
  sheetXml.forEach((xml, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = xml; });
  return xlZip(files, new Date(created));
}
