// scripts/lib/mirror-mode.ts
//
// Which mirror bake may run: REDACTED (public-safe, the default) or FULL (confidential deals
// included, for an Access-gated target only). Shared by scripts/bake-mirror.ts and
// scripts/scan-mirror-dist.ts so both decide the mode the same way. Deliberately dependency-light.
//
// Audit wf_9bf74429-aaf finding 31: MIRROR_INCLUDE_CONFIDENTIAL could come from `.env`, so a manual
// `npm run deploy:mirror` shipped the FULL bake with no Access probe at all. Now:
//   - the flag is read only from the real process environment (server/load-env.ts never fills
//     PROCESS_ENV_ONLY_KEYS from `.env`, and the deploy script's .env import skips them too);
//   - FULL mode also requires MIRROR_ACCESS_PREPROBE=passed, which only scripts/deploy-mirror.ps1
//     sets, and only after its pre-deploy Access probe of the production target passed (finding 4).
// A FULL request without that attestation is REFUSED, never silently downgraded: the caller asked
// for something specific, and a quiet redacted bake would hide the misconfiguration.

/** The value scripts/deploy-mirror.ps1 writes to MIRROR_ACCESS_PREPROBE once its pre-deploy probe passed. */
export const ACCESS_PREPROBE_PASSED = 'passed';

export interface MirrorMode {
  includeConfidential: boolean;
  /** Non-null when the requested mode may not run; the caller must exit non-zero with nothing written. */
  refusal: string | null;
}

export function resolveMirrorMode(env: Record<string, string | undefined>): MirrorMode {
  const flag = env.MIRROR_INCLUDE_CONFIDENTIAL;
  if (flag === undefined || flag === '' || flag === '0') return { includeConfidential: false, refusal: null };
  if (flag !== '1') {
    return {
      includeConfidential: false,
      refusal: `✗ mirror: MIRROR_INCLUDE_CONFIDENTIAL must be unset, '0' or '1' (got a different value) — refusing rather than guessing the bake mode.`,
    };
  }
  if (env.MIRROR_ACCESS_PREPROBE !== ACCESS_PREPROBE_PASSED) {
    return {
      includeConfidential: false,
      refusal:
        `✗ mirror: refusing the FULL (confidential) bake — MIRROR_INCLUDE_CONFIDENTIAL=1 is honoured only ` +
        `from scripts/deploy-mirror.ps1 after its pre-deploy Cloudflare Access probe passed ` +
        `(MIRROR_ACCESS_PREPROBE=${ACCESS_PREPROBE_PASSED}). Unset MIRROR_INCLUDE_CONFIDENTIAL for a ` +
        `public-safe (redacted) bake.`,
    };
  }
  return { includeConfidential: true, refusal: null };
}
