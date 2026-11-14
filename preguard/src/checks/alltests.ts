import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../lib/exec.ts';
import { remainingMs, type Check, type Ctx } from '../lib/context.ts';
import { readPackage } from '../lib/detect.ts';
import { isTestFile } from '../lib/imports.ts';
import { summarizeTestOutput } from './tools.ts';
import type { Finding } from '../lib/types.ts';

// ---------- locate a failing test by its title (for file:line evidence) ----------

export function locateTest(root: string, files: string[], title: string): { file: string; line: number } | null {
  const needle = title.replace(/^\s*(not ok \d+ - |✖\s*|✕\s*)/, '').trim();
  if (!needle) return null;
  for (const f of files.filter(isTestFile)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.includes(needle.slice(0, 60)));
    if (i >= 0) return { file: f, line: i + 1 };
  }
  return null;
}

// ---------- all tests, in every mode ----------

export interface ModeRun {
  mode: string;
  ok: boolean;
  pass: number | null;
  fail: number | null;
  failures: string[];
  command: string;
  not_run?: string;
}

export const allTestsCheck: Check = (ctx) => {
  const base = { id: 'all_tests', title: 'all tests (every mode)' };
  const modes = ctx.rules.test_modes;
  if (!modes.length) return { ...base, status: 'not_run', summary: 'no test modes configured (test_modes in rules.yml)', details: [], findings: [] };

  const runs: ModeRun[] = [];
  const findings: Finding[] = [];
  const all = ctx.git.allFiles();
  for (const m of modes) {
    const r = runCommand(m.command, { cwd: ctx.root, timeoutMs: remainingMs(ctx) });
    if (r.timedOut || r.error || r.code === 127) {
      runs.push({ mode: m.name, ok: false, pass: null, fail: null, failures: [], command: r.command, not_run: r.timedOut ? 'timed out (push budget)' : `could not run \`${r.command}\`` });
      continue;
    }
    const s = summarizeTestOutput(r.stdout + '\n' + r.stderr);
    runs.push({ mode: m.name, ok: r.code === 0, pass: s.pass, fail: s.fail, failures: s.failures, command: r.command });
    for (const f of s.failures) {
      const loc = locateTest(ctx.root, all, f);
      findings.push({
        id: `TEST-${m.name}-${findings.length + 1}`,
        category: 'failing_test',
        severity: 'high',
        confidence: 1,
        file: loc?.file ?? '(tests)',
        line: loc?.line ?? 1,
        reason: `Fails in test mode "${m.name}"`,
        evidence: f,
        origin: 'check',
      });
    }
  }
  const failed = runs.filter((r) => !r.ok && !r.not_run);
  const notRun = runs.filter((r) => r.not_run);
  const details = runs.map((r) =>
    r.not_run ? `${r.mode}: not run, ${r.not_run}` : `${r.mode}: ${r.pass ?? '?'} passed${r.fail ? `, ${r.fail} failed` : ''}${r.failures.length ? `  ${r.failures[0]}` : ''}`,
  );
  const data = { runs };
  if (failed.length) {
    return { ...base, status: 'fail', summary: `failing in ${failed.map((r) => r.mode).join(', ')}`, details, fix: `reproduce with \`${failed[0].command}\``, findings, data };
  }
  if (notRun.length) return { ...base, status: 'not_run', summary: `mode(s) ${notRun.map((r) => r.mode).join(', ')} did not run`, details, findings, data };
  return { ...base, status: 'pass', summary: runs.map((r) => `${r.mode}: ${r.pass ?? 'all'} passed`).join(' · '), details, findings, data };
};

// ---------- test inventory: every new test file is in every mode ----------

function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of cmd.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The script text behind "npm run --silent test:legacy" etc. */
function scriptText(root: string, command: string): string {
  const scripts = readPackage(root).scripts;
  const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:--silent\s+)?([\w:.-]+)/.exec(command.trim());
  return m && scripts[m[1]] ? scripts[m[1]] : command;
}

