import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "clipper-universal-stems-test-")
);
process.env.PROJECT_DIR = fixture;

const {
  UniversalStemManager,
  universalStemTestHelpers,
} = await import("./universalManager.js");
const { buildPremierePackageManifest, findUniversalPackage } = await import(
  "../util/universalPackageStore.js"
);
const {
  hasMatchingLiveFixtureVerification,
  recordLiveFixtureVerification,
  resolveConfiguredStemMcp,
  saveStemMcpEntry,
} = await import("./connectorSettings.js");
const { UNIVERSAL_CLIPPER_SCHEMA } = await import(
  "../util/universalClipper.js"
);

test.after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

function silentWav(seconds: number, sampleRate = 48_000, channels = 2): Buffer {
  const bits = 16;
  const samples = Math.round(seconds * sampleRate);
  const dataSize = samples * channels * (bits / 8);
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

function digest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createOfficialMcpEntry(): string {
  const mcpRoot = path.join(fixture, "official-stem-studio", "mcp");
  const dist = path.join(mcpRoot, "dist");
  const entry = path.join(dist, "index.js");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(entry, "// generated test entry\n");
  fs.writeFileSync(
    path.join(mcpRoot, "package.json"),
    JSON.stringify({
      name: "stem-studio-mcp",
      version: "1.1.0",
      type: "module",
      main: "./dist/index.js",
      bin: { "stem-studio-mcp": "./dist/index.js" },
    })
  );
  return entry;
}

function createPackage(packageId = "11111111-1111-4111-8111-111111111111") {
  const folder = path.join(
    fixture,
    "derived",
    "universal-clipper",
    `fixture-${packageId.slice(0, 8)}`
  );
  const mediaDir = path.join(folder, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const sourceFile = path.join(mediaDir, "scene137.wav");
  const clipFile = path.join(mediaDir, "scene137__clip-01.wav");
  fs.writeFileSync(sourceFile, silentWav(2));
  fs.writeFileSync(clipFile, silentWav(1));
  const roles = ["DIALOGUE", "MUSIC", "SFX", "MARRIED"] as const;
  const sourceGroup = "source:aaaaaaaaaaaaaaaa";
  const clipGroup = `${sourceGroup}:clip:bbbbbbbbbbbbbbbb`;
  const now = new Date().toISOString();
  const sheet = {
    schema: UNIVERSAL_CLIPPER_SCHEMA,
    schemaVersion: 1 as const,
    packageId,
    packageName: "fixture",
    createdAt: now,
    handoff: "premiere-uxp-with-finder-fallback" as const,
    sourcePathPrivacy: "fixture",
    qualityStrategy: "fixture",
    originalsPolicy: "read-only-unchanged" as const,
    stemExecution: {
      status: "not_requested" as const,
      quality: null,
      jobId: null,
      stage: "Prepared",
      percent: 0,
      message: "Prepared",
      updatedAt: now,
    },
    premiere: {
      platform: "UXP" as const,
      minimumVersion: "25.6.0" as const,
      metadataPersistence: "clipper-local-mapping" as const,
      timelineMutation: "explicit-only" as const,
    },
    sources: [
      {
        sourceId: "aaaaaaaaaaaaaaaa",
        sourceAirTagId: null,
        sourcePath: sourceFile,
        sourceFilename: "scene137.wav",
        fullSourceFilename: "scene137.wav",
        fullSourceAirTagId: null,
        groupId: sourceGroup,
        stems: roles.map((stemRole) => ({
          groupId: sourceGroup,
          sourceId: "aaaaaaaaaaaaaaaa",
          clipId: null,
          stemRole,
          inSeconds: 0,
          outSeconds: null,
          filename: `scene137__${stemRole}.wav`,
          path: null,
          airTagId: null,
          status: "planned" as const,
          alignment: "planned",
        })),
        lineage: {
          relation: "derived-copy" as const,
          sourceAirTagId: null,
          outputAirTagId: null,
          lifeHistoryLookup: {
            sourcePath: sourceFile,
            outputPath: sourceFile,
          },
        },
      },
    ],
    clips: [
      {
        groupId: clipGroup,
        clipId: "bbbbbbbbbbbbbbbb",
        clipAirTagId: null,
        outputAirTagId: null,
        sourceId: "aaaaaaaaaaaaaaaa",
        sourceAirTagId: null,
        sourcePath: sourceFile,
        sourcePathPrivacy: "local-absolute-path" as const,
        sourceFilename: "scene137.wav",
        sourceInSeconds: 0.5,
        sourceOutSeconds: 1.5,
        durationSeconds: 1,
        sourceInTimecode: null,
        sourceOutTimecode: null,
        timecodeNote: "seconds canonical",
        name: "Fixture clip",
        label: "Fixture clip",
        tags: [],
        notes: "",
        characters: [],
        scenes: [],
        objects: [],
        outputFilename: "scene137__clip-01.wav",
        exportPath: clipFile,
        fullSourceFilename: "scene137.wav",
        fullSourcePath: sourceFile,
        fullSourceAirTagId: null,
        exportMethod: "smart-cut" as const,
        exportDetails: "fixture",
        lineage: {
          relation: "derived-copy" as const,
          sourceAirTagId: null,
          outputAirTagId: null,
          lifeHistoryLookup: {
            sourcePath: sourceFile,
            outputPath: clipFile,
          },
        },
        stems: roles.map((stemRole) => ({
          groupId: clipGroup,
          sourceId: "aaaaaaaaaaaaaaaa",
          clipId: "bbbbbbbbbbbbbbbb",
          stemRole,
          inSeconds: 0.5,
          outSeconds: 1.5,
          filename: `scene137__clip-01__${stemRole}.wav`,
          path: null,
          airTagId: null,
          status: "planned" as const,
          alignment: "planned",
        })),
      },
    ],
  };
  fs.writeFileSync(
    path.join(folder, "clip-sheet.json"),
    JSON.stringify(sheet, null, 2)
  );
  fs.writeFileSync(
    path.join(folder, "stem-handoff.json"),
    JSON.stringify({ schema: "fixture" })
  );
  return { folder, mediaDir, sourceFile, sheet };
}

function createDelivery(root: string, seconds = 2) {
  fs.mkdirSync(root, { recursive: true });
  const files = {
    dialogue: path.join(root, "scene_DIALOGUE.wav"),
    music: path.join(root, "scene_MUSIC.wav"),
    sfx: path.join(root, "scene_SFX.wav"),
    married: path.join(root, "scene_MARRIED.wav"),
  };
  for (const file of Object.values(files)) {
    fs.writeFileSync(file, silentWav(seconds), { flag: "wx" });
  }
  return {
    stems: {
      dialogue: files.dialogue,
      music: files.music,
      sfx: files.sfx,
    },
    married: files.married,
  };
}

test("stores only a validated connector path in private central settings", () => {
  const entry = createOfficialMcpEntry();
  const settingsFile = path.join(fixture, ".clipcataloger", "integrations-test.json");
  const verificationFile = path.join(
    fixture,
    ".clipcataloger",
    "stem-verification-test.json"
  );
  const saved = saveStemMcpEntry(entry, settingsFile);
  const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(stored).sort(), [
    "schemaVersion",
    "stemStudioMcpEntry",
  ]);
  assert.equal(stored.stemStudioMcpEntry, fs.realpathSync(entry));
  assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o600);
  const resolved = resolveConfiguredStemMcp({}, settingsFile);
  assert.equal(resolved.source, "settings");
  assert.equal(resolved.config?.entry, saved.entry);
  assert.equal(
    hasMatchingLiveFixtureVerification(saved, verificationFile),
    false
  );
  recordLiveFixtureVerification(saved, verificationFile);
  assert.equal(
    hasMatchingLiveFixtureVerification(saved, verificationFile),
    true
  );
});

