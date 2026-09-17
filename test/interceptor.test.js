'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPage, evalInWindow, tick } = require('./helpers/load');

/**
 * Boot interceptor.js in a page and return helpers that speak the
 * content-script ↔ interceptor postMessage protocol.
 */
function bootPage({ url, html } = {}) {
  const dom = createPage({ url, html });
  const w = dom.window;
  const fetchCalls = [];
  const originalFetch = function (input, init) {
    fetchCalls.push({ input, init });
    return Promise.resolve(new Response('ORIGINAL', { status: 200 }));
  };
  w.fetch = originalFetch;

  const fromInterceptor = [];
  w.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'cg-int') fromInterceptor.push(e.data);
  });

  evalInWindow(w, 'interceptor.js');

  async function send(msg) {
    w.postMessage(Object.assign({ source: 'cg-cs' }, msg), '*');
    await tick();
  }

  async function activate(opts = {}) {
    await send({ type: 'activate', allow: opts.allow || [], block: opts.block || [], auto: opts.auto !== false });
  }

  function lastBlocked() {
    return fromInterceptor.filter((m) => m.type === 'blocked').pop();
  }

  // Log messages travel over postMessage, which jsdom delivers asynchronously.
  async function logs() {
    await tick();
    return fromInterceptor.filter((m) => m.type === 'log').map((l) => l.action);
  }

  async function decide(id, action) {
    await send({ type: 'decision', id, action });
  }

  return { dom, w, fetchCalls, fromInterceptor, originalFetch, send, activate, lastBlocked, logs, decide };
}

describe('interceptor: install / uninstall', () => {
  let page;
  beforeEach(() => { page = bootPage(); });
  afterEach(() => page.dom.window.close());

  test('does nothing until activated', async () => {
    assert.equal(page.w.fetch, page.originalFetch);
    const res = await page.w.fetch('/api/thing', { method: 'POST' });
    assert.equal(await res.text(), 'ORIGINAL');
    assert.equal(page.fromInterceptor.length, 0);
  });

  test('activate patches fetch/XHR/forms, deactivate restores originals', async () => {
    const xhrSend = page.w.XMLHttpRequest.prototype.send;
    const formSubmit = page.w.HTMLFormElement.prototype.submit;
    await page.activate();
    assert.notEqual(page.w.fetch, page.originalFetch);
    assert.notEqual(page.w.XMLHttpRequest.prototype.send, xhrSend);
    assert.notEqual(page.w.HTMLFormElement.prototype.submit, formSubmit);

    await page.send({ type: 'deactivate' });
    assert.equal(page.w.fetch, page.originalFetch);
    assert.equal(page.w.XMLHttpRequest.prototype.send, xhrSend);
    assert.equal(page.w.HTMLFormElement.prototype.submit, formSubmit);
  });
});

