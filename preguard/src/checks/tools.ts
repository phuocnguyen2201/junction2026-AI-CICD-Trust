import { runCommand, type ExecResult } from '../lib/exec.ts';
import { remainingMs, type Check, type Ctx } from '../lib/context.ts';
import { parseFileLines } from '../lib/output.ts';
import { buildImportGraph, isCode, isTestFile, relatedTests } from '../lib/imports.ts';
import type { CheckResult, Finding, Severity } from '../lib/types.ts';

type R = Omit<CheckResult, 'ms'>;

const TEXT_FILE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|json|css|scss|less|html|vue|svelte|md|ya?ml)$/;

function outputLines(r: ExecResult): string[] {
  return (r.stdout + '\n' + r.stderr)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^>\s/.test(l) && !/^npm (ERR|error|warn)/i.test(l));
}

/** Common handling for "command didn't actually run" outcomes. */
function notRunReason(r: ExecResult & { command: string }): string | null {
  if (r.timedOut) return `timed out (time budget) running \`${r.command}\``;
  if (r.error) return `could not start \`${r.command}\`: ${r.error}`;
  if (r.code === 127) return `command not found: \`${r.command}\``;
  return null;
}

function toFindings(prefix: string, category: string, severity: Severity, r: ExecResult, files: string[], perFile = false): Finding[] {
  const hits = parseFileLines(r.stdout + '\n' + r.stderr, files);
  if (perFile) {
    // One finding per file (e.g. formatting): the first location, plus a count and the kinds of problem.
    const byFile = new Map<string, typeof hits>();
    for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
    return [...byFile.entries()].map(([file, hs], i) => {
      const kinds = [...new Set(hs.map((h) => h.text.replace(/^.*?:\d+(?::\d+)?[:\s]*/, '')))];
      return { id: `${prefix}-${i + 1}`, category, severity, confidence: 1, file, line: hs[0].line, reason: `${hs.length} line(s): ${kinds.join(', ')}`, evidence: hs.slice(0, 3).map((h) => h.text).join(' · ') + (hs.length > 3 ? ` · … ${hs.length - 3} more` : ''), origin: 'check' as const };
    });
  }
  return hits.map((p, i) => ({
    id: `${prefix}-${i + 1}`,
    category,
    severity,
    confidence: 1,
    file: p.file,
    line: p.line,
    reason: p.text.replace(/^.*?:\d+(?::\d+)?[:\s]*/, '') || `${category} failure`,
    evidence: p.text,
    origin: 'check' as const,
  }));
}

// ---------- format (auto-fix so scope noise never reaches the PR) ----------

export const formatCheck: Check = (ctx) => {
  const t = ctx.rules.tools.format;
  const files = ctx.files.filter((f) => TEXT_FILE.test(f));
  const base = { id: 'format', title: 'format' };
  if (!t.check) return { ...base, status: 'not_run', summary: 'no format check command configured (tools.format.check)', details: [], findings: [] };
  if (!files.length) return { ...base, status: 'pass', summary: 'no formattable files changed', details: [], findings: [] };

  const first = runCommand(t.check, { cwd: ctx.root, files, timeoutMs: remainingMs(ctx) });
  const nr = notRunReason(first);
  if (nr) return { ...base, status: 'not_run', summary: nr, details: [], findings: [] };
  if (first.code === 0) return { ...base, status: 'pass', summary: `${files.length} file(s) already formatted`, details: [], findings: [] };

  const bad = [...new Set(parseFileLines(first.stdout + '\n' + first.stderr, files).map((p) => p.file))];
  const badFiles = bad.length ? bad : files;

  if (ctx.fix && t.fix) {
    // Never rewrite a file whose unstaged edits would get swept into the commit.
    const unstaged = ctx.filesMode === 'staged' ? new Set(ctx.git.unstagedFiles()) : new Set<string>();
    const fixable = badFiles.filter((f) => !unstaged.has(f));
    const skipped = badFiles.filter((f) => unstaged.has(f));
    if (fixable.length) {
      const fx = runCommand(t.fix, { cwd: ctx.root, files: fixable, timeoutMs: remainingMs(ctx) });
      const fnr = notRunReason(fx);
      if (fnr) return { ...base, status: 'not_run', summary: `auto-fix ${fnr}`, details: [], findings: [] };
      if (ctx.filesMode === 'staged') {
        ctx.git.git(['add', '--', ...fixable]);
        // A file that was only noise is now identical to HEAD: later checks should not see it.
        const still = new Set(ctx.git.stagedFiles());
        ctx.files = ctx.files.filter((f) => still.has(f));
      }
    }
    const again = runCommand(t.check, { cwd: ctx.root, files, timeoutMs: remainingMs(ctx) });
    if (again.code === 0) {
      return {
        ...base,
        status: 'pass',
        summary: `auto-fixed ${fixable.length} file(s)${ctx.filesMode === 'staged' ? ' and re-staged them' : ''}`,
        details: fixable.map((f) => `fixed ${f}`),
        findings: [],
        data: { auto_fixed: fixable },
      };
    }
    return {
      ...base,
      status: 'fail',
      summary: skipped.length ? `${skipped.length} file(s) have unstaged edits; not auto-fixed` : 'still failing after auto-fix',
      details: outputLines(again).slice(0, 20),
      fix: skipped.length ? `stage or stash your edits in ${skipped.join(', ')}, then commit again` : `run \`${t.fix.replace('{files}', badFiles.join(' '))}\` and inspect`,
      findings: toFindings('FMT', 'format', 'low', again, files, true),
    };
  }

  return {
    ...base,
    status: 'fail',
    summary: `${badFiles.length} file(s) not formatted`,
    details: outputLines(first).slice(0, 20),
    fix: t.fix ? 'run `preguard check --fix` (the commit hook does this automatically)' : 'run the repo formatter on these files',
    findings: toFindings('FMT', 'format', 'low', first, files, true),
  };
};

