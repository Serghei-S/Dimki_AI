import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type { DeepReadonly, DistrictData } from '../core/types.js';
import { edgeBlockReason } from '../core/graph.js';
import { ACTIVITY_RULES } from '../core/daily-activity.js';
import { ResidentLayer } from './residents.js';
import { FlowLayer } from './flow-layer.js';
import { EditorLayer } from './editor-layer.js';
import type { EditHandle } from './editor-types.js';
import type { XY } from '../core/types.js';
import { pointAlong, lengthOf, projectSegment } from '../core/design-geometry.js';
import { createActivityMotionPaths, deterministicRandom } from './motion.js';
import { accessibilityColor, differenceColor } from './palette.js';
import { GIS_THEME } from './theme.js';
import {
  bounds,
  world,
  shape,
  flatPolygon,
  lineSegments,
  disposeObject,
  distanceToSegment,
  pointInside,
} from './geometry.js';
import type { Point } from './geometry.js';
import { SpatialIndex } from './spatial.js';
import { createLawnSizer } from './lawns.js';
import { projectLocations } from './focus.js';
import { PLACEMENT_RULES } from '../core/placement.js';
import type { MotionPath } from './motion.js';
import type { MapState, SceneCallbacks, ViewSettings } from './types.js';

interface BoxItem {
  point: Point;
  y: number;
  size: [number, number, number];
  angle?: number;
  color?: THREE.ColorRepresentation;
}
interface Label {
  element: HTMLDivElement;
  point: THREE.Vector3;
  public: boolean;
  id: string;
}
const DAY_BG = GIS_THEME.background;
const INITIAL: ViewSettings = {
  layers: {
    buildings: true,
    trees: true,
    network: false,
    residents: false,
    loads: true,
    labels: true,
    projects: false,
  },
  colorMode: 'natural',
  quality: 'auto',
  paused: false,
  speed: 20,
  agentCount: 360,
  hour: 8,
  planView: false,
  heightScale: 1.5,
};

