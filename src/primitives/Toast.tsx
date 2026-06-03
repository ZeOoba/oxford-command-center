import { useCallback, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { ToastContext, type ToastItem, type ToastInput, type ToastTone } from './toast-context';

const META: Record<ToastTone, { color: string; Icon: typeof Info }> = {
  success: { color: 'var(--color-pos)', Icon: CheckCircle2 },
  error: { color: 'var(--color-neg)', Icon: AlertCircle },
  info: { color: 'var(--color-info)', Icon: Info },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastInput) => {
      const id = (counter.current += 1);
      setItems((xs) => [...xs, { id, tone: 'info', ...t }]);
      setTimeout(() => remove(id), 4200);
    },
    [remove],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[320px] max-w-[92vw] flex-col gap-2">
        <AnimatePresence>
          {items.map((t) => {
            const { color, Icon } = META[t.tone ?? 'info'];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, x: 24, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.96 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5"
                style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', boxShadow: '0 18px 40px -22px rgba(0,0,0,0.7)' }}
              >
                <Icon size={15} style={{ color, marginTop: 1, flexShrink: 0 }} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{t.title}</div>
                  {t.description && <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>{t.description}</div>}
                </div>
                <button onClick={() => remove(t.id)} aria-label="Dismiss" className="grid h-5 w-5 place-items-center rounded" style={{ color: 'var(--text-tertiary)' }}>
                  <X size={12} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
