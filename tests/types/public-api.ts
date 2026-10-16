// Type-only consumer contract: emitted declarations are not executed as tests.
import { createPlanningEngine, compareMetrics, EngineWorkerClient } from '../../src/core/index.js';
const engine = await createPlanningEngine({});
const baseline = engine.evaluate({projectIds: [], budgetRub: 8000000});
const coordinatePair: readonly [number, number] = engine.getDataset().nodes[0]!.xy;
void coordinatePair;
engine.evaluate(engine.getDataset().scenarios[0]!);
compareMetrics(baseline.profiles['walk']!, baseline.profiles['walk']!);
// @ts-expect-error budget is a number, not text
engine.evaluate({projectIds: [], budgetRub: '8000000'});
// @ts-expect-error immutable dataset cannot be changed by a frontend
engine.getDataset().edges.push({});
// @ts-expect-error cached calculation results are immutable
baseline.profiles['walk']!.evaluatedPopulation = 0;
// @ts-expect-error required optimizer objective is missing
void engine.optimize({budgetRub: 8000000});
const client = new EngineWorkerClient({} as Worker);
void client.init(engine.getDataset());
void client.evaluate(engine.getDataset().scenarios[0]!);
