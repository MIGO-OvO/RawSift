import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { installNativeCallbacks } from './native-mock.mjs';

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const url = process.env.TEST_URL || 'http://127.0.0.1:1420';
const saved = { sessionId: '00000000-0000-4000-8000-000000000011', sourceRoot: 'E:/DCIM', recursive: true, activeDate: '2026-09-14', currentCaptureId: 'capture-1', destinationRoot: 'F:/Photos', shootName: '', importMode: 'raw', showInfo: false, showHistogram: false, autoAdvance: false, reviews: {}, transfers: {} };
async function setup(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(installNativeCallbacks);
  await page.addInitScript(({ saved, options }) => {
    window.isTauri = true;
    window.pendingStages = new Map();
    const state = window.testState = { calls: [], events: new Map(), destination: 'H:/NewLibrary', holdStages: false, ignoreCancel: false, stageError: false, commitError: false, maximized: false, saved, ...options };
    const preview = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000" fill="#655b51"/></svg>')}`;
    const scan = root => ({ sourceRoot: root, sourceName: 'Sony fixture', scannedFiles: 8, unsupportedFiles: 0, dateGroups: state.splitDates ? [{ dateKey: saved.activeDate, captureCount: 2, pairedCount: 2, totalBytes: 400 }, { dateKey: '2026-09-13', captureCount: 2, pairedCount: 2, totalBytes: 400 }] : [{ dateKey: saved.activeDate, captureCount: 4, pairedCount: 4, totalBytes: 800 }], captures: Array.from({ length: 4 }, (_, index) => ({
      id: `capture-${index + 1}`, stem: `DSC0000${index + 1}`, capturedAt: '2026-09-14T12:00:00+08:00', dateKey: state.splitDates && index >= 2 ? '2026-09-13' : saved.activeDate, previewPath: preview,
      jpeg: { id: `jpeg-${index}`, kind: 'jpeg', name: `DSC0000${index + 1}.JPG`, path: `${root}/DSC0000${index + 1}.JPG`, sizeBytes: 100 },
      raw: { id: `raw-${index}`, kind: 'raw', name: `DSC0000${index + 1}.ARW`, path: `${root}/DSC0000${index + 1}.ARW`, sizeBytes: 100 }, orientationDegrees: 0, orientationMirrored: false, exif: null,
    })) });
    Object.assign(window.__TAURI_INTERNALS__, { invoke: async (command, args) => {
      state.calls.push({ command, args });
      if (command === 'load_last_session') return state.saved;
      if (command === 'load_source_session') return args.sourceRoot === saved.sourceRoot ? state.saved : null;
      if (command === 'load_import_history') return [];
      if (command === 'discover_photo_devices') return { devices: [], warning: null };
      if (command === 'scan_local_source') return scan(args.root);
      if (command === 'plugin:dialog|open') return state.destination;
      if (command === 'plugin:event|listen') { state.events.set(args.event, args.handler); return args.handler; }
      if (command === 'plugin:window|is_maximized') return state.maximized;
      if (command === 'plugin:window|toggle_maximize') { state.maximized = !state.maximized; window.nativeCallbacks.get(state.events.get('tauri://resize'))?.({ event: 'tauri://resize', payload: { width: 1280, height: 800 } }); return; }
      if (command === 'stage_capture') {
        const request = args.request;
        let messageIndex = 0;
        const totalFiles = request.importMode === 'jpeg+raw' ? 2 : 1;
        const send = (phase, bytes) => window.nativeCallbacks.get(args.onProgress.id)?.({ index: messageIndex++, message: { operationId: request.operationId, captureId: request.captureId, phase, fileName: 'DSC00001.ARW', bytesProcessed: bytes, totalBytes: 100, filesCompleted: 0, totalFiles, speedBytesPerSecond: 1234000 } });
        send('copying', 25);
        if (state.holdStages) await new Promise((resolve, reject) => window.pendingStages.set(request.operationId, { resolve, reject, request, send }));
        else await new Promise(resolve => setTimeout(resolve, 80));
        if (state.stageError) throw '磁盘空间不足';
        send('verifying', 50);
        await new Promise(resolve => setTimeout(resolve, 30));
        send('verifying', 100);
        return [{ name: 'DSC00001.ARW', bytes: 100, blake3: 'abc', stagingPath: 'staging' }];
      }
      if (command === 'cancel_transfer') {
        if (!state.ignoreCancel) window.pendingStages.get(args.operationId)?.reject('已取消');
        return;
      }
      if (command === 'unstage_capture' && state.delayCleanup) await new Promise(resolve => setTimeout(resolve, 180));
      if (command === 'commit_session') {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (state.commitError) throw '目标设备不可用';
        const files = args.request.captureIds.map(id => ({ originalName: `${id}.ARW`, destination: `${args.request.destinationRoot}/${id}.ARW`, bytes: 100, blake3: 'abcdef', disposition: 'committed' }));
        window.nativeCallbacks.get(args.onProgress.id)?.({ index: 0, message: { operationId: args.request.sessionId, captureId: files[0].originalName, phase: 'committing', fileName: files[0].originalName, bytesProcessed: 0, totalBytes: 0, filesCompleted: files.length, totalFiles: files.length, speedBytesPerSecond: 0 } });
        return { files, persistenceWarning: null };
      }
      if (command === 'preview_thumbnail') {
        const bmp = new Uint8Array(58); bmp.set([66,77]); const data = new DataView(bmp.buffer);
        data.setUint32(2,58,true); data.setUint32(10,54,true); data.setUint32(14,40,true); data.setInt32(18,1,true); data.setInt32(22,1,true); data.setUint16(26,1,true); data.setUint16(28,24,true); return bmp.buffer;
      }
      return null;
    } });
  }, { saved, options });
  await page.goto(url);
  await page.locator('.source-control').waitFor();
  return { page, errors };
}
const count = (page, command) => page.evaluate(command => window.testState.calls.filter(call => call.command === command).length, command);
const keep = async page => { await page.locator('.decision.keep').click(); };
const verified = async page => page.waitForFunction(() => document.querySelector('.finish')?.disabled === false);
const commit = async page => {
  await page.locator('.finish').click();
  await page.getByRole('dialog').getByRole('button', { name: '完成导入', exact: true }).click();
  await page.getByRole('dialog', { name: '导入完成', exact: true }).waitFor();
};
try {
  const lifecycle = await setup();
  const page = lifecycle.page;
  await keep(page); await verified(page); await commit(page);
  await page.screenshot({ path: 'artifacts/import-result.png' });
  await page.getByRole('button', { name: '继续导入', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert(await page.locator('.decision.keep').isEnabled());
  await keep(page); await verified(page); await commit(page);
  const requests = await page.evaluate(() => window.testState.calls.filter(call => call.command === 'commit_session').map(call => call.args.request));
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].sessionId, requests[1].sessionId, 'Each batch has a new staging identity');
  assert.equal(requests[0].reviewSessionId, requests[1].reviewSessionId, 'Review identity remains stable');
  assert.deepEqual(requests.map(request => request.captureIds), [['capture-1'], ['capture-2']], 'Completed captures are excluded');
  await page.getByRole('button', { name: '查看结果', exact: true }).click();
  assert.equal(await page.locator('.history-batch').count(), 2);
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('.notice-toast'), { timeout: 7000 });
  assert.deepEqual(lifecycle.errors, []);
  console.log('PASS: consecutive batches, preserved review identity/history, excluded completed captures, toast timeout and modal Escape');

  const recoveryBatch = '00000000-0000-4000-8000-000000000012';
  const dates = await setup({ splitDates: true, saved: { ...saved, pendingBatchId: recoveryBatch, reviews: { 'capture-1': 'keep', 'capture-3': 'keep' } } });
  await verified(dates.page);
  await dates.page.waitForFunction(() => window.testState.calls.filter(call => call.command === 'stage_capture').length === 2);
  assert.equal(await dates.page.evaluate(() => window.testState.calls.find(call => call.command === 'stage_capture').args.request.sessionId), recoveryBatch, 'Restart preserves unfinished staging identity');
  await commit(dates.page); await dates.page.getByRole('button', { name: '继续导入', exact: true }).click();
  await dates.page.getByRole('button', { name: /9月13/ }).click();
  await verified(dates.page); await commit(dates.page);
  assert.deepEqual(await dates.page.evaluate(() => window.testState.calls.filter(call => call.command === 'commit_session').map(call => call.args.request.captureIds)), [['capture-1'], ['capture-3']]);
  const otherDateStages = await dates.page.evaluate(() => window.testState.calls.filter(call => call.command === 'stage_capture' && call.args.request.captureId === 'capture-3').map(call => call.args.request.sessionId));
  assert.equal(otherDateStages.length, 2); assert.notEqual(otherDateStages[0], otherDateStages[1], 'A staged future date is verified again in the new batch');
  assert.deepEqual(dates.errors, []);
  console.log('PASS: persisted batch recovery and consecutive date groups with pre-staged captures');

  const race = await setup({ holdStages: true, ignoreCancel: true });
  await keep(race.page);
  await race.page.getByRole('progressbar').waitFor();
  assert.equal(await race.page.getByRole('progressbar').getAttribute('aria-valuenow'), '25');
  await race.page.screenshot({ path: 'artifacts/import-progress.png' });
  assert(await race.page.locator('.progress-speed').textContent().then(value => value.includes('1.2 MB')));
  await race.page.locator('.destination-path').click();
  await race.page.waitForFunction(() => window.testState.calls.some(call => call.command === 'cancel_transfer'));
  await race.page.evaluate(() => { const job = window.pendingStages.values().next().value; job.send('verifying', 100); job.resolve(); });
  await race.page.waitForFunction(() => window.testState.calls.filter(call => call.command === 'stage_capture').length === 2);
  assert.equal(await race.page.locator('.finish').isEnabled(), false, 'Old target verification cannot enable commit');
  await race.page.getByRole('button', { name: 'JPG + RAW', exact: true }).click();
  await race.page.evaluate(() => { [...window.pendingStages.values()].at(-1).resolve(); });
  await race.page.waitForFunction(() => window.testState.calls.filter(call => call.command === 'stage_capture').length === 3);
  const currentRequest = await race.page.evaluate(() => window.testState.calls.filter(call => call.command === 'stage_capture').at(-1).args.request);
  assert.equal(currentRequest.destinationRoot, 'H:/NewLibrary'); assert.equal(currentRequest.importMode, 'jpeg+raw');
  await race.page.evaluate(() => { window.testState.ignoreCancel = false; });
  await race.page.getByRole('button', { name: '暂停导入', exact: true }).click();
  await race.page.getByRole('button', { name: '重试未完成', exact: true }).waitFor();
  await race.page.evaluate(() => { window.testState.holdStages = false; window.testState.stageError = true; });
  await race.page.getByRole('button', { name: '重试未完成', exact: true }).click();
  await race.page.locator('.transfer-state.failed').waitFor();
  await race.page.evaluate(() => { window.testState.stageError = false; });
  await race.page.getByRole('button', { name: '重试未完成', exact: true }).click(); await verified(race.page);
  assert.deepEqual(race.errors, []);
  console.log('PASS: measured progress/speed, stale destination/mode results ignored, cooperative cancel, failure/retry');

  const selection = await setup({ holdStages: true, ignoreCancel: true, delayCleanup: true });
  await keep(selection.page);
  await selection.page.getByRole('progressbar').waitFor();
  await selection.page.locator('.decision.reject').click();
  await keep(selection.page);
  await selection.page.evaluate(() => { window.pendingStages.values().next().value.resolve(); });
  assert.equal(await count(selection.page, 'stage_capture'), 1, 'Re-keep must wait for old staged-file cleanup');
  await selection.page.waitForFunction(() => window.testState.calls.filter(call => call.command === 'stage_capture').length === 2);
  assert.equal(await selection.page.locator('.finish').isEnabled(), false, 'Rejected then re-kept capture cannot accept revoked task results');
  await selection.page.evaluate(() => { [...window.pendingStages.values()].at(-1).resolve(); });
  await verified(selection.page);
  assert.deepEqual(selection.errors, []);
  console.log('PASS: rapid reject/re-keep revokes old selection identity');

  const comparison = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const compareErrors = []; comparison.on('pageerror', error => compareErrors.push(error.message));
  await comparison.goto(url);
  await comparison.getByRole('button', { name: '网格视图', exact: true }).click();
  const gridNames = await comparison.locator('.grid-name').allTextContents();
  await comparison.getByRole('button', { name: new RegExp(`将 ${gridNames[3].slice(0,8)} 设为比较 A`) }).click();
  await comparison.getByRole('button', { name: '替换比较照片 B', exact: true }).click();
  await comparison.locator('.compare-picker button').nth(9).click();
  assert.equal(await comparison.locator('.compare-caption strong').nth(0).textContent(), gridNames[3].slice(0,8));
  assert.equal(await comparison.locator('.compare-caption strong').nth(1).textContent(), gridNames[9].slice(0,8));
  await comparison.getByRole('button', { name: '交换 A/B', exact: true }).click();
  assert.equal(await comparison.locator('.compare-caption strong').nth(0).textContent(), gridNames[9].slice(0,8));
  await comparison.getByRole('button', { name: '100%', exact: true }).click();
  await comparison.waitForFunction(() => [...document.querySelectorAll('.compare-pane img')].every(image => image.clientWidth === image.naturalWidth / 2));
  const imageState = () => comparison.locator('.compare-pane img').evaluateAll(images => images.map(image => ({ width: image.clientWidth, natural: image.naturalWidth, matrix: getComputedStyle(image).transform })));
  assert((await imageState()).every(image => Math.abs(image.width - image.natural / 2) < 1), '100% maps JPEG pixels to physical pixels at 200% DPI');
  const host = comparison.locator('.compare-pane .photo-preview').first();
  const bounds = await host.boundingBox();
  await comparison.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await comparison.mouse.wheel(0, -600);
  assert.equal(await comparison.getByRole('button', { name: '同步缩放和平移', exact: true }).getAttribute('aria-pressed'), 'true');
  await comparison.mouse.down(); await comparison.mouse.move(bounds.x + bounds.width / 2 + 35, bounds.y + bounds.height / 2 + 20); await comparison.mouse.up();
  const synced = await comparison.locator('.compare-pane img').evaluateAll(images => images.map(image => ({ width: image.clientWidth / image.naturalWidth, matrix: new DOMMatrix(getComputedStyle(image).transform) })).map(item => ({ zoom: item.width, x: item.matrix.e, y: item.matrix.f })));
  assert(Math.abs(synced[0].zoom - synced[1].zoom) < 0.01, 'Both images share zoom');
  await comparison.getByRole('button', { name: '适应窗口', exact: true }).click();
  await comparison.getByRole('button', { name: '选择 B', exact: true }).click();
  if (await comparison.getByRole('button', { name: '上一组胶片', exact: true }).isEnabled()) await comparison.getByRole('button', { name: '上一组胶片', exact: true }).click();
  await comparison.locator(`.film-frame[title="${gridNames[2].slice(0,8)}"]`).click();
  assert.equal(await comparison.locator('.compare-caption strong').nth(1).textContent(), gridNames[2].slice(0,8));
  for (const viewport of [{width:1024,height:640},{width:800,height:560},{width:3840,height:2160}]) {
    await comparison.setViewportSize(viewport);
    if (viewport.width === 1024) await comparison.screenshot({ path: 'artifacts/compare-1024.png' });
    assert(await comparison.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Scaled viewport has no document overflow');
    for (const pane of await comparison.locator('.compare-pane').all()) { const box = await pane.boundingBox(); assert(box.width > 0 && box.height > 100); }
  }
  await comparison.emulateMedia({ reducedMotion: 'reduce' });
  await comparison.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await comparison.getByRole('dialog').evaluate(dialog => getComputedStyle(dialog).animationName), 'none');
  await comparison.keyboard.press('p');
  assert.equal(await comparison.locator('.filterbar button').nth(2).textContent(), '保留0', 'Modal typing cannot review underlying photo');
  await comparison.keyboard.press('Escape');
  assert.deepEqual(compareErrors, []);
  console.log('PASS: arbitrary grid/filmstrip A/B, replace/swap, synchronized zoom/pan, physical 100%, 800–3840px layouts and reduced motion');

  const windows = await setup();
  await windows.page.getByRole('button', { name: '最小化', exact: true }).click();
  assert.equal(await count(windows.page, 'plugin:window|minimize'), 1);
  await windows.page.getByRole('button', { name: '最大化', exact: true }).click();
  await windows.page.getByRole('button', { name: '还原窗口', exact: true }).click();
  assert.equal(await count(windows.page, 'plugin:window|toggle_maximize'), 2);
  await windows.page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  assert.equal(await count(windows.page, 'plugin:window|close'), 1);
  assert.deepEqual(windows.errors, []);
  console.log('PASS: real Tauri window IPC contracts for minimize/maximize/restore/close (mocked OS)');
} finally { await browser.close(); }
