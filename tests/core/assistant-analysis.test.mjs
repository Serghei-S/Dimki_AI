import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPlanningEngine,
  newObject,
  relocateWithContext,
  DEFAULT_DESIGN_RULES,
} from '../../dist/engine.js';
import { aiContext } from '../../dist/report.js';
import { calculateReport, parseNarrative } from '../../scripts/assistant-api.mjs';
import { placementIntent } from '../../scripts/assistant-analysis.mjs';

const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data);
const input = {
  datasetId: engine.datasetId,
  datasetSha256: engine.datasetSha256,
  profileId: 'walk',
  scenario: { projectIds: [], budgetRub: 8000000 },
  question: 'Найди место для наилучшего расположения магазина по твоему мнению',
  mode: 'summary',
};

test('location intent does not replace risk, explanation, or need questions with a construction search', () => {
  for (const question of [
    'Найди риски магазина',
    'Почему показатель стал лучше?',
    'Нужен ли ещё магазин?',
    'Кому стало хуже?',
    'Объясни результат',
  ])
    assert.equal(placementIntent(question, input.scenario), null);
  for (const question of ['Где лучше поставить остановку?', 'Подбери место для школы', input.question])
    assert(placementIntent(question, input.scenario)?.kind);
  assert(placementIntent('Где построить магазин или школу?', input.scenario).clarification);
  assert(placementIntent('Где лучше сделать парк?', input.scenario).clarification);
  assert.equal(placementIntent('Где лучше расположить парковку?', input.scenario).kind, 'parking');
});

test('search ranks real feasible sites and reconciles winning effects against an independent scenario calculation', async () => {
  const before = structuredClone(input);
  const report = await calculateReport(input);
  assert.deepEqual(input, before);
  const result = report.locationAnalysis;
  assert.equal(result.status, 'ready');
  assert(result.checked > result.alternatives.length);
  assert.equal(result.alternatives.length, 4);
  const best = result.alternatives.find((a) => a.id === result.bestId);
  assert(best.point);
  assert(best.improvedResidents > 0);
  assert(best.improvedHomes > 0);
  const obj = relocateWithContext(data, newObject('grocery', best.point, 'user_test_search'), best.point);
  const scenario = { ...input.scenario, design: { rules: { ...DEFAULT_DESIGN_RULES }, objects: [obj] } };
  const comparison = await engine.analyzeDesign({
    mode: 'compare',
    kind: 'grocery',
    scenario: input.scenario,
    profileId: 'walk',
    scenarios: [
      { name: 'До', scenario: input.scenario },
      { name: 'После', scenario },
    ],
  });
  const after = comparison.comparisons[1];
  assert.equal(best.withinResidents, after.totals.withinResidents);
  assert.equal(best.meanDistanceM, after.totals.meanDistanceM);
  assert.equal(best.improvedResidents, after.change.improvedResidents);
  assert.equal(best.addedCostRub, engine.evaluate(scenario, ['walk']).costs.capexRub);
  assert.equal(
    report.facts.find((f) => f.id === 'housing.children').value,
    data.buildings.reduce((sum, h) => sum + (h.population?.ageGroups.under18 ?? 0), 0),
  );
  assert.equal(report.facts.find((f) => f.id === 'supply.grocery.capacity').value, null);
  assert.equal(new Set(report.facts.map((f) => f.id)).size, report.facts.length);
  const external = aiContext(report);
  for (const a of external.locationAnalysis.alternatives) {
    assert(!('point' in a));
    assert(!('location' in a));
  }
  assert(!('buildings' in external));
  const narrative = {
    selectedAlternativeId: best.id,
    findings: [
      {
        title: best.label,
        text: 'Лучший из проверенных вариантов по охвату и сокращению пути.',
        evidenceIds: [`location.${best.id}.improvedResidents`],
      },
    ],
    recommendations: [
      {
        title: 'Выбрать это место',
        text: 'Проверить участок на местности.',
        evidenceIds: [`location.${best.id}.addedCostRub`],
      },
    ],
    limitations: ['Население модельное.'],
  };
  assert(parseNarrative(JSON.stringify(narrative), report.facts, result));
  assert.throws(() =>
    parseNarrative(JSON.stringify({ ...narrative, selectedAlternativeId: 'invented' }), report.facts, result),
  );
  narrative.findings[0].evidenceIds = ['capex'];
  assert.throws(() => parseNarrative(JSON.stringify(narrative), report.facts, result));

  // A different walking speed affects the time, without making up a new population.
  const slow = await calculateReport({ ...input, profileId: 'slow_walk' });
  assert.equal(
    slow.facts.find((f) => f.id === 'housing.homes').value,
    report.facts.find((f) => f.id === 'housing.homes').value,
  );
  assert(
    slow.locationAnalysis.alternatives.find((a) => a.id === slow.locationAnalysis.bestId).meanMinutes >
      best.meanMinutes,
  );

  // A search on a scenario with a newly placed store relocates that store, not a duplicate.
  const replacement = await calculateReport({ ...input, scenario });
  assert.match(replacement.locationAnalysis.scope, /вашего нового объекта/);
  const current = replacement.locationAnalysis.alternatives.find((a) => a.id === 'current');
  assert.equal(current.withinResidents, best.withinResidents);
  assert.equal(
    replacement.locationAnalysis.alternatives.find((a) => a.id === 'unchanged').withinResidents,
    comparison.comparisons[0].totals.withinResidents,
  );
  assert(replacement.locationAnalysis.alternatives.every((a) => a.addedCostRub <= best.addedCostRub));
});

test('insufficient budget keeps no-build option; ambiguous questions and cancelled searches do not invent locations', async () => {
  const report = await calculateReport({ ...input, scenario: { ...input.scenario, budgetRub: 0 } });
  assert.equal(report.locationAnalysis.bestId, 'unchanged');
  assert.equal(report.locationAnalysis.alternatives.length, 1);
  const ambiguous = await calculateReport({ ...input, question: 'Где лучше поставить объект?' });
  assert.equal(ambiguous.locationAnalysis.status, 'clarification');
  assert.equal(ambiguous.locationAnalysis.bestId, null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(calculateReport(input, { signal: controller.signal }), { name: 'AbortError' });
});
