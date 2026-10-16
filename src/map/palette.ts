export const ACCESS_COLORS = ['#629e92', '#adbd85', '#d7aa73', '#c98775', '#89959e'] as const;
export function accessibilityColor(seconds: number | null, threshold: number): string {
  if (seconds === null) return ACCESS_COLORS[4];
  return ACCESS_COLORS[
    seconds <= threshold * 0.5 ? 0 : seconds <= threshold ? 1 : seconds <= threshold * 1.5 ? 2 : 3
  ];
}
export function differenceColor(before: number | null, after: number | null): string {
  const a = before ?? Infinity,
    b = after ?? Infinity;
  return b < a - 0.01 ? '#479f91' : b > a + 0.01 ? '#ce876f' : '#c8d0cb';
}
