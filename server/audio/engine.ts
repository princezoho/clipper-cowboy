import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AudioQuality = "fast";

export interface AudioEngineStatus {
  ready: boolean;
  installing: boolean;
  pythonAvailable: boolean;
  message: string;
  recommendedQuality?: AudioQuality;
}

export interface AudioInstallJob {
  status: "queued" | "running" | "complete" | "error";
  stage?: "environment" | "dependencies" | "validating";
  message: string;
  updatedAt: number;
}

const ENGINE_ROOT = path.join(os.homedir(), ".clipper-cowboy", "audio-engine");
const VENV_ROOT = path.join(ENGINE_ROOT, "venv");
const MAX_OUTPUT_BYTES = 64 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const SEPARATION_TIMEOUT_MS = 6 * 60 * 60_000;
const WORKER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "stemstudio_worker");

function pythonInVenv(): string {
  return process.platform === "win32"
    ? path.join(VENV_ROOT, "Scripts", "python.exe")
    : path.join(VENV_ROOT, "bin", "python");
}

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONUNBUFFERED = "1";
  return env;
}

function testPython(): string | undefined {
  const candidate = process.env.CLIPPER_AUDIO_ENGINE_TEST_PYTHON;
  return process.env.NODE_ENV === "test" && candidate && path.isAbsolute(candidate)
    ? candidate
    : undefined;
}

function findPython(): string | undefined {
  const injected = testPython();
  if (injected) return injected;
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["--version"], {
      env: safeEnv(),
      stdio: "ignore",
      timeout: 5_000,
    });
    if (result.status === 0) return command;
  }
  return undefined;
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void,
  onOutput?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: safeEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn?.(child);
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      collect(chunk);
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) onOutput?.(line);
      }
    });
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("The local audio engine could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (bytes > MAX_OUTPUT_BYTES) {
        reject(new Error("The local audio engine produced too much output."));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error("The local audio engine did not complete."));
      }
    });
  });
}

export class AudioEngineManager {
  private job: AudioInstallJob | null = null;
  private installing = false;

  inspect(): AudioEngineStatus {
    const test = testPython();
    const pythonAvailable = Boolean(findPython());
    const ready =
      Boolean(test) ||
      (fs.existsSync(pythonInVenv()) &&
        spawnSync(pythonInVenv(), ["-c", "import numpy, scipy, soundfile"], {
          env: safeEnv(),
          stdio: "ignore",
          timeout: 10_000,
        }).status === 0);
    return {
      ready,
      installing: this.installing,
      pythonAvailable,
      ...(ready ? { recommendedQuality: "fast" as const } : {}),
      message: ready
        ? "Audio splitting is ready on this Mac."
        : pythonAvailable
          ? "Audio splitting needs a one-time local engine download."
          : "Audio splitting needs Python 3 installed on this Mac.",
    };
  }

  inspectInstall(): AudioInstallJob | null {
    return this.job;
  }

  startInstall(): AudioInstallJob {
    if (this.installing && this.job) return this.job;
    this.job = {
      status: "queued",
      message: "Audio engine installation is queued.",
      updatedAt: Date.now(),
    };
    this.installing = true;
    queueMicrotask(() => void this.install());
    return this.job;
  }

  async separate(
    input: string,
    outputRoot: string,
    quality: AudioQuality,
    onSpawn: (child: ChildProcess) => void,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<void> {
    const status = this.inspect();
    if (!status.ready) throw new Error(status.message);
    const python = testPython() || pythonInVenv();
    const args = [
      "-m",
      "stemstudio_worker.separate",
      "--input",
      input,
      "--outdir",
      outputRoot,
      "--engine",
      "stub",
      "--quality",
      "fast",
      "--cache-dir",
      path.join(ENGINE_ROOT, "models"),
    ];
    const env = safeEnv();
    env.PYTHONPATH = path.dirname(WORKER_ROOT);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      onSpawn(child);
      let bytes = 0;
      let buffered = "";
      const output = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
        buffered += chunk.toString("utf8");
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { event?: string; stage?: string; percent?: number };
            if (event.event === "progress" && typeof event.stage === "string" && typeof event.percent === "number") onProgress?.(event.stage, event.percent);
          } catch { /* worker diagnostics never reach browser */ }
        }
      };
      child.stdout.on("data", output);
      child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM"); });
      const timer = setTimeout(() => child.kill("SIGTERM"), SEPARATION_TIMEOUT_MS);
      child.once("error", () => { clearTimeout(timer); reject(new Error("The local audio engine could not start.")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (bytes > MAX_OUTPUT_BYTES) reject(new Error("The local audio engine produced too much output."));
        else if (code === 0) resolve();
        else reject(new Error("The local audio engine did not complete."));
      });
    });
  }

  private update(patch: Omit<Partial<AudioInstallJob>, "updatedAt">): void {
    if (this.job) Object.assign(this.job, patch, { updatedAt: Date.now() });
  }

  private async install(): Promise<void> {
    try {
      const bootstrap = findPython();
      if (!bootstrap) throw new Error("Python 3 is not available.");
      if (testPython()) {
        this.update({ status: "complete", message: "Audio engine is ready." });
        return;
      }
      fs.mkdirSync(ENGINE_ROOT, { recursive: true, mode: 0o700 });
      this.update({
        status: "running",
        stage: "environment",
        message: "Creating the local audio engine…",
      });
      await run(bootstrap, ["-m", "venv", VENV_ROOT], INSTALL_TIMEOUT_MS);
      this.update({
        status: "running",
        stage: "dependencies",
        message: "Downloading the audio engine…",
      });
      await run(
        pythonInVenv(),
        ["-m", "pip", "install", "--disable-pip-version-check", "numpy==2.2.6", "scipy==1.15.3", "soundfile==0.13.1"],
        INSTALL_TIMEOUT_MS
      );
      this.update({
        status: "running",
        stage: "validating",
        message: "Checking the local audio engine…",
      });
      await run(pythonInVenv(), ["-c", "import numpy, scipy, soundfile"], 30_000);
      this.update({ status: "complete", stage: undefined, message: "Audio engine is ready." });
    } catch {
      this.update({
        status: "error",
        stage: undefined,
        message: "Audio engine installation could not finish. Check that Python 3 is available, then try again.",
      });
    } finally {
      this.installing = false;
    }
  }
}

export const audioEngineManager = new AudioEngineManager();
