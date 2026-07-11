import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeRedactor,
  requireContainedFile,
  requireId,
  safeStemOutputDir,
} from "../src/security.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP security helpers", () => {
  it("accepts only canonical 16-hex IDs", () => {
    expect(requireId("0123456789abcdef", "clip_id")).toBe("0123456789abcdef");
    expect(() => requireId("../../.env", "clip_id")).toThrow(/16-character/);
    expect(() => requireId("ABCDEF0123456789", "clip_id")).toThrow(/16-character/);
  });

  it("rejects sibling paths and symlink escapes", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-security-"));
    cleanup.push(base);
    const root = path.join(base, "project");
    const sibling = path.join(base, "project-evil");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    const safe = path.join(root, "safe.mov");
    const outside = path.join(sibling, "outside.mov");
    fs.writeFileSync(safe, "safe");
    fs.writeFileSync(outside, "outside");
    expect(requireContainedFile(root, safe)).toBe(fs.realpathSync(safe));
    expect(() => requireContainedFile(root, outside)).toThrow(/outside/);
    const link = path.join(root, "link.mov");
    fs.symlinkSync(outside, link);
    expect(() => requireContainedFile(root, link)).toThrow(/outside/);
  });

  it("redacts explicit and recognized credential shapes", () => {
    const redact = makeRedactor({ OPENAI_API_KEY: "unit-test-secret-sentinel" });
    const tokenShape = "sk-" + "abcdefghijklmnopqrstuvwxyz";
    expect(redact(`bad unit-test-secret-sentinel ${tokenShape}`)).toBe(
      "bad [REDACTED] [REDACTED]"
    );
    expect(redact("x".repeat(3_000))).toHaveLength(3_000);
    const escapedSecret = 'abc"defgh';
    const escapedRedactor = makeRedactor({ SERVICE_TOKEN: escapedSecret });
    expect(escapedRedactor(JSON.stringify({ value: escapedSecret }))).not.toContain("abc");
  });

  it("never lets dot-only clip names escape the stems directory", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-stems-path-"));
    cleanup.push(base);
    const stems = path.join(base, "derived", "stems");
    fs.mkdirSync(stems, { recursive: true });
    expect(
      safeStemOutputDir(stems, path.join(base, "clips", "...mov"), "0123456789abcdef")
    ).toBe(path.join(fs.realpathSync(stems), "clip-0123456789abcdef"));
    expect(
      safeStemOutputDir(stems, path.join(base, "clips", "Scene.mov"), "0123456789abcdef")
    ).toBe(path.join(fs.realpathSync(stems), "Scene"));
  });
});
