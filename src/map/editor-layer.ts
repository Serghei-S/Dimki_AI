import * as THREE from 'three';
import type { DeepReadonly, DistrictData, DesignState, XY } from '../core/types.js';
import type { EditHandle, EditorView } from './editor-types.js';
import { EMPTY_EDITOR } from './editor-types.js';
import { disposeObject, world, bounds, lineSegments } from './geometry.js';
import { pointAlong } from '../core/design-geometry.js';
export class EditorLayer {
  readonly group = new THREE.Group();
  pickables: THREE.Object3D[] = [];
  setData(
    data: DeepReadonly<DistrictData>,
    view: EditorView = EMPTY_EDITOR,
    design?: DeepReadonly<DesignState>,
  ): void {
    for (const child of [...this.group.children]) disposeObject(child);
    this.pickables = [];
    const nodes = new Map(data.nodes.map((n) => [n.id, n])),
      edited = new Set(design?.objects.map((o) => o.id) ?? []);
    const importance = new Map(view.overlay?.objects.map((o) => [o.id, o]) ?? []),
      maxImportance = Math.max(
        1,
        ...[...importance.values()].map(
          (o) =>
            o.change.lostWithinResidents + o.change.lostReachableResidents + o.change.worsenedResidents * 0.1,
        ),
      );
    const markers: { point: XY; height: number; size: number; color: string; handle: EditHandle }[] = [];
    for (const d of data.destinations.filter((d) => d.active)) {
      if (!view.active && !edited.has(d.id) && !d.id.startsWith('user_')) continue;
      const parcel = data.parcels.find((p) => p.id === d.parcelId),
        raw = parcel ? bounds(parcel.polygon).center : nodes.get(d.accessNodeIds[0] ?? '')?.xy;
      if (!raw) continue;
      const draft = view.draft?.id === d.id ? view.draft : null,
        point = draft
          ? draft.polygon
            ? bounds(draft.polygon).center
            : (draft.entrances[0] ?? ([...raw] as XY))
          : ([...raw] as XY);
      const score = importance.get(d.id),
        ratio = score
          ? (score.change.lostWithinResidents +
              score.change.lostReachableResidents +
              score.change.worsenedResidents * 0.1) /
            maxImportance
          : 0;
      const color =
        view.overlay?.mode === 'importance' && score
          ? new THREE.Color('#aebbb1').lerp(new THREE.Color('#de6650'), ratio).getStyle()
          : d.id === view.selectedId
            ? '#1a99b1'
            : edited.has(d.id)
              ? '#d89141'
              : '#6d9683';
      markers.push({
        point,
        height: 14,
        size: d.id === view.selectedId ? 6 : 4.6,
        color,
        handle: { id: d.id, part: 'object', index: 0 },
      });
    }
    const add = (items: typeof markers, geometry: THREE.BufferGeometry) => {
      if (!items.length) {
        geometry.dispose();
        return;
      }
      const mesh = new THREE.InstancedMesh(
          geometry,
          new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
          items.length,
        ),
        dummy = new THREE.Object3D();
      items.forEach((item, i) => {
        dummy.position.copy(world(item.point, item.height));
        dummy.scale.setScalar(item.size);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new THREE.Color(item.color));
      });
      mesh.userData.handles = items.map((i) => i.handle);
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.pickables.push(mesh);
    };
    add(markers, new THREE.IcosahedronGeometry(1, 1));
    if (view.active && view.draft?.kind === 'park' && view.draft.polygon) {
      const object = view.draft;
      this.group.add(lineSegments(object.polygon!, 2.3, '#2d94b6'));
      add(
        object.polygon!.slice(0, -1).map((point, index) => ({
          point,
          height: 3.7,
          size: 3.3,
          color: '#428ca6',
          handle: { id: object.id, part: 'vertex', index },
        })),
        new THREE.BoxGeometry(1, 1, 1),
      );
      const entrancePoints = object.autoEntrances
        ? (data.destinations
            .find((d) => d.id === object.id)
            ?.accessNodeIds.map((id) => [...nodes.get(id)!.xy] as XY) ?? object.entrances)
        : object.entrances;
      add(
        entrancePoints.map((point, index) => ({
          point,
          height: 6,
          size: 4.2,
          color: '#e4a94f',
          handle: { id: object.id, part: 'entrance', index },
        })),
        new THREE.SphereGeometry(1, 8, 6),
      );
    }
    if (view.polygon.length > 1) this.group.add(lineSegments(view.polygon, 3, '#3d9c9d', true));
    const overlay = view.overlay;
    if (overlay?.mode === 'needs' || overlay?.mode === 'vulnerability') {
      const scores = new Map<string, number>();
      if (overlay.mode === 'needs')
        for (const c of overlay.candidates)
          scores.set(
            c.edgeId,
            Math.max(
              scores.get(c.edgeId) ?? 0,
              c.gainResidents + c.gainReachableResidents + (c.meanReductionM ?? 0) * 0.01,
            ),
          );
      else
        for (const e of overlay.vulnerabilities)
          scores.set(e.edgeId, e.lostResidents + e.lostReachableResidents + e.affectedResidents * 0.1);
      const maximum = Math.max(1, ...scores.values());
      const segments = data.edges
        .filter((e) => e.active && scores.has(e.id))
        .flatMap((e) => {
          if (overlay.mode !== 'needs')
            return e.geometry.slice(1).map((b, i) => ({ a: e.geometry[i]!, b, score: scores.get(e.id)! }));
          const samples = overlay.candidates
            .filter((c) => c.edgeId === e.id)
            .sort((a, b) => a.alongM - b.alongM);
          const value = (c: (typeof samples)[number]) =>
            c.gainResidents + c.gainReachableResidents + (c.meanReductionM ?? 0) * 0.01;
          const scoreAt = (d: number) => {
            const right = samples.findIndex((c) => c.alongM >= d);
            if (right === 0) return value(samples[0]!);
            if (right < 0) return value(samples.at(-1)!);
            const a = samples[right - 1]!,
              b = samples[right]!,
              t = (d - a.alongM) / (b.alongM - a.alongM);
            return value(a) * (1 - t) + value(b) * t;
          };
          let along = 0;
          return e.geometry.slice(1).flatMap((b, i) => {
            const a = e.geometry[i]!,
              length = Math.hypot(b[0] - a[0], b[1] - a[1]),
              count = Math.ceil(length / 12),
              start = along;
            along += length;
            return Array.from({ length: count }, (_, j) => ({
              a: pointAlong([a, b], (length * j) / count),
              b: pointAlong([a, b], (length * (j + 1)) / count),
              score: scoreAt(start + (length * (j + 0.5)) / count),
            }));
          });
        });
      const geometry = new THREE.PlaneGeometry(1, 1);
      geometry.rotateX(-Math.PI / 2);
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: '#ffffff',
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
        Math.max(1, segments.length),
      );
      mesh.count = segments.length;
      mesh.renderOrder = 4;
      const dummy = new THREE.Object3D();
      segments.forEach(({ a, b, score }, i) => {
        const ratio = score / maximum;
        dummy.position.copy(world([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1.7));
        dummy.rotation.y = Math.atan2(b[0] - a[0], -(b[1] - a[1]));
        dummy.scale.set(3 + ratio * 7, 1, Math.hypot(b[0] - a[0], b[1] - a[1]));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(
          i,
          new THREE.Color('#a6b2ac').lerp(
            new THREE.Color(overlay.mode === 'needs' ? '#2d9e75' : '#d6584b'),
            ratio,
          ),
        );
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }
  handle(hit: THREE.Intersection): EditHandle | null {
    return (hit.object.userData.handles as EditHandle[] | undefined)?.[hit.instanceId ?? -1] ?? null;
  }
  dispose(): void {
    disposeObject(this.group);
    this.pickables = [];
  }
}
