// Loads the dashboard scripts into one vm context in the same order as index.html,
// so tests see exactly the global scope the browser sees. council-app.js is DOM wiring and is not loaded.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['assets/council-app.js']);

function scriptList() {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script[^>]+src="(assets\/[^"?]+)/g)].map(m => m[1]).filter(f => !SKIP.has(f));
}

function createContext(extra = {}) {
  const store = new Map();
  const context = vm.createContext({
    console, btoa, atob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer,
    crypto: nodeCrypto.webcrypto,
    window: { addEventListener() {} },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Date, Intl, Math, JSON, Set, Map, ...extra
  });
  for (const file of scriptList()) vm.runInContext(readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  return context;
}

/** Runs code in the app context. `globals` are placed on the context first (buffers, fixtures, assert). */
function run(context, code, globals = {}) {
  return vm.runInContext(code, Object.assign(context, globals));
}

module.exports = { createContext, run, scriptList, ROOT };
