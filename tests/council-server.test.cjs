// Shared server: revisioned council records, all-or-nothing batches, old stores still work.
// Starts server/server.js on a free port with a throw-away data directory and a throw-away password.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USER = 'ito';
const PASSWORD = 'test-password-' + Math.random().toString(36).slice(2, 12);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-council-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, COORD_PORT: String(port), COORD_HOST: '127.0.0.1', COORD_PASSWORD: PASSWORD, COORD_USER: USER, COORD_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const auth = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
  const call = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const batch = writes => call('POST', '/api/council/batch', { writes });
  const order = (id, extra = {}) => ({ id: 'order:' + id, kind: 'order', orderId: id, title: 'Поручение ' + id, ...extra });

  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await call('GET', '/api/health'); if (r.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
      if (child.exitCode !== null) throw new Error('server exited: ' + log);
    }
    const results = [];
    const t = async (name, fn) => { try { await fn(); results.push({ ok: true, name }); } catch (e) { results.push({ ok: false, name, error: e.stack || String(e) }); } };

    await t('auth: no password, no data', async () => {
      assert.equal((await fetch(base + '/api/health')).status, 401);
      assert.equal((await fetch(base + '/api/council/batch', { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await fetch(base + '/index.html')).status, 401);
    });

    await t('static: the new module files are served to the browser', async () => {
      for (const f of ['assets/xlsx.js', 'assets/council.js', 'assets/council-ops.js', 'assets/council-agenda.js', 'assets/council-store.js', 'assets/council-views.js', 'assets/council-meeting.js', 'assets/council-app.js', 'assets/council.css']) {
        const r = await call('GET', '/' + f);
        assert.equal(r.status, 200, f);
      }
      const html = await (await call('GET', '/index.html')).text();
      assert.ok(html.includes('council-app.js'));
      assert.equal((await call('GET', '/server/server.js')).status, 404, 'server code is not served');
      assert.equal((await call('GET', '/tests/council.test.cjs')).status, 404, 'tests are not served');
    });

    await t('batch: a new record needs expected revision 0 and gets revision 1', async () => {
      const r = await batch([{ store: 'council', key: 'order:TS-AAAAAA', value: order('TS-AAAAAA'), expectedRev: 0 }]);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.ok, true); assert.equal(body.revs['order:TS-AAAAAA'], 1);
      const stored = await (await call('GET', '/api/store/council/order:TS-AAAAAA')).json();
      assert.equal(stored.rev, 1); assert.equal(stored.title, 'Поручение TS-AAAAAA');
    });

    await t('batch: creating a record that already exists is a conflict and returns the current version', async () => {
      const r = await batch([{ store: 'council', key: 'order:TS-AAAAAA', value: order('TS-AAAAAA', { title: 'Другое' }), expectedRev: 0 }]);
      assert.equal(r.status, 409);
      const body = await r.json();
      assert.equal(body.conflicts[0].current.title, 'Поручение TS-AAAAAA');
    });

    await t('batch: update with the right revision passes, with an old revision is refused', async () => {
      const ok = await batch([{ store: 'council', key: 'order:TS-AAAAAA', value: order('TS-AAAAAA', { title: 'Правка 1' }), expectedRev: 1 }]);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).revs['order:TS-AAAAAA'], 2);
      const stale = await batch([{ store: 'council', key: 'order:TS-AAAAAA', value: order('TS-AAAAAA', { title: 'Правка из старой копии' }), expectedRev: 1 }]);
      assert.equal(stale.status, 409);
      const stored = await (await call('GET', '/api/store/council/order:TS-AAAAAA')).json();
      assert.equal(stored.title, 'Правка 1');
      assert.equal(stored.rev, 2);
    });

    await t('batch: all or nothing, one stale record keeps every other record in the batch from being written', async () => {
      const r = await batch([
        { store: 'council', key: 'order:TS-BBBBBB', value: order('TS-BBBBBB'), expectedRev: 0 },
        { store: 'council', key: 'order:TS-AAAAAA', value: order('TS-AAAAAA', { title: 'Устарело' }), expectedRev: 1 }
      ]);
      assert.equal(r.status, 409);
      const second = await (await call('GET', '/api/store/council/order:TS-BBBBBB')).json();
      assert.equal(second, null, 'the new record was not created');
    });

    await t('batch: two clients race on the same revision, exactly one wins', async () => {
      const make = n => batch([{ store: 'council', key: 'order:TS-AAAAAA', value: order('TS-AAAAAA', { title: 'Гонка ' + n }), expectedRev: 2 }]);
      const statuses = (await Promise.all([make(1), make(2), make(3), make(4)])).map(r => r.status).sort();
      assert.deepEqual(statuses, [200, 409, 409, 409]);
      const stored = await (await call('GET', '/api/store/council/order:TS-AAAAAA')).json();
      assert.equal(stored.rev, 3);
    });

    await t('batch: a record id must equal its key; unknown stores and empty batches are refused', async () => {
      assert.equal((await batch([{ store: 'council', key: 'order:TS-CCCCCC', value: order('TS-DDDDDD'), expectedRev: 0 }])).status, 400);
      assert.equal((await batch([{ store: 'snapshots', key: 'x', value: { id: 'x' }, expectedRev: 0 }])).status, 400);
      assert.equal((await batch([])).status, 400);
      assert.equal((await call('POST', '/api/council/batch', { nope: true })).status, 400);
      assert.equal((await batch([{ store: 'council', key: 'order:TS-AAAAAA', delete: true, expectedRev: 3 }])).status, 400, 'council records are never deleted');
    });

    await t('direct writes to the council store are refused, so an old client cannot overwrite a record blindly', async () => {
      assert.equal((await call('PUT', '/api/store/council/order:TS-AAAAAA', order('TS-AAAAAA', { title: 'Тихая перезапись' }))).status, 405);
      assert.equal((await call('DELETE', '/api/store/council/order:TS-AAAAAA')).status, 405);
      const stored = await (await call('GET', '/api/store/council/order:TS-AAAAAA')).json();
      assert.ok(stored.title.startsWith('Гонка'));
    });

    await t('files: content-addressed attachments are written, listed and removed without a revision', async () => {
      const file = { id: 'file:abc', name: 'protokol.pdf', type: 'application/pdf', size: 3, data: 'AAEC' };
      assert.equal((await batch([{ store: 'councilfiles', key: 'file:abc', value: file }])).status, 200);
      assert.equal((await batch([{ store: 'councilfiles', key: 'file:abc', value: file }])).status, 200, 'saving the same file twice is fine');
      const back = await (await call('GET', '/api/store/councilfiles/file:abc')).json();
      assert.equal(back.data, 'AAEC');
      assert.equal((await batch([{ store: 'councilfiles', key: 'file:abc', delete: true }])).status, 200);
      assert.equal(await (await call('GET', '/api/store/councilfiles/file:abc')).json(), null);
    });

    await t('revision counter moves on every successful council write and not on a refused one', async () => {
      const rev = async () => (await (await call('GET', '/api/revision')).json()).revision;
      const before = await rev();
      await batch([{ store: 'council', key: 'order:TS-EEEEEE', value: order('TS-EEEEEE'), expectedRev: 0 }]);
      const after = await rev();
      assert.ok(after > before, 'clients polling the revision see the change');
      await batch([{ store: 'council', key: 'order:TS-EEEEEE', value: order('TS-EEEEEE'), expectedRev: 0 }]);
      assert.equal(await rev(), after, 'a refused write does not announce a change');
    });

    await t('old stores keep working: snapshots and settings are written with plain PUT as before', async () => {
      const put = await call('PUT', '/api/store/snapshots/snap-1', { id: 'snap-1', tasks: [] });
      assert.equal(put.status, 200);
      assert.deepEqual((await (await call('GET', '/api/store/snapshots/snap-1')).json()).tasks, []);
      assert.equal((await call('PUT', '/api/store/settings/main', { id: 'main', nicknames: { a: 'b' } })).status, 200);
      const list = await (await call('GET', '/api/store/snapshots')).json();
      assert.equal(list.length, 1);
      assert.equal((await call('DELETE', '/api/store/snapshots/snap-1')).status, 204);
    });

    await t('council list: records of the council store come back as a list with their revisions', async () => {
      const list = await (await call('GET', '/api/store/council')).json();
      assert.ok(list.length >= 2);
      list.forEach(r => assert.equal(typeof r.rev, 'number'));
    });

    let failed = 0;
    for (const r of results) {
      if (r.ok) console.log('  ok   ' + r.name);
      else { failed++; console.log('  FAIL ' + r.name + '\n' + r.error.split('\n').slice(0, 6).map(l => '       ' + l).join('\n')); }
    }
    if (failed) { console.log(`\n${failed} of ${results.length} failed`); process.exitCode = 1; }
    else console.log(`PASS: council server — ${results.length} checks`);
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
