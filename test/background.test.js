'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createChromeMock } = require('./helpers/chrome-mock');
const { loadBackground, tick } = require('./helpers/load');

function boot(options) {
  const mock = createChromeMock(options);
  loadBackground(mock.chrome);
  return mock;
}

describe('background: state', () => {
  test('get-state returns defaults on a fresh install', async () => {
    const m = boot();
    const s = await m.dispatch({ type: 'get-state' });
    assert.deepEqual(s.allowList, []);
    assert.deepEqual(s.blockList, []);
    assert.deepEqual(s.redactList, []);
    assert.equal(s.autoMode, true);
    assert.equal(s.redactEnabled, true);
    assert.deepEqual(s.stats, { blocked: 0, allowed: 0, redacted: 0 });
  });

  test('migrates older state that lacks redaction fields', async () => {
    const m = boot({ local: { cg: { allowList: [{ pattern: 'a', method: '*' }], blockList: [], autoMode: false, stats: { blocked: 3, allowed: 4 }, log: [] } } });
    const s = await m.dispatch({ type: 'get-state' });
    assert.equal(s.autoMode, false);
    assert.deepEqual(s.redactList, []);
    assert.equal(s.redactEnabled, true);
    assert.deepEqual(s.stats, { blocked: 3, allowed: 4, redacted: 0 });
  });

  test('managed rules are merged first, tagged, and never persisted locally', async () => {
    const m = boot({
      managed: {
        allowList: [{ pattern: '*://api.corp.com/*', method: '*' }],
        redactList: [{ kind: 'text', value: 'Project Falcon' }]
      },
      local: { cg: { allowList: [{ pattern: '*://mine.io/*', method: 'POST' }], blockList: [], redactList: [{ kind: 'text', value: 'x' }] } }
    });
    const s = await m.dispatch({ type: 'get-state' });
    assert.equal(s.allowList.length, 2);
    assert.equal(s.allowList[0].managed, true);
    assert.equal(s.allowList[0].pattern, '*://api.corp.com/*');
    assert.equal(s.allowList[1].managed, undefined);
    assert.equal(s.redactList[0].managed, true);
    assert.equal(s.redactList[1].kind, 'text');

    await m.dispatch({ type: 'set-auto-mode', enabled: false });
    assert.equal(m.localStore.cg.allowList.length, 1);
    assert.equal(m.localStore.cg.redactList.length, 1);
    assert.equal(m.localStore.cg.allowList[0].pattern, '*://mine.io/*');
  });

  test('managed policy change re-broadcasts rules to all tabs', async () => {
    const m = boot({ tabs: [{ id: 1 }, { id: 2 }] });
    m.fireManagedChange({ redactList: [{ kind: 'text', value: 'Project Falcon' }] });
    await tick();
    const updates = m.sent.filter((s) => s.msg.type === 'rules-updated');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].msg.redactList[0].managed, true);
  });
});

