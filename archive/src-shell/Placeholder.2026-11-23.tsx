import type { LucideIcon } from 'lucide-react';

export function Placeholder({ title, icon: Icon, note }: { title: string; icon: LucideIcon; note?: string }) {
  return (
    <div className="grid place-items-center py-28 text-center">
      <div
        className="mb-4 grid h-14 w-14 place-items-center rounded-[var(--radius-lg)]"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--accent)' }}
      >
        <Icon size={24} />
      </div>
      <h2 className="display text-xl" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      <p className="num mt-2 text-2xs uppercase" style={{ letterSpacing: '0.18em', color: 'var(--text-tertiary)' }}>
        {note ?? 'On the build roadmap'}
      </p>
    </div>
  );
}
