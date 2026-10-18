import copy
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch
from scripts import monitor_health as health
from scripts import monitor


def sample(t=1000, version=1):
    return {'schema': 4, 't': t, 'scriptV': version, 'username': 'me', 'creeps': [
        {'id': 'up', 'home': 'W1N1', 'room': 'W1N1', 'role': 'upgrader', 'work': 5, 'energy': 50, 'ctrlRange': 1}],
        'rooms': [{'name': 'W1N1', 'rcl': 4, 'prog': 1000 + t * 5, 'storage': 2000,
                   'sources': [], 'sites': [], 'economy': {}, 'remotes': [{
                       'room': 'W1N2', 'enabled': True, 'visible': True,
                       'controllerDistance': 150, 'controllerDistanceVersion': 3,
                       'drop': {'distanceVersion': 3},
                       'reservation': {'username': 'me', 'ticksToEnd': 2000, 'seenAt': t},
                       'drops': [], 'routes': [{'id': 's1', 'distance': 150, 'version': 3,
                                                'incomplete': False, 'roadComplete': False,
                                                'roadTiles': 0, 'containerFree': 100}]}]}]}


def rules(mon, old=None):
    return {f['rule'] for f in health.assess(mon, [{'mon': old}] if old else [])['findings']}


class OutcomeTest(unittest.TestCase):
    def test_repeated_relief_at_empty_workers_position_adds_actionable_hint(self):
        old = sample(900); mon = sample()
        for entry in (old, mon):
            entry['creeps'][0].update(energy=0, pos='11,42')
            entry['rooms'][0]['prog'] = 123
            entry['rooms'][0]['linkRelief'] = {'at': entry['t'], 'n': entry['t'], 'x': 11, 'y': 42}
        def finding():
            return next(x for x in health.assess(mon, [{'mon': old}])['findings']
                        if x['rule'] == 'supply-mismatch')
        hinted = finding()
        self.assertIn('原地迁移', hinted['action'])
        self.assertEqual((hinted['key'], hinted['severity']), ('W1N1:supply-mismatch', 'investigate'))
        for field, value in [('id', 'replacement'), ('pos', '12,42')]:
            with self.subTest(field=field):
                previous = mon['creeps'][0][field]
                mon['creeps'][0][field] = value
                self.assertNotIn('原地迁移', finding()['action'])
                mon['creeps'][0][field] = previous
        for relief in [None, {'at': 994, 'n': 1000, 'x': 11, 'y': 42},
                       {'at': 1000, 'n': 900, 'x': 11, 'y': 42},
                       {'at': 1001, 'n': 1000, 'x': 11, 'y': 42},
                       {'at': 1000, 'n': 1000, 'x': 12, 'y': 42}]:
            with self.subTest(relief=relief):
                mon['rooms'][0]['linkRelief'] = relief
                self.assertNotIn('原地迁移', finding()['action'])

    def test_walking_successor_is_not_station_supply_demand(self):
        old = sample(900); mon = sample()
        mon['creeps'][0].update(work=21, energy=58)
        mon['creeps'].append(dict(mon['creeps'][0], id='successor', ctrlRange=14, energy=0))
        result = health.assess(mon, [{'mon': old}])
        self.assertIn('W1N1:supply-mismatch', result['checked'])
        self.assertNotIn('supply-mismatch', rules(mon, old))
        mon['creeps'][0]['energy'] = 0
        self.assertIn('supply-mismatch', rules(mon, old))

    def test_missing_ranges_or_empty_station_do_not_prove_supply_recovery(self):
        for distance in [None, True, -1, 50, 14]:
            with self.subTest(distance=distance):
                mon = sample(); mon['creeps'][0].update(ctrlRange=distance, energy=0)
                result = health.assess(mon, [{'mon': sample(900)}])
                self.assertNotIn('W1N1:supply-mismatch', result['checked'])
                mon['rooms'][0]['prog'] = sample(900)['rooms'][0]['prog']
                self.assertIn('development-stalled', rules(mon, sample(900)))

    def test_unknown_upgrader_route_is_actionable_despite_current_upgrade_progress(self):
        mon = sample()
        mon['rooms'][0]['upgraderLeg'] = {'at': mon['t'], 'complete': False, 'ticks': None}
        self.assertIn('upgrader-route', rules(mon, sample(900)))
        mon['rooms'][0]['upgraderLeg'].update(complete=True, ticks=488)
        result = health.assess(mon, [])
        self.assertIn('W1N1:upgrader-route', result['checked'])
        self.assertNotIn('upgrader-route', rules(mon))

    def test_absent_stale_or_invalid_route_does_not_prove_recovery(self):
        for leg in [None, {'at': 699, 'complete': True, 'ticks': 488},
                    {'at': 1001, 'complete': True, 'ticks': 488},
                    {'at': 1000, 'ticks': 488}]:
            with self.subTest(leg=leg):
                mon = sample()
                mon['rooms'][0]['upgraderLeg'] = leg
                self.assertNotIn('W1N1:upgrader-route', health.assess(mon, [])['checked'])

    def test_complete_route_requires_numeric_nonnegative_travel(self):
        for ticks in [None, -1, True]:
            with self.subTest(ticks=ticks):
                mon = sample()
                mon['rooms'][0]['upgraderLeg'] = {'at': mon['t'], 'complete': True, 'ticks': ticks}
                self.assertIn('upgrader-route', rules(mon))

    def test_known_roots_replay_and_controls(self):
        mon = sample(); self.assertEqual(rules(mon), {'economy-coverage'})
        mon['creeps'][0]['energy'] = 0
        self.assertIn('supply-mismatch', rules(mon))
        mon['rooms'][0]['storage'] = 0
        self.assertNotIn('supply-mismatch', rules(mon))
        remote = mon['rooms'][0]['remotes'][0]
        remote['routes'][0]['incomplete'] = True
        self.assertIn('route', rules(mon))
        remote['routes'][0].update(incomplete=False, version=2)
        self.assertIn('route', rules(mon))
        remote['routes'][0].update(version=3, roadComplete=True)
        self.assertIn('road-complete', rules(mon))
        remote['drop']['distanceVersion'] = 2
        self.assertIn('drop-route', rules(mon))
        mon['rooms'][0]['economy']['remoteRoadBudget'] = {'maxTripSpent': 51}
        self.assertIn('road-budget', rules(mon))

    def test_reserver_present_but_not_arrived_is_not_coverage(self):
        mon = sample(); remote = mon['rooms'][0]['remotes'][0]
        remote['reservation']['ticksToEnd'] = 100
        mon['creeps'].append({'home': 'W1N1', 'role': 'reserver', 'room': 'W1N2',
                              'remoteRoom': 'W1N2', 'ctrlRange': 20, 'claim': 1, 'ttl': 400})
        self.assertIn('reserve-handoff', rules(mon))
        mon['creeps'][-1]['ctrlRange'] = 1
        self.assertNotIn('reserve-handoff', rules(mon))
        mon['creeps'][-1]['ttl'] = 10
        self.assertIn('reserve-handoff', rules(mon))

    def test_stale_reservation_and_suspended_remote(self):
        mon = sample(); remote = mon['rooms'][0]['remotes'][0]
        remote['reservation'].update(ticksToEnd=500, seenAt=500)
        self.assertIn('reserve-handoff', rules(mon))
        remote['suspendedUntil'] = 1100
        self.assertNotIn('reserve-handoff', rules(mon))

    def test_reserver_not_wanted_skips_handoff(self):
        mon = sample(); remote = mon['rooms'][0]['remotes'][0]
        remote['reservation'] = None
        self.assertIn('reserve-handoff', rules(mon))
        remote.update(demandKnown=True, want={'remoteMiner': 1, 'reserver': 0, 'remoteHauler': 1})
        self.assertNotIn('reserve-handoff', rules(mon))
        remote['want']['reserver'] = 1
        self.assertIn('reserve-handoff', rules(mon))

    def test_invisible_is_unknown_not_zero(self):
        mon = sample(); remote = mon['rooms'][0]['remotes'][0]
        remote.update(visible=False, drops=None, reservation=None)
        self.assertIn('visibility', rules(mon))
        self.assertNotIn('reserve-handoff', rules(mon))
        self.assertNotIn('ground-backlog', rules(mon))

    def test_drop_identity_and_no_false_decay_claim(self):
        old = sample(); old['rooms'][0]['remotes'][0]['drops'] = [{'id': 'pile1', 'amount': 1500}]
        mon = copy.deepcopy(old); mon['t'] += 100
        self.assertTrue({'ground-retained', 'ground-backlog'} <= rules(mon, old))
        mon['rooms'][0]['remotes'][0]['drops'][0]['id'] = 'new-pile'
        self.assertNotIn('ground-retained', rules(mon, old))

    def test_construction_does_not_hide_stall(self):
        old = sample(); mon = sample(1200)
        mon['rooms'][0]['prog'] = old['rooms'][0]['prog']
        mon['rooms'][0]['sites'] = [{'id': 'site', 'progress': 100}]
        self.assertIn('development-stalled', rules(mon, old))
        self.assertIn('upgrade-underuse', rules(mon, old))
        mon['scriptV'] = 2
        self.assertNotIn('development-stalled', rules(mon, old))

    def test_empty_snapshot_with_good_observed_throughput_is_not_starvation(self):
        old = sample(); mon = sample(1100)
        mon['creeps'][0]['energy'] = 0
        self.assertNotIn('supply-mismatch', rules(mon, old))

    def test_old_monitor_also_excludes_cross_version_rate(self):
        old = sample(); mon = sample(1200, 2)
        for data in (old, mon):
            data['rooms'][0]['spawnUtil'] = {'total': 1, 'busy': 1, 'idle': 0}
        analysis = monitor.analyze_room(mon, mon['rooms'][0], [{'mon': old}])
        self.assertIsNone(analysis['rate'])

    def test_sparse_sampling_and_economy_unknown(self):
        mon = sample()
        entry = health.assess(mon, [{'mon': sample(900), 'sampledAt': 100}])
        self.assertIn('cadence', {f['rule'] for f in entry['findings']})
        self.assertIn('禁止', entry['coverage']['economy'])
        mon['schema'] = 3
        self.assertIn('coverage', rules(mon))

    def test_burst_uses_sufficient_window_without_crossing_deployment(self):
        mon = sample(1040)
        self.assertEqual(health.prior(mon, [{'mon':sample(1000)}, {'mon':sample(1020)}])['t'], 1000)
        self.assertEqual(health.prior(mon, [{'mon':sample(1000, 0)}, {'mon':sample(1020)}])['t'], 1020)

    def test_spawn_reservation_defers_supply_rule_without_claiming_recovery(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        mon['rooms'][0].update(energy=300, spawnWaiting={'cost':650, 'at':1000})
        result = health.assess(mon, [])
        self.assertNotIn('W1N1:supply-mismatch', result['checked'])
        mon['rooms'][0]['spawnWaiting']['at'] = 900
        self.assertIn('supply-mismatch', rules(mon))

    def cpu_mon(self, cpus, bucket, px=None):
        mon = sample(); mon.update(cpuLimit=150, bucket=bucket, px=px,
                                   statsTail=[{'t': 900 + 30 * i, 'cpu': c} for i, c in enumerate(cpus)])
        return mon

    def test_cpu_emergency_on_sustained_overrun_or_drained_bucket(self):
        live = self.cpu_mon([171.9, 128.8, 160, 150.5, 145], 303)
        result = health.assess(live, [])
        finding = next(f for f in result['findings'] if f['rule'] == 'cpu-emergency')
        self.assertEqual((finding['scope'], finding['severity']), ('global', 'urgent'))
        self.assertIn('cpu-emergency', rules(self.cpu_mon([160, 155, 158], 9000)))
        self.assertIn('cpu-emergency', rules(self.cpu_mon([120, 110, 130], 800)))
        healthy = self.cpu_mon([120, 110, 130, 175], 4000)
        self.assertIn('global:cpu-emergency', health.assess(healthy, [])['checked'])
        self.assertNotIn('cpu-emergency', rules(healthy))

    def test_cpu_emergency_pixel_refill_and_missing_data(self):
        old = self.cpu_mon([100], 10000, px=5)
        refill = self.cpu_mon([110, 120], 200, px=6)
        self.assertNotIn('cpu-emergency', {f['rule'] for f in health.assess(refill, [{'mon': old}])['findings']})
        overrun = self.cpu_mon([160, 170], 200, px=6)
        self.assertIn('cpu-emergency', {f['rule'] for f in health.assess(overrun, [{'mon': old}])['findings']})
        for broken in (self.cpu_mon([], 200), self.cpu_mon([160], None), dict(self.cpu_mon([160], 200), cpuLimit=None)):
            with self.subTest(broken=broken.get('statsTail')):
                self.assertNotIn('global:cpu-emergency', health.assess(broken, [])['checked'])

    def test_hauler_missing_is_checked(self):
        self.assertEqual(monitor.remote_shortfall({'enabled': True, 'want': {'remoteHauler': 2},
                                                  'have': {'remoteHauler': 0}}, 1000), ['remoteHauler'])


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, 'incidents.json')

    def update(self, mon, history=None):
        entry = {'mon': mon, 'issues': [], 'health': health.assess(mon, history or [])}
        return health.update_state(self.path, entry)

    def test_repeat_escalates_then_two_positive_samples_close(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        for tick in (1000, 1010, 1020):
            mon['t'] = tick; state = self.update(mon)
        key = 'W1N1:supply-mismatch'
        self.assertEqual(state['incidents'][key]['status'], 'escalated')
        state = self.update(mon)
        self.assertEqual(state['incidents'][key]['observations'], 3)
        mon['creeps'][0]['energy'] = 50; mon['t'] = 1030
        self.assertEqual(self.update(mon)['incidents'][key]['status'], 'recovering')
        mon['t'] = 1040
        self.assertEqual(self.update(mon)['incidents'][key]['status'], 'recovering')
        mon['t'] = 1060
        self.assertEqual(self.update(mon)['incidents'][key]['status'], 'resolved')

    def test_missing_visibility_cannot_close_reserve_incident(self):
        mon = sample(); remote = mon['rooms'][0]['remotes'][0]
        remote['reservation'] = None
        self.update(mon)
        remote['visible'] = False
        for tick in (1100, 1200):
            mon['t'] = tick; state = self.update(mon)
        self.assertEqual(state['incidents']['W1N1/W1N2:reserve-handoff']['status'], 'awaiting-evidence')

    def test_departed_upgrader_cannot_close_supply_incident(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        self.update(mon)
        mon['creeps'][0]['ctrlRange'] = 14
        for tick in (1100, 1200):
            mon['t'] = tick; state = self.update(mon)
        self.assertEqual(state['incidents']['W1N1:supply-mismatch']['status'], 'awaiting-evidence')

    def test_version_change_restarts_clean_evidence(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0; self.update(mon)
        mon['creeps'][0]['energy'] = 50; mon['t'] = 1100; self.update(mon)
        mon['t'] = 1200; mon['scriptV'] = 2
        self.assertEqual(self.update(mon)['incidents']['W1N1:supply-mismatch']['status'], 'recovering')

    def test_expected_safe_mode_does_not_escalate_from_repetition(self):
        for tick in (1000, 1100, 1200):
            mon = sample(tick)
            entry = {'mon':mon, 'health':health.assess(mon, []),
                     'issues':['W1N1 safe mode 仍处于激活状态: 剩余 500 ticks']}
            state = health.update_state(self.path, entry)
        item = next(i for i in state['incidents'].values() if i['rule'] == 'legacy')
        self.assertEqual(item['status'], 'observing')

    def test_confirmed_bug_stays_open_after_transient_recovery(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        state = self.update(mon)
        key = 'W1N1:supply-mismatch'
        state['incidents'][key]['workStatus'] = 'fix-required'
        health.save_state(self.path, state)
        mon['creeps'][0]['energy'] = 50
        for tick in (1100, 1200):
            mon['t'] = tick; state = self.update(mon)
        self.assertEqual(state['incidents'][key]['status'], 'awaiting-fix')
        self.assertGreater(state['summary']['open'], 0)

    def test_verified_defect_recurrence_requires_new_evidence(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        state = self.update(mon); key = 'W1N1:supply-mismatch'
        state['incidents'][key].update(status='resolved', workStatus='verified')
        health.save_state(self.path, state)
        mon['t'] = 1200
        self.assertEqual(self.update(mon)['incidents'][key]['workStatus'], 'fix-required')

    def reserve_incident(self):
        mon = sample(); mon['rooms'][0]['remotes'][0]['reservation'] = None
        self.update(mon)
        return mon, 'W1N1/W1N2:reserve-handoff'

    def test_dewhitelisted_remote_retires_its_incidents_as_obsolete(self):
        for reason in ('notWhitelisted', 'tooFar'):
            with self.subTest(reason=reason):
                if os.path.exists(self.path): os.remove(self.path)
                mon, key = self.reserve_incident()
                mon['rooms'][0]['remotes'][0].update(enabled=False, suspendReason=reason)
                mon['t'] = 1100; state = self.update(mon)
                self.assertEqual(state['incidents'][key]['status'], 'obsolete')
                self.assertEqual(state['incidents'][key]['resolution']['reason'], 'scope-gone:remote-' + reason)
                self.assertEqual(state['summary']['obsolete'], 1)
                self.assertNotIn(key, [k for k, i in state['incidents'].items() if i['status'] not in health.CLOSED])

    def test_removed_remote_or_lost_room_is_obsolete(self):
        mon, key = self.reserve_incident()
        mon['rooms'][0]['remotes'] = []; mon['t'] = 1100
        self.assertEqual(self.update(mon)['incidents'][key]['resolution']['reason'], 'scope-gone:remote-removed')
        mon = sample(1200); mon['creeps'][0]['energy'] = 0; self.update(mon)
        mon['rooms'][0]['name'] = 'W5N5'; mon['t'] = 1300
        state = self.update(mon)
        self.assertEqual(state['incidents']['W1N1:supply-mismatch']['status'], 'obsolete')

    def test_temporary_suspension_or_crashed_check_stays_open(self):
        mon, key = self.reserve_incident()
        mon['rooms'][0]['remotes'][0].update(enabled=False, suspendReason='hostileCreep', suspendedUntil=5000)
        mon['t'] = 1100
        self.assertEqual(self.update(mon)['incidents'][key]['status'], 'awaiting-evidence')
        mon = sample(1200); mon['t'] = 1200
        entry = {'mon': mon, 'issues': [], 'health': {'findings': [], 'checked': [],
                 'coverage': {'sameVersionTicks': 0}}}
        state = health.update_state(self.path, entry)
        self.assertEqual(state['incidents'][key]['status'], 'awaiting-evidence')
        mon['rooms'] = []; mon['t'] = 1300
        entry['mon'] = mon
        self.assertEqual(health.update_state(self.path, entry)['incidents'][key]['status'], 'awaiting-evidence')

    def test_confirmed_defect_survives_scope_retirement_and_recurrence_reopens(self):
        mon, key = self.reserve_incident()
        state = health.read_state(self.path); state['incidents'][key]['workStatus'] = 'fix-required'
        health.save_state(self.path, state)
        mon['rooms'][0]['remotes'][0].update(enabled=False, suspendReason='notWhitelisted'); mon['t'] = 1100
        item = self.update(mon)['incidents'][key]
        self.assertEqual(item['status'], 'awaiting-fix'); self.assertIn('scopeGone', item)
        state = health.read_state(self.path); state['incidents'][key].pop('workStatus')
        health.save_state(self.path, state); mon['t'] = 1200
        self.assertEqual(self.update(mon)['incidents'][key]['status'], 'obsolete')
        mon['rooms'][0]['remotes'][0].update(enabled=True, suspendReason=None); mon['t'] = 1300
        item = self.update(mon)['incidents'][key]
        self.assertEqual(item['status'], 'escalated'); self.assertNotIn('scopeGone', item)

    def alerts(self, mon):
        return {a['key']: a['reason'] for a in self.update(mon)['lastSample']['alerts']}

    def test_alerts_only_on_new_escalated_or_unacknowledged_urgent(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        key = 'W1N1:supply-mismatch'
        self.assertEqual(self.alerts(mon), {key: 'new'})
        self.assertEqual(self.alerts(mon), {})
        mon['t'] = 1010; self.assertEqual(self.alerts(mon), {})
        mon['t'] = 1020; self.assertEqual(self.alerts(mon), {key: 'escalated'})
        mon['t'] = 1030; self.assertEqual(self.alerts(mon), {})
        state = health.read_state(self.path)
        self.assertEqual(state['summary']['open'], 2); self.assertEqual(state['summary']['alerts'], 0)
        mon['creeps'][0]['energy'] = 50; mon['t'] = 1040; self.alerts(mon)
        mon['creeps'][0]['energy'] = 0; mon['t'] = 1050; self.assertEqual(self.alerts(mon), {})
        mon['creeps'][0]['energy'] = 50
        for tick in (1100, 1140): mon['t'] = tick; self.alerts(mon)
        self.assertEqual(health.read_state(self.path)['incidents'][key]['status'], 'resolved')
        mon['creeps'][0]['energy'] = 0; mon['t'] = 1200
        self.assertEqual(self.alerts(mon), {key: 'new'})

    def test_urgent_repeats_until_investigation_is_attached(self):
        mon = sample(); mon['rooms'][0]['remotes'][0]['reservation'] = None
        key = 'W1N1/W1N2:reserve-handoff'
        self.assertEqual(self.alerts(mon)[key], 'new')
        mon['t'] = 1100; self.assertEqual(self.alerts(mon)[key], 'urgent')
        state = health.read_state(self.path)
        state['incidents'][key]['investigation'] = [{'at': time.time(), 'note': 'known'}]
        health.save_state(self.path, state)
        mon['t'] = 1200; self.assertNotIn(key, self.alerts(mon))

    def test_stale_note_from_earlier_episode_does_not_silence_urgent(self):
        mon = sample(); mon['rooms'][0]['remotes'][0]['reservation'] = None
        key = 'W1N1/W1N2:reserve-handoff'
        self.alerts(mon)
        state = health.read_state(self.path)
        state['incidents'][key]['investigation'] = [{'at': state['incidents'][key]['episodeAt'] - 86400 * 14,
                                                     'note': 'old episode'}]
        health.save_state(self.path, state)
        mon['t'] = 1100; self.assertEqual(self.alerts(mon)[key], 'urgent')

    def test_alerts_accumulate_until_acknowledged(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        key = 'W1N1:supply-mismatch'
        self.update(mon)
        mon['t'] = 1010; self.update(mon)
        mon['t'] = 1020; state = self.update(mon)
        self.assertEqual(state['lastSample']['alerts'][0]['reason'], 'escalated')
        self.assertEqual([(a['key'], a['reason']) for a in state['pendingAlerts']],
                         [(key, 'new'), (key, 'escalated')], '后来的样本不能覆盖之前未确认的告警')
        self.assertEqual(state['summary']['pending'], 2)
        self.assertEqual(health.ack_alerts(self.path), 2)
        self.assertEqual(health.read_state(self.path)['pendingAlerts'], [])
        mon['t'] = 1030; self.assertEqual(self.update(mon)['pendingAlerts'], [])

    def test_legacy_escalated_ledger_does_not_alert_on_upgrade(self):
        mon = sample(); mon['creeps'][0]['energy'] = 0
        key = 'W1N1:supply-mismatch'
        self.update(mon)
        state = health.read_state(self.path)
        state['incidents'][key].update(status='escalated', observations=40)
        state['incidents'][key].pop('escalatedAt', None)
        health.save_state(self.path, state)
        mon['t'] = 1100; self.assertEqual(self.alerts(mon), {})
        state = health.read_state(self.path)
        state['incidents'][key].update(status='awaiting-fix', workStatus='fix-required')
        state['incidents'][key].pop('escalatedAt', None)
        health.save_state(self.path, state)
        mon['t'] = 1200; self.assertEqual(self.alerts(mon), {key: 'escalated'})
        mon['t'] = 1300; self.assertEqual(self.alerts(mon), {})

    def test_failure_preserves_open_incidents(self):
        self.update(sample()); health.record_failure(self.path, 'timeout')
        state = health.read_state(self.path)
        self.assertIn('monitor:economy-coverage', state['incidents'])
        self.assertEqual(state['collectionFailure']['status'], 'unknown')

    def test_corrupt_ledger_not_replaced(self):
        with open(self.path, 'w') as stream: stream.write('broken')
        health.record_failure(self.path, 'bad json')
        with open(self.path) as stream: self.assertEqual(stream.read(), 'broken')
        self.assertTrue(os.path.exists(self.path + '.failure'))


if __name__ == '__main__':
    unittest.main()
