import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type SaveState = "saved" | "saving" | "dirty" | "error";

interface SaveStateValue {
  state: SaveState;
  lastSavedAt: number | null;
  pendingCount: number;
  errorMessage: string | null;
  /** Increment the in-flight counter. The returned callback decrements and stamps lastSavedAt. */
  markPending(): () => void;
  /** Force-mark "saved" without going through markPending (rare; mostly internal). */
  markSaved(): void;
  /** Mark the global state as errored with a human-readable message. */
  markError(msg: string): void;
  /** Mark fields dirty (no in-flight request yet). For future use by debounced fields. */
  markDirty(): void;
  /** Reset to baseline (used after error explicitly cleared). */
  clearError(): void;
}

const Ctx = createContext<SaveStateValue | null>(null);

export function SaveStateProvider({ children }: { children: React.ReactNode }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const markPending = useCallback(() => {
    setPendingCount((c) => c + 1);
    setDirty(false);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      setPendingCount((c) => Math.max(0, c - 1));
      setLastSavedAt(Date.now());
      setErrorMessage(null);
    };
  }, []);

  const markSaved = useCallback(() => {
    setLastSavedAt(Date.now());
    setErrorMessage(null);
  }, []);

  const markError = useCallback((msg: string) => {
    setErrorMessage(msg);
    setPendingCount((c) => Math.max(0, c - 1));
  }, []);

  const markDirty = useCallback(() => {
    setDirty(true);
  }, []);

  const clearError = useCallback(() => setErrorMessage(null), []);

  const state: SaveState = errorMessage
    ? "error"
    : pendingCount > 0
      ? "saving"
      : dirty
        ? "dirty"
        : "saved";

  const value = useMemo<SaveStateValue>(
    () => ({
      state,
      lastSavedAt,
      pendingCount,
      errorMessage,
      markPending,
      markSaved,
      markError,
      markDirty,
      clearError,
    }),
    [
      state,
      lastSavedAt,
      pendingCount,
      errorMessage,
      markPending,
      markSaved,
      markError,
      markDirty,
      clearError,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSaveState(): SaveStateValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useSaveState must be used inside <SaveStateProvider>");
  }
  return v;
}

/**
 * Header indicator. Drop into the top bar; renders a dot + label and a tooltip
 * with the relative "saved Xm ago" timestamp (or the error message).
 */
export function SaveStateIndicator({ className }: { className?: string }) {
  const { state, lastSavedAt, errorMessage } = useSaveState();
  // Tick once a minute so "Xm ago" stays roughly fresh.
  const [, setNow] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setNow((n) => n + 1), 30_000);
    return () => window.clearInterval(h);
  }, []);

  const dotColor =
    state === "saved"
      ? "#22c55e"
      : state === "saving"
        ? "#facc15"
        : state === "dirty"
          ? "#f59e0b"
          : "#ef4444";

  const label =
    state === "saved"
      ? "Saved"
      : state === "saving"
        ? "Saving…"
        : state === "dirty"
          ? "Unsaved changes"
          : "Save failed";

  const tooltip =
    state === "error" && errorMessage
      ? errorMessage
      : state === "saved" && lastSavedAt
        ? `Last saved ${formatRelative(lastSavedAt)}`
        : state === "saving"
          ? "Save in flight…"
          : "";

  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-ink-300 " +
        (className ?? "")
      }
      title={tooltip}
      data-testid="save-state-indicator"
      data-state={state}
    >
      <span
        className={
          "inline-block h-1.5 w-1.5 rounded-full " +
          (state === "saving" ? "animate-pulse" : "")
        }
        style={{ background: dotColor, boxShadow: `0 0 6px ${dotColor}80` }}
      />
      <span>{label}</span>
    </span>
  );
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

/** Convenience: a stable noop release function (for typed defaults). */
export function noopRelease(): void {
  /* no-op */
}

// Useful in tests / future workers.
export const __test__ = { formatRelative };

// Re-export so callers can grab a ref to the context if they want imperative
// access (rare; prefer the hook).
export const SaveStateContext = Ctx;
