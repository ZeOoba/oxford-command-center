import { MotionConfig } from 'framer-motion';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { DataProvider } from '@/data/provider';
import { UiProvider } from '@/brain/UiProvider';
import { ViewProfileProvider, useViewProfile } from '@/brain/view-profile';
import { PROFILE_HOME } from '@/shell/module-order';
import { ToastProvider } from '@/primitives/Toast';
import { AppShell } from '@/shell/AppShell';

function HomeRedirect() {
  const { profile } = useViewProfile();
  return <Navigate to={`/${PROFILE_HOME[profile]}`} replace />;
}

export function App() {
  return (
    // reducedMotion="user" makes EVERY Framer animation honor prefers-reduced-motion.
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <DataProvider>
          <BrowserRouter>
            <UiProvider>
              <ViewProfileProvider>
                <Routes>
                  {/* `:moduleId/*` matches both `/portfolio` and `/portfolio/:id` (drawer) without
                      remounting AppShell, so module/drawer changes are cheap navigations. */}
                  <Route index element={<HomeRedirect />} />
                  <Route path=":moduleId/*" element={<AppShell />} />
                </Routes>
              </ViewProfileProvider>
            </UiProvider>
          </BrowserRouter>
        </DataProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
