export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** Static uniform grid. Used only during scene generation, never in the animation loop. */
export class SpatialIndex<T> {
  readonly #cells = new Map<string, { box: Extent; value: T }[]>();
  constructor(readonly cellSize = 64) {}
  add(box: Extent, value: T): void {
    const entry = { box, value };
    for (let x = Math.floor(box.minX / this.cellSize); x <= Math.floor(box.maxX / this.cellSize); x++)
      for (let y = Math.floor(box.minY / this.cellSize); y <= Math.floor(box.maxY / this.cellSize); y++) {
        const key = `${x},${y}`,
          cell = this.#cells.get(key);
        if (cell) cell.push(entry);
        else this.#cells.set(key, [entry]);
      }
  }
  at(x: number, y: number): T[] {
    return (this.#cells.get(`${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`) ?? [])
      .filter(({ box: b }) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY)
      .map((entry) => entry.value);
  }
}
