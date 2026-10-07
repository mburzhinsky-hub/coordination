'use strict';
async function preparePresenceEditor(snapshot, force = false) {
  const existing = await loadPresence(snapshot.id);
  if (existing && !force) { state.presence = existing; return; }
  const previous = existing || await loadPreviousPresence(snapshot.asOf);
  const roster = [...ITO_ROSTER];
  const draft = { snapshotId: snapshot.id, asOf: snapshot.asOf, people: {} };
  roster.forEach(person => {
    const prior = normalizePresenceEntry(previous?.people?.[person]);
    draft.people[person] = { mode: prior.mode || '', projectId: prior.projectId || '' };
  });
  state.pendingPresence = draft;
  state.pendingPresenceSnapshotId = snapshot.id;
  renderPresenceEditor(roster, draft);
  document.getElementById('presenceDialog')?.showModal();
}

function renderPresenceEditor(roster, draft) {
  const projectOptions = ITO_PROJECTS.map(project => `<option value="${escapeAttr(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  document.getElementById('presenceMatrix').innerHTML = `<table class="presence-edit-table"><thead><tr><th>Сотрудник</th><th>Где сегодня</th><th>Проект / объект</th></tr></thead><tbody>${roster.map(person => {
    const entry = normalizePresenceEntry(draft.people?.[person]);
    return `<tr><td>${escapeHtml(person)}</td><td><select class="presence-mode-select" data-presence-person="${escapeAttr(person)}"><option value="" ${entry.mode ? '' : 'selected'}>Не указано</option>${PRESENCE_MODES.map(mode => `<option value="${mode.id}" ${entry.mode === mode.id ? 'selected' : ''}>${escapeHtml(mode.label)}</option>`).join('')}</select></td><td><select class="presence-project-select" data-presence-project-person="${escapeAttr(person)}" ${entry.mode === 'site' ? '' : 'disabled'}><option value="">Выберите проект</option>${projectOptions.replace(`value="${entry.projectId}"`, `value="${entry.projectId}" selected`)}</select></td></tr>`;
  }).join('')}</tbody></table>`;
}

function updatePresenceRow(person) {
  const entry = normalizePresenceEntry(state.pendingPresence?.people?.[person]);
  const select = document.querySelector(`[data-presence-project-person="${CSS.escape(person)}"]`);
  if (!select) return;
  select.disabled = entry.mode !== 'site';
  if (entry.mode !== 'site') {
    select.value = '';
    state.pendingPresence.people[person].projectId = '';
  }
}

async function savePendingPresence(useChanges) {
  if (!state.pendingPresenceSnapshotId) return;
  const payload = state.pendingPresence || { snapshotId: state.pendingPresenceSnapshotId, asOf: state.currentSnapshot.asOf, people: {} };
  for (const person of ITO_ROSTER) {
    payload.people[person] = normalizePresenceEntry(payload.people[person] || { mode: '', projectId: '' });
  }
  await putRecord('presence', payload);
  state.presence = payload;
  state.pendingPresence = null;
  state.pendingPresenceSnapshotId = null;
  state.roster = [...ITO_ROSTER];
  await saveRoster(state.roster);
  document.getElementById('presenceDialog')?.close();
  renderCurrentView();
}

function presenceProjectWeight(presence, projectId) {
  return ITO_ROSTER.filter(person => {
    const entry = presenceForPerson(presence, person);
    return entry.mode === 'site' && entry.projectId === projectId;
  }).length;
}

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
async function loadRoster() { return [...ITO_ROSTER]; }
async function saveRoster(roster) { await putRecord('settings',{id:'roster',value:[...ITO_ROSTER]}); }

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
  const resolvedProject = resolveItoProject(next.projectRaw, next.parentTitle, next.projectFullName, next.project);
  next.projectId = resolvedProject?.id || '';
  next.project = resolvedProject?.name || 'Вне активных проектов';
  next.projectFullName = resolvedProject?.fullName || next.projectFullName || next.projectRaw || next.parentTitle || 'Вне активных проектов';
  return next;
}

