// server/ai/models.ts
//
// One home for the Claude model IDs (2026-11-23 review, Tier 4). They were hard-coded in four files
// across two generations (claude-opus-5, claude-haiku-4-5-20251001). Gabriel ruled the same day:
// centralize, and move the defaults to the current 5.5 models. The env overrides keep working.

/** The assistant (Ask / agent loop) and the web-search comps call. */
export const ASSISTANT_MODEL = 'claude-opus-5-5';

/** Short, schema-bound or deterministic text work: briefing narratives and OM field extraction. */
export const FAST_MODEL = 'claude-haiku-5-5';

/** ANTHROPIC_MODEL overrides the assistant model; an empty value falls back to the default. */
export function assistantModel(): string {
  return process.env.ANTHROPIC_MODEL || ASSISTANT_MODEL;
}

/** OM_EXTRACT_MODEL overrides the extraction model (separate from the assistant model). */
export function omExtractModel(): string {
  return process.env.OM_EXTRACT_MODEL || FAST_MODEL;
}

/**
 * Request fields for a FAST_MODEL call. Claude Haiku 5.5 thinks by default and rejects a non-default
 * `temperature` with a 400, so these calls send no `temperature` and turn thinking off: they ran
 * without thinking on Haiku 4.5, and a 1024-token `max_tokens` would otherwise be spent on thinking
 * before any answer. `{type: 'disabled'}` is accepted on Haiku 5.5 at its default effort and on Haiku 4.5.
 */
export const FAST_CALL_FIELDS = { thinking: { type: 'disabled' } } as const;