describe('background: rules', () => {
  test('add-rule appends, deduplicates and broadcasts', async () => {
    const m = boot({ tabs: [{ id: 7 }] });
    const r1 = await m.dispatch({ type: 'add-rule', list: 'allow', rule: { pattern: '*://a.io/*', method: '*' } });
    const r2 = await m.dispatch({ type: 'add-rule', list: 'allow', rule: { pattern: '*://a.io/*', method: '*' } });
    assert.deepEqual(r1, { ok: true, added: true });
    assert.deepEqual(r2, { ok: true, added: false });
    assert.equal(m.localStore.cg.allowList.length, 1);
    const broadcasts = m.sent.filter((s) => s.msg.type === 'rules-updated');
    assert.equal(broadcasts.length, 2);
    assert.equal(broadcasts[0].tabId, 7);
    assert.deepEqual(Object.keys(broadcasts[0].msg).sort(), ['allowList', 'autoMode', 'blockList', 'guardMinCertainty', 'guards', 'redactEnabled', 'redactList', 'type']);
  });

  test('add-rule for redact list dedupes on kind+value+scope and strips managed flag', async () => {
    const m = boot();
    await m.dispatch({ type: 'add-rule', list: 'redact', rule: { kind: 'text', value: 'Jane', managed: true } });
    await m.dispatch({ type: 'add-rule', list: 'redact', rule: { kind: 'text', value: 'Jane', scope: '*' } });
    await m.dispatch({ type: 'add-rule', list: 'redact', rule: { kind: 'text', value: 'Jane', scope: '*://x.io/*' } });
    assert.equal(m.localStore.cg.redactList.length, 2);
    assert.equal(m.localStore.cg.redactList[0].managed, undefined);
  });

  test('add-rule rejects unknown lists and malformed rules', async () => {
    const m = boot();
    const r = await m.dispatch({ type: 'add-rule', list: 'nope', rule: { pattern: 'x' } });
    assert.equal(r.ok, false);
    const r2 = await m.dispatch({ type: 'add-rule', list: 'block', rule: null });
    assert.equal(r2.ok, false);
  });

  test('remove-rule removes by index in the merged list and protects managed rules', async () => {
    const m = boot({
      managed: { blockList: [{ pattern: '*://policy.io/*', method: '*' }] },
      local: { cg: { allowList: [], blockList: [{ pattern: '*://mine.io/*', method: '*' }, { pattern: '*://two.io/*', method: 'GET' }] } }
    });
    const denied = await m.dispatch({ type: 'remove-rule', list: 'block', index: 0 });
    assert.equal(denied.ok, false);
    const ok = await m.dispatch({ type: 'remove-rule', list: 'block', index: 1 });
    assert.equal(ok.ok, true);
    assert.deepEqual(m.localStore.cg.blockList, [{ pattern: '*://two.io/*', method: 'GET' }]);
    const oob = await m.dispatch({ type: 'remove-rule', list: 'block', index: 99 });
    assert.equal(oob.ok, false);
  });

  test('set-redact-enabled toggles and broadcasts', async () => {
    const m = boot({ tabs: [{ id: 1 }] });
    await m.dispatch({ type: 'set-redact-enabled', enabled: false });
    assert.equal(m.localStore.cg.redactEnabled, false);
    const b = m.sent.find((s) => s.msg.type === 'rules-updated');
    assert.equal(b.msg.redactEnabled, false);
  });
});

