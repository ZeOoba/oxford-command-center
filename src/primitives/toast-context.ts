import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
}
export interface ToastItem extends ToastInput {
  id: number;
}
export interface ToastApi {
  toast: (t: ToastInput) => void;
}

export const ToastContext = createContext<ToastApi>({ toast: () => {} });
export function useToast(): ToastApi {
  return useContext(ToastContext);
}
