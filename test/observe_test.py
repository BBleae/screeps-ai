import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from observe import analyze, report  # noqa: E402

FIXTURES = os.path.join(ROOT, 'test', 'fixtures')
KALGEN = '61a475b5048fffe95d98bbcf'


def load(name):
    with open(os.path.join(FIXTURES, name)) as handle:
        return json.load(handle)


class NameAndBodyTest(unittest.TestCase):
    def test_parse_kalgen_names(self):
        parsed = analyze.parse_creep_name('shauler-L1600-W17N27h1-82739484')
        self.assertEqual(parsed, {'role': 'shauler', 'tier': 1600, 'room': 'W17N27', 'slot': 'h', 'slotIndex': 1,
                                  'tick': 82739484})
        parsed = analyze.parse_creep_name('lhauler-L1600-W19S4h1-6a58da111c4b0fb074fb0865-5374656')
        self.assertEqual((parsed['role'], parsed['tier'], parsed['room'], parsed['tick']),
                         ('lhauler', 1600, 'W19S4', 5374656))
        parsed = analyze.parse_creep_name('W18S4a-legacyscientist-t5375928')
        self.assertEqual((parsed['role'], parsed['room'], parsed['slot'], parsed['tick']),
                         ('legacyscientist', 'W18S4', 'a', 5375928))
        parsed = analyze.parse_creep_name('efiller-W18S4f1-L800-t5375856')
        self.assertEqual((parsed['role'], parsed['tier'], parsed['slot'], parsed['slotIndex']),
                         ('efiller', 800, 'f', 1))
        parsed = analyze.parse_creep_name('ereserve-W18N29r1-L4-t82740468')
        self.assertEqual((parsed['role'], parsed['tier'], parsed['room']), ('ereserve', 4, 'W18N29'))

    def test_parse_other_names(self):
        self.assertEqual(analyze.parse_creep_name('荷取丙')['role'], '荷取丙')
        self.assertEqual(analyze.parse_creep_name('hauler_12')['role'], 'hauler_12')
        self.assertEqual(analyze.parse_creep_name(None)['role'], None)

    def test_body_signature_and_cost(self):
        body = [{'type': 'work'}] * 10 + [{'type': 'carry'}] + [{'type': 'move'}] * 5
        self.assertEqual(analyze.body_signature(body), 'W10C1M5')
        self.assertEqual(analyze.body_cost(body), 1300)
        self.assertEqual(analyze.body_signature(['carry', 'move', 'carry']), 'C2M1')
        boosted = [{'type': 'work', 'boost': 'XGH2O'}] * 2 + [{'type': 'move'}]
        self.assertEqual(analyze.body_boosts(boosted), {'XGH2O': 2})


