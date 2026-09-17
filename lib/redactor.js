/**
 * Claude Guard — redaction engine.
 *
 * Removes sensitive information from a live document while a Claude browser
 * agent is active. Unlike CSS-based hiding, redaction rewrites text nodes and
 * removes matched elements from the DOM, so the information is genuinely gone
 * from anything that reads the page (accessibility tree, innerText, screenshots).
 *
 * Runs in the isolated content-script world (DOM access, no page globals) and is
 * also loadable as a CommonJS module for unit tests.
 *
 * Two sources of redaction:
 *
 * 1. Built-in guards (lib/guards.js) — grouped regex checks with a certainty
 *    score. Configured via `guards` settings:
 *      { [guardId]: { enabled?: boolean, disabledChecks?: string[] } }
 *    and a global `minCertainty` (checks rated below it are ignored).
 *
 * 2. Custom rules:
 *   { kind: 'text',     value: 'literal string',        scope?, replacement? }
 *   { kind: 'regex',    value: 'source', flags?: 'gi',  scope?, replacement? }
 *   { kind: 'selector', value: '.css-selector',         scope? }
 *
 * `scope` is an optional URL glob (same syntax as allow/block rules, `*` wildcard).
 * A rule with no scope, or scope `*`, applies to every page.
 */
(function (root, factory) {
  var guards = (typeof module === 'object' && module.exports)
    ? require('./guards.js')
    : root.ClaudeGuardGuards;
  if (typeof module === 'object' && module.exports) module.exports = factory(guards);
  else root.ClaudeGuardRedactor = factory(guards);
})(typeof self !== 'undefined' ? self : this, function (Guards) {
  'use strict';

  var DEFAULT_MASK = '[REDACTED]';
  var KINDS = ['text', 'regex', 'selector'];
  var GUARDS = (Guards && Guards.GUARDS) || [];
  var DEFAULT_MIN_CERTAINTY = (Guards && Guards.DEFAULT_MIN_CERTAINTY) || 6;

  // Attributes whose values are exposed to assistive tech / agents and may leak data.
  var TEXT_ATTRIBUTES = ['title', 'alt', 'aria-label', 'placeholder'];

  // Subtrees we never touch: executable/style content and our own overlays.
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var OWN_PREFIX = 'claude-guard';

  var SHOW_ELEMENT = 1, SHOW_TEXT = 4;
  var FILTER_ACCEPT = 1, FILTER_REJECT = 2;
  var ELEMENT_NODE = 1, TEXT_NODE = 3, DOCUMENT_NODE = 9, FRAGMENT_NODE = 11;

  // --------------- Helpers ---------------

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function globToRegExp(pattern) {
    var src = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + src + '$', 'i');
  }

  function inScope(rule, url) {
    if (!rule.scope || rule.scope === '*') return true;
    if (!url) return false;
    try { return globToRegExp(rule.scope).test(url); } catch (e) { return false; }
  }

  function normalizeFlags(flags) {
    var out = 'g';
    String(flags || '').split('').forEach(function (f) {
      if ('imsu'.indexOf(f) !== -1 && out.indexOf(f) === -1) out += f;
    });
    return out;
  }

  function describeRule(rule) {
    return rule ? String(rule.value || '') : '';
  }

  /**
   * Validate a single custom rule. Returns null when valid, otherwise an error string.
   */
  function validateRule(rule) {
    if (!rule || typeof rule !== 'object') return 'Rule must be an object';
    if (KINDS.indexOf(rule.kind) === -1) return 'Unknown rule kind: ' + rule.kind;
    if (typeof rule.value !== 'string' || !rule.value.trim()) return 'Rule value is required';
    if (rule.kind === 'regex') {
      try { new RegExp(rule.value, normalizeFlags(rule.flags)); } catch (e) { return 'Invalid regular expression: ' + e.message; }
    }
    return null;
  }

  // --------------- Guards ---------------

  function clampCertainty(v) {
    var n = Number(v);
    if (!isFinite(n)) return DEFAULT_MIN_CERTAINTY;
    return Math.min(10, Math.max(1, Math.round(n)));
  }

  /**
   * Resolve the effective state of every built-in guard given user/policy
   * settings. Returns an array the popup can render directly:
   *   { guard, enabled, managed, checks: [{ check, disabled, belowThreshold, active }] }
   */
  function resolveGuards(settings, minCertainty) {
    settings = settings || {};
    var min = clampCertainty(minCertainty === undefined ? DEFAULT_MIN_CERTAINTY : minCertainty);
    return GUARDS.map(function (guard) {
      var s = settings[guard.id] || {};
      var enabled = typeof s.enabled === 'boolean' ? s.enabled : !!guard.defaultEnabled;
      var disabled = Array.isArray(s.disabledChecks) ? s.disabledChecks : [];
      var checks = guard.checks.map(function (check) {
        var isDisabled = disabled.indexOf(check.id) !== -1;
        var below = check.certainty < min;
        return { check: check, disabled: isDisabled, belowThreshold: below, active: enabled && !isDisabled && !below };
      });
      return {
        guard: guard,
        enabled: enabled,
        managed: !!s.managed,
        activeCount: checks.filter(function (c) { return c.active; }).length,
        checks: checks
      };
    });
  }

  /** Compile active guard checks into text matchers. */
  function compileGuards(settings, minCertainty) {
    var out = [];
    resolveGuards(settings, minCertainty).forEach(function (g) {
      g.checks.forEach(function (c) {
        if (!c.active) return;
        var re;
        try { re = new RegExp(c.check.pattern, normalizeFlags(c.check.flags)); } catch (e) { return; }
        out.push({
          re: re,
          mask: c.check.replacement || DEFAULT_MASK,
          validate: c.check.validate || null,
          guard: g.guard.id,
          check: c.check.id
        });
      });
    });
    return out;
  }

  /**
   * Compile a redaction config for `url` into matchers.
   *
   *   compile({ rules, guards, minCertainty }, url)
   *   compile(rules, url)                        // custom rules only
   *
   * Invalid custom rules are skipped and reported in `errors`.
   */
  function compile(config, url) {
    if (Array.isArray(config)) config = { rules: config };
    config = config || {};
    var out = { text: [], selectors: [], errors: [] };

    if (config.guards !== undefined || config.minCertainty !== undefined) {
      out.text = compileGuards(config.guards, config.minCertainty);
    }

    (config.rules || []).forEach(function (rule) {
      if (!rule) return;
      var error = validateRule(rule);
      if (error) { out.errors.push({ rule: rule, error: error }); return; }
      if (!inScope(rule, url)) return;

      var mask = (typeof rule.replacement === 'string' && rule.replacement) ? rule.replacement : DEFAULT_MASK;

      if (rule.kind === 'selector') {
        out.selectors.push({ selector: rule.value, rule: rule });
        return;
      }

      var re = rule.kind === 'text'
        ? new RegExp(escapeRegExp(rule.value), 'gi')
        : new RegExp(rule.value, normalizeFlags(rule.flags));
      out.text.push({ re: re, mask: mask, validate: null, rule: rule });
    });
    return out;
  }

  /**
   * Apply compiled text matchers to a string.
   * Returns { value, count } where count is the number of replacements made.
   */
  function redactString(input, textMatchers) {
    var value = String(input);
    var count = 0;
    if (!value || !textMatchers || !textMatchers.length) return { value: value, count: 0 };
    for (var i = 0; i < textMatchers.length; i++) {
      var m = textMatchers[i];
      m.re.lastIndex = 0;
      value = value.replace(m.re, function (match) {
        if (m.validate && !m.validate(match)) return match;
        count++;
        return m.mask;
      });
    }
    return { value: value, count: count };
  }

  function isOwnElement(el) {
    var id = el.id;
    if (typeof id === 'string' && id.indexOf(OWN_PREFIX) === 0) return true;
    return el.hasAttribute && el.hasAttribute('data-claude-guard-toast');
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== ELEMENT_NODE) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    return isOwnElement(el);
  }

  function hasSkippedAncestor(node) {
    var el = node.parentNode;
    while (el && el.nodeType === ELEMENT_NODE) {
      if (shouldSkipElement(el)) return true;
      el = el.parentNode;
    }
    return false;
  }

  function redactTextNode(node, textMatchers) {
    var current = node.nodeValue;
    if (!current || !/\S/.test(current)) return 0;
    var r = redactString(current, textMatchers);
    if (r.count && r.value !== current) node.nodeValue = r.value;
    return r.count;
  }

  function redactAttributes(el, textMatchers) {
    if (!el || el.nodeType !== ELEMENT_NODE || !textMatchers.length) return 0;
    var count = 0;
    for (var i = 0; i < TEXT_ATTRIBUTES.length; i++) {
      var name = TEXT_ATTRIBUTES[i];
      if (!el.hasAttribute(name)) continue;
      var current = el.getAttribute(name);
      var r = redactString(current, textMatchers);
      if (r.count && r.value !== current) { el.setAttribute(name, r.value); count += r.count; }
    }
    return count;
  }

  function safeMatches(el, selector) {
    try { return el.matches(selector); } catch (e) { return false; }
  }

  function removeMatches(rootEl, selectors) {
    var removed = 0;
    for (var i = 0; i < selectors.length; i++) {
      var sel = selectors[i].selector;
      if (rootEl.nodeType === ELEMENT_NODE && safeMatches(rootEl, sel)) {
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
        return { removed: removed + 1, rootRemoved: true };
      }
      var found;
      try { found = rootEl.querySelectorAll(sel); } catch (e) { continue; }
      for (var k = 0; k < found.length; k++) {
        var el = found[k];
        if (isOwnElement(el)) continue;
        if (el.parentNode) { el.parentNode.removeChild(el); removed++; }
      }
    }
    return { removed: removed, rootRemoved: false };
  }

  /**
   * Redact a DOM subtree in place. `root` may be a Document, Element,
   * DocumentFragment or Text node. Returns { text, elements } counts.
   */
  function redactTree(root, compiled) {
    var result = { text: 0, elements: 0 };
    if (!root || !compiled) return result;

    if (root.nodeType === TEXT_NODE) {
      if (hasSkippedAncestor(root)) return result;
      result.text += redactTextNode(root, compiled.text);
      return result;
    }

    if (root.nodeType === DOCUMENT_NODE) root = root.documentElement;
    if (!root || (root.nodeType !== ELEMENT_NODE && root.nodeType !== FRAGMENT_NODE)) return result;
    if (root.nodeType === ELEMENT_NODE && (shouldSkipElement(root) || hasSkippedAncestor(root))) return result;

    if (compiled.selectors.length) {
      var rm = removeMatches(root, compiled.selectors);
      result.elements += rm.removed;
      if (rm.rootRemoved) return result;
    }

    if (!compiled.text.length) return result;

    var doc = root.ownerDocument || root;
    if (root.nodeType === ELEMENT_NODE) result.text += redactAttributes(root, compiled.text);

    var walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === ELEMENT_NODE) return shouldSkipElement(n) ? FILTER_REJECT : FILTER_ACCEPT;
        return FILTER_ACCEPT;
      }
    });

    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === TEXT_NODE) result.text += redactTextNode(node, compiled.text);
      else result.text += redactAttributes(node, compiled.text);
    }
    return result;
  }

  // --------------- Live redactor ---------------

  /**
   * Create a redactor bound to a document. It performs a full pass on start()
   * and then keeps redacting content added or changed later via MutationObserver.
   */
  function createRedactor(doc) {
    var compiled = null;
    var observer = null;
    var listeners = [];
    var stats = { text: 0, elements: 0 };
    var view = doc.defaultView;
    var MO = (view && view.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);

    function emit(res) {
      if (!res.text && !res.elements) return;
      stats.text += res.text;
      stats.elements += res.elements;
      listeners.forEach(function (cb) {
        try { cb(res, stats); } catch (e) {}
      });
    }

    function add(total, res) { total.text += res.text; total.elements += res.elements; }

    function process(records) {
      if (!compiled || !records || !records.length) return;
      var total = { text: 0, elements: 0 };
      var seen = [];
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') {
          for (var k = 0; k < r.addedNodes.length; k++) {
            var n = r.addedNodes[k];
            if (seen.indexOf(n) !== -1) continue;
            seen.push(n);
            add(total, redactTree(n, compiled));
          }
        } else if (r.type === 'characterData') {
          add(total, redactTree(r.target, compiled));
        } else if (r.type === 'attributes') {
          if (!hasSkippedAncestor(r.target) && !shouldSkipElement(r.target)) {
            total.text += redactAttributes(r.target, compiled.text);
          }
        }
      }
      emit(total);
    }

    var api = {
      /**
       * Start (or restart) redaction for the given page URL.
       * `config` is { rules, guards, minCertainty } or a plain array of custom rules.
       */
      start: function (config, url) {
        url = url || (doc.location && doc.location.href) || '';
        compiled = compile(config, url);
        if (!compiled.text.length && !compiled.selectors.length) {
          api.stop();
          return { text: 0, elements: 0 };
        }
        var res = redactTree(doc, compiled);
        if (!observer && MO) {
          observer = new MO(process);
          observer.observe(doc, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: TEXT_ATTRIBUTES
          });
        }
        emit(res);
        return res;
      },
      /** Stop observing. Already-redacted content is not restored. */
      stop: function () {
        if (observer) { observer.disconnect(); observer = null; }
        compiled = null;
      },
      /** Synchronously process pending mutation records (useful in tests). */
      flush: function () {
        if (observer) process(observer.takeRecords());
      },
      isActive: function () { return !!compiled; },
      errors: function () { return compiled ? compiled.errors.slice() : []; },
      stats: stats,
      onRedact: function (cb) { if (typeof cb === 'function') listeners.push(cb); }
    };
    api.update = api.start;
    return api;
  }

  return {
    DEFAULT_MASK: DEFAULT_MASK,
    DEFAULT_MIN_CERTAINTY: DEFAULT_MIN_CERTAINTY,
    KINDS: KINDS,
    GUARDS: GUARDS,
    TEXT_ATTRIBUTES: TEXT_ATTRIBUTES,
    globToRegExp: globToRegExp,
    inScope: inScope,
    validateRule: validateRule,
    describeRule: describeRule,
    clampCertainty: clampCertainty,
    resolveGuards: resolveGuards,
    compileGuards: compileGuards,
    compile: compile,
    redactString: redactString,
    redactTree: redactTree,
    createRedactor: createRedactor
  };
});
