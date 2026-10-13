"""scripts/soak/rcl_ab.py：同一快照分叉的多跑对比。合成两份 progress.jsonl/samples.jsonl 验证账本差分、storage 曲线与无 spawn 房时间线。"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.soak import rcl_ab  # noqa: E402


def make_run(root, name, rev, cp_per_tick, storage_end, spawnless=None):
    run_dir = os.path.join(root, name)
    os.makedirs(run_dir)
    with open(os.path.join(run_dir, 'run.json'), 'w') as fh:
        json.dump({'srcRev': rev, 'srcCommit': rev + '0' * 33, 'forkedFrom': {'dbFile': '/x/db-snap.json', 'tick': 1000}}, fh)
    rows = []
    for i in range(0, 7):
        t = 1000 + i * 5000
        frac = i / 6.0
        owned = {
            'W1': {'rcl': 7, 'prog': 100 + i, 'progTotal': 1000, 'storage': 3000, 'links': 0 if i < 3 else 2, 'linkE': 400 * (i >= 3)},
            'W2': {'rcl': 4 if i else 3, 'prog': 10 * i, 'progTotal': 400, 'storage': int(storage_end * frac),
                   'srcCont': 1000 + 100 * i, 'ctrlCont': 50, 'drop': 2000 if rev == 'aaaaaaa' else 4000, 'dropN': 2,
                   'contHits': 400000 if rev == 'aaaaaaa' else 200000, 'contMinHits': 150000 if rev == 'aaaaaaa' else 60000, 'contN': 2, 'towerE': 800},
        }
        if spawnless and i >= 2:
            owned['W3'] = {'rcl': 1, 'prog': i, 'progTotal': 200, 'storage': 0}
        rows.append({
            't': t, 'gcl': 5000 + cp_per_tick * (t - 1000), 'creeps': 10 + i,
            'roles': {'upgrader': 2 + (i % 2), 'hauler': 3},
            'acc': {'harvest': 100 * i, 'spawn': 40 * i, 'build': 5 * i,
                    'upgradeByRoom': {'W1': 30 * (t - 1000), 'W2': int(cp_per_tick * (t - 1000))},
                    'harvestByRoom': {'W1': 100 * i, 'W2': 30 * (t - 1000), 'R1': 20 * (t - 1000)}, 'spawnByRemote': {'R1': 8 * (t - 1000)}},
            'remoteRooms': ['R1'],
            'owned': owned,
            'roomsMem': {'W2': {'targets': {'upgrader': 1 if i < 3 else 3}, 'remotes': [['R1', 1, '', 0]]}},
            'claims': {'W3': 11000} if spawnless else {},
            'haulerTasks': {'W2': {'srcContainer': 2, 'storage': 1 if rev == 'bbbbbbb' else 0, 'drop': 0, 'deliver': 1, 'idle': 0}},
            'feeders': {'W2': {'n': 1, 'loaded': 1 if i % 2 else 0}} if rev == 'bbbbbbb' else {},
            'spawnBuilt': {'W1': 1000, 'W2': 1000},
            'errN': 0, 'downgrades': 0,
        })
    with open(os.path.join(run_dir, 'progress.jsonl'), 'w') as fh:
        for row in rows:
            fh.write(json.dumps(row) + '\n')
    samples = []
    if spawnless:
        for i, (spawn_prog, road_prog, roads, done) in enumerate(spawnless):
            room = {'mine': True, 'structs': {'road': roads}, 'sites': []}
            if done:
                room['structs']['spawn'] = 1
            else:
                room['sites'] = [['spawn', 5, 5, spawn_prog, 15000], ['road', 1, 1, road_prog, 300], ['road', 2, 2, 0, 300]]
            samples.append({'t': 11000 + i * 500, 'rooms': {'W3': room, 'W1': {'mine': True, 'structs': {'spawn': 1}, 'sites': [['link', 5, 5, 100, 5000]] if i else []}}})
    with open(os.path.join(run_dir, 'samples.jsonl'), 'w') as fh:
        for s in samples:
            fh.write(json.dumps(s) + '\n')
    return run_dir


class AbTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.a = make_run(self.tmp, 'a', 'aaaaaaa', 2.0, 120000)
        self.b = make_run(self.tmp, 'b', 'bbbbbbb', 5.0, 30000,
                          spawnless=[(0, 100, 0, False), (8000, 300, 1, False), (0, 0, 3, True)])

    def test_totals_and_rooms(self):
        fa, fb = rcl_ab.load_fork(self.a), rcl_ab.load_fork(self.b)
        ta, tb = rcl_ab.totals(fa), rcl_ab.totals(fb)
        self.assertEqual(ta['ticks'], 30000)
        self.assertAlmostEqual(ta['cpPerTick'], 2.0)
        self.assertAlmostEqual(tb['cpPerTick'], 5.0)
        self.assertAlmostEqual(ta['harvestPerTick'], 600 / 30000.0)
        self.assertAlmostEqual(ta['rolesAvg']['upgrader'], 2 + 3 / 7.0)
        ra, rb = rcl_ab.per_room(fa), rcl_ab.per_room(fb)
        self.assertAlmostEqual(ra['W2']['cpPerTick'], 2.0)
        self.assertEqual(ra['W2']['storageStart'], 0)
        self.assertEqual(ra['W2']['storageEnd'], 120000)
        self.assertEqual(rb['W2']['storageEnd'], 30000)
        self.assertEqual(ra['W2']['rclStart'], 3)
        self.assertEqual(ra['W2']['rclEnd'], 4)
        self.assertAlmostEqual(ra['W2']['upgraderTarget'], (1 * 3 + 3 * 4) / 7.0)
        self.assertEqual(rb['W3']['claimedAt'], 11000)
        remotes = rcl_ab.per_remote(fa)
        self.assertAlmostEqual(remotes['R1']['gross'], 20.0)
        self.assertAlmostEqual(remotes['R1']['spend'], 8.0)
        self.assertAlmostEqual(remotes['R1']['net'], 12.0)
        self.assertNotIn('W1', remotes)
        ta, tb = rcl_ab.transport(fa), rcl_ab.transport(fb)
        self.assertAlmostEqual(ta['W2']['drop'], 2000.0)
        self.assertAlmostEqual(tb['W2']['drop'], 4000.0)
        self.assertAlmostEqual(ta['W2']['srcCont'], 1300.0)
        self.assertAlmostEqual(ta['W2']['shares']['srcContainer'], 2 / 3.0)
        self.assertAlmostEqual(tb['W2']['shares']['storage'], 0.25)
        self.assertEqual(tb['W2']['taskSamples'], 28)
        self.assertAlmostEqual(tb['W2']['haulers'], 4.0)
        self.assertAlmostEqual(ta['W2']['haulers'], 3.0)
        self.assertNotIn('srcCont', ta['W1']['shares'])
        self.assertEqual(ta['W2']['feeders'], 0)
        self.assertIsNone(ta['W2']['feederLoaded'])
        self.assertAlmostEqual(tb['W2']['feeders'], 1.0)
        self.assertAlmostEqual(tb['W2']['feederLoaded'], 3 / 7.0)
        self.assertAlmostEqual(ta['W2']['contHitsAvg'], 200000.0)
        self.assertEqual(ta['W2']['contMinHits'], 150000)
        self.assertEqual(tb['W2']['contMinHits'], 60000)
        self.assertAlmostEqual(ta['W2']['towerE'], 800.0)
        self.assertIsNone(ta['W1']['contHitsAvg'])
        self.assertNotIn('W3', ra)

    def test_spawnless_timeline(self):
        fb = rcl_ab.load_fork(self.b)
        tl = rcl_ab.spawnless_timeline(fb)
        self.assertEqual(list(tl.keys()), ['W3'])
        entries = tl['W3']
        self.assertEqual(len(entries), 3)
        self.assertEqual(entries[0]['spawnProg'], 0)
        self.assertEqual(entries[1]['spawnProg'], 8000)
        self.assertEqual(entries[1]['roadProg'], 300)
        self.assertEqual(entries[1]['roadSites'], 2)
        self.assertTrue(entries[2]['spawnDone'])
        self.assertEqual(entries[2]['roads'], 3)
        self.assertEqual(rcl_ab.spawnless_timeline(rcl_ab.load_fork(self.a)), {})

    def test_income_by_home(self):
        inc = rcl_ab.income_by_home(rcl_ab.load_fork(self.a))
        self.assertAlmostEqual(inc['W2']['own'], 30.0)
        self.assertAlmostEqual(inc['W2']['remote'], 20.0)
        self.assertAlmostEqual(inc['W2']['income'], 50.0)
        self.assertAlmostEqual(inc['W2']['remoteSpend'], 8.0)
        self.assertAlmostEqual(inc['W2']['cp'], 2.0)
        self.assertAlmostEqual(inc['W2']['cpShare'], 0.04)
        self.assertAlmostEqual(inc['W1']['remote'], 0.0)
        self.assertIsNone(inc['W1']['cpShare'] and None)

    def test_link_timeline(self):
        fb = rcl_ab.load_fork(self.b)
        tl = rcl_ab.link_timeline(fb)
        self.assertEqual(tl['W1']['built'], [(0, 0), (15000, 2)])
        self.assertEqual(tl['W1']['linksEnd'], 2)
        self.assertEqual(tl['W1']['firstSite'], 10500)
        self.assertAlmostEqual(tl['W1']['linkEAvg'], 400 * 4 / 7.0)
        self.assertIsNone(tl['W2']['firstSite'])
        self.assertIsNone(tl['W2']['linkEAvg'])

    def test_render(self):
        text = rcl_ab.render([rcl_ab.load_fork(self.a), rcl_ab.load_fork(self.b)], ['W2'])
        self.assertIn('aaaaaaa vs bbbbbbb', text)
        self.assertIn('db-snap.json', text)
        self.assertIn('| 全账号 CP/tick | 2.0 | 5.0 |', text)
        self.assertIn('| W2 | 2.0 | 3→4 | 0.0k→120.0k (0.0k) |', text)
        self.assertIn('| 15000 | 60.0k | 15.0k |', text)
        self.assertIn('bbbbbbb — W3', text)
        self.assertIn('| W1 | - | 2@15000 | 229 | 10500 | 2@15000 | 229 |', text)
        self.assertIn('| W2 | 30.0 | 20.0 | 50.0 | 2.0 | 4% | 30.0 | 20.0 | 50.0 | 5.0 | 10% |', text)
        self.assertIn('| 11500 | 8000/15000 | 300/2 | 1 |', text)
        self.assertIn('| 12000 | 建成 | - | 3 |', text)
        self.assertIn('| R1 | 20.0 | 8.0 | 12.0 | 20.0 | 8.0 | 12.0 |', text)
        self.assertIn('| W2 | 2.0k (2.0) | 1.3k | 50 | 3.0 | 67%/0%/0%/33%/0% | - | 200.0k (150.0k) | 800 |', text)
        self.assertIn('| 4.0k (2.0) | 1.3k | 50 | 4.0 | 50%/25%/0%/25%/0% | 1.0 (43%) | 100.0k (60.0k) | 800 |', text)

    def test_main_writes_file(self):
        out = os.path.join(self.tmp, 'ab.md')
        self.assertEqual(rcl_ab.main([self.a, self.b, '--rooms', 'W2', '--out', out]), 0)
        with open(out) as fh:
            self.assertIn('## 重点房 storage 曲线', fh.read())


if __name__ == '__main__':
    unittest.main()
