import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('.tools/test', { recursive: true });
await build({
  entryPoints: ['src/map/lawns.ts'],
  outfile: '.tools/test/lawns.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
});
const { createLawnSizer } = await import('../../.tools/test/lawns.mjs');
const rectangle = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
];
const empty = { roads: [], buildings: [], parcels: [], edges: [] };
test('decorative lawns stop at buildings, road polygons, block boundaries and actual path width', () => {
  const block = rectangle(0, 0, 100, 100);
  assert.equal(createLawnSizer(empty)([-1, 20], block, 11), 0);
  assert.equal(createLawnSizer(empty)([1, 20], block, 11), 0.4);
  const data = {
    ...empty,
    roads: [{ polygon: rectangle(30, 0, 10, 100) }],
    buildings: [{ polygon: rectangle(60, 60, 10, 10) }],
    edges: [
      {
        active: true,
        widthM: 4,
        geometry: [
          [0, 20],
          [100, 20],
        ],
      },
    ],
  };
  const size = createLawnSizer(data);
  assert.equal(size([35, 50], block, 11), 0);
  assert.equal(size([65, 65], block, 11), 0);
  assert.equal(size([20, 50], block, 11), 9.4);
  assert.equal(size([20, 25], block, 11), 2.2);
  assert.equal(size([20, 20], block, 11), 0);
});
test('real Obninsk lawn clearance matches independent exhaustive distances; rendering never mutates planning data', async () => {
  const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
  const original = JSON.stringify(data),
    size = createLawnSizer(data);
  const inside = (p, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
        hit = !hit;
    }
    return hit;
  };
  const distance = (p, a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const forbidden = [
    ...data.roads,
    ...data.buildings,
    ...data.parcels.filter((p) => p.kind === 'vacant'),
  ].map((p) => p.polygon);
  let positive = 0;
  for (const block of data.blocks) {
    const xs = block.polygon.map((p) => p[0]),
      ys = block.polygon.map((p) => p[1]);
    for (let x = Math.min(...xs) + 5; x < Math.max(...xs); x += 19)
      for (let y = Math.min(...ys) + 5; y < Math.max(...ys); y += 19) {
        const p = [x, y],
          r = size(p, block.polygon, 11);
        if (r <= 0) continue;
        positive++;
        assert(inside(p, block.polygon));
        for (const ring of forbidden) {
          assert(!inside(p, ring));
          for (let i = 1; i < ring.length; i++) assert(r <= distance(p, ring[i - 1], ring[i]) - 0.6 + 1e-8);
        }
        for (const edge of data.edges.filter((e) => e.active))
          for (let i = 1; i < edge.geometry.length; i++)
            assert(r <= distance(p, edge.geometry[i - 1], edge.geometry[i]) - edge.widthM / 2 - 0.8 + 1e-8);
      }
  }
  assert(positive > 10);
  assert.equal(JSON.stringify(data), original);
});
