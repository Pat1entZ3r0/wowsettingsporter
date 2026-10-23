'use strict';
// Snapshots: a copy of one character's setup (its WTF folder, the account's settings and
// SavedVariables, Config.wtf and the addons themselves) plus what was learned about how the
// character appears inside that data.
//
//   <dataDir>/snapshots/<id>/manifest.json
//   <dataDir>/snapshots/<id>/wtf/character/...     WTF/Account/<acct>/<realm>/<char>/
//   <dataDir>/snapshots/<id>/wtf/account/...       WTF/Account/<acct>/ files + SavedVariables/
//   <dataDir>/snapshots/<id>/wtf/Config.wtf
//   <dataDir>/snapshots/<id>/addons/<Addon>/...

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const lua = require('./lua');
const wow = require('./wow');
const { detectIdentity, splitFolderName } = require('./identity');

const FORMAT = 1;
const SKIP_FILE = /\.(bak|old|tmp)$|^cache\.md5$/i;

function snapshotsDir(dataDir) {
  return path.join(dataDir, 'snapshots');
}

function slug(s) {
  return String(s).normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';
}

function copyFiles(fromDir, toDir, filter) {
  const copied = [];
  if (!wow.isDir(fromDir)) return copied;
  for (const ent of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, ent.name);
    const to = path.join(toDir, ent.name);
    if (ent.isDirectory()) {
      for (const c of copyFiles(from, to, filter)) copied.push(path.join(ent.name, c));
    } else if (ent.isFile() && (!filter || filter(ent.name))) {
      fs.mkdirSync(toDir, { recursive: true });
      fs.copyFileSync(from, to);
      copied.push(ent.name);
    }
  }
  return copied;
}

