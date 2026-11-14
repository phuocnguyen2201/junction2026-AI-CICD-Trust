export type Severity = 'low' | 'medium' | 'high';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'not_run';
export type Stage = 'start' | 'tests' | 'check' | 'review' | 'review_staged' | 'ready';

export interface Finding {
  id: string;
  category: string;
  severity: Severity;
  confidence: number;
  file: string;
  line: number;
  reason: string;
  evidence: string;
  source_url?: string;
  /** Which stage found it (shift-left metric). */
  stage?: Stage;
  /** Who produced it: a deterministic check or the AI reviewer. */
  origin?: 'check' | 'ai';
  status?: 'open' | 'fixed';
}

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** One-line summary. For not_run this is the reason it didn't run. */
  summary: string;
  details: string[];
  fix?: string;
  ms: number;
  findings: Finding[];
  /** Extra structured data a later stage (e.g. `ready`) can use. */
  data?: Record<string, unknown>;
}

export interface Decision {
  id: string;
  question: string;
  why_not_ai: 'long_term_promise' | 'affects_all_users_or_data' | 'policy' | 'owner_intent';
  owner_role: string;
  answer: string | null;
  /** Optional link to a full_review_trigger, e.g. "public_api_change". */
  trigger?: string;
  where?: string;
}

export interface RequirementCard {
  id: string;
  title: string;
  acceptance_criteria: string[];
  scope: {
    in: string[];
    out: string[];
    /** Extension: path globs used by the scope check. */
    paths?: { in: string[]; out?: string[] };
  };
  layers: ('backend' | 'frontend')[];
  risk_tier: 'low' | 'medium' | 'high';
  expected_blast_radius: string;
  in_reach: { result: 'do' | 'do_with_checkpoint' | 'refuse'; signals_failed: string[]; needed_to_continue?: string; partial_work?: string };
  open_decisions: Decision[];
}
