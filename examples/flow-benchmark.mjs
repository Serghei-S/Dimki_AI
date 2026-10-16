import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createPlanningEngine } from '../dist/engine.js';
import { scaleDataset } from './scale-dataset.mjs';
const source = JSON.parse(await readFile(new URL('../data/district.json', import.meta.url), 'utf8'));
const scenario = { projectIds: [], budgetRub: 0 },
  rows = [];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const copies of [1, 25, 100]) {
  const data = copies === 1 ? source : scaleDataset(source, copies),
    engine = await createPlanningEngine(data),
    homes = data.buildings.filter((b) => b.population),
    weights = new Map(homes.map((b) => [b.id, b.population.total]));
  const start = performance.now();
  const cold = engine.mapSnapshot(scenario, 'walk', 'park');
  const coldMs = performance.now() - start;
  const quiet = [],
    routeSums = [];
  for (let i = 0; i < 7; i++) {
    let tick = performance.now();
    engine.mapSnapshot(scenario, 'walk', 'park');
    quiet.push(performance.now() - tick);
    tick = performance.now();
    const sums = new Map();
    for (let j = 0; j < homes.length; j += 1024)
      for (const route of engine.routes(
        scenario,
        'walk',
        homes.slice(j, j + 1024).map((b) => b.id),
        'park',
      ))
        for (const id of route.edgeIds) sums.set(id, (sums.get(id) ?? 0) + weights.get(route.buildingId));
    routeSums.push(performance.now() - tick);
  }
  rows.push({
    nodes: data.nodes.length,
    edges: data.edges.length,
    homes: homes.length,
    coldSnapshotMs: +coldMs.toFixed(2),
    warmSnapshotMedianMs: +median(quiet).toFixed(2),
    explicitRoutesMedianMs: +median(routeSums).toFixed(2),
    residents: cold.loads.assignedResidents,
  });
}
console.table(rows);
await mkdir('data/reports', { recursive: true });
await writeFile(
  'data/reports/flow-performance.json',
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      method: '7 sequential warm runs; median; Node, no GPU or Worker transport included',
      rows,
    },
    null,
    2,
  ) + '\n',
);
