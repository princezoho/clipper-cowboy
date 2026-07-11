import { useEffect, useState } from "react";
import {
  HealthResponse,
  ImageItem,
  LibraryItem,
  OrphanFile,
  PoolItem,
  fetchHealth,
  fetchImages,
  fetchLibrary,
  fetchPool,
} from "./lib/api";
import PoolView from "./views/PoolView";
import LibraryView from "./views/LibraryView";
import ImagesView from "./views/ImagesView";
import CharactersView from "./views/CharactersView";
import EntityCatalogView from "./views/EntityCatalogView";
import EditorOverlay from "./views/EditorOverlay";
import SettingsModal from "./views/SettingsModal";
import OnboardingScreen from "./views/OnboardingScreen";
import ToastHost from "./components/ToastHost";
import ActivityPopover from "./components/ActivityPopover";
import StemJobsIndicator from "./components/StemJobsIndicator";
import {
  SaveStateIndicator,
  SaveStateProvider,
  useSaveState,
} from "./lib/saveState";
import { ToastKind, fireToast } from "./lib/toast";

type Tab = "pool" | "library" | "images" | "characters" | "scenes" | "objects";

export default function App() {
  // ToastHost is rendered before AppInner so its mount effect (which
  // subscribes to toastBus) runs first. Without this ordering, any toast
  // fired from AppInner's first-mount useEffect (e.g. the ?testToast=…
  // dev hook, future onboarding-complete toasts) is dispatched before the
  // host's listener is attached and silently dropped.
  return (
    <SaveStateProvider>
      <ToastHost />
      <AppInner />
    </SaveStateProvider>
  );
}

