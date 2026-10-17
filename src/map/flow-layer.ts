import * as THREE from 'three';
import type { ActivityComparison, DeepReadonly, DistrictData, EdgeLoadReport } from '../core/types.js';
import { flowStyle } from './flow-style.js';
import { disposeObject, world } from './geometry.js';

/** One draw call for all eligible edge segments. The glow is procedural, without postprocessing. */
export class FlowLayer {
  readonly group = new THREE.Group();
  mesh: THREE.InstancedMesh | null = null;
  #edgeIds: string[] = [];
  setData(
    data: DeepReadonly<DistrictData>,
    report: Pick<EdgeLoadReport, 'edges'>,
    scale?: number,
    before?: Pick<EdgeLoadReport, 'edges'> | null,
    comparison?: ActivityComparison | null,
  ): void {
    for (const child of [...this.group.children]) disposeObject(child);
    const byId = new Map(report.edges.map((edge) => [edge.edgeId, edge]));
    const segments = data.edges.flatMap((edge) =>
      byId.get(edge.id)?.eligible && byId.get(edge.id)!.load > 1e-8
        ? edge.geometry
            .slice(1)
            .map((b, i) => ({ edge, a: edge.geometry[i]!, b, load: byId.get(edge.id)!.load }))
        : [],
    );
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const intensity = new Float32Array(Math.max(1, segments.length));
    geometry.setAttribute('loadIntensity', new THREE.InstancedBufferAttribute(intensity, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      vertexShader: `
        attribute float loadIntensity;
        varying vec2 vUv; varying vec3 vLoadColor; varying float vIntensity;
        void main() {
          vUv=uv; vLoadColor=instanceColor; vIntensity=loadIntensity;
          gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv; varying vec3 vLoadColor; varying float vIntensity;
        void main() {
          float d=abs(vUv.x-.5)*2.0;
          float halo=exp(-d*d*6.0);
          float core=exp(-d*d*65.0);
          float ends=smoothstep(0.0,.025,vUv.y)*smoothstep(0.0,.025,1.0-vUv.y);
          float alpha=(halo*.4+core*.6)*(.2+.8*vIntensity)*ends;
          gl_FragColor=vec4(mix(vLoadColor,vec3(1.0),core*.18*vIntensity),alpha);
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, segments.length));
    mesh.count = segments.length;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(Math.max(1, segments.length) * 3).fill(1),
      3,
    );
    const dummy = new THREE.Object3D(),
      color = new THREE.Color();
    this.#edgeIds = [];
    segments.forEach(({ edge, a, b, load }, i) => {
      const style = flowStyle(load, scale),
        dx = b[0] - a[0],
        dy = b[1] - a[1];
      dummy.position.copy(world([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1.05));
      dummy.rotation.set(0, Math.atan2(dx, -dy), 0);
      dummy.scale.set(style.widthM * 2.8, 1, Math.hypot(dx, dy) + 0.1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(style.color));
      intensity[i] = load ? 0.65 + 0.35 * style.ratio : 0;
      this.#edgeIds.push(edge.id);
    });
    mesh.renderOrder = 2;
    mesh.computeBoundingSphere();
    this.mesh = mesh;
    this.group.add(mesh);
    this.#addDirectionalArrows(data, report);
    if (before) this.#addBeforeFlow(data, before, scale);
    if (comparison) this.#addDelta(data, comparison);
  }
  #addBeforeFlow(
    data: DeepReadonly<DistrictData>,
    report: Pick<EdgeLoadReport, 'edges'>,
    scale?: number,
  ): void {
    const byId = new Map(report.edges.map((edge) => [edge.edgeId, edge]));
    const material = new THREE.MeshBasicMaterial({ color: '#8093a5', transparent: true, opacity: 0.28, depthWrite: false });
    for (const edge of data.edges) {
      const load = byId.get(edge.id)?.load ?? 0;
      if (load <= 1e-8) continue;
      for (let i = 1; i < edge.geometry.length; i++) {
        const a = edge.geometry[i - 1]!, b = edge.geometry[i]!;
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material.clone());
        const dx = b[0] - a[0], dy = b[1] - a[1];
        mesh.position.copy(world([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 1.01));
        mesh.rotation.set(0, Math.atan2(dx, -dy), 0);
        mesh.scale.set(flowStyle(load, scale).widthM * 2.1, 1, Math.hypot(dx, dy));
        this.group.add(mesh);
      }
    }
  }
  #addDirectionalArrows(data: DeepReadonly<DistrictData>, report: Pick<EdgeLoadReport, 'edges'>): void {
    const byId = new Map(report.edges.map((edge) => [edge.edgeId, edge]));
    const arrows = new THREE.Group();
    for (const edge of data.edges) {
      const load = byId.get(edge.id);
      if (!load || load.load <= 1e-8 || edge.geometry.length < 2) continue;
      const a = world(edge.geometry[0]!, 1.16), b = world(edge.geometry.at(-1)!, 1.16);
      const vector = new THREE.Vector3().subVectors(b, a);
      const length = vector.length();
      if (length < 1) continue;
      vector.normalize();
      const forward = load.forward >= load.backward;
      if (!forward) vector.multiplyScalar(-1);
      const middle = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      arrows.add(new THREE.ArrowHelper(vector, middle, Math.min(16, Math.max(5, length * 0.28)), forward ? '#2b7cff' : '#f08b3e', 4, 2.5));
    }
    arrows.renderOrder = 4;
    this.group.add(arrows);
  }
  #addDelta(data: DeepReadonly<DistrictData>, comparison: ActivityComparison): void {
    const positions: number[] = [], colors: number[] = [];
    const edgeById = new Map(data.edges.map((edge) => [edge.id, edge]));
    for (const change of comparison.edges) {
      if (Math.abs(change.delta) <= 1e-8) continue;
      const edge = edgeById.get(change.edgeId);
      if (!edge) continue;
      const color = new THREE.Color(change.delta < 0 ? '#28a56b' : '#d94f4f');
      for (let i = 1; i < edge.geometry.length; i++) {
        const a = world(edge.geometry[i - 1]!, 1.2), b = world(edge.geometry[i]!, 1.2);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    lines.renderOrder = 5;
    this.group.add(lines);
  }
  edgeId(instance: number): string | null {
    return this.#edgeIds[instance] ?? null;
  }
  dispose(): void {
    disposeObject(this.group);
    this.mesh = null;
    this.#edgeIds = [];
  }
}
