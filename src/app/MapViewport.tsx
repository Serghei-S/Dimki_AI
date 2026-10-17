import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { GIS_THEME } from '../map/theme.js';
import { DistrictScene } from '../map/scene.js';
import type { MapState, SceneCallbacks, ViewSettings } from '../map/types.js';
import type { XY } from '../core/types.js';

export interface MapHandle {
  home: () => void;
  zoom: (factor: number) => void;
  focus: (id: string) => void;
  focusLocations: (points: readonly XY[]) => void;
  focusProjects: (ids: readonly string[]) => void;
  screenshot: () => Promise<Blob>;
}
interface Props {
  state: MapState;
  settings: ViewSettings;
  callbacks: SceneCallbacks;
}
export const MapViewport = forwardRef<MapHandle, Props>(function MapViewport(
  { state, settings, callbacks },
  ref,
) {
  const host = useRef<HTMLDivElement>(null),
    scene = useRef<DistrictScene | null>(null),
    latest = useRef({ state, settings, callbacks });
  latest.current = { state, settings, callbacks };
  const [failed, setFailed] = useState(false);
  useImperativeHandle(
    ref,
    () => ({
      home: () => scene.current?.home(),
      zoom: (f) => scene.current?.zoom(f),
      focus: (id) => scene.current?.focus(id),
      focusLocations: (points) => scene.current?.focusLocations(points),
      focusProjects: (ids) => scene.current?.focusProjects(ids),
      screenshot: () =>
        scene.current ? scene.current.screenshot() : Promise.reject(new Error('3D-карта недоступна')),
    }),
    [],
  );
  useEffect(() => {
    if (!host.current) return;
    try {
      const current = new DistrictScene(host.current, latest.current.state, {
        onSelect: (id) => latest.current.callbacks.onSelect(id),
        onStats: (stats) => latest.current.callbacks.onStats(stats),
        onError: (error) => latest.current.callbacks.onError(error),
        onCamera: (angle) => latest.current.callbacks.onCamera(angle),
        editor: {
          point: (point) => latest.current.callbacks.editor?.point(point),
          drag: (event) => latest.current.callbacks.editor?.drag(event),
          cancel: () => latest.current.callbacks.editor?.cancel(),
        },
      });
      scene.current = current;
      current.setSettings(latest.current.settings);
      return () => {
        current.dispose();
        scene.current = null;
      };
    } catch (error) {
      setFailed(true);
      latest.current.callbacks.onError(error instanceof Error ? error.message : 'WebGL недоступен');
    }
  }, []);
  useEffect(() => {
    scene.current?.setState(state);
  }, [state]);
  useEffect(() => {
    scene.current?.setSettings(settings);
  }, [settings]);
  return (
    <div ref={host} className="map-viewport" data-testid="map-viewport">
      {failed && (
        <div className="map-fallback">
          <svg
            viewBox={`${state.data.metadata.boundsM[0]} ${-state.data.metadata.boundsM[3]} ${state.data.metadata.boundsM[2] - state.data.metadata.boundsM[0]} ${state.data.metadata.boundsM[3] - state.data.metadata.boundsM[1]}`}
            role="img"
            aria-label="Схема района при недоступности 3D"
          >
            {state.data.blocks.map((b) => (
              <polygon
                key={b.id}
                points={b.polygon.map((p) => `${p[0]},${-p[1]}`).join(' ')}
                fill={GIS_THEME.block}
              />
            ))}
            {state.data.roads.map((r) => (
              <polygon
                key={r.id}
                points={r.polygon.map((p) => `${p[0]},${-p[1]}`).join(' ')}
                fill={GIS_THEME.road}
              />
            ))}
            {state.data.edges
              .filter((e) => e.active)
              .map((e) => (
                <polyline
                  key={e.id}
                  points={e.geometry.map((p) => `${p[0]},${-p[1]}`).join(' ')}
                  fill="none"
                  stroke={GIS_THEME.path}
                  strokeWidth={3}
                />
              ))}
            {state.data.buildings.map((b) => (
              <polygon
                key={b.id}
                points={b.polygon.map((p) => `${p[0]},${-p[1]}`).join(' ')}
                fill={b.id === state.selectedId ? GIS_THEME.selection : GIS_THEME.residential[0]}
                stroke={GIS_THEME.marker}
                onClick={() => callbacks.onSelect(b.id)}
              />
            ))}
          </svg>
          <p>Показана схема. Для 3D включите аппаратное ускорение в браузере.</p>
        </div>
      )}
    </div>
  );
});
