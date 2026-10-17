import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { create } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPlanningEngine, pointAlong } from '../../dist/engine.js';
import { suggestPlacement } from '../../dist/map-logic.js';

// Exercise the real React component and effects, without a browser or WebGL.
await mkdir(new URL('../../.tools/generated/', import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('../../src/app/DesignWorkbench.tsx', import.meta.url))],
  outfile: fileURLToPath(new URL('../../.tools/generated/editor-launch-test.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
});
const { DesignWorkbench } = await import('../../.tools/generated/editor-launch-test.mjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data);
const text = (node) => (typeof node === 'string' ? node : node.children.map(text).join(''));
const button = (root, label) => {
  const found = root.root.findAllByType('button').find((b) => text(b) === label);
  assert(found, `Missing button: ${label}`);
  return found;
};
async function editor(t, launch = 0) {
  const events = { current: null },
    observed = { view: null, preview: null, applied: [], focused: 0, scrolled: 0 };
  const noop = () => {};
  const onView = (view) => {
    observed.view = view;
  };
  function Harness({ launch, active }) {
    const [scenario, setScenario] = useState({ projectIds: [], budgetRub: 8000000 });
    const [selectedId, onSelect] = useState(null);
    return React.createElement(DesignWorkbench, {
      active,
      launch,
      client: { evaluate: async (input, ids) => engine.evaluate(input, ids) },
      baseData: data,
      district: data,
      analysis: null,
      calculationBusy: false,
      calculationError: null,
      baselineView: false,
      onKindChange: noop,
      onProfileChange: noop,
      scenario,
      profileId: 'walk',
      selectedId,
      saved: [],
      onSelect,
      onApply: (input) => {
        observed.applied.push(input);
        setScenario(input);
      },
      onPreview: (input) => {
        observed.preview = input;
      },
      onView,
      onNotify: noop,
      events,
      onFocus: noop,
      onCompare: noop,
    });
  }
  let currentLaunch = launch;
  const render = (value, active = true) =>
    React.createElement(React.StrictMode, null, React.createElement(Harness, { launch: value, active }));
  let root;
  await act(async () => {
    root = create(render(launch), {
      createNodeMock: () => ({
        scrollIntoView: () => {
          observed.scrolled++;
        },
        focus: () => {
          observed.focused++;
        },
      }),
    });
  });
  t.after(async () => {
    await act(async () => root.unmount());
  });
  return {
    root,
    observed,
    events,
    launch: async (next) => {
      currentLaunch = next;
      await act(async () => root.update(render(next)));
    },
    show: async (active) => {
      await act(async () => root.update(render(currentLaunch, active)));
    },
  };
}

test('New object arms placement when the editor is already open and returns from another panel', async (t) => {
  const e = await editor(t);
  assert.equal(e.observed.view.tool, 'select');
  await e.launch(1);
  assert.equal(e.observed.view.tool, 'place');
  assert.equal(e.observed.view.kind, 'bus_stop');
  assert(e.observed.scrolled > 0);
  assert(e.observed.focused > 0);
  await act(async () => button(e.root, 'Анализ').props.onClick());
  assert.equal(e.observed.view.tool, 'select');
  await e.launch(2);
  assert.equal(e.observed.view.tool, 'place');
  assert.equal(button(e.root, 'Разместить').props['aria-pressed'], true);
});
test('reopening the editor does not repeat an already handled New object request', async (t) => {
  const e = await editor(t, 1);
  assert.equal(e.observed.view.tool, 'place');
  await e.show(false);
  await e.show(true);
  assert.equal(e.observed.view.tool, 'select');
  await e.launch(2);
  assert.equal(e.observed.view.tool, 'place');
});

test('New object retains park type, activates polygon drawing and cancellation restores selection', async (t) => {
  const e = await editor(t);
  await act(async () => button(e.root, 'Парк / сквер').props.onClick());
  await e.launch(1);
  assert.equal(e.observed.view.tool, 'polygon');
  await act(async () => e.events.current.point([10, 20]));
  assert.deepEqual(e.observed.view.polygon, [[10, 20]]);
  await act(async () => e.events.current.cancel());
  assert.equal(e.observed.view.tool, 'select');
  assert.deepEqual(e.observed.view.polygon, []);
});

test('Map click after New object creates a preview and requires confirmation before applying', async (t) => {
  const e = await editor(t, 1);
  let point;
  for (const edge of data.edges.filter((edge) => edge.active && edge.kind === 'sidewalk')) {
    try {
      point = suggestPlacement(data, 'bus_stop', pointAlong(edge.geometry, edge.lengthM / 2)).point;
      break;
    } catch {
      /* Try next actual sidewalk. */
    }
  }
  assert(point);
  await act(async () => e.events.current.point(point));
  assert.equal(e.observed.preview.design.objects.length, 1);
  assert.equal(e.observed.applied.length, 0);
  assert.equal(button(e.root, 'Применить объект').props.disabled, false);
  await act(async () => {
    button(e.root, 'Применить объект').props.onClick();
  });
  assert.equal(e.observed.applied.length, 1);
  assert.equal(e.observed.applied[0].design.objects[0].kind, 'bus_stop');
  assert.equal(e.observed.preview, null);
  assert.equal(e.observed.view.tool, 'select');
});
