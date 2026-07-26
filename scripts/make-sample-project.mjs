#!/usr/bin/env node
/**
 * Regenerates the committed starter project media under `samples/starter-project/`.
 *
 * Everything is synthesized by the bundled ffmpeg from lavfi test sources, so
 * the repository never carries anyone's footage and the files stay tiny. Run
 * this only when the starter project needs to change; the output is committed.
 *
 *   node scripts/make-sample-project.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";

const FFMPEG = ffmpegStatic || "ffmpeg";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "samples", "starter-project");
const SOURCES = path.join(OUT, "sources");
const CLIPS = path.join(OUT, "clips");
const IMAGES = path.join(OUT, "images");

// 320x180 at 12 fps with a hard rate cap keeps each file in the low tens of KB
// while still being a real, seekable, keyframed H.264 file the exporter can cut.
const SIZE = "320x180";
const FPS = 12;
const VIDEO_ARGS = [
  "-c:v", "libx264",
  "-profile:v", "baseline",
  "-pix_fmt", "yuv420p",
  "-preset", "veryslow",
  "-crf", "34",
  "-g", "12",
  "-c:a", "aac",
  "-b:a", "24k",
  "-ac", "1",
  "-ar", "22050",
  "-movflags", "+faststart",
];

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args]);
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

/** One synthetic "montage": three lavfi segments concatenated with a tone bed. */
async function makeSource({ file, segments, tone }) {
  const inputs = [];
  const filters = [];
  segments.forEach((seg, i) => {
    inputs.push("-f", "lavfi", "-i", `${seg}=size=${SIZE}:rate=${FPS}`);
    filters.push(`[${i}:v]trim=duration=3,setpts=PTS-STARTPTS[v${i}]`);
  });
  inputs.push("-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=22050`);
  // `gradients` needs an explicit duration or it never reports EOF.
  const concat = segments.map((_, i) => `[v${i}]`).join("");
  const filter = [
    ...filters,
    `${concat}concat=n=${segments.length}:v=1:a=0[vout]`,
  ].join(";");
  const target = path.join(SOURCES, file);
  await ffmpeg([
    ...inputs,
    "-filter_complex", filter,
    "-map", "[vout]",
    "-map", `${segments.length}:a`,
    "-t", String(segments.length * 3),
    "-shortest",
    ...VIDEO_ARGS,
    "-y", target,
  ]);
  return target;
}

/** A "keeper" cut out of a source, the way an export would produce it. */
async function makeClip({ file, source, start, duration }) {
  const target = path.join(CLIPS, file);
  await ffmpeg([
    "-ss", String(start),
    "-t", String(duration),
    "-i", path.join(SOURCES, source),
    ...VIDEO_ARGS,
    "-y", target,
  ]);
  return target;
}

/** A synthetic reference still, so the Images tab has something to show. */
async function makeImage({ file, pattern }) {
  const target = path.join(IMAGES, file);
  await ffmpeg([
    "-f", "lavfi",
    "-i", `${pattern}=size=480x270:rate=1`,
    "-frames:v", "1",
    "-y", target,
  ]);
  return target;
}

const SOURCE_PLAN = [
  {
    file: "Sample_Bars_And_Gradients.mp4",
    segments: ["smptebars", "testsrc2", "gradients"],
    tone: 220,
  },
  {
    file: "Sample_Countdown_Slate.mp4",
    segments: ["testsrc", "smptehdbars", "testsrc2"],
    tone: 330,
  },
];

const CLIP_PLAN = [
  {
    file: "Sample_Color_Bars_Wide.mp4",
    source: "Sample_Bars_And_Gradients.mp4",
    start: 0.5,
    duration: 2,
  },
  {
    file: "Sample_Gradient_Drift.mp4",
    source: "Sample_Bars_And_Gradients.mp4",
    start: 6.5,
    duration: 2,
  },
  {
    file: "Sample_Countdown_Insert.mp4",
    source: "Sample_Countdown_Slate.mp4",
    start: 1,
    duration: 2,
  },
];

const IMAGE_PLAN = [
  { file: "sample-reference-chart.png", pattern: "testsrc2" },
];

async function main() {
  for (const dir of [SOURCES, CLIPS, IMAGES]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const written = [];
  for (const plan of SOURCE_PLAN) written.push(await makeSource(plan));
  for (const plan of CLIP_PLAN) written.push(await makeClip(plan));
  for (const plan of IMAGE_PLAN) written.push(await makeImage(plan));

  let total = 0;
  for (const f of written) {
    const size = fs.statSync(f).size;
    total += size;
    console.log(`${String(Math.round(size / 1024)).padStart(5)} KB  ${path.relative(ROOT, f)}`);
  }
  console.log(`\ntotal: ${(total / 1024).toFixed(1)} KB across ${written.length} files`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
