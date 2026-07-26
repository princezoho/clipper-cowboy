import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, onConfigReload } from "../config.js";
import {
  validateStemMcpEntry,
  type StemMcpConfig,
} from "./mcpClient.js";

// `let`, not `const`: both are project-local, and the first-run wizard can
// change the project folder while the process is running. Callers reach them
// through default parameters, which re-read the binding on every call.
let SETTINGS_PATH = path.join(config.internalDir, "integrations.json");
let VERIFICATION_PATH = path.join(
  config.internalDir,
  "stem-runtime-verification.json"
);
const MAX_SETTINGS_BYTES = 64 * 1024;

interface IntegrationSettings {
  schemaVersion: 1;
  stemStudioMcpEntry?: string;
}

interface RuntimeVerification {
  schemaVersion: 1;
  entry: string;
  entryVersion: string | null;
  quality: "high";
  verifiedAt: string;
  generatedFixture: true;
  sourcePreserved: true;
  outputsValidated: true;
}

export interface ResolvedStemMcpConfiguration {
  config: StemMcpConfig | null;
  source: "settings" | "environment" | null;
  issue?: string;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > MAX_SETTINGS_BYTES
    ) {
      return null;
    }
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readSettings(file = SETTINGS_PATH): IntegrationSettings {
  const value = readJsonObject(file);
  if (value?.schemaVersion !== 1) return { schemaVersion: 1 };
  return {
    schemaVersion: 1,
    ...(typeof value.stemStudioMcpEntry === "string"
      ? { stemStudioMcpEntry: value.stemStudioMcpEntry }
      : {}),
  };
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Refusing to replace unsafe integration settings.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temp);
    } catch {
      // Best effort cleanup; the authoritative settings file was unchanged.
    }
    throw error;
  }
}

export function resolveConfiguredStemMcp(
  env: NodeJS.ProcessEnv = process.env,
  settingsFile = SETTINGS_PATH
): ResolvedStemMcpConfiguration {
  const stored = readSettings(settingsFile).stemStudioMcpEntry?.trim();
  if (stored) {
    const validation = validateStemMcpEntry(stored);
    return validation.config
      ? { config: validation.config, source: "settings" }
      : {
          config: null,
          source: "settings",
          issue: validation.message,
        };
  }

  const legacy = (env.STEMSTUDIO_MCP_ENTRY ?? "").trim();
  if (legacy) {
    const validation = validateStemMcpEntry(legacy);
    return validation.config
      ? { config: validation.config, source: "environment" }
      : {
          config: null,
          source: "environment",
          issue: validation.message,
        };
  }
  return { config: null, source: null };
}

export function saveStemMcpEntry(
  requestedEntry: string,
  settingsFile = SETTINGS_PATH
): StemMcpConfig {
  const validation = validateStemMcpEntry(requestedEntry);
  if (!validation.config) throw new Error(validation.message);
  writePrivateJson(settingsFile, {
    schemaVersion: 1,
    stemStudioMcpEntry: validation.config.entry,
  } satisfies IntegrationSettings);
  return validation.config;
}

export function clearStemMcpEntry(settingsFile = SETTINGS_PATH): void {
  writePrivateJson(settingsFile, { schemaVersion: 1 } satisfies IntegrationSettings);
}

export function hasMatchingLiveFixtureVerification(
  connector: StemMcpConfig,
  verificationFile = VERIFICATION_PATH
): boolean {
  const value = readJsonObject(verificationFile);
  return Boolean(
    value?.schemaVersion === 1 &&
      value.entry === connector.entry &&
      (value.entryVersion ?? null) === (connector.version ?? null) &&
      value.quality === "high" &&
      value.generatedFixture === true &&
      value.sourcePreserved === true &&
      value.outputsValidated === true &&
      typeof value.verifiedAt === "string" &&
      Number.isFinite(Date.parse(value.verifiedAt))
  );
}

export function recordLiveFixtureVerification(
  connector: StemMcpConfig,
  verificationFile = VERIFICATION_PATH
): void {
  writePrivateJson(verificationFile, {
    schemaVersion: 1,
    entry: connector.entry,
    entryVersion: connector.version ?? null,
    quality: "high",
    verifiedAt: new Date().toISOString(),
    generatedFixture: true,
    sourcePreserved: true,
    outputsValidated: true,
  } satisfies RuntimeVerification);
}

export const stemConnectorSettingsPaths = {
  get settings(): string {
    return SETTINGS_PATH;
  },
  get verification(): string {
    return VERIFICATION_PATH;
  },
};

onConfigReload({
  apply: () => {
    SETTINGS_PATH = path.join(config.internalDir, "integrations.json");
    VERIFICATION_PATH = path.join(
      config.internalDir,
      "stem-runtime-verification.json"
    );
  },
});
