import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldState } from "../components/FieldStatus";
import { useSaveState } from "./saveState";

export interface UseDebouncedAutosaveOpts {
  debounceMs?: number;
}

export interface UseDebouncedAutosaveResult {
  state: FieldState;
  errorMessage: string | null;
  flush: () => Promise<void>;
}

/**
 * Debounces a value and persists it via `save(value)` after the user stops
 * typing. Reports its own per-field state and contributes to the global
 * `useSaveState` save indicator while a request is in flight.
 *
 * - Initial render does not trigger a save (we capture the initial value).
 * - If `value` changes during a save, queues a follow-up save when the
 *   in-flight one resolves.
 * - `flush()` cancels the debounce and saves immediately.
 */
export function useDebouncedAutosave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  opts: UseDebouncedAutosaveOpts = {}
): UseDebouncedAutosaveResult {
  const { debounceMs = 800 } = opts;
  const saveStore = useSaveState();

  const [state, setState] = useState<FieldState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const initialValueRef = useRef<T>(value);
  const lastSavedValueRef = useRef<T>(value);
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);
  const queuedValueRef = useRef<{ v: T } | null>(null);
  const saveRef = useRef(save);
  const valueRef = useRef(value);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const performSave = useCallback(
    async (v: T) => {
      setState("saving");
      const release = saveStore.markPending();
      try {
        await saveRef.current(v);
        lastSavedValueRef.current = v;
        // If the value didn't change while the request was in flight, we're saved.
        if (Object.is(valueRef.current, v) || shallowEqual(valueRef.current, v)) {
          setState("saved");
          setErrorMessage(null);
        } else {
          // queueing handled in caller wrapper
        }
        release();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg);
        setState("error");
        saveStore.markError(msg);
      }
    },
    [saveStore]
  );

  const runSave = useCallback(
    async (v: T) => {
      // If a save is already in flight, queue this value to run after.
      if (inflightRef.current) {
        queuedValueRef.current = { v };
        return;
      }
      const p = performSave(v);
      inflightRef.current = p;
      try {
        await p;
      } finally {
        inflightRef.current = null;
        const queued = queuedValueRef.current;
        queuedValueRef.current = null;
        if (queued) {
          // Fire-and-forget; recursion is bounded by user typing.
          void runSave(queued.v);
        }
      }
    },
    [performSave]
  );

  // Debounce on value changes (skip initial mount).
  useEffect(() => {
    if (Object.is(value, initialValueRef.current)) return;
    if (shallowEqual(value, lastSavedValueRef.current)) {
      // Reverted to last-saved; clear pending state.
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setState((s) => (s === "pending" ? "idle" : s));
      return;
    }
    setState("pending");
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runSave(valueRef.current);
    }, debounceMs);
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, debounceMs, runSave]);

  const flush = useCallback(async () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (shallowEqual(valueRef.current, lastSavedValueRef.current)) return;
    await runSave(valueRef.current);
  }, [runSave]);

  return { state, errorMessage, flush };
}

function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  return false;
}
