// src/charts/kit/MarkFrame.tsx
//
// Shared frame of the app's hand-built SVG chart kit (built for the Property explorer, plan T7;
// promoted to src/charts by roadmap 2.6, styled by ./kit.css on app tokens): a horizontally scrolling
// container (wide charts scroll INSIDE it, never the page), a fixed-pixel SVG (text stays at its CSS
// size), and a tooltip for EVERY mark on hover, touch (pointer down) and keyboard (the chart is one
// tab stop; arrow keys walk the marks, Escape clears). The legend and the <details> data table sit
// outside the scroller. The component draws nothing itself: children render the marks and bind each
// one with `bind(i)`.
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import './kit.css';

export interface TipMark {
  /** Anchor of the tooltip, in SVG pixels. */
  readonly x: number;
  readonly y: number;
  /** Title first, then detail lines. */
  readonly lines: readonly string[];
}

export interface MarkBind {
  readonly onPointerEnter: () => void;
  readonly onPointerDown: () => void;
  readonly 'data-mark': string;
}

export interface MarkFrameProps {
  /** Ref of the measured outer element (useMeasure). */
  readonly measureRef: React.Ref<HTMLDivElement>;
  readonly width: number;
  readonly height: number;
  readonly ariaLabel: string;
  readonly marks: readonly TipMark[];
  readonly children: (bind: (i: number) => MarkBind, active: number | null) => ReactNode;
  readonly legend?: ReactNode;
  /** The accessible data-table fallback (rendered inside <details>). */
  readonly table: ReactNode;
  readonly testId?: string;
}

const TIP_W = 200;

export function MarkFrame({ measureRef, width: W, height: H, ariaLabel, marks, children, legend, table, testId }: MarkFrameProps) {
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const n = marks.length;
  const bind = (i: number): MarkBind => ({ onPointerEnter: () => setActive(i), onPointerDown: () => setActive(i), 'data-mark': String(i) });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const cur = active ?? -1;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };
  const m = active === null ? undefined : marks[active];
  const left = m ? Math.max(0, m.x + 14 + TIP_W > W ? m.x - TIP_W - 14 : m.x + 14) : 0;
  const top = m ? Math.max(0, Math.min(H - 40, m.y - 10)) : 0;

  return (
    <div className="ck-xchart" data-testid={testId}>
      <div className="ck-chart ck-chart-sx" ref={measureRef}>
        <div
          className="ck-cin ck-chart-focus"
          style={{ width: W }}
          tabIndex={0}
          role="group"
          aria-label={`${ariaLabel}. Use the arrow keys to read each mark; the data table below lists every value.`}
          aria-describedby={tableId}
          onKeyDown={onKey}
          onFocus={() => setActive((a) => a ?? (n > 0 ? 0 : null))}
          onBlur={() => setActive(null)}
        >
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onPointerLeave={() => setActive(null)} style={{ width: W, height: H, maxWidth: 'none', touchAction: 'pan-x pan-y' }}>
            {children(bind, active)}
          </svg>
          {m && (
            <div className="ck-tip" role="status" style={{ left, top, width: TIP_W }}>
              <b>{m.lines[0]}</b>
              {m.lines.slice(1).map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          )}
        </div>
      </div>
      {legend}
      <details className="ck-tablefb" id={tableId}>
        <summary>Data table</summary>
        <div className="ck-tbl">{table}</div>
      </details>
    </div>
  );
}

/** Legend swatch list (shown for two or more series). */
export function Legend({ items, extra }: { items: ReadonlyArray<{ readonly label: string; readonly color: string; readonly shape?: ReactNode }>; extra?: ReactNode }) {
  if (items.length < 2 && !extra) return null;
  return (
    <div className="ck-legend">
      {items.map((it) => (
        <span key={it.label}>
          {it.shape ?? <i style={{ background: it.color, height: 10, width: 10 }} aria-hidden />}
          {it.label}
        </span>
      ))}
      {extra}
    </div>
  );
}
