import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Character,
  Entity,
  IMAGE_CATEGORIES,
  ImageCategory,
  ImageItem,
  NamedRef,
  createCharacter,
  createEntity,
  createImageFolder,
  deleteImageFolder,
  fetchCharacters,
  fetchEntities,
  fetchImageFolders,
  formatBytes,
  moveImages,
  patchImage,
  uploadImages,
} from "../lib/api";
import { fireToast } from "../lib/toast";
import FieldStatus from "../components/FieldStatus";
import ChipPicker from "../components/ChipPicker";
import CategorySelect from "../components/CategorySelect";
import { useDebouncedAutosave } from "../lib/useDebouncedAutosave";
import {
  imagePreviewAspectRatio,
  imagePreviewObjectFit,
} from "../lib/imagePreview";

interface Props {
  items: ImageItem[];
  loading: boolean;
  imagesDir: string;
  onChanged: () => void;
}

const CATEGORY_LABEL: Record<ImageCategory, string> = {
  "": "Uncategorized",
  storyboard: "Storyboard",
  shot: "Shot",
  "character-ref": "Character ref",
  "object-ref": "Object ref",
  background: "Background",
};

const CATEGORY_TONE: Record<Exclude<ImageCategory, "">, string> = {
  storyboard: "bg-amber-500/85 text-black",
  shot: "bg-accent-500/85 text-black",
  "character-ref": "bg-emerald-500/85 text-black",
  "object-ref": "bg-fuchsia-500/85 text-black",
  background: "bg-sky-500/85 text-black",
};

const STARTER_FOLDERS = [
  "storyboards",
  "shots",
  "character-refs",
  "object-refs",
  "backgrounds",
];

const SUPPORTED_UPLOAD_MIME = /^image\/(png|jpeg|jpg|webp|gif)$/i;
const SUPPORTED_UPLOAD_EXT = /\.(png|jpe?g|webp|gif)$/i;

function isImageFile(f: File): boolean {
  if (f.type && SUPPORTED_UPLOAD_MIME.test(f.type)) return true;
  return SUPPORTED_UPLOAD_EXT.test(f.name);
}

interface FolderNode {
  /** Relative folder path under IMAGES_DIR; "" for root. */
  path: string;
  /** Last segment, or "All images" for root. */
  name: string;
  count: number;
  children: FolderNode[];
}

/**
 * Build a hierarchical tree from a flat list of relative folder paths plus the
 * complete image list (so we can compute per-folder counts including subtree).
 */
