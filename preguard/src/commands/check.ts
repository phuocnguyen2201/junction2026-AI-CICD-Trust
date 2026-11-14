import { buildContext, runChecks, type Check, type FilesMode } from '../lib/context.ts';
import { pinnedEnvCheck } from '../checks/env.ts';
import { secretScanCheck } from '../checks/secrets.ts';
import { publicApiCheck } from '../checks/api.ts';
import { formatCheck, lintCheck, relatedTestsCheck, typeCheck } from '../checks/tools.ts';
import { runEntryFor, saveStage, type StageRecord } from '../lib/state.ts';
import { recordRun } from '../lib/dashboard.ts';
import { color, printCompact, printResults, secs } from '../lib/output.ts';
import { RULES_PATH } from '../lib/rules.ts';

// Commit stage (§8.1): fast checks on changed files only. Cheap checks first so a
// tight budget still gets the most signal.
export const COMMIT_CHECKS: [string, string, Check][] = [
  ['pinned_env', 'pinned env', pinnedEnvCheck],
  ['secrets', 'secret scan', secretScanCheck],
  ['public_api', 'public API flag', publicApiCheck],
  ['format', 'format', formatCheck],
  ['lint', 'lint', lintCheck],
  ['typecheck', 'type check', typeCheck],
  ['related_tests', 'related tests', relatedTestsCheck],
];

export async function checkCommand(opts: { cwd: string; mode?: FilesMode; id?: string; fix?: boolean; json?: boolean; hook?: boolean; verbose?: boolean }): Promise<number> {
  const ctx = buildContext({ ...opts, budgetMs: (r) => r.time_budget.commit_seconds * 1000 });
  const start = Date.now();
  if (!ctx.rulesExists && !opts.json) console.log(color.yellow(`! ${RULES_PATH} not found: using defaults. Run \`preguard init\` first.`));

  // ai.on_commit: also run the AI self-review in the commit stage (its own time allowance on top).
  let checks = COMMIT_CHECKS;
  if (ctx.rules.ai.on_commit) {
    const { AI_CHECKS } = await import('./review.ts');
    checks = [...COMMIT_CHECKS, ...AI_CHECKS];
    ctx.deadline += ctx.rules.ai.timeout_seconds * 1000;
  }
  const results = await runChecks(ctx, checks);
  const ms = Date.now() - start;
  const record: StageRecord = {
    stage: 'check',
    card_id: ctx.card?.id ?? null,
    head: ctx.git.head(),
    tree: ctx.git.currentTree(ctx.filesMode),
    branch: ctx.git.branch(),
    dirty: ctx.git.isDirty(),
    files_mode: ctx.filesMode,
    files: ctx.files,
    started_at: new Date(start).toISOString(),
    ms,
    budget_ms: ctx.budgetMs,
    results,
  };
  saveStage(ctx.root, record);
  let dashboard = '';
  try {
    dashboard = recordRun(ctx.root, record.card_id, runEntryFor(record));
  } catch {}

  const failed = results.filter((r) => r.status === 'fail');
  if (opts.json) {
    console.log(JSON.stringify({ stage: 'check', ok: failed.length === 0, ms, budget_ms: ctx.budgetMs, card: ctx.card?.id ?? null, files: ctx.files, results }, null, 2));
    return failed.length ? 1 : 0;
  }

  const modeLabel = { staged: 'staged', branch: `changed vs ${ctx.baseBranch ?? 'HEAD'}`, all: 'all files' }[ctx.filesMode];
  const cardLabel = ctx.card ? `card ${ctx.card.id}${ctx.card.errors.length ? color.red(' (invalid)') : ''}` : color.dim('no requirement card');
  const over = ms > ctx.budgetMs;
  const time = `${secs(ms)}${over ? color.yellow(` (over ${secs(ctx.budgetMs)} budget)`) : ''}`;
  if (opts.verbose) {
    console.log(`${color.bold('preguard check')}  ${ctx.files.length} file(s) ${modeLabel} · ${cardLabel}`);
    printResults(results, { verbose: true });
  } else {
    printCompact(results);
  }
  const verdict = failed.length ? color.red(color.bold(`BLOCKED`)) + ` ${failed.length} check(s) failing` : color.green(color.bold('OK'));
  console.log(`${verdict} ${color.dim(`· ${ctx.card ? ctx.card.id : 'no card'} · ${ctx.files.length} file(s) · ${time}`)}`);
  if (failed.length && opts.hook) console.log(color.dim('Fix the above, or bypass with --no-verify (shown as "not run" in the readiness report).'));
  if (dashboard && !opts.hook) console.log(color.dim(`Dashboard: ${dashboard}`));
  return failed.length ? 1 : 0;
}
