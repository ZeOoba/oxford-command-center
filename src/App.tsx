import { MotionConfig } from 'framer-motion';
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
          <UiProvider>
            <AppShell />
          </UiProvider>
        </DataProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
