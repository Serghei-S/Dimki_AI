import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  Minus,
  Layers,
  Sun,
  Play,
  Pause,
  RotateCcw,
  Undo2,
  Redo2,
  Search,
  X,
  Check,
  Footprints,
  Trees,
  Bus,
  School,
  HeartPulse,
  ShoppingBag,
  Building2,
  Settings2,
  Camera,
  Download,
  Save,
  Sparkles,
  LoaderCircle,
  Info,
  Compass,
  Menu,
  Crosshair,
  MapPin,
  Upload,
  ChevronDown,
  FileText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  DeepReadonly,
  DistrictData,
  OptimizationResult,
  ScenarioEnvelope,
  ScenarioInput,
  XY,
} from '../core/types.js';
import type { PlanningService } from './planning-service.js';
import type { MapState, SceneCallbacks, SceneStats, ViewSettings } from '../map/types.js';
import { MapViewport } from './MapViewport.js';
import { EnvironmentSummary } from './EnvironmentSummary.js';
import { ActivityPanel } from './ActivityPanel.js';
import { ActivityComparisonPanel } from './ActivityComparisonPanel.js';
import { PlacementDecisionPanel } from './PlacementDecisionPanel.js';
import { useActivity } from './useActivity.js';
import type { DayType } from '../core/types.js';
import { projectLocations } from '../map/focus.js';
import { OBJECT_KINDS } from '../core/design-rules.js';
import { ACCESS_DIAGNOSTICS_RULES } from '../core/access-diagnostics.js';
import { compareActivitySnapshots } from '../core/activity-comparison.js';
import type { ActivityComparison } from '../core/types.js';
import type { MapHandle } from './MapViewport.js';
import { connectEngine } from './engine-client.js';
import { useAnalysis, useSelectedRoute } from './useAnalysis.js';
import { copyScenario, initialScenario, projectCost, scenarioHistory, selectProjects } from './state.js';
const DesignWorkbench = lazy(() =>
  import('./DesignWorkbench.js').then((module) => ({ default: module.DesignWorkbench })),
);
import { EMPTY_EDITOR } from '../map/editor-types.js';
import type { EditorView, EditorEvents } from '../map/editor-types.js';
import { DISTRICTS } from './districts.js';
import type { DistrictId } from './districts.js';
import type { ScenarioHistory } from './state.js';
import type { PlanningReport } from '../reports/report.js';
const ReportAssistant = lazy(() =>
  import('./ReportAssistant.js').then((m) => ({ default: m.ReportAssistant })),
);
import provenanceUrl from '../../data/obninsk-center.provenance.json?url';

const METRICS: { id: string; name: string; heading: string; icon: LucideIcon }[] = [
  { id: 'park', name: 'Парки и скверы', heading: 'Доступ к зелёным зонам', icon: Trees },
  { id: 'bus_stop', name: 'Общественный транспорт', heading: 'Доступ к остановкам', icon: Bus },
  { id: 'school', name: 'Школы', heading: 'Доступ к школам', icon: School },
  { id: 'clinic', name: 'Поликлиники', heading: 'Доступ к поликлиникам', icon: HeartPulse },
  { id: 'grocery', name: 'Магазины', heading: 'Доступ к магазинам', icon: ShoppingBag },
];
const PROJECT_LABELS: Record<string, { name: string; icon: LucideIcon }> = {
  new_crossing: { name: 'Переход', icon: Footprints },
  accessibility: { name: 'Доступность', icon: Footprints },
  open_passage: { name: 'Пешеходная связь', icon: ArrowUpRight },
  new_park: { name: 'Озеленение', icon: Trees },
  relocate_stop: { name: 'Остановка', icon: Bus },
};
const PROFILE_NAMES: Record<string, string> = {
  walk: 'Пешеход',
  step_free: 'Без ступеней',
  slow_walk: 'Медленно',
};
const money = (value: number) =>
  value >= 1000000
    ? `${(value / 1000000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн ₽`
    : value
      ? `${Math.round(value / 1000).toLocaleString('ru-RU')} тыс. ₽`
      : '0 ₽';
const number = (value: number) => value.toLocaleString('ru-RU');
const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const minutes = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined
    ? 'Недоступно'
    : `${(seconds / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мин`;
