"""Render a self-contained SVG map for human quality review, no dependencies."""
from __future__ import annotations

import argparse
from html import escape
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from district_model import metrics

ROOT = Path(__file__).resolve().parents[1]


def render(data):
    width, height = 1680, 1430
    scale, left, top = 1.08, 112, 160
    xmin, ymin, xmax, ymax = data['metadata']['boundsM']
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
             '<style>text{font-family:Arial,sans-serif;fill:#193246}.small{font-size:13px}.label{font-size:12px;font-weight:700;text-anchor:middle}</style>',
             f'<rect width="{width}" height="{height}" fill="#f6f8fa"/>']

    def xy(p):
        return left + (p[0] - xmin) * scale, top + (ymax - p[1]) * scale

    def text(x, y, value, size=16, fill='#193246', anchor='start', weight='normal'):
        parts.append(f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size}" style="fill:{fill}" text-anchor="{anchor}" font-weight="{weight}">{escape(str(value))}</text>')

    def line(points, color, thickness=2, dash=None):
        points_string = ' '.join(f'{a:.2f},{b:.2f}' for a, b in map(xy, points))
        dashed = f' stroke-dasharray="{dash}"' if dash else ''
        parts.append(f'<polyline points="{points_string}" fill="none" stroke="{color}" stroke-width="{thickness}" stroke-linecap="round" stroke-linejoin="round"{dashed}/>')

    def polygon(ring, fill, stroke='none', dash=None):
        points_string = ' '.join(f'{a:.2f},{b:.2f}' for a, b in map(xy, ring))
        dashed = f' stroke-dasharray="{dash}"' if dash else ''
        parts.append(f'<polygon points="{points_string}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"{dashed}/>')

    def circle(point, radius, fill, stroke='#fff'):
        x, y = xy(point)
        parts.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')

    text(112, 61, 'Обнинск 2040', 38, weight='bold')
    text(112, 96, 'Учебный район «Сосновый» · карта исходных данных', 23)
    text(112, 130, 'Полностью синтетическая геометрия и население. Существующие улицы и жители города не воспроизводятся.', 16, '#5d7180')
    for block in data['blocks']:
        polygon(block['polygon'], '#edf0e8', '#dce3d9')
    for road in data['roads']:
        polygon(road['polygon'], '#d8e0e8')
    for parcel in data['parcels']:
        if parcel['kind'] == 'public_park':
            polygon(parcel['polygon'], '#d1e6bf', '#9abe83')
        elif parcel['kind'] == 'vacant':
            polygon(parcel['polygon'], '#f3ecf9', '#a47fc0', '5 4')
        elif parcel['fence']:
            polygon(parcel['polygon'], '#e9e2f3', '#836c9c', '3 3')
    for edge in data['edges']:
        if not edge['active']:
            line(edge['geometry'], '#ba8435', 3, '6 5')
        elif edge['kind'] == 'crossing':
            line(edge['geometry'], '#78909c', 7)
            line(edge['geometry'], '#fff', 4, '3 4')
        else:
            line(edge['geometry'], '#fff', 7)
            line(edge['geometry'], '#a4b0b8', 1.8)
    park_stats = metrics(data, 'walk')
    building_stats = {b['buildingId']: b for b in park_stats['perBuilding']}
    nodes = {n['id']: n for n in data['nodes']}
    colors = ['#79b68a', '#c1ce75', '#e4b46c', '#ce8974']
    for building in data['buildings']:
        if building['population']:
            seconds = building_stats[building['id']]['destinations']['park']['travelSeconds']
            fill = colors[0 if seconds <= 300 else 1 if seconds <= 600 else 2 if seconds <= 900 else 3]
        else:
            fill = '#9c92bd'
        polygon(building['polygon'], fill, '#667d86')
        ring = building['polygon']
        center = [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2]
        x, y = xy(center)
        label = building['name'].replace('Жилой дом ', 'Д') if building['population'] else {'school': 'Школа', 'grocery': 'Магазин', 'clinic': 'Клиника', 'community': 'Центр'}[building['kind']]
        text(x, y + 4, label, 12, anchor='middle', weight='bold')
        for entrance in building['entranceNodeIds']:
            circle(nodes[entrance]['xy'], 3, '#fff', '#506b75')
    for node in data['nodes']:
        if node['kind'] == 'park_entrance':
            circle(node['xy'], 4, '#427f4e' if node['active'] else '#a47fc0')
        elif node['kind'] == 'gate':
            circle(node['xy'], 4, '#806293')
    for edge in data['edges']:
        if edge['stairs']:
            a, b = edge['geometry'][0], edge['geometry'][-1]
            mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
            circle(mid, 9, '#9d5b56')
            xx, yy = xy(mid)
            text(xx, yy + 4, 'С', 11, '#fff', 'middle', 'bold')
        if edge['crossing'] and not edge['crossing']['kerbRamps']:
            a, b = edge['geometry'][0], edge['geometry'][-1]
            circle([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 5, '#c3685b')
    for destination in data['destinations']:
        if destination['kind'] == 'bus_stop' and destination['active']:
            p = nodes[destination['accessNodeIds'][0]]['xy']
            circle(p, 12, '#357fa6')
            xx, yy = xy(p)
            text(xx, yy + 4, 'А', 13, '#fff', 'middle', 'bold')
    for d in data['destinations']:
        if d['kind'] != 'park':
            continue
        parcel = next(p for p in data['parcels'] if p['id'] == d['parcelId'])
        ring = parcel['polygon']
        point = [(ring[0][0] + ring[2][0]) / 2, ring[2][1] - 19]
        xx, yy = xy(point)
        text(xx, yy, 'Сосновый парк' if d['id'] == 'park_main' else 'Сквер' if d['active'] else 'Резерв',
             18 if d['id'] == 'park_main' else 12, '#47734b' if d['active'] else '#8a67a5', 'middle', 'bold')
    # Local scale and north arrow are independent of geographic basemap services.
    xx, yy = xy([40, 915])
    text(xx, yy, 'С ↑', 18, weight='bold')
    xx, yy = xy([1030, 30])
    parts.append(f'<path d="M {xx} {yy} h {200 * scale}" stroke="#193246" stroke-width="3"/>')
    text(xx + 100 * scale, yy - 10, '200 м', 14, anchor='middle')
    legend_y = 1325
    text(112, 1290, 'Цвет жилых домов — время пешком до ближайшего существующего парка', 18, weight='bold')
    for i, label in enumerate(['до 5 минут', '5–10 минут', '10–15 минут', 'более 15 минут']):
        xx = 112 + i * 220
        parts.append(f'<rect x="{xx}" y="{legend_y - 16}" width="23" height="20" rx="3" fill="{colors[i]}"/>')
        text(xx + 34, legend_y, label, 15)
    text(1030, 1325, 'А — остановка · С — ступени', 15)
    homes = [b for b in data['buildings'] if b['population']]
    residents = f'{sum(b["population"]["total"] for b in homes):,}'.replace(',', ' ')
    text(112, 1374, f'{len(data["blocks"])} кварталов · {len(homes)} жилых домов · {residents} жителей · {len(data["nodes"])} узлов · {len(data["edges"])} участков', 17)
    text(112, 1403, 'Пунктир — закрытая или проектная связь; фиолетовый участок — резерв под сквер. Расчёт ведётся по сети, в метрах.', 14, '#5d7180')
    parts.append('</svg>')
    return '\n'.join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, default=ROOT / 'data' / 'district.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'data' / 'preview' / 'district.svg')
    args = parser.parse_args()
    data = json.loads(args.data.read_text(encoding='utf-8'))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(data), encoding='utf-8', newline='\n')
    print(args.output)


if __name__ == '__main__':
    main()
