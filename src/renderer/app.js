'use strict';
/* global porter */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const call = (...a) => porter.call(...a);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtSize(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}
const RULESET_LABEL = { PvE: 'Normal', PvP: 'PvP', RP: 'Roleplaying', Hardcore: 'Hardcore' };

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 9000 : 4000);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const S = {
  settings: {},
  installs: [],
  snapshots: [],
  selectedChar: null,
  betaAddons: [],
  plan: null,
};

// ---- navigation ------------------------------------------------------------------------

function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'snapshot') refreshSnapshotView();
  if (view === 'apply') refreshApplyView();
  if (view === 'backups') refreshBackups();
}
$$('.nav').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto]');
  if (a) { e.preventDefault(); show(a.dataset.goto); }
});

// ---- 1. game folders -------------------------------------------------------------------

function allFlavors() {
  return S.installs.flatMap((i) => i.flavors);
}

function flavorOptionLabel(f) {
  const n = f.accounts.length;
  return `${f.label} — ${f.path}${f.hasWTF ? '' : ' (no WTF yet)'}${n ? '' : ''}`;
}

async function describeFolder(which) {
  const p = S.settings[which + 'Path'];
  $(`#${which}-path`).textContent = p || 'No folder chosen';
  const facts = $(`#${which}-facts`);
  if (!p) { facts.innerHTML = '<span class="muted">Not found automatically. Use Browse to pick the game folder.</span>'; return; }
  try {
    const [flavor] = await call('installs:flavorsAt', p);
    if (!flavor) { facts.innerHTML = '<span class="status err">This doesn\'t look like a WoW game folder (no WTF or Interface folder).</span>'; return; }
    let chars = 0;
    for (const a of flavor.accounts) chars += (await call('wow:characters', p, a)).length;
    facts.innerHTML = `<span>Accounts <b>${flavor.accounts.length}</b></span><span>Characters <b>${chars}</b></span><span>Addons <b>${flavor.addonCount}</b></span>`
      + (which === 'live' && !chars ? '<span>No characters yet: log in to the new character once, then exit.</span>' : '');
  } catch (e) {
    facts.innerHTML = `<span class="status err">${esc(e.message)}</span>`;
  }
}

function fillFlavorSelect(which) {
  const sel = $(`#${which}-select`);
  const cur = S.settings[which + 'Path'] || '';
  const flavors = allFlavors();
  let html = flavors.map((f) => `<option value="${esc(f.path)}">${esc(flavorOptionLabel(f))}</option>`).join('');
  if (cur && !flavors.some((f) => f.path === cur)) html = `<option value="${esc(cur)}">${esc(cur)}</option>` + html;
  if (!cur) html = '<option value="">Choose…</option>' + html;
  sel.innerHTML = html;
  sel.value = cur;
}

async function setFolder(which, p) {
  S.settings[which + 'Path'] = p;
  await call('settings:set', { [which + 'Path']: p });
  fillFlavorSelect(which);
  describeFolder(which);
  S.plan = null;
}

