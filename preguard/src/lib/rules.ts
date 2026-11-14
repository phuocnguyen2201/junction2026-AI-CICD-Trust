import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, stringifyYaml, yamlScalar } from './yaml.ts';

export interface TestMode {
  name: string;
  command: string;
  /** Optional: env vars the mode sets (informational, used by the inventory check). */
  env?: Record<string, string>;
}

export interface Rules {
  version: number;
  base_branch: string | null;
  pinned_env: { source: 'auto' | 'manual'; node?: string | null; dotnet?: string | null; python?: string | null };
  time_budget: { commit_seconds: number; push_minutes: number };
  layers: { backend: string[]; frontend: string[] };
  critical_paths: { backend: string[]; frontend: string[] };
  public_api: string[];
  tools: {
    format: { check: string | null; fix: string | null };
    lint: { command: string | null; fix: string | null };
    typecheck: { command: string | null };
    tests: { runner: string | null; related: string | null };
    /** End-to-end command for critical flows (login, checkout). */
    e2e: string | null;
  };
  test_modes: TestMode[];
  secret_scan: { allow_paths: string[] };
  /** Checks a developer may bypass with a written reason. Secrets and owner decisions never can. */
  bypass: { allowed: string[] };
  full_review_triggers: string[];
  checklist: string[];
  /** Track record from git history (`preguard trust`). */
  trust: {
    /** Regex for task ids in commit subjects. */
    task_pattern: string;
    /** How far back to read history. */
    history_days: number;
    /** A revert or follow-up fix within this many days of a task counts against it. */
    window_days: number;
    /** Fewer settled tasks than this in a category = "building", never "earned". */
    min_tasks: number;
    /** 95% lower bound on the success rate needed for "earned". */
    required_lower_bound: number;
  };
  ai: {
    provider: string | null;
    model: string | null;
    send_code: boolean;
    /** Env var that holds the API key (default per provider, e.g. ANTHROPIC_API_KEY). Never the key itself. */
    api_key_env: string | null;
    /** Optional dotenv file to read the key from, relative to the repo root. */
    env_file: string | null;
    /** Claude effort: low|medium|high|xhigh|max; null = model default. */
    reasoning_effort: string | null;
    /** Stop waiting and report "not run" after this long. */
    timeout_seconds: number;
    /** Drop AI findings below this confidence (precision over volume). */
    min_confidence: number;
    /** Also run the AI self-review in the commit hook (slower commits; off by default). */
    on_commit: boolean;
  };
}

export const RULES_PATH = '.preguard/rules.yml';

export const DEFAULT_CHECKLIST = [
  'silent_failure',
  'fix_wider_than_issue',
  'self_confirming_tests',
  'missing_test_modes',
  'unsourced_claims',
  'env_mismatch',
  'scope_drift',
  'safety_net_dependency',
];

export const DEFAULT_BYPASSABLE = ['related_tests', 'all_tests', 'e2e', 'ai_review', 'test_inventory', 'format', 'lint', 'typecheck', 'pinned_env', 'scope', 'a11y', 'screenshots', 'critical_flows'];
/** Never bypassable, whatever the rule pack says: a leaked secret can't be unleaked, and owner decisions aren't the developer's. */
export const NEVER_BYPASS = ['secrets', 'public_api', 'api_contract', 'migrations', 'decisions'];

export const DEFAULT_TRIGGERS = ['public_api_change', 'build_breaking_rule', 'data_or_wire_format', 'security'];

export function defaultRules(): Rules {
  return {
    version: 1,
    base_branch: null,
    pinned_env: { source: 'auto' },
    time_budget: { commit_seconds: 30, push_minutes: 5 },
    layers: { backend: [], frontend: [] },
    critical_paths: {
      backend: ['**/auth/**', '**/payment*/**', '**/migrations/**'],
      frontend: ['**/login/**', '**/checkout/**'],
    },
    public_api: [],
    tools: {
      format: { check: null, fix: null },
      lint: { command: null, fix: null },
      typecheck: { command: null },
      tests: { runner: null, related: null },
      e2e: null,
    },
    test_modes: [],
    secret_scan: { allow_paths: [] },
    bypass: { allowed: [...DEFAULT_BYPASSABLE] },
    full_review_triggers: [...DEFAULT_TRIGGERS],
    checklist: [...DEFAULT_CHECKLIST],
    trust: { task_pattern: '\\b[A-Z][A-Z0-9]+-\\d+\\b', history_days: 365, window_days: 14, min_tasks: 5, required_lower_bound: 0.8 },
    ai: { provider: null, model: null, send_code: false, api_key_env: null, env_file: '.env', reasoning_effort: 'medium', timeout_seconds: 120, min_confidence: 0.6, on_commit: false },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
  return out as T;
}

export class RulesError extends Error {}

export function loadRules(root: string): { rules: Rules; path: string; exists: boolean } {
  const p = path.join(root, RULES_PATH);
  if (!fs.existsSync(p)) return { rules: defaultRules(), path: p, exists: false };
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new RulesError(`${RULES_PATH}: ${(e as Error).message}`);
  }
  if (!isObj(parsed)) throw new RulesError(`${RULES_PATH}: expected a map at the top level`);
  if (parsed.version !== 1) throw new RulesError(`${RULES_PATH}: unsupported version ${String(parsed.version)} (expected 1)`);
  const rules = merge(defaultRules(), parsed);
  validateRules(rules);
  return { rules, path: p, exists: true };
}

