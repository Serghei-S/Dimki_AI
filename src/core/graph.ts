import type { DistrictData, Edge, Profile } from './types.js';
import { requireCondition } from './errors.js';
import { compareId, ROUTING_EPSILON } from './util.js';

export interface Topology {
  nodeIds: string[];
  nodeIndex: Map<string, number>;
  edgeIndex: Map<string, number>;
  edgeFrom: Int32Array;
  edgeTo: Int32Array;
}
export interface RoutingGraph {
  topology: Topology;
  incomingOffsets: Uint32Array;
  incomingNodes: Uint32Array;
  incomingEdges: Uint32Array;
  incomingCosts: Float64Array;
  edgeCosts: Float64Array;
  activeNodes: Uint8Array;
  byteLength: number;
}
export interface RouteTree {
  distances: Float64Array;
  nextNodes: Int32Array;
  nextEdges: Int32Array;
  targets: Int32Array;
  byteLength: number;
}
export function compileTopology(data: DistrictData): Topology {
  const nodeIds = data.nodes.map(n => n.id).sort(compareId), nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  return {nodeIds, nodeIndex, edgeIndex: new Map(data.edges.map((e, i) => [e.id, i])),
    edgeFrom: Int32Array.from(data.edges.map(e => nodeIndex.get(e.from)!)),
    edgeTo: Int32Array.from(data.edges.map(e => nodeIndex.get(e.to)!))};
}
export function edgeBlockReason(edge: Edge, profile: Profile): string | null {
  if (edge.stairs && !profile.allowStairs) return 'stairs';
  if (Math.abs(edge.slope) > profile.maxSlope) return 'slope';
  if (edge.widthM < profile.minWidthM) return 'width';
  if (edge.crossing && profile.requiresKerbRamps && !edge.crossing.kerbRamps) return 'kerb_ramps';
  if (!(profile.surfaceSpeedFactors[edge.surface] > 0)) return 'surface';
  return null;
}
export function edgeTravelSeconds(edge: Edge, profile: Profile): number | null {
  return edgeBlockReason(edge, profile) ? null : edge.lengthM / (profile.speedMps * profile.surfaceSpeedFactors[edge.surface]) + (edge.crossing?.waitSeconds ?? 0);
}
export function buildRoutingGraph(topology: Topology, data: DistrictData, profile: Profile): RoutingGraph {
  const n = topology.nodeIds.length, activeNodes = new Uint8Array(n);
  for (const node of data.nodes) activeNodes[topology.nodeIndex.get(node.id)!] = Number(node.active);
  const counts = new Uint32Array(n), edgeCosts = new Float64Array(data.edges.length).fill(Infinity);
  for (let i = 0; i < data.edges.length; i++) {
    const edge = data.edges[i]!, from = topology.edgeFrom[i]!, to = topology.edgeTo[i]!;
    if (!edge.active || !activeNodes[from] || !activeNodes[to]) continue;
    const cost = edgeTravelSeconds(edge, profile);
    if (cost === null) continue;
    requireCondition(Number.isFinite(cost) && cost > 0, 'INVALID_STATE', `Non-positive routing cost at ${edge.id}`);
    edgeCosts[i] = cost; counts[to] = counts[to]! + 1;
    if (edge.bidirectional) counts[from] = counts[from]! + 1;
  }
  const incomingOffsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) incomingOffsets[i + 1] = incomingOffsets[i]! + counts[i]!;
  const size = incomingOffsets[n]!, incomingNodes = new Uint32Array(size), incomingEdges = new Uint32Array(size), incomingCosts = new Float64Array(size);
  const cursor = incomingOffsets.slice(0, n);
  const arc = (from: number, to: number, edge: number, cost: number): void => {
    const at = cursor[to]!; cursor[to] = at + 1;
    incomingNodes[at] = from; incomingEdges[at] = edge; incomingCosts[at] = cost;
  };
  for (let i = 0; i < data.edges.length; i++) if (Number.isFinite(edgeCosts[i])) {
    const edge = data.edges[i]!, from = topology.edgeFrom[i]!, to = topology.edgeTo[i]!, cost = edgeCosts[i]!;
    arc(from, to, i, cost); if (edge.bidirectional) arc(to, from, i, cost);
  }
  // Stable adjacency ordering also makes equal-cost path selection reproducible.
  for (let node = 0; node < n; node++) {
    const start = incomingOffsets[node]!, end = incomingOffsets[node + 1]!;
    const order = Array.from({length: end - start}, (_, i) => start + i).sort((a, b) => incomingNodes[a]! - incomingNodes[b]!
      || incomingCosts[a]! - incomingCosts[b]! || compareId(data.edges[incomingEdges[a]!]!.id, data.edges[incomingEdges[b]!]!.id));
    const ns = order.map(i => incomingNodes[i]!), es = order.map(i => incomingEdges[i]!), cs = order.map(i => incomingCosts[i]!);
    incomingNodes.set(ns, start); incomingEdges.set(es, start); incomingCosts.set(cs, start);
  }
  return {topology, incomingOffsets, incomingNodes, incomingEdges, incomingCosts, edgeCosts, activeNodes,
    byteLength: incomingOffsets.byteLength + incomingNodes.byteLength + incomingEdges.byteLength + incomingCosts.byteLength + edgeCosts.byteLength + activeNodes.byteLength};
}

