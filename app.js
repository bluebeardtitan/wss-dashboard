// ========== IndexedDB Setup ==========
const DB_NAME = 'WaterSupplyDB';
const DB_VERSION = 1;
const STORE_NAME = 'schemes';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAdd(scheme) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).add(scheme);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(tx.error);
  });
}

async function dbUpdate(scheme) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(scheme);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ========== State ==========
let schemes = [];
let editingId = null;
let searchQuery = '';
let showHidden = false;
let selectionMode = false;
let selectedIds = new Set();
let pendingChanges = new Map();
let newSchemeCounter = 0;

function findScheme(id) {
  const numId = Number(id);
  return schemes.find(s => s.id === id || s.id === numId);
}

function getEffective(id) {
  const base = findScheme(id);
  if (!base) return null;
  const numId = Number(id);
  const change = pendingChanges.get(id) || pendingChanges.get(numId) || pendingChanges.get(String(base.id));
  if (change) {
    return { ...base, ...change };
  }
  return { ...base };
}

function isNewId(id) {
  return typeof id === 'string' && isNaN(Number(id));
}

function stageChange(id, change) {
  const base = findScheme(id);
  if (!base) return;
  // Existing schemes are keyed by their numeric id so commit() can tell them
  // apart from new (_new_N) schemes even when the caller passes a string id.
  const numId = Number(id);
  const key = isNaN(numId) ? id : numId;
  const existing = pendingChanges.get(key) || pendingChanges.get(id) || {};
  pendingChanges.set(key, { ...existing, ...change });
  render();
}

function stageNewScheme(name, fields, hiddenFields, groups) {
  const id = `_new_${++newSchemeCounter}`;
  schemes.push({ id, name, fields: fields || {}, hiddenFields: hiddenFields || {}, groups: groups || [], hidden: false, createdAt: new Date().toISOString() });
  pendingChanges.set(id, { name, fields: fields || {}, hiddenFields: hiddenFields || {}, groups: groups || [] });
  render();
}

// ========== Shared Helpers ==========
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toExportShape(e) {
  return {
    name: e.name,
    fields: e.fields,
    hiddenFields: e.hiddenFields,
    groups: e.groups || [],
    hidden: e.hidden,
    createdAt: e.createdAt
  };
}

