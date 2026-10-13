"""scripts/soak/rcl_report.py 的单测：阶段切分、账目差分、潜在采集/自产估计、下限与效率、Markdown 渲染。"""
import unittest

from scripts.soak import rcl_report as report


def row(t, rcl, prog, acc, stock_total=0, spawn_energy=0, ext=0, remote_rooms=(), reservations=(), idle=0, dropped=0, dt=50, upgrade=None, spawning=0, cpu=5.0,
        owned=None, claims=None, spawn_built=None):
    base = {'harvest': 0, 'harvestHome': 0, 'harvestRemote': 0, 'upgrade': 0, 'spawn': 0, 'parts': 0, 'creeps': 0, 'build': 0, 'buildHome': 0, 'buildLost': 0,
            'spawnByRole': {}, 'spawnByHome': {}, 'spawnByRemote': {}, 'buildByType': {}, 'harvestByRoom': {}, 'upgradeByRoom': {}}
    base.update(acc)
    owned = owned or {'W1N1': {'rcl': rcl, 'prog': prog, 'spawn': 1, 'ext': ext}}
    return {
        't': t, 'dt': dt, 'wall': 1000 + t * 30, 'rcl': rcl, 'prog': prog, 'gcl': base['upgrade'], 'gclLevel': 1,
        'owned': owned, 'ownedN': len(owned), 'claims': claims or {}, 'spawnBuilt': spawn_built or {}, 'lost': {},
        'acc': base, 'stock': {'total': stock_total, 'spawn': spawn_energy, 'spawnExt': spawn_energy, 'storage': 0, 'carried': 0, 'dropped': dropped, 'droppedRemote': 0},
        'creeps': 3, 'spawning': spawning, 'roles': {'harvester': 2, 'upgrader': 1}, 'homeStructs': {'spawn': 1, 'extension': ext},
        'homeSources': [{'x': 1, 'y': 1, 'energy': 3000, 'regenAt': 0, 'cap': 3000}, {'x': 2, 'y': 2, 'energy': 3000, 'regenAt': 0, 'cap': 3000}],
        'idleSources': idle, 'hostiles': {}, 'cores': [], 'remoteRooms': list(remote_rooms), 'reservations': [list(r) for r in reservations],
        'cpu': cpu, 'bucket': 9000, 'errN': 0, 'lastErr': None, 'downgradeIn': 19000,
    }


def make_run():
    run = {'args': {'home': 'W1N1', 'cpu': 140, 'sample': 50, 'brainEvery': 5000}, 'spawn': {'x': 5, 'y': 5}, 'rooms': 3, 'startTick': 100, 'startedAt': 1000,
           'srcRev': 'abc', 'srcCommit': 'abcdef0123456789'}
    rows = [
        row(150, 1, 100, {'harvest': 100, 'harvestHome': 100, 'upgrade': 100, 'upgradeByRoom': {'W1N1': 100}, 'spawn': 300, 'parts': 4, 'creeps': 1, 'spawnByRole': {'harvester': 300}}, stock_total=50, spawn_energy=50, dt=50),
        row(200, 1, 190, {'harvest': 400, 'harvestHome': 400, 'upgrade': 190, 'upgradeByRoom': {'W1N1': 190}, 'spawn': 300, 'parts': 4, 'creeps': 1, 'spawnByRole': {'harvester': 300}}, stock_total=80, spawn_energy=80, dt=50),
        row(250, 2, 20, {'harvest': 900, 'harvestHome': 900, 'upgrade': 220, 'upgradeByRoom': {'W1N1': 220}, 'spawn': 500, 'parts': 7, 'creeps': 2, 'spawnByRole': {'harvester': 300, 'upgrader': 200}, 'build': 100, 'buildByType': {'extension': 100}},
            stock_total=300, spawn_energy=300, dt=50),
        row(300, 2, 520, {'harvest': 2400, 'harvestHome': 1900, 'harvestRemote': 500, 'upgrade': 720, 'upgradeByRoom': {'W1N1': 720}, 'spawn': 500, 'parts': 7, 'creeps': 2, 'spawnByRole': {'harvester': 300, 'upgrader': 200}, 'build': 400, 'buildByType': {'extension': 400}},
            stock_total=300, spawn_energy=300, remote_rooms=('W2N1',), reservations=(('W2N1', 500, None),), idle=1, dropped=2500, dt=50),
    ]
    levels = [{'room': 'W1N1', 'level': 2, 'tick': 215, 'sampleTick': 250, 'sinceStart': 115, 'sincePrev': 115}]
    return run, rows, levels


