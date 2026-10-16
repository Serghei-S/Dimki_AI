import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import {
  Plus,
  MousePointer2,
  Move,
  Trash2,
  MapPin,
  Settings2,
  LoaderCircle,
  X,
  Check,
  Undo2,
} from 'lucide-react';
import type {
  DeepReadonly,
  DistrictData,
  ScenarioInput,
  ScenarioEnvelope,
  EditableObject,
  Destination,
  XY,
  DesignAnalysisResult,
  DesignAnalysisInput,
  DesignRules,
  DistanceRow,
} from '../core/types.js';
import type { PlanningService } from './planning-service.js';
import type { EditorView, EditorEvents, EditorTool, EditorDrag } from '../map/editor-types.js';
import {
  DEFAULT_DESIGN_RULES,
  OBJECT_KINDS,
  LEVEL_NAMES,
  DESIGN_COSTS,
  STOP_HEADWAYS,
  CAPACITY_FACTORS,
  MOVE_COST_RUB,
  REMOVE_COST_RUB,
  newObject,
  objectFromDestination,
} from '../core/design-rules.js';
import { nearestNetworkPoint, polygonArea } from '../core/design-geometry.js';
import { upsertObject, dragObject } from './design-state.js';

interface Props {
  active: boolean;
  client: PlanningService | null;
  baseData: DeepReadonly<DistrictData> | null;
  district: DeepReadonly<DistrictData> | null;
  scenario: ScenarioInput;
  profileId: string;
  selectedId: string | null;
  saved: { name: string; envelope: ScenarioEnvelope }[];
  onSelect: (id: string | null) => void;
  onApply: (scenario: ScenarioInput, costRub?: number) => void;
  onPreview: (scenario: ScenarioInput | null) => void;
  onView: (view: EditorView) => void;
  onNotify: (message: string) => void;
  events: MutableRefObject<EditorEvents | null>;
}
const n = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function DesignWorkbench(props: Props) {
  const [kind, setKind] = useState<Destination['kind']>('bus_stop'),
    [tool, setTool] = useState<EditorTool>('select'),
    [draft, setDraft] = useState<EditableObject | null>(null),
    [polygon, setPolygon] = useState<XY[]>([]);
  const [coordinates, setCoordinates] = useState<XY>([160, 16]),
    [result, setResult] = useState<DesignAnalysisResult | null>(null),
    [overlay, setOverlay] = useState(false),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState<string | null>(null),
    [rulesOpen, setRulesOpen] = useState(false),
    [explanation, setExplanation] = useState<string | null>(null),
    [comparisonChoices, setComparisonChoices] = useState<number[]>([]),
    [relocationPoint, setRelocationPoint] = useState<XY | null>(null),
    [dragging, setDragging] = useState(false);
  const [auditRows, setAuditRows] = useState<DistanceRow[] | null>(null),
    [auditFilter, setAuditFilter] = useState('all');
  const job = useRef<AbortController | null>(null),
    actionBusy = useRef(false),
    drag = useRef<{
      original: EditableObject;
      rollback: EditableObject;
      start: XY;
      last: EditableObject;
    } | null>(null),
    previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    lastPreview = useRef(0),
    pendingPreview = useRef<ScenarioInput | null>(null);
  const rules = props.scenario.design?.rules ?? DEFAULT_DESIGN_RULES;
  const district = props.district ?? props.baseData;
  function makeObject(kind: Destination['kind'], point: XY, id?: string) {
    const object = newObject(kind, point, id);
    if (object.polygon && district) {
      const [x0, y0, x1, y1] = district.metadata.boundsM;
      const x = Math.max(x0 + 25, Math.min(x1 - 25, point[0])),
        y = Math.max(y0 + 25, Math.min(y1 - 25, point[1]));
      object.polygon = object.polygon.map((p) => [p[0] + x - point[0], p[1] + y - point[1]]);
    }
    return object;
  }
  const scenarioKey = JSON.stringify(props.scenario);
  const latestScenarioKey = useRef(scenarioKey);
  latestScenarioKey.current = scenarioKey;
  const latestSelection = useRef(props.selectedId);
  latestSelection.current = props.selectedId;
  useEffect(() => {
    if (!props.active) return;
    const selected =
      props.scenario.design?.objects.find((o) => o.id === props.selectedId) ??
      (district && props.selectedId ? objectFromDestination(district, props.selectedId) : null);
    setDraft(selected ? structuredClone(selected) : null);
    if (selected) setKind(selected.kind);
  }, [props.selectedId, scenarioKey, props.active]);
  useEffect(() => {
    setResult(null);
    setOverlay(false);
    setRelocationPoint(null);
    job.current?.abort();
    setBusy(false);
    setAuditRows(null);
  }, [scenarioKey, props.profileId]);
  useEffect(() => {
    props.onView({
      active: props.active,
      tool,
      kind,
      selectedId: props.selectedId,
      draft: props.active ? draft : null,
      polygon,
      overlay: props.active && overlay ? result : null,
    });
  }, [props.active, tool, kind, props.selectedId, draft, polygon, result, overlay, props.onView]);
  useEffect(() => {
    if (!props.active) {
      cancel();
      job.current?.abort();
    }
  }, [props.active]);
  useEffect(
    () => () => {
      job.current?.abort();
      if (previewTimer.current) clearTimeout(previewTimer.current);
      props.onPreview(null);
    },
    [],
  );
  const objects = district?.destinations.filter((d) => d.active) ?? [];
  const selectedResult =
    result?.mode === 'importance' ? result.objects.find((o) => o.id === draft?.id) : null;
  async function commit(scenario: ScenarioInput, id?: string) {
    if (!props.client || actionBusy.current) return false;
    actionBusy.current = true;
    setSaving(true);
    setError(null);
    try {
      const evaluated = await props.client.evaluate(scenario, [props.profileId]);
      if (latestScenarioKey.current !== scenarioKey) {
        props.onNotify('Сценарий изменился во время проверки. Повторите применение параметров.');
        return false;
      }
      props.onApply(scenario, evaluated.costs.capexRub);
      if (id) props.onSelect(id);
      return true;
    } catch (error) {
      setError(errorText(error));
      props.onNotify(errorText(error));
      return false;
    } finally {
      actionBusy.current = false;
      setSaving(false);
      props.onPreview(null);
    }
  }
  async function save(object: EditableObject) {
    const normalized = structuredClone(object);
    if (district && !(object.kind === 'park' && object.autoEntrances))
      normalized.entrances = object.entrances.map((point) => {
        const snap = nearestNetworkPoint(district, point);
        return snap && snap.distanceM <= rules.snapDistanceM ? snap.point : point;
      });
    return commit(upsertObject(props.scenario, normalized), object.id);
  }
  function restored(id: string) {
    const next = {
      ...props.scenario,
      design: {
        rules: { ...rules },
        objects: (props.scenario.design?.objects ?? []).filter((o) => o.id !== id),
      },
    };
    void commit(next);
    setDraft(null);
    props.onSelect(null);
  }
  function remove() {
    if (!draft) return;
    if (!props.baseData?.destinations.some((d) => d.id === draft.id)) {
      restored(draft.id);
      return;
    }
    void save({ ...draft, active: false });
  }
  function cancel() {
    if (drag.current) setDraft(structuredClone(drag.current.rollback));
    setTool('select');
    setPolygon([]);
    setRelocationPoint(null);
    props.onPreview(null);
    drag.current = null;
    setDragging(false);
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    pendingPreview.current = null;
  }
  function streamedPreview(scenario: ScenarioInput) {
    pendingPreview.current = scenario;
    const now = performance.now();
    if (now - lastPreview.current >= 80) {
      lastPreview.current = now;
      props.onPreview(scenario);
      return;
    }
    if (!previewTimer.current)
      previewTimer.current = setTimeout(
        () => {
          previewTimer.current = null;
          lastPreview.current = performance.now();
          if (pendingPreview.current) props.onPreview(pendingPreview.current);
        },
        80 - (now - lastPreview.current),
      );
  }
  function onDrag(event: EditorDrag) {
    if (actionBusy.current) return;
    if (event.phase === 'cancel') {
      cancel();
      return;
    }
    if (event.phase === 'start') {
      job.current?.abort();
      setBusy(false);
      const object =
        props.scenario.design?.objects.find((o) => o.id === event.id) ??
        (district ? objectFromDestination(district, event.id) : null);
      if (!object) return;
      const original = structuredClone(object);
      if (event.part === 'entrance' && original.autoEntrances && district) {
        original.entrances =
          district.destinations
            .find((d) => d.id === event.id)
            ?.accessNodeIds.map((id) => [...district.nodes.find((n) => n.id === id)!.xy] as XY) ??
          original.entrances;
        original.autoEntrances = false;
      }
      drag.current = { original, rollback: structuredClone(object), start: event.point, last: original };
      setDragging(true);
      setResult(null);
      setOverlay(false);
      return;
    }
    if (!drag.current) return;
    const next = dragObject(drag.current.original, drag.current.start, event.point, event.part, event.index);
    if (district && next.kind !== 'park')
      next.entrances = next.entrances.map((point) => {
        const snap = nearestNetworkPoint(district, point);
        return snap && snap.distanceM <= rules.snapDistanceM ? snap.point : point;
      });
    drag.current.last = next;
    setDraft(next);
    if (event.phase === 'move') streamedPreview(upsertObject(props.scenario, next));
    else {
      if (previewTimer.current) {
        clearTimeout(previewTimer.current);
        previewTimer.current = null;
      }
      pendingPreview.current = null;
      const rollback = drag.current.rollback;
      drag.current = null;
      setDragging(false);
      void save(next).then((success) => {
        if (!success && latestSelection.current === event.id && latestScenarioKey.current === scenarioKey)
          setDraft(rollback);
      });
    }
  }
  async function run(mode: DesignAnalysisInput['mode'], point?: XY) {
    if (!props.client) return;
    job.current?.abort();
    const controller = new AbortController();
    job.current = controller;
    setBusy(true);
    setProgress(0);
    setError(null);
    const input: DesignAnalysisInput = {
      scenario: props.scenario,
      profileId: props.profileId,
      kind: draft?.kind ?? kind,
      mode,
      ...(point && draft ? { point, objectId: draft.id } : {}),
    };
    try {
      if (mode === 'compare') {
        const saved = [];
        for (const index of comparisonChoices) {
          const item = props.saved[index];
          if (item)
            saved.push({ name: item.name, scenario: await props.client.importScenario(item.envelope) });
        }
        input.scenarios = [
          { name: 'Исходный район', scenario: { projectIds: [], budgetRub: props.scenario.budgetRub } },
          { name: 'Текущий вариант', scenario: props.scenario },
          ...saved,
        ].slice(0, 8);
      }
      const next = await props.client.analyzeDesign(input, {
        signal: controller.signal,
        onProgress: (p) => setProgress(p.totalSubsets ? (p.processedSubsets / p.totalSubsets) * 100 : 0),
      });
      if (!controller.signal.aborted) {
        setResult(next);
        setOverlay(['importance', 'needs', 'vulnerability'].includes(mode));
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error));
    } finally {
      if (job.current === controller) setBusy(false);
    }
  }
  function place(point: XY) {
    if (!district || actionBusy.current) return;
    setError(null);
    if (tool === 'polygon') {
      setPolygon((points) => [...points, point]);
      return;
    }
    const snap = nearestNetworkPoint(district, point);
    if (!snap || snap.distanceM > rules.snapDistanceM) {
      setError(`Нажмите ближе к тротуару или дорожке: предел привязки ${rules.snapDistanceM} м.`);
      return;
    }
    if (tool === 'entrance' && draft?.kind === 'park') {
      const entrances = draft.autoEntrances
        ? (district.destinations
            .find((d) => d.id === draft.id)
            ?.accessNodeIds.map((id) => [...district.nodes.find((n) => n.id === id)!.xy] as XY) ?? [])
        : draft.entrances;
      void save({ ...draft, autoEntrances: false, entrances: [...entrances, snap.point] });
      setTool('select');
      return;
    }
    if (tool === 'relocate' && draft) {
      setRelocationPoint(snap.point);
      setTool('select');
      void run('relocation', snap.point);
      return;
    }
    if (tool === 'place') {
      const object = makeObject(kind, snap.point);
      void save(object);
      setTool('select');
    }
  }
  props.events.current = { point: place, drag: onDrag, cancel };
  async function finishPolygon() {
    if (polygon.length < 3) return;
    const center: XY = [
        polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
        polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
      ],
      object = { ...makeObject('park', center), polygon: [...polygon, [...polygon[0]!] as XY] };
    if (!(await save(object))) return;
    setPolygon([]);
    setTool('select');
  }
  function changeKind(value: Destination['kind']) {
    setKind(value);
    if (draft) {
      const point = draft.entrances[0] ?? coordinates,
        next = makeObject(value, point, draft.id);
      setDraft({ ...next, name: draft.name });
    }
  }
  function setRule(key: keyof DesignRules, value: number) {
    if (!Number.isFinite(value)) return;
    void commit({
      ...props.scenario,
      design: { rules: { ...rules, [key]: value }, objects: props.scenario.design?.objects ?? [] },
    });
  }
  function previewRelocation(stage: number) {
    if (!draft || !relocationPoint) return;
    const object =
      stage === 0
        ? draft
        : stage === 1
          ? { ...draft, active: false }
          : { ...draft, entrances: [relocationPoint] };
    props.onPreview({ ...upsertObject(props.scenario, object), budgetRub: Number.MAX_SAFE_INTEGER });
  }
  const explainSummary =
    'Расстояние — кратчайший путь по допустимой сети, в метрах, до ближайшего входа. Сумма расстояний умножается на население домов и делится на число достижимых жителей. Порог применяется к каждому дому; недостижимые жители остаются в общем населении. Сравнение среднего рассчитывается только по жителям, достижимым в обоих состояниях; потери достижимости показаны отдельно.';
  function explainRows(rows: DistanceRow[], message = explainSummary) {
    setAuditRows(rows);
    setAuditFilter('all');
    setExplanation(message);
  }
  const audited = auditRows ?? result?.rows ?? [];
  const reference = new Map(result?.rows.map((row) => [row.buildingId, row]) ?? []);
  const visibleAudit = audited.filter((row) => {
    const before = reference.get(row.buildingId)?.distanceM ?? Infinity,
      after = row.distanceM ?? Infinity;
    return auditFilter === 'won'
      ? after < before - 0.01
      : auditFilter === 'lost'
        ? after > before + 0.01
        : true;
  });
  if (!props.active) return null;
  return (
    <section className="design-studio" aria-label="Свободный редактор объектов">
      <div className="section-heading">
        <h2>Свободный редактор</h2>
        <button
          className="icon-button"
          aria-label="Правила свободного редактора"
          onClick={() => setRulesOpen((v) => !v)}
        >
          <Settings2 size={16} />
        </button>
      </div>
      <p className="studio-note">
        Любая точка тротуара или дорожки. Привязка создаёт новый узел, а не выбирает готовое место.
      </p>
      <label className="field-label" htmlFor="object-kind">
        Категория объекта
      </label>
      <select
        id="object-kind"
        value={kind}
        onChange={(e) => changeKind(e.target.value as Destination['kind'])}
      >
        {Object.entries(OBJECT_KINDS).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <div className="studio-tools">
        <button
          className={tool === 'place' ? 'active' : ''}
          disabled={saving}
          onClick={() => {
            props.onSelect(null);
            setDraft(null);
            setTool('place');
          }}
        >
          <Plus size={14} />
          Поставить на карте
        </button>
        <button
          className={tool === 'polygon' ? 'active' : ''}
          onClick={() => {
            props.onSelect(null);
            setDraft(null);
            setKind('park');
            setPolygon([]);
            setTool('polygon');
          }}
        >
          Нарисовать парк
        </button>
      </div>
      {tool !== 'select' && (
        <div className="studio-hint" role="status">
          {tool === 'place'
            ? 'Нажмите в любой точке сети.'
            : tool === 'polygon'
              ? `Добавляйте вершины границы: ${polygon.length}.`
              : tool === 'entrance'
                ? 'Нажмите на дорожку рядом с границей парка.'
                : 'Выберите новое место на пешеходной сети.'}
          <button aria-label="Отменить инструмент" onClick={cancel}>
            <X size={14} />
          </button>
        </div>
      )}
      <details className="coordinate-placement">
        <summary>Размещение по координатам</summary>
        <div className="studio-pair">
          <label>
            X, м
            <input
              aria-label="Координата X нового объекта"
              type="number"
              step="0.1"
              value={coordinates[0]}
              onChange={(e) => setCoordinates([Number(e.target.value), coordinates[1]])}
            />
          </label>
          <label>
            Y, м
            <input
              aria-label="Координата Y нового объекта"
              type="number"
              step="0.1"
              value={coordinates[1]}
              onChange={(e) => setCoordinates([coordinates[0], Number(e.target.value)])}
            />
          </label>
        </div>
        <button
          className="secondary-button full-width"
          disabled={saving}
          onClick={() => {
            if (tool === 'polygon') place(coordinates);
            else if (tool === 'entrance' || tool === 'relocate') place(coordinates);
            else {
              const snap = district && nearestNetworkPoint(district, coordinates);
              if (snap && snap.distanceM <= rules.snapDistanceM) void save(makeObject(kind, snap.point));
              else setError('Рядом с указанными координатами нет пешеходной сети');
            }
          }}
        >
          {tool === 'polygon'
            ? 'Добавить вершину'
            : tool === 'relocate'
              ? 'Проверить перенос'
              : tool === 'entrance'
                ? 'Добавить вход'
                : 'Разместить по координатам'}
        </button>
      </details>
      {tool === 'polygon' && (
        <div className="studio-tools">
          <button disabled={polygon.length < 3 || saving} onClick={() => void finishPolygon()}>
            Завершить границу
          </button>
          <button disabled={!polygon.length} onClick={() => setPolygon((points) => points.slice(0, -1))}>
            <Undo2 size={13} />
            Последняя вершина
          </button>
        </div>
      )}
      {saving && (
        <p className="studio-note" role="status">
          <LoaderCircle className="spin" size={13} />
          Проверка сети и бюджета…
        </p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="studio-object-list" aria-label="Объекты для редактирования">
        {objects.map((object) => (
          <button
            key={object.id}
            className={object.id === props.selectedId ? 'active' : ''}
            onClick={() => {
              props.onSelect(object.id);
              setTool('select');
            }}
          >
            <MapPin size={12} />
            <span>{object.name}</span>
            <small>{OBJECT_KINDS[object.kind]}</small>
          </button>
        ))}
      </div>
      {draft && (
        <section className="studio-object-card">
          <h3>{draft.name}</h3>
          <p className="studio-note">
            Выберите маркер и перетащите его. Синие квадраты — вершины, жёлтые точки — входы. Стрелки на
            клавиатуре двигают выбранный объект на 5 м.
          </p>
          {dragging && <div className="studio-hint">Перетаскивание · пересчёт до 12 раз/с</div>}
          <label className="field-label" htmlFor="edit-name">
            Название
          </label>
          <input
            id="edit-name"
            maxLength={120}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <label className="field-label" htmlFor="object-level">
            Уровень
          </label>
          <select
            id="object-level"
            value={draft.level}
            onChange={(e) => setDraft({ ...draft, level: Number(e.target.value) as 0 | 1 | 2 })}
          >
            {LEVEL_NAMES[draft.kind].map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>
          {draft.kind !== 'park' ? (
            <>
              <label className="field-label" htmlFor="object-capacity">
                Базовая вместимость
              </label>
              <input
                id="object-capacity"
                type="number"
                min="0"
                max="1000000"
                value={draft.capacity ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, capacity: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
              <p className="studio-note">
                Коэффициент уровня ×{CAPACITY_FACTORS[draft.level]}.{' '}
                {draft.kind === 'bus_stop'
                  ? `Условный интервал ${STOP_HEADWAYS[draft.level] / 60} мин, ожидание ${STOP_HEADWAYS[draft.level] / 120} мин.`
                  : ''}
              </p>
              <div className="studio-pair">
                {[0, 1].map((axis) => (
                  <label key={axis}>
                    {axis ? 'Y' : 'X'}, м
                    <input
                      aria-label={`Положение объекта ${axis ? 'Y' : 'X'}`}
                      type="number"
                      step="0.1"
                      value={draft.entrances[0]?.[axis] ?? 0}
                      onChange={(e) => {
                        const point: XY = [...(draft.entrances[0] ?? coordinates)];
                        point[axis] = Number(e.target.value);
                        setDraft({ ...draft, entrances: [point] });
                      }}
                    />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              <button
                className="studio-number"
                onClick={() =>
                  setExplanation(
                    `Площадь многоугольника: ${n(draft.polygon ? polygonArea(draft.polygon) : 0)} м². Вместимость = площадь / ${rules.parkM2PerVisitor} м² × коэффициент уровня ${CAPACITY_FACTORS[draft.level]}.`,
                  )
                }
              >
                {n(draft.polygon ? polygonArea(draft.polygon) : 0)} м² ·{' '}
                {n(
                  draft.polygon
                    ? Math.floor(
                        (polygonArea(draft.polygon) / rules.parkM2PerVisitor) * CAPACITY_FACTORS[draft.level],
                      )
                    : 0,
                )}{' '}
                посетителей
              </button>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={draft.autoEntrances}
                  onChange={(e) => setDraft({ ...draft, autoEntrances: e.target.checked })}
                />
                Входы автоматически по сторонам
              </label>
              <label className="studio-check">
                <input
                  type="checkbox"
                  checked={draft.throughAccess}
                  onChange={(e) => setDraft({ ...draft, throughAccess: e.target.checked })}
                />
                Внутренние сквозные дорожки
              </label>
              <div className="studio-tools">
                <button onClick={() => setTool('entrance')}>Добавить вход</button>
                <button
                  onClick={() => {
                    const actual = district && objectFromDestination(district, draft.id);
                    setDraft({
                      ...draft,
                      autoEntrances: false,
                      entrances: actual?.entrances ?? draft.entrances,
                    });
                  }}
                >
                  Ручные входы
                </button>
              </div>
              {!draft.autoEntrances &&
                draft.entrances.map((point, index) => (
                  <div className="studio-entry" key={index}>
                    <span>
                      Вход {index + 1}: {n(point[0])}, {n(point[1])}
                    </span>
                    <button
                      aria-label={`Удалить вход ${index + 1}`}
                      onClick={() =>
                        void save({ ...draft, entrances: draft.entrances.filter((_, i) => i !== index) })
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              {draft.polygon && (
                <details>
                  <summary>Координаты вершин</summary>
                  {draft.polygon.slice(0, -1).map((point, index) => (
                    <div className="studio-pair" key={index}>
                      {[0, 1].map((axis) => (
                        <label key={axis}>
                          {index + 1} · {axis ? 'Y' : 'X'}
                          <input
                            aria-label={`Вершина ${index + 1} ${axis ? 'Y' : 'X'}`}
                            type="number"
                            step="0.1"
                            value={point[axis]}
                            onChange={(e) => {
                              const polygon = structuredClone(draft.polygon!);
                              polygon[index]![axis] = Number(e.target.value);
                              if (index === 0) polygon[polygon.length - 1] = [...polygon[0]!];
                              setDraft({ ...draft, polygon });
                            }}
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          <button
            className="primary-button full-width"
            disabled={saving || !draft.name.trim()}
            onClick={() => void save(draft)}
          >
            <Check size={14} />
            Применить параметры
          </button>
          <div className="studio-tools">
            <button disabled={draft.kind === 'park'} onClick={() => setTool('relocate')}>
              <Move size={13} />
              Перенос: 3 состояния
            </button>
            <button onClick={remove}>
              <Trash2 size={13} />
              Удалить объект
            </button>
          </div>
          {props.scenario.design?.objects.some((o) => o.id === draft.id) && (
            <button className="text-button" onClick={() => restored(draft.id)}>
              Вернуть исходное состояние объекта
            </button>
          )}
          <button
            className="secondary-button full-width"
            disabled={busy}
            onClick={() => void run('importance')}
          >
            Рассчитать важность объекта
          </button>
          {selectedResult && (
            <div className="studio-impact">
              <button
                onClick={() =>
                  setExplanation(
                    'Каждый дом относится к ближайшему достижимому объекту выбранного типа. Население таких домов суммируется. Вместимость не ограничивает маршрутизацию: перегрузка показывается отдельно.',
                  )
                }
              >
                Обслуживает {n(selectedResult.servedResidents)} жителей
              </button>
              {selectedResult.capacity !== null && (
                <button
                  onClick={() =>
                    setExplanation(
                      'Нагрузка = жители, для которых объект ближайший / эффективная вместимость × 100%. Более 100% означает условную перегрузку; перераспределение жителей при переполнении не моделируется.',
                    )
                  }
                >
                  Вместимость {n(selectedResult.capacity)} · нагрузка{' '}
                  {selectedResult.capacity === 0 && selectedResult.servedResidents > 0
                    ? '∞'
                    : n(selectedResult.loadPercent)}
                  %
                </button>
              )}
              <button onClick={() => explainRows(selectedResult.withoutRows)}>
                Без объекта: +{n(selectedResult.change.meanChangeCommonM)} м среднего пути;{' '}
                {n(selectedResult.change.lostWithinResidents)} жителей потеряют доступ в{' '}
                {rules.distanceThresholdM} м; недостижимыми станут{' '}
                {n(selectedResult.change.lostReachableResidents)}.
              </button>
            </div>
          )}
        </section>
      )}
      <section className="studio-analysis">
        <h3>Аналитика размещения</h3>
        <p className="studio-note">
          Категория: {OBJECT_KINDS[draft?.kind ?? kind]} · радиус {rules.distanceThresholdM} м по сети.
        </p>
        <div className="studio-tools">
          <button disabled={busy} onClick={() => void run('needs')}>
            Где нужнее всего?
          </button>
          <button disabled={busy} onClick={() => void run('importance')}>
            Карта важности
          </button>
          <button disabled={busy} onClick={() => void run('vulnerability')}>
            Уязвимость сети
          </button>
        </div>
        {busy && (
          <div className="studio-hint" role="status">
            <LoaderCircle className="spin" size={13} />
            Считаем {n(progress)}%
            <button
              onClick={() => {
                job.current?.abort();
                setBusy(false);
              }}
            >
              Отменить
            </button>
          </div>
        )}
        {result && (
          <>
            <button className="studio-number" onClick={() => setExplanation(explainSummary)}>
              Средний путь {n(result.totals.meanDistanceM)} м · в радиусе {n(result.totals.withinResidents)}{' '}
              из {n(result.totals.evaluatedResidents)} жителей
            </button>
            {result.totals.meanServiceSeconds !== null && (
              <button
                className="studio-number"
                onClick={() =>
                  setExplanation(
                    'Время до посадки = время ходьбы по выбранному кратчайшему по метрам пути (скорость, покрытие, переходы) + половина условного интервала остановки. Интервалы уровней: 15 / 10 / 5 минут. Это отдельный показатель; обычная пешая доступность выше не меняется.',
                  )
                }
              >
                До посадки с ожиданием: {n(result.totals.meanServiceSeconds / 60)} мин
              </button>
            )}
            {result.mode === 'needs' && (
              <>
                <p className="studio-note">
                  Проверено {result.evaluatedCandidates} точек, шаг до {n(result.spacingM)} м плюс узлы сети.
                  Точный эффект одного нового входа в проверенных точках; цвет между ними интерполирован.
                  Зелёный — больше эффект, серый — нет эффекта. Для парка «Поставить сюда» создаёт один ручной
                  вход. Топ-3 разнесены минимум на 80 м.
                </p>
                {result.top.map((candidate, index) => (
                  <article className="studio-result" key={candidate.id}>
                    <h4>Место {index + 1}</h4>
                    <button onClick={() => explainRows(candidate.rows ?? result.rows)}>
                      −{n(candidate.meanReductionM)} м среднего пути · +{n(candidate.gainResidents)} жителей в
                      радиусе {rules.distanceThresholdM} м
                    </button>
                    <p>
                      Новая достижимость: {n(candidate.gainReachableResidents)} · X {n(candidate.point[0])}, Y{' '}
                      {n(candidate.point[1])}
                    </p>
                    <button
                      className="secondary-button full-width"
                      disabled={saving}
                      onClick={() =>
                        void save({ ...makeObject(result.kind, candidate.point), autoEntrances: false })
                      }
                    >
                      Поставить сюда
                    </button>
                  </article>
                ))}
              </>
            )}
            {result.mode === 'vulnerability' &&
              [...result.vulnerabilities]
                .sort(
                  (a, b) =>
                    b.lostReachableResidents - a.lostReachableResidents ||
                    b.lostResidents - a.lostResidents ||
                    b.affectedResidents - a.affectedResidents,
                )
                .slice(0, 3)
                .map((edge) => (
                  <article className="studio-result" key={edge.edgeId}>
                    <strong>{edge.edgeId}</strong>
                    <button onClick={() => setExplanation(explainSummary)}>
                      Закрытие: {n(edge.lostResidents)} потеряют радиус, {n(edge.lostReachableResidents)} —
                      достижимость; хуже {n(edge.affectedResidents)} жителям.
                    </button>
                  </article>
                ))}
            {result.mode === 'importance' && (
              <p className="studio-note">
                Цвет объектов показывает последствия удаления. Краснее — больше жителей потеряют доступ или
                получат более длинный путь. Индекс цвета = потери порога + потери достижимости + 0,1 × жители
                с ухудшением, относительно максимума. Выберите объект для чисел.
              </p>
            )}
            {result.comparisons.length > 0 && (
              <div className="studio-comparison" role="region" aria-label="Сравнение состояний">
                <table>
                  <thead>
                    <tr>
                      <th>Вариант</th>
                      <th>Среднее, м</th>
                      <th>В радиусе</th>
                      <th>Выиграли</th>
                      <th>Проиграли</th>
                      <th>Недостижимы</th>
                      <th>Стоимость, ₽</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.comparisons.map((row, index) => (
                      <tr key={index}>
                        <th>
                          {result.mode === 'relocation' ? (
                            <button
                              onClick={() => {
                                previewRelocation(index);
                                explainRows(row.rows);
                              }}
                            >
                              {row.name}
                            </button>
                          ) : (
                            row.name
                          )}
                        </th>
                        <td>
                          <button onClick={() => explainRows(row.rows)}>{n(row.totals.meanDistanceM)}</button>
                        </td>
                        <td>
                          <button onClick={() => explainRows(row.rows)}>
                            {n(row.totals.withinResidents)}
                          </button>
                        </td>
                        <td>
                          <button
                            onClick={() => {
                              explainRows(row.rows);
                              setAuditFilter('won');
                            }}
                          >
                            {n(row.change.improvedResidents)}
                          </button>
                        </td>
                        <td>
                          <button
                            onClick={() => {
                              explainRows(row.rows);
                              setAuditFilter('lost');
                            }}
                          >
                            {n(row.change.worsenedResidents)}
                          </button>
                        </td>
                        <td>
                          <button onClick={() => explainRows(row.rows)}>
                            {n(row.totals.evaluatedResidents - row.totals.reachableResidents)}
                          </button>
                        </td>
                        <td>
                          <button
                            onClick={() => {
                              setRulesOpen(true);
                              setExplanation(
                                `Стоимость варианта «${row.name}»: ${n(row.costRub)} ₽ (округление общей суммы до рубля). ${row.costItems.map((item) => `${item.name}: ${item.formula} = ${n(item.amountRub)} ₽`).join('; ') || 'Платных изменений нет'}. Отмена нового объекта отменяет его стоимость.`,
                              );
                            }}
                          >
                            {n(row.costRub)}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.mode === 'relocation' && draft && relocationPoint && (
              <>
                <p className="studio-note">
                  Нажимайте на состояния в таблице для просмотра. Предварительный расчёт не ограничен
                  бюджетом; применение проверяет реальный бюджет.
                </p>
                <button
                  className="primary-button full-width"
                  onClick={() => void save({ ...draft, entrances: [relocationPoint] })}
                >
                  Применить перенос
                </button>
                <button className="text-button" onClick={() => props.onPreview(null)}>
                  Закончить просмотр
                </button>
              </>
            )}
            {overlay && (
              <button className="text-button" onClick={() => setOverlay(false)}>
                Убрать аналитическую подсветку
              </button>
            )}
          </>
        )}
      </section>
      <section className="studio-analysis">
        <h3>Сравнить сценарии А / Б / В</h3>
        <p className="studio-note">Исходный и текущий включены. Добавьте сохранённые варианты (до 6).</p>
        {props.saved.slice(0, 20).map((item, index) => (
          <label className="studio-check" key={index}>
            <input
              type="checkbox"
              checked={comparisonChoices.includes(index)}
              onChange={(e) =>
                setComparisonChoices((old) =>
                  e.target.checked ? [...old, index].slice(0, 6) : old.filter((i) => i !== index),
                )
              }
            />
            {item.name}
          </label>
        ))}
        <button className="secondary-button full-width" disabled={busy} onClick={() => void run('compare')}>
          Сравнить выбранные сценарии
        </button>
      </section>
      <button className="text-button" onClick={() => setRulesOpen((v) => !v)}>
        Все правила, нормативы и стоимости
      </button>
      {rulesOpen && (
        <section className="studio-rules" aria-label="Допущения модели">
          <h3>Допущения модели</h3>
          {(
            [
              ['distanceThresholdM', 'Порог расстояния, м'],
              ['parkM2PerVisitor', 'Площадь на посетителя, м²'],
              ['snapDistanceM', 'Предел привязки, м'],
              ['entranceGapM', 'Зазор автоматического входа, м'],
              ['candidateSpacingM', 'Шаг поиска потребности, м'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                aria-label={label}
                type="number"
                key={`${key}:${rules[key]}`}
                defaultValue={rules[key]}
                onBlur={(e) => {
                  if (e.target.value !== '' && Number(e.target.value) !== rules[key])
                    setRule(key, Number(e.target.value));
                }}
              />
            </label>
          ))}
          <p>
            Скорость выбранного профиля:{' '}
            {n(district?.profiles.find((p) => p.id === props.profileId)?.speedMps)} м/с. Покрытие и ожидания
            переходов: из исходных данных. Один условный поход жителя к выбранной цели за цикл. Шаг клавиатуры
            5 м; разнесение лучших мест 80 м.
          </p>
          <p>
            Вместимость: площадь / норматив × коэффициент уровня {CAPACITY_FACTORS.join(' / ')}. Перегрузка не
            перераспределяет жителей. Вход парка — его точка примыкания к пешеходной сети, без дополнительного
            поперечного расстояния до границы.
          </p>
          <p>
            Перенос: {n(MOVE_COST_RUB)} ₽; удаление существующего: {n(REMOVE_COST_RUB)} ₽; дополнительная
            единица вместимости сверх исходной (для нового объекта — сверх стандартной): 1000 ₽. Пустая
            вместимость означает отсутствие данных о ней.
          </p>
          <table>
            <thead>
              <tr>
                <th>Тип</th>
                <th>Стоимость уровней, ₽</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(DESIGN_COSTS).map(([key, prices]) => (
                <tr key={key}>
                  <th>{OBJECT_KINDS[key as Destination['kind']]}</th>
                  <td>
                    {prices.map((price) => n(price)).join(' / ')}
                    {key === 'park' ? ' за м²' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Стоимость улучшения существующего объекта — разница уровней; увеличение парка оплачивает
            добавленную площадь. Вместимость не ограничивает поиск пешего маршрута.
          </p>
          <p>
            Условная учебная модель. Нет официального прогноза, проверки права на строительство и реального
            расписания автобусов.
          </p>
        </section>
      )}
      {explanation && (
        <div className="studio-explanation" role="region" aria-label="Объяснение расчёта">
          <button
            className="icon-button"
            aria-label="Закрыть объяснение"
            onClick={() => setExplanation(null)}
          >
            <X size={16} />
          </button>
          <h3>Как получено число</h3>
          <p>{explanation}</p>
          {result && (
            <details className="studio-audit" open>
              <summary>Проверить по домам</summary>
              <p className="studio-note">
                Сравнение с текущим вариантом на момент запуска анализа. Расчёт по населению домов; «—»
                означает недостижимость.
              </p>
              <label>
                Показать
                <select
                  aria-label="Фильтр жителей"
                  value={auditFilter}
                  onChange={(e) => setAuditFilter(e.target.value)}
                >
                  <option value="all">Все дома</option>
                  <option value="won">Жители, которым стало лучше</option>
                  <option value="lost">Жители, которым стало хуже</option>
                </select>
              </label>
              <p className="studio-note">
                Жителей в таблице: {n(visibleAudit.reduce((sum, row) => sum + row.residents, 0))}. Среднее ={' '}
                {n(audited.reduce((sum, row) => sum + (row.distanceM ?? 0) * row.residents, 0))} чел.·м /{' '}
                {n(
                  audited
                    .filter((row) => row.distanceM !== null)
                    .reduce((sum, row) => sum + row.residents, 0),
                )}{' '}
                чел.
              </p>
              <div className="studio-comparison">
                <table>
                  <thead>
                    <tr>
                      <th>Дом</th>
                      <th>Жители</th>
                      <th>Сейчас, м</th>
                      <th>Вариант, м</th>
                      <th>Ближайший объект</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAudit.map((row) => (
                      <tr key={row.buildingId}>
                        <th>
                          <button onClick={() => props.onSelect(row.buildingId)}>
                            {district?.buildings.find((b) => b.id === row.buildingId)?.name ?? row.buildingId}
                          </button>
                        </th>
                        <td>{n(row.residents)}</td>
                        <td>{n(reference.get(row.buildingId)?.distanceM)}</td>
                        <td>{n(row.distanceM)}</td>
                        <td>
                          {row.destinationId === '__new_candidate'
                            ? 'Новый объект'
                            : (district?.destinations.find((d) => d.id === row.destinationId)?.name ??
                              row.destinationId ??
                              '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
