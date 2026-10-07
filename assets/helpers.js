'use strict';
function isProjectContainerTitle(title) {
  const key = projectKey(title);
  if (ITO_PROJECTS.some(project => projectKey(project.fullName) === key)) return true;
  if (KNOWN_PROJECT_CONTAINERS.some(name => projectKey(name) === key)) return true;
  return /(техническ(ая|ое)\s+(реализац|сопровожд)|тех\s*поддерж|гарантийн(ое|ый)\s+сопровожд|\bобслуживан|^просчеты\s+ито$|^задачи\s+руководителя\s+ито$|^пресейл\s+и\s+техническая\s+экспертиза)/i.test(cleanText(title));
}

function resolveItoProject(...values) {
  const texts = values.map(projectKey).filter(Boolean);
  for (const text of texts) {
    for (const project of ITO_PROJECTS) {
      const aliases = [project.name, project.fullName, ...(project.aliases || [])].map(projectKey);
      if (aliases.some(alias => alias && text.includes(alias))) return project;
    }
  }
  return null;
}

function itoProjectById(id) {
  return ITO_PROJECTS.find(project => project.id === id) || null;
}

function normalizePresenceEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { mode: '', projectId: '' };
  const mode = PRESENCE_MODES.some(item => item.id === value.mode) ? value.mode : '';
  const projectId = itoProjectById(value.projectId)?.id || '';
  return { mode, projectId: mode === 'site' ? projectId : '' };
}

function presenceForPerson(presence, person) {
  return normalizePresenceEntry(presence?.people?.[person]);
}

function presenceModeLabel(mode) {
  return PRESENCE_MODES.find(item => item.id === mode)?.label || 'Не указано';
}

function shortenProjectName(value) {
  let text = cleanText(value || 'Без проекта');
  text = text.replace(/\s*[—-]\s*(техническая реализация|техническое сопровождение|гарантийное сопровождение|тех\s*поддержка|обслуживание)\s*$/i, '');
  return text || cleanText(value) || 'Без проекта';
}

function deadlineChangesWithin(task, asOf, days) {
  return (task.deadlineHistory || []).filter(item => diffDays(asOf, new Date(item.at)) >= 0 && diffDays(asOf, new Date(item.at)) <= days).length;
}

function getRowValue(row, ...names) {
  for (const name of names) {
    const key = normalizeHeader(name);
    if (row[key] !== undefined && cleanText(row[key])) return cleanText(row[key]);
  }
  return '';
}

function findHeader(headers, names) {
  const keys = names.map(normalizeHeader);
  return headers.find(h => keys.includes(h)) || '';
}

function readFileAsText(file) { return new Promise((resolve,reject) => { const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result||'')); reader.onerror=()=>reject(reader.error||new Error('Не удалось прочитать файл.')); reader.readAsText(file); }); }
function normalizeUploadFileName(name, asOf) { const safe=cleanText(name).replace(/[^0-9A-Za-zА-Яа-яЁё_.\-]/g,'_'); return safe || `tasks_${formatFileDate(asOf)}.xls`; }
function formatFileDate(date) { const pad=n=>String(n).padStart(2,'0'); return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`; }
function snapshotId(date) { return `snapshot:${new Date(date).toISOString()}`; }
function parseDateFromFileName(name) { const m=String(name||'').match(/(\d{4})-(\d{2})-(\d{2})[_-](\d{2})-(\d{2})(?:-(\d{2}))?/); return m ? new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]||0)) : null; }
function compareExportNames(a,b) { return (parseDateFromFileName(a)?.getTime()||0)-(parseDateFromFileName(b)?.getTime()||0) || String(a).localeCompare(String(b)); }
function parseBitrixDate(value) { const text=cleanText(value); if(!text)return null; const m=text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/); if(m)return new Date(Number(m[3]),Number(m[2])-1,Number(m[1]),Number(m[4]||0),Number(m[5]||0),Number(m[6]||0)); const d=new Date(text); return Number.isNaN(d.getTime())?null:d; }
function parseNumber(value) { const m=cleanText(value).replace(',','.').match(/-?\d+(?:\.\d+)?/); return m?Number(m[0]):0; }
function splitPeople(value) { return unique(cleanText(value).split(/[,;\n]+/).map(cleanText).filter(Boolean)); }
function cleanText(value) { return String(value??'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim(); }
function normalizeHeader(value) { return cleanText(value).toLowerCase().replace(/ё/g,'е'); }
function projectKey(value) { return normalizeHeader(value).replace(/[«»“”„"]/g,'').replace(/[–—−]/g,'-').replace(/\s*-\s*/g,' - ').replace(/\s+/g,' ').trim(); }
function personKey(value) { return normalizeHeader(value).replace(/\s+/g,' '); }
function canonicalItoName(value) {
  const key = personKey(value);
  if (!key) return '';
  for (const name of ITO_ROSTER) {
    const canonicalKey = personKey(name);
    if (key === canonicalKey) return name;
    const parts = canonicalKey.split(' ');
    if (parts.length === 2 && key === parts.slice().reverse().join(' ')) return name;
  }
  return '';
}
function isItoMember(value) { return Boolean(canonicalItoName(value)); }
function dateKey(date) { return date ? new Date(date).toISOString().slice(0,16) : ''; }
function startOfDay(date) { const d=new Date(date); return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
function diffDays(a,b) { return Math.floor((startOfDay(a)-startOfDay(b))/86400000); }
function sameDay(a,b) { return Boolean(a&&b&&startOfDay(a).getTime()===startOfDay(b).getTime()); }
function sameMinute(a,b) { return Math.abs(new Date(a)-new Date(b)) < 60000; }
function unique(values) { return [...new Set((values||[]).filter(Boolean))]; }
function sum(values) { return (values||[]).reduce((total,value)=>total+(Number(value)||0),0); }
function mode(values) { const counts={}; let best='', max=0; for(const value of values||[]){ counts[value]=(counts[value]||0)+1; if(counts[value]>max){best=value;max=counts[value];} } return best; }
function groupBy(rows, fn) { return (rows||[]).reduce((acc,row)=>{ const key=fn(row)||'__empty__'; (acc[key] ||= []).push(row); return acc; },{}); }
function severityWeight(v) { return {critical:4,watch:3,info:2,success:1,neutral:0}[v]||0; }
function riskWeight(v) { return {high:2,medium:1,none:0}[v]||0; }
function initials(name) { const parts=cleanText(name).split(' ').filter(Boolean); return (parts[0]?.[0]||'')+(parts[1]?.[0]||''); }
function shortLabel(value,max=18) { const text=cleanText(value); return text.length>max?`${text.slice(0,max-1)}…`:text; }
function formatTime(value) { const d=new Date(value); return Number.isNaN(d)?'—':d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}); }
function formatDateShort(value) { const d=new Date(value); return Number.isNaN(d)?'—':d.toLocaleDateString('ru-RU',{day:'2-digit',month:'short'}).replace('.',''); }
function formatDateTime(value) { const d=new Date(value); return Number.isNaN(d)?'—':d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
function escapeHtml(value) { return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function escapeAttr(value) { return escapeHtml(value); }
