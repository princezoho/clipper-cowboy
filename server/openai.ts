import OpenAI from "openai";
import fs from "node:fs";
import { config } from "./config.js";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!config.openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to your .env file (see .env.example)."
    );
  }
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

export interface ClipCaption {
  name: string;
  description: string;
  tags: string[];
}

const CAPTION_PROMPT = `You are tagging clips for a stock-footage style library.
Given these frames sampled from a single short clip, return JSON with:
- name: 3-7 word headline (Title Case, no trailing period)
- description: one concise sentence (<= 18 words)
- tags: 3-7 lowercase keyword tags (single words or short noun phrases)

Focus on subject, setting, action, mood, camera move. Avoid filler words.
Respond ONLY with valid JSON: {"name": "...", "description": "...", "tags": ["..."]}.`;

function fileToDataUrl(p: string): string {
  const buf = fs.readFileSync(p);
  const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function captionFromFrames(
  framePaths: string[]
): Promise<ClipCaption> {
  const ai = getOpenAI();
  const images = framePaths.map((p) => ({
    type: "image_url" as const,
    image_url: { url: fileToDataUrl(p), detail: "low" as const },
  }));

  const response = await ai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CAPTION_PROMPT },
          ...images,
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let parsed: Partial<ClipCaption> = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return {
    name: (parsed.name ?? "Untitled Clip").toString().slice(0, 120),
    description: (parsed.description ?? "").toString().slice(0, 400),
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 10)
      : [],
  };
}