function normalizeScheme(raw) {
  return {
    name: raw.name,
    fields: raw.fields || {},
    hiddenFields: raw.hiddenFields || {},
    groups: raw.groups || [],
    hidden: raw.hidden || false,
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function parseFieldRows(container) {
  const groups = [];
  const rows = [];
  let currentGroup = null;
  container.querySelectorAll('.dynamic-field-row, .dynamic-group-row').forEach(row => {
    if (row.classList.contains('dynamic-group-row')) {
      const gName = row.querySelector('.group-name-input').value.trim();
      currentGroup = gName ? { name: gName, fieldKeys: [] } : null;
      if (currentGroup) groups.push(currentGroup);
      return;
    }
    let k = row.querySelector('.field-key-input').value.trim();
    if (!k) return;
    // Link rows created via "Add Link" get the → marker applied on save,
    // unless the user already typed a → or @ prefix themselves.
    if (row.classList.contains('link-row')) {
      if (!isLinkKey(k)) k = '→ ' + k;
    } else if (row.classList.contains('tag-row')) {
      // Tag rows always save with exactly one # marker, however the name
      // was typed.
      k = '#' + k.replace(/^#+\s*/, '');
    } else {
      // Plain field rows no longer create tags: a typed # is stripped, so
      // "Add Tag" is the only way to make one.
      k = k.replace(/^#+\s*/, '');
    }
    const valueInput = row.querySelector('.field-value-input');
    const entry = {
      key: k,
      value: valueInput ? valueInput.value.trim() : '',
      hidden: row.dataset.isHidden === 'true'
    };
    rows.push(entry);
    if (currentGroup && !entry.hidden) currentGroup.fieldKeys.push(k);
  });
  return { rows, groups };
}

// ========== DOM refs ==========
const cardsContainer = document.getElementById('cardsContainer');
const emptyState = document.getElementById('emptyState');
const statsBar = document.getElementById('statsBar');
const searchInput = document.getElementById('searchInput');
const searchWrapper = document.getElementById('searchWrapper');
const themeToggle = document.getElementById('themeToggle');
const addSchemeBtn = document.getElementById('addSchemeBtn');
const schemeModal = document.getElementById('schemeModal');
const modalTitle = document.getElementById('modalTitle');
const schemeNameInput = document.getElementById('schemeNameInput');
const dynamicFields = document.getElementById('dynamicFields');
const addFieldBtn = document.getElementById('addFieldBtn');
const addGroupBtn = document.getElementById('addGroupBtn');
const addLinkBtn = document.getElementById('addLinkBtn');
const addTagBtn = document.getElementById('addTagBtn');
const modalSave = document.getElementById('modalSave');
const modalCancel = document.getElementById('modalCancel');
const modalClose = document.getElementById('modalClose');
const showHiddenBtn = document.getElementById('showHiddenBtn');
const showHiddenCount = document.getElementById('showHiddenCount');
const showHiddenFieldsToggle = document.getElementById('showHiddenFieldsToggle');

// Pivot
const pivotBtn = document.getElementById('pivotBtn');
const pivotModal = document.getElementById('pivotModal');
const pivotModalClose = document.getElementById('pivotModalClose');
const pivotRows = document.getElementById('pivotRows');
const pivotCols = document.getElementById('pivotCols');
const pivotValues = document.getElementById('pivotValues');
const pivotAgg = document.getElementById('pivotAgg');
const generatePivotBtn = document.getElementById('generatePivotBtn');
const pivotResult = document.getElementById('pivotResult');
const pivotFormat = document.getElementById('pivotFormat');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const copyTableBtn = document.getElementById('copyTableBtn');
const pivotExportBar = document.getElementById('pivotExportBar');
const pivotToast = document.getElementById('pivotToast');

// Data Menu
const dataMenuBtn = document.getElementById('dataMenuBtn');
const dataMenuModal = document.getElementById('dataMenuModal');
const dataMenuClose = document.getElementById('dataMenuClose');
const dataImportLocal = document.getElementById('dataImportLocal');
const dataExportLocal = document.getElementById('dataExportLocal');
const dataDriveConnect = document.getElementById('dataDriveConnect');
const dataDrivePull = document.getElementById('dataDrivePull');
const dataDrivePush = document.getElementById('dataDrivePush');
const driveStatusText = document.getElementById('driveStatusText');
const driveStatusSub = document.getElementById('driveStatusSub');
const driveConnectDesc = document.getElementById('driveConnectDesc');
const driveConnectLabel = document.getElementById('driveConnectLabel');
const driveConnectIcon = document.getElementById('driveConnectIcon');
const importFileInput = document.getElementById('importFileInput');

// Bulk
const bulkActionBar = document.getElementById('bulkActionBar');
const bulkSelectedCount = document.getElementById('bulkSelectedCount');
const bulkSelectAllBtn = document.getElementById('bulkSelectAllBtn');
const bulkDeselectAllBtn = document.getElementById('bulkDeselectAllBtn');
const bulkFieldsBtn = document.getElementById('bulkFieldsBtn');
const bulkDuplicateBtn = document.getElementById('bulkDuplicateBtn');
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const bulkModal = document.getElementById('bulkModal');
const bulkModalTitle = document.getElementById('bulkModalTitle');
const bulkModalDesc = document.getElementById('bulkModalDesc');
const bulkModalClose = document.getElementById('bulkModalClose');
const bulkDynamicFields = document.getElementById('bulkDynamicFields');
const bulkAddFieldBtn = document.getElementById('bulkAddFieldBtn');
const bulkAddGroupBtn = document.getElementById('bulkAddGroupBtn');
const bulkAddLinkBtn = document.getElementById('bulkAddLinkBtn');
const bulkAddTagBtn = document.getElementById('bulkAddTagBtn');
const bulkModalCancel = document.getElementById('bulkModalCancel');
const bulkModalSave = document.getElementById('bulkModalSave');
const bulkModalNext = document.getElementById('bulkModalNext');
const bulkModalBack = document.getElementById('bulkModalBack');
const bulkStep1 = document.getElementById('bulkStep1');
const bulkStep2 = document.getElementById('bulkStep2');
const bulkGrid = document.getElementById('bulkGrid');
const bulkBatchChips = document.getElementById('bulkBatchChips');
const bulkStep2Title = document.getElementById('bulkStep2Title');
const bulkStep2Desc = document.getElementById('bulkStep2Desc');

// Copy from
const copyFromSelect = document.getElementById('copyFromSelect');
const copyFromPicklist = document.getElementById('copyFromPicklist');
const copyPicklistBody = document.getElementById('copyPicklistBody');
const copyPickAll = document.getElementById('copyPickAll');
const copyFromBtn = document.getElementById('copyFromBtn');

// Pending
const pendingBar = document.getElementById('pendingBar');
const pendingCount = document.getElementById('pendingCount');
const commitBtn = document.getElementById('commitBtn');
const discardBtn = document.getElementById('discardBtn');

// Detail
const detailModal = document.getElementById('detailModal');
const detailModalTitle = document.getElementById('detailModalTitle');
const detailBackBtn = document.getElementById('detailBackBtn');
const detailModalBody = document.getElementById('detailModalBody');
const detailModalClose = document.getElementById('detailModalClose');
const detailModalCloseBtn = document.getElementById('detailModalCloseBtn');
const detailModalEdit = document.getElementById('detailModalEdit');
const detailSearchInput = document.getElementById('detailSearchInput');
const detailFieldCount = document.getElementById('detailFieldCount');

// ========== Theme ==========
const savedTheme = localStorage.getItem('theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
themeToggle.textContent = savedTheme === 'dark' ? '☀️' : '🌙';

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
});

// ========== Toast ==========
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function showPivotToast(msg) {
  pivotToast.textContent = msg;
  pivotToast.classList.remove('hidden');
  clearTimeout(pivotToast._timer);
  pivotToast._timer = setTimeout(() => pivotToast.classList.add('hidden'), 2000);
}

// ========== Selection Mode ==========
let longPressTimer = null;
const LONG_PRESS_MS = 500;

function enterSelectionMode(id) {
  selectionMode = true;
  selectedIds.clear();
  if (id !== undefined) selectedIds.add(id);
  document.body.classList.add('selection-mode');
  updateBulkBar();
  render();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedIds.clear();
  document.body.classList.remove('selection-mode');
  updateBulkBar();
  render();
}

function toggleSelect(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  if (selectedIds.size === 0) exitSelectionMode();
  else { updateBulkBar(); render(); }
}

function updateBulkBar() {
  const count = selectedIds.size;
  bulkSelectedCount.textContent = `${count} selected`;
  bulkActionBar.classList.toggle('hidden', count === 0 || !selectionMode);
}

function updatePendingBar() {
  const count = pendingChanges.size;
  pendingCount.textContent = `${count} pending change${count !== 1 ? 's' : ''}`;
  pendingBar.classList.toggle('hidden', count === 0);
}

// ========== Render ==========
function render() {
  const visibleSchemes = schemes.filter(s => showHidden ? true : !s.hidden);
  const filtered = visibleSchemes.filter(s => schemeMatchesQuery(getEffective(s.id)));
  const searchInvalid = !!(searchQuery.trim() && compileSearchQuery(searchQuery.trim())?.invalid);
  searchWrapper.classList.toggle('search-invalid', searchInvalid);

  const hiddenCount = schemes.filter(s => s.hidden).length;
  showHiddenCount.textContent = hiddenCount;
  showHiddenBtn.classList.toggle('active', showHidden);

  const pendingCount = schemes.filter(s => pendingChanges.has(s.id)).length;
  const newPending = [...pendingChanges.keys()].filter(isNewId).length;
  const totalPending = pendingCount + newPending;

  statsBar.textContent = `${filtered.length} of ${visibleSchemes.length} card${visibleSchemes.length !== 1 ? 's' : ''}${showHidden && hiddenCount ? ` (${hiddenCount} hidden)` : ''}${totalPending ? ` — ${totalPending} unsaved` : ''}${searchInvalid ? ' — invalid expression' : ''}`;

  updatePendingBar();

  if (filtered.length === 0) {
    cardsContainer.innerHTML = '';
    emptyState.style.display = 'flex';
    emptyState.querySelector('h2').textContent = visibleSchemes.length === 0
      ? 'No cards yet'
      : 'No matching cards';
    emptyState.querySelector('p').textContent = visibleSchemes.length === 0
      ? 'Click "Add Card" to create your first card.'
      : 'Try a different search term.';
    return;
  }

  emptyState.style.display = 'none';

  cardsContainer.innerHTML = filtered.map(s => {
    const e = getEffective(s.id);
    const isPending = pendingChanges.has(s.id);
    const isNew = typeof s.id === 'string';
    const entries = Object.entries(e.fields || {});
    const groups = e.groups || [];
    const groupedKeys = new Set(groups.flatMap(g => g.fields || []));
    const maxPreview = 3;

    // Separate tags (#key) from regular fields
    const tags = entries.filter(([k]) => k.startsWith('#')).map(([k, v]) => [k, v]);
    const regularEntries = entries.filter(([k]) => !k.startsWith('#'));

    // Tags as badges
    const tagsHtml = tags.length
      ? `<div class="card-tags">${tags.map(([k, v]) =>
          `<span class="card-tag">${esc(k)}${v ? ': ' + esc(v) : ''}</span>`
        ).join('')}</div>`
      : '';

    let fieldsHtml = '';
    let shown = 0;

    if (groups.length > 0) {
      groups.forEach(g => {
        if (shown >= maxPreview) return;
        const gFields = (g.fields || []).filter(k => e.fields && e.fields[k] !== undefined && !k.startsWith('#'));
        if (gFields.length === 0) return;
        fieldsHtml += `<div class="card-group-header">${esc(g.name)}</div>`;
        gFields.slice(0, maxPreview - shown).forEach(k => {
          fieldsHtml += `<div class="card-field"><span class="field-key">${esc(isLinkKey(k) ? linkLabel(k) : k)}</span><span class="field-value${isLinkKey(k) ? ' card-links' : ''}">${fieldValueCellHtml(k, e.fields[k])}</span></div>`;
          shown++;
        });
      });
    }

    const ungrouped = regularEntries.filter(([k]) => !groupedKeys.has(k));
    ungrouped.slice(0, maxPreview - shown).forEach(([k, v]) => {
      fieldsHtml += `<div class="card-field"><span class="field-key">${esc(isLinkKey(k) ? linkLabel(k) : k)}</span><span class="field-value${isLinkKey(k) ? ' card-links' : ''}">${fieldValueCellHtml(k, v)}</span></div>`;
      shown++;
    });

    if (shown === 0 && !tagsHtml) fieldsHtml = '<div class="card-empty">No additional fields</div>';

    const totalFields = entries.length;
    const viewMore = totalFields > maxPreview
      ? `<div class="card-view-more">View all ${totalFields} fields →</div>`
      : '';

    const hiddenBadge = e.hidden ? '<span class="card-hidden-badge">Hidden</span>' : '';
    const pendingBadge = isPending ? '<span class="card-pending-badge">Unsaved</span>' : '';

    const classes = ['card'];
    if (selectedIds.has(s.id)) classes.push('card-selected');
    if (e.hidden) classes.push('card-is-hidden');
    if (isPending) classes.push('card-has-pending');

    const NAME_MAX = 40;
    const needsTrunc = e.name.length > NAME_MAX;
    const truncName = needsTrunc ? esc(e.name.slice(0, NAME_MAX)) + '…' : esc(e.name);
    const nameHtml = needsTrunc
      ? `<h3 class="card-name-truncated">${truncName}<a href="#" class="card-name-more">see more</a></h3>`
      : `<h3>${esc(e.name)}</h3>`;

    return `
      <div class="${classes.join(' ')}" data-id="${s.id}">
        <div class="card-header">
          ${nameHtml}${hiddenBadge}${pendingBadge}
          <div class="card-actions">
            <button class="edit-btn" title="Edit">✏️</button>
          </div>
        </div>
        ${tagsHtml}
        <div class="card-body">${fieldsHtml}${viewMore}</div>
      </div>
    `;
  }).join('');
}

// Card actions are bound once here via delegation; render() only writes innerHTML.
function cardIdFrom(target) {
  const card = target.closest('.card');
  if (!card) return null;
  const numId = Number(card.dataset.id);
  return isNaN(numId) ? card.dataset.id : numId;
}

function clearLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

cardsContainer.addEventListener('click', e => {
  const schemeId = cardIdFrom(e.target);
  if (schemeId === null) return;

  if (e.target.closest('.edit-btn')) { e.stopPropagation(); editScheme(schemeId); return; }
  const linkChip = e.target.closest('.link-chip');
  if (linkChip) {
    e.stopPropagation();
    if (linkChip.dataset.target) {
      const t = findSchemeByName(linkChip.dataset.target);
      if (t) openDetailModal(t.id);
    } else if (linkChip.dataset.missing) {
      showToast(`No card named "${linkChip.dataset.missing}"`);
    }
    return;
  }
  if (e.target.closest('.card-name-more')) {
    e.preventDefault();
    e.stopPropagation();
    const h3 = e.target.closest('h3');
    h3.innerHTML = esc(getEffective(schemeId).name);
    h3.classList.remove('card-name-truncated');
    return;
  }
  if (e.target.closest('.card-view-more')) { openDetailModal(schemeId); return; }
  if (e.target.closest('.card-actions')) return;

  if (selectionMode) toggleSelect(schemeId);
  else openDetailModal(schemeId);
});

cardsContainer.addEventListener('pointerdown', e => {
  if (e.target.closest('.card-actions')) return;
  const schemeId = cardIdFrom(e.target);
  if (schemeId === null) return;
  const card = e.target.closest('.card');
  const onCancel = () => { clearLongPress(); cleanup(); };
  const cleanup = () => {
    card.removeEventListener('pointerleave', onCancel);
    card.removeEventListener('pointerup', onCancel);
    card.removeEventListener('pointercancel', onCancel);
  };
  card.addEventListener('pointerleave', onCancel);
  card.addEventListener('pointerup', onCancel);
  card.addEventListener('pointercancel', onCancel);
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    cleanup();
    enterSelectionMode(schemeId);
  }, LONG_PRESS_MS);
});

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ========== Scheme Links ==========
// A link field is any field whose key starts with → (or @). Its value is a
// comma-separated list of other schemes' names. Stored as plain text so
// export/import, pivot, search and bulk edit keep treating it like any field.
const LINK_KEY_RE = /^[→@]/;

function isLinkKey(k) {
  return LINK_KEY_RE.test(String(k));
}

function linkLabel(k) {
  return String(k).replace(/^[→@]\s*/, '');
}

// A tag field is any field whose key starts with #. Like links, the prefix
// is a storage marker: users create tags with the "Add Tag" button and never
// type the # themselves — parseFieldRows applies it on save.
const TAG_KEY_RE = /^#/;

function isTagKey(k) {
  return TAG_KEY_RE.test(String(k));
}

function tagLabel(k) {
  return String(k).replace(/^#\s*/, '');
}

function knownSchemeNameSet() {
  const set = new Set();
  schemes.forEach(s => {
    const n = (getEffective(s.id).name || '').trim().toLowerCase();
    if (n) set.add(n);
  });
  return set;
}

// Values are comma-joined names, but names may contain commas too ("Bore
// Well, Main"), so a plain split shreds one target into fragments. Rebuild:
// keep fragments that already match a real scheme, then greedily rejoin runs
// of leftovers longest-first until the joined text matches. When both
// readings are valid the single-target reading wins, since multi-link lists
// are the common case; anything unmatched stays a fragment and renders as an
// unresolved chip. Stored text is never rewritten by this.
function parseLinkTargets(v) {
  const parts = String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [];
  const known = knownSchemeNameSet();
  const out = [];
  let i = 0;
  while (i < parts.length) {
    if (known.has(parts[i].toLowerCase())) {
      out.push(parts[i]);
      i++;
      continue;
    }
    let j = parts.length;
    while (j > i + 1 && !known.has(parts.slice(i, j).join(', ').toLowerCase())) j--;
    if (j > i + 1) {
      out.push(parts.slice(i, j).join(', '));
      i = j;
    } else {
      out.push(parts[i]);
      i++;
    }
  }
  return out;
}

// esc() escapes <>& but not quotes; use this for attribute values.
function escAttr(str) {
  return esc(str).replace(/"/g, '&quot;');
}

function findSchemeByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return schemes.find(s => (getEffective(s.id).name || '').trim().toLowerCase() === n) || null;
}

// Schemes whose link fields name this scheme. Computed live so backlinks
// survive without storage: they are just the reverse reading of the graph.
function getBacklinks(id) {
  const self = getEffective(id);
  if (!self) return [];
  const selfName = (self.name || '').trim().toLowerCase();
  const out = [];
  schemes.forEach(s => {
    if (String(s.id) === String(id)) return;
    const e = getEffective(s.id);
    Object.entries(e.fields || {}).forEach(([k, v]) => {
      if (!isLinkKey(k)) return;
      if (parseLinkTargets(v).some(t => t.toLowerCase() === selfName)) {
        out.push({ fromId: s.id, fromName: e.name, label: linkLabel(k) });
      }
    });
  });
  return out;
}

function linkChipHtml(name) {
  const target = findSchemeByName(name);
  if (target) {
    return `<button type="button" class="link-chip" data-target="${escAttr(name)}"><span class="link-dot"></span>${esc(name)}</button>`;
  }
  return `<span class="link-chip link-chip-unresolved" data-missing="${escAttr(name)}" title="No card named “${escAttr(name)}”"><span class="link-dot"></span>${esc(name)}?</span>`;
}

function linkChipsHtml(value) {
  return parseLinkTargets(value).map(linkChipHtml).join('');
}

// Value cell for card/detail rows: chips for link fields, escaped text otherwise.
function fieldValueCellHtml(k, v) {
  return isLinkKey(k) ? `<span class="card-links">${linkChipsHtml(v)}</span>` : esc(v);
}

// ========== CRUD (all staged) ==========
async function loadSchemes() {
  schemes = await dbGetAll();
  render();
}

function editScheme(id) {
  const scheme = getEffective(id);
  if (scheme) openModal(scheme);
}

// Stages a pending clone with a "(copy)" suffix. Silent — callers own the
// toast, so multi-selection can summarize one operation in one message.
function duplicateScheme(id) {
  const source = getEffective(id);
  if (!source) return;
  stageNewScheme(
    source.name + ' (copy)',
    { ...(source.fields || {}) },
    { ...(source.hiddenFields || {}) },
    JSON.parse(JSON.stringify(source.groups || []))
  );
}

showHiddenBtn.addEventListener('click', () => {
  showHidden = !showHidden;
  exitSelectionMode();
});

// ========== Modal - Scheme ==========
let showHiddenFields = false;

function openModal(scheme = null) {
  editingId = scheme ? scheme.id : null;
  modalTitle.textContent = scheme ? 'Edit Card' : 'Add Card';
  schemeNameInput.value = scheme ? scheme.name : '';
  updateFieldSuggestions();
  dynamicFields.innerHTML = '';
  showHiddenFields = false;

  const entries = scheme ? Object.entries(scheme.fields || {}) : [];
  const hiddenEntries = scheme ? Object.entries(scheme.hiddenFields || {}) : [];
  const groups = scheme ? (scheme.groups || []) : [];
  const groupedKeys = new Set(groups.flatMap(g => g.fields || []));

  if (entries.length === 0 && hiddenEntries.length === 0 && groups.length === 0) {
    addFieldRow('', '');
  } else {
    // Link fields get the token-chip editor, tag fields the tag row;
    // everything else a plain row.
    const addRowFor = (k, v, isHidden) =>
      isLinkKey(k) ? addLinkRow(linkLabel(k), v, isHidden)
      : isTagKey(k) ? addTagRow(tagLabel(k), v, isHidden)
      : addFieldRow(k, v, isHidden);
    // Render grouped fields under their group headers
    groups.forEach(g => {
      addGroupRow(g.name);
      (g.fields || []).forEach(k => {
        const v = scheme.fields ? scheme.fields[k] : '';
        if (v !== undefined) addRowFor(k, v, false);
      });
    });
    // Render ungrouped fields (not in any group, not hidden)
    entries.filter(([k]) => !groupedKeys.has(k)).forEach(([k, v]) => addRowFor(k, v, false));
    // Render hidden fields
    hiddenEntries.forEach(([k, v]) => addRowFor(k, v, true));
  }

  renderHiddenFieldsToggle(hiddenEntries.length);

  // Populate copy-from dropdown (exclude current scheme)
  copyFromSelect.innerHTML = '<option value="">— Select a card —</option>';
  schemes.filter(s => s.id !== editingId).forEach(s => {
    const e = getEffective(s.id);
    copyFromSelect.innerHTML += `<option value="${s.id}">${esc(e.name)}</option>`;
  });
  copyFromSelect.value = '';
  copyFromPicklist.classList.add('hidden');

  schemeModal.classList.remove('hidden');
  setTimeout(() => schemeNameInput.focus(), 100);
}

copyFromSelect.addEventListener('change', () => {
  const sourceId = copyFromSelect.value;
  if (!sourceId) { copyFromPicklist.classList.add('hidden'); return; }
  const source = getEffective(sourceId);
  if (!source) { copyFromPicklist.classList.add('hidden'); return; }

  const sourceFields = source.fields || {};
  const sourceGroups = source.groups || [];
  const groupedKeys = new Set(sourceGroups.flatMap(g => g.fields || []));
  let html = '';

  sourceGroups.forEach(g => {
    const gFields = (g.fields || []).filter(k => sourceFields[k] !== undefined);
    if (gFields.length === 0) return;
    html += `<div class="copy-pick-group">`;
    html += `<label class="copy-pick-item copy-pick-group-label">
      <input type="checkbox" class="copy-pick-group-cb" data-group="${esc(g.name)}" data-fields="${esc(gFields.join(','))}" />
      <span>📁 ${esc(g.name)}</span>
    </label>`;
    gFields.forEach(k => {
      html += `<label class="copy-pick-item copy-pick-field">
        <input type="checkbox" class="copy-pick-field-cb" data-key="${esc(k)}" data-group="${esc(g.name)}" />
        <span>${esc(k)}: <em>${esc(sourceFields[k])}</em></span>
      </label>`;
    });
    html += `</div>`;
  });

  const ungrouped = Object.entries(sourceFields).filter(([k]) => !groupedKeys.has(k));
  if (ungrouped.length > 0) {
    ungrouped.forEach(([k, v]) => {
      html += `<label class="copy-pick-item copy-pick-field">
        <input type="checkbox" class="copy-pick-field-cb" data-key="${esc(k)}" />
        <span>${esc(k)}: <em>${esc(v)}</em></span>
      </label>`;
    });
  }

  copyPicklistBody.innerHTML = html || '<p class="copy-empty">No fields to copy</p>';
  copyPickAll.checked = false;
  copyFromPicklist.classList.remove('hidden');

  // Wire group checkboxes
  copyPicklistBody.querySelectorAll('.copy-pick-group-cb').forEach(gcb => {
    gcb.addEventListener('change', () => {
      const fields = gcb.dataset.fields.split(',').filter(Boolean);
      copyPicklistBody.querySelectorAll(`.copy-pick-field-cb[data-group="${gcb.dataset.group}"]`).forEach(fcb => {
        fcb.checked = gcb.checked;
      });
    });
  });

  // Wire select all
  copyPickAll.addEventListener('change', () => {
    copyPicklistBody.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = copyPickAll.checked);
  });
});

copyFromBtn.addEventListener('click', () => {
  const sourceId = copyFromSelect.value;
  if (!sourceId) { showToast('Select a card first'); return; }
  const source = getEffective(sourceId);
  if (!source) return;

  const sourceFields = source.fields || {};
  const sourceGroups = source.groups || [];
  const checkedFieldKeys = new Set();

  copyPicklistBody.querySelectorAll('.copy-pick-field-cb:checked').forEach(cb => {
    checkedFieldKeys.add(cb.dataset.key);
  });

  if (checkedFieldKeys.size === 0) { showToast('Check at least one field to copy'); return; }

  const groupedCheckedKeys = new Set();
  const pasteField = (k, v) =>
    isLinkKey(k) ? addLinkRow(linkLabel(k), v)
    : isTagKey(k) ? addTagRow(tagLabel(k), v)
    : addFieldRow(k, v, false);

  // Add checked group headers with their fields
  sourceGroups.forEach(g => {
    const gCb = copyPicklistBody.querySelector(`.copy-pick-group-cb[data-group="${esc(g.name)}"]`);
    const groupChecked = gCb && gCb.checked;
    const gFields = (g.fields || []).filter(k => checkedFieldKeys.has(k));
    if (!groupChecked && gFields.length === 0) return;
    addGroupRow(g.name);
    gFields.forEach(k => {
      groupedCheckedKeys.add(k);
      if (sourceFields[k] !== undefined) pasteField(k, sourceFields[k]);
    });
  });

  // Add remaining checked fields not in any group
  checkedFieldKeys.forEach(k => {
    if (!groupedCheckedKeys.has(k) && sourceFields[k] !== undefined) {
      pasteField(k, sourceFields[k]);
    }
  });

  showToast(`Copied ${checkedFieldKeys.size} field(s) from "${source.name}"`);
  copyFromSelect.value = '';
  copyFromPicklist.classList.add('hidden');
});

function renderHiddenFieldsToggle(hiddenCount) {
  if (hiddenCount === 0) {
    showHiddenFieldsToggle.classList.add('hidden');
    showHiddenFields = false;
    return;
  }
  showHiddenFieldsToggle.classList.remove('hidden');
  showHiddenFieldsToggle.textContent = showHiddenFields
    ? `Hide ${hiddenCount} hidden field${hiddenCount !== 1 ? 's' : ''}`
    : `Show ${hiddenCount} hidden field${hiddenCount !== 1 ? 's' : ''}`;
}

function closeModal() {
  schemeModal.classList.add('hidden');
  editingId = null;
}

function getUniqueFieldKeys() {
  const keys = new Set();
  schemes.forEach(s => {
    const e = getEffective(s.id);
    Object.keys(e.fields || {}).forEach(k => keys.add(k));
  });
  return Array.from(keys);
}

function getUniqueTagNames() {
  const names = new Set();
  schemes.forEach(s => {
    const e = getEffective(s.id);
    Object.keys(e.fields || {}).forEach(k => {
      if (isTagKey(k)) names.add(tagLabel(k));
    });
  });
  return Array.from(names);
}

function updateFieldSuggestions() {
  // Tag keys are offered by tagNameSuggestions instead — plain fields no
  // longer suggest or create # keys.
  const keys = getUniqueFieldKeys().filter(k => !isTagKey(k));
  const datalist = document.getElementById('fieldKeySuggestions');
  datalist.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
  const linkDatalist = document.getElementById('linkLabelSuggestions');
  if (linkDatalist) {
    linkDatalist.innerHTML = getUniqueLinkLabels().map(l => `<option value="${esc(l)}">`).join('');
  }
  const tagDatalist = document.getElementById('tagNameSuggestions');
  if (tagDatalist) {
    tagDatalist.innerHTML = getUniqueTagNames().map(t => `<option value="${esc(t)}">`).join('');
  }
}

let fieldRowIndex = 0;

function initDragHandle(row) {
  const handle = row.querySelector('.drag-handle');
  if (!handle) return;
  handle.addEventListener('dragstart', e => {
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  });
  handle.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const container = row.parentElement;
    const dragging = container.querySelector('.dragging');
    if (!dragging || dragging === row) return;
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      container.insertBefore(dragging, row);
    } else {
      container.insertBefore(dragging, row.nextSibling);
    }
  });
}

