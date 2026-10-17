import * as THREE from 'three';
import type { DeepReadonly, DistrictData, EdgeLoadReport } from '../core/types.js';
import { flowStyle } from './flow-style.js';
import { disposeObject, world } from './geometry.js';

/** One draw call for all eligible edge segments. The glow is procedural, without postprocessing. */
export class FlowLayer {
  readonly group = new THREE.Group();
  mesh: THREE.InstancedMesh | null = null;
  #edgeIds: string[] = [];
  setData(data: DeepReadonly<DistrictData>, report: Pick<EdgeLoadReport, 'edges'>, scale?: number): void {
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
