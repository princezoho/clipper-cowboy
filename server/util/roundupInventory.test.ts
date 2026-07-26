import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const fixture = fs.mkdtempSync(
  path.join(process.cwd(), ".clipper-roundup-test-")
);
process.env.PROJECT_DIR = fixture;

const {
  RoundupInventoryManager,
  copyRoundupMedia,
  prepareStemHandoff,
  previewRoundupMedia,
  roundupInventory,
} = await import("./roundupInventory.js");

test.after(() => {
  // Only remove the uniquely allocated fixture this process created.
  fs.rmSync(fixture, { recursive: true, force: true });
});

function digest(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function waitForSettled<T extends { status: string }>(
  read: () => T | undefined
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const current = read();
    assert.ok(current);
    if (!["queued", "running"].includes(current.status)) return current;
    assert.ok(Date.now() < deadline, "inventory fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("preview and copy preserve source and allocate unique outputs", () => {
  const source = path.join(fixture, "Seedance", "source.mov");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, Buffer.from("fixture-media-bytes"));
  const before = {
    digest: digest(source),
    stat: fs.statSync(source),
  };
  const outputDir = path.join(fixture, "derived", "roundup");
  fs.mkdirSync(outputDir, { recursive: true });
  const occupied = path.join(outputDir, "source.mov");
  fs.writeFileSync(occupied, "existing-output-must-survive");

  const preview = previewRoundupMedia(source);
  assert.equal(preview.mediaKind, "video");
  assert.equal(preview.stemsEligible, true);
  assert.equal(preview.sourcePolicy, "read-only-preserve");
  assert.equal(preview.collisionPolicy, "allocate-unique-never-overwrite");
  assert.equal(preview.destructiveActionPolicy, "none");
  assert.match(preview.identity, /^[0-9a-f-]{36}$/);
  assert.equal(digest(source), before.digest);

  const first = copyRoundupMedia(source);
  const second = copyRoundupMedia(source);
  assert.notEqual(first.outputPath, occupied);
  assert.notEqual(first.outputPath, second.outputPath);
  assert.equal(fs.readFileSync(occupied, "utf8"), "existing-output-must-survive");
  assert.equal(digest(first.outputPath), before.digest);
  assert.equal(digest(second.outputPath), before.digest);
  assert.equal(digest(source), before.digest);
  assert.equal(fs.existsSync(source), true);
  const after = fs.statSync(source);
  assert.equal(after.size, before.stat.size);
  assert.equal(after.mtimeMs, before.stat.mtimeMs);
  assert.equal(after.ino, before.stat.ino);
});

