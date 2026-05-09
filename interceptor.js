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

  function verdict(method, url, hasAuth) {
    for (var i = 0; i < allowList.length; i++) if (match(allowList[i], method, url)) return 'allow';
    for (var j = 0; j < blockList.length; j++) if (match(blockList[j], method, url)) return 'block';
    if (autoMode && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && hasAuth) return 'block';
    return 'allow';
  }

  function ask(method, url, reason) {
    return new Promise(function (resolve) {
      var id = ++rid;
      pending.set(id, resolve);
      window.postMessage({ source: 'cg-int', type: 'blocked', id: id, method: method, url: url, reason: reason }, '*');
      setTimeout(function () {
        if (pending.has(id)) { pending.delete(id); resolve('deny'); }
      }, 120000);
    });
  }

  function log(method, url, action) {
    window.postMessage({ source: 'cg-int', type: 'log', method: method, url: url, action: action }, '*');
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
    var hasAuth = false;
    try {
      var h = new Headers((init && init.headers) || (req ? req.headers : undefined) || {});
      hasAuth = h.has('Authorization') || h.has('authorization');
    } catch (e) {}

    if (verdict(method, url, hasAuth) === 'allow') {
      log(method, url, 'allow');
      return _fetch.apply(this, arguments);
    }

    var self = this;
    var reason = hasAuth ? 'Authorization header on ' + method + ' request' : 'Matched block rule';
    return ask(method, url, reason).then(function (act) {
      log(method, url, act === 'deny' ? 'block' : 'allow');
      if (act !== 'deny') return _fetch.call(self, input, init);
      throw new DOMException('Blocked by Claude Guard', 'AbortError');
    });
  };

  // -- XMLHttpRequest --
  XMLHttpRequest.prototype.open = function (m, u) {
    this._cg = { m: (m || 'GET').toUpperCase(), u: String(u), a: false };
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name) {
    if (this._cg && /^authorization$/i.test(name)) this._cg.a = true;
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
    var reason = info.a ? 'Authorization header on ' + info.m + ' request' : 'Matched block rule';
    ask(info.m, info.u, reason).then(function (act) {
      log(info.m, info.u, act === 'deny' ? 'block' : 'allow');
      if (act !== 'deny') {
        _xhrSend.apply(xhr, args);
      } else {
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
