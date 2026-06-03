export type ClassValue = string | number | false | null | undefined;

/** Minimal class joiner (truthy values only). */
export function cn(...args: ClassValue[]): string {
  return args.filter(Boolean).join(' ');
}
