export function trainProgress(time: number): number;
export function arcLengthLookup(
  point: (angle: number) => { x: number; y: number; z: number },
  samples?: number,
): { total: number; parameter(distance: number): number };
