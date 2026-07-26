(function universalClipperCore(globalScope) {
  "use strict";

  const PACKAGE_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const VALID_PACKAGE_STATES = new Set([
    "preparing",
    "stems_pending",
    "setup_required",
    "stem_error",
    "ready",
  ]);
  const VALID_ASSET_STATES = new Set(["ready", "pending", "invalid"]);
  const VALID_KINDS = new Set(["full-source", "clip", "stem"]);

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isAbsolutePath(value) {
    return (
      typeof value === "string" &&
      (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))
    );
  }

  function normalizeCanonicalPath(value, platform) {
    if (!isAbsolutePath(value) || value.includes("\0")) return null;
    const windows = /^[A-Za-z]:[\\/]/.test(value);
    const prefix = windows ? value.slice(0, 2) : "";
    const raw = windows ? value.slice(2) : value;
    const segments = raw
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    const clean = [];
    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (!clean.length) return null;
        clean.pop();
      } else {
        clean.push(segment.normalize("NFKC"));
      }
    }
    let normalized = windows
      ? `${prefix}/${clean.join("/")}`
      : `/${clean.join("/")}`;
    const caseInsensitive =
      windows || platform === "win32" || platform === "darwin";
    if (caseInsensitive) normalized = normalized.toLocaleLowerCase("en-US");
    return normalized;
  }

  function validatePackageManifest(raw) {
    if (!isObject(raw) || raw.schema !== "clipper-cowboy/premiere-package@1") {
      throw new Error("Unsupported Universal Clipper package schema.");
    }
    if (!PACKAGE_ID_RE.test(String(raw.packageId || ""))) {
      throw new Error("Package ID is invalid.");
    }
    if (
      typeof raw.packageName !== "string" ||
      !raw.packageName.trim() ||
      !VALID_PACKAGE_STATES.has(raw.packageStatus)
    ) {
      throw new Error("Package summary is invalid.");
    }
    if (!Array.isArray(raw.groups) || !raw.groups.length) {
      throw new Error("Package has no import groups.");
    }
    const groupIds = new Set();
    const assetIds = new Set();
    for (const group of raw.groups) {
      if (
        !isObject(group) ||
        typeof group.groupId !== "string" ||
        !group.groupId ||
        groupIds.has(group.groupId) ||
        !Array.isArray(group.assets) ||
        !group.assets.length
      ) {
        throw new Error("Package contains an invalid or duplicate group.");
      }
      groupIds.add(group.groupId);
      for (const asset of group.assets) {
        if (
          !isObject(asset) ||
          asset.groupId !== group.groupId ||
          typeof asset.assetId !== "string" ||
          !asset.assetId ||
          assetIds.has(asset.assetId) ||
          !VALID_KINDS.has(asset.kind) ||
          !VALID_ASSET_STATES.has(asset.status) ||
          typeof asset.filename !== "string" ||
          asset.filename !== asset.filename.split(/[\\/]/).pop()
        ) {
          throw new Error("Package contains an invalid or duplicate asset.");
        }
        if (
          asset.status === "ready" &&
          !isAbsolutePath(asset.mediaPath)
        ) {
          throw new Error("Ready package asset has no canonical media path.");
        }
        if (
          asset.mediaPath !== null &&
          asset.mediaPath !== undefined &&
          !isAbsolutePath(asset.mediaPath)
        ) {
          throw new Error("Package asset path is not absolute.");
        }
        assetIds.add(asset.assetId);
      }
    }
    return raw;
  }

  function buildImportPlan(
    unvalidatedManifest,
    projectItems,
    acknowledgements,
    platform
  ) {
    const manifest = validatePackageManifest(unvalidatedManifest);
    const items = Array.isArray(projectItems) ? projectItems : [];
    const acks = Array.isArray(acknowledgements) ? acknowledgements : [];
    const byPath = new Map();
    const byId = new Map();
    const byAirTag = new Map();
    for (const item of items) {
      if (!isObject(item) || typeof item.id !== "string") continue;
      byId.set(item.id, item);
      const canonical = normalizeCanonicalPath(item.mediaPath, platform);
      if (canonical && !byPath.has(canonical)) byPath.set(canonical, item);
      if (
        typeof item.airTagId === "string" &&
        item.airTagId &&
        !byAirTag.has(item.airTagId)
      ) {
        byAirTag.set(item.airTagId, item);
      }
    }
    const ackByAsset = new Map(
      acks
        .filter(
          (ack) =>
            isObject(ack) &&
            typeof ack.assetId === "string" &&
            typeof ack.projectItemId === "string"
        )
        .map((ack) => [ack.assetId, ack])
    );

    const groups = manifest.groups.map((group) => {
      const entries = group.assets.map((asset) => {
        if (asset.status === "invalid") {
          return { asset, state: "invalid", reason: "Package media failed validation." };
        }
        if (asset.status !== "ready" || !asset.mediaPath) {
          return { asset, state: "unresolved", reason: "Asset is not published yet." };
        }
        const canonical = normalizeCanonicalPath(asset.mediaPath, platform);
        if (!canonical) {
          return { asset, state: "invalid", reason: "Media path is not canonical." };
        }
        const pathMatch = byPath.get(canonical);
        if (pathMatch) {
          return {
            asset,
            state: "existing",
            reason: "Canonical media path already exists in this project.",
            projectItemId: pathMatch.id,
            matchedBy: "canonical-path",
          };
        }
        const ack = ackByAsset.get(asset.assetId);
        const ackItem = ack && byId.get(ack.projectItemId);
        if (ackItem) {
          return {
            asset,
            state: "existing",
            reason: "Clipper import mapping matches an existing project item.",
            projectItemId: ackItem.id,
            matchedBy: "clipper-mapping",
          };
        }
        const airTagMatch =
          typeof asset.airTagId === "string" && asset.airTagId
            ? byAirTag.get(asset.airTagId)
            : null;
        if (airTagMatch) {
          return {
            asset,
            state: "existing",
            reason: "AirTag identity matches an existing mapped project item.",
            projectItemId: airTagMatch.id,
            matchedBy: "airtag",
          };
        }
        return {
          asset,
          state: "will_import",
          reason: "No canonical path or trusted Clipper mapping matched.",
        };
      });
      return { group, entries };
    });
    const entries = groups.flatMap((group) => group.entries);
    const count = (state) => entries.filter((entry) => entry.state === state).length;
    return {
      manifest,
      groups,
      counts: {
        existing: count("existing"),
        willImport: count("will_import"),
        unresolved: count("unresolved"),
        invalid: count("invalid"),
      },
      canImport:
        manifest.premiereReady === true &&
        count("invalid") === 0 &&
        count("unresolved") === 0,
    };
  }

  function safeBinName(value, fallback) {
    const cleaned = String(value || "")
      .normalize("NFKC")
      .replace(/[\0/\\:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return cleaned || fallback;
  }

  function binNameForGroup(group) {
    const primary = group.assets.find(
      (asset) => asset.kind === "full-source" || asset.kind === "clip"
    );
    const filename = primary ? primary.filename : group.label;
    const base = String(filename || "").replace(/\.[^.]+$/, "");
    return safeBinName(base.replace(/__clip-\d+$/i, ""), "Clipper group");
  }

  function importBatches(plan) {
    return plan.groups
      .map(({ group, entries }) => ({
        groupId: group.groupId,
        binName: binNameForGroup(group),
        entries: entries.filter((entry) => entry.state === "will_import"),
      }))
      .filter((batch) => batch.entries.length);
  }

  function acknowledgementEntries(plan, refreshedProjectItems, platform) {
    const refreshed = Array.isArray(refreshedProjectItems)
      ? refreshedProjectItems
      : [];
    const byPath = new Map();
    for (const item of refreshed) {
      const canonical = normalizeCanonicalPath(item.mediaPath, platform);
      if (canonical && item.id) byPath.set(canonical, item);
    }
    const entries = [];
    for (const entry of plan.groups.flatMap((group) => group.entries)) {
      const canonical = normalizeCanonicalPath(entry.asset.mediaPath, platform);
      const item = canonical && byPath.get(canonical);
      if (!item) continue;
      entries.push({
        assetId: entry.asset.assetId,
        projectItemId: item.id,
        status: entry.state === "existing" ? "existing" : "imported",
      });
    }
    return entries;
  }

  const api = {
    acknowledgementEntries,
    binNameForGroup,
    buildImportPlan,
    importBatches,
    isAbsolutePath,
    normalizeCanonicalPath,
    safeBinName,
    validatePackageManifest,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ClipperPremiereCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
