import type { DeepReadonly, DistrictData, ScenarioEvaluation } from '../core/types.js';
import { DEFAULT_DESIGN_RULES, OBJECT_KINDS, CAPACITY_FACTORS, STOP_HEADWAYS } from '../core/design-rules.js';
import { PLACEMENT_RULES } from '../core/placement.js';
import { stableKey } from '../core/util.js';

export interface ReportFact {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  method: string;
}
export interface ReportMetric {
  id: string;
  name: string;
  population: number;
  thresholdMinutes: number;
  beforeCoverage: number | null;
  afterCoverage: number | null;
  beforeMeanMinutes: number | null;
  afterMeanMinutes: number | null;
  commonMeanChangeMinutes: number | null;
  commonResidents: number;
  improved: number;
  worsened: number;
  gainedAccess: number;
  lostAccess: number;
  unreachable: number;
}
export interface AiFinding {
  title: string;
  text: string;
  evidenceIds: string[];
}
export interface AiNarrative {
  findings: AiFinding[];
  recommendations: AiFinding[];
  limitations: string[];
}
export interface AiResult {
  model: string;
  provider?: string;
  createdAt: string;
  question: string;
  mode: string;
  narrative: AiNarrative;
}
export interface PlanningReport {
  formatVersion: 1;
  snapshotKey: string;
  createdAt: string;
  district: string;
  datasetId: string;
  datasetSha256: string;
  datasetVersion: string;
  profileId: string;
  profileName: string;
  scenario: DeepReadonly<ScenarioEvaluation['scenario']>;
  facts: ReportFact[];
  metrics: ReportMetric[];
  changes: string[];
  limitations: string[];
  assumptions: object;
  buildings: {
    id: string;
    metric: string;
    residents: number;
    beforeSeconds: number | null;
    afterSeconds: number | null;
    beforeWithin: boolean;
    afterWithin: boolean;
  }[];
}
const minutes = (n: number | null) => (n === null ? null : n / 60);
export function makeReport(
  data: DeepReadonly<DistrictData>,
  result: DeepReadonly<ScenarioEvaluation>,
  baseline: DeepReadonly<ScenarioEvaluation>,
  profileId: string,
  createdAt = new Date().toISOString(),
): PlanningReport {
  const after = result.profiles[profileId],
    before = baseline.profiles[profileId];
  if (
    !after ||
    !before ||
    result.datasetSha256 !== baseline.datasetSha256 ||
    data.metadata.id !== result.datasetId
  )
    throw new Error('Несовместимые данные отчёта');
  const facts: ReportFact[] = [],
    buildings: PlanningReport['buildings'] = [];
  const fact = (id: string, label: string, value: number | null, unit: string, method: string) =>
    facts.push({ id, label, value, unit, method });
  fact(
    'population',
    'Население модели',
    after.evaluatedPopulation,
    'жителей',
    'Сумма населения жилых домов. Население моделируется, это не перепись.',
  );
  fact(
    'capex',
    'Стоимость изменений',
    result.costs.capexRub,
    '₽',
    'Стоимость проектов и редактирования по правилам модели. Условные цены.',
  );
  fact(
    'opex',
    'Ежегодное содержание',
    result.costs.annualOpexRub,
    '₽/год',
    'Сумма годовых расходов объектов по правилам модели.',
  );
  fact('budget', 'Бюджет', result.scenario.budgetRub, '₽', 'Бюджет текущего сценария.');
  const oldHomes = new Map(before.perBuilding.map((h) => [h.buildingId, h]));
  const metrics = Object.entries(after.destinations).map(([id, a]): ReportMetric => {
    const b = before.destinations[id]!;
    let commonResidents = 0,
      weightedChange = 0,
      gainedAccess = 0,
      lostAccess = 0;
    for (const home of after.perBuilding) {
      const now = home.destinations[id]!,
        old = oldHomes.get(home.buildingId)?.destinations[id];
      if (!old || old.evaluatedResidents !== now.evaluatedResidents)
        throw new Error('Изменился состав населения');
      const n = now.evaluatedResidents;
      if (old.travelSeconds !== null && now.travelSeconds !== null) {
        commonResidents += n;
        weightedChange += (now.travelSeconds - old.travelSeconds) * n;
      }
      if (old.travelSeconds === null && now.travelSeconds !== null) gainedAccess += n;
      if (old.travelSeconds !== null && now.travelSeconds === null) lostAccess += n;
      buildings.push({
        id: home.buildingId,
        metric: id,
        residents: n,
        beforeSeconds: old.travelSeconds,
        afterSeconds: now.travelSeconds,
        beforeWithin: old.withinThreshold,
        afterWithin: now.withinThreshold,
      });
    }
    const change = result.changesFromBaseline[profileId]![id]!;
    const name = OBJECT_KINDS[id as keyof typeof OBJECT_KINDS] ?? id;
    const row: ReportMetric = {
      id,
      name,
      population: a.evaluatedPopulation,
      thresholdMinutes: a.thresholdSeconds / 60,
      beforeCoverage: b.coveragePercent,
      afterCoverage: a.coveragePercent,
      beforeMeanMinutes: minutes(b.meanSecondsReachableOnly),
      afterMeanMinutes: minutes(a.meanSecondsReachableOnly),
      commonMeanChangeMinutes: commonResidents ? weightedChange / commonResidents / 60 : null,
      commonResidents,
      improved: change.improvedResidents,
      worsened: change.worsenedResidents,
      gainedAccess,
      lostAccess,
      unreachable: a.unreachableResidents,
    };
    fact(
      `${id}.coverage.before`,
      `${name}: охват до`,
      row.beforeCoverage,
      '%',
      'Жители в пределах временного порога / население категории × 100.',
    );
    fact(
      `${id}.coverage.after`,
      `${name}: охват после`,
      row.afterCoverage,
      '%',
      'Тот же временной порог и группа населения, что в исходном состоянии.',
    );
    fact(
      `${id}.threshold`,
      `${name}: временной порог`,
      row.thresholdMinutes,
      'мин',
      'Настройка основной метрики; не путать с отдельным порогом редактора в метрах.',
    );
    fact(
      `${id}.mean.before`,
      `${name}: среднее время до`,
      row.beforeMeanMinutes,
      'мин',
      'Средневзвешенное по населению, только для достижимых домов.',
    );
    fact(
      `${id}.mean.after`,
      `${name}: среднее время после`,
      row.afterMeanMinutes,
      'мин',
      'Средневзвешенное по населению, только для достижимых домов; состав достижимых мог измениться.',
    );
    fact(
      `${id}.change`,
      `${name}: изменение времени для общей группы`,
      row.commonMeanChangeMinutes,
      'мин',
      'Средневзвешенное (после − до) только по жителям, достижимым в обоих состояниях. Минус — улучшение.',
    );
    fact(
      `${id}.common`,
      `${name}: общая достижимая группа`,
      commonResidents,
      'жителей',
      'Жители домов, достижимых до и после.',
    );
    fact(
      `${id}.improved`,
      `${name}: путь улучшился`,
      row.improved,
      'жителей',
      'Сравнение времени по каждому дому с учётом населения категории; включает новую достижимость.',
    );
    fact(
      `${id}.worsened`,
      `${name}: путь ухудшился`,
      row.worsened,
      'жителей',
      'Сравнение времени по каждому дому; включает потерю достижимости.',
    );
    fact(
      `${id}.gained`,
      `${name}: получили достижимость`,
      gainedAccess,
      'жителей',
      'Было недостижимо по сети, стало достижимо; это не обязательно доступ в пределах порога.',
    );
    fact(
      `${id}.lost`,
      `${name}: потеряли достижимость`,
      lostAccess,
      'жителей',
      'Было достижимо, стало недостижимо.',
    );
    fact(
      `${id}.unreachable`,
      `${name}: недостижимо после`,
      row.unreachable,
      'жителей',
      'Остаются в знаменателе охвата; не участвуют в среднем времени.',
    );
    return row;
  });
  const changes = result.scenario.projectIds.map((id) => data.projects.find((p) => p.id === id)?.name ?? id);
  for (const o of result.scenario.design?.objects ?? [])
    changes.push(`${o.active ? 'Изменение / размещение' : 'Удаление'}: ${OBJECT_KINDS[o.kind]} · ${o.name}`);
  for (const o of result.scenario.operationalOverrides ?? [])
    changes.push(`Операционное изменение: ${JSON.stringify(o)}`);
  return {
    formatVersion: 1,
    snapshotKey: stableKey({ datasetSha256: result.datasetSha256, scenario: result.scenario, profileId }),
    createdAt,
    district: data.metadata.name,
    datasetId: result.datasetId,
    datasetSha256: result.datasetSha256,
    datasetVersion: result.datasetVersion,
    profileId,
    profileName: data.profiles.find((p) => p.id === profileId)?.name ?? profileId,
    scenario: structuredClone(result.scenario),
    facts,
    metrics,
    changes,
    buildings,
    limitations: [
      ...data.metadata.limitations,
      'Условная оценка доступности, не официальный прогноз. Население, часть входов, параметры сети и цены требуют проверки на местности.',
      'Выигравшие и проигравшие в разных категориях могут быть одними и теми же жителями: суммировать их между категориями нельзя.',
      'Ближайший объект не гарантирует свободных мест. Вместимость не является измеренной посещаемостью; остановка не создаёт транспортный маршрут.',
      'Визуальная трава и деревья — оформление карты; они не увеличивают площадь общественных парков и не меняют расчёты.',
      'Отчёт не проверяет право строительства, все пересечения новых полигонов с препятствиями или полноту данных за границей района.',
    ],
    assumptions: {
      placementSketch: PLACEMENT_RULES,
      profile: data.profiles.find((p) => p.id === profileId),
      metricDefinitions: data.metricDefinitions,
      designRules: { ...DEFAULT_DESIGN_RULES, ...result.scenario.design?.rules },
      capacityFactors: CAPACITY_FACTORS,
      amenityCapacityFactors: [1, 1, 1],
      hypotheticalStopHeadwaysSeconds: STOP_HEADWAYS,
      source: data.metadata.source,
    },
  };
}
export function formatFact(fact: ReportFact): string {
  return `${fact.value === null ? 'нет данных' : fact.value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${fact.unit}`;
}
/** Only aggregates and explicit assumptions go to the external model, never building rows or geometry. */
export function aiContext(report: PlanningReport) {
  return {
    district: report.district,
    profile: report.profileName,
    facts: report.facts,
    changes: report.changes,
    limitations: report.limitations,
    assumptions: report.assumptions,
  };
}
