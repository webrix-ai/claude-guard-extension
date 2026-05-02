let currentTab = "events";
let currentPage = 0;
const PAGE_SIZE = 50;

document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  initEvents();
  initRules();
  loadStatus();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "new-event" && currentTab === "events") {
      loadEvents();
    }
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get("createRule") === "1") {
    const url = params.get("url") || "";
    const method = params.get("method") || "*";
    const pageUrl = params.get("pageUrl") || "";
    if (url) {
      setTimeout(() => openModalFromEvent(url, method, pageUrl), 100);
    }
  }
});

/* Navigation */
function initNavigation() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      currentTab = tab;
      document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
      document.getElementById(`tab-${tab}`).classList.add("active");

      if (tab === "events") loadEvents();
      if (tab === "rules") loadRules();
    });
  });
}

/* Status */
async function loadStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-status" });
    const el = document.getElementById("agentStatus");
    const text = document.getElementById("agentStatusText");

    if (response.agentTabCount > 0) {
      el.classList.add("active");
      text.textContent = `${response.agentTabCount} agent${response.agentTabCount > 1 ? "s" : ""} active`;
    } else {
      el.classList.remove("active");
      text.textContent = "No agents active";
    }
  } catch {
    // background not ready
  }
}

/* Events */
function initEvents() {
  document.getElementById("clearEvents").addEventListener("click", async () => {
    if (confirm("Clear all recorded events?")) {
      await chrome.runtime.sendMessage({ type: "clear-events" });
      loadEvents();
    }
  });

  document.getElementById("filterMethod").addEventListener("change", () => {
    currentPage = 0;
    loadEvents();
  });
  document.getElementById("filterAction").addEventListener("change", () => {
    currentPage = 0;
    loadEvents();
  });

  let filterTimeout;
  document.getElementById("filterUrl").addEventListener("input", () => {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => {
      currentPage = 0;
      loadEvents();
    }, 300);
  });

  loadEvents();
}

async function loadEvents() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "get-events",
      limit: 5000,
      offset: 0,
    });

    let events = response.events || [];

    const methodFilter = document.getElementById("filterMethod").value;
    const actionFilter = document.getElementById("filterAction").value;
    const urlFilter = document.getElementById("filterUrl").value.toLowerCase();

    if (methodFilter) events = events.filter((e) => e.method === methodFilter);
    if (actionFilter) events = events.filter((e) => e.action === actionFilter);
    if (urlFilter) events = events.filter((e) => e.url.toLowerCase().includes(urlFilter));

    const totalPages = Math.ceil(events.length / PAGE_SIZE) || 1;
    if (currentPage >= totalPages) currentPage = totalPages - 1;

    const pageEvents = events.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    renderEvents(pageEvents);
    renderPagination(totalPages, events.length);
  } catch {
    // background not ready
  }
}

