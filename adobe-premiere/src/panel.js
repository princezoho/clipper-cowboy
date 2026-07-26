(function runUniversalClipperPanel() {
  "use strict";

  const core = globalThis.ClipperPremiereCore;
  const apiModule = globalThis.ClipperPremiereApi;
  const hostModule = globalThis.ClipperPremiereHost;
  const elements = {
    port: document.querySelector("#port"),
    token: document.querySelector("#token"),
    connect: document.querySelector("#connect"),
    connectionPill: document.querySelector("#connection-pill"),
    hostState: document.querySelector("#host-state"),
    packageSelect: document.querySelector("#package-select"),
    packageState: document.querySelector("#package-state"),
    counts: document.querySelector("#counts"),
    groupsCard: document.querySelector("#groups-card"),
    groups: document.querySelector("#groups"),
    refresh: document.querySelector("#refresh"),
    importMissing: document.querySelector("#import-missing"),
    timelineGroup: document.querySelector("#timeline-group"),
    addTimeline: document.querySelector("#add-timeline"),
    message: document.querySelector("#message"),
  };

  let premiereHost = null;
  let client = null;
  let packages = [];
  let currentPlan = null;
  let currentProject = null;
  let busy = false;

  try {
    const savedPort = localStorage.getItem("clipper.port");
    if (savedPort) elements.port.value = savedPort;
  } catch {
    // Storage is optional; the token is intentionally never persisted.
  }

  function setMessage(text, kind) {
    elements.message.textContent = text || "";
    elements.message.className = kind || "";
  }

  function setBusy(next) {
    busy = next;
    elements.connect.disabled = next;
    elements.refresh.disabled = next || !client;
    renderActions();
  }

  function setConnection(label, tone) {
    elements.connectionPill.textContent = label;
    elements.connectionPill.className = `pill ${tone}`;
  }

  function option(value, label) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  }

  function renderPackageOptions() {
    const selected = elements.packageSelect.value;
    elements.packageSelect.replaceChildren();
    if (!packages.length) {
      elements.packageSelect.appendChild(option("", "No prepared packages found"));
      elements.packageSelect.disabled = true;
      return;
    }
    elements.packageSelect.appendChild(option("", "Choose a package"));
    for (const item of packages) {
      const state = item.premiereReady ? "Ready" : item.packageStatus.replace(/_/g, " ");
      elements.packageSelect.appendChild(
        option(item.packageId, `${item.packageName} · ${state}`)
      );
    }
    elements.packageSelect.disabled = false;
    if (packages.some((item) => item.packageId === selected)) {
      elements.packageSelect.value = selected;
    }
  }

  function assetTone(state) {
    if (state === "existing") return "ok";
    if (state === "will_import") return "pending";
    return "bad";
  }

  function renderPlan() {
    elements.groups.replaceChildren();
    if (!currentPlan) {
      elements.groupsCard.hidden = true;
      elements.counts.hidden = true;
      renderActions();
      return;
    }
    elements.groupsCard.hidden = false;
    const counts = currentPlan.counts;
    elements.counts.hidden = false;
    elements.counts.replaceChildren();
    for (const [label, value, tone] of [
      ["existing", counts.existing, "ok"],
      ["will import", counts.willImport, "pending"],
      ["unresolved", counts.unresolved, "bad"],
      ["invalid", counts.invalid, "bad"],
    ]) {
      const card = document.createElement("div");
      card.className = `count ${tone}`;
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const small = document.createElement("small");
      small.textContent = label;
      card.append(strong, small);
      elements.counts.appendChild(card);
    }

    for (const groupPlan of currentPlan.groups) {
      const groupNode = document.createElement("div");
      groupNode.className = "group";
      const title = document.createElement("div");
      title.className = "group-title";
      title.textContent = groupPlan.group.label;
      groupNode.appendChild(title);
      for (const entry of groupPlan.entries) {
        const row = document.createElement("div");
        row.className = "asset";
        const state = document.createElement("span");
        state.className = `asset-state ${assetTone(entry.state)}`;
        state.textContent = entry.state.replace("_", " ");
        const detail = document.createElement("div");
        const name = document.createElement("div");
        name.className = "asset-name";
        name.textContent = entry.asset.filename;
        const meta = document.createElement("div");
        meta.className = "asset-meta";
        meta.textContent = `${entry.asset.relationship} · ${entry.reason}`;
        detail.append(name, meta);
        row.append(state, detail);
        groupNode.appendChild(row);
      }
      elements.groups.appendChild(groupNode);
    }

    elements.timelineGroup.replaceChildren(
      option("", "Choose an imported clip group")
    );
    for (const groupPlan of currentPlan.groups) {
      if (groupPlan.group.clipId === null) continue;
      const unavailable = groupPlan.entries.some(
        (entry) => entry.state !== "existing"
      );
      const entry = option(groupPlan.group.groupId, groupPlan.group.label);
      entry.disabled = unavailable;
      elements.timelineGroup.appendChild(entry);
    }
    elements.timelineGroup.disabled =
      elements.timelineGroup.options.length <= 1;
    renderActions();
  }

  function renderActions() {
    const hasMissing = Boolean(currentPlan && currentPlan.counts.willImport > 0);
    elements.importMissing.disabled =
      busy || !currentPlan || !currentPlan.canImport || !hasMissing;
    elements.importMissing.textContent =
      currentPlan && !hasMissing ? "Everything already imported" : "Import missing";
    elements.addTimeline.disabled =
      busy || !currentPlan || !elements.timelineGroup.value;
  }

  async function loadSelectedPackage() {
    const packageId = elements.packageSelect.value;
    currentPlan = null;
    renderPlan();
    if (!packageId || !client || !premiereHost) {
      elements.packageState.textContent = "No package loaded.";
      elements.packageState.className = "state neutral";
      return;
    }
    setBusy(true);
    setMessage("Inspecting project and package…");
    try {
      currentProject = await premiereHost.listProjectItems();
      const manifest = await client.getPackage(
        packageId,
        currentProject.projectGuid
      );
      currentPlan = core.buildImportPlan(
        manifest,
        currentProject.items,
        manifest.importAcknowledgements || []
      );
      elements.packageState.textContent = manifest.premiereReady
        ? `Ready for Premiere · ${manifest.stemExecution.message}`
        : `${manifest.packageStatus.replace(/_/g, " ")} · ${
            manifest.stemExecution.message
          }`;
      elements.packageState.className = `state ${
        manifest.premiereReady ? "ok" : "pending"
      }`;
      renderPlan();
      setMessage(
        manifest.premiereReady
          ? "Preview complete. Import changes nothing until you click Import missing."
          : "Package is inspectable but import is disabled until stems validate in Clipper."
      );
    } catch (error) {
      elements.packageState.textContent =
        error instanceof Error ? error.message : String(error);
      elements.packageState.className = "state bad";
      setMessage(elements.packageState.textContent, "error");
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    setMessage("Connecting to Clipper and Premiere…");
    try {
      let ppro;
      try {
        ppro = require("premierepro");
      } catch {
        throw new Error(
          "Premiere UXP host module is unavailable. Load this plugin in Premiere Pro 25.6+."
        );
      }
      premiereHost = hostModule.createPremiereHost(ppro, core);
      currentProject = await premiereHost.listProjectItems();
      elements.hostState.textContent = `${currentProject.projectName} · ${currentProject.items.length} media items inspected`;
      client = apiModule.createClient({
        port: elements.port.value,
        token: elements.token.value,
      });
      try {
        localStorage.setItem("clipper.port", String(elements.port.value));
      } catch {
        // Port persistence is optional; token is never stored.
      }
      const response = await client.listPackages();
      packages = Array.isArray(response.items) ? response.items : [];
      renderPackageOptions();
      setConnection("Connected", "ok");
      setMessage(
        packages.length
          ? "Choose a prepared package."
          : "No packages yet. Prepare media and stems in Clipper Cowboy."
      );
    } catch (error) {
      client = null;
      packages = [];
      renderPackageOptions();
      setConnection("Offline", "bad");
      elements.hostState.textContent =
        error instanceof Error ? error.message : String(error);
      setMessage(elements.hostState.textContent, "error");
    } finally {
      setBusy(false);
    }
  }

  async function importMissing() {
    if (!currentPlan || !client || !premiereHost) return;
    setBusy(true);
    setMessage("Importing only missing canonical paths…");
    try {
      const result = await premiereHost.importMissing(currentPlan);
      const entries = core.acknowledgementEntries(
        currentPlan,
        result.items
      );
      await client.acknowledgeImport(
        currentPlan.manifest.packageId,
        result.projectGuid,
        entries
      );
      if (result.failures.length) {
        setMessage(
          `Import finished with ${result.failures.length} failure(s): ${result.failures.join(
            " · "
          )}`,
          "error"
        );
      } else {
        setMessage("Missing assets imported and mapped.", "success");
      }
      await loadSelectedPackage();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function addTimelineGroup() {
    if (!currentPlan || !premiereHost || !elements.timelineGroup.value) return;
    const proceed =
      typeof confirm !== "function" ||
      confirm(
        "Place this clip video and its DIALOGUE/MUSIC/SFX stems at the active sequence playhead? This is the only action that changes the timeline."
      );
    if (!proceed) return;
    setBusy(true);
    setMessage("Placing selected clip group at the playhead…");
    try {
      const result = await premiereHost.addClipGroupToActiveSequence(
        currentPlan,
        elements.timelineGroup.value
      );
      setMessage(
        `Placed ${result.placed} synchronized assets at ${result.positionSeconds.toFixed(
          3
        )}s. MARRIED was excluded.`,
        "success"
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  elements.connect.addEventListener("click", connect);
  elements.packageSelect.addEventListener("change", loadSelectedPackage);
  elements.refresh.addEventListener("click", loadSelectedPackage);
  elements.importMissing.addEventListener("click", importMissing);
  elements.timelineGroup.addEventListener("change", renderActions);
  elements.addTimeline.addEventListener("click", addTimelineGroup);
  renderPackageOptions();
  renderActions();
})();
