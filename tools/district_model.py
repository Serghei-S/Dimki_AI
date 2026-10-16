"""Dependency-free reference calculations; the JSON contract is language-neutral."""
from __future__ import annotations

import copy
import heapq
import math

EARTH_RADIUS_M = 6371008.8


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def line_length(points):
    return sum(distance(a, b) for a, b in zip(points, points[1:]))


def polygon_area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))) / 2


def rectangle(x1, y1, x2, y2):
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]


def to_wgs84(point, origin):
    """Small-area equirectangular display transform, NOT a surveying CRS."""
    lon, lat = origin
    return [round(lon + math.degrees(point[0] / (EARTH_RADIUS_M * math.cos(math.radians(lat)))), 8),
            round(lat + math.degrees(point[1] / EARTH_RADIUS_M), 8)]


def edge_seconds(edge, profile):
    if edge['stairs'] and not profile['allowStairs']:
        return None
    if abs(edge['slope']) > profile['maxSlope']:
        return None
    if edge['widthM'] < profile['minWidthM']:
        return None
    crossing = edge['crossing']
    if crossing and profile['requiresKerbRamps'] and not crossing['kerbRamps']:
        return None
    factor = profile['surfaceSpeedFactors'].get(edge['surface'], 0)
    if factor <= 0:
        return None
    return edge['lengthM'] / (profile['speedMps'] * factor) + (crossing['waitSeconds'] if crossing else 0)


def adjacency(data, profile_id):
    profile = next(p for p in data['profiles'] if p['id'] == profile_id)
    active = {n['id'] for n in data['nodes'] if n['active']}
    graph = {node: [] for node in active}
    for edge in data['edges']:
        if not edge['active'] or edge['from'] not in active or edge['to'] not in active:
            continue
        seconds = edge_seconds(edge, profile)
        if seconds is None:
            continue
        graph[edge['from']].append((edge['to'], seconds, edge['id']))
        if edge['bidirectional']:
            graph[edge['to']].append((edge['from'], seconds, edge['id']))
    return graph


def shortest_to_targets(graph, targets):
    """Reverse multi-source Dijkstra; supports directed future pedestrian links."""
    reverse = {node: [] for node in graph}
    for source, links in graph.items():
        for target, seconds, edge_id in links:
            reverse[target].append((source, seconds, edge_id))
    distances, next_steps, destination = {}, {}, {}
    queue = []
    for node in sorted(set(targets)):
        if node in graph:
            distances[node] = 0.0
            destination[node] = node
            heapq.heappush(queue, (0.0, node))
    while queue:
        seconds, node = heapq.heappop(queue)
        if seconds > distances[node] + 1e-9:
            continue
        for previous, cost, edge_id in sorted(reverse[node]):
            proposed = seconds + cost
            if proposed < distances.get(previous, math.inf) - 1e-9:
                distances[previous] = proposed
                next_steps[previous] = {'nodeId': node, 'edgeId': edge_id}
                destination[previous] = destination[node]
                heapq.heappush(queue, (proposed, previous))
    return distances, next_steps, destination


def apply_operations(data, operations):
    """Mutates a scenario copy, never the canonical base district."""
    indexes = {key: {item['id']: item for item in data[key]}
               for key in ['nodes', 'edges', 'destinations', 'parcels']}
    for operation in operations:
        op = operation['op']
        collection = {'set_node_active': 'nodes', 'set_edge_active': 'edges',
                      'set_destination_active': 'destinations', 'relocate_destination': 'destinations',
                      'upgrade_edge': 'edges', 'set_parcel_use': 'parcels'}.get(op)
        if collection is None:
            raise ValueError(f'Unsupported operation: {op}')
        entity = indexes[collection][operation['targetId']]
        if op == 'set_parcel_use':
            entity['kind'] = operation['kind']
        elif op.startswith('set_'):
            entity['active'] = operation['value']
        elif op == 'relocate_destination':
            entity['accessNodeIds'] = [operation['nodeId']]
            entity['stopBayId'] = operation['stopBayId']
        elif op == 'upgrade_edge':
            changes = operation['changes']
            if not set(changes) <= {'surface', 'stairs', 'slope', 'widthM', 'kerbRamps'}:
                raise ValueError('Unsupported edge upgrade')
            for key, value in changes.items():
                if key == 'kerbRamps':
                    if entity['crossing'] is None:
                        raise ValueError('Kerb ramps require a crossing')
                    entity['crossing']['kerbRamps'] = value
                else:
                    entity[key] = value


