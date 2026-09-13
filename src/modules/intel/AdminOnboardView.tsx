// src/modules/intel/AdminOnboardView.tsx
//
// Phase 5 W4 — minimal "Onboard property" admin panel.
// POSTs to POST /api/warehouse/properties/onboard; shows ok/error inline.
import React, { useState } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { Button } from '@/primitives/Button';
import { ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';

interface OnboardResult { ok: boolean; propertyId?: string; error?: string }

const PM_SYSTEMS = [
  { value: 'quickbooks', label: 'QuickBooks' },
  { value: 'yardi', label: 'Yardi' },
  { value: 'appfolio', label: 'AppFolio' },
  { value: 'rent-manager', label: 'Rent Manager' },
] as const;

const AUTH_SOURCES = [
  { value: 'pm-exports', label: 'PM Exports' },
  { value: 'internal-quickbooks', label: 'Internal QuickBooks' },
  { value: 'workbook-only', label: 'Workbook Only' },
] as const;

export function AdminOnboardView() {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [sfTotal, setSfTotal] = useState('');
  // Ownership % (2026-08-24, PR #302 review): PropertyOnboardingInputSchema requires ownershipPct
  // with no default -- the route 400s without it. Default 100 (wholly-owned, the common case);
  // stored here as a 0-100 display value and converted to the schema's 0-1 fraction on submit.
  const [ownershipPctDisplay, setOwnershipPctDisplay] = useState('100');
  const [pmSystem, setPmSystem] = useState<string>('quickbooks');
  const [authSource, setAuthSource] = useState<string>('internal-quickbooks');
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitForm() {
    setSubmitting(true);
    setResult(null);
    const cleanId = id.trim();
    const cleanName = name.trim();
    const ownershipPct = Number(ownershipPctDisplay) / 100;
    if (!cleanId || !cleanName) {
      setResult({ ok: false, error: 'ID and Name are required.' });
      setSubmitting(false);
      return;
    }
    if (!Number.isFinite(ownershipPct) || ownershipPct <= 0 || ownershipPct > 1) {
      setResult({ ok: false, error: 'Ownership % must be greater than 0 and at most 100.' });
      setSubmitting(false);
      return;
    }
    try {
      const res = await fetch('/api/warehouse/properties/onboard', {
        method: 'POST',
        headers: ORA_JSON_MUTATION_HEADERS,
        body: JSON.stringify({
          id: cleanId,
          name: cleanName,
          aliases: aliases.split(',').map(s => s.trim()).filter(Boolean),
          sfTotal: sfTotal ? Number(sfTotal) : null,
          ownershipPct,
          pmSystem,
          authoritativeSource: authSource,
        }),
      });
      const data = await res.json() as OnboardResult;
      setResult(data);
      if (data.ok) { setId(''); setName(''); setAliases(''); setSfTotal(''); setOwnershipPctDisplay('100'); }
    } catch {
      setResult({ ok: false, error: 'Network error — is the server running?' });
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 8px', fontSize: 13,
    border: '1px solid var(--border)', borderRadius: 4,
    background: 'var(--surface)', color: 'var(--text)',
  };

  return (
    <Card>
      <CardHeader title="Onboard Property" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          ID (URL-safe kebab-case, e.g. my-property)
          <input required value={id} onChange={e => setId(e.target.value)} style={inputStyle} placeholder="my-new-property" />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Display Name
          <input required value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="123 Main St, Columbus OH" />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Aliases (comma-separated, for file detection)
          <input value={aliases} onChange={e => setAliases(e.target.value)} style={inputStyle} placeholder="Main St, main_st_columbus" />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Rentable SF
          <input type="number" min={0} value={sfTotal} onChange={e => setSfTotal(e.target.value)} style={inputStyle} placeholder="10000" />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Ownership % (100 for wholly-owned; e.g. 50 for a 50% JV)
          <input
            required
            type="number"
            min={0.01}
            max={100}
            step="any"
            value={ownershipPctDisplay}
            onChange={e => setOwnershipPctDisplay(e.target.value)}
            style={inputStyle}
            placeholder="100"
          />
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          PM System
          <select value={pmSystem} onChange={e => setPmSystem(e.target.value)} style={inputStyle}>
            {PM_SYSTEMS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Authoritative Source
          <select value={authSource} onChange={e => setAuthSource(e.target.value)} style={inputStyle}>
            {AUTH_SOURCES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <Button onPress={() => void submitForm()} isDisabled={submitting}>
          {submitting ? 'Onboarding…' : 'Onboard Property'}
        </Button>
        {result && (
          <div style={{
            padding: '8px 12px', borderRadius: 4, fontSize: 13,
            background: result.ok ? 'var(--color-pos-soft)' : 'var(--color-neg-soft)',
            color: result.ok ? 'var(--text-pos)' : 'var(--text-neg)',
          }}>
            {result.ok ? `✓ Onboarded: ${result.propertyId ?? ''}` : `✗ ${result.error ?? 'Unknown error'}`}
          </div>
        )}
      </div>
    </Card>
  );
}
