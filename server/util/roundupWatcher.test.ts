import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type {
  RoundupApprovedRoot,
  RoundupSettings,
} from "./roundup.js";

const fixturePrefix = ".clipper-roundup-watcher-test-";
for (const entry of fs.readdirSync(process.cwd())) {
  if (entry.startsWith(fixturePrefix)) {
    fs.rmSync(path.join(process.cwd(), entry), { recursive: true, force: true });
  }
}
const fixture = fs.mkdtempSync(
  path.join(process.cwd(), fixturePrefix)
);
process.env.PROJECT_DIR = fixture;
process.env.DOTENV_CONFIG_PATH = "/dev/null";
// Native FSEvents is not available in every supported Node build used by CI.
// Polling keeps these end-to-end rename assertions deterministic without
// changing the production default.
process.env.ROUNDUP_WATCHER_TEST_POLLING = "1";

const roundup = await import("./roundup.js");
const tags = await import("./roundupTags.js");
const { RoundupWatcher } = await import("./roundupWatcher.js");

const broadRootIds = [
  "downloads",
  "desktop",
  "documents",
  "pictures",
  "movies",
  "music",
];

function settings(
  watchedRootIds: string[] = ["project"],
  approvedRoots: RoundupApprovedRoot[] = []
): RoundupSettings {
  return {
    enabled: true,
    disabledRoots: broadRootIds,
    watchedRootIds,
    approvedRoots,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for watcher fixture event");
}

test.after(async () => {
  tags.flushTagsSync();
  // Let any already-scheduled observational flush finish, then remove again so
  // no delayed timer can recreate fixture metadata after teardown.
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("overlapping active roots collapse to one recursive watcher", () => {
  const nested = path.join(fixture, "droplet");
  fs.mkdirSync(nested, { recursive: true });
  const approved: RoundupApprovedRoot = {
    id: "droplet:test",
    label: "Fixture droplet",
    path: nested,
    reason: "droplet",
  };
  roundup.writeRoundupSettings(settings(["project", approved.id], [approved]));
  const result = roundup.dedupeRoundupWatchRoots(
    roundup.listAllowlistedWatchRoots()
  );
  assert.deepEqual(result.roots.map((root) => root.id), ["project"]);
  assert.deepEqual(result.coveredIds, [approved.id]);
});

test("repeated start, reconfigure, and stop closes every prior instance", async () => {
  class FakeWatcher extends EventEmitter {
    closeCalls = 0;
    async close(): Promise<void> {
      this.closeCalls += 1;
    }
  }
  const instances: FakeWatcher[] = [];
  const watcher = new RoundupWatcher(() => {
    const fake = new FakeWatcher();
    instances.push(fake);
    queueMicrotask(() => fake.emit("ready"));
    return fake as never;
  });

  roundup.writeRoundupSettings(settings());
  await watcher.start();
  await watcher.restart();
  await watcher.applySettings({ watchedRootIds: ["project"] });
  await watcher.stop();

  assert.equal(instances.length, 3);
  assert.deepEqual(
    instances.map((instance) => instance.closeCalls),
    [1, 1, 1]
  );
  assert.equal(watcher.status().state, "off");
});

test("watcher errors surface a degraded, non-running status", async () => {
  class ErrorWatcher extends EventEmitter {
    closed = false;
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  let fake: ErrorWatcher | undefined;
  const watcher = new RoundupWatcher(() => {
    fake = new ErrorWatcher();
    queueMicrotask(() => {
      const error = Object.assign(new Error("fixture handle exhaustion"), {
        code: "EMFILE",
      });
      fake!.emit("error", error);
    });
    return fake as never;
  });

  roundup.writeRoundupSettings(settings());
  await watcher.start();
  assert.equal(watcher.status().state, "degraded");
  assert.equal(watcher.status().running, false);
  assert.match(watcher.status().lastError ?? "", /handle exhaustion/);
  assert.equal(fake?.closed, true);
});

test("two external rename hops retain one UUID and complete trail", async () => {
  const source = path.join(fixture, "external-a.mov");
  const hopOne = path.join(fixture, "external-b.mov");
  const hopTwo = path.join(fixture, "external-c.mov");
  fs.writeFileSync(source, "isolated-fixture-media");
  roundup.writeRoundupSettings(settings());

  const watcher = new RoundupWatcher();
  await watcher.start();
  assert.equal(watcher.status().state, "watched");
  assert.equal(tags.findTagForPath(source), undefined, "startup must not tag");

  fs.renameSync(source, hopOne);
  await waitFor(() => tags.findTagForPath(hopOne)?.currentPath === hopOne);
  const firstTag = tags.findTagForPath(hopOne);
  assert.ok(firstTag);

  fs.renameSync(hopOne, hopTwo);
  await waitFor(() => tags.findTagForPath(hopTwo)?.currentPath === hopTwo);
  await watcher.stop();

  const finalTag = tags.findTagForPath(hopTwo);
  assert.equal(finalTag?.id, firstTag.id);
  assert.deepEqual(finalTag?.paths.slice(-3), [source, hopOne, hopTwo]);

  const events = await roundup.readAllRoundupEvents();
  const external = events.filter((event) => event.triggeredBy === "watcher");
  assert.deepEqual(
    external.slice(-2).map((event) => [event.oldPath, event.newPath]),
    [
      [source, hopOne],
      [hopOne, hopTwo],
    ]
  );
  assert.equal(external.at(-1)?.tagId, firstTag.id);
});

test("same-volume atomic move pairs across two watched roots", async () => {
  const sourceRoot = path.join(fixture, "downloads-fixture");
  const destinationRoot = path.join(fixture, "fundrop-fixture");
  const source = path.join(sourceRoot, "source-name.wav");
  const destination = path.join(destinationRoot, "renamed-name.wav");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(destinationRoot, { recursive: true });
  fs.writeFileSync(source, "isolated-two-root-fixture");

  const approved: RoundupApprovedRoot[] = [
    {
      id: "droplet:downloads-fixture",
      label: "Downloads fixture",
      path: sourceRoot,
      reason: "droplet",
    },
    {
      id: "droplet:fundrop-fixture",
      label: "Fundrop fixture",
      path: destinationRoot,
      reason: "droplet",
    },
  ];
  roundup.writeRoundupSettings(
    settings(approved.map((root) => root.id), approved)
  );

  const watcher = new RoundupWatcher();
  try {
    await watcher.start();
    assert.equal(watcher.status().state, "watched");
    assert.deepEqual(watcher.status().watching.sort(), [
      destinationRoot,
      sourceRoot,
    ].sort());

    fs.renameSync(source, destination);
    await waitFor(
      () => tags.findTagForPath(destination)?.paths.includes(source) === true
    );

    const status = watcher.status();
    assert.equal(status.state, "watched");
    assert.equal(status.lastError, null);

    const tag = tags.findTagForPath(destination);
    assert.ok(tag);
    assert.deepEqual(tag.paths.slice(-2), [source, destination]);
    assert.equal(
      tags.listTags(500).filter((candidate) =>
        candidate.paths.includes(source) ||
        candidate.paths.includes(destination)
      ).length,
      1
    );

    for (const query of [
      { path: source },
      { basename: path.basename(source) },
    ]) {
      const candidates = await roundup.lookupRoundup(query);
      assert.equal(candidates[0]?.currentPath, destination);
      assert.deepEqual(candidates[0]?.trail.slice(-2), [source, destination]);
      assert.equal(candidates[0]?.tag?.id, tag.id);
    }
  } finally {
    await watcher.stop();
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(destinationRoot, { recursive: true, force: true });
  }

  assert.equal(fs.existsSync(sourceRoot), false);
  assert.equal(fs.existsSync(destinationRoot), false);
});
