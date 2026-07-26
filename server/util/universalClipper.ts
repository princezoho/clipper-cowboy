import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getDuration, probeFile } from "../ffmpeg.js";
import { smartCut, type SmartCutResult } from "../smartcut.js";
import { pathToId, safeFilename } from "./id.js";
import { appendRoundupLineage } from "./roundup.js";
import {
  createTrackableCopyIdentity,
  ensureTrackable,
} from "./roundupTags.js";

export const UNIVERSAL_CLIPPER_SCHEMA = "clipper-cowboy/universal-clipper@1";
const ID_RE = /^[a-f0-9]{16}$/;
export const STEM_ROLES = ["DIALOGUE", "MUSIC", "SFX", "MARRIED"] as const;
export type StemRole = (typeof STEM_ROLES)[number];

export interface PlannedStem {
  groupId: string;
  sourceId: string;
  clipId: string | null;
  stemRole: StemRole;
  inSeconds: number;
  outSeconds: number | null;
  filename: string;
  status: "existing-if-validated" | "planned-handoff";
}

export interface UniversalClipMeta {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  characters?: { id: string; name: string }[];
  scenes?: { id: string; name: string }[];
  objects?: { id: string; name: string }[];
  filename: string;
  path: string;
  source?: string;
  sourcePath?: string;
  sourceCopyPath?: string;
  sourceId?: string;
  in?: number;
  out?: number;
  duration?: number;
  created: number;
}

export interface UniversalPlanClip {
  clipId: string;
  sourceId: string;
  name: string;
  inSeconds: number;
  outSeconds: number;
  durationSeconds: number;
  outputFilename: string;
  qualityMethod: "adaptive-smart-cut";
  qualityNote: string;
  groupId: string;
  stems: PlannedStem[];
}

export interface UniversalPlanSource {
  sourceId: string;
  sourceFilename: string;
  sourcePath: string;
  fullSourceFilename: string;
  groupId: string;
  stems: PlannedStem[];
  clips: UniversalPlanClip[];
}

export interface UniversalPlan {
  schema: typeof UNIVERSAL_CLIPPER_SCHEMA;
  packageName: string;
  destinationRoot: string;
  selectedClipCount: number;
  sourceCount: number;
  sources: UniversalPlanSource[];
  mediaDirectory: "media";
  expectedAssetCount: number;
  stemExecution: {
    roles: StemRole[];
    behavior: "include-validated-existing-then-plan-handoff";
    confirmationRequired: true;
  };
  safety: {
    originals: "read-only-unchanged";
    collisionPolicy: "unique-package-and-exclusive-files";
    browserHandoff: "reveal-in-finder";
  };
}

export interface ClipSheetClip {
  groupId: string;
  clipId: string;
  clipAirTagId: string | null;
  outputAirTagId: string | null;
  sourceId: string;
  sourceAirTagId: string | null;
  sourcePath: string;
  sourcePathPrivacy: "local-absolute-path";
  sourceFilename: string;
  sourceInSeconds: number;
  sourceOutSeconds: number;
  durationSeconds: number;
  sourceInTimecode: string | null;
  sourceOutTimecode: string | null;
  timecodeNote: string;
  name: string;
  label: string;
  tags: string[];
  notes: string;
  characters: { id: string; name: string }[];
  scenes: { id: string; name: string }[];
  objects: { id: string; name: string }[];
  outputFilename: string;
  exportPath: string;
  fullSourceFilename: string;
  fullSourcePath: string;
  fullSourceAirTagId: string | null;
  exportMethod: SmartCutResult["mode"];
  exportDetails: string;
  lineage: {
    relation: "derived-copy";
    sourceAirTagId: string | null;
    outputAirTagId: string | null;
    lifeHistoryLookup: {
      sourcePath: string;
      outputPath: string;
    };
  };
  stems: ClipSheetStem[];
}

export interface ClipSheetStem {
  groupId: string;
  sourceId: string;
  clipId: string | null;
  stemRole: StemRole;
  inSeconds: number;
  outSeconds: number | null;
  filename: string;
  path: string | null;
  airTagId: string | null;
  status: "included" | "planned";
  alignment: string;
  validation?: {
    durationSeconds: number;
    sampleRate: number;
    channels: number;
    alignmentToleranceSeconds: number;
  };
}

