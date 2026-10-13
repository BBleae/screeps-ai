"""Screeps HTTP API 封装：官方服务器与私服共用，带限速、退避与磁盘缓存。"""
import base64
import gzip
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


class ApiError(RuntimeError):
    pass


class ScreepsApi:
    def __init__(self, base_url, token, username=None, shard='shard1', cache_dir=None,
                 min_interval=0.4, sleep=time.sleep, opener=None):
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.username = username
        self.shard = shard
        self.cache_dir = cache_dir
        self.min_interval = min_interval
        self._sleep = sleep
        self._open = opener or urllib.request.urlopen
        self._last_call = 0.0
        self.calls = 0

    # ---- 底层请求 ----
    def _headers(self):
        headers = {'X-Token': self.token, 'Content-Type': 'application/json'}
        if self.username:
            headers['X-Username'] = self.username
        return headers

    def _throttle(self):
        wait = self.min_interval - (time.time() - self._last_call)
        if wait > 0:
            self._sleep(wait)
        self._last_call = time.time()

    def request(self, method, path, params=None, body=None, retries=3):
        url = self.base_url + path
        if params:
            url += '?' + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        backoff = 5
        for attempt in range(retries + 1):
            self._throttle()
            req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
            try:
                with self._open(req, timeout=30) as resp:
                    payload = json.loads(resp.read().decode() or '{}')
                    self.calls += 1
                    if isinstance(payload, dict) and payload.get('error'):
                        raise ApiError(payload['error'])
                    return payload
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < retries:
                    self._sleep(backoff)
                    backoff *= 3
                    continue
                raise ApiError('%s %s -> HTTP %s' % (method, path, error.code))
            except ApiError as error:
                if 'rate' in str(error).lower() and attempt < retries:
                    self._sleep(backoff)
                    backoff *= 3
                    continue
                raise
        raise ApiError('%s %s -> retries exhausted' % (method, path))

    def get(self, path, params=None):
        return self.request('GET', path, params=params)

    def post(self, path, body=None):
        return self.request('POST', path, body=body)

    # ---- 磁盘缓存 ----
    def _cache_path(self, key):
        digest = hashlib.sha1(key.encode()).hexdigest()
        return os.path.join(self.cache_dir, digest + '.json')

    @staticmethod
    def _cache_key(path, params):
        return path + '?' + urllib.parse.urlencode(sorted((params or {}).items()))

    def cached_get(self, path, params, ttl_s):
        if not self.cache_dir:
            return self.get(path, params)
        os.makedirs(self.cache_dir, exist_ok=True)
        key = self._cache_key(path, params)
        cache_file = self._cache_path(key)
        if os.path.exists(cache_file):
            try:
                with open(cache_file) as handle:
                    entry = json.load(handle)
                if time.time() - entry.get('at', 0) < ttl_s:
                    return entry['payload']
            except (OSError, ValueError):
                pass
        payload = self.get(path, params)
        with open(cache_file, 'w') as handle:
            json.dump({'at': time.time(), 'key': key, 'payload': payload}, handle)
        return payload

    # ---- 领域接口 ----
    def time(self):
        return int(self.get('/api/game/time', {'shard': self.shard}).get('time', 0))

    def room_objects(self, room, ttl_s=60):
        return self.cached_get('/api/game/room-objects', {'room': room, 'shard': self.shard}, ttl_s)

    def cached_room_objects(self, room, max_age_s):
        """只读磁盘缓存、不发请求：监控面板复用 intel.collect 本轮拉下的 room-objects；没有或超过 max_age_s 返回 None"""
        if not self.cache_dir:
            return None
        cache_file = self._cache_path(self._cache_key('/api/game/room-objects', {'room': room, 'shard': self.shard}))
        try:
            with open(cache_file) as handle:
                entry = json.load(handle)
        except (OSError, ValueError):
            return None
        if time.time() - entry.get('at', 0) > max_age_s:
            return None
        return entry.get('payload')

    def room_terrain(self, room):
        payload = self.cached_get('/api/game/room-terrain', {'room': room, 'shard': self.shard, 'encoded': 1},
                                  30 * 24 * 3600)
        terrain = payload.get('terrain') or []
        return terrain[0].get('terrain') if terrain else None

    def map_stats(self, rooms, stat='owner0'):
        return self.post('/api/game/map-stats', {'rooms': list(rooms), 'statName': stat, 'shard': self.shard})

    def me(self):
        return self.get('/api/auth/me')

    def memory(self, path):
        payload = self.get('/api/user/memory', {'path': path, 'shard': self.shard})
        data = payload.get('data')
        if isinstance(data, str) and data.startswith('gz:'):
            data = json.loads(gzip.decompress(base64.b64decode(data[3:])).decode())
        return data

    def set_memory(self, path, value):
        return self.post('/api/user/memory', {'path': path, 'value': value, 'shard': self.shard})

    def get_segment(self, segment):
        payload = self.get('/api/user/memory-segment', {'segment': segment, 'shard': self.shard})
        return payload.get('data')

    def set_segment(self, segment, data):
        if len(data) > 100 * 1024:
            raise ApiError('segment payload too large: %d bytes' % len(data))
        return self.post('/api/user/memory-segment', {'segment': segment, 'data': data, 'shard': self.shard})

    def console(self, expression):
        return self.post('/api/user/console', {'expression': expression, 'shard': self.shard})


def load_env(root):
    """读取项目 .env 里的键值（不落日志）。"""
    values = {}
    env_file = os.path.join(root, '.env')
    if not os.path.exists(env_file):
        return values
    with open(env_file) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values
