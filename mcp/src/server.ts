import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveConfig, rootLooksValid, type McpConfig } from "./config.js";
import { JobRegistry } from "./jobs.js";
import {
  ID_RE,
  PublicError,
  makeRedactor,
  requireContainedFile,
  requireId,
  safeStemOutputDir,
} from "./security.js";
import { ClipperService, type Health } from "./service.js";

const VERSION = "0.1.0";
const MAX_LIMIT = 200;

interface PoolItem {
  id: string;
  filename: string;
  path: string;
  folder: string;
  size: number;
  mtime: number;
  duration: number;
  clipCount: number;
}

interface LibraryItem {
  id: string;
  name: string;
  description: string;
  tags: string[];
  characters?: NamedRef[];
  scenes?: NamedRef[];
  objects?: NamedRef[];
  filename: string;
  path: string;
  sourceId?: string;
  source?: string;
  in?: number;
  out?: number;
  duration?: number;
  exportMode?: string;
  created: number;
  missing?: boolean;
}

interface NamedRef {
  id: string;
  name: string;
  description?: string;
}

interface CatalogResponse {
  items: NamedRef[];
}

interface PoolResponse {
  items: unknown[];
  poolDir: string;
}

interface LibraryResponse {
  items: unknown[];
  libraryDir: string;
  missingCount: number;
  orphans: unknown[];
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface ServerBundle {
  server: McpServer;
  service: ClipperService;
  jobs: JobRegistry;
  config: McpConfig;
}

export interface ServerDependencies {
  service?: ClipperService;
  jobs?: JobRegistry;
  moduleUrl?: string;
}

function ok(data: unknown, redact: (value: unknown) => string): ToolResult {
  return { content: [{ type: "text", text: redact(JSON.stringify(data, null, 2)) }] };
}

function failure(error: unknown, redact: (value: unknown) => string): ToolResult {
  const publicError = error instanceof PublicError
    ? error
    : new PublicError("INTERNAL_ERROR", redact(error));
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: {
          code: publicError.code,
          message: redact(publicError.message).slice(0, 2_000),
          ...(publicError.remediation ? { remediation: redact(publicError.remediation).slice(0, 2_000) } : {}),
        },
      }, null, 2),
    }],
    isError: true,
  };
}

function page<T>(items: T[], offset: number, limit: number) {
  return {
    total: items.length,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}

function normalizeRefs(items: unknown[]): NamedRef[] {
  return items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.id === "string" && ID_RE.test(item.id) && typeof item.name === "string")
    .map((item) => ({
      id: item.id as string,
      name: (item.name as string).slice(0, 200),
      ...(typeof item.description === "string"
        ? { description: item.description.slice(0, 2_000) }
        : {}),
    }));
}

function normalizeLibraryItem(value: unknown): LibraryItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" || !ID_RE.test(item.id) ||
    typeof item.name !== "string" || typeof item.filename !== "string" ||
    typeof item.path !== "string"
  ) return null;
  const refList = (candidate: unknown) => normalizeRefs(Array.isArray(candidate) ? candidate : []);
  return {
    id: item.id,
    name: item.name.slice(0, 120),
    description: typeof item.description === "string" ? item.description.slice(0, 5_000) : "",
    tags: Array.isArray(item.tags)
      ? item.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 50)
      : [],
    characters: refList(item.characters),
    scenes: refList(item.scenes),
    objects: refList(item.objects),
    filename: item.filename,
    path: item.path,
    sourceId: typeof item.sourceId === "string" ? item.sourceId : undefined,
    source: typeof item.source === "string" ? item.source : undefined,
    in: typeof item.in === "number" && Number.isFinite(item.in) ? item.in : undefined,
    out: typeof item.out === "number" && Number.isFinite(item.out) ? item.out : undefined,
    duration: typeof item.duration === "number" && Number.isFinite(item.duration) ? item.duration : undefined,
    exportMode: typeof item.exportMode === "string" ? item.exportMode : undefined,
    created: typeof item.created === "number" && Number.isFinite(item.created) ? item.created : 0,
    missing: item.missing === true,
  };
}

function normalizePoolItem(value: unknown): PoolItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" || !ID_RE.test(item.id) ||
    typeof item.filename !== "string" || typeof item.path !== "string"
  ) return null;
  const finite = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  return {
    id: item.id,
    filename: item.filename,
    path: item.path,
    folder: typeof item.folder === "string" ? item.folder : "",
    size: finite(item.size),
    mtime: finite(item.mtime),
    duration: finite(item.duration),
    clipCount: finite(item.clipCount),
  };
}

