'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPage, tick } = require('./helpers/load');

const Redactor = require(path.join(__dirname, '..', 'lib', 'redactor.js'));
const MASK = Redactor.DEFAULT_MASK;
// Engine tests use a plain regex rule; built-in guard patterns are covered in guards.test.js.
const EMAIL = { kind: 'regex', value: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}', flags: 'i' };

describe('redactString', () => {
  test('guards are compiled from config (details in guards.test.js)', () => {
    const c = Redactor.compile({ guards: { email: { enabled: true } }, minCertainty: 6 });
    assert.equal(Redactor.redactString('mail a@b.co', c.text).value, 'mail [REDACTED-EMAIL]');
    assert.equal(Redactor.compile({ guards: {}, minCertainty: 6 }).text.length > 0, true, 'default guards active');
    assert.equal(Redactor.compile([]).text.length, 0, 'array form = custom rules only, no guards');
  });

  test('text rule is literal and case-insensitive', () => {
    const c = Redactor.compile([{ kind: 'text', value: 'Jane (Doe)' }]);
    const r = Redactor.redactString('Hi JANE (doe), jane (Doe) here', c.text);
    assert.equal(r.value, `Hi ${MASK}, ${MASK} here`);
    assert.equal(r.count, 2);
  });

  test('regex rule honours flags and forces global', () => {
    const c = Redactor.compile([{ kind: 'regex', value: 'acme-\\d{6}', flags: 'i' }]);
    const r = Redactor.redactString('ACME-123456 and acme-654321', c.text);
    assert.equal(r.value, `${MASK} and ${MASK}`);
    assert.equal(c.text[0].re.flags, 'gi');
  });

  test('custom replacement text', () => {
    const c = Redactor.compile([Object.assign({}, EMAIL, { replacement: '<email hidden>' })]);
    assert.equal(Redactor.redactString('a@b.co', c.text).value, '<email hidden>');
  });

  test('multiple rules apply in order', () => {
    const c = Redactor.compile([
      EMAIL,
      { kind: 'text', value: 'secret project' }
    ]);
    const r = Redactor.redactString('Secret Project lead: x@y.io', c.text);
    assert.equal(r.value, `${MASK} lead: ${MASK}`);
    assert.equal(r.count, 2);
  });
});

describe('compile / validateRule / scope', () => {
  test('rejects malformed rules and reports errors', () => {
    assert.match(Redactor.validateRule(null), /object/);
    assert.match(Redactor.validateRule({ kind: 'nope', value: 'x' }), /Unknown rule kind/);
    assert.match(Redactor.validateRule({ kind: 'text', value: '   ' }), /required/);
    assert.match(Redactor.validateRule({ kind: 'preset', value: 'email' }), /Unknown rule kind/);
    assert.match(Redactor.validateRule({ kind: 'regex', value: '(' }), /Invalid regular expression/);
    assert.equal(Redactor.validateRule({ kind: 'selector', value: '.x' }), null);

    const c = Redactor.compile([{ kind: 'regex', value: '[' }, EMAIL]);
    assert.equal(c.errors.length, 1);
    assert.equal(c.text.length, 1);
  });

  test('scope limits rules to matching URLs', () => {
    const rules = [
      Object.assign({}, EMAIL, { scope: '*://bank.example.com/*' }),
      { kind: 'selector', value: '.balance', scope: '*://bank.example.com/accounts*' },
      { kind: 'text', value: 'ssn' }
    ];
    const onBank = Redactor.compile(rules, 'https://bank.example.com/accounts/1');
    assert.equal(onBank.text.length, 2);
    assert.equal(onBank.selectors.length, 1);

    const onBankHome = Redactor.compile(rules, 'https://bank.example.com/');
    assert.equal(onBankHome.text.length, 2);
    assert.equal(onBankHome.selectors.length, 0);

    const elsewhere = Redactor.compile(rules, 'https://news.example.org/');
    assert.equal(elsewhere.text.length, 1);
    assert.equal(elsewhere.selectors.length, 0);
  });

  test('inScope treats missing/star scope as global and is case-insensitive', () => {
    assert.equal(Redactor.inScope({}, 'https://x.io'), true);
    assert.equal(Redactor.inScope({ scope: '*' }, 'https://x.io'), true);
    assert.equal(Redactor.inScope({ scope: '*://X.IO/*' }, 'https://x.io/path'), true);
    assert.equal(Redactor.inScope({ scope: '*://x.io/*' }, ''), false);
  });

  test('describeRule returns the rule value', () => {
    assert.equal(Redactor.describeRule({ kind: 'text', value: 'abc' }), 'abc');
    assert.equal(Redactor.describeRule(null), '');
  });

});