function addFieldRow(key = '', value = '', isHidden = false) {
  const idx = fieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row';
  row.dataset.isHidden = isHidden ? 'true' : 'false';
  if (isHidden) row.classList.add('field-hidden');
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <input type="text" class="field-key-input" name="field_key_${idx}" placeholder="Field name" value="${esc(key)}" list="fieldKeySuggestions" />
    <input type="text" class="field-value-input" name="field_value_${idx}" placeholder="Value" value="${esc(value)}" />
    <button class="remove-field" type="button" title="Hide field">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => {
    if (row.dataset.isHidden === 'true') {
      row.remove();
      updateHiddenFieldsCount();
    } else {
      row.dataset.isHidden = 'true';
      row.classList.add('field-hidden');
      updateHiddenFieldsCount();
    }
  });
  initDragHandle(row);
  dynamicFields.appendChild(row);
  updateHiddenFieldsCount();
}

let groupRowIndex = 0;

function addGroupRow(name = '') {
  const idx = groupRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-group-row';
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <span class="group-icon">📁</span>
    <input type="text" class="group-name-input" name="group_name_${idx}" placeholder="Group name" value="${esc(name)}" />
    <button class="remove-field" type="button" title="Remove group">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => row.remove());
  initDragHandle(row);
  dynamicFields.appendChild(row);
}

function updateHiddenFieldsCount() {
  const hiddenCount = dynamicFields.querySelectorAll('.dynamic-field-row[data-is-hidden="true"]').length;
  if (editingId) renderHiddenFieldsToggle(hiddenCount);
}

// ---------- Link rows (token-chip editor) ----------
function getUniqueLinkLabels() {
  const labels = new Set();
  schemes.forEach(s => {
    const e = getEffective(s.id);
    Object.keys(e.fields || {}).forEach(k => {
      if (isLinkKey(k)) labels.add(linkLabel(k));
    });
  });
  return Array.from(labels);
}