function dirSize(dir) {
  let total = 0;
  if (!wow.isDir(dir)) return 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    total += ent.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function parseLuaFile(file) {
  return lua.parse(fs.readFileSync(file).toString('latin1'));
}

// Parses every SavedVariables file of a snapshot (or a live install) for detection.
function parseSavedVariables(accountSvDir, charSvDir, warnings) {
  const files = [];
  for (const [dir, perCharacter] of [[accountSvDir, false], [charSvDir, true]]) {
    if (!dir || !wow.isDir(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.lua')) continue;
      try {
        files.push({ name: f, perCharacter, file: parseLuaFile(path.join(dir, f)) });
      } catch (e) {
        if (warnings) warnings.push(`${perCharacter ? 'Character' : 'Account'} SavedVariables ${f} could not be read (${e.message}); it is copied with plain text replacement only.`);
      }
    }
  }
  return files;
}

/**
 * Takes a snapshot. opts: { dataDir, flavorPath, account, realmFolder, charFolder, first, last,
 * name, addons: string[] | 'all', includeAccount, includeClientConfig }.
 */
function createSnapshot(opts) {
  const { dataDir, flavorPath, account, realmFolder, charFolder } = opts;
  const acctDir = wow.accountDir(flavorPath, account);
  const charDir = path.join(acctDir, realmFolder, charFolder);
  if (!wow.isDir(charDir)) throw new Error(`Character folder not found: ${charDir}`);
  const split = splitFolderName(charFolder);
  const first = (opts.first || split.first).trim();
  const last = (opts.last ?? split.last).trim();

  const createdAt = new Date();
  const id = `${createdAt.toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${slug(opts.name || `${first} ${last}`)}`;
  const root = path.join(snapshotsDir(dataDir), id);
  const tmp = root + '.partial';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const warnings = [];

  try {
    const characterFiles = copyFiles(charDir, path.join(tmp, 'wtf', 'character'), (f) => !SKIP_FILE.test(f));

    let accountFiles = [];
    let accountSavedVariables = [];
    if (opts.includeAccount !== false) {
      for (const f of fs.readdirSync(acctDir, { withFileTypes: true })) {
        if (f.isFile() && !SKIP_FILE.test(f.name)) {
          fs.mkdirSync(path.join(tmp, 'wtf', 'account'), { recursive: true });
          fs.copyFileSync(path.join(acctDir, f.name), path.join(tmp, 'wtf', 'account', f.name));
          accountFiles.push(f.name);
        }
      }
      accountSavedVariables = copyFiles(path.join(acctDir, 'SavedVariables'), path.join(tmp, 'wtf', 'account', 'SavedVariables'),
        (f) => f.toLowerCase().endsWith('.lua'));
    }

    let clientConfig = false;
    const configWtf = path.join(flavorPath, 'WTF', 'Config.wtf');
    if (opts.includeClientConfig !== false && wow.isFile(configWtf)) {
      fs.copyFileSync(configWtf, path.join(tmp, 'wtf', 'Config.wtf'));
      clientConfig = true;
    }

    const installed = wow.listAddons(flavorPath);
    const enabled = wow.readAddOnsTxt(path.join(charDir, 'AddOns.txt'));
    const wanted = opts.addons === 'all' || opts.addons === undefined ? installed.map((a) => a.name) : opts.addons;
    const addons = [];
    for (const a of installed) {
      if (!wanted.includes(a.name)) continue;
      copyFiles(path.join(flavorPath, 'Interface', 'AddOns', a.name), path.join(tmp, 'addons', a.name));
      addons.push({ ...a, enabled: enabled[a.name] !== false });
    }

    const parsed = parseSavedVariables(path.join(tmp, 'wtf', 'account', 'SavedVariables'), path.join(tmp, 'wtf', 'character', 'SavedVariables'), warnings);
    const detected = detectIdentity(parsed, first, last, realmFolder);

    const otherCharacters = wow.listCharacters(flavorPath, account)
      .filter((c) => !(c.realmFolder === realmFolder && c.charFolder === charFolder))
      .map((c) => ({ first: c.first, last: c.last, charFolder: c.charFolder, realmFolder: c.realmFolder }));
    // their GUIDs too, so data keyed by them can be left out on apply
    const accountOnly = parsed.filter((p) => !p.perCharacter);
    for (const o of otherCharacters) {
      const guid = detectIdentity(accountOnly, o.first, o.last, o.realmFolder).guid;
      if (guid && guid !== detected.guid) o.guid = guid;
    }

    const manifest = {
      format: FORMAT,
      id,
      name: opts.name || `${first} ${last}`.trim(),
      createdAt: createdAt.toISOString(),
      source: {
        flavorPath,
        flavor: path.basename(flavorPath),
        account,
        realmFolder,
        charFolder,
        identity: {
          first,
          last,
          ruleset: detected.ruleset,
          realmName: detected.realmName,
          faction: detected.faction,
          guid: detected.guid,
        },
      },
      detected,
      otherCharacters,
      addons,
      characterFiles,
      accountFiles,
      accountSavedVariables,
      clientConfig,
      warnings,
      size: 0,
    };
    manifest.size = dirSize(tmp);
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, root);
    return manifest;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function readManifest(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (!m || m.format > FORMAT) throw new Error('This snapshot was made by a newer version of Forever Profile Porter.');
  return m;
}

function listSnapshots(dataDir) {
  const out = [];
  for (const d of wow.dirs(snapshotsDir(dataDir))) {
    if (d.endsWith('.partial')) continue;
    try { out.push(readManifest(path.join(snapshotsDir(dataDir), d))); } catch { /* not a snapshot */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function snapshotDir(dataDir, id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad snapshot id');
  return path.join(snapshotsDir(dataDir), id);
}

function getSnapshot(dataDir, id) {
  return readManifest(snapshotDir(dataDir, id));
}

// Saves corrections to the snapshot's name or source identity.
function updateSnapshot(dataDir, id, changes) {
  const dir = snapshotDir(dataDir, id);
  const m = readManifest(dir);
  if (typeof changes.name === 'string' && changes.name.trim()) m.name = changes.name.trim();
  if (changes.identity) {
    for (const k of ['first', 'last', 'ruleset', 'realmName', 'faction', 'guid']) {
      if (typeof changes.identity[k] === 'string') m.source.identity[k] = changes.identity[k].trim();
    }
  }
  if (Array.isArray(changes.layouts)) m.layouts = cleanLayouts(changes.layouts);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return m;
}

// Edit Mode layouts live on Blizzard's servers, so the snapshot keeps the export strings
// pasted from the game, ready to paste into the new character's Edit Mode import.
function cleanLayouts(list) {
  return list
    .map((l) => ({ name: String(l.name || '').trim().slice(0, 64), text: String(l.text || '').trim().slice(0, 1024 * 1024) }))
    .filter((l) => l.text)
    .map((l, i) => ({ ...l, name: l.name || `Layout ${i + 1}` }));
}

function deleteSnapshot(dataDir, id) {
  fs.rmSync(snapshotDir(dataDir, id), { recursive: true, force: true });
}

function exportSnapshot(dataDir, id, zipPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(snapshotDir(dataDir, id), id);
  zip.writeZip(zipPath);
  return zipPath;
}

function importSnapshot(dataDir, zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const manifestEntry = entries.find((e) => /^[^/]+\/manifest\.json$/.test(e.entryName));
  if (!manifestEntry) throw new Error('This file is not a Forever Profile Porter snapshot.');
  const prefix = manifestEntry.entryName.split('/')[0];
  const m = JSON.parse(manifestEntry.getData().toString('utf8'));
  let id = /^[\w.-]+$/.test(m.id || '') ? m.id : slug(prefix);
  while (wow.isDir(snapshotDir(dataDir, id))) id += '-copy';
  const dest = snapshotDir(dataDir, id);
  for (const e of entries) {
    if (e.isDirectory || !e.entryName.startsWith(prefix + '/')) continue;
    const rel = e.entryName.slice(prefix.length + 1);
    const out = path.resolve(dest, rel);
    if (!out.startsWith(path.resolve(dest) + path.sep)) throw new Error('Unsafe path in snapshot file: ' + rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.getData());
  }
  const manifest = readManifest(dest);
  manifest.id = id;
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = {
  createSnapshot, listSnapshots, getSnapshot, updateSnapshot, deleteSnapshot, exportSnapshot, importSnapshot,
  snapshotDir, parseSavedVariables, parseLuaFile, copyFiles, dirSize, SKIP_FILE,
};
