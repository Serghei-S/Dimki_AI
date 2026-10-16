import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPlanningEngine, compileTopology, buildRoutingGraph, shortestToTargets, edgeTravelSeconds, compareMetrics} from '../../dist/engine.js';
import {scaleDataset} from '../../examples/scale-dataset.mjs';

const text = await readFile(new URL('../../data/district.json', import.meta.url), 'utf8');
const data = JSON.parse(text);
const base = {projectIds: [], budgetRub: 8000000};
const engine = await createPlanningEngine(text);
function matches(actual, expected, path = '$') {
  if (typeof expected === 'number') {
    if (/Residents$|Population$|residents$|Rub$/.test(path)) assert.equal(actual, expected, path);
    else assert.ok(Math.abs(actual - expected) <= .002, `${path}: ${actual} != ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, path); expected.forEach((v, i) => matches(actual[i], v, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    for (const [key, value] of Object.entries(expected)) matches(actual[key], value, `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}
const errorCode = code => error => error?.code === code;

test('all 18 saved scenario/profile calculations and comparisons match Python reports', async () => {
  const oracle = JSON.parse(await readFile(new URL('../../data/reports/scenario-comparison.json', import.meta.url), 'utf8'));
  for (const scenario of data.scenarios) {
    const expected = oracle.find(x => x.scenarioId === scenario.id), actual = engine.evaluate(scenario);
    matches(actual.costs, expected.costs);
    matches(actual.profiles, expected.metrics, scenario.id);
    matches(actual.changesFromBaseline, expected.changesFromBaseline, `${scenario.id}.changes`);
  }
});

test('every reported home route has the right time, edge direction, geometry, length and destination', () => {
  const evaluation = engine.evaluate(base);
  for (const profile of data.profiles) for (const building of data.buildings.filter(b => b.population)) for (const kind of ['bus_stop', 'park', 'school', 'clinic', 'grocery']) {
    const route = engine.route(base, profile.id, building.id, kind);
    const stats = evaluation.profiles[profile.id].perBuilding.find(b => b.buildingId === building.id).destinations[kind];
    assert.equal(route.travelSeconds, stats.travelSeconds);
    assert.equal(route.nodeIds[0], route.entranceNodeId);
    assert.equal(route.nodeIds.at(-1), route.destinationAccessNodeId);
    const destination = data.destinations.find(d => d.id === route.destinationId);
    assert.ok(destination.active && destination.kind === kind && destination.accessNodeIds.includes(route.destinationAccessNodeId));
    let seconds = 0, length = 0, wait = 0;
    route.edgeIds.forEach((id, i) => {
      const edge = data.edges.find(e => e.id === id);
      assert.ok(edge.active);
      assert.ok((edge.from === route.nodeIds[i] && edge.to === route.nodeIds[i + 1]) || (edge.bidirectional && edge.to === route.nodeIds[i] && edge.from === route.nodeIds[i + 1]));
      const value = edgeTravelSeconds(edge, profile); assert.notEqual(value, null);
      seconds += value; length += edge.lengthM; wait += edge.crossing?.waitSeconds ?? 0;
    });
    assert.ok(Math.abs(route.travelSeconds - seconds) <= .001);
    assert.ok(Math.abs(route.distanceM - length) <= .001);
    assert.ok(Math.abs(route.waitingSeconds - wait) <= .001);
    assert.ok(Math.abs(route.walkingSeconds + route.waitingSeconds - route.travelSeconds) <= .002);
    assert.equal(route.geojson.geometry.type, 'LineString');
    assert.ok(route.geojson.geometry.coordinates.every(([lon, lat]) => lon > 36 && lon < 37 && lat > 55 && lat < 56));
  }
});

test('random directed graph Dijkstra agrees with an independent Bellman-Ford oracle', () => {
  let seed = 2040;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const graphData = {nodes: Array.from({length: 100}, (_, i) => ({id: `n${String(i).padStart(3, '0')}`, xy: [i, 0], active: true})), edges: []};
  const pairs = new Set();
  for (let i = 0; i < 600; i++) {
    const from = Math.floor(random() * 99), to = Math.floor(random() * 99);
    if (from === to || pairs.has(`${from}-${to}`)) continue;
    pairs.add(`${from}-${to}`);
    graphData.edges.push({id: `e${i}`, from: graphData.nodes[from].id, to: graphData.nodes[to].id,
      active: true, lengthM: Math.floor(random() * 200) + 1, bidirectional: random() < .3,
      stairs: false, widthM: 2, slope: 0, surface: 'asphalt', crossing: null});
  }
  const profile = {...data.profiles[0], speedMps: 1}, topology = compileTopology(graphData), graph = buildRoutingGraph(topology, graphData, profile);
  const targets = [0, 17, 65], result = shortestToTargets(graph, targets);
  const distances = Array(100).fill(Infinity); targets.forEach(i => distances[i] = 0);
  for (let pass = 0; pass < 99; pass++) {
    let changed = false;
    for (const edge of graphData.edges) {
      const from = topology.nodeIndex.get(edge.from), to = topology.nodeIndex.get(edge.to);
      if (distances[to] + edge.lengthM < distances[from]) {distances[from] = distances[to] + edge.lengthM; changed = true;}
      if (edge.bidirectional && distances[from] + edge.lengthM < distances[to]) {distances[to] = distances[from] + edge.lengthM; changed = true;}
    }
    if (!changed) break;
  }
  distances.forEach((value, i) => assert.equal(result.distances[i], value));
  assert.equal(result.distances[99], Infinity);
});

test('profile restrictions include exact slope and width boundaries and crossing wait', () => {
  const profile = data.profiles.find(p => p.id === 'step_free');
  const edge = {...data.edges.find(e => e.crossing?.kerbRamps), lengthM: 85, widthM: 1.5, slope: .05, stairs: false, surface: 'asphalt',
    crossing: {...data.edges.find(e => e.crossing?.kerbRamps).crossing, waitSeconds: 12}};
  assert.equal(edgeTravelSeconds(edge, profile), 112);
  for (const change of [{stairs: true}, {widthM: 1.499}, {slope: .05001}, {crossing: {...edge.crossing, kerbRamps: false}}])
    assert.equal(edgeTravelSeconds({...edge, ...change}, profile), null);
});

test('disconnected home stays in coverage denominator and has null route data', () => {
  const home = data.buildings.find(b => b.population), entrances = new Set(home.entranceNodeIds);
  const overrides = data.edges.filter(e => entrances.has(e.from) || entrances.has(e.to)).map(e => ({op: 'set_edge_active', targetId: e.id, value: false}));
  const scenario = {...base, operationalOverrides: overrides}, report = engine.evaluate(scenario, ['walk']).profiles.walk;
  for (const totals of Object.values(report.destinations)) assert.equal(totals.unreachableResidents, home.population.total);
  const route = engine.route(scenario, 'walk', home.id, 'park');
  assert.equal(route.reachable, false); assert.equal(route.travelSeconds, null); assert.deepEqual(route.edgeIds, []); assert.equal(route.geojson.geometry, null);
  assert.ok(!JSON.stringify(report).includes('NaN'));
});

test('metric registry supports additional destinations, demographic weights and threshold equality', async () => {
  const custom = await createPlanningEngine(data, {metrics: [{id: 'children_school', destinationKinds: ['school'], thresholdSeconds: 600, populationGroup: 'under18'},
    {id: 'services', destinationKinds: ['grocery', 'community'], thresholdSeconds: 900, populationGroup: 'all'}]});
  const report = custom.evaluate(base, ['walk']).profiles.walk;
  assert.equal(report.destinations.children_school.evaluatedPopulation, data.buildings.reduce((sum, b) => sum + (b.population?.ageGroups.under18 ?? 0), 0));
  assert.ok(report.destinations.services.coveragePercent > 0);
  const home = data.buildings.find(b => b.population);
  const route = engine.route(base, 'walk', home.id, 'park');
  const profile = data.profiles[0], time = route.edgeIds.reduce((sum, id) => sum + edgeTravelSeconds(data.edges.find(e => e.id === id), profile), 0);
  const exact = await createPlanningEngine(data, {metrics: [{id: 'boundary', destinationKinds: ['park'], thresholdSeconds: time, populationGroup: 'all'}]});
  assert.equal(exact.evaluate(base, ['walk']).profiles.walk.perBuilding.find(b => b.buildingId === home.id).destinations.boundary.withinThreshold, true);
});

test('zero demographic population is represented without division by zero', async () => {
  const modified = structuredClone(data);
  for (const b of modified.buildings) if (b.population) b.population.mobilityNeedsResidents = 0;
  const custom = await createPlanningEngine(modified, {metrics: [{id: 'mobility_park', destinationKinds: ['park'], thresholdSeconds: 600, populationGroup: 'mobilityNeeds'}]});
  const totals = custom.evaluate(base, ['walk']).profiles.walk.destinations.mobility_park;
  assert.equal(totals.evaluatedPopulation, 0); assert.equal(totals.coveragePercent, null); assert.equal(totals.meanSecondsReachableOnly, null);
});

test('new movement profiles are data-driven and duplicate IDs are rejected', async () => {
  const slow = {...data.profiles[0], id: 'custom_slow', speedMps: .6};
  const custom = await createPlanningEngine(data, {additionalProfiles: [slow]});
  assert.ok(custom.evaluate(base, ['custom_slow']).profiles.custom_slow.destinations.park.meanSecondsReachableOnly > engine.evaluate(base, ['walk']).profiles.walk.destinations.park.meanSecondsReachableOnly);
  await assert.rejects(createPlanningEngine(data, {additionalProfiles: [data.profiles[0]]}), errorCode('INVALID_INPUT'));
});

test('base and cached results cannot be changed by callers', () => {
  const original = engine.evaluate(base, ['walk']);
  assert.throws(() => engine.getDataset().edges[0].lengthM = 0, TypeError);
  assert.throws(() => original.profiles.walk.perBuilding[0].residents = 0, TypeError);
  const route = engine.route(base, 'walk', data.buildings.find(b => b.population).id, 'park');
  route.edgeIds.length = 0;
  assert.ok(engine.route(base, 'walk', data.buildings.find(b => b.population).id, 'park').edgeIds.length > 0);
});

test('cache is bounded and warm entries never bypass budget checks', async () => {
  const local = await createPlanningEngine(data, {cacheMaxEntries: 2, cacheMaxBytes: 1000000});
  for (const scenario of data.scenarios) local.evaluate(scenario, ['walk']);
  assert.ok(local.cacheStats().entries <= 2); assert.ok(local.cacheStats().estimatedBytes <= 1000000);
  local.evaluate({projectIds: ['p_park_b10'], budgetRub: 8000000}, ['walk']);
  assert.throws(() => local.evaluate({projectIds: ['p_park_b10'], budgetRub: 0}, ['walk']), errorCode('BUDGET_EXCEEDED'));
  local.clearCache(); assert.equal(local.cacheStats().entries, 0);
});

test('project order, dependencies, conflicts, unknown IDs and unsafe operations are rejected', () => {
  for (const [scenario, code] of [
    [{projectIds: ['p_park_paving'], budgetRub: 8000000}, 'DEPENDENCY_ERROR'],
    [{projectIds: ['p_stop_north', 'p_stop_south'], budgetRub: 8000000}, 'PROJECT_CONFLICT'],
    [{projectIds: ['missing'], budgetRub: 8000000}, 'UNKNOWN_ID'],
    [{...base, operationalOverrides: [{op: 'set_edge_active', targetId: 'cross_v2_r0_n', value: true}]}, 'INVALID_SCENARIO'],
    [{...base, operationalOverrides: [{op: 'upgrade_edge', targetId: 'b00_arm_n', changes: {stairs: false}}]}, 'INVALID_SCENARIO'],
    [{...base, budgetRub: -1}, 'INVALID_INPUT']]) assert.throws(() => engine.evaluate(scenario), errorCode(code));
  assert.deepEqual(engine.resolveProjects(['p_park_paving']), ['p_park_b10', 'p_park_paving']);
});

test('scenario envelopes bind to canonical dataset content and version', async () => {
  const envelope = engine.exportScenario(data.scenarios.find(s => s.id === 'balanced'));
  assert.equal(engine.importScenario(JSON.stringify(envelope)).projectIds.length, 6);
  assert.throws(() => engine.importScenario({...envelope, datasetVersion: 'other'}), errorCode('DATASET_MISMATCH'));
  const reordered = await createPlanningEngine(JSON.stringify(data, null, 4));
  assert.equal(reordered.datasetSha256, engine.datasetSha256);
  const changed = structuredClone(data); changed.metadata.description += ' changed';
  const different = await createPlanningEngine(changed);
  assert.throws(() => different.importScenario(envelope), errorCode('DATASET_MISMATCH'));
});

test('dataset shape, references and population corruption fail before calculations', async () => {
  for (const mutate of [d => d.nodes[0].id = d.nodes[1].id, d => d.edges[0].from = 'missing',
    d => d.buildings.find(b => b.population).population.total++, d => d.edges[0].lengthM = NaN,
    d => d.projects[0].requires.push(d.projects[0].id)]) {
    const changed = structuredClone(data); mutate(changed);
    await assert.rejects(createPlanningEngine(changed), errorCode('INVALID_DATASET'));
  }
});

test('network coloring uses the same routes and thresholds as building reports', () => {
  const access = new Map(engine.networkAccess(base, 'step_free', 'park').map(n => [n.nodeId, n]));
  for (const building of data.buildings.filter(b => b.population)) {
    const route = engine.route(base, 'step_free', building.id, 'park');
    assert.equal(access.get(route.entranceNodeId).travelSeconds, route.travelSeconds);
  }
});

test('exact optimizer matches the independently generated Python exhaustive-search oracle', {timeout: 60000}, async () => {
  const oracle = JSON.parse(await readFile(new URL('./fixtures/optimizer-oracle.json', import.meta.url), 'utf8'));
  assert.equal(oracle.datasetFileSha256, createHash('sha256').update(text).digest('hex'));
  for (const reference of oracle.cases) {
    const result = await engine.optimize(reference.input);
    assert.equal(result.exact, true); assert.equal(result.processedSubsets, reference.totalSubsets); assert.equal(result.feasibleSubsets, reference.feasibleSubsets);
    assert.equal(result.frontierSize, reference.frontierSize);
    assert.equal(result.alternatives.length, reference.alternatives.length);
    result.alternatives.forEach((alternative, i) => {
      assert.deepEqual([...alternative.projectIds].sort(), reference.alternatives[i].projectIds);
      matches(alternative.score, reference.alternatives[i].score);
      assert.ok(alternative.costs.capexRub <= reference.input.budgetRub);
    });
  }
});

test('optimizer handles required projects, dependency expansion, zero budget and candidate limit', async () => {
  const dependency = await engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000, candidateProjectIds: ['p_park_paving'], requiredProjectIds: ['p_park_paving']});
  assert.deepEqual(dependency.candidateProjectIds, ['p_park_b10', 'p_park_paving']);
  assert.deepEqual(dependency.alternatives[0].projectIds, ['p_park_b10', 'p_park_paving']);
  const zero = await engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 0});
  assert.deepEqual(zero.alternatives[0].projectIds, []); assert.equal(zero.feasibleSubsets, 1);
  await assert.rejects(engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000, maxCandidates: 2}), errorCode('SEARCH_LIMIT'));
  await assert.rejects(engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 1, requiredProjectIds: ['p_park_b10']}), errorCode('BUDGET_EXCEEDED'));
  await assert.rejects(engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000, maxFrontierSize: 1}), errorCode('SEARCH_LIMIT'));
});

