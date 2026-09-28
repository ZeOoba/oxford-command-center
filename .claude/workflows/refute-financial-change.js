// refute-financial-change — reusable adversarial review for financial-decision code.
//
// Engineering OS mandate: any change to engine math, scoring, benchmarking, NOI, or anything feeding
// capital-allocation gets a MANDATORY adversarial pass — reviewers told to REFUTE/break the change,
// not confirm it — before "done". This workflow was distilled from the PFI Phase 1a review, where
// three rounds caught five real defects a green gate never surfaced (NOI double-count, arbitrary-row
// basis pick, intransitive tie-break, incomplete scoring guard, unknown-basis pooling).
//
// Invoke:  Workflow({ name: 'refute-financial-change', args: {
//   changeSet: 'PROSE describing the exact uncommitted change set (files, functions, behavior).',
//   repo: 'C:\\Users\\Owner\\oxford-command-center',         // optional; default below
//   lenses: [ { label: 'noi', focus: 'NOI correctness & regression — ...' }, ... ],  // optional
//   greenContext: 'The full gate is GREEN and behavior-preserving on the current corpus.',  // optional
// }})
// args may also be a PLAIN STRING (treated as changeSet with the default lenses).

export const meta = {
  name: 'refute-financial-change',
  description: 'Adversarially refute a financial-decision code change (engine/scoring/NOI) across N lenses before commit',
  phases: [{ title: 'Refute', detail: 'independent refuters, each told to break the change', model: 'fable' }],
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'foundRealDefect', 'maxSeverity', 'findings', 'summary'],
  properties: {
    lens: { type: 'string' },
    foundRealDefect: { type: 'boolean' },
    maxSeverity: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'detail', 'concreteTrigger', 'suggestedFix'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          detail: { type: 'string' },
          concreteTrigger: { type: 'string', description: 'exact input/scenario that triggers it, or "none — could not construct one"' },
          suggestedFix: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

const A = (typeof args === 'string') ? { changeSet: args } : (args ?? {})
const repo = A.repo ?? 'C:\\Users\\Owner\\oxford-command-center'
const changeSet = A.changeSet ?? 'NO CHANGE SET PROVIDED — read git diff in the repo and review the uncommitted changes.'
const greenContext = A.greenContext ?? 'Probe the EDGES the current corpus does not exercise; a green gate does not prove correctness on unencountered data.'
const lenses = (Array.isArray(A.lenses) && A.lenses.length)
  ? A.lenses
  : [
      { label: 'correctness', focus: 'NUMERIC CORRECTNESS & REGRESSION — does the change ever produce a wrong number vs the prior behavior? SQL/param binding, sign conventions, rounding, off-by-one, double-counting.' },
      { label: 'determinism', focus: 'DETERMINISM & ORDER-INDEPENDENCE — is every comparator a total order (transitive)? Does any result depend on row/Map/iteration order? Construct a permutation that flips the output.' },
      { label: 'edges', focus: 'EDGE CASES & COMPLETENESS — nulls, empty cohorts, singletons, mixed bases/grains, coexisting versions; does the guard cover EVERY path into the decision, or only the obvious one?' },
      { label: 'sweep-completer', focus: 'SWEEP COMPLETENESS — the change claims to apply something EVERYWHERE (a rename, a guard, a coercion, a new field, a policy). Do NOT read the diff first and check it off. Independently enumerate, from the repo itself (grep the pattern, the callers, the sibling modules, config/fixtures/docs/tests), EVERY location that should have received the change; THEN diff your list against what was actually changed. Report each MISSED instance as a finding with its file:line. A half-applied sweep is a real defect: the unchanged half now silently disagrees with the changed half.' },
      { label: 'scope-auditor', focus: 'SCOPE INTEGRITY — diff the ACTUAL change against the DECLARED intent above. Flag every hunk that is not required by the stated scope: unrelated files, opportunistic refactors, reformatting, dependency/lockfile churn, config or generated-artifact edits. Separately flag anything that looks SWEPT IN from a concurrent session on a shared checkout — edits in a different voice/style, changes to files this task never named, snapshot/auto-refresh output, or work matching some OTHER in-flight effort. An unrelated hunk riding along in this commit is a real defect regardless of its own quality.' },
    ]

if (lenses.length > 4096) throw new Error('too many lenses')

phase('Refute')

const base =
  'You are a HOSTILE financial-systems reviewer for Oxford Realty Advisors (private family-office industrial real estate). BREAK the change below; do NOT bless it. This is NOI / capital-allocation / scoring code — a silent error mis-allocates real capital. Read the ACTUAL files at ' + repo + ' (use git diff for the uncommitted change). HARD CONSTRAINT (CLAUDE.md §9, applies in every checkout and worktree): NEVER open, query, or read the live warehouse or any other data/**/*.sqlite file (data/warehouse/finance.sqlite in particular) — not even read-only, not to "check the real data". To probe a trigger, build an in-memory database in a vitest/tsx script (better-sqlite3 :memory: + runMigrations) from source and migrations only. Set foundRealDefect=true ONLY for a CONCRETE, demonstrably-triggerable defect — not a style nit or a future wish; if you cannot construct a trigger, say so and lean false. ' + greenContext + '\n\nCHANGE SET:\n' + changeSet + '\n\nYOUR LENS: '

// 2026-07-10: governor/financial-code invariant floor raised from opus to fable (CLAUDE.md
// Dispatch line). Fable's fan-out concurrency is UNTESTED (only opus was canary-tested at the
// ~2-3-concurrent rate-limit ceiling — reference_lean_ram_toolkit.md) and Fable has observed
// availability gaps, so each lens falls back to opus on a null result (agent() returns null on
// a terminal API failure) rather than silently dropping that lens. Concurrency held at 3
// (unchanged) — do not widen this fan-out until Fable's own ceiling is verified.
const verdicts = await parallel(
  lenses.map((l) => async () => {
    let v = await agent(base + l.focus, { label: 'refute:' + l.label, phase: 'Refute', model: 'fable', schema: VERDICT })
    if (v === null) {
      log(`Fable call failed for lens "${l.label}" — falling back to opus.`)
      v = await agent(base + l.focus, { label: 'refute:' + l.label + ':opus-fallback', phase: 'Refute', model: 'opus', schema: VERDICT })
    }
    return v
  }),
)

const succeeded = verdicts.filter(Boolean)
const allFailed = succeeded.length === 0
const real = succeeded.filter((v) => v.foundRealDefect)
const order = { critical: 4, high: 3, medium: 2, low: 1, none: 0 }
const worst = succeeded.reduce((m, v) => Math.max(m, order[v.maxSeverity] ?? 0), 0)

if (allFailed) {
  log(`All ${lenses.length} lenses failed (Fable and opus fallback both unavailable) — this is a TOOLING FAILURE, not a clean result. Do not report CLEAN.`)
} else {
  log(real.length
    ? `${real.length}/${succeeded.length} lenses found a real defect; worst severity rank ${worst}. Fix before commit.`
    : `No real defect across ${succeeded.length}/${lenses.length} lenses. Clear to commit (still confirm the gate).`)
}

return { verdicts, anyRealDefect: real.length > 0, worstSeverityRank: worst, succeeded: succeeded.length, allFailed }
