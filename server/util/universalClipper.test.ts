import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "clipper-universal-test-")
);
process.env.PROJECT_DIR = fixture;

const {
  STEM_ROLES,
  clipSheetCsv,
  executeUniversalPackage,
  planUniversalPackage,
  publishUniversalStemReturns,
} = await import("./universalClipper.js");
const {
  buildPremierePackageManifest,
  findUniversalPackage,
  readPremiereImportAcknowledgement,
  writePremiereImportAcknowledgement,
} = await import("./universalPackageStore.js");
const require = createRequire(import.meta.url);
const premiereCore = require("../../adobe-premiere/src/core.js") as {
  buildImportPlan: (
    manifest: unknown,
    projectItems: { id: string; mediaPath: string }[],
    acknowledgements: unknown[]
  ) => {
    counts: {
      existing: number;
      willImport: number;
      unresolved: number;
      invalid: number;
    };
    groups: unknown[];
  };
};

const roots = {
  projectDir: fixture,
  clipMetaDir: path.join(fixture, ".clipcataloger", "clip-meta"),
  clipsDir: path.join(fixture, "clips"),
  outputRoot: path.join(fixture, "derived", "universal-clipper"),
};
for (const dir of [roots.clipMetaDir, roots.clipsDir, roots.outputRoot]) {
  fs.mkdirSync(dir, { recursive: true });
}

test.after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceId(file: string): string {
  return crypto
    .createHash("sha1")
    .update(path.resolve(file))
    .digest("hex")
    .slice(0, 16);
}

function silentWav(seconds: number): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bits = 16;
  const dataSize = Math.round(seconds * sampleRate) * channels * (bits / 8);
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  out.writeUInt16LE(channels * (bits / 8), 32);
  out.writeUInt16LE(bits, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  return out;
}

function addClip(input: {
  id: string;
  sourceId: string;
  sourcePath: string;
  name: string;
  inT: number;
  outT: number;
  notes?: string;
  tags?: string[];
}) {
  const clipPath = path.join(roots.clipsDir, `${input.id}.mov`);
  fs.writeFileSync(clipPath, `existing clip ${input.id}`);
  fs.writeFileSync(
    path.join(roots.clipMetaDir, `${input.id}.json`),
    JSON.stringify({
      id: input.id,
      name: input.name,
      description: input.notes ?? "",
      tags: input.tags ?? [],
      filename: path.basename(clipPath),
      path: clipPath,
      sourceId: input.sourceId,
      sourcePath: input.sourcePath,
      source: path.basename(input.sourcePath),
      in: input.inT,
      out: input.outT,
      duration: input.outT - input.inT,
      created: Date.now(),
    })
  );
}

const sourceA = path.join(fixture, "A", "Scene.mov");
const sourceB = path.join(fixture, "B", "scene.mov");
fs.mkdirSync(path.dirname(sourceA), { recursive: true });
fs.mkdirSync(path.dirname(sourceB), { recursive: true });
fs.writeFileSync(sourceA, "SOURCE-A-MUST-SURVIVE");
fs.writeFileSync(sourceB, "SOURCE-B-MUST-SURVIVE");
addClip({
  id: "1111111111111111",
  sourceId: sourceId(sourceA),
  sourcePath: sourceA,
  name: "Close, \"quoted\"",
  inT: 1,
  outT: 2,
  notes: "line one\nline two",
  tags: ["hero", "wide"],
});
addClip({
  id: "2222222222222222",
  sourceId: sourceId(sourceA),
  sourcePath: sourceA,
  name: "Close",
  inT: 3,
  outT: 4,
});
addClip({
  id: "3333333333333333",
  sourceId: sourceId(sourceB),
  sourcePath: sourceB,
  name: "Other",
  inT: 0,
  outT: 1,
});

