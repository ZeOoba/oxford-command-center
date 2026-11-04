import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens/theme.css';
import { App } from './App';
import { applyTheme, getInitialTheme } from './lib/theme';
import { applyDensity, getInitialDensity } from './lib/density';
import { installStaleChunkReload } from './shell/stale-chunk';

installStaleChunkReload();
applyTheme(getInitialTheme());
applyDensity(getInitialDensity());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
