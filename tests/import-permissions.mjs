import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { confirm } from '@tauri-apps/plugin-dialog';

const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url)));
const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)));
assert(capability.windows.includes(config.app.windows[0].label));
let response = '完成导入';
globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command) => {
  assert.equal(command, 'plugin:dialog|message');
  assert(capability.permissions.includes('dialog:allow-message'), `${command} not allowed by ACL`);
  return response;
} } };
const options = { okLabel: '完成导入', cancelLabel: '继续审片' };
assert.equal(await confirm('导入确认', options), true);
response = '继续审片';
assert.equal(await confirm('导入确认', options), false);
console.log('PASS: real dialog confirm command allowed for main window; confirm/cancel semantics');
