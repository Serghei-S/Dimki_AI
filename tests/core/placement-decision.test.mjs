import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import {
  createPlanningEngine,
  newObject,
  DEFAULT_DESIGN_RULES,
  placementDecision,
} from '../../dist/engine.js';

const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data);
const base = { projectIds: [], budgetRub: 12000000 };
// The residential entrance with the longest existing approach gives an independently chosen improvement.
const homes = data.buildings
  .filter((b) => b.population)
  .map((b) => ({
    home: b,
    route: engine.route(base, 'walk', b.id, 'bus_stop'),
  }))
  .filter((b) => b.route.travelSeconds !== null)
  .sort((a, b) => b.route.travelSeconds - a.route.travelSeconds);
const point = data.nodes.find((n) => n.id === homes[0].home.entranceNodeIds[0]).xy;
const after = {
  ...base,
  design: { rules: { ...DEFAULT_DESIGN_RULES }, objects: [newObject('bus_stop', point, 'user_test_stop')] },
};
async function calculate(before, next, profileId = 'walk') {
  return engine.analyzeDesign({
    scenario: before,
    profileId,
    kind: 'bus_stop',
    mode: 'compare',
    scenarios: [
      { name: 'До', scenario: before },
      { name: 'После', scenario: next },
    ],
  });
}
test('a stop without a bus line improves pedestrian access while hourly transport demand stays unchanged', async () => {
  const comparison = await calculate(base, after);
  const verdict = placementDecision(
    comparison,
    engine.evaluate(base).profiles.walk,
    engine.evaluate(after).profiles.walk,
    true,
  );
  assert.ok(verdict.improved > 0);
  assert.ok(verdict.metrics[0].after < verdict.metrics[0].before);
  assert.ok(verdict.metrics.length >= 4);
  const oldRows = new Map(comparison.comparisons[0].rows.map((r) => [r.buildingId, r]));
  const independentlyCounted = comparison.comparisons[1].rows.reduce(
    (sum, r) => sum + (r.distanceM < oldRows.get(r.buildingId).distanceM - 1e-8 ? r.residents : 0),
    0,
  );
  assert.equal(verdict.improved, independentlyCounted);
  assert.match(verdict.minus.join(' '), /нет известной автобусной линии/);
  assert.match(verdict.conclusion, /пока нельзя признать оптимальным/);
  for (const dayType of ['weekday', 'weekend'])
    for (const hour of [8, 18]) {
      const b = engine.activitySnapshot(base, 'walk', { hour, dayType });
      const a = engine.activitySnapshot(after, 'walk', { hour, dayType });
      assert.equal(a.servedTrips, b.servedTrips);
    }
});
test('unchanged and reversed placements do not invent a benefit or call a worse place optimal', async () => {
  const unchanged = placementDecision(await calculate(after, after));
  assert.equal(unchanged.improved, 0);
  assert.equal(unchanged.gained, 0);
  assert.match(unchanged.conclusion, /не даёт улучшения/);
  const removed = placementDecision(await calculate(after, base));
  assert.ok(removed.worsened > 0);
  assert.equal(removed.improved, 0);
  assert.match(removed.conclusion, /Оптимальность не подтверждена/);
  assert.equal(removed.metrics[0].before, unchanged.metrics[0].after);
});

await mkdir('.tools/generated', { recursive: true });
await build({
  entryPoints: ['src/app/PlacementDecisionPanel.tsx'],
  outfile: '.tools/generated/placement-decision-ui.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
});
const { PlacementDecisionPanel } = await import('../../.tools/generated/placement-decision-ui.mjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const pause = () => new Promise((r) => setTimeout(r, 130));
test('preview shows a table and verdict immediately and ignores late results after moving the object', async () => {
  const pending = [];
  const client = {
    analyzeDesign: (input) => new Promise((resolve) => pending.push({ input, resolve })),
    evaluate: async (scenario, profiles) => engine.evaluate(scenario, profiles),
  };
  const props = { client, before: base, after, kind: 'bus_stop', profileId: 'walk', preview: true };
  let view;
  try {
    await act(async () => {
      view = create(React.createElement(PlacementDecisionPanel, props));
    });
    await act(pause);
    assert.equal(pending.length, 1);
    await act(async () => {
      pending[0].resolve(await engine.analyzeDesign(pending[0].input));
    });
    assert.ok(view.root.findAllByType('table').length);
    assert.ok(view.root.findAllByType('tr').length >= 3);
    assert.match(JSON.stringify(view.toJSON()), /Вывод/);
    assert.match(JSON.stringify(view.toJSON()), /СанПиН/);
    await act(async () => {
      view.update(React.createElement(PlacementDecisionPanel, { ...props, after: structuredClone(after), preview: false }));
    });
    assert.match(JSON.stringify(view.toJSON()), /результат размещения/);
    assert.equal(view.root.findAllByType('table').length, 1);
    // New calculation must hide the old verdict while the selected place changes.
    await act(async () => {
      view.update(React.createElement(PlacementDecisionPanel, { ...props, after: base }));
    });
    await act(pause);
    assert.equal(view.root.findAllByType('table').length, 0);
    await act(async () => {
      view.update(React.createElement(PlacementDecisionPanel, { ...props, profileId: 'step_free' }));
    });
    await act(pause);
    await act(async () => {
      pending[1].resolve(await engine.analyzeDesign(pending[1].input));
    });
    assert.equal(view.root.findAllByType('table').length, 0);
    await act(async () => {
      pending[2].resolve(await engine.analyzeDesign(pending[2].input));
    });
    assert.equal(view.root.findAllByType('table').length, 1);
  } finally {
    await act(async () => view?.unmount());
  }
});
