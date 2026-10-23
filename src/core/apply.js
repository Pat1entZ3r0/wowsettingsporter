'use strict';
// Applying a snapshot to a character: planning every write (so it can be previewed),
// backing up whatever would be touched, writing, and restoring a backup.

const fs = require('fs');
const path = require('path');
const lua = require('./lua');
const wow = require('./wow');
const snapshots = require('./snapshot');
const id = require('./identity');

const DEFAULT_OPTIONS = {
  addons: 'missing', // 'missing' | 'overwrite' | 'none'
  addonList: null, // null = every addon in the snapshot
  characterSettings: true,
  accountFiles: true, // account-wide bindings, macros and settings caches
  accountSavedVariables: 'merge', // 'merge' | 'replace' | 'skip'
  savedVariablesList: null, // null = every account SavedVariables file in the snapshot
  clientConfig: true, // copy Config.wtf (camera, graphics, sound and other client options)
  disableServerSync: true,
  loadOutOfDate: true,
  dropOtherCharacters: true,
  firstNameOnly: true,
};

// Config.wtf values that belong to the install or the login, never copied across.
const CONFIG_BLOCKLIST = new Set([
  'accountname', 'accountlist', 'portal', 'realmlist', 'realmlistbn', 'realmname', 'lastcharacterindex',
  'lastcharacterguid', 'lastaccountname', 'agentuid', 'installtype', 'installlocale', 'textlocale',
  'audiolocale', 'patchlist', 'serveralert', 'launchagent', 'hwdetect', 'gxadapter', 'checkaddonversion',
]);
const SYNC_CVARS = ['synchronizeSettings', 'synchronizeConfig', 'synchronizeBindings', 'synchronizeMacros', 'synchronizeChatFrames'];

