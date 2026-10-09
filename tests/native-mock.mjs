// Install the actual Tauri Channel/event callback contract, not a fake percentage.
export function installNativeCallbacks() {
  let next = 0;
  window.nativeCallbacks = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ ??= {};
  Object.assign(window.__TAURI_INTERNALS__, {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(callback) { const id = ++next; window.nativeCallbacks.set(id, callback); return id; },
    unregisterCallback(id) { window.nativeCallbacks.delete(id); },
  });
}
