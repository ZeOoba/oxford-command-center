# Oxford Intelligence Platform — Roadmap (living document)

**Status:** RATIFIED — merged [PR #246](https://github.com/ZeOoba/oxford-command-center/pull/246), 2026-07-29. Phase 0 kickoff is the next open action (unclaimed — no `architecture/status.json` entry exists yet).
**Governed by:** [`docs/constitution/ENGINEERING_CONSTITUTION.md`](../../constitution/ENGINEERING_CONSTITUTION.md) — where anything in this roadmap conflicts with the constitution, the constitution wins unless it's been explicitly amended. Read it once; it doesn't change per-phase the way this file does.
**Supersedes:** nothing yet ratified supersedes this. `docs/superpowers/specs/2026-06-13-ora-intelligence-platform-master-plan.md` is the prior master plan for the *Financial Intelligence* line of work — every phase it proposed is now Merged per CLAUDE.md §3. This roadmap is a **new, separate initiative** that builds the cross-document "institutional memory" layer on top of the warehouse that plan shipped. Read that file for history; do not treat its gap list as current (it isn't — see its own file header).

This folder is the single source of truth for the Intelligence Platform initiative's *work sequencing*. It is not a one-time artifact — it is maintained the same way the rest of this repo's process docs are (`architecture/status.json`, `docs/superpowers/specs/`, `docs/superpowers/plans/`). Every session working on this initiative starts here.

## Files

- [`../../constitution/ENGINEERING_CONSTITUTION.md`](../../constitution/ENGINEERING_CONSTITUTION.md) — the platform's governing principles. Read first; changes rarely.
- [`00-master-roadmap.md`](00-master-roadmap.md) — phases, epics, the Phase 0 task graph, dependency graph, risk register, and the mandatory self-critique.
- [`01-agent-roadmap.md`](01-agent-roadmap.md) — the specialized-agent design (extraction, reconciliation, outcome-tracking, verification).
- [`02-standards-testing-quality.md`](02-standards-testing-quality.md) — the *delta* on top of `architecture/coding-standards.md`: fact/document schema conventions, testing strategy, data quality framework, observability, documentation placement rules.
- [`../../adr/`](../../adr/) — architecture decision records. New convention, introduced by this initiative because the repo had none. The first five ADRs record the hardest-to-reverse calls from the approved architecture review.

## How every session should use this

1. Read this README + `00-master-roadmap.md`'s phase table to find the current phase.
2. Check `architecture/status.json` for the phase's live entry (owner, status, blockers) — this roadmap says *what* and *why*; status.json says *who* and *is it claimed right now*.
3. If the phase's task graph doesn't exist yet in `00-master-roadmap.md` or a dated plan under `docs/superpowers/plans/`, run `superpowers:writing-plans` to generate it just-in-time — **do not** hand-write ad hoc tasks, and do not expect this roadmap to have pre-baked tickets for anything past Phase 0 (see "Why phases 2+ aren't ticketed yet" in `00-master-roadmap.md`).
4. Select the highest-priority unblocked task, confirm prerequisites, implement it in a worktree, write tests, update docs, add/update an ADR if a hard-to-reverse call was made, mark it done in `architecture/status.json`, then update the phase's status line in `00-master-roadmap.md` if the phase completed or a dependency changed.
5. On phase completion: fold anything durable into `architecture/system-overview.md` / `architecture/database-schema.md` / `architecture/api-contracts.md` (whichever applies), archive the phase's plan doc, and update this README's phase pointer.

## Current phase pointer

**Not started.** Awaiting Gabriel's go/no-go on Phase 0 (see `00-master-roadmap.md`). No `architecture/status.json` entry exists for this initiative yet — the first Phase 0 task creates it.
