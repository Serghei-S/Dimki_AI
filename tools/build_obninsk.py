"""Reproducible hybrid model of central Obninsk, from a cached OSM extract.

No network access during building. Install tools/requirements-geo.txt to regenerate.
Real footprints/road axes; pedestrian infill, entrances, population and projects are assumptions.
"""
from __future__ import annotations
import copy
import hashlib
import heapq
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'geo'))
from shapely import __version__ as shapely_version
from shapely.geometry import Point, LineString, Polygon, box, MultiLineString
from shapely.ops import unary_union, nearest_points, polygonize
from shapely.geometry.polygon import orient
from shapely.strtree import STRtree
from build_dataset import write_json, rng_for
from district_model import polygon_area, metrics, materialize, to_wgs84, compare_metrics

ORIGIN = [36.608, 55.09]
BBOX = [36.6072, 55.09, 36.617, 55.0945]
R = 6371008.8
SOURCE = ROOT / 'data/sources/obninsk-center.osm.json'

def xy(point):
    return ((point['lon'] - ORIGIN[0]) * math.pi / 180 * R * math.cos(math.radians(ORIGIN[1])),
            (point['lat'] - ORIGIN[1]) * math.pi / 180 * R)

def parts(shape, kind):
    if shape.is_empty:
        return []
    if shape.geom_type == kind:
        return [shape]
    if hasattr(shape, 'geoms'):
        return [item for child in shape.geoms for item in parts(child, kind)]
    return []

def coords(shape):
    return [[round(x, 5), round(y, 5)] for x, y in shape.coords]

def ring(polygon):
    return coords(orient(polygon, sign=1).exterior)

def polygon(element):
    try:
        p = Polygon([xy(q) for q in element['geometry']])
        if not p.is_valid:
            p = p.buffer(0)
        return max(parts(p, 'Polygon'), key=lambda x: x.area)
    except (ValueError, KeyError):
        return None

def numeric(value, default):
    try:
        return float(str(value).split(';')[0].replace(' m', ''))
    except (ValueError, TypeError):
        return default

def population(identifier, area, floors):
    rng = rng_for(identifier)
    apartments = max(4, round(area * floors * .78 / 55))
    occupied = max(1, round(apartments * .94))
    sizes = [rng.choices([1, 2, 3, 4, 5], [.23, .34, .25, .15, .03])[0] for _ in range(occupied)]
    total = sum(sizes)
    under, older = round(total * .18), round(total * .23)
    return {'total': total, 'ageGroups': {'under18': under, 'age18to64': total-under-older, 'age65plus': older},
            'mobilityNeedsResidents': max(1, round(total * .035)), 'households': occupied,
            'householdSizeCounts': {str(i): sizes.count(i) for i in range(1,6)},
            'apartments': apartments, 'occupiedApartments': occupied}

