import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from brain import dashboard  # noqa: E402
from brain import run as run_module  # noqa: E402
from brain.api import ScreepsApi  # noqa: E402

MY = 'u-me'
TICK = 1000


def body(*parts):
    return [{'type': part, 'hits': 100} for part in parts]


def home_objects(harvested=(0, 0), level=6, progress=100, storage=5000, tick=TICK, extra=()):
    return [
        {'_id': 'ctrl', 'type': 'controller', 'level': level, 'progress': progress, 'user': MY, 'downgradeTime': tick + 50000},
        {'_id': 'src-b', 'type': 'source', 'energyCapacity': 3000, 'invaderHarvested': harvested[1]},
        {'_id': 'src-a', 'type': 'source', 'energyCapacity': 3000, 'invaderHarvested': harvested[0]},
        {'_id': 'sp', 'type': 'spawn', 'user': MY, 'store': {'energy': 300}, 'storeCapacityResource': {'energy': 300},
         'spawning': {'name': 'x'}},
        {'_id': 'ex', 'type': 'extension', 'user': MY, 'store': {'energy': 20}, 'storeCapacityResource': {'energy': 50}},
        {'_id': 'st', 'type': 'storage', 'user': MY, 'store': {'energy': storage, 'L': 100}},
        {'_id': 'drop', 'type': 'energy', 'resourceType': 'energy', 'energy': 40},
    ] + list(extra)


def remote_objects(harvested=0, capacity=3000, reserve_user=MY, tick=TICK, extra=()):
    return [
        {'_id': 'rctrl', 'type': 'controller', 'level': 0, 'reservation': {'user': reserve_user, 'endTime': tick + 3000}},
        {'_id': 'rsrc', 'type': 'source', 'energyCapacity': capacity, 'invaderHarvested': harvested},
    ] + list(extra)


def entry(t, at, gcl=0, harvested=0, prog=0, storage=1000, upkeep=1.0, remotes=None, room='W1N1'):
    rooms = {}
    if harvested is not None:
        rooms[room] = {'rcl': 6, 'prog': prog, 'storage': storage, 'upkeep': upkeep,
                       'sources': [[harvested, 3000], [harvested, 3000]], 'remotes': remotes or {}}
    return {'v': 1, 't': t, 'at': at, 'gcl': gcl, 'rooms': rooms}


def snap_for(entries):
    last = entries[-1]
    rooms = {name: dict(room, seen=True, remotes={}) for name, room in last['rooms'].items()}
    return {'t': last['t'], 'at': last['at'], 'gcl': last['gcl'], 'me': 'me', 'brain': {}, 'rooms': rooms}


class RoomViewTest(unittest.TestCase):
    def test_reads_energy_storage_ground_hostiles_and_reservation(self):
        view = dashboard.room_view(home_objects(harvested=(10, 20)) + [
            {'_id': 'k', 'type': 'creep', 'user': '3', 'body': body('attack')},
            {'_id': 'inv', 'type': 'creep', 'user': '2', 'body': body('ranged_attack', 'move')},
            {'_id': 'sc', 'type': 'creep', 'user': 'other', 'body': body('move')},
        ], MY, TICK)
        self.assertEqual(view['sources'], [[10, 3000], [20, 3000]], '源按 _id 排序')
        self.assertEqual((view['energy'], view['cap'], view['storage'], view['ground']), (320, 350, 5000, 40))
        self.assertEqual(view['spawns'], [1, 1])
        self.assertEqual((view['hostiles'], view['armed']), (2, 1), 'Source Keeper 不算敌人')
        self.assertEqual(view['downgrade'], 50000)
        self.assertEqual(dashboard.room_view(remote_objects(), MY, TICK)['reserve'], 3000)
        self.assertEqual(dashboard.room_view(remote_objects(reserve_user='x'), MY, TICK)['reserve'], -3000)
        self.assertIsNone(dashboard.room_view(remote_objects(), MY, TICK)['storage'])

    def test_gcl_info(self):
        info = dashboard.gcl_info(373242598)
        self.assertEqual(info['level'], 12)
        self.assertTrue(0 < info['progress'] < 1)
        self.assertEqual(dashboard.gcl_info(0)['level'], 0)


