// src/modules/intel/ProspectDemandModule.tsx
//
// Direction 3 — Prospect Demand Intelligence panel (FOUNDATION).
//
// Tracks external demand signals on portfolio properties — broker showings, inquiries, LOI
// activity, tours, follow-ups. Today these are entered manually via the form below; when the
// Outlook ingest pipeline ships it will write the same warehouse table (source='outlook') and
// this same table will surface those events automatically — no UI change needed.
//
// Layout:
//   A. Per-property demand table — Property | Events | Last Contact | Event Types
//   B. Manual-entry form — property (dropdown from portfolio), type, date, contact, SF, notes
//
// Degrades gracefully on the static mirror (warehouse routes absent → informational card).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Radar, Plus } from 'lucide-react';
import { useProspectDemand, addProspectEvent, PROSPECT_DEMAND_KEYS } from './prospect-demand-hooks';
import { isWarehouseUnavailable } from './hooks';
import { useSnapshot } from '@/data/queries';
import { fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { DataTable, type Column } from '@/primitives/DataTable';
import { ProspectEventType, type ProspectDemandSummary, type ProspectEventType as EventType } from '@contracts/prospect-demand';

// ── Event-type display ──────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  showing: 'Showing',
  inquiry: 'Inquiry',
  loi: 'LOI',
  tour: 'Tour',
  follow_up: 'Follow-up',
};

const EVENT_TYPE_TONES: Record<EventType, 'amber' | 'neutral' | 'green' | 'blue'> = {
  loi: 'green',
  tour: 'blue',
  showing: 'blue',
  inquiry: 'neutral',
  follow_up: 'amber',
};

// ── Demand table ─────────────────────────────────────────────────────────────────

const fieldStyle = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
} as const;

function buildColumns(propertyNames: Map<string, string>): Column<ProspectDemandSummary>[] {
  return [
    {
      key: 'property',
      header: 'Property',
      render: (s) => (
        <span style={{ fontWeight: 600 }}>{propertyNames.get(s.propertyId) ?? s.propertyId}</span>
      ),
      sortValue: (s) => propertyNames.get(s.propertyId) ?? s.propertyId,
    },
    {
      key: 'events',
      header: 'Events',
      align: 'right',
      render: (s) => <span className="num">{fmtNum(s.eventCount)}</span>,
      sortValue: (s) => s.eventCount,
    },
    {
      key: 'last',
      header: 'Last Contact',
      align: 'right',
      render: (s) =>
        s.lastEventDate ? (
          <span className="num">{s.lastEventDate}</span>
        ) : (
          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        ),
      sortValue: (s) => s.lastEventDate ?? '',
    },
    {
      key: 'types',
      header: 'Event Types',
      render: (s) => (
        <span className="flex flex-wrap gap-1">
          {s.eventTypes.map((t) => (
            <Badge key={t} tone={EVENT_TYPE_TONES[t]}>
              {EVENT_TYPE_LABELS[t]}
            </Badge>
          ))}
        </span>
      ),
      sortValue: (s) => s.eventTypes.length,
    },
  ];
}

// ── Manual-entry form ─────────────────────────────────────────────────────────────

interface PropertyOption {
  id: string;
  name: string;
}

