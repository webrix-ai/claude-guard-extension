'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Guards = require(path.join(__dirname, '..', 'lib', 'guards.js'));
const Redactor = require(path.join(__dirname, '..', 'lib', 'redactor.js'));

const ALL_ON = {};
Guards.GUARDS.forEach((g) => { ALL_ON[g.id] = { enabled: true }; });

/** Redact with every guard on and every check active. */
function redactAll(text) {
  return Redactor.redactString(text, Redactor.compile({ guards: ALL_ON, minCertainty: 1 }).text).value;
}

describe('guards catalog', () => {
  test('has the expected Willow guard ids, unique check ids and compilable patterns', () => {
    assert.deepEqual(Guards.GUARDS.map((g) => g.id), [
      'secrets', 'email', 'phone', 'ssn', 'credit-card', 'ip-address', 'financial', 'dob', 'government-id', 'address'
    ]);
    const ids = new Set();
    for (const g of Guards.GUARDS) {
      assert.ok(g.name && g.description);
      assert.ok(g.checks.length > 0, g.id);
      for (const c of g.checks) {
        assert.match(c.id, /^regex-[a-z0-9-]+$/);
        assert.ok(!ids.has(c.id), `duplicate check id ${c.id}`);
        ids.add(c.id);
        assert.ok(c.certainty >= 1 && c.certainty <= 10, c.id);
        assert.match(c.replacement, /^\[REDACTED-[A-Z-]+\]$/);
        assert.doesNotThrow(() => new RegExp(c.pattern, 'g'), c.id);
      }
    }
    assert.equal(Guards.getGuard('email').id, 'email');
    assert.equal(Guards.getGuard('nope'), null);
    assert.equal(Guards.findCheck(Guards.getGuard('phone'), 'regex-us-phone-number').certainty, 6);
  });

  test('check ids follow Willow slug format', () => {
    assert.equal(Guards.slugify('Stripe / Platform API Key'), 'stripe-platform-api-key');
    assert.equal(Guards.slugify('SWIFT/BIC Code'), 'swift-bic-code');
  });

  test('sensible defaults: high-precision guards on, noisy ones off', () => {
    const on = Guards.GUARDS.filter((g) => g.defaultEnabled).map((g) => g.id);
    assert.deepEqual(on, ['secrets', 'ssn', 'credit-card', 'financial', 'government-id']);
  });
});

describe('guard checks match Willow samples', () => {
  test('secrets', () => {
    const cases = {
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz': '[REDACTED-ANTHROPIC-KEY]',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789': '[REDACTED-GITHUB-TOKEN]',
      'AKIAIOSFODNN7EXAMPLE': '[REDACTED-AWS-ACCESS-KEY]',
      'AIzaSyA-1234567890abcdefghijklmnopqrstu': '[REDACTED-GOOGLE-API-KEY]',
      'xoxb-1234567890-abcdefghij': '[REDACTED-SLACK-TOKEN]',
      '-----BEGIN RSA PRIVATE KEY-----': '[REDACTED-PRIVATE-KEY]',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N': '[REDACTED-JWT]',
      'postgres://admin:s3cret@db.internal:5432/app': '[REDACTED-DB-CONNECTION]',
      'password: hunter2hunter2': '[REDACTED-PASSWORD]',
      'sk_live_abcdefghijklmnopqrstuvwxyz': '[REDACTED-API-KEY]'
    };
    for (const [input, expected] of Object.entries(cases)) {
      assert.equal(redactAll(`x ${input} y`), `x ${expected} y`, input);
    }
    assert.equal(redactAll('skate park and a token of appreciation'), 'skate park and a token of appreciation');
  });

  test('email / phone / ssn / card / ip', () => {
    assert.equal(redactAll('mail jane.doe@example.co.uk now'), 'mail [REDACTED-EMAIL] now');
    assert.equal(redactAll('call (555) 123-4567'), 'call [REDACTED-PHONE]');
    assert.equal(redactAll('call +44 20 7946 0958'), 'call [REDACTED-PHONE]');
    assert.equal(redactAll('SSN: 123-45-6789'), 'SSN: [REDACTED-SSN]');
    assert.equal(redactAll('card 4111 1111 1111 1111'), 'card [REDACTED-CREDIT-CARD]');
    assert.equal(redactAll('amex 3782 822463 10005'), 'amex [REDACTED-CREDIT-CARD]');
    assert.equal(redactAll('host 10.0.0.12 up'), 'host [REDACTED-IP-ADDRESS] up');
    assert.equal(redactAll('mac 00:1A:2B:3C:4D:5E'), 'mac [REDACTED-MAC-ADDRESS]');
  });

  test('card checks are Luhn-validated (extension addition)', () => {
    const text = Redactor.compile({ guards: { 'credit-card': { enabled: true } }, minCertainty: 1 }).text;
    const only = (s) => Redactor.redactString(s, text).value;
    assert.equal(only('card 4111 1111 1111 1111'), 'card [REDACTED-CREDIT-CARD]');
    assert.equal(only('card 4111 1111 1111 1112'), 'card 4111 1111 1111 1112');
    assert.equal(only('card 0000 0000 0000 0000'), 'card 0000 0000 0000 0000');
    assert.equal(Guards.luhn('4111111111111111'), true);
    assert.equal(Guards.luhn('4111111111111112'), false);
  });

  test('financial / dob / government id / address', () => {
    assert.equal(redactAll('IBAN GB29NWBK60161331926819'), 'IBAN [REDACTED-IBAN]');
    assert.equal(redactAll('Routing: 021000021'), '[REDACTED-ROUTING]');
    assert.equal(redactAll('Date of birth: 04/12/1980'), '[REDACTED-DOB]');
    assert.equal(redactAll('Passport: A12345678'), '[REDACTED-PASSPORT]');
    assert.equal(redactAll('NIN AB123456C'), 'NIN [REDACTED-NIN]');
    assert.equal(redactAll('at 221 Baker Street, Apt 4'), 'at [REDACTED-ADDRESS]');
    assert.equal(redactAll('PO Box 1234'), '[REDACTED-ADDRESS]');
    assert.equal(redactAll('lat: 51.5074'), '[REDACTED-COORDINATES]');
  });
});

