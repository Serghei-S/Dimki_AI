import type { Analysis } from './useAnalysis.js';
import { OBJECT_KINDS } from '../core/design-rules.js';
import type { Destination } from '../core/types.js';
import { accessDiagnostics, ACCESS_DIAGNOSTICS_RULES } from '../core/access-diagnostics.js';
const f = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
export function EnvironmentSummary({
  analysis,
  busy,
  onMetric,
  onCompare,
}: {
  analysis: Analysis | null;
  busy: boolean;
  onMetric: (id: string) => void;
  onCompare: () => void;
}) {
  if (!analysis) return <p className="studio-note">Рассчитываем доступность района…</p>;
  const after = accessDiagnostics(analysis.result.profiles[analysis.profileId]!);
  const before = accessDiagnostics(analysis.baseline.profiles[analysis.profileId]!);
  return (
    <section
      className={`environment-summary ${busy ? 'is-updating' : ''}`}
      aria-label="Среда и сравнение сценария"
      aria-busy={busy}
    >
      <p className="studio-note">До — исходный район; после — ваш сценарий.</p>
      <div className="environment-cards">
        <article>
          <h3>Индекс близости</h3>
          <div className="environment-values">
            <div>
              <span>До</span>
              <strong>
                {f(before.score)}
                <small> / 100</small>
              </strong>
            </div>
            <div>
              <span>После</span>
              <strong>
                {f(after.score)}
                <small> / 100</small>
              </strong>
            </div>
          </div>
        </article>
        <article>
          <h3>Жители с трудным доступом</h3>
          <div className="environment-values">
            <div>
              <span>До</span>
              <strong>
                {f(before.problemResidents)}
                <small> чел.</small>
              </strong>
            </div>
            <div>
              <span>После</span>
              <strong>
                {f(after.problemResidents)}
                <small> чел.</small>
              </strong>
            </div>
          </div>
        </article>
      </div>
      <div className="environment-explanations">
        <h3>Что означают показатели</h3>
        <p>
          <b>Чем выше, тем ближе нужные объекты.</b> Для каждого дома: 100 × max(0; 1 − время пути / порог).
          Если пути нет, оценка равна нулю. Затем считаем среднее с учётом числа жителей и равным весом
          категорий объектов.
        </p>
        <p>
          <b>Чем меньше, тем лучше.</b> Суммируем жителей домов, где хотя бы до одной категории объектов нет
          пути или путь занимает больше {f(ACCESS_DIAGNOSTICS_RULES.longRouteFraction * 100)}% её порога
          времени. Жителей каждого дома учитываем один раз.
        </p>
      </div>
      {busy && (
        <p role="status" className="studio-note">
          Обновляем расчёт… Пока показан предыдущий результат.
        </p>
      )}
      <details className="sidebar-detail">
        <summary>По категориям объектов</summary>
        <div className="environment-table">
          <table>
            <thead>
              <tr>
                <th>Объект</th>
                <th>До / 100</th>
                <th>После / 100</th>
              </tr>
            </thead>
            <tbody>
              {after.categories.map((category) => (
                <tr key={category.id}>
                  <th>
                    <button onClick={() => onMetric(category.id)}>
                      {OBJECT_KINDS[category.id as Destination['kind']] ?? category.id}
                    </button>
                    <small>Порог: {f(category.thresholdSeconds / 60)} мин</small>
                  </th>
                  <td>{f(before.categories.find((c) => c.id === category.id)?.score)}</td>
                  <td>{f(category.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="studio-note">
        Это оценка доступности по сети, а не проверка СанПиН. Пороги заданы моделью; население расчётное.
        Поток людей по часам считается отдельно.
      </p>
      <button className="secondary-button full-width" onClick={onCompare}>
        Показать изменения на карте
      </button>
    </section>
  );
}