test("planner groups sources and produces adjacent deterministic stem names", () => {
  const plan = planUniversalPackage(
    ["1111111111111111", "2222222222222222", "3333333333333333"],
    "../Premiere: handoff",
    roots
  );
  assert.equal(plan.sourceCount, 2);
  assert.equal(plan.selectedClipCount, 3);
  assert.equal(plan.mediaDirectory, "media");
  assert.equal(plan.expectedAssetCount, 25);
  assert.deepEqual(plan.stemExecution.roles, STEM_ROLES);
  const names = plan.sources.map((source) => source.fullSourceFilename);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
  const first = plan.sources[0];
  assert.equal(first.fullSourceFilename, "Scene.mov");
  assert.equal(first.clips[0].outputFilename, "Scene__clip-01.mov");
  assert.equal(first.clips[0].stems[0].filename, "Scene__clip-01__DIALOGUE.wav");
  assert.equal(first.clips[0].stems[0].groupId, first.clips[0].groupId);
  assert.equal(first.clips[0].stems[0].inSeconds, first.clips[0].inSeconds);
  assert.equal(first.clips[0].stems[0].outSeconds, first.clips[0].outSeconds);
  const sorted = [
    first.fullSourceFilename,
    ...first.stems.map((stem) => stem.filename),
    ...first.clips.flatMap((clip) => [
      clip.outputFilename,
      ...clip.stems.map((stem) => stem.filename),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  assert.equal(sorted.every((name) => name.startsWith("Scene")), true);
});

test("planner rejects invalid IDs and traversal-shaped IDs", () => {
  assert.equal(findUniversalPackage("../../etc/passwd"), null);
  assert.throws(
    () => planUniversalPackage(["../../etc/passwd"], "bad", roots),
    /invalid clip id/
  );
  assert.throws(
    () => planUniversalPackage(["1111111111111111", "1111111111111111"], "bad", roots),
    /duplicate clip ids/
  );
  addClip({
    id: "4444444444444444",
    sourceId: "ffffffffffffffff",
    sourcePath: sourceA,
    name: "Tampered source identity",
    inT: 0,
    outT: 1,
  });
  assert.throws(
    () => planUniversalPackage(["4444444444444444"], "bad", roots),
    /source identity\/path mismatch/
  );
});

test("executor preserves sources, allocates unique packages, and writes linked manifests", async () => {
  const beforeA = sha(sourceA);
  const fakeCut = async (
    _source: string,
    inT: number,
    outT: number,
    outputPath: string
  ) => {
    fs.writeFileSync(outputPath, `generated fixture ${inT}-${outT}`, { flag: "wx" });
    return {
      outputPath,
      mode: "smart-cut" as const,
      details: "test fixture cut; no real media processed",
    };
  };
  const ids = ["1111111111111111", "2222222222222222"];
  const first = await executeUniversalPackage(ids, "Premiere handoff", {
    roots,
    cut: fakeCut,
    confirmedStemHandoff: true,
  });
  const second = await executeUniversalPackage(ids, "Premiere handoff", {
    roots,
    cut: fakeCut,
    confirmedStemHandoff: true,
  });
  assert.notEqual(first.folder, second.folder);
  assert.equal(sha(sourceA), beforeA);
  assert.equal(fs.existsSync(sourceA), true);
  const media = fs.readdirSync(path.join(first.folder, "media"));
  assert.equal(media.includes("Scene.mov"), true);
  assert.equal(media.includes("Scene__clip-01.mov"), true);
  assert.equal(media.some((name) => name.endsWith(".wav")), false);
  assert.equal(fs.existsSync(path.join(first.folder, "stem-handoff.json")), true);
  assert.equal(first.sheet.clips[0].stems.length, STEM_ROLES.length);
  assert.equal(first.sheet.clips[0].stems.every((stem) => stem.status === "planned"), true);
  const csv = clipSheetCsv(first.sheet);
  assert.match(csv, /"clip-stem"/);
  assert.match(csv, /"Close, ""quoted"""/);
  assert.match(csv, /"line one\nline two"/);
  const json = JSON.parse(
    fs.readFileSync(path.join(first.folder, "clip-sheet.json"), "utf8")
  );
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.clips[0].groupId, json.clips[0].stems[0].groupId);
  assert.equal(json.originalsPolicy, "read-only-unchanged");

  const returnedNames = first.sheet.clips[0].stems.map((stem) => stem.filename);
  for (const returnedName of returnedNames) {
    fs.writeFileSync(
      path.join(first.folder, "stem-inbox", returnedName),
      silentWav(1)
    );
  }
  const published = await publishUniversalStemReturns(first.folder, roots);
  assert.equal(published.published, STEM_ROLES.length);
  assert.equal(
    fs.existsSync(path.join(first.folder, "media", returnedNames[0])),
    true
  );
  const updated = JSON.parse(
    fs.readFileSync(path.join(first.folder, "clip-sheet.json"), "utf8")
  );
  assert.equal(updated.clips[0].stems[0].status, "included");

  const storedPackage = findUniversalPackage(first.sheet.packageId);
  assert.ok(storedPackage);
  const premiereManifest = buildPremierePackageManifest(storedPackage);
  const sourceAsset = premiereManifest.groups[0].assets[0];
  const importPlan = premiereCore.buildImportPlan(
    premiereManifest,
    [{ id: "existing-source", mediaPath: sourceAsset.mediaPath! }],
    []
  );
  assert.equal(importPlan.groups.length, 3);
  assert.equal(importPlan.counts.existing, 1);
  assert.equal(importPlan.counts.willImport > 0, true);
  assert.equal(importPlan.counts.unresolved > 0, true);
  assert.throws(
    () =>
      writePremiereImportAcknowledgement(
        first.sheet.packageId,
        "fixture-project",
        [
          {
            assetId: "../../arbitrary-path",
            projectItemId: "item-1",
            status: "imported",
          },
        ]
      ),
    /invalid import mapping/
  );
  const accepted = writePremiereImportAcknowledgement(
    first.sheet.packageId,
    "fixture-project",
    [
      {
        assetId: sourceAsset.assetId,
        projectItemId: "existing-source",
        status: "existing",
      },
    ]
  );
  assert.equal(accepted.length, 1);
  assert.equal(
    readPremiereImportAcknowledgement(
      first.sheet.packageId,
      "fixture-project"
    )[0].assetId,
    sourceAsset.assetId
  );
});

test("executor requires explicit stem handoff confirmation", async () => {
  await assert.rejects(
    executeUniversalPackage(["3333333333333333"], "unconfirmed", {
      roots,
      cut: async () => {
        throw new Error("must not run");
      },
    }),
    /explicit stem handoff confirmation/
  );
});
