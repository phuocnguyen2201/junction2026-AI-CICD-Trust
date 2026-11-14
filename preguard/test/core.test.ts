import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml } from '../src/lib/yaml.ts';
import { satisfies } from '../src/lib/semver.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEnvFile, scanLine } from '../src/checks/secrets.ts';
import { findApiKey } from '../src/lib/env.ts';
import { surfaceOf } from '../src/checks/api.ts';
import { relatedTests } from '../src/lib/imports.ts';
import { validateCard } from '../src/lib/card.ts';
import { defaultRules, renderRules } from '../src/lib/rules.ts';

test('yaml: maps, lists of maps, flow lists, comments, scalars', () => {
  const y = parseYaml(`
version: 1   # comment
name: "a # not a comment"
flags: [a, "b c", 3, true]
empty: {}
nested:
  deep:
    x: null
modes:
  - name: default
    command: npm test
  - name: legacy
    env: { ID: "1" }
list:
- one
- 'two'
`);
  assert.deepEqual(y, {
    version: 1,
    name: 'a # not a comment',
    flags: ['a', 'b c', 3, true],
    empty: {},
    nested: { deep: { x: null } },
    modes: [
      { name: 'default', command: 'npm test' },
      { name: 'legacy', env: { ID: '1' } },
    ],
    list: ['one', 'two'],
  });
});

test('yaml: stringify round-trips', () => {
  const v = { a: 1, b: ['x', 'y z'], c: [{ name: 'n', command: 'npm run -- {files}' }], d: { e: null, f: '**/auth/**' } };
  assert.deepEqual(parseYaml(stringifyYaml(v)), v);
});

test('yaml: rendered rule pack parses back to the same rules', () => {
  const r = defaultRules();
  r.test_modes = [{ name: 'default', command: 'npm run --silent test' }];
  r.public_api = ['api/contract.json'];
  assert.deepEqual(parseYaml(renderRules(r, { pinned: ['node "22"'], ci: ['.github/workflows/ci.yml'] })), r);
});

test('yaml: errors carry a line number', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /line 2/);
});

test('semver: pins and ranges', () => {
  assert.equal(satisfies('26.10.0', '26'), true);
  assert.equal(satisfies('v26.10.0', '24'), false);
  assert.equal(satisfies('22.11.0', '22.11'), true);
  assert.equal(satisfies('22.11.0', '>=20 <23'), true);
  assert.equal(satisfies('23.0.0', '>=20 <23'), false);
  assert.equal(satisfies('20.5.1', '^20.3'), true);
  assert.equal(satisfies('21.0.0', '^20.3'), false);
  assert.equal(satisfies('20.3.9', '~20.3.1'), true);
  assert.equal(satisfies('18.0.0', '16 || 18'), true);
  assert.equal(satisfies('22.0.0', '22.x'), true);
  assert.equal(satisfies('22.0.0', 'lts/*'), null);
});

test('secrets: real-looking keys hit, placeholders do not', () => {
  assert.equal(scanLine(`key = "AKIA${'Q'.repeat(16)}"`)?.id, 'aws-access-key');
  assert.equal(scanLine('-----BEGIN RSA PRIVATE KEY-----')?.id, 'private-key');
  assert.equal(scanLine('token: "k8Fq2LmZ9pRt4VxN7bWc"')?.id, 'generic-secret');
  assert.equal(scanLine(`token: "${'ab'.repeat(10)}"`), null); // low entropy
  assert.equal(scanLine('apiKey: "your-api-key-goes-here"'), null);
  assert.equal(scanLine('password = process.env.DB_PASSWORD'), null);
  assert.equal(scanLine(`key = "AKIA${'Q'.repeat(16)}" // preguard:allow-secret`), null);
});

test('secrets: dotenv files are always flagged, examples are not', () => {
  assert.equal(isEnvFile('.env'), true);
  assert.equal(isEnvFile('api/.env.local'), true);
  assert.equal(isEnvFile('.env.example'), false);
  assert.equal(isEnvFile('src/env.ts'), false);
});

test('api key lookup: env var wins, then dotenv file; key never comes from rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-env-'));
  fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_API_KEY=from-file\n');
  const r = defaultRules();
  r.ai.provider = 'anthropic';
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.deepEqual(findApiKey(dir, r), { key: 'from-file', varName: 'ANTHROPIC_API_KEY', source: '.env' });
    process.env.ANTHROPIC_API_KEY = 'from-env';
    assert.equal(findApiKey(dir, r).source, 'environment');
    r.ai.provider = null;
    assert.equal(findApiKey(dir, r).key, null);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('api surface: contract endpoints and JS exports', () => {
  const contract = JSON.stringify({ endpoints: [{ method: 'get', path: '/a' }, { method: 'POST', path: '/a' }] });
  assert.deepEqual([...surfaceOf('api/contract.json', contract)], ['GET /a', 'POST /a']);
  const js = 'export function f() {}\nexport const g = 1;\nexport { h, i as j };\nexport default 1;\nfunction private1() {}';
  assert.deepEqual([...surfaceOf('src/index.js', js)].sort(), ['export default', 'export f', 'export g', 'export h', 'export j']);
  assert.deepEqual([...surfaceOf('x.json', null)], []);
});

test('related tests: transitive imports', () => {
  const g = new Map<string, string[]>([
    ['test/a.test.js', ['src/a.js']],
    ['test/b.test.js', ['src/b.js']],
    ['src/a.js', ['src/util.js']],
    ['src/b.js', []],
    ['src/util.js', []],
  ]);
  assert.deepEqual(relatedTests(g, ['src/util.js']), ['test/a.test.js']);
  assert.deepEqual(relatedTests(g, ['test/b.test.js']), ['test/b.test.js']);
});

test('requirement card validation', () => {
  const ok = {
    id: '1',
    title: 't',
    acceptance_criteria: ['a'],
    scope: { in: [], out: [] },
    layers: ['backend'],
    risk_tier: 'low',
    expected_blast_radius: '',
    in_reach: { result: 'do', signals_failed: [] },
    open_decisions: [{ id: 'D-1', question: 'q', why_not_ai: 'policy', owner_role: 'owners', answer: null }],
  };
  assert.deepEqual(validateCard(ok), []);
  assert.match(validateCard({ ...ok, risk_tier: 'huge' }).join(), /risk_tier/);
  assert.match(validateCard({ ...ok, open_decisions: [{ ...ok.open_decisions[0], why_not_ai: 'because' }] }).join(), /why_not_ai/);
});

test('trust math: Wilson lower bound and successes needed', async () => {
  const { wilsonLower, successesNeeded } = await import('../src/lib/history.ts');
  assert.equal(wilsonLower(0, 0), null);
  assert.ok(Math.abs((wilsonLower(5, 5) ?? 0) - 0.566) < 0.01); // 5/5 is only "at least 57%" at 95% confidence
  assert.ok((wilsonLower(95, 100) ?? 0) > 0.88);
  assert.equal(successesNeeded(5, 5, 0.8, 5), 11); // 16/16 → lower bound ≥ 80%
  assert.equal(successesNeeded(30, 30, 0.8, 5), 0);
});
