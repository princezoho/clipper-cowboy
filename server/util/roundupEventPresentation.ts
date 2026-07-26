import path from "node:path";

export type RoundupEventClassification =
  | "renamed_and_moved"
  | "renamed"
  | "moved"
  | "derived_copy"
  | "unknown";

export interface RoundupEventPresentation {
  classification: RoundupEventClassification;
  oldName: string | null;
  newName: string | null;
  oldFolder: string | null;
  newFolder: string | null;
  nameChanged: boolean;
  folderChanged: boolean;
  extensionChanged: boolean;
}

export interface RoundupEventLike {
  oldPath?: unknown;
  newPath?: unknown;
  oldName?: unknown;
  newName?: unknown;
  kind?: unknown;
  relation?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value.normalize("NFC")
    : null;
}

function pathPart(value: unknown, part: "name" | "folder"): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  return (part === "name" ? path.basename(candidate) : path.dirname(candidate)).normalize(
    "NFC"
  );
}

/**
 * Classify a life-history edge without assuming that all historical JSONL
 * records contain the newer convenience fields.
 *
 * Comparisons are Unicode-normalized but intentionally case-sensitive:
 * default macOS volumes are usually case-insensitive while still preserving
 * case, so `take.mov` → `TAKE.mov` is a meaningful rename to show the user.
 */
export function presentRoundupEvent(
  event: RoundupEventLike
): RoundupEventPresentation {
  const oldPath = text(event.oldPath);
  const newPath = text(event.newPath);
  const oldName = text(event.oldName) ?? pathPart(oldPath, "name");
  const newName = text(event.newName) ?? pathPart(newPath, "name");
  const oldFolder = pathPart(oldPath, "folder");
  const newFolder = pathPart(newPath, "folder");

  const nameChanged =
    oldName !== null && newName !== null ? oldName !== newName : false;
  const folderChanged =
    oldFolder !== null && newFolder !== null ? oldFolder !== newFolder : false;
  const extensionChanged =
    oldName !== null && newName !== null
      ? path.extname(oldName) !== path.extname(newName)
      : false;

  const relation = text(event.relation);
  const kind = text(event.kind);
  let classification: RoundupEventClassification;
  if (
    relation === "derived-copy" ||
    relation === "derived_copy" ||
    kind === "derived_copy"
  ) {
    classification = "derived_copy";
  } else if (nameChanged && folderChanged) {
    classification = "renamed_and_moved";
  } else if (nameChanged) {
    classification = "renamed";
  } else if (folderChanged) {
    classification = "moved";
  } else {
    classification = "unknown";
  }

  return {
    classification,
    oldName,
    newName,
    oldFolder,
    newFolder,
    nameChanged,
    folderChanged,
    extensionChanged,
  };
}
