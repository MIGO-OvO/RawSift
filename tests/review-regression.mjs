import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Use an existing Playwright installation; no application dependency is needed.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function contained(container, image) {
  await image.waitFor({ state: 'visible' });
  const stage = await container.boundingBox();
  const photo = await image.boundingBox();
  assert(photo.x >= stage.x - 1 && photo.y >= stage.y - 1 && photo.x + photo.width <= stage.x + stage.width + 1 && photo.y + photo.height <= stage.y + stage.height + 1, 'Photo must fit inside its container');
}
try {
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:1420');
  const paths = await page.evaluate(async () => {
    const { histogramPaths } = await import('/src/histogram.ts');
    const bins = Array(256).fill(10);
    return histogramPaths({ red: bins, green: bins, blue: bins, luminance: bins });
  });
  assert(paths.every(path => (path.match(/L/g) || []).length >= 256), 'Every histogram channel must retain 256 bins');
  await page.locator('.film-frame').nth(4).click();
  await page.waitForTimeout(350);
  await contained(page.locator('.viewer-stage'), page.locator('.viewer-stage img'));
  await page.getByRole('button', { name: '向右旋转', exact: true }).click();
  assert.equal(await page.locator('.viewer-tools > span').textContent(), '本地旋转 90°');
  await contained(page.locator('.viewer-stage'), page.locator('.viewer-stage img'));
  await page.reload();
  await page.locator('.film-frame').nth(4).click();
  assert.equal(await page.locator('.viewer-tools > span').textContent(), '本地旋转 90°', 'Manual rotation persists');
  await page.keyboard.press('Shift+R');
  assert.equal(await page.locator('.viewer-tools > span').textContent(), '自动方向 · 适应窗口');
  await page.locator('.shoot-name input').fill('rpxu');
  await page.locator('.shoot-name input').press('r');
  assert.equal(await page.locator('.shoot-name input').inputValue(), 'rpxur');
  assert.equal(await page.locator('.viewer-tools > span').textContent(), '自动方向 · 适应窗口', 'Typing must not rotate or review');
  await page.locator('.shoot-name input').blur();
  await page.keyboard.down('Space');
  assert(await page.locator('.viewer.focus-check').count());
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('.viewer.focus-check').count(), 0, 'Focus check releases when the window loses focus');
  await page.keyboard.up('Space');
  await page.keyboard.press('c');
  for (const pane of await page.locator('.compare-pane').all()) {
    await contained(pane, pane.locator('img'));
  }
  await page.keyboard.press('c');
  for (const viewport of [{ width: 1024, height: 640 }, { width: 3992, height: 2200 }, { width: 1600, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    await contained(page.locator('.viewer-stage'), page.locator('.viewer-stage img'));
  }
  await page.screenshot({ path: 'artifacts/review-fixed.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: 256 bins, portrait/rotation/compare containment, persistence, input shortcuts, focus release, 1024–3992px layouts');

  const perf = await browser.newPage();
  await perf.addInitScript(() => {
    window.analyses = 0;
    const get = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      window.analyses++;
      return get.apply(this, args);
    };
  });
  await perf.goto(process.env.TEST_URL || 'http://127.0.0.1:1420');
  await perf.waitForFunction(() => window.analyses > 0);
  await perf.evaluate(() => { window.analyses = 0; });
  for (let i = 0; i < 10; i++) await perf.keyboard.press('ArrowRight');
  await perf.waitForTimeout(1200);
  const analyses = await perf.evaluate(() => window.analyses);
  assert(analyses >= 1 && analyses <= 2, `Rapid navigation should analyze only the final frame, got ${analyses}`);
  console.log(`PASS: rapid 10-frame navigation analysis count 10 → ${analyses}`);

  // Real JPEG APP1/EXIF orientations, not CSS-only synthetic portrait fixtures.
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 80;
    const context = canvas.getContext('2d');
    context.fillStyle = '#cb453a'; context.fillRect(0, 0, 60, 80);
    context.fillStyle = '#44885f'; context.fillRect(60, 0, 60, 80);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]), char => char.charCodeAt(0));
    return Array.from({ length: 8 }, (_, index) => {
      const orientation = index + 1;
      const app1 = new Uint8Array([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
      return 'data:image/jpeg;base64,' + btoa(String.fromCharCode(...bytes.slice(0, 2), ...app1, ...bytes.slice(2)));
    });
  });
  const exif = await browser.newPage();
  await exif.route(/\/src\/demo\.ts(?:\?.*)?$/, async route => {
    const captures = fixture.map((url, index) => ({ id: `exif-${index + 1}`, stem: `EXIF ${index + 1}`, capturedAt: '2026-09-04T10:00:00+08:00', dateKey: '2026-09-04', previewPath: url,
      jpeg: { id: `jpg-${index}`, kind: 'jpeg', name: 'test.jpg', path: '', sizeBytes: 1000 }, raw: null,
      orientationDegrees: [0, 0, 180, 180, 270, 90, 90, 270][index], orientationMirrored: [2, 4, 5, 7].includes(index + 1), exif: null }));
    await route.fulfill({ contentType: 'text/javascript', body: `export const demoScan = ${JSON.stringify({ sourceRoot: 'test', sourceName: 'EXIF fixture', captures, scannedFiles: 8, unsupportedFiles: 0, dateGroups: [{ dateKey: '2026-09-04', captureCount: 8, pairedCount: 0, totalBytes: 8000 }] })};` });
  });
  await exif.goto(process.env.TEST_URL || 'http://127.0.0.1:1420');
  for (let index = 0; index < 8; index++) {
    await exif.locator('.film-frame').nth(index).click();
    await exif.waitForFunction(() => {
      const image = document.querySelector('.viewer-stage img');
      return image?.complete && getComputedStyle(image).visibility === 'visible';
    });
    const actual = await exif.locator('.viewer-stage img').evaluate(image => {
      const matrix = new DOMMatrix(getComputedStyle(image).transform);
      return { width: image.naturalWidth, height: image.naturalHeight, a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d };
    });
    assert.deepEqual(actual, { width: index >= 4 ? 80 : 120, height: index >= 4 ? 120 : 80, a: 1, b: 0, c: 0, d: 1 }, `EXIF ${index + 1} must be applied exactly once by the decoder`);
    await contained(exif.locator('.viewer-stage'), exif.locator('.viewer-stage img'));
  }
  console.log('PASS: all 8 actual JPEG EXIF orientations applied exactly once');

  const desktop = await browser.newPage();
  const scan = await exif.evaluate(async () => (await import('/src/demo.ts')).demoScan);
  await desktop.addInitScript(scan => {
    window.isTauri = true;
    window.thumbnailCalls = 0;
    window.activeDecodes = 0;
    window.peakDecodes = 0;
    const bmp = new Uint8Array(54 + 120 * 80 * 3);
    const header = new DataView(bmp.buffer);
    bmp.set([66, 77]);
    header.setUint32(2, bmp.length, true); header.setUint32(10, 54, true);
    header.setUint32(14, 40, true); header.setInt32(18, 120, true); header.setInt32(22, -80, true);
    header.setUint16(26, 1, true); header.setUint16(28, 24, true);
    for (let i = 54; i < bmp.length; i += 3) bmp.set([60, 130, 180], i);
    window.__TAURI_INTERNALS__ = { invoke: async command => {
      if (command === 'load_last_session') return { sessionId: '00000000-0000-4000-8000-000000000001', sourceRoot: 'fixture', recursive: false, activeDate: '2026-09-04', currentCaptureId: scan.captures[0].id, destinationRoot: null, shootName: '', importMode: 'jpeg', showInfo: true, showHistogram: false, autoAdvance: false, reviews: {}, transfers: {} };
      if (command === 'scan_local_source') return scan;
      if (command === 'preview_thumbnail') {
        window.thumbnailCalls++; window.activeDecodes++;
        window.peakDecodes = Math.max(window.peakDecodes, window.activeDecodes);
        await new Promise(resolve => setTimeout(resolve, 10));
        window.activeDecodes--;
        return bmp.buffer;
      }
    } };
  }, scan);
  await desktop.goto(process.env.TEST_URL || 'http://127.0.0.1:1420');
  await desktop.waitForFunction(() => document.querySelectorAll('.film-frame img[src^="blob:"]').length === 8);
  for (const frame of await desktop.locator('.film-frame').all()) await contained(frame, frame.locator('img'));
  assert.equal(await desktop.evaluate(() => window.peakDecodes), 1, 'Thumbnail decodes must be serialized');
  assert.equal(await desktop.locator('.film-frame img').first().evaluate(image => image.naturalWidth), 120, 'Binary thumbnail response is decoded by the browser');
  await desktop.keyboard.press('g');
  await desktop.waitForFunction(() => document.querySelectorAll('.grid-cell img[src^="blob:"]').length === 8);
  assert.equal(await desktop.evaluate(() => window.thumbnailCalls), 8, 'Grid must reuse filmstrip thumbnails');
  assert.equal(await desktop.locator('.grid-cell img:not([src^="blob:"])').count(), 0, 'Small views must not load originals');
  console.log('PASS: desktop IPC binary thumbnails, bounded decode concurrency, shared cache and no full-resolution grid loads (mocked IPC)');
} finally {
  await browser.close();
}
