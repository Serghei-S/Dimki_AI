import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPlanningEngine,
  newObject,
  objectFromDestination,
  DEFAULT_DESIGN_RULES,
  nearestNetworkPoint,
  polygonArea,
  autoParkEntrances,
  validatePolygon,
  compileTopology,
  buildRoutingGraph,
  shortestToTargets,
  edgeTravelSeconds,
  compareDistances,
  EngineWorkerClient,
  createWorkerRuntime,
} from '../../dist/engine.js';
import { upsertObject, dragObject, scenarioHistory, applyDistrictChanges } from '../../dist/map-logic.js';

const data = JSON.parse(await readFile(new URL('../../data/district.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data);
const base = { projectIds: [], budgetRub: 8000000 };
const rules = structuredClone(DEFAULT_DESIGN_RULES);
const scenario = (...objects) => ({ ...base, design: { rules: structuredClone(rules), objects } });
const request = (scenario, kind = 'bus_stop', mode = 'importance', extra = {}) => ({
  scenario,
  kind,
  mode,
  profileId: 'walk',
  ...extra,
});
const close = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const error = (code) => (e) => e.code === code;

// Independent Bellman-Ford oracle: no routing trees, target ownership or engine aggregation.
function distances(district, kind, profile = data.profiles[0]) {
  const dist = new Map(district.nodes.map((n) => [n.id, Infinity]));
  const active = new Set(district.nodes.filter((n) => n.active).map((n) => n.id));
  for (const d of district.destinations.filter((d) => d.active && d.kind === kind))
    for (const n of d.accessNodeIds) dist.set(n, 0);
  for (let pass = 0; pass < dist.size; pass++) {
    let changed = false;
    for (const e of district.edges) {
      if (!e.active || !active.has(e.from) || !active.has(e.to) || edgeTravelSeconds(e, profile) === null)
        continue;
      if (dist.get(e.to) + e.lengthM < dist.get(e.from)) {
        dist.set(e.from, dist.get(e.to) + e.lengthM);
        changed = true;
      }
      if (e.bidirectional && dist.get(e.from) + e.lengthM < dist.get(e.to)) {
        dist.set(e.to, dist.get(e.from) + e.lengthM);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return district.buildings
    .filter((b) => b.population)
    .map((b) => {
      const value = Math.min(...b.entranceNodeIds.map((n) => dist.get(n)));
      return {
        buildingId: b.id,
        residents: b.population.total,
        distanceM: Number.isFinite(value) ? value : null,
      };
    });
}
function oracleTotals(rows, threshold = 400) {
  const reachable = rows.filter((r) => r.distanceM !== null),
    population = reachable.reduce((s, r) => s + r.residents, 0);
  return {
    population,
    mean: population ? reachable.reduce((s, r) => s + r.residents * r.distanceM, 0) / population : null,
    within: reachable.filter((r) => r.distanceM <= threshold).reduce((s, r) => s + r.residents, 0),
  };
}

test('arbitrary position creates an exact node and conserves lengths, directions and previous routes', () => {
  const object = newObject('community', [81.253, 16], 'user_exact'),
    s = scenario(object),
    district = engine.materialize(s).data;
  const dest = district.destinations.find((d) => d.id === object.id),
    node = district.nodes.find((n) => n.id === dest.accessNodeIds[0]);
  assert.deepEqual(node.xy, [81.253, 16]);
  assert.ok(!data.nodes.some((n) => n.xy[0] === 81.253 && n.xy[1] === 16));
  assert.equal(district.edges.find((e) => e.id === 'b00_sidewalk_0').active, false);
  const children = district.edges.filter((e) => e.active && (e.from === node.id || e.to === node.id));
  assert.equal(children.length, 2);
  close(
    children.reduce((s, e) => s + e.lengthM, 0),
    144,
  );
  for (const e of children) {
    assert.equal(e.bidirectional, true);
    assert.equal(e.surface, 'asphalt');
    assert.equal(e.slope, 0.015);
  }
  for (const profile of data.profiles)
    for (const kind of ['bus_stop', 'park', 'school', 'clinic', 'grocery']) {
      const actual = distances(district, kind, profile),
        expected = distances(data, kind, profile);
      actual.forEach((r, i) => close(r.distanceM, expected[i].distanceM));
    }
  assert.deepEqual(data, JSON.parse(awaitText));
});
const awaitText = JSON.stringify(data);

test('several cuts share coincident nodes, endpoints do not add zero length edges, moving leaves no old cuts', () => {
  const a = newObject('community', [40, 16], 'user_a'),
    b = newObject('grocery', [100, 16], 'user_b'),
    c = newObject('clinic', [40, 16], 'user_c');
  const district = engine.materialize(scenario(a, b, c)).data;
  const access = (id) => district.destinations.find((d) => d.id === id).accessNodeIds[0];
  assert.equal(access(a.id), access(c.id));
  assert.notEqual(access(a.id), access(b.id));
  assert.equal(district.nodes.length, data.nodes.length + 2);
  assert.ok(district.edges.every((e) => e.lengthM > 0));
  const moved = engine.materialize(scenario({ ...a, entrances: [[210.123, 16]] })).data;
  assert.equal(moved.nodes.length, data.nodes.length + 1);
  assert.ok(!moved.nodes.some((n) => n.xy[0] === 40 && n.xy[1] === 16));
  const endpoint = engine.materialize(scenario({ ...a, entrances: [[16, 16]] })).data;
  assert.equal(endpoint.nodes.length, data.nodes.length);
  assert.equal(endpoint.edges.length, data.edges.length);
  assert.deepEqual(engine.materialize(base).data, data);
});

test('curved one-way edge cuts preserve polyline geometry and directed travel time', async () => {
  const variant = structuredClone(data),
    edge = variant.edges.find((e) => e.id === 'b00_sidewalk_0');
  edge.geometry = [
    [16, 16],
    [70, 18],
    [160, 16],
  ];
  edge.lengthM = Math.hypot(54, 2) + Math.hypot(90, 2);
  edge.bidirectional = false;
  const e = await createPlanningEngine(variant),
    o = newObject('community', [97, 17.4], 'user_curve');
  const state = e.materialize(scenario(o)).data,
    newEdges = state.edges.filter((x) => x.id.startsWith('__edit_edge'));
  assert.equal(newEdges.length, 2);
  assert.ok(newEdges.every((x) => !x.bidirectional));
  close(
    newEdges.reduce((s, x) => s + x.lengthM, 0),
    edge.lengthM,
  );
  assert.ok(newEdges.some((x) => x.geometry.some((p) => p[0] === 70 && p[1] === 18)));
  for (const profile of data.profiles)
    close(
      newEdges.reduce((s, x) => s + edgeTravelSeconds(x, profile), 0),
      edgeTravelSeconds(edge, profile),
    );
});

test('new stop, routes, edge flow and district patches include dynamic topology', () => {
  const s = scenario(newObject('bus_stop', [81.25, 16], 'user_stop')),
    snap = engine.mapSnapshot(
      s,
      'walk',
      'bus_stop',
      data.buildings.filter((b) => b.population).map((b) => b.id),
    );
  const patched = applyDistrictChanges(data, snap.result.districtChanges),
    full = engine.materialize(s).data;
  assert.deepEqual(patched, full);
  assert.ok(patched.stopBays.length > data.stopBays.length);
  assert.equal(snap.loads.edges.length, patched.edges.length);
  for (const route of snap.routes.filter((r) => r.reachable)) {
    assert.ok(patched.destinations.some((d) => d.id === route.destinationId));
    route.edgeIds.forEach((id) => assert.ok(patched.edges.some((e) => e.id === id && e.active)));
  }
  assert.deepEqual(applyDistrictChanges(data, engine.evaluate(base, ['walk']).districtChanges), data);
});

test('importance matches full counterfactual independently, including population ownership and budget-free analysis', async () => {
  const s = scenario(newObject('bus_stop', [81.25, 16], 'user_stop')),
    result = await engine.analyzeDesign(request(s));
  const initial = oracleTotals(distances(engine.materialize(s).data, 'bus_stop'));
  close(result.totals.meanDistanceM, initial.mean);
  assert.equal(result.totals.withinResidents, initial.within);
  assert.equal(
    result.objects.reduce((s, o) => s + o.servedResidents, 0),
    initial.population,
  );
  for (const importance of result.objects) {
    const object =
      s.design.objects.find((o) => o.id === importance.id) ?? objectFromDestination(data, importance.id);
    const removed = upsertObject({ ...s, budgetRub: Number.MAX_SAFE_INTEGER }, { ...object, active: false });
    const expected = oracleTotals(distances(engine.materialize(removed).data, 'bus_stop'));
    close(importance.without.meanDistanceM, expected.mean);
    assert.equal(importance.without.withinResidents, expected.within);
    assert.equal(importance.withoutRows.length, result.rows.length);
  }
});

test('needs recommendations equal actual placement effects for every category and restricted walking profile', async () => {
  for (const kind of ['bus_stop', 'park', 'clinic'])
    for (const profileId of ['walk', 'step_free']) {
      const needs = await engine.analyzeDesign(request(base, kind, 'needs', { profileId }));
      assert.ok(needs.evaluatedCandidates > data.nodes.length);
      assert.ok(needs.top.length === 3);
      for (const p of needs.top) {
        const object = { ...newObject(kind, p.point, 'user_recommendation'), autoEntrances: false };
        const after = await engine.analyzeDesign(
          request(scenario(object), kind, 'importance', { profileId }),
        );
        assert.equal(after.totals.withinResidents - needs.totals.withinResidents, p.gainResidents);
        assert.equal(
          after.totals.reachableResidents - needs.totals.reachableResidents,
          p.gainReachableResidents,
        );
        close(needs.totals.meanDistanceM - after.totals.meanDistanceM, p.meanReductionM);
      }
    }
});

test('polygon parks compute area capacity and nearest entrance; no entrances means no imaginary access', async () => {
  const park = {
    ...newObject('park', [80, 16], 'user_park'),
    polygon: [
      [40, 16],
      [100, 16],
      [100, 46],
      [40, 46],
      [40, 16],
    ],
    autoEntrances: false,
    entrances: [
      [43.5, 16],
      [95.5, 16],
    ],
    level: 1,
  };
  const s = scenario(park),
    full = engine.materialize(s).data,
    d = full.destinations.find((d) => d.id === park.id);
  assert.equal(d.capacity, 225);
  assert.equal(d.accessNodeIds.length, 2);
  assert.equal(polygonArea(park.polygon), 1800);
  const r = await engine.analyzeDesign(request(s, 'park'));
  const expected = oracleTotals(distances(full, 'park'));
  close(r.totals.meanDistanceM, expected.mean);
  const o = r.objects.find((o) => o.id === park.id);
  assert.equal(o.capacity, 225);
  close(o.loadPercent, (o.servedResidents / 225) * 100);
  const blank = await engine.analyzeDesign(request(scenario({ ...park, entrances: [] }), 'park'));
  assert.equal(blank.objects.find((o) => o.id === park.id).servedResidents, 0);
  const changed = { ...s, design: { ...s.design, rules: { ...rules, parkM2PerVisitor: 20 } } };
  assert.equal(engine.materialize(changed).data.destinations.find((d) => d.id === park.id).capacity, 112);
});

test('automatic entrances detect interior side intersections, ignore inactive nodes and snap each resulting entrance', () => {
  const polygon = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
    ],
    fixture = {
      nodes: [
        { id: 'a', active: true },
        { id: 'b', active: true },
      ],
      edges: [
        {
          id: 'e',
          from: 'a',
          to: 'b',
          active: true,
          kind: 'sidewalk',
          geometry: [
            [50, -20],
            [50, 120],
          ],
        },
      ],
    };
  assert.deepEqual(autoParkEntrances(fixture, polygon, 0), [
    [50, 0],
    [50, 100],
  ]);
  fixture.nodes[0].active = false;
  assert.deepEqual(autoParkEntrances(fixture, polygon, 25), []);
});

test('new objects attach exactly to new internal park paths, independently of object order', async () => {
  const park = {
    ...newObject('park', [85, 28], 'user_through'),
    polygon: [
      [30, 16],
      [140, 16],
      [140, 40],
      [30, 40],
      [30, 16],
    ],
    entrances: [
      [45, 16],
      [125, 16],
    ],
    autoEntrances: false,
    throughAccess: true,
  };
  const object = newObject('grocery', [65, 22], 'user_internal');
  const a = engine.materialize(scenario(object, park)).data,
    b = engine.materialize(scenario(park, object)).data;
  const entrance = (d) =>
    d.nodes.find((n) => n.id === d.destinations.find((x) => x.id === object.id).accessNodeIds[0]);
  assert.deepEqual(entrance(a).xy, [65, 22]);
  assert.deepEqual(entrance(b).xy, [65, 22]);
  assert.ok(
    a.edges
      .filter((e) => e.active && e.kind === 'park_path')
      .some((e) => e.from === entrance(a).id || e.to === entrance(a).id),
  );
  const needs = await engine.analyzeDesign(request(scenario(park), 'grocery', 'needs'));
  for (const candidate of needs.candidates.filter((c) => c.edgeId.includes('park_path')).slice(0, 3)) {
    const after = await engine.analyzeDesign(
      request(scenario(park, newObject('grocery', candidate.point, 'user_candidate')), 'grocery'),
    );
    close(needs.totals.meanDistanceM - after.totals.meanDistanceM, candidate.meanReductionM);
  }
});

test('oversized point capacity has an explicit additional budget cost', () => {
  const object = { ...newObject('grocery', [55, 16], 'user_capacity'), capacity: 200 };
  assert.equal(engine.materialize(scenario(object)).costs.capexRub, 400000);
});

test('validation rejects malformed polygons, unknown IDs, duplicate IDs, disconnected placements and over-budget edits', () => {
  const object = newObject('bus_stop', [81.25, 16], 'user_valid');
  assert.throws(() => engine.materialize(scenario(object, object)), error('INVALID_SCENARIO'));
  assert.throws(
    () => engine.materialize(scenario({ ...object, id: 'not_existing' })),
    error('INVALID_SCENARIO'),
  );
  assert.throws(
    () => engine.materialize(scenario({ ...object, entrances: [[100000, 100000]] })),
    error('INVALID_SCENARIO'),
  );
  assert.throws(() => engine.materialize({ ...scenario(object), budgetRub: 1 }), error('BUDGET_EXCEEDED'));
  assert.throws(() => engine.materialize(scenario({ ...object, level: 3 })), error('INVALID_INPUT'));
  assert.throws(() =>
    validatePolygon(
      [
        [0, 0],
        [20, 0],
        [0, 20],
        [20, 20],
        [0, 0],
      ],
      [-100, -100, 100, 100],
    ),
  );
  assert.throws(() =>
    validatePolygon(
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      [-100, -100, 100, 100],
    ),
  );
});

test('levels change capacity, waiting time and cost through explicit rules without shortening pedestrian distance', async () => {
  const object = objectFromDestination(data, 'stop_west');
  object.capacity = 100;
  const a = await engine.analyzeDesign(request(scenario(object))),
    b = await engine.analyzeDesign(request(scenario({ ...object, level: 2 })));
  close(a.totals.meanDistanceM, b.totals.meanDistanceM);
  assert.ok(b.totals.meanServiceSeconds < a.totals.meanServiceSeconds);
  assert.equal(b.objects.find((o) => o.id === object.id).capacity, 150);
  assert.equal(b.objects.find((o) => o.id === object.id).expectedWaitSeconds, 150);
  assert.ok(
    engine.materialize(scenario({ ...object, level: 2 })).costs.capexRub >
      engine.materialize(scenario(object)).costs.capexRub,
  );
});

test('relocation compares current, removed and moved with separate winning and losing residents and exact rows', async () => {
  const result = await engine.analyzeDesign(
    request(base, 'bus_stop', 'relocation', { objectId: 'stop_west', point: [306, 746] }),
  );
  assert.equal(result.comparisons.length, 3);
  const same = result.comparisons[0];
  assert.equal(same.change.improvedResidents, 0);
  assert.equal(same.change.worsenedResidents, 0);
  const moved = result.comparisons[2];
  assert.ok(moved.change.improvedResidents > 0);
  assert.ok(moved.change.worsenedResidents > 0);
  assert.equal(
    moved.change.improvedResidents + moved.change.worsenedResidents + moved.change.unchangedResidents,
    8636,
  );
  const oracle = oracleTotals(
    distances(
      engine.materialize(scenario({ ...objectFromDestination(data, 'stop_west'), entrances: [[306, 746]] }))
        .data,
      'bus_stop',
    ),
  );
  close(moved.totals.meanDistanceM, oracle.mean);
  assert.equal(moved.totals.withinResidents, oracle.within);
});

test('unreachable cohorts never artificially improve the average; gains and losses of reachability remain explicit', () => {
  const rows = [
    { buildingId: 'a', residents: 10, distanceM: 100 },
    { buildingId: 'b', residents: 20, distanceM: 1000 },
    { buildingId: 'c', residents: 30, distanceM: null },
  ];
  const after = [
    { ...rows[0], distanceM: 200 },
    { ...rows[1], distanceM: null },
    { ...rows[2], distanceM: 150 },
  ];
  const change = compareDistances(rows, after, 400);
  assert.equal(change.meanChangeCommonM, 100);
  assert.equal(change.commonResidents, 10);
  assert.equal(change.improvedResidents, 30);
  assert.equal(change.worsenedResidents, 30);
  assert.equal(change.lostReachableResidents, 20);
  assert.equal(change.gainedReachableResidents, 30);
});

test('saved scenarios, undo/redo, vertex/entrance transforms and comparisons preserve independent edits', async () => {
  const object = newObject('grocery', [55.2, 16], 'user_history'),
    s = scenario(object),
    envelope = engine.exportScenario(s);
  assert.deepEqual(engine.importScenario(JSON.stringify(envelope)), { ...s, operationalOverrides: [] });
  const history = scenarioHistory({ past: [], current: base, future: [] }, { type: 'apply', scenario: s });
  assert.deepEqual(scenarioHistory(scenarioHistory(history, { type: 'undo' }), { type: 'redo' }).current, {
    ...s,
    operationalOverrides: [],
  });
  const park = newObject('park', [100, 100], 'user_vertices'),
    moved = dragObject(park, [0, 0], [10, 12], 'vertex', 0);
  assert.deepEqual(moved.polygon[0], moved.polygon.at(-1));
  assert.deepEqual(park.polygon[0], [75, 75]);
  const result = await engine.analyzeDesign(
    request(s, 'grocery', 'compare', {
      scenarios: [
        { name: 'А', scenario: base },
        { name: 'Б', scenario: s },
      ],
    }),
  );
  assert.equal(result.comparisons.length, 2);
  assert.equal(result.comparisons[1].costRub, 300000);
  assert.equal(result.comparisons[1].change.improvedResidents, 0);
});

test('vulnerability matches a physically closed edge and design analysis cooperatively cancels', async () => {
  const result = await engine.analyzeDesign(request(base, 'park', 'vulnerability'));
  const critical = [...result.vulnerabilities].sort((a, b) => b.affectedResidents - a.affectedResidents)[0];
  const closed = structuredClone(data);
  closed.edges.find((e) => e.id === critical.edgeId).active = false;
  const expected = oracleTotals(distances(closed, 'park'));
  assert.equal(result.totals.withinResidents - expected.within, critical.lostResidents);
  const controller = new AbortController();
  await assert.rejects(
    engine.analyzeDesign(request(base, 'bus_stop', 'needs'), {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    error('CANCELLED'),
  );
});

test('optimizer includes edit cost and topology; cancellation remains cooperative for infeasible subsets', async () => {
  const object = newObject('community', [55.2, 16], 'user_optimization');
  const result = await engine.optimize({
    profileId: 'walk',
    metricId: 'park',
    budgetRub: 8000000,
    design: scenario(object).design,
    candidateProjectIds: [],
  });
  assert.equal(result.alternatives[0].costs.capexRub, 700000);
  const controller = new AbortController();
  await assert.rejects(
    engine.optimize(
      { profileId: 'walk', metricId: 'park', budgetRub: 800000, design: scenario(object).design },
      {
        signal: controller.signal,
        yieldEvery: 1,
        onProgress: (p) => {
          if (p.processedSubsets > 0) controller.abort();
        },
      },
    ),
    error('CANCELLED'),
  );
});

test('worker transport validates, computes, cancels analysis and retains editable scenario envelopes', async () => {
  class Transport extends EventTarget {
    runtime = createWorkerRuntime((message) =>
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: message }))),
    );
    postMessage(message) {
      void this.runtime.handle(structuredClone(message));
    }
    terminate() {
      this.runtime.dispose();
    }
  }
  const client = new EngineWorkerClient(new Transport());
  try {
    await client.init(data);
    const s = scenario(newObject('bus_stop', [81.25, 16], 'user_worker'));
    const result = await client.analyzeDesign(request(s));
    assert.ok(result.objects.some((o) => o.id === 'user_worker'));
    assert.deepEqual(await client.importScenario(await client.exportScenario(s)), {
      ...s,
      operationalOverrides: [],
    });
    const controller = new AbortController();
    await assert.rejects(
      client.analyzeDesign(request(s, 'park', 'needs'), {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
      error('CANCELLED'),
    );
    assert.equal((await client.evaluate(base, ['walk'])).profiles.walk.evaluatedPopulation, 8636);
  } finally {
    client.dispose();
  }
});
