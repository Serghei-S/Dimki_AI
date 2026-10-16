import * as THREE from 'three';
export type Point = readonly [number, number];
/** Geometry stays in district-local metres. One parent transform centers any district. */
export function world(point: Point, height = 0): THREE.Vector3 {
  return new THREE.Vector3(point[0], height, -point[1]);
}
export function bounds(ring: readonly Point[]) {
  const xs = ring.map((p) => p[0]),
    ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    depth: maxY - minY,
    center: [(minX + maxX) / 2, (minY + maxY) / 2] as [number, number],
  };
}
export function shape(ring: readonly Point[]): THREE.Shape {
  return new THREE.Shape(ring.slice(0, -1).map((p) => new THREE.Vector2(p[0], p[1])));
}
export function flatPolygon(ring: readonly Point[], material: THREE.Material, elevation: number): THREE.Mesh {
  const geometry = new THREE.ShapeGeometry(shape(ring));
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = elevation;
  mesh.receiveShadow = true;
  return mesh;
}
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function pointInside(p: Point, ring: readonly Point[]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0])
      result = !result;
  }
  return result;
}
export function lineSegments(
  points: readonly Point[],
  height: number,
  color: THREE.ColorRepresentation,
  dash = false,
) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => world(p, height)));
  const material = dash
    ? new THREE.LineDashedMaterial({ color, dashSize: 7, gapSize: 5, transparent: true, opacity: 0.9 })
    : new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(geometry, material);
  if (dash) line.computeLineDistances();
  return line;
}
export function addRibbon(
  group: THREE.Group,
  a: Point,
  b: Point,
  width: number,
  height: number,
  material: THREE.Material,
): THREE.Mesh {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.22, length + 0.1), material);
  mesh.position.copy(world([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], height));
  mesh.rotation.y = Math.atan2(b[0] - a[0], -(b[1] - a[1]));
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
  });
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.removeFromParent();
}
