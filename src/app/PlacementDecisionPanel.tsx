import { useEffect, useRef, useState } from 'react';
import type { Destination, ScenarioInput } from '../core/types.js';
import type { PlanningService } from './planning-service.js';
import { OBJECT_KINDS } from '../core/design-rules.js';
import { placementDecision, STOP_ACCESS_REFERENCE } from '../core/placement-decision.js';

const f = (n: number | null) => (n === null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 1 }));
export function PlacementDecisionPanel({
  client,
  before,
  after,
  kind,
  profileId,
  preview,
}: {
  client: PlanningService | null;
  before: ScenarioInput;
  after: ScenarioInput;
  kind: Destination['kind'];
  profileId: string;
  preview: boolean;
}) {
  const key = JSON.stringify({ before, after, kind, profileId });
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'nearest' });
  }, [key]);
  const [result, setResult] = useState<{ key: string; value: ReturnType<typeof placementDecision> } | null>(
    null,
  );
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.all([
        client.analyzeDesign(
          {
            scenario: before,
            profileId,
            kind,
            mode: 'compare',
            scenarios: [
              { name: 'До', scenario: before },
              { name: 'После', scenario: after },
            ],
          },
          { signal: controller.signal },
        ),
        client.evaluate(before, [profileId], controller.signal),
        client.evaluate(after, [profileId], controller.signal),
      ])
        .then(([comparison, oldEvaluation, newEvaluation]) => {
          if (controller.signal.aborted) return;
          const oldObjects = new Map(before.design?.objects.map((o) => [o.id, JSON.stringify(o)]));
          const changedIds = new Set(
            after.design?.objects
              .filter((o) => o.active && o.kind === kind && oldObjects.get(o.id) !== JSON.stringify(o))
              .map((o) => o.id),
          );
          const unservedStop =
            kind === 'bus_stop' &&
            newEvaluation.districtChanges.destinations.some(
              (d) => changedIds.has(d.id) && !d.routeIds.length,
            );
          setResult({
            key,
            value: placementDecision(
              comparison,
              oldEvaluation.profiles[profileId],
              newEvaluation.profiles[profileId],
              unservedStop,
            ),
          });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setFailure({ key, message: error instanceof Error ? error.message : String(error) });
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, key]);
  const value = result?.key === key ? result.value : null;
  return (
    <section
      ref={panel}
      className="placement-decision"
      aria-label={`Оценка размещения: ${OBJECT_KINDS[kind]}`}
      aria-busy={!value && failure?.key !== key}
    >
      <h2>
        {OBJECT_KINDS[kind]} · {preview ? 'оценка нового места' : 'результат размещения'}
      </h2>
      {failure?.key === key ? (
        <p role="alert">Не удалось оценить место: {failure.message}</p>
      ) : !value ? (
        <p role="status">Сравниваем маршруты жителей до и после…</p>
      ) : (
        <>
          <h3>Плюсы для жителей</h3>
          {value.plus.length ? (
            <ul>
              {value.plus.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p>Улучшений пешей доступности в этом месте не найдено.</p>
          )}
          <h3>Минусы и условия реализации</h3>
          {value.minus.length ? (
            <ul>
              {value.minus.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p>Ухудшений рассчитанной пешей доступности нет.</p>
          )}
          <h3>СанПиН и нормативы</h3>
          {kind === 'bus_stop' && (
            <p>
              <a href={STOP_ACCESS_REFERENCE.url} target="_blank" rel="noreferrer">
                {STOP_ACCESS_REFERENCE.title}
              </a>
              : общий ориентир подхода к остановке — {value.threshold} м. Климатические исключения и местные
              НГП требуют проверки; таблица оценивает только путь от жилых домов.
            </p>
          )}
          <p>
            <a href="https://zpp.rospotrebnadzor.ru/news/federal/512693" target="_blank" rel="noreferrer">
              СанПиН 1.2.3685-21 и 2.1.3684-21
            </a>
            : санитарная безопасность не подтверждена. В модели нет измерений шума, загрязнения воздуха и
            данных о санитарном содержании территории. Соблюдение этих требований нельзя определить по точке
            на карте.
          </p>
          <div className="environment-table">
            <table>
              <caption>Доступность {OBJECT_KINDS[kind].toLowerCase()}: до и после</caption>
              <thead>
                <tr>
                  <th>Показатель</th>
                  <th>До</th>
                  <th>После</th>
                  <th>Разница</th>
                </tr>
              </thead>
              <tbody>
                {value.metrics.map((m) => (
                  <tr key={m.label}>
                    <th>
                      {m.label}, {m.unit}
                    </th>
                    <td>{f(m.before)}</td>
                    <td>{f(m.after)}</td>
                    <td>
                      {m.before === null || m.after === null
                        ? '—'
                        : `${m.after > m.before ? '+' : ''}${f(m.after - m.before)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="placement-verdict" role="status">
            <strong>Вывод: </strong>
            {value.conclusion}
          </p>
          <p className="studio-note">
            Число выигравших жителей считается по домам, без суммирования поездок. Расстояние — кратчайший
            доступный путь; время — самый быстрый. Население и затраты в исходном наборе модельные.
          </p>
        </>
      )}
    </section>
  );
}
