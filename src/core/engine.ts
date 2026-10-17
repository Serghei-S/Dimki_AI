import type { DistrictData, EngineOptions, Profile, MetricDefinition, ScenarioInput, ScenarioRequest, DeepReadonly, ScenarioEvaluation, RouteResult, OptimizationInput, OptimizationControl, OptimizationResult, ScenarioEnvelope } from './types.js';
import type { ProfileAnalysis } from './metrics.js';
import { analyzeProfile, defaultMetrics, compareMetrics, routeForBuilding } from './metrics.js';
import {edgeLoadsForAnalysis} from './metrics.js';
import type {EdgeLoadReport, MapSnapshot} from './types.js';
import {analyzeDesign as analyzeFreeDesign} from './design-analysis.js';
import type {DesignAnalysisInput,DesignAnalysisResult} from './design-types.js';
import { compileTopology } from './graph.js';
import type { Topology } from './graph.js';
import { parseDataset, parseOptions, parseScenario, parseEnvelope } from './validation.js';
import { materializeValidated, resolveProjectOrder } from './scenario.js';
import { optimizeProjects } from './optimizer.js';
import { requireCondition } from './errors.js';
import { BoundedCache, deepFreeze, stableKey, round } from './util.js';
import { sha256Hex } from './crypto.js';
import {planDailyActivity,activityAtHour} from './daily-activity.js';
import type {DailyPlan} from './daily-activity.js';
import type {ActivityInput,ActivitySnapshot} from './activity-types.js';

const EMPTY: ScenarioInput = {projectIds: [], budgetRub: 0, operationalOverrides: []};

export class PlanningEngine {
  readonly #data: DistrictData;
  readonly #profiles: Map<string, Profile>;
  readonly #metrics: Map<string, MetricDefinition>;
  readonly #topology: Topology;
  readonly #cache: BoundedCache<ProfileAnalysis>;
  readonly #digest: string;
  readonly #dailyPlans = new BoundedCache<DailyPlan>(4, 24*1024*1024);

