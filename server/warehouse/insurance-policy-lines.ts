/**
 * Policy-line classification by policy_type text — pure, no imports, so both the insurance
 * analysis engine (rate-benchmark cohort) and the loss engine (which must not import calibration
 * via insurance-analysis.ts) share ONE keyword rule instead of drifting apart.
 */

/** A first-party property line: the property/package/building keyword test. TIV-independent —
 *  the TIV gate belongs to the rate benchmark (classifyCohort), not to what a policy IS. */
export function isPropertyLinePolicyType(policyType: string | null): boolean {
  if (policyType === null) return false;
  const t = policyType.toLowerCase();
  return t.includes('property') || t.includes('package') || t.includes('building');
}

/** A tenant's evidence-of-insurance certificate on file (ACORD 25/28) — not an ORA policy. Its
 *  deductible is the tenant's retention, never ORA's, so it takes no loss attachment or deductible
 *  review. It still counts as coverage "on file" for the insurance-gap alert (Gabriel, 2026-09-24:
 *  NNN single-tenant buildings are insured by the tenant). */
export function isTenantEvidenceCertificate(policyType: string | null): boolean {
  if (policyType === null) return false;
  return /\bevidence of\b|\bacord\b/i.test(policyType);
}

/** Unambiguous third-party wording — never a first-party property claim, whatever peril it
 *  describes ('Slip and fall on ice', 'Bodily injury from roof collapse', 'Fire liability suit').
 *  The slip/trip-and-fall connector repeats so 'slip-and-fall' and 'slip & fall' both match; a bare
 *  'slip' ('slip joint failure') does not. */
const STRONG_THIRD_PARTY = /\bbodily injury\b|\bpersonal injury\b|\b(?:slip|trip)(?:\s*(?:and|&|\/|-)\s*)*\s*fall\b|\bepli\b|\bemployment practices\b|\bwrongful termination\b|\b(?:law)?suit\b|\bclaimant\b/i;

/** Bare liability wording — third-party only when no first-party peril is named. */
const WEAK_THIRD_PARTY = /\bliabilit(?:y|ies)\b/i;

/** Named first-party property perils. They outrank WEAK wording only ('Water damage from tenant
 *  liability dispute', 'Property liability - water backup' stay first-party). */
const FIRST_PARTY_PERIL = /\b(?:water|wind|hail|fire|smoke|theft|burglary|vandal\w*|roof|pipe|freeze|frozen|flood|lightning|collapse|storm|snow|ice|mold|sewer|backup|electrical)\b/i;

/** A loss-run cause that is a THIRD-PARTY claim. A property deductible never applies to one, so
 *  such an event stays EAL-only — even when its policy_ref is a bundled BOP number shared by the
 *  property line and the liability lines (live: Hartford '37 SBA CB6KKB' spans property, GL,
 *  umbrella and EPLI at 9620 Raytown). Two tiers (refute wf_a4ae3c23-a46): STRONG wording always
 *  wins; bare 'liability' yields to a named peril. An unrecognised or null cause is first-party. */
export function isThirdPartyLossCause(cause: string | null): boolean {
  if (cause === null) return false;
  if (STRONG_THIRD_PARTY.test(cause)) return true;
  return WEAK_THIRD_PARTY.test(cause) && !FIRST_PARTY_PERIL.test(cause);
}

