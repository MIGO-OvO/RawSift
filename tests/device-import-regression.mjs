import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.TEST_URL || 'http://127.0.0.1:5173';
const card = { id: 'card-1', name: 'Sony α6700', root: 'E:\\DCIM', transport: 'msc' };
const second = { id: 'card-2', name: 'Second card', root: 'G:\\DCIM', transport: 'msc' };
const saved = { sessionId: '00000000-0000-4000-8000-000000000001', sourceRoot: '\\\\?\\E:\\DCIM\\100MSDCF', recursive: true, activeDate: '2026-09-14', currentCaptureId: 'capture-1', destinationRoot: 'F:\\Photos', shootName: '', importMode: 'raw', showInfo: false, showHistogram: false, autoAdvance: false, reviews: { 'capture-1': 'keep' }, transfers: {} };
async function setup(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ options }) => {
    window.isTauri = true;
    window.testState = { devices: [], calls: [], unavailable: false, answer: '继续审片', commitError: false, ...options };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const state = window.testState;
      state.calls.push({ command, args });
      if (command === 'load_last_session') return state.saved || null;
      if (command === 'discover_photo_devices') return { devices: structuredClone(state.devices), warning: null };
      if (command === 'scan_local_source') {
        if (state.unavailable) throw '来源已断开';
        return { sourceName: 'Sony fixture', sourceRoot: args.root, scannedFiles: 1, unsupportedFiles: 0,
          dateGroups: [{ dateKey: '2026-09-14', captureCount: 1, pairedCount: 0, totalBytes: 100 }],
          captures: [{ id: 'capture-1', stem: 'DSC00001', capturedAt: '2026-09-14T12:00:00+08:00', dateKey: '2026-09-14', previewPath: null, jpeg: null,
            raw: { id: 'raw-1', kind: 'raw', name: 'DSC00001.ARW', path: `${args.root}\\DSC00001.ARW`, sizeBytes: 100 }, orientationDegrees: 0, orientationMirrored: false, exif: null }] };
      }
      if (command === 'stage_capture') return [];
      if (command === 'plugin:dialog|message') {
        await new Promise(resolve => setTimeout(resolve, 150));
        return state.answer;
      }
      if (command === 'commit_session') {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (state.commitError) throw '目标设备不可用';
        return { files: [{ destination: 'F:\\Photos\\DSC00001.ARW' }], persistenceWarning: null };
      }
      return null;
    } };
  }, { options });
  await page.goto(url);
  return { page, errors };
}
const count = (page, command) => page.evaluate(command => window.testState.calls.filter(call => call.command === command).length, command);
try {
  const hotplug = await setup();
  await hotplug.page.getByText('正在等待相机或存储卡连接…').waitFor();
  await hotplug.page.evaluate(card => { window.testState.devices = [card]; }, card);
  await hotplug.page.locator('.source-control').waitFor();
  assert.equal(await count(hotplug.page, 'scan_local_source'), 1, 'Hotplug auto-opens once');
  await hotplug.page.evaluate(second => { window.testState.devices.push(second); }, second);
  await hotplug.page.waitForFunction(() => document.querySelector('.source-control')?.textContent.includes('2 个设备'));
  assert.equal(await count(hotplug.page, 'scan_local_source'), 1, 'New card cannot replace active session');
  await hotplug.page.evaluate(() => { window.testState.devices = []; });
  await hotplug.page.getByText('来源已断开，请重新连接同一设备；审片记录仍保留').waitFor();
  await hotplug.page.evaluate(card => { window.testState.devices = [card]; }, card);
  await hotplug.page.waitForFunction(() => !document.querySelector('.statusbar')?.textContent.includes('来源已断开'));
  assert.equal(await count(hotplug.page, 'scan_local_source'), 1);
  assert.deepEqual(hotplug.errors, []);

  const multiple = await setup({ devices: [card, second] });
  await multiple.page.getByText('已检测到 2 个设备').waitFor();
  assert.equal(await count(multiple.page, 'scan_local_source'), 0, 'Multiple cards require a choice');
  await multiple.page.getByRole('button', { name: /Second card/ }).click();
  await multiple.page.locator('.source-control').waitFor();
  assert.equal(await multiple.page.evaluate(() => window.testState.calls.find(call => call.command === 'scan_local_source').args.root), second.root);

  const mtp = await setup({ devices: [{ id: 'mtp-1', name: 'Sony α6700', root: null, transport: 'mtp' }] });
  await mtp.page.getByText(/当前不能直接读取此设备/).waitFor();
  assert.equal(await count(mtp.page, 'scan_local_source'), 0);
  const emptyBox = await mtp.page.locator('.empty-workspace').boundingBox();
  assert.equal(emptyBox.width, 1024, 'Empty workspace must span every grid column at minimum size');
  const helpBox = await mtp.page.getByText(/当前不能直接读取此设备/).boundingBox();
  assert(helpBox.x >= 0 && helpBox.y + helpBox.height <= 640, 'MTP recovery instructions remain visible');
  await mtp.page.screenshot({ path: 'artifacts/device-mtp-1024.png' });

  const resume = await setup({ saved, unavailable: true, devices: [second] });
  await resume.page.getByText(/上次会话已保留/).waitFor();
  const before = await count(resume.page, 'scan_local_source');
  assert.equal(await count(resume.page, 'save_session_snapshot'), 0, 'Unavailable session stays intact');
  await resume.page.evaluate(card => { window.testState.unavailable = false; window.testState.devices = [card]; }, card);
  await resume.page.locator('.source-control').waitFor();
  assert.equal(await count(resume.page, 'scan_local_source'), before + 1);
  await resume.page.waitForFunction(() => document.querySelector('.finish')?.disabled === false);
  const finish = resume.page.locator('.finish');
  await finish.click();
  await resume.page.waitForFunction(() => document.querySelector('.finish')?.disabled === false);
  assert.equal(await count(resume.page, 'commit_session'), 0, 'Cancel must not commit');
  await resume.page.evaluate(() => { window.testState.answer = '完成导入'; window.testState.commitError = true; });
  await finish.click();
  await resume.page.getByText('目标设备不可用', { exact: true }).waitFor();
  assert.equal(await finish.isEnabled(), true, 'Failure releases lock for retry');
  await resume.page.evaluate(() => { window.testState.commitError = false; });
  await finish.evaluate(button => { button.click(); button.click(); button.click(); });
  await resume.page.getByText('导入已完成', { exact: true }).waitFor();
  assert.equal(await count(resume.page, 'commit_session'), 2, 'Rapid clicks produce only one additional commit');
  assert.equal(await resume.page.locator('.error-toast').count(), 0, 'Successful retry clears stale error');
  assert.deepEqual(resume.errors, []);
  await resume.page.locator('.source-control').click();
  await resume.page.screenshot({ path: 'artifacts/device-import-1024.png' });
  console.log('PASS: hotplug, multiple devices, no session takeover, disconnect/reconnect, MTP guidance, saved-session recovery, cancel, failure/retry and duplicate-submit protection (mocked IPC)');
} finally { await browser.close(); }
