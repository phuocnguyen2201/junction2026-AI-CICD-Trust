import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, type Check, type Ctx } from '../lib/context.ts';
import { callJson } from '../lib/ai.ts';
import { buildImportGraph, isCode } from '../lib/imports.ts';
import type { Schema } from '../lib/schema.ts';
import type { Finding } from '../lib/types.ts';

// §7.3 self-review + §7.4 impact report in ONE call (cheaper, faster), returned as two checks.
// Precision over volume: every AI finding must quote evidence that really exists in the changed file,
// or it is dropped. The AI flags; it never approves or sets readiness.

const CHECKLIST_TEXT: Record<string, string> = {
  silent_failure: 'Code that skips, drops, filters, swallows errors or returns success/defaults instead of failing loudly. Say what could now be hidden.',
  fix_wider_than_issue: 'The change affects more cases or callers than the requirement card asks for.',
  self_confirming_tests: 'Tests that only restate the implementation, or would still pass if the acceptance criteria were broken.',
  missing_test_modes: 'Behaviour that differs by mode/target/environment (env vars, id formats, platforms) without tests in every mode.',
  unsourced_claims: 'Factual statements in code, comments or docs about external libraries, runtimes, APIs or standards that are false or unverifiable. If false, give the official documentation URL that shows it in source_url.',
  env_mismatch: 'Code that needs a newer runtime/API than the pinned environment.',
  scope_drift: 'Changes unrelated to the requirement card.',
  safety_net_dependency: 'Correctness that silently depends on another check, validation or error staying in place.',
};

const FINDING_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'severity', 'confidence', 'file', 'line', 'reason', 'evidence', 'source_url'],
  properties: {
    category: { type: 'string', enum: Object.keys(CHECKLIST_TEXT) },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    file: { type: 'string' },
    line: { type: 'integer', minimum: 1 },
    reason: { type: 'string' },
    evidence: { type: 'string', description: 'One line copied exactly from the numbered file content, without the line-number prefix.' },
    source_url: { type: ['string', 'null'] },
  },
};

const IMPACT_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'before', 'after', 'depends_on', 'could_break', 'watch_after_merge', 'known'],
  properties: {
    area: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    depends_on: { type: 'string' },
    could_break: { type: 'string' },
    watch_after_merge: { type: 'string' },
    known: { type: 'boolean' },
  },
};

export const REVIEW_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'impact'],
  properties: { findings: { type: 'array', items: FINDING_SCHEMA }, impact: IMPACT_SCHEMA },
};

interface AiOut {
  findings: (Omit<Finding, 'id' | 'source_url'> & { source_url: string | null })[];
  impact: Record<string, unknown> & { known: boolean };
}

const SYSTEM = `You are the self-review step of Pre-PR Guard. A developer is about to commit or merge a change. You check it against a requirement card and a fixed checklist, and you describe its impact. You do not approve anything and you do not decide readiness.

Rules:
- Report only real problems you can prove from the material given. If you are not sure, leave it out. Returning zero findings is a good result for a correct change.
- Every finding needs: file (one of the CHANGED FILES), line (line number in that file), evidence (one line copied exactly from the numbered content, without the "123| " prefix), and a reason in one or two plain sentences.
- Do not report formatting, lint, or anything already listed under ALREADY FOUND.
- unsourced_claims: when a code comment or doc states a fact about an external library, runtime or standard, check it. If it is false, report it and put the official documentation URL that shows the truth in source_url. Otherwise source_url is null.
- severity: high = wrong behaviour, crash, data loss, security, or a test gap that hides a bug; medium = likely bug or misleading code/comment; low = minor.
- confidence: your honest probability (0-1) that the finding is real.
- Impact: plain words a reviewer can accept without reading the code. "before" = behaviour on the base branch, "after" = behaviour with this change, including side effects. depends_on = callers and consumers visible in CONSUMERS plus API clients implied by the contract. known = false only when the effect depends on code or consumers you cannot see and cannot reason about from what is given.`;

const SKIP = ['requirements/**', '.preguard/**', '**/package-lock.json', '**/*.lock', '**/pnpm-lock.yaml'];
const MAX_FILE_LINES = 600;
const MAX_TOTAL_CHARS = 120_000;

function numbered(text: string): string {
  return text
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
    .join('\n');
}

