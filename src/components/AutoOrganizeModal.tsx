import { useEffect, useMemo, useState } from "react";
import {
  PoolAnalyzeRow,
  PoolItem,
  analyzePoolContent,
  movePoolSources,
} from "../lib/api";
import { fireToast } from "../lib/toast";
import { showOpenAIQuotaToast, userFacingOpenAIError } from "../lib/openaiUx";

/*
 * Auto-organize wizard. 3 stages:
 *   1. Pre-flight    — explain the cost, let the user back out
 *   2. Analyzing     — POST /api/pool/analyze-content (returns when done)
 *   3. Review        — table of suggestions, user includes / edits, then Apply
 *
 * Apply path batches by target folder so a 50-clip pass collapses into ~5
 * /api/pool/move calls. After the pass finishes we toast + onComplete().
 */

const HARD_CAP = 100;

interface Props {
  /** Visible pool items the user has filtered to (we only analyze these). */
  items: PoolItem[];
  onClose: () => void;
  /** Called after Apply succeeds so the parent can refresh pool + folders. */
  onComplete: () => void;
}

type Stage = "pre" | "analyzing" | "review";

interface ReviewRow extends PoolAnalyzeRow {
  /** Editable text (defaults to AI suggestion, blank if no suggestion). */
  draftFolder: string;
  /** When false, this row is skipped at Apply time. */
  include: boolean;
  /** Per-row Apply state for the toast → individual error reporting. */
  status: "pending" | "ok" | "error";
  errorMsg?: string;
}

