export type Theme = 'command' | 'parchment';

const KEY = 'ora-theme';

export function getInitialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'command' || t === 'parchment') return t;
  } catch {
    /* storage unavailable */
  }
  return 'command';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
}
