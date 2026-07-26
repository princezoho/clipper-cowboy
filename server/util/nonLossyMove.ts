import fs from "node:fs";
import path from "node:path";
import { redactErrorMessage } from "./publicError.js";

/**
 * Move a regular file without ever replacing an existing destination.
 *
 * The destination is created atomically with link(2) when possible. Across
 * filesystems, COPYFILE_EXCL preserves the same no-overwrite guarantee. The
 * source is removed only after the destination has the expected byte length.
 */
export function moveFileNoReplace(source: string, destination: string): void {
  const before = fs.lstatSync(source);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("move source must be a regular non-symlink file");
  }

  try {
    fs.linkSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EXDEV", "EPERM", "EACCES", "ENOSYS", "EMLINK"].includes(code ?? "")) {
      throw error;
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }

  const copied = fs.statSync(destination);
  if (!copied.isFile() || copied.size !== before.size) {
    // Callers surface this message to the browser, so name the files only.
    throw new Error(
      `move verification failed; both paths were retained: ${path.basename(source)} -> ${path.basename(destination)}`
    );
  }

  try {
    fs.unlinkSync(source);
  } catch (error) {
    throw new Error(
      `move copied safely but could not remove the source; both paths were retained: ${redactErrorMessage(error)}`
    );
  }
}