function validateRules(r: Rules): void {
  const errs: string[] = [];
  const num = (v: unknown, name: string) => {
    if (typeof v !== 'number' || v <= 0) errs.push(`${name} must be a positive number`);
  };
  num(r.time_budget.commit_seconds, 'time_budget.commit_seconds');
  num(r.time_budget.push_minutes, 'time_budget.push_minutes');
  if (!Array.isArray(r.test_modes)) errs.push('test_modes must be a list');
  else
    r.test_modes.forEach((m, i) => {
      if (!m || typeof m.name !== 'string' || typeof m.command !== 'string') errs.push(`test_modes[${i}] needs name and command`);
    });
  for (const k of ['public_api', 'checklist', 'full_review_triggers'] as const) {
    if (!Array.isArray(r[k])) errs.push(`${k} must be a list`);
  }
  if (typeof r.ai.send_code !== 'boolean') errs.push('ai.send_code must be true or false');
  if (errs.length) throw new RulesError(`${RULES_PATH}: ${errs.join('; ')}`);
}

/** Render the rule pack with explanatory comments (keeps the file reviewable in PRs). */
export function renderRules(r: Rules, notes: { pinned: string[]; ci: string[] }): string {
  const block = (v: unknown, indent: number) => stringifyYaml(v, indent).replace(/\n$/, '');
  const list = (v: string[]) => `[${v.map(yamlScalar).join(', ')}]`;
  const out: string[] = [];
  out.push('# Pre-PR Guard rule pack. Shared by local hooks and CI: same rules, same commands.');
  out.push('# Edit through PRs. Owner: see the open decisions in the README.');
  out.push(`version: ${r.version}`);
  out.push(`base_branch: ${yamlScalar(r.base_branch)}`);
  out.push('');
  out.push('pinned_env:            # "auto": re-read the repo\'s own pin files on every run');
  out.push(`  source: ${r.pinned_env.source}`);
  for (const n of notes.pinned) out.push(`  # detected: ${n}`);
  out.push('');
  out.push('time_budget:');
  out.push(`  commit_seconds: ${r.time_budget.commit_seconds}`);
  out.push(`  push_minutes: ${r.time_budget.push_minutes}`);
  out.push('');
  out.push('layers:                # which paths count as back-end / front-end');
  out.push(`  backend: ${list(r.layers.backend)}`);
  out.push(`  frontend: ${list(r.layers.frontend)}`);
  out.push('');
  out.push('critical_paths:        # always risk tier "high"');
  out.push(`  backend: ${list(r.critical_paths.backend)}`);
  out.push(`  frontend: ${list(r.critical_paths.frontend)}`);
  out.push('');
  out.push('public_api:            # changes here raise the public_api_change flag');
  out.push(r.public_api.length ? r.public_api.map((x) => `  - ${yamlScalar(x)}`).join('\n') : '  []');
  out.push('');
  out.push("tools:                 # the repo's own tools, detected by init. {files} = changed files, {tests} = related test files");
  out.push(block(r.tools, 2));
  out.push('');
  out.push('test_modes:            # every mode/target the repo tests; pre-push runs all of them');
  out.push(r.test_modes.length ? block(r.test_modes, 2) : '  []');
  out.push('');
  out.push('secret_scan:');
  out.push(`  allow_paths: ${list(r.secret_scan.allow_paths)}`);
  out.push('');
  out.push('bypass:                # checks a developer may bypass with a written reason (recorded in the report)');
  out.push(`  allowed: ${list(r.bypass.allowed)}`);
  out.push('  # never bypassable: secrets, public API / contract, migrations, unanswered decisions');
  out.push('');
  out.push('full_review_triggers:  # changes that need a human design decision up front');
  out.push(r.full_review_triggers.map((x) => `  - ${yamlScalar(x)}`).join('\n'));
  out.push('');
  out.push('checklist:             # AI self-review items');
  out.push(r.checklist.map((x) => `  - ${x}`).join('\n'));
  out.push('');
  out.push('trust:                 # track record from git history (preguard trust)');
  out.push(`  task_pattern: ${yamlScalar(r.trust.task_pattern)}   # task id in commit subjects`);
  out.push(`  history_days: ${r.trust.history_days}`);
  out.push(`  window_days: ${r.trust.window_days}          # a revert or follow-up fix within this window counts as a failure`);
  out.push(`  min_tasks: ${r.trust.min_tasks}             # fewer settled tasks = "building"`);
  out.push(`  required_lower_bound: ${r.trust.required_lower_bound}  # 95% lower bound on success rate needed to "earn" trust`);
  out.push('');
  out.push('ai:');
  out.push(`  provider: ${yamlScalar(r.ai.provider)}   # null = no approved provider yet: AI steps are "not run"`);
  out.push(`  model: ${yamlScalar(r.ai.model)}`);
  out.push(`  send_code: ${r.ai.send_code}            # false means AI steps are skipped`);
  out.push(`  api_key_env: ${yamlScalar(r.ai.api_key_env)}         # name of the env var with the key (null = provider default); never the key itself`);
  out.push(`  env_file: ${yamlScalar(r.ai.env_file)}           # optional dotenv file (keep it out of git); $PREGUARD_ENV_FILE overrides`);
  out.push(`  reasoning_effort: ${yamlScalar(r.ai.reasoning_effort)}`);
  out.push(`  timeout_seconds: ${r.ai.timeout_seconds}       # AI step reports "not run" after this`);
  out.push(`  min_confidence: ${r.ai.min_confidence}         # AI findings below this are dropped`);
  out.push(`  on_commit: ${r.ai.on_commit}             # true = AI self-review also runs in the commit hook (slower)`);
  if (notes.ci.length) {
    out.push('');
    out.push(`# CI config found (not modified): ${notes.ci.join(', ')}`);
    out.push('# To keep "same rules as CI", have CI call: preguard check --all && preguard review');
  }
  return out.join('\n') + '\n';
}
