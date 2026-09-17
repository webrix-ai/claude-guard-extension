var agentTabs = new Set();
var agentGroups = new Map(); // groupId -> main agent tabId

function activateTab(tabId) {
  agentTabs.add(tabId);
  chrome.action.setIcon({
    path: { 16: 'icons/icon16-active.png', 48: 'icons/icon48-active.png', 128: 'icons/icon128-active.png' },
    tabId: tabId
  }).catch(function () {});
  chrome.action.setBadgeText({ text: 'ON', tabId: tabId }).catch(function () {});
  chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: tabId }).catch(function () {});
}

function deactivateTab(tabId) {
  agentTabs.delete(tabId);
  chrome.action.setIcon({
    path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    tabId: tabId
  }).catch(function () {});
  chrome.action.setBadgeText({ text: '', tabId: tabId }).catch(function () {});
}

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.groupId !== undefined && changeInfo.groupId >= 0 && agentGroups.has(changeInfo.groupId)) {
    activateTab(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'group-agent-on' }).catch(function () {});
  }
});
var approvePort = null;
var approveWindowId = null;
var pendingApprovals = new Map();

// Rule lists that can be managed by the user (popup) and/or by policy (MDM).
var RULE_LISTS = { allow: 'allowList', block: 'blockList', redact: 'redactList' };
var LIST_NAMES = Object.keys(RULE_LISTS).map(function (k) { return RULE_LISTS[k]; });

var DEFAULT_MIN_CERTAINTY = 6;

var DEFAULT_STATE = {
  allowList: [],
  blockList: [],
  redactList: [],
  // Built-in guard overrides: { [guardId]: { enabled, disabledChecks } }.
  // Guards absent here use their catalog default.
  guards: {},
  guardMinCertainty: DEFAULT_MIN_CERTAINTY,
  autoMode: true,
  redactEnabled: true,
  stats: { blocked: 0, allowed: 0, redacted: 0 },
  log: []
};

var MANAGED_KEYS = LIST_NAMES.concat(['guards', 'guardMinCertainty']);

function tagManaged(rules) {
  return (rules || []).map(function (r) { return Object.assign({}, r, { managed: true }); });
}

function emptyManaged() {
  var out = { guards: null, guardMinCertainty: null };
  LIST_NAMES.forEach(function (name) { out[name] = []; });
  return out;
}

function getManagedRules() {
  return chrome.storage.managed.get(MANAGED_KEYS).then(function (managed) {
    var out = emptyManaged();
    LIST_NAMES.forEach(function (name) { out[name] = tagManaged(managed[name]); });
    if (managed.guards && typeof managed.guards === 'object') out.guards = managed.guards;
    if (typeof managed.guardMinCertainty === 'number') out.guardMinCertainty = managed.guardMinCertainty;
    return out;
  }).catch(emptyManaged);
}