// Token-chip picker: selected schemes render as removable chips, the entry
// input autocompletes over scheme names. The comma-joined selection is kept
// in sync with a hidden .field-value-input so parseFieldRows reads it like
// any other field.
function initLinkEditor(row, initialValue) {
  const editor = row.querySelector('.link-editor');
  const chipsBox = editor.querySelector('.link-chips');
  const entry = editor.querySelector('.link-entry');
  const hidden = editor.querySelector('.field-value-input');
  let items = parseLinkTargets(initialValue);
  let activeIdx = -1;

  const sug = document.createElement('div');
  sug.className = 'link-suggest hidden';
  editor.appendChild(sug);

  const selfName = () => (schemeNameInput ? schemeNameInput.value : '').trim().toLowerCase();

  function sync() { hidden.value = items.join(', '); }

  function renderChips() {
    chipsBox.innerHTML = items.map((n, i) =>
      `<span class="link-chip link-chip-edit"><span class="link-dot"></span>${esc(n)}<button type="button" class="link-chip-x" data-i="${i}" aria-label="Remove ${escAttr(n)}">&times;</button></span>`
    ).join('');
  }

  function candidates() {
    const q = entry.value.trim().toLowerCase();
    const chosen = new Set(items.map(x => x.toLowerCase()));
    return schemes
      .map(s => getEffective(s.id))
      .filter(e => (e.name || '').trim().toLowerCase() !== selfName())
      .map(e => e.name)
      .filter(n => !chosen.has(n.toLowerCase()) && (!q || n.toLowerCase().includes(q)));
  }

  function renderSug() {
    const c = candidates().slice(0, 8);
    if (c.length === 0) { sug.classList.add('hidden'); activeIdx = -1; return; }
    if (activeIdx >= c.length) activeIdx = c.length - 1;
    if (activeIdx < 0) activeIdx = 0;
    sug.innerHTML = c.map((n, i) =>
      `<button type="button" class="link-sug${i === activeIdx ? ' link-sug-active' : ''}" data-name="${escAttr(n)}">${esc(n)}</button>`
    ).join('');
    sug.classList.remove('hidden');
  }

  function addItem(name) {
    name = String(name || '').trim();
    if (!name) return;
    if (items.some(x => x.toLowerCase() === name.toLowerCase())) {
      entry.value = '';
      renderSug();
      return;
    }
    items.push(name);
    entry.value = '';
    activeIdx = -1;
    renderChips();
    sync();
    renderSug();
  }

  function removeAt(i) {
    items.splice(i, 1);
    renderChips();
    sync();
  }

  entry.addEventListener('input', () => { activeIdx = -1; renderSug(); });
  entry.addEventListener('focus', renderSug);
  entry.addEventListener('keydown', e => {
    const c = candidates().slice(0, 8);
    if (e.key === 'ArrowDown' && c.length) {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, c.length - 1);
      renderSug();
    } else if (e.key === 'ArrowUp' && c.length) {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      renderSug();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      addItem(c[activeIdx] !== undefined ? c[activeIdx] : entry.value);
    } else if (e.key === 'Backspace' && !entry.value && items.length) {
      removeAt(items.length - 1);
    } else if (e.key === 'Escape') {
      // Dismiss only the dropdown; the global Escape handler would close
      // the whole modal and discard the form.
      e.stopPropagation();
      sug.classList.add('hidden');
    }
  });
  // Free-typed names are allowed too: they commit on blur and simply show
  // as unresolved chips until a scheme with that name exists.
  entry.addEventListener('blur', () => {
    setTimeout(() => sug.classList.add('hidden'), 150);
    if (entry.value.trim()) addItem(entry.value);
  });
  sug.addEventListener('mousedown', e => {
    const b = e.target.closest('.link-sug');
    if (!b) return;
    e.preventDefault(); // keep focus in the entry; blur handler would re-add
    addItem(b.dataset.name);
  });
  chipsBox.addEventListener('click', e => {
    const x = e.target.closest('.link-chip-x');
    if (x) removeAt(Number(x.dataset.i));
  });

  renderChips();
  sync();
}