test("requires an installed model before reporting the connector ready", () => {
  assert.equal(
    universalStemTestHelpers.asReadyStatus({
      ready: true,
      pythonExists: true,
      depsImportable: true,
      modelCachePresent: false,
    }),
    false
  );
  assert.equal(
    universalStemTestHelpers.asReadyStatus({
      ready: true,
      pythonExists: true,
      depsImportable: true,
      modelCachePresent: true,
    }),
    true
  );
});

test("validates full stems, derives exact clip stems, and publishes flat names", async () => {
  createPackage();
  const location = findUniversalPackage(
    "11111111-1111-4111-8111-111111111111"
  );
  assert.ok(location);
  const outputRoot = path.join(fixture, "derived", "stems", "fixture-output");
  const flatStage = path.join(outputRoot, "package-flat");
  fs.mkdirSync(flatStage, { recursive: true });
  const delivery = createDelivery(path.join(outputRoot, "source-01"));
  const before = digest(location.mediaDir + "/scene137.wav");
  const prepared = await universalStemTestHelpers.prepareSourceOutputs(
    location,
    location.sheet.sources[0],
    delivery,
    path.join(outputRoot, "source-01"),
    flatStage
  );
  assert.equal(prepared.length, 8);
  universalStemTestHelpers.publishPreparedBatch(location, prepared);
  assert.equal(digest(location.mediaDir + "/scene137.wav"), before);
  const names = fs.readdirSync(location.mediaDir);
  assert.equal(names.includes("scene137__DIALOGUE.wav"), true);
  assert.equal(names.includes("scene137__clip-01__DIALOGUE.wav"), true);
  const clipStem = location.sheet.clips[0].stems[0];
  assert.equal(clipStem.status, "included");
  assert.equal(clipStem.validation?.sampleRate, 48_000);
  assert.equal(Math.abs((clipStem.validation?.durationSeconds ?? 0) - 1) < 0.01, true);
});

