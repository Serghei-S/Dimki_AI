import { useEffect, useState } from 'react';
import type { PlanningService } from './planning-service.js';
import type { ActivitySnapshot, DayType, ScenarioInput } from '../core/types.js';
export function useActivity(
  client: PlanningService | null,
  scenario: ScenarioInput,
  profileId: string,
  hour: number,
  dayType: DayType,
  includeRoutes: boolean,
) {
  const [value, setValue] = useState<{ scenario: ScenarioInput; snapshot: ActivitySnapshot } | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    setBusy(true);
    setError(null);
    const timer = setTimeout(() => {
      void client
        .activitySnapshot(scenario, profileId, { hour, dayType, includeRoutes }, controller.signal)
        .then((snapshot) => {
          if (!controller.signal.aborted) {
            setValue({ scenario, snapshot });
            setBusy(false);
          }
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            setError(err instanceof Error ? err.message : 'Не удалось рассчитать поток');
            setBusy(false);
          }
        });
    }, 80);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, scenario, profileId, hour, dayType, includeRoutes]);
  const snapshot =
    value?.scenario === scenario &&
    value.snapshot.profileId === profileId &&
    value.snapshot.hour === hour &&
    value.snapshot.dayType === dayType &&
    (!includeRoutes || !busy)
      ? value.snapshot
      : null;
  return { snapshot, busy, error };
}