class MinHeap {
  #nodes: number[] = [];
  #costs: number[] = [];
  #less(a: number, b: number): boolean { return this.#costs[a]! < this.#costs[b]! || (this.#costs[a] === this.#costs[b] && this.#nodes[a]! < this.#nodes[b]!); }
  #swap(a: number, b: number): void {
    [this.#nodes[a], this.#nodes[b]] = [this.#nodes[b]!, this.#nodes[a]!];
    [this.#costs[a], this.#costs[b]] = [this.#costs[b]!, this.#costs[a]!];
  }
  push(node: number, cost: number): void {
    let i = this.#nodes.length; this.#nodes.push(node); this.#costs.push(cost);
    while (i > 0) { const parent = (i - 1) >> 1; if (!this.#less(i, parent)) break; this.#swap(i, parent); i = parent; }
  }
  pop(): [number, number] | undefined {
    if (!this.#nodes.length) return undefined;
    const result: [number, number] = [this.#nodes[0]!, this.#costs[0]!];
    const node = this.#nodes.pop()!, cost = this.#costs.pop()!;
    if (this.#nodes.length) {
      this.#nodes[0] = node; this.#costs[0] = cost;
      let i = 0;
      while (true) { const left = i * 2 + 1, right = left + 1; let best = i;
        if (left < this.#nodes.length && this.#less(left, best)) best = left;
        if (right < this.#nodes.length && this.#less(right, best)) best = right;
        if (best === i) break; this.#swap(i, best); i = best;
      }
    }
    return result;
  }
}

/** Reverse multi-source Dijkstra: distances are FROM a node TO any supplied target. */
export function shortestToTargets(graph: RoutingGraph, targetIndices: Iterable<number>,options?:{initialCosts?:ReadonlyMap<number,number>;blockedEdge?:number}): RouteTree {
  const n = graph.topology.nodeIds.length, distances = new Float64Array(n).fill(Infinity),
    nextNodes = new Int32Array(n).fill(-1), nextEdges = new Int32Array(n).fill(-1), targets = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  for (const target of [...new Set(targetIndices)].sort((a, b) => a - b)) {
    if (!graph.activeNodes[target]) continue;
    const initial=options?.initialCosts?.get(target)??0;
    distances[target] = initial; targets[target] = target; heap.push(target, initial);
  }
  let current: [number, number] | undefined;
  while ((current = heap.pop())) {
    const [node, cost] = current;
    if (cost > distances[node]! + ROUTING_EPSILON) continue;
    for (let at = graph.incomingOffsets[node]!; at < graph.incomingOffsets[node + 1]!; at++) {
      if(options?.blockedEdge===graph.incomingEdges[at])continue;
      const previous = graph.incomingNodes[at]!, proposed = cost + graph.incomingCosts[at]!;
      if (proposed < distances[previous]! - ROUTING_EPSILON) {
        distances[previous] = proposed; nextNodes[previous] = node; nextEdges[previous] = graph.incomingEdges[at]!;
        targets[previous] = targets[node]!; heap.push(previous, proposed);
      }
    }
  }
  return {distances, nextNodes, nextEdges, targets,
    byteLength: distances.byteLength + nextNodes.byteLength + nextEdges.byteLength + targets.byteLength};
}
