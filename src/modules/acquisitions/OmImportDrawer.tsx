// src/modules/acquisitions/OmImportDrawer.tsx
import { useRef, useState } from 'react';
import { FIELD_GROUPS, omExtractRequest, OmExtractError, type OmExtractResult } from './acquisition-score';

type DrawerState =
  | { phase: 'idle' }
  | { phase: 'uploading'; filename: string }
  | { phase: 'extracted'; filename: string; fields: Record<string, string>; fieldCount: number; rawText?: string; savedPath?: string }
  | { phase: 'error'; message: string };

// key → human label from the shared field model
const FIELD_LABELS: Record<string, string> = {};
for (const group of FIELD_GROUPS) {
  for (const spec of group.fields) {
    FIELD_LABELS[spec.key] = spec.label;
  }
}

export function OmImportDrawer({
  open,
  onClose,
  onApply,
  dealId,
  extractFn = omExtractRequest,
}: {
  open: boolean;
  onClose: () => void;
  onApply: (fields: Record<string, string>) => void;
  dealId?: string;
  extractFn?: (file: File, dealId?: string) => Promise<OmExtractResult>;
}) {
  const [state, setState] = useState<DrawerState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) {
      setState({ phase: 'error', message: 'File too large (max 25 MB).' });
      return;
    }
    setState({ phase: 'uploading', filename: file.name });
    try {
      const result = await extractFn(file, dealId);
      setState({ phase: 'extracted', filename: file.name, fields: result.fields, fieldCount: result.fieldCount, rawText: result.rawText, savedPath: result.savedPath });
    } catch (e) {
      setState({
        phase: 'error',
        message: e instanceof OmExtractError ? e.message : 'Extraction failed — try again.',
      });
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = ''; // allow re-selecting the same file
  };

  const handleApply = () => {
    if (state.phase !== 'extracted') return;
    onApply(state.fields);
    setState({ phase: 'idle' });
    onClose();
  };

  const handleDiscard = () => {
    setState({ phase: 'idle' });
    onClose();
  };

  const drawerStyle: React.CSSProperties = {
    background: 'var(--surface-base)',
    border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
    marginBottom: '0.75rem',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.375rem 0.75rem',
    borderBottom: '1px solid var(--border-strong)',
    background: 'var(--surface-overlay)',
  };

  const btnBase: React.CSSProperties = {
    background: 'var(--surface-overlay)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: '0.7rem',
    padding: '0.2rem 0.5rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const btnPrimary: React.CSSProperties = {
    ...btnBase,
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
    color: '#fff',
  };

  return (
    <div style={drawerStyle}>
      {/* Single hidden file input — all states share it */}
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Header */}
      <div style={headerStyle}>
        <span
          className="text-2xs font-semibold uppercase"
          style={{ letterSpacing: '0.08em', color: 'var(--accent)' }}
        >
          OM Import
        </span>
        {state.phase === 'uploading' && (
          <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
            Extracting fields…
          </span>
        )}
        {state.phase === 'extracted' && (
          <span className="text-2xs" style={{ color: 'var(--color-pos)' }}>
            {state.fieldCount} field{state.fieldCount !== 1 ? 's' : ''} found
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '0.5rem 0.75rem' }}>
        {state.phase === 'idle' && (
          <button
            type="button"
            style={{ ...btnBase, width: '100%', textAlign: 'center' }}
            onClick={() => inputRef.current?.click()}
          >
            Drop PDF here or click to upload
          </button>
        )}

        {state.phase === 'uploading' && (
          <div>
            <div
              style={{
                height: '3px',
                background: 'var(--border-strong)',
                borderRadius: '2px',
                marginBottom: '6px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  background: 'var(--accent)',
                  borderRadius: '2px',
                  width: '60%',
                }}
              />
            </div>
            <span className="text-2xs" style={{ color: 'var(--text-secondary)' }}>
              {state.filename}
            </span>
          </div>
        )}

        {state.phase === 'extracted' && (
          <>
            {state.fieldCount === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <p className="text-2xs" style={{ color: 'var(--text-secondary)', flex: 1, margin: 0 }}>
                  No fields extracted — the OM may lack structured data.
                </p>
                {state.rawText && (
                  <button
                    type="button"
                    style={btnBase}
                    onClick={() => void navigator.clipboard.writeText(state.rawText!)}
                  >
                    Copy OM text
                  </button>
                )}
              </div>
            ) : (
              <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '0.5rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
                  <thead>
                    <tr>
                      <th
                        style={{
                          textAlign: 'left',
                          padding: '0 0.5rem 0.25rem 0',
                          fontWeight: 600,
                          fontSize: '0.65rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        Field
                      </th>
                      <th
                        style={{
                          textAlign: 'left',
                          padding: '0 0.5rem 0.25rem 0',
                          fontWeight: 600,
                          fontSize: '0.65rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        Extracted
                      </th>
                      <th style={{ width: '1.25rem' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(state.fields).map(([key, value]) => (
                      <tr key={key} style={{ borderTop: '1px solid var(--border-strong)' }}>
                        <td
                          style={{ padding: '0.2rem 0.5rem 0.2rem 0', color: 'var(--color-info)' }}
                        >
                          {FIELD_LABELS[key] ?? key}
                        </td>
                        <td style={{ padding: '0.2rem 0.5rem 0.2rem 0', color: 'var(--text-primary)' }}>
                          {value}
                        </td>
                        <td style={{ color: 'var(--color-pos)', textAlign: 'center' }}>✓</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span
                className="text-2xs"
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-tertiary)' }}
                title={state.savedPath ?? state.filename}
              >
                {state.savedPath ? `Saved to OneDrive ✓` : state.filename}
              </span>
              <button type="button" style={btnBase} onClick={handleDiscard}>
                Discard
              </button>
              <button
                type="button"
                style={state.fieldCount === 0 ? { ...btnPrimary, opacity: 0.5, cursor: 'not-allowed' } : btnPrimary}
                onClick={handleApply}
                disabled={state.fieldCount === 0}
              >
                Apply to Form
              </button>
            </div>
          </>
        )}

        {state.phase === 'error' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              className="text-2xs"
              style={{ flex: 1, color: 'var(--color-neg)' }}
            >
              {state.message}
            </span>
            <button
              type="button"
              style={btnBase}
              onClick={() => {
                setState({ phase: 'idle' });
                // Small delay so state settles before re-opening the picker
                setTimeout(() => inputRef.current?.click(), 50);
              }}
            >
              Try again
            </button>
            <button type="button" style={btnBase} onClick={handleDiscard}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
