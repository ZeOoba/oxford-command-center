import { useState } from 'react';
import { Moon, Sun, Sunset } from 'lucide-react';
import { Button } from '@/primitives/Button';
import { applyTheme, getInitialTheme, type Theme } from '@/lib/theme';

const NEXT: Record<Theme, Theme> = {
  command: 'parchment',
  parchment: 'warm',
  warm: 'command',
};

const ICON: Record<Theme, typeof Moon> = {
  command: Moon,
  parchment: Sun,
  warm: Sunset,
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const toggle = () => {
    const next = NEXT[theme];
    applyTheme(next);
    setTheme(next);
  };
  const Icon = ICON[theme];
  return (
    <Button variant="ghost" size="sm" aria-label="Toggle theme" onPress={toggle}>
      <Icon size={15} />
    </Button>
  );
}
