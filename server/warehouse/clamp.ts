/**
 * Clamps a value between a minimum and maximum.
 * @param value The value to clamp
 * @param min The minimum bound (inclusive)
 * @param max The maximum bound (inclusive)
 * @returns The clamped value
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
