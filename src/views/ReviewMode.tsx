import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AutoCutCandidate,
  AutoCutState,
  Character,
  ExportMode,
  MatchedCharacter,
  PoolItem,
  UnknownPerson,
  addCharacterRef,
  captionClip,
  clearAutoCut,
  createCharacter,
  exportClip,
  fetchAutoCut,
  fetchCharacters,
  formatDuration,
  formatTime,
  setAutoCutSkipped,
  startAutoCut,
} from "../lib/api";

interface Props {
  source: PoolItem;
  defaultExportMode: ExportMode;
  onExportModeChange: (m: ExportMode) => void;
  onClose: () => void;
  onExported: () => void;
  onCharactersChanged?: () => void;
  hasOpenAIKey: boolean;
}

interface CandidateEdits {
  name: string;
  description: string;
  tags: string[];
  characters: MatchedCharacter[];
  inT: number;
  outT: number;
  status: "pending" | "approved" | "skipped";
}

const POLL_INTERVAL_MS = 1500;

export default function ReviewMode({
  source,
  defaultExportMode,
  onExportModeChange,
  onClose,
  onExported,
  onCharactersChanged,
  hasOpenAIKey,
}: Props) {
  const [state, setState] = useState<AutoCutState | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [edits, setEdits] = useState<Record<string, CandidateEdits>>({});
  const [allCharacters, setAllCharacters] = useState<Character[]>([]);
  const [exportMode, setExportMode] = useState<ExportMode>(defaultExportMode);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [recaptioning, setRecaptioning] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pollTimer = useRef<number | null>(null);

  // ---- bootstrap ---------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await startAutoCut(source.id);
        if (!cancelled) ingestState(initial, true);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    reloadCharacters();
    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id]);

  function ingestState(s: AutoCutState, initialBoot = false) {
    setState(s);
    setEdits((prev) => {
      const next = { ...prev };
      for (const c of s.candidates) {
        if (next[c.id]) continue; // don't clobber user edits
        const isSkipped = s.skipped.includes(c.id);
        next[c.id] = {
          name: c.caption?.name ?? "",
          description: c.caption?.description ?? "",
          tags: c.caption?.tags ?? [],
          characters: c.caption?.characters ?? [],
          inT: c.in,
          outT: c.out,
          status: isSkipped ? "skipped" : "pending",
        };
      }
      return next;
    });

    // jump to first non-skipped, non-approved candidate on first boot
    if (initialBoot && s.candidates.length > 0) {
      const firstUnreviewed = s.candidates.findIndex(
        (c) => !s.skipped.includes(c.id)
      );
      if (firstUnreviewed >= 0) setActiveIdx(firstUnreviewed);
    }

    // schedule polling while still running
    if (
      (s.status === "detecting" || s.status === "captioning") &&
      !pollTimer.current
    ) {
      pollTimer.current = window.setInterval(async () => {
        try {
          const fresh = await fetchAutoCut(source.id);
          ingestState(fresh);
          if (fresh.status === "complete" || fresh.status === "error") {
            if (pollTimer.current) {
              window.clearInterval(pollTimer.current);
              pollTimer.current = null;
            }
          }
        } catch {
          // ignore; will try again next tick
        }
      }, POLL_INTERVAL_MS);
    }
  }

  async function reloadCharacters() {
    try {
      const r = await fetchCharacters();
      setAllCharacters(r.items);
    } catch {
      // ignore
    }
  }

  // ---- derived -----------------------------------------------------------

  const candidates: AutoCutCandidate[] = state?.candidates ?? [];
  const active = candidates[activeIdx];
  const activeEdits: CandidateEdits | undefined = active
    ? edits[active.id]
    : undefined;

  const counts = useMemo(() => {
    let approved = 0;
    let skipped = 0;
    let pending = 0;
    for (const c of candidates) {
      const e = edits[c.id];
      if (!e) {
        pending += 1;
        continue;
      }
      if (e.status === "approved") approved += 1;
      else if (e.status === "skipped") skipped += 1;
      else pending += 1;
    }
    return { approved, skipped, pending, total: candidates.length };
  }, [candidates, edits]);

  // ---- video looping over current selection ------------------------------

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !activeEdits) return;
    const seekToIn = () => {
      try {
        v.currentTime = activeEdits.inT;
      } catch {
        // ignore
      }
      v.play().catch(() => {});
    };
    if (v.readyState >= 1) seekToIn();
    else v.addEventListener("loadedmetadata", seekToIn, { once: true });

    function onTime() {
      if (!v) return;
      if (v.currentTime >= activeEdits!.outT - 0.02) {
        try {
          v.currentTime = activeEdits!.inT;
        } catch {
          // ignore
        }
      }
    }
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [activeIdx, activeEdits?.inT, activeEdits?.outT]);

  // ---- mutations ---------------------------------------------------------

  function patchEdit(patch: Partial<CandidateEdits>) {
    if (!active) return;
    setEdits((prev) => ({ ...prev, [active.id]: { ...prev[active.id], ...patch } }));
  }

  function pickExportMode(m: ExportMode) {
    setExportMode(m);
    onExportModeChange(m);
  }

  function gotoNextUnreviewed(fromIdx: number) {
    for (let i = fromIdx + 1; i < candidates.length; i += 1) {
      const e = edits[candidates[i].id];
      if (!e || e.status === "pending") {
        setActiveIdx(i);
        return;
      }
    }
    // wrap around
    for (let i = 0; i <= fromIdx; i += 1) {
      const e = edits[candidates[i].id];
      if (!e || e.status === "pending") {
        setActiveIdx(i);
        return;
      }
    }
    // nothing pending — show summary by leaving activeIdx alone
  }

  async function handleApprove() {
    if (!active || !activeEdits || exporting) return;
    if (!activeEdits.name.trim()) {
      setError("Give the clip a name first.");
      return;
    }
    if (
      exportMode !== "source" &&
      activeEdits.outT - activeEdits.inT < 0.1
    ) {
      setError("Selection is too short.");
      return;
    }
    setExporting(true);
    setError(null);
    setStatusMsg("Exporting…");
    try {
      const item = await exportClip({
        sourceId: source.id,
        in: activeEdits.inT,
        out: activeEdits.outT,
        name: activeEdits.name,
        description: activeEdits.description,
        tags: activeEdits.tags,
        characters: activeEdits.characters,
        mode: exportMode,
      });
      patchEdit({ status: "approved" });
      setStatusMsg(`Exported ${item.filename}`);
      onExported();
      gotoNextUnreviewed(activeIdx);
    } catch (err) {
      setError(String(err));
      setStatusMsg(null);
    } finally {
      setExporting(false);
    }
  }

  async function handleSkip() {
    if (!active) return;
    try {
      await setAutoCutSkipped(source.id, active.id, true);
      patchEdit({ status: "skipped" });
      gotoNextUnreviewed(activeIdx);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleUnskip(idx: number) {
    const c = candidates[idx];
    if (!c) return;
    try {
      await setAutoCutSkipped(source.id, c.id, false);
      setEdits((prev) => ({
        ...prev,
        [c.id]: { ...prev[c.id], status: "pending" },
      }));
      setActiveIdx(idx);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleReanalyze() {
    if (!confirm("Discard the current candidates and re-run AI analysis?")) return;
    try {
      await clearAutoCut(source.id);
      setEdits({});
      setActiveIdx(0);
      const fresh = await startAutoCut(source.id);
      ingestState(fresh, true);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleRecaption() {
    if (!active || !activeEdits || recaptioning || !hasOpenAIKey) return;
    setRecaptioning(true);
    setError(null);
    try {
      const c = await captionClip(source.id, activeEdits.inT, activeEdits.outT);
      patchEdit({
        name: c.name,
        description: c.description,
        tags: c.tags,
        characters: c.characters,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setRecaptioning(false);
    }
  }

  function removeMatched(id: string) {
    if (!activeEdits) return;
    patchEdit({ characters: activeEdits.characters.filter((c) => c.id !== id) });
  }

  function addExistingCharacter(c: Character) {
    if (!activeEdits) return;
    if (activeEdits.characters.find((x) => x.id === c.id)) return;
    patchEdit({
      characters: [...activeEdits.characters, { id: c.id, name: c.name }],
    });
  }

  async function nameUnknown(p: UnknownPerson, newName: string) {
    if (!newName.trim() || !active?.cacheKey) return;
    try {
      const newChar = await createCharacter({ name: newName.trim() });
      await addCharacterRef(newChar.id, {
        cacheKey: active.cacheKey,
        frameIndex: p.frameIndex,
      });
      addExistingCharacter(newChar as unknown as Character);
      reloadCharacters();
      onCharactersChanged?.();
    } catch (err) {
      setError(String(err));
    }
  }

  async function connectUnknown(p: UnknownPerson, characterId: string) {
    if (!active?.cacheKey) return;
    const target = allCharacters.find((c) => c.id === characterId);
    if (!target) return;
    try {
      await addCharacterRef(target.id, {
        cacheKey: active.cacheKey,
        frameIndex: p.frameIndex,
      });
      addExistingCharacter(target);
      reloadCharacters();
      onCharactersChanged?.();
    } catch (err) {
      setError(String(err));
    }
  }

  // ---- hotkeys -----------------------------------------------------------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (isFormField) return;
      switch (e.key) {
        case "a":
        case "A":
        case "Enter":
          e.preventDefault();
          handleApprove();
          break;
        case "s":
        case "S":
          e.preventDefault();
          handleSkip();
          break;
        case "j":
        case "J":
          e.preventDefault();
          if (activeIdx > 0) setActiveIdx(activeIdx - 1);
          break;
        case "k":
        case "K":
          e.preventDefault();
          if (activeIdx < candidates.length - 1) setActiveIdx(activeIdx + 1);
          break;
        case "r":
        case "R":
          e.preventDefault();
          handleRecaption();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, candidates.length, activeEdits, exportMode]);

  // ---- render ------------------------------------------------------------

  const isAnalyzing =
    state?.status === "detecting" || state?.status === "captioning";
  const allDone =
    state?.status === "complete" &&
    counts.pending === 0 &&
    counts.total > 0;

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-ink-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-ink-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="rounded-md border border-ink-700 px-2 py-1 text-sm text-ink-300 hover:bg-ink-800"
            onClick={onClose}
            title="Close (Esc)"
          >
            ✕ Exit review
          </button>
          <div className="truncate text-sm text-ink-300">
            <span className="text-ink-500">Auto-cut review · </span>
            {source.filename}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <ProgressStrip {...counts} />
          {isAnalyzing && (
            <span className="text-amber-300">
              {state?.status === "detecting"
                ? "Scanning scenes…"
                : `Captioning ${state?.done}/${state?.total}…`}
            </span>
          )}
          {statusMsg && <span className="text-emerald-300">{statusMsg}</span>}
          {error && (
            <span
              className="max-w-[26rem] truncate text-red-300"
              title={error}
            >
              {error}
            </span>
          )}
          <button
            className="rounded border border-ink-700 px-2 py-1 text-ink-300 hover:bg-ink-800"
            onClick={handleReanalyze}
            title="Discard current candidates and re-run AI"
          >
            Re-analyze
          </button>
        </div>
      </div>

      {/* Body: queue panel + main */}
      <div className="flex flex-1 overflow-hidden">
        {/* Queue */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-900/40">
          <div className="border-b border-ink-800 px-3 py-2 text-xs uppercase tracking-wide text-ink-500">
            Queue ({candidates.length})
          </div>
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {candidates.length === 0 && isAnalyzing && (
              <div className="p-3 text-xs text-ink-500">Waiting for scenes…</div>
            )}
            {candidates.map((c, idx) => {
              const e = edits[c.id];
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveIdx(idx)}
                  className={
                    "flex w-full items-start gap-2 border-b border-ink-800/60 px-3 py-2 text-left text-xs transition " +
                    (activeIdx === idx
                      ? "bg-ink-800 text-ink-100"
                      : "text-ink-300 hover:bg-ink-800/50")
                  }
                >
                  <StatusDot status={e?.status ?? "pending"} ready={!!c.caption} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {e?.name || c.caption?.name || (
                        <span className="italic text-ink-500">analyzing…</span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-ink-500">
                      {formatTime(c.in)} → {formatTime(c.out)} ·{" "}
                      {formatDuration(c.duration)}
                    </div>
                  </div>
                  {e?.status === "skipped" && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        handleUnskip(idx);
                      }}
                      className="text-[10px] text-ink-500 hover:text-ink-200"
                      title="Bring this candidate back"
                    >
                      undo
                    </button>
                  )}
                </button>
              );
            })}
          </div>
          <div className="border-t border-ink-800 px-3 py-2 text-[10px] text-ink-500">
            <Hotkey>A</Hotkey> approve · <Hotkey>S</Hotkey> skip ·{" "}
            <Hotkey>J</Hotkey>/<Hotkey>K</Hotkey> prev/next · <Hotkey>R</Hotkey>{" "}
            re-caption · <Hotkey>Esc</Hotkey> exit
          </div>
        </aside>

        {/* Main */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {!active ? (
            <div className="flex flex-1 items-center justify-center text-ink-400">
              {isAnalyzing
                ? "Analyzing source… first results will appear in the queue shortly."
                : allDone
                ? `All done — ${counts.approved} exported, ${counts.skipped} skipped.`
                : "No candidates yet."}
            </div>
          ) : (
            <ActiveCandidate
              videoRef={videoRef}
              source={source}
              candidate={active}
              edits={activeEdits!}
              allCharacters={allCharacters}
              exportMode={exportMode}
              onExportMode={pickExportMode}
              recaptioning={recaptioning}
              exporting={exporting}
              hasOpenAIKey={hasOpenAIKey}
              onPatch={patchEdit}
              onApprove={handleApprove}
              onSkip={handleSkip}
              onRecaption={handleRecaption}
              onRemoveCharacter={removeMatched}
              onAddExistingCharacter={addExistingCharacter}
              onNameUnknown={nameUnknown}
              onConnectUnknown={connectUnknown}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ---- subcomponents -------------------------------------------------------

function ProgressStrip({
  approved,
  skipped,
  pending,
  total,
}: {
  approved: number;
  skipped: number;
  pending: number;
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <span className="text-emerald-300">✓ {approved}</span>
      <span className="text-ink-500">✗ {skipped}</span>
      <span className="text-ink-300">· {pending} left</span>
      <span className="text-ink-600">/ {total}</span>
    </div>
  );
}

function StatusDot({
  status,
  ready,
}: {
  status: "pending" | "approved" | "skipped";
  ready: boolean;
}) {
  if (status === "approved")
    return <span className="mt-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />;
  if (status === "skipped")
    return <span className="mt-1 inline-block h-2 w-2 rounded-full bg-ink-600" />;
  if (!ready)
    return (
      <span className="mt-1 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400/60" />
    );
  return <span className="mt-1 inline-block h-2 w-2 rounded-full bg-accent-500" />;
}

function ActiveCandidate({
  videoRef,
  source,
  candidate,
  edits,
  allCharacters,
  exportMode,
  onExportMode,
  recaptioning,
  exporting,
  hasOpenAIKey,
  onPatch,
  onApprove,
  onSkip,
  onRecaption,
  onRemoveCharacter,
  onAddExistingCharacter,
  onNameUnknown,
  onConnectUnknown,
}: {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  source: PoolItem;
  candidate: AutoCutCandidate;
  edits: CandidateEdits;
  allCharacters: Character[];
  exportMode: ExportMode;
  onExportMode: (m: ExportMode) => void;
  recaptioning: boolean;
  exporting: boolean;
  hasOpenAIKey: boolean;
  onPatch: (p: Partial<CandidateEdits>) => void;
  onApprove: () => void;
  onSkip: () => void;
  onRecaption: () => void;
  onRemoveCharacter: (id: string) => void;
  onAddExistingCharacter: (c: Character) => void;
  onNameUnknown: (p: UnknownPerson, name: string) => void;
  onConnectUnknown: (p: UnknownPerson, characterId: string) => void;
}) {
  const matchedIds = new Set(edits.characters.map((c) => c.id));
  const addable = allCharacters.filter((c) => !matchedIds.has(c.id));
  const unknownPeople = candidate.caption?.unknownPeople ?? [];
  const sampleFrames = candidate.caption?.sampleFrames ?? [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 items-center justify-center bg-black">
        <video
          ref={videoRef}
          key={source.id}
          src={`/api/video/${source.id}`}
          controls
          autoPlay
          playsInline
          className="h-full w-full object-contain"
        />
      </div>

      <div className="border-t border-ink-800 bg-ink-950/60 px-4 py-3">
        {/* Selection sliders */}
        <div className="mb-3 flex items-center gap-3 font-mono text-[11px] text-ink-400">
          <label className="flex items-center gap-1">
            in
            <input
              type="number"
              step="0.05"
              value={edits.inT.toFixed(3)}
              onChange={(e) =>
                onPatch({ inT: Math.max(0, Number(e.target.value)) })
              }
              className="w-24 rounded bg-ink-800 px-2 py-0.5 text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            />
          </label>
          <label className="flex items-center gap-1">
            out
            <input
              type="number"
              step="0.05"
              value={edits.outT.toFixed(3)}
              onChange={(e) => onPatch({ outT: Number(e.target.value) })}
              className="w-24 rounded bg-ink-800 px-2 py-0.5 text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            />
          </label>
          <span className="text-ink-500">
            ({(edits.outT - edits.inT).toFixed(2)}s, AI suggested{" "}
            {formatTime(candidate.in)} → {formatTime(candidate.out)})
          </span>
        </div>

        {/* Form */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
          <div className="grid grid-cols-1 gap-2">
            <input
              className="rounded bg-ink-800 px-3 py-2 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={edits.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              placeholder="Clip name"
            />
            <textarea
              rows={2}
              className="rounded bg-ink-800 px-3 py-2 text-sm text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={edits.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              placeholder="One-sentence summary"
            />
            <input
              className="rounded bg-ink-800 px-3 py-2 font-mono text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={edits.tags.join(", ")}
              onChange={(e) =>
                onPatch({
                  tags: e.target.value
                    .split(",")
                    .map((t) => t.trim().toLowerCase())
                    .filter((t, i, arr) => t && arr.indexOf(t) === i),
                })
              }
              placeholder="tag1, tag2, tag3"
            />
          </div>

          <div className="flex flex-col items-end justify-between gap-2">
            <button
              onClick={onRecaption}
              disabled={recaptioning || !hasOpenAIKey}
              className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-800 disabled:opacity-40"
              title="Re-run AI on the current in/out (R)"
            >
              {recaptioning ? "Re-captioning…" : "Re-caption (R)"}
            </button>
            <ModePicker exportMode={exportMode} onExportMode={onExportMode} />
            <div className="flex gap-2">
              <button
                onClick={onSkip}
                className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800"
                title="Skip (S)"
              >
                Skip ✗
              </button>
              <button
                onClick={onApprove}
                disabled={exporting || !edits.name.trim()}
                className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black shadow hover:bg-accent-400 disabled:opacity-40"
                title="Approve & export (A or Enter)"
              >
                {exporting ? "Exporting…" : "Approve & export ✓"}
              </button>
            </div>
          </div>
        </div>

        {/* Characters */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-500">
            Characters
          </span>
          {edits.characters.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs text-emerald-200"
            >
              {c.name}
              <button
                onClick={() => onRemoveCharacter(c.id)}
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
                if (c) onAddExistingCharacter(c);
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

        {/* Unknown people */}
        {unknownPeople.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
            <div className="text-xs text-amber-200">
              Unknown character{unknownPeople.length === 1 ? "" : "s"} spotted —
              name, connect, or ignore:
            </div>
            <div className="flex flex-wrap gap-3">
              {unknownPeople.map((u, idx) => (
                <UnknownCard
                  key={idx}
                  person={u}
                  allCharacters={allCharacters}
                  frame={sampleFrames[u.frameIndex]?.url}
                  onName={(n) => onNameUnknown(u, n)}
                  onConnect={(id) => onConnectUnknown(u, id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModePicker({
  exportMode,
  onExportMode,
}: {
  exportMode: ExportMode;
  onExportMode: (m: ExportMode) => void;
}) {
  const opts: { id: ExportMode; label: string }[] = [
    { id: "clip", label: "Clip" },
    { id: "source", label: "Source" },
    { id: "bundle", label: "Bundle" },
  ];
  return (
    <div className="flex overflow-hidden rounded-md border border-ink-700 text-[11px]">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onExportMode(o.id)}
          className={
            "px-2 py-1 transition " +
            (exportMode === o.id
              ? "bg-accent-500 text-black"
              : "bg-ink-900 text-ink-300 hover:bg-ink-800")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UnknownCard({
  person,
  allCharacters,
  frame,
  onName,
  onConnect,
}: {
  person: UnknownPerson;
  allCharacters: Character[];
  frame: string | undefined;
  onName: (n: string) => void;
  onConnect: (id: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="flex w-60 flex-col gap-1.5 rounded border border-ink-800 bg-ink-900 p-2">
      {frame ? (
        <img
          src={frame}
          alt=""
          className="aspect-video w-full rounded object-cover"
        />
      ) : (
        <div className="aspect-video w-full rounded bg-ink-800" />
      )}
      <div className="text-[11px] text-ink-300">{person.description}</div>
      {naming ? (
        <div className="flex gap-1">
          <input
            autoFocus
            className="flex-1 rounded bg-ink-800 px-2 py-1 text-[11px] text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Character name"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
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
            className="rounded bg-accent-500 px-2 py-1 text-[10px] font-medium text-black hover:bg-accent-400 disabled:opacity-50"
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
        <div className="flex flex-wrap items-center gap-1">
          <button
            className="rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-200 hover:bg-ink-700"
            onClick={() => setNaming(true)}
          >
            Name
          </button>
          {allCharacters.length > 0 && (
            <select
              className="rounded bg-ink-800 px-2 py-1 text-[10px] text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value=""
              onChange={(e) => {
                if (e.target.value) onConnect(e.target.value);
              }}
            >
              <option value="">Connect…</option>
              {allCharacters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}

function Hotkey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-ink-700 bg-ink-900 px-1 py-0.5 font-mono text-[9px] text-ink-300">
      {children}
    </kbd>
  );
}
