import type { DeepReadonly, DistrictData } from '../core/types.js';
import { bounds, pointInside, distanceToSegment, type Point } from './geometry.js';
import { SpatialIndex } from './spatial.js';

/** Decorative only: never adds park area, access nodes or demand to the planning graph. */
export function createLawnSizer(data: DeepReadonly<DistrictData>) {
  const maxRadius = 14;
  const polygons = new SpatialIndex<readonly Point[]>();
  const paths = new SpatialIndex<{ a: Point; b: Point; halfWidth: number }>();
  for (const polygon of [
    ...data.roads.map((r) => r.polygon),
    ...data.buildings.map((b) => b.polygon),
    ...data.parcels.filter((p) => p.kind === 'vacant').map((p) => p.polygon),
  ]) {
    const b = bounds(polygon);
    polygons.add(
      {
        minX: b.minX - maxRadius,
        minY: b.minY - maxRadius,
        maxX: b.maxX + maxRadius,
        maxY: b.maxY + maxRadius,
      },
      polygon,
    );
  }
  for (const edge of data.edges.filter((e) => e.active))
    for (let i = 1; i < edge.geometry.length; i++) {
      const a = edge.geometry[i - 1]!,
        b = edge.geometry[i]!,
        margin = edge.widthM / 2 + maxRadius;
      paths.add(
        {
          minX: Math.min(a[0], b[0]) - margin,
          minY: Math.min(a[1], b[1]) - margin,
          maxX: Math.max(a[0], b[0]) + margin,
          maxY: Math.max(a[1], b[1]) + margin,
        },
        { a, b, halfWidth: edge.widthM / 2 },
      );
    }
  return (point: Point, block: readonly Point[], desiredRadius: number): number => {
    if (!pointInside(point, block)) return 0;
    let radius = Math.min(maxRadius, Math.max(0, desiredRadius));
    const constrain = (ring: readonly Point[]) => {
      for (let i = 1; i < ring.length; i++)
        radius = Math.min(radius, distanceToSegment(point, ring[i - 1]!, ring[i]!) - 0.6);
    };
    constrain(block);
    for (const polygon of polygons.at(point[0], point[1])) {
      if (pointInside(point, polygon)) return 0;
      constrain(polygon);
    }
    for (const path of paths.at(point[0], point[1]))
      radius = Math.min(radius, distanceToSegment(point, path.a, path.b) - path.halfWidth - 0.8);
    return Math.max(0, radius);
  };
}
