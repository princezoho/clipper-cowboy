const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../src/core.js");
const { createPremiereHost } = require("../src/host.js");

let nextId = 1;

class Folder {
  constructor(name) {
    this.kind = "folder";
    this.name = name;
    this.id = `folder-${nextId++}`;
    this.items = [];
  }
  getId() {
    return this.id;
  }
  async getItems() {
    return this.items;
  }
  createBinAction(name) {
    return () => {
      if (!this.items.some((item) => item.kind === "folder" && item.name === name)) {
        this.items.push(new Folder(name));
      }
    };
  }
}

class Clip {
  constructor(name, mediaPath) {
    this.kind = "clip";
    this.name = name;
    this.mediaPath = mediaPath;
    this.id = `clip-${nextId++}`;
  }
  getId() {
    return this.id;
  }
  async getMediaFilePath() {
    return this.mediaPath;
  }
}

function fixtureManifest() {
  const sourceGroup = "source:aaaaaaaaaaaaaaaa";
  const clipGroup = `${sourceGroup}:clip:bbbbbbbbbbbbbbbb`;
  return {
    schema: "clipper-cowboy/premiere-package@1",
    packageId: "11111111-1111-4111-8111-111111111111",
    packageName: "Handoff",
    createdAt: "2026-07-13T00:00:00.000Z",
    packageStatus: "ready",
    premiereReady: true,
    groups: [
      {
        groupId: sourceGroup,
        sourceId: "aaaaaaaaaaaaaaaa",
        clipId: null,
        label: "scene137.mov",
        assets: [
          {
            assetId: `${sourceGroup}:video`,
            groupId: sourceGroup,
            kind: "full-source",
            sourceId: "aaaaaaaaaaaaaaaa",
            clipId: null,
            stemRole: null,
            filename: "scene137.mov",
            mediaPath: "/package/media/scene137.mov",
            airTagId: "source-tag",
            status: "ready",
            relationship: "source-video",
          },
        ],
      },
      {
        groupId: clipGroup,
        sourceId: "aaaaaaaaaaaaaaaa",
        clipId: "bbbbbbbbbbbbbbbb",
        label: "Hero closeup",
        assets: [
          {
            assetId: `${clipGroup}:video`,
            groupId: clipGroup,
            kind: "clip",
            sourceId: "aaaaaaaaaaaaaaaa",
            clipId: "bbbbbbbbbbbbbbbb",
            stemRole: null,
            filename: "scene137__clip-01.mov",
            mediaPath: "/package/media/scene137__clip-01.mov",
            airTagId: "clip-tag",
            status: "ready",
            relationship: "clip-video",
          },
          {
            assetId: `${clipGroup}:stem:DIALOGUE`,
            groupId: clipGroup,
            kind: "stem",
            sourceId: "aaaaaaaaaaaaaaaa",
            clipId: "bbbbbbbbbbbbbbbb",
            stemRole: "DIALOGUE",
            filename: "scene137__clip-01__DIALOGUE.wav",
            mediaPath: "/package/media/scene137__clip-01__DIALOGUE.wav",
            airTagId: "dialogue-tag",
            status: "ready",
            relationship: "clip-stem",
          },
        ],
      },
    ],
  };
}

function hostFixture() {
  const root = new Folder("Root");
  root.items.push(new Clip("Already here", "/package/media/scene137.mov"));
  const importCalls = [];
  const timelineCalls = [];
  const position = { seconds: 12.5 };
  const project = {
    guid: "project-guid",
    name: "Mock Premiere Project",
    path: "/projects/mock.prproj",
    async getRootItem() {
      return root;
    },
    async importFiles(paths, suppressUI, targetBin, asNumberedStills) {
      importCalls.push({ paths, suppressUI, targetBin, asNumberedStills });
      for (const mediaPath of paths) {
        targetBin.items.push(new Clip(mediaPath.split("/").pop(), mediaPath));
      }
      return true;
    },
    executeTransaction(callback) {
      callback({
        addAction(action) {
          action();
          return true;
        },
      });
      return true;
    },
    async getActiveSequence() {
      return {
        async getPlayerPosition() {
          return position;
        },
      };
    },
  };
  const ppro = {
    Project: {
      async getActiveProject() {
        return project;
      },
    },
    FolderItem: {
      cast(item) {
        if (item.kind !== "folder") throw new Error("not a folder");
        return item;
      },
    },
    ClipProjectItem: {
      cast(item) {
        if (item.kind !== "clip") throw new Error("not a clip");
        return item;
      },
    },
    ProjectItem: {
      cast(item) {
        return item;
      },
    },
    SequenceEditor: {
      getEditor() {
        return {
          createOverwriteItemAction(item, time, videoTrackIndex, audioTrackIndex) {
            return () => {
              timelineCalls.push({
                item,
                time,
                videoTrackIndex,
                audioTrackIndex,
              });
            };
          },
        };
      },
    },
  };
  return { ppro, project, root, importCalls, timelineCalls, position };
}

test("imports only missing assets into shallow source bin", async () => {
  const fixture = hostFixture();
  const host = createPremiereHost(fixture.ppro, core);
  const before = await host.listProjectItems();
  const plan = core.buildImportPlan(fixtureManifest(), before.items, []);
  assert.equal(plan.counts.existing, 1);
  assert.equal(plan.counts.willImport, 2);

  const result = await host.importMissing(plan);
  assert.equal(fixture.importCalls.length, 1);
  assert.deepEqual(fixture.importCalls[0].paths, [
    "/package/media/scene137__clip-01.mov",
    "/package/media/scene137__clip-01__DIALOGUE.wav",
  ]);
  assert.equal(fixture.importCalls[0].suppressUI, true);
  const topBin = fixture.root.items.find(
    (item) => item.kind === "folder" && item.name === "Universal Clipper"
  );
  assert.ok(topBin);
  assert.equal(topBin.items[0].name, "scene137");

  const retry = core.buildImportPlan(fixtureManifest(), result.items, []);
  assert.equal(retry.counts.willImport, 0);
  assert.equal(retry.counts.existing, 3);
});

test("places a clip group only on explicit host call at one playhead time", async () => {
  const fixture = hostFixture();
  const host = createPremiereHost(fixture.ppro, core);
  const initial = core.buildImportPlan(
    fixtureManifest(),
    (await host.listProjectItems()).items,
    []
  );
  await host.importMissing(initial);
  const after = await host.listProjectItems();
  const readyPlan = core.buildImportPlan(fixtureManifest(), after.items, []);
  const clipGroup = fixtureManifest().groups[1].groupId;

  assert.equal(fixture.timelineCalls.length, 0);
  const result = await host.addClipGroupToActiveSequence(readyPlan, clipGroup);
  assert.equal(result.placed, 2);
  assert.equal(fixture.timelineCalls.length, 2);
  assert.equal(fixture.timelineCalls[0].time, fixture.position);
  assert.equal(fixture.timelineCalls[1].time, fixture.position);
  assert.deepEqual(
    fixture.timelineCalls.map((call) => call.audioTrackIndex),
    [0, 1]
  );
});

test("reports no-project and unsupported-host states honestly", async () => {
  const noProject = createPremiereHost(
    {
      Project: { async getActiveProject() { return null; } },
    },
    core
  );
  await assert.rejects(noProject.listProjectItems(), /No Premiere project is open/);

  const unsupported = createPremiereHost({}, core);
  await assert.rejects(unsupported.listProjectItems(), /25\.6/);
});
