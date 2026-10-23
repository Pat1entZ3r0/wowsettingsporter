'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const lua = require('../src/core/lua');
const id = require('../src/core/identity');
const wow = require('../src/core/wow');
const snapshots = require('../src/core/snapshot');
const apply = require('../src/core/apply');
const { makeInstall, BETA_SV, ACCOUNT } = require('./fixtures');

const LUA = (() => {
  for (const bin of ['lua5.1', 'luajit', 'lua']) {
    try { execFileSync(bin, ['-v'], { stdio: 'ignore' }); return bin; } catch { /* next */ }
  }
  return null;
})();

// The file's globals as the game's Lua 5.1 sees them.
function luaDump(file) {
  return execFileSync(LUA, [path.join(__dirname, 'dump.lua'), file]).toString('latin1');
}
function tmpFile(content) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fpp-lua-')), 'x.lua');
  fs.writeFileSync(f, Buffer.from(content, 'latin1'));
  return f;
}
function readLua(file) {
  return lua.toJS(lua.parse(fs.readFileSync(file).toString('latin1')).assignments[0].value);
}
function u(s) { return Buffer.from(s, 'latin1').toString('utf8'); }

test('round trip keeps every value, checked with real Lua', { skip: !LUA && 'no Lua interpreter' }, () => {
  for (const [name, src] of Object.entries(BETA_SV)) {
    const original = tmpFile(Buffer.from(src, 'utf8').toString('latin1'));
    const out = tmpFile(lua.serialize(lua.parse(fs.readFileSync(original).toString('latin1'))));
    assert.strictEqual(luaDump(out), luaDump(original), name);
  }
});

test('binary-safe strings survive a round trip', { skip: !LUA && 'no Lua interpreter' }, () => {
  let s = '';
  for (let i = 0; i < 256; i++) s += String.fromCharCode(i);
  const src = `X = {\n["k"] = ${lua.quote(s)},\n[${lua.quote(s)}] = 1,\n}\n`;
  const f = tmpFile(src);
  const out = tmpFile(lua.serialize(lua.parse(src)));
  assert.strictEqual(luaDump(out), luaDump(f));
  assert.strictEqual(lua.toJS(lua.parse(src).assignments[0].value).k, s);
});

test('parser handles WoW output shapes', () => {
  const f = lua.parse('\nA = {\n\t"x", -- [1]\n\t{\n\t}, -- [2]\n\t["n"] = -1.5,\n}\nB = nil\nC = "s"\n');
  assert.deepStrictEqual(lua.toJS(f.assignments[0].value), { 1: 'x', 2: {}, n: -1.5 });
  assert.strictEqual(f.assignments[1].value.type, 'nil');
  assert.throws(() => lua.parse('A = { ["x"] = }'), lua.LuaParseError);
});

test('merge keeps base keys, takes incoming values, replaces lists', () => {
  const base = lua.parse('A = { keep = 1, both = { x = 1, y = 2 }, list = { "a", "b", "c" } }');
  const inc = lua.parse('A = { both = { y = 3, z = 4 }, list = { "d" }, new = true }');
  assert.deepStrictEqual(lua.toJS(lua.mergeFiles(base, inc).assignments[0].value), {
    keep: 1, both: { x: 1, y: 3, z: 4 }, list: { 1: 'd' }, new: true,
  });
});

test('rewrite rules respect word boundaries and key types', () => {
  const rules = id.compileRules(id.buildRules(
    { first: 'Alice', last: 'Smith', ruleset: 'PvE', realmName: '70', faction: 'Alliance', guid: '' },
    { first: 'Carol', last: 'Hale', ruleset: 'PvP', realmName: '12', faction: '', guid: '' },
  ));
  const r = (s, isKey, parent) => id.rewriteString(s, rules, null, isKey, parent);
  assert.strictEqual(r('Alice Smith'), 'Carol Hale');
  assert.strictEqual(r('Alice Smithers'), 'Alice Smithers');
  assert.strictEqual(r('Zed Alicesmith'), 'Zed Alicesmith');
  assert.strictEqual(r('Alice - 70'), 'Carol - 12');
  assert.strictEqual(r('Alice - 701'), 'Alice - 701');
  assert.strictEqual(r('Alliance - PvE - US'), 'Alliance - PvP - US');
  assert.strictEqual(r('70'), '70', 'numeric realm never replaced alone');
  assert.strictEqual(r('PvE', true, 'realm'), 'PvP');
  assert.strictEqual(r('PvE', true, 'modes'), 'PvE');
  assert.strictEqual(r('PvE', false), 'PvE');
  assert.strictEqual(r('Alice'), 'Carol');
  assert.strictEqual(r('Alicea'), 'Alicea');
});

