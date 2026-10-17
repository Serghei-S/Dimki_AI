import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import {
  createPlanningEngine,
  ACTIVITY_RULES,
  accessDiagnostics,
  scheduledFraction,
  edgeTravelSeconds,
  createWorkerRuntime,
} from '../../dist/engine.js';
import {
  createActivityMotionPaths,
  sampleMotion,
  flowStyle,
  accessibilityColor,
  ACCESS_COLORS,
} from '../../dist/map-logic.js';

// Inspect scheduling events independently of Worker transport, without a browser.
await mkdir(new URL('../../.tools/generated/', import.meta.url), { recursive: true });
await build({
  stdin: {
    contents: "export { planDailyActivity } from './src/core/daily-activity.ts';",
    resolveDir: process.cwd(),
  },
  outfile: '.tools/generated/activity-test.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { planDailyActivity } = await import('../../.tools/generated/activity-test.mjs');
const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data),
  base = { projectIds: [], budgetRub: 8000000 };
const at = (
  hour,
  dayType = 'weekday',
  includeRoutes = true,
  profile = 'walk',
  local = engine,
  scenario = base,
) => local.activitySnapshot(scenario, profile, { hour, dayType, includeRoutes });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const purpose = (value, id) => value.purposes.find((p) => p.id === id);
const population = data.buildings.filter((b) => b.population).map((b) => b.population);

test('continuous proximity exposes long paths without falsifying threshold coverage; P90 is weighted by residents', () => {
  const report = engine.evaluate(base, ['walk']).profiles.walk,
    quality = accessDiagnostics(report);
  assert.equal(report.destinations.park.coveragePercent, 100);
  assert.ok(quality.score > 50 && quality.score < 60);
  assert.equal(quality.problemResidents, 1855);
  const school = quality.categories.find((c) => c.id === 'school');
  assert.ok(school.score < 30 && school.longResidents > 1500);
  for (const category of quality.categories) {
    const all = report.perBuilding
      .flatMap((h) =>
        Array(h.destinations[category.id].evaluatedResidents).fill(
          h.destinations[category.id].travelSeconds ?? Infinity,
        ),
      )
      .sort((a, b) => a - b);
    const oracle = all[Math.ceil(0.9 * all.length) - 1];
    assert.equal(category.p90Seconds, Number.isFinite(oracle) ? oracle : null);
  }
  const improved = structuredClone(report);
  for (const h of improved.perBuilding)
    for (const d of Object.values(h.destinations)) if (d.travelSeconds !== null) d.travelSeconds *= 0.5;
  assert.ok(accessDiagnostics(improved).score > quality.score);
  // Input is never edited by diagnostics.
  assert.deepEqual(engine.evaluate(base, ['walk']).profiles.walk, report);
});

test('proximity handles unreachable residents, zero thresholds, empty groups, and counts problematic homes once', () => {
  const fixture = {
    destinations: {
      a: { thresholdSeconds: 100, unreachableResidents: 20 },
      b: { thresholdSeconds: 100, unreachableResidents: 20 },
    },
    perBuilding: [
      {
        residents: 80,
        destinations: {
          a: { evaluatedResidents: 80, travelSeconds: 20 },
          b: { evaluatedResidents: 80, travelSeconds: 90 },
        },
      },
      {
        residents: 20,
        destinations: {
          a: { evaluatedResidents: 20, travelSeconds: null },
          b: { evaluatedResidents: 20, travelSeconds: null },
        },
      },
    ],
  };
  const d = accessDiagnostics(fixture);
  assert.equal(d.categories[0].score, 64);
  assert.equal(d.categories[0].p90Seconds, null);
  assert.equal(d.problemResidents, 100);
  const empty = structuredClone(fixture);
  for (const h of empty.perBuilding) {
    h.residents = 0;
    for (const m of Object.values(h.destinations)) m.evaluatedResidents = 0;
  }
  assert.equal(accessDiagnostics(empty).score, null);
  assert.equal(accessDiagnostics(empty).categories[0].p90Seconds, null);
  const zero = {
    destinations: { a: { thresholdSeconds: 0, unreachableResidents: 0 } },
    perBuilding: [{ residents: 1, destinations: { a: { travelSeconds: 0, evaluatedResidents: 1 } } }],
  };
  assert.equal(accessDiagnostics(zero).score, 100);
  assert.notEqual(accessibilityColor(90, 100), accessibilityColor(20, 100));
  assert.equal(accessibilityColor(90, 100), ACCESS_COLORS[3]);
  assert.equal(accessibilityColor(null, 100), ACCESS_COLORS[4]);
});

test('uniform schedules conserve departures over all 24 hours, including midnight and exact boundaries', () => {
  for (const [start, end] of [
    [7.25, 8.5],
    [23.75, 24.5],
    [-0.5, 0.25],
    [9, 10],
    [0, 24],
  ]) {
    close(
      Array.from({ length: 24 }, (_, h) => scheduledFraction(start, end, h, h + 1)).reduce(
        (s, n) => s + n,
        0,
      ),
      1,
    );
  }
  assert.equal(scheduledFraction(7, 8, 8, 9), 0);
  assert.equal(scheduledFraction(7, 7, 7, 8), 0);
});

test('weekday schools attract pupils in the morning and return them in the afternoon; work returns in the evening', () => {
  const morning = at(8),
    afternoon = at(14),
    evening = at(18),
    night = at(23);
  assert.ok(purpose(morning, 'school').outbound > 0);
  assert.equal(purpose(morning, 'school').homeward, 0);
  assert.equal(purpose(afternoon, 'school').outbound, 0);
  assert.ok(purpose(afternoon, 'school').homeward > 0);
  assert.equal(purpose(evening, 'school').outbound, 0);
  assert.equal(purpose(evening, 'school').homeward, 0);
  assert.ok(purpose(morning, 'work').outbound > purpose(evening, 'work').outbound);
  assert.ok(purpose(evening, 'work').homeward > purpose(morning, 'work').homeward);
  assert.equal(night.expectedOnNetwork, 0);
  assert.equal(night.routes.length, 0);
  assert.ok(morning.expectedOnNetwork < morning.population * 0.1);
  assert.ok(morning.expectedOnNetwork > 0);
});

test('cohort participation and round trips conserve the expected daily number; weekends have no ordinary school commute', () => {
  for (const day of ['weekday', 'weekend']) {
    const values = Array.from({ length: 24 }, (_, h) => at(h, day, false));
    const total = (id, d) => values.reduce((sum, v) => sum + purpose(v, id)[d], 0);
    const students =
      day === 'weekday'
        ? population.reduce((s, p) => s + p.ageGroups.under18, 0) *
          ACTIVITY_RULES.schoolAgeShareOfUnder18 *
          ACTIVITY_RULES.schoolAttendance
        : 0;
    const workers =
      population.reduce((s, p) => s + p.ageGroups.age18to64, 0) *
      ACTIVITY_RULES.employedAdultShare *
      (day === 'weekday' ? 1 : ACTIVITY_RULES.weekendWorkShare);
    close(total('school', 'outbound'), students);
    close(total('school', 'homeward'), students);
    close(total('work', 'outbound'), workers);
    close(total('work', 'homeward'), workers);
    for (const rates of Object.values(ACTIVITY_RULES.discretionary))
      assert.ok(
        Object.entries(rates).reduce(
          (s, [p, n]) => s + n * (day === 'weekday' ? 1 : ACTIVITY_RULES.weekendVisitMultipliers[p]),
          0,
        ) <= 1,
      );
    for (const v of values) {
      close(v.plannedTrips, v.servedTrips + v.unservedTrips);
      close(
        v.expectedOnNetwork,
        v.purposes.reduce((s, p) => s + p.onNetwork, 0),
      );
      assert.ok(v.expectedOnNetwork <= v.population);
    }
  }
});

test('hourly directional edge loads match independent interval integration, actual travel costs and midnight spillovers', () => {
  const profile = data.profiles.find((p) => p.id === 'walk'),
    plan = planDailyActivity(data, profile, 'weekday');
  const edges = new Map(data.edges.map((e) => [e.id, e]));
  const fraction = (event, a, b) => {
    let sum = 0;
    for (let shift = -48; shift <= 48; shift += 24)
      sum += Math.max(0, Math.min(b, event.end + shift) - Math.max(a, event.start + shift));
    return sum / (event.end - event.start);
  };
  for (let h = 0; h < 24; h++) {
    const oracle = new Map(data.edges.map((e) => [e.id, { forward: 0, backward: 0 }]));
    let occupancy = 0;
    for (const event of plan.events) {
      if (!event.route) continue;
      occupancy += event.count * fraction(event, h + 0.5 - event.route.travelSeconds / 3600, h + 0.5);
      let offset = 0;
      event.route.edgeIds.forEach((id, i) => {
        const e = edges.get(id),
          direction = e.from === event.route.nodeIds[i] ? 'forward' : 'backward';
        oracle.get(id)[direction] += event.count * fraction(event, h - offset, h + 1 - offset);
        offset += edgeTravelSeconds(e, profile) / 3600;
      });
      close(offset * 3600, event.route.travelSeconds);
    }
    const value = at(h);
    close(value.expectedOnNetwork, occupancy);
    for (const row of value.loads.edges) {
      close(row.forward, oracle.get(row.edgeId).forward);
      close(row.backward, oracle.get(row.edgeId).backward);
      close(row.load, row.forward + row.backward);
      if (!row.eligible) assert.equal(row.load, 0);
    }
  }
});

test('every activity route follows the directed accessible graph; animation uses the same path, time and occupancy weight', () => {
  for (const profile of data.profiles) {
    const edges = new Map(data.edges.map((e) => [e.id, e]));
    for (const hour of [7, 8, 14, 18, 20]) {
      const value = at(hour, 'weekday', true, profile.id);
      const paths = createActivityMotionPaths(data, profile, value.routes);
      assert.equal(paths.length, value.routes.length);
      value.routes.forEach((trip, i) => {
        let seconds = 0;
        trip.route.edgeIds.forEach((id, j) => {
          const edge = edges.get(id),
            from = trip.route.nodeIds[j],
            to = trip.route.nodeIds[j + 1];
          assert.ok(edge.active);
          assert.ok(
            (edge.from === from && edge.to === to) ||
              (edge.bidirectional && edge.to === from && edge.from === to),
          );
          const time = edgeTravelSeconds(edge, profile);
          assert.notEqual(time, null);
          seconds += time;
        });
        close(seconds, trip.route.travelSeconds);
        close(paths[i].travelSeconds, seconds);
        close(paths[i].residents, trip.expectedOnNetwork);
        assert.equal(paths[i].cycleSeconds, paths[i].travelSeconds);
        const start = sampleMotion(paths[i], 0);
        close(start.x, trip.route.geometry[0][0]);
        close(start.y, trip.route.geometry[0][1]);
        const home = data.buildings.find((b) => b.id === trip.route.buildingId);
        assert.ok(
          home.entranceNodeIds.includes(
            trip.direction === 'homeward' ? trip.route.nodeIds.at(-1) : trip.route.nodeIds[0],
          ),
        );
      });
    }
  }
});

test('closed or missing facilities do not generate phantom visits or phantom return flows', async () => {
  const missing = structuredClone(data);
  missing.destinations.forEach((d) => (d.active = false));
  const local = await createPlanningEngine(missing);
  const plan = planDailyActivity(missing, missing.profiles[0], 'weekday');
  assert.ok(plan.events.length > 0);
  assert.ok(plan.events.every((e) => e.route === null && e.direction === 'outbound'));
  for (const hour of [8, 14, 18, 20]) {
    const v = at(hour, 'weekday', true, 'walk', local);
    assert.equal(v.servedTrips, 0);
    assert.equal(v.expectedOnNetwork, 0);
    assert.equal(v.loads.maxLoad, 0);
  }
  const closed = structuredClone(data);
  closed.destinations.filter((d) => d.kind === 'grocery').forEach((d) => (d.openingHours = '00:00-01:00'));
  const closedEngine = await createPlanningEngine(closed);
  for (const hour of [10, 11, 20, 21]) {
    const v = at(hour, 'weekday', true, 'walk', closedEngine);
    assert.equal(purpose(v, 'shopping').outbound, 0);
    assert.equal(purpose(v, 'shopping').homeward, 0);
    assert(!v.routes.some((r) => r.purpose === 'shopping'));
  }
  assert.ok(purpose(at(20, 'weekday', true, 'walk', closedEngine), 'shopping').unserved > 0);
});

test('one-way returns are routed separately and closures remove traffic without modifying population', async () => {
  const directed = structuredClone(data);
  directed.edges.forEach((e) => (e.bidirectional = false));
  const local = await createPlanningEngine(directed);
  const plan = planDailyActivity(directed, directed.profiles[0], 'weekday');
  assert.ok(plan.events.some((e) => e.direction === 'homeward' && !e.route));
  for (const event of plan.events.filter((e) => e.route))
    event.route.edgeIds.forEach((id, i) => {
      const edge = directed.edges.find((e) => e.id === id);
      assert.equal(edge.from, event.route.nodeIds[i]);
      assert.equal(edge.to, event.route.nodeIds[i + 1]);
    });
  const operationalOverrides = data.edges
    .filter((e) => e.active)
    .map((e) => ({ op: 'set_edge_active', targetId: e.id, value: false }));
  const blocked = at(8, 'weekday', true, 'walk', engine, { ...base, operationalOverrides });
  assert.equal(blocked.population, 3692);
  assert.equal(blocked.expectedOnNetwork, 0);
  assert.equal(blocked.loads.maxLoad, 0);
});

test('only stops with known service can be work gateways; rendering switches cannot change calculated flow', async () => {
  const changed = structuredClone(data);
  changed.destinations.filter((d) => d.kind === 'bus_stop').forEach((d) => (d.routeIds = []));
  const local = await createPlanningEngine(changed);
  const v = at(8, 'weekday', true, 'walk', local);
  assert.ok(purpose(v, 'work').unserved > 0);
  assert(!v.routes.some((r) => changed.destinations.find((d) => d.id === r.objectId)?.kind === 'bus_stop'));
  const hidden = at(8, 'weekday', false),
    visible = at(8);
  assert.equal(hidden.routes.length, 0);
  assert.deepEqual(hidden.loads, visible.loads);
  assert.equal(hidden.expectedOnNetwork, visible.expectedOnNetwork);
  assert.equal(flowStyle(150, ACTIVITY_RULES.flowDisplayScale).ratio, 0.5);
  const before = engine.evaluate(base, ['walk']);
  at(18);
  at(23, 'weekend');
  assert.deepEqual(engine.evaluate(base, ['walk']), before);
});

test('activity cache preserves scenario validation, invalid inputs fail and caller mutations cannot poison results', () => {
  for (const options of [
    { hour: -1, dayType: 'weekday' },
    { hour: 24, dayType: 'weekday' },
    { hour: 8.5, dayType: 'weekday' },
    { hour: 8, dayType: 'holiday' },
    { hour: 8, dayType: 'weekday', includeRoutes: 'yes' },
  ])
    assert.throws(() => engine.activitySnapshot(base, 'walk', options));
  assert.throws(() => at(8, 'weekday', true, 'unknown'));
  const v = at(8);
  assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(v.loads.edges));
  assert.throws(() => {
    v.loads.edges[0].load = 999;
  });
  const scenario = data.scenarios.find((s) => s.projectIds.length);
  at(8, 'weekday', false, 'walk', engine, scenario);
  assert.throws(() => at(8, 'weekday', false, 'walk', engine, { ...scenario, budgetRub: 0 }));
});

test('Worker activity messages enforce hour/day/routes contracts and reconcile transport results', async () => {
  const messages = [],
    runtime = createWorkerRuntime((m) => messages.push(m));
  await runtime.handle({ type: 'init', requestId: 'init-activity', dataset: data });
  await runtime.handle({
    type: 'activity_snapshot',
    requestId: 'day',
    scenario: base,
    profileId: 'walk',
    options: { hour: 8, dayType: 'weekday', includeRoutes: true },
  });
  assert.equal(messages.at(-1).type, 'result');
  assert.deepEqual(messages.at(-1).result, at(8));
  await runtime.handle({
    type: 'activity_snapshot',
    requestId: 'invalid-hour',
    scenario: base,
    profileId: 'walk',
    options: { hour: 24, dayType: 'weekday' },
  });
  assert.equal(messages.at(-1).type, 'error');
  assert.equal(messages.at(-1).error.code, 'INVALID_INPUT');
  runtime.dispose();
});
