import type { DistrictData, Operation, Project, ScenarioInput, Materialized } from './types.js';
import { EngineError, requireCondition } from './errors.js';
import { parseScenario, validateState } from './validation.js';
import { deepFreeze, compareId } from './util.js';
import {applyDesign} from './design-materialize.js';

/** Explicit dependency expansion for a UI selection or optimizer, including their cost. */
export function resolveProjectOrder(data: DistrictData, selected: readonly string[]): string[] {
  const projects = new Map(data.projects.map(p => [p.id, p]));
  const done = new Set<string>(), active = new Set<string>(), ordered: string[] = [];
  // Iterative DFS avoids JS call-stack limits on deep dependency chains.
  for (const id of [...selected].sort(compareId)) {
    const stack: {id: string; exit: boolean}[] = [{id, exit: false}];
    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.exit) { active.delete(frame.id); done.add(frame.id); ordered.push(frame.id); continue; }
      if (done.has(frame.id)) continue;
      const project = projects.get(frame.id);
      requireCondition(project, 'UNKNOWN_ID', `Unknown project: ${frame.id}`);
      requireCondition(!active.has(frame.id), 'DEPENDENCY_ERROR', `Dependency cycle: ${frame.id}`);
      active.add(frame.id); stack.push({id: frame.id, exit: true});
      for (const required of [...project.requires].sort(compareId).reverse()) stack.push({id: required, exit: false});
    }
  }
  return ordered;
}

export function materializeScenario(base: DistrictData, input: unknown): Materialized {
  return materializeValidated(base, parseScenario(input));
}