async function loadCatalogs(service: ClipperService) {
  const [characters, scenes, objects] = await Promise.all([
    service.request<CatalogResponse>("/api/characters"),
    service.request<CatalogResponse>("/api/scenes"),
    service.request<CatalogResponse>("/api/objects"),
  ]);
  return {
    characters: normalizeRefs(Array.isArray(characters.items) ? characters.items : []),
    scenes: normalizeRefs(Array.isArray(scenes.items) ? scenes.items : []),
    objects: normalizeRefs(Array.isArray(objects.items) ? objects.items : []),
  };
}

function refsForIds(ids: string[] | undefined, catalog: NamedRef[], label: string): NamedRef[] | undefined {
  if (ids === undefined) return undefined;
  const byId = new Map(catalog.map((item) => [item.id, item]));
  return ids.map((id) => {
    requireId(id, `${label}_id`);
    const item = byId.get(id);
    if (!item) {
      throw new PublicError(
        "CATALOG_ITEM_NOT_FOUND",
        `Unknown ${label} ID: ${id}`,
        "Call list_metadata_catalogs to obtain current IDs."
      );
    }
    return { id: item.id, name: item.name };
  });
}

async function safeSources(service: ClipperService): Promise<{ health: Health; items: PoolItem[]; rejected: number }> {
  const health = await service.ensure();
  const response = await service.request<PoolResponse>("/api/pool");
  const items: PoolItem[] = [];
  let rejected = 0;
  for (const raw of Array.isArray(response.items) ? response.items : []) {
    const item = normalizePoolItem(raw);
    if (!item) {
      rejected += 1;
      continue;
    }
    try {
      requireId(item.id, "source_id");
      const safePath = requireContainedFile(health.projectDir, item.path);
      items.push({ ...item, path: safePath });
    } catch {
      rejected += 1;
    }
  }
  return { health, items, rejected };
}

async function safeClips(service: ClipperService): Promise<{ health: Health; response: LibraryResponse; items: Array<LibraryItem & { safePath?: string }>; rejected: number }> {
  const health = await service.ensure();
  const rawResponse = await service.request<LibraryResponse>("/api/library");
  const response: LibraryResponse = {
    items: Array.isArray(rawResponse.items) ? rawResponse.items : [],
    libraryDir: typeof rawResponse.libraryDir === "string" ? rawResponse.libraryDir : health.clipsDir,
    missingCount: typeof rawResponse.missingCount === "number" && Number.isFinite(rawResponse.missingCount)
      ? rawResponse.missingCount
      : 0,
    orphans: Array.isArray(rawResponse.orphans) ? rawResponse.orphans : [],
  };
  const items: Array<LibraryItem & { safePath?: string }> = [];
  let rejected = 0;
  for (const raw of Array.isArray(response.items) ? response.items : []) {
    const item = normalizeLibraryItem(raw);
    if (!item) {
      rejected += 1;
      continue;
    }
    try {
      requireId(item.id, "clip_id");
      if (item.missing || !fs.existsSync(item.path)) {
        items.push({ ...item, missing: true });
        continue;
      }
      items.push({ ...item, safePath: requireContainedFile(health.clipsDir, item.path) });
    } catch {
      rejected += 1;
    }
  }
  return { health, response, items, rejected };
}

function publicSource(item: PoolItem) {
  return {
    source_id: item.id,
    filename: item.filename,
    input_path: item.path,
    folder: item.folder,
    size_bytes: item.size,
    modified_at: item.mtime,
    duration_seconds: item.duration,
    exported_clip_count: item.clipCount,
  };
}

function publicClip(item: LibraryItem & { safePath?: string }) {
  return {
    clip_id: item.id,
    name: item.name,
    filename: item.filename,
    output_path: item.safePath ?? null,
    missing: Boolean(item.missing || !item.safePath),
    source_id: item.sourceId,
    source_filename: item.source,
    in_seconds: item.in,
    out_seconds: item.out,
    duration_seconds: item.duration,
    description: item.description,
    tags: item.tags,
    characters: item.characters ?? [],
    scenes: item.scenes ?? [],
    objects: item.objects ?? [],
    export_mode: item.exportMode,
    created_at: item.created,
  };
}