class RoomSummaryTest(unittest.TestCase):
    def setUp(self):
        self.objs = load('observe_room_W18N28.json')['objects']
        self.summary = analyze.summarize_room('shard3', 'W18N28', self.objs, KALGEN)

    def test_structure_counts_and_links(self):
        self.assertEqual(self.summary['rcl'], 8)
        self.assertEqual(self.summary['structures']['spawn'], 3)
        self.assertEqual(self.summary['structures']['extension'], 60)
        self.assertEqual(self.summary['structures']['link'], 1)
        self.assertEqual(self.summary['linkKinds'], {'hub': 1})
        self.assertEqual(self.summary['towers']['n'], 6)
        self.assertGreater(self.summary['storageEnergy'], 100000)
        self.assertEqual(self.summary['mineral'], 'Z')

    def test_creeps_and_archetypes(self):
        creeps = self.summary['creeps']
        self.assertEqual(creeps['count'], 11)
        self.assertEqual(creeps['roles']['shauler'], 5)
        self.assertEqual(creeps['archetypes']['shauler|C32M16'], 5)
        self.assertEqual(creeps['archetypes']['eharvest|W10C1M5'], 2)
        self.assertEqual(creeps['archetypes']['xboostedUpgrader|W15C16M1'], 1)
        self.assertEqual(self.summary['otherCreeps'], 0)

    def test_core_and_distances(self):
        self.assertLessEqual(self.summary['core']['area'], 120)
        self.assertLessEqual(self.summary['distances']['storageToController'], 4)
        self.assertEqual(len(self.summary['distances']['storageToSources']), 2)

    def test_aggregation(self):
        agg = analyze.aggregate_rooms([self.summary])
        self.assertEqual(agg['rooms'], 1)
        self.assertEqual(agg['rcl'], {8: 1})
        self.assertEqual(agg['creepsPerRoom']['mean'], 11)
        arch = analyze.aggregate_archetypes([self.summary])
        self.assertEqual(arch['shauler'], {'C32M16': 5})
        remotes = analyze.remotes_from_creeps([self.summary])
        self.assertEqual(remotes['W18N28']['W17N27'], {'shauler': 5})
        self.assertEqual(remotes['W18N28']['W18N29'], {'ereserve': 1})

    def test_ascii_render(self):
        terrain = load('observe_terrain_W18N28.json')['terrain']
        text = analyze.render_ascii(self.objs, terrain)
        lines = text.split('\n')
        self.assertEqual(len(lines), 51)
        self.assertIn('$', text)
        self.assertIn('C', lines[34])


class RemoteRoomTest(unittest.TestCase):
    def test_remote_summary(self):
        objs = load('observe_room_W19S4.json')['objects']
        summary = analyze.summarize_remote_room('shardX', 'W19S4', objs, KALGEN, game_time=5376000)
        self.assertEqual(summary['reservedBy'], KALGEN)
        self.assertEqual(summary['reservationLeft'], 4113)
        self.assertEqual(len(summary['containers']), 2)
        self.assertEqual(summary['roads'], 58)
        self.assertEqual(summary['creeps']['roles'], {'eharvest': 1})
        self.assertFalse(summary['invaderCore'])


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.history = load('observe_history_W18S4.json')
        self.summary = analyze.summarize_history(self.history, KALGEN)

    def test_creep_behaviour(self):
        by_name = {c['name']: c for c in self.summary['creeps']}
        harvester = by_name['eharvest-L10-W18S4h1-5375256']
        self.assertEqual(harvester['moves'], 0)
        self.assertEqual(set(harvester['unloadTargets']), {'link'})
        upgrader = by_name['xboostedUpgrader-L15-W18S4u1-5375460']
        self.assertEqual(upgrader['moves'], 0)
        self.assertGreater(upgrader['unloaded'], 15 * 30)
        edge = by_name['lhauler-L1600-W19S4h1-6a58da111c4b0fb074fb0865-5374656']
        self.assertEqual(edge['unloadTargets'], {'link': 2})
        self.assertEqual(edge['start'], (1, 16))
        filler = by_name['efiller-W18S4f1-L800-t5375856']
        self.assertIn('extension', filler['unloadTargets'])
        self.assertGreater(filler['movesPerTick'], 0.2)

    def test_roles_sources_and_spawns(self):
        self.assertIn('eharvest', self.summary['roles'])
        self.assertEqual(self.summary['roles']['xboostedUpgrader']['movesPerTick'], 0)
        rates = list(self.summary['sourceHarvestPerTick'].values())
        self.assertEqual(len(rates), 2)
        self.assertTrue(all(rate == 20 for rate in rates), rates)
        self.assertEqual(self.summary['ticks'], 60)
        names = [e['name'] for e in self.summary['spawnEvents']]
        self.assertIn('eharvest-L10-W17S5h1-5375988', names)
        self.assertIn('lhauler-L1600-W19S5h1-6a58d6631ffd5b0691957cfe-5375976', names)
        self.assertTrue(all(e.get('ongoing') for e in self.summary['spawnEvents']))
        # 离开房间的 creep 也保留轨迹与名字
        self.assertIn('shauler-L1600-W18S5h1-5375316', {c['name'] for c in self.summary['creeps']})


