importScripts("rules.js", "storage.js");

const GRACE_PERIOD_MS = 3 * 60 * 1000;
const DNR_RULE_ID_START = 10001;

const agentTabs = new Map();
const removalTimers = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RULES);
  if (!data[STORAGE_KEYS.RULES]) {
    await saveRules([...DEFAULT_RULES]);
  }
  await syncDnrRules();
  console.log("[Guardian] Extension installed, default rules initialized");
});

// --- Logging via webRequest (observational, not blocking) ---

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (
      details.type === "main_frame" ||
      details.type === "sub_frame" ||
      details.tabId < 0
    ) {
      return;
    }
    handleRequest(details);
  },
  { urls: ["https://*/*", "http://*/*"] }
);

async function handleRequest(details) {
  const { tabId, url, method, type, requestId } = details;
  if (!agentTabs.has(tabId)) return;

  const tabInfo = agentTabs.get(tabId);
  const pageUrl = tabInfo?.url || "unknown";
  const rules = await getRules();
  const result = evaluateRequest(url, method, rules, pageUrl);

  const event = {
    url,
    method,
    resourceType: type,
    tabId,
    requestId,
    action: result.action,
    matchedRule: result.rule
      ? { id: result.rule.id, pattern: result.rule.pattern, method: result.rule.method, pagePattern: result.rule.pagePattern }
      : null,
    pageUrl,
  };

  await addEvent(event);

  chrome.runtime.sendMessage({
    type: "new-event",
    event,
  }).catch(() => {});

  if (result.action === "block") {
    console.log(`[Guardian] BLOCKED ${method} ${url} from page ${pageUrl} (rule: ${result.rule?.id || "default"})`);
  }
}

// --- Actual blocking via declarativeNetRequest ---

async function syncDnrRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map((r) => r.id);

  const agentTabIds = Array.from(agentTabs.keys());

  if (agentTabIds.length === 0) {
    if (removeIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
    }
    console.log("[Guardian] DNR: no agent tabs, all rules cleared");
    return;
  }

  const userRules = await getRules();
  const dnrRules = [];
  let ruleId = DNR_RULE_ID_START;

  for (const rule of userRules) {
    const dnr = toDnrRule(rule, ruleId, agentTabIds);
    if (dnr) {
      dnrRules.push(dnr);
      ruleId++;
    }
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: dnrRules,
  });

  console.log(`[Guardian] DNR: synced ${dnrRules.length} rules for ${agentTabIds.length} agent tab(s)`);
}

function toDnrRule(rule, id, tabIds) {
  const condition = {
    tabIds,
    excludedResourceTypes: ["main_frame", "sub_frame"],
  };

  if (rule.pattern && rule.pattern !== "*") {
    condition.urlFilter = rule.pattern;
  } else {
    condition.urlFilter = "*";
  }

  if (rule.method && rule.method !== "*") {
    condition.requestMethods = [rule.method.toLowerCase()];
  }

  if (rule.pagePattern && rule.pagePattern !== "*") {
    const domain = extractDomainFromPattern(rule.pagePattern);
    if (domain) {
      condition.initiatorDomains = [domain];
    }
  }

  const priority = rule.type === "custom" ? 2 : 1;

  return {
    id,
    priority,
    action: { type: rule.action === "allow" ? "allow" : "block" },
    condition,
  };
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "agent-detected") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      if (removalTimers.has(tabId)) {
        clearTimeout(removalTimers.get(tabId));
        removalTimers.delete(tabId);
        console.log(`[Guardian] Agent re-detected on tab ${tabId}, cancelled grace period`);
      }
      agentTabs.set(tabId, {
        url: sender.tab.url,
        detectedAt: Date.now(),
      });
      setAgentTab(tabId, true);
      updateBadge(tabId, true);
      syncDnrRules();
      console.log(`[Guardian] Agent detected on tab ${tabId}: ${sender.tab.url}`);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "agent-removed") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      scheduleRemoval(tabId);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "get-events") {
    getEvents(message.limit || 100, message.offset || 0).then((events) => {
      sendResponse({ events });
    });
    return true;
  }

  if (message.type === "get-rules") {
    getRules().then((rules) => {
      sendResponse({ rules });
    });
    return true;
  }

  if (message.type === "save-rules") {
    saveRules(message.rules).then(() => {
      syncDnrRules();
      broadcastRulesChanged();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "add-rule") {
    getRules().then((rules) => {
      const newRule = {
        ...message.rule,
        id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "custom",
      };
      rules.unshift(newRule);
      return saveRules(rules).then(() => {
        syncDnrRules();
        broadcastRulesChanged();
        sendResponse({ ok: true, rule: newRule });
      });
    });
    return true;
  }

  if (message.type === "delete-rule") {
    getRules().then((rules) => {
      const filtered = rules.filter((r) => r.id !== message.ruleId);
      return saveRules(filtered).then(() => {
        syncDnrRules();
        broadcastRulesChanged();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "clear-events") {
    clearEvents().then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "get-status") {
    const activeTabs = Array.from(agentTabs.entries()).map(([id, info]) => ({
      tabId: id,
      ...info,
      inGracePeriod: removalTimers.has(id),
    }));
    sendResponse({ activeTabs, agentTabCount: activeTabs.length });
    return;
  }
});

async function broadcastRulesChanged() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (agentTabs.has(tab.id)) {
      chrome.tabs.sendMessage(tab.id, { type: "rules-changed" }).catch(() => {});
    }
  }
}

// --- Grace period for agent removal ---

function scheduleRemoval(tabId) {
  if (removalTimers.has(tabId)) return;

  const info = agentTabs.get(tabId);
  console.log(`[Guardian] Agent div removed on tab ${tabId}, grace period ${GRACE_PERIOD_MS / 1000}s started`);

  if (info) {
    info.gracePeriodStart = Date.now();
  }

  const timer = setTimeout(() => {
    removalTimers.delete(tabId);
    agentTabs.delete(tabId);
    setAgentTab(tabId, false);
    updateBadge(tabId, false);
    syncDnrRules();
    chrome.tabs.sendMessage(tabId, { type: "force-deactivate" }).catch(() => {});
    console.log(`[Guardian] Grace period expired, tab ${tabId} no longer monitored`);
  }, GRACE_PERIOD_MS);

  removalTimers.set(tabId, timer);
}

function cancelRemoval(tabId) {
  if (removalTimers.has(tabId)) {
    clearTimeout(removalTimers.get(tabId));
    removalTimers.delete(tabId);
  }
}

// --- Tab lifecycle ---

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelRemoval(tabId);
  if (agentTabs.has(tabId)) {
    agentTabs.delete(tabId);
    setAgentTab(tabId, false);
    syncDnrRules();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && agentTabs.has(tabId)) {
    cancelRemoval(tabId);
    agentTabs.delete(tabId);
    setAgentTab(tabId, false);
    updateBadge(tabId, false);
    syncDnrRules();
  }
});

function updateBadge(tabId, isAgent) {
  if (isAgent) {
    chrome.action.setIcon({
      path: { "16": "icons/icon16-active.png", "48": "icons/icon48-active.png", "128": "icons/icon128-active.png" },
      tabId,
    });
    chrome.action.setBadgeText({ text: "ON", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
    chrome.action.setTitle({ title: "Webrix Guard — ACTIVE (monitoring agent)", tabId });
  } else {
    chrome.action.setIcon({
      path: { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
      tabId,
    });
    chrome.action.setBadgeText({ text: "", tabId });
    chrome.action.setTitle({ title: "Webrix Guard", tabId });
  }
}