test("bounded inventory reports bytes, skips, and completeness", async () => {
  const job = roundupInventory.start(["project"], 5_000);
  const deadline = Date.now() + 5_000;
  let current = job;
  while (current.status === "queued" || current.status === "running") {
    assert.ok(Date.now() < deadline, "inventory fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = roundupInventory.get(job.id)!;
  }

  assert.equal(current.status, "done");
  assert.equal(current.complete, true);
  assert.equal(current.capped, false);
  assert.equal(current.placeholderSkips, 0);
  assert.equal(current.errors, 0);
  assert.equal(current.skipped, 0);
  assert.equal(current.mediaCandidates, current.discovered);
  assert.ok(current.discovered > 0);
  assert.ok(current.totalBytes > 0);
});

test("inventory resumes its deterministic cursor and keeps UUIDs idempotent", async () => {
  const mediaDir = path.join(fixture, "resume-fixture");
  fs.mkdirSync(mediaDir, { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(mediaDir, `${index}.mp4`), `media-${index}`);
  }
  const before = previewRoundupMedia(path.join(mediaDir, "0.mp4"));
  const beforeCreatedAt = (
    await import("./roundupTags.js")
  ).findTagForPath(path.join(mediaDir, "0.mp4"))!.createdAt;

  const manager = new RoundupInventoryManager(
    path.join(fixture, ".clipcataloger", "resume-jobs.json")
  );
  const started = manager.start(["project"], 2);
  let current = await waitForSettled(() => manager.get(started.id));
  assert.equal(current.status, "paused");
  assert.equal(current.mediaCandidates, 2);

  while (current.status === "paused") {
    manager.resume(current.id);
    current = await waitForSettled(() => manager.get(current.id));
  }
  assert.equal(current.status, "done");
  assert.equal(current.complete, true);
  assert.equal(current.discovered, current.tagged + current.alreadyTagged);

  const after = previewRoundupMedia(path.join(mediaDir, "0.mp4"));
  const afterTag = (
    await import("./roundupTags.js")
  ).findTagForPath(path.join(mediaDir, "0.mp4"))!;
  assert.equal(after.identity, before.identity);
  assert.equal(afterTag.createdAt, beforeCreatedAt);
});

test("paused inventory survives manager restart and can be cancelled", async () => {
  const jobsPath = path.join(fixture, ".clipcataloger", "restart-jobs.json");
  const firstManager = new RoundupInventoryManager(jobsPath);
  const started = firstManager.start(["project"], 1);
  const paused = await waitForSettled(() => firstManager.get(started.id));
  assert.equal(paused.status, "paused");

  const restartedManager = new RoundupInventoryManager(jobsPath);
  assert.equal(restartedManager.get(started.id)?.status, "paused");
  const resumed = restartedManager.resume(started.id)!;
  assert.ok(["queued", "running"].includes(resumed.status));
  const nextPause = await waitForSettled(() => restartedManager.get(started.id));
  assert.equal(nextPause.status, "paused");
  restartedManager.cancel(started.id);
  assert.equal(restartedManager.get(started.id)?.status, "cancelled");

  const cancelManager = new RoundupInventoryManager(
    path.join(fixture, ".clipcataloger", "cancel-jobs.json")
  );
  const cancellable = cancelManager.start(["project"], 5_000);
  cancelManager.cancel(cancellable.id);
  const cancelled = await waitForSettled(() => cancelManager.get(cancellable.id));
  assert.equal(cancelled.status, "cancelled");
});

test("inventory skips sparse cloud-placeholder-shaped media", async () => {
  const placeholder = path.join(fixture, "resume-fixture", "placeholder.mp4");
  fs.closeSync(fs.openSync(placeholder, "w"));
  fs.truncateSync(placeholder, 1024 * 1024);
  const stat = fs.statSync(placeholder);
  assert.equal(stat.blocks, 0, "fixture filesystem must preserve sparse allocation");

  const manager = new RoundupInventoryManager(
    path.join(fixture, ".clipcataloger", "placeholder-jobs.json")
  );
  const started = manager.start(["project"], 5_000);
  const current = await waitForSettled(() => manager.get(started.id));
  assert.equal(current.status, "done");
  assert.ok(current.placeholderSkips >= 1);
  assert.equal(
    (await import("./roundupTags.js")).findTagForPath(placeholder),
    undefined
  );
});

test("stems handoff fails closed without explicit confirmation", () => {
  const source = path.join(fixture, "Seedance", "source.mov");
  assert.throws(
    () => prepareStemHandoff(source, false),
    /explicit external-processing confirmation/
  );
});

test("confirmed stems handoffs are unique and preserve the source", () => {
  const source = path.join(fixture, "Seedance", "source.mov");
  const before = digest(source);
  const first = prepareStemHandoff(source, true);
  const second = prepareStemHandoff(source, true);

  assert.notEqual(first.manifestPath, second.manifestPath);
  assert.equal(digest(source), before);
  assert.equal(fs.existsSync(source), true);
  assert.equal(first.manifest.sourcePolicy, "read-only-preserve");
  assert.equal(first.manifest.outputPolicy, "allocate-unique-never-overwrite");
  assert.equal(
    first.manifest.destructiveActionPolicy,
    "explicit-confirmation-required"
  );
});
