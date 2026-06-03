import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles, X, ArrowUp } from 'lucide-react';
import { useUi } from './ui-context';
import { askBrain } from './ai/adapter';
import type { AiMessage } from './ai/types';
import { Badge } from '@/primitives/Badge';

const SUGGESTIONS = ["What's at risk right now?", 'Summarize the portfolio', 'Any balloons coming up?', 'Tenant concentration?'];

export function AiPanel() {
  const ui = useUi();
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const counter = useRef(0);
  const nextId = () => `m${(counter.current += 1)}`;

  useEffect(() => {
    if (!ui.aiOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ui.closeAi();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    const userMsg: AiMessage = { id: nextId(), role: 'user', content: q };
    const pending: AiMessage = { id: nextId(), role: 'assistant', content: '', pending: true };
    setMessages((m) => [...m, userMsg, pending]);
    setBusy(true);
    try {
      const res = await askBrain(q);
      setMessages((m) => m.map((x) => (x.id === pending.id ? { ...x, content: res.answer, sources: res.sources, pending: false } : x)));
    } catch {
      setMessages((m) => m.map((x) => (x.id === pending.id ? { ...x, content: 'Could not reach the assistant. Is the Brain Server running?', pending: false } : x)));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <AnimatePresence>
      {ui.aiOpen && (
        <motion.aside
          className="fixed right-0 top-0 z-40 flex h-dvh w-[380px] max-w-[92vw] flex-col"
          style={{ background: 'var(--surface-raised)', borderLeft: '1px solid var(--border-strong)', boxShadow: '-20px 0 50px -30px rgba(0,0,0,0.6)' }}
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
          <header className="flex items-center justify-between px-4 py-3.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-2">
              <Sparkles size={16} style={{ color: 'var(--accent)' }} />
              <span className="display text-base" style={{ color: 'var(--text-primary)' }}>Brain Assistant</span>
              <Badge tone="gold">Preview</Badge>
            </div>
            <button onClick={ui.closeAi} aria-label="Close assistant" className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
              <X size={14} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mb-3 grid h-12 w-12 place-items-center rounded-[var(--radius-lg)]" style={{ background: 'var(--accent-quiet)', color: 'var(--accent)' }}>
                  <Sparkles size={22} />
                </div>
                <p className="mb-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Ask about your portfolio</p>
                <p className="mb-5 text-xs" style={{ color: 'var(--text-tertiary)' }}>Grounded in the live workbook. Answers cite their source.</p>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => void send(s)} className="rounded-[var(--radius-sm)] px-3 py-2 text-left text-xs transition-colors" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((m) => (
                  <div key={m.id} className={m.role === 'user' ? 'self-end' : 'self-start'} style={{ maxWidth: '92%' }}>
                    <div
                      className="whitespace-pre-wrap rounded-[var(--radius-md)] px-3 py-2 text-xs leading-relaxed"
                      style={
                        m.role === 'user'
                          ? { background: 'var(--accent)', color: 'var(--text-on-accent)', fontWeight: 500 }
                          : { background: 'var(--surface-overlay)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }
                      }
                    >
                      {m.pending ? 'Analyzing the workbook…' : m.content}
                    </div>
                    {m.sources && m.sources.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.sources.map((s) => (
                          <span key={s} className="num rounded px-1.5 py-0.5 text-[9px] uppercase" style={{ letterSpacing: '0.08em', background: 'var(--surface-base)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}>
                            {s}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={onSubmit} className="flex items-center gap-2 px-3 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the brain…"
              className="num flex-1 rounded-[var(--radius-sm)] px-3 py-2 text-xs outline-none"
              style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}>
              <ArrowUp size={15} />
            </button>
          </form>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