const STORAGE = 'obninsk2040:saved-scenarios:v1';
interface SavedScenario {
  id: string;
  name: string;
  envelope: ScenarioEnvelope;
}
function loadSaved(): SavedScenario[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? '[]');
    return Array.isArray(value)
      ? (value
          .filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.envelope)
          .slice(0, 40) as SavedScenario[])
      : [];
  } catch {
    return [];
  }
}
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  report = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  report?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    titleId = useRef(`dialog-${Math.random().toString(36).slice(2)}`);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog--wide' : ''} ${report ? 'dialog--report' : ''}`}
      aria-labelledby={titleId.current}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id={titleId.current}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="Закрыть окно" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App() {
  const [districtId, setDistrictId] = useState<DistrictId>(() => {
    try {
      return localStorage.getItem('obninsk2040:district') === 'sosnovy' ? 'sosnovy' : 'obninsk-center';
    } catch {
      return 'obninsk-center';
    }
  });
  const drafts = useRef(new Map<DistrictId, ScenarioHistory>());
  return (
    <DistrictApp
      key={districtId}
      districtId={districtId}
      initialHistory={drafts.current.get(districtId)}
      onDistrictChange={(next, history) => {
        drafts.current.set(districtId, history);
        setDistrictId(next);
        try {
          localStorage.setItem('obninsk2040:district', next);
        } catch {
          /* Selection remains usable without storage. */
        }
      }}
    />
  );
}
function DistrictApp({
  districtId,
  initialHistory,
  onDistrictChange,
}: {
  districtId: DistrictId;
  initialHistory: ScenarioHistory | undefined;
  onDistrictChange: (id: DistrictId, history: ScenarioHistory) => void;
}) {
  const districtInfo = DISTRICTS[districtId];
  const [buildingSources, setBuildingSources] = useState<
    Record<string, { url: string; floorsAssumed: boolean; heightAssumed: boolean; entranceAssumed: boolean }>
  >({});
  useEffect(() => {
    if (!districtInfo.real) return;
    const controller = new AbortController();
    void fetch(provenanceUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Provenance unavailable');
        return response.json();
      })
      .then((value) => {
        if (!controller.signal.aborted) setBuildingSources(value.buildings);
      })
      .catch(() => {
        /* Calculation does not depend on source metadata download. */
      });
    return () => controller.abort();
  }, []);
  const [connection, setConnection] = useState<{
      client: PlanningService;
      data: DeepReadonly<DistrictData>;
    } | null>(null),
    [fatal, setFatal] = useState<string | null>(null);
  const [history, dispatch] = useReducer(
    scenarioHistory,
    initialHistory ?? {
      current: initialScenario(),
      past: [],
      future: [],
    },
  );
  const [profileId, setProfileId] = useState('walk'),
    [metricId, setMetricId] = useState('park'),
    [tab, setTab] = useState<'overview' | 'projects' | 'scenarios' | 'studio'>('studio');
  const [previewScenario, setPreviewScenario] = useState<ScenarioInput | null>(null),
    [editorView, setEditorView] = useState<EditorView>(EMPTY_EDITOR);
  const [editorLaunch, setEditorLaunch] = useState(0);
  const [dayType, setDayType] = useState<DayType>('weekday');
  const [reportSnapshot, setReportSnapshot] = useState<PlanningReport | null>(null);
  const editorEvents = useRef<EditorEvents | null>(null),
    costCache = useRef(new Map<string, number>());
  const scenarioRef = useRef(history.current);
  scenarioRef.current = history.current;
  const projectCheck = useRef(false),
    [checkingProject, setCheckingProject] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [sidebarOpen, setSidebarOpen] = useState(false);
  const [scenarioComparison, setScenarioComparison] = useState<{
    before: ScenarioInput;
    after: ScenarioInput;
  } | null>(null);
  const [settings, setSettings] = useState<ViewSettings>(() => ({
    layers: {
      buildings: true,
      trees: true,
      residents: false,
      loads: true,
      network: false,
      labels: true,
      projects: false,
    },
    colorMode: 'natural',
    quality: 'auto',
    paused: matchMedia('(prefers-reduced-motion: reduce)').matches,
    speed: 20,
    agentCount: 360,
    hour: 8,
    planView: false,
    heightScale: 1.5,
  }));
  const activeOverlay = editorView.overlay;
  const viewportSettings = useMemo(
    () =>
      activeOverlay && ['needs', 'vulnerability'].includes(activeOverlay.mode)
        ? { ...settings, layers: { ...settings.layers, loads: false } }
        : settings,
    [settings, activeOverlay?.mode],
  );
  const [stats, setStats] = useState<SceneStats>({
      fps: 0,
      drawCalls: 0,
      triangles: 0,
      agents: 360,
      movingAgents: 0,
      scaleMeters: 0,
      scalePixels: 0,
    }),
    [heading, setHeading] = useState(0);
  const [layersOpen, setLayersOpen] = useState(false),
    [infoOpen, setInfoOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [sceneError, setSceneError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [searchOpen, setSearchOpen] = useState(false);
  const [saved, setSaved] = useState<SavedScenario[]>(() =>
      loadSaved()
        .filter((s) => s.envelope.datasetId === districtInfo.datasetId)
        .slice(0, 20),
    ),
    [saveOpen, setSaveOpen] = useState(false),
    [saveName, setSaveName] = useState(''),
    [saving, setSaving] = useState(false);
  const [optimizerOpen, setOptimizerOpen] = useState(false),
    [optimizing, setOptimizing] = useState(false),
    [optimization, setOptimization] = useState<OptimizationResult | null>(null),
    [optimizationError, setOptimizationError] = useState<string | null>(null),
    [progress, setProgress] = useState(0),
    [keepProjects, setKeepProjects] = useState(true);
  const optimizer = useRef<AbortController | null>(null),
    map = useRef<MapHandle>(null),
    importFile = useRef<HTMLInputElement>(null);
  const pendingProjectFocus = useRef<string[] | null>(null);
  const pendingLocationFocus = useRef<XY[] | null>(null);
  const data = connection?.data ?? null,
    client = connection?.client ?? null;
  const savedComparison =
    scenarioComparison && JSON.stringify(scenarioComparison.after) === JSON.stringify(history.current)
      ? scenarioComparison
      : null;
  const decisionPair = previewScenario
    ? { before: history.current, after: previewScenario }
    : savedComparison;
  const changedKinds = useMemo(() => {
    if (!decisionPair) return [];
    const oldObjects = new Map(decisionPair.before.design?.objects.map((o) => [o.id, o]));
    const newObjects = new Map(decisionPair.after.design?.objects.map((o) => [o.id, o]));
    return [
      ...new Set(
        [...oldObjects.keys(), ...newObjects.keys()].flatMap((id) => {
          const a = oldObjects.get(id),
            b = newObjects.get(id);
          return JSON.stringify(a) === JSON.stringify(b) ? [] : [(b ?? a)!.kind];
        }),
      ),
    ];
  }, [decisionPair?.before, decisionPair?.after]);
  const effectiveScenario = previewScenario ?? history.current;
  const {
    analysis: completedAnalysis,
    busy,
    error,
  } = useAnalysis(client, data, effectiveScenario, profileId, metricId, false);
  const {
    snapshot: activity,
    busy: activityBusy,
    error: activityError,
  } = useActivity(
    client,
    effectiveScenario,
    profileId,
    settings.hour,
    dayType,
    settings.layers.residents || Boolean(scenarioComparison),
  );
  const comparisonBeforeScenario = scenarioComparison?.before ?? history.current;
  const comparisonAfterScenario = scenarioComparison?.after ?? history.current;
  const { snapshot: activityBefore } = useActivity(
    client,
    comparisonBeforeScenario,
    profileId,
    settings.hour,
    dayType,
    true,
    Boolean(savedComparison) && !previewScenario,
  );
  const { snapshot: activityAfter } = useActivity(
    client,
    comparisonAfterScenario,
    profileId,
    settings.hour,
    dayType,
    true,
    Boolean(savedComparison) && !previewScenario,
  );
  const activityComparison = useMemo<ActivityComparison | null>(
    () =>
      data && activityBefore && activityAfter && savedComparison && !previewScenario
        ? compareActivitySnapshots(data, activityBefore, activityAfter)
        : null,
    [data, activityBefore, activityAfter, savedComparison, previewScenario],
  );
  const analysis =
    completedAnalysis?.profileId === profileId &&
    completedAnalysis.metricId === metricId &&
    completedAnalysis.scenario === effectiveScenario
      ? completedAnalysis
      : null;
  const committedDistrict = useRef<DeepReadonly<DistrictData> | null>(null);
  if (analysis?.scenario === history.current) committedDistrict.current = analysis.district;
  const comparisonAnalysis = analysis;
  const selectedRoute = useSelectedRoute(client, analysis, selectedId);
  const selectedEdge = analysis?.district.edges.find((edge) => edge.id === selectedId);
  const selectedLoad = activity?.loads.edges.find((edge) => edge.edgeId === selectedId);
  useEffect(() => {
    const controller = new AbortController();
    let owned: PlanningService | null = null;
    void connectEngine(controller.signal, districtId)
      .then((result) => {
        if (controller.signal.aborted) {
          result.client.dispose();
          return;
        }
        owned = result.client;
        setConnection(result);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setFatal(err instanceof Error ? err.message : String(err));
      });
    return () => {
      controller.abort();
      owned?.dispose();
      optimizer.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (error) setToast(`Расчёт не выполнен: ${error}`);
  }, [error]);
  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);
  const onStats = useCallback((next: SceneStats) => setStats(next), []);
  const onError = useCallback((message: string | null) => setSceneError(message), []);
  const onCamera = useCallback((value: number) => setHeading(value), []);
  const callbacks = useMemo<SceneCallbacks>(
    () => ({
      onSelect,
      onStats,
      onError,
      onCamera,
      editor: {
        point: (point) => editorEvents.current?.point(point),
        drag: (event) => editorEvents.current?.drag(event),
        cancel: () => editorEvents.current?.cancel(),
      },
    }),
    [onSelect, onStats, onError, onCamera],
  );
  const mapState = useMemo<MapState | null>(
    () =>
      analysis
        ? {
            data: analysis.district,
            report: analysis.result.profiles[profileId]!,
            baseline: analysis.baseline.profiles[profileId]!,
            metricId,
            profileId,
            projectIds: analysis.result.scenario.projectIds,
            routes: analysis.routes,
            loads: analysis.loads,
            activity,
            activityBefore,
            activityComparison,
            geometryKey: JSON.stringify({
              projects: analysis.result.scenario.projectIds,
              operations: analysis.result.scenario.operationalOverrides ?? [],
              design: analysis.result.scenario.design ?? null,
            }),
            selectedId,
            selectedRoute,
            ...(analysis.result.scenario.design ? { design: analysis.result.scenario.design } : {}),
          }
        : null,
    [analysis, profileId, metricId, selectedId, selectedRoute, activity, activityBefore, activityComparison],
  );
  // During a profile/metric transition keep the last complete, internally consistent snapshot.
  const renderedState = useRef<MapState | null>(null);
  if (mapState?.report && mapState.report.destinations[metricId]) renderedState.current = mapState;
  const renderedMap = renderedState.current;
  const state = useMemo(
    () =>
      renderedMap
        ? {
            ...renderedMap,
            activity: mapState?.activity ?? null,
            activityBefore: mapState?.activityBefore ?? null,
            activityComparison: mapState?.activityComparison ?? null,
            editor: editorView,
            selectedId,
            selectedRoute: renderedMap.selectedId === selectedId ? renderedMap.selectedRoute : null,
          }
        : null,
    [renderedMap, editorView, selectedId, mapState],
  );
  const report = analysis?.result.profiles[profileId],
    currentMetric = METRICS.find((m) => m.id === metricId)!;
  function showMetricProblem(id: string) {
    setMetricId(id);
    setSettings((old) => ({ ...old, colorMode: 'accessibility' }));
    const value = comparisonAnalysis;
    if (!value) return;
    const result = value.result.profiles[profileId]!;
    const worst = [...result.perBuilding]
      .filter(
        (h) =>
          h.destinations[id]!.evaluatedResidents > 0 &&
          (h.destinations[id]!.travelSeconds === null ||
            h.destinations[id]!.travelSeconds! >
              result.destinations[id]!.thresholdSeconds * ACCESS_DIAGNOSTICS_RULES.longRouteFraction),
      )
      .sort(
        (a, b) =>
          (b.destinations[id]!.travelSeconds ?? Infinity) - (a.destinations[id]!.travelSeconds ?? Infinity),
      )[0];
    if (worst) {
      setSelectedId(worst.buildingId);
      map.current?.focus(worst.buildingId);
    }
    setSidebarOpen(false);
  }
  useEffect(() => {
    if (pendingProjectFocus.current && completedAnalysis?.scenario === history.current) {
      map.current?.focusProjects(pendingProjectFocus.current);
      pendingProjectFocus.current = null;
    }
    if (pendingLocationFocus.current && completedAnalysis?.scenario === history.current) {
      map.current?.focusLocations(pendingLocationFocus.current);
      pendingLocationFocus.current = null;
    }
  }, [completedAnalysis, history.current]);
  const committedKey = JSON.stringify(history.current);
  if (completedAnalysis?.scenario === history.current) {
    costCache.current.set(committedKey, completedAnalysis.result.costs.capexRub);
    if (costCache.current.size > 80) costCache.current.delete(costCache.current.keys().next().value!);
  }
  const cost =
    costCache.current.get(committedKey) ?? (data ? projectCost(data, history.current.projectIds) : 0);
  const selectedBuilding = data?.buildings.find((b) => b.id === selectedId),
    selectedProject = data?.projects.find((p) => p.id === selectedId),
    selectedDestination = analysis?.district.destinations.find((d) => d.id === selectedId);
  const selectedAccess = report?.perBuilding.find((b) => b.buildingId === selectedId)?.destinations[metricId];
  const searchableDistrict = analysis?.district ?? state?.data ?? data;
  const searchResults = useMemo(
    () =>
      !data || !query.trim()
        ? []
        : [
            ...data.buildings.map((b) => ({
              id: b.id,
              name: b.name,
              detail:
                b.kind === 'residential'
                  ? `${b.floors} этажей · ${b.population?.total} жителей`
                  : 'Общественное здание',
            })),
            ...(searchableDistrict?.destinations ?? data.destinations)
              .filter((d) => d.active && ['park', 'bus_stop'].includes(d.kind))
              .map((d) => ({
                id: d.id,
                name: d.name,
                detail: d.kind === 'park' ? 'Зелёная зона' : 'Остановка',
              })),
          ]
            .filter((item) =>
              `${item.name} ${item.id}`.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')),
            )
            .slice(0, 7),
    [data, searchableDistrict, query],
  );
  function apply(scenario: ScenarioInput, capexRub?: number) {
    const previous = history.current;
    const previousObjects = new Set((previous.design?.objects ?? []).map((object) => object.id));
    const addedObject = (scenario.design?.objects ?? []).some(
      (object) => object.active && !previousObjects.has(object.id),
    );
    if (addedObject) {
      setScenarioComparison({ before: copyScenario(previous), after: copyScenario(scenario) });
      setTab('overview');
      setSidebarOpen(true);
    } else if (scenario.design && JSON.stringify(scenario.design) !== JSON.stringify(previous.design)) {
      setScenarioComparison({ before: copyScenario(previous), after: copyScenario(scenario) });
    } else {
      setScenarioComparison(null);
    }
    if (JSON.stringify(scenario.projectIds) !== JSON.stringify(history.current.projectIds)) {
      pendingProjectFocus.current = scenario.projectIds.length
        ? [...scenario.projectIds]
        : [...history.current.projectIds];
      setSettings((s) => ({ ...s, layers: { ...s.layers, projects: true } }));
    }
    if (capexRub !== undefined) costCache.current.set(JSON.stringify(scenario), capexRub);
    setPreviewScenario(null);
    dispatch({ type: 'apply', scenario });
  }
  async function toggleProject(id: string) {
    if (!data || projectCheck.current) return;
    try {
      const next = selectProjects(data, history.current, id);
      if (next.design && client) {
        projectCheck.current = true;
        setCheckingProject(true);
        const evaluated = await client.evaluate(next, [profileId]);
        if (scenarioRef.current === history.current) apply(next, evaluated.costs.capexRub);
      } else apply(next);
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    } finally {
      projectCheck.current = false;
      setCheckingProject(false);
    }
  }
  function setBudget(budgetRub: number) {
    if (budgetRub < cost) {
      setToast('Бюджет меньше стоимости выбранных проектов. Сначала уберите часть изменений.');
      return;
    }
    apply({ ...history.current, budgetRub });
  }
  function choose(id: string) {
    setSelectedId(id);
    setSearchOpen(false);
    setQuery('');
    map.current?.focus(id);
    setSidebarOpen(false);
  }
  function showChanges() {
    if (!data) return;
    setSettings((s) => ({ ...s, layers: { ...s.layers, projects: true } }));
    const points = [
      ...projectLocations(data, history.current.projectIds),
      ...(history.current.design?.objects.filter((o) => o.active).flatMap((o) => o.entrances) ?? []),
    ];
    if (analysis?.scenario === history.current) map.current?.focusLocations(points);
    else pendingLocationFocus.current = points;
  }
  async function saveScenario() {
    if (!client || !saveName.trim()) return;
    setSaving(true);
    try {
      const envelope = await client.exportScenario(history.current),
        next = [{ id: crypto.randomUUID(), name: saveName.trim().slice(0, 60), envelope }, ...saved].slice(
          0,
          20,
        );
      localStorage.setItem(
        STORAGE,
        JSON.stringify(
          [...next, ...loadSaved().filter((s) => s.envelope.datasetId !== districtInfo.datasetId)].slice(
            0,
            40,
          ),
        ),
      );
      setSaved(next);
      setSaveOpen(false);
      setSaveName('');
      setToast('Сценарий сохранён в этом браузере');
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Не удалось сохранить сценарий');
    } finally {
      setSaving(false);
    }
  }
  async function downloadScenario() {
    if (!client) return;
    try {
      saveBlob(
        new Blob([JSON.stringify(await client.exportScenario(history.current), null, 2)], {
          type: 'application/json',
        }),
        'obninsk-scenario.json',
      );
    } catch (err) {
      setToast(String(err));
    }
  }
  async function importScenario(file: File) {
    if (!client) return;
    if (file.size > 1000000) {
      setToast('Файл сценария должен быть меньше 1 МБ');
      return;
    }
    try {
      apply(await client.importScenario(await file.text()));
      setToast('Сценарий загружен');
    } catch {
      setToast('Не удалось загрузить сценарий. Проверьте формат и версию района.');
    }
  }
  async function screenshot() {
    try {
      const blob = await map.current?.screenshot();
      if (blob) {
        saveBlob(blob, 'dimki-ai-map.png');
        setToast('Изображение 3D-сцены сохранено');
      }
    } catch {
      setToast('Сначала дождитесь загрузки 3D-карты');
    }
  }
  async function runOptimization() {
    if (!client) return;
    optimizer.current?.abort();
    const controller = new AbortController();
    optimizer.current = controller;
    setOptimizing(true);
    setOptimization(null);
    setOptimizationError(null);
    setProgress(0);
    try {
      const result = await client.optimize(
        {
          profileId,
          metricId,
          budgetRub: history.current.budgetRub,
          topK: 3,
          ...(keepProjects ? { requiredProjectIds: [...history.current.projectIds] } : {}),
          operationalOverrides: [...(history.current.operationalOverrides ?? [])],
          ...(history.current.design ? { design: history.current.design } : {}),
        },
        {
          signal: controller.signal,
          onProgress: (p) => setProgress(p.totalSubsets ? p.processedSubsets / p.totalSubsets : 0),
        },
      );
      if (!controller.signal.aborted) setOptimization(result);
    } catch (err) {
      if (!controller.signal.aborted) setOptimizationError(err instanceof Error ? err.message : String(err));
    } finally {
      if (optimizer.current === controller) setOptimizing(false);
    }
  }
  const closeOptimizer = () => {
    optimizer.current?.abort();
    setOptimizing(false);
    setOptimizerOpen(false);
  };
  const patchSettings = (patch: Partial<ViewSettings>) => setSettings((old) => ({ ...old, ...patch }));
  const toggleLayer = (key: keyof ViewSettings['layers']) =>
    setSettings((old) => ({ ...old, layers: { ...old.layers, [key]: !old.layers[key] } }));

  return (
    <div className="application">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Димки AI">
          <strong>
            Димки <b>AI</b>
          </strong>
        </a>
        <nav className="topnav" aria-label="Основная навигация">
          <button
            className={tab !== 'scenarios' ? 'active' : ''}
            aria-current={tab !== 'scenarios' ? 'page' : undefined}
            onClick={() => {
              setTab('studio');
              setSidebarOpen(true);
            }}
          >
            Конструктор
          </button>
          <button
            className={tab === 'scenarios' ? 'active' : ''}
            aria-current={tab === 'scenarios' ? 'page' : undefined}
            onClick={() => {
              setTab('scenarios');
              setSidebarOpen(true);
            }}
          >
            Сценарии
          </button>
        </nav>
        <div className="topbar-actions">
          <button
            className="report-open-button"
            aria-label="Открыть отчёт и AI-помощника"
            title="Отчёт и AI-помощник"
            disabled={!analysis || !data || busy || Boolean(previewScenario)}
            onClick={() => {
              if (!analysis || !data) return;
              void import('../reports/report.js')
                .then(({ makeReport }) => {
                  setReportSnapshot(makeReport(data, analysis.result, analysis.baseline, analysis.profileId));
                })
                .catch(() => setToast('Не удалось создать отчёт. Повторите расчёт.'));
            }}
          >
            <FileText size={17} />
            <span>Отчёт</span>
          </button>
          <button
            className="top-icon"
            aria-label="Сохранить изображение карты"
            title="Сохранить PNG 3D-сцены"
            onClick={() => void screenshot()}
            disabled={!state}
          >
            <Camera size={19} />
          </button>
          <button
            className="save-button"
            aria-label="Сохранить сценарий"
            onClick={() => setSaveOpen(true)}
            disabled={!client}
          >
            <Save size={15} />
            <span>Сохранить</span>
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside
          className={`sidebar ${sidebarOpen ? 'sidebar--open' : ''} ${tab === 'studio' ? 'sidebar--studio' : ''}`}
        >
          <div className="sidebar-intro">
            <div className="eyebrow">
              <span />
              Территория анализа{' '}
              <button
                className="mobile-close icon-button"
                aria-label="Закрыть панель"
                onClick={() => setSidebarOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <h1>{districtInfo.name}</h1>
            <details className="district-tools">
              <summary>Территория и поиск</summary>
              <label className="district-switch">
                <span>Территория</span>
                <select
                  aria-label="Выбор территории"
                  value={districtId}
                  onChange={(e) => onDistrictChange(e.target.value as DistrictId, history)}
                >
                  <option value="obninsk-center">Центр Обнинска · реальная геометрия</option>
                  <option value="sosnovy">Сосновый · прежний район</option>
                </select>
              </label>
              <div className="object-search">
                <Search size={15} />
                <input
                  aria-label="Найти дом или объект"
                  placeholder="Найти дом или объект"
                  value={query}
                  onFocus={() => setSearchOpen(true)}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSearchOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSearchOpen(false);
                    if (e.key === 'Enter' && searchResults[0]) choose(searchResults[0].id);
                  }}
                />
                {searchOpen && query && (
                  <div className="search-results">
                    {searchResults.length ? (
                      searchResults.map((item) => (
                        <button key={item.id} onClick={() => choose(item.id)}>
                          <Building2 size={16} />
                          <span>
                            <strong>{item.name}</strong>
                            <small>{item.detail}</small>
                          </span>
                          <ArrowUpRight size={13} />
                        </button>
                      ))
                    ) : (
                      <p>Объекты не найдены</p>
                    )}
                  </div>
                )}
              </div>
            </details>
          </div>
          <div className="sidebar-tabs" role="tablist" aria-label="Панели района">
            {(
              [
                ['studio', 'Редактор'],
                ['overview', 'Среда'],
                ['projects', 'Проекты'],
                ['scenarios', 'Сценарии'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'active' : ''}
                onClick={() => {
                  setTab(id);
                  if (id === 'projects')
                    setSettings((s) => ({ ...s, layers: { ...s.layers, projects: true } }));
                }}
              >
                {label}
                {id === 'projects' && <span>{history.current.projectIds.length || 12}</span>}
              </button>
            ))}
          </div>
          <div className="sidebar-scroll">
            {decisionPair &&
              changedKinds.map((kind) => (
                <PlacementDecisionPanel
                  key={kind}
                  client={client}
                  before={decisionPair.before}
                  after={decisionPair.after}
                  kind={kind}
                  profileId={profileId}
                  preview={Boolean(previewScenario)}
                />
              ))}
            {activityComparison && (
              <details className="placement-flow-detail">
                <summary>Потоки в выбранный час · подробное сравнение</summary>
                <ActivityComparisonPanel value={activityComparison} hour={settings.hour} dayType={dayType} />
              </details>
            )}
            <Suspense fallback={<p className="studio-note">Загрузка редактора…</p>}>
              <DesignWorkbench
                active={tab === 'studio'}
                launch={editorLaunch}
                client={client}
                baseData={data}
                district={committedDistrict.current ?? data}
                analysis={analysis}
                calculationBusy={busy}
                calculationError={error}
                baselineView={false}
                onKindChange={(kind) => {
                  if (METRICS.some((m) => m.id === kind)) setMetricId(kind);
                }}
                onProfileChange={setProfileId}
                onFocus={(points) => map.current?.focusLocations(points)}
                onCompare={() => setTab('overview')}
                scenario={history.current}
                profileId={profileId}
                selectedId={selectedId}
                saved={saved}
                onSelect={onSelect}
                onApply={apply}
                onPreview={(scenario) => {
                  setPreviewScenario(scenario);
                  if (scenario) {
                    setSidebarOpen(true);
                  }
                }}
                onView={setEditorView}
                onNotify={setToast}
                events={editorEvents}
              />
            </Suspense>
            {fatal ? (
              <div className="inline-error">
                <h3>Не удалось загрузить район</h3>
                <p>{fatal}</p>
                <button className="primary-button" onClick={() => location.reload()}>
                  Повторить
                </button>
              </div>
            ) : !data ? (
              <div className="sidebar-loading">
                <LoaderCircle className="spin" />
                Загружаем модель района…
              </div>
            ) : (
              <>
                {tab === 'overview' && (
                  <EnvironmentSummary
                    analysis={comparisonAnalysis}
                    busy={busy}
                    onMetric={showMetricProblem}
                    onCompare={showChanges}
                  />
                )}
                {tab === 'projects' && (
                  <>
                    <div className="section-heading">
                      <h2>Изменения района</h2>
                      <span>{data.projects.length} проектов</span>
                    </div>
                    <p className="panel-description">
                      Добавляйте инфраструктуру и смотрите, как меняются маршруты жителей.
                    </p>
                    <div className="budget-control">
                      <label htmlFor="budget">
                        Бюджет проекта <strong>{money(history.current.budgetRub)}</strong>
                      </label>
                      <input
                        id="budget"
                        type="range"
                        min="0"
                        max="12000000"
                        step="250000"
                        value={history.current.budgetRub}
                        onChange={(e) => setBudget(Number(e.target.value))}
                      />
                      <div>
                        <span>Выбрано на {money(cost)}</span>
                        <span>осталось {money(history.current.budgetRub - cost)}</span>
                      </div>
                    </div>
                    <div className="project-list">
                      {data.projects.map((p) => {
                        const kind = PROJECT_LABELS[p.kind]!,
                          checked = history.current.projectIds.includes(p.id);
                        return (
                          <label
                            key={p.id}
                            className={`project-card ${checked ? 'project-card--selected' : ''}`}
                          >
                            <input
                              type="checkbox"
                              aria-label={p.name}
                              checked={checked}
                              disabled={checkingProject}
                              onChange={() => void toggleProject(p.id)}
                            />
                            <span className="project-checkbox">{checked && <Check size={12} />}</span>
                            <div>
                              <span className="project-category">
                                <kind.icon size={12} />
                                {kind.name}
                              </span>
                              <h3>{p.name}</h3>
                              <span className="project-price">{money(p.cost.capexRub)}</span>
                              {p.requires.length > 0 && (
                                <small className="dependency-note">Потребуется создание сквера</small>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
                {tab === 'scenarios' && (
                  <>
                    <div className="section-heading">
                      <h2>Готовые сценарии</h2>
                      <span>{data.scenarios.length}</span>
                    </div>
                    <p className="panel-description">
                      Сравните подходы к благоустройству или сохраните свой вариант.
                    </p>
                    <div className="scenario-list">
                      {data.scenarios.map((s, i) => (
                        <button
                          key={s.id}
                          className="scenario-card"
                          onClick={() => {
                            apply(s);
                            setToast(`Применён сценарий «${s.name}»`);
                          }}
                        >
                          <span className={`scenario-art scenario-art--${i % 4}`}>
                            <Building2 size={28} />
                            <Trees size={22} />
                            <i />
                          </span>
                          <span className="scenario-card-text">
                            <strong>{s.name}</strong>
                            <small>
                              {s.projectIds.length} проектов · {money(projectCost(data, s.projectIds))}
                            </small>
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    </div>
                    <div className="section-heading saved-heading">
                      <h2>Ваши варианты</h2>
                      <button className="text-button" onClick={() => setSaveOpen(true)}>
                        <Plus size={14} />
                        Сохранить
                      </button>
                    </div>
                    {saved.length ? (
                      saved.map((s) => (
                        <button
                          className="saved-scenario"
                          key={s.id}
                          onClick={() => {
                            void client
                              ?.importScenario(s.envelope)
                              .then(apply)
                              .catch(() => setToast('Вариант относится к другой версии района'));
                          }}
                        >
                          <Save size={16} />
                          <span>{s.name}</span>
                          <ArrowUpRight size={14} />
                        </button>
                      ))
                    ) : (
                      <p className="empty-note">
                        Сохранённые сценарии появятся здесь. Они хранятся в вашем браузере.
                      </p>
                    )}
                    <div className="file-actions">
                      <button onClick={() => void downloadScenario()}>
                        <Download size={14} />
                        Экспорт JSON
                      </button>
                      <button onClick={() => importFile.current?.click()}>
                        <Upload size={14} />
                        Импорт
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <>
            <ActivityPanel
              value={activity}
              busy={activityBusy}
              error={activityError}
              hour={settings.hour}
              dayType={dayType}
              onHour={(h) => patchSettings({ hour: h })}
              onDay={setDayType}
            />
            <div className="pedestrian-mode">
              <span>
                <Footprints size={15} /> Пешеход
              </span>
              <details>
                <summary>{profileId === 'walk' ? 'Режимы ходьбы' : PROFILE_NAMES[profileId]}</summary>
                <p>Альтернативные условия расчёта для тех же жителей.</p>
                {data?.profiles.map((p) => (
                  <label key={p.id}>
                    <input
                      type="radio"
                      name="walking-mode"
                      value={p.id}
                      checked={profileId === p.id}
                      onChange={() => setProfileId(p.id)}
                    />
                    <span>
                      {PROFILE_NAMES[p.id] ?? p.name}
                      <small>{p.description}</small>
                    </span>
                  </label>
                ))}
              </details>
            </div>
            <div className="sidebar-bottom">
              <button
                className="optimize-button"
                disabled={!client || busy}
                onClick={() => {
                  setOptimizerOpen(true);
                  setOptimization(null);
                  setOptimizationError(null);
                }}
              >
                <Sparkles size={17} />
                <span>Подобрать улучшения</span>
                <ArrowUpRight size={16} />
              </button>
              <span>Расчёт с учётом вашего бюджета</span>
            </div>
          </>
        </aside>
        {sidebarOpen && (
          <button
            className="sidebar-scrim"
            aria-label="Закрыть боковую панель"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <main className="map-workspace" aria-label="Карта района">
          {state ? (
            <MapViewport ref={map} state={state} settings={viewportSettings} callbacks={callbacks} />
          ) : (
            <div className="map-loading">
              <div className="loading-city">
                <i />
                <i />
                <i />
                <i />
              </div>
              <h2>{fatal ? 'Район не загружен' : 'Собираем 3D-макет'}</h2>
              <p>{fatal ? 'Повторите загрузку данных' : 'Геометрия, маршруты и жизнь района'}</p>
              <LoaderCircle className="spin" size={18} />
            </div>
          )}
          <div className="map-topline">
            <div className="map-breadcrumb">
              <button
                className="mobile-menu icon-button"
                aria-label="Открыть панель района"
                onClick={() => setSidebarOpen(true)}
              >
                <Menu size={18} />
              </button>
              <span className="map-live-dot" />
              <strong>{districtInfo.name}</strong>
              <span className="breadcrumb-divider">/</span>
              <span>Городская среда</span>
            </div>
          </div>
          <div className="view-bar">
            <div className="view-toggle" aria-label="Представление карты">
              <button
                className={!settings.planView ? 'active' : ''}
                onClick={() => patchSettings({ planView: false })}
              >
                3D
              </button>
              <button
                className={settings.planView ? 'active' : ''}
                onClick={() => patchSettings({ planView: true })}
              >
                План
              </button>
            </div>
            <span className={`calculation-status ${busy ? 'busy' : ''}`}>
              {busy ? (
                <>
                  <LoaderCircle size={12} className="spin" />
                  Пересчёт
                </>
              ) : (
                <>
                  <Check size={12} />
                  Рассчитано
                </>
              )}
            </span>
          </div>
          <div className="map-toolbar" aria-label="Управление картой">
            <button title="Увеличить" aria-label="Увеличить карту" onClick={() => map.current?.zoom(0.8)}>
              <Plus size={19} />
            </button>
            <button title="Уменьшить" aria-label="Уменьшить карту" onClick={() => map.current?.zoom(1.25)}>
              <Minus size={19} />
            </button>
            <span />
            <button
              title="Весь район (Home)"
              aria-label="Показать весь район"
              onClick={() => {
                map.current?.home();
                patchSettings({ planView: false });
              }}
            >
              <Crosshair size={19} />
            </button>
            <button
              title="Слои и качество"
              aria-label="Слои и настройки карты"
              className={layersOpen ? 'active' : ''}
              onClick={() => setLayersOpen((v) => !v)}
            >
              <Layers size={19} />
            </button>
            <button
              title="Управление камерой"
              aria-label="Как управлять картой"
              onClick={() => setHelpOpen((v) => !v)}
            >
              <Info size={18} />
            </button>
          </div>
          <button
            className="compass"
            aria-label="Вернуть исходный ракурс"
            title="Север · вернуть исходный ракурс"
            onClick={() => map.current?.home()}
          >
            <span>С</span>
            <Compass size={25} style={{ transform: `rotate(${-heading}deg)` }} />
          </button>
          {layersOpen && (
            <section className="layers-panel floating-panel">
              <div className="floating-heading">
                <h2>Карта и отображение</h2>
                <button
                  className="icon-button"
                  aria-label="Закрыть настройки"
                  onClick={() => setLayersOpen(false)}
                >
                  <X size={17} />
                </button>
              </div>
              <label className="section-label">Цвет зданий</label>
              <div className="style-options">
                {(
                  [
                    ['natural', 'Материалы'],
                    ['accessibility', 'Близость'],
                    ['change', 'Эффект'],
                  ] as const
                ).map(([id, name]) => (
                  <button
                    key={id}
                    className={settings.colorMode === id ? 'active' : ''}
                    onClick={() => patchSettings({ colorMode: id })}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="layer-switches">
                {(
                  [
                    ['buildings', 'Здания', Building2],
                    ['trees', 'Деревья', Trees],
                    ['loads', 'Нагрузка рёбер', ArrowUpRight],
                    ['residents', 'Фигуры жителей', Footprints],
                    ['labels', 'Подписи объектов', Info],
                    ['network', 'Пешеходная сеть', ArrowUpRight],
                    ['projects', 'Места улучшений', Plus],
                  ] as const
                ).map(([key, name, Icon]) => (
                  <button
                    key={key}
                    role="switch"
                    aria-checked={settings.layers[key]}
                    onClick={() => toggleLayer(key)}
                  >
                    <Icon size={15} />
                    <span>{name}</span>
                    <i className={settings.layers[key] ? 'switch switch--on' : 'switch'} />
                  </button>
                ))}
              </div>
              <div className="settings-divider" />
              <label className="section-label" htmlFor="quality">
                Качество сцены
              </label>
              <select
                id="quality"
                value={settings.quality}
                onChange={(e) => patchSettings({ quality: e.target.value as ViewSettings['quality'] })}
              >
                <option value="auto">Авто · сбалансированное</option>
                <option value="high">Высокое · до 1 600 фигур</option>
                <option value="eco">Экономное · до 250 фигур</option>
              </select>
              <label className="range-label" htmlFor="density">
                Лимит фигур <b>{settings.agentCount}</b>
              </label>
              <input
                id="density"
                type="range"
                min="100"
                max="1600"
                step="20"
                value={settings.agentCount}
                onChange={(e) => patchSettings({ agentCount: Number(e.target.value) })}
              />
              <p className="setting-note">
                Фигуры увеличены для наглядности. В сцене сейчас {stats.agents}; это выборка, не всё
                население.
              </p>
              <label className="range-label" htmlFor="height-scale">
                Масштаб высоты <b>{settings.heightScale.toLocaleString('ru-RU')}×</b>
              </label>
              <input
                id="height-scale"
                type="range"
                min="1"
                max="2"
                step=".25"
                value={settings.heightScale}
                onChange={(e) => patchSettings({ heightScale: Number(e.target.value) })}
              />
            </section>
          )}
          <button
            className="editor-entry-button"
            aria-pressed={editorView.active && (editorView.tool === 'place' || editorView.tool === 'polygon')}
            onClick={() => {
              setEditorLaunch((value) => value + 1);
              setSelectedId(null);
              setTab('studio');
              setSidebarOpen(true);
            }}
          >
            <Plus size={14} />
            {tab === 'studio' ? 'Новый объект' : 'Объект в любой точке'}
          </button>
          {editorView.active && (editorView.tool === 'place' || editorView.tool === 'polygon') && (
            <div className="map-placement-hint" role="status">
              <MapPin size={17} />
              <span>
                <strong>{OBJECT_KINDS[editorView.kind]} · размещение включено</strong>
                <small>
                  {editorView.tool === 'polygon'
                    ? 'Отмечайте углы границы на карте. Завершите границу в редакторе.'
                    : 'Нажмите на тротуар или дорожку. Затем подтвердите объект в редакторе.'}
                </small>
              </span>
              <button
                className="icon-button"
                aria-label="Отменить размещение"
                onClick={() => editorEvents.current?.cancel()}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {previewScenario && (
            <div className="editor-preview-badge" role="status">
              Предварительный пересчёт
            </div>
          )}
          {helpOpen && (
            <section className="help-panel floating-panel">
              <div className="floating-heading">
                <h2>Управление</h2>
                <button
                  className="icon-button"
                  aria-label="Закрыть подсказку"
                  onClick={() => setHelpOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <p>Перетаскивание — перемещение карты</p>
              <p>Правая кнопка мыши — поворот</p>
              <p>Колесо или + / − — масштаб</p>
              <p>Нажмите на дом, чтобы увидеть его маршрут</p>
              <p>Home — весь район · Esc — снять выбор</p>
            </section>
          )}
          {tab !== 'studio' &&
            !layersOpen &&
            (selectedBuilding || selectedProject || selectedDestination || selectedEdge) && (
              <section className="object-panel floating-panel">
                <div className="floating-heading">
                  <span className="eyebrow">
                    {selectedEdge
                      ? 'Нагрузка участка'
                      : selectedBuilding
                        ? 'Объект района'
                        : selectedProject
                          ? 'Проект благоустройства'
                          : 'Инфраструктура'}
                  </span>
                  <button
                    className="icon-button"
                    aria-label="Снять выбор объекта"
                    onClick={() => setSelectedId(null)}
                  >
                    <X size={17} />
                  </button>
                </div>
                <h2>
                  {selectedBuilding?.name ??
                    selectedProject?.name ??
                    selectedDestination?.name ??
                    'Пешеходный участок'}
                </h2>
                {selectedBuilding && (
                  <>
                    <p className="object-subtitle">
                      {districtInfo.real ? (
                        data?.blocks.find((b) => b.id === selectedBuilding.blockId)?.name
                      ) : (
                        <>
                          Квартал{' '}
                          {selectedBuilding.blockId
                            .slice(1)
                            .split('')
                            .map((x) => Number(x) + 1)
                            .join('.')}
                        </>
                      )}{' '}
                      · {buildingSources[selectedBuilding.id]?.floorsAssumed ? '≈' : ''}
                      {selectedBuilding.floors} этажей ·{' '}
                      {buildingSources[selectedBuilding.id]?.heightAssumed ? '≈' : ''}
                      {selectedBuilding.heightM.toLocaleString('ru-RU')} м
                    </p>
                    {districtInfo.real && (
                      <p className="waiting-note">
                        <a
                          href={`https://www.openstreetmap.org/way/${selectedBuilding.id.replace('osm_building_', '')}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Контур и теги здания в OSM ↗
                        </a>
                        . Население оценочное. Знак ≈ — параметр смоделирован. Вход:{' '}
                        {buildingSources[selectedBuilding.id]
                          ? buildingSources[selectedBuilding.id]!.entranceAssumed
                            ? 'приближённый'
                            : 'отмечен в OSM'
                          : 'уточняется по источнику'}
                        ; соединение с сетью моделируется.
                      </p>
                    )}
                    <div className="object-population">
                      <Building2 size={18} />
                      <span>
                        {selectedBuilding.population ? (
                          <>
                            <strong>{number(selectedBuilding.population.total)}</strong> жителей ·{' '}
                            {selectedBuilding.population.households} семей
                          </>
                        ) : (
                          'Общественное здание'
                        )}
                      </span>
                    </div>
                    {selectedBuilding.population && (
                      <>
                        <div className="object-route-heading">
                          <currentMetric.icon size={15} />
                          <span>{currentMetric.name}</span>
                        </div>
                        <div className="object-route-number">
                          <strong>{minutes(selectedAccess?.travelSeconds)}</strong>
                          {selectedRoute?.distanceM !== null && selectedRoute?.distanceM !== undefined && (
                            <span>{Math.round(selectedRoute.distanceM)} м по сети</span>
                          )}
                        </div>
                        <div
                          className={`route-status ${selectedAccess?.withinThreshold ? 'route-status--good' : ''}`}
                        >
                          {selectedAccess?.withinThreshold ? <Check size={13} /> : <Info size={13} />}{' '}
                          {!analysis
                            ? 'Обновляем маршрут…'
                            : selectedAccess?.reachable
                              ? selectedAccess.withinThreshold
                                ? 'В пределах выбранного порога'
                                : 'Дальше выбранного порога'
                              : 'Нет доступного маршрута'}
                        </div>
                        {selectedRoute?.waitingSeconds ? (
                          <p className="waiting-note">
                            Ожидание на переходах: {Math.round(selectedRoute.waitingSeconds)} с
                          </p>
                        ) : null}
                        <button
                          className="secondary-button full-width"
                          onClick={() => map.current?.focus(selectedBuilding.id)}
                        >
                          <Crosshair size={14} />
                          Приблизить к дому
                        </button>
                      </>
                    )}
                  </>
                )}
                {selectedEdge && (
                  <>
                    <p className="object-subtitle">
                      {selectedEdge.id} · {Math.round(selectedEdge.lengthM)} м · ширина {selectedEdge.widthM}{' '}
                      м
                    </p>
                    <div className="object-route-number">
                      <strong>{percent(selectedLoad?.load)}</strong>
                      <span>ожидаемых проходов за час</span>
                    </div>
                    <p className="object-description">
                      {!selectedLoad
                        ? 'Поток ещё не рассчитан для этого состояния.'
                        : selectedLoad.eligible
                          ? `Все цели, ${settings.hour}:00. В направлении ребра: ${percent(selectedLoad.forward)}; обратно: ${percent(selectedLoad.backward)}.`
                          : 'Участок закрыт или недоступен выбранному профилю.'}
                    </p>
                    <p className="waiting-note">
                      Поток рассчитан по целям, расписанию и группам населения. Это условная модель, а не
                      измеренная плотность толпы.
                    </p>
                  </>
                )}
                {selectedProject && (
                  <>
                    <p className="object-description">{selectedProject.description}</p>
                    <div className="object-project-price">
                      <span>Стоимость проекта</span>
                      <strong>{money(selectedProject.cost.capexRub)}</strong>
                    </div>
                    <button
                      className="primary-button full-width"
                      onClick={() => toggleProject(selectedProject.id)}
                    >
                      {history.current.projectIds.includes(selectedProject.id) ? (
                        <>
                          <Check size={15} />
                          Убрать из проекта
                        </>
                      ) : (
                        <>
                          <Plus size={15} />
                          Добавить улучшение
                        </>
                      )}
                    </button>
                  </>
                )}
                {selectedDestination && !selectedBuilding && (
                  <>
                    <p className="object-description">
                      {selectedDestination.kind === 'park'
                        ? 'Доступность рассчитывается до входов по пешеходной сети.'
                        : selectedDestination.kind === 'bus_stop'
                          ? 'Остановка. Моделируется пеший доступ; интервал уровня доступен в редакторе.'
                          : 'Точечный объект. Доступность рассчитывается по пешеходной сети до его входа.'}
                    </p>
                    <button
                      className="secondary-button full-width"
                      onClick={() => map.current?.focus(selectedDestination.id)}
                    >
                      <Crosshair size={14} />
                      Приблизить
                    </button>
                  </>
                )}
              </section>
            )}
          {sceneError && (
            <div className="scene-error" role="alert">
              <Info size={16} />
              {sceneError}
            </div>
          )}
          <div className="simulation-bar">
            <div className="simulation-title">
              <span className="simulation-icon">
                <Footprints size={21} />
              </span>
              <div>
                <strong>
                  {settings.layers.residents ? 'Жизнь района' : 'Нагрузка сети'}{' '}
                  <i className={!settings.layers.residents || settings.paused ? 'paused' : ''} />
                </strong>
                <span>
                  {settings.layers.residents
                    ? `${stats.agents} фигур · выборка жителей`
                    : 'Все жители · без анимации'}
                </span>
              </div>
            </div>
            <span className="simulation-divider" />
            <button
              className="people-toggle"
              aria-label="Показывать фигуры жителей"
              aria-pressed={settings.layers.residents}
              title="Отдельный слой фигур жителей"
              onClick={() => toggleLayer('residents')}
            >
              <Footprints size={17} />
              <span>Жители</span>
            </button>
            <button
              className="play-button"
              disabled={!settings.layers.residents}
              aria-label={settings.paused ? 'Запустить движение жителей' : 'Поставить жителей на паузу'}
              onClick={() => patchSettings({ paused: !settings.paused })}
            >
              {settings.paused ? (
                <Play size={17} fill="currentColor" />
              ) : (
                <Pause size={17} fill="currentColor" />
              )}
            </button>
            <label className="speed-select">
              <select
                aria-label="Скорость анимации"
                disabled={!settings.layers.residents}
                value={settings.speed}
                onChange={(e) => patchSettings({ speed: Number(e.target.value) })}
              >
                {[1, 10, 20, 40, 80].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <span className="simulation-divider" />
            <div className="daylight-control">
              <Sun size={17} />
              <label htmlFor="sunlight" className="sr-only">
                Время суток и поток людей
              </label>
              <input
                id="sunlight"
                type="range"
                min="0"
                max="23"
                step="1"
                value={settings.hour}
                onChange={(e) => patchSettings({ hour: Number(e.target.value) })}
              />
              <span>{String(settings.hour).padStart(2, '0')}:00</span>
            </div>
            <button
              className="simulation-info"
              aria-label="Как устроена анимация жителей"
              onClick={() => setInfoOpen(true)}
            >
              <Info size={16} />
            </button>
          </div>
          <div className="map-footer">
            <div className="history-controls">
              <button
                aria-label="Отменить изменение"
                title="Отменить"
                disabled={!history.past.length}
                onClick={() => {
                  setPreviewScenario(null);
                  dispatch({ type: 'undo' });
                }}
              >
                <Undo2 size={15} />
              </button>
              <button
                aria-label="Повторить изменение"
                title="Повторить"
                disabled={!history.future.length}
                onClick={() => {
                  setPreviewScenario(null);
                  dispatch({ type: 'redo' });
                }}
              >
                <Redo2 size={15} />
              </button>
              <button
                aria-label="Сбросить все изменения"
                title="Исходный район"
                onClick={() => apply(initialScenario())}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <span className="fps-indicator">
              <i className={stats.fps < 25 ? 'slow' : ''} />
              {!settings.layers.residents
                ? 'По запросу'
                : settings.paused
                  ? 'Пауза'
                  : `${stats.fps || '—'} FPS`}
              <span
                className="scale-rule"
                style={{ width: stats.scalePixels || 50, minWidth: 0, flexShrink: 0 }}
              >
                {stats.scaleMeters ? `${stats.scaleMeters} м` : null}
              </span>
            </span>
          </div>
        </main>
      </div>
      <input
        ref={importFile}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Файл сценария"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importScenario(file);
          e.target.value = '';
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <Info size={16} />
          <span>{toast}</span>
          <button className="icon-button" aria-label="Скрыть уведомление" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {reportSnapshot && (
        <Dialog
          title="Отчёт по району"
          subtitle={reportSnapshot.district}
          report
          onClose={() => setReportSnapshot(null)}
        >
          <Suspense fallback={<p className="studio-note">Готовим отчёт…</p>}>
            <ReportAssistant snapshot={reportSnapshot} />
          </Suspense>
        </Dialog>
      )}
      {saveOpen && (
        <Dialog
          title="Сохранить сценарий"
          subtitle="Вариант останется в этом браузере. Его также можно экспортировать в JSON."
          onClose={() => setSaveOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveScenario();
            }}
          >
            <label className="field-label" htmlFor="scenario-name">
              Название варианта
            </label>
            <input
              id="scenario-name"
              className="text-input"
              autoFocus
              maxLength={60}
              placeholder="Например, зелёный район"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
            <div className="save-summary">
              <span>{history.current.projectIds.length} проектов</span>
              <strong>{money(cost)}</strong>
            </div>
            <button className="primary-button full-width" disabled={!saveName.trim() || saving} type="submit">
              {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Сохранить вариант
            </button>
          </form>
        </Dialog>
      )}
      {infoOpen && (
        <Dialog
          title="Как устроена модель"
          subtitle={data?.metadata.name ?? districtInfo.name}
          onClose={() => setInfoOpen(false)}
          wide
        >
          <div className="model-info">
            <div className="model-info-row">
              <span>
                <Building2 size={21} />
              </span>
              <div>
                <h3>Согласованные данные района</h3>
                <p>
                  {data?.buildings.filter((b) => b.population).length ?? 0} жилых домов,{' '}
                  {number(data?.buildings.reduce((sum, b) => sum + (b.population?.total ?? 0), 0) ?? 0)}{' '}
                  условных жителей и {data?.edges.filter((e) => e.active).length ?? 0} активных участков
                  пешеходной сети.{' '}
                  {districtInfo.real
                    ? 'Контуры основных зданий и оси улиц — OpenStreetMap. Входы и часть дорожек смоделированы. Население, вместимость и стоимости условные.'
                    : 'Геометрия, население и стоимости полностью синтетические.'}
                </p>
                {districtInfo.real && (
                  <p>
                    <a href={districtInfo.mapUrl!} target="_blank" rel="noreferrer">
                      Этот участок на OpenStreetMap ↗
                    </a>{' '}
                    ·{' '}
                    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                      © OpenStreetMap contributors, ODbL 1.0
                    </a>
                  </p>
                )}
              </div>
            </div>
            <div className="model-info-row">
              <span>
                <Footprints size={21} />
              </span>
              <div>
                <h3>Реальные расчёты по графу</h3>
                <p>
                  В слое «Близость» зелёный цвет означает путь до ¼ порога, светлый зелёный — до ½, оранжевый
                  — до ¾, терракотовый — дольше ¾, серый — недостижимость. Это доля бюджета времени, а не
                  юридический норматив. Маршруты учитывают длину, покрытие, ожидание на переходах и
                  ограничения профиля. Доступность парка считается до входа, а недостижимые жители остаются в
                  статистике.
                </p>
              </div>
            </div>
            <div className="model-info-row">
              <span>
                <Play size={20} />
              </span>
              <div>
                <h3>Потоки зависят от выбранного часа</h3>
                <p>
                  На рёбрах суммируются ожидаемые перемещения на работу, учёбу, за покупками, в парк и к
                  врачу. Утром преобладают отправления, вечером — возвращения домой и отдых. В выходной нет
                  обычных школьных поездок. Шкала 300 проходов/час фиксирована между часами и сценариями, это
                  не предел пропускной способности.
                </p>
                <p>
                  Фигуры — выборка текущих перемещений по тем же маршрутам и направлениям. Их количество
                  зависит от ожидаемого числа людей на сети. Скорость анимации ускоряет только воспроизведение
                  часового среза. Расписания, доли участия и неизвестные часы работы условные и видны в панели
                  потоков.
                </p>
              </div>
            </div>
            <div className="model-info-row">
              <span>
                <Sun size={21} />
              </span>
              <div>
                <h3>Часовой срез и освещение</h3>
                <p>
                  Ползунок времени меняет поток и свет. Часы работы известны частично; используются видимые
                  допущения. Вместимость и перегрузка доступны в редакторе; движение автобусов и очереди не
                  моделируются. Высота зданий на макете масштабируется отдельно от расчётов.
                </p>
              </div>
            </div>
            <p className="model-info-note">
              Результаты предназначены для сравнения учебных сценариев. Модель не является официальным
              прогнозом развития города.
            </p>
            {data?.metadata.limitations.map((text, index) => (
              <p className="model-info-note" key={index}>
                {text}
              </p>
            ))}
          </div>
        </Dialog>
      )}
      {optimizerOpen && (
        <Dialog
          title="Подобрать улучшения"
          subtitle={`${currentMetric.heading} · ${PROFILE_NAMES[profileId]} · бюджет ${money(history.current.budgetRub)}`}
          onClose={closeOptimizer}
          wide
        >
          {!optimization && !optimizing && (
            <>
              <p className="optimization-intro">
                Переберём допустимые сочетания проектов, учтём зависимости и бюджет. В результат не попадут
                более дорогие варианты с тем же или худшим эффектом.
              </p>
              <label className="keep-projects">
                <input
                  type="checkbox"
                  checked={keepProjects}
                  onChange={(e) => setKeepProjects(e.target.checked)}
                />
                Сохранить выбранные проекты обязательными
              </label>
              {optimizationError && <p className="inline-error">{optimizationError}</p>}
              <button className="primary-button full-width" onClick={() => void runOptimization()}>
                <Sparkles size={16} />
                Рассчитать варианты
              </button>
            </>
          )}
          {optimizing && (
            <div className="optimization-progress">
              <LoaderCircle size={28} className="spin" />
              <h3>Сравниваем сценарии</h3>
              <p>Рассчитываем доступность на каждом допустимом варианте</p>
              <div className="progress-track">
                <span style={{ width: `${progress * 100}%` }} />
              </div>
              <strong>{Math.round(progress * 100)}%</strong>
              <button
                className="secondary-button"
                onClick={() => {
                  optimizer.current?.abort();
                  setOptimizing(false);
                }}
              >
                Отменить расчёт
              </button>
            </div>
          )}
          {optimization && (
            <>
              <div className="optimization-found">
                <Check size={16} />
                {number(optimization.feasibleSubsets)} допустимых сочетаний · {optimization.frontierSize}{' '}
                вариантов без доминирования
              </div>
              <div className="optimization-results">
                {optimization.alternatives.map((a, i) => (
                  <section key={a.projectIds.join('|')}>
                    <div className="alternative-heading">
                      <span>
                        {i === 0 ? (
                          <>
                            <Sparkles size={13} />
                            Лучший по выбранной цели
                          </>
                        ) : (
                          `Вариант ${i + 1}`
                        )}
                      </span>
                      <strong>{money(a.costs.capexRub)}</strong>
                    </div>
                    <div className="alternative-metrics">
                      <strong>
                        {percent(a.metric.coveragePercent)}
                        <small>% в пределах порога</small>
                      </strong>
                      <span>
                        {minutes(a.metric.meanSecondsReachableOnly)}
                        <small>средний путь</small>
                      </span>
                    </div>
                    <ul>
                      {a.projectIds.length ? (
                        a.projectIds.map((id) => (
                          <li key={id}>
                            <Check size={12} />
                            {data?.projects.find((p) => p.id === id)?.name}
                          </li>
                        ))
                      ) : (
                        <li>Исходный район уже лучший для этой цели и бюджета.</li>
                      )}
                    </ul>
                    <button
                      className={i === 0 ? 'primary-button full-width' : 'secondary-button full-width'}
                      onClick={() => {
                        apply({
                          projectIds: a.projectIds,
                          budgetRub: history.current.budgetRub,
                          operationalOverrides: history.current.operationalOverrides ?? [],
                          ...(history.current.design ? { design: history.current.design } : {}),
                        });
                        closeOptimizer();
                        setToast('Рассчитанный вариант применён');
                      }}
                    >
                      Применить вариант <ArrowRight size={15} />
                    </button>
                  </section>
                ))}
              </div>
              <p className="optimization-note">
                Точный выбор среди 12 подготовленных проектов. Приоритет: охват жителей, достижимость, время
                пути, затем расходы.
              </p>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
