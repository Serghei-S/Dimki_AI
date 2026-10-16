import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPlanningEngine,
  newObject,
  objectFromDestination,
  pointAlong,
  DEFAULT_DESIGN_RULES,
} from '../../dist/engine.js';

const city = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(city);
const base = { projectIds: [], budgetRub: 12000000 };
const scenario = (...objects) => ({ ...base, design: { objects, rules: { ...DEFAULT_DESIGN_RULES } } });
const path = city.edges.find(
  (e) => e.active && e.kind === 'sidewalk' && e.lengthM > 35 && !e.stairs && e.widthM >= 2,
);
const location = pointAlong(path.geometry, path.lengthM * 0.37183);
const close = (a, b, epsilon = 0.0011) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);

// Independent label-correcting oracle, including entry restrictions and service seed costs.
// It does not use the engine topology, Dijkstra, ownership or aggregate methods.
function oracle(data, profile, kind, levels = null) {
  const times = new Map(data.nodes.map((n) => [n.id, Infinity]));
  const active = new Set(data.nodes.filter((n) => n.active).map((n) => n.id));
  for (const d of data.destinations.filter((d) => d.active && d.kind === kind)) {
    const initial = levels ? [450, 300, 150][levels.get(d.id) ?? 0] : 0;
    for (const node of d.accessNodeIds)
      if (active.has(node)) times.set(node, Math.min(times.get(node), initial));
  }
  for (let pass = 0; pass < data.nodes.length; pass++) {
    let changed = false;
    for (const e of data.edges) {
      if (
        !e.active ||
        !active.has(e.from) ||
        !active.has(e.to) ||
        (e.stairs && !profile.allowStairs) ||
        Math.abs(e.slope) > profile.maxSlope ||
        e.widthM < profile.minWidthM ||
        (e.crossing && profile.requiresKerbRamps && !e.crossing.kerbRamps) ||
        !(profile.surfaceSpeedFactors[e.surface] > 0)
      )
        continue;
      const cost =
        e.lengthM / (profile.speedMps * profile.surfaceSpeedFactors[e.surface]) +
        (e.crossing?.waitSeconds ?? 0);
      for (const [from, to] of e.bidirectional
        ? [
            [e.from, e.to],
            [e.to, e.from],
          ]
        : [[e.from, e.to]]) {
        if (times.get(to) + cost < times.get(from) - 1e-9) {
          times.set(from, times.get(to) + cost);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return data.buildings
    .filter((b) => b.population)
    .map((b) => ({
      id: b.id,
      population: b.population.total,
      seconds: Math.min(...b.entranceNodeIds.map((n) => times.get(n))),
    }));
}

test('real-city arbitrary placement recalculates all five criteria and every building against an independent time oracle', () => {
  for (const kind of ['bus_stop', 'school', 'clinic', 'grocery', 'park']) {
    const object = newObject(kind, location, `user_audit_${kind}`);
    // The park test audits a proposed access point; no new through-path can change other categories.
    object.autoEntrances = false;
    const s = scenario(object),
      district = engine.materialize(s).data,
      result = engine.evaluate(s);
    for (const profile of city.profiles) {
      const report = result.profiles[profile.id];
      for (const metric of engine.getMetrics()) {
        const expected = oracle(district, profile, metric.id);
        for (const row of expected) {
          const actual = report.perBuilding.find((b) => b.buildingId === row.id).destinations[metric.id];
          if (!Number.isFinite(row.seconds)) assert.equal(actual.travelSeconds, null);
          else close(actual.travelSeconds, row.seconds);
          assert.equal(actual.withinThreshold, row.seconds <= metric.thresholdSeconds + 1e-9);
        }
        const reachable = expected.filter((r) => Number.isFinite(r.seconds));
        const count = reachable.reduce((sum, r) => sum + r.population, 0);
        const totals = report.destinations[metric.id];
        assert.equal(totals.reachableResidents, count);
        if (count)
          close(
            totals.meanSecondsReachableOnly,
            reachable.reduce((sum, r) => sum + r.seconds * r.population, 0) / count,
          );
        const catchments = report.serviceCatchments[metric.id];
        assert.equal(
          catchments.reduce((sum, c) => sum + c.assignedResidents, 0),
          count,
        );
        assert.equal(
          catchments.reduce((sum, c) => sum + c.withinThresholdResidents, 0),
          totals.withinThresholdResidents,
        );
      }
    }
    assert.deepEqual(city, engine.getDataset(), 'edits must not change source data');
  }
});

test('effective capacity is consistent in materialization, map snapshots and importance; capacity alone does not shorten paths', async () => {
  for (const kind of ['school', 'clinic', 'grocery', 'bus_stop']) {
    const object = { ...newObject(kind, location, `user_capacity_${kind}`), capacity: 701, level: 2 };
    const a = scenario(object),
      b = scenario({ ...object, capacity: 901 });
    const snapA = engine.mapSnapshot(a, 'walk', kind),
      snapB = engine.mapSnapshot(b, 'walk', kind);
    const effective = Math.floor(701 * 1.5);
    assert.equal(engine.materialize(a).data.destinations.find((d) => d.id === object.id).capacity, effective);
    assert.equal(
      snapA.result.profiles.walk.serviceCatchments[kind].find((c) => c.objectId === object.id)
        .effectiveCapacity,
      effective,
    );
    const importance = await engine.analyzeDesign({
      scenario: a,
      profileId: 'walk',
      kind,
      mode: 'importance',
    });
    assert.equal(importance.objects.find((o) => o.id === object.id).capacity, effective);
    assert.deepEqual(snapA.result.profiles.walk.destinations, snapB.result.profiles.walk.destinations);
    assert.deepEqual(snapA.loads, snapB.loads);
    assert.ok(snapB.result.costs.capexRub > snapA.result.costs.capexRub);
  }
});

test('park area norm updates untouched existing parks in the main report and matches importance', async () => {
  const s = { ...base, design: { objects: [], rules: { ...DEFAULT_DESIGN_RULES, parkM2PerVisitor: 20 } } };
  const district = engine.materialize(s).data,
    report = engine.evaluate(s, ['walk']).profiles.walk;
  const analysis = await engine.analyzeDesign({
    scenario: s,
    profileId: 'walk',
    kind: 'park',
    mode: 'importance',
  });
  for (const d of district.destinations.filter((d) => d.active && d.kind === 'park')) {
    const parcel = district.parcels.find((p) => p.id === d.parcelId);
    assert.equal(d.capacity, Math.floor(parcel.areaM2 / 20));
    assert.equal(
      report.serviceCatchments.park.find((c) => c.objectId === d.id).effectiveCapacity,
      d.capacity,
    );
    assert.equal(analysis.objects.find((o) => o.id === d.id).capacity, d.capacity);
  }
});

test('moving or upgrading stops preserves actual route IDs; newly proposed stops do not invent services', () => {
  const original = city.destinations.find((d) => d.active && d.kind === 'bus_stop');
  const object = { ...objectFromDestination(city, original.id), entrances: [location], level: 2 };
  const a = engine.materialize(scenario(object)).data;
  assert.deepEqual(a.destinations.find((d) => d.id === original.id).routeIds, original.routeIds);
  assert.deepEqual(
    a.stopBays.find((b) => b.id === a.destinations.find((d) => d.id === original.id).stopBayId).routeIds,
    original.routeIds,
  );
  const proposed = newObject('bus_stop', location, 'user_unserved_stop');
  const b = engine.materialize(scenario(proposed)).data;
  assert.deepEqual(b.destinations.find((d) => d.id === proposed.id).routeIds, []);
});

test('hypothetical walk plus wait uses the fastest eligible service path, including co-located stops', async () => {
  const stopA = { ...newObject('bus_stop', location, 'user_wait_a'), level: 0 };
  const stopB = { ...newObject('bus_stop', location, 'user_wait_b'), level: 2 };
  const s = scenario(stopA, stopB),
    data = engine.materialize(s).data;
  for (const profile of city.profiles) {
    const result = await engine.analyzeDesign({
      scenario: s,
      profileId: profile.id,
      kind: 'bus_stop',
      mode: 'importance',
    });
    const rows = oracle(
      data,
      profile,
      'bus_stop',
      new Map([
        [stopA.id, 0],
        [stopB.id, 2],
      ]),
    );
    const reachable = rows.filter((r) => Number.isFinite(r.seconds));
    close(
      result.totals.meanServiceSeconds,
      reachable.reduce((sum, r) => sum + r.seconds * r.population, 0) /
        reachable.reduce((sum, r) => sum + r.population, 0),
    );
  }
});

test('a park entrance cannot silently attach to a remote street outside its territory', async () => {
  const synthetic = JSON.parse(await readFile(new URL('../../data/district.json', import.meta.url), 'utf8'));
  const e = await createPlanningEngine(synthetic);
  const park = {
    ...newObject('park', [80, 16], 'user_remote_entrance'),
    autoEntrances: false,
    polygon: [
      [40, 16],
      [100, 16],
      [100, 46],
      [40, 46],
      [40, 16],
    ],
    entrances: [[160, 16]],
  };
  assert.throws(
    () => e.materialize(scenario(park)),
    (err) => err.code === 'INVALID_SCENARIO' && /Вход парка/.test(err.message),
  );
  assert.doesNotThrow(() => e.materialize(scenario({ ...park, entrances: [[100, 16]] })));
  const acrossRoad = {
    ...park,
    polygon: [
      [334, 30],
      [374, 30],
      [374, 70],
      [334, 70],
      [334, 30],
    ],
    entrances: [[304, 50]],
  };
  const proposed = scenario(acrossRoad);
  proposed.design.rules.entranceGapM = 40;
  assert.throws(
    () => e.materialize(proposed),
    (err) => err.code === 'INVALID_SCENARIO' && /через дорогу/.test(err.message),
  );
});

test('removal, relocation, undo and repeated evaluation conserve populations and do not accumulate old cuts', () => {
  const object = newObject('school', location, 'user_roundtrip');
  const a = scenario(object),
    moved = scenario({ ...object, entrances: [pointAlong(path.geometry, path.lengthM * 0.78351)] });
  const first = engine.mapSnapshot(a, 'walk', 'school');
  engine.mapSnapshot(moved, 'walk', 'school');
  const removed = engine.evaluate(scenario({ ...object, active: false }), ['walk']);
  assert.deepEqual(
    removed.profiles.walk.destinations,
    engine.evaluate(base, ['walk']).profiles.walk.destinations,
  );
  assert.deepEqual(engine.mapSnapshot(a, 'walk', 'school'), first);
  assert.deepEqual(engine.materialize(base).data, city);
  const report = first.result.profiles.walk,
    changes = first.result.changesFromBaseline.walk;
  for (const [kind, totals] of Object.entries(report.destinations)) {
    assert.equal(totals.reachableResidents + totals.unreachableResidents, report.evaluatedPopulation);
    assert.equal(
      changes[kind].improvedResidents + changes[kind].worsenedResidents + changes[kind].unchangedResidents,
      report.evaluatedPopulation,
    );
  }
});