const NODE_DEFAULT = ['**/*.test.{js,mjs,cjs,ts,mts}', '**/*-test.{js,mjs,cjs}', '**/*_test.{js,mjs,cjs}', '**/test/**/*.{js,mjs,cjs}', '**/test.{js,mjs,cjs}'];

/** Files a `node --test` mode includes, or null if this runner can't be inspected statically. */
export function modeFiles(root: string, command: string): { files: Set<string>; how: string } | null {
  const script = scriptText(root, command);
  if (!/node\s+(?:[^\n]*\s)?--test\b/.test(script)) return null;
  const segment = script.split(/&&|\|\||;|\|/).find((s) => /--test\b/.test(s)) ?? script;
  const toks = tokenize(segment);
  const at = toks.indexOf('--test');
  const patterns = toks.slice(at + 1).filter((t) => !t.startsWith('-'));
  const files = new Set<string>();
  for (const p of patterns.length ? patterns : NODE_DEFAULT) {
    if (/[*?{[]/.test(p)) {
      for (const f of fs.globSync(p, { cwd: root, exclude: (n: unknown) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(n)) })) files.add(String(f).split(path.sep).join('/'));
    } else {
      const abs = path.join(root, p);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        for (const f of fs.globSync(`${p.replace(/\/$/, '')}/**/*.{js,mjs,cjs,ts}`, { cwd: root })) files.add(String(f).split(path.sep).join('/'));
      } else files.add(p.replace(/^\.\//, ''));
    }
  }
  return { files, how: patterns.length ? 'explicit list / globs' : 'node --test defaults' };
}

export function newTestFiles(ctx: Ctx): string[] {
  const ref = ctx.diffBase ?? 'HEAD';
  const added = new Set([...ctx.git.lines(['diff', '--name-only', '--diff-filter=A', ref]), ...ctx.git.lines(['ls-files', '--others', '--exclude-standard'])]);
  return [...added].filter(isTestFile).sort();
}

export const testInventoryCheck: Check = (ctx) => {
  const base = { id: 'test_inventory', title: 'test inventory' };
  const modes = ctx.rules.test_modes;
  if (modes.length < 1) return { ...base, status: 'not_run', summary: 'no test modes configured', details: [], findings: [] };
  const fresh = newTestFiles(ctx);
  if (!fresh.length) return { ...base, status: 'pass', summary: 'no new test files on this branch', details: [], findings: [] };

  const included: { mode: string; files: Set<string> | null; how: string }[] = modes.map((m) => {
    const r = modeFiles(ctx.root, m.command);
    return { mode: m.name, files: r?.files ?? null, how: r?.how ?? 'cannot inspect this runner' };
  });
  const unknown = included.filter((i) => !i.files);
  const findings: Finding[] = [];
  const details: string[] = [];
  for (const f of fresh) {
    const missing = included.filter((i) => i.files && !i.files.has(f)).map((i) => i.mode);
    if (missing.length) {
      details.push(`${f} is not run in mode(s): ${missing.join(', ')}`);
      findings.push({
        id: `INV-${findings.length + 1}`,
        category: 'missing_test_modes',
        severity: 'high',
        confidence: 1,
        file: f,
        line: 1,
        reason: `New test never runs in test mode ${missing.map((m) => `"${m}"`).join(', ')}; a bug that only shows in that mode stays hidden`,
        evidence: `${f} matches none of the files of ${missing.map((m) => `"${m}" (${modes.find((x) => x.name === m)!.command})`).join(', ')}`,
        origin: 'check',
      });
    }
  }
  if (findings.length) {
    return { ...base, status: 'fail', summary: `${findings.length} new test file(s) missing from a test mode`, details, fix: 'add the file(s) to the listed mode(s), then run all modes again', findings };
  }
  if (unknown.length) {
    return { ...base, status: 'not_run', summary: `can't read the file list of mode(s) ${unknown.map((u) => u.mode).join(', ')}`, details: fresh.map((f) => `new: ${f}`), findings };
  }
  return { ...base, status: 'pass', summary: `${fresh.length} new test file(s) run in all ${modes.length} modes`, details: fresh.map((f) => `new: ${f}`), findings };
};
