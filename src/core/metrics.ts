import type {
  Building,
  DistrictData,
  MetricDefinition,
  Profile,
  ProfileMetrics,
  MetricChange,
  RouteResult,
  BuildingMetrics,
  DeepReadonly,
} from './types.js';
import { requireCondition } from './errors.js';
import { buildRoutingGraph, shortestToTargets } from './graph.js';
import type { Topology, RoutingGraph, RouteTree } from './graph.js';
import { compareId, round, ROUTING_EPSILON, toWgs84 } from './util.js';
import type { EdgeLoadReport } from './types.js';

/** Accumulate demand up the shortest-path forest instead of materializing every home route. */
export function edgeLoadsForAnalysis(analysis: ProfileAnalysis, metricId: string): EdgeLoadReport {
  const runtime = analysis.metrics.get(metricId);
  requireCondition(runtime, 'UNKNOWN_ID', `Unknown metric: ${metricId}`);
  const { data, graph } = analysis,
    { topology } = graph,
    { tree, definition } = runtime;
  const demand = new Float64Array(topology.nodeIds.length);
  const forward = new Float64Array(data.edges.length),
    backward = new Float64Array(data.edges.length);
  let evaluatedResidents = 0,
    assignedResidents = 0;
  for (const home of data.buildings) {
    if (!home.population) continue;
    const weight = population(home, definition),
      entrance = bestEntrance(home, topology, tree);
    evaluatedResidents += weight;
    if (Number.isFinite(entrance.seconds)) {
      demand[entrance.index] = demand[entrance.index]! + weight;
      assignedResidents += weight;
    }
  }
  const ordered = Array.from({ length: demand.length }, (_, i) => i)
    .filter((i) => tree.nextNodes[i]! >= 0 && Number.isFinite(tree.distances[i]))
    .sort((a, b) => tree.distances[b]! - tree.distances[a]! || a - b);
  for (const node of ordered) {
    const next = tree.nextNodes[node]!,
      edge = tree.nextEdges[node]!,
      weight = demand[node]!;
    const direction = topology.edgeFrom[edge] === node ? forward : backward;
    direction[edge] = direction[edge]! + weight;
    demand[next] = demand[next]! + weight;
  }
  let maxLoad = 0,
    edgeTraversals = 0;
  const edges = data.edges.map((edge, i) => {
    const load = forward[i]! + backward[i]!;
    maxLoad = Math.max(maxLoad, load);
    edgeTraversals += load;
    return {
      edgeId: edge.id,
      load,
      forward: forward[i]!,
      backward: backward[i]!,
      eligible: Number.isFinite(graph.edgeCosts[i]),
    };
  });
  return {
    profileId: analysis.report.profileId,
    metricId,
    unit: 'resident-trips-per-cycle',
    evaluatedResidents,
    assignedResidents,
    unreachableResidents: evaluatedResidents - assignedResidents,
    maxLoad,
    edgeTraversals,
    edges,
  };
}

