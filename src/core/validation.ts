import validators from '../../.tools/generated/validators.mjs';
import type { DistrictData, Operation, Scenario, EngineOptions, OptimizationInput, ScenarioInput, ScenarioEnvelope } from './types.js';
import { EngineError, requireCondition } from './errors.js';
import { deepFreeze, stableKey } from './util.js';

export function assertSchema(kind: keyof typeof validators, value: unknown): void {
  if (!validators[kind](value)) throw new EngineError(kind === 'dataset' ? 'INVALID_DATASET' : 'INVALID_INPUT',
    `Invalid ${kind} structure`, structuredClone(validators[kind].errors ?? []));
}
export function parseDataset(input: unknown): DistrictData {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input); } catch { throw new EngineError('INVALID_DATASET', 'Dataset is not valid JSON'); }
  }
  assertSchema('dataset', value);
  const data = structuredClone(value) as DistrictData;
  const all = new Set<string>();
  const collections = ['nodes', 'edges', 'buildings', 'destinations', 'parcels', 'roads', 'blocks', 'stopBays', 'transitServices', 'projects', 'profiles', 'scenarios'] as const;
  for (const name of collections) for (const item of data[name]) {
    requireCondition(!all.has(item.id), 'INVALID_DATASET', `Duplicate global ID: ${item.id}`); all.add(item.id);
  }
  const nodes = new Map(data.nodes.map(n => [n.id, n]));
  const parcels = new Map(data.parcels.map(p => [p.id, p]));
  const blocks = new Set(data.blocks.map(b => b.id));
  const roads = new Set(data.roads.map(r => r.id));
  const buildings = new Set(data.buildings.map(b => b.id));
  const projects = new Map(data.projects.map(p => [p.id, p]));
  const services = new Set(data.transitServices.map(s => s.id));
  const bays = new Map(data.stopBays.map(b => [b.id, b]));
  const operationIndex: OperationIndex = {nodes: new Set(nodes.keys()), edges: new Map(data.edges.map(e => [e.id, e])),
    parcels, destinations: new Map(data.destinations.map(d => [d.id, d])), bays};
  for (const n of data.nodes) requireCondition(n.blockId === null || blocks.has(n.blockId), 'INVALID_DATASET', `Unknown block for ${n.id}`);
  for (const e of data.edges) {
    const from = nodes.get(e.from), to = nodes.get(e.to);
    requireCondition(from && to && e.from !== e.to, 'INVALID_DATASET', `Invalid endpoints: ${e.id}`);
    requireCondition(JSON.stringify(e.geometry[0]) === JSON.stringify(from.xy) && JSON.stringify(e.geometry.at(-1)) === JSON.stringify(to.xy), 'INVALID_DATASET', `Geometry endpoints mismatch: ${e.id}`);
    const length = e.geometry.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - e.geometry[i]![0], p[1] - e.geometry[i]![1]), 0);
    requireCondition(Math.abs(length - e.lengthM) < 1e-5 && length > 0, 'INVALID_DATASET', `Invalid length: ${e.id}`);
    requireCondition((e.kind === 'crossing') === (e.crossing !== null) && (!e.crossing || roads.has(e.crossing.roadId)), 'INVALID_DATASET', `Invalid crossing: ${e.id}`);
  }
  for (const p of data.parcels) {
    requireCondition(blocks.has(p.blockId), 'INVALID_DATASET', `Unknown block: ${p.id}`);
    const area = Math.abs(p.polygon.slice(1).reduce((s, b, i) => {const a = p.polygon[i]!; return s + a[0] * b[1] - b[0] * a[1];}, 0)) / 2;
    requireCondition(Math.abs(area - p.areaM2) < 1e-5, 'INVALID_DATASET', `Wrong parcel area: ${p.id}`);
    requireCondition(!p.fence || p.fence.gateNodeIds.every(n => nodes.has(n)), 'INVALID_DATASET', `Unknown gate: ${p.id}`);
  }
  for (const b of data.buildings) {
    requireCondition(parcels.has(b.parcelId) && blocks.has(b.blockId) && b.entranceNodeIds.every(n => nodes.has(n)), 'INVALID_DATASET', `Invalid building references: ${b.id}`);
    requireCondition((b.kind === 'residential') === (b.population !== null), 'INVALID_DATASET', `Population/use mismatch: ${b.id}`);
    if (b.population) {
      const p = b.population;
      requireCondition(Object.values(p.ageGroups).reduce((a, n) => a + n, 0) === p.total
        && Object.values(p.householdSizeCounts).reduce((a, n) => a + n, 0) === p.households
        && Object.entries(p.householdSizeCounts).reduce((a, [s, n]) => a + Number(s) * n, 0) === p.total
        && p.households === p.occupiedApartments && p.occupiedApartments <= p.apartments && p.mobilityNeedsResidents <= p.total,
      'INVALID_DATASET', `Inconsistent population: ${b.id}`);
    }
  }
  for (const bay of data.stopBays) requireCondition(nodes.has(bay.nodeId) && roads.has(bay.roadId) && bay.routeIds.every(s => services.has(s)), 'INVALID_DATASET', `Invalid bay: ${bay.id}`);
  for (const d of data.destinations) requireCondition(d.accessNodeIds.every(n => nodes.has(n)) && (!d.parcelId || parcels.has(d.parcelId))
    && (!d.buildingId || buildings.has(d.buildingId)) && (!d.stopBayId || bays.has(d.stopBayId)) && d.routeIds.every(s => services.has(s)), 'INVALID_DATASET', `Invalid destination: ${d.id}`);
  const dependants = new Map<string, string[]>(), pending = new Map<string, number>();
  for (const p of data.projects) {
    pending.set(p.id, p.requires.length);
    for (const required of p.requires) {
      requireCondition(projects.has(required), 'INVALID_DATASET', `Unknown dependency ${required}`);
      const children = dependants.get(required) ?? []; children.push(p.id); dependants.set(required, children);
    }
    requireCondition(p.excludes.every(id => projects.has(id) && id !== p.id), 'INVALID_DATASET', `Invalid project exclusions: ${p.id}`);
    for (const op of p.operations) validateOperationReference(operationIndex, op);
  }
  const queue = data.projects.filter(p => !p.requires.length).map(p => p.id);
  for (let i = 0; i < queue.length; i++) for (const child of dependants.get(queue[i]!) ?? []) {
    pending.set(child, pending.get(child)! - 1); if (pending.get(child) === 0) queue.push(child);
  }
  requireCondition(queue.length === projects.size, 'INVALID_DATASET', 'Project dependency cycle');
  const dependsOn = (from: string, target: string): boolean => {
    const stack = [...projects.get(from)!.requires], seen = new Set<string>();
    while (stack.length) {const id = stack.pop()!; if (id === target) return true;
      if (seen.has(id)) continue; seen.add(id); stack.push(...projects.get(id)!.requires);}
    return false;
  };
  const writes = new Map<string, {projectId: string; value: string}[]>();
  for (const p of data.projects) for (const op of p.operations) {
    const fields = op.op === 'upgrade_edge' ? op.changes : op.op === 'relocate_destination' ? {accessNodeIds: [op.nodeId], stopBayId: op.stopBayId}
      : op.op === 'set_parcel_use' ? {kind: op.kind} : {active: op.value};
    const collection = op.op === 'set_node_active' ? 'nodes' : op.op === 'set_parcel_use' ? 'parcels'
      : op.op === 'set_destination_active' || op.op === 'relocate_destination' ? 'destinations' : 'edges';
    for (const [field, value] of Object.entries(fields)) {
      const key = `${collection}:${op.targetId}:${field}`, previous = writes.get(key) ?? [], encoded = stableKey(value);
      for (const earlier of previous) {
        if (earlier.projectId === p.id || earlier.value === encoded) continue;
        const other = projects.get(earlier.projectId)!;
        requireCondition((p.exclusiveGroup !== null && p.exclusiveGroup === other.exclusiveGroup)
          || p.excludes.includes(other.id) || other.excludes.includes(p.id) || dependsOn(p.id, other.id) || dependsOn(other.id, p.id),
        'INVALID_DATASET', `Undeclared conflicting project writes: ${other.id}, ${p.id}`);
      }
      previous.push({projectId: p.id, value: encoded}); writes.set(key, previous);
    }
  }
  validateState(data);
  return deepFreeze(data);
}

