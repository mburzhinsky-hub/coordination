'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'config.local.json');
const ALLOWED_STORES = new Set(['snapshots', 'presence', 'sources', 'settings', 'council', 'councilfiles']);
/* Stores whose records carry a "rev" and are written only through /api/council/batch with an expected revision (optimistic locking). */
const REVISIONED_STORES = new Set(['council']);
const MAX_BATCH_WRITES = 600;
const MAX_BODY_BYTES = 30 * 1024 * 1024;

function readConfig() {
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {}
  return {
    host: process.env.COORD_HOST || fileConfig.host || '127.0.0.1',
    port: Number(process.env.COORD_PORT || fileConfig.port || 8787),
    user: process.env.COORD_USER || fileConfig.user || 'ito',
    password: process.env.COORD_PASSWORD || fileConfig.password || '',
    dataDir: path.resolve(ROOT, process.env.COORD_DATA_DIR || fileConfig.dataDir || 'shared-data')
  };
}

const config = readConfig();

if (!config.password || config.password === 'CHANGE_ME' || config.password.length < 10) {
  console.error('Shared server not started: set a password of at least 10 characters in server/config.local.json or COORD_PASSWORD.');
  process.exit(1);
}

const META_FILE = path.join(config.dataDir, 'meta.json');
let writeQueue = Promise.resolve();

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (_) {
    return false;
  }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  const user = decoded.slice(0, split);
  const password = decoded.slice(split + 1);
  return safeEqual(user, config.user) && safeEqual(password, config.password);
}

function requireAuth(req, res) {
  if (authorized(req)) return true;
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="ITO Coordination", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end('Требуется авторизация.');
  return false;
}

function sendJson(res, status, value, revision) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (revision != null) headers['X-Coordination-Revision'] = String(revision);
  res.writeHead(status, headers);
  res.end(JSON.stringify(value));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

async function ensureDataDir() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  for (const store of ALLOWED_STORES) {
    await fsp.mkdir(path.join(config.dataDir, store), { recursive: true });
  }
  try {
    await fsp.access(META_FILE);
  } catch (_) {
    await atomicWriteJson(META_FILE, { revision: 0, updatedAt: new Date().toISOString() });
  }
}

async function readRevision() {
  try {
    const meta = JSON.parse(await fsp.readFile(META_FILE, 'utf8'));
    return Number(meta.revision || 0);
  } catch (_) {
    return 0;
  }
}

async function bumpRevision() {
  const revision = (await readRevision()) + 1;
  await atomicWriteJson(META_FILE, { revision, updatedAt: new Date().toISOString() });
  return revision;
}

function recordPath(store, key) {
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex');
  return path.join(config.dataDir, store, digest + '.json');
}

async function atomicWriteJson(filePath, value) {
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fsp.rename(tmp, filePath);
}

