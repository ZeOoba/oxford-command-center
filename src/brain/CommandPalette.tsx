import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Command } from 'cmdk';
import { RefreshCw, Moon, Sun, CornerDownLeft, Download } from 'lucide-react';
import { useSnapshot } from '@/data/queries';
import { useBrain } from '@/data/brain-context';
import { MODULES } from '@/shell/modules';
import { applyTheme } from '@/lib/theme';
import { downloadCsv } from '@/lib/export';
import { governorFieldValue } from '@analytics/governor-inputs'; // blank workbook cell exports empty, never 0 (audit 2026-11-12 HIGH #2)
import { useUi } from './ui-context';
import { buildEntityItems, type EntityItem } from './searchIndex';

const ENTITY_GROUPS: EntityItem['group'][] = ['Deals', 'Properties', 'Tenants', 'Loans', 'Insurance', 'Cash'];

export function CommandPalette() {
  const ui = useUi();
  const { data } = useSnapshot();
  const { refresh } = useBrain();
  const items = useMemo(() => (data ? buildEntityItems(data.snapshot) : []), [data]);

  useEffect(() => {
    if (!ui.paletteOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        ui.closePalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui]);

  const setTheme = applyTheme;

  return (
    <AnimatePresence>
      {ui.paletteOpen && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Command palette">
          <motion.div
            className="absolute inset-0"
            style={{ background: 'rgba(2,4,8,0.62)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={ui.closePalette}
          />
          <div className="absolute left-1/2 top-[13vh] w-[min(640px,92vw)] -translate-x-1/2">
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              <Command label="Command palette" loop className="ora-cmdk">
                <Command.Input autoFocus placeholder="Search deals, properties, tenants, loans — or run a command…" />
                <Command.List>
                  <Command.Empty>No matches.</Command.Empty>

                  <Command.Group heading="Navigate">
                    {MODULES.map((m) => {
                      const Icon = m.icon;
                      return (
                        <Command.Item
                          key={m.id}
                          value={`go ${m.label} ${m.group}`}
                          onSelect={() => {
                            ui.setActiveModule(m.id);
                            ui.closePalette();
                          }}
                        >
                          <Icon size={15} style={{ color: 'var(--accent)' }} />
                          <span style={{ color: 'inherit' }}>Go to {m.label}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>

                  {/* "Destination > Tab" — the safety valve for every module absorbed into a destination:
                      each stays findable by its legacy name (tab label + aliases). */}
                  <Command.Group heading="Tabs">
                    {MODULES.flatMap((m) =>
                      (m.tabs ?? []).map((t) => (
                        <Command.Item
                          key={`${m.id}:${t.id}`}
                          value={`go ${m.label} ${t.label} ${(t.aliases ?? []).join(' ')} tab`}
                          onSelect={() => {
                            ui.openTab(m.id, t.id);
                            ui.closePalette();
                          }}
                        >
                          <m.icon size={15} style={{ color: 'var(--accent)' }} />
                          <span style={{ color: 'inherit' }}>{m.label} &rsaquo; {t.label}</span>
                        </Command.Item>
                      )),
                    )}
                  </Command.Group>

                  <Command.Group heading="Actions">
                    <Command.Item value="refresh data reload workbook" onSelect={() => { refresh(); ui.closePalette(); }}>
                      <RefreshCw size={15} style={{ color: 'var(--accent)' }} />
                      Refresh data from workbook
                    </Command.Item>
                    <Command.Item value="dark theme command mode" onSelect={() => { setTheme('command'); ui.closePalette(); }}>
                      <Moon size={15} style={{ color: 'var(--accent)' }} />
                      Switch to dark (Command)
                    </Command.Item>
                    <Command.Item value="light theme parchment mode" onSelect={() => { setTheme('parchment'); ui.closePalette(); }}>
                      <Sun size={15} style={{ color: 'var(--accent)' }} />
                      Switch to light (Parchment)
                    </Command.Item>
                  </Command.Group>

                  {data && (
                    <Command.Group heading="Export">
                      <Command.Item
                        value="export properties csv portfolio"
                        onSelect={() => {
                          downloadCsv('ora-properties.csv', data.snapshot.properties.map((p) => ({ name: p.name, market: p.market, type: p.type, sf: p.sf, occPct: p.occPct, noi: governorFieldValue(p, 'noi'), capRate: p.capRate, dscr: p.dscr, oxfordValue: p.oxfordValue, loanBalance: governorFieldValue(p, 'loanBalance'), ltv: p.ltv, lender: p.lender })));
                          ui.closePalette();
                        }}
                      >
                        <Download size={15} style={{ color: 'var(--accent)' }} />
                        Export — Properties (CSV)
                      </Command.Item>
                      <Command.Item
                        value="export rent roll leases tenants csv"
                        onSelect={() => {
                          downloadCsv('ora-rent-roll.csv', data.snapshot.leases.map((l) => ({ property: l.propertyKey, unit: l.unit, tenant: l.tenantName, company: l.company, sf: l.sf, monthlyRent: l.monthlyRent, annualRent: l.annualRent, rentPerSf: l.rentPerSf, leaseStart: l.leaseStart, leaseEnd: l.leaseEnd, escalationPct: l.escalationPct, status: l.status })));
                          ui.closePalette();
                        }}
                      >
                        <Download size={15} style={{ color: 'var(--accent)' }} />
                        Export — Rent Roll (CSV)
                      </Command.Item>
                      <Command.Item
                        value="export loans debt csv"
                        onSelect={() => {
                          downloadCsv('ora-loans.csv', data.snapshot.loans.map((l) => ({ name: l.name, direction: l.direction, counterparty: l.counterparty, currentBalance: l.currentBalance, rate: l.rate, monthlyPmt: l.monthlyPmt, maturity: l.maturity, monthsToMaturity: l.monthsToMaturity, ltv: l.ltv, balloon: l.balloon, status: l.status })));
                          ui.closePalette();
                        }}
                      >
                        <Download size={15} style={{ color: 'var(--accent)' }} />
                        Export — Loans (CSV)
                      </Command.Item>
                    </Command.Group>
                  )}

                  {ENTITY_GROUPS.map((g) => {
                    const groupItems = items.filter((i) => i.group === g);
                    if (!groupItems.length) return null;
                    return (
                      <Command.Group key={g} heading={g}>
                        {groupItems.map((i) => (
                          <Command.Item
                            key={`${i.ref.type}-${i.ref.id}`}
                            value={`${i.value} ${i.ref.id}`}
                            onSelect={() => {
                              ui.openEntity(i.ref);
                              ui.closePalette();
                            }}
                          >
                            <CornerDownLeft size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                            <span className="truncate" style={{ color: 'inherit' }}>{i.title}</span>
                            <span className="cmdk-sub num ml-auto shrink-0 truncate pl-3 text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: '55%' }}>
                              {i.subtitle}
                            </span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    );
                  })}
                </Command.List>
              </Command>
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>
  );
}
