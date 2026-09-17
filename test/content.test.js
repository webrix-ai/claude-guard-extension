'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPage, evalInWindow, tick } = require('./helpers/load');
const { createChromeMock } = require('./helpers/chrome-mock');

const MASK = '[REDACTED-EMAIL]';

/**
 * Boot lib/redactor.js + content.js in a page with a chrome mock that answers
 * runtime messages the way background.js would.
 */
function bootContent({ agentActive = true, state = {}, html } = {}) {
  const fullState = Object.assign({
    allowList: [], blockList: [], redactList: [], guards: {}, guardMinCertainty: 6, autoMode: true, redactEnabled: true,
    stats: { blocked: 0, allowed: 0, redacted: 0 }, log: []
  }, state);

  const mock = createChromeMock({
    onRuntimeMessage(msg) {
      if (msg.type === 'check-agent-status') return { agentActive };
      if (msg.type === 'get-state') return JSON.parse(JSON.stringify(fullState));
      return { ok: true };
    }
  });

  const dom = createPage({
    html: html || `<!doctype html><html><head><title>Mail</title></head><body>
      <p id="p1">Owner: jane@example.com</p>
      <div class="balance">$500</div>
    </body></html>`
  });
  const w = dom.window;
  w.chrome = mock.chrome;

  const toInterceptor = [];
  w.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'cg-cs') toInterceptor.push(e.data);
  });

  evalInWindow(w, 'lib/guards.js');
  evalInWindow(w, 'lib/redactor.js');
  evalInWindow(w, 'content.js');

  /** Simulate a message from the background service worker. */
  async function fromBackground(msg) {
    mock.chrome.runtime.onMessage._fns.forEach((fn) => fn(msg, {}, () => {}));
    await tick(); // let any resulting window.postMessage land
  }

  /** Simulate a message from the MAIN-world interceptor. */
  async function fromInterceptor(msg) {
    w.postMessage(Object.assign({ source: 'cg-int' }, msg), '*');
    await tick();
  }

  return { dom, w, mock, toInterceptor, fromBackground, fromInterceptor, state: fullState };
}

describe('content script: activation & redaction', () => {
  let page;
  afterEach(() => page && page.dom.window.close());

  test('activates immediately when the tab is already an agent tab and redacts the page', async () => {
    page = bootContent({ state: { guards: { email: { enabled: true } }, redactList: [{ kind: 'selector', value: '.balance' }] } });
    await tick();
    await tick();

    const activate = page.toInterceptor.find((m) => m.type === 'activate');
    assert.ok(activate, 'interceptor told to activate');
    assert.equal(activate.auto, true);

    const doc = page.w.document;
    assert.equal(doc.getElementById('p1').textContent, `Owner: ${MASK}`);
    assert.equal(doc.querySelector('.balance'), null);

    // Batched stats report to background + visible toast for the agent.
    await tick(500);
    const report = page.mock.runtimeSent.find((m) => m.type === 'redact-event');
    assert.ok(report, 'redact-event sent');
    assert.equal(report.count, 2);
    const toast = doc.querySelector('[data-claude-guard-toast="redacted"]');
    assert.match(toast.textContent, /Redacted 2 sensitive items/);
  });

  test('does not redact when the agent is not active', async () => {
    page = bootContent({ agentActive: false, state: { guards: { email: { enabled: true } } } });
    await tick();
    await tick();
    assert.equal(page.toInterceptor.length, 0);
    assert.equal(page.w.document.getElementById('p1').textContent, 'Owner: jane@example.com');
  });

  test('detects the agent glow border by polling and activates', async () => {
    page = bootContent({ agentActive: false, state: { guards: { email: { enabled: true } } } });
    await tick();
    const glow = page.w.document.createElement('div');
    glow.id = 'claude-agent-glow-border';
    page.w.document.body.appendChild(glow);

    // Poll interval is 2s; wait for it.
    await tick(2200);
    await tick();
    assert.ok(page.mock.runtimeSent.some((m) => m.type === 'agent-on'));
    assert.equal(page.w.document.getElementById('p1').textContent, `Owner: ${MASK}`);

    glow.remove();
    await tick(2200);
    assert.ok(page.mock.runtimeSent.some((m) => m.type === 'agent-off'));
    assert.ok(page.toInterceptor.some((m) => m.type === 'deactivate'));
  });

  test('respects the redaction toggle and live rule updates', async () => {
    page = bootContent({ state: { guards: { email: { enabled: true } }, redactEnabled: false } });
    await tick();
    await tick();
    const doc = page.w.document;
    assert.equal(doc.getElementById('p1').textContent, 'Owner: jane@example.com', 'disabled → untouched');

    await page.fromBackground({
      type: 'rules-updated', allowList: [], blockList: [], autoMode: true,
      redactEnabled: true, guards: { email: { enabled: true } }
    });
    assert.equal(doc.getElementById('p1').textContent, `Owner: ${MASK}`);
    const update = page.toInterceptor.find((m) => m.type === 'update');
    assert.ok(update, 'interceptor receives rule update');

    // Turn it back off: new content is left alone.
    await page.fromBackground({ type: 'rules-updated', allowList: [], blockList: [], autoMode: true, redactEnabled: false, guards: { email: { enabled: true } } });
    const p = doc.createElement('p');
    p.textContent = 'late@example.com';
    doc.body.appendChild(p);
    await tick();
    assert.equal(p.textContent, 'late@example.com');
  });

  test('scoped rules only apply on matching pages', async () => {
    page = bootContent({ state: { guards: {}, redactList: [{ kind: 'regex', value: '[a-z]+@[a-z.]+', scope: '*://bank.example.com/*' }] } });
    await tick();
    await tick();
    assert.equal(page.w.document.getElementById('p1').textContent, 'Owner: jane@example.com');
  });

  test('group peers activate on group-agent-on and stop on group-agent-off', async () => {
    page = bootContent({ agentActive: false, state: { guards: { email: { enabled: true } } } });
    await tick();
    await page.fromBackground({ type: 'group-agent-on' });
    await tick();
    await tick();
    assert.equal(page.w.document.getElementById('p1').textContent, `Owner: ${MASK}`);

    await page.fromBackground({ type: 'group-agent-off' });
    assert.ok(page.toInterceptor.some((m) => m.type === 'deactivate'));
    const p = page.w.document.createElement('p');
    p.textContent = 'x@y.io';
    page.w.document.body.appendChild(p);
    await tick();
    assert.equal(p.textContent, 'x@y.io');
  });
});

