export type StemQuality = "fast";

export type StemJobStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "interrupted";

export interface StemJobSummary {
  id: string;
  clipId: string;
  clipName: string;
  quality: StemQuality;
  status: StemJobStatus;
  stage?: string;
  percent: number;
  outputDir?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StemStudioStatus {
  ready: boolean;
  installing: boolean;
  pythonAvailable: boolean;
  recommendedQuality?: StemQuality;
  message: string;
}
