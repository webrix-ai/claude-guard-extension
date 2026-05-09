(function () {
  'use strict';

  let active = false, autoMode = true, allowList = [], blockList = [];
  const pending = new Map();
  let rid = 0;

  const _fetch = window.fetch;
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;
  const _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const _formSubmit = HTMLFormElement.prototype.submit;
  const _formReqSubmit = HTMLFormElement.prototype.requestSubmit;
  const _beacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  const formPass = new WeakSet();

  function match(rule, method, url) {
    if (rule.method && rule.method !== '*' && rule.method.toUpperCase() !== method) return false;
    if (!rule.pattern || rule.pattern === '*') return true;
    try {
      var re = new RegExp(
        '^' + rule.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'
      );
      return re.test(url);
    } catch (e) { return false; }
  }

  function rootDomain(h) {
    var p = h.split('.');
    if (p.length <= 2) return h;
    if (p[p.length - 2].length <= 2) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  function isSameSite(url) {
    try {
      return rootDomain(new URL(url, location.href).hostname) === rootDomain(location.hostname);
    } catch (e) { return true; }
  }

  function verdict(method, url, hasAuth) {
    for (var i = 0; i < allowList.length; i++) if (match(allowList[i], method, url)) return 'allow';
    for (var j = 0; j < blockList.length; j++) if (match(blockList[j], method, url)) return 'block';
    if (autoMode && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && (hasAuth || isSameSite(url))) return 'block';
    return 'allow';
  }

  function captureHeaders(raw) {
    var out = {};
    try {
      if (raw instanceof Headers) { raw.forEach(function (v, k) { out[k] = v; }); }
      else if (Array.isArray(raw)) { raw.forEach(function (p) { out[p[0]] = p[1]; }); }
      else if (raw && typeof raw === 'object') { Object.keys(raw).forEach(function (k) { out[k] = raw[k]; }); }
    } catch (e) {}
    return out;
  }

  function captureBody(body) {
    if (!body) return null;
    if (typeof body === 'string') return body.length > 3000 ? body.slice(0, 3000) + '\n… (truncated)' : body;
    if (body instanceof URLSearchParams) return body.toString().slice(0, 3000);
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      var parts = [];
      body.forEach(function (v, k) { parts.push(k + '=' + (typeof v === 'string' ? v : '[File: ' + (v.name || 'blob') + ']')); });
      return parts.join('\n').slice(0, 3000);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob ' + body.size + ' bytes, type=' + (body.type || 'unknown') + ']';
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return '[ArrayBuffer ' + body.byteLength + ' bytes]';
    return '[' + (body.constructor ? body.constructor.name : typeof body) + ']';
  }

  function ask(method, url, reason, headers, body) {
    return new Promise(function (resolve) {
      var id = ++rid;
      pending.set(id, resolve);
      window.postMessage({
        source: 'cg-int', type: 'blocked', id: id,
        method: method, url: url, reason: reason,
        headers: headers || null, body: body || null
      }, '*');
      setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); resolve('deny'); }
      }, 120000);
    });
  }

  function log(method, url, action) {
    window.postMessage({ source: 'cg-int', type: 'log', method: method, url: url, action: action }, '*');
  }

  function blockedResponse(method, url) {
    var body = JSON.stringify({
      error: 'BLOCKED_BY_CLAUDE_GUARD',
      message: 'This ' + method + ' request to ' + url + ' was blocked by Claude Guard. The human denied the request or it timed out. Do NOT retry this request.',
      blocked: true
    });
    return new Response(body, {
      status: 403,
      statusText: 'Blocked by Claude Guard',
      headers: { 'Content-Type': 'application/json' }
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'cg-cs') return;
    if (d.type === 'activate') {
      active = true;
      allowList = d.allow || [];
      blockList = d.block || [];
      autoMode = d.auto !== false;
    } else if (d.type === 'deactivate') {
      active = false;
    } else if (d.type === 'update') {
      if (d.allow) allowList = d.allow;
      if (d.block) blockList = d.block;
      if (d.auto !== undefined) autoMode = d.auto;
    } else if (d.type === 'decision') {
      var r = pending.get(d.id);
      if (r) { pending.delete(d.id); r(d.action); }
    }
  });

  // -- fetch --
  window.fetch = function (input, init) {
    if (!active) return _fetch.apply(this, arguments);
    var req = input instanceof Request ? input : null;
    var url = req ? req.url : String(input);
    var method = ((init && init.method) || (req && req.method) || 'GET').toUpperCase();
    var rawHeaders = (init && init.headers) || (req ? req.headers : undefined) || {};
    var hasAuth = false;
    try {
      var h = new Headers(rawHeaders);
      hasAuth = h.has('Authorization') || h.has('authorization');
    } catch (e) {}

    if (verdict(method, url, hasAuth) === 'allow') {
      log(method, url, 'allow');
      return _fetch.apply(this, arguments);
    }

    var self = this;
    var hdrs = captureHeaders(rawHeaders);
    var bod = captureBody((init && init.body) || (req ? req.body : null));
    var reason = hasAuth ? 'Authorization header on ' + method + ' request' : isSameSite(url) ? 'Same-site ' + method + ' request' : 'Matched block rule';
    console.warn('[Claude Guard] Blocked ' + method + ' ' + url + ' — waiting for human approval');
    return ask(method, url, reason, hdrs, bod).then(function (act) {
      log(method, url, act === 'deny' ? 'block' : 'allow');
      if (act !== 'deny') return _fetch.call(self, input, init);
      console.warn('[Claude Guard] DENIED ' + method + ' ' + url + ' — human denied this request. Do not retry.');
      return blockedResponse(method, url);
    });
  };

  // -- XMLHttpRequest --
  XMLHttpRequest.prototype.open = function (m, u) {
    this._cg = { m: (m || 'GET').toUpperCase(), u: String(u), a: false, h: [] };
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._cg) {
      if (/^authorization$/i.test(name)) this._cg.a = true;
      this._cg.h.push([name, value]);
    }
    return _xhrSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (!active || !this._cg) return _xhrSend.apply(this, arguments);
    var info = this._cg;
    if (verdict(info.m, info.u, info.a) === 'allow') {
      log(info.m, info.u, 'allow');
      return _xhrSend.apply(this, arguments);
    }

    var xhr = this, args = arguments;
    var hdrs = captureHeaders(info.h);
    var bod = captureBody(body);
    var reason = info.a ? 'Authorization header on ' + info.m + ' request' : isSameSite(info.u) ? 'Same-site ' + info.m + ' request' : 'Matched block rule';
    console.warn('[Claude Guard] Blocked ' + info.m + ' ' + info.u + ' — waiting for human approval');
    ask(info.m, info.u, reason, hdrs, bod).then(function (act) {
      log(info.m, info.u, act === 'deny' ? 'block' : 'allow');
      if (act !== 'deny') {
        _xhrSend.apply(xhr, args);
      } else {
        console.warn('[Claude Guard] DENIED ' + info.m + ' ' + info.u + ' — human denied this request. Do not retry.');
        try {
          Object.defineProperty(xhr, 'status', { get: function () { return 403; } });
          Object.defineProperty(xhr, 'statusText', { get: function () { return 'Blocked by Claude Guard'; } });
          Object.defineProperty(xhr, 'responseText', { get: function () { return '{"error":"BLOCKED_BY_CLAUDE_GUARD","message":"Human denied this request. Do NOT retry.","blocked":true}'; } });
        } catch (e) {}
        xhr.dispatchEvent(new ProgressEvent('error'));
        xhr.dispatchEvent(new ProgressEvent('loadend'));
      }
    });
  };

  // -- Form submit / requestSubmit --
  HTMLFormElement.prototype.submit = function () {
    if (!active || formPass.has(this)) { formPass.delete(this); return _formSubmit.call(this); }
    var m = (this.method || 'GET').toUpperCase(), u = this.action || location.href;
    if (verdict(m, u, false) === 'allow') { log(m, u, 'allow'); return _formSubmit.call(this); }
    var f = this;
    ask(m, u, 'Form submission').then(function (act) {
      log(m, u, act === 'deny' ? 'block' : 'allow');
      if (act !== 'deny') { formPass.add(f); f.submit(); }
    });
  };

  if (_formReqSubmit) {
    HTMLFormElement.prototype.requestSubmit = function (sub) {
      if (!active || formPass.has(this)) { formPass.delete(this); return _formReqSubmit.call(this, sub); }
      var m = (this.method || 'GET').toUpperCase(), u = this.action || location.href;
      if (verdict(m, u, false) === 'allow') { log(m, u, 'allow'); return _formReqSubmit.call(this, sub); }
      var f = this;
      ask(m, u, 'Form submission').then(function (act) {
        log(m, u, act === 'deny' ? 'block' : 'allow');
        if (act !== 'deny') { formPass.add(f); f.requestSubmit(sub); }
      });
    };
  }

  // Capture-phase listener for button-triggered form submits
  document.addEventListener('submit', function (e) {
    if (!active || !(e.target instanceof HTMLFormElement)) return;
    var f = e.target;
    if (formPass.has(f)) { formPass.delete(f); return; }
    var m = (f.method || 'GET').toUpperCase(), u = f.action || location.href;
    if (verdict(m, u, false) === 'allow') { log(m, u, 'allow'); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    ask(m, u, 'Form submission').then(function (act) {
      log(m, u, act === 'deny' ? 'block' : 'allow');
      if (act !== 'deny') { formPass.add(f); _formSubmit.call(f); }
    });
  }, true);

  // -- sendBeacon (synchronous check only, no approval popup) --
  if (_beacon) {
    navigator.sendBeacon = function (url, data) {
      if (!active) return _beacon(url, data);
      var u = String(url);
      if (verdict('POST', u, false) !== 'allow') { log('POST', u, 'block'); return false; }
      log('POST', u, 'allow');
      return _beacon(url, data);
    };
  }
})();