describe('guard configuration', () => {
  test('defaults: only defaultEnabled guards are active, checks below min certainty are skipped', () => {
    const resolved = Redactor.resolveGuards({}, 6);
    const byId = Object.fromEntries(resolved.map((g) => [g.guard.id, g]));
    assert.equal(byId.secrets.enabled, true);
    assert.equal(byId.email.enabled, false);
    assert.equal(byId.email.activeCount, 0);

    const ssnGeneric = byId.ssn.checks.find((c) => c.check.id === 'regex-social-security-number');
    assert.equal(ssnGeneric.check.certainty, 5);
    assert.equal(ssnGeneric.belowThreshold, true);
    assert.equal(ssnGeneric.active, false);
    const ssnLabel = byId.ssn.checks.find((c) => c.check.id === 'regex-ssn-with-label');
    assert.equal(ssnLabel.active, true);

    const text = Redactor.compile({ guards: {}, minCertainty: 6 }).text;
    assert.equal(Redactor.redactString('123-45-6789', text).count, 0, 'bare SSN skipped at min 6');
    assert.equal(Redactor.redactString('SSN 123-45-6789', text).count, 1);
    assert.equal(Redactor.redactString('a@b.co', text).count, 0, 'email guard off by default');
  });

  test('lowering min certainty activates weaker checks', () => {
    const text = Redactor.compile({ guards: {}, minCertainty: 1 }).text;
    assert.equal(Redactor.redactString('123-45-6789', text).count, 1);
  });

  test('enabling a guard and disabling individual checks', () => {
    const settings = {
      email: { enabled: true },
      secrets: { enabled: true, disabledChecks: ['regex-jwt-token'] }
    };
    const text = Redactor.compile({ guards: settings, minCertainty: 6 }).text;
    assert.equal(Redactor.redactString('a@b.co', text).value, '[REDACTED-EMAIL]');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    assert.equal(Redactor.redactString(jwt, text).count, 0, 'disabled check is skipped');
    assert.equal(Redactor.redactString('AKIAIOSFODNN7EXAMPLE', text).count, 1, 'other checks remain');

    const resolved = Redactor.resolveGuards(settings, 6);
    const secrets = resolved.find((g) => g.guard.id === 'secrets');
    assert.equal(secrets.checks.find((c) => c.check.id === 'regex-jwt-token').disabled, true);
  });

  test('disabling a guard overrides its default', () => {
    const text = Redactor.compile({ guards: { secrets: { enabled: false } }, minCertainty: 6 }).text;
    assert.equal(Redactor.redactString('AKIAIOSFODNN7EXAMPLE', text).count, 0);
  });

  test('managed flag is surfaced', () => {
    const resolved = Redactor.resolveGuards({ email: { enabled: true, managed: true } }, 6);
    assert.equal(resolved.find((g) => g.guard.id === 'email').managed, true);
    assert.equal(resolved.find((g) => g.guard.id === 'phone').managed, false);
  });

  test('clampCertainty', () => {
    assert.equal(Redactor.clampCertainty(0), 1);
    assert.equal(Redactor.clampCertainty(11), 10);
    assert.equal(Redactor.clampCertainty('7.4'), 7);
    assert.equal(Redactor.clampCertainty('x'), Redactor.DEFAULT_MIN_CERTAINTY);
  });

  test('guards and custom rules combine; custom rules run after guards', () => {
    const c = Redactor.compile({
      guards: { email: { enabled: true } },
      minCertainty: 6,
      rules: [{ kind: 'text', value: 'Acme Corp', replacement: '[COMPANY]' }]
    }, 'https://x.io/');
    const r = Redactor.redactString('Acme Corp <ceo@acme.com>', c.text);
    assert.equal(r.value, '[COMPANY] <[REDACTED-EMAIL]>');
    assert.equal(r.count, 2);
  });
});
