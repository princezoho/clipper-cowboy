import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PoolClipsSummaryEntry,
  PoolItem,
  createPoolFolder,
  deletePoolFolder,
  fetchPoolClipsSummary,
  fetchPoolFolders,
  formatDuration,
  movePoolSources,
  revealPoolFolder,
} from "../lib/api";
import { fireToast } from "../lib/toast";
import AutoOrganizeModal from "../components/AutoOrganizeModal";

interface Props {
  items: PoolItem[];
  loading: boolean;
  onPick: (item: PoolItem) => void;
  /** Parent re-fetches /api/pool when triggered. */
  onChanged?: () => void;
  poolDir?: string;
}

interface FolderNode {
  /** POSIX rel path under PROJECT_DIR; "" for root. */
  path: string;
  /** Last segment, or "All sources" for root. */
  name: string;
  count: number;
  children: FolderNode[];
}

/**
 * Build a hierarchical folder tree out of the flat folder list + every pool
 * item's `folder` field. Subtree-inclusive counts mirror ImagesView so the
 * sidebar shows totals for parent folders.
 */
function buildFolderTree(folders: string[], items: PoolItem[]): FolderNode {
  const root: FolderNode = {
    path: "",
    name: "All sources",
    count: items.length,
    children: [],
  };
  const byPath = new Map<string, FolderNode>();
  byPath.set("", root);

  const all = new Set<string>(folders);
  for (const f of folders) {
    let cur = "";
    for (const seg of f.split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      all.add(cur);
    }
  }
  // Surface implicit folders (a video lives in `foo/bar` but the user never
  // explicitly created `foo` via /folders) so the tree doesn't drop them.
  for (const it of items) {
    if (!it.folder) continue;
    let cur = "";
    for (const seg of it.folder.split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      all.add(cur);
    }
  }
  const sorted = Array.from(all).sort();
  for (const p of sorted) {
    const segs = p.split("/");
    const name = segs[segs.length - 1];
    const parent = segs.slice(0, -1).join("/");
    const node: FolderNode = { path: p, name, count: 0, children: [] };
    byPath.set(p, node);
    const parentNode = byPath.get(parent) ?? root;
    parentNode.children.push(node);
  }

  for (const it of items) {
    if (!it.folder) continue;
    let cur = "";
    for (const seg of it.folder.split("/")) {
      cur = cur ? `${cur}/${seg}` : seg;
      const n = byPath.get(cur);
      if (n) n.count += 1;
    }
  }

  function sortDeep(n: FolderNode) {
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.children.forEach(sortDeep);
  }
  sortDeep(root);
  return root;
}

type SortMode = "recent" | "oldest" | "name";
type ClipFilter = "all" | "clipped" | "unclipped";

