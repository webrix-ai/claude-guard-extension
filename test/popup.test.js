'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require('jsdom');
const { read, evalInWindow, tick } = require('./helpers/load');
const { createChromeMock } = require('./helpers/chrome-mock');

function bootPopup(state, { agentActive = true } = {}) {
  const fullState = Object.assign({
    allowList: [], blockList: [], redactList: [], guards: {}, guardMinCertainty: 6, autoMode: true, redactEnabled: true,
    stats: { blocked: 0, allowed: 0, redacted: 0 }, log: []
  }, state);

  const mock = createChromeMock({
    tabs: [{ id: 1, active: true }],
    onRuntimeMessage(msg) {
      if (msg.type === 'get-state') return JSON.parse(JSON.stringify(fullState));
      if (msg.type === 'get-tab-status') return { agentActive };
      return { ok: true };
    }
  });

  const dom = new JSDOM(read('popup.html'), {
    url: 'chrome-extension://abc/popup.html',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole()
  });
  const w = dom.window;
  w.chrome = mock.chrome;
  evalInWindow(w, 'lib/guards.js');
  evalInWindow(w, 'lib/redactor.js');
  evalInWindow(w, 'popup.js');
  const $ = (id) => w.document.getElementById(id);
  const sentOf = (type) => mock.runtimeSent.filter((m) => m.type === type);
  return { dom, w, $, mock, sentOf };
}

