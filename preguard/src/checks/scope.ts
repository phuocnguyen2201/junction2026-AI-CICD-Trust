import { matchesAny, type Check } from '../lib/context.ts';
import type { Finding } from '../lib/types.ts';

// Changed files vs. the requirement card's scope.paths. Files under requirements/ and
// .preguard/ are always in scope (they describe the work, they aren't the work).
const ALWAYS_IN = ['requirements/**', '.preguard/**'];

export const scopeCheck: Check = (ctx) => {
  const base = { id: 'scope', title: 'scope vs card' };
  if (!ctx.card) return { ...base, status: 'not_run', summary: 'no requirement card for this branch', details: [], findings: [] };
  if (!ctx.card.card) return { ...base, status: 'not_run', summary: `card ${ctx.card.id} is invalid: ${ctx.card.errors[0]}`, details: [], findings: [] };
  const paths = ctx.card.card.scope.paths;
  if (!paths?.in?.length) return { ...base, status: 'not_run', summary: `card ${ctx.card.id} has no scope.paths to compare against`, details: [], findings: [] };

  const changed = [...ctx.files, ...ctx.deleted].filter((f) => !matchesAny(f, ALWAYS_IN));
  const findings: Finding[] = [];
  const details: string[] = [];
  for (const f of changed) {
    if (paths.out && matchesAny(f, paths.out)) {
      details.push(`${f}: card marks this out of scope`);
      const why = ctx.card.card.scope.out.join('; ');
      findings.push({ id: `SCOPE-${findings.length + 1}`, category: 'scope_drift', severity: 'high', confidence: 1, file: f, line: 1, reason: 'Changed a file the requirement card puts out of scope; the fix may be wider than the issue', evidence: `scope.paths.out matches ${f} (out of scope: ${why})`, origin: 'check' });
    } else if (!matchesAny(f, paths.in)) {
      details.push(`${f}: not in the card's scope`);
      findings.push({ id: `SCOPE-${findings.length + 1}`, category: 'scope_drift', severity: 'medium', confidence: 0.9, file: f, line: 1, reason: 'Changed a file outside the requirement card’s scope', evidence: `${f} matches none of scope.paths.in [${paths.in.join(', ')}]`, origin: 'check' });
    }
  }
  if (!findings.length) return { ...base, status: 'pass', summary: `${changed.length} changed file(s), all inside ${ctx.card.id}'s scope`, details: [], findings };
  const high = findings.some((f) => f.severity === 'high');
  return {
    ...base,
    status: high ? 'fail' : 'warn',
    summary: `${findings.length} file(s) outside ${ctx.card.id}'s scope`,
    details,
    fix: 'revert the unrelated change, or extend the card’s scope (and say why in the card)',
    findings,
  };
};