interface OperationIndex {
  nodes: Set<string>;
  edges: Map<string, DistrictData['edges'][number]>;
  parcels: Map<string, DistrictData['parcels'][number]>;
  destinations: Map<string, DistrictData['destinations'][number]>;
  bays: Map<string, DistrictData['stopBays'][number]>;
}
function validateOperationReference(index: OperationIndex, op: Operation): void {
  const key = op.op === 'set_node_active' ? 'nodes' : op.op === 'set_parcel_use' ? 'parcels'
    : op.op === 'set_destination_active' || op.op === 'relocate_destination' ? 'destinations' : 'edges';
  requireCondition(index[key].has(op.targetId), 'INVALID_DATASET', `Unknown operation target: ${op.targetId}`);
  if (op.op === 'relocate_destination') {
    const d = index.destinations.get(op.targetId)!;
    const old = d.stopBayId ? index.bays.get(d.stopBayId) : undefined, bay = index.bays.get(op.stopBayId);
    requireCondition(d.kind === 'bus_stop' && old && bay && bay.nodeId === op.nodeId && old.roadId === bay.roadId && old.side === bay.side
      && d.routeIds.every(r => bay.routeIds.includes(r)), 'INVALID_DATASET', `Incompatible stop relocation: ${op.targetId}`);
  }
  if (op.op === 'upgrade_edge' && op.changes.kerbRamps !== undefined)
    requireCondition(index.edges.get(op.targetId)!.crossing, 'INVALID_DATASET', 'Kerb ramps require crossing metadata');
  if (op.op === 'set_parcel_use') requireCondition(['vacant', 'public_park'].includes(index.parcels.get(op.targetId)!.kind), 'INVALID_DATASET', 'Park project cannot replace occupied land');
}

