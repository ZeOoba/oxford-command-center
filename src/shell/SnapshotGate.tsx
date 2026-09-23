import type { ReactElement } from 'react';
import { useSnapshot } from '@/data/queries';
import { ModuleError, ModuleLoading } from './ModuleFallback';

/**
 * Loading/error gate for snapshot-backed modules. Destination's <Suspense> only covers the lazy JS
 * chunk, not the data fetch — before this, eight modules rendered a blank page whenever the Brain
 * Server was slow or down (2026-09-23 review). Call unconditionally at the top of the component.
 */
export function useSnapshotGate(): ReactElement | null {
  const q = useSnapshot();
  if (q.isLoading) return <ModuleLoading />;
  if (q.isError && !q.data) {
    return <ModuleError onRetry={() => void q.refetch()} message={q.error instanceof Error ? q.error.message : undefined} />;
  }
  return null;
}
