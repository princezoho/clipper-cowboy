import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Character,
  Entity,
  ExportCollectionResult,
  LibraryItem,
  NamedRef,
  OrphanFile,
  adoptOrphans,
  copyLibraryToClipboard,
  createCharacter,
  createEntity,
  deleteLibraryItem,
  exportCollection,
  fetchCharacters,
  fetchEntities,
  formatBytes,
  formatDuration,
  formatTime,
  patchLibraryItem,
  renameLibraryItem,
  repairMissingLibrary,
  revealLibrarySelectionInFinder,
  sendLibraryToPremiere,
  trashOrphans,
} from "../lib/api";
import { fireToast } from "../lib/toast";
import FieldStatus from "../components/FieldStatus";
import ChipPicker from "../components/ChipPicker";
import { useDebouncedAutosave } from "../lib/useDebouncedAutosave";

interface Props {
  items: LibraryItem[];
  loading: boolean;
  onChanged: () => void;
  missingCount?: number;
  orphans?: OrphanFile[];
  selectedCharacterIds: Set<string>;
  selectedSceneIds: Set<string>;
  selectedObjectIds: Set<string>;
  selectedTags: Set<string>;
  searchText: string;
  onToggleCharacter: (id: string) => void;
  onToggleScene: (id: string) => void;
  onToggleObject: (id: string) => void;
  onToggleTag: (tag: string) => void;
  onSearchChange: (s: string) => void;
  onClearFilters: () => void;
  onPreviewInEditor?: (id: string) => void;
}

