const STORAGE_KEYS = {
  RULES: "guardian_rules",
  EVENTS: "guardian_events",
  AGENT_TABS: "guardian_agent_tabs",
  SETTINGS: "guardian_settings",
};

const MAX_EVENTS = 5000;

async function getRules() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.RULES);
  return data[STORAGE_KEYS.RULES] || [...DEFAULT_RULES];
}

async function saveRules(rules) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RULES]: rules });
}

async function addEvent(event) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.EVENTS);
  const events = data[STORAGE_KEYS.EVENTS] || [];

  events.unshift({
    ...event,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  });

  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.EVENTS]: events });
  return events[0];
}

async function getEvents(limit = 100, offset = 0) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.EVENTS);
  const events = data[STORAGE_KEYS.EVENTS] || [];
  return events.slice(offset, offset + limit);
}

async function clearEvents() {
  await chrome.storage.local.set({ [STORAGE_KEYS.EVENTS]: [] });
}

async function getAgentTabs() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.AGENT_TABS);
  return data[STORAGE_KEYS.AGENT_TABS] || {};
}

async function setAgentTab(tabId, isAgent) {
  const tabs = await getAgentTabs();
  if (isAgent) {
    tabs[tabId] = { detectedAt: Date.now() };
  } else {
    delete tabs[tabId];
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.AGENT_TABS]: tabs });
}

if (typeof globalThis !== "undefined") {
  globalThis.STORAGE_KEYS = STORAGE_KEYS;
  globalThis.getRules = getRules;
  globalThis.saveRules = saveRules;
  globalThis.addEvent = addEvent;
  globalThis.getEvents = getEvents;
  globalThis.clearEvents = clearEvents;
  globalThis.getAgentTabs = getAgentTabs;
  globalThis.setAgentTab = setAgentTab;
}