function addLinkRow(label = '', value = '', isHidden = false) {
  const idx = fieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row link-row';
  row.dataset.isHidden = isHidden ? 'true' : 'false';
  if (isHidden) row.classList.add('field-hidden');
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <input type="text" class="field-key-input" name="field_key_${idx}" placeholder="Link label (e.g. Feeds)" value="${esc(label ? '→ ' + label : '')}" list="linkLabelSuggestions" />
    <div class="link-editor">
      <span class="link-chips"></span>
      <input type="text" class="link-entry" placeholder="Add scheme…" autocomplete="off" />
      <input type="hidden" class="field-value-input" value="${escAttr(value)}" />
    </div>
    <button class="remove-field" type="button" title="Hide field">&times;</button>
  `;
  initLinkEditor(row, value);
  row.querySelector('.remove-field').addEventListener('click', () => {
    if (row.dataset.isHidden === 'true') {
      row.remove();
      updateHiddenFieldsCount();
    } else {
      row.dataset.isHidden = 'true';
      row.classList.add('field-hidden');
      updateHiddenFieldsCount();
    }
  });
  initDragHandle(row);
  dynamicFields.appendChild(row);
  updateHiddenFieldsCount();
}

// Tag rows look like plain field rows but carry the tag-row class: on save
// the key gets the # marker and renders as a card badge. The name input
// suggests tags already in use.
function addTagRow(label = '', value = '', isHidden = false) {
  const idx = fieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row tag-row';
  row.dataset.isHidden = isHidden ? 'true' : 'false';
  if (isHidden) row.classList.add('field-hidden');
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <span class="row-type-icon" aria-hidden="true">🏷️</span>
    <input type="text" class="field-key-input" name="field_key_${idx}" placeholder="Tag name" value="${esc(label)}" list="tagNameSuggestions" />
    <input type="text" class="field-value-input" name="field_value_${idx}" placeholder="Value (optional)" value="${esc(value)}" />
    <button class="remove-field" type="button" title="Hide field">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => {
    if (row.dataset.isHidden === 'true') {
      row.remove();
      updateHiddenFieldsCount();
    } else {
      row.dataset.isHidden = 'true';
      row.classList.add('field-hidden');
      updateHiddenFieldsCount();
    }
  });
  initDragHandle(row);
  dynamicFields.appendChild(row);
  updateHiddenFieldsCount();
}

function collectFieldData() {
  const name = schemeNameInput.value.trim();
  if (!name) {
    alert('Card name is required');
    return null;
  }
  const { rows, groups } = parseFieldRows(dynamicFields);
  const fields = {};
  const hiddenFields = {};
  rows.forEach(r => {
    if (r.hidden) hiddenFields[r.key] = r.value;
    else fields[r.key] = r.value;
  });
  return { name, fields, hiddenFields, groups: groups.map(g => ({ name: g.name, fields: g.fieldKeys })) };
}

addSchemeBtn.addEventListener('click', () => openModal());
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
schemeModal.addEventListener('click', e => {
  if (e.target === schemeModal) closeModal();
});

addFieldBtn.addEventListener('click', () => addFieldRow('', ''));
addGroupBtn.addEventListener('click', () => addGroupRow(''));
addLinkBtn.addEventListener('click', () => addLinkRow('', ''));
addTagBtn.addEventListener('click', () => addTagRow('', ''));

showHiddenFieldsToggle.addEventListener('click', () => {
  showHiddenFields = !showHiddenFields;
  const hiddenCount = dynamicFields.querySelectorAll('.dynamic-field-row[data-is-hidden="true"]').length;
  renderHiddenFieldsToggle(hiddenCount);
  dynamicFields.querySelectorAll('.dynamic-field-row[data-is-hidden="true"]').forEach(row => {
    row.classList.toggle('field-hidden', !showHiddenFields);
  });
});

modalSave.addEventListener('click', () => {
  const data = collectFieldData();
  if (!data) return;
  if (editingId) {
    stageChange(editingId, data);
    showToast('Changes staged');
  } else {
    stageNewScheme(data.name, data.fields, data.hiddenFields, data.groups);
    showToast('New card staged');
  }
  closeModal();
});

schemeNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') modalSave.click();
});

// ========== Detail Modal ==========
let detailSchemeId = null;
let detailEntries = [];
let detailGroups = [];
let detailHistory = [];

// The Connections block: outgoing link fields grouped by label on a rail,
// plus "Referenced by" backlinks computed from every other scheme. Both
// directions are clickable and navigate within the modal. This block is the
// only place link fields appear — they are kept out of the detail rows and
// the field count below. While filtering, it narrows to matching labels,
// targets and referrers instead of disappearing.
function renderConnectionsHtml(query) {
  const q = (query || '').trim().toLowerCase();
  const hit = s => !q || String(s).toLowerCase().includes(q);

  const outGroups = [];
  detailEntries.forEach(([k, v]) => {
    if (!isLinkKey(k)) return;
    const targets = parseLinkTargets(v);
    if (hit(linkLabel(k))) {
      outGroups.push({ label: linkLabel(k), targets });
    } else {
      const matched = targets.filter(hit);
      if (matched.length) outGroups.push({ label: linkLabel(k), targets: matched });
    }
  });
  const backs = getBacklinks(detailSchemeId).filter(b => hit(b.fromName) || hit(b.label));

  if (!outGroups.length && !backs.length) {
    if (q) return '';
    return `<div class="connections-block">
      <div class="connections-title">Connections</div>
      <p class="connections-none">No linked cards yet — add one while editing.</p>
    </div>`;
  }

  let html = `<div class="connections-block"><div class="connections-title">Connections</div>`;
  outGroups.forEach(g => {
    html += `<div class="conn-group conn-out">
      <div class="conn-label"><span class="conn-arrow" aria-hidden="true">→</span>${esc(g.label)}</div>
      <div class="conn-nodes">${g.targets.map(linkChipHtml).join('')}</div>
    </div>`;
  });
  if (backs.length) {
    html += `<div class="conn-group conn-in">
      <div class="conn-label"><span class="conn-arrow" aria-hidden="true">←</span>Referenced by</div>
      <div class="conn-nodes">${backs.map(b =>
        `<button type="button" class="link-chip" data-target-id="${escAttr(String(b.fromId))}"><span class="link-dot"></span>${esc(b.fromName)}${b.label ? `<span class="conn-via"> · ${esc(b.label)}</span>` : ''}</button>`
      ).join('')}</div>
    </div>`;
  }
  html += `</div>`;
  return html;
}

function renderDetailRows() {
  const query = detailSearchInput.value.toLowerCase();
  // Link fields live in the Connections block, never among these rows.
  const plainEntries = detailEntries.filter(([k]) => !isLinkKey(k));
  const matchesQuery = ([k, v]) =>
    !query || k.toLowerCase().includes(query) || String(v).toLowerCase().includes(query);
  let rows = '';

  if (detailGroups.length > 0 && !query) {
    const groupedKeys = new Set(detailGroups.flatMap(g => g.fields || []));
    detailGroups.forEach(g => {
      const gFields = (g.fields || [])
        .filter(k => !isLinkKey(k))
        .map(k => [k, detailEntries.find(([ek]) => ek === k)])
        .filter(([, v]) => v !== undefined);
      if (gFields.length === 0) return;
      rows += `<div class="detail-group-header">${esc(g.name)}</div>`;
      gFields.forEach(([k, [, v]]) => {
        rows += `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`;
      });
    });
    const ungrouped = plainEntries.filter(([k]) => !groupedKeys.has(k));
    if (ungrouped.length > 0) {
      ungrouped.forEach(([k, v]) => {
        rows += `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`;
      });
    }
  } else {
    const filtered = plainEntries.filter(matchesQuery);
    rows = filtered.length
      ? filtered.map(([k, v]) =>
          `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`
        ).join('')
      : '<p class="detail-empty">No matching fields</p>';
  }

  const visiblePlain = plainEntries.filter(matchesQuery);

  detailModalBody.innerHTML = renderConnectionsHtml(query) + rows;
  detailFieldCount.textContent = `${visiblePlain.length} of ${plainEntries.length} field${plainEntries.length !== 1 ? 's' : ''}`;
}

function openDetailModal(id, opts = {}) {
  const scheme = getEffective(id);
  if (!scheme) return;
  if (!opts.navigate) detailHistory = [];
  detailSchemeId = id;
  detailModalTitle.textContent = scheme.name;
  detailEntries = Object.entries(scheme.fields || {});
  detailGroups = scheme.groups || [];
  detailSearchInput.value = '';
  renderDetailRows();
  detailBackBtn.classList.toggle('hidden', detailHistory.length === 0);
  detailModal.classList.remove('hidden');
  detailModalBody.scrollTop = 0;
  if (opts.refocusTitle) detailModalTitle.focus();
}

// Follow a link chip: remember where we came from so the back arrow can
// retrace the path through the network.
function gotoLinkedScheme(id) {
  if (detailSchemeId === null || String(detailSchemeId) === String(id)) return;
  detailHistory.push(detailSchemeId);
  openDetailModal(id, { navigate: true, refocusTitle: true });
}

function closeDetailModal() {
  detailModal.classList.add('hidden');
  detailSchemeId = null;
  detailEntries = [];
  detailHistory = [];
}

detailSearchInput.addEventListener('input', renderDetailRows);

detailBackBtn.addEventListener('click', () => {
  const prev = detailHistory.pop();
  if (prev !== null && prev !== undefined) {
    openDetailModal(prev, { navigate: true, refocusTitle: true });
  } else {
    detailBackBtn.classList.add('hidden');
  }
});

// Chip navigation inside the detail body
detailModalBody.addEventListener('click', e => {
  const chip = e.target.closest('.link-chip');
  if (!chip) return;
  if (chip.dataset.targetId !== undefined) {
    const t = findScheme(chip.dataset.targetId);
    if (t) gotoLinkedScheme(t.id);
    else showToast('That card no longer exists');
    return;
  }
  if (chip.dataset.target) {
    const t = findSchemeByName(chip.dataset.target);
    if (t) gotoLinkedScheme(t.id);
    return;
  }
  if (chip.dataset.missing) {
      showToast(`No card named "${chip.dataset.missing}"`);
  }
});

detailModalClose.addEventListener('click', closeDetailModal);
detailModalCloseBtn.addEventListener('click', closeDetailModal);
detailModalEdit.addEventListener('click', () => {
  if (detailSchemeId) editScheme(detailSchemeId);
  closeDetailModal();
});

// ========== Search ==========
let searchTimer = null;
searchInput.addEventListener('input', e => {
  searchQuery = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(), 100);
});

// ========== Expression Search ==========
// Queries containing field:"Name" references or comparison operators are
// compiled with filtrex (vendored at vendor/filtrex.js) and evaluated per
// scheme; everything else stays a plain substring search. Supported syntax:
// and/or/not, == != > >= < <=, ~= (regex), if/then/else, exists(), empty(),
// arithmetic. Bare words resolve against field names case-insensitively and
// `name` is the scheme name. Numeric-looking values compare as numbers.
const EXPR_FIELD_RE = /field\s*:\s*(?:"([^"]*)"|'([^']*)')/gi;
const EXPR_OPS_RE = /==|!=|>=|<=|~=|[A-Za-z0-9_)"']\s*[<>]\s*[0-9"']/;

function preprocessExprQuery(q) {
  return q.replace(EXPR_FIELD_RE, (m, dq, sq) => {
    const name = (dq !== undefined ? dq : sq).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return '__field("' + name + '")';
  });
}

function coerceFieldValue(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  }
  return v;
}

function lookupExprField(fields, name) {
  if (fields && Object.prototype.hasOwnProperty.call(fields, name)) {
    return coerceFieldValue(fields[name]);
  }
  const lower = String(name).trim().toLowerCase();
  for (const k of Object.keys(fields || {})) {
    if (k.trim().toLowerCase() === lower) return coerceFieldValue(fields[k]);
  }
  return undefined;
}

// __field reads the scheme currently being tested; evaluation is synchronous,
// so this slot is set right before each call.
let exprCurrentFields = {};
const exprCache = new Map();

// Returns { fn } when the query compiles, { invalid: true } when it looks
// like an expression but does not compile, or null for plain text queries.
function compileSearchQuery(q) {
  EXPR_FIELD_RE.lastIndex = 0;
  if (!EXPR_FIELD_RE.test(q) && !EXPR_OPS_RE.test(q)) return null;
  if (exprCache.has(q)) return exprCache.get(q);
  if (exprCache.size > 100) exprCache.clear();
  let result;
  try {
    result = {
      fn: window.filtrex.compileExpression(preprocessExprQuery(q), {
        extraFunctions: { __field: name => lookupExprField(exprCurrentFields, name) },
        customProp: (name, get, obj) =>
          obj && Object.prototype.hasOwnProperty.call(obj, name)
            ? obj[name]
            : lookupExprField(obj, name),
        operators: { '~=': (a, b) => RegExp(String(b)).test(String(a)) }
      })
    };
  } catch (err) {
    result = { invalid: true };
  }
  exprCache.set(q, result);
  return result;
}

function schemeMatchesQuery(e) {
  const q = searchQuery.trim();
  if (!q) return true;
  const compiled = compileSearchQuery(q);
  if (compiled) {
    if (compiled.invalid) return false;
    exprCurrentFields = e.fields || {};
    // filtrex returns runtime errors as truthy Error objects; only a real
    // boolean true counts as a match.
    try {
      return compiled.fn(Object.assign({}, e.fields, { name: e.name })) === true;
    } catch (err) {
      return false;
    }
  }
  const lq = q.toLowerCase();
  return (e.name || '').toLowerCase().includes(lq) ||
    Object.entries(e.fields || {}).some(([k, v]) =>
      k.toLowerCase().includes(lq) ||
      String(v).toLowerCase().includes(lq)
    );
}

// ========== Bulk Operations ==========
bulkSelectAllBtn.addEventListener('click', () => {
  // Respect the active search: only cards currently matching are selected.
  const visibleSchemes = schemes
    .filter(s => showHidden ? true : !s.hidden)
    .filter(s => schemeMatchesQuery(getEffective(s.id)));
  visibleSchemes.forEach(s => selectedIds.add(s.id));
  updateBulkBar();
  render();
});

bulkDeselectAllBtn.addEventListener('click', () => {
  exitSelectionMode();
});

bulkDeleteBtn.addEventListener('click', () => {
  if (!confirm(`Hide ${selectedIds.size} card(s)?`)) return;
  for (const id of selectedIds) {
    stageChange(id, { hidden: true });
  }
  exitSelectionMode();
  showToast('Cards hidden (pending)');
});

// Hide and duplicate live only here now — selection mode is the single
// surface for both, even when just one card is selected.
bulkDuplicateBtn.addEventListener('click', () => {
  const count = selectedIds.size;
  for (const id of selectedIds) {
    duplicateScheme(id);
  }
  exitSelectionMode();
  showToast(`${count} card${count !== 1 ? 's' : ''} duplicated (pending)`);
});

// ========== Bulk Fields Modal ==========
let bulkFieldRowIndex = 0;

function addBulkFieldRow(key = '') {
  const idx = bulkFieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row';
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Field name" value="${esc(key)}" list="bulkFieldKeySuggestions" />
    <button class="remove-field" type="button">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => row.remove());
  initDragHandle(row);
  bulkDynamicFields.appendChild(row);
}

function addBulkLinkRow(label = '', value = '') {
  const idx = bulkFieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row link-row';
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Link label (e.g. Feeds)" value="${esc(label ? '→ ' + label : '')}" list="linkLabelSuggestions" />
    <div class="link-editor">
      <span class="link-chips"></span>
      <input type="text" class="link-entry" placeholder="Add scheme…" autocomplete="off" />
      <input type="hidden" class="field-value-input" value="${escAttr(value)}" />
    </div>
    <button class="remove-field" type="button">&times;</button>
  `;
  initLinkEditor(row, value);
  row.querySelector('.remove-field').addEventListener('click', () => row.remove());
  initDragHandle(row);
  bulkDynamicFields.appendChild(row);
}

function addBulkTagRow(label = '', value = '') {
  const idx = bulkFieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row tag-row';
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <span class="row-type-icon" aria-hidden="true">🏷️</span>
    <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Tag name" value="${esc(label)}" list="tagNameSuggestions" />
    <input type="text" class="field-value-input" name="bulk_field_value_${idx}" placeholder="Value (optional)" value="${esc(value)}" />
    <button class="remove-field" type="button">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => row.remove());
  initDragHandle(row);
  bulkDynamicFields.appendChild(row);
}

let bulkGroupRowIndex = 0;