class CreepLedgerTest(unittest.TestCase):
    def test_charges_remote_claim_and_aid_creeps(self):
        objects = {'W1N1': [
            {'type': 'creep', 'user': MY, 'name': 'miner', 'body': body('work', 'work', 'move')},
            {'type': 'creep', 'user': MY, 'name': 'reserver', 'body': body('claim', 'move')},
            {'type': 'creep', 'user': MY, 'name': 'aider', 'body': body('work', 'carry', 'move')},
            {'type': 'creep', 'user': MY, 'name': 'upg', 'body': body('work', 'carry', 'move')},
            {'type': 'creep', 'user': 'other', 'name': 'ghost', 'body': body('claim')},
        ]}
        memory = {
            'miner': {'role': 'remoteMiner', 'home': 'W1N1', 'remoteRoom': 'W2N1'},
            'reserver': {'role': 'reserver', 'home': 'W1N1', 'remoteRoom': 'W2N1'},
            'aider': {'role': 'builder', 'home': 'W3N3', 'aid': 'W1N1'},
            'upg': {'role': 'upgrader', 'home': 'W1N1'},
            'ghost': {'role': 'hauler', 'home': 'W1N1'},
        }
        staff, pay, priced = dashboard.creep_ledger(objects, memory, MY)
        self.assertEqual(sorted(priced), ['aider', 'miner', 'reserver', 'upg'])
        self.assertEqual(staff['W1N1']['creeps'], 4)
        self.assertEqual(staff['W3N3']['roles'], {'builder': 1}, '编制记在干活的房')
        self.assertAlmostEqual(pay['W1N1']['own'], 200 / 1500 * 2, msg='援建 builder 记在出钱的母房')
        self.assertAlmostEqual(pay['W1N1']['remotes']['W2N1'][0], 250 / 1500 + 650 / 600, msg='CLAIM creep 按 600 tick 摊')
        self.assertEqual(pay['W1N1']['remotes']['W2N1'][1], 2)
        self.assertEqual(pay['W1N1']['unpriced'], 1, '别人家同名 creep 不算我方身体')
        self.assertNotIn('W3N3', pay)

    def test_creeps_in_unfetched_rooms_keep_last_known_price(self):
        memory = {'miner': {'role': 'remoteMiner', 'home': 'W1N1', 'remoteRoom': 'W2N1'},
                  'fresh': {'role': 'hauler', 'home': 'W1N1'}}
        known = {'miner': [0.5, 900], 'fresh': [9, 600], 'dead': [9, 1000]}
        _, pay, priced = dashboard.creep_ledger({}, memory, MY, known=known, tick=1000)
        self.assertEqual(pay['W1N1']['remotes']['W2N1'], [0.5, 1], '这一轮没拉到它站的房：沿用上一轮的价')
        self.assertEqual(pay['W1N1']['unpriced'], 1, '超过 300 tick 没见过身体（可能是同名复用的新 creep）就不再沿用')
        self.assertEqual(priced, {'miner': [0.5, 900]}, '沿用时保留最初看到身体的 tick；已经死掉的 creep 不再往下传')


