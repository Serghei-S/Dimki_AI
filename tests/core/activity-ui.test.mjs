import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createPlanningEngine } from '../../dist/engine.js';

await mkdir(new URL('../../.tools/generated/', import.meta.url), { recursive: true });
await build({
  stdin: {
    contents: `export {ActivityPanel} from './src/app/ActivityPanel.tsx'; export {EnvironmentSummary} from './src/app/EnvironmentSummary.tsx'; export {useActivity} from './src/app/useActivity.ts';`,
    resolveDir: process.cwd(),
  },
  outfile: '.tools/generated/activity-ui-test.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
});
const { ActivityPanel, EnvironmentSummary, useActivity } =
  await import('../../.tools/generated/activity-ui-test.mjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data),
  scenario = { projectIds: [], budgetRub: 8000000 };
const result = engine.evaluate(scenario, ['walk']);
const analysis = {
  profileId: 'walk',
  metricId: 'park',
  scenario,
  result,
  baseline: result,
  district: data,
  routes: [],
  loads: engine.edgeLoads(scenario, 'walk', 'park'),
};
const text = (node) => (typeof node === 'string' ? node : (node?.children?.map(text).join('') ?? ''));
const pause = () => new Promise((r) => setTimeout(r, 100));

test('real environment and activity components render measured model values and expose working time/day controls offline', async () => {
  const noop = () => {};
  const html = renderToStaticMarkup(
    React.createElement(EnvironmentSummary, {
      analysis,
      busy: false,
      onMetric: noop,
      onCompare: noop,
    }),
  );
  for (const label of [
    'Индекс близости',
    '54,4',
    '1\u00a0855',
    'Жители с трудным доступом',
    'Что означают показатели',
    'До / 100',
    'После / 100',
  ])
    assert.ok(html.includes(label), label);
  let hour = null,
    day = null,
    root;
  await act(async () => {
    root = create(
      React.createElement(ActivityPanel, {
        value: engine.activitySnapshot(scenario, 'walk', { hour: 8, dayType: 'weekday' }),
        hour: 8,
        dayType: 'weekday',
        busy: false,
        error: null,
        onHour: (v) => (hour = v),
        onDay: (v) => (day = v),
      }),
    );
  });
  try {
    const button = root.root.findAllByType('button').find((b) => text(b) === 'Вечер');
    await act(async () => button.props.onClick());
    assert.equal(hour, 18);
    await act(async () => root.root.findByType('select').props.onChange({ target: { value: 'weekend' } }));
    assert.equal(day, 'weekend');
    assert.ok(text(root.toJSON()).includes('Учёба'));
    assert.ok(text(root.toJSON()).includes('Домой / ч'));
  } finally {
    await act(async () => root.unmount());
  }
});

test('time, profile and scenario changes hide stale flows and an old Worker reply cannot restore the previous hour', async () => {
  const requests = [];
  const client = {
    activitySnapshot: (s, p, options, signal) =>
      new Promise((resolve) => requests.push({ s, p, options, signal, resolve })),
  };
  let latest, root;
  function Harness({ hour = 8, profile = 'walk', value = scenario }) {
    latest = useActivity(client, value, profile, hour, 'weekday', true);
    return null;
  }
  await act(async () => {
    root = create(React.createElement(Harness));
  });
  await act(pause);
  try {
    assert.equal(requests.length, 1);
    const first = requests[0];
    await act(async () => root.update(React.createElement(Harness, { hour: 18 })));
    assert.equal(latest.snapshot, null);
    assert.equal(first.signal.aborted, true);
    await act(pause);
    const evening = requests[1];
    await act(async () =>
      first.resolve(
        engine.activitySnapshot(scenario, 'walk', { hour: 8, dayType: 'weekday', includeRoutes: true }),
      ),
    );
    assert.equal(latest.snapshot, null);
    await act(async () =>
      evening.resolve(
        engine.activitySnapshot(scenario, 'walk', { hour: 18, dayType: 'weekday', includeRoutes: true }),
      ),
    );
    assert.equal(latest.snapshot.hour, 18);
    await act(async () => root.update(React.createElement(Harness, { hour: 18, profile: 'step_free' })));
    assert.equal(latest.snapshot, null);
    await act(pause);
    await act(async () =>
      requests[2].resolve(
        engine.activitySnapshot(scenario, 'step_free', { hour: 18, dayType: 'weekday', includeRoutes: true }),
      ),
    );
    assert.equal(latest.snapshot.profileId, 'step_free');
    await act(async () =>
      root.update(React.createElement(Harness, { hour: 18, profile: 'step_free', value: { ...scenario } })),
    );
    assert.equal(latest.snapshot, null);
  } finally {
    await act(async () => root.unmount());
  }
});
