import type { PlanningEngine } from './engine.js';
import type { DistrictData, Profile, ScenarioInput, Destination } from './types.js';
import type {
  DesignAnalysisInput,
  DesignAnalysisResult,
  DistanceRow,
  DistanceTotals,
  DistanceChange,
  NeedCandidate,
  XY,
} from './design-types.js';
import {
  DEFAULT_DESIGN_RULES,
  CAPACITY_FACTORS,
  STOP_HEADWAYS,
  objectFromDestination,
} from './design-rules.js';
import { compileTopology, buildRoutingGraph, shortestToTargets } from './graph.js';
import type { RouteTree } from './graph.js';
import { bestEntrance } from './metrics.js';
import { pointAlong, nearestNetworkPoint } from './design-geometry.js';
import { EngineError, requireCondition } from './errors.js';
import { assertSchema } from './validation.js';
import { suggestPlacement, relocateWithContext, siteAccessPoint, PLACEMENT_RULES } from './placement.js';

function context(
  data: DistrictData,
  profile: Profile,
  kind: Destination['kind'],
  threshold: number,
  levels: Map<string, number>,
) {
  const topology = compileTopology(data),
    timeGraph = buildRoutingGraph(topology, data, profile),
    graph = buildRoutingGraph(topology, data, profile),
    homes = data.buildings.filter((b) => b.population);
  for (let i = 0; i < graph.edgeCosts.length; i++)
    if (Number.isFinite(graph.edgeCosts[i])) graph.edgeCosts[i] = data.edges[i]!.lengthM;
  for (let i = 0; i < graph.incomingCosts.length; i++)
    graph.incomingCosts[i] = graph.edgeCosts[graph.incomingEdges[i]!]!;
  const destinations = data.destinations
    .filter((d) => d.active && d.kind === kind)
    .sort((a, b) => a.id.localeCompare(b.id));
  const ownersFor = (excluded?: string) => {
    const owners = new Map<number, string>();
    for (const d of destinations)
      if (d.id !== excluded)
        for (const id of d.accessNodeIds) {
          const i = topology.nodeIndex.get(id)!;
          if (!owners.has(i)) owners.set(i, d.id);
        }
    return owners;
  };
  const owners = ownersFor();
  function summarize(
    tree: RouteTree,
    ownerMap: Map<number, string> = owners,
    blockedEdge?: number,
  ): { totals: DistanceTotals; rows: DistanceRow[] } {
    // This is a separate hypothetical service indicator: choose the best walk + wait,
    // rather than adding a wait to the shortest-by-metres route after it was chosen.
    const waits = new Map<number, number>();
    if (kind === 'bus_stop')
      for (const d of destinations)
        for (const id of d.accessNodeIds) {
          const node = topology.nodeIndex.get(id)!,
            wait = STOP_HEADWAYS[levels.get(d.id) ?? 0]! / 2;
          waits.set(node, Math.min(waits.get(node) ?? Infinity, wait));
        }
    const serviceTree =
      kind === 'bus_stop'
        ? shortestToTargets(timeGraph, waits.keys(), {
            initialCosts: waits,
            ...(blockedEdge === undefined ? {} : { blockedEdge }),
          })
        : null;
    let evaluatedResidents = 0,
      reachableResidents = 0,
      withinResidents = 0,
      weighted = 0,
      serviceWeighted = 0;
    const rows = homes.map((home) => {
      const weight = home.population!.total,
        entrance = bestEntrance(home, topology, tree),
        finite = Number.isFinite(entrance.seconds),
        target = finite ? (ownerMap.get(tree.targets[entrance.index]!) ?? null) : null;
      evaluatedResidents += weight;
      if (finite) {
        reachableResidents += weight;
        weighted += entrance.seconds * weight;
        if (entrance.seconds <= threshold + 1e-8) withinResidents += weight;
        if (serviceTree) serviceWeighted += bestEntrance(home, topology, serviceTree).seconds * weight;
      }
      return {
        buildingId: home.id,
        residents: weight,
        distanceM: finite ? entrance.seconds : null,
        destinationId: target,
      };
    });
    return {
      totals: {
        evaluatedResidents,
        reachableResidents,
        withinResidents,
        meanDistanceM: reachableResidents ? weighted / reachableResidents : null,
        meanServiceSeconds:
          kind === 'bus_stop' && reachableResidents ? serviceWeighted / reachableResidents : null,
        thresholdM: threshold,
      },
      rows,
    };
  }
  const tree = shortestToTargets(graph, owners.keys()),
    current = summarize(tree);
  return {
    data,
    profile,
    kind,
    threshold,
    topology,
    graph,
    homes,
    destinations,
    ownersFor,
    owners,
    tree,
    summarize,
    ...current,
  };
}
export function compareDistances(
  before: DistanceRow[],
  after: DistanceRow[],
  threshold: number,
): DistanceChange {
  const result: DistanceChange = {
    improvedResidents: 0,
    worsenedResidents: 0,
    unchangedResidents: 0,
    gainedWithinResidents: 0,
    lostWithinResidents: 0,
    gainedReachableResidents: 0,
    lostReachableResidents: 0,
    meanChangeCommonM: null,
    commonResidents: 0,
  };
  let weighted = 0;
  const byId = new Map(before.map((r) => [r.buildingId, r]));
  for (const row of after) {
    const old = byId.get(row.buildingId);
    requireCondition(old && old.residents === row.residents, 'INVALID_INPUT', 'Сравниваются разные жители');
    const a = old.distanceM ?? Infinity,
      b = row.distanceM ?? Infinity,
      w = row.residents;
    result[b < a - 0.01 ? 'improvedResidents' : b > a + 0.01 ? 'worsenedResidents' : 'unchangedResidents'] +=
      w;
    if (a > threshold && b <= threshold) result.gainedWithinResidents += w;
    if (a <= threshold && b > threshold) result.lostWithinResidents += w;
    if (!Number.isFinite(a) && Number.isFinite(b)) result.gainedReachableResidents += w;
    if (Number.isFinite(a) && !Number.isFinite(b)) result.lostReachableResidents += w;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      result.commonResidents += w;
      weighted += (b - a) * w;
    }
  }
  if (result.commonResidents) result.meanChangeCommonM = weighted / result.commonResidents;
  return result;
}
export async function analyzeDesign(
  engine: PlanningEngine,
  input: DesignAnalysisInput,
  control: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DesignAnalysisResult> {
  assertSchema('designAnalysis', input);
  input = structuredClone(input);
  const profile = engine.getProfiles().find((p) => p.id === input.profileId);
  requireCondition(profile, 'UNKNOWN_ID', 'Неизвестный профиль');
  const snapshot = engine.materialize(input.scenario),
    data = snapshot.data as DistrictData,
    rules = input.scenario.design?.rules ?? DEFAULT_DESIGN_RULES;
  const levels = new Map(input.scenario.design?.objects.map((o) => [o.id, o.level]) ?? []),
    ctx = context(data, profile, input.kind, rules.distanceThresholdM, levels);
  const result: DesignAnalysisResult = {
    mode: input.mode,
    kind: input.kind,
    totals: ctx.totals,
    rows: ctx.rows,
    costItems: snapshot.costItems ?? [],
    objects: [],
    candidates: [],
    top: [],
    vulnerabilities: [],
    comparisons: [],
    evaluatedCandidates: 0,
    spacingM: rules.candidateSpacingM,
    rules,
  };
  const check = () => {
    if (control.signal?.aborted) throw new EngineError('CANCELLED', 'Анализ отменён');
  };
  const cooperate = async (done: number, total: number) => {
    check();
    if (done % 8 === 0) {
      control.onProgress?.(done, total);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      check();
    }
  };
  check();
  if (input.mode === 'importance') {
    for (let i = 0; i < ctx.destinations.length; i++) {
      const d = ctx.destinations[i]!,
        object =
          input.scenario.design?.objects.find((o) => o.id === d.id) ?? objectFromDestination(data, d.id)!,
        removed = engine.materialize({
          ...input.scenario,
          budgetRub: Number.MAX_SAFE_INTEGER,
          design: {
            rules,
            objects: [
              ...(input.scenario.design?.objects ?? []).filter((o) => o.id !== d.id),
              { ...object, active: false },
            ],
          },
        }),
        without = context(
          removed.data as DistrictData,
          profile,
          input.kind,
          rules.distanceThresholdM,
          levels,
        ),
        servedResidents = ctx.rows
          .filter((r) => r.destinationId === d.id)
          .reduce((s, r) => s + r.residents, 0),
        level = levels.get(d.id) ?? 0;
      const parcel = data.parcels.find((p) => p.id === d.parcelId),
        capacity =
          d.kind === 'park' && parcel
            ? Math.floor((parcel.areaM2 / rules.parkM2PerVisitor) * CAPACITY_FACTORS[level]!)
            : d.capacity;
      result.objects.push({
        id: d.id,
        name: d.name,
        servedResidents,
        capacity,
        effectiveCapacity: capacity,
        loadPercent:
          capacity === null
            ? null
            : capacity > 0
              ? (servedResidents / capacity) * 100
              : servedResidents
                ? null
                : 0,
        without: without.totals,
        withoutRows: without.rows,
        change: compareDistances(ctx.rows, without.rows, rules.distanceThresholdM),
        expectedWaitSeconds: d.kind === 'bus_stop' ? STOP_HEADWAYS[level]! / 2 : 0,
      });
      await cooperate(i + 1, ctx.destinations.length);
    }
  }
  if (input.mode === 'needs') {
    const eligible = data.edges
      .map((e, i) => ({ e, i }))
      .filter(({ e, i }) => e.kind !== 'crossing' && Number.isFinite(ctx.graph.edgeCosts[i]));
    const spacing = Math.max(rules.candidateSpacingM, eligible.reduce((s, { e }) => s + e.lengthM, 0) / 1200);
    result.spacingM = spacing;
    const points: { id: string; edgeId: string; point: XY; alongM: number; accessDistanceM?: number }[] = [],
      seen = new Set<string>();
    for (const [edgeIndex, { e }] of eligible.entries()) {
      const distances = [0, e.lengthM];
      for (let d = spacing / 2; d < e.lengthM; d += spacing) distances.push(d);
      if (distances.length === 2) distances.push(e.lengthM / 2);
      for (const alongM of distances) {
        const point = pointAlong(e.geometry, alongM),
          snap = nearestNetworkPoint(data, point)!;
        if (!Number.isFinite(ctx.graph.edgeCosts[ctx.topology.edgeIndex.get(snap.edgeId)!])) continue;
        const id = `${snap.edgeId}@${snap.alongM.toFixed(6)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let accessDistanceM = 0;
        if (input.placementAware && input.kind !== 'park') {
          try {
            const placement = suggestPlacement(
              data,
              input.kind,
              snap.point,
              input.scenario.design?.objects,
              rules.snapDistanceM,
            );
            if (placement.site) {
              const door = siteAccessPoint(placement.site, input.kind, snap.point);
              accessDistanceM = Math.hypot(door[0] - snap.point[0], door[1] - snap.point[1]);
              if (
                accessDistanceM > 0.01 &&
                (profile.minWidthM > PLACEMENT_RULES.approachWidthM ||
                  !(profile.surfaceSpeedFactors.paving > 0))
              )
                continue;
            }
          } catch {
            continue;
          }
        }
        points.push({
          id,
          edgeId: snap.edgeId,
          point: snap.point,
          alongM: snap.alongM,
          ...(accessDistanceM ? { accessDistanceM } : {}),
        });
      }
      await cooperate(edgeIndex + 1, eligible.length);
    }
    requireCondition(
      points.length <= 5000,
      'SEARCH_LIMIT',
      'Слишком крупная сеть для интерактивной карты потребности',
    );
    const treeToPoint = (p: (typeof points)[number]) => {
      const edge = data.edges[ctx.topology.edgeIndex.get(p.edgeId)!]!,
        seeds = new Map<number, number>(),
        from = ctx.topology.nodeIndex.get(edge.from)!,
        to = ctx.topology.nodeIndex.get(edge.to)!;
      const access = p.accessDistanceM ?? 0;
      if (p.alongM < 0.001) seeds.set(from, access);
      else if (edge.lengthM - p.alongM < 0.001) seeds.set(to, access);
      else {
        seeds.set(from, p.alongM + access);
        if (edge.bidirectional) seeds.set(to, edge.lengthM - p.alongM + access);
      }
      return shortestToTargets(ctx.graph, seeds.keys(), { initialCosts: seeds });
    };
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!,
        tree = treeToPoint(p);
      let gainResidents = 0,
        gainReachableResidents = 0,
        weighted = 0,
        commonResidents = 0;
      for (let h = 0; h < ctx.homes.length; h++) {
        const home = ctx.homes[h]!,
          old = ctx.rows[h]!.distanceM ?? Infinity,
          distance = Math.min(old, bestEntrance(home, ctx.topology, tree).seconds),
          w = home.population!.total;
        if (old > rules.distanceThresholdM && distance <= rules.distanceThresholdM) gainResidents += w;
        if (!Number.isFinite(old) && Number.isFinite(distance)) gainReachableResidents += w;
        if (Number.isFinite(old)) {
          weighted += (old - distance) * w;
          commonResidents += w;
        }
      }
      result.candidates.push({
        ...p,
        gainResidents,
        gainReachableResidents,
        meanReductionM: commonResidents ? weighted / commonResidents : null,
        commonResidents,
        score: weighted,
      });
      await cooperate(i + 1, points.length);
    }
    result.evaluatedCandidates = points.length;
    const ranked = [...result.candidates].sort(
      (a, b) =>
        b.gainResidents - a.gainResidents ||
        b.gainReachableResidents - a.gainReachableResidents ||
        b.score - a.score ||
        a.id.localeCompare(b.id),
    );
    for (const candidate of ranked) {
      if (
        result.top.every(
          (other) =>
            Math.hypot(other.point[0] - candidate.point[0], other.point[1] - candidate.point[1]) >= 80,
        )
      ) {
        const tree = treeToPoint(candidate);
        candidate.rows = ctx.rows.map((row, h) => {
          const distance = bestEntrance(ctx.homes[h]!, ctx.topology, tree).seconds,
            old = row.distanceM ?? Infinity;
          return distance < old
            ? { ...row, distanceM: distance, destinationId: '__new_candidate' }
            : { ...row };
        });
        result.top.push(candidate);
      }
      if (result.top.length === 3) break;
    }
  }
  if (input.mode === 'vulnerability') {
    const edges = data.edges
      .map((e, i) => ({ e, i }))
      .filter(({ i }) => Number.isFinite(ctx.graph.edgeCosts[i]));
    for (let i = 0; i < edges.length; i++) {
      const { e, index } = { e: edges[i]!.e, index: edges[i]!.i },
        without = ctx.summarize(
          shortestToTargets(ctx.graph, ctx.owners.keys(), { blockedEdge: index }),
          ctx.owners,
          index,
        ),
        change = compareDistances(ctx.rows, without.rows, rules.distanceThresholdM);
      result.vulnerabilities.push({
        edgeId: e.id,
        lostResidents: change.lostWithinResidents,
        lostReachableResidents: change.lostReachableResidents,
        meanIncreaseM: change.meanChangeCommonM,
        affectedResidents: change.worsenedResidents,
      });
      await cooperate(i + 1, edges.length);
    }
  }
  if (input.mode === 'relocation') {
    requireCondition(input.objectId && input.point, 'INVALID_INPUT', 'Выберите объект и новую точку');
    const object =
      input.scenario.design?.objects.find((o) => o.id === input.objectId) ??
      objectFromDestination(data, input.objectId);
    requireCondition(object && object.active, 'UNKNOWN_ID', 'Объект не найден');
    requireCondition(
      object.kind === input.kind,
      'INVALID_INPUT',
      'Тип анализа должен совпадать с типом переносимого объекта',
    );
    requireCondition(
      object.kind !== 'park',
      'INVALID_INPUT',
      'Для переноса парка используйте перемещение границы',
    );
    const variants = [
      { name: 'Как сейчас', object },
      { name: 'Старый убран', object: { ...object, active: false } },
      {
        name: 'На новом месте',
        object:
          input.placementAware || object.placementChecked
            ? relocateWithContext(
                data,
                object,
                input.point,
                input.scenario.design?.objects,
                rules.snapDistanceM,
              )
            : { ...object, entrances: [input.point] },
      },
    ];
    for (const variant of variants) {
      const scenario: ScenarioInput = {
        ...input.scenario,
        budgetRub: Number.MAX_SAFE_INTEGER,
        design: {
          rules,
          objects: [
            ...(input.scenario.design?.objects ?? []).filter((o) => o.id !== object.id),
            variant.object,
          ],
        },
      };
      const state = engine.materialize(scenario),
        next = context(state.data as DistrictData, profile, input.kind, rules.distanceThresholdM, levels);
      result.comparisons.push({
        name: variant.name,
        totals: next.totals,
        rows: next.rows,
        change: compareDistances(ctx.rows, next.rows, rules.distanceThresholdM),
        costRub: state.costs.capexRub,
        costItems: state.costItems ?? [],
      });
    }
  }
  if (input.mode === 'compare') {
    requireCondition(
      input.scenarios && input.scenarios.length >= 2,
      'INVALID_INPUT',
      'Выберите минимум два сценария',
    );
    for (let i = 0; i < input.scenarios.length; i++) {
      const variant = input.scenarios[i]!,
        state = engine.materialize(variant.scenario),
        newLevels = new Map(variant.scenario.design?.objects.map((o) => [o.id, o.level]) ?? []),
        next = context(state.data as DistrictData, profile, input.kind, rules.distanceThresholdM, newLevels);
      result.comparisons.push({
        name: variant.name,
        totals: next.totals,
        rows: next.rows,
        change: compareDistances(ctx.rows, next.rows, rules.distanceThresholdM),
        costRub: state.costs.capexRub,
        costItems: state.costItems ?? [],
      });
      await cooperate(i + 1, input.scenarios.length);
    }
  }
  check();
  control.onProgress?.(1, 1);
  return result;
}
