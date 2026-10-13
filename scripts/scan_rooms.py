#!/usr/bin/env python3
"""扫描候选 respawn 房间：源数量、矿物类型、归属状态。用法: python3 scripts/scan_rooms.py W35 S3 2"""
import json, sys, time, urllib.request, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = [l.split('=',1)[1].strip() for l in open(os.path.join(ROOT,'.env')) if l.startswith('SCREEPS_AUTH_TOKEN')][0]

def api(path):
    req = urllib.request.Request('https://screeps.com'+path, headers={'X-Token': TOKEN})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def parse_room(name):  # W35S5 -> (35, 5)  以西/以南为正
    import re
    m = re.match(r'([WE])(\d+)([NS])(\d+)', name)
    we, x, ns, y = m.group(1), int(m.group(2)), m.group(3), int(m.group(4))
    return (x if we=='W' else -x-1, y if ns=='S' else -y-1)

def room_name(wx, wy):
    return f"W{wx}S{wy}" if wx>=0 else f"E{-wx-1}N{-wy-1}"

cx, cy = int(sys.argv[1]), int(sys.argv[2])
radius = int(sys.argv[3]) if len(sys.argv)>3 else 2
results = []
for dx in range(-radius, radius+1):
    for dy in range(-radius, radius+1):
        name = room_name(cx+dx, cy+dy)
        try:
            st = api(f'/api/game/room-status?room={name}&shard=shard1').get('room', {})
            ro = api(f'/api/game/room-objects?room={name}&shard=shard1')
        except Exception as e:
            print(f'{name}: ERROR {e}', file=sys.stderr); continue
        objs = ro.get('objects') or []
        sources = [(o['x'],o['y']) for o in objs if o.get('type')=='source']
        mineral = next((o.get('mineralType') for o in objs if o.get('type')=='mineral'), None)
        # SK 房特征: 3 源; highway: 0 源
        r = {'room': name, 'status': st.get('status'), 'respawnArea': bool(st.get('respawnArea')),
             'sources': len(sources), 'srcPos': sources, 'mineral': mineral,
             'sk': len(sources)==3, 'otherStructs': sum(1 for o in objs if o.get('type') not in ('source','mineral','controller','extractor'))}
        results.append(r)
        time.sleep(0.55)

json.dump(results, open(os.path.join(ROOT,'tmp_scan.json'),'w'), ensure_ascii=False, indent=1)
for r in sorted(results, key=lambda r:(-r['sources'], r['room'])):
    tag = 'SK!' if r['sk'] else ('hwy' if r['sources']==0 else '')
    print(f"{r['room']:>7}  src={r['sources']}  mineral={r['mineral']}  status={r['status']:<8} respawnArea={r['respawnArea']} structs={r['otherStructs']:>2}  {tag}")
