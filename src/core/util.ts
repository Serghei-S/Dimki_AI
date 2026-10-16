export const ROUTING_EPSILON = 1e-9;
export const round = (value: number, digits = 3): number => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
export const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => compareId(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableKey(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function toWgs84(point: [number, number], origin: [number, number], radius: number): [number, number] {
  return [round(origin[0] + point[0] / (radius * Math.cos(origin[1] * Math.PI / 180)) * 180 / Math.PI, 8),
    round(origin[1] + point[1] / radius * 180 / Math.PI, 8)];
}
export class BoundedCache<T> {
  #entries = new Map<string, {value: T; bytes: number}>();
  #bytes = 0;
  hits = 0;
  misses = 0;
  constructor(readonly maxEntries: number, readonly maxBytes: number) {}
  get(key: string): T | undefined {
    const found = this.#entries.get(key);
    if (!found) { this.misses++; return undefined; }
    this.hits++;
    this.#entries.delete(key); this.#entries.set(key, found);
    return found.value;
  }
  set(key: string, value: T, bytes: number): void {
    if (this.maxEntries === 0 || bytes > this.maxBytes) return;
    const old = this.#entries.get(key);
    if (old) { this.#bytes -= old.bytes; this.#entries.delete(key); }
    this.#entries.set(key, {value, bytes}); this.#bytes += bytes;
    while (this.#entries.size > this.maxEntries || this.#bytes > this.maxBytes) {
      const first = this.#entries.keys().next().value!;
      this.#bytes -= this.#entries.get(first)!.bytes; this.#entries.delete(first);
    }
  }
  clear(): void { this.#entries.clear(); this.#bytes = 0; }
  stats() { return {hits: this.hits, misses: this.misses, entries: this.#entries.size, estimatedBytes: this.#bytes}; }
}