class StepTest(unittest.TestCase):
    def test_source_step_handles_invader_reset_and_capacity_floor(self):
        harvest, ceiling = dashboard.source_step([[2900, 1500], [100, 3000]], [[50, 1500], [400, 3000]], 100)
        self.assertEqual(harvest, 50 + 300, 'invaderHarvested 变小 = Invader 清零，从 0 重新累计')
        self.assertAlmostEqual(ceiling, 2 * 3000 / 300 * 100, msg='预定掉了的 1500 档也按 3000 算上限')
        self.assertIsNone(dashboard.source_step([[1, 3000]], [[1, 3000], [2, 3000]], 100))
        self.assertAlmostEqual(dashboard.source_step([[0, 4000]], [[10, 4000]], 30)[1], 4000 / 300 * 30)

    def test_cp_step_across_level_up_rcl8_and_downgrade(self):
        self.assertEqual(dashboard.cp_step({'rcl': 5, 'prog': 100}, {'rcl': 5, 'prog': 350}), 250)
        self.assertEqual(dashboard.cp_step({'rcl': 5, 'prog': 1214000}, {'rcl': 6, 'prog': 500}), 1500)
        self.assertIsNone(dashboard.cp_step({'rcl': 7, 'prog': 10934000}, {'rcl': 8, 'prog': 0}))
        self.assertIsNone(dashboard.cp_step({'rcl': 6, 'prog': 10}, {'rcl': 5, 'prog': 0}))
        # 降级后 progress 被抬到超过本级所需，恢复计时后升级：引擎是 progress -= 所需，真实增量只有 10
        self.assertEqual(dashboard.cp_step({'rcl': 5, 'prog': 1315000}, {'rcl': 6, 'prog': 100010}), 10)

    def test_downgrade_alert_scales_with_level(self):
        def critical(level, ticks):
            room = {'rcl': level, 'downgrade': ticks, 'seen': True, 'remotes': {}}
            return any(a['level'] == 'critical' for a in dashboard.room_alerts(room, {}, {}))
        self.assertFalse(critical(2, 9990), 'RCL2 的降级计时上限就是 10000')
        self.assertTrue(critical(2, 2000))
        self.assertTrue(critical(6, 9000))
        self.assertFalse(critical(6, 60000))


class RatesTest(unittest.TestCase):
    def view(self, entries):
        return dashboard.build_view(entries, snap_for(entries), now=entries[-1]['at'])

    def test_window_rates_from_counters(self):
        entries = [entry(1000, 0, gcl=1000, harvested=0, prog=0, storage=1000),
                   entry(1100, 300, gcl=1600, harvested=1000, prog=500, storage=1300),
                   entry(1200, 600, gcl=2200, harvested=2000, prog=1000, storage=1600)]
        view = self.view(entries)
        stats = view['rooms'][0]['stats']['1h']
        self.assertEqual((stats['cp'], stats['hOwn'], stats['cOwn'], stats['eff']), (5, 20, 20, 1))
        self.assertEqual((stats['storage'], stats['upkeep'], stats['hRem'], stats['net']), (3, 1, 0, 19))
        self.assertEqual((stats['ticks'], stats['secPerTick']), (200, 3))
        account = view['account']['stats']['1h']
        self.assertEqual((account['cp'], account['roomsCp'], account['harvest']), (6, 5, 20))
        self.assertEqual(len(view['series']['t']), 1, '10 分钟内的快照落在同一个 20 分钟桶')

    def test_long_pause_and_missing_room_do_not_dilute(self):
        entries = [entry(1000, 0, harvested=0),
                   entry(1100, 300, harvested=1000),
                   entry(4000, 300 + 3 * 3600, harvested=0),         # 本机睡了 3 小时：这一段不算
                   entry(4100, 600 + 3 * 3600, harvested=1500),
                   entry(4200, 900 + 3 * 3600, harvested=None),      # 这一轮没拿到房间
                   entry(4300, 1200 + 3 * 3600, harvested=2500),
                   entry(4400, 1500 + 3 * 3600, harvested=3500)]
        stats = self.view(entries)['rooms'][0]['stats']['24h']
        # 算进来的只有 1000→1100、4000→4100、4300→4400 三段：(2000 + 3000 + 2000) / 300 tick
        self.assertAlmostEqual(stats['hOwn'], 7000 / 300, places=2)
        self.assertEqual(stats['eff'], round(7000 / 300 / 20, 3))

    def test_remote_counters_and_uncounted_upkeep(self):
        counted = [entry(1000, 0, harvested=0, remotes={'W2N1': [1, 2.0, 1, [[2900, 3000]]], 'W3N1': [1, 0.5, 0, None],
                                                        'W4N1': [1, 0.0, 1, [[0, 3000]]]}),
                   entry(1100, 300, harvested=0, remotes={'W2N1': [1, 2.0, 1, [[400, 3000]]], 'W3N1': [1, 0.5, 0, None],
                                                          'W4N1': [1, 0.0, 1, [[300, 3000]]]}),
                   entry(1200, 600, harvested=0, remotes={'W2N1': [2, 2.0, 1, None], 'W3N1': [1, 0.5, 0, None],
                                                          'W4N1': [1, 0.0, 1, [[600, 3000]]]})]
        view = self.view(counted)
        stats = view['rooms'][0]['stats']['1h']
        # 第一段两个外矿都看得到：(400 + 300) / 100 tick，上限 20/tick；第二段 W2N1 没拉到 → 母房外矿整段不算（不按整段 tick 稀释）
        self.assertEqual((stats['hRem'], stats['cRem']), (7, 20))
        self.assertEqual(stats['upRem'], 2.5, '没记采集的外矿（记在别的母房）照样算维持成本')
        w4 = next(r for r in dashboard.build_view(counted, dict(snap_for(counted), rooms={'W1N1': dict(
            snap_for(counted)['rooms']['W1N1'], remotes={'W4N1': {'state': 'on', 'counted': True, 'upkeep': 0.0, 'creeps': 0}})}),
            now=600)['rooms'][0]['remotes'] if r['name'] == 'W4N1')
        self.assertEqual(w4['stats']['1h']['h'], 3, '单个外矿自己的账不受别的外矿缺数据影响')
        remote_view = dashboard.build_view(counted, dict(snap_for(counted), rooms={'W1N1': dict(
            snap_for(counted)['rooms']['W1N1'], remotes={'W2N1': {'state': 'suspended', 'counted': True, 'upkeep': 2.0,
                                                                  'why': 'hostileCreep', 'creeps': 1}})}), now=600)
        remote = remote_view['rooms'][0]['remotes'][0]
        self.assertEqual((remote['stats']['1h']['h'], remote['stats']['1h']['upkeep'], remote['stats']['1h']['net']), (4, 2, 2))
        self.assertIn({'level': 'warning', 'text': '外矿 W2N1 停用：hostileCreep'}, remote_view['rooms'][0]['alerts'])


