import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X, Copy, Check, Mail, ShieldAlert } from 'lucide-react';
import { useUi } from './ui-context';
import { useSnapshot } from '@/data/queries';
import { buildDraft, mailtoHref, ORA_CC } from './draft';

/**
 * Draft-only email composer (Phase 5). Generates a firm-voice draft from spine data, lets the user
 * edit it, then Copy or Open in Outlook. It NEVER sends — auto-send is intentionally disabled in the
 * app. The principals are always cc'd.
 */
export function DraftPanel() {
  const ui = useUi();
  const { data } = useSnapshot();
  const built = ui.draft && data ? buildDraft(data.snapshot, ui.draft) : null;

  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [copied, setCopied] = useState(false);

  // Seed the editable fields whenever a new draft is opened.
  useEffect(() => {
    if (built) {
      setTo(built.to);
      setSubject(built.subject);
      setBody(built.body);
      setCopied(false);
    }
  }, [ui.draft, built]);

  const open = !!ui.draft && !!built;
  const href = mailtoHref({ title: '', to, cc: ORA_CC, subject, body });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <AnimatePresence>
      {open && built && (
        <div className="fixed inset-0 z-[70] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Draft email">
          <motion.div className="absolute inset-0" style={{ background: 'rgba(2,4,8,0.55)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={ui.closeDraft} />
          <motion.div
            className="relative flex w-[min(620px,94vw)] flex-col rounded-[var(--radius-lg)]"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-strong)', maxHeight: '88vh' }}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            <header className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center gap-2">
                <Mail size={16} style={{ color: 'var(--accent)' }} />
                <span className="display text-base" style={{ color: 'var(--text-primary)' }}>{built.title}</span>
              </div>
              <button onClick={ui.closeDraft} aria-label="Close" className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                <X size={14} />
              </button>
            </header>

            <div className="flex items-center gap-2 px-5 py-2 text-2xs" style={{ background: 'color-mix(in oklab, var(--color-warn) 12%, transparent)', color: 'var(--text-warn)', borderBottom: '1px solid var(--border-subtle)' }}>
              <ShieldAlert size={13} />
              <span style={{ fontWeight: 600 }}>Draft only — review and send it yourself. Auto-send is disabled.</span>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <Field label="To">
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" className="num w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-none" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
              </Field>
              <Field label="Cc">
                <div className="flex flex-wrap gap-1.5">
                  {ORA_CC.map((a) => (
                    <span key={a} className="num rounded-full px-2 py-0.5 text-2xs" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>{a}</span>
                  ))}
                </div>
              </Field>
              <Field label="Subject">
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs outline-none" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
              </Field>
              <Field label="Body">
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} className="w-full resize-y rounded-[var(--radius-sm)] px-2.5 py-2 text-xs leading-relaxed outline-none" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
              </Field>
            </div>

            <footer className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <button onClick={copy} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
              <a href={href} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}>
                <Mail size={13} /> Open in Outlook
              </a>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="num mb-1 text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{label}</div>
      {children}
    </div>
  );
}
