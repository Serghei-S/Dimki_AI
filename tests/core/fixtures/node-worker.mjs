import {parentPort} from 'node:worker_threads';
globalThis.self = {
  postMessage: value => parentPort.postMessage(value),
  addEventListener: (type, listener) => { if (type === 'message') parentPort.on('message', data => listener({data})); }
};
await import('../../../dist/engine.worker.js');
