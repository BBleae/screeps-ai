#!/usr/bin/env python3
import contextlib
import io
import json
import os
import tempfile
import time
import unittest
from unittest import mock

from scripts import monitor


def room_snapshot(progress_a, progress_b):
    return {
        'name': 'W33S7',
        'rcl': 2,
        'state': {'stableHarvesters': 1, 'recovering': False},
        'sources': [],
        'sites': [
            {'id': 'a', 'type': 'extension', 'progress': progress_a, 'total': 3000},
            {'id': 'b', 'type': 'container', 'progress': progress_b, 'total': 5000},
        ],
        'spawnUtil': {'total': 1, 'busy': 0, 'idle': 1},
        'energy': 0,
        'cap': 350,
        'prog': 100,
        'total': 2000,
        'defense': {
            'hostiles': 0,
            'armedHostiles': 0,
            'safeMode': 0,
            'safeModeAvailable': 1,
            'safeModeCooldown': 0,
        },
        'blueprint': {},
        'remotes': [],
    }


def healthy_creeps():
    return [
        {'role': 'harvester', 'home': 'W33S7', 'spawning': False, 'work': 2, 'carry': 1},
        {'role': 'hauler', 'home': 'W33S7', 'spawning': False, 'work': 0, 'carry': 2},
        {'role': 'upgrader', 'home': 'W33S7', 'spawning': False, 'work': 1, 'carry': 1},
    ]


def task_broker_room(backlog, acted, idle, assigned=0, skipped_cpu=0, deferred=0):
    return {
        'backlog': backlog,
        'acted': acted,
        'idle': idle,
        'deferred': deferred,
        'assigned': assigned,
        'skippedCpu': skipped_cpu,
    }


class AidSummaryTest(unittest.TestCase):
    def test_lists_aid_creeps_only(self):
        creeps = healthy_creeps() + [
            {'role': 'harvester', 'home': 'W34S7', 'aid': 'W33S7', 'room': 'W33S7', 'pos': '18,19', 'ttl': 1458, 'spawning': False},
            {'role': 'hauler', 'home': 'W34S7', 'aid': 'W33S7', 'room': 'W34S7', 'pos': '30,30', 'ttl': None, 'spawning': True},
        ]
        line = monitor.aid_summary(creeps)
        self.assertIn('W33S7→W34S7 harvester@W33S7 18,19 ttl1458', line)
        self.assertIn('hauler@W34S7 30,30 ttlspawning', line)
        self.assertEqual(monitor.aid_summary(healthy_creeps()), '')


