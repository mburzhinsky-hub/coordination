'use strict';
/*
 * Effects: dot-matrix numerals, glitch bursts, halftone reveal, dot field, dot sweep.
 * Everything here is optional. With effects off the interface shows plain text numerals and no motion;
 * with prefers-reduced-motion effects start switched off.
 * The top level only defines data and functions, so the file is safe to load without a DOM (tests).
 */

/* 5 x 7 dot-matrix glyphs. "1" = lit dot. */
const DOT_GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '−': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00', '00', '00', '00', '00', '11', '11'],
  ':': ['00', '11', '11', '00', '11', '11', '00'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  '—': ['00000', '00000', '00000', '01110', '00000', '00000', '00000']
};
const DOT_ROWS = 7;
const DOT_DIGITS = '0123456789';

function dotGlyph(ch) { return DOT_GLYPHS[ch] || DOT_GLYPHS[' ']; }

/** Layout of a string in dot cells: [{ch, x, w}], total width in cells. */
function dotLayout(text) {
  const chars = [...String(text)];
  let x = 0;
  const cells = chars.map(ch => {
    const w = dotGlyph(ch)[0].length;
    const item = { ch, x, w };
    x += w + 1;
    return item;
  });
  return { cells, width: Math.max(0, x - 1) };
}

/** Dot-matrix numeral. Real text stays in the DOM for screen readers and for the effects-off mode. */
function dotNumberHtml(value, opts = {}) {
  const text = String(value);
  const pitch = opts.pitch || 9;
  const radius = opts.radius || pitch * 0.34;
  const layout = dotLayout(text);
  const circles = layout.cells.map((cell, ci) => dotGlyph(cell.ch).map((line, r) => [...line].map((bit, c) =>
    `<circle data-ch="${ci}" data-r="${r}" data-c="${c}" cx="${((cell.x + c) * pitch + pitch / 2).toFixed(1)}" cy="${(r * pitch + pitch / 2).toFixed(1)}" r="${radius.toFixed(2)}" class="${bit === '1' ? 'on' : 'off'}"/>`).join('')).join('')).join('');
  const w = layout.width * pitch;
  const h = DOT_ROWS * pitch;
  return `<span class="dotnum ${escapeAttr(opts.cls || '')}" data-dotnum="${escapeAttr(text)}" data-pitch="${pitch}"><span class="dotnum-text">${escapeHtml(text)}</span><svg class="dotnum-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" focusable="false">${circles}</svg></span>`;
}

/* ---------- runtime ---------- */

