import fs from 'node:fs';
import path from 'node:path';
import type { Git } from './git.ts';
import type { RequirementCard } from './types.ts';

export const CARD_DIR = 'requirements';
const WHY = ['long_term_promise', 'affects_all_users_or_data', 'policy', 'owner_intent'];

export function cardPath(root: string, id: string): string {
  return path.join(root, CARD_DIR, `${id}.json`);
}

export function listCardIds(root: string): string[] {
  const dir = path.join(root, CARD_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

/**
 * Which card belongs to this work? In order: --id, a card id that appears in the branch name,
 * the only card changed on this branch, the local `.preguard/current` pointer set by `start`.
 */
export function resolveCardId(root: string, git: Git, opts: { explicit?: string; diffBase?: string | null }): { id: string; source: string } | null {
  if (opts.explicit) return { id: opts.explicit, source: '--id' };
  const ids = listCardIds(root);
  const branch = git.branch().toLowerCase();
  const inBranch = ids.filter((id) => branch.includes(id.toLowerCase()));
  if (inBranch.length === 1) return { id: inBranch[0], source: `branch name "${git.branch()}"` };
  if (opts.diffBase) {
    const changed = git.changedSince(opts.diffBase).filter((f) => f.startsWith(`${CARD_DIR}/`) && f.endsWith('.json'));
    if (changed.length === 1) return { id: path.basename(changed[0], '.json'), source: 'only card changed on this branch' };
  }
  const cur = path.join(root, '.preguard/state/current');
  if (fs.existsSync(cur)) {
    const id = fs.readFileSync(cur, 'utf8').trim();
    if (id) return { id, source: '.preguard/state/current (set by preguard start)' };
  }
  return null;
}

export function validateCard(c: any): string[] {
  const errs: string[] = [];
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!c || typeof c !== 'object') return ['card is not a JSON object'];
  if (!str(c.id)) errs.push('id must be a non-empty string');
  if (!str(c.title)) errs.push('title must be a non-empty string');
  if (!strArr(c.acceptance_criteria) || !c.acceptance_criteria.length) errs.push('acceptance_criteria must be a non-empty list of strings');
  if (!c.scope || !strArr(c.scope.in) || !strArr(c.scope.out)) errs.push('scope.in and scope.out must be lists of strings');
  if (c.scope?.paths !== undefined && (!strArr(c.scope.paths.in) || (c.scope.paths.out !== undefined && !strArr(c.scope.paths.out)))) errs.push('scope.paths.in/out must be lists of globs');
  if (!strArr(c.layers) || c.layers.some((l: string) => l !== 'backend' && l !== 'frontend')) errs.push('layers must be a list of "backend"/"frontend"');
  if (!['low', 'medium', 'high'].includes(c.risk_tier)) errs.push('risk_tier must be low|medium|high');
  if (typeof c.expected_blast_radius !== 'string') errs.push('expected_blast_radius must be a string');
  if (!c.in_reach || !['do', 'do_with_checkpoint', 'refuse'].includes(c.in_reach.result) || !strArr(c.in_reach.signals_failed)) errs.push('in_reach must have result do|do_with_checkpoint|refuse and signals_failed[]');
  if (!Array.isArray(c.open_decisions)) errs.push('open_decisions must be a list');
  else
    c.open_decisions.forEach((d: any, i: number) => {
      if (!d || !str(d.id) || !str(d.question) || !str(d.owner_role)) errs.push(`open_decisions[${i}] needs id, question, owner_role`);
      else if (!WHY.includes(d.why_not_ai)) errs.push(`open_decisions[${i}].why_not_ai must be one of ${WHY.join('|')}`);
      else if (d.answer !== null && typeof d.answer !== 'string') errs.push(`open_decisions[${i}].answer must be a string or null`);
    });
  return errs;
}

export function loadCard(root: string, id: string): { card: RequirementCard | null; path: string; errors: string[] } {
  const p = cardPath(root, id);
  if (!fs.existsSync(p)) return { card: null, path: p, errors: [`${path.relative(root, p)} not found`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { card: null, path: p, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const errors = validateCard(parsed);
  return { card: errors.length ? null : (parsed as RequirementCard), path: p, errors };
}

export function isAnswered(answer: string | null | undefined): boolean {
  return typeof answer === 'string' && answer.trim().length > 0;
}
