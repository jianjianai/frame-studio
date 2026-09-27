export interface ExportPlan {
  start: number;
  end: number;
  fps: number;
  width: number;
  height: number;
  frames: number;
  duration: number;
}
export function createExportPlan(options: {
  duration: number;
  fps?: number;
  width?: number;
  start?: number;
  end?: number;
}): ExportPlan;
