export type StemQuality = "fast" | "high" | "max";

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
  configured: boolean;
  ready: boolean;
  helperSetupRequired?: boolean;
  device?: "cpu" | "mps" | "cuda";
  recommendedQuality?: StemQuality;
  message?: string;
}
