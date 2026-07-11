#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// The integration deliberately gives Stem Studio a fresh allowlisted
// environment. Failing here makes credential inheritance a hard test failure.
if (process.env.OPENAI_API_KEY || process.env.CLIPPER_API_TOKEN) {
  process.exit(42);
}

let separation = null;
let checks = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function tool(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  };
}

function delivery() {
  const base = path.basename(
    separation.input_path,
    path.extname(separation.input_path)
  );
  fs.mkdirSync(separation.output_dir, { recursive: true });
  const paths = {
    dialogue: path.join(separation.output_dir, `${base}_DIALOGUE.wav`),
    music: path.join(separation.output_dir, `${base}_MUSIC.wav`),
    sfx: path.join(separation.output_dir, `${base}_SFX.wav`),
    married: path.join(separation.output_dir, `${base}_MARRIED.wav`),
    video: path.join(separation.output_dir, `${base}_STEMS.mov`),
  };
  for (const output of Object.values(paths)) {
    fs.writeFileSync(output, `fake media for ${path.basename(output)}\n`);
  }
  return {
    output_dir: separation.output_dir,
    stems: {
      dialogue: paths.dialogue,
      music: paths.music,
      sfx: paths.sfx,
    },
    married: paths.married,
    multitrack_video: paths.video,
  };
}

const tools = [
  "setup_status",
  "probe_media",
  "separate_stems",
  "check_job",
  "cancel_job",
].map((name) => ({ name, inputSchema: { type: "object" } }));

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exit(43);
  }
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    reply({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "stem-studio", version: "1.0.0-test" },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply({ tools });
    return;
  }
  if (message.method !== "tools/call") {
    reply({});
    return;
  }
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === "setup_status") {
    setTimeout(() => reply(tool({ ready: true, device: "cpu" })), 3_000);
  } else if (name === "probe_media") {
    reply(tool({ has_video: true, duration: 1 }));
  } else if (name === "separate_stems") {
    separation = args;
    checks = 0;
    reply(tool({ job_id: "fake-separation", status: "running" }));
  } else if (name === "check_job") {
    checks += 1;
    if (checks < 2) {
      reply(
        tool({
          job_id: "fake-separation",
          status: "running",
          stage: "separating",
          percent: 50,
        })
      );
    } else {
      reply(
        tool({
          job_id: "fake-separation",
          status: "done",
          stage: "done",
          percent: 100,
          result: delivery(),
        })
      );
    }
  } else if (name === "cancel_job") {
    reply(tool({ job_id: args.job_id, status: "cancelled" }));
  } else {
    reply(tool({ error: "unknown test tool" }, true));
  }
});
