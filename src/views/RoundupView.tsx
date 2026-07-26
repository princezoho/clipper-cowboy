import { useCallback, useEffect, useState } from "react";
import {
  RoundupCandidate,
  RoundupEvent,
  RoundupEventPresentation,
  RoundupInventoryJob,
  RoundupWatcherStatus,
  approveRoundupRoot,
  cancelRoundupInventory,
  exportRoundupCopy,
  fetchRoundup,
  fetchRoundupInventory,
  fetchRoundupWatcher,
  lookupRoundup,
  pauseRoundupInventory,
  prepareRoundupStemHandoff,
  recordRoundupEvent,
  revealPathInFinder,
  resumeRoundupInventory,
  setRoundupTrackable,
  startRoundupInventory,
  updateRoundupWatcher,
} from "../lib/api";
import { fireToast } from "../lib/toast";

/*
 * Clipper Roundup — AirTag-style media locator.
 * Paste an old path or filename → life trail + current location.
 * Primary handoff: Copy path + Reveal in Finder.
 */

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatExact(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ts));
}

type ApprovedRootReason =
  | "seedance"
  | "droplet"
  | "gunslinger_dropbox"
  | "gunslinger_seedance";

function rootReasonLabel(reason: RoundupWatcherStatus["roots"][number]["reason"]): string {
  if (reason === "gunslinger_dropbox") return "Gunslinger Dropbox";
  if (reason === "gunslinger_seedance") return "Gunslinger Seedance";
  return reason;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function fallbackPresentation(event: RoundupEvent): RoundupEventPresentation {
  const split = (value: string) => {
    const normalized = value.normalize("NFC");
    const index = normalized.lastIndexOf("/");
    return {
      name: index >= 0 ? normalized.slice(index + 1) : normalized,
      folder: index > 0 ? normalized.slice(0, index) : index === 0 ? "/" : "",
    };
  };
  const oldParts = split(event.oldPath);
  const newParts = split(event.newPath);
  const oldName = (event.oldName ?? oldParts.name).normalize("NFC");
  const newName = (event.newName ?? newParts.name).normalize("NFC");
  const nameChanged = oldName !== newName;
  const folderChanged = oldParts.folder !== newParts.folder;
  const extension = (name: string) => {
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index) : "";
  };
  return {
    classification:
      nameChanged && folderChanged
        ? "renamed_and_moved"
        : nameChanged
          ? "renamed"
          : folderChanged
            ? "moved"
            : "unknown",
    oldName,
    newName,
    oldFolder: oldParts.folder || null,
    newFolder: newParts.folder || null,
    nameChanged,
    folderChanged,
    extensionChanged: extension(oldName) !== extension(newName),
  };
}

function classificationLabel(
  classification: RoundupEventPresentation["classification"]
): string {
  switch (classification) {
    case "renamed_and_moved":
      return "Renamed + moved";
    case "renamed":
      return "Renamed";
    case "moved":
      return "Moved";
    case "derived_copy":
      return "Derived / copied";
    default:
      return "Recorded change";
  }
}

function sourceLabel(event: RoundupEvent): string {
  if (event.kind === "external_detected") return "External watcher";
  if (event.triggeredBy === "manual" || event.kind === "manual") return "Manual";
  return "Clipper";
}

function kindLabel(kind: RoundupEvent["kind"]): string {
  switch (kind) {
    case "pool_move":
      return "Pool move";
    case "library_rename":
      return "Clip rename";
    case "image_move":
      return "Image move";
    case "clip_restore":
      return "Restored";
    case "orphan_trash":
      return "Trashed orphan";
    case "external_detected":
      return "External watcher";
    case "manual":
      return "Manual";
    default:
      return kind;
  }
}

function matchLabel(match: RoundupCandidate["match"]): string {
  switch (match) {
    case "exact_path":
      return "Exact path";
    case "basename":
      return "Filename";
    case "fingerprint":
      return "Size / inode";
    case "tag":
      return "AirTag";
    case "path_prefix":
      return "Path";
    default:
      return match;
  }
}

