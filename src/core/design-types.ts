import type { Destination, ScenarioInput } from './types.js';
export type XY = [number, number];
export interface CostItem {
  id: string;
  name: string;
  amountRub: number;
  formula: string;
}
export interface DesignRules {
  distanceThresholdM: number;
  parkM2PerVisitor: number;
  snapDistanceM: number;
  entranceGapM: number;
  candidateSpacingM: number;
}
export interface EditableObject {
  id: string;
  name: string;
  kind: Destination['kind'];
  active: boolean;
  level: 0 | 1 | 2;
  capacity: number | null;
  entrances: XY[];
  polygon: XY[] | null;
  /** Reserved concept site; not a cadastral plot or a verified building footprint. */
  site?: XY[];
  placementChecked?: boolean;
  autoEntrances: boolean;
  throughAccess: boolean;
}
export interface DesignState {
  objects: EditableObject[];
  rules: DesignRules;
}
export interface DistanceRow {
  buildingId: string;
  residents: number;
  distanceM: number | null;
  destinationId: string | null;
}
export interface DistanceTotals {
  evaluatedResidents: number;
  reachableResidents: number;
  withinResidents: number;
  meanDistanceM: number | null;
  meanServiceSeconds: number | null;
  thresholdM: number;
}
export interface DistanceChange {
  improvedResidents: number;
  worsenedResidents: number;
  unchangedResidents: number;
  gainedWithinResidents: number;
  lostWithinResidents: number;
  gainedReachableResidents: number;
  lostReachableResidents: number;
  meanChangeCommonM: number | null;
  commonResidents: number;
}
export interface ObjectImportance {
  id: string;
  name: string;
  servedResidents: number;
  capacity: number | null;
  loadPercent: number | null;
  without: DistanceTotals;
  withoutRows: DistanceRow[];
  change: DistanceChange;
  expectedWaitSeconds: number;
  effectiveCapacity: number | null;
}
export interface NeedCandidate {
  accessDistanceM?: number;
  id: string;
  edgeId: string;
  point: XY;
  alongM: number;
  gainResidents: number;
  gainReachableResidents: number;
  meanReductionM: number | null;
  commonResidents: number;
  score: number;
  /** Populated only for the three recommendations, bounding report size. */
  rows?: DistanceRow[];
}
export interface EdgeVulnerability {
  edgeId: string;
  lostResidents: number;
  lostReachableResidents: number;
  meanIncreaseM: number | null;
  affectedResidents: number;
}
export interface DesignAnalysisInput {
  placementAware?: boolean;
  scenario: ScenarioInput;
  profileId: string;
  kind: Destination['kind'];
  mode: 'importance' | 'needs' | 'vulnerability' | 'relocation' | 'compare';
  objectId?: string;
  point?: XY;
  scenarios?: { name: string; scenario: ScenarioInput }[];
}
export interface DesignAnalysisResult {
  mode: DesignAnalysisInput['mode'];
  kind: Destination['kind'];
  totals: DistanceTotals;
  rows: DistanceRow[];
  costItems: CostItem[];
  objects: ObjectImportance[];
  candidates: NeedCandidate[];
  top: NeedCandidate[];
  vulnerabilities: EdgeVulnerability[];
  comparisons: {
    name: string;
    totals: DistanceTotals;
    rows: DistanceRow[];
    change: DistanceChange;
    costRub: number;
    costItems: CostItem[];
  }[];
  evaluatedCandidates: number;
  spacingM: number;
  rules: DesignRules;
}
