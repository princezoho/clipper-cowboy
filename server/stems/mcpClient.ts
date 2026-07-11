import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonObject = Record<string, unknown>;

const MAX_STDOUT_BUFFER = 1024 * 1024;
const REQUIRED_TOOLS = new Set([
  "setup_status",
  "probe_media",
  "separate_stems",
  "check_job",
  "cancel_job",
]);

function safeError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  return new Error(text.slice(0, 1000));
}

function stemEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "ComSpec",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.STEMSTUDIO_ROOT = root;
  if (config.stemStudioPython) {
    env.STEMSTUDIO_PYTHON = config.stemStudioPython;
  }
  if (config.stemStudioCache) {
    env.STEMSTUDIO_CACHE = config.stemStudioCache;
  }
  return env;
}

function resolveStemEntry(): { root: string; entry: string } {
  if (!config.stemStudioRoot) {
    throw new Error(
      "Stem Studio is not connected. Set its folder in Settings and restart Clipper Cowboy."
    );
  }
  const root = fs.realpathSync(config.stemStudioRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error("The configured Stem Studio folder is not a directory.");
  }
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  ) as { name?: string };
  const mcpPackage = JSON.parse(
    fs.readFileSync(path.join(root, "mcp", "package.json"), "utf8")
  ) as { name?: string };
  if (
    rootPackage.name !== "stem-studio" ||
    mcpPackage.name !== "stem-studio-mcp"
  ) {
    throw new Error(
      "The configured folder is not an official Stem Studio checkout."
    );
  }
  const entry = fs.realpathSync(path.join(root, "mcp", "dist", "index.js"));
  const relative = path.relative(root, entry);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Stem Studio's MCP entry is outside its configured folder.");
  }
  if (!fs.statSync(entry).isFile()) {
    throw new Error("Stem Studio's MCP server is not built. Run its MCP build first.");
  }
  return { root, entry };
}

export class StemMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private failed: Error | null = null;
  private pending = new Map<number, Pending>();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.on("error", (error) => this.fail(safeError(error)));
    child.stdin.on("error", (error) => this.fail(safeError(error)));
    child.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        this.fail(
          new Error(
            `Stem Studio stopped unexpectedly${
              code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ""
            }.`
          )
        );
      }
    });
    // Drain diagnostics without reflecting them into API responses. The child
    // receives no Clipper/OpenAI credentials, and stdout remains JSON-RPC only.
    child.stderr.resume();
  }

  static async connect(): Promise<StemMcpClient> {
    const { root, entry } = resolveStemEntry();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: stemEnvironment(root),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StemMcpClient(child);
    try {
      const initialized = (await client.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "clipper-cowboy", version: "0.1.0" },
        },
        15_000
      )) as JsonObject;
      const serverInfo = initialized.serverInfo as JsonObject | undefined;
      if (serverInfo?.name !== "stem-studio") {
        throw new Error("The configured MCP server did not identify as Stem Studio.");
      }
      client.notify("notifications/initialized", {});
      const listed = (await client.request("tools/list", {}, 15_000)) as {
        tools?: Array<{ name?: string }>;
      };
      const names = new Set((listed.tools ?? []).map((tool) => tool.name));
      for (const required of REQUIRED_TOOLS) {
        if (!names.has(required)) {
          throw new Error(`Stem Studio MCP is missing the ${required} tool.`);
        }
      }
      return client;
    } catch (error) {
      try {
        await client.close(true);
      } catch {
        // Preserve the handshake error.
      }
      throw error;
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_STDOUT_BUFFER && !this.buffer.includes("\n")) {
      this.fail(new Error("Stem Studio sent an oversized MCP message."));
      void this.close(true);
      return;
    }
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_STDOUT_BUFFER) {
        this.fail(new Error("Stem Studio sent an oversized MCP message."));
        void this.close(true);
        return;
      }
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        this.fail(new Error("Stem Studio wrote non-JSON data to its MCP channel."));
        void this.close(true);
        return;
      }
      if (typeof message.id !== "number") continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error("Stem Studio MCP returned a protocol error."));
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  private fail(error: Error): void {
    if (!this.failed) this.failed = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failed);
    }
    this.pending.clear();
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Stem Studio timed out during ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (!error) return;
          const waiter = this.pending.get(id);
          if (!waiter) return;
          this.pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.reject(safeError(error));
        }
      );
    });
  }

  notify(method: string, params: JsonObject): void {
    if (this.failed) return;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  async callTool<T>(
    name: string,
    args: JsonObject,
    timeoutMs = 30_000
  ): Promise<T> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs
    )) as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error(`Stem Studio's ${name} tool returned no JSON result.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Stem Studio's ${name} tool returned malformed JSON.`);
    }
    if (result.isError) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `${name} failed`;
      throw new Error(message.slice(0, 1000));
    }
    return parsed as T;
  }

  async close(force = false): Promise<void> {
    if (!force && !this.child.killed) this.child.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.killProcess("SIGKILL");
        resolve();
      }, force ? 50 : 500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.killProcess("SIGTERM");
    });
  }

  private killProcess(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) {
        process.kill(-this.child.pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch {
      // already gone
    }
  }
}
