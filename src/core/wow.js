'use strict';
// Finding WoW installs and reading what's in them: game flavors (_classic_beta_, ...),
// WTF accounts, realm and character folders, and installed addons.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { splitFolderName } = require('./identity');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function dirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

// A game flavor folder holds the client for one game version: WTF, Interface, Wow*.exe.
function looksLikeFlavor(p) {
  if (isDir(path.join(p, 'WTF')) || isDir(path.join(p, 'Interface'))) return true;
  try {
    return fs.readdirSync(p).some((f) => /^wow.*\.exe$/i.test(f));
  } catch { return false; }
}

function flavorRole(name) {
  const n = name.toLowerCase();
  if (/beta|ptr|test|alpha/.test(n)) return 'beta';
  if (/forever/.test(n)) return 'live';
  return 'other';
}

function flavorLabel(name) {
  const known = {
    _classic_beta_: 'Classic beta (WoW Forever Beta)',
    _forever_: 'WoW Forever',
    _forever_beta_: 'WoW Forever Beta',
    _classic_era_: 'Classic Era',
    _classic_: 'Classic',
    _retail_: 'Retail',
    _ptr_: 'Retail PTR',
    _classic_ptr_: 'Classic PTR',
    _classic_era_ptr_: 'Classic Era PTR',
    _beta_: 'Retail beta',
  };
  return known[name] || name.replace(/^_|_$/g, '').replace(/_/g, ' ');
}

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

// WoW install roots worth looking at: the registry's InstallPath, Battle.net's usual places
// on every drive, and FPP_WOW_ROOTS (path-separated) for testing.
async function candidateRoots() {
  const roots = [];
  if (process.env.FPP_WOW_ROOTS) roots.push(...process.env.FPP_WOW_ROOTS.split(path.delimiter).filter(Boolean));
  if (process.platform === 'win32') {
    for (const key of [
      'HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft',
      'HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft',
    ]) {
      for (const v of ['InstallPath', 'GamePath', 'InstallLocation']) {
        const p = await regQuery(key, v);
        if (p) roots.push(p);
      }
    }
    for (const drive of 'CDEFGHIJ') {
      for (const rel of [
        'Program Files (x86)\\World of Warcraft',
        'Program Files\\World of Warcraft',
        'World of Warcraft',
        'Games\\World of Warcraft',
        'Battle.net\\World of Warcraft',
        'Blizzard\\World of Warcraft',
        'Program Files (x86)\\Battle.net\\World of Warcraft',
      ]) roots.push(`${drive}:\\${rel}`);
    }
  } else {
    const home = os.homedir();
    roots.push(
      path.join(home, 'Games', 'World of Warcraft'),
      path.join(home, '.wine', 'drive_c', 'Program Files (x86)', 'World of Warcraft'),
      '/Applications/World of Warcraft',
    );
  }
  // InstallPath often points into a flavor folder: use its parent
  const out = [];
  for (let r of roots) {
    r = r.replace(/[\\/]+$/, '');
    if (/^_.+_$/.test(path.basename(r))) r = path.dirname(r);
    if (!out.some((o) => o.toLowerCase() === r.toLowerCase())) out.push(r);
  }
  return out;
}

function flavorInfo(p) {
  const name = path.basename(p);
  return {
    name,
    path: p,
    label: flavorLabel(name),
    role: flavorRole(name),
    hasWTF: isDir(path.join(p, 'WTF')),
    accounts: listAccounts(p),
    addonCount: dirs(path.join(p, 'Interface', 'AddOns')).filter((d) => !d.startsWith('Blizzard_')).length,
  };
}

// Flavors at a path the user picked: the path itself, or the flavor folders inside a root.
function flavorsAt(p) {
  if (!p || !isDir(p)) return [];
  const inside = dirs(p).filter((d) => /^_.+_$/.test(d)).map((d) => path.join(p, d)).filter(looksLikeFlavor);
  if (inside.length) return inside.map(flavorInfo);
  if (looksLikeFlavor(p)) return [flavorInfo(p)];
  return [];
}

async function detectInstalls() {
  const found = [];
  for (const root of await candidateRoots()) {
    if (!isDir(root)) continue;
    const flavors = flavorsAt(root);
    if (flavors.length) found.push({ root, flavors });
  }
  return found;
}

