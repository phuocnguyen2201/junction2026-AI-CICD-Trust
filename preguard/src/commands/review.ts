import { buildContext, runChecks, type Check, type Ctx } from '../lib/context.ts';
import { COMMIT_CHECKS } from './check.ts';
import { allTestsCheck, testInventoryCheck } from '../checks/alltests.ts';
import { scopeCheck } from '../checks/scope.ts';
import { apiContractCheck, migrationCheck } from '../checks/contract.ts';
import { a11yCheck, criticalFlowCheck, e2eCheck, screenshotCheck } from '../checks/frontend.ts';
import { aiImpactCheck, aiReviewCheck } from '../checks/ai.ts';
import { runEntryFor, saveStage, type StageRecord } from '../lib/state.ts';
import { recordRun } from '../lib/dashboard.ts';
import { color, printCompact, printResults, secs } from '../lib/output.ts';
import type { CheckResult } from '../lib/types.ts';

export const AI_CHECKS: [string, string, Check][] = [
  ['ai_review', 'AI self-review', aiReviewCheck],
  ['impact', 'impact report', aiImpactCheck],
];

// Pre-push stage (§8.2): the whole branch, everything CI would run, plus the full-review checks.
// The AI runs last so it can see (and not repeat) what the deterministic checks found.
export const REVIEW_CHECKS: [string, string, Check][] = [
  ...COMMIT_CHECKS.filter(([id]) => id !== 'related_tests'),
  ['all_tests', 'all tests (every mode)', allTestsCheck],
  ['e2e', 'end-to-end tests', e2eCheck],
  ['test_inventory', 'test inventory', testInventoryCheck],
  ['scope', 'scope vs card', scopeCheck],
  ['api_contract', 'API contract', apiContractCheck],
  ['migrations', 'migrations', migrationCheck],
  ['a11y', 'accessibility basics', a11yCheck],
  ['screenshots', 'before/after screens', screenshotCheck],
  ['critical_flows', 'critical flows', criticalFlowCheck],
  ...AI_CHECKS,
];

export async function runReview(opts: { cwd: string; id?: string; staged?: boolean }): Promise<{ ctx: Ctx; record: StageRecord; dashboard: string }> {
  const ctx = buildContext({
    cwd: opts.cwd,
    mode: opts.staged ? 'staged' : 'branch',
    id: opts.id,
    budgetMs: (r) => (opts.staged ? r.time_budget.commit_seconds * 1000 + r.ai.timeout_seconds * 1000 : r.time_budget.push_minutes * 60_000),
  });
  const start = Date.now();
  // --staged: the fast commit checks + the AI, on exactly what you are about to commit.
  const results: CheckResult[] = await runChecks(ctx, opts.staged ? [...COMMIT_CHECKS, ...AI_CHECKS] : REVIEW_CHECKS);
  const record: StageRecord = {
    stage: opts.staged ? 'review_staged' : 'review',
    card_id: ctx.card?.id ?? null,
    head: ctx.git.head(),
    tree: ctx.git.currentTree(opts.staged ? 'staged' : 'branch'),
    branch: ctx.git.branch(),
    dirty: ctx.git.isDirty(),
    files_mode: ctx.filesMode,
    files: ctx.files,
    started_at: new Date(start).toISOString(),
    ms: Date.now() - start,
    budget_ms: ctx.budgetMs,
    results,
  };
  saveStage(ctx.root, record);
  let dashboard = '';
  try {
    dashboard = recordRun(ctx.root, record.card_id, runEntryFor(record));
  } catch {}
  return { ctx, record, dashboard };
}

export async function reviewCommand(opts: { cwd: string; id?: string; json?: boolean; verbose?: boolean; hook?: boolean; staged?: boolean }): Promise<number> {
  const { ctx, record, dashboard } = await runReview(opts);
  const failed = record.results.filter((r) => r.status === 'fail');
  if (opts.json) {
    console.log(JSON.stringify({ stage: record.stage, ok: !failed.length, ms: record.ms, card: record.card_id, files: record.files, results: record.results }, null, 2));
    return failed.length ? 1 : 0;
  }
  const what = opts.staged ? `${ctx.files.length} staged file(s)` : `${ctx.files.length} file(s) vs ${ctx.baseBranch ?? 'HEAD'}`;
  if (opts.verbose) {
    console.log(`${color.bold(opts.staged ? 'preguard review --staged' : 'preguard review')}  ${what} · ${ctx.card ? `card ${ctx.card.id}` : 'no card'}`);
    printResults(record.results, { verbose: true });
  } else printCompact(record.results);
  const ai = record.results.find((r) => r.id === 'ai_review');
  if (ai && ai.findings.length) {
    console.log(color.bold('AI findings') + color.dim(' (checked: evidence exists at file:line)'));
    for (const f of ai.findings) {
      console.log(`  ${f.severity === 'high' ? color.red('●') : color.yellow('●')} ${f.file}:${f.line}  ${f.reason}`);
      console.log(`    ${color.dim(f.evidence)}`);
      if (f.source_url) console.log(`    ${color.cyan(f.source_url)}`);
    }
  }
  const verdict = failed.length ? color.red(color.bold('BLOCKED')) + ` ${failed.length} check(s) failing` : color.green(color.bold('OK'));
  console.log(`${verdict} ${color.dim(`· ${ctx.card?.id ?? 'no card'} · ${what} · ${secs(record.ms)}${record.ms > ctx.budgetMs ? ' (over budget)' : ''}`)}`);
  if (!opts.staged) console.log(color.dim(`Next: preguard ready${ctx.card ? ` --id ${ctx.card.id}` : ''}`));
  if (dashboard) console.log(color.dim(`Dashboard: ${dashboard}`));
  return failed.length ? 1 : 0;
}
