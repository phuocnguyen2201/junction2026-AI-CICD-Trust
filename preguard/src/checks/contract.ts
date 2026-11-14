import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, type Check, type Ctx } from '../lib/context.ts';
import { isAnswered } from '../lib/card.ts';
import { surfaceOf } from './api.ts';
import type { Finding } from '../lib/types.ts';

// Back-end additions (§8.2): API contract vs. previous version, routes in code vs. contract,
// migrations (always a human decision). Cross-layer: removed/changed endpoints break the old front-end.

const ROUTE_RE = /method:\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"][\s\S]{0,120}?path:\s*['"]([^'"]+)['"]/g;

function contractFiles(ctx: Ctx): string[] {
  return ctx.git.allFiles().filter((f) => f.endsWith('.json') && matchesAny(f, ctx.rules.public_api) && path.basename(f) !== 'package.json');
}

function codeRoutes(ctx: Ctx): { route: string; file: string; line: number }[] {
  const out: { route: string; file: string; line: number }[] = [];
  const backend = ctx.rules.layers.backend;
  for (const f of ctx.git.allFiles()) {
    if (!/\.(m?js|ts)$/.test(f) || (backend.length && !matchesAny(f, backend)) || /test/.test(f)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(ctx.root, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ROUTE_RE)) out.push({ route: `${m[1]} ${m[2]}`, file: f, line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

function decisionFor(ctx: Ctx, trigger: string): { answered: boolean; ids: string[] } | null {
  const ds = ctx.card?.card?.open_decisions.filter((d) => d.trigger === trigger) ?? [];
  if (!ds.length) return null;
  return { answered: ds.every((d) => isAnswered(d.answer)), ids: ds.map((d) => d.id) };
}

export const apiContractCheck: Check = (ctx) => {
  const base = { id: 'api_contract', title: 'API contract' };
  const files = contractFiles(ctx);
  if (!files.length) return { ...base, status: 'not_run', summary: 'no JSON API contract in public_api', details: [], findings: [] };
  const findings: Finding[] = [];
  const details: string[] = [];

  const declared = new Set<string>();
  for (const f of files) {
    const now = fs.existsSync(path.join(ctx.root, f)) ? fs.readFileSync(path.join(ctx.root, f), 'utf8') : null;
    const before = ctx.git.showFile(ctx.diffBase ?? 'HEAD', f);
    const a = surfaceOf(f, before);
    const b = surfaceOf(f, now);
    b.forEach((x) => declared.add(x));
    const removed = [...a].filter((x) => !b.has(x));
    for (const r of removed) {
      details.push(`- ${r} removed from ${f}: clients built against the previous version break`);
      findings.push({ id: `CONTRACT-${findings.length + 1}`, category: 'data_or_wire_format', severity: 'high', confidence: 1, file: f, line: 1, reason: 'Endpoint removed or changed: the deployed front-end and other clients still call it', evidence: `${r} is in ${f} on ${ctx.baseBranch ?? 'base'} but not on this branch`, origin: 'check' });
    }
  }
  // Every route in code must be in the contract.
  for (const r of codeRoutes(ctx)) {
    if (!declared.has(r.route)) {
      details.push(`${r.route} in ${r.file}:${r.line} is not declared in the contract`);
      findings.push({ id: `CONTRACT-${findings.length + 1}`, category: 'public_api_change', severity: 'high', confidence: 0.95, file: r.file, line: r.line, reason: 'Route served by the back-end but missing from the API contract', evidence: `${r.route} not in ${files.join(', ')}`, origin: 'check' });
    }
  }
  if (findings.length) {
    const d = decisionFor(ctx, 'public_api_change');
    const breaking = findings.some((f) => f.category === 'data_or_wire_format');
    if (breaking && d?.answered) {
      return { ...base, status: 'warn', summary: `breaking contract change, approved in ${d.ids.join(', ')}`, details, findings: findings.map((f) => ({ ...f, severity: 'medium' as const })) };
    }
    return { ...base, status: 'fail', summary: `${findings.length} contract problem(s)`, details, fix: 'declare every route in the contract; keep removed endpoints until old clients are gone (or record an owner decision)', findings };
  }
  return { ...base, status: 'pass', summary: `${declared.size} endpoint(s): code and contract agree, nothing removed`, details: [], findings };
};

export const migrationCheck: Check = (ctx) => {
  const base = { id: 'migrations', title: 'migrations' };
  const migs = ctx.files.filter((f) => /(^|\/)(migrations?|migrate)\//.test(f) || /\.sql$/.test(f));
  if (!migs.length) return { ...base, status: 'pass', summary: 'no migrations changed', details: [], findings: [] };
  const d = decisionFor(ctx, 'migration');
  if (d?.answered) return { ...base, status: 'pass', summary: `migration approved in ${d.ids.join(', ')}`, details: migs, findings: [] };
  return {
    ...base,
    status: 'fail',
    summary: `${migs.length} migration file(s) need a human decision`,
    details: migs,
    fix: 'add a decision with "trigger": "migration" to the card; the data owner answers it',
    findings: migs.map((f, i) => ({ id: `MIG-${i + 1}`, category: 'data_or_wire_format', severity: 'high' as const, confidence: 1, file: f, line: 1, reason: 'Data migration: hard to undo, always a human decision', evidence: `${f} changed, no answered "migration" decision on the card`, origin: 'check' as const })),
  };
};
