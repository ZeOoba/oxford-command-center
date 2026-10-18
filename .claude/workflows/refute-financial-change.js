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
//   lenses: [ { label: 'noi', focus: 'NOI correctness & regression — ...' }, ... ],  // optional; see CUSTOM LENSES below
//   greenContext: 'The full gate is GREEN and behavior-preserving on the current corpus.',  // optional
//   model: 'opus',           // optional: 'opus' (default; Opus 5.5 -- the floor since 2026-10-05) | 'fable' (retired from dispatch, still accepted)
//   fallbackModel: 'opus',   // optional: 'opus' (default) | null. Ignored when it equals `model` (default 'opus' = one same-model retry per failed lens; null disables it)
//   outOfScope: ['known limit of the mechanism this change sits on', ...],  // optional: string | string[] (max 20 items, 300 chars each). See SCOPING below.
//   outOfScope: ['known limit of the mechanism this change sits on', ...],  // optional: string | string[]. See SCOPING below.
//   effort: 'low',           // optional reasoning effort per lens call: low | medium | high | xhigh | max (default: inherit the session)
// }})
//
// SCOPING A REVIEW OF A GUARD. When the change is a guard/gate on top of a mechanism with documented limits (a commit
// gate over a sign detector; a supersede guard over restale-in-place re-derives), do NOT let the first round re-litigate
// the mechanism. List its known limits in `outOfScope` and ask only "is the guard correct GIVEN these limits, and does it
// make any of them newly reachable, newly silent, or worse?". Review the mechanism itself as its own change. Without
// this, successive rounds each find the next layer of the same root cause (one supersede guard took three rounds).
// A scoped run tells every lens NOT to report the listed items, so the result echoes them (`outOfScope`) and sets
// `scoped: true`; cite a scoped run as `Refute-Reviewed: wf_<id> (scoped)` so a reader knows what was excluded.
//
// CUSTOM LENSES. Each custom lens must carry a non-empty string `label` and `focus` (anything else throws). A custom set
// only counts toward `clean` when it contains every default lens verbatim (same label AND focus); a narrower or
// re-worded set is reported (`lensesDefault: false`, `lensLabels`) but never `clean`.
//
// RECORDING THE RESULT. The result carries `clean` (every lens succeeded AND no real defect AND worst severity below
// medium AND the default lens set, or a superset of it, ran), `lensCount`, `lensesDefault`, `lensLabels`, `outOfScope`
// and `scoped`, plus `repo` and `changeSetSha256` / `changeSetLength` / `greenContextSha256` / `greenContextLength`
// (null when the arg was absent). A `Refute-Reviewed: wf_<id>` trailer means a clean run: record a BARE id only when `clean` is true and
// `scoped` is false (a clean scoped run is `wf_<id> (scoped)`). A run with findings you accept, or with failed lenses,
// must say so after the id. This rule lives HERE:
// `check:refute` (scripts/check-refute-required.ts) only sees the trailer text, so it cannot enforce `clean`; the
// procedure docs that show the trailer (architecture/coding-standards.md) predate it and still show the bare form.
// A run with a non-null `effort` result field was a reduced-effort pass: it is a weaker claim, so say so after the id
// (e.g. `wf_<id> (effort=low)`). `effort` records the REQUESTED level, not a confirmed applied one.
//
// TRUSTED CALLER INPUT. `changeSet` and `greenContext` go into every lens prompt verbatim, uncapped and unvalidated:
// nothing stops a caller from writing scoping ("ignore X") into them, and `scoped` does NOT detect that. They are
// trusted input, so the result records their sha256 and length; an auditor compares those against the change-set
// text the author cites before accepting the attestation. Only `outOfScope` is bounded and echoed verbatim.
//
// FINDING-SEVERITY LOOP RULE. Low findings: fix in the same pass. Medium or higher: stop and report to the owner before
// another round, so the loop stays bounded and the owner decides whether to keep going, narrow the change, or split it.
//
// REVIEWER HYGIENE. Reviewers are told to remove any scratch node_modules junction/symlink they create FIRST (via
// `cmd /c rmdir`, never a recursive delete through it; a real node_modules directory is left alone), then their scratch
// worktree with a plain `git worktree remove` (never --force, which discards uncommitted work), and never to remove the
// worktree under review (`repo`, named in the prompt); check `git worktree list` after a run anyway.
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
for (const k of ['changeSet', 'greenContext']) {
  if (A[k] !== undefined && A[k] !== null && typeof A[k] !== 'string') {
    throw new Error(k + ' must be a string (got ' + typeof A[k] + ')')
  }
}
const changeSet = A.changeSet ?? 'NO CHANGE SET PROVIDED — read git diff in the repo and review the uncommitted changes.'
const greenContext = A.greenContext ?? 'Probe the EDGES the current corpus does not exercise; a green gate does not prove correctness on unencountered data.'
const DEFAULT_LENSES = [
  { label: 'correctness', focus: 'NUMERIC CORRECTNESS & REGRESSION — does the change ever produce a wrong number vs the prior behavior? SQL/param binding, sign conventions, rounding, off-by-one, double-counting.' },
  { label: 'determinism', focus: 'DETERMINISM & ORDER-INDEPENDENCE — is every comparator a total order (transitive)? Does any result depend on row/Map/iteration order? Construct a permutation that flips the output.' },
  { label: 'edges', focus: 'EDGE CASES & COMPLETENESS — nulls, empty cohorts, singletons, mixed bases/grains, coexisting versions; does the guard cover EVERY path into the decision, or only the obvious one?' },
  { label: 'sweep-completer', focus: 'SWEEP COMPLETENESS — the change claims to apply something EVERYWHERE (a rename, a guard, a coercion, a new field, a policy). Do NOT read the diff first and check it off. Independently enumerate, from the repo itself (grep the pattern, the callers, the sibling modules, config/fixtures/docs/tests), EVERY location that should have received the change; THEN diff your list against what was actually changed. Report each MISSED instance as a finding with its file:line. A half-applied sweep is a real defect: the unchanged half now silently disagrees with the changed half.' },
  { label: 'scope-auditor', focus: 'SCOPE INTEGRITY — diff the ACTUAL change against the DECLARED intent above. Flag every hunk that is not required by the stated scope: unrelated files, opportunistic refactors, reformatting, dependency/lockfile churn, config or generated-artifact edits. Separately flag anything that looks SWEPT IN from a concurrent session on a shared checkout — edits in a different voice/style, changes to files this task never named, snapshot/auto-refresh output, or work matching some OTHER in-flight effort. An unrelated hunk riding along in this commit is a real defect regardless of its own quality.' },
]

