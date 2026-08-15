# ADR-0005: LLMs narrate deterministic output; they never compute or invent financial numbers

**Status:** Accepted (already the warehouse's operating pattern — this ADR formalizes it as a boundary the Intelligence Platform's new agents must not erode)

## Context

The single highest risk identified in the platform's architecture review is an LLM stating a wrong financial figure with the same confidence as a verified one, inside an unsupervised narrative brief, steering a real acquisition or capital decision. The existing warehouse already separates deterministic compute (growth/driver/anomaly/scoring engines) from LLM narration (JARVIS brief, Intel module) — this has held without incident. The new Extractor/Reconciler/Outcome Tracker/Narrator agents introduce more surface area where that boundary could quietly erode (e.g., an agent "helpfully" filling in a missing number via inference instead of flagging it as unknown).

## Decision

LLM agents may extract, classify, flag, and narrate. They may never originate a number that isn't directly sourced from a document or computed by a deterministic engine. Any number-bearing narrative claim routes through the Adversarial Verifier before it ships. A missing figure is represented as an explicit `confidence: unknown` fact, never estimated by the LLM to fill a gap, unless an agent is *explicitly* designed and labeled as producing an estimate (and even then, tagged `confidence: estimated`, never presented at the same trust level as a verified fact).

## Consequences

- Every new agent's design must state, explicitly, which side of this boundary it's on (compute vs. narrate) — an agent that blurs the two doesn't ship without a redesign.
- This adds friction: some genuinely useful inferences ("this insurance renewal will likely increase ~8% based on the last four cycles") require a labeled estimation agent rather than letting the Narrator just say it — accepted, because the alternative erodes trust in every other number the system states correctly.
- Loosening this boundary later, once agents and Gabriel have learned to trust LLM-narrated numbers, is a governance and trust problem to re-litigate explicitly — not a change to make silently by adding a convenient shortcut in one agent.
