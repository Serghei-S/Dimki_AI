/** Disconnected copies are a CPU/memory load fixture, NOT a new realistic city dataset. */
export function scaleDataset(base, copies) {
  const keys = ['roads', 'blocks', 'parcels', 'buildings', 'nodes', 'edges', 'destinations', 'stopBays', 'transitServices', 'projects'];
  const ids = new Set(keys.flatMap(key => base[key].map(x => x.id))), result = structuredClone(base);
  for (const key of keys) result[key] = [];
  const columns = Math.ceil(Math.sqrt(copies));
  for (let tile = 0; tile < copies; tile++) {
    const dx = (tile % columns) * 1500, dy = Math.floor(tile / columns) * 1200;
    const map = value => {
      if (typeof value === 'string') return ids.has(value) ? `tile${tile}_${value}` : value;
      if (Array.isArray(value)) return value.map(map);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(child)]));
      return value;
    };
    for (const key of keys) for (const original of base[key]) {
      const item = map(original), shift = p => [p[0] + dx, p[1] + dy];
      if (item.xy) item.xy = shift(item.xy);
      if (item.polygon) item.polygon = item.polygon.map(shift);
      if (item.geometry) item.geometry = item.geometry.map(shift);
      if (key === 'roads') item.centerM += item.axis === 'vertical' ? dx : dy;
      result[key].push(item);
    }
  }
  result.metadata.id = `scalability-fixture-${copies}`;
  result.metadata.description = 'Disconnected benchmark copies only; not a planning dataset.';
  result.metadata.boundsM = [-28, -28, columns * 1500, Math.ceil(copies / columns) * 1200];
  result.scenarios = [{id: 'baseline', name: 'Baseline', description: 'Performance fixture.', projectIds: [], budgetRub: 8000000, operationalOverrides: []}];
  return result;
}
