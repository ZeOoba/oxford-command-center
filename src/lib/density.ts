export type Density = 'comfortable' | 'compact';

const KEY = 'ora-density';

export function getInitialDensity(): Density {
  try {
    const d = localStorage.getItem(KEY);
    if (d === 'comfortable' || d === 'compact') return d;
  } catch {
    /* storage unavailable */
  }
  return 'comfortable';
}

export function applyDensity(density: Density): void {
  document.documentElement.setAttribute('data-density', density);
  try {
    localStorage.setItem(KEY, density);
  } catch {
    /* storage unavailable */
  }
}
