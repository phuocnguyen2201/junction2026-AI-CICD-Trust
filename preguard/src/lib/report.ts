import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.ts';
import type { Bypass, StageRecord } from './state.ts';
import { isAnswered } from './card.ts';
import { isTestFile } from './imports.ts';
import type { CheckResult, Finding } from './types.ts';
import { adoptionDate, bucketize, buildTasks, categoryOf } from './history.ts';

export interface TrackLine {
  category: string;
  text: string;
  trust: 'earned' | 'not_earned' | 'building';
}

/** Track record for the category of the current change (layers × AI-assisted), from git history. */
export function trackFor(ctx: Ctx): TrackLine | null {
  if (!ctx.baseBranch) return null;
  const layers = (['backend', 'frontend'] as const).filter((l) => ctx.files.some((f) => ctx.rules.layers[l].some((g) => path.matchesGlob(f, g))));
  const range = ctx.diffBase ? `${ctx.diffBase}..HEAD` : 'HEAD';
  const bodies = ctx.git.tryGit(['log', range, '--format=%an%n%b']) ?? '';
  const ai = /^co-authored-by:.*\b(claude|anthropic|copilot|gpt|openai|codex|cursor|devin|gemini|bot)\b/im.test(bodies);
  const category = categoryOf(layers, ai);
  const all = buildTasks(ctx.root, ctx.git, ctx.rules, ctx.baseBranch).tasks;
  const adopted = adoptionDate(ctx.git, ctx.baseBranch);
  const since = adopted ? all.filter((t) => t.last >= adopted) : [];
  const tasks = since.length ? since : all; // judge the current process when there is history for it
  const b = bucketize(tasks, ctx.rules, (t) => categoryOf(t.layers, t.aiAssisted)).find((x) => x.category === category);
  if (!b || !b.settled) return { category, text: 'no settled tasks in this category yet: trust is still building', trust: 'building' };
  const lb = b.lowerBound === null ? '–' : `${Math.round(b.lowerBound * 100)}%`;
  const more = b.needed !== null ? ` (needs ${b.needed} more successes in a row)` : '';
  const verdict = b.trust === 'earned' ? 'trust earned' : b.trust === 'building' ? `good record, too few tasks to prove it yet${more}` : `trust not earned${more}: give this change a full human review`;
  return { category, text: `${b.success}/${b.settled} succeeded (${Math.round((b.rate ?? 0) * 100)}%, 95% lower bound ${lb}), ${b.reverted} reverted, ${b.followUp} needed a follow-up fix → ${verdict}`, trust: b.trust };
}

export type Status = 'red' | 'yellow' | 'green';
export const STATUS_LABEL: Record<Status, string> = { red: '🔴 Not ready', yellow: '🟡 Ready with notes', green: '🟢 Ready' };

export interface AcCoverage {
  index: number;
  text: string;
  tests: { file: string; line: number; title: string; failing: boolean }[];
}

