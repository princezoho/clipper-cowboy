export type StemQuality = "fast" | "high";

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
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StemStudioStatus {
  ready: boolean;
  installing: boolean;
  pythonAvailable: boolean;
  recommendedQuality?: StemQuality;
  installedQualities: StemQuality[];
  message: string;
}