describe('popup', () => {
  let p;
  afterEach(() => p && p.dom.window.close());

  test('renders state: toggles, counters, rule lists, MDM tags, status badge', async () => {
    p = bootPopup({
      autoMode: false,
      redactEnabled: true,
      stats: { blocked: 2, allowed: 9, redacted: 14 },
      allowList: [{ pattern: '*://api.corp.com/*', method: '*', managed: true }, { pattern: '*://mine.io/*', method: 'POST' }],
      blockList: [],
      redactList: [{ kind: 'text', value: 'Jane Doe' }, { kind: 'selector', value: '.balance', scope: '*://bank.io/*', managed: true }]
    });
    await tick();
    await tick();

    assert.equal(p.$('autoMode').checked, false);
    assert.equal(p.$('redactEnabled').checked, true);
    assert.equal(p.$('blockedNum').textContent, '2');
    assert.equal(p.$('allowedNum').textContent, '9');
    assert.equal(p.$('redactedNum').textContent, '14');
    assert.equal(p.$('statusBadge').textContent, 'Active');

    assert.equal(p.$('allowCount').textContent, '2');
    const allowRows = p.$('allowList').querySelectorAll('.rule');
    assert.equal(allowRows.length, 2);
    assert.ok(allowRows[0].querySelector('.tag'), 'managed rule shows MDM tag');
    assert.equal(allowRows[0].querySelector('.remove'), null, 'managed rule has no remove button');
    assert.ok(allowRows[1].querySelector('.remove'));

    assert.equal(p.$('blockList').textContent.trim(), 'No rules');

    const redactRows = p.$('redactList').querySelectorAll('.rule');
    assert.equal(redactRows.length, 2);
    assert.equal(redactRows[0].querySelector('.kind').textContent, 'text');
    assert.equal(redactRows[0].querySelector('.pattern').textContent, 'Jane Doe');
    assert.equal(redactRows[1].querySelector('.scope').textContent, '*://bank.io/*');
    assert.ok(redactRows[1].querySelector('.tag'));
  });

  test('renders built-in guards with defaults, min certainty and MDM state', async () => {
    p = bootPopup({
      guards: { email: { enabled: true, managed: true }, secrets: { enabled: true, disabledChecks: ['regex-jwt-token'] } },
      guardMinCertainty: 7
    });
    await tick();
    await tick();
    const Guards = p.w.ClaudeGuardGuards;
    const rows = [...p.$('guardList').querySelectorAll('.guard')];
    assert.equal(rows.length, Guards.GUARDS.length);
    assert.equal(p.$('guardCount').textContent, '6/10', '5 defaults + managed email');
    assert.equal(p.$('guardMinCertainty').value, '7');
    assert.deepEqual([...p.$('guardMinCertainty').options].map((o) => o.value), ['1','2','3','4','5','6','7','8','9','10']);

    const email = rows.find((r) => r.getAttribute('data-guard') === 'email');
    assert.equal(email.querySelector('[data-guard-enabled]').checked, true);
    assert.equal(email.querySelector('[data-guard-enabled]').disabled, true, 'managed guard is read-only');
    assert.ok(email.querySelector('.tag'));

    const phone = rows.find((r) => r.getAttribute('data-guard') === 'phone');
    assert.equal(phone.querySelector('[data-guard-enabled]').checked, false);
    assert.ok(phone.classList.contains('off'));

    const secrets = rows.find((r) => r.getAttribute('data-guard') === 'secrets');
    const total = Guards.getGuard('secrets').checks.length;
    // one disabled, plus the two certainty-6 checks below min 7
    assert.equal(secrets.querySelector('.guard-meta').textContent, `${total - 3}/${total} checks`);
  });

  test('expanding a guard lists its checks; toggles send guard messages', async () => {
    p = bootPopup();
    await tick();
    await tick();
    assert.equal(p.$('guardList').querySelector('.guard-checks'), null);
    p.$('guardList').querySelector('[data-expand="phone"]').click();
    const checks = [...p.$('guardList').querySelectorAll('[data-guard="phone"] .check')];
    assert.equal(checks.length, p.w.ClaudeGuardGuards.getGuard('phone').checks.length);
    const us = checks.find((c) => c.querySelector('input').getAttribute('data-check') === 'regex-us-phone-number');
    assert.equal(us.querySelector('.certainty').textContent, '6');
    assert.equal(us.querySelector('input').disabled, true, 'checks are read-only while the guard is off');

    const toggle = p.$('guardList').querySelector('[data-guard-enabled="phone"]');
    toggle.checked = true;
    toggle.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await tick();
    assert.deepEqual(p.sentOf('set-guard')[0], { type: 'set-guard', guardId: 'phone', enabled: true });

    p.$('guardMinCertainty').value = '8';
    p.$('guardMinCertainty').dispatchEvent(new p.w.Event('change'));
    await tick();
    assert.deepEqual(p.sentOf('set-guard-min-certainty')[0], { type: 'set-guard-min-certainty', value: 8 });
  });

  test('unchecking a check of an enabled guard sends set-guard-check', async () => {
    p = bootPopup({ guards: { phone: { enabled: true } } });
    await tick();
    await tick();
    p.$('guardList').querySelector('[data-expand="phone"]').click();
    const cb = p.$('guardList').querySelector('[data-guard-check="phone"][data-check="regex-us-phone-number"]');
    assert.equal(cb.disabled, false);
    assert.equal(cb.checked, true);
    cb.checked = false;
    cb.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await tick();
    assert.deepEqual(p.sentOf('set-guard-check')[0], { type: 'set-guard-check', guardId: 'phone', checkId: 'regex-us-phone-number', disabled: true });
  });

  test('adds a text redaction rule with optional scope', async () => {
    p = bootPopup();
    await tick();
    p.$('addRedact').click();
    assert.equal(p.$('redactForm').hidden, false);
    assert.equal(p.$('redactKind').value, 'text');
    p.$('redactValue').value = 'Jane Doe';
    p.$('redactScope').value = ' *://shop.io/* ';
    p.w.document.querySelector('[data-confirm="redact"]').click();
    await tick();

    const [msg] = p.sentOf('add-rule');
    assert.deepEqual(msg, { type: 'add-rule', list: 'redact', rule: { kind: 'text', value: 'Jane Doe', scope: '*://shop.io/*' } });
    assert.equal(p.$('redactForm').hidden, true, 'form closes after add');
  });

  test('switching kind updates the placeholder; invalid regex shows an error and sends nothing', async () => {
    p = bootPopup();
    await tick();
    p.$('addRedact').click();
    p.$('redactKind').value = 'regex';
    p.$('redactKind').dispatchEvent(new p.w.Event('change'));
    assert.match(p.$('redactValue').placeholder, /Regular expression/);

    p.$('redactValue').value = '(unclosed';
    p.$('redactValue').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.equal(p.$('redactError').hidden, false);
    assert.match(p.$('redactError').textContent, /Invalid regular expression/);
    assert.equal(p.sentOf('add-rule').length, 0);

    p.$('redactValue').value = 'ACME-\\d{6}';
    p.$('redactValue').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    assert.deepEqual(p.sentOf('add-rule')[0].rule, { kind: 'regex', value: 'ACME-\\d{6}' });
  });

  test('invalid CSS selector is rejected client-side', async () => {
    p = bootPopup();
    await tick();
    p.$('addRedact').click();
    p.$('redactKind').value = 'selector';
    p.$('redactKind').dispatchEvent(new p.w.Event('change'));
    p.$('redactValue').value = ':::nope';
    p.w.document.querySelector('[data-confirm="redact"]').click();
    await tick();
    assert.match(p.$('redactError').textContent, /Invalid CSS selector/);
    assert.equal(p.sentOf('add-rule').length, 0);
  });

  test('remove buttons send the merged-list index; toggles send their messages', async () => {
    p = bootPopup({
      redactList: [{ kind: 'text', value: 'Acme', managed: true }, { kind: 'text', value: 'Jane' }]
    });
    await tick();
    await tick();
    const removeBtn = p.$('redactList').querySelector('.remove[data-type="redact"]');
    assert.equal(removeBtn.getAttribute('data-index'), '1');
    removeBtn.click();
    await tick();
    assert.deepEqual(p.sentOf('remove-rule')[0], { type: 'remove-rule', list: 'redact', index: 1 });

    p.$('redactEnabled').checked = false;
    p.$('redactEnabled').dispatchEvent(new p.w.Event('change'));
    await tick();
    assert.deepEqual(p.sentOf('set-redact-enabled')[0], { type: 'set-redact-enabled', enabled: false });

    p.$('autoMode').checked = false;
    p.$('autoMode').dispatchEvent(new p.w.Event('change'));
    await tick();
    assert.deepEqual(p.sentOf('set-auto-mode')[0], { type: 'set-auto-mode', enabled: false });

    p.$('clearStats').click();
    await tick();
    assert.equal(p.sentOf('clear-stats').length, 1);
  });

  test('allow/block forms still work', async () => {
    p = bootPopup();
    await tick();
    p.$('addBlock').click();
    p.$('blockPattern').value = '*://evil.io/*';
    p.$('blockMethod').value = 'GET';
    p.w.document.querySelector('[data-confirm="block"]').click();
    await tick();
    assert.deepEqual(p.sentOf('add-rule')[0], { type: 'add-rule', list: 'block', rule: { pattern: '*://evil.io/*', method: 'GET' } });
  });
});
