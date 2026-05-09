(function () {
  'use strict';

  if (window.self !== window.top) return;

  var agentActive = false;
  var popupRoot = null;

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
        auto: state.autoMode !== false
      }, '*');
    }).catch(function () {
      window.postMessage({ source: 'cg-cs', type: 'activate', allow: [], block: [], auto: true }, '*');
    });
  }

  // --------------- Message Bridge ---------------

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'rules-updated') {
      window.postMessage({
        source: 'cg-cs',
        type: 'update',
        allow: msg.allowList,
        block: msg.blockList,
        auto: msg.autoMode
      }, '*');
    }
  });

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'cg-int') return;

    if (d.type === 'blocked') {
      showApproval(d.id, d.method, d.url, d.reason);
    }

    if (d.type === 'log') {
      chrome.runtime.sendMessage({
        type: 'log-event',
        event: { method: d.method, url: d.url, action: d.action }
      }).catch(function () {});
    }
  });

  // --------------- In-Page Approval Popup ---------------

  var POPUP_CSS = [
    ':host { all: initial; }',
    '*, *::before, *::after { box-sizing: border-box; }',

    '.stack {',
    '  position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;',
    '  display: flex; flex-direction: column; gap: 8px;',
    '  max-height: 80vh; overflow-y: auto;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    '  scrollbar-width: none;',
    '}',
    '.stack::-webkit-scrollbar { display: none; }',

    '.card {',
    '  background: rgba(255,255,255,0.97);',
    '  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);',
    '  border: 1px solid rgba(0,0,0,0.08);',
    '  border-radius: 14px;',
    '  box-shadow: 0 8px 40px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);',
    '  padding: 16px 18px; width: 400px; max-width: calc(100vw - 32px);',
    '  animation: cgSlideIn 0.25s cubic-bezier(0.16,1,0.3,1);',
    '  color: #1e293b;',
    '}',
    '.card.out { animation: cgSlideOut 0.2s ease-in forwards; pointer-events: none; }',

    '@keyframes cgSlideIn {',
    '  from { opacity: 0; transform: translateY(12px) scale(0.97); }',
    '  to   { opacity: 1; transform: none; }',
    '}',
    '@keyframes cgSlideOut {',
    '  to { opacity: 0; transform: translateX(60px); }',
    '}',

    '.head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }',
    '.head svg { color: #f59e0b; flex-shrink: 0; }',
    '.head .title { font-size: 13px; font-weight: 600; flex: 1; letter-spacing: -0.01em; }',
    '.head .close {',
    '  background: none; border: none; cursor: pointer; color: #94a3b8;',
    '  padding: 4px; border-radius: 6px; display: flex; line-height: 0;',
    '}',
    '.head .close:hover { background: #f1f5f9; color: #64748b; }',

    '.detail { margin-bottom: 14px; }',
    '.method-badge {',
    '  display: inline-block; font-size: 10px; font-weight: 700;',
    '  letter-spacing: 0.5px; padding: 2px 8px; border-radius: 4px;',
    '  color: #fff; vertical-align: middle; line-height: 1.6;',
    '}',
    '.method-badge.GET    { background: #22c55e; }',
    '.method-badge.POST   { background: #3b82f6; }',
    '.method-badge.PUT    { background: #f59e0b; }',
    '.method-badge.PATCH  { background: #8b5cf6; }',
    '.method-badge.DELETE { background: #ef4444; }',
    '.method-badge.OTHER  { background: #6b7280; }',

    '.url {',
    '  font-size: 12px; font-family: "SF Mono", Monaco, Consolas, monospace;',
    '  color: #334155; word-break: break-all; margin-top: 6px;',
    '  line-height: 1.5; max-height: 54px; overflow: hidden;',
    '}',
    '.reason { font-size: 11px; color: #94a3b8; margin-top: 4px; }',

    '.actions { display: flex; gap: 8px; }',
    '.btn {',
    '  flex: 1; padding: 8px 12px; border-radius: 8px; font-size: 12px;',
    '  font-weight: 600; cursor: pointer; border: 1.5px solid transparent;',
    '  transition: all 0.15s ease; line-height: 1;',
    '}',
    '.btn:active { transform: scale(0.97); }',

    '.deny  { background: #f8fafc; border-color: #e2e8f0; color: #64748b; }',
    '.deny:hover  { background: #f1f5f9; border-color: #cbd5e1; }',
    '.once  { background: #f8fafc; border-color: #c7d2fe; color: #4f46e5; }',
    '.once:hover  { background: #eef2ff; border-color: #a5b4fc; }',
    '.always { background: #4f46e5; color: #fff; border-color: #4f46e5; }',
    '.always:hover { background: #4338ca; border-color: #4338ca; }',

    '@media (prefers-color-scheme: dark) {',
    '  .card { background: rgba(30,41,59,0.97); border-color: rgba(255,255,255,0.08); color: #f1f5f9; }',
    '  .head .close { color: #64748b; }',
    '  .head .close:hover { background: rgba(255,255,255,0.06); color: #94a3b8; }',
    '  .url { color: #cbd5e1; }',
    '  .reason { color: #64748b; }',
    '  .deny { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.1); color: #94a3b8; }',
    '  .deny:hover { background: rgba(255,255,255,0.08); }',
    '  .once { background: rgba(99,102,241,0.08); border-color: rgba(99,102,241,0.3); color: #a5b4fc; }',
    '  .once:hover { background: rgba(99,102,241,0.15); }',
    '}'
  ].join('\n');

  function ensureRoot() {
    if (popupRoot) return popupRoot;
    var host = document.createElement('cg-guard');
    var shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = POPUP_CSS;
    shadow.appendChild(style);
    var stack = document.createElement('div');
    stack.className = 'stack';
    shadow.appendChild(stack);
    popupRoot = stack;
    document.documentElement.appendChild(host);
    return stack;
  }

  function showApproval(id, method, url, reason) {
    var root = ensureRoot();
    var card = document.createElement('div');
    card.className = 'card';

    var mc = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) !== -1 ? method : 'OTHER';
    var display = url.length > 140 ? url.slice(0, 137) + '\u2026' : url;

    card.innerHTML = [
      '<div class="head">',
      '  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
      '  <span class="title">Request Blocked</span>',
      '  <button class="close" aria-label="Dismiss"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>',
      '</div>',
      '<div class="detail">',
      '  <span class="method-badge ' + mc + '">' + esc(method) + '</span>',
      '  <div class="url">' + esc(display) + '</div>',
      '  <div class="reason">' + esc(reason) + '</div>',
      '</div>',
      '<div class="actions">',
      '  <button class="btn deny">Deny</button>',
      '  <button class="btn once">Allow Once</button>',
      '  <button class="btn always">Always Allow</button>',
      '</div>'
    ].join('\n');

    function respond(action) {
      card.classList.add('out');
      window.postMessage({ source: 'cg-cs', type: 'decision', id: id, action: action }, '*');

      if (action === 'allow-always') {
        try {
          var hostname = new URL(url, location.href).hostname;
          chrome.runtime.sendMessage({
            type: 'add-rule',
            list: 'allow',
            rule: { pattern: '*://' + hostname + '/*', method: '*' }
          }).catch(function () {});
        } catch (e) {}
      }

      setTimeout(function () { card.remove(); }, 220);
    }

    card.querySelector('.close').onclick = function () { respond('deny'); };
    card.querySelector('.deny').onclick = function () { respond('deny'); };
    card.querySelector('.once').onclick = function () { respond('allow-once'); };
    card.querySelector('.always').onclick = function () { respond('allow-always'); };

    root.appendChild(card);
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --------------- Poll (no MutationObserver — zero DOM overhead) ---------------

  setInterval(checkAgent, 2000);
})();