async function detect() {
  $('#redetect').disabled = true;
  try {
    const { installs, suggested } = await call('installs:detect');
    S.installs = installs;
    for (const which of ['beta', 'live']) {
      const cur = S.settings[which + 'Path'];
      if (!cur && suggested[which]) await call('settings:set', { [which + 'Path']: (S.settings[which + 'Path'] = suggested[which]) });
      fillFlavorSelect(which);
      describeFolder(which);
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    $('#redetect').disabled = false;
  }
}

for (const which of ['beta', 'live']) {
  $(`#${which}-select`).addEventListener('change', (e) => setFolder(which, e.target.value));
}
$$('[data-browse]').forEach((b) => b.addEventListener('click', async () => {
  const which = b.dataset.browse;
  const picked = await call('dialog:pickFolder', `Choose the ${which} game folder`, S.settings[which + 'Path']);
  if (!picked) return;
  const flavors = await call('installs:flavorsAt', picked);
  if (!flavors.length) return toast('No WoW game folder there. Pick the folder that holds WTF and Interface, e.g. World of Warcraft\\_classic_beta_.', 'err');
  if (flavors.length > 1) {
    // a WoW root: add its flavors to the list and take the likeliest one
    S.installs.push({ root: picked, flavors });
    const pick = flavors.find((f) => (which === 'beta' ? f.role === 'beta' : f.role !== 'beta')) || flavors[0];
    return setFolder(which, pick.path);
  }
  setFolder(which, flavors[0].path);
}));
$('#redetect').addEventListener('click', detect);

// ---- 2. snapshots ----------------------------------------------------------------------

async function refreshSnapshotView() {
  const beta = S.settings.betaPath;
  $('#snap-nobeta').hidden = !!beta;
  $('#snap-form').hidden = !beta;
  if (beta) {
    const accounts = await call('wow:accounts', beta).catch(() => []);
    const sel = $('#snap-account');
    const prev = sel.value;
    sel.innerHTML = accounts.length ? accounts.map((a) => `<option>${esc(a)}</option>`).join('') : '<option value="">No accounts in this game folder</option>';
    if (accounts.includes(prev)) sel.value = prev;
    await loadSnapChars();
    S.betaAddons = await call('wow:addons', beta).catch(() => []);
    renderSnapAddons();
  }
  await refreshSnapshotList();
}

async function loadSnapChars() {
  const beta = S.settings.betaPath;
  const account = $('#snap-account').value;
  const grid = $('#snap-chars');
  if (!account) { grid.innerHTML = '<span class="muted">No characters found.</span>'; return; }
  const chars = await call('wow:characters', beta, account).catch(() => []);
  if (!chars.length) { grid.innerHTML = '<span class="muted">No characters found on this account.</span>'; return; }
  grid.innerHTML = chars.map((c, i) => `
    <button class="char${S.selectedChar && S.selectedChar.charFolder === c.charFolder && S.selectedChar.realmFolder === c.realmFolder ? ' selected' : ''}" data-i="${i}">
      <span class="nm">${esc(c.first)} ${esc(c.last)}</span>
      <span class="meta">Realm folder ${esc(c.realmFolder)}${c.modified ? ' · ' + esc(fmtDate(c.modified)) : ''}</span>
    </button>`).join('');
  grid.querySelectorAll('.char').forEach((b) => b.addEventListener('click', () => {
    S.selectedChar = chars[Number(b.dataset.i)];
    grid.querySelectorAll('.char').forEach((x) => x.classList.toggle('selected', x === b));
    $('#snap-first').value = S.selectedChar.first;
    $('#snap-last').value = S.selectedChar.last;
    if (!$('#snap-name').dataset.touched) $('#snap-name').value = `${S.selectedChar.first} ${S.selectedChar.last}`.trim();
    markAddonsEnabled();
  }));
}

async function markAddonsEnabled() {
  if (!S.selectedChar) return;
  const c = S.selectedChar;
  const enabled = await call('wow:addonsTxt', S.settings.betaPath, $('#snap-account').value, c.realmFolder, c.charFolder).catch(() => ({}));
  $$('#snap-addon-list input[data-addon]').forEach((i) => { i.checked = enabled[i.dataset.addon] !== false; });
  updateAddonCount();
}

function addonListHtml(addons, attr) {
  return '<div class="tools"><button class="btn small" data-all="1">All</button><button class="btn small" data-all="0">None</button></div>'
    + addons.map((a) => `<label title="${esc(a.name)}${a.version ? ' ' + esc(a.version) : ''}"><input type="checkbox" ${attr}="${esc(a.name)}" checked> ${esc(a.title)}${a.version ? ` <span class="muted">${esc(a.version)}</span>` : ''}</label>`).join('');
}
function wireAllNone(container, after) {
  container.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    container.querySelectorAll('input[type=checkbox]').forEach((i) => { i.checked = b.dataset.all === '1'; });
    if (after) after();
  }));
}

function renderSnapAddons() {
  const list = $('#snap-addon-list');
  list.innerHTML = S.betaAddons.length ? addonListHtml(S.betaAddons, 'data-addon') : '<span class="muted">No addons installed.</span>';
  wireAllNone(list, updateAddonCount);
  list.addEventListener('change', updateAddonCount);
  markAddonsEnabled();
  updateAddonCount();
}
function updateAddonCount() {
  const all = $$('#snap-addon-list input[data-addon]');
  const on = all.filter((i) => i.checked).length;
  $('#snap-addon-count').textContent = all.length ? `(${on} of ${all.length})` : '(none installed)';
}

