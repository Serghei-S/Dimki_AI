import {readFile} from 'node:fs/promises';
import {createPlanningEngine} from '../dist/engine.js';
import {scaleDataset} from './scale-dataset.mjs';
const base = JSON.parse(await readFile(new URL('../data/district.json', import.meta.url), 'utf8'));
const rows = [];
for (const copies of [1, 25, 100]) {
  const data = copies === 1 ? base : scaleDataset(base, copies), start = performance.now();
  const engine = await createPlanningEngine(data), loaded = performance.now();
  const report = engine.evaluate({projectIds: [], budgetRub: 0}); const cold = performance.now();
  engine.evaluate({projectIds: [], budgetRub: 0}); const warm = performance.now();
  const routeStart = performance.now();
  engine.route({projectIds: [], budgetRub: 0}, 'walk', copies === 1 ? 'building_b00_sw' : 'tile0_building_b00_sw', 'park');
  rows.push({copies, nodes: data.nodes.length, edges: data.edges.length, residents: report.profiles.walk.evaluatedPopulation,
    loadMs: Math.round(loaded - start), threeProfilesColdMs: Math.round(cold - loaded), threeProfilesWarmMs: Math.round(warm - cold),
    routeMs: Math.round(performance.now() - routeStart), cacheMiB: +(engine.cacheStats().estimatedBytes / 2 ** 20).toFixed(2)});
}
console.table(rows);
