import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, runCommand } from '../lib/exec.ts';
import { matchesAny, remainingMs, type Check, type Ctx } from '../lib/context.ts';
import { stateDir } from '../lib/state.ts';
import type { Finding } from '../lib/types.ts';

// Front-end additions (§8.2): accessibility basics, before/after screenshots of changed
// screens, critical flows. Each only runs when front-end files changed.

function frontendChanged(ctx: Ctx): string[] {
  const fe = ctx.rules.layers.frontend;
  return fe.length ? ctx.files.filter((f) => matchesAny(f, fe)) : ctx.files.filter((f) => /\.(html|vue|svelte|jsx|tsx|css)$/.test(f));
}

/** Changed pages: changed .html files plus pages whose <script src> points at a changed file. */
function changedPages(ctx: Ctx, changed: string[]): string[] {
  const pages = new Set(changed.filter((f) => f.endsWith('.html')));
  for (const f of ctx.git.allFiles().filter((x) => x.endsWith('.html'))) {
    let html: string;
    try {
      html = fs.readFileSync(path.join(ctx.root, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (changed.includes(target)) pages.add(f);
    }
  }
  return [...pages].sort();
}

export function a11yProblems(html: string): { line: number; issue: string }[] {
  const out: { line: number; issue: string }[] = [];
  const lineAt = (i: number) => html.slice(0, i).split('\n').length;
  const m = /<html\b([^>]*)>/i.exec(html);
  if (m && !/\blang=/.test(m[1])) out.push({ line: lineAt(m.index), issue: '<html> has no lang attribute' });
  for (const im of html.matchAll(/<img\b([^>]*)>/gi)) if (!/\balt=/.test(im[1])) out.push({ line: lineAt(im.index!), issue: '<img> has no alt text' });
  const labels = new Set([...html.matchAll(/<label[^>]*\bfor=["']([^"']+)["']/gi)].map((x) => x[1]));
  for (const inp of html.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const attrs = inp[2];
    if (/type=["']?(hidden|submit|button|reset)/i.test(attrs)) continue;
    const id = /\bid=["']([^"']+)["']/.exec(attrs)?.[1];
    if (!/aria-label(ledby)?=/.test(attrs) && !(id && labels.has(id))) out.push({ line: lineAt(inp.index!), issue: `<${inp[1]}${id ? ` id="${id}"` : ''}> has no label` });
  }
  for (const b of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (!b[2].replace(/<[^>]+>/g, '').trim() && !/aria-label/.test(b[1])) out.push({ line: lineAt(b.index!), issue: '<button> has no text or aria-label' });
  }
  return out;
}

export const a11yCheck: Check = (ctx) => {
  const base = { id: 'a11y', title: 'accessibility basics' };
  const changed = frontendChanged(ctx);
  if (!changed.length) return { ...base, status: 'pass', summary: 'no front-end files changed', details: [], findings: [] };
  const pages = changedPages(ctx, changed);
  if (!pages.length) return { ...base, status: 'pass', summary: 'no changed page found to check', details: [], findings: [] };
  const findings: Finding[] = [];
  for (const p of pages) {
    for (const prob of a11yProblems(fs.readFileSync(path.join(ctx.root, p), 'utf8'))) {
      findings.push({ id: `A11Y-${findings.length + 1}`, category: 'accessibility', severity: 'medium', confidence: 0.9, file: p, line: prob.line, reason: prob.issue, evidence: `${p}:${prob.line} ${prob.issue}`, origin: 'check' });
    }
  }
  if (!findings.length) return { ...base, status: 'pass', summary: `${pages.length} changed page(s): lang, alt text, labels, button text OK`, details: [], findings };
  return { ...base, status: 'warn', summary: `${findings.length} accessibility problem(s)`, details: findings.map((f) => f.evidence), fix: 'add the missing label/alt/lang', findings };
};

function findBrowser(): string | null {
  const candidates = [
    process.env.PREGUARD_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter((x): x is string => !!x);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const r = run('which', [name], { cwd: os.tmpdir() });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function shoot(browser: string, file: string, out: string, timeoutMs: number): boolean {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-chrome-'));
  // Headless Chrome writes the PNG quickly but may not exit, so wait for the file, then stop it.
  const flags = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', `--user-data-dir=${profile}`, '--window-size=1024,768', '--timeout=2000', `--screenshot=${out}`, `file://${file}`];
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const tries = Math.max(10, Math.floor(timeoutMs / 100));
  const script = `${[browser, ...flags].map(q).join(' ')} >/dev/null 2>&1 & pid=$!
i=0; while [ $i -lt ${tries} ]; do if [ -s ${q(out)} ]; then sleep 0.3; break; fi; kill -0 $pid 2>/dev/null || break; sleep 0.1; i=$((i+1)); done
kill $pid 2>/dev/null; wait $pid 2>/dev/null; [ -s ${q(out)} ]`;
  const r = run('/bin/sh', ['-c', script], { cwd: os.tmpdir(), timeoutMs: timeoutMs + 5000 });
  fs.rmSync(profile, { recursive: true, force: true });
  return r.code === 0 && fs.existsSync(out);
}

export const screenshotCheck: Check = (ctx) => {
  const base = { id: 'screenshots', title: 'before/after screens' };
  const changed = frontendChanged(ctx);
  if (!changed.length) return { ...base, status: 'pass', summary: 'no front-end files changed', details: [], findings: [] };
  const pages = changedPages(ctx, changed);
  if (!pages.length) return { ...base, status: 'not_run', summary: 'front-end changed, but no page that uses it was found', details: changed, findings: [] };
  const browser = findBrowser();
  if (!browser) return { ...base, status: 'not_run', summary: 'no Chrome/Chromium found (set PREGUARD_BROWSER)', details: [], findings: [] };

  const outDir = path.join(stateDir(ctx.root, ctx.card?.id ?? null), 'screens');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // "before" = the base branch, checked out in a throwaway worktree.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-before-'));
  const added = ctx.git.tryGit(['worktree', 'add', '--detach', wt, ctx.diffBase ?? 'HEAD']) !== null;
  const details: string[] = [];
  try {
    for (const p of pages) {
      const name = p.replace(/[\/]/g, '_').replace(/\.html$/, '');
      const before = path.join(outDir, `${name}.before.png`);
      const after = path.join(outDir, `${name}.after.png`);
      const okB = added && fs.existsSync(path.join(wt, p)) ? shoot(browser, path.join(wt, p), before, Math.min(20000, remainingMs(ctx))) : false;
      const okA = shoot(browser, path.join(ctx.root, p), after, Math.min(20000, remainingMs(ctx)));
      details.push(`${p}: ${okB ? path.relative(ctx.root, before) : 'before: new page'} → ${okA ? path.relative(ctx.root, after) : 'after: failed'}`);
    }
  } finally {
    if (added) ctx.git.tryGit(['worktree', 'remove', '--force', wt]);
    fs.rmSync(wt, { recursive: true, force: true });
  }
  return {
    ...base,
    status: 'pass',
    summary: `${pages.length} page(s) captured before/after (static render: script-driven content isn't shown)`,
    details,
    findings: [],
    data: { dir: path.relative(ctx.root, outDir) },
  };
};

/** End-to-end suite: runs on every review (not only when a critical path is touched). */
export const e2eCheck: Check = (ctx) => {
  const base = { id: 'e2e', title: 'end-to-end tests' };
  const e2e = ctx.rules.tools.e2e;
  if (!e2e) return { ...base, status: 'not_run', summary: 'no e2e suite configured (tools.e2e)', details: [], findings: [] };
  const r = runCommand(e2e, { cwd: ctx.root, timeoutMs: remainingMs(ctx) });
  if (r.timedOut) return { ...base, status: 'not_run', summary: `timed out running \`${r.command}\``, details: [], findings: [] };
  const out = (r.stdout + '\n' + r.stderr).split('\n');
  const n = out.map((l) => /^(?:#|ℹ)\s*pass\s+(\d+)/.exec(l)?.[1]).find(Boolean);
  if (r.code === 0) return { ...base, status: 'pass', summary: n ? `${n} passed` : 'passed', details: [], findings: [], data: { ran: true } };
  const failures = out.filter((l) => /^\s*(not ok \d+|✖|✕|FAIL\b)/.test(l)).map((l) => l.trim()).filter((l, i, a) => a.indexOf(l) === i && !/failing tests:/.test(l));
  return {
    ...base,
    status: 'fail',
    summary: `e2e failing (${failures.length || 'see output'})`,
    details: failures.length ? failures.slice(0, 10) : out.slice(-10),
    fix: `reproduce with \`${r.command}\``,
    findings: (failures.length ? failures : [`\`${r.command}\` exit ${r.code}`]).slice(0, 5).map((f, i) => ({ id: `E2E-${i + 1}`, category: 'failing_test', severity: 'high' as const, confidence: 1, file: '(e2e)', line: 1, reason: 'End-to-end test fails', evidence: f, origin: 'check' as const })),
    data: { ran: true },
  };
};

/** Critical paths (login, checkout, auth, payments, migrations) need the e2e suite to have run and passed. */
export const criticalFlowCheck: Check = (ctx) => {
  const base = { id: 'critical_flows', title: 'critical flows' };
  const cp = ctx.rules.critical_paths;
  const hit = ctx.files.filter((f) => matchesAny(f, [...cp.frontend, ...cp.backend]));
  if (!hit.length) return { ...base, status: 'pass', summary: 'no critical path touched', details: [], findings: [] };
  const e2e = ctx.results.find((r) => r.id === 'e2e');
  if (!e2e || e2e.status === 'not_run') return { ...base, status: 'not_run', summary: `critical path touched (${hit.join(', ')}) but the e2e suite did not run`, details: hit, findings: [] };
  if (e2e.status === 'pass') return { ...base, status: 'pass', summary: `critical path touched; e2e passed`, details: hit, findings: [] };
  return { ...base, status: 'fail', summary: 'critical path touched and e2e is failing', details: hit, fix: 'fix the e2e failures above before merging a critical-path change', findings: [{ id: 'CRIT-1', category: 'failing_test', severity: 'high', confidence: 1, file: hit[0], line: 1, reason: 'Critical flow changed while end-to-end tests fail', evidence: e2e.summary, origin: 'check' }] };
};
