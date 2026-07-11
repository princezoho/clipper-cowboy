import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface McpConfig {
  rootDir: string;
  serviceUrl: string;
  projectDir?: string;
  autoStart: boolean;
  debug: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function defaultRootFromModule(moduleUrl: string): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(here, "../..");
}

export function validateLocalServiceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:") {
    throw new Error("CLIPPER_URL must use http://");
  }
  if (!new Set(["127.0.0.1", "localhost"]).has(url.hostname)) {
    throw new Error("CLIPPER_URL must point to localhost or 127.0.0.1");
  }
  // The managed API binds IPv4 loopback. Normalize localhost so systems that
  // prefer ::1 do not report a false offline state.
  url.hostname = "127.0.0.1";
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("CLIPPER_URL must not include credentials or a path");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url
): McpConfig {
  if (env.CLIPPER_ROOT?.trim() && !path.isAbsolute(env.CLIPPER_ROOT.trim())) {
    throw new Error("CLIPPER_ROOT must be an absolute path");
  }
  const rootDir = path.resolve(
    env.CLIPPER_ROOT?.trim() || defaultRootFromModule(moduleUrl)
  );
  const projectRaw = env.CLIPPER_PROJECT_DIR?.trim();
  if (projectRaw && !path.isAbsolute(projectRaw)) {
    throw new Error("CLIPPER_PROJECT_DIR must be an absolute path");
  }
  const port = Number(env.CLIPPER_PORT || 47474);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("CLIPPER_PORT must be an integer from 1024 to 65535");
  }
  const serviceUrl = validateLocalServiceUrl(
    env.CLIPPER_URL?.trim() || `http://127.0.0.1:${port}`
  );
  return {
    rootDir,
    serviceUrl,
    projectDir: projectRaw ? path.resolve(projectRaw) : undefined,
    autoStart: parseBoolean(env.CLIPPER_AUTOSTART, true),
    debug: parseBoolean(env.CLIPPER_MCP_DEBUG, false),
  };
}

export function rootLooksValid(rootDir: string): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(rootDir, "package.json"), "utf8")
    ) as { name?: unknown };
    return (
      packageJson.name === "clipper-cowboy" &&
      fs.existsSync(path.join(rootDir, "server", "index.ts"))
    );
  } catch {
    return false;
  }
}