// Custom lenses (optional). A wrong type, or a lens without a non-empty string label AND focus, throws: a lens with no
// focus would otherwise run as "YOUR LENS: undefined" and still count toward a clean result.
if (A.lenses !== undefined && A.lenses !== null && !Array.isArray(A.lenses)) {
  throw new Error('lenses must be an array of { label, focus } (got ' + typeof A.lenses + ')')
}
const nonEmptyString = (x) => typeof x === 'string' && x.trim() !== ''
if (Array.isArray(A.lenses)) {
  A.lenses.forEach((l, i) => {
    if (l === null || typeof l !== 'object' || !nonEmptyString(l.label) || !nonEmptyString(l.focus)) {
      throw new Error('lenses[' + i + '] must be an object with a non-empty string label and focus')
    }
  })
}
const lensesDefault = !(Array.isArray(A.lenses) && A.lenses.length)
const lenses = lensesDefault ? DEFAULT_LENSES : A.lenses
// `clean` may only be claimed when every default lens ran verbatim (same label AND focus): a caller-supplied set that
// drops one, or re-words its focus ("confirm it looks fine"), is reported but never clean.
const coversDefaultLenses = DEFAULT_LENSES.every((d) => lenses.some((l) => l.label === d.label && l.focus === d.focus))

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

// SHA-256 (FIPS 180-4) over the UTF-8 encoding, hex. Pure JS: workflow scripts have no Node crypto. Lone surrogates
// encode as U+FFFD, matching Buffer/TextEncoder, so the hash equals `sha256sum` of the same text saved as UTF-8.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const utf8Bytes = (str) => {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00)
      i++
    } else if (c >= 0xd800 && c <= 0xdfff) {
      c = 0xfffd
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}
const sha256Hex = (str) => {
  const bytes = utf8Bytes(str)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const W = new Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = ((bytes[off + 4 * t] << 24) | (bytes[off + 4 * t + 1] << 16) | (bytes[off + 4 * t + 2] << 8) | bytes[off + 4 * t + 3]) >>> 0
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3)
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10)
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + W[t]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    const v = [a, b, c, d, e, f, g, h]
    for (let k = 0; k < 8; k++) H[k] = (H[k] + v[k]) >>> 0
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('')
}
// Audit fields for the TRUSTED caller input (see header): null when the arg was absent and a built-in default ran.
const auditOf = (x) => (typeof x === 'string' ? { sha: sha256Hex(x), len: x.length } : { sha: null, len: null })
const changeSetAudit = auditOf(A.changeSet)
const greenContextAudit = auditOf(A.greenContext)
// Optional reasoning effort applied to every lens call (agent() supports opts.effort). Omitted = inherit the
// session effort, i.e. today's behaviour; a low-effort pass is a cheaper second opinion, not a replacement
// for the default-effort attestation run.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
if (A.effort !== undefined && !EFFORTS.includes(A.effort)) throw new Error('effort must be one of ' + EFFORTS.join(' | ') + ' (got ' + JSON.stringify(A.effort) + ')')
const effortOpt = A.effort === undefined ? {} : { effort: A.effort }

