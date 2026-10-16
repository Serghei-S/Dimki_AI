"""Schema, geometry, topology, population and scenario integrity checks."""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataset_schema import build_schema
from district_model import distance, line_length, polygon_area, adjacency, shortest_to_targets, materialize, metrics

EPS = 1e-6


def json_equal(a, b):
    # Python considers True == 1; JSON Schema does not.
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(json_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(json_equal(a[k], b[k]) for k in a)
    return a == b


def schema_errors(value, schema, root=None, path='$'):
    """Checks the exact JSON Schema vocabulary emitted by dataset_schema.py.

    External draft-2020-12 validator can additionally be used; no dependency is
    needed to run this project's normal build/check workflow.
    """
    root = schema if root is None else root
    if '$ref' in schema:
        target = root
        for part in schema['$ref'].removeprefix('#/').split('/'):
            target = target[part]
        return schema_errors(value, target, root, path)
    for combinator, wanted in [('oneOf', 1), ('anyOf', None)]:
        if combinator in schema:
            passed = sum(not schema_errors(value, branch, root, path) for branch in schema[combinator])
            return [] if (passed == wanted if wanted else passed > 0) else [f'{path}: violates {combinator}']
    errors = []
    if 'const' in schema and not json_equal(value, schema['const']):
        errors.append(f'{path}: expected constant {schema["const"]!r}')
    if 'enum' in schema and not any(json_equal(value, v) for v in schema['enum']):
        errors.append(f'{path}: outside enum')
    kind = schema.get('type')
    matches = {'object': isinstance(value, dict), 'array': isinstance(value, list),
               'string': isinstance(value, str), 'boolean': isinstance(value, bool),
               'number': isinstance(value, (int, float)) and not isinstance(value, bool),
               'integer': isinstance(value, int) and not isinstance(value, bool), 'null': value is None}
    if kind and not matches[kind]:
        return errors + [f'{path}: expected {kind}']
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{path}: missing {key}')
        if len(value) < schema.get('minProperties', 0):
            errors.append(f'{path}: too few properties')
        props = schema.get('properties', {})
        for key, item in value.items():
            if key in props:
                errors.extend(schema_errors(item, props[key], root, f'{path}.{key}'))
            elif schema.get('additionalProperties') is False:
                errors.append(f'{path}: unknown field {key}')
    elif isinstance(value, list):
        if not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', math.inf):
            errors.append(f'{path}: invalid array length')
        if schema.get('uniqueItems') and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            errors.append(f'{path}: duplicate array items')
        if 'items' in schema:
            for i, item in enumerate(value):
                errors.extend(schema_errors(item, schema['items'], root, f'{path}[{i}]'))
    elif isinstance(value, str):
        import re
        if len(value) < schema.get('minLength', 0):
            errors.append(f'{path}: string too short')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            errors.append(f'{path}: pattern mismatch')
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value) or not schema.get('minimum', -math.inf) <= value <= schema.get('maximum', math.inf):
            errors.append(f'{path}: invalid numeric value')
    return errors


def on_segment(point, a, b):
    cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])
    return abs(cross) < EPS and min(a[0], b[0]) - EPS <= point[0] <= max(a[0], b[0]) + EPS and min(a[1], b[1]) - EPS <= point[1] <= max(a[1], b[1]) + EPS


def on_boundary(point, ring):
    return any(on_segment(point, a, b) for a, b in zip(ring, ring[1:]))


