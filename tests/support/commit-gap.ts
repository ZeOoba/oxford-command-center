// tests/support/commit-gap.ts
//
// Simulates a second writer landing in the gap right after a write becomes durable (merge gate PR #591,
// R-3 and R2-1). The returned connection behaves exactly like `db`, except that `after()` runs ONCE, at
// the first of:
//   - the first top-level `db.transaction(...)` call committing (nested savepoints never fire it), or
//   - when `autocommit` is given, a prepared statement whose SQL matches it finishing `run()` OUTSIDE any
//     transaction (an autocommitted write is durable the moment it returns).
import type { WarehouseDb } from '../../server/warehouse/db';

export function withCommitGap(db: WarehouseDb, after: () => void, opts: { autocommit?: RegExp } = {}): WarehouseDb {
  let fired = false;
  const fire = () => { if (!fired) { fired = true; after(); } };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (fn: (...a: unknown[]) => unknown) => {
          const tx = target.transaction(fn);
          const wrap = (variant: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
            const top = !target.inTransaction;
            const out = variant(...a);
            if (top) fire();
            return out;
          };
          return Object.assign(wrap(tx), {
            deferred: wrap(tx.deferred), immediate: wrap(tx.immediate), exclusive: wrap(tx.exclusive),
          });
        };
      }
      if (prop === 'prepare' && opts.autocommit) {
        // Without g / y: a stateful lastIndex would make the match depend on earlier prepares.
        const re = new RegExp(opts.autocommit.source, opts.autocommit.flags.replace(/[gy]/g, ''));
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!re.test(sql)) return stmt;
          return new Proxy(stmt, {
            get(s, p) {
              if (p === 'run') {
                return (...a: unknown[]) => {
                  const out = (s.run as (...x: unknown[]) => unknown)(...a);
                  if (!target.inTransaction) fire();
                  return out;
                };
              }
              const v = Reflect.get(s, p, s) as unknown;
              return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(s) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
}
