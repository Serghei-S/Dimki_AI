import type { DistrictData, MetricDefinition, Profile, OptimizationInput, OptimizationControl, OptimizationResult, OptimizationAlternative, OptimizationScore, ScenarioInput } from './types.js';
import type { Topology } from './graph.js';
import {compileTopology} from './graph.js';
import { EngineError, requireCondition } from './errors.js';
import { parseOptimization } from './validation.js';
import { materializeValidated, resolveProjectOrder } from './scenario.js';
import { analyzeProfile } from './metrics.js';
import { compareId, round } from './util.js';

export const OPTIMIZER_RANKING = 'Remove dominated/equivalent alternatives; maximize withinThresholdResidents, then reachableResidents; minimize population-weighted travel seconds (rounded to 6 decimals), capex, annual opex; finally lexicographic project IDs. Exact only within the returned candidate catalogue.';
export function dominates(a: OptimizationScore, b: OptimizationScore): boolean {
  return a.withinThresholdResidents >= b.withinThresholdResidents && a.reachableResidents >= b.reachableResidents
    && a.weightedTravelSecondsReachable <= b.weightedTravelSecondsReachable && a.capexRub <= b.capexRub && a.annualOpexRub <= b.annualOpexRub
    && (a.withinThresholdResidents > b.withinThresholdResidents || a.reachableResidents > b.reachableResidents
      || a.weightedTravelSecondsReachable < b.weightedTravelSecondsReachable || a.capexRub < b.capexRub || a.annualOpexRub < b.annualOpexRub);
}
export function compareOptimizationScores(a: OptimizationScore, b: OptimizationScore): number {
  return b.withinThresholdResidents - a.withinThresholdResidents || b.reachableResidents - a.reachableResidents
    || a.weightedTravelSecondsReachable - b.weightedTravelSecondsReachable || a.capexRub - b.capexRub || a.annualOpexRub - b.annualOpexRub;
}
export async function optimizeProjects(data: DistrictData, topology: Topology, profiles: Map<string, Profile>, metrics: Map<string, MetricDefinition>,
  input: unknown, control: OptimizationControl = {}): Promise<OptimizationResult> {
  const options: OptimizationInput = parseOptimization(input);
  const profile = profiles.get(options.profileId), metric = metrics.get(options.metricId);
  requireCondition(profile, 'UNKNOWN_ID', `Unknown profile ${options.profileId}`);
  requireCondition(metric, 'UNKNOWN_ID', `Unknown metric ${options.metricId}`);
  const checkCancel = (): void => { if (control.signal?.aborted) throw new EngineError('CANCELLED', 'Optimization cancelled'); };
  checkCancel();
  const yieldEvery = control.yieldEvery ?? 16;
  requireCondition(Number.isSafeInteger(yieldEvery) && yieldEvery > 0 && yieldEvery <= 4096, 'INVALID_INPUT', 'yieldEvery must be in 1..4096');
  const candidates = resolveProjectOrder(data, [...(options.candidateProjectIds ?? data.projects.map(p => p.id)), ...(options.requiredProjectIds ?? [])]);
  requireCondition(candidates.length <= (options.maxCandidates ?? 16), 'SEARCH_LIMIT', 'Exact-search catalogue exceeds candidate limit', {candidateCount: candidates.length, limit: options.maxCandidates ?? 16});
  const required = resolveProjectOrder(data, options.requiredProjectIds ?? []), requiredSet = new Set(required);
  const optional = candidates.filter(id => !requiredSet.has(id));
  const overrides = options.operationalOverrides ?? [];
  const extension=options.design?{design:options.design}:{};
  materializeValidated(data, {projectIds: required, budgetRub: options.budgetRub, operationalOverrides: overrides,...extension});
  const byId = new Map(data.projects.map(p => [p.id, p]));
  const totalSubsets = 2 ** optional.length, topK = options.topK ?? 3, frontier: OptimizationAlternative[] = [];
  const identity = (a: OptimizationAlternative) => [...a.projectIds].sort(compareId).join('|');
  let feasibleSubsets = 0;
  const progress = (processedSubsets: number) => ({processedSubsets, totalSubsets, feasibleSubsets});
  control.onProgress?.(progress(0));
  for (let mask = 0; mask < totalSubsets; mask++) {
    checkCancel();
    const selected = new Set(required);
    for (let bit = 0; bit < optional.length; bit++) if ((mask & 2 ** bit) !== 0) selected.add(optional[bit]!);
    let valid = true, cost = 0;
    const groups = new Set<string>();
    for (const id of selected) {
      const project = byId.get(id)!;
      if (!project.requires.every(id => selected.has(id)) || project.excludes.some(id => selected.has(id))
        || (project.exclusiveGroup !== null && groups.has(project.exclusiveGroup))) {valid = false; break;}
      if (project.exclusiveGroup) groups.add(project.exclusiveGroup);
      cost += project.cost.capexRub;
      if (cost > options.budgetRub) {valid = false; break;}
    }
    if (valid) {
      const projectIds = candidates.filter(id => selected.has(id));
      const scenario: ScenarioInput = {projectIds, budgetRub: options.budgetRub, operationalOverrides: overrides,...extension};
      let snapshot;
      try{snapshot=materializeValidated(data, scenario);}catch(error){
        if(error instanceof EngineError && (error.code==='BUDGET_EXCEEDED' || (options.design && error.code==='INVALID_SCENARIO'))){
          if((mask+1)%yieldEvery===0){control.onProgress?.(progress(mask+1));await new Promise<void>(resolve=>setTimeout(resolve,0));}
          continue;
        }
        throw error;
      }
      const analysis = analyzeProfile(snapshot.data, options.design?compileTopology(snapshot.data):topology, profile, [metric]);
      const totals = analysis.report.destinations[metric.id]!, weighted = analysis.metrics.get(metric.id)!.weightedSeconds;
      const alternative: OptimizationAlternative = {projectIds, costs: snapshot.costs, metric: totals,
        score: {withinThresholdResidents: totals.withinThresholdResidents, reachableResidents: totals.reachableResidents,
          weightedTravelSecondsReachable: round(weighted, 6), capexRub: snapshot.costs.capexRub, annualOpexRub: snapshot.costs.annualOpexRub}};
      const equivalent = frontier.findIndex(item => compareOptimizationScores(item.score, alternative.score) === 0);
      if (equivalent >= 0) {
        if (compareId(identity(alternative), identity(frontier[equivalent]!)) < 0) frontier[equivalent] = alternative;
      } else if (!frontier.some(item => dominates(item.score, alternative.score))) {
        for (let i = frontier.length - 1; i >= 0; i--) if (dominates(alternative.score, frontier[i]!.score)) frontier.splice(i, 1);
        frontier.push(alternative);
        requireCondition(frontier.length <= (options.maxFrontierSize ?? 4096), 'SEARCH_LIMIT', 'Pareto frontier exceeds memory limit', {limit: options.maxFrontierSize ?? 4096});
      }
      feasibleSubsets++;
    }
    if ((mask + 1) % yieldEvery === 0) {
      control.onProgress?.(progress(mask + 1));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  checkCancel();
  if (totalSubsets % yieldEvery !== 0) control.onProgress?.(progress(totalSubsets));
  frontier.sort((a, b) => compareOptimizationScores(a.score, b.score) || compareId(identity(a), identity(b)));
  return {...progress(totalSubsets), exact: true, frontierSize: frontier.length,
    candidateProjectIds: candidates, rankingRule: OPTIMIZER_RANKING, alternatives: frontier.slice(0, topK)};
}
