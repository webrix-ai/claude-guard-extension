(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var pendingRequests = new Map();

  // --------------- State Loading ---------------

  function load() {
    chrome.runtime.sendMessage({ type: 'get-state' }).then(function (s) {
      state = s;
      getActiveTabStatus().then(function (isAgentActive) {
        render(isAgentActive);
      });
    });
  }

  function getActiveTabStatus() {
    return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(function (tabs) {
      var tabId = tabs[0] && tabs[0].id;
      if (!tabId) return false;
      return chrome.runtime.sendMessage({ type: 'get-tab-status', tabId: tabId }).then(function (res) {
        return !!(res && res.agentActive);
      });
    }).catch(function () { return false; });
  }

  // --------------- Rendering ---------------

  function render(isAgentActive) {
    if (!state) return;

    $('autoMode').checked = state.autoMode;
    $('blockedNum').textContent = state.stats ? state.stats.blocked : 0;
    $('allowedNum').textContent = state.stats ? state.stats.allowed : 0;

    var badge = $('statusBadge');
    badge.textContent = isAgentActive ? 'Active' : 'Inactive';
    badge.className = 'badge' + (isAgentActive ? ' active' : '');

    renderList('allow', state.allowList || []);
    renderList('block', state.blockList || []);
  }

  function renderList(type, rules) {
    var el = $(type + 'List');
    $(type + 'Count').textContent = rules.length;

    if (!rules.length) {
      el.innerHTML = '<div class="empty">No rules</div>';
      return;
    }

    el.innerHTML = rules.map(function (r, i) {
      var managed = r.managed ? ' <span style="font-size:9px;color:#94a3b8;font-weight:600">MDM</span>' : '';
      var removeBtn = r.managed ? '' : [
        '<button class="remove" data-type="' + type + '" data-index="' + i + '" title="Remove">',
        '  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
        '</button>'
      ].join('');
      return [
        '<div class="rule">',
        '  <span class="method">' + esc(r.method || '*') + '</span>',
        '  <span class="pattern" title="' + esc(r.pattern || '*') + '">' + esc(r.pattern || '*') + '</span>',
        managed,
        removeBtn,
        '</div>'
      ].join('');
    }).join('');
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // --------------- Pending Approvals ---------------

  function renderPending() {
    var section = $('pendingSection');
    var hr = $('pendingHr');
    var list = $('pendingList');
    var count = pendingRequests.size;

    $('pendingCount').textContent = count;
    section.hidden = count === 0;
    hr.hidden = count === 0;

    if (!count) { list.innerHTML = ''; return; }

    list.innerHTML = Array.from(pendingRequests.values()).map(function (req) {
      var shortUrl = req.url;
      try { var u = new URL(req.url); shortUrl = u.host + u.pathname; } catch (e) {}
      if (shortUrl.length > 50) shortUrl = shortUrl.slice(0, 47) + '\u2026';

      return [
        '<div class="pending-item" data-id="' + esc(req.id) + '">',
        '  <div class="pending-item-meta">',
        '    <span class="pending-method">' + esc(req.method || '?') + '</span>',
        '    <span class="pending-url" title="' + esc(req.url) + '">' + esc(shortUrl) + '</span>',
        '  </div>',
        '  <div class="pending-actions">',
        '    <button class="btn-approve" data-action="allow" data-id="' + esc(req.id) + '">Allow</button>',
        '    <button class="btn-approve-always" data-action="allow-always" data-id="' + esc(req.id) + '">Always</button>',
        '    <button class="btn-deny" data-action="deny" data-id="' + esc(req.id) + '">Deny</button>',
        '  </div>',
        '</div>'
      ].join('');
    }).join('');
  }

  // --------------- Background Port (for live pending approvals) ---------------

  var port = chrome.runtime.connect({ name: 'sidepanel' });

  port.onMessage.addListener(function (msg) {
    if (msg.type === 'pending-requests') {
      pendingRequests.clear();
      (msg.requests || []).forEach(function (r) { pendingRequests.set(r.id, r); });
      renderPending();
    }
    if (msg.type === 'new-request') {
      pendingRequests.set(msg.request.id, msg.request);
      renderPending();
    }
    if (msg.type === 'request-resolved') {
      pendingRequests.delete(msg.id);
      renderPending();
      load();
    }
  });

  port.postMessage({ type: 'sp-ready' });

  // --------------- Event Listeners ---------------

  $('autoMode').addEventListener('change', function (e) {
    chrome.runtime.sendMessage({ type: 'set-auto-mode', enabled: e.target.checked }).then(load);
  });

  ['allow', 'block'].forEach(function (type) {
    $('add' + cap(type)).addEventListener('click', function () {
      $(type + 'Form').hidden = false;
      $(type + 'Pattern').focus();
    });
  });

  document.querySelectorAll('[data-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-cancel');
      $(type + 'Form').hidden = true;
      $(type + 'Pattern').value = '';
    });
  });

  document.querySelectorAll('[data-confirm]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-confirm');
      var pattern = $(type + 'Pattern').value.trim();
      var method = $(type + 'Method').value;
      if (!pattern) { $(type + 'Pattern').focus(); return; }
      chrome.runtime.sendMessage({
        type: 'add-rule',
        list: type,
        rule: { pattern: pattern, method: method }
      }).then(function () {
        $(type + 'Form').hidden = true;
        $(type + 'Pattern').value = '';
        $(type + 'Method').value = '*';
        load();
      });
    });
  });

  ['allow', 'block'].forEach(function (type) {
    $(type + 'Pattern').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        document.querySelector('[data-confirm="' + type + '"]').click();
      }
    });
  });

  document.addEventListener('click', function (e) {
    var removeBtn = e.target.closest('.remove[data-type]');
    if (removeBtn) {
      chrome.runtime.sendMessage({
        type: 'remove-rule',
        list: removeBtn.getAttribute('data-type'),
        index: parseInt(removeBtn.getAttribute('data-index'), 10)
      }).then(load);
      return;
    }

    var actionBtn = e.target.closest('[data-action][data-id]');
    if (actionBtn) {
      var id = actionBtn.getAttribute('data-id');
      var action = actionBtn.getAttribute('data-action');
      port.postMessage({ type: 'sp-decision', id: id, action: action });
      pendingRequests.delete(id);
      renderPending();
    }
  });

  $('clearStats').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'clear-stats' }).then(load);
  });

  chrome.storage.onChanged.addListener(load);

  chrome.tabs.onActivated.addListener(function () {
    getActiveTabStatus().then(function (isAgentActive) {
      if (state) render(isAgentActive);
    });
  });

  load();
})();