export interface ProfileAnalysis {
  data: DistrictData;
  graph: RoutingGraph;
  report: ProfileMetrics;
  metrics: Map<
    string,
    { definition: MetricDefinition; tree: RouteTree; owners: Map<number, string>; weightedSeconds: number }
  >;
  estimatedBytes: number;
}
export function defaultMetrics(data: DistrictData): MetricDefinition[] {
  return (['bus_stop', 'park', 'school', 'clinic', 'grocery'] as const).map((kind) => ({
    id: kind,
    destinationKinds: [kind],
    thresholdSeconds: data.metricDefinitions.thresholdSeconds[kind],
    populationGroup: 'all',
  }));
}
function population(building: Building, definition: MetricDefinition): number {
  const p = building.population!;
  return definition.populationGroup === 'all'
    ? p.total
    : definition.populationGroup === 'mobilityNeeds'
      ? p.mobilityNeedsResidents
      : p.ageGroups[definition.populationGroup];
}
export function bestEntrance(
  building: Building,
  topology: Topology,
  tree: RouteTree,
): { index: number; seconds: number } {
  let index = -1,
    seconds = Infinity;
  for (const id of [...building.entranceNodeIds].sort(compareId)) {
    const candidate = topology.nodeIndex.get(id)!;
    if (tree.distances[candidate]! < seconds - ROUTING_EPSILON) {
      seconds = tree.distances[candidate]!;
      index = candidate;
    }
  }
  return { index, seconds };
}
export function analyzeProfile(
  data: DistrictData,
  topology: Topology,
  profile: Profile,
  definitions: MetricDefinition[],
): ProfileAnalysis {
  const graph = buildRoutingGraph(topology, data, profile),
    homes = data.buildings.filter((b) => b.population !== null);
  const totalPopulation = homes.reduce((sum, b) => sum + b.population!.total, 0);
  const perBuilding: BuildingMetrics[] = homes.map((b) => ({
    buildingId: b.id,
    residents: b.population!.total,
    destinations: Object.create(null),
  }));
  const report: ProfileMetrics = {
    profileId: profile.id,
    evaluatedPopulation: totalPopulation,
    populationInterpretation:
      'All residents hypothetically using this profile; profile totals must not be added.',
    destinations: Object.create(null),
    perBuilding,
    publicParkAreaM2: 0,
    publicParkM2PerResident: null,
    serviceCatchments: Object.create(null),
  };
  const sharedTrees = new Map<string, { tree: RouteTree; owners: Map<number, string> }>();
  const runtimes: ProfileAnalysis['metrics'] = new Map();
  for (const definition of definitions) {
    const key = [...definition.destinationKinds].sort(compareId).join('|');
    let search = sharedTrees.get(key);
    if (!search) {
      const owners = new Map<number, string>();
      for (const destination of data.destinations
        .filter((d) => d.active && definition.destinationKinds.includes(d.kind))
        .sort((a, b) => compareId(a.id, b.id)))
        for (const node of destination.accessNodeIds) {
          const index = topology.nodeIndex.get(node)!;
          if (!owners.has(index)) owners.set(index, destination.id);
        }
      search = { tree: shortestToTargets(graph, owners.keys()), owners };
      sharedTrees.set(key, search);
    }
    const catchments = new Map(
      data.destinations
        .filter((d) => d.active && definition.destinationKinds.includes(d.kind))
        .sort((a, b) => compareId(a.id, b.id))
        .map((d) => [
          d.id,
          {
            objectId: d.id,
            assignedResidents: 0,
            under18Residents: 0,
            withinThresholdResidents: 0,
            effectiveCapacity: d.capacity,
          },
        ]),
    );
    let reachable = 0,
      within = 0,
      weightedSeconds = 0,
      evaluated = 0;
    for (let i = 0; i < homes.length; i++) {
      const home = homes[i]!,
        weight = population(home, definition),
        { index, seconds } = bestEntrance(home, topology, search.tree);
      const finite = Number.isFinite(seconds),
        withinThreshold = finite && seconds <= definition.thresholdSeconds + ROUTING_EPSILON;
      evaluated += weight;
      if (finite) {
        reachable += weight;
        weightedSeconds += seconds * weight;
      }
      if (withinThreshold) within += weight;
      if (finite) {
        const destinationId = search.owners.get(search.tree.targets[index]!)!,
          catchment = catchments.get(destinationId)!;
        catchment.assignedResidents += weight;
        catchment.under18Residents += home.population!.ageGroups.under18;
        if (withinThreshold) catchment.withinThresholdResidents += weight;
      }
      perBuilding[i]!.destinations[definition.id] = {
        travelSeconds: finite ? round(seconds) : null,
        reachable: finite,
        withinThreshold,
        evaluatedResidents: weight,
      };
    }
    report.destinations[definition.id] = {
      thresholdSeconds: definition.thresholdSeconds,
      evaluatedPopulation: evaluated,
      reachableResidents: reachable,
      unreachableResidents: evaluated - reachable,
      withinThresholdResidents: within,
      coveragePercent: evaluated ? round((100 * within) / evaluated) : null,
      meanSecondsReachableOnly: reachable ? round(weightedSeconds / reachable) : null,
    };
    report.serviceCatchments[definition.id] = [...catchments.values()];
    runtimes.set(definition.id, { definition, ...search, weightedSeconds });
  }
  const parkIds = new Set(
    data.destinations.filter((d) => d.active && d.kind === 'park').map((d) => d.parcelId),
  );
  report.publicParkAreaM2 = round(
    data.parcels.filter((p) => p.active && parkIds.has(p.id)).reduce((sum, p) => sum + p.areaM2, 0),
    2,
  );
  report.publicParkM2PerResident = totalPopulation ? round(report.publicParkAreaM2 / totalPopulation) : null;
  const estimatedBytes =
    graph.byteLength +
    [...sharedTrees.values()].reduce((sum, s) => sum + s.tree.byteLength + s.owners.size * 80, 0) +
    homes.length * (80 + definitions.length * 100) +
    Object.values(report.serviceCatchments).reduce((sum, items) => sum + items.length * 120, 0) +
    data.edges.length * 128 +
    data.nodes.length * 48;
  return { data, graph, report, metrics: runtimes, estimatedBytes };
}