function slugAlnum(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function clipMatchesCharacter(
  item: LibraryItem,
  character: { id: string; name: string }
): boolean {
  if (item.characters?.some((c) => c.id === character.id)) return true;
  // Tag-name fallback (mirrors backend) for older clips without explicit
  // character associations.
  const target = slugAlnum(character.name);
  if (!target) return false;
  return (item.tags ?? []).some((t) => slugAlnum(t) === target);
}

export default function LibraryView({
  items,
  loading,
  onChanged,
  missingCount = 0,
  orphans = [],
  selectedCharacterIds,
  selectedSceneIds,
  selectedObjectIds,
  selectedTags,
  searchText,
  onToggleCharacter,
  onToggleScene,
  onToggleObject,
  onToggleTag,
  onSearchChange,
  onClearFilters,
  onPreviewInEditor,
}: Props) {
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Entity[]>([]);
  const [objects, setObjects] = useState<Entity[]>([]);
  const [searchDraft, setSearchDraft] = useState(searchText);
  // null = closed; "filter" = export the current filter; "selection" = export the
  // explicit selectedIds set. Both render the same modal but build different
  // payloads.
  const [exportContext, setExportContext] = useState<null | "filter" | "selection">(
    null
  );
  // ---- Multi-select state for batch copy / reveal / export ----------------
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Index (within the current `filtered` view) of the last card the user
  // clicked. Used as the anchor for shift+click range selection.
  const lastClickedIdxRef = useRef<number | null>(null);
  const [busyAction, setBusyAction] = useState<
    null | "copy" | "reveal" | "send-premiere"
  >(null);
  // Session-only state for the C.0 integrity banners.
  const [missingDismissed, setMissingDismissed] = useState(false);
  const [orphansDismissed, setOrphansDismissed] = useState(false);
  const [showOnlyMissing, setShowOnlyMissing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [trashingOrphans, setTrashingOrphans] = useState(false);

  // ---- Hover-preview state -----------------------------------------------
  // Only one card is ever the "active previewer" at a time. Mouse-enter on
  // a card sets activePreviewId to its id; the previously active card sees
  // isActive=false and unmounts its <video>. This also caps concurrent
  // media decoders at one regardless of grid size.
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  // Audio toggle for hover previews. Default off so autoplay is always
  // permitted by the browser; persisted under "cowboy.previewAudio" so it
  // survives reloads.
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

  // Keep the local input synchronised with the lifted state (e.g. after
  // "Clear all" wipes it).
  useEffect(() => {
    setSearchDraft(searchText);
  }, [searchText]);

  // 300ms debounce on the search input.
  useEffect(() => {
    if (searchDraft === searchText) return;
    const id = window.setTimeout(() => onSearchChange(searchDraft), 300);
    return () => window.clearTimeout(id);
  }, [searchDraft, searchText, onSearchChange]);

  // Pull the entity catalogs so we can render filter chips by name even when
  // no clip in the result set carries the entity. Cheap and cached client-side.
  // Also reused by inline-edit ChipPickers on every card.
  const reloadCharacters = useCallback(() => {
    fetchCharacters()
      .then((r) => setCharacters(r.items))
      .catch(() => setCharacters([]));
  }, []);
  const reloadScenes = useCallback(() => {
    fetchEntities("scenes")
      .then((r) => setScenes(r.items))
      .catch(() => setScenes([]));
  }, []);
  const reloadObjects = useCallback(() => {
    fetchEntities("objects")
      .then((r) => setObjects(r.items))
      .catch(() => setObjects([]));
  }, []);

  useEffect(() => {
    reloadCharacters();
    reloadScenes();
    reloadObjects();
  }, [reloadCharacters, reloadScenes, reloadObjects]);

  const charactersAsNamedRefs = useMemo<NamedRef[]>(
    () => characters.map((c) => ({ id: c.id, name: c.name })),
    [characters]
  );
  const scenesAsNamedRefs = useMemo<NamedRef[]>(
    () => scenes.map((s) => ({ id: s.id, name: s.name })),
    [scenes]
  );
  const objectsAsNamedRefs = useMemo<NamedRef[]>(
    () => objects.map((o) => ({ id: o.id, name: o.name })),
    [objects]
  );

  const charactersById = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters) m.set(c.id, c);
    return m;
  }, [characters]);

  const scenesById = useMemo(() => {
    const m = new Map<string, Entity>();
    for (const s of scenes) m.set(s.id, s);
    return m;
  }, [scenes]);

  const objectsById = useMemo(() => {
    const m = new Map<string, Entity>();
    for (const o of objects) m.set(o.id, o);
    return m;
  }, [objects]);

  const selectedCharacters = useMemo(() => {
    const list: NamedRef[] = [];
    for (const id of selectedCharacterIds) {
      const c = charactersById.get(id);
      if (c) list.push({ id: c.id, name: c.name });
      else {
        // Fallback: derive name from any clip's characters array.
        for (const it of items) {
          const match = it.characters?.find((cc) => cc.id === id);
          if (match) {
            list.push({ id: match.id, name: match.name });
            break;
          }
        }
      }
    }
    return list;
  }, [selectedCharacterIds, charactersById, items]);

  const selectedScenes = useMemo(() => {
    const list: NamedRef[] = [];
    for (const id of selectedSceneIds) {
      const s = scenesById.get(id);
      if (s) list.push({ id: s.id, name: s.name });
      else {
        for (const it of items) {
          const m = it.scenes?.find((x) => x.id === id);
          if (m) {
            list.push({ id: m.id, name: m.name });
            break;
          }
        }
      }
    }
    return list;
  }, [selectedSceneIds, scenesById, items]);

  const selectedObjects = useMemo(() => {
    const list: NamedRef[] = [];
    for (const id of selectedObjectIds) {
      const o = objectsById.get(id);
      if (o) list.push({ id: o.id, name: o.name });
      else {
        for (const it of items) {
          const m = it.objects?.find((x) => x.id === id);
          if (m) {
            list.push({ id: m.id, name: m.name });
            break;
          }
        }
      }
    }
    return list;
  }, [selectedObjectIds, objectsById, items]);

  const needle = searchText.trim().toLowerCase();

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (showOnlyMissing && !item.missing) return false;
      for (const c of selectedCharacters) {
        if (!clipMatchesCharacter(item, c)) return false;
      }
      for (const s of selectedScenes) {
        if (!item.scenes?.some((x) => x.id === s.id)) return false;
      }
      for (const o of selectedObjects) {
        if (!item.objects?.some((x) => x.id === o.id)) return false;
      }
      for (const tag of selectedTags) {
        const has = (item.tags ?? []).some((t) => t.toLowerCase() === tag);
        if (!has) return false;
      }
      if (needle) {
        const hay = [
          item.name,
          item.description,
          ...(item.tags ?? []),
          ...((item.characters ?? []).map((c) => c.name)),
          ...((item.scenes ?? []).map((s) => s.name)),
          ...((item.objects ?? []).map((o) => o.name)),
        ]
          .filter(Boolean)
          .join(" \u0001 ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [
    items,
    selectedCharacters,
    selectedScenes,
    selectedObjects,
    selectedTags,
    needle,
    showOnlyMissing,
  ]);

  const showMissingBanner = missingCount > 0 && !missingDismissed;
  const showOrphansBanner = orphans.length > 0 && !orphansDismissed;

  // ---- Multi-select helpers ----------------------------------------------
  // macOS-only features (clipboard / reveal-many) get a disabled state with
  // an explanatory tooltip on Linux/Windows.
  const isMacPlatform = useMemo(() => {
    if (typeof navigator === "undefined") return true;
    const p = (navigator.platform || "") + " " + (navigator.userAgent || "");
    return /Mac|iPhone|iPod|iPad/i.test(p);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    lastClickedIdxRef.current = null;
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    lastClickedIdxRef.current = null;
  }, []);

  const filteredIds = useMemo(() => filtered.map((it) => it.id), [filtered]);

  const handleCardSelectClick = useCallback(
    (idx: number, e: React.MouseEvent) => {
      const id = filteredIds[idx];
      if (!id) return;
      if (e.shiftKey && lastClickedIdxRef.current !== null) {
        const a = Math.min(lastClickedIdxRef.current, idx);
        const b = Math.max(lastClickedIdxRef.current, idx);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = a; i <= b; i += 1) next.add(filteredIds[i]);
          return next;
        });
        // Don't move the anchor on shift-click — matches Finder/Mail.
      } else {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        lastClickedIdxRef.current = idx;
      }
    },
    [filteredIds]
  );

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(filteredIds));
    lastClickedIdxRef.current = filteredIds.length > 0 ? 0 : null;
  }, [filteredIds]);

  // Esc exits selection mode; Cmd/Ctrl+A selects all currently filtered cards.
  useEffect(() => {
    if (!selectionMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        exitSelectionMode();
        return;
      }
      const isModA =
        (e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A");
      if (isModA) {
        const tgt = e.target as HTMLElement | null;
        if (
          tgt &&
          (tgt.tagName === "INPUT" ||
            tgt.tagName === "TEXTAREA" ||
            tgt.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        selectAllVisible();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode, exitSelectionMode, selectAllVisible]);

  // Drop selections that vanish from the filtered set (e.g. user toggled a
  // filter chip while in selection mode). Keeps "N selected" honest.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const visible = new Set(filteredIds);
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (visible.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedIds(next);
    // Intentionally don't depend on selectedIds (would re-run forever).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredIds]);

  /** Map "currently selected ids" → ordered list with absolute paths. */
  const selectionAsItems = useCallback((): LibraryItem[] => {
    const set = selectedIds;
    return items.filter((it) => set.has(it.id));
  }, [selectedIds, items]);

  async function handleCopySelection() {
    if (selectedIds.size === 0 || busyAction) return;
    const ids = Array.from(selectedIds);
    setBusyAction("copy");
    try {
      const r = await copyLibraryToClipboard(ids);
      fireToast({
        kind: "success",
        title: `Copied ${r.count} clip${r.count === 1 ? "" : "s"} to clipboard`,
        body: "Paste into Premiere's Project panel, or paste in Finder to copy the files.",
      });
    } catch (err) {
      fireToast({ kind: "error", title: "Clipboard copy failed", body: String(err) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSendSelectionToPremiere() {
    if (selectedIds.size === 0 || busyAction || !isMacPlatform) return;
    const ids = Array.from(selectedIds);
    setBusyAction("send-premiere");
    try {
      // Inline fetch (instead of sendLibraryToPremiere) so we can read the
      // `code` field on a 500 response and surface the install-missing
      // toast with the exact copy from the spec.
      const res = await fetch("/api/library/send-to-premiere", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        let body: { error?: unknown; code?: unknown } = {};
        try {
          body = await res.json();
        } catch {
          // ignore — fall through to generic message below
        }
        if (res.status === 500 && body?.code === "premiere-missing") {
          fireToast({
            kind: "error",
            title: "Adobe Premiere Pro doesn't appear to be installed.",
          });
          return;
        }
        const msg =
          typeof body?.error === "string"
            ? body.error
            : `${res.status} ${res.statusText}`;
        fireToast({
          kind: "error",
          title: "Send to Premiere failed",
          body: msg,
        });
        return;
      }
      const r = (await res.json()) as { count: number };
      fireToast({
        kind: "success",
        title: `Sent ${r.count} clip${r.count === 1 ? "" : "s"} to Premiere.`,
      });
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Send to Premiere failed",
        body: String(err),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRevealSelection() {
    if (selectedIds.size === 0 || busyAction) return;
    const ids = Array.from(selectedIds);
    setBusyAction("reveal");
    try {
      const r = await revealLibrarySelectionInFinder(ids);
      fireToast({
        kind: "info",
        title: `Revealing ${r.count} clip${r.count === 1 ? "" : "s"} in Finder`,
      });
    } catch (err) {
      fireToast({ kind: "error", title: "Reveal failed", body: String(err) });
    } finally {
      setBusyAction(null);
    }
  }

  /** Build dataTransfer payload for HTML5 drag-out from a card. */
  const startDragForCard = useCallback(
    (item: LibraryItem, e: React.DragEvent<HTMLElement>) => {
      // Multi-drag if the dragged card is part of the selection, else single.
      const sel = selectionAsItems();
      const dragItems =
        selectedIds.has(item.id) && sel.length > 0 ? sel : [item];
      const paths = dragItems.map((it) => it.path).filter(Boolean);
      if (paths.length === 0) return;
      try {
        e.dataTransfer.effectAllowed = "copy";
        const text = paths.join("\n");
        e.dataTransfer.setData("text/plain", text);
        e.dataTransfer.setData("text/uri-list", paths.map((p) => `file://${p}`).join("\n"));
        e.dataTransfer.setData("application/octet-stream", text);
        // Chrome's native "drag a download" — only the first file participates,
        // multi-file isn't supported by the browser. Premiere's drag-import is
        // unreliable across versions; surface this caveat in the action-bar
        // tooltip.
        const first = dragItems[0];
        const fname = first.filename || "clip.mp4";
        e.dataTransfer.setData(
          "DownloadURL",
          `video/mp4:${fname}:file://${encodeURI(first.path)}`
        );
      } catch {
        // Any of these can throw on stricter browsers — drag still proceeds
        // with whatever data did register.
      }
    },
    [selectedIds, selectionAsItems]
  );

  async function handleRepairMissing() {
    setRepairing(true);
    try {
      const r = await repairMissingLibrary();
      if (r.repaired > 0) {
        fireToast({
          kind: "success",
          title: "Re-rendered missing clips",
          body: `${r.repaired} clip${r.repaired === 1 ? "" : "s"} restored${r.errors.length ? ` · ${r.errors.length} failed` : ""}`,
        });
      } else {
        fireToast({
          kind: r.errors.length > 0 ? "error" : "info",
          title: "No clips re-rendered",
          body:
            r.errors.length > 0
              ? `${r.errors.length} item${r.errors.length === 1 ? "" : "s"} skipped (source unavailable?)`
              : "Nothing to repair.",
        });
      }
      onChanged();
    } catch (err) {
      fireToast({ kind: "error", title: "Re-render failed", body: String(err) });
    } finally {
      setRepairing(false);
    }
  }

  async function handleAdoptOrphans() {
    setAdopting(true);
    try {
      const r = await adoptOrphans(orphans.map((o) => o.path));
      fireToast({
        kind: "success",
        title: "Adopted orphan files",
        body: `${r.adopted} file${r.adopted === 1 ? "" : "s"} now tracked in the library`,
      });
      onChanged();
    } catch (err) {
      fireToast({ kind: "error", title: "Adopt failed", body: String(err) });
    } finally {
      setAdopting(false);
    }
  }

  async function handleTrashOrphans() {
    if (
      !confirm(
        `Move ${orphans.length} untracked clip file${orphans.length === 1 ? "" : "s"} to Trash?`
      )
    ) {
      return;
    }
    setTrashingOrphans(true);
    try {
      const r = await trashOrphans(orphans.map((o) => o.path));
      fireToast({
        kind: "warn",
        title: "Moved to Trash",
        body: `${r.trashed} orphan file${r.trashed === 1 ? "" : "s"} moved to ~/.Trash`,
      });
      onChanged();
    } catch (err) {
      fireToast({ kind: "error", title: "Move-to-Trash failed", body: String(err) });
    } finally {
      setTrashingOrphans(false);
    }
  }

  const hasAnyFilter =
    selectedCharacters.length > 0 ||
    selectedScenes.length > 0 ||
    selectedObjects.length > 0 ||
    selectedTags.size > 0 ||
    needle.length > 0;

  /** Slug used to prefill the export folder name. */
  const filterSlug = useMemo(() => {
    const parts: string[] = [];
    for (const c of selectedCharacters) parts.push(c.name);
    for (const s of selectedScenes) parts.push(s.name);
    for (const o of selectedObjects) parts.push(o.name);
    for (const t of selectedTags) parts.push(t);
    if (needle) parts.push(needle);
    if (parts.length === 0) parts.push("library");
    return parts
      .map((p) =>
        p
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
      )
      .filter(Boolean)
      .join("_")
      .slice(0, 80);
  }, [selectedCharacters, selectedScenes, selectedObjects, selectedTags, needle]);

  if (loading && items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-ink-400">
        Loading library…
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ink-400">
        <div className="text-lg text-ink-200">Library is empty</div>
        <div className="max-w-md text-sm">
          Open a pool video, mark in/out, and export. Your clips show up here.
        </div>
      </div>
    );
  }

  return (
    <>
      {(showMissingBanner || showOrphansBanner) && (
        <div className="flex flex-col gap-2 px-5 pt-4">
          {showMissingBanner && (
            <div
              data-testid="library-missing-banner"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-amber-200"
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded border border-amber-400/40 bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px]">
                  MISSING
                </span>
                <span>
                  <strong>{missingCount}</strong>{" "}
                  {missingCount === 1 ? "clip has" : "clips have"} missing files
                </span>
                <span className="text-amber-200/70">
                  · sidecar exists, .mp4 not on disk
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowOnlyMissing((v) => !v)}
                  className={
                    "rounded border border-amber-400/40 px-2.5 py-1 text-xs font-medium hover:bg-amber-500/15 " +
                    (showOnlyMissing
                      ? "bg-amber-500/20 text-amber-100"
                      : "text-amber-100")
                  }
                >
                  {showOnlyMissing ? "Show all" : "Show only missing"}
                </button>
                <button
                  type="button"
                  onClick={handleRepairMissing}
                  disabled={repairing}
                  className="rounded bg-amber-500 px-3 py-1 text-xs font-semibold text-black hover:bg-amber-400 disabled:opacity-50"
                >
                  {repairing ? "Re-rendering…" : "Re-render missing"}
                </button>
                <button
                  type="button"
                  onClick={() => setMissingDismissed(true)}
                  className="rounded border border-amber-400/40 px-2.5 py-1 text-xs text-amber-100 hover:bg-amber-500/15"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {showOrphansBanner && (
            <div
              data-testid="library-orphan-banner"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-400/40 bg-sky-500/10 px-4 py-3 text-sky-200"
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="rounded border border-sky-400/40 bg-sky-500/20 px-1.5 py-0.5 font-mono text-[11px]">
                  ORPHAN
                </span>
                <span>
                  <strong>{orphans.length}</strong> untracked clip file
                  {orphans.length === 1 ? "" : "s"} in clips folder
                </span>
                <span className="text-sky-200/70">· no sidecar found</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAdoptOrphans}
                  disabled={adopting}
                  className="rounded bg-sky-500 px-3 py-1 text-xs font-semibold text-black hover:bg-sky-400 disabled:opacity-50"
                >
                  {adopting ? "Adopting…" : "Adopt all"}
                </button>
                <button
                  type="button"
                  onClick={handleTrashOrphans}
                  disabled={trashingOrphans}
                  className="rounded border border-sky-400/40 px-2.5 py-1 text-xs text-sky-100 hover:bg-sky-500/15 disabled:opacity-50"
                >
                  {trashingOrphans ? "Moving…" : "Move all to Trash"}
                </button>
                <button
                  type="button"
                  onClick={() => setOrphansDismissed(true)}
                  className="rounded border border-sky-400/40 px-2.5 py-1 text-xs text-sky-100 hover:bg-sky-500/15"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-ink-800 bg-ink-950/95 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search clips by name, description, tag, character, scene, or object…"
              className="w-full rounded-md bg-ink-900 px-3 py-2 pr-8 text-sm text-ink-100 outline-none ring-1 ring-ink-700 placeholder:text-ink-500 focus:ring-accent-500"
              data-testid="library-search"
            />
            {searchDraft && (
              <button
                type="button"
                onClick={() => {
                  setSearchDraft("");
                  onSearchChange("");
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-ink-500 hover:text-ink-200"
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setAudioOn((v) => !v)}
            data-testid="library-preview-audio-toggle"
            aria-pressed={audioOn}
            title={`Preview audio (currently ${audioOn ? "on" : "off"})`}
            className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:bg-ink-800"
          >
            <span aria-hidden="true">{audioOn ? "\uD83D\uDD0A" : "\uD83D\uDD07"}</span>
            <span className="sr-only">
              Preview audio (currently {audioOn ? "on" : "off"})
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectionMode) {
                exitSelectionMode();
              } else {
                setSelectionMode(true);
              }
            }}
            data-testid="library-select-toggle"
            className={
              "rounded-md px-3 py-2 text-sm font-medium transition " +
              (selectionMode
                ? "bg-accent-500 text-black hover:bg-accent-400"
                : "border border-ink-700 text-ink-200 hover:bg-ink-800")
            }
            title={selectionMode ? "Exit selection mode (Esc)" : "Multi-select clips for batch copy / reveal / export"}
          >
            {selectionMode ? "Done" : "Select"}
          </button>
          <button
            type="button"
            onClick={() => setExportContext("filter")}
            disabled={filtered.length === 0}
            data-testid="export-collection-btn"
            className="rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              filtered.length === 0
                ? "No clips match — adjust filters first"
                : `Export ${filtered.length} clip${filtered.length === 1 ? "" : "s"} as a folder for Premiere`
            }
          >
            Export collection ({filtered.length})
          </button>
          <div className="text-xs text-ink-500">
            {hasAnyFilter
              ? `${filtered.length} of ${items.length}`
              : `${items.length} clip${items.length === 1 ? "" : "s"}`}
          </div>
        </div>

        {selectionMode && (
          <div
            data-testid="library-selection-bar"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-500/40 bg-accent-500/5 px-3 py-2"
          >
            <div className="flex items-center gap-3 text-xs">
              <span
                data-testid="library-selection-count"
                className="rounded bg-accent-500 px-2 py-0.5 font-mono text-[11px] font-semibold text-black"
              >
                {selectedIds.size} selected
              </span>
              <span className="text-ink-400">
                of {filtered.length} visible · click to toggle, shift-click for range, ⌘A for all
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={selectAllVisible}
                disabled={filtered.length === 0 || selectedIds.size === filtered.length}
                className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Select all visible
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={selectedIds.size === 0}
                className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleCopySelection}
                disabled={selectedIds.size === 0 || !isMacPlatform || busyAction !== null}
                data-testid="library-copy-btn"
                title={
                  !isMacPlatform
                    ? "Clipboard copy uses macOS osascript and is unavailable on this platform"
                    : "Copy files to the macOS clipboard. Drag from a card works in Finder; for Premiere use Copy or Reveal."
                }
                className="rounded-md bg-accent-500 px-3 py-1 text-xs font-semibold text-black hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {!isMacPlatform
                  ? "Copy to clipboard (macOS only)"
                  : busyAction === "copy"
                    ? "Copying…"
                    : `Copy ${selectedIds.size} to clipboard`}
              </button>
              <button
                type="button"
                onClick={handleSendSelectionToPremiere}
                disabled={
                  selectedIds.size === 0 ||
                  !isMacPlatform ||
                  busyAction !== null
                }
                data-testid="library-send-premiere-btn"
                title={
                  !isMacPlatform
                    ? "macOS only"
                    : "Open Adobe Premiere Pro and import the selected clips"
                }
                className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-bold text-black shadow-sm ring-1 ring-emerald-300/40 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {!isMacPlatform
                  ? "Send to Premiere (macOS only)"
                  : busyAction === "send-premiere"
                    ? "Sending…"
                    : `Send ${selectedIds.size} to Premiere`}
              </button>
              <button
                type="button"
                onClick={handleRevealSelection}
                disabled={selectedIds.size === 0 || !isMacPlatform || busyAction !== null}
                title={
                  !isMacPlatform
                    ? "Reveal uses macOS Finder and is unavailable on this platform"
                    : "Open Finder with all selected clips highlighted"
                }
                className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busyAction === "reveal" ? "Revealing…" : "Reveal in Finder"}
              </button>
              <button
                type="button"
                onClick={() => setExportContext("selection")}
                disabled={selectedIds.size === 0 || busyAction !== null}
                className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Export {selectedIds.size > 0 ? `${selectedIds.size} ` : ""}as folder…
              </button>
            </div>
          </div>
        )}

        {hasAnyFilter && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-ink-500">
              Filtering by:
            </span>
            {selectedCharacters.map((c) => (
              <FilterChip
                key={`char-${c.id}`}
                kind="character"
                label={`Character: ${c.name}`}
                onRemove={() => onToggleCharacter(c.id)}
              />
            ))}
            {selectedScenes.map((s) => (
              <FilterChip
                key={`scene-${s.id}`}
                kind="scene"
                label={`Scene: ${s.name}`}
                onRemove={() => onToggleScene(s.id)}
              />
            ))}
            {selectedObjects.map((o) => (
              <FilterChip
                key={`object-${o.id}`}
                kind="object"
                label={`Object: ${o.name}`}
                onRemove={() => onToggleObject(o.id)}
              />
            ))}
            {Array.from(selectedTags).map((t) => (
              <FilterChip
                key={`tag-${t}`}
                kind="tag"
                label={`Tag: ${t}`}
                onRemove={() => onToggleTag(t)}
              />
            ))}
            {needle && (
              <FilterChip
                kind="search"
                label={`Search: "${needle}"`}
                onRemove={() => {
                  setSearchDraft("");
                  onSearchChange("");
                }}
              />
            )}
            <button
              type="button"
              onClick={onClearFilters}
              className="ml-1 text-[11px] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-ink-400">
          <div className="text-base text-ink-200">
            No clips match these filters.
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800"
            >
              Clear filters
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-5">
          {filtered.map((item, idx) => (
            <ClipCard
              key={item.id}
              item={item}
              onPreview={() => setPreview(item)}
              onChanged={onChanged}
              selectedTags={selectedTags}
              onToggleTag={onToggleTag}
              selectedCharacterIds={selectedCharacterIds}
              onToggleCharacter={onToggleCharacter}
              selectedSceneIds={selectedSceneIds}
              onToggleScene={onToggleScene}
              selectedObjectIds={selectedObjectIds}
              onToggleObject={onToggleObject}
              characterOptions={charactersAsNamedRefs}
              sceneOptions={scenesAsNamedRefs}
              objectOptions={objectsAsNamedRefs}
              onCharactersCatalogChanged={reloadCharacters}
              onScenesCatalogChanged={reloadScenes}
              onObjectsCatalogChanged={reloadObjects}
              selectionMode={selectionMode}
              isSelected={selectedIds.has(item.id)}
              onSelectClick={(e) => handleCardSelectClick(idx, e)}
              onDragStart={(e) => startDragForCard(item, e)}
              isActivePreview={activePreviewId === item.id}
              audioOn={audioOn}
              onPreviewEnter={handlePreviewEnter}
              onPreviewLeave={handlePreviewLeave}
              onPreviewInEditor={onPreviewInEditor}
            />
          ))}
        </div>
      )}
      {preview && (
        <PreviewModal item={preview} onClose={() => setPreview(null)} />
      )}
      {exportContext && (
        <ExportCollectionModal
          defaultName={
            exportContext === "selection"
              ? `selection-${selectedIds.size}`
              : filterSlug
          }
          fileCount={
            exportContext === "selection" ? selectedIds.size : filtered.length
          }
          onClose={() => setExportContext(null)}
          buildPayload={(name, zip, reveal) => ({
            name,
            zip,
            reveal,
            filter:
              exportContext === "selection"
                ? { ids: Array.from(selectedIds) }
                : {
                    q: searchText.trim() || undefined,
                    characterIds:
                      selectedCharacters.length > 0
                        ? selectedCharacters.map((c) => c.id)
                        : undefined,
                    sceneIds:
                      selectedScenes.length > 0
                        ? selectedScenes.map((s) => s.id)
                        : undefined,
                    objectIds:
                      selectedObjects.length > 0
                        ? selectedObjects.map((o) => o.id)
                        : undefined,
                    tagNames:
                      selectedTags.size > 0
                        ? Array.from(selectedTags)
                        : undefined,
                  },
          })}
        />
      )}
    </>
  );
}

type ChipKind = "character" | "scene" | "object" | "tag" | "search";

function FilterChip({
  kind,
  label,
  onRemove,
}: {
  kind: ChipKind;
  label: string;
  onRemove: () => void;
}) {
  const tone =
    kind === "character"
      ? "bg-accent-500 text-black"
      : kind === "scene"
        ? "bg-sky-400 text-black"
        : kind === "object"
          ? "bg-fuchsia-400 text-black"
          : kind === "tag"
            ? "bg-emerald-500/90 text-black"
            : "bg-ink-700 text-ink-100";
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium " +
        tone
      }
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-black/20"
        title="Remove filter"
        aria-label={`Remove filter ${label}`}
      >
        ×
      </button>
    </span>
  );
}

function ExportCollectionModal({
  defaultName,
  fileCount,
  onClose,
  buildPayload,
}: {
  defaultName: string;
  fileCount: number;
  onClose: () => void;
  buildPayload: (
    name: string,
    zip: boolean,
    reveal: boolean
  ) => Parameters<typeof exportCollection>[0];
}) {
  const [name, setName] = useState(defaultName);
  const [zip, setZip] = useState(false);
  const [reveal, setReveal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ExportCollectionResult | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run() {
    if (!name.trim()) {
      setError("Folder name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await exportCollection(buildPayload(name.trim(), zip, reveal));
      setDone(r);
      const revealPath = r.zipPath || r.folder;
      fireToast({
        kind: "success",
        title: "Collection exported",
        body: `${r.fileCount} clip${r.fileCount === 1 ? "" : "s"} · ${formatBytes(r.bytes)}`,
        action: {
          label: "Show in Finder",
          onClick: () => {
            fetch(`/api/reveal`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: revealPath }),
            }).catch(() => {
              // best-effort
            });
          },
        },
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-ink-800 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <div className="text-sm font-semibold text-ink-100">
            {done ? "Export complete" : `Export ${fileCount} clip${fileCount === 1 ? "" : "s"}`}
          </div>
          <button
            className="text-ink-500 hover:text-ink-100"
            onClick={onClose}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {!done ? (
          <div className="flex flex-col gap-3 p-5">
            <label className="grid gap-1 text-xs text-ink-400">
              Folder name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded bg-ink-800 px-3 py-2 font-mono text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
                placeholder="export-name"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) {
                    e.preventDefault();
                    run();
                  }
                }}
              />
              <span className="text-[11px] text-ink-500">
                Saved under <code className="text-ink-300">exports/&lt;name&gt;/</code> in your project. Special characters get sanitized.
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
              <input
                type="checkbox"
                className="accent-accent-500"
                checked={zip}
                onChange={(e) => setZip(e.target.checked)}
              />
              Zip the folder after copying
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-200">
              <input
                type="checkbox"
                className="accent-accent-500"
                checked={reveal}
                onChange={(e) => setReveal(e.target.checked)}
              />
              Reveal in Finder when done
            </label>
            {error && (
              <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:bg-ink-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={run}
                disabled={busy || !name.trim()}
                className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:opacity-40"
              >
                {busy ? "Exporting…" : `Export ${fileCount} clip${fileCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-5 text-sm text-ink-200">
            <div>
              Exported <strong>{done.fileCount}</strong> clip
              {done.fileCount === 1 ? "" : "s"} ({formatBytes(done.bytes)}) —{" "}
              {done.links} hardlink{done.links === 1 ? "" : "s"},{" "}
              {done.copies} cop{done.copies === 1 ? "y" : "ies"}.
            </div>
            <div className="break-all rounded bg-ink-800 p-2 font-mono text-xs text-ink-300">
              {done.folder}
            </div>
            {done.zipPath && (
              <div className="break-all rounded bg-ink-800 p-2 font-mono text-xs text-ink-300">
                {done.zipPath}
              </div>
            )}
            <div className="flex justify-end pt-1">
              <button
                onClick={onClose}
                className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black hover:bg-accent-400"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface ClipCardProps {
  item: LibraryItem;
  onPreview: () => void;
  onChanged: () => void;
  selectedTags: Set<string>;
  onToggleTag: (t: string) => void;
  selectedCharacterIds: Set<string>;
  onToggleCharacter: (id: string) => void;
  selectedSceneIds: Set<string>;
  onToggleScene: (id: string) => void;
  selectedObjectIds: Set<string>;
  onToggleObject: (id: string) => void;
  characterOptions: NamedRef[];
  sceneOptions: NamedRef[];
  objectOptions: NamedRef[];
  onCharactersCatalogChanged: () => void;
  onScenesCatalogChanged: () => void;
  onObjectsCatalogChanged: () => void;
  /** When true, thumbnail click toggles selection instead of opening preview. */
  selectionMode: boolean;
  isSelected: boolean;
  onSelectClick: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  /** True when this card is the single active hover previewer. */
  isActivePreview: boolean;
  /** Whether hover previews should play with audio (true) or muted (false). */
  audioOn: boolean;
  onPreviewEnter: (id: string) => void;
  onPreviewLeave: (id: string) => void;
  onPreviewInEditor?: (id: string) => void;
}

function ClipCard({
  item,
  onPreview,
  onChanged,
  selectedTags,
  onToggleTag,
  selectedCharacterIds,
  onToggleCharacter,
  selectedSceneIds,
  onToggleScene,
  selectedObjectIds,
  onToggleObject,
  characterOptions,
  sceneOptions,
  objectOptions,
  onCharactersCatalogChanged,
  onScenesCatalogChanged,
  onObjectsCatalogChanged,
  selectionMode,
  isSelected,
  onSelectClick,
  onDragStart,
  isActivePreview,
  audioOn,
  onPreviewEnter,
  onPreviewLeave,
  onPreviewInEditor,
}: ClipCardProps) {
  // Each field is a local-first piece of state with its own debounced autosave.
  // The save callback PATCHes ONLY that field so concurrent saves don't block.
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [tags, setTags] = useState<string[]>(item.tags);
  const [characters, setCharacters] = useState<NamedRef[]>(
    (item.characters ?? []).map((c) => ({ id: c.id, name: c.name }))
  );
  const [scenes, setScenes] = useState<NamedRef[]>(item.scenes ?? []);
  const [objects, setObjects] = useState<NamedRef[]>(item.objects ?? []);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  // When the server-side item changes (e.g. via repair-missing), sync local
  // mirrors. We only refresh on id change to avoid clobbering an in-progress
  // edit on the same card.
  useEffect(() => {
    setName(item.name);
    setDescription(item.description);
    setTags(item.tags);
    setCharacters((item.characters ?? []).map((c) => ({ id: c.id, name: c.name })));
    setScenes(item.scenes ?? []);
    setObjects(item.objects ?? []);
  }, [item.id]);

  const nameSave = useCallback(
    async (v: string) => {
      await patchLibraryItem(item.id, { name: v });
    },
    [item.id]
  );
  const descSave = useCallback(
    async (v: string) => {
      await patchLibraryItem(item.id, { description: v });
    },
    [item.id]
  );
  const tagsSave = useCallback(
    async (v: string[]) => {
      await patchLibraryItem(item.id, { tags: v });
    },
    [item.id]
  );
  const charactersSave = useCallback(
    async (v: NamedRef[]) => {
      await patchLibraryItem(item.id, { characters: v });
    },
    [item.id]
  );
  const scenesSave = useCallback(
    async (v: NamedRef[]) => {
      await patchLibraryItem(item.id, { scenes: v });
    },
    [item.id]
  );
  const objectsSave = useCallback(
    async (v: NamedRef[]) => {
      await patchLibraryItem(item.id, { objects: v });
    },
    [item.id]
  );

  const nameStatus = useDebouncedAutosave(name, nameSave);
  const descStatus = useDebouncedAutosave(description, descSave);
  // Arrays autosave with a shorter debounce — chip add/remove is a discrete
  // action, no need to wait 800ms.
  const tagsStatus = useDebouncedAutosave(tags, tagsSave, { debounceMs: 250 });
  const charsStatus = useDebouncedAutosave(characters, charactersSave, {
    debounceMs: 250,
  });
  const scenesStatus = useDebouncedAutosave(scenes, scenesSave, {
    debounceMs: 250,
  });
  const objectsStatus = useDebouncedAutosave(objects, objectsSave, {
    debounceMs: 250,
  });

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  async function remove() {
    setMenuOpen(false);
    if (!confirm(`Delete clip "${item.name}"? The file will also be removed.`)) {
      return;
    }
    try {
      await deleteLibraryItem(item.id);
      onChanged();
      fireToast({
        kind: "warn",
        title: "Clip deleted",
        body: item.name,
        durationMs: 10000,
        action: {
          label: "Undo (10s)",
          onClick: () => {
            // Best-effort restore; sidecar may be gone. Failures are silent.
            fetch(`/api/library/${item.id}/restore`, { method: "POST" })
              .then((r) => {
                if (r.ok) onChanged();
              })
              .catch(() => {
                // best-effort
              });
          },
        },
      });
    } catch (err) {
      alert(String(err));
    }
  }

  async function createCharacterRef(rawName: string): Promise<NamedRef> {
    const c = await createCharacter({ name: rawName.trim() });
    onCharactersCatalogChanged();
    return { id: c.id, name: c.name };
  }
  async function createSceneRef(rawName: string): Promise<NamedRef> {
    const e = await createEntity("scenes", { name: rawName.trim() });
    onScenesCatalogChanged();
    return { id: e.id, name: e.name };
  }
  async function createObjectRef(rawName: string): Promise<NamedRef> {
    const e = await createEntity("objects", { name: rawName.trim() });
    onObjectsCatalogChanged();
    return { id: e.id, name: e.name };
  }

  const isMissing = Boolean(item.missing);
  // In selection mode the thumbnail click toggles selection (Finder-style)
  // instead of opening the preview modal. The card menu (⋮ → Delete…) and the
  // inline-edit fields keep working as normal.
  const handleThumbClick = (e: React.MouseEvent) => {
    if (selectionMode) {
      onSelectClick(e);
      return;
    }
    if (!isMissing) onPreview();
  };
  return (
    <div
      data-testid={`library-card-${item.id}`}
      data-selected={isSelected ? "true" : undefined}
      className={
        "relative flex flex-col overflow-hidden rounded-xl border bg-ink-900 transition " +
        (isSelected
          ? "border-accent-500 ring-2 ring-accent-500/60"
          : "border-ink-800")
      }
      draggable={selectionMode}
      onDragStart={selectionMode ? onDragStart : undefined}
    >
      <button
        className="relative aspect-video overflow-hidden bg-ink-950 disabled:cursor-not-allowed"
        onClick={handleThumbClick}
        disabled={isMissing && !selectionMode}
        onMouseEnter={() => onPreviewEnter(item.id)}
        onMouseLeave={() => onPreviewLeave(item.id)}
        title={
          selectionMode
            ? isSelected
              ? "Click to deselect (shift-click for range)"
              : "Click to select (shift-click for range)"
            : isMissing
              ? "File missing on disk"
              : "Preview"
        }
      >
        <CardThumbnail
          item={item}
          isActive={isActivePreview && !selectionMode && !isMissing}
          audioOn={audioOn}
        />
        {isMissing && (
          <span
            className="absolute left-2 top-2 rounded bg-red-600/90 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-white shadow"
            title="Sidecar exists but the .mp4 file is missing on disk"
          >
            Missing
          </span>
        )}
        {item.duration != null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px]">
            {formatDuration(item.duration)}
          </span>
        )}
        {item.mode && !isMissing && (
          <span
            className={
              "absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] " +
              (item.mode === "stream-copy"
                ? "bg-emerald-500/80 text-black"
                : item.mode === "smart-cut"
                  ? "bg-accent-500/85 text-black"
                  : "bg-amber-500/85 text-black")
            }
            title={item.details}
          >
            {item.mode}
          </span>
        )}
      </button>

      {selectionMode && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelectClick(e);
          }}
          aria-label={isSelected ? "Deselect clip" : "Select clip"}
          aria-pressed={isSelected}
          data-testid={`card-checkbox-${item.id}`}
          className={
            "absolute left-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border-2 text-[12px] font-bold transition " +
            (isSelected
              ? "border-accent-500 bg-accent-500 text-black"
              : "border-white/70 bg-black/40 text-transparent backdrop-blur hover:border-white hover:text-white/60")
          }
          title={isSelected ? "Deselect" : "Select"}
        >
          ✓
        </button>
      )}

      <div ref={menuRef} className="absolute right-1.5 top-1.5 z-10">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Card actions"
          title="Card actions"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-base text-ink-100 backdrop-blur hover:bg-black/75"
          data-testid={`card-menu-${item.id}`}
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-8 z-20 w-56 overflow-hidden rounded-md border border-ink-700 bg-ink-800 shadow-xl">
            <button
              type="button"
              disabled={isMissing}
              title={isMissing ? "File is missing — repair first" : undefined}
              onClick={() => {
                setMenuOpen(false);
                if (isMissing) return;
                onPreviewInEditor?.(item.id);
              }}
              className="block w-full px-3 py-2 text-left text-xs text-ink-100 hover:bg-ink-700 disabled:cursor-not-allowed disabled:text-ink-500"
            >
              Preview in editor
            </button>
            <button
              type="button"
              disabled={isMissing}
              title={isMissing ? "File is missing — repair first" : undefined}
              onClick={() => {
                setMenuOpen(false);
                if (isMissing) return;
                setRenameDraft(stripExt(item.filename || item.name));
                setRenameError(null);
                setRenameOpen(true);
              }}
              className="block w-full px-3 py-2 text-left text-xs text-ink-100 hover:bg-ink-700 disabled:cursor-not-allowed disabled:text-ink-500"
            >
              Rename file…
            </button>
            <button
              type="button"
              onClick={async () => {
                setMenuOpen(false);
                try {
                  const r = await copyLibraryToClipboard([item.id]);
                  fireToast({
                    kind: "success",
                    title: `Copied ${r.count} clip — paste into Finder/Slack. For Premiere use Send to Premiere.`,
                  });
                } catch (err) {
                  fireToast({ kind: "error", title: "Clipboard copy failed", body: String(err) });
                }
              }}
              className="block w-full px-3 py-2 text-left text-xs text-ink-100 hover:bg-ink-700"
            >
              Copy to clipboard
            </button>
            <button
              type="button"
              disabled={isMissing}
              title={isMissing ? "File is missing — repair first" : undefined}
              onClick={async () => {
                setMenuOpen(false);
                if (isMissing) return;
                try {
                  const r = await sendLibraryToPremiere([item.id]);
                  fireToast({
                    kind: "success",
                    title: `Sent ${r.count} clip to Premiere.`,
                  });
                } catch (err) {
                  fireToast({
                    kind: "error",
                    title: "Send to Premiere failed",
                    body: String(err),
                  });
                }
              }}
              className="block w-full px-3 py-2 text-left text-xs text-ink-100 hover:bg-ink-700 disabled:cursor-not-allowed disabled:text-ink-500"
            >
              Send to Premiere
            </button>
            <button
              type="button"
              onClick={async () => {
                setMenuOpen(false);
                try {
                  await revealLibrarySelectionInFinder([item.id]);
                } catch (err) {
                  fireToast({ kind: "error", title: "Reveal failed", body: String(err) });
                }
              }}
              className="block w-full px-3 py-2 text-left text-xs text-ink-100 hover:bg-ink-700"
            >
              Reveal in Finder
            </button>
            <div className="border-t border-ink-700" />
            <button
              type="button"
              onClick={remove}
              className="block w-full px-3 py-2 text-left text-xs text-red-300 hover:bg-ink-700 hover:text-red-200"
            >
              Delete clip…
            </button>
          </div>
        )}
      </div>
      {renameOpen && (
        <RenamePopover
          initial={renameDraft}
          error={renameError}
          onCancel={() => setRenameOpen(false)}
          onSubmit={async (name) => {
            setRenameError(null);
            try {
              await renameLibraryItem(item.id, name);
              setRenameOpen(false);
              onChanged();
              fireToast({ kind: "success", title: `Renamed to ${name}` });
            } catch (err) {
              setRenameError(String(err));
            }
          }}
        />
      )}

      <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
        <FieldRow
          label="Name"
          status={
            <FieldStatus
              state={nameStatus.state}
              errorMessage={nameStatus.errorMessage}
            />
          }
        >
          <input
            className="w-full rounded bg-ink-800 px-2 py-1 text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void nameStatus.flush()}
            placeholder="Untitled clip"
          />
        </FieldRow>

        <FieldRow
          label="Description"
          status={
            <FieldStatus
              state={descStatus.state}
              errorMessage={descStatus.errorMessage}
            />
          }
        >
          <textarea
            className="min-h-[2.75rem] w-full resize-y rounded bg-ink-800 px-2 py-1 text-xs text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void descStatus.flush()}
            placeholder="Describe what happens in this clip…"
            rows={2}
          />
        </FieldRow>

        <FieldRow
          label="Tags"
          status={
            <FieldStatus
              state={tagsStatus.state}
              errorMessage={tagsStatus.errorMessage}
            />
          }
        >
          <ChipPicker
            mode="tag"
            current={tags}
            selected={selectedTags}
            onChipClick={(t) => onToggleTag(t)}
            onAdd={(t) => {
              setTags((prev) =>
                prev.some((x) => x.toLowerCase() === t.toLowerCase())
                  ? prev
                  : [...prev, t]
              );
            }}
            onRemove={(t) => {
              setTags((prev) => prev.filter((x) => x !== t));
            }}
            placeholder="+ Add tag"
            tone="neutral"
          />
        </FieldRow>

        <FieldRow
          label="Characters"
          status={
            <FieldStatus
              state={charsStatus.state}
              errorMessage={charsStatus.errorMessage}
            />
          }
        >
          <ChipPicker
            mode="entity"
            current={characters}
            options={characterOptions}
            selected={selectedCharacterIds}
            onChipClick={(id) => onToggleCharacter(id)}
            onAdd={(c) => {
              setCharacters((prev) =>
                prev.some((x) => x.id === c.id) ? prev : [...prev, c]
              );
            }}
            onRemove={(id) => {
              setCharacters((prev) => prev.filter((x) => x.id !== id));
            }}
            allowCreate
            onCreate={createCharacterRef}
            placeholder="+ Add character"
            tone="emerald"
          />
        </FieldRow>

        <FieldRow
          label="Scenes"
          status={
            <FieldStatus
              state={scenesStatus.state}
              errorMessage={scenesStatus.errorMessage}
            />
          }
        >
          <ChipPicker
            mode="entity"
            current={scenes}
            options={sceneOptions}
            selected={selectedSceneIds}
            onChipClick={(id) => onToggleScene(id)}
            onAdd={(s) => {
              setScenes((prev) =>
                prev.some((x) => x.id === s.id) ? prev : [...prev, s]
              );
            }}
            onRemove={(id) => {
              setScenes((prev) => prev.filter((x) => x.id !== id));
            }}
            allowCreate
            onCreate={createSceneRef}
            placeholder="+ Add scene"
            tone="sky"
          />
        </FieldRow>

        <FieldRow
          label="Objects"
          status={
            <FieldStatus
              state={objectsStatus.state}
              errorMessage={objectsStatus.errorMessage}
            />
          }
        >
          <ChipPicker
            mode="entity"
            current={objects}
            options={objectOptions}
            selected={selectedObjectIds}
            onChipClick={(id) => onToggleObject(id)}
            onAdd={(o) => {
              setObjects((prev) =>
                prev.some((x) => x.id === o.id) ? prev : [...prev, o]
              );
            }}
            onRemove={(id) => {
              setObjects((prev) => prev.filter((x) => x.id !== id));
            }}
            allowCreate
            onCreate={createObjectRef}
            placeholder="+ Add object"
            tone="fuchsia"
          />
        </FieldRow>

        <div className="mt-auto pt-1 text-[10px] text-ink-500">
          <span className="truncate font-mono" title={item.filename}>
            {item.filename}
          </span>
        </div>
      </div>
    </div>
  );
}

function CardThumbnail({
  item,
  isActive,
  audioOn,
}: {
  item: LibraryItem;
  isActive: boolean;
  audioOn: boolean;
}) {
  const isMissing = Boolean(item.missing);
  if (isActive) {
    return (
      <HoverPreviewVideo
        src={item.videoUrl}
        audioOn={audioOn}
        alt={item.name}
      />
    );
  }
  return (
    <img
      src={item.thumbUrl}
      loading="lazy"
      alt={item.name}
      className={
        "h-full w-full object-cover transition " +
        (isMissing ? "opacity-30 grayscale" : "hover:scale-[1.02]")
      }
    />
  );
}

function HoverPreviewVideo({
  src,
  audioOn,
  alt,
}: {
  src: string;
  audioOn: boolean;
  alt: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // Live-update the muted attribute when the global audio toggle flips
  // while this card is the active previewer. Browsers can reject play()
  // when un-muting without a recent user gesture; we wrap in try/catch
  // and silently let the next hover try again.
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

function FieldRow({
  label,
  status,
  children,
}: {
  label: string;
  status: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
          {label}
        </span>
        <span className="flex h-3 items-center">{status}</span>
      </div>
      {children}
    </div>
  );
}

type PreviewTab = "clip" | "source" | "side-by-side";

function PreviewModal({
  item,
  onClose,
}: {
  item: LibraryItem;
  onClose: () => void;
}) {
  const sourceAvailable = Boolean(item.sourceVideoUrl);
  const hasTrimMeta =
    typeof item.in === "number" && typeof item.out === "number" && item.out > item.in;

  const [tab, setTab] = useState<PreviewTab>("clip");
  const [loopSelection, setLoopSelection] = useState(true);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{item.name}</div>
            {hasTrimMeta && (
              <div className="font-mono text-[11px] text-ink-500">
                in {formatTime(item.in!)} → out {formatTime(item.out!)} ·{" "}
                {formatDuration((item.out ?? 0) - (item.in ?? 0))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-ink-700 text-xs">
              <TabButton active={tab === "clip"} onClick={() => setTab("clip")}>
                Clip
              </TabButton>
              <TabButton
                active={tab === "source"}
                disabled={!sourceAvailable}
                onClick={() => sourceAvailable && setTab("source")}
                title={sourceAvailable ? "" : "Source file isn't available"}
              >
                Source
              </TabButton>
              <TabButton
                active={tab === "side-by-side"}
                disabled={!sourceAvailable}
                onClick={() =>
                  sourceAvailable && setTab("side-by-side")
                }
                title={sourceAvailable ? "" : "Source file isn't available"}
              >
                Side-by-side
              </TabButton>
            </div>

            {tab !== "clip" && hasTrimMeta && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-400">
                <input
                  type="checkbox"
                  className="accent-accent-500"
                  checked={loopSelection}
                  onChange={(e) => setLoopSelection(e.target.checked)}
                />
                Loop selection
              </label>
            )}

            <button
              className="rounded-md border border-ink-700 px-2 py-1 text-sm text-ink-300 hover:bg-ink-800"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden bg-black">
          {tab === "clip" && (
            <ClipPlayer src={item.videoUrl} className="h-[70vh] w-full" />
          )}
          {tab === "source" && sourceAvailable && (
            <SourcePlayer
              src={item.sourceVideoUrl!}
              inT={item.in}
              outT={item.out}
              loopSelection={loopSelection && hasTrimMeta}
              className="h-[70vh] w-full"
            />
          )}
          {tab === "side-by-side" && sourceAvailable && (
            <div className="grid h-[70vh] grid-cols-2 divide-x divide-ink-800">
              <div className="flex flex-col">
                <div className="border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-xs uppercase tracking-wide text-ink-400">
                  Clip
                </div>
                <ClipPlayer src={item.videoUrl} className="flex-1 bg-black" />
              </div>
              <div className="flex flex-col">
                <div className="border-b border-ink-800 bg-ink-900/60 px-3 py-1 text-xs uppercase tracking-wide text-ink-400">
                  Source {hasTrimMeta && `(loop ${formatTime(item.in!)}–${formatTime(item.out!)})`}
                </div>
                <SourcePlayer
                  src={item.sourceVideoUrl!}
                  inT={item.in}
                  outT={item.out}
                  loopSelection={loopSelection && hasTrimMeta}
                  className="flex-1 bg-black"
                />
              </div>
            </div>
          )}
        </div>

        {item.description && (
          <div className="border-t border-ink-800 px-4 py-3 text-sm text-ink-300">
            {item.description}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  children,
  active,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "px-2.5 py-1 transition " +
        (active
          ? "bg-accent-500 text-black"
          : disabled
            ? "bg-ink-900 text-ink-600"
            : "bg-ink-900 text-ink-300 hover:bg-ink-800")
      }
    >
      {children}
    </button>
  );
}

function ClipPlayer({ src, className }: { src: string; className?: string }) {
  return (
    <video
      key={src}
      src={src}
      controls
      autoPlay
      loop
      playsInline
      className={className}
    />
  );
}

function SourcePlayer({
  src,
  inT,
  outT,
  loopSelection,
  className,
}: {
  src: string;
  inT?: number;
  outT?: number;
  loopSelection: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    function onLoaded() {
      if (typeof inT === "number" && Number.isFinite(inT)) {
        try {
          v!.currentTime = inT;
        } catch {
          // ignore
        }
      }
      v!.play().catch(() => {});
    }
    v.addEventListener("loadedmetadata", onLoaded);
    return () => v.removeEventListener("loadedmetadata", onLoaded);
  }, [src, inT]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !loopSelection) return;
    if (typeof inT !== "number" || typeof outT !== "number") return;
    function onTime() {
      if (!v) return;
      if (v.currentTime >= outT! - 0.02) {
        try {
          v.currentTime = inT!;
        } catch {
          // ignore
        }
      }
    }
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [loopSelection, inT, outT, src]);

  return (
    <video
      ref={ref}
      key={src}
      src={src}
      controls
      autoPlay
      playsInline
      className={className}
    />
  );
}


function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function RenamePopover({
  initial,
  error,
  onCancel,
  onSubmit,
}: {
  initial: string;
  error: string | null;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="absolute left-2 right-2 top-12 z-30 rounded-md border border-ink-700 bg-ink-900 p-2 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="New name"
        className="w-full rounded bg-ink-800 px-2 py-1 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
      />
      {error && (
        <div className="mt-1 text-xs text-red-300">{error}</div>
      )}
      <div className="mt-1 text-[10px] text-ink-500">
        Letters, numbers, space, _ and - only. Enter saves, Esc cancels.
      </div>
    </div>
  );
}
