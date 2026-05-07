import { useCallback, useEffect, useRef, useState } from "react";
import { SceneSegment, formatTime } from "../lib/api";

interface Props {
  duration: number;
  current: number;
  inT: number;
  outT: number;
  scenes: SceneSegment[];
  activeSceneIndex: number | null;
  onSeek: (t: number) => void;
  onSetIn: (t: number) => void;
  onSetOut: (t: number) => void;
  onSelectScene?: (idx: number) => void;
}

type Drag = { kind: "in" | "out" | "playhead" } | null;

export default function Timeline({
  duration,
  current,
  inT,
  outT,
  scenes,
  activeSceneIndex,
  onSeek,
  onSetIn,
  onSetOut,
  onSelectScene,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [hover, setHover] = useState<number | null>(null);

  const safeDuration = duration > 0 ? duration : 1;

  const tFromEvent = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width)
      );
      return ratio * safeDuration;
    },
    [safeDuration]
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const t = tFromEvent(e.clientX);
      if (drag.kind === "in") onSetIn(Math.min(t, outT - 1 / 60));
      else if (drag.kind === "out") onSetOut(Math.max(t, inT + 1 / 60));
      else onSeek(t);
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, inT, outT, onSeek, onSetIn, onSetOut, tFromEvent]);

  function pct(t: number): number {
    return (t / safeDuration) * 100;
  }

  return (
    <div className="select-none px-4 py-3">
      <div className="flex items-end justify-between text-[11px] text-ink-400 font-mono">
        <span>0:00.000</span>
        <span className="text-ink-200">
          IN {formatTime(inT)} • OUT {formatTime(outT)} •{" "}
          <span className="text-accent-400">
            Δ {formatTime(Math.max(0, outT - inT))}
          </span>
        </span>
        <span>{formatTime(safeDuration)}</span>
      </div>

      <div
        ref={trackRef}
        className="relative mt-2 h-12 cursor-pointer rounded-md bg-ink-800"
        onMouseMove={(e) => setHover(tFromEvent(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).dataset.handle) return;
          const t = tFromEvent(e.clientX);
          onSeek(t);
          setDrag({ kind: "playhead" });
        }}
      >
        {scenes.map((s, i) => (
          <div
            key={i}
            className={
              "absolute top-0 h-full transition " +
              (i === activeSceneIndex
                ? "bg-accent-500/15"
                : "bg-ink-700/40 hover:bg-ink-700/60")
            }
            style={{
              left: `${pct(s.start)}%`,
              width: `${Math.max(0.1, pct(s.end - s.start))}%`,
              borderLeft: "1px solid rgba(255,255,255,0.08)",
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              onSelectScene?.(i);
            }}
            title={`Scene ${i + 1}: ${formatTime(s.start)} → ${formatTime(s.end)}`}
          />
        ))}

        <div
          className="absolute top-0 h-full bg-accent-500/25 ring-1 ring-accent-500/60"
          style={{
            left: `${pct(inT)}%`,
            width: `${Math.max(0, pct(outT - inT))}%`,
          }}
        />

        <Handle
          left={pct(inT)}
          color="bg-accent-400"
          label="IN"
          onMouseDown={(e) => {
            e.stopPropagation();
            setDrag({ kind: "in" });
          }}
        />
        <Handle
          left={pct(outT)}
          color="bg-accent-400"
          label="OUT"
          onMouseDown={(e) => {
            e.stopPropagation();
            setDrag({ kind: "out" });
          }}
        />

        <div
          className="absolute top-0 h-full w-px bg-white"
          style={{ left: `${pct(current)}%` }}
        >
          <div
            data-handle="playhead"
            className="absolute -left-2 -top-1.5 h-3 w-4 cursor-ew-resize rounded-sm bg-white"
            onMouseDown={(e) => {
              e.stopPropagation();
              setDrag({ kind: "playhead" });
            }}
          />
        </div>

        {hover != null && drag == null && (
          <div
            className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-100"
            style={{ left: `${pct(hover)}%` }}
          >
            {formatTime(hover)}
          </div>
        )}
      </div>
    </div>
  );
}

function Handle({
  left,
  color,
  label,
  onMouseDown,
}: {
  left: number;
  color: string;
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      data-handle="1"
      onMouseDown={onMouseDown}
      className="absolute top-0 z-10 h-full w-1 cursor-ew-resize"
      style={{ left: `calc(${left}% - 0.125rem)` }}
    >
      <div className={"absolute inset-y-0 left-0 w-1 " + color} />
      <div className="absolute -top-1 left-1/2 -translate-x-1/2 rounded-sm bg-accent-500 px-1 text-[9px] font-bold text-black">
        {label}
      </div>
    </div>
  );
}
