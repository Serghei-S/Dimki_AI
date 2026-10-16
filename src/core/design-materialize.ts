import type { DistrictData, DesignState, EditableObject, XY, CostItem } from './types.js';
import { requireCondition } from './errors.js';
import {
  autoParkEntrances,
  nearestNetworkPoint,
  polygonArea,
  slicePolyline,
  lengthOf,
  pointInPolygon,
  pointAlong,
  validatePolygon,
  projectSegment,
} from './design-geometry.js';
import {
  DESIGN_COSTS,
  MOVE_COST_RUB,
  REMOVE_COST_RUB,
  DEFAULT_CAPACITY,
  CAPACITY_FACTORS,
} from './design-rules.js';

export function applyDesign(
  source: DistrictData,
  design: DesignState,
): { data: DistrictData; capexRub: number; costItems: CostItem[] } {
  const data: DistrictData = {
    ...source,
    nodes: [...source.nodes],
    edges: [...source.edges],
    destinations: [...source.destinations],
    parcels: [...source.parcels],
    stopBays: [...source.stopBays],
  };
  const allIds = new Set(
    [
      source.nodes,
      source.edges,
      source.destinations,
      source.parcels,
      source.buildings,
      source.projects,
      source.roads,
      source.blocks,
      source.stopBays,
      source.transitServices,
      source.profiles,
      source.scenarios,
    ].flatMap((items) => items.map((i) => i.id)),
  );
  let sequence = 0;
  const uid = (kind: string) => {
    let id: string;
    do {
      id = `__edit_${kind}_${sequence++}`;
    } while (allIds.has(id));
    allIds.add(id);
    return id;
  };
  const seen = new Set<string>(),
    plans: {
      object: EditableObject;
      nodes: string[];
      snaps: NonNullable<ReturnType<typeof nearestNetworkPoint>>[];
    }[] = [];
  let capexRub = 0;
  const costItems: CostItem[] = [];
  const charge = (object: EditableObject, amountRub: number, formula: string) => {
    if (amountRub > 0) {
      capexRub += amountRub;
      costItems.push({ id: object.id, name: object.name, amountRub, formula });
    }
  };
  for (const object of [...design.objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    requireCondition(!seen.has(object.id), 'INVALID_SCENARIO', 'Объект повторяется в сценарии');
    seen.add(object.id);
    const old = source.destinations.find((d) => d.id === object.id);
    requireCondition(
      old || (!allIds.has(object.id) && object.id.startsWith('user_')),
      'INVALID_SCENARIO',
      'Идентификатор нового объекта должен начинаться с user_',
    );
    if (!object.active) {
      if (old?.active) {
        data.destinations[data.destinations.indexOf(old)] = { ...old, active: false };
        charge(object, REMOVE_COST_RUB, 'Удаление существующего объекта');
      }
      continue;
    }
    requireCondition(
      object.kind === 'park' || (object.entrances.length === 1 && object.polygon === null),
      'INVALID_SCENARIO',
      'Точечный объект должен иметь ровно один вход и не иметь многоугольника',
    );
    if (object.kind === 'park') {
      requireCondition(object.polygon, 'INVALID_SCENARIO', 'Нужна граница парка');
      validatePolygon(object.polygon, data.metadata.boundsM);
    }
    plans.push({ object, nodes: [], snaps: [] });
  }
  // Build through-parks first, then other parks and point objects. This also permits
  // objects on newly created park paths without persisting fragile generated edge IDs.
  const batches = [
    plans.filter((p) => p.object.kind === 'park' && p.object.throughAccess),
    plans.filter((p) => p.object.kind === 'park' && !p.object.throughAccess),
    plans.filter((p) => p.object.kind !== 'park'),
  ];
  for (const batch of batches) {
    for (const plan of batch) {
      const object = plan.object;
      const points =
        object.kind === 'park' && object.autoEntrances
          ? autoParkEntrances(data, object.polygon!, design.rules.entranceGapM)
          : object.entrances;
      plan.snaps = points.map((p) => {
        const snap = nearestNetworkPoint(data, p);
        requireCondition(
          snap && snap.distanceM <= design.rules.snapDistanceM,
          'INVALID_SCENARIO',
          `Объект «${object.name}»: рядом со входом нет тротуара или дорожки (предел ${design.rules.snapDistanceM} м)`,
        );
        return snap;
      });
    }
    // Cut all points on an edge in one ordered pass. Coincident points share a node.
    const byEdge = new Map<
      string,
      { plan: (typeof plans)[number]; i: number; snap: (typeof plans)[number]['snaps'][number] }[]
    >();
    for (const plan of batch)
      plan.snaps.forEach((snap, i) => {
        const cuts = byEdge.get(snap.edgeId) ?? [];
        cuts.push({ plan, i, snap });
        byEdge.set(snap.edgeId, cuts);
      });
    for (const [edgeId, cuts] of byEdge) {
      const edge = data.edges.find((e) => e.id === edgeId)!;
      cuts.sort((a, b) => a.snap.alongM - b.snap.alongM);
      const vertices: { distance: number; nodeId: string; point: XY }[] = [
        { distance: 0, nodeId: edge.from, point: [...edge.geometry[0]!] as XY },
      ];
      for (const cut of cuts) {
        if (cut.snap.alongM < 0.01) {
          cut.plan.nodes[cut.i] = edge.from;
          continue;
        }
        if (edge.lengthM - cut.snap.alongM < 0.01) {
          cut.plan.nodes[cut.i] = edge.to;
          continue;
        }
        let vertex = vertices.at(-1)!;
        if (cut.snap.alongM - vertex.distance >= 0.01) {
          const nodeId = uid('node'),
            point = cut.snap.point;
          data.nodes.push({ id: nodeId, xy: point, active: true, kind: 'sidewalk', blockId: null });
          vertex = { distance: cut.snap.alongM, nodeId, point };
          vertices.push(vertex);
        }
        cut.plan.nodes[cut.i] = vertex.nodeId;
      }
      if (vertices.length === 1) continue;
      vertices.push({ distance: edge.lengthM, nodeId: edge.to, point: [...edge.geometry.at(-1)!] as XY });
      const originalIndex = data.edges.findIndex((e) => e.id === edge.id);
      data.edges[originalIndex] = { ...edge, active: false };
      for (let i = 1; i < vertices.length; i++) {
        const a = vertices[i - 1]!,
          b = vertices[i]!,
          geometry = slicePolyline(edge.geometry, a.distance, b.distance);
        geometry[0] = a.point;
        geometry[geometry.length - 1] = b.point;
        data.edges.push({
          ...edge,
          id: uid('edge'),
          from: a.nodeId,
          to: b.nodeId,
          geometry,
          lengthM: lengthOf(geometry),
        });
      }
    }
    for (const { object, nodes, snaps } of batch) {
      const old = source.destinations.find((d) => d.id === object.id);
      const oldPoints = old?.accessNodeIds.map((id) => source.nodes.find((n) => n.id === id)!.xy) ?? [];
      const moved =
        !old ||
        oldPoints.length !== snaps.length ||
        snaps.some(
          (snap, i) =>
            !oldPoints[i] ||
            Math.hypot(snap.point[0] - oldPoints[i]![0], snap.point[1] - oldPoints[i]![1]) > 0.02,
        );
      const area = object.polygon ? polygonArea(object.polygon) : 0,
        oldArea = old?.parcelId ? (source.parcels.find((p) => p.id === old.parcelId)?.areaM2 ?? 0) : 0;
      const price =
        object.kind === 'park'
          ? area * DESIGN_COSTS.park[object.level]!
          : DESIGN_COSTS[object.kind][object.level]!;
      if (!old?.active || old.kind !== object.kind) {
        charge(
          object,
          price,
          object.kind === 'park'
            ? `${area} м² × ${DESIGN_COSTS.park[object.level]} ₽/м²`
            : `Создание, уровень ${object.level + 1}`,
        );
        if (old?.active) charge(object, REMOVE_COST_RUB, 'Удаление прежнего типа объекта');
      } else {
        if (moved) charge(object, MOVE_COST_RUB, 'Перенос / изменение входов');
        const increase =
          object.kind === 'park'
            ? Math.max(0, price - oldArea * DESIGN_COSTS.park[0]!)
            : DESIGN_COSTS[object.kind][object.level]! - DESIGN_COSTS[object.kind][0]!;
        charge(
          object,
          increase,
          object.kind === 'park'
            ? `max(0; ${area} м² × ${DESIGN_COSTS.park[object.level]} − ${oldArea} м² × ${DESIGN_COSTS.park[0]})`
            : `Улучшение: ${DESIGN_COSTS[object.kind][object.level]} − ${DESIGN_COSTS[object.kind][0]} ₽`,
        );
      }
      if (object.kind !== 'park') {
        const extra = Math.max(
          0,
          (object.capacity ?? 0) -
            (old?.kind === object.kind
              ? (old.capacity ?? DEFAULT_CAPACITY[object.kind])
              : DEFAULT_CAPACITY[object.kind]),
        );
        charge(object, extra * 1000, `${extra} дополнительных мест × 1000 ₽`);
      }

      let parcelId: string | null = null,
        stopBayId: string | null = null;
      if (object.kind === 'park') {
        parcelId = old?.kind === 'park' && old.parcelId ? old.parcelId : uid('parcel');
        const parcel = {
          id: parcelId,
          name: object.name,
          blockId:
            source.blocks.find((b) => pointInPolygon(object.polygon![0]!, b.polygon))?.id ??
            source.blocks[0]!.id,
          kind: 'public_park' as const,
          polygon: object.polygon!,
          areaM2: polygonArea(object.polygon!),
          active: true,
          fence: null,
        };
        const index = data.parcels.findIndex((p) => p.id === parcelId);
        if (index < 0) data.parcels.push(parcel);
        else data.parcels[index] = parcel;
      }
      let routeIds = old?.routeIds ?? [];
      if (object.kind === 'bus_stop') {
        const p = data.nodes.find((n) => n.id === nodes[0])!.xy;
        const road = [...source.roads].sort((a, b) => roadDistance(a, p) - roadDistance(b, p))[0]!;
        stopBayId = uid('bay');
        routeIds = source.transitServices.slice(0, object.level + 1).map((s) => s.id);
        data.stopBays.push({
          id: stopBayId,
          name: object.name,
          nodeId: nodes[0]!,
          roadId: road.id,
          side:
            road.axis === 'vertical'
              ? p[0] < road.centerM
                ? 'west'
                : 'east'
              : p[1] < road.centerM
                ? 'south'
                : 'north',
          routeIds,
          stepFreeBoardingAssumed: true,
        });
      }
      const capacity =
        object.kind === 'park'
          ? Math.floor(
              (polygonArea(object.polygon!) / design.rules.parkM2PerVisitor) * CAPACITY_FACTORS[object.level],
            )
          : object.capacity;
      const destination = {
        id: object.id,
        name: object.name,
        kind: object.kind,
        active: true,
        accessNodeIds: [...new Set(nodes)],
        parcelId,
        stopBayId,
        buildingId: null,
        capacity,
        openingHours: old?.openingHours ?? 'Условно открыто',
        routeIds,
      };
      const index = data.destinations.findIndex((d) => d.id === object.id);
      if (index < 0) data.destinations.push(destination);
      else data.destinations[index] = destination;
      if (object.kind === 'park' && object.throughAccess && nodes.length > 1) {
        const polygon = object.polygon!,
          center: XY = [
            polygon.slice(0, -1).reduce((s, p) => s + p[0], 0) / (polygon.length - 1),
            polygon.slice(0, -1).reduce((s, p) => s + p[1], 0) / (polygon.length - 1),
          ];
        requireCondition(
          pointInPolygon(center, polygon),
          'INVALID_SCENARIO',
          'Для этого вогнутого парка нельзя автоматически построить прямые внутренние дорожки',
        );
        const hub = uid('park_hub');
        data.nodes.push({ id: hub, xy: center, active: true, kind: 'junction', blockId: null });
        for (const node of new Set(nodes)) {
          const p = data.nodes.find((n) => n.id === node)!.xy,
            geometry: XY[] = [[...p], center],
            length = lengthOf(geometry);
          if (length < 0.01) continue;
          let entered = false;
          for (let d = 0; d <= length; d += Math.min(1, length)) {
            const q = pointAlong(geometry, d);
            const inside = pointInPolygon(q, polygon);
            requireCondition(
              !entered || inside,
              'INVALID_SCENARIO',
              'Прямая внутренняя дорожка выходит за границу вогнутого парка',
            );
            if (inside) entered = true;
            requireCondition(
              !source.roads.some((r) => pointInPolygon(q, r.polygon)) &&
                !source.buildings.some((b) => pointInPolygon(q, b.polygon)),
              'INVALID_SCENARIO',
              'Внутренняя дорожка пересекает дорогу или здание',
            );
          }
          data.edges.push({
            id: uid('park_path'),
            from: node,
            to: hub,
            geometry,
            lengthM: length,
            kind: 'park_path',
            active: true,
            bidirectional: true,
            surface: 'paving',
            widthM: 3,
            slope: 0,
            stairs: false,
            crossing: null,
          });
        }
      }
    }
  }
  // Round the final total once; line items retain full precision for audit.
  return { data, capexRub: Math.round(capexRub), costItems };
}
function roadDistance(road: DistrictData['roads'][number], p: XY): number {
  if (!road.centerline) return Math.abs((road.axis === 'vertical' ? p[0] : p[1]) - road.centerM);
  return Math.min(
    ...road.centerline.slice(1).map((b, i) => {
      const q = projectSegment(p, road.centerline![i]!, b);
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    }),
  );
}
