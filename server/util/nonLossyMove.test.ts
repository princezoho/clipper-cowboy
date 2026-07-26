import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { moveFileNoReplace } from "./nonLossyMove.js";

test("moveFileNoReplace moves bytes without overwriting a destination", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-move-test-"));
  try {
    const source = path.join(fixture, "source.mov");
    const destination = path.join(fixture, "destination.mov");
    fs.writeFileSync(source, "source-bytes");
    fs.writeFileSync(destination, "existing-bytes");

    assert.throws(
      () => moveFileNoReplace(source, destination),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "EEXIST"
    );
    assert.equal(fs.readFileSync(source, "utf8"), "source-bytes");
    assert.equal(fs.readFileSync(destination, "utf8"), "existing-bytes");

    const uniqueDestination = path.join(fixture, "destination-2.mov");
    moveFileNoReplace(source, uniqueDestination);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(uniqueDestination, "utf8"), "source-bytes");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
