import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  createPlanningEngine,
  newObject,
  DEFAULT_DESIGN_RULES,
  pointAlong,
  edgeTravelSeconds,
} from '../../dist/engine.js';
import { applyDistrictChanges, upsertObject, createMotionPaths, sampleMotion } from '../../dist/map-logic.js';

const read = async (path) => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));
const data = await read('data/obninsk-center.json'),
  provenance = await read('data/obninsk-center.provenance.json');
const osm = await read('data/sources/obninsk-center.osm.json'),
  sourceWays = new Map(osm.elements.filter((e) => e.type === 'way').map((e) => [e.id, e]));
const engine = await createPlanningEngine(data),
  base = { projectIds: [], budgetRub: 8000000 };
const close = (a, b, tolerance = 0.002) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('real map footprints preserve OSM coordinates and source hashes; assumptions remain explicit', async () => {
  assert.equal(data.metadata.license, 'ODbL-1.0');
  assert.equal(data.metadata.synthetic, true);
  assert.ok(data.buildings.length >= 35 && data.buildings.length <= 50);
  assert.ok(data.roads.every((r) => r.centerline?.length >= 2));
  assert.equal(
    provenance.sourceSha256,
    createHash('sha256')
      .update(await readFile(new URL('../../data/sources/obninsk-center.osm.json', import.meta.url)))
      .digest('hex'),
  );
  assert.equal(
    provenance.detailsSha256,
    createHash('sha256')
      .update(await readFile(new URL('../../data/sources/obninsk-details.osm.json', import.meta.url)))
      .digest('hex'),
  );
  for (const building of data.buildings) {
    const source = provenance.buildings[building.id],
      way = sourceWays.get(source.osmId);
    assert.ok(way);
    assert.equal(building.polygon.length, way.geometry.length);
    building.polygon.forEach((p) => {
      const lon =
        data.metadata.coordinateSystem.displayOriginWgs84[0] +
        ((p[0] /
          6371008.8 /
          Math.cos((data.metadata.coordinateSystem.displayOriginWgs84[1] * Math.PI) / 180)) *
          180) /
          Math.PI;
      const lat = data.metadata.coordinateSystem.displayOriginWgs84[1] + ((p[1] / 6371008.8) * 180) / Math.PI;
      assert.ok(way.geometry.some((q) => Math.abs(q.lon - lon) < 1e-8 && Math.abs(q.lat - lat) < 1e-8));
    });
    assert.equal(source.populationSynthetic, building.population !== null);
    if (!source.floorsAssumed) assert.equal(building.floors, Number(way.tags['building:levels']));
  }
  const clinic = data.destinations.find((d) => d.active && d.kind === 'clinic');
  assert.equal(provenance.destinations[clinic.id].kind, 'scenario_assumption');
  assert.match(clinic.name, /допущение/);
  const assumedParks = data.destinations.filter(
    (d) => d.active && d.kind === 'park' && provenance.destinations[d.id].parkInterpretationAssumed,
  );
  assert.ok(assumedParks.length > 0);
  assert.ok(assumedParks.every((p) => /учебный/.test(p.name)));
});

test('all profiles and catalogue scenarios keep consistent populations, complete patches and real routes', () => {
  const population = data.buildings.reduce((sum, b) => sum + (b.population?.total ?? 0), 0);
  assert.equal(population, provenance.summary.residents);
  for (const scenario of data.scenarios) {
    const evaluated = engine.evaluate(scenario),
      district = applyDistrictChanges(data, evaluated.districtChanges);
    assert.deepEqual(district, engine.materialize(scenario).data);
    for (const profile of data.profiles) {
      assert.equal(evaluated.profiles[profile.id].evaluatedPopulation, population);
      for (const metric of engine.getMetrics()) {
        const totals = evaluated.profiles[profile.id].destinations[metric.id];
        assert.equal(totals.reachableResidents + totals.unreachableResidents, population);
        assert.ok(totals.withinThresholdResidents <= totals.reachableResidents);
      }
      for (const b of data.buildings.filter((b) => b.population)) {
        const route = engine.route(scenario, profile.id, b.id, 'school');
        if (!route.reachable) continue;
        let sum = 0;
        route.edgeIds.forEach((id, i) => {
          const edge = district.edges.find((e) => e.id === id);
          assert.ok(edge.active);
          assert.ok(
            (edge.from === route.nodeIds[i] && edge.to === route.nodeIds[i + 1]) ||
              (edge.bidirectional && edge.to === route.nodeIds[i] && edge.from === route.nodeIds[i + 1]),
          );
          assert.notEqual(edgeTravelSeconds(edge, profile), null);
          sum += edgeTravelSeconds(edge, profile);
        });
        close(route.travelSeconds, sum);
        for (const [lon, lat] of route.geojson.geometry.coordinates)
          assert.ok(lon > 36.6 && lon < 36.63 && lat > 55.085 && lat < 55.1);
      }
    }
  }
});

