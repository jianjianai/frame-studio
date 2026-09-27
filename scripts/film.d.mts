export const commandHelp: string;
export function inspectProject(
  root: string,
  id: string,
): {
  schemaVersion: number;
  id: string;
  folder: string;
  metadata: Record<string, unknown>;
  writeBoundary: string;
  outputDirectory: string;
  [key: string]: unknown;
};
export function runFilm(args: string[], root?: string): number;