$('#snap-account').addEventListener('change', () => { S.selectedChar = null; loadSnapChars(); });
$('#snap-name').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
$('#snap-inc-addons').addEventListener('change', (e) => { $('#snap-addon-details').hidden = !e.target.checked; });

$('#snap-take').addEventListener('click', async () => {
  const status = $('#snap-status');
  if (!S.selectedChar) { status.className = 'status err'; status.textContent = 'Pick a character first.'; return; }
  const first = $('#snap-first').value.trim();
  if (!first) { status.className = 'status err'; status.textContent = 'Type the character\'s first name.'; return; }
  $('#snap-take').disabled = true;
  status.className = 'status';
  status.textContent = 'Taking snapshot…';
  try {
    const addons = $('#snap-inc-addons').checked ? $$('#snap-addon-list input[data-addon]').filter((i) => i.checked).map((i) => i.dataset.addon) : [];
    const m = await call('snap:create', {
      flavorPath: S.settings.betaPath,
      account: $('#snap-account').value,
      realmFolder: S.selectedChar.realmFolder,
      charFolder: S.selectedChar.charFolder,
      first,
      last: $('#snap-last').value.trim(),
      name: $('#snap-name').value.trim(),
      addons,
      includeAccount: $('#snap-inc-account').checked,
      includeClientConfig: $('#snap-inc-config').checked,
    });
    status.className = 'status ok';
    status.textContent = `Saved "${m.name}" (${fmtSize(m.size)}).`;
    $('#snap-name').dataset.touched = '';
    await refreshSnapshotList();
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  } finally {
    $('#snap-take').disabled = false;
  }
});

function identityKv(idn) {
  const v = (x) => (x ? `<b>${esc(x)}</b>` : '<span class="muted">not found</span>');
  return `<div class="kv">
    <span>Ruleset ${idn.ruleset ? `<b>${esc(RULESET_LABEL[idn.ruleset] || idn.ruleset)}</b>` : v('')}</span>
    <span>Faction ${v(idn.faction)}</span>
    <span>Realm name ${v(idn.realmName)}</span>
    <span>GUID ${v(idn.guid)}</span>
  </div>`;
}

const LAYOUT_EXPORT_HELP = 'In game, open Edit Mode, pick the layout, then use Share › Copy to Clipboard and paste it here.';
const LAYOUT_IMPORT_HELP = 'On the new character, open Edit Mode, open the layout dropdown, choose Import, paste, name it and save.';

// The Edit Mode layouts kept with a snapshot, each with a Copy button (and Remove when editable).
function layoutsHtml(m, editable) {
  const list = m.layouts || [];
  const rows = list.map((l, i) => `<div class="layout-row" data-li="${i}">
      <span class="nm">${esc(l.name)}</span><span class="muted">${l.text.length.toLocaleString()} characters</span>
      <button class="btn small" data-layout-copy="${i}">Copy</button>
      ${editable ? `<button class="btn small danger" data-layout-remove="${i}">Remove</button>` : ''}
    </div>`).join('');
  return `<div class="layouts">
    <div class="label">Edit Mode layouts</div>
    ${rows || `<div class="muted">${editable ? 'None saved yet.' : 'None saved with this snapshot. Add one on the Snapshots page.'}</div>`}
    ${editable ? `<details class="layout-add"><summary>Add a layout</summary>
      <p class="muted">${esc(LAYOUT_EXPORT_HELP)}</p>
      <input data-layout-name placeholder="Layout name, e.g. Leveling" autocomplete="off">
      <textarea data-layout-text rows="4" placeholder="Paste the layout string here" spellcheck="false"></textarea>
      <button class="btn small" data-layout-save>Save layout</button>
    </details>` : (list.length ? `<p class="muted">${esc(LAYOUT_IMPORT_HELP)}</p>` : '')}
  </div>`;
}

