import fs from 'node:fs';
import path from 'node:path';
import { matchesAny, type Check } from '../lib/context.ts';
import type { Finding } from '../lib/types.ts';

// Built-in secret scan on *added* lines only (fast, low noise). If the repo uses
// gitleaks/trufflehog in CI, put that command here instead; same rule, same tool.

const PATTERNS: { id: string; re: RegExp; what: string }[] = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, what: 'private key' },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, what: 'AWS access key id' },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/, what: 'GitHub token' },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, what: 'Slack token' },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, what: 'Anthropic API key' },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/, what: 'OpenAI-style API key' },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, what: 'Stripe live key' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, what: 'JWT' },
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{6,}@/i, what: 'credentials in URL' },
];

const ASSIGN = /(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|auth)['"]?\s*[:=]\s*['"]([^'"\s]{16,})['"]/i;
const PLACEHOLDER = /example|changeme|dummy|placeholder|your[_-]|xxx|\*\*\*|<[^>]+>|\$\{|process\.env|test|fake|sample/i;
const SKIP_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$|\.(png|jpe?g|gif|ico|pdf|zip|gz|woff2?|ttf|lock)$/;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function mask(s: string): string {
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…(${s.length} chars)`;
}

export function scanLine(text: string): { id: string; what: string; value: string } | null {
  if (/preguard:allow-secret/.test(text)) return null;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) return { id: p.id, what: p.what, value: m[0] };
  }
  const a = ASSIGN.exec(text);
  if (a && !PLACEHOLDER.test(a[1]) && entropy(a[1]) >= 3.5) return { id: 'generic-secret', what: 'high-entropy secret assignment', value: a[1] };
  return null;
}

export function isEnvFile(f: string): boolean {
  return /(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template|dist)$/.test(f);
}

export const secretScanCheck: Check = (ctx) => {
  const files = ctx.files.filter((f) => !SKIP_FILE.test(f) && (isEnvFile(f) || !matchesAny(f, ctx.rules.secret_scan.allow_paths)));
  if (!files.length) return { id: 'secrets', title: 'secret scan', status: 'pass', summary: 'no files to scan', details: [], findings: [] };

  let lines: Map<string, { line: number; text: string }[]>;
  if (ctx.filesMode === 'all') {
    lines = new Map();
  } else {
    lines = ctx.git.addedLines(ctx.filesMode === 'staged' ? null : ctx.diffBase ?? 'HEAD', files);
  }
  // Untracked files (or --all) have no diff: scan whole content.
  for (const f of files) {
    if (lines.has(f)) continue;
    if (ctx.filesMode === 'staged') continue;
    let text: string;
    try {
      const p = path.join(ctx.root, f);
      if (fs.statSync(p).size > 1024 * 1024) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    lines.set(f, text.split('\n').map((t, i) => ({ line: i + 1, text: t })));
  }

  const findings: Finding[] = [];
  // A dotenv file in a commit is a leak whatever its content looks like.
  for (const f of ctx.files.filter(isEnvFile)) {
    findings.push({ id: `SEC-${findings.length + 1}`, category: 'security', severity: 'high', confidence: 1, file: f, line: 1, reason: 'Environment file with possible secrets is about to be committed', evidence: `${f} is a dotenv file (keep it untracked; add it to .gitignore)`, origin: 'check' });
    lines.delete(f);
  }
  let scanned = 0;
  for (const [file, added] of lines) {
    for (const l of added) {
      scanned++;
      const hit = scanLine(l.text);
      if (hit) {
        findings.push({
          id: `SEC-${findings.length + 1}`,
          category: 'security',
          severity: 'high',
          confidence: hit.id === 'generic-secret' ? 0.7 : 0.95,
          file,
          line: l.line,
          reason: `Possible ${hit.what} committed`,
          evidence: `${hit.id}: ${mask(hit.value)}`,
          origin: 'check',
        });
      }
    }
  }
  if (!findings.length) return { id: 'secrets', title: 'secret scan', status: 'pass', summary: `${scanned} added line(s) in ${lines.size} file(s), nothing found`, details: [], findings };
  return {
    id: 'secrets',
    title: 'secret scan',
    status: 'fail',
    summary: `${findings.length} possible secret(s)`,
    details: findings.map((f) => `${f.file}:${f.line}  ${f.reason} (${f.evidence})`),
    fix: 'remove the secret and rotate it; for a false positive add `preguard:allow-secret` on that line or list the path in secret_scan.allow_paths',
    findings,
  };
};
