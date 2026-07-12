import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AudioQuality = "fast" | "high";

export interface AudioEngineStatus {
  ready: boolean;
  installing: boolean;
  pythonAvailable: boolean;
  message: string;
  recommendedQuality?: AudioQuality;
  installedQualities: AudioQuality[];
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
const UV = "/opt/homebrew/bin/uv";
const MODEL_READY: Record<AudioQuality, string> = {
  fast: path.join(ENGINE_ROOT, "htdemucs-ready"),
  high: path.join(ENGINE_ROOT, "htdemucs_ft-ready"),
};
const PYTHON_REQUIREMENTS = [
  "torch==2.5.1",
  "torchaudio==2.5.1",
  "demucs==4.0.1",
  "soundfile==0.13.1",
];

function safeWorkerDiagnostic(message: string): string {
  return message
    .replace(/(?:\/[^\s:'"]+)+/g, "<path>")
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{12,}\b/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

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

function systemPython(): { command: string; version: string } | undefined {
  const injected = testPython();
  if (injected) return { command: injected, version: "test" };
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["--version"], {
      env: safeEnv(),
      encoding: "utf8",
      timeout: 5_000,
    });
    const version = `${result.stdout ?? ""}${result.stderr ?? ""}`.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/)?.[1];
    if (result.status === 0 && version) return { command, version };
  }
  return undefined;
}

function hasUv(): boolean {
  return process.platform === "darwin" && fs.existsSync(UV) &&
    spawnSync(UV, ["--version"], { env: safeEnv(), stdio: "ignore", timeout: 5_000 }).status === 0;
}

function dependenciesReady(): boolean {
  return fs.existsSync(pythonInVenv()) &&
    spawnSync(pythonInVenv(), ["-c", "import torch, demucs, soundfile"], {
      env: safeEnv(), stdio: "ignore", timeout: 15_000,
    }).status === 0;
}

function modelWeightsPresent(): boolean {
  const checkpoints = path.join(ENGINE_ROOT, "models", "hub", "checkpoints");
  try {
    return fs.readdirSync(checkpoints).some((entry) => entry.endsWith(".th") && fs.statSync(path.join(checkpoints, entry)).size > 0);
  } catch {
    return false;
  }
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void,
  onOutput?: (line: string) => void,
  extraEnv?: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...safeEnv(), ...extraEnv },
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
    const detected = systemPython();
    const uv = hasUv();
    const pythonAvailable = Boolean(uv || detected);
    const fastInstalled = Boolean(test) || (fs.existsSync(MODEL_READY.fast) && modelWeightsPresent());
    const highInstalled = fs.existsSync(MODEL_READY.high);
    const ready = Boolean(test) || (dependenciesReady() && fastInstalled);
    const installedQualities: AudioQuality[] = [
      ...(fastInstalled ? ["fast" as const] : []),
      ...(highInstalled ? ["high" as const] : []),
    ];
    return {
      ready,
      installing: this.installing,
      pythonAvailable,
      installedQualities,
      ...(ready ? { recommendedQuality: "fast" as const } : {}),
      message: ready
        ? highInstalled
          ? "Audio splitting is ready: Fast (htdemucs) and High (htdemucs_ft) run locally on this Mac."
          : "Audio splitting is ready: Fast (htdemucs) is installed. Choose High to download its fine-tuned model before the first job."
        : uv
          ? "Audio splitting needs a one-time managed Python 3.11 environment and Demucs model download."
          : detected
            ? `Audio splitting requires Python 3.10+ (detected ${detected.version}). Install uv, then try setup again.`
            : "Audio splitting requires Python 3.10+. Install uv, then try setup again.",
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
    if (quality === "high" && !status.installedQualities.includes("high")) {
      onProgress?.("downloading_high_model", 0);
      await this.downloadModel("high", onSpawn, onProgress);
      onProgress?.("downloading_high_model", 100);
    }
    const python = testPython() || pythonInVenv();
    const args = [
      "-m",
      "stemstudio_worker.separate",
      "--input",
      input,
      "--outdir",
      outputRoot,
      "--engine",
      "demucs",
      "--quality",
      quality,
      "--cache-dir",
      path.join(ENGINE_ROOT, "models"),
    ];
    const env = safeEnv();
    env.PYTHONPATH = path.dirname(WORKER_ROOT);
    env.TORCH_HOME = path.join(ENGINE_ROOT, "models");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(python, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      onSpawn(child);
      let bytes = 0;
      let buffered = "";
      let workerError = "";
      let stderr = "";
      const output = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
        buffered += chunk.toString("utf8");
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as { event?: string; stage?: string; percent?: number; message?: string };
            if (event.event === "progress" && typeof event.stage === "string" && typeof event.percent === "number") onProgress?.(event.stage, event.percent);
            if (event.event === "error" && typeof event.message === "string") workerError = safeWorkerDiagnostic(event.message);
          } catch { /* worker diagnostics never reach browser */ }
        }
      };
      child.stdout.on("data", output);
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
        stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), SEPARATION_TIMEOUT_MS);
      child.once("error", () => { clearTimeout(timer); reject(new Error("The local audio engine could not start.")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (bytes > MAX_OUTPUT_BYTES) reject(new Error("The local audio engine produced too much output."));
        else if (code === 0) resolve();
        else {
          const diagnostic = workerError || safeWorkerDiagnostic(stderr);
          reject(new Error(`audio engine worker failed${diagnostic ? `: ${diagnostic}` : ""}`));
        }
      });
    });
  }

  private update(patch: Omit<Partial<AudioInstallJob>, "updatedAt">): void {
    if (this.job) Object.assign(this.job, patch, { updatedAt: Date.now() });
  }

  private async install(): Promise<void> {
    try {
      if (testPython()) {
        this.update({ status: "complete", message: "Audio engine is ready." });
        return;
      }
      if (!hasUv()) {
        const detected = systemPython();
        throw new Error(
          detected
            ? `Audio splitting requires Python 3.10+ (detected ${detected.version}). Install uv, then try again.`
            : "Audio splitting requires Python 3.10+. Install uv, then try again."
        );
      }
      fs.mkdirSync(ENGINE_ROOT, { recursive: true, mode: 0o700 });
      fs.rmSync(MODEL_READY.fast, { force: true });
      this.update({
        status: "running",
        stage: "environment",
        message: "Creating the local audio engine…",
      });
      await run(UV, ["venv", "--python", "3.11", VENV_ROOT], INSTALL_TIMEOUT_MS);
      this.update({
        status: "running",
        stage: "dependencies",
        message: "Downloading the audio engine…",
      });
      await run(
        UV,
        ["pip", "install", "--python", pythonInVenv(), ...PYTHON_REQUIREMENTS],
        INSTALL_TIMEOUT_MS
      );
      this.update({
        status: "running",
        stage: "validating",
        message: "Downloading and checking the Demucs model…",
      });
      const env = safeEnv();
      env.PYTHONPATH = path.dirname(WORKER_ROOT);
      env.TORCH_HOME = path.join(ENGINE_ROOT, "models");
      await run(
        pythonInVenv(),
        ["-m", "stemstudio_worker.separate", "--download-model", "--engine", "demucs", "--quality", "fast", "--cache-dir", env.TORCH_HOME],
        INSTALL_TIMEOUT_MS,
        undefined,
        undefined,
        env
      );
      fs.writeFileSync(MODEL_READY.fast, "htdemucs\n", { mode: 0o600 });
      this.update({ status: "complete", stage: undefined, message: "Fast Demucs audio engine is ready. High downloads after you select it." });
    } catch (error) {
      this.update({
        status: "error",
        stage: undefined,
        message: error instanceof Error ? error.message : "Audio engine installation could not finish.",
      });
    } finally {
      this.installing = false;
    }
  }

  private async downloadModel(
    quality: AudioQuality,
    onSpawn: (child: ChildProcess) => void,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<void> {
    const python = testPython() || pythonInVenv();
    const env = safeEnv();
    env.PYTHONPATH = path.dirname(WORKER_ROOT);
    env.TORCH_HOME = path.join(ENGINE_ROOT, "models");
    await run(
      python,
      [
        "-m", "stemstudio_worker.separate", "--download-model", "--engine", "demucs",
        "--quality", quality, "--cache-dir", env.TORCH_HOME,
      ],
      INSTALL_TIMEOUT_MS,
      onSpawn,
      (line) => {
        try {
          const event = JSON.parse(line) as { event?: string; percent?: number };
          if (event.event === "progress" && typeof event.percent === "number") {
            onProgress?.("downloading_high_model", event.percent);
          }
        } catch {
          // The worker's stdout protocol is JSON lines; diagnostics are not surfaced.
        }
      },
      env
    );
    fs.writeFileSync(MODEL_READY[quality], quality === "high" ? "htdemucs_ft\n" : "htdemucs\n", { mode: 0o600 });
  }
}

export const audioEngineManager = new AudioEngineManager();
