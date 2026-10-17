import type {
  DeepReadonly,
  DistrictData,
  ProfileMetrics,
  RouteResult,
  EdgeLoadReport,
  ActivitySnapshot,
} from '../core/types.js';
import type { DesignState } from '../core/types.js';
import type { EditorView, EditorEvents } from './editor-types.js';
export type Quality = 'auto' | 'high' | 'eco';
export type ColorMode = 'natural' | 'accessibility' | 'change';
export interface MapLayers {
  buildings: boolean;
  trees: boolean;
  network: boolean;
  residents: boolean;
  loads: boolean;
  labels: boolean;
  projects: boolean;
}
export interface ViewSettings {
  layers: MapLayers;
  colorMode: ColorMode;
  quality: Quality;
  paused: boolean;
  speed: number;
  agentCount: number;
  hour: number;
  planView: boolean;
  heightScale: number;
}
export interface MapState {
  activity?: ActivitySnapshot | null;
  editor?: EditorView;
  design?: DeepReadonly<DesignState>;
  data: DeepReadonly<DistrictData>;
  report: DeepReadonly<ProfileMetrics>;
  baseline: DeepReadonly<ProfileMetrics>;
  metricId: string;
  profileId: string;
  projectIds: readonly string[];
  routes: RouteResult[];
  loads: EdgeLoadReport;
  geometryKey: string;
  selectedId: string | null;
  selectedRoute: RouteResult | null;
}
export interface SceneStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  agents: number;
  movingAgents: number;
  scaleMeters: number;
  scalePixels: number;
}
export interface SceneCallbacks {
  editor?: EditorEvents;
  onSelect: (id: string | null) => void;
  onStats: (stats: SceneStats) => void;
  onError: (message: string | null) => void;
  onCamera: (heading: number) => void;
}
