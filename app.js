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
  const numId = Number(id);
  const base = schemes.find(s => s.id === id || s.id === numId);
  if (!base) return null;
  const change = pendingChanges.get(id) || pendingChanges.get(numId) || pendingChanges.get(String(base.id));
  if (change) {
    return { ...base, ...change };
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

function stageNewScheme(name, fields, hiddenFields, groups) {
  const id = `_new_${++newSchemeCounter}`;
  schemes.push({ id, name, fields: fields || {}, hiddenFields: hiddenFields || {}, groups: groups || [], hidden: false, createdAt: new Date().toISOString() });
  pendingChanges.set(id, { name, fields: fields || {}, hiddenFields: hiddenFields || {}, groups: groups || [] });
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
const addGroupBtn = document.getElementById('addGroupBtn');
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

function showPivotToast(msg) {
  pivotToast.textContent = msg;
  pivotToast.classList.remove('hidden');
  clearTimeout(pivotToast._timer);
  pivotToast._timer = setTimeout(() => pivotToast.classList.add('hidden'), 2000);
}

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
const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
const bulkModal = document.getElementById('bulkModal');
const bulkModalTitle = document.getElementById('bulkModalTitle');
const bulkModalDesc = document.getElementById('bulkModalDesc');
const bulkModalClose = document.getElementById('bulkModalClose');
const bulkDynamicFields = document.getElementById('bulkDynamicFields');
const bulkAddFieldBtn = document.getElementById('bulkAddFieldBtn');
const bulkAddGroupBtn = document.getElementById('bulkAddGroupBtn');
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
          fieldsHtml += `<div class="card-field"><span class="field-key">${esc(k)}</span><span class="field-value">${esc(e.fields[k])}</span></div>`;
          shown++;
        });
      });
    }

    const ungrouped = regularEntries.filter(([k]) => !groupedKeys.has(k));
    ungrouped.slice(0, maxPreview - shown).forEach(([k, v]) => {
      fieldsHtml += `<div class="card-field"><span class="field-key">${esc(k)}</span><span class="field-value">${esc(v)}</span></div>`;
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
            <button class="dup-btn" title="Duplicate scheme">📋</button>
            <button class="hide-btn" title="${e.hidden ? 'Unhide' : 'Hide'}">${e.hidden ? '👁️' : '🙈'}</button>
          </div>
        </div>
        ${tagsHtml}
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
    card.querySelector('.dup-btn').addEventListener('click', e => { e.stopPropagation(); duplicateScheme(schemeId); });
    card.querySelector('.hide-btn').addEventListener('click', e => { e.stopPropagation(); toggleHideScheme(schemeId); });
    card.querySelector('.card-name-more')?.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const h3 = e.target.closest('h3');
      const e2 = getEffective(schemeId);
      h3.innerHTML = esc(e2.name);
      h3.classList.remove('card-name-truncated');
    });
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

