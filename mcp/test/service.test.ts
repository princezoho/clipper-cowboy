import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { McpConfig } from "../src/config.js";
import { ClipperService } from "../src/service.js";

const config: McpConfig = {
  rootDir: "/tmp/clipper",
  serviceUrl: "http://127.0.0.1:47474",
  autoStart: false,
  debug: false,
};

describe("ClipperService identity checks", () => {
  it("treats a reachable non-JSON port as a service mismatch", async () => {
    const service = new ClipperService(config, {}, String, {
      fetchImpl: async () => new Response("not clipper", { status: 200 }),
    });
    await expect(service.status()).rejects.toMatchObject({ code: "SERVICE_MISMATCH" });
  });

  it("accepts only Clipper Cowboy API v1 health", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-service-test-"));
    const clips = path.join(project, "clips");
    const characters = path.join(project, "characters");
    const derived = path.join(project, "derived");
    const stems = path.join(derived, "stems");
    for (const dir of [clips, characters, stems]) fs.mkdirSync(dir, { recursive: true });
    let redirect: RequestInit["redirect"];
    const service = new ClipperService(config, {}, String, {
      fetchImpl: async (_input, init) => {
        redirect = init?.redirect;
        return new Response(JSON.stringify({
          ok: true,
          service: "clipper-cowboy",
          apiVersion: 1,
          projectDir: project,
          clipsDir: clips,
          charactersDir: characters,
          derivedDir: derived,
          stemsDir: stems,
          shotlistMd: path.join(project, "shotlist.md"),
          shotlistCsv: path.join(project, "shotlist.csv"),
          hasOpenAIKey: false,
          projectDirConfigured: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    expect((await service.status())?.service).toBe("clipper-cowboy");
    expect(redirect).toBe("error");
    fs.rmSync(project, { recursive: true, force: true });
  });
});
