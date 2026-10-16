"""Geometry and provenance checks for the real-map model, including every saved scenario."""
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.tools/geo'))
from shapely.geometry import Polygon,LineString,Point
from shapely.ops import unary_union
from shapely.strtree import STRtree
from district_model import materialize,metrics
from dataset_schema import build_schema
from validate_dataset import schema_errors

def validate_geometry(data):
    errors=schema_errors(data,build_schema())
    roads=unary_union([Polygon(r['polygon']) for r in data['roads']]).buffer(-.1)
    buildings=unary_union([Polygon(b['polygon']) for b in data['buildings']]).buffer(-.1)
    for key in ('roads','blocks','parcels','buildings'):
        for item in data[key]:
            polygon=Polygon(item['polygon'])
            if not polygon.is_valid or polygon.area<=0:errors.append(f'Invalid polygon: {item["id"]}')
    scenarios=[]
    for scenario in data['scenarios']:
        district,costs=materialize(data,scenario)
        edges=[e for e in district['edges'] if e['active']]
        lines=[LineString(e['geometry']) for e in edges]
        tree=STRtree(lines)
        by_id={n['id']:n for n in district['nodes']}
        for edge,line in zip(edges,lines):
            if edge['geometry'][0]!=by_id[edge['from']]['xy'] or edge['geometry'][-1]!=by_id[edge['to']]['xy']:
                errors.append(f'{scenario["id"]}: mismatched geometry endpoints {edge["id"]}')
            if abs(line.length-edge['lengthM'])>1e-5 or line.length<.001:
                errors.append(f'{scenario["id"]}: wrong length {edge["id"]}')
            if line.intersection(buildings).length>.15:
                errors.append(f'{scenario["id"]}: walkway through a building {edge["id"]}')
            if edge['kind']!='crossing' and line.intersection(roads).length>.15:
                errors.append(f'{scenario["id"]}: unmarked carriageway crossing {edge["id"]}')
        for i,line in enumerate(lines):
            for j in tree.query(line):
                if j<=i or {edges[i]['from'],edges[i]['to']}&{edges[j]['from'],edges[j]['to']}:continue
                hit=line.intersection(lines[j])
                if hit.geom_type!='Point':continue
                near_i=min(Point(line.coords[0]).distance(hit),Point(line.coords[-1]).distance(hit))
                near_j=min(Point(lines[j].coords[0]).distance(hit),Point(lines[j].coords[-1]).distance(hit))
                if near_i>.12 or near_j>.12:
                    errors.append(f'{scenario["id"]}: intersection without graph node {edges[i]["id"]}/{edges[j]["id"]}')
        scenarios.append({'id':scenario['id'],'activeEdges':len(edges),'costs':costs,
            'population':sum((b['population'] or {}).get('total',0) for b in district['buildings'])})
    return {'valid':not errors,'errors':errors,'scenarios':scenarios,
        'geometryToleranceM':.15,'nodeMergeToleranceM':.05,
        'scope':'Stored building footprints and road carriageway polygons, all six catalogue scenarios; source fences are not certified.',
        'notAnOfficialForecast':True}

if __name__=='__main__':
    data=json.loads((ROOT/'data/obninsk-center.json').read_text(encoding='utf-8'))
    report=validate_geometry(data)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    raise SystemExit(0 if report['valid'] else 1)
