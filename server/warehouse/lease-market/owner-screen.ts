// server/warehouse/lease-market/owner-screen.ts
//
// Lease Market Intelligence — owner screening via county-parcel-screen's institutional_owners.py
// (the canonical ORA institutional / never-call alias table; ported by bridge, never re-implemented,
// so the two screens cannot drift). Fail-closed: any failure => available:false => candidates withheld.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { OwnerType } from '../../../src/contracts/lease-market';

export interface OwnerScreenResult {
  available: boolean;
  guardOk: boolean;
  types: Map<string, OwnerType>;
  error: string | null;
}

export type OwnerScreenRunner = (modulePath: string, names: string[]) => unknown;

const BridgeOutput = z.object({ guardOk: z.boolean(), types: z.record(z.string(), OwnerType) });

export const pythonOwnerScreenRunner: OwnerScreenRunner = (modulePath, names) => {
  const script = join(process.cwd(), 'scripts', 'lease-market-owner-screen.py');
  const stdout = execFileSync(process.env.PYTHON ?? 'python', [script, modulePath], {
    input: JSON.stringify(names),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return JSON.parse(stdout) as unknown;
};

export function screenOwners(
  names: readonly string[],
  modulePath: string,
  runner: OwnerScreenRunner = pythonOwnerScreenRunner,
): OwnerScreenResult {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return { available: true, guardOk: true, types: new Map(), error: null };
  const allUnknown = () => new Map<string, OwnerType>(unique.map((n) => [n, 'unknown']));
  try {
    const parsed = BridgeOutput.parse(runner(modulePath, unique));
    const types = new Map<string, OwnerType>();
    for (const n of unique) types.set(n, parsed.types[n] ?? 'unknown');
    return {
      available: parsed.guardOk,
      guardOk: parsed.guardOk,
      types,
      error: parsed.guardOk ? null : 'never-call guard file unreadable (screen degraded to ORA-self only)',
    };
  } catch (e) {
    const message = e instanceof Error ? (e.message.split('\n')[0] ?? 'owner screen failed') : 'owner screen failed';
    return { available: false, guardOk: false, types: allUnknown(), error: message };
  }
}
