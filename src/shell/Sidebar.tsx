import { motion } from 'framer-motion';
import { PanelLeftClose, PanelLeft } from 'lucide-react';
import { type ModuleDef } from './modules';
import { orderedModules } from './module-order';
import { useViewProfile } from '@/brain/view-profile';
import { cn } from '@/lib/cn';

interface Props {
  activeId: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ activeId, onSelect, collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { profile } = useViewProfile();
  const ordered = orderedModules(profile);
  const groups = [...new Set(ordered.map((m) => m.group))];
  const width = collapsed ? 60 : 212;
  const handleSelect = (id: string) => {
    onSelect(id);
    onMobileClose();
  };
  return (
    <>
      {mobileOpen && (
        <button
          aria-label="Close navigation"
          onClick={onMobileClose}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}
      <motion.aside
        animate={{ width }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          'z-40 flex h-dvh flex-col lg:relative lg:z-20 lg:translate-x-0',
          'fixed inset-y-0 left-0 transition-transform duration-200',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        style={{ background: 'var(--surface-rail)', borderRight: '1px solid var(--border-subtle)' }}
      >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2.5 px-3.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-sm font-bold"
          style={{ background: 'var(--accent)', color: 'var(--text-on-accent)', fontFamily: 'var(--font-display)' }}
        >
          O
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="display text-sm leading-tight" style={{ color: 'var(--text-primary)' }}>
              Oxford
            </div>
            <div className="num text-[8px] uppercase leading-tight" style={{ letterSpacing: '0.22em', color: 'var(--text-tertiary)' }}>
              Command Center
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group) => {
          const items = ordered.filter((m) => m.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="mb-3">
              {!collapsed && (
                <div className="num px-2 pb-1.5 text-[9px] font-semibold uppercase" style={{ letterSpacing: '0.16em', color: 'var(--text-tertiary)' }}>
                  {group}
                </div>
              )}
              <ul className="flex flex-col gap-0.5">
                {items.map((m) => (
                  <NavItem key={m.id} module={m} active={m.id === activeId} collapsed={collapsed} onSelect={() => handleSelect(m.id)} />
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="hidden h-11 items-center gap-2.5 px-4 text-xs transition-colors lg:flex"
        style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
      >
        {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        {!collapsed && <span className="num text-2xs uppercase" style={{ letterSpacing: '0.1em' }}>Collapse</span>}
      </button>
      </motion.aside>
    </>
  );
}

function NavItem({ module, active, collapsed, onSelect }: { module: ModuleDef; active: boolean; collapsed: boolean; onSelect: () => void }) {
  const Icon = module.icon;
  return (
    <li className="relative">
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-[var(--radius-sm)]"
          style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)' }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
      <button
        onClick={onSelect}
        title={collapsed ? module.label : undefined}
        className={cn('relative z-10 flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm transition-colors')}
        style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
      >
        <Icon size={17} style={{ color: active ? 'var(--accent)' : 'currentColor', flexShrink: 0 }} />
        {!collapsed && <span className="truncate font-medium">{module.label}</span>}
      </button>
    </li>
  );
}
