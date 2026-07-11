import { describe, expect, it } from "vitest";
import { JobRegistry } from "../src/jobs.js";

describe("JobRegistry", () => {
  it("serializes long-running operations", async () => {
    const jobs = new JobRegistry(String);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = jobs.start("export", async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
      return 1;
    });
    const second = jobs.start("export", async () => {
      events.push("second-start");
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jobs.snapshot(second.job_id)?.status).toBe("queued");
    releaseFirst();
    await Promise.all([first.result, second.result]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
    expect(jobs.snapshot(second.job_id)?.status).toBe("done");
  });

  it("stores a redacted terminal error", async () => {
    const jobs = new JobRegistry((value) => String(value).replace("secret", "[REDACTED]"));
    const job = jobs.start("analyze", async () => { throw new Error("secret provider error"); });
    await expect(job.result).rejects.toThrow();
    expect(jobs.snapshot(job.job_id)?.error).not.toContain("secret");
  });

  it("evicts terminal jobs but caps active and queued work", async () => {
    const jobs = new JobRegistry(String, 60_000, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = jobs.start("export", async () => { await gate; return 1; });
    const second = jobs.start("export", async () => 2);
    expect(() => jobs.start("export", async () => 3)).toThrow(/queue is full/);
    release();
    await Promise.all([first.result, second.result]);
    const third = jobs.start("export", async () => 3);
    await expect(third.result).resolves.toBe(3);
  });
});
