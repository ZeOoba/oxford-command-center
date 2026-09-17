// server/warehouse/lease-market/owner-screen.ts
//
// Lease Market Intelligence — owner screening via county-parcel-screen's institutional_owners.py
// (the canonical ORA institutional / never-call alias table; ported by bridge, never re-implemented,
// so the two screens cannot drift). Fail-closed: any failure => available:false => candidates withheld.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { OwnerType } from '../../../src/contracts/lease-market';

export interface OwnerScreenResult {
  available: boolean;
  guardOk: boolean;
  types: Map<string, OwnerType>;
  error: string | null;
}

export type OwnerScreenRunner = (modulePath: string, names: string[]) => unknown;

const BridgeOutput = z.object({ guardOk: z.boolean(), types: z.record(z.string(), OwnerType) });

// Resolved from this module's own file location, never process.cwd() -- the bridge must work
// identically regardless of which directory the caller was launched from. Deliberately NOT
// `new URL('...', import.meta.url)` -- Vite statically rewrites that literal pattern into a
// dev-server asset URL (http://localhost:...), which breaks under Vitest/SSR. `dirname` +
// `join` on the plain fileURLToPath'd path (the pattern already used by server/warehouse/migrate.ts)
// avoids that rewrite.
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'lease-market-owner-screen.py');

export const pythonOwnerScreenRunner: OwnerScreenRunner = (modulePath, names) => {
  if (!existsSync(SCRIPT_PATH)) throw new Error('owner screen bridge script not found');
  const stdout = execFileSync(process.env.PYTHON ?? 'python', [SCRIPT_PATH, modulePath], {
    input: JSON.stringify(names),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe'], // never let child stderr reach parent logs
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
    if (e instanceof ZodError) {
      return { available: false, guardOk: false, types: allUnknown(), error: 'owner screen returned invalid output' };
    }
    const message = e instanceof Error ? (e.message.split('\n')[0] ?? 'owner screen failed') : 'owner screen failed';
    return { available: false, guardOk: false, types: allUnknown(), error: message };
  }
}