const TEXT_FILE = /\.(txt|wtf)$/i;
const NAME_RE = /^[\p{L}]{2,12}$/u;
const UNSAFE_RE = /[\\/:*?"<>|\u0000-\u001f]|^\.+$/;

function ensureInside(base, p) {
  const b = path.resolve(base) + path.sep;
  const r = path.resolve(p);
  if (!(r + path.sep).startsWith(b)) throw new Error(`Refusing to write outside the game folder: ${p}`);
  return r;
}

function validateName(label, s, required) {
  const errors = [];
  const warnings = [];
  if (!s) {
    if (required) errors.push(`${label} is required.`);
    return { errors, warnings };
  }
  if (UNSAFE_RE.test(s)) errors.push(`${label} "${s}" has characters that can't be in a folder name.`);
  else if (!NAME_RE.test(s)) warnings.push(`${label} "${s}" doesn't look like a WoW Forever name (2 to 12 letters).`);
  return { errors, warnings };
}

function parseConfig(text) {
  return text.split(/\r?\n/).map((line) => {
    const m = /^SET\s+(\S+)\s+"(.*)"\s*$/.exec(line);
    return m ? { line, name: m[1], value: m[2] } : { line };
  });
}
function configText(lines) {
  return lines.map((l) => (l.name ? `SET ${l.name} "${l.value}"` : l.line)).join('\r\n').replace(/(\r\n)*$/, '\r\n');
}
function setCvar(lines, name, value, changes) {
  const cur = lines.find((l) => l.name && l.name.toLowerCase() === name.toLowerCase());
  if (cur) {
    if (cur.value !== value) changes.push(`${name}: "${cur.value}" → "${value}"`);
    cur.value = value;
  } else {
    // keep a trailing blank line at the end
    let at = lines.length;
    while (at > 0 && !lines[at - 1].name && lines[at - 1].line.trim() === '') at--;
    lines.splice(at, 0, { line: '', name, value });
    changes.push(`${name} = "${value}"`);
  }
}

function sourceIdentity(manifest, override) {
  return { ...manifest.source.identity, ...(override || {}) };
}

/**
 * What's already there for a target character, for the form: its folder if the character
 * has logged in once, the realm folders, and what its live data says about it.
 */
function inspectTarget({ flavorPath, account, first, last, manifest }) {
  const out = { accountExists: false, realms: [], found: null, suggestedFolder: '', detected: null, characters: [] };
  if (!flavorPath || !account) return out;
  out.accountExists = wow.isDir(wow.accountDir(flavorPath, account));
  out.realms = out.accountExists ? wow.listRealms(flavorPath, account) : [];
  out.characters = out.accountExists ? wow.listCharacters(flavorPath, account) : [];
  if (!first) return out;
  const src = manifest ? manifest.source.identity : null;
  out.suggestedFolder = id.folderNameFor(manifest ? manifest.source.charFolder : '', src, { first, last });
  const candidates = [out.suggestedFolder, last ? `${first}-${last}` : first, last ? `${first} ${last}` : first, `${first}${last || ''}`];
  out.found = out.accountExists ? wow.findCharacter(flavorPath, account, candidates) : null;
  if (out.accountExists) {
    const acct = wow.accountDir(flavorPath, account);
    const charSv = out.found ? path.join(acct, out.found.realmFolder, out.found.charFolder, 'SavedVariables') : null;
    const parsed = snapshots.parseSavedVariables(path.join(acct, 'SavedVariables'), charSv, null);
    out.detected = id.detectIdentity(parsed, first, last, out.found ? out.found.realmFolder : '');
  }
  return out;
}

/**
 * Works out every write an apply would make, with the new contents, without touching the
 * game folder. opts: { dataDir, snapshotId, sourceIdentity?, target: { flavorPath, account,
 * realmFolder, charFolder?, identity: { first, last, ruleset, realmName, faction, guid } },
 * options }.
 */
function planApply(opts) {
  const options = { ...DEFAULT_OPTIONS, ...(opts.options || {}) };
  const manifest = snapshots.getSnapshot(opts.dataDir, opts.snapshotId);
  const snapDir = snapshots.snapshotDir(opts.dataDir, opts.snapshotId);
  const t = opts.target || {};
  const errors = [];
  const warnings = [];

  const src = sourceIdentity(manifest, opts.sourceIdentity);
  const tgt = { ruleset: '', realmName: '', faction: '', guid: '', ...(t.identity || {}) };
  for (const k of Object.keys(tgt)) tgt[k] = String(tgt[k] ?? '').trim();
  if (!tgt.faction) tgt.faction = src.faction;

  for (const [label, v, req] of [['First name', tgt.first, true], ['Last name', tgt.last, false]]) {
    const r = validateName(label, v, req);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  if (!t.flavorPath || !wow.isDir(t.flavorPath)) errors.push('Choose the game folder to apply to.');
  if (!t.account) errors.push('Choose or type the WTF account folder.');
  else if (UNSAFE_RE.test(t.account)) errors.push('The account folder name has characters that can\'t be in a folder name.');
  if (errors.length) return { ok: false, errors, warnings, actions: [] };

  let realmFolder = String(t.realmFolder || '').trim();
  let charFolder = String(t.charFolder || '').trim();
  const look = inspectTarget({ flavorPath: t.flavorPath, account: t.account, first: tgt.first, last: tgt.last, manifest });
  if (!charFolder) charFolder = look.found ? look.found.charFolder : look.suggestedFolder;
  // what the target's own data says, where the form left it blank
  if (look.detected) {
    if (!tgt.guid && look.found) tgt.guid = look.detected.guid;
    if (!tgt.realmName) tgt.realmName = look.detected.realmName;
  }
  if (!realmFolder && look.found) realmFolder = look.found.realmFolder;
  if (!realmFolder) errors.push('The realm folder for this character is unknown. Log in to the new character once (then exit the game) so WoW creates its folder, or type the realm folder number.');
  if (UNSAFE_RE.test(realmFolder) || UNSAFE_RE.test(charFolder)) errors.push('The realm or character folder name has characters that can\'t be in a folder name.');
  if (errors.length) return { ok: false, errors, warnings, actions: [] };

  if (!look.accountExists) warnings.push(`The account folder "${t.account}" doesn't exist in this game folder yet; it will be created. Logging in once first is safer.`);
  else if (!look.found) warnings.push(`No folder for ${id.fullName(tgt)} was found on this account, so "${realmFolder}/${charFolder}" will be created. If the character hasn't logged in yet, log in once and exit first so the folder names are WoW's own.`);
  if (look.found && (look.found.realmFolder !== realmFolder || look.found.charFolder !== charFolder)) {
    warnings.push(`The character already has a folder at "${look.found.realmFolder}/${look.found.charFolder}", but "${realmFolder}/${charFolder}" was chosen.`);
  }
  if (!tgt.ruleset && src.ruleset) warnings.push('No ruleset was chosen, so ruleset-keyed addon data (AceDB realm and faction sections) keeps the beta ruleset.');
  if (src.realmName && !tgt.realmName) warnings.push(`Older addons key characters by realm name ("${src.realmName}" on the beta). The target's realm name isn't known yet, so those entries keep the snapshot's realm.`);
  if (src.guid && !tgt.guid) warnings.push('The beta character GUID was found in addon data, but the new character\'s GUID isn\'t known (it appears once the character has logged in with those addons), so GUID-keyed entries aren\'t moved.');

  const rules = id.buildRules(src, tgt, { firstNameOnly: options.firstNameOnly });
  const compiled = id.compileRules(rules);
  const dropKeys = options.dropOtherCharacters ? id.otherCharacterKeys(manifest.otherCharacters || [], src) : null;

  const base = t.flavorPath;
  const acctRel = path.join('WTF', 'Account', t.account);
  const charRel = path.join(acctRel, realmFolder, charFolder);
  const actions = [];

  const exists = (rel) => fs.existsSync(path.join(base, rel));

  function luaAction(fromFile, rel, merge, scope) {
    const raw = fs.readFileSync(fromFile);
    let parsed;
    try {
      parsed = lua.parse(raw.toString('latin1'));
    } catch (e) {
      const r = id.rewriteText(raw.toString('latin1'), compiled);
      warnings.push(`${path.basename(fromFile)} couldn't be read as Lua (${e.message}); names in it were replaced as plain text.`);
      return { op: 'file', scope, rel, mode: exists(rel) ? 'overwrite' : 'new', content: Buffer.from(r.content, 'latin1'), rewrites: r.stats, dropped: 0 };
    }
    const { stats, dropped } = id.rewriteFile(parsed, compiled, dropKeys);
    let mode = exists(rel) ? 'overwrite' : 'new';
    let out = parsed;
    if (merge && mode === 'overwrite') {
      try {
        const current = lua.parse(fs.readFileSync(path.join(base, rel)).toString('latin1'));
        out = lua.mergeFiles(current, parsed);
        mode = 'merge';
      } catch (e) {
        warnings.push(`The existing ${path.basename(rel)} couldn't be read (${e.message}), so it is replaced instead of merged (a backup is kept).`);
      }
    }
    const content = mode !== 'merge' && stats.length === 0 && dropped === 0 ? raw : Buffer.from(lua.serialize(out), 'latin1');
    return { op: 'file', scope, rel, mode, content, rewrites: stats, dropped };
  }

  // config-cache.wtf holds game options (auto loot, interface options...): the snapshot's values
  // go in setting by setting, so the preview can list each one and options only live has stay.
  function optionsAction(fromFile, rel, scope) {
    const incoming = parseConfig(id.rewriteText(fs.readFileSync(fromFile, 'latin1'), compiled).content);
    const there = exists(rel);
    const lines = there ? parseConfig(fs.readFileSync(path.join(base, rel), 'latin1')) : [];
    const changes = [];
    if (!there) {
      for (const l of incoming) if (l.name) changes.push(`${l.name} = "${l.value}"`);
      return { op: 'file', scope, rel, mode: 'new', content: Buffer.from(configText(incoming), 'latin1'), rewrites: [], dropped: 0, changes };
    }
    for (const l of incoming) if (l.name) setCvar(lines, l.name, l.value, changes);
    return { op: 'file', scope, rel, mode: 'merge', content: Buffer.from(configText(lines), 'latin1'), rewrites: [], dropped: 0, changes };
  }

  function textAction(fromFile, rel, scope) {
    if (/config-cache\.wtf$/i.test(fromFile)) return optionsAction(fromFile, rel, scope);
    const raw = fs.readFileSync(fromFile);
    if (!TEXT_FILE.test(fromFile)) return { op: 'file', scope, rel, mode: exists(rel) ? 'overwrite' : 'new', content: raw, rewrites: [], dropped: 0 };
    const r = id.rewriteText(raw.toString('latin1'), compiled);
    return { op: 'file', scope, rel, mode: exists(rel) ? 'overwrite' : 'new', content: r.stats.length ? Buffer.from(r.content, 'latin1') : raw, rewrites: r.stats, dropped: 0 };
  }

  function walkFiles(dir, rel = '') {
    const out = [];
    if (!wow.isDir(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      if (ent.isDirectory()) out.push(...walkFiles(path.join(dir, ent.name), r));
      else if (ent.isFile() && !snapshots.SKIP_FILE.test(ent.name)) out.push(r);
    }
    return out;
  }

  // the character's own folder: per-character SavedVariables, AddOns.txt, macros, bindings, layout
  if (options.characterSettings) {
    const from = path.join(snapDir, 'wtf', 'character');
    for (const rel of walkFiles(from)) {
      const full = path.join(from, rel);
      const target = path.join(charRel, rel);
      actions.push(rel.toLowerCase().endsWith('.lua') ? luaAction(full, target, false, 'character') : textAction(full, target, 'character'));
    }
  }

  // account-wide caches next to the SavedVariables folder
  if (options.accountFiles) {
    const from = path.join(snapDir, 'wtf', 'account');
    if (wow.isDir(from)) {
      for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
        if (ent.isFile() && !snapshots.SKIP_FILE.test(ent.name)) {
          actions.push(textAction(path.join(from, ent.name), path.join(acctRel, ent.name), 'account'));
        }
      }
    }
  }

  // account-wide SavedVariables
  if (options.accountSavedVariables !== 'skip') {
    const from = path.join(snapDir, 'wtf', 'account', 'SavedVariables');
    const list = options.savedVariablesList;
    if (wow.isDir(from)) {
      for (const f of fs.readdirSync(from).sort()) {
        if (!f.toLowerCase().endsWith('.lua')) continue;
        if (list && !list.includes(f)) continue;
        actions.push(luaAction(path.join(from, f), path.join(acctRel, 'SavedVariables', f), options.accountSavedVariables === 'merge', 'savedvariables'));
      }
    }
  }

  // Config.wtf: client settings from the beta, plus the switches for ported settings
  const cfgRel = path.join('WTF', 'Config.wtf');
  const snapCfg = path.join(snapDir, 'wtf', 'Config.wtf');
  if (options.clientConfig || options.disableServerSync || options.loadOutOfDate) {
    const lines = exists(cfgRel) ? parseConfig(fs.readFileSync(path.join(base, cfgRel), 'latin1')) : [];
    const changes = [];
    if (options.clientConfig && wow.isFile(snapCfg)) {
      for (const l of parseConfig(fs.readFileSync(snapCfg, 'latin1'))) {
        if (l.name && !CONFIG_BLOCKLIST.has(l.name.toLowerCase())) setCvar(lines, l.name, l.value, changes);
      }
    }
    if (options.disableServerSync) for (const c of SYNC_CVARS) setCvar(lines, c, '0', changes);
    if (options.loadOutOfDate) setCvar(lines, 'checkAddonVersion', '0', changes);
    if (changes.length) {
      actions.push({ op: 'file', scope: 'config', rel: cfgRel, mode: exists(cfgRel) ? 'overwrite' : 'new', content: Buffer.from(configText(lines), 'latin1'), rewrites: [], dropped: 0, changes });
    }
  }

  // the addons themselves
  if (options.addons !== 'none') {
    for (const a of manifest.addons || []) {
      if (options.addonList && !options.addonList.includes(a.name)) continue;
      const rel = path.join('Interface', 'AddOns', a.name);
      const there = wow.isDir(path.join(base, rel));
      if (there && options.addons === 'missing') {
        actions.push({ op: 'addon', rel, name: a.name, title: a.title, mode: 'keep', version: a.version, liveVersion: (wow.readToc(path.join(base, rel), a.name) || {}).version || '' });
        continue;
      }
      actions.push({ op: 'addon', rel, name: a.name, title: a.title, mode: there ? 'overwrite' : 'new', version: a.version, from: path.join(snapDir, 'addons', a.name) });
    }
  }

  for (const a of actions) ensureInside(base, path.join(base, a.rel));

  return {
    ok: true,
    errors: [],
    warnings,
    snapshot: { id: manifest.id, name: manifest.name },
    source: src,
    target: { flavorPath: base, account: t.account, realmFolder, charFolder, identity: tgt, found: !!look.found },
    rules: {
      substring: rules.sub.map(([f, to, label]) => ({ from: id.text(f), to: id.text(to), label })),
      exact: rules.exact.map(([f, to, label]) => ({ from: id.text(f), to: id.text(to), label })),
      keys: rules.keyOnly.map(([f, to, label]) => ({ from: id.text(f), to: id.text(to), label })),
    },
    actions,
  };
}

// The plan without file contents, for the UI.
function summarizePlan(plan) {
  return {
    ...plan,
    actions: plan.actions.map(({ content, from, ...a }) => ({ ...a, size: content ? content.length : undefined })),
  };
}

function backupsDir(dataDir) {
  return path.join(dataDir, 'backups');
}

function copyPath(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

/** Backs up everything the plan touches, then writes it. Returns the backup manifest. */
function executePlan(dataDir, plan) {
  if (!plan.ok) throw new Error(plan.errors.join(' '));
  const base = plan.target.flavorPath;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const backupId = `${stamp}-${plan.target.charFolder}`.replace(/[^\w.-]+/g, '_');
  const bdir = path.join(backupsDir(dataDir), backupId);
  fs.mkdirSync(path.join(bdir, 'files'), { recursive: true });

  const todo = plan.actions.filter((a) => a.mode !== 'keep');
  const entries = [];
  // directories this apply creates, removed again on restore if they end up empty
  const createdDirs = new Set();
  for (const a of todo) {
    const target = ensureInside(base, path.join(base, a.rel));
    const existed = fs.existsSync(target);
    if (existed) copyPath(target, path.join(bdir, 'files', a.rel));
    entries.push({ rel: a.rel, existed, kind: a.op === 'addon' ? 'dir' : 'file' });
    let d = path.dirname(target);
    while (!fs.existsSync(d) && (d + path.sep).startsWith(path.resolve(base) + path.sep)) {
      createdDirs.add(path.relative(base, d));
      d = path.dirname(d);
    }
  }
  // a copy of the whole WTF folder as it was, for recovery by hand
  const wtf = path.join(base, 'WTF');
  if (wow.isDir(wtf)) copyPath(wtf, path.join(bdir, 'WTF-full'));

  const backup = {
    id: backupId,
    createdAt: new Date().toISOString(),
    snapshot: plan.snapshot,
    target: plan.target,
    entries,
    createdDirs: [...createdDirs].sort((a, b) => b.length - a.length),
    complete: false,
  };
  fs.writeFileSync(path.join(bdir, 'backup.json'), JSON.stringify(backup, null, 2));

  const log = [];
  for (const a of todo) {
    const target = path.join(base, a.rel);
    if (a.op === 'addon') {
      fs.rmSync(target, { recursive: true, force: true });
      copyPath(a.from, target);
      log.push(`${a.mode === 'new' ? 'Installed' : 'Replaced'} addon ${a.title}`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, a.content);
      log.push(`${a.mode === 'new' ? 'Wrote' : a.mode === 'merge' ? 'Merged' : 'Replaced'} ${a.rel}`);
    }
  }
  backup.complete = true;
  backup.log = log;
  fs.writeFileSync(path.join(bdir, 'backup.json'), JSON.stringify(backup, null, 2));
  return backup;
}

function listBackups(dataDir) {
  const out = [];
  for (const d of wow.dirs(backupsDir(dataDir))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(backupsDir(dataDir), d, 'backup.json'), 'utf8'))); } catch { /* not a backup */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Puts every file an apply touched back the way it was. */
function restoreBackup(dataDir, backupId) {
  if (!/^[\w.-]+$/.test(backupId)) throw new Error('Bad backup id');
  const bdir = path.join(backupsDir(dataDir), backupId);
  const backup = JSON.parse(fs.readFileSync(path.join(bdir, 'backup.json'), 'utf8'));
  const base = backup.target.flavorPath;
  const log = [];
  for (const e of backup.entries) {
    const target = ensureInside(base, path.join(base, e.rel));
    fs.rmSync(target, { recursive: true, force: true });
    if (e.existed) {
      copyPath(path.join(bdir, 'files', e.rel), target);
      log.push(`Restored ${e.rel}`);
    } else {
      log.push(`Removed ${e.rel}`);
    }
  }
  for (const d of backup.createdDirs || []) {
    const p = ensureInside(base, path.join(base, d));
    try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch { /* already gone */ }
  }
  backup.restoredAt = new Date().toISOString();
  fs.writeFileSync(path.join(bdir, 'backup.json'), JSON.stringify(backup, null, 2));
  return { backup, log };
}

function deleteBackup(dataDir, backupId) {
  if (!/^[\w.-]+$/.test(backupId)) throw new Error('Bad backup id');
  fs.rmSync(path.join(backupsDir(dataDir), backupId), { recursive: true, force: true });
}

module.exports = {
  DEFAULT_OPTIONS, inspectTarget, planApply, summarizePlan, executePlan, listBackups, restoreBackup, deleteBackup,
  parseConfig, configText,
};
