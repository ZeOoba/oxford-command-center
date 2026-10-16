// server/ai/egress-scan.ts
//
// The agent's server-side confidentialScan (OI-225 layer 2), extracted from server/index.ts so it is
// unit-testable (refute round 3, U3). Server-only: it reads the roster off disk, so it cannot live in
// the runtime-agnostic agent module (the mirror has no filesystem).
//
// Uses egressRosterMatch, which refuses the placeholder roster as well as an unreadable one: tool
// results go to an external API, the same egress class as comps and OM extraction. On either
// failure the real detail goes to the server log only (it embeds the roster's absolute path and
// the opt-out's name), and the generic CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE is thrown.
// runAgent passes exactly that message through and halts (fail closed).
import { egressRosterMatch } from '../briefing/roster-match';
import { CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE } from './agent';
import type { ConfidentialHit } from '../briefing/confidential';

export function agentConfidentialScan(value: unknown): ConfidentialHit | null {
  try {
    return egressRosterMatch(value);
  } catch (err) {
    console.error('[ai] confidentiality guard unavailable:', err);
    throw new Error(CONFIDENTIALITY_GUARD_UNAVAILABLE_MESSAGE);
  }
}