function wireLayouts(container, m, onChange) {
  container.querySelectorAll('[data-layout-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await call('clipboard:write', m.layouts[Number(b.dataset.layoutCopy)].text);
      toast(`Copied "${m.layouts[Number(b.dataset.layoutCopy)].name}". ${LAYOUT_IMPORT_HELP}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }));
  const save = async (layouts) => {
    try {
      await call('snap:update', m.id, { layouts });
      if (onChange) onChange();
    } catch (e) { toast(e.message, 'err'); }
  };
  container.querySelectorAll('[data-layout-remove]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Remove this layout from the snapshot?')) return;
    save((m.layouts || []).filter((_, i) => i !== Number(b.dataset.layoutRemove)));
  }));
  const add = container.querySelector('[data-layout-save]');
  if (add) add.addEventListener('click', () => {
    const text = container.querySelector('[data-layout-text]').value.trim();
    if (!text) return toast('Paste the layout string first.', 'err');
    const name = container.querySelector('[data-layout-name]').value.trim() || `Layout ${(m.layouts || []).length + 1}`;
    save([...(m.layouts || []), { name, text }]);
    toast(`Saved layout "${name}" with this snapshot.`, 'ok');
  });
}

async function refreshSnapshotList() {
  S.snapshots = await call('snap:list').catch(() => []);
  const list = $('#snap-list');
  if (!S.snapshots.length) { list.innerHTML = '<div class="notice">No snapshots yet.</div>'; return; }
  list.innerHTML = S.snapshots.map((m) => `
    <div class="card snap" data-id="${esc(m.id)}">
      <div>
        <div class="title">${esc(m.name)}</div>
        <div class="kv">
          <span><b>${esc(m.source.identity.first)} ${esc(m.source.identity.last)}</b></span>
          <span>${esc(m.source.flavor)} · realm folder ${esc(m.source.realmFolder)}</span>
          <span>${esc(fmtDate(m.createdAt))}</span>
          <span>${m.addons.length} addons · ${m.accountSavedVariables.length} account data files · ${fmtSize(m.size)}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary small" data-act="apply">Apply…</button>
        <button class="btn small" data-act="export">Export</button>
        <button class="btn small" data-act="open">Open folder</button>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
      <div class="detected">
        <div class="label">Found in its addon data</div>
        ${identityKv(m.source.identity)}
        ${m.warnings && m.warnings.length ? `<div class="notice warn"><ul>${m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <div class="detected">${layoutsHtml(m, true)}</div>
    </div>`).join('');
  list.querySelectorAll('.snap').forEach((card) => {
    const id = card.dataset.id;
    wireLayouts(card, S.snapshots.find((x) => x.id === id), refreshSnapshotList);
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      try {
        if (b.dataset.act === 'apply') { S.applySnapshot = id; show('apply'); }
        if (b.dataset.act === 'export') { const p = await call('snap:export', id); if (p) toast('Exported to ' + p, 'ok'); }
        if (b.dataset.act === 'open') await call('snap:openFolder', id);
        if (b.dataset.act === 'delete') {
          if (!confirm('Delete this snapshot? This can\'t be undone (export it first to keep a copy).')) return;
          await call('snap:delete', id);
          refreshSnapshotList();
        }
      } catch (e) { toast(e.message, 'err'); }
    }));
  });
}

$('#snap-import').addEventListener('click', async () => {
  try {
    const m = await call('snap:import');
    if (m) { toast(`Imported "${m.name}".`, 'ok'); refreshSnapshotList(); }
  } catch (e) { toast(e.message, 'err'); }
});

// ---- 3. apply --------------------------------------------------------------------------

function currentSnapshot() {
  return S.snapshots.find((s) => s.id === $('#ap-snapshot').value) || null;
}

