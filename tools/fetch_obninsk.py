"""Refresh public OSM source snapshots explicitly. Cached files are reused by default."""
import argparse
import json
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
TARGET=ROOT/'data/sources'
AGENT='DimkiAI-local-study/0.2 (https://github.com/Serghei-S/Dimki_AI)'
def get(url,body=None):
    request=Request(url,data=body,headers={'User-Agent':AGENT})
    with urlopen(request,timeout=90) as response:return response.read()
def save(path,raw):
    pending=path.with_suffix(path.suffix+'.tmp');pending.write_bytes(raw);pending.replace(path)
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--refresh',action='store_true');args=parser.parse_args()
    target=TARGET/'obninsk-center.osm.json'
    if not target.exists() or args.refresh:
        query=(TARGET/'obninsk-center.overpass').read_text(encoding='utf-8')
        raw=get('https://overpass-api.de/api/interpreter',urlencode({'data':query}).encode())
        record=json.loads(raw)
        if record.get('remark'):raise RuntimeError(record['remark'])
        save(target,raw)
    xml_path=TARGET/'obninsk-details.osm.xml'
    if not xml_path.exists() or args.refresh:
        raw=get('https://api.openstreetmap.org/api/0.6/map?bbox=36.606,55.089,36.619,55.0955')
        ET.fromstring(raw);save(xml_path,raw)
    root=ET.fromstring(xml_path.read_bytes());nodes={e.attrib['id']:e for e in root.findall('node')};elements=[]
    for e in root:
        if e.tag not in ('node','way'):continue
        tags={x.attrib['k']:x.attrib['v'] for x in e.findall('tag')}
        if not(tags.get('landuse')=='grass' or tags.get('leisure') or tags.get('entrance') or tags.get('barrier') in ('gate','entrance','fence')):continue
        record={'type':e.tag,'id':int(e.attrib['id']),'tags':tags}
        if e.tag=='node':record.update(lat=float(e.attrib['lat']),lon=float(e.attrib['lon']))
        else:
            refs=[n.attrib['ref'] for n in e.findall('nd')]
            if any(n not in nodes for n in refs):continue
            record['nodes']=[int(n) for n in refs];record['geometry']=[{'lat':float(nodes[n].attrib['lat']),'lon':float(nodes[n].attrib['lon'])} for n in refs]
        elements.append(record)
    details={'version':.6,'generator':'OSM API 0.6 map, filtered from cached XML','osm3s':{'timestamp_osm_base':root.find('meta').attrib.get('osm_base') if root.find('meta') is not None else '2026-10-16'},'elements':elements}
    save(TARGET/'obninsk-details.osm.json',json.dumps(details,ensure_ascii=False,indent=2).encode())
    print('Source snapshots ready. Rebuild and validate before using refreshed data; scenarios are content-fingerprinted.')