function duplicateScheme(id) {
  const source = getEffective(id);
  if (!source) return;
  stageNewScheme(
    source.name + ' (copy)',
    { ...(source.fields || {}) },
    { ...(source.hiddenFields || {}) },
    JSON.parse(JSON.stringify(source.groups || []))
  );
  showToast('Scheme duplicated — edit and commit');
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
  const groups = scheme ? (scheme.groups || []) : [];
  const groupedKeys = new Set(groups.flatMap(g => g.fields || []));

  if (entries.length === 0 && hiddenEntries.length === 0 && groups.length === 0) {
    addFieldRow('', '');
  } else {
    // Render grouped fields under their group headers
    groups.forEach(g => {
      addGroupRow(g.name);
      (g.fields || []).forEach(k => {
        const v = scheme.fields ? scheme.fields[k] : '';
        if (v !== undefined) addFieldRow(k, v, false);
      });
    });
    // Render ungrouped fields (not in any group, not hidden)
    entries.filter(([k]) => !groupedKeys.has(k)).forEach(([k, v]) => addFieldRow(k, v, false));
    // Render hidden fields
    hiddenEntries.forEach(([k, v]) => addFieldRow(k, v, true));
  }

  renderHiddenFieldsToggle(hiddenEntries.length);

  // Populate copy-from dropdown (exclude current scheme)
  copyFromSelect.innerHTML = '<option value="">— Select a scheme —</option>';
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
  if (!sourceId) { showToast('Select a scheme first'); return; }
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

  // Add checked group headers with their fields
  sourceGroups.forEach(g => {
    const gCb = copyPicklistBody.querySelector(`.copy-pick-group-cb[data-group="${esc(g.name)}"]`);
    const groupChecked = gCb && gCb.checked;
    const gFields = (g.fields || []).filter(k => checkedFieldKeys.has(k));
    if (!groupChecked && gFields.length === 0) return;
    addGroupRow(g.name);
    gFields.forEach(k => {
      groupedCheckedKeys.add(k);
      if (sourceFields[k] !== undefined) addFieldRow(k, sourceFields[k], false);
    });
  });

  // Add remaining checked fields not in any group
  checkedFieldKeys.forEach(k => {
    if (!groupedCheckedKeys.has(k) && sourceFields[k] !== undefined) {
      addFieldRow(k, sourceFields[k], false);
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

function updateFieldSuggestions() {
  const keys = getUniqueFieldKeys();
  const datalist = document.getElementById('fieldKeySuggestions');
  datalist.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
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

function collectFieldData() {
  const name = schemeNameInput.value.trim();
  if (!name) {
    alert('Scheme name is required');
    return null;
  }
  const fields = {};
  const hiddenFields = {};
  const groups = [];
  let currentGroup = null;

  dynamicFields.querySelectorAll('.dynamic-field-row, .dynamic-group-row').forEach(row => {
    if (row.classList.contains('dynamic-group-row')) {
      const gName = row.querySelector('.group-name-input').value.trim();
      if (gName) {
        currentGroup = { name: gName, fields: [] };
        groups.push(currentGroup);
      } else {
        currentGroup = null;
      }
      return;
    }
    const k = row.querySelector('.field-key-input').value.trim();
    const v = row.querySelector('.field-value-input').value.trim();
    if (!k) return;
    if (row.dataset.isHidden === 'true') {
      hiddenFields[k] = v;
    } else {
      fields[k] = v;
      if (currentGroup) currentGroup.fields.push(k);
    }
  });
  return { name, fields, hiddenFields, groups };
}

addSchemeBtn.addEventListener('click', () => openModal());
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
schemeModal.addEventListener('click', e => {
  if (e.target === schemeModal) closeModal();
});

addFieldBtn.addEventListener('click', () => addFieldRow('', ''));
addGroupBtn.addEventListener('click', () => addGroupRow(''));

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
let detailGroups = [];

function renderDetailRows() {
  const query = detailSearchInput.value.toLowerCase();
  let rows = '';

  if (detailGroups.length > 0 && !query) {
    const groupedKeys = new Set(detailGroups.flatMap(g => g.fields || []));
    detailGroups.forEach(g => {
      const gFields = (g.fields || [])
        .map(k => [k, detailEntries.find(([ek]) => ek === k)])
        .filter(([, v]) => v !== undefined);
      if (gFields.length === 0) return;
      rows += `<div class="detail-group-header">${esc(g.name)}</div>`;
      gFields.forEach(([k, [, v]]) => {
        rows += `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`;
      });
    });
    const ungrouped = detailEntries.filter(([k]) => !groupedKeys.has(k));
    if (ungrouped.length > 0) {
      ungrouped.forEach(([k, v]) => {
        rows += `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`;
      });
    }
  } else {
    const filtered = query
      ? detailEntries.filter(([k, v]) => k.toLowerCase().includes(query) || String(v).toLowerCase().includes(query))
      : detailEntries;
    rows = filtered.length
      ? filtered.map(([k, v]) =>
          `<div class="detail-row"><span class="detail-key">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`
        ).join('')
      : '<p class="detail-empty">No matching fields</p>';
  }

  const totalVisible = query
    ? detailEntries.filter(([k, v]) => k.toLowerCase().includes(query) || String(v).toLowerCase().includes(query)).length
    : detailEntries.length;
  detailModalBody.innerHTML = rows;
  detailFieldCount.textContent = `${totalVisible} of ${detailEntries.length} field${detailEntries.length !== 1 ? 's' : ''}`;
}

function openDetailModal(id) {
  const scheme = getEffective(id);
  if (!scheme) return;
  detailSchemeId = id;
  detailModalTitle.textContent = esc(scheme.name);
  detailEntries = Object.entries(scheme.fields || {});
  detailGroups = scheme.groups || [];
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
    <span class="drag-handle" draggable="true">⠿</span>
    <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Field name" value="${esc(key)}" list="bulkFieldKeySuggestions" />
    <input type="text" class="field-value-input" name="bulk_field_value_${idx}" placeholder="Value" value="${esc(value)}" />
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
  const keys = getUniqueFieldKeys();
  const datalist = document.getElementById('bulkFieldKeySuggestions');
  datalist.innerHTML = keys.map(k => `<option value="${esc(k)}">`).join('');
}

function openBulkModal() {
  bulkModalTitle.textContent = 'Add/Edit Fields';
  bulkModalDesc.textContent = `Apply fields to ${selectedIds.size} selected scheme(s). Existing fields with the same name will be overwritten.`;
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

bulkModalNext.addEventListener('click', () => {
  const fieldKeys = [];
  const groupsData = [];
  let currentGroup = null;

  bulkDynamicFields.querySelectorAll('.dynamic-field-row, .dynamic-group-row').forEach(row => {
    if (row.classList.contains('dynamic-group-row')) {
      const gName = row.querySelector('.group-name-input').value.trim();
      currentGroup = gName ? { name: gName, fields: [] } : null;
      if (currentGroup) groupsData.push(currentGroup);
      return;
    }
    const k = row.querySelector('.field-key-input').value.trim();
    if (k) {
      fieldKeys.push(k);
      if (currentGroup) currentGroup.fields.push(k);
    }
  });

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
  bulkStep2Desc.innerHTML = `${schemeIds.length} scheme${schemeIds.length === 1 ? '' : 's'} in this batch. Leave a cell blank for null. <strong>Tab</strong> / <strong>arrow keys</strong> to navigate.`;

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
  const fieldKeys = [];
  const groupsData = [];
  let currentGroup = null;

  bulkDynamicFields.querySelectorAll('.dynamic-field-row, .dynamic-group-row').forEach(row => {
    if (row.classList.contains('dynamic-group-row')) {
      const gName = row.querySelector('.group-name-input').value.trim();
      currentGroup = gName ? { name: gName, fields: [] } : null;
      if (currentGroup) groupsData.push(currentGroup);
      return;
    }
    const k = row.querySelector('.field-key-input').value.trim();
    if (k) {
      fieldKeys.push(k);
      if (currentGroup) currentGroup.fields.push(k);
    }
  });

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
  showToast(`Fields staged for ${selectedIds.size} scheme(s)`);
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
  if (fieldKey === 'Scheme Name') return scheme.name;
  return scheme.fields ? scheme.fields[fieldKey] : undefined;
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

  // Aggregate into pivotMap: rowKey|colKey -> aggregated value
  const pivotMap = new Map();
  records.forEach(r => {
    const k = r.rowKey + '||' + r.colKey;
    if (isComma) {
      const str = String(r.rawVal ?? '');
      if (!str) return;
      if (!pivotMap.has(k)) pivotMap.set(k, []);
      const arr = pivotMap.get(k);
      if (agg === 'comma-distinct' ? !arr.includes(str) : true) arr.push(str);
    } else {
      const num = agg === 'count' ? 1 : (isNaN(Number(r.rawVal)) ? 0 : Number(r.rawVal));
      pivotMap.set(k, (pivotMap.get(k) || 0) + num);
    }
  });

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

  // For avg aggregation, recompute average from raw records
  function getAvg(rowKey, colKey) {
    const items = records.filter(r => r.rowKey === rowKey && r.colKey === colKey);
    if (!items.length) return 0;
    const sum = items.reduce((acc, r) => acc + (isNaN(Number(r.rawVal)) ? 0 : Number(r.rawVal)), 0);
    return (sum / items.length).toFixed(2);
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pivot-table.csv';
  a.click();
  URL.revokeObjectURL(url);
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
  const data = schemes.map(s => {
    const e = getEffective(s.id);
    return {
      name: e.name,
      fields: e.fields,
      hiddenFields: e.hiddenFields,
      groups: e.groups || [],
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
          groups: s.groups || [],
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
  var clientId = getDriveClientId();

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
    const data = schemes.map(s => {
      const e = getEffective(s.id);
      return { name: e.name, fields: e.fields, hiddenFields: e.hiddenFields, groups: e.groups || [], hidden: e.hidden, createdAt: e.createdAt };
    });
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
      await dbAdd({
        name: s.name,
        fields: s.fields || {},
        hiddenFields: s.hiddenFields || {},
        groups: s.groups || [],
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
  overlay.appendChild(makeJumpBtn('top', modalEl, id === 'schemeModal' ? 'form' : id === 'pivotModal' ? 'pivot table' : id === 'detailModal' ? 'details' : id === 'dataMenuModal' ? 'data menu' : 'bulk editor'));
  overlay.appendChild(makeJumpBtn('bottom', modalEl, id === 'schemeModal' ? 'form' : id === 'pivotModal' ? 'pivot table' : id === 'detailModal' ? 'details' : id === 'dataMenuModal' ? 'data menu' : 'bulk editor'));
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