  private constructor(data: DistrictData, options: EngineOptions, digest: string) {
    this.#data = data; this.#digest = digest;
    const profiles = [...data.profiles, ...(options.additionalProfiles ?? [])];
    this.#profiles = new Map(profiles.map(p => [p.id, deepFreeze(p)]));
    requireCondition(this.#profiles.size === profiles.length, 'INVALID_INPUT', 'Duplicate profile ID');
    const metrics = options.metrics ?? defaultMetrics(data);
    this.#metrics = new Map(metrics.map(m => [m.id, deepFreeze(m)]));
    requireCondition(this.#metrics.size === metrics.length, 'INVALID_INPUT', 'Duplicate metric ID');
    this.#topology = compileTopology(data);
    this.#cache = new BoundedCache(options.cacheMaxEntries ?? 24, options.cacheMaxBytes ?? 32 * 1024 * 1024);
    // Structural/catalogue checks are done once by parseDataset; full state validation
    // is done for saved scenarios and on every applied scenario, not P full graph copies.
    for (const scenario of data.scenarios) materializeValidated(data, parseScenario(scenario));
  }
  static async create(input: unknown, inputOptions: EngineOptions = {}): Promise<PlanningEngine> {
    const data = parseDataset(input), options = parseOptions(inputOptions);
    // Content fingerprint is independent of JSON whitespace or object property order.
    const bytes = new TextEncoder().encode(stableKey(data));
    const digest = sha256Hex(bytes);
    return new PlanningEngine(data, options, digest);
  }
  get datasetId(): string { return this.#data.metadata.id; }
  get datasetSha256(): string { return this.#digest; }
  get datasetVersion(): string { return this.#data.metadata.datasetVersion; }
  getDataset(): DeepReadonly<DistrictData> { return this.#data; }
  getMetrics(): MetricDefinition[] { return structuredClone([...this.#metrics.values()]); }
  getProfiles(): Profile[] { return structuredClone([...this.#profiles.values()]); }
  resolveProjects(ids: readonly string[]): string[] { return resolveProjectOrder(this.#data, ids); }
  materialize(input: ScenarioRequest): {data: DeepReadonly<DistrictData>; costs: import('./types.js').Costs; scenario: ScenarioInput;costItems?:import('./design-types.js').CostItem[]} {
    return materializeValidated(this.#data, parseScenario(input));
  }
  clearCache(): void { this.#cache.clear(); this.#dailyPlans.clear(); }
  cacheStats() { return this.#cache.stats(); }

  #analysis(scenario: ScenarioInput, profileId: string, snapshot?: DistrictData): ProfileAnalysis {
    const profile = this.#profiles.get(profileId);
    requireCondition(profile, 'UNKNOWN_ID', `Unknown profile: ${profileId}`);
    // Budget does not change routes; operation ordering remains part of the key.
    const key = stableKey({profileId, projectIds: scenario.projectIds, overrides: scenario.operationalOverrides ?? [],design:scenario.design??null});
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const data = snapshot ?? materializeValidated(this.#data, scenario).data;
    const analysis = analyzeProfile(data, scenario.design?compileTopology(data):this.#topology, profile, [...this.#metrics.values()]);
    deepFreeze(analysis.report);
    this.#cache.set(key, analysis, analysis.estimatedBytes);
    return analysis;
  }

  evaluate(input: ScenarioRequest = EMPTY, profileIds = [...this.#profiles.keys()]): DeepReadonly<ScenarioEvaluation> {
    const scenario = parseScenario(input), snapshot = materializeValidated(this.#data, scenario);
    requireCondition(Array.isArray(profileIds) && profileIds.length > 0 && new Set(profileIds).size === profileIds.length, 'INVALID_INPUT', 'Select unique nonempty profile IDs');
    const profiles: ScenarioEvaluation['profiles'] = Object.create(null), changes: ScenarioEvaluation['changesFromBaseline'] = Object.create(null);
    for (const id of profileIds) {
      const analysis = this.#analysis(scenario, id, snapshot.data), baseline = snapshot.data === this.#data ? analysis : this.#analysis(EMPTY, id, this.#data);
      profiles[id] = analysis.report;
      changes[id] = compareMetrics(baseline.report, analysis.report, this.#data.metricDefinitions.comparisonEpsilonSeconds);
    }
    const districtChanges = {nodes: snapshot.data.nodes.filter((record, i) => record !== this.#data.nodes[i]),
      edges: snapshot.data.edges.filter((record, i) => record !== this.#data.edges[i]),
      destinations: snapshot.data.destinations.filter((record, i) => record !== this.#data.destinations[i]),
      parcels: snapshot.data.parcels.filter((record, i) => record !== this.#data.parcels[i]),
      stopBays:snapshot.data.stopBays.filter((record,i)=>record!==this.#data.stopBays[i])};
    return deepFreeze({datasetId: this.datasetId, datasetVersion: this.datasetVersion, datasetSha256: this.datasetSha256,
      scenario, costs: snapshot.costs, profiles, changesFromBaseline: changes, districtChanges});
  }

  route(input: ScenarioRequest, profileId: string, buildingId: string, metricId: string): RouteResult {
    const scenario = parseScenario(input), snapshot = materializeValidated(this.#data, scenario);
    return routeForBuilding(this.#analysis(scenario, profileId, snapshot.data), buildingId, metricId);
  }

  /** One snapshot and one profile analysis for a batch, used by map animations. */
  routes(input: ScenarioRequest, profileId: string, buildingIds: readonly string[], metricId: string): RouteResult[] {
    requireCondition(Array.isArray(buildingIds) && buildingIds.length > 0 && buildingIds.length <= 1024
      && new Set(buildingIds).size === buildingIds.length, 'INVALID_INPUT', 'Select 1..1024 unique buildings for batch routes');
    const scenario = parseScenario(input), snapshot = materializeValidated(this.#data, scenario);
    const analysis = this.#analysis(scenario, profileId, snapshot.data);
    return buildingIds.map(id => routeForBuilding(analysis, id, metricId));
  }

  /** Population-weighted directional demand on the selected shortest-path forest. */
  edgeLoads(input: ScenarioRequest, profileId: string, metricId: string): EdgeLoadReport {
    const scenario = parseScenario(input), snapshot = materializeValidated(this.#data, scenario);
    return edgeLoadsForAnalysis(this.#analysis(scenario, profileId, snapshot.data), metricId);
  }

  /** One transport message; report, load and optional actor routes share the same cached analysis. */
  mapSnapshot(input: ScenarioRequest, profileId: string, metricId: string, buildingIds: readonly string[] = []): MapSnapshot {
    requireCondition(Array.isArray(buildingIds) && buildingIds.length <= 1024 && new Set(buildingIds).size === buildingIds.length,
      'INVALID_INPUT', 'Select at most 1024 unique animation homes');
    const result = this.evaluate(input, [profileId]);
    const analysis = this.#analysis(parseScenario(result.scenario), profileId);
    const baseline = this.evaluate(EMPTY, [profileId]);
    return {result, baseline, loads:edgeLoadsForAnalysis(analysis, metricId),
      routes:buildingIds.map(id => routeForBuilding(analysis, id, metricId))};
  }
  activitySnapshot(input: ScenarioRequest, profileId: string, options: ActivityInput): ActivitySnapshot {
    const scenario = parseScenario(input), profile = this.#profiles.get(profileId);
    requireCondition(profile, 'UNKNOWN_ID', 'Неизвестный профиль потока');
    requireCondition(
      options && Number.isInteger(options.hour) && options.hour >= 0 && options.hour <= 23 &&
      ['weekday', 'weekend'].includes(options.dayType) &&
      (options.includeRoutes === undefined || typeof options.includeRoutes === 'boolean'),
      'INVALID_INPUT', 'Некорректное время моделирования',
    );
    // Validate the budget and edits even when the geometry already has a cached daily plan.
    const snapshot = materializeValidated(this.#data, scenario);
    const key = stableKey({
      projects: scenario.projectIds, overrides: scenario.operationalOverrides ?? [],
      design: scenario.design ?? null, profileId, dayType: options.dayType,
    });
    let plan = this.#dailyPlans.get(key);
    if (!plan) {
      plan = deepFreeze(planDailyActivity(snapshot.data, profile, options.dayType));
      this.#dailyPlans.set(key, plan, JSON.stringify(plan.events).length * 2 + snapshot.data.edges.length * 200);
    }
    return deepFreeze(activityAtHour(plan, options));
  }

  /** Network-based access values for coloring nodes; no circular-buffer approximation. */
  networkAccess(input: ScenarioRequest, profileId: string, metricId: string): {nodeId: string; travelSeconds: number | null; withinThreshold: boolean}[] {
    const scenario = parseScenario(input), snapshot = materializeValidated(this.#data, scenario), analysis = this.#analysis(scenario, profileId, snapshot.data);
    const runtime = analysis.metrics.get(metricId);
    requireCondition(runtime, 'UNKNOWN_ID', `Unknown metric ${metricId}`);
    return analysis.graph.topology.nodeIds.map((id, i) => {const time = runtime.tree.distances[i]!; return {nodeId: id,
      travelSeconds: Number.isFinite(time) ? round(time) : null, withinThreshold: time <= runtime.definition.thresholdSeconds + 1e-9};});
  }

  async optimize(input: OptimizationInput, control: OptimizationControl = {}): Promise<OptimizationResult> {
    return optimizeProjects(this.#data, this.#topology, this.#profiles, this.#metrics, input, control);
  }
  analyzeDesign(input:DesignAnalysisInput,control:{signal?:AbortSignal;onProgress?:(done:number,total:number)=>void}={}):Promise<DesignAnalysisResult>{return analyzeFreeDesign(this,input,control);}
  exportScenario(input: ScenarioRequest): ScenarioEnvelope {
    const scenario = parseScenario(input);
    materializeValidated(this.#data, scenario);
    return {formatVersion: 1, datasetId: this.datasetId, datasetVersion: this.datasetVersion, datasetSha256: this.datasetSha256, scenario};
  }
  importScenario(input: unknown): ScenarioInput {
    let value = input;
    if (typeof input === 'string') { try {value = JSON.parse(input);} catch {requireCondition(false, 'INVALID_INPUT', 'Invalid scenario JSON');} }
    const envelope = parseEnvelope(value);
    requireCondition(envelope.datasetId === this.datasetId && envelope.datasetVersion === this.datasetVersion && envelope.datasetSha256 === this.datasetSha256,
      'DATASET_MISMATCH', 'Scenario belongs to different dataset content/version');
    materializeValidated(this.#data, envelope.scenario);
    return envelope.scenario;
  }
}
export const createPlanningEngine = PlanningEngine.create;