export interface ClipSheet {
  schema: typeof UNIVERSAL_CLIPPER_SCHEMA;
  schemaVersion: 1;
  packageId: string;
  packageName: string;
  createdAt: string;
  handoff: "premiere-uxp-with-finder-fallback";
  sourcePathPrivacy: string;
  qualityStrategy: string;
  originalsPolicy: "read-only-unchanged";
  stemExecution: {
    status:
      | "not_requested"
      | "queued"
      | "checking_setup"
      | "running"
      | "validating"
      | "ready"
      | "setup_required"
      | "cancelled"
      | "interrupted"
      | "error";
    quality: "high" | "max" | null;
    jobId: string | null;
    externalJobId?: string;
    stage: string;
    percent: number;
    message: string;
    updatedAt: string;
  };
  premiere: {
    platform: "UXP";
    minimumVersion: "25.6.0";
    metadataPersistence: "clipper-local-mapping";
    timelineMutation: "explicit-only";
  };
  sources: {
    sourceId: string;
    sourceAirTagId: string | null;
    sourcePath: string;
    sourceFilename: string;
    fullSourceFilename: string;
    fullSourceAirTagId: string | null;
    groupId: string;
    stems: ClipSheetStem[];
    lineage: {
      relation: "derived-copy";
      sourceAirTagId: string | null;
      outputAirTagId: string | null;
      lifeHistoryLookup: { sourcePath: string; outputPath: string };
    };
  }[];
  clips: ClipSheetClip[];
}

export interface UniversalClipperRoots {
  projectDir: string;
  clipMetaDir: string;
  clipsDir: string;
  outputRoot: string;
}

function defaultRoots(): UniversalClipperRoots {
  return {
    projectDir: config.projectDir,
    clipMetaDir: config.clipMetaDir,
    clipsDir: config.clipsDir,
    outputRoot: path.join(config.derivedDir, "universal-clipper"),
  };
}

function contained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function existingFileWithin(roots: string[], candidate: unknown): string | null {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  try {
    const lst = fs.lstatSync(candidate);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    const real = fs.realpathSync(candidate);
    for (const root of roots) {
      const realRoot = fs.realpathSync(root);
      if (contained(realRoot, real) && real !== realRoot) return real;
    }
  } catch {
    return null;
  }
  return null;
}

function readClip(id: string, roots: UniversalClipperRoots): UniversalClipMeta {
  if (!ID_RE.test(id)) throw new Error(`invalid clip id: ${id}`);
  const sidecar = path.join(roots.clipMetaDir, `${id}.json`);
  let parsed: UniversalClipMeta;
  try {
    parsed = JSON.parse(fs.readFileSync(sidecar, "utf8")) as UniversalClipMeta;
  } catch {
    throw new Error(`clip not found: ${id}`);
  }
  if (parsed.id !== id) throw new Error(`clip identity mismatch: ${id}`);
  return parsed;
}

function resolveSource(meta: UniversalClipMeta, roots: UniversalClipperRoots): string {
  const sourceCopy = existingFileWithin([roots.clipsDir], meta.sourceCopyPath);
  if (sourceCopy) return sourceCopy;
  const source = existingFileWithin([roots.projectDir], meta.sourcePath);
  if (source) {
    const lexicalSourceId =
      typeof meta.sourcePath === "string" ? pathToId(meta.sourcePath) : null;
    if (
      meta.sourceId &&
      pathToId(source) !== meta.sourceId &&
      lexicalSourceId !== meta.sourceId
    ) {
      throw new Error(`source identity/path mismatch for clip: ${meta.id}`);
    }
    return source;
  }
  throw new Error(`full source unavailable for clip: ${meta.id}`);
}

function safePackageName(raw: string): string {
  const cleaned = safeFilename(raw)
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return cleaned || "premiere-handoff";
}

function uniqueNames(
  items: { id: string; preferred: string; ext: string }[]
): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const item of items) {
    const base = safeFilename(item.preferred) || item.id;
    let name = `${base}${item.ext}`;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}_${n}${item.ext}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    out.set(item.id, name);
  }
  return out;
}

