"""scripts/soak/rcl_dashboard.py 的单测：增量读取、尾行读取、状态计算（速率 / ETA / 序列降采样），以及 HTTP 接口。"""
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from scripts.soak import rcl_dashboard as dash


def make_row(t, rcl, prog, cp, harvest, spawn=0, creeps=3, wall=None):
    return {'t': t, 'dt': 50, 'wall': wall or (1000 + t * 40), 'dwall': 2000, 'rcl': rcl, 'prog': prog, 'progTotal': dash.CONTROLLER_LEVELS.get(rcl, 0),
            'gcl': cp, 'gclLevel': 1, 'owned': {'W1N1': {'rcl': rcl, 'prog': prog, 'progTotal': dash.CONTROLLER_LEVELS.get(rcl, 0), 'spawn': 1, 'ext': 0}},
            'ownedN': 1, 'claims': {}, 'spawnBuilt': {'W1N1': 100}, 'lost': {},
            'acc': {'harvest': harvest, 'harvestHome': harvest, 'harvestRemote': 0, 'upgrade': cp, 'spawn': spawn, 'parts': 4, 'creeps': 1, 'build': 0, 'buildHome': 0,
                    'buildLost': 0, 'residual': 0, 'spawnByRole': {'harvester': spawn}, 'spawnByHome': {}, 'buildByType': {}, 'harvestByRoom': {'W1N1': harvest}, 'upgradeByRoom': {'W1N1': cp}},
            'stock': {'spawnExt': 300, 'tower': 0, 'storage': 0, 'container': 0, 'containerRemote': 0, 'carried': 0, 'dropped': 0, 'droppedRemote': 0, 'tomb': 0, 'ruin': 0, 'other': 0, 'total': 300, 'spawn': 300},
            'creeps': creeps, 'spawning': 0, 'roles': {'harvester': creeps}, 'homeStructs': {'spawn': 1}, 'homeSources': [], 'idleSources': 0, 'sitesN': 0,
            'hostiles': {}, 'cores': [], 'remoteRooms': [], 'reservations': [], 'cpu': 2.0, 'bucket': 10000, 'errN': 0, 'lastErr': None}


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        with open(os.path.join(self.dir, 'run.json'), 'w') as handle:
            json.dump({'args': {'home': 'W1N1', 'cpu': 140, 'sample': 50, 'brainEvery': 5000}, 'spawn': {'x': 5, 'y': 5}, 'startTick': 100, 'startedAt': 1000,
                       'srcRev': 'abc', 'srcCommit': 'abcdef0123', 'worldDir': '/tmp/w', 'rooms': 3}, handle)
        self.rows = [make_row(100 + 50 * i, 1 if i < 4 else 2, (i * 60) % 200 if i < 4 else 100 + i * 60, i * 60, i * 400, spawn=300, creeps=3 + i) for i in range(1, 121)]
        with open(os.path.join(self.dir, 'progress.jsonl'), 'w') as handle:
            for row in self.rows:
                handle.write(json.dumps(row) + '\n')
        with open(os.path.join(self.dir, 'levels.json'), 'w') as handle:
            json.dump([{'room': 'W1N1', 'level': 2, 'tick': 320, 'sinceStart': 220, 'sincePrev': 220}], handle)
        with open(os.path.join(self.dir, 'events.jsonl'), 'w') as handle:
            handle.write(json.dumps({'event': 'restart', 't': 500, 'wall': 5000}) + '\n')

    def test_tail_lines_reads_last_records(self):
        items = dash.tail_lines(os.path.join(self.dir, 'progress.jsonl'), 3)
        self.assertEqual([i['t'] for i in items], [r['t'] for r in self.rows[-3:]])
        self.assertEqual(dash.tail_lines(os.path.join(self.dir, 'missing.jsonl'), 3), [])

    def test_reader_is_incremental_and_tolerates_partial_lines(self):
        reader = dash.RunReader(self.dir)
        reader.refresh()
        self.assertEqual(len(reader.rows), 120)
        with open(os.path.join(self.dir, 'progress.jsonl'), 'a') as handle:
            handle.write(json.dumps(make_row(6150, 2, 999, 7300, 48400))[:40])   # 半行
        reader.refresh()
        self.assertEqual(len(reader.rows), 120)
        with open(os.path.join(self.dir, 'progress.jsonl'), 'a') as handle:
            handle.write(json.dumps(make_row(6150, 2, 999, 7300, 48400))[40:] + '\n')
        reader.refresh()
        self.assertEqual(len(reader.rows), 121)
        self.assertEqual(reader.rows[-1]['t'], 6150)

    def test_state_rates_eta_and_series(self):
        reader = dash.RunReader(self.dir)
        state = dash.build_state(reader, None, 5)
        self.assertTrue(state['ready'])
        self.assertEqual(state['tick'], 6000)
        self.assertEqual(state['rcl'], 2)
        # 每 50 tick CP +60 → 1.2/tick；两种窗口都应给出同样的速率
        self.assertAlmostEqual(state['rate5']['upgrade'], 1.2)
        self.assertAlmostEqual(state['rate1']['harvest'], 8.0)
        self.assertAlmostEqual(state['homeRate5'], 1.2)
        self.assertAlmostEqual(state['eta']['levelTicks'], (45000 - state['prog']) / 1.2)
        self.assertAlmostEqual(state['tps'], 25.0)   # dt 50 / dwall 2000 ms
        self.assertEqual(state['levels'][0]['level'], 2)
        self.assertEqual(state['events'][-1]['event'], 'restart')
        self.assertTrue(len(state['series']) <= dash.MAX_POINTS + 1)
        self.assertEqual(state['series'][-1]['t'], 6000)
        self.assertTrue(state['rates'])
        self.assertEqual([s['level'] for s in state['stages']], [1, 2])
        self.assertIn('W1N1', state['owned'])

    def test_http_endpoints(self):
        reader = dash.RunReader(self.dir)
        server = ThreadingHTTPServer(('127.0.0.1', 0), dash.make_handler(reader, None, 5))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state') as response:
                state = json.loads(response.read().decode('utf-8'))
            self.assertTrue(state['ready'])
            self.assertEqual(state['tick'], 6000)
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/') as response:
                html = response.read().decode('utf-8')
            self.assertIn('RCL 基准看板', html)
            self.assertIn('/api/state', html)
        finally:
            server.shutdown()
            server.server_close()

    def test_empty_run_is_not_ready(self):
        empty = tempfile.mkdtemp()
        with open(os.path.join(empty, 'run.json'), 'w') as handle:
            json.dump({'args': {'home': 'W1N1'}, 'startTick': 1}, handle)
        state = dash.build_state(dash.RunReader(empty), None, 5)
        self.assertFalse(state['ready'])


if __name__ == '__main__':
    unittest.main()
