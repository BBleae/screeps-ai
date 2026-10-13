#!/usr/bin/env python3
import math
import unittest

from scripts.report import sk_roi


class SkRoiTest(unittest.TestCase):
    def test_killer_needs_rcl7_capacity(self):
        self.assertIsNone(sk_roi.killer_body(1650))
        self.assertIsNone(sk_roi.killer_body(2300))
        killer = sk_roi.killer_body(5600)
        self.assertIsNotNone(killer)
        # 单挑一只 Keeper：F = ceil(5000 / 30A) tick，贴身每 tick 受 400、自疗 12H，靠近先吃 200
        fight = math.ceil(5000 / (30 * killer['attack']))
        damage = fight * max(0, 400 - 12 * killer['heal']) + 200
        self.assertEqual(killer['fightTicks'], fight)
        self.assertAlmostEqual(killer['damageTaken'], damage)
        self.assertLessEqual(damage, killer['parts'] * 100 * 0.8)
        self.assertLessEqual(damage / (12 * killer['heal']), 100)   # 3 个 lair：100 tick 内回满
        self.assertEqual(killer['move'], killer['attack'] + killer['heal'])
        self.assertLessEqual(killer['cost'], 5600)
        # 12900 容量也不会更贵（50 部件上限）
        self.assertLessEqual(sk_roi.killer_body(12900)['cost'], killer['cost'])

    def test_account_for_a_close_sk_room(self):
        report = sk_roi.evaluate(5600, [62, 44, 25], downtime=0.25, loss_factor=1.2)
        self.assertTrue(report['viable'])
        self.assertEqual(report['miner']['work'], 7)
        gross = sum(min(14, 4000 / 300) * (1500 - d) / 1500 for d in [62, 44, 25])
        self.assertAlmostEqual(report['gross'], gross, places=3)
        self.assertAlmostEqual(report['delivered'], gross, places=3)   # 运力富余
        self.assertAlmostEqual(report['repair'], 3 * 0.5 + 62 * 0.001, places=4)
        self.assertAlmostEqual(report['upkeep']['killer'], report['killer']['cost'] / 1500 * 1.2, places=4)
        self.assertAlmostEqual(report['net'], report['delivered'] - report['totalUpkeep'], places=4)
        self.assertAlmostEqual(report['netAfterDowntime'], report['net'] * 0.75, places=4)
        self.assertGreater(report['net'], 20)
        self.assertAlmostEqual(report['netPerSpawn'], report['net'] / report['spawnShare'], places=4)
        first = report['sources'][0]
        self.assertEqual(first['requiredCarry'], math.ceil(4000 / 300 * (2 * 62 + 4) / 50))
        self.assertEqual(sum(h['carry'] for h in first['haulers']), 36)   # 32 + 补差的 4

    def test_not_viable_below_rcl7(self):
        report = sk_roi.evaluate(2300, [62, 44, 25])
        self.assertFalse(report['viable'])
        self.assertIsNone(report['killer'])


if __name__ == '__main__':
    unittest.main()
