import OpenAI from "openai";
import fs from "node:fs";
import { config, SUPPRESSED_TAGS } from "./config.js";

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

export interface CharacterContext {
  id: string;
  name: string;
  refPaths: string[];
}

export interface MatchedCharacter {
  id: string;
  name: string;
}

export interface UnknownPerson {
  description: string;
  frameIndex: number;
}

export interface ClipCaption {
  name: string;
  description: string;
  tags: string[];
  characters: MatchedCharacter[];
  unknownPeople: UnknownPerson[];
}

const BASE_PROMPT = `You are tagging clips for a stock-footage style library.
Given the candidate frames sampled from a single short clip, return JSON with:
- name: 3-7 word headline (Title Case, no trailing period)
- description: one concise sentence (<= 18 words)
- tags: 3-7 lowercase keyword tags (single words or short noun phrases)

Focus on subject, setting, action, mood, camera move. Avoid filler words.
Do NOT include style-of-art tags like "animation", "cartoon", "illustration",
"comic", "drawing", "2d" — the entire library shares one art style, so those
are noise. Tag what is happening, not how it is rendered.`;

// Always asked for — even with zero defined characters. This is how the user
// bootstraps the character library: the AI flags every distinct figure it
// sees, then the UI offers Name / Connect / Ignore on each one.
const UNKNOWN_PEOPLE_INSTRUCTIONS = `Also report every distinct human-like
character visible in the candidate frames as "unknown people" — list each
one even if no labeled references are provided. This is how the catalog
bootstraps its character library from raw footage.

For each unknown person, return:
- frameIndex: 0|1|2 (which sample frame they appear most clearly in)
- description: <=10 word visual description (e.g. "cowboy in tan vest", "white horse")

Don't list the same character twice. Don't invent figures that aren't visible.`;

const CHARACTER_MATCHING_INSTRUCTIONS = `You will also be shown LABELED
CHARACTER REFERENCES. For each candidate frame, decide which of the labeled
characters appear and include their ids in the "characters" field. Any
distinct figures that do NOT match a labeled reference go in "unknownPeople"
(see above).

Only list characters whose face/body actually appears. Do not invent.`;

const RESPONSE_SCHEMA_TEXT = `Respond ONLY with a single JSON object:
{
  "name": "...",
  "description": "...",
  "tags": ["..."],
  "characters": ["<character id>", ...],
  "unknownPeople": [{ "frameIndex": 0, "description": "..." }, ...]
}
"characters" should be an empty array if no labeled references match.
"unknownPeople" should always list every visible human-like figure that
isn't already in "characters".`;

function fileToDataUrl(p: string): string {
  const buf = fs.readFileSync(p);
  const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

const REFS_PER_CHARACTER = 2;
const MAX_CHARACTERS_IN_PROMPT = 10;

export async function captionFromFrames(
  framePaths: string[],
  characters: CharacterContext[] = []
): Promise<ClipCaption> {
  const ai = getOpenAI();

  const candidateImages = framePaths.map((p) => ({
    type: "image_url" as const,
    image_url: { url: fileToDataUrl(p), detail: "low" as const },
  }));

  const usedCharacters = characters.slice(0, MAX_CHARACTERS_IN_PROMPT);
  const characterParts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" } }
  > = [];
  if (usedCharacters.length > 0) {
    characterParts.push({
      type: "text",
      text: "LABELED CHARACTER REFERENCES (followed by their reference images):",
    });
    for (const c of usedCharacters) {
      characterParts.push({
        type: "text",
        text: `Character id="${c.id}" name="${c.name}"`,
      });
      const refs = c.refPaths.slice(0, REFS_PER_CHARACTER);
      for (const r of refs) {
        characterParts.push({
          type: "image_url",
          image_url: { url: fileToDataUrl(r), detail: "low" as const },
        });
      }
    }
  }

  const promptText =
    BASE_PROMPT +
    "\n\n" +
    UNKNOWN_PEOPLE_INSTRUCTIONS +
    (usedCharacters.length > 0
      ? "\n\n" + CHARACTER_MATCHING_INSTRUCTIONS
      : "") +
    "\n\n" +
    RESPONSE_SCHEMA_TEXT;

  const response = await ai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "text", text: "CANDIDATE FRAMES:" },
          ...candidateImages,
          ...characterParts,
        ],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const tags: string[] = Array.isArray(parsed.tags)
    ? parsed.tags
        .map((t: unknown) => String(t).toLowerCase().trim())
        .filter((t: string) => t && !SUPPRESSED_TAGS.has(t))
        .slice(0, 10)
    : [];

  const charIds: string[] = Array.isArray(parsed.characters)
    ? parsed.characters.map((x: unknown) => String(x))
    : [];
  const charById = new Map(usedCharacters.map((c) => [c.id, c]));
  const matched: MatchedCharacter[] = [];
  const seen = new Set<string>();
  for (const id of charIds) {
    if (seen.has(id)) continue;
    const c = charById.get(id);
    if (c) {
      matched.push({ id: c.id, name: c.name });
      seen.add(id);
    }
  }

  const unknownPeople: UnknownPerson[] = Array.isArray(parsed.unknownPeople)
    ? parsed.unknownPeople
        .map((u: any) => ({
          description: String(u?.description ?? "").trim().slice(0, 200),
          frameIndex: Math.max(
            0,
            Math.min(framePaths.length - 1, Number(u?.frameIndex ?? 0))
          ),
        }))
        .filter((u: UnknownPerson) => u.description)
        .slice(0, 5)
    : [];

  return {
    name: (parsed.name ?? "Untitled Clip").toString().slice(0, 120),
    description: (parsed.description ?? "").toString().slice(0, 400),
    tags,
    characters: matched,
    unknownPeople,
  };
}
