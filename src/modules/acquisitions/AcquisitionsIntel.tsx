// src/modules/acquisitions/AcquisitionsIntel.tsx
//
// Acquisition Intelligence section — ranked deal-flow + calibration summary (Phase 4, Step 7).
// Appended to AcquisitionsModule.tsx as an additional card section.
// Reads GET /acq/intel; writes PATCH /acq/candidates/:id/status (hidden when warehouse offline).
import { useState } from 'react';
import { isWarehouseUnavailable, useWarehouseLive } from '../intel/hooks';
import { useAcqIntel } from './hooks';
import { RankedCandidateList } from './RankedCandidateList';
import { CalibrationSummaryPanel } from './CalibrationSummaryPanel';

const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'acquired', label: 'Acquired' },
  { value: 'passed',   label: 'Passed' },
];

const MARKET_OPTIONS = [
  { value: '',                  label: 'All markets' },
  { value: 'owned-submarket',   label: 'Owned submarket' },
  { value: 'established',       label: 'Established' },
  { value: 'entry',             label: 'Entry' },
  { value: 'satellite',         label: 'Satellite' },
  { value: 'none',              label: 'No market' },
];

const VERDICT_OPTIONS = [
  { value: '',       label: 'All verdicts' },
  { value: 'PURSUE', label: 'Pursue' },
  { value: 'WATCH',  label: 'Watch' },
  { value: 'PASS',   label: 'Pass' },
  { value: 'KILLED', label: 'Killed' },
];

export function AcquisitionsIntel() {
  const [status,  setStatus]  = useState('active');
  const [market,  setMarket]  = useState('');
  const [verdict, setVerdict] = useState('');

  const { data, isLoading, error } = useAcqIntel(
    status || undefined,
    market  || undefined,
    verdict || undefined,
  );

  const writesEnabled = useWarehouseLive();

  const selectStyle = {
    fontSize: '0.75rem',
    padding: '0.25rem 0.5rem',
    border: '1px solid var(--border)',
    borderRadius: '0.25rem',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  };

  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: '1.125rem', color: 'var(--text-primary)', marginBottom: '0.75rem' }}>
        Acquisition Intelligence
      </h2>

      {data?.advisoryOnly && (
        <div role="alert" style={{ background: 'var(--color-warn-bg, #fef3c7)', border: '1px solid var(--color-warn)', borderRadius: '0.375rem', padding: '0.625rem 0.875rem', marginBottom: '0.875rem', fontSize: '0.8125rem', color: 'var(--color-warn-text, #92400e)' }}>
          <strong>Advisory only</strong> — ruleset not yet ratified. Scores are informational; do not act on them for capital deployment.
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <select value={status}  onChange={(e) => setStatus(e.target.value)}  style={selectStyle}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={market}  onChange={(e) => setMarket(e.target.value)}  style={selectStyle}>
          {MARKET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)} style={selectStyle}>
          {VERDICT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {isLoading && (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>Loading acquisition intel…</p>
      )}

      {!isLoading && isWarehouseUnavailable(error) && (
        <p style={{ color: 'var(--text-tertiary)', fontSize: '0.875rem' }}>Warehouse offline — acquisition intel unavailable.</p>
      )}

      {!isLoading && !isWarehouseUnavailable(error) && data && (
        <>
          <CalibrationSummaryPanel summary={data.calibrationSummary} />
          <RankedCandidateList
            items={data.rankedCandidates}
            advisoryOnly={data.advisoryOnly}
            writesEnabled={writesEnabled}
          />
        </>
      )}
    </section>
  );
}
