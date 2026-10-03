/**
 * One speed scale for every airflow visual (map, streaks, lines, arrows), so a
 * colour means the same m/s everywhere. The range is set for cleanrooms:
 * below 0.05 m/s is effectively still air, HEPA face velocity is ~0.45 m/s,
 * and anything past 0.6 m/s is a jet or a draught.
 */

export const SPEED_SCALE_MAX = 0.6; // m/s
export const STILL_AIR = 0.05; // m/s

const STOPS: [number, [number, number, number]][] = [
  [0.0, [0.12, 0.16, 0.55]], // still: deep blue
  [0.08, [0.15, 0.39, 0.92]], // barely moving: blue
  [0.25, [0.02, 0.71, 0.83]], // gentle: cyan
  [0.45, [0.13, 0.77, 0.37]], // mixing: green
  [0.7, [0.92, 0.7, 0.03]], // HEPA face speed: amber
  [1.0, [0.94, 0.27, 0.27]], // jets / draughts: red
];

/** Speed (m/s) → linear RGB in 0..1. */
export function speedRgb(speed: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, speed / SPEED_SCALE_MAX));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** CSS gradient of the scale, for legends. */
export function speedGradientCss(): string {
  return `linear-gradient(to right, ${STOPS.map(
    ([t, c]) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}) ${Math.round(t * 100)}%`
  ).join(', ')})`;
}