export default function AutoOrganizeModal({
  items,
  onClose,
  onComplete,
}: Props) {
  const [stage, setStage] = useState<Stage>("pre");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [applying, setApplying] = useState(false);

  const analyzableItems = useMemo(
    () => items.slice(0, HARD_CAP),
    [items]
  );
  const overCap = items.length > HARD_CAP;

  // ESC to close (but only when not actively analyzing — don't let the user
  // accidentally drop a pending GPT-4o batch mid-flight).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && stage !== "analyzing") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, onClose]);

  async function startAnalysis() {
    setStage("analyzing");
    try {
      const r = await analyzePoolContent(analyzableItems.map((i) => i.id));
      const byId = new Map(analyzableItems.map((i) => [i.id, i]));
      const initial: ReviewRow[] = r.suggestions.map((s) => {
        const it = byId.get(s.id);
        return {
          ...s,
          // Backend already includes filename/currentFolder, but prefer the
          // pool item's values (fresher, includes any rename the user did).
          filename: it?.filename ?? s.filename,
          currentFolder: it?.folder ?? s.currentFolder,
          draftFolder: s.suggested?.folder ?? "",
          // Default to "include" when confidence is med or high; let the user
          // opt-in for low-confidence suggestions.
          include: !!s.suggested && s.suggested.confidence !== "low",
          status: "pending",
        };
      });
      setRows(initial);
      setStage("review");
    } catch (err) {
      const quotaError = showOpenAIQuotaToast(err);
      if (!quotaError) {
        fireToast({
          kind: "error",
          title: "Auto-organize failed",
          body: userFacingOpenAIError(err),
        });
      }
      onClose();
    }
  }

  async function applyAll() {
    if (applying) return;
    const eligible = rows.filter(
      (r) => r.include && r.draftFolder.trim().length > 0
    );
    if (eligible.length === 0) {
      fireToast({
        kind: "warn",
        title: "Nothing to apply",
        body: "Toggle some rows on or fill in a folder name first.",
      });
      return;
    }
    setApplying(true);

    // Batch by target folder so the backend does fewer round-trips.
    const byFolder = new Map<string, ReviewRow[]>();
    for (const r of eligible) {
      const key = r.draftFolder.trim();
      const arr = byFolder.get(key) ?? [];
      arr.push(r);
      byFolder.set(key, arr);
    }

    const next = rows.slice();
    let totalMoved = 0;
    let totalErrors = 0;

    for (const [folder, batch] of byFolder.entries()) {
      try {
        const r = await movePoolSources(
          batch.map((b) => b.id),
          folder
        );
        const movedIds = new Set(r.items.map((i) => i.oldId));
        const errMap = new Map(r.errors.map((e) => [e.id, e.error]));
        for (let i = 0; i < next.length; i += 1) {
          const row = next[i];
          if (!batch.some((b) => b.id === row.id)) continue;
          if (movedIds.has(row.id)) {
            next[i] = { ...row, status: "ok" };
            totalMoved += 1;
          } else if (errMap.has(row.id)) {
            next[i] = {
              ...row,
              status: "error",
              errorMsg: errMap.get(row.id),
            };
            totalErrors += 1;
          } else {
            next[i] = { ...row, status: "error", errorMsg: "no result" };
            totalErrors += 1;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (let i = 0; i < next.length; i += 1) {
          const row = next[i];
          if (!batch.some((b) => b.id === row.id)) continue;
          next[i] = { ...row, status: "error", errorMsg: msg };
          totalErrors += 1;
        }
      }
      setRows(next.slice());
    }

    setApplying(false);

    if (totalMoved > 0) {
      fireToast({
        kind: totalErrors > 0 ? "warn" : "success",
        title: `Auto-organized ${totalMoved} video${totalMoved === 1 ? "" : "s"} into ${byFolder.size} folder${byFolder.size === 1 ? "" : "s"}`,
        body:
          totalErrors > 0
            ? `${totalErrors} skipped — see details in the review table`
            : undefined,
      });
      onComplete();
    } else {
      fireToast({
        kind: "error",
        title: "No videos moved",
        body: totalErrors > 0 ? `${totalErrors} errors` : "Nothing applied",
      });
    }
  }

  function patchRow(id: string, patch: Partial<ReviewRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  }

  function bulkInclude(value: boolean) {
    setRows((prev) =>
      prev.map((r) =>
        r.suggested ? { ...r, include: value } : r
      )
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={() => {
        if (stage !== "analyzing") onClose();
      }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-ink-800 bg-ink-900 text-ink-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <div>
            <div className="text-sm font-semibold">
              Auto-organize Pool with GPT-4o
            </div>
            <div className="text-xs text-ink-500">
              {stage === "pre" && `${analyzableItems.length} source${analyzableItems.length === 1 ? "" : "s"} ready to analyze`}
              {stage === "analyzing" &&
                `Analyzing ${analyzableItems.length} source${analyzableItems.length === 1 ? "" : "s"}…`}
              {stage === "review" &&
                `Review ${rows.length} suggestion${rows.length === 1 ? "" : "s"} before moving anything`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={stage === "analyzing"}
            className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-40"
          >
            {stage === "review" && !applying ? "Done" : "Cancel"}
          </button>
        </header>

        {stage === "pre" && (
          <div className="flex flex-col gap-4 overflow-y-auto p-6 text-sm text-ink-200">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-100">
              <div className="font-semibold">Heads up — this calls OpenAI.</div>
              <div className="mt-1 text-xs">
                We'll extract 3 frames from each of {analyzableItems.length} video
                {analyzableItems.length === 1 ? "" : "s"} and ask GPT-4o for a folder
                suggestion. Estimated total cost: <strong>~$0.15-0.30</strong> at
                current vision pricing. Nothing moves on disk yet — you'll review
                every suggestion first.
              </div>
            </div>
            {overCap && (
              <div
                className="rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-xs text-ink-400"
                title="GPT-4o batches are capped at 100 to keep costs predictable."
              >
                Pool has {items.length} sources. Only the first {HARD_CAP} will be
                analyzed in this pass — re-run after applying to handle the rest.
              </div>
            )}
            <ul className="space-y-1.5 text-xs text-ink-400">
              <li>• Frame extraction runs locally with ffmpeg.</li>
              <li>• Frames are sent to OpenAI as low-detail base64.</li>
              <li>• Suggestions land in a review table — you can edit, skip, or apply.</li>
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:bg-ink-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={startAnalysis}
                className="rounded-md bg-accent-500 px-3 py-2 text-sm font-semibold text-black hover:bg-accent-400"
              >
                Analyze {analyzableItems.length} video
                {analyzableItems.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}

        {stage === "analyzing" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-ink-300">
            <div className="text-4xl">🤖</div>
            <div className="text-sm">
              Analyzing {analyzableItems.length} source video
              {analyzableItems.length === 1 ? "" : "s"} with GPT-4o vision…
            </div>
            <div className="text-xs text-ink-500">
              This usually takes ~1-3 seconds per video. Don't close this dialog.
            </div>
            <div className="mt-2 inline-block h-2 w-32 overflow-hidden rounded-full bg-ink-800">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-accent-500" />
            </div>
          </div>
        )}

        {stage === "review" && (
          <ReviewTable
            rows={rows}
            applying={applying}
            onPatch={patchRow}
            onBulkInclude={bulkInclude}
            onApply={applyAll}
            onCancel={onClose}
          />
        )}
      </div>
    </div>
  );
}

function ReviewTable({
  rows,
  applying,
  onPatch,
  onBulkInclude,
  onApply,
  onCancel,
}: {
  rows: ReviewRow[];
  applying: boolean;
  onPatch: (id: string, patch: Partial<ReviewRow>) => void;
  onBulkInclude: (v: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const includedCount = rows.filter(
    (r) => r.include && r.draftFolder.trim().length > 0
  ).length;
  const folderCount = new Set(
    rows
      .filter((r) => r.include && r.draftFolder.trim().length > 0)
      .map((r) => r.draftFolder.trim())
  ).size;

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2 text-xs text-ink-400">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onBulkInclude(true)}
            className="rounded border border-ink-700 px-2 py-1 hover:bg-ink-800"
          >
            Include all
          </button>
          <button
            type="button"
            onClick={() => onBulkInclude(false)}
            className="rounded border border-ink-700 px-2 py-1 hover:bg-ink-800"
          >
            Skip all
          </button>
        </div>
        <div>
          <span className="font-mono">
            {includedCount} of {rows.length}
          </span>{" "}
          included → {folderCount} folder{folderCount === 1 ? "" : "s"}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-ink-950 text-[10px] uppercase tracking-wide text-ink-500">
            <tr>
              <th className="px-2 py-2 text-left">Thumb</th>
              <th className="px-2 py-2 text-left">Filename</th>
              <th className="px-2 py-2 text-left">Current</th>
              <th className="px-2 py-2 text-left">Suggested folder</th>
              <th className="px-2 py-2 text-left">Setting</th>
              <th className="px-2 py-2 text-left">Conf.</th>
              <th className="px-2 py-2 text-center">Include</th>
            </tr>
          </thead>
          <tbody className="text-xs text-ink-200">
            {rows.map((r) => (
              <tr
                key={r.id}
                className={
                  "border-t border-ink-800 " +
                  (r.status === "ok"
                    ? "bg-emerald-500/10"
                    : r.status === "error"
                      ? "bg-red-500/10"
                      : r.suggested
                        ? "hover:bg-ink-800/40"
                        : "opacity-60")
                }
              >
                <td className="w-[80px] px-2 py-1.5">
                  <img
                    src={`/api/thumb/${r.id}?t=1&w=120`}
                    alt={r.filename}
                    className="h-12 w-20 rounded bg-ink-950 object-cover"
                  />
                </td>
                <td
                  className="max-w-[260px] truncate px-2 py-1.5 font-mono text-[11px]"
                  title={r.filename}
                >
                  {r.filename}
                </td>
                <td className="max-w-[120px] truncate px-2 py-1.5 font-mono text-[10px] text-ink-500">
                  {r.currentFolder || "/"}
                </td>
                <td className="px-2 py-1.5">
                  {r.suggested ? (
                    <input
                      value={r.draftFolder}
                      onChange={(e) =>
                        onPatch(r.id, { draftFolder: e.target.value })
                      }
                      placeholder="kebab-case folder"
                      className="w-44 rounded bg-ink-800 px-2 py-1 font-mono text-[11px] text-ink-100 outline-none ring-1 ring-ink-700 focus:ring-accent-500"
                      disabled={applying || r.status === "ok"}
                    />
                  ) : (
                    <span
                      className="font-mono text-[11px] text-red-300"
                      title={r.error}
                    >
                      {r.error || "no suggestion"}
                    </span>
                  )}
                </td>
                <td className="max-w-[180px] truncate px-2 py-1.5 text-[11px] text-ink-300">
                  {r.suggested ? (
                    <span title={`time of day: ${r.suggested.timeOfDay}`}>
                      {r.suggested.setting}
                      {r.suggested.characters.length > 0 && (
                        <span className="ml-1 text-ink-500">
                          · {r.suggested.characters.join(", ")}
                        </span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-2 py-1.5 text-[10px] uppercase">
                  {r.suggested ? (
                    <span
                      className={
                        "rounded px-1.5 py-0.5 font-mono " +
                        (r.suggested.confidence === "high"
                          ? "bg-emerald-500/30 text-emerald-200"
                          : r.suggested.confidence === "med"
                            ? "bg-amber-500/30 text-amber-200"
                            : "bg-ink-800 text-ink-400")
                      }
                    >
                      {r.suggested.confidence}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {r.status === "ok" ? (
                    <span
                      className="text-emerald-400"
                      title="Moved successfully"
                    >
                      ✓
                    </span>
                  ) : r.status === "error" ? (
                    <span
                      className="text-red-400"
                      title={r.errorMsg ?? "error"}
                    >
                      ⚠
                    </span>
                  ) : r.suggested ? (
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) =>
                        onPatch(r.id, { include: e.target.checked })
                      }
                      disabled={applying}
                    />
                  ) : (
                    <span className="text-ink-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-ink-800 px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={applying}
          className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:bg-ink-800 disabled:opacity-40"
        >
          {rows.some((r) => r.status === "ok") ? "Done" : "Cancel"}
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={applying || includedCount === 0}
          className="rounded-md bg-accent-500 px-4 py-2 text-sm font-semibold text-black hover:bg-accent-400 disabled:opacity-40"
        >
          {applying
            ? "Moving…"
            : `Apply ${includedCount} → ${folderCount} folder${folderCount === 1 ? "" : "s"}`}
        </button>
      </footer>
    </>
  );
}
