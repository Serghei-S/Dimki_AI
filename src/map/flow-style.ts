/** Fixed between scenarios. These are resident trips per model cycle, not measured capacity. */
export const FLOW_SCALE = 1000;
export function flowStyle(load: number) {
  const ratio = Math.min(1, Math.max(0, Number.isFinite(load) ? load : 0) / FLOW_SCALE);
  return {
    ratio,
    widthM: load > 0 ? 2 + 9 * Math.sqrt(ratio) : 1.1,
    color: ratio < 0.25 ? '#48b7a3' : ratio < 0.5 ? '#d9c547' : ratio < 0.75 ? '#ef9944' : '#eb5045',
  };
}