export class DistrictScene {
  readonly #host: HTMLElement;
  readonly #callbacks: SceneCallbacks;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(39, 1, 1, 15000);
  readonly #renderer: THREE.WebGLRenderer;
  readonly #controls: MapControls;
  readonly #district = new THREE.Group();
  readonly #terrain = new THREE.Group();
  readonly #buildings = new THREE.Group();
  readonly #infrastructure = new THREE.Group();
  readonly #trees = new THREE.Group();
  readonly #network = new THREE.Group();
  readonly #projects = new THREE.Group();
  readonly #selection = new THREE.Group();
  readonly #focusHighlight = new THREE.Group();
  readonly #route = new THREE.Group();
  #residents: ResidentLayer | null = null;
  readonly #flow = new FlowLayer();
  readonly #editor = new EditorLayer();
  #dragging: EditHandle | null = null;
  readonly #sun = new THREE.DirectionalLight('#fffaf2', 3);
  readonly #ambient = new THREE.HemisphereLight('#f1f6ff', '#bac5ce', 1.7);
  readonly #labels: Label[] = [];
  readonly #labelHost = document.createElement('div');
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #pickables: THREE.Object3D[] = [];
  readonly #resize: ResizeObserver;
  #settings: ViewSettings = structuredClone(INITIAL);
  #state: MapState;
  #motionPaths: MotionPath[] = [];
  #body!: THREE.InstancedMesh;
  #roof!: THREE.InstancedMesh;
  #windows!: THREE.InstancedMesh;
  #buildingOrder: string[] = [];
  #complexBuildings = new Map<string, THREE.Mesh>();
  #windowMaterial = new THREE.MeshStandardMaterial({ color: '#bacbd8', roughness: 0.5, metalness: 0.12 });
  #frame = 0;
  #last = 0;
  #lastRender = 0;
  #lastStats = performance.now();
  #frames = 0;
  #dirty = true;
  #disposed = false;
  #lost = false;
  #width = 1;
  #height = 1;
  #radius = 1300;
  #down = { x: 0, y: 0 };
  #cameraTransition: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    targetFrom: THREE.Vector3;
    targetTo: THREE.Vector3;
    start: number;
  } | null = null;

  constructor(host: HTMLElement, state: MapState, callbacks: SceneCallbacks) {
    this.#host = host;
    this.#state = state;
    this.#callbacks = callbacks;
    this.#renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.#renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
    this.#renderer.setClearColor(DAY_BG);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.08;
    this.#renderer.shadowMap.enabled = true;
    this.#renderer.shadowMap.type = THREE.PCFShadowMap;
    this.#renderer.shadowMap.autoUpdate = false;
    this.#renderer.domElement.className = 'district-canvas';
    this.#renderer.domElement.setAttribute(
      'aria-label',
      `Интерактивная 3D-модель: ${state.data.metadata.name}`,
    );
    this.#renderer.domElement.setAttribute('role', 'img');
    this.#renderer.domElement.tabIndex = 0;
    this.#labelHost.className = 'map-labels';
    host.append(this.#renderer.domElement, this.#labelHost);
    this.#scene.background = new THREE.Color(DAY_BG);
    const [x0, y0, x1, y1] = state.data.metadata.boundsM;
    this.#district.position.set(-(x0 + x1) / 2, 0, (y0 + y1) / 2);
    this.#radius = Math.max(x1 - x0, y1 - y0);
    this.#scene.fog = new THREE.Fog(DAY_BG, this.#radius * 5, this.#radius * 12);
    this.#scene.add(this.#district, this.#sun, this.#sun.target, this.#ambient);
    this.#district.add(
      this.#terrain,
      this.#buildings,
      this.#infrastructure,
      this.#trees,
      this.#network,
      this.#projects,
      this.#selection,
      this.#focusHighlight,
      this.#route,
      this.#flow.group,
      this.#editor.group,
    );
    this.#sun.castShadow = true;
    this.#sun.shadow.mapSize.set(2048, 2048);
    this.#sun.shadow.bias = -0.00025;
    this.#sun.shadow.normalBias = 1.5;
    const shadow = this.#sun.shadow.camera;
    shadow.left = -this.#radius * 0.7;
    shadow.right = this.#radius * 0.7;
    shadow.top = this.#radius * 0.7;
    shadow.bottom = -this.#radius * 0.7;
    shadow.near = 1;
    shadow.far = this.#radius * 4;
    this.#controls = new MapControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.09;
    this.#controls.minDistance = 100;
    this.#controls.maxDistance = this.#radius * 4;
    this.#controls.maxPolarAngle = Math.PI * 0.465;
    this.#controls.minPolarAngle = 0.02;
    this.#controls.enablePan = true;
    this.#controls.zoomSpeed = 1.05;
    this.#controls.panSpeed = 0.85;
    this.#controls.addEventListener('change', this.#onCameraChange);
    this.#camera.position.set(this.#radius * 0.75, this.#radius * 0.86, this.#radius * 0.88);
    this.#controls.target.set(0, 0, 0);
    this.#controls.update();
    this.#buildTerrain(state.data);
    this.#buildBuildings(state.data);
    this.#buildInfrastructure();
    this.#buildTrees();
    this.#buildProjects();
    this.#buildLabels();
    this.#updateColors();
    this.#flow.setData(state.data, state.activity?.loads ?? { edges: [] }, ACTIVITY_RULES.flowDisplayScale);
    this.#editor.setData(state.data, state.editor, state.design);
    this.#updateMotion();
    this.#updateSelection();
    this.#setLight(INITIAL.hour);
    this.#renderer.domElement.addEventListener('pointerdown', this.#onPointerDown, true);
    this.#renderer.domElement.addEventListener('pointerup', this.#onPointerUp);
    this.#renderer.domElement.addEventListener('pointermove', this.#onPointerMove);
    this.#renderer.domElement.addEventListener('pointercancel', this.#onPointerCancel);
    this.#renderer.domElement.addEventListener('keydown', this.#onKey);
    this.#renderer.domElement.addEventListener('webglcontextlost', this.#onContextLost);
    this.#renderer.domElement.addEventListener('webglcontextrestored', this.#onContextRestored);
    this.#resize = new ResizeObserver(this.#onResize);
    this.#resize.observe(host);
    this.#onResize();
    this.#camera.position.copy(this.#homePosition());
    this.#controls.update();
    this.#renderer.shadowMap.needsUpdate = true;
    this.setSettings(INITIAL);
    document.addEventListener('visibilitychange', this.#onVisibility);
    this.#invalidate();
  }
  #onCameraChange = (): void => {
    this.#invalidate();
    this.#callbacks.onCamera((this.#controls.getAzimuthalAngle() * 180) / Math.PI);
  };
  #invalidate(): void {
    this.#dirty = true;
    if (!this.#disposed && !this.#lost && !document.hidden && !this.#frame)
      this.#frame = requestAnimationFrame(this.#animate);
  }
  #onVisibility = (): void => {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#last = 0;
    if (!document.hidden) this.#invalidate();
  };
  #onResize = (): void => {
    this.#width = Math.max(1, this.#host.clientWidth);
    this.#height = Math.max(1, this.#host.clientHeight);
    this.#renderer.setSize(this.#width, this.#height);
    this.#camera.aspect = this.#width / this.#height;
    this.#camera.updateProjectionMatrix();
    this.#invalidate();
  };
  #material(color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.88, ...extra });
  }
  #boxes(
    items: BoxItem[],
    material: THREE.Material,
    parent: THREE.Group,
    shadows = false,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, Math.max(1, items.length));
    mesh.count = items.length;
    const dummy = new THREE.Object3D();
    items.forEach((item, i) => {
      dummy.position.copy(world(item.point, item.y));
      dummy.rotation.set(0, item.angle ?? 0, 0);
      dummy.scale.set(...item.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (item.color) mesh.setColorAt(i, new THREE.Color(item.color));
    });
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    if (items.length) mesh.computeBoundingSphere();
    parent.add(mesh);
    return mesh;
  }
  #clear(group: THREE.Group): void {
    for (const child of [...group.children]) disposeObject(child);
  }
  #buildTerrain(data: DeepReadonly<DistrictData>): void {
    const [x0, y0, x1, y1] = data.metadata.boundsM,
      w = x1 - x0 + 24,
      h = y1 - y0 + 24,
      c: Point = [(x0 + x1) / 2, (y0 + y1) / 2];
    const slabShape = new THREE.Shape(),
      r = 22,
      l = c[0] - w / 2,
      b = c[1] - h / 2;
    slabShape.moveTo(l + r, b);
    slabShape.lineTo(l + w - r, b);
    slabShape.quadraticCurveTo(l + w, b, l + w, b + r);
    slabShape.lineTo(l + w, b + h - r);
    slabShape.quadraticCurveTo(l + w, b + h, l + w - r, b + h);
    slabShape.lineTo(l + r, b + h);
    slabShape.quadraticCurveTo(l, b + h, l, b + h - r);
    slabShape.lineTo(l, b + r);
    slabShape.quadraticCurveTo(l, b, l + r, b);
    const geometry = new THREE.ExtrudeGeometry(slabShape, {
      depth: 10,
      bevelEnabled: true,
      bevelSize: 2,
      bevelThickness: 2,
      bevelSegments: 2,
      steps: 1,
    });
    geometry.rotateX(-Math.PI / 2);
    const slab = new THREE.Mesh(geometry, this.#material(GIS_THEME.ground));
    slab.position.y = -12.25;
    slab.receiveShadow = true;
    slab.castShadow = true;
    this.#terrain.add(slab);
    const underlay = new THREE.Mesh(
      new THREE.PlaneGeometry(this.#radius * 15, this.#radius * 15),
      this.#material(DAY_BG),
    );
    underlay.rotation.x = -Math.PI / 2;
    underlay.position.copy(world(c, -14));
    underlay.receiveShadow = true;
    this.#terrain.add(underlay);
    const blockMat = this.#material(GIS_THEME.block);
    for (const block of data.blocks) this.#terrain.add(flatPolygon(block.polygon, blockMat, 0.12));
    const roadMat = this.#material(GIS_THEME.road);
    for (const road of data.roads) this.#terrain.add(flatPolygon(road.polygon, roadMat, 0.18));
    const marks: BoxItem[] = [];
    for (const road of data.roads) {
      if (road.centerline) {
        const total = lengthOf(road.centerline);
        for (let d = 8; d < total - 5; d += 18) {
          const p = pointAlong(road.centerline, d),
            a = pointAlong(road.centerline, d - 1),
            b = pointAlong(road.centerline, d + 1);
          if (data.roads.some((other) => other.id !== road.id && pointInside(p, other.polygon))) continue;
          const angle = Math.atan2(b[0] - a[0], -(b[1] - a[1]));
          marks.push({ point: p, y: 0.23, size: [0.35, 0.06, 6], angle });
        }
        continue;
      }
      const vertical = road.axis === 'vertical',
        start = vertical ? y0 : x0,
        end = vertical ? y1 : x1;
      for (let p = start + 8; p < end - 5; p += 18) {
        if (
          data.roads.some(
            (other) => other.axis !== road.axis && Math.abs(p - other.centerM) < other.widthM / 2 + 8,
          )
        )
          continue;
        const lanes = road.lanes > 2 ? [-road.widthM / 4, -0.7, 0.7, road.widthM / 4] : [0];
        for (const offset of lanes)
          marks.push({
            point: vertical ? [road.centerM + offset, p] : [p, road.centerM + offset],
            y: 0.23,
            size: vertical ? [0.42, 0.06, road.lanes > 2 && Math.abs(offset) < 1 ? 14 : 7] : [7, 0.06, 0.42],
          });
      }
    }
    this.#boxes(marks, this.#material(GIS_THEME.marking), this.#terrain);
  }
  #buildBuildings(data: DeepReadonly<DistrictData>): void {
    this.#buildingOrder = data.buildings.map((b) => b.id);
    const body: BoxItem[] = [],
      roofs: BoxItem[] = [],
      windows: BoxItem[] = [],
      vents: BoxItem[] = [],
      doors: BoxItem[] = [],
      canopies: BoxItem[] = [];
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));
    const palette = GIS_THEME.residential;
    const random = deterministicRandom(201);
    for (const building of data.buildings) {
      const box = bounds(building.polygon),
        height = building.heightM;
      const rectangular =
        building.polygon.length === 5 &&
        building.polygon.every(
          (p) => (p[0] === box.minX || p[0] === box.maxX) && (p[1] === box.minY || p[1] === box.maxY),
        );
      const color =
        building.kind === 'residential'
          ? palette[Math.floor(random() * palette.length)]!
          : building.kind === 'school'
            ? GIS_THEME.school
            : building.kind === 'clinic'
              ? GIS_THEME.clinic
              : GIS_THEME.civic;
      body.push({
        point: box.center,
        y: height / 2 + 0.6,
        size: rectangular ? [box.width, height, box.depth] : [0, 0, 0],
        color,
      });
      roofs.push({
        point: box.center,
        y: height + 1,
        size: rectangular ? [box.width + 0.6, 0.9, box.depth + 0.6] : [0, 0, 0],
        color: GIS_THEME.roof,
      });
      if (!rectangular) {
        const geometry = new THREE.ExtrudeGeometry(shape(building.polygon), {
          depth: height,
          bevelEnabled: false,
        });
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, [this.#material(GIS_THEME.roof), this.#material(color)]);
        mesh.position.y = 0.6;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.selectionId = building.id;
        this.#buildings.add(mesh);
        this.#pickables.push(mesh);
        this.#complexBuildings.set(building.id, mesh);
      }
      for (let s = 0; s < building.polygon.length - 1; s++) {
        const a = building.polygon[s]!,
          b = building.polygon[s + 1]!,
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = Math.hypot(dx, dy),
          n = Math.floor(length / 5.2);
        for (let floor = 0; floor < building.floors; floor++)
          for (let slot = 0; slot < n; slot++) {
            const t = (slot + 0.5) / n;
            windows.push({
              point: [a[0] + dx * t + (dy / length) * 0.24, a[1] + dy * t - (dx / length) * 0.24],
              y: 0.6 + ((floor + 0.55) * height) / building.floors,
              size: [2, 1.45, 0.2],
              angle: Math.atan2(dy, dx),
              color: random() > 0.17 ? '#91a9bc' : '#c3d1dc',
            });
          }
      }
      if (rectangular)
        for (const side of [-1, 1])
          vents.push({
            point: [box.center[0] + side * box.width * 0.23, box.center[1]],
            y: height + 1.9,
            size: [3.5, 1.3, 2.7],
          });
      for (const id of building.entranceNodeIds) {
        const p = nodeMap.get(id)!.xy,
          dx = p[0] - box.center[0],
          dy = p[1] - box.center[1],
          angle = Math.atan2(dx, -dy);
        doors.push({ point: p, y: 2, size: [2.3, 3, 0.4], angle });
        canopies.push({
          point: [p[0] + Math.sin(angle), p[1] - Math.cos(angle)],
          y: 3.6,
          size: [4.2, 0.32, 3],
          angle,
        });
      }
    }
    this.#body = this.#boxes(body, this.#material('#ffffff'), this.#buildings, true);
    this.#body.userData.kind = 'buildings';
    this.#pickables.push(this.#body);
    this.#roof = this.#boxes(roofs, this.#material('#ffffff'), this.#buildings, true);
    this.#windows = this.#boxes(windows, this.#windowMaterial, this.#buildings);
    this.#boxes(vents, this.#material('#a5b1ae'), this.#buildings, true);
    this.#boxes(doors, this.#material('#3d6066'), this.#buildings);
    this.#boxes(canopies, this.#material('#718984'), this.#buildings, true);
    this.#buildings.scale.y = this.#settings.heightScale;
  }
  #buildInfrastructure(): void {
    this.#pickables.splice(0, this.#pickables.length, this.#body, ...this.#complexBuildings.values());
    this.#clear(this.#infrastructure);
    this.#clear(this.#network);
    const data = this.#state.data,
      paths: BoxItem[] = [],
      gravel: BoxItem[] = [],
      stripes: BoxItem[] = [],
      benches: BoxItem[] = [],
      railings: BoxItem[] = [];
    const lawn = this.#material(GIS_THEME.lawn),
      reserve = this.#material('#d7ceb9'),
      publicGround = this.#material(GIS_THEME.publicGround);
    const nodes = new Map(data.nodes.map((n) => [n.id, n]));
    for (const parcel of data.parcels) {
      if (parcel.kind === 'public_park' || parcel.kind === 'landscaping')
        this.#infrastructure.add(flatPolygon(parcel.polygon, lawn, 0.27));
      else if (parcel.kind === 'vacant') {
        this.#infrastructure.add(flatPolygon(parcel.polygon, reserve, 0.25));
        this.#infrastructure.add(lineSegments(parcel.polygon, 0.4, '#a68d68', true));
      } else this.#infrastructure.add(flatPolygon(parcel.polygon, publicGround, 0.26));
      if (parcel.kind === 'public_park') {
        const box = bounds(parcel.polygon);
        for (const sign of [-1, 1]) {
          const x = box.center[0] + sign * Math.min(36, box.width * 0.26),
            y = box.center[1] + Math.min(36, box.depth * 0.24);
          benches.push(
            { point: [x, y], y: 1.1, size: [7, 0.7, 1.6] },
            { point: [x, y + 0.65], y: 2, size: [7, 1.3, 0.35] },
          );
        }
      }
      if (parcel.fence) {
        const gates = parcel.fence.gateNodeIds.map((id) => nodes.get(id)!.xy);
        for (let s = 0; s < parcel.polygon.length - 1; s++) {
          const a = parcel.polygon[s]!,
            b = parcel.polygon[s + 1]!,
            length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          for (let d = 0; d < length; d += 5) {
            const p: Point = [a[0] + ((b[0] - a[0]) * d) / length, a[1] + ((b[1] - a[1]) * d) / length];
            if (gates.some((g) => Math.hypot(g[0] - p[0], g[1] - p[1]) < 5)) continue;
            railings.push({ point: p, y: 1.65, size: [0.35, 3, 0.35] });
            const mid: Point = [
              a[0] + ((b[0] - a[0]) * (d + 2.5)) / length,
              a[1] + ((b[1] - a[1]) * (d + 2.5)) / length,
            ];
            if (!gates.some((g) => Math.hypot(g[0] - mid[0], g[1] - mid[1]) < 5))
              railings.push({
                point: mid,
                y: 2.6,
                size: [5, 0.15, 0.18],
                angle: -Math.atan2(b[1] - a[1], b[0] - a[0]),
              });
          }
        }
      }
    }
    const profile = data.profiles.find((p) => p.id === this.#state.profileId)!;
    const networkGood: number[] = [],
      networkBad: number[] = [];
    for (const edge of data.edges) {
      if (!edge.active) continue;
      const blocked = edgeBlockReason(
        { ...edge, geometry: edge.geometry.map((p) => [...p] as [number, number]) },
        profile,
      );
      for (let i = 1; i < edge.geometry.length; i++) {
        const a = edge.geometry[i - 1]!,
          b = edge.geometry[i]!,
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          length = Math.hypot(dx, dy);
        if (edge.kind === 'crossing') {
          for (let d = 4.5; d < length - 4; d += 2)
            stripes.push({
              point: [a[0] + (dx * d) / length, a[1] + (dy * d) / length],
              y: 0.28,
              size: [edge.widthM + 1.2, 0.06, 0.9],
              angle: Math.atan2(dx, -dy),
            });
        } else
          (edge.surface === 'compacted_gravel' ? gravel : paths).push({
            point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
            y: 0.39,
            size: [edge.widthM + (edge.kind === 'sidewalk' ? 1.1 : 0.35), 0.22, length + 0.2],
            angle: Math.atan2(dx, -dy),
          });
        (blocked ? networkBad : networkGood).push(a[0], 1.3, -a[1], b[0], 1.3, -b[1]);
      }
    }
    this.#boxes(paths, this.#material(GIS_THEME.path), this.#infrastructure);
    this.#boxes(gravel, this.#material('#cebd9c'), this.#infrastructure);
    this.#boxes(stripes, this.#material(GIS_THEME.marking), this.#infrastructure);
    this.#boxes(benches, this.#material('#8b7355'), this.#infrastructure, true);
    this.#boxes(railings, this.#material('#76877e'), this.#infrastructure);
    for (const [positions, color] of [
      [networkGood, '#238c9a'],
      [networkBad, '#cb7963'],
    ] as const) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.#network.add(
        new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }),
        ),
      );
    }
    const posts: BoxItem[] = [],
      lamps: BoxItem[] = [];
    for (const node of data.nodes.filter((n) => n.kind === 'sidewalk' && /_(sw|ne)$/.test(n.id))) {
      posts.push({ point: [node.xy[0] + 3, node.xy[1] + 3], y: 4.8, size: [0.45, 9, 0.45] });
      lamps.push({ point: [node.xy[0] + 3, node.xy[1] + 3], y: 9.5, size: [2.1, 0.7, 2.1] });
    }
    this.#boxes(posts, this.#material('#6a7d78'), this.#infrastructure, true);
    this.#boxes(
      lamps,
      this.#material('#f7edcf', { emissive: '#f7da97', emissiveIntensity: 0.4 }),
      this.#infrastructure,
    );
    for (const stop of data.destinations.filter((d) => d.active && d.kind === 'bus_stop')) {
      const p = nodes.get(stop.accessNodeIds[0]!)!.xy,
        bay = data.stopBays.find((b) => b.id === stop.stopBayId)!,
        offset = bay.side === 'west' ? -3 : 3;
      const road = data.roads.find((r) => r.id === bay.roadId);
      let shelterPoint: Point = [p[0] + offset, p[1]],
        backPoint: Point = [p[0] + offset * 1.5, p[1]],
        direction: Point = [0, 1],
        angle = 0;
      if (road?.centerline) {
        const candidates = road.centerline
          .slice(1)
          .map((b, i) => {
            const a = road.centerline![i]!,
              q = projectSegment(p, a, b);
            return { a, b, q, distance: Math.hypot(q[0] - p[0], q[1] - p[1]) };
          })
          .sort((a, b) => a.distance - b.distance);
        const nearest = candidates[0]!;
        const length = Math.hypot(nearest.b[0] - nearest.a[0], nearest.b[1] - nearest.a[1]);
        if (length) {
          direction = [(nearest.b[0] - nearest.a[0]) / length, (nearest.b[1] - nearest.a[1]) / length];
          const normal: Point =
            nearest.distance > 0.01
              ? [(p[0] - nearest.q[0]) / nearest.distance, (p[1] - nearest.q[1]) / nearest.distance]
              : [-direction[1], direction[0]];
          shelterPoint = [p[0] + normal[0] * 3, p[1] + normal[1] * 3];
          backPoint = [p[0] + normal[0] * 4.5, p[1] + normal[1] * 4.5];
          angle = Math.atan2(direction[0], -direction[1]);
        }
      }
      const group = new THREE.Group();
      this.#infrastructure.add(group);
      const roof = this.#boxes(
        [{ point: shelterPoint, y: 5.1, size: [5.4, 0.6, 10], angle }],
        this.#material('#446e72'),
        group,
        true,
      );
      roof.userData.selectionId = stop.id;
      this.#pickables.push(roof);
      this.#boxes(
        [-3.8, 3.8].map((z) => ({
          point: [shelterPoint[0] + direction[0] * z, shelterPoint[1] + direction[1] * z] as Point,
          y: 2.6,
          size: [0.35, 5, 0.35],
        })),
        this.#material('#42616a'),
        group,
        true,
      );
      this.#boxes(
        [{ point: backPoint, y: 2.8, size: [0.12, 4.2, 8], angle }],
        this.#material('#bed5d4', { transparent: true, opacity: 0.55 }),
        group,
      );
    }
    this.#network.visible = this.#settings.layers.network;
  }
  #buildTrees(): void {
    this.#clear(this.#trees);
    const data = this.#state.data,
      random = deterministicRandom(1840),
      positions: { p: Point; height: number; radius: number; lawnRadius: number; color: string }[] = [];
    const lawnSize = createLawnSizer(data);
    const parks = data.parcels.filter((p) => p.kind === 'public_park'),
      vacant = data.parcels.filter((p) => p.kind === 'vacant');
    const edges = data.edges.filter((e) => e.active && e.kind !== 'crossing');
    const buildingsIndex = new SpatialIndex<boolean>(),
      parcelsIndex = new SpatialIndex<(typeof data.parcels)[number]>();
    const pathsIndex = new SpatialIndex<{ a: Point; b: Point; margin: number }>();
    for (const building of data.buildings) {
      const b = bounds(building.polygon);
      buildingsIndex.add({ minX: b.minX - 7, minY: b.minY - 7, maxX: b.maxX + 7, maxY: b.maxY + 7 }, true);
    }
    for (const object of this.#state.design?.objects ?? []) {
      if (!object.active || !object.site) continue;
      const b = bounds(object.site);
      buildingsIndex.add(
        { minX: b.minX - 11, minY: b.minY - 11, maxX: b.maxX + 11, maxY: b.maxY + 11 },
        true,
      );
    }
    for (const parcel of [...parks, ...vacant]) parcelsIndex.add(bounds(parcel.polygon), parcel);
    for (const edge of edges)
      for (let i = 1; i < edge.geometry.length; i++) {
        const a = edge.geometry[i - 1]!,
          b = edge.geometry[i]!,
          margin = edge.widthM / 2 + 5;
        pathsIndex.add(
          {
            minX: Math.min(a[0], b[0]) - margin,
            minY: Math.min(a[1], b[1]) - margin,
            maxX: Math.max(a[0], b[0]) + margin,
            maxY: Math.max(a[1], b[1]) + margin,
          },
          { a, b, margin },
        );
      }
    const area = data.blocks.reduce((sum, block) => {
      const b = bounds(block.polygon);
      return sum + b.width * b.depth;
    }, 0);
    const spacing = Math.max(23, Math.sqrt(area / 30000));
    for (const block of data.blocks) {
      const box = bounds(block.polygon);
      for (let x = box.minX + 12; x < box.maxX - 10; x += spacing)
        for (let y = box.minY + 12; y < box.maxY - 10; y += spacing) {
          const p: Point = [x + (random() - 0.5) * 11, y + (random() - 0.5) * 11];
          const parcels = parcelsIndex.at(p[0], p[1]),
            inPark = parcels.some((a) => a.kind === 'public_park' && pointInside(p, a.polygon));
          if (
            random() > (inPark ? 0.62 : 0.18) ||
            !pointInside(p, block.polygon) ||
            parcels.some((a) => a.kind === 'vacant' && pointInside(p, a.polygon))
          )
            continue;
          if (buildingsIndex.at(p[0], p[1]).length) continue;
          if (pathsIndex.at(p[0], p[1]).some((s) => distanceToSegment(p, s.a, s.b) < s.margin)) continue;
          const lawnRadius = lawnSize(p, block.polygon, 11);
          if (lawnRadius < 1.2) continue;
          positions.push({
            p,
            lawnRadius,
            height: 8 + random() * 6,
            radius: 3.8 + random() * 2.7,
            color: ['#7f9c72', '#698f70', '#92a77a', '#759a85'][Math.floor(random() * 4)]!,
          });
        }
    }
    // One instanced draw for all lawns; the clearance radius keeps grass off paths and buildings.
    const grass = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 24),
      this.#material('#99bd88'),
      Math.max(1, positions.length),
    );
    grass.count = positions.length;
    const lawnTransform = new THREE.Object3D();
    positions.forEach((t, i) => {
      lawnTransform.position.copy(world(t.p, 0.3));
      lawnTransform.rotation.x = -Math.PI / 2;
      lawnTransform.scale.set(t.lawnRadius, t.lawnRadius, 1);
      lawnTransform.updateMatrix();
      grass.setMatrixAt(i, lawnTransform.matrix);
    });
    grass.receiveShadow = true;
    this.#trees.add(grass);
    this.#boxes(
      positions.map((t) => ({ point: t.p, y: t.height * 0.3, size: [0.75, t.height * 0.6, 0.75] })),
      this.#material('#8e8267'),
      this.#trees,
      true,
    );
    const crowns = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      this.#material('#ffffff'),
      Math.max(1, positions.length),
    );
    crowns.count = positions.length;
    const dummy = new THREE.Object3D();
    positions.forEach((t, i) => {
      dummy.position.copy(world(t.p, t.height * 0.69));
      dummy.scale.set(t.radius, t.height * 0.48, t.radius);
      dummy.rotation.y = random() * 6;
      dummy.updateMatrix();
      crowns.setMatrixAt(i, dummy.matrix);
      crowns.setColorAt(i, new THREE.Color(t.color));
    });
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    this.#trees.add(crowns);
    this.#trees.visible = this.#settings.layers.trees;
  }
  #buildProjects(): void {
    this.#clear(this.#projects);
    const data = this.#state.data,
      nodes = new Map(data.nodes.map((n) => [n.id, n]));
    for (const project of data.projects) {
      let point: Point | undefined;
      if (project.parcelId)
        point = bounds(data.parcels.find((p) => p.id === project.parcelId)!.polygon).center;
      else {
        const op = project.operations[0]!;
        if (op.op === 'relocate_destination') point = nodes.get(op.nodeId)!.xy;
        else {
          const edge = data.edges.find((e) => e.id === op.targetId);
          if (edge) {
            const a = edge.geometry[0]!,
              b = edge.geometry.at(-1)!;
            point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          }
        }
      }
      if (!point) continue;
      const applied = this.#state.projectIds.includes(project.id),
        sprite = this.#badge(applied ? '✓' : '+', applied ? '#338f82' : '#d2944d');
      sprite.position.copy(world(point, 19));
      sprite.scale.set(26, 26, 1);
      sprite.userData.selectionId = project.id;
      this.#projects.add(sprite);
      this.#pickables.push(sprite);
    }
    this.#projects.visible = this.#settings.layers.projects;
  }
  #badge(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath();
    ctx.arc(48, 48, 43, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(48, 48, 35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 54px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 48, 49);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  }
  #buildLabels(): void {
    for (const label of this.#labels) label.element.remove();
    this.#labels.length = 0;
    const data = this.#state.data;
    const roadNames = new Set<string>();
    for (const road of data.roads) {
      if (!road.centerline || roadNames.has(road.name) || lengthOf(road.centerline) < 50) continue;
      roadNames.add(road.name);
      const point = pointAlong(road.centerline, lengthOf(road.centerline) / 2),
        element = document.createElement('div');
      element.className = 'place-label street-label';
      element.textContent = road.name;
      this.#labelHost.append(element);
      this.#labels.push({ element, point: world(point, 4), public: true, id: road.id });
    }
    for (const destination of data.destinations.filter((d) => d.active)) {
      const editedObject = this.#state.design?.objects.find((o) => o.id === destination.id);
      const parcel = destination.parcelId ? data.parcels.find((p) => p.id === destination.parcelId) : null;
      const building = destination.buildingId
        ? data.buildings.find((b) => b.id === destination.buildingId)
        : null;
      const node = data.nodes.find((n) => n.id === destination.accessNodeIds[0])!;
      const point = editedObject?.site
        ? bounds(editedObject.site).center
        : building
          ? bounds(building.polygon).center
          : parcel
            ? bounds(parcel.polygon).center
            : node.xy;
      const element = document.createElement('div');
      element.className = `place-label place-label--${destination.kind}`;
      if (editedObject) element.dataset.proposed = 'true';
      const icon = document.createElement('span');
      icon.className = 'place-label-icon';
      icon.textContent = {
        park: '♧',
        school: 'Ш',
        clinic: '+',
        grocery: 'М',
        bus_stop: 'А',
        community: 'Ц',
        parking: 'P',
        playground: 'Д',
        waste_bin: 'У',
      }[destination.kind];
      const title = document.createElement('span');
      title.textContent =
        destination.kind === 'park'
          ? destination.name
          : destination.kind === 'school'
            ? 'Школа'
            : destination.kind === 'clinic'
              ? 'Поликлиника'
              : destination.kind === 'grocery'
                ? 'Магазин'
                : destination.kind === 'community'
                  ? 'Районный центр'
                  : destination.name;
      if (editedObject)
        title.textContent = `${destination.name} · ${destination.id.startsWith('user_') ? 'проект' : 'изменено'}`;
      element.append(icon, title);
      this.#labelHost.append(element);
      this.#labels.push({
        element,
        point: world(
          point,
          editedObject?.site
            ? (PLACEMENT_RULES.buildingHeightsM[destination.kind] ?? 3) + 11
            : building
              ? building.heightM * this.#settings.heightScale + 11
              : destination.kind === 'park'
                ? 13
                : 12,
        ),
        public: true,
        id: destination.id,
      });
    }
  }
  #updateColors(): void {
    const current = new Map(this.#state.report.perBuilding.map((b) => [b.buildingId, b])),
      before = new Map(this.#state.baseline.perBuilding.map((b) => [b.buildingId, b]));
    const threshold = this.#state.report.destinations[this.#state.metricId]!.thresholdSeconds;
    const palette = GIS_THEME.residential,
      random = deterministicRandom(201);
    this.#state.data.buildings.forEach((building, i) => {
      let color: string =
        building.kind === 'residential'
          ? palette[Math.floor(random() * palette.length)]!
          : building.kind === 'school'
            ? GIS_THEME.school
            : building.kind === 'clinic'
              ? GIS_THEME.clinic
              : GIS_THEME.civic;
      const now = current.get(building.id)?.destinations[this.#state.metricId],
        old = before.get(building.id)?.destinations[this.#state.metricId];
      if (now && this.#settings.colorMode === 'accessibility')
        color = accessibilityColor(now.travelSeconds, threshold);
      if (now && old && this.#settings.colorMode === 'change')
        color = differenceColor(old.travelSeconds, now.travelSeconds);
      this.#body.setColorAt(i, new THREE.Color(color));
      // Keep analytical colors legible in plan view; brighten roofs only in the base map.
      const roofColor = new THREE.Color(color).lerp(
        new THREE.Color(GIS_THEME.roof),
        this.#settings.colorMode === 'natural' ? 0.7 : 0.15,
      );
      this.#roof.setColorAt(i, roofColor);
      const complex = this.#complexBuildings.get(building.id);
      if (complex) {
        const [roof, walls] = complex.material as THREE.MeshStandardMaterial[];
        roof!.color.copy(roofColor);
        walls!.color.set(color);
      }
    });
    this.#body.instanceColor!.needsUpdate = true;
    this.#roof.instanceColor!.needsUpdate = true;
    this.#invalidate();
  }
  #updateMotion(reset = true): void {
    if (!this.#settings.layers.residents) return;
    if (!this.#residents) {
      this.#residents = new ResidentLayer();
      this.#district.add(this.#residents.group);
    }
    const profile = this.#state.data.profiles.find((p) => p.id === this.#state.profileId)!;
    const cap = this.#settings.quality === 'eco' ? 250 : this.#settings.quality === 'auto' ? 800 : 1600;
    if (reset)
      this.#motionPaths = this.#state.activity
        ? createActivityMotionPaths(
            this.#state.data,
            { ...profile, surfaceSpeedFactors: { ...profile.surfaceSpeedFactors } },
            this.#state.activity.routes,
          )
        : [];
    const count = this.#state.activity ? Math.ceil(this.#state.activity.expectedOnNetwork) : 0;
    this.#residents.setPaths(this.#motionPaths, Math.min(cap, this.#settings.agentCount, count), reset);
  }
  #updateSelection(): void {
    this.#clear(this.#selection);
    this.#clear(this.#route);
    const selectedEdge = this.#state.data.edges.find((edge) => edge.id === this.#state.selectedId);
    if (selectedEdge) {
      const highlight = lineSegments(selectedEdge.geometry, 1.8, GIS_THEME.selection);
      (highlight.material as THREE.LineBasicMaterial).depthTest = false;
      highlight.renderOrder = 3;
      this.#selection.add(highlight);
    }
    const building = this.#state.data.buildings.find((b) => b.id === this.#state.selectedId);
    if (building) {
      const b = bounds(building.polygon),
        height = building.heightM * this.#settings.heightScale;
      const geometry = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(b.width + 2.2, height + 1.6, b.depth + 2.2),
      );
      const outline = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          color: GIS_THEME.selection,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        }),
      );
      outline.position.copy(world(b.center, height / 2 + 1));
      this.#selection.add(outline);
      const marker = flatPolygon(
        building.polygon,
        new THREE.MeshBasicMaterial({
          color: GIS_THEME.selectionHalo,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
        }),
        0.53,
      );
      marker.scale.set(1, 1, 1);
      this.#selection.add(marker);
    }
    const route = this.#state.selectedRoute;
    if (route?.reachable && route.geometry.length > 1) {
      const positions = route.geometry.map((p) => world(p, 2));
      const curve = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < positions.length; i++)
        curve.add(new THREE.LineCurve3(positions[i - 1]!, positions[i]!));
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(24, route.geometry.length * 4), 1.8, 5, false),
        new THREE.MeshBasicMaterial({ color: GIS_THEME.selection }),
      );
      this.#route.add(tube);
      const end = positions.at(-1)!,
        target = this.#badge('✓', GIS_THEME.selection);
      target.position.copy(end).add(new THREE.Vector3(0, 20, 0));
      target.scale.set(22, 22, 1);
      this.#route.add(target);
    }
    this.#invalidate();
  }
  setState(state: MapState): void {
    const old = this.#state;
    this.#state = state;
    this.#renderer.domElement.style.cursor =
      state.editor?.active && state.editor.tool !== 'select' ? 'crosshair' : 'grab';
    const geometryChanged = old.geometryKey !== state.geometryKey;
    if (geometryChanged || old.profileId !== state.profileId) {
      this.#buildInfrastructure();
      this.#buildProjects();
    }
    if (geometryChanged) {
      this.#clear(this.#focusHighlight);
      this.#buildTrees();
      this.#buildLabels();
      this.#renderer.shadowMap.needsUpdate = true;
    }
    if (old.activity !== state.activity || old.data !== state.data)
      this.#flow.setData(state.data, state.activity?.loads ?? { edges: [] }, ACTIVITY_RULES.flowDisplayScale);
    if (old.editor !== state.editor || old.data !== state.data)
      this.#editor.setData(state.data, state.editor, state.design);
    if (old.activity !== state.activity || old.profileId !== state.profileId) this.#updateMotion();
    if (old.report !== state.report || old.metricId !== state.metricId) this.#updateColors();
    this.#updateSelection();
    this.#invalidate();
  }
  setSettings(settings: ViewSettings): void {
    const old = this.#settings;
    this.#settings = settings;
    this.#buildings.visible = settings.layers.buildings;
    this.#trees.visible = settings.layers.trees;
    this.#network.visible = settings.layers.network;
    this.#projects.visible = settings.layers.projects;
    this.#flow.group.visible = settings.layers.loads;
    if (old.layers.residents !== settings.layers.residents) {
      if (settings.layers.residents) this.#updateMotion();
      else {
        this.#residents?.dispose();
        this.#residents = null;
        this.#motionPaths = [];
      }
    }
    this.#labelHost.hidden = !settings.layers.labels;
    if (old.colorMode !== settings.colorMode) this.#updateColors();
    if (old.agentCount !== settings.agentCount || old.quality !== settings.quality) this.#updateMotion(false);
    if (old.hour !== settings.hour) this.#setLight(settings.hour);
    if (old.heightScale !== settings.heightScale) {
      this.#buildings.scale.y = settings.heightScale;
      this.#buildLabels();
      this.#updateSelection();
      this.#renderer.shadowMap.needsUpdate = true;
    }
    if (old.layers.trees !== settings.layers.trees || old.layers.buildings !== settings.layers.buildings)
      this.#renderer.shadowMap.needsUpdate = true;
    if (old.quality !== settings.quality) {
      this.#renderer.setPixelRatio(
        Math.min(devicePixelRatio, settings.quality === 'high' ? 2 : settings.quality === 'eco' ? 1 : 1.7),
      );
      this.#renderer.shadowMap.enabled = settings.quality !== 'eco';
      this.#onResize();
      this.#renderer.shadowMap.needsUpdate = true;
    }
    if (old.planView !== settings.planView) this.setPlanView(settings.planView);
    this.#invalidate();
  }
  #setLight(hour: number): void {
    const angle = ((hour - 6) / 14) * Math.PI,
      strength = Math.max(0.12, Math.sin(angle));
    this.#sun.position.set(-this.#radius * 0.65, this.#radius * (0.35 + strength), this.#radius * 0.7);
    this.#sun.intensity = 0.65 + strength * 2.2;
    this.#sun.color.set(hour >= 18 ? '#ffd2a4' : '#fffaf2');
    this.#ambient.intensity = 0.7 + strength * 1.2;
    const bg = new THREE.Color(hour >= 19 ? '#c7cfd2' : DAY_BG);
    this.#scene.background = bg;
    (this.#scene.fog as THREE.Fog).color.copy(bg);
    this.#windowMaterial.emissive.set(hour >= 18 ? '#d8ac6f' : '#000000');
    this.#windowMaterial.emissiveIntensity = hour >= 18 ? 0.85 : 0;
    this.#renderer.shadowMap.needsUpdate = true;
    this.#invalidate();
  }
  #fly(to: THREE.Vector3, target: THREE.Vector3): void {
    this.#cameraTransition = {
      from: this.#camera.position.clone(),
      to,
      targetFrom: this.#controls.target.clone(),
      targetTo: target,
      start: performance.now(),
    };
    this.#invalidate();
  }
  #homePosition(): THREE.Vector3 {
    if (this.#settings.planView)
      return new THREE.Vector3(0, this.#radius * Math.max(1.9, 1.9 / this.#camera.aspect), 1);
    return new THREE.Vector3(0.75, 0.86, 0.88).multiplyScalar(
      this.#radius * Math.min(2.6, 1.2 * Math.max(1, 1.25 / this.#camera.aspect)),
    );
  }
  home(): void {
    this.#clear(this.#focusHighlight);
    this.#fly(this.#homePosition(), new THREE.Vector3());
  }
  zoom(factor: number): void {
    const relative = this.#camera.position.clone().sub(this.#controls.target);
    const length = THREE.MathUtils.clamp(
      relative.length() * factor,
      this.#controls.minDistance,
      this.#controls.maxDistance,
    );
    relative.setLength(length);
    this.#fly(this.#controls.target.clone().add(relative), this.#controls.target.clone());
  }
  setPlanView(plan: boolean): void {
    if (plan)
      this.#fly(
        this.#controls.target
          .clone()
          .add(
            new THREE.Vector3(
              0,
              Math.min(this.#radius * 1.55, this.#camera.position.distanceTo(this.#controls.target)),
              1,
            ),
          ),
        this.#controls.target.clone(),
      );
    else this.home();
  }
  focus(id: string): void {
    const projects = projectLocations(this.#state.data, [id]);
    if (projects.length) {
      this.focusLocations(projects);
      return;
    }
    const data = this.#state.data,
      building = data.buildings.find((b) => b.id === id),
      destination = data.destinations.find((d) => d.id === id);
    const edge = data.edges.find((edge) => edge.id === id);
    const point = building
      ? bounds(building.polygon).center
      : destination
        ? (data.nodes.find((n) => n.id === destination.accessNodeIds[0])?.xy ??
          (data.parcels.find((p) => p.id === destination.parcelId)
            ? bounds(data.parcels.find((p) => p.id === destination.parcelId)!.polygon).center
            : null))
        : edge
          ? bounds(edge.geometry).center
          : null;
    if (!point) return;
    this.focusLocations([[...point] as XY]);
  }
  focusProjects(ids: readonly string[]): void {
    this.focusLocations(projectLocations(this.#state.data, ids));
  }
  focusLocations(points: readonly XY[]): void {
    if (!points.length) return;
    this.#clear(this.#focusHighlight);
    const b = bounds(points),
      target = world(b.center).add(this.#district.position);
    const distance = Math.max(260, Math.hypot(b.width, b.depth) * 1.45);
    const offset = this.#camera.position
      .clone()
      .sub(this.#controls.target)
      .setLength(Math.min(this.#controls.maxDistance, distance));
    for (const point of points) {
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(9, 13, 40),
        new THREE.MeshBasicMaterial({
          color: GIS_THEME.selection,
          transparent: true,
          opacity: 0.85,
          depthTest: false,
          side: THREE.DoubleSide,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.copy(world(point, 2));
      halo.renderOrder = 5;
      this.#focusHighlight.add(halo);
    }
    this.#fly(target.clone().add(offset), target);
  }
  async screenshot(): Promise<Blob> {
    this.#renderer.render(this.#scene, this.#camera);
    return new Promise((resolve, reject) =>
      this.#renderer.domElement.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сохранить изображение'))),
        'image/png',
      ),
    );
  }
  #visible(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (!current.visible) return false;
      current = current.parent;
    }
    return true;
  }
  #pick(event: PointerEvent): string | null {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hits = this.#raycaster.intersectObjects(
      [
        ...this.#pickables.filter((p) => this.#visible(p)),
        ...(this.#flow.mesh && this.#flow.group.visible ? [this.#flow.mesh] : []),
        ...this.#editor.pickables,
      ],
      false,
    );
    const first = hits[0];
    if (!first) return null;
    const handle = this.#editor.handle(first);
    if (handle) return handle.id;
    if (first.object === this.#flow.mesh) return this.#flow.edgeId(first.instanceId!);
    return first.object === this.#body
      ? (this.#buildingOrder[first.instanceId!] ?? null)
      : ((first.object.userData.selectionId as string | undefined) ?? null);
  }
  #onPointerDown = (event: PointerEvent): void => {
    this.#down = { x: event.clientX, y: event.clientY };
    this.#cameraTransition = null;
    const editor = this.#state.editor;
    if (event.button === 0 && editor?.active) {
      const point = this.#groundPoint(event);
      if (editor.tool !== 'select') {
        this.#controls.enabled = false;
        return;
      }
      const hits = this.#raycaster.intersectObjects(this.#editor.pickables, false),
        handle = hits[0] ? this.#editor.handle(hits[0]) : null;
      if (handle && handle.id === editor.selectedId && point) {
        this.#dragging = handle;
        this.#controls.enabled = false;
        this.#renderer.domElement.setPointerCapture(event.pointerId);
        this.#callbacks.editor?.drag({ ...handle, point, phase: 'start' });
        event.stopImmediatePropagation();
      }
    }
  };
  #onPointerUp = (event: PointerEvent): void => {
    if (this.#dragging) {
      const point = this.#groundPoint(event),
        handle = this.#dragging;
      this.#dragging = null;
      this.#controls.enabled = true;
      if (point) this.#callbacks.editor?.drag({ ...handle, point, phase: 'end' });
      return;
    }
    this.#controls.enabled = true;
    if (
      event.button === 0 &&
      this.#state.editor?.active &&
      this.#state.editor.tool !== 'select' &&
      Math.hypot(event.clientX - this.#down.x, event.clientY - this.#down.y) < 5
    ) {
      const point = this.#groundPoint(event);
      if (point) this.#callbacks.editor?.point(point);
      return;
    }
    if (event.button === 0 && Math.hypot(event.clientX - this.#down.x, event.clientY - this.#down.y) < 5)
      this.#callbacks.onSelect(this.#pick(event));
  };
  #onPointerMove = (event: PointerEvent): void => {
    if (this.#dragging) {
      const point = this.#groundPoint(event);
      if (point) this.#callbacks.editor?.drag({ ...this.#dragging, point, phase: 'move' });
      return;
    }
    if (event.buttons === 0)
      this.#renderer.domElement.style.cursor =
        this.#state.editor?.active && this.#state.editor.tool !== 'select'
          ? 'crosshair'
          : this.#pick(event)
            ? 'pointer'
            : 'grab';
  };
  #groundPoint(event: PointerEvent): XY | null {
    const rect = this.#renderer.domElement.getBoundingClientRect();
    this.#pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const hit = this.#raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      new THREE.Vector3(),
    );
    if (!hit) return null;
    hit.sub(this.#district.position);
    return [hit.x, -hit.z];
  }
  #onPointerCancel = (): void => {
    if (this.#dragging) this.#callbacks.editor?.drag({ ...this.#dragging, point: [0, 0], phase: 'cancel' });
    this.#dragging = null;
    this.#controls.enabled = true;
  };
  #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.#onPointerCancel();
      this.#callbacks.editor?.cancel();
      this.#callbacks.onSelect(null);
    } else if (
      this.#state.editor?.active &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) &&
      this.#state.editor.draft
    ) {
      event.preventDefault();
      const object = this.#state.editor.draft,
        p = object.polygon ? bounds(object.polygon).center : object.entrances[0];
      if (p) {
        const point: XY = [
            p[0] + (event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0),
            p[1] + (event.key === 'ArrowUp' ? 5 : event.key === 'ArrowDown' ? -5 : 0),
          ],
          handle = { id: object.id, part: 'object' as const, index: 0 };
        this.#callbacks.editor?.drag({ ...handle, point: [...p] as XY, phase: 'start' });
        this.#callbacks.editor?.drag({ ...handle, point, phase: 'end' });
      }
    } else if (event.key === 'Home') this.home();
    else if (event.key === '+' || event.key === '=') this.zoom(0.8);
    else if (event.key === '-') this.zoom(1.25);
  };
  #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.#lost = true;
    this.#callbacks.onError('Графический контекст потерян. Ожидаем восстановления…');
  };
  #onContextRestored = (): void => {
    this.#lost = false;
    this.#invalidate();
    this.#renderer.shadowMap.needsUpdate = true;
    this.#callbacks.onError(null);
  };
  #positionLabels(): void {
    const distance = this.#camera.position.distanceTo(this.#controls.target);
    for (const label of this.#labels) {
      const p = label.point.clone().add(this.#district.position).project(this.#camera),
        hidden =
          p.z > 1 ||
          p.z < -1 ||
          Math.abs(p.x) > 0.98 ||
          Math.abs(p.y) > 0.96 ||
          (label.element.classList.contains('place-label--bus_stop') && distance > this.#radius * 0.95);
      label.element.hidden = hidden;
      if (!hidden)
        label.element.style.transform = `translate(${(p.x * 0.5 + 0.5) * this.#width}px,${(-p.y * 0.5 + 0.5) * this.#height}px) translate(-50%,-100%)`;
    }
  }
  #animate = (time: number): void => {
    if (this.#disposed) return;
    this.#frame = 0;
    const delta = this.#last ? Math.min(0.1, (time - this.#last) / 1000) : 0;
    this.#last = time;
    if (document.hidden || this.#lost) return;
    if (this.#cameraTransition) {
      const motion = this.#cameraTransition,
        t = Math.min(1, (time - motion.start) / 650),
        eased = t * t * (3 - 2 * t);
      this.#camera.position.lerpVectors(motion.from, motion.to, eased);
      this.#controls.target.lerpVectors(motion.targetFrom, motion.targetTo, eased);
      this.#invalidate();
      if (t === 1) this.#cameraTransition = null;
    }
    const cameraMoving = this.#controls.update();
    const animate = !this.#settings.paused && this.#settings.layers.residents;
    if (animate) {
      this.#residents?.update(delta, false, this.#settings.speed);
      this.#dirty = true;
    }
    if (animate || this.#cameraTransition || cameraMoving) {
      if (!this.#frame) this.#frame = requestAnimationFrame(this.#animate);
    }
    if (this.#settings.quality === 'eco' && time - this.#lastRender < 1000 / 30 && this.#frame) return;
    if (this.#dirty) {
      this.#renderer.render(this.#scene, this.#camera);
      this.#positionLabels();
      this.#frames++;
      this.#lastRender = time;
      this.#dirty = false;
      this.#host.dataset['sceneReady'] = 'true';
      this.#host.dataset['renderCount'] = String(Number(this.#host.dataset['renderCount'] ?? 0) + 1);
      this.#host.dataset['drawCalls'] = String(this.#renderer.info.render.calls);
      this.#host.dataset['triangles'] = String(this.#renderer.info.render.triangles);
    }
    this.#host.dataset['renderMode'] = animate ? 'animated' : this.#frame ? 'camera' : 'idle';
    if (time - this.#lastStats > 1000 || !this.#frame) {
      this.#callbacks.onStats({
        fps: Math.round((this.#frames * 1000) / (time - this.#lastStats)),
        drawCalls: this.#renderer.info.render.calls,
        triangles: this.#renderer.info.render.triangles,
        agents: this.#residents?.count ?? 0,
        movingAgents: this.#residents?.moving ?? 0,
        ...this.#mapScale(),
      });
      this.#frames = 0;
      this.#lastStats = time;
    }
  };
  #mapScale(): { scaleMeters: number; scalePixels: number } {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
      a = new THREE.Vector3(),
      b = new THREE.Vector3();
    this.#raycaster.setFromCamera(new THREE.Vector2(0.5, -0.85), this.#camera);
    if (!this.#raycaster.ray.intersectPlane(plane, a)) return { scaleMeters: 0, scalePixels: 0 };
    this.#raycaster.setFromCamera(new THREE.Vector2(0.5 + 160 / this.#width, -0.85), this.#camera);
    if (!this.#raycaster.ray.intersectPlane(plane, b)) return { scaleMeters: 0, scalePixels: 0 };
    const meters = a.distanceTo(b),
      power = 10 ** Math.floor(Math.log10(meters));
    const value =
      [1, 2, 5, 10]
        .map((n) => n * power)
        .filter((n) => n <= meters)
        .at(-1) ?? power;
    return { scaleMeters: value, scalePixels: (80 * value) / meters };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#frame);
    this.#resize.disconnect();
    this.#controls.dispose();
    const canvas = this.#renderer.domElement;
    canvas.removeEventListener('pointerdown', this.#onPointerDown, true);
    canvas.removeEventListener('pointerup', this.#onPointerUp);
    canvas.removeEventListener('pointermove', this.#onPointerMove);
    canvas.removeEventListener('pointercancel', this.#onPointerCancel);
    canvas.removeEventListener('keydown', this.#onKey);
    canvas.removeEventListener('webglcontextlost', this.#onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#residents?.dispose();
    this.#flow.dispose();
    this.#editor.dispose();
    document.removeEventListener('visibilitychange', this.#onVisibility);
    disposeObject(this.#scene);
    this.#sun.shadow.map?.dispose();
    this.#renderer.dispose();
    canvas.remove();
    this.#labelHost.remove();
  }
}
