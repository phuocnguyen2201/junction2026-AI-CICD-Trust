import path from 'node:path';
import fs from 'node:fs';
import type { Git } from './git.ts';
import type { Rules } from './rules.ts';
import { isTestFile } from './imports.ts';

// Track record from the repo's own git history: what happened to each task after it landed.
// A task = commits on the base branch whose subject carries the same task id (e.g. "DEMO-101: …").
//   reverted       a later `Revert "…"` commit names one of its commits
//   follow-up fix  a later fix/hotfix/bug commit from ANOTHER task (or untagged) touches its files within the window
//   success        settled (window passed) with neither of the above
//   too recent     the window has not passed yet, so it is not counted either way

export interface Commit {
  sha: string;
  date: Date;
  author: string;
  subject: string;
  body: string;
  files: string[];
}

export interface Task {
  id: string;
  title: string;
  /** Author of the task's first commit (the PR author). */
  author: string;
  commits: Commit[];
  files: string[];
  layers: ('backend' | 'frontend')[];
  aiAssisted: boolean;
  risk: string;
  first: Date;
  last: Date;
  outcome: 'success' | 'reverted' | 'follow_up_fix' | 'too_recent';
  evidence: string[];
  /** Readiness verdict recorded in a `Preguard-Status:` commit trailer (green|yellow|red, optionally "bypassed"). */
  preguard: { status: 'green' | 'yellow' | 'red'; bypassed: boolean } | null;
}

const PG_TRAILER = /^preguard-status:\s*(green|yellow|red)\b(.*)$/im;

/** When the team started using Pre-PR Guard: the commit that first added the rule pack. */
export function adoptionDate(git: Git, ref: string): Date | null {
  const out = git.tryGit(['log', ref, '--diff-filter=A', '--format=%aI', '--', '.preguard/rules.yml'])?.trim().split('\n').filter(Boolean);
  return out?.length ? new Date(out[out.length - 1]) : null;
}

export interface Bucket {
  category: string;
  tasks: number;
  settled: number;
  success: number;
  reverted: number;
  followUp: number;
  rate: number | null;
  lowerBound: number | null;
  trust: 'earned' | 'not_earned' | 'building';
  /** Further successes in a row needed to earn trust (null if already earned or out of reach). */
  needed: number | null;
}

/** Smallest k so that (success + k) / (n + k) has a 95% lower bound ≥ bound. */
export function successesNeeded(success: number, n: number, bound: number, minTasks: number): number | null {
  for (let k = 0; k <= 200; k++) {
    if (n + k >= minTasks && (wilsonLower(success + k, n + k) ?? 0) >= bound) return k;
  }
  return null;
}

const AI_TRAILER = /^co-authored-by:.*\b(claude|anthropic|copilot|gpt|openai|codex|cursor|devin|gemini|ai assistant|bot)\b/im;
const AI_AUTHOR = /\[bot\]|\bbot\b|claude|copilot|devin/i;
const FIX = /\b(fix(es|ed)?|hotfix|bug|regression|broke|broken)\b/i;

export function readCommits(git: Git, ref: string, sinceDays: number): Commit[] {
  const out = git.tryGit(['log', ref, '--no-merges', `--since=${sinceDays}.days.ago`, '--name-only', '--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1f']) ?? '';
  const commits: Commit[] = [];
  for (const rec of out.split('\x1e').slice(1)) {
    const [sha, date, author, subject, body, rest] = rec.split('\x1f');
    commits.push({ sha, date: new Date(date), author, subject, body: body ?? '', files: (rest ?? '').split('\n').map((s) => s.trim()).filter(Boolean) });
  }
  return commits.reverse(); // oldest first
}

