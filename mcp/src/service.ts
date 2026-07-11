import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rootLooksValid, type McpConfig } from "./config.js";
import { PublicError } from "./security.js";
import { isContainedPath } from "./security.js";

export interface Health {
  ok: boolean;
  service: string;
  apiVersion: number;
  projectDir: string;
  clipsDir: string;
  charactersDir: string;
  imagesDir?: string;
  derivedDir: string;
  stemsDir: string;
  shotlistMd: string;
  shotlistCsv: string;
  hasOpenAIKey: boolean;
  projectDirConfigured: boolean;
}

interface ProbeResult {
  reachable: boolean;
  health?: Health;
}

export interface ServiceOptions {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
}

export class ClipperService {
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly sleep: (ms: number) => Promise<void>;
  private child: ChildProcess | null = null;
  private readonly workerChildren = new Set<ChildProcess>();
  private apiToken: string | undefined;
  private startPromise: Promise<Health> | null = null;
  private readonly logTail: string[] = [];

  constructor(
    readonly config: McpConfig,
    private readonly env: NodeJS.ProcessEnv,
    private readonly redact: (value: unknown) => string,
    options: ServiceOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async status(): Promise<Health | null> {
    const probe = await this.probe();
    if (!probe.reachable) return null;
    return this.validateHealth(probe.health);
  }

  async ensure(): Promise<Health> {
    const probe = await this.probe();
    if (probe.reachable) return this.validateHealth(probe.health);
    if (!this.config.autoStart) {
      throw new PublicError(
        "SERVICE_OFFLINE",
        "Clipper Cowboy is not running and automatic startup is disabled.",
        "Start npm run dev/start, or set CLIPPER_AUTOSTART=true."
      );
    }
    if (!this.startPromise) {
      this.startPromise = this.startManaged().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async request<T>(
    pathname: string,
    init: RequestInit = {},
    timeoutMs = 30_000
  ): Promise<T> {
    await this.ensure();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.serviceUrl}${pathname}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(this.apiToken ? { "x-clipper-api-token": this.apiToken } : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new PublicError("INVALID_RESPONSE", "Clipper Cowboy returned a non-JSON response.");
      }
      if (!response.ok) {
        const candidate = body && typeof body === "object" && "error" in body
          ? (body as { error: unknown }).error
          : `HTTP ${response.status}`;
        throw new PublicError("CLIPPER_API_ERROR", this.redact(
          typeof candidate === "string" ? candidate : JSON.stringify(candidate)
        ));
      }
      return body as T;
    } catch (error) {
      if (error instanceof PublicError) throw error;
      if ((error as { name?: string }).name === "AbortError") {
        throw new PublicError(
          "TIMEOUT",
          "Clipper Cowboy did not finish before the tool timeout.",
          "Use wait:false for long work and poll check_job."
        );
      }
      throw new PublicError("SERVICE_ERROR", this.redact(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async setup(createProjectDir: boolean, update: (stage: string, percent: number, detail?: string) => void): Promise<unknown> {
    if (!rootLooksValid(this.config.rootDir)) {
      throw new PublicError(
        "INVALID_REPOSITORY",
        "CLIPPER_ROOT is not a Clipper Cowboy repository.",
        "Correct CLIPPER_ROOT before running setup."
      );
    }
    if (createProjectDir) {
      if (!this.config.projectDir) {
        throw new PublicError(
          "PROJECT_NOT_CONFIGURED",
          "CLIPPER_PROJECT_DIR is not configured.",
          "Add an absolute CLIPPER_PROJECT_DIR to the MCP environment."
        );
      }
      fs.mkdirSync(this.config.projectDir, { recursive: true });
    }
    update("installing", 10, "Installing Clipper Cowboy dependencies");
    await this.runNpm(["ci"]);
    update("building", 70, "Building the Clipper Cowboy UI");
    await this.runNpm(["run", "build"]);
    update("verifying", 95, "Checking the local service prerequisites");
    return {
      root_dir: this.config.rootDir,
      project_dir: this.config.projectDir,
      dependencies_installed: true,
      ui_built: true,
    };
  }

  async shutdown(): Promise<void> {
    const children = [this.child, ...this.workerChildren].filter(
      (child): child is ChildProcess => Boolean(child && child.exitCode === null)
    );
    for (const child of children) this.signalProcessTree(child, "SIGTERM");
    if (children.length > 0) {
      await Promise.race([
        Promise.all(children.map((child) => new Promise<void>((resolve) => child.once("exit", () => resolve())))),
        this.sleep(2_000),
      ]);
      for (const child of children) {
        if (child.exitCode === null) this.signalProcessTree(child, "SIGKILL");
      }
    }
    this.child = null;
    this.workerChildren.clear();
    this.apiToken = undefined;
  }

  private async probe(): Promise<ProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    let reached = false;
    try {
      const response = await this.fetchImpl(`${this.config.serviceUrl}/api/health`, {
        headers: {
          Accept: "application/json",
          ...(this.apiToken ? { "x-clipper-api-token": this.apiToken } : {}),
        },
        signal: controller.signal,
        redirect: "error",
      });
      reached = true;
      if (!response.ok) return { reachable: true };
      const body = (await response.json()) as Health;
      return { reachable: true, health: body };
    } catch {
      return { reachable: reached };
    } finally {
      clearTimeout(timer);
    }
  }

  private validateHealth(health: Health | undefined): Health {
    if (!health || health.ok !== true || health.service !== "clipper-cowboy" || health.apiVersion !== 1) {
      throw new PublicError(
        "SERVICE_MISMATCH",
        `${this.config.serviceUrl} is occupied by an incompatible or unrelated service.`,
        "Stop that service or configure a different CLIPPER_PORT."
      );
    }
    const requiredPaths: Array<[keyof Health, string]> = [
      ["projectDir", health.projectDir],
      ["clipsDir", health.clipsDir],
      ["charactersDir", health.charactersDir],
      ["derivedDir", health.derivedDir],
      ["stemsDir", health.stemsDir],
      ["shotlistMd", health.shotlistMd],
      ["shotlistCsv", health.shotlistCsv],
    ];
    if (requiredPaths.some(([, value]) => typeof value !== "string" || !path.isAbsolute(value))) {
      throw new PublicError("INVALID_HEALTH", "Clipper Cowboy returned invalid project paths.");
    }
    const expectedPaths: Array<[string, string]> = [
      [health.clipsDir, path.join(health.projectDir, "clips")],
      [health.charactersDir, path.join(health.projectDir, "characters")],
      [health.derivedDir, path.join(health.projectDir, "derived")],
      [health.stemsDir, path.join(health.projectDir, "derived", "stems")],
      [health.shotlistMd, path.join(health.projectDir, "shotlist.md")],
      [health.shotlistCsv, path.join(health.projectDir, "shotlist.csv")],
    ];
    if (expectedPaths.some(([actual, expected]) => path.resolve(actual) !== path.resolve(expected))) {
      throw new PublicError("INVALID_HEALTH", "Clipper Cowboy returned an unsafe directory layout.");
    }
    try {
      const realProject = fs.realpathSync(health.projectDir);
      for (const childDir of [health.clipsDir, health.charactersDir, health.derivedDir, health.stemsDir]) {
        const realChild = fs.realpathSync(childDir);
        if (!isContainedPath(realProject, realChild)) {
          throw new Error("directory escapes project");
        }
      }
    } catch {
      throw new PublicError("INVALID_HEALTH", "Clipper Cowboy project directories contain an unsafe symlink or are unavailable.");
    }
    if (this.config.projectDir) {
      const expected = path.resolve(this.config.projectDir);
      const actual = path.resolve(health.projectDir);
      if (actual !== expected) {
        throw new PublicError(
          "PROJECT_MISMATCH",
          "The running Clipper Cowboy service uses a different project directory.",
          "Stop it, or point CLIPPER_PROJECT_DIR at the same project."
        );
      }
    }
    return health;
  }

  private async startManaged(): Promise<Health> {
    if (!rootLooksValid(this.config.rootDir)) {
      throw new PublicError(
        "INVALID_REPOSITORY",
        "CLIPPER_ROOT is not a Clipper Cowboy repository.",
        "Correct CLIPPER_ROOT before automatic startup."
      );
    }
    const tsxPackage = path.join(this.config.rootDir, "node_modules", "tsx", "package.json");
    if (!fs.existsSync(tsxPackage)) {
      throw new PublicError(
        "DEPENDENCIES_MISSING",
        "Clipper Cowboy dependencies are not installed.",
        "Run npm run setup from the repository root."
      );
    }
    const url = new URL(this.config.serviceUrl);
    const port = url.port || "80";
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      PORT: port,
    };
    this.apiToken = randomBytes(32).toString("hex");
    childEnv.CLIPPER_API_TOKEN = this.apiToken;
    if (this.config.projectDir) childEnv.PROJECT_DIR = this.config.projectDir;

    const child = this.spawnImpl(
      process.execPath,
      ["--import", "tsx", path.join(this.config.rootDir, "server", "index.ts")],
      {
        cwd: this.config.rootDir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      }
    );
    this.child = child;
    this.captureLogs(child.stdout, "stdout");
    this.captureLogs(child.stderr, "stderr");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        throw new PublicError(
          "SERVICE_START_FAILED",
          `Clipper Cowboy exited during startup.${this.logTail.length ? ` Last log: ${this.logTail.at(-1)}` : ""}`
        );
      }
      const probe = await this.probe();
      if (probe.reachable) return this.validateHealth(probe.health);
      await this.sleep(200);
    }
    child.kill("SIGTERM");
    throw new PublicError(
      "SERVICE_START_TIMEOUT",
      "Clipper Cowboy did not become ready within 20 seconds."
    );
  }

  private captureLogs(stream: NodeJS.ReadableStream | null, label: string): void {
    if (!stream) return;
    let pending = "";
    stream.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        const line = this.redact(raw).slice(0, 4000);
        if (!line) continue;
        this.logTail.push(line);
        if (this.logTail.length > 20) this.logTail.shift();
        if (this.config.debug) process.stderr.write(`[clipper:${label}] ${line}\n`);
      }
    });
  }

  private runNpm(args: string[]): Promise<void> {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    return new Promise((resolve, reject) => {
      const allowedEnv = [
        "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP",
        "SystemRoot", "ComSpec", "SHELL", "LANG", "LC_ALL",
        "npm_config_cache",
      ];
      const childEnv = Object.fromEntries(
        allowedEnv.flatMap((key) => this.env[key] === undefined ? [] : [[key, this.env[key] as string]])
      );
      const child = this.spawnImpl(command, args, {
        cwd: this.config.rootDir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.workerChildren.add(child);
      const tail: string[] = [];
      const collect = (stream: NodeJS.ReadableStream | null) => {
        stream?.on("data", (chunk) => {
          const line = this.redact(chunk).slice(0, 1000);
          tail.push(line);
          if (tail.length > 10) tail.shift();
        });
      };
      collect(child.stdout);
      collect(child.stderr);
      child.once("error", reject);
      child.once("close", (code) => {
        this.workerChildren.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`npm ${args.join(" ")} failed (exit ${code}). ${tail.at(-1) ?? ""}`));
      });
    });
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // Process may already have exited.
    }
  }
}
