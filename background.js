var agentTabs = new Set();
var approvePort = null;
var approveWindowId = null;
var pendingApprovals = new Map();

var DEFAULT_STATE = {
  allowList: [],
  blockList: [],
  autoMode: true,
  stats: { blocked: 0, allowed: 0 },
  log: []
};

function getManagedRules() {
  return chrome.storage.managed.get(['allowList', 'blockList']).then(function (managed) {
    return {
      allowList: (managed.allowList || []).map(function (r) { return Object.assign({}, r, { managed: true }); }),
      blockList: (managed.blockList || []).map(function (r) { return Object.assign({}, r, { managed: true }); })
    };
  }).catch(function () {
    return { allowList: [], blockList: [] };
  });
}

function getState() {
  return Promise.all([
    chrome.storage.local.get('cg'),
    getManagedRules()
  ]).then(function (results) {
    var local = Object.assign({}, DEFAULT_STATE, results[0].cg);
    var managed = results[1];
    local.allowList = managed.allowList.concat(local.allowList);
    local.blockList = managed.blockList.concat(local.blockList);
    return local;
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

// --------------- Approval Window ---------------

function openApproveWindow(request) {
  pendingApprovals.set(request.id, request);

  if (approvePort) {
    approvePort.postMessage({ type: 'new-request', request: request });
    if (approveWindowId != null) {
      chrome.windows.update(approveWindowId, { focused: true }).catch(function () {});
    }
    return;
  }

  var W = 480, H = 420;
  chrome.windows.getLastFocused().then(function (parent) {
    var sidePanelOffset = agentTabs.has(request.tabId) ? 420 : 0;
    var left = Math.max(0, (parent.left + parent.width) - W - 24 - sidePanelOffset);
    var top = Math.max(0, (parent.top + parent.height) - H - 48);
    return chrome.windows.create({
      url: 'approve.html',
      type: 'popup',
      width: W,
      height: H,
      left: left,
      top: top,
      focused: true
    });
  }).then(function (win) {
    approveWindowId = win.id;
  }).catch(function () {});
}

function denyAllPending() {
  pendingApprovals.forEach(function (req, id) {
    chrome.tabs.sendMessage(req.tabId, {
      type: 'approval-decision', id: id, action: 'deny',
      method: req.method, url: req.url
    }).catch(function () {});
  });
  pendingApprovals.clear();
}

chrome.windows.onRemoved.addListener(function (windowId) {
  if (windowId === approveWindowId) {
    approveWindowId = null;
    approvePort = null;
    denyAllPending();
  }
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'approve') return;

  approvePort = port;

  port.onMessage.addListener(function (msg) {
    if (msg.type === 'ready') {
      port.postMessage({
        type: 'pending-requests',
        requests: Array.from(pendingApprovals.values())
      });
    }

    if (msg.type === 'decision') {
      var req = pendingApprovals.get(msg.id);
      if (!req) return;
      pendingApprovals.delete(msg.id);

      chrome.tabs.sendMessage(req.tabId, {
        type: 'approval-decision', id: msg.id, action: msg.action,
        method: req.method, url: req.url
      }).catch(function () {});

      if (msg.action === 'allow-always') {
        try {
          var hostname = new URL(req.url).hostname;
          getState().then(function (s) {
            var pattern = '*://' + hostname + '/*';
            var exists = s.allowList.some(function (r) { return r.pattern === pattern; });
            if (!exists) {
              s.allowList.push({ pattern: pattern, method: '*' });
              setState(s).then(function () {
                broadcast({
                  type: 'rules-updated',
                  allowList: s.allowList,
                  blockList: s.blockList,
                  autoMode: s.autoMode
                });
              });
            }
          });
        } catch (e) {}
      }

      if (pendingApprovals.size === 0 && approveWindowId != null) {
        chrome.windows.remove(approveWindowId).catch(function () {});
        approveWindowId = null;
      }
    }
  });

  port.onDisconnect.addListener(function () {
    approvePort = null;
    approveWindowId = null;
    denyAllPending();
  });
});

// --------------- Main Message Handler ---------------

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  switch (msg.type) {

    case 'get-state':
      getState().then(reply);
      return true;

    case 'get-tab-status':
      reply({ agentActive: agentTabs.has(msg.tabId) });
      return false;

    case 'request-blocked':
      if (sender.tab && sender.tab.id) {
        openApproveWindow({
          id: msg.id,
          method: msg.method,
          url: msg.url,
          reason: msg.reason,
          headers: msg.headers || null,
          body: msg.body || null,
          tabId: sender.tab.id
        });
      }
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
