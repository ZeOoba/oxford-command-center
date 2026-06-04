import { useViewProfile, type ViewProfile } from '@/brain/view-profile';

const OPTIONS: { id: ViewProfile; label: string }[] = [
  { id: 'acquisitions', label: 'Acquisitions' },
  { id: 'principal', label: 'Principal' },
];

export function ViewToggle() {
  const { profile, setProfile } = useViewProfile();
  return (
    <div className="hidden items-center rounded-full p-0.5 sm:inline-flex" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      {OPTIONS.map((o) => {
        const active = o.id === profile;
        return (
          <button
            key={o.id}
            onClick={() => setProfile(o.id)}
            aria-pressed={active}
            className="num rounded-full px-2.5 py-1 text-2xs font-semibold transition-colors"
            style={active
              ? { background: 'var(--accent-quiet)', color: 'var(--accent)' }
              : { background: 'transparent', color: 'var(--text-tertiary)' }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
