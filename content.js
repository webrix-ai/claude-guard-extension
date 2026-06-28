(function () {
  'use strict';

  if (window.self !== window.top) return;

  var agentActive = false;
  var pendingCount = 0;
  var bannerEl = null;
  var toastContainer = null;
  var originalTitle = '';

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
      window.postMessage({ source: 'cg-cs', type: 'deactivate' }, '*');
    }
  }

  function activate() {
    chrome.runtime.sendMessage({ type: 'get-state' }).then(function (state) {
      window.postMessage({
        source: 'cg-cs',
        type: 'activate',
        allow: state.allowList || [],
        block: state.blockList || [],
        auto: state.autoMode !== false,
        guard: state.guard || { enabled: false, messages: false, files: false }
      }, '*');
    }).catch(function () {
      window.postMessage({ source: 'cg-cs', type: 'activate', allow: [], block: [], auto: true, guard: { enabled: false, messages: false, files: false } }, '*');
    });
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

  function showToast(method, url, status) {
    var container = ensureToastContainer();
    var toast = document.createElement('div');
    toast.setAttribute('data-claude-guard-toast', status);

    var isBlock = (status === 'blocked' || status === 'denied');
    var bg = isBlock ? '#fef2f2' : '#f0fdf4';
    var border = isBlock ? '#fca5a5' : '#86efac';
    var color = isBlock ? '#991b1b' : '#166534';
    var icon = status === 'blocked' ? '\u23F3' : status === 'denied' ? '\u274C' : '\u2705';

    var shortUrl = url;
    try { var u = new URL(url); shortUrl = u.host + u.pathname; } catch (e) {}
    if (shortUrl.length > 60) shortUrl = shortUrl.slice(0, 57) + '\u2026';

    var label = status === 'blocked'
      ? 'BLOCKED — waiting for human approval'
      : status === 'denied'
        ? 'DENIED by human — do NOT retry'
        : 'APPROVED by human';

    toast.style.cssText = [
      'background:' + bg, 'border:1px solid ' + border, 'color:' + color,
      'border-radius:8px', 'padding:8px 12px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.08)',
      'pointer-events:none'
    ].join(';');
    toast.textContent = icon + ' [Claude Guard] ' + method + ' ' + shortUrl + ' — ' + label;

    container.appendChild(toast);

    var ttl = status === 'blocked' ? 30000 : 8000;
    setTimeout(function () { toast.remove(); }, ttl);
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
        window.postMessage({ source: 'cg-cs', type: 'deactivate' }, '*');
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

    // Interceptor asks us to evaluate user content (message/file) against org
    // guards. The token + server URL live in the background worker, so we relay
    // the request there and post the verdict back to the MAIN-world interceptor.
    if (d.type === 'guard-check') {
      chrome.runtime.sendMessage({
        type: 'guard-evaluate',
        event: d.event,
        content: d.content
      }).then(function (result) {
        var verdict = (result && result.verdict) || 'allow';
        if (verdict === 'block') {
          showToast(d.label || 'POST', d.url || (d.event === 'PreToolUse' ? 'file upload' : 'message'), 'denied');
        }
        window.postMessage({
          source: 'cg-cs',
          type: 'guard-result',
          id: d.id,
          verdict: verdict,
          reason: (result && result.reason) || ''
        }, '*');
      }).catch(function () {
        // Fail open: never wedge the page if the background is unreachable.
        window.postMessage({ source: 'cg-cs', type: 'guard-result', id: d.id, verdict: 'allow', reason: '' }, '*');
      });
    }
  });

  // --------------- Poll (no MutationObserver — zero DOM overhead) ---------------

  setInterval(checkAgent, 2000);
})();