describe('interceptor: fetch verdicts (auto mode)', () => {
  let page;
  beforeEach(async () => { page = bootPage(); await page.activate(); });
  afterEach(() => page.dom.window.close());

  test('GET requests pass through', async () => {
    const res = await page.w.fetch('https://api.example.com/items');
    assert.equal(await res.text(), 'ORIGINAL');
    assert.equal(page.fetchCalls.length, 1);
    assert.deepEqual(await page.logs(), ['allow']);
  });

  test('same-site POST is held for approval and released on allow', async () => {
    const p = page.w.fetch('https://api.example.com/items', { method: 'POST', body: '{"a":1}', headers: { 'X-Test': '1' } });
    await tick();
    assert.equal(page.fetchCalls.length, 0, 'original fetch not yet called');
    const blocked = page.lastBlocked();
    assert.equal(blocked.method, 'POST');
    assert.equal(blocked.url, 'https://api.example.com/items');
    assert.match(blocked.reason, /Same-site POST/);
    assert.equal(blocked.body, '{"a":1}');
    assert.equal(blocked.headers['X-Test'], '1');

    await page.decide(blocked.id, 'allow-once');
    const res = await p;
    assert.equal(await res.text(), 'ORIGINAL');
    assert.equal(page.fetchCalls.length, 1);
    assert.deepEqual(await page.logs(), ['allow']);
  });

  test('denied request resolves to a synthetic 403 JSON response', async () => {
    const p = page.w.fetch('/items/1', { method: 'DELETE' });
    await tick();
    const blocked = page.lastBlocked();
    await page.decide(blocked.id, 'deny');
    const res = await p;
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'BLOCKED_BY_CLAUDE_GUARD');
    assert.equal(body.blocked, true);
    assert.equal(page.fetchCalls.length, 0);
    assert.deepEqual(await page.logs(), ['block']);
  });

  test('cross-site POST without auth passes; with Authorization header it is held', async () => {
    await page.w.fetch('https://other.org/collect', { method: 'POST' });
    assert.equal(page.fetchCalls.length, 1);

    const p = page.w.fetch('https://other.org/collect', { method: 'POST', headers: { Authorization: 'Bearer abc' } });
    await tick();
    const blocked = page.lastBlocked();
    assert.match(blocked.reason, /Authorization header/);
    await page.decide(blocked.id, 'deny');
    assert.equal((await p).status, 403);
  });

  test('Request objects are inspected too', async () => {
    const req = new page.w.Request('https://app.example.com/save', { method: 'PUT' });
    const p = page.w.fetch(req);
    await tick();
    const blocked = page.lastBlocked();
    assert.equal(blocked.method, 'PUT');
    await page.decide(blocked.id, 'deny');
    assert.equal((await p).status, 403);
  });

  test('subdomains of the same registrable domain count as same-site', async () => {
    page.w.fetch('https://deep.sub.example.com/x', { method: 'POST' });
    await tick();
    assert.ok(page.lastBlocked());
  });
});

describe('interceptor: rule lists', () => {
  let page;
  afterEach(() => page.dom.window.close());

  test('allow rule wins over auto-mode and block rules', async () => {
    page = bootPage();
    await page.activate({
      allow: [{ pattern: '*://api.example.com/*', method: 'POST' }],
      block: [{ pattern: '*://api.example.com/*', method: '*' }]
    });
    await page.w.fetch('https://api.example.com/items', { method: 'POST' });
    assert.equal(page.fetchCalls.length, 1);

    // Method-specific allow does not cover DELETE → block rule applies.
    const p = page.w.fetch('https://api.example.com/items', { method: 'DELETE' });
    await tick();
    const blocked = page.lastBlocked();
    assert.equal(blocked.method, 'DELETE');
    await page.decide(blocked.id, 'deny');
    assert.equal((await p).status, 403);
  });

  test('block rule on a cross-site GET reports "Matched block rule"', async () => {
    page = bootPage();
    await page.activate({ block: [{ pattern: '*://tracker.example.org/*', method: '*' }] });
    const p = page.w.fetch('https://tracker.example.org/pixel');
    await tick();
    const blocked = page.lastBlocked();
    assert.equal(blocked.reason, 'Matched block rule');
    await page.decide(blocked.id, 'deny');
    await p;
  });

  test('block rule holds GET requests to other sites even with auto mode off', async () => {
    page = bootPage();
    await page.activate({ auto: false, block: [{ pattern: '*://evil.example.org/*', method: '*' }] });
    await page.w.fetch('https://api.example.com/items', { method: 'POST' });
    assert.equal(page.fetchCalls.length, 1, 'auto mode off → same-site POST allowed');

    const p = page.w.fetch('https://evil.example.org/track');
    await tick();
    const blocked = page.lastBlocked();
    assert.equal(blocked.method, 'GET');
    await page.decide(blocked.id, 'deny');
    await p;
  });

  test('rules can be updated live', async () => {
    page = bootPage();
    await page.activate();
    await page.send({ type: 'update', allow: [{ pattern: '*', method: '*' }] });
    await page.w.fetch('/anything', { method: 'DELETE' });
    assert.equal(page.fetchCalls.length, 1);
  });

  test('glob matching escapes regex metacharacters', async () => {
    page = bootPage();
    await page.activate({ allow: [{ pattern: 'https://api.example.com/v1/items?id=*', method: '*' }] });
    await page.w.fetch('https://api.example.com/v1/items?id=42', { method: 'POST' });
    assert.equal(page.fetchCalls.length, 1, 'literal ? in pattern must match a literal ?');
    const p = page.w.fetch('https://api.example.com/v1/itemsid=42', { method: 'POST' });
    await tick();
    const blocked = page.lastBlocked();
    assert.ok(blocked, '? must not act as a regex quantifier');
    await page.decide(blocked.id, 'deny');
    await p;
  });

  test('navigating to a blocked URL replaces the page content', async () => {
    page = bootPage({ url: 'https://evil.example.org/landing' });
    await page.activate({ block: [{ pattern: '*://evil.example.org/*', method: '*' }] });
    assert.equal(page.w.document.title, 'Blocked by Claude Guard');
    assert.match(page.w.document.body.textContent, /Navigation to this URL is not allowed/);
    assert.deepEqual(await page.logs(), ['block']);
  });
});

