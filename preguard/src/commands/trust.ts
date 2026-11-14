import { Git } from '../lib/git.ts';
import { loadRules } from '../lib/rules.ts';
import { UsageError } from '../lib/context.ts';
import { adoptionDate, bucketize, buildTasks, categoryOf, wilsonLower, type Bucket, type Task } from '../lib/history.ts';
import { color } from '../lib/output.ts';
import { loadRuns } from '../lib/state.ts';
import { refreshDashboard } from '../lib/dashboard.ts';

// `preguard trust`: evidence for (or against) trusting changes, per category, from the repo's own git history.
//  1. Before vs. with Pre-PR Guard (adoption = the commit that added .preguard/rules.yml)
//  2. Trust per category, judged on tasks since adoption (the current process)
//  3. Pre-PR Guard's own accuracy, from `Preguard-Status:` commit trailers: how often a 🟢 still failed

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const failed = (t: Task) => t.outcome === 'reverted' || t.outcome === 'follow_up_fix';
const settled = (ts: Task[]) => ts.filter((t) => t.outcome !== 'too_recent');

function rateLine(ts: Task[]) {
  const s = settled(ts);
  const ok = s.filter((t) => t.outcome === 'success').length;
  return { tasks: ts.length, settled: s.length, success: ok, rate: s.length ? ok / s.length : null, lower: wilsonLower(ok, s.length), reverted: s.filter((t) => t.outcome === 'reverted').length, followUp: s.filter((t) => t.outcome === 'follow_up_fix').length };
}

export function trustData(cwd: string) {
  const root = Git.findRoot(cwd);
  if (!root) throw new UsageError('not inside a git repository');
  const git = new Git(root);
  const { rules } = loadRules(root);
  const base = git.baseBranch(rules.base_branch);
  if (!base) throw new UsageError('no base branch found to read history from');
  const { tasks, untagged, scanned } = buildTasks(root, git, rules, base);
  const adopted = adoptionDate(git, base);
  const before = adopted ? tasks.filter((t) => t.last < adopted) : [];
  const withPg = adopted ? tasks.filter((t) => t.last >= adopted) : tasks;
  const current = withPg.length ? withPg : tasks;
  const byCategory = bucketize(current, rules, (t) => categoryOf(t.layers, t.aiAssisted));
  // Per developer (PR author), over all settled history: PRs, worked perfectly, hit a defect, reverted.
  const byDeveloper = bucketize(tasks, rules, (t) => t.author);
  const beforeByCategory = new Map(bucketize(before, rules, (t) => categoryOf(t.layers, t.aiAssisted)).map((b) => [b.category, b]));
  // Pre-PR Guard accuracy from commit trailers.
  const verdicts = settled(tasks).filter((t) => t.preguard);
  const greens = verdicts.filter((t) => t.preguard!.status === 'green');
  const falseGreens = greens.filter(failed);
  const reds = verdicts.filter((t) => t.preguard!.status === 'red');
  const bypassed = reds.filter((t) => t.preguard!.bypassed);
  const yellows = verdicts.filter((t) => t.preguard!.status === 'yellow');
  return {
    root, rules, base, tasks, untagged, scanned, adopted,
    periods: { before: rateLine(before), with: rateLine(withPg) },
    byCategory, beforeByCategory, byDeveloper,
    accuracy: {
      verdicts: verdicts.length,
      greens: greens.length,
      falseGreens: falseGreens.map((t) => t.id),
      yellows: yellows.length,
      yellowFailed: yellows.filter(failed).length,
      reds: reds.length,
      bypassed: bypassed.length,
      bypassedFailed: bypassed.filter(failed).map((t) => t.id),
    },
  };
}

