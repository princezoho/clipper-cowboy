import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Character,
  Draft,
  DraftInput,
  ExistingPoolClip,
  ExportMode,
  LibraryItem,
  MatchedCharacter,
  NamedRef,
  PoolItem,
  SampleFrame,
  StemQuality,
  AudioEngineStatus,
  UnknownPerson,
  ApiError,
  addCharacterRef,
  captionClip,
  createCharacter,
  deleteDraft,
  exportClip,
  fetchCharacters,
  fetchDraft,
  fetchLibrary,
  fetchPoolClips,
  fetchAudioEngineInstall,
  fetchAudioEngineStatus,
  installAudioEngine,
  formatTime,
  putDraft,
  reexportLibraryItem,
} from "../lib/api";
import VideoPlayer, { VideoPlayerHandle } from "../components/VideoPlayer";
import Timeline from "../components/Timeline";
import ClipMetaForm from "../components/ClipMetaForm";
import TagCharacterFromFrame from "../components/TagCharacterFromFrame";
import EntityMultiPicker from "../components/EntityMultiPicker";
import { fireToast } from "../lib/toast";
import { showOpenAIQuotaToast, userFacingOpenAIError } from "../lib/openaiUx";
import { useDebouncedAutosave } from "../lib/useDebouncedAutosave";

interface Props {
  source: PoolItem;
  onClose: () => void;
  onExported: () => void;
  onCharactersChanged?: () => void;
  onScenesChanged?: () => void;
  onObjectsChanged?: () => void;
  hasOpenAIKey: boolean;
  /** When set, mount in re-export mode for this library clip id. */
  initialEditClipId?: string | null;
}

const ESTIMATED_FPS = 30;
const STEM_QUALITY_STORAGE_KEY = "cowboy.stemQuality";

function readStoredStemQuality(): StemQuality | null {
  try {
    const value = window.localStorage.getItem(STEM_QUALITY_STORAGE_KEY);
    return value === "fast" ? value : null;
  } catch {
    return null;
  }
}

function persistStemQuality(value: StemQuality): void {
  try {
    window.localStorage.setItem(STEM_QUALITY_STORAGE_KEY, value);
  } catch {
    // Preferences are best-effort.
  }
}

/** Authoritative duration + in/out clamped for export / caption (matches timeline). */
function exportRangeSeconds(
  video: HTMLVideoElement | null,
  editorDuration: number,
  poolDuration: number,
  inT: number,
  outT: number
): { expIn: number; expOut: number; dur: number } {
  const dur =
    video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : editorDuration > 0
        ? editorDuration
        : poolDuration > 0
          ? poolDuration
          : 0;
  if (dur <= 0) {
    const expIn = Math.max(0, inT);
    const expOut = Math.max(expIn + 1 / 60, outT);
    return { expIn, expOut, dur: 0 };
  }
  const expIn = Math.max(0, Math.min(inT, dur));
  const expOut = Math.max(expIn + 1 / 60, Math.min(outT, dur));
  return { expIn, expOut, dur };
}