/** Map each acceptance criterion to tests titled "AC<n>..." and whether any of them fail. */
export function acCoverage(ctx: Ctx, review: StageRecord | null): AcCoverage[] {
  const card = ctx.card?.card;
  if (!card) return [];
  const failures = (review?.results.find((r) => r.id === 'all_tests')?.data?.runs as { failures: string[] }[] | undefined)?.flatMap((r) => r.failures) ?? [];
  const tests: { file: string; line: number; title: string }[] = [];
  for (const f of ctx.git.allFiles().filter(isTestFile)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(ctx.root, f), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((l, i) => {
      const m = /\b(?:test|it)\(\s*['"`](AC\d+\b[^'"`]*)['"`]/.exec(l);
      if (m) tests.push({ file: f, line: i + 1, title: m[1] });
    });
  }
  return card.acceptance_criteria.map((text, i) => {
    const mine = tests.filter((t) => new RegExp(`^AC${i + 1}\\b`).test(t.title));
    return { index: i + 1, text, tests: mine.map((t) => ({ ...t, failing: failures.some((f) => f.includes(t.title.slice(0, 50))) })) };
  });
}

export interface Assessment {
  status: Status;
  why: string[];
  bypassed: { bypass: Bypass; result: CheckResult }[];
  openFindings: Finding[];
  unanswered: { id: string; question: string; owner_role: string; why_not_ai: string }[];
  notRun: CheckResult[];
}

export function assess(ctx: Ctx, results: CheckResult[], bypasses: Bypass[], coverage: AcCoverage[]): Assessment {
  const why: string[] = [];
  const tree = ctx.git.headTree();
  const activeBypass = (id: string) => bypasses.find((b) => b.check === id && b.tree === tree);
  const bypassed: Assessment['bypassed'] = [];
  for (const r of results) {
    const b = r.status === 'fail' ? activeBypass(r.id) : undefined;
    if (b) bypassed.push({ bypass: b, result: r });
  }
  const openFindings = results.flatMap((r) => r.findings);
  const unanswered = (ctx.card?.card?.open_decisions ?? []).filter((d) => !isAnswered(d.answer));
  const notRun = results.filter((r) => r.status === 'not_run');

  let red = false;
  const highs = openFindings.filter((f) => f.severity === 'high');
  if (highs.length) {
    red = true;
    why.push(`${highs.length} open high-severity finding(s)`);
  }
  if (unanswered.length) {
    red = true;
    why.push(`${unanswered.length} unanswered decision(s): ${unanswered.map((d) => `${d.id} (${d.owner_role})`).join(', ')}`);
  }
  if (results.some((r) => ['all_tests', 'related_tests', 'e2e'].includes(r.id) && r.status === 'fail')) {
    red = true;
    why.push('failing tests');
  }
  if (results.some((r) => r.id === 'pinned_env' && r.status === 'fail')) {
    red = true;
    why.push('runtime does not match the pinned environment');
  }
  if (results.some((r) => r.status === 'fail') && !highs.length && !why.length) {
    red = true;
    why.push(`failing: ${results.filter((r) => r.status === 'fail').map((r) => r.title).join(', ')}`);
  }
  if (!ctx.card) {
    red = true;
    why.push('no requirement card: nothing to check the change against');
  } else if (!ctx.card.card) {
    red = true;
    why.push(`requirement card ${ctx.card.id} is invalid`);
  }
  if (red) return { status: 'red', why, bypassed, openFindings, unanswered, notRun };

  const notes: string[] = [];
  const meds = openFindings.filter((f) => f.severity !== 'high');
  if (meds.length) notes.push(`${meds.length} low/medium finding(s)`);
  if (notRun.length) notes.push(`not run: ${notRun.map((r) => r.title).join(', ')}`);
  if (results.some((r) => r.status === 'warn')) notes.push(`warnings: ${results.filter((r) => r.status === 'warn').map((r) => r.title).join(', ')}`);
  const impact = results.find((r) => r.id === 'impact');
  if (!impact || impact.status === 'not_run' || impact.data?.known === false) notes.push('impact unknown');
  const uncovered = coverage.filter((c) => !c.tests.length);
  if (uncovered.length) notes.push(`acceptance criteria without a test: ${uncovered.map((c) => `AC${c.index}`).join(', ')}`);
  if (notes.length) return { status: 'yellow', why: notes, bypassed, openFindings, unanswered, notRun };
  return { status: 'green', why: ['all checks passed, impact known, no open decisions'], bypassed, openFindings, unanswered, notRun };
}

const ICON: Record<string, string> = { pass: '✅ pass', fail: '❌ fail', warn: '⚠️ warning', not_run: '⏸ not run' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReport(input: {
  ctx: Ctx;
  review: StageRecord;
  commitHook: { ran: boolean; note: string };
  coverage: AcCoverage[];
  a: Assessment;
  fixed: Finding[];
  track?: TrackLine | null;
}): string {
  const { ctx, review, commitHook, coverage, a, fixed, track } = input;
  const card = ctx.card?.card;
  const results = review.results;
  const L: string[] = [];
  const id = ctx.card?.id ?? '(no card)';
  const bypassNote = a.bypassed.length ? ` · bypassed by ${[...new Set(a.bypassed.map((b) => b.bypass.by))].join(', ')}` : '';
  L.push(`# Readiness report: ${id}${card ? ` · ${card.title}` : ''}`);
  L.push('');
  L.push(`Branch \`${review.branch}\` at \`${(review.head ?? '').slice(0, 10)}\` vs \`${ctx.baseBranch ?? 'HEAD'}\` · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · local only`);
  L.push('');
  L.push(`## 1. Status: ${STATUS_LABEL[a.status]}${bypassNote}`);
  L.push('');
  L.push(a.why.join('; ') + '.');
  for (const b of a.bypassed) L.push(`\n> **Bypassed:** \`${b.result.id}\` (${b.result.summary}). Reason from ${b.bypass.by}: "${b.bypass.reason}"`);
  if (track) L.push(`\n**Track record** for *${track.category}* changes in this repo: ${track.text}.`);
  L.push('');

  L.push('## 2. What changed');
  L.push('');
  const layers = (['backend', 'frontend'] as const).filter((l) => ctx.files.some((f) => ctx.rules.layers[l].some((g) => path.matchesGlob(f, g))));
  L.push(`${card?.title ?? 'Unknown task'}: ${review.files.length} file(s) changed${layers.length ? ` (${layers.join(' + ')})` : ''}.`);
  L.push('');

  L.push('## 3. Requirement match');
  L.push('');
  if (!coverage.length) L.push('_Not run: no valid requirement card._');
  else {
    L.push('| Acceptance criterion | Covered by | Result |');
    L.push('|---|---|---|');
    for (const c of coverage) {
      const tests = c.tests.map((t) => `\`${t.file}:${t.line}\``).join(', ') || '**no test**';
      const res = !c.tests.length ? '⚠️ not covered' : c.tests.some((t) => t.failing) ? '❌ failing' : '✅ passing';
      L.push(`| AC${c.index}: ${cell(c.text)} | ${tests} | ${res} |`);
    }
  }
  L.push('');

  const impact = results.find((r) => r.id === 'impact');
  const imp = impact && impact.status !== 'not_run' && impact.data ? (impact.data as Record<string, unknown>) : null;
  L.push('## 4. Before → after');
  L.push('');
  L.push(imp ? `**Before:** ${imp.before}\n\n**After:** ${imp.after}` : '_Not run: needs the AI impact report (M3)._');
  L.push('');

  L.push('## 5. Impact');
  L.push('');
  if (imp && imp.known !== false) {
    L.push(`- **Area:** ${imp.area}`);
    L.push(`- **Who depends on it:** ${imp.depends_on}`);
    L.push(`- **What could break:** ${imp.could_break}`);
    L.push(`- **Watch after merge:** ${imp.watch_after_merge}`);
  } else {
    L.push('**Impact unknown.**' + (card ? ` Expected blast radius from the card: ${card.expected_blast_radius}. Risk tier: ${card.risk_tier}.` : ''));
  }
  L.push('');

  L.push('## 6. Checks run');
  L.push('');
  L.push('| Check | Result | Details |');
  L.push('|---|---|---|');
  L.push(`| commit hook (\`preguard check\`) | ${commitHook.ran ? ICON.pass : ICON.not_run} | ${cell(commitHook.note)} |`);
  for (const r of results) {
    const by = a.bypassed.find((b) => b.result.id === r.id);
    L.push(`| ${r.title} | ${by ? '❌ fail · bypassed' : ICON[r.status]} | ${cell(r.summary)} |`);
  }
  L.push('');
  L.push(`Total ${(review.ms / 1000).toFixed(1)} s (budget ${review.budget_ms / 60000} min).`);
  L.push('');

  L.push('## 7. Findings');
  L.push('');
  if (!a.openFindings.length && !fixed.length) L.push('None.');
  else {
    L.push('| | ID | Severity | Where | Reason | Evidence |');
    L.push('|---|---|---|---|---|---|');
    for (const f of a.openFindings) L.push(`| open | ${f.id} | ${f.severity} | \`${f.file}:${f.line}\` | ${cell(f.reason)} | ${cell(f.evidence)} |`);
    for (const f of fixed) L.push(`| fixed | ${f.id} | ${f.severity} | \`${f.file}:${f.line}\` | ${cell(f.reason)} | ${cell(f.evidence)} |`);
  }
  L.push('');

  L.push('## 8. Open decisions');
  L.push('');
  if (!card) L.push('_Not run: no valid requirement card._');
  else if (!card.open_decisions.length) L.push('None recorded.');
  else
    for (const d of card.open_decisions) {
      L.push(`- **${d.id}** ${isAnswered(d.answer) ? '✅ answered' : '❗ unanswered'}: ${d.question} _(owner: ${d.owner_role}; not the AI's call: ${d.why_not_ai})_${isAnswered(d.answer) ? `\n  - Answer: ${d.answer}` : ''}`);
    }
  L.push('');

  L.push('## 9. Not verified');
  L.push('');
  const nv = [
    ...a.notRun.map((r) => `${r.title}: ${r.summary}`),
    'Same-name signature changes inside JS exports (only added/removed names are compared)',
    'Screenshots are static renders: content drawn by scripts or the API is not shown',
    'Tests prove the change works, not that it is the right design',
  ];
  for (const n of nv) L.push(`- ${n}`);
  L.push('');

  L.push('## 10. Environment');
  L.push('');
  const env = (results.find((r) => r.id === 'pinned_env')?.data?.env as { runtime: string; pinned: string; source: string; used: string | null; match: boolean | null }[] | undefined) ?? [];
  if (!env.length) L.push('_No runtime pin found._');
  for (const e of env) L.push(`- ${e.runtime}: pinned \`${e.pinned}\` (${e.source}), used \`${e.used ?? 'none'}\` ${e.match ? '✅' : '❌ mismatch'}`);
  L.push('');
  L.push('---');
  L.push('_Generated by Pre-PR Guard. It flags and reports; humans decide. Nothing was approved, signed, merged or pushed._');
  return L.join('\n') + '\n';
}