export default function PoolView({
  items,
  loading,
  onPick,
  onChanged,
  poolDir,
}: Props) {
  const [summary, setSummary] = useState<Record<string, PoolClipsSummaryEntry>>(
    {}
  );
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string>("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [showOrganize, setShowOrganize] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [clipFilter, setClipFilter] = useState<ClipFilter>("all");
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

  const reloadFolders = useCallback(() => {
    fetchPoolFolders()
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]));
  }, []);

  useEffect(() => {
    reloadFolders();
  }, [reloadFolders, items.length]);

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
        if (!cancelled) setSummaryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [items.length]);

  function inCurrentFolder(item: PoolItem): boolean {
    if (!currentFolder) return true;
    return (
      item.folder === currentFolder ||
      item.folder.startsWith(currentFolder + "/")
    );
  }

  const filtered = useMemo(
    () => items.filter(inCurrentFolder),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, currentFolder]
  );

  // Sort the visible sources. "recent" (most recently added) is the default so
  // freshly dropped clips surface at the top.
  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortMode) {
      case "recent":
        arr.sort((a, b) => b.mtime - a.mtime);
        break;
      case "oldest":
        arr.sort((a, b) => a.mtime - b.mtime);
        break;
      case "name":
        arr.sort((a, b) => a.filename.localeCompare(b.filename));
        break;
    }
    return arr;
  }, [filtered, sortMode]);

  // Clipped = at least one cut exported from this source (clipCount > 0).
  const clippedCount = useMemo(
    () => filtered.filter((it) => it.clipCount > 0).length,
    [filtered]
  );
  const unclippedCount = filtered.length - clippedCount;

  // Apply the clipped/not-clipped filter on top of the sort. This is the final
  // list shown in the grid.
  const visible = useMemo(() => {
    if (clipFilter === "clipped") return sorted.filter((it) => it.clipCount > 0);
    if (clipFilter === "unclipped")
      return sorted.filter((it) => it.clipCount === 0);
    return sorted;
  }, [sorted, clipFilter]);

  // Auto-organize targets the user's selection when they've picked specific
  // sources; otherwise it falls back to everything currently visible.
  const organizeItems = useMemo(
    () =>
      selectedIds.size > 0
        ? visible.filter((it) => selectedIds.has(it.id))
        : visible,
    [visible, selectedIds]
  );

  const tree = useMemo(() => buildFolderTree(folders, items), [folders, items]);

  const folderAbsPath = useMemo(
    () => (currentFolder ? `${poolDir ?? ""}/${currentFolder}` : poolDir ?? ""),
    [poolDir, currentFolder]
  );

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }
  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllVisible() {
    setSelectedIds(new Set(filtered.map((it) => it.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Esc exits selection mode (matches Library / Images keyboard semantics).
  useEffect(() => {
    if (!selectionMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exitSelectionMode();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode]);

  async function handleCreateFolder(parent: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const fullPath = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      const r = await createPoolFolder(fullPath);
      reloadFolders();
      setCurrentFolder(r.folder);
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Couldn't create folder",
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async function handleDeleteFolder(folder: string) {
    if (!folder) return;
    if (!confirm(`Delete empty folder "${folder}"?`)) return;
    try {
      await deletePoolFolder(folder);
      reloadFolders();
      if (currentFolder === folder) setCurrentFolder("");
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Couldn't delete folder",
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleMoveSelection() {
    if (selectedIds.size === 0) return;
    try {
      const r = await movePoolSources(Array.from(selectedIds), moveTarget);
      const moved = r.items.length;
      const errs = r.errors.length;
      fireToast({
        kind: moved > 0 ? "success" : "error",
        title: `Moved ${moved} source${moved === 1 ? "" : "s"}${errs ? ` · ${errs} failed` : ""}`,
        body: moveTarget ? `→ ${moveTarget}` : "→ project root",
      });
      exitSelectionMode();
      onChanged?.();
      reloadFolders();
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Move failed",
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleRevealFolder() {
    try {
      await revealPoolFolder(currentFolder);
    } catch {
      // best-effort
    }
  }

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

  const breadcrumb = currentFolder ? currentFolder.split("/") : [];
  const breadcrumbHrefs: { label: string; path: string }[] = [
    { label: "All sources", path: "" },
    ...breadcrumb.map((seg, i) => ({
      label: seg,
      path: breadcrumb.slice(0, i + 1).join("/"),
    })),
  ];

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <aside className="hidden w-[220px] shrink-0 flex-col border-r border-ink-800 bg-ink-950 md:flex">
          <FolderSidebar
            tree={tree}
            current={currentFolder}
            onSelect={(p) => setCurrentFolder(p)}
            onCreate={handleCreateFolder}
            onDelete={handleDeleteFolder}
          />
        </aside>
      )}

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-ink-800 bg-ink-950/95 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 md:hidden"
              title="Toggle folder sidebar"
            >
              ☰
            </button>
            <span className="mr-auto text-xs text-ink-500">
              {currentFolder
                ? `${filtered.length} of ${items.length} source${items.length === 1 ? "" : "s"}`
                : `${items.length} source${items.length === 1 ? "" : "s"}`}
            </span>
            <div
              className="flex items-center rounded-md border border-ink-700 text-xs"
              data-testid="pool-clip-filter"
            >
              {(
                [
                  ["all", `All ${filtered.length}`],
                  ["clipped", `Clipped ${clippedCount}`],
                  ["unclipped", `Not clipped ${unclippedCount}`],
                ] as [ClipFilter, string][]
              ).map(([value, label], i) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setClipFilter(value)}
                  title={
                    value === "clipped"
                      ? "Sources you've already cut clips from"
                      : value === "unclipped"
                        ? "Sources with no clips yet"
                        : "Show every source"
                  }
                  className={
                    "px-2.5 py-1 transition " +
                    (i > 0 ? "border-l border-ink-700 " : "") +
                    (clipFilter === value
                      ? "bg-accent-500 font-medium text-black"
                      : "text-ink-300 hover:bg-ink-800")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 text-xs text-ink-500">
              <span className="hidden sm:inline">Sort</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                data-testid="pool-sort-select"
                title="Sort the visible sources"
                className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100 outline-none hover:bg-ink-800"
              >
                <option value="recent">Most recent</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name (A–Z)</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowOrganize(true)}
              disabled={organizeItems.length === 0}
              data-testid="pool-auto-organize-btn"
              title={
                selectedIds.size > 0
                  ? `Use GPT-4o vision to suggest folders for the ${selectedIds.size} selected source${selectedIds.size === 1 ? "" : "s"}`
                  : "Use GPT-4o vision to suggest folders for the visible sources"
              }
              className="rounded-md border border-accent-500/40 bg-accent-500/15 px-3 py-2 text-sm text-accent-200 hover:bg-accent-500/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span aria-hidden>🤖</span>{" "}
              {selectedIds.size > 0
                ? `Auto-organize ${selectedIds.size} selected…`
                : "Auto-organize…"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectionMode) exitSelectionMode();
                else setSelectionMode(true);
              }}
              className={
                "rounded-md px-3 py-2 text-sm font-medium transition " +
                (selectionMode
                  ? "bg-accent-500 text-black hover:bg-accent-400"
                  : "border border-ink-700 text-ink-200 hover:bg-ink-800")
              }
              title={
                selectionMode
                  ? "Exit selection (Esc)"
                  : "Select sources for batch move"
              }
            >
              {selectionMode ? "Done" : "Select"}
            </button>
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

          {/* Breadcrumb + Open in Finder */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-400">
              {breadcrumbHrefs.map((seg, i) => (
                <span key={`${seg.path}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <span className="text-ink-600">/</span>}
                  <button
                    type="button"
                    onClick={() => setCurrentFolder(seg.path)}
                    className={
                      "rounded px-1 py-0.5 hover:bg-ink-800 hover:text-ink-100 " +
                      (i === breadcrumbHrefs.length - 1
                        ? "font-semibold text-ink-200"
                        : "")
                    }
                  >
                    {seg.label}
                  </button>
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={handleRevealFolder}
              className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:bg-ink-800"
              title={`Reveal ${folderAbsPath} in Finder`}
            >
              Open in Finder
            </button>
          </div>

          {selectionMode && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent-500/40 bg-accent-500/5 px-3 py-2">
              <div className="flex items-center gap-3 text-xs">
                <span className="rounded bg-accent-500 px-2 py-0.5 font-mono text-[11px] font-semibold text-black">
                  {selectedIds.size} selected
                </span>
                <button
                  type="button"
                  onClick={selectAllVisible}
                  disabled={
                    filtered.length === 0 ||
                    selectedIds.size === filtered.length
                  }
                  className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 disabled:opacity-40"
                >
                  Select all visible ({filtered.length})
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  disabled={selectedIds.size === 0}
                  className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800 disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="text-ink-400">Move to:</label>
                <select
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700"
                >
                  <option value="">/ (root)</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleMoveSelection}
                  disabled={selectedIds.size === 0}
                  className="rounded-md bg-accent-500 px-3 py-1 text-xs font-semibold text-black hover:bg-accent-400 disabled:opacity-40"
                >
                  Move {selectedIds.size}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="relative flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-ink-400">
              <div className="text-base text-ink-200">
                {clipFilter === "clipped"
                  ? "No clipped sources here yet."
                  : clipFilter === "unclipped"
                    ? "Every source here has been clipped. 🎉"
                    : currentFolder
                      ? `No sources in ${currentFolder} yet.`
                      : "No sources yet."}
              </div>
              {clipFilter !== "all" && filtered.length > 0 && (
                <button
                  type="button"
                  onClick={() => setClipFilter("all")}
                  className="rounded-md border border-ink-700 px-3 py-1 text-sm text-ink-200 hover:bg-ink-800"
                >
                  Show all sources
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
              {visible.map((item) => (
                <PoolCard
                  key={item.id}
                  item={item}
                  summary={summary[item.id]}
                  summaryLoaded={summaryLoaded}
                  onPick={() => {
                    setActivePreviewId(null);
                    onPick(item);
                  }}
                  isActivePreview={activePreviewId === item.id}
                  audioOn={audioOn}
                  onPreviewEnter={handlePreviewEnter}
                  onPreviewLeave={handlePreviewLeave}
                  selectionMode={selectionMode}
                  isSelected={selectedIds.has(item.id)}
                  onToggleSelected={() => toggleSelected(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showOrganize && (
        <AutoOrganizeModal
          items={organizeItems}
          onClose={() => setShowOrganize(false)}
          onComplete={() => {
            setShowOrganize(false);
            onChanged?.();
            reloadFolders();
          }}
        />
      )}
    </div>
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
  selectionMode,
  isSelected,
  onToggleSelected,
}: {
  item: PoolItem;
  summary: PoolClipsSummaryEntry | undefined;
  summaryLoaded: boolean;
  onPick: () => void;
  isActivePreview: boolean;
  audioOn: boolean;
  onPreviewEnter: (id: string) => void;
  onPreviewLeave: (id: string) => void;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelected: () => void;
}) {
  const processed = item.clipCount > 0;
  const clips = summary?.clips ?? [];
  const draft = summary?.draft;
  const safeDuration = item.duration > 0 ? item.duration : 0;

  return (
    <div
      className={
        "group relative flex flex-col overflow-hidden rounded-xl border bg-ink-900 transition hover:border-ink-600 hover:bg-ink-800 " +
        (selectionMode && isSelected
          ? "border-accent-500 ring-2 ring-accent-500/50"
          : "border-ink-800")
      }
      onMouseEnter={() => onPreviewEnter(item.id)}
      onMouseLeave={() => onPreviewLeave(item.id)}
    >
      {selectionMode && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelected();
          }}
          aria-label={isSelected ? "Deselect" : "Select"}
          className={
            "absolute right-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold shadow-md " +
            (isSelected
              ? "border-accent-500 bg-accent-500 text-black"
              : "border-ink-600 bg-black/60 text-ink-200 hover:border-ink-400")
          }
        >
          {isSelected ? "✓" : ""}
        </button>
      )}
      <button
        className="text-left"
        onClick={selectionMode ? onToggleSelected : onPick}
        title={selectionMode ? "Toggle selection" : "Open in editor"}
      >
        <div className="relative aspect-video overflow-hidden bg-ink-950">
          <PoolCardThumbnail
            item={item}
            isActive={isActivePreview && !selectionMode}
            audioOn={audioOn}
          />
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">
            {formatDuration(item.duration)}
          </span>
          <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
            {processed ? (
              <span
                className="rounded-full bg-emerald-500/85 px-2 py-0.5 font-mono text-[10px] font-medium text-black"
                title={`${item.clipCount} clip${item.clipCount === 1 ? "" : "s"} exported from this source`}
              >
                ✓ {item.clipCount}
              </span>
            ) : (
              <span
                className="rounded-full border border-ink-500/60 bg-black/60 px-2 py-0.5 font-mono text-[10px] font-medium text-ink-300"
                title="No clips exported from this source yet"
              >
                Not clipped
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
          {item.folder && (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-ink-200">
              {item.folder}/
            </span>
          )}
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
          onClick={selectionMode ? onToggleSelected : onPick}
          className="w-full rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 hover:bg-ink-700"
        >
          {selectionMode
            ? isSelected
              ? "Deselect"
              : "Select"
            : "Open in editor"}
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

// ---- FolderSidebar (mirrors ImagesView) ----------------------------------

function FolderSidebar({
  tree,
  current,
  onSelect,
  onCreate,
  onDelete,
}: {
  tree: FolderNode;
  current: string;
  onSelect: (p: string) => void;
  onCreate: (parent: string, name: string) => Promise<void>;
  onDelete: (folder: string) => void;
}) {
  const [creatingParent, setCreatingParent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function commit(parent: string) {
    if (!draft.trim()) {
      setCreatingParent(null);
      setDraft("");
      return;
    }
    setBusy(true);
    try {
      await onCreate(parent, draft);
      setCreatingParent(null);
      setDraft("");
    } catch {
      // toast already fired by parent
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ink-800 px-3 py-3 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        Folders
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2 text-sm">
        <FolderRow
          node={tree}
          depth={0}
          current={current}
          onSelect={onSelect}
          onRequestCreateChild={(parent) => {
            setCreatingParent(parent);
            setDraft("");
          }}
          onDelete={onDelete}
        />
      </div>
      <div className="flex flex-col gap-1 border-t border-ink-800 px-3 py-3">
        <button
          type="button"
          onClick={() => {
            setCreatingParent(current);
            setDraft("");
          }}
          className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-200 hover:bg-ink-800"
        >
          + New folder{current ? ` in ${current}/` : ""}
        </button>
        {creatingParent !== null && (
          <input
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit(creatingParent);
              if (e.key === "Escape") {
                setCreatingParent(null);
                setDraft("");
              }
            }}
            placeholder="folder-name"
            className="w-full rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
          />
        )}
      </div>
    </div>
  );
}

function FolderRow({
  node,
  depth,
  current,
  onSelect,
  onRequestCreateChild,
  onDelete,
}: {
  node: FolderNode;
  depth: number;
  current: string;
  onSelect: (p: string) => void;
  onRequestCreateChild: (parent: string) => void;
  onDelete: (folder: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const isActive = node.path === current;
  const hasChildren = node.children.length > 0;
  const isRoot = depth === 0;

  return (
    <div>
      <div
        className={
          "group flex items-center gap-1 rounded-md py-1 pr-1 text-[12px] transition " +
          (isActive
            ? "bg-accent-500/15 text-ink-100"
            : "text-ink-300 hover:bg-ink-800/60 hover:text-ink-100")
        }
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Collapse" : "Expand"}
            className="inline-flex h-4 w-4 items-center justify-center text-ink-500 hover:text-ink-200"
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="inline-block h-4 w-4" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className="flex flex-1 items-center justify-between gap-1 truncate text-left"
        >
          <span className="truncate">{node.name}</span>
          <span className="ml-1 shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
            {node.count}
          </span>
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="invisible inline-flex h-5 w-5 items-center justify-center rounded text-ink-500 hover:bg-ink-700 hover:text-ink-100 group-hover:visible"
            aria-label="Folder actions"
          >
            ⋮
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-6 z-20 w-44 overflow-hidden rounded-md border border-ink-700 bg-ink-900 shadow-xl"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onRequestCreateChild(node.path);
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink-200 hover:bg-ink-800"
              >
                New subfolder…
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  if (!isRoot) onDelete(node.path);
                }}
                disabled={isRoot || node.count > 0}
                title={
                  isRoot
                    ? "Can't delete the root"
                    : node.count > 0
                      ? "Folder isn't empty — move or delete its contents first"
                      : ""
                }
                className="block w-full px-3 py-1.5 text-left text-xs text-red-300 hover:bg-ink-800 disabled:cursor-not-allowed disabled:text-ink-600"
              >
                Delete folder
              </button>
            </div>
          )}
        </div>
      </div>
      {open &&
        node.children.map((c) => (
          <FolderRow
            key={c.path}
            node={c}
            depth={depth + 1}
            current={current}
            onSelect={onSelect}
            onRequestCreateChild={onRequestCreateChild}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}