export function trustCommand(opts: { cwd: string; json?: boolean; verbose?: boolean }): number {
  const d = trustData(opts.cwd);
  if (opts.json) {
    const slim = (t: Task) => ({ id: t.id, title: t.title, author: t.author, outcome: t.outcome, evidence: t.evidence, layers: t.layers, ai_assisted: t.aiAssisted, risk: t.risk, preguard: t.preguard, last: t.last.toISOString() });
    console.log(JSON.stringify({ base: d.base, adopted: d.adopted?.toISOString() ?? null, scanned_commits: d.scanned, untagged_commits: d.untagged, settings: d.rules.trust, periods: d.periods, by_category: d.byCategory, by_developer: d.byDeveloper, accuracy: d.accuracy, tasks: d.tasks.map(slim) }, null, 2));
    return 0;
  }
  const t = d.rules.trust;
  const recent = d.tasks.filter((x) => x.outcome === 'too_recent').length;
  console.log(`${color.bold('preguard trust')}  ${d.tasks.length} task(s) from ${d.scanned} commit(s) on ${d.base} · ${d.untagged} untagged commit(s)${recent ? ` · ${recent} too recent to judge` : ''}`);
  console.log(color.dim(`  success = not reverted and no follow-up fix within ${t.window_days} days · trust "earned" = ≥ ${t.min_tasks} settled tasks and 95% lower bound ≥ ${pct(t.required_lower_bound)}`));

  // 1. Before vs with
  if (d.adopted) {
    const b = d.periods.before;
    const w = d.periods.with;
    console.log(`\n${color.bold('Before vs with Pre-PR Guard')} ${color.dim(`(adopted ${d.adopted.toISOString().slice(0, 10)})`)}`);
    const row = (label: string, r: typeof b) =>
      console.log(`  ${label.padEnd(20)} ${String(r.settled).padStart(3)} tasks  success ${pct(r.rate).padStart(4)}  (95% lower ${pct(r.lower).padStart(4)})  reverted ${String(r.reverted).padStart(2)}  follow-up fixes ${String(r.followUp).padStart(2)}`);
    row('before', b);
    row('with Pre-PR Guard', w);
    if (b.rate !== null && w.rate !== null && b.settled && w.settled) {
      const fb = 1 - b.rate;
      const fw = 1 - w.rate;
      const change = fb ? Math.round(((fb - fw) / fb) * 100) : 0;
      console.log(`  ${color.bold(`failure rate ${pct(fb)} → ${pct(fw)}`)}${change > 0 ? color.green(` (${change}% fewer failed tasks)`) : change < 0 ? color.red(` (${-change}% more failed tasks)`) : ''}`);
    }
  }

  // 2. Per category
  console.log(`\n${color.bold('Trust per category')} ${color.dim(d.adopted ? '(judged on tasks since adoption)' : '')}`);
  console.log(color.dim(`  ${'category'.padEnd(24)} before  now   tasks  95% lower  trust`));
  for (const b of d.byCategory) {
    const prev = d.beforeByCategory.get(b.category);
    const label = b.trust === 'earned' ? color.green('earned: fast accept allowed') : b.trust === 'not_earned' ? color.red(`not earned${b.needed !== null ? ` (+${b.needed} successes in a row)` : ''}`) : color.yellow(`building${b.needed !== null ? ` (+${b.needed} successes in a row)` : ''}`);
    console.log(`  ${b.category.padEnd(24)} ${pct(prev?.rate ?? null).padStart(6)}  ${pct(b.rate).padStart(4)}  ${String(b.settled).padStart(5)}  ${pct(b.lowerBound).padStart(9)}  ${label}`);
  }

  // 2b. Per developer
  console.log(`\n${color.bold('Per developer')} ${color.dim('(PR = task; all settled history)')}`);
  console.log(color.dim(`  ${'developer'.padEnd(16)}   PRs  worked perfectly  hit a defect  reverted  defect rate  trust ratio  95% lower  trust`));
  for (const b of d.byDeveloper) {
    const defects = b.followUp + b.reverted;
    const label = b.trust === 'earned' ? color.green('earned') : b.trust === 'not_earned' ? color.red(`not earned${b.needed !== null ? ` (+${b.needed})` : ''}`) : color.yellow(`building${b.needed !== null ? ` (+${b.needed})` : ''}`);
    console.log(`  ${b.category.padEnd(16)} ${String(b.settled).padStart(5)}  ${String(b.success).padStart(16)}  ${String(b.followUp).padStart(12)}  ${String(b.reverted).padStart(8)}  ${pct(b.settled ? defects / b.settled : null).padStart(11)}  ${pct(b.rate).padStart(11)}  ${pct(b.lowerBound).padStart(9)}  ${label}`);
  }
  console.log(color.dim('  Use per-person numbers to choose review depth and pairing, not to rank people: small samples swing a lot.'));

  // 3. Accuracy
  const a = d.accuracy;
  console.log(`\n${color.bold('Pre-PR Guard accuracy')} ${color.dim('(from Preguard-Status commit trailers)')}`);
  if (!a.verdicts) console.log(color.dim('  no tasks carry a Preguard-Status trailer yet (add the line `preguard ready` prints to the merge commit)'));
  else {
    console.log(`  🟢 ready: ${a.greens} task(s), ${color.bold(`${a.falseGreens.length} false green(s)`)} (${pct(a.greens ? a.falseGreens.length / a.greens : null)})${a.falseGreens.length ? color.dim(`: ${a.falseGreens.join(', ')}`) : ''}`);
    console.log(`  🟡 notes: ${a.yellows} task(s), ${a.yellowFailed} failed`);
    console.log(`  🔴 merged anyway with a bypass: ${a.bypassed} task(s), ${a.bypassedFailed.length} failed${a.bypassedFailed.length ? color.dim(`: ${a.bypassedFailed.join(', ')}`) : ''}`);
  }

  if (opts.verbose) {
    console.log('');
    for (const task of d.tasks) {
      const mark = task.outcome === 'success' ? color.green('✔') : task.outcome === 'too_recent' ? color.dim('…') : color.red('✘');
      const pg = task.preguard ? ` [${task.preguard.status}${task.preguard.bypassed ? ', bypassed' : ''}]` : '';
      console.log(`  ${mark} ${task.id.padEnd(10)} ${task.last.toISOString().slice(0, 10)} ${task.outcome.padEnd(14)} ${task.author.padEnd(10)} ${categoryOf(task.layers, task.aiAssisted).padEnd(24)} ${task.title.slice(0, 44)}${color.dim(pg)}`);
      for (const e of task.evidence) console.log(`      ${color.dim(e)}`);
    }
  } else console.log(color.dim('\nUse -v to list every task with the commit that proves its outcome, --json for dashboards.'));
  try {
    console.log(color.dim(`Dashboard: ${refreshDashboard(d.root, loadRuns(d.root, 1)[0]?.card ?? null)}`));
  } catch {}
  return 0;
}

export type { Bucket };
