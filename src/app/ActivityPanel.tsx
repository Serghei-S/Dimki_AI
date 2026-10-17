import type { ActivitySnapshot, DayType } from '../core/types.js';
import { ACTIVITY_RULES, PURPOSE_NAMES } from '../core/daily-activity.js';
const f = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
export function ActivityPanel({
  value,
  busy,
  error,
  hour,
  dayType,
  onHour,
  onDay,
}: {
  value: ActivitySnapshot | null;
  busy: boolean;
  error: string | null;
  hour: number;
  dayType: DayType;
  onHour: (h: number) => void;
  onDay: (d: DayType) => void;
}) {
  return (
    <details className="activity-panel">
      <summary>
        {String(hour).padStart(2, '0')}:00 · {dayType === 'weekday' ? 'Будний день' : 'Выходной'}
        <small>
          {busy
            ? 'Пересчитываем поток…'
            : value
              ? `≈ ${f(value.expectedOnNetwork)} человек на сети`
              : 'Поток недоступен'}
        </small>
      </summary>
      <div className="activity-time-options">
        {[
          [8, 'Утро'],
          [14, 'День'],
          [18, 'Вечер'],
          [23, 'Ночь'],
        ].map(([h, label]) => (
          <button key={h} aria-pressed={hour === h} onClick={() => onHour(Number(h))}>
            {label}
          </button>
        ))}
      </div>
      <label>
        Тип дня
        <select value={dayType} onChange={(e) => onDay(e.target.value as DayType)}>
          <option value="weekday">Будний день</option>
          <option value="weekend">Выходной</option>
        </select>
      </label>
      {error && <p className="inline-error">{error}</p>}
      {value && (
        <>
          <div className="environment-table">
            <table>
              <thead>
                <tr>
                  <th>Цель</th>
                  <th>К объекту / ч</th>
                  <th>Домой / ч</th>
                </tr>
              </thead>
              <tbody>
                {value.purposes.map((p) => (
                  <tr key={p.id}>
                    <th>{PURPOSE_NAMES[p.id]}</th>
                    <td>{f(p.outbound)}</td>
                    <td>{f(p.homeward)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Не обеспечено маршрутом или часами работы: {f(value.unservedTrips)} планируемых отправлений за
            час.
          </p>
          <p>
            Цвет рёбер: все цели вместе, проходов/час. Верх шкалы — {ACTIVITY_RULES.flowDisplayScale}{' '}
            проходов/час, а не пропускная способность. Фигуры — выборка текущих перемещений, не всё население.
          </p>
          <details>
            <summary>Правила расписания и допущения</summary>
            <p>
              Учащиеся: ≈ {Math.round(ACTIVITY_RULES.schoolAgeShareOfUnder18 * 100)}% группы до 18 лет ×{' '}
              {ACTIVITY_RULES.schoolAttendance * 100}% посещения. Работают{' '}
              {ACTIVITY_RULES.employedAdultShare * 100}% взрослых; в выходной —{' '}
              {ACTIVITY_RULES.weekendWorkShare * 100}% этой группы. Локальные рабочие направления —{' '}
              {ACTIVITY_RULES.localWorkShare * 100}% работающих.
            </p>
            <p>
              Прибытие в школу: 07:45–08:30; домой: 13:30–15:30. Работа: прибытие 08:00–09:30, возвращение с
              17:00 до 19:00. Покупки и отдых работающих — после возвращения. В выходной нет обычных школьных
              поездок.
            </p>
            <p>Доли дополнительных посещений за день:</p>
            <div className="environment-table">
              <table>
                <thead>
                  <tr>
                    <th>Группа</th>
                    <th>Покупки</th>
                    <th>Отдых</th>
                    <th>Врач</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(ACTIVITY_RULES.discretionary).map(([id, rates]) => (
                    <tr key={id}>
                      <th>
                        {
                          {
                            worker: 'Работающие',
                            student: 'Учащиеся',
                            other: 'Остальные',
                            senior: 'Пожилые',
                          }[id]
                        }
                      </th>
                      {(['shopping', 'park', 'clinic'] as const).map((p) => (
                        <td key={p}>{f(rates[p] * 100)}%</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              В выходной частота покупок умножается на {f(ACTIVITY_RULES.weekendVisitMultipliers.shopping)},
              отдыха — на {f(ACTIVITY_RULES.weekendVisitMultipliers.park)}, медицины — на{' '}
              {f(ACTIVITY_RULES.weekendVisitMultipliers.clinic)}. Цели — альтернативы: их суммарная доля в
              каждой группе меньше 100%.
            </p>
            <details>
              <summary>Все параметры расчёта</summary>
              <pre>{JSON.stringify(ACTIVITY_RULES, null, 2)}</pre>
            </details>
            <p>
              Время пребывания: покупки {ACTIVITY_RULES.dwellHours.shopping * 60} мин, парк{' '}
              {ACTIVITY_RULES.dwellHours.park * 60} мин, медицина {ACTIVITY_RULES.dwellHours.clinic * 60} мин.
              Обратный выход после этого времени и подхода к объекту. Для неизвестных расписаний приняты
              интервалы: школа 07–17, магазин 08–22, парк 06–23, медицина 08–20.
            </p>
            {value.assumptions.map((a, i) => (
              <p key={i}>{a}</p>
            ))}
          </details>
        </>
      )}
    </details>
  );
}
