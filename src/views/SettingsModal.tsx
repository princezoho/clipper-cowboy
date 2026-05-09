import { useState } from "react";
import { HealthResponse } from "../lib/api";

interface Props {
  current: HealthResponse;
  onClose: () => void;
}

export default function SettingsModal({ current, onClose }: Props) {
  const [projectDir, setProjectDir] = useState(current.projectDir);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const body: Record<string, string> = { projectDir };
      if (apiKey.trim()) body.openaiApiKey = apiKey.trim();
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setNote(data.note ?? "Saved.");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-ink-800 bg-ink-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
          <div className="font-medium">Settings</div>
          <button
            className="text-ink-400 hover:text-ink-100"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <Field
            label="Project folder"
            hint="One folder = one project. Source montages live at the root; clips go in clips/, characters in characters/, shotlist.md/csv at the root."
          >
            <input
              className="w-full rounded bg-ink-800 px-2 py-1.5 font-mono text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="/Users/you/Desktop/your-project"
            />
          </Field>

          <div className="rounded-md border border-ink-800 bg-ink-950/40 px-3 py-2 font-mono text-[11px] text-ink-400">
            <div>
              <span className="text-ink-500">clips/      </span>
              {current.clipsDir.replace(current.projectDir, "<project>")}
            </div>
            <div>
              <span className="text-ink-500">characters/ </span>
              {current.charactersDir.replace(
                current.projectDir,
                "<project>"
              )}
            </div>
            <div>
              <span className="text-ink-500">shotlist.md </span>
              {current.shotlistMd.replace(current.projectDir, "<project>")}
            </div>
            <div>
              <span className="text-ink-500">shotlist.csv</span>{" "}
              {current.shotlistCsv.replace(current.projectDir, "<project>")}
            </div>
          </div>

          <Field
            label="OpenAI API key"
            hint={
              current.hasOpenAIKey
                ? "A key is already set. Type a new value to replace it, or leave blank to keep the existing one."
                : "Required for AI auto-fill and character recognition. Stored in your .env file."
            }
          >
            <input
              type="password"
              className="w-full rounded bg-ink-800 px-2 py-1.5 font-mono text-xs text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={current.hasOpenAIKey ? "(unchanged)" : "sk-..."}
            />
          </Field>

          {error && (
            <div className="rounded bg-red-950/40 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
          {note && (
            <div className="rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {note}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-800 bg-ink-950/40 px-4 py-3">
          <button
            className="rounded px-3 py-1 text-sm text-ink-300 hover:text-ink-100"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded bg-accent-500 px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-400 disabled:opacity-50"
            onClick={save}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-ink-400">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-ink-500">{hint}</div>}
    </div>
  );
}