async function refreshApplyView() {
  S.snapshots = await call('snap:list').catch(() => []);
  $('#apply-empty').hidden = S.snapshots.length > 0;
  $('#apply-form').hidden = S.snapshots.length === 0;
  if (!S.snapshots.length) return;
  const sel = $('#ap-snapshot');
  const want = S.applySnapshot || sel.value || S.snapshots[0].id;
  S.applySnapshot = null;
  sel.innerHTML = S.snapshots.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.source.identity.first)} ${esc(m.source.identity.last)} (${esc(fmtDate(m.createdAt))})</option>`).join('');
  sel.value = S.snapshots.some((s) => s.id === want) ? want : S.snapshots[0].id;

  fillTargetSelect();
  await loadTargetAccounts();
  loadSnapshotIntoForm();
}

// The game folder a snapshot goes to: live by default, the beta (or any other detected
// folder) for trying a snapshot out before launch.
function targetPath() {
  return $('#ap-target').value || S.settings.livePath || '';
}

function fillTargetSelect() {
  const sel = $('#ap-target');
  const prev = sel.value;
  const opts = [];
  const add = (p, label) => { if (p && !opts.some((o) => o.p === p)) opts.push({ p, label }); };
  add(S.settings.livePath, `Live — ${S.settings.livePath}`);
  add(S.settings.betaPath, `Beta, for testing — ${S.settings.betaPath}`);
  for (const f of allFlavors()) add(f.path, `${f.label} — ${f.path}`);
  sel.innerHTML = opts.length ? opts.map((o) => `<option value="${esc(o.p)}">${esc(o.label)}</option>`).join('') : '<option value="">Choose the game folders first</option>';
  if (opts.some((o) => o.p === prev)) sel.value = prev;
}

async function loadTargetAccounts() {
  const target = targetPath();
  const accounts = target ? await call('wow:accounts', target).catch(() => []) : [];
  const acc = $('#ap-account');
  const prev = acc.value;
  acc.innerHTML = accounts.map((a) => `<option>${esc(a)}</option>`).join('') + '<option value="__custom">Type a folder name…</option>';
  const snap = currentSnapshot();
  acc.value = accounts.includes(prev) ? prev : accounts.includes(snap.source.account) ? snap.source.account : accounts[0] || '__custom';
  if (acc.value === '__custom' && !$('#ap-account-custom').value) $('#ap-account-custom').value = snap.source.account;
  $('#ap-account-custom').hidden = acc.value !== '__custom';
}

function loadSnapshotIntoForm() {
  const m = currentSnapshot();
  if (!m) return;
  const idn = m.source.identity;
  $('#ap-source').innerHTML = `<span><b>${esc(idn.first)} ${esc(idn.last)}</b></span><span>${esc(m.source.flavor)} · realm folder ${esc(m.source.realmFolder)}</span>${identityKv(idn)}`;
  $('#ap-layouts').innerHTML = layoutsHtml(m, false);
  wireLayouts($('#ap-layouts'), m);
  for (const k of ['first', 'last', 'ruleset', 'faction', 'realmName', 'guid']) $(`#src-${k.toLowerCase()}`).value = idn[k] || '';
  if (idn.ruleset && !$('#ap-ruleset').dataset.touched) $('#ap-ruleset').value = idn.ruleset;

  const addonList = $('#ap-addon-list');
  addonList.innerHTML = m.addons.length ? addonListHtml(m.addons, 'data-addon') : '<span class="muted">This snapshot has no addons.</span>';
  wireAllNone(addonList, invalidate);
  const svList = $('#ap-sv-list');
  const svs = m.accountSavedVariables.map((f) => ({ name: f, title: f }));
  svList.innerHTML = svs.length ? addonListHtml(svs, 'data-sv') : '<span class="muted">This snapshot has no account-wide addon data.</span>';
  wireAllNone(svList, invalidate);
  invalidate();
  inspect();
}

function accountValue() {
  const v = $('#ap-account').value;
  return v === '__custom' ? $('#ap-account-custom').value.trim() : v;
}

const inspect = debounce(async () => {
  const m = currentSnapshot();
  const first = $('#ap-first').value.trim();
  const last = $('#ap-last').value.trim();
  const found = $('#ap-found');
  const chips = $('#ap-chars');
  if (!m || !targetPath()) { found.className = 'found warn'; found.textContent = 'Choose the game folders first, under Game folders.'; chips.innerHTML = ''; return; }
  try {
    const r = await call('target:inspect', { flavorPath: targetPath(), account: accountValue(), first, last, snapshotId: m.id });
    chips.innerHTML = r.characters.length
      ? 'Characters here: ' + r.characters.map((c, i) => `<button class="chip" data-i="${i}">${esc(c.first)} ${esc(c.last)}</button>`).join('')
      : '';
    chips.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      const c = r.characters[Number(b.dataset.i)];
      $('#ap-first').value = c.first;
      $('#ap-last').value = c.last;
      invalidate();
      inspect();
    }));
    $('#ap-realm-list').innerHTML = r.realms.map((x) => `<option value="${esc(x)}">`).join('');
    $('#ap-realm').placeholder = r.found ? r.found.realmFolder : (r.realms.length === 1 ? `e.g. ${r.realms[0]}` : 'unknown: log in once first');
    $('#ap-charfolder').placeholder = r.found ? r.found.charFolder : (r.suggestedFolder || 'found automatically');
    const d = r.detected || {};
    $('#ap-realmname').placeholder = d.realmName || 'unknown until the character logs in';
    $('#ap-guid').placeholder = d.guid || 'Player-… (unknown until the character logs in)';
    S.detectedTarget = d;
    if (!first) { found.className = 'found'; found.textContent = ''; return; }
    if (!r.accountExists) { found.className = 'found warn'; found.textContent = `The account folder "${accountValue()}" isn't in this game folder yet. Log in once so WoW creates it.`; return; }
    if (r.found) {
      found.className = 'found ok';
      found.textContent = `✓ Found ${r.found.charFolder} in realm folder ${r.found.realmFolder}` + (d.guid ? ` (GUID ${d.guid})` : '');
    } else {
      found.className = 'found warn';
      found.textContent = `No folder for ${first} ${last} on this account yet. Log in to the character once, exit the game, and this updates.`;
    }
  } catch (e) {
    found.className = 'found warn';
    found.textContent = e.message;
  }
}, 250);

