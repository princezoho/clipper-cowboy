import { useCallback, useEffect, useRef, useState } from "react";
import {
  Character,
  ExportMode,
  MatchedCharacter,
  PoolItem,
  SampleFrame,
  SceneSegment,
  UnknownPerson,
  addCharacterRef,
  captionClip,
  createCharacter,
  detectScenes,
  exportClip,
  fetchCharacters,
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
  onCharactersChanged?: () => void;
  hasOpenAIKey: boolean;
}

const ESTIMATED_FPS = 30;

export default function EditorOverlay({
  source,
  onClose,
  onExported,
  onCharactersChanged,
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
  const [characters, setCharacters] = useState<MatchedCharacter[]>([]);
  const [unknownPeople, setUnknownPeople] = useState<UnknownPerson[]>([]);
  const [sampleFrames, setSampleFrames] = useState<SampleFrame[]>([]);
  const [captionCacheKey, setCaptionCacheKey] = useState<string | null>(null);

  const [allCharacters, setAllCharacters] = useState<Character[]>([]);
  const [exportMode, setExportMode] = useState<ExportMode>("clip");
  const [captioning, setCaptioning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const captionAbort = useRef<AbortController | null>(null);

  async function reloadCharacters() {
    try {
      const r = await fetchCharacters();
      setAllCharacters(r.items);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchScenes(source.id).then((cached) => {
      if (cancelled || !cached) return;
      setScenes(cached.segments);
      if (cached.duration && !duration) setDuration(cached.duration);
    });
    reloadCharacters();
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
        setCharacters(c.characters);
        setUnknownPeople(c.unknownPeople);
        setSampleFrames(c.sampleFrames);
        setCaptionCacheKey(c.cacheKey);
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
    if (exportMode !== "source" && outT - inT < 0.1) {
      setError("Selection is too short.");
      return;
    }
    setExporting(true);
    setError(null);
    setStatusMsg(
      exportMode === "bundle"
        ? "Exporting clip + cloning source…"
        : exportMode === "source"
        ? "Cloning source…"
        : "Exporting…"
    );
    try {
      const item = await exportClip({
        sourceId: source.id,
        in: inT,
        out: outT,
        name,
        description,
        tags,
        characters,
        mode: exportMode,
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
    characters,
    inT,
    outT,
    exportMode,
    source.id,
    onExported,
    scenes,
    activeScene,
    selectScene,
    onClose,
  ]);

  // ---- Unknown-people actions ----------------------------------------------

  function dismissUnknown(idx: number) {
    setUnknownPeople((arr) => arr.filter((_, i) => i !== idx));
  }

  async function nameUnknown(idx: number, newName: string) {
    if (!newName.trim() || !captionCacheKey) return;
    try {
      const newChar = await createCharacter({ name: newName.trim() });
      await addCharacterRef(newChar.id, {
        cacheKey: captionCacheKey,
        frameIndex: unknownPeople[idx].frameIndex,
      });
      setCharacters((cs) =>
        cs.find((c) => c.id === newChar.id)
          ? cs
          : [...cs, { id: newChar.id, name: newChar.name }]
      );
      dismissUnknown(idx);
      reloadCharacters();
      onCharactersChanged?.();
    } catch (err) {
      setError(String(err));
    }
  }

  async function connectUnknown(idx: number, characterId: string) {
    if (!captionCacheKey) return;
    const target = allCharacters.find((c) => c.id === characterId);
    if (!target) return;
    try {
      await addCharacterRef(target.id, {
        cacheKey: captionCacheKey,
        frameIndex: unknownPeople[idx].frameIndex,
      });
      setCharacters((cs) =>
        cs.find((c) => c.id === target.id)
          ? cs
          : [...cs, { id: target.id, name: target.name }]
      );
      dismissUnknown(idx);
      reloadCharacters();
      onCharactersChanged?.();
    } catch (err) {
      setError(String(err));
    }
  }

  function removeMatched(id: string) {
    setCharacters((cs) => cs.filter((c) => c.id !== id));
  }

  // ---- Hotkeys -------------------------------------------------------------

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

        <CharacterStrip
          characters={characters}
          allCharacters={allCharacters}
          unknownPeople={unknownPeople}
          sampleFrames={sampleFrames}
          onRemove={removeMatched}
          onName={nameUnknown}
          onConnect={connectUnknown}
          onIgnore={dismissUnknown}
          onAddExisting={(c) =>
            setCharacters((cs) =>
              cs.find((x) => x.id === c.id) ? cs : [...cs, { id: c.id, name: c.name }]
            )
          }
        />

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
          exportMode={exportMode}
          onExportMode={setExportMode}
        />
      </div>
    </div>
  );
}

function CharacterStrip({
  characters,
  allCharacters,
  unknownPeople,
  sampleFrames,
  onRemove,
  onName,
  onConnect,
  onIgnore,
  onAddExisting,
}: {
  characters: MatchedCharacter[];
  allCharacters: Character[];
  unknownPeople: UnknownPerson[];
  sampleFrames: SampleFrame[];
  onRemove: (id: string) => void;
  onName: (idx: number, name: string) => void;
  onConnect: (idx: number, characterId: string) => void;
  onIgnore: (idx: number) => void;
  onAddExisting: (c: Character) => void;
}) {
  const matchedIds = new Set(characters.map((c) => c.id));
  const addable = allCharacters.filter((c) => !matchedIds.has(c.id));

  const hasContent =
    characters.length > 0 || unknownPeople.length > 0 || addable.length > 0;
  if (!hasContent) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-ink-800 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-500">
          Characters
        </span>
        {characters.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-200"
            title="AI matched — click × to remove from this clip"
          >
            {c.name}
            <button
              onClick={() => onRemove(c.id)}
              className="text-emerald-200/60 hover:text-emerald-100"
            >
              ×
            </button>
          </span>
        ))}
        {addable.length > 0 && (
          <select
            className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value=""
            onChange={(e) => {
              const c = allCharacters.find((x) => x.id === e.target.value);
              if (c) onAddExisting(c);
              e.target.value = "";
            }}
          >
            <option value="">+ add character…</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {unknownPeople.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
          <div className="text-xs text-amber-200">
            Unknown character{unknownPeople.length === 1 ? "" : "s"} spotted by
            AI — name, connect to existing, or ignore:
          </div>
          <div className="flex flex-wrap gap-3">
            {unknownPeople.map((u, idx) => (
              <UnknownCard
                key={idx}
                person={u}
                allCharacters={allCharacters}
                frame={sampleFrames[u.frameIndex]}
                onName={(n) => onName(idx, n)}
                onConnect={(id) => onConnect(idx, id)}
                onIgnore={() => onIgnore(idx)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UnknownCard({
  person,
  allCharacters,
  frame,
  onName,
  onConnect,
  onIgnore,
}: {
  person: UnknownPerson;
  allCharacters: Character[];
  frame: SampleFrame | undefined;
  onName: (n: string) => void;
  onConnect: (id: string) => void;
  onIgnore: () => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="flex w-72 flex-col gap-2 rounded border border-ink-800 bg-ink-900 p-2">
      {frame ? (
        <img
          src={frame.url}
          alt=""
          className="aspect-video w-full rounded object-cover"
        />
      ) : (
        <div className="aspect-video w-full rounded bg-ink-800" />
      )}
      <div className="text-xs text-ink-300">{person.description}</div>

      {naming ? (
        <div className="flex gap-1">
          <input
            autoFocus
            className="flex-1 rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Character name"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                e.preventDefault();
                onName(name);
                setNaming(false);
                setName("");
              } else if (e.key === "Escape") {
                setNaming(false);
                setName("");
              }
            }}
          />
          <button
            className="rounded bg-accent-500 px-2 py-1 text-[11px] font-medium text-black hover:bg-accent-400 disabled:opacity-50"
            disabled={!name.trim()}
            onClick={() => {
              onName(name);
              setNaming(false);
              setName("");
            }}
          >
            Save
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            className="rounded bg-ink-800 px-2 py-1 text-[11px] text-ink-200 hover:bg-ink-700"
            onClick={() => setNaming(true)}
          >
            Name
          </button>
          {allCharacters.length > 0 && (
            <select
              className="rounded bg-ink-800 px-2 py-1 text-[11px] text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value=""
              onChange={(e) => {
                if (e.target.value) onConnect(e.target.value);
              }}
            >
              <option value="">Connect to…</option>
              {allCharacters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="rounded px-2 py-1 text-[11px] text-ink-500 hover:text-red-400"
            onClick={onIgnore}
          >
            Ignore
          </button>
        </div>
      )}
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