def materialize(data, scenario):
    result = copy.deepcopy(data)
    project_index = {p['id']: p for p in data['projects']}
    selected = scenario['projectIds']
    if len(selected) != len(set(selected)):
        raise ValueError('Duplicate project')
    groups = set()
    capex, opex = 0, 0
    for project_id in selected:
        project = project_index[project_id]
        if not set(project['requires']) <= set(selected):
            raise ValueError(f'Missing dependencies for {project_id}')
        if set(project['excludes']) & set(selected):
            raise ValueError(f'Conflicting projects for {project_id}')
        group = project['exclusiveGroup']
        if group and group in groups:
            raise ValueError(f'Conflicting exclusive group: {group}')
        if group:
            groups.add(group)
        capex += project['cost']['capexRub']
        opex += project['cost']['annualOpexRub']
    if capex > scenario['budgetRub']:
        raise ValueError('Capital budget exceeded')
    # Stable order is part of the scenario contract; dependencies must precede dependants.
    done = set()
    for project_id in selected:
        project = project_index[project_id]
        if not set(project['requires']) <= done:
            raise ValueError('Projects must be topologically ordered')
        apply_operations(result, project['operations'])
        done.add(project_id)
    apply_operations(result, scenario['operationalOverrides'])
    return result, {'capexRub': capex, 'annualOpexRub': opex, 'remainingRub': scenario['budgetRub'] - capex}


def metrics(data, profile_id):
    graph = adjacency(data, profile_id)
    homes = [b for b in data['buildings'] if b['kind'] == 'residential']
    total_population = sum(b['population']['total'] for b in homes)
    result = {'profileId': profile_id, 'evaluatedPopulation': total_population,
              'populationInterpretation': 'All residents hypothetically using this profile; profile totals must not be added.',
              'destinations': {}, 'perBuilding': []}
    per_home = {b['id']: {'buildingId': b['id'], 'residents': b['population']['total'], 'destinations': {}} for b in homes}
    for kind in ['bus_stop', 'park', 'school', 'clinic', 'grocery']:
        objects = [d for d in data['destinations'] if d['active'] and d['kind'] == kind]
        targets = [n for d in objects for n in d['accessNodeIds']]
        distances, _, _ = shortest_to_targets(graph, targets)
        threshold = data['metricDefinitions']['thresholdSeconds'][kind]
        reachable, within, weighted_seconds = 0, 0, 0.0
        for home in homes:
            seconds = min((distances.get(n, math.inf) for n in home['entranceNodeIds']), default=math.inf)
            population = home['population']['total']
            finite = math.isfinite(seconds)
            if finite:
                reachable += population
                weighted_seconds += seconds * population
                if seconds <= threshold + 1e-9:
                    within += population
            per_home[home['id']]['destinations'][kind] = {
                'travelSeconds': round(seconds, 3) if finite else None,
                'reachable': finite, 'withinThreshold': finite and seconds <= threshold + 1e-9}
        result['destinations'][kind] = {
            'thresholdSeconds': threshold,
            'reachableResidents': reachable,
            'unreachableResidents': total_population - reachable,
            'withinThresholdResidents': within,
            'coveragePercent': round(100 * within / total_population, 3) if total_population else None,
            'meanSecondsReachableOnly': round(weighted_seconds / reachable, 3) if reachable else None}
    result['perBuilding'] = list(per_home.values())
    parks = [d for d in data['destinations'] if d['active'] and d['kind'] == 'park']
    parcel_by_id = {p['id']: p for p in data['parcels']}
    park_parcel_ids = set(d['parcelId'] for d in parks)
    result['publicParkAreaM2'] = round(sum(parcel_by_id[p]['areaM2'] for p in park_parcel_ids), 2)
    result['publicParkM2PerResident'] = round(result['publicParkAreaM2'] / total_population, 3)
    return result


def compare_metrics(base, changed):
    before = {b['buildingId']: b for b in base['perBuilding']}
    result = {}
    for kind in base['destinations']:
        counters = {'improvedResidents': 0, 'worsenedResidents': 0, 'unchangedResidents': 0}
        for home in changed['perBuilding']:
            old = before[home['buildingId']]['destinations'][kind]['travelSeconds']
            new = home['destinations'][kind]['travelSeconds']
            old = math.inf if old is None else old
            new = math.inf if new is None else new
            key = 'improvedResidents' if new < old - .01 else 'worsenedResidents' if new > old + .01 else 'unchangedResidents'
            counters[key] += home['residents']
        counters['coverageDeltaPercentagePoints'] = round(changed['destinations'][kind]['coveragePercent'] - base['destinations'][kind]['coveragePercent'], 3)
        result[kind] = counters
    return result
