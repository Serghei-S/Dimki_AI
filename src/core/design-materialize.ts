import type { DistrictData, DesignState, EditableObject, XY, CostItem } from './types.js';
import { requireCondition } from './errors.js';
import {
  siteProblem,
  suggestPlacement,
  PLACEMENT_RULES,
  polygonsOverlap,
  siteAccessPoint,
} from './placement.js';
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
  distanceToPolygon,
  nearestParcelPoint,
  segmentEntersPolygon,
} from './design-geometry.js';
import {
  DESIGN_COSTS,
  MOVE_COST_RUB,
  REMOVE_COST_RUB,
  DEFAULT_CAPACITY,
  CAPACITY_FACTORS,
  capacityFactor,
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
      if (object.placementChecked)
        requireCondition(
          ![...source.roads, ...source.buildings].some((o) => polygonsOverlap(object.polygon!, o.polygon)),
          'INVALID_SCENARIO',
          'Новый парк пересекает дорогу или здание.',
        );
    }
    if (object.placementChecked && object.kind === 'bus_stop') {
      try {
        suggestPlacement(
          source,
          'bus_stop',
          object.entrances[0]!,
          design.objects,
          design.rules.snapDistanceM,
        );
      } catch (error) {
        requireCondition(
          false,
          'INVALID_SCENARIO',
          error instanceof Error ? error.message : 'Недопустимое место остановки',
        );
      }
    }
    if (object.placementChecked && PLACEMENT_RULES.siteSizesM[object.kind])
      requireCondition(
        object.site,
        'INVALID_SCENARIO',
        'Для нового объекта нужен свободный эскизный участок.',
      );
    if (object.site) {
      validatePolygon(object.site, data.metadata.boundsM);
      const problem = siteProblem(source, object.site, design.objects, object.id);
      requireCondition(!problem, 'INVALID_SCENARIO', `«${object.name}»: ${problem}`);
      const size = PLACEMENT_RULES.siteSizesM[object.kind];
      if (object.placementChecked && size)
        requireCondition(
          polygonArea(object.site) + 0.001 >= size[0] * size[1],
          'INVALID_SCENARIO',
          'Эскизный участок меньше принятого размера для выбранного типа.',
        );
      requireCondition(
        object.entrances.length === 1 && distanceToPolygon(object.entrances[0]!, object.site) <= 15,
        'INVALID_SCENARIO',
        'Вход должен находиться рядом с эскизным участком (не дальше 15 м).',
      );
      const boundary = nearestParcelPoint(object.entrances[0]!, object.site);
      requireCondition(
        ![...source.roads, ...source.buildings].some((o) =>
          segmentEntersPolygon(object.entrances[0]!, boundary, o.polygon),
        ),
        'INVALID_SCENARIO',
        'Вход к участку пересекает здание или дорогу.',
      );
    }
    plans.push({ object, nodes: [], snaps: [] });
  }
  // Build through-parks first, then other parks and point objects. This also permits
  // objects on newly created park paths without persisting fragile generated edge IDs.
  const batches = [
    plans.filter((p) => p.object.kind === 'park' && p.object.throughAccess),
    plans.filter((p) => p.object.kind === 'park' && !p.object.throughAccess),
    plans.filter((p) => p.object.kind !== 'park' && p.object.site),
    plans.filter((p) => p.object.kind !== 'park' && !p.object.site),
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
        if (object.site)
          requireCondition(
            distanceToPolygon(snap.point, object.site) <= 15 &&
              ![...source.roads, ...source.buildings].some((o) =>
                segmentEntersPolygon(snap.point, nearestParcelPoint(snap.point, object.site!), o.polygon),
              ),
            'INVALID_SCENARIO',
            'Реальный вход с дорожки должен быть рядом с участком и не пересекать дорогу или здание.',
          );
        if (object.placementChecked && object.kind === 'parking')
          requireCondition(
            Math.min(...source.roads.map((r) => distanceToPolygon(snap.point, r.polygon))) <=
              PLACEMENT_RULES.roadAccessM,
            'INVALID_SCENARIO',
            'Парковке нужен доступ к улице.',
          );
        if (object.kind === 'park') {
          const original = source.destinations.find((d) => d.id === object.id);
          const originalPolygon = source.parcels.find((p) => p.id === original?.parcelId)?.polygon;
          const originalPoints = original?.accessNodeIds.map(
            (id) => source.nodes.find((n) => n.id === id)!.xy,
          );
          const unchanged =
            !object.autoEntrances &&
            JSON.stringify(originalPolygon) === JSON.stringify(object.polygon) &&
            JSON.stringify(originalPoints) === JSON.stringify(object.entrances);
          requireCondition(
            unchanged || distanceToPolygon(snap.point, object.polygon!) <= design.rules.entranceGapM + 1e-7,
            'INVALID_SCENARIO',
            `Вход парка «${object.name}» удалён от его территории больше чем на ${design.rules.entranceGapM} м. Переместите вход или измените границу.`,
          );
          const boundary = nearestParcelPoint(snap.point, object.polygon!);
          requireCondition(
            unchanged ||
              ![...data.roads, ...data.buildings].some((obstacle) =>
                segmentEntersPolygon(snap.point, boundary, obstacle.polygon),
              ),
            'INVALID_SCENARIO',
            `Вход парка «${object.name}» соединён с границей через дорогу или здание. Выберите вход со стороны парка.`,
          );
        }
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
      if (object.site && nodes[0]) {
        const anchor = data.nodes.find((n) => n.id === nodes[0])!.xy;
        const door = siteAccessPoint(object.site, object.kind, [...anchor]);
        requireCondition(
          pointInPolygon(door, object.site) &&
            ![...source.roads, ...source.buildings].some((o) =>
              segmentEntersPolygon([...anchor], door, o.polygon),
            ),
          'INVALID_SCENARIO',
          'Не удаётся построить безопасный подход от сети к объекту.',
        );
        const lengthM = Math.hypot(door[0] - anchor[0], door[1] - anchor[1]);
        if (lengthM > 0.01) {
          const entry = uid('entrance');
          data.nodes.push({ id: entry, xy: door, active: true, kind: 'building_entrance', blockId: null });
          data.edges.push({
            id: uid('approach'),
            from: nodes[0],
            to: entry,
            geometry: [[...anchor], door],
            lengthM,
            kind: 'access',
            active: true,
            bidirectional: true,
            surface: 'paving',
            widthM: PLACEMENT_RULES.approachWidthM,
            slope: 0,
            stairs: false,
            crossing: null,
          });
          nodes[0] = entry;
        }
      }
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
        // Moving/upgrading a stop does not create bus routes. New services need their own data.
        routeIds = old?.kind === 'bus_stop' ? [...old.routeIds] : [];
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
          : object.capacity === null
            ? null
            : Math.floor(object.capacity * capacityFactor(object.kind, object.level));
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
          requireCondition(
            ![...source.roads, ...source.buildings].some((obstacle) =>
              segmentEntersPolygon(p, center, obstacle.polygon),
            ),
            'INVALID_SCENARIO',
            'Внутренняя дорожка пересекает дорогу или здание',
          );
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
  // A changed area norm must also update untouched parks, not only edited objects.
  const levels = new Map(design.objects.map((o) => [o.id, o.level]));
  data.destinations = data.destinations.map((d) => {
    const parcel = d.active && d.kind === 'park' ? data.parcels.find((p) => p.id === d.parcelId) : null;
    if (!parcel) return d;
    const capacity = Math.floor(
      (parcel.areaM2 / design.rules.parkM2PerVisitor) * CAPACITY_FACTORS[levels.get(d.id) ?? 0],
    );
    return capacity === d.capacity ? d : { ...d, capacity };
  });
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
