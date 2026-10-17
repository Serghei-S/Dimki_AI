import type { ActivityComparison, ActivityEdgeChange, ActivityObjectLoad, ActivityRoute, ActivityRouteChange, ActivitySnapshot, NormativeCheck } from './activity-types.js';
import type { DeepReadonly, DistrictData } from './types.js';

interface NormativeReference {
  kinds: readonly string[];
  title: string;
  limit: number;
  source: string;
  sourceUrl: string;
  applicability: string;
  caveat: string;
}

/**
 * Reference limits are published planning norms, not a replacement for the
 * municipality's approved territorial planning documentation.  The selected
 * reference is shown with every comparison so a reviewer can verify scope.
 */
export const NORMATIVE_REFERENCES: readonly NormativeReference[] = [
  {
    kinds: ['school'],
    title: 'Пешеходная доступность школы',
    limit: 500,
    source: 'СП 42.13330.2016 и СП 2.4.3648-20; региональные НГП',
    sourceUrl: 'https://docs.cntd.ru/document/571077553',
    applicability: 'Справочное значение для городской территории',
    caveat: 'Итоговую границу нужно сверить с действующими НГП региона; для сложного рельефа встречаются увеличенные пределы.',
  },
  {
    kinds: ['grocery', 'community', 'park', 'playground'],
    title: 'Ежедневное обслуживание пешком',
    limit: 500,
    source: 'Региональные нормативы градостроительного проектирования (ссылка на требования СП 42.13330.2016)',
    sourceUrl: 'https://docs.cntd.ru/document/906507363/titles/6IKFIN',
    applicability: 'Справочное значение для объектов ежедневного обслуживания',
    caveat: 'Норма зависит от вида объекта и утверждённых местных нормативов; проверка относится к запланированным поездкам выбранного часа.',
  },
  {
    kinds: ['bus_stop'],
    title: 'Подход к остановке общественного транспорта',
    limit: 500,
    source: 'Региональные нормативы градостроительного проектирования; СП 42.13330.2016',
    sourceUrl: 'https://docs.cntd.ru/document/407533303/titles/6U1IKG',
    applicability: 'Справочное значение для городской застройки',
    caveat: 'В разных НГП встречаются 400–500 м; здесь показывается выбранное справочное значение и ссылка на источник.',
  },
];

const routeKey = (route: ActivityRoute) => `${route.route.buildingId}|${route.purpose}|${route.direction}`;
const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
function routeChanges(before: ActivitySnapshot, after: ActivitySnapshot): ActivityRouteChange[] {
  const b = new Map(before.routes.map((route) => [routeKey(route), route]));
  const a = new Map(after.routes.map((route) => [routeKey(route), route]));
  return [...new Set([...b.keys(), ...a.keys()])]
    .sort()
    .map((key) => {
      const oldRoute = b.get(key), newRoute = a.get(key), source = newRoute ?? oldRoute!;
      const distanceBeforeM = oldRoute?.route.distanceM ?? null;
      const distanceAfterM = newRoute?.route.distanceM ?? null;
      const secondsBefore = oldRoute?.route.travelSeconds ?? null;
      const secondsAfter = newRoute?.route.travelSeconds ?? null;
      return {
        key,
        purpose: source.purpose,
        direction: source.direction,
        buildingId: source.route.buildingId,
        objectBeforeId: oldRoute?.objectId ?? null,
        objectAfterId: newRoute?.objectId ?? null,
        tripsBefore: oldRoute?.tripsPerHour ?? 0,
        tripsAfter: newRoute?.tripsPerHour ?? 0,
        onNetworkBefore: oldRoute?.expectedOnNetwork ?? 0,
        onNetworkAfter: newRoute?.expectedOnNetwork ?? 0,
        distanceBeforeM,
        distanceAfterM,
        secondsBefore,
        secondsAfter,
        distanceDeltaM: finite(distanceBeforeM) && finite(distanceAfterM) ? distanceAfterM - distanceBeforeM : null,
        secondsDelta: finite(secondsBefore) && finite(secondsAfter) ? secondsAfter - secondsBefore : null,
        shorter: finite(secondsBefore) && finite(secondsAfter) && secondsAfter < secondsBefore - 1e-9,
        longer: finite(secondsBefore) && finite(secondsAfter) && secondsAfter > secondsBefore + 1e-9,
        newRoute: !!newRoute && (!oldRoute || oldRoute.objectId !== newRoute.objectId),
        lostRoute: !!oldRoute && !newRoute,
      } satisfies ActivityRouteChange;
    });
}