function addBulkGroupRow(name = '') {
  const idx = bulkGroupRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-group-row';
  row.innerHTML = `
    <span class="drag-handle" draggable="true">⠿</span>
    <span class="group-icon">📁</span>
    <input type="text" class="group-name-input" name="bulk_group_name_${idx}" placeholder="Group name" value="${esc(name)}" />
    <button class="remove-field" type="button" title="Remove group">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => row.remove());
  initDragHandle(row);
  bulkDynamicFields.appendChild(row);
}

function updateBulkFieldSuggestions() {
  const keys = getUniqueFieldKeys().filter(k => !isTagKey(k));
  const datalist = document.getElementById('bulkFieldKeySuggestions');
  datalist.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
}

function openBulkModal() {
  bulkModalTitle.textContent = 'Add/Edit Fields';
  bulkModalDesc.textContent = `Apply fields to ${selectedIds.size} selected card(s). Existing fields with the same name will be overwritten.`;
  bulkDynamicFields.innerHTML = '';
  bulkFieldRowIndex = 0;
  bulkGroupRowIndex = 0;
  updateBulkFieldSuggestions();
  addBulkFieldRow('', '');
  bulkBatchChips.innerHTML = [...selectedIds]
    .map(id => {
      const e = getEffective(id);
      return `<span class="bulk-chip">${esc(e ? e.name : '(unknown)')}</span>`;
    })
    .join('');
  bulkStep1.classList.remove('hidden');
  bulkStep2.classList.add('hidden');
  bulkModalNext.classList.remove('hidden');
  bulkModalBack.classList.add('hidden');
  bulkModalSave.classList.add('hidden');
  bulkModal.classList.remove('hidden');
}

function closeBulkModal() {
  bulkModal.classList.add('hidden');
}

bulkFieldsBtn.addEventListener('click', openBulkModal);
bulkModalClose.addEventListener('click', closeBulkModal);
bulkModalCancel.addEventListener('click', closeBulkModal);
bulkModal.addEventListener('click', e => {
  if (e.target === bulkModal) closeBulkModal();
});
bulkAddFieldBtn.addEventListener('click', () => addBulkFieldRow('', ''));
bulkAddGroupBtn.addEventListener('click', () => addBulkGroupRow(''));
bulkAddLinkBtn.addEventListener('click', () => addBulkLinkRow('', ''));
bulkAddTagBtn.addEventListener('click', () => addBulkTagRow('', ''));

bulkModalNext.addEventListener('click', () => {
  const { rows, groups } = parseFieldRows(bulkDynamicFields);
  const fieldKeys = rows.map(r => r.key);
  const groupsData = groups.map(g => ({ name: g.name, fields: g.fieldKeys }));

  if (fieldKeys.length === 0) {
    alert('Add at least one field first.');
    return;
  }

  const affected = [];
  for (const id of selectedIds) {
    const e = getEffective(id);
    if (!e || !e.fields) continue;
    for (const k of fieldKeys) {
      if (e.fields[k] !== undefined && e.fields[k] !== '') {
        affected.push({ scheme: e.name, field: k, value: e.fields[k] });
      }
    }
  }
  if (affected.length > 0) {
    const sample = affected.slice(0, 6).map(a => `• ${a.scheme} → "${a.field}" = "${a.value}"`).join('\n');
    const extra = affected.length > 6 ? `\n…and ${affected.length - 6} more.` : '';
    const ok = confirm(
      `${affected.length} existing field value(s) will be OVERWRITTEN:\n\n${sample}${extra}\n\n` +
      `Entering a field name that already exists updates that field's values instead of adding a new one. Continue?`
    );
    if (!ok) return;
  }

  const schemeIds = [...selectedIds];
  bulkStep2Title.textContent = 'Enter values per scheme';
  bulkStep2Desc.innerHTML = `${schemeIds.length} card${schemeIds.length === 1 ? '' : 's'} in this batch. Leave a cell blank for null. <strong>Tab</strong> / <strong>arrow keys</strong> to navigate.`;

  let gridHtml = '<table class="bulk-grid-table"><thead><tr><th class="bulk-grid-scheme-col">Scheme</th>';
  fieldKeys.forEach(k => gridHtml += `<th>${esc(k)}</th>`);
  gridHtml += '</tr></thead><tbody>';

  schemeIds.forEach((id, si) => {
    const e = getEffective(id);
    gridHtml += `<tr data-scheme-id="${esc(id)}">`;
    gridHtml += `<td class="bulk-grid-scheme-col"><span class="bulk-scheme-marker">▸</span><strong class="bulk-scheme-name">${esc(e ? e.name : '(unknown)')}</strong></td>`;
    fieldKeys.forEach((k, fi) => {
      const existing = e && e.fields ? (e.fields[k] || '') : '';
      const hasExisting = e && e.fields && e.fields[k] !== undefined && e.fields[k] !== '';
      gridHtml += `<td><input type="text" class="bulk-grid-cell${hasExisting ? ' bulk-cell-existing' : ''}" data-fi="${fi}" data-si="${si}" value="${esc(existing)}"${hasExisting ? ` title="Existing value: ${esc(existing)}"` : ''} /></td>`;
    });
    gridHtml += '</tr>';
  });
  gridHtml += '</tbody></table>';

  bulkGrid.innerHTML = gridHtml;
  bulkStep1.classList.add('hidden');
  bulkStep2.classList.remove('hidden');
  bulkModalNext.classList.add('hidden');
  bulkModalBack.classList.remove('hidden');
  bulkModalSave.classList.remove('hidden');

  bulkGrid.querySelectorAll('.bulk-grid-cell').forEach(cell => {
    cell.addEventListener('focus', () => {
      bulkGrid.querySelectorAll('tr.bulk-row-active').forEach(tr => tr.classList.remove('bulk-row-active'));
      cell.closest('tr').classList.add('bulk-row-active');
    });
    cell.addEventListener('keydown', e => {
      const fi = parseInt(cell.dataset.fi);
      const si = parseInt(cell.dataset.si);
      const rowLen = fieldKeys.length;
      const colLen = schemeIds.length;
      let target = null;

      switch (e.key) {
        case 'ArrowRight': if (fi < rowLen - 1) target = bulkGrid.querySelector(`.bulk-grid-cell[data-si="${si}"][data-fi="${fi + 1}"]`); break;
        case 'ArrowLeft': if (fi > 0) target = bulkGrid.querySelector(`.bulk-grid-cell[data-si="${si}"][data-fi="${fi - 1}"]`); break;
        case 'ArrowDown': case 'Enter': if (si < colLen - 1) target = bulkGrid.querySelector(`.bulk-grid-cell[data-si="${si + 1}"][data-fi="${fi}"]`); break;
        case 'ArrowUp': if (si > 0) target = bulkGrid.querySelector(`.bulk-grid-cell[data-si="${si - 1}"][data-fi="${fi}"]`); break;
      }

      if (target) {
        e.preventDefault();
        target.focus();
        target.select();
      }
    });
  });

  const first = bulkGrid.querySelector('.bulk-grid-cell');
  if (first) setTimeout(() => first.focus(), 100);
});

bulkModalBack.addEventListener('click', () => {
  bulkStep1.classList.remove('hidden');
  bulkStep2.classList.add('hidden');
  bulkModalNext.classList.remove('hidden');
  bulkModalBack.classList.add('hidden');
  bulkModalSave.classList.add('hidden');
});

bulkModalSave.addEventListener('click', () => {
  const { rows, groups } = parseFieldRows(bulkDynamicFields);
  const fieldKeys = rows.map(r => r.key);
  const groupsData = groups.map(g => ({ name: g.name, fields: g.fieldKeys }));

  bulkGrid.querySelectorAll('tr[data-scheme-id]').forEach(tr => {
    const id = tr.dataset.schemeId;
    const e = getEffective(id);
    if (!e) return;

    const fields = { ...(e.fields || {}) };
    let changed = false;

    tr.querySelectorAll('.bulk-grid-cell').forEach(cell => {
      const fi = parseInt(cell.dataset.fi);
      const key = fieldKeys[fi];
      if (key === undefined) return;
      fields[key] = cell.value.trim();
      changed = true;
    });

    if (changed) {
      const mergedGroups = groupsData.length > 0
        ? [...(e.groups || []), ...groupsData]
        : (e.groups || []);
      stageChange(id, { fields, groups: mergedGroups });
    }
  });

  exitSelectionMode();
  closeBulkModal();
  showToast(`Fields staged for ${selectedIds.size} card(s)`);
});

// ========== Commit / Discard ==========
// When a scheme is renamed, every → link naming it would go stale. Rewrite
// the old name in all other schemes' link fields (base records and any
// staged changes) so references survive the rename.
async function propagateRenames() {
  for (const [id, changes] of pendingChanges) {
    if (isNewId(id) || !changes.name) continue;
    const base = findScheme(id);
    if (!base || !base.name || base.name.trim() === changes.name.trim()) continue;
    const oldName = base.name.trim().toLowerCase();
    const newName = changes.name.trim();
    if (!oldName) continue;

    for (const s of schemes) {
      if (String(s.id) === String(base.id)) continue;
      const staged = pendingChanges.get(s.id);
      // Mirror commit()'s merge: staged dicts win, otherwise base. Both
      // visible and hidden link fields must be rewritten.
      const rewrite = source => {
        const dict = { ...source };
        let changed = false;
        Object.keys(dict).forEach(k => {
          if (!isLinkKey(k)) return;
          const parts = parseLinkTargets(dict[k]);
          const next = parts.map(p => (p.toLowerCase() === oldName ? newName : p));
          if (next.some((p, i) => p !== parts[i])) {
            dict[k] = next.join(', ');
            changed = true;
          }
        });
        return { dict, changed };
      };

      const effFields = (staged && staged.fields) || getEffective(s.id).fields || {};
      const effHidden = (staged && staged.hiddenFields) || getEffective(s.id).hiddenFields || {};
      const fieldsRes = rewrite(effFields);
      const hiddenRes = rewrite(effHidden);
      if (!fieldsRes.changed && !hiddenRes.changed) continue;

      if (staged) {
        // Its own commit will persist the rewritten dicts.
        if (staged.fields || fieldsRes.changed) staged.fields = fieldsRes.dict;
        if (staged.hiddenFields || hiddenRes.changed) staged.hiddenFields = hiddenRes.dict;
      } else {
        const target = findScheme(s.id);
        target.fields = fieldsRes.dict;
        target.hiddenFields = hiddenRes.dict;
        await dbUpdate({ ...target });
      }
    }
  }
}

commitBtn.addEventListener('click', async () => {
  await propagateRenames();
  const count = pendingChanges.size;
  let committed = 0;
  for (const [id, changes] of pendingChanges) {
    const isNew = isNewId(id);
    if (isNew) {
      const { id: _discard, ...schemeData } = { id: 0, ...getEffective(id) };
      delete schemeData.id;
      const newId = await dbAdd(schemeData);
      committed++;
    } else {
      const base = findScheme(id);
      if (!base) continue;
      const merged = { ...base, ...changes };
      await dbUpdate(merged);
      committed++;
    }
  }
  pendingChanges.clear();
  await loadSchemes();
  exitSelectionMode();
  showToast(`${committed} change${committed !== 1 ? 's' : ''} committed`);
});

discardBtn.addEventListener('click', () => {
  if (!confirm(`Discard ${pendingChanges.size} pending change(s)?`)) return;
  // Remove any new (unsaved) schemes from the in-memory list
  for (const id of pendingChanges.keys()) {
    if (isNewId(id)) {
      schemes = schemes.filter(s => s.id !== id);
    }
  }
  pendingChanges.clear();
  render();
  showToast('Changes discarded');
});

// ========== Pivot Table ==========
function getFieldKeys() {
  const keys = new Set();
  schemes.filter(s => showHidden ? true : !s.hidden).forEach(s => {
    const e = getEffective(s.id);
    Object.keys(e.fields || {}).forEach(k => keys.add(k));
  });
  return ['Card Name', ...Array.from(keys)];
}

function renderCheckList(container, keys, checkedKeys = []) {
  container.innerHTML = keys.map(k => `
    <label class="pivot-check-item">
      <input type="checkbox" value="${esc(k)}" ${checkedKeys.includes(k) ? 'checked' : ''}>
      <span>${esc(k)}</span>
    </label>
  `).join('');
}

function getCheckedValues(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
}

function openPivotModal() {
  const keys = getFieldKeys();
  renderCheckList(pivotRows, keys, ['Card Name']);
  renderCheckList(pivotCols, keys, []);
  pivotValues.innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  pivotResult.innerHTML = '';
  pivotExportBar.classList.add('hidden');
  pivotModal.classList.remove('hidden');
}

pivotBtn.addEventListener('click', openPivotModal);
pivotModalClose.addEventListener('click', () => pivotModal.classList.add('hidden'));
pivotModal.addEventListener('click', e => {
  if (e.target === pivotModal) pivotModal.classList.add('hidden');
});

pivotModal.addEventListener('click', e => {
  const btn = e.target.closest('.check-all-btn, .check-none-btn');
  if (!btn) return;
  const targetId = btn.dataset.target;
  const container = document.getElementById(targetId);
  if (!container) return;
  const check = btn.classList.contains('check-all-btn');
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = check);
});

function getFieldValue(scheme, fieldKey) {
  if (fieldKey === 'Card Name') return scheme.name;
  return scheme.fields ? scheme.fields[fieldKey] : undefined;
}

// Pure aggregation: buckets records into pivotMap (count/sum/comma) plus
// incremental sum/count maps used for avg. O(n), single pass over records.
function aggregateRecords(records, agg) {
  const pivotMap = new Map();
  const sumMap = new Map();
  const countMap = new Map();
  const isComma = agg === 'comma' || agg === 'comma-distinct';

  records.forEach(r => {
    const k = r.rowKey + '||' + r.colKey;
    if (isComma) {
      const str = String(r.rawVal ?? '');
      if (!str) return;
      if (!pivotMap.has(k)) pivotMap.set(k, []);
      const arr = pivotMap.get(k);
      if (agg === 'comma-distinct' ? !arr.includes(str) : true) arr.push(str);
      return;
    }
    if (agg === 'avg') {
      sumMap.set(k, (sumMap.get(k) || 0) + (isNaN(Number(r.rawVal)) ? 0 : Number(r.rawVal)));
      countMap.set(k, (countMap.get(k) || 0) + 1);
      return;
    }
    const num = agg === 'count' ? 1 : (isNaN(Number(r.rawVal)) ? 0 : Number(r.rawVal));
    pivotMap.set(k, (pivotMap.get(k) || 0) + num);
  });

  return { pivotMap, sumMap, countMap };
}

