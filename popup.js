(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var Redactor = window.ClaudeGuardRedactor;
  var expandedGuards = {}; // guardId -> true while its check list is open

  var REDACT_PLACEHOLDERS = {
    text: 'Text to redact, e.g. Jane Doe',
    regex: 'Regular expression, e.g. ACME-\\d{6}',
    selector: 'CSS selector, e.g. .account-balance'
  };

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

    $('autoMode').checked = state.autoMode !== false;
    $('redactEnabled').checked = state.redactEnabled !== false;
    var stats = state.stats || {};
    $('blockedNum').textContent = stats.blocked || 0;
    $('allowedNum').textContent = stats.allowed || 0;
    $('redactedNum').textContent = stats.redacted || 0;

    var badge = $('statusBadge');
    badge.textContent = isAgentActive ? 'Active' : 'Inactive';
    badge.className = 'badge' + (isAgentActive ? ' active' : '');

    renderList('allow', state.allowList || []);
    renderList('block', state.blockList || []);
    renderGuards(state.guards || {}, state.guardMinCertainty, !!state.guardMinCertaintyManaged);
    renderRedactList(state.redactList || []);
  }

  // --------------- Built-in guards ---------------

  function renderGuards(settings, minCertainty, minManaged) {
    var el = $('guardList');
    var sel = $('guardMinCertainty');
    if (!Redactor) {
      el.innerHTML = '<div class="empty">Guards unavailable</div>';
      return;
    }
    var min = Redactor.clampCertainty(minCertainty);
    sel.value = String(min);
    sel.disabled = minManaged;
    sel.title = minManaged ? 'Managed by your organization' : 'Checks rated below this certainty are ignored';

    var resolved = Redactor.resolveGuards(settings, min);
    var enabledCount = resolved.filter(function (g) { return g.enabled; }).length;
    $('guardCount').textContent = enabledCount + '/' + resolved.length;

    el.innerHTML = resolved.map(function (g) {
      var open = !!expandedGuards[g.guard.id];
      var checksHtml = open ? g.checks.map(function (c) {
        var cls = 'check' + (c.active ? '' : ' inactive');
        var note = c.belowThreshold ? ' <span class="note">below min</span>' : '';
        return [
          '<label class="' + cls + '">',
          '  <input type="checkbox" data-guard-check="' + esc(g.guard.id) + '" data-check="' + esc(c.check.id) + '"',
          '    ' + (c.disabled ? '' : 'checked') + (g.managed || !g.enabled ? ' disabled' : '') + '>',
          '  <span class="check-name" title="' + esc(c.check.pattern) + '">' + esc(c.check.name) + '</span>',
          note,
          '  <span class="certainty c' + c.check.certainty + '" title="Certainty">' + c.check.certainty + '</span>',
          '</label>'
        ].join('');
      }).join('') : '';

      return [
        '<div class="guard' + (g.enabled ? '' : ' off') + '" data-guard="' + esc(g.guard.id) + '">',
        '  <div class="guard-row">',
        '    <button class="guard-toggle-open" data-expand="' + esc(g.guard.id) + '" aria-expanded="' + open + '" title="' + esc(g.guard.description) + '">',
        '      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="transform:rotate(' + (open ? 90 : 0) + 'deg)"><path d="M9 6l6 6-6 6"/></svg>',
        '      <span class="guard-name">' + esc(g.guard.name) + '</span>',
        '      <span class="guard-meta">' + g.activeCount + '/' + g.checks.length + ' checks</span>',
        '    </button>',
        managedTag(g),
        '    <label class="toggle toggle-sm">',
        '      <input type="checkbox" data-guard-enabled="' + esc(g.guard.id) + '"' + (g.enabled ? ' checked' : '') + (g.managed ? ' disabled' : '') + '>',
        '      <span class="slider"></span>',
        '    </label>',
        '  </div>',
        open ? '<div class="guard-checks">' + checksHtml + '</div>' : '',
        '</div>'
      ].join('');
    }).join('');
  }

  function populateCertainty() {
    var sel = $('guardMinCertainty');
    var opts = [];
    for (var i = 1; i <= 10; i++) opts.push('<option value="' + i + '">' + i + '</option>');
    sel.innerHTML = opts.join('');
  }

  function removeButton(type, index) {
    return [
      '  <button class="remove" data-type="' + type + '" data-index="' + index + '" title="Remove">',
      '    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
      '  </button>'
    ].join('');
  }

  function managedTag(rule) {
    return rule.managed ? '<span class="tag" title="Managed by your organization">MDM</span>' : '';
  }

  function renderList(type, rules) {
    var el = $(type + 'List');
    $(type + 'Count').textContent = rules.length;

    if (!rules.length) {
      el.innerHTML = '<div class="empty">No rules</div>';
      return;
    }

    el.innerHTML = rules.map(function (r, i) {
      return [
        '<div class="rule">',
        '  <span class="method">' + esc(r.method || '*') + '</span>',
        '  <span class="pattern" title="' + esc(r.pattern || '*') + '">' + esc(r.pattern || '*') + '</span>',
        managedTag(r),
        r.managed ? '' : removeButton(type, i),
        '</div>'
      ].join('');
    }).join('');
  }

  function renderRedactList(rules) {
    var el = $('redactList');
    $('redactCount').textContent = rules.length;

    if (!rules.length) {
      el.innerHTML = '<div class="empty">No redaction rules</div>';
      return;
    }

    el.innerHTML = rules.map(function (r, i) {
      var label = Redactor ? Redactor.describeRule(r) : String(r.value || '');
      var scope = r.scope && r.scope !== '*' ? '<span class="scope" title="' + esc(r.scope) + '">' + esc(r.scope) + '</span>' : '';
      var tooltip = r.kind + ': ' + (r.value || '') + (r.scope && r.scope !== '*' ? '\nScope: ' + r.scope : '');
      return [
        '<div class="rule">',
        '  <span class="kind kind-' + esc(r.kind || '') + '">' + esc(r.kind || '?') + '</span>',
        '  <span class="pattern" title="' + esc(tooltip) + '">' + esc(label) + '</span>',
        scope,
        managedTag(r),
        r.managed ? '' : removeButton('redact', i),
        '</div>'
      ].join('');
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // --------------- Redaction form ---------------

  function syncRedactKind() {
    var kind = $('redactKind').value;
    $('redactValue').placeholder = REDACT_PLACEHOLDERS[kind] || '';
    showRedactError('');
  }

  function showRedactError(msg) {
    var el = $('redactError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function resetRedactForm() {
    $('redactForm').hidden = true;
    $('redactKind').value = 'text';
    $('redactValue').value = '';
    $('redactScope').value = '';
    syncRedactKind();
  }

  function buildRedactRule() {
    var kind = $('redactKind').value;
    var value = $('redactValue').value.trim();
    var scope = $('redactScope').value.trim();
    var rule = { kind: kind, value: value };
    if (scope && scope !== '*') rule.scope = scope;
    return rule;
  }

  function submitRedactRule() {
    var rule = buildRedactRule();
    var error = Redactor ? Redactor.validateRule(rule) : (rule.value ? null : 'Rule value is required');
    if (!error && rule.kind === 'selector') {
      try { document.querySelector(rule.value); } catch (e) { error = 'Invalid CSS selector'; }
    }
    if (error) {
      showRedactError(error);
      $('redactValue').focus();
      return;
    }
    chrome.runtime.sendMessage({ type: 'add-rule', list: 'redact', rule: rule }).then(function () {
      resetRedactForm();
      load();
    });
  }

  populateCertainty();
  syncRedactKind();

  $('redactKind').addEventListener('change', syncRedactKind);
  $('addRedact').addEventListener('click', function () {
    $('redactForm').hidden = false;
    $('redactValue').focus();
  });

  // --------------- Guard controls ---------------

  $('guardMinCertainty').addEventListener('change', function (e) {
    chrome.runtime.sendMessage({ type: 'set-guard-min-certainty', value: parseInt(e.target.value, 10) }).then(load);
  });

  $('guardList').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-expand]');
    if (!btn) return;
    var id = btn.getAttribute('data-expand');
    expandedGuards[id] = !expandedGuards[id];
    if (state) renderGuards(state.guards || {}, state.guardMinCertainty, !!state.guardMinCertaintyManaged);
  });

  $('guardList').addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-guard-enabled')) {
      chrome.runtime.sendMessage({ type: 'set-guard', guardId: t.getAttribute('data-guard-enabled'), enabled: t.checked }).then(load);
    } else if (t.hasAttribute('data-guard-check')) {
      chrome.runtime.sendMessage({
        type: 'set-guard-check',
        guardId: t.getAttribute('data-guard-check'),
        checkId: t.getAttribute('data-check'),
        disabled: !t.checked
      }).then(load);
    }
  });
  $('redactValue').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitRedactRule();
  });
  $('redactScope').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitRedactRule();
  });

  // --------------- Toggles ---------------

  $('autoMode').addEventListener('change', function (e) {
    chrome.runtime.sendMessage({ type: 'set-auto-mode', enabled: e.target.checked }).then(load);
  });

  $('redactEnabled').addEventListener('change', function (e) {
    chrome.runtime.sendMessage({ type: 'set-redact-enabled', enabled: e.target.checked }).then(load);
  });

  // --------------- Allow / block forms ---------------

  ['allow', 'block'].forEach(function (type) {
    $('add' + cap(type)).addEventListener('click', function () {
      $(type + 'Form').hidden = false;
      $(type + 'Pattern').focus();
    });
  });

  document.querySelectorAll('[data-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-cancel');
      if (type === 'redact') { resetRedactForm(); return; }
      $(type + 'Form').hidden = true;
      $(type + 'Pattern').value = '';
    });
  });

  document.querySelectorAll('[data-confirm]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var type = btn.getAttribute('data-confirm');
      if (type === 'redact') { submitRedactRule(); return; }
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

  $('clearStats').addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'clear-stats' }).then(load);
  });

  chrome.storage.onChanged.addListener(load);

  load();
})();
