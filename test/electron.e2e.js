'use strict';
// Starts the real Electron app against a fake install and runs a snapshot and an apply
// through the actual main process, preload and IPC.   xvfb-run node test/electron.e2e.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { _electron: electron } = require('playwright-core');
const { makeInstall } = require('./fixtures');

(async () => {
  const fx = makeInstall();
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, FPP_WOW_ROOTS: fx.wowRoot, FPP_DATA_DIR: fx.dataDir },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.waitForFunction(() => document.querySelector('#beta-facts').textContent.includes('Characters'));
    await page.click('[data-view=snapshot]');
    await page.click('.char:has-text("Alice")');
    await page.click('#snap-take');
    await page.waitForSelector('#snap-list .snap');
    await page.click('#snap-list [data-act=apply]');
    await page.fill('#ap-first', 'Carol');
    await page.fill('#ap-last', 'Hale');
    await page.waitForFunction(() => document.querySelector('#ap-found').textContent.includes('Found'));
    await page.click('#ap-preview');
    await page.waitForSelector('#ap-plan table');
    await page.click('#ap-run');
    await page.waitForSelector('#ap-plan .notice.ok');
    const ftf = fs.readFileSync(path.join(fx.live, 'WTF', 'Account', fx.account, 'SavedVariables', 'FirstToForever.lua'), 'latin1');
    assert.match(ftf, /\["Carol Hale"\] = "Carol Hale"/);
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'backups')));
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    assert.deepStrictEqual(errors, []);
    console.log('Electron e2e passed');
  } finally {
    await app.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
