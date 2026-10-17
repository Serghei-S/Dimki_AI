import type { DeepReadonly, DistrictData, Destination, EditableObject, XY } from './types.js';
import { deepFreeze } from './util.js';
import {
  distanceToPolygon,
  nearestNetworkPoint,
  nearestParcelPoint,
  pointInPolygon,
  segmentEntersPolygon,
} from './design-geometry.js';

/** Explicit sketch assumptions, not statutory setbacks or approved land-use rules. */
export const PLACEMENT_RULES = deepFreeze({
  roadAccessM: 25,
  entranceGapM: 3,
  approachWidthM: 2,
  buildingFootprintFactor: 0.55,
  buildingHeightsM: { school: 13, clinic: 10, grocery: 7, community: 7 } as Partial<
    Record<Destination['kind'], number>
  >,
  siteSizesM: {
    school: [80, 60],
    clinic: [36, 28],
    grocery: [20, 16],
    community: [28, 20],
    parking: [24, 15],
    playground: [18, 14],
  } as Partial<Record<Destination['kind'], readonly [number, number]>>,
});
export function siteAccessPoint(
  site: readonly (readonly number[])[],
  kind: Destination['kind'],
  anchor: XY,
): XY {
  if (!['school', 'clinic', 'grocery', 'community'].includes(kind)) return nearestParcelPoint(anchor, site);
  const cx = (Math.min(...site.map((p) => p[0]!)) + Math.max(...site.map((p) => p[0]!))) / 2;
  const cy = (Math.min(...site.map((p) => p[1]!)) + Math.max(...site.map((p) => p[1]!))) / 2;
  const footprint = site.map(
    (p) =>
      [
        cx + (p[0]! - cx) * PLACEMENT_RULES.buildingFootprintFactor,
        cy + (p[1]! - cy) * PLACEMENT_RULES.buildingFootprintFactor,
      ] as XY,
  );
  return nearestParcelPoint(anchor, footprint);
}
export const PLACEMENT_HINTS: Record<Destination['kind'], string> = {
  bus_stop:
    'Нажмите на тротуар у улицы. Остановка не может находиться во дворе или в глубине парка. Новая остановка сама по себе не создаёт автобусный маршрут.',
  school:
    'Укажите пешеходный вход. Рядом ищется свободное место под эскизный участок 80 × 60 м; здания, дороги, парки и существующие дорожки сохраняются.',
  clinic:
    'Укажите вход с дорожки или тротуара. Рядом нужен свободный эскизный участок 36 × 28 м, без пересечения дороги к входу.',
  grocery:
    'Выберите вход у пешеходной сети. Рядом проверяется свободное место 20 × 16 м под предлагаемый объект.',
  community: 'Выберите вход с дорожки; рядом проверяется свободный эскизный участок 28 × 20 м.',
  park: 'Нарисуйте границу свободной территории. Входы привязываются к дорожкам; доступ считается до входов, а не до центра.',
  parking:
    'Выберите место у улицы. Нужна свободная площадка 24 × 15 м рядом с пешеходной сетью. Автомобильный въезд и дорожная ёмкость требуют отдельного проекта.',
  playground:
    'Выберите дорожку у свободной дворовой территории. Площадка 18 × 14 м не перекрывает здания, дороги и пути.',
  waste_bin:
    'Укажите место вдоль дорожки. Урна обозначает благоустройство; маршруты и доступ к школам от неё не улучшаются.',
};
export function polygonsOverlap(
  a: readonly (readonly number[])[],
  b: readonly (readonly number[])[],
): boolean {
  const box = (r: readonly (readonly number[])[]) => [
    Math.min(...r.map((p) => p[0]!)),
    Math.min(...r.map((p) => p[1]!)),
    Math.max(...r.map((p) => p[0]!)),
    Math.max(...r.map((p) => p[1]!)),
  ];
  const x = box(a),
    y = box(b);
  if (x[2]! < y[0]! || y[2]! < x[0]! || x[3]! < y[1]! || y[3]! < x[1]!) return false;
  return (
    a.some((p) => pointInPolygon(p, b)) ||
    b.some((p) => pointInPolygon(p, a)) ||
    a.slice(1).some((p, i) => segmentEntersPolygon([...a[i]!] as XY, [...p] as XY, b))
  );
}
export function siteProblem(
  data: DeepReadonly<DistrictData>,
  site: XY[],
  others: readonly DeepReadonly<EditableObject>[] = [],
  id?: string,
): string | null {
  const [x0, y0, x1, y1] = data.metadata.boundsM;
  if (site.some((p) => p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1))
    return 'Участок выходит за границу района.';
  if (data.buildings.some((b) => polygonsOverlap(site, b.polygon)))
    return 'Участок пересекает существующее здание.';
  if (data.roads.some((r) => polygonsOverlap(site, r.polygon))) return 'Участок пересекает проезжую часть.';
  if (data.parcels.some((p) => p.active && p.kind === 'public_park' && polygonsOverlap(site, p.polygon)))
    return 'Участок занимает существующий общественный парк.';
  if (
    data.edges.some(
      (e) =>
        e.active &&
        e.geometry
          .slice(1)
          .some((p, i) => segmentEntersPolygon([...e.geometry[i]!] as XY, [...p] as XY, site)),
    )
  )
    return 'Участок перекрывает существующую дорожку.';
  if (
    others.some(
      (o) =>
        o.id !== id &&
        o.active &&
        ((o.site && polygonsOverlap(site, o.site)) || (o.polygon && polygonsOverlap(site, o.polygon))),
    )
  )
    return 'Участок пересекает другой объект сценария.';
  return null;
}
export function suggestPlacement(
  data: DeepReadonly<DistrictData>,
  kind: Destination['kind'],
  point: XY,
  others: readonly DeepReadonly<EditableObject>[] = [],
  snapDistanceM = 80,
): { point: XY; site?: XY[]; message: string } {
  let snap = nearestNetworkPoint(data, point);
  if (kind === 'bus_stop' && snap && data.edges.find((e) => e.id === snap!.edgeId)?.kind !== 'sidewalk') {
    const sidewalk = nearestNetworkPoint(
      { ...data, edges: data.edges.filter((e) => e.kind === 'sidewalk') },
      point,
    );
    if (sidewalk && Math.hypot(sidewalk.point[0] - snap.point[0], sidewalk.point[1] - snap.point[1]) < 1e-7)
      snap = sidewalk;
  }
  if (!snap || snap.distanceM > snapDistanceM)
    throw Error(`Нет дорожки в пределах ${snapDistanceM} м. Выберите пешеходный вход ближе к сети.`);
  if (
    [...data.roads, ...data.buildings].some(
      (o) => pointInPolygon(point, o.polygon) || segmentEntersPolygon(point, snap.point, o.polygon),
    )
  )
    throw Error('Выберите точку со стороны тротуара: вход не должен проходить через здание или дорогу.');
  const roadDistance = Math.min(...data.roads.map((r) => distanceToPolygon(snap.point, r.polygon)));
  if ((kind === 'bus_stop' || kind === 'parking') && roadDistance > PLACEMENT_RULES.roadAccessM)
    throw Error(
      `Для ${kind === 'bus_stop' ? 'остановки' : 'парковки'} нужна улица не дальше ${PLACEMENT_RULES.roadAccessM} м. Здесь подходит дворовое благоустройство.`,
    );
  if (
    kind === 'bus_stop' &&
    (data.edges.find((e) => e.id === snap.edgeId)?.kind !== 'sidewalk' ||
      data.parcels.some((p) => p.active && p.kind === 'public_park' && pointInPolygon(snap.point, p.polygon)))
  )
    throw Error('Остановку можно разместить на тротуаре у улицы, вне территории парка.');
  const size = PLACEMENT_RULES.siteSizesM[kind];
  if (!size)
    return {
      point: snap.point,
      message: `Вход привязан к дорожке: ${Math.round(snap.distanceM)} м от указанной точки.`,
    };
  for (const [w, h] of [size, [size[1], size[0]] as const]) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const cx = snap.point[0] + dx! * (w / 2 + PLACEMENT_RULES.entranceGapM),
        cy = snap.point[1] + dy! * (h / 2 + PLACEMENT_RULES.entranceGapM);
      const site: XY[] = [
        [cx - w / 2, cy - h / 2],
        [cx + w / 2, cy - h / 2],
        [cx + w / 2, cy + h / 2],
        [cx - w / 2, cy + h / 2],
        [cx - w / 2, cy - h / 2],
      ];
      if (siteProblem(data, site, others)) continue;
      const boundary: XY = [
        Math.max(cx - w / 2, Math.min(cx + w / 2, snap.point[0])),
        Math.max(cy - h / 2, Math.min(cy + h / 2, snap.point[1])),
      ];
      if (
        [...data.roads, ...data.buildings].some((o) => segmentEntersPolygon(snap.point, boundary, o.polygon))
      )
        continue;
      return {
        point: snap.point,
        site,
        message: `Проверен свободный эскизный участок ${w} × ${h} м. Вход соединён с дорожкой. Назначение земли и инженерные условия пока не подтверждены.`,
      };
    }
  }
  throw Error(
    `Рядом нет свободного места ${size[0]} × ${size[1]} м без пересечения зданий, дорог, парков и дорожек. Выберите другой вход.`,
  );
}
export function relocateWithContext(
  data: DeepReadonly<DistrictData>,
  object: EditableObject,
  point: XY,
  others: readonly DeepReadonly<EditableObject>[] = [],
  snapDistanceM = 80,
): EditableObject {
  const placement = suggestPlacement(
    data,
    object.kind,
    point,
    others.filter((o) => o.id !== object.id),
    snapDistanceM,
  );
  const next = { ...structuredClone(object), entrances: [placement.point], placementChecked: true };
  delete next.site;
  if (placement.site) next.site = placement.site;
  return next;
}
