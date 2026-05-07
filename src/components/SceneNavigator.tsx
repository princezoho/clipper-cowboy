import { SceneSegment, formatDuration } from "../lib/api";

interface Props {
  scenes: SceneSegment[];
  activeIndex: number | null;
  detecting: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDetect: () => void;
}

export default function SceneNavigator({
  scenes,
  activeIndex,
  detecting,
  onPrev,
  onNext,
  onDetect,
}: Props) {
  const total = scenes.length;
  const display =
    activeIndex != null && activeIndex >= 0 ? activeIndex + 1 : "—";

  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        className="rounded-md border border-ink-700 px-2 py-1 text-ink-300 hover:bg-ink-800 disabled:opacity-40"
        onClick={onPrev}
        disabled={total === 0 || activeIndex === 0}
        title="Previous scene (↑)"
      >
        ◀◀
      </button>
      <div className="min-w-[5rem] text-center font-mono text-ink-200">
        scene {display}/{total || "—"}
      </div>
      <button
        className="rounded-md border border-ink-700 px-2 py-1 text-ink-300 hover:bg-ink-800 disabled:opacity-40"
        onClick={onNext}
        disabled={total === 0 || (activeIndex != null && activeIndex >= total - 1)}
        title="Next scene (↓)"
      >
        ▶▶
      </button>
      {total === 0 ? (
        <button
          onClick={onDetect}
          disabled={detecting}
          className="ml-2 rounded-md bg-ink-800 px-3 py-1 text-ink-200 hover:bg-ink-700 disabled:opacity-50"
        >
          {detecting ? "Detecting…" : "Detect scenes"}
        </button>
      ) : (
        activeIndex != null && (
          <span className="ml-2 text-xs text-ink-400 font-mono">
            {formatDuration(scenes[activeIndex].end - scenes[activeIndex].start)}
          </span>
        )
      )}
    </div>
  );
}
