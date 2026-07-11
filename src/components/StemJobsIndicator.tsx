import { useEffect, useRef, useState } from "react";
import {
  StemJobSummary,
  cancelStemJob,
  fetchStemJobs,
  revealStemJob,
  revealStemsRoot,
} from "../lib/api";
import { fireToast } from "../lib/toast";

function isActive(job: StemJobSummary): boolean {
  return job.status === "queued" || job.status === "running";
}

function statusTone(status: StemJobSummary["status"]): string {
  if (status === "done") return "text-emerald-300";
  if (status === "error" || status === "interrupted") return "text-red-300";
  if (status === "cancelled") return "text-ink-500";
  return "text-amber-300";
}

const stemsActionLabel =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "Show stems in Finder"
    : "Open stems folder";

async function revealJob(id: string): Promise<void> {
  try {
    await revealStemJob(id);
  } catch {
    fireToast({
      kind: "error",
      title: "Could not open stems folder",
      body: "It may have been moved or is no longer available.",
    });
  }
}

async function revealRoot(): Promise<void> {
  try {
    await revealStemsRoot();
  } catch {
    fireToast({
      kind: "error",
      title: "Could not open Audio Stems folder",
      body: "Try completing another audio split, then try again.",
    });
  }
}

export default function StemJobsIndicator({
  enabled,
  configured,
}: {
  enabled: boolean;
  configured: boolean;
}) {
  const [jobs, setJobs] = useState<StemJobSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const previousRef = useRef<Map<string, StemJobSummary["status"]>>(new Map());
  const initializedRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      let nextDelay = 10_000;
      try {
        const response = await fetchStemJobs();
        if (disposed) return;
        const next = response.items;
        if (initializedRef.current) {
          for (const job of next) {
            const before = previousRef.current.get(job.id);
            if ((before === "queued" || before === "running") && job.status === "done") {
              fireToast({
                kind: "success",
                title: "Audio splitting is ready",
                body: `${job.clipName} · ${job.quality} quality`,
                action: {
                  label: stemsActionLabel,
                  onClick: () => void revealJob(job.id),
                },
              });
            }
            if (
              (before === "queued" || before === "running") &&
              (job.status === "error" || job.status === "interrupted")
            ) {
              fireToast({
                kind: "error",
                title: "Audio splitting stopped",
                body: `${job.clipName}: ${job.error || "Open Audio splitting for details."}`,
                durationMs: 7000,
              });
            }
          }
        }
        previousRef.current = new Map(next.map((job) => [job.id, job.status]));
        initializedRef.current = true;
        setJobs(next);
        if (next.some(isActive)) nextDelay = 2_000;
      } catch {
        // The normal app error surface handles server availability. Keep the
        // background indicator quiet and try again later.
      } finally {
        if (!disposed) timer = window.setTimeout(poll, nextDelay);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!configured && jobs.length === 0) return null;

  const running = jobs.filter((job) => job.status === "running").length;
  const queued = jobs.filter((job) => job.status === "queued").length;
  const active = running + queued;
  const hasCompleted = jobs.some((job) => job.status === "done");

  async function cancel(job: StemJobSummary): Promise<void> {
    setCancelling(job.id);
    try {
      const updated = await cancelStemJob(job.id);
      setJobs((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      );
    } catch {
      fireToast({
        kind: "error",
        title: "Could not cancel stem job",
        body: "Try again in a moment.",
      });
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={
          "rounded-full border px-2.5 py-1 transition " +
          (active
            ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
            : "border-ink-700 bg-ink-900 text-ink-300 hover:bg-ink-800")
        }
        aria-expanded={open}
        title="Background audio splitting jobs"
      >
        {active > 0
          ? `Stems: ${running ? `${running} running` : ""}${
              running && queued ? " · " : ""
            }${queued ? `${queued} queued` : ""}`
          : "Audio"}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-[24rem] overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-xl shadow-black/50">
          <div className="border-b border-ink-800 px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-ink-100">
                Background audio splitting
              </div>
              {hasCompleted && (
                <button
                  type="button"
                  onClick={() => void revealRoot()}
                  className="shrink-0 text-[10px] text-accent-300 hover:underline"
                >
                  {stemsActionLabel}
                </button>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-ink-500">
              One local separation runs at a time, so editing stays responsive.
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {jobs.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-ink-500">
                Audio stems appear here after a split completes.
              </div>
            ) : (
              jobs.slice(0, 10).map((job) => (
                <div
                  key={job.id}
                  className="border-b border-ink-800/80 px-3 py-2 last:border-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-ink-100">
                        {job.clipName}
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-500">
                        {job.quality} · {job.stage || job.status}
                      </div>
                    </div>
                    <span className={`text-[11px] ${statusTone(job.status)}`}>
                      {job.status === "running"
                        ? `${Math.max(0, Math.round(job.percent))}%`
                        : job.status}
                    </span>
                  </div>
                  {job.status === "running" && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded bg-ink-800">
                      <div
                        className="h-full rounded bg-amber-400 transition-all"
                        style={{ width: `${Math.max(1, Math.min(100, job.percent))}%` }}
                      />
                    </div>
                  )}
                  {job.error && (
                    <div className="mt-1 text-[10px] leading-4 text-red-300">
                      {job.error}
                    </div>
                  )}
                  {job.status === "done" && (
                    <div className="mt-1 text-[10px] text-ink-500">
                      Saved in this project&apos;s Audio Stems folder.
                    </div>
                  )}
                  <div className="mt-1 flex justify-end gap-2">
                    {job.status === "done" && (
                      <button
                        type="button"
                        onClick={() => void revealJob(job.id)}
                        className="text-[10px] text-accent-300 hover:underline"
                      >
                        {stemsActionLabel}
                      </button>
                    )}
                    {isActive(job) && (
                      <button
                        type="button"
                        disabled={cancelling === job.id}
                        onClick={() => void cancel(job)}
                        className="text-[10px] text-ink-400 hover:text-red-300 disabled:opacity-50"
                      >
                        {cancelling === job.id ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
