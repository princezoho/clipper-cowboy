import { useCallback, useEffect, useRef, useState } from "react";
import {
  PoolClipsSummaryEntry,
  PoolItem,
  fetchPoolClipsSummary,
  formatDuration,
} from "../lib/api";

interface Props {
  items: PoolItem[];
  loading: boolean;
  onPick: (item: PoolItem) => void;
}

export default function PoolView({ items, loading, onPick }: Props) {
  const [summary, setSummary] = useState<Record<string, PoolClipsSummaryEntry>>(
    {}
  );
  const [summaryLoaded, setSummaryLoaded] = useState(false);

  // ---- Hover-preview state (mirrors LibraryView) -------------------------
  // Single active previewer at a time; sharing the localStorage key
  // "cowboy.previewAudio" with LibraryView keeps the audio toggle a single
  // global preference across both tabs.
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("cowboy.previewAudio") === "on";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "cowboy.previewAudio",
        audioOn ? "on" : "off"
      );
    } catch {
      // ignore (private mode / disabled storage)
    }
  }, [audioOn]);

  const handlePreviewEnter = useCallback((id: string) => {
    setActivePreviewId(id);
  }, []);
  const handlePreviewLeave = useCallback((id: string) => {
    setActivePreviewId((curr) => (curr === id ? null : curr));
  }, []);

  // Single batch fetch keeps render cheap even with 70+ Pool cards. Refetch
  // whenever the visible Pool item set changes (refresh, new dropped sources).
  useEffect(() => {
    let cancelled = false;
    fetchPoolClipsSummary()
      .then((s) => {
        if (!cancelled) {
          setSummary(s);
          setSummaryLoaded(true);
        }
      })
      .catch(() => {
        // Strip just won't render for sources without summary data.
        if (!cancelled) setSummaryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [items.length]);

  if (loading && items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-ink-400">
        Loading pool…
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ink-400">
        <div className="text-lg text-ink-200">Pool is empty</div>
        <div className="max-w-md text-sm">
          Drop your AI-generated montage videos into the project folder, then
          click Refresh up top.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-ink-800 bg-ink-950/95 px-5 py-3 backdrop-blur">
        <span className="mr-auto text-xs text-ink-500">
          {items.length} source{items.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setAudioOn((v) => !v)}
          data-testid="pool-preview-audio-toggle"
          aria-pressed={audioOn}
          title={`Preview audio (currently ${audioOn ? "on" : "off"})`}
          className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:bg-ink-800"
        >
          <span aria-hidden="true">{audioOn ? "\uD83D\uDD0A" : "\uD83D\uDD07"}</span>
          <span className="sr-only">
            Preview audio (currently {audioOn ? "on" : "off"})
          </span>
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
        {items.map((item) => (
          <PoolCard
            key={item.id}
            item={item}
            summary={summary[item.id]}
            summaryLoaded={summaryLoaded}
            onPick={() => {
              // Clear hover preview before unveiling the editor so the
              // background <video> doesn't keep decoding while the editor's
              // own player is mounting.
              setActivePreviewId(null);
              onPick(item);
            }}
            isActivePreview={activePreviewId === item.id}
            audioOn={audioOn}
            onPreviewEnter={handlePreviewEnter}
            onPreviewLeave={handlePreviewLeave}
          />
        ))}
      </div>
    </>
  );
}

function PoolCard({
  item,
  summary,
  summaryLoaded,
  onPick,
  isActivePreview,
  audioOn,
  onPreviewEnter,
  onPreviewLeave,
}: {
  item: PoolItem;
  summary: PoolClipsSummaryEntry | undefined;
  summaryLoaded: boolean;
  onPick: () => void;
  isActivePreview: boolean;
  audioOn: boolean;
  onPreviewEnter: (id: string) => void;
  onPreviewLeave: (id: string) => void;
}) {
  const processed = item.clipCount > 0;
  const clips = summary?.clips ?? [];
  const draft = summary?.draft;
  // Fall back to the source's known duration; if neither side knows yet, hide
  // the strip rather than guess (would render a band stretching off the card).
  const safeDuration = item.duration > 0 ? item.duration : 0;

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900 transition hover:border-ink-600 hover:bg-ink-800"
      onMouseEnter={() => onPreviewEnter(item.id)}
      onMouseLeave={() => onPreviewLeave(item.id)}
    >
      <button
        className="text-left"
        onClick={onPick}
        title="Open in editor"
      >
        <div className="relative aspect-video overflow-hidden bg-ink-950">
          <PoolCardThumbnail
            item={item}
            isActive={isActivePreview}
            audioOn={audioOn}
          />
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">
            {formatDuration(item.duration)}
          </span>
          <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
            {processed && (
              <span
                className="rounded-full bg-emerald-500/85 px-2 py-0.5 font-mono text-[10px] font-medium text-black"
                title={`${item.clipCount} clip${item.clipCount === 1 ? "" : "s"} exported from this source`}
              >
                ✓ {item.clipCount}
              </span>
            )}
            {draft && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-500/85 px-2 py-0.5 font-mono text-[10px] font-medium text-black"
                title={`Unsaved draft — IN ${draft.in.toFixed(2)}s · OUT ${draft.out.toFixed(2)}s`}
                data-testid="pool-draft-pill"
              >
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-950/70" />
                1 draft
              </span>
            )}
          </div>
        </div>

        {/* Coverage strip — 4px-tall yellow bands showing where clips live
            within the source's duration. Mirrors the editor timeline. */}
        <div
          className="relative h-1 w-full bg-ink-800"
          title={
            clips.length > 0 && summary
              ? `${clips.length} clip${clips.length === 1 ? "" : "s"} · ${summary.coveredSec.toFixed(1)}s mined${draft ? " · 1 draft" : ""}`
              : draft
                ? "Unsaved draft on this source"
                : "No clips exported yet"
          }
        >
          {safeDuration > 0 &&
            clips.map((c, i) => (
              <div
                key={c.id ?? i}
                className="absolute top-0 h-full bg-[#facc15]/70"
                style={{
                  left: `${Math.max(0, Math.min(100, (c.in / safeDuration) * 100))}%`,
                  width: `${Math.max(0.2, Math.min(100, ((c.out - c.in) / safeDuration) * 100))}%`,
                }}
                title={`${c.name} — ${c.in.toFixed(2)}s → ${c.out.toFixed(2)}s`}
              />
            ))}
          {safeDuration > 0 && draft && draft.out > draft.in && (
            <div
              className="absolute top-0 h-full border-t-2 border-dashed border-amber-400 bg-amber-400/30"
              style={{
                left: `${Math.max(0, Math.min(100, (draft.in / safeDuration) * 100))}%`,
                width: `${Math.max(0.2, Math.min(100, ((draft.out - draft.in) / safeDuration) * 100))}%`,
              }}
              title={`Draft — ${draft.in.toFixed(2)}s → ${draft.out.toFixed(2)}s`}
            />
          )}
        </div>

        <div className="px-3 py-2">
          <div className="truncate text-sm text-ink-100">{item.filename}</div>
          <ProgressLine item={item} summary={summary} loaded={summaryLoaded} />
          <div className="mt-0.5 text-xs text-ink-500">
            {(item.size / (1024 * 1024)).toFixed(1)} MB
          </div>
        </div>
      </button>

      <div className="absolute inset-x-0 bottom-0 flex translate-y-full justify-center gap-1 bg-gradient-to-t from-black/90 to-transparent px-2 py-2 transition group-hover:translate-y-0">
        <button
          onClick={onPick}
          className="w-full rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 hover:bg-ink-700"
        >
          Open in editor
        </button>
      </div>
    </div>
  );
}