test('accented names match byte for byte', () => {
  const rules = id.compileRules(id.buildRules({ first: 'Zoë', last: 'Brûlé' }, { first: 'Ãna', last: 'Ñu' }));
  const s = Buffer.from('Zoë Brûlé!', 'utf8').toString('latin1');
  assert.strictEqual(u(id.rewriteString(s, rules, null)), 'Ãna Ñu!');
});

test('folder names follow the source pattern', () => {
  assert.strictEqual(id.folderNameFor('Alice-Smith', { first: 'Alice', last: 'Smith' }, { first: 'Carol', last: 'Hale' }), 'Carol-Hale');
  assert.strictEqual(id.folderNameFor('Alice Smith', { first: 'Alice', last: 'Smith' }, { first: 'Carol', last: 'Hale' }), 'Carol Hale');
  assert.strictEqual(id.folderNameFor('AliceSmith', { first: 'Alice', last: 'Smith' }, { first: 'Carol', last: 'Hale' }), 'CarolHale');
  assert.deepStrictEqual(id.splitFolderName('Alice-Smith'), { first: 'Alice', last: 'Smith' });
});

test('finds installs, flavors, characters and addons', async () => {
  const fx = makeInstall();
  process.env.FPP_WOW_ROOTS = fx.wowRoot;
  const installs = await wow.detectInstalls();
  const found = installs.find((i) => i.root === fx.wowRoot);
  assert.ok(found);
  assert.deepStrictEqual(found.flavors.map((f) => f.name).sort(), ['_classic_beta_', '_forever_']);
  assert.deepStrictEqual(wow.suggestFlavors([found]), { beta: fx.beta, live: fx.live });
  assert.deepStrictEqual(wow.flavorsAt(fx.beta).map((f) => f.name), ['_classic_beta_']);
  const chars = wow.listCharacters(fx.beta, ACCOUNT).map((c) => c.charFolder).sort();
  assert.deepStrictEqual(chars, ['Alice-Smith', 'Bob-Jones']);
  const addons = wow.listAddons(fx.beta);
  assert.deepStrictEqual(addons.map((a) => a.title), ['Bagthing', 'Details! Damage Meter', 'First to Forever']);
});

function snapshotAlice(fx) {
  return snapshots.createSnapshot({
    dataDir: fx.dataDir, flavorPath: fx.beta, account: ACCOUNT, realmFolder: '70', charFolder: 'Alice-Smith', name: 'Alice main',
  });
}

test('snapshot detects how the character appears in addon data', () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  assert.strictEqual(m.source.identity.first, 'Alice');
  assert.strictEqual(m.source.identity.last, 'Smith');
  assert.strictEqual(m.source.identity.ruleset, 'PvE');
  assert.strictEqual(m.source.identity.realmName, 'Forever Beta');
  assert.strictEqual(m.source.identity.faction, 'Alliance');
  assert.strictEqual(m.source.identity.guid, 'Player-70-0A1B2C3D');
  assert.deepStrictEqual(m.otherCharacters.map((c) => c.charFolder), ['Bob-Jones']);
  assert.deepStrictEqual(m.accountSavedVariables.sort(), ['Bagthing.lua', 'Details.lua', 'FirstToForever.lua']);
  assert.ok(!m.accountFiles.includes('cache.md5'));
  assert.deepStrictEqual(m.addons.map((a) => [a.name, a.enabled]).sort(), [['Bagthing', false], ['Details', true], ['FirstToForever', true]]);
  assert.strictEqual(snapshots.listSnapshots(fx.dataDir).length, 1);
});

test('inspectTarget finds the live character and its GUID', () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  const t = apply.inspectTarget({ flavorPath: fx.live, account: ACCOUNT, first: 'Carol', last: 'Hale', manifest: m });
  assert.strictEqual(t.found.realmFolder, '12');
  assert.strictEqual(t.found.charFolder, 'Carol-Hale');
  assert.strictEqual(t.detected.guid, 'Player-12-0F0F0F0F');
});

function applyCarol(fx, m, options) {
  return apply.planApply({
    dataDir: fx.dataDir,
    snapshotId: m.id,
    target: {
      flavorPath: fx.live, account: ACCOUNT, realmFolder: '', charFolder: '',
      identity: { first: 'Carol', last: 'Hale', ruleset: 'PvP', realmName: 'Forever', faction: '', guid: 'Player-12-0F0F0F0F' },
    },
    options,
  });
}