test('all real-city scenario/profile results agree with the independent Python oracle', async () => {
  const oracle = await read('data/obninsk/reports/scenario-comparison.json');
  function match(actual, expected) {
    if (typeof expected === 'number') close(actual, expected);
    else if (Array.isArray(expected)) {
      assert.equal(actual.length, expected.length);
      expected.forEach((value, i) => match(actual[i], value));
    } else if (expected && typeof expected === 'object') {
      for (const [key, value] of Object.entries(expected)) match(actual[key], value);
    } else assert.equal(actual, expected);
  }
  for (const scenario of data.scenarios) {
    const result = engine.evaluate(scenario),
      expected = oracle.find((x) => x.scenarioId === scenario.id);
    match(result.profiles, expected.metrics);
    match(result.costs, expected.costs);
    match(result.changesFromBaseline, expected.changesFromBaseline);
  }
  const manifest = await read('data/obninsk-center.manifest.json');
  for (const item of manifest.files)
    assert.equal(
      createHash('sha256')
        .update(await readFile(new URL(`../../data/${item.path}`, import.meta.url)))
        .digest('hex'),
      item.sha256,
      item.path,
    );
});

test('new city retains all project categories, dependencies, exclusive stop choices and budget validation', () => {
  assert.equal(data.projects.length, 12);
  assert.deepEqual([...new Set(data.projects.map((p) => p.kind))].sort(), [
    'accessibility',
    'new_crossing',
    'new_park',
    'open_passage',
    'relocate_stop',
  ]);
  for (const project of data.projects) {
    const scenario = { ...base, projectIds: [...project.requires, project.id] };
    assert.ok(engine.evaluate(scenario, ['walk']).costs.capexRub > 0);
  }
  assert.throws(
    () => engine.evaluate({ ...base, projectIds: ['oc_hub_0', 'oc_hub_1'] }),
    (e) => e.code === 'PROJECT_CONFLICT',
  );
  assert.throws(
    () => engine.evaluate({ ...base, projectIds: ['oc_green_0_path'] }),
    (e) => e.code === 'DEPENDENCY_ERROR',
  );
  assert.throws(
    () => engine.evaluate({ ...base, projectIds: ['oc_green_0'], budgetRub: 1 }),
    (e) => e.code === 'BUDGET_EXCEEDED',
  );
});

test('free placement on a curved OSM path, movement, removal and saving preserve engine and animation behaviour', () => {
  const edge = data.edges.find(
    (e) => e.active && e.kind !== 'crossing' && e.geometry.length > 2 && e.lengthM > 12,
  );
  assert.ok(edge);
  const point = pointAlong(edge.geometry, edge.lengthM * 0.4321),
    object = newObject('bus_stop', point, 'user_real_map');
  let scenario = upsertObject(base, object);
  const snapshot = engine.mapSnapshot(
    scenario,
    'walk',
    'bus_stop',
    data.buildings.filter((b) => b.population).map((b) => b.id),
  );
  const district = applyDistrictChanges(data, snapshot.result.districtChanges),
    dest = district.destinations.find((d) => d.id === object.id),
    node = district.nodes.find((n) => n.id === dest.accessNodeIds[0]);
  close(node.xy[0], point[0], 0.0001);
  close(node.xy[1], point[1], 0.0001);
  assert.deepEqual(engine.importScenario(engine.exportScenario(scenario)), {
    ...scenario,
    operationalOverrides: [],
  });
  const paths = createMotionPaths(district, data.profiles[0], snapshot.routes);
  assert.ok(paths.length > 0);
  const path = paths[0],
    sample = sampleMotion(path, path.travelSeconds / 2);
  assert.ok(Number.isFinite(sample.x) && Number.isFinite(sample.y));
  scenario = upsertObject(scenario, {
    ...object,
    entrances: [pointAlong(edge.geometry, edge.lengthM * 0.7)],
  });
  assert.equal(engine.materialize(scenario).data.destinations.filter((d) => d.id === object.id).length, 1);
  assert.equal(
    engine.materialize({ ...base, design: { rules: DEFAULT_DESIGN_RULES, objects: [] } }).data.destinations
      .length,
    data.destinations.length,
  );
});

