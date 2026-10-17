import type { ActivityComparison, DayType } from '../core/types.js';
import { PURPOSE_NAMES } from '../core/daily-activity.js';

const f = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const min = (n: number | null | undefined) => (n == null ? '—' : `${f(n / 60)} мин`);
const distance = (n: number | null | undefined) => (n == null ? '—' : `${f(n)} м`);
const sign = (n: number | null | undefined, unit = '') =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${f(n)}${unit}`;

export function ActivityComparisonPanel({
  value,
  hour,
  dayType,
}: {
  value: ActivityComparison | null;
  hour: number;
  dayType: DayType;
}) {
  if (!value) return null;
  const s = value.summary;
  return (
    <section className="activity-comparison" aria-label="Автоматическое сравнение потоков">
      <div className="section-heading">
        <div>
          <span className="eyebrow"><span /> Сценарное сравнение</span>
          <h2>До и после добавления объекта</h2>
        </div>
        <small>{String(hour).padStart(2, '0')}:00 · {dayType === 'weekday' ? 'будний день' : 'выходной'}</small>
      </div>
      <p className="studio-note">
        Расчёт выполнен по текущей территории, профилю передвижения и выбранному часу. Значения — ожидаемые
        поездки за час; они пересчитываются при смене времени, типа дня или профиля.
      </p>
      <p className="studio-note">На карте стрелки показывают преобладающее направление вдоль участка сети. Зелёные участки сократили поток, красные получили дополнительную нагрузку. Без автобусной линии новая остановка не изменяет моделируемые поездки к транспорту.</p>
      <div className="environment-table">
        <table>
          <thead><tr><th>Показатель</th><th>До</th><th>После</th><th>Изменение</th></tr></thead>
          <tbody>
            <tr><th>Население территории (не охват)</th><td>{f(s.populationBefore)}</td><td>{f(s.populationAfter)}</td><td>{sign(s.populationAfter - s.populationBefore)}</td></tr>
            <tr><th>Планируемые поездки / ч</th><td>{f(s.plannedTripsBefore)}</td><td>{f(s.plannedTripsAfter)}</td><td>{sign(s.plannedTripsAfter - s.plannedTripsBefore)}</td></tr>
            <tr><th>Обслуженные поездки / ч</th><td>{f(s.servedTripsBefore)}</td><td>{f(s.servedTripsAfter)}</td><td>{sign(s.servedTripsAfter - s.servedTripsBefore)}</td></tr>
            <tr><th>Поездки по новым направлениям / ч</th><td>—</td><td>{f(s.newlyServedTrips)}</td><td>новый маршрут</td></tr>
            <tr><th>Поездки с меньшим временем пути / ч</th><td>—</td><td>{f(s.shorterRouteTrips)}</td><td>улучшение</td></tr>
            <tr><th>Среднее расстояние маршрута</th><td>{distance(s.meanDistanceBeforeM)}</td><td>{distance(s.meanDistanceAfterM)}</td><td>{sign(s.meanDistanceDeltaM, ' м')}</td></tr>
            <tr><th>Среднее время маршрута</th><td>{min(s.meanSecondsBefore)}</td><td>{min(s.meanSecondsAfter)}</td><td>{sign(s.meanSecondsDelta == null ? null : s.meanSecondsDelta / 60, ' мин')}</td></tr>
          </tbody>
        </table>
      </div>
      <details open>
        <summary>Нагрузка на объекты и расчётная вместимость</summary>
        <div className="environment-table">
          <table>
            <thead><tr><th>Объект</th><th>Вместимость</th><th>До, поездок / ч</th><th>После, поездок / ч</th><th>На сети после</th><th>Нагрузка после</th></tr></thead>
            <tbody>{value.objects.map((object) => (
              <tr key={object.objectId}>
                <th>{object.name}<small>{object.kind}</small></th>
                <td>{f(object.capacity)}</td><td>{f(object.tripsBefore)}</td><td>{f(object.tripsAfter)}</td><td>{f(object.onNetworkAfter)}</td>
                <td>{object.loadPercentAfter == null ? 'нет заданной вместимости' : `${f(object.loadPercentAfter)}%`}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      <details open>
        <summary>Маршруты: люди, время и расстояние</summary>
        <div className="environment-table">
          <table>
            <thead><tr><th>Направление</th><th>Людей / ч</th><th>До</th><th>После</th><th>Разница</th></tr></thead>
            <tbody>{value.routes.filter((route) => route.tripsBefore > 0 || route.tripsAfter > 0).slice(0, 80).map((route) => (
              <tr key={route.key}>
                <th>{PURPOSE_NAMES[route.purpose]} · {route.direction === 'outbound' ? 'к объекту' : 'домой'}<small>{route.buildingId}</small></th>
                <td>{f(route.tripsAfter || route.tripsBefore)}</td>
                <td>{min(route.secondsBefore)} / {distance(route.distanceBeforeM)}</td>
                <td>{min(route.secondsAfter)} / {distance(route.distanceAfterM)}</td>
                <td>{route.newRoute ? 'новый' : route.lostRoute ? 'исчез' : sign(route.secondsDelta, ' с')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      <p className="studio-note">Охват жителей и нормативные условия размещения приведены в карточке решения выше. Почасовые поездки не используются как число жителей, обеспеченных нормативной доступностью.</p>
      <details>
        <summary>Изменение потоков на участках карты</summary>
        <div className="environment-table">
          <table>
            <thead><tr><th>Участок</th><th>До</th><th>После</th><th>Разница</th><th>Направления после</th></tr></thead>
            <tbody>{value.edges.filter((edge) => Math.abs(edge.delta) > 1e-8).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 80).map((edge) => (
              <tr key={edge.edgeId}><th>{edge.edgeId}</th><td>{f(edge.loadBefore)}</td><td>{f(edge.loadAfter)}</td><td>{sign(edge.delta)}</td><td>→ {f(edge.forwardAfter)} · ← {f(edge.backwardAfter)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
