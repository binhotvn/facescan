// Drives the built app against a running FaceScan hub and screenshots it.
//   KAPOK_E2E_URL=http://localhost:8001 KAPOK_E2E_TOKEN=... KAPOK_E2E_FOLDER=/photos \
//   [KAPOK_E2E_QUEUE_CMD="python upload.py ..."] node scripts/e2e.mjs
import { _electron as electron } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.env.KAPOK_E2E_OUT || os.tmpdir();
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapok-e2e-'));
const cfg = path.join(cfgDir, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({
  url: process.env.KAPOK_E2E_URL,
  token: process.env.KAPOK_E2E_TOKEN,
  folder: process.env.KAPOK_E2E_FOLDER,
  quality: 'high',
  watch: false,
  localFaces: true,
}));

const app = await electron.launch({
  // KAPOK_E2E_EXE: test a packaged build instead of the source tree
  ...(process.env.KAPOK_E2E_EXE ? { executablePath: process.env.KAPOK_E2E_EXE, args: [] } : { args: ['.'] }),
  // a fresh userData: the run downloads the models like a first launch does
  env: { ...process.env, KAPOK_UPLOADER_CONFIG: cfg, ELECTRON_USER_DATA: cfgDir },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await win.setViewportSize({ width: 1360, height: 900 });
const shot = (n) => win.screenshot({ path: path.join(out, `kapok-${n}.png`) });

await win.waitForSelector('.conn.is-on', { timeout: 20000 });
await win.waitForSelector('.device.is-downloading, .device.is-loading, .device.is-ready', { timeout: 60000 });
await shot('1-models');
await win.waitForSelector('.device.is-ready', { timeout: 180000 });
console.log('device:', await win.locator('.device strong').innerText());
await win.click('text=Bắt đầu tải lên');
await win.waitForSelector('.status:has-text("Hoàn tất")', { timeout: 120000 });
await win.waitForTimeout(500);
await shot('2-uploaded');
console.log('upload:', (await win.locator('.facestats').innerText()).replace(/\n/g, ' | '));

if (process.env.KAPOK_E2E_QUEUE_CMD) {
  execSync(process.env.KAPOK_E2E_QUEUE_CMD, { stdio: 'ignore' }); // photos the server must index
  await win.click('text=Làm node xử lý hàng chờ của máy chủ');
  await win.waitForFunction(() => /Node: 12 ảnh/.test(document.querySelector('.facestats')?.innerText || ''), null, { timeout: 120000 });
  await win.waitForTimeout(500);
  await shot('3-node');
  console.log('node:', (await win.locator('.facestats').innerText()).replace(/\n/g, ' | '));
}
await win.emulateMedia({ colorScheme: 'dark' });
await win.waitForTimeout(400);
await shot('4-dark');
console.log('errors:', errors);
await app.close();
