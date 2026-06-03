import { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Animated count-up via rAF (not CSS — screenshot/idle safe). Eases from prior value. */
export function useCountUp(target: number | null, duration = 850): number {
  const [val, setVal] = useState(target ?? 0);
  const prev = useRef(target ?? 0);

  useEffect(() => {
    if (target === null || !Number.isFinite(target)) {
      setVal(0);
      return;
    }
    if (prefersReducedMotion()) {
      setVal(target);
      prev.current = target;
      return;
    }
    const from = prev.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return val;
}
