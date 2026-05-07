interface Props {
  name: string;
  description: string;
  tags: string[];
  captioning: boolean;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onTags: (v: string[]) => void;
  onAutoFill: () => void;
  onExport: () => void;
  exporting: boolean;
  hasOpenAIKey: boolean;
}

export default function ClipMetaForm({
  name,
  description,
  tags,
  captioning,
  onName,
  onDescription,
  onTags,
  onAutoFill,
  onExport,
  exporting,
  hasOpenAIKey,
}: Props) {
  return (
    <div className="grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[1fr_auto]">
      <div className="grid grid-cols-1 gap-2">
        <label className="grid grid-cols-[5rem_1fr] items-center gap-2">
          <span className="text-xs text-ink-400">Name</span>
          <input
            className="rounded bg-ink-800 px-2 py-1.5 text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="e.g. Drone Shot, Sunset Coast"
          />
        </label>
        <label className="grid grid-cols-[5rem_1fr] items-start gap-2">
          <span className="pt-1 text-xs text-ink-400">Description</span>
          <textarea
            rows={2}
            className="rounded bg-ink-800 px-2 py-1.5 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
            value={description}
            onChange={(e) => onDescription(e.target.value)}
            placeholder="One-sentence summary"
          />
        </label>
        <label className="grid grid-cols-[5rem_1fr] items-center gap-2">
          <span className="text-xs text-ink-400">Tags</span>
          <input
            className="rounded bg-ink-800 px-2 py-1.5 text-sm text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500 font-mono"
            value={tags.join(", ")}
            onChange={(e) =>
              onTags(
                e.target.value
                  .split(",")
                  .map((t) => t.trim().toLowerCase())
                  .filter((t, i, arr) => t && arr.indexOf(t) === i)
              )
            }
            placeholder="drone, sunset, coast"
          />
        </label>
      </div>

      <div className="flex flex-col items-end justify-end gap-2">
        <button
          onClick={onAutoFill}
          disabled={captioning || !hasOpenAIKey}
          className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800 disabled:opacity-40"
          title={
            hasOpenAIKey
              ? "Use AI to suggest a name + tags for the current selection"
              : "Add OPENAI_API_KEY to .env to enable"
          }
        >
          {captioning ? "Thinking…" : "Auto-fill with AI"}
        </button>
        <button
          onClick={onExport}
          disabled={exporting || !name.trim()}
          className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black shadow hover:bg-accent-400 disabled:opacity-40"
          title="Export the selected range to your library (Enter)"
        >
          {exporting ? "Exporting…" : "Export clip ⏎"}
        </button>
      </div>
    </div>
  );
}