def inside(point, ring, boundary=False):
    if on_boundary(point, ring):
        return boundary
    hit = False
    x, y = point
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y):
            xx = (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
            if x < xx:
                hit = not hit
    return hit


def boundary_intersections(a, b, ring):
    result = []
    dx, dy = b[0] - a[0], b[1] - a[1]
    for c, d in zip(ring, ring[1:]):
        ex, ey = d[0] - c[0], d[1] - c[1]
        denominator = dx * ey - dy * ex
        if abs(denominator) < EPS:
            continue
        t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / denominator
        u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / denominator
        if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
            point = [a[0] + t * dx, a[1] + t * dy]
            if not any(distance(point, existing[1]) < EPS for existing in result):
                result.append((max(0, min(1, t)), point))
    return result


def enters_interior(a, b, ring):
    cuts = sorted(set([0, 1] + [t for t, _ in boundary_intersections(a, b, ring)]))
    return any(inside([a[0] + (b[0] - a[0]) * (u + v) / 2, a[1] + (b[1] - a[1]) * (u + v) / 2], ring)
               for u, v in zip(cuts, cuts[1:]) if v - u > EPS)


def polygon_errors(ring):
    errors = []
    if ring[0] != ring[-1]:
        errors.append('unclosed polygon')
    if len(set(map(tuple, ring[:-1]))) != len(ring) - 1:
        errors.append('repeated polygon vertex')
    signed_area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2
    if signed_area <= EPS:
        errors.append('polygon must have positive area and counterclockwise exterior')
    segments = list(zip(ring, ring[1:]))
    for i, (a, b) in enumerate(segments):
        if distance(a, b) < EPS:
            errors.append('zero-length polygon side')
        for j, (c, d) in enumerate(segments):
            if j <= i + 1 or (i == 0 and j == len(segments) - 1):
                continue
            if boundary_intersections(a, b, [c, d]):
                errors.append('self-intersecting polygon')
    return errors


def segment_intersection(a, b, c, d):
    """Return (point, overlapping_length); ignores nonintersecting AABBs early."""
    if any(max(min(a[i], b[i]), min(c[i], d[i])) > min(max(a[i], b[i]), max(c[i], d[i])) + EPS for i in [0, 1]):
        return None, 0
    hits = boundary_intersections(a, b, [c, d])
    if hits:
        return hits[0][1], 0
    cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if abs(cross) > EPS:
        return None, 0
    axis = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
    lo, hi = max(min(a[axis], b[axis]), min(c[axis], d[axis])), min(max(a[axis], b[axis]), max(c[axis], d[axis]))
    if hi < lo - EPS:
        return None, 0
    denominator = b[axis] - a[axis]
    if abs(denominator) < EPS:
        return None, 0
    t = (lo - a[axis]) / denominator
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], max(0, hi - lo)