class SnapshotTest(unittest.TestCase):
    def test_shared_remote_counts_once_and_stale_records_are_dropped(self):
        memory_rooms = {
            'W1N1': {'state': {'recovering': True}, 'spawnQueue': {'waiting': {'key': 'core:hauler:1', 'waited': 400, 'eta': 20}},
                     'remotes': {'W2N1': {'enabled': True, 'suspendedUntil': 0, 'sources': [{'id': 'rsrc', 'distance': 40, 'containerId': 'c'}]},
                                 'W9N9': {'enabled': False, 'suspendReason': 'notWhitelisted'},
                                 'W8N8': {'enabled': True, 'suspendedUntil': TICK + 50, 'suspendReason': 'hostileCreep'}}},
            'W5N5': {'remotes': {'W2N1': {'enabled': True, 'suspendedUntil': 0, 'drop': {'room': 'W1N1'}}}},
        }
        objects = {'W1N1': home_objects(), 'W5N5': home_objects(), 'W2N1': remote_objects(harvested=5)}
        snap = dashboard.build_snapshot(TICK, 123.4, {'_id': MY, 'username': 'me', 'gcl': 10}, ['W1N1', 'W5N5'],
                                        memory_rooms, {}, objects, whitelist={'W5N5': ['W2N1']})
        w1, w5 = snap['rooms']['W1N1'], snap['rooms']['W5N5']
        self.assertFalse(w1['remotes']['W2N1']['counted'])
        self.assertTrue(w5['remotes']['W2N1']['counted'], '两个母房都启用时记在大脑白名单的那个')
        self.assertEqual(w5['remotes']['W2N1']['drop'], 'W1N1')
        self.assertNotIn('W9N9', w1['remotes'], '没启用也没人干活的旧记录不上面板')
        self.assertEqual(w1['remotes']['W8N8']['state'], 'suspended')
        self.assertFalse(w1['remotes']['W8N8']['seen'])
        history = dashboard.history_entry(snap)
        self.assertEqual(history['rooms']['W5N5']['remotes']['W2N1'], [1, 0.0, 1, [[5, 3000]]])
        self.assertEqual(history['rooms']['W1N1']['remotes']['W2N1'][3], None)
        view = dashboard.build_view([history], snap, now=123.4)
        alerts = {a['text']: a['level'] for a in view['rooms'][0]['alerts']}
        self.assertEqual(alerts['外矿 W8N8 本轮没拉到房间对象，外矿采集暂不计'], 'warning')
        self.assertEqual(alerts['恢复模式'], 'critical')
        self.assertEqual(alerts['孵化排队 core:hauler:1 已等 400 tick'], 'warning')


