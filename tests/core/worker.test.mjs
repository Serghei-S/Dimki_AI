import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {EngineWorkerClient, createWorkerRuntime} from '../../dist/engine.js';

const data = JSON.parse(await readFile(new URL('../../data/district.json', import.meta.url), 'utf8'));
const base = {projectIds: [], budgetRub: 8000000};
class BrowserWorkerTransport extends EventTarget {
  #thread = new Worker(new URL('./fixtures/node-worker.mjs', import.meta.url));
  constructor() { super(); this.#thread.on('message', data => this.dispatchEvent(new MessageEvent('message', {data})));
    this.#thread.on('error', () => this.dispatchEvent(new Event('error'))); }
  postMessage(value) { this.#thread.postMessage(value); }
  terminate() { void this.#thread.terminate(); }
}

test('real worker executes the browser bundle and client returns metrics and routes', {timeout: 10000}, async t => {
  const client = new EngineWorkerClient(new BrowserWorkerTransport()); t.after(() => client.dispose());
  const initialized = await client.init(data); assert.equal(initialized.datasetId, data.metadata.id);
  const result = await client.evaluate(base, ['walk']); assert.equal(result.profiles.walk.evaluatedPopulation, 8636);
  const quietMap=await client.mapSnapshot(base,'walk','park'); assert.equal(quietMap.routes.length,0); assert.equal(quietMap.loads.assignedResidents,8636);
  assert.equal(quietMap.loads.edges.length,data.edges.length);
  const route = await client.route(base, 'walk', data.buildings.find(b => b.population).id, 'park'); assert.ok(route.reachable && route.edgeIds.length > 0);
  assert.deepEqual(await client.routes(base, 'walk', [route.buildingId], 'park'), [route]);
  const access = await client.networkAccess(base, 'walk', 'park'); assert.equal(access.length, data.nodes.length);
  const envelope = await client.exportScenario(base); assert.deepEqual((await client.importScenario(envelope)).projectIds, []);
  await assert.rejects(client.evaluate({projectIds: ['missing'], budgetRub: 1}), e => e.code === 'UNKNOWN_ID');
});

test('worker cancellation reports progress, rejects old work and accepts a following request', {timeout: 10000}, async t => {
  const client = new EngineWorkerClient(new BrowserWorkerTransport()); t.after(() => client.dispose()); await client.init(data);
  const controller = new AbortController();
  await assert.rejects(client.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000},
    {signal: controller.signal, onProgress: p => {if (p.processedSubsets > 0) controller.abort();}}), e => e.code === 'CANCELLED');
  const result = await client.evaluate(base, ['step_free']); assert.equal(result.profiles.step_free.evaluatedPopulation, 8636);
});

test('disposing client settles every pending request', async () => {
  const client = new EngineWorkerClient(new BrowserWorkerTransport());
  const promise = client.init(data); const rejection = assert.rejects(promise, e => e.code === 'WORKER_DISPOSED');
  client.dispose(); await rejection;
  await assert.rejects(client.evaluate(base), e => e.code === 'WORKER_DISPOSED');
});

test('progress callback failures settle the caller and cancel background computation', {timeout: 10000}, async t => {
  const client = new EngineWorkerClient(new BrowserWorkerTransport()); t.after(() => client.dispose()); await client.init(data);
  await assert.rejects(client.optimize({profileId: 'walk', metricId: 'park', budgetRub: 8000000},
    {onProgress: () => {throw new Error('UI callback failed');}}), /UI callback failed/);
  assert.equal((await client.evaluate(base, ['walk'])).profiles.walk.evaluatedPopulation, 8636);
});

test('worker rejects uninitialized and malformed commands with structured errors', async () => {
  const messages = [], runtime = createWorkerRuntime(message => messages.push(message));
  await runtime.handle({type: 'evaluate', requestId: 'before-init', scenario: base});
  assert.equal(messages.at(-1).error.code, 'INVALID_INPUT');
  await runtime.handle({type: 'unknown', requestId: 'bad'}); assert.equal(messages.at(-1).type, 'error');
  runtime.dispose();
});

test('reinitializing the worker cannot publish a stale optimization result', {timeout: 10000}, async () => {
  const messages = [], runtime = createWorkerRuntime(message => messages.push(message));
  await runtime.handle({type: 'init', requestId: 'init-1', dataset: data});
  const running = runtime.handle({type: 'optimize', requestId: 'old-job', input: {profileId: 'walk', metricId: 'park', budgetRub: 8000000}});
  await runtime.handle({type: 'init', requestId: 'init-2', dataset: data}); await running;
  assert.equal(messages.find(m => m.requestId === 'old-job' && m.type === 'error').error.code, 'CANCELLED');
  assert.ok(!messages.some(m => m.requestId === 'old-job' && m.type === 'result')); runtime.dispose();
});
