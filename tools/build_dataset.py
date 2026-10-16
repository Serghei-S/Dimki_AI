"""Build the fictional Obninsk district deterministically, using only stdlib."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from district_model import rectangle, polygon_area, line_length, to_wgs84, materialize, metrics, compare_metrics
from dataset_schema import build_schema, typescript_contract

ROOT = Path(__file__).resolve().parents[1]
SEED = 20402026


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8', newline='\n')


def rng_for(identifier):
    digest = hashlib.sha256(f'{SEED}:{identifier}'.encode()).digest()
    return random.Random(int.from_bytes(digest[:8], 'big'))


def population_for(identifier, floors):
    rng = rng_for(identifier)
    apartments = floors * rng.choice([12, 14, 16])
    occupied = round(apartments * rng.uniform(.88, .98))
    sizes = [rng.choices([1, 2, 3, 4, 5], [.18, .34, .28, .16, .04])[0] for _ in range(occupied)]
    total = sum(sizes)
    children = round(total * rng.uniform(.15, .23))
    older = round(total * rng.uniform(.17, .28))
    return {'total': total, 'ageGroups': {'under18': children, 'age18to64': total - children - older, 'age65plus': older},
            'mobilityNeedsResidents': max(1, round(total * rng.uniform(.02, .045))),
            'households': occupied, 'householdSizeCounts': {str(n): sizes.count(n) for n in range(1, 6)},
            'apartments': apartments, 'occupiedApartments': occupied}


def build():
    data = {
        '$schema': './schema/district.schema.json',
        'metadata': {
            'id': 'obninsk-fictional-district-01', 'name': 'Обнинск 2040 — учебный район «Сосновый»',
            'description': 'Полностью вымышленный район для проверки городских решений. Не воспроизводит существующие улицы, жителей и объекты Обнинска.',
            'schemaVersion': '1.0.0', 'datasetVersion': '1.0.0', 'seed': SEED, 'generatedForDate': '2026-10-16',
            'synthetic': True, 'source': 'Procedural generation; no external geographic or personal datasets.',
            'license': 'UNLICENSED',
            'coordinateSystem': {'id': 'LOCAL_METERS', 'axes': ['east', 'north'], 'units': 'm',
                                 'displayOriginWgs84': [36.60, 55.10], 'earthRadiusM': 6371008.8,
                                 'displayTransform': 'lon=lon0+degrees(x/(R*cos(lat0))); lat=lat0+degrees(y/R)',
                                 'accuracy': 'Approximate WGS84 display placement only; all calculations use local metres.'},
            'boundsM': [-28, -28, 1308, 988],
            'limitations': [
                'All geometry, population, costs, capacities and crossing waits are synthetic assumptions.',
                'Only pedestrian access is modelled; bus routes, traffic, queues and service capacity allocation are not simulated.',
                'Profiles are comparison assumptions, not certification of accessible routes.',
                'Only geometric road barriers and explicitly represented fences are checked; no terrain or legal feasibility model.',
                'Park area is public parcel area including paths; it is not tree canopy, cooling or ecological impact.',
                'Each profile evaluates the same population hypothetically; profile populations overlap and must not be summed.',
                'Walking calculations assume destinations are open; opening-hour strings are descriptive only.'
            ]},
        'metricDefinitions': {'thresholdSeconds': {'bus_stop': 420, 'park': 600, 'school': 900, 'clinic': 900, 'grocery': 600},
                              'distanceUnit': 'm', 'timeUnit': 's', 'costUnit': 'RUB',
                              'costPriceYear': 2026, 'costsAreSynthetic': True,
                              'edgeTimeRule': 'lengthM / (profile.speedMps * surfaceSpeedFactors[surface]) + crossing.waitSeconds; exclude ineligible edges.',
                              'aggregationRule': 'Use minimum entrance-to-access-node travel time per building; population-weighted mean over reachable residents ONLY; always show unreachable count.',
                              'coverageRule': 'All residents of a building count when its fastest entrance reaches any open destination of a kind within thresholdSeconds (inclusive).',
                              'comparisonEpsilonSeconds': .01},
        'profiles': [
            {'id': 'walk', 'name': 'Пешеход', 'speedMps': 1.25, 'allowStairs': True, 'maxSlope': .20,
             'minWidthM': .8, 'requiresKerbRamps': False,
             'surfaceSpeedFactors': {'asphalt': 1.0, 'paving': .95, 'compacted_gravel': .85},
             'description': 'Условный взрослый пешеход; постоянная скорость, без толпы и погоды.'},
            {'id': 'step_free', 'name': 'Без ступеней', 'speedMps': .85, 'allowStairs': False, 'maxSlope': .05,
             'minWidthM': 1.5, 'requiresKerbRamps': True,
             'surfaceSpeedFactors': {'asphalt': 1.0, 'paving': .9, 'compacted_gravel': .6},
             'description': 'Условный профиль коляски: исключает ступени, узкие участки, крутые уклоны и переходы без понижения бордюра.'},
            {'id': 'slow_walk', 'name': 'Медленный пешеход', 'speedMps': .8, 'allowStairs': True, 'maxSlope': .12,
             'minWidthM': .9, 'requiresKerbRamps': False,
             'surfaceSpeedFactors': {'asphalt': 1.0, 'paving': .9, 'compacted_gravel': .75},
             'description': 'Сценарий более медленной ходьбы; не привязан автоматически ко всем пожилым жителям.'}],
        'roads': [], 'blocks': [], 'parcels': [], 'buildings': [], 'nodes': [], 'edges': [],
        'destinations': [], 'stopBays': [], 'projects': [], 'scenarios': [],
        'transitServices': [{'id': 'bus_a', 'name': 'Условная автобусная линия А', 'mode': 'bus',
                             'routeGeometryModelled': False, 'description': 'Только группа совместимости остановок; движение, расписание и посадка не рассчитываются.'}]}
    nodes = {}

    def node(identifier, xy, kind='junction', active=True, block=None):
        if identifier in nodes:
            raise ValueError(f'Duplicate node {identifier}')
        record = {'id': identifier, 'xy': list(xy), 'kind': kind, 'active': active, 'blockId': block}
        data['nodes'].append(record)
        nodes[identifier] = record
        return identifier

    def edge(identifier, source, target, kind='courtyard', active=True, stairs=False, surface='asphalt', crossing=None, slope=.015, width=2.0):
        geometry = [nodes[source]['xy'], nodes[target]['xy']]
        record = {'id': identifier, 'from': source, 'to': target, 'geometry': geometry,
                  'lengthM': round(line_length(geometry), 6), 'kind': kind, 'active': active,
                  'bidirectional': True, 'surface': surface, 'widthM': width, 'slope': slope,
                  'stairs': stairs, 'crossing': crossing}
        data['edges'].append(record)
        return identifier

    def parcel(identifier, block_id, kind, ring, name, active=True, fence=None):
        data['parcels'].append({'id': identifier, 'blockId': block_id, 'kind': kind, 'name': name,
                                'polygon': ring, 'areaM2': polygon_area(ring), 'active': active,
                                'fence': fence})

    def destination(identifier, name, kind, access, parcel_id=None, building_id=None, active=True, stop_bay=None, capacity=None):
        data['destinations'].append({'id': identifier, 'name': name, 'kind': kind, 'active': active,
                                     'accessNodeIds': access, 'parcelId': parcel_id, 'buildingId': building_id,
                                     'stopBayId': stop_bay, 'capacity': capacity,
                                     'openingHours': '24/7' if kind in ['park', 'bus_stop'] else '08:00-20:00 (model assumes open)',
                                     'routeIds': ['bus_a'] if kind == 'bus_stop' else []})

    widths_v = [24, 20, 30, 20, 24]
    widths_h = [24, 20, 24, 24]
    for i, width in enumerate(widths_v):
        x = i * 320
        data['roads'].append({'id': f'road_v{i}', 'name': f'Условная улица {i + 1}',
                              'axis': 'vertical', 'centerM': x, 'widthM': width,
                              'polygon': rectangle(x - width / 2, -28, x + width / 2, 988),
                              'speedLimitKmh': 40 if i == 2 else 30, 'lanes': 4 if i == 2 else 2})
    for i, width in enumerate(widths_h):
        y = i * 320
        data['roads'].append({'id': f'road_h{i}', 'name': f'Условный проезд {i + 1}',
                              'axis': 'horizontal', 'centerM': y, 'widthM': width,
                              'polygon': rectangle(-28, y - width / 2, 1308, y + width / 2),
                              'speedLimitKmh': 30, 'lanes': 2})

    # Explicit land-use decisions prevent hidden demolition or building/park overlaps.
    special = {
        ('b01', 'sw'): 'grocery', ('b02', 'nw'): 'park', ('b10', 'ne'): 'planned_park',
        ('b11', 'nw'): 'school', ('b12', 'se'): 'clinic',
        ('b21', 'sw'): 'grocery', ('b21', 'nw'): 'community',
        ('b22', 'ne'): 'planned_park', ('b23', 'nw'): 'school'}
    home_number = 0
    for row in range(3):
        for col in range(4):
            bid = f'b{row}{col}'
            x, y = col * 320, row * 320
            left, right = x + widths_v[col] / 2 + 4, x + 320 - widths_v[col + 1] / 2 - 4
            bottom, top = y + widths_h[row] / 2 + 4, y + 320 - widths_h[row + 1] / 2 - 4
            cx, cy = x + 160, y + 160
            main_park = bid == 'b13'
            data['blocks'].append({'id': bid, 'name': f'Квартал {row + 1}.{col + 1}',
                                   'polygon': rectangle(left, bottom, right, top),
                                   'landUse': 'park' if main_park else 'mixed' if bid in ['b01', 'b11', 'b12', 'b21', 'b23'] else 'residential'})
            perimeter = [('sw', [left, bottom]), ('s', [cx, bottom]), ('se', [right, bottom]),
                         ('e', [right, cy]), ('ne', [right, top]), ('n', [cx, top]),
                         ('nw', [left, top]), ('w', [left, cy])]
            for suffix, xy in perimeter:
                node(f'{bid}_{suffix}', xy, 'sidewalk', block=bid)
            for i in range(8):
                edge(f'{bid}_sidewalk_{i}', f'{bid}_{perimeter[i][0]}', f'{bid}_{perimeter[(i + 1) % 8][0]}', 'sidewalk', width=3.0)
            for suffix, xx in [('cw', x + 85), ('c', cx), ('ce', x + 235)]:
                node(f'{bid}_{suffix}', [xx, cy], 'junction', block=bid)
            if main_park:
                park_id = f'parcel_{bid}_park'
                parcel(park_id, bid, 'public_park', rectangle(x + 42, y + 42, x + 278, y + 278), 'Сосновый парк')
                for suffix, xy in [('gate_w', [x + 42, cy]), ('gate_e', [x + 278, cy]),
                                   ('gate_s', [cx, y + 42]), ('gate_n', [cx, y + 278])]:
                    node(f'{bid}_{suffix}', xy, 'park_entrance', block=bid)
                horizontal = ['w', 'gate_w', 'cw', 'c', 'ce', 'gate_e', 'e']
                for a, b in zip(horizontal, horizontal[1:]):
                    edge(f'{bid}_path_{a}_{b}', f'{bid}_{a}', f'{bid}_{b}', 'park_path' if a != 'w' and b != 'e' else 'access')
                # Interior recreational loop; access still occurs at explicit parcel gates.
                for suffix, xy in [('loop_sw', [x + 85, y + 85]), ('loop_se', [x + 235, y + 85]),
                                   ('loop_ne', [x + 235, y + 235]), ('loop_nw', [x + 85, y + 235]),
                                   ('loop_s', [cx, y + 85]), ('loop_n', [cx, y + 235])]:
                    node(f'{bid}_{suffix}', xy, block=bid)
                for side in ['n', 's']:
                    edge(f'{bid}_access_{side}', f'{bid}_{side}', f'{bid}_gate_{side}', 'access')
                    edge(f'{bid}_park_{side}_outer', f'{bid}_gate_{side}', f'{bid}_loop_{side}', 'park_path')
                    edge(f'{bid}_park_{side}_inner', f'{bid}_loop_{side}', f'{bid}_c', 'park_path')
                loop = ['loop_sw', 'loop_s', 'loop_se', 'ce', 'loop_ne', 'loop_n', 'loop_nw', 'cw', 'loop_sw']
                for a, b in zip(loop, loop[1:]):
                    edge(f'{bid}_{a}_{b}', f'{bid}_{a}', f'{bid}_{b}', 'park_path', surface='compacted_gravel')
                destination('park_main', 'Сосновый парк', 'park', [f'{bid}_gate_{s}' for s in ['w', 'e', 's', 'n']], park_id)
                continue
            for a, b in zip(['w', 'cw', 'c', 'ce'], ['cw', 'c', 'ce', 'e']):
                edge(f'{bid}_path_{a}_{b}', f'{bid}_{a}', f'{bid}_{b}')
            for side in ['n', 's']:
                edge(f'{bid}_arm_{side}', f'{bid}_c', f'{bid}_{side}', active=not (side == 'n' and bid in ['b10', 'b02']),
                     stairs=(bid == 'b03' and side == 'n'), surface='paving', slope=.03)
            for quadrant in ['sw', 'se', 'nw', 'ne']:
                west, south = quadrant.endswith('w'), quadrant.startswith('s')
                bx, by = x + (85 if west else 235), y + (85 if south else 235)
                kind = special.get((bid, quadrant), 'residential')
                target = f'{bid}_c{"w" if west else "e"}'
                pid = f'parcel_{bid}_{quadrant}'
                if kind in ['park', 'planned_park']:
                    active = kind == 'park'
                    ring = rectangle(bx - 43, by - 43, bx + 43, by + 43)
                    parcel(pid, bid, 'public_park' if active else 'vacant', ring,
                           'Сквер у дома' if active else 'Свободный участок для сквера')
                    gate = node(f'{bid}_{quadrant}_park_gate', [bx, by - 43], 'park_entrance', active, bid)
                    edge(f'{bid}_{quadrant}_park_access', target, gate, 'access', active, surface='compacted_gravel')
                    destination(f'park_{bid}', f'Сквер {row + 1}.{col + 1}', 'park', [gate], pid, active=active)
                    continue
                building_id = f'building_{bid}_{quadrant}'
                half_width, half_depth = (30, 12) if kind == 'residential' else (36, 27)
                ring = rectangle(bx - half_width, by - half_depth, bx + half_width, by + half_depth)
                entrance_xy = [bx, by + half_depth if south else by - half_depth]
                entrance = node(f'{building_id}_entrance', entrance_xy, 'building_entrance', block=bid)
                fenced = kind == 'school'
                gate_id = None
                if fenced:
                    gate_id = node(f'{building_id}_gate', [bx, by - 43], 'gate', block=bid)
                    parcel(pid, bid, 'school', rectangle(bx - 49, by - 43, bx + 49, by + 49),
                           'Ограждённый школьный участок', fence={'gateNodeIds': [gate_id], 'publicThroughAccess': False})
                    edge(f'{building_id}_access_outside', target, gate_id, 'access')
                    edge(f'{building_id}_access_inside', gate_id, entrance, 'access')
                else:
                    parcel(pid, bid, 'residential' if kind == 'residential' else 'public_service',
                           rectangle(bx - 43, by - 37, bx + 43, by + 37), 'Жилой участок' if kind == 'residential' else 'Общественный объект')
                    edge(f'{building_id}_access', target, entrance, 'access')
                rng = rng_for(building_id)
                floors = rng.choice([5, 7, 9]) if kind == 'residential' else 3 if kind == 'school' else 2
                population = population_for(building_id, floors) if kind == 'residential' else None
                if population:
                    home_number += 1
                name = f'Жилой дом {home_number:02d}' if population else {'grocery': 'Продуктовый магазин', 'school': 'Школа', 'clinic': 'Поликлиника', 'community': 'Районный центр'}[kind]
                data['buildings'].append({'id': building_id, 'name': name, 'kind': kind, 'blockId': bid,
                                           'parcelId': pid, 'polygon': ring, 'footprintAreaM2': polygon_area(ring),
                                           'floors': floors, 'heightM': floors * 3.2, 'entranceNodeIds': [entrance],
                                           'population': population})
                if kind != 'residential':
                    # Community is an amenity, not part of the five primary accessibility metrics.
                    destination(f'dest_{bid}_{quadrant}', name + f' {row + 1}.{col + 1}', kind, [entrance], pid, building_id,
                                capacity=650 if kind == 'school' else None)

    crossing_ids = {}
    for row in range(3):
        for col in range(3):
            for end, suffix in [('s', 'se'), ('n', 'ne')]:
                source, target = f'b{row}{col}_{suffix}', f'b{row}{col + 1}_{"sw" if end == "s" else "nw"}'
                identifier = f'cross_v{col + 1}_r{row}_{end}'
                active = identifier not in ['cross_v2_r0_n', 'cross_v2_r1_s']
                ramps = identifier not in ['cross_v2_r0_s', 'cross_v2_r1_n']
                road_id = f'road_v{col + 1}'
                edge(identifier, source, target, 'crossing', active, slope=.01, width=3.0,
                     crossing={'roadId': road_id, 'control': 'signalized' if col == 1 else 'zebra',
                               'waitSeconds': 35 if col == 1 else 8, 'kerbRamps': ramps, 'tactilePaving': ramps})
                crossing_ids[identifier] = identifier
    for row in range(2):
        for col in range(4):
            for end, suffix in [('w', 'nw'), ('e', 'ne')]:
                edge(f'cross_h{row + 1}_c{col}_{end}', f'b{row}{col}_{suffix}', f'b{row + 1}{col}_{"sw" if end == "w" else "se"}',
                     'crossing', width=3.0, slope=.01,
                     crossing={'roadId': f'road_h{row + 1}', 'control': 'zebra', 'waitSeconds': 8,
                               'kerbRamps': True, 'tactilePaving': True})

    # Mid-block crossings make courtyard links useful and avoid an artificial
    # network in which every north/south courtyard arm is a pointless detour.
    for row in range(2):
        for col in range(4):
            edge(f'cross_h{row + 1}_c{col}_mid', f'b{row}{col}_n', f'b{row + 1}{col}_s', 'crossing',
                 width=3.0, slope=.01, crossing={'roadId': f'road_h{row + 1}', 'control': 'zebra',
                 'waitSeconds': 8, 'kerbRamps': True, 'tactilePaving': True})
    for row in range(3):
        for road in [1, 3] + ([2] if row == 2 else []):
            edge(f'cross_v{road}_r{row}_mid', f'b{row}{road - 1}_e', f'b{row}{road}_w', 'crossing',
                 width=3.0, slope=.01, crossing={'roadId': f'road_v{road}', 'control': 'signalized' if road == 2 else 'zebra',
                 'waitSeconds': 35 if road == 2 else 8, 'kerbRamps': True, 'tactilePaving': True})

    bay_specs = [('b00', 'e'), ('b10', 'e'), ('b20', 'e'),
                 ('b01', 'e'), ('b11', 'e'), ('b21', 'e'),
                 ('b02', 'w'), ('b12', 'w'), ('b22', 'w'),
                 ('b03', 'w'), ('b13', 'w'), ('b23', 'w')]
    for block, side in bay_specs:
        road_number = int(block[2]) + (1 if side == 'e' else 0)
        data['stopBays'].append({'id': f'bay_{block}_{side}', 'nodeId': f'{block}_{side}',
                                 'roadId': f'road_v{road_number}', 'side': 'west' if side == 'e' else 'east',
                                 'routeIds': ['bus_a'], 'name': f'Допустимое место остановки {block} {side}',
                                 'stepFreeBoardingAssumed': True})
    for identifier, block, side, name in [('stop_west', 'b00', 'e', 'Западная'), ('stop_central_w', 'b11', 'e', 'Центральная запад'),
                                           ('stop_central_e', 'b12', 'w', 'Центральная восток'), ('stop_east', 'b23', 'w', 'Восточная')]:
        destination(identifier, name, 'bus_stop', [f'{block}_{side}'], stop_bay=f'bay_{block}_{side}')

    def operation(op, target, **kwargs):
        return {'op': op, 'targetId': target, **kwargs}

    def project(identifier, name, kind, cost, operations, requires=None, group=None, parcel_id=None, description=''):
        data['projects'].append({'id': identifier, 'name': name, 'kind': kind, 'description': description,
                                 'cost': {'capexRub': cost, 'annualOpexRub': round(cost * .035), 'isSynthetic': True, 'priceYear': 2026},
                                 'requires': requires or [], 'excludes': [], 'exclusiveGroup': group,
                                 'parcelId': parcel_id, 'operations': operations})

    project('p_cross_south', 'Переход через магистраль у южного квартала', 'new_crossing', 1800000,
            [operation('set_edge_active', 'cross_v2_r0_n', value=True)], description='Открывает заранее размеченный переход; включает понижения бордюров.')
    project('p_cross_central', 'Переход через магистраль у центрального квартала', 'new_crossing', 1900000,
            [operation('set_edge_active', 'cross_v2_r1_s', value=True)], description='Сокращает обход между центральными кварталами.')
    project('p_kerbs', 'Понижение бордюров на двух переходах', 'accessibility', 450000,
            [operation('upgrade_edge', identifier, changes={'kerbRamps': True}) for identifier in ['cross_v2_r0_s', 'cross_v2_r1_n']],
            description='Сохраняет длину и время ожидания; делает два перехода доступными профилю без ступеней.')
    project('p_ramp', 'Пандус на дворовом проходе юго-восточного квартала', 'accessibility', 650000,
            [operation('upgrade_edge', 'b03_arm_n', changes={'stairs': False, 'slope': .04, 'widthM': 2.0})],
            description='Условный пандус в существующем коридоре; геометрия не является строительным проектом.')
    for bid in ['b10', 'b02']:
        project(f'p_passage_{bid}', f'Открыть северный проход квартала {bid}', 'open_passage', 350000,
                [operation('set_edge_active', f'{bid}_arm_n', value=True)], description='Убирает ограничение на заранее существующем свободном коридоре.')
    for bid, cost in [('b10', 2400000), ('b22', 1700000)]:
        project(f'p_park_{bid}', f'Сквер на свободном участке {bid}', 'new_park', cost,
                [operation('set_node_active', f'{bid}_ne_park_gate', value=True),
                 operation('set_edge_active', f'{bid}_ne_park_access', value=True),
                 operation('set_parcel_use', f'parcel_{bid}_ne', kind='public_park'),
                 operation('set_destination_active', f'park_{bid}', value=True)],
                parcel_id=f'parcel_{bid}_ne', description='Осваивает свободный участок без сноса и переселения; площадь задана полигоном участка.')
    for identifier, bay, name in [('p_stop_north', 'bay_b21_e', 'Перенести западную центральную остановку на север'),
                                   ('p_stop_south', 'bay_b01_e', 'Перенести западную центральную остановку на юг')]:
        project(identifier, name, 'relocate_stop', 600000,
                [operation('relocate_destination', 'stop_central_w', nodeId=bay.replace('bay_', ''), stopBayId=bay)],
                group='stop_central_w_location', description='Перенос на ту же сторону той же улицы; оценивается только пеший доступ.')
    project('p_stop_east_north', 'Перенести восточную центральную остановку на север', 'relocate_stop', 550000,
            [operation('relocate_destination', 'stop_central_e', nodeId='b22_w', stopBayId='bay_b22_w')],
            description='Сохраняет условный маршрут и сторону улицы; может ухудшить доступ южных домов.')
    project('p_park_paving', 'Твёрдое покрытие входа в новый западный сквер', 'accessibility', 300000,
            [operation('upgrade_edge', 'b10_ne_park_access', changes={'surface': 'asphalt'})], requires=['p_park_b10'],
            description='Дополнение к созданию сквера; не может применяться самостоятельно.')

    data['scenarios'] = [
        {'id': 'baseline', 'name': 'Исходный район', 'description': 'Неизменённое состояние для воспроизводимого сравнения.',
         'projectIds': [], 'budgetRub': 8000000, 'operationalOverrides': []},
        {'id': 'connections', 'name': 'Связность кварталов', 'description': 'Два новых перехода и один открытый проход.',
         'projectIds': ['p_cross_south', 'p_cross_central', 'p_passage_b10'], 'budgetRub': 8000000, 'operationalOverrides': []},
        {'id': 'green_access', 'name': 'Скверы и доступность', 'description': 'Два сквера, бордюры, пандус и твёрдое покрытие входа.',
         'projectIds': ['p_park_b10', 'p_park_b22', 'p_kerbs', 'p_ramp', 'p_park_paving'], 'budgetRub': 8000000, 'operationalOverrides': []},
        {'id': 'stop_north', 'name': 'Остановка севернее', 'description': 'Пример перераспределения пользы между жителями.',
         'projectIds': ['p_stop_north'], 'budgetRub': 8000000, 'operationalOverrides': []},
        {'id': 'balanced', 'name': 'Сбалансированный проект', 'description': 'Авторский вариант для сравнения, без утверждения об оптимальности.',
         'projectIds': ['p_cross_central', 'p_park_b10', 'p_kerbs', 'p_passage_b10', 'p_stop_east_north', 'p_park_paving'],
         'budgetRub': 8000000, 'operationalOverrides': []},
        {'id': 'temporary_closure', 'name': 'Временное закрытие перехода', 'description': 'Стресс-сценарий: эксплуатационное событие без капитальных расходов.',
         'projectIds': [], 'budgetRub': 8000000,
         'operationalOverrides': [operation('set_edge_active', 'cross_v2_r1_n', value=False)]}]
    return data


def feature_collection(features, dataset):
    return {'type': 'FeatureCollection', 'name': dataset['metadata']['id'],
            'datasetVersion': dataset['metadata']['datasetVersion'],
            'coordinateNotice': 'RFC 7946 longitude,latitude; approximate display only. Canonical geometry is local metres in district.json.',
            'features': features}


def exports(data, target):
    origin = data['metadata']['coordinateSystem']['displayOriginWgs84']
    nodes = {n['id']: n for n in data['nodes']}
    for key in ['roads', 'blocks', 'parcels', 'buildings', 'nodes', 'edges', 'destinations']:
        features = []
        for item in data[key]:
            props = dict(item)
            if 'polygon' in props:
                ring = props.pop('polygon')
                geometry = {'type': 'Polygon', 'coordinates': [[to_wgs84(p, origin) for p in ring]]}
            elif key == 'edges':
                geometry = {'type': 'LineString', 'coordinates': [to_wgs84(p, origin) for p in props.pop('geometry')]}
            else:
                xy = props.pop('xy') if key == 'nodes' else nodes[item['accessNodeIds'][0]]['xy']
                geometry = {'type': 'Point', 'coordinates': to_wgs84(xy, origin)}
                if key == 'destinations':
                    props['displayPointRule'] = 'first access node; accessNodeIds are routing authority'
            props['synthetic'] = True
            features.append({'type': 'Feature', 'id': item['id'], 'properties': props, 'geometry': geometry})
        write_json(target / 'geojson' / f'{key}.geojson', feature_collection(features, data))


def reports(data, target):
    baseline = {p['id']: metrics(data, p['id']) for p in data['profiles']}
    write_json(target / 'reports' / 'baseline-metrics.json', baseline)
    comparison = []
    for scenario in data['scenarios']:
        district, costs = materialize(data, scenario)
        profile_results = {p['id']: metrics(district, p['id']) for p in data['profiles']}
        comparison.append({'scenarioId': scenario['id'], 'costs': costs,
                           'metrics': profile_results,
                           'changesFromBaseline': {pid: compare_metrics(baseline[pid], result) for pid, result in profile_results.items()}})
    write_json(target / 'reports' / 'scenario-comparison.json', comparison)
    project_effects = []
    for project in data['projects']:
        context = {'projectIds': project['requires'], 'budgetRub': 1000000000, 'operationalOverrides': []}
        before, _ = materialize(data, context)
        after, _ = materialize(data, {**context, 'projectIds': project['requires'] + [project['id']]})
        changes = {profile['id']: compare_metrics(metrics(before, profile['id']), metrics(after, profile['id'])) for profile in data['profiles']}
        project_effects.append({'projectId': project['id'], 'contextProjectIds': project['requires'],
                               'changesFromContext': changes,
                               'note': 'Counts are per destination type and profile; do not sum them as unique residents. Zero immediate effect is valid; benefits may depend on other projects.'})
    write_json(target / 'reports' / 'project-effects.json', project_effects)
    home = next(b for b in data['buildings'] if b['kind'] == 'residential')
    entrance_ids = set(home['entranceNodeIds'])
    incident = [e['id'] for e in data['edges'] if e['from'] in entrance_ids or e['to'] in entrance_ids]
    write_json(target / 'fixtures' / 'regression-cases.json', {
        'description': 'Intentional edge cases for tests; do not merge these overrides into the baseline.',
        'cases': [
            {'id': 'isolated_home', 'scenario': {'id': 'fixture_isolated', 'name': 'Изоляция дома', 'description': 'Только тест.',
             'projectIds': [], 'budgetRub': 8000000,
             'operationalOverrides': [{'op': 'set_edge_active', 'targetId': e, 'value': False} for e in incident]},
             'expectation': {'buildingId': home['id'], 'unreachableResidents': home['population']['total'], 'travelSeconds': None}},
            {'id': 'conflicting_stops', 'projectIds': ['p_stop_north', 'p_stop_south'], 'expectedError': 'exclusive group'},
            {'id': 'missing_dependency', 'projectIds': ['p_park_paving'], 'expectedError': 'dependencies'},
            {'id': 'over_budget', 'projectIds': ['p_park_b10'], 'budgetRub': 1000000, 'expectedError': 'budget'}]})
    files = sorted(p for p in target.rglob('*') if p.is_file() and p.name != 'manifest.json' and p.parent.name not in ['reports', 'preview'])
    write_json(target / 'manifest.json', {
        'datasetVersion': data['metadata']['datasetVersion'], 'canonicalFile': 'district.json',
        'hashAlgorithm': 'sha256', 'files': [{'path': str(p.relative_to(target)).replace('\\', '/'),
                                             'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'data')
    args = parser.parse_args()
    data = build()
    write_json(args.output / 'district.json', data)
    schema = build_schema()
    write_json(args.output / 'schema' / 'district.schema.json', schema)
    (args.output / 'schema' / 'district.types.ts').write_text(typescript_contract(schema), encoding='utf-8', newline='\n')
    exports(data, args.output)
    reports(data, args.output)
    from validate_dataset import validate
    validation = validate(data)
    write_json(args.output / 'reports' / 'validation.json', validation)
    print(json.dumps(validation, ensure_ascii=False, indent=2))
    if validation['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