/** Internal fast path: caller has already checked the structural input schema. */
export function materializeValidated(base: DistrictData, scenario: ScenarioInput): Materialized {
  const projectById = new Map(base.projects.map(p => [p.id, p]));
  const selected = new Set(scenario.projectIds), done = new Set<string>(), groups = new Set<string>();
  requireCondition(selected.size === scenario.projectIds.length, 'INVALID_SCENARIO', 'Duplicate project selection');
  let capexRub = 0, annualOpexRub = 0;
  const projects: Project[] = [];
  for (const id of scenario.projectIds) {
    const project = projectById.get(id);
    requireCondition(project, 'UNKNOWN_ID', `Unknown project: ${id}`);
    requireCondition(project.requires.every(required => done.has(required)), 'DEPENDENCY_ERROR', `Dependencies must be selected before ${id}`, project.requires);
    requireCondition(!project.excludes.some(other => selected.has(other)), 'PROJECT_CONFLICT', `Excluded project selected with ${id}`);
    requireCondition(!project.exclusiveGroup || !groups.has(project.exclusiveGroup), 'PROJECT_CONFLICT', `Exclusive group conflict: ${project.exclusiveGroup}`);
    if (project.exclusiveGroup) groups.add(project.exclusiveGroup);
    capexRub += project.cost.capexRub; annualOpexRub += project.cost.annualOpexRub;
    requireCondition(Number.isSafeInteger(capexRub) && Number.isSafeInteger(annualOpexRub), 'INVALID_SCENARIO', 'Costs exceed safe integer range');
    projects.push(project); done.add(id);
  }
  requireCondition(capexRub <= scenario.budgetRub, 'BUDGET_EXCEEDED', 'Capital budget exceeded', {capexRub, budgetRub: scenario.budgetRub});
  if (!projects.length && !(scenario.operationalOverrides?.length) && !scenario.design)
    return {data: base, costs: {capexRub: 0, annualOpexRub: 0, remainingRub: scenario.budgetRub}, scenario};

  // Copy arrays once, clone only changed records; unchanged geometry is shared with the frozen base.
  const data: DistrictData = {...base, nodes: [...base.nodes], edges: [...base.edges],
    destinations: [...base.destinations], parcels: [...base.parcels]};
  const indexes = {
    nodes: new Map(data.nodes.map((n, i) => [n.id, i])), edges: new Map(data.edges.map((e, i) => [e.id, i])),
    destinations: new Map(data.destinations.map((d, i) => [d.id, i])), parcels: new Map(data.parcels.map((p, i) => [p.id, i]))};
  const apply = (op: Operation): void => {
    switch (op.op) {
      case 'set_node_active': {
        const i = indexes.nodes.get(op.targetId); requireCondition(i !== undefined, 'UNKNOWN_ID', `Unknown node ${op.targetId}`);
        data.nodes[i] = {...data.nodes[i]!, active: op.value}; break;
      }
      case 'set_edge_active': {
        const i = indexes.edges.get(op.targetId); requireCondition(i !== undefined, 'UNKNOWN_ID', `Unknown edge ${op.targetId}`);
        data.edges[i] = {...data.edges[i]!, active: op.value}; break;
      }
      case 'set_destination_active': {
        const i = indexes.destinations.get(op.targetId); requireCondition(i !== undefined, 'UNKNOWN_ID', `Unknown destination ${op.targetId}`);
        data.destinations[i] = {...data.destinations[i]!, active: op.value}; break;
      }
      case 'set_parcel_use': {
        const i = indexes.parcels.get(op.targetId); requireCondition(i !== undefined, 'UNKNOWN_ID', `Unknown parcel ${op.targetId}`);
        requireCondition(base.parcels[i]!.kind === 'vacant' || base.parcels[i]!.kind === 'public_park', 'INVALID_SCENARIO', 'Park project cannot replace occupied land');
        data.parcels[i] = {...data.parcels[i]!, kind: op.kind}; break;
      }
      case 'relocate_destination': {
        const i = indexes.destinations.get(op.targetId); requireCondition(i !== undefined, 'UNKNOWN_ID', `Unknown destination ${op.targetId}`);
        data.destinations[i] = {...data.destinations[i]!, accessNodeIds: [op.nodeId], stopBayId: op.stopBayId}; break;
      }
      case 'upgrade_edge': {
        const i = indexes.edges.get(op.targetId); requireCondition(i !== undefined, 'UNKNOWN_ID', `Unknown edge ${op.targetId}`);
        const {kerbRamps, ...fields} = op.changes;
        const edge = data.edges[i]!;
        requireCondition(kerbRamps === undefined || edge.crossing !== null, 'INVALID_SCENARIO', 'Kerb ramps require a crossing');
        data.edges[i] = {...edge, ...fields, crossing: kerbRamps === undefined ? edge.crossing : {...edge.crossing!, kerbRamps}};
        break;
      }
      default: { const unsupported: never = op; throw new EngineError('INVALID_SCENARIO', 'Unsupported operation', unsupported); }
    }
  };
  for (const project of projects) for (const op of project.operations) apply(op);
  // A temporary closure is not a free infrastructure project. Reopening is allowed
  // only when the link existed after applying the paid projects.
  const builtEdges = new Map(data.edges.map(e => [e.id, e.active]));
  for (const op of scenario.operationalOverrides ?? []) {
    requireCondition(op.op === 'set_edge_active', 'INVALID_SCENARIO', 'Only temporary edge closures/reopenings are operational overrides');
    requireCondition(builtEdges.has(op.targetId), 'UNKNOWN_ID', `Unknown edge: ${op.targetId}`);
    requireCondition(!op.value || builtEdges.get(op.targetId), 'INVALID_SCENARIO', 'Cannot construct a planned link through an operational override');
    apply(op);
  }
  validateState(data);
  const designed=scenario.design?applyDesign(data,scenario.design):{data,capexRub:0,costItems:[]};
  capexRub+=designed.capexRub;
  requireCondition(capexRub<=scenario.budgetRub,'BUDGET_EXCEEDED','Бюджет меньше стоимости проектов и свободно размещённых объектов',{capexRub,budgetRub:scenario.budgetRub});
  validateState(designed.data);
  return {data: deepFreeze(designed.data), costs: {capexRub, annualOpexRub, remainingRub: scenario.budgetRub - capexRub}, scenario,
    costItems:[...projects.map(p=>({id:p.id,name:p.name,amountRub:p.cost.capexRub,formula:'Каталоговый проект'})),...designed.costItems]};
}
