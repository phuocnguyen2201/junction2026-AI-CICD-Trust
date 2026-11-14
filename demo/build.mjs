#!/usr/bin/env node
// Builds the synthetic demo git repo: main (app + rule pack) and one branch per seeded failure pattern.
// Usage: node demo/build.mjs [--out <dir>]     (default: demo/repo; rebuilt from scratch each time)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg > -1 ? process.argv[outArg + 1] : path.join(here, 'repo'));
const PREGUARD = path.join(here, '..', 'preguard', 'bin', 'preguard.mjs');
const MARKER = '.git/preguard-demo';

// Deterministic, synthetic identity and dates: the demo never uses real people or real history.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Demo Dev',
  GIT_AUTHOR_EMAIL: 'demo-dev@example.invalid',
  GIT_COMMITTER_NAME: 'Demo Dev',
  GIT_COMMITTER_EMAIL: 'demo-dev@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};
let clock = Date.parse('2026-05-01T09:00:00Z');
const git = (...args) => {
  clock += 60_000;
  const date = new Date(clock).toISOString();
  return execFileSync('git', args, { cwd: out, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8' });
};

if (fs.existsSync(out)) {
  if (!fs.existsSync(path.join(out, MARKER))) {
    console.error(`Refusing to delete ${out}: it is not a demo repo built by this script.`);
    process.exit(1);
  }
  fs.rmSync(out, { recursive: true, force: true });
}
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(here, 'app'), out, { recursive: true });
const major = process.versions.node.split('.')[0];
fs.writeFileSync(path.join(out, '.nvmrc'), `${major}\n`);

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Demo Dev');
git('config', 'user.email', 'demo-dev@example.invalid');
git('config', 'commit.gpgsign', 'false');
fs.writeFileSync(path.join(out, MARKER), 'built by demo/build.mjs\n');
git('add', '-A');
git('commit', '-q', '-m', 'Synthetic event sign-up app');

// ── Synthetic task history (for `preguard trust`) ─────────────────────────────
// Period 1, May–Aug 2026: 32 tasks WITHOUT Pre-PR Guard. Then the rule pack lands on 2026-09-01.
// Period 2, Sep–Oct 2026: 44 tasks WITH Pre-PR Guard, each recording its readiness verdict in a
// `Preguard-Status:` trailer, plus 3 tasks in November that are too recent to judge.
// Outcomes are seeded to tell the before/after story. Every name, line of code and date is synthetic,
// and each task changes only its own file, so the demo branches are unaffected.
const DAY = 86_400_000;
const AI = 'Co-Authored-By: AI Assistant <ai-assistant@example.invalid>';
const NAMES = {
  backend: ['daily count', 'weekly count', 'CSV export', 'summary', 'monthly count', 'no-show report', 'waitlist report', 'duplicate scan', 'email domains', 'late sign-ups', 'cancellations', 'capacity check', 'ticket mix', 'team report', 'sign-up trend', 'peak hours', 'region split', 'returning guests', 'VIP list', 'badge export', 'speaker list', 'room usage', 'catering count', 'survey totals', 'check-in rate', 'refund report', 'invoice list', 'audit trail', 'reminder queue', 'export retries', 'sponsor list', 'volunteer shifts', 'session counts', 'track report', 'API usage', 'error digest', 'nightly rollup', 'data retention', 'privacy export', 'quota report', 'timezone fix', 'archive job', 'growth report'],
  frontend: ['sign-up banner', 'live counter', 'popular badge', 'footer total', 'attendee tooltip', 'empty state', 'error toast', 'form hints', 'dark theme', 'mobile layout', 'progress bar', 'confirmation view', 'share button', 'seat map', 'calendar link', 'agenda list', 'speaker cards', 'filter chips', 'search box', 'skeleton loader', 'keyboard nav', 'focus rings', 'print view', 'language switch', 'help panel', 'countdown'],
};
const used = { backend: 0, frontend: 0 };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const rep = (n, layer, ai, outcome, pg = null) => Array.from({ length: n }, () => ({ layer, ai, outcome, pg }));
// Deterministic shuffle so categories interleave the same way on every build.
function shuffle(list, seed) {
  const a = [...list];
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const period1 = shuffle([
  ...rep(6, 'backend', true, 'ok'), ...rep(2, 'backend', true, 'revert'), ...rep(2, 'backend', true, 'fix'),
  ...rep(7, 'backend', false, 'ok'), ...rep(1, 'backend', false, 'fix'),
  ...rep(4, 'frontend', true, 'ok'), ...rep(2, 'frontend', true, 'revert'), ...rep(2, 'frontend', true, 'fix'),
  ...rep(5, 'frontend', false, 'ok'), ...rep(1, 'frontend', false, 'fix'),
], 7);
const period2 = shuffle([
  ...rep(12, 'backend', true, 'ok', 'green'), ...rep(1, 'backend', true, 'ok', 'yellow'), ...rep(1, 'backend', true, 'fix', 'green'),
  ...rep(17, 'backend', false, 'ok', 'green'), ...rep(1, 'backend', false, 'ok', 'yellow'),
  ...rep(6, 'frontend', true, 'ok', 'green'), ...rep(1, 'frontend', true, 'ok', 'yellow'), ...rep(1, 'frontend', true, 'revert', 'red (bypassed: format)'),
  ...rep(4, 'frontend', false, 'ok', 'green'),
], 11);
const recent = rep(3, 'backend', true, 'ok', 'green');

// Fictional developers (synthetic names, example.invalid addresses). Pools are sized so each ends with a
// different track record: Amber 20 PRs / 0 failed, Birch 17 / 2, Cedar 15 / 4, Dune 14 / 4, Elm (new) 10 / 2.
const DEVS = Object.fromEntries(['Amber', 'Birch', 'Cedar', 'Dune', 'Elm'].map((n) => [n, `Dev ${n} <dev-${n.toLowerCase()}@example.invalid>`]));
const pool = (counts, seed) => shuffle(Object.entries(counts).flatMap(([n, k]) => Array(k).fill(DEVS[n])), seed);
const authorsFor = {
  ok: pool({ Amber: 20, Birch: 15, Cedar: 11, Dune: 10, Elm: 8 }, 3),
  bad: pool({ Birch: 2, Cedar: 4, Dune: 4, Elm: 2 }, 5),
  recent: [DEVS.Elm, DEVS.Birch, DEVS.Amber],
};
const pickAuthor = (t, isRecent) => (isRecent ? authorsFor.recent.shift() : t.outcome === 'ok' ? authorsFor.ok.shift() : authorsFor.bad.shift());

let nextId = 300;
function schedule(tasks, fromIso, toIso, isRecent = false) {
  const from = Date.parse(fromIso);
  const step = (Date.parse(toIso) - from) / Math.max(1, tasks.length - 1);
  return tasks.map((t, i) => {
    const name = NAMES[t.layer][used[t.layer]++ % NAMES[t.layer].length];
    const file = t.layer === 'backend' ? `api/reports/${slug(name)}.js` : `web/widgets/${slug(name)}.js`;
    return { ...t, id: `EVT-${nextId++}`, name, file, time: Math.round(from + i * step), author: pickAuthor(t, isRecent) };
  });
}
const moduleSource = (t, v) => `// Synthetic ${t.layer === 'backend' ? 'report' : 'widget'} module: ${t.name} (demo history, ${t.id}).\n\nexport function ${slug(t.name).replace(/-(\w)/g, (_, c) => c.toUpperCase()).replace(/^(\d)/, 'm$1')}(rows) {\n  return rows.filter((r) => r.version >= ${v}).length;\n}\n`;

function playHistory(tasks) {
  const events = [];
  for (const t of tasks) {
    events.push({ time: t.time, run: () => {
      clock = t.time;
      apply(t.file, moduleSource(t, 1));
      git('add', '-A');
      const trailers = [t.ai ? AI : null, t.pg ? `Preguard-Status: ${t.pg}` : null].filter(Boolean).join('\n');
      git('commit', '-q', `--author=${t.author}`, '-m', `${t.id}: ${t.name}`, ...(trailers ? ['-m', trailers] : []));
      t.sha = git('rev-parse', 'HEAD').trim();
    } });
    if (t.outcome === 'fix') events.push({ time: t.time + 2 * DAY, run: () => {
      clock = t.time + 2 * DAY;
      apply(t.file, moduleSource(t, 2));
      git('add', '-A');
      git('commit', '-q', `--author=${t.author}`, '-m', `fix: ${t.name} counted the wrong rows`);
    } });
    if (t.outcome === 'revert') events.push({ time: t.time + 1 * DAY, run: () => {
      clock = t.time + 1 * DAY;
      git('revert', '--no-edit', t.sha);
    } });
  }
  for (const e of events.sort((a, b) => a.time - b.time)) e.run();
}

playHistory(schedule(period1, '2026-05-04T10:00:00Z', '2026-08-24T10:00:00Z'));

// 2026-09-01: the team adopts Pre-PR Guard. Rule pack generated by `preguard init` (no hooks) and committed
// so CI and every developer share it.
clock = Date.parse('2026-09-01T09:00:00Z');
execFileSync(process.execPath, [PREGUARD, 'init', '--no-hooks'], { cwd: out, stdio: 'ignore', env });
// AI provider chosen for the prototype (open decision #1): Anthropic, Claude Sonnet 5.5. Only synthetic demo code is sent.
// The key stays in ~/junction2026/.env (two levels above demo/repo and demo/work); it is never copied.
const rulesPath = path.join(out, '.preguard/rules.yml');
let rules = fs.readFileSync(rulesPath, 'utf8');
for (const [from, to] of [
  [/^  provider: null.*$/m, '  provider: anthropic'],
  [/^  model: null.*$/m, '  model: claude-sonnet-5-5'],
  [/^  send_code: false.*$/m, '  send_code: true             # synthetic demo code only'],
  [/^  env_file: .*$/m, '  env_file: ../../.env         # the workspace .env with ANTHROPIC_API_KEY (outside the repo)'],
]) {
  if (!from.test(rules)) throw new Error(`could not set AI config: ${from}`);
  rules = rules.replace(from, to);
}
fs.writeFileSync(rulesPath, rules);
git('add', '-A');
git('commit', '-q', '-m', 'Add Pre-PR Guard rule pack');


playHistory(schedule(period2, '2026-09-02T10:00:00Z', '2026-10-28T10:00:00Z'));
playHistory(schedule(recent, '2026-11-04T10:00:00Z', '2026-11-09T10:00:00Z', true));
if (authorsFor.ok.length || authorsFor.bad.length) throw new Error('author pools do not match the task list');
clock = Date.parse('2026-11-11T09:00:00Z');

function apply(file, value) {
  const p = path.join(out, file);
  if (value === null) return fs.rmSync(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (typeof value === 'string') return fs.writeFileSync(p, value);
  let text = fs.readFileSync(p, 'utf8');
  if (typeof value === 'function') text = value(text);
  else
    for (const [from, to] of value.edits) {
      if (!text.includes(from)) throw new Error(`scenario patch for ${file} did not apply: ${JSON.stringify(from.slice(0, 60))}`);
      text = text.replace(from, to);
    }
  fs.writeFileSync(p, text);
}

for (const s of scenarios) {
  git('checkout', '-q', '-b', s.branch, 'main');
  for (const c of s.commits) {
    for (const [file, value] of Object.entries(c.files)) apply(file, value);
    git('add', '-A');
    git('commit', '-q', '-m', c.message);
  }
  git('checkout', '-q', 'main');
}

console.log(`Demo repo ready: ${out}`);
console.log(`Branches: main, ${scenarios.map((s) => s.branch).join(', ')}`);