export function planUniversalPackage(
  ids: string[],
  packageName = "premiere-handoff",
  roots: UniversalClipperRoots = defaultRoots()
): UniversalPlan {
  if (ids.length < 1 || ids.length > 500) throw new Error("select between 1 and 500 clips");
  if (new Set(ids).size !== ids.length) throw new Error("duplicate clip ids are not allowed");
  const clips = ids.map((id) => {
    const meta = readClip(id, roots);
    const sourcePath = resolveSource(meta, roots);
    const inSeconds = meta.in;
    const outSeconds = meta.out;
    if (
      typeof inSeconds !== "number" ||
      typeof outSeconds !== "number" ||
      !Number.isFinite(inSeconds) ||
      !Number.isFinite(outSeconds) ||
      inSeconds < 0 ||
      outSeconds - inSeconds < 0.1
    ) {
      throw new Error(`clip has no valid source range: ${id}`);
    }
    return { meta, sourcePath, inSeconds, outSeconds };
  });

  const grouped = new Map<string, typeof clips>();
  for (const clip of clips) {
    const key = `${clip.meta.sourceId ?? ""}\0${clip.sourcePath}`;
    const group = grouped.get(key) ?? [];
    group.push(clip);
    grouped.set(key, group);
  }

  const sourceNames = uniqueNames(
    [...grouped.entries()].map(([key, group]) => ({
      id: key,
      preferred: path.basename(group[0].sourcePath, path.extname(group[0].sourcePath)),
      ext: path.extname(group[0].sourcePath).toLowerCase() || ".mov",
    }))
  );

  const sources = [...grouped.entries()].map(([key, group]) => {
    const first = group[0];
    const sourceId = first.meta.sourceId ?? crypto.createHash("sha256").update(first.sourcePath).digest("hex").slice(0, 16);
    const fullSourceFilename = sourceNames.get(key)!;
    const prefix = path.basename(fullSourceFilename, path.extname(fullSourceFilename));
    const groupId = `source:${sourceId}`;
    const sourceStems = STEM_ROLES.map((stemRole) => ({
      groupId,
      sourceId,
      clipId: null,
      stemRole,
      inSeconds: 0,
      outSeconds: null,
      filename: `${prefix}__${stemRole}.wav`,
      status: "planned-handoff" as const,
    }));
    return {
      sourceId,
      sourceFilename: path.basename(first.sourcePath),
      sourcePath: first.sourcePath,
      fullSourceFilename,
      groupId,
      stems: sourceStems,
      clips: group.map(({ meta, inSeconds, outSeconds }, index) => {
        const clipPrefix = `${prefix}__clip-${String(index + 1).padStart(2, "0")}`;
        const clipGroupId = `${groupId}:clip:${meta.id}`;
        return {
          clipId: meta.id,
          sourceId,
          name: meta.name,
          inSeconds,
          outSeconds,
          durationSeconds: outSeconds - inSeconds,
          outputFilename: `${clipPrefix}${path.extname(first.sourcePath).toLowerCase() || ".mov"}`,
          qualityMethod: "adaptive-smart-cut" as const,
          qualityNote:
            "Stream-copy is used only when both endpoints align to keyframes; otherwise edge frames or the full range are losslessly re-encoded for precise marks.",
          groupId: clipGroupId,
          stems: STEM_ROLES.map((stemRole) => ({
            groupId: clipGroupId,
            sourceId,
            clipId: meta.id,
            stemRole,
            inSeconds,
            outSeconds,
            filename: `${clipPrefix}__${stemRole}.wav`,
            status: "existing-if-validated" as const,
          })),
        };
      }),
    };
  });

  return {
    schema: UNIVERSAL_CLIPPER_SCHEMA,
    packageName: safePackageName(packageName),
    destinationRoot: roots.outputRoot,
    selectedClipCount: clips.length,
    sourceCount: sources.length,
    sources,
    mediaDirectory: "media",
    expectedAssetCount:
      sources.length * (1 + STEM_ROLES.length) +
      clips.length * (1 + STEM_ROLES.length),
    stemExecution: {
      roles: [...STEM_ROLES],
      behavior: "include-validated-existing-then-plan-handoff",
      confirmationRequired: true,
    },
    safety: {
      originals: "read-only-unchanged",
      collisionPolicy: "unique-package-and-exclusive-files",
      browserHandoff: "reveal-in-finder",
    },
  };
}

function allocatePackageDir(root: string, base: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(path.dirname(root));
  if (path.dirname(realRoot) !== realParent) {
    throw new Error("universal package root must not be a symlink escape");
  }
  let n = 1;
  while (true) {
    const suffix = n === 1 ? "" : `_${n}`;
    const candidate = path.join(realRoot, `${base}${suffix}`);
    if (!contained(realRoot, candidate) || candidate === realRoot) throw new Error("unsafe package destination");
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      n += 1;
    }
  }
}