function DemandEntryForm({ properties }: { properties: PropertyOption[] }) {
  const qc = useQueryClient();
  const [propertyId, setPropertyId] = useState('');
  const [eventType, setEventType] = useState<EventType>('showing');
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [contact, setContact] = useState('');
  const [company, setCompany] = useState('');
  const [sfInterest, setSfInterest] = useState('');
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: addProspectEvent,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROSPECT_DEMAND_KEYS.report });
      // Reset the volatile fields; keep property + type for rapid multi-entry.
      setContact('');
      setCompany('');
      setSfInterest('');
      setNotes('');
    },
  });

  const handleSubmit = () => {
    if (!propertyId || !eventDate) return;
    const sf = sfInterest.trim() === '' ? null : Math.trunc(Number(sfInterest));
    mutation.mutate({
      property_id: propertyId,
      event_type: eventType,
      event_date: eventDate,
      contact: contact.trim() || null,
      company: company.trim() || null,
      sf_interest: sf !== null && Number.isFinite(sf) && sf >= 0 ? sf : null,
      notes: notes.trim() || null,
      source: 'manual',
    });
  };

  const canSubmit = propertyId !== '' && eventDate !== '' && !mutation.isPending;

  return (
    <Card>
      <CardHeader
        title="Log Demand Event"
        trailing={
          <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            manual entry
          </span>
        }
      />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Property dropdown */}
          <label className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Property</span>
            <select
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
              aria-label="Property"
              className="num h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={{ ...fieldStyle, width: 240 }}
            >
              <option value="">Select a property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {/* Event type */}
          <label className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Type</span>
            <select
              value={eventType}
              onChange={(e) => setEventType(e.target.value as EventType)}
              aria-label="Event type"
              className="num h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={fieldStyle}
            >
              {ProspectEventType.options.map((t) => (
                <option key={t} value={t}>{EVENT_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </label>

          {/* Date */}
          <label className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Date</span>
            <input
              type="date"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              aria-label="Event date"
              className="num h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={fieldStyle}
            />
          </label>

          {/* SF interest */}
          <label className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>SF Interest</span>
            <input
              type="number"
              min={0}
              step={500}
              value={sfInterest}
              onChange={(e) => setSfInterest(e.target.value)}
              placeholder="—"
              aria-label="SF of interest"
              className="num h-8 w-24 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={fieldStyle}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {/* Contact */}
          <label className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Contact</span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Broker / prospect name"
              aria-label="Contact"
              className="h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={{ ...fieldStyle, width: 200 }}
            />
          </label>

          {/* Company */}
          <label className="flex flex-col gap-1">
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Company</span>
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Firm name"
              aria-label="Company"
              className="h-8 rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={{ ...fieldStyle, width: 200 }}
            />
          </label>

          {/* Notes */}
          <label className="flex flex-1 flex-col gap-1" style={{ minWidth: 200 }}>
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Notes</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="Free text"
              aria-label="Notes"
              className="h-8 w-full rounded-[var(--radius-sm)] px-2 text-2xs outline-none"
              style={fieldStyle}
            />
          </label>

          <Button
            size="sm"
            variant="subtle"
            onPress={handleSubmit}
            isDisabled={!canSubmit}
            aria-label="Log demand event"
          >
            <Plus size={12} /> Log Event
          </Button>
        </div>

        {mutation.isError && (
          <div className="text-2xs" style={{ color: 'var(--color-neg)' }}>
            Failed to log event — brain server not reachable.
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Main module ────────────────────────────────────────────────────────────────────

export function ProspectDemandModule() {
  const { data, error } = useProspectDemand();
  const { data: snapshotData } = useSnapshot();

  const warehouseDown = isWarehouseUnavailable(error);

  const properties: PropertyOption[] = (snapshotData?.snapshot.properties ?? [])
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const propertyNames = new Map(properties.map((p) => [p.id, p.name]));

  const summaries = data?.summaries ?? [];
  const columns = buildColumns(propertyNames);

  if (warehouseDown) {
    return (
      <Card>
        <div className="px-6 py-10 text-center" style={{ color: 'var(--text-tertiary)' }}>
          <Radar size={28} className="mx-auto mb-3 opacity-40" />
          <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Prospect Demand Intelligence Unavailable
          </div>
          <div className="mt-1 text-2xs">
            Warehouse routes are not reachable on the static mirror. Run the local brain server to
            record and view demand signals.
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Section A — Per-property demand table */}
      <Card>
        <CardHeader
          title="Demand Signals by Property"
          trailing={
            <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              {data ? `${fmtNum(data.totalEventCount)} events` : '—'}
            </span>
          }
        />
        {summaries.length === 0 ? (
          <div className="px-4 py-8 text-center text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            No demand events recorded. Use the form below to log a showing or inquiry.
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={summaries}
            getRowId={(s) => s.propertyId}
            initialSort={{ key: 'events', dir: 'desc' }}
            maxHeight={420}
          />
        )}
      </Card>

      {/* Section B — Manual-entry form */}
      <DemandEntryForm properties={properties} />
    </div>
  );
}