def make_multi_run():
    """母房 + 一个新占的房：总 CP 与母房 CP 分开，占领时间线与外矿账。"""
    run, rows, levels = make_run()
    rows.append(row(350, 2, 900, {'harvest': 3400, 'harvestHome': 2500, 'harvestRemote': 900, 'upgrade': 1300, 'spawn': 1900, 'parts': 17, 'creeps': 5,
                                  'spawnByRole': {'harvester': 300, 'upgrader': 200, 'claimer': 650, 'remoteMiner': 550, 'reserver': 200}, 'spawnByRemote': {'W2N1': 750},
                                  'upgradeByRoom': {'W1N1': 1100, 'W3N1': 200}, 'harvestByRoom': {'W1N1': 2500, 'W2N1': 900}, 'build': 400, 'buildByType': {'extension': 400}},
                    stock_total=300, spawn_energy=300, remote_rooms=('W2N1',), reservations=(('W2N1', 500, None),), dt=50,
                    owned={'W1N1': {'rcl': 2, 'prog': 900, 'spawn': 1, 'ext': 0}, 'W3N1': {'rcl': 2, 'prog': 0, 'spawn': 0, 'ext': 0}},
                    claims={'W3N1': 400}, spawn_built={'W1N1': 100}))
    levels.append({'room': 'W3N1', 'level': 2, 'tick': 340, 'sampleTick': 350, 'sinceStart': 240, 'sincePrev': 40})
    return run, rows, levels


class StageTest(unittest.TestCase):
    def test_stages_split_by_level_and_accounts_are_deltas(self):
        run, rows, levels = make_run()
        stages = report.build_stages(run, rows, levels, 'W1N1', {'W2N1': 2})
        self.assertEqual([s['level'] for s in stages], [1, 2])
        first, second = stages
        # 阶段 1：开局 → 升级 tick 215（插值），账目从零起算，并计初始 300
        self.assertEqual(first['tStart'], 0)
        self.assertEqual(first['tEnd'], 115)
        self.assertEqual(first['ticks'], 115)
        self.assertFalse(first['inProgress'])
        self.assertEqual(first['acc']['harvest'], 400)
        self.assertEqual(first['acc']['spawn'], 300)
        self.assertEqual(first['initial'], 300)
        self.assertEqual(first['regen'], 100)          # 两条记录 spawn 能量都 < 300：50 + 50 tick
        self.assertEqual(first['income'], 400 + 100 + 300)
        self.assertEqual(first['residual'], first['income'] - 190 - 300 - 0 - (80 - 0))
        # 阶段 2：进行中，账目是与上一阶段末记录之差
        self.assertTrue(second['inProgress'])
        self.assertEqual(second['tStart'], 115)
        self.assertEqual(second['acc']['harvest'], 2000)
        self.assertEqual(second['acc']['harvestRemote'], 500)
        self.assertEqual(second['acc']['spawn'], 200)
        self.assertEqual(second['acc']['spawnByRole'], {'upgrader': 200})
        self.assertEqual(second['acc']['build'], 400)
        self.assertEqual(second['acc']['buildByType'], {'extension': 400})
        self.assertEqual(second['regen'], 0)           # spawn 满 300 不自产
        self.assertEqual(second['deltaStock'], 300 - 80)

    def test_potential_and_utilisation(self):
        run, rows, levels = make_run()
        stages = report.build_stages(run, rows, levels, 'W1N1', {'W2N1': 2})
        second = stages[1]
        stats = second['stats']
        # 100 tick × 2 母房源 × 10 = 2000；外矿 W2N1 只在最后一条记录活跃且有预定：50 × 2 × 10 = 1000
        self.assertEqual(stats['potentialHome'], 2000)
        self.assertEqual(stats['potentialRemote'], 1000)
        self.assertAlmostEqual(second['sourceUtilHome'], 1500 / 2000)
        self.assertAlmostEqual(second['sourceUtilRemote'], 0.5)
        self.assertEqual(stats['idleSourceTicks'], 50)
        self.assertAlmostEqual(stats['droppedDecay'], 50 * 2.5)
        self.assertEqual(stats['remoteRooms'], ['W2N1'])
        self.assertAlmostEqual(second['spawnUtil'], 3 * 3 / (1 * second['ticks']))

    def test_bounds_and_efficiency(self):
        run, rows, levels = make_run()
        stages = report.build_stages(run, rows, levels, 'W1N1', {})
        first = stages[0]
        self.assertEqual(first['need'], 200)
        self.assertEqual(first['boundHomeOnly'], 10)
        self.assertAlmostEqual(first['boundIncome'], 200 / (400 / 115))
        self.assertAlmostEqual(first['efficiencyHomeOnly'], 10 / 115)
        self.assertIsNone(stages[1]['efficiencyHomeOnly'])   # 进行中的阶段不算效率

    def test_unreserved_remote_counts_half_rate(self):
        run, rows, levels = make_run()
        rows[-1]['reservations'] = []
        stages = report.build_stages(run, rows, levels, 'W1N1', {'W2N1': 2})
        self.assertEqual(stages[1]['stats']['potentialRemote'], 500)

    def test_render_markdown_mentions_every_stage(self):
        run, rows, levels = make_run()
        summary = report.summarize(run, rows, levels, [{'event': 'restart'}], None)
        text = report.render_markdown(run, summary)
        self.assertIn('| 1→2 |', text)
        self.assertIn('2→3（进行中）', text)
        self.assertIn('重启 1 次', text)
        self.assertIn('己方房源未采满', text)
        self.assertIn('819,010', text)
        self.assertEqual(summary['overall']['reachedLevel'], 2)
        self.assertEqual(summary['overall']['acc']['harvest'], 2400)