function optionsFromForm() {
  const radio = (name) => ($(`input[name=${name}]:checked`) || {}).value;
  const picked = (sel, attr) => {
    const all = $$(`${sel} input[${attr}]`);
    const on = all.filter((i) => i.checked).map((i) => i.getAttribute(attr));
    return on.length === all.length ? null : on;
  };
  return {
    addons: radio('ap-addons'),
    addonList: picked('#ap-addon-list', 'data-addon'),
    accountSavedVariables: radio('ap-sv'),
    savedVariablesList: picked('#ap-sv-list', 'data-sv'),
    characterSettings: $('#ap-char').checked,
    accountFiles: $('#ap-acct').checked,
    clientConfig: $('#ap-config').checked,
    disableServerSync: $('#ap-sync').checked,
    loadOutOfDate: $('#ap-ood').checked,
    dropOtherCharacters: $('#ap-drop').checked,
    firstNameOnly: $('#ap-firstname').checked,
  };
}

function requestFromForm() {
  const m = currentSnapshot();
  const d = S.detectedTarget || {};
  return {
    snapshotId: m.id,
    sourceIdentity: {
      first: $('#src-first').value.trim(),
      last: $('#src-last').value.trim(),
      ruleset: $('#src-ruleset').value.trim(),
      faction: $('#src-faction').value.trim(),
      realmName: $('#src-realmname').value.trim(),
      guid: $('#src-guid').value.trim(),
    },
    target: {
      flavorPath: targetPath(),
      account: accountValue(),
      realmFolder: $('#ap-realm').value.trim(),
      charFolder: $('#ap-charfolder').value.trim(),
      identity: {
        first: $('#ap-first').value.trim(),
        last: $('#ap-last').value.trim(),
        ruleset: $('#ap-ruleset').value,
        faction: $('#ap-faction').value,
        realmName: $('#ap-realmname').value.trim() || d.realmName || '',
        guid: $('#ap-guid').value.trim() || d.guid || '',
      },
    },
    options: optionsFromForm(),
  };
}

function invalidate() {
  S.plan = null;
  $('#ap-run').disabled = true;
  if ($('#ap-plan').innerHTML) $('#ap-plan').innerHTML = '<div class="notice">Settings changed. Preview again before applying.</div>';
}

function rewritesHtml(list) {
  return list.map((r) => `<div><code>${esc(r.from)}</code><span class="arrow">→</span><code>${esc(r.to)}</code> <span class="muted">×${r.count}</span></div>`).join('');
}

