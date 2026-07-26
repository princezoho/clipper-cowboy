const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
for (const filename of [
  "src/core.js",
  "src/api.js",
  "src/host.js",
  "src/panel.js",
  "scripts/build.cjs",
]) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, filename)], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write("Premiere plugin JavaScript syntax passed.\n");