function clampCertainty(v) {
  var n = Number(v);
  if (!isFinite(n)) return DEFAULT_MIN_CERTAINTY;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function getState() {
  return Promise.all([
    chrome.storage.local.get('cg'),
    getManagedRules()
  ]).then(function (results) {
    var local = Object.assign({}, DEFAULT_STATE, results[0].cg);
    // Older installs may lack newer fields — fill them in without clobbering counts.
    local.stats = Object.assign({}, DEFAULT_STATE.stats, local.stats);
    local.guards = Object.assign({}, local.guards);
    local.guardMinCertainty = clampCertainty(local.guardMinCertainty);
    var managed = results[1];
    LIST_NAMES.forEach(function (name) {
      local[name] = managed[name].concat(local[name] || []);
    });
    // Policy wins over local guard settings and is marked read-only.
    if (managed.guards) {
      Object.keys(managed.guards).forEach(function (id) {
        var m = managed.guards[id];
        if (!m || typeof m !== 'object') return;
        local.guards[id] = Object.assign({}, m, { managed: true });
      });
    }
    if (managed.guardMinCertainty !== null) {
      local.guardMinCertainty = clampCertainty(managed.guardMinCertainty);
      local.guardMinCertaintyManaged = true;
    }
    return local;
  });
}

function setState(state) {
  // Managed (MDM/policy) values live in chrome.storage.managed only —
  // strip them so they are never persisted into local storage.
  var local = Object.assign({}, state);
  LIST_NAMES.forEach(function (name) {
    local[name] = (state[name] || []).filter(function (r) { return !r.managed; });
  });
  local.guards = {};
  Object.keys(state.guards || {}).forEach(function (id) {
    if (!state.guards[id] || state.guards[id].managed) return;
    local.guards[id] = state.guards[id];
  });
  if (state.guardMinCertaintyManaged) delete local.guardMinCertainty;
  delete local.guardMinCertaintyManaged;
  return chrome.storage.local.set({ cg: local });
}

function rulesPayload(state) {
  return {
    type: 'rules-updated',
    allowList: state.allowList,
    blockList: state.blockList,
    redactList: state.redactList,
    guards: state.guards,
    guardMinCertainty: state.guardMinCertainty,
    autoMode: state.autoMode,
    redactEnabled: state.redactEnabled
  };
}

function broadcast(msg) {
  chrome.tabs.query({}).then(function (tabs) {
    tabs.forEach(function (t) {
      chrome.tabs.sendMessage(t.id, msg).catch(function () {});
    });
  });
}

function sameRule(a, b) {
  if (!a || !b) return false;
  if (a.kind || b.kind) {
    return a.kind === b.kind && a.value === b.value && (a.scope || '*') === (b.scope || '*');
  }
  return a.pattern === b.pattern && (a.method || '*') === (b.method || '*');
}

// Live policy pushes: when the managed area changes, re-broadcast merged rules
// so active tabs pick them up without a reload.
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'managed') return;
    getState().then(function (s) { broadcast(rulesPayload(s)); });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get('cg').then(function (data) {
    if (!data.cg) chrome.storage.local.set({ cg: DEFAULT_STATE });
  });
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  agentTabs.delete(tabId);
  agentGroups.forEach(function (mainId, groupId) {
    if (mainId === tabId) agentGroups.delete(groupId);
  });
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
                broadcast(rulesPayload(s));
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
        s.autoMode = !!msg.enabled;
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
          reply({ ok: true });
        });
      });
      return true;

    case 'set-redact-enabled':
      getState().then(function (s) {
        s.redactEnabled = !!msg.enabled;
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
          reply({ ok: true });
        });
      });
      return true;

    case 'set-guard':
      // { guardId, enabled?: boolean, disabledChecks?: string[] } — partial update.
      getState().then(function (s) {
        if (typeof msg.guardId !== 'string' || !msg.guardId) {
          reply({ ok: false, error: 'Invalid guard id' });
          return;
        }
        var current = s.guards[msg.guardId] || {};
        if (current.managed) {
          reply({ ok: false, error: 'Managed guards cannot be changed' });
          return;
        }
        var next = Object.assign({}, current);
        if (typeof msg.enabled === 'boolean') next.enabled = msg.enabled;
        if (Array.isArray(msg.disabledChecks)) {
          next.disabledChecks = msg.disabledChecks.filter(function (id) { return typeof id === 'string'; });
        }
        s.guards[msg.guardId] = next;
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
          reply({ ok: true });
        });
      });
      return true;

    case 'set-guard-check':
      // Toggle a single check within a guard.
      getState().then(function (s) {
        if (typeof msg.guardId !== 'string' || typeof msg.checkId !== 'string') {
          reply({ ok: false, error: 'Invalid guard or check id' });
          return;
        }
        var g = s.guards[msg.guardId] || {};
        if (g.managed) {
          reply({ ok: false, error: 'Managed guards cannot be changed' });
          return;
        }
        var disabled = (g.disabledChecks || []).filter(function (id) { return id !== msg.checkId; });
        if (msg.disabled) disabled.push(msg.checkId);
        s.guards[msg.guardId] = Object.assign({}, g, { disabledChecks: disabled });
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
          reply({ ok: true });
        });
      });
      return true;

    case 'set-guard-min-certainty':
      getState().then(function (s) {
        if (s.guardMinCertaintyManaged) {
          reply({ ok: false, error: 'Minimum certainty is managed by policy' });
          return;
        }
        s.guardMinCertainty = clampCertainty(msg.value);
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
          reply({ ok: true, value: s.guardMinCertainty });
        });
      });
      return true;

    case 'add-rule':
      getState().then(function (s) {
        var list = RULE_LISTS[msg.list];
        if (!list || !msg.rule || typeof msg.rule !== 'object') {
          reply({ ok: false, error: 'Invalid rule' });
          return;
        }
        var rule = Object.assign({}, msg.rule);
        delete rule.managed; // only policy may mark rules as managed
        var exists = s[list].some(function (r) { return sameRule(r, rule); });
        if (!exists) s[list].push(rule);
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
          reply({ ok: true, added: !exists });
        });
      });
      return true;

    case 'remove-rule':
      getState().then(function (s) {
        var list = RULE_LISTS[msg.list];
        var index = msg.index;
        if (!list || typeof index !== 'number' || index < 0 || index >= s[list].length) {
          reply({ ok: false, error: 'Invalid rule index' });
          return;
        }
        if (s[list][index].managed) {
          reply({ ok: false, error: 'Managed rules cannot be removed' });
          return;
        }
        s[list].splice(index, 1);
        return setState(s).then(function () {
          broadcast(rulesPayload(s));
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

    case 'redact-event':
      getState().then(function (s) {
        var n = Number(msg.count) || 0;
        if (n > 0) s.stats.redacted += n;
        return setState(s).then(function () { reply({ ok: true }); });
      });
      return true;

    case 'clear-stats':
      getState().then(function (s) {
        s.stats = { blocked: 0, allowed: 0, redacted: 0 };
        s.log = [];
        return setState(s).then(function () { reply({ ok: true }); });
      });
      return true;

    case 'agent-on':
      if (sender.tab && sender.tab.id) {
        var mainTabId = sender.tab.id;
        activateTab(mainTabId);
        var groupId = sender.tab.groupId;
        if (groupId !== undefined && groupId >= 0) {
          agentGroups.set(groupId, mainTabId);
          chrome.tabs.query({ groupId: groupId }).then(function (tabs) {
            tabs.forEach(function (t) {
              if (t.id !== mainTabId) {
                activateTab(t.id);
                chrome.tabs.sendMessage(t.id, { type: 'group-agent-on' }).catch(function () {});
              }
            });
          }).catch(function () {});
        }
      }
      return false;

    case 'agent-off':
      if (sender.tab && sender.tab.id) {
        var offTabId = sender.tab.id;
        var offGroupId = sender.tab.groupId;
        if (offGroupId !== undefined && offGroupId >= 0 && agentGroups.get(offGroupId) === offTabId) {
          agentGroups.delete(offGroupId);
          chrome.tabs.query({ groupId: offGroupId }).then(function (tabs) {
            tabs.forEach(function (t) {
              if (t.id !== offTabId) {
                deactivateTab(t.id);
                chrome.tabs.sendMessage(t.id, { type: 'group-agent-off' }).catch(function () {});
              }
            });
          }).catch(function () {});
        }
        deactivateTab(offTabId);
      }
      return false;

    case 'check-agent-status':
      reply({ agentActive: sender.tab ? agentTabs.has(sender.tab.id) : false });
      return false;
  }
});
