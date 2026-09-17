'use strict';

/**
 * Minimal in-memory mock of the chrome.* extension APIs used by Claude Guard.
 * Only promise-returning shapes are implemented (MV3 style).
 */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function listenerSet() {
  const fns = [];
  return {
    addListener(fn) { fns.push(fn); },
    removeListener(fn) { const i = fns.indexOf(fn); if (i !== -1) fns.splice(i, 1); },
    hasListener(fn) { return fns.includes(fn); },
    _fns: fns
  };
}

function createChromeMock(options = {}) {
  const localStore = clone(options.local) || {};
  const managedStore = clone(options.managed) || {};
  const tabs = (options.tabs || []).map((t) => ({ ...t }));
  const sent = [];       // tabs.sendMessage calls
  const runtimeSent = []; // runtime.sendMessage calls (from content/popup)
  const windows = { created: [], removed: [], updated: [] };
  const action = { icons: [], badges: [] };

  const storage = {
    local: {
      get(keys) {
        const out = {};
        const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(localStore) : [keys];
        for (const k of list) if (k in localStore) out[k] = clone(localStore[k]);
        return Promise.resolve(out);
      },
      set(obj) {
        for (const k of Object.keys(obj)) localStore[k] = clone(obj[k]);
        for (const fn of storage.onChanged._fns) fn(obj, 'local');
        return Promise.resolve();
      }
    },
    managed: {
      get(keys) {
        const out = {};
        const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(managedStore) : [keys];
        for (const k of list) if (k in managedStore) out[k] = clone(managedStore[k]);
        return Promise.resolve(out);
      }
    },
    onChanged: listenerSet()
  };

  const runtime = {
    onMessage: listenerSet(),
    onInstalled: listenerSet(),
    onConnect: listenerSet(),
    sendMessage(msg) {
      runtimeSent.push(clone(msg));
      const handler = options.onRuntimeMessage;
      return Promise.resolve(handler ? handler(msg) : undefined);
    },
    connect() { throw new Error('runtime.connect not mocked'); }
  };

  const chrome = {
    storage,
    runtime,
    tabs: {
      query(q) {
        let list = tabs;
        if (q && q.groupId !== undefined) list = list.filter((t) => t.groupId === q.groupId);
        if (q && q.active !== undefined) list = list.filter((t) => !!t.active === q.active);
        return Promise.resolve(list.map((t) => ({ ...t })));
      },
      sendMessage(tabId, msg) { sent.push({ tabId, msg: clone(msg) }); return Promise.resolve(); },
      onUpdated: listenerSet(),
      onRemoved: listenerSet()
    },
    action: {
      setIcon(o) { action.icons.push(o); return Promise.resolve(); },
      setBadgeText(o) { action.badges.push(o); return Promise.resolve(); },
      setBadgeBackgroundColor() { return Promise.resolve(); }
    },
    windows: {
      create(o) { const win = { id: 900 + windows.created.length, ...o }; windows.created.push(win); return Promise.resolve(win); },
      update(id, o) { windows.updated.push({ id, ...o }); return Promise.resolve(); },
      remove(id) { windows.removed.push(id); return Promise.resolve(); },
      getLastFocused() { return Promise.resolve({ left: 0, top: 0, width: 1400, height: 900 }); },
      onRemoved: listenerSet()
    }
  };

  /**
   * Deliver a message to the background's onMessage listeners the way Chrome
   * would, resolving with whatever the handler passed to `sendResponse`.
   */
  function dispatch(msg, sender = {}) {
    return new Promise((resolve) => {
      let async = false;
      let replied = false;
      for (const fn of runtime.onMessage._fns) {
        // Chrome structured-clones replies; mirror that so objects created inside
        // the background VM context compare equal to test-realm literals.
        const ret = fn(msg, sender, (value) => { replied = true; resolve(clone(value)); });
        if (ret === true) async = true;
      }
      if (!async && !replied) resolve(undefined);
    });
  }

  function fireManagedChange(changes) {
    for (const k of Object.keys(changes)) managedStore[k] = clone(changes[k]);
    for (const fn of storage.onChanged._fns) fn(changes, 'managed');
  }

  return {
    chrome,
    dispatch,
    fireManagedChange,
    localStore,
    managedStore,
    sent,
    runtimeSent,
    windows,
    action,
    tabs
  };
}

module.exports = { createChromeMock };
