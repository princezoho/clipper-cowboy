import { randomUUID } from "node:crypto";

export type JobKind = "export" | "analyze" | "setup";
export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobSnapshot {
  job_id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string;
  percent: number;
  detail?: string;
  result?: unknown;
  error?: string;
  created_at: number;
  updated_at: number;
}

interface JobRecord extends JobSnapshot {
  resultPromise: Promise<unknown>;
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly redact: (value: unknown) => string,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxJobs = 100
  ) {}

  start(kind: JobKind, task: (update: (stage: string, percent: number, detail?: string) => void) => Promise<unknown>) {
    this.prune();
    if (this.jobs.size >= this.maxJobs) {
      throw new Error("Job queue is full. Wait for existing jobs to finish before starting another.");
    }
    const now = Date.now();
    const jobId = randomUUID();
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (reason: unknown) => void;
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // A wait:false job may fail before anyone awaits it.
    void resultPromise.catch(() => {});
    const record: JobRecord = {
      job_id: jobId,
      kind,
      status: "queued",
      stage: "queued",
      percent: 0,
      created_at: now,
      updated_at: now,
      resultPromise,
    };
    this.jobs.set(jobId, record);

    const run = this.tail.then(async () => {
      record.status = "running";
      record.stage = kind === "setup" ? "installing" : kind;
      record.updated_at = Date.now();
      const update = (stage: string, percent: number, detail?: string) => {
        if (record.status !== "running") return;
        record.stage = stage;
        record.percent = Math.max(0, Math.min(100, Math.round(percent)));
        record.detail = detail ? this.redact(detail).slice(0, 2_000) : undefined;
        record.updated_at = Date.now();
      };
      try {
        const result = await task(update);
        record.status = "done";
        record.stage = "done";
        record.percent = 100;
        record.detail = undefined;
        record.result = result;
        record.updated_at = Date.now();
        resolveResult(result);
      } catch (error) {
        record.status = "error";
        record.stage = "error";
        record.error = this.redact(error).slice(0, 2_000);
        record.detail = undefined;
        record.updated_at = Date.now();
        rejectResult(error);
      }
    });
    this.tail = run.catch(() => {});
    return { job_id: jobId, result: resultPromise };
  }

  snapshot(jobId: string): JobSnapshot | null {
    this.prune();
    const record = this.jobs.get(jobId);
    if (!record) return null;
    const { resultPromise: _promise, ...snapshot } = record;
    return { ...snapshot };
  }

  private prune(): void {
    const expiry = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if ((job.status === "done" || job.status === "error") && job.updated_at < expiry) {
        this.jobs.delete(id);
      }
    }
    if (this.jobs.size < this.maxJobs) return;
    const terminal = [...this.jobs.values()]
      .filter((job) => job.status === "done" || job.status === "error")
      .sort((a, b) => a.updated_at - b.updated_at);
    for (const job of terminal) {
      if (this.jobs.size < this.maxJobs) break;
      this.jobs.delete(job.job_id);
    }
  }
}