/**
 * Per-source coverage line: tiny donut + "N clips · X:YZ of M:NN (Z%)" text.
 * Mirrors mockup C.3 — a quick triage signal so users can see at a glance
 * which sources still have untouched footage.
 */
function ProgressLine({
  item,
  summary,
  loaded,
}: {
  item: PoolItem;
  summary: PoolClipsSummaryEntry | undefined;
  loaded: boolean;
}) {
  const totalDur = item.duration > 0 ? item.duration : 0;
  const clips = summary?.clips ?? [];
  const coveredSec = summary?.coveredSec ?? 0;

  if (!loaded) {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
        <span className="inline-block h-3.5 w-3.5 rounded-full border border-ink-700" />
        <span>—</span>
      </div>
    );
  }

  if (clips.length === 0 || totalDur <= 0) {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500">
        <span
          className="inline-block h-3.5 w-3.5 rounded-full border border-ink-700"
          aria-hidden
          title="No clips exported yet"
        />
        <span>— · {formatDuration(totalDur)}</span>
      </div>
    );
  }

  const rawPct = (coveredSec / totalDur) * 100;
  const pct = Math.max(0, Math.min(100, Math.round(rawPct)));
  const fullyCovered = pct >= 100;

  if (fullyCovered) {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-emerald-300">
        <span
          className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500/30 text-[10px] text-emerald-200"
          aria-hidden
        >
          ✓
        </span>
        <span>
          Fully covered · {clips.length} clip{clips.length === 1 ? "" : "s"}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-400">
      <span
        className="inline-block h-3.5 w-3.5 rounded-full"
        style={{
          background: `conic-gradient(#facc15 ${pct * 3.6}deg, #26262d 0)`,
        }}
        aria-hidden
        title={`${pct}% covered`}
      />
      <span>
        {clips.length} clip{clips.length === 1 ? "" : "s"} · {formatDuration(coveredSec)} of{" "}
        {formatDuration(totalDur)} ({pct}%)
      </span>
    </div>
  );
}

function PoolCardThumbnail({
  item,
  isActive,
  audioOn,
}: {
  item: PoolItem;
  isActive: boolean;
  audioOn: boolean;
}) {
  if (isActive) {
    // Source-video stream — same endpoint EditorOverlay uses for playback.
    return (
      <PoolHoverPreviewVideo
        src={`/api/video/${item.id}`}
        audioOn={audioOn}
        alt={item.filename}
      />
    );
  }
  return (
    <img
      src={item.thumbUrl}
      loading="lazy"
      alt={item.filename}
      className="h-full w-full object-cover transition group-hover:scale-[1.02]"
    />
  );
}

function PoolHoverPreviewVideo({
  src,
  audioOn,
  alt,
}: {
  src: string;
  audioOn: boolean;
  alt: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // Live-update muted attr when the global audio toggle flips while this
  // card is the active previewer. Browsers may reject play() when un-muting
  // without a fresh user gesture; swallow the rejection — the next hover
  // will succeed.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = !audioOn;
    const p = v.play();
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => {
        // autoplay rejected — fine, user can re-hover
      });
    }
  }, [audioOn]);
  return (
    <video
      ref={ref}
      src={src}
      autoPlay
      loop
      playsInline
      preload="auto"
      muted={!audioOn}
      aria-label={alt}
      className="h-full w-full object-cover"
    />
  );
}
