import type { DeepReadonly, DistrictData, Profile, RouteResult } from '../core/types.js';
import { edgeTravelSeconds } from '../core/graph.js';
import type { ActivityRoute } from '../core/types.js';

export interface MotionLeg {
  startSeconds: number;
  waitSeconds: number;
  walkingSeconds: number;
  points: readonly (readonly [number, number])[];
  cumulativeM: number[];
  lengthM: number;
}
export interface MotionPath {
  buildingId: string;
  residents: number;
  legs: MotionLeg[];
  travelSeconds: number;
  cycleSeconds: number;
}
export interface MotionSample {
  x: number;
  y: number;
  heading: number;
  walking: boolean;
  visible: number;
  phase: number;
}
export function createMotionPaths(
  data: DeepReadonly<DistrictData>,
  profile: Profile,
  routes: readonly RouteResult[],
): MotionPath[] {
  const edges = new Map(data.edges.map((e) => [e.id, e])),
    homes = new Map(data.buildings.map((b) => [b.id, b]));
  const result: MotionPath[] = [];
  for (const route of routes) {
    if (!route.reachable || !route.edgeIds.length) continue;
    const legs: MotionLeg[] = [];
    let startSeconds = 0;
    route.edgeIds.forEach((id, i) => {
      const source = edges.get(id);
      if (!source || !source.active) throw new Error(`Animation route contains unavailable edge: ${id}`);
      const forward = source.from === route.nodeIds[i] && source.to === route.nodeIds[i + 1];
      if (
        !forward &&
        !(source.bidirectional && source.to === route.nodeIds[i] && source.from === route.nodeIds[i + 1])
      )
        throw new Error(`Animation route direction mismatch: ${id}`);
      const edge = { ...source, geometry: source.geometry.map((p) => [...p] as [number, number]) };
      const seconds = edgeTravelSeconds(edge, profile);
      if (seconds === null) throw new Error(`Animation route is not eligible for profile: ${id}`);
      const points = forward ? source.geometry : [...source.geometry].reverse();
      const cumulativeM = [0];
      for (let j = 1; j < points.length; j++)
        cumulativeM.push(
          cumulativeM[j - 1]! +
            Math.hypot(points[j]![0] - points[j - 1]![0], points[j]![1] - points[j - 1]![1]),
        );
      const waitSeconds = source.crossing?.waitSeconds ?? 0;
      legs.push({
        startSeconds,
        waitSeconds,
        walkingSeconds: seconds - waitSeconds,
        points,
        cumulativeM,
        lengthM: cumulativeM.at(-1)!,
      });
      startSeconds += seconds;
    });
    result.push({
      buildingId: route.buildingId,
      residents: homes.get(route.buildingId)?.population?.total ?? 0,
      legs,
      travelSeconds: startSeconds,
      cycleSeconds: startSeconds + 90,
    });
  }
  return result;
}
/** Visual samples represent the active traffic mix, not every resident on a repeated trip. */
export function createActivityMotionPaths(
  data: DeepReadonly<DistrictData>,
  profile: Profile,
  routes: readonly ActivityRoute[],
): MotionPath[] {
  return routes.flatMap((trip) =>
    createMotionPaths(data, profile, [trip.route]).map((path) => ({
      ...path,
      residents: trip.expectedOnNetwork,
      cycleSeconds: path.travelSeconds,
    })),
  );
}
export function sampleMotion(
  path: MotionPath,
  time: number,
  out: MotionSample = { x: 0, y: 0, heading: 0, walking: false, visible: 0, phase: 0 },
): MotionSample {
  const phase = ((time % path.cycleSeconds) + path.cycleSeconds) % path.cycleSeconds;
  if (phase >= path.travelSeconds) {
    const last = path.legs.at(-1)!.points.at(-1)!;
    out.x = last[0];
    out.y = last[1];
    out.heading = 0;
    out.walking = false;
    out.visible = 0;
    out.phase = phase;
    return out;
  }
  let low = 0,
    high = path.legs.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (path.legs[mid]!.startSeconds <= phase) low = mid;
    else high = mid - 1;
  }
  const leg = path.legs[low]!,
    local = phase - leg.startSeconds,
    walking = local >= leg.waitSeconds;
  const distance = Math.min(
    leg.lengthM,
    Math.max(0, ((local - leg.waitSeconds) / leg.walkingSeconds) * leg.lengthM),
  );
  let part = 1;
  while (part < leg.cumulativeM.length - 1 && leg.cumulativeM[part]! < distance) part++;
  const a = leg.points[part - 1]!,
    b = leg.points[part]!;
  const span = leg.cumulativeM[part]! - leg.cumulativeM[part - 1]!,
    t = span > 0 ? (distance - leg.cumulativeM[part - 1]!) / span : 0;
  out.x = a[0] + (b[0] - a[0]) * t;
  out.y = a[1] + (b[1] - a[1]) * t;
  out.heading = Math.atan2(b[0] - a[0], -(b[1] - a[1]));
  out.walking = walking;
  out.visible = Math.min(1, phase / 3, (path.travelSeconds - phase) / 3);
  out.phase = phase;
  return out;
}
export function deterministicRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
export function pickWeightedPath(paths: readonly MotionPath[], value: number): number {
  const total = paths.reduce((sum, path) => sum + path.residents, 0);
  let remaining = value * total;
  for (let i = 0; i < paths.length; i++) {
    remaining -= paths[i]!.residents;
    if (remaining < 0) return i;
  }
  return Math.max(0, paths.length - 1);
}
