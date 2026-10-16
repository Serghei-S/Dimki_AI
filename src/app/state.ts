import type { DeepReadonly, DistrictData, ScenarioInput } from '../core/types.js';
export interface ScenarioHistory {
  current: ScenarioInput;
  past: ScenarioInput[];
  future: ScenarioInput[];
}
export type HistoryAction = { type: 'apply'; scenario: ScenarioInput } | { type: 'undo' } | { type: 'redo' };
export const initialScenario = (): ScenarioInput => ({
  projectIds: [],
  budgetRub: 8000000,
  operationalOverrides: [],
});
export function copyScenario(scenario: ScenarioInput): ScenarioInput {
  return {
    projectIds: [...scenario.projectIds],
    budgetRub: scenario.budgetRub,
    operationalOverrides: structuredClone(scenario.operationalOverrides ?? []),
    ...(scenario.design ? { design: structuredClone(scenario.design) } : {}),
  };
}
export function scenarioHistory(state: ScenarioHistory, action: HistoryAction): ScenarioHistory {
  if (action.type === 'apply') {
    if (JSON.stringify(action.scenario) === JSON.stringify(state.current)) return state;
    return {
      current: copyScenario(action.scenario),
      past: [...state.past, state.current].slice(-60),
      future: [],
    };
  }
  if (action.type === 'undo' && state.past.length)
    return {
      current: state.past.at(-1)!,
      past: state.past.slice(0, -1),
      future: [state.current, ...state.future],
    };
  if (action.type === 'redo' && state.future.length)
    return { current: state.future[0]!, past: [...state.past, state.current], future: state.future.slice(1) };
  return state;
}
export function projectCost(data: DeepReadonly<DistrictData>, ids: readonly string[]): number {
  const map = new Map(data.projects.map((p) => [p.id, p.cost.capexRub]));
  return ids.reduce((sum, id) => {
    const cost = map.get(id);
    if (cost === undefined) throw new Error('Неизвестный проект');
    return sum + cost;
  }, 0);
}
export function selectProjects(
  data: DeepReadonly<DistrictData>,
  scenario: ScenarioInput,
  id: string,
): ScenarioInput {
  const projects = new Map(data.projects.map((p) => [p.id, p])),
    selected = new Set(scenario.projectIds),
    project = projects.get(id);
  if (!project) throw new Error('Проект не найден');
  const removeWithDependants = (remove: Set<string>) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const current of selected)
        if (remove.has(current) || projects.get(current)!.requires.some((p) => remove.has(p))) {
          selected.delete(current);
          remove.add(current);
          changed = true;
        }
    }
  };
  if (selected.has(id)) removeWithDependants(new Set([id]));
  else {
    const additions = new Set<string>(),
      stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      if (additions.has(current)) continue;
      additions.add(current);
      stack.push(...projects.get(current)!.requires);
    }
    const incompatible = new Set<string>();
    for (const existing of selected)
      for (const added of additions) {
        const a = projects.get(existing)!,
          b = projects.get(added)!;
        if (
          (a.exclusiveGroup && a.exclusiveGroup === b.exclusiveGroup && existing !== added) ||
          a.excludes.includes(added) ||
          b.excludes.includes(existing)
        )
          incompatible.add(existing);
      }
    removeWithDependants(incompatible);
    for (const added of additions) selected.add(added);
  }
  const ordered: string[] = [],
    done = new Set<string>();
  while (ordered.length < selected.size) {
    let progress = false;
    for (const current of [...selected].sort())
      if (!done.has(current) && projects.get(current)!.requires.every((p) => done.has(p))) {
        done.add(current);
        ordered.push(current);
        progress = true;
      }
    if (!progress) throw new Error('Нарушены зависимости проектов');
  }
  const cost = projectCost(data, ordered);
  if (cost > scenario.budgetRub)
    throw new Error(
      `Не хватает бюджета: требуется ${(cost / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн ₽`,
    );
  return { ...copyScenario(scenario), projectIds: ordered };
}
export function applyDistrictChanges(
  data: DeepReadonly<DistrictData>,
  changes: DeepReadonly<Pick<DistrictData, 'nodes' | 'edges' | 'destinations' | 'parcels'>> & {
    readonly stopBays?: DeepReadonly<DistrictData['stopBays']>;
  },
): DeepReadonly<DistrictData> {
  const replace = <T extends { readonly id: string }>(source: readonly T[], updates: readonly T[]) => {
    if (!updates.length) return source;
    const map = new Map(updates.map((value) => [value.id, value]));
    const known = new Set(source.map((value) => value.id));
    return [
      ...source.map((value) => map.get(value.id) ?? value),
      ...updates.filter((value) => !known.has(value.id)),
    ];
  };
  return {
    ...data,
    nodes: replace(data.nodes, changes.nodes),
    edges: replace(data.edges, changes.edges),
    destinations: replace(data.destinations, changes.destinations),
    parcels: replace(data.parcels, changes.parcels),
    stopBays: replace(data.stopBays, changes.stopBays ?? []),
  };
}
/** Deterministic, population-weighted home sample for future larger datasets. */
export function sampleHomes(data: DeepReadonly<DistrictData>, maxHomes = 160): string[] {
  const homes = data.buildings.filter((b) => b.population),
    total = homes.reduce((sum, b) => sum + b.population!.total, 0);
  if (homes.length <= maxHomes) return homes.map((b) => b.id);
  const selected = new Set<string>();
  let home = 0,
    cumulative = homes[0]!.population!.total;
  for (let i = 0; i < maxHomes; i++) {
    const target = ((i + 0.5) / maxHomes) * total;
    while (cumulative < target && home < homes.length - 1) cumulative += homes[++home]!.population!.total;
    selected.add(homes[home]!.id);
  }
  return [...selected];
}
