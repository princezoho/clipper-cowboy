import fs from "node:fs";
import path from "node:path";
import {
  ffmpeg,
  getKeyframes,
  getVideoInfo,
  tmpFile,
  VideoInfo,
} from "./ffmpeg.js";

const KEYFRAME_TOLERANCE = 0.04;

function findFloorKeyframe(keyframes: number[], t: number): number {
  let best = 0;
  for (const k of keyframes) {
    if (k <= t + KEYFRAME_TOLERANCE) best = k;
    else break;
  }
  return best;
}

function findCeilKeyframe(
  keyframes: number[],
  t: number,
  duration: number
): number {
  for (const k of keyframes) {
    if (k >= t - KEYFRAME_TOLERANCE) return k;
  }
  return duration;
}

function pickEncoderArgs(info: VideoInfo): string[] {
  const codec = info.codec;
  const isH264 = codec === "h264";
  const isHevc = codec === "hevc" || codec === "h265";
  const isProres = codec?.startsWith("prores");

  if (isProres) {
    return [
      "-c:v",
      "prores_ks",
      "-profile:v",
      "3",
      "-pix_fmt",
      info.pixFmt || "yuv422p10le",
    ];
  }
  if (isHevc) {
    return [
      "-c:v",
      "libx265",
      "-preset",
      "slow",
      "-x265-params",
      "lossless=1",
      "-pix_fmt",
      info.pixFmt || "yuv420p",
    ];
  }
  if (isH264) {
    return [
      "-c:v",
      "libx264",
      "-preset",
      "veryslow",
      "-qp",
      "0",
      "-pix_fmt",
      info.pixFmt || "yuv420p",
    ];
  }
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryslow",
    "-qp",
    "0",
    "-pix_fmt",
    info.pixFmt || "yuv420p",
  ];
}

function pickAudioArgs(info: VideoInfo): string[] {
  if (!info.audioCodec) return ["-an"];
  const codec = info.audioCodec;
  if (codec === "aac") {
    return [
      "-c:a",
      "aac",
      "-b:a",
      String(Math.max(192_000, info.audioBitrate || 192_000)),
      "-ar",
      String(info.audioSampleRate || 48_000),
      "-ac",
      String(info.audioChannels || 2),
    ];
  }
  if (codec === "pcm_s16le" || codec === "pcm_s24le") {
    return ["-c:a", codec];
  }
  if (codec === "opus") {
    return ["-c:a", "libopus", "-b:a", String(info.audioBitrate || 192_000)];
  }
  return [
    "-c:a",
    "aac",
    "-b:a",
    String(Math.max(192_000, info.audioBitrate || 192_000)),
  ];
}

export interface SmartCutResult {
  outputPath: string;
  mode: "stream-copy" | "smart-cut" | "reencode-fallback";
  details: string;
}

export async function smartCut(
  source: string,
  inT: number,
  outT: number,
  outputPath: string
): Promise<SmartCutResult> {
  if (outT <= inT) throw new Error("out must be greater than in");

  const info = await getVideoInfo(source);
  const keyframes = await getKeyframes(source);
  const duration = info.duration;

  const inOnKey =
    keyframes.some((k) => Math.abs(k - inT) <= KEYFRAME_TOLERANCE) ||
    inT <= KEYFRAME_TOLERANCE;
  const outOnKey =
    Math.abs(outT - duration) <= KEYFRAME_TOLERANCE ||
    keyframes.some((k) => Math.abs(k - outT) <= KEYFRAME_TOLERANCE);

  if (inOnKey && outOnKey) {
    const args = [
      "-ss",
      String(inT),
      "-to",
      String(outT),
      "-i",
      source,
      "-map",
      "0",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outputPath,
    ];
    const r = await ffmpeg(args);
    if (r.code === 0) {
      return {
        outputPath,
        mode: "stream-copy",
        details: "Both endpoints landed on keyframes; bit-identical copy.",
      };
    }
  }

  const kInNext = findCeilKeyframe(keyframes, inT, duration);
  const kOutPrev = findFloorKeyframe(keyframes, outT);

  const ext = path.extname(outputPath);
  const headPath = tmpFile(ext);
  const midPath = tmpFile(ext);
  const tailPath = tmpFile(ext);
  const segments: string[] = [];
  const cleanup: string[] = [];

  try {
    const headNeeded = kInNext - inT > KEYFRAME_TOLERANCE;
    const tailNeeded = outT - kOutPrev > KEYFRAME_TOLERANCE;
    const midNeeded = kOutPrev - kInNext > KEYFRAME_TOLERANCE;

    if (!headNeeded && !midNeeded && !tailNeeded) {
      const args = [
        "-ss",
        String(inT),
        "-to",
        String(outT),
        "-i",
        source,
        "-map",
        "0",
        ...pickEncoderArgs(info),
        ...pickAudioArgs(info),
        outputPath,
      ];
      const r = await ffmpeg(args);
      if (r.code !== 0) throw new Error(`reencode fallback failed: ${r.stderr}`);
      return {
        outputPath,
        mode: "reencode-fallback",
        details: "Selection sat between two adjacent keyframes; encoded to match source.",
      };
    }

    const encoderArgs = pickEncoderArgs(info);
    const audioArgs = pickAudioArgs(info);

    if (headNeeded) {
      const args = [
        "-ss",
        String(inT),
        "-to",
        String(kInNext),
        "-i",
        source,
        "-map",
        "0",
        ...encoderArgs,
        ...audioArgs,
        headPath,
      ];
      const r = await ffmpeg(args);
      if (r.code !== 0) throw new Error(`head encode failed: ${r.stderr}`);
      segments.push(headPath);
      cleanup.push(headPath);
    }

    if (midNeeded) {
      const args = [
        "-ss",
        String(kInNext),
        "-to",
        String(kOutPrev),
        "-i",
        source,
        "-map",
        "0",
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        midPath,
      ];
      const r = await ffmpeg(args);
      if (r.code !== 0) throw new Error(`mid copy failed: ${r.stderr}`);
      segments.push(midPath);
      cleanup.push(midPath);
    }

    if (tailNeeded) {
      const args = [
        "-ss",
        String(kOutPrev),
        "-to",
        String(outT),
        "-i",
        source,
        "-map",
        "0",
        ...encoderArgs,
        ...audioArgs,
        tailPath,
      ];
      const r = await ffmpeg(args);
      if (r.code !== 0) throw new Error(`tail encode failed: ${r.stderr}`);
      segments.push(tailPath);
      cleanup.push(tailPath);
    }

    if (segments.length === 1) {
      fs.copyFileSync(segments[0], outputPath);
    } else {
      const listPath = tmpFile(".txt");
      cleanup.push(listPath);
      fs.writeFileSync(
        listPath,
        segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n")
      );
      const r = await ffmpeg([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-map",
        "0",
        "-c",
        "copy",
        outputPath,
      ]);
      if (r.code !== 0) throw new Error(`concat failed: ${r.stderr}`);
    }

    return {
      outputPath,
      mode: "smart-cut",
      details: `head=${headNeeded ? (kInNext - inT).toFixed(3) + "s" : "0"} mid=${midNeeded ? (kOutPrev - kInNext).toFixed(3) + "s" : "0"} tail=${tailNeeded ? (outT - kOutPrev).toFixed(3) + "s" : "0"}`,
    };
  } finally {
    for (const f of cleanup) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
  }
}
