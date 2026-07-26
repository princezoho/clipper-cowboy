import { useEffect, useState } from "react";
import {
  fetchStarterProject,
  loadStarterProject,
  StarterProjectStatus,
} from "../lib/api";
import { fireToast } from "../lib/toast";

export const WALKTHROUGH_VIDEO = "/roundup/tutorial/roundup-walkthrough.mp4";

/**
 * The panel a brand-new user actually lands on. An empty tab is the normal
 * state of a fresh install, so it has to read as a first step rather than as a
 * failure: what the tab holds, how material gets here, and a way to try the
 * workflow immediately.
 */
export function EmptyGuide({
  title,
  lead,
  steps,
  projectDir,
  primary,
  children,
}: {
  title: string;
  lead: string;
  steps?: React.ReactNode[];
  projectDir?: string;
  primary?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl space-y-5 text-center">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-ink-100">{title}</h2>
          <p className="text-sm leading-relaxed text-ink-400">{lead}</p>
        </div>

        {steps && steps.length > 0 && (
          <ol className="space-y-2 rounded-xl border border-ink-800 bg-ink-900/60 p-4 text-left text-sm text-ink-300">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-800 text-[11px] font-semibold text-ink-300">
                  {i + 1}
                </span>
                <span className="leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        )}

        {projectDir && (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-ink-500">
              Your project folder
            </div>
            <div
              className="break-all rounded-md bg-ink-900 px-3 py-2 font-mono text-[11px] text-ink-300"
              title={projectDir}
            >
              {projectDir}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          {primary}
          <a
            href={WALKTHROUGH_VIDEO}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-ink-700 px-4 py-2 text-sm text-ink-200 hover:bg-ink-800"
          >
            Watch the walkthrough
          </a>
        </div>

        {children}
      </div>
    </div>
  );
}

/**
 * Offers the bundled starter project: two synthetic montages and three
 * catalogued clips, copied into the project folder so every tab has something
 * real in it within a click. Hidden once loaded, and hidden entirely when the
 * sample media is not installed alongside the server.
 */
export function LoadStarterProjectButton({
  onLoaded,
  variant = "primary",
}: {
  onLoaded: () => void;
  variant?: "primary" | "secondary";
}) {
  const [status, setStatus] = useState<StarterProjectStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchStarterProject()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setStatus({ available: false, loaded: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!status?.available || status.loaded) return null;

  async function handleClick() {
    setLoading(true);
    try {
      const r = await loadStarterProject();
      setStatus((prev) => (prev ? { ...prev, loaded: true } : prev));
      fireToast({
        kind: "success",
        title: "Starter project loaded",
        body: `${r.sources} sample montages and ${r.clips} catalogued clips copied into your project folder. Delete them whenever you like.`,
      });
      onLoaded();
    } catch (err) {
      fireToast({
        kind: "error",
        title: "Could not load the starter project",
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      title="Copies a few tiny synthetic test-pattern clips into your project folder so you can try the workflow"
      className={
        variant === "primary"
          ? "rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:opacity-50"
          : "rounded-md border border-ink-700 px-4 py-2 text-sm text-ink-200 hover:bg-ink-800 disabled:opacity-50"
      }
    >
      {loading ? "Loading sample…" : "Load sample project"}
    </button>
  );
}
