/**
 * "Still mode" (?still=1) freezes perpetual animations (live pulses, shimmers)
 * so automated screenshots capture deterministically. No effect on normal use.
 */
export function isStill(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('still');
}
