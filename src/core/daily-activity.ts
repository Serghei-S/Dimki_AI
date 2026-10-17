import type { DistrictData, Profile, RouteResult, XY } from './types.js';
import type {
  ActivityInput,
  ActivitySnapshot,
  TripPurpose,
  ActivityRoute,
  DayType,
} from './activity-types.js';
import { compileTopology, buildRoutingGraph, shortestToTargets } from './graph.js';
import type { RouteTree } from './graph.js';
import { deepFreeze } from './util.js';
import { requireCondition } from './errors.js';

export const ACTIVITY_RULES = deepFreeze({
  schoolAgeShareOfUnder18: 2 / 3,
  schoolAttendance: 0.92,
  employedAdultShare: 0.72,
  weekendWorkShare: 0.2,
  localWorkShare: 0.25,
  flowDisplayScale: 300,
  arrivals: { school: [7.75, 8.5], work: [8, 9.5], commute: [7, 9] },
  departuresHome: { school: [13.5, 15.5], work: [17, 19] },
  weekendWorkArrivals: [9, 11],
  weekendWorkHomeward: [15, 17],
  weekendVisitMultipliers: { shopping: 1.1, park: 1.4, clinic: 0.25 },
  visitWindows: {
    workerWeekday: [20, 21],
    workerWeekend: [18, 19],
    workerClinicAppointment: [10, 12],
    student: [16.5, 18],
    other: { shopping: [10, 12], clinic: [9, 12], park: [15, 18] },
    weekend: { shopping: [10, 16], clinic: [9, 12], park: [12, 18] },
  },
  discretionary: {
    worker: { shopping: 0.35, park: 0.18, clinic: 0.01 },
    student: { shopping: 0.08, park: 0.35, clinic: 0.005 },
    other: { shopping: 0.45, park: 0.3, clinic: 0.015 },
    senior: { shopping: 0.4, park: 0.3, clinic: 0.025 },
  },
  dwellHours: { shopping: 0.35, park: 0.8, clinic: 0.75 },
  assumedOpening: { school: [7, 17], work: [6, 23], shopping: [8, 22], park: [6, 23], clinic: [8, 20] },
});
export const PURPOSE_NAMES: Record<TripPurpose, string> = {
  work: 'Работа',
  school: 'Учёба',
  shopping: 'Покупки',
  park: 'Отдых',
  clinic: 'Медицина',
};
interface Target {
  id: string;
  nodes: string[];
  opening: [number, number];
}
interface Event {
  purpose: TripPurpose;
  direction: 'outbound' | 'homeward';
  objectId: string;
  count: number;
  start: number;
  end: number;
  route: RouteResult | null;
  offsets: number[];
}
export interface DailyPlan {
  data: DistrictData;
  profile: Profile;
  dayType: DayType;
  events: Event[];
  eligible: boolean[];
  population: number;
}
function opening(text: string, fallback: readonly number[]): [number, number] {
  if (text.trim() === '24/7') return [0, 24];
  const match = text.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (match) {
    const a = Number(match[1]) + Number(match[2]) / 60,
      b = Number(match[3]) + Number(match[4]) / 60;
    if (Number(match[2]) < 60 && Number(match[4]) < 60 && a >= 0 && a < 24 && b <= 24 && b > a) return [a, b];
  }
  return [fallback[0]!, fallback[1]!];
}
/** Uniform departure window integrated exactly; repeats daily, including midnight tails. */
export function scheduledFraction(start: number, end: number, from: number, to: number): number {
  if (!(end > start) || !(to > from)) return 0;
  let overlap = 0;
  for (let shift = Math.floor((from - end) / 24); shift <= Math.ceil((to - start) / 24); shift++)
    overlap += Math.max(0, Math.min(to, end + shift * 24) - Math.max(from, start + shift * 24));
  return Math.min(1, overlap / (end - start));
}
export function planDailyActivity(data: DistrictData, profile: Profile, dayType: DayType): DailyPlan {
  const topology = compileTopology(data),
    graph = buildRoutingGraph(topology, data, profile);
  const trees = new Map<string, RouteTree>();
  const treeFor = (nodes: readonly string[]) => {
    const key = [...nodes].sort().join('|');
    let tree = trees.get(key);
    if (!tree) {
      tree = shortestToTargets(
        graph,
        nodes.map((id) => topology.nodeIndex.get(id)!).filter((n) => n !== undefined),
      );
      trees.set(key, tree);
    }
    return tree;
  };
  const homes = data.buildings.filter((b) => b.population);
  const targets = (purpose: TripPurpose): Target[] => {
    const kinds =
      purpose === 'school'
        ? ['school']
        : purpose === 'shopping'
          ? ['grocery']
          : purpose === 'park'
            ? ['park']
            : purpose === 'clinic'
              ? ['clinic']
              : ['community', 'grocery', 'clinic', 'school'];
    return data.destinations
      .filter((d) => d.active && kinds.includes(d.kind) && d.accessNodeIds.length)
      .map((d) => ({
        id: d.id,
        nodes: [...d.accessNodeIds],
        opening: opening(d.openingHours, ACTIVITY_RULES.assumedOpening[purpose]),
      }));
  };
  const byPurpose = Object.fromEntries(
    (['work', 'school', 'shopping', 'park', 'clinic'] as TripPurpose[]).map((p) => [p, targets(p)]),
  ) as Record<TripPurpose, Target[]>;
  const gateways: Target[] = data.destinations
    .filter(
      (d) =>
        d.active &&
        d.kind === 'bus_stop' &&
        d.routeIds.some((id) => data.transitServices.some((s) => s.id === id)),
    )
    .map((d) => ({ id: d.id, nodes: [...d.accessNodeIds], opening: [0, 24] }));
  function route(
    home: (typeof homes)[number],
    target: Target,
    back: boolean,
    purpose: TripPurpose,
  ): RouteResult | null {
    const origins = back ? target.nodes : home.entranceNodeIds,
      ends = back ? home.entranceNodeIds : target.nodes,
      tree = treeFor(ends);
    let first = -1,
      best = Infinity;
    for (const id of [...origins].sort()) {
      const index = topology.nodeIndex.get(id);
      if (index !== undefined && tree.distances[index]! < best - 1e-9) {
        first = index;
        best = tree.distances[index]!;
      }
    }
    if (first < 0) return null;
    let node = first,
      distance = 0,
      waiting = 0;
    const nodeIds = [topology.nodeIds[node]!],
      edgeIds: string[] = [],
      geometry: XY[] = [];
    while (tree.nextNodes[node]! >= 0) {
      requireCondition(
        edgeIds.length < data.nodes.length,
        'INVALID_STATE',
        'Activity route predecessor cycle',
      );
      const index = tree.nextEdges[node]!,
        edge = data.edges[index]!,
        next = tree.nextNodes[node]!;
      const points = edge.from === topology.nodeIds[node] ? edge.geometry : [...edge.geometry].reverse();
      geometry.push(...(geometry.length ? points.slice(1) : points).map((p) => [...p] as XY));
      edgeIds.push(edge.id);
      nodeIds.push(topology.nodeIds[next]!);
      distance += edge.lengthM;
      waiting += edge.crossing?.waitSeconds ?? 0;
      node = next;
    }
    return {
      profileId: profile.id,
      buildingId: home.id,
      metricId: purpose,
      reachable: true,
      entranceNodeId: nodeIds[0]!,
      destinationId: back ? home.id : target.id,
      destinationAccessNodeId: nodeIds.at(-1)!,
      travelSeconds: best,
      walkingSeconds: best - waiting,
      waitingSeconds: waiting,
      distanceM: distance,
      nodeIds,
      edgeIds,
      geometry,
      geojson: {
        type: 'Feature',
        properties: { purpose, direction: back ? 'homeward' : 'outbound' },
        geometry: null,
      },
    };
  }
  function nearest(
    home: (typeof homes)[number],
    list: Target[],
    purpose: TripPurpose,
    accept?: (target: Target, path: RouteResult) => boolean,
  ) {
    let best: { target: Target; out: RouteResult; back: RouteResult | null } | null = null;
    for (const target of list) {
      const out = route(home, target, false, purpose);
      if (
        out &&
        (!accept || accept(target, out)) &&
        (!best ||
          out.travelSeconds! < best.out.travelSeconds! - 1e-9 ||
          (Math.abs(out.travelSeconds! - best.out.travelSeconds!) < 1e-9 && target.id < best.target.id))
      )
        best = { target, out, back: null };
    }
    if (best) best.back = route(home, best.target, true, purpose);
    return best;
  }
  const events: Event[] = [];
  const add = (
    purpose: TripPurpose,
    direction: 'outbound' | 'homeward',
    count: number,
    start: number,
    end: number,
    path: RouteResult | null,
    objectId: string,
  ) => {
    if (count <= 0 || end <= start) return;
    const offsets: number[] = [];
    let offset = 0;
    for (const id of path?.edgeIds ?? []) {
      const i = topology.edgeIndex.get(id)!,
        duration = graph.edgeCosts[i]!;
      offsets.push(offset);
      offset += duration;
    }
    events.push({ purpose, direction, count, start, end, route: path, objectId, offsets });
  };
  for (const home of homes) {
    const pop = home.population!,
      weekday = dayType === 'weekday';
    const students = weekday
      ? pop.ageGroups.under18 * ACTIVITY_RULES.schoolAgeShareOfUnder18 * ACTIVITY_RULES.schoolAttendance
      : 0;
    const workers =
      pop.ageGroups.age18to64 *
      ACTIVITY_RULES.employedAdultShare *
      (weekday ? 1 : ACTIVITY_RULES.weekendWorkShare);
    const obligatory = (purpose: 'work' | 'school', count: number, list: Target[], external = false) => {
      if (!count) return;
      const chosen = nearest(home, list, purpose),
        travel = (chosen?.out.travelSeconds ?? 0) / 3600;
      const arrival =
        purpose === 'school'
          ? ACTIVITY_RULES.arrivals.school
          : !weekday
            ? ACTIVITY_RULES.weekendWorkArrivals
            : external
              ? ACTIVITY_RULES.arrivals.commute
              : ACTIVITY_RULES.arrivals.work;
      const returning =
        purpose === 'school'
          ? ACTIVITY_RULES.departuresHome.school
          : weekday
            ? ACTIVITY_RULES.departuresHome.work
            : ACTIVITY_RULES.weekendWorkHomeward;
      add(
        purpose,
        'outbound',
        count,
        arrival[0]! - travel,
        arrival[1]! - travel,
        chosen?.out ?? null,
        chosen?.target.id ?? 'unserved',
      );
      // Missing outbound access cannot generate a phantom return from the destination.
      if (chosen)
        add(purpose, 'homeward', count, returning[0]!, returning[1]!, chosen.back, chosen.target.id);
    };
    obligatory('school', students, byPurpose.school);
    obligatory('work', workers * ACTIVITY_RULES.localWorkShare, byPurpose.work);
    obligatory('work', workers * (1 - ACTIVITY_RULES.localWorkShare), gateways, true);
    const cohorts = [
      { id: 'worker' as const, n: workers },
      { id: 'student' as const, n: students },
      { id: 'senior' as const, n: pop.ageGroups.age65plus },
      { id: 'other' as const, n: pop.total - workers - students - pop.ageGroups.age65plus },
    ];
    for (const cohort of cohorts)
      for (const purpose of ['shopping', 'park', 'clinic'] as const) {
        const count =
          cohort.n *
          ACTIVITY_RULES.discretionary[cohort.id][purpose] *
          (weekday ? 1 : ACTIVITY_RULES.weekendVisitMultipliers[purpose]);
        // Discretionary groups are disjoint alternatives; probability sum remains <= 1.
        let window: readonly number[] =
          cohort.id === 'worker'
            ? weekday
              ? ACTIVITY_RULES.visitWindows.workerWeekday
              : ACTIVITY_RULES.visitWindows.workerWeekend
            : cohort.id === 'student'
              ? ACTIVITY_RULES.visitWindows.student
              : ACTIVITY_RULES.visitWindows.other[purpose];
        if (!weekday && cohort.id !== 'worker') window = ACTIVITY_RULES.visitWindows.weekend[purpose];
        // A small appointment cohort takes time off; it is not sent to a closed clinic at night.
        if (cohort.id === 'worker' && purpose === 'clinic')
          window = ACTIVITY_RULES.visitWindows.workerClinicAppointment;
        const chosen = nearest(
          home,
          byPurpose[purpose],
          purpose,
          (target, path) =>
            Math.min(
              window[1]!,
              target.opening[1] - path.travelSeconds! / 3600 - ACTIVITY_RULES.dwellHours[purpose],
            ) > Math.max(window[0]!, target.opening[0] - path.travelSeconds! / 3600),
        );
        const duration = (chosen?.out.travelSeconds ?? 0) / 3600;
        // Ensure arrival and stay finish while the selected facility is open.
        const start = Math.max(window[0]!, chosen ? chosen.target.opening[0] - duration : window[0]!);
        const end = Math.min(
          window[1]!,
          chosen ? chosen.target.opening[1] - duration - ACTIVITY_RULES.dwellHours[purpose] : window[1]!,
        );
        add(purpose, 'outbound', count, start, end, chosen?.out ?? null, chosen?.target.id ?? 'unserved');
        if (chosen)
          add(
            purpose,
            'homeward',
            count,
            start + duration + ACTIVITY_RULES.dwellHours[purpose],
            end + duration + ACTIVITY_RULES.dwellHours[purpose],
            chosen.back,
            chosen.target.id,
          );
      }
  }
  return {
    data,
    profile,
    dayType,
    events,
    eligible: [...graph.edgeCosts].map(Number.isFinite),
    population: homes.reduce((s, h) => s + h.population!.total, 0),
  };
}
export function activityAtHour(plan: DailyPlan, input: ActivityInput): ActivitySnapshot {
  requireCondition(
    Number.isInteger(input.hour) && input.hour >= 0 && input.hour <= 23 && input.dayType === plan.dayType,
    'INVALID_INPUT',
    'Некорректный час или тип дня',
  );
  const h = input.hour,
    mid = h + 0.5,
    edgeIndex = new Map(plan.data.edges.map((e, i) => [e.id, i]));
  const edges = plan.data.edges.map((e, i) => ({
    edgeId: e.id,
    load: 0,
    forward: 0,
    backward: 0,
    eligible: plan.eligible[i]!,
  }));
  const purposes = (['work', 'school', 'shopping', 'park', 'clinic'] as TripPurpose[]).map((id) => ({
    id,
    outbound: 0,
    homeward: 0,
    unserved: 0,
    onNetwork: 0,
  }));
  const routes: ActivityRoute[] = [];
  let plannedTrips = 0,
    servedTrips = 0,
    unservedTrips = 0,
    expectedOnNetwork = 0;
  for (const event of plan.events) {
    const trips = event.count * scheduledFraction(event.start, event.end, h, h + 1),
      summary = purposes.find((p) => p.id === event.purpose)!;
    plannedTrips += trips;
    if (!event.route) {
      unservedTrips += trips;
      summary.unserved += trips;
      continue;
    }
    servedTrips += trips;
    summary[event.direction] += trips;
    const duration = event.route.travelSeconds! / 3600;
    const onNetwork = event.count * scheduledFraction(event.start, event.end, mid - duration, mid);
    expectedOnNetwork += onNetwork;
    summary.onNetwork += onNetwork;
    event.route.edgeIds.forEach((id, i) => {
      const index = edgeIndex.get(id)!,
        source = plan.data.edges[index]!,
        offset = event.offsets[i]! / 3600;
      const load = event.count * scheduledFraction(event.start, event.end, h - offset, h + 1 - offset);
      const row = edges[index]!;
      row.load += load;
      if (source.from === event.route!.nodeIds[i]) row.forward += load;
      else row.backward += load;
    });
    if (input.includeRoutes && onNetwork > 1e-8 && event.route.edgeIds.length)
      routes.push({
        purpose: event.purpose,
        direction: event.direction,
        objectId: event.objectId,
        tripsPerHour: trips,
        expectedOnNetwork: onNetwork,
        route: event.route,
      });
  }
  return {
    hour: h,
    dayType: input.dayType,
    profileId: plan.profile.id,
    population: plan.population,
    plannedTrips,
    servedTrips,
    unservedTrips,
    expectedOnNetwork,
    purposes,
    routes,
    loads: {
      unit: 'pedestrian-trips-per-hour',
      maxLoad: edges.reduce((max, e) => Math.max(max, e.load), 0),
      edgeTraversals: edges.reduce((s, e) => s + e.load, 0),
      edges,
    },
    assumptions: [
      'Условные ожидаемые перемещения, не наблюдаемый трафик. Доли участия и расписания заданы в ACTIVITY_RULES.',
      'Работа: условная локальная занятость и выход через остановки с известной в наборе линией. Участок поездки за районом и движение автобуса не моделируются; новые остановки без маршрута не создают рабочее направление.',
      'Учащиеся оценены как часть группы до 18 лет. Неработающие, пожилые и учащиеся имеют отдельные расписания. Магазины/парки/клиники — альтернативные группы посетителей, а не всё население сразу.',
      'Поток на ребре — ожидаемые проходы за выбранный час с учётом времени входа на ребро. Число людей на сети — ожидаемое значение в середине часа. В обратном направлении ищется отдельный допустимый маршрут.',
      'Часы работы читаются только из простого интервала HH:MM-HH:MM или 24/7; остальные расписания заменяются явно заданными предположениями. Ёмкость рабочих мест и фактическое зачисление не подтверждены.',
      'Локальные рабочие места приближены ближайшими общественными объектами; реестра рабочих мест нет. Небольшая группа работающих посещает врача днём по условию отгула. Дошкольные прогулки подразумевают сопровождение, отдельные сопровождающие и цепочки посещений не генерируются.',
    ],
  };
}
