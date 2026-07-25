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

function getEffective(id) {
  const base = schemes.find(s => s.id === id);
  if (!base) return null;
  if (pendingChanges.has(id)) {
    return { ...base, ...pendingChanges.get(id) };
  }
  return { ...base };
}

function stageChange(id, change) {
  const base = schemes.find(s => s.id === id);
  if (!base) return;
  const existing = pendingChanges.get(id) || {};
  pendingChanges.set(id, { ...existing, ...change });
  render();
}

function stageNewScheme(name, fields, hiddenFields) {
  const id = `_new_${++newSchemeCounter}`;
  schemes.push({ id, name, fields: fields || {}, hiddenFields: hiddenFields || {}, hidden: false, createdAt: new Date().toISOString() });
  pendingChanges.set(id, { name, fields: fields || {}, hiddenFields: hiddenFields || {} });
  render();
}

// ========== DOM refs ==========
const cardsContainer = document.getElementById('cardsContainer');
const emptyState = document.getElementById('emptyState');
const statsBar = document.getElementById('statsBar');
const searchInput = document.getElementById('searchInput');
const themeToggle = document.getElementById('themeToggle');
const addSchemeBtn = document.getElementById('addSchemeBtn');
const schemeModal = document.getElementById('schemeModal');
const modalTitle = document.getElementById('modalTitle');
const schemeNameInput = document.getElementById('schemeNameInput');
const dynamicFields = document.getElementById('dynamicFields');
const addFieldBtn = document.getElementById('addFieldBtn');
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
const driveClientIdSection = document.getElementById('driveClientIdSection');
const driveClientIdInput = document.getElementById('driveClientIdInput');
const driveClientIdSave = document.getElementById('driveClientIdSave');
const driveRedirectUri = document.getElementById('driveRedirectUri');
const importFileInput = document.getElementById('importFileInput');

// Bulk
const bulkActionBar = document.getElementById('bulkActionBar');
const bulkSelectedCount = document.getElementById('bulkSelectedCount');
const bulkSelectAllBtn = document.getElementById('bulkSelectAllBtn');
const bulkDeselectAllBtn = document.getElementById('bulkDeselectAllBtn');
const bulkFieldsBtn = document.getElementById('bulkFieldsBtn');
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const bulkModal = document.getElementById('bulkModal');
const bulkModalTitle = document.getElementById('bulkModalTitle');
const bulkModalDesc = document.getElementById('bulkModalDesc');
const bulkModalClose = document.getElementById('bulkModalClose');
const bulkDynamicFields = document.getElementById('bulkDynamicFields');
const bulkAddFieldBtn = document.getElementById('bulkAddFieldBtn');
const bulkModalCancel = document.getElementById('bulkModalCancel');
const bulkModalSave = document.getElementById('bulkModalSave');

