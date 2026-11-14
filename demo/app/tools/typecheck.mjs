#!/usr/bin/env node
// Synthetic stand-in for a type checker (think tsc --noEmit): parses every JS module with
// `node --check` so syntax errors fail fast. Usage: node tools/typecheck.mjs

import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.m?js$/.test(f) && fs.existsSync(f));

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    const line = /:(\d+)\n/.exec(r.stderr)?.[1] ?? '1';
    const msg = r.stderr.split('\n').find((l) => /Error/.test(l)) ?? 'syntax error';
    console.log(`${f}:${line}: ${msg.trim()}`);
  }
}
if (failed) process.exit(1);
console.log(`${files.length} file(s) OK`);
