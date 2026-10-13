#!/usr/bin/env python3
import contextlib
import io
import unittest

from scripts.report import remote_roi


def fixture():
    return {
        't': 1000,
        'homes': [{
            'name': 'W33S7', 'rcl': 5, 'cap': 1600,
            'reserver': {'cost': 1300, 'parts': 4, 'work': 0, 'carry': 0, 'claim': 2},
            'remotes': [
                {
                    'room': 'W32S7', 'enabled': True, 'suspendedUntil': 0, 'suspendReason': None, 'reservation': 500,
                    'controllerDistance': 40,
                    'sources': [{'id': 's1', 'distance': 46, 'energyCapacity': 3000, 'container': True, 'roadTiles': 10, 'roadComplete': True}],
                    # 预定够久，remote.js 此刻不出 reserver 需求：稳态账要按母房容量补一只
                    'demands': [
                        {'role': 'remoteMiner', 'slot': 'remoteMiner:W32S7:s1', 'sourceId': 's1', 'cost': 700, 'parts': 9, 'work': 5, 'carry': 1, 'claim': 0},
                        {'role': 'remoteHauler', 'slot': 'remoteHauler:W32S7:s1:0', 'sourceId': 's1', 'cost': 1000, 'parts': 20, 'work': 1, 'carry': 12, 'claim': 0},
                    ],
                    'alive': [
                        {'role': 'remoteMiner', 'sourceId': 's1', 'cost': 700, 'parts': 9, 'work': 5, 'carry': 1, 'claim': 0, 'ttl': 900},
                        # 缩身 hauler：1 CARRY 跑 96 tick 一趟
                        {'role': 'remoteHauler', 'sourceId': 's1', 'cost': 200, 'parts': 3, 'work': 1, 'carry': 1, 'claim': 0, 'ttl': 1200},
                    ],
                },
                {'room': 'W36S7', 'enabled': False, 'suspendedUntil': 2 ** 53, 'suspendReason': 'tooFar', 'reservation': 0,
                 'controllerDistance': None, 'sources': [], 'demands': [], 'alive': []},
                {'room': 'W31S6', 'enabled': True, 'suspendedUntil': 0, 'suspendReason': None, 'reservation': 0,
                 'controllerDistance': None, 'sources': [], 'demands': None, 'alive': []},
            ],
        }],
    }


class RemoteRoiTest(unittest.TestCase):
    def test_haul_capacity_uses_drop_room_distance(self):
        """运输工往路程最短的己方房卸货：运力按卸货房距离算，矿工在岗率仍按源距离"""
        roster = [{'role': 'remoteMiner', 'sourceId': 's1', 'work': 5, 'cost': 550, 'parts': 6},
                  {'role': 'remoteHauler', 'sourceId': 's1', 'carry': 10, 'cost': 750, 'parts': 15}]
        remote = {'sources': [{'id': 's1', 'distance': 60, 'energyCapacity': 3000, 'container': True, 'roadTiles': 0}]}
        far = remote_roi.evaluate_roster(remote, roster, reserved=True)
        near = remote_roi.evaluate_roster(dict(remote, dropRoom='W33S8', dropDistance=30), roster, reserved=True)
        self.assertAlmostEqual(far['capacity'], 10 * 50 / (2 * 60 + 4))
        self.assertAlmostEqual(near['capacity'], 10 * 50 / (2 * 30 + 4), msg='运力按卸货房距离 30 算')
        self.assertAlmostEqual(near['gross'], far['gross'], msg='矿工在岗率仍按源距离')
        self.assertGreater(near['delivered'], far['delivered'])

    def test_plan_actual_and_no_reserve_accounts(self):
        report = remote_roi.evaluate(fixture())
        home = report['homes'][0]
        remote = home['remotes'][0]
        plan = remote['plan']
        uptime = (1500 - 46) / 1500
        self.assertAlmostEqual(plan['gross'], 10 * uptime, places=3)
        self.assertAlmostEqual(plan['capacity'], 12 * 50 / 96, places=3)
        self.assertAlmostEqual(plan['delivered'], 6.25, places=3)
        self.assertAlmostEqual(plan['cost']['remoteMiner'], 700 / 1500, places=4)
        self.assertAlmostEqual(plan['cost']['remoteHauler'], 1000 / 1500, places=4)
        self.assertAlmostEqual(plan['cost']['reserver'], 1300 / 600, places=4)   # 稳态补上的 reserver
        self.assertAlmostEqual(plan['repair'], 0.1 + 10 * 0.001, places=4)
        self.assertAlmostEqual(plan['net'], 6.25 - (700 / 1500 + 1000 / 1500 + 1300 / 600 + 0.11), places=3)
        self.assertAlmostEqual(plan['payback'], (5000 + 3000) / plan['net'], places=2)
        self.assertAlmostEqual(plan['spawnShare'], (9 * 3 + 20 * 3) / 1500 + 4 * 3 / 600, places=4)

        no_reserve = remote['noReserve']
        self.assertAlmostEqual(no_reserve['delivered'], 5 * uptime, places=3)
        self.assertAlmostEqual(no_reserve['cost']['reserver'], 0.0, places=4)
        self.assertAlmostEqual(no_reserve['cost']['remoteHauler'], 500 / 1500, places=4)
        self.assertAlmostEqual(no_reserve['repair'], 0.5 + 0.01, places=4)

        actual = remote['actual']
        self.assertAlmostEqual(actual['capacity'], 50 / 96, places=4)
        self.assertAlmostEqual(actual['net'], 50 / 96 - (900 / 1500 + 0.11), places=3)
        self.assertLess(actual['net'], 0)

        self.assertFalse(home['remotes'][1]['active'])
        self.assertIsNone(home['remotes'][1]['plan'])
        self.assertTrue(home['remotes'][2]['active'])
        self.assertIsNone(home['remotes'][2]['plan'])
        self.assertAlmostEqual(home['planNet'], plan['net'], places=4)
        self.assertAlmostEqual(home['planNetPerSpawn'], plan['net'] / plan['spawnShare'], places=3)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            remote_roi.print_report(report)
        out = buf.getvalue()
        self.assertIn('W32S7  源1 容器1 距46 预定500  毛产 9.7 运力 6.2 到家 6.2', out)
        self.assertIn('W36S7  源0 容器0 距 预定0  停用(tooFar)', out)
        self.assertIn('W31S6  源0 容器0 距 预定0  需求未知', out)


if __name__ == '__main__':
    unittest.main()