// Pending
const pendingBar = document.getElementById('pendingBar');
const pendingCount = document.getElementById('pendingCount');
const commitBtn = document.getElementById('commitBtn');
const discardBtn = document.getElementById('discardBtn');

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
  const filtered = visibleSchemes.filter(s => {
    const e = getEffective(s.id);
    return e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      Object.entries(e.fields || {}).some(([k, v]) =>
        k.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(v).toLowerCase().includes(searchQuery.toLowerCase())
      );
  });

  const hiddenCount = schemes.filter(s => s.hidden).length;
  showHiddenCount.textContent = hiddenCount;
  showHiddenBtn.classList.toggle('active', showHidden);

  const pendingCount = schemes.filter(s => pendingChanges.has(s.id)).length;
  const newPending = [...pendingChanges.keys()].filter(k => typeof k === 'string').length;
  const totalPending = pendingCount + newPending;

  statsBar.textContent = `${filtered.length} of ${visibleSchemes.length} scheme${visibleSchemes.length !== 1 ? 's' : ''}${showHidden && hiddenCount ? ` (${hiddenCount} hidden)` : ''}${totalPending ? ` — ${totalPending} unsaved` : ''}`;

  updatePendingBar();

  if (filtered.length === 0) {
    cardsContainer.innerHTML = '';
    emptyState.style.display = 'flex';
    emptyState.querySelector('h2').textContent = visibleSchemes.length === 0
      ? 'No schemes yet'
      : 'No matching schemes';
    emptyState.querySelector('p').textContent = visibleSchemes.length === 0
      ? 'Click "Add Scheme" to create your first water supply scheme entry.'
      : 'Try a different search term.';
    return;
  }

  emptyState.style.display = 'none';

  cardsContainer.innerHTML = filtered.map(s => {
    const e = getEffective(s.id);
    const isPending = pendingChanges.has(s.id);
    const isNew = typeof s.id === 'string';
    const entries = Object.entries(e.fields || {});
    const maxPreview = 3;
    const previewEntries = entries.slice(0, maxPreview);
    const remaining = entries.length - maxPreview;

    const fieldsHtml = entries.length
      ? previewEntries.map(([k, v]) =>
          `<div class="card-field"><span class="field-key">${esc(k)}</span><span class="field-value">${esc(v)}</span></div>`
        ).join('')
      : '<div class="card-empty">No additional fields</div>';

    const viewMore = remaining > 0
      ? `<div class="card-view-more">View all ${entries.length} fields →</div>`
      : '';

    const hiddenBadge = e.hidden ? '<span class="card-hidden-badge">Hidden</span>' : '';
    const pendingBadge = isPending ? '<span class="card-pending-badge">Unsaved</span>' : '';

    const classes = ['card'];
    if (selectedIds.has(s.id)) classes.push('card-selected');
    if (e.hidden) classes.push('card-is-hidden');
    if (isPending) classes.push('card-has-pending');

    return `
      <div class="${classes.join(' ')}" data-id="${s.id}">
        <div class="card-header">
          <h3>${esc(e.name)}</h3>${hiddenBadge}${pendingBadge}
          <div class="card-actions">
            <button class="edit-btn" title="Edit">✏️</button>
            <button class="hide-btn" title="${e.hidden ? 'Unhide' : 'Hide'}">${e.hidden ? '👁️' : '🙈'}</button>
          </div>
        </div>
        <div class="card-body">${fieldsHtml}${viewMore}</div>
      </div>
    `;
  }).join('');

  // Re-bind card events
  cardsContainer.querySelectorAll('.card').forEach(card => {
    const id = card.dataset.id;
    const numId = Number(id);
    const schemeId = isNaN(numId) ? id : numId;

    card.querySelector('.edit-btn').addEventListener('click', e => { e.stopPropagation(); editScheme(schemeId); });
    card.querySelector('.hide-btn').addEventListener('click', e => { e.stopPropagation(); toggleHideScheme(schemeId); });
    card.querySelector('.card-view-more')?.addEventListener('click', () => openDetailModal(schemeId));

    // Long press to enter selection
    card.addEventListener('pointerdown', e => {
      if (e.target.closest('.card-actions')) return;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        enterSelectionMode(schemeId);
      }, LONG_PRESS_MS);
    });
    card.addEventListener('pointerup', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });
    card.addEventListener('pointerleave', () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });

    card.addEventListener('click', e => {
      if (e.target.closest('.card-actions')) return;
      if (selectionMode) {
        toggleSelect(schemeId);
      } else {
        openDetailModal(schemeId);
      }
    });
  });
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
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

function toggleHideScheme(id) {
  const current = getEffective(id);
  if (!current) return;
  stageChange(id, { hidden: !current.hidden });
  showToast(current.hidden ? 'Scheme unhidden (pending)' : 'Scheme hidden (pending)');
}

showHiddenBtn.addEventListener('click', () => {
  showHidden = !showHidden;
  exitSelectionMode();
});

// ========== Modal - Scheme ==========
let showHiddenFields = false;

function openModal(scheme = null) {
  editingId = scheme ? scheme.id : null;
  modalTitle.textContent = scheme ? 'Edit Scheme' : 'Add Scheme';
  schemeNameInput.value = scheme ? scheme.name : '';
  updateFieldSuggestions();
  dynamicFields.innerHTML = '';
  showHiddenFields = false;

  const entries = scheme ? Object.entries(scheme.fields || {}) : [];
  const hiddenEntries = scheme ? Object.entries(scheme.hiddenFields || {}) : [];

  if (entries.length === 0 && hiddenEntries.length === 0) {
    addFieldRow('', '');
  } else {
    entries.forEach(([k, v]) => addFieldRow(k, v, false));
    hiddenEntries.forEach(([k, v]) => addFieldRow(k, v, true));
  }

  renderHiddenFieldsToggle(hiddenEntries.length);
  schemeModal.classList.remove('hidden');
  setTimeout(() => schemeNameInput.focus(), 100);
}

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

