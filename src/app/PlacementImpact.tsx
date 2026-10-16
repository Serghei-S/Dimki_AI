import type { Analysis } from './useAnalysis.js';
import type { DeepReadonly, DistrictData, Destination } from '../core/types.js';
import {
  OBJECT_KINDS,
  DEFAULT_DESIGN_RULES,
  DESIGN_COSTS,
  CAPACITY_FACTORS,
  STOP_HEADWAYS,
  MOVE_COST_RUB,
  REMOVE_COST_RUB,
} from '../core/design-rules.js';
import { useMemo } from 'react';
import { segmentEntersPolygon } from '../core/design-geometry.js';
import type { XY } from '../core/types.js';

const format = (value: number | null | undefined) =>
  value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
function download(contents: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (value: unknown) => {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export function PlacementImpact({
  analysis,
  busy,
  error,
  selectedId,
  kind,
  baseData,
  onSelect,
  compact,
  baselineView,
}: {
  analysis: Analysis | null;
  busy: boolean;
  error: string | null;
  selectedId: string | null;
  kind: Destination['kind'];
  baseData: DeepReadonly<DistrictData> | null;
  onSelect: (id: string | null) => void;
  compact: boolean;
  baselineView: boolean;
}) {
  const report = analysis?.result.profiles[analysis.profileId];
  const baseline = analysis?.baseline.profiles[analysis.profileId];
  const selected = analysis?.district.destinations.find((d) => d.id === selectedId);
  const catchment = selected
    ? report?.serviceCatchments[selected.kind]?.find((c) => c.objectId === selectedId)
    : null;
  const metric = report?.destinations[kind],
    initial = baseline?.destinations[kind];
  const changes = analysis?.result.changesFromBaseline[analysis.profileId];
  const conflicts = useMemo(() => {
    const polygon = analysis?.district.parcels.find((p) => p.id === selected?.parcelId)?.polygon;
    if (selected?.kind !== 'park' || !polygon || !analysis) return null;
    const xs = polygon.map((p) => p[0]),
      ys = polygon.map((p) => p[1]);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const overlaps = (ring: readonly (readonly number[])[]) => {
      if (
        ring.every((p) => p[0]! < bounds[0]!) ||
        ring.every((p) => p[0]! > bounds[2]!) ||
        ring.every((p) => p[1]! < bounds[1]!) ||
        ring.every((p) => p[1]! > bounds[3]!)
      )
        return false;
      return (
        polygon.slice(1).some((b, i) => segmentEntersPolygon([...polygon[i]!] as XY, [...b] as XY, ring)) ||
        ring.slice(1).some((b, i) => segmentEntersPolygon([...ring[i]!] as XY, [...b] as XY, polygon))
      );
    };
    return {
      buildings: analysis.district.buildings.filter((b) => overlaps(b.polygon)).length,
      roads: analysis.district.roads.filter((r) => overlaps(r.polygon)).length,
    };
  }, [analysis, selected]);
  function exportCsv() {
    if (!analysis || !report || !baseline) return;
    const before = new Map(baseline.perBuilding.map((b) => [b.buildingId, b]));
    const names = new Map(analysis.district.buildings.map((b) => [b.id, b.name]));
    const rows: unknown[][] = [
      [
        'dataset_id',
        'dataset_sha256',
        'profile',
        'building_id',
        'building_name',
        'metric',
        'residents',
        'before_seconds',
        'after_seconds',
        'before_within',
        'after_within',
      ],
    ];
    for (const home of report.perBuilding)
      for (const [id, access] of Object.entries(home.destinations)) {
        const old = before.get(home.buildingId)!.destinations[id]!;
        rows.push([
          analysis.result.datasetId,
          analysis.result.datasetSha256,
          analysis.profileId,
          home.buildingId,
          names.get(home.buildingId),
          id,
          access.evaluatedResidents,
          old.travelSeconds,
          access.travelSeconds,
          old.withinThreshold,
          access.withinThreshold,
        ]);
      }
    download(
      '\ufeff' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n'),
      'obninsk-accessibility-by-building.csv',
      'text/csv;charset=utf-8',
    );
  }
  return (
    <section className="placement-impact" aria-label="Результат пересчёта">
      <details className="placement-result" open={!compact}>
        <summary>Результат размещения</summary>
        {baselineView && (
          <p className="placement-warning" role="status">
            Показано исходное состояние. Переключите карту на «После», чтобы оценить внесённые изменения.
          </p>
        )}
        {error ? (
          <p className="inline-error" role="alert">
            Изменение не рассчитано: {error}. Показатели предыдущего положения не используются.
          </p>
        ) : busy || !analysis || !report || !baseline ? (
          <p className="studio-note" role="status">
            Пересчитываем маршруты и показатели…
          </p>
        ) : (
          <>
            <p className="studio-note">Сравнение с исходным районом · тот же профиль движения.</p>
            {conflicts && (conflicts.buildings > 0 || conflicts.roads > 0) && (
              <p className="placement-warning" role="status">
                Контур затрагивает здания: {conflicts.buildings}, проезжие части: {conflicts.roads}. Площадь и
                вместимость такого контура условные. Исправьте границу перед оценкой реализации.
              </p>
            )}
            {metric && initial && (
              <div className="placement-kpis">
                <div>
                  <strong>{format(metric.coveragePercent)}%</strong>
                  <span>в пределах {format(metric.thresholdSeconds / 60)} мин</span>
                  <small>было {format(initial.coveragePercent)}%</small>
                </div>
                <div>
                  <strong>
                    {format(
                      metric.meanSecondsReachableOnly === null ? null : metric.meanSecondsReachableOnly / 60,
                    )}{' '}
                    мин
                  </strong>
                  <span>средний пеший путь</span>
                  <small>
                    было{' '}
                    {format(
                      initial.meanSecondsReachableOnly === null
                        ? null
                        : initial.meanSecondsReachableOnly / 60,
                    )}{' '}
                    мин
                  </small>
                </div>
              </div>
            )}
            {changes?.[kind] && (
              <p className="placement-change">
                Ближе: <b>{format(changes[kind]!.improvedResidents)}</b> жителей · дальше:{' '}
                <b>{format(changes[kind]!.worsenedResidents)}</b>
              </p>
            )}
            {catchment && selected && (
              <details className="placement-catchment" open>
                <summary>Зона обслуживания объекта</summary>
                <p>
                  {format(catchment.assignedResidents)} жителей домов, для которых этот вход быстрее всего
                  достижим пешком; {format(catchment.withinThresholdResidents)} — в пределах временного
                  порога.
                </p>
                <p>
                  Эффективная вместимость: <strong>{format(catchment.effectiveCapacity)}</strong>
                  {catchment.effectiveCapacity === null ? ' · данных нет' : ''}.
                </p>
                {selected.kind === 'school' && (
                  <p>
                    До 18 лет в зоне: {format(catchment.under18Residents)}. Это не число школьников: для
                    расчёта дефицита мест нужны школьные возраста, зачисление и сменность.
                  </p>
                )}
                {selected.kind === 'park' && catchment.effectiveCapacity !== null && (
                  <p>
                    Потенциальные жители / одновременная вместимость:{' '}
                    {catchment.effectiveCapacity === 0
                      ? catchment.assignedResidents
                        ? '∞'
                        : '0'
                      : format((100 * catchment.assignedResidents) / catchment.effectiveCapacity)}
                    %. Это стресс-сценарий одновременного посещения всей зоны, а не фактическая загрузка
                    парка.
                  </p>
                )}
                {selected.kind === 'bus_stop' && (
                  <p>
                    Зона остановки не равна пассажиропотоку. Новый вход сам по себе не создаёт автобусные
                    маршруты и рейсы.
                  </p>
                )}
                <p>
                  Вместимость не меняет длину улиц и пешую доступность. Занятость, очереди и перераспределение
                  посетителей не рассчитаны.
                </p>
              </details>
            )}
            <details className="placement-all-metrics">
              <summary>Все показатели и расчёт по домам</summary>
              {Object.entries(report.destinations).map(([id, value]) => {
                const old = baseline.destinations[id]!,
                  change = changes?.[id];
                return (
                  <details key={id}>
                    <summary>
                      {OBJECT_KINDS[id as Destination['kind']] ?? id}{' '}
                      <b>
                        {format(old.coveragePercent)} → {format(value.coveragePercent)}%
                      </b>
                    </summary>
                    <p>
                      Порог: {format(value.thresholdSeconds / 60)} мин. Достижимы{' '}
                      {format(value.reachableResidents)} из {format(value.evaluatedPopulation)}; до изменения
                      — {format(old.reachableResidents)}. Выиграли {format(change?.improvedResidents)},
                      проиграли {format(change?.worsenedResidents)}.
                    </p>
                    <p>
                      Среднее время считается только по достижимым жителям. Если состав достижимых изменился,
                      сравнивайте также потери доступа и строки домов.
                    </p>
                    <div className="placement-building-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Дом</th>
                            <th>Жители</th>
                            <th>До, мин</th>
                            <th>После, мин</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.perBuilding.map((home, index) => {
                            const a = baseline.perBuilding[index]!.destinations[id]!,
                              b = home.destinations[id]!;
                            return (
                              <tr key={home.buildingId}>
                                <th>
                                  <button onClick={() => onSelect(home.buildingId)}>
                                    {analysis.district.buildings.find((h) => h.id === home.buildingId)
                                      ?.name ?? home.buildingId}
                                  </button>
                                </th>
                                <td>{format(b.evaluatedResidents)}</td>
                                <td>{format(a.travelSeconds === null ? null : a.travelSeconds / 60)}</td>
                                <td>{format(b.travelSeconds === null ? null : b.travelSeconds / 60)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                );
              })}
              <p>
                «—» означает недостижимость. Время = длина / скорость профиля с поправкой на покрытие +
                ожидания переходов. Дома учитываются с весом их населения; выбирается лучший доступный вход.
                Профили описывают альтернативные условия для тех же жителей и не суммируются.
              </p>
              <div className="studio-tools">
                <button onClick={exportCsv}>Дома в CSV</button>
                <button
                  onClick={() =>
                    download(
                      JSON.stringify(
                        {
                          generatedAt: new Date().toISOString(),
                          interpretation:
                            'Potential network accessibility; not observed demand or an official forecast',
                          assumptions: {
                            metadata: baseData?.metadata,
                            profiles: baseData?.profiles,
                            metricDefinitions: baseData?.metricDefinitions,
                            designRules: analysis.result.scenario.design?.rules ?? DEFAULT_DESIGN_RULES,
                            capacityFactors: CAPACITY_FACTORS,
                            hypotheticalStopHeadwaysSeconds: STOP_HEADWAYS,
                            levelCostsRub: DESIGN_COSTS,
                            relocationCostRub: MOVE_COST_RUB,
                            removalCostRub: REMOVE_COST_RUB,
                          },
                          ...analysis.result,
                          baseline: analysis.baseline,
                          profileId: analysis.profileId,
                          selectedMetric: kind,
                          parkGeometryConflicts: conflicts,
                        },
                        null,
                        2,
                      ),
                      'obninsk-analysis.json',
                      'application/json',
                    )
                  }
                >
                  Отчёт JSON
                </button>
              </div>
            </details>
          </>
        )}
      </details>
      <details className="placement-quality">
        <summary>Достоверность данных и границы анализа</summary>
        <p>
          Население и возрастной состав домов смоделированы. Для центра Обнинска контуры зданий и часть
          объектов взяты из OSM; часть тротуаров и входов восстановлена алгоритмом. Район «Сосновый» полностью
          искусственный. Ширина, уклон, бордюры и доступность проходов требуют обследования.
        </p>
        <p>
          Сеть обрезана границей участка. Внешние объекты и маршруты могут изменить выводы, особенно рядом с
          границей. Отсутствие объекта в данных не доказывает его отсутствие в городе.
        </p>
        <p>
          Точечный объект — сценарный вход. Подбор участка под здание, право строительства, реальные мощности,
          режим работы и расписание транспорта здесь не подтверждаются. Парк задаётся контуром; короткий зазор
          между входом и его границей допускается по настройкам и не добавляется к расстоянию.
        </p>
        <p>
          Цвет нагрузки — один условный поход каждого жителя к ближайшей цели за цикл. Это показатель
          концентрации потенциальных маршрутов, без периода суток и фактических частот поездок.
        </p>
        <p>
          Для решений на местности нужны проверенные население и входы, объекты в окружающем буфере,
          обследованные пути, мощности учреждений и наблюдения спроса. До такой калибровки сравнение сценариев
          — предварительная оценка при заданных допущениях.
        </p>
        {baseData && (
          <p>
            Набор: {baseData.metadata.id} · версия {baseData.metadata.datasetVersion}. Исходный набор при
            редактировании не меняется.
          </p>
        )}
      </details>
    </section>
  );
}
