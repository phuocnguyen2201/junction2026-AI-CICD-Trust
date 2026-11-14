#!/usr/bin/env node
// Runs Pre-PR Guard on every demo branch: commit stage (`check`) and readiness (`ready`, which runs `review`).
// Usage: node demo/run.mjs [--branch demo/clean] [--verbose]

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, 'repo');
const PREGUARD = path.join(here, '..', 'preguard', 'bin', 'preguard.mjs');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const only = arg('--branch');
const verbose = process.argv.includes('--verbose');
const env = { ...process.env };
const dotenv = path.join(here, '..', '.env');
if (fs.existsSync(dotenv) && !env.PREGUARD_ENV_FILE) env.PREGUARD_ENV_FILE = dotenv; // AI key for M3; never printed

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
const original = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
if (git('status', '--porcelain').trim()) {
  console.error('demo/repo has uncommitted changes; rebuild it with `node demo/build.mjs`.');
  process.exit(1);
}
const pg = (...a) => {
  const r = spawnSync(process.execPath, [PREGUARD, ...a], { cwd: repo, encoding: 'utf8', env });
  try {
    return JSON.parse(r.stdout);
  } catch {
    console.error(`preguard ${a.join(' ')} did not return JSON\n${r.stdout}\n${r.stderr}`);
    process.exit(1);
  }
};

const ICON = { red: '🔴', yellow: '🟡', green: '🟢' };
const rows = [];
for (const s of scenarios.filter((x) => !only || x.branch === only)) {
  git('checkout', '-q', s.branch);
  const check = pg('check', '--json');
  const t0 = Date.now();
  const ready = pg('ready', '--json');
  const ms = Date.now() - t0;
  const aiPending = s.expect.needsAi && ready.status !== s.expect.ready;
  rows.push({
    s,
    check: check.ok ? 'pass' : 'fail',
    checkMs: check.ms,
    ready: ready.status,
    ms,
    ok: (check.ok ? 'pass' : 'fail') === s.expect.check && (ready.status === s.expect.ready || aiPending),
    aiPending,
    why: ready.why.join('; '),
  });
  if (verbose) {
    console.log(`\n── ${s.branch}`);
    spawnSync(process.execPath, [PREGUARD, 'ready'], { cwd: repo, stdio: 'inherit', env });
  }
}
git('checkout', '-q', original);

console.log('\nPre-PR Guard on each demo branch\n');
console.log(`  ${'branch'.padEnd(19)} ${'commit'.padEnd(7)} ${'ready'.padEnd(9)} ${'expect'.padEnd(7)} ${'review'.padStart(6)}  why`);
for (const r of rows) {
  const mark = !r.ok ? '✘' : r.aiPending ? '…' : '✔';
  const why = r.aiPending ? `${r.why}  ← final status needs the AI review (M3)` : r.why;
  console.log(`${mark} ${r.s.branch.padEnd(19)} ${r.check.padEnd(7)} ${ICON[r.ready]} ${r.ready.padEnd(6)} ${ICON[r.s.expect.ready]}      ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${why}`);
}
const bad = rows.filter((r) => !r.ok).length;
const pending = rows.filter((r) => r.aiPending).length;
console.log(`\n${rows.length - bad - pending} as expected · ${pending} waiting for M3 · ${bad} wrong · slowest commit ${(Math.max(...rows.map((r) => r.checkMs)) / 1000).toFixed(1)}s, slowest review ${(Math.max(...rows.map((r) => r.ms)) / 1000).toFixed(1)}s`);
process.exit(bad ? 1 : 0);