test('no active destination has null average and zero coverage', async () => {
  const modified = structuredClone(data); modified.destinations.filter(d => d.kind === 'park').forEach(d => d.active = false);
  const local = await createPlanningEngine(modified), result = local.evaluate(base, ['walk']).profiles.walk;
  assert.equal(result.destinations.park.meanSecondsReachableOnly, null); assert.equal(result.destinations.park.coveragePercent, 0);
  assert.equal(local.route(base, 'walk', data.buildings.find(b => b.population).id, 'park').reachable, false);
});

test('map changes are complete absolute changes relative to baseline, including new park land use', () => {
  const scenario = {projectIds: ['p_park_b10', 'p_park_paving', 'p_stop_north'], budgetRub: 8000000};
  const changed = engine.materialize(scenario).data, result = engine.evaluate(scenario, ['walk']);
  const reconstructed = {...data};
  for (const key of ['nodes', 'edges', 'destinations', 'parcels']) {
    const delta = new Map(result.districtChanges[key].map(record => [record.id, record]));
    reconstructed[key] = data[key].map(record => delta.get(record.id) ?? record);
    assert.deepEqual(reconstructed[key], changed[key]);
  }
  assert.equal(result.datasetSha256, engine.datasetSha256);
  assert.equal(result.districtChanges.parcels[0].kind, 'public_park');
});

