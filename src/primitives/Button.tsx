import type { ReactNode } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'subtle' | 'ghost';
type Size = 'sm' | 'md';

interface Props {
  children: ReactNode;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  className?: string;
  isDisabled?: boolean;
  'aria-label'?: string;
}

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-2xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export function Button({
  children,
  onPress,
  variant = 'subtle',
  size = 'md',
  className,
  isDisabled,
  ...rest
}: Props) {
  return (
    <AriaButton
      onPress={onPress}
      isDisabled={isDisabled}
      aria-label={rest['aria-label']}
      className={cn(
        'num inline-flex items-center justify-center rounded-[var(--radius-sm)] font-semibold whitespace-nowrap transition-[background,border-color,transform,box-shadow] duration-[140ms] outline-none select-none data-[disabled]:opacity-45 data-[pressed]:scale-[0.97]',
        SIZES[size],
        className,
      )}
      style={({ isHovered, isPressed }): CSSProperties => {
        const base: CSSProperties = { letterSpacing: '0.02em' };
        if (variant === 'primary')
          return {
            ...base,
            background: 'var(--accent)',
            color: 'var(--text-on-accent)',
            border: '1px solid color-mix(in oklab, var(--accent) 70%, #000)',
            filter: isHovered ? 'brightness(1.07)' : undefined,
          };
        if (variant === 'ghost')
          return {
            ...base,
            background: isHovered || isPressed ? 'var(--surface-overlay)' : 'transparent',
            color: isHovered ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: '1px solid transparent',
          };
        return {
          ...base,
          background: isHovered ? 'var(--surface-overlay)' : 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
          color: 'var(--text-primary)',
          border: `1px solid ${isHovered ? 'var(--border-strong)' : 'var(--border-subtle)'}`,
        };
      }}
    >
      {children}
    </AriaButton>
  );
}
