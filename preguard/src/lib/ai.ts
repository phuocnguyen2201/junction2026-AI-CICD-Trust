import Anthropic from '@anthropic-ai/sdk';
import type { Rules } from './rules.ts';
import { findApiKey } from './env.ts';
import { validate, type Schema } from './schema.ts';

// One job: send a prompt to the approved provider (Anthropic, Claude) and get schema-valid JSON back.
// Code goes ONLY to the provider in the rule pack. Invalid output is retried once, then the step is "not run".
// Nothing about the code is logged or stored; only token counts are kept (principle 8).

export interface AiResult<T> {
  ok: boolean;
  value?: T;
  /** Why the step did not run (for the report). Never contains the key. */
  reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
  ms: number;
  attempts: number;
  model?: string;
}

const SUPPORTED = ['anthropic'];
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Can AI steps run at all? Returns a "not run" reason if not. */
export function aiAvailability(root: string, rules: Rules): { ok: true; key: string } | { ok: false; reason: string } {
  const ai = rules.ai;
  if (process.env.PREGUARD_NO_AI === '1') return { ok: false, reason: 'AI turned off for this run (--no-ai)' };
  if (!ai.provider) return { ok: false, reason: 'no approved AI provider in rules.yml (ai.provider)' };
  if (!SUPPORTED.includes(ai.provider)) return { ok: false, reason: `provider "${ai.provider}" is not supported (supported: ${SUPPORTED.join(', ')})` };
  if (!ai.model) return { ok: false, reason: 'no model in rules.yml (ai.model)' };
  if (!ai.send_code) return { ok: false, reason: 'ai.send_code is false: code is never sent' };
  const k = findApiKey(root, rules);
  if (!k.key) return { ok: false, reason: `no API key: set ${k.varName ?? 'the key variable'} in the environment, in $PREGUARD_ENV_FILE or in ai.env_file` };
  return { ok: true, key: k.key };
}

/**
 * The schema sent to the API: our local schema minus keywords only the local validator needs
 * (numeric bounds), with type unions written as anyOf. The full schema is still checked locally.
 */
export function toWireSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(s.type)) {
    return { anyOf: s.type.map((t) => toWireSchema({ ...s, type: t })), ...(s.description ? { description: s.description } : {}) };
  }
  if (s.type) out.type = s.type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toWireSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.additionalProperties === false) out.additionalProperties = false;
  if (s.items) out.items = toWireSchema(s.items);
  return out;
}

function describeError(e: unknown, model: string, timeoutMs: number): string {
  // Typed SDK errors, most specific first; messages are scrubbed of anything key-like.
  const msg = (e as Error)?.message?.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…').slice(0, 200) ?? String(e);
  if (e instanceof Anthropic.AuthenticationError) return 'API key rejected (401): check ANTHROPIC_API_KEY';
  if (e instanceof Anthropic.PermissionDeniedError) return `key has no access to ${model} (403)`;
  if (e instanceof Anthropic.NotFoundError) return `model "${model}" not found for this key (404)`;
  if (e instanceof Anthropic.RateLimitError) return 'rate limited (429): try again shortly';
  if (e instanceof Anthropic.BadRequestError) return `request rejected (400): ${msg}`;
  if (e instanceof Anthropic.InternalServerError) return `provider error (${e.status}): try again`;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return `timed out after ${Math.round(timeoutMs / 1000)} s (ai.timeout_seconds)`;
  if (e instanceof Anthropic.APIConnectionError) return `could not reach the provider: ${msg}`;
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${msg}`;
  return `AI call failed: ${msg}`;
}

export async function callJson<T>(root: string, rules: Rules, req: { name: string; system: string; user: string; schema: Schema }, timeoutMs: number): Promise<AiResult<T>> {
  const start = Date.now();
  const avail = aiAvailability(root, rules);
  if (!avail.ok) return { ok: false, reason: avail.reason, ms: 0, attempts: 0 };
  const model = rules.ai.model!;
  const client = new Anthropic({ apiKey: avail.key, maxRetries: 1, timeout: timeoutMs });
  const usage = { input_tokens: 0, output_tokens: 0 };
  let lastProblem = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = timeoutMs - (Date.now() - start);
    if (left < 2000) return { ok: false, reason: `timed out after ${Math.round((Date.now() - start) / 1000)} s (ai.timeout_seconds)`, usage, ms: Date.now() - start, attempts: attempt - 1 };
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await client.beta.messages.create(
        {
          model,
          max_tokens: 16000,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: {
            format: { type: 'json_schema', schema: toWireSchema(req.schema) },
            ...(rules.ai.reasoning_effort ? { effort: rules.ai.reasoning_effort as Effort } : {}),
          },
          // Server-side fallback on a policy decline (enabled by default for current Claude models).
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { timeout: left },
      );
    } catch (e) {
      return { ok: false, reason: describeError(e, model, left), usage, ms: Date.now() - start, attempts: attempt };
    }
    usage.input_tokens += res.usage?.input_tokens ?? 0;
    usage.output_tokens += res.usage?.output_tokens ?? 0;

    if (res.stop_reason === 'refusal') {
      const cat = (res as { stop_details?: { category?: string | null } }).stop_details?.category;
      return { ok: false, reason: `the model declined this request${cat ? ` (${cat})` : ''}`, usage, ms: Date.now() - start, attempts: attempt, model: res.model };
    }
    if (res.stop_reason === 'max_tokens') {
      lastProblem = 'response was cut off (max_tokens)';
      continue;
    }
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (!text) {
      lastProblem = 'no JSON text in the response';
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      lastProblem = 'response was not valid JSON';
      continue;
    }
    const errs = validate(parsed, req.schema);
    if (errs.length) {
      lastProblem = `response failed the schema: ${errs.slice(0, 3).join('; ')}`;
      continue;
    }
    return { ok: true, value: parsed as T, usage, ms: Date.now() - start, attempts: attempt, model: res.model };
  }
  return { ok: false, reason: `${lastProblem} (after 1 retry)`, usage, ms: Date.now() - start, attempts: 2 };
}
