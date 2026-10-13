#!/usr/bin/env python3
"""守望：每 1–2 分钟看一眼己方房有没有武装敌人，safe mode 决定有变化就只改 segment 90 里的 rooms[房].safeMode，
其余字段沿用上一份指令（issuedAt 刷新，游戏内才会重新读入）。run.py 每轮也会出同样的决定，这里只是把反应时间从 5 分钟缩到 1–2 分钟；
真正每 tick 的兜底（核心建筑掉血）留在游戏内 tower.js。没有已写入的指令时不写（不能用一份只有 safeMode 的指令把白名单清空）。"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from brain import directive, intel, safemode  # noqa: E402
from brain import run as brain_run  # noqa: E402


def patch_directive(doc, decisions, now_ms=None):
    """把决定写进已有指令：返回 (新文档, 是否有变化)。只改 rooms[房].safeMode"""
    if not isinstance(doc, dict) or 'rooms' not in doc:
        return doc, False
    changed = False
    rooms = doc.setdefault('rooms', {})
    for room, decision in decisions.items():
        entry = rooms.setdefault(room, {})
        previous = entry.get('safeMode') or {}
        if previous.get('action') != decision.get('action') or previous.get('reason') != decision.get('reason') or decision.get('action') == 'activate':
            entry['safeMode'] = decision
            changed = True
    if changed:
        doc['issuedAt'] = int(now_ms or time.time() * 1000)
    return doc, changed


def load_state(path):
    if os.path.exists(path):
        with open(path) as handle:
            return json.load(handle)
    return {}


def run(args, api=None):
    api = api or brain_run.make_api(args)
    me = api.me()
    my_id = str(me.get('_id'))
    tick = api.time()
    memory_rooms = api.memory('rooms') or {}
    homes = [h for h in args.homes.split(',') if h] or brain_run.owned_rooms(api, memory_rooms)
    if not homes:
        raise SystemExit('no home rooms')
    # 只拉己方房的 room-objects，不调 map-stats（限流 429，会拖累 run.py）
    all_intel = intel.collect(api, homes, 0, my_user_id=my_id, tick=tick, map_stats=False)
    decisions = safemode.decide_all(all_intel, homes, tick)
    state_path = os.path.join(args.out, 'guard.json')
    previous = load_state(state_path).get('decisions') or {}
    # 有敌人的房、或上次有敌人这次没了的房才需要写；纯 hold/no-threat 的稳态不碰 segment
    interesting = {room: d for room, d in decisions.items()
                   if d.get('action') == 'activate' or (previous.get(room) or {}).get('action') != d.get('action')
                   or (previous.get(room) or {}).get('reason') != d.get('reason')}
    wrote = '无变化'
    if interesting and args.write and not args.dry_run:
        raw = api.get_segment(directive.SEGMENT)
        doc = None
        try:
            doc = json.loads(raw) if raw else None
        except ValueError:
            doc = None
        if doc:
            doc, changed = patch_directive(doc, interesting)
            if changed:
                size = directive.write(api, doc)
                wrote = 'segment %d，%d 字节，issuedAt %d，改了 %s' % (directive.SEGMENT, size, doc['issuedAt'], ','.join(sorted(interesting)))
        else:
            wrote = '未写入（segment 里没有可修补的指令）'
    os.makedirs(args.out, exist_ok=True)
    state = {'generatedAt': time.time(), 'tick': tick, 'decisions': decisions, 'wrote': wrote, 'apiCalls': api.calls}
    with open(state_path, 'w') as handle:
        json.dump(state, handle, ensure_ascii=False, indent=1)
    return state


def main(argv=None):
    args = brain_run.parse_args(argv)
    state = run(args)
    print(json.dumps({'tick': state['tick'], 'decisions': {room: [d['action'], d['reason']] for room, d in state['decisions'].items()},
                      'wrote': state['wrote'], 'apiCalls': state['apiCalls']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
