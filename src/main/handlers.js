'use strict';
// Every call the UI can make, shared by the Electron main process and the browser test harness.
// `env` supplies what differs between them: { dataDir, version, pickFolder, saveFile, openFile, openPath }.

const fs = require('fs');
const path = require('path');
const wow = require('../core/wow');
const snapshots = require('../core/snapshot');
const apply = require('../core/apply');

function createHandlers(env) {
  const dataDir = () => env.dataDir;
  const settingsFile = () => path.join(dataDir(), 'settings.json');
  const readSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
  };
  const writeSettings = (s) => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
    return s;
  };
  const h = {};
  const handle = (channel, fn) => { h[channel] = fn; };

  handle('app:info', () => ({ version: env.version, dataDir: dataDir(), platform: process.platform }));
  handle('settings:get', () => readSettings());
  handle('settings:set', (patch) => writeSettings({ ...readSettings(), ...patch }));

  handle('installs:detect', async () => {
    const installs = await wow.detectInstalls();
    return { installs, suggested: wow.suggestFlavors(installs) };
  });
  handle('installs:flavorsAt', (p) => wow.flavorsAt(p));
  handle('dialog:pickFolder', (title, defaultPath) => env.pickFolder(title, defaultPath));
  handle('shell:openPath', (p) => env.openPath(p));
  handle('clipboard:write', (text) => env.writeClipboard(String(text)));

  handle('wow:accounts', (flavorPath) => wow.listAccounts(flavorPath));
  handle('wow:characters', (flavorPath, account) => wow.listCharacters(flavorPath, account));
  handle('wow:addons', (flavorPath) => wow.listAddons(flavorPath));
  handle('wow:addonsTxt', (flavorPath, account, realm, ch) => wow.readAddOnsTxt(path.join(wow.accountDir(flavorPath, account), realm, ch, 'AddOns.txt')));
  handle('wow:isRunning', () => wow.isWowRunning());

  handle('snap:create', (opts) => snapshots.createSnapshot({ ...opts, dataDir: dataDir() }));
  handle('snap:list', () => snapshots.listSnapshots(dataDir()));
  handle('snap:update', (id, changes) => snapshots.updateSnapshot(dataDir(), id, changes));
  handle('snap:delete', (id) => snapshots.deleteSnapshot(dataDir(), id));
  handle('snap:export', async (id) => {
    const m = snapshots.getSnapshot(dataDir(), id);
    const file = await env.saveFile('Export snapshot', `${m.name.replace(/[\\/:*?"<>|]+/g, '_')}.ffpsnap`);
    if (!file) return null;
    return snapshots.exportSnapshot(dataDir(), id, file);
  });
  handle('snap:import', async () => {
    const file = await env.openFile('Import snapshot');
    if (!file) return null;
    return snapshots.importSnapshot(dataDir(), file);
  });
  handle('snap:openFolder', (id) => env.openPath(snapshots.snapshotDir(dataDir(), id)));

  handle('target:inspect', (opts) => {
    const manifest = opts.snapshotId ? snapshots.getSnapshot(dataDir(), opts.snapshotId) : null;
    return apply.inspectTarget({ ...opts, manifest });
  });
  handle('apply:defaults', () => apply.DEFAULT_OPTIONS);
  handle('apply:plan', (opts) => apply.summarizePlan(apply.planApply({ ...opts, dataDir: dataDir() })));
  handle('apply:run', async (opts) => {
    if (!opts.ignoreRunning && (await wow.isWowRunning())) {
      throw new Error('World of Warcraft is running. Exit the game first: it rewrites these files when you log out, which would undo the changes.');
    }
    const plan = apply.planApply({ ...opts, dataDir: dataDir() });
    if (!plan.ok) throw new Error(plan.errors.join(' '));
    return apply.executePlan(dataDir(), plan);
  });

  handle('backups:list', () => apply.listBackups(dataDir()));
  handle('backups:restore', async (id) => {
    if (await wow.isWowRunning()) throw new Error('Exit World of Warcraft before restoring a backup.');
    return apply.restoreBackup(dataDir(), id);
  });
  handle('backups:delete', (id) => apply.deleteBackup(dataDir(), id));
  handle('backups:openFolder', (id) => env.openPath(path.join(dataDir(), 'backups', id)));

  return h;
}

module.exports = { createHandlers };