function updateFieldSuggestions() {
  const keys = getUniqueFieldKeys();
  const datalist = document.getElementById('fieldKeySuggestions');
  datalist.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
}

let fieldRowIndex = 0;

function addFieldRow(key = '', value = '', isHidden = false) {
  const idx = fieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row';
  row.dataset.isHidden = isHidden ? 'true' : 'false';
  if (isHidden) row.classList.add('field-hidden');
  row.innerHTML = `
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
  dynamicFields.appendChild(row);
  updateHiddenFieldsCount();
}

function updateHiddenFieldsCount() {
  const hiddenCount = dynamicFields.querySelectorAll('.dynamic-field-row[data-is-hidden="true"]').length;
  if (editingId) renderHiddenFieldsToggle(hiddenCount);
}

function collectFieldData() {
  const name = schemeNameInput.value.trim();
  if (!name) {
    alert('Scheme name is required');
    return null;
  }
  const fields = {};
  const hiddenFields = {};
  dynamicFields.querySelectorAll('.dynamic-field-row').forEach(row => {
    const k = row.querySelector('.field-key-input').value.trim();
    const v = row.querySelector('.field-value-input').value.trim();
    if (!k) return;
    if (row.dataset.isHidden === 'true') {
      hiddenFields[k] = v;
    } else {
      fields[k] = v;
    }
  });
  return { name, fields, hiddenFields };
}

addSchemeBtn.addEventListener('click', () => openModal());
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
schemeModal.addEventListener('click', e => {
  if (e.target === schemeModal) closeModal();
});

addFieldBtn.addEventListener('click', () => addFieldRow('', ''));

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
    stageNewScheme(data.name, data.fields, data.hiddenFields);
    showToast('New scheme staged');
  }
  closeModal();
});

schemeNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') modalSave.click();
});

// ========== Detail Modal ==========
const detailModal = document.getElementById('detailModal');
const detailModalTitle = document.getElementById('detailModalTitle');
const detailModalBody = document.getElementById('detailModalBody');
const detailModalClose = document.getElementById('detailModalClose');
const detailModalCloseBtn = document.getElementById('detailModalCloseBtn');
const detailModalEdit = document.getElementById('detailModalEdit');
const detailSearchInput = document.getElementById('detailSearchInput');
const detailFieldCount = document.getElementById('detailFieldCount');

let detailSchemeId = null;
let detailEntries = [];

function renderDetailRows() {
  const query = detailSearchInput.value.toLowerCase();
  const filtered = query
    ? detailEntries.filter(([k, v]) => k.toLowerCase().includes(query) || String(v).toLowerCase().includes(query))
    : detailEntries;

  const rows = filtered.length
    ? filtered.map(([k, v]) =>
        `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`
      ).join('')
    : '<p class="detail-empty">No matching fields</p>';

  detailModalBody.innerHTML = rows;
  detailFieldCount.textContent = `${filtered.length} of ${detailEntries.length} field${detailEntries.length !== 1 ? 's' : ''}`;
}

function openDetailModal(id) {
  const scheme = getEffective(id);
  if (!scheme) return;
  detailSchemeId = id;
  detailModalTitle.textContent = esc(scheme.name);
  detailEntries = Object.entries(scheme.fields || {});
  detailSearchInput.value = '';
  renderDetailRows();
  detailModal.classList.remove('hidden');
  setTimeout(() => detailSearchInput.focus(), 100);
}

function closeDetailModal() {
  detailModal.classList.add('hidden');
  detailSchemeId = null;
  detailEntries = [];
}

detailSearchInput.addEventListener('input', renderDetailRows);

detailModalClose.addEventListener('click', closeDetailModal);
detailModalCloseBtn.addEventListener('click', closeDetailModal);
detailModal.addEventListener('click', e => {
  if (e.target === detailModal) closeDetailModal();
});
detailModalEdit.addEventListener('click', () => {
  if (detailSchemeId) editScheme(detailSchemeId);
  closeDetailModal();
});

// ========== Search ==========
searchInput.addEventListener('input', e => {
  searchQuery = e.target.value;
  render();
});

// ========== Bulk Operations ==========
bulkSelectAllBtn.addEventListener('click', () => {
  const visibleSchemes = schemes.filter(s => showHidden ? true : !s.hidden);
  visibleSchemes.forEach(s => selectedIds.add(s.id));
  updateBulkBar();
  render();
});

bulkDeselectAllBtn.addEventListener('click', () => {
  exitSelectionMode();
});

bulkDeleteBtn.addEventListener('click', () => {
  if (!confirm(`Hide ${selectedIds.size} scheme(s)?`)) return;
  for (const id of selectedIds) {
    stageChange(id, { hidden: true });
  }
  exitSelectionMode();
  showToast('Schemes hidden (pending)');
});

// ========== Bulk Fields Modal ==========
let bulkFieldRowIndex = 0;

function addBulkFieldRow(key = '', value = '') {
  const idx = bulkFieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row';
  row.innerHTML = `
    <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Field name" value="${esc(key)}" list="bulkFieldKeySuggestions" />
    <input type="text" class="field-value-input" name="bulk_field_value_${idx}" placeholder="Value" value="${esc(value)}" />
    <button class="remove-field" type="button">&times;</button>
  `;
  row.querySelector('.remove-field').addEventListener('click', () => row.remove());
  bulkDynamicFields.appendChild(row);
}

function updateBulkFieldSuggestions() {
  const keys = getUniqueFieldKeys();
  const datalist = document.getElementById('bulkFieldKeySuggestions');
  datalist.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
}

function openBulkModal() {
  bulkModalTitle.textContent = 'Add/Edit Fields';
  bulkModalDesc.textContent = `Apply fields to ${selectedIds.size} selected scheme(s). Existing fields with the same name will be overwritten.`;
  bulkDynamicFields.innerHTML = '';
  updateBulkFieldSuggestions();
  addBulkFieldRow('', '');
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

bulkModalSave.addEventListener('click', () => {
  const fields = {};
  bulkDynamicFields.querySelectorAll('.dynamic-field-row').forEach(row => {
    const k = row.querySelector('.field-key-input').value.trim();
    const v = row.querySelector('.field-value-input').value.trim();
    if (k) fields[k] = v;
  });

  if (Object.keys(fields).length === 0) {
    alert('Add at least one field.');
    return;
  }

  for (const id of selectedIds) {
    const current = getEffective(id);
    if (!current) continue;
    stageChange(id, { fields: { ...(current.fields || {}), ...fields } });
  }
  exitSelectionMode();
  closeBulkModal();
  showToast(`Fields staged for ${Object.keys(fields).length > 0 ? selectedIds.size : 0} scheme(s)`);
});

// ========== Commit / Discard ==========
commitBtn.addEventListener('click', async () => {
  const count = pendingChanges.size;
  let committed = 0;
  for (const [id, changes] of pendingChanges) {
    const isNew = typeof id === 'string';
    if (isNew) {
      const { id: _discard, ...schemeData } = { id: 0, ...getEffective(id) };
      delete schemeData.id;
      const newId = await dbAdd(schemeData);
      committed++;
    } else {
      const base = schemes.find(s => s.id === id);
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
    if (typeof id === 'string') {
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
  return ['Scheme Name', ...Array.from(keys)];
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

  renderCheckList(pivotRows, keys, ['Scheme Name']);
  renderCheckList(pivotCols, keys, []);
  pivotValues.innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  pivotResult.innerHTML = '';

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
  if (fieldKey === 'Scheme Name') return scheme.name;
  return scheme.fields ? scheme.fields[fieldKey] : undefined;
}

generatePivotBtn.addEventListener('click', () => {
  const rowKeys = getCheckedValues(pivotRows);
  const colKeys = getCheckedValues(pivotCols);
  const valKey = pivotValues.value;
  const agg = pivotAgg.value;

  if (!rowKeys.length && !colKeys.length) {
    alert('Select at least one row or column field.');
    return;
  }

  const filtered = schemes.filter(s => {
    const e = getEffective(s.id);
    return (showHidden ? true : !e.hidden) &&
      e.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const pivotMap = new Map();

  filtered.forEach(s => {
    const e = getEffective(s.id);
    const rowVal = rowKeys.map(k => String(getFieldValue(e, k) ?? '(blank)')).join('|');
    const colVal = colKeys.map(k => String(getFieldValue(e, k) ?? '(blank)')).join('|');
    const rawVal = getFieldValue(e, valKey);
    const numVal = agg === 'count' ? 1 : (isNaN(Number(rawVal)) ? 0 : Number(rawVal));

    const rowKey = rowKeys.length ? rowVal : '__total__';
    const colKey = colKeys.length ? colVal : '__total__';

    if (!pivotMap.has(rowKey)) pivotMap.set(rowKey, new Map());
    const rowMap = pivotMap.get(rowKey);
    rowMap.set(colKey, (rowMap.get(colKey) || 0) + numVal);
  });

  const rowLabels = Array.from(pivotMap.keys()).sort();
  const colLabels = new Set();
  pivotMap.forEach(m => m.forEach((_, c) => colLabels.add(c)));
  const colLabelsSorted = Array.from(colLabels).sort();
  const totalLabel = '__total__';

  if (colLabelsSorted.length > 1) colLabelsSorted.push('Total');

  let html = '<table class="pivot-table"><thead><tr><th>' +
    (rowKeys.length ? rowKeys.join(' / ') : 'Total') +
    '</th>';

  const displayColLabels = colLabelsSorted.filter(l => l !== totalLabel);
  displayColLabels.forEach(l => {
    const display = l.split('|').join(' / ');
    html += `<th>${esc(display)}</th>`;
  });
  if (displayColLabels.length > 1) html += '<th>Total</th>';
  html += '</tr></thead><tbody>';

  rowLabels.forEach(r => {
    if (r === totalLabel) return;
    const display = r.split('|').join(' / ');
    html += `<tr><td><strong>${esc(display)}</strong></td>`;
    let rowTotal = 0;
    displayColLabels.forEach(c => {
      let cellVal = 0;
      if (c === 'Total') {
        cellVal = rowTotal;
      } else {
        cellVal = pivotMap.get(r)?.get(c) ?? 0;
        rowTotal += cellVal;
      }
      html += `<td>${agg === 'avg' ? avgCellValue(filtered, rowKeys, colKeys, valKey, r, c) : cellVal}</td>`;
    });
    if (displayColLabels.length > 1) html += `<td>${rowTotal}</td>`;
    html += '</tr>';
  });

  if (rowLabels.length > 1) {
    html += '<tr><td><strong>Total</strong></td>';
    displayColLabels.forEach(c => {
      let colTotal = 0;
      rowLabels.forEach(r => {
        if (r === totalLabel) return;
        colTotal += pivotMap.get(r)?.get(c) ?? 0;
      });
      html += `<td>${colTotal}</td>`;
    });
    if (displayColLabels.length > 1) {
      let grandTotal = 0;
      rowLabels.forEach(r => {
        if (r === totalLabel) return;
        displayColLabels.forEach(c => {
          grandTotal += pivotMap.get(r)?.get(c) ?? 0;
        });
      });
      html += `<td>${grandTotal}</td>`;
    }
    html += '</tr>';
  }

  html += '</tbody></table>';

  if (filtered.length === 0) {
    pivotResult.innerHTML = '<p>No data to display.</p>';
  } else {
    pivotResult.innerHTML = html;
  }
});

function avgCellValue(schemesList, rowKeys, colKeys, valKey, rowVal, colVal) {
  const items = schemesList.filter(s => {
    const e = getEffective(s.id);
    const rv = rowKeys.map(k => String(getFieldValue(e, k) ?? '(blank)')).join('|');
    const cv = colKeys.map(k => String(getFieldValue(e, k) ?? '(blank)')).join('|');
    return rv === rowVal && cv === colVal;
  });
  if (!items.length) return 0;
  const sum = items.reduce((acc, s) => {
    const e = getEffective(s.id);
    const v = Number(getFieldValue(e, valKey));
    return acc + (isNaN(v) ? 0 : v);
  }, 0);
  return (sum / items.length).toFixed(2);
}

// ========== Import / Export ==========
function exportJSON() {
  const data = schemes.map(s => {
    const e = getEffective(s.id);
    return {
      name: e.name,
      fields: e.fields,
      hiddenFields: e.hiddenFields,
      hidden: e.hidden,
      createdAt: e.createdAt
    };
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `schemes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
        await dbAdd({
          name: s.name,
          fields: s.fields || {},
          hiddenFields: s.hiddenFields || {},
          hidden: s.hidden || false,
          createdAt: s.createdAt || new Date().toISOString()
        });
      }
      await loadSchemes();
      showToast(`Imported ${data.length} scheme${data.length !== 1 ? 's' : ''}`);
    } catch (err) {
      alert('Failed to parse JSON file: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ========== Data Menu ==========
function openDataMenuModal() {
  const clientId = getDriveClientId();
  const connected = !!window._gdriveToken;

  driveClientIdSection.classList.toggle('hidden', connected);
  driveClientIdInput.value = clientId;
  driveRedirectUri.textContent = getRedirectUri();

  if (connected) {
    driveStatusText.textContent = 'Connected to Google Drive';
    driveStatusSub.textContent = '';
    driveConnectLabel.textContent = 'Disconnect from Google';
    driveConnectIcon.textContent = '🔌';
    driveConnectDesc.textContent = 'Click to sign out';
    driveConnectDesc.style.opacity = '1';
  } else {
    driveStatusText.textContent = 'Not connected to Google Drive';
    driveStatusSub.textContent = clientId ? 'Client ID configured — click Sign in' : 'Enter your Client ID below, then sign in';
    driveConnectLabel.textContent = 'Sign in with Google';
    driveConnectIcon.textContent = '🔗';
    driveConnectDesc.textContent = clientId ? 'Redirects to Google to authorize this app' : 'Save a Client ID first';
    driveConnectDesc.style.opacity = clientId ? '1' : '0.5';
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
window._gdriveToken = null;
window._gdriveTokenExpiry = 0;

function getDriveClientId() {
  return localStorage.getItem('gdrive_client_id') || '';
}

function saveDriveClientId(id) {
  localStorage.setItem('gdrive_client_id', id.trim());
}

function getRedirectUri() {
  return window.location.origin + window.location.pathname;
}

driveClientIdSave.addEventListener('click', () => {
  const val = driveClientIdInput.value.trim();
  if (!val) { showToast('Enter a Client ID first'); return; }
  saveDriveClientId(val);
  showToast('Client ID saved');
  openDataMenuModal();
});

driveClientIdInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') driveClientIdSave.click();
});

function oauthSignIn() {
  var clientId = getDriveClientId();
  if (!clientId) { showToast('Save a Client ID first'); return; }

  var form = document.createElement('form');
  form.setAttribute('method', 'GET');
  form.setAttribute('action', 'https://accounts.google.com/o/oauth2/v2/auth');

  var params = {
    'client_id': clientId,
    'redirect_uri': getRedirectUri(),
    'response_type': 'token',
    'scope': 'https://www.googleapis.com/auth/drive.file',
    'include_granted_scopes': 'true',
    'prompt': 'consent'
  };

  for (var p in params) {
    var input = document.createElement('input');
    input.setAttribute('type', 'hidden');
    input.setAttribute('name', p);
    input.setAttribute('value', params[p]);
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

function extractTokenFromHash() {
  var hash = window.location.hash;
  if (!hash || !hash.includes('access_token')) return;
  var params = new URLSearchParams(hash.substring(1));
  var token = params.get('access_token');
  var expiresIn = parseInt(params.get('expires_in') || '3600', 10);
  if (token) {
    window._gdriveToken = token;
    window._gdriveTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

dataDriveConnect.addEventListener('click', () => {
  if (window._gdriveToken) {
    window._gdriveToken = null;
    window._gdriveTokenExpiry = 0;
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

async function driveListFiles(name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`, {
    headers: { Authorization: 'Bearer ' + window._gdriveToken }
  });
  if (!res.ok) throw new Error('Drive list failed: ' + res.status);
  return (await res.json()).files || [];
}

async function driveUpload(name, data) {
  const files = await driveListFiles(name);
  const metadata = { name, mimeType: 'application/json' };
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

async function driveDownload(name) {
  const files = await driveListFiles(name);
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
    const data = schemes.map(s => {
      const e = getEffective(s.id);
      return { name: e.name, fields: e.fields, hiddenFields: e.hiddenFields, hidden: e.hidden, createdAt: e.createdAt };
    });
    await driveUpload('scheme-database-backup.json', data);
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
    const data = await driveDownload('scheme-database-backup.json');
    if (!Array.isArray(data) || !data.every(s => s.name)) {
      alert('Invalid backup format on Drive.');
      return;
    }
    const mode = confirm('Click OK to replace all local data, or Cancel to append.');
    if (mode) await dbClear();
    for (const s of data) {
      await dbAdd({
        name: s.name,
        fields: s.fields || {},
        hiddenFields: s.hiddenFields || {},
        hidden: s.hidden || false,
        createdAt: s.createdAt || new Date().toISOString()
      });
    }
    await loadSchemes();
    showToast(`Synced ${data.length} scheme${data.length !== 1 ? 's' : ''} from Drive`);
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
