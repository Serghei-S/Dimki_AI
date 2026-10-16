"""The machine-readable, closed JSON Schema contract (draft 2020-12)."""


def obj(properties, required=None):
    return {'type': 'object', 'properties': properties, 'required': list(properties) if required is None else required, 'additionalProperties': False}


def arr(items, minimum=0, unique=False):
    result = {'type': 'array', 'items': items, 'minItems': minimum}
    if unique:
        result['uniqueItems'] = True
    return result


def enum(*values):
    return {'enum': list(values)}


def num(minimum=None, maximum=None, integer=False):
    result = {'type': 'integer' if integer else 'number'}
    if minimum is not None:
        result['minimum'] = minimum
    if maximum is not None:
        result['maximum'] = maximum
    return result


def nullable(schema):
    return {'anyOf': [schema, {'type': 'null'}]}


def build_schema():
    text = {'type': 'string', 'minLength': 1}
    identifier = {'type': 'string', 'pattern': '^[a-z][a-z0-9_-]*$'}
    flag = {'type': 'boolean'}
    point = {**arr(num(), 2), 'maxItems': 2}
    ring = arr(point, 4)
    ref = lambda name: {'$ref': f'#/$defs/{name}'}
    ids = arr(identifier, unique=True)
    surface = enum('asphalt', 'paving', 'compacted_gravel')
    ages = obj({'under18': num(0, integer=True), 'age18to64': num(0, integer=True), 'age65plus': num(0, integer=True)})
    defs = {}
    defs['population'] = obj({'total': num(1, integer=True), 'ageGroups': ages,
                              'mobilityNeedsResidents': num(0, integer=True), 'households': num(1, integer=True),
                              'householdSizeCounts': obj({str(i): num(0, integer=True) for i in range(1, 6)}),
                              'apartments': num(1, integer=True), 'occupiedApartments': num(1, integer=True)})
    defs['node'] = obj({'id': identifier, 'xy': point, 'kind': enum('junction', 'sidewalk', 'park_entrance', 'building_entrance', 'gate'),
                        'active': flag, 'blockId': nullable(identifier)})
    defs['crossing'] = obj({'roadId': identifier, 'control': enum('signalized', 'zebra'),
                            'waitSeconds': num(0, 300), 'kerbRamps': flag, 'tactilePaving': flag})
    defs['edge'] = obj({'id': identifier, 'from': identifier, 'to': identifier, 'geometry': arr(point, 2),
                        'lengthM': num(.001), 'kind': enum('sidewalk', 'courtyard', 'crossing', 'access', 'park_path'),
                        'active': flag, 'bidirectional': flag, 'surface': surface, 'widthM': num(.1, 20),
                        'slope': num(-1, 1), 'stairs': flag, 'crossing': nullable(ref('crossing'))})
    defs['road'] = obj({'id': identifier, 'name': text, 'axis': enum('vertical', 'horizontal'), 'centerM': num(),
                        'widthM': num(1), 'polygon': ring, 'speedLimitKmh': num(5, 130, True), 'lanes': num(1, 12, True)})
    defs['block'] = obj({'id': identifier, 'name': text, 'polygon': ring, 'landUse': enum('residential', 'mixed', 'park')})
    defs['parcel'] = obj({'id': identifier, 'blockId': identifier, 'kind': enum('public_park', 'vacant', 'school', 'residential', 'public_service'),
                          'name': text, 'polygon': ring, 'areaM2': num(.1), 'active': flag,
                          'fence': nullable(obj({'gateNodeIds': arr(identifier, 1, True), 'publicThroughAccess': flag}))})
    defs['building'] = obj({'id': identifier, 'name': text, 'kind': enum('residential', 'school', 'clinic', 'grocery', 'community'),
                            'blockId': identifier, 'parcelId': identifier, 'polygon': ring, 'footprintAreaM2': num(1),
                            'floors': num(1, 50, True), 'heightM': num(1, 200), 'entranceNodeIds': arr(identifier, 1, True),
                            'population': nullable(ref('population'))})
    defs['destination'] = obj({'id': identifier, 'name': text, 'kind': enum('bus_stop', 'park', 'school', 'clinic', 'grocery', 'community'),
                               'active': flag, 'accessNodeIds': arr(identifier, 1, True), 'parcelId': nullable(identifier),
                               'buildingId': nullable(identifier), 'stopBayId': nullable(identifier), 'capacity': nullable(num(1, integer=True)),
                               'openingHours': text, 'routeIds': ids})
    defs['stopBay'] = obj({'id': identifier, 'nodeId': identifier, 'roadId': identifier, 'side': enum('west', 'east', 'north', 'south'),
                           'routeIds': arr(identifier, 1, True), 'name': text, 'stepFreeBoardingAssumed': flag})
    defs['transitService'] = obj({'id': identifier, 'name': text, 'mode': {'const': 'bus'},
                                  'routeGeometryModelled': {'const': False}, 'description': text})
    operations = []
    for name in ['set_node_active', 'set_edge_active', 'set_destination_active']:
        operations.append(obj({'op': {'const': name}, 'targetId': identifier, 'value': flag}))
    operations.append(obj({'op': {'const': 'relocate_destination'}, 'targetId': identifier, 'nodeId': identifier, 'stopBayId': identifier}))
    operations.append(obj({'op': {'const': 'set_parcel_use'}, 'targetId': identifier, 'kind': enum('public_park')}))
    changes = obj({'surface': surface, 'stairs': flag, 'slope': num(-1, 1), 'widthM': num(.1, 20), 'kerbRamps': flag}, required=[])
    changes['minProperties'] = 1
    operations.append(obj({'op': {'const': 'upgrade_edge'}, 'targetId': identifier, 'changes': changes}))
    defs['operation'] = {'oneOf': operations}
    defs['project'] = obj({'id': identifier, 'name': text,
                           'kind': enum('new_crossing', 'accessibility', 'open_passage', 'new_park', 'relocate_stop'),
                           'description': text, 'cost': obj({'capexRub': num(0, integer=True), 'annualOpexRub': num(0, integer=True),
                                                            'isSynthetic': {'const': True}, 'priceYear': num(2020, 2100, True)}),
                           'requires': ids, 'excludes': ids, 'exclusiveGroup': nullable(identifier), 'parcelId': nullable(identifier),
                           'operations': arr(ref('operation'), 1)})
    defs['scenario'] = obj({'id': identifier, 'name': text, 'description': text, 'projectIds': ids,
                            'budgetRub': num(0, integer=True), 'operationalOverrides': arr(ref('operation'))})
    defs['profile'] = obj({'id': identifier, 'name': text, 'speedMps': num(.1, 3), 'allowStairs': flag,
                           'maxSlope': num(0, 1), 'minWidthM': num(.1), 'requiresKerbRamps': flag,
                           'surfaceSpeedFactors': obj({s: num(.01, 1) for s in ['asphalt', 'paving', 'compacted_gravel']}), 'description': text})
    metadata = obj({'id': identifier, 'name': text, 'description': text, 'schemaVersion': {'const': '1.0.0'},
                    'datasetVersion': {'type': 'string', 'pattern': '^\\d+\\.\\d+\\.\\d+$'}, 'seed': num(0, integer=True),
                    'generatedForDate': {'type': 'string', 'pattern': '^\\d{4}-\\d{2}-\\d{2}$'}, 'synthetic': {'const': True},
                    'source': text, 'license': {'const': 'UNLICENSED'},
                    'coordinateSystem': obj({'id': {'const': 'LOCAL_METERS'}, 'axes': {'const': ['east', 'north']}, 'units': {'const': 'm'},
                                             'displayOriginWgs84': point, 'earthRadiusM': num(6000000, 7000000),
                                             'displayTransform': text, 'accuracy': text}),
                    'boundsM': {**arr(num(), 4), 'maxItems': 4}, 'limitations': arr(text, 1)})
    metric_defs = obj({'thresholdSeconds': obj({k: num(1) for k in ['bus_stop', 'park', 'school', 'clinic', 'grocery']}),
                       'distanceUnit': {'const': 'm'}, 'timeUnit': {'const': 's'}, 'costUnit': {'const': 'RUB'},
                       'costPriceYear': num(2020, 2100, True), 'costsAreSynthetic': {'const': True},
                       'edgeTimeRule': text, 'aggregationRule': text, 'coverageRule': text, 'comparisonEpsilonSeconds': num(0)})
    root = obj({'$schema': text, 'metadata': metadata, 'metricDefinitions': metric_defs,
                **{plural: arr(ref(singular), 1) for plural, singular in [
                    ('profiles', 'profile'), ('roads', 'road'), ('blocks', 'block'), ('parcels', 'parcel'),
                    ('buildings', 'building'), ('nodes', 'node'), ('edges', 'edge'), ('destinations', 'destination'),
                    ('stopBays', 'stopBay'), ('transitServices', 'transitService'), ('projects', 'project'), ('scenarios', 'scenario')]}})
    return {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'urn:obninsk2040:district:1.0.0',
            'title': 'Fictional district data contract v1', **root, '$defs': defs}


