// src/modules/intel/MappingsView.tsx
//
// The manual-ruling surface: append a mapping override (match_kind='manual', which beats
// the seed per resolveMapping precedence) and re-derive the ACTIVE ledger rows whose
// account key matches (+ optional property scope). The form is the only place a human
// hand-classifies an account outside the approve loop.
import { useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { useAddMapping, useWarehouseLive, type ImportSummary } from './hooks';
import { CategorySelect, ClassificationSelect, SectionLabel } from './ImportsView';
import type { Classification } from '@contracts/warehouse';

/** Distinct properties drawn from the imports list — the optional override scope picker. */
function distinctProperties(imports: ImportSummary[]): Array<{ id: string; name: string }> {
  const map = new Map<string, string>();
  for (const i of imports) {
    if (i.propertyId) map.set(i.propertyId, i.propertyName ?? i.propertyId);
  }
  return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function MappingsView({ imports }: { imports: ImportSummary[] }) {
  const addMapping = useAddMapping();
  // Adding a mapping override is a server WRITE; on the baked mirror it has no edge home (Phase 1b).
  const live = useWarehouseLive();
  const properties = distinctProperties(imports);

  const [account, setAccount] = useState('');
  const [category, setCategory] = useState<string>('Repairs & Maintenance');
  const [classification, setClassification] = useState<Classification>('opex');
  const [propertyId, setPropertyId] = useState<string>('');
  const [lastResult, setLastResult] = useState<{ rederived: number } | null>(null);

  const canSubmit = account.trim().length > 0 && !addMapping.isPending;

  const submit = () => {
    if (!canSubmit) return;
    setLastResult(null);
    addMapping.mutate(
      {
        account: account.trim(),
        normalizedCategory: category,
        classification,
        ...(propertyId ? { propertyId } : {}),
      },
      {
        onSuccess: (res) => {
          setLastResult({ rederived: res.rederived });
          setAccount('');
        },
      },
    );
  };

  // The baked mirror is read-only: the entire mapping-override surface is a write, so replace it with
  // an honest note rather than a form that cannot submit.
  if (!live) {
    return (
      <Card>
        <CardHeader title="Mapping Overrides" trailing={<Badge tone="neutral">read-only</Badge>} />
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          Mapping overrides are a workstation-only action. This deployed mirror is read-only — open the
          command center on the local machine to add or change a mapping.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Mapping Overrides"
        trailing={<Badge tone="gold">manual rulings</Badge>}
      />
      <div className="flex flex-col gap-4 p-4">
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)', maxWidth: 640 }}>
          A manual override beats the seed mapping for an account and immediately re-derives every active
          ledger row whose account key matches. Scope it to a single property when a chart name means
          different things across entities; leave it global otherwise.
        </p>

        <div>
          <SectionLabel>Add override</SectionLabel>
          <div className="flex flex-col gap-3" style={{ maxWidth: 640 }}>
            <div className="flex flex-col gap-1">
              <label htmlFor="map-account" className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Account name</label>
              <input
                id="map-account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="e.g. HVAC Repair"
                className="h-9 rounded-[var(--radius-sm)] px-3 text-sm outline-none"
                style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
              />
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Category</span>
                <CategorySelect value={category} onChange={setCategory} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Classification</span>
                <ClassificationSelect value={classification} onChange={setClassification} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>Property scope</span>
                <select
                  value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}
                  aria-label="Property scope"
                  className="h-7 rounded-[var(--radius-sm)] px-2 text-xs outline-none"
                  style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                >
                  <option value="">All properties (global)</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <Button variant="primary" size="md" onPress={submit} isDisabled={!canSubmit}>Add mapping</Button>
            </div>

            {addMapping.isError && (
              <span className="text-2xs" style={{ color: 'var(--text-neg)' }}>
                {addMapping.error instanceof Error ? addMapping.error.message : 'Add mapping failed'}
              </span>
            )}
            {lastResult && (
              <span className="text-2xs" style={{ color: 'var(--text-pos)' }}>
                Override saved — {lastResult.rederived} active ledger row{lastResult.rederived === 1 ? '' : 's'} re-derived.
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