test('apply rewrites, merges, backs up and restores', { skip: !LUA && 'no Lua interpreter' }, () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  const liveSv = path.join(fx.live, 'WTF', 'Account', ACCOUNT, 'SavedVariables');
  const before = fs.readFileSync(path.join(liveSv, 'FirstToForever.lua'));
  const plan = applyCarol(fx, m, {});
  assert.ok(plan.ok, plan.errors.join());
  assert.strictEqual(plan.target.realmFolder, '12');
  assert.strictEqual(plan.target.charFolder, 'Carol-Hale');
  const backup = apply.executePlan(fx.dataDir, plan);

  // every written Lua file loads in real Lua
  const charDir = path.join(fx.live, 'WTF', 'Account', ACCOUNT, '12', 'Carol-Hale');
  for (const f of [...fs.readdirSync(liveSv).map((f) => path.join(liveSv, f)), path.join(charDir, 'SavedVariables', 'FirstToForever.lua')]) {
    luaDump(f);
  }

  const ftf = readLua(path.join(liveSv, 'FirstToForever.lua'));
  assert.deepStrictEqual(ftf.profileKeys, { 'Carol Hale': 'Carol Hale', 'Dan Fox': 'Dan Fox' }, 'Bob dropped, Dan kept, Carol mapped');
  assert.strictEqual(ftf.profiles['Carol Hale'].announcer.volume, 0.75);
  assert.strictEqual(ftf.profiles['Carol Hale'].greeting, 'Hello from Carol Hale, not Alice Smithers');
  assert.strictEqual(ftf.profiles['Dan Fox'].announcer.volume, 0.1);
  assert.ok(!ftf.profiles['Alice Smith']);
  assert.deepStrictEqual(Object.keys(ftf.char).sort(), ['Carol Hale']);
  assert.strictEqual(ftf.char['Carol Hale'].guid, 'Player-12-0F0F0F0F', 'live data kept by the merge');
  assert.strictEqual(ftf.char['Carol Hale'].minimap.minimapPos, 212.5);
  assert.ok(ftf.factionrealm['Alliance - PvP']);
  assert.strictEqual(ftf.factionrealm['Alliance - PvP'].leaderboard[1].players[1].name, 'Carol Hale');
  assert.strictEqual(ftf.factionrealm['Alliance - PvP'].leaderboard[1].players[2].name, 'Zed Alicesmith');
  assert.ok(ftf.factionrealmregion['Alliance - PvP - US']);
  assert.deepStrictEqual(Object.keys(ftf.realm), ['PvP']);
  assert.strictEqual(ftf.realm.PvP.note, 'PvE stays PvE inside values');

  const det = lua.parse(fs.readFileSync(path.join(liveSv, 'Details.lua')).toString('latin1'));
  const detDb = lua.toJS(det.assignments.find((a) => a.name === 'DetailsDB').value);
  assert.deepStrictEqual(detDb.profileKeys, { 'Carol - Forever': 'Carol - Forever' });
  assert.deepStrictEqual(Object.keys(detDb.realm), ['Forever']);

  const bag = readLua(path.join(liveSv, 'Bagthing.lua'));
  assert.deepStrictEqual(Object.keys(bag.Forever), ['Carol Hale']);
  assert.strictEqual(bag.Forever['Carol Hale'].guid, 'Player-12-0F0F0F0F');
  assert.deepStrictEqual(bag.guids, { 'Player-12-0F0F0F0F': 'Carol Hale' });
  assert.strictEqual(u(bag.escapes), 'tab\there "quoted" back\\slash — nl\ndone');

  const charSv = readLua(path.join(charDir, 'SavedVariables', 'FirstToForever.lua'));
  assert.deepStrictEqual(charSv, { me: 'Carol Hale', first: 'Carol', guid: 'Player-12-0F0F0F0F' });
  assert.match(fs.readFileSync(path.join(charDir, 'macros-cache.txt'), 'utf8'), /\/tar Carol Hale/);
  assert.match(fs.readFileSync(path.join(fx.live, 'WTF', 'Account', ACCOUNT, 'macros-cache.txt'), 'utf8'), /I am Carol Hale/);
  assert.strictEqual(fs.readFileSync(path.join(charDir, 'AddOns.txt'), 'utf8'), 'FirstToForever: enabled\nDetails: enabled\nBagthing: disabled\n');

  const cfg = fs.readFileSync(path.join(fx.live, 'WTF', 'Config.wtf'), 'utf8');
  assert.match(cfg, /SET synchronizeSettings "0"/);
  assert.match(cfg, /SET checkAddonVersion "0"/);
  assert.match(cfg, /SET accountName "LIVE"/);
  assert.match(cfg, /SET cameraDistanceMaxZoomFactor "2.6"/, 'client config on by default');
  assert.doesNotMatch(cfg, /SET portal "test"/, 'install values never copied');

  // option caches merge setting by setting
  const acctCfg = fs.readFileSync(path.join(fx.live, 'WTF', 'Account', ACCOUNT, 'config-cache.wtf'), 'utf8');
  assert.match(acctCfg, /SET autoLootDefault "1"/);
  assert.match(acctCfg, /SET interactOnLeftClick "0"/);
  assert.match(acctCfg, /SET liveOnly "7"/);
  const charCfg = fs.readFileSync(path.join(charDir, 'config-cache.wtf'), 'utf8');
  assert.match(charCfg, /SET lockActionBars "1"/);
  assert.match(charCfg, /SET showTargetOfTarget "1"/);
  const cfgAction = plan.actions.find((a) => a.rel.endsWith(path.join('Carol-Hale', 'config-cache.wtf')));
  assert.strictEqual(cfgAction.mode, 'merge');
  assert.deepStrictEqual(cfgAction.changes, ['lockActionBars: "0" → "1"']);

  // addons: missing ones installed, the newer live FirstToForever kept
  assert.strictEqual(fs.readFileSync(path.join(fx.live, 'Interface', 'AddOns', 'FirstToForever', 'main.lua'), 'utf8'), '-- live 2.4.0');
  assert.strictEqual(fs.readFileSync(path.join(fx.live, 'Interface', 'AddOns', 'Details', 'main.lua'), 'utf8'), '-- Details beta');

  // restore puts the live install back exactly
  assert.strictEqual(apply.listBackups(fx.dataDir).length, 1);
  apply.restoreBackup(fx.dataDir, backup.id);
  assert.deepStrictEqual(fs.readFileSync(path.join(liveSv, 'FirstToForever.lua')), before);
  assert.ok(!fs.existsSync(path.join(liveSv, 'Details.lua')));
  assert.ok(!fs.existsSync(path.join(fx.live, 'Interface', 'AddOns', 'Details')));
  assert.deepStrictEqual(fs.readdirSync(charDir).sort(), ['AddOns.txt', 'config-cache.wtf']);
  assert.strictEqual(fs.readFileSync(path.join(charDir, 'config-cache.wtf'), 'utf8'), 'SET lockActionBars "0"\r\nSET showTargetOfTarget "1"\r\n');
  assert.strictEqual(fs.readFileSync(path.join(charDir, 'AddOns.txt'), 'utf8'), 'FirstToForever: enabled\n');
  assert.doesNotMatch(fs.readFileSync(path.join(fx.live, 'WTF', 'Config.wtf'), 'utf8'), /checkAddonVersion/);
});

