import type { DistrictData, Profile, Scenario, Destination } from '../../data/schema/district.types.js';
export type * from '../../data/schema/district.types.js';
export type DeepReadonly<T> = T extends object ? {readonly [K in keyof T]: DeepReadonly<T[K]>} : T;

export type PopulationGroup = 'all' | 'under18' | 'age18to64' | 'age65plus' | 'mobilityNeeds';
export interface MetricDefinition {
  id: string;
  destinationKinds: Destination['kind'][];
  thresholdSeconds: number;
  populationGroup: PopulationGroup;
}
export interface EngineOptions {
  metrics?: MetricDefinition[];
  additionalProfiles?: Profile[];
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
}
export interface ScenarioInput {
  projectIds: readonly string[];
  budgetRub: number;
  /** Operational events may close/reopen originally existing links, never build or upgrade for free. */
  operationalOverrides?: readonly Scenario['operationalOverrides'][number][];
}
export type ScenarioRequest = ScenarioInput | DeepReadonly<Scenario>;
export interface Costs { capexRub: number; annualOpexRub: number; remainingRub: number }
export interface BuildingAccess {
  travelSeconds: number | null;
  reachable: boolean;
  withinThreshold: boolean;
  evaluatedResidents: number;
}
export interface MetricTotals {
  thresholdSeconds: number;
  evaluatedPopulation: number;
  reachableResidents: number;
  unreachableResidents: number;
  withinThresholdResidents: number;
  coveragePercent: number | null;
  meanSecondsReachableOnly: number | null;
}
export interface BuildingMetrics {
  buildingId: string;
  residents: number;
  destinations: Record<string, BuildingAccess>;
}
export interface ProfileMetrics {
  profileId: string;
  evaluatedPopulation: number;
  populationInterpretation: string;
  destinations: Record<string, MetricTotals>;
  perBuilding: BuildingMetrics[];
  publicParkAreaM2: number;
  publicParkM2PerResident: number | null;
}
export interface MetricChange {
  improvedResidents: number;
  worsenedResidents: number;
  unchangedResidents: number;
  coverageDeltaPercentagePoints: number | null;
}
export interface ScenarioEvaluation {
  datasetId: string;
  datasetVersion: string;
  datasetSha256: string;
  scenario: ScenarioInput;
  costs: Costs;
  profiles: Record<string, ProfileMetrics>;
  changesFromBaseline: Record<string, Record<string, MetricChange>>;
  /** Absolute changed records relative to the original district, not relative to previous UI state. */
  districtChanges: Pick<DistrictData, 'nodes' | 'edges' | 'destinations' | 'parcels'>;
}
export interface EdgeLoadReport {
  profileId: string;
  metricId: string;
  unit: 'resident-trips-per-cycle';
  evaluatedResidents: number;
  assignedResidents: number;
  unreachableResidents: number;
  maxLoad: number;
  edgeTraversals: number;
  edges: {edgeId: string; load: number; forward: number; backward: number; eligible: boolean}[];
}
export interface MapSnapshot {
  result: DeepReadonly<ScenarioEvaluation>;
  baseline: DeepReadonly<ScenarioEvaluation>;
  loads: EdgeLoadReport;
  routes: RouteResult[];
}
export interface RouteResult {
  profileId: string;
  buildingId: string;
  metricId: string;
  reachable: boolean;
  entranceNodeId: string | null;
  destinationId: string | null;
  destinationAccessNodeId: string | null;
  travelSeconds: number | null;
  walkingSeconds: number | null;
  waitingSeconds: number | null;
  distanceM: number | null;
  nodeIds: string[];
  edgeIds: string[];
  geometry: [number, number][];
  geojson: { type: 'Feature'; properties: Record<string, string | number | boolean | null>;
    geometry: { type: 'LineString'; coordinates: [number, number][] } | null };
}
export interface OptimizationInput {
  profileId: string;
  metricId: string;
  budgetRub: number;
  candidateProjectIds?: string[];
  requiredProjectIds?: string[];
  operationalOverrides?: Scenario['operationalOverrides'];
  maxCandidates?: number;
  maxFrontierSize?: number;
  topK?: number;
}
export interface OptimizationScore {
  withinThresholdResidents: number;
  reachableResidents: number;
  weightedTravelSecondsReachable: number;
  capexRub: number;
  annualOpexRub: number;
}
export interface OptimizationAlternative {
  projectIds: string[];
  costs: Costs;
  metric: MetricTotals;
  score: OptimizationScore;
}
export interface OptimizationProgress { processedSubsets: number; totalSubsets: number; feasibleSubsets: number }
export interface OptimizationResult extends OptimizationProgress {
  exact: true;
  frontierSize: number;
  candidateProjectIds: string[];
  rankingRule: string;
  alternatives: OptimizationAlternative[];
}
export interface OptimizationControl {
  signal?: AbortSignal;
  onProgress?: (progress: OptimizationProgress) => void;
  yieldEvery?: number;
}
export interface EngineStats { hits: number; misses: number; entries: number; estimatedBytes: number }
export interface ScenarioEnvelope {
  formatVersion: 1;
  datasetId: string;
  datasetVersion: string;
  datasetSha256: string;
  scenario: ScenarioInput;
}
export type Materialized = { data: DistrictData; costs: Costs; scenario: ScenarioInput };