class MultiRoomTest(unittest.TestCase):
    def test_total_cp_split_and_remote_economy(self):
        run, rows, levels = make_multi_run()
        stages = report.build_stages(run, rows, levels, 'W1N1', {'W2N1': 2, 'W3N1': 2})
        second = stages[1]
        self.assertEqual(second['cp'], 1300 - 190)        # 账号总 CP 增量
        self.assertEqual(second['progressed'], 1100 - 190)      # 母房自己的进度（upgradeByRoom 相对上一阶段末）
        self.assertEqual(second['cpOthers'], 200)
        self.assertEqual(second['ownedEnd'], ['W1N1', 'W3N1'])
        self.assertEqual(second['expansionSpend'], 650)
        remote = second['remote']
        self.assertEqual(remote['gross'], 900)
        self.assertEqual(remote['spend'], 750)
        self.assertEqual(remote['net'], 150)
        self.assertEqual(remote['perRemote']['W2N1'], {'gross': 900, 'spend': 750, 'net': 150, 'netRate': None})
        # 新房算进己方源潜在：最后一条记录 50 tick × (2 + 2) 源 × 10
        self.assertEqual(second['stats']['potentialOwned'], 50 * 2 * 10 * 2 + 50 * 4 * 10)

    def test_claim_timeline_and_cp_windows(self):
        run, rows, levels = make_multi_run()
        # 降级后弹回的重复条目：采样里 W3N1 从 350 起就已是 RCL2，这条 sampleTick 600 的"升级"要被丢掉（哪怕它的 tick 更早）
        levels = levels + [{'room': 'W3N1', 'level': 2, 'tick': 300, 'sampleTick': 600, 'sinceStart': 200, 'sincePrev': 80}]
        timeline = report.claim_timeline(run, rows, levels, 'W1N1')
        self.assertEqual(len(timeline), 1)
        self.assertEqual(timeline[0]['room'], 'W3N1')
        self.assertEqual(timeline[0]['claimed'], 300)
        self.assertIsNone(timeline[0]['spawnBuilt'])
        self.assertEqual(timeline[0]['levels'], [(2, 240)])
        self.assertEqual(timeline[0]['cp'], 200)
        windows = report.cp_windows(run, rows, 'W1N1', window=100)
        self.assertEqual([w['to'] for w in windows], [150, 250])
        self.assertAlmostEqual(windows[-1]['cpRate'], (1300 - 220) / 100)
        self.assertAlmostEqual(windows[-1]['homeRate'], (1100 - 220) / 100)
        self.assertAlmostEqual(windows[-1]['othersRate'], 200 / 100)
        self.assertEqual(windows[-1]['rooms'], 2)
        text = report.render_markdown(run, report.summarize(run, rows, levels, [], None, window=100))
        self.assertIn('## 账号总 Control Point 增长', text)
        self.assertIn('| W3N1 | 300 |', text)
        self.assertIn('占领/开荒孵化', text)
        self.assertIn('## 外矿', text)


class DiffTest(unittest.TestCase):
    def test_diff_acc_handles_missing_breakdowns(self):
        last = {'acc': {'harvest': 10, 'spawnByRole': {'a': 5}}}
        self.assertEqual(report.diff_acc(last, None)['harvest'], 10)
        self.assertEqual(report.diff_acc(last, None)['spawnByRole'], {'a': 5})
        self.assertEqual(report.diff_acc(last, {'acc': {'harvest': 4, 'spawnByRole': {'a': 5}}})['spawnByRole'], {})


if __name__ == '__main__':
    unittest.main()
