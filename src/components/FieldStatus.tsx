import { useEffect, useState } from "react";

export type FieldState = "idle" | "pending" | "saving" | "saved" | "error";

interface Props {
  state: FieldState;
  errorMessage?: string | null;
  className?: string;
}

/**
 * Tiny per-field autosave indicator (~12px tall). Renders nothing for `idle`,
 * and auto-fades to nothing 1.5s after entering `saved`.
 */
export default function FieldStatus({ state, errorMessage, className }: Props) {
  const [hideSaved, setHideSaved] = useState(false);

  useEffect(() => {
    if (state === "saved") {
      setHideSaved(false);
      const h = window.setTimeout(() => setHideSaved(true), 1500);
      return () => window.clearTimeout(h);
    }
    setHideSaved(false);
    return undefined;
  }, [state]);

  if (state === "idle") return null;
  if (state === "saved" && hideSaved) return null;

  const wrap = "inline-flex h-3 items-center gap-1 text-[10px] leading-none " + (className ?? "");

  if (state === "pending") {
    return (
      <span className={wrap} title="Pending — debouncing" data-testid="field-status" data-state="pending">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: "#facc15", boxShadow: "0 0 4px #facc1580" }}
        />
      </span>
    );
  }
  if (state === "saving") {
    return (
      <span className={wrap} title="Saving…" data-testid="field-status" data-state="saving">
        <span
          className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-ink-500 border-t-transparent"
          aria-label="saving"
        />
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span
        className={wrap}
        title="Saved"
        data-testid="field-status"
        data-state="saved"
        style={{ color: "#22c55e", transition: "opacity 200ms ease" }}
      >
        ✓
      </span>
    );
  }
  // error
  return (
    <span
      className={wrap}
      title={errorMessage ?? "Save failed"}
      data-testid="field-status"
      data-state="error"
      style={{ color: "#ef4444" }}
    >
      ✗
    </span>
  );
}
