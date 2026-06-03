import { useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/primitives/Button';
import { applyTheme, getInitialTheme, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const toggle = () => {
    const next: Theme = theme === 'command' ? 'parchment' : 'command';
    applyTheme(next);
    setTheme(next);
  };
  return (
    <Button variant="ghost" size="sm" aria-label="Toggle theme" onPress={toggle}>
      {theme === 'command' ? <Moon size={15} /> : <Sun size={15} />}
    </Button>
  );
}