test("rejects mismatched returns before any flat publication", async () => {
  createPackage("22222222-2222-4222-8222-222222222222");
  const location = findUniversalPackage(
    "22222222-2222-4222-8222-222222222222"
  );
  assert.ok(location);
  const outputRoot = path.join(fixture, "derived", "stems", "mismatch-output");
  const sourceRoot = path.join(outputRoot, "source-01");
  const flatStage = path.join(outputRoot, "package-flat");
  fs.mkdirSync(flatStage, { recursive: true });
  const delivery = createDelivery(sourceRoot);
  fs.rmSync(delivery.stems.music);
  fs.writeFileSync(delivery.stems.music, silentWav(1), { flag: "wx" });
  await assert.rejects(
    universalStemTestHelpers.prepareSourceOutputs(
      location,
      location.sheet.sources[0],
      delivery,
      sourceRoot,
      flatStage
    ),
    /does not align/
  );
  assert.equal(
    fs.existsSync(path.join(location.mediaDir, "scene137__DIALOGUE.wav")),
    false
  );
});

test("enters setup-required and never calls setup_environment", async () => {
  createPackage("33333333-3333-4333-8333-333333333333");
  const calls: string[] = [];
  const manager = new UniversalStemManager({
    pollMs: 10,
    configResolver: () => ({
      command: process.execPath,
      args: [],
      entry: process.execPath,
    }),
    sessionFactory: () => ({
      async start() {},
      async listTools() {
        return [
          "setup_status",
          "separate_stems",
          "check_job",
          "cancel_job",
          "setup_environment",
        ].map((name) => ({ name }));
      },
      async callTool<T = unknown>(name: string): Promise<T> {
        calls.push(name);
        if (name === "setup_status") {
          return {
            ready: false,
            pythonExists: false,
            depsImportable: false,
          } as T;
        }
        throw new Error(`unexpected tool ${name}`);
      },
      async close() {},
      diagnostic() {
        return undefined;
      },
    }),
  });
  const queued = manager.enqueue({
    packageId: "33333333-3333-4333-8333-333333333333",
    quality: "high",
    confirmedModelExecution: true,
  });
  let current = manager.get(queued.id)!;
  for (let attempt = 0; attempt < 100 && current.status === "queued"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(queued.id)!;
  }
  assert.equal(current.status, "setup_required");
  assert.deepEqual(calls, ["setup_status"]);
  const location = findUniversalPackage(
    "33333333-3333-4333-8333-333333333333"
  )!;
  assert.equal(
    buildPremierePackageManifest(location).packageStatus,
    "setup_required"
  );
  await manager.shutdown();
});

test("requires explicit Max licensing confirmation", () => {
  createPackage("44444444-4444-4444-8444-444444444444");
  const manager = new UniversalStemManager();
  assert.throws(
    () =>
      manager.enqueue({
        packageId: "44444444-4444-4444-8444-444444444444",
        quality: "max",
        confirmedModelExecution: true,
      }),
    /licensing confirmation/
  );
});
