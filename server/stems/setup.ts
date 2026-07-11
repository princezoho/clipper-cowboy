import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { validateStemStudioInstallation } from "./installation.js";

export type StemSetupStatus = "queued" | "running" | "complete" | "error";

export interface StemSetupJob {
  status: StemSetupStatus;
  stage?: "dependencies" | "building" | "validating";
  message: string;
  technicalDetails?: string;
  updatedAt: number;
}

const COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function setupEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.STEMSTUDIO_ROOT = root;
  return env;
}

function helperDirectory(): { root: string; mcp: string } {
  if (!config.stemStudioRoot) throw new Error("Stem Studio is not connected.");
  const root = validateStemStudioInstallation(config.stemStudioRoot).root;
  const mcp = path.join(root, "mcp");
  const stat = fs.lstatSync(mcp);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Stem Studio's local helper folder is unavailable.");
  }
  return { root, mcp };
}

function hasDependencies(mcp: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(mcp, "node_modules"));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function runNpm(
  root: string,
  mcp: string,
  args: string[]
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: mcp,
      env: setupEnvironment(root),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    const readOutput = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
    };
    child.stdout.on("data", readOutput);
    child.stderr.on("data", readOutput);
    const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, detail: "The local package manager could not run." });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        resolve({ ok: false, detail: "The setup command produced too much output." });
      } else if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, detail: `The setup command exited with code ${code ?? "unknown"}.` });
      }
    });
  });
}

/**
 * Explicit, single-process setup for the already trusted local helper.
 * This deliberately never invokes Stem Studio's Python or model setup.
 */
export class StemSetupManager {
  private job: StemSetupJob | null = null;
  private active = false;

  inspect(): StemSetupJob | null {
    return this.job;
  }

  start(): StemSetupJob {
    if (this.active && this.job) return this.job;
    this.job = {
      status: "queued",
      message: "Stem Studio setup is queued.",
      updatedAt: Date.now(),
    };
    this.active = true;
    queueMicrotask(() => void this.run());
    return this.job;
  }

  private update(patch: Omit<Partial<StemSetupJob>, "updatedAt">): void {
    if (!this.job) return;
    Object.assign(this.job, patch, { updatedAt: Date.now() });
  }

  private async run(): Promise<void> {
    try {
      const { root, mcp } = helperDirectory();
      if (!hasDependencies(mcp)) {
        this.update({
          status: "running",
          stage: "dependencies",
          message: "Installing Stem Studio's local helper dependencies…",
        });
        const installArgs = fs.existsSync(path.join(mcp, "package-lock.json"))
          ? ["ci", "--ignore-scripts=false"]
          : ["install", "--ignore-scripts=false"];
        const installed = await runNpm(root, mcp, installArgs);
        if (!installed.ok) throw new Error(installed.detail);
      }
      this.update({
        status: "running",
        stage: "building",
        message: "Building Stem Studio's local helper…",
      });
      const built = await runNpm(root, mcp, ["run", "build"]);
      if (!built.ok) throw new Error(built.detail);
      this.update({
        status: "running",
        stage: "validating",
        message: "Checking the local helper…",
      });
      const entry = path.join(mcp, "dist", "index.js");
      const entryStat = fs.lstatSync(entry);
      if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
        throw new Error("The build did not create the expected local helper.");
      }
      this.update({
        status: "complete",
        stage: undefined,
        message: "Stem Studio's local helper is ready. Checking audio setup…",
        technicalDetails: undefined,
      });
    } catch (error) {
      const detail =
        error instanceof Error && error.message
          ? error.message.replace(/(?:\/[^ \n]+)+/g, "<path>").slice(0, 240)
          : "An unexpected local setup error occurred.";
      this.update({
        status: "error",
        stage: undefined,
        message:
          "Stem Studio setup could not finish. Open Stem Studio to complete its setup, then try again.",
        technicalDetails: detail,
      });
    } finally {
      this.active = false;
    }
  }
}

export const stemSetupManager = new StemSetupManager();
