import fs from 'node:fs';
import path from 'node:path';
import { Git } from './git.ts';
import { loadRules, type Rules } from './rules.ts';
import { loadCard, resolveCardId } from './card.ts';
import type { CheckResult, RequirementCard } from './types.ts';

export type FilesMode = 'staged' | 'branch' | 'all';

export interface Ctx {
  root: string;
  git: Git;
  rules: Rules;
  rulesExists: boolean;
  baseBranch: string | null;
  /** merge-base of HEAD and the base branch (null on a repo with no commits). */
  diffBase: string | null;
  filesMode: FilesMode;
  /** Changed files that exist on disk. */
  files: string[];
  deleted: string[];
  card: { id: string; source: string; card: RequirementCard | null; errors: string[] } | null;
  fix: boolean;
  deadline: number;
  budgetMs: number;
  /** Results of the checks that already ran in this stage (the AI uses them to avoid duplicates). */
  results: CheckResult[];
  /** Impact report produced by the AI review, read by the impact check. */
  aiImpact?: Record<string, unknown> | null;
}

export class UsageError extends Error {}

export function buildContext(opts: { cwd: string; mode?: FilesMode; id?: string; fix?: boolean; budgetMs: (r: Rules) => number }): Ctx {
  const root = Git.findRoot(opts.cwd);
  if (!root) throw new UsageError('not inside a git repository');
  const git = new Git(root);
  const { rules, exists } = loadRules(root);
  const baseBranch = git.head() ? git.baseBranch(rules.base_branch) : null;
  const diffBase = baseBranch ? git.mergeBase(baseBranch) : null;

  let mode: FilesMode = opts.mode ?? 'branch';
  let files: string[];
  let deleted: string[] = [];
  if (!opts.mode && git.head()) {
    const staged = git.stagedFiles();
    if (staged.length) mode = 'staged';
  }
  if (mode === 'all' || !git.head()) {
    files = git.allFiles();
    mode = 'all';
  } else if (mode === 'staged') {
    files = git.stagedFiles();
  } else {
    const ref = diffBase ?? 'HEAD';
    files = git.changedSince(ref);
    deleted = git.deletedSince(ref);
  }
  files = files.filter((f) => fs.existsSync(path.join(root, f)) && !f.startsWith('.preguard/state/'));

  const resolved = resolveCardId(root, git, { explicit: opts.id, diffBase });
  const card = resolved ? { ...resolved, ...loadCard(root, resolved.id) } : null;
  const budgetMs = opts.budgetMs(rules);
  return {
    root,
    git,
    rules,
    rulesExists: exists,
    baseBranch,
    diffBase,
    filesMode: mode,
    files,
    deleted,
    card,
    fix: !!opts.fix,
    deadline: Date.now() + budgetMs,
    budgetMs,
    results: [],
  };
}

export function remainingMs(ctx: Ctx): number {
  return ctx.deadline - Date.now();
}

export type Check = (ctx: Ctx) => Omit<CheckResult, 'ms'> | Promise<Omit<CheckResult, 'ms'>>;

/** Run checks in order; a check that would start after the budget is spent is "not run". */
export async function runChecks(ctx: Ctx, checks: [string, string, Check][]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  ctx.results = results;
  for (const [id, title, fn] of checks) {
    if (remainingMs(ctx) <= 0) {
      results.push({ id, title, status: 'not_run', summary: 'time budget exhausted before this check started', details: [], ms: 0, findings: [] });
      continue;
    }
    const start = Date.now();
    try {
      const r = await fn(ctx);
      results.push({ ...r, ms: Date.now() - start });
    } catch (e) {
      results.push({ id, title, status: 'not_run', summary: `check crashed: ${(e as Error).message}`, details: [], ms: Date.now() - start, findings: [] });
    }
  }
  return results;
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => path.matchesGlob(file, g));
}