/** Wilson score interval lower bound (95%): how high the success rate is, at least, given the sample size. */
export function wilsonLower(success: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const p = success / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

function riskOf(root: string, id: string, files: string[], rules: Rules): string {
  try {
    const card = JSON.parse(fs.readFileSync(path.join(root, 'requirements', `${id}.json`), 'utf8'));
    if (typeof card.risk_tier === 'string') return card.risk_tier;
  } catch {}
  const cp = [...rules.critical_paths.backend, ...rules.critical_paths.frontend];
  return files.some((f) => cp.some((g) => path.matchesGlob(f, g))) ? 'high' : 'untiered';
}

export function buildTasks(root: string, git: Git, rules: Rules, ref: string, now = new Date()): { tasks: Task[]; untagged: number; scanned: number } {
  const t = rules.trust;
  const idRe = new RegExp(t.task_pattern);
  const commits = readCommits(git, ref, t.history_days);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const reverts = commits.filter((c) => /^Revert "/.test(c.subject));
  const revertedShas = new Map<string, Commit>();
  for (const r of reverts) for (const m of r.body.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
    const target = [...bySha.keys()].find((s) => s.startsWith(m[1]));
    if (target) revertedShas.set(target, r);
  }
  const groups = new Map<string, Commit[]>();
  let untagged = 0;
  for (const c of commits) {
    if (reverts.includes(c)) continue;
    const id = idRe.exec(c.subject)?.[1] ?? idRe.exec(c.subject)?.[0];
    if (!id) {
      untagged++;
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), c]);
  }
  const windowMs = t.window_days * 86_400_000;
  const tasks: Task[] = [];
  for (const [id, cs] of groups) {
    const files = [...new Set(cs.flatMap((c) => c.files))].filter((f) => !f.startsWith('requirements/') && !f.startsWith('.preguard/'));
    const code = files.filter((f) => !isTestFile(f));
    const first = cs[0].date;
    const last = cs[cs.length - 1].date;
    const evidence: string[] = [];
    let outcome: Task['outcome'] = 'success';
    const rev = cs.map((c) => revertedShas.get(c.sha)).find(Boolean);
    if (rev) {
      outcome = 'reverted';
      evidence.push(`${rev.sha.slice(0, 8)} ${rev.subject}`);
    } else {
      const fix = commits.find(
        (c) => c.date > last && c.date.getTime() - last.getTime() <= windowMs && !cs.includes(c) && !reverts.includes(c) && FIX.test(c.subject) && idRe.exec(c.subject)?.[0] !== id && c.files.some((f) => code.includes(f)),
      );
      if (fix) {
        outcome = 'follow_up_fix';
        evidence.push(`${fix.sha.slice(0, 8)} ${fix.subject} (touches ${fix.files.filter((f) => code.includes(f)).join(', ')})`);
      } else if (now.getTime() - last.getTime() < windowMs) {
        outcome = 'too_recent';
      }
    }
    const layers = (['backend', 'frontend'] as const).filter((l) => files.some((f) => rules.layers[l].some((g) => path.matchesGlob(f, g))));
    tasks.push({
      id,
      title: cs[0].subject.replace(idRe, '').replace(/^[:\s-]+/, ''),
      author: cs[0].author,
      commits: cs,
      files,
      layers,
      aiAssisted: cs.some((c) => AI_TRAILER.test(c.body) || AI_AUTHOR.test(c.author)),
      risk: riskOf(root, id, files, rules),
      first,
      last,
      outcome,
      evidence,
      preguard: (() => {
        const m = [...cs].reverse().map((c) => PG_TRAILER.exec(c.body)).find(Boolean);
        return m ? { status: m[1].toLowerCase() as 'green' | 'yellow' | 'red', bypassed: /bypass/i.test(m[2]) } : null;
      })(),
    });
  }
  return { tasks, untagged, scanned: commits.length };
}

export function categoryOf(layers: string[], aiAssisted: boolean): string {
  const layer = layers.length === 2 ? 'cross-layer' : layers[0] ?? 'other';
  return `${layer} · ${aiAssisted ? 'AI-assisted' : 'human'}`;
}

export function bucketize(tasks: Task[], rules: Rules, keyOf: (t: Task) => string): Bucket[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) map.set(keyOf(t), [...(map.get(keyOf(t)) ?? []), t]);
  return [...map.entries()]
    .map(([category, ts]) => {
      const settled = ts.filter((t) => t.outcome !== 'too_recent');
      const success = settled.filter((t) => t.outcome === 'success').length;
      const lb = wilsonLower(success, settled.length);
      const t = rules.trust;
      const rate = settled.length ? success / settled.length : 0;
      // earned: enough tasks AND the lower bound clears the bar. building: the record is good but the sample is
      // too small to prove it. not earned: the success rate itself is below the bar.
      const trust: Bucket['trust'] = settled.length >= t.min_tasks && (lb ?? 0) >= t.required_lower_bound ? 'earned' : settled.length && rate < t.required_lower_bound ? 'not_earned' : 'building';
      const needed = trust === 'earned' ? null : successesNeeded(success, settled.length, t.required_lower_bound, t.min_tasks);
      return {
        category,
        tasks: ts.length,
        settled: settled.length,
        success,
        reverted: settled.filter((t) => t.outcome === 'reverted').length,
        followUp: settled.filter((t) => t.outcome === 'follow_up_fix').length,
        rate: settled.length ? success / settled.length : null,
        lowerBound: lb,
        trust,
        needed,
      };
    })
    .sort((a, b) => b.tasks - a.tasks || a.category.localeCompare(b.category));
}
