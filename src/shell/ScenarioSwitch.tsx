import { motion } from 'framer-motion';
import type { ScenarioName } from '@contracts/index';
import { useUi } from '@/brain/ui-context';

const SCENARIOS: ScenarioName[] = ['Base', 'Upside', 'Downside'];

/**
 * Scenario selector — recomputes the entire analytics layer through the
 * revenue / vacancy / exit-cap factors (see analytics/applyScenario).
 */
export function ScenarioSwitch() {
  const { scenario, setScenario } = useUi();

  return (
    <div
      className="flex items-center gap-0.5 rounded-full p-0.5"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
      role="radiogroup"
      aria-label="Scenario"
    >
      {SCENARIOS.map((s) => (
        <button
          key={s}
          role="radio"
          aria-checked={scenario === s}
          onClick={() => setScenario(s)}
          className="relative rounded-full px-2.5 py-1"
          style={{ color: scenario === s ? 'var(--text-on-accent)' : 'var(--text-tertiary)' }}
        >
          {scenario === s && (
            <motion.span
              layoutId="scenario-active"
              className="absolute inset-0 rounded-full"
              style={{ background: 'var(--accent)' }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            />
          )}
          <span className="num relative z-10 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.06em' }}>
            {s}
          </span>
        </button>
      ))}
    </div>
  );
}