export function validateState(data: DistrictData): void {
  const nodes = new Map(data.nodes.map(n => [n.id, n]));
  const parcels = new Map(data.parcels.map(p => [p.id, p]));
  const bays = new Map(data.stopBays.map(b => [b.id, b]));
  const occupied = new Set<string>();
  for (const e of data.edges) requireCondition(!e.active || (nodes.get(e.from)?.active && nodes.get(e.to)?.active), 'INVALID_STATE', `Active edge has inactive endpoint: ${e.id}`);
  for (const d of data.destinations) {
    if (!d.active) continue;
    requireCondition(d.accessNodeIds.every(n => nodes.get(n)?.active), 'INVALID_STATE', `Active destination has inactive entrance: ${d.id}`);
    if (d.kind === 'park') requireCondition(d.parcelId && parcels.get(d.parcelId)?.active && parcels.get(d.parcelId)?.kind === 'public_park', 'INVALID_STATE', `Park land use mismatch: ${d.id}`);
    if (d.kind === 'bus_stop') {
      const bay = d.stopBayId ? bays.get(d.stopBayId) : undefined;
      requireCondition(bay && d.accessNodeIds.length === 1 && d.accessNodeIds[0] === bay.nodeId && d.routeIds.every(r => bay.routeIds.includes(r)), 'INVALID_STATE', `Stop/bay mismatch: ${d.id}`);
      requireCondition(!occupied.has(bay.id), 'INVALID_STATE', `Occupied stop bay: ${bay.id}`); occupied.add(bay.id);
    }
  }
}
export function parseScenario(input: unknown): ScenarioInput {
  assertSchema('scenario', input);
  const value = input as Scenario | ScenarioInput;
  return {projectIds: [...value.projectIds], budgetRub: value.budgetRub, operationalOverrides: structuredClone(value.operationalOverrides ?? [])};
}
export function parseOptions(input: unknown): EngineOptions { assertSchema('options', input); return structuredClone(input) as EngineOptions; }
export function parseOptimization(input: unknown): OptimizationInput { assertSchema('optimization', input); return structuredClone(input) as OptimizationInput; }
export function parseEnvelope(input: unknown): ScenarioEnvelope { assertSchema('envelope', input); return structuredClone(input) as ScenarioEnvelope; }
