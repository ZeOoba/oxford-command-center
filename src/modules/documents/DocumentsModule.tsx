import { useEffect, useState, type ReactNode } from 'react';
import { FileSearch, Sparkles } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { fmtNum } from '@analytics/index';
import { useUi } from '@/brain/ui-context';
import { useDocSearch } from '@/data/documents';

interface DocStatus {
  configured: boolean;
  dir: string | null;
  documents: number;
  chunks: number;
  docs: Array<{ name: string; chunks: number }>;
}

/**
 * Documents (Phase 6) — lease/PSA/OM corpus the agent searches (RAG). Indexing runs on the local
 * Brain Server only; the read-only mirror has no document index. Search itself is via the Ask panel
 * ("what's the renewal option in the Eurosort lease") — answers cite the passage.
 */
export function DocumentsModule() {
  const ui = useUi();
  const [status, setStatus] = useState<DocStatus | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/documents')
      .then((r) => (r.ok ? (r.json() as Promise<DocStatus>) : Promise.reject(new Error('no server'))))
      .then((j) => alive && setStatus(j))
      .catch(() => alive && setOffline(true));
    return () => {
      alive = false;
    };
  }, []);

  const Hint = ({ children }: { children: ReactNode }) => (
    <div className="flex items-center gap-2 px-4 py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>
      <FileSearch size={16} /> {children}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiStat label="Documents Indexed" value={status?.documents ?? 0} format={fmtNum} accentColor="var(--accent)" />
        <KpiStat label="Searchable Passages" value={status?.chunks ?? 0} format={fmtNum} accentColor="var(--color-info)" />
        <KpiStat label="Search" value={null} format={() => 'In-app + Ask'} sublabel="cited answers" />
      </div>

      <DocSearch />

      <Card>
        <CardHeader
          title="Document Corpus"
          trailing={
            offline ? <Badge tone="neutral">Mirror — read-only</Badge> : status?.configured ? <Badge tone="green">Indexed</Badge> : <Badge tone="amber">Not configured</Badge>
          }
        />
        {offline ? (
          <Hint>Document search runs on the local Brain Server, not the read-only mirror.</Hint>
        ) : !status ? (
          <Hint>Checking the document index…</Hint>
        ) : !status.configured ? (
          <Hint>
            No documents folder configured. Set <code className="num">DOCUMENTS_DIR</code> on the Brain Server (point it at the
            lease/PSA/OM folder) and restart to index PDFs.
          </Hint>
        ) : status.documents === 0 ? (
          <Hint>Folder configured ({status.dir}) but no supported documents (.pdf/.txt/.md) found.</Hint>
        ) : (
          <ul className="flex flex-col">
            {status.docs.map((d) => (
              <li key={d.name} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{d.name}</span>
                <span className="num shrink-0 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{d.chunks} passages</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <button
        onClick={ui.openAi}
        className="flex items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 py-3 text-sm font-semibold"
        style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--accent)' }}
      >
        <Sparkles size={15} /> Ask a document question
      </button>
    </div>
  );
}

function highlight(text: string, query: string): ReactNode {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return text.split(re).map((part, i) =>
    new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i').test(part) ? <mark key={i} style={{ background: 'var(--accent-quiet)', color: 'var(--accent)', padding: '0 2px', borderRadius: 2 }}>{part}</mark> : <span key={i}>{part}</span>,
  );
}

function DocSearch() {
  const [q, setQ] = useState('');
  const { data: hits, isFetching, isError } = useDocSearch(q);
  return (
    <Card>
      <CardHeader title="Semantic Search" trailing={<Badge tone="gold">embeddings + sqlite-vec</Badge>} />
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search clauses by meaning — e.g. ROFR, renewal option, environmental indemnity…"
          aria-label="Semantic document search"
          className="num h-9 w-full rounded-[var(--radius-sm)] px-3 text-sm outline-none"
          style={{ background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
      </div>
      <div className="flex flex-col">
        {isError ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>Search runs on the local Brain Server only.</div>
        ) : q.trim().length <= 2 ? (
          <div className="px-4 py-6 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Type a clause concept; results rank by meaning, not keywords.</div>
        ) : isFetching ? (
          <div className="px-4 py-6 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Searching…</div>
        ) : !hits || hits.length === 0 ? (
          <div className="px-4 py-6 text-2xs" style={{ color: 'var(--text-tertiary)' }}>No passages found (or no documents indexed).</div>
        ) : (
          hits.map((h) => (
            <div key={`${h.docId}-${h.chunkIdx}`} className="px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-2xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{h.doc}</span>
                <span className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{(h.score * 100).toFixed(0)}% match</span>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-primary)' }}>{highlight(h.snippet, q)}</p>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