class MonitorAnalysisTest(unittest.TestCase):
    def test_site_stall_excludes_explicit_economic_deferral(self):
        old = room_snapshot(100, 0)
        old['sites'] = [{'id': 'lab', 'type': 'lab', 'progress': 100, 'total': 50000, 'wanted': False}]
        current = room_snapshot(100, 0)
        current['sites'] = [dict(old['sites'][0])]
        previous = {'t': 1000, 'scriptV': 7, 'rooms': [old], 'creeps': healthy_creeps()}
        snapshot = {'t': 1400, 'scriptV': 7, 'rooms': [current], 'creeps': healthy_creeps()}
        def stalls():
            return [text for text in monitor.analyze_snapshot(snapshot, [{'mon': previous}])['issues'] if '工地停滞' in text]
        self.assertEqual(stalls(), [], 'deferred luxury construction must not be treated as a failed builder')
        current['sites'][0]['wanted'] = True
        self.assertEqual(stalls(), [], 'resuming construction needs a new active comparison window')
        old['sites'][0]['wanted'] = True
        self.assertTrue(stalls(), 'active construction that stops must still alert')
        current['sites'][0].pop('wanted')
        self.assertTrue(stalls(), 'unknown policy must not suppress a stall')
        snapshot['scriptV'] = 8
        self.assertEqual(stalls(), [], 'different source policies cannot share a stall window')

    def test_plan_error_alerts_and_missing_wheel_plan_alerts(self):
        room = room_snapshot(100, 0)
        room['plan'] = {'version': None, 'wheel': False, 'error': {'at': 900, 'message': 'wheel planner returned false', 'retryAt': 5900}}
        snapshot = {'t': 1000, 'rooms': [room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('轮子规划失败' in text and '5900' in text for text in issues), issues)
        room['plan'] = {'version': None, 'wheel': False, 'error': None}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('还没有轮子方案' in text for text in issues), issues)
        room['plan'] = {'version': 'wheel-layout-2.1.0', 'wheel': True, 'error': None}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertFalse(any('轮子' in text for text in issues), issues)

    def test_upgrade_cap_missing_only_alerts_with_competing_demand(self):
        room = room_snapshot(100, 0)
        room['plan'] = {'version': 'wheel-layout-2.1.0', 'wheel': True, 'error': None}
        room['upgrade'] = {'at': 1000, 'low': True, 'cap': None, 'work': 24, 'duty': 1}
        room['upgradeCompete'] = {'at': 500, 'why': 'spawn', 'free': {'at': 1000, 'n': 40}}
        snapshot = {'t': 1000, 'rooms': [room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertFalse(any('取能上限' in text for text in issues), issues)
        room['upgradeCompete'] = {'at': 950, 'why': 'backlog', 'free': None}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('取能上限' in text and 'backlog' in text for text in issues), issues)
        snapshot['t'] = 1020
        room['upgradeCompete'] = {'at': 1020, 'why': 'unfull', 'free': {'at': 1001, 'n': 40}}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertFalse(any('取能上限' in text for text in issues), issues)

    def test_layout_blocked_alerts_only_when_backlog_is_large(self):
        room = room_snapshot(100, 0)
        room['plan'] = {'version': 'wheel-layout-2.1.0', 'wheel': True, 'error': None}
        room['layoutBlocked'] = [{'x': 25, 'y': 24, 'type': 'storage', 'by': 'road'}]
        snapshot = {'t': 1000, 'rooms': [room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0}
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertFalse(any('占住' in text for text in issues), '少量冲突由拆迁调度处理，不告警')
        room['layoutBlocked'] = [{'x': 20 + i, 'y': 24, 'type': 'extension', 'by': 'road'} for i in range(8)]
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('8 处' in text for text in issues), issues)

    def test_brain_heartbeat_alerts(self):
        base = {'t': 1000, 'rooms': [], 'creeps': [], 'hostiles': 0, 'armedHostiles': 0,
                'errN': 0, 'cpu': 2, 'cpuLimit': 140, 'bucket': 5000}
        now_ms = time.time() * 1000
        self.assertEqual(monitor.analyze_snapshot(dict(base), [])['issues'], [])
        issues = monitor.analyze_snapshot(dict(base, brain=None), [])['issues']
        self.assertTrue(any('外脑指令缺失' in text for text in issues), issues)
        fresh = {'issuedAt': now_ms - 60 * 1000, 'ttlMs': 1800000, 'stale': False, 'ackTick': 10, 'rooms': 3}
        self.assertEqual(monitor.analyze_snapshot(dict(base, brain=fresh), [])['issues'], [])
        warn = dict(fresh, issuedAt=now_ms - (monitor.THRESHOLDS['brain_age_warn_min'] + 5) * 60 * 1000)
        issues = monitor.analyze_snapshot(dict(base, brain=warn), [])['issues']
        self.assertTrue(any('没写入' in text and '宽限' not in text for text in issues), issues)
        alert = dict(fresh, issuedAt=now_ms - (monitor.THRESHOLDS['brain_age_alert_min'] + 5) * 60 * 1000)
        issues = monitor.analyze_snapshot(dict(base, brain=alert), [])['issues']
        self.assertTrue(any('宽限' in text for text in issues), issues)
        issues = monitor.analyze_snapshot(dict(base, brain=dict(fresh, stale=True)), [])['issues']
        self.assertTrue(any('宽限内沿用' in text for text in issues), issues)

    def test_move_only_hostile_does_not_alert(self):
        snapshot = {
            't': 1000,
            'rooms': [],
            'creeps': [],
            'hostiles': 1,
            'armedHostiles': 0,
            'errN': 0,
            'cpu': 2,
            'cpuLimit': 140,
            'bucket': 5000,
        }
        self.assertEqual(monitor.analyze_snapshot(snapshot, [])['issues'], [])

    def test_safe_mode_activation_and_active_state_alert(self):
        room = room_snapshot(100, 0)
        room['defense']['safeMode'] = 400
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 0,
            'armedHostiles': 0,
        }
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('safe mode 已激活' in text for text in issues))

        previous = room_snapshot(100, 0)
        previous['defense']['safeMode'] = 600
        history = [{'mon': {'t': 800, 'rooms': [previous], 'creeps': healthy_creeps()}}]
        issues = monitor.analyze_snapshot(snapshot, history)['issues']
        self.assertTrue(any('safe mode 仍处于激活状态' in text for text in issues))

    def test_armed_hostile_with_no_safe_mode_available_alerts(self):
        room = room_snapshot(100, 0)
        room['defense'].update({'hostiles': 1, 'armedHostiles': 1, 'safeModeAvailable': 0})
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 1,
            'armedHostiles': 1,
        }
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('武装敌方 creep 入侵' in text for text in issues))
        self.assertTrue(any('武装入侵且 safe mode 已耗尽' in text for text in issues))

    def test_no_alert_when_safe_mode_unavailable_without_armed_hostile(self):
        room = room_snapshot(100, 0)
        room['defense']['safeModeAvailable'] = 0
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 0,
            'armedHostiles': 0,
        }
        self.assertEqual(monitor.analyze_snapshot(snapshot, [])['issues'], [])

    def test_armed_hostile_during_safe_mode_cooldown_alerts(self):
        room = room_snapshot(100, 0)
        room['defense'].update({'hostiles': 1, 'armedHostiles': 1, 'safeModeCooldown': 200})
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 1,
            'armedHostiles': 1,
        }
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        self.assertTrue(any('safe mode 冷却中' in text for text in issues))

    def test_site_queue_alerts_only_when_all_work_stalls(self):
        previous = room_snapshot(100, 0)
        history = [{'mon': {'t': 1000, 'rooms': [previous], 'creeps': healthy_creeps(), 'bucket': 5000}}]

        progressing = room_snapshot(200, 0)
        current_mon = {'t': 1200, 'rooms': [progressing], 'creeps': healthy_creeps()}
        self.assertEqual(monitor.analyze_room(current_mon, progressing, history)['siteStalls'], [])

        stalled = room_snapshot(100, 0)
        current_mon['rooms'] = [stalled]
        self.assertTrue(monitor.analyze_room(current_mon, stalled, history)['siteStalls'])

    def test_defender_losses_and_brain_orders_are_reported(self):
        previous_room = room_snapshot(100, 0)
        previous_room['defenseLog'] = {'spawned': 4, 'losses': 1}
        current_room = room_snapshot(100, 0)
        current_room['defenseLog'] = {'spawned': 5, 'losses': 2, 'lastLoss': {'room': 'W33S6', 'at': 990},
                                      'skipped': {'room': 'W32S7', 'reason': 'unwinnable', 'at': 980}}
        current_room['brainDefense'] = {'W33S6': {'action': 'fight', 'squad': {'count': 2}}, 'W32S7': {'action': 'avoid'}}
        previous_mon = {'t': 900, 'rooms': [previous_room], 'creeps': healthy_creeps()}
        current_mon = {'t': 1000, 'rooms': [current_room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0}
        entry = monitor.analyze_snapshot(current_mon, [{'mon': previous_mon}])
        self.assertTrue(any('defender 阵亡 +1（W33S6 @ tick 990）' in text for text in entry['issues']), entry['issues'])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('出兵: 出兵=5 阵亡=2 最近阵亡=W33S6@990 不出兵=W32S7(unwinnable)@980 指令=W32S7:avoid,W33S6:fight×2', buf.getvalue())
        quiet = monitor.analyze_snapshot(current_mon, [{'mon': {'t': 900, 'rooms': [current_room], 'creeps': healthy_creeps()}}])
        self.assertFalse(any('阵亡' in text for text in quiet['issues']), '阵亡数没变不报警')

    def test_task_broker_trend_is_reported_and_printed(self):
        previous_room = room_snapshot(100, 0)
        current_room = room_snapshot(100, 0)
        previous_mon = {
            't': 900,
            'rooms': [previous_room],
            'creeps': healthy_creeps(),
            'taskBroker': {'rooms': {'W33S7': task_broker_room(40, 10, 2, assigned=1, deferred=3)}},
        }
        current_mon = {
            't': 1000,
            'rooms': [current_room],
            'creeps': healthy_creeps(),
            'taskBroker': {'rooms': {'W33S7': task_broker_room(55, 6, 4, assigned=2, skipped_cpu=1, deferred=7)}},
        }
        entry = monitor.analyze_snapshot(current_mon, [{'mon': previous_mon}])
        broker = entry['analysis']['rooms'][0]['taskBroker']
        self.assertEqual(broker['backlog']['delta'], 15)
        self.assertEqual(broker['backlog']['trend'], 'up')
        self.assertEqual(broker['acted']['delta'], -4)
        self.assertEqual(broker['acted']['trend'], 'down')
        self.assertEqual(broker['idle']['delta'], 2)
        self.assertEqual(broker['idle']['trend'], 'up')
        self.assertEqual(broker['deferred']['delta'], 4)
        self.assertEqual(broker['deferred']['trend'], 'up')
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('broker backlog=55(↑15) acted=6(↓4) deferred=7(↑4) idle=4(↑2)', buf.getvalue())

    def test_dynamic_demand_is_reported_and_alerted(self):
        room = room_snapshot(100, 0)
        room['energy'] = room['cap'] = 550
        room['demand'] = {
            'targets': {'harvester': 2, 'hauler': 1, 'upgrader': 1, 'builder': 2},
            'planned': {'harvester': 2, 'hauler': 1, 'upgrader': 1, 'builder': 1},
            'builderBacklog': 5000,
            'harvesterWork': 8,
            'harvesterWorkTarget': 10,
            'harvesterWorkDeficit': 2,
            'harvesterStaticSources': 2,
        }
        creeps = healthy_creeps() + [
            {'role': 'builder', 'home': 'W33S7', 'spawning': False, 'work': 3, 'carry': 2},
        ]
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': creeps,
            'hostiles': 0,
            'armedHostiles': 0,
        }
        entry = monitor.analyze_snapshot(snapshot, [])
        analysis = entry['analysis']['rooms'][0]
        self.assertEqual(analysis['dynamicDeficits'], ['builder'])
        self.assertTrue(any('动态目标未满足' in text for text in entry['issues']))
        room['energy'] = 480
        waiting = monitor.analyze_snapshot(snapshot, [])
        self.assertFalse(any('动态目标未满足' in text for text in waiting['issues']),
                         '满容量身体需要等能量满，未满时不算 spawn 漏造')
        room['energy'] = 550
        self.assertEqual(analysis['harvesterWorkDeficit'], 2)
        self.assertTrue(any('采集 WORK 吞吐未达目标' in text for text in entry['issues']))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('builderBacklog=5000', buf.getvalue())

    def test_same_tick_spawn_actions_consume_idle_slots_for_alerts(self):
        room = room_snapshot(100, 0)
        room['energy'] = room['cap'] = 550
        room['demand'] = {'targets': {'harvester': 2, 'hauler': 2},
                          'harvesterWorkDeficit': 2}
        room['spawnQueue'] = {'at': 1000, 'spawned': ['remoteMaintain:haul']}
        snapshot = {'t': 1000, 'rooms': [room], 'creeps': [],
                    'hostiles': 0, 'armedHostiles': 0}
        def idle_alerts():
            return [x for x in monitor.analyze_snapshot(snapshot, [])['issues']
                    if 'spawn 空闲' in x]
        self.assertEqual(idle_alerts(), [], 'accepted intent already occupies the sole spawn')
        room['spawnQueue']['at'] = 999
        self.assertEqual(len(idle_alerts()), 3, 'old intents must not hide current deficits')
        room['spawnQueue']['at'] = 1000
        room['spawnUtil'] = {'total': 2, 'busy': 0, 'idle': 2}
        self.assertEqual(len(idle_alerts()), 3, 'a second genuinely idle spawn still alerts')
        room['spawnQueue']['spawned'].append('remoteMaintain:other')
        self.assertEqual(idle_alerts(), [])
        room['spawnQueue']['spawned'] = []
        self.assertEqual(len(idle_alerts()), 3)

    def test_small_repair_debt_deferral_needs_fresh_matching_evidence(self):
        room = room_snapshot(100, 0)
        room['state'].update({'builderTarget': 0, 'builderOutOfReach': 10, 'builderRepairDebt': 9300})
        room['outOfReachBelowFloor'] = {'at': 995, 'count': 10, 'debt': 9300}
        room['roads'] = {'minOnPlanRatio': 0.54}
        snapshot = {'t': 1000, 'rooms': [room], 'creeps': healthy_creeps()}
        def repair_alerts():
            return [x for x in monitor.analyze_snapshot(snapshot, [])['issues'] if '处待修但没有 builder' in x]
        self.assertEqual(repair_alerts(), [], 'small debt intentionally waits to avoid permanent builder cost')
        room['outOfReachBelowFloor']['at'] = 900
        self.assertTrue(repair_alerts(), 'stale decision must not hide new debt')
        room['outOfReachBelowFloor']['at'] = 995
        room['state']['builderRepairDebt'] = 13000
        self.assertTrue(repair_alerts(), 'changed debt invalidates old deferral')
        room['state']['builderRepairDebt'] = 9300
        room['roads']['minOnPlanRatio'] = 0.1
        self.assertTrue(repair_alerts(), 'critical roads always remain visible')
        room['roads']['minOnPlanRatio'] = 0.54
        room['state']['builderTarget'] = 1
        self.assertTrue(repair_alerts(), 'real requested builder gap remains visible')

    def test_source_work_fallback_alerts_without_demand(self):
        room = room_snapshot(100, 0)
        room['energy'] = room['cap'] = 550
        room['sources'] = [{
            'id': 'source-0',
            'idx': 0,
            'energy': 1200,
            'energyCapacity': 3000,
            'regenerationTicks': 300,
            'ticksToRegeneration': 1,
            'work': 3,
            'workTarget': 5,
        }]
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 0,
            'armedHostiles': 0,
        }
        entry = monitor.analyze_snapshot(snapshot, [])
        analysis = entry['analysis']['rooms'][0]
        self.assertEqual(analysis['harvesterWorkDeficit'], 2)
        self.assertEqual(analysis['harvesterWork']['target'], 5)
        self.assertTrue(any('采集 WORK 吞吐未达目标' in text for text in entry['issues']))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('w=3/5', buf.getvalue())

    def test_source_work_fallback_uses_center_source_capacity(self):
        room = room_snapshot(100, 0)
        room['sources'] = [{
            'id': 'center-source',
            'idx': 0,
            'energy': 4000,
            'energyCapacity': 4000,
            'ticksToRegeneration': 300,
            'work': 7,
        }]
        snapshot = {
            't': 1000,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 0,
            'armedHostiles': 0,
        }
        analysis = monitor.analyze_snapshot(snapshot, [])['analysis']['rooms'][0]
        self.assertEqual(analysis['harvesterWork']['target'], 7)
        self.assertEqual(analysis['harvesterWorkDeficit'], 0)

    def test_upkeep_is_printed_and_empty_controller_container_alerts(self):
        def snapshot(tick, ctrl_energy):
            room = room_snapshot(100, 0)
            room['sites'] = []
            room['rcl'] = 3
            room['energy'] = room['cap'] = 800
            room['upkeep'] = {
                'ctrlContainer': {'x': 33, 'y': 25, 'energy': ctrl_energy, 'free': 2000 - ctrl_energy},
                'towers': [{'energy': 990, 'capacity': 1000}],
                'ramparts': {'count': 2, 'minHits': 418101, 'target': 30000},
            }
            return {
                't': tick,
                'rooms': [room],
                'creeps': healthy_creeps() + [
                    {'role': 'upgrader', 'home': 'W33S7', 'spawning': False, 'work': 6, 'carry': 2},
                ],
                'hostiles': 0,
                'armedHostiles': 0,
            }

        history = [{'mon': snapshot(1000, 0)}]
        entry = monitor.analyze_snapshot(snapshot(1100, 0), history)
        analysis = entry['analysis']['rooms'][0]
        self.assertEqual(analysis['upkeep']['ctrlContainer']['energy'], 0)
        self.assertTrue(any('供能容器两次采样为空' in text for text in entry['issues']))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('维护: ctrl容器=0/2000 tower=990/1000 rampart=418101/30000', buf.getvalue())

        fed = monitor.analyze_snapshot(snapshot(1100, 600), history)
        self.assertFalse(any('供能容器两次采样为空' in text for text in fed['issues']))
        fresh = monitor.analyze_snapshot(snapshot(1100, 0), [{'mon': snapshot(1000, 900)}])
        self.assertFalse(any('供能容器两次采样为空' in text for text in fresh['issues']))

    def test_rate_regression_needs_a_long_enough_window(self):
        def snapshot(tick, prog):
            room = room_snapshot(100, 0)
            room['sites'] = []
            room['prog'] = prog
            return {'t': tick, 'rooms': [room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0}

        history = [{'mon': snapshot(1000, 1000)}, {'mon': snapshot(1300, 2800)}]
        short = monitor.analyze_snapshot(snapshot(1326, 2800), history)
        self.assertFalse(any('升级速率回退' in text for text in short['issues']),
                         '26 tick 的采样窗口内进度未变化不算速率回退')
        long = monitor.analyze_snapshot(snapshot(1500, 2800), history)
        self.assertTrue(any('升级速率回退' in text for text in long['issues']))

    def test_pixel_generation_explains_bucket_drop(self):
        def snapshot(tick, bucket, px):
            return {'t': tick, 'rooms': [], 'creeps': [], 'hostiles': 0, 'armedHostiles': 0,
                    'bucket': bucket, 'px': px, 'cpu': 6.0, 'cpuLimit': 140}

        history = [{'mon': snapshot(1000, 9800, 5)}]
        pixel = monitor.analyze_snapshot(snapshot(1100, 401, 6), history)
        self.assertFalse(any('bucket' in text for text in pixel['issues']),
                         '生成 pixel 消耗 10000 bucket 不是 CPU 问题')
        real = monitor.analyze_snapshot(snapshot(1100, 401, 5), history)
        self.assertTrue(any('bucket 偏低' in text for text in real['issues']))
        self.assertTrue(any('bucket 回退过快' in text for text in real['issues']))


    def test_hard_stop_increase_alerts_once(self):
        def snapshot(tick, hard):
            mon = {'t': tick, 'rooms': [], 'creeps': [], 'hostiles': 0, 'armedHostiles': 0,
                   'bucket': 5000, 'px': 1, 'cpu': 100.0, 'cpuLimit': 150}
            if hard is not False:
                mon['hardStop'] = hard
            return mon

        history = [{'mon': snapshot(1000, {'n': 2, 'at': 900, 'cut': 3})}]
        fresh = monitor.analyze_snapshot(snapshot(1100, {'n': 5, 'at': 1090, 'cut': 7}), history)
        self.assertTrue(any('硬停 +3' in text for text in fresh['issues']), fresh['issues'])
        same = monitor.analyze_snapshot(snapshot(1100, {'n': 2, 'at': 900, 'cut': 3}), history)
        self.assertFalse(any('硬停' in text for text in same['issues']))
        old = monitor.analyze_snapshot(snapshot(1100, {'n': 5, 'at': 1090, 'cut': 7}), [{'mon': snapshot(1000, False)}])
        self.assertFalse(any('硬停' in text for text in old['issues']))

    def test_upgrader_backoff_and_spawn_stall_alert(self):
        def snapshot(tick, stuck, stall):
            room = room_snapshot(0, 0)
            room['upgraderStuck'] = stuck
            room['spawnStall'] = stall
            return {'t': tick, 'rooms': [room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0,
                    'bucket': 10000, 'px': 1, 'cpu': 50.0, 'cpuLimit': 150}

        history = [{'mon': snapshot(1000, None, {'n': 1, 'spawn': 'S1', 'name': 'a', 'waited': 5})}]
        cur = monitor.analyze_snapshot(snapshot(1100, {'streak': 3, 'backoffUntil': 2500, 'backoffs': 1},
                                                {'n': 2, 'spawn': 'S1', 'name': 'b', 'waited': 6}), history)
        self.assertTrue(any('退避中' in text for text in cur['issues']), cur['issues'])
        self.assertTrue(any('已放开非口袋方向 +1' in text for text in cur['issues']), cur['issues'])
        self.assertFalse(any('放开口袋方向' in text for text in cur['issues']), cur['issues'])
        later = monitor.analyze_snapshot(snapshot(2600, {'streak': 3, 'backoffUntil': 2500, 'backoffs': 1},
                                                  {'n': 2, 'spawn': 'S1', 'name': 'b', 'waited': 6}), [{'mon': snapshot(2500, None, {'n': 2})}])
        self.assertFalse(any('退避中' in text or '非口袋方向' in text for text in later['issues']), later['issues'])

    def test_spawn_exit_vacate_trapped_and_born_pocket_alerts(self):
        def snapshot(tick, stall):
            room = room_snapshot(0, 0)
            room['spawnStall'] = stall
            return {'t': tick, 'rooms': [room], 'creeps': healthy_creeps(), 'hostiles': 0, 'armedHostiles': 0,
                    'bucket': 10000, 'px': 1, 'cpu': 50.0, 'cpuLimit': 150}

        prev = {'n': 0, 'vacate': {'n': 4}, 'trapped': {'n': 1, 'recycled': 1}}
        cur = {'n': 0, 'vacate': {'n': 9}, 'trapped': {'n': 2, 'name': 'm', 'x': 26, 'y': 33, 'recycled': 2},
               'cannotVacate': {'n': 1, 'spawn': 'Spawn21', 'blockers': ['p']},
               'born': {'name': 'b', 'x': 26, 'y': 33}, 'bornPocket': 1}
        entry = monitor.analyze_snapshot(snapshot(1100, cur), [{'mon': snapshot(1000, prev)}])
        texts = entry['issues']
        self.assertTrue(any('口袋里困着的 creep 回收 +1' in t for t in texts), texts)
        self.assertTrue(any('无法让路 +1' in t for t in texts), texts)
        self.assertTrue(any('孵进了出生口袋 +1' in t for t in texts), texts)
        self.assertFalse(any('非口袋方向' in t for t in texts), texts)
        quiet = monitor.analyze_snapshot(snapshot(1200, cur), [{'mon': snapshot(1100, cur)}])
        self.assertFalse(any('口袋' in t or '让路' in t for t in quiet['issues']), quiet['issues'])


class UpgradeHoldFloorTest(unittest.TestCase):
    def test_upgrader_floor_respects_upgrade_hold(self):
        base = {'rcl': 7, 'state': {'stableHarvesters': 2, 'recovering': False}, 'sources': [{}, {}]}
        self.assertEqual(monitor.critical_floors(base)['upgrader'], 1)
        held = dict(base, upgradeHold={'on': True, 'guard': False})
        self.assertEqual(monitor.critical_floors(held)['upgrader'], 0)
        guarded = dict(base, upgradeHold={'on': True, 'guard': True})
        self.assertEqual(monitor.critical_floors(guarded)['upgrader'], 1)
        released = dict(base, upgradeHold={'on': False, 'guard': False})
        self.assertEqual(monitor.critical_floors(released)['upgrader'], 1)



class BootstrapRoomTest(unittest.TestCase):
    def test_room_without_spawn_is_reported_as_bootstrapping_not_collapsed(self):
        room = room_snapshot(0, 0)
        room.update({'name': 'W34S7', 'rcl': 1, 'energy': 0, 'cap': 0, 'prog': 0, 'total': 200,
                     'spawnUtil': {'total': 0, 'busy': 0, 'idle': 0},
                     'sites': [{'id': 's', 'type': 'spawn', 'progress': 1200, 'total': 15000}],
                     'state': {'stableHarvesters': 2, 'recovering': True}})
        mon = {'t': 1000, 'rooms': [room], 'creeps': [
            {'role': 'pioneer', 'home': 'W33S7', 'spawning': False, 'work': 4, 'carry': 4, 'room': 'W34S7'},
        ]}
        entry = monitor.analyze_snapshot(mon, [])
        texts = [i['text'] if isinstance(i, dict) else str(i) for i in entry.get('issues', [])]
        self.assertFalse(any('零 harvester' in t or '关键角色低于 floor' in t or '恢复风险' in t for t in texts), texts)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('开荒中', buf.getvalue())
        self.assertIn('1200/15000', buf.getvalue())


class RemoteStaffingTest(unittest.TestCase):
    @staticmethod
    def remote(room, want, have, reservation=540, enabled=True, reason=None, suspended_until=0):
        return {
            'room': room,
            'enabled': enabled,
            'suspendedUntil': suspended_until,
            'suspendReason': reason,
            'sourceCount': 2,
            'containers': 2,
            'want': want,
            'have': have,
            'missing': [],
            'demandKnown': True,
            'reservation': {'username': 'me', 'ticksToEnd': reservation, 'seenAt': 1},
        }

    def snapshot(self, tick, short=True):
        room = room_snapshot(100, 0)
        room['sites'] = []
        room['rcl'] = 5
        room['energy'] = room['cap'] = 1600
        room['remotes'] = [
            self.remote('W33S6', {'remoteMiner': 2, 'reserver': 1, 'remoteHauler': 3},
                        {'remoteMiner': 2, 'reserver': 1, 'remoteHauler': 3}),
            self.remote('W32S8', {'remoteMiner': 2, 'reserver': 1, 'remoteHauler': 2},
                        {'remoteMiner': 1 if short else 2, 'reserver': 0 if short else 1, 'remoteHauler': 2}, reservation=0),
            self.remote('W34S8', {}, {}, enabled=False, reason='tooFar', suspended_until=2 ** 53 - 1),
            self.remote('W31S6', {'remoteMiner': 1, 'reserver': 0, 'remoteHauler': 1},
                        {'remoteMiner': 0, 'reserver': 0, 'remoteHauler': 1}, reason='invader', suspended_until=tick + 200),
        ]
        return {
            't': tick,
            'rooms': [room],
            'creeps': healthy_creeps(),
            'hostiles': 0,
            'armedHostiles': 0,
        }

    def test_remote_line_marks_shortfall_and_alerts_only_when_persistent(self):
        history = [{'mon': self.snapshot(1000)}]
        entry = monitor.analyze_snapshot(self.snapshot(1500), history)
        analysis = entry['analysis']['rooms'][0]
        self.assertEqual([r['room'] for r in analysis['remotes'] if r['active']], ['W33S6', 'W32S8'])
        self.assertEqual(analysis['remotes'][1]['short'], ['remoteMiner', 'reserver'])
        self.assertTrue(any('外矿 W32S8 两次采样缺编（相隔 500 ticks）: remoteMiner 1/2, reserver 0/1' in text for text in entry['issues']))
        self.assertFalse(any('W31S6' in text for text in entry['issues']))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        out = buf.getvalue()
        self.assertIn('远程 2/4', out)
        self.assertIn('外矿: W33S6 m2/2 r1/1 h3/3 预定540 | W32S8 m1/2! r0/1! h2/2 预定0 | W34S8 停用(tooFar) | W31S6 暂停(invader)', out)

        fresh = monitor.analyze_snapshot(self.snapshot(1500), [{'mon': self.snapshot(1000, short=False)}])
        self.assertFalse(any('持续缺编' in text for text in fresh['issues']))
        recent = monitor.analyze_snapshot(self.snapshot(1100), history)
        self.assertFalse(any('持续缺编' in text for text in recent['issues']))
        staffed = monitor.analyze_snapshot(self.snapshot(1500, short=False), history)
        self.assertFalse(any('持续缺编' in text for text in staffed['issues']))
        self.assertEqual(staffed['analysis']['rooms'][0]['remotes'][1]['short'], [])


class CpuAlertTest(unittest.TestCase):

    def _snapshot(self, cpu, bucket, tick_limit=500):
        return {'t': 1000, 'rooms': [], 'creeps': [], 'hostiles': 0, 'armedHostiles': 0, 'errN': 0,
                'cpu': cpu, 'cpuLimit': 140, 'tickLimit': tick_limit, 'bucket': bucket, 'px': 3}

    def _issues(self, cpu, bucket, **kwargs):
        return [i for i in monitor.analyze_snapshot(self._snapshot(cpu, bucket, **kwargs), [])['issues'] if 'CPU 用量' in i]

    def test_spike_funded_by_a_healthy_bucket_is_not_an_alert(self):
        self.assertEqual(self._issues(176.6, 9000), [])
        self.assertEqual(self._issues(165.0, 6068), [])

    def test_high_cpu_with_a_drained_bucket_alerts(self):
        issues = self._issues(176.6, 800)
        self.assertTrue(issues and '176.6/140' in issues[0], issues)

    def test_near_tick_limit_alerts_even_with_a_full_bucket(self):
        issues = self._issues(480.0, 9800)
        self.assertTrue(issues and '480.0' in issues[0], issues)

    def test_normal_usage_is_quiet(self):
        self.assertEqual(self._issues(94.6, 2894), [])
        self.assertEqual(self._issues(94.6, 500), [])


class AlertNoiseTest(unittest.TestCase):

    def _room(self, tick, ctrl_energy, ctrl_feed=None, prog=None):
        room = room_snapshot(100, 0)
        room['sites'] = []
        room['rcl'] = 5
        room['energy'] = room['cap'] = 1800
        if prog is not None:
            room['prog'] = prog
        upkeep = {
            'ctrlContainer': {'x': 33, 'y': 25, 'energy': ctrl_energy, 'free': 2000 - ctrl_energy},
            'towers': [{'energy': 990, 'capacity': 1000}],
            'ramparts': {'count': 2, 'minHits': 418101, 'target': 30000},
        }
        if ctrl_feed:
            upkeep['ctrlFeed'] = ctrl_feed
        room['upkeep'] = upkeep
        return {
            't': tick,
            'rooms': [room],
            'creeps': healthy_creeps() + [{'role': 'upgrader', 'home': 'W33S7', 'spawning': False, 'work': 6, 'carry': 2}],
            'hostiles': 0,
            'armedHostiles': 0,
        }

    def test_storage_fed_room_does_not_alert_on_empty_controller_container(self):
        history = [{'mon': self._room(1000, 0, 'storage')}]
        entry = monitor.analyze_snapshot(self._room(1400, 0, 'storage'), history)
        self.assertFalse(any('供能容器两次采样为空' in text for text in entry['issues']),
                         'storage 供能的房里 hauler 本来就不喂控制器容器（task_broker.controllerFeedContainer 返回 null）')
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            monitor.print_summary(entry)
        self.assertIn('ctrl容器=0/2000(供能=storage)', buf.getvalue())
        legacy = monitor.analyze_snapshot(self._room(1400, 0), [{'mon': self._room(1000, 0)}])
        self.assertTrue(any('供能容器两次采样为空' in text for text in legacy['issues']))

    def test_empty_samples_do_not_claim_continuous_starvation(self):
        history = [{'mon': self._room(1000, 0, prog=1000)}]
        entry = monitor.analyze_snapshot(self._room(1400, 0, prog=5000), history)
        alerts = [text for text in entry['issues'] if '供能容器' in text]
        self.assertEqual(len(alerts), 1)
        self.assertIn('两次采样为空（相隔 400 ticks', alerts[0])
        self.assertNotIn('持续为空', alerts[0])
        self.assertEqual(entry['analysis']['rooms'][0]['rate'], 10)

    def test_armed_hostile_alert_names_the_rooms(self):
        snapshot = {
            't': 1000, 'rooms': [], 'creeps': [], 'hostiles': 4, 'armedHostiles': 4,
            'hostileRooms': {'W33S6': 3, 'W34S5': 1},
            'errN': 0, 'cpu': 2, 'cpuLimit': 140, 'bucket': 5000,
        }
        issues = monitor.analyze_snapshot(snapshot, [])['issues']
        armed = [text for text in issues if '武装敌方' in text]
        self.assertEqual(len(armed), 1)
        self.assertIn('W33S6×3', armed[0])
        self.assertIn('W34S5×1', armed[0])

    def test_rate_regression_baseline_ignores_a_single_spike(self):
        history = []
        prog = 0
        rates = [7, 7, 7, 7, 30, 7]
        history.append({'mon': self._room(1000, 500, None, prog)})
        tick = 1000
        for rate in rates:
            tick += 100
            prog += rate * 100
            history.append({'mon': self._room(tick, 500, None, prog)})
        entry = monitor.analyze_snapshot(self._room(tick + 100, 500, None, prog + 700), history)
        self.assertFalse(any('升级速率回退' in text for text in entry['issues']),
                         '基线应取最近几轮的中位数，单次尖峰不算基线')
        dropped = monitor.analyze_snapshot(self._room(tick + 100, 500, None, prog + 300), history)
        self.assertTrue(any('升级速率回退' in text for text in dropped['issues']), '3/tick < 7/tick 的 80% 仍要报')

    def test_rate_regression_skips_rooms_capped_on_purpose(self):
        history = []
        prog = 0
        history.append({'mon': self._room(1000, 500, None, prog)})
        tick = 1000
        for _ in range(6):
            tick += 100
            prog += 20 * 100
            history.append({'mon': self._room(tick, 500, None, prog)})
        capped = self._room(tick + 100, 500, None, prog + 1200)
        capped['rooms'][0]['upgrade'] = {'cap': 12, 'work': 12}
        entry = monitor.analyze_snapshot(capped, history)
        self.assertFalse(any('升级速率回退' in text for text in entry['issues']), '有意封顶的房按封顶判断')
        low = self._room(tick + 100, 500, None, prog + 500)
        low['rooms'][0]['upgrade'] = {'cap': 12, 'work': 12}
        dropped = monitor.analyze_snapshot(low, history)
        self.assertTrue(any('升级速率回退' in text for text in dropped['issues']), '5/tick < 封顶 12 的 80% 仍要报')

    def test_rate_regression_skips_rooms_on_upgrade_hold(self):
        history = []
        prog = 0
        history.append({'mon': self._room(1000, 500, None, prog)})
        tick = 1000
        for _ in range(6):
            tick += 100
            prog += 10 * 100
            history.append({'mon': self._room(tick, 500, None, prog)})
        held = self._room(tick + 100, 500, None, prog + 300)
        held['rooms'][0]['upgradeHold'] = {'on': True, 'guard': False}
        entry = monitor.analyze_snapshot(held, history)
        self.assertFalse(any('升级速率回退' in text for text in entry['issues']), 'upgradeHold 停升级时不报回退')
        guarded = self._room(tick + 100, 500, None, prog + 300)
        guarded['rooms'][0]['upgradeHold'] = {'on': True, 'guard': True}
        dropped = monitor.analyze_snapshot(guarded, history)
        self.assertTrue(any('升级速率回退' in text for text in dropped['issues']), '进了 guard 仍要报')


class StatusLogTrimTest(unittest.TestCase):
    def _write(self, count, size, max_bytes, keep):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, 'logs', 'status.jsonl')
            with mock.patch.object(monitor, 'LOG', log), \
                    mock.patch.object(monitor, 'LOG_MAX_BYTES', max_bytes), \
                    mock.patch.object(monitor, 'LOG_KEEP_ENTRIES', keep):
                for i in range(count):
                    monitor.write_entry({'i': i, 'pad': 'x' * size})
            with open(log) as f:
                return [json.loads(line)['i'] for line in f]

    def test_trims_by_bytes_not_only_by_entry_count(self):
        kept = self._write(10, 1300, 4096, 1000)
        self.assertEqual(kept, [7, 8, 9], '字节预算内只留最新的几条，且顺序不变')

    def test_entry_cap_still_applies_under_the_byte_budget(self):
        kept = self._write(10, 1300, 4096, 2)
        self.assertEqual(kept, [8, 9])

    def test_newest_entry_is_kept_even_if_it_alone_exceeds_the_budget(self):
        kept = self._write(3, 5000, 4096, 1000)
        self.assertEqual(kept, [2], '单条超预算也不能把日志清空')


class ExitCodeTest(unittest.TestCase):

    def mon(self, t, energy=50):
        room = room_snapshot(0, 0)
        room.update({'rcl': 4, 'prog': 1000 + t * 5, 'storage': 2000, 'sites': [],
                     'spawnUtil': {'total': 1, 'busy': 1, 'idle': 0}})
        creeps = healthy_creeps()
        creeps[2].update(room='W33S7', ctrlRange=1, energy=energy, work=5)
        return {'schema': 4, 't': t, 'scriptV': 1, 'username': 'me', 'rooms': [room], 'creeps': creeps,
                'cpu': 50, 'cpuLimit': 150, 'bucket': 9000, 'roles': {}, 'errN': 0}

    def run_main(self, tmp, mons, argv=()):
        snapshots = iter(mons)

        def snap():
            item = next(snapshots)
            if isinstance(item, Exception):
                raise item
            return item
        with mock.patch.object(monitor, 'ROOT', tmp), \
                mock.patch.object(monitor, 'LOG', os.path.join(tmp, 'logs', 'status.jsonl')), \
                mock.patch.object(monitor, 'snapshot', snap), \
                mock.patch('sys.argv', ['monitor.py', '--interval', '0', *argv]), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return monitor.main()

    def test_exit_codes_follow_sample_alerts_not_open_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_main(tmp, [self.mon(1000, energy=0)]), 1)
            self.assertEqual(self.run_main(tmp, [self.mon(1010, energy=0)]), 0)
            with open(os.path.join(tmp, 'logs', 'monitor-incidents.json')) as f:
                self.assertGreater(json.load(f)['summary']['open'], 0)
            self.assertEqual(self.run_main(tmp, [self.mon(1020, energy=0)]), 1)
            self.assertEqual(self.run_main(tmp, [self.mon(1030, energy=0)]), 0)
            self.assertEqual(self.run_main(tmp, [RuntimeError('timeout')]), 2)
            self.assertEqual(self.run_main(tmp, [self.mon(1040, energy=0), self.mon(1050, energy=0)],
                                           ['--samples', '2']), 0)
            drained = self.mon(1070, energy=0); drained['bucket'] = 500
            self.assertEqual(self.run_main(tmp, [self.mon(1060, energy=0), drained], ['--samples', '2']), 1)


    def test_cron_run_does_not_spend_alerts_meant_for_heartbeat(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_main(tmp, [self.mon(1000, energy=0)], ['--no-ack']), 1)
            self.assertEqual(self.run_main(tmp, [self.mon(1010, energy=0)], ['--no-ack']), 1)
            with open(os.path.join(tmp, 'logs', 'monitor-incidents.json')) as f:
                state = json.load(f)
            self.assertEqual(len(state['pendingAlerts']), 1, '同一事件同一原因只留一条')
            self.assertEqual(state['pendingAlerts'][0]['firstTick'], 1000)
            self.assertEqual(state['pendingAlerts'][0]['reason'], 'new')
            self.assertEqual(self.run_main(tmp, [self.mon(1015, energy=0)], ['--samples', '1']), 1)
            self.assertEqual(self.run_main(tmp, [self.mon(1016, energy=0)]), 0)
            with open(os.path.join(tmp, 'logs', 'monitor-incidents.json')) as f:
                state = json.load(f)
            self.assertEqual(state['pendingAlerts'], [])
            self.assertEqual(state['lastAck']['alerts'], 2)

    def test_failed_sample_keeps_earlier_alerts_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_main(tmp, [self.mon(1000, energy=0), RuntimeError('timeout')],
                                           ['--samples', '2']), 2)
            self.assertEqual(self.run_main(tmp, [self.mon(1010, energy=0)]), 1)
            with open(os.path.join(tmp, 'logs', 'monitor-incidents.json')) as f:
                state = json.load(f)
            self.assertEqual(state['lastSample']['alerts'], [])
            self.assertEqual(state['pendingAlerts'], [])
            self.assertEqual(state['lastAck']['alerts'], 1)


