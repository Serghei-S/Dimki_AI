import type { DeepReadonly, DistrictData, XY } from '../core/types.js';
export function projectLocations(data: DeepReadonly<DistrictData>, ids: readonly string[]): XY[] {
  const points: XY[] = [];
  const center = (ring: readonly (readonly number[])[]): XY => [
    (Math.min(...ring.map((p) => p[0]!)) + Math.max(...ring.map((p) => p[0]!))) / 2,
    (Math.min(...ring.map((p) => p[1]!)) + Math.max(...ring.map((p) => p[1]!))) / 2,
  ];
  for (const id of ids) {
    const project = data.projects.find((p) => p.id === id);
    if (!project) continue;
    if (project.parcelId) {
      const p = data.parcels.find((p) => p.id === project.parcelId);
      if (p) points.push(center(p.polygon));
    }
    for (const op of project.operations) {
      const target = op.op === 'relocate_destination' ? op.nodeId : op.targetId;
      const node = data.nodes.find((n) => n.id === target),
        edge = data.edges.find((e) => e.id === target),
        parcel = data.parcels.find((p) => p.id === target),
        destination = data.destinations.find((d) => d.id === target);
      if (node) points.push([...node.xy]);
      else if (edge) points.push(center(edge.geometry));
      else if (parcel) points.push(center(parcel.polygon));
      else if (destination) {
        const n = data.nodes.find((n) => n.id === destination.accessNodeIds[0]);
        if (n) points.push([...n.xy]);
      }
    }
  }
  return [...new Map(points.map((p) => [p.map((v) => v.toFixed(3)).join(','), p])).values()];
}
