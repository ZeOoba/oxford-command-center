// src/primitives/EmptyState.tsx — a loaded-but-empty module body: what is missing and the command that fills it.
import { Card, CardHeader } from './Card';
import { Badge } from './Badge';

export interface EmptyStateProps {
  title: string;
  message: string;
  detail?: string;
  command?: string;
}

export function EmptyState({ title, message, detail, command }: EmptyStateProps) {
  return (
    <Card>
      <CardHeader title={title} trailing={<Badge tone="neutral">no data</Badge>} />
      <div role="status" className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{message}</div>
        {detail && <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 460 }}>{detail}</div>}
        {command && <code className="num text-2xs" style={{ color: 'var(--text-primary)' }}>{command}</code>}
      </div>
    </Card>
  );
}