test('importance, park capacity, heat recommendations and relocation remain calculated on the real network', async () => {
  const importance = await engine.analyzeDesign({
    scenario: base,
    profileId: 'walk',
    kind: 'park',
    mode: 'importance',
  });
  assert.equal(
    importance.objects.reduce((sum, o) => sum + o.servedResidents, 0),
    importance.totals.reachableResidents,
  );
  for (const park of importance.objects) {
    assert.ok(park.capacity > 0);
    close(park.loadPercent, (park.servedResidents / park.capacity) * 100);
  }
  const needs = await engine.analyzeDesign({
    scenario: base,
    profileId: 'step_free',
    kind: 'bus_stop',
    mode: 'needs',
  });
  assert.equal(needs.top.length, 3);
  for (const candidate of needs.top) {
    const scenario = upsertObject(base, newObject('bus_stop', candidate.point, 'user_city_candidate'));
    const actual = await engine.analyzeDesign({
      scenario,
      profileId: 'step_free',
      kind: 'bus_stop',
      mode: 'importance',
    });
    assert.equal(actual.totals.withinResidents - needs.totals.withinResidents, candidate.gainResidents);
    close(needs.totals.meanDistanceM - actual.totals.meanDistanceM, candidate.meanReductionM);
  }
  const stop = data.destinations.find((d) => d.active && d.kind === 'bus_stop');
  const relocation = await engine.analyzeDesign({
    scenario: base,
    profileId: 'walk',
    kind: 'bus_stop',
    mode: 'relocation',
    objectId: stop.id,
    point: needs.top[0].point,
  });
  assert.equal(relocation.comparisons.length, 3);
  for (const row of relocation.comparisons) {
    assert.equal(
      row.change.improvedResidents + row.change.worsenedResidents + row.change.unchangedResidents,
      importance.totals.evaluatedResidents,
    );
    assert.equal(Math.round(row.costItems.reduce((s, item) => s + item.amountRub, 0)), row.costRub);
  }
});

test('scenario fingerprints keep the previous district usable and prevent mixing territories', async () => {
  const previous = await createPlanningEngine(await read('data/district.json'));
  assert.equal(previous.evaluate(base, ['walk']).profiles.walk.evaluatedPopulation, 8636);
  const old = previous.exportScenario(base),
    real = engine.exportScenario(base);
  assert.throws(() => engine.importScenario(old));
  assert.throws(() => previous.importScenario(real));
  assert.deepEqual(previous.importScenario(old), { ...base, operationalOverrides: [] });
});

test('project optimizer preserves free objects and prices on the curved real-city topology', async () => {
  const edge = data.edges.find((e) => e.active && e.kind !== 'crossing' && e.lengthM > 30),
    point = pointAlong(edge.geometry, edge.lengthM * 0.421);
  const scenario = upsertObject(base, newObject('community', point, 'user_opt_city'));
  const result = await engine.optimize({
    profileId: 'walk',
    metricId: 'park',
    budgetRub: 8000000,
    design: scenario.design,
    candidateProjectIds: ['oc_crossing_0', 'oc_green_0', 'oc_green_0_path'],
    topK: 3,
  });
  assert.ok(result.exact && result.alternatives.length > 0);
  for (const alternative of result.alternatives) {
    const evaluated = engine.evaluate({ ...scenario, projectIds: alternative.projectIds }, ['walk']);
    assert.equal(evaluated.costs.capexRub, alternative.costs.capexRub);
    assert.equal(
      evaluated.profiles.walk.destinations.park.withinThresholdResidents,
      alternative.metric.withinThresholdResidents,
    );
  }
});
