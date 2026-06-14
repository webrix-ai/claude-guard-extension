(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = null;

  function load() {
    chrome.runtime.sendMessage({ type: 'get-state' }).then(function (s) {
      state = s;
      chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
        var tabId = tabs[0] && tabs[0].id;
        if (tabId) {
          chrome.runtime.sendMessage({ type: 'get-tab-status', tabId: tabId }).then(function (res) {
            render(res && res.agentActive);
          });
        } else {
          render(false);
        }
      });
    });
  }

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
      var action = r.managed
        ? ''
        : [
            '  <button class="remove" data-type="' + type + '" data-index="' + i + '" title="Remove">',
            '    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
            '  </button>'
          ].join('');
      return [
        '<div class="rule">',
        '  <span class="method">' + esc(r.method || '*') + '</span>',
        '  <span class="pattern" title="' + esc(r.pattern || '*') + '">' + esc(r.pattern || '*') + '</span>',
        action,
        '</div>'
      ].join('');
    }).join('');
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // Auto mode toggle
  $('autoMode').addEventListener('change', function (e) {
    chrome.runtime.sendMessage({ type: 'set-auto-mode', enabled: e.target.checked }).then(load);
  });

  // Add rule form toggles
  ['allow', 'block'].forEach(function (type) {
    $('add' + cap(type)).addEventListener('click', function () {
      $(type + 'Form').hidden = false;
      $(type + 'Pattern').focus();
    });
  });

  // Cancel buttons
  document.querySelectorAll('[data-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-cancel');
      $(type + 'Form').hidden = true;
      $(type + 'Pattern').value = '';
    });
  });

  // Confirm buttons
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

  // Enter key to submit forms
  ['allow', 'block'].forEach(function (type) {
    $(type + 'Pattern').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        document.querySelector('[data-confirm="' + type + '"]').click();
      }
    });
  });

  // Remove rules (event delegation)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.remove[data-type]');
    if (!btn) return;
    chrome.runtime.sendMessage({
      type: 'remove-rule',
      list: btn.getAttribute('data-type'),
      index: parseInt(btn.getAttribute('data-index'), 10)
    }).then(load);
  });

  // Clear stats
  $('clearStats').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'clear-stats' }).then(load);
  });

  // Auto-refresh when storage changes
  chrome.storage.onChanged.addListener(load);

  load();
})();
