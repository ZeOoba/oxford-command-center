import { MotionConfig } from 'framer-motion';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DataProvider } from '@/data/provider';
import { UiProvider } from '@/brain/UiProvider';
import { ToastProvider } from '@/primitives/Toast';
import { AppShell } from '@/shell/AppShell';

export function App() {
  return (
    // reducedMotion="user" makes EVERY Framer animation honor prefers-reduced-motion.
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <DataProvider>
          <BrowserRouter>
            <UiProvider>
              <Routes>
                {/* `:moduleId/*` matches both `/portfolio` and `/portfolio/:id` (drawer) without
                    remounting AppShell, so module/drawer changes are cheap navigations. */}
                <Route index element={<Navigate to="/overview" replace />} />
                <Route path=":moduleId/*" element={<AppShell />} />
              </Routes>
            </UiProvider>
          </BrowserRouter>
        </DataProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
