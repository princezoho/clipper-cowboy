import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export const FFMPEG_PATH = (ffmpegStatic as unknown as string) || "ffmpeg";
export const FFPROBE_PATH =
  (ffprobeStatic as { path: string } | undefined)?.path || "ffprobe";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  bin: string,
  args: string[],
  opts: { input?: Buffer; cwd?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

export async function ffmpeg(args: string[]): Promise<RunResult> {
  return run(FFMPEG_PATH, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

export async function ffprobe(args: string[]): Promise<RunResult> {
  return run(FFPROBE_PATH, args);
}

export interface ProbeStream {
  index: number;
  codec_type: "video" | "audio" | "subtitle" | string;
  codec_name?: string;
  profile?: string;
  level?: number;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
}

export interface ProbeResult {
  format: {
    filename: string;
    duration?: string;
    bit_rate?: string;
    format_name?: string;
  };
  streams: ProbeStream[];
}

export async function probeFile(file: string): Promise<ProbeResult> {
  const r = await ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as ProbeResult;
}

export async function getKeyframes(file: string): Promise<number[]> {
  const r = await ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
    "-of",
    "csv=p=0",
    file,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe keyframes failed: ${r.stderr}`);
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => Number(l))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

export function tmpFile(ext: string): string {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `cliplab-${id}${ext}`);
}

export async function extractFrameJpeg(
  file: string,
  timeSec: number,
  outPath: string,
  width = 320
): Promise<void> {
  const r = await ffmpeg([
    "-ss",
    String(Math.max(0, timeSec)),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    "4",
    outPath,
  ]);
  if (r.code !== 0) throw new Error(`extractFrame failed: ${r.stderr}`);
}

export interface SceneCut {
  time: number;
  score: number;
}

export async function detectScenes(
  file: string,
  threshold = 0.4
): Promise<SceneCut[]> {
  const r = await ffmpeg([
    "-i",
    file,
    "-filter:v",
    `select='gt(scene,${threshold})',showinfo`,
    "-f",
    "null",
    "-",
  ]);
  if (r.code !== 0) {
    const r2 = await run(FFMPEG_PATH, [
      "-hide_banner",
      "-i",
      file,
      "-filter:v",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ]);
    return parseShowinfo(r2.stderr);
  }
  return parseShowinfo(r.stderr);
}

function parseShowinfo(stderr: string): SceneCut[] {
  const cuts: SceneCut[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    cuts.push({ time: Number(m[1]), score: 1 });
  }
  return cuts;
}

export async function getDuration(file: string): Promise<number> {
  const probe = await probeFile(file);
  const d = Number(probe.format.duration ?? 0);
  return Number.isFinite(d) ? d : 0;
}

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  codec: string;
  pixFmt: string;
  videoBitrate: number;
  audioCodec?: string;
  audioBitrate?: number;
  audioSampleRate?: number;
  audioChannels?: number;
}

export function evalRate(rate: string | undefined): number {
  if (!rate) return 0;
  if (rate.includes("/")) {
    const [a, b] = rate.split("/").map(Number);
    if (!b) return 0;
    return a / b;
  }
  return Number(rate);
}

export async function getVideoInfo(file: string): Promise<VideoInfo> {
  const probe = await probeFile(file);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("No video stream");
  const fps = evalRate(v.avg_frame_rate) || evalRate(v.r_frame_rate) || 30;
  return {
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps,
    duration: Number(probe.format.duration ?? 0),
    codec: v.codec_name ?? "",
    pixFmt: v.pix_fmt ?? "",
    videoBitrate: Number(v.bit_rate ?? probe.format.bit_rate ?? 0),
    audioCodec: a?.codec_name,
    audioBitrate: a ? Number(a.bit_rate ?? 0) : undefined,
    audioSampleRate: a ? Number(a.sample_rate ?? 0) : undefined,
    audioChannels: a?.channels,
  };
}