def build():
    raw = json.loads(SOURCE.read_text(encoding='utf-8'))
    print('Reading cached OSM extract',flush=True)
    elements = raw['elements']
    details_path=ROOT/'data/sources/obninsk-details.osm.json'
    details=json.loads(details_path.read_text(encoding='utf-8'))
    by_id={(e['type'],e['id']):e for e in elements}
    by_id.update({(e['type'],e['id']):e for e in details['elements']})
    elements=list(by_id.values())
    source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    baseline = json.loads((ROOT/'data/district.json').read_text(encoding='utf-8'))
    aoi = box(*xy({'lon':BBOX[0],'lat':BBOX[1]}), *xy({'lon': BBOX[2], 'lat': BBOX[3]}))
    data = {key: copy.deepcopy(baseline[key]) for key in ('$schema','metadata','metricDefinitions','profiles','transitServices')}
    for name in ('roads','blocks','parcels','buildings','nodes','edges','destinations','stopBays','projects','scenarios'):
        data[name] = []
    data['metadata'].update({
        'id':'obninsk-center-01','name':'Обнинск — центр / площадь Преображения','datasetVersion':'1.0.0',
        'description':'Гибридная учебная модель реального центра: контуры зданий и оси улиц OSM, моделируемые входы, население и проекты.',
        'source':f'© OpenStreetMap contributors, ODbL 1.0; snapshot {raw["osm3s"]["timestamp_osm_base"]}; approximate pedestrian infill and synthetic population.',
        'license':'ODbL-1.0',
        'limitations':[
            'Контуры основных зданий и оси улиц взяты из OpenStreetMap, не из кадастра. Мелкие строения упрощены.',
            'Население, домохозяйства, вместимость, стоимости, ожидание, ширина и уклоны — условная модель, не официальная статистика.',
            'OSM-дорожки дополнены приблизительными тротуарами вдоль улиц и проверяемыми дворовыми связями; это не навигационный сервис.',
            'Входы зданий и парков приближены по видимой пешеходной сети. Не проверены заборы, право прохода и фактическая доступность бордюров.',
            'Учебный медпункт обозначен как сценарное допущение; внутри участка нет подтверждённой OSM поликлиники.',
            'Крупные OSM-газоны используются как учебные зелёные площадки. Это допущение о доступе, не утверждение официального статуса парка.',
            'Модель ограничена рамкой: маршруты вне участка не учитываются. Недостижимые жители остаются в знаменателе.',
            'Автобусное движение, пробки, очереди и перераспределение по вместимости не моделируются.',
            'Сценарные новые переходы, скверы и связи — предложения, не существующие или утверждённые объекты.',
        ]})
    data['metadata']['coordinateSystem'].update({'displayOriginWgs84': ORIGIN,
        'accuracy':'Local equirectangular metric projection of OSM WGS84. Map geometry, not a cadastral survey.'})
    provenance = {'sourceFile':'sources/obninsk-center.osm.json','sourceSha256':source_hash,
        'osmTimestamp':raw['osm3s']['timestamp_osm_base'],'extentWgs84':BBOX,'originWgs84':ORIGIN,
        'license':'ODbL-1.0','attribution':'© OpenStreetMap contributors','licenseUrl':'https://www.openstreetmap.org/copyright',
        'generator':'tools/build_obninsk.py','shapelyVersion':shapely_version,
        'detailsFile':'sources/obninsk-details.osm.json','detailsSha256':hashlib.sha256(details_path.read_bytes()).hexdigest(),
        'assumptions':{'residentialFloorUsableFactor':.78,'apartmentAreaM2':55,'occupancy':.94,'defaultFloors':4,
            'defaultFloorHeightM':3.1,'sidewalkOffsetFromRoadM':3,'maxInfillLinkM':45,'maxBuildingAccessM':100,
            'defaultSlope':.015,'unknownKerbsAssumedLowered':True,'defaultCrossingWaitSeconds':20},
        'buildings':{},'roads':{},'edges':{},'destinations':{},'warnings':[]}
    school_sites = [(e,polygon(e)) for e in elements if e.get('tags',{}).get('amenity')=='school' and 'geometry' in e]
    source_buildings=[]
    for e in elements:
        t=e.get('tags',{})
        if e['type']!='way' or 'building' not in t:
            continue
        p=polygon(e)
        if not p or not aoi.buffer(40).intersects(p):
            continue
        source_buildings.append((e,p))
    selected=[]
    for e,p in source_buildings:
        t=e['tags']
        if not aoi.contains(p.centroid) or p.area<190 or t.get('military') or t['building'] in ('roof','garage','garages','construction','service'):
            continue
        school=next((site for site,area in school_sites if area and area.covers(p.representative_point())),None)
        if not (t.get('addr:street') or t.get('amenity') or t.get('tourism') or t['building']=='apartments' or school):
            continue
        kind='school' if school else 'grocery' if t.get('shop') in ('supermarket','convenience') else 'community' if t.get('amenity') or t.get('tourism') or t.get('shop') or t['building'] in ('commercial','office','retail') else 'residential'
        selected.append((e,p,kind,school))
    extent=unary_union([aoi]+[p for _,p,_,_ in selected]).envelope.buffer(12)
    data['metadata']['boundsM']=[round(v,5) for v in extent.bounds]
    building_obstacles=unary_union([p for _,p in source_buildings]).buffer(.05)
    node_lookup={}
    def node(point, kind='junction', active=True):
        point=(round(point[0],5),round(point[1],5))
        if point in node_lookup:
            return node_lookup[point]
        if active:
            nearby=next((n for n in data['nodes'] if n['active'] and math.dist(n['xy'],point)<.05),None)
            if nearby:
                node_lookup[point]=nearby['id'];return nearby['id']
        identifier=f'oc_n_{len(data["nodes"])}'
        data['nodes'].append({'id':identifier,'xy':list(point),'kind':kind,'active':active,'blockId':None})
        node_lookup[point]=identifier
        return identifier
    def edge(line,kind='sidewalk',active=True,crossing=None,source=None,surface='paving',width=2.5,stairs=False):
        geometry=coords(line)
        if len(geometry)<2 or LineString(geometry).length<.05:
            return None
        identifier=f'oc_e_{len(data["edges"])}'
        source_node,target_node=node(geometry[0]),node(geometry[-1])
        geometry[0]=list(node_record(source_node)['xy']);geometry[-1]=list(node_record(target_node)['xy'])
        if source_node==target_node or LineString(geometry).length<.001:return None
        data['edges'].append({'id':identifier,'from':source_node,'to':target_node,'geometry':geometry,
            'lengthM':round(LineString(geometry).length,6),'kind':kind,'active':active,'bidirectional':True,
            'surface':surface,'widthM':width,'slope':.015,'stairs':stairs,'crossing':crossing})
        provenance['edges'][identifier]=source or {'kind':'modelled'}
        return identifier
    def node_record(identifier):
        return next(n for n in data['nodes'] if n['id']==identifier)
    roads=[]
    pedestrian=[]
    service=[]
    for e in elements:
        if e['type']!='way' or not e.get('geometry'):
            continue
        t=e.get('tags',{});h=t.get('highway')
        if not h or h in ('construction','proposed','bus_stop'):
            continue
        line=LineString([xy(q) for q in e['geometry']]).simplify(.35,preserve_topology=True).intersection(aoi)
        if line.is_empty:
            continue
        if h in ('primary','secondary','tertiary','residential','unclassified','primary_link','secondary_link','tertiary_link','living_street'):
            lanes=int(max(1,min(4,numeric(t.get('lanes'),2))))
            width=numeric(t.get('width'),lanes*3.1 if h in ('primary','secondary','primary_link') else 6)
            for index,piece in enumerate(parts(line,'LineString')):
                if piece.length<3:continue
                identifier=f'osm_road_{e["id"]}_{index}'
                outline=piece.buffer(width/2,cap_style=2,join_style=2)
                if outline.geom_type!='Polygon':continue
                g=coords(piece);vertical=abs(g[-1][1]-g[0][1])>abs(g[-1][0]-g[0][0])
                record={'id':identifier,'name':t.get('name','Уличный проезд'),'axis':'vertical' if vertical else 'horizontal',
                    'centerM':piece.centroid.x if vertical else piece.centroid.y,'widthM':width,'polygon':ring(outline),
                    'speedLimitKmh':int(numeric(t.get('maxspeed'),40 if h in ('primary','secondary') else 30)),
                    'lanes':lanes,'centerline':g}
                data['roads'].append(record);roads.append((record,piece,outline))
                provenance['roads'][identifier]={'osmType':'way','osmId':e['id'],'widthAssumed':'width' not in t}
        elif h in ('footway','path','pedestrian','steps','cycleway') and t.get('access') not in ('private','no') and t.get('foot')!='no':
            pedestrian.extend((piece,e) for piece in parts(line,'LineString'))
        elif h=='service' and t.get('access') not in ('private','no') and t.get('foot')!='no':
            service.extend((piece,e) for piece in parts(line,'LineString'))
    road_mask=unary_union([p for _,_,p in roads])
    raw_walk=[];raw_cross=[]
    cross_nodes=[e for e in elements if e['type']=='node' and e.get('tags',{}).get('highway')=='crossing' and aoi.covers(Point(xy(e)))]
    crossing_points=[Point(xy(e)) for e in cross_nodes]
    def outside(line):
        return parts(line.difference(road_mask).difference(building_obstacles),'LineString')
    for line,e in pedestrian+service:
        raw_walk.extend(outside(line))
        for piece in parts(line.intersection(road_mask),'LineString'):
            if e.get('tags',{}).get('footway')=='crossing' or any(piece.distance(p)<18 for p in crossing_points):
                raw_cross.append(piece)
    # Derive sidewalks on both sides of actual road curves; never walk on a carriageway axis.
    for record,line,_ in roads:
        for side in (-1,1):
            offset=line.offset_curve(side*(record['widthM']/2+3),join_style=2)
            for segment in parts(offset.intersection(aoi),'LineString'):
                raw_walk.extend(outside(segment))
    for e in cross_nodes:
        p=Point(xy(e));record,line,_=min(roads,key=lambda item:item[1].distance(p))
        if any(piece.distance(p)<3 for piece in raw_cross):continue
        d=line.project(p);a=line.interpolate(max(0,d-2));b=line.interpolate(min(line.length,d+2))
        dx,dy=b.x-a.x,b.y-a.y;l=math.hypot(dx,dy)
        if not l or p.distance(line)>8:continue
        c=line.interpolate(d);half=record['widthM']/2+4.2
        crossing=LineString([(c.x-dy/l*half,c.y+dx/l*half),(c.x+dy/l*half,c.y-dx/l*half)])
        if crossing.intersects(building_obstacles):continue
        raw_walk.extend(outside(crossing))
        raw_cross.extend(parts(crossing.intersection(road_mask),'LineString'))
    network=unary_union(raw_walk+raw_cross)
    print(f'Pedestrian primitives: {len(parts(network,"LineString"))}',flush=True)
    # Short inferred corner joins only where no building or road blocks the link.
    endpoints=list({tuple(p) for line in parts(network,'LineString') for p in (line.coords[0],line.coords[-1])})
    infill=[]
    endpoint_index={p:i for i,p in enumerate(endpoints)}
    parent=list(range(len(endpoints)))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]];i=parent[i]
        return i
    def union(i,j):parent[root(i)]=root(j)
    for line in parts(network,'LineString'):union(endpoint_index[tuple(line.coords[0])],endpoint_index[tuple(line.coords[-1])])
    endpoint_tree=STRtree([Point(p) for p in endpoints])
    joins=[]
    for i,p in enumerate(endpoints):
        for j in endpoint_tree.query(Point(p).buffer(45)):
            if j<=i:continue
            q=endpoints[j]
            distance=math.dist(p,q)
            if .02<distance<=45 and root(i)!=root(j):joins.append((distance,i,int(j)))
    for distance,i,j in sorted(joins):
        if root(i)==root(j):continue
        link=LineString([endpoints[i],endpoints[j]])
        if not link.intersects(road_mask.buffer(-.02)) and not link.intersects(building_obstacles):
            infill.append(link);union(i,j)
    network=unary_union([network]+infill)
    # Repair sub-metre endpoint-to-segment digitisation gaps without moving OSM footprints.
    initial_lines=parts(network,'LineString');line_tree=STRtree(initial_lines);repairs=[]
    for p in endpoints:
        point=Point(p)
        for index in line_tree.query(point.buffer(.35)):
            target=initial_lines[index];distance=point.distance(target)
            if not .00003<distance<=.35:continue
            q=nearest_points(point,target)[1];link=LineString([point,q])
            if not link.intersects(building_obstacles) and not link.intersects(road_mask.buffer(-.02)):repairs.append(link)
    network=unary_union([network]+repairs)
    print(f'Network infill links: {len(infill)}',flush=True)
    lines=[line for line in parts(network,'LineString') if line.length>.08]
    # Remove microscopic disconnected traces, retain meaningful disconnected paths honestly.
    for line in lines:
        middle=line.interpolate(.5,normalized=True)
        road=next((record for record,_,p in roads if p.buffer(.01).covers(middle)),None)
        crossing=None
        nearest_osm=min(pedestrian+service,key=lambda pair:pair[0].distance(middle),default=None)
        is_osm=nearest_osm and nearest_osm[0].distance(middle)<.3
        tags=nearest_osm[1].get('tags',{}) if is_osm else {}
        surface='asphalt' if tags.get('surface') in ('asphalt','concrete') else 'compacted_gravel' if tags.get('surface') in ('ground','dirt','gravel','compacted','unpaved') else 'paving'
        stairs=tags.get('highway')=='steps'
        if road:
            if line.length<.1:continue
            cp=min(cross_nodes,key=lambda e:middle.distance(Point(xy(e))),default=None)
            signal=cp and cp.get('tags',{}).get('crossing') in ('traffic_signals','signals')
            crossing={'roadId':road['id'],'control':'signalized' if signal else 'zebra','waitSeconds':35 if signal else 20,
                'kerbRamps':True,'tactilePaving':False}
        source={'kind':'osm' if is_osm else 'inferred_sidewalk_or_corner',**({'osmType':'way','osmId':nearest_osm[1]['id']} if is_osm else {})}
        edge(line,'crossing' if crossing else 'courtyard' if tags.get('highway')=='service' else 'sidewalk',
             crossing=crossing,source=source,surface=surface,stairs=stairs,width=2.5 if not stairs else 1.8)
    # Helpers attach to an existing edge and split its actual polyline at the footpoint.
    def attach(point):
        p=Point(point)
        choices=[e for e in data['edges'] if e['active'] and e['kind']!='crossing']
        target=min(choices,key=lambda e:LineString(e['geometry']).distance(p))
        line=LineString(target['geometry']);distance=line.project(p);q=line.interpolate(distance)
        if distance<.03:return target['from']
        if line.length-distance<.03:return target['to']
        from shapely.ops import substring
        target['active']=False
        split_node=node((q.x,q.y))
        for a,b in [(0,distance),(distance,line.length)]:
            piece=substring(line,a,b)
            child=edge(piece,target['kind'],crossing=copy.deepcopy(target['crossing']),source=copy.deepcopy(provenance['edges'][target['id']]),surface=target['surface'],stairs=target['stairs'],width=target['widthM'])
        return split_node
    def access_to(p, own=None):
        candidates=[]
        obstacles=building_obstacles.difference(own.buffer(.15)) if own is not None else building_obstacles
        for e in data['edges']:
            if not e['active'] or e['kind']=='crossing':continue
            line=LineString(e['geometry']);q=nearest_points(p,line)[1];a=nearest_points(p,q)[0]
            if a.distance(q)>100:continue
            connector=LineString([a,q])
            if connector.length<.05 or not connector.intersects(road_mask.buffer(.02)) and not connector.intersects(obstacles):
                candidates.append((connector.length,connector,q,a))
        if not candidates:
            return None,None
        _,connector,q,a=min(candidates,key=lambda item:item[0])
        anchor=attach((q.x,q.y))
        if connector.length<.05:return anchor,anchor
        entrance=node((a.x,a.y),'building_entrance')
        if connector.length>=.05:edge(connector,'access',source={'kind':'modelled_building_entrance'})
        return entrance,anchor
    # Road-delimited blocks are only a visual grouping; they create no walking connections.
    land=aoi.difference(road_mask.buffer(3))
    for i,p in enumerate(sorted(parts(land,'Polygon'),key=lambda p:-p.area)):
        if p.area<70:continue
        data['blocks'].append({'id':f'oc_block_{i}','name':f'Центральный квартал {i+1}','polygon':ring(p),'landUse':'mixed'})
    def block_for(p):
        return min(data['blocks'],key=lambda b:Polygon(b['polygon']).distance(p))['id']
    def parcel(identifier,p,kind,name):
        data['parcels'].append({'id':identifier,'blockId':block_for(p),'kind':kind,'name':name,'polygon':ring(p),
            'areaM2':polygon_area(ring(p)),'active':True,'fence':None})
    def destination(identifier,name,kind,entrances,parcel_id=None,building_id=None,active=True,capacity=None,bay=None,source=None):
        data['destinations'].append({'id':identifier,'name':name,'kind':kind,'active':active,'accessNodeIds':entrances,
            'parcelId':parcel_id,'buildingId':building_id,'stopBayId':bay,'capacity':capacity,
            'openingHours':'Условно открыто; расписание не моделируется','routeIds':['bus_a'] if kind=='bus_stop' else []})
        provenance['destinations'][identifier]=source or {'kind':'scenario_assumption'}
    print(f'Attaching {len(selected)} primary buildings',flush=True)
    for e,p,kind,school in sorted(selected,key=lambda item:item[0]['id']):
        identifier=f'osm_building_{e["id"]}';t=e['tags']
        entrances=[by_id[('node',n)] for n in e.get('nodes',[]) if ('node',n) in by_id and by_id[('node',n)].get('tags',{}).get('entrance') and by_id[('node',n)].get('tags',{}).get('access') not in ('private','no')]
        entrances.sort(key=lambda n:(n.get('tags',{}).get('entrance')!='main',n['id']))
        entrance,anchor=access_to(Point(xy(entrances[0])) if entrances else p.exterior,p)
        if entrance is None:
            q=p.exterior.interpolate(.5,normalized=True);entrance=node((q.x,q.y),'building_entrance')
            provenance['warnings'].append(f'{identifier}: no safe modelled entrance connector; kept unreachable')
        floors=int(max(1,min(30,numeric(t.get('building:levels'),4 if kind=='residential' else 2))))
        height=max(3,min(120,numeric(t.get('height'),floors*3.1+1.5)))
        name=(t.get('addr:street','')+', '+t.get('addr:housenumber','')).strip(', ')
        if school:name=school['tags'].get('name','Школа')
        elif t.get('name'):name=t['name']+(f' · {name}' if name else '')
        if not name:name=f'Здание OSM {e["id"]}'
        parcel_id=f'oc_parcel_{e["id"]}';parcel(parcel_id,p,'residential' if kind=='residential' else 'school' if kind=='school' else 'public_service',name)
        data['buildings'].append({'id':identifier,'name':name,'kind':kind,'blockId':block_for(p),'parcelId':parcel_id,
            'polygon':ring(p),'footprintAreaM2':polygon_area(ring(p)),'floors':floors,'heightM':height,
            'entranceNodeIds':[entrance],'population':population(identifier,p.area,floors) if kind=='residential' else None})
        provenance['buildings'][identifier]={'osmType':'way','osmId':e['id'],'url':f'https://www.openstreetmap.org/way/{e["id"]}',
            'tags':t,'useAssumed':t.get('building')=='yes' and not (school or t.get('amenity') or t.get('shop') or t.get('tourism')),
            'floorsAssumed':'building:levels' not in t,'heightAssumed':'height' not in t,'entranceAssumed':not bool(entrances),'entranceOsmId':entrances[0]['id'] if entrances else None,'entranceLinkAssumed':True,'populationSynthetic':kind=='residential'}
        if kind in ('school','grocery','community'):
            destination(f'oc_place_{e["id"]}',name,kind,[entrance],parcel_id,identifier,capacity=600 if kind=='school' else None,
                source={'kind':'osm_site' if school or t.get('shop') or t.get('amenity') else 'inferred_building_use','osmId':school['id'] if school else e['id']})
    # A POI inside a mixed-use residential footprint routes to that building's entrance;
    # its position is not treated as a door through the middle of the building.
    for e in elements:
        if e['type']!='node' or e.get('tags',{}).get('shop') not in ('supermarket','convenience'):continue
        p=Point(xy(e))
        if not aoi.covers(p):continue
        building=min(data['buildings'],key=lambda b:Polygon(b['polygon']).distance(p))
        if Polygon(building['polygon']).distance(p)>15:continue
        identifier=f'osm_shop_{e["id"]}'
        destination(identifier,e['tags'].get('name','Продуктовый магазин'),'grocery',list(building['entranceNodeIds']),building_id=building['id'],
            source={'kind':'osm','osmType':'node','osmId':e['id'],'entranceAssumed':True,'openingHoursInformational':True})
        data['destinations'][-1]['openingHours']=e['tags'].get('opening_hours','Условно открыто')
    # Real mapped parks: entrances at mapped path/boundary intersections, capacity remains conditional.
    for e in elements:
        if e['type']!='way' or not(e.get('tags',{}).get('leisure') in ('park','garden') or e.get('tags',{}).get('landuse')=='grass'):continue
        p=polygon(e)
        if p is None:continue
        for index,piece in enumerate(parts(p.intersection(aoi),'Polygon')):
            if piece.area<50:continue
            is_park=e.get('tags',{}).get('leisure') in ('park','garden') or piece.area>=900
            pid=f'osm_park_{e["id"]}_{index}'
            if not is_park:
                parcel(pid,piece,'landscaping','Газон · контур OpenStreetMap')
                continue
            entries=[]
            for crossing in parts(piece.boundary.intersection(network),'Point'):
                if not any(crossing.distance(Point(node_record(n)['xy']))<18 for n in entries):entries.append(attach((crossing.x,crossing.y)))
                if len(entries)>=8:break
            if not entries:
                entrance,_=access_to(piece.exterior)
                if entrance:entries=[entrance]
            if not entries:continue
            name=e.get('tags',{}).get('name','Зелёная площадка · учебный доступ')
            parcel(pid,piece,'public_park',name)
            destination(f'oc_park_{e["id"]}_{index}',name,'park',entries,pid,capacity=max(1,int(piece.area/10)),source={'kind':'osm','osmType':'way','osmId':e['id'],'entrancesAssumed':True,'parkInterpretationAssumed':e.get('tags',{}).get('leisure') not in ('park','garden')})
    # Bus stops retain actual OSM coordinates, projected to the model sidewalk on the same side.
    for e in elements:
        if e['type']!='node' or e.get('tags',{}).get('highway')!='bus_stop' or not aoi.covers(Point(xy(e))):continue
        point=Point(xy(e));choices=[x for x in data['edges'] if x['active'] and x['kind']!='crossing']
        eligible=[]
        for candidate in choices:
            q=nearest_points(point,LineString(candidate['geometry']))[1]
            connector=LineString([point,q])
            if connector.length<=35 and not connector.intersects(road_mask.buffer(-.2)):eligible.append((connector.length,q))
        if not eligible:continue
        _,q=min(eligible,key=lambda item:item[0]);n=attach((q.x,q.y));record,line,_=min(roads,key=lambda item:item[1].distance(q))
        side='west' if record['axis']=='vertical' and q.x<line.centroid.x else 'east' if record['axis']=='vertical' else 'south' if q.y<line.centroid.y else 'north'
        bay=f'oc_bay_{e["id"]}';name=e['tags'].get('name','Остановка в центре')
        data['stopBays'].append({'id':bay,'name':name,'nodeId':n,'roadId':record['id'],'side':side,'routeIds':['bus_a'],'stepFreeBoardingAssumed':True})
        destination(f'osm_stop_{e["id"]}',name,'bus_stop',[n],bay=bay,source={'kind':'osm','osmType':'node','osmId':e['id'],'positionSnappedM':q.distance(point)})
    # Model service types absent in the crop remain explicit assumptions, never invented real businesses.
    for kind,name in [('clinic','Учебный медпункт · сценарное допущение'),('grocery','Учебный магазин · сценарное допущение'),('school','Учебный образовательный центр · сценарное допущение')]:
        if any(d['active'] and d['kind']==kind for d in data['destinations']):continue
        candidate=min(data['buildings'],key=lambda b:Point(node_record(b['entranceNodeIds'][0])['xy']).distance(aoi.centroid))
        destination(f'oc_model_{kind}',name,kind,list(candidate['entranceNodeIds']),building_id=candidate['id'],capacity=200 if kind=='clinic' else 600 if kind=='school' else 100,
            source={'kind':'scenario_assumption','reason':'No confirmed service of this kind inside selected map crop; illustrative service only.'})
    add_projects(data,provenance,roads,road_mask,building_obstacles,aoi,node,edge,attach,parcel,destination,node_record)
    print('Scenario catalogue complete',flush=True)
    # Geometry is rounded once, then all stored lengths recomputed from stored coordinates.
    for e in data['edges']:e['lengthM']=round(LineString(e['geometry']).length,6)
    provenance['summary']={'buildings':len(data['buildings']),'homes':sum(b['population'] is not None for b in data['buildings']),
        'residents':sum((b['population'] or {}).get('total',0) for b in data['buildings']),
        'nodes':len(data['nodes']),'edges':len(data['edges']),'activeEdges':sum(e['active'] for e in data['edges']),
        'crossingEdges':sum(e['active'] and e['kind']=='crossing' for e in data['edges']),
        'sourceCrossingNodes':len(cross_nodes),'projects':len(data['projects']),
        'roads':len(data['roads']),'stops':sum(d['active'] and d['kind']=='bus_stop' for d in data['destinations']),
        'greenAreas':sum(d['active'] and d['kind']=='park' for d in data['destinations'])}
    return data,provenance

