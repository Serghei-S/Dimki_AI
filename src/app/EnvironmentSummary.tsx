import type { Analysis } from './useAnalysis.js';
import { OBJECT_KINDS } from '../core/design-rules.js';
import type { Destination, DeepReadonly, DistrictData } from '../core/types.js';
const f = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
export function EnvironmentSummary({
  analysis,
  busy,
  onMetric,
  onCompare,
  baseData,
}: {
  analysis: Analysis | null;
  busy: boolean;
  onMetric: (id: string) => void;
  onCompare: () => void;
  baseData: DeepReadonly<DistrictData> | null;
}) {
  if (!analysis) return <p className="studio-note">Рассчитываем доступность района…</p>;
  const after = analysis.result.profiles[analysis.profileId]!,
    before = analysis.baseline.profiles[analysis.profileId]!;
  const metrics = Object.entries(after.destinations),
    valid = metrics.map(([, m]) => m.coveragePercent).filter((x): x is number => x !== null);
  const average = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  const population = after.perBuilding.reduce((s, b) => s + b.residents, 0);
  const complete = after.perBuilding
    .filter((b) => Object.values(b.destinations).every((m) => m.withinThreshold))
    .reduce((s, b) => s + b.residents, 0);
  const changes = analysis.result.changesFromBaseline[analysis.profileId];
  return (
    <section
      className={`environment-summary ${busy ? 'is-updating' : ''}`}
      aria-label="Среда и сравнение сценария"
      aria-busy={busy}
    >
      <div className="environment-cards">
        <div>
          <strong>{f(average)}%</strong>
          <span>Средняя доступность</span>
        </div>
        <div>
          <strong>{f(population ? (100 * complete) / population : null)}%</strong>
          <span>Все категории рядом</span>
        </div>
      </div>
      <p className="studio-note">
        Средняя доступность — среднее охвата пяти категорий. «Все рядом» — доля жителей, у которых каждая
        категория в пределах своего порога пешком. Это показатели модели, не оценка соблюдения обязательных
        норм.
      </p>
      {busy && (
        <p role="status" className="studio-note">
          Обновляем расчёт… Показан последний завершённый результат.
        </p>
      )}
      <h3>До и после · доступность</h3>
      <div className="environment-table">
        <table>
          <thead>
            <tr>
              <th>Объект</th>
              <th>До</th>
              <th>После</th>
              <th>Δ п.п.</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map(([id, m]) => (
              <tr key={id}>
                <th>
                  <button onClick={() => onMetric(id)}>
                    {OBJECT_KINDS[id as Destination['kind']] ?? id}
                  </button>
                  <small>до {f(m.thresholdSeconds / 60)} мин</small>
                </th>
                <td>{f(before.destinations[id]?.coveragePercent)}%</td>
                <td>{f(m.coveragePercent)}%</td>
                <td>{f(changes?.[id]?.coverageDeltaPercentagePoints)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="sidebar-detail">
        <summary>Кому стало ближе и дальше</summary>
        <p className="studio-note">
          Жители между категориями не суммируются. Потерявшие путь включены в число тех, кому стало дальше.
        </p>
        <div className="environment-table">
          <table>
            <thead>
              <tr>
                <th>Категория</th>
                <th>Ближе</th>
                <th>Дальше</th>
                <th>Потеряли путь</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map(([id]) => (
                <tr key={id}>
                  <th>{OBJECT_KINDS[id as Destination['kind']] ?? id}</th>
                  <td>{f(changes?.[id]?.improvedResidents)}</td>
                  <td>{f(changes?.[id]?.worsenedResidents)}</td>
                  <td>
                    {f(
                      after.perBuilding
                        .filter(
                          (b) =>
                            b.destinations[id]?.travelSeconds === null &&
                            before.perBuilding.find((old) => old.buildingId === b.buildingId)?.destinations[
                              id
                            ]?.travelSeconds != null,
                        )
                        .reduce((sum, b) => sum + b.residents, 0),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="sidebar-detail">
        <summary>Благоустройство и расходы</summary>
        <p>
          Изменения: {analysis.result.scenario.design?.objects.length ?? 0} объектов;{' '}
          {analysis.result.scenario.projectIds.length} проектов. Стоимость:{' '}
          {f(analysis.baseline.costs.capexRub)} → {f(analysis.result.costs.capexRub)} ₽ · условная оценка.
        </p>
        {(['parking', 'playground', 'waste_bin'] as const).map((kind) => (
          <p key={kind}>
            {OBJECT_KINDS[kind]}:{' '}
            {baseData?.destinations.filter((d) => d.active && d.kind === kind).length ?? 0} →{' '}
            {analysis.district.destinations.filter((d) => d.active && d.kind === kind).length} шт.
          </p>
        ))}
        <p className="studio-note">
          Парковка, площадка и урна не улучшают охват школ, медицины или транспорта. Расстояния к ним можно
          проверить в «Редактор → Анализ». Занятость парковок и сбор отходов не моделируются.
        </p>
      </details>
      <button className="secondary-button full-width" onClick={onCompare}>
        Показать изменения на карте
      </button>
    </section>
  );
}
