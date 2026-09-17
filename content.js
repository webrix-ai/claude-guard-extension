(function () {
  'use strict';

  if (window.self !== window.top) return;

  var agentActive = false;
  var pendingCount = 0;
  var bannerEl = null;
  var toastContainer = null;
  var originalTitle = '';

  // Redaction engine (lib/redactor.js is loaded before this script).
  var Redactor = (typeof self !== 'undefined' && self.ClaudeGuardRedactor) || null;
  var redactor = Redactor ? Redactor.createRedactor(document) : null;
  var redactPending = 0;
  var redactTimer = null;

  if (redactor) {
    redactor.onRedact(function (res) {
      redactPending += res.text + res.elements;
      if (redactTimer) return;
      // Batch bursts of DOM mutations into one report + one toast.
      redactTimer = setTimeout(flushRedactReport, 400);
    });
  }

  function flushRedactReport() {
    redactTimer = null;
    var n = redactPending;
    redactPending = 0;
    if (n <= 0) return;
    console.info('[Claude Guard] Redacted ' + n + ' sensitive item' + (n === 1 ? '' : 's') + ' from this page.');
    pushToast('\uD83D\uDEE1\uFE0F [Claude Guard] Redacted ' + n + ' sensitive item' + (n === 1 ? '' : 's') + ' from this page \u2014 the information is intentionally unavailable.', 'redacted', 8000);
    chrome.runtime.sendMessage({ type: 'redact-event', count: n }).catch(function () {});
  }

  /**
   * (Re)start redaction from a state/broadcast payload:
   * { redactEnabled, redactList, guards, guardMinCertainty }.
   */
  function applyRedaction(cfg) {
    if (!redactor) return;
    cfg = cfg || {};
    if (!agentActive || cfg.redactEnabled === false) {
      redactor.stop();
      return;
    }
    redactor.start({
      rules: cfg.redactList || [],
      guards: cfg.guards || {},
      minCertainty: cfg.guardMinCertainty
    }, location.href);
    var errors = redactor.errors();
    if (errors.length) console.warn('[Claude Guard] Skipped ' + errors.length + ' invalid redaction rule(s):', errors);
  }

  // If this tab is a group peer of an active agent tab, activate immediately
  chrome.runtime.sendMessage({ type: 'check-agent-status' }).then(function (resp) {
    if (resp && resp.agentActive && !agentActive) {
      agentActive = true;
      activate();
    }
  }).catch(function () {});

  // --------------- Agent Detection ---------------

  function checkAgent() {
    var found = document.getElementById('claude-agent-glow-border') !== null;
    if (found && !agentActive) {
      agentActive = true;
      chrome.runtime.sendMessage({ type: 'agent-on' }).catch(function () {});
      activate();
    } else if (!found && agentActive) {
      agentActive = false;
      chrome.runtime.sendMessage({ type: 'agent-off' }).catch(function () {});
      deactivate();
    }
  }

  function activate() {
    chrome.runtime.sendMessage({ type: 'get-state' }).then(function (state) {
      state = state || {};
      window.postMessage({
        source: 'cg-cs',
        type: 'activate',
        allow: state.allowList || [],
        block: state.blockList || [],
        auto: state.autoMode !== false
      }, '*');
      applyRedaction(state);
    }).catch(function () {
      window.postMessage({ source: 'cg-cs', type: 'activate', allow: [], block: [], auto: true }, '*');
    });
  }

  function deactivate() {
    window.postMessage({ source: 'cg-cs', type: 'deactivate' }, '*');
    // Redacted content is not restored — it was removed on purpose.
    if (redactor) redactor.stop();
  }

  // --------------- Waiting Banner (visible to Claude) ---------------

  function showBanner() {
    pendingCount++;
    if (!bannerEl) {
      originalTitle = document.title;
      bannerEl = document.createElement('div');
      bannerEl.id = 'claude-guard-waiting';
      bannerEl.setAttribute('role', 'alert');
      bannerEl.setAttribute('aria-live', 'assertive');
      bannerEl.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
        'background:#fef3c7', 'border-bottom:2px solid #f59e0b',
        'color:#92400e', 'font:600 14px/1 -apple-system,system-ui,sans-serif',
        'padding:10px 16px', 'text-align:center',
        'box-shadow:0 2px 8px rgba(0,0,0,0.1)',
        'pointer-events:none'
      ].join(';');
      document.documentElement.appendChild(bannerEl);
    }
    updateBannerText();
  }

  function hideBanner() {
    pendingCount = Math.max(0, pendingCount - 1);
    if (pendingCount === 0 && bannerEl) {
      bannerEl.remove();
      bannerEl = null;
      document.title = originalTitle;
    } else {
      updateBannerText();
    }
  }

  function updateBannerText() {
    if (!bannerEl) return;
    var s = pendingCount === 1 ? '' : 's';
    var msg = '\u23F3 Claude Guard: Waiting for human approval (' + pendingCount + ' request' + s + ' pending). Do NOT proceed until approved.';
    bannerEl.textContent = msg;
    document.title = '\u26A0\uFE0F BLOCKED \u2014 ' + msg;
  }

  // --------------- Per-request toasts (visible to Claude) ---------------

  function ensureToastContainer() {
    if (toastContainer) return toastContainer;
    toastContainer = document.createElement('div');
    toastContainer.id = 'claude-guard-toasts';
    toastContainer.setAttribute('aria-live', 'polite');
    toastContainer.style.cssText = [
      'position:fixed', 'bottom:16px', 'left:16px', 'z-index:2147483646',
      'display:flex', 'flex-direction:column', 'gap:6px',
      'max-width:420px', 'pointer-events:none',
      'font:500 12px/1.4 -apple-system,system-ui,sans-serif'
    ].join(';');
    document.documentElement.appendChild(toastContainer);
    return toastContainer;
  }

  var TOAST_TONES = {
    blocked:  { bg: '#fef2f2', border: '#fca5a5', color: '#991b1b' },
    denied:   { bg: '#fef2f2', border: '#fca5a5', color: '#991b1b' },
    approved: { bg: '#f0fdf4', border: '#86efac', color: '#166534' },
    redacted: { bg: '#eef2ff', border: '#a5b4fc', color: '#3730a3' }
  };

  function pushToast(text, tone, ttl) {
    var container = ensureToastContainer();
    var t = TOAST_TONES[tone] || TOAST_TONES.approved;
    var toast = document.createElement('div');
    toast.setAttribute('data-claude-guard-toast', tone);
    toast.style.cssText = [
      'background:' + t.bg, 'border:1px solid ' + t.border, 'color:' + t.color,
      'border-radius:8px', 'padding:8px 12px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.08)',
      'pointer-events:none'
    ].join(';');
    toast.textContent = text;
    container.appendChild(toast);
    setTimeout(function () { toast.remove(); }, ttl || 8000);
    return toast;
  }

  function showToast(method, url, status) {
    var icon = status === 'blocked' ? '\u23F3' : status === 'denied' ? '\u274C' : '\u2705';

    var shortUrl = url;
    try { var u = new URL(url); shortUrl = u.host + u.pathname; } catch (e) {}
    if (shortUrl.length > 60) shortUrl = shortUrl.slice(0, 57) + '\u2026';

    var label = status === 'blocked'
      ? 'BLOCKED — waiting for human approval'
      : status === 'denied'
        ? 'DENIED by human — do NOT retry'
        : 'APPROVED by human';

    pushToast(icon + ' [Claude Guard] ' + method + ' ' + shortUrl + ' — ' + label, status, status === 'blocked' ? 30000 : 8000);
  }

  // --------------- Message Bridge ---------------

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'group-agent-on') {
      if (!agentActive) {
        agentActive = true;
        activate();
      }
    }

    if (msg.type === 'group-agent-off') {
      if (agentActive) {
        agentActive = false;
        deactivate();
      }
    }

    if (msg.type === 'rules-updated') {
      window.postMessage({
        source: 'cg-cs',
        type: 'update',
        allow: msg.allowList,
        block: msg.blockList,
        auto: msg.autoMode
      }, '*');
      if (agentActive) applyRedaction(msg);
    }

    if (msg.type === 'approval-decision') {
      hideBanner();
      showToast(msg.method || '?', msg.url || '?', msg.action === 'deny' ? 'denied' : 'approved');
      window.postMessage({
        source: 'cg-cs',
        type: 'decision',
        id: msg.id,
        action: msg.action
      }, '*');
    }
  });

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'cg-int') return;

    if (d.type === 'blocked') {
      showBanner();
      showToast(d.method, d.url, 'blocked');
      chrome.runtime.sendMessage({
        type: 'request-blocked',
        id: d.id,
        method: d.method,
        url: d.url,
        reason: d.reason,
        headers: d.headers || null,
        body: d.body || null
      }).catch(function () {});
    }

    if (d.type === 'log') {
      chrome.runtime.sendMessage({
        type: 'log-event',
        event: { method: d.method, url: d.url, action: d.action }
      }).catch(function () {});
    }
  });

  // --------------- Poll (no MutationObserver — zero DOM overhead) ---------------

  setInterval(checkAgent, 2000);
})();
