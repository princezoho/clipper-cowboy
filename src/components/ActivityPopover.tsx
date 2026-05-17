import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityEvent, ActivityKind, fetchActivity } from "../lib/api";

/*
 * Header popover for the append-only activity log. Reads the tail from
 * `/api/activity?limit=…`, polls every 30s while open, and renders one
 * row per event. Click-outside closes. "Show all" expands the panel and
 * bumps the limit to 200 — no separate modal yet (mockup spec C.4).
 */

interface Props {
  openOnMount?: boolean;
}

export default function ActivityPopover({ openOnMount = false }: Props) {
  const [open, setOpen] = useState(openOnMount);
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [unseenCount, setUnseenCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeenTsRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const limit = expanded ? 200 : 10;

  const refetch = useCallback(
    async (n: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetchActivity(n);
        setEvents(r.events);
        const newest = r.events[0]?.ts ?? 0;
        setUnseenCount((prev) => {
          if (open) {
            lastSeenTsRef.current = newest;
            return 0;
          }
          let count = 0;
          for (const e of r.events) {
            if (e.ts > lastSeenTsRef.current) count += 1;
          }
          return Math.max(prev, count);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [open]
  );

  // Initial load (single shot) so the badge can appear without opening.
  useEffect(() => {
    refetch(10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while open. We don't poll while closed — the badge will catch up
  // next time the popover opens or the user mounts the app.
  useEffect(() => {
    if (!open) return undefined;
    refetch(limit);
    const handle = window.setInterval(() => {
      refetch(limit);
    }, 30_000);
    return () => window.clearInterval(handle);
  }, [open, limit, refetch]);

  // Click-outside.
  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setExpanded(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) {
        const newest = events[0]?.ts ?? 0;
        lastSeenTsRef.current = Math.max(lastSeenTsRef.current, newest);
        setUnseenCount(0);
      } else {
        setExpanded(false);
      }
      return next;
    });
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        className="inline-flex items-center gap-1 rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-800"
        onClick={toggle}
        title="Recent activity"
        data-testid="activity-toggle"
      >
        <span aria-hidden>⏱</span>
        <span className="hidden sm:inline">Activity</span>
        {unseenCount > 0 && !open && (
          <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium text-black">
            {unseenCount > 99 ? "99+" : unseenCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={
            "absolute right-0 z-40 mt-2 w-80 overflow-auto rounded-md border border-ink-700 bg-ink-900 shadow-lg " +
            (expanded ? "max-h-[80vh]" : "max-h-96")
          }
          data-testid="activity-popover"
        >
          <div className="sticky top-0 flex items-center justify-between border-b border-ink-800 bg-ink-900/95 px-3 py-2 backdrop-blur">
            <span className="text-[11px] uppercase tracking-wider text-ink-400">
              Recent activity
            </span>
            <button
              className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              onClick={() => refetch(limit)}
              title="Refresh"
              aria-label="Refresh activity"
            >
              <span aria-hidden>{loading ? "⟳" : "↻"}</span>
            </button>
          </div>

          {error && (
            <div className="px-3 py-2 text-xs text-red-300">{error}</div>
          )}

          {!error && events.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-ink-500">
              {loading ? "Loading…" : "No activity yet."}
            </div>
          )}

          <ul className="divide-y divide-ink-800">
            {events.map((e, i) => (
              <ActivityRow key={`${e.ts}-${i}`} event={e} />
            ))}
          </ul>

          {!expanded && events.length >= 10 && (
            <button
              className="block w-full border-t border-ink-800 px-3 py-2 text-center text-xs text-amber-300 hover:bg-ink-800"
              onClick={() => setExpanded(true)}
            >
              Show all activity →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const { icon, title, sub } = describeEvent(event);
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-xs">
      <span className="mt-0.5 text-base leading-none" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-ink-100">{title}</div>
        <div className="text-[11px] text-ink-500">{sub}</div>
      </div>
    </li>
  );
}

const ICON: Record<ActivityKind, string> = {
  clip_exported: "🎬",
  clip_reexported: "🔁",
  clip_deleted: "🗑",
  clip_restored: "↺",
  scene_created: "🎞",
  scene_deleted: "🎞",
  character_created: "🎭",
  character_deleted: "🎭",
  object_created: "📦",
  object_deleted: "📦",
  collection_exported: "📁",
  missing_repaired: "🛠",
  orphans_adopted: "🥄",
  orphans_trashed: "🥄",
  clips_copied: "📋",
  clip_renamed: "✎",
  clips_sent_to_premiere: "▶",
};

function describeEvent(event: ActivityEvent): {
  icon: string;
  title: string;
  sub: string;
} {
  const p = event.payload ?? {};
  const name = typeof p.name === "string" ? p.name : "";
  const rel = formatRelative(event.ts);
  const icon = ICON[event.kind] ?? "•";

  switch (event.kind) {
    case "clip_exported": {
      const dur = typeof p.durationSec === "number" ? ` · ${p.durationSec.toFixed(1)}s` : "";
      const mode = typeof p.mode === "string" ? ` · ${p.mode}` : "";
      return {
        icon,
        title: `Exported "${name || "(unnamed)"}"`,
        sub: `${rel}${dur}${mode}`,
      };
    }
    case "clip_reexported": {
      const dur = typeof p.durationSec === "number" ? ` · ${p.durationSec.toFixed(1)}s` : "";
      return {
        icon,
        title: `Re-exported "${name || "(unnamed)"}"`,
        sub: `${rel}${dur}`,
      };
    }
    case "clip_deleted":
      return { icon, title: `Deleted "${name}"`, sub: rel };
    case "clip_restored":
      return { icon, title: `Restored "${name}"`, sub: rel };
    case "scene_created":
      return { icon, title: `Created scene "${name}"`, sub: rel };
    case "scene_deleted":
      return { icon, title: `Deleted scene "${name}"`, sub: rel };
    case "character_created":
      return { icon, title: `Created character "${name}"`, sub: rel };
    case "character_deleted":
      return { icon, title: `Deleted character "${name}"`, sub: rel };
    case "object_created":
      return { icon, title: `Created object "${name}"`, sub: rel };
    case "object_deleted":
      return { icon, title: `Deleted object "${name}"`, sub: rel };
    case "collection_exported": {
      const fc = typeof p.fileCount === "number" ? `${p.fileCount} clip${p.fileCount === 1 ? "" : "s"}` : "";
      return {
        icon,
        title: `Exported collection "${name}"`,
        sub: [rel, fc].filter(Boolean).join(" · "),
      };
    }
    case "missing_repaired": {
      const r = typeof p.repaired === "number" ? p.repaired : 0;
      const errs = typeof p.errors === "number" ? p.errors : 0;
      return {
        icon,
        title: `Repaired ${r} missing clip${r === 1 ? "" : "s"}`,
        sub: errs > 0 ? `${rel} · ${errs} error${errs === 1 ? "" : "s"}` : rel,
      };
    }
    case "orphans_adopted": {
      const a = typeof p.adopted === "number" ? p.adopted : 0;
      return {
        icon,
        title: `Adopted ${a} orphan${a === 1 ? "" : "s"}`,
        sub: rel,
      };
    }
    case "orphans_trashed": {
      const t = typeof p.trashed === "number" ? p.trashed : 0;
      return {
        icon,
        title: `Trashed ${t} orphan${t === 1 ? "" : "s"}`,
        sub: rel,
      };
    }
    case "clips_copied": {
      const c =
        typeof p.count === "number"
          ? p.count
          : typeof p.fileCount === "number"
            ? p.fileCount
            : 0;
      return {
        icon,
        title: `Copied ${c} clip${c === 1 ? "" : "s"} to clipboard`,
        sub: rel,
      };
    }
    case "clip_renamed": {
      const from = typeof p.oldName === "string" ? p.oldName : "";
      const to =
        typeof p.newName === "string" ? p.newName : name || "(unnamed)";
      return {
        icon,
        title: from ? `Renamed "${from}" → "${to}"` : `Renamed "${to}"`,
        sub: rel,
      };
    }
    case "clips_sent_to_premiere": {
      const c =
        typeof p.count === "number"
          ? p.count
          : typeof p.fileCount === "number"
            ? p.fileCount
            : 0;
      return {
        icon,
        title: `Sent ${c} clip${c === 1 ? "" : "s"} to Premiere`,
        sub: rel,
      };
    }
    default:
      return { icon, title: event.kind, sub: rel };
  }
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}