function AppInner() {
  const [tab, setTab] = useState<Tab>("pool");
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [imagesDir, setImagesDir] = useState<string>("");
  const [missingCount, setMissingCount] = useState(0);
  const [orphans, setOrphans] = useState<OrphanFile[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [editing, setEditing] = useState<PoolItem | null>(null);
  const [initialEditClipId, setInitialEditClipId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loadingPool, setLoadingPool] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [loadingImages, setLoadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openActivityOnMount] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("openActivity") === "1";
  });
  const [characterReloadKey, setCharacterReloadKey] = useState(0);
  const [sceneReloadKey, setSceneReloadKey] = useState(0);
  const [objectReloadKey, setObjectReloadKey] = useState(0);

  // Library filter state lives here so clicking a card on a catalog tab can
  // switch tabs and pre-set the filter chip.
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedSceneIds, setSelectedSceneIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedObjectIds, setSelectedObjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedTags, setSelectedTags] = useState<Set<string>>(
    () => new Set()
  );
  const [searchText, setSearchText] = useState("");

  function makeToggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>) {
    return (id: string, opts?: { switchTab?: boolean }) => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      if (opts?.switchTab) setTab("library");
    };
  }

  const toggleCharacterFilter = makeToggle(setSelectedCharacterIds);
  const toggleSceneFilter = makeToggle(setSelectedSceneIds);
  const toggleObjectFilter = makeToggle(setSelectedObjectIds);

  function toggleTagFilter(tag: string) {
    const lower = tag.toLowerCase();
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(lower)) next.delete(lower);
      else next.add(lower);
      return next;
    });
  }

  function clearAllFilters() {
    setSelectedCharacterIds(new Set());
    setSelectedSceneIds(new Set());
    setSelectedObjectIds(new Set());
    setSelectedTags(new Set());
    setSearchText("");
  }

  async function reloadPool() {
    setLoadingPool(true);
    setError(null);
    try {
      const r = await fetchPool();
      setPool(r.items);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingPool(false);
    }
  }

  async function reloadLibrary() {
    setLoadingLibrary(true);
    setError(null);
    try {
      const r = await fetchLibrary();
      setLibrary(r.items);
      setMissingCount(r.missingCount ?? 0);
      setOrphans(r.orphans ?? []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingLibrary(false);
    }
  }

  async function reloadImages() {
    setLoadingImages(true);
    setError(null);
    try {
      const r = await fetchImages();
      setImages(r.items);
      setImagesDir(r.imagesDir);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingImages(false);
    }
  }

  function reloadCharacters() {
    setCharacterReloadKey((k) => k + 1);
  }
  function reloadScenes() {
    setSceneReloadKey((k) => k + 1);
  }
  function reloadObjects() {
    setObjectReloadKey((k) => k + 1);
  }

  // Initial health check. Pool / library loads are deferred until we know
  // the user has actually configured a project folder — otherwise the first
  // /api/pool call could scan ~/ClipCataloger (or a stale legacy default) and
  // show a confusing "empty pool" before the onboarding screen renders.
  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setHealth(h);
        if (h.projectDirConfigured) {
          reloadPool();
          reloadLibrary();
          reloadImages();
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Auto-rescan when the user returns to the app (switches back to this tab/
  // window). Drop new clips into the project folder, switch back, and they
  // show up without anyone remembering to click Refresh. The /api/pool route
  // re-scans disk on every request, so this is just a re-fetch.
  useEffect(() => {
    if (!health?.projectDirConfigured) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      reloadPool();
      reloadLibrary();
      reloadImages();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [health?.projectDirConfigured]);

  async function refreshAfterOnboarding() {
    try {
      const h = await fetchHealth();
      setHealth(h);
      if (h.projectDirConfigured) {
        reloadPool();
        reloadLibrary();
        reloadImages();
      }
    } catch (err) {
      setError(String(err));
    }
  }

  // ?tab=library lets the mockup Test-it links land on the Library tab.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (
      t === "pool" ||
      t === "library" ||
      t === "images" ||
      t === "characters" ||
      t === "scenes" ||
      t === "objects"
    ) {
      setTab(t);
    }
  }, []);

  // Mockup test-button entry: ?openSource=<id> opens the editor on that source
  // as soon as the pool finishes loading. Lets the C.2 "Test it" button drop
  // straight into the Drafts UX without a manual click.
  useEffect(() => {
    if (pool.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("openSource");
    if (!wanted) return;
    const match = pool.find((p) => p.id === wanted) ?? pool[0];
    if (match) setEditing(match);
    // Clear the param so a refresh inside the editor doesn't reopen on close.
    params.delete("openSource");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? `?${next}` : "") + window.location.hash
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.length]);

  // Mockup test-buttons hooks: ?testToast=<kind> fires a demo toast on mount,
  // ?demoSaveState=saving holds the global save-state indicator in `saving`
  // for ~2s. Both are intentionally cheap and one-shot.
  const saveStore = useSaveState();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("testToast");
    if (t) {
      const kind = (
        ["success", "info", "warn", "error"] as const
      ).includes(t as ToastKind)
        ? (t as ToastKind)
        : "info";
      fireToast({
        kind,
        title: "Test toast",
        body: "Triggered via mockup test button",
      });
    }
    const d = params.get("demoSaveState");
    if (d === "saving" || d === "dirty" || d === "error") {
      const release = saveStore.markPending();
      const handle = window.setTimeout(() => release(), 2000);
      // Release on cleanup too, so StrictMode's double-invoke doesn't leak
      // a pending counter that pins the indicator to "saving" forever.
      return () => {
        window.clearTimeout(handle);
        release();
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExportComplete() {
    reloadLibrary();
    reloadPool();
  }

  function handlePreviewInEditor(id: string) {
    const item = library.find((it) => it.id === id);
    if (!item) return;
    const src = item.sourceId ? pool.find((p) => p.id === item.sourceId) : null;
    if (!src) {
      // No source pool item available — surface the limitation rather than
      // silently dropping the click.
      setError(
        "Original source is not in the pool anymore; can't preview in editor."
      );
      return;
    }
    setInitialEditClipId(id);
    setEditing(src);
  }

  // First-run wizard: show onboarding instead of the empty pool grid when
  // the user hasn't pointed Clipper Cowboy at a folder yet. The note about
  // a brand-new clone is "PROJECT_DIR isn't in .env yet" — not "the default
  // dir is empty", which would race with the user's first source-video drop.
  if (health && !health.projectDirConfigured) {
    return (
      <OnboardingScreen
        defaultProjectDir={health.projectDir}
        onComplete={refreshAfterOnboarding}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-ink-100">
      <header className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
        <div className="flex items-center gap-6">
          <div className="flex items-center">
            <div
              role="img"
              aria-label="Clipper Cowboy"
              className="h-[84px] w-[84px]"
              style={{
                backgroundColor: "#fef3c7",
                WebkitMaskImage: "url(/logo.png)",
                maskImage: "url(/logo.png)",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            />
          </div>
          <nav className="flex items-center gap-1 rounded-lg bg-ink-900 p-1">
            <TabButton active={tab === "pool"} onClick={() => setTab("pool")}>
              Pool
              <Counter n={pool.length} />
            </TabButton>
            <TabButton
              active={tab === "library"}
              onClick={() => setTab("library")}
            >
              Library
              <Counter n={library.length} />
            </TabButton>
            <TabButton
              active={tab === "images"}
              onClick={() => setTab("images")}
            >
              Images
              <Counter n={images.length} />
            </TabButton>
            <TabButton
              active={tab === "characters"}
              onClick={() => setTab("characters")}
            >
              Characters
            </TabButton>
            <TabButton
              active={tab === "scenes"}
              onClick={() => setTab("scenes")}
            >
              Scenes
            </TabButton>
            <TabButton
              active={tab === "objects"}
              onClick={() => setTab("objects")}
            >
              Objects
            </TabButton>
          </nav>
        </div>

        <div className="flex items-center gap-3 text-xs text-ink-400">
          {health && (
            <>
              <FolderChip label="Project" path={health.projectDir} />
              <span
                className={
                  health.hasOpenAIKey
                    ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-300"
                    : "rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300"
                }
                title={
                  health.hasOpenAIKey
                    ? "OpenAI key detected"
                    : "Set OPENAI_API_KEY in .env to enable AI captioning"
                }
              >
                {health.hasOpenAIKey ? "AI: ready" : "AI: no key"}
              </span>
            </>
          )}
          <SaveStateIndicator />
          <StemJobsIndicator
            enabled={Boolean(health?.projectDirConfigured)}
            configured={true}
          />
          <ActivityPopover openOnMount={openActivityOnMount} />
          <button
            className="rounded-md border border-ink-700 px-2 py-1 text-ink-300 hover:bg-ink-800"
            onClick={() => {
              reloadPool();
              reloadLibrary();
              reloadImages();
              reloadCharacters();
              reloadScenes();
              reloadObjects();
            }}
          >
            Refresh
          </button>
          <button
            className="rounded-md border border-ink-700 px-2 py-1 text-ink-300 hover:bg-ink-800"
            onClick={() => setShowSettings(true)}
          >
            Settings
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-5 py-2 text-sm text-red-200">
          {error}
          <button
            className="ml-3 underline opacity-70 hover:opacity-100"
            onClick={() => setError(null)}
          >
            dismiss
          </button>
        </div>
      )}

      <main className="flex-1 overflow-y-auto scrollbar-thin">
        {tab === "pool" && (
          <PoolView
            items={pool}
            loading={loadingPool}
            onPick={(item) => setEditing(item)}
            onChanged={reloadPool}
            poolDir={health?.projectDir}
          />
        )}
        {tab === "images" && (
          <ImagesView
            items={images}
            loading={loadingImages}
            imagesDir={imagesDir || (health?.imagesDir ?? "")}
            onChanged={reloadImages}
          />
        )}
        {tab === "library" && (
          <LibraryView
            items={library}
            loading={loadingLibrary}
            onChanged={reloadLibrary}
            missingCount={missingCount}
            orphans={orphans}
            selectedCharacterIds={selectedCharacterIds}
            selectedSceneIds={selectedSceneIds}
            selectedObjectIds={selectedObjectIds}
            selectedTags={selectedTags}
            searchText={searchText}
            onToggleCharacter={(id) => toggleCharacterFilter(id)}
            onToggleScene={(id) => toggleSceneFilter(id)}
            onToggleObject={(id) => toggleObjectFilter(id)}
            onToggleTag={toggleTagFilter}
            onSearchChange={setSearchText}
            onClearFilters={clearAllFilters}
            onPreviewInEditor={handlePreviewInEditor}
          />
        )}
        {tab === "characters" && (
          <CharactersView
            reloadKey={characterReloadKey}
            onChanged={reloadCharacters}
            selectedCharacterIds={selectedCharacterIds}
            onSelectCharacter={(id) =>
              toggleCharacterFilter(id, { switchTab: true })
            }
          />
        )}
        {tab === "scenes" && (
          <EntityCatalogView
            kind="scenes"
            label="Scenes"
            singular="scene"
            hint="Use scenes for recurring locations or moments — e.g. Saloon Brawl, Desert Showdown. Tag clips from the Editor."
            reloadKey={sceneReloadKey}
            onChanged={reloadScenes}
            selectedIds={selectedSceneIds}
            onSelect={(id) => toggleSceneFilter(id, { switchTab: true })}
            library={library}
          />
        )}
        {tab === "objects" && (
          <EntityCatalogView
            kind="objects"
            label="Objects"
            singular="object"
            hint="Use objects for physical things that recur across clips — e.g. Rose, Apple, Wagon. Tag clips from the Editor."
            reloadKey={objectReloadKey}
            onChanged={reloadObjects}
            selectedIds={selectedObjectIds}
            onSelect={(id) => toggleObjectFilter(id, { switchTab: true })}
            library={library}
          />
        )}
      </main>

      {editing && (
        <EditorOverlay
          source={editing}
          initialEditClipId={initialEditClipId}
          onClose={() => {
            setEditing(null);
            setInitialEditClipId(null);
          }}
          onExported={handleExportComplete}
          onCharactersChanged={reloadCharacters}
          onScenesChanged={reloadScenes}
          onObjectsChanged={reloadObjects}
          hasOpenAIKey={health?.hasOpenAIKey ?? false}
        />
      )}

      {showSettings && health && (
        <SettingsModal
          current={health}
          onClose={() => {
            setShowSettings(false);
            fetchHealth().then(setHealth).catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function Counter({ n }: { n: number }) {
  return (
    <span className="ml-2 rounded bg-ink-800 px-1.5 py-0.5 text-xs text-ink-400">
      {n}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-md px-3 py-1 text-sm transition " +
        (active
          ? "bg-ink-700 text-ink-100"
          : "text-ink-300 hover:bg-ink-800 hover:text-ink-100")
      }
    >
      {children}
    </button>
  );
}

function FolderChip({ label, path }: { label: string; path: string }) {
  const short = path.length > 48 ? "…" + path.slice(-48) : path;
  return (
    <span
      className="hidden md:inline-flex items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 font-mono text-[11px] text-ink-300"
      title={path}
    >
      <span className="text-ink-500">{label}</span>
      {short}
    </span>
  );
}
