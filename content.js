let agentDetected = false;

function checkForAgent() {
  const el = document.getElementById("claude-agent-glow-border");
  const found = el !== null;

  if (found && !agentDetected) {
    agentDetected = true;
    chrome.runtime.sendMessage({ type: "agent-detected" }).catch(() => {});
    activateInterceptor();
  } else if (!found && agentDetected) {
    agentDetected = false;
    chrome.runtime.sendMessage({ type: "agent-removed" }).catch(() => {});
  }
}

async function activateInterceptor() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-rules" });
    const rules = response.rules || [];
    window.postMessage({
      source: "webrix-guard-content",
      type: "activate",
      rules,
    }, "*");
  } catch {
    window.postMessage({
      source: "webrix-guard-content",
      type: "activate",
      rules: [],
    }, "*");
  }
}

function deactivateInterceptor() {
  window.postMessage({
    source: "webrix-guard-content",
    type: "deactivate",
  }, "*");
}

async function refreshRules() {
  if (!agentDetected) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-rules" });
    window.postMessage({
      source: "webrix-guard-content",
      type: "update-rules",
      rules: response.rules || [],
    }, "*");
  } catch {}
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "rules-changed") {
    refreshRules();
  }
  if (msg.type === "force-deactivate") {
    deactivateInterceptor();
  }
});

window.addEventListener("message", (e) => {
  if (!e.data || e.data.source !== "webrix-guard-interceptor") return;

  if (e.data.type === "request-event") {
    chrome.runtime.sendMessage({
      type: "intercepted-request",
      url: e.data.url,
      method: e.data.method,
      action: e.data.action,
      pageUrl: e.data.pageUrl,
      matchedRule: e.data.matchedRule || null,
    }).catch(() => {});
  }
});

function startObserving() {
  checkForAgent();

  const observer = new MutationObserver(() => {
    checkForAgent();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id"],
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserving);
} else {
  startObserving();
}
