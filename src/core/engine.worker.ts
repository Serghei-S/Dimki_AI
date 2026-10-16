import { createWorkerRuntime } from './worker-runtime.js';

const runtime = createWorkerRuntime(message => self.postMessage(message));
self.addEventListener('message', (event: MessageEvent<unknown>) => { void runtime.handle(event.data); });
