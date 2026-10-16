"""Meaningful regression tests for the district contract and routing semantics."""
import copy
import hashlib
import json
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from build_dataset import build
from dataset_schema import build_schema, typescript_contract
from district_model import adjacency, edge_seconds, materialize, metrics, compare_metrics, shortest_to_targets, line_length
from validate_dataset import validate, schema_errors, polygon_errors


class DistrictTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = build()
        cls.base_metrics = {p['id']: metrics(cls.data, p['id']) for p in cls.data['profiles']}

    def scenario(self, projects=(), budget=8000000, overrides=()):
        return {'projectIds': list(projects), 'budgetRub': budget, 'operationalOverrides': list(overrides)}

    def test_canonical_file_matches_generator(self):
        saved = json.loads((ROOT / 'data/district.json').read_text(encoding='utf-8'))
        self.assertEqual(saved, self.data)
        self.assertEqual(build(), self.data)

    def test_full_dataset_integrity(self):
        report = validate(self.data)
        self.assertEqual(report['errors'], [])
        self.assertTrue(report['valid'])

    def test_schema_rejects_unknown_field_and_incorrect_type(self):
        changed = copy.deepcopy(self.data)
        changed['nodes'][0]['typo'] = True
        changed['edges'][0]['lengthM'] = True
        changed['metadata']['synthetic'] = False
        errors = schema_errors(changed, build_schema())
        self.assertTrue(any('unknown field typo' in e for e in errors))
        self.assertTrue(any('expected number' in e for e in errors))
        self.assertTrue(any('expected constant True' in e for e in errors))

    def test_schema_rejects_empty_upgrade(self):
        changed = copy.deepcopy(self.data)
        changed['projects'][2]['operations'][0]['changes'] = {}
        self.assertTrue(schema_errors(changed, build_schema()))

    def test_schema_boolean_constant_is_not_numeric_one(self):
        changed = copy.deepcopy(self.data)
        changed['metadata']['synthetic'] = 1
        self.assertTrue(schema_errors(changed, build_schema()))

    def test_frontend_types_are_generated_from_current_schema(self):
        self.assertEqual((ROOT / 'data/schema/district.types.ts').read_text(encoding='utf-8'), typescript_contract(build_schema()))

    def test_identical_parcel_geometry_is_rejected(self):
        changed = copy.deepcopy(self.data)
        duplicate = copy.deepcopy(changed['parcels'][0])
        duplicate['id'] = 'duplicate_parcel_geometry'
        changed['parcels'].append(duplicate)
        self.assertTrue(any('Overlapping parcels' in e for e in validate(changed, deep=False)['errors']))

    def test_undeclared_conflicting_project_writes_are_rejected(self):
        changed = copy.deepcopy(self.data)
        for p in changed['projects']:
            if p['id'] in ['p_stop_north', 'p_stop_south']:
                p['exclusiveGroup'] = None
        self.assertTrue(any('Undeclared conflicting project writes' in e for e in validate(changed, deep=False)['errors']))

    def test_missing_reference_is_rejected(self):
        changed = copy.deepcopy(self.data)
        changed['edges'][0]['from'] = 'missing_node'
        report = validate(changed, deep=False)
        self.assertTrue(any('missing endpoint' in e for e in report['errors']))

    def test_geometry_rejects_hidden_road_crossing(self):
        changed = copy.deepcopy(self.data)
        edge = next(e for e in changed['edges'] if e['id'] == 'b00_path_w_cw')
        edge['geometry'].insert(1, [340, 160])
        edge['lengthM'] = line_length(edge['geometry'])
        report = validate(changed, deep=False)
        self.assertTrue(any('unmodelled road crossing' in e for e in report['errors']))

    def test_geometry_rejects_fence_bypass(self):
        changed = copy.deepcopy(self.data)
        edge = copy.deepcopy(changed['edges'][0])
        edge.update({'id': 'illegal_school_shortcut', 'from': 'b11_c', 'to': 'building_b11_nw_entrance', 'kind': 'access'})
        nodes = {n['id']: n for n in changed['nodes']}
        edge['geometry'] = [nodes[edge['from']]['xy'], nodes[edge['to']]['xy']]
        edge['lengthM'] = line_length(edge['geometry'])
        changed['edges'].append(edge)
        report = validate(changed, deep=False)
        self.assertTrue(any('fence crossed outside gate' in e for e in report['errors']))

    def test_geometry_rejects_unconnected_visual_intersection(self):
        changed = copy.deepcopy(self.data)
        edge = copy.deepcopy(changed['edges'][0])
        edge.update({'id': 'unsplit_north_south_path', 'from': 'b01_s', 'to': 'b01_n', 'kind': 'courtyard'})
        nodes = {n['id']: n for n in changed['nodes']}
        edge['geometry'] = [nodes[edge['from']]['xy'], nodes[edge['to']]['xy']]
        edge['lengthM'] = line_length(edge['geometry'])
        changed['edges'].append(edge)
        self.assertTrue(any('Unnoded/overlapping paths' in e for e in validate(changed, deep=False)['errors']))

    def test_invalid_population_is_rejected(self):
        changed = copy.deepcopy(self.data)
        home = next(b for b in changed['buildings'] if b['population'])
        home['population']['total'] += 1
        report = validate(changed, deep=False)
        self.assertTrue(any('inconsistent age groups' in e for e in report['errors']))
        self.assertTrue(any('inconsistent household population' in e for e in report['errors']))

    def test_directed_routes_use_reverse_multisource_graph(self):
        graph = {'a': [('b', 3, 'ab')], 'b': [('c', 4, 'bc')], 'c': [], 'isolated': []}
        distances, steps, destinations = shortest_to_targets(graph, ['c'])
        self.assertEqual(distances, {'c': 0, 'b': 4, 'a': 7})
        self.assertEqual(steps['a'], {'nodeId': 'b', 'edgeId': 'ab'})
        self.assertEqual(destinations['a'], 'c')
        self.assertNotIn('isolated', distances)
        self.assertEqual(shortest_to_targets(graph, ['a'])[0], {'a': 0})

    def test_dijkstra_agrees_with_independent_bellman_ford(self):
        for profile in self.data['profiles']:
            graph = adjacency(self.data, profile['id'])
            targets = [n for d in self.data['destinations'] if d['active'] and d['kind'] == 'park' for n in d['accessNodeIds']]
            expected = {n: 0 if n in targets else math.inf for n in graph}
            for _ in range(len(graph) - 1):
                changed = False
                for source, links in graph.items():
                    for target, cost, _ in links:
                        if expected[target] + cost < expected[source] - 1e-9:
                            expected[source] = expected[target] + cost
                            changed = True
                if not changed:
                    break
            actual, _, _ = shortest_to_targets(graph, targets)
            for node in graph:
                self.assertAlmostEqual(actual[node], expected[node], places=7)

    def test_wait_time_surface_and_accessibility_rules(self):
        edge = copy.deepcopy(next(e for e in self.data['edges'] if e['crossing'] and e['crossing']['kerbRamps']))
        profile = next(p for p in self.data['profiles'] if p['id'] == 'step_free')
        edge.update({'lengthM': 85, 'surface': 'asphalt', 'stairs': False, 'widthM': 2, 'slope': .05})
        edge['crossing']['waitSeconds'] = 12
        self.assertAlmostEqual(edge_seconds(edge, profile), 112)
        for changes in [{'stairs': True}, {'widthM': 1.49}, {'slope': .0501}]:
            altered = {**edge, **changes}
            self.assertIsNone(edge_seconds(altered, profile))
        edge['crossing']['kerbRamps'] = False
        self.assertIsNone(edge_seconds(edge, profile))

    def test_mean_is_weighted_by_population_and_threshold_is_inclusive(self):
        for pid, result in self.base_metrics.items():
            for kind, stats in result['destinations'].items():
                seconds = [(b['residents'], b['destinations'][kind]['travelSeconds']) for b in result['perBuilding']]
                expected = sum(pop * value for pop, value in seconds) / sum(pop for pop, _ in seconds)
                self.assertAlmostEqual(stats['meanSecondsReachableOnly'], expected, delta=.001)
                self.assertEqual(stats['withinThresholdResidents'], sum(pop for pop, value in seconds if value <= stats['thresholdSeconds']))
        # Exact threshold is based on unrounded route time.
        changed = copy.deepcopy(self.data)
        home = next(b for b in changed['buildings'] if b['population'])
        target = next(d for d in changed['destinations'] if d['kind'] == 'bus_stop')
        target['accessNodeIds'] = home['entranceNodeIds']
        changed['metricDefinitions']['thresholdSeconds']['bus_stop'] = 0
        result = metrics(changed, 'walk')
        entry = next(b for b in result['perBuilding'] if b['buildingId'] == home['id'])
        self.assertTrue(entry['destinations']['bus_stop']['withinThreshold'])

    def test_unreachable_residents_stay_in_denominator_and_use_null(self):
        home = next(b for b in self.data['buildings'] if b['population'])
        entrances = set(home['entranceNodeIds'])
        ids = [e['id'] for e in self.data['edges'] if e['from'] in entrances or e['to'] in entrances]
        isolated, _ = materialize(self.data, self.scenario(overrides=[{'op': 'set_edge_active', 'targetId': e, 'value': False} for e in ids]))
        result = metrics(isolated, 'walk')
        entry = next(b for b in result['perBuilding'] if b['buildingId'] == home['id'])
        for kind, stats in result['destinations'].items():
            self.assertEqual(stats['unreachableResidents'], home['population']['total'])
            self.assertIsNone(entry['destinations'][kind]['travelSeconds'])
            self.assertEqual(stats['reachableResidents'] + stats['unreachableResidents'], result['evaluatedPopulation'])
        json.dumps(result, allow_nan=False)

    def test_no_destinations_returns_null_mean_and_zero_coverage(self):
        changed = copy.deepcopy(self.data)
        for d in changed['destinations']:
            if d['kind'] == 'park':
                d['active'] = False
        stats = metrics(changed, 'walk')['destinations']['park']
        self.assertIsNone(stats['meanSecondsReachableOnly'])
        self.assertEqual(stats['coveragePercent'], 0)
        self.assertEqual(stats['unreachableResidents'], self.base_metrics['walk']['evaluatedPopulation'])

    def test_project_conflicts_dependencies_order_and_budget(self):
        for selected, budget in [(['p_stop_north', 'p_stop_south'], 8000000),
                                  (['p_park_paving'], 8000000), (['p_park_b10'], 1000000),
                                  (['p_park_b10', 'p_park_b10'], 8000000),
                                  (['p_park_paving', 'p_park_b10'], 8000000)]:
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                materialize(self.data, self.scenario(selected, budget))

    def test_scenario_does_not_mutate_base_and_resets_exactly(self):
        snapshot = copy.deepcopy(self.data)
        materialize(self.data, self.scenario(['p_park_b10', 'p_park_paving', 'p_kerbs']))
        self.assertEqual(self.data, snapshot)
        reset, costs = materialize(self.data, self.scenario())
        self.assertEqual(reset, self.data)
        self.assertEqual(costs['capexRub'], 0)

    def test_park_creation_updates_land_use_and_population_is_preserved(self):
        changed, _ = materialize(self.data, self.scenario(['p_park_b10']))
        parcel = next(p for p in changed['parcels'] if p['id'] == 'parcel_b10_ne')
        self.assertEqual(parcel['kind'], 'public_park')
        result = metrics(changed, 'walk')
        self.assertAlmostEqual(result['publicParkAreaM2'] - self.base_metrics['walk']['publicParkAreaM2'], parcel['areaM2'])
        self.assertEqual(result['evaluatedPopulation'], self.base_metrics['walk']['evaluatedPopulation'])

    def test_crossing_addition_cannot_worsen_walk_time(self):
        changed, _ = materialize(self.data, self.scenario(['p_cross_central']))
        for profile in self.data['profiles']:
            result = compare_metrics(self.base_metrics[profile['id']], metrics(changed, profile['id']))
            self.assertTrue(all(v['worsenedResidents'] == 0 for v in result.values()))
        self.assertGreater(compare_metrics(self.base_metrics['walk'], metrics(changed, 'walk'))['park']['improvedResidents'], 0)

    def test_relocation_has_both_winners_and_losers(self):
        changed, _ = materialize(self.data, self.scenario(['p_stop_north']))
        result = compare_metrics(self.base_metrics['walk'], metrics(changed, 'walk'))['bus_stop']
        self.assertGreater(result['improvedResidents'], 0)
        self.assertGreater(result['worsenedResidents'], 0)
        self.assertEqual(sum(result[k] for k in ['improvedResidents', 'worsenedResidents', 'unchangedResidents']), self.base_metrics['walk']['evaluatedPopulation'])

    def test_ramp_has_effect_for_step_free_and_not_ordinary_walk(self):
        changed, _ = materialize(self.data, self.scenario(['p_ramp']))
        free = compare_metrics(self.base_metrics['step_free'], metrics(changed, 'step_free'))
        ordinary = compare_metrics(self.base_metrics['walk'], metrics(changed, 'walk'))
        self.assertTrue(any(s['improvedResidents'] > 0 for s in free.values()))
        self.assertTrue(all(s['improvedResidents'] == s['worsenedResidents'] == 0 for s in ordinary.values()))

    def test_geojson_coordinate_order_and_polygon_orientation(self):
        for path in (ROOT / 'data/geojson').glob('*.geojson'):
            fc = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(fc['type'], 'FeatureCollection')
            self.assertEqual(len({f['id'] for f in fc['features']}), len(fc['features']))
            for feature in fc['features']:
                geometry = feature['geometry']
                coords = geometry['coordinates']
                if geometry['type'] == 'Polygon':
                    self.assertEqual(coords[0][0], coords[0][-1])
                    signed_area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(coords[0], coords[0][1:])) / 2
                    self.assertGreater(signed_area, 0)
                    points = coords[0]
                else:
                    points = [coords] if geometry['type'] == 'Point' else coords
                for lon, lat in points:
                    self.assertTrue(36 < lon < 37 and 55 < lat < 56)

    def test_manifest_hashes_match(self):
        manifest = json.loads((ROOT / 'data/manifest.json').read_text(encoding='utf-8'))
        for item in manifest['files']:
            path = ROOT / 'data' / item['path']
            self.assertTrue(path.is_file())
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item['sha256'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