phase('Refute')

// Known limits of the mechanism under the change (optional). Injected into every lens prompt so reviewers judge the
// change GIVEN them instead of re-reporting them. A wrong type throws rather than silently dropping the scoping.
if (A.outOfScope !== undefined && A.outOfScope !== null && typeof A.outOfScope !== 'string' && !Array.isArray(A.outOfScope)) {
  throw new Error('outOfScope must be a string or an array of strings (got ' + typeof A.outOfScope + ')')
}
if (Array.isArray(A.outOfScope) && A.outOfScope.some((s) => typeof s !== 'string')) {
  throw new Error('outOfScope array elements must all be strings')
}
const OUT_OF_SCOPE_MAX_ITEMS = 20
const OUT_OF_SCOPE_MAX_CHARS = 300
const outOfScopeItems = [].concat(A.outOfScope ?? []).map((s) => String(s).trim()).filter(Boolean)
// Bounded so a scoping list cannot quietly grow into a list of everything the change gets wrong.
if (outOfScopeItems.length > OUT_OF_SCOPE_MAX_ITEMS) {
  throw new Error('outOfScope may list at most ' + OUT_OF_SCOPE_MAX_ITEMS + ' items (got ' + outOfScopeItems.length + ')')
}
// One item is one line: an embedded newline would smuggle extra bullets past the item-count cap.
const brokenItem = outOfScopeItems.findIndex((s) => /[\r\n]/.test(s))
if (brokenItem !== -1) {
  throw new Error('outOfScope items must be a single line (item ' + brokenItem + ' contains a line break)')
}
const longItem = outOfScopeItems.findIndex((s) => s.length > OUT_OF_SCOPE_MAX_CHARS)
if (longItem !== -1) {
  throw new Error('outOfScope items must be at most ' + OUT_OF_SCOPE_MAX_CHARS + ' characters (item ' + longItem + ' has ' + outOfScopeItems[longItem].length + ')')
}
const outOfScopeBlock = outOfScopeItems.length
  ? '\n\nKNOWN LIMITS OF THE UNDERLYING MECHANISM (out of scope: do NOT report these as defects of this change). Judge whether THIS change is correct GIVEN these limits; report one only if this change makes it newly reachable, newly silent, or worse than before:\n' + outOfScopeItems.map((s) => '- ' + s).join('\n')
  : ''
// Clean-up duty (a reviewer once left a registered worktree and a node_modules junction behind). Deleting THROUGH a
// junction deletes the real target, so the junction is removed with rmdir, never recursively, and BEFORE the worktree
// is removed (a forced remove has recursed through a junction and deleted the real node_modules). --force is
// forbidden because a plain `git worktree remove` already refuses on uncommitted or untracked changes, whatever
// node_modules holds; --force is what discards them.
const hygiene = '\n\nCLEAN UP before you finish. The worktree under review is ' + repo + ': NEVER run `git worktree remove` on the worktree under review, with or without --force, and leave it exactly as you found it. For any scratch git worktree YOU created: first remove ONLY a node_modules junction or symlink you created in it, with `cmd /c rmdir <your-scratch-path>\\node_modules` (NEVER rm -rf or any recursive delete through it, which follows the link and deletes the real node_modules), and leave a real node_modules directory alone; then run plain `git worktree remove <your-scratch-path>`. NEVER pass --force to git worktree remove: if it refuses because of uncommitted or untracked changes, STOP and report the path and what is uncommitted instead of forcing it. Delete any probe files you wrote outside the repo.'

const base =
  'You are a HOSTILE financial-systems reviewer for Oxford Realty Advisors (private family-office industrial real estate). BREAK the change below; do NOT bless it. This is NOI / capital-allocation / scoring code — a silent error mis-allocates real capital. Read the ACTUAL files at ' + repo + ' (use git diff for the uncommitted change). HARD CONSTRAINT (CLAUDE.md §9, applies in every checkout and worktree): NEVER open, query, or read the live warehouse or any other data/**/*.sqlite file (data/warehouse/finance.sqlite in particular) — not even read-only, not to "check the real data". To probe a trigger, build an in-memory database in a vitest/tsx script (better-sqlite3 :memory: + runMigrations) from source and migrations only. Set foundRealDefect=true ONLY for a CONCRETE, demonstrably-triggerable defect — not a style nit or a future wish; if you cannot construct a trigger, say so and lean false. ' + greenContext + hygiene + '\n\nCHANGE SET:\n' + changeSet + outOfScopeBlock + '\n\nYOUR LENS: '

