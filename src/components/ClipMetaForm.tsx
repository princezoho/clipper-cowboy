import { AudioEngineStatus, ExportMode, StemQuality } from "../lib/api";

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
  createStems: boolean;
  onCreateStems: (enabled: boolean) => void;
  onRequestStemSetup: () => void;
  stemQuality: StemQuality;
  onStemQuality: (quality: StemQuality) => void;
  audioEngineStatus: AudioEngineStatus | null;
  audioEngineLoading: boolean;
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

const STEM_QUALITY_OPTIONS: Array<{
  value: StemQuality;
  label: string;
  description: string;
}> = [
  { value: "fast", label: "Fast", description: "Local dialogue, music, and effects split." },
];

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
  createStems,
  onCreateStems,
  onRequestStemSetup,
  stemQuality,
  onStemQuality,
  audioEngineStatus,
  audioEngineLoading,
  reexportMode,
}: Props) {
  const stemModeSupported = exportMode === "clip" || exportMode === "bundle";
  const audioEngineReady = Boolean(audioEngineStatus?.ready);

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

        {stemModeSupported && (
          <div className="w-full rounded-md border border-ink-700 bg-ink-950/40 p-2 md:w-[22rem]">
            <label className="flex items-center gap-2 text-sm text-ink-100">
              <input
                type="checkbox"
                checked={createStems}
                onChange={(event) => {
                  if (event.target.checked) {
                    onCreateStems(true);
                    if (!audioEngineReady) onRequestStemSetup();
                  } else {
                    onCreateStems(false);
                  }
                }}
                className="h-4 w-4 accent-accent-500"
              />
              <span>Split audio stems</span>
            </label>
            <div className="mt-1 text-[11px] leading-4 text-ink-500">
              {audioEngineLoading
                ? "Checking audio splitting…"
                : audioEngineReady
                  ? "Dialogue, music, SFX, and married mix."
                  : "Audio splitting needs a one-time local engine download. It runs on this Mac and may take a few minutes."}
            </div>

            {createStems && (
            <div className="mt-2">
              <div
                className="grid grid-cols-1 gap-1"
                role="radiogroup"
                aria-label="Stem quality"
              >
                {STEM_QUALITY_OPTIONS.map((option) => {
                  const selected = stemQuality === option.value;
                  const recommended =
                    audioEngineStatus?.recommendedQuality === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => onStemQuality(option.value)}
                      title={
                        option.description
                      }
                      className={
                        "rounded border px-2 py-1.5 text-left transition " +
                        (selected
                          ? "border-accent-400 bg-accent-500/15 text-ink-100"
                          : "border-ink-700 bg-ink-900 text-ink-400 hover:bg-ink-800")
                      }
                    >
                      <span className="block text-xs font-medium">
                        {option.label}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-3 text-ink-500">
                        {option.description}
                        {recommended ? " · Recommended" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-1.5 text-[11px] text-emerald-300">
                {audioEngineReady
                  ? "Runs locally in the background. Keep clipping while it works."
                  : "Install audio splitting to queue it after export."}
              </div>
            </div>
            )}
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