describe('redactTree (DOM)', () => {
  let dom, document;

  beforeEach(() => {
    dom = createPage({
      html: `<!doctype html><html><head><title>Inbox for jane@example.com</title></head><body>
        <h1 title="Owner: jane@example.com">Account</h1>
        <p id="p1">Email: jane@example.com, card 4111 1111 1111 1111</p>
        <div class="balance">$12,345.00</div>
        <img alt="photo of jane@example.com">
        <script id="s">var e = "jane@example.com";</script>
        <style>/* jane@example.com */</style>
        <div id="claude-guard-toasts"><div data-claude-guard-toast="x">jane@example.com</div></div>
        <ul><li>bob@example.com</li><li>plain</li></ul>
      </body></html>`
    });
    document = dom.window.document;
  });

  afterEach(() => dom.window.close());

  test('replaces text nodes, attributes and title; skips script/style and own overlays', () => {
    const c = Redactor.compile([EMAIL]);
    const res = Redactor.redactTree(document, c);

    assert.equal(document.title, `Inbox for ${MASK}`);
    assert.equal(document.getElementById('p1').textContent, `Email: ${MASK}, card 4111 1111 1111 1111`);
    assert.equal(document.querySelector('h1').getAttribute('title'), `Owner: ${MASK}`);
    assert.equal(document.querySelector('img').getAttribute('alt'), `photo of ${MASK}`);
    assert.equal(document.querySelector('li').textContent, MASK);
    assert.equal(document.getElementById('s').textContent, 'var e = "jane@example.com";');
    assert.equal(document.querySelector('style').textContent, '/* jane@example.com */');
    assert.equal(document.querySelector('[data-claude-guard-toast]').textContent, 'jane@example.com');
    assert.equal(res.text, 5);
    assert.equal(res.elements, 0);
  });

  test('selector rules remove elements entirely', () => {
    const c = Redactor.compile([{ kind: 'selector', value: '.balance, ul' }]);
    const res = Redactor.redactTree(document, c);
    assert.equal(document.querySelector('.balance'), null);
    assert.equal(document.querySelector('ul'), null);
    assert.equal(res.elements, 2);
    assert.equal(document.body.innerHTML.includes('12,345'), false);
  });

  test('selector rule removes the root itself when it matches', () => {
    const c = Redactor.compile([{ kind: 'selector', value: '.balance' }]);
    const el = document.querySelector('.balance');
    const res = Redactor.redactTree(el, c);
    assert.equal(res.elements, 1);
    assert.equal(el.parentNode, null);
  });

  test('is idempotent', () => {
    const c = Redactor.compile([EMAIL, { kind: 'selector', value: '.balance' }]);
    const first = Redactor.redactTree(document, c);
    const second = Redactor.redactTree(document, c);
    assert.ok(first.text > 0 && first.elements === 1);
    assert.deepEqual(second, { text: 0, elements: 0 });
  });

  test('handles a bare text node and ignores invalid selectors', () => {
    const c = Redactor.compile([EMAIL, { kind: 'selector', value: ':::bad' }]);
    const textNode = document.createTextNode('x@y.io');
    document.body.appendChild(textNode);
    const res = Redactor.redactTree(textNode, c);
    assert.equal(textNode.nodeValue, MASK);
    assert.equal(res.text, 1);
    assert.doesNotThrow(() => Redactor.redactTree(document, c));
  });
});

describe('createRedactor (live)', () => {
  let dom, document, redactor;

  beforeEach(() => {
    dom = createPage({ html: '<!doctype html><html><body><p id="a">a@b.co</p></body></html>' });
    document = dom.window.document;
    redactor = Redactor.createRedactor(document);
  });

  afterEach(() => { redactor.stop(); dom.window.close(); });

  test('start performs a full pass and reports stats', () => {
    const events = [];
    redactor.onRedact((res, stats) => events.push({ res: { ...res }, stats: { ...stats } }));
    const res = redactor.start([EMAIL], 'https://x.io/');
    assert.deepEqual(res, { text: 1, elements: 0 });
    assert.equal(document.getElementById('a').textContent, MASK);
    assert.equal(events.length, 1);
    assert.equal(redactor.isActive(), true);
  });

  test('redacts nodes added later and text changed later', async () => {
    redactor.start([EMAIL, { kind: 'selector', value: '.secret' }], 'https://x.io/');

    const p = document.createElement('p');
    p.innerHTML = 'new <b>c@d.io</b> <span class="secret">hidden</span>';
    document.body.appendChild(p);
    await tick();

    assert.equal(p.querySelector('b').textContent, MASK);
    assert.equal(p.querySelector('.secret'), null);

    document.getElementById('a').firstChild.nodeValue = 'changed to e@f.io';
    await tick();
    assert.equal(document.getElementById('a').textContent, `changed to ${MASK}`);

    document.getElementById('a').setAttribute('title', 'g@h.io');
    await tick();
    assert.equal(document.getElementById('a').getAttribute('title'), MASK);

    assert.equal(redactor.stats.text, 4);
    assert.equal(redactor.stats.elements, 1);
  });

  test('flush processes pending records synchronously', () => {
    redactor.start([EMAIL], 'https://x.io/');
    const p = document.createElement('p');
    p.textContent = 'z@z.io';
    document.body.appendChild(p);
    redactor.flush();
    assert.equal(p.textContent, MASK);
  });

  test('stop disconnects the observer; content is not restored', async () => {
    redactor.start([EMAIL], 'https://x.io/');
    redactor.stop();
    assert.equal(redactor.isActive(), false);
    assert.equal(document.getElementById('a').textContent, MASK);

    const p = document.createElement('p');
    p.textContent = 'after@stop.io';
    document.body.appendChild(p);
    await tick();
    assert.equal(p.textContent, 'after@stop.io');
  });

  test('start with no applicable rules deactivates', () => {
    redactor.start([Object.assign({}, EMAIL, { scope: '*://other.io/*' })], 'https://x.io/');
    assert.equal(redactor.isActive(), false);
    assert.equal(document.getElementById('a').textContent, 'a@b.co');
  });

  test('update swaps rule sets without duplicating observers', async () => {
    redactor.start([{ kind: 'text', value: 'nothing-here' }], 'https://x.io/');
    redactor.update([EMAIL], 'https://x.io/');
    assert.equal(document.getElementById('a').textContent, MASK);

    const p = document.createElement('p');
    p.textContent = 'q@r.io';
    document.body.appendChild(p);
    await tick();
    assert.equal(p.textContent, MASK);
    assert.equal(redactor.stats.text, 2);
  });

  test('errors() exposes skipped rules', () => {
    redactor.start([{ kind: 'regex', value: '(' }, EMAIL], 'https://x.io/');
    assert.equal(redactor.errors().length, 1);
  });
});
