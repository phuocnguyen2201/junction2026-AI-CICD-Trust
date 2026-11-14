import fs from 'node:fs';
import path from 'node:path';
import { buildContext, UsageError } from '../lib/context.ts';
import { loadBypasses, loadStage, saveBypasses, stateDir, type StageRecord } from '../lib/state.ts';
import { acCoverage, assess, renderReport, STATUS_LABEL, trackFor, type TrackLine } from '../lib/report.ts';
import { NEVER_BYPASS } from '../lib/rules.ts';
import { runReview } from './review.ts';
import { recordRun } from '../lib/dashboard.ts';
import { runEntryFor } from '../lib/state.ts';
import { color } from '../lib/output.ts';
import type { Finding } from '../lib/types.ts';

const key = (f: Finding) => `${f.category}|${f.file}|${f.reason}`;

export async function readyCommand(opts: { cwd: string; id?: string; bypass?: string; reason?: string; noRun?: boolean; json?: boolean }): Promise<number> {
  let ctx = buildContext({ cwd: opts.cwd, mode: 'branch', id: opts.id, budgetMs: (r) => r.time_budget.push_minutes * 60_000 });
  const cardId = ctx.card?.id ?? null;
  const headTree = ctx.git.headTree();

  // 1. Review results must describe exactly the current code, or they don't count.
  let review: StageRecord | null = loadStage(ctx.root, cardId, 'review');
  const fresh = review && review.tree !== null && review.tree === ctx.git.currentTree('branch');
  if (!fresh) {
    if (opts.noRun) {
      review = null;
    } else {
      if (!opts.json) console.log(color.dim(review ? 'Review results are for older code: running `preguard review` again…' : 'No review results yet: running `preguard review`…'));
      ({ ctx, record: review } = await runReview({ cwd: opts.cwd, id: opts.id }));
    }
  }
  if (!review) throw new UsageError('no up-to-date review results (run `preguard review`, or drop --no-run)');
  if (ctx.git.isDirty() && !opts.json) console.log(color.yellow('! Uncommitted changes: this report describes the working tree, not a commit.'));

  // 2. Bypass: only allowed checks, only with a reason, only for this exact tree.
  let bypasses = loadBypasses(ctx.root, cardId).filter((b) => b.tree === headTree);
  if (opts.bypass) {
    const target = review.results.find((r) => r.id === opts.bypass);
    if (NEVER_BYPASS.includes(opts.bypass)) throw new UsageError(`"${opts.bypass}" can't be bypassed: ${opts.bypass === 'secrets' ? 'a pushed secret is leaked for good' : 'that decision belongs to its owner, not the developer'}`);
    if (!ctx.rules.bypass.allowed.includes(opts.bypass)) throw new UsageError(`"${opts.bypass}" is not in bypass.allowed in .preguard/rules.yml`);
    if (!target) throw new UsageError(`no check "${opts.bypass}" in the review results (ids: ${review.results.map((r) => r.id).join(', ')})`);
    if (target.status !== 'fail') throw new UsageError(`"${opts.bypass}" is not failing (${target.status}); nothing to bypass`);
    if (!opts.reason || opts.reason.trim().length < 15) throw new UsageError('--reason is required (at least 15 characters) so the reviewer knows why');
    if (!headTree) throw new UsageError('commit first: a bypass is tied to one commit');
    bypasses = bypasses.filter((b) => b.check !== opts.bypass);
    bypasses.push({ check: opts.bypass, reason: opts.reason.trim(), tree: headTree, by: ctx.git.userName(), at: new Date().toISOString() });
    saveBypasses(ctx.root, cardId, bypasses);
  }
  const unanswered = (ctx.card?.card?.open_decisions ?? []).some((d) => !d.answer);
  if (opts.bypass && unanswered && !opts.json) console.log(color.yellow('! Open decisions can never be bypassed; the owner still has to answer them.'));

  // 3. Commit hook: did `preguard check` run on what is now HEAD?
  const check = loadStage(ctx.root, cardId, 'check');
  const commitHook =
    check && check.tree && check.tree === headTree
      ? { ran: true, note: `ran on the latest commit: ${check.results.filter((r) => r.status === 'fail').length ? 'it failed, so the commit used --no-verify' : 'passed'}` }
      : { ran: false, note: 'did not run on the latest commit (hook not installed, or --no-verify)' };

  // 4. Assess + fixed-since-last-report.
  const coverage = acCoverage(ctx, review);
  const a = assess(ctx, review.results, bypasses, coverage);
  if (!commitHook.ran) a.notRun.push({ id: 'commit_hook', title: 'commit hook', status: 'not_run', summary: commitHook.note, details: [], findings: [], ms: 0 });
  if (!commitHook.ran && a.status !== 'red') {
    if (a.status === 'green') a.why = [];
    a.status = 'yellow';
    a.why.push('commit hook did not run on the latest commit');
  }
  const histPath = path.join(stateDir(ctx.root, cardId), 'last-findings.json');
  let prev: { open: Finding[]; fixed: Finding[] } = { open: [], fixed: [] };
  try {
    prev = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  } catch {}
  // Fixed = was open in an earlier report on this branch, and isn't open now.
  const nowKeys = new Set(a.openFindings.map(key));
  const fixedMap = new Map<string, Finding>();
  for (const f of [...(prev.fixed ?? []), ...(prev.open ?? [])]) if (!nowKeys.has(key(f))) fixedMap.set(key(f), { ...f, status: 'fixed' });
  const fixed = [...fixedMap.values()];
  fs.mkdirSync(path.dirname(histPath), { recursive: true });
  fs.writeFileSync(histPath, JSON.stringify({ open: a.openFindings, fixed }, null, 2));

  // 5. Track record for this kind of change (from git history), then write the report (local only).
  let track: TrackLine | null = null;
  try {
    track = trackFor(ctx);
  } catch {}
  const md = renderReport({ ctx, review, commitHook, coverage, a, fixed, track });
  fs.writeFileSync(path.join(stateDir(ctx.root, cardId), 'ready.json'), JSON.stringify({ status: a.status, head: ctx.git.head(), tree: headTree, at: new Date().toISOString() }, null, 2));
  const out = path.join(ctx.root, '.preguard/reports', `${cardId ?? 'no-card'}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);

  let dashboard = '';
  try {
    dashboard = recordRun(ctx.root, cardId, { ...runEntryFor(review, a.status), stage: 'ready' });
  } catch {}

  const proceed = a.status !== 'red' || (a.bypassed.length > 0 && a.bypassed.length === review.results.filter((r) => r.status === 'fail').length && !a.unanswered.length);
  if (opts.json) {
    console.log(JSON.stringify({ stage: 'ready', status: a.status, why: a.why, card: cardId, report: path.relative(ctx.root, out), dashboard, bypassed: a.bypassed.map((b) => b.result.id), findings: a.openFindings, fixed }, null, 2));
    return proceed ? 0 : 1;
  }
  const head = a.status === 'red' ? color.red : a.status === 'yellow' ? color.yellow : color.green;
  console.log(`${color.bold(head(STATUS_LABEL[a.status]))}  ${a.why.join('; ')}`);
  for (const b of a.bypassed) console.log(color.yellow(`  bypassed ${b.result.id} by ${b.bypass.by}: "${b.bypass.reason}"`));
  for (const f of a.openFindings.filter((x) => x.severity === 'high').slice(0, 6)) console.log(`  ${color.red('●')} ${f.file}:${f.line}  ${f.reason}`);
  for (const d of a.unanswered) console.log(`  ${color.red('?')} ${d.id} → ${d.owner_role}: ${d.question}`);
  if (fixed.length) console.log(color.green(`  fixed since last report: ${fixed.length} finding(s)`));
  if (track) console.log(color.dim(`  track record (${track.category}): ${track.text}`));
  console.log(color.dim(`Report: ${path.relative(ctx.root, out)}${dashboard ? ` · dashboard: ${dashboard}` : ''}`));
  // A verdict in git history is what lets `preguard trust` measure false greens later, for everyone.
  if (proceed) console.log(color.dim(`Record it in the final commit message: Preguard-Status: ${a.status}${a.bypassed.length ? ` (bypassed: ${a.bypassed.map((b) => b.result.id).join(', ')})` : ''}`));
  return proceed ? 0 : 1;
}
