"""scripts/soak/haul_ab.py：同一快照分叉的运输饱和度对比。合成两份 progress.jsonl（带 haul 累计计数）验证窗口差分与各项比例。"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.soak import haul_ab  # noqa: E402


def make_run(root, name, rev, idle_per_sample, chain_per_sample):
    run_dir = os.path.join(root, name)
    os.makedirs(run_dir)
    with open(os.path.join(run_dir, 'run.json'), 'w') as fh:
        json.dump({'srcRev': rev, 'srcCommit': rev + '0' * 33}, fh)
    rows = []
    for i in range(0, 6):
        t = 1000 + i * 1000
        # 每 1000 tick：2 只 hauler × 1000 tick = 2000 个观察 tick；idle / 动作 / 同步挪位按参数给
        hauler = {'t': 2000 * i, 'cap': 2000 * 500 * i, 'idle': idle_per_sample * i, 'idleE': idle_per_sample * i, 'idleL': 0, 'fat': 0,
                  'mvE': 500 * i, 'mvL': (1500 - idle_per_sample - 200) * i, 'lf': 0.8 * (1500 - idle_per_sample - 200) * i,
                  'ld': 100 * i, 'ul': 100 * i, 'ch': chain_per_sample * i, 'in': 50000 * i, 'out': 50000 * i,
                  'cu': 0.4 * 2000 * i, 'dep': 100 * i, 'df': 90 * i, 'churn': 10 * i,
                  'rs': {'park': idle_per_sample * i}, 'ri': {'park': idle_per_sample * i}}
        row = {'t': t, 'gcl': 10 * (t - 1000), 'acc': {'upgradeByRoom': {'W1': 5 * (t - 1000)}, 'harvest': 20 * (t - 1000),
                                                    'spawnByRole': {'hauler': 2 * (t - 1000)}},
               'owned': {'W1': {'srcCont': 500, 'drop': 100, 'storage': 1000}}}
        if i >= 1:   # 第一条行没有 haul（遥测上线前的快照），窗口要从第一条带 haul 的行算起
            row['haul'] = {'v': 1, 'rooms': {'W1': {'hauler': hauler}}}
        rows.append(row)
    with open(os.path.join(run_dir, 'progress.jsonl'), 'w') as fh:
        for row in rows:
            fh.write(json.dumps(row) + '\n')
    return run_dir


class HaulAbTest(unittest.TestCase):
    def test_window_diff_and_ratios(self):
        with tempfile.TemporaryDirectory() as root:
            base = make_run(root, 'a', 'aaaaaaa', idle_per_sample=800, chain_per_sample=0)
            new = make_run(root, 'b', 'bbbbbbb', idle_per_sample=200, chain_per_sample=150)
            ra = haul_ab.analyse(base, warmup=1500)
            rb = haul_ab.analyse(new, warmup=1500)
            # warmup 1500 → 窗口从 t=3000 到 t=6000（3000 tick），差分 = 3 个采样增量
            self.assertEqual((ra['tStart'], ra['tEnd'], ra['ticks']), (3000, 6000, 3000))
            ma = ra['homes']['W1']['hauler']
            mb = rb['homes']['W1']['hauler']
            self.assertAlmostEqual(ma['carriers'], 2.0)
            self.assertAlmostEqual(ma['busy'], 1 - 800 / 2000)
            self.assertAlmostEqual(mb['busy'], 1 - 200 / 2000)
            self.assertAlmostEqual(mb['chain'], 150 / 200)
            self.assertEqual(ma['chain'], 0)
            self.assertAlmostEqual(ma['load'], 0.8)
            self.assertAlmostEqual(ma['perCarry'], 50000 * 50 / (2000 * 500))
            self.assertAlmostEqual(ma['reasons']['park'], 800 / 2000)
            self.assertAlmostEqual(ma['cargo'], 0.4)
            self.assertAlmostEqual(ma['depFill'], 0.9)
            self.assertAlmostEqual(ma['churnPerTick'], 10 * 3 / 3000)
            self.assertAlmostEqual(ra['ledger']['cpTotal'], 10.0)
            self.assertAlmostEqual(ra['ledger']['spawnByRole']['hauler'], 2.0)
            text = haul_ab.render([ra, rb])
            self.assertIn('W1 · hauler', text)
            self.assertIn('| aaaaaaa | 2.00 | 60% |', text)
            self.assertIn('| bbbbbbb | 2.00 | 90% |', text)

    def test_v2_counters_rooms_and_lines(self):
        with tempfile.TemporaryDirectory() as root:
            run_dir = os.path.join(root, 'v2')
            os.makedirs(run_dir)
            with open(os.path.join(run_dir, 'run.json'), 'w') as fh:
                json.dump({'srcRev': 'ccccccc', 'srcCommit': 'ccccccc' + '0' * 33}, fh)
            with open(os.path.join(run_dir, 'progress.jsonl'), 'w') as fh:
                for i in range(0, 4):
                    t = 1000 + i * 1000
                    hauler = {'t': 1000 * i, 'cap': 1000 * 500 * i, 'idle': 100 * i, 'idleE': 100 * i, 'mvE': 300 * i, 'mvL': 400 * i,
                              'lf': 300 * i, 'ld': 100 * i, 'ul': 100 * i, 'ch': 50 * i, 'out': 20000 * i, 'cu': 400 * i, 'dep': 50 * i, 'df': 40 * i,
                              'ac': 200 * i, 'acm': 120 * i, 'tw': 30 * i, 'mvP': 20 * i, 'abL': 5 * i, 'abE': 5 * i, 'lgS': 600 * i, 'lgD': 500 * i,
                              'egS': 450 * i, 'egD': 500 * i, 'dp8': 10 * i, 'idWa': 40 * i, 'idSt': 40 * i, 'idOv': 20 * i, 'lostAge': 60 * i}
                    room = {'ticks': 1000 * i, 'rfN': 4 * i, 'rfT': 120 * i, 'rfD': 4000 * i, 'lkF': 100 * i, 'lsF': 50 * i, 'spW': 10 * i}
                    lines = {'W2': {'t': 500 * i, 'idle': 50 * i, 'tw': 25 * i, 'ac': 20 * i, 'acm': 10 * i, 'dep': 5 * i, 'df': 4 * i, 'out': 4000 * i, 'cap': 500 * 400 * i, 'lostAge': 0}}
                    fh.write(json.dumps({'t': t, 'gcl': 0, 'acc': {}, 'owned': {}, 'haul': {'v': 2, 'rooms': {'W1': {'hauler': hauler, '_room': room, '_lines': lines}}}}) + '\n')
            r = haul_ab.analyse(run_dir, warmup=0)
            m = r['account']['hauler']
            self.assertTrue(m['v2'])
            self.assertAlmostEqual(m['actMove'], 0.6)
            self.assertAlmostEqual(m['trickle'], 0.03)
            self.assertAlmostEqual(m['detourLoaded'], 1.2)
            self.assertAlmostEqual(m['partialDep'], 0.2)
            self.assertAlmostEqual(m['lostPerLife'], 60 * 1500 / 1000)
            self.assertAlmostEqual(r['rooms']['W1']['refillTicks'], 30)
            self.assertAlmostEqual(r['rooms']['W1']['ctrlLinkFull'], 0.1)
            self.assertAlmostEqual(r['lines']['W1→W2']['trickle'], 0.05)
            text = haul_ab.render([r])
            self.assertIn('全账号 v2 细分', text)
            self.assertIn('W1→W2', text)
            self.assertNotIn('_room', text)

    def test_until_aligns_unequal_runs_and_reports_missing(self):
        with tempfile.TemporaryDirectory() as root:
            run = make_run(root, 'a', 'aaaaaaa', idle_per_sample=800, chain_per_sample=0)
            r = haul_ab.analyse(run, warmup=0, until=3000)
            self.assertEqual((r['tStart'], r['tEnd']), (2000, 4000))
            empty = haul_ab.analyse(run, warmup=100000)
            self.assertIn('error', empty)
            self.assertIn('没有足够的 haul 采样', haul_ab.render([empty]))


if __name__ == '__main__':
    unittest.main()
