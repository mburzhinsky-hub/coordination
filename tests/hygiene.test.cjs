// The real registry and real work data must never reach the public repository; every script in index.html must exist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scriptList, ROOT } = require('./support/load.cjs');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'shared-data'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const files = walk(ROOT);

// 1. No Excel files in the repository folder, except the synthetic fixtures (there are none: tests build theirs with xlsxWrite).
const sheets = files.filter(f => /\.(xlsx|xlsm|xls)$/i.test(f) && !f.startsWith('tests/fixtures/'));
assert.deepEqual(sheets.filter(f => !f.startsWith('data/raw/')), [], 'registry or export files must stay out of the repository folder');

// 2. Git is told to ignore them as well.
const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
assert.ok(/^\*\.xlsx$/m.test(ignore), '.gitignore keeps *.xlsx out');
assert.ok(/^shared-data\/$/m.test(ignore), '.gitignore keeps the shared data directory out');
assert.ok(/config\.local\.json/.test(ignore), '.gitignore keeps the server password file out');

// 3. If this is a git checkout, nothing tracked looks like a registry export either.
try {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(tracked.filter(f => /\.xlsx$/i.test(f)), [], 'no .xlsx is tracked');
  assert.deepEqual(tracked.filter(f => f.startsWith('shared-data/') || /config\.local\.json$/.test(f)), []);
} catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }

// 4. Every script listed in index.html exists and the council module is wired in, in the order the code needs.
const scripts = scriptList().concat(['assets/council-app.js']);
scripts.forEach(f => assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' exists'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const order = [...html.matchAll(/<script[^>]+src="(assets\/[^"?]+)/g)].map(m => m[1]);
const at = f => order.indexOf(f);
['assets/xlsx.js', 'assets/council.js', 'assets/council-ops.js', 'assets/council-agenda.js', 'assets/council-store.js', 'assets/council-views.js', 'assets/council-meeting.js', 'assets/council-app.js'].forEach(f => assert.ok(at(f) >= 0, f + ' is loaded by index.html'));
assert.ok(at('assets/council-store.js') < at('assets/app.js'), 'the council store defines councilBlank(), which app.js calls while loading');
assert.ok(at('assets/council-app.js') > at('assets/app.js'), 'council-app.js hooks into the finished app');
assert.ok(/assets\/council\.css/.test(html), 'council.css is linked');

// 5. The migration page can read and write the new stores, so a backup includes the council.
const migration = fs.readFileSync(path.join(ROOT, 'migration.html'), 'utf8');
assert.ok(/council/.test(migration) && /councilfiles/.test(migration), 'migration.html covers the council stores');

console.log('PASS: hygiene — no registry files in the repo, scripts wired, migration page covers the council stores');
