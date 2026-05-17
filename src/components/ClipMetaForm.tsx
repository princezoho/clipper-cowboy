import { ExportMode } from "../lib/api";

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
  exportMode: ExportMode;
  onExportMode: (m: ExportMode) => void;
  /** When true, swap the Export button copy for a re-export-in-place flow. */
  reexportMode?: boolean;
}

const MODE_LABEL: Record<ExportMode, string> = {
  clip: "Clip",
  source: "Source",
  bundle: "Clip + Source",
};

const MODE_TITLE: Record<ExportMode, string> = {
  clip: "Smart-cut just the trimmed selection into the library.",
  source: "Clone the entire source montage into the library (no trim).",
  bundle:
    "Both: smart-cut clip AND a full clone of the source, side-by-side in the library.",
};

const MODE_CTA: Record<ExportMode, string> = {
  clip: "Export clip",
  source: "Export source",
  bundle: "Export bundle",
};

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
  exportMode,
  onExportMode,
  reexportMode,
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

        {!reexportMode && (
          <div className="flex overflow-hidden rounded-md border border-ink-700 text-xs">
            {(Object.keys(MODE_LABEL) as ExportMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onExportMode(m)}
                title={MODE_TITLE[m]}
                className={
                  "px-2.5 py-1 transition " +
                  (exportMode === m
                    ? "bg-accent-500 text-black"
                    : "bg-ink-900 text-ink-300 hover:bg-ink-800")
                }
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={onExport}
          disabled={exporting || !name.trim()}
          className={
            "rounded-md px-4 py-2 text-sm font-semibold shadow disabled:opacity-40 " +
            (reexportMode
              ? "bg-yellow-400 text-black hover:bg-yellow-300"
              : "bg-accent-500 text-black hover:bg-accent-400")
          }
          title={
            reexportMode
              ? "Re-cut this clip from the source and overwrite the existing file in place. (Enter)"
              : MODE_TITLE[exportMode] + " (Enter)"
          }
        >
          {exporting
            ? reexportMode
              ? "Re-exporting…"
              : "Exporting…"
            : reexportMode
              ? "Re-export clip ⏎"
              : `${MODE_CTA[exportMode]} ⏎`}
        </button>
      </div>
    </div>
  );
}
