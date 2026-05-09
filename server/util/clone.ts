import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Copy a file with maximum disk efficiency on macOS APFS:
 *   1. `cp -c` uses `clonefile(2)` → instant, zero data written, copy-on-write.
 *      The clone is fully independent: deleting the source leaves the clone intact.
 *   2. If `cp -c` is unavailable or fails (non-APFS volume, cross-volume copy),
 *      fall back to a regular byte-for-byte copy via Node.
 *
 * Returns the kind of copy that actually happened, useful for logging.
 */
export async function cloneOrCopy(
  source: string,
  dest: string
): Promise<"clone" | "copy"> {
  try {
    await runCp(["-c", "-f", source, dest]);
    return "clone";
  } catch {
    fs.copyFileSync(source, dest);
    return "copy";
  }
}

function runCp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cp ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });
}