class FakeCacheApi:
    def __init__(self, rooms):
        self.rooms = rooms
        self.asked = []

    def cached_room_objects(self, room, max_age_s):
        self.asked.append((room, max_age_s))
        return {'objects': self.rooms[room]} if room in self.rooms else None


class UpdateTest(unittest.TestCase):
    def test_update_appends_history_and_renders_escaped_page(self):
        memory_rooms = {'W1N1': {'spawnIncome': {'ema': 12.345}, 'spawnSpend': {'ema': 8}, 'state': {},
                                 'remotes': {'W2N1': {'enabled': True, 'suspendedUntil': 0,
                                                      'sources': [{'id': 'rsrc', 'distance': 40, 'containerId': 'c'}]},
                                             'W9N9': {'enabled': False}}}}
        creeps = {'m': {'role': '</script><b>x', 'home': 'W1N1', 'remoteRoom': 'W2N1'}}
        miner = {'type': 'creep', 'user': MY, 'name': 'm', 'body': body('work', 'work', 'work', 'move')}
        state = {'homes': {'W1N1': {}}, 'wrote': 'segment 90，1 字节', 'blockers': [], 'apiCalls': 3,
                 'directive': {'rooms': {'W1N1': {'remotes': ['W2N1']}}}}
        with tempfile.TemporaryDirectory() as out:
            api = FakeCacheApi({'W1N1': home_objects(harvested=(0, 0), progress=100),
                                'W2N1': remote_objects(harvested=0, extra=[miner])})
            dashboard.update(out, api, dict(state, tick=1000), {'_id': MY, 'username': 'me', 'gcl': 5000000},
                             memory_rooms, creeps, now=10000)
            self.assertEqual(api.asked, [('W1N1', 240), ('W2N1', 240), ('W9N9', 240)], '只读缓存，名单是母房 + 外矿记录')
            api.rooms = {'W1N1': home_objects(harvested=(1000, 1000), progress=600, tick=1100),
                         'W2N1': remote_objects(harvested=900, tick=1100, extra=[miner])}
            view = dashboard.update(out, api, dict(state, tick=1100), {'_id': MY, 'username': 'me', 'gcl': 5000700},
                                    memory_rooms, creeps, now=10300)
            with open(os.path.join(out, 'history.jsonl')) as handle:
                self.assertEqual(len(handle.readlines()), 2)
            self.assertEqual(view['account']['stats']['1h']['cp'], 7)
            room = view['rooms'][0]
            self.assertEqual((room['stats']['1h']['cp'], room['stats']['1h']['hOwn'], room['stats']['1h']['hRem']), (5, 20, 9))
            self.assertAlmostEqual(room['remotes'][0]['stats']['1h']['upkeep'], 350 / 1500, places=2)
            self.assertTrue(view['brain']['ok'])
            with open(os.path.join(out, 'index.html'), encoding='utf-8') as handle:
                html = handle.read()
            self.assertNotIn(dashboard.DATA_MARKER, html)
            self.assertNotIn('</script><b>', html, '数据里的 </script> 必须转义')
            self.assertIn('\\u003c/script>\\u003cb>x', html)
            self.assertTrue(os.path.exists(os.path.join(out, 'latest.json')))
            with redirect_stdout(io.StringIO()) as printed:
                dashboard.main(['--dir', out])
            self.assertIn('index.html', printed.getvalue())

            # 第三轮外矿没拉到：矿工沿用上一轮的价，外矿维持成本不掉 0；历史文件上次断在半行也不连累新行
            with open(os.path.join(out, 'history.jsonl'), 'a') as handle:
                handle.write('{"t": 1150, "at"')
            api.rooms = {'W1N1': home_objects(harvested=(2000, 2000), progress=1100, tick=1200)}
            view = dashboard.update(out, api, dict(state, tick=1200), {'_id': MY, 'username': 'me', 'gcl': 5001400},
                                    memory_rooms, creeps, now=10600)
            remote = view['rooms'][0]['remotes'][0]
            self.assertFalse(remote['now']['seen'])
            self.assertAlmostEqual(remote['now']['upkeep'], 350 / 1500, places=3)
            self.assertEqual(view['rooms'][0]['now']['unpriced'], 0)
            self.assertEqual([e['t'] for e in dashboard.load_history(os.path.join(out, 'history.jsonl'))], [1000, 1100, 1200])
            self.assertEqual(view['history']['entries'], 3)

    def test_busy_lock_times_out_instead_of_blocking(self):
        import fcntl
        with tempfile.TemporaryDirectory() as out:
            with open(os.path.join(out, '.lock'), 'w') as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                with self.assertRaises(TimeoutError):
                    dashboard.update(out, FakeCacheApi({}), {'homes': {}}, {}, {}, {}, now=1, lock_wait=0.3)
            self.assertFalse(os.path.exists(os.path.join(out, 'history.jsonl')))

    def test_history_trim_dedupe_and_bad_lines(self):
        with tempfile.TemporaryDirectory() as out:
            path = os.path.join(out, 'history.jsonl')
            with open(path, 'w') as handle:
                handle.write(json.dumps({'t': 1, 'at': 0}) + '\n')
                handle.write('{broken\n')
                handle.write(json.dumps({'t': 2, 'at': 900000, 'x': 1}) + '\n')
                handle.write(json.dumps({'t': 2, 'at': 900001, 'x': 2}) + '\n')
            kept = dashboard.load_history(path, now=dashboard.KEEP_SECONDS + 10)
            self.assertEqual([(e['t'], e['x']) for e in kept], [(2, 2)])