async function listStore(store) {
  const dir = path.join(config.dataDir, store);
  const names = (await fsp.readdir(dir)).filter(name => name.endsWith('.json'));
  const rows = [];
  for (const name of names) {
    try {
      rows.push(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')));
    } catch (error) {
      console.warn('Skipping unreadable shared record:', store, name, error.message);
    }
  }
  return rows;
}

async function readRecord(store, key) {
  try {
    return JSON.parse(await fsp.readFile(recordPath(store, key), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRecord(store, key, value) {
  return enqueueWrite(async () => {
    await atomicWriteJson(recordPath(store, key), value);
    return await bumpRevision();
  });
}

/**
 * All-or-nothing write of several council records. Every record that lives in a revisioned store comes with the revision the client
 * based its change on (0 = "must not exist yet"). If any of them moved on, nothing is written and the current versions go back to the client,
 * which merges and retries. Content-addressed file records are written as they are.
 */
async function writeCouncilBatch(writes) {
  return enqueueWrite(async () => {
    const conflicts = [];
    const plan = [];
    for (const w of writes) {
      if (!REVISIONED_STORES.has(w.store)) { plan.push({ ...w, rev: 0 }); continue; }
      const current = await readRecord(w.store, w.key);
      const currentRev = current ? Number(current.rev || 0) : 0;
      const expected = Number(w.expectedRev || 0);
      if (current && expected === 0 && !w.delete) { conflicts.push({ store: w.store, key: w.key, expected, current }); continue; }
      if (currentRev !== expected) { conflicts.push({ store: w.store, key: w.key, expected, current }); continue; }
      plan.push({ ...w, rev: expected + 1 });
    }
    if (conflicts.length) return { ok: false, conflicts };
    const revs = {};
    for (const w of plan) {
      if (w.delete) {
        try { await fsp.unlink(recordPath(w.store, w.key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      const value = REVISIONED_STORES.has(w.store) ? { ...w.value, rev: w.rev, savedAt: new Date().toISOString() } : w.value;
      await atomicWriteJson(recordPath(w.store, w.key), value);
      revs[w.key] = w.rev;
    }
    const revision = await bumpRevision();
    return { ok: true, revs, revision };
  });
}

async function deleteRecord(store, key) {
  return enqueueWrite(async () => {
    try {
      await fsp.unlink(recordPath(store, key));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return await bumpRevision();
  });
}

function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Payload too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseApi(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;
  if (parts[1] === 'health') return { type: 'health' };
  if (parts[1] === 'revision') return { type: 'revision' };
  if (parts[1] === 'council' && parts[2] === 'batch') return { type: 'council-batch' };
  if (parts[1] !== 'store' || !parts[2]) return { type: 'invalid' };
  const store = decodeURIComponent(parts[2]);
  const key = parts.length > 3 ? decodeURIComponent(parts.slice(3).join('/')) : null;
  return { type: 'store', store, key };
}

async function handleApi(req, res, url) {
  const api = parseApi(url);
  if (!api) return false;
  if (!requireAuth(req, res)) return true;

  if (api.type === 'health') {
    const revision = await readRevision();
    sendJson(res, 200, { ok: true, shared: true, revision }, revision);
    return true;
  }
  if (api.type === 'revision') {
    const revision = await readRevision();
    sendJson(res, 200, { revision }, revision);
    return true;
  }
  if (api.type === 'council-batch') {
    if (req.method !== 'POST') { sendText(res, 405, 'Method not allowed'); return true; }
    const body = await readBody(req);
    const writes = Array.isArray(body?.writes) ? body.writes : null;
    if (!writes || !writes.length || writes.length > MAX_BATCH_WRITES) { sendText(res, 400, 'Bad batch'); return true; }
    for (const w of writes) {
      if (!w || !['council', 'councilfiles'].includes(w.store) || typeof w.key !== 'string' || !w.key || w.key.length > 200) { sendText(res, 400, 'Bad batch entry'); return true; }
      if (w.delete && w.store !== 'councilfiles') { sendText(res, 400, 'Only files can be deleted'); return true; }
      if (!w.delete && (typeof w.value !== 'object' || w.value === null || w.value.id !== w.key)) { sendText(res, 400, 'Record id must equal its key'); return true; }
    }
    const outcome = await writeCouncilBatch(writes);
    if (!outcome.ok) { sendJson(res, 409, { ok: false, conflicts: outcome.conflicts }, await readRevision()); return true; }
    sendJson(res, 200, { ok: true, revs: outcome.revs }, outcome.revision);
    return true;
  }
  if (api.type !== 'store' || !ALLOWED_STORES.has(api.store)) {
    sendText(res, 404, 'Unknown API route');
    return true;
  }

  const revision = await readRevision();

  /* revisioned records change only through the batch endpoint, so an old or foreign client cannot overwrite them blindly */
  if (REVISIONED_STORES.has(api.store) && (req.method === 'PUT' || req.method === 'DELETE')) {
    sendText(res, 405, 'Use /api/council/batch for this store');
    return true;
  }

  if (req.method === 'GET' && !api.key) {
    sendJson(res, 200, await listStore(api.store), revision);
    return true;
  }
  if (req.method === 'GET' && api.key) {
    sendJson(res, 200, await readRecord(api.store, api.key), revision);
    return true;
  }
  if (req.method === 'PUT' && api.key) {
    const body = await readBody(req);
    const nextRevision = await writeRecord(api.store, api.key, body);
    sendJson(res, 200, { ok: true }, nextRevision);
    return true;
  }
  if (req.method === 'DELETE' && api.key) {
    const nextRevision = await deleteRecord(api.store, api.key);
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Coordination-Revision': String(nextRevision) });
    res.end();
    return true;
  }

  sendText(res, 405, 'Method not allowed');
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function handleStatic(req, res, url) {
  if (!requireAuth(req, res)) return;

  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/index.html';
  relative = relative.replace(/^\/+/, '');

  const allowed = relative === 'index.html' ||
    relative === 'migration.html' ||
    relative.startsWith('assets/') ||
    relative.startsWith('data/');

  if (!allowed || relative.includes('..')) {
    sendText(res, 404, 'Not found');
    return;
  }

  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT + path.sep)) {
    sendText(res, 404, 'Not found');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error('Not file'), { code: 'ENOENT' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=60'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendText(res, 404, 'Not found');
      return;
    }
    throw error;
  }
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await handleApi(req, res, url)) return;
    await handleStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendText(res, error.statusCode || 500, error.message || 'Server error');
  }
}

async function main() {
  await ensureDataDir();
  const server = http.createServer(requestHandler);
  server.listen(config.port, config.host, () => {
    console.log('');
    console.log('ITO Coordination shared server');
    console.log('--------------------------------');
    console.log('Listening: http://' + config.host + ':' + config.port);
    console.log('User: ' + config.user);
    console.log('Data: ' + config.dataDir);
    console.log('Keep this window open while the dashboard is in use.');
    console.log('');
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
