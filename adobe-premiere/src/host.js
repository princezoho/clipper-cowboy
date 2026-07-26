(function universalClipperHost(globalScope) {
  "use strict";

  function guidString(value) {
    if (typeof value === "string") return value;
    if (value && typeof value.toString === "function") {
      const result = value.toString();
      if (result && result !== "[object Object]") return result;
    }
    return "";
  }

  function createPremiereHost(ppro, core) {
    if (!ppro || !core) throw new Error("Premiere host APIs are unavailable.");

    async function getProject() {
      if (!ppro.Project || typeof ppro.Project.getActiveProject !== "function") {
        throw new Error(
          "Unsupported Premiere version. Universal Clipper requires Premiere Pro 25.6 or newer."
        );
      }
      const project = await ppro.Project.getActiveProject();
      if (!project) throw new Error("No Premiere project is open.");
      if (
        typeof project.getRootItem !== "function" ||
        typeof project.importFiles !== "function" ||
        typeof project.executeTransaction !== "function"
      ) {
        throw new Error(
          "This Premiere build does not expose the required UXP 25.6 project APIs."
        );
      }
      return project;
    }

    async function asFolder(projectItem) {
      if (!ppro.FolderItem || typeof ppro.FolderItem.cast !== "function") {
        return null;
      }
      try {
        const folder = ppro.FolderItem.cast(projectItem);
        if (folder && typeof folder.getItems === "function") {
          await folder.getItems();
          return folder;
        }
      } catch {
        return null;
      }
      return null;
    }

    async function asClip(projectItem) {
      if (
        !ppro.ClipProjectItem ||
        typeof ppro.ClipProjectItem.cast !== "function"
      ) {
        return null;
      }
      try {
        const clip = ppro.ClipProjectItem.cast(projectItem);
        if (clip && typeof clip.getMediaFilePath === "function") return clip;
      } catch {
        return null;
      }
      return null;
    }

    async function collectProjectItems(project) {
      const root = await project.getRootItem();
      const records = [];
      const objects = new Map();
      const visited = new Set();

      async function visit(folder, binPath) {
        const items = await folder.getItems();
        for (const projectItem of items) {
          const id =
            typeof projectItem.getId === "function"
              ? String(projectItem.getId())
              : "";
          if (id && visited.has(id)) continue;
          if (id) visited.add(id);
          const childFolder = await asFolder(projectItem);
          if (childFolder) {
            await visit(childFolder, [...binPath, String(projectItem.name || "")]);
            continue;
          }
          const clip = await asClip(projectItem);
          if (!clip) continue;
          let mediaPath = "";
          try {
            mediaPath = await clip.getMediaFilePath();
          } catch {
            mediaPath = "";
          }
          if (!id || typeof mediaPath !== "string" || !mediaPath) continue;
          records.push({
            id,
            name: String(projectItem.name || ""),
            mediaPath,
            binPath,
          });
          objects.set(id, projectItem);
        }
      }

      await visit(root, []);
      return { records, objects, root };
    }

    async function projectContext() {
      const project = await getProject();
      return {
        project,
        projectGuid: guidString(project.guid) || String(project.path || project.name),
        projectName: String(project.name || "Untitled project"),
      };
    }

    async function listProjectItems() {
      const context = await projectContext();
      const collected = await collectProjectItems(context.project);
      return {
        projectGuid: context.projectGuid,
        projectName: context.projectName,
        items: collected.records,
      };
    }

    async function findFolder(parent, name) {
      const items = await parent.getItems();
      for (const item of items) {
        if (String(item.name || "") !== name) continue;
        const folder = await asFolder(item);
        if (folder) return folder;
      }
      return null;
    }

    async function ensureFolder(project, parent, name) {
      const existing = await findFolder(parent, name);
      if (existing) return existing;
      if (typeof parent.createBinAction !== "function") {
        throw new Error("Premiere does not expose bin creation in this build.");
      }
      const action = parent.createBinAction(name, false);
      const committed = project.executeTransaction(
        (compoundAction) => {
          if (!compoundAction.addAction(action)) {
            throw new Error("Premiere rejected the bin creation action.");
          }
        },
        `Create ${name} bin`
      );
      if (committed === false) throw new Error(`Could not create bin “${name}”.`);
      const created = await findFolder(parent, name);
      if (!created) throw new Error(`Premiere did not return bin “${name}”.`);
      return created;
    }

    async function importMissing(plan) {
      if (!plan || !plan.canImport) {
        throw new Error("Import preview contains unresolved or invalid assets.");
      }
      const context = await projectContext();
      const root = await context.project.getRootItem();
      const clipperBin = await ensureFolder(
        context.project,
        root,
        "Universal Clipper"
      );
      const batches = core.importBatches(plan);
      const failures = [];
      let failedAssetCount = 0;
      for (const batch of batches) {
        const groupBin = await ensureFolder(
          context.project,
          clipperBin,
          batch.binName
        );
        const targetBin =
          ppro.ProjectItem && typeof ppro.ProjectItem.cast === "function"
            ? ppro.ProjectItem.cast(groupBin)
            : groupBin;
        const paths = batch.entries.map((entry) => entry.asset.mediaPath);
        try {
          const imported = await context.project.importFiles(
            paths,
            true,
            targetBin,
            false
          );
          if (imported === false) {
            failures.push(`${batch.binName}: Premiere rejected the import.`);
            failedAssetCount += paths.length;
          }
        } catch (error) {
          failedAssetCount += paths.length;
          failures.push(
            `${batch.binName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      const refreshed = await collectProjectItems(context.project);
      return {
        projectGuid: context.projectGuid,
        projectName: context.projectName,
        items: refreshed.records,
        importedCount: plan.counts.willImport - failedAssetCount,
        failures,
      };
    }

    async function addClipGroupToActiveSequence(plan, groupId) {
      const groupPlan = plan.groups.find(
        (candidate) => candidate.group.groupId === groupId
      );
      if (!groupPlan || groupPlan.group.clipId === null) {
        throw new Error("Choose a clip group, not a full-source group.");
      }
      const context = await projectContext();
      if (
        !ppro.SequenceEditor ||
        typeof ppro.SequenceEditor.getEditor !== "function"
      ) {
        throw new Error("Timeline insertion is unavailable in this Premiere build.");
      }
      const sequence = await context.project.getActiveSequence();
      if (!sequence) throw new Error("No active sequence is open.");
      const position = await sequence.getPlayerPosition();
      const editor = ppro.SequenceEditor.getEditor(sequence);
      if (!editor || typeof editor.createOverwriteItemAction !== "function") {
        throw new Error("Timeline insertion is unavailable in this Premiere build.");
      }
      const collected = await collectProjectItems(context.project);
      const objectByCanonicalPath = new Map();
      for (const record of collected.records) {
        const canonical = core.normalizeCanonicalPath(
          record.mediaPath,
          typeof process !== "undefined" ? process.platform : undefined
        );
        if (canonical) {
          objectByCanonicalPath.set(canonical, collected.objects.get(record.id));
        }
      }
      const selectedEntries = groupPlan.entries.filter(
        (entry) =>
          entry.asset.status === "ready" &&
          (entry.asset.kind === "clip" ||
            (entry.asset.kind === "stem" &&
              entry.asset.stemRole !== "MARRIED"))
      );
      const actions = [];
      let audioTrackIndex = 1;
      for (const entry of selectedEntries) {
        const canonical = core.normalizeCanonicalPath(
          entry.asset.mediaPath,
          typeof process !== "undefined" ? process.platform : undefined
        );
        const projectItem = canonical && objectByCanonicalPath.get(canonical);
        if (!projectItem) {
          throw new Error(`Import ${entry.asset.filename} before timeline placement.`);
        }
        const isVideo = entry.asset.kind === "clip";
        actions.push(
          editor.createOverwriteItemAction(
            projectItem,
            position,
            0,
            isVideo ? 0 : audioTrackIndex++
          )
        );
      }
      if (!actions.length) throw new Error("No imported clip assets are available.");
      const committed = context.project.executeTransaction(
        (compoundAction) => {
          for (const action of actions) {
            if (!compoundAction.addAction(action)) {
              throw new Error("Premiere rejected a timeline placement action.");
            }
          }
        },
        "Add Universal Clipper group"
      );
      if (committed === false) {
        throw new Error("Premiere rejected the timeline transaction.");
      }
      return {
        placed: actions.length,
        excludedMarriedStem: true,
        positionSeconds: Number(position.seconds || 0),
      };
    }

    return {
      addClipGroupToActiveSequence,
      importMissing,
      listProjectItems,
      projectContext,
      capabilities: {
        minimumPremiereVersion: "25.6.0",
        importFiles: true,
        createBins: true,
        canonicalPathDedupe: true,
        metadataWrite: false,
        explicitTimelinePlacement: true,
      },
    };
  }

  const api = { createPremiereHost, guidString };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ClipperPremiereHost = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
