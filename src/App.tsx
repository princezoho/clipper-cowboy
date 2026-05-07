import { useEffect, useState } from "react";
import {
  HealthResponse,
  LibraryItem,
  PoolItem,
  fetchHealth,
  fetchLibrary,
  fetchPool,
} from "./lib/api";
import PoolView from "./views/PoolView";
import LibraryView from "./views/LibraryView";
import EditorOverlay from "./views/EditorOverlay";
import SettingsModal from "./views/SettingsModal";

type Tab = "pool" | "library";

export default function App() {
  const [tab, setTab] = useState<Tab>("pool");
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [editing, setEditing] = useState<PoolItem | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loadingPool, setLoadingPool] = useState(false);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingLibrary(false);
    }
  }

  useEffect(() => {
    fetchHealth().then(setHealth).catch((e) => setError(String(e)));
    reloadPool();
    reloadLibrary();
  }, []);

  function handleExportComplete() {
    reloadLibrary();
  }

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-ink-100">
      <header className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
        <div className="flex items-center gap-6">
          <div className="font-semibold tracking-tight">Clip Cataloger</div>
          <nav className="flex items-center gap-1 rounded-lg bg-ink-900 p-1">
            <TabButton active={tab === "pool"} onClick={() => setTab("pool")}>
              Pool
              <span className="ml-2 rounded bg-ink-800 px-1.5 py-0.5 text-xs text-ink-400">
                {pool.length}
              </span>
            </TabButton>
            <TabButton
              active={tab === "library"}
              onClick={() => setTab("library")}
            >
              Library
              <span className="ml-2 rounded bg-ink-800 px-1.5 py-0.5 text-xs text-ink-400">
                {library.length}
              </span>
            </TabButton>
          </nav>
        </div>

        <div className="flex items-center gap-3 text-xs text-ink-400">
          {health && (
            <>
              <FolderChip label="Pool" path={health.poolDir} />
              <FolderChip label="Library" path={health.libraryDir} />
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
          <button
            className="rounded-md border border-ink-700 px-2 py-1 text-ink-300 hover:bg-ink-800"
            onClick={() => {
              reloadPool();
              reloadLibrary();
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
        {tab === "pool" ? (
          <PoolView
            items={pool}
            loading={loadingPool}
            onPick={(item) => setEditing(item)}
          />
        ) : (
          <LibraryView
            items={library}
            loading={loadingLibrary}
            onChanged={reloadLibrary}
          />
        )}
      </main>

      {editing && (
        <EditorOverlay
          source={editing}
          onClose={() => setEditing(null)}
          onExported={handleExportComplete}
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
  const short = path.length > 40 ? "…" + path.slice(-40) : path;
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
