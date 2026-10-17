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
  Bus,
  School,
  HeartPulse,
  Trees,
  CarFront,
  Baby,
  ShoppingBag,
  Building2,
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
  capacityFactor,
  MOVE_COST_RUB,
  REMOVE_COST_RUB,
  newObject,
  objectFromDestination,
} from '../core/design-rules.js';
import { nearestNetworkPoint, polygonArea } from '../core/design-geometry.js';
import { upsertObject, dragObject } from './design-state.js';
import type { Analysis } from './useAnalysis.js';
import { PlacementImpact } from './PlacementImpact.js';
import {
  suggestPlacement,
  PLACEMENT_HINTS,
  PLACEMENT_RULES,
  polygonsOverlap,
  relocateWithContext,
} from '../core/placement.js';

interface Props {
  active: boolean;
  launch: number;
  client: PlanningService | null;
  baseData: DeepReadonly<DistrictData> | null;
  district: DeepReadonly<DistrictData> | null;
  analysis: Analysis | null;
  calculationBusy: boolean;
  calculationError: string | null;
  baselineView: boolean;
  onKindChange: (kind: Destination['kind']) => void;
  onProfileChange: (id: string) => void;
  onFocus: (points: readonly XY[]) => void;
  onCompare: () => void;
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
  const [batchMode, setBatchMode] = useState(false),
    [queued, setQueued] = useState<EditableObject[]>([]),
    [placementMessage, setPlacementMessage] = useState<string | null>(null);
  const [panel, setPanel] = useState<'place' | 'objects' | 'analysis'>('place');
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
    placementHeading = useRef<HTMLHeadingElement>(null),
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
  const lastOpenedObject = useRef<string | null>(null);
  const editorSession = useRef<number | null>(null);
  const consumedLaunch = useRef(0);
  latestSelection.current = props.selectedId;
  useEffect(() => {
    if (!props.active || editorSession.current !== props.launch) return;
    const selected =
      props.scenario.design?.objects.find((o) => o.id === props.selectedId) ??
      (district && props.selectedId ? objectFromDestination(district, props.selectedId) : null);
    setDraft(selected ? structuredClone(selected) : null);
    if (selected) {
      setKind(selected.kind);
      props.onKindChange(selected.kind);
      if (lastOpenedObject.current !== selected.id || panel === 'place') setPanel('objects');
      lastOpenedObject.current = selected.id;
    } else {
      lastOpenedObject.current = null;
    }
  }, [props.selectedId, scenarioKey, props.active]);
  useEffect(() => {
    if (!props.active) {
      editorSession.current = null;
      return;
    }
    const requestedPlacement = props.launch > consumedLaunch.current;
    if (!requestedPlacement && editorSession.current === props.launch) return;
    consumedLaunch.current = props.launch;
    editorSession.current = props.launch;
    cancel();
    setPanel('place');
    setDraft(null);
    props.onSelect(null);
    props.onKindChange(kind);
    setError(null);
    setOverlay(false);
    setResult(null);
    job.current?.abort();
    setBusy(false);
    // A deliberate launch must arm the map even when the editor is already open.
    setTool(requestedPlacement ? (kind === 'park' ? 'polygon' : 'place') : 'select');
    if (requestedPlacement) {
      placementHeading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      placementHeading.current?.focus({ preventScroll: true });
    }
  }, [props.active, props.launch]);
  useEffect(() => {
    setQueued([]);
    props.onPreview(null);
  }, [scenarioKey]);
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
  const persistedObject = draft
    ? (props.scenario.design?.objects.find((o) => o.id === draft.id) ??
      (district ? objectFromDestination(district, draft.id) : null))
    : null;
  const pendingParameters = draft && JSON.stringify(draft) !== JSON.stringify(persistedObject);
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
    if (district && normalized.active && normalized.kind === 'bus_stop') {
      const current = district.destinations.find((d) => d.id === normalized.id);
      const oldPoint = district.nodes.find((n) => n.id === current?.accessNodeIds[0])?.xy;
      if (!oldPoint || JSON.stringify(oldPoint) !== JSON.stringify(normalized.entrances[0])) {
        try {
          suggestPlacement(
            district,
            'bus_stop',
            normalized.entrances[0]!,
            props.scenario.design?.objects,
            rules.snapDistanceM,
          );
        } catch (error) {
          setError(errorText(error));
          props.onPreview(null);
          return false;
        }
      }
    }
    const success = await commit(upsertObject(props.scenario, normalized), object.id);
    if (success && !normalized.active) {
      props.onSelect(null);
      setDraft(null);
    }
    return success;
  }
  function restored(id: string) {
    const next = {
      ...props.scenario,
      design: {
        rules: { ...rules },
        objects: (props.scenario.design?.objects ?? []).filter((o) => o.id !== id),
      },
    };
    void commit(next).then((success) => {
      if (success) {
        setDraft(null);
        props.onSelect(null);
      }
    });
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
    setQueued([]);
    setPlacementMessage(null);
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
    setTool('select');
    setPolygon([]);
    setPanel('analysis');
    job.current?.abort();
    const controller = new AbortController();
    job.current = controller;
    setBusy(true);
    setProgress(0);
    setError(null);
    const input: DesignAnalysisInput = {
      scenario: props.scenario,
      placementAware: true,
      profileId: props.profileId,
      kind,
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
        if (mode === 'needs' && next.top[0]) props.onFocus([next.top[0].point]);
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
      stageObject(point);
    }
  }
  function stagedScenario(objects: EditableObject[]) {
    return objects.reduce((scenario, object) => upsertObject(scenario, object), props.scenario);
  }
  function queueObject(object: EditableObject, message: string) {
    const next = batchMode ? [...queued, object] : [object];
    if ((props.scenario.design?.objects.length ?? 0) + next.length > 128) {
      setError('В сценарии допускается не больше 128 объектов.');
      return;
    }
    setQueued(next);
    setPlacementMessage(message);
    props.onSelect(null);
    setDraft(null);
    setPanel('place');
    props.onPreview(stagedScenario(next));
    setError(null);
  }
  function stageObject(point: XY, value = kind) {
    if (!district) return;
    if (value === 'park') {
      setKind('park');
      setPanel('place');
      setTool('polygon');
      setPolygon([point]);
      props.onFocus([point]);
      return;
    }
    try {
      const placementDistrict =
        batchMode &&
        queued.length &&
        props.analysis &&
        JSON.stringify(props.analysis.scenario) === JSON.stringify(stagedScenario(queued))
          ? props.analysis.district
          : district;
      const placement = suggestPlacement(
        placementDistrict,
        value,
        point,
        [...(props.scenario.design?.objects ?? []), ...(batchMode ? queued : [])],
        rules.snapDistanceM,
      );
      const object = {
        ...makeObject(value, placement.point),
        placementChecked: true,
        ...(placement.site ? { site: placement.site } : {}),
      };
      queueObject(object, placement.message);
      setTool('place');
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function applyQueued() {
    if (!queued.length) return;
    const objects = queued;
    if (await commit(stagedScenario(objects), objects.at(-1)!.id)) {
      setQueued([]);
      setPlacementMessage(null);
      setTool('select');
      props.onFocus(objects.flatMap((o) => o.entrances));
      props.onNotify(`Применено объектов: ${objects.length}. Сравните результат во вкладке «Среда».`);
    }
  }
  props.events.current = { point: place, drag: onDrag, cancel };
  async function finishPolygon() {
    if (polygon.length < 3) return;
    const center: XY = [
        polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
        polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
      ],
      object = {
        ...makeObject('park', center),
        polygon: [...polygon, [...polygon[0]!] as XY],
        placementChecked: true,
      };
    if (!district) return;
    if (
      [...district.roads, ...district.buildings].some((o) => polygonsOverlap(object.polygon!, o.polygon)) ||
      [...(props.scenario.design?.objects ?? []), ...queued].some(
        (o) =>
          o.active &&
          ((o.site && polygonsOverlap(object.polygon!, o.site)) ||
            (o.polygon && polygonsOverlap(object.polygon!, o.polygon))),
      )
    ) {
      setError('Граница парка пересекает дорогу, здание или другой объект сценария. Измените вершины.');
      return;
    }
    queueObject(
      object,
      'Граница парка готова. Вместимость рассчитывается по площади, доступность — до входов.',
    );
    setPolygon([]);
    setTool('select');
  }
  function changeKind(value: Destination['kind']) {
    if (draft && panel === 'objects' && district) {
      try {
        const next = makeObject(value, draft.entrances[0] ?? coordinates, draft.id);
        const placement =
          value === 'park'
            ? null
            : suggestPlacement(
                district,
                value,
                next.entrances[0]!,
                props.scenario.design?.objects.filter((o) => o.id !== draft.id),
                rules.snapDistanceM,
              );
        setDraft({
          ...next,
          name: draft.name,
          ...(placement
            ? {
                entrances: [placement.point],
                ...(placement.site ? { site: placement.site } : {}),
                placementChecked: true,
              }
            : {}),
        });
      } catch (error) {
        setError(errorText(error));
        return;
      }
    }
    setKind(value);
    props.onKindChange(value);
    job.current?.abort();
    setBusy(false);
    setResult(null);
    setOverlay(false);
    if (panel === 'place') {
      setTool(value === 'park' ? 'polygon' : 'place');
      setPolygon([]);
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
          : relocateWithContext(
              district!,
              draft,
              relocationPoint,
              props.scenario.design?.objects,
              rules.snapDistanceM,
            );
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
      <nav className="studio-navigation" aria-label="Режим редактора">
        {(
          [
            ['place', 'Разместить'],
            ['objects', 'Объекты'],
            ['analysis', 'Анализ'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={panel === id}
            onClick={() => {
              cancel();
              setPanel(id);
              if (id === 'place') {
                props.onSelect(null);
                setDraft(null);
                setTool('place');
              }
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="section-heading">
        <h2 ref={placementHeading} tabIndex={-1}>
          {panel === 'place'
            ? 'Новый объект'
            : panel === 'objects'
              ? 'Редактирование объекта'
              : 'Анализ размещения'}
        </h2>
        <button
          className="icon-button"
          aria-label="Правила свободного редактора"
          onClick={() => setRulesOpen((v) => !v)}
        >
          <Settings2 size={16} />
        </button>
      </div>
      {panel === 'place' && (
        <p className="studio-note">
          1. Выберите объект → 2. Укажите место на карте → 3. Проверьте и примените.
        </p>
      )}
      <label className="field-label" htmlFor="object-kind">
        Категория объекта
      </label>
      {panel === 'place' ? (
        <div className="object-type-grid" role="group" aria-label="Тип нового объекта">
          {Object.entries(OBJECT_KINDS).map(([id, label]) => {
            const Icon = {
              bus_stop: Bus,
              school: School,
              clinic: HeartPulse,
              park: Trees,
              parking: CarFront,
              playground: Baby,
              waste_bin: Trash2,
              grocery: ShoppingBag,
              community: Building2,
            }[id as Destination['kind']];
            return (
              <button
                key={id}
                aria-pressed={kind === id}
                onClick={() => changeKind(id as Destination['kind'])}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      ) : (
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
      )}
      {panel === 'place' && (
        <>
          <p className="placement-guidance">{PLACEMENT_HINTS[kind]}</p>
          <label className="batch-mode">
            <input
              type="checkbox"
              checked={batchMode}
              onChange={(e) => {
                cancel();
                setBatchMode(e.target.checked);
                setTool('select');
              }}
            />
            Добавить несколько объектов за один раз
          </label>
          <div className="studio-tools">
            <button
              className={tool === (kind === 'park' ? 'polygon' : 'place') ? 'active' : ''}
              disabled={saving}
              onClick={() => {
                props.onSelect(null);
                setDraft(null);
                setTool(kind === 'park' ? 'polygon' : 'place');
              }}
            >
              <Plus size={14} />
              {kind === 'park' ? 'Нарисовать границу' : 'Выбрать место на карте'}
            </button>
            {kind !== 'park' && (
              <button
                disabled={busy || saving || !!queued.length || !props.client}
                onClick={() => void run('needs')}
              >
                <MapPin size={14} />
                Найти подходящие места
              </button>
            )}
          </div>
          {!!queued.length && (
            <section className="placement-queue" aria-label="Предпросмотр добавления">
              <h3>{batchMode ? `Объекты к применению · ${queued.length}` : 'Предпросмотр объекта'}</h3>
              <p className="studio-note">{placementMessage}</p>
              <p className="studio-note">
                На карте и в показателях показан предпросмотр.{' '}
                {batchMode
                  ? 'Выберите другой тип и добавьте ещё объекты.'
                  : 'Другой щелчок меняет выбранное место.'}
              </p>
              <ol>
                {queued.map((o, i) => (
                  <li key={o.id}>
                    <button onClick={() => props.onFocus(o.entrances)}>
                      {i + 1}. {o.name}
                    </button>
                    <button
                      aria-label={`Убрать из набора ${o.name}`}
                      onClick={() => {
                        const next = queued.filter((x) => x.id !== o.id);
                        setQueued(next);
                        props.onPreview(next.length ? stagedScenario(next) : null);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ol>
              <button
                className="primary-button full-width"
                disabled={saving || props.calculationBusy || !!props.calculationError}
                onClick={() => void applyQueued()}
              >
                <Check size={15} />
                {saving ? 'Применяем…' : `Применить ${batchMode ? 'все объекты' : 'объект'}`}
              </button>
              <button className="text-button" onClick={cancel}>
                Отменить предпросмотр
              </button>
            </section>
          )}
        </>
      )}
      {tool !== 'select' && (
        <div className="studio-hint" role="status">
          {tool === 'place'
            ? 'Выберите пешеходный вход. Затем подтвердите добавление в панели.'
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
      {(panel === 'place' || tool === 'entrance' || tool === 'relocate') && (
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
                stageObject(coordinates);
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
      )}
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
      {panel === 'objects' && (
        <details className="studio-object-picker" open={!draft}>
          <summary>
            {draft ? 'Выбрать другой объект' : `Выберите объект на карте или из списка · ${objects.length}`}
          </summary>
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
        </details>
      )}
      {draft && panel === 'objects' && (
        <section className="studio-object-card">
          <h3>{draft.name}</h3>
          {draft.site && (
            <p className="studio-note">
              Эскизный участок {n(polygonArea(draft.site))} м². Граница и условный объём показаны на карте;
              назначение земли требует проверки.
            </p>
          )}
          <p className="studio-note">
            Выберите маркер и перетащите его. Синие квадраты — вершины, жёлтые точки — входы. Стрелки на
            клавиатуре двигают выбранный объект на 5 м.
          </p>
          {dragging && (
            <div className="studio-hint">Перетаскивание · показатели обновляются по мере расчёта</div>
          )}
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
                {draft.kind === 'parking'
                  ? 'Машино-места'
                  : draft.kind === 'waste_bin'
                    ? 'Количество ёмкостей'
                    : draft.kind === 'playground'
                      ? 'Посетителей одновременно'
                      : 'Базовая вместимость'}
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
                Коэффициент вместимости ×{capacityFactor(draft.kind, draft.level)}.{' '}
                {draft.kind === 'bus_stop'
                  ? `Условный интервал ${STOP_HEADWAYS[draft.level] / 60} мин, ожидание ${STOP_HEADWAYS[draft.level] / 120} мин.`
                  : ''}
              </p>
              <details className="coordinate-placement">
                <summary>Положение по координатам</summary>
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
                          setDraft(dragObject(draft, draft.entrances[0] ?? coordinates, point, 'object', 0));
                        }}
                      />
                    </label>
                  ))}
                </div>
              </details>
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
          {pendingParameters && !dragging && (
            <p className="studio-note" role="status">
              Есть неприменённые параметры. Результаты ниже относятся к сохранённому варианту; нажмите
              «Применить параметры» для пересчёта.
            </p>
          )}
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
                Потенциальная зона: {n(selectedResult.servedResidents)} жителей
              </button>
              {selectedResult.capacity !== null && (
                <button
                  onClick={() =>
                    setExplanation(
                      'Потенциальные жители ближайших домов / эффективная вместимость × 100%. Для парка это стресс-сценарий одновременного посещения всей зоны. Для школы нужны школьные возраста и зачисление; для магазина, клиники и остановки — частота обращений и период времени. Этот коэффициент не является фактической загрузкой.',
                    )
                  }
                >
                  Вместимость {n(selectedResult.capacity)} · отношение к населению зоны{' '}
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
      <PlacementImpact
        analysis={props.analysis}
        busy={props.calculationBusy}
        error={props.calculationError}
        selectedId={props.selectedId}
        kind={kind}
        baseData={props.baseData}
        onSelect={props.onSelect}
        compact={panel === 'place'}
        baselineView={props.baselineView}
      />
      <button className="secondary-button full-width" disabled={!!queued.length} onClick={props.onCompare}>
        Сравнить характеристики до и после
      </button>
      {panel === 'analysis' && (
        <>
          <section className="studio-analysis">
            <h3>Аналитика размещения</h3>
            <p className="studio-note">
              Категория: {OBJECT_KINDS[kind]} · радиус {rules.distanceThresholdM} м по сети.
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
                {selectedResult && (
                  <article className="studio-result">
                    <h4>{selectedResult.name}</h4>
                    <button onClick={() => explainRows(selectedResult.withoutRows)}>
                      Удаление: {n(selectedResult.change.worsenedResidents)} жителям станет дальше;{' '}
                      {n(selectedResult.change.lostWithinResidents)} потеряют доступ в{' '}
                      {rules.distanceThresholdM} м, {n(selectedResult.change.lostReachableResidents)} —
                      достижимость.
                    </button>
                    <button className="secondary-button full-width" onClick={() => setPanel('objects')}>
                      Редактировать объект
                    </button>
                  </article>
                )}
                <button className="studio-number" onClick={() => setExplanation(explainSummary)}>
                  Средний путь {n(result.totals.meanDistanceM)} м · в радиусе{' '}
                  {n(result.totals.withinResidents)} из {n(result.totals.evaluatedResidents)} жителей
                </button>
                {result.totals.meanServiceSeconds !== null && (
                  <button
                    className="studio-number"
                    onClick={() =>
                      setExplanation(
                        'Минимум времени ходьбы + половины заданного интервала среди достижимых остановок. Интервалы уровней: 15 / 10 / 5 минут — сценарное допущение. Равномерное прибытие, без пропуска рейсов и переполнения. Реальные маршруты, направления и расписания не проверены; это не прогноз времени посадки.',
                      )
                    }
                  >
                    Ходьба + условное ожидание: {n(result.totals.meanServiceSeconds / 60)} мин
                  </button>
                )}
                {result.mode === 'needs' && (
                  <>
                    <p className="studio-note">
                      Проверено {result.evaluatedCandidates} точек, шаг до {n(result.spacingM)} м плюс узлы
                      сети. Точный эффект одного нового входа в проверенных точках; цвет между ними
                      интерполирован. Зелёный — больше эффект, серый — нет эффекта. Для остановок проверяется
                      близость к улице, для зданий и площадок — свободное место. Для парка оценивается
                      возможный вход; границу нужно нарисовать отдельно. Топ-3 разнесены минимум на 80 м.
                    </p>
                    {result.top.map((candidate, index) => (
                      <article className="studio-result" key={candidate.id}>
                        <h4>Место {index + 1}</h4>
                        <button onClick={() => props.onFocus([candidate.point])}>
                          <MapPin size={13} />
                          Показать на карте
                        </button>
                        <button onClick={() => explainRows(candidate.rows ?? result.rows)}>
                          −{n(candidate.meanReductionM)} м среднего пути · +{n(candidate.gainResidents)}{' '}
                          жителей в радиусе {rules.distanceThresholdM} м
                        </button>
                        <p>
                          Новая достижимость: {n(candidate.gainReachableResidents)} · X{' '}
                          {n(candidate.point[0])}, Y {n(candidate.point[1])}
                        </p>
                        {!!candidate.accessDistanceM && (
                          <p>
                            Подход от дорожки до входа: {n(candidate.accessDistanceM)} м · учтён в расчёте.
                          </p>
                        )}
                        <button
                          className="secondary-button full-width"
                          disabled={saving}
                          onClick={() => {
                            props.onFocus([candidate.point]);
                            setKind(result.kind);
                            stageObject(candidate.point, result.kind);
                          }}
                        >
                          Проверить и разместить
                        </button>
                      </article>
                    ))}
                    {!result.top.length && (
                      <p className="studio-note">
                        Подходящих точек в исследованной сети не найдено. Попробуйте другой тип объекта или
                        участок территории.
                      </p>
                    )}
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
                          Закрытие: {n(edge.lostResidents)} потеряют радиус, {n(edge.lostReachableResidents)}{' '}
                          — достижимость; хуже {n(edge.affectedResidents)} жителям.
                        </button>
                      </article>
                    ))}
                {result.mode === 'importance' && (
                  <p className="studio-note">
                    Цвет объектов показывает последствия удаления. Краснее — больше жителей потеряют доступ
                    или получат более длинный путь. Индекс цвета = потери порога + потери достижимости + 0,1 ×
                    жители с ухудшением, относительно максимума. Выберите объект для чисел.
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
                              <button onClick={() => explainRows(row.rows)}>
                                {n(row.totals.meanDistanceM)}
                              </button>
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
                      onClick={() => {
                        try {
                          void save(
                            relocateWithContext(
                              district!,
                              draft,
                              relocationPoint,
                              props.scenario.design?.objects,
                              rules.snapDistanceM,
                            ),
                          );
                        } catch (error) {
                          setError(errorText(error));
                        }
                      }}
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
            <button
              className="secondary-button full-width"
              disabled={busy}
              onClick={() => void run('compare')}
            >
              Сравнить выбранные сценарии
            </button>
          </section>
        </>
      )}
      <button className="text-button" onClick={() => setRulesOpen((v) => !v)}>
        Все правила, нормативы и стоимости
      </button>
      {rulesOpen && (
        <section className="studio-rules" aria-label="Допущения модели">
          <h3>Допущения модели</h3>
          <p>
            Эскизные участки:{' '}
            {Object.entries(PLACEMENT_RULES.siteSizesM)
              .map(([id, size]) => `${OBJECT_KINDS[id as Destination['kind']]} ${size[0]} × ${size[1]} м`)
              .join('; ')}
            . Остановка и парковка: до улицы не дальше {PLACEMENT_RULES.roadAccessM} м. Это инженерные
            предположения для выбора места, а не утверждённые строительные нормативы.
          </p>
          <p>
            Назначение земли, санитарные разрывы, сети, подъезд спецтехники и право строительства пока не
            проверяются. Условные объёмы на карте показывают предложение. Парковки, площадки и урны не
            получают дополнительную вместимость от смены уровня.
          </p>
          <p>
            Подход от дорожки до условного входа включён в граф: покрытие — плитка, ширина{' '}
            {PLACEMENT_RULES.approachWidthM} м, уклон и ступени условно отсутствуют. Объём здания занимает{' '}
            {PLACEMENT_RULES.buildingFootprintFactor * 100}% ширины и глубины участка; высоты:{' '}
            {Object.entries(PLACEMENT_RULES.buildingHeightsM)
              .map(([id, height]) => `${OBJECT_KINDS[id as Destination['kind']]} ${height} м`)
              .join('; ')}
            . Машины и оборудование на карте условные, занятость не наблюдается.
          </p>
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