class DeployVersionTest(unittest.TestCase):
    def mon(self, version):
        return {'t': 1000, 'scriptV': version, 'rooms': [], 'creeps': []}

    def test_version_change_is_surfaced_with_build_time(self):
        entry = monitor.analyze_snapshot(self.mon(1790987175590), [{'mon': self.mon(1790869387821)}])
        deploy = entry['deploy']
        self.assertTrue(deploy['changed']); self.assertFalse(deploy['regressed'])
        self.assertEqual(deploy['builtAt'], time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(1790987175.590)))
        self.assertFalse(any('版本' in text for text in entry['issues']), '正常升级不是异常')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            monitor.print_summary(entry)
        self.assertIn('1790869387821 → 1790987175590', out.getvalue())

    def test_same_version_is_quiet_and_regression_alerts(self):
        same = monitor.analyze_snapshot(self.mon(5_000_000_000_000), [{'mon': self.mon(5_000_000_000_000)}])
        self.assertFalse(same['deploy']['changed'])
        back = monitor.analyze_snapshot(self.mon(1790869387821), [{'mon': self.mon(1790987175590)}])
        self.assertTrue(back['deploy']['regressed'])
        self.assertTrue(any('比上一样本旧' in text for text in back['issues']))
        missing = monitor.analyze_snapshot(self.mon(None), [{'mon': self.mon(1790987175590)}])
        self.assertTrue(any('SCRIPT_VERSION 缺失' in text for text in missing['issues']))


if __name__ == '__main__':
    unittest.main()
