// Tiny toast bus: any component can call `fireToast(...)`. The single
// `<ToastHost />` in App.tsx subscribes to `toastBus` and renders the stack.
//
// Kept dependency-free (just an EventTarget) so this file is safe to import
// from anywhere without circular-import worries.

export type ToastKind = "success" | "info" | "warn" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  body?: string;
  kind?: ToastKind;
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastEventDetail extends ToastOptions {
  id: number;
}

export const TOAST_EVENT = "toast:fire";

export const toastBus: EventTarget = new EventTarget();

let nextId = 1;

export function fireToast(opts: ToastOptions): void {
  const detail: ToastEventDetail = { id: nextId++, ...opts };
  toastBus.dispatchEvent(new CustomEvent<ToastEventDetail>(TOAST_EVENT, { detail }));
}
