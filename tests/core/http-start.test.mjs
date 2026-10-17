import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPlanningEngine, newObject, randomUuid, sha256Hex } from '../../dist/engine.js';
import { createAppServer } from '../../scripts/serve.mjs';

const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));

test('HTTP crypto fallback retains exact dataset identity and creates valid unique object IDs without subtle or randomUUID', async () => {
  const expected = (await createPlanningEngine(data)).datasetSha256;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  });
  try {
    const engine = await createPlanningEngine(data);
    assert.equal(engine.datasetSha256, expected);
    assert.equal(
      engine.evaluate({ projectIds: [], budgetRub: 8000000 }, ['walk']).profiles.walk.evaluatedPopulation,
      3692,
    );
    const ids = new Set(Array.from({ length: 100 }, () => randomUuid()));
    assert.equal(ids.size, 100);
    for (const id of ids)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(newObject('bus_stop', [100, 100]).id, /^user_[0-9a-f-]{36}$/);
    const envelope = engine.exportScenario({ projectIds: [], budgetRub: 8000000 });
    assert.equal(engine.importScenario(envelope).projectIds.length, 0);
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('SHA-256 matches an independent native implementation for empty, unicode, block boundaries and district data', () => {
  for (const value of [
    '',
    'Обнинск 🌳',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(4097),
    JSON.stringify(data),
  ]) {
    const bytes = new TextEncoder().encode(value);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});

const publicOrigin = 'http://203.0.113.10:4173',
  host = '203.0.113.10:4173';
const send = (url, path = '/', headers = {}, body) =>
  new Promise((resolve, reject) => {
    const req = request(
      url + path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Host: host, ...headers, Connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP test timeout')));
    req.end(body);
  });
async function fixture(
  t,
  {
    key = 'test-placeholder',
    fetchImpl = () => {
      throw new Error('Unexpected inference');
    },
  } = {},
) {
  const root = resolve('.tools/generated', `http-start-${randomUuid()}`);
  await mkdir(resolve(root, 'public/assets'), { recursive: true });
  await writeFile(resolve(root, 'public/index.html'), '<html>fixture</html>');
  await writeFile(resolve(root, 'public/assets/worker.js'), 'export const worker = true;');
  await writeFile(resolve(root, '.env.local'), 'secret-fixture-outside-static-root');
  const server = createAppServer({
    root: resolve(root, 'public'),
    env: { PUBLIC_ORIGIN: publicOrigin, AI_PROVIDER: 'riskradar', RISKRADAR_API_KEY: key },
    assistantOptions: { fetchImpl },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test('one HTTP server serves static assets with correct types and never exposes source, env or an HTML fallback for a missing Worker', async (t) => {
  const url = await fixture(t);
  const page = await send(url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-cache');
  const worker = await send(url, '/assets/worker.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-type'], /(javascript|ecmascript)/);
  for (const path of [
    '/assets/missing.js',
    '/.env.local',
    '/..%2f.env.local',
    '/scripts/assistant-api.mjs',
    '/api/missing',
  ])
    assert.equal((await send(url, path)).status, 404, path);
  assert.equal((await send(url, '/', {}, 'body')).status, 405);
});

test('public IP API accepts only its configured HTTP Host/Origin, keeps keys server-side and retains missing-key behavior', async (t) => {
  const url = await fixture(t);
  const response = await send(url, '/api/assistant/status');
  assert.equal(response.status, 200);
  const value = JSON.parse(response.body);
  assert.equal(value.configured, true);
  assert.equal(value.provider, 'RiskRadar');
  assert(!response.body.includes('test-placeholder'));
  assert.equal((await send(url, '/api/assistant/status', { Host: 'evil.test' })).status, 403);
  assert.equal((await send(url, '/api/assistant/status', { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await send(url, '/api/assistant/status', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.throws(() => createAppServer({ env: { PUBLIC_ORIGIN: publicOrigin + '/' } }));
  const missing = await fixture(t, { key: '' });
  assert.equal(
    (
      await send(
        missing,
        '/api/assistant/analyze',
        { 'Content-Type': 'application/json', Origin: publicOrigin },
        '{}',
      )
    ).status,
    503,
  );
});

test('public HTTP IP report uses the actual engine and mocked provider, without Vite or an HTTPS proxy', async (t) => {
  let calls = 0;
  const narrative = {
    findings: [
      { title: 'Исходная доступность', text: 'Показан исходный район.', evidenceIds: ['proximity.after'] },
    ],
    recommendations: [
      { title: 'Проверка', text: 'Нужно обследовать подходы.', evidenceIds: ['school.long.after'] },
    ],
    limitations: ['Население моделируется.'],
  };
  const url = await fixture(t, {
    fetchImpl: async (target, options) => {
      calls++;
      assert.equal(target, 'https://riskradarai.ru/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-placeholder');
      return Response.json({
        model: 'gemini-2.5-flash',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(narrative) } }],
      });
    },
  });
  const engine = await createPlanningEngine(data);
  const payload = {
    datasetId: engine.datasetId,
    datasetSha256: engine.datasetSha256,
    profileId: 'walk',
    scenario: { projectIds: [], budgetRub: 8000000 },
    mode: 'summary',
    question: 'Что проверить?',
  };
  const response = await send(
    url,
    '/api/assistant/analyze',
    { 'Content-Type': 'application/json', Origin: publicOrigin },
    JSON.stringify(payload),
  );
  assert.equal(response.status, 200, response.body);
  assert.equal(calls, 1);
  const value = JSON.parse(response.body);
  assert.equal(value.report.facts.find((f) => f.id === 'population').value, 3692);
  assert.equal(value.ai.provider, 'RiskRadar');
});
