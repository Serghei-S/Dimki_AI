import type { DeepReadonly, DistrictData } from './types.js';
import type { XY } from './design-types.js';
import { requireCondition } from './errors.js';
export interface NetworkSnap {
  edgeId: string;
  point: XY;
  alongM: number;
  distanceM: number;
}
export function lengthOf(points: readonly (readonly number[])[]): number {
  return points
    .slice(1)
    .reduce((s, b, i) => s + Math.hypot(b[0]! - points[i]![0]!, b[1]! - points[i]![1]!), 0);
}
export function projectSegment(p: readonly number[], a: readonly number[], b: readonly number[]): XY {
  const dx = b[0]! - a[0]!,
    dy = b[1]! - a[1]!,
    den = dx * dx + dy * dy,
    t = den ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / den)) : 0;
  return [a[0]! + t * dx, a[1]! + t * dy];
}
export function pointAlong(points: readonly (readonly number[])[], distance: number): XY {
  let remaining = distance;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      l = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
    if (remaining <= l || i === points.length - 1) {
      const t = l ? Math.max(0, Math.min(1, remaining / l)) : 0;
      return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t];
    }
    remaining -= l;
  }
  return [...points[0]!] as XY;
}
export function nearestNetworkPoint(
  data: DeepReadonly<DistrictData>,
  point: readonly number[],
): NetworkSnap | null {
  const nodes = new Map(data.nodes.map((n) => [n.id, n.active]));
  let best: NetworkSnap | null = null;
  for (const edge of data.edges) {
    if (!edge.active || edge.kind === 'crossing' || !nodes.get(edge.from) || !nodes.get(edge.to)) continue;
    let along = 0;
    for (let i = 1; i < edge.geometry.length; i++) {
      const a = edge.geometry[i - 1]!,
        b = edge.geometry[i]!,
        q = projectSegment(point, a, b),
        distanceM = Math.hypot(q[0] - point[0]!, q[1] - point[1]!);
      if (
        !best ||
        distanceM < best.distanceM - 1e-8 ||
        (Math.abs(distanceM - best.distanceM) < 1e-8 && edge.id < best.edgeId)
      )
        best = { edgeId: edge.id, point: q, alongM: along + Math.hypot(q[0] - a[0], q[1] - a[1]), distanceM };
      along += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  return best;
}
export function polygonArea(ring: readonly (readonly number[])[]): number {
  return Math.abs(ring.slice(1).reduce((s, b, i) => s + ring[i]![0]! * b[1]! - b[0]! * ring[i]![1]!, 0)) / 2;
}
/** Distance to the parcel, zero when the network entrance lies inside it. */
export function distanceToPolygon(point: XY, ring: readonly (readonly number[])[]): number {
  if (pointInPolygon(point, ring)) return 0;
  return Math.min(
    ...ring.slice(1).map((b, i) => {
      const q = projectSegment(point, ring[i]!, b);
      return Math.hypot(point[0] - q[0], point[1] - q[1]);
    }),
  );
}
export function nearestParcelPoint(point: XY, ring: readonly (readonly number[])[]): XY {
  if (pointInPolygon(point, ring)) return [...point];
  return ring
    .slice(1)
    .map((b, i) => projectSegment(point, ring[i]!, b))
    .sort(
      (a, b) => Math.hypot(a[0] - point[0], a[1] - point[1]) - Math.hypot(b[0] - point[0], b[1] - point[1]),
    )[0]!;
}
/** Exact boundary splits, then interior tests; narrow obstacles are not skipped by sampling. */
export function segmentEntersPolygon(a: XY, b: XY, ring: readonly (readonly number[])[]): boolean {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    length2 = dx * dx + dy * dy;
  if (length2 < 1e-14) return false;
  const cuts = [0, 1];
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1]!,
      d = ring[i]!,
      ex = d[0]! - c[0]!,
      ey = d[1]! - c[1]!;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) > 1e-12) {
      const t = ((c[0]! - a[0]) * ey - (c[1]! - a[1]) * ex) / den;
      const u = ((c[0]! - a[0]) * dy - (c[1]! - a[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    } else
      for (const p of [c, d]) {
        const t = ((p[0]! - a[0]) * dx + (p[1]! - a[1]) * dy) / length2;
        if (t > 0 && t < 1) cuts.push(t);
      }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1]! + cuts[i]!) / 2,
      p: XY = [a[0] + dx * t, a[1] + dy * t];
    if (!pointInPolygon(p, ring)) continue;
    const boundary = Math.min(
      ...ring.slice(1).map((b, j) => {
        const q = projectSegment(p, ring[j]!, b);
        return Math.hypot(p[0] - q[0], p[1] - q[1]);
      }),
    );
    if (boundary > 1e-7) return true;
  }
  return false;
}
const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
  (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
export function pointInPolygon(p: readonly number[], ring: readonly (readonly number[])[]): boolean {
  let yes = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1]!,
      b = ring[i]!;
    const q = projectSegment(p, a, b);
    if (Math.hypot(q[0] - p[0]!, q[1] - p[1]!) < 1e-7) return true;
    if (
      a[1]! > p[1]! !== b[1]! > p[1]! &&
      p[0]! < ((b[0]! - a[0]!) * (p[1]! - a[1]!)) / (b[1]! - a[1]!) + a[0]!
    )
      yes = !yes;
  }
  return yes;
}
export function validatePolygon(ring: XY[], bounds: readonly number[]): void {
  requireCondition(
    ring.length >= 4 &&
      ring.length <= 65 &&
      ring[0]![0] === ring.at(-1)![0] &&
      ring[0]![1] === ring.at(-1)![1],
    'INVALID_SCENARIO',
    'Граница парка должна быть замкнутой и содержать 3–64 вершины',
  );
  requireCondition(polygonArea(ring) >= 10, 'INVALID_SCENARIO', 'Площадь парка должна быть не меньше 10 м²');
  for (const p of ring)
    requireCondition(
      p[0] >= bounds[0]! && p[0] <= bounds[2]! && p[1] >= bounds[1]! && p[1] <= bounds[3]!,
      'INVALID_SCENARIO',
      'Граница парка выходит за пределы района',
    );
  for (let i = 0; i < ring.length - 1; i++) {
    requireCondition(
      lengthOf([ring[i]!, ring[i + 1]!]) > 0.05,
      'INVALID_SCENARIO',
      'Совпадающие вершины границы',
    );
    for (let j = i + 2; j < ring.length - 1; j++) {
      if (i === 0 && j === ring.length - 2) continue;
      const a = ring[i]!,
        b = ring[i + 1]!,
        c = ring[j]!,
        d = ring[j + 1]!;
      const overlap =
        Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
          Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) + 1e-8 &&
        Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
          Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) + 1e-8;
      requireCondition(
        !(overlap && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0),
        'INVALID_SCENARIO',
        'Граница парка пересекает сама себя',
      );
    }
  }
}
export function autoParkEntrances(data: DeepReadonly<DistrictData>, polygon: XY[], maxGap: number): XY[] {
  const result: XY[] = [];
  const active = new Set(data.nodes.filter((n) => n.active).map((n) => n.id));
  for (let i = 1; i < polygon.length; i++) {
    const a = polygon[i - 1]!,
      b = polygon[i]!;
    let best: NetworkSnap | null = null;
    for (const edge of data.edges) {
      if (!edge.active || edge.kind === 'crossing' || !active.has(edge.from) || !active.has(edge.to))
        continue;
      for (let j = 1; j < edge.geometry.length; j++) {
        const c = edge.geometry[j - 1]!,
          d = edge.geometry[j]!;
        const middle: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
        const t = denominator
          ? ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator
          : -1;
        const u = denominator
          ? ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator
          : -1;
        const intersection: XY[] =
          t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [[a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]] : [];
        for (const p of [...intersection, middle, a, b, projectSegment(c, a, b), projectSegment(d, a, b)]) {
          const q = projectSegment(p, c, d),
            gap = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (
            !best ||
            gap < best.distanceM - 1e-8 ||
            (Math.abs(gap - best.distanceM) < 1e-8 && lengthOf([q, middle]) < lengthOf([best.point, middle]))
          )
            best = { edgeId: edge.id, point: q, distanceM: gap, alongM: 0 };
        }
      }
    }
    if (
      best &&
      best.distanceM <= maxGap &&
      !result.some((p) => Math.hypot(p[0] - best!.point[0], p[1] - best!.point[1]) < 2)
    )
      result.push(best.point);
  }
  return result;
}
export function slicePolyline(points: XY[], start: number, end: number): XY[] {
  const result = [pointAlong(points, start)];
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    along += lengthOf([points[i - 1]!, points[i]!]);
    if (along > start + 1e-7 && along < end - 1e-7) result.push([...points[i]!] as XY);
  }
  result.push(pointAlong(points, end));
  return result;
}
