import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRootFromModule, resolveConfig, validateLocalServiceUrl } from "../src/config.js";

describe("MCP configuration", () => {
  it("resolves the repository relative to the built module, not cwd", () => {
    const moduleUrl = "file:///tmp/example/clipper-cowboy/mcp/dist/index.js";
    expect(defaultRootFromModule(moduleUrl)).toBe(path.resolve("/tmp/example/clipper-cowboy"));
    expect(resolveConfig({}, moduleUrl).rootDir).toBe(path.resolve("/tmp/example/clipper-cowboy"));
  });

  it("rejects remote and credential-bearing service URLs", () => {
    expect(() => validateLocalServiceUrl("https://127.0.0.1:47474")).toThrow(/http/);
    expect(() => validateLocalServiceUrl("http://example.com:47474")).toThrow(/localhost/);
    expect(() => validateLocalServiceUrl("http://user:pass@localhost:47474")).toThrow(/credentials/);
  });

  it("requires an absolute project directory", () => {
    expect(() => resolveConfig({ CLIPPER_PROJECT_DIR: "relative/project" }, import.meta.url)).toThrow(/absolute/);
  });

  it("requires an absolute explicit repository root", () => {
    expect(() => resolveConfig({ CLIPPER_ROOT: "relative/repo" }, import.meta.url)).toThrow(/absolute/);
  });
});
