(function universalClipperApi(globalScope) {
  "use strict";

  function normalizePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Clipper port must be between 1 and 65535.");
    }
    return port;
  }

  function createClient(options) {
    const fetchImpl =
      (options && options.fetchImpl) ||
      (typeof fetch === "function" ? fetch.bind(globalScope) : null);
    if (!fetchImpl) throw new Error("UXP fetch is unavailable.");
    const port = normalizePort((options && options.port) || 47474);
    const token = String((options && options.token) || "").trim();
    const baseUrl = `http://127.0.0.1:${port}`;

    async function request(path, init) {
      if (typeof path !== "string" || !path.startsWith("/api/")) {
        throw new Error("Refusing a non-Clipper API request.");
      }
      const headers = Object.assign({}, (init && init.headers) || {});
      if (token) headers["x-clipper-api-token"] = token;
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers,
        });
      } catch {
        throw new Error(
          `Clipper is offline at ${baseUrl}. Start Clipper Cowboy and try again.`
        );
      }
      let body = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      if (!response.ok) {
        const message =
          body && typeof body.error === "string"
            ? body.error
            : response.status === 401
              ? "Clipper rejected the local API token."
              : `Clipper request failed (${response.status}).`;
        throw new Error(message);
      }
      return body;
    }

    return {
      baseUrl,
      async listPackages() {
        return request("/api/universal-clipper/packages?limit=50");
      },
      async getPackage(packageId, projectGuid) {
        const query = projectGuid
          ? `?projectGuid=${encodeURIComponent(projectGuid)}`
          : "";
        return request(
          `/api/universal-clipper/packages/${encodeURIComponent(packageId)}${query}`
        );
      },
      async acknowledgeImport(packageId, projectGuid, entries) {
        return request(
          `/api/universal-clipper/packages/${encodeURIComponent(
            packageId
          )}/import-ack`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectGuid, entries }),
          }
        );
      },
    };
  }

  const api = { createClient, normalizePort };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ClipperPremiereApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
