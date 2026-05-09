import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

interface ClipForShotlist {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  characters?: { id: string; name: string }[];
  filename: string;
  source?: string;
  in?: number;
  out?: number;
  duration?: number;
  exportMode?: string;
  mode?: string;
  created: number;
}

function fmtTime(t: number | undefined): string {
  if (t === undefined || !Number.isFinite(t)) return "";
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${mm}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function fmtDuration(t: number | undefined): string {
  if (t === undefined || !Number.isFinite(t)) return "";
  return `${t.toFixed(2)}s`;
}

function escapeMd(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeCsv(s: string | undefined): string {
  if (s === undefined || s === null) return "";
  const str = String(s);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function loadAllClips(): ClipForShotlist[] {
  const dir = config.clipMetaDir;
  if (!fs.existsSync(dir)) return [];
  const out: ClipForShotlist[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8")
      ) as ClipForShotlist;
      out.push(data);
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function renderMarkdown(clips: ClipForShotlist[]): string {
  const header =
    "| # | Name | File | Duration | In → Out | Source | Tags | Characters | Description |\n" +
    "|---|------|------|----------|----------|--------|------|------------|-------------|\n";
  const rows = clips
    .map((c, i) => {
      const cells = [
        String(i + 1),
        escapeMd(c.name),
        "`" + escapeMd(c.filename) + "`",
        fmtDuration(c.duration),
        c.in !== undefined && c.out !== undefined
          ? `${fmtTime(c.in)} → ${fmtTime(c.out)}`
          : "",
        escapeMd(c.source),
        escapeMd((c.tags ?? []).join(", ")),
        escapeMd(
          (c.characters ?? []).map((ch) => ch.name).join(", ")
        ),
        escapeMd(c.description),
      ];
      return "| " + cells.join(" | ") + " |";
    })
    .join("\n");

  const generatedAt = new Date().toISOString();
  return [
    "# Shot list",
    "",
    `Project: \`${config.projectDir}\`  `,
    `Clips: **${clips.length}**  `,
    `Generated: ${generatedAt}`,
    "",
    header + rows,
    "",
  ].join("\n");
}

function renderCsv(clips: ClipForShotlist[]): string {
  const header = [
    "index",
    "name",
    "filename",
    "duration_seconds",
    "in_seconds",
    "out_seconds",
    "source",
    "tags",
    "characters",
    "description",
    "export_mode",
    "cut_mode",
    "created_iso",
  ].join(",");

  const rows = clips.map((c, i) =>
    [
      i + 1,
      escapeCsv(c.name),
      escapeCsv(c.filename),
      c.duration !== undefined ? c.duration.toFixed(3) : "",
      c.in !== undefined ? c.in.toFixed(3) : "",
      c.out !== undefined ? c.out.toFixed(3) : "",
      escapeCsv(c.source),
      escapeCsv((c.tags ?? []).join("; ")),
      escapeCsv((c.characters ?? []).map((ch) => ch.name).join("; ")),
      escapeCsv(c.description),
      escapeCsv(c.exportMode),
      escapeCsv(c.mode),
      new Date(c.created).toISOString(),
    ].join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}

let pending: NodeJS.Timeout | null = null;

/**
 * Regenerate shotlist.md and shotlist.csv. Debounced so a burst of edits only
 * writes once. Safe to call from anywhere on the hot path.
 */
export function scheduleShotlistRebuild(delayMs = 250): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    try {
      rebuildShotlistNow();
    } catch (err) {
      console.error("[shotlist] rebuild failed:", err);
    }
  }, delayMs);
}

export function rebuildShotlistNow(): void {
  const clips = loadAllClips();
  fs.writeFileSync(config.shotlistMdPath, renderMarkdown(clips));
  fs.writeFileSync(config.shotlistCsvPath, renderCsv(clips));
}