generatePivotBtn.addEventListener('click', () => {
  const rowKeys = getCheckedValues(pivotRows);
  const colKeys = getCheckedValues(pivotCols);
  const valKey = pivotValues.value;
  const agg = pivotAgg.value;
  const format = pivotFormat.value;
  const isComma = agg === 'comma' || agg === 'comma-distinct';

  if (!rowKeys.length && !colKeys.length) {
    alert('Select at least one row or column field.');
    return;
  }

  const filtered = schemes.filter(s => {
    const e = getEffective(s.id);
    return (showHidden ? true : !e.hidden) &&
      e.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  // Build flat records: [{ rowKey, colKey, rawVal, rowParts, colParts }]
  const records = [];
  filtered.forEach(s => {
    const e = getEffective(s.id);
    const rowParts = rowKeys.map(k => String(getFieldValue(e, k) ?? '(blank)'));
    const colParts = colKeys.map(k => String(getFieldValue(e, k) ?? '(blank)'));
    const rawVal = getFieldValue(e, valKey);
    const rowKey = rowKeys.length ? rowParts.join('|') : '__total__';
    const colKey = colKeys.length ? colParts.join('|') : '__total__';
    records.push({ rowKey, colKey, rawVal, rowParts, colParts });
  });

  // Aggregate records into per-cell buckets: sum/count/avg/comma handled once here
  const { pivotMap, sumMap, countMap } = aggregateRecords(records, agg);

  // Unique row / column labels
  const rowSet = new Set(records.map(r => r.rowKey));
  const colSet = new Set(records.map(r => r.colKey));
  const rowLabels = [...rowSet].sort();
  const colLabels = [...colSet].filter(c => c !== '__total__').sort();
  const totalLabel = '__total__';

  // Helper: get aggregated value for a (rowKey, colKey) pair
  function getVal(rowKey, colKey) {
    const v = pivotMap.get(rowKey + '||' + colKey);
    if (v === undefined) return isComma ? '' : 0;
    if (isComma) return esc(v.join(', '));
    return v;
  }

  // For avg aggregation, average was accumulated incrementally during aggregation
  function getAvg(rowKey, colKey) {
    const k = rowKey + '||' + colKey;
    const sum = sumMap.get(k);
    if (sum === undefined) return 0;
    return (sum / countMap.get(k)).toFixed(2);
  }

  function cellVal(rowKey, colKey) {
    return agg === 'avg' ? getAvg(rowKey, colKey) : getVal(rowKey, colKey);
  }

  function displayParts(parts) {
    return parts.join(' / ');
  }

  // ========== Long format ==========
  if (format === 'long') {
    let html = '<table class="pivot-table"><thead><tr>';
    rowKeys.forEach(k => html += `<th>${esc(k)}</th>`);
    colKeys.forEach(k => html += `<th>${esc(k)}</th>`);
    html += '</tr></thead><tbody>';

    records.forEach(r => {
      html += '<tr>';
      r.rowParts.forEach(p => html += `<td>${esc(p)}</td>`);
      r.colParts.forEach(p => html += `<td>${esc(p)}</td>`);
      html += '</tr>';
    });

    html += '</tbody></table>';
    pivotResult.innerHTML = filtered.length === 0 ? '<p>No data to display.</p>' : html;
    pivotExportBar.classList.toggle('hidden', filtered.length === 0);
    return;
  }

  // ========== Wide format (cross-tab) ==========
  const showTotals = colLabels.length > 1 && !isComma;
  const colHeaders = showTotals ? [...colLabels, 'Total'] : colLabels;

  let html = '<table class="pivot-table"><thead><tr><th>' +
    (rowKeys.length ? rowKeys.join(' / ') : 'Total') +
    '</th>';

  colHeaders.forEach(l => {
    html += `<th>${esc(displayParts(l.split('|')))}</th>`;
  });
  html += '</tr></thead><tbody>';

  rowLabels.forEach(r => {
    if (r === totalLabel) return;
    html += `<tr><td><strong>${esc(displayParts(r.split('|')))}</strong></td>`;
    let rowTotal = 0;
    colLabels.forEach(c => {
      const val = cellVal(r, c);
      html += `<td>${val}</td>`;
      if (!isComma) rowTotal += Number(val);
    });
    if (showTotals) html += `<td>${rowTotal}</td>`;
    html += '</tr>';
  });

  // Totals row
  if (rowLabels.filter(r => r !== totalLabel).length > 1 && showTotals) {
    html += '<tr><td><strong>Total</strong></td>';
    colLabels.forEach(c => {
      let colTotal = 0;
      rowLabels.forEach(r => {
        if (r === totalLabel) return;
        colTotal += Number(cellVal(r, c));
      });
      html += `<td>${colTotal}</td>`;
    });
    let grandTotal = 0;
    rowLabels.forEach(r => {
      if (r === totalLabel) return;
      colLabels.forEach(c => {
        grandTotal += Number(cellVal(r, c));
      });
    });
    html += `<td>${grandTotal}</td></tr>`;
  }

  html += '</tbody></table>';

  pivotResult.innerHTML = filtered.length === 0 ? '<p>No data to display.</p>' : html;
  pivotExportBar.classList.toggle('hidden', filtered.length === 0);
});

exportCsvBtn.addEventListener('click', () => {
  const table = pivotResult.querySelector('table');
  if (!table) return;

  const rows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const cells = [];
    tr.querySelectorAll('th, td').forEach(td => {
      let text = td.textContent.trim();
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        text = '"' + text.replace(/"/g, '""') + '"';
      }
      cells.push(text);
    });
    rows.push(cells);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, 'table.csv');
  showPivotToast('✓ CSV downloaded');
});

copyTableBtn.addEventListener('click', () => {
  const table = pivotResult.querySelector('table');
  if (!table) return;

  let htmlOut = '<table>';
  let tsvRows = [];
  table.querySelectorAll('tr').forEach(tr => {
    const tsvCells = [];
    const tds = tr.querySelectorAll('th, td');
    htmlOut += '<tr>';
    tds.forEach(td => {
      const text = td.textContent.trim();
      tsvCells.push(text);
      htmlOut += `<td>${esc(text)}</td>`;
    });
    htmlOut += '</tr>';
    tsvRows.push(tsvCells.join('\t'));
  });
  htmlOut += '</table>';

  const htmlBlob = new Blob([htmlOut], { type: 'text/html' });
  const tsvBlob = new Blob([tsvRows.join('\n')], { type: 'text/plain' });
  const item = new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': tsvBlob });
  navigator.clipboard.write([item]);
  showPivotToast('✓ Copied to clipboard');
});

// ========== Import / Export ==========
function exportJSON() {
  const data = schemes.map(s => toExportShape(getEffective(s.id)));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `schemes-${new Date().toISOString().slice(0, 10)}.json`);
  showToast('Data exported');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data) || !data.every(s => s.name)) {
        alert('Invalid format: expected an array of objects with at least a "name" property.');
        return;
      }
      const mode = confirm('Click OK to replace all data, or Cancel to append to existing data.');
      if (mode) {
        await dbClear();
      }
      for (const s of data) {
        await dbAdd(normalizeScheme(s));
      }
      await loadSchemes();
      showToast(`Imported ${data.length} card${data.length !== 1 ? 's' : ''}`);
    } catch (err) {
      alert('Failed to parse JSON file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ========== Data Menu ==========
function openDataMenuModal() {
  const connected = !!window._gdriveToken;

  if (connected) {
    driveStatusText.textContent = 'Connected to Google Drive';
    driveStatusSub.textContent = '';
    driveConnectLabel.textContent = 'Disconnect from Google';
    driveConnectIcon.textContent = '🔌';
    driveConnectDesc.textContent = 'Click to sign out';
    driveConnectDesc.style.opacity = '1';
  } else {
    driveStatusText.textContent = 'Not connected to Google Drive';
    driveStatusSub.textContent = 'Click Sign in to authorize with Google Drive';
    driveConnectLabel.textContent = 'Sign in with Google';
    driveConnectIcon.textContent = '🔗';
    driveConnectDesc.textContent = 'Redirects to Google to authorize this app';
    driveConnectDesc.style.opacity = '1';
  }

  dataDrivePull.disabled = !connected;
  dataDrivePush.disabled = !connected;
  dataMenuModal.classList.remove('hidden');
}

function closeDataMenuModal() {
  dataMenuModal.classList.add('hidden');
}

dataMenuBtn.addEventListener('click', openDataMenuModal);
dataMenuClose.addEventListener('click', closeDataMenuModal);
dataMenuModal.addEventListener('click', e => {
  if (e.target === dataMenuModal) closeDataMenuModal();
});

dataImportLocal.addEventListener('click', () => {
  closeDataMenuModal();
  importFileInput.click();
});

dataExportLocal.addEventListener('click', () => {
  closeDataMenuModal();
  exportJSON();
});

importFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) importJSON(file);
  importFileInput.value = '';
});

// ========== Google Drive OAuth ==========
window._gdriveToken = localStorage.getItem('gdrive_token') || null;
window._gdriveTokenExpiry = parseInt(localStorage.getItem('gdrive_token_expiry') || '0', 10);

function saveDriveToken(token, expiresIn) {
  window._gdriveToken = token;
  window._gdriveTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  localStorage.setItem('gdrive_token', token);
  localStorage.setItem('gdrive_token_expiry', String(window._gdriveTokenExpiry));
}

function clearDriveToken() {
  window._gdriveToken = null;
  window._gdriveTokenExpiry = 0;
  localStorage.removeItem('gdrive_token');
  localStorage.removeItem('gdrive_token_expiry');
}

const _driveClientIdB64 = 'MTA2NzA3NTQ5NTIwMC1wMGhhdXJuanRwMzJvZm51YWVuNzQ5NzBybDN1OHY1di5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==';
function getDriveClientId() { return atob(_driveClientIdB64); }

function getRedirectUri() {
  return window.location.origin + window.location.pathname;
}

