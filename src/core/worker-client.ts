import type { WorkerRequest, WorkerResponse } from './worker-runtime.js';
import type { DistrictData, DeepReadonly, EngineOptions, ScenarioInput, ScenarioRequest, ScenarioEvaluation, RouteResult, OptimizationInput, OptimizationProgress, OptimizationResult, ScenarioEnvelope } from './types.js';
import { EngineError } from './errors.js';
import type {MapSnapshot} from './types.js';
import type {DesignAnalysisInput,DesignAnalysisResult} from './design-types.js';
import type {ActivityInput,ActivitySnapshot} from './activity-types.js';

export class EngineWorkerClient {
  #sequence = 0;
  #disposed = false;
  #pending = new Map<string, {resolve: (value: unknown) => void; reject: (error: unknown) => void;
    progress?: (progress: OptimizationProgress) => void; cleanup: () => void}>();
  constructor(readonly worker: Worker) {
    worker.addEventListener('message', this.#onMessage);
    worker.addEventListener('error', this.#onError);
    worker.addEventListener('messageerror', this.#onError);
  }
  #onMessage = (event: MessageEvent<WorkerResponse>): void => {
    const message = event.data, pending = this.#pending.get(message.requestId);
    if (!pending) return;
    if (message.type === 'progress') {
      try { pending.progress?.(message.progress); } catch (error) {
        pending.cleanup(); this.#pending.delete(message.requestId); pending.reject(error); this.#cancel(message.requestId);
      }
      return;
    }
    pending.cleanup(); this.#pending.delete(message.requestId);
    if (message.type === 'error') pending.reject(new EngineError(message.error.code, message.error.message, message.error.details));
    else pending.resolve(message.result);
  };
  #onError = (): void => {
    this.#failAll(new EngineError('WORKER_DISPOSED', 'Calculation worker failed')); this.dispose();
  };
  #failAll(error: EngineError): void {
    for (const pending of this.#pending.values()) {pending.cleanup(); pending.reject(error);} this.#pending.clear();
  }
  #cancel(targetRequestId: string): void {
    try {this.worker.postMessage({type: 'cancel', requestId: `cancel-${++this.#sequence}`, targetRequestId} satisfies WorkerRequest);}
    catch { /* The caller is already settled; a dead transport cannot receive cancellation. */ }
  }
  #request<T>(body: object, signal?: AbortSignal, progress?: (p: OptimizationProgress) => void): Promise<T> {
    if (this.#disposed) return Promise.reject(new EngineError('WORKER_DISPOSED', 'Worker client is disposed'));
    if (signal?.aborted) return Promise.reject(new EngineError('CANCELLED', 'Request already cancelled'));
    const requestId = `request-${++this.#sequence}`;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        pending.cleanup(); this.#pending.delete(requestId);
        reject(new EngineError('CANCELLED', 'Request cancelled'));
        this.#cancel(requestId);
      };
      this.#pending.set(requestId, {resolve: value => resolve(value as T), reject,
        ...(progress ? {progress} : {}), cleanup: () => signal?.removeEventListener('abort', abort)});
      signal?.addEventListener('abort', abort, {once: true});
      try { this.worker.postMessage({...body, requestId}); } catch (error) {
        this.#pending.get(requestId)!.cleanup(); this.#pending.delete(requestId); reject(error);
      }
    });
  }
  init(dataset: DeepReadonly<DistrictData>, options?: EngineOptions) {
    return this.#request<{datasetId: string; datasetVersion: string; datasetSha256: string}>({type: 'init', dataset, ...(options ? {options} : {})});
  }
  evaluate(scenario: ScenarioRequest, profileIds?: string[], signal?: AbortSignal): Promise<DeepReadonly<ScenarioEvaluation>> {
    return this.#request({type: 'evaluate', scenario, ...(profileIds ? {profileIds} : {})}, signal);
  }
  route(scenario: ScenarioRequest, profileId: string, buildingId: string, metricId: string, signal?: AbortSignal): Promise<RouteResult> {
    return this.#request({type: 'route', scenario, profileId, buildingId, metricId}, signal);
  }
  routes(scenario: ScenarioRequest, profileId: string, buildingIds: readonly string[], metricId: string, signal?: AbortSignal): Promise<RouteResult[]> {
    return this.#request({type: 'routes', scenario, profileId, buildingIds, metricId}, signal);
  }
  optimize(input: OptimizationInput, options: {signal?: AbortSignal; onProgress?: (p: OptimizationProgress) => void} = {}): Promise<OptimizationResult> {
    return this.#request({type: 'optimize', input}, options.signal, options.onProgress);
  }
  mapSnapshot(scenario: ScenarioRequest, profileId: string, metricId: string, buildingIds: readonly string[] = [], signal?: AbortSignal): Promise<MapSnapshot> {
    return this.#request({type:'map_snapshot', scenario, profileId, metricId, buildingIds}, signal);
  }
  activitySnapshot(scenario:ScenarioRequest,profileId:string,options:ActivityInput,signal?:AbortSignal):Promise<ActivitySnapshot>{return this.#request({type:'activity_snapshot',scenario,profileId,options},signal);}
  analyzeDesign(input:DesignAnalysisInput,options:{signal?:AbortSignal;onProgress?:(progress:OptimizationProgress)=>void}={}):Promise<DesignAnalysisResult>{return this.#request({type:'design_analysis',input},options.signal,options.onProgress);}
  networkAccess(scenario: ScenarioRequest, profileId: string, metricId: string, signal?: AbortSignal) {
    return this.#request<{nodeId: string; travelSeconds: number | null; withinThreshold: boolean}[]>({type: 'network_access', scenario, profileId, metricId}, signal);
  }
  exportScenario(scenario: ScenarioRequest): Promise<ScenarioEnvelope> { return this.#request({type: 'export_scenario', scenario}); }
  importScenario(envelope: unknown): Promise<ScenarioInput> { return this.#request({type: 'import_scenario', envelope}); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.worker.removeEventListener('message', this.#onMessage); this.worker.removeEventListener('error', this.#onError);
    this.worker.removeEventListener('messageerror', this.#onError); this.worker.terminate();
    this.#failAll(new EngineError('WORKER_DISPOSED', 'Worker client disposed'));
  }
}
