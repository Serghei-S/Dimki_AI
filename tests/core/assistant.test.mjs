import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPlanningEngine } from '../../dist/engine.js';
import { makeReport, aiContext } from '../../dist/report.js';
import { createAssistantMiddleware, parseNarrative, FREE_MODEL } from '../../scripts/assistant-api.mjs';
const data = JSON.parse(await readFile(new URL('../../data/obninsk-center.json', import.meta.url), 'utf8'));
const engine = await createPlanningEngine(data),
  scenario = { projectIds: [], budgetRub: 8000000 };
const base = engine.evaluate(scenario, ['walk']),
  report = makeReport(data, base, base, 'walk');
const input = {
  datasetId: engine.datasetId,
  datasetSha256: engine.datasetSha256,
  profileId: 'walk',
  scenario,
  mode: 'summary',
  question: 'Кому стало хуже?',
};
const narrative = {
  findings: [{ title: 'Исходный район', text: 'Изменения не внесены.', evidenceIds: ['capex'] }],
  recommendations: [
    {
      title: 'Проверить сценарий',
      text: 'Сначала проверьте доступность на местности.',
      evidenceIds: ['park.coverage.after'],
    },
  ],
  limitations: ['Данные населения моделируются.'],
};
function upstream() {
  return Response.json({
    model: 'test-model:free',
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(narrative) } }],
  });
}
async function fixture(t, options = {}) {
  const middleware = createAssistantMiddleware({ getKey: () => 'unit-test-not-a-real-key', ...options });
  const server = createServer(
    (req, res) =>
      void middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    post: (payload = input, extra = {}) =>
      fetch(url + '/api/assistant/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        ...extra,
      }),
  };
}
test('missing key is explicit; status never reveals credentials and report generation does not call a provider', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    getKey: () => '',
    fetchImpl: () => {
      calls++;
      throw Error();
    },
  });
  assert.deepEqual(await (await fetch(f.url + '/api/assistant/status')).json(), {
    configured: false,
    model: FREE_MODEL,
  });
  const response = await f.post();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'NOT_CONFIGURED');
  assert.equal(calls, 0);
});
test('server recomputes metrics, ignores injected client facts/model and calls only the free endpoint', async (t) => {
  let sent;
  const f = await fixture(t, {
    fetchImpl: async (url, options) => {
      sent = { url, ...options };
      return upstream();
    },
  });
  const response = await f.post({ ...input, model: 'paid/model', facts: [{ id: 'capex', value: 999999 }] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.report.snapshotKey, report.snapshotKey);
  assert.deepEqual(result.report.facts, report.facts);
  const body = JSON.parse(sent.body);
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'openrouter/free');
  const outbound = JSON.parse(body.messages[1].content);
  assert.deepEqual(outbound.DATA.facts, report.facts);
  assert(!('buildings' in outbound.DATA));
  assert(!('scenario' in outbound.DATA));
  assert(!JSON.stringify(result).includes('unit-test-not-a-real-key'));
  assert.equal(result.ai.model, 'test-model:free');
});
test('invalid scenarios, profiles and dataset versions fail before external inference', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    fetchImpl: async () => {
      calls++;
      return upstream();
    },
  });
  for (const [payload, status] of [
    [{ ...input, datasetSha256: 'old' }, 409],
    [{ ...input, profileId: 'bad' }, 400],
    [{ ...input, datasetId: '../../secret' }, 400],
    [{ ...input, scenario: { projectIds: ['bad'], budgetRub: 0 } }, 400],
  ])
    assert.equal((await f.post(payload)).status, status);
  assert.equal(calls, 0);
});
test('same-origin protection, method/content type and size bounds reject abusive requests', async (t) => {
  const f = await fixture(t, { fetchImpl: async () => upstream() });
  assert.equal(
    (await f.post(input, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' } }))
      .status,
    403,
  );
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url + '/api/assistant/status', { headers: { Host: 'evil.test:80' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await f.post(input, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(f.url + '/api/assistant/analyze')).status, 405);
  assert.equal((await f.post({ ...input, question: 'x'.repeat(140000) })).status, 413);
  assert.equal((await f.post({ ...input, question: 'x'.repeat(1201) })).status, 400);
});
test('provider rate limits and invalid answers produce honest errors without exposing raw provider messages', async (t) => {
  const f = await fixture(t, {
    getReport: async () => report,
    fetchImpl: async () => Response.json({ error: 'SECRET provider raw details' }, { status: 429 }),
  });
  const response = await f.post();
  assert.equal(response.status, 429);
  assert(!(await response.text()).includes('SECRET'));
  const bad = await fixture(t, {
    getReport: async () => report,
    fetchImpl: async () =>
      Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
  });
  assert.equal((await bad.post()).status, 502);
});
test('AI prose must cite known facts and cannot invent numeric metrics', () => {
  assert.deepEqual(parseNarrative(JSON.stringify(narrative), report.facts), narrative);
  const unknown = structuredClone(narrative);
  unknown.findings[0].evidenceIds = ['fake'];
  assert.throws(() => parseNarrative(JSON.stringify(unknown), report.facts));
  const numbers = structuredClone(narrative);
  numbers.findings[0].text = 'Выиграли 900 жителей';
  assert.throws(() => parseNarrative(JSON.stringify(numbers), report.facts));
  assert.throws(() => parseNarrative('not json', report.facts));
  assert.throws(() => parseNarrative('{}', report.facts));
});
test('timeout aborts upstream request and returns a recoverable error', async (t) => {
  let aborted = false;
  const f = await fixture(t, {
    timeoutMs: 50,
    getReport: async () => report,
    contextForReport: aiContext,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('aborted'));
          },
          { once: true },
        ),
      ),
  });
  assert.equal((await f.post()).status, 504);
  assert(aborted);
});
test('client cancellation aborts the external provider request', async (t) => {
  let began, finish;
  const started = new Promise((r) => (began = r)),
    stopped = new Promise((r) => (finish = r));
  const f = await fixture(t, {
    getReport: async () => report,
    contextForReport: aiContext,
    fetchImpl: async (_url, { signal }) => {
      began();
      return new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            finish();
            reject(new Error('aborted'));
          },
          { once: true },
        ),
      );
    },
  });
  const controller = new AbortController(),
    request = f.post(input, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(request);
  await stopped;
});
test('local request quota bounds repeated external calls even with a valid key', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    getReport: async () => report,
    contextForReport: aiContext,
    fetchImpl: async () => {
      calls++;
      return upstream();
    },
  });
  for (let i = 0; i < 10; i++) assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 429);
  assert.equal(calls, 10);
});