// ---------- lint ----------

export const lintCheck: Check = (ctx) => {
  const t = ctx.rules.tools.lint;
  const files = ctx.files.filter((f) => isCode(f) || /\.(vue|svelte|css|scss)$/.test(f));
  const base = { id: 'lint', title: 'lint' };
  if (!t.command) return { ...base, status: 'not_run', summary: 'no lint command configured (tools.lint.command)', details: [], findings: [] };
  if (!files.length) return { ...base, status: 'pass', summary: 'no lintable files changed', details: [], findings: [] };
  const r = runCommand(t.command, { cwd: ctx.root, files, timeoutMs: remainingMs(ctx) });
  const nr = notRunReason(r);
  if (nr) return { ...base, status: 'not_run', summary: nr, details: [], findings: [] };
  if (r.code === 0) return { ...base, status: 'pass', summary: `${files.length} file(s) clean`, details: [], findings: [] };
  const findings = toFindings('LINT', 'lint', 'medium', r, files);
  return { ...base, status: 'fail', summary: `${findings.length || 'some'} lint problem(s)`, details: outputLines(r).slice(0, 20), fix: t.fix ? `try \`${t.fix.replace('{files}', '<files>')}\`` : 'fix the reported lines', findings };
};

// ---------- type check ----------

export const typeCheck: Check = (ctx) => {
  const t = ctx.rules.tools.typecheck;
  const base = { id: 'typecheck', title: 'type check' };
  if (!t.command) return { ...base, status: 'not_run', summary: 'no type checker configured (tools.typecheck.command)', details: [], findings: [] };
  if (!ctx.files.some(isCode)) return { ...base, status: 'pass', summary: 'no code files changed', details: [], findings: [] };
  const r = runCommand(t.command, { cwd: ctx.root, files: ctx.files, timeoutMs: remainingMs(ctx) });
  const nr = notRunReason(r);
  if (nr) return { ...base, status: 'not_run', summary: nr, details: [], findings: [] };
  if (r.code === 0) return { ...base, status: 'pass', summary: 'whole project type-checks', details: [], findings: [] };
  const findings = toFindings('TYPE', 'typecheck', 'medium', r, ctx.git.allFiles());
  return { ...base, status: 'fail', summary: `${findings.length || 'some'} type error(s)`, details: outputLines(r).slice(0, 20), fix: 'fix the reported type errors', findings };
};

// ---------- tests related to the changed files ----------

