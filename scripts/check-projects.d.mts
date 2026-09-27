export interface ProjectIssue {
  severity: "error" | "warning" | "info";
  code: string;
  file: string;
  line?: number;
  message: string;
}
export interface ProjectCheckReport {
  checkedAt: string;
  root: string;
  strict: boolean;
  projects: {
    id: string;
    directory: string;
    status: string;
    renderer: string;
    duration: number;
  }[];
  issues: ProjectIssue[];
  errors: number;
  warnings: number;
  passed: boolean;
  limitation: string;
}
export function localAsset(root: string, reference: unknown, owner?: string): string;
export function checkProjects(
  root?: string,
  options?: { ids?: string[]; strict?: boolean },
): ProjectCheckReport;
