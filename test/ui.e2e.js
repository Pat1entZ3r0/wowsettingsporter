'use strict';
// Drives the whole UI in Chromium against a fake install: detect folders, take a snapshot,
// preview and apply it to a live character, then restore the backup.
//   node test/ui.e2e.js [screenshotDir]

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright-core');
const { start } = require('./ui-harness');

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  const shots = process.argv[2];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const harness = await start();
  const { server, fx, url, shim } = harness;
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.addInitScript(shim);
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true }); };

  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#beta-facts').textContent.includes('Characters'));
    assert.strictEqual(await page.inputValue('#beta-select'), fx.beta);
    assert.strictEqual(await page.inputValue('#live-select'), fx.live);
    await page.waitForFunction(() => document.querySelector('#live-facts').textContent.includes('Characters'));
    await shot('1-setup');

    await page.click('[data-view=snapshot]');
    await page.waitForSelector('.char');
    await page.click('.char:has-text("Alice")');
    assert.strictEqual(await page.inputValue('#snap-first'), 'Alice');
    assert.strictEqual(await page.inputValue('#snap-last'), 'Smith');
    await page.waitForFunction(() => document.querySelector('#snap-addon-count').textContent === '(2 of 3)');
    await page.click('#snap-addon-details summary');
    await page.click('#snap-addon-list [data-all="1"]');
    await page.fill('#snap-name', 'Alice final beta UI');
    await page.click('#snap-take');
    await page.waitForSelector('#snap-list .snap');
    const card = await page.textContent('#snap-list .snap');
    assert.match(card, /Alice final beta UI/);
    assert.match(card, /Normal/);
    assert.match(card, /Forever Beta/);
    assert.match(card, /Player-70-0A1B2C3D/);
    await shot('2-snapshot');

    // save an Edit Mode layout string with the snapshot
    await page.click('#snap-list .layout-add summary');
    await page.fill('#snap-list [data-layout-name]', 'Leveling');
    await page.fill('#snap-list [data-layout-text]', '0 35 0 0 0 4 4 UIParent 0.0 -1.0 -1 ## a');
    await page.click('#snap-list [data-layout-save]');
    await page.waitForSelector('#snap-list .layout-row:has-text("Leveling")');
    await shot('2b-layout');

    await page.click('#snap-list [data-act=apply]');
    await page.waitForSelector('#view-apply.active');
    await page.click('#ap-layouts [data-layout-copy="0"]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Copied'));
    assert.strictEqual(harness.env.clipboard, '0 35 0 0 0 4 4 UIParent 0.0 -1.0 -1 ## a');
    await page.fill('#ap-first', 'Carol');
    await page.fill('#ap-last', 'Hale');
    await page.selectOption('#ap-ruleset', 'PvP');
    await page.waitForFunction(() => document.querySelector('#ap-found').textContent.includes('Found Carol-Hale in realm folder 12'));
    await page.click('#ap-preview');
    await page.waitForSelector('#ap-plan table');
    const planText = await page.textContent('#ap-plan');
    assert.match(planText, /Alliance - PvE/);
    assert.match(planText, /Alliance - PvP/);
    assert.match(planText, /Carol Hale/);
    assert.ok(await page.isEnabled('#ap-run'));
    await shot('3-preview');

    await page.click('#ap-run');
    await page.waitForSelector('#ap-plan .notice.ok');
    assert.match(await page.textContent('#ap-plan'), /Last step: Edit Mode/);
    const ftf = fs.readFileSync(path.join(fx.live, 'WTF', 'Account', fx.account, 'SavedVariables', 'FirstToForever.lua'), 'latin1');
    assert.match(ftf, /\["Carol Hale"\] = "Carol Hale"/);
    assert.match(ftf, /\["Alliance - PvP"\]/);
    assert.doesNotMatch(ftf, /Bob Jones/);
    assert.ok(fs.existsSync(path.join(fx.live, 'Interface', 'AddOns', 'Bagthing')));
    await shot('4-applied');

    await page.click('[data-view=backups]');
    await page.waitForSelector('#backup-list .snap');
    await shot('5-backups');
    await page.click('#backup-list [data-act=restore]');
    await page.waitForSelector('#backup-list .pill.ok');
    assert.ok(!fs.existsSync(path.join(fx.live, 'Interface', 'AddOns', 'Bagthing')));

    // a name with no live folder yet: the plan explains what to do
    await page.click('[data-view=apply]');
    await page.fill('#ap-first', 'Nobody');
    await page.fill('#ap-last', 'Yet');
    await page.waitForFunction(() => document.querySelector('#ap-found').textContent.includes('Log in to the character once'));
    await page.click('#ap-preview');
    await page.waitForSelector('#ap-plan .notice.err');
    assert.ok(!(await page.isEnabled('#ap-run')));
    await shot('6-not-found');

    // apply to another beta character for testing, picked from the character chips
    await page.selectOption('#ap-target', fx.beta);
    await page.waitForSelector('#ap-chars .chip:has-text("Bob Jones")');
    await page.click('#ap-chars .chip:has-text("Bob Jones")');
    await page.waitForFunction(() => document.querySelector('#ap-found').textContent.includes('Found Bob-Jones in realm folder 70'));
    await page.click('#ap-preview');
    await page.waitForSelector('#ap-plan table');
    assert.match(await page.textContent('#ap-plan'), /autoLootDefault|lockActionBars|cameraDistanceMaxZoomFactor/);
    await shot('7-beta-preview');
    await page.click('#ap-run');
    await page.waitForSelector('#ap-plan .notice.ok');
    const bobMacros = fs.readFileSync(path.join(fx.beta, 'WTF', 'Account', fx.account, '70', 'Bob-Jones', 'macros-cache.txt'), 'utf8');
    assert.match(bobMacros, /\/tar Bob Jones/);

    assert.deepStrictEqual(errors, []);
    console.log('UI e2e passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
