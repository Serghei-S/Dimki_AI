import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlanningEngine } from '../../dist/engine.js';
import {
  createMotionPaths,
  sampleMotion,
  initialScenario,
  selectProjects,
  scenarioHistory,
  applyDistrictChanges,
  sampleHomes,
  SpatialIndex,
} from '../../dist/map-logic.js';

const data = JSON.parse(await readFile(new URL('../../data/district.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data);
const base = initialScenario(),
  homes = sampleHomes(data);

test('spatial decoration index matches exhaustive lookup across negative coordinates and cell boundaries', () => {
  const index = new SpatialIndex(16),
    entries = Array.from({ length: 100 }, (_, i) => ({
      minX: i * 3 - 150,
      minY: (i % 17) - 9,
      maxX: i * 3 - 119,
      maxY: (i % 17) + 24,
    }));
  entries.forEach((box, i) => index.add(box, i));
  for (let x = -160; x < 200; x += 7)
    for (let y = -30; y < 60; y += 5) {
      assert.deepEqual(
        index.at(x, y),
        entries.flatMap((b, i) => (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY ? [i] : [])),
      );
    }
});

test('batch routes equal individual routes, reject duplicate and oversized requests', () => {
  for (const profile of data.profiles) {
    const routes = engine.routes(base, profile.id, homes, 'park');
    routes.forEach((route, i) => assert.deepEqual(route, engine.route(base, profile.id, homes[i], 'park')));
  }
  assert.throws(() => engine.routes(base, 'walk', [], 'park'));
  assert.throws(() => engine.routes(base, 'walk', [homes[0], homes[0]], 'park'));
  assert.throws(() =>
    engine.routes(
      base,
      'walk',
      Array.from({ length: 1025 }, (_, i) => `home${i}`),
      'park',
    ),
  );
});

test('animation follows oriented eligible edges and exactly preserves walking and waiting durations', () => {
  for (const scenario of [base, ...data.scenarios])
    for (const profile of data.profiles) {
      const evaluation = engine.evaluate(scenario, [profile.id]);
      const district = applyDistrictChanges(data, evaluation.districtChanges);
      const routes = engine.routes(scenario, profile.id, homes, 'park');
      const paths = createMotionPaths(district, profile, routes);
      for (const path of paths) {
        const route = routes.find((r) => r.buildingId === path.buildingId);
        assert.ok(Math.abs(path.travelSeconds - route.travelSeconds) < 0.001);
        assert.ok(
          Math.abs(path.legs.reduce((sum, l) => sum + l.waitSeconds, 0) - route.waitingSeconds) < 0.001,
        );
        path.legs.forEach((leg, i) => {
          const node = district.nodes.find((n) => n.id === route.nodeIds[i]);
          assert.deepEqual(leg.points[0], node.xy);
          if (leg.waitSeconds) {
            const waiting = sampleMotion(path, leg.startSeconds + leg.waitSeconds / 2);
            assert.equal(waiting.walking, false);
            assert.equal(waiting.x, node.xy[0]);
            assert.equal(waiting.y, node.xy[1]);
          }
          const moving = sampleMotion(path, leg.startSeconds + leg.waitSeconds + leg.walkingSeconds / 2);
          assert.equal(moving.walking, true);
          assert.ok(Number.isFinite(moving.x) && Number.isFinite(moving.heading));
        });
        assert.equal(sampleMotion(path, path.travelSeconds + 10).visible, 0);
        assert.deepEqual(sampleMotion(path, 15), sampleMotion(path, path.cycleSeconds + 15));
      }
    }
});

test('motion samples reuse output buffers and reject a forbidden direction', () => {
  const routes = engine.routes(base, 'walk', homes, 'park'),
    paths = createMotionPaths(data, data.profiles[0], routes);
  const out = {};
  assert.equal(sampleMotion(paths[0], 10, out), out);
  const invalid = structuredClone(routes[0]);
  invalid.nodeIds[0] = 'wrong';
  assert.throws(() => createMotionPaths(data, data.profiles[0], [invalid]), /direction mismatch/);
});

test('project selection resolves dependencies, exclusions and budgets without mutating history', () => {
  const large = { ...base, budgetRub: 30000000 };
  const paving = selectProjects(data, large, 'p_park_paving');
  assert.ok(paving.projectIds.indexOf('p_park_b10') < paving.projectIds.indexOf('p_park_paving'));
  assert.deepEqual(selectProjects(data, paving, 'p_park_b10').projectIds, []);
  const north = selectProjects(data, large, 'p_stop_north');
  const south = selectProjects(data, north, 'p_stop_south');
  assert.ok(!south.projectIds.includes('p_stop_north') && south.projectIds.includes('p_stop_south'));
  assert.throws(() => selectProjects(data, { ...base, budgetRub: 1 }, 'p_park_paving'), /бюджета/);
  assert.deepEqual(base.projectIds, []);
  const applied = scenarioHistory(
    { current: base, past: [], future: [] },
    { type: 'apply', scenario: north },
  );
  const undone = scenarioHistory(applied, { type: 'undo' });
  assert.deepEqual(undone.current, base);
  assert.deepEqual(scenarioHistory(undone, { type: 'redo' }).current, north);
});

test('absolute map snapshots restore base geometry when projects are removed', () => {
  const changed = engine.evaluate({ projectIds: ['p_park_b10'], budgetRub: 30000000 });
  const improved = applyDistrictChanges(data, changed.districtChanges);
  assert.notDeepEqual(improved.parcels, data.parcels);
  const restored = applyDistrictChanges(data, engine.evaluate(base).districtChanges);
  assert.deepEqual(restored.parcels, data.parcels);
  assert.deepEqual(restored.edges, data.edges);
  assert.notEqual(improved, data);
});
