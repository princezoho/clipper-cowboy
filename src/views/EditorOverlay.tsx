import { useCallback, useEffect, useRef, useState } from "react";
import {
  PoolItem,
  SceneSegment,
  captionClip,
  detectScenes,
  exportClip,
  fetchScenes,
  formatTime,
} from "../lib/api";
import VideoPlayer, { VideoPlayerHandle } from "../components/VideoPlayer";
import Timeline from "../components/Timeline";
import SceneNavigator from "../components/SceneNavigator";
import ClipMetaForm from "../components/ClipMetaForm";

interface Props {
  source: PoolItem;
  onClose: () => void;
  onExported: () => void;
  hasOpenAIKey: boolean;
}

const ESTIMATED_FPS = 30;

export default function EditorOverlay({
  source,
  onClose,
  onExported,
  hasOpenAIKey,
}: Props) {
  const playerRef = useRef<VideoPlayerHandle>(null);

  const [duration, setDuration] = useState(source.duration || 0);
  const [fps, setFps] = useState(ESTIMATED_FPS);
  const [current, setCurrent] = useState(0);
  const [inT, setInT] = useState(0);
  const [outT, setOutT] = useState(source.duration || 1);

  const [scenes, setScenes] = useState<SceneSegment[]>([]);
  const [activeScene, setActiveScene] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [captioning, setCaptioning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const captionAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchScenes(source.id).then((cached) => {
      if (cancelled || !cached) return;
      setScenes(cached.segments);
      if (cached.duration && !duration) setDuration(cached.duration);
    });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  const onLoaded = useCallback(
    (info: { duration: number; width: number; height: number }) => {
      setDuration(info.duration);
      if (outT === 0 || outT > info.duration) setOutT(info.duration);
      const v = playerRef.current?.el;
      if (v) {
        const guess = guessFps(v);
        if (guess) setFps(guess);
      }
    },
    [outT]
  );

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    setError(null);
    try {
      const r = await detectScenes(source.id);
      setScenes(r.segments);
      if (r.duration && !duration) setDuration(r.duration);
      if (r.segments.length > 0) selectScene(0, r.segments);
    } catch (err) {
      setError(String(err));
    } finally {
      setDetecting(false);
    }
  }, [source.id, duration]);

  const selectScene = useCallback(
    (idx: number, segs?: SceneSegment[]) => {
      const list = segs ?? scenes;
      if (idx < 0 || idx >= list.length) return;
      const s = list[idx];
      setActiveScene(idx);
      setInT(s.start);
      setOutT(s.end);
      playerRef.current?.seek(s.start);
      runAutoCaption(s.start, s.end);
    },
    [scenes, hasOpenAIKey]
  );

  const runAutoCaption = useCallback(
    async (a: number, b: number) => {
      if (!hasOpenAIKey) return;
      captionAbort.current?.abort();
      const ac = new AbortController();
      captionAbort.current = ac;
      setCaptioning(true);
      setError(null);
      try {
        const c = await captionClip(source.id, a, b);
        if (ac.signal.aborted) return;
        setName(c.name);
        setDescription(c.description);
        setTags(c.tags);
      } catch (err) {
        if (!ac.signal.aborted) setError(String(err));
      } finally {
        if (!ac.signal.aborted) setCaptioning(false);
      }
    },
    [hasOpenAIKey, source.id]
  );

  const handleAutoFill = useCallback(() => {
    runAutoCaption(inT, outT);
  }, [inT, outT, runAutoCaption]);

  const handleExport = useCallback(async () => {
    if (!name.trim()) {
      setError("Give the clip a name first.");
      return;
    }
    if (outT - inT < 0.1) {
      setError("Selection is too short.");
      return;
    }
    setExporting(true);
    setError(null);
    setStatusMsg("Exporting…");
    try {
      const item = await exportClip({
        sourceId: source.id,
        in: inT,
        out: outT,
        name,
        description,
        tags,
      });
      setStatusMsg(`Exported as ${item.filename} (${item.mode})`);
      onExported();

      if (scenes.length > 0 && activeScene != null) {
        const next = activeScene + 1;
        if (next < scenes.length) {
          setTimeout(() => selectScene(next), 200);
        } else {
          setTimeout(onClose, 600);
        }
      }
    } catch (err) {
      setError(String(err));
      setStatusMsg(null);
    } finally {
      setExporting(false);
    }
  }, [
    name,
    description,
    tags,
    inT,
    outT,
    source.id,
    onExported,
    scenes,
    activeScene,
    selectScene,
    onClose,
  ]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const isCtaShortcut = e.key === "Enter" && (e.metaKey || e.ctrlKey);

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (isFormField && !isCtaShortcut) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          playerRef.current?.togglePlay();
          break;
        case "j":
          playerRef.current?.setRate(-1);
          playerRef.current?.play();
          break;
        case "k":
          playerRef.current?.pause();
          break;
        case "l":
          playerRef.current?.setRate(1);
          playerRef.current?.play();
          break;
        case "ArrowLeft":
          e.preventDefault();
          playerRef.current?.stepFrame(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          playerRef.current?.stepFrame(e.shiftKey ? 10 : 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          if (activeScene == null && scenes.length > 0) selectScene(0);
          else if (activeScene != null && activeScene > 0)
            selectScene(activeScene - 1);
          break;
        case "ArrowDown":
          e.preventDefault();
          if (activeScene == null && scenes.length > 0) selectScene(0);
          else if (activeScene != null && activeScene < scenes.length - 1)
            selectScene(activeScene + 1);
          break;
        case "i":
        case "I":
          setInT(playerRef.current?.el?.currentTime ?? current);
          break;
        case "o":
        case "O":
          setOutT(playerRef.current?.el?.currentTime ?? current);
          break;
        case "Enter":
          if (isCtaShortcut || !isFormField) {
            e.preventDefault();
            handleExport();
          }
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeScene, scenes, selectScene, current, handleExport, onClose]);

  const safeIn = Math.max(0, Math.min(inT, duration || inT));
  const safeOut = Math.max(safeIn, Math.min(outT, duration || outT));

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-ink-950">
      <div className="flex items-center justify-between border-b border-ink-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="rounded-md border border-ink-700 px-2 py-1 text-sm text-ink-300 hover:bg-ink-800"
            onClick={onClose}
            title="Close (Esc)"
          >
            ✕ Close
          </button>
          <div className="truncate text-sm text-ink-300">{source.filename}</div>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-400">
          {statusMsg && <span className="text-emerald-300">{statusMsg}</span>}
          {error && (
            <span
              className="max-w-[26rem] truncate text-red-300"
              title={error}
            >
              {error}
            </span>
          )}
          <span className="font-mono">
            {formatTime(current)} / {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <VideoPlayer
          ref={playerRef}
          src={`/api/video/${source.id}`}
          fps={fps}
          onTimeUpdate={setCurrent}
          onLoaded={onLoaded}
        />
      </div>

      <div className="border-t border-ink-800">
        <Timeline
          duration={duration}
          current={current}
          inT={safeIn}
          outT={safeOut}
          scenes={scenes}
          activeSceneIndex={activeScene}
          onSeek={(t) => playerRef.current?.seek(t)}
          onSetIn={setInT}
          onSetOut={setOutT}
          onSelectScene={(idx) => selectScene(idx)}
        />

        <div className="flex flex-wrap items-center gap-3 border-t border-ink-800 px-4 py-2">
          <SceneNavigator
            scenes={scenes}
            activeIndex={activeScene}
            detecting={detecting}
            onPrev={() =>
              activeScene != null && activeScene > 0 && selectScene(activeScene - 1)
            }
            onNext={() =>
              activeScene != null &&
              activeScene < scenes.length - 1 &&
              selectScene(activeScene + 1)
            }
            onDetect={handleDetect}
          />
          <div className="ml-auto flex items-center gap-2 text-xs text-ink-500">
            <Hotkey>Space</Hotkey> play
            <Hotkey>I</Hotkey>
            <Hotkey>O</Hotkey> in/out
            <Hotkey>←</Hotkey>
            <Hotkey>→</Hotkey> step
            <Hotkey>↑</Hotkey>
            <Hotkey>↓</Hotkey> scene
            <Hotkey>⏎</Hotkey> export
          </div>
        </div>

        <ClipMetaForm
          name={name}
          description={description}
          tags={tags}
          captioning={captioning}
          onName={setName}
          onDescription={setDescription}
          onTags={setTags}
          onAutoFill={handleAutoFill}
          onExport={handleExport}
          exporting={exporting}
          hasOpenAIKey={hasOpenAIKey}
        />
      </div>
    </div>
  );
}

function Hotkey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
      {children}
    </kbd>
  );
}

function guessFps(_v: HTMLVideoElement): number | null {
  return null;
}