export function summarizeTestOutput(out: string): { pass: number | null; fail: number | null; failures: string[] } {
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : null;
  };
  const pass = num(/^(?:#|ℹ)\s*pass\s+(\d+)/m) ?? num(/Tests:.*?(\d+) passed/) ?? num(/(\d+) passed/);
  const fail = num(/^(?:#|ℹ)\s*fail\s+(\d+)/m) ?? num(/Tests:.*?(\d+) failed/) ?? num(/(\d+) failed/);
  const failures = out
    .split('\n')
    .filter((l) => /^\s*(not ok \d+|✖|✕|FAIL\b|●)/.test(l) && !/^\s*✖ failing tests:/.test(l))
    .map((l) => l.trim().replace(/\s*\(\d+(\.\d+)?m?s\)$/, ''))
    .filter((l, i, a) => a.indexOf(l) === i);
  return { pass, fail, failures };
}

export function relatedTestsFor(ctx: Ctx): { tests: string[]; uncovered: string[] } {
  const all = ctx.git.allFiles();
  const graph = buildImportGraph(ctx.root, all);
  const tests = relatedTests(graph, ctx.files);
  const covered = new Set<string>();
  for (const t of tests) {
    const stack = [t];
    while (stack.length) {
      const f = stack.pop()!;
      if (covered.has(f)) continue;
      covered.add(f);
      stack.push(...(graph.get(f) ?? []));
    }
  }
  const uncovered = ctx.files.filter((f) => isCode(f) && !isTestFile(f) && !covered.has(f) && !/(^|\/)(tools|scripts|bin)\//.test(f) && !/\.config\./.test(f));
  return { tests, uncovered };
}

export const relatedTestsCheck: Check = (ctx) => {
  const t = ctx.rules.tools.tests;
  const base = { id: 'related_tests', title: 'related tests' };
  const codeChanged = ctx.files.filter(isCode);
  if (!codeChanged.length) return { ...base, status: 'pass', summary: 'no code files changed', details: [], findings: [] };

  let command = t.related;
  let tests: string[] = [];
  let uncovered: string[] = [];
  let note = '';
  if (command?.includes('{tests}')) {
    ({ tests, uncovered } = relatedTestsFor(ctx));
    if (!tests.length) {
      return {
        ...base,
        status: 'warn',
        summary: `no tests reach the ${codeChanged.length} changed code file(s)`,
        details: codeChanged.map((f) => `untested: ${f}`),
        fix: 'add a test from the requirement card (`preguard tests <id>`)',
        findings: [],
      };
    }
  } else if (!command) {
    const mode = ctx.rules.test_modes[0];
    if (!mode) return { ...base, status: 'not_run', summary: 'no test runner or test mode configured', details: [], findings: [] };
    command = mode.command;
    note = ` (runner can't select related tests; ran full "${mode.name}" mode)`;
  }

  const r = runCommand(command, { cwd: ctx.root, files: codeChanged, tests, timeoutMs: remainingMs(ctx) });
  const nr = notRunReason(r);
  if (nr) return { ...base, status: 'not_run', summary: nr, details: [], findings: [] };
  const s = summarizeTestOutput(r.stdout + '\n' + r.stderr);
  const counts = s.pass !== null ? `${s.pass} passed${s.fail ? `, ${s.fail} failed` : ''}` : '';
  const scope = tests.length ? `${tests.length} test file(s)` : 'related tests';
  if (r.code === 0) {
    const details = uncovered.map((f) => `no test reaches ${f}`);
    return {
      ...base,
      status: uncovered.length ? 'warn' : 'pass',
      summary: uncovered.length ? `no test reaches ${uncovered.join(', ')} (${scope} passed)` : `${scope}: ${counts || 'passed'}${note}`,
      details: [...tests.map((x) => `ran ${x}`), ...details],
      findings: [],
      data: { tests },
    };
  }
  const findings: Finding[] = s.failures.slice(0, 10).map((f, i) => {
    const loc = parseFileLines(f, [])[0];
    return { id: `TEST-${i + 1}`, category: 'failing_test', severity: 'high', confidence: 1, file: loc?.file ?? tests[0] ?? '(tests)', line: loc?.line ?? 1, reason: 'Test fails', evidence: f, origin: 'check' };
  });
  return {
    ...base,
    status: 'fail',
    summary: `${scope}: ${counts || 'failed'}${note}`,
    details: s.failures.length ? s.failures.slice(0, 15) : outputLines(r).slice(-15),
    fix: `reproduce with \`${r.command}\``,
    findings,
    data: { tests },
  };
};
