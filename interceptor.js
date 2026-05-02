/**
 * MAIN world script — runs in the page's JS context so it can
 * override fetch(), XMLHttpRequest, form.submit(), and sendBeacon()
 * to actually prevent blocked requests from being sent.
 */

(function () {
  "use strict";

  const BLOCKED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const ALLOWED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

  let active = false;
  let rules = [];

  // --- Rule evaluation (self-contained, no imports) ---

  function matchPattern(url, pattern) {
    if (!pattern || pattern === "*") return true;
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    try {
      return new RegExp("^" + escaped + "$", "i").test(url);
    } catch {
      return false;
    }
  }

  function evaluate(url, method) {
    const pageUrl = location.href;
    const custom = rules.filter(function (r) { return r.type === "custom"; });
    const defaults = rules.filter(function (r) { return r.type === "default"; });

    for (const rule of custom) {
      if (
        (rule.method === "*" || rule.method === method) &&
        matchPattern(url, rule.pattern) &&
        matchPattern(pageUrl, rule.pagePattern)
      ) {
        return rule.action;
      }
    }

    for (const rule of defaults) {
      if (
        (rule.method === "*" || rule.method === method) &&
        matchPattern(url, rule.pattern) &&
        matchPattern(pageUrl, rule.pagePattern)
      ) {
        return rule.action;
      }
    }

    if (BLOCKED_METHODS.has(method)) return "block";
    return "allow";
  }

  function resolveUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
    } catch {}
    return String(input);
  }

  function shouldBlock(url, method) {
    if (!active) return false;
    return evaluate(url, method.toUpperCase()) === "block";
  }

  function logBlock(method, url) {
    console.warn(
      "%c[Webrix Guard]%c Blocked %c" + method + "%c " + url,
      "color:#a78bfa;font-weight:bold",
      "color:#f87171",
      "color:#f87171;font-weight:bold",
      "color:#f87171"
    );
    window.postMessage({
      source: "webrix-guard-interceptor",
      type: "blocked",
      method: method,
      url: url,
    }, "*");
  }

  // --- Override fetch() ---

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = resolveUrl(input);
    const method = ((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (shouldBlock(url, method)) {
      logBlock(method, url);
      return Promise.reject(
        new DOMException("[Webrix Guard] Request blocked: " + method + " " + url, "AbortError")
      );
    }

    return originalFetch.apply(this, arguments);
  };

  // --- Override XMLHttpRequest ---

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wgMethod = (method || "GET").toUpperCase();
    this.__wgUrl = resolveUrl(url);
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (shouldBlock(this.__wgUrl, this.__wgMethod)) {
      logBlock(this.__wgMethod, this.__wgUrl);
      Object.defineProperty(this, "status", { get: function () { return 0; } });
      Object.defineProperty(this, "readyState", { get: function () { return 4; } });
      this.dispatchEvent(new ProgressEvent("error"));
      this.dispatchEvent(new ProgressEvent("loadend"));
      return;
    }
    return originalSend.apply(this, arguments);
  };

  // --- Override navigator.sendBeacon() ---

  if (navigator.sendBeacon) {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (shouldBlock(resolveUrl(url), "POST")) {
        logBlock("POST", resolveUrl(url));
        return false;
      }
      return originalBeacon(url, data);
    };
  }

  // --- Override HTMLFormElement.prototype.submit ---

  const originalSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    const method = (this.method || "GET").toUpperCase();
    const url = resolveUrl(this.action || location.href);

    if (shouldBlock(url, method)) {
      logBlock(method, url);
      return;
    }
    return originalSubmit.apply(this, arguments);
  };

  if (HTMLFormElement.prototype.requestSubmit) {
    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = function () {
      const method = (this.method || "GET").toUpperCase();
      const url = resolveUrl(this.action || location.href);

      if (shouldBlock(url, method)) {
        logBlock(method, url);
        return;
      }
      return originalRequestSubmit.apply(this, arguments);
    };
  }

  // --- Listen for messages from the content script (ISOLATED world) ---

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.source !== "webrix-guard-content") return;

    if (e.data.type === "activate") {
      active = true;
      rules = e.data.rules || [];
      console.log(
        "%c[Webrix Guard]%c Active — monitoring " + rules.length + " rules",
        "color:#a78bfa;font-weight:bold",
        "color:#4ade80"
      );
    }

    if (e.data.type === "deactivate") {
      active = false;
      console.log(
        "%c[Webrix Guard]%c Deactivated",
        "color:#a78bfa;font-weight:bold",
        "color:#71717a"
      );
    }

    if (e.data.type === "update-rules") {
      rules = e.data.rules || [];
    }
  });
})();