describe('background: guard settings', () => {
  test('defaults expose empty overrides and the default min certainty', async () => {
    const m = boot();
    const s = await m.dispatch({ type: 'get-state' });
    assert.deepEqual(s.guards, {});
    assert.equal(s.guardMinCertainty, 6);
    assert.equal(s.guardMinCertaintyManaged, undefined);
  });

  test('set-guard toggles a guard and broadcasts; set-guard-check toggles single checks', async () => {
    const m = boot({ tabs: [{ id: 1 }] });
    await m.dispatch({ type: 'set-guard', guardId: 'email', enabled: true });
    await m.dispatch({ type: 'set-guard-check', guardId: 'phone', checkId: 'regex-us-phone-number', disabled: true });
    await m.dispatch({ type: 'set-guard-check', guardId: 'phone', checkId: 'regex-uk-phone-number', disabled: true });
    await m.dispatch({ type: 'set-guard-check', guardId: 'phone', checkId: 'regex-us-phone-number', disabled: false });

    const s = await m.dispatch({ type: 'get-state' });
    assert.deepEqual(s.guards, {
      email: { enabled: true },
      phone: { disabledChecks: ['regex-uk-phone-number'] }
    });
    const last = m.sent.filter((x) => x.msg.type === 'rules-updated').pop();
    assert.deepEqual(last.msg.guards, s.guards);
    assert.equal(last.msg.guardMinCertainty, 6);
  });

  test('set-guard-min-certainty clamps to 1..10', async () => {
    const m = boot();
    assert.deepEqual(await m.dispatch({ type: 'set-guard-min-certainty', value: 42 }), { ok: true, value: 10 });
    assert.deepEqual(await m.dispatch({ type: 'set-guard-min-certainty', value: -3 }), { ok: true, value: 1 });
    assert.deepEqual(await m.dispatch({ type: 'set-guard-min-certainty', value: 'nope' }), { ok: true, value: 6 });
  });

  test('rejects malformed guard messages', async () => {
    const m = boot();
    assert.equal((await m.dispatch({ type: 'set-guard', guardId: 7, enabled: true })).ok, false);
    assert.equal((await m.dispatch({ type: 'set-guard-check', guardId: 'x' })).ok, false);
  });

  test('managed guard settings override local, are read-only and never persisted', async () => {
    const m = boot({
      managed: { guards: { email: { enabled: true }, secrets: { disabledChecks: ['regex-jwt-token'] } }, guardMinCertainty: 8 },
      local: { cg: { guards: { email: { enabled: false }, phone: { enabled: true } }, guardMinCertainty: 3 } }
    });
    const s = await m.dispatch({ type: 'get-state' });
    assert.deepEqual(s.guards.email, { enabled: true, managed: true });
    assert.deepEqual(s.guards.secrets, { disabledChecks: ['regex-jwt-token'], managed: true });
    assert.deepEqual(s.guards.phone, { enabled: true });
    assert.equal(s.guardMinCertainty, 8);
    assert.equal(s.guardMinCertaintyManaged, true);

    assert.equal((await m.dispatch({ type: 'set-guard', guardId: 'email', enabled: false })).ok, false);
    assert.equal((await m.dispatch({ type: 'set-guard-check', guardId: 'secrets', checkId: 'x', disabled: true })).ok, false);
    assert.equal((await m.dispatch({ type: 'set-guard-min-certainty', value: 2 })).ok, false);

    await m.dispatch({ type: 'set-guard', guardId: 'dob', enabled: true });
    assert.deepEqual(m.localStore.cg.guards, { phone: { enabled: true }, dob: { enabled: true } });
    assert.equal(m.localStore.cg.guardMinCertainty, undefined, 'managed value not written locally');
    assert.equal(m.localStore.cg.guardMinCertaintyManaged, undefined);
  });
});

describe('background: stats & log', () => {
  test('log-event updates counters and caps the log at 200', async () => {
    const m = boot();
    for (let i = 0; i < 205; i++) {
      await m.dispatch({ type: 'log-event', event: { method: 'POST', url: `https://x.io/${i}`, action: i % 2 ? 'block' : 'allow' } });
    }
    const s = await m.dispatch({ type: 'get-state' });
    assert.equal(s.log.length, 200);
    assert.equal(s.log[0].url, 'https://x.io/204');
    assert.equal(s.stats.blocked, 102);
    assert.equal(s.stats.allowed, 103);
  });

  test('redact-event accumulates and clear-stats resets everything', async () => {
    const m = boot();
    await m.dispatch({ type: 'redact-event', count: 3 });
    await m.dispatch({ type: 'redact-event', count: 2 });
    await m.dispatch({ type: 'redact-event', count: -5 });
    await m.dispatch({ type: 'redact-event', count: 'bogus' });
    let s = await m.dispatch({ type: 'get-state' });
    assert.equal(s.stats.redacted, 5);
    await m.dispatch({ type: 'clear-stats' });
    s = await m.dispatch({ type: 'get-state' });
    assert.deepEqual(s.stats, { blocked: 0, allowed: 0, redacted: 0 });
    assert.deepEqual(s.log, []);
  });
});

