import { Skeleton } from '@/primitives/Skeleton';
import { Button } from '@/primitives/Button';

export function ModuleLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 96 }} />
        ))}
      </div>
      <Skeleton style={{ height: 320 }} />
    </div>
  );
}

export function ModuleError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div role="alert" className="grid place-items-center gap-3 py-24 text-center">
      <div className="text-sm font-semibold" style={{ color: 'var(--text-neg)' }}>
        Can't reach the Brain Server (:8911).
      </div>
      {message && (
        <div className="num max-w-lg text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {message}
        </div>
      )}
      <Button variant="subtle" onPress={onRetry}>
        Retry
      </Button>
    </div>
  );
}