function copyExclusive(source: string, destination: string): void {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function csvCell(value: unknown): string {
  const raw =
    value == null ? "" : Array.isArray(value) ? value.join(" | ") : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

export function clipSheetCsv(sheet: ClipSheet): string {
  const header = [
    "asset_kind", "group_id", "source_id", "clip_id", "stem_role",
    "source_in_seconds", "source_out_seconds", "duration_seconds", "filename",
    "status", "name", "tags", "notes", "source_path", "airtag_uuid",
  ];
  const rows: unknown[][] = [];
  for (const source of sheet.sources) {
    rows.push([
      "full-source-video", source.groupId, source.sourceId, "", "", 0, "", "",
      source.fullSourceFilename, "included", source.sourceFilename, "", "",
      source.sourcePath, source.fullSourceAirTagId,
    ]);
    for (const stem of source.stems) {
      rows.push([
        "full-source-stem", stem.groupId, stem.sourceId, "", stem.stemRole,
        stem.inSeconds, stem.outSeconds, "", stem.filename, stem.status, "", "",
        stem.alignment, source.sourcePath, stem.airTagId,
      ]);
    }
  }
  for (const clip of sheet.clips) {
    rows.push([
      "clip-video", clip.groupId,
      clip.sourceId, clip.clipId, "", clip.sourceInSeconds, clip.sourceOutSeconds,
      clip.durationSeconds, clip.outputFilename, "included", clip.name, clip.tags,
      clip.notes, clip.sourcePath, clip.outputAirTagId,
    ]);
    for (const stem of clip.stems) {
      rows.push([
        "clip-stem", stem.groupId, stem.sourceId, clip.clipId, stem.stemRole,
        stem.inSeconds, stem.outSeconds, clip.durationSeconds, stem.filename,
        stem.status, clip.name, clip.tags, stem.alignment, clip.sourcePath,
        stem.airTagId,
      ]);
    }
  }
  return [
    header.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\r\n") + "\r\n";
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function packageHtml(sheet: ClipSheet): string {
  const rows = sheet.clips.map((clip) => `<tr><td>${htmlEscape(clip.name)}</td><td>${htmlEscape(clip.sourceFilename)}</td><td>${clip.sourceInSeconds.toFixed(3)}–${clip.sourceOutSeconds.toFixed(3)}</td><td>${htmlEscape(clip.outputFilename)}</td><td>${clip.stems.map((stem) => `${htmlEscape(stem.stemRole)}: ${htmlEscape(stem.filename)} (${stem.status})`).join("<br>")}</td><td>${htmlEscape(clip.exportMethod)}</td></tr>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(sheet.packageName)} clip sheet</title><style>body{font:14px system-ui;margin:32px;color:#201c18}h1{font-family:Georgia,serif}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9bda9;padding:8px;text-align:left}th{background:#f2eadc}code{background:#f4f0e8;padding:2px 4px}</style></head><body><h1>Universal Clipper</h1><p>${sheet.clips.length} clips from ${sheet.sources.length} full sources. Originals were not modified.</p><p>Package ID: <code>${htmlEscape(sheet.packageId)}</code>. Open the Universal Clipper UXP panel in Premiere Pro 25.6+ to preview and import only missing assets. <code>media/</code> remains the Finder fallback.</p><p>Stem execution: ${htmlEscape(sheet.stemExecution.status)} — ${htmlEscape(sheet.stemExecution.message)}</p><table><thead><tr><th>Clip</th><th>Source</th><th>Source range (seconds)</th><th>Video</th><th>Sibling stems</th><th>Method</th></tr></thead><tbody>${rows}</tbody></table><p>Machine-readable details: <code>clip-sheet.json</code> and <code>clip-sheet.csv</code>.</p></body></html>\n`;
}

export function refreshUniversalPackageArtifacts(
  folder: string,
  sheet: ClipSheet & { incomplete?: boolean }
): void {
  const files = [
    {
      name: "clip-sheet.json",
      content: JSON.stringify(sheet, null, 2) + "\n",
    },
    { name: "clip-sheet.csv", content: clipSheetCsv(sheet) },
    { name: "README.html", content: packageHtml(sheet) },
  ];
  const written: string[] = [];
  try {
    for (const file of files) {
      const destination = path.join(folder, file.name);
      const temp = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
      fs.writeFileSync(temp, file.content, { flag: "wx", mode: 0o600 });
      written.push(temp);
    }
    for (let index = 0; index < files.length; index += 1) {
      fs.renameSync(written[index], path.join(folder, files[index].name));
    }
  } finally {
    for (const temp of written) {
      try {
        if (fs.existsSync(temp)) fs.rmSync(temp);
      } catch {
        // Generated temporary metadata only; leave the previous valid artifact.
      }
    }
  }
}

export interface ExecuteOptions {
  roots?: UniversalClipperRoots;
  cut?: typeof smartCut;
  confirmedStemHandoff?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number, stage: string) => void;
}

async function existingValidatedStems(
  clipId: string,
  expectedDuration: number,
  roots: UniversalClipperRoots
): Promise<Map<StemRole, string>> {
  const found = new Map<StemRole, string>();
  let stemRoot: string;
  try {
    stemRoot = fs.realpathSync(path.join(roots.projectDir, "derived", "stems"));
  } catch {
    return found;
  }
  for (const entry of fs.readdirSync(stemRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(stemRoot, entry.name);
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
      if (!contained(stemRoot, realDir) || realDir === stemRoot) continue;
      const manifest = JSON.parse(
        fs.readFileSync(path.join(realDir, "manifest.json"), "utf8")
      ) as { clipId?: string; files?: string[] };
      if (manifest.clipId !== clipId || !Array.isArray(manifest.files)) continue;
      for (const role of STEM_ROLES) {
        const filename = manifest.files.find((name) =>
          new RegExp(`_${role}\\.wav$`, "i").test(name)
        );
        if (!filename || path.basename(filename) !== filename) continue;
        const candidate = path.join(realDir, filename);
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) continue;
        const real = fs.realpathSync(candidate);
        if (!contained(realDir, real)) continue;
        const duration = await getDuration(real);
        // Audio is sample-aligned to the exported clip. Allow a small encoder
        // tail while refusing visibly mismatched or wrong-source stems.
        if (Math.abs(duration - expectedDuration) > 0.25) continue;
        found.set(role, real);
      }
      if (found.size > 0) return found;
    } catch {
      // Malformed or stale stem output is skipped, never trusted.
    }
  }
  return found;
}

export async function executeUniversalPackage(
  ids: string[],
  packageName: string,
  options: ExecuteOptions = {}
): Promise<{ folder: string; sheet: ClipSheet; incomplete: boolean }> {
  const roots = options.roots ?? defaultRoots();
  const cut = options.cut ?? smartCut;
  if (options.confirmedStemHandoff !== true) {
    throw new Error("explicit stem handoff confirmation is required");
  }
  const plan = planUniversalPackage(ids, packageName, roots);
  const folder = allocatePackageDir(roots.outputRoot, plan.packageName);
  const packageId = crypto.randomUUID();
  const mediaDir = path.join(folder, "media");
  fs.mkdirSync(mediaDir, { mode: 0o700 });
  const total = plan.sourceCount + plan.selectedClipCount;
  let completed = 0;
  let incomplete = false;
  const sourceRows: ClipSheet["sources"] = [];
  const clipRows: ClipSheetClip[] = [];

  for (const source of plan.sources) {
    if (options.isCancelled?.()) {
      incomplete = true;
      break;
    }
    const fullSourcePath = path.join(mediaDir, source.fullSourceFilename);
    copyExclusive(source.sourcePath, fullSourcePath);
    const sourceTag = ensureTrackable(source.sourcePath);
    const fullSourceTag = createTrackableCopyIdentity(fullSourcePath);
    appendRoundupLineage({
      sourcePath: source.sourcePath,
      outputPath: fullSourcePath,
      sourceTagId: sourceTag?.id,
      outputTagId: fullSourceTag?.id,
      packageId,
    });
    const sourceSheetStems: ClipSheetStem[] = source.stems.map((stem) => ({
      ...stem,
      path: null,
      airTagId: null,
      status: "planned",
      alignment:
        "Full-source stems must begin at source time 0 and match source duration/sample count before publication.",
    }));
    sourceRows.push({
      sourceId: source.sourceId,
      sourceAirTagId: sourceTag?.id ?? null,
      sourcePath: source.sourcePath,
      sourceFilename: source.sourceFilename,
      fullSourceFilename: source.fullSourceFilename,
      fullSourceAirTagId: fullSourceTag?.id ?? null,
      groupId: source.groupId,
      stems: sourceSheetStems,
      lineage: {
        relation: "derived-copy",
        sourceAirTagId: sourceTag?.id ?? null,
        outputAirTagId: fullSourceTag?.id ?? null,
        lifeHistoryLookup: {
          sourcePath: source.sourcePath,
          outputPath: fullSourcePath,
        },
      },
    });
    completed += 1;
    options.onProgress?.(completed, total, `Copied full source ${source.sourceFilename}`);

    for (const plannedClip of source.clips) {
      if (options.isCancelled?.()) {
        incomplete = true;
        break;
      }
      const meta = readClip(plannedClip.clipId, roots);
      const clipPath = existingFileWithin([roots.clipsDir], meta.path);
      const outputPath = path.join(mediaDir, plannedClip.outputFilename);
      if (fs.existsSync(outputPath)) throw new Error("package output collision");
      const result = await cut(
        source.sourcePath,
        plannedClip.inSeconds,
        plannedClip.outSeconds,
        outputPath
      );
      const clipTag = clipPath ? ensureTrackable(clipPath) : null;
      const outputTag = createTrackableCopyIdentity(outputPath);
      appendRoundupLineage({
        sourcePath: source.sourcePath,
        outputPath,
        sourceTagId: sourceTag?.id,
        outputTagId: outputTag?.id,
        clipId: meta.id,
        packageId,
      });
      const existingStems = await existingValidatedStems(
        meta.id,
        plannedClip.durationSeconds,
        roots
      );
      const clipStems: ClipSheetStem[] = [];
      for (const plannedStem of plannedClip.stems) {
        const existing = existingStems.get(plannedStem.stemRole);
        if (existing) {
          const destination = path.join(mediaDir, plannedStem.filename);
          copyExclusive(existing, destination);
          const existingStemTag = ensureTrackable(existing);
          const destinationStemTag = createTrackableCopyIdentity(destination);
          appendRoundupLineage({
            sourcePath: existing,
            outputPath: destination,
            sourceTagId: existingStemTag?.id,
            outputTagId: destinationStemTag?.id,
            clipId: meta.id,
            packageId,
          });
          clipStems.push({
            ...plannedStem,
            path: destination,
            airTagId: destinationStemTag?.id ?? null,
            status: "included",
            alignment:
              "Validated against the clip duration (≤0.25s tolerance); the stem starts at clip time 0 and corresponds to the same source in/out range.",
          });
        } else {
          clipStems.push({
            ...plannedStem,
            path: null,
            airTagId: null,
            status: "planned",
            alignment:
              "Must be separated from this exact clip output so stem time 0 equals the selected source in and its duration equals the clip.",
          });
        }
      }
      clipRows.push({
        groupId: plannedClip.groupId,
        clipId: meta.id,
        clipAirTagId: clipTag?.id ?? null,
        outputAirTagId: outputTag?.id ?? null,
        sourceId: source.sourceId,
        sourceAirTagId: sourceTag?.id ?? null,
        sourcePath: source.sourcePath,
        sourcePathPrivacy: "local-absolute-path",
        sourceFilename: source.sourceFilename,
        sourceInSeconds: plannedClip.inSeconds,
        sourceOutSeconds: plannedClip.outSeconds,
        durationSeconds: plannedClip.durationSeconds,
        sourceInTimecode: null,
        sourceOutTimecode: null,
        timecodeNote: "No authoritative source frame-rate/timecode metadata is stored; seconds are canonical.",
        name: meta.name,
        label: meta.name,
        tags: meta.tags ?? [],
        notes: meta.description ?? "",
        characters: meta.characters ?? [],
        scenes: meta.scenes ?? [],
        objects: meta.objects ?? [],
        outputFilename: plannedClip.outputFilename,
        exportPath: outputPath,
        fullSourceFilename: source.fullSourceFilename,
        fullSourcePath,
        fullSourceAirTagId: fullSourceTag?.id ?? null,
        exportMethod: result.mode,
        exportDetails: result.details,
        lineage: {
          relation: "derived-copy",
          sourceAirTagId: sourceTag?.id ?? null,
          outputAirTagId: outputTag?.id ?? null,
          lifeHistoryLookup: {
            sourcePath: source.sourcePath,
            outputPath,
          },
        },
        stems: clipStems,
      });
      completed += 1;
      options.onProgress?.(completed, total, `Prepared ${meta.name}`);
    }
    if (incomplete) break;
  }

  const sheet: ClipSheet = {
    schema: UNIVERSAL_CLIPPER_SCHEMA,
    schemaVersion: 1,
    packageId,
    packageName: plan.packageName,
    createdAt: new Date().toISOString(),
    handoff: "premiere-uxp-with-finder-fallback",
    sourcePathPrivacy:
      "This local manifest includes absolute source paths for traceability. Remove or redact them before sharing outside this workstation.",
    qualityStrategy:
      "Keyframe-aligned ranges use stream copy. Other ranges use the existing lossless smart-cut/transcode path for precise marks; output size and codec compatibility may differ.",
    originalsPolicy: "read-only-unchanged",
    stemExecution: {
      status: "not_requested",
      quality: null,
      jobId: null,
      stage: "Media prepared; stems have not been requested",
      percent: 0,
      message:
        "Choose Separate stems in Clipper Cowboy to run the official Stem Studio MCP.",
      updatedAt: new Date().toISOString(),
    },
    premiere: {
      platform: "UXP",
      minimumVersion: "25.6.0",
      metadataPersistence: "clipper-local-mapping",
      timelineMutation: "explicit-only",
    },
    sources: sourceRows,
    clips: clipRows,
  };
  fs.writeFileSync(path.join(folder, "clip-sheet.json"), JSON.stringify({ ...sheet, incomplete }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(folder, "clip-sheet.csv"), clipSheetCsv(sheet), { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(folder, "README.html"), packageHtml(sheet), { flag: "wx", mode: 0o600 });
  const expectedStems = [
    ...sheet.sources.flatMap((source) => source.stems),
    ...sheet.clips.flatMap((clip) => clip.stems),
  ].filter((stem) => stem.status === "planned");
  const stemInbox = path.join(folder, "stem-inbox");
  fs.mkdirSync(stemInbox, { mode: 0o700 });
  fs.writeFileSync(
    path.join(folder, "stem-handoff.json"),
    JSON.stringify(
      {
        schema: "clipper-cowboy/universal-clipper-stem-handoff@1",
        confirmedModelExecution: false,
        execution: sheet.stemExecution,
        connector: "official-stem-studio-mcp",
        setupPolicy:
          "Clipper never invokes setup_environment or installs/downloads models.",
        taxonomy: STEM_ROLES,
        outputDirectory: stemInbox,
        publishDestination: mediaDir,
        collisionPolicy: "exclusive-create-never-overwrite",
        validation:
          "Publish only WAV files with matching group/source/clip identity and duration. Clip stems use the exact video source in/out and start at clip time 0.",
        expected: expectedStems,
      },
      null,
      2
    ) + "\n",
    { flag: "wx", mode: 0o600 }
  );
  return { folder, sheet, incomplete };
}

export async function publishUniversalStemReturns(
  packageFolder: string,
  roots: UniversalClipperRoots = defaultRoots()
): Promise<{ published: number; remaining: number; rejected: string[] }> {
  const outputRoot = fs.realpathSync(roots.outputRoot);
  const folder = fs.realpathSync(packageFolder);
  if (!contained(outputRoot, folder) || folder === outputRoot) {
    throw new Error("unsafe package folder");
  }
  const mediaDir = fs.realpathSync(path.join(folder, "media"));
  const inbox = fs.realpathSync(path.join(folder, "stem-inbox"));
  if (!contained(folder, mediaDir) || !contained(folder, inbox)) {
    throw new Error("unsafe package layout");
  }
  const manifestPath = path.join(folder, "clip-sheet.json");
  const stored = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ClipSheet & {
    incomplete?: boolean;
  };
  const allStems = [
    ...stored.sources.flatMap((source) => source.stems),
    ...stored.clips.flatMap((clip) => clip.stems),
  ];
  const sourceByGroup = new Map(stored.sources.map((source) => [source.groupId, source]));
  const clipByGroup = new Map(stored.clips.map((clip) => [clip.groupId, clip]));
  let published = 0;
  const rejected: string[] = [];
  const pendingGroups = new Map<string, ClipSheetStem[]>();
  for (const stem of allStems.filter((candidate) => candidate.status === "planned")) {
    const group = pendingGroups.get(stem.groupId) ?? [];
    group.push(stem);
    pendingGroups.set(stem.groupId, group);
  }
  for (const [groupId, stems] of pendingGroups) {
    const present = stems.filter((stem) =>
      fs.existsSync(path.join(inbox, stem.filename))
    );
    if (present.length === 0) continue;
    if (present.length !== stems.length) {
      rejected.push(
        `${groupId}: complete ${stems.length}-stem group required; found ${present.length}`
      );
      continue;
    }
    const candidates: {
      stem: ClipSheetStem;
      incoming: string;
      destination: string;
      duration: number;
      sampleRate: number;
      channels: number;
    }[] = [];
    try {
      const clip = clipByGroup.get(groupId);
      const source = sourceByGroup.get(groupId);
      const expectedDuration = clip
        ? clip.durationSeconds
        : source
          ? await getDuration(path.join(mediaDir, source.fullSourceFilename))
          : 0;
      if (!expectedDuration) throw new Error("unknown or invalid stem group");
      for (const stem of stems) {
        if (path.basename(stem.filename) !== stem.filename) {
          throw new Error(`${stem.filename}: unsafe filename`);
        }
        const incoming = path.join(inbox, stem.filename);
        const incomingStat = fs.lstatSync(incoming);
        if (
          incomingStat.isSymbolicLink() ||
          !incomingStat.isFile() ||
          incomingStat.size === 0
        ) {
          throw new Error(`${stem.filename}: not a regular non-empty file`);
        }
        const realIncoming = fs.realpathSync(incoming);
        if (!contained(inbox, realIncoming)) {
          throw new Error(`${stem.filename}: escaped stem inbox`);
        }
        const probe = await probeFile(realIncoming);
        const audio = probe.streams.find((stream) => stream.codec_type === "audio");
        const duration = Number(probe.format.duration ?? 0);
        const sampleRate = Number(audio?.sample_rate ?? 0);
        const channels = Number(audio?.channels ?? 0);
        if (
          !audio ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          !Number.isInteger(sampleRate) ||
          sampleRate <= 0 ||
          !Number.isInteger(channels) ||
          channels <= 0
        ) {
          throw new Error(`${stem.filename}: invalid audio metadata`);
        }
        if (Math.abs(duration - expectedDuration) > 0.25) {
          throw new Error(
            `${stem.filename}: duration ${duration.toFixed(3)}s does not match ${expectedDuration.toFixed(3)}s`
          );
        }
        const destination = path.join(mediaDir, stem.filename);
        if (fs.existsSync(destination)) {
          throw new Error(`${stem.filename}: destination already exists`);
        }
        candidates.push({
          stem,
          incoming: realIncoming,
          destination,
          duration,
          sampleRate,
          channels,
        });
      }
      const reference = candidates[0];
      if (
        candidates.some(
          (candidate) =>
            candidate.sampleRate !== reference.sampleRate ||
            candidate.channels !== reference.channels ||
            Math.abs(candidate.duration - reference.duration) >
              Math.max(0.05, 2 / reference.sampleRate)
        )
      ) {
        throw new Error("stem group sample rate, channels, or duration disagree");
      }
      const created: string[] = [];
      try {
        for (const candidate of candidates) {
          copyExclusive(candidate.incoming, candidate.destination);
          created.push(candidate.destination);
        }
      } catch (error) {
        for (const destination of created) {
          try {
            fs.rmSync(destination);
          } catch {
            // The manifest is unchanged, so failed output is never advertised.
          }
        }
        throw error;
      }
      for (const candidate of candidates) {
        const returnedTag = ensureTrackable(candidate.incoming);
        const publishedTag = createTrackableCopyIdentity(candidate.destination);
        appendRoundupLineage({
          sourcePath: candidate.incoming,
          outputPath: candidate.destination,
          sourceTagId: returnedTag?.id,
          outputTagId: publishedTag?.id,
          ...(candidate.stem.clipId ? { clipId: candidate.stem.clipId } : {}),
          packageId: stored.packageId,
        });
        candidate.stem.path = candidate.destination;
        candidate.stem.airTagId = publishedTag?.id ?? null;
        candidate.stem.status = "included";
        candidate.stem.validation = {
          durationSeconds: candidate.duration,
          sampleRate: candidate.sampleRate,
          channels: candidate.channels,
          alignmentToleranceSeconds: Math.max(
            0.05,
            2 / candidate.sampleRate
          ),
        };
        candidate.stem.alignment = clip
          ? "Validated complete returned group: clip time 0 and duration match the selected clip boundary."
          : "Validated complete returned group: source time 0 and duration match the full source.";
        published += 1;
      }
    } catch (error) {
      rejected.push(
        `${groupId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  refreshUniversalPackageArtifacts(folder, stored);
  return {
    published,
    remaining: allStems.filter((stem) => stem.status === "planned").length,
    rejected,
  };
}

export const universalClipperTestHelpers = {
  allocatePackageDir,
  existingFileWithin,
  safePackageName,
};
