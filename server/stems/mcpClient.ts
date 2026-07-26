import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "STEMSTUDIO_ROOT",
  "STEMSTUDIO_PYTHON",
  "STEMSTUDIO_RESOURCES",
  "STEMSTUDIO_USER_DATA",
  "STEMSTUDIO_USER_DATA_FOLDER",
  "STEMSTUDIO_CACHE",
  "STEMSTUDIO_WINDOWS_PROFILE",
] as const;

export interface StemMcpConfig {
  command: string;
  args: string[];
  entry: string;
  kind?: "source-module" | "packaged-launcher";
  version?: string;
}

export interface StemMcpEntryValidation {
  ok: boolean;
  message: string;
  config?: StemMcpConfig;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function safeDiagnostic(value: unknown): string {
  return String(value ?? "")
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
    .replace(
      /\b(OPENAI_API_KEY|CLIPPER_API_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)\s*=\s*\S+/gi,
      "$1=<redacted>"
    )
    .replace(/(?:\/[^\s:'"]+)+/g, "<path>")
    .replace(/[A-Za-z]:\\(?:[^\s:'"]+\\?)+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function buildStemMcpEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) clean[key] = value;
  }
  clean.NO_COLOR = "1";
  // A missing or incomplete cache must fail closed. Clipper never permits the
  // official worker to fetch model weights as a side effect of separation.
  clean.HF_HUB_OFFLINE = "1";
  clean.TRANSFORMERS_OFFLINE = "1";
  return clean;
}

function readSmallJson(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function regularCanonicalFile(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function sourceModuleConfig(entry: string): StemMcpConfig | null {
  if (
    path.basename(entry) !== "index.js" ||
    path.basename(path.dirname(entry)) !== "dist"
  ) {
    return null;
  }
  const mcpRoot = path.dirname(path.dirname(entry));
  const packageJsonPath = path.join(mcpRoot, "package.json");
  const packageJson = readSmallJson(packageJsonPath);
  const bin =
    packageJson?.bin &&
    typeof packageJson.bin === "object" &&
    !Array.isArray(packageJson.bin)
      ? (packageJson.bin as Record<string, unknown>)["stem-studio-mcp"]
      : undefined;
  const version = packageJson?.version;
  if (
    regularCanonicalFile(packageJsonPath) !== packageJsonPath ||
    packageJson?.name !== "stem-studio-mcp" ||
    packageJson?.main !== "./dist/index.js" ||
    bin !== "./dist/index.js" ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  ) {
    return null;
  }
  return {
    command: process.execPath,
    args: [entry],
    entry,
    kind: "source-module",
    version,
  };
}

function packagedLauncherConfig(entry: string): StemMcpConfig | null {
  const windows = process.platform === "win32";
  const expectedName = windows
    ? "stem-studio-mcp.cmd"
    : "stem-studio-mcp";
  const mcpDir = path.dirname(entry);
  if (
    path.basename(entry) !== expectedName ||
    path.basename(mcpDir) !== "mcp"
  ) {
    return null;
  }
  const resourcesDir = path.dirname(mcpDir);
  const descriptorPath = path.join(
    resourcesDir,
    "stem-studio-distribution.json"
  );
  const modulePath = path.join(mcpDir, "index.js");
  const modulePackagePath = path.join(mcpDir, "package.json");
  const descriptor = readSmallJson(descriptorPath);
  const modulePackage = readSmallJson(modulePackagePath);
  if (
    regularCanonicalFile(descriptorPath) !== descriptorPath ||
    regularCanonicalFile(modulePath) !== modulePath ||
    regularCanonicalFile(modulePackagePath) !== modulePackagePath ||
    descriptor?.schemaVersion !== 1 ||
    descriptor?.appId !== "com.wassermanproductions.stemstudio" ||
    descriptor?.displayName !== "Stem Studio" ||
    descriptor?.mcpLauncher !== `mcp/${expectedName}` ||
    modulePackage?.type !== "module" ||
    modulePackage?.private !== true
  ) {
    return null;
  }

  if (process.platform === "darwin") {
    const contentsDir = path.dirname(resourcesDir);
    const appDir = path.dirname(contentsDir);
    if (
      path.basename(resourcesDir) !== "Resources" ||
      path.basename(contentsDir) !== "Contents" ||
      !path.basename(appDir).endsWith(".app")
    ) {
      return null;
    }
    try {
      const launcher = fs.readFileSync(entry, "utf8");
      const lines = launcher.trimEnd().split(/\r?\n/);
      const execMatch = lines[2]?.match(
        /^ELECTRON_RUN_AS_NODE=1 exec "\$HERE\/\.\.\/\.\.\/MacOS\/([^"/]+)" "\$HERE\/index\.js" "\$@"$/
      );
      if (
        lines.length !== 3 ||
        lines[0] !== "#!/bin/sh" ||
        lines[1] !==
          'HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)' ||
        !execMatch
      ) {
        return null;
      }
      const hostExecutable = path.join(contentsDir, "MacOS", execMatch[1]);
      if (!regularCanonicalFile(hostExecutable)) return null;
      fs.accessSync(entry, fs.constants.X_OK);
      fs.accessSync(hostExecutable, fs.constants.X_OK);
    } catch {
      return null;
    }
  } else if (!windows) {
    try {
      fs.accessSync(entry, fs.constants.X_OK);
    } catch {
      return null;
    }
  }

  return windows
    ? {
        command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", "call", entry],
        entry,
        kind: "packaged-launcher",
      }
    : {
        command: entry,
        args: [],
        entry,
        kind: "packaged-launcher",
      };
}

export function validateStemMcpEntry(
  configured: string
): StemMcpEntryValidation {
  const candidate = configured.trim();
  if (!candidate) {
    return { ok: false, message: "Choose an official Stem Studio MCP entry." };
  }
  if (!path.isAbsolute(candidate)) {
    return {
      ok: false,
      message: "The Stem Studio MCP entry must be an absolute path.",
    };
  }
  const entry = regularCanonicalFile(candidate);
  if (!entry) {
    return {
      ok: false,
      message: "The Stem Studio MCP entry must be a regular, non-symlink file.",
    };
  }
  const config = sourceModuleConfig(entry) ?? packagedLauncherConfig(entry);
  if (!config) {
    return {
      ok: false,
      message:
        "That file is not a verified Stem Studio MCP dist/index.js module or packaged launcher.",
    };
  }
  return {
    ok: true,
    message:
      config.kind === "source-module"
        ? `Verified official Stem Studio MCP ${config.version}.`
        : "Verified official packaged Stem Studio MCP launcher.",
    config,
  };
}

export function resolveStemMcpConfig(
  source: NodeJS.ProcessEnv = process.env
): StemMcpConfig | null {
  const configured = (source.STEMSTUDIO_MCP_ENTRY ?? "").trim();
  return configured
    ? validateStemMcpEntry(configured).config ?? null
    : null;
}

export function decodeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { type?: string; text?: string }[];
  };
  let decoded: unknown = value.structuredContent;
  if (decoded === undefined && Array.isArray(value.content)) {
    const text = value.content.find(
      (item) => item?.type === "text" && typeof item.text === "string"
    )?.text;
    if (text !== undefined) {
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = text;
      }
    }
  }
  if (value.isError) {
    const message =
      decoded && typeof decoded === "object" && "error" in decoded
        ? String((decoded as { error?: unknown }).error)
        : typeof decoded === "string"
          ? decoded
          : "Stem Studio rejected the request.";
    throw new Error(safeDiagnostic(message) || "Stem Studio rejected the request.");
  }
  return decoded;
}

export class StemMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stderrTail = "";
  private protocolError: Error | null = null;

  constructor(
    private readonly config: StemMcpConfig,
    private readonly childEnv: NodeJS.ProcessEnv = buildStemMcpEnvironment()
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args, {
      env: this.childEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.once("error", () => {
      this.failAll(new Error("Official Stem Studio MCP could not start."));
    });
    child.once("close", (code) => {
      const detail = this.protocolError
        ? this.protocolError.message
        : this.stderrTail
          ? `Stem Studio MCP exited (${code ?? "unknown"}): ${this.stderrTail}`
          : `Stem Studio MCP exited (${code ?? "unknown"}).`;
      this.failAll(new Error(detail));
      this.child = null;
    });

    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "clipper-cowboy", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request("tools/list", {})) as {
      tools?: McpToolDefinition[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs
    );
    return decodeToolResult(result) as T;
  }

  diagnostic(): string | undefined {
    return this.stderrTail || undefined;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error("Stem Studio MCP is not connected."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Stem Studio MCP ${method} timed out.`));
      }, Math.max(100, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.protocolFailure("Stem Studio MCP exceeded its stdout limit.");
      return;
    }
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.protocolFailure(
          "Stem Studio MCP wrote non-JSON data to stdout; JSON-RPC discipline is required."
        );
        return;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            safeDiagnostic(message.error.message) ||
              "Stem Studio MCP returned a protocol error."
          )
        );
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > MAX_STDERR_BYTES && this.child) {
      this.protocolFailure("Stem Studio MCP exceeded its diagnostic output limit.");
      return;
    }
    this.stderrTail = safeDiagnostic(
      `${this.stderrTail} ${chunk.toString("utf8")}`
    );
  }

  private protocolFailure(message: string): void {
    if (this.protocolError) return;
    this.protocolError = new Error(message);
    this.failAll(this.protocolError);
    this.child?.kill("SIGTERM");
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export const stemMcpTestHelpers = {
  CHILD_ENV_ALLOWLIST,
  safeDiagnostic,
};
