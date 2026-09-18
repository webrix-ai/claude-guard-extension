'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, read } = require('./helpers/load');

const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const schema = JSON.parse(read('managed_schema.json'));

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

describe('manifest.json', () => {
  test('is Manifest V3 with a service worker and both content-script worlds', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.ok(exists(manifest.background.service_worker));
    const worlds = manifest.content_scripts.map((cs) => cs.world || 'ISOLATED').sort();
    assert.deepEqual(worlds, ['ISOLATED', 'MAIN']);
    for (const cs of manifest.content_scripts) {
      assert.equal(cs.run_at, 'document_start');
      for (const js of cs.js) assert.ok(exists(js), `${js} missing`);
    }
  });

  test('isolated world loads guards, then the redactor, then content.js', () => {
    const isolated = manifest.content_scripts.find((cs) => cs.world !== 'MAIN');
    assert.deepEqual(isolated.js, ['lib/guards.js', 'lib/redactor.js', 'content.js']);
  });

  test('referenced assets exist', () => {
    assert.ok(exists(manifest.action.default_popup));
    assert.ok(exists(manifest.storage.managed_schema));
    for (const icon of Object.values(manifest.icons)) assert.ok(exists(icon), icon);
    for (const icon of Object.values(manifest.action.default_icon)) assert.ok(exists(icon), icon);
    for (const size of [16, 48, 128]) assert.ok(exists(`icons/icon${size}-active.png`));
  });

  test('version matches package.json', () => {
    assert.equal(manifest.version, pkg.version);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  });

  test('does not pin an extension key (ID is assigned by the store / install path)', () => {
    assert.equal(manifest.key, undefined);
  });

  test('requests only the permissions it uses', () => {
    assert.deepEqual([...manifest.permissions].sort(), ['storage', 'tabs']);
    assert.equal(manifest.host_permissions, undefined);
  });
});

describe('managed_schema.json', () => {
  test('declares rule lists and guard settings', () => {
    assert.deepEqual(Object.keys(schema.properties).sort(), ['allowList', 'blockList', 'guardMinCertainty', 'guards', 'redactList']);
    const redact = schema.properties.redactList.items.properties;
    assert.deepEqual(redact.kind.enum, ['text', 'regex', 'selector']);
    assert.ok(redact.value && redact.scope && redact.replacement);
  });
});

describe('packaging', () => {
  test('pack-zip.sh ships every file the manifest and popup reference', () => {
    const script = read('scripts/pack-zip.sh');
    const shipped = (rel) => {
      const parts = rel.split('/');
      return script.includes(rel) || (parts.length > 1 && script.includes(parts[0] + '/'));
    };
    const needed = new Set([
      manifest.background.service_worker,
      manifest.action.default_popup,
      manifest.storage.managed_schema,
      ...manifest.content_scripts.flatMap((cs) => cs.js),
      ...Object.values(manifest.icons)
    ]);
    // Local files pulled in by the HTML pages (external links are not packaged).
    for (const html of ['popup.html', 'approve.html']) {
      for (const m of read(html).matchAll(/(?:src|href)="([^"]+)"/g)) {
        if (!/^[a-z]+:/i.test(m[1])) needed.add(m[1]);
      }
    }
    for (const rel of needed) assert.ok(shipped(rel), `${rel} not in pack-zip.sh`);
  });
});
