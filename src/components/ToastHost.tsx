import { useEffect, useRef, useState } from "react";
import {
  TOAST_EVENT,
  ToastEventDetail,
  ToastKind,
  toastBus,
} from "../lib/toast";

interface LiveToast extends ToastEventDetail {
  // false until the slide-up transition has been triggered
  shown: boolean;
  // true once we've started the fade-out (waiting for transition end)
  leaving: boolean;
}

const KIND_EDGE: Record<ToastKind, string> = {
  success: "#22c55e",
  info: "#60a5fa",
  warn: "#facc15",
  error: "#ef4444",
};

const ENTER_MS = 200;
const EXIT_MS = 200;

export default function ToastHost() {
  const [toasts, setToasts] = useState<LiveToast[]>([]);
  const timersRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    function onFire(ev: Event) {
      const detail = (ev as CustomEvent<ToastEventDetail>).detail;
      if (!detail) return;
      setToasts((prev) => [...prev, { ...detail, shown: false, leaving: false }]);
      // Trigger the enter transition on the next frame.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setToasts((prev) =>
            prev.map((t) => (t.id === detail.id ? { ...t, shown: true } : t))
          );
        });
      });
      const dur = detail.durationMs ?? 4000;
      const handle = window.setTimeout(() => dismiss(detail.id), dur);
      timersRef.current.set(detail.id, handle);
    }
    toastBus.addEventListener(TOAST_EVENT, onFire);
    return () => toastBus.removeEventListener(TOAST_EVENT, onFire);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss(id: number) {
    const handle = timersRef.current.get(id);
    if (handle != null) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    );
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_MS);
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
      data-testid="toast-host"
    >
      {toasts.map((t) => {
        const edge = KIND_EDGE[t.kind ?? "info"];
        const translate = t.shown && !t.leaving ? "translateY(0)" : "translateY(12px)";
        const opacity = t.shown && !t.leaving ? 1 : 0;
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex w-full max-w-md cursor-pointer items-start gap-3 rounded-lg border border-ink-700 bg-ink-800 px-4 py-3 shadow-lg shadow-black/40"
            style={{
              borderLeft: `3px solid ${edge}`,
              transform: translate,
              opacity,
              transition: `transform ${t.leaving ? EXIT_MS : ENTER_MS}ms ease, opacity ${
                t.leaving ? EXIT_MS : ENTER_MS
              }ms ease`,
            }}
            onClick={() => dismiss(t.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium text-ink-100">
                {t.title}
              </div>
              {t.body && (
                <div className="mt-0.5 text-xs text-ink-300">{t.body}</div>
              )}
            </div>
            {t.action && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  try {
                    t.action!.onClick();
                  } finally {
                    dismiss(t.id);
                  }
                }}
                className="shrink-0 rounded-md border border-ink-600 px-2 py-1 text-xs font-medium text-ink-100 hover:bg-ink-700"
              >
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
