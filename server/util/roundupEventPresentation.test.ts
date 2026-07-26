import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { presentRoundupEvent } from "./roundupEventPresentation.js";

test("classifies moved, renamed, and renamed plus moved edges", () => {
  assert.equal(
    presentRoundupEvent({
      oldPath: "/media/in/take.mp4",
      newPath: "/media/out/take.mp4",
    }).classification,
    "moved"
  );
  assert.equal(
    presentRoundupEvent({
      oldPath: "/media/in/take.mp4",
      newPath: "/media/in/hero-take.mp4",
    }).classification,
    "renamed"
  );

  const fundrop = presentRoundupEvent({
    oldPath: "/Users/fixture/Downloads/Seedance model output 01.mp4",
    newPath: "/Users/fixture/Desktop/fundrop/GFun_hero-arrival.mp4",
  });
  assert.equal(fundrop.classification, "renamed_and_moved");
  assert.equal(fundrop.oldName, "Seedance model output 01.mp4");
  assert.equal(fundrop.newName, "GFun_hero-arrival.mp4");
  assert.equal(fundrop.oldFolder, "/Users/fixture/Downloads");
  assert.equal(fundrop.newFolder, "/Users/fixture/Desktop/fundrop");
});

test("treats case-only and extension changes as meaningful renames", () => {
  const caseOnly = presentRoundupEvent({
    oldPath: "/media/take.mov",
    newPath: "/media/TAKE.mov",
  });
  assert.equal(caseOnly.classification, "renamed");
  assert.equal(caseOnly.extensionChanged, false);

  const extension = presentRoundupEvent({
    oldPath: "/media/take.mov",
    newPath: "/media/take.mp4",
  });
  assert.equal(extension.classification, "renamed");
  assert.equal(extension.extensionChanged, true);
});

test("normalizes Unicode and safely handles legacy or incomplete fields", () => {
  const canonicallyEquivalent = presentRoundupEvent({
    oldPath: "/media/Cafe\u0301.mov",
    newPath: "/media/Café.mov",
  });
  assert.equal(canonicallyEquivalent.classification, "unknown");

  const legacy = presentRoundupEvent({
    oldPath: "/old/folder/legacy.mov",
    newPath: "/new/folder/legacy.mov",
  });
  assert.equal(legacy.oldName, "legacy.mov");
  assert.equal(legacy.classification, "moved");

  assert.equal(
    presentRoundupEvent({ oldName: "known.mov" }).classification,
    "unknown"
  );
  assert.equal(
    presentRoundupEvent({
      relation: "derived-copy",
      oldPath: "/source/a.mov",
      newPath: "/derived/a.mov",
    }).classification,
    "derived_copy"
  );
});

test("Roundup tail API records preserve raw paths and add presentation", async () => {
  const fixture = fs.mkdtempSync(path.join(process.cwd(), ".roundup-event-test-"));
  process.env.PROJECT_DIR = fixture;
  process.env.DOTENV_CONFIG_PATH = "/dev/null";
  try {
    const roundup = await import("./roundup.js");
    const oldPath = path.join(fixture, "Downloads", "Seedance output.mp4");
    const newPath = path.join(fixture, "fundrop", "GFun output.mp4");
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, "synthetic media fixture");

    roundup.appendRoundupEvent({
      kind: "external_detected",
      entityType: "other",
      oldPath,
      newPath,
      triggeredBy: "watcher",
    });

    const [event] = await roundup.readRoundupTail(1);
    assert.equal(event.oldPath, oldPath);
    assert.equal(event.newPath, newPath);
    assert.equal(event.classification, "renamed_and_moved");
    assert.equal(event.presentation?.oldName, "Seedance output.mp4");
    assert.equal(event.presentation?.newName, "GFun output.mp4");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
