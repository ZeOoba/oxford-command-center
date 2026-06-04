import { motion } from 'framer-motion';
import { useState } from 'react';
import { RefreshCw, Search, Sparkles, Menu, MoreHorizontal } from 'lucide-react';
import { fmtDate } from '@analytics/index';
import { useBrain } from '@/data/brain-context';
import { useUi } from '@/brain/ui-context';
import { StatusPill } from '@/primitives/StatusPill';
import { ScenarioSwitch } from './ScenarioSwitch';
import { ViewToggle } from './ViewToggle';
import { ThemeToggle } from './ThemeToggle';
import { DensityToggle } from './DensityToggle';

export function TopBar({ title, asOf, onOpenSearch, onOpenNav, navOpen }: { title: string; asOf: string; onOpenSearch?: () => void; onOpenNav?: () => void; navOpen?: boolean }) {
  const { refresh, refreshing } = useBrain();
  const ui = useUi();
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between gap-4 px-5"
      style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-base)' }}
    >
      <button
        onClick={onOpenNav}
        aria-label="Open navigation"
        aria-expanded={navOpen}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] lg:hidden"
        style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        <Menu size={16} />
      </button>
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="display truncate text-lg leading-none" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h1>
        {asOf && (
          <span className="num hidden whitespace-nowrap text-2xs uppercase lg:inline" style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
            As of {fmtDate(asOf)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        <button
          onClick={onOpenSearch}
          className="hidden items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-2xs md:flex"
          style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
        >
          <Search size={13} />
          <span>Search…</span>
          <kbd className="num rounded px-1" style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }}>⌘K</kbd>
        </button>

        <button
          onClick={ui.toggleAi}
          className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-2xs font-semibold transition-colors"
          style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
        >
          <Sparkles size={13} />
          <span className="hidden sm:inline">Ask</span>
        </button>

        <ViewToggle />
        <div className="hidden lg:contents"><ScenarioSwitch /></div>
        <StatusPill />

        <button
          onClick={refresh}
          aria-label="Refresh data"
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]"
          style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <motion.span
            animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={refreshing ? { duration: 0.9, repeat: Infinity, ease: 'linear' } : { duration: 0.2 }}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <RefreshCw size={14} />
          </motion.span>
        </button>

        <div className="hidden lg:contents">
          <DensityToggle />
          <ThemeToggle />
        </div>

        <div className="relative lg:hidden">
          <button
            onClick={() => setMoreOpen((o) => !o)}
            aria-label="More controls"
            aria-expanded={moreOpen}
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]"
            style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <MoreHorizontal size={16} />
          </button>
          {moreOpen && (
            <>
              <button aria-hidden tabIndex={-1} className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
              <div
                className="absolute right-0 top-10 z-40 flex flex-col gap-2 rounded-[var(--radius-md)] p-3"
                style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}
              >
                <ScenarioSwitch />
                <div className="flex items-center gap-2.5">
                  <DensityToggle />
                  <ThemeToggle />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