export function createServer(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ServerDependencies = {}
): ServerBundle {
  const config = resolveConfig(env, dependencies.moduleUrl ?? import.meta.url);
  const redact = makeRedactor(env);
  const safeOk = (data: unknown) => ok(data, redact);
  const service = dependencies.service ?? new ClipperService(config, env, redact);
  const jobs = dependencies.jobs ?? new JobRegistry(redact);
  const server = new McpServer({ name: "clipper-cowboy", version: VERSION });
  type ToolExtra = {
    sendNotification: (notification: unknown) => Promise<void>;
    _meta?: { progressToken?: string | number };
  };
  const notifyProgress = (
    extra: ToolExtra,
    progress: number,
    message: string
  ) => {
    const token = extra._meta?.progressToken;
    if (token === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total: 100, message },
    }).catch(() => {});
  };

  server.registerTool("setup_status", {
    title: "Check Clipper Cowboy readiness",
    description:
      "Read-only readiness check for the repository, Node runtime, dependencies, " +
      "configured project, local service, and optional OpenAI capability. It never " +
      "reads or returns an API key and does not start the service or create folders.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => {
    try {
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      const rootValid = rootLooksValid(config.rootDir);
      const dependenciesInstalled = fs.existsSync(path.join(config.rootDir, "node_modules", "tsx", "package.json"));
      const uiBuilt = fs.existsSync(path.join(config.rootDir, "dist", "index.html"));
      const mcpBuilt = fs.existsSync(path.join(config.rootDir, "mcp", "dist", "index.js"));
      let projectExists: boolean | null = null;
      let projectWritable: boolean | null = null;
      if (config.projectDir) {
        projectExists = fs.existsSync(config.projectDir) && fs.statSync(config.projectDir).isDirectory();
        if (projectExists) {
          try {
            fs.accessSync(config.projectDir, fs.constants.R_OK | fs.constants.W_OK);
            projectWritable = true;
          } catch {
            projectWritable = false;
          }
        } else {
          projectWritable = false;
        }
      }
      let health: Health | null = null;
      let serviceError: string | undefined;
      try {
        health = await service.status();
      } catch (error) {
        serviceError = redact(error);
      }
      const ready = nodeMajor >= 20 && rootValid && dependenciesInstalled && mcpBuilt &&
        (config.projectDir ? projectExists === true && projectWritable === true : true);
      return safeOk({
        ready,
        node: { version: process.versions.node, supported: nodeMajor >= 20 },
        repository: {
          root_dir: config.rootDir,
          valid: rootValid,
          dependencies_installed: dependenciesInstalled,
          ui_built: uiBuilt,
          mcp_built: mcpBuilt,
        },
        project: {
          configured_for_mcp: Boolean(config.projectDir),
          project_dir: health?.projectDir ?? config.projectDir ?? null,
          exists: config.projectDir ? projectExists : null,
          writable: config.projectDir ? projectWritable : null,
        },
        service: {
          online: Boolean(health),
          url: config.serviceUrl,
          auto_start: config.autoStart,
          ...(serviceError ? { warning: serviceError } : {}),
        },
        ai: { openai_configured: health ? health.hasOpenAIKey : null },
        next_step: ready
          ? "Call project_summary or list_sources. The local service will start automatically if needed."
          : !rootValid
            ? "Correct CLIPPER_ROOT so it points to the Clipper Cowboy repository."
            : "Run setup_environment with confirm_install:true, or npm run setup from the repository root.",
      });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("setup_environment", {
    title: "Install and build Clipper Cowboy",
    description:
      "Install repository dependencies and build the UI using fixed npm commands. " +
      "Set create_project_dir:true only to create the configured CLIPPER_PROJECT_DIR. " +
      "No API key is accepted or changed. With wait:false, poll check_job.",
    inputSchema: {
      confirm_install: z.boolean().describe("Must be true: npm ci will replace node_modules from the lockfile and run package install scripts."),
      create_project_dir: z.boolean().optional().describe("Create CLIPPER_PROJECT_DIR if missing. Default false."),
      wait: z.boolean().optional().describe("Wait for completion (default true); false returns a job_id."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (input, extra) => {
    try {
      if (input.confirm_install !== true) {
        throw new PublicError(
          "INSTALL_CONFIRMATION_REQUIRED",
          "setup_environment runs npm ci and package install scripts. Explicit confirmation is required."
        );
      }
      const wait = input.wait ?? true;
      const job = jobs.start("setup", (update) => service.setup(
        input.create_project_dir ?? false,
        (stage, percent, detail) => {
          update(stage, percent, detail);
          if (wait) notifyProgress(extra as unknown as ToolExtra, percent, detail ?? stage);
        }
      ));
      if (!wait) return safeOk({ job_id: job.job_id, status: "queued", next_tool: "check_job" });
      const result = await job.result;
      return safeOk({ job_id: job.job_id, status: "done", result });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("project_summary", {
    title: "Summarize the active Clipper project",
    description:
      "Start or attach to the verified local Clipper service and summarize its project, " +
      "source and clip counts, catalog paths, missing media, and optional AI readiness.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => {
    try {
      const [sources, clips] = await Promise.all([safeSources(service), safeClips(service)]);
      const health = sources.health;
      return safeOk({
        service_url: config.serviceUrl,
        project_dir: health.projectDir,
        clips_dir: health.clipsDir,
        stems_dir: health.stemsDir,
        shotlist_md: health.shotlistMd,
        shotlist_csv: health.shotlistCsv,
        source_count: sources.items.length,
        clip_count: clips.items.length,
        missing_clip_count: clips.response.missingCount,
        rejected_unsafe_catalog_entries: sources.rejected + clips.rejected,
        openai_configured: health.hasOpenAIKey,
      });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("list_sources", {
    title: "List source videos",
    description:
      "List safe source videos in the active project. Returns stable source IDs and " +
      "absolute local input paths. Paths are canonicalized and symlink escapes rejected.",
    inputSchema: {
      query: z.string().max(200).optional(),
      folder: z.string().max(500).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try {
      const loaded = await safeSources(service);
      const query = input.query?.trim().toLowerCase();
      const folder = input.folder?.trim().replace(/^\/+|\/+$/g, "");
      const filtered = loaded.items.filter((item) => {
        if (folder !== undefined && item.folder !== folder) return false;
        return !query || `${item.filename} ${item.folder}`.toLowerCase().includes(query);
      });
      return safeOk({
        ...page(filtered.map(publicSource), input.offset ?? 0, input.limit ?? 50),
        rejected_unsafe_entries: loaded.rejected,
      });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("get_source", {
    title: "Inspect one source video",
    description:
      "Return one source's canonical path, exact duration, saved source metadata, and " +
      "already-exported ranges. Call list_sources first to obtain source_id.",
    inputSchema: { source_id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ source_id }) => {
    try {
      requireId(source_id, "source_id");
      const loaded = await safeSources(service);
      const source = loaded.items.find((item) => item.id === source_id);
      if (!source) throw new PublicError("SOURCE_NOT_FOUND", "No source exists with that ID.", "Call list_sources first.");
      const [duration, metadata, clips] = await Promise.all([
        service.request<{ duration: number }>(`/api/pool/duration/${source_id}`),
        service.request<unknown>(`/api/pool/${source_id}/meta`),
        service.request<{ items: unknown[] }>(`/api/pool/${source_id}/clips`),
      ]);
      return safeOk({
        ...publicSource({ ...source, duration: duration.duration }),
        metadata,
        exported_ranges: clips.items,
      });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("list_clips", {
    title: "Search exported clips",
    description:
      "Search the Clipper library by text, source ID, or tags. Returns canonical local " +
      "output paths suitable for Clipper Cowboy's managed audio splitting. Unsafe sidecar paths are rejected.",
    inputSchema: {
      query: z.string().max(200).optional(),
      source_id: z.string().optional(),
      tags: z.array(z.string().min(1).max(120)).max(20).optional(),
      include_missing: z.boolean().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try {
      if (input.source_id) requireId(input.source_id, "source_id");
      const loaded = await safeClips(service);
      const query = input.query?.trim().toLowerCase();
      const tags = input.tags?.map((tag) => tag.toLowerCase());
      const filtered = loaded.items.filter((item) => {
        if (!input.include_missing && (item.missing || !item.safePath)) return false;
        if (input.source_id && item.sourceId !== input.source_id) return false;
        if (query && !`${item.name} ${item.filename} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(query)) return false;
        if (tags && !tags.every((tag) => item.tags.some((existing) => existing.toLowerCase() === tag))) return false;
        return true;
      });
      return safeOk({
        ...page(filtered.map(publicClip), input.offset ?? 0, input.limit ?? 50),
        missing_count: loaded.response.missingCount,
        rejected_unsafe_entries: loaded.rejected,
      });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("get_clip", {
    title: "Inspect one exported clip",
    description: "Return full safe metadata and the canonical output path for one clip ID.",
    inputSchema: { clip_id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ clip_id }) => {
    try {
      requireId(clip_id, "clip_id");
      const loaded = await safeClips(service);
      const clip = loaded.items.find((item) => item.id === clip_id);
      if (!clip) throw new PublicError("CLIP_NOT_FOUND", "No clip exists with that ID.", "Call list_clips first.");
      return safeOk(publicClip(clip));
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("list_metadata_catalogs", {
    title: "List character, scene, and object IDs",
    description:
      "Return the canonical metadata catalogs used by export_clip and update_clip_metadata. " +
      "Use these IDs rather than inventing names in mutation tools.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => {
    try {
      return safeOk(await loadCatalogs(service));
    } catch (error) {
      return failure(error, redact);
    }
  });

  const idArray = z.array(z.string()).max(50).optional();
  const tagsArray = z.array(z.string().trim().min(1).max(120)).max(50).optional();

  server.registerTool("export_clip", {
    title: "Export a precise clip",
    description:
      "Smart-cut a time range from a catalogued source into PROJECT_DIR/clips and persist " +
      "its metadata. Accepts IDs only—no arbitrary paths or output directory. Returns the " +
      "actual collision-safe output path and suggested managed-audio directory. Runtime ranges " +
      "from seconds to minutes. wait:false returns a job_id for check_job.",
    inputSchema: {
      source_id: z.string(),
      in_seconds: z.number().min(0),
      out_seconds: z.number().positive(),
      name: z.string().trim().min(1).max(120),
      description: z.string().max(5_000).optional(),
      tags: tagsArray,
      character_ids: idArray,
      scene_ids: idArray,
      object_ids: idArray,
      wait: z.boolean().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (input, extra) => {
    try {
      requireId(input.source_id, "source_id");
      if (input.out_seconds - input.in_seconds < 0.1) {
        throw new PublicError("RANGE_TOO_SHORT", "The export range must be at least 0.1 seconds.");
      }
      const loaded = await safeSources(service);
      if (!loaded.items.some((item) => item.id === input.source_id)) {
        throw new PublicError("SOURCE_NOT_FOUND", "No source exists with that ID.", "Call list_sources first.");
      }
      const catalogs = await loadCatalogs(service);
      const body = {
        sourceId: input.source_id,
        in: input.in_seconds,
        out: input.out_seconds,
        name: input.name.trim(),
        description: input.description?.trim() ?? "",
        tags: input.tags ?? [],
        characters: refsForIds(input.character_ids, catalogs.characters, "character") ?? [],
        scenes: refsForIds(input.scene_ids, catalogs.scenes, "scene") ?? [],
        objects: refsForIds(input.object_ids, catalogs.objects, "object") ?? [],
        mode: "clip",
      };
      const job = jobs.start("export", async (update) => {
        const report = (stage: string, percent: number, detail: string) => {
          update(stage, percent, detail);
          if (input.wait ?? true) notifyProgress(extra as unknown as ToolExtra, percent, detail);
        };
        report("exporting", 10, "Smart-cutting source media");
        const rawResult = await service.request<unknown>("/api/export", {
          method: "POST",
          body: JSON.stringify(body),
        }, 6 * 60 * 60 * 1000);
        const result = normalizeLibraryItem(rawResult);
        if (!result) throw new PublicError("INVALID_RESPONSE", "Clipper Cowboy returned invalid export metadata.");
        const outputPath = requireContainedFile(loaded.health.clipsDir, result.path);
        report("cataloguing", 95, "Writing clip metadata and shotlist");
        return {
          clip: publicClip({ ...result, safePath: outputPath }),
          handoff: {
            input_path: outputPath,
            suggested_stem_output_dir: safeStemOutputDir(
              loaded.health.stemsDir,
              outputPath,
              result.id
            ),
            next_tool: "clipper.audio_splitting",
          },
        };
      });
      if (!(input.wait ?? true)) return safeOk({ job_id: job.job_id, status: "queued", next_tool: "check_job" });
      const result = await job.result;
      return safeOk({ job_id: job.job_id, status: "done", result });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("update_clip_metadata", {
    title: "Update clip metadata",
    description:
      "Update descriptive metadata for an existing clip ID. This does not rename, move, " +
      "delete, or re-export the media file. Catalog references must use IDs from list_metadata_catalogs.",
    inputSchema: {
      clip_id: z.string(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(5_000).optional(),
      tags: tagsArray,
      character_ids: idArray,
      scene_ids: idArray,
      object_ids: idArray,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try {
      requireId(input.clip_id, "clip_id");
      const loaded = await safeClips(service);
      if (!loaded.items.some((item) => item.id === input.clip_id)) {
        throw new PublicError("CLIP_NOT_FOUND", "No clip exists with that ID.", "Call list_clips first.");
      }
      const catalogs = await loadCatalogs(service);
      const patch = {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.character_ids !== undefined ? { characters: refsForIds(input.character_ids, catalogs.characters, "character") } : {}),
        ...(input.scene_ids !== undefined ? { scenes: refsForIds(input.scene_ids, catalogs.scenes, "scene") } : {}),
        ...(input.object_ids !== undefined ? { objects: refsForIds(input.object_ids, catalogs.objects, "object") } : {}),
      };
      if (Object.keys(patch).length === 0) {
        throw new PublicError("EMPTY_PATCH", "Provide at least one metadata field to update.");
      }
      const rawResult = await service.request<unknown>(`/api/library/${input.clip_id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      const result = normalizeLibraryItem(rawResult);
      if (!result) throw new PublicError("INVALID_RESPONSE", "Clipper Cowboy returned invalid clip metadata.");
      const safePath = result.missing || !fs.existsSync(result.path)
        ? undefined
        : requireContainedFile(loaded.health.clipsDir, result.path);
      return safeOk(publicClip({ ...result, safePath }));
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("analyze_source_with_openai", {
    title: "Analyze a source with OpenAI vision",
    description:
      "Sample frames from one catalogued source and upload those frames to OpenAI for tags, " +
      "mood, character, scene, and object suggestions. This crosses the local-only boundary. " +
      "The caller must set confirm_external_upload:true. No key is accepted or returned; the " +
      "server uses its own ignored local configuration. wait:false returns a job_id.",
    inputSchema: {
      source_id: z.string(),
      confirm_external_upload: z.boolean(),
      force: z.boolean().optional(),
      wait: z.boolean().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (input, extra) => {
    try {
      requireId(input.source_id, "source_id");
      if (input.confirm_external_upload !== true) {
        throw new PublicError(
          "UPLOAD_CONFIRMATION_REQUIRED",
          "OpenAI analysis uploads sampled video frames. Explicit confirmation is required."
        );
      }
      const loaded = await safeSources(service);
      if (!loaded.items.some((item) => item.id === input.source_id)) {
        throw new PublicError("SOURCE_NOT_FOUND", "No source exists with that ID.", "Call list_sources first.");
      }
      if (!loaded.health.hasOpenAIKey) {
        throw new PublicError(
          "OPENAI_NOT_CONFIGURED",
          "OpenAI analysis is not configured.",
          "Add your own key locally through Clipper Cowboy Settings; never pass it to this tool."
        );
      }
      const job = jobs.start("analyze", async (update) => {
        const report = (stage: string, percent: number, detail: string) => {
          update(stage, percent, detail);
          if (input.wait ?? true) notifyProgress(extra as unknown as ToolExtra, percent, detail);
        };
        report("sampling", 10, "Extracting representative frames");
        const result = await service.request<unknown>(`/api/pool/${input.source_id}/analyze`, {
          method: "POST",
          body: JSON.stringify({ force: input.force ?? false }),
        }, 60 * 60 * 1000);
        report("saving", 95, "Saving source metadata");
        return { source_id: input.source_id, metadata: result };
      });
      if (!(input.wait ?? true)) return safeOk({ job_id: job.job_id, status: "queued", next_tool: "check_job" });
      const result = await job.result;
      return safeOk({ job_id: job.job_id, status: "done", result });
    } catch (error) {
      return failure(error, redact);
    }
  });

  server.registerTool("check_job", {
    title: "Check a background Clipper job",
    description:
      "Return queued/running/done/error state, stage, percent, and terminal result for " +
      "setup, export, or OpenAI analysis started with wait:false. Completed jobs expire after one hour.",
    inputSchema: { job_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ job_id }) => {
    try {
      const snapshot = jobs.snapshot(job_id);
      if (!snapshot) throw new PublicError("JOB_NOT_FOUND", "Unknown or expired job_id.");
      return safeOk(snapshot);
    } catch (error) {
      return failure(error, redact);
    }
  });

  return { server, service, jobs, config };
}
