import { createPlanningEngine } from './engine.js';
import type { PlanningEngine } from './engine.js';
import type { DistrictData, EngineOptions, ScenarioInput, OptimizationInput, OptimizationProgress } from './types.js';
import { assertSchema } from './validation.js';
import { EngineError, requireCondition, serializeError } from './errors.js';
import type {DesignAnalysisInput} from './design-types.js';
import type {ActivityInput} from './activity-types.js';

export type WorkerRequest =
  | {type:'activity_snapshot';requestId:string;scenario:ScenarioInput;profileId:string;options:ActivityInput}
  | {type: 'init'; requestId: string; dataset: DistrictData; options?: EngineOptions}
  | {type: 'evaluate'; requestId: string; scenario: ScenarioInput; profileIds?: string[]}
  | {type: 'route'; requestId: string; scenario: ScenarioInput; profileId: string; buildingId: string; metricId: string}
  | {type: 'routes'; requestId: string; scenario: ScenarioInput; profileId: string; buildingIds: string[]; metricId: string}
  | {type: 'network_access'; requestId: string; scenario: ScenarioInput; profileId: string; metricId: string}
  | {type: 'map_snapshot'; requestId: string; scenario: ScenarioInput; profileId: string; metricId: string; buildingIds: string[]}
  | {type:'design_analysis';requestId:string;input:DesignAnalysisInput}
  | {type: 'export_scenario'; requestId: string; scenario: ScenarioInput}
  | {type: 'import_scenario'; requestId: string; envelope: unknown}
  | {type: 'optimize'; requestId: string; input: OptimizationInput}
  | {type: 'cancel'; requestId: string; targetRequestId: string};
export type WorkerResponse =
  | {type: 'result'; requestId: string; result: unknown}
  | {type: 'progress'; requestId: string; progress: OptimizationProgress}
  | {type: 'error'; requestId: string; error: ReturnType<typeof serializeError>};

/** Transport-independent dispatcher; used by the browser worker and real worker integration tests. */
export function createWorkerRuntime(send: (message: WorkerResponse) => void) {
  let engine: PlanningEngine | null = null, generation = 0;
  const active = new Map<string, AbortController>();
  return {
    async handle(value: unknown): Promise<void> {
      let requestId = value && typeof value === 'object' && 'requestId' in value && typeof value.requestId === 'string' ? value.requestId : 'invalid-request';
      let registered = false;
      try {
        assertSchema('request', value);
        const request = value as WorkerRequest; requestId = request.requestId;
        requireCondition(!active.has(requestId), 'INVALID_INPUT', 'Duplicate active request ID');
        if (request.type === 'cancel') {
          const controller = active.get(request.targetRequestId); controller?.abort();
          send({type: 'result', requestId, result: {cancelled: Boolean(controller)}}); return;
        }
        requireCondition(active.size < 8, 'INVALID_INPUT', 'Too many active worker requests');
        const controller = new AbortController(); active.set(requestId, controller); registered = true;
        if (request.type === 'init') {
          generation++;
          for (const [id, job] of active) if (id !== requestId) job.abort();
          engine = null;
          const version = generation;
          const next = await createPlanningEngine(request.dataset, request.options);
          if (controller.signal.aborted || version !== generation) throw new EngineError('CANCELLED', 'Initialization superseded');
          engine = next;
          send({type: 'result', requestId, result: {datasetId: next.datasetId, datasetVersion: next.datasetVersion, datasetSha256: next.datasetSha256}});
          return;
        }
        requireCondition(engine, 'INVALID_INPUT', 'Initialize worker dataset first');
        const current = engine, version = generation;
        let result: unknown;
        if (request.type === 'evaluate') result = current.evaluate(request.scenario, request.profileIds);
        else if (request.type === 'route') result = current.route(request.scenario, request.profileId, request.buildingId, request.metricId);
        else if (request.type === 'routes') result = current.routes(request.scenario, request.profileId, request.buildingIds, request.metricId);
        else if (request.type === 'network_access') result = current.networkAccess(request.scenario, request.profileId, request.metricId);
        else if (request.type === 'map_snapshot') result = current.mapSnapshot(request.scenario, request.profileId, request.metricId, request.buildingIds);
        else if(request.type==='activity_snapshot')result=current.activitySnapshot(request.scenario,request.profileId,request.options);
        else if (request.type === 'export_scenario') result = current.exportScenario(request.scenario);
        else if (request.type === 'import_scenario') result = current.importScenario(request.envelope);
        else if(request.type==='design_analysis')result=await current.analyzeDesign(request.input,{signal:controller.signal,onProgress:(done,total)=>{if(!controller.signal.aborted&&version===generation)send({type:'progress',requestId,progress:{processedSubsets:done,totalSubsets:total,feasibleSubsets:done}});}});
        else result = await current.optimize(request.input, {signal: controller.signal,
          onProgress: progress => { if (!controller.signal.aborted && version === generation) send({type: 'progress', requestId, progress}); }});
        if (controller.signal.aborted || version !== generation) throw new EngineError('CANCELLED', 'Request cancelled or dataset replaced');
        send({type: 'result', requestId, result});
      } catch (error) {
        send({type: 'error', requestId, error: serializeError(error)});
      } finally { if (registered) active.delete(requestId); }
    },
    dispose(): void { generation++; engine = null; for (const job of active.values()) job.abort(); }
  };
}
