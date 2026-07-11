import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export interface StemStudioInstallation {
  root: string;
}

export interface StemStudioCandidate {
  id: string;
}

function packageName(file: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export function validateStemStudioInstallation(
  selected: string
): StemStudioInstallation {
  const root = fs.realpathSync(selected);
  if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
  if (
    packageName(path.join(root, "package.json")) !== "stem-studio" ||
    packageName(path.join(root, "mcp", "package.json")) !== "stem-studio-mcp"
  ) {
    throw new Error("missing package markers");
  }
  return { root };
}

export function stemStudioFolderMessage(selected: string): string {
  try {
    const root = path.resolve(selected);
    if (validateSilently(path.join(root, "stem-studio"))) {
      return "Choose the Stem Studio folder itself, not the folder above it.";
    }
    if (path.basename(root) === "mcp" && validateSilently(path.dirname(root))) {
      return "Choose the Stem Studio folder, not its mcp folder.";
    }
  } catch {
    // Fall through to the safe, actionable default.
  }
  return "Choose the Stem Studio folder—the one containing package.json and an mcp folder.";
}

function validateSilently(root: string): boolean {
  try {
    validateStemStudioInstallation(root);
    return true;
  } catch {
    return false;
  }
}

function discoveryRoots(): string[] {
  const home = os.homedir();
  return [
    config.stemStudioRoot,
    path.join(home, "Desktop", "stem-studio"),
    path.join(home, "Documents", "stem-studio"),
    path.join(home, "Projects", "stem-studio"),
    path.join(home, "Developer", "stem-studio"),
  ].filter((value): value is string => Boolean(value));
}

function discoveredRoots(): string[] {
  const roots = new Set<string>();
  for (const candidate of discoveryRoots()) {
    try {
      roots.add(validateStemStudioInstallation(candidate).root);
    } catch {
      // Discovery only reports trusted installations.
    }
  }
  return [...roots];
}

const discoveredCandidates = new Map<string, string>();

export function discoverStemStudioInstallations(): StemStudioCandidate[] {
  discoveredCandidates.clear();
  return discoveredRoots().map((root) => {
    const id = `candidate-${randomUUID()}`;
    discoveredCandidates.set(id, root);
    return { id };
  });
}

export function getDiscoveredStemStudioInstallation(
  id: string
): StemStudioInstallation | undefined {
  const root = discoveredCandidates.get(id);
  if (!root) return undefined;
  try {
    return validateStemStudioInstallation(root);
  } catch {
    return undefined;
  }
}
