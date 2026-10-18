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
//   model: 'opus',           // optional: 'opus' (default; Opus 5.5 -- the floor since 2026-10-05) | 'fable' (retired from dispatch, still accepted)
//   fallbackModel: 'opus',   // optional: 'opus' (default) | null. Ignored when it equals `model` (default 'opus' = one same-model retry per failed lens; null disables it)
//   outOfScope: ['known limit of the mechanism this change sits on', ...],  // optional: string | string[]. See SCOPING below.
// }})
//
// SCOPING A REVIEW OF A GUARD. When the change is a guard/gate on top of a mechanism with documented limits (a commit
// gate over a sign detector; a supersede guard over restale-in-place re-derives), do NOT let the first round re-litigate
// the mechanism. List its known limits in `outOfScope` and ask only "is the guard correct GIVEN these limits, and does it
// make any of them newly reachable, newly silent, or worse?". Review the mechanism itself as its own change. Without
// this, successive rounds each find the next layer of the same root cause (one supersede guard took three rounds).
//
// RECORDING THE RESULT. The result carries `clean` (every lens succeeded AND no real defect AND worst severity below
// medium) and `lensCount`. A `Refute-Reviewed: wf_<id>` trailer means a clean run: record a BARE id only when `clean`
// is true. A run with findings you accept, or with failed lenses, must say so after the id. This rule lives HERE:
// `check:refute` (scripts/check-refute-required.ts) only sees the trailer text, so it cannot enforce `clean`; the
// procedure docs that show the trailer (architecture/coding-standards.md) predate it and still show the bare form.
//
// FINDING-SEVERITY LOOP RULE. Low findings: fix in the same pass. Medium or higher: stop and report to the owner before
// another round, so the loop stays bounded and the owner decides whether to keep going, narrow the change, or split it.
//
// REVIEWER HYGIENE. Reviewers are told to remove any scratch worktree / node_modules junction they create (junction via
// `cmd /c rmdir`, never a recursive delete through it) before finishing; check `git worktree list` after a run anyway.
// There is deliberately ONE script: a forked "-opus" copy drifted (47 lines, two versions in circulation).
// The result records which models ran (`models`, `modelFloorMet`) so a Refute-Reviewed attestation is auditable:
// modelFloorMet is true for every accepted tier (both are at or above the Opus 5.5 floor); a lower model throws.
// args may also be a PLAIN STRING (treated as changeSet with the default lenses).