function consumers(ctx: Ctx, changed: string[]): string[] {
  const all = ctx.git.allFiles();
  const graph = buildImportGraph(ctx.root, all);
  const out: string[] = [];
  for (const f of changed.filter(isCode)) {
    const users = [...graph.entries()].filter(([, deps]) => deps.includes(f)).map(([u]) => u);
    out.push(`${f} is imported by: ${users.length ? users.join(', ') : '(nothing in this repo)'}`);
  }
  // Front-end callers of API paths (contract consumers inside the repo).
  const fe = all.filter((f) => matchesAny(f, ctx.rules.layers.frontend) && isCode(f));
  for (const f of fe) {
    const text = fs.readFileSync(path.join(ctx.root, f), 'utf8');
    const calls = [...text.matchAll(/fetch\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*method:\s*['"](\w+)['"])?/g)].map((m) => `${(m[2] ?? 'GET').toUpperCase()} ${m[1]}`);
    if (calls.length) out.push(`${f} (front-end) calls: ${[...new Set(calls)].join(', ')}`);
  }
  return out;
}

export function buildPrompt(ctx: Ctx): { user: string; files: string[]; truncated: boolean } {
  const changed = ctx.files.filter((f) => !matchesAny(f, SKIP));
  let budget = MAX_TOTAL_CHARS;
  let truncated = false;
  const parts: string[] = [];
  const card = ctx.card?.card;
  parts.push(`REQUIREMENT CARD:\n${card ? JSON.stringify(card, null, 2) : '(none: judge against the change itself and flag scope only if obvious)'}`);
  parts.push(`CHECKLIST (report only these categories):\n${ctx.rules.checklist.filter((c) => CHECKLIST_TEXT[c]).map((c) => `- ${c}: ${CHECKLIST_TEXT[c]}`).join('\n')}`);
  const already = ctx.results.flatMap((r) => r.findings).map((f) => `- ${f.category} ${f.file}:${f.line} ${f.reason}`);
  parts.push(`ALREADY FOUND by deterministic checks (do not repeat):\n${already.join('\n') || '(none)'}`);
  const modes = ctx.rules.test_modes.map((m) => `${m.name}: ${m.command}`).join('\n');
  parts.push(`TEST MODES:\n${modes || '(none)'}\nPINNED ENV: see .nvmrc / engines in the files if relevant.`);
  parts.push(`CONSUMERS (who uses the changed code inside this repo):\n${consumers(ctx, changed).join('\n') || '(none found)'}`);
  const diff = ctx.git.tryGit(['diff', '-U3', '--no-color', ctx.filesMode === 'staged' ? '--cached' : ctx.diffBase ?? 'HEAD', '--', ...changed]) ?? '';
  const diffPart = diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n…(diff truncated)` : diff;
  if (diff.length > 40_000) truncated = true;
  budget -= diffPart.length;
  parts.push(`DIFF vs ${ctx.filesMode === 'staged' ? 'HEAD (staged)' : ctx.baseBranch ?? 'HEAD'}:\n${diffPart}`);
  const fileParts: string[] = [];
  for (const f of changed) {
    let text: string;
    try {
      text = ctx.filesMode === 'staged' ? ctx.git.showFile('', f) ?? '' : fs.readFileSync(path.join(ctx.root, f), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    let lines = text.split('\n');
    if (lines.length > MAX_FILE_LINES) {
      lines = lines.slice(0, MAX_FILE_LINES);
      truncated = true;
    }
    const block = `=== ${f} ===\n${numbered(lines.join('\n'))}`;
    if (block.length > budget) {
      truncated = true;
      fileParts.push(`=== ${f} === (omitted: size budget)`);
      continue;
    }
    budget -= block.length;
    fileParts.push(block);
  }
  parts.push(`CHANGED FILES (full content after the change, numbered):\n${fileParts.join('\n\n')}`);
  return { user: parts.join('\n\n'), files: changed, truncated };
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Keep only findings whose evidence really exists in the changed file; fix the line number if it drifted. */
export function verifyFindings(ctx: Ctx, raw: AiOut['findings'], files: string[]): { kept: Finding[]; dropped: string[] } {
  const kept: Finding[] = [];
  const dropped: string[] = [];
  const min = ctx.rules.ai.min_confidence;
  for (const f of raw) {
    const label = `${f.category} ${f.file}:${f.line}`;
    if (!files.includes(f.file)) {
      dropped.push(`${label}: file is not part of the change`);
      continue;
    }
    if (f.confidence < min) {
      dropped.push(`${label}: confidence ${f.confidence} < ${min}`);
      continue;
    }
    const ev = norm(f.evidence.replace(/^\s*\d+\|\s?/, ''));
    if (ev.length < 4) {
      dropped.push(`${label}: no usable evidence`);
      continue;
    }
    let text: string;
    try {
      text = ctx.filesMode === 'staged' ? ctx.git.showFile('', f.file) ?? '' : fs.readFileSync(path.join(ctx.root, f.file), 'utf8');
    } catch {
      dropped.push(`${label}: file unreadable`);
      continue;
    }
    const lines = text.split('\n').map(norm);
    const probe = ev.slice(0, 80);
    const candidates = lines.map((l, i) => (l.includes(probe) || (probe.length > 10 && probe.includes(l) && l.length > 10) ? i + 1 : 0)).filter(Boolean);
    if (!candidates.length) {
      dropped.push(`${label}: evidence not found in the file`);
      continue;
    }
    const line = candidates.reduce((best, n) => (Math.abs(n - f.line) < Math.abs(best - f.line) ? n : best), candidates[0]);
    let severity = f.severity;
    let reason = f.reason;
    if (f.category === 'unsourced_claims' && !f.source_url) {
      severity = 'low';
      reason = `${reason} (no source given, so treat as unverified)`;
    }
    if (ctx.results.some((r) => r.findings.some((d) => d.file === f.file && d.line === line && d.category === f.category))) {
      dropped.push(`${label}: duplicate of a deterministic finding`);
      continue;
    }
    kept.push({
      id: `AI-${kept.length + 1}`,
      category: f.category,
      severity,
      confidence: f.confidence,
      file: f.file,
      line,
      reason,
      evidence: f.evidence.replace(/^\s*\d+\|\s?/, '').trim(),
      ...(f.source_url ? { source_url: f.source_url } : {}),
      origin: 'ai',
    });
  }
  return { kept, dropped };
}

export const aiReviewCheck: Check = async (ctx) => {
  const base = { id: 'ai_review', title: 'AI self-review' };
  ctx.aiImpact = null;
  const { user, files, truncated } = buildPrompt(ctx);
  if (!files.length) return { ...base, status: 'pass', summary: 'no reviewable files changed', details: [], findings: [] };
  const r = await callJson<AiOut>(ctx.root, ctx.rules, { name: 'preguard_review', system: SYSTEM, user, schema: REVIEW_SCHEMA }, ctx.rules.ai.timeout_seconds * 1000);
  if (!r.ok || !r.value) return { ...base, status: 'not_run', summary: r.reason ?? 'AI step failed', details: [], findings: [], data: { usage: r.usage } };
  ctx.aiImpact = { ...r.value.impact, truncated };
  const { kept, dropped } = verifyFindings(ctx, r.value.findings, files);
  const meta = `${ctx.rules.ai.model}, ${(r.ms / 1000).toFixed(0)} s, ${r.usage?.input_tokens ?? '?'}→${r.usage?.output_tokens ?? '?'} tokens${dropped.length ? `, ${dropped.length} unproven finding(s) dropped` : ''}`;
  const data = { usage: r.usage, model: r.model, dropped, truncated };
  const details = [...kept.map((f) => `${f.file}:${f.line}  [${f.severity}] ${f.reason}${f.source_url ? `  (source: ${f.source_url})` : ''}`), ...dropped.map((d) => `dropped: ${d}`)];
  if (!kept.length) return { ...base, status: 'pass', summary: `no findings (${meta})`, details, findings: [], data };
  const high = kept.some((f) => f.severity === 'high');
  return { ...base, status: high ? 'fail' : 'warn', summary: `${kept.length} finding(s): ${[...new Set(kept.map((f) => f.category))].join(', ')} (${meta})`, details, fix: 'fix the code/comment, or explain in the card why the finding is wrong', findings: kept, data };
};

export const aiImpactCheck: Check = (ctx) => {
  const base = { id: 'impact', title: 'impact report' };
  const imp = ctx.aiImpact;
  const ai = ctx.results.find((r) => r.id === 'ai_review');
  if (!imp) return { ...base, status: 'not_run', summary: `impact unknown: ${ai?.status === 'not_run' ? ai.summary : 'AI review did not produce one'}`, details: [], findings: [] };
  if (!imp.known) return { ...base, status: 'warn', summary: 'impact unknown (the AI could not see all consumers)', details: [String(imp.area), String(imp.depends_on)], findings: [], data: imp };
  return { ...base, status: 'pass', summary: String(imp.area).slice(0, 120), details: [`before: ${imp.before}`, `after: ${imp.after}`, `could break: ${imp.could_break}`], findings: [], data: imp };
};
