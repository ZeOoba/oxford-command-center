// src/primitives/PlaceholderBanner.tsx
//
// Amber advisory banner for surfaces running on placeholder fixture data
// (server/warehouse/placeholders/*). Rendered whenever a report's dataSource
// discriminator is 'placeholder' — see docs/placeholder-data.md. Figures under
// this banner are never decision-grade.

export function PlaceholderBanner({ detail, label = 'PLACEHOLDER DATA' }: { detail: string; label?: string }) {
  return (
    <div
      role="status"
      style={{
        background: 'color-mix(in oklab, var(--color-warn) 14%, transparent)',
        border: '1px solid color-mix(in oklab, var(--color-warn) 45%, transparent)',
        borderRadius: 8,
        padding: '8px 12px',
        marginBottom: 12,
        fontSize: 13,
        color: 'var(--text-primary)',
      }}
    >
      <strong style={{ color: 'var(--color-warn)', marginRight: 8 }}>{label}</strong>
      {detail}
    </div>
  );
}
