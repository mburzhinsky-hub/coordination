'use strict';
async function preparePresenceEditor(snapshot) {
  const existing = await loadPresence(snapshot.id);
  if (existing) { state.presence = existing; return; }
  const previous = await loadPreviousPresence(snapshot.asOf);
  const roster = mergeRoster(snapshot.tasks, state.roster, previous || {people:{}});
  const projects = summarizeProjectsV2(snapshot.tasks).map(p => p.name);
  const draft = { snapshotId: snapshot.id, asOf: snapshot.asOf, people: {} };
  roster.forEach(person => {
    draft.people[person] = {};
    projects.forEach(project => { draft.people[person][project] = Number(previous?.people?.[person]?.[project] || 0); });
  });
  state.pendingPresence = draft;
  state.pendingPresenceSnapshotId = snapshot.id;
  renderPresenceEditor(roster, projects, draft);
  document.getElementById('presenceDialog')?.showModal();
}

function renderPresenceEditor(roster, projects, draft) {
  document.getElementById('presenceMatrix').innerHTML = `<table class="presence-edit-table"><thead><tr><th>Сотрудник</th>${projects.map(p => `<th title="${escapeAttr(p)}">${escapeHtml(shortLabel(p, 18))}</th>`).join('')}</tr></thead><tbody>${roster.map(person => `<tr><td>${escapeHtml(person)}</td>${projects.map(project => { const level = Number(draft.people?.[person]?.[project] || 0); return `<td><button type="button" class="presence-edit-button level-${level}" data-presence-person="${escapeAttr(person)}" data-presence-project="${escapeAttr(project)}">${level || '—'}</button></td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
}

function updatePresenceButton(button, level) {
  button.className = `presence-edit-button level-${level}`;
  button.textContent = level || '—';
}

async function savePendingPresence(useChanges) {
  if (!state.pendingPresenceSnapshotId) return;
  const payload = state.pendingPresence || { snapshotId: state.pendingPresenceSnapshotId, asOf: state.currentSnapshot.asOf, people: {} };
  await putRecord('presence', payload);
  state.presence = payload;
  state.pendingPresence = null;
  state.pendingPresenceSnapshotId = null;
  state.roster = mergeRoster(state.currentSnapshot.tasks, state.roster, state.presence);
  await saveRoster(state.roster);
  document.getElementById('presenceDialog')?.close();
  renderCurrentView();
}

function presenceLevel(presence, person, project) { return Math.max(0, Math.min(3, Number(presence?.people?.[person]?.[project] || 0))); }
function presenceProjectWeight(presence, project) { return sum(Object.values(presence?.people || {}).map(row => Number(row?.[project] || 0))); }

async function seedRepositorySnapshots() {
  let manifest;
  try {
    const res = await fetch(`data/exports.json?v=${Date.now()}`);
    if (!res.ok) return;
    manifest = await res.json();
  } catch (_) { return; }
  const files = [...(manifest.files || [])].filter(Boolean).sort(compareExportNames);
  const stored = await getAllRecords('snapshots');
  const existingIds = new Set(stored.map(x => x.id));
  let snapshots = stored.map(hydrateSnapshot).sort((a,b) => new Date(a.asOf) - new Date(b.asOf));
  for (const fileName of files) {
    const asOf = parseDateFromFileName(fileName);
    if (!asOf || existingIds.has(snapshotId(asOf))) continue;
    try {
      const res = await fetch(`data/raw/${encodeURIComponent(fileName)}?v=${Date.now()}`);
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseBitrixHtmlExport(text);
      const previous = snapshots.filter(s => new Date(s.asOf) < asOf).at(-1) || null;
      const quality = validateRows(parsed.rows, parsed.headers, previous);
      if (quality.errors.length) continue;
      const snap = buildSnapshot(parsed.rows, asOf, fileName, previous, snapshots, quality);
      await putRecord('snapshots', dehydrateSnapshot(snap));
      snapshots.push(snap);
      snapshots.sort((a,b) => new Date(a.asOf) - new Date(b.asOf));
    } catch (error) { console.warn('Не удалось импортировать репозиторную выгрузку', fileName, error); }
  }
}

async function migrateLegacyExports() {
  let parsed = [];
  try { parsed = JSON.parse(localStorage.getItem(LEGACY_EXPORTS_KEY) || '[]'); } catch (_) {}
  if (!Array.isArray(parsed) || !parsed.length) return;
  const stored = (await getAllRecords('snapshots')).map(hydrateSnapshot).sort((a,b) => new Date(a.asOf) - new Date(b.asOf));
  for (const item of parsed.filter(x => x?.name && x?.text).sort((a,b) => compareExportNames(a.name,b.name))) {
    const asOf = parseDateFromFileName(item.name);
    if (!asOf || stored.some(s => s.id === snapshotId(asOf))) continue;
    try {
      const data = parseBitrixHtmlExport(item.text);
      const previous = stored.filter(s => new Date(s.asOf) < asOf).at(-1) || null;
      const quality = validateRows(data.rows, data.headers, previous);
      if (quality.errors.length) continue;
      const snap = buildSnapshot(data.rows, asOf, item.name, previous, stored, quality);
      await putRecord('snapshots', dehydrateSnapshot(snap));
      await putRecord('sources', {id:snap.id,asOf:snap.asOf,fileName:item.name,text:item.text,savedAt:new Date().toISOString()});
      stored.push(snap);
      stored.sort((a,b) => new Date(a.asOf)-new Date(b.asOf));
    } catch (_) {}
  }
  try { localStorage.removeItem(LEGACY_EXPORTS_KEY); } catch (_) {}
}

async function refreshSnapshots() {
  state.snapshots = (await getAllRecords('snapshots')).map(hydrateSnapshot).sort((a,b) => new Date(a.asOf) - new Date(b.asOf));
}

async function loadPresence(snapshotIdValue) { return await getRecord('presence', snapshotIdValue); }
async function loadPreviousPresence(asOf) {
  const rows = await getAllRecords('presence');
  return rows.filter(row => new Date(row.asOf) < new Date(asOf)).sort((a,b) => new Date(a.asOf) - new Date(b.asOf)).at(-1) || null;
}
async function loadRoster() { return (await getRecord('settings','roster'))?.value || mergeRoster(state.currentSnapshot?.tasks || [], [], state.presence); }
async function saveRoster(roster) { await putRecord('settings',{id:'roster',value:unique(roster)}); }

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('presence')) db.createObjectStore('presence', { keyPath: 'snapshotId' });
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function store(name, mode='readonly') { return state.db.transaction(name, mode).objectStore(name); }
function getRecord(name, key) { return new Promise((resolve,reject) => { const r=store(name).get(key); r.onsuccess=()=>resolve(r.result||null); r.onerror=()=>reject(r.error); }); }
function getAllRecords(name) { return new Promise((resolve,reject) => { const r=store(name).getAll(); r.onsuccess=()=>resolve(r.result||[]); r.onerror=()=>reject(r.error); }); }
function putRecord(name, value) { return new Promise((resolve,reject) => { const r=store(name,'readwrite').put(value); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
function deleteRecord(name, key) { return new Promise((resolve,reject) => { const r=store(name,'readwrite').delete(key); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); }); }
async function pruneSources(limit) { const rows=(await getAllRecords('sources')).sort((a,b)=>new Date(b.asOf)-new Date(a.asOf)); for (const row of rows.slice(limit)) await deleteRecord('sources',row.id); }

function dehydrateSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function hydrateSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    tasks: (snapshot.tasks || []).map(task => hydrateTask(task))
  };
}

function hydrateTask(task) {
  const dateFields = ['deadline','actualStart','plannedStart','plannedEnd','created','changed','closed'];
  const next = {...task};
  dateFields.forEach(field => { next[field] = next[field] ? new Date(next[field]) : null; });
  return next;
}

