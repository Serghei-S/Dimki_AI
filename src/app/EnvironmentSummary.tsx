import type { Analysis } from './useAnalysis.js';
import { OBJECT_KINDS } from '../core/design-rules.js';
import type { Destination, DeepReadonly, DistrictData } from '../core/types.js';
import { accessDiagnostics, ACCESS_DIAGNOSTICS_RULES } from '../core/access-diagnostics.js';
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
  const diagnostic = accessDiagnostics(after),
    oldDiagnostic = accessDiagnostics(before);
  return (
    <section
      className={`environment-summary ${busy ? 'is-updating' : ''}`}
      aria-label="Среда и сравнение сценария"
      aria-busy={busy}
    >
      <div className="environment-cards">
        <div>
          <strong>
            {f(diagnostic.score)}
            <small> / 100</small>
          </strong>
          <span>Индекс близости · было {f(oldDiagnostic.score)}</span>
        </div>
        <div>
          <strong>{f(diagnostic.problemResidents)}</strong>
          <span>жителей с долгим или недоступным маршрутом</span>
        </div>
      </div>
      <p className="studio-note">
        Путь может укладываться в порог и оставаться долгим. Близость учитывает всё время пути, а не только
        попадание в порог. Здесь сравнивается постоянная доступность по сети; расписания посещений учитываются
        отдельно в потоке выбранного часа.
      </p>
      <details className="sidebar-detail">
        <summary>Как считаются показатели</summary>
        <p>
          Для каждого дома: max(0; 1 − время / порог) × 100, затем среднее с весом населения и равным весом
          пяти категорий. Долгим считается путь дольше {ACCESS_DIAGNOSTICS_RULES.longRouteFraction * 100}%
          бюджета времени; недостижимость тоже включена. Это явные правила индекса, не официальный норматив и
          не оценка всего качества жизни.
        </p>
        <p>
          В пределах порогов: в среднем {f(average)}%; все категории доступны{' '}
          {f(population ? (100 * complete) / population : null)}% жителей. Эти проценты сохраняются отдельно и
          не занижаются.
        </p>
      </details>
      <div className="access-problems">
        {diagnostic.categories
          .filter((c) => c.longResidents > 0)
          .sort((a, b) => b.longResidents - a.longResidents)
          .slice(0, 3)
          .map((c) => (
            <button key={c.id} onClick={() => onMetric(c.id)}>
              <strong>{OBJECT_KINDS[c.id as Destination['kind']]}</strong>
              <span>
                {f(c.longResidents)} жителей: путь дольше{' '}
                {f((c.thresholdSeconds * ACCESS_DIAGNOSTICS_RULES.longRouteFraction) / 60)} мин или недостижим
              </span>
            </button>
          ))}
      </div>
      {busy && (
        <p role="status" className="studio-note">
          Обновляем расчёт… Показан последний завершённый результат.
        </p>
      )}
      <h3>До и после · близость и время</h3>
      <div className="environment-table">
        <table>
          <thead>
            <tr>
              <th>Объект</th>
              <th>До / 100</th>
              <th>После / 100</th>
              <th>90% за, мин</th>
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
                  <small>
                    В пороге: {f(before.destinations[id]?.coveragePercent)} → {f(m.coveragePercent)}%
                  </small>
                </th>
                <td>{f(oldDiagnostic.categories.find((c) => c.id === id)?.score)}</td>
                <td>{f(diagnostic.categories.find((c) => c.id === id)?.score)}</td>
                <td>
                  {f(
                    diagnostic.categories.find((c) => c.id === id)?.p90Seconds == null
                      ? null
                      : diagnostic.categories.find((c) => c.id === id)!.p90Seconds! / 60,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="studio-note">
        «90% за» — время, за которое доберутся 90% жителей с учётом населения каждого дома. Прочерк означает,
        что достичь 90% невозможно или группа пуста.
      </p>
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