function renderEvents(events) {
  const tbody = document.getElementById("eventsBody");

  if (events.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No events match your filters</td></tr>';
    return;
  }

  tbody.innerHTML = events
    .map((e) => {
      const time = formatTime(e.timestamp);
      const urlDisplay = truncateUrl(e.url);
      const pageDisplay = truncateUrl(e.pageUrl || e.tabUrl || "");
      const ruleDisplay = e.matchedRule
        ? `${e.matchedRule.method} ${e.matchedRule.pattern}`
        : "—";

      return `<tr>
        <td class="time-cell">${time}</td>
        <td><span class="method-badge method-${e.method}">${e.method}</span></td>
        <td class="url-cell" title="${escapeHtml(e.url)}">${escapeHtml(urlDisplay)}</td>
        <td class="page-cell" title="${escapeHtml(e.pageUrl || e.tabUrl || "")}">${escapeHtml(pageDisplay)}</td>
        <td><span class="action-badge action-${e.action}">${e.action}</span></td>
        <td class="rule-cell">${escapeHtml(ruleDisplay)}</td>
        <td class="action-cell">
          <button class="btn btn-sm btn-ghost create-rule-btn" data-url="${escapeAttr(e.url)}" data-method="${e.method}" data-page-url="${escapeAttr(e.pageUrl || e.tabUrl || "")}" title="Create rule from this event">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Rule
          </button>
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".create-rule-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModalFromEvent(btn.dataset.url, btn.dataset.method, btn.dataset.pageUrl);
    });
  });
}

function renderPagination(totalPages, totalItems) {
  const el = document.getElementById("pagination");

  if (totalPages <= 1) {
    el.innerHTML = totalItems > 0
      ? `<span style="color:var(--text-dim);font-size:12px">${totalItems} events</span>`
      : "";
    return;
  }

  let html = `<button ${currentPage === 0 ? "disabled" : ""} data-page="${currentPage - 1}">&laquo; Prev</button>`;

  const start = Math.max(0, currentPage - 2);
  const end = Math.min(totalPages, start + 5);

  for (let i = start; i < end; i++) {
    html += `<button class="${i === currentPage ? "active" : ""}" data-page="${i}">${i + 1}</button>`;
  }

  html += `<button ${currentPage >= totalPages - 1 ? "disabled" : ""} data-page="${currentPage + 1}">Next &raquo;</button>`;
  html += `<span style="color:var(--text-dim);font-size:12px;margin-left:8px">${totalItems} events</span>`;

  el.innerHTML = html;

  el.querySelectorAll("button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPage = parseInt(btn.dataset.page);
      loadEvents();
    });
  });
}

/* Rules */
function initRules() {
  document.getElementById("addRuleBtn").addEventListener("click", openModal);
  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("cancelRule").addEventListener("click", closeModal);

  document.getElementById("ruleModal").addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay")) closeModal();
  });

  document.getElementById("saveRule").addEventListener("click", saveNewRule);

  document.getElementById("resetDefaults").addEventListener("click", async () => {
    if (confirm("Reset all rules to defaults? Custom rules will be removed.")) {
      await chrome.runtime.sendMessage({
        type: "save-rules",
        rules: [
          { id: "default-get", pattern: "*", pagePattern: "*", method: "GET", action: "allow", type: "default", description: "Allow all GET requests" },
          { id: "default-head", pattern: "*", pagePattern: "*", method: "HEAD", action: "allow", type: "default", description: "Allow all HEAD requests" },
          { id: "default-options", pattern: "*", pagePattern: "*", method: "OPTIONS", action: "allow", type: "default", description: "Allow all OPTIONS requests" },
          { id: "default-post", pattern: "*", pagePattern: "*", method: "POST", action: "block", type: "default", description: "Block all POST requests" },
          { id: "default-put", pattern: "*", pagePattern: "*", method: "PUT", action: "block", type: "default", description: "Block all PUT requests" },
          { id: "default-patch", pattern: "*", pagePattern: "*", method: "PATCH", action: "block", type: "default", description: "Block all PATCH requests" },
          { id: "default-delete", pattern: "*", pagePattern: "*", method: "DELETE", action: "block", type: "default", description: "Block all DELETE requests" },
        ],
      });
      loadRules();
    }
  });

  loadRules();
}

async function loadRules() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-rules" });
    const rules = response.rules || [];

    const custom = rules.filter((r) => r.type === "custom");
    const defaults = rules.filter((r) => r.type === "default");

    renderRulesList("customRules", custom, true);
    renderRulesList("defaultRules", defaults, false);
  } catch {
    // background not ready
  }
}

function renderRulesList(containerId, rules, deletable) {
  const el = document.getElementById(containerId);

  if (rules.length === 0) {
    el.innerHTML = '<div class="rules-empty">No custom rules defined</div>';
    return;
  }

  el.innerHTML = rules
    .map((rule) => {
      const methodClass = `method-${rule.method === "*" ? "OPTIONS" : rule.method}`;
      const actionClass = rule.action === "allow" ? "action-allow" : "action-block";

      const pageLabel = rule.pagePattern && rule.pagePattern !== "*"
        ? `<span class="rule-page" title="Page: ${escapeHtml(rule.pagePattern)}">@ ${escapeHtml(rule.pagePattern)}</span>`
        : "";

      return `<div class="rule-card" data-rule-id="${rule.id}">
        <span class="rule-method ${methodClass}">${rule.method === "*" ? "ALL" : rule.method}</span>
        <span class="rule-pattern">${escapeHtml(rule.pattern)}</span>
        ${pageLabel}
        ${rule.description ? `<span class="rule-description">${escapeHtml(rule.description)}</span>` : ""}
        <span class="rule-action-badge ${actionClass}">${rule.action}</span>
        ${deletable ? `<button class="rule-delete" data-rule-id="${rule.id}" title="Delete rule">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>` : ""}
      </div>`;
    })
    .join("");

  if (deletable) {
    el.querySelectorAll(".rule-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ruleId = btn.dataset.ruleId;
        await chrome.runtime.sendMessage({ type: "delete-rule", ruleId });
        loadRules();
      });
    });
  }
}

function openModal() {
  document.getElementById("ruleModal").classList.add("visible");
  document.getElementById("rulePattern").value = "";
  document.getElementById("rulePagePattern").value = "*";
  document.getElementById("ruleMethod").value = "*";
  document.getElementById("ruleAction").value = "allow";
  document.getElementById("ruleDescription").value = "";
  document.getElementById("rulePattern").focus();
}

function openModalFromEvent(url, method, pageUrl) {
  const pattern = urlToPattern(url);
  const pagePattern = pageUrl ? urlToPagePattern(pageUrl) : "*";
  const action = ["GET", "HEAD", "OPTIONS"].includes(method) ? "block" : "allow";

  document.getElementById("ruleModal").classList.add("visible");
  document.getElementById("rulePattern").value = pattern;
  document.getElementById("rulePagePattern").value = pagePattern;
  document.getElementById("ruleMethod").value = method;
  document.getElementById("ruleAction").value = action;

  let host = "";
  try { host = new URL(url).host; } catch {}
  const verb = action === "allow" ? "Allow" : "Block";
  document.getElementById("ruleDescription").value = `${verb} ${method} on ${host}`;
  document.getElementById("rulePattern").focus();

  switchToTab("rules");
}

function urlToPagePattern(url) {
  try {
    const u = new URL(url);
    return `*${u.host}*`;
  } catch {
    return "*";
  }
}

function switchToTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
  document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add("active");
  document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
  document.getElementById(`tab-${tab}`).classList.add("active");
}

function urlToPattern(url) {
  try {
    const u = new URL(url);
    const pathParts = u.pathname.split("/").filter(Boolean);

    const patternParts = pathParts.map((part) => {
      if (/^[0-9a-f]{8,}$/i.test(part) || /^\d+$/.test(part)) return "*";
      if (part.includes(".") && part.length > 20) return "*";
      return part;
    });

    return `${u.protocol}//${u.host}/${patternParts.join("/")}*`;
  } catch {
    return url;
  }
}

function closeModal() {
  document.getElementById("ruleModal").classList.remove("visible");
}

async function saveNewRule() {
  const pattern = document.getElementById("rulePattern").value.trim();
  const pagePattern = document.getElementById("rulePagePattern").value.trim() || "*";
  const method = document.getElementById("ruleMethod").value;
  const action = document.getElementById("ruleAction").value;
  const description = document.getElementById("ruleDescription").value.trim();

  if (!pattern) {
    document.getElementById("rulePattern").focus();
    return;
  }

  await chrome.runtime.sendMessage({
    type: "add-rule",
    rule: { pattern, pagePattern, method, action, description },
  });

  closeModal();
  loadRules();
}

/* Helpers */
function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  if (isToday) return time;

  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function truncateUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    if (path.length > 60) return u.host + path.slice(0, 57) + "...";
    return u.host + path;
  } catch {
    return url.length > 70 ? url.slice(0, 67) + "..." : url;
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
