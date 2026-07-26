import fs from "node:fs";
import path from "node:path";
import { config, onConfigReload } from "../config.js";

/*
 * Append-only session activity log. One JSON event per line, written to
 * `<projectDir>/.clipcataloger/activity.log.jsonl`. Survives restarts; never
 * rewritten, never compacted. Reads tail-only on demand for the header
 * popover. Errors on write are swallowed — a logging failure must never
 * break the underlying mutation path.
 */

export type ActivityKind =
  | "clip_exported"
  | "clip_reexported"
  | "clip_deleted"
  | "clip_restored"
  | "scene_created"
  | "scene_deleted"
  | "character_created"
  | "character_deleted"
  | "object_created"
  | "object_deleted"
  | "collection_exported"
  | "missing_repaired"
  | "orphans_adopted"
  | "orphans_trashed"
  | "clips_copied"
  | "clip_renamed"
  | "clips_sent_to_premiere"
  | "source_analyzed"
  | "source_batch_started"
  | "pool_source_moved"
  | "pool_organize_analyzed"
  | "universal_package_created"
  | "sample_project_loaded"
  | "stems_queued"
  | "stems_completed"
  | "stems_failed";

export interface ActivityEvent {
  ts: number;
  kind: ActivityKind;
  payload: Record<string, unknown>;
}

// `let`, not `const`: derived from the project folder, which the first-run
// wizard can change while the process is running. See onConfigReload below.
let ACTIVITY_PATH = path.join(config.internalDir, "activity.log.jsonl");

export function appendActivity(
  kind: ActivityKind,
  payload: Record<string, unknown>
): void {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_PATH), { recursive: true });
    const event: ActivityEvent = { ts: Date.now(), kind, payload };
    fs.appendFileSync(ACTIVITY_PATH, JSON.stringify(event) + "\n");
  } catch {
    // Intentionally swallow — activity logging is a side observation,
    // never a hard dependency of the caller.
  }
}

export async function readActivityTail(limit: number): Promise<ActivityEvent[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  let raw = "";
  try {
    raw = await fs.promises.readFile(ACTIVITY_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(Math.max(0, lines.length - n));
  const events: ActivityEvent[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as ActivityEvent;
      if (
        parsed &&
        typeof parsed.ts === "number" &&
        typeof parsed.kind === "string"
      ) {
        events.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  events.reverse(); // newest first
  return events;
}

export let ACTIVITY_LOG_PATH = ACTIVITY_PATH;

onConfigReload({
  apply: () => {
    ACTIVITY_PATH = path.join(config.internalDir, "activity.log.jsonl");
    ACTIVITY_LOG_PATH = ACTIVITY_PATH;
  },
});
