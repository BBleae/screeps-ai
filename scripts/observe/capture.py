"""拉取一轮玩家快照：账号、房间、map-stats、stats、room-objects、room-history、外矿房。只读，不需要对方授权。

快照目录：data/observe/<player>/snapshots/<UTC 时间>/
  manifest.json   本轮抓了什么、用了多少请求
  profile.json    /api/user/find + leaderboard + rooms + shards
  mapstats.json   {shard: map-stats.stats}
  stats.json      {interval: stats}（全 shard 汇总；creepsProduced 是部件数）
  self_stats.json 我方账号同口径（--self）
  objects/<shard>__<room>.json
  history/<shard>__<room>__<tick>.json
  remotes/<shard>__<room>.json
"""
import gzip
import io
import json
import os
import time
import urllib.error
import urllib.request

from brain.api import ApiError

HISTORY_BASE = 'https://screeps.com/room-history'
STAT_INTERVALS = (8, 180, 1440)


def utc_stamp(now=None):
    return time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(now if now is not None else time.time()))


def fetch_history(shard, room, tick, opener=None, timeout=30):
    """公开的 room-history：tick 取整百；返回 dict 或 None（404 / 未归档）。响应通常是 gzip。"""
    tick = int(tick) // 100 * 100
    url = '%s/%s/%s/%d.json' % (HISTORY_BASE, shard, room, tick)
    request = urllib.request.Request(url, headers={'Accept-Encoding': 'gzip'})
    open_fn = opener or urllib.request.urlopen
    try:
        with open_fn(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise ApiError('room-history %s/%s/%d -> HTTP %s' % (shard, room, tick, error.code))
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    if not raw.strip():
        return None
    return json.loads(raw.decode())


class Capture:
    def __init__(self, api, player, out_dir, history_n=3, remotes_n=6, history_lag=300, include_self=False,
                 self_id=None, log=print):
        self.api = api
        self.player = player
        self.out_dir = out_dir
        self.history_n = history_n
        self.remotes_n = remotes_n
        self.history_lag = history_lag
        self.include_self = include_self
        self.self_id = self_id
        self.log = log
        self.state_path = os.path.join(out_dir, 'state.json')
        self.state = self._load_state()

    # ---- 状态（轮转游标） ----
    def _load_state(self):
        try:
            with open(self.state_path) as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return {'historyCursor': 0, 'remoteCursor': 0}

    def _save_state(self):
        os.makedirs(self.out_dir, exist_ok=True)
        with open(self.state_path, 'w') as handle:
            json.dump(self.state, handle, indent=1)

    # ---- 账号级 ----
    def profile(self):
        user = self.api.get('/api/user/find', {'username': self.player}).get('user') or {}
        if not user.get('_id'):
            raise ApiError('player not found: %s' % self.player)
        uid = user['_id']
        rooms = self.api.get('/api/user/rooms', {'id': uid}).get('shards') or {}
        ranks = {}
        for mode in ('world', 'power'):
            entries = self.api.get('/api/leaderboard/find', {'username': self.player, 'mode': mode}).get('list') or []
            if entries:
                latest = sorted(entries, key=lambda e: e.get('season') or '')[-1]
                ranks[mode] = {'season': latest.get('season'), 'rank': latest.get('rank'), 'score': latest.get('score')}
        shards = {}
        for shard in self.api.get('/api/game/shards/info').get('shards') or []:
            shards[shard['name']] = {'tickSeconds': round((shard.get('tick') or 0) / 1000.0, 3),
                                     'rooms': shard.get('rooms'), 'users': shard.get('users')}
        owned = {shard: sorted(names) for shard, names in rooms.items() if names}
        return {'username': user.get('username'), 'id': uid, 'gcl': user.get('gcl'), 'power': user.get('power'),
                'roomsByShard': owned, 'rooms': sum(len(v) for v in owned.values()), 'ranks': ranks,
                'shards': shards}

    def stats(self, uid):
        result = {}
        for interval in STAT_INTERVALS:
            result[str(interval)] = self.api.get('/api/user/stats', {'id': uid, 'interval': interval}).get('stats') or {}
        return result

    def map_stats(self, rooms_by_shard):
        result = {}
        for shard, rooms in rooms_by_shard.items():
            payload = self.api.post('/api/game/map-stats', {'rooms': rooms, 'statName': 'owner0', 'shard': shard})
            result[shard] = {'gameTime': payload.get('gameTime'), 'stats': payload.get('stats') or {}}
        return result

    def game_time(self, shard):
        return int(self.api.get('/api/game/time', {'shard': shard}).get('time') or 0)

    def room_objects(self, shard, room):
        payload = self.api.get('/api/game/room-objects', {'room': room, 'shard': shard})
        return {'objects': payload.get('objects') or [], 'users': payload.get('users') or {}}

    # ---- 一轮 ----
    def run(self, all_rooms=True, room_limit=None):
        started = time.time()
        calls_before = self.api.calls
        stamp = utc_stamp()
        snap_dir = os.path.join(self.out_dir, 'snapshots', stamp)
        for sub in ('objects', 'history', 'remotes'):
            os.makedirs(os.path.join(snap_dir, sub), exist_ok=True)

        profile = self.profile()
        self.log('[observe] %s id=%s gcl=%s rooms=%s' % (profile['username'], profile['id'], profile['gcl'],
                                                        profile['rooms']))
        stats = self.stats(profile['id'])
        mapstats = self.map_stats(profile['roomsByShard'])
        self_stats = None
        if self.include_self and self.self_id:
            self_stats = self.stats(self.self_id)

        pairs = [(shard, room) for shard, rooms in profile['roomsByShard'].items() for room in rooms]
        if not all_rooms and room_limit:
            cursor = self.state.get('roomCursor', 0) % max(len(pairs), 1)
            pairs = (pairs + pairs)[cursor:cursor + room_limit]
            self.state['roomCursor'] = (cursor + room_limit) % max(len(pairs), 1)
        fetched_rooms = []
        for shard, room in pairs:
            try:
                data = self.room_objects(shard, room)
            except ApiError as error:
                self.log('[observe] room-objects %s/%s failed: %s' % (shard, room, error))
                continue
            with open(os.path.join(snap_dir, 'objects', '%s__%s.json' % (shard, room)), 'w') as handle:
                json.dump(data, handle, separators=(',', ':'))
            fetched_rooms.append((shard, room))

        # history：RCL<8 的房（新占房的建造顺序最有学习价值）优先，其余按游标轮转，共 history_n 个
        histories = []
        game_times = {}
        if self.history_n and fetched_rooms:
            picks = self.history_picks(fetched_rooms, mapstats)
            for shard, room in picks:
                if shard not in game_times:
                    game_times[shard] = self.game_time(shard)
                tick = (game_times[shard] - self.history_lag) // 100 * 100
                data = None
                for attempt in range(3):
                    try:
                        data = fetch_history(shard, room, tick - attempt * 100)
                    except ApiError as error:
                        self.log('[observe] history %s/%s failed: %s' % (shard, room, error))
                        break
                    if data:
                        break
                if data:
                    with open(os.path.join(snap_dir, 'history', '%s__%s__%d.json' % (shard, room, data['base'])),
                              'w') as handle:
                        json.dump(data, handle, separators=(',', ':'))
                    histories.append((shard, room, data['base']))

        # 外矿房：从 creep 名里出现的目标房推断（目标房 ≠ 所在房），轮转 remotes_n 个
        remote_pairs = self._remote_candidates(snap_dir, fetched_rooms, profile['roomsByShard'])
        remotes = []
        if self.remotes_n and remote_pairs:
            cursor = self.state.get('remoteCursor', 0) % len(remote_pairs)
            picks = (remote_pairs + remote_pairs)[cursor:cursor + self.remotes_n]
            self.state['remoteCursor'] = (cursor + self.remotes_n) % len(remote_pairs)
            for shard, room, home in picks:
                try:
                    data = self.room_objects(shard, room)
                except ApiError as error:
                    self.log('[observe] remote %s/%s failed: %s' % (shard, room, error))
                    continue
                data['home'] = home
                if shard not in game_times:
                    game_times[shard] = self.game_time(shard)
                data['gameTime'] = game_times[shard]
                with open(os.path.join(snap_dir, 'remotes', '%s__%s.json' % (shard, room)), 'w') as handle:
                    json.dump(data, handle, separators=(',', ':'))
                remotes.append((shard, room))

        manifest = {
            'player': self.player, 'capturedAt': stamp, 'startedAt': started, 'seconds': round(time.time() - started, 1),
            'apiCalls': self.api.calls - calls_before, 'rooms': fetched_rooms, 'histories': histories,
            'remotes': remotes, 'remoteCandidates': len(remote_pairs), 'gameTimes': game_times,
        }
        with open(os.path.join(snap_dir, 'profile.json'), 'w') as handle:
            json.dump(profile, handle, indent=1)
        with open(os.path.join(snap_dir, 'stats.json'), 'w') as handle:
            json.dump(stats, handle, indent=1)
        with open(os.path.join(snap_dir, 'mapstats.json'), 'w') as handle:
            json.dump(mapstats, handle, separators=(',', ':'))
        if self_stats is not None:
            with open(os.path.join(snap_dir, 'self_stats.json'), 'w') as handle:
                json.dump(self_stats, handle, indent=1)
        with open(os.path.join(snap_dir, 'manifest.json'), 'w') as handle:
            json.dump(manifest, handle, indent=1)
        self._save_state()
        self.log('[observe] snapshot %s: rooms=%d histories=%d remotes=%d calls=%d in %ss' % (
            stamp, len(fetched_rooms), len(histories), len(remotes), manifest['apiCalls'], manifest['seconds']))
        return snap_dir

    def history_picks(self, fetched_rooms, mapstats):
        """选本轮抓 history 的房：RCL<8 的先（按游标轮转），剩余名额在其余房里按游标轮转。"""
        def level(pair):
            shard, room = pair
            own = ((mapstats.get(shard) or {}).get('stats') or {}).get(room, {}).get('own') or {}
            return own.get('level') or 0

        low = [pair for pair in fetched_rooms if 0 < level(pair) < 8]
        rest = [pair for pair in fetched_rooms if pair not in low]
        picks = []
        if low:
            cursor = self.state.get('lowCursor', 0) % len(low)
            take = min(self.history_n, len(low))
            picks.extend((low + low)[cursor:cursor + take])
            self.state['lowCursor'] = (cursor + take) % len(low)
        remaining = self.history_n - len(picks)
        if remaining > 0 and rest:
            cursor = self.state.get('historyCursor', 0) % len(rest)
            picks.extend((rest + rest)[cursor:cursor + remaining])
            self.state['historyCursor'] = (cursor + remaining) % len(rest)
        return picks

    def _remote_candidates(self, snap_dir, fetched_rooms, rooms_by_shard):
        from observe.analyze import parse_creep_name
        owned = {(shard, room) for shard, rooms in rooms_by_shard.items() for room in rooms}
        seen = {}
        for shard, room in fetched_rooms:
            path = os.path.join(snap_dir, 'objects', '%s__%s.json' % (shard, room))
            try:
                with open(path) as handle:
                    objs = json.load(handle).get('objects') or []
            except (OSError, ValueError):
                continue
            for obj in objs:
                if obj.get('type') != 'creep':
                    continue
                target = parse_creep_name(obj.get('name')).get('room')
                if target and target != room and (shard, target) not in owned:
                    seen.setdefault((shard, target), room)
        return sorted((shard, room, home) for (shard, room), home in seen.items())