function edgeChanges(before: ActivitySnapshot, after: ActivitySnapshot): ActivityEdgeChange[] {
  const b = new Map(before.loads.edges.map((edge) => [edge.edgeId, edge]));
  const a = new Map(after.loads.edges.map((edge) => [edge.edgeId, edge]));
  return [...new Set([...b.keys(), ...a.keys()])]
    .sort()
    .map((edgeId) => {
      const oldEdge = b.get(edgeId), newEdge = a.get(edgeId);
      const loadBefore = oldEdge?.load ?? 0, loadAfter = newEdge?.load ?? 0;
      return {
        edgeId,
        loadBefore,
        loadAfter,
        delta: loadAfter - loadBefore,
        forwardBefore: oldEdge?.forward ?? 0,
        forwardAfter: newEdge?.forward ?? 0,
        backwardBefore: oldEdge?.backward ?? 0,
        backwardAfter: newEdge?.backward ?? 0,
        eligibleBefore: oldEdge?.eligible ?? false,
        eligibleAfter: newEdge?.eligible ?? false,
      } satisfies ActivityEdgeChange;
    });
}

function objectLoads(data: DeepReadonly<DistrictData>, before: ActivitySnapshot, after: ActivitySnapshot): ActivityObjectLoad[] {
  const ids = new Set([
    ...before.routes.filter((route) => route.direction === 'outbound').map((route) => route.objectId),
    ...after.routes.filter((route) => route.direction === 'outbound').map((route) => route.objectId),
  ]);
  return [...ids].sort().map((objectId) => {
    const destination = [...(after.objects ?? []), ...(before.objects ?? [])].find((item) => item.id === objectId) ??
      data.destinations.find((item) => item.id === objectId);
    const oldRoutes = before.routes.filter((route) => route.direction === 'outbound' && route.objectId === objectId);
    const newRoutes = after.routes.filter((route) => route.direction === 'outbound' && route.objectId === objectId);
    const tripsBefore = oldRoutes.reduce((sum, route) => sum + route.tripsPerHour, 0);
    const tripsAfter = newRoutes.reduce((sum, route) => sum + route.tripsPerHour, 0);
    return {
      objectId,
      name: destination?.name ?? objectId,
      kind: destination?.kind ?? 'unknown',
      capacity: destination?.capacity ?? null,
      tripsBefore,
      tripsAfter,
      onNetworkBefore: oldRoutes.reduce((sum, route) => sum + route.expectedOnNetwork, 0),
      onNetworkAfter: newRoutes.reduce((sum, route) => sum + route.expectedOnNetwork, 0),
      loadPercentBefore: destination?.capacity ? (100 * tripsBefore) / destination.capacity : null,
      loadPercentAfter: destination?.capacity ? (100 * tripsAfter) / destination.capacity : null,
    } satisfies ActivityObjectLoad;
  });
}

