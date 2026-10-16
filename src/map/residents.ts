import * as THREE from 'three';
import type { MotionPath, MotionSample } from './motion.js';
import { deterministicRandom, pickWeightedPath, sampleMotion } from './motion.js';
import { disposeObject } from './geometry.js';

const MAX_AGENTS = 1600;
interface Agent {
  path: number;
  offset: number;
  size: number;
  gait: number;
}
/** Seven instanced meshes regardless of population size. No per-frame object creation. */
export class ResidentLayer {
  readonly group = new THREE.Group();
  #paths: MotionPath[] = [];
  #agents: Agent[] = [];
  #time = 0;
  #body: THREE.InstancedMesh;
  #head: THREE.InstancedMesh;
  #leftLeg: THREE.InstancedMesh;
  #rightLeg: THREE.InstancedMesh;
  #leftArm: THREE.InstancedMesh;
  #rightArm: THREE.InstancedMesh;
  #shadow: THREE.InstancedMesh;
  #dummy = new THREE.Object3D();
  #root = new THREE.Matrix4();
  #local = new THREE.Matrix4();
  #position = new THREE.Vector3();
  #quaternion = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #rotation = new THREE.Euler();
  #sample: MotionSample = { x: 0, y: 0, heading: 0, walking: false, visible: 0, phase: 0 };
  moving = 0;
  constructor() {
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85 });
    const limbMaterial = new THREE.MeshStandardMaterial({ color: '#34475a', roughness: 0.9 });
    const skinMaterial = new THREE.MeshStandardMaterial({ color: '#e9b99a', roughness: 1 });
    const create = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geometry, material, MAX_AGENTS);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return mesh;
    };
    this.#body = create(new THREE.CapsuleGeometry(0.23, 0.48, 3, 5), bodyMaterial);
    this.#head = create(new THREE.SphereGeometry(0.19, 6, 4), skinMaterial);
    const legs = new THREE.CylinderGeometry(0.085, 0.07, 0.72, 4);
    this.#leftLeg = create(legs, limbMaterial);
    this.#rightLeg = create(legs, limbMaterial);
    const arms = new THREE.CylinderGeometry(0.065, 0.055, 0.57, 4);
    this.#leftArm = create(arms, bodyMaterial);
    this.#rightArm = create(arms, bodyMaterial);
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: '#4a514c',
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    const shadowGeometry = new THREE.CircleGeometry(0.42, 8);
    shadowGeometry.rotateX(-Math.PI / 2);
    this.#shadow = create(shadowGeometry, shadowMaterial);
    const random = deterministicRandom(4040),
      palette = ['#157d88', '#e59750', '#496998', '#ecba61', '#9b706c', '#555d72', '#7c9263'];
    for (let i = 0; i < MAX_AGENTS; i++) {
      const color = new THREE.Color(palette[Math.floor(random() * palette.length)]!);
      this.#body.setColorAt(i, color);
      this.#leftArm.setColorAt(i, color);
      this.#rightArm.setColorAt(i, color);
      this.#head.setColorAt(
        i,
        new THREE.Color().setHSL(0.055 + random() * 0.035, 0.3 + random() * 0.15, 0.45 + random() * 0.32),
      );
    }
  }
  setPaths(paths: MotionPath[], count: number, resetClock = true): void {
    this.#paths = paths;
    this.#agents = [];
    if (resetClock) this.#time = 0;
    const random = deterministicRandom(2040);
    const n = paths.length ? Math.min(MAX_AGENTS, Math.max(0, Math.floor(count))) : 0;
    for (let i = 0; i < n; i++) {
      const path = pickWeightedPath(paths, random());
      this.#agents.push({
        path,
        offset: random() * paths[path]!.cycleSeconds,
        size: 3.8 + random() * 0.9,
        gait: random() * Math.PI * 2,
      });
    }
    for (const mesh of [
      this.#body,
      this.#head,
      this.#leftLeg,
      this.#rightLeg,
      this.#leftArm,
      this.#rightArm,
      this.#shadow,
    ])
      mesh.count = n;
    this.update(0, false, 1);
  }
  get count(): number {
    return this.#agents.length;
  }
  #part(mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number, angle = 0): void {
    this.#position.set(x, y, z);
    this.#rotation.set(angle, 0, 0);
    this.#quaternion.setFromEuler(this.#rotation);
    this.#scale.set(1, 1, 1);
    this.#local.compose(this.#position, this.#quaternion, this.#scale);
    this.#local.premultiply(this.#root);
    mesh.setMatrixAt(i, this.#local);
  }
  update(delta: number, paused: boolean, speed: number): void {
    if (!paused) this.#time += delta * speed;
    let moving = 0;
    for (let i = 0; i < this.#agents.length; i++) {
      const agent = this.#agents[i]!,
        sample = sampleMotion(this.#paths[agent.path]!, this.#time + agent.offset, this.#sample);
      const size = agent.size * sample.visible;
      if (sample.walking && sample.visible > 0) moving++;
      const stride = sample.walking ? Math.sin(sample.phase * 6.2 + agent.gait) * 0.48 : 0;
      const bob = sample.walking ? Math.abs(Math.sin(sample.phase * 6.2 + agent.gait)) * 0.04 : 0;
      this.#dummy.position.set(sample.x, 0.6 + bob * size, -sample.y);
      this.#dummy.rotation.set(0, sample.heading, 0);
      this.#dummy.scale.setScalar(Math.max(0.00001, size));
      this.#dummy.updateMatrix();
      this.#root.copy(this.#dummy.matrix);
      this.#part(this.#body, i, 0, 1.05, 0);
      this.#part(this.#head, i, 0, 1.67, 0);
      this.#part(this.#leftLeg, i, -0.13, 0.4, Math.sin(stride) * 0.16, stride);
      this.#part(this.#rightLeg, i, 0.13, 0.4, -Math.sin(stride) * 0.16, -stride);
      this.#part(this.#leftArm, i, -0.32, 1.02, -Math.sin(stride) * 0.12, -stride);
      this.#part(this.#rightArm, i, 0.32, 1.02, Math.sin(stride) * 0.12, stride);
      this.#part(this.#shadow, i, 0, -0.02, 0);
    }
    this.moving = moving;
    for (const mesh of [
      this.#body,
      this.#head,
      this.#leftLeg,
      this.#rightLeg,
      this.#leftArm,
      this.#rightArm,
      this.#shadow,
    ])
      mesh.instanceMatrix.needsUpdate = true;
  }
  dispose(): void {
    disposeObject(this.group);
  }
}