class ApiCacheTest(unittest.TestCase):
    def test_cached_room_objects_never_hits_network(self):
        class Response:
            def __init__(self, payload):
                self.data = json.dumps(payload).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return self.data

        calls = []

        def opener(request, timeout=30):
            calls.append(request.full_url)
            return Response({'objects': [{'type': 'source'}]})

        with tempfile.TemporaryDirectory() as cache:
            api = ScreepsApi('http://x', 't', cache_dir=cache, opener=opener, sleep=lambda s: None, min_interval=0)
            self.assertIsNone(api.cached_room_objects('W1N1', 240))
            api.room_objects('W1N1')
            self.assertEqual(api.cached_room_objects('W1N1', 240), {'objects': [{'type': 'source'}]})
            self.assertIsNone(api.cached_room_objects('W1N1', -1), '过旧的缓存不用')
            self.assertEqual(len(calls), 1, '读缓存本身不发请求')


class RunHookTest(unittest.TestCase):
    def test_private_server_and_flag_skip_and_errors_are_contained(self):
        with mock.patch.object(dashboard, 'update') as update:
            args = run_module.parse_args(['--server', 'private', '--token', 't'])
            self.assertFalse(run_module.update_dashboard(args, None, {}, {}, {}, {}))
            for argv in (['--no-dashboard'], ['--homes', 'W33S7', '--write'], ['--dry-run']):
                self.assertFalse(run_module.update_dashboard(run_module.parse_args(argv), None, {}, {}, {}, {}), argv)
            update.assert_not_called()
            self.assertTrue(run_module.update_dashboard(run_module.parse_args(['--write']), None, {}, {}, {}, {}))
            update.assert_called_once()
        err = io.StringIO()
        with mock.patch.object(dashboard, 'update', side_effect=RuntimeError('boom')), redirect_stderr(err):
            self.assertFalse(run_module.update_dashboard(run_module.parse_args([]), None, {}, {}, {}, {}))
        self.assertIn('boom', err.getvalue())


if __name__ == '__main__':
    unittest.main()