function normativeChecks(data: DeepReadonly<DistrictData>, before: ActivitySnapshot, after: ActivitySnapshot): NormativeCheck[] {
  return objectLoads(data, before, after).flatMap((object) => {
    const reference = NORMATIVE_REFERENCES.find((candidate) => candidate.kinds.includes(object.kind));
    if (!reference) return [];
    const oldRoutes = before.routes.filter((route) => route.direction === 'outbound' && route.objectId === object.objectId);
    const newRoutes = after.routes.filter((route) => route.direction === 'outbound' && route.objectId === object.objectId);
    const within = (routes: ActivityRoute[]) => routes.reduce((sum, route) => sum + (route.route.distanceM != null && route.route.distanceM <= reference.limit ? route.tripsPerHour : 0), 0);
    const withinBefore = within(oldRoutes), withinAfter = within(newRoutes);
    return [{
      objectId: object.objectId,
      objectName: object.name,
      kind: object.kind,
      title: reference.title,
      source: reference.source,
      sourceUrl: reference.sourceUrl,
      limit: reference.limit,
      unit: 'm',
      tripsBefore: object.tripsBefore,
      tripsAfter: object.tripsAfter,
      withinBefore,
      withinAfter,
      withinPercentBefore: object.tripsBefore > 0 ? (100 * withinBefore) / object.tripsBefore : null,
      withinPercentAfter: object.tripsAfter > 0 ? (100 * withinAfter) / object.tripsAfter : null,
      capacity: object.capacity,
      capacityLoadPercentAfter: object.loadPercentAfter,
      applicability: reference.applicability,
      caveat: reference.caveat,
    } satisfies NormativeCheck];
  });
}

function weighted(routes: ActivityRoute[], field: 'distanceM' | 'travelSeconds'): number | null {
  let weight = 0, total = 0;
  for (const route of routes) {
    const value = route.route[field];
    if (!finite(value) || route.tripsPerHour <= 0) continue;
    weight += route.tripsPerHour;
    total += value * route.tripsPerHour;
  }
  return weight > 0 ? total / weight : null;
}

export function compareActivitySnapshots(
  data: DeepReadonly<DistrictData>,
  before: ActivitySnapshot,
  after: ActivitySnapshot,
): ActivityComparison {
  const routes = routeChanges(before, after);
  const edges = edgeChanges(before, after);
  const objects = objectLoads(data, before, after);
  const shorterRouteTrips = routes.filter((route) => route.shorter).reduce((sum, route) => sum + route.tripsAfter, 0);
  const longerRouteTrips = routes.filter((route) => route.longer).reduce((sum, route) => sum + route.tripsAfter, 0);
  const newlyServedTrips = routes.filter((route) => route.newRoute).reduce((sum, route) => sum + route.tripsAfter, 0);
  const meanDistanceBeforeM = weighted(before.routes, 'distanceM');
  const meanDistanceAfterM = weighted(after.routes, 'distanceM');
  const meanSecondsBefore = weighted(before.routes, 'travelSeconds');
  const meanSecondsAfter = weighted(after.routes, 'travelSeconds');
  return {
    before,
    after,
    summary: {
      plannedTripsBefore: before.plannedTrips,
      plannedTripsAfter: after.plannedTrips,
      populationBefore: before.population,
      populationAfter: after.population,
      servedTripsBefore: before.servedTrips,
      servedTripsAfter: after.servedTrips,
      newlyServedTrips,
      newlyServedPeople: newlyServedTrips,
      shorterRouteTrips,
      shorterRoutePeople: shorterRouteTrips,
      longerRouteTrips,
      meanDistanceBeforeM,
      meanDistanceAfterM,
      meanDistanceDeltaM: finite(meanDistanceBeforeM) && finite(meanDistanceAfterM) ? meanDistanceAfterM - meanDistanceBeforeM : null,
      meanSecondsBefore,
      meanSecondsAfter,
      meanSecondsDelta: finite(meanSecondsBefore) && finite(meanSecondsAfter) ? meanSecondsAfter - meanSecondsBefore : null,
    },
    routes,
    edges,
    objects,
    normative: normativeChecks(data, before, after),
    assumptions: [...new Set([...before.assumptions, ...after.assumptions])],
  };
}
