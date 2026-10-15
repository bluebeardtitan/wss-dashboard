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

// Applies every put/add in ONE transaction: if any record fails, the whole
// batch aborts and the store is left exactly as it was. This is what keeps
// commit() and replace-import from ever leaving a half-written database.
async function dbCommit({ puts = [], adds = [], clear = false }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      if (clear) store.clear();
      puts.forEach(r => store.put(r));
      adds.forEach(r => store.add(r));
    } catch (err) {
      try { if (tx) tx.abort(); } catch (_) { /* already aborted */ }
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
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
  schemes.push({ id, uid: generateUid(), name, fields: fields || {}, hiddenFields: hiddenFields || {}, groups: groups || [], hidden: false, createdAt: new Date().toISOString() });
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

function generateUid() {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function stableUidForScheme(s, index = 0) {
  const name = (s.name || '').trim();
  const created = s.createdAt || '';
  const base = (name + '|' + created + '|' + index).slice(0, 128);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 's-' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function toExportShape(e) {
  return {
    uid: e.uid || stableUidForScheme(e),
    name: e.name,
    fields: e.fields,
    hiddenFields: e.hiddenFields,
    groups: e.groups || [],
    hidden: e.hidden,
    createdAt: e.createdAt
  };
}

function normalizeScheme(raw, index = 0) {
  const uid = raw.uid || stableUidForScheme(raw, index);
  return {
    uid,
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
const tablePreviewSummary = document.getElementById('tablePreviewSummary');
const tablePreviewBody = document.getElementById('tablePreviewBody');

// Data Menu
const dataMenuBtn = document.getElementById('dataMenuBtn');
const dataMenuModal = document.getElementById('dataMenuModal');
const dataMenuClose = document.getElementById('dataMenuClose');
const dataImportLocal = document.getElementById('dataImportLocal');
const dataExportLocal = document.getElementById('dataExportLocal');
const dataDriveConnect = document.getElementById('dataDriveConnect');
const dataDriveSync = document.getElementById('dataDriveSync');
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
const bulkStep2Title = document.getElementById('bulkStep2Title');
const bulkStep2Desc = document.getElementById('bulkStep2Desc');

// Copy from
const copyFromSelect = document.getElementById('copyFromSelect');
const copyFromInput = document.getElementById('copyFromInput');
const copySuggest = document.getElementById('copySuggest');
const copyFromPicklist = document.getElementById('copyFromPicklist');
const copyPicklistBody = document.getElementById('copyPicklistBody');
const copyPickAll = document.getElementById('copyPickAll');
const copyFromBtn = document.getElementById('copyFromBtn');
const matchOrderBtn = document.getElementById('matchOrderBtn');
const orderPreview = document.getElementById('orderPreview');
const orderNote = document.getElementById('orderNote');
const copyModeTabs = document.querySelectorAll('.copy-mode-tab');

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
// Toasts share one corner of the screen, so they render into a stack
// container instead of piling up at identical fixed coordinates.
let toastStack = null;

function showToast(msg) {
  if (!toastStack || !toastStack.isConnected) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.appendChild(toastStack);
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toastStack.appendChild(t);
  setTimeout(() => {
    t.remove();
    if (toastStack && !toastStack.children.length) toastStack.remove();
  }, 2500);
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
  const visibleSchemes = getVisibleSchemes();
  const filtered = visibleSchemes.filter(s => schemeMatchesQuery(getEffective(s.id)));
  const filterActive = searchMode === 'expr' || searchMode === 'simple';
  const exprInvalid = filterActive && !!exprFilter && isExprInvalid(exprFilter);
  searchWrapper.classList.toggle('search-invalid', exprInvalid);
  syncHeaderChrome();
  invalidateSearchSchema();

  const hiddenCount = schemes.filter(s => s.hidden).length;
  showHiddenCount.textContent = hiddenCount;
  showHiddenBtn.classList.toggle('active', showHidden);

  const pendingCount = schemes.filter(s => pendingChanges.has(s.id)).length;
  const newPending = [...pendingChanges.keys()].filter(isNewId).length;
  const totalPending = pendingCount + newPending;

  const modeNote = searchMode === 'expr' ? ' — ƒx filter' : searchMode === 'simple' ? ' — filters' : '';
  statsBar.textContent = `${filtered.length} of ${visibleSchemes.length} card${visibleSchemes.length !== 1 ? 's' : ''}${showHidden && hiddenCount ? ` (${hiddenCount} hidden)` : ''}${totalPending ? ` — ${totalPending} unsaved` : ''}${modeNote}${exprInvalid ? ' — invalid expression' : ''}`;

  updatePendingBar();

  if (filtered.length === 0) {
    cardsContainer.innerHTML = '';
    emptyState.style.display = 'flex';
    emptyState.querySelector('h2').textContent = visibleSchemes.length === 0
      ? 'No cards yet'
      : 'No matching cards';
    emptyState.querySelector('p').textContent = visibleSchemes.length === 0
      ? 'Click "Add Card" to create your first card.'
      : (filterActive
        ? 'Try removing a filter or checking the spelling.'
        : 'Try a different search term.');
    return;
  }

  emptyState.style.display = 'none';

  cardsContainer.innerHTML = filtered.map(renderCard).join('');
}

function renderCard(s) {
  const e = getEffective(s.id);
  const isPending = pendingChanges.has(s.id);
  const entries = Object.entries(e.fields || {});
  const groups = e.groups || [];
  const groupedKeys = new Set(groups.flatMap(g => g.fields || []));
  const maxPreview = 3;

  const tags = entries.filter(([k]) => k.startsWith('#'));
  const regularEntries = entries.filter(([k]) => !k.startsWith('#'));

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
      <span class="sel-marker" aria-hidden="true"></span>
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

// Quotes are included because esc() output is injected into HTML attributes
// (value="…", data-*=…) as well as text nodes. Without ", a value like
// foo"bar would terminate the attribute early and the truncated remainder
// would be silently written back on the next save.
const ESC_RE = /[&<>"]/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(str) {
  return String(str).replace(ESC_RE, c => ESC_MAP[c]);
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

function getVisibleSchemes() {
  return showHidden ? schemes : schemes.filter(s => !s.hidden);
}

// Values are comma-joined names, but names may contain commas too ("Bore
// Well, Main"), so a plain split shreds one target into fragments. Instead,
// scan the raw text positionally and prefer the LONGEST known scheme name
// that starts at each position and is followed by a separator (comma) or the
// end — this keeps large names that span commas intact ("Bore Well, Main
// Road" matches the scheme of that full name, not the shorter "Bore Well").
// A known name is only consumed when it sits on its own comma boundary, so a
// free-typed name that merely starts with a known one is left whole. Anything
// unmatched stays as a comma-split fragment and renders as an unresolved chip.
// Stored text is never rewritten by this.
function parseLinkTargets(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const names = Array.from(knownSchemeNameSet()).sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === ',' || ch === ' ') { i++; continue; }
    // Longest known-name match at this position, boundary-checked.
    let best = null;
    for (const name of names) {
      if (!name) continue;
      if (lower.startsWith(name, i)) {
        const next = raw[i + name.length];
        if (next === undefined || next === ',') {
          best = name;
          break; // sorted longest-first, so the first hit is the longest
        }
        break; // known name is only a prefix of a longer unknown name
      }
    }
    if (best) {
      out.push(raw.slice(i, i + best.length));
      i += best.length;
      continue;
    }
    // No known-name match: keep the next comma-free fragment whole.
    const nextComma = raw.indexOf(',', i);
    if (nextComma === -1) {
      const frag = raw.slice(i).trim();
      if (frag) out.push(frag);
      i = raw.length;
    } else {
      const frag = raw.slice(i, nextComma).trim();
      if (frag) out.push(frag);
      i = nextComma + 1;
    }
  }
  return out;
}

// esc() now escapes quotes too; this alias remains for call-site clarity.
function escAttr(str) {
  return esc(str);
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

  // Populate copy-from searchable list (exclude current scheme)
  copyFromData = schemes.filter(s => s.id !== editingId).map(s => ({
    id: s.id,
    name: (getEffective(s.id).name || '').trim()
  }));
  copyFromInput.value = '';
  copyFromSelect.value = '';
  copySuggest.innerHTML = '';
  copySuggest.classList.add('hidden');
  copyFromPicklist.classList.add('hidden');
  setCopyMode('copy');

  schemeModal.classList.remove('hidden');
  setTimeout(() => schemeNameInput.focus(), 100);
}

// ---------- Copy-from searchable dropdown ----------
let copyFromData = [];

function filterCopySchemes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return copyFromData;
  return copyFromData.filter(s => s.name.toLowerCase().includes(q));
}

function renderCopySuggestions(query) {
  const matches = filterCopySchemes(query);
  if (!matches.length) {
    copySuggest.innerHTML = '<div class="cs-empty">No matching cards</div>';
    copySuggest.classList.remove('hidden');
    return;
  }
  const q = (query || '').trim().toLowerCase();
  copySuggest.innerHTML = matches.map(s => {
    const hl = q ? highlightMatch(s.name, q) : esc(s.name);
    return `<button type="button" class="cs-item" data-id="${escAttr(String(s.id))}">${hl}</button>`;
  }).join('');
  copySuggest.classList.remove('hidden');
  if (!copySuggest._glowInit) { initScrollGlow(copySuggest); copySuggest._glowInit = true; }
}

function highlightMatch(name, q) {
  const i = name.toLowerCase().indexOf(q);
  if (i === -1) return esc(name);
  return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
}

function selectCopyScheme(id) {
  copyFromSelect.value = String(id);
  const match = copyFromData.find(s => String(s.id) === String(id));
  copyFromInput.value = match ? match.name : '';
  copySuggest.classList.add('hidden');
  copyFromSelect.dispatchEvent(new Event('change'));
}

copyFromInput.addEventListener('input', () => {
  copyFromSelect.value = '';
  copyFromPicklist.classList.add('hidden');
  renderCopySuggestions(copyFromInput.value);
});

copyFromInput.addEventListener('focus', () => {
  renderCopySuggestions(copyFromInput.value);
});

copyFromInput.addEventListener('blur', () => {
  setTimeout(() => copySuggest.classList.add('hidden'), 150);
});

copyFromInput.addEventListener('keydown', e => {
  const items = copySuggest.querySelectorAll('.cs-item');
  const activeIdx = [...items].findIndex(el => el.classList.contains('cs-active'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = activeIdx < items.length - 1 ? activeIdx + 1 : 0;
    items.forEach((el, i) => el.classList.toggle('cs-active', i === next));
    if (items[next]) items[next].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = activeIdx > 0 ? activeIdx - 1 : items.length - 1;
    items.forEach((el, i) => el.classList.toggle('cs-active', i === prev));
    if (items[prev]) items[prev].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0 && items[activeIdx]) {
      selectCopyScheme(items[activeIdx].dataset.id);
    } else if (items.length === 1) {
      selectCopyScheme(items[0].dataset.id);
    }
  } else if (e.key === 'Escape') {
    copySuggest.classList.add('hidden');
  }
});

copySuggest.addEventListener('mousedown', e => {
  const item = e.target.closest('.cs-item');
  if (!item) return;
  e.preventDefault();
  selectCopyScheme(item.dataset.id);
});

copyFromSelect.addEventListener('change', () => {
  const sourceId = copyFromSelect.value;
  if (!sourceId) { copyFromPicklist.classList.add('hidden'); return; }
  const source = getEffective(sourceId);
  if (!source) { copyFromPicklist.classList.add('hidden'); return; }

  const sourceFields = source.fields || {};
  const sourceGroups = source.groups || [];
  const groupedKeys = new Set(sourceGroups.flatMap(g => g.fields || []));

  // Keys already present on the current card (visible or hidden). Source
  // fields without a match would be added as new rows, so they get a
  // "New" mark while everything else reads as a value overwrite.
  const currentKeys = new Set();
  Array.from(dynamicFields.children).forEach(row => {
    if (!row.classList.contains('dynamic-field-row')) return;
    const k = rowKey(row);
    if (k) currentKeys.add(k);
  });
  const newMark = k => currentKeys.has(k) ? '' : '<span class="copy-pick-new-badge" title="Not on this card yet">New</span>';

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
      html += `<label class="copy-pick-item copy-pick-field${currentKeys.has(k) ? '' : ' is-new'}">
        <input type="checkbox" class="copy-pick-field-cb" data-key="${esc(k)}" data-group="${esc(g.name)}" />
        <span>${esc(k)}: <em>${esc(sourceFields[k])}</em></span>${newMark(k)}
      </label>`;
    });
    html += `</div>`;
  });

  const ungrouped = Object.entries(sourceFields).filter(([k]) => !groupedKeys.has(k));
  if (ungrouped.length > 0) {
    ungrouped.forEach(([k, v]) => {
      html += `<label class="copy-pick-item copy-pick-field${currentKeys.has(k) ? '' : ' is-new'}">
        <input type="checkbox" class="copy-pick-field-cb" data-key="${esc(k)}" />
        <span>${esc(k)}: <em>${esc(v)}</em></span>${newMark(k)}
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
  resetCopyFrom();
});

// ---------- Copy-from: match field order ----------
copyModeTabs.forEach(tab => {
  tab.addEventListener('click', () => setCopyMode(tab.dataset.mode));
});

function setCopyMode(mode) {
  copyModeTabs.forEach(t => t.classList.toggle('is-active', t.dataset.mode === mode));
  copyFromPicklist.querySelectorAll('.copy-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== mode));
  if (mode === 'order') renderOrderPreview();
}

function resetCopyFrom() {
  copyFromSelect.value = '';
  copyFromInput.value = '';
  copySuggest.classList.add('hidden');
  copyFromPicklist.classList.add('hidden');
  setCopyMode('copy');
}

// Stored key for a field row, mirroring parseFieldRows (link → "→ label",
// tag → "#name", plain → name).
function rowKey(row) {
  const input = row.querySelector('.field-key-input');
  if (!input) return '';
  let k = input.value.trim();
  if (!k) return '';
  if (row.classList.contains('link-row')) {
    if (!isLinkKey(k)) k = '→ ' + k;
  } else if (row.classList.contains('tag-row')) {
    k = '#' + k.replace(/^#+\s*/, '');
  } else {
    k = k.replace(/^#+\s*/, '');
  }
  return k;
}

// Ordered layout plan of a source card: grouped fields follow their groups,
// then any remaining fields in insertion order.
function buildTargetPlan(source) {
  const fields = source.fields || {};
  const groups = source.groups || [];
  const inGroup = new Set();
  const seen = new Set();
  const plan = [];
  groups.forEach(g => {
    const gFields = (g.fields || []).filter(k => !seen.has(k) && fields[k] !== undefined);
    if (gFields.length === 0) return;
    plan.push({ type: 'group', name: g.name });
    gFields.forEach(k => { seen.add(k); inGroup.add(k); plan.push({ type: 'field', key: k }); });
  });
  Object.keys(fields).forEach(k => {
    if (!seen.has(k)) plan.push({ type: 'field', key: k });
  });
  return plan;
}

// Reorder the open form's rows so existing fields line up like the source
// card. Duplicate rows are keyed together and stay one contiguous block, so
// fields that share a name never get pulled apart. Rows (and hidden fields)
// without a counterpart on the source card keep their relative order.
function applyOrderToForm(source) {
  const plan = buildTargetPlan(source);
  const children = Array.from(dynamicFields.children);

  const groupByName = new Map();
  children.forEach(row => {
    if (!row.classList.contains('dynamic-group-row')) return;
    const nameInput = row.querySelector('.group-name-input');
    const name = nameInput ? nameInput.value.trim() : '';
    if (name && !groupByName.has(name)) groupByName.set(name, row);
  });

  const byKey = new Map();
  children.forEach(row => {
    if (!row.classList.contains('dynamic-field-row') || row.dataset.isHidden === 'true') return;
    const k = rowKey(row);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(row);
  });

  const used = new Set();
  const usedGroups = new Set();
  const ordered = [];

  plan.forEach(entry => {
    if (entry.type === 'group') {
      if (usedGroups.has(entry.name)) return;
      const gr = groupByName.get(entry.name);
      if (gr) {
        usedGroups.add(entry.name);
        used.add(gr);
        ordered.push(gr);
      }
      return;
    }
    const q = byKey.get(entry.key);
    if (q && q.length) {
      q.forEach(row => {
        used.add(row);
        ordered.push(row);
      });
      byKey.set(entry.key, []);
    }
  });

  children.forEach(row => {
    if (!used.has(row)) ordered.push(row);
  });
  ordered.forEach(row => dynamicFields.appendChild(row));
}

// Preview ribbon for the "Match field order" tab: numbered slots show where
// each existing field lands, muted slots are source fields missing from this
// card, and the tail lists fields that keep their current place.
function renderOrderPreview() {
  const sourceId = copyFromSelect.value;
  const source = sourceId ? getEffective(sourceId) : null;
  if (!source) {
    orderNote.textContent = 'Search and pick a card above to preview its field order.';
    orderPreview.innerHTML = '';
    return;
  }

  const plan = buildTargetPlan(source);
  const targetKeys = plan.filter(e => e.type === 'field').map(e => e.key);
  const targets = new Set(targetKeys);
  const counts = new Map();
  Array.from(dynamicFields.children).forEach(row => {
    if (!row.classList.contains('dynamic-field-row') || row.dataset.isHidden === 'true') return;
    const k = rowKey(row);
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const dupCount = Array.from(counts.values()).filter(c => c > 1).length;
  const keptKeys = Array.from(counts.keys()).filter(k => !targets.has(k));

  let matched = 0;
  let slot = 1;
  let html = '';
  plan.forEach(entry => {
    if (entry.type === 'group') {
      html += `<span class="order-chip order-chip-group" title="Group: ${esc(entry.name)}">📁 ${esc(entry.name)}</span>`;
      return;
    }
    const n = counts.get(entry.key) || 0;
    if (n > 0) {
      html += `<span class="order-chip" title="${esc(entry.key)}"><b>${slot}</b>${esc(entry.key)}${n > 1 ? `<i>×${n}</i>` : ''}</span>`;
      slot += 1;
      matched += 1;
    } else {
      html += `<span class="order-chip order-chip-ghost" title="${esc(entry.key)} — not on this card">${esc(entry.key)}</span>`;
    }
  });
  if (keptKeys.length > 0) {
    html += `<span class="order-ribbon-divider">Keeps its place</span>`;
    keptKeys.forEach(k => {
      html += `<span class="order-chip order-chip-kept" title="${esc(k)}">${esc(k)}${counts.get(k) > 1 ? `<i>×${counts.get(k)}</i>` : ''}</span>`;
    });
  }

  const dupNote = dupCount > 0
    ? ` ${dupCount} duplicate name${dupCount > 1 ? 's' : ''} stay${dupCount > 1 ? '' : 's'} paired in current order.`
    : '';
  orderNote.innerHTML = `Arranges <b>${matched}</b> field${matched !== 1 ? 's' : ''}${keptKeys.length ? `, keeps <b>${keptKeys.length}</b> as-is` : ''}.${dupNote}`;
  orderPreview.innerHTML = html;
}

matchOrderBtn.addEventListener('click', () => {
  const sourceId = copyFromSelect.value;
  if (!sourceId) { showToast('Select a card first'); return; }
  const source = getEffective(sourceId);
  if (!source) return;
  applyOrderToForm(source);
  resetCopyFrom();
  showToast(`Fields reordered to match "${source.name}"`);
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
  return getUniqueFieldKeys().filter(isTagKey).map(tagLabel);
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

function wireRemoveFieldBtn(row, onRemove) {
  row.querySelector('.remove-field').addEventListener('click', () => {
    if (row.dataset.isHidden === 'true') {
      row.remove();
      updateHiddenFieldsCount();
    } else {
      row.dataset.isHidden = 'true';
      row.classList.add('field-hidden');
      updateHiddenFieldsCount();
    }
    if (onRemove) onRemove();
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
  wireRemoveFieldBtn(row);
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
  return getUniqueFieldKeys().filter(isLinkKey).map(linkLabel);
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
  wireRemoveFieldBtn(row);
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
  wireRemoveFieldBtn(row);
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

// ========== Expression Filter ==========
// Expressions are compiled with filtrex (vendored at vendor/filtrex.js) and
// evaluated per scheme. Supported syntax: and/or/not, == != > >= < <=,
// ~= (regex), if/then/else, exists(), empty(), arithmetic. Bare words
// resolve against field names case-insensitively and `name` is the scheme
// name. Numeric-looking values compare as numbers. Expressions live only in
// expression mode (see "Expression Filter UI" below) — plain text search
// never compiles anything.
const EXPR_FIELD_RE = /field\s*:\s*(?:"([^"]*)"|'([^']*)')/gi;

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
  if (!fields) return undefined;
  const raw = String(name).trim();
  if (Object.prototype.hasOwnProperty.call(fields, raw)) {
    return coerceFieldValue(fields[raw]);
  }
  // Tags are stored as "#Name" but shown without the marker, so resolve
  // either spelling: try as typed, then cross the # boundary.
  const tries = [raw];
  const stripped = raw.replace(/^#+\s*/, '');
  if (stripped !== raw) tries.push(stripped);
  else if (stripped) tries.push('#' + stripped);
  for (const t of tries) {
    const tl = t.toLowerCase();
    for (const k of Object.keys(fields)) {
      if (k.trim().toLowerCase() === tl) return coerceFieldValue(fields[k]);
    }
  }
  return undefined;
}

// __field reads the scheme currently being tested; evaluation is synchronous,
// so this slot is set right before each call.
let exprCurrentFields = {};
const exprCache = new Map();

// Pseudo-field exposing a record's whole searchable text (card name + field
// keys + values) to Simple-mode queries. Generated Simple filters use it for
// the free-text box, so one expression can represent both the text search and
// the filter rows — which is what lets Simple round-trip to Advanced without
// losing the typed query. The name is unlikely to collide with a real field.
const BUILDER_TEXT_KEY = '__builder_text__';

function builderSearchBlob(e) {
  const parts = [String(e.name || '')];
  for (const [k, v] of Object.entries(e.fields || {})) { parts.push(k); parts.push(String(v)); }
  return parts.join('\n');
}

// Compiles the query as a filtrex expression: { fn } on success,
// { invalid: true } on syntax errors. Only called in expression mode —
// text mode never compiles.
function compileSearchQuery(q) {
  if (exprCache.has(q)) return exprCache.get(q);
  if (exprCache.size > 100) exprCache.clear();
  let result;
  try {
    result = {
      fn: window.filtrex.compileExpression(preprocessExprQuery(q), {
        extraFunctions: {
          __field: name => lookupExprField(exprCurrentFields, name),
          // Case-insensitive text helpers used only by generated Simple-mode
          // queries. Exposing them as functions keeps every user value a
          // plain string literal, so quotes, parentheses and non-ASCII
          // characters in a value can never break the expression the way a
          // hand-assembled regex could.
          icontains: (a, b) => String(a == null ? '' : a).toLowerCase().includes(String(b == null ? '' : b).toLowerCase()),
          istartsWith: (a, b) => String(a == null ? '' : a).toLowerCase().startsWith(String(b == null ? '' : b).toLowerCase()),
          iequals: (a, b) => String(a == null ? '' : a).toLowerCase() === String(b == null ? '' : b).toLowerCase(),
          inotequals: (a, b) => String(a == null ? '' : a).toLowerCase() !== String(b == null ? '' : b).toLowerCase()
        },
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

// ---------- Two search modes ----------
// 'text': substring across the name, field keys and values — nothing is
// compiled. 'expr': exprFilter (composed in the query editor modal) always
// evaluates as filtrex, even bare words, because the user chose this mode.
// 'simple': the guided builder compiled exprFilter into an expression that
// must evaluate true — used by the plain-language filter modal. text and expr
// each keep their own query; simple reuses exprFilter (it holds the generated
// expression) and keeps its own builder state alongside.
// Switching swaps between them without loss.
let searchMode = 'text';
let exprFilter = '';

function evalCompiledExpr(compiled, e) {
  // Expose the record's searchable text under BUILDER_TEXT_KEY so the
  // generated Simple query can scan it; field-name lookups still resolve from
  // the record's own fields.
  const scope = Object.assign({}, e.fields || {}, { [BUILDER_TEXT_KEY]: builderSearchBlob(e) });
  exprCurrentFields = scope;
  // filtrex returns runtime errors as truthy Error objects; only a real
  // boolean true counts as a match.
  try {
    return compiled.fn(Object.assign({}, scope, { name: e.name })) === true;
  } catch (err) {
    return false;
  }
}

function isExprInvalid(q) {
  if (!q) return false;
  const c = compileSearchQuery(q);
  return !!(c && c.invalid);
}

// Text-mode grammar: term [term …] [| term [term …]]…
// Whitespace-separated terms AND together; | separates OR groups, and AND
// binds tighter (split on | first, then on spaces). Each term is tested
// against the card name, field keys and values under the selected matching
// mode (see "Matching mode" below). Degenerate queries degrade gracefully:
// empty terms/groups are dropped, a lone separator equals the bare term, an
// all-empty query matches all.
function textTermMatches(term, e) {
  const cells = [String(e.name || '')];
  Object.entries(e.fields || {}).forEach(([k, v]) => {
    cells.push(k, String(v));
  });
  return cells.some(cell => cellMatches(searchMatchMode, cell, term));
}

function textQueryMatches(q, e) {
  const groups = q.toLowerCase()
    .split('|')
    .map(g => g.split(/\s+/).filter(Boolean))
    .filter(g => g.length);
  if (!groups.length) return true;
  return groups.some(terms => terms.every(t => textTermMatches(t, e)));
}

// ---------- Matching mode (text mode only) ----------
// How a term is applied to a card name / field key / field value cell:
//  'anywhere' — the term occurs as a substring anywhere in the cell
//  'word'     — the term occurs as a whole word (non-letter/number bounds)
//  'exact'    — the entire cell equals the term
// Expression mode has its own operators, so this governs plain text only.
let searchMatchMode = 'anywhere';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cellMatches(mode, cell, term) {
  const c = String(cell || '');
  if (mode === 'exact') return c.trim().toLowerCase() === term.toLowerCase();
  if (mode === 'word') {
    const re = new RegExp(
      '(^|[^\\p{L}\\p{N}_])(' + escapeRegExp(term) + ')(?=[^\\p{L}\\p{N}_]|$)',
      'iu'
    );
    return re.test(c);
  }
  return c.toLowerCase().includes(term);
}

function schemeMatchesQuery(e) {
  // Advanced and Simple both apply a compiled expression; Simple's is
  // generated from the builder, Advanced's is typed by the user.
  if (searchMode === 'expr' || searchMode === 'simple') {
    if (!exprFilter) return true;
    const compiled = compileSearchQuery(exprFilter);
    if (!compiled || compiled.invalid) return false;
    return evalCompiledExpr(compiled, e);
  }
  const q = searchQuery.trim();
  if (!q) return true;
  return textQueryMatches(q, e);
}

// ========== Expression Filter UI ==========
// Expressions are composed in a dedicated editor modal launched from the ƒx
// toggle, and reopened any time by clicking the active-filter pill. The
// editor keeps the schema-live affordances that make the language
// discoverable: a suggestion dropdown driven by the caret context (fields →
// operators → sample values, all from the user's own data), snippet
// sections mirroring SEARCH.md, click-to-load examples, and a live match
// count so applying a filter is never a guess. Inserted values follow the
// documented typing rules: numeric-looking literals go bare so `in (11045)`
// matches numbers, everything else is quoted.
const searchClearBtn = document.getElementById('searchClearBtn');
const exprModeBtn = document.getElementById('exprModeBtn');
const matchModeGroup = document.getElementById('matchMode');

function setMatchMode(mode) {
  searchMatchMode = mode;
  matchModeGroup.querySelectorAll('.match-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
}

matchModeGroup.addEventListener('click', e => {
  const btn = e.target.closest('.match-mode-btn');
  if (!btn || btn.dataset.mode === searchMatchMode) return;
  setMatchMode(btn.dataset.mode);
  render();
});
const exprPill = document.getElementById('exprPill');
const exprPillText = document.getElementById('exprPillText');
const exprPillExit = document.getElementById('exprPillExit');
const queryModal = document.getElementById('queryModal');
const queryModalClose = document.getElementById('queryModalClose');
const exprInput = document.getElementById('exprInput');
const exprSuggest = document.getElementById('exprSuggest');
const exprStatus = document.getElementById('exprStatus');
const querySections = document.getElementById('querySections');
const exprRemoveBtn = document.getElementById('exprRemoveBtn');
const exprCancelBtn = document.getElementById('exprCancelBtn');
const exprApplyBtn = document.getElementById('exprApplyBtn');

// Simple-builder + mode-switch DOM, looked up once like every other ref.
const simplePanel = document.getElementById('simplePanel');
const advancedPanel = document.getElementById('advancedPanel');
const simpleSearchInput = document.getElementById('simpleSearchInput');
const simpleFilters = document.getElementById('simpleFilters');
const addFilterBtn = document.getElementById('addFilterBtn');
const clearFiltersBtn = document.getElementById('clearFiltersBtn');
const simpleMatchGroup = document.getElementById('simpleMatchGroup');
const simpleExamples = document.getElementById('simpleExamples');
const simpleStatus = document.getElementById('simpleStatus');
const advancedToggle = document.getElementById('advancedToggle');
const simpleToggle = document.getElementById('simpleToggle');
const queryRoundTripNote = document.getElementById('queryRoundTripNote');

// ---------- Live schema ----------
let searchSchemaCache = null;

function invalidateSearchSchema() { searchSchemaCache = null; }

function getSearchSchema() {
  if (searchSchemaCache) return searchSchemaCache;
  const map = new Map();
  const bump = (name, val) => {
    let rec = map.get(name);
    if (!rec) { rec = { count: 0, freq: new Map(), samples: [] }; map.set(name, rec); }
    rec.count++;
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      const s = String(val);
      rec.freq.set(s, (rec.freq.get(s) || 0) + 1);
    }
  };
  schemes.forEach(s => {
    if (!showHidden && s.hidden) return;
    const e = getEffective(s.id);
    Object.entries(e.fields || {}).forEach(([k, v]) =>
      bump(isTagKey(k) ? tagLabel(k) : k, v));
  });
  map.set('name', { count: schemes.length, freq: new Map(), samples: [], pseudoName: true });
  map.forEach(rec => {
    rec.samples = [...rec.freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(e2 => e2[0]);
    delete rec.freq;
  });
  searchSchemaCache = map;
  return map;
}

function truncateMeta(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatSampleLiteral(s) {
  const t = String(s).trim();
  if (t !== '' && Number.isFinite(Number(t))) return t;
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------- Caret context ----------
// Works on the text left of the caret to answer: is the user picking a
// field name, an operator, or a value — and for which field?
function resolveLeftFieldRef(str, schema) {
  str = str.replace(/\s+$/, '');
  let m = str.match(/\bfield\s*:\s*(?:"([^"]*)"|'([^']*)')$/i);
  if (m) return m[1] !== undefined ? m[1] : m[2];
  m = str.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) {
    const tok = m[1];
    if (tok.toLowerCase() === 'name' || schema.has(tok) ||
        [...schema.keys()].some(k => k.toLowerCase() === tok.toLowerCase())) return tok;
  }
  return null;
}

function getAssistContext(text, caret) {
  const left = text.slice(0, caret);
  const schema = () => getSearchSchema();

  // Locate the last comparison operator once.
  const opRe = /(==|!=|>=|<=|~=|>|<)/g;
  let last = null, om;
  while ((om = opRe.exec(left))) last = om;

  // An unterminated string literal sits before the caret. Whose? Quote
  // parity tells us reliably whether a literal is open (quotes in this
  // language only ever pair up as literal delimiters).
  const openDq = ((left.match(/"/g) || []).length % 2) === 1;
  const openSq = ((left.match(/'/g) || []).length % 2) === 1;
  if (openDq || openSq) {
    const q = openDq ? '"' : "'";
    const qIdx = left.lastIndexOf(q);
    const typed = left.slice(qIdx + 1);
    const beforeStr = left.slice(0, qIdx);
    // Opened by field: → picking a field name.
    if (/\bfield\s*:\s*$/i.test(beforeStr)) {
      return { type: 'field', start: caret - typed.length, typed, inString: true, quoteChar: q };
    }
    // Opened by a comparison operator → picking a value. Regex patterns
    // stay quiet: free-typing a pattern is not value picking.
    const opIsEq = last && last[0] !== '~=' && beforeStr.trimEnd().endsWith(last[0]);
    if (opIsEq) {
      const ref = resolveLeftFieldRef(left.slice(0, last.index), schema());
      if (ref) return { type: 'value', ref, start: caret - typed.length, typed, inString: true, quoteChar: q };
    }
    return null;
  }

  const trimEnd = left.replace(/\s+$/, '');

  // A closed field reference just ended → operator comes next.
  if (/\bfield\s*:\s*(?:"[^"]*"|'[^']*')$/i.test(trimEnd)) {
    return { type: 'operator', start: caret, typed: '' };
  }

  // A bare word token sits before the caret.
  let m = trimEnd.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) {
    const tok = m[1];
    const start = trimEnd.length - tok.length;
    const before = trimEnd.slice(0, start);
    const tokenComplete = left.length > trimEnd.length; // caret sits after whitespace
    if (/(==|!=|>=|<=|~=|>|<|\(|,)$/.test(before)) {
      const ref = resolveLeftFieldRef(before.replace(/(?:==|!=|>=|<=|~=|>|<)\s*$/, ''), schema());
      if (ref) return { type: 'value', ref, start, typed: tok };
    } else {
      // A completed field name followed by a space expects an operator;
      // a half-typed word filters the same list.
      const ref = tokenComplete
        ? resolveLeftFieldRef(trimEnd, schema())
        : resolveLeftFieldRef(before, schema());
      if (ref) return { type: 'operator', start, typed: tokenComplete ? '' : tok };
    }
    return { type: 'keyword', start, typed: tok };
  }

  // After a comparison operator → picking a bare (unquoted) value.
  if (last) {
    const afterOp = left.slice(last.index + last[0].length);
    const vm = afterOp.match(/([A-Za-z0-9_.]+)$/);
    if (vm) {
      const ref = resolveLeftFieldRef(left.slice(0, last.index), schema());
      if (ref) return { type: 'value', ref, start: caret - vm[1].length, typed: vm[1] };
    }
  }
  return null;
}

// ---------- Suggestion builders ----------
const EXPR_KEYWORDS = ['and', 'or', 'not', 'in', 'if', 'then', 'else', 'mod', 'true', 'false'];
const EXPR_FUNCTIONS = ['abs', 'ceil', 'floor', 'log', 'log2', 'log10', 'max', 'min', 'round', 'sqrt', 'exists', 'empty'];
const EXPR_OPERATORS = [
  { t: '==', d: 'equals (exact)' },
  { t: '!=', d: 'not equals' },
  { t: '>', d: 'greater than' },
  { t: '>=', d: 'greater or equal' },
  { t: '<', d: 'less than' },
  { t: '<=', d: 'less or equal' },
  { t: '~=', d: 'matches regex' },
  { t: 'in', d: 'any of ( … )' }
];

function rankByTyped(entries, typed) {
  const tl = typed.toLowerCase();
  const scored = entries.map(e => {
    const nl = String(e.name).toLowerCase();
    const tier = tl && nl.startsWith(tl) ? 0 : (tl && nl.includes(tl) ? 1 : (tl ? 2 : 0));
    return { ...e, tier };
  });
  scored.sort((a, b) => a.tier - b.tier || (b.weight || 0) - (a.weight || 0));
  return scored.filter(e => e.tier < 2 || !tl).slice(0, 8);
}

function buildSuggestions(ctx) {
  const schema = getSearchSchema();
  if (ctx.type === 'field') {
    const entries = [...schema.entries()]
      .map(([name, r]) => ({ name, weight: r.count }))
      .filter(e => e.name.toLowerCase().includes(ctx.typed.toLowerCase()));
    const ranked = rankByTyped(entries, ctx.typed).map(e => ({
      glyph: '▸',
      name: e.name,
      meta: e.name === 'name' ? `${e.weight} cards` :
        (getSearchSchema().get(e.name).samples[0] !== undefined ?
          `e.g. ${truncateMeta(getSearchSchema().get(e.name).samples[0], 16)}` : `${e.weight} cards`),
      insert: 'field:"' + e.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"',
      inner: e.name
    }));
    return [{ label: 'Fields', items: ranked }];
  }
  if (ctx.type === 'operator') {
    const items = rankByTyped(EXPR_OPERATORS.map(o => ({ name: o.t, desc: o.d })), ctx.typed)
      .map(o => ({ glyph: '=', name: o.name, meta: o.desc, insert: o.name + ' ' }));
    return [{ label: 'Operators', items }];
  }
  if (ctx.type === 'value') {
    const rec = schema.get(ctx.ref);
    if (!rec || rec.pseudoName) return [];
    const items = rec.samples
      .filter(s => !ctx.typed || formatSampleLiteral(s).toLowerCase().includes(ctx.typed.toLowerCase()))
      .slice(0, 8)
      .map(s => ({
        glyph: '"',
        name: truncateMeta(s, 26),
        meta: rec.count + ' cards',
        insert: formatSampleLiteral(s),
        // Inside an open string literal only the content goes in — the
        // quotes are already on the page.
        inner: String(s).replace(/"/g, '\\"')
      }));
    return items.length ? [{ label: `Values of ${ctx.ref}`, items }] : [];
  }
  if (ctx.type === 'keyword') {
    const groups = [];
    const fieldEntries = [...schema.entries()].map(([name, r]) => ({ name, weight: r.count }));
    const fields = rankByTyped(fieldEntries, ctx.typed).map(e => ({
      glyph: '▸', name: e.name,
      meta: e.name === 'name' ? 'card name' : 'field',
      insert: 'field:"' + e.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"',
      inner: e.name
    })).filter(x => x.name.toLowerCase().includes(ctx.typed.toLowerCase()));
    if (fields.length) groups.push({ label: 'Fields', items: fields });

    const fns = EXPR_FUNCTIONS.filter(f => f.startsWith(ctx.typed.toLowerCase())).map(f => ({
      glyph: 'ƒ', name: f,
      meta: (f === 'empty' || f === 'exists') ? 'check blank / present' : 'function',
      insert: (f === 'empty' || f === 'exists') ? `${f}(field:"")` : `${f}()`,
      caretIn: (f === 'empty' || f === 'exists') ? f.length + 8 : `${f}()`.length - 1
    }));
    if (fns.length) groups.push({ label: 'Functions', items: fns });

    const kws = EXPR_KEYWORDS.filter(k => k.startsWith(ctx.typed.toLowerCase())).map(k => ({
      glyph: '·', name: k, meta: 'keyword',
      insert: (k === 'not') ? 'not (' : k === 'true' || k === 'false' ? k : k + ' '
    }));
    if (kws.length) groups.push({ label: 'Keywords', items: kws });
    return groups;
  }
  return [];
}

// ---------- Suggestion dropdown (editor textarea) ----------
let suggestItems = [];
let suggestActive = -1;

function hideSuggest() {
  suggestItems = [];
  suggestActive = -1;
  exprSuggest.classList.add('hidden');
  exprInput.removeAttribute('aria-activedescendant');
}

function renderSuggest(groups) {
  suggestItems = groups.flatMap(g => g.items);
  if (!suggestItems.length) { hideSuggest(); return; }
  suggestActive = -1;
  let html = '';
  let i = 0;
  groups.forEach(g => {
    html += `<div class="ss-group-label">${esc(g.label)}</div>`;
    html += g.items.map(it => {
      const id = `ss-opt-${i}`;
      const metaHtml = it.meta ? `<span class="ss-meta">${esc(it.meta)}</span>` : '';
      const row = `<button type="button" tabindex="-1" role="option" class="ss-item" data-i="${i}" id="${id}">` +
        `<span class="ss-glyph" aria-hidden="true">${esc(it.glyph)}</span>` +
        `<span class="ss-name">${esc(it.name)}</span>${metaHtml}</button>`;
      i++;
      return row;
    }).join('');
  });
  exprSuggest.innerHTML = html;
  exprSuggest.classList.remove('hidden');
  if (!exprSuggest._glowInit) { initScrollGlow(exprSuggest); exprSuggest._glowInit = true; }
}

function applySuggestItem(item) {
  if (item.replaceAll) {
    exprInput.value = item.insert;
  } else {
    const v = exprInput.value;
    const selStart = exprInput.selectionStart ?? v.length;
    const selEnd = exprInput.selectionEnd ?? v.length;
    const ctx = getAssistContext(v, selStart);
    // Inside an open field:"…" or "…" literal the wrapper already exists
    // on the page: only the content goes between the quotes, and the
    // closing quote is added — unless it's already there to our right.
    let text = item.insert;
    if (ctx && item.inner !== undefined && ((ctx.type === 'field') || (ctx.type === 'value' && ctx.inString))) {
      const q = ctx.quoteChar || '"';
      text = item.inner;
      if (v.charAt(Math.max(selEnd, selStart)) !== q) text += q;
    }
    const start = ctx ? Math.min(ctx.start ?? selStart, selStart) : selStart;
    exprInput.value = v.slice(0, start) + text + v.slice(Math.max(selEnd, selStart));
    let pos = start + text.length;
    if (item.caretIn !== undefined && text === item.insert) pos = start + item.caretIn;
    else if (ctx && ctx.inString && v.charAt(Math.max(selEnd, selStart)) === '"') pos = start + item.inner.length + 1;
    exprInput.setSelectionRange(pos, pos);
  }
  hideSuggest();
  exprInput.focus();
  refreshExprAssist();
  scheduleExprStatus();
}

function moveSuggestActive(dir) {
  if (!suggestItems.length || exprSuggest.classList.contains('hidden')) return;
  const count = suggestItems.length;
  suggestActive = dir > 0
    ? (suggestActive + 1) % count
    : (suggestActive <= 0 ? count - 1 : suggestActive - 1);
  exprSuggest.querySelectorAll('.ss-item').forEach((el, idx) =>
    el.classList.toggle('active', idx === suggestActive));
  const el = exprSuggest.querySelector(`#ss-opt-${suggestActive}`);
  if (el) {
    el.scrollIntoView({ block: 'nearest' });
    exprInput.setAttribute('aria-activedescendant', el.id);
  }
}

// ---------- Editor wiring ----------
function refreshExprAssist() {
  const v = exprInput.value;
  if (!v.trim()) { hideSuggest(); return; }
  const ctx = getAssistContext(v, exprInput.selectionStart ?? v.length);
  if (!ctx) { hideSuggest(); return; }
  const groups = buildSuggestions(ctx).filter(g => g.items.length);
  if (!groups.length) { hideSuggest(); return; }
  renderSuggest(groups);
}

let exprStatusTimer = null;

function scheduleExprStatus() {
  clearTimeout(exprStatusTimer);
  exprStatusTimer = setTimeout(updateExprStatus, 120);
}

// Live preview of what applying would do: null means "does not compile".
function countExprMatches(q) {
  const compiled = compileSearchQuery(q);
  if (!compiled || compiled.invalid) return null;
  let n = 0;
  schemes.forEach(s => {
    if (!showHidden && s.hidden) return;
    if (evalCompiledExpr(compiled, getEffective(s.id))) n++;
  });
  return n;
}

function updateExprStatus() {
  clearTimeout(exprStatusTimer);
  exprStatusTimer = null;
  const q = exprInput.value.trim();
  if (!q) {
    exprStatus.className = 'expr-status';
    exprStatus.textContent = 'Type an expression, or pick fields and examples below.';
    exprApplyBtn.disabled = true;
    return;
  }
  const total = getVisibleSchemes().length;
  const n = countExprMatches(q);
  exprApplyBtn.disabled = n === null;
  if (n === null) {
    exprStatus.className = 'expr-status err';
    exprStatus.textContent = 'Invalid expression — check quotes, parentheses and operators.';
  } else {
    exprStatus.className = 'expr-status ok';
    exprStatus.textContent = `${n} of ${total} card${total !== 1 ? 's' : ''} match`;
  }
}

exprInput.addEventListener('input', () => {
  refreshExprAssist();
  scheduleExprStatus();
});
exprInput.addEventListener('focus', () => {
  // A fresh editor grounds the user immediately in their own fields.
  if (!exprInput.value.trim()) {
    const entries = [...getSearchSchema().entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([name]) => ({
        glyph: '▸', name, meta: name === 'name' ? 'card name' : 'field',
        insert: 'field:"' + name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"',
        inner: name
      }));
    renderSuggest([{ label: 'Your fields', items: entries }]);
  }
});
exprInput.addEventListener('blur', () => setTimeout(hideSuggest, 120));
exprInput.addEventListener('keydown', e => {
  const listOpen = suggestItems.length > 0 && !exprSuggest.classList.contains('hidden');
  if (listOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggestActive(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggestActive(-1); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && suggestActive >= 0) {
      e.preventDefault();
      applySuggestItem(suggestItems[suggestActive]);
      return;
    }
    if (e.key === 'Escape') {
      // Dismiss the dropdown first; only a second Esc reaches the modal.
      e.preventDefault();
      e.stopPropagation();
      hideSuggest();
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    applyExprFromEditor();
  }
});

exprSuggest.addEventListener('mousedown', e => {
  const b = e.target.closest('.ss-item');
  if (!b) return;
  e.preventDefault(); // keep focus in the textarea
  applySuggestItem(suggestItems[Number(b.dataset.i)]);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.classList.add('hidden');
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.focus();
});

// ---------- Reference panel (ƒx?) ----------
function fieldChipsForHelp() {
  const entries = [...getSearchSchema().entries()]
    .filter(([n, r]) => !r.pseudoName)
    .sort((a, b) => b[1].count - a[1].count);
  const shown = entries.slice(0, 12);
  const rest = entries.length - shown.length;
  const chips = shown.map(([name, r]) =>
    `<button type="button" class="sh-chip" data-insert="field:&quot;${escAttr(name.replace(/"/g, '\\"'))}&quot;">` +
    `${esc(name)} <span class="sh-count">×${r.count}</span></button>`
  ).join('');
  const note = rest > 0 ? `<p class="sh-note">+${rest} more — they appear as you type.</p>` : '';
  return chips + note;
}

const HELP_SECTIONS = [
  {
    title: 'Compare',
    chips: [
      { t: '== ', d: 'equals (exact case)' }, { t: '!= ', d: 'not equals' },
      { t: '> ', d: 'numbers only' }, { t: '>= ', d: '' }, { t: '< ', d: '' }, { t: '<= ', d: '' },
      { t: '~= ', d: 'regex test' }, { t: ' in ( )', d: 'any of a list' }
    ]
  },
  {
    title: 'Combine',
    chips: [
      { t: 'and ', d: '' }, { t: 'or ', d: '' }, { t: 'not ( )', d: 'negate — wrap comparisons' }
    ]
  },
  {
    title: 'Check values',
    chips: [
      { t: 'empty(field:"")', d: 'blank or missing', tpl: true },
      { t: 'exists(field:"")', d: 'present', tpl: true },
      { t: ' ~= ""', d: 'regex, e.g. ^WSS' }
    ],
    note: 'Blank fields read as missing — use empty(), not == "". Equality is exact: "Done" ≠ "done".'
  }
];

const HELP_EXAMPLES = [
  { q: 'Status == "Completed" or Status == "Commissioned"', d: 'either value' },
  { q: 'field:"Demand(MLD)" > 400 and not empty(field:"Notes")', d: 'combine conditions' },
  { q: 'field:"District" in ("North", "South")', d: 'list membership' },
  { q: 'name ~= "^WSS"', d: 'regex on card name' },
  { q: 'field:"Cost" / field:"Villages" > 50', d: 'arithmetic' },
  { q: 'max(field:"Phase 1", field:"Phase 2") >= 3', d: 'functions' }
];

// ---------- Editor sections ----------
function buildQuerySections() {
  const sections = HELP_SECTIONS.map(s => `
    <div class="sh-section">
      <h4>${esc(s.title)}</h4>
      <div class="sh-grid">${s.chips.map(c =>
        `<button type="button" class="sh-chip" title="${escAttr(c.d)}"${c.tpl ? ' data-tpl="true"' : ` data-insert="${escAttr(c.t)}"`}>${esc(c.t)}</button>`
      ).join('')}</div>
      ${s.note ? `<p class="sh-note">${esc(s.note)}</p>` : ''}
    </div>`).join('');
  querySections.innerHTML = `
    <div class="sh-section">
      <h4>Your fields <em>· click to insert</em></h4>
      <div class="sh-grid">${fieldChipsForHelp()}</div>
    </div>
    ${sections}
    <div class="sh-section">
      <h4>Examples <em>· click to load</em></h4>
      ${HELP_EXAMPLES.map(ex =>
        `<button type="button" class="sh-example" data-example="${escAttr(ex.q)}"><code>${esc(ex.q)}</code><span>${esc(ex.d)}</span></button>`
      ).join('')}
    </div>`;
}

querySections.addEventListener('mousedown', e => {
  const chip = e.target.closest('.sh-chip[data-insert]');
  const tpl = e.target.closest('.sh-chip[data-tpl]');
  const example = e.target.closest('.sh-example[data-example]');
  if (!chip && !tpl && !example) return;
  e.preventDefault(); // keep focus in the textarea while inserting
  if (tpl) {
    const fn = tpl.textContent.trim().replace(/\(field:""\)$/, '');
    insertIntoExpr(`${fn}(field:"")`, fn.length + 8);
    return;
  }
  if (chip) { insertIntoExpr(chip.dataset.insert); return; }
  exprInput.value = example.dataset.example;
  exprInput.setSelectionRange(exprInput.value.length, exprInput.value.length);
  updateExprStatus();
});

function insertIntoExpr(text, caretIn) {
  const v = exprInput.value;
  const c = exprInput.selectionStart ?? v.length;
  exprInput.value = v.slice(0, c) + text + v.slice(exprInput.selectionEnd ?? c);
  const pos = c + (caretIn !== undefined ? caretIn : text.length);
  exprInput.setSelectionRange(pos, pos);
  exprInput.focus();
  refreshExprAssist();
  scheduleExprStatus();
}

// ========== Simple builder (plain-language filters) ==========
// The default search experience. Users pick a field, a plain-word condition
// and a value; this module compiles that into a filtrex expression and hands
// it to the same evaluator Advanced mode uses. Power users can flip to
// Advanced and see the generated expression, which is also how we round-trip
// an expression back into rows (see parseSimpleExpression).
let builderSearch = '';
let builderMatch = 'all';        // 'all' | 'any'
let builderFilters = [];         // { id, field, op, value, value2 }
let builderFilterSeq = 0;

// Friendly label shown in the field dropdown. Link/tag prefixes are storage
// markers, so the dropdown shows what users think the field is called.
function builderFieldLabel(key) {
  if (key === 'name') return 'Card name';
  if (isLinkKey(key)) return 'Links to · ' + linkLabel(key);
  if (isTagKey(key)) return 'Tag · ' + tagLabel(key);
  return key;
}

// Collects the fields actually present in the current data: their sample
// values (for suggestions) and whether they read as mostly numeric (which
// unlocks the greater/less/between conditions). Hidden cards are excluded the
// same way the advanced suggestion schema excludes them.
function getBuilderFields() {
  const map = new Map();
  getVisibleSchemes().forEach(s => {
    const e = getEffective(s.id);
    Object.entries(e.fields || {}).forEach(([k, v]) => {
      let rec = map.get(k);
      if (!rec) { rec = { total: 0, numericCount: 0, freq: new Map() }; map.set(k, rec); }
      const str = v == null ? '' : String(v);
      if (str.trim() !== '') {
        rec.total++;
        if (Number.isFinite(Number(str.trim()))) rec.numericCount++;
        rec.freq.set(str, (rec.freq.get(str) || 0) + 1);
      }
    });
  });
  const fields = [];
  map.forEach((rec, key) => {
    fields.push({
      key,
      label: builderFieldLabel(key),
      numeric: rec.total > 0 && rec.numericCount / rec.total >= 0.7,
      samples: [...rec.freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(e2 => e2[0])
    });
  });
  // A pseudo-field so the card name can be filtered like any other field.
  fields.push({
    key: 'name',
    label: 'Card name',
    numeric: false,
    samples: getVisibleSchemes().map(s => getEffective(s.id).name).filter(Boolean).slice(0, 20)
  });
  fields.sort((a, b) => a.label.localeCompare(b.label));
  return fields;
}

// Conditions offered for a field. Numeric fields gain the ordering ones; the
// empty checks apply to any field because a missing value is meaningful for
// both text and numbers.
function builderOpDefs(numeric) {
  const ops = [
    { v: 'contains', label: 'contains' },
    { v: 'exactly', label: 'is exactly' },
    { v: 'not', label: 'is not' },
    { v: 'startsWith', label: 'starts with' },
    { v: 'empty', label: 'is empty' },
    { v: 'notEmpty', label: 'is not empty' }
  ];
  if (numeric) {
    ops.splice(1, 0,
      { v: 'gt', label: 'is greater than' },
      { v: 'lt', label: 'is less than' },
      { v: 'between', label: 'is between' });
  }
  return ops;
}

function builderOpHelp(op) {
  switch (op) {
    case 'contains': return 'Matches anywhere in the text, ignoring capital letters.';
    case 'exactly': return 'The whole value must match, ignoring capital letters.';
    case 'not': return 'The value must be different.';
    case 'startsWith': return 'The value begins with your text.';
    case 'empty': return 'The field is missing or blank.';
    case 'notEmpty': return 'The field has any value at all.';
    case 'gt': return 'The field is a number greater than your value.';
    case 'lt': return 'The field is a number less than your value.';
    case 'between': return 'The field is a number between the two values, inclusive.';
    default: return '';
  }
}

// ---------- Builder → expression compiler ----------
// The single place builder state becomes a filtrex expression. Keeping all
// generation here means the guided UI and the Advanced textarea can never
// drift, and the round-trip parser only has to understand what this emits.
// Values are passed as quoted string literals to the icontains-family
// helpers so quotes, parentheses and non-ASCII characters in a value can't
// break the expression; numeric comparisons emit bare numbers so the ordering
// operators work on real numbers.
function builderFieldRef(key) {
  if (key === 'name') return 'name';
  return 'field:"' + String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function quoteBuilderLiteral(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function builderIsNumber(s) {
  const t = String(s == null ? '' : s).trim();
  return t !== '' && Number.isFinite(Number(t));
}

function builderNumLiteral(s) {
  return String(Number(String(s).trim()));
}

function buildSearchClause(text) {
  const q = (text || '').trim();
  if (!q) return '';
  // Same grammar as the plain header search: spaces mean AND, | means OR.
  const groups = q.split('|')
    .map(g => g.split(/\s+/).filter(Boolean))
    .filter(g => g.length);
  if (!groups.length) return '';
  const groupExprs = groups.map(terms =>
    '(' + terms.map(t => `icontains(${BUILDER_TEXT_KEY}, ${quoteBuilderLiteral(t)})`).join(' and ') + ')');
  return groupExprs.length > 1 ? '(' + groupExprs.join(' or ') + ')' : groupExprs[0];
}

function filterRowExpr(f) {
  if (!f || !f.field) return '';
  const ref = builderFieldRef(f.field);
  const val = f.value == null ? '' : String(f.value);
  const val2 = f.value2 == null ? '' : String(f.value2);
  switch (f.op) {
    case 'contains': return val.trim() ? `icontains(${ref}, ${quoteBuilderLiteral(val)})` : '';
    case 'exactly': return val.trim() ? `iequals(${ref}, ${quoteBuilderLiteral(val)})` : '';
    case 'not': return val.trim() ? `inotequals(${ref}, ${quoteBuilderLiteral(val)})` : '';
    case 'startsWith': return val.trim() ? `istartsWith(${ref}, ${quoteBuilderLiteral(val)})` : '';
    case 'empty': return `empty(${ref})`;
    case 'notEmpty': return `not empty(${ref})`;
    case 'gt': return builderIsNumber(val) ? `${ref} > ${builderNumLiteral(val)}` : '';
    case 'lt': return builderIsNumber(val) ? `${ref} < ${builderNumLiteral(val)}` : '';
    case 'between': {
      const hasA = builderIsNumber(val), hasB = builderIsNumber(val2);
      if (hasA && hasB) return `(${ref} >= ${builderNumLiteral(val)} and ${ref} <= ${builderNumLiteral(val2)})`;
      // A half-filled range degrades to a one-sided comparison (emitted with
      // strict operators so it round-trips back to greater/less-than).
      if (hasA) return `${ref} > ${builderNumLiteral(val)}`;
      if (hasB) return `${ref} < ${builderNumLiteral(val2)}`;
      return '';
    }
    default: return '';
  }
}

function buildFiltersClause() {
  const atoms = builderFilters.map(filterRowExpr).filter(Boolean);
  if (!atoms.length) return '';
  const joined = atoms.map(a => '(' + a + ')').join(builderMatch === 'any' ? ' or ' : ' and ');
  return '(' + joined + ')';
}

function buildSimpleExpression() {
  const searchExpr = buildSearchClause(builderSearch);
  const filtersExpr = buildFiltersClause();
  if (searchExpr && filtersExpr) return `${searchExpr} and ${filtersExpr}`;
  return searchExpr || filtersExpr || '';
}

// ---------- Expression → builder parser (round-trip) ----------
// Recognises exactly the shapes buildSimpleExpression emits (plus the same
// atoms typed by hand), so Simple ↔ Advanced switching never silently drops
// a query. Returns null when the expression uses anything the builder can't
// represent; the caller then keeps the expression and explains why.

// Removes one balanced wrapping pair of parentheses, or leaves the string
// untouched if the outer pair isn't a matching wrapper.
function stripOneOuterParen(s) {
  s = s.trim();
  if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') return s;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0 && i !== s.length - 1) return s; }
  }
  return depth === 0 ? s.slice(1, -1).trim() : s;
}

// Splits on a separator that sits at parenthesis depth 0 and outside strings.
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, i = 0, start = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && s.startsWith(sep, i)) { parts.push(s.slice(start, i)); i += sep.length; start = i; continue; }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

function unquoteBuilderLiteral(s) {
  s = String(s).trim();
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return null;
  return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

const PARSE_REF = '(?:name|field\\s*:\\s*"(?:[^"\\\\]|\\\\.)*")';
const PARSE_LIT = '"(?:[^"\\\\]|\\\\.)*"';
const PARSE_NUM = '-?\\d+(?:\\.\\d+)?';

function parseFieldRef(ref) {
  ref = String(ref).trim();
  if (ref === 'name') return 'name';
  const m = ref.match(/^field\s*:\s*"((?:[^"\\]|\\.)*)"$/);
  if (!m) return null;
  return m[1].replace(/\\(["\\])/g, '$1');
}

function parseFilterAtom(atom) {
  atom = stripOneOuterParen(atom);
  let m;
  const unary = (re, op) => {
    const mm = atom.match(re);
    if (!mm) return null;
    const k = parseFieldRef(mm[1]);
    const v = unquoteBuilderLiteral(mm[2]);
    if (k === null || v === null) return null;
    return { field: k, op, value: v };
  };
  let res;
  res = unary(new RegExp('^icontains\\s*\\(\\s*(' + PARSE_REF + ')\\s*,\\s*(' + PARSE_LIT + ')\\s*\\)$'), 'contains');
  if (res) return res;
  res = unary(new RegExp('^istartsWith\\s*\\(\\s*(' + PARSE_REF + ')\\s*,\\s*(' + PARSE_LIT + ')\\s*\\)$'), 'startsWith');
  if (res) return res;
  res = unary(new RegExp('^iequals\\s*\\(\\s*(' + PARSE_REF + ')\\s*,\\s*(' + PARSE_LIT + ')\\s*\\)$'), 'exactly');
  if (res) return res;
  res = unary(new RegExp('^inotequals\\s*\\(\\s*(' + PARSE_REF + ')\\s*,\\s*(' + PARSE_LIT + ')\\s*\\)$'), 'not');
  if (res) return res;

  m = atom.match(new RegExp('^not\\s+empty\\s*\\(\\s*(' + PARSE_REF + ')\\s*\\)$'));
  if (m) { const k = parseFieldRef(m[1]); return k === null ? null : { field: k, op: 'notEmpty' }; }
  m = atom.match(new RegExp('^empty\\s*\\(\\s*(' + PARSE_REF + ')\\s*\\)$'));
  if (m) { const k = parseFieldRef(m[1]); return k === null ? null : { field: k, op: 'empty' }; }

  m = atom.match(new RegExp('^(' + PARSE_REF + ')\\s*>=\\s*(' + PARSE_NUM + ')\\s+and\\s+(' + PARSE_REF + ')\\s*<=\\s*(' + PARSE_NUM + ')$'));
  if (m) {
    const k1 = parseFieldRef(m[1]), k2 = parseFieldRef(m[3]);
    if (k1 !== null && k1 === k2) return { field: k1, op: 'between', value: m[2], value2: m[4] };
    return null;
  }
  m = atom.match(new RegExp('^(' + PARSE_REF + ')\\s*>\\s*(' + PARSE_NUM + ')$'));
  if (m) { const k = parseFieldRef(m[1]); return k === null ? null : { field: k, op: 'gt', value: m[2] }; }
  m = atom.match(new RegExp('^(' + PARSE_REF + ')\\s*<\\s*(' + PARSE_NUM + ')$'));
  if (m) { const k = parseFieldRef(m[1]); return k === null ? null : { field: k, op: 'lt', value: m[2] }; }
  return null;
}

function parseSearchClause(p) {
  p = stripOneOuterParen(p);
  const orGroups = splitTopLevel(p, ' or ');
  const wordGroups = [];
  for (const g of orGroups) {
    const inner = stripOneOuterParen(g);
    const terms = splitTopLevel(inner, ' and ');
    const words = [];
    for (const t of terms) {
      const m = stripOneOuterParen(t).match(
        new RegExp('^icontains\\s*\\(\\s*' + BUILDER_TEXT_KEY + '\\s*,\\s*(' + PARSE_LIT + ')\\s*\\)$'));
      if (!m) return null;
      const lit = unquoteBuilderLiteral(m[1]);
      if (lit === null) return null;
      words.push(lit);
    }
    wordGroups.push(words.join(' '));
  }
  return wordGroups.join(' | ');
}

function parseFiltersClause(p) {
  p = stripOneOuterParen(p);
  const orParts = splitTopLevel(p, ' or ');
  const andParts = splitTopLevel(p, ' and ');
  let atoms, match;
  if (orParts.length > 1 && andParts.length > 1) return null; // mixed → too custom
  if (orParts.length > 1) { atoms = orParts; match = 'any'; }
  else { atoms = andParts; match = 'all'; }
  const filters = [];
  for (const a of atoms) {
    const f = parseFilterAtom(a);
    if (!f) return null;
    filters.push(f);
  }
  return { match, filters };
}

function parseSimpleExpression(expr) {
  const src = (expr || '').trim();
  if (!src) return { search: '', match: 'all', filters: [] };
  const rawParts = splitTopLevel(src, ' and ');
  let search = null, filters = null;
  for (const raw of rawParts) {
    const p = stripOneOuterParen(raw);
    if (p.includes(BUILDER_TEXT_KEY)) {
      if (search !== null) return null;      // two text clauses — not ours
      search = parseSearchClause(p);
      if (search === null) return null;
    } else {
      if (filters !== null) return null;     // two filter clauses — not ours
      filters = parseFiltersClause(p);
      if (filters === null) return null;
    }
  }
  return {
    search: search || '',
    match: filters ? filters.match : 'all',
    filters: filters ? filters.filters : []
  };
}

// ---------- Simple builder rendering ----------
function filterRowHtml(f, fields, byKey) {
  const info = byKey.get(f.field);
  const numeric = !!(info && info.numeric);
  const opDefs = builderOpDefs(numeric);
  if (!opDefs.some(o => o.v === f.op)) f.op = 'contains';
  const showValue = f.op !== 'empty' && f.op !== 'notEmpty';
  const isBetween = f.op === 'between';
  const samples = info ? info.samples : [];
  const listId = 'filter-vals-' + f.id;
  const fieldId = 'filter-field-' + f.id;
  const fieldOptions = ['<option value="">Choose a field…</option>']
    .concat(fields.map(x => `<option value="${escAttr(x.key)}"${x.key === f.field ? ' selected' : ''}>${esc(x.label)}</option>`))
    .join('');
  const opOptions = opDefs.map(o => `<option value="${o.v}"${o.v === f.op ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  let valueHtml = '';
  if (showValue) {
    valueHtml = isBetween
      ? `<input type="text" class="filter-value" list="${listId}" value="${escAttr(f.value)}" placeholder="from" inputmode="decimal" aria-label="From value" />`
        + `<span class="filter-and">and</span>`
        + `<input type="text" class="filter-value filter-value2" list="${listId}" value="${escAttr(f.value2)}" placeholder="to" inputmode="decimal" aria-label="To value" />`
      : `<input type="text" class="filter-value" list="${listId}" value="${escAttr(f.value)}" placeholder="value" aria-label="Filter value" />`;
  }
  const datalist = samples.length
    ? `<datalist id="${listId}">${samples.map(s => `<option value="${escAttr(s)}"></option>`).join('')}</datalist>`
    : '';
  const help = builderOpHelp(f.op);
  return `<div class="filter-row" data-id="${f.id}">
    <div class="filter-row-main">
      <label class="sr-only" for="${fieldId}">Field</label>
      <select class="filter-field" id="${fieldId}">${fieldOptions}</select>
      <select class="filter-op" aria-label="Condition">${opOptions}</select>
      <div class="filter-value-wrap">${valueHtml}</div>
      <button type="button" class="filter-remove" title="Remove filter" aria-label="Remove filter">&times;</button>
    </div>
    ${help ? `<p class="filter-help">${esc(help)}</p>` : ''}
    ${datalist}
  </div>`;
}

function renderSimpleFilters() {
  const fields = getBuilderFields();
  const byKey = new Map(fields.map(f => [f.key, f]));
  if (!builderFilters.length) {
    simpleFilters.innerHTML = '<p class="simple-empty">No filters yet — use the search box above, or add a filter.</p>';
    return;
  }
  simpleFilters.innerHTML = builderFilters.map(f => filterRowHtml(f, fields, byKey)).join('');
}

function focusFilterControl(id, selector) {
  const row = simpleFilters.querySelector(`[data-id="${id}"]`);
  const el = row && row.querySelector(selector);
  if (el) el.focus();
}

function addFilter(init) {
  const f = Object.assign(
    { id: 'bf' + (++builderFilterSeq), field: '', op: 'contains', value: '', value2: '' },
    init || {});
  builderFilters.push(f);
  renderSimpleFilters();
  refreshSimpleStatus();
  if (!f.field) focusFilterControl(f.id, '.filter-field');
  else focusFilterControl(f.id, '.filter-value');
  return f;
}

function renderSimpleExamples() {
  const chips = [];
  const tagField = getBuilderFields().find(f => isTagKey(f.key));
  if (tagField) chips.push({ label: 'Schemes with a tag', apply: () => addFilter({ field: tagField.key, op: 'notEmpty' }) });
  chips.push({ label: 'A field is empty', apply: () => addFilter({ field: '', op: 'empty' }) });
  chips.push({ label: 'Card name contains “tank”', apply: () => addFilter({ field: 'name', op: 'contains', value: 'tank' }) });
  simpleExamples._chips = chips;
  simpleExamples.innerHTML = chips.map((c, i) => `<button type="button" class="simple-chip" data-i="${i}">${esc(c.label)}</button>`).join('');
}

function syncSimpleMatchButtons() {
  simpleMatchGroup.querySelectorAll('.simple-match-btn').forEach(b => {
    const on = b.dataset.match === builderMatch;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

// ---------- Simple builder feedback ----------
let simpleCountTimer = null;
function scheduleSimpleCount() {
  clearTimeout(simpleCountTimer);
  simpleCountTimer = setTimeout(refreshSimpleStatus, 150);
}

function refreshSimpleStatus() {
  clearTimeout(simpleCountTimer);
  simpleCountTimer = null;
  const total = getVisibleSchemes().length;
  const expr = buildSimpleExpression();
  if (!expr) {
    simpleStatus.className = 'simple-status';
    simpleStatus.textContent = 'Type in the box or add a filter to narrow the list.';
    return;
  }
  const n = countExprMatches(expr) || 0;
  if (n === 0) {
    simpleStatus.className = 'simple-status empty';
    simpleStatus.textContent = 'No schemes match. Try removing a filter or checking the spelling.';
  } else {
    simpleStatus.className = 'simple-status ok';
    simpleStatus.textContent = `${n} of ${total} scheme${total !== 1 ? 's' : ''} match`;
  }
}

// A short, human summary for the header pill so Simple mode never shows raw
// syntax in the chrome (the expression is still available in Advanced).
function simpleSummaryLabel() {
  const q = builderSearch.trim();
  const n = builderFilters.filter(f => f.field && filterRowExpr(f)).length;
  const bits = [];
  if (q) bits.push(q.length > 24 ? q.slice(0, 23) + '…' : q);
  if (n) bits.push(n + (n === 1 ? ' filter' : ' filters'));
  if (n > 1) bits.push(builderMatch === 'any' ? 'match any' : 'match all');
  return bits.join(' · ') || 'filters';
}

// ---------- Simple panel wiring ----------
simpleSearchInput.addEventListener('input', () => {
  builderSearch = simpleSearchInput.value;
  scheduleSimpleCount();
});
simpleSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); applySimpleFilter(); }
});
simpleMatchGroup.addEventListener('click', e => {
  const btn = e.target.closest('.simple-match-btn');
  if (!btn || btn.dataset.match === builderMatch) return;
  builderMatch = btn.dataset.match;
  syncSimpleMatchButtons();
  refreshSimpleStatus();
});
addFilterBtn.addEventListener('click', () => addFilter({}));
clearFiltersBtn.addEventListener('click', () => {
  builderSearch = '';
  builderFilters = [];
  simpleSearchInput.value = '';
  renderSimpleFilters();
  syncSimpleMatchButtons();
  refreshSimpleStatus();
  simpleSearchInput.focus();
});
simpleFilters.addEventListener('change', e => {
  const row = e.target.closest('.filter-row');
  if (!row) return;
  const f = builderFilters.find(x => x.id === row.dataset.id);
  if (!f) return;
  if (e.target.classList.contains('filter-field')) {
    f.field = e.target.value;
    renderSimpleFilters();
    focusFilterControl(f.id, '.filter-op');
  } else if (e.target.classList.contains('filter-op')) {
    f.op = e.target.value;
    renderSimpleFilters();
    if (f.op !== 'empty' && f.op !== 'notEmpty') focusFilterControl(f.id, '.filter-value');
  }
  refreshSimpleStatus();
});
simpleFilters.addEventListener('input', e => {
  const row = e.target.closest('.filter-row');
  if (!row) return;
  const f = builderFilters.find(x => x.id === row.dataset.id);
  if (!f) return;
  if (e.target.classList.contains('filter-value2')) f.value2 = e.target.value;
  else if (e.target.classList.contains('filter-value')) f.value = e.target.value;
  scheduleSimpleCount();
});
simpleFilters.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('filter-value')) {
    e.preventDefault();
    applySimpleFilter();
  }
});
simpleFilters.addEventListener('click', e => {
  const btn = e.target.closest('.filter-remove');
  if (!btn) return;
  const row = btn.closest('.filter-row');
  if (!row) return;
  builderFilters = builderFilters.filter(x => x.id !== row.dataset.id);
  renderSimpleFilters();
  refreshSimpleStatus();
});
simpleExamples.addEventListener('click', e => {
  const btn = e.target.closest('.simple-chip');
  if (!btn) return;
  const chips = simpleExamples._chips || [];
  const c = chips[Number(btn.dataset.i)];
  if (c) c.apply();
});

// ---------- Mode switching ----------
function showSimpleMode() {
  simplePanel.classList.remove('hidden');
  advancedPanel.classList.add('hidden');
  advancedToggle.classList.remove('hidden');
  simpleToggle.classList.add('hidden');
  queryRoundTripNote.classList.add('hidden');
  simpleSearchInput.value = builderSearch;
  syncSimpleMatchButtons();
  renderSimpleFilters();
  renderSimpleExamples();
  refreshSimpleStatus();
}

function showAdvancedMode() {
  // Generate the current builder as the starting expression so switching
  // teaches the syntax by example instead of discarding the filters.
  exprInput.value = buildSimpleExpression();
  simplePanel.classList.add('hidden');
  advancedPanel.classList.remove('hidden');
  advancedToggle.classList.add('hidden');
  simpleToggle.classList.remove('hidden');
  queryRoundTripNote.classList.add('hidden');
  buildQuerySections();
  hideSuggest();
  updateExprStatus();
  exprInput.focus();
  exprInput.setSelectionRange(exprInput.value.length, exprInput.value.length);
}

function switchToSimple() {
  const parsed = parseSimpleExpression(exprInput.value);
  if (!parsed) {
    // Keep the expression intact and say why it can't be shown as filters.
    queryRoundTripNote.textContent = 'This search is too custom to show as simple filters. Your expression is kept as it is.';
    queryRoundTripNote.classList.remove('hidden');
    return;
  }
  builderSearch = parsed.search;
  builderMatch = parsed.match;
  builderFilters = parsed.filters.map(f => Object.assign(
    { id: 'bf' + (++builderFilterSeq), value: '', value2: '' }, f));
  showSimpleMode();
  simpleSearchInput.focus();
}

advancedToggle.addEventListener('click', showAdvancedMode);
simpleToggle.addEventListener('click', switchToSimple);

// ---------- Modal lifecycle ----------
function syncHeaderChrome() {
  const filterActive = searchMode === 'expr' || searchMode === 'simple';
  // With a filter active the input yields to a pill naming the filter, so the
  // mode is legible at a glance. Simple mode shows a plain summary; Advanced
  // shows the expression itself.
  searchWrapper.classList.toggle('mode-expr', filterActive);
  exprPill.classList.toggle('hidden', !filterActive);
  if (filterActive) {
    const label = searchMode === 'simple' ? simpleSummaryLabel() : exprFilter;
    const title = searchMode === 'simple'
      ? 'Filtering with simple filters — click to edit'
      : `Filtering by: ${exprFilter}`;
    if (exprPillText.textContent !== label || exprPill.title !== title) {
      exprPillText.textContent = label;
      exprPill.title = title;
    }
  }
  exprModeBtn.classList.toggle('active', filterActive);
  searchClearBtn.classList.toggle('hidden', filterActive || searchInput.value.length === 0);
}

function openQueryModal() {
  const filterActive = (searchMode === 'expr' || searchMode === 'simple') && exprFilter;
  exprRemoveBtn.classList.toggle('hidden', !filterActive);
  queryModal.classList.remove('hidden');
  if (searchMode === 'expr' && exprFilter) {
    // Reopening an expert search drops straight into Advanced so the raw text
    // is exactly as applied.
    simplePanel.classList.add('hidden');
    advancedPanel.classList.remove('hidden');
    advancedToggle.classList.add('hidden');
    simpleToggle.classList.remove('hidden');
    queryRoundTripNote.classList.add('hidden');
    exprInput.value = exprFilter;
    buildQuerySections();
    hideSuggest();
    updateExprStatus();
    exprInput.focus();
    exprInput.setSelectionRange(exprInput.value.length, exprInput.value.length);
  } else {
    // Default entry: the guided builder. Any already-applied simple filter is
    // still in state and reappears.
    showSimpleMode();
    simpleSearchInput.focus();
  }
}

function closeQueryModal() {
  queryModal.classList.add('hidden');
  clearTimeout(exprStatusTimer);
  exprStatusTimer = null;
  clearTimeout(simpleCountTimer);
  simpleCountTimer = null;
  hideSuggest();
}

function applyExprFromEditor() {
  const q = exprInput.value.trim();
  if (!q || isExprInvalid(q)) { updateExprStatus(); return; }
  exprFilter = q;
  searchMode = 'expr';
  syncHeaderChrome();
  render();
  closeQueryModal();
  const matches = countExprMatches(q);
  showToast(`ƒx filter applied · ${matches} matching card${matches === 1 ? '' : 's'}`);
}

// Applies the guided builder. Everything is compiled through
// buildSimpleExpression and evaluated by the same path as Advanced mode; an
// empty builder means "no filter", which clears the search.
function applySimpleFilter() {
  const expr = buildSimpleExpression();
  if (!expr) {
    exitExprMode();
    closeQueryModal();
    return;
  }
  exprFilter = expr;
  searchMode = 'simple';
  syncHeaderChrome();
  render();
  closeQueryModal();
  const n = countExprMatches(expr) || 0;
  showToast(`Filters applied · ${n} matching scheme${n === 1 ? '' : 's'}`);
}

function exitExprMode() {
  searchMode = 'text';
  exprFilter = '';
  // Clearing a simple filter resets the builder too, so reopening starts
  // fresh rather than resurrecting the filter the user just removed.
  builderSearch = '';
  builderMatch = 'all';
  builderFilters = [];
  syncHeaderChrome();
  render();
}

exprApplyBtn.addEventListener('click', () => {
  if (advancedPanel.classList.contains('hidden')) applySimpleFilter();
  else applyExprFromEditor();
});
exprCancelBtn.addEventListener('click', closeQueryModal);
queryModalClose.addEventListener('click', closeQueryModal);
exprRemoveBtn.addEventListener('click', () => { exitExprMode(); closeQueryModal(); });
exprModeBtn.addEventListener('click', openQueryModal);
exprPill.addEventListener('click', openQueryModal);
exprPillExit.addEventListener('click', e => {
  // The pill opens the editor; × only removes the filter.
  e.stopPropagation();
  exitExprMode();
  searchInput.focus();
});

// ========== Bulk Operations ==========
bulkSelectAllBtn.addEventListener('click', () => {
  // Respect the active search: only cards currently matching are selected.
  const visibleSchemes = getVisibleSchemes()
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
let bulkGroupRowIndex = 0;

function addBulkRow(type, key = '') {
  const isGroup = type === 'group';
  const idx = isGroup ? bulkGroupRowIndex++ : bulkFieldRowIndex++;
  const row = document.createElement('div');
  row.className = 'dynamic-field-row' + (type === 'field' ? '' : ` ${type}-row`);
  row.innerHTML = isGroup
    ? `<span class="drag-handle" draggable="true">⠿</span>
       <span class="group-icon">📁</span>
       <input type="text" class="group-name-input" name="bulk_group_name_${idx}" placeholder="Group name" value="${esc(key)}" />
       <button class="remove-field" type="button" title="Remove group">&times;</button>`
    : (type === 'tag'
      ? `<span class="drag-handle" draggable="true">⠿</span>
         <span class="row-type-icon" aria-hidden="true">🏷️</span>
         <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Tag name" value="${esc(key)}" list="tagNameSuggestions" />
         <button class="remove-field" type="button">&times;</button>`
      : `<span class="drag-handle" draggable="true">⠿</span>
         <input type="text" class="field-key-input" name="bulk_field_key_${idx}" placeholder="Field name" value="${esc(key)}" list="bulkFieldKeySuggestions" />
         <button class="remove-field" type="button">&times;</button>`);
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
  // Refresh every suggestion list: the shared tag/link datalists are
  // otherwise only updated by the single-card edit modal, so opening bulk
  // directly would offer stale (or empty) suggestions.
  updateFieldSuggestions();
  updateBulkFieldSuggestions();
  addBulkRow('field');
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
bulkAddFieldBtn.addEventListener('click', () => addBulkRow('field'));
bulkAddGroupBtn.addEventListener('click', () => addBulkRow('group'));
bulkAddLinkBtn.addEventListener('click', () => addBulkRow('link'));
bulkAddTagBtn.addEventListener('click', () => addBulkRow('tag'));

bulkModalNext.addEventListener('click', () => {
  const { rows, groups } = parseFieldRows(bulkDynamicFields);
  const fieldKeys = rows.map(r => r.key);
  const groupsData = groups.map(g => ({ name: g.name, fields: g.fieldKeys }));

  if (fieldKeys.length === 0) {
    alert('Add at least one field first.');
    return;
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
      const existing = e && e.fields ? (e.fields[k] ?? '') : '';
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

  const stagedCount = bulkGrid.querySelectorAll('tr[data-scheme-id]').length;

  exitSelectionMode();
  closeBulkModal();
  showToast(`Fields staged for ${stagedCount} card(s)`);
});

// ========== Commit / Discard ==========
// When a scheme is renamed, every → link naming it would go stale. Rewrite
// the old name in all other schemes' link fields (base records and any
// staged changes) so references survive the rename.
// Returns extra records to include in the commit batch instead of writing
// them itself — commit must stay all-or-nothing, so nothing is persisted
// until the whole batch succeeds.
function planRenamePropagation() {
  const extraPuts = [];
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
        // Its own commit record will carry the rewritten dicts.
        if (staged.fields || fieldsRes.changed) staged.fields = fieldsRes.dict;
        if (staged.hiddenFields || hiddenRes.changed) staged.hiddenFields = hiddenRes.dict;
      } else {
        const target = findScheme(s.id);
        if (target) extraPuts.push({ ...target, fields: fieldsRes.dict, hiddenFields: hiddenRes.dict, uid: target.uid || stableUidForScheme(target) });
      }
    }
  }
  return extraPuts;
}

let committing = false;

commitBtn.addEventListener('click', async () => {
  // Re-entry guard: a second click while the batch is in flight would run
  // the same loop twice and duplicate every new card.
  if (committing) return;
  committing = true;
  commitBtn.disabled = true;
  try {
    const extraPuts = planRenamePropagation();
    const puts = [];
    const adds = [];
    let skipped = 0;

    for (const [id, changes] of pendingChanges) {
      if (isNewId(id)) {
        const { id: _discard, ...schemeData } = { ...getEffective(id) };
        if (!schemeData.name) { skipped++; continue; }
        delete schemeData.id;
        adds.push({ uid: generateUid(), ...schemeData });
      } else {
        const base = findScheme(id);
        if (!base) { skipped++; continue; }
        puts.push({ ...base, ...changes, uid: changes.uid || base.uid || stableUidForScheme({ ...base, ...changes }) });
      }
    }
    const stagedCount = puts.length + adds.length;

    // Rename rewrites for cards without their own staged changes; cards that
    // are also being committed already carry the rewrite via their staged
    // merge above, so only add extras for ids not already in puts.
    const putIds = new Set(puts.map(p => p.id));
    for (const rec of extraPuts) {
      if (putIds.has(rec.id)) continue;
      puts.push({ uid: rec.uid || stableUidForScheme(rec), ...rec });
    }

    // One transaction: either every card commits or the database is untouched.
    await dbCommit({ puts, adds });
    pendingChanges.clear();
    await loadSchemes();
    noteLocalChange();
    exitSelectionMode();
    showToast(`${stagedCount} change${stagedCount !== 1 ? 's' : ''} committed${skipped ? ` (${skipped} skipped)` : ''}`);
  } catch (err) {
    console.error(err);
    // pendingChanges is untouched and the transaction rolled back, so the
    // user can simply retry.
    showToast('Commit failed — no changes were written. Please retry.');
  } finally {
    committing = false;
    commitBtn.disabled = false;
  }
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
  getVisibleSchemes().forEach(s => {
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
  updateTablePreview();
  pivotModal.classList.remove('hidden');
}

pivotBtn.addEventListener('click', openPivotModal);
pivotModalClose.addEventListener('click', () => pivotModal.classList.add('hidden'));

pivotModal.addEventListener('click', e => {
  const btn = e.target.closest('.check-all-btn, .check-none-btn');
  if (!btn) return;
  const targetId = btn.dataset.target;
  const container = document.getElementById(targetId);
  if (!container) return;
  const check = btn.classList.contains('check-all-btn');
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = check);
  // Programmatic checks don't fire change events — refresh the preview here.
  scheduleTablePreview();
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

// Shared table builder: returns { html, shown, total } or null when no
// row/column field is selected. maxRows caps rendered rows so the live
// preview stays compact; Generate passes Infinity for the full table.
function buildTableParts(maxRows) {
  const rowKeys = getCheckedValues(pivotRows);
  const colKeys = getCheckedValues(pivotCols);
  const valKey = pivotValues.value;
  const agg = pivotAgg.value;
  const format = pivotFormat.value;
  const isComma = agg === 'comma' || agg === 'comma-distinct';

  if (!rowKeys.length && !colKeys.length) return null;

  const filtered = schemes.filter(s => {
    const e = getEffective(s.id);
    return (showHidden ? true : !e.hidden) &&
      cellMatches(searchMatchMode, e.name, searchQuery.trim());
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

    let shown = 0;
    for (const r of records) {
      if (shown >= maxRows) break;
      html += '<tr>';
      r.rowParts.forEach(p => html += `<td>${esc(p)}</td>`);
      r.colParts.forEach(p => html += `<td>${esc(p)}</td>`);
      html += '</tr>';
      shown++;
    }

    html += '</tbody></table>';
    return { html, shown, total: records.length };
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

  const shownRowLabels = rowLabels.filter(r => r !== totalLabel).slice(0, maxRows);
  shownRowLabels.forEach(r => {
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
  if (shownRowLabels.length > 1 && showTotals) {
    html += '<tr><td><strong>Total</strong></td>';
    colLabels.forEach(c => {
      let colTotal = 0;
      shownRowLabels.forEach(r => {
        colTotal += Number(cellVal(r, c));
      });
      html += `<td>${colTotal}</td>`;
    });
    let grandTotal = 0;
    shownRowLabels.forEach(r => {
      colLabels.forEach(c => {
        grandTotal += Number(cellVal(r, c));
      });
    });
    html += `<td>${grandTotal}</td></tr>`;
  }

  html += '</tbody></table>';
  return { html, shown: shownRowLabels.length, total: records.length };
}

generatePivotBtn.addEventListener('click', () => {
  const built = buildTableParts(Infinity);
  if (!built) {
    alert('Select at least one row or column field.');
    return;
  }
  pivotResult.innerHTML = built.total === 0 ? '<p>No data to display.</p>' : built.html;
  pivotExportBar.classList.toggle('hidden', built.total === 0);
});

// ---------- Live preview ----------
// A compact version of the real table, rebuilt from actual data on every
// selection change, so the shape of the report is visible before generating.
const AGG_VERBS = { count: 'count', sum: 'sum', avg: 'average', comma: 'list', 'comma-distinct': 'unique list' };
const PREVIEW_MAX_ROWS = 8;

function updateTablePreview() {
  const rowKeys = getCheckedValues(pivotRows);
  const colKeys = getCheckedValues(pivotCols);
  const dims = [];
  if (rowKeys.length) dims.push(rowKeys.join(' + '));
  if (colKeys.length) dims.push(colKeys.join(' + '));
  tablePreviewSummary.textContent = dims.length
    ? `${AGG_VERBS[pivotAgg.value] || pivotAgg.value} of ${pivotValues.value} by ${dims.join(' × ')}`
    : '';

  const built = buildTableParts(PREVIEW_MAX_ROWS);
  if (!built) {
    tablePreviewBody.innerHTML = '<p class="table-preview-empty">Select at least one row or column field to see the table.</p>';
    return;
  }
  if (built.total === 0) {
    tablePreviewBody.innerHTML = '<p class="table-preview-empty">No cards match the current search.</p>';
    return;
  }
  const note = built.shown < built.total
    ? `<p class="table-preview-note">Showing ${built.shown} of ${built.total} rows — generate for the full table.</p>`
    : '';
  tablePreviewBody.innerHTML = built.html + note;
}

let previewTimer = null;
function scheduleTablePreview() {
  // Selections changed: a previously generated result is now stale.
  pivotResult.innerHTML = '';
  pivotExportBar.classList.add('hidden');
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateTablePreview, 120);
}

pivotModal.addEventListener('change', e => {
  if (e.target.closest('.pivot-controls')) scheduleTablePreview();
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
function getExportData() {
  return schemes.map(s => toExportShape(getEffective(s.id)));
}

async function importSchemesData(data, replaceMode) {
  if (!Array.isArray(data) || data.length === 0 || !data.every(s => s && typeof s === 'object' && s.name)) {
    alert('Invalid format: expected a non-empty array of objects with at least a "name" property.');
    return false;
  }
  // An import replaces the whole store; staged edits reference card ids that
  // will no longer exist afterwards (and staged _new_N cards would be wiped
  // from memory by the reload, then committed later as empty junk records).
  if (pendingChanges.size > 0) {
    alert(`You have ${pendingChanges.size} uncommitted change(s). Commit or discard them before importing.`);
    return false;
  }
  // Clearing and re-adding in one transaction: any bad record aborts the
  // whole import instead of leaving the database emptied or half-written.
  const records = data.map((s, i) => normalizeScheme(s, i));
  try {
    await dbCommit(replaceMode ? { puts: [], adds: records, clear: true } : { adds: records });
  } catch (err) {
    console.error(err);
    alert('Import failed — the existing data was left unchanged.');
    return false;
  }
  await loadSchemes();
  noteLocalChange();
  return true;
}

function exportJSON() {
  const data = getExportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `schemes-${new Date().toISOString().slice(0, 10)}.json`);
  showToast('Data exported');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch (err) {
      alert('Failed to parse JSON file: ' + err.message);
      return;
    }
    // Validate BEFORE asking "replace or append" so a wrong/garbage file can
    // never tempt the user into confirming a wipe that then half-fails.
    if (!Array.isArray(data) || data.length === 0 || !data.every(s => s && typeof s === 'object' && s.name)) {
      alert('Invalid format: expected a non-empty array of objects with at least a "name" property.');
      return;
    }
    const mode = confirm('Click OK to replace all data, or Cancel to append to existing data.');
    if (await importSchemesData(data, mode)) {
      showToast(`Imported ${data.length} card${data.length !== 1 ? 's' : ''}`);
    }
  };
  reader.readAsText(file);
}

// ========== Data Menu ==========
function openDataMenuModal() {
  // All Drive labels/state are owned by driveUI() in the sync section.
  driveUI();
  dataMenuModal.classList.remove('hidden');
}

function closeDataMenuModal() {
  dataMenuModal.classList.add('hidden');
}

dataMenuBtn.addEventListener('click', openDataMenuModal);
dataMenuClose.addEventListener('click', closeDataMenuModal);

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

// ========== Google Drive sync ==========
/* Design (shared with the time-dial app)
   - Local changes are detected by CONTENT HASH (canonical, normalized JSON) against the hash of the
     last successful sync. Only COMMITTED data is hashed: staged (pendingChanges) edits are never
     uploaded, and a sync pass that would apply remote data is refused while work is staged.
   - Remote changes are detected from Drive file metadata (md5Checksum/version): one tiny GET, no
     download unless the bytes actually changed.
   - Decision flow: neither changed -> nothing; remote only -> pull; local only -> push; both ->
     three-way merge (per-card, keyed by uid, local wins same-field conflicts, losing copies kept).
   - Remote data is applied through applyLocal (never through the commit button), and sync state is
     stored only after success, so applying remote data can never queue an upload of the same data.
   - Sign-in uses Google Identity Services' popup token flow. It needs the page ORIGIN listed under
     "Authorized JavaScript origins"; it does not use redirect URIs. */

/* ==SYNC-CORE-BEGIN== */
const SyncCore=(function(){
'use strict';
const SECRET=/ya29\.[\w.-]+|Bearer\s+[\w.~+\/=-]+|(?:access_token|refresh_token|client_secret|id_token)=[^&\s"']+|"(?:access_token|refresh_token|client_secret|id_token)"\s*:\s*"[^"]*"/gi;
const scrub=s=>String(s==null?'':s).replace(SECRET,'[redacted]');

class SyncError extends Error{
  constructor(code,message,x={}){super(scrub(message));this.name='SyncError';this.code=code;
    this.retryable=!!x.retryable;this.needsAuth=!!x.needsAuth;this.offline=!!x.offline;this.cancelled=!!x.cancelled;this.status=x.status||0}}
const asSyncError=e=>e instanceof SyncError?e:new SyncError('UNEXPECTED','Unexpected sync error: '+scrub(e&&e.message||e));

/* ---- canonical form + hash ---- */
function canon(v){
  if(v===undefined)return'∅';
  const w=x=>{if(Array.isArray(x))return x.map(w);
    if(x&&typeof x==='object'){const o={};Object.keys(x).sort().forEach(k=>{if(x[k]!==undefined)o[k]=w(x[k])});return o}
    return x};
  return JSON.stringify(w(v))}
function hashStr(s){let h1=0xdeadbeef,h2=0x41c6ce57;
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677)}
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return(h2>>>0).toString(16).padStart(8,'0')+(h1>>>0).toString(16).padStart(8,'0')+'-'+s.length.toString(16)}
const snapOf=obj=>{const str=canon(obj);return{obj,str,hash:hashStr(str)}};
const eq=(a,b)=>canon(a)===canon(b);
const asList=d=>Array.isArray(d)?d:[];
const isEmpty=d=>asList(d).length===0;

/* ---- three-way merge (base, local, remote) ----
   Policy: cards are keyed by their stable uid. Untouched side yields to the changed side (including
   deletions); an edit beats a delete; when both edited the same card, fields merge individually,
   primitive lists (e.g. groups) merge as sets, and a genuine same-field conflict is won by LOCAL
   (the device the user is holding). The remote snapshot is always kept as a backup by the engine, so
   nothing is lost silently. A null base behaves as "empty". */
const isPrimArr=a=>Array.isArray(a)&&a.every(x=>x===null||typeof x!=='object');
const isObj=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
function mergeVal(b,l,r){
  if(eq(l,r))return l;if(eq(l,b))return r;if(eq(r,b))return l;
  if(isPrimArr(l)&&isPrimArr(r)&&(b===undefined||isPrimArr(b))){
    const B=new Set(b||[]),L=new Set(l),R=new Set(r);
    return[...new Set([...l,...r])].filter(x=>!B.has(x)||(L.has(x)&&R.has(x)))}
  /* A card's content lives in nested dicts (fields/hiddenFields), so recurse
     into plain objects. Arrays of objects (groups) are treated as one value and
     follow the local-wins policy. */
  if(isObj(l)&&isObj(r)&&(b===undefined||isObj(b)))return mergeFields(b||{},l,r);
  return l}
function mergeFields(b,l,r){const out={};
  b=b||{};l=l||{};r=r||{};
  for(const k of new Set([...Object.keys(l),...Object.keys(r)])){const v=mergeVal(b[k],l[k],r[k]);if(v!==undefined)out[k]=v}
  return out}
function mergeItem(b,l,r){
  if(eq(l,r))return l;if(eq(l,b))return r;if(eq(r,b))return l;
  if(l===undefined)return r;if(r===undefined)return l;
  return mergeFields(b||{},l,r)}
function mergeList(b,l,r){
  const idx=a=>new Map(asList(a).map(x=>[x.uid,x]));
  const B=idx(b),L=idx(l),R=idx(r),out=[],seen=new Set();
  /* Keep LOCAL order first, then append cards only the remote has. */
  for(const x of asList(l)){const v=mergeItem(B.get(x.uid),L.get(x.uid),R.get(x.uid));if(v!==undefined){out.push(v);seen.add(x.uid)}}
  for(const x of asList(r)){if(seen.has(x.uid))continue;const v=mergeItem(B.get(x.uid),undefined,R.get(x.uid));if(v!==undefined)out.push(v)}
  return out}
function merge3(base,local,remote){return mergeList(base,local,remote)}

/* ---- Google sign-in (token flow, popup). One token client, one request at a time. ---- */
function createAuth(o){
  const SKEW=60000,T=o.timers||{setTimeout:(f,ms)=>setTimeout(f,ms),clearTimeout:t=>clearTimeout(t)};
  let tok=null,client=null,cur=null,inflight=null,needsInteractive=false;
  const readTok=()=>{if(tok)return tok;
    try{const j=JSON.parse(o.storage.get()||'null');if(j&&typeof j.t==='string'&&j.t&&j.exp>0)tok=j}catch{}return tok};
  const valid=()=>{const t=readTok();return t&&t.exp-SKEW>o.now()?t.t:''};
  const invalidate=()=>{tok=null;try{o.storage.remove()}catch{}};
  const CONFIG_ERR=['invalid_client','unauthorized_client','origin_mismatch','redirect_uri_mismatch','invalid_scope','invalid_request'];
  function diagnose(){
    if(o.protocol==='file:'||o.origin==='null')
      return new SyncError('AUTH_ORIGIN','Google sign-in cannot run from a file:// page. Open the app from its https:// address.',{needsAuth:true});
    if(o.protocol==='http:'&&!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(o.hostname||''))
      return new SyncError('AUTH_ORIGIN','Google sign-in requires https (or localhost). This page is served from '+o.origin+'.',{needsAuth:true});
    return null}
  function mapError(type,msg,interactive){
    const orig=o.origin||'this page’s origin';
    if(!interactive&&!CONFIG_ERR.includes(type))
      return new SyncError('AUTH_REQUIRED','Google needs you to sign in again to continue syncing.',{needsAuth:true});
    if(CONFIG_ERR.includes(type))
      return new SyncError('AUTH_CONFIG','Google rejected the sign-in configuration ('+scrub(type)+'). Check the OAuth client ID and that '+orig+' is listed under Authorized JavaScript origins (redirect URIs are not used by this sign-in method).',{needsAuth:true});
    switch(type){
      case'popup_failed_to_open':return new SyncError('AUTH_POPUP_BLOCKED','The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',{needsAuth:true});
      case'popup_closed':return new SyncError('AUTH_CLOSED','The Google sign-in window was closed before it finished. If it showed “origin_mismatch”, add '+orig+' under Authorized JavaScript origins for this OAuth client (this sign-in method does not use redirect URIs).',{needsAuth:true});
      case'access_denied':return new SyncError('AUTH_DENIED','Google denied access. Approve the Drive permission, and if the OAuth consent screen is in Testing mode make sure this Google account is listed as a test user.',{needsAuth:true});
      default:return new SyncError('AUTH_FAILED','Google sign-in failed ('+scrub(type)+')'+(msg?': '+scrub(msg):'')+'.',{needsAuth:true})}}
  function request(interactive){
    return Promise.resolve().then(()=>o.loadGis()).catch(()=>{throw new SyncError('AUTH_LOAD','Could not load Google Sign-In. Check your connection.',{retryable:true})})
    .then(gis=>new Promise((res,rej)=>{
      let done=false;
      const finish=(fn,v)=>{if(done)return;done=true;T.clearTimeout(timer);if(cur===handlers)cur=null;fn(v)};
      const handlers={
        onResult:r=>{
          if(!r||r.error)return finish(rej,mapError(r&&r.error||'unknown',r&&r.error_description,interactive));
          if(!r.access_token)return finish(rej,new SyncError('AUTH_FAILED','Google returned no access token.',{needsAuth:true}));
          tok={t:r.access_token,exp:o.now()+(Number(r.expires_in)||3600)*1000};
          try{o.storage.set(JSON.stringify(tok))}catch{}
          finish(res,tok.t)},
        onError:e=>finish(rej,mapError(e&&e.type||'unknown',e&&e.message,interactive))};
      const timer=T.setTimeout(()=>finish(rej,new SyncError('AUTH_TIMEOUT',interactive?'Google sign-in took too long. Try again.':'Google did not answer the background sign-in.',{needsAuth:true})),interactive?120000:15000);
      cur=handlers;
      try{
        if(!client)client=gis.initTokenClient({client_id:o.clientId,scope:o.scope,
          callback:r=>{cur&&cur.onResult(r)},error_callback:e=>{cur&&cur.onError(e)}});
        const hint=o.getHint&&o.getHint();
        client.requestAccessToken(interactive?{prompt:''}:Object.assign({prompt:'none'},hint?{hint}:{}))}
      catch(e){finish(rej,mapError('exception',e&&e.message,interactive))}}))}
  async function getToken(opt){
    const interactive=!!(opt&&opt.interactive);
    for(;;){
      const v=valid();if(v)return v;
      if(inflight){if(inflight.interactive||!interactive)return inflight.p;try{await inflight.p}catch{}continue}
      if(!interactive&&needsInteractive)throw new SyncError('AUTH_REQUIRED','Google sign-in has expired. Reconnect to resume syncing.',{needsAuth:true});
      const d=diagnose();if(d)throw d;
      const entry={interactive};
      entry.p=request(interactive).then(t=>{needsInteractive=false;return t},e=>{if(e&&e.needsAuth)needsInteractive=true;throw e})
        .finally(()=>{if(inflight===entry)inflight=null});
      inflight=entry;return entry.p}}
  return{getToken,invalidate,clear(){invalidate();needsInteractive=false}}}

/* ---- Drive adapter: folder/file lookup, metadata check, download, create/update ---- */
function createDriveRemote(o){
  const API='https://www.googleapis.com/drive/v3',UP='https://www.googleapis.com/upload/drive/v3',
    FIELDS='id,version,md5Checksum,modifiedTime,trashed';
  const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  async function call(url,init,ctx,tolerate404){
    let refreshed=false;
    for(;;){
      const token=await o.auth.getToken({interactive:!!(ctx&&ctx.interactive)});
      const ctl=typeof AbortController!=='undefined'?new AbortController():null,
        to=ctl?setTimeout(()=>ctl.abort(),o.timeoutMs||20000):null;
      let r;
      try{r=await o.fetch(url,Object.assign({},init,{headers:Object.assign({},init&&init.headers,{Authorization:'Bearer '+token}),signal:ctl?ctl.signal:undefined}))}
      catch(e){if(to)clearTimeout(to);
        throw new SyncError(e&&e.name==='AbortError'?'TIMEOUT':'NETWORK',e&&e.name==='AbortError'?'Google Drive did not respond in time.':'Could not reach Google Drive. Check your connection.',{retryable:true})}
      if(to)clearTimeout(to);
      if(r.ok)return r;
      if(r.status===404&&tolerate404)return r;
      const body=await r.text().catch(()=>''),gmsg=(body.match(/"message":\s*"([^"]*)"/)||[])[1]||'',reason=(body.match(/"reason":\s*"([^"]*)"/)||[])[1]||'';
      if(r.status===401){o.auth.invalidate();if(!refreshed){refreshed=true;continue}
        throw new SyncError('AUTH_EXPIRED','Google sign-in has expired. Reconnect to resume syncing.',{needsAuth:true,status:401})}
      if(r.status===403&&/rate|quota|limit/i.test(reason))throw new SyncError('RATE_LIMIT','Google Drive is rate limiting requests. Retrying shortly.',{retryable:true,status:403});
      if(r.status===403)throw new SyncError('AUTH_SCOPE','Google Drive refused access. Reconnect and approve the Drive permission.',{needsAuth:true,status:403});
      if(r.status===429||r.status>=500)throw new SyncError('HTTP_'+r.status,'Google Drive is temporarily unavailable ('+r.status+').',{retryable:true,status:r.status});
      throw new SyncError('HTTP_'+r.status,'Google Drive error '+r.status+(gmsg?': '+gmsg:'')+'.',{status:r.status})}}
  const norm=(j,folderId)=>({exists:true,fileId:j.id,folderId:folderId||'',version:String(j.version||''),md5:j.md5Checksum||'',modified:j.modifiedTime||''});
  const list=async(q,fields,ctx,extra)=>{const r=await call(API+'/files?'+new URLSearchParams(Object.assign({q,fields,spaces:'drive',pageSize:'1'},extra||{})),{},ctx);return(await r.json()).files||[]};
  async function findFolder(ctx,create){
    let p='root';
    for(const n of o.folder.split('/')){
      let f=(await list("name='"+esc(n)+"' and '"+p+"' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",'files(id,name)',ctx))[0];
      if(!f){if(!create)return'';
        const c=await call(API+'/files?fields=id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,mimeType:'application/vnd.google-apps.folder',parents:[p]})},ctx);
        f=await c.json();if(!f.id)throw new SyncError('HTTP_0','Could not create the Drive folder.')}
      p=f.id}
    return p}
  const findFile=async(folderId,ctx)=>(await list("name='"+esc(o.fileName)+"' and '"+folderId+"' in parents and trashed=false",'files('+FIELDS+')',ctx,{orderBy:'modifiedTime desc'}))[0]||null;
  const multipart=(meta,data)=>{const b='td_sync_'+Math.random().toString(36).slice(2);
    return{headers:{'Content-Type':'multipart/related; boundary='+b},body:'--'+b+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+b+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+data+'\r\n--'+b+'--\r\n'}};
  return{
    async head(ids,ctx){
      if(ids.fileId){const r=await call(API+'/files/'+ids.fileId+'?fields='+FIELDS,{},ctx,true);
        if(r.status!==404){const j=await r.json();if(!j.trashed)return norm(j,ids.folderId)}}
      const folderId=await findFolder(ctx,false);
      if(!folderId)return{exists:false,fileId:'',folderId:''};
      const f=await findFile(folderId,ctx);
      return f?norm(f,folderId):{exists:false,fileId:'',folderId}},
    async download(fileId,ctx){return(await call(API+'/files/'+fileId+'?alt=media',{},ctx)).text()},
    /* Idempotent: with no known fileId we look the file up by name before creating, so a retry after a lost
       response updates the file instead of creating a duplicate. */
    async write(ids,data,ctx){
      let fileId=ids.fileId,folderId=ids.folderId;
      if(!fileId){folderId=folderId||await findFolder(ctx,true);const ex=await findFile(folderId,ctx);if(ex)fileId=ex.id}
      if(fileId){const mp=multipart({},data),
        r=await call(UP+'/files/'+fileId+'?uploadType=multipart&fields='+FIELDS,Object.assign({method:'PATCH'},mp),ctx,true);
        if(r.status!==404)return norm(await r.json(),folderId);
        fileId='';folderId=''}
      folderId=folderId||await findFolder(ctx,true);
      const mp=multipart({name:o.fileName,parents:[folderId]},data);
      const r=await call(UP+'/files?uploadType=multipart&fields='+FIELDS,Object.assign({method:'POST'},mp),ctx);
      return norm(await r.json(),folderId)},
    async userEmail(ctx){const r=await call('https://www.googleapis.com/oauth2/v3/userinfo',{},ctx);return(await r.json()).email||''}}}

/* ---- Sync engine ---- */
function createSyncEngine(o){
  const cfg=Object.assign({debounceMs:2500,probeMinMs:300000,skewMs:120000,backoffBaseMs:2000,backoffCapMs:300000,maxAttempts:5,maxPasses:4},o.config||{});
  const T=o.timers,now=o.now,random=o.random||Math.random,iso=t=>new Date(t).toISOString();
  const meta=Object.assign({v:2,connected:false,email:'',folderId:'',fileId:'',baseHash:null,remoteVersion:'',remoteMd5:'',remoteModified:'',
    lastSyncedAt:'',lastCheckedAt:0,lastLocalChangeAt:0,rev:0,pending:false,failure:null},o.loadMeta()||{},{v:2});
  const rt={needsAuth:false,paused:false,attempts:0};   /* runtime only: never persisted */
  let inFlight=null,rerun=false,debounceT=null,retryT=null,started=false,epoch=0,lastProbeAt=meta.lastCheckedAt||0;
  const commit=()=>{try{o.saveMeta(meta)}catch{}};
  const snap=()=>snapOf(o.normalize(o.getLocal()));
  const markBase=S=>{meta.baseHash=S.hash;o.saveBase(S.str)};
  const remember=h=>{meta.remoteVersion=String(h.version||'');meta.remoteMd5=h.md5||'';meta.remoteModified=h.modified||''};
  const remoteDiffers=h=>(h.md5&&meta.remoteMd5)?h.md5!==meta.remoteMd5:String(h.version||'')!==String(meta.remoteVersion||'');
  const needsWork=()=>meta.baseHash===null||snap().hash!==meta.baseHash;
  const synced=()=>{meta.lastSyncedAt=iso(now());meta.pending=false;commit()};
  function status(){return{connected:meta.connected,email:meta.email,syncing:!!inFlight,pending:meta.connected&&meta.pending,
    needsAuth:rt.needsAuth,paused:rt.paused,failure:meta.failure,lastSyncedAt:meta.lastSyncedAt,lastCheckedAt:meta.lastCheckedAt}}
  const emit=()=>{try{o.onState&&o.onState(status())}catch{}};
  const clearDebounce=()=>{if(debounceT!==null){T.clearTimeout(debounceT);debounceT=null}};
  const clearRetry=()=>{if(retryT!==null){T.clearTimeout(retryT);retryT=null}};
  const schedule=(ms,reason)=>{clearDebounce();debounceT=T.setTimeout(()=>{debounceT=null;requestSync({reason})},ms)};

  /* --- local change hook: called after a Commit only. Cheap, no network. --- */
  function noteLocalChange(){
    meta.rev++;meta.lastLocalChangeAt=now();
    if(!meta.connected){commit();return}
    meta.pending=meta.baseHash===null?true:snap().hash!==meta.baseHash;commit();
    if(!meta.pending){clearDebounce();emit();return}
    rt.paused=false;rt.attempts=0;clearRetry();emit();
    if(rt.needsAuth)return;                       /* waits for the user to reconnect; edits stay pending */
    schedule(cfg.debounceMs,'local-change')}

  /* --- single-flight entry point --- */
  function requestSync(opts){
    opts=opts||{};
    if(!meta.connected)return Promise.resolve({status:'skipped'});
    if(rt.needsAuth&&!opts.interactive)return Promise.resolve({status:'skipped'});
    if(inFlight){rerun=true;return inFlight}
    inFlight=run(opts).finally(()=>{inFlight=null;emit()});
    emit();
    return inFlight}
  async function run(opts){
    let r,passes=0;
    do{rerun=false;lastProbeAt=now();r=await pass(opts);passes++;if(r.status==='stale')rerun=true}
    while(rerun&&r.status!=='error'&&r.status!=='cancelled'&&passes<cfg.maxPasses&&(r.status==='stale'||needsWork()));
    if(meta.connected){meta.pending=meta.baseHash===null?false:snap().hash!==meta.baseHash;commit();
      if(meta.pending&&r.status!=='error'&&r.status!=='cancelled'&&!rt.needsAuth)schedule(cfg.debounceMs,'followup')}
    return r}
  async function pass(opts){
    const ep=epoch,ctx={interactive:!!opts.interactive,alive(){if(ep!==epoch)throw new SyncError('CANCELLED','Sync was cancelled.',{cancelled:true})}};
    try{
      if(!o.online())throw new SyncError('OFFLINE','You are offline. Changes are kept on this device and will sync when you are back online.',{retryable:true,offline:true});
      const r=await reconcile(ctx);ctx.alive();
      meta.failure=null;rt.attempts=0;rt.paused=false;rt.needsAuth=false;clearRetry();commit();emit();
      if(r.status==='pulled'||r.status==='merged'){try{o.onEvent&&o.onEvent({type:r.status})}catch{}}
      return r}
    catch(e){return fail(asSyncError(e))}}
  function fail(e){
    if(e.cancelled)return{status:'cancelled'};
    meta.failure={code:e.code,message:e.message,at:now()};
    if(e.needsAuth){rt.needsAuth=true;clearRetry()}
    else if(e.offline)clearRetry();                 /* the 'online' event resumes; no timers while offline */
    else if(e.retryable){rt.attempts++;
      if(rt.attempts<=cfg.maxAttempts){const d=Math.min(cfg.backoffCapMs,cfg.backoffBaseMs*Math.pow(2,rt.attempts-1));
        clearRetry();retryT=T.setTimeout(()=>{retryT=null;requestSync({reason:'retry'})},Math.round(d*(0.5+random()*0.5)))}
      else{rt.paused=true;clearRetry()}}
    else{rt.paused=true;clearRetry()}               /* permanent error: no automatic retry */
    commit();emit();return{status:'error',error:e}}

  /* --- decision flow --- */
  async function reconcile(ctx){
    const L=snap();
    const head=await o.remote.head({fileId:meta.fileId,folderId:meta.folderId},ctx);ctx.alive();
    if(head.fileId)meta.fileId=head.fileId;if(head.folderId)meta.folderId=head.folderId;
    meta.lastCheckedAt=now();
    if(!head.exists){                               /* nothing remote (or deleted): never touch local data */
      if(meta.baseHash===null&&isEmpty(L.obj)){markBase(L);commit();return{status:'noop'}}
      return push(L,ctx,true)}
    if(meta.baseHash===null)return firstLaunch(L,head,ctx);
    const local=L.hash!==meta.baseHash,remote=remoteDiffers(head);
    if(!local&&!remote){commit();return{status:'unchanged'}}
    if(!local)return pull(L,head,ctx);
    if(!remote)return push(L,ctx,false);
    return mergeBoth(L,head,ctx)}
  async function fetchRemote(head,ctx){
    const text=await o.remote.download(head.fileId,ctx);ctx.alive();
    let parsed;try{parsed=JSON.parse(text)}catch{throw new SyncError('REMOTE_INVALID','The copy on Google Drive is not valid JSON, so it was left untouched.')}
    const err=o.validate(parsed);
    if(err)throw new SyncError('REMOTE_INVALID','The copy on Google Drive could not be read ('+err+'), so it was left untouched.');
    return snapOf(o.normalize(parsed))}
  async function push(L,ctx,create){
    const res=await o.remote.write({fileId:create?'':meta.fileId,folderId:meta.folderId},JSON.stringify(L.obj),ctx);ctx.alive();
    meta.fileId=res.fileId;meta.folderId=res.folderId;remember(res);markBase(L);   /* state saved only after success */
    meta.lastSyncedAt=iso(now());meta.pending=snap().hash!==meta.baseHash;commit();
    return{status:'pushed'}}
  function adopt(L,R){                              /* replace local with remote, unless local moved meanwhile */
    if(snap().hash!==L.hash)return false;
    o.backup('local',L.obj);o.applyLocal(R.obj);markBase(snap());return true}
  async function pull(L,head,ctx){
    const R=await fetchRemote(head,ctx);
    if(R.hash===meta.baseHash){remember(head);commit();return{status:'unchanged'}}   /* metadata-only change */
    if(!adopt(L,R))return{status:'stale'};
    remember(head);synced();return{status:'pulled'}}
  async function mergeBoth(L,head,ctx){
    const R=await fetchRemote(head,ctx);
    if(R.hash===L.hash){markBase(L);remember(head);synced();return{status:'converged'}}
    if(R.hash===meta.baseHash){remember(head);return push(L,ctx,false)}
    return combine(L,R,head,loadBase(),ctx)}
  async function combine(L,R,head,B,ctx){
    const M=snapOf(o.normalize(merge3(B,L.obj,R.obj)));
    if(snap().hash!==L.hash)return{status:'stale'};
    o.backup('remote',R.obj);                       /* the other side's version is always preserved */
    if(M.hash!==L.hash){o.backup('local',L.obj);o.applyLocal(M.obj)}
    meta.baseHash=R.hash;o.saveBase(R.str);remember(head);commit();   /* base = what the remote holds right now */
    const L2=snap();
    if(L2.hash===R.hash){synced();return{status:'merged'}}
    const p=await push(L2,ctx,false);
    return p.status==='pushed'?{status:'merged'}:p}
  function loadBase(){const s=o.loadBase();if(!s)return null;try{return o.normalize(JSON.parse(s))}catch{return null}}
  /* No trusted base (first launch, legacy state): identical -> no write; empty yields to non-empty; a side that is
     demonstrably newer (beyond a clock-skew margin) wins wholesale with the loser backed up; otherwise merge. */
  async function firstLaunch(L,head,ctx){
    const R=await fetchRemote(head,ctx);
    if(R.hash===L.hash){markBase(L);remember(head);synced();return{status:'identical'}}
    const lc=meta.lastLocalChangeAt,rc=Date.parse(head.modified)||0;let dir;
    if(isEmpty(L.obj))dir='remote';else if(isEmpty(R.obj))dir='local';
    else if(lc&&rc&&rc-lc>cfg.skewMs)dir='remote';else if(lc&&rc&&lc-rc>cfg.skewMs)dir='local';else dir='merge';
    if(dir==='remote'){if(!adopt(L,R))return{status:'stale'};remember(head);synced();return{status:'pulled'}}
    if(dir==='local'){if(!isEmpty(R.obj))o.backup('remote',R.obj);return push(L,ctx,false)}
    return combine(L,R,head,null,ctx)}

  /* --- explicit, enumerated triggers --- */
  function probe(){   /* returning to the tab: a metadata-only check, throttled; uploads only if edits are pending */
    if(!meta.connected||rt.needsAuth||rt.paused||inFlight||!o.online())return;
    if(now()-lastProbeAt<cfg.probeMinMs)return;
    requestSync({reason:'probe'})}
  function onOnline(){
    if(!meta.connected||rt.needsAuth)return;
    if(meta.pending||meta.baseHash===null||meta.failure){rt.attempts=0;rt.paused=false;requestSync({reason:'online'})}}
  function start(){
    if(started||!meta.connected)return;started=true;
    meta.failure=null;rt.needsAuth=false;
    if(meta.baseHash===null||snap().hash!==meta.baseHash||now()-(meta.lastCheckedAt||0)>=cfg.probeMinMs)requestSync({reason:'start'})}
  function setConnected(email){epoch++;meta.connected=true;if(email)meta.email=email;rt.needsAuth=false;rt.paused=false;rt.attempts=0;meta.failure=null;commit();emit()}
  function authRestored(){rt.needsAuth=false;rt.paused=false;rt.attempts=0;meta.failure=null;commit();emit()}
  function disconnect(){
    epoch++;clearDebounce();clearRetry();started=false;
    const keep=meta.lastLocalChangeAt,rev=meta.rev;
    Object.assign(meta,{connected:false,email:'',folderId:'',fileId:'',baseHash:null,remoteVersion:'',remoteMd5:'',remoteModified:'',lastSyncedAt:'',lastCheckedAt:0,pending:false,failure:null,lastLocalChangeAt:keep,rev});
    rt.needsAuth=false;rt.paused=false;rt.attempts=0;lastProbeAt=0;
    try{o.saveBase(null)}catch{}
    commit();emit()}
  function dispose(){epoch++;clearDebounce();clearRetry()}
  return{noteLocalChange,requestSync,probe,onOnline,start,setConnected,authRestored,disconnect,dispose,status}}

return{SyncError,createAuth,createDriveRemote,createSyncEngine,merge3,canon,hashStr}})();
/* ==SYNC-CORE-END== */

/* ---- wiring to this app ---- */
const DRIVE_BACKUP_FOLDER = 'MAK-Projects/Scheme-DB-Dashboard';
const DRIVE_BACKUP_FILE = 'scheme-database-backup.json';
const DRIVE_REVISIONS_FOLDER = 'MAK-Projects/Scheme-DB-Dashboard/revisions';
const GDRIVE = {
  clientId: atob('MTA2NzA3NTQ5NTIwMC1wMGhhdXJuanRwMzJvZm51YWVuNzQ5NzBybDN1OHY1di5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='),
  folder: DRIVE_BACKUP_FOLDER,
  fileName: DRIVE_BACKUP_FILE,
  scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email'
};

// Sync-state keys. The legacy gdrive_* keys are read once (below) to carry an
// existing connection across the upgrade, then ignored.
const SYNC_META_KEY = 'schemedb.v1.sync';
const SYNC_BASE_KEY = 'schemedb.v1.sync.base';
const SYNC_CONFLICT_KEY = 'schemedb.v1.conflict';
const SYNC_LOCAL_BACKUP_KEY = 'schemedb.v1.backup';
const SYNC_TOKEN_KEY = 'schemedb.drive.token';

const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
const ssGet = k => { try { return sessionStorage.getItem(k); } catch { return null; } };
const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };
const ssDel = k => { try { sessionStorage.removeItem(k); } catch {} };

// The token used to live in localStorage (the old redirect flow). Carry a
// still-valid one into the new sessionStorage store so the upgrade does not
// force a re-authorisation; Google's popup flow refreshes it once it expires.
(function migrateLegacyDriveToken() {
  try {
    const t = localStorage.getItem('gdrive_token');
    const exp = parseInt(localStorage.getItem('gdrive_token_expiry') || '0', 10);
    if (t && exp > Date.now() && !ssGet(SYNC_TOKEN_KEY)) ssSet(SYNC_TOKEN_KEY, JSON.stringify({ t, exp }));
  } catch {}
})();

// The sync snapshot is the COMMITTED state only. `schemes` holds committed base
// records (plus staged `_new_N` placeholders, which are excluded here);
// pendingChanges overlays are deliberately ignored so uncommitted work is never
// treated as a local change to upload.
function getCommittedSchemes() {
  return schemes.filter(s => !isNewId(s.id)).map(s => toExportShape(s));
}

// Pure, order-independent normal form. Cards are sorted by createdAt (then uid)
// so two devices holding the same cards agree no matter their local order.
function normalizeForSync(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.schemes) ? data.schemes : []);
  return list.map((s, i) => normalizeScheme(s, i)).sort((a, b) => {
    const ca = String(a.createdAt || ''), cb = String(b.createdAt || '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });
}

// A Drive copy that is not a list of named cards is refused (never applied,
// never overwritten) — SyncCore turns the returned string into REMOTE_INVALID.
function validateSyncData(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.schemes) ? data.schemes : null);
  if (!list) return 'the top-level value is not a list of cards';
  if (!list.every(s => s && typeof s === 'object' && typeof s.name === 'string' && s.name.trim())) {
    return 'it contains entries without a name';
  }
  return '';
}

const loadGis = () => new Promise((res, rej) => {
  if (window.google && google.accounts && google.accounts.oauth2) return res(google.accounts.oauth2);
  let done = false;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => { if (!done) { done = true; window.google && google.accounts && google.accounts.oauth2 ? res(google.accounts.oauth2) : rej(new Error('Google Sign-In did not initialise.')); } };
  s.onerror = () => { if (!done) { done = true; rej(new Error('Could not load Google Sign-In.')); } };
  setTimeout(() => { if (!done) { done = true; rej(new Error('Google Sign-In timed out loading.')); } }, 15000);
  document.head.append(s);
});

function loadSyncMeta() {
  let m = null;
  try { m = JSON.parse(lsGet(SYNC_META_KEY)); } catch {}
  if (m && m.v === 2) return m;
  m = {};
  // Migrate the old connection flags. The version counters are obsolete under
  // content-hash sync, so only the connection and the local-change time are
  // carried over; baseHash stays null so the first sync reconciles properly.
  try {
    if (ssGet(SYNC_TOKEN_KEY)) m.connected = true;
    const at = parseInt(localStorage.getItem('gdrive_last_sync_at') || '0', 10);
    if (at > 0) m.lastSyncedAt = new Date(at).toISOString();
    const t = parseInt(localStorage.getItem('gdrive_local_modified_at') || '0', 10);
    if (t > 0) m.lastLocalChangeAt = t;
  } catch {}
  return m;
}

const auth = SyncCore.createAuth({
  loadGis, clientId: GDRIVE.clientId, scope: GDRIVE.scope, now: () => Date.now(),
  origin: location.origin, protocol: location.protocol, hostname: location.hostname,
  storage: { get: () => ssGet(SYNC_TOKEN_KEY), set: v => ssSet(SYNC_TOKEN_KEY, v), remove: () => ssDel(SYNC_TOKEN_KEY) },
  getHint: () => syncEngine && syncEngine.status().email
});
const driveRemote = SyncCore.createDriveRemote({ fetch: (u, i) => fetch(u, i), auth, folder: GDRIVE.folder, fileName: GDRIVE.fileName });

// Before any overwrite, the losing snapshot is archived both locally and
// (best-effort) in the Drive revisions/ folder, so a merge can never silently
// destroy the only copy of either side.
function archiveRevision(which, obj) {
  try { lsSet(which === 'local' ? SYNC_LOCAL_BACKUP_KEY : SYNC_CONFLICT_KEY, JSON.stringify(obj)); } catch {}
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const remote = SyncCore.createDriveRemote({
    fetch: (u, i) => fetch(u, i), auth, folder: DRIVE_REVISIONS_FOLDER,
    fileName: `scheme-revision-${stamp}-${which}.json`
  });
  remote.write({ fileId: '', folderId: '' }, JSON.stringify(obj, null, 2), { interactive: false })
    .catch(err => console.warn('Drive revision archive skipped:', err && err.message));
}

let syncEngine = null;
// Called after a successful Commit (and after an import that rewrites the
// store) — the only moments committed state changes — so the engine can
// debounce an upload. Cheap and offline-safe: it never touches the network.
function noteLocalChange() {
  if (syncEngine) syncEngine.noteLocalChange();
}
syncEngine = SyncCore.createSyncEngine({
  getLocal: getCommittedSchemes,
  normalize: normalizeForSync,
  validate: validateSyncData,
  remote: driveRemote,
  now: () => Date.now(),
  timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) },
  online: () => navigator.onLine !== false,
  loadMeta: loadSyncMeta,
  saveMeta: m => lsSet(SYNC_META_KEY, JSON.stringify(m)),
  loadBase: () => lsGet(SYNC_BASE_KEY),
  saveBase: s => (s == null ? lsDel(SYNC_BASE_KEY) : lsSet(SYNC_BASE_KEY, s)),
  backup: archiveRevision,
  applyLocal: obj => {
    // Remote data replaces the committed store. It must never swallow staged
    // work, so refuse (the engine treats this as a failed pass and retries
    // after the next commit) if the user has uncommitted changes.
    if (pendingChanges.size > 0) {
      throw new SyncCore.SyncError('PENDING', 'You have uncommitted changes, so the newer Drive data was not applied. Commit them and sync again.');
    }
    const records = obj.map((s, i) => normalizeScheme(s, i));
    // Update the in-memory base synchronously so the engine's snapshot sees the
    // applied state at once; then persist atomically (replace the whole store).
    schemes = records.map((r, i) => ({ id: -(i + 1), ...r }));
    render();
    dbCommit({ puts: [], adds: records, clear: true })
      .then(loadSchemes)
      .catch(err => {
        console.error('Failed to save synced data', err);
        showToast('Sync applied but could not be saved — reload the page.');
      });
  },
  onState: () => driveUI(),
  onEvent: e => {
    showToast(e.type === 'merged' ? 'Merged changes from another device' : 'Loaded newer data from Drive');
    if (e.type === 'merged') render();
  }
});

/* ---- Data-menu UI ---- */
function driveUI() {
  const s = syncEngine.status();
  const when = t => t ? new Date(t).toLocaleString() : 'never';

  driveConnectLabel.textContent = s.connected ? 'Disconnect from Google' : 'Sign in with Google';
  driveConnectIcon.textContent = s.connected ? '🔌' : '🔗';
  driveConnectDesc.textContent = s.connected
    ? 'Click to sign out'
    : 'Opens a Google sign-in popup to authorize this app';
  driveConnectDesc.style.opacity = '1';
  dataDriveSync.disabled = !s.connected || s.syncing;

  let text, sub = '', err = false;
  if (!s.connected) {
    text = 'Not connected to Google Drive';
    sub = 'Click Sign in to authorize with Google Drive';
  } else if (s.syncing) {
    text = 'Syncing with Google Drive…';
    sub = 'Checking for changes';
  } else if (s.needsAuth) {
    text = 'Google sign-in needs renewing';
    sub = (s.failure && s.failure.message) || 'Click "Sign in with Google" to reconnect';
    err = true;
  } else if (s.failure && s.failure.code === 'PENDING') {
    text = 'Connected to Google Drive' + (s.email ? ` as ${s.email}` : '');
    sub = s.failure.message;
    err = true;
  } else if (s.failure) {
    text = 'Sync failed';
    sub = s.failure.message + (s.paused ? ' — click Sync now to retry.' : ' Retrying automatically.');
    err = true;
  } else {
    text = 'Connected to Google Drive' + (s.email ? ` as ${s.email}` : '');
    sub = (s.pending ? 'Changes pending — ' : 'Up to date · ') + 'Last synced: ' + when(s.lastSyncedAt);
  }
  driveStatusText.textContent = text;
  driveStatusSub.textContent = sub;
  driveStatusSub.style.color = err ? 'var(--danger)' : '';
}

let driveConnecting = false;
async function driveConnect() {
  if (driveConnecting) return;
  driveConnecting = true;
  dataDriveConnect.disabled = true;
  driveStatusText.textContent = 'Connecting to Google…';
  driveStatusSub.textContent = 'Complete the sign-in popup';
  driveStatusSub.style.color = '';
  try {
    await auth.getToken({ interactive: true });
    let email = '';
    try { email = await driveRemote.userEmail({ interactive: false }); } catch {}
    syncEngine.setConnected(email);
    syncEngine.authRestored();
    const r = await syncEngine.requestSync({ interactive: true, reason: 'connect' });
    showToast(r.status === 'error' ? 'Drive sync failed' : 'Connected to Google Drive');
  } catch (err) {
    driveStatusText.textContent = 'Connect failed';
    driveStatusSub.textContent = (err && err.message) || 'Unknown error';
    driveStatusSub.style.color = 'var(--danger)';
    if (!(err && err.code)) console.error('Drive connect:', err && err.name, err);
  } finally {
    driveConnecting = false;
    dataDriveConnect.disabled = false;
    driveUI();
  }
}

dataDriveConnect.addEventListener('click', () => {
  if (syncEngine.status().connected) {
    syncEngine.disconnect();
    auth.clear();
    showToast('Disconnected from Google Drive');
    driveUI();
    return;
  }
  driveConnect();
});

dataDriveSync.addEventListener('click', async () => {
  if (!syncEngine.status().connected) { showToast('Not connected to Drive'); return; }
  if (pendingChanges.size > 0) {
    showToast(`Commit or discard ${pendingChanges.size} pending change(s) before syncing.`);
    return;
  }
  closeDataMenuModal();
  const r = await syncEngine.requestSync({ interactive: true, reason: 'manual' });
  showToast(
    r.status === 'error' ? 'Sync failed: ' + ((r.error && r.error.message) || 'unknown error')
      : r.status === 'pushed' ? 'Synced to Drive'
      : (r.status === 'pulled' || r.status === 'merged') ? 'Updated from Drive'
      : 'Already up to date'
  );
});

/* ---- Triggers (each registered exactly once) ----
   Staged edits are never synced: a trigger that fires while work is staged is
   ignored, and the successful Commit (via noteLocalChange) is what re-arms sync.
   Returning to the tab runs a throttled metadata-only check; regaining the
   network resumes pending work. Focus/blur/timers never upload anything by
   themselves. */
function syncIsDeferred() { return pendingChanges.size > 0; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !syncIsDeferred()) syncEngine.probe();
});
window.addEventListener('online', () => { if (!syncIsDeferred()) syncEngine.onOnline(); });

// ========== Click outside to exit selection ==========
document.addEventListener('click', e => {
  // A click whose target was removed during dispatch (e.g. a delete-row
  // button) arrives here detached from the DOM; closest() finds nothing
  // and it must not be mistaken for an outside click.
  if (!e.target.isConnected) return;
  if (selectionMode && !e.target.closest('.card') && !e.target.closest('.bulk-action-bar') && !e.target.closest('.modal-overlay') && !e.target.closest('.scroll-flap')) {
    exitSelectionMode();
  }
});

// ========== Init ==========
loadSchemes();
syncEngine.start();

// Any staged (uncommitted) change is memory-only; leaving the page — tab
// close, refresh, or reload — would drop it silently. Warn when there
// is pending work that would be lost.
window.addEventListener('beforeunload', e => {
  if (pendingChanges.size > 0) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// Keyboard shortcut: Ctrl+K focuses search (or opens the expression editor
// while a filter is active), Escape exits
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (searchMode === 'expr' || searchMode === 'simple') openQueryModal();
    else {
      searchInput.focus();
      searchInput.select();
    }
  }
  if (e.key === 'Escape') {
    if (!schemeModal.classList.contains('hidden')) closeModal();
    else if (!pivotModal.classList.contains('hidden')) pivotModal.classList.add('hidden');
    else if (!detailModal.classList.contains('hidden')) closeDetailModal();
    else if (!bulkModal.classList.contains('hidden')) closeBulkModal();
    else if (!dataMenuModal.classList.contains('hidden')) closeDataMenuModal();
    // The query editor yields before selection mode does, so Escape peels
    // layers instead of nuking state.
    else if (!queryModal.classList.contains('hidden')) closeQueryModal();
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

// Jump button factory. Default flavour hops ~80% of the viewport per click
// (hold to scroll continuously); edge=true turns the button into an absolute
// jump that lands exactly at the top or bottom in one click.
function makeJumpBtn(dir, scrollEl, contextLabel, edge) {
  const btn = document.createElement('button');
  btn.className = 'scroll-jump scroll-jump-' + dir + (edge ? ' scroll-jump-edge' : '');
  btn.textContent = dir === 'top' ? '↑' : '↓';
  const action = edge ? 'Jump to ' + (dir === 'top' ? 'top' : 'bottom') : (dir === 'top' ? 'Scroll to top' : 'Scroll to bottom');
  btn.title = action;
  btn.setAttribute('aria-label', action + ' of ' + contextLabel);

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollBehavior = prefersReduced ? 'instant' : 'smooth';

  let holdTimer = null;
  let holdInterval = null;
  const HOLD_DELAY = 300;
  const SCROLL_STEP = 30;

  function doScroll() {
    if (edge) {
      scrollEl.scrollTo({ top: dir === 'top' ? 0 : scrollEl.scrollHeight, behavior: scrollBehavior });
      return;
    }
    if (dir === 'top') scrollEl.scrollBy({ top: -scrollEl.clientHeight * 0.8, behavior: scrollBehavior });
    else scrollEl.scrollBy({ top: scrollEl.clientHeight * 0.8, behavior: scrollBehavior });
  }

  // Holding an absolute jump has no meaning — one click is the whole trip.
  if (edge) {
    btn.addEventListener('click', doScroll);
    return btn;
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

// Leather flap: every scroll control in a context lives on one strap docked
// at the right edge — folded by default, pulled open from the tab.
function makeScrollFlap(buttons) {
  const flap = document.createElement('div');
  flap.className = 'scroll-flap';
  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'scroll-flap-tab';
  tab.setAttribute('aria-expanded', 'false');
  const chev = document.createElement('span');
  chev.className = 'flap-chev';
  chev.textContent = '◂';
  chev.setAttribute('aria-hidden', 'true');
  const lab = document.createElement('span');
  lab.className = 'flap-label';
  lab.textContent = 'Jump';
  tab.appendChild(chev);
  tab.appendChild(lab);
  const panel = document.createElement('div');
  panel.className = 'scroll-flap-panel';
  buttons.forEach(b => panel.appendChild(b));
  tab.addEventListener('click', () => {
    const open = flap.classList.toggle('open');
    tab.setAttribute('aria-expanded', String(open));
    tab.title = open ? 'Hide jump controls' : 'Show jump controls';
  });
  flap.appendChild(panel);
  flap.appendChild(tab);
  return flap;
}

// Modal jump flaps — a hop pair (80% per click, hold to scroll) plus an
// edge pair that lands exactly at the top/bottom in one click.
const MODAL_LABELS = {
  schemeModal: 'form',
  pivotModal: 'table',
  detailModal: 'details',
  dataMenuModal: 'data menu',
  bulkModal: 'bulk editor'
};
Object.keys(MODAL_LABELS).forEach(id => {
  const overlay = document.getElementById(id);
  const modalEl = overlay && overlay.querySelector('.modal');
  if (!modalEl) return;
  const label = MODAL_LABELS[id];
  initScrollGlow(modalEl);
  overlay.appendChild(makeScrollFlap([
    makeJumpBtn('top', modalEl, label, true),
    makeJumpBtn('top', modalEl, label),
    makeJumpBtn('bottom', modalEl, label),
    makeJumpBtn('bottom', modalEl, label, true)
  ]));
});

// Page-level jump flap on the desk itself
const pageScrollEl = document.documentElement;
const pageUpBtn = makeJumpBtn('top', pageScrollEl, 'page');
const pageDownBtn = makeJumpBtn('bottom', pageScrollEl, 'page');
const pageTopEdgeBtn = makeJumpBtn('top', pageScrollEl, 'page', true);
const pageBottomEdgeBtn = makeJumpBtn('bottom', pageScrollEl, 'page', true);
const pageFlap = makeScrollFlap([pageTopEdgeBtn, pageUpBtn, pageDownBtn, pageBottomEdgeBtn]);
document.body.appendChild(pageFlap);

// Fold the page flap away whenever any modal is open
['schemeModal', 'pivotModal', 'detailModal', 'dataMenuModal', 'bulkModal'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const obs = new MutationObserver(() => {
    const open = !el.classList.contains('hidden');
    pageFlap.classList.toggle('hidden', open);
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