function entityTone(entity: RoundupEvent["entityType"]): string {
  switch (entity) {
    case "pool":
      return "bg-sky-500/20 text-sky-300";
    case "library":
      return "bg-amber-500/20 text-amber-300";
    case "image":
      return "bg-emerald-500/20 text-emerald-300";
    default:
      return "bg-ink-700 text-ink-300";
  }
}

async function reveal(absPath: string) {
  try {
    await revealPathInFinder(absPath);
    fireToast({ kind: "success", title: "Revealed in Finder" });
  } catch (err) {
    fireToast({
      kind: "error",
      title: err instanceof Error ? err.message : String(err),
    });
  }
}

async function copyPath(absPath: string) {
  try {
    await navigator.clipboard.writeText(absPath);
    fireToast({
      kind: "success",
      title: "Path copied",
      body: "Paste the current location wherever you need it",
    });
  } catch {
    fireToast({ kind: "error", title: "Could not copy" });
  }
}

function EventMoment({
  event,
  latest = false,
  onViewHistory,
}: {
  event: RoundupEvent;
  latest?: boolean;
  onViewHistory?: (event: RoundupEvent) => void;
}) {
  const p = event.presentation ?? fallbackPresentation(event);
  const changedName = p.nameChanged ? "text-accent-400" : "text-ink-200";
  const changedFolder = p.folderChanged ? "text-amber-300" : "text-ink-400";
  return (
    <article
      className={
        "rounded-md border p-3 " +
        (latest
          ? "border-accent-500/50 bg-accent-500/[0.04]"
          : "border-ink-800 bg-ink-950/30")
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-accent-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-black">
            {classificationLabel(p.classification)}
          </span>
          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-300">
            {sourceLabel(event)}
          </span>
          {latest && (
            <span className="text-[10px] uppercase tracking-wide text-accent-400">
              Latest hop
            </span>
          )}
        </div>
        <div className="text-right">
          <time
            dateTime={new Date(event.ts).toISOString()}
            className="block text-xs text-ink-200"
          >
            {formatExact(event.ts)}
          </time>
          <span className="text-[10px] text-ink-500">
            {formatRelative(event.ts)}
          </span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-2 gap-y-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-600">Old name</div>
          <div className={`mt-0.5 break-words font-mono text-xs ${changedName}`}>
            {p.oldName ?? "Unavailable"}
          </div>
        </div>
        <span aria-hidden="true" className="self-end pb-0.5 text-ink-600">→</span>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-600">New name</div>
          <div className={`mt-0.5 break-words font-mono text-xs ${changedName}`}>
            {p.newName ?? "Unavailable"}
            {p.extensionChanged && (
              <span className="ml-2 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] uppercase text-amber-300">
                extension changed
              </span>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-600">From folder</div>
          <div className={`mt-0.5 break-words font-mono text-[11px] ${changedFolder}`}>
            {p.oldFolder ?? "Unavailable"}
          </div>
        </div>
        <span aria-hidden="true" className="self-end pb-0.5 text-ink-600">→</span>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-ink-600">To folder</div>
          <div className={`mt-0.5 break-words font-mono text-[11px] ${changedFolder}`}>
            {p.newFolder ?? "Unavailable"}
          </div>
        </div>
      </div>

      <details className="mt-3 rounded border border-ink-800 bg-ink-950/50 px-2.5 py-2 text-[11px]">
        <summary className="cursor-pointer select-none text-ink-400 hover:text-ink-200">
          Full paths and identity
        </summary>
        <dl className="mt-2 space-y-2">
          <div>
            <dt className="text-[10px] uppercase text-ink-600">Old path</dt>
            <dd className="break-all font-mono text-ink-400">{event.oldPath}</dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase text-ink-600">Current path</dt>
            <dd className="break-all font-mono text-ink-200">{event.newPath}</dd>
          </div>
          {event.tagId && (
            <div>
              <dt className="text-[10px] uppercase text-ink-600">AirTag UUID</dt>
              <dd className="break-all font-mono text-accent-400">{event.tagId}</dd>
            </div>
          )}
        </dl>
      </details>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-800" onClick={() => copyPath(event.oldPath)}>
          Copy old path
        </button>
        <button type="button" className="rounded bg-accent-500 px-2 py-1 text-[11px] font-medium text-black hover:bg-accent-400" onClick={() => copyPath(event.newPath)}>
          Copy current path
        </button>
        <button type="button" disabled={!event.exists} className="rounded border border-amber-700/70 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/10 disabled:opacity-40" onClick={() => reveal(event.newPath)}>
          Reveal current file
        </button>
        {onViewHistory && (
          <button type="button" className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-300 hover:bg-ink-800" onClick={() => onViewHistory(event)}>
            View full life history
          </button>
        )}
      </div>
    </article>
  );
}

function LifeTrail({ candidate }: { candidate: RoundupCandidate }) {
  const [open, setOpen] = useState(true);
  const hops = candidate.history.length;
  if (hops <= 0 && candidate.trail.length <= 1) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        className="text-[11px] font-medium text-amber-300 underline-offset-2 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? "Hide full life history"
          : `View full life history · ${hops} hop${hops === 1 ? "" : "s"}`}
      </button>
      {open && (
        <ol className="mt-2 space-y-2">
          {candidate.history.map((hop, i) => (
            <li key={`${hop.ts}-${hop.oldPath}-${i}`}>
              <EventMoment
                event={hop}
                latest={i === candidate.history.length - 1}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LocatorActions({
  path,
  exists,
}: {
  path: string;
  exists: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-black hover:bg-accent-400"
          onClick={() => copyPath(path)}
        >
          Copy path
        </button>
        <button
          type="button"
          className="rounded-md border border-amber-600/60 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
          disabled={!exists}
          onClick={() => reveal(path)}
        >
          Reveal in Finder
        </button>
      </div>
      <p className="max-w-[14rem] text-[10px] leading-snug text-ink-600 sm:text-right">
        Locator handoff: copy the current path or reveal the file in Finder.
      </p>
    </div>
  );
}

export default function RoundupView() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<RoundupCandidate[] | null>(null);
  const [events, setEvents] = useState<RoundupEvent[]>([]);
  const [watcher, setWatcher] = useState<RoundupWatcherStatus | null>(null);
  const [loadingLookup, setLoadingLookup] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showManual, setShowManual] = useState(false);
  const [manualOld, setManualOld] = useState("");
  const [manualNew, setManualNew] = useState("");
  const [recording, setRecording] = useState(false);
  const [savingWatcher, setSavingWatcher] = useState(false);
  const [inventory, setInventory] = useState<RoundupInventoryJob | null>(null);
  const [approvedPath, setApprovedPath] = useState("");
  const [approvedLabel, setApprovedLabel] = useState("Seedance / Gunslinger");
  const [approvedReason, setApprovedReason] =
    useState<ApprovedRootReason>("gunslinger_seedance");
  const [approvalChecked, setApprovalChecked] = useState(false);

  const reloadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const r = await fetchRoundup(100);
      setEvents(r.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const reloadWatcher = useCallback(async () => {
    try {
      setWatcher(await fetchRoundupWatcher());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    reloadHistory();
    reloadWatcher();
  }, [reloadHistory, reloadWatcher]);

  useEffect(() => {
    if (!inventory || !["queued", "running"].includes(inventory.status)) return;
    const timer = window.setInterval(async () => {
      try {
        setInventory(await fetchRoundupInventory(inventory.id));
      } catch {
        // Keep the last safe progress snapshot.
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [inventory?.id, inventory?.status]);

  async function runLookup(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (!q) {
      setCandidates(null);
      return;
    }
    setLoadingLookup(true);
    setError(null);
    try {
      const r = await lookupRoundup({ q, limit: 30 });
      setCandidates(r.candidates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCandidates([]);
    } finally {
      setLoadingLookup(false);
    }
  }

  async function viewFullHistory(event: RoundupEvent) {
    const q = event.oldPath;
    setQuery(q);
    setLoadingLookup(true);
    setError(null);
    try {
      const result = await lookupRoundup({ q, limit: 30 });
      setCandidates(result.candidates);
      window.requestAnimationFrame(() => {
        document
          .getElementById("roundup-life-history")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCandidates([]);
    } finally {
      setLoadingLookup(false);
    }
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manualOld.trim() || !manualNew.trim()) return;
    setRecording(true);
    try {
      await recordRoundupEvent({
        oldPath: manualOld.trim(),
        newPath: manualNew.trim(),
        kind: "manual",
      });
      fireToast({ kind: "success", title: "Recorded in Roundup" });
      setManualOld("");
      setManualNew("");
      setShowManual(false);
      await reloadHistory();
    } catch (err) {
      fireToast({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRecording(false);
    }
  }

  async function toggleWatching(enabled: boolean) {
    setSavingWatcher(true);
    try {
      const next = await updateRoundupWatcher({ enabled });
      setWatcher(next);
      fireToast({
        kind: next.state === "degraded" ? "error" : "success",
        title:
          next.state === "degraded"
            ? "Roundup watcher degraded"
            : enabled
              ? "Roundup watching on"
              : "Roundup watching off",
        ...(next.lastError ? { body: next.lastError } : {}),
      });
    } catch (err) {
      fireToast({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingWatcher(false);
    }
  }

  async function toggleRoot(
    id: RoundupWatcherStatus["roots"][0]["id"],
    enabled: boolean
  ) {
    setSavingWatcher(true);
    try {
      setWatcher(await updateRoundupWatcher({ root: { id, enabled } }));
    } catch (err) {
      fireToast({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingWatcher(false);
    }
  }

  async function toggleTrackable(c: RoundupCandidate, trackable: boolean) {
    try {
      const { tag } = await setRoundupTrackable({
        trackable,
        ...(c.tag?.id ? { id: c.tag.id } : { path: c.currentPath }),
      });
      setCandidates((prev) =>
        prev
          ? prev.map((row) =>
              row.currentPath === c.currentPath || row.tag?.id === tag.id
                ? { ...row, tag }
                : row
            )
          : prev
      );
      fireToast({
        kind: "success",
        title: trackable ? "Lassoed — tracking on" : "Untagged — tracking off",
      });
    } catch (err) {
      fireToast({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function approveRoot(e: React.FormEvent) {
    e.preventDefault();
    if (!approvalChecked) return;
    try {
      const status = await approveRoundupRoot({
        path: approvedPath.trim(),
        label: approvedLabel.trim(),
        reason: approvedReason,
        approved: true,
      });
      setWatcher(status);
      setApprovedPath("");
      setApprovalChecked(false);
      fireToast({ kind: "success", title: "Safe media root approved" });
    } catch (err) {
      fireToast({
        kind: "error",
        title: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function startInventory() {
    try {
      setInventory(
        await startRoundupInventory({
          rootIds:
            watcher?.roots
              .filter((root) => root.inventoryEligible && root.enabled)
              .map((root) => root.id) ?? [],
          limit: 1000,
        })
      );
    } catch (err) {
      fireToast({ kind: "error", title: err instanceof Error ? err.message : String(err) });
    }
  }

  async function exportCopy(source: string) {
    try {
      const result = await exportRoundupCopy(source);
      await navigator.clipboard.writeText(result.outputPath);
      fireToast({
        kind: "success",
        title: "New high-fidelity copy created",
        body: "Output path copied. The original was not changed.",
      });
    } catch (err) {
      fireToast({ kind: "error", title: err instanceof Error ? err.message : String(err) });
    }
  }

  async function prepareStems(source: string) {
    if (
      !window.confirm(
        "Prepare this file for the official Stem Studio MCP handoff? This confirms external processing may receive the media. No model will run now."
      )
    ) return;
    try {
      const result = await prepareRoundupStemHandoff(source);
      await navigator.clipboard.writeText(result.manifestPath);
      fireToast({
        kind: "success",
        title: "Stems handoff prepared",
        body: "Manifest path copied. No setup, model, or separation was started.",
      });
    } catch (err) {
      fireToast({ kind: "error", title: err instanceof Error ? err.message : String(err) });
    }
  }

  const empty = candidates !== null && candidates.length === 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 px-5 py-8">
      {/* Brand header — supplied vector mark plus supplied lasso animation */}
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          <img
            src="/roundup/lasso.svg"
            alt=""
            className="h-14 w-14"
            width={56}
            height={56}
          />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-ink-100">
            Clipper Roundup
          </h1>
          <p className="mt-1 max-w-xl text-sm text-ink-400">
            AirTag for your footage. Media stays trackable across renames and
            moves through approved roots — paste an old path or filename, copy
            the current one, or Reveal in Finder.
          </p>
        </div>
        <img
          src="/roundup/lasso-spin.gif"
          alt=""
          className="hidden h-16 w-auto opacity-90 sm:block"
          width={90}
          height={64}
        />
      </div>

      {watcher && (
        <section className="flex flex-col gap-3 rounded-md border border-ink-800 bg-ink-900/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[11px] uppercase tracking-wider text-ink-500">
                Local watcher
              </h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Media only. Inventory access is separate from live watching.
                {watcher.state === "watched" ? (
                  <span className="ml-2 text-emerald-400">● Watched</span>
                ) : watcher.state === "degraded" ? (
                  <span className="ml-2 text-red-400">● Degraded</span>
                ) : watcher.state === "starting" ? (
                  <span className="ml-2 text-amber-400">○ starting…</span>
                ) : (
                  <span className="ml-2 text-ink-500">○ off</span>
                )}
              </p>
              {watcher.lastError && (
                <p className="mt-1 max-w-xl text-[11px] text-red-300">
                  {watcher.lastError}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={savingWatcher}
              onClick={() => toggleWatching(!watcher.enabled)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40 " +
                (watcher.enabled
                  ? "border border-ink-600 text-ink-200 hover:bg-ink-800"
                  : "bg-accent-500 text-black hover:bg-accent-400")
              }
            >
              {watcher.enabled ? "Turn off" : "Turn on"}
            </button>
          </div>

          <ul className="grid gap-1.5 sm:grid-cols-2">
            {watcher.roots.map((root) => (
              <li
                key={root.id}
                className="flex items-center gap-2 rounded border border-ink-800/80 bg-ink-950/50 px-2.5 py-1.5"
              >
                <input
                  type="checkbox"
                  id={`roundup-root-${root.id}`}
                  checked={root.enabled}
                  disabled={
                    savingWatcher ||
                    !watcher.enabled ||
                    !root.allowed ||
                    !root.exists
                  }
                  onChange={(e) => toggleRoot(root.id, e.target.checked)}
                  className="accent-accent-500"
                />
                <label
                  htmlFor={`roundup-root-${root.id}`}
                  className="min-w-0 flex-1 cursor-pointer"
                >
                  <div className="flex items-center gap-2 text-xs text-ink-200">
                    <span>{root.label}</span>
                    <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-500">
                      {rootReasonLabel(root.reason)}
                    </span>
                    <span
                      className={
                        root.enabled ? "text-emerald-400" : "text-amber-400"
                      }
                    >
                      {root.enabled ? "Watched" : "Inventory only"}
                    </span>
                  </div>
                  <div
                    className="truncate font-mono text-[10px] text-ink-600"
                    title={root.path}
                  >
                    {!root.exists
                      ? "not found"
                      : !root.allowed
                        ? "blocked"
                        : root.path}
                  </div>
                </label>
              </li>
            ))}
          </ul>
          <form
            onSubmit={approveRoot}
            className="grid gap-2 rounded border border-ink-800 bg-ink-950/40 p-3 sm:grid-cols-2"
          >
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-ink-300">Approve another media root</p>
              <p className="text-[10px] text-ink-600">
                Use this when Seedance/Gunslinger or a droplet destination was not found in the project. Existing folders only; the server applies the same safe-root and canonical-path checks.
              </p>
            </div>
            <input
              value={approvedPath}
              onChange={(e) => setApprovedPath(e.target.value)}
              placeholder="/absolute/path/to/folder"
              className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-xs text-ink-200"
            />
            <input
              value={approvedLabel}
              onChange={(e) => setApprovedLabel(e.target.value)}
              placeholder="Folder label"
              className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs text-ink-200"
            />
            <select
              value={approvedReason}
              onChange={(e) => setApprovedReason(e.target.value as ApprovedRootReason)}
              className="rounded border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs text-ink-200"
            >
              <option value="seedance">Seedance / Gunslinger</option>
              <option value="gunslinger_seedance">Gunslinger Seedance</option>
              <option value="gunslinger_dropbox">Gunslinger Dropbox</option>
              <option value="droplet">Droplet destination</option>
            </select>
            <label className="flex items-center gap-2 text-[11px] text-ink-400">
              <input
                type="checkbox"
                checked={approvalChecked}
                onChange={(e) => setApprovalChecked(e.target.checked)}
                className="accent-accent-500"
              />
              I approve inventory and active metadata-only watching for this folder.
            </label>
            <button
              type="submit"
              disabled={!approvedPath.trim() || !approvedLabel.trim() || !approvalChecked}
              className="self-start rounded border border-ink-600 px-3 py-1.5 text-xs text-ink-200 disabled:opacity-40 sm:col-span-2"
            >
              Validate and approve
            </button>
          </form>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-md border border-ink-800 bg-ink-900/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[11px] uppercase tracking-wider text-ink-500">
              Safe media inventory
            </h2>
            <p className="mt-1 max-w-2xl text-xs text-ink-400">
              Track / Locate reads media metadata and assigns AirTag UUIDs. Export Copy creates a new byte-for-byte file under derived/roundup. Stems Handoff only prepares a confirmed manifest for the official MCP.
            </p>
            <p className="mt-1 text-xs font-medium text-emerald-400">
              Creates new files; originals are never changed or deleted.
            </p>
          </div>
          <div className="flex gap-2">
            {inventory && ["queued", "running"].includes(inventory.status) ? (
              <>
                <button
                  type="button"
                  onClick={async () => setInventory(await pauseRoundupInventory(inventory.id))}
                  className="rounded border border-ink-600 px-3 py-1.5 text-xs text-ink-300"
                >
                  Pause
                </button>
                <button
                  type="button"
                  onClick={async () => setInventory(await cancelRoundupInventory(inventory.id))}
                  className="rounded border border-red-900/60 px-3 py-1.5 text-xs text-red-300"
                >
                  Cancel
                </button>
              </>
            ) : inventory?.status === "paused" ? (
              <>
                <button
                  type="button"
                  onClick={async () => setInventory(await resumeRoundupInventory(inventory.id))}
                  className="rounded bg-accent-500 px-3 py-1.5 text-xs font-semibold text-black"
                >
                  Resume next batch
                </button>
                <button
                  type="button"
                  onClick={async () => setInventory(await cancelRoundupInventory(inventory.id))}
                  className="rounded border border-red-900/60 px-3 py-1.5 text-xs text-red-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startInventory}
                disabled={
                  !watcher?.roots.some(
                    (root) => root.inventoryEligible && root.enabled
                  )
                }
                className="rounded bg-accent-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40"
              >
                Start resumable inventory
              </button>
            )}
          </div>
        </div>

        {inventory && (
          <>
            <div className="flex flex-wrap gap-3 text-[11px] text-ink-500">
              <span>Status: {inventory.status}</span>
              <span>Files checked: {inventory.scanned}</span>
              <span>Media covered: {inventory.discovered}</span>
              <span>New tags: {inventory.tagged}</span>
              <span>Already tagged: {inventory.alreadyTagged}</span>
              <span>Batch size: {inventory.limit}</span>
              <span>Bytes: {formatBytes(inventory.totalBytes)}</span>
              <span>Skipped: {inventory.skipped}</span>
              <span>Placeholders: {inventory.placeholderSkips}</span>
              <span>Errors: {inventory.errors}</span>
              <span>
                Inventory: {inventory.complete ? "complete" : inventory.capped ? "capped" : "partial"}
              </span>
              <span>AirTag: default on</span>
            </div>
            <ul className="max-h-96 divide-y divide-ink-800 overflow-auto rounded border border-ink-800">
              {inventory.items.slice(0, 100).map((item) => (
                <li key={item.identity} className="flex flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[10px]">
                    <span className="rounded bg-accent-500/20 px-1.5 py-0.5 text-accent-400">
                      AirTag {item.identity.slice(0, 8)}
                    </span>
                    <span className="uppercase text-ink-500">{item.mediaKind}</span>
                    <span className="text-ink-600">{item.sourceRootReason}</span>
                    {item.stemsEligible && <span className="text-violet-400">stems eligible</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-ink-200" title={item.source}>
                    {item.source}
                  </div>
                  <div className="truncate font-mono text-[10px] text-ink-600" title={item.intendedExportDestination}>
                    Preview → {item.intendedExportDestination} · unique/no overwrite
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => exportCopy(item.source)}
                      className="rounded bg-accent-500 px-2.5 py-1 text-xs font-medium text-black"
                    >
                      Export Copy
                    </button>
                    {item.stemsEligible && (
                      <button
                        type="button"
                        onClick={() => prepareStems(item.source)}
                        className="rounded border border-violet-700/70 px-2.5 py-1 text-xs text-violet-300"
                      >
                        Prepare Stems Handoff
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => reveal(item.source)}
                      className="rounded border border-ink-700 px-2.5 py-1 text-xs text-ink-300"
                    >
                      Reveal source
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section id="roundup-life-history" className="flex flex-col gap-3 scroll-mt-4">
        <h2 className="text-[11px] uppercase tracking-wider text-ink-500">
          Locate tracked media
        </h2>
        <form onSubmit={runLookup} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Paste an old path or filename…"
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-sm text-ink-100 placeholder:text-ink-600 focus:border-accent-500 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
            data-testid="roundup-query"
          />
          <button
            type="submit"
            disabled={loadingLookup || !query.trim()}
            className="rounded-md bg-accent-500 px-4 py-2 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-40"
          >
            {loadingLookup ? "Searching…" : "Round up"}
          </button>
        </form>

        {error && (
          <div className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {empty && (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-ink-800 px-4 py-10 text-center">
            <img
              src="/roundup/lasso-spin.gif"
              alt=""
              className="h-20 w-auto opacity-80"
              width={112}
              height={80}
            />
            <p className="max-w-sm text-sm text-ink-500">
              No matches yet. Keep watching on — when Seedance or a renamer
              moves footage, Roundup keeps the AirTag trail.
            </p>
          </div>
        )}

        {candidates !== null && candidates.length > 0 && (
          <div className="overflow-hidden rounded-md border border-ink-800">
            <ul className="divide-y divide-ink-800">
              {candidates.map((c, i) => {
                const tracking = c.tag?.trackable !== false && Boolean(c.tag);
                return (
                  <li
                    key={`${c.currentPath}-${c.event.ts}-${i}`}
                    className="px-4 py-4"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={
                              "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide " +
                              entityTone(c.event.entityType)
                            }
                          >
                            {c.event.entityType}
                          </span>
                          <span className="text-[10px] text-ink-500">
                            {matchLabel(c.match)} · {kindLabel(c.event.kind)}
                          </span>
                          <span
                            className={
                              c.currentExists
                                ? "text-[10px] text-emerald-400"
                                : "text-[10px] text-amber-400"
                            }
                          >
                            {c.currentExists ? "on disk" : "missing"}
                          </span>
                          {c.tag ? (
                            <span
                              className={
                                tracking
                                  ? "rounded bg-accent-500/20 px-1.5 py-0.5 text-[10px] text-accent-400"
                                  : "rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-ink-400"
                              }
                              title={c.tag.id}
                            >
                              {tracking
                                ? `AirTag ${c.tag.id.slice(0, 8)} · Trackable`
                                : `AirTag ${c.tag.id.slice(0, 8)} · Untagged`}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 break-all font-mono text-sm text-ink-100">
                          {c.currentPath}
                        </div>
                        <LifeTrail candidate={c} />
                        <div className="mt-2">
                          {c.tag ? (
                            <button
                              type="button"
                              className="text-[11px] text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline"
                              onClick={() =>
                                toggleTrackable(c, !c.tag!.trackable)
                              }
                            >
                              {c.tag.trackable
                                ? "Stop tracking (untag)"
                                : "Lasso again — resume tracking"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-[11px] text-amber-400/90 underline-offset-2 hover:underline"
                              onClick={() => toggleTrackable(c, true)}
                            >
                              Lasso — start tracking
                            </button>
                          )}
                        </div>
                      </div>
                      <LocatorActions
                        path={c.currentPath}
                        exists={c.currentExists}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <button
          type="button"
          className="self-start text-xs text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline"
          onClick={() => setShowManual((v) => !v)}
        >
          {showManual ? "Hide manual entry" : "Record a move manually…"}
        </button>
        {showManual && (
          <form
            onSubmit={submitManual}
            className="flex flex-col gap-2 rounded-md border border-ink-800 bg-ink-900/50 p-3"
          >
            <p className="text-xs text-ink-500">
              Absolute media paths only. Creates / updates an AirTag by default.
            </p>
            <input
              type="text"
              value={manualOld}
              onChange={(e) => setManualOld(e.target.value)}
              placeholder="Old absolute path"
              className="rounded-md border border-ink-700 bg-ink-950 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-600 focus:border-accent-500 focus:outline-none"
              spellCheck={false}
            />
            <input
              type="text"
              value={manualNew}
              onChange={(e) => setManualNew(e.target.value)}
              placeholder="New absolute path"
              className="rounded-md border border-ink-700 bg-ink-950 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-600 focus:border-accent-500 focus:outline-none"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={recording || !manualOld.trim() || !manualNew.trim()}
              className="self-start rounded-md border border-ink-600 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-800 disabled:opacity-40"
            >
              {recording ? "Saving…" : "Save mapping"}
            </button>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-wider text-ink-500">
            Recent moves
          </h2>
          <button
            type="button"
            className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-400 hover:bg-ink-800"
            onClick={() => {
              reloadHistory();
              reloadWatcher();
            }}
          >
            {loadingHistory ? "…" : "Refresh"}
          </button>
        </div>

        {events.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-ink-800 px-4 py-10 text-center">
            <img
              src="/roundup/lasso.svg"
              alt=""
              className="h-12 w-12 opacity-70"
              width={48}
              height={48}
            />
            <p className="max-w-sm text-sm text-ink-500">
              No hops yet. Clipper moves and watched Finder renames build the
              trail automatically.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {events.map((ev, i) => (
              <li key={`${ev.ts}-${i}`}>
                <EventMoment
                  event={ev}
                  latest={i === 0}
                  onViewHistory={viewFullHistory}
                />
              </li>
            ))}
          </ul>
        )}

        <p className="text-[11px] text-ink-600">
          Cloud Dropbox/Drive folder watching is still later. This page uses
          only the local supplied lasso assets for its branding.
        </p>
      </section>
    </div>
  );
}
