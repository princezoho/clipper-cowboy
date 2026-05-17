import fs from "node:fs";
import zlib from "node:zlib";

/**
 * Pure-JS PNG metadata reader. Walks chunks and decodes textual entries
 * (`tEXt`, `iTXt`, `zTXt`) into a flat `{ key: value }` map. No native deps.
 *
 * Returns `{}` on any non-PNG / unreadable / corrupt file — never throws.
 *
 * The map is then funnelled through {@link derivePromptString} to produce a
 * single best-effort "prompt" string covering the common generators
 * (Auto1111, Fooocus, ComfyUI, Midjourney).
 */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface PngInfo {
  /** Flat key -> value map of every text chunk in the PNG. */
  text: Record<string, string>;
  /** First image header dimensions, if present. */
  width?: number;
  height?: number;
}

export function readPngInfo(filePath: string): PngInfo {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { text: {} };
  }
  return parsePngBuffer(buf);
}

export function parsePngBuffer(buf: Buffer): PngInfo {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { text: {} };
  }
  const out: PngInfo = { text: {} };
  let off = 8;
  // Hard limit to keep us from looping on a corrupt file forever.
  let chunks = 0;
  while (off + 8 <= buf.length && chunks < 4096) {
    chunks += 1;
    const length = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);

    try {
      if (type === "IHDR" && length >= 8) {
        out.width = data.readUInt32BE(0);
        out.height = data.readUInt32BE(4);
      } else if (type === "tEXt") {
        const sep = data.indexOf(0);
        if (sep > 0) {
          const key = data.toString("latin1", 0, sep);
          const value = data.toString("latin1", sep + 1);
          if (key) out.text[key] = value;
        }
      } else if (type === "zTXt") {
        const sep = data.indexOf(0);
        if (sep > 0 && sep + 2 < data.length) {
          const key = data.toString("latin1", 0, sep);
          // data[sep+1] = compression method (always 0 = deflate)
          const compressed = data.subarray(sep + 2);
          try {
            const value = zlib.inflateSync(compressed).toString("utf8");
            if (key) out.text[key] = value;
          } catch {
            // skip undecodable chunk
          }
        }
      } else if (type === "iTXt") {
        // Layout: keyword \0 compFlag(1) compMethod(1) langTag \0 transKey \0 text
        const k1 = data.indexOf(0);
        if (k1 > 0 && k1 + 2 < data.length) {
          const key = data.toString("latin1", 0, k1);
          const compFlag = data[k1 + 1];
          // skip langTag
          const k2 = data.indexOf(0, k1 + 3);
          if (k2 > 0) {
            const k3 = data.indexOf(0, k2 + 1);
            if (k3 > 0 && k3 + 1 <= data.length) {
              const textBytes = data.subarray(k3 + 1);
              let value: string;
              if (compFlag === 1) {
                try {
                  value = zlib.inflateSync(textBytes).toString("utf8");
                } catch {
                  value = "";
                }
              } else {
                value = textBytes.toString("utf8");
              }
              if (key && value) out.text[key] = value;
            }
          }
        }
      }
    } catch {
      // tolerate malformed individual chunks
    }

    if (type === "IEND") break;
    off = dataEnd + 4; // skip CRC
  }
  return out;
}

/**
 * Best-effort: collapse all known generator metadata into a single prompt
 * string. Order: `parameters` (Auto1111/Fooocus, split before Negative/Steps),
 * then `prompt` (often raw JSON for ComfyUI — kept verbatim), then
 * `Description` (Midjourney).
 *
 * Returns `""` when no recognizable text is present.
 */
export function derivePromptString(text: Record<string, string>): string {
  const parameters = text["parameters"];
  if (parameters && parameters.trim()) {
    // Strip everything from the first "Negative prompt:" or "Steps:" onward —
    // those are settings, not the prompt body.
    const cut = parameters.search(/\n?(Negative prompt:|Steps:)/i);
    const head = (cut >= 0 ? parameters.slice(0, cut) : parameters).trim();
    if (head) return head;
  }
  const prompt = text["prompt"];
  if (prompt && prompt.trim()) return prompt.trim();
  const description = text["Description"];
  if (description && description.trim()) return description.trim();
  // Catch-all: any com.midjourney.* key with a non-empty value.
  for (const [k, v] of Object.entries(text)) {
    if (k.toLowerCase().startsWith("com.midjourney") && v && v.trim()) {
      return v.trim();
    }
  }
  return "";
}
