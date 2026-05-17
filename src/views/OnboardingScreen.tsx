import { useEffect, useMemo, useState } from "react";
import { FsCheckResponse, checkFsPath, saveSettings } from "../lib/api";

interface Props {
  /** Current PROJECT_DIR resolved server-side (a sensible default the user can keep). */
  defaultProjectDir: string;
  /** Fires after a successful save so the parent can reload health + pool. */
  onComplete: () => void;
}

/**
 * First-run wizard. Shown when PROJECT_DIR (or legacy POOL_DIR) is not set in
 * .env. Walks the user through:
 *   1. picking a folder full of source videos,
 *   2. (optionally) pasting an OpenAI API key.
 * Then POSTs to /api/settings, which writes .env, and asks the parent to
 * reload so the rest of the app boots into the normal Pool view.
 */
export default function OnboardingScreen({
  defaultProjectDir,
  onComplete,
}: Props) {
  const [projectDir, setProjectDir] = useState(defaultProjectDir);
  const [apiKey, setApiKey] = useState("");
  const [check, setCheck] = useState<FsCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced path validation. Cheap stat call; no race-condition headaches.
  useEffect(() => {
    const value = projectDir.trim();
    if (!value) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    const handle = window.setTimeout(async () => {
      try {
        const r = await checkFsPath(value);
        if (!cancelled) setCheck(r);
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [projectDir]);

  const canSubmit = useMemo(() => {
    if (!projectDir.trim()) return false;
    if (!check) return false;
    return check.exists ? check.isDir : check.canCreate;
  }, [projectDir, check]);

  const clipsHint = useMemo(() => {
    const base = check?.expanded || projectDir.trim();
    if (!base) return null;
    const sep = base.endsWith("/") ? "" : "/";
    return `${base}${sep}clips/`;
  }, [check, projectDir]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const body: { projectDir?: string; openaiApiKey?: string } = {
        projectDir: projectDir.trim(),
      };
      const k = apiKey.trim();
      if (k) body.openaiApiKey = k;
      await saveSettings(body);
      onComplete();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-ink-950 text-ink-100">
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-12">
        <div className="mb-10 text-center">
          <div
            role="img"
            aria-label="Clipper Cowboy logo"
            className="mx-auto mb-4 h-60 w-60"
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
          <h1 className="text-3xl font-semibold tracking-tight">
            Welcome to Clipper Cowboy
          </h1>
          <p className="mt-3 text-sm text-ink-400">
            Local-first triage and cataloging for AI-generated video clips.
            Point it at a folder, optionally drop in an OpenAI key, and start
            clipping. Everything stays on your machine.
          </p>
        </div>

        <form
          className="space-y-6 rounded-xl border border-ink-800 bg-ink-900/60 p-6 shadow-xl"
          onSubmit={handleSubmit}
        >
          <Step n={1} title="Pick your project folder">
            <p className="text-sm text-ink-400">
              Drop source montages at the root of this folder. Exported clips
              go to <code className="font-mono text-ink-300">clips/</code>{" "}
              inside it, and a portable{" "}
              <code className="font-mono text-ink-300">shotlist.md</code> is
              regenerated as you work.
            </p>
            <input
              autoFocus
              className="w-full rounded-md bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="~/Movies/clipper-cowboy"
              spellCheck={false}
              autoComplete="off"
            />
            <PathStatus
              check={check}
              checking={checking}
              raw={projectDir.trim()}
            />
            {clipsHint && (
              <div className="mt-1 font-mono text-[11px] text-ink-500">
                clips will export to {clipsHint}
              </div>
            )}
          </Step>

          <Step n={2} title="(Optional) Add your OpenAI API key">
            <p className="text-sm text-ink-400">
              Enables AI auto-fill for clip names, descriptions, and tags, plus
              character recognition. Skip if you'd rather name clips by hand —
              everything else works without it. Stored in your local{" "}
              <code className="font-mono text-ink-300">.env</code>, never sent
              anywhere except OpenAI.{" "}
              <a
                className="text-accent-400 underline hover:text-accent-300"
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer noopener"
              >
                Get a key →
              </a>
            </p>
            <input
              type="password"
              className="w-full rounded-md bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
            />
          </Step>

          {error && (
            <div className="rounded-md bg-red-950/50 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-ink-800 pt-5">
            <div className="text-xs text-ink-500">
              You can change all of this later in Settings.
            </div>
            <button
              type="submit"
              disabled={!canSubmit || saving}
              className="rounded-md bg-accent-500 px-5 py-2 text-sm font-semibold text-black shadow hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Saving…" : "Get clipping →"}
            </button>
          </div>
        </form>

        <div className="mt-6 text-center text-xs text-ink-500">
          ffmpeg is bundled — no system install needed. macOS, Linux, and
          Windows all work.
        </div>
      </main>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-500/20 text-xs font-semibold text-accent-300">
          {n}
        </span>
        <h2 className="text-sm font-semibold tracking-tight text-ink-100">
          {title}
        </h2>
      </div>
      <div className="space-y-2 pl-8">{children}</div>
    </div>
  );
}

function PathStatus({
  check,
  checking,
  raw,
}: {
  check: FsCheckResponse | null;
  checking: boolean;
  raw: string;
}) {
  if (!raw) return null;
  if (checking && !check) {
    return <div className="text-xs text-ink-500">Checking…</div>;
  }
  if (!check) return null;
  if (check.exists && check.isDir) {
    return (
      <div className="text-xs text-emerald-300">
        ✓ Folder exists. Source videos at the root will appear in the Pool.
      </div>
    );
  }
  if (check.exists && !check.isDir) {
    return (
      <div className="text-xs text-red-300">
        That path exists but isn't a folder. Pick a directory.
      </div>
    );
  }
  if (check.canCreate) {
    return (
      <div className="text-xs text-amber-300">
        Folder doesn't exist yet — it'll be created when you continue.
      </div>
    );
  }
  return (
    <div className="text-xs text-red-300">
      Can't create that folder (parent missing or not writable).
    </div>
  );
}