describe('background: agent tabs & approvals', () => {
  test('agent-on activates the tab and its group peers; agent-off reverses', async () => {
    const m = boot({ tabs: [{ id: 1, groupId: 5 }, { id: 2, groupId: 5 }, { id: 3, groupId: -1 }] });
    await m.dispatch({ type: 'agent-on' }, { tab: { id: 1, groupId: 5 } });
    await tick();
    assert.deepEqual(await m.dispatch({ type: 'get-tab-status', tabId: 1 }), { agentActive: true });
    assert.deepEqual(await m.dispatch({ type: 'get-tab-status', tabId: 2 }), { agentActive: true });
    assert.deepEqual(await m.dispatch({ type: 'get-tab-status', tabId: 3 }), { agentActive: false });
    assert.ok(m.sent.some((s) => s.tabId === 2 && s.msg.type === 'group-agent-on'));
    assert.deepEqual(await m.dispatch({ type: 'check-agent-status' }, { tab: { id: 2 } }), { agentActive: true });

    await m.dispatch({ type: 'agent-off' }, { tab: { id: 1, groupId: 5 } });
    await tick();
    assert.deepEqual(await m.dispatch({ type: 'get-tab-status', tabId: 1 }), { agentActive: false });
    assert.deepEqual(await m.dispatch({ type: 'get-tab-status', tabId: 2 }), { agentActive: false });
    assert.ok(m.sent.some((s) => s.tabId === 2 && s.msg.type === 'group-agent-off'));
  });

  test('request-blocked opens the approval window once and queues further requests', async () => {
    const m = boot();
    await m.dispatch({ type: 'request-blocked', id: 1, method: 'POST', url: 'https://x.io/a', reason: 'r' }, { tab: { id: 4 } });
    await tick();
    assert.equal(m.windows.created.length, 1);
    assert.equal(m.windows.created[0].url, 'approve.html');

    // Approval page connects and asks for pending requests.
    const port = makePort('approve');
    m.chrome.runtime.onConnect._fns.forEach((fn) => fn(port));
    port.receive({ type: 'ready' });
    assert.equal(port.posted[0].type, 'pending-requests');
    assert.equal(port.posted[0].requests.length, 1);

    await m.dispatch({ type: 'request-blocked', id: 2, method: 'DELETE', url: 'https://x.io/b', reason: 'r' }, { tab: { id: 4 } });
    assert.equal(m.windows.created.length, 1, 'no second window');
    assert.equal(port.posted[1].type, 'new-request');

    // Deny #1, always-allow #2 → decision forwarded to tab, rule added, window closed.
    port.receive({ type: 'decision', id: 1, action: 'deny' });
    port.receive({ type: 'decision', id: 2, action: 'allow-always' });
    await tick();
    const decisions = m.sent.filter((s) => s.msg.type === 'approval-decision');
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].msg.action, 'deny');
    assert.equal(decisions[1].msg.action, 'allow-always');
    assert.deepEqual(m.localStore.cg.allowList, [{ pattern: '*://x.io/*', method: '*' }]);
    assert.equal(m.windows.removed.length, 1);
  });

  test('closing the approval window denies everything pending', async () => {
    const m = boot();
    await m.dispatch({ type: 'request-blocked', id: 9, method: 'POST', url: 'https://x.io/a', reason: 'r' }, { tab: { id: 4 } });
    await tick();
    const winId = m.windows.created[0].id;
    m.chrome.windows.onRemoved._fns.forEach((fn) => fn(winId));
    const decisions = m.sent.filter((s) => s.msg.type === 'approval-decision');
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].msg.action, 'deny');
    assert.equal(decisions[0].msg.id, 9);
  });
});

function makePort(name) {
  const onMessage = [];
  const onDisconnect = [];
  return {
    name,
    posted: [],
    postMessage(msg) { this.posted.push(JSON.parse(JSON.stringify(msg))); },
    onMessage: { addListener(fn) { onMessage.push(fn); } },
    onDisconnect: { addListener(fn) { onDisconnect.push(fn); } },
    receive(msg) { onMessage.forEach((fn) => fn(msg)); },
    disconnect() { onDisconnect.forEach((fn) => fn()); }
  };
}
