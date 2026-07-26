const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src");
const output = path.join(root, "dist");
const pluginPackage = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
);

if (
  manifest.manifestVersion !== 5 ||
  manifest.id !== "com.clippercowboy.universal-premiere" ||
  manifest.name !== "Universal Clipper" ||
  manifest.version !== pluginPackage.version ||
  manifest.main !== "index.html" ||
  manifest.host?.app !== "premierepro" ||
  manifest.host?.minVersion !== "25.6.0" ||
  !Array.isArray(manifest.entrypoints) ||
  manifest.entrypoints.length !== 1 ||
  manifest.entrypoints[0]?.type !== "panel" ||
  manifest.entrypoints[0]?.id !== "universalClipperPanel"
) {
  throw new Error("Premiere UXP manifest contract is invalid.");
}
const permissionNames = Object.keys(manifest.requiredPermissions || {});
const domains = manifest.requiredPermissions?.network?.domains;
if (
  permissionNames.length !== 1 ||
  permissionNames[0] !== "network" ||
  !Array.isArray(domains) ||
  domains.length !== 1 ||
  domains[0] !== "http://127.0.0.1:47474"
) {
  throw new Error("Plugin network permission must remain restricted to Clipper localhost.");
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const filename of [
  "index.html",
  "styles.css",
  "core.js",
  "api.js",
  "host.js",
  "panel.js",
]) {
  fs.copyFileSync(path.join(source, filename), path.join(output, filename));
}
fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));
process.stdout.write(`Built Premiere UXP plugin: ${output}\n`);
