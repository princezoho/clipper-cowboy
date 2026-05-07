import { PoolItem, formatDuration } from "../lib/api";

interface Props {
  items: PoolItem[];
  loading: boolean;
  onPick: (item: PoolItem) => void;
}

export default function PoolView({ items, loading, onPick }: Props) {
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
          Drop your AI-generated montage videos into the pool folder, then click
          Refresh up top.
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
      {items.map((item) => (
        <button
          key={item.id}
          className="group flex flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900 text-left transition hover:border-ink-600 hover:bg-ink-800"
          onClick={() => onPick(item)}
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
          </div>
          <div className="px-3 py-2">
            <div className="truncate text-sm text-ink-100">{item.filename}</div>
            <div className="mt-0.5 text-xs text-ink-500">
              {(item.size / (1024 * 1024)).toFixed(1)} MB
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