export default function EditorOverlay({
  source,
  onClose,
  onExported,
  onCharactersChanged,
  onScenesChanged,
  onObjectsChanged,
  hasOpenAIKey,
  initialEditClipId,
}: Props) {
  const playerRef = useRef<VideoPlayerHandle>(null);
  const inTRef = useRef(0);

  const [duration, setDuration] = useState(source.duration || 0);
  const [fps, setFps] = useState(ESTIMATED_FPS);
  const [current, setCurrent] = useState(0);
  const [inT, setInT] = useState(0);
  const [outT, setOutT] = useState(source.duration || 1);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [characters, setCharacters] = useState<MatchedCharacter[]>([]);
  const [scenes, setScenes] = useState<NamedRef[]>([]);
  const [objects, setObjects] = useState<NamedRef[]>([]);
  const [unknownPeople, setUnknownPeople] = useState<UnknownPerson[]>([]);
  const [sampleFrames, setSampleFrames] = useState<SampleFrame[]>([]);
  const [captionCacheKey, setCaptionCacheKey] = useState<string | null>(null);

  const [allCharacters, setAllCharacters] = useState<Character[]>([]);
  const [exportMode, setExportMode] = useState<ExportMode>("clip");
  const [initialStemPreference] = useState(() => {
    const stored = readStoredStemQuality();
    return {
      quality: stored ?? ("fast" as StemQuality),
      wasStored: Boolean(stored),
    };
  });
  const [createStems, setCreateStems] = useState(false);
  const [stemQuality, setStemQuality] = useState<StemQuality>(
    initialStemPreference.quality
  );
  const [audioEngineStatus, setAudioEngineStatus] =
    useState<AudioEngineStatus | null>(null);
  const [audioEngineLoading, setAudioEngineLoading] = useState(true);
  const [showStemSetup, setShowStemSetup] = useState(false);
  const [stemSetupBusy, setStemSetupBusy] = useState(false);
  const [stemSetupError, setStemSetupError] = useState<string | null>(null);
  const [captioning, setCaptioning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which trim handle is being dragged on the timeline (for split-pane preview). */
  const [trimDrag, setTrimDrag] = useState<"in" | "out" | null>(null);
  /** Existing clips already carved out of this source (for timeline bands). */
  const [existingClips, setExistingClips] = useState<ExistingPoolClip[]>([]);
  /** When set, Export becomes "Re-export" — POSTs to /api/library/:id/reexport. */
  const [editingClipId, setEditingClipId] = useState<string | null>(null);

  // ---- Draft autosave -----------------------------------------------------
  /** True while we're fetching the initial draft for this source. */
  const [draftLoading, setDraftLoading] = useState(true);
  /** Restored draft pending user decision (Discard / Keep editing). Null once dismissed. */
  const [restoredDraft, setRestoredDraft] = useState<Draft | null>(null);
  /** A draft exists on the server for this source (drives the pill visibility). */
  const [hasDraft, setHasDraft] = useState(false);
  /** Last time the draft was saved (server `updatedAt`-style). Drives the "Xs ago" label. */
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  /** Tick once a second so the "Xs ago" pill stays current without re-renders elsewhere. */
  const [pillNowTick, setPillNowTick] = useState(0);

  const captionAbort = useRef<AbortController | null>(null);

  inTRef.current = inT;

  const handleTrimDragChange = useCallback((kind: "in" | "out" | null) => {
    setTrimDrag(kind);
  }, []);

  async function reloadCharacters() {
    try {
      const r = await fetchCharacters();
      setAllCharacters(r.items);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    reloadCharacters();
  }, [source.id]);

  const reloadExistingClips = useCallback(async () => {
    try {
      const r = await fetchPoolClips(source.id);
      setExistingClips(r.items);
    } catch {
      // ignore — bands just won't render
    }
  }, [source.id]);

  useEffect(() => {
    reloadExistingClips();
  }, [reloadExistingClips]);

  const refreshAudioEngineStatus = useCallback(async () => {
    setAudioEngineLoading(true);
    try {
      const status = await fetchAudioEngineStatus();
      setAudioEngineStatus(status);
      if (!initialStemPreference.wasStored && status.recommendedQuality) {
        setStemQuality(status.recommendedQuality);
      }
      return status;
    } catch {
      const status = {
        ready: false,
        installing: false,
        pythonAvailable: false,
        message: "Audio splitting is not ready yet.",
      };
      setAudioEngineStatus(status);
      return status;
    } finally {
      setAudioEngineLoading(false);
    }
  }, [initialStemPreference.wasStored]);

  useEffect(() => {
    let cancelled = false;
    refreshAudioEngineStatus().then((status) => {
      if (cancelled) return;
      setAudioEngineStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshAudioEngineStatus]);

  const handleStemSetup = useCallback(async () => {
    setStemSetupBusy(true);
    setStemSetupError(null);
    try {
      let job = await installAudioEngine();
      for (let attempt = 0; job.status === "queued" || job.status === "running"; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        job = await fetchAudioEngineInstall();
        if (attempt >= 900) throw new Error("Installation is taking longer than expected. Check again shortly.");
      }
      if (job.status === "error") throw new Error(job.message);
      const status = await refreshAudioEngineStatus();
      if (status.ready) setShowStemSetup(false);
      else setStemSetupError(status.message);
    } catch (err) {
      setStemSetupError(err instanceof Error ? err.message : "Audio engine installation could not finish.");
    } finally {
      setStemSetupBusy(false);
    }
  }, [refreshAudioEngineStatus]);

  useEffect(() => {
    setCreateStems(false);
  }, [source.id]);

  useEffect(() => {
    if (editingClipId) setCreateStems(false);
  }, [editingClipId]);

  const handleStemQuality = useCallback((quality: StemQuality) => {
    setStemQuality(quality);
    persistStemQuality(quality);
  }, []);

  useEffect(() => {
    if (!initialEditClipId) return;
    void loadExisting(initialEditClipId);
    // We intentionally fire only once per id+source — loadExisting is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEditClipId, source.id]);

  // Fetch any pre-existing draft for this source on mount. If found, surface
  // the restore banner; user picks Keep editing / Discard before autosave kicks
  // in so we don't immediately overwrite their saved work with editor defaults.
  useEffect(() => {
    let cancelled = false;
    setDraftLoading(true);
    setRestoredDraft(null);
    setHasDraft(false);
    setDraftSavedAt(null);
    fetchDraft(source.id)
      .then((d) => {
        if (cancelled) return;
        if (d) {
          setRestoredDraft(d);
          setHasDraft(true);
          setDraftSavedAt(d.updatedAt);
        }
      })
      .catch(() => {
        // Ignore — drafts are best-effort.
      })
      .finally(() => {
        if (!cancelled) setDraftLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  // Tick once per second while a draft exists so the "saved Xs ago" label updates.
  useEffect(() => {
    if (!hasDraft || !draftSavedAt) return undefined;
    const h = window.setInterval(() => setPillNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(h);
  }, [hasDraft, draftSavedAt]);

  const loadExisting = useCallback(
    async (id: string) => {
      try {
        const lib = await fetchLibrary();
        const item = lib.items.find((it: LibraryItem) => it.id === id);
        if (!item) {
          setError("Could not find that clip in the library.");
          return;
        }
        setEditingClipId(id);
        setName(item.name ?? "");
        setDescription(item.description ?? "");
        setTags(item.tags ?? []);
        setCharacters(item.characters ?? []);
        setScenes(item.scenes ?? []);
        setObjects(item.objects ?? []);
        const inV = typeof item.in === "number" ? item.in : 0;
        const outV =
          typeof item.out === "number" ? item.out : (item.duration ?? 0) + inV;
        setInT(inV);
        setOutT(outV);
        setExportMode("clip");
        setStatusMsg(`Editing existing clip: ${item.name}`);
        setError(null);
        playerRef.current?.seek(inV);
      } catch (err) {
        setError(String(err));
      }
    },
    []
  );

  const onLoaded = useCallback((info: { duration: number; width: number; height: number }) => {
    const d = info.duration;
    setDuration(d);
    setInT((i) => Math.max(0, Math.min(i, d)));
    setOutT((o) => {
      if (o > d || o <= 0) return d;
      // Default `outT` was `1` when pool duration was unknown; expand only if IN still at start.
      if (d > 2 && Math.abs(o - 1) < 0.02 && inTRef.current < 0.05) return d;
      return Math.min(o, d);
    });
    const v = playerRef.current?.el;
    if (v) {
      const guess = guessFps(v);
      if (guess) setFps(guess);
    }
  }, []);

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
        if (!ac.signal.aborted) {
          showOpenAIQuotaToast(err);
          setError(userFacingOpenAIError(err));
        }
      } finally {
        if (!ac.signal.aborted) setCaptioning(false);
      }
    },
    [hasOpenAIKey, source.id]
  );

  // ---- Autosave wiring ----------------------------------------------------
  const autosaveActive =
    !draftLoading && !restoredDraft && !editingClipId;
  const autosaveActiveRef = useRef(autosaveActive);
  autosaveActiveRef.current = autosaveActive;

  const draftInput: DraftInput = useMemo(() => {
    const safeIn = Number.isFinite(inT) ? Math.max(0, inT) : 0;
    const safeOut =
      Number.isFinite(outT) && outT > safeIn ? outT : safeIn + 1 / 60;
    return {
      in: safeIn,
      out: safeOut,
      name: name ?? "",
      description: description ?? "",
      tags: tags.slice(0, 50),
      characters: characters.slice(0, 50),
      scenes: scenes.slice(0, 50),
      objects: objects.slice(0, 50),
    };
  }, [inT, outT, name, description, tags, characters, scenes, objects]);
  const draftKey = useMemo(() => JSON.stringify(draftInput), [draftInput]);
  const draftInputRef = useRef(draftInput);
  draftInputRef.current = draftInput;

  const sourceIdRef = useRef(source.id);
  sourceIdRef.current = source.id;

  const saveDraft = useCallback(async (_v: string) => {
    if (!autosaveActiveRef.current) return;
    const sid = sourceIdRef.current;
    const saved = await putDraft(sid, draftInputRef.current);
    if (sourceIdRef.current !== sid) return;
    setHasDraft(true);
    setDraftSavedAt(saved.updatedAt);
  }, []);

  const draftSave = useDebouncedAutosave(draftKey, saveDraft, {
    debounceMs: 800,
  });

  const handleDiscardDraft = useCallback(async () => {
    try {
      await deleteDraft(source.id);
    } catch {
      // best-effort
    }
    setRestoredDraft(null);
    setHasDraft(false);
    setDraftSavedAt(null);
    setInT(0);
    setOutT(duration > 0 ? duration : source.duration || 1);
    setName("");
    setDescription("");
    setTags([]);
    setCharacters([]);
    setScenes([]);
    setObjects([]);
  }, [source.id, source.duration, duration]);

  const handleKeepDraft = useCallback(() => {
    if (!restoredDraft) return;
    setInT(restoredDraft.in);
    setOutT(restoredDraft.out);
    setName(restoredDraft.name);
    setDescription(restoredDraft.description);
    setTags(restoredDraft.tags);
    setCharacters(restoredDraft.characters);
    setScenes(restoredDraft.scenes);
    setObjects(restoredDraft.objects);
    setHasDraft(true);
    setDraftSavedAt(restoredDraft.updatedAt);
    setRestoredDraft(null);
    playerRef.current?.seek(restoredDraft.in);
  }, [restoredDraft]);

  const handleAutoFill = useCallback(() => {
    const { expIn, expOut } = exportRangeSeconds(
      playerRef.current?.el ?? null,
      duration,
      source.duration,
      inT,
      outT
    );
    runAutoCaption(expIn, expOut);
  }, [inT, outT, duration, source.duration, runAutoCaption]);

  const handleExport = useCallback(async () => {
    if (!name.trim()) {
      setError("Give the clip a name first.");
      return;
    }
    if (
      createStems &&
      !audioEngineStatus?.ready
    ) {
      setShowStemSetup(true);
      setError("Set up audio splitting before exporting with stems.");
      return;
    }
    const { expIn, expOut, dur } = exportRangeSeconds(
      playerRef.current?.el ?? null,
      duration,
      source.duration,
      inT,
      outT
    );
    if (exportMode !== "source" && dur > 0 && expOut - expIn < 0.1) {
      setError("Selection is too short.");
      return;
    }
    if (exportMode !== "source" && dur <= 0) {
      setError("Video duration not ready yet — wait a moment and try again.");
      return;
    }
    setExporting(true);
    setError(null);
    if (editingClipId) {
      setStatusMsg("Re-exporting clip in place…");
      try {
        const requestStems =
          createStems &&
          audioEngineStatus?.ready;
        const item = await reexportLibraryItem(editingClipId, {
          in: expIn,
          out: expOut,
          name,
          description,
          tags,
          characters,
          scenes,
          objects,
          ...(requestStems ? { stems: { quality: stemQuality } } : {}),
        });
        const stemQueued =
          item.stemJob?.status === "queued" || item.stemJob?.status === "running";
        const stemError = item.stemJob?.status === "error";
        setStatusMsg(
          stemQueued
            ? `Re-exported ${item.filename} · stems queued`
            : `Re-exported ${item.filename} (${item.mode})`
        );
        fireToast({
          kind: "success",
          title: stemQueued
            ? "Clip re-exported · stem separation queued"
            : "Clip re-exported",
          body: stemQueued
            ? `${item.filename} · ${stemQuality} quality`
            : `${item.filename} · ${item.mode}`,
          action: {
            label: "Show in Finder",
            onClick: () => {
              fetch(`/api/library/${item.id}/reveal`, { method: "POST" }).catch(
                () => {
                  // best-effort
                }
              );
            },
          },
        });
        if (stemError) {
          fireToast({
            kind: "warn",
            title: "Clip re-exported; stems did not start",
            body: item.stemJob?.error || "Check audio splitting setup.",
          });
        }
        setCreateStems(false);
        await reloadExistingClips();
        onExported();
      } catch (err) {
        setError(String(err));
        setStatusMsg(null);
      } finally {
        setExporting(false);
      }
      return;
    }
    setStatusMsg(
      exportMode === "bundle"
        ? "Exporting clip + cloning source…"
        : exportMode === "source"
        ? "Cloning source…"
        : "Exporting…"
    );
    try {
      const requestStems =
        createStems &&
        exportMode !== "source" &&
        audioEngineStatus?.ready;
      const item = await exportClip({
        sourceId: source.id,
        in: expIn,
        out: expOut,
        name,
        description,
        tags,
        characters,
        scenes,
        objects,
        mode: exportMode,
        ...(requestStems ? { stems: { quality: stemQuality } } : {}),
      });
      // Clean up the draft for this source — it just became a real clip.
      deleteDraft(source.id)
        .then(() => {
          setHasDraft(false);
          setDraftSavedAt(null);
        })
        .catch(() => {
          /* best-effort */
        });
      const stemQueued =
        item.stemJob?.status === "queued" || item.stemJob?.status === "running";
      const stemError = item.stemJob?.status === "error";
      setStatusMsg(
        stemQueued
          ? `Exported ${item.filename} · stems queued`
          : `Exported as ${item.filename} (${item.mode})`
      );
      fireToast({
        kind: "success",
        title: stemQueued
          ? "Clip exported · stem separation queued"
          : "Clip exported",
        body: stemQueued
          ? `${item.filename} · ${stemQuality} quality`
          : `${item.filename} · ${item.mode}`,
        action: {
          label: "Show in Finder",
          onClick: () => {
            fetch(`/api/library/${item.id}/reveal`, { method: "POST" }).catch(
              () => {
                // best-effort
              }
            );
          },
        },
      });
      if (stemError) {
        fireToast({
          kind: "warn",
          title: "Clip exported; stems did not start",
          body: item.stemJob?.error || "Check audio splitting setup.",
        });
      }
      setCreateStems(false);
      await reloadExistingClips();
      onExported();
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
    scenes,
    objects,
    inT,
    outT,
    duration,
    source.duration,
    exportMode,
    createStems,
    stemQuality,
    audioEngineStatus,
    source.id,
    editingClipId,
    reloadExistingClips,
    onExported,
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
  }, [current, handleExport, onClose]);

  const knownDuration = Math.max(duration, source.duration || 0);
  const safeIn =
    knownDuration > 0
      ? Math.max(0, Math.min(inT, knownDuration))
      : Math.max(0, inT);
  const safeOut =
    knownDuration > 0
      ? Math.max(safeIn, Math.min(outT, knownDuration))
      : Math.max(safeIn, outT);
  const trimPreviewT = trimDrag === "out" ? safeOut : safeIn;
  const videoSrc = `/api/video/${source.id}`;

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
          {hasDraft && !editingClipId && (
            <DraftPill
              saving={draftSave.state === "saving" || draftSave.state === "pending"}
              savedAt={draftSavedAt}
              nowTick={pillNowTick}
            />
          )}
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

      {restoredDraft && !editingClipId && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-400/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-200">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="rounded border border-amber-400/40 bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-100">
              Draft restored
            </span>
            <span className="truncate">
              IN <span className="font-mono">{formatTime(restoredDraft.in)}</span>{" "}
              · OUT <span className="font-mono">{formatTime(restoredDraft.out)}</span>{" "}
              · "{restoredDraft.name || "Untitled"}" ·{" "}
              {restoredDraft.tags.length} tag
              {restoredDraft.tags.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded border border-amber-400/40 px-2 py-1 text-xs text-red-300 hover:bg-amber-500/20"
              onClick={handleDiscardDraft}
            >
              Discard draft
            </button>
            <button
              className="rounded bg-amber-400 px-2.5 py-1 text-xs font-medium text-ink-950 hover:bg-amber-300"
              onClick={handleKeepDraft}
            >
              Keep editing
            </button>
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col-reverse overflow-hidden md:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:border-r md:border-ink-800">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-800 bg-ink-900 px-2 py-1.5 text-[11px]">
            <span className="text-ink-500">Trim point</span>
            <span className="font-mono text-ink-200">
              <span
                className={
                  trimDrag === "out"
                    ? "text-accent-300"
                    : trimDrag === "in"
                      ? "text-accent-300"
                      : "text-ink-400"
                }
              >
                {trimDrag === "out" ? "OUT" : "IN"}
              </span>{" "}
              {formatTime(trimPreviewT)}
            </span>
          </div>
          <div className="relative min-h-[120px] flex-1 md:min-h-0">
            <TrimPreviewPane
              src={videoSrc}
              t={trimPreviewT}
              duration={knownDuration || duration}
            />
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-800 bg-ink-900 px-2 py-1.5 text-[11px]">
            <span className="text-ink-500">Playhead</span>
            <span className="font-mono text-ink-200">{formatTime(current)}</span>
          </div>
          <div className="relative min-h-[120px] flex-1 md:min-h-0">
            <VideoPlayer
              ref={playerRef}
              src={videoSrc}
              fps={fps}
              onTimeUpdate={setCurrent}
              onLoaded={onLoaded}
            />
          </div>
        </div>
      </div>

      <div className="border-t border-ink-800">
        <Timeline
          duration={knownDuration > 0 ? knownDuration : 0.001}
          current={current}
          inT={safeIn}
          outT={safeOut}
          scenes={[]}
          activeSceneIndex={null}
          onSeek={(t) => playerRef.current?.seek(t)}
          onSetIn={setInT}
          onSetOut={setOutT}
          onTrimDragChange={handleTrimDragChange}
          existingClips={existingClips}
          highlightClipId={editingClipId}
          onLoadExisting={loadExisting}
        />
        {editingClipId && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-yellow-400/40 bg-yellow-500/15 px-4 py-1.5 text-xs text-yellow-300">
            <span>
              Editing existing clip — Export will overwrite this clip in place.
            </span>
            <button
              className="rounded border border-yellow-400/40 px-2 py-0.5 text-[11px] text-yellow-200 hover:bg-yellow-500/20"
              onClick={() => {
                setEditingClipId(null);
                setStatusMsg(null);
              }}
            >
              Cancel re-edit (back to new clip)
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-800 px-4 py-2 text-xs text-ink-500">
          <Hotkey>Space</Hotkey> play
          <Hotkey>I</Hotkey>
          <Hotkey>O</Hotkey> in/out
          <Hotkey>←</Hotkey>
          <Hotkey>→</Hotkey> step
          <Hotkey>⏎</Hotkey> export
        </div>

        <CharacterStrip
          sourceId={source.id}
          getCurrentTime={() => playerRef.current?.el?.currentTime ?? current}
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
          onTagged={(c) =>
            setCharacters((cs) =>
              cs.find((x) => x.id === c.id) ? cs : [...cs, c]
            )
          }
          onCharactersChanged={() => {
            reloadCharacters();
            onCharactersChanged?.();
          }}
          onError={setError}
        />

        <div className="flex flex-col gap-2 border-t border-ink-800 px-4 py-2">
          <EntityMultiPicker
            kind="scenes"
            label="Scenes"
            tone="sky"
            selected={scenes}
            onChange={setScenes}
            onCatalogChanged={onScenesChanged}
          />
          <EntityMultiPicker
            kind="objects"
            label="Objects"
            tone="fuchsia"
            selected={objects}
            onChange={setObjects}
            onCatalogChanged={onObjectsChanged}
          />
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
          exportMode={exportMode}
          onExportMode={(mode) => {
            setExportMode(mode);
            if (mode === "source") setCreateStems(false);
          }}
          createStems={createStems}
          onCreateStems={setCreateStems}
          onRequestStemSetup={() => { setStemSetupError(null); setShowStemSetup(true); }}
          stemQuality={stemQuality}
          onStemQuality={handleStemQuality}
          audioEngineStatus={audioEngineStatus}
          audioEngineLoading={audioEngineLoading}
          reexportMode={Boolean(editingClipId)}
        />
      </div>
      {showStemSetup && (
        <AudioSplittingSetupModal
          busy={stemSetupBusy}
          error={stemSetupError}
          status={audioEngineStatus?.message}
          onInstall={handleStemSetup}
          onNotNow={() => {
            setCreateStems(false);
            setShowStemSetup(false);
            setStemSetupError(null);
          }}
        />
      )}
    </div>
  );
}

function AudioSplittingSetupModal({
  busy,
  error,
  status,
  onInstall,
  onNotNow,
}: {
  busy: boolean;
  error: string | null;
  status?: string;
  onInstall: () => void;
  onNotNow: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 shadow-xl" role="dialog" aria-modal="true">
        <div className="space-y-3 px-5 py-5">
          <h2 className="text-base font-semibold">Set up audio splitting</h2>
          <p className="text-sm leading-5 text-ink-300">{status ?? "Audio splitting is not available in this build yet."}</p>
          <p className="text-xs leading-5 text-ink-500">Setup creates a Clipper Cowboy-managed Python 3.11 environment, installs the pinned Demucs engine, and downloads its model before enabling exports.</p>
          {error && <div className="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-ink-800 px-5 py-3">
          <button className="rounded px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100" onClick={onNotNow} disabled={busy}>Not now</button>
          <button className="rounded bg-accent-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-50" onClick={onInstall} disabled={busy}>
            {busy ? "Setting up…" : "Install Demucs model"}
          </button>
        </div>
      </div>
    </div>
  );
  /*
  const [candidates, setCandidates] = useState<StemStudioCandidate[]>([]);
  const [discovering, setDiscovering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    discoverStemStudioInstallations()
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const foundOne = candidates.length === 1 ? candidates[0] : undefined;
  const noVerifiedCandidate = candidates.length === 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div
        className="w-full max-w-md rounded-xl border border-ink-800 bg-ink-900 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audio-splitting-setup-title"
      >
        <div className="space-y-3 px-5 py-5">
          <h2 id="audio-splitting-setup-title" className="text-base font-semibold">
            Set up audio splitting
          </h2>
          <p className="text-sm leading-5 text-ink-300">
            Clipper Cowboy uses the free Stem Studio app on this Mac to separate dialogue, music, and effects.
          </p>
          <p className="text-xs leading-5 text-ink-500">
            The first time, Stem Studio needs to be installed locally and may download models. This can take a few minutes.
          </p>
          {!connected && !discovering && noVerifiedCandidate && (
            <>
              <div className="rounded-md border border-ink-700 bg-ink-800/50 p-3 text-sm text-ink-200">
                Stem Studio not found on this Mac
              </div>
              <ol className="list-decimal space-y-1 pl-4 text-xs leading-5 text-ink-400">
                <li>Download or clone Stem Studio.</li>
                <li>Open its folder here.</li>
                <li>Clipper Cowboy will verify it.</li>
              </ol>
            </>
          )}
          {!connected && foundOne && (
            <div className="rounded-md border border-accent-500/40 bg-accent-500/10 p-3 text-sm text-ink-100">
              Stem Studio found
            </div>
          )}
          {connected && helperSetupRequired && (
            <div className="space-y-1 text-xs leading-5 text-ink-300">
              <p className="font-medium text-ink-100">Stem Studio is ready to finish setup.</p>
              <p>
                Clipper Cowboy needs to build Stem Studio’s local helper once. This may install
                its JavaScript dependencies; audio models are downloaded by Stem Studio when you
                use them.
              </p>
            </div>
          )}
          {connected && !helperSetupRequired && (
            <p className="text-xs leading-5 text-ink-500">
              Stem Studio is connected. Finish any first-time setup in Stem Studio, then check again.
            </p>
          )}
          {error && (
            <div className="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {error}
            </div>
          )}
          {technicalDetails && (
            <details className="rounded border border-ink-700 bg-ink-950/40 px-3 py-2 text-xs text-ink-400">
              <summary className="cursor-pointer text-ink-300">Technical details</summary>
              <p className="mt-2 break-words">{technicalDetails}</p>
            </details>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-ink-800 px-5 py-3">
          {repairRequired && (
            <button
              className="mr-auto rounded px-3 py-1.5 text-sm text-amber-200 hover:text-amber-100"
              onClick={onRepairConfig}
              disabled={busy}
            >
              Repair old setup
            </button>
          )}
          <button
            className="rounded px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100"
            onClick={onNotNow}
            disabled={busy}
          >
            Not now
          </button>
          {connected && helperSetupRequired ? (
            <button
              className="rounded bg-accent-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-50"
              onClick={onFinishSetup}
              disabled={busy}
            >
              {busy ? "Finishing setup…" : "Finish audio setup"}
            </button>
          ) : connected ? (
            <button
              className="rounded bg-accent-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-50"
              onClick={onCheckAgain}
              disabled={busy}
            >
              {busy ? "Checking…" : "Check setup again"}
            </button>
          ) : foundOne ? (
            <>
              <button
                className="rounded px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100"
                onClick={onChooseFolder}
                disabled={busy}
              >
                Choose Stem Studio folder…
              </button>
              <button
                className="rounded bg-accent-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-50"
                onClick={() => onUseCandidate(foundOne.id)}
                disabled={busy}
              >
                {busy ? "Connecting…" : "Use Stem Studio"}
              </button>
            </>
          ) : (
            <>
              <a
                className="rounded px-3 py-1.5 text-sm text-accent-300 hover:text-accent-200"
                href="https://github.com/wassermanproductions/stem-studio"
                target="_blank"
                rel="noreferrer"
              >
                Get Stem Studio
              </a>
              <button
                className="rounded bg-accent-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-50"
                onClick={onChooseFolder}
                disabled={busy || discovering}
              >
                {busy ? "Choosing…" : "Choose Stem Studio folder…"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
*/
}

function CharacterStrip({
  sourceId,
  getCurrentTime,
  characters,
  allCharacters,
  unknownPeople,
  sampleFrames,
  onRemove,
  onName,
  onConnect,
  onIgnore,
  onAddExisting,
  onTagged,
  onCharactersChanged,
  onError,
}: {
  sourceId: string;
  getCurrentTime: () => number;
  characters: MatchedCharacter[];
  allCharacters: Character[];
  unknownPeople: UnknownPerson[];
  sampleFrames: SampleFrame[];
  onRemove: (id: string) => void;
  onName: (idx: number, name: string) => void;
  onConnect: (idx: number, characterId: string) => void;
  onIgnore: (idx: number) => void;
  onAddExisting: (c: Character) => void;
  onTagged: (c: MatchedCharacter) => void;
  onCharactersChanged: () => void;
  onError: (msg: string) => void;
}) {
  const matchedIds = new Set(characters.map((c) => c.id));
  const addable = allCharacters.filter((c) => !matchedIds.has(c.id));

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
            <option value="">+ add existing…</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <TagCharacterFromFrame
          sourceId={sourceId}
          getCurrentTime={getCurrentTime}
          existingCharacters={allCharacters}
          alreadyMatched={characters}
          onTagged={onTagged}
          onCharactersChanged={onCharactersChanged}
          onError={onError}
        />
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

/** Second video: stays paused, seeks to `t` whenever trim handles move (live trim preview). */
function TrimPreviewPane({
  src,
  t,
  duration,
}: {
  src: string;
  t: number;
  duration: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const cap =
      Number.isFinite(v.duration) && v.duration > 0
        ? v.duration
        : duration > 0
          ? duration
          : t;
    const maxT = typeof cap === "number" && cap > 0 ? cap : t;
    const c = Math.max(0, Math.min(t, maxT > 0 ? maxT - 1e-6 : t));

    const apply = () => {
      if (Math.abs(v.currentTime - c) > 1 / 90) v.currentTime = c;
    };

    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
  }, [t, src, duration]);

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      <video
        ref={ref}
        src={src}
        className="max-h-full max-w-full object-contain"
        muted
        playsInline
        preload="metadata"
      />
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

function DraftPill({
  saving,
  savedAt,
  nowTick: _nowTick,
}: {
  saving: boolean;
  savedAt: number | null;
  /** Unused but forces re-render every second so "Xs ago" stays current. */
  nowTick: number;
}) {
  const label = saving
    ? "Draft · auto-saving"
    : savedAt
    ? `Draft saved ${formatRelativeShort(savedAt)}`
    : "Draft";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-200"
      title="Auto-saved locally: in/out, name, description, tags, characters, scenes, objects."
      data-testid="draft-pill"
    >
      <span
        className={
          "inline-block h-1.5 w-1.5 rounded-full bg-amber-300 " +
          (saving ? "animate-pulse" : "")
        }
        style={{ boxShadow: "0 0 6px rgba(252,211,77,0.7)" }}
      />
      <span>{label}</span>
    </span>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}
