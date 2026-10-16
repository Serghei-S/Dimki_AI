import { useEffect, useRef, useState } from 'react';
import type { PlanningService } from './planning-service.js';
import type {
  DeepReadonly,
  DistrictData,
  ScenarioInput,
  ScenarioEvaluation,
  RouteResult,
  EdgeLoadReport,
} from '../core/types.js';
import { applyDistrictChanges, sampleHomes } from './state.js';

export interface Analysis {
  profileId: string;
  metricId: string;
  scenario: ScenarioInput;
  result: DeepReadonly<ScenarioEvaluation>;
  baseline: DeepReadonly<ScenarioEvaluation>;
  routes: RouteResult[];
  loads: EdgeLoadReport;
  district: DeepReadonly<DistrictData>;
}
export function useAnalysis(
  client: PlanningService | null,
  data: DeepReadonly<DistrictData> | null,
  scenario: ScenarioInput,
  profileId: string,
  metricId: string,
  includeResidents: boolean,
) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    if (!client || !data) return;
    const current = ++revision.current,
      controller = new AbortController();
    setBusy(true);
    setError(null);
    void client
      .mapSnapshot(
        scenario,
        profileId,
        metricId,
        includeResidents ? sampleHomes(data) : [],
        controller.signal,
      )
      .then(({ result, baseline, routes, loads }) => {
        if (controller.signal.aborted || current !== revision.current) return;
        setAnalysis({
          profileId,
          metricId,
          scenario,
          result,
          baseline,
          routes,
          loads,
          district: applyDistrictChanges(data, result.districtChanges),
        });
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || current !== revision.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
    return () => controller.abort();
  }, [client, data, scenario, profileId, metricId, includeResidents]);
  return { analysis, busy, error };
}

/** Detailed selection remains available even when a large district uses a sampled crowd. */
export function useSelectedRoute(
  client: PlanningService | null,
  analysis: Analysis | null,
  buildingId: string | null,
): RouteResult | null {
  const [extra, setExtra] = useState<{ analysis: Analysis; route: RouteResult } | null>(null);
  const existing = analysis?.routes.find((route) => route.buildingId === buildingId) ?? null;
  useEffect(() => {
    if (
      !client ||
      !analysis ||
      !buildingId ||
      existing ||
      !analysis.district.buildings.some((b) => b.id === buildingId && b.population)
    )
      return;
    const controller = new AbortController();
    void client
      .route(analysis.scenario, analysis.profileId, buildingId, analysis.metricId, controller.signal)
      .then((route) => {
        if (!controller.signal.aborted) setExtra({ analysis, route });
      })
      .catch(() => {
        /* Report still provides reachability; an aborted detail never replaces a newer route. */
      });
    return () => controller.abort();
  }, [client, analysis, buildingId, existing]);
  return (
    existing ?? (extra?.analysis === analysis && extra.route.buildingId === buildingId ? extra.route : null)
  );
}
