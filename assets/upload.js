'use strict';
async function handleUpload(file) {
  if (state.busy) return;
  state.busy = true;
  renderLoading('Разбираю новую выгрузку…');
  try {
    const text = await readFileAsText(file);
    const latest = state.snapshots[state.snapshots.length - 1] || null;
    let asOf = parseDateFromFileName(file.name) || new Date(file.lastModified || Date.now());
    if (latest && asOf <= new Date(latest.asOf)) {
      if (sameMinute(asOf, new Date(latest.asOf))) asOf = new Date(Date.now());
      else throw new Error(`Эта выгрузка старше текущего среза (${formatDateTime(latest.asOf)}). Для ежедневного режима загрузите более свежий файл.`);
    }
    const fileName = normalizeUploadFileName(file.name, asOf);
    const parsed = parseBitrixHtmlExport(text);
    const quality = validateRows(parsed.rows, parsed.headers, latest);
    if (quality.errors.length) throw new Error(quality.errors.join(' '));
    if (quality.requiresConfirmation) {
      const accepted = window.confirm(`${quality.warnings.join('\n')}\n\nПродолжить импорт?`);
      if (!accepted) { renderCurrentView(); return; }
    }
    const snapshot = buildSnapshot(parsed.rows, asOf, fileName, latest, state.snapshots, quality);
    await putRecord('snapshots', dehydrateSnapshot(snapshot));
    await putRecord('sources', { id: snapshot.id, asOf: snapshot.asOf, fileName, text, savedAt: new Date().toISOString() });
    await pruneSources(14);
    await refreshSnapshots();
    state.latestSnapshot = state.snapshots[state.snapshots.length - 1];
    state.currentSnapshot = state.latestSnapshot;
    state.historyMode = false;
    state.roster = mergeRoster(state.currentSnapshot.tasks, state.roster, state.presence);
    await saveRoster(state.roster);
    await preparePresenceEditor(state.currentSnapshot);
    renderCurrentView();
  } catch (error) {
    console.error(error);
    renderError(error.message || String(error));
  } finally {
    state.busy = false;
  }
}

