/**
 * Minimal in-memory, promise-based mock of the subset of the `chrome`
 * extension API that background.js touches at module scope and inside
 * its message handlers: `chrome.storage.local.get/set/remove`,
 * `chrome.runtime.onMessage/onInstalled.addListener`, `chrome.contextMenus`,
 * and `chrome.tabs.sendMessage`.
 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createChromeMock() {
  const store = new Map();

  const local = {
    async get(keys) {
      if (keys === undefined || keys === null) {
        const out = {};
        for (const [k, v] of store) out[k] = clone(v);
        return out;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        if (store.has(k)) out[k] = clone(store.get(k));
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, clone(v));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    }
  };

  return {
    storage: { local },
    runtime: {
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      lastError: undefined
    },
    contextMenus: {
      create() {},
      removeAll(cb) {
        if (cb) cb();
      },
      onClicked: { addListener() {} }
    },
    tabs: {
      sendMessage() {}
    }
  };
}

module.exports = { createChromeMock };