def add_projects(data,provenance,roads,road_mask,obstacles,aoi,node,edge,attach,parcel,destination,node_record):
    print('Building scenario catalogue',flush=True)
    def project(identifier,name,kind,operations,cost=400000,requires=None,group=None,pid=None):
        data['projects'].append({'id':identifier,'name':name,'kind':kind,'description':'Условное предложение для сравнения. Требуется обследование территории и проверка прав прохода.',
            'cost':{'capexRub':cost,'annualOpexRub':round(cost*.025),'isSynthetic':True,'priceYear':2026},
            'requires':requires or [],'excludes':[],'exclusiveGroup':group,'parcelId':pid,'operations':operations})
    actual_crossings=[e for e in data['edges'] if e['active'] and e['kind']=='crossing' and e['lengthM']>3]
    proposed_crossings=[]
    actual_cross_geometry=unary_union([LineString(e['geometry']) for e in actual_crossings])
    for record,axis,_ in roads:
        if len(proposed_crossings)>=2:break
        if axis.length<75:continue
        for fraction in (.35,.65):
            d=axis.length*fraction;c=axis.interpolate(d);a=axis.interpolate(d-1);b=axis.interpolate(d+1)
            dx,dy=b.x-a.x,b.y-a.y;length=math.hypot(dx,dy)
            if not length:continue
            half=record['widthM']/2+3
            ends=[Point(c.x+side*(-dy/length)*half,c.y+side*(dx/length)*half) for side in (-1,1)]
            if any(not aoi.contains(p) for p in ends):continue
            footpoints=[]
            for p in ends:
                candidates=[]
                for e in data['edges']:
                    if not e['active'] or e['kind']=='crossing':continue
                    q=nearest_points(p,LineString(e['geometry']))[1]
                    if p.distance(q)<5 and not LineString([p,q]).intersects(road_mask.buffer(-.1)):
                        candidates.append((p.distance(q),e['id'],q))
                if not candidates:break
                footpoints.append(min(candidates,key=lambda item:(item[0],item[1]))[2])
            if len(footpoints)!=2:continue
            line=LineString(footpoints)
            if line.length<record['widthM'] or line.length>35 or line.intersects(obstacles) or line.distance(actual_cross_geometry)<30:continue
            if any(line.centroid.distance(p)<100 for p in proposed_crossings):continue
            a,b=[attach((p.x,p.y)) for p in footpoints]
            geometry=LineString([node_record(a)['xy'],node_record(b)['xy']])
            eid=edge(geometry,'crossing',active=False,crossing={'roadId':record['id'],'control':'zebra','waitSeconds':20,'kerbRamps':True,'tactilePaving':True},source={'kind':'proposed_road_crossing'})
            if eid is None:continue
            i=len(proposed_crossings)
            project(f'oc_crossing_{i}',f'Новый переход: {record["name"]}','new_crossing',[{'op':'set_edge_active','targetId':eid,'value':True}],650000)
            proposed_crossings.append(line.centroid)
            if len(proposed_crossings)==2:break
    selected=[]
    for e in sorted(actual_crossings,key=lambda e:-e['lengthM']):
        p=LineString(e['geometry']).centroid
        if all(p.distance(other)>45 for other in selected):
            i=len(selected);selected.append(p)
            project(f'oc_access_{i}',f'Удобный переход {i+1}','accessibility',[{'op':'upgrade_edge','targetId':e['id'],'changes':{'widthM':4,'kerbRamps':True}}],350000+i*90000)
            if len(selected)==4-len(proposed_crossings):break
    # Short courtyard passages are proposed only across geometrically unobstructed land.
    candidates=[]
    active_nodes={e['from'] for e in data['edges'] if e['active']}|{e['to'] for e in data['edges'] if e['active']}
    nodes=[n for n in data['nodes'] if n['id'] in active_nodes]
    tree=STRtree([Point(n['xy']) for n in nodes])
    existing=unary_union([LineString(e['geometry']) for e in data['edges'] if e['active']])
    existing_buffer=existing.buffer(2)
    road_buffer=road_mask.buffer(.1)
    road_park_buffer=road_mask.buffer(7)
    building_park_buffer=obstacles.buffer(4)
    for i,a in enumerate(nodes):
        for j in tree.query(Point(a['xy']).buffer(70)):
            if j<=i:continue
            b=nodes[j]
            d=math.dist(a['xy'],b['xy'])
            if not 24<d<70:continue
            line=LineString([a['xy'],b['xy']])
            if line.intersects(road_buffer) or line.intersects(obstacles) or line.difference(existing_buffer).length<d*.65:continue
            candidates.append((d,a['id'],b['id'],line))
    chosen=[]
    for _,a,b,line in sorted(candidates,key=lambda item:(item[0],item[1],item[2])):
        if any(line.centroid.distance(p)<100 for p in chosen):continue
        identifier=edge(line,'courtyard',active=False,source={'kind':'proposed_courtyard_link'})
        project(f'oc_passage_{len(chosen)}',f'Дворовая связь {len(chosen)+1}','open_passage',[{'op':'set_edge_active','targetId':identifier,'value':True}],450000)
        chosen.append(line.centroid)
        if len(chosen)==2:break
    # Small unoccupied candidate squares; generated proposal geometry, not an asserted cadastral reserve.
    parks=unary_union([Polygon(p['polygon']) for p in data['parcels'] if p['kind']=='public_park'])
    proposals=[]
    for x in range(30,int(aoi.bounds[2])-30,22):
        for y in range(30,int(aoi.bounds[3])-30,22):
            p=box(x-13,y-13,x+13,y+13)
            if p.intersects(building_park_buffer) or p.intersects(road_park_buffer) or p.intersects(parks):continue
            q=nearest_points(p.exterior,existing)[1];g=nearest_points(p.exterior,q)[0];link=LineString([q,g])
            if link.length>18 or link.intersects(road_mask.buffer(.1)) or link.intersects(obstacles):continue
            if any(p.centroid.distance(other)<140 for other in proposals):continue
            pid=f'oc_proposed_park_{len(proposals)}';parcel(pid,p,'vacant','Модель: место возможного сквера')
            anchor=attach((q.x,q.y));gate=node((g.x,g.y),'park_entrance',active=False)
            if link.length<.1:
                g=Point(p.exterior.interpolate(.1,normalized=True));gate=node((g.x,g.y),'park_entrance',active=False);link=LineString([q,g])
            eid=edge(link,'access',active=False,source={'kind':'proposed_park_entrance'})
            did=f'oc_future_park_{len(proposals)}';destination(did,'Новый сквер · проект','park',[gate],pid,active=False,capacity=67)
            identifier=f'oc_green_{len(proposals)}'
            project(identifier,f'Новый сквер {len(proposals)+1}','new_park',[
                {'op':'set_parcel_use','targetId':pid,'kind':'public_park'},{'op':'set_node_active','targetId':gate,'value':True},
                {'op':'set_edge_active','targetId':eid,'value':True},{'op':'set_destination_active','targetId':did,'value':True}],850000,pid=pid)
            project(f'{identifier}_path',f'Покрытие входа в сквер {len(proposals)+1}','accessibility',[{'op':'upgrade_edge','targetId':eid,'changes':{'surface':'asphalt','widthM':3}}],180000,requires=[identifier],pid=pid)
            proposals.append(p.centroid)
            if len(proposals)==2:break
        if len(proposals)==2:break
    # Two compatible alternatives move a stop along the same mapped road and side.
    stops=[d for d in data['destinations'] if d['active'] and d['kind']=='bus_stop']
    if stops:
        stop=stops[0];old=next(b for b in data['stopBays'] if b['id']==stop['stopBayId']);p=Point(node_record(old['nodeId'])['xy'])
        options=[]
        for e in data['edges']:
            if not e['active'] or e['kind']=='crossing':continue
            line=LineString(e['geometry']);q=line.interpolate(.5,normalized=True);d=p.distance(q)
            if 18<d<85 and not LineString([p,q]).intersects(road_mask.buffer(-.3)):
                options.append((d,e['id'],q))
        for i,(_,_,q) in enumerate(sorted(options,key=lambda item:(item[0],item[1]))[:2]):
            n=attach((q.x,q.y));bid=f'oc_alternative_bay_{i}'
            data['stopBays'].append({**old,'id':bid,'nodeId':n,'name':f'Проект переноса остановки {i+1}'})
            project(f'oc_hub_{i}',f'Перенос остановки: вариант {i+1}','relocate_stop',[{'op':'relocate_destination','targetId':stop['id'],'nodeId':n,'stopBayId':bid}],650000+i*120000,group='oc_stop_options')
    ids=[p['id'] for p in data['projects']]
    groups=[[],[i for i in ids if i.startswith(('oc_access','oc_crossing'))], [i for i in ids if i.startswith('oc_passage')],
        [i for i in ids if i.startswith('oc_green')], [i for i in ids if not i.startswith('oc_hub')], [i for i in ids if i=='oc_hub_0']]
    names=['Как сейчас','Удобные переходы','Связность дворов','Зелёные пространства','Комплексный вариант','Перенос остановки']
    for i,(name,chosen) in enumerate(zip(names,groups)):
        data['scenarios'].append({'id':f'oc_scenario_{i}','name':name,'description':'Условный сценарий реального центрального участка.',
            'projectIds':chosen,'budgetRub':8000000,'operationalOverrides':[]})

