"""Standalone plan for checking/exporting the model; no browser or tile server required."""
import json
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[1]
data=json.loads((ROOT/'data/obninsk-center.json').read_text(encoding='utf-8'))
W,H=1500,1390
image=Image.new('RGB',(W,H),'#f2f4ed');draw=ImageDraw.Draw(image)
font_path='C:/Windows/Fonts/arial.ttf'
def font(size):
    try:return ImageFont.truetype(font_path,size)
    except OSError:return ImageFont.load_default(size=size)
small,text,title=font(14),font(19),font(35)
draw.text((55,30),'ОБНИНСК  /  ЦЕНТР',font=title,fill='#264c42')
draw.text((57,82),'Площадь Преображения · проспект Ленина · Красных Зорь · Лейпунского',font=text,fill='#657a6b')
x0,y0,x1,y1=data['metadata']['boundsM'];scale=min((W-110)/(x1-x0),(H-250)/(y1-y0))
ox=55+(W-110-(x1-x0)*scale)/2;oy=130
def p(point):return(ox+(point[0]-x0)*scale,oy+(y1-point[1])*scale)
for block in data['blocks']:draw.polygon([p(q) for q in block['polygon']],fill='#e3e9dc')
for road in data['roads']:draw.polygon([p(q) for q in road['polygon']],fill='#a8b4b1')
for parcel in data['parcels']:
    if parcel['kind'] in ('public_park','landscaping'):draw.polygon([p(q) for q in parcel['polygon']],fill='#bed3aa',outline='#a8c08e')
for edge in data['edges']:
    if not edge['active']:continue
    draw.line([p(q) for q in edge['geometry']],fill='#c6755c' if edge['kind']=='crossing' else '#f9f5e5',width=4 if edge['kind']=='crossing' else 3)
for building in data['buildings']:
    color='#cbbda8' if building['kind']=='residential' else '#9ebbb7' if building['kind']=='school' else '#b2c3bf'
    draw.polygon([p(q) for q in building['polygon']],fill=color,outline='#7d9081',width=1)
    points=[p(q) for q in building['polygon']];x=sum(q[0] for q in points)/len(points);y=sum(q[1] for q in points)/len(points)
    label=building['name'].split(', ')[-1] if ', ' in building['name'] else 'Ш5' if building['kind']=='school' else 'А' if 'Преображения' in building['name'] else 'Ю' if 'Юбилейная' in building['name'] else ''
    if label:draw.text((x,y),label,font=small,fill='#395747',anchor='mm')
nodes={n['id']:n for n in data['nodes']}
for place in data['destinations']:
    if not place['active']:continue
    x,y=p(nodes[place['accessNodeIds'][0]]['xy'])
    color='#427d90' if place['kind']=='bus_stop' else '#458968' if place['kind']=='park' else '#8e6b93' if place['kind']=='clinic' else '#9f8056'
    draw.ellipse((x-6,y-6,x+6,y+6),fill=color,outline='#f9faf5',width=2)
seen=set()
for road in data['roads']:
    if road['name'] in seen or len(road['centerline'])<2:continue
    seen.add(road['name']);q=road['centerline'][len(road['centerline'])//2];x,y=p(q)
    if 150<x<W-270 and 150<y<H-220:
        box=draw.textbbox((x,y),road['name'],font=small);draw.rectangle((box[0]-4,box[1]-2,box[2]+4,box[3]+2),fill='#f2f4ed');draw.text((x,y),road['name'],font=small,fill='#526f66')
draw.line((W-95,175,W-95,135),fill='#426655',width=3);draw.polygon([(W-102,146),(W-95,130),(W-88,146)],fill='#426655');draw.text((W-95,111),'С',font=text,fill='#426655',anchor='mm')
y=H-135
population=sum((b['population'] or {}).get('total',0) for b in data['buildings'])
draw.text((55,y),f'{len(data["buildings"])} здание · {population:,} условных жителей · 15 отмеченных OSM точек переходов'.replace(',',' '),font=text,fill='#426453')
draw.text((55,y+37),'Контуры зданий и улиц — OSM. Население, входы, часть тротуаров и параметры — учебная модель.',font=small,fill='#697d70')
draw.text((55,y+66),'© OpenStreetMap contributors · ODbL 1.0 · https://www.openstreetmap.org/copyright',font=small,fill='#697d70')
draw.text((55,y+92),'Не является официальным прогнозом или картой для навигации.',font=small,fill='#697d70')
target=ROOT/'data/obninsk/preview/plan.png';target.parent.mkdir(parents=True,exist_ok=True);image.save(target)
print(target)