function oauthSignIn() {
  const clientId = getDriveClientId();

  const form = document.createElement('form');
  form.setAttribute('method', 'GET');
  form.setAttribute('action', 'https://accounts.google.com/o/oauth2/v2/auth');

  const params = {
    'client_id': clientId,
    'redirect_uri': getRedirectUri(),
    'response_type': 'token',
    'scope': 'https://www.googleapis.com/auth/drive.file',
    'include_granted_scopes': 'true',
    'prompt': 'consent'
  };

  for (const p in params) {
    const input = document.createElement('input');
    input.setAttribute('type', 'hidden');
    input.setAttribute('name', p);
    input.setAttribute('value', params[p]);
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

function extractTokenFromHash() {
  const hash = window.location.hash;
  if (!hash || !hash.includes('access_token')) return;
  const params = new URLSearchParams(hash.substring(1));
  const token = params.get('access_token');
  const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
  if (token) {
    saveDriveToken(token, expiresIn);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

dataDriveConnect.addEventListener('click', () => {
  if (window._gdriveToken) {
    clearDriveToken();
    showToast('Disconnected from Drive');
    openDataMenuModal();
    return;
  }
  oauthSignIn();
});

function ensureDriveToken() {
  if (!window._gdriveToken || Date.now() >= window._gdriveTokenExpiry) {
    showToast('Not connected to Drive');
    return false;
  }
  return true;
}

const DRIVE_BACKUP_FOLDER = 'MAK-Projects/Scheme-DB-Dashboard';
const DRIVE_BACKUP_FILE = 'scheme-database-backup.json';

async function driveGetOrCreateFolder(path) {
  const parts = path.split('/').filter(Boolean);
  let parentId = 'root';
  for (const part of parts) {
    const q = encodeURIComponent(`name='${part}' and '${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
      headers: { Authorization: 'Bearer ' + window._gdriveToken }
    });
    if (!res.ok) throw new Error('Drive folder lookup failed: ' + res.status);
    const files = (await res.json()).files || [];
    if (files.length > 0) {
      parentId = files[0].id;
    } else {
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + window._gdriveToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: part, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
      });
      if (!createRes.ok) throw new Error('Drive folder create failed: ' + createRes.status);
      parentId = (await createRes.json()).id;
    }
  }
  return parentId;
}

async function driveListFiles(name, parentId) {
  let q = `name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)`, {
    headers: { Authorization: 'Bearer ' + window._gdriveToken }
  });
  if (!res.ok) throw new Error('Drive list failed: ' + res.status);
  return (await res.json()).files || [];
}

async function driveUpload(name, data, parentId) {
  const files = await driveListFiles(name, parentId);
  const metadata = { name, mimeType: 'application/json' };
  if (parentId) metadata.parents = [parentId];
  const body = JSON.stringify(data);

  if (files.length > 0) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + window._gdriveToken, 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) throw new Error('Drive update failed: ' + res.status);
    showToast('Updated existing file on Drive');
  } else {
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + window._gdriveToken },
      body: (() => {
        const mp = new FormData();
        mp.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        mp.append('file', new Blob([body], { type: 'application/json' }), name);
        return mp;
      })()
    });
    if (!res.ok) throw new Error('Drive create failed: ' + res.status);
    showToast('Created backup on Drive');
  }
}

async function driveDownload(name, parentId) {
  const files = await driveListFiles(name, parentId);
  if (files.length === 0) throw new Error('No backup found on Drive');
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`, {
    headers: { Authorization: 'Bearer ' + window._gdriveToken }
  });
  if (!res.ok) throw new Error('Drive download failed: ' + res.status);
  return await res.json();
}

dataDrivePush.addEventListener('click', async () => {
  if (!ensureDriveToken()) return;
  closeDataMenuModal();
  try {
    const data = schemes.map(s => toExportShape(getEffective(s.id)));
    const folderId = await driveGetOrCreateFolder(DRIVE_BACKUP_FOLDER);
    await driveUpload(DRIVE_BACKUP_FILE, data, folderId);
    showToast('Synced to Google Drive');
  } catch (err) {
    console.error(err);
    showToast('Sync failed: ' + err.message);
  }
});

dataDrivePull.addEventListener('click', async () => {
  if (!ensureDriveToken()) return;
  closeDataMenuModal();
  try {
    const folderId = await driveGetOrCreateFolder(DRIVE_BACKUP_FOLDER);
    const data = await driveDownload(DRIVE_BACKUP_FILE, folderId);
    if (!Array.isArray(data) || !data.every(s => s.name)) {
      alert('Invalid backup format on Drive.');
      return;
    }
    const mode = confirm('Click OK to replace all local data, or Cancel to append.');
    if (mode) await dbClear();
    for (const s of data) {
      await dbAdd(normalizeScheme(s));
    }
    await loadSchemes();
    showToast(`Synced ${data.length} card${data.length !== 1 ? 's' : ''} from Drive`);
  } catch (err) {
    console.error(err);
    showToast('Sync failed: ' + err.message);
  }
});

// ========== Click outside to exit selection ==========
document.addEventListener('click', e => {
  if (selectionMode && !e.target.closest('.card') && !e.target.closest('.bulk-action-bar') && !e.target.closest('.modal-overlay')) {
    exitSelectionMode();
  }
});

// ========== Init ==========
extractTokenFromHash();
loadSchemes();

// Keyboard shortcut: Ctrl+K focuses search, Escape exits
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    searchInput.focus();
  }
  if (e.key === 'Escape') {
    if (!schemeModal.classList.contains('hidden')) closeModal();
    else if (!pivotModal.classList.contains('hidden')) pivotModal.classList.add('hidden');
    else if (!detailModal.classList.contains('hidden')) closeDetailModal();
    else if (!bulkModal.classList.contains('hidden')) closeBulkModal();
    else if (!dataMenuModal.classList.contains('hidden')) closeDataMenuModal();
    else if (selectionMode) exitSelectionMode();
  }
});

// ========== Scroll Glow ==========
// Native scrollbars are hidden (see styles.css). In their place, a soft glow
// fades in from under the top and/or bottom edge of any scrollable area,
// only while there's actually more content in that direction, with a gentle
// pulse animation so it reads as "scroll for more" rather than a static line.
function initScrollGlow(el, threshold = 4) {
  if (!el || el._scrollGlowInit) return;
  el._scrollGlowInit = true;

  function update() {
    const canUp = el.scrollTop > threshold;
    const canDown = el.scrollTop < el.scrollHeight - el.clientHeight - threshold;
    el.classList.toggle('show-top-glow', canUp);
    el.classList.toggle('show-bottom-glow', canDown);
  }

  el.addEventListener('scroll', update, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(update).observe(el);
  if (window.MutationObserver) {
    new MutationObserver(update).observe(el, { childList: true, subtree: true, characterData: true });
  }
  update();
  return update;
}

// Jump button factory: click jumps ~80% page, hold for continuous scroll
function makeJumpBtn(dir, scrollEl, contextLabel) {
  const btn = document.createElement('button');
  btn.className = 'scroll-jump scroll-jump-' + dir;
  btn.textContent = dir === 'top' ? '↑' : '↓';
  btn.title = dir === 'top' ? 'Scroll to top' : 'Scroll to bottom';
  btn.setAttribute('aria-label', (dir === 'top' ? 'Scroll to top' : 'Scroll to bottom') + ' of ' + contextLabel);

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = prefersReduced ? 'instant' : 'smooth';

  let holdTimer = null;
  let holdInterval = null;
  const HOLD_DELAY = 300;
  const SCROLL_STEP = 30;

  function doScroll() {
    if (dir === 'top') scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.8, behavior: scrollBehavior });
    else scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.8, behavior: scrollBehavior });
  }

  function startHold() {
    holdTimer = setTimeout(() => {
      holdInterval = setInterval(() => {
        if (dir === 'top') scrollEl.scrollBy({ top: -SCROLL_STEP });
        else scrollEl.scrollBy({ top: SCROLL_STEP });
      }, 30);
      btn.classList.add('scroll-jump-active');
    }, HOLD_DELAY);
  }

  function stopHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
    btn.classList.remove('scroll-jump-active');
  }

  btn.addEventListener('click', e => { if (!holdTimer && !holdInterval) doScroll(); });
  btn.addEventListener('mousedown', startHold);
  btn.addEventListener('mouseup', stopHold);
  btn.addEventListener('mouseleave', stopHold);
  btn.addEventListener('touchstart', startHold, { passive: true });
  btn.addEventListener('touchend', stopHold);
  btn.addEventListener('touchcancel', stopHold);

  return btn;
}

// Modal jump buttons
['schemeModal', 'pivotModal', 'detailModal', 'dataMenuModal', 'bulkModal'].forEach(id => {
  const overlay = document.getElementById(id);
  const modalEl = overlay && overlay.querySelector('.modal');
  if (!modalEl) return;
  initScrollGlow(modalEl);
  overlay.appendChild(makeJumpBtn('top', modalEl, id === 'schemeModal' ? 'form' : id === 'pivotModal' ? 'table' : id === 'detailModal' ? 'details' : id === 'dataMenuModal' ? 'data menu' : 'bulk editor'));
  overlay.appendChild(makeJumpBtn('bottom', modalEl, id === 'schemeModal' ? 'form' : id === 'pivotModal' ? 'table' : id === 'detailModal' ? 'details' : id === 'dataMenuModal' ? 'data menu' : 'bulk editor'));
});

// Page-level jump buttons
const pageScrollEl = document.documentElement;
const pageUpBtn = makeJumpBtn('top', pageScrollEl, 'page');
pageUpBtn.classList.add('scroll-jump-page');
const pageDownBtn = makeJumpBtn('bottom', pageScrollEl, 'page');
pageDownBtn.classList.add('scroll-jump-page');
document.body.appendChild(pageUpBtn);
document.body.appendChild(pageDownBtn);

// Hide page jump buttons when any modal is open
['schemeModal', 'pivotModal', 'detailModal', 'dataMenuModal', 'bulkModal'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const obs = new MutationObserver(() => {
    const open = !el.classList.contains('hidden');
    pageUpBtn.classList.toggle('hidden', open);
    pageDownBtn.classList.toggle('hidden', open);
  });
  obs.observe(el, { attributes: true, attributeFilter: ['class'] });
});

// Page Up/Down / Home/End for the topmost open modal
document.addEventListener('keydown', e => {
  const modals = document.querySelectorAll('.modal-overlay:not(.hidden)');
  if (!modals.length) return;
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
  const modal = [...modals].pop().querySelector('.modal');
  if (!modal) return;
  switch (e.key) {
    case 'PageDown': modal.scrollBy({ top: modal.clientHeight * 0.8, behavior: 'smooth' }); e.preventDefault(); break;
    case 'PageUp': modal.scrollBy({ top: -modal.clientHeight * 0.8, behavior: 'smooth' }); e.preventDefault(); break;
    case 'Home': modal.scrollTo({ top: 0, behavior: 'smooth' }); e.preventDefault(); break;
    case 'End': modal.scrollTo({ top: modal.scrollHeight, behavior: 'smooth' }); e.preventDefault(); break;
  }
});

// Smaller internal scroll areas
initScrollGlow(pivotRows);
initScrollGlow(pivotCols);
initScrollGlow(copyPicklistBody);
initScrollGlow(document.getElementById('detailModalBody'));

// Page-level scroll (the main window/body scroll)
const pageGlowTop = document.createElement('div');
pageGlowTop.className = 'page-scroll-glow page-scroll-glow-top';
const pageGlowBottom = document.createElement('div');
pageGlowBottom.className = 'page-scroll-glow page-scroll-glow-bottom';
document.body.appendChild(pageGlowTop);
document.body.appendChild(pageGlowBottom);

function updatePageGlow() {
  const headerEl = document.querySelector('header');
  pageGlowTop.style.top = (headerEl ? headerEl.offsetHeight : 0) + 'px';
  const scrollEl = document.scrollingElement || document.documentElement;
  const canUp = scrollEl.scrollTop > 4;
  const canDown = scrollEl.scrollTop < scrollEl.scrollHeight - scrollEl.clientHeight - 4;
  pageGlowTop.classList.toggle('visible', canUp);
  pageGlowBottom.classList.toggle('visible', canDown);
}

window.addEventListener('scroll', updatePageGlow, { passive: true });
window.addEventListener('resize', updatePageGlow);
if (window.ResizeObserver) new ResizeObserver(updatePageGlow).observe(document.body);
updatePageGlow();