// 2026-10-05: governor/financial-code invariant floor is Opus 5.5 (CLAUDE.md Dispatch line; Fable
// retired from dispatch). Opus is the canary-tested tier at the ~2-3-concurrent rate-limit ceiling
// (reference_lean_ram_toolkit.md); concurrency held at 3. The null-result fallback below only fires
// when a caller explicitly selects model:'fable' (agent() returns null on a terminal API failure)
// so that lens is retried on opus rather than silently dropped.
const verdicts = await parallel(
  lenses.map((l) => async () => {
    let v = await agent(base + l.focus, { label: 'refute:' + l.label, phase: 'Refute', model: primaryModel, schema: VERDICT, ...effortOpt })
    if (v === null && effectiveFallback) {
      log(`${primaryModel} call failed for lens "${l.label}" — ${effectiveFallback === primaryModel ? 'retrying once on' : 'falling back to'} ${effectiveFallback}.`)
      v = await agent(base + l.focus, { label: 'refute:' + l.label + ':' + effectiveFallback + '-fallback', phase: 'Refute', model: effectiveFallback, schema: VERDICT, ...effortOpt })
    }
    return v
  }),
)

const succeeded = verdicts.filter(Boolean)
const allFailed = succeeded.length === 0
// Only an explicit boolean false counts as "no defect": missing / null / 0 / '' / 'false' must fail closed.
const real = succeeded.filter((v) => v?.foundRealDefect !== false)
const order = { critical: 4, high: 3, medium: 2, low: 1, none: 0 }
// A severity outside the enum (or missing) ranks as critical: unknown must fail closed, never read as "none".
const rank = (s) => (typeof s === 'string' && Object.prototype.hasOwnProperty.call(order, s) ? order[s] : order.critical)
// Worst over BOTH the lens's self-reported maxSeverity and every finding's own severity: the schema does not tie the
// two together, so a lens could otherwise list a critical finding under maxSeverity 'low' and still attest clean.
const worst = succeeded.reduce(
  // A non-array `findings` (missing, null, an object) is malformed output: it ranks as critical, like an unknown
  // severity, so it can never read as clean.
  (m, v) => Math.max(m, rank(v.maxSeverity), ...(Array.isArray(v.findings) ? v.findings.map((f) => rank(f?.severity)) : [order.critical])),
  0,
)

if (allFailed) {
  log(`All ${lenses.length} lenses failed (${primaryModel}${effectiveFallback ? ' and ' + effectiveFallback + ' fallback' : ''} unavailable) — this is a TOOLING FAILURE, not a clean result. Do not report CLEAN.`)
} else {
  log(real.length
    ? `${real.length}/${succeeded.length} lenses found a real defect; worst severity rank ${worst}. Fix before commit.`
    : !coversDefaultLenses
      ? `No real defect in ${succeeded.length}/${lenses.length} lenses, but the custom lens set (${lenses.map((l) => l.label).join(', ')}) does not include every default lens verbatim — NOT clean; do not record a bare Refute-Reviewed id.`
      : succeeded.length < lenses.length
      ? `No real defect in ${succeeded.length}/${lenses.length} lenses, but ${lenses.length - succeeded.length} lens(es) FAILED even after retry — PARTIAL coverage; do not treat as a full clean pass.`
      : worst >= order.medium
        ? `No lens set foundRealDefect, but worst severity rank ${worst} is medium or higher — NOT clean. Report to the owner before another round (FINDING-SEVERITY LOOP RULE); do not record a bare Refute-Reviewed id.`
        : `No real defect across ${succeeded.length}/${lenses.length} lenses. Clear to commit (still confirm the gate).`)
}
if (outOfScopeItems.length) log(`SCOPED run: ${outOfScopeItems.length} item(s) were out of scope for every lens; cite it as wf_<id> (scoped).`)

return {
  verdicts, anyRealDefect: real.length > 0, worstSeverityRank: worst, succeeded: succeeded.length, allFailed,
  lensCount: lenses.length,
  clean: succeeded.length === lenses.length && real.length === 0 && worst < order.medium && coversDefaultLenses,
  lensesDefault, lensLabels: lenses.map((l) => l.label),
  outOfScope: outOfScopeItems, scoped: outOfScopeItems.length > 0,
  repo,
  changeSetSha256: changeSetAudit.sha, changeSetLength: changeSetAudit.len,
  greenContextSha256: greenContextAudit.sha, greenContextLength: greenContextAudit.len,
  models: { primary: primaryModel, fallback: effectiveFallback },
  effort: A.effort ?? null,
  modelFloorMet: TIERS.includes(primaryModel),
}