function renderPlan(plan) {
  const out = [];
  if (plan.errors && plan.errors.length) out.push(`<div class="notice err"><b>Can't apply yet</b><ul>${plan.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`);
  if (!plan.ok) return void ($('#ap-plan').innerHTML = out.join(''));
  if (plan.warnings.length) out.push(`<div class="notice warn"><b>Check before applying</b><ul>${plan.warnings.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`);

  const t = plan.target;
  out.push(`<div class="card"><h2>Target</h2><div class="kv">
    <span><b>${esc(t.identity.first)} ${esc(t.identity.last)}</b></span>
    <span>Folder <code>WTF\\Account\\${esc(t.account)}\\${esc(t.realmFolder)}\\${esc(t.charFolder)}</code> ${t.found ? '<span class="pill ok">exists</span>' : '<span class="pill warn">will be created</span>'}</span>
    <span>Ruleset <b>${esc(RULESET_LABEL[t.identity.ruleset] || t.identity.ruleset || '—')}</b></span>
  </div></div>`);

  const rules = [...plan.rules.substring, ...plan.rules.exact.map((r) => ({ ...r, label: r.label + ' (whole text only)' })), ...plan.rules.keys.map((r) => ({ ...r, label: r.label }))];
  out.push(`<div class="card"><h2>Replacements</h2>${rules.length ? `<table><tr><th>From</th><th></th><th>To</th><th>What</th></tr>${rules.map((r) => `<tr><td><code>${esc(r.from)}</code></td><td class="arrow">→</td><td><code>${esc(r.to)}</code></td><td class="muted">${esc(r.label)}</td></tr>`).join('')}</table>` : '<span class="muted">Nothing to rename: the new character has the same name and ruleset.</span>'}</div>`);

  const files = plan.actions.filter((a) => a.op === 'file');
  const addons = plan.actions.filter((a) => a.op === 'addon');
  const modeLabel = { new: 'new', overwrite: 'replace', merge: 'merge', keep: 'keep installed' };
  const totalRewrites = files.reduce((n, a) => n + a.rewrites.reduce((m, r) => m + r.count, 0), 0);
  out.push(`<div class="card"><h2>Files <span class="pill">${files.length}</span> <span class="muted normal">${totalRewrites} replacements</span></h2>
    <table><tr><th>File</th><th>Action</th><th>Changes</th></tr>
    ${files.map((a) => `<tr><td><code>${esc(a.rel)}</code></td><td><span class="pill ${a.mode}">${modeLabel[a.mode]}</span></td><td>
      ${a.rewrites.length ? `<details><summary>${a.rewrites.reduce((m, r) => m + r.count, 0)} replaced</summary>${rewritesHtml(a.rewrites)}</details>` : ''}
      ${a.dropped ? `<div class="muted">${a.dropped} other-character entries left out</div>` : ''}
      ${a.changes ? `<details><summary>${a.changes.length} settings</summary>${a.changes.map((c) => `<div><code>${esc(c)}</code></div>`).join('')}</details>` : ''}
      ${!a.rewrites.length && !a.dropped && !a.changes ? '<span class="muted">copied as is</span>' : ''}
    </td></tr>`).join('')}
    </table></div>`);
  if (addons.length) {
    out.push(`<div class="card"><h2>Addons <span class="pill">${addons.filter((a) => a.mode !== 'keep').length} to install</span></h2>
      <table><tr><th>Addon</th><th>Action</th><th>Version</th></tr>
      ${addons.map((a) => `<tr><td>${esc(a.title)}</td><td><span class="pill ${a.mode}">${modeLabel[a.mode]}</span></td><td class="muted">${esc(a.version || '')}${a.mode === 'keep' && a.liveVersion ? ` (installed: ${esc(a.liveVersion)})` : ''}</td></tr>`).join('')}
      </table></div>`);
  }
  $('#ap-plan').innerHTML = out.join('');
}

$('#ap-preview').addEventListener('click', async () => {
  const status = $('#ap-status');
  status.className = 'status';
  status.textContent = 'Working out the changes…';
  $('#ap-preview').disabled = true;
  try {
    const plan = await call('apply:plan', requestFromForm());
    S.plan = plan;
    renderPlan(plan);
    $('#ap-run').disabled = !plan.ok;
    status.textContent = plan.ok ? 'Preview ready. Nothing has been changed yet.' : '';
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  } finally {
    $('#ap-preview').disabled = false;
  }
});

$('#ap-run').addEventListener('click', async () => {
  if (!S.plan || !S.plan.ok) return;
  const t = S.plan.target;
  if (!confirm(`Apply "${S.plan.snapshot.name}" to ${t.identity.first} ${t.identity.last}?\n\nMake sure World of Warcraft is closed. Every file that changes is backed up first.`)) return;
  const status = $('#ap-status');
  status.className = 'status';
  status.textContent = 'Backing up and applying…';
  $('#ap-run').disabled = true;
  try {
    let backup;
    try {
      backup = await call('apply:run', requestFromForm());
    } catch (e) {
      if (/running/.test(e.message) && confirm(e.message + '\n\nApply anyway?')) backup = await call('apply:run', { ...requestFromForm(), ignoreRunning: true });
      else throw e;
    }
    status.className = 'status ok';
    status.textContent = 'Done.';
    $('#ap-plan').innerHTML = `<div class="notice ok"><b>Applied to ${esc(t.identity.first)} ${esc(t.identity.last)}.</b> Log in to check it. If anything looks wrong, restore backup <code>${esc(backup.id)}</code> under Backups.
      <details><summary>${backup.log.length} changes</summary>${backup.log.map((l) => `<div><code>${esc(l)}</code></div>`).join('')}</details></div>`;
    const snap = currentSnapshot();
    if (snap && snap.layouts && snap.layouts.length) {
      $('#ap-plan').insertAdjacentHTML('beforeend', `<div class="card"><h2>Last step: Edit Mode</h2>${layoutsHtml(snap, false)}</div>`);
      wireLayouts($('#ap-plan'), snap);
    }
    S.plan = null;
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  }
});