test('undeclared catalogue overwrites are rejected before they can corrupt a cache key', async () => {
  const modified = structuredClone(data);
  modified.projects.filter(p => ['p_stop_north', 'p_stop_south'].includes(p.id)).forEach(p => p.exclusiveGroup = null);
  await assert.rejects(createPlanningEngine(modified), errorCode('INVALID_DATASET'));
});

test('optimization cancellation yields to the event loop and leaves engine usable', async () => {
  const controller = new AbortController(); let progress = 0;
  const promise = engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000}, {
    signal: controller.signal, yieldEvery: 1, onProgress: p => {progress = p.processedSubsets; if (p.processedSubsets >= 2) controller.abort();}});
  await assert.rejects(promise, errorCode('CANCELLED')); assert.ok(progress >= 2 && progress < 4096);
  assert.ok(engine.evaluate(base, ['walk']).profiles.walk.evaluatedPopulation > 0);
});

test('population comparison rejects mismatched cohorts and metric sets', () => {
  const before = structuredClone(engine.evaluate(base, ['walk']).profiles.walk), after = structuredClone(before);
  after.perBuilding[0].residents++;
  assert.throws(() => compareMetrics(before, after), errorCode('INVALID_INPUT'));
});

test('scaled independent districts preserve per-person metrics and sum populations correctly', async () => {
  const scaled = await createPlanningEngine(scaleDataset(data, 25), {cacheMaxBytes: 10000000});
  const original = engine.evaluate(base), result = scaled.evaluate(base);
  for (const profile of data.profiles) {
    assert.equal(result.profiles[profile.id].evaluatedPopulation, original.profiles[profile.id].evaluatedPopulation * 25);
    for (const [kind, totals] of Object.entries(original.profiles[profile.id].destinations)) {
      assert.equal(result.profiles[profile.id].destinations[kind].coveragePercent, totals.coveragePercent);
      assert.ok(Math.abs(result.profiles[profile.id].destinations[kind].meanSecondsReachableOnly - totals.meanSecondsReachableOnly) <= .001);
    }
  }
  assert.ok(scaled.cacheStats().estimatedBytes <= 10000000);
});
