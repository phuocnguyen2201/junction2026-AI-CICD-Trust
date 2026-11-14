import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult, Stage } from './types.ts';

export interface StageRecord {
  stage: Stage;
  card_id: string | null;
  head: string | null;
  /** Tree the results describe: staged tree for a commit-hook run, HEAD tree for a clean branch run, null if dirty. */
  tree: string | null;
  branch: string;
  dirty: boolean;
  files_mode: string;
  files: string[];
  started_at: string;
  ms: number;
  budget_ms: number;
  results: CheckResult[];
}

const STATE_DIR = '.preguard/state';

export function stateDir(root: string, cardId: string | null): string {
  return path.join(root, STATE_DIR, cardId ?? '_no-card');
}

export function saveStage(root: string, rec: StageRecord): string {
  const dir = stateDir(root, rec.card_id);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${rec.stage}.json`);
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n');
  return p;
}

export function loadStage(root: string, cardId: string | null, stage: Stage): StageRecord | null {
  const p = path.join(stateDir(root, cardId), `${stage}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Keep local-only state out of git without touching the repo's own .gitignore. */
export function ensureStateIgnored(root: string): void {
  const p = path.join(root, '.preguard/.gitignore');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# Local Pre-PR Guard output (never committed)\nstate/\nreports/\n');
  }
}

export interface Bypass {
  check: string;
  reason: string;
  tree: string;
  by: string;
  at: string;
}

export function loadBypasses(root: string, cardId: string | null): Bypass[] {
  const p = path.join(stateDir(root, cardId), 'bypasses.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

export function saveBypasses(root: string, cardId: string | null, list: Bypass[]): void {
  fs.mkdirSync(stateDir(root, cardId), { recursive: true });
  fs.writeFileSync(path.join(stateDir(root, cardId), 'bypasses.json'), JSON.stringify(list, null, 2) + '\n');
}

// ---------- run log (one JSON line per run; feeds the dashboard's history) ----------

export interface RunEntry {
  at: string;
  stage: string;
  card: string | null;
  branch: string;
  head: string | null;
  /** pass/fail for check/review; red/yellow/green for ready. */
  result: string;
  fails: number;
  warns: number;
  not_run: number;
  findings: { high: number; medium: number; low: number };
  ms: number;
  /** Snapshot of the dashboard for this run, relative to .preguard/reports/. */
  snapshot?: string;
}

const RUN_LOG = '.preguard/state/runs.jsonl';

export function runEntryFor(rec: StageRecord, result?: string): RunEntry {
  const f = rec.results.flatMap((r) => r.findings);
  return {
    at: new Date().toISOString(),
    stage: rec.stage,
    card: rec.card_id,
    branch: rec.branch,
    head: rec.head,
    result: result ?? (rec.results.some((r) => r.status === 'fail') ? 'fail' : 'pass'),
    fails: rec.results.filter((r) => r.status === 'fail').length,
    warns: rec.results.filter((r) => r.status === 'warn').length,
    not_run: rec.results.filter((r) => r.status === 'not_run').length,
    findings: { high: f.filter((x) => x.severity === 'high').length, medium: f.filter((x) => x.severity === 'medium').length, low: f.filter((x) => x.severity === 'low').length },
    ms: rec.ms,
  };
}

export function appendRun(root: string, entry: RunEntry): void {
  const p = path.join(root, RUN_LOG);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
}

export function loadRuns(root: string, limit = 30): RunEntry[] {
  try {
    return fs
      .readFileSync(path.join(root, RUN_LOG), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEntry)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}
