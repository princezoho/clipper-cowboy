import { cleanSuppressedTagsInSidecars, migrateLegacyLibrary } from "./migrate.js";
import { rebuildShotlistNow } from "./shotlist.js";

/**
 * The one-shot work a project folder needs before it is served: legacy library
 * migration, sidecar tag cleanup, and a fresh shotlist.
 *
 * Both boot and the first-run wizard's in-process reload call this, so adopting
 * a folder without restarting leaves it in the same state a restart would. Each
 * step is independently idempotent and independently non-fatal.
 */
export function bootstrapProjectDir(): void {
  try {
    migrateLegacyLibrary();
  } catch (err) {
    console.error("[migrate] failed:", err);
  }
  try {
    cleanSuppressedTagsInSidecars();
  } catch (err) {
    console.error("[migrate] tag cleanup failed:", err);
  }
  try {
    rebuildShotlistNow();
  } catch (err) {
    console.error("[shotlist] rebuild failed:", err);
  }
}
