#!/usr/bin/env python3
"""抓取线上房间快照（地形、对象、我方建筑、Memory 里的 plan/外矿/大脑白名单），供私服 soak 模拟复现。

用法: python3 scripts/soak/capture_live.py [--rooms W33S7,W34S7,W32S7,W33S6,W33S8,W35S7] [--out data/soak/live_snapshot.json]
"""
import argparse
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from brain.api import ScreepsApi, load_env  # noqa: E402
from probe import read_memory  # noqa: E402

KEEP_FIELDS = ('_id', 'type', 'x', 'y', 'hits', 'hitsMax', 'level', 'progress', 'progressTotal', 'user', 'energy', 'energyCapacity',
               'mineralType', 'mineralAmount', 'store', 'storeCapacity', 'storeCapacityResource', 'structureType', 'name',
               'reservation', 'safeMode', 'safeModeAvailable', 'ticksToRegeneration', 'density', 'cooldown', 'isPublic')


def room_xy(name):
    match = re.match(r'^([WE])(\d+)([NS])(\d+)$', name)
    if not match:
        raise ValueError('bad room name %s' % name)
    x = -int(match.group(2)) - 1 if match.group(1) == 'W' else int(match.group(2))
    y = -int(match.group(4)) - 1 if match.group(3) == 'N' else int(match.group(4))
    return x, y


def xy_room(x, y):
    return ('W%d' % (-x - 1) if x < 0 else 'E%d' % x) + ('N%d' % (-y - 1) if y < 0 else 'S%d' % y)


def ring_rooms(centers, ring):
    """centers 周围切比雪夫距离 ≤ ring 的房间名（含 centers），保证私服里跨房路径存在。"""
    out = []
    for center in centers:
        cx, cy = room_xy(center)
        for dx in range(-ring, ring + 1):
            for dy in range(-ring, ring + 1):
                name = xy_room(cx + dx, cy + dy)
                if name not in out:
                    out.append(name)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rooms', default='W33S7,W34S7,W32S7,W33S6,W33S8,W35S7')
    parser.add_argument('--homes', default='W33S7,W34S7')
    parser.add_argument('--ring', type=int, default=2, help='额外抓母房周围 ring 圈房间的地形/中立对象（两跳外矿要能走通）')
    parser.add_argument('--out', default=os.path.join(ROOT, 'data', 'soak', 'live_snapshot.json'))
    args = parser.parse_args()
    env = load_env(ROOT)
    token = env.get('SCREEPS_AUTH_TOKEN')
    if not token:
        raise SystemExit('missing SCREEPS_AUTH_TOKEN in .env')
    api = ScreepsApi('https://screeps.com', token, shard='shard1', cache_dir=os.path.join(ROOT, 'data', 'soak', 'cache'))
    try:
        me = api.cached_get('/api/auth/me', {}, 60)
    except Exception:  # noqa: BLE001
        me = {}
    my_id = me.get('_id') if isinstance(me, dict) else None
    snapshot = {'capturedAt': time.strftime('%Y-%m-%d %H:%M:%S'), 'tick': api.time(), 'me': my_id, 'rooms': {}}
    focus = [r for r in args.rooms.split(',') if r]
    homes = [r for r in args.homes.split(',') if r]
    rooms = list(focus)
    for room in ring_rooms(homes, args.ring) if args.ring > 0 else []:
        if room not in rooms:
            rooms.append(room)
    snapshot['focus'] = focus
    for room in rooms:
        terrain = api.room_terrain(room)
        payload = api.room_objects(room) or {}
        objects = []
        for obj in payload.get('objects') or []:
            if obj.get('type') == 'creep':
                continue
            objects.append({k: obj[k] for k in KEEP_FIELDS if k in obj})
        snapshot['rooms'][room] = {'terrain': terrain, 'objects': objects, 'users': payload.get('users')}
    snapshot['memory'] = {
        'rooms': {room: read_memory('rooms.' + room) for room in ('W33S7', 'W34S7')},
        'brain': read_memory('brain'),
        'roomPlanner': read_memory('roomPlanner'),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as handle:
        json.dump(snapshot, handle, ensure_ascii=False)
    summary = {room: {'terrain': len(entry['terrain'] or ''), 'objects': len(entry['objects'])} for room, entry in snapshot['rooms'].items()}
    print(json.dumps({'out': args.out, 'tick': snapshot['tick'], 'rooms': summary}, ensure_ascii=False))


if __name__ == '__main__':
    main()