def typescript_contract(schema):
    """Generate frontend types from the same schema; runtime constraints stay in JSON Schema."""
    import json
    def typename(name):
        return name[0].upper() + name[1:]
    def emit(rule, level=0):
        if '$ref' in rule:
            return typename(rule['$ref'].split('/')[-1])
        if 'const' in rule:
            return json.dumps(rule['const'], ensure_ascii=False)
        if 'enum' in rule:
            return ' | '.join(json.dumps(v, ensure_ascii=False) for v in rule['enum'])
        for key in ['oneOf', 'anyOf']:
            if key in rule:
                return ' | '.join(emit(branch, level) for branch in rule[key])
        kind = rule.get('type')
        if kind == 'object':
            lines = []
            for name, value in rule['properties'].items():
                optional = '' if name in rule.get('required', []) else '?'
                lines.append('  ' * (level + 1) + json.dumps(name) + optional + ': ' + emit(value, level + 1) + ';')
            return '{\n' + '\n'.join(lines) + '\n' + '  ' * level + '}'
        if kind == 'array':
            item = emit(rule['items'], level)
            if rule.get('minItems') == rule.get('maxItems') and 'maxItems' in rule:
                return '[' + ', '.join([item] * rule['maxItems']) + ']'
            return '(' + item + ')[]'
        return {'number': 'number', 'integer': 'number', 'boolean': 'boolean', 'string': 'string', 'null': 'null'}[kind]
    sections = ['// Generated by tools/build_dataset.py. Do not edit manually.',
                '// Structural types only; IDs, ranges and geometry require runtime validation.',
                'export type DistrictData = ' + emit(schema) + ';']
    sections += ['export type ' + typename(name) + ' = ' + emit(rule) + ';' for name, rule in schema['$defs'].items()]
    return '\n\n'.join(sections) + '\n'