test('replace mode, overwrite addons, client config and a brand-new character folder', () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  const plan = apply.planApply({
    dataDir: fx.dataDir,
    snapshotId: m.id,
    target: { flavorPath: fx.live, account: ACCOUNT, realmFolder: '12', identity: { first: 'Erin', last: 'Vale', ruleset: 'PvE' } },
    options: { accountSavedVariables: 'replace', addons: 'overwrite', clientConfig: true, disableServerSync: false },
  });
  assert.ok(plan.ok, plan.errors.join());
  assert.ok(plan.warnings.some((w) => /will be created/.test(w)));
  apply.executePlan(fx.dataDir, plan);
  const liveSv = path.join(fx.live, 'WTF', 'Account', ACCOUNT, 'SavedVariables');
  const ftf = readLua(path.join(liveSv, 'FirstToForever.lua'));
  assert.deepStrictEqual(ftf.profileKeys, { 'Erin Vale': 'Erin Vale' }, 'replace drops live-only entries');
  assert.ok(ftf.realm.PvE);
  assert.ok(fs.existsSync(path.join(fx.live, 'WTF', 'Account', ACCOUNT, '12', 'Erin-Vale', 'SavedVariables', 'FirstToForever.lua')));
  assert.strictEqual(fs.readFileSync(path.join(fx.live, 'Interface', 'AddOns', 'FirstToForever', 'main.lua'), 'utf8'), '-- FirstToForever beta');
  const cfg = fs.readFileSync(path.join(fx.live, 'WTF', 'Config.wtf'), 'utf8');
  assert.match(cfg, /SET Sound_MasterVolume "0.4"/);
  assert.match(cfg, /SET accountName "LIVE"/, 'login values never copied');
  assert.match(cfg, /SET synchronizeSettings "1"/, 'sync left alone when the option is off');
});

