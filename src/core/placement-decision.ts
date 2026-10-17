import type { DeepReadonly, DesignAnalysisResult, Destination, ProfileMetrics } from './types.js';

export const STOP_ACCESS_REFERENCE = {
  distanceM: 500,
  title: 'СП 42.13330.2016, п. 11.24',
  url: 'https://mchs.gov.ru/uploads/document/2022-03-22/92f1282638e98bee41afcccdbc57f247.pdf',
};
export interface DecisionMetric {
  label: string;
  before: number | null;
  after: number | null;
  unit: string;
}
const f = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

/** Accessibility measures are resident-weighted, never hourly trips relabelled as people. */
export function placementDecision(
  comparison: DesignAnalysisResult,
  beforeProfile?: DeepReadonly<ProfileMetrics>,
  afterProfile?: DeepReadonly<ProfileMetrics>,
  unservedStop = false,
) {
  const before = comparison.comparisons[0],
    after = comparison.comparisons[1];
  if (!before || !after) throw new Error('Для оценки необходимы оба состояния');
  const kind: Destination['kind'] = comparison.kind;
  const threshold =
    kind === 'bus_stop' ? STOP_ACCESS_REFERENCE.distanceM : comparison.rules.distanceThresholdM;
  const oldRows = new Map(before.rows.map((r) => [r.buildingId, r]));
  let improved = 0,
    worsened = 0,
    gained = 0,
    lost = 0,
    common = 0,
    oldDistance = 0,
    newDistance = 0;
  for (const row of after.rows) {
    const old = oldRows.get(row.buildingId);
    if (!old || old.residents !== row.residents)
      throw new Error('Состав жителей в сравниваемых сценариях различается');
    if (old.distanceM === null && row.distanceM !== null) gained += row.residents;
    else if (old.distanceM !== null && row.distanceM === null) lost += row.residents;
    else if (old.distanceM !== null && row.distanceM !== null) {
      common += row.residents;
      oldDistance += old.distanceM * row.residents;
      newDistance += row.distanceM * row.residents;
      if (row.distanceM < old.distanceM - 1e-8) improved += row.residents;
      if (row.distanceM > old.distanceM + 1e-8) worsened += row.residents;
    }
  }
  const within = (rows: typeof before.rows) =>
    rows.reduce(
      (sum, r) => sum + (r.distanceM !== null && r.distanceM <= threshold + 1e-8 ? r.residents : 0),
      0,
    );
  const metrics: DecisionMetric[] = [
    {
      label: 'Средний путь для жителей, имеющих доступ в обоих состояниях',
      before: common ? oldDistance / common : null,
      after: common ? newDistance / common : null,
      unit: 'м',
    },
    {
      label: `Жители в пределах ${threshold} м${kind === 'bus_stop' ? ' (ориентир СП)' : ' (порог сценария)'}`,
      before: within(before.rows),
      after: within(after.rows),
      unit: 'чел.',
    },
    {
      label: 'Жители с доступным пешим маршрутом',
      before: before.totals.reachableResidents,
      after: after.totals.reachableResidents,
      unit: 'чел.',
    },
  ];
  // Time uses the fastest walking route; distance above uses the shortest accessible route.
  const oldHomes = new Map(beforeProfile?.perBuilding.map((b) => [b.buildingId, b]));
  let timeWeight = 0,
    oldSeconds = 0,
    newSeconds = 0;
  for (const home of afterProfile?.perBuilding ?? []) {
    const a = oldHomes.get(home.buildingId)?.destinations[kind],
      b = home.destinations[kind];
    if (a?.travelSeconds != null && b?.travelSeconds != null) {
      timeWeight += b.evaluatedResidents;
      oldSeconds += a.travelSeconds * b.evaluatedResidents;
      newSeconds += b.travelSeconds * b.evaluatedResidents;
    }
  }
  if (beforeProfile?.destinations[kind] && afterProfile?.destinations[kind])
    metrics.splice(1, 0, {
      label: 'Среднее время пешком для общей достижимой группы',
      before: timeWeight ? oldSeconds / timeWeight / 60 : null,
      after: timeWeight ? newSeconds / timeWeight / 60 : null,
      unit: 'мин',
    });
  const plus: string[] = [],
    minus: string[] = [];
  if (improved) plus.push(`Для ${f(improved)} жителей путь к ближайшему объекту стал короче.`);
  if (gained) plus.push(`${f(gained)} жителей получили ранее недоступный пеший маршрут.`);
  const coverageGain = within(after.rows) - within(before.rows);
  if (coverageGain > 0) plus.push(`В пределах ${threshold} м стало на ${f(coverageGain)} жителей больше.`);
  if (worsened) minus.push(`Для ${f(worsened)} жителей путь стал длиннее.`);
  if (lost) minus.push(`${f(lost)} жителей потеряли пешую доступность.`);
  if (coverageGain < 0)
    minus.push(`Охват в пределах ${threshold} м сократился на ${f(-coverageGain)} жителей.`);
  const outside = after.totals.evaluatedResidents - within(after.rows);
  if (outside > 0)
    minus.push(
      `${f(outside)} жителей остаются за пределами ${threshold} м или без доступного пути. ${kind === 'bus_stop' ? 'Это ограничение охвата по ориентиру СП, а не заключение о нарушении СанПиН.' : 'Используется порог текущего сценария.'}`,
    );
  if (after.costRub > before.costRub)
    minus.push(`Дополнительные затраты по модели: ${f(after.costRub - before.costRub)} ₽.`);
  if (unservedStop)
    minus.push(
      'У новой остановки нет известной автобусной линии. Пешеходный подход можно оценить, но рейсы, ожидание и рост пассажиропотока не подтверждены.',
    );
  const benefit = improved > 0 || gained > 0 || coverageGain > 0;
  const conclusion = !benefit
    ? 'По доступности решение не даёт улучшения. Оптимальность не подтверждена: стоит проверить другое место.'
    : worsened > 0 || lost > 0 || coverageGain < 0
      ? 'Решение имеет плюсы и минусы для жителей. Рекомендовать его как оптимальное пока нельзя.'
      : unservedStop
        ? 'Место улучшает пешую доступность, но решение пока нельзя признать оптимальным: требуется назначить автобусную линию и проверить санитарные условия.'
        : 'По пешей доступности решение полезно. Оптимальность не доказана: нужны сравнение альтернативных мест и санитарная проверка.';
  return { metrics, improved, worsened, gained, lost, plus, minus, conclusion, threshold };
}
