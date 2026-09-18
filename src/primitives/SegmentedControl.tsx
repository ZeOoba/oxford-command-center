// src/primitives/SegmentedControl.tsx
//
// Level-2 "same data, different view" switch (IA decongestion Phase 0 — R5: no nested tabs;
// this is what a second disclosure level inside a tab panel uses instead — $ vs $/SF, monthly
// vs TTM, a market toggle, etc). Wraps react-aria-components' RadioGroup/Radio for real
// single-select radiogroup semantics (role="radiogroup" + role="radio" per item, arrow-key
// roving handled by RAC — no hand-rolled key handling, matching Tabs.tsx).
//
// Visual contract: design_handoff_ora_command_center/app/ora.css:160-164 (`.seg`) — a bordered
// group of mono, 10.5px labels with the active segment filled `--accent`. Ported to this repo's
// token names; colors applied via RAC's `isSelected` render prop (inline style), same convention
// as Tabs.tsx.
import { RadioGroup, Radio, type Key } from 'react-aria-components';
import { cn } from '@/lib/cn';

export interface SegmentedControlOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string> {
  options: ReadonlyArray<SegmentedControlOption<V>>;
  value: V;
  onChange: (value: V) => void;
  'aria-label': string;
  className?: string;
}

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps<V>) {
  return (
    <RadioGroup
      aria-label={ariaLabel}
      orientation="horizontal"
      value={value}
      onChange={(v: Key | null) => {
        if (v !== null) onChange(String(v) as V);
      }}
      className={cn('inline-flex w-fit overflow-hidden rounded-[var(--radius-sm)]', className)}
      style={{ border: '1px solid var(--border-subtle)' }}
    >
      {options.map((opt, i) => (
        <Radio
          key={opt.value}
          value={opt.value}
          className={({ isFocusVisible }) =>
            cn(
              'num cursor-pointer select-none whitespace-nowrap px-2.5 py-1 text-[10.5px] font-semibold outline-none',
              isFocusVisible && 'ring-2 ring-offset-1',
            )
          }
          style={({ isSelected, isHovered, isFocusVisible }) => ({
            color: isSelected
              ? 'var(--text-on-accent)'
              : isHovered
                ? 'var(--text-secondary)'
                : 'var(--text-tertiary)',
            background: isSelected ? 'var(--accent)' : 'transparent',
            borderRight: i < options.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            letterSpacing: '0.02em',
            ...(isFocusVisible ? { outline: '2px solid var(--accent)', outlineOffset: '-2px' } : null),
          })}
        >
          {opt.label}
        </Radio>
      ))}
    </RadioGroup>
  );
}
