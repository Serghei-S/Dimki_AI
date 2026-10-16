import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlanningEngine } from '../../dist/engine.js';
import { flowStyle } from '../../dist/map-logic.js';

const data = JSON.parse(await readFile(new URL('../../data/district.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data),
  base = { projectIds: [], budgetRub: 8000000 };

test('aggregated directional edge demand matches independent home-route sums across scenarios, profiles and goals', () => {
  const homes = data.buildings.filter((b) => b.population);
  for (const scenario of [base, ...data.scenarios])
    for (const profile of data.profiles)
      for (const metric of ['park', 'bus_stop', 'school', 'clinic', 'grocery']) {
        const report = engine.edgeLoads(scenario, profile.id, metric),
          oracle = new Map(report.edges.map((e) => [e.edgeId, { forward: 0, backward: 0 }]));
        const snapshot = engine.materialize(scenario).data,
          edges = new Map(snapshot.edges.map((e) => [e.id, e]));
        let assigned = 0;
        for (const home of homes) {
          const route = engine.route(scenario, profile.id, home.id, metric);
          if (!route.reachable) continue;
          assigned += home.population.total;
          route.edgeIds.forEach((id, i) => {
            oracle.get(id)[edges.get(id).from === route.nodeIds[i] ? 'forward' : 'backward'] +=
              home.population.total;
          });
        }
        for (const edge of report.edges) {
          assert.equal(edge.forward, oracle.get(edge.edgeId).forward);
          assert.equal(edge.backward, oracle.get(edge.edgeId).backward);
          assert.equal(edge.load, edge.forward + edge.backward);
          if (!edge.eligible) assert.equal(edge.load, 0);
        }
        assert.equal(report.assignedResidents, assigned);
        assert.equal(report.evaluatedResidents, 8636);
        assert.equal(report.unreachableResidents, 8636 - assigned);
        assert.equal(
          report.edgeTraversals,
          report.edges.reduce((sum, e) => sum + e.load, 0),
        );
        assert.equal(report.maxLoad, Math.max(...report.edges.map((e) => e.load)));
      }
});

test('combined snapshots preserve load regardless of animation sample and caller mutations', () => {
  const quiet = engine.mapSnapshot(base, 'walk', 'park'),
    animated = engine.mapSnapshot(base, 'walk', 'park', ['building_b00_sw']);
  assert.equal(quiet.routes.length, 0);
  assert.equal(animated.routes.length, 1);
  assert.deepEqual(quiet.loads, animated.loads);
  assert.equal(
    quiet.loads.assignedResidents,
    quiet.result.profiles.walk.destinations.park.reachableResidents,
  );
  quiet.loads.edges[0].load = 999999;
  assert.notEqual(engine.edgeLoads(base, 'walk', 'park').edges[0].load, 999999);
  assert.throws(() => engine.mapSnapshot(base, 'walk', 'park', ['building_b00_sw', 'building_b00_sw']));
  assert.throws(() => engine.edgeLoads(base, 'walk', 'missing'));
});

test('unreachable homes and absent goals produce no phantom flow', async () => {
  const home = data.buildings.find((b) => b.population),
    entrances = new Set(home.entranceNodeIds);
  const operationalOverrides = data.edges
    .filter((e) => entrances.has(e.from) || entrances.has(e.to))
    .map((e) => ({ op: 'set_edge_active', targetId: e.id, value: false }));
  const load = engine.edgeLoads({ ...base, operationalOverrides }, 'walk', 'park');
  assert.equal(load.unreachableResidents, home.population.total);
  const modified = structuredClone(data);
  modified.destinations.filter((d) => d.kind === 'park').forEach((d) => (d.active = false));
  const empty = (await createPlanningEngine(modified)).edgeLoads(base, 'walk', 'park');
  assert.equal(empty.assignedResidents, 0);
  assert.equal(empty.maxLoad, 0);
  assert.ok(empty.edges.every((e) => !e.load));
});

test('flow respects demographic weights and a common, bounded comparison scale', async () => {
  const local = await createPlanningEngine(data, {
    metrics: [
      { id: 'children', destinationKinds: ['school'], thresholdSeconds: 600, populationGroup: 'under18' },
    ],
  });
  const load = local.edgeLoads(base, 'walk', 'children');
  assert.equal(
    load.evaluatedResidents,
    local.evaluate(base, ['walk']).profiles.walk.destinations.children.evaluatedPopulation,
  );
  let previous = 0;
  for (const n of [0, 1, 100, 250, 500, 750, 1000, 1000000]) {
    const style = flowStyle(n);
    assert.ok(style.widthM >= previous && Number.isFinite(style.widthM));
    previous = style.widthM;
  }
  assert.deepEqual(flowStyle(250), flowStyle(250));
  assert.equal(flowStyle(1000).color, flowStyle(9999).color);
});