if __name__=='__main__':
    data,provenance=build()
    from validate_obninsk import validate_geometry
    report=validate_geometry(data)
    write_json(ROOT/'data/obninsk/reports/validation.json',report)
    if not report['valid']:raise SystemExit('\n'.join(report['errors']))
    write_json(ROOT/'data/obninsk-center.json',data)
    write_json(ROOT/'data/obninsk-center.provenance.json',provenance)
    baseline={p['id']:metrics(data,p['id']) for p in data['profiles']}
    write_json(ROOT/'data/obninsk/reports/baseline-metrics.json',baseline)
    comparisons=[]
    for scenario in data['scenarios']:
        district,costs=materialize(data,scenario)
        results={p['id']:metrics(district,p['id']) for p in data['profiles']}
        comparisons.append({'scenarioId':scenario['id'],'costs':costs,'metrics':results,
            'changesFromBaseline':{key:compare_metrics(baseline[key],value) for key,value in results.items()}})
    write_json(ROOT/'data/obninsk/reports/scenario-comparison.json',comparisons)
    for name in ('buildings','roads','edges','parcels','destinations'):
        features=[];nodes={n['id']:n for n in data['nodes']}
        for item in data[name]:
            if name=='destinations':geometry={'type':'Point','coordinates':to_wgs84(nodes[item['accessNodeIds'][0]]['xy'],ORIGIN)}
            elif name=='edges':geometry={'type':'LineString','coordinates':[to_wgs84(p,ORIGIN) for p in item['geometry']]}
            else:geometry={'type':'Polygon','coordinates':[[to_wgs84(p,ORIGIN) for p in item['polygon']]]}
            features.append({'type':'Feature','id':item['id'],'geometry':geometry,'properties':{k:v for k,v in item.items() if k not in ('polygon','geometry','centerline')}})
        write_json(ROOT/f'data/obninsk/geojson/{name}.geojson',{'type':'FeatureCollection','name':name,
            'attribution':'© OpenStreetMap contributors','license':'ODbL-1.0','modelNotice':'Hybrid geometry; population and assumptions are synthetic. See provenance file.','features':features})
    files=[ROOT/'data/obninsk-center.json',ROOT/'data/obninsk-center.provenance.json',SOURCE,ROOT/'data/sources/obninsk-details.osm.json',ROOT/'data/sources/obninsk-details.osm.xml']
    files+=list((ROOT/'data/obninsk').rglob('*.json'))+list((ROOT/'data/obninsk').rglob('*.geojson'))
    write_json(ROOT/'data/obninsk-center.manifest.json',{'datasetId':data['metadata']['id'],'datasetVersion':data['metadata']['datasetVersion'],
        'hashAlgorithm':'sha256','files':[{'path':str(path.relative_to(ROOT/'data')).replace('\\','/'),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(files)]})
    print(json.dumps(provenance['summary'],ensure_ascii=False))
    for warning in provenance['warnings']:print(warning)
