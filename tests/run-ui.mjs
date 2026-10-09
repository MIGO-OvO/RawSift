import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const url = process.env.TEST_URL || 'http://127.0.0.1:1421';
const server = process.env.TEST_URL ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '1421', '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
server?.stderr.on('data', data => process.stderr.write(data));
server?.stdout.resume();
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await delay(200);
  }
  if (!ready) throw new Error(`Vite did not start at ${url}`);
  for (const test of ['import-permissions', 'device-import-regression', 'review-regression', 'workstation-regression']) {
    const code = await new Promise((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, [`tests/${test}.mjs`], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...globalThis.process.env, TEST_URL: url } });
      process.on('error', reject); process.on('exit', resolve);
    });
    if (code !== 0) throw new Error(`${test} failed with exit ${code}`);
  }
} finally { server?.kill(); }
