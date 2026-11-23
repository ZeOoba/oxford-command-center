// tests/support/commit-gap.ts
//
// Simulates a second writer landing in the gap right after a transaction commits (merge gate PR #591, R-3).
// The returned connection behaves exactly like `db`, except that the FIRST top-level `db.transaction(...)`
// call runs `after()` immediately after it commits. Nested (savepoint) transactions never fire it.
import type { WarehouseDb } from '../../server/warehouse/db';

export function withCommitGap(db: WarehouseDb, after: () => void): WarehouseDb {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (fn: (...a: unknown[]) => unknown) => {
          const tx = target.transaction(fn);
          return (...a: unknown[]) => {
            const top = !target.inTransaction;
            const out = tx(...a);
            if (top && !fired) { fired = true; after(); }
            return out;
          };
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
}
