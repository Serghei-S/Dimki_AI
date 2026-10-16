import type { EngineWorkerClient } from '../core/worker-client.js';

/** Transport boundary: an HTTP adapter can implement the same contract as the local Worker. */
export type PlanningService = Pick<
  EngineWorkerClient,
  'evaluate' | 'route' | 'mapSnapshot' | 'optimize' | 'exportScenario' | 'importScenario' | 'dispose'
>;
