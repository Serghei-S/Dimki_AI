import type { Destination, DeepReadonly, DistrictData } from './types.js';
import type { DesignRules, EditableObject, XY } from './design-types.js';
import { deepFreeze } from './util.js';
export const DEFAULT_DESIGN_RULES: DesignRules = {
  distanceThresholdM: 400,
  parkM2PerVisitor: 10,
  snapDistanceM: 80,
  entranceGapM: 25,
  candidateSpacingM: 60,
};
export const OBJECT_KINDS: Record<Destination['kind'], string> = {
  bus_stop: 'Остановка',
  school: 'Школа',
  clinic: 'Поликлиника',
  grocery: 'Магазин',
  park: 'Парк / сквер',
  community: 'Районный центр',
  parking: 'Парковка',
  playground: 'Детская площадка',
  waste_bin: 'Урна',
};
export const LEVEL_NAMES: Record<Destination['kind'], readonly string[]> = {
  bus_stop: ['Обычная', 'С навесом', 'Хаб'],
  park: ['Сквер', 'Парк', 'Парк с площадками'],
  school: ['Базовая', 'Расширенная', 'Кампус'],
  clinic: ['Базовая', 'Расширенная', 'Медцентр'],
  grocery: ['Магазин', 'Супермаркет', 'Торговый центр'],
  community: ['Базовый', 'Расширенный', 'Многофункциональный'],
  parking: ['Открытая', 'С освещением', 'С благоустройством'],
  playground: ['Базовая', 'Расширенная', 'Инклюзивная'],
  waste_bin: ['Обычная', 'Раздельный сбор', 'С навесом'],
};
export const DESIGN_COSTS: Record<Destination['kind'], readonly number[]> = {
  bus_stop: [400000, 700000, 1500000],
  park: [1200, 1600, 2200],
  school: [3000000, 4000000, 6000000],
  clinic: [2000000, 3000000, 5000000],
  grocery: [300000, 500000, 900000],
  community: [700000, 1000000, 1500000],
  parking: [600000, 800000, 1000000],
  playground: [450000, 700000, 1100000],
  waste_bin: [15000, 30000, 60000],
};
export const DEFAULT_CAPACITY: Record<Destination['kind'], number> = {
  bus_stop: 100,
  park: 0,
  school: 600,
  clinic: 200,
  grocery: 100,
  community: 200,
  parking: 12,
  playground: 25,
  waste_bin: 1,
};
export const CAPACITY_FACTORS = [1, 1.25, 1.5] as const;
export function capacityFactor(kind: Destination['kind'], level: 0 | 1 | 2): number {
  return ['parking', 'playground', 'waste_bin'].includes(kind) ? 1 : CAPACITY_FACTORS[level];
}
export const STOP_HEADWAYS = [900, 600, 300] as const;
export const MOVE_COST_RUB = 100000,
  REMOVE_COST_RUB = 50000;
for (const table of [
  DEFAULT_DESIGN_RULES,
  OBJECT_KINDS,
  LEVEL_NAMES,
  DESIGN_COSTS,
  DEFAULT_CAPACITY,
  CAPACITY_FACTORS,
  STOP_HEADWAYS,
])
  deepFreeze(table);
export function objectFromDestination(data: DeepReadonly<DistrictData>, id: string): EditableObject | null {
  const d = data.destinations.find((d) => d.id === id);
  if (!d) return null;
  const parcel = data.parcels.find((p) => p.id === d.parcelId),
    nodes = new Map(data.nodes.map((n) => [n.id, n]));
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    active: d.active,
    level: 0,
    capacity: d.capacity,
    entrances: d.accessNodeIds.map((id) => [...nodes.get(id)!.xy] as XY),
    polygon: d.kind === 'park' && parcel ? parcel.polygon.map((p) => [...p] as XY) : null,
    autoEntrances: false,
    throughAccess: false,
  };
}
export function newObject(
  kind: Destination['kind'],
  point: XY,
  id = `user_${crypto.randomUUID()}`,
): EditableObject {
  const [x, y] = point;
  return {
    id,
    name: OBJECT_KINDS[kind],
    kind,
    active: true,
    level: 0,
    capacity: kind === 'park' ? null : DEFAULT_CAPACITY[kind],
    entrances: [point],
    polygon:
      kind === 'park'
        ? [
            [x - 25, y - 25],
            [x + 25, y - 25],
            [x + 25, y + 25],
            [x - 25, y + 25],
            [x - 25, y - 25],
          ]
        : null,
    autoEntrances: kind === 'park',
    throughAccess: false,
  };
}
