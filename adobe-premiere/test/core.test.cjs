const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../src/core.js");

function manifest(overrides = {}) {
  return {
    schema: "clipper-cowboy/premiere-package@1",
    packageId: "11111111-1111-4111-8111-111111111111",
    packageName: "Premiere handoff",
    createdAt: "2026-07-13T00:00:00.000Z",
    packageStatus: "ready",
    premiereReady: true,
    minimumPremiereVersion: "25.6.0",
    stemExecution: {
      status: "ready",
      quality: "high",
      jobId: "22222222-2222-4222-8222-222222222222",
      stage: "Ready",
      percent: 100,
      message: "Ready",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
    groups: [
      {
        groupId: "source:aaaaaaaaaaaaaaaa",
        sourceId: "aaaaaaaaaaaaaaaa",
        clipId: null,
        label: "scene137.mov",
        airTagId: "source-airtag",
        assets: [
          {
            assetId: "source:aaaaaaaaaaaaaaaa:video",
            groupId: "source:aaaaaaaaaaaaaaaa",
            kind: "full-source",
            sourceId: "aaaaaaaaaaaaaaaa",
            clipId: null,
            stemRole: null,
            filename: "scene137.mov",
            mediaPath: "/project/derived/universal/media/scene137.mov",
            airTagId: "source-airtag",
            status: "ready",
            relationship: "source-video",
          },
        ],
      },
      {
        groupId: "source:aaaaaaaaaaaaaaaa:clip:bbbbbbbbbbbbbbbb",
        sourceId: "aaaaaaaaaaaaaaaa",
        clipId: "bbbbbbbbbbbbbbbb",
        label: "Hero closeup",
        airTagId: "clip-airtag",
        assets: [
          {
            assetId:
              "source:aaaaaaaaaaaaaaaa:clip:bbbbbbbbbbbbbbbb:video",
            groupId: "source:aaaaaaaaaaaaaaaa:clip:bbbbbbbbbbbbbbbb",
            kind: "clip",
            sourceId: "aaaaaaaaaaaaaaaa",
            clipId: "bbbbbbbbbbbbbbbb",
            stemRole: null,
            filename: "scene137__clip-01.mov",
            mediaPath:
              "/project/derived/universal/media/scene137__clip-01.mov",
            airTagId: "clip-airtag",
            status: "ready",
            relationship: "clip-video",
          },
          {
            assetId:
              "source:aaaaaaaaaaaaaaaa:clip:bbbbbbbbbbbbbbbb:stem:DIALOGUE",
            groupId: "source:aaaaaaaaaaaaaaaa:clip:bbbbbbbbbbbbbbbb",
            kind: "stem",
            sourceId: "aaaaaaaaaaaaaaaa",
            clipId: "bbbbbbbbbbbbbbbb",
            stemRole: "DIALOGUE",
            filename: "scene137__clip-01__DIALOGUE.wav",
            mediaPath:
              "/project/derived/universal/media/scene137__clip-01__DIALOGUE.wav",
            airTagId: "dialogue-airtag",
            status: "ready",
            relationship: "clip-stem",
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("deduplicates canonical media path before mappings", () => {
  const value = manifest();
  const plan = core.buildImportPlan(
    value,
    [
      {
        id: "premiere-source",
        name: "renamed in Premiere",
        mediaPath: "/PROJECT/derived/universal/media/scene137.mov",
      },
    ],
    [
      {
        assetId: value.groups[0].assets[0].assetId,
        projectItemId: "stale-mapping",
      },
    ],
    "darwin"
  );
  assert.equal(plan.counts.existing, 1);
  assert.equal(plan.counts.willImport, 2);
  assert.equal(plan.groups[0].entries[0].matchedBy, "canonical-path");
});

test("does not deduplicate solely by filename", () => {
  const plan = core.buildImportPlan(
    manifest(),
    [
      {
        id: "wrong-file",
        name: "scene137.mov",
        mediaPath: "/another/project/scene137.mov",
      },
    ],
    [],
    "darwin"
  );
  assert.equal(plan.counts.existing, 0);
  assert.equal(plan.counts.willImport, 3);
});

test("uses trusted Clipper mapping and AirTag fallback", () => {
  const value = manifest();
  const plan = core.buildImportPlan(
    value,
    [
      {
        id: "mapped-clip",
        mediaPath: "/moved/clip.mov",
      },
      {
        id: "airtag-dialogue",
        mediaPath: "/moved/dialogue.wav",
        airTagId: "dialogue-airtag",
      },
    ],
    [
      {
        assetId: value.groups[1].assets[0].assetId,
        projectItemId: "mapped-clip",
      },
    ]
  );
  assert.equal(plan.groups[1].entries[0].matchedBy, "clipper-mapping");
  assert.equal(plan.groups[1].entries[1].matchedBy, "airtag");
});

test("retry becomes idempotent after imported paths appear", () => {
  const value = manifest();
  const initial = core.buildImportPlan(value, [], []);
  assert.equal(initial.counts.willImport, 3);
  const imported = value.groups.flatMap((group) =>
    group.assets.map((asset, index) => ({
      id: `item-${group.groupId}-${index}`,
      mediaPath: asset.mediaPath,
    }))
  );
  const retry = core.buildImportPlan(value, imported, []);
  assert.equal(retry.counts.existing, 3);
  assert.equal(retry.counts.willImport, 0);
  assert.deepEqual(core.importBatches(retry), []);
});

test("rejects traversal-shaped filenames and incomplete package imports", () => {
  const unsafe = manifest();
  unsafe.groups[0].assets[0].filename = "../scene137.mov";
  assert.throws(
    () => core.validatePackageManifest(unsafe),
    /invalid or duplicate asset/
  );

  const pending = manifest({
    packageStatus: "stems_pending",
    premiereReady: false,
  });
  pending.groups[1].assets[1].status = "pending";
  pending.groups[1].assets[1].mediaPath = null;
  const plan = core.buildImportPlan(pending, [], []);
  assert.equal(plan.counts.unresolved, 1);
  assert.equal(plan.canImport, false);
});

test("creates shallow predictable bin names", () => {
  const plan = core.buildImportPlan(manifest(), [], []);
  const batches = core.importBatches(plan);
  assert.equal(batches[0].binName, "scene137");
  assert.equal(batches[1].binName, "scene137");
});