export function compareMetrics(
  before: DeepReadonly<ProfileMetrics>,
  after: DeepReadonly<ProfileMetrics>,
  epsilonSeconds = 0.01,
): Record<string, MetricChange> {
  requireCondition(
    before.profileId === after.profileId && before.evaluatedPopulation === after.evaluatedPopulation,
    'INVALID_INPUT',
    'Cannot compare different profiles/populations',
  );
  const oldBuildings = new Map(before.perBuilding.map((b) => [b.buildingId, b]));
  requireCondition(
    oldBuildings.size === after.perBuilding.length &&
      after.perBuilding.every((b) => oldBuildings.get(b.buildingId)?.residents === b.residents),
    'INVALID_INPUT',
    'Cannot compare different building populations',
  );
  requireCondition(
    Object.keys(before.destinations).sort().join('|') === Object.keys(after.destinations).sort().join('|'),
    'INVALID_INPUT',
    'Cannot compare different metric registries',
  );
  const result: Record<string, MetricChange> = Object.create(null);
  for (const [id, totals] of Object.entries(before.destinations)) {
    const change: MetricChange = {
      improvedResidents: 0,
      worsenedResidents: 0,
      unchangedResidents: 0,
      coverageDeltaPercentagePoints:
        totals.coveragePercent === null || after.destinations[id]!.coveragePercent === null
          ? null
          : round(after.destinations[id]!.coveragePercent! - totals.coveragePercent),
    };
    for (const building of after.perBuilding) {
      const old = oldBuildings.get(building.buildingId)!.destinations[id]!,
        current = building.destinations[id]!;
      requireCondition(
        old.evaluatedResidents === current.evaluatedResidents,
        'INVALID_INPUT',
        'Metric population groups changed',
      );
      const oldTime = old.travelSeconds ?? Infinity,
        newTime = current.travelSeconds ?? Infinity;
      const key =
        newTime < oldTime - epsilonSeconds
          ? 'improvedResidents'
          : newTime > oldTime + epsilonSeconds
            ? 'worsenedResidents'
            : 'unchangedResidents';
      change[key] += current.evaluatedResidents;
    }
    result[id] = change;
  }
  return result;
}

export function routeForBuilding(
  analysis: ProfileAnalysis,
  buildingId: string,
  metricId: string,
): RouteResult {
  const { data, graph } = analysis,
    topology = graph.topology;
  const building = data.buildings.find((b) => b.id === buildingId),
    runtime = analysis.metrics.get(metricId);
  requireCondition(
    building && building.population,
    'UNKNOWN_ID',
    `Unknown residential building: ${buildingId}`,
  );
  requireCondition(runtime, 'UNKNOWN_ID', `Unknown metric: ${metricId}`);
  const { index, seconds } = bestEntrance(building, topology, runtime.tree),
    reachable = Number.isFinite(seconds);
  const result: RouteResult = {
    profileId: analysis.report.profileId,
    buildingId,
    metricId,
    reachable,
    entranceNodeId: null,
    destinationId: null,
    destinationAccessNodeId: null,
    travelSeconds: null,
    walkingSeconds: null,
    waitingSeconds: null,
    distanceM: null,
    nodeIds: [],
    edgeIds: [],
    geometry: [],
    geojson: { type: 'Feature', properties: { buildingId, metricId, reachable }, geometry: null },
  };
  if (!reachable) return result;
  let node = index,
    distance = 0,
    waiting = 0;
  const nodeIds: string[] = [topology.nodeIds[node]!],
    edgeIds: string[] = [],
    geometry: [number, number][] = [];
  while (runtime.tree.nextNodes[node]! >= 0) {
    requireCondition(edgeIds.length < topology.nodeIds.length, 'INVALID_STATE', 'Route predecessor cycle');
    const edgeIndex = runtime.tree.nextEdges[node]!,
      edge = data.edges[edgeIndex]!,
      next = runtime.tree.nextNodes[node]!;
    const points = edge.from === topology.nodeIds[node] ? edge.geometry : [...edge.geometry].reverse();
    geometry.push(...(geometry.length ? points.slice(1) : points));
    distance += edge.lengthM;
    waiting += edge.crossing?.waitSeconds ?? 0;
    edgeIds.push(edge.id);
    nodeIds.push(topology.nodeIds[next]!);
    node = next;
  }
  if (!geometry.length) geometry.push(data.nodes.find((n) => n.id === topology.nodeIds[index])!.xy);
  const destinationId = runtime.owners.get(node)!;
  Object.assign(result, {
    entranceNodeId: topology.nodeIds[index]!,
    destinationId,
    destinationAccessNodeId: topology.nodeIds[node]!,
    travelSeconds: round(seconds),
    walkingSeconds: round(seconds - waiting),
    waitingSeconds: round(waiting),
    distanceM: round(distance),
    nodeIds,
    edgeIds,
    geometry: structuredClone(geometry),
  });
  result.geojson.properties = {
    buildingId,
    metricId,
    reachable,
    destinationId,
    travelSeconds: result.travelSeconds,
    distanceM: result.distanceM,
  };
  result.geojson.geometry =
    geometry.length > 1
      ? {
          type: 'LineString',
          coordinates: geometry.map((p) =>
            toWgs84(
              p,
              data.metadata.coordinateSystem.displayOriginWgs84,
              data.metadata.coordinateSystem.earthRadiusM,
            ),
          ),
        }
      : null;
  return result;
}