def validate(data, deep=True):
    errors = schema_errors(data, build_schema())
    warnings = []
    checks = Counter()
    if errors:
        return {'valid': False, 'errors': errors, 'warnings': warnings, 'checks': {}, 'summary': {}}

    def check(condition, message, category):
        checks[category] += 1
        if not condition:
            errors.append(message)

    collections = ['roads', 'blocks', 'parcels', 'buildings', 'nodes', 'edges', 'destinations', 'stopBays', 'transitServices', 'projects', 'scenarios', 'profiles']
    indexes = {key: {item['id']: item for item in data[key]} for key in collections}
    all_ids = [item['id'] for key in collections for item in data[key]]
    check(len(all_ids) == len(set(all_ids)), 'IDs must be globally unique', 'identifiers')
    for key in collections:
        check(len(indexes[key]) == len(data[key]), f'Duplicate {key} ID', 'identifiers')
    nodes, blocks, parcels = indexes['nodes'], indexes['blocks'], indexes['parcels']
    xmin, ymin, xmax, ymax = data['metadata']['boundsM']
    for key in ['roads', 'blocks', 'parcels', 'buildings']:
        for item in data[key]:
            for error in polygon_errors(item['polygon']):
                errors.append(f'{item["id"]}: {error}')
            checks['polygons'] += 1
            for x, y in item['polygon']:
                check(xmin <= x <= xmax and ymin <= y <= ymax, f'{item["id"]}: polygon out of bounds', 'bounds')
            if key == 'parcels':
                check(abs(item['areaM2'] - polygon_area(item['polygon'])) < EPS, f'{item["id"]}: wrong parcel area', 'areas')
                check(item['blockId'] in blocks, f'{item["id"]}: missing block', 'references')
                if item['blockId'] in blocks:
                    check(all(inside(p, blocks[item['blockId']]['polygon'], True) for p in item['polygon']), f'{item["id"]}: parcel outside block', 'containment')
    for i, a in enumerate(data['parcels']):
        for b in data['parcels'][i + 1:]:
            ca = [sum(p[axis] for p in a['polygon'][:-1]) / (len(a['polygon']) - 1) for axis in [0, 1]]
            cb = [sum(p[axis] for p in b['polygon'][:-1]) / (len(b['polygon']) - 1) for axis in [0, 1]]
            check(not any(enters_interior(u, v, b['polygon']) for u, v in zip(a['polygon'], a['polygon'][1:]))
                  and not any(inside(p, a['polygon']) for p in b['polygon'][:-1])
                  and not (inside(ca, a['polygon']) and inside(ca, b['polygon']))
                  and not (inside(cb, b['polygon']) and inside(cb, a['polygon'])), f'Overlapping parcels: {a["id"]}, {b["id"]}', 'parcel_overlap')
    for n in data['nodes']:
        check(xmin <= n['xy'][0] <= xmax and ymin <= n['xy'][1] <= ymax, f'{n["id"]}: node out of bounds', 'bounds')
        check(n['blockId'] is None or n['blockId'] in blocks, f'{n["id"]}: missing block', 'references')
        if n['blockId'] in blocks:
            check(inside(n['xy'], blocks[n['blockId']]['polygon'], True), f'{n["id"]}: node outside assigned block', 'containment')
        check(not any(inside(n['xy'], r['polygon']) for r in data['roads']), f'{n["id"]}: pedestrian node inside carriageway', 'road_barriers')
        check(not any(inside(n['xy'], b['polygon']) for b in data['buildings']), f'{n["id"]}: pedestrian node inside building', 'building_barriers')
    check(len({tuple(n['xy']) for n in data['nodes']}) == len(data['nodes']), 'Duplicate node coordinates: merge nodes or model grade separation explicitly', 'topology')
    endpoint_pairs = []
    for e in data['edges']:
        check(e['from'] in nodes and e['to'] in nodes, f'{e["id"]}: missing endpoint', 'references')
        if e['from'] not in nodes or e['to'] not in nodes:
            continue
        check(e['from'] != e['to'], f'{e["id"]}: self-loop', 'topology')
        check(e['geometry'][0] == nodes[e['from']]['xy'] and e['geometry'][-1] == nodes[e['to']]['xy'], f'{e["id"]}: geometry/endpoint mismatch', 'geometry')
        check(abs(line_length(e['geometry']) - e['lengthM']) < 1e-5, f'{e["id"]}: wrong length', 'geometry')
        check(not e['active'] or (nodes[e['from']]['active'] and nodes[e['to']]['active']), f'{e["id"]}: active edge touches inactive node', 'topology')
        check((e['kind'] == 'crossing') == (e['crossing'] is not None), f'{e["id"]}: crossing metadata mismatch', 'crossings')
        if e['crossing'] and e['crossing']['roadId'] in indexes['roads']:
            road = indexes['roads'][e['crossing']['roadId']]
            axis = 0 if road['axis'] == 'vertical' else 1
            check((nodes[e['from']]['xy'][axis] - road['centerM']) * (nodes[e['to']]['xy'][axis] - road['centerM']) < 0,
                  f'{e["id"]}: crossing endpoints must be on opposite road sides', 'crossings')
        endpoint_pairs.append(tuple(sorted([e['from'], e['to']])) if e['bidirectional'] else (e['from'], e['to']))
        intersected = set()
        for a, b in zip(e['geometry'], e['geometry'][1:]):
            for road in data['roads']:
                if enters_interior(a, b, road['polygon']):
                    intersected.add(road['id'])
            for building in data['buildings']:
                check(not enters_interior(a, b, building['polygon']), f'{e["id"]}: path crosses building {building["id"]}', 'building_barriers')
            for p in data['parcels']:
                if p['fence']:
                    gate_points = [nodes[g]['xy'] for g in p['fence']['gateNodeIds'] if g in nodes]
                    for _, point in boundary_intersections(a, b, p['polygon']):
                        check(any(distance(point, g) < EPS for g in gate_points), f'{e["id"]}: fence crossed outside gate at {p["id"]}', 'fence_barriers')
                if p['kind'] == 'public_park' or any(d['kind'] == 'park' and d['parcelId'] == p['id'] for d in data['destinations']):
                    gates = [nodes[n]['xy'] for d in data['destinations'] if d['kind'] == 'park' and d['parcelId'] == p['id'] for n in d['accessNodeIds'] if n in nodes]
                    for _, point in boundary_intersections(a, b, p['polygon']):
                        check(any(distance(point, g) < EPS for g in gates), f'{e["id"]}: park boundary crossed outside declared entrance {p["id"]}', 'park_entrances')
        check(intersected == ({e['crossing']['roadId']} if e['crossing'] else set()), f'{e["id"]}: unmodelled road crossing {sorted(intersected)}', 'road_barriers')
    check(len(endpoint_pairs) == len(set(endpoint_pairs)), 'Duplicate pedestrian edge endpoint pair', 'topology')
    # Crossing lines must connect in the graph; all links are at ground level in v1.
    for i, first in enumerate(data['edges']):
        for second in data['edges'][i + 1:]:
            shared = set([first['from'], first['to']]) & set([second['from'], second['to']])
            for a, b in zip(first['geometry'], first['geometry'][1:]):
                for c, d in zip(second['geometry'], second['geometry'][1:]):
                    point, overlap = segment_intersection(a, b, c, d)
                    if point is not None:
                        check(overlap < EPS and any(distance(point, nodes[n]['xy']) < EPS for n in shared),
                              f'Unnoded/overlapping paths: {first["id"]}, {second["id"]}', 'path_intersections')
    for b in data['buildings']:
        check(b['parcelId'] in parcels and b['blockId'] in blocks, f'{b["id"]}: missing parcel/block', 'references')
        if b['parcelId'] in parcels:
            check(all(inside(p, parcels[b['parcelId']]['polygon'], True) for p in b['polygon']), f'{b["id"]}: building outside parcel', 'containment')
        check(abs(b['footprintAreaM2'] - polygon_area(b['polygon'])) < EPS, f'{b["id"]}: wrong footprint area', 'areas')
        for entrance in b['entranceNodeIds']:
            check(entrance in nodes, f'{b["id"]}: missing entrance', 'references')
            if entrance in nodes:
                check(nodes[entrance]['kind'] == 'building_entrance' and on_boundary(nodes[entrance]['xy'], b['polygon']), f'{b["id"]}: entrance off facade', 'entrances')
        population = b['population']
        check((b['kind'] == 'residential') == (population is not None), f'{b["id"]}: population incompatible with building use', 'population')
        if population:
            check(sum(population['ageGroups'].values()) == population['total'], f'{b["id"]}: inconsistent age groups', 'population')
            check(sum(int(size) * count for size, count in population['householdSizeCounts'].items()) == population['total'], f'{b["id"]}: inconsistent household population', 'population')
            check(sum(population['householdSizeCounts'].values()) == population['households'] == population['occupiedApartments'] <= population['apartments'], f'{b["id"]}: inconsistent apartment occupancy', 'population')
            check(population['mobilityNeedsResidents'] <= population['total'], f'{b["id"]}: mobility group exceeds population', 'population')
            avg_area = b['footprintAreaM2'] * b['floors'] * .72 / population['apartments']
            check(35 <= avg_area <= 140, f'{b["id"]}: implausible average apartment area {avg_area}', 'population_plausibility')
    for p in data['parcels']:
        if p['fence']:
            for gate in p['fence']['gateNodeIds']:
                check(gate in nodes and on_boundary(nodes[gate]['xy'], p['polygon']), f'{p["id"]}: invalid fence gate', 'fence_gates')
    for bay in data['stopBays']:
        check(all(route in indexes['transitServices'] for route in bay['routeIds']), f'{bay["id"]}: unknown transit service', 'references')
        check(bay['nodeId'] in nodes and bay['roadId'] in indexes['roads'], f'{bay["id"]}: invalid node/road', 'references')
        if bay['nodeId'] in nodes and bay['roadId'] in indexes['roads']:
            road = indexes['roads'][bay['roadId']]
            xy = nodes[bay['nodeId']]['xy']
            delta = xy[0 if road['axis'] == 'vertical' else 1] - road['centerM']
            check(abs(abs(delta) - road['widthM'] / 2 - 4) < EPS, f'{bay["id"]}: stop bay is not on roadside sidewalk', 'stop_bays')
            expected = ('west' if delta < 0 else 'east') if road['axis'] == 'vertical' else ('south' if delta < 0 else 'north')
            check(bay['side'] == expected, f'{bay["id"]}: wrong road side', 'stop_bays')
    for d in data['destinations']:
        check(all(route in indexes['transitServices'] for route in d['routeIds']), f'{d["id"]}: unknown transit service', 'references')
        for key, collection in [('parcelId', 'parcels'), ('buildingId', 'buildings'), ('stopBayId', 'stopBays')]:
            check(d[key] is None or d[key] in indexes[collection], f'{d["id"]}: missing {key}', 'references')
        for n in d['accessNodeIds']:
            check(n in nodes and (not d['active'] or nodes[n]['active']), f'{d["id"]}: missing/inactive access node', 'references')
            if d['kind'] == 'park' and n in nodes and d['parcelId'] in parcels:
                check(nodes[n]['kind'] == 'park_entrance' and on_boundary(nodes[n]['xy'], parcels[d['parcelId']]['polygon']), f'{d["id"]}: park entrance not on boundary', 'park_entrances')
        if d['kind'] == 'park' and d['active'] and d['parcelId'] in parcels:
            check(parcels[d['parcelId']]['kind'] == 'public_park', f'{d["id"]}: active park has non-park land use', 'land_use')
        if d['kind'] == 'bus_stop' and d['stopBayId'] in indexes['stopBays']:
            bay = indexes['stopBays'][d['stopBayId']]
            check(d['accessNodeIds'] == [bay['nodeId']] and d['routeIds'] == bay['routeIds'], f'{d["id"]}: stop inconsistent with bay', 'stop_bays')
    occupied_bays = [d['stopBayId'] for d in data['destinations'] if d['active'] and d['kind'] == 'bus_stop']
    check(len(occupied_bays) == len(set(occupied_bays)), 'Two stops occupy the same bay; model a shared stop explicitly', 'stop_bays')

    # Validate operations on all candidates, including candidates absent from saved scenarios.
    operation_collection = {'set_node_active': 'nodes', 'set_edge_active': 'edges', 'set_destination_active': 'destinations',
                            'upgrade_edge': 'edges', 'relocate_destination': 'destinations', 'set_parcel_use': 'parcels'}
    for project in data['projects']:
        for other in project['requires'] + project['excludes']:
            check(other in indexes['projects'] and other != project['id'], f'{project["id"]}: invalid project dependency/exclusion', 'projects')
        for op in project['operations']:
            check(op['targetId'] in indexes[operation_collection[op['op']]], f'{project["id"]}: missing operation target', 'projects')
            if op['op'] == 'relocate_destination':
                destination = indexes['destinations'].get(op['targetId'])
                bay = indexes['stopBays'].get(op['stopBayId'])
                check(bay is not None and bay['nodeId'] == op['nodeId'], f'{project["id"]}: invalid relocation bay', 'projects')
                if bay and destination:
                    old = indexes['stopBays'].get(destination['stopBayId'])
                    check(old is not None and old['roadId'] == bay['roadId'] and old['side'] == bay['side'] and set(destination['routeIds']) <= set(bay['routeIds']), f'{project["id"]}: relocation changes road/side/service', 'projects')
    # A future optimizer can combine candidates only when conflicting writes
    # have an explicit exclusion or ordered dependency in the catalogue.
    writes = {}
    for project in data['projects']:
        for op in project['operations']:
            collection = operation_collection[op['op']]
            if op['op'] == 'upgrade_edge':
                fields = op['changes']
            elif op['op'] == 'relocate_destination':
                fields = {'accessNodeIds': [op['nodeId']], 'stopBayId': op['stopBayId']}
            elif op['op'] == 'set_parcel_use':
                fields = {'kind': op['kind']}
            else:
                fields = {'active': op['value']}
            for field, value in fields.items():
                key = (collection, op['targetId'], field)
                for previous, old_value in writes.get(key, []):
                    declared = ((project['exclusiveGroup'] and project['exclusiveGroup'] == previous['exclusiveGroup'])
                                or previous['id'] in project['excludes'] or project['id'] in previous['excludes']
                                or previous['id'] in project['requires'] or project['id'] in previous['requires'])
                    check(json_equal(value, old_value) or declared,
                          f'Undeclared conflicting project writes: {previous["id"]}, {project["id"]} at {key}', 'project_interactions')
                writes.setdefault(key, []).append((project, value))
    if deep and not errors:
        for profile in data['profiles']:
            graph = adjacency(data, profile['id'])
            anchor = next(iter(graph))
            distances, _, _ = shortest_to_targets(graph, [anchor])
            check(len(distances) == len(graph), f'{profile["id"]}: baseline active graph is disconnected', 'connectivity')
            result = metrics(data, profile['id'])
            for kind, stats in result['destinations'].items():
                check(stats['unreachableResidents'] == 0, f'{profile["id"]}: baseline residents cannot reach {kind}', 'reachability')
        scenarios = list(data['scenarios'])
        for project in data['projects']:
            def dependency_order(pid, trail=()):
                if pid in trail:
                    raise ValueError(f'Dependency cycle at {pid}')
                ordered = []
                for requirement in indexes['projects'][pid]['requires']:
                    ordered.extend(dependency_order(requirement, trail + (pid,)))
                return list(dict.fromkeys(ordered + [pid]))
            try:
                selected = dependency_order(project['id'])
                scenarios.append({'id': f'check_{project["id"]}', 'projectIds': selected, 'budgetRub': 1000000000, 'operationalOverrides': []})
            except (ValueError, KeyError) as error:
                errors.append(str(error))
        for scenario in scenarios:
            try:
                changed, _ = materialize(data, scenario)
                sub = validate(changed, deep=False)
                check(not sub['errors'], f'{scenario["id"]}: invalid materialized geometry/state: {sub["errors"][:3]}', 'scenario_integrity')
            except (ValueError, KeyError) as error:
                errors.append(f'{scenario["id"]}: {error}')
    homes = [b for b in data['buildings'] if b['population']]
    summary = {key: len(data[key]) for key in collections}
    summary.update({'residentialBuildings': len(homes), 'residents': sum(b['population']['total'] for b in homes),
                    'households': sum(b['population']['households'] for b in homes),
                    'activeEdges': sum(e['active'] for e in data['edges']), 'activeNodes': sum(n['active'] for n in data['nodes']),
                    'baseParkCount': sum(d['kind'] == 'park' and d['active'] for d in data['destinations']),
                    'plannedParkCount': sum(d['kind'] == 'park' and not d['active'] for d in data['destinations'])})
    return {'valid': not errors, 'schemaVersion': data['metadata']['schemaVersion'],
            'contractValidator': 'dependency-free validator for the vocabulary used in the bundled draft-2020-12 schema',
            'errors': errors, 'warnings': warnings, 'checks': dict(sorted(checks.items())), 'summary': summary}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('path', type=Path, nargs='?', default=Path(__file__).resolve().parents[1] / 'data' / 'district.json')
    args = parser.parse_args()
    data = json.loads(args.path.read_text(encoding='utf-8'))
    result = validate(data)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['valid'] else 1)


if __name__ == '__main__':
    main()