export const meta = {
  name: 'refute-financial-change',
  description: 'Adversarially refute a financial-decision code change (engine/scoring/NOI) across N lenses before commit',
  phases: [{ title: 'Refute', detail: 'independent refuters, each told to break the change', model: 'opus' }],
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

// Model selection. Only the two tiers this workflow has ever been validated on are accepted; anything
// lower (sonnet/haiku/free text) throws rather than silently weakening a financial-code gate.
const TIERS = ['fable', 'opus']
const primaryModel = A.model ?? 'opus'
if (!TIERS.includes(primaryModel)) throw new Error('model must be one of ' + TIERS.join(' | ') + ' (got ' + JSON.stringify(A.model) + ')')
const fallbackModel = A.fallbackModel === undefined ? 'opus' : A.fallbackModel
if (fallbackModel !== null && !TIERS.includes(fallbackModel)) throw new Error('fallbackModel must be one of ' + TIERS.join(' | ') + ' | null (got ' + JSON.stringify(A.fallbackModel) + ')')
// A same-model "fallback" is a deliberate single retry: with opus now the default primary, skipping it would
// let one transient API failure silently drop a lens from a gate attestation (2026-10-05 review, C1).
const effectiveFallback = fallbackModel || null

phase('Refute')

// Known limits of the mechanism under the change (optional). Injected into every lens prompt so reviewers judge the
// change GIVEN them instead of re-reporting them. A wrong type throws rather than silently dropping the scoping.
if (A.outOfScope !== undefined && A.outOfScope !== null && typeof A.outOfScope !== 'string' && !Array.isArray(A.outOfScope)) {
  throw new Error('outOfScope must be a string or an array of strings (got ' + typeof A.outOfScope + ')')
}
if (Array.isArray(A.outOfScope) && A.outOfScope.some((s) => typeof s !== 'string')) {
  throw new Error('outOfScope array elements must all be strings')
}
const outOfScopeItems = [].concat(A.outOfScope ?? []).map((s) => String(s).trim()).filter(Boolean)
const outOfScopeBlock = outOfScopeItems.length
  ? '\n\nKNOWN LIMITS OF THE UNDERLYING MECHANISM (out of scope: do NOT report these as defects of this change). Judge whether THIS change is correct GIVEN these limits; report one only if this change makes it newly reachable, newly silent, or worse than before:\n' + outOfScopeItems.map((s) => '- ' + s).join('\n')
  : ''
// Clean-up duty (a reviewer once left a registered worktree and a node_modules junction behind). Deleting THROUGH a
// junction deletes the real target, so the junction is removed with rmdir, never recursively.
const hygiene = '\n\nCLEAN UP before you finish: if you created a scratch git worktree or a node_modules junction, remove the junction with `cmd /c rmdir <path>\\node_modules` (NEVER rm -rf or any recursive delete through it, which follows the link and deletes the real node_modules), then run `git worktree remove --force <path>`, and delete any probe files you wrote outside the repo. Leave the worktree you were pointed at exactly as you found it.'

const base =
  'You are a HOSTILE financial-systems reviewer for Oxford Realty Advisors (private family-office industrial real estate). BREAK the change below; do NOT bless it. This is NOI / capital-allocation / scoring code — a silent error mis-allocates real capital. Read the ACTUAL files at ' + repo + ' (use git diff for the uncommitted change). HARD CONSTRAINT (CLAUDE.md §9, applies in every checkout and worktree): NEVER open, query, or read the live warehouse or any other data/**/*.sqlite file (data/warehouse/finance.sqlite in particular) — not even read-only, not to "check the real data". To probe a trigger, build an in-memory database in a vitest/tsx script (better-sqlite3 :memory: + runMigrations) from source and migrations only. Set foundRealDefect=true ONLY for a CONCRETE, demonstrably-triggerable defect — not a style nit or a future wish; if you cannot construct a trigger, say so and lean false. ' + greenContext + hygiene + '\n\nCHANGE SET:\n' + changeSet + outOfScopeBlock + '\n\nYOUR LENS: '

// 2026-10-05: governor/financial-code invariant floor is Opus 5.5 (CLAUDE.md Dispatch line; Fable
// retired from dispatch). Opus is the canary-tested tier at the ~2-3-concurrent rate-limit ceiling
// (reference_lean_ram_toolkit.md); concurrency held at 3. The null-result fallback below only fires
// when a caller explicitly selects model:'fable' (agent() returns null on a terminal API failure)
// so that lens is retried on opus rather than silently dropped.
const verdicts = await parallel(
  lenses.map((l) => async () => {
    let v = await agent(base + l.focus, { label: 'refute:' + l.label, phase: 'Refute', model: primaryModel, schema: VERDICT })
    if (v === null && effectiveFallback) {
      log(`${primaryModel} call failed for lens "${l.label}" — ${effectiveFallback === primaryModel ? 'retrying once on' : 'falling back to'} ${effectiveFallback}.`)
      v = await agent(base + l.focus, { label: 'refute:' + l.label + ':' + effectiveFallback + '-fallback', phase: 'Refute', model: effectiveFallback, schema: VERDICT })
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
  log(`All ${lenses.length} lenses failed (${primaryModel}${effectiveFallback ? ' and ' + effectiveFallback + ' fallback' : ''} unavailable) — this is a TOOLING FAILURE, not a clean result. Do not report CLEAN.`)
} else {
  log(real.length
    ? `${real.length}/${succeeded.length} lenses found a real defect; worst severity rank ${worst}. Fix before commit.`
    : succeeded.length < lenses.length
      ? `No real defect in ${succeeded.length}/${lenses.length} lenses, but ${lenses.length - succeeded.length} lens(es) FAILED even after retry — PARTIAL coverage; do not treat as a full clean pass.`
      : `No real defect across ${succeeded.length}/${lenses.length} lenses. Clear to commit (still confirm the gate).`)
}

return {
  verdicts, anyRealDefect: real.length > 0, worstSeverityRank: worst, succeeded: succeeded.length, allFailed,
  lensCount: lenses.length, clean: succeeded.length === lenses.length && real.length === 0 && worst < order.medium,
  models: { primary: primaryModel, fallback: effectiveFallback },
  modelFloorMet: TIERS.includes(primaryModel),
}