// Picks the likely beta and live flavors among detected installs.
function suggestFlavors(installs) {
  const all = installs.flatMap((i) => i.flavors);
  const withChars = (f) => f.accounts.length > 0;
  const beta = all.find((f) => f.name === '_classic_beta_' && withChars(f))
    || all.find((f) => f.role === 'beta' && /forever/i.test(f.name))
    || all.find((f) => f.name === '_classic_beta_')
    || all.find((f) => f.role === 'beta' && withChars(f))
    || null;
  const live = all.find((f) => f.role === 'live')
    || all.find((f) => f.name === '_classic_era_')
    || all.find((f) => f !== beta && f.role !== 'beta' && f.name !== '_retail_')
    || null;
  return { beta: beta ? beta.path : '', live: live ? live.path : '' };
}

function listAccounts(flavorPath) {
  return dirs(path.join(flavorPath, 'WTF', 'Account')).filter((d) => d !== 'SavedVariables');
}

function accountDir(flavorPath, account) {
  return path.join(flavorPath, 'WTF', 'Account', account);
}

function listRealms(flavorPath, account) {
  return dirs(accountDir(flavorPath, account)).filter((d) => d !== 'SavedVariables');
}

function listCharacters(flavorPath, account) {
  const out = [];
  for (const realm of listRealms(flavorPath, account)) {
    for (const ch of dirs(path.join(accountDir(flavorPath, account), realm))) {
      if (ch === 'SavedVariables') continue;
      const dir = path.join(accountDir(flavorPath, account), realm, ch);
      const { first, last } = splitFolderName(ch);
      let modified = 0;
      try {
        for (const f of fs.readdirSync(dir)) modified = Math.max(modified, fs.statSync(path.join(dir, f)).mtimeMs);
        const sv = path.join(dir, 'SavedVariables');
        if (isDir(sv)) for (const f of fs.readdirSync(sv)) modified = Math.max(modified, fs.statSync(path.join(sv, f)).mtimeMs);
      } catch { /* unreadable folder: listed without a date */ }
      out.push({ realmFolder: realm, charFolder: ch, first, last, modified, savedVariables: isDir(path.join(dir, 'SavedVariables')) });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

// Finds a character's folder among the realm folders of an account, case-insensitively.
function findCharacter(flavorPath, account, folderNames) {
  const want = folderNames.map((n) => n.toLowerCase());
  for (const c of listCharacters(flavorPath, account)) {
    if (want.includes(c.charFolder.toLowerCase())) return c;
  }
  return null;
}

function stripColors(s) {
  return s.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '').replace(/\|T[^|]*\|t/g, '').trim();
}

function readToc(addonDir, name) {
  let files;
  try { files = fs.readdirSync(addonDir); } catch { return null; }
  const tocs = files.filter((f) => f.toLowerCase().endsWith('.toc'));
  if (!tocs.length) return null;
  // prefer Name.toc, then a flavor-suffixed one (Name-Classic.toc, Name_Vanilla.toc)
  const toc = tocs.find((t) => t.toLowerCase() === `${name.toLowerCase()}.toc`) || tocs[0];
  const meta = {};
  try {
    for (const line of fs.readFileSync(path.join(addonDir, toc), 'utf8').split(/\r?\n/)) {
      const m = /^##\s*([^:]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
    }
  } catch { /* unreadable toc: name only */ }
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    name,
    title: stripColors(meta.title || name),
    version: meta.version || '',
    interface: meta.interface || '',
    savedVariables: list(meta.savedvariables),
    savedVariablesPerCharacter: list(meta.savedvariablespercharacter),
    dependencies: list(meta.dependencies || meta.requireddeps || meta.dep),
  };
}

function listAddons(flavorPath) {
  const base = path.join(flavorPath, 'Interface', 'AddOns');
  return dirs(base)
    .filter((d) => !d.startsWith('Blizzard_'))
    .map((d) => readToc(path.join(base, d), d) || { name: d, title: d, version: '', interface: '', savedVariables: [], savedVariablesPerCharacter: [], dependencies: [], noToc: true })
    .sort((a, b) => a.title.localeCompare(b.title));
}

// AddOns.txt: "Name: enabled" per line.
function readAddOnsTxt(file) {
  const map = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([^:]+):\s*(enabled|disabled)/i.exec(line.trim());
      if (m) map[m[1].trim()] = m[2].toLowerCase() === 'enabled';
    }
  } catch { /* none yet */ }
  return map;
}

function isWowRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.split(/\r?\n/).some((l) => /^"wow[^"]*\.exe"/i.test(l)));
    });
  });
}

module.exports = {
  isDir, isFile, dirs, looksLikeFlavor, flavorsAt, detectInstalls, suggestFlavors, candidateRoots,
  listAccounts, accountDir, listRealms, listCharacters, findCharacter, listAddons, readToc, readAddOnsTxt, isWowRunning,
};
