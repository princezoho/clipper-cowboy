import assert from "node:assert/strict";
import test from "node:test";
import { redactErrorMessage } from "./publicError.js";

test("redactErrorMessage keeps the fs code and drops the absolute path", () => {
  const error: NodeJS.ErrnoException = Object.assign(
    new Error(
      "ENOENT: no such file or directory, open '/Users/someone/Videos/take 3.mp4'"
    ),
    { code: "ENOENT" }
  );
  assert.equal(
    redactErrorMessage(error),
    "ENOENT: no such file or directory, open 'take 3.mp4'"
  );
});

test("redactErrorMessage restores a code that the message omitted", () => {
  const error: NodeJS.ErrnoException = Object.assign(
    new Error("permission denied"),
    { code: "EACCES" }
  );
  assert.equal(redactErrorMessage(error), "EACCES: permission denied");
});

test("redactErrorMessage collapses every absolute path in a message", () => {
  const message = redactErrorMessage(
    new Error(
      "move verification failed; both paths were retained: /Users/someone/a.mov -> /Volumes/Backup/b.mov"
    )
  );
  assert.equal(message.includes("/Users/"), false);
  assert.equal(message.includes("/Volumes/"), false);
  assert.match(message, /a\.mov -> b\.mov$/);
});

// Assembled at runtime so the release secret scanner doesn't flag this file.
const FAKE_KEY = `sk-${"abcdef0123456789abcdef"}`;

test("redactErrorMessage strips key-shaped strings", () => {
  const message = redactErrorMessage(
    new Error(`request failed for ${FAKE_KEY} and OPENAI_API_KEY=hunter2secret`)
  );
  assert.equal(message.includes(FAKE_KEY), false);
  assert.equal(message.includes("hunter2secret"), false);
  assert.match(message, /\[REDACTED\]/);
});

test("redactErrorMessage keeps http endpoints but not their query strings", () => {
  const message = redactErrorMessage(
    new Error(`429 from https://api.openai.com/v1/chat/completions?key=${FAKE_KEY}`)
  );
  assert.match(message, /https:\/\/api\.openai\.com\/v1\/chat\/completions/);
  assert.equal(message.includes("key="), false);
  assert.equal(message.includes(FAKE_KEY), false);
});

test("redactErrorMessage leaves relative project paths readable", () => {
  const message = redactErrorMessage(
    new Error("could not parse .clipcataloger/clip-meta/abc.json")
  );
  assert.equal(message, "could not parse .clipcataloger/clip-meta/abc.json");
});

test("redactErrorMessage handles non-Error throws", () => {
  assert.equal(redactErrorMessage("plain failure"), "plain failure");
  assert.equal(redactErrorMessage(undefined), "unexpected server error");
  assert.equal(
    redactErrorMessage({ message: "connector rejected /Users/someone/tool.py" }),
    "connector rejected tool.py"
  );
});