$('#ap-snapshot').addEventListener('change', loadSnapshotIntoForm);
$('#ap-target').addEventListener('change', async () => {
  await loadTargetAccounts();
  invalidate();
  inspect();
});
$('#ap-account').addEventListener('change', (e) => {
  $('#ap-account-custom').hidden = e.target.value !== '__custom';
  invalidate();
  inspect();
});
$('#ap-ruleset').addEventListener('change', (e) => { e.target.dataset.touched = '1'; });
$('#apply-form').addEventListener('input', (e) => {
  if (e.target.closest('#ap-plan')) return;
  invalidate();
  if (['ap-first', 'ap-last', 'ap-account-custom'].includes(e.target.id)) inspect();
});
$('#apply-form').addEventListener('change', (e) => { if (!e.target.closest('#ap-plan') && e.target.id !== 'ap-snapshot') invalidate(); });

$('#src-save').addEventListener('click', async (e) => {
  e.preventDefault();
  const m = currentSnapshot();
  try {
    await call('snap:update', m.id, { identity: requestFromForm().sourceIdentity });
    S.snapshots = await call('snap:list');
    toast('Saved to the snapshot.', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// ---- backups ---------------------------------------------------------------------------

async function refreshBackups() {
  const list = $('#backup-list');
  const backups = await call('backups:list').catch(() => []);
  if (!backups.length) { list.innerHTML = '<div class="notice">No backups yet. One is made every time you apply a snapshot.</div>'; return; }
  list.innerHTML = backups.map((b) => `
    <div class="card snap" data-id="${esc(b.id)}">
      <div>
        <div class="title">${esc(fmtDate(b.createdAt))}</div>
        <div class="kv">
          <span>"${esc(b.snapshot.name)}" → <b>${esc(b.target.identity.first)} ${esc(b.target.identity.last)}</b></span>
          <span><code>${esc(b.target.account)}\\${esc(b.target.realmFolder)}\\${esc(b.target.charFolder)}</code></span>
          <span>${b.entries.length} files and folders</span>
          ${b.restoredAt ? `<span class="pill ok">restored ${esc(fmtDate(b.restoredAt))}</span>` : ''}
          ${b.complete ? '' : '<span class="pill warn">apply didn\'t finish</span>'}
        </div>
      </div>
      <div class="actions">
        <button class="btn small" data-act="restore">Restore</button>
        <button class="btn small" data-act="open">Open folder</button>
        <button class="btn small danger" data-act="delete">Delete</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('.snap').forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        if (btn.dataset.act === 'restore') {
          if (!confirm('Put every file this apply changed back the way it was, and remove the files it added?')) return;
          const r = await call('backups:restore', id);
          toast(`Restored ${r.log.length} files and folders.`, 'ok');
        }
        if (btn.dataset.act === 'open') await call('backups:openFolder', id);
        if (btn.dataset.act === 'delete') {
          if (!confirm('Delete this backup? You won\'t be able to undo that apply any more.')) return;
          await call('backups:delete', id);
        }
        refreshBackups();
      } catch (e) { toast(e.message, 'err'); }
    }));
  });
}

// ---- start -----------------------------------------------------------------------------

(async () => {
  const info = await call('app:info');
  $('#version').textContent = 'Version ' + info.version;
  S.settings = await call('settings:get');
  show('setup');
  for (const which of ['beta', 'live']) { fillFlavorSelect(which); describeFolder(which); }
  await detect();
  S.snapshots = await call('snap:list').catch(() => []);
  if (S.settings.betaPath && S.settings.livePath && S.snapshots.length) show('apply');
})();