describe('interceptor: XHR, forms, beacons', () => {
  let page;
  beforeEach(async () => { page = bootPage(); await page.activate(); });
  afterEach(() => page.dom.window.close());

  test('XHR with Authorization header is held and reports 403 on deny', async () => {
    const xhr = new page.w.XMLHttpRequest();
    xhr.open('POST', 'https://other.org/api');
    xhr.setRequestHeader('Authorization', 'Bearer x');
    xhr.setRequestHeader('X-Trace', 't1');
    const events = [];
    xhr.addEventListener('error', () => events.push('error'));
    xhr.addEventListener('loadend', () => events.push('loadend'));
    xhr.send('payload');
    await tick();

    const blocked = page.lastBlocked();
    assert.equal(blocked.method, 'POST');
    assert.equal(blocked.headers['X-Trace'], 't1');
    assert.equal(blocked.body, 'payload');

    await page.decide(blocked.id, 'deny');
    assert.equal(xhr.status, 403);
    assert.match(xhr.responseText, /BLOCKED_BY_CLAUDE_GUARD/);
    assert.deepEqual(events, ['error', 'loadend']);
  });

  test('XHR GET passes straight through', async () => {
    const xhr = new page.w.XMLHttpRequest();
    xhr.open('GET', 'https://other.org/api');
    xhr.send();
    await tick();
    assert.equal(page.lastBlocked(), undefined);
    assert.deepEqual(await page.logs(), ['allow']);
  });

  test('form.submit() to same-site is held', async () => {
    const form = page.w.document.createElement('form');
    form.method = 'post';
    form.action = 'https://app.example.com/checkout';
    page.w.document.body.appendChild(form);
    form.submit();
    await tick();
    const blocked = page.lastBlocked();
    assert.equal(blocked.reason, 'Form submission');
    assert.equal(blocked.url, 'https://app.example.com/checkout');
  });

  test('user-triggered submit events are intercepted and cancelled', async () => {
    const form = page.w.document.createElement('form');
    form.method = 'post';
    form.action = 'https://app.example.com/checkout';
    page.w.document.body.appendChild(form);
    const evt = new page.w.Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(evt);
    await tick();
    assert.equal(evt.defaultPrevented, true);
    assert.equal(page.lastBlocked().reason, 'Form submission');
  });

  test('a blocked approval times out to deny after 120s', async () => {
    // Use a fake timer by monkey-patching setTimeout for the interceptor's window.
    const realSetTimeout = page.w.setTimeout;
    let scheduled = null;
    page.w.setTimeout = function (fn, ms) { if (ms === 120000) { scheduled = fn; return 1; } return realSetTimeout(fn, ms); };
    const p = page.w.fetch('/slow', { method: 'POST' });
    await tick();
    assert.ok(scheduled, 'timeout scheduled');
    scheduled();
    const res = await p;
    assert.equal(res.status, 403);
    page.w.setTimeout = realSetTimeout;
  });
});
