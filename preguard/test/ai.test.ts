import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/lib/schema.ts';
import { REVIEW_SCHEMA, verifyFindings } from '../src/checks/ai.ts';
import { aiAvailability } from '../src/lib/ai.ts';
import { defaultRules } from '../src/lib/rules.ts';
import type { Ctx } from '../src/lib/context.ts';

const impact = { area: 'a', before: 'b', after: 'c', depends_on: 'd', could_break: 'e', watch_after_merge: 'f', known: true };
const finding = { category: 'unsourced_claims', severity: 'medium', confidence: 0.9, file: 'api/routes.js', line: 3, reason: 'r', evidence: 'x', source_url: null };

test('AI output schema: valid passes, extra or missing fields fail', () => {
  assert.deepEqual(validate({ findings: [finding], impact }, REVIEW_SCHEMA), []);
  assert.match(validate({ findings: [{ ...finding, severity: 'critical' }], impact }, REVIEW_SCHEMA).join(), /severity/);
  assert.match(validate({ findings: [], impact: { ...impact, known: 'yes' } }, REVIEW_SCHEMA).join(), /known/);
  assert.match(validate({ findings: [{ ...finding, extra: 1 }], impact }, REVIEW_SCHEMA).join(), /not allowed/);
  assert.match(validate({ findings: [] }, REVIEW_SCHEMA).join(), /impact: required/);
});

test('AI availability: no provider / send_code false / no key all mean "not run"', () => {
  const r = defaultRules();
  assert.match((aiAvailability('/nonexistent', r) as { reason: string }).reason, /no approved AI provider/);
  r.ai.provider = 'anthropic';
  r.ai.model = 'claude-sonnet-5-5';
  assert.match((aiAvailability('/nonexistent', r) as { reason: string }).reason, /send_code is false/);
  r.ai.send_code = true;
  r.ai.env_file = null;
  const saved = process.env.ANTHROPIC_API_KEY;
  const savedFile = process.env.PREGUARD_ENV_FILE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.PREGUARD_ENV_FILE;
  try {
    assert.match((aiAvailability('/nonexistent', r) as { reason: string }).reason, /no API key/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    if (savedFile !== undefined) process.env.PREGUARD_ENV_FILE = savedFile;
  }
});

test('AI findings: evidence must exist in the changed file; line is corrected; unsourced claims downgraded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ai-'));
  fs.mkdirSync(path.join(dir, 'api'));
  fs.writeFileSync(path.join(dir, 'api/routes.js'), 'const a = 1;\nconst b = 2;\n// decodeURIComponent never throws on path input\nconst c = decodeURIComponent(x);\n');
  const ctx = { root: dir, files: ['api/routes.js'], filesMode: 'branch', rules: defaultRules(), results: [] } as unknown as Ctx;
  try {
    const { kept, dropped } = verifyFindings(
      ctx,
      [
        { ...finding, line: 1, evidence: '// decodeURIComponent never throws on path input', source_url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/decodeURIComponent' },
        { ...finding, category: 'silent_failure', evidence: 'this line does not exist anywhere' },
        { ...finding, file: 'api/other.js', evidence: 'const a = 1;' },
        { ...finding, confidence: 0.3, evidence: 'const b = 2;' },
        { ...finding, line: 4, evidence: 'const c = decodeURIComponent(x);', source_url: null },
      ] as never,
      ['api/routes.js'],
    );
    assert.equal(kept.length, 2);
    assert.equal(kept[0].line, 3); // moved from 1 to where the evidence actually is
    assert.equal(kept[0].severity, 'medium');
    assert.equal(kept[1].severity, 'low'); // claim without a source is only "unverified"
    assert.equal(dropped.length, 3);
    assert.match(dropped.join('\n'), /evidence not found/);
    assert.match(dropped.join('\n'), /not part of the change/);
    assert.match(dropped.join('\n'), /confidence 0.3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wire schema: numeric bounds stay local, type unions become anyOf', async () => {
  const { toWireSchema } = await import('../src/lib/ai.ts');
  const wire = toWireSchema(REVIEW_SCHEMA) as any;
  const f = wire.properties.findings.items.properties;
  assert.equal(f.confidence.minimum, undefined);
  assert.deepEqual(f.source_url.anyOf, [{ type: 'string' }, { type: 'null' }]);
  assert.equal(wire.additionalProperties, false);
  assert.deepEqual(wire.required, ['findings', 'impact']);
});
