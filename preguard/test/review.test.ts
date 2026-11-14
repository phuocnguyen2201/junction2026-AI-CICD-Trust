import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modeFiles } from '../src/checks/alltests.ts';
import { a11yProblems } from '../src/checks/frontend.ts';

test('test inventory: explicit file lists and globs per mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-inv-'));
  fs.mkdirSync(path.join(dir, 'test'));
  for (const f of ['a.test.js', 'b.test.js', 'new.test.js']) fs.writeFileSync(path.join(dir, 'test', f), '');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { 'test:default': 'node --test "test/**/*.test.js"', 'test:legacy': 'ID_FORMAT=legacy node --test test/a.test.js test/b.test.js' } }),
  );
  try {
    const def = modeFiles(dir, 'npm run --silent test:default')!;
    const legacy = modeFiles(dir, 'npm run --silent test:legacy')!;
    assert.ok(def.files.has('test/new.test.js'));
    assert.equal(legacy.files.has('test/new.test.js'), false);
    assert.deepEqual([...legacy.files].sort(), ['test/a.test.js', 'test/b.test.js']);
    assert.equal(modeFiles(dir, 'npx jest'), null); // can't inspect statically → "not run", never a guess
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a11y basics: lang, alt, labels, button text', () => {
  const bad = '<html><body><img src="x.png"><input id="n"><button></button></body></html>';
  assert.deepEqual(a11yProblems(bad).map((p) => p.issue), ['<html> has no lang attribute', '<img> has no alt text', '<input id="n"> has no label', '<button> has no text or aria-label']);
  const good = '<html lang="en"><img alt="logo" src="x.png"><label for="n">Name</label><input id="n"><input type="submit"><button>Go</button></html>';
  assert.deepEqual(a11yProblems(good), []);
});