describe('content script: approval UI bridge', () => {
  let page;
  beforeEach(async () => { page = bootContent(); await tick(); await tick(); });
  afterEach(() => page.dom.window.close());

  test('blocked request shows banner, updates title, forwards to background; decision clears it', async () => {
    const doc = page.w.document;
    await page.fromInterceptor({ id: 1, type: 'blocked', method: 'POST', url: 'https://app.example.com/pay', reason: 'Same-site POST request', headers: { a: 'b' }, body: '{}' });

    const banner = doc.getElementById('claude-guard-waiting');
    assert.ok(banner);
    assert.match(banner.textContent, /1 request pending/);
    assert.match(doc.title, /BLOCKED/);
    assert.ok(doc.querySelector('[data-claude-guard-toast="blocked"]'));

    const forwarded = page.mock.runtimeSent.find((m) => m.type === 'request-blocked');
    assert.equal(forwarded.id, 1);
    assert.equal(forwarded.method, 'POST');
    assert.deepEqual(forwarded.headers, { a: 'b' });

    await page.fromInterceptor({ id: 2, type: 'blocked', method: 'DELETE', url: 'https://app.example.com/x', reason: 'r' });
    assert.match(doc.getElementById('claude-guard-waiting').textContent, /2 requests pending/);

    await page.fromBackground({ type: 'approval-decision', id: 1, action: 'deny', method: 'POST', url: 'https://app.example.com/pay' });
    await tick();
    assert.match(doc.getElementById('claude-guard-waiting').textContent, /1 request pending/);
    assert.ok(doc.querySelector('[data-claude-guard-toast="denied"]'));
    const decision = page.toInterceptor.find((m) => m.type === 'decision');
    assert.deepEqual({ id: decision.id, action: decision.action }, { id: 1, action: 'deny' });

    await page.fromBackground({ type: 'approval-decision', id: 2, action: 'allow-once', method: 'DELETE', url: 'https://app.example.com/x' });
    assert.equal(doc.getElementById('claude-guard-waiting'), null);
    assert.equal(doc.title, 'Mail');
    assert.ok(doc.querySelector('[data-claude-guard-toast="approved"]'));
  });

  test('log messages from the interceptor are forwarded', async () => {
    await page.fromInterceptor({ type: 'log', method: 'GET', url: 'https://x.io', action: 'allow' });
    const log = page.mock.runtimeSent.find((m) => m.type === 'log-event');
    assert.deepEqual(log.event, { method: 'GET', url: 'https://x.io', action: 'allow' });
  });
});
