import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { matchesAny, type Check, type Ctx } from '../lib/context.ts';
import { isAnswered } from '../lib/card.ts';
import type { Finding } from '../lib/types.ts';

// A "surface" is the set of public entries of a file. Comparing base vs. now gives
// added / removed entries. Same-name signature changes inside JS are NOT detected
// (stated in the report's "not verified" list).

export function surfaceOf(file: string, text: string | null): Set<string> {
  const s = new Set<string>();
  if (text === null) return s;
  if (file.endsWith('.json')) {
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      s.add(`(unparseable) ${hash(text)}`);
      return s;
    }
    if (path.basename(file) === 'package.json') {
      for (const k of ['name', 'main', 'module', 'types', 'exports', 'bin']) if (j[k] !== undefined) s.add(`${k}=${JSON.stringify(j[k])}`);
      return s;
    }
    const entries = Array.isArray(j) ? j : Array.isArray(j?.endpoints) ? j.endpoints : null;
    if (entries) {
      for (const e of entries) s.add(e && e.method && e.path ? `${String(e.method).toUpperCase()} ${e.path}` : JSON.stringify(e));
      return s;
    }
    if (j?.paths && typeof j.paths === 'object') {
      for (const [p, ops] of Object.entries(j.paths)) for (const m of Object.keys(ops as object)) s.add(`${m.toUpperCase()} ${p}`);
      return s;
    }
    for (const [k, v] of Object.entries(j ?? {})) s.add(`${k}=${JSON.stringify(v)}`);
    return s;
  }
  if (/\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/.test(file)) {
    for (const m of text.matchAll(/^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) s.add(`export ${m[1]}`);
    for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) s.add(`export ${name}`);
      }
    }
    if (/^\s*export\s+default\b/m.test(text)) s.add('export default');
    for (const m of text.matchAll(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) s.add(`export ${m[1]}`);
    return s;
  }
  s.add(`content ${hash(text)}`);
  return s;
}

function hash(t: string): string {
  return createHash('sha256').update(t).digest('hex').slice(0, 12);
}

function lineOf(text: string, entry: string): number {
  const token = entry.includes(' ') ? entry.split(' ').slice(1).join(' ') : entry.split('=')[0];
  const lines = text.split('\n');
  const method = entry.split(' ')[0];
  // Prefer a line that has the token near the method (route tables / contracts).
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(token)) {
      const near = lines.slice(Math.max(0, i - 3), i + 4).join(' ');
      if (!/^[A-Z]+$/.test(method) || near.toUpperCase().includes(method)) return i + 1;
    }
  }
  const any = lines.findIndex((l) => l.includes(token));
  return any >= 0 ? any + 1 : 1;
}

export interface ApiChange {
  file: string;
  added: string[];
  removed: string[];
  line: number;
}

export function detectApiChanges(ctx: Ctx): { changes: ApiChange[]; checked: string[] } {
  const globs = ctx.rules.public_api;
  const candidates = [...ctx.files, ...ctx.deleted].filter((f) => matchesAny(f, globs));
  const changes: ApiChange[] = [];
  for (const f of candidates) {
    const before = ctx.git.showFile(ctx.diffBase ?? 'HEAD', f);
    let now: string | null;
    if (ctx.filesMode === 'staged') now = ctx.git.showFile('', f);
    else now = fs.existsSync(path.join(ctx.root, f)) ? fs.readFileSync(path.join(ctx.root, f), 'utf8') : null;
    const a = surfaceOf(f, before);
    const b = surfaceOf(f, now);
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) changes.push({ file: f, added, removed, line: now && added.length ? lineOf(now, added[0]) : 1 });
  }
  return { changes, checked: candidates };
}

export const publicApiCheck: Check = (ctx) => {
  const base = { id: 'public_api', title: 'public API flag' };
  if (!ctx.rules.public_api.length) return { ...base, status: 'not_run', summary: 'no public_api globs in rules.yml', details: [], findings: [] };
  const { changes, checked } = detectApiChanges(ctx);
  if (!changes.length) {
    return { ...base, status: 'pass', summary: checked.length ? `no public surface change in ${checked.length} API file(s)` : 'no public API files changed', details: [], findings: [], data: { changed: false } };
  }
  const details: string[] = [];
  for (const c of changes) {
    for (const a of c.added) details.push(`+ ${a}  (${c.file})`);
    for (const r of c.removed) details.push(`- ${r}  (${c.file})`);
  }
  const first = changes[0];
  const mkFinding = (reason: string, evidence: string): Finding => ({
    id: 'API-1',
    category: 'public_api_change',
    severity: 'high',
    confidence: 1,
    file: first.file,
    line: first.line,
    reason,
    evidence,
    origin: 'check',
  });
  const surface = details.map((d) => d.split('  (')[0]).join(', ');
  const data = { changed: true, changes };

  if (!ctx.card) {
    return { ...base, status: 'fail', summary: 'public API changed, but no requirement card for this work', details, fix: 'run `preguard start <issue>` and record the API decision for its owner', findings: [mkFinding('Public API change with no requirement card or owner decision', surface)], data };
  }
  if (!ctx.card.card) {
    return { ...base, status: 'fail', summary: `public API changed; card ${ctx.card.id} is invalid`, details: [...details, ...ctx.card.errors.map((e) => `card: ${e}`)], findings: [mkFinding('Public API change; requirement card is invalid', surface)], data };
  }
  const decisions = ctx.card.card.open_decisions.filter((d) => d.trigger === 'public_api_change');
  const unanswered = decisions.filter((d) => !isAnswered(d.answer));
  if (!decisions.length) {
    return {
      ...base,
      status: 'fail',
      summary: `public API changed; card ${ctx.card.id} has no public_api_change decision`,
      details,
      fix: `add an open_decisions entry with "trigger": "public_api_change" to requirements/${ctx.card.id}.json and get it answered by the API owner`,
      findings: [mkFinding('New/changed public API without a recorded human decision (long-term promise)', surface)],
      data,
    };
  }
  if (unanswered.length) {
    return {
      ...base,
      status: 'fail',
      summary: `public API changed; decision ${unanswered.map((d) => d.id).join(', ')} unanswered`,
      details: [...details, ...unanswered.map((d) => `${d.id} → ${d.owner_role}: ${d.question}`)],
      fix: `the named owner (${unanswered.map((d) => d.owner_role).join(', ')}) must answer in requirements/${ctx.card.id}.json`,
      findings: [mkFinding(`Public API change waiting on decision ${unanswered.map((d) => d.id).join(', ')}`, surface)],
      data,
    };
  }
  return { ...base, status: 'pass', summary: `public API changed; decision ${decisions.map((d) => d.id).join(', ')} answered`, details, findings: [], data };
};
