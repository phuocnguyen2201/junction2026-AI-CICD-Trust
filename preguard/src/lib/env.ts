import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { Rules } from './rules.ts';

// API keys are read at call time and never written to disk, logs, reports or state.
// Lookup order: process env → $PREGUARD_ENV_FILE → rules.ai.env_file (relative to repo root).

const DEFAULT_KEY_VAR: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY' };

export function apiKeyVar(rules: Rules): string | null {
  return rules.ai.api_key_env ?? (rules.ai.provider ? DEFAULT_KEY_VAR[rules.ai.provider] ?? null : null);
}

export function findApiKey(root: string, rules: Rules): { key: string | null; varName: string | null; source: string | null } {
  const varName = apiKeyVar(rules);
  if (!varName) return { key: null, varName: null, source: null };
  const fromEnv = process.env[varName];
  if (fromEnv) return { key: fromEnv, varName, source: 'environment' };
  const files = [process.env.PREGUARD_ENV_FILE, rules.ai.env_file && path.resolve(root, rules.ai.env_file)].filter((f): f is string => !!f);
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const value = parseEnv(text)[varName];
    if (value) return { key: value, varName, source: path.basename(f) };
  }
  return { key: null, varName, source: null };
}
