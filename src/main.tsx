import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens/theme.css';
import { App } from './App';
import { applyTheme, getInitialTheme } from './lib/theme';
import { applyDensity, getInitialDensity } from './lib/density';

applyTheme(getInitialTheme());
applyDensity(getInitialDensity());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
