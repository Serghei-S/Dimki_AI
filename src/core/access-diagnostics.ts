import type { DeepReadonly, ProfileMetrics } from './types.js';
export const ACCESS_DIAGNOSTICS_RULES = Object.freeze({ longRouteFraction: 0.75 });
/** A continuous time-budget index, separate from binary threshold coverage. */
export function accessDiagnostics(report: DeepReadonly<ProfileMetrics>) {
  const categories = Object.entries(report.destinations).map(([id, metric]) => {
    const rows = report.perBuilding.map((home) => ({
      n: home.destinations[id]!.evaluatedResidents,
      t: home.destinations[id]!.travelSeconds,
    }));
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    const score = total
      ? (100 *
          rows.reduce(
            (sum, r) =>
              sum +
              r.n *
                (r.t === null
                  ? 0
                  : metric.thresholdSeconds === 0
                    ? r.t === 0
                      ? 1
                      : 0
                    : Math.max(0, 1 - r.t / metric.thresholdSeconds)),
            0,
          )) /
        total
      : null;
    let cumulative = 0,
      p90Seconds: number | null = null;
    for (const row of [...rows]
      .filter((r) => r.n > 0)
      .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))) {
      cumulative += row.n;
      if (cumulative >= total * 0.9) {
        p90Seconds = row.t;
        break;
      }
    }
    const longResidents = rows
      .filter(
        (r) => r.t === null || r.t > metric.thresholdSeconds * ACCESS_DIAGNOSTICS_RULES.longRouteFraction,
      )
      .reduce((sum, r) => sum + r.n, 0);
    return {
      id,
      score,
      p90Seconds,
      longResidents,
      thresholdSeconds: metric.thresholdSeconds,
      unreachable: metric.unreachableResidents,
    };
  });
  const valid = categories.map((c) => c.score).filter((s): s is number => s !== null);
  const problemResidents = report.perBuilding
    .filter((home) =>
      Object.entries(home.destinations).some(
        ([id, m]) =>
          m.evaluatedResidents > 0 &&
          (m.travelSeconds === null ||
            m.travelSeconds >
              report.destinations[id]!.thresholdSeconds * ACCESS_DIAGNOSTICS_RULES.longRouteFraction),
      ),
    )
    .reduce((sum, home) => sum + home.residents, 0);
  return {
    score: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    problemResidents,
    categories,
  };
}
