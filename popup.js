document.addEventListener("DOMContentLoaded", () => {
  loadStatus();
  loadEvents();

  document.getElementById("openDashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "new-event") {
      loadEvents();
    }
  });
});

async function loadStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-status" });
    const bar = document.getElementById("statusBar");
    const text = document.getElementById("statusText");

    if (response.agentTabCount > 0) {
      bar.classList.add("active");
      text.textContent = `Monitoring ${response.agentTabCount} agent tab${response.agentTabCount > 1 ? "s" : ""}`;
    } else {
      bar.classList.remove("active");
      text.textContent = "No active agent tabs detected";
    }
  } catch {
    document.getElementById("statusText").textContent = "Extension ready";
  }
}

async function loadEvents() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get-events",
      limit: 50,
    });

    const events = response.events || [];
    const list = document.getElementById("eventsList");

    let blocked = 0;
    let allowed = 0;
    events.forEach((e) => {
      if (e.action === "block") blocked++;
      else allowed++;
    });

    document.getElementById("blockedCount").textContent = blocked;
    document.getElementById("allowedCount").textContent = allowed;
    document.getElementById("totalCount").textContent = events.length;

    if (events.length === 0) {
      list.innerHTML = '<div class="empty-state">No events yet</div>';
      return;
    }

    const recent = events.slice(0, 15);
    list.innerHTML = recent
      .map((e) => {
        const urlObj = tryParseUrl(e.url);
        const short = urlObj
          ? urlObj.pathname + urlObj.search
          : e.url;
        return `
        <div class="event-item">
          <span class="event-method method-${e.method}">${e.method}</span>
          <span class="event-url" title="${escapeHtml(e.url)}">${escapeHtml(short)}</span>
          <span class="event-action action-${e.action}">${e.action}</span>
          <button class="event-rule-btn" data-url="${escapeAttr(e.url)}" data-method="${e.method}" data-page-url="${escapeAttr(e.pageUrl || e.tabUrl || "")}" title="Create rule from this event">+</button>
        </div>`;
      })
      .join("");

    list.querySelectorAll(".event-rule-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const url = btn.dataset.url;
        const method = btn.dataset.method;
        const pageUrl = btn.dataset.pageUrl;
        chrome.tabs.create({
          url: chrome.runtime.getURL(`dashboard.html?createRule=1&url=${encodeURIComponent(url)}&method=${method}&pageUrl=${encodeURIComponent(pageUrl)}`),
        });
      });
    });
  } catch {
    // popup may open before background is ready
  }
}

function tryParseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
