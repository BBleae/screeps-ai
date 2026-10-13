#!/usr/bin/env python3
"""分析候选房间地形：评分每个可放置 spawn 的位置。用法: python3 scripts/pick_spawn.py ROOM1 ROOM2 ..."""
import json, sys, os, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = [l.split('=',1)[1].strip() for l in open(os.path.join(ROOT,'.env')) if l.startswith('SCREEPS_AUTH_TOKEN')][0]

def api(path):
    import subprocess
    for attempt in range(4):
        try:
            out = subprocess.run(['curl','-s','-m','30','-H','X-Token: '+TOKEN,
                                  'https://screeps.com'+path], capture_output=True, text=True, timeout=40).stdout
            return json.loads(out)
        except Exception as e:
            if attempt == 3: raise
            print(f'retry {attempt+1} {path}: {e}', file=sys.stderr)
            time.sleep(3+attempt*4)

def objects(room):
    d = api(f'/api/game/room-objects?room={room}&shard=shard1')
    objs = d.get('objects') or []
    srcs = [(o['x'],o['y']) for o in objs if o.get('type')=='source']
    mineral = next(((o['x'],o['y'],o.get('mineralType')) for o in objs if o.get('type')=='mineral'), None)
    return srcs, mineral

def terrain(room):
    d = api(f'/api/game/room-terrain?room={room}&shard=shard1')
    grid = [[0]*50 for _ in range(50)]  # 默认平地
    for e in d['terrain']:
        grid[e['y']][e['x']] = 1 if e['type']=='wall' else (2 if e['type']=='swamp' else 0)
    return grid

def score_room(room):
    srcs, mineral = objects(room)
    g = terrain(room)
    def blocked(x,y): return x<3 or x>46 or y<3 or y>46 or g[y][x]==1
    best = None
    for y in range(5,45):
        for x in range(5,45):
            if g[y][x]!=0: continue
            # 半径3内平地数(基建空间) + 半径4内墙数惩罚
            open3 = sum(1 for dy in range(-3,4) for dx in range(-3,4)
                        if 0<=x+dx<50 and 0<=y+dy<50 and g[y+dy][x+dx]!=1)
            if open3 < 40: continue  # 基建空间不足
            dmin = min(((x-sx)**2+(y-sy)**2)**.5 for sx,sy in srcs)
            # 源太近(<2.5)或太远(>25)都不好; 沼泽惩罚
            swamp = sum(1 for dy in range(-3,4) for dx in range(-3,4)
                        if 0<=x+dx<50 and 0<=y+dy<50 and g[y+dy][x+dx]==2)
            s = open3*3 - swamp*2 - abs(dmin-12)*6 - ((x-25)**2+(y-25)**2)**.5*0.5
            if best is None or s > best[0]:
                best = (s, x, y, round(dmin,1))
    if best:
        s, x, y, dmin = best
        print(f"{room}: srcs={srcs} mineral={mineral[2] if mineral else '-'} "
              f"-> spawn({x},{y}) score={s:.0f} 源距={dmin} 平地r3={sum(1 for dy in range(-3,4) for dx in range(-3,4) if 0<=x+dx<50 and 0<=y+dy<50 and g[y+dy][x+dx]!=1)}")
    return {'room':room, 'srcs':srcs, 'mineral':mineral, 'best':best}

for room in sys.argv[1:]:
    score_room(room)