test('plan refuses unknown realm folder and unsafe names', () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  const p1 = apply.planApply({ dataDir: fx.dataDir, snapshotId: m.id, target: { flavorPath: fx.live, account: ACCOUNT, identity: { first: 'Nobody', last: 'Here' } } });
  assert.ok(!p1.ok);
  assert.match(p1.errors[0], /realm folder/);
  const p2 = apply.planApply({ dataDir: fx.dataDir, snapshotId: m.id, target: { flavorPath: fx.live, account: ACCOUNT, realmFolder: '12', identity: { first: '..\\x', last: '' } } });
  assert.ok(!p2.ok);
});

test('export and import a snapshot', () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  const zip = path.join(fx.root, 'alice.ffpsnap');
  snapshots.updateSnapshot(fx.dataDir, m.id, { layouts: [{ name: ' Leveling ', text: ' 0 35 0 ## x ' }, { name: 'empty', text: '  ' }, { text: 'abc' }] });
  assert.deepStrictEqual(snapshots.getSnapshot(fx.dataDir, m.id).layouts, [{ name: 'Leveling', text: '0 35 0 ## x' }, { name: 'Layout 2', text: 'abc' }]);
  snapshots.exportSnapshot(fx.dataDir, m.id, zip);
  const other = path.join(fx.root, 'data2');
  const imported = snapshots.importSnapshot(other, zip);
  assert.strictEqual(imported.name, 'Alice main');
  assert.strictEqual(imported.layouts.length, 2, 'layouts travel with an exported snapshot');
  assert.deepStrictEqual(snapshots.listSnapshots(other).map((s) => s.id), [m.id]);
  const again = snapshots.importSnapshot(other, zip);
  assert.notStrictEqual(again.id, m.id);
});

test('a snapshot applies to another beta character for testing', () => {
  const fx = makeInstall();
  const m = snapshotAlice(fx);
  const plan = apply.planApply({
    dataDir: fx.dataDir,
    snapshotId: m.id,
    target: { flavorPath: fx.beta, account: ACCOUNT, identity: { first: 'Bob', last: 'Jones', ruleset: 'PvE', realmName: 'Forever Beta' } },
  });
  assert.ok(plan.ok, plan.errors.join());
  assert.strictEqual(plan.target.realmFolder, '70');
  assert.strictEqual(plan.target.charFolder, 'Bob-Jones');
  assert.ok(plan.actions.filter((a) => a.op === 'addon').every((a) => a.mode === 'keep'), 'beta addons already there');
  apply.executePlan(fx.dataDir, plan);
  const sv = path.join(fx.beta, 'WTF', 'Account', ACCOUNT, 'SavedVariables');
  const ftf = readLua(path.join(sv, 'FirstToForever.lua'));
  // Alice's profile now also drives Bob; Alice's own entries stay in the merged file
  assert.strictEqual(ftf.profileKeys['Bob Jones'], 'Bob Jones');
  assert.strictEqual(ftf.profiles['Bob Jones'].announcer.volume, 0.75);
  assert.strictEqual(ftf.char['Bob Jones'].minimap.minimapPos, 212.5);
  assert.strictEqual(ftf.profileKeys['Alice Smith'], 'Alice Smith');
  const det = lua.toJS(lua.parse(fs.readFileSync(path.join(sv, 'Details.lua')).toString('latin1')).assignments.find((a) => a.name === 'DetailsDB').value);
  assert.strictEqual(det.profileKeys['Bob - Forever Beta'], 'Bob - Forever Beta');
  assert.strictEqual(det.profiles['Bob - Forever Beta'].row_height, 16);
  const bag = readLua(path.join(sv, 'Bagthing.lua'));
  assert.strictEqual(bag['Forever Beta']['Bob Jones'].gold, 12345);
  assert.strictEqual(bag['Forever Beta']['Bob Jones'].guid, 'Player-70-0D0D0D0D', 'Bob keeps his own GUID');
  const bobDir = path.join(fx.beta, 'WTF', 'Account', ACCOUNT, '70', 'Bob-Jones');
  assert.match(fs.readFileSync(path.join(bobDir, 'macros-cache.txt'), 'utf8'), /\/tar Bob Jones/);
  assert.match(fs.readFileSync(path.join(bobDir, 'config-cache.wtf'), 'utf8'), /lockActionBars "1"/);
});