class RatesTest(unittest.TestCase):
    def test_derive_rates(self):
        stats = {'creepsProduced': 36897, 'energyHarvested': 9037228, 'energyConstruction': 899273,
                 'energyControl': 3363997, 'energyCreeps': 3016150, 'creepsLost': 182, 'powerProcessed': 20849}
        rates = analyze.derive_rates(stats, 89, 2.47, 8)
        self.assertEqual(rates['windowMinutes'], 64)
        self.assertAlmostEqual(rates['harvestPerRoomTick'], 65.3, delta=1.0)
        self.assertAlmostEqual(rates['energyPerPart'], 81.7, delta=0.2)
        self.assertAlmostEqual(rates['controlShare'], 0.372, delta=0.002)
        self.assertIsNone(analyze.derive_rates({}, 0, 0, 8)['harvestPerRoomTick'])


class DiffAndReportTest(unittest.TestCase):
    def test_diff(self):
        prev = {'profile': {'gcl': 1, 'rooms': 2}, 'archetypes': {'shauler': {'C32M16': 5}},
                'roomList': [{'room': 'A'}, {'room': 'B'}]}
        cur = {'profile': {'gcl': 2, 'rooms': 3}, 'archetypes': {'shauler': {'C32M16': 5, 'C16M8': 1}, 'x': {'M1': 1}},
               'roomList': [{'room': 'A'}, {'room': 'C'}]}
        diff = analyze.diff_summaries(prev, cur)
        self.assertEqual(diff['gcl'], {'from': 1, 'to': 2})
        self.assertEqual(diff['newSignatures'], {'shauler': ['C16M8'], 'x': ['M1']})
        self.assertEqual(diff['roomsLost'], ['B'])
        self.assertEqual(diff['roomsGained'], ['C'])
        self.assertEqual(analyze.diff_summaries(None, cur), {'first': True})

    def test_report_renders(self):
        objs = load('observe_room_W18N28.json')['objects']
        room = analyze.summarize_room('shard3', 'W18N28', objs, KALGEN)
        history = analyze.summarize_history(load('observe_history_W18S4.json'), KALGEN)
        summary = {
            'player': 'Kalgen', 'capturedAt': '2026-09-04T10:00:00Z',
            'profile': {'gcl': 49567233263, 'power': 151106386, 'rooms': 1, 'roomsByShard': {'shard3': ['W18N28']},
                        'ranks': {'world': {'season': '2026-09', 'rank': 0}}},
            'rates': {'8': analyze.derive_rates({'creepsProduced': 100, 'energyHarvested': 1000, 'energyCreeps': 500,
                                                 'energyControl': 300}, 1, 2.5, 8)},
            'selfRates': None,
            'aggregate': analyze.aggregate_rooms([room]),
            'archetypes': analyze.aggregate_archetypes([room]),
            'remotes': analyze.remotes_from_creeps([room]),
            'remoteRooms': [],
            'roomList': [room],
            'history': [history],
            'diff': {'first': True},
        }
        text = report.render_markdown(summary, timeline=[{'capturedAt': summary['capturedAt'], 'gcl': 1,
                                                          'rooms': 1, 'harvestPerRoomTick': 65.0}],
                                      ascii_maps={'shard3/W18N28': 'MAP'})
        self.assertIn('# Kalgen', text)
        self.assertIn('shauler', text)
        self.assertIn('C32M16', text)
        self.assertIn('MAP', text)
        self.assertIn('eharvest', text)


if __name__ == '__main__':
    unittest.main()


