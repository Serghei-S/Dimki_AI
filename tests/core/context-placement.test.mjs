import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPlanningEngine,
  newObject,
  DEFAULT_DESIGN_RULES,
  pointAlong,
  polygonArea,
} from '../../dist/engine.js';
import {
  suggestPlacement,
  siteProblem,
  polygonsOverlap,
  projectLocations,
  upsertObject,
  scenarioHistory,
  dragObject,
} from '../../dist/map-logic.js';
const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data),
  base = { projectIds: [], budgetRub: 8000000 };
const points = data.edges
  .filter((e) => e.active && e.kind !== 'crossing')
  .map((e) => pointAlong(e.geometry, e.lengthM / 2));
function proposal(kind, others = [], id = `user_${kind}`) {
  for (const point of points) {
    try {
      const placement = suggestPlacement(data, kind, point, others);
      return {
        ...newObject(kind, placement.point, id),
        placementChecked: true,
        ...(placement.site ? { site: placement.site } : {}),
      };
    } catch {}
  }
  throw Error(`No valid ${kind} site in real district`);
}
const scenario = (objects) => ({ ...base, design: { rules: { ...DEFAULT_DESIGN_RULES }, objects } });
test('context distinguishes street stops from park paths, and rejects roads/buildings instead of snapping through them', () => {
  const stop = proposal('bus_stop');
  const result = engine.materialize(scenario([stop]));
  assert.equal(result.data.destinations.find((d) => d.id === stop.id).routeIds.length, 0);
  const parkEdge = data.edges.find((e) => e.active && e.kind !== 'sidewalk' && e.kind !== 'crossing');
  assert(parkEdge);
  assert.throws(() =>
    suggestPlacement(data, 'bus_stop', pointAlong(parkEdge.geometry, parkEdge.lengthM / 2)),
  );
  for (const obstacle of [data.buildings[0], data.roads[0]]) {
    const ring = obstacle.polygon,
      point = [
        ring.slice(0, -1).reduce((s, p) => s + p[0], 0) / (ring.length - 1),
        ring.slice(0, -1).reduce((s, p) => s + p[1], 0) / (ring.length - 1),
      ];
    assert.throws(() => suggestPlacement(data, 'waste_bin', point));
  }
});
test('school and clinic reserve real free space; invalid, undersized and colliding sites are rejected by the engine', () => {
  for (const [kind, area] of [
    ['school', 4800],
    ['clinic', 1008],
  ]) {
    const object = proposal(kind);
    assert(Math.abs(polygonArea(object.site) - area) < 0.001);
    assert.equal(siteProblem(data, object.site), null);
    assert(engine.evaluate(scenario([object]), ['walk']).costs.capexRub > 0);
    const state = engine.materialize(scenario([object])).data;
    const destination = state.destinations.find((d) => d.id === object.id),
      entry = state.nodes.find((n) => n.id === destination.accessNodeIds[0]);
    const approach = state.edges.find(
      (e) => e.active && e.to === entry.id && e.id.startsWith('__edit_approach'),
    );
    assert(approach);
    assert(approach.lengthM > 0);
    assert(
      Math.abs(
        approach.lengthM -
          Math.hypot(entry.xy[0] - object.entrances[0][0], entry.xy[1] - object.entrances[0][1]),
      ) < 1e-6,
    );
    const tiny = {
      ...object,
      site: object.site.map((p) => [
        object.entrances[0][0] + (p[0] - object.entrances[0][0]) / 10,
        object.entrances[0][1] + (p[1] - object.entrances[0][1]) / 10,
      ]),
    };
    assert.throws(() => engine.materialize(scenario([tiny])));
    assert.throws(() => engine.materialize(scenario([object, { ...object, id: 'user_collision' }])));
    const moved = dragObject(
      object,
      object.entrances[0],
      [object.entrances[0][0] + 7, object.entrances[0][1] + 9],
      'object',
      0,
    );
    assert.deepEqual(
      moved.site,
      object.site.map((p) => [p[0] + 7, p[1] + 9]),
    );
  }
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  assert(
    polygonsOverlap(square, [
      [-2, 4],
      [12, 4],
      [12, 5],
      [-2, 5],
      [-2, 4],
    ]),
  );
  assert(
    !polygonsOverlap(square, [
      [20, 20],
      [30, 20],
      [30, 30],
      [20, 30],
      [20, 20],
    ]),
  );
});
test('mixed object set applies atomically, preserves populations and routes, survives export/import and one-step undo', () => {
  const objects = [];
  for (const kind of ['school', 'clinic', 'parking', 'playground', 'waste_bin'])
    objects.push(proposal(kind, objects));
  const next = scenario(objects),
    before = engine.evaluate(base, ['walk']),
    after = engine.evaluate(next, ['walk']);
  assert.equal(after.profiles.walk.perBuilding.length, before.profiles.walk.perBuilding.length);
  for (let i = 0; i < after.profiles.walk.perBuilding.length; i++) {
    const a = before.profiles.walk.perBuilding[i],
      b = after.profiles.walk.perBuilding[i];
    assert.equal(a.residents, b.residents);
    for (const id of Object.keys(a.destinations))
      assert(
        (b.destinations[id].travelSeconds ?? Infinity) <=
          (a.destinations[id].travelSeconds ?? Infinity) + 0.002,
      );
  }
  assert.deepEqual(engine.importScenario(engine.exportScenario(next)), { ...next, operationalOverrides: [] });
  const history = scenarioHistory({ current: base, past: [], future: [] }, { type: 'apply', scenario: next });
  assert.equal(history.past.length, 1);
  assert.deepEqual(scenarioHistory(history, { type: 'undo' }).current, base);
  assert.throws(() => engine.evaluate({ ...next, budgetRub: 0 }, ['walk']));
  assert.deepEqual(engine.getDataset(), data);
});
test('small amenities do not invent improvements in the five access criteria; lighting upgrades do not create parking spaces', () => {
  const before = engine.evaluate(base, ['walk']);
  for (const kind of ['parking', 'playground', 'waste_bin']) {
    const object = proposal(kind),
      after = engine.evaluate(scenario([object]), ['walk']);
    assert.deepEqual(after.profiles.walk.destinations, before.profiles.walk.destinations);
    for (const level of [0, 1, 2]) {
      const state = engine.materialize(scenario([{ ...object, level }]));
      assert.equal(state.data.destinations.find((d) => d.id === object.id).capacity, object.capacity);
    }
  }
});
test('context-aware school recommendations are placeable and match an actual recalculation at the recommended entrance', async () => {
  const result = await engine.analyzeDesign({
    scenario: base,
    profileId: 'walk',
    kind: 'school',
    mode: 'needs',
    placementAware: true,
  });
  assert(result.top.length > 0);
  for (const candidate of result.top) {
    const placement = suggestPlacement(data, 'school', candidate.point),
      object = { ...newObject('school', placement.point), site: placement.site, placementChecked: true };
    const actual = await engine.analyzeDesign({
      scenario: scenario([object]),
      profileId: 'walk',
      kind: 'school',
      mode: 'importance',
    });
    assert.equal(actual.totals.withinResidents - result.totals.withinResidents, candidate.gainResidents);
    assert(
      Math.abs(result.totals.meanDistanceM - actual.totals.meanDistanceM - candidate.meanReductionM) < 0.002,
    );
  }
});
test('camera focus resolves every project, including transitions, upgrades, parcels and relocated stops', () => {
  for (const project of data.projects) {
    const locations = projectLocations(data, [project.id]);
    assert(locations.length > 0, project.id);
    for (const point of locations) assert(point.every(Number.isFinite));
    assert.deepEqual(projectLocations(data, [project.id, project.id]), locations);
  }
  assert.deepEqual(projectLocations(data, ['unknown']), []);
});
