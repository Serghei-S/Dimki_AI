import {readFile} from 'node:fs/promises';
import {createPlanningEngine} from '../dist/engine.js';
const engine = await createPlanningEngine(await readFile(new URL('../data/district.json', import.meta.url), 'utf8'));
const scenario = engine.getDataset().scenarios.find(s => s.id === 'balanced');
const result = engine.evaluate(scenario, ['walk', 'step_free']);
console.table(Object.entries(result.profiles).map(([profileId, p]) => ({profileId,
  population: p.evaluatedPopulation, parkCoveragePercent: p.destinations.park.coveragePercent,
  stopCoveragePercent: p.destinations.bus_stop.coveragePercent, capexRub: result.costs.capexRub})));
const route = engine.route(scenario, 'step_free', 'building_b00_sw', 'park');
console.log('Route:', {distanceM: route.distanceM, travelSeconds: route.travelSeconds, destinationId: route.destinationId, edgeIds: route.edgeIds});
const started = performance.now();
const best = await engine.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000});
console.log('Exact optimization:', {milliseconds: Math.round(performance.now() - started), subsets: best.totalSubsets,
  feasible: best.feasibleSubsets, frontierSize: best.frontierSize});
console.table(best.alternatives.map((a, i) => ({rank: i + 1, projects: a.projectIds.join(', '),
  coveragePercent: a.metric.coveragePercent, capexRub: a.costs.capexRub, meanSeconds: a.metric.meanSecondsReachableOnly})));
