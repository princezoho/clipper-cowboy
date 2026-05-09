import { PoolItem, formatDuration } from "../lib/api";

interface Props {
  items: PoolItem[];
  loading: boolean;
  onPick: (item: PoolItem) => void;
  onAutoCut: (item: PoolItem) => void;
}

export default function PoolView({ items, loading, onPick, onAutoCut }: Props) {
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
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
      {items.map((item) => (
        <PoolCard
          key={item.id}
          item={item}
          onPick={() => onPick(item)}
          onAutoCut={() => onAutoCut(item)}
        />
      ))}
    </div>
  );
}

function PoolCard({
  item,
  onPick,
  onAutoCut,
}: {
  item: PoolItem;
  onPick: () => void;
  onAutoCut: () => void;
}) {
  const processed = item.clipCount > 0;
  const analyzing =
    item.autoCutStatus === "detecting" || item.autoCutStatus === "captioning";
  const ready = item.autoCutStatus === "complete";

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900 transition hover:border-ink-600 hover:bg-ink-800">
      <button
        className="text-left"
        onClick={onPick}
        title="Open in editor"
      >
        <div className="relative aspect-video overflow-hidden bg-ink-950">
          <img
            src={item.thumbUrl}
            loading="lazy"
            alt={item.filename}
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">
            {formatDuration(item.duration)}
          </span>
          {processed && (
            <span
              className="absolute left-1.5 top-1.5 rounded-full bg-emerald-500/85 px-2 py-0.5 font-mono text-[10px] font-medium text-black"
              title={`${item.clipCount} clip${item.clipCount === 1 ? "" : "s"} exported from this source`}
            >
              ✓ {item.clipCount}
            </span>
          )}
          {analyzing && (
            <span className="absolute right-1.5 top-1.5 rounded-full bg-amber-500/85 px-2 py-0.5 font-mono text-[10px] font-medium text-black">
              {item.autoCutStatus === "detecting"
                ? "scanning…"
                : `${item.autoCutDone}/${item.autoCutTotal}`}
            </span>
          )}
          {ready && !analyzing && (
            <span className="absolute right-1.5 top-1.5 rounded-full bg-accent-500/85 px-2 py-0.5 font-mono text-[10px] font-medium text-black">
              ⚡ {item.autoCutTotal}
            </span>
          )}
        </div>
        <div className="px-3 py-2">
          <div className="truncate text-sm text-ink-100">{item.filename}</div>
          <div className="mt-0.5 text-xs text-ink-500">
            {(item.size / (1024 * 1024)).toFixed(1)} MB
          </div>
        </div>
      </button>

      <div className="absolute inset-x-0 bottom-0 flex translate-y-full justify-center gap-1 bg-gradient-to-t from-black/90 to-transparent px-2 py-2 transition group-hover:translate-y-0">
        <button
          onClick={onPick}
          className="flex-1 rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 hover:bg-ink-700"
        >
          Open
        </button>
        <button
          onClick={onAutoCut}
          disabled={analyzing}
          className="flex-1 rounded bg-accent-500 px-2 py-1 text-xs font-medium text-black hover:bg-accent-400 disabled:opacity-50"
          title={
            ready
              ? "Open the AI-cut review queue"
              : analyzing
              ? "Analysis in progress…"
              : "Run AI scene detection + captioning, then walk the queue"
          }
        >
          {ready ? "Review queue" : analyzing ? "Analyzing…" : "Auto-cut ⚡"}
        </button>
      </div>
    </div>
  );
}
