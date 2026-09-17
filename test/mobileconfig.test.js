'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { ROOT } = require('./helpers/load');

const SCRIPT = path.join(ROOT, 'generate-mobileconfig.sh');
const hasUuidgen = spawnSync('uuidgen').status === 0;

function generate(args) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-')), 'p.mobileconfig');
  execFileSync('bash', [SCRIPT, '--output', out, ...args], { stdio: 'pipe' });
  return fs.readFileSync(out, 'utf8');
}

/** Tiny plist reader: returns the <dict> entries of an <array> under `key`. */
function dictsUnder(xml, key) {
  const start = xml.indexOf(`<key>${key}</key>`);
  assert.notEqual(start, -1, `${key} present`);
  const arrStart = xml.indexOf('<array>', start);
  const arrEnd = xml.indexOf('</array>', arrStart);
  const body = xml.slice(arrStart, arrEnd);
  return [...body.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((m) => {
    const d = {};
    for (const kv of m[1].matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) d[kv[1]] = kv[2];
    return d;
  });
}

describe('generate-mobileconfig.sh', { skip: !hasUuidgen && 'uuidgen not available' }, () => {
  test('emits allow/block/redact lists under the extension policy domain', () => {
    const xml = generate([
      '--extension-id', 'abcdefghijklmnopabcdefghijklmnop',
      '--allow', '*://api.github.com/*',
      '--block', '*://evil.example.com/*|POST',
      '--redact', 'text:Jane Doe',
      '--redact', 'selector:.balance|*://bank.example.com/*',
      '--redact', 'regex:ACME-\\d{6}'
    ]);

    assert.ok(xml.includes('<key>com.google.Chrome.extensions.abcdefghijklmnopabcdefghijklmnop</key>'));
    assert.deepEqual(dictsUnder(xml, 'allowList'), [{ pattern: '*://api.github.com/*', method: '*' }]);
    assert.deepEqual(dictsUnder(xml, 'blockList'), [{ pattern: '*://evil.example.com/*', method: 'POST' }]);
    assert.deepEqual(dictsUnder(xml, 'redactList'), [
      { kind: 'text', value: 'Jane Doe' },
      { kind: 'selector', value: '.balance', scope: '*://bank.example.com/*' },
      { kind: 'regex', value: 'ACME-\\d{6}' }
    ]);
  });

  test('emits guard overrides and min certainty', () => {
    const xml = generate([
      '--guard', 'email:on',
      '--guard', 'phone:off',
      '--disable-check', 'phone:regex-us-phone-number',
      '--disable-check', 'secrets:regex-jwt-token',
      '--min-certainty', '7'
    ]);
    assert.ok(xml.includes('<key>guardMinCertainty</key>\n                <integer>7</integer>'));
    const guards = xml.slice(xml.indexOf('<key>guards</key>'));
    assert.match(guards, /<key>email<\/key>\s*<dict>\s*<key>enabled<\/key>\s*<true\/>/);
    assert.match(guards, /<key>phone<\/key>\s*<dict>\s*<key>enabled<\/key>\s*<false\/>\s*<key>disabledChecks<\/key>\s*<array>\s*<string>regex-us-phone-number<\/string>/);
    assert.match(guards, /<key>secrets<\/key>\s*<dict>\s*<key>disabledChecks<\/key>\s*<array>\s*<string>regex-jwt-token<\/string>/);
    assert.ok(!xml.includes('<key>redactList</key>'));
  });

  test('validates guard flags', () => {
    for (const args of [['--guard', 'email:maybe'], ['--guard', 'email'], ['--disable-check', 'phone'], ['--min-certainty', '11'], ['--min-certainty', 'x']]) {
      const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
      assert.notEqual(r.status, 0, args.join(' '));
    }
  });

  test('XML-escapes rule values', () => {
    const xml = generate(['--redact', 'text:Tom & Jerry <3']);
    assert.ok(xml.includes('<string>Tom &amp; Jerry &lt;3</string>'));
  });

  test('rejects malformed redact rules and empty invocations', () => {
    const bad = spawnSync('bash', [SCRIPT, '--redact', 'bogus:x'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /invalid --redact rule/);

    const noValue = spawnSync('bash', [SCRIPT, '--redact', 'text'], { encoding: 'utf8' });
    assert.notEqual(noValue.status, 0);

    const empty = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stdout + empty.stderr, /at least one/);
  });
});
