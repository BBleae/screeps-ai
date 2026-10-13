#!/usr/bin/env python3
"""顶级玩家持续观察：capture（抓快照）→ analyze（摘要）→ report（docs/observe/<player>.md）。

用法：
  python3 scripts/observe/run.py all --player Kalgen            # 抓一轮 + 分析 + 报告（launchd 用这个）
  python3 scripts/observe/run.py capture --player Kalgen --history 3 --remotes 6
  python3 scripts/observe/run.py analyze --player Kalgen [--snapshot <目录>]   # 只重新分析（默认最新快照）
  python3 scripts/observe/run.py report --player Kalgen                       # 只重渲染报告
  python3 scripts/observe/run.py all --player Kalgen --self                   # 同时记录我方账号同口径速率

产物：data/observe/<player>/snapshots/<UTC>/（原始 + summary.json）、data/observe/<player>/timeline.jsonl、
     docs/observe/<player 小写>.md。
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brain.api import ScreepsApi, load_env  # noqa: E402
from observe import analyze, report  # noqa: E402
from observe.capture import Capture  # noqa: E402


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['capture', 'analyze', 'report', 'all'])
    parser.add_argument('--player', default='Kalgen')
    parser.add_argument('--out', default=os.path.join(ROOT, 'data', 'observe'))
    parser.add_argument('--docs', default=os.path.join(ROOT, 'docs', 'observe'))
    parser.add_argument('--snapshot', default=None, help='analyze/report 用哪个快照目录（默认最新）')
    parser.add_argument('--history', type=int, default=3, help='每轮抓多少个房的 room-history')
    parser.add_argument('--remotes', type=int, default=6, help='每轮抓多少个外矿房')
    parser.add_argument('--room-limit', type=int, default=0, help='>0 时每轮只轮转抓这么多己方房（默认全部）')
    parser.add_argument('--self', dest='include_self', action='store_true', help='同时记录我方账号同口径 stats')
    parser.add_argument('--maps', type=int, default=2, help='报告里附几张 ASCII 布局图')
    parser.add_argument('--min-interval', type=float, default=0.4)
    parser.add_argument('--token', default=None)
    return parser.parse_args(argv)


def make_api(args):
    env = load_env(ROOT)
    token = args.token or env.get('SCREEPS_AUTH_TOKEN')
    if not token:
        raise SystemExit('缺少 SCREEPS_AUTH_TOKEN（.env）')
    return ScreepsApi('https://screeps.com', token, cache_dir=os.path.join(args.out, 'cache'),
                      min_interval=args.min_interval)


def player_dir(args):
    return os.path.join(args.out, args.player)


def latest_snapshot(args):
    base = os.path.join(player_dir(args), 'snapshots')
    if not os.path.isdir(base):
        return None
    names = sorted(name for name in os.listdir(base) if os.path.isdir(os.path.join(base, name)))
    return os.path.join(base, names[-1]) if names else None


def previous_summary(args, current_dir):
    base = os.path.join(player_dir(args), 'snapshots')
    names = sorted(name for name in os.listdir(base) if os.path.isdir(os.path.join(base, name)))
    current = os.path.basename(current_dir)
    for name in reversed(names):
        if name >= current:
            continue
        path = os.path.join(base, name, 'summary.json')
        if os.path.exists(path):
            with open(path) as handle:
                return json.load(handle)
    return None


def _load(path):
    with open(path) as handle:
        return json.load(handle)


def analyze_snapshot(args, snap_dir, api=None):
    profile = _load(os.path.join(snap_dir, 'profile.json'))
    manifest = _load(os.path.join(snap_dir, 'manifest.json'))
    stats = _load(os.path.join(snap_dir, 'stats.json'))
    self_stats_path = os.path.join(snap_dir, 'self_stats.json')
    self_stats = _load(self_stats_path) if os.path.exists(self_stats_path) else None
    uid = profile['id']

    # 主 shard 的 tick 秒数：按房间数最多的 shard
    rooms_by_shard = profile.get('roomsByShard') or {}
    main_shard = max(rooms_by_shard, key=lambda s: len(rooms_by_shard[s])) if rooms_by_shard else None
    tick_seconds = ((profile.get('shards') or {}).get(main_shard) or {}).get('tickSeconds') or 0
    rates = {interval: analyze.derive_rates(stats.get(interval) or {}, profile.get('rooms') or 0, tick_seconds,
                                            int(interval)) for interval in stats}
    self_rates = None
    if self_stats:
        self_rooms = manifest.get('selfRooms') or 0
        self_tick = ((profile.get('shards') or {}).get('shard1') or {}).get('tickSeconds') or 0
        self_rates = {interval: analyze.derive_rates(self_stats.get(interval) or {}, self_rooms, self_tick,
                                                     int(interval)) for interval in self_stats}

    room_summaries = []
    objects_dir = os.path.join(snap_dir, 'objects')
    for name in sorted(os.listdir(objects_dir)):
        shard, room = name[:-5].split('__', 1)
        objs = _load(os.path.join(objects_dir, name)).get('objects') or []
        room_summaries.append(analyze.summarize_room(shard, room, objs, uid))
    remote_summaries = []
    remotes_dir = os.path.join(snap_dir, 'remotes')
    for name in sorted(os.listdir(remotes_dir)):
        shard, room = name[:-5].split('__', 1)
        data = _load(os.path.join(remotes_dir, name))
        entry = analyze.summarize_remote_room(shard, room, data.get('objects') or [], uid, data.get('gameTime'))
        entry['home'] = data.get('home')
        remote_summaries.append(entry)
    histories = []
    history_dir = os.path.join(snap_dir, 'history')
    for name in sorted(os.listdir(history_dir)):
        histories.append(analyze.summarize_history(_load(os.path.join(history_dir, name)), uid))

    summary = {
        'player': args.player, 'capturedAt': manifest.get('capturedAt'), 'snapshot': os.path.basename(snap_dir),
        'profile': {'id': uid, 'gcl': profile.get('gcl'), 'power': profile.get('power'), 'rooms': profile.get('rooms'),
                    'roomsByShard': rooms_by_shard, 'ranks': profile.get('ranks'), 'mainShard': main_shard,
                    'tickSeconds': tick_seconds},
        'rates': rates, 'selfRates': self_rates,
        'aggregate': analyze.aggregate_rooms(room_summaries),
        'archetypes': analyze.aggregate_archetypes(room_summaries),
        'remotes': analyze.remotes_from_creeps(room_summaries),
        'remoteRooms': remote_summaries,
        'roomList': room_summaries,
        'history': histories,
        'apiCalls': manifest.get('apiCalls'),
    }
    summary['diff'] = analyze.diff_summaries(previous_summary(args, snap_dir), summary)
    with open(os.path.join(snap_dir, 'summary.json'), 'w') as handle:
        json.dump(summary, handle, separators=(',', ':'))
    with open(os.path.join(player_dir(args), 'timeline.jsonl'), 'a') as handle:
        handle.write(json.dumps(report.timeline_entry(summary)) + '\n')
    return summary


def ascii_maps(args, snap_dir, summary, api):
    """给报告挑几个房画 ASCII 图：优先 history 里的房，其次 creep 最多的房。地形走磁盘缓存。"""
    maps = {}
    if args.maps <= 0:
        return maps
    picks = [(h.get('shard') or _shard_of(summary, h.get('room')), h.get('room')) for h in summary.get('history') or []]
    picks += [(r['shard'], r['room']) for r in sorted(summary.get('roomList') or [],
                                                     key=lambda r: -r['creeps']['count'])]
    seen = set()
    for shard, room in picks:
        if not shard or not room or (shard, room) in seen:
            continue
        seen.add((shard, room))
        path = os.path.join(snap_dir, 'objects', '%s__%s.json' % (shard, room))
        if not os.path.exists(path):
            continue
        objs = _load(path).get('objects') or []
        terrain = None
        if api is not None:
            try:
                payload = api.cached_get('/api/game/room-terrain', {'room': room, 'shard': shard, 'encoded': 1},
                                         30 * 24 * 3600)
                terrain = ((payload.get('terrain') or [{}])[0]).get('terrain')
            except Exception as error:  # noqa: BLE001 —— 地形只是装饰，失败不影响报告
                print('[observe] terrain %s/%s failed: %s' % (shard, room, error))
        maps['%s/%s' % (shard, room)] = analyze.render_ascii(objs, terrain)
        if len(maps) >= args.maps:
            break
    return maps


def _shard_of(summary, room):
    for shard, rooms in (summary.get('profile') or {}).get('roomsByShard', {}).items():
        if room in rooms:
            return shard
    return None


def write_report(args, snap_dir, summary, api):
    timeline = []
    path = os.path.join(player_dir(args), 'timeline.jsonl')
    if os.path.exists(path):
        with open(path) as handle:
            for line in handle:
                line = line.strip()
                if line:
                    timeline.append(json.loads(line))
    text = report.render_markdown(summary, timeline=timeline, ascii_maps=ascii_maps(args, snap_dir, summary, api))
    os.makedirs(args.docs, exist_ok=True)
    out = os.path.join(args.docs, '%s.md' % args.player.lower())
    with open(out, 'w') as handle:
        handle.write(text)
    print('[observe] report -> %s' % out)
    return out


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    api = make_api(args)
    snap_dir = args.snapshot
    if args.command in ('capture', 'all'):
        self_id = None
        if args.include_self:
            me = api.me()
            self_id = me.get('_id')
        capture = Capture(api, args.player, player_dir(args), history_n=args.history, remotes_n=args.remotes,
                          include_self=args.include_self, self_id=self_id)
        snap_dir = capture.run(all_rooms=args.room_limit <= 0, room_limit=args.room_limit)
        if args.include_self:
            rooms = api.get('/api/user/rooms', {'id': self_id}).get('shards') or {}
            manifest_path = os.path.join(snap_dir, 'manifest.json')
            manifest = _load(manifest_path)
            manifest['selfRooms'] = sum(len(v) for v in rooms.values())
            manifest['selfId'] = self_id
            with open(manifest_path, 'w') as handle:
                json.dump(manifest, handle, indent=1)
    if snap_dir is None:
        snap_dir = latest_snapshot(args)
    if snap_dir is None:
        raise SystemExit('没有快照：先跑 capture')
    summary = None
    if args.command in ('analyze', 'all'):
        summary = analyze_snapshot(args, snap_dir, api)
        print('[observe] analyzed %s: rooms=%d archetypes=%d histories=%d' % (
            os.path.basename(snap_dir), len(summary['roomList']),
            sum(len(v) for v in summary['archetypes'].values()), len(summary['history'])))
    if args.command in ('report', 'all'):
        if summary is None:
            path = os.path.join(snap_dir, 'summary.json')
            if not os.path.exists(path):
                summary = analyze_snapshot(args, snap_dir, api)
            else:
                summary = _load(path)
        write_report(args, snap_dir, summary, api)
    return 0


if __name__ == '__main__':
    sys.exit(main())