const fx = (() => {
  const FX_KEY = 'coordination.fx';
  let timers = [];
  let rafs = [];
  let cleanups = [];
  let burstTimer = 0;

  function reducedMotion() {
    try { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }
  function stored() { try { return localStorage.getItem(FX_KEY); } catch (_) { return null; } }
  function enabled() {
    const saved = stored();
    if (saved === 'on') return true;
    if (saved === 'off') return false;
    return !reducedMotion();
  }
  function apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-fx', enabled() ? 'on' : 'off');
  }
  function setEnabled(value) {
    try { localStorage.setItem(FX_KEY, value ? 'on' : 'off'); } catch (_) {}
    apply();
  }
  function later(fn, ms) { const id = setTimeout(fn, ms); timers.push(id); return id; }
  function frames(fn) {
    let id = 0;
    const loop = ts => { if (fn(ts) !== false) id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    rafs.push(() => cancelAnimationFrame(id));
  }
  function rand(n) { return Math.floor(Math.random() * n); }

  /* --- dot numerals --- */
  function setGlyph(el, charIndex, ch) {
    const glyph = dotGlyph(ch);
    el.querySelectorAll(`circle[data-ch="${charIndex}"]`).forEach(c => {
      const bit = glyph[Number(c.dataset.r)]?.[Number(c.dataset.c)] === '1';
      c.setAttribute('class', bit ? 'on' : 'off');
    });
  }
  function scrambleIn(el, startDelay = 0) {
    const chars = [...el.dataset.dotnum];
    // start dark so the numeral "boots up", then lock digits left to right
    el.querySelectorAll('circle.on').forEach(c => c.setAttribute('class', 'off'));
    chars.forEach((ch, i) => {
      const start = startDelay + i * 110;
      if (!/[0-9]/.test(ch)) { later(() => setGlyph(el, i, ch), start); return; }
      const rounds = 7 + i;
      for (let k = 0; k < rounds; k++) later(() => setGlyph(el, i, DOT_DIGITS[rand(10)]), start + k * 55);
      later(() => setGlyph(el, i, ch), start + rounds * 55);
    });
  }
  function glitchRow(el) {
    const rows = [...el.querySelectorAll('circle')];
    if (!rows.length) return;
    const r = rand(DOT_ROWS);
    const pitch = Number(el.dataset.pitch) || 9;
    const dx = (rand(2) ? 1 : -1) * pitch * (1 + rand(2));
    const hit = rows.filter(c => Number(c.dataset.r) === r);
    hit.forEach(c => { c.style.transform = `translateX(${dx}px)`; c.classList.add('glitch'); });
    later(() => hit.forEach(c => { c.style.transform = ''; c.classList.remove('glitch'); }), 130);
  }

  /* --- digits flicker inside headlines (tabular figures, so nothing reflows) --- */
  function flickerDigits(el, ms = 520) {
    if (!el.dataset.original) el.dataset.original = el.textContent;
    const original = el.dataset.original;
    const end = performance.now() + ms;
    frames(() => {
      const now = performance.now();
      if (now >= end) { el.textContent = original; return false; }
      el.textContent = original.replace(/\d/g, () => DOT_DIGITS[rand(10)]);
      return true;
    });
  }

  /* --- ambient dot field behind the hero --- */
  function dotField(canvas) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    const parent = canvas.parentElement;
    const pitch = 14;
    let w = 0, h = 0, dpr = 1, mouse = null, last = 0;
    const color = getComputedStyle(canvas).color || '#14140F';
    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = r.width; h = r.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    }
    function onMove(e) { const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function onLeave() { mouse = null; }
    resize();
    window.addEventListener('resize', resize);
    parent.addEventListener('pointermove', onMove);
    parent.addEventListener('pointerleave', onLeave);
    cleanups.push(() => { window.removeEventListener('resize', resize); parent.removeEventListener('pointermove', onMove); parent.removeEventListener('pointerleave', onLeave); });
    frames(ts => {
      if (document.hidden || ts - last < 40) return true;
      last = ts;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      const t = ts * 0.0006;
      for (let y = pitch / 2; y < h; y += pitch) {
        for (let x = pitch / 2; x < w; x += pitch) {
          let a = 0.07 + 0.09 * (0.5 + 0.5 * Math.sin(x * 0.011 + y * 0.007 - t * 2.2));
          let rad = 1.1;
          if (mouse) {
            const d = Math.hypot(x - mouse.x, y - mouse.y);
            if (d < 110) { const k = 1 - d / 110; a += k * 0.55; rad += k * 1.5; }
          }
          ctx.globalAlpha = Math.min(0.8, a);
          ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.2832); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      return true;
    });
  }

  /* --- public --- */
  function unmount() {
    timers.forEach(clearTimeout); timers = [];
    rafs.forEach(stop => stop()); rafs = [];
    cleanups.forEach(fn => fn()); cleanups = [];
    clearTimeout(burstTimer);
  }

  function scheduleBursts(root) {
    const next = () => {
      burstTimer = setTimeout(() => {
        if (!document.hidden) {
          root.querySelectorAll('[data-glitch]').forEach(el => {
            el.classList.add('is-glitch');
            later(() => el.classList.remove('is-glitch'), 260);
            el.querySelectorAll('[data-scramble]').forEach(em => flickerDigits(em, 260));
          });
          const nums = root.querySelectorAll('.dotnum');
          if (nums.length) glitchRow(nums[rand(nums.length)]);
        }
        next();
      }, 8000 + rand(7000));
    };
    next();
  }

  /* soft = the view was re-rendered after a click, not navigated to: keep ambient effects, skip the intro show */
  function mount(root, opts = {}) {
    unmount();
    apply();
    if (!root || !enabled()) return;
    if (!opts.soft) {
      root.querySelectorAll('.dotnum').forEach((el, i) => scrambleIn(el, 120 + i * 140));
      /* the halftone mask animates a registered custom property; browsers without @property skip it */
      const canReveal = typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function';
      root.querySelectorAll('[data-reveal]').forEach(el => {
        if (!canReveal) { el.classList.add('is-revealed'); return; }
        el.classList.remove('is-revealed');
        el.classList.add('reveal-run');
        el.addEventListener('animationend', () => { el.classList.add('is-revealed'); el.classList.remove('reveal-run'); }, { once: true });
      });
      root.querySelectorAll('[data-scramble]').forEach(el => flickerDigits(el, 700));
    }
    root.querySelectorAll('canvas[data-dotfield]').forEach(dotField);
    scheduleBursts(root);
  }

  function sweep() {
    if (typeof document === 'undefined' || !enabled()) return;
    const bar = document.getElementById('dotSweep');
    if (!bar) return;
    if (!bar.children.length) bar.innerHTML = Array.from({ length: 72 }, (_, i) => `<i style="--i:${i}"></i>`).join('');
    bar.classList.remove('run');
    void bar.offsetWidth;
    bar.classList.add('run');
  }

  return { enabled, setEnabled, apply, mount, unmount, sweep, reducedMotion };
})();