class FakeApi:
    """离线假 API：按路径返回固定件，记录调用次数。"""

    def __init__(self):
        self.calls = 0
        self.room = load('observe_room_W18N28.json')
        self.remote = load('observe_room_W19S4.json')

    def get(self, path, params=None):
        self.calls += 1
        params = params or {}
        if path == '/api/user/find':
            return {'ok': 1, 'user': {'_id': KALGEN, 'username': 'Kalgen', 'gcl': 10, 'power': 5}}
        if path == '/api/user/rooms':
            return {'ok': 1, 'shards': {'shard3': ['W18N28', 'W16N28'], 'shardX': ['W18S4']}}
        if path == '/api/leaderboard/find':
            return {'ok': 1, 'list': [{'season': '2026-08', 'rank': 1}, {'season': '2026-09', 'rank': 0}]}
        if path == '/api/game/shards/info':
            return {'ok': 1, 'shards': [{'name': 'shard3', 'tick': 3680.7}, {'name': 'shardX', 'tick': 2473.6}]}
        if path == '/api/user/stats':
            return {'ok': 1, 'stats': {'energyHarvested': 1000, 'creepsProduced': 10, 'energyCreeps': 800}}
        if path == '/api/game/time':
            return {'ok': 1, 'time': 82740900}
        if path == '/api/game/room-objects':
            return self.remote if params.get('room') == 'W17N27' else self.room
        raise AssertionError('unexpected GET ' + path)

    def post(self, path, body=None):
        self.calls += 1
        if path == '/api/game/map-stats':
            levels = {'W18N28': 8, 'W16N28': 7, 'W18S4': 8}
            return {'ok': 1, 'gameTime': 1, 'stats': {room: {'own': {'user': KALGEN, 'level': levels.get(room, 8)}}
                                                      for room in body['rooms']}}
        raise AssertionError('unexpected POST ' + path)


class CaptureTest(unittest.TestCase):
    def test_capture_round_offline(self):
        import tempfile
        from observe import capture as capture_mod
        history = load('observe_history_W18S4.json')
        calls = []

        def fake_history(shard, room, tick, opener=None, timeout=30):
            calls.append((shard, room, tick))
            return history if tick % 200 == 0 else None

        original = capture_mod.fetch_history
        capture_mod.fetch_history = fake_history
        try:
            with tempfile.TemporaryDirectory() as tmp:
                api = FakeApi()
                cap = capture_mod.Capture(api, 'Kalgen', tmp, history_n=2, remotes_n=1, log=lambda *_: None)
                snap = cap.run()
                manifest = load_path(os.path.join(snap, 'manifest.json'))
                self.assertEqual(len(manifest['rooms']), 3)
                # RCL7 的 W16N28 必须优先进 history
                self.assertEqual(manifest['histories'][0][:2], ['shard3', 'W16N28'])
                self.assertEqual(len(manifest['histories']), 2)
                self.assertEqual(len(manifest['remotes']), 1)
                self.assertEqual(manifest['remotes'][0], ['shard3', 'W17N27'])
                self.assertTrue(os.path.exists(os.path.join(snap, 'remotes', 'shard3__W17N27.json')))
                self.assertTrue(os.path.exists(os.path.join(snap, 'objects', 'shardX__W18S4.json')))
                state = load_path(os.path.join(tmp, 'state.json'))
                self.assertEqual(state['lowCursor'], 0)
                self.assertEqual(state['historyCursor'], 1)
                # 第二轮：其余房按游标轮转到下一个
                cap2 = capture_mod.Capture(api, 'Kalgen', tmp, history_n=2, remotes_n=1, log=lambda *_: None)
                snap2 = cap2.run()
                manifest2 = load_path(os.path.join(snap2, 'manifest.json'))
                self.assertEqual(manifest2['histories'][0][:2], ['shard3', 'W16N28'])
                self.assertNotEqual(manifest2['histories'][1][:2], manifest['histories'][1][:2])
        finally:
            capture_mod.fetch_history = original


def load_path(path):
    with open(path) as handle:
        return json.load(handle)
