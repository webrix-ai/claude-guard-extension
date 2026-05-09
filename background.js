var agentTabs = new Set();

var DEFAULT_STATE = {
  allowList: [],
  blockList: [],
  autoMode: true,
  stats: { blocked: 0, allowed: 0 },
  log: []
};

function getState() {
  return chrome.storage.local.get('cg').then(function (data) {
    return Object.assign({}, DEFAULT_STATE, data.cg);
  });
}

function setState(state) {
  return chrome.storage.local.set({ cg: state });
}

function broadcast(msg) {
  chrome.tabs.query({}).then(function (tabs) {
    tabs.forEach(function (t) {
      chrome.tabs.sendMessage(t.id, msg).catch(function () {});
    });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get('cg').then(function (data) {
    if (!data.cg) chrome.storage.local.set({ cg: DEFAULT_STATE });
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  agentTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  switch (msg.type) {

    case 'get-state':
      getState().then(reply);
      return true;

    case 'get-tab-status':
      reply({ agentActive: agentTabs.has(msg.tabId) });
      return false;

    case 'set-auto-mode':
      getState().then(function (s) {
        s.autoMode = msg.enabled;
        return setState(s).then(function () {
          broadcast({ type: 'rules-updated', allowList: s.allowList, blockList: s.blockList, autoMode: s.autoMode });
          reply({ ok: true });
        });
      });
      return true;

    case 'add-rule':
      getState().then(function (s) {
        var list = msg.list === 'allow' ? 'allowList' : 'blockList';
        var exists = s[list].some(function (r) {
          return r.pattern === msg.rule.pattern && r.method === msg.rule.method;
        });
        if (!exists) s[list].push(msg.rule);
        return setState(s).then(function () {
          broadcast({ type: 'rules-updated', allowList: s.allowList, blockList: s.blockList, autoMode: s.autoMode });
          reply({ ok: true });
        });
      });
      return true;

    case 'remove-rule':
      getState().then(function (s) {
        var list = msg.list === 'allow' ? 'allowList' : 'blockList';
        s[list].splice(msg.index, 1);
        return setState(s).then(function () {
          broadcast({ type: 'rules-updated', allowList: s.allowList, blockList: s.blockList, autoMode: s.autoMode });
          reply({ ok: true });
        });
      });
      return true;

    case 'log-event':
      getState().then(function (s) {
        s.log.unshift({ method: msg.event.method, url: msg.event.url, action: msg.event.action, ts: Date.now() });
        if (s.log.length > 200) s.log.length = 200;
        if (msg.event.action === 'block') s.stats.blocked++;
        else s.stats.allowed++;
        return setState(s).then(function () { reply({ ok: true }); });
      });
      return true;

    case 'clear-stats':
      getState().then(function (s) {
        s.stats = { blocked: 0, allowed: 0 };
        s.log = [];
        return setState(s).then(function () { reply({ ok: true }); });
      });
      return true;

    case 'agent-on':
      if (sender.tab && sender.tab.id) {
        agentTabs.add(sender.tab.id);
        chrome.action.setIcon({
          path: { 16: 'icons/icon16-active.png', 48: 'icons/icon48-active.png', 128: 'icons/icon128-active.png' },
          tabId: sender.tab.id
        }).catch(function () {});
        chrome.action.setBadgeText({ text: 'ON', tabId: sender.tab.id }).catch(function () {});
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab.id }).catch(function () {});
      }
      return false;

    case 'agent-off':
      if (sender.tab && sender.tab.id) {
        agentTabs.delete(sender.tab.id);
        chrome.action.setIcon({
          path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
          tabId: sender.tab.id
        }).catch(function () {});
        chrome.action.setBadgeText({ text: '', tabId: sender.tab.id }).catch(function () {});
      }
      return false;
  }
});