function buildFolderTree(folders: string[], items: ImageItem[]): FolderNode {
  const root: FolderNode = {
    path: "",
    name: "All images",
    count: items.length,
    children: [],
  };
  const byPath = new Map<string, FolderNode>();
  byPath.set("", root);

  // Make sure every implicit ancestor exists even if `folders` skipped it
  // (shouldn't happen, but defensive).
  const all = new Set<string>(folders);
  for (const f of folders) {
    let cur = "";
    for (const seg of f.split("/")) {
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

  // Per-folder counts (subtree-inclusive).
  for (const it of items) {
    let cur = "";
    const node0 = byPath.get(cur);
    if (node0 && cur !== "") node0.count += 1;
    if (!it.folder) continue;
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

export default function ImagesView({
  items,
  loading,
  imagesDir,
  onChanged,
}: Props) {
  const [folders, setFolders] = useState<string[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string>("");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [scenes, setScenes] = useState<Entity[]>([]);
  const [objects, setObjects] = useState<Entity[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchText, setSearchText] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<
    Set<ImageCategory>
  >(() => new Set());
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedSceneIds, setSelectedSceneIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedObjectIds, setSelectedObjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set());
  const [lightbox, setLightbox] = useState<ImageItem | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [moveTarget, setMoveTarget] = useState<string>("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [creatingStarter, setCreatingStarter] = useState(false);
  const [starterPicks, setStarterPicks] = useState<Set<string>>(
    () => new Set(STARTER_FOLDERS)
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);

  // Debounce search input → applied filter (matches Library UX).
  useEffect(() => {
    if (searchDraft === searchText) return;
    const id = window.setTimeout(() => setSearchText(searchDraft), 300);
    return () => window.clearTimeout(id);
  }, [searchDraft, searchText]);

  const reloadFolders = useCallback(() => {
    fetchImageFolders()
      .then((r) => setFolders(r.folders))
      .catch(() => setFolders([]));
  }, []);

  useEffect(() => {
    reloadFolders();
  }, [reloadFolders, items.length]);

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

  const characterOptions = useMemo<NamedRef[]>(
    () => characters.map((c) => ({ id: c.id, name: c.name })),
    [characters]
  );
  const sceneOptions = useMemo<NamedRef[]>(
    () => scenes.map((s) => ({ id: s.id, name: s.name })),
    [scenes]
  );
  const objectOptions = useMemo<NamedRef[]>(
    () => objects.map((o) => ({ id: o.id, name: o.name })),
    [objects]
  );

  // ---- Filters ------------------------------------------------------------

  function toggleCategory(c: ImageCategory) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }
  function toggleCharacter(id: string) {
    setSelectedCharacterIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleScene(id: string) {
    setSelectedSceneIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleObject(id: string) {
    setSelectedObjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleTag(tag: string) {
    const lower = tag.toLowerCase();
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(lower)) next.delete(lower);
      else next.add(lower);
      return next;
    });
  }
  function clearAllFilters() {
    setSelectedCategories(new Set());
    setSelectedCharacterIds(new Set());
    setSelectedSceneIds(new Set());
    setSelectedObjectIds(new Set());
    setSelectedTags(new Set());
    setSearchText("");
    setSearchDraft("");
  }

  function inCurrentFolder(item: ImageItem): boolean {
    if (!currentFolder) return true;
    return (
      item.folder === currentFolder ||
      item.folder.startsWith(currentFolder + "/")
    );
  }

  const needle = searchText.trim().toLowerCase();
  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (!inCurrentFolder(item)) return false;
      if (selectedCategories.size > 0) {
        const cat = item.category || "";
        if (!selectedCategories.has(cat)) return false;
      }
      for (const id of selectedCharacterIds) {
        if (!item.characters?.some((c) => c.id === id)) return false;
      }
      for (const id of selectedSceneIds) {
        if (!item.scenes?.some((s) => s.id === id)) return false;
      }
      for (const id of selectedObjectIds) {
        if (!item.objects?.some((o) => o.id === id)) return false;
      }
      for (const tag of selectedTags) {
        const has = (item.tags ?? []).some((t) => t.toLowerCase() === tag);
        if (!has) return false;
      }
      if (needle) {
        const hay = [
          item.name,
          item.description,
          item.prompt,
          item.filename,
          item.folder,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    items,
    currentFolder,
    selectedCategories,
    selectedCharacterIds,
    selectedSceneIds,
    selectedObjectIds,
    selectedTags,
    needle,
  ]);

  const tree = useMemo(() => buildFolderTree(folders, items), [folders, items]);
  const folderAbsPath = useMemo(
    () => (currentFolder ? `${imagesDir}/${currentFolder}` : imagesDir),
    [imagesDir, currentFolder]
  );

  const hasAnyFilter =
    selectedCategories.size > 0 ||
    selectedCharacterIds.size > 0 ||
    selectedSceneIds.size > 0 ||
    selectedObjectIds.size > 0 ||
    selectedTags.size > 0 ||
    needle.length > 0;

  // ---- Selection ----------------------------------------------------------

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }
  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }
  function selectAllVisible() {
    setSelectedIds(new Set(filtered.map((it) => it.id)));
  }

  useEffect(() => {
    if (!selectionMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exitSelectionMode();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionMode]);

  // ---- Upload (drop / paste / picker) -------------------------------------

  async function uploadFiles(files: File[], folder: string) {
    const valid = files.filter(isImageFile);
    const rejected = files.length - valid.length;
    if (rejected > 0 && valid.length === 0) {
      fireToast({
        kind: "error",
        title: "Nothing to upload",
        body: `${rejected} file${rejected === 1 ? "" : "s"} ignored — only PNG / JPG / WebP / GIF are supported`,
      });
      return;
    }
    if (rejected > 0) {
      fireToast({
        kind: "warn",
        title: `Skipping ${rejected} non-image file${rejected === 1 ? "" : "s"}`,
      });
    }
    setUploading(true);
    try {
      const r = await uploadImages(folder, valid);
      const okCount = r.items.length;
      const rejCount = r.rejected?.length ?? 0;
      fireToast({
        kind: okCount > 0 ? "success" : "warn",
        title: `Uploaded ${okCount} image${okCount === 1 ? "" : "s"}${rejCount ? ` · ${rejCount} rejected` : ""}`,
        body:
          folder
            ? `→ ${folder}`
            : "→ images/",
      });
      onChanged();
      reloadFolders();
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Upload failed",
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  }

  function onDragEnter(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragging(false);
  }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    await uploadFiles(files, currentFolder);
  }

  // Paste-from-clipboard listener (window-level, only while ImagesView mounted).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      // Ignore paste targeting an input/textarea — that's text editing.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files: File[] = [];
      for (const it of Array.from(cd.items)) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f && SUPPORTED_UPLOAD_MIME.test(f.type)) {
            // Browsers often hand us a generic "image.png" — make it unique
            // so multiple pastes don't all collide on the same name.
            const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
            const renamed = new File(
              [f],
              `paste-${Date.now()}.${ext}`,
              { type: f.type }
            );
            files.push(renamed);
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files, currentFolder);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolder]);

  function openFilePicker() {
    fileInputRef.current?.click();
  }
  function onFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void uploadFiles(files, currentFolder);
    // Reset so picking the same file twice in a row still fires onChange.
    e.target.value = "";
  }

  // ---- Folder ops ---------------------------------------------------------

  async function handleCreateFolder(parent: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const fullPath = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      const r = await createImageFolder(fullPath);
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
      await deleteImageFolder(folder);
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

  async function handleCreateStarters() {
    setCreatingStarter(true);
    try {
      const picks = Array.from(starterPicks);
      for (const f of picks) {
        try {
          await createImageFolder(f);
        } catch (err) {
          fireToast({
            kind: "warn",
            title: `Skipped "${f}"`,
            body: err instanceof Error ? err.message : String(err),
          });
        }
      }
      fireToast({
        kind: "success",
        title: `Created ${picks.length} starter folder${picks.length === 1 ? "" : "s"}`,
      });
      reloadFolders();
    } finally {
      setCreatingStarter(false);
    }
  }

  async function handleMoveSelection() {
    if (selectedIds.size === 0) return;
    try {
      const r = await moveImages(Array.from(selectedIds), moveTarget);
      const moved = r.items.length;
      const errs = r.errors.length;
      fireToast({
        kind: moved > 0 ? "success" : "error",
        title: `Moved ${moved} image${moved === 1 ? "" : "s"}${errs ? ` · ${errs} failed` : ""}`,
        body: moveTarget ? `→ ${moveTarget}` : "→ images/",
      });
      exitSelectionMode();
      onChanged();
      reloadFolders();
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Move failed",
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function revealCurrentFolder() {
    try {
      await fetch("/api/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderAbsPath }),
      });
    } catch {
      // best-effort
    }
  }

  // ---- Render -------------------------------------------------------------

  if (loading && items.length === 0 && folders.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-ink-400">
        Loading images…
      </div>
    );
  }

  // Empty state: no images AND no folders → onboarding panel with starter picks.
  if (items.length === 0 && folders.length === 0) {
    return (
      <EmptyState
        imagesDir={imagesDir}
        starterPicks={starterPicks}
        onTogglePick={(p) =>
          setStarterPicks((prev) => {
            const next = new Set(prev);
            if (next.has(p)) next.delete(p);
            else next.add(p);
            return next;
          })
        }
        creating={creatingStarter}
        onCreate={handleCreateStarters}
        uploading={uploading}
        dragging={dragging}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPickFiles={openFilePicker}
      />
    );
  }

  const breadcrumb = currentFolder ? currentFolder.split("/") : [];
  const breadcrumbHrefs: { label: string; path: string }[] = [
    { label: "All images", path: "" },
    ...breadcrumb.map((seg, i) => ({
      label: seg,
      path: breadcrumb.slice(0, i + 1).join("/"),
    })),
  ];

  return (
    <div
      className="flex h-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={onFilesPicked}
        className="hidden"
      />

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
            <div className="relative flex-1">
              <input
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder="Search images by name, prompt, description, tag, character, scene, or object…"
                className="w-full rounded-md bg-ink-900 px-3 py-2 pr-8 text-sm text-ink-100 outline-none ring-1 ring-ink-700 placeholder:text-ink-500 focus:ring-accent-500"
                data-testid="images-search"
              />
              {searchDraft && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchDraft("");
                    setSearchText("");
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
              onClick={openFilePicker}
              disabled={uploading}
              className="rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="images-add-btn"
              title="Pick image files to upload to the current folder"
            >
              + Add images
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
              title={selectionMode ? "Exit selection (Esc)" : "Select images for batch move"}
            >
              {selectionMode ? "Done" : "Select"}
            </button>
            <div className="text-xs text-ink-500">
              {hasAnyFilter || currentFolder
                ? `${filtered.length} of ${items.length}`
                : `${items.length} image${items.length === 1 ? "" : "s"}`}
            </div>
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
              onClick={revealCurrentFolder}
              className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:bg-ink-800"
              title={`Reveal ${folderAbsPath} in Finder`}
            >
              Open in Finder
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-ink-500">
              Category:
            </span>
            {IMAGE_CATEGORIES.map((c) => {
              const active = selectedCategories.has(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCategory(c)}
                  className={
                    "rounded-full px-2 py-0.5 text-[11px] font-medium transition " +
                    (active
                      ? CATEGORY_TONE[c]
                      : "bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100")
                  }
                >
                  {CATEGORY_LABEL[c]}
                </button>
              );
            })}
            {hasAnyFilter && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="ml-1 text-[11px] text-ink-400 underline-offset-2 hover:text-ink-100 hover:underline"
              >
                Clear all
              </button>
            )}
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
                  disabled={filtered.length === 0 || selectedIds.size === filtered.length}
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
          {filtered.length === 0 ? (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center text-ink-400">
              <div className="text-base text-ink-200">
                {currentFolder
                  ? `No images in ${currentFolder} yet.`
                  : hasAnyFilter
                    ? "No images match these filters."
                    : "No images yet."}
              </div>
              <div className="text-xs text-ink-500">
                Drop image files here, paste from the clipboard, or click <em>+ Add images</em>.
              </div>
              {hasAnyFilter && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {filtered.map((item) => (
                <ImageCard
                  key={item.id}
                  item={item}
                  onPreview={() => setLightbox(item)}
                  selectedTags={selectedTags}
                  onToggleTag={toggleTag}
                  selectedCharacterIds={selectedCharacterIds}
                  onToggleCharacter={toggleCharacter}
                  selectedSceneIds={selectedSceneIds}
                  onToggleScene={toggleScene}
                  selectedObjectIds={selectedObjectIds}
                  onToggleObject={toggleObject}
                  characterOptions={characterOptions}
                  sceneOptions={sceneOptions}
                  objectOptions={objectOptions}
                  onCharactersCatalogChanged={reloadCharacters}
                  onScenesCatalogChanged={reloadScenes}
                  onObjectsCatalogChanged={reloadObjects}
                  selectionMode={selectionMode}
                  isSelected={selectedIds.has(item.id)}
                  onToggleSelected={() => toggleSelected(item.id)}
                />
              ))}
            </div>
          )}

          {dragging && (
            <DragOverlay folder={currentFolder} />
          )}
          {uploading && (
            <div className="pointer-events-none fixed bottom-6 right-6 z-30 rounded-md bg-ink-900 px-4 py-2 text-sm text-ink-100 shadow-xl ring-1 ring-ink-700">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-500" />{" "}
              Uploading…
            </div>
          )}
        </div>
      </div>

      {lightbox && (
        <ImageLightbox item={lightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

// ---- DragOverlay --------------------------------------------------------

function DragOverlay({ folder }: { folder: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-accent-500/15 backdrop-blur-[1px]">
      <div className="rounded-2xl border-4 border-dashed border-accent-500 bg-ink-950/80 px-8 py-6 text-center text-ink-100 shadow-xl">
        <div className="text-base font-semibold">Drop to upload</div>
        <div className="mt-1 font-mono text-xs text-ink-300">
          → {folder ? folder + "/" : "images/"}
        </div>
      </div>
    </div>
  );
}

// ---- EmptyState ---------------------------------------------------------

function EmptyState({
  imagesDir,
  starterPicks,
  onTogglePick,
  creating,
  onCreate,
  uploading,
  dragging,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onPickFiles,
}: {
  imagesDir: string;
  starterPicks: Set<string>;
  onTogglePick: (p: string) => void;
  creating: boolean;
  onCreate: () => void;
  uploading: boolean;
  dragging: boolean;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onPickFiles: () => void;
}) {
  return (
    <div
      className="relative flex h-full flex-col items-center justify-center gap-6 p-10 text-center"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="space-y-1">
        <div className="text-xl font-semibold text-ink-100">No images yet</div>
        <div className="text-sm text-ink-400">
          Drop image files here, paste from clipboard, or click below to upload.
        </div>
      </div>

      <button
        type="button"
        onClick={onPickFiles}
        disabled={uploading}
        className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "+ Add images"}
      </button>

      <div
        className={
          "w-full max-w-xl rounded-2xl border-2 border-dashed p-6 transition " +
          (dragging
            ? "border-accent-500 bg-accent-500/10 text-ink-100"
            : "border-ink-700 text-ink-400")
        }
      >
        <div className="text-sm">
          {dragging ? "Drop to upload" : "Or drop images right here"}
        </div>
        <div className="mt-1 font-mono text-[11px] text-ink-500">
          PNG · JPG · WebP · GIF
        </div>
      </div>

      <div className="w-full max-w-xl rounded-xl border border-ink-800 bg-ink-900 p-4 text-left">
        <div className="mb-1 text-sm font-semibold text-ink-100">
          Suggested starter folders
        </div>
        <div className="mb-3 text-xs text-ink-400">
          Folders organize images on disk so Premiere / Bridge see the same
          structure. Toggle any you don't want.
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STARTER_FOLDERS.map((f) => {
            const active = starterPicks.has(f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => onTogglePick(f)}
                className={
                  "rounded-full px-2 py-0.5 text-[11px] font-medium transition " +
                  (active
                    ? "bg-accent-500 text-black"
                    : "bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100")
                }
              >
                {f}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <code className="truncate font-mono text-[10px] text-ink-500" title={imagesDir}>
            {imagesDir}
          </code>
          <button
            type="button"
            onClick={onCreate}
            disabled={creating || starterPicks.size === 0}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200 hover:bg-ink-800 disabled:opacity-40"
          >
            {creating ? "Creating…" : `Create ${starterPicks.size} folder${starterPicks.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      {dragging && <DragOverlay folder="" />}
    </div>
  );
}

// ---- FolderSidebar ------------------------------------------------------

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
        {creatingParent !== null &&
          (creatingParent === "" ? (
            <div className="mt-2 flex items-center gap-1">
              <input
                autoFocus
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commit("");
                  if (e.key === "Escape") {
                    setCreatingParent(null);
                    setDraft("");
                  }
                }}
                placeholder="folder-name"
                className="w-full rounded bg-ink-800 px-2 py-1 text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              />
            </div>
          ) : null)}
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
        {creatingParent !== null && creatingParent === current && current !== "" && (
          <input
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit(current);
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

// ---- ImageCard ----------------------------------------------------------

interface ImageCardProps {
  item: ImageItem;
  onPreview: () => void;
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
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelected: () => void;
}

function ImageCard({
  item,
  onPreview,
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
  onToggleSelected,
}: ImageCardProps) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [prompt, setPrompt] = useState(item.prompt);
  const [category, setCategory] = useState<ImageCategory>(item.category);
  const [tags, setTags] = useState<string[]>(item.tags ?? []);
  const [characters, setCharacters] = useState<NamedRef[]>(item.characters ?? []);
  const [scenes, setScenes] = useState<NamedRef[]>(item.scenes ?? []);
  const [objects, setObjects] = useState<NamedRef[]>(item.objects ?? []);

  useEffect(() => {
    setName(item.name);
    setDescription(item.description);
    setPrompt(item.prompt);
    setCategory(item.category);
    setTags(item.tags ?? []);
    setCharacters(item.characters ?? []);
    setScenes(item.scenes ?? []);
    setObjects(item.objects ?? []);
  }, [item.id]);

  const nameSave = useCallback(
    async (v: string) => {
      await patchImage(item.id, { name: v });
    },
    [item.id]
  );
  const descSave = useCallback(
    async (v: string) => {
      await patchImage(item.id, { description: v });
    },
    [item.id]
  );
  const promptSave = useCallback(
    async (v: string) => {
      await patchImage(item.id, { prompt: v });
    },
    [item.id]
  );
  const categorySave = useCallback(
    async (v: ImageCategory) => {
      await patchImage(item.id, { category: v });
    },
    [item.id]
  );
  const tagsSave = useCallback(
    async (v: string[]) => {
      await patchImage(item.id, { tags: v });
    },
    [item.id]
  );
  const charactersSave = useCallback(
    async (v: NamedRef[]) => {
      await patchImage(item.id, { characters: v });
    },
    [item.id]
  );
  const scenesSave = useCallback(
    async (v: NamedRef[]) => {
      await patchImage(item.id, { scenes: v });
    },
    [item.id]
  );
  const objectsSave = useCallback(
    async (v: NamedRef[]) => {
      await patchImage(item.id, { objects: v });
    },
    [item.id]
  );

  const nameStatus = useDebouncedAutosave(name, nameSave);
  const descStatus = useDebouncedAutosave(description, descSave);
  const promptStatus = useDebouncedAutosave(prompt, promptSave);
  const categoryStatus = useDebouncedAutosave(category, categorySave, {
    debounceMs: 100,
  });
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

  async function copyPrompt() {
    if (!prompt.trim()) {
      fireToast({
        kind: "warn",
        title: "Nothing to copy",
        body: "Prompt is empty",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      fireToast({ kind: "success", title: "Prompt copied" });
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Copy failed",
        body: String(err),
      });
    }
  }

  const previewFit = imagePreviewObjectFit(item);
  const previewAspect = imagePreviewAspectRatio(item);

  return (
    <div
      className={
        "relative flex flex-col overflow-visible rounded-xl border bg-ink-900 transition " +
        (selectionMode && isSelected
          ? "border-accent-500 ring-2 ring-accent-500/50"
          : "border-ink-800")
      }
    >
      {selectionMode && (
        <button
          type="button"
          onClick={onToggleSelected}
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
        type="button"
        onClick={selectionMode ? onToggleSelected : onPreview}
        className="relative w-full max-h-56 overflow-hidden rounded-t-xl bg-ink-950"
        style={{ aspectRatio: previewAspect }}
        title={selectionMode ? "Toggle selection" : "Open lightbox"}
      >
        <img
          src={item.thumbUrl}
          loading="lazy"
          alt={item.name}
          className={
            "h-full w-full transition hover:scale-[1.02] " +
            (previewFit === "contain" ? "object-contain" : "object-cover")
          }
        />
        {category !== "" && (
          <span
            className={
              "absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] " +
              CATEGORY_TONE[category as Exclude<ImageCategory, "">]
            }
          >
            {CATEGORY_LABEL[category]}
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-100">
          {formatBytes(item.sizeBytes)}
          {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
        </span>
        {item.folder && (
          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-ink-200">
            {item.folder}/
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
        <FieldRow
          label="Category"
          status={
            <FieldStatus
              state={categoryStatus.state}
              errorMessage={categoryStatus.errorMessage}
            />
          }
        >
          <CategorySelect
            value={category}
            onChange={(v) => setCategory(v)}
          />
        </FieldRow>

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
            placeholder="Untitled image"
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
            placeholder="What is this image of? Where does it slot in?"
            rows={2}
          />
        </FieldRow>

        <FieldRow
          label={
            <span className="flex items-center gap-2">
              Prompt
              <button
                type="button"
                onClick={copyPrompt}
                className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] font-medium text-ink-300 hover:border-ink-500 hover:bg-ink-800 hover:text-ink-100"
                title="Copy prompt to clipboard"
              >
                Copy
              </button>
            </span>
          }
          status={
            <FieldStatus
              state={promptStatus.state}
              errorMessage={promptStatus.errorMessage}
            />
          }
        >
          <textarea
            className="min-h-[3.75rem] w-full resize-y rounded bg-ink-800 px-2 py-1 font-mono text-[11px] text-ink-200 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => void promptStatus.flush()}
            placeholder="Generative prompt (auto-filled from PNG metadata when available)…"
            rows={3}
            spellCheck={false}
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
            onAdd={(t) =>
              setTags((prev) =>
                prev.some((x) => x.toLowerCase() === t.toLowerCase())
                  ? prev
                  : [...prev, t]
              )
            }
            onRemove={(t) => setTags((prev) => prev.filter((x) => x !== t))}
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
            onAdd={(c) =>
              setCharacters((prev) =>
                prev.some((x) => x.id === c.id) ? prev : [...prev, c]
              )
            }
            onRemove={(id) =>
              setCharacters((prev) => prev.filter((x) => x.id !== id))
            }
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
            onAdd={(s) =>
              setScenes((prev) =>
                prev.some((x) => x.id === s.id) ? prev : [...prev, s]
              )
            }
            onRemove={(id) =>
              setScenes((prev) => prev.filter((x) => x.id !== id))
            }
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
            onAdd={(o) =>
              setObjects((prev) =>
                prev.some((x) => x.id === o.id) ? prev : [...prev, o]
              )
            }
            onRemove={(id) =>
              setObjects((prev) => prev.filter((x) => x.id !== id))
            }
            allowCreate
            onCreate={createObjectRef}
            placeholder="+ Add object"
            tone="fuchsia"
          />
        </FieldRow>

        <div className="mt-auto pt-1 text-[10px] text-ink-500">
          <span className="truncate font-mono" title={item.path}>
            {item.filename}
          </span>
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  label,
  status,
  children,
}: {
  label: React.ReactNode;
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

// ---- Lightbox -----------------------------------------------------------

function ImageLightbox({
  item,
  onClose,
}: {
  item: ImageItem;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copyPrompt() {
    if (!item.prompt.trim()) return;
    try {
      await navigator.clipboard.writeText(item.prompt);
      fireToast({ kind: "success", title: "Prompt copied" });
    } catch (err) {
      fireToast({ kind: "error", title: "Copy failed", body: String(err) });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[94vh] w-full max-w-[1400px] gap-4 overflow-hidden rounded-xl border border-ink-800 bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-1 items-center justify-center overflow-auto bg-black">
          <img
            src={item.fullUrl}
            alt={item.name}
            className="max-h-[94vh] max-w-full object-contain"
          />
        </div>
        <div className="flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto p-4 text-sm text-ink-200">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-medium text-ink-100">{item.name}</div>
              <div className="truncate font-mono text-[10px] text-ink-500" title={item.path}>
                {item.folder ? `${item.folder}/` : ""}
                {item.filename}
              </div>
            </div>
            <button
              className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-800"
              onClick={onClose}
            >
              Close
            </button>
          </div>

          {item.category !== "" && (
            <div>
              <span
                className={
                  "inline-block rounded px-1.5 py-0.5 font-mono text-[10px] " +
                  CATEGORY_TONE[item.category as Exclude<ImageCategory, "">]
                }
              >
                {CATEGORY_LABEL[item.category]}
              </span>
            </div>
          )}

          {item.description && (
            <div className="text-xs text-ink-300">{item.description}</div>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Prompt
              </span>
              <button
                type="button"
                onClick={copyPrompt}
                disabled={!item.prompt.trim()}
                className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] font-medium text-ink-300 hover:border-ink-500 hover:bg-ink-800 hover:text-ink-100 disabled:opacity-40"
              >
                Copy
              </button>
            </div>
            <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded bg-ink-950 p-2 font-mono text-[11px] text-ink-200">
              {item.prompt || "—"}
            </pre>
          </div>

          <div className="text-[10px] text-ink-500">
            {formatBytes(item.sizeBytes)}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
