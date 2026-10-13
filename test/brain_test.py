import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

from brain import brief, combat, directive, guard, intel, plan, safemode  # noqa: E402
from brain.api import ScreepsApi  # noqa: E402

TICK = 73439000
ME = 'me'
MY_ID = '5de994c7ad2e8d3d72d1d6d2'
USERS = {'9': {'username': 'bigplayer'}, MY_ID: {'username': ME}}


def objects_for(sources=2, owner=None, level=0, reservation=None, creeps=(), invader_core=False, lairs=0,
                walls=0, towers=0, mineral='L'):
    objs = [{'_id': 'ctrl', 'type': 'controller', 'x': 31, 'y': 41, 'level': level}]
    if owner:
        objs[0]['user'] = owner
    if reservation:
        objs[0]['reservation'] = reservation
    for index in range(sources):
        objs.append({'_id': 'src%d' % index, 'type': 'source', 'x': 10 + index, 'y': 20, 'energyCapacity': 3000})
    if mineral:
        objs.append({'_id': 'min', 'type': 'mineral', 'x': 5, 'y': 8, 'mineralType': mineral, 'mineralAmount': 70000})
    for index, (user, body) in enumerate(creeps):
        objs.append({'_id': 'c%d' % index, 'type': 'creep', 'x': 1, 'y': 1, 'user': user, 'hits': 100 * len(body),
                     'hitsMax': 100 * len(body), 'ageTime': TICK + 1400,
                     'body': [{'type': part, 'hits': 100} for part in body]})
    if invader_core:
        objs.append({'_id': 'core', 'type': 'invaderCore', 'x': 25, 'y': 25, 'level': 1})
    for index in range(lairs):
        objs.append({'_id': 'lair%d' % index, 'type': 'keeperLair', 'x': 2, 'y': 2})
    for index in range(walls):
        objs.append({'_id': 'w%d' % index, 'type': 'constructedWall', 'x': 3, 'y': index})
    for index in range(towers):
        objs.append({'_id': 't%d' % index, 'type': 'tower', 'x': 4, 'y': index})
    return objs


class RoomMathTest(unittest.TestCase):
    def test_coords_roundtrip(self):
        for name in ('W33S7', 'E0N0', 'W0S0', 'E12N34'):
            self.assertEqual(intel.room_name(*intel.room_coords(name)), name)

    def test_ring_and_distance(self):
        ring = intel.ring_rooms('W33S7', 1)
        self.assertEqual(sorted(ring), sorted(['W34S6', 'W33S6', 'W32S6', 'W34S7', 'W32S7', 'W34S8', 'W33S8', 'W32S8']))
        self.assertEqual(intel.room_distance('W33S7', 'W31S9'), 2)
        self.assertEqual(len(intel.ring_rooms('W33S7', 2)), 24)

    def test_room_class(self):
        self.assertEqual(intel.room_class('W33S7'), 'normal')
        self.assertEqual(intel.room_class('W35S5'), 'center')
        self.assertEqual(intel.room_class('W34S6'), 'sk')
        self.assertEqual(intel.room_class('W30S7'), 'highway')
        self.assertEqual(intel.room_class('W33S10'), 'highway')


class BuildEntryTest(unittest.TestCase):
    def test_neutral_room(self):
        entry = intel.build_entry('W34S7', objects_for(walls=30), USERS, TICK, MY_ID)
        self.assertEqual(entry['sources'], 2)
        self.assertEqual(entry['sourceData'][0], {'id': 'src0', 'x': 10, 'y': 20, 'energyCapacity': 3000})
        self.assertIsNone(entry['owner'])
        self.assertEqual(entry['mineral'], 'L')
        self.assertEqual(entry['walls'], 30)
        self.assertEqual(entry['class'], 'normal')
        self.assertFalse(entry['threat'])
        self.assertEqual(entry['at'], TICK)
        self.assertEqual(entry['source'], 'external')

    def test_owned_room_with_armed_creeps(self):
        creeps = [('9', ['attack', 'move']), ('9', ['carry', 'move']), (MY_ID, ['attack'])]
        entry = intel.build_entry('W33S9', objects_for(owner='9', level=8, creeps=creeps, towers=5), USERS, TICK, MY_ID)
        self.assertEqual(entry['owner'], 'bigplayer')
        self.assertEqual(entry['level'], 8)
        self.assertEqual(entry['hostiles'], 2)
        self.assertEqual(entry['armedHostiles'], 1)
        self.assertTrue(entry['threat'])
        self.assertEqual(entry['towers'], 5)

    def test_reservation_and_invaders(self):
        reservation = {'user': '9', 'endTime': TICK + 1200}
        creeps = [('2', ['ranged_attack', 'move'])]
        entry = intel.build_entry('W33S8', objects_for(reservation=reservation, creeps=creeps, invader_core=True), USERS, TICK, MY_ID)
        self.assertEqual(entry['reservation'], {'username': 'bigplayer', 'ticksToEnd': 1200, 'mine': False})
        self.assertTrue(entry['invaderCore'])
        self.assertEqual(entry['armedHostiles'], 1)
        expired = intel.build_entry('W33S8', objects_for(reservation={'user': '9', 'endTime': TICK - 5}), USERS, TICK, MY_ID)
        self.assertIsNone(expired['reservation'])

    def test_keeper_lair(self):
        entry = intel.build_entry('W34S6', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID)
        self.assertEqual(entry['lairs'], 4)
        self.assertEqual(entry['class'], 'sk')


def neighborhood():
    return {
        'W33S6': intel.build_entry('W33S6', objects_for(sources=1), USERS, TICK, MY_ID),
        'W32S7': intel.build_entry('W32S7', objects_for(sources=1, mineral='O'), USERS, TICK, MY_ID),
        'W33S8': intel.build_entry('W33S8', objects_for(sources=2, mineral='K'), USERS, TICK, MY_ID),
        'W34S7': intel.build_entry('W34S7', objects_for(sources=2, walls=30), USERS, TICK, MY_ID),
        'W33S9': intel.build_entry('W33S9', objects_for(owner='9', level=8, towers=5), USERS, TICK, MY_ID),
        'W34S6': intel.build_entry('W34S6', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID),
        'W32S8': intel.build_entry('W32S8', objects_for(sources=2, creeps=[('2', ['attack', 'move'])]), USERS, TICK, MY_ID),
    }


def intel_entry_two_hop():
    return intel.build_entry('W31S7', objects_for(sources=2, mineral='H'), USERS, TICK, MY_ID)


class PlanTest(unittest.TestCase):
    def test_remote_min_score_gate_is_off_by_default_and_keeps_sticky_rooms(self):
        # 评分下限：默认 None 不设门；设门后低分候选进 rejected（lowScore:<分>），不占 remoteMaxRooms 名额。
        # 已在用的外矿先加 stickyBonus 再判，所以换房成本不会被一次微小分差抵消
        data = neighborhood()
        base = plan.choose_remotes('W33S7', data, ME, 4, tick=TICK)
        self.assertIn('W33S8', base['remotes'])
        scores = {item['room']: item['score'] for item in base['ranked']}
        cut = max(scores.values())          # 门设在最高分：只有并列最高的留下
        gated = plan.choose_remotes('W33S7', data, ME, 4, cfg={'remoteMinScore': cut}, tick=TICK)
        self.assertTrue(all(scores[room] >= cut for room in gated['remotes']), (gated['remotes'], scores))
        dropped = [room for room in base['remotes'] if room not in gated['remotes']]
        self.assertTrue(dropped, base['remotes'])
        for room in dropped:
            self.assertTrue(gated['rejected'][room].startswith('lowScore:'), gated['rejected'][room])
        # 粘性：同一个房作为"在用"时加 6 分，足以把它拉回门内
        low = min(scores, key=lambda room: scores[room])
        sticky = plan.choose_remotes('W33S7', data, ME, 4, cfg={'remoteMinScore': scores[low] + 3},
                                     tick=TICK, current=[low])
        self.assertIn(low, sticky['remotes'], sticky['rejected'])

    def test_choose_remotes_prefers_safe_double_source_neighbor(self):
        result = plan.choose_remotes('W33S7', neighborhood(), ME, 4, tick=TICK)
        self.assertEqual(result['remotes'][0], 'W34S7')
        self.assertLessEqual(len(result['remotes']), 4, 'RCL4 最多 4 个外矿')
        self.assertGreaterEqual(len(result['remotes']), 2)
        ranked = [item['room'] for item in result['ranked']]
        self.assertEqual(ranked[:2], ['W34S7', 'W33S8'])
        self.assertIn('W33S6', ranked, '单源房也进入候选，只是分数更低')
        self.assertLess([r['score'] for r in result['ranked'] if r['room'] == 'W33S6'][0],
                        [r['score'] for r in result['ranked'] if r['room'] == 'W33S8'][0])
        self.assertEqual(result['rejected']['W34S6'], 'keeper')
        self.assertEqual(result['rejected']['W32S8'], 'threat')
        self.assertNotIn('W33S9', result['ranked'])

    def test_choose_remotes_respects_rcl_limit(self):
        self.assertEqual(plan.choose_remotes('W33S7', neighborhood(), ME, 3, tick=TICK)['remotes'], [])
        six = plan.choose_remotes('W33S7', neighborhood(), ME, 6, tick=TICK)
        self.assertEqual(six['remotes'][:2], ['W34S7', 'W33S8'])
        self.assertLessEqual(len(six['remotes']), 4)

    def test_diagonal_rooms_count_as_two_room_transits(self):
        data = neighborhood()
        data['W32S6'] = intel.build_entry('W32S6', objects_for(sources=2, mineral='L'), USERS, TICK, MY_ID)
        result = plan.choose_remotes('W33S7', data, ME, 6, tick=TICK)
        ranked = [item['room'] for item in result['ranked']]
        self.assertIn('W32S6', ranked)
        self.assertGreater(ranked.index('W32S6'), ranked.index('W33S8'), '对角双源房要排在相邻双源房之后')
        self.assertLess(plan.remote_score('W33S7', 'W32S6', data['W32S6'], data, plan.DEFAULTS),
                        plan.remote_score('W33S7', 'W33S6', data['W33S6'], data, plan.DEFAULTS),
                        '对角双源房的分数低于相邻单源房（穿房成本）')

    def test_two_hop_rooms_are_candidates_but_rank_below_neighbors(self):
        data = neighborhood()
        data['W31S7'] = intel_entry_two_hop()
        result = plan.choose_remotes('W33S7', data, ME, 6, tick=TICK)
        ranked = [item['room'] for item in result['ranked']]
        self.assertIn('W31S7', ranked)
        self.assertGreater(ranked.index('W31S7'), ranked.index('W33S8'))

    def test_remote_behind_keeper_rooms_is_rejected(self):
        # 线上 W34S7→W36S7：W35S7 西侧无出口，唯一通路是 W35S6→W36S6 两个 SK 房（出口数据已与游戏 describeExits 核对）
        data = {
            'W34S7': intel.build_entry('W34S7', objects_for(sources=2, owner=MY_ID, level=4), USERS, TICK, MY_ID),
            'W35S7': intel.build_entry('W35S7', objects_for(sources=2), USERS, TICK, MY_ID),
            'W35S6': intel.build_entry('W35S6', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID),
            'W36S6': intel.build_entry('W36S6', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID),
            'W36S7': intel.build_entry('W36S7', objects_for(sources=2), USERS, TICK, MY_ID),
        }
        data['W34S7']['exits'] = {'N': True, 'S': False, 'W': True, 'E': True}
        data['W35S7']['exits'] = {'N': True, 'S': False, 'W': False, 'E': True}
        data['W36S7']['exits'] = {'N': True, 'S': True, 'W': True, 'E': False}
        self.assertIsNone(plan.route_hops('W34S7', 'W36S7', data, ME, 4))
        result = plan.choose_remotes('W34S7', data, ME, 4, tick=TICK, current=['W36S7'])
        self.assertEqual(result['rejected']['W36S7'], 'noRoute', '已在用也不豁免：creep 会死在 SK 房')
        self.assertEqual(result['remotes'], ['W35S7'])
        claim = plan.choose_claim('W34S7', data, ME, 12, ['W34S7'], tick=TICK, level=4)
        self.assertEqual(claim['rejected']['W36S7'], 'noRoute', '占领候选同样不能只靠穿 SK 房到达')
        # 把 W35S7/W36S7 之间的边两侧都打开：W36S7 两跳可达，回到候选（只开一侧仍不通）
        data['W35S7']['exits']['W'] = True
        self.assertIsNone(plan.route_hops('W34S7', 'W36S7', data, ME, 4), '共享边要两侧都有出口')
        data['W36S7']['exits']['E'] = True
        self.assertEqual(plan.route_hops('W34S7', 'W36S7', data, ME, 4), 2)
        self.assertIn('W36S7', plan.choose_remotes('W34S7', data, ME, 4, tick=TICK)['remotes'])

    def test_claim_queue_routes_through_keeper_rooms_with_avoidance(self):
        # 用户点名的占领清单可穿 SK 房（claimer/pioneer 有 keeper 规避）；remote 默认仍不穿（见上一个测试）。
        # 垂直链：W34S7(家) → S6/S5/S4（都是 SK 房）→ W34S3（SK 环外目标）；无 exits 时 connected 按正交相邻算。
        home_objs = objects_for(sources=2, owner=MY_ID, level=5)
        home_objs.append({'_id': 'spawn0', 'type': 'spawn', 'x': 25, 'y': 25, 'user': MY_ID})  # 有 spawn 才不算开荒中，可当 sponsor
        data = {
            'W34S7': intel.build_entry('W34S7', home_objs, USERS, TICK, MY_ID),
            'W34S6': intel.build_entry('W34S6', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID),
            'W34S5': intel.build_entry('W34S5', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID),
            'W34S4': intel.build_entry('W34S4', objects_for(lairs=4, sources=3), USERS, TICK, MY_ID),
            'W34S3': intel.build_entry('W34S3', objects_for(sources=2), USERS, TICK, MY_ID),  # 目标（SK 环外）
        }
        self.assertEqual(data['W34S6']['class'], 'sk')
        self.assertTrue(data['W34S6'].get('lairPos'), 'SK 房 intel 记录了 lairPos')
        # passable：SK 房默认不穿；allow_keeper=True 且有 lairPos 才穿；没 lairPos 即便 allow_keeper 也不穿
        self.assertFalse(plan.passable(data['W34S6'], ME), 'SK 房默认不可穿（remote 路由）')
        self.assertTrue(plan.passable(data['W34S6'], ME, allow_keeper=True), 'allow_keeper 且有 lairPos 时 SK 房可穿')
        no_lair = dict(data['W34S6']); no_lair['lairPos'] = []
        self.assertFalse(plan.passable(no_lair, ME, allow_keeper=True), '没有 lairPos（情报不足）即便 allow_keeper 也不穿')
        # route_hops：默认穿不过 SK，allow_keeper 时可（穿 S6/S5/S4 = 4 跳到 S3）
        self.assertIsNone(plan.route_hops('W34S7', 'W34S3', data, ME, 6), 'remote 路由穿不过 SK 房到 SK 环外')
        self.assertEqual(plan.route_hops('W34S7', 'W34S3', data, ME, 6, allow_keeper=True), 4, 'allow_keeper 穿 SK：S6→S5→S4→S3 四跳')
        # assign_claim_queue：点名 W34S3 能分到 sponsor（穿 SK），travel 在 claimer 寿命内
        plans = {'W34S7': {'claim': None}}
        status = plan.assign_claim_queue(plans, ['W34S3'], data, ME, {'W34S7': 5}, ['W34S7'], 12, tick=TICK)
        self.assertEqual(status['W34S3']['status'], 'claim', '用户点名的 SK 环外房分到 sponsor')
        self.assertEqual(status['W34S3']['sponsor'], 'W34S7')
        self.assertLessEqual(status['W34S3']['travel'], plan.DEFAULTS['claimTravelTicks'], '在 claimer 寿命内走得到')

    def test_route_hops_follow_exits_and_score_by_real_distance(self):
        # 线上 W34S7→W34S8：共享边被墙封死，实际走 W33S7→W33S8→W34S8 三跳；走廊只穿己方/无主房
        data = {
            'W34S7': intel.build_entry('W34S7', objects_for(sources=2, owner=MY_ID, level=4), USERS, TICK, MY_ID),
            'W33S7': intel.build_entry('W33S7', objects_for(sources=2, owner=MY_ID, level=5), USERS, TICK, MY_ID),
            'W33S8': intel.build_entry('W33S8', objects_for(sources=2, owner=MY_ID, level=1), USERS, TICK, MY_ID),
            'W34S8': intel.build_entry('W34S8', objects_for(sources=1), USERS, TICK, MY_ID),
        }
        data['W34S7']['exits'] = {'N': True, 'S': False, 'W': True, 'E': True}
        data['W34S8']['exits'] = {'N': False, 'S': True, 'W': False, 'E': True}
        self.assertEqual(plan.route_hops('W34S7', 'W34S8', data, ME, 4), 3)
        self.assertIsNone(plan.route_hops('W34S7', 'W34S8', data, ME, 2), '上限之内到不了')
        result = plan.choose_remotes('W34S7', data, ME, 4, tick=TICK)
        self.assertEqual(result['remotes'], ['W34S8'])
        self.assertEqual([r['score'] for r in result['ranked'] if r['room'] == 'W34S8'][0],
                         round(plan.remote_score('W34S7', 'W34S8', data['W34S8'], data, plan.DEFAULTS, hops=3), 1))
        self.assertLess(plan.remote_score('W34S7', 'W34S8', data['W34S8'], data, plan.DEFAULTS, hops=3),
                        plan.remote_score('W34S7', 'W34S8', data['W34S8'], data, plan.DEFAULTS, hops=1), '按实际穿房数计分')
        data['W33S8'] = intel.build_entry('W33S8', objects_for(sources=2, owner='9', level=8, towers=3), USERS, TICK, MY_ID)
        self.assertIsNone(plan.route_hops('W34S7', 'W34S8', data, ME, 4), '走廊不穿他人房')

    def test_plan_home_excludes_claim_target_and_own_rooms_from_remotes(self):
        data = neighborhood()
        result = plan.plan_home('W33S7', data, ME, 6, 12, ['W33S7'], tick=TICK, prefer_claim='W34S7')
        self.assertEqual(result['claim']['room'], 'W34S7')
        self.assertNotIn('W34S7', result['remotes'], '占领目标不再同时作为外矿')
        self.assertEqual(result['analysis']['remotes']['rejected'].get('W34S7'), 'excluded')

    def test_choose_claim_uses_headroom_and_preference(self):
        result = plan.choose_claim('W33S7', neighborhood(), ME, 12, ['W33S7'], tick=TICK, prefer='W34S7')
        self.assertEqual(result['claim'], {'room': 'W34S7', 'priority': 1})
        self.assertEqual(result['gclHeadroom'], 11)
        none = plan.choose_claim('W33S7', neighborhood(), ME, 1, ['W33S7'], tick=TICK)
        self.assertIsNone(none['claim'])
        self.assertEqual(none['gclHeadroom'], 0)
        bad_pref = plan.choose_claim('W33S7', neighborhood(), ME, 12, ['W33S7'], tick=TICK, prefer='W33S9')
        self.assertNotEqual(bad_pref['claim']['room'], 'W33S9')

    def test_plan_home_shape(self):
        result = plan.plan_home('W33S7', neighborhood(), ME, 4, 12, ['W33S7'], tick=TICK, prefer_claim='W34S7')
        self.assertEqual(result['claim']['room'], 'W34S7')
        self.assertEqual(result['remotes'][0], 'W33S8', '占领目标被排除后，外矿落到次优的相邻双源房')
        self.assertLessEqual(len(result['remotes']), 4, 'RCL4 最多 4 个外矿')
        self.assertIn('analysis', result)

    def test_strong_neighbor_penalty_requires_an_open_exit(self):
        data = neighborhood()
        base = plan.remote_score('W33S7', 'W33S8', data['W33S8'], data, plan.DEFAULTS)
        # 对角的强邻（W32S9）与 W33S8 没有直接出口：不扣分；正南的 W33S9 与 W33S8 之间的边被墙封死：也不扣分
        data['W32S9'] = intel.build_entry('W32S9', objects_for(owner='9', level=8, towers=5), USERS, TICK, MY_ID)
        data['W33S8']['exits'] = {'N': True, 'E': True, 'S': False, 'W': True}
        data['W33S9']['exits'] = {'N': False, 'E': True, 'S': True, 'W': True}
        self.assertEqual(plan.remote_score('W33S7', 'W33S8', data['W33S8'], data, plan.DEFAULTS), base + 0.0 + float(plan.DEFAULTS['strongNeighborPenalty']),
                         '强邻但不连通：不扣分（基线里 W33S9 按坐标相邻扣了一次）')
        data['W33S8']['exits']['S'] = True
        data['W33S9']['exits']['N'] = True
        self.assertEqual(plan.remote_score('W33S7', 'W33S8', data['W33S8'], data, plan.DEFAULTS), base, '边开着才扣分')

    def test_exits_from_terrain(self):
        terrain = ['0'] * 2500
        for x in range(50):
            terrain[x] = '1'                # 北边全墙
            terrain[49 * 50 + x] = '1'      # 南边全墙
        for y in range(50):
            terrain[y * 50] = '1'           # 西边全墙
        terrain[25 * 50 + 49] = '0'         # 东边有一格开口
        exits = intel.exits_from_terrain(''.join(terrain))
        self.assertEqual(exits, {'N': False, 'E': True, 'S': False, 'W': False})

    def test_own_reservation_by_user_id_is_not_foreign(self):
        # room-objects 的 users 表偶尔不含自己，reservation.username 会退化成用户 id：不能把自己预定的外矿当成别人的
        data = neighborhood()
        data['W32S7'] = intel.build_entry('W32S7', objects_for(sources=1, mineral='O', reservation={'user': MY_ID, 'endTime': TICK + 4000}), {}, TICK, MY_ID)
        self.assertTrue(data['W32S7'].get('reservation', {}).get('mine'), data['W32S7'].get('reservation'))
        self.assertIsNone(plan.usable_for_remote(data['W32S7'], ME, plan.DEFAULTS, TICK))
        foreign = intel.build_entry('W32S7', objects_for(sources=1, mineral='O', reservation={'user': '9', 'endTime': TICK + 4000}), {}, TICK, MY_ID)
        self.assertTrue(str(plan.usable_for_remote(foreign, ME, plan.DEFAULTS, TICK)).startswith('reservation:'))

    def test_current_remote_survives_a_transient_threat(self):
        data = neighborhood()
        # 现有外矿 W34S7 出现一只 Invader（threat）：游戏内防御会处理，大脑不该立刻换房去折腾两跳外的候选
        data['W34S7'] = intel.build_entry('W34S7', objects_for(sources=2, walls=30, creeps=[('2', ['attack', 'move'])]), USERS, TICK, MY_ID)
        data['W31S7'] = intel_entry_two_hop()
        dropped = plan.choose_remotes('W33S7', data, ME, 4, tick=TICK)
        self.assertNotIn('W34S7', dropped['remotes'], '前提：不带 current 时威胁房被剔除')
        kept = plan.choose_remotes('W33S7', data, ME, 4, tick=TICK, current=['W34S7'])
        self.assertIn('W34S7', kept['remotes'], '现有外矿遇临时威胁保留')
        # 但被别人占了/预定了仍然要换
        data['W34S7'] = intel.build_entry('W34S7', objects_for(sources=2, owner='9', level=3), USERS, TICK, MY_ID)
        gone = plan.choose_remotes('W33S7', data, ME, 4, tick=TICK, current=['W34S7'])
        self.assertNotIn('W34S7', gone['remotes'])

    def test_current_remote_names_include_temporarily_suspended(self):
        records = {
            'W32S7': {'enabled': True},
            'W33S6': {'enabled': False, 'suspendReason': 'hostileCreep', 'suspendedUntil': 200},
            'W35S7': {'enabled': False, 'suspendReason': 'notWhitelisted'},
            'W32S6': {'enabled': False, 'suspendReason': 'tooFar'},
            'legacy': 'W31S7',
        }
        self.assertEqual(plan.current_remote_names(records, tick=100), ['W32S7', 'W33S6'])
        self.assertEqual(plan.current_remote_names(records, tick=300), ['W32S7'], '暂停到期未恢复的不算')

    def test_current_remote_not_displaced_by_marginally_better_candidate(self):
        data = neighborhood()
        # W33S6 与 W32S7 同分（单源相邻房）：已经在用 W33S6 时不应换成 W32S7
        result = plan.choose_remotes('W33S7', data, ME, 4, tick=TICK, current=['W33S6'])
        self.assertIn('W33S6', result['remotes'])

    def test_plan_home_excludes_only_the_effective_claim(self):
        data = neighborhood()
        # locks 把占领目标锁在 W34S7（已占下）时，规划自己算出的候选 W33S8 不该被排除出外矿
        result = plan.plan_home('W33S7', data, ME, 4, 12, ['W33S7'], tick=TICK,
                                claim_override={'room': 'W34S7', 'priority': 1})
        self.assertIn('W33S8', result['remotes'])
        self.assertNotIn('W34S7', result['remotes'])
        self.assertEqual(result['analysis']['remotes']['rejected'].get('W34S7'), 'excluded')
        # 锁值为 null（暂缓占领）时不排除任何候选
        held = plan.plan_home('W33S7', data, ME, 4, 12, ['W33S7'], tick=TICK, claim_override=None)
        self.assertIn('W33S8', held['remotes'])
        self.assertNotEqual(held['analysis']['remotes']['rejected'].get('W33S8'), 'excluded')


class ClaimPolicyTest(unittest.TestCase):
    def test_low_level_home_does_not_sponsor_claims(self):
        # RCL2 母房容量 550 连 claimer（650）都孵不出，规划不该给它排占领目标
        result = plan.choose_claim('W33S7', neighborhood(), ME, 12, ['W33S7'], tick=TICK, level=2)
        self.assertIsNone(result['claim'])
        self.assertEqual(result['blocked'], 'level:2')
        home_plan = plan.plan_home('W33S7', neighborhood(), ME, 2, 12, ['W33S7'], tick=TICK)
        self.assertIsNone(home_plan['claim'])

    def test_only_one_claim_account_wide(self):
        plans = {
            'W33S7': {'remotes': [], 'claim': {'room': 'W33S8', 'priority': 1}, 'analysis': {'claim': {'blocked': None}}},
            'W34S7': {'remotes': [], 'claim': {'room': 'W35S7', 'priority': 1}, 'analysis': {'claim': {'blocked': None}}},
            'W35S9': {'remotes': [], 'claim': None, 'analysis': {'claim': {'blocked': 'gcl'}}},
        }
        plan.single_claim(plans, {'W33S7': 4, 'W34S7': 5, 'W35S9': 6})
        self.assertIsNone(plans['W33S7']['claim'])
        self.assertEqual(plans['W33S7']['analysis']['claim']['blocked'], 'claimElsewhere:W34S7')
        self.assertEqual(plans['W34S7']['claim']['room'], 'W35S7')
        self.assertEqual(plans['W35S9']['analysis']['claim']['blocked'], 'gcl')

    def test_no_new_claim_while_a_new_room_is_bootstrapping(self):
        data = neighborhood()
        data['W34S7'] = intel.build_entry('W34S7', objects_for(sources=2, owner=MY_ID, level=1), USERS, TICK, MY_ID)
        result = plan.choose_claim('W33S7', data, ME, 12, ['W33S7', 'W34S7'], tick=TICK)
        self.assertIsNone(result['claim'])
        self.assertEqual(result['blocked'], 'bootstrapping:W34S7')

    def test_claim_resumes_once_the_new_room_has_a_spawn(self):
        data = neighborhood()
        objs = objects_for(sources=2, owner=MY_ID, level=2)
        objs.append({'_id': 'sp', 'type': 'spawn', 'x': 24, 'y': 36, 'user': MY_ID})
        data['W34S7'] = intel.build_entry('W34S7', objs, USERS, TICK, MY_ID)
        data['W31S5'] = intel.build_entry('W31S5', objects_for(sources=2, mineral='O'), USERS, TICK, MY_ID)
        result = plan.choose_claim('W33S7', data, ME, 12, ['W33S7', 'W34S7'], tick=TICK)
        self.assertIsNotNone(result['claim'])
        self.assertEqual(result['claim']['room'], 'W33S8', '相邻候选优先于二跳候选')

    def test_gcl_headroom_counts_rooms_seen_in_intel(self):
        data = neighborhood()
        data['W34S7'] = intel.build_entry('W34S7', objects_for(sources=2, owner=MY_ID, level=1), USERS, TICK, MY_ID)
        result = plan.choose_claim('W33S7', data, ME, 2, ['W33S7', 'W34S7'], tick=TICK)
        self.assertEqual(result['gclHeadroom'], 0)


SMALL_MELEE = ['tough', 'tough', 'move', 'move', 'move', 'move', 'ranged_attack', 'work', 'attack', 'move']
SMALL_RANGED = ['tough', 'tough', 'move', 'move', 'move', 'move', 'ranged_attack', 'ranged_attack', 'ranged_attack', 'move']
SMALL_HEALER = ['move', 'move', 'move', 'move', 'heal', 'heal', 'heal', 'heal', 'heal', 'move']


def invader(body, boosts=None, age=TICK + 1400, hits=None):
    parts = []
    for part in body:
        item = {'type': part, 'hits': 100}
        if boosts and part in boosts:
            item['boost'] = boosts[part]
        parts.append(item)
    return {'_id': 'inv', 'type': 'creep', 'user': '2', 'x': 27, 'y': 43, 'body': parts,
            'hits': hits if hits is not None else 100 * len(body), 'hitsMax': 100 * len(body), 'ageTime': age}


class CombatTest(unittest.TestCase):
    # 与 src/defense.js 同一套公式：这里的数字要和 test/smoke.js 出兵评估场景一致

    def test_profile_of_live_boosted_pair(self):
        pair = [invader(SMALL_MELEE, {'tough': 'GO', 'ranged_attack': 'KO', 'attack': 'UH', 'work': 'ZH'}),
                invader(SMALL_RANGED, {'tough': 'GO', 'ranged_attack': 'KO'})]
        profile = combat.hostile_profile(pair, TICK)
        self.assertEqual((profile['count'], profile['dps'], profile['heal']), (2, 140, 0))
        self.assertTrue(profile['kiters'] and profile['boosted'])
        self.assertEqual(profile['hits'], 2171)
        self.assertEqual(profile['until'], TICK + 1400)

    def test_plain_pair_and_can_beat(self):
        pair = [invader(SMALL_MELEE), invader(SMALL_MELEE)]
        profile = combat.hostile_profile(pair, TICK)
        self.assertEqual((profile['hits'], profile['dps'], profile['kiters']), (2000, 80, False))
        self.assertFalse(combat.can_beat([['attack', 'attack', 'move', 'move']], profile))
        squad = combat.plan_squad(1800, profile)
        self.assertEqual((squad['style'], squad['count'], squad['body'].count('attack')), ('melee', 1, 7))

    def test_kiters_need_ranged_group(self):
        pair = [invader(SMALL_MELEE, {'tough': 'GO', 'ranged_attack': 'KO', 'attack': 'UH'}),
                invader(SMALL_RANGED, {'tough': 'GO', 'ranged_attack': 'KO'})]
        profile = combat.hostile_profile(pair, TICK)
        squad = combat.plan_squad(1800, profile)
        self.assertEqual(squad['style'], 'ranged')
        self.assertEqual(squad['count'], 2)
        self.assertEqual(squad['total'], 3200)
        self.assertFalse(combat.can_beat([squad['body']], profile))
        self.assertTrue(combat.can_beat([squad['body']] * 2, profile))

    def test_unwinnable_at_low_capacity(self):
        trio = [invader(SMALL_RANGED), invader(SMALL_RANGED), invader(SMALL_HEALER)]
        self.assertIsNone(combat.plan_squad(550, combat.hostile_profile(trio, TICK)))

    def test_energy_capacity(self):
        self.assertEqual(combat.energy_capacity(5, 1, 30), 1800)
        self.assertEqual(combat.energy_capacity(7, 2, 50), 5600)

    def test_plan_defense_fight_avoid_and_loss_escalation(self):
        pair = [invader(SMALL_MELEE), invader(SMALL_MELEE)]
        trio = [invader(SMALL_RANGED), invader(SMALL_RANGED), invader(SMALL_HEALER)]
        intel_map = {
            'W33S6': intel.build_entry('W33S6', objects_for(sources=1) + pair, USERS, TICK, MY_ID),
            'W32S7': intel.build_entry('W32S7', objects_for(sources=1) + trio, USERS, TICK, MY_ID),
            'W33S8': intel.build_entry('W33S8', objects_for(sources=2), USERS, TICK, MY_ID),
        }
        self.assertEqual(intel_map['W33S6']['hostileProfile']['count'], 2)
        self.assertIsNone(intel_map['W33S8']['hostileProfile'])
        orders = combat.plan_defense('W33S7', ['W33S6', 'W32S7', 'W33S8'], intel_map, 1800, TICK)
        self.assertEqual(orders['W33S6']['action'], 'fight')
        self.assertEqual(orders['W33S6']['squad']['count'], 1)
        self.assertEqual(orders['W33S6']['until'], TICK + 1400)
        self.assertNotIn('W33S8', orders)
        low = combat.plan_defense('W33S7', ['W32S7'], intel_map, 550, TICK)
        self.assertEqual((low['W32S7']['action'], low['W32S7']['reason']), ('avoid', 'unwinnable'))
        # 1 源外矿只剩 100 tick：价值 500，编组不值 → avoid
        soon = dict(intel_map)
        soon['W33S6'] = dict(intel_map['W33S6'], hostileProfile=dict(intel_map['W33S6']['hostileProfile'], until=TICK + 100))
        cheap = combat.plan_defense('W33S7', ['W33S6'], soon, 1800, TICK)
        self.assertEqual(cheap['W33S6']['action'], 'avoid')
        self.assertTrue(cheap['W33S6']['reason'].startswith('notWorth'))
        # 值不值按到场时算：收入 2/tick 时攒 910 能量要 455 tick + 孵化 42 + 走路 50，剩 1400 − 547 = 853 → 价值 4265 仍够；
        # 收入 0.5/tick 攒 1820 tick，到场时入侵者早没了 → avoid
        slow = combat.plan_defense('W33S7', ['W33S6'], intel_map, 1800, TICK, income=0.5, travel_rooms={'W33S6': 1})
        self.assertEqual(slow['W33S6']['action'], 'avoid')
        self.assertTrue(slow['W33S6']['reason'].startswith('notWorth'))
        self.assertGreater(slow['W33S6']['lead'], 1400)
        fast = combat.plan_defense('W33S7', ['W33S6'], intel_map, 1800, TICK, income=2, travel_rooms={'W33S6': 1})
        self.assertEqual(fast['W33S6']['action'], 'fight')
        self.assertEqual(fast['W33S6']['lead'], 455 + 42 + 50)
        # 近期在这房阵亡过：门槛抬高，编组要更强
        escalated = combat.plan_defense('W33S7', ['W33S6'], intel_map, 1800, TICK, last_loss={'room': 'W33S6', 'at': TICK - 100})
        self.assertEqual(escalated['W33S6']['action'], 'fight')
        self.assertGreater(escalated['W33S6']['squad']['total'], orders['W33S6']['squad']['total'])


class DirectiveTest(unittest.TestCase):
    def test_defense_orders_and_profile_travel_in_the_directive(self):
        pair = [invader(SMALL_MELEE), invader(SMALL_MELEE)]
        intel_map = {'W33S6': intel.build_entry('W33S6', objects_for(sources=1) + pair, USERS, TICK, MY_ID)}
        orders = combat.plan_defense('W33S7', ['W33S6'], intel_map, 1800, TICK)
        plans = {'W33S7': {'remotes': ['W33S6'], 'claim': None, 'defense': orders}}
        doc = directive.build(plans, intel_map, now_ms=1000)
        self.assertEqual(doc['rooms']['W33S7']['defense']['W33S6']['action'], 'fight')
        self.assertEqual(doc['intel']['W33S6']['hostileProfile']['count'], 2)
        encoded = json.loads(directive.encode(doc))
        self.assertEqual(encoded['rooms']['W33S7']['defense']['W33S6']['squad']['count'], 1)

    def test_build_and_encode(self):
        plans = {'W33S7': {'remotes': ['W34S7'], 'claim': {'room': 'W34S7', 'priority': 1}}}
        doc = directive.build(plans, neighborhood(), now_ms=1000)
        self.assertEqual(doc['version'], 1)
        self.assertEqual(doc['issuedAt'], 1000)
        self.assertEqual(doc['rooms']['W33S7']['remotes'], ['W34S7'])
        self.assertIn('W34S7', doc['intel'])
        self.assertNotIn('seenAt', doc['intel']['W34S7'])
        encoded = directive.encode(doc)
        self.assertLess(len(encoded), 100 * 1024)
        self.assertEqual(json.loads(encoded)['rooms']['W33S7']['claim']['room'], 'W34S7')

    def test_locks_override_plan(self):
        plans = {'W33S7': {'remotes': ['W34S7'], 'claim': {'room': 'W34S7', 'priority': 1}}}
        locks = {'W33S7.claim': {'value': None, 'until': 5000, 'by': 'agent'},
                 'W33S7.remotes': {'value': ['W33S8'], 'until': 500, 'by': 'agent'}}
        doc = directive.build(plans, {}, locks=locks, now_ms=1000)
        self.assertIsNone(doc['rooms']['W33S7']['claim'])
        self.assertEqual(doc['rooms']['W33S7']['remotes'], ['W34S7'], '过期的 lock 不生效')


class SegmentApi:
    """模拟引擎写回：前 clobber 次读回都返回旧内容"""

    def __init__(self, clobber):
        self.clobber = clobber
        self.writes = []
        self.stored = 'old'

    def set_segment(self, segment, data):
        self.writes.append(data)
        self.stored = 'old' if len(self.writes) <= self.clobber else data

    def get_segment(self, segment):
        return self.stored


class DirectiveWriteTest(unittest.TestCase):
    def test_rewrites_when_engine_clobbers(self):
        api = SegmentApi(clobber=2)
        size = directive.write(api, {'version': 1, 'issuedAt': 5, 'rooms': {}}, sleep=lambda _s: None)
        self.assertEqual(len(api.writes), 3)
        self.assertGreater(size, 0)

    def test_single_write_when_visible(self):
        api = SegmentApi(clobber=0)
        directive.write(api, {'version': 1, 'issuedAt': 5, 'rooms': {}}, sleep=lambda _s: None)
        self.assertEqual(len(api.writes), 1)

    def test_gives_up_after_retries(self):
        api = SegmentApi(clobber=99)
        with self.assertRaises(RuntimeError):
            directive.write(api, {'version': 1, 'issuedAt': 5, 'rooms': {}}, retries=3, sleep=lambda _s: None)


class FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class ApiTest(unittest.TestCase):
    def test_cached_get_and_throttle(self):
        calls = []
        sleeps = []

        def opener(req, timeout=0):
            calls.append(req.full_url)
            return FakeResponse({'ok': 1, 'objects': [], 'users': {}})

        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            api = ScreepsApi('http://x', 'tok', shard='shard1', cache_dir=tmp, min_interval=0.5,
                             sleep=sleeps.append, opener=opener)
            api.room_objects('W1N1')
            api.room_objects('W1N1')
            self.assertEqual(len(calls), 1, '同一房间 60s 内命中磁盘缓存')
            api.room_objects('W1N2')
            self.assertEqual(len(calls), 2)
            self.assertTrue(sleeps, '连续请求之间有限速等待')

    def test_error_payload_raises(self):
        def opener(req, timeout=0):
            return FakeResponse({'error': 'invalid room'})
        api = ScreepsApi('http://x', 'tok', sleep=lambda s: None, opener=opener, min_interval=0)
        with self.assertRaises(Exception):
            api.get('/api/game/room-objects', {'room': 'bad'})


if __name__ == '__main__':
    unittest.main()


class SpawnPosTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, 'test', 'fixtures', 'W34S7.json')) as handle:
            self.fixture = json.load(handle)

    def test_choose_spawn_pos_on_real_terrain(self):
        from brain import layout
        pos = layout.choose_spawn_pos(self.fixture['terrain'], self.fixture['objects'])
        self.assertIsNotNone(pos)
        self.assertTrue(4 <= pos['x'] <= 45 and 4 <= pos['y'] <= 45, pos)
        clearance = layout.wall_clearance(self.fixture['terrain'], pos['x'], pos['y'])
        self.assertGreaterEqual(clearance, 3, '选出的 spawn 位周围至少 3 格无墙')
        for obj in self.fixture['objects']:
            if obj['type'] in ('source', 'controller', 'mineral'):
                self.assertGreater(max(abs(obj['x'] - pos['x']), abs(obj['y'] - pos['y'])), 2, obj)
        again = layout.choose_spawn_pos(self.fixture['terrain'], self.fixture['objects'])
        self.assertEqual(pos, again, '选址是确定性的')

    def test_choose_spawn_pos_prefers_center_of_resources(self):
        from brain import layout
        pos = layout.choose_spawn_pos(self.fixture['terrain'], self.fixture['objects'])
        sources = [o for o in self.fixture['objects'] if o['type'] == 'source']
        ctrl = [o for o in self.fixture['objects'] if o['type'] == 'controller'][0]
        total = sum(max(abs(o['x'] - pos['x']), abs(o['y'] - pos['y'])) for o in sources + [ctrl])
        self.assertLess(total, 60, '到两个 source 与 controller 的距离和不应太大: %s' % total)

    def test_walls_in_fixture_are_avoided(self):
        from brain import layout
        walls = {(o['x'], o['y']) for o in self.fixture['objects'] if o['type'] == 'constructedWall'}
        pos = layout.choose_spawn_pos(self.fixture['terrain'], self.fixture['objects'])
        self.assertNotIn((pos['x'], pos['y']), walls)


class ClaimDirectiveTest(unittest.TestCase):
    def test_claim_carries_spawn_pos(self):
        plans = {'W33S7': {'remotes': [], 'claim': {'room': 'W34S7', 'priority': 1, 'spawnPos': {'x': 20, 'y': 25}}}}
        doc = directive.build(plans, {}, now_ms=1)
        self.assertEqual(doc['rooms']['W33S7']['claim']['spawnPos'], {'x': 20, 'y': 25})


class BriefTest(unittest.TestCase):
    def test_brief_reflects_locked_directive(self):
        from brain import brief
        state = {'generatedAt': 0, 'tick': 1, 'me': 'me', 'gcl': 12,
                 'homes': {'W33S7': {'level': 4, 'plan': {'remotes': [], 'claim': None,
                                                          'analysis': {'claim': {'blocked': 'bootstrapping:W34S7', 'ranked': []}, 'remotes': {'rejected': {}}}},
                                     'intel': {}}},
                 'directive': {'rooms': {'W33S7': {'remotes': ['W32S7'], 'claim': {'room': 'W34S7', 'spawnPos': {'x': 27, 'y': 18}, 'plan': {'version': 'x'}}}},
                               'locks': {'W33S7.claim': {'by': 'agent', 'until': 9e15}}},
                 'wrote': 'x'}
        text = brief.render(state)
        self.assertIn('占领目标：W34S7', text)
        self.assertIn('locks 覆盖', text)
        self.assertIn('bootstrapping:W34S7', text)
        self.assertIn('外矿分配：W32S7', text)



class CollectOwnerTest(unittest.TestCase):
    def test_reserved_room_is_not_owned(self):
        """map-stats 对我方预定的房间也返回 own.user（level 0），不能当成我方拥有的房"""
        class Api:
            def time(self):
                return 100

            def map_stats(self, rooms):
                return {'stats': {'W32S7': {'own': {'user': 'u1', 'level': 0}},
                                  'W34S7': {'own': {'user': 'u1', 'level': 1}}},
                        'users': {'u1': {'username': 'me'}}}

            def room_objects(self, name):
                ctrl = {'type': 'controller', 'x': 10, 'y': 10, 'room': name, '_id': 'c' + name}
                if name == 'W32S7':
                    ctrl['reservation'] = {'user': 'u1', 'endTime': 1000}
                else:
                    ctrl['user'] = 'u1'
                    ctrl['level'] = 1
                return {'objects': [ctrl], 'users': {'u1': {'username': 'me'}}}

        got = intel.collect(Api(), ['W33S7'], radius=1, my_user_id='u1', tick=100)
        self.assertIsNone(got['W32S7']['owner'])
        self.assertEqual(got['W32S7']['reservation']['username'], 'me')
        self.assertEqual(got['W34S7']['owner'], 'me')

    def test_collect_includes_homes_themselves(self):
        """母房自身也要进情报：没有 spawn 的新母房才能被识别为开荒中，不会给它规划新占领"""
        class Api:
            def time(self):
                return 100

            def map_stats(self, rooms):
                return {'stats': {r: {'own': {'user': 'u1', 'level': 1}} for r in ('W33S7', 'W34S7')},
                        'users': {'u1': {'username': 'me'}}}

            def room_objects(self, name):
                objs = [{'type': 'controller', 'x': 10, 'y': 10, 'room': name, '_id': 'c' + name}]
                if name in ('W33S7', 'W34S7'):
                    objs[0].update({'user': 'u1', 'level': 1})
                if name == 'W33S7':
                    objs.append({'type': 'spawn', 'x': 20, 'y': 20, 'room': name, '_id': 's1', 'user': 'u1'})
                return {'objects': objs, 'users': {'u1': {'username': 'me'}}}

        got = intel.collect(Api(), ['W33S7', 'W34S7'], radius=1, my_user_id='u1', tick=100)
        self.assertIn('W33S7', got)
        self.assertIn('W34S7', got)
        self.assertEqual(plan.bootstrapping_rooms(got, 'me'), ['W34S7'])
        home_plan = plan.plan_home('W34S7', got, 'me', 1, 12, ['W33S7', 'W34S7'], tick=100)
        self.assertIsNone(home_plan['claim'])
        self.assertEqual(home_plan['analysis']['claim']['blocked'], 'bootstrapping:W34S7')


class AssignRemotesTest(unittest.TestCase):
    """同一外矿只能归一个母房：两个母房各派 reserver/miner 是 2026-09-04 14:48 线上 7 个 reserver（W33S8 两个）的根因"""

    @staticmethod
    def _plans():
        return {
            'W33S7': {'remotes': ['W33S8', 'W35S7', 'W32S7'], 'claim': None,
                      'analysis': {'remotes': {'ranked': [{'room': 'W33S8', 'score': 12.0}, {'room': 'W35S7', 'score': -2.0},
                                                          {'room': 'W32S7', 'score': -6.0}, {'room': 'W31S6', 'score': -8.0}],
                                               'maxRooms': 3}}},
            'W34S7': {'remotes': ['W35S7', 'W33S8'], 'claim': None,
                      'analysis': {'remotes': {'ranked': [{'room': 'W35S7', 'score': 12.0}, {'room': 'W33S8', 'score': 12.0},
                                                          {'room': 'W34S8', 'score': 2.0}],
                                               'maxRooms': 2}}},
        }

    def test_remote_follows_its_drop_home(self):
        # 同分时 RCL 高的 W33S7 本来会赢 W33S8；但这条外矿的能量卸在 W34S7（游戏内 record.drop），归属跟着能量走
        plans = plan.assign_remotes(self._plans(), {'W33S7': 5, 'W34S7': 4}, prefer={'W33S8': 'W34S7'})
        self.assertIn('W33S8', plans['W34S7']['remotes'], '卸货房是 W34S7 的外矿归 W34S7')
        self.assertNotIn('W33S8', plans['W33S7']['remotes'])

    def test_drop_preferences_come_from_enabled_records_only(self):
        memory_rooms = {
            'W33S7': {'remotes': {'W32S6': {'enabled': True, 'drop': {'room': 'W32S4'}},
                                  'W33S6': {'enabled': True, 'drop': {'room': 'W33S7'}},
                                  'W33S5': {'enabled': False, 'drop': {'room': 'W32S4'}}}},
            'W32S4': {'remotes': {}},
        }
        self.assertEqual(plan.drop_preferences(memory_rooms, ['W33S7', 'W32S4']), {'W32S6': 'W32S4'},
                         '只收启用中的、卸货房是另一个母房的记录（改派后原记录停用，偏好消失、不来回翻）')
        # 卸货房 storage 富余：不跟过去（W32S4 的 W32S3/W32S2 卸在 34 万 storage 的 W33S3，那是要纠正的错配）
        memory_rooms['W32S4']['storageRich'] = {'on': True}
        self.assertEqual(plan.drop_preferences(memory_rooms, ['W33S7', 'W32S4']), {}, '卸货房 storage 富余时不采用偏好')
        memory_rooms['W32S4'] = {'remotes': {}, 'remoteSpawnCapped': True}
        self.assertEqual(plan.drop_preferences(memory_rooms, ['W33S7', 'W32S4']), {}, '卸货房开了外矿孵化时间上限时不采用偏好')

    def test_unstaffed_remote_is_not_current(self):
        records = {'W32S6': {'enabled': True, 'staffed': False}, 'W33S6': {'enabled': True, 'staffed': True},
                   'W32S7': {'enabled': True}}
        self.assertEqual(plan.current_remote_names(records, tick=1), ['W32S7', 'W33S6'],
                         '游戏内编制预算裁掉的外矿（staffed False）不算在用，不拿粘性加分')

    def test_contested_room_goes_to_best_scoring_home(self):
        plans = plan.assign_remotes(self._plans(), {'W33S7': 5, 'W34S7': 4})
        self.assertIn('W35S7', plans['W34S7']['remotes'], '相邻的 W34S7 得分高，W35S7 归它')
        self.assertNotIn('W35S7', plans['W33S7']['remotes'], '两跳外的 W33S7 不再同时派 reserver/miner 去 W35S7')

    def test_tie_goes_to_higher_level_home_and_loser_backfills(self):
        plans = plan.assign_remotes(self._plans(), {'W33S7': 5, 'W34S7': 4})
        self.assertEqual(plans['W33S7']['remotes'], ['W33S8', 'W32S7', 'W31S6'], '同分 W33S8 归 RCL 高的 W33S7；落选的 W35S7 用下一个候选补位')
        self.assertEqual(plans['W34S7']['remotes'], ['W35S7', 'W34S8'], '落选的 W33S8 用下一个候选 W34S8 补位')
        self.assertEqual(plans['W34S7']['analysis']['remotes']['takenBy'], {'W33S8': 'W33S7'})
        self.assertEqual(plans['W33S7']['analysis']['remotes']['takenBy'], {'W35S7': 'W34S7'})

    def test_respects_max_rooms(self):
        plans = self._plans()
        plans['W34S7']['analysis']['remotes']['maxRooms'] = 1
        out = plan.assign_remotes(plans, {'W33S7': 5, 'W34S7': 4})
        self.assertEqual(out['W34S7']['remotes'], ['W35S7'])
        self.assertEqual(out['W33S7']['remotes'], ['W33S8', 'W32S7', 'W31S6'])

    def test_single_home_or_no_overlap_unchanged(self):
        plans = self._plans()
        del plans['W34S7']
        out = plan.assign_remotes(plans, {'W33S7': 5})
        self.assertEqual(out['W33S7']['remotes'], ['W33S8', 'W35S7', 'W32S7'])
        self.assertEqual(out['W33S7']['analysis']['remotes'].get('takenBy'), {})

    def test_double_source_remote_skips_a_home_that_cannot_afford_it(self):
        """2026-09-06 线上：W31S8（双源）离 W33S8 2 跳、离 W33S7 3 跳，但 W33S8 容量 800 养不起 2 CLAIM 的 reserver 和大 hauler"""
        def plans(near_capacity):
            return {
                'W33S8': {'remotes': ['W31S8'], 'claim': None, 'capacity': near_capacity,
                          'analysis': {'remotes': {'ranked': [{'room': 'W31S8', 'score': -2.0, 'sources': 2},
                                                              {'room': 'W31S7', 'score': -12.0, 'sources': 1}], 'maxRooms': 2}}},
                'W33S7': {'remotes': ['W31S8'], 'claim': None, 'capacity': 1800,
                          'analysis': {'remotes': {'ranked': [{'room': 'W31S8', 'score': -10.0, 'sources': 2}], 'maxRooms': 4}}},
            }
        out = plan.assign_remotes(plans(800), {'W33S8': 4, 'W33S7': 5})
        self.assertEqual(out['W33S7']['remotes'], ['W31S8'], '近的养不起：双源外矿退给远但养得起的 W33S7')
        self.assertEqual(out['W33S8']['remotes'], ['W31S7'], '养不起的母房用单源候选补位')
        self.assertEqual(out['W33S8']['analysis']['remotes']['takenBy'], {'W31S8': 'W33S7'})
        out = plan.assign_remotes(plans(1300), {'W33S8': 4, 'W33S7': 5})
        self.assertEqual(out['W33S8']['remotes'], ['W31S8', 'W31S7'], '容量到 1300 后路程最短的 W33S8 拿回 W31S8')
        self.assertEqual(out['W33S7']['remotes'], [])
        # 谁都养不起时仍归分数最高的，而不是没人开
        starved = plans(800)
        starved['W33S7']['capacity'] = 800
        out = plan.assign_remotes(starved, {'W33S8': 4, 'W33S7': 5})
        self.assertEqual(out['W33S8']['remotes'], ['W31S8', 'W31S7'])


class ReplanRemotesTest(unittest.TestCase):
    """占领目标要全账号排除：plan_home 只排除本母房自己的占领目标，别的母房会把它当外矿收进来"""

    def test_other_homes_do_not_take_a_claim_target_as_remote(self):
        data = neighborhood()
        plans = {
            'W33S7': plan.plan_home('W33S7', data, ME, 6, 12, ['W33S7', 'W33S8'], tick=TICK, prefer_claim='W34S7'),
            'W33S8': plan.plan_home('W33S8', data, ME, 4, 12, ['W33S7', 'W33S8'], tick=TICK),
        }
        self.assertEqual(plans['W33S7']['claim']['room'], 'W34S7')
        levels = {'W33S7': 6, 'W33S8': 4}
        plan.replan_remotes(plans, data, ME, levels, ['W33S7', 'W33S8'], {'W34S7'}, tick=TICK)
        for home in plans:
            self.assertNotIn('W34S7', plans[home]['remotes'], home + ' 不把别家的占领目标当外矿')
            self.assertEqual(plans[home]['analysis']['remotes']['rejected'].get('W34S7'), 'excluded')
        self.assertIn('sources', plans['W33S7']['analysis']['remotes']['ranked'][0], 'ranked 带源数供容量判断')


class WriteGateTest(unittest.TestCase):
    """情报不完整的一轮不能写指令：2026-09-04 15:13 本机断网，room-objects 全部失败 → 写入 remotes=[] →
    游戏内全部外矿 notWhitelisted，7 个 reserver 与全部远程 creep 退役，6 分钟后白名单恢复再全部重孵。"""

    @staticmethod
    def _api(fail=(), home_level=5):
        class Api:
            def __init__(self):
                self.calls = 0
                self.segments = []

            def me(self):
                return {'_id': MY_ID, 'username': ME, 'gcl': 3e8}

            def time(self):
                return TICK

            def memory(self, path):
                return {}

            def map_stats(self, rooms):
                return {'stats': {}, 'users': USERS}

            def room_objects(self, room, ttl_s=60):
                self.calls += 1
                if room in fail:
                    raise RuntimeError('<urlopen error [Errno 51] Network is unreachable>')
                if room == 'W33S7':
                    objs = objects_for(sources=2, owner=MY_ID, level=home_level) + \
                        [{'_id': 'sp', 'type': 'spawn', 'x': 23, 'y': 21, 'user': MY_ID}]
                else:
                    objs = objects_for(sources=1)
                return {'objects': objs, 'users': USERS}

            def set_segment(self, segment, data):
                self.segments.append(data)

            def get_segment(self, segment):
                return self.segments[-1] if self.segments else ''
        return Api()

    @staticmethod
    def _run(api):
        import tempfile
        from unittest import mock
        from brain import run as run_module

        def fake_write(api_, doc, *args, **kwargs):
            data = run_module.directive.encode(doc)
            api_.set_segment(run_module.directive.SEGMENT, data)
            return len(data)

        with tempfile.TemporaryDirectory() as out:
            args = run_module.parse_args(['--homes', 'W33S7', '--radius', '1', '--write', '--out', out])
            with mock.patch.object(run_module.directive, 'write', fake_write):
                return run_module.run(args, api=api)

    def test_api_failure_blocks_write(self):
        api = self._api(fail=('W33S6',))
        state = self._run(api)
        self.assertEqual(api.segments, [], '有房拉取失败就不写 segment')
        self.assertTrue(state['wrote'].startswith('未写入'), state['wrote'])
        self.assertIn('W33S6', state['wrote'])
        self.assertEqual([b.split(':')[0] for b in state['blockers']], ['intel'])

    def test_home_level_zero_blocks_write(self):
        api = self._api(home_level=0)
        state = self._run(api)
        self.assertEqual(api.segments, [])
        self.assertIn('level:W33S7', state['blockers'])

    def test_clean_round_writes(self):
        api = self._api()
        state = self._run(api)
        self.assertEqual(len(api.segments), 1)
        self.assertTrue(state['wrote'].startswith('segment'), state['wrote'])
        self.assertEqual(state['blockers'], [])
        self.assertTrue(json.loads(api.segments[0])['rooms']['W33S7']['remotes'], '正常一轮的白名单非空')


class SafeModeTest(unittest.TestCase):
    def entry(self, dps=150, heal=0, owners=('Invader',), boosted=False, towers=0, tower_energy=0, safe_mode=False, charges=1, armed=1):
        return {'armedHostiles': armed, 'hostileProfile': {'dps': dps, 'heal': heal, 'boosted': boosted, 'hits': 1000, 'count': armed},
                'hostileOwners': list(owners), 'structures': {'spawn': 1, 'tower': towers}, 'towerEnergy': tower_energy,
                'safeMode': safe_mode, 'safeModeAvailable': charges}

    def test_holds_without_threat_charge_or_when_already_on(self):
        self.assertEqual(safemode.decide('W1N1', self.entry(armed=0), [], 10)['reason'], 'no-threat')
        self.assertEqual(safemode.decide('W1N1', self.entry(safe_mode=True), [], 10)['reason'], 'already-on')
        self.assertEqual(safemode.decide('W1N1', self.entry(charges=0), [], 10)['reason'], 'no-charge')
        # 同一账号同时只能有一房开盾：别房开着时本房开不了（ERR_BUSY），给 hold busy:<房>
        self.assertEqual(safemode.decide('W1N1', self.entry(), [], 10, busy='W2N1')['reason'], 'busy:W2N1')
        intel_busy = {'W1N1': self.entry(), 'W2N1': self.entry(armed=0, safe_mode=True), 'W3N1': self.entry(armed=0)}
        self.assertEqual(safemode.safe_mode_busy('W1N1', intel_busy, ['W1N1', 'W2N1', 'W3N1']), 'W2N1')
        self.assertIsNone(safemode.safe_mode_busy('W1N1', {'W1N1': self.entry(), 'W3N1': self.entry(armed=0)}, ['W1N1', 'W3N1']))
        self.assertEqual(safemode.decide_all(intel_busy, ['W1N1', 'W2N1', 'W3N1'], 10)['W1N1']['reason'], 'busy:W2N1')

    def test_towers_with_energy_hold_unless_outhealed(self):
        held = safemode.decide('W1N1', self.entry(towers=1, tower_energy=800), [], 10)
        self.assertEqual((held['action'], held['reason']), ('hold', 'towers'))
        outhealed = safemode.decide('W1N1', self.entry(heal=400, towers=1, tower_energy=800), [], 10)
        self.assertEqual(outhealed['action'], 'activate')   # 没有别的母房：治疗压过塔就得开

    def test_weak_hostiles_go_to_defenders(self):
        self.assertEqual(safemode.decide('W1N1', self.entry(dps=20), [], 10)['reason'], 'weak')
        # 玩家 1 个 ATTACK 的侦察兵（30 < 60）也不值得
        self.assertEqual(safemode.decide('W1N1', self.entry(dps=30, owners=('Someone',)), [], 10)['reason'], 'weak')

    def test_lone_room_activates_and_help_timing_decides_otherwise(self):
        lone = safemode.decide('W1N1', self.entry(dps=150), [], 10)
        self.assertEqual((lone['action'], lone['reason']), ('activate', 'no-help'))
        late = safemode.decide('W1N1', self.entry(dps=150), [{'room': 'W2N1', 'hops': 1}], 10)
        self.assertEqual((late['action'], late['reason'], late['eta']), ('activate', 'help-too-late', 110))
        in_time = safemode.decide('W1N1', self.entry(dps=30), [{'room': 'W2N1', 'hops': 1}], 10)
        self.assertEqual((in_time['action'], in_time['reason']), ('hold', 'help-in-time'))   # 30 × 110 = 3300 < 4000
        self.assertEqual(in_time['atTick'], 10)

    def test_boosted_player_always_activates(self):
        boosted = safemode.decide('W1N1', self.entry(dps=90, owners=('Someone',), boosted=True), [{'room': 'W2N1', 'hops': 1}], 10)
        self.assertEqual((boosted['action'], boosted['reason']), ('activate', 'boosted-player'))

    def test_helpers_need_a_spawn_and_sort_by_distance(self):
        intel_map = {'W1N1': {'structures': {'spawn': 1}}, 'W3N1': {'structures': {'spawn': 1}}, 'W2N1': {'structures': {'spawn': 1}},
                     'W1N5': {'structures': {}}}
        helpers = safemode.helpers_for('W1N1', intel_map, ['W1N1', 'W3N1', 'W2N1', 'W1N5'])
        self.assertEqual([h['room'] for h in helpers], ['W2N1', 'W3N1'])
        decisions = safemode.decide_all({'W1N1': self.entry(), 'W2N1': {'error': 'boom'}}, ['W1N1', 'W2N1'], 10)
        self.assertEqual(list(decisions), ['W1N1'])


class GuardTest(unittest.TestCase):
    def test_patch_only_touches_safe_mode_and_bumps_issued_at(self):
        doc = {'version': 1, 'issuedAt': 100, 'ttlMs': 5, 'rooms': {'W1N1': {'remotes': ['W2N1'], 'safeMode': {'action': 'hold', 'reason': 'no-threat'}}}}
        same, changed = guard.patch_directive(dict(doc, rooms={'W1N1': dict(doc['rooms']['W1N1'])}), {'W1N1': {'action': 'hold', 'reason': 'no-threat'}}, now_ms=200)
        self.assertFalse(changed)
        self.assertEqual(same['issuedAt'], 100)
        patched, changed = guard.patch_directive(doc, {'W1N1': {'action': 'activate', 'reason': 'no-help', 'atTick': 5}}, now_ms=200)
        self.assertTrue(changed)
        self.assertEqual(patched['issuedAt'], 200)
        self.assertEqual(patched['rooms']['W1N1']['remotes'], ['W2N1'])
        self.assertEqual(patched['rooms']['W1N1']['safeMode']['reason'], 'no-help')
        # activate 每次都重写（刷新 atTick）
        again, changed = guard.patch_directive(patched, {'W1N1': {'action': 'activate', 'reason': 'no-help', 'atTick': 9}}, now_ms=300)
        self.assertTrue(changed)
        self.assertEqual(again['rooms']['W1N1']['safeMode']['atTick'], 9)
        untouched, changed = guard.patch_directive({'version': 1}, {'W1N1': {'action': 'activate'}}, now_ms=1)
        self.assertFalse(changed)


class CollectWithoutMapStatsTest(unittest.TestCase):
    def test_guard_path_skips_map_stats(self):
        class FakeApi:
            calls = 0
            def time(self):
                return 500
            def map_stats(self, rooms):
                raise AssertionError('map-stats must not be called with map_stats=False')
            def room_objects(self, room, ttl_s=60):
                return {'objects': [{'_id': 'c', 'type': 'controller', 'x': 10, 'y': 10, 'user': 'me', 'level': 4, 'safeModeAvailable': 2}],
                        'users': {'me': {'username': 'Me'}}}
            def room_terrain(self, room):
                return None
        got = intel.collect(FakeApi(), ['W1N1'], 0, my_user_id='me', tick=500, map_stats=False)
        self.assertEqual(got['W1N1']['owner'], 'Me')
        self.assertEqual(got['W1N1']['safeModeAvailable'], 2)


class ClaimQueueTest(unittest.TestCase):
    """用户点名的占领清单（locks.json 的 claim.queue）：有主的房等它无主，无主的分给最近的够格母房。"""

    def owned_entry(self, room, level, spawn=True):
        objs = objects_for(sources=2, owner=MY_ID, level=level)
        if spawn:
            objs.append({'_id': 'sp-' + room, 'type': 'spawn', 'x': 24, 'y': 36, 'user': MY_ID})
        return intel.build_entry(room, objs, USERS, TICK, MY_ID)

    def world(self):
        data = {
            'W33S7': self.owned_entry('W33S7', 5),
            'W34S7': self.owned_entry('W34S7', 4),
            'W31S6': self.owned_entry('W31S6', 3),
            'W33S3': intel.build_entry('W33S3', objects_for(sources=2, mineral='H'), USERS, TICK, MY_ID),
            'W31S5': intel.build_entry('W31S5', objects_for(sources=2, mineral='O'), USERS, TICK, MY_ID),
            'W32S4': intel.build_entry('W32S4', objects_for(sources=2, owner='9', level=5), USERS, TICK, MY_ID),
            'W31S4': intel.build_entry('W31S4', objects_for(sources=2, owner='9', level=4), USERS, TICK, MY_ID),
        }
        for corridor in ('W33S6', 'W33S5', 'W33S4', 'W32S6', 'W32S7', 'W31S7'):
            data[corridor] = intel.build_entry(corridor, objects_for(sources=1), USERS, TICK, MY_ID)
        return data

    def plans(self, auto=None):
        plans = {home: {'remotes': [], 'claim': None, 'analysis': {'claim': {'blocked': None}}}
                 for home in ('W33S7', 'W34S7', 'W31S6')}
        if auto:
            plans['W34S7']['claim'] = {'room': auto, 'priority': 1}
        return plans

    LEVELS = {'W33S7': 5, 'W34S7': 4, 'W31S6': 3}
    OWNED = ['W33S7', 'W34S7', 'W31S6']
    QUEUE = ['W33S3', 'W32S4', 'W31S4', 'W31S5']

    def test_assigns_nearest_capable_sponsor_and_waits_for_owned_rooms(self):
        plans = self.plans(auto='W35S8')
        status = plan.assign_claim_queue(plans, self.QUEUE, self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK)
        self.assertEqual(status['W33S3'], {'status': 'claim', 'sponsor': 'W33S7', 'hops': 4, 'travel': 200})
        self.assertEqual(plans['W33S7']['claim'], {'room': 'W33S3', 'priority': 1})
        self.assertEqual(status['W32S4']['status'], 'wait:owner:bigplayer')
        self.assertEqual(status['W31S4']['status'], 'wait:owner:bigplayer')
        # W31S6 相邻但 RCL3 孵不出 claimer，W33S7 已经接了 W33S3：W34S7 5 跳（没有地形数据按每房 50 tick 估 = 250 ≤ 600）接下
        self.assertEqual(status['W31S5'], {'status': 'claim', 'sponsor': 'W34S7', 'hops': 5, 'travel': 250})
        self.assertEqual(plans['W34S7']['claim'], {'room': 'W31S5', 'priority': 1})
        # 清单未完成期间，脚本自己排的占领目标一律让路
        self.assertIsNone(plans['W31S6']['claim'])
        tight = plan.assign_claim_queue(self.plans(auto='W35S8'), self.QUEUE, self.world(), ME, self.LEVELS, self.OWNED, 12,
                                        tick=TICK, cfg={'claimTravelTicks': 200})
        self.assertEqual(tight['W31S5']['status'], 'noSponsor', 'claimer 寿命内走不到就没人接')
        self.assertEqual(tight['W33S3']['sponsor'], 'W33S7', '刚好 200 tick 走得到的仍接')

    def test_pending_queue_clears_automatic_claims(self):
        plans = self.plans(auto='W35S8')
        plan.assign_claim_queue(plans, ['W32S4'], self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK)
        self.assertIsNone(plans['W34S7']['claim'])
        self.assertEqual(plans['W34S7']['analysis']['claim']['blocked'], 'claimQueue')

    def test_sponsor_still_bootstrapping_takes_no_new_target(self):
        data = self.world()
        data['W33S3'] = self.owned_entry('W33S3', 1, spawn=False)
        owned = self.OWNED + ['W33S3']
        status = plan.assign_claim_queue(self.plans(), self.QUEUE, data, ME, self.LEVELS, owned, 12, tick=TICK,
                                         sponsoring={'W33S7': 'W33S3'})
        self.assertEqual(status['W33S3'], {'status': 'bootstrapping', 'sponsor': 'W33S7', 'hops': 4})
        self.assertEqual(status['W31S5']['sponsor'], 'W34S7', 'W33S7 还在开荒 W33S3，只剩 W34S7 能接')
        # 没有母房记着它（孤儿房）：游戏内由最近的母房接手，这里同样把最近的够格母房算作占用
        orphan = plan.assign_claim_queue(self.plans(), self.QUEUE, data, ME, self.LEVELS, owned, 12, tick=TICK)
        self.assertEqual(orphan['W33S3']['sponsor'], 'W33S7')
        self.assertEqual(orphan['W31S5']['sponsor'], 'W34S7')

    def test_gcl_headroom_and_locked_homes(self):
        plans = self.plans()
        status = plan.assign_claim_queue(plans, ['W33S3'], self.world(), ME, self.LEVELS, self.OWNED, 3, tick=TICK)
        self.assertEqual(status['W33S3']['status'], 'gcl')
        self.assertIsNone(plans['W33S7']['claim'])
        plans = self.plans()
        plans['W33S7']['claim'] = {'room': 'W32S7', 'priority': 1}
        status = plan.assign_claim_queue(plans, ['W33S3'], self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK,
                                         locked_homes={'W33S7'})
        self.assertEqual(status['W33S3']['sponsor'], 'W34S7', '带锁的 W33S7 跳过，5 跳的 W34S7 接')
        self.assertEqual(plans['W33S7']['claim']['room'], 'W32S7', '母房自己的 claim 锁不被清单覆盖')

    def test_finished_queue_releases_automatic_claims(self):
        plans = self.plans(auto='W35S8')
        status = plan.assign_claim_queue(plans, ['W31S6'], self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK)
        self.assertEqual(status['W31S6']['status'], 'owned')
        self.assertEqual(plans['W34S7']['claim']['room'], 'W35S8')
        self.assertEqual(plan.assign_claim_queue(plans, [], self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK), {})

    def test_second_sponsor_takes_the_next_room(self):
        data = self.world()
        data['W34S8'] = intel.build_entry('W34S8', objects_for(sources=2), USERS, TICK, MY_ID)
        plans = self.plans()
        status = plan.assign_claim_queue(plans, ['W33S3', 'W34S8'], data, ME, self.LEVELS, self.OWNED, 12, tick=TICK)
        self.assertEqual(status['W33S3']['sponsor'], 'W33S7')
        self.assertEqual(status['W34S8'], {'status': 'claim', 'sponsor': 'W34S7', 'hops': 1, 'travel': 50})
        self.assertEqual(plans['W34S7']['claim'], {'room': 'W34S8', 'priority': 1})

    def test_sponsor_eligibility_by_capacity_when_known(self):
        # RCL3 的 W31S6 建了 9 个 extension（容量 750 ≥ claimer 650）：给出容量时它能接相邻的 W31S5；RCL4 但容量只有 550 的 W34S7 不能
        plans = self.plans()
        capacities = {'W33S7': 1800, 'W34S7': 550, 'W31S6': 750}
        status = plan.assign_claim_queue(plans, ['W31S5', 'W33S3'], self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK,
                                         capacities=capacities)
        self.assertEqual(status['W31S5'], {'status': 'claim', 'sponsor': 'W31S6', 'hops': 1, 'travel': 50})
        self.assertEqual(status['W33S3'], {'status': 'claim', 'sponsor': 'W33S7', 'hops': 4, 'travel': 200})
        self.assertEqual(plans['W31S6']['claim'], {'room': 'W31S5', 'priority': 1})
        low = plan.assign_claim_queue(self.plans(), ['W31S5'], self.world(), ME, self.LEVELS, self.OWNED, 12, tick=TICK,
                                      capacities={'W33S7': 1800, 'W34S7': 550, 'W31S6': 550})
        self.assertEqual(low['W31S5']['sponsor'], 'W33S7', '容量 550 的房孵不出 claimer，退给 4 跳的 W33S7')

    def test_travel_ticks_uses_terrain(self):
        # 有地形时按真实格数估：W33S7 spawn (25,25) 往北 4 房到 W33S3 的 controller (25,25) 旁，全平地约 195 tick；
        # 走廊 W33S5 全沼泽（5 tick/格）多花约 200 tick；上限压到 300 就没人接
        data = self.world()
        plain = '0' * 2500
        for room in data:
            data[room]['terrain'] = plain
        for room in ('W33S7', 'W34S7', 'W31S6'):
            data[room]['spawnPos'] = {'x': 25, 'y': 25}
        travel = plan.travel_ticks('W33S7', 'W33S3', data, ME, 600)
        self.assertTrue(150 <= travel <= 260, travel)
        self.assertIsNone(plan.travel_ticks('W33S7', 'W33S3', data, ME, 100), '超过上限返回 None')
        data['W33S5']['terrain'] = '2' * 2500
        swampy = plan.travel_ticks('W33S7', 'W33S3', data, ME, 600)
        self.assertTrue(swampy > travel + 150, (travel, swampy))
        status = plan.assign_claim_queue(self.plans(), ['W33S3'], data, ME, self.LEVELS, self.OWNED, 12, tick=TICK)
        self.assertEqual(status['W33S3']['sponsor'], 'W33S7')
        self.assertEqual(status['W33S3']['travel'], swampy)
        tight = plan.assign_claim_queue(self.plans(), ['W33S3'], data, ME, self.LEVELS, self.OWNED, 12, tick=TICK,
                                        cfg={'claimTravelTicks': 300})
        self.assertEqual(tight['W33S3']['status'], 'noSponsor')
        # 墙封死的走廊走不通
        data['W33S5']['terrain'] = '1' * 2500
        self.assertIsNone(plan.travel_ticks('W33S7', 'W33S3', data, ME, 600))

    def test_queue_lock_parsing_and_intel_rooms(self):
        now = 1_000_000
        self.assertEqual(plan.active_claim_queue({'claim.queue': {'value': ['W33S3', 'W31S5'], 'until': now + 1}}, now),
                         ['W33S3', 'W31S5'])
        self.assertEqual(plan.active_claim_queue({'claim.queue': {'value': ['W33S3'], 'until': now - 1}}, now), [])
        self.assertEqual(plan.active_claim_queue({'claim.queue': {'value': 'W33S3', 'until': now + 1}}, now), [])
        self.assertEqual(plan.active_claim_queue({}, now), [])
        rooms = plan.claim_queue_intel_rooms(['W33S3'])
        self.assertEqual(rooms[0], 'W33S3')
        self.assertEqual(sorted(rooms), sorted(['W33S3'] + intel.ring_rooms('W33S3', 1)))

    def test_collect_pulls_extra_rooms(self):
        seen = []

        class FakeApi:
            def time(self):
                return 500

            def room_objects(self, room, ttl_s=60):
                seen.append(room)
                return {'objects': [{'_id': 'c', 'type': 'controller', 'x': 10, 'y': 10}], 'users': {}}

            def room_terrain(self, room):
                return None
        got = intel.collect(FakeApi(), ['W1N1'], 0, my_user_id='me', tick=500, map_stats=False,
                            extra_rooms=['W5N5', 'W1N1'])
        self.assertEqual(seen, ['W1N1', 'W5N5'])
        self.assertIn('W5N5', got)

    def test_brief_lists_the_queue(self):
        state = {'generatedAt': 0, 'tick': 1, 'me': ME, 'gcl': 12, 'homes': {}, 'wrote': 'x',
                 'claimQueue': {'W33S3': {'status': 'claim', 'sponsor': 'W33S7', 'hops': 4},
                                'W32S4': {'status': 'wait:owner:bigplayer', 'sponsor': None, 'hops': None}}}
        text = brief.render(state)
        self.assertIn('W33S3', text)
        self.assertIn('wait:owner:bigplayer', text)

class BoundaryTest(unittest.TestCase):
    def test_status_filters_routes_and_candidates(self):
        home = {'roomStatus': 'respawn', 'owner': ME, 'structures': {'spawn': 1}}
        goal = {'roomStatus': 'normal', 'sources': 2, 'class': 'normal'}
        rooms = {'W31S8': home, 'W30S8': goal}
        self.assertIsNone(plan.route_hops('W31S8', 'W30S8', rooms, ME, 3))
        self.assertIsNone(plan.travel_ticks('W31S8', 'W30S8', rooms, ME, 600))
        self.assertEqual(plan.usable_for_claim(goal, ME, plan.DEFAULTS, TICK, home), 'roomStatus')
        goal['roomStatus'] = 'respawn'
        self.assertEqual(plan.route_hops('W31S8', 'W30S8', rooms, ME, 3), 1)
        goal['roomStatus'] = 'closed'
        self.assertIsNone(plan.route_hops('W31S8', 'W30S8', rooms, ME, 3))

    def test_highway_corridor_in_respawn_area(self):
        # 我方在 respawn 区：W31S9 只能经分界线上的 highway W30S9（normal、带墙）进出。
        # 走廊放宽到 highway，目标房仍严格：墙内的 respawn 目标可达，墙外的 normal 目标仍被拒
        home = {'roomStatus': 'respawn', 'owner': ME, 'structures': {'spawn': 1}, 'exits': {'1': 'W31S7', '3': 'W30S8'}}
        corridor = {'roomStatus': 'normal', 'class': 'highway'}
        target = {'roomStatus': 'respawn', 'sources': 1, 'class': 'normal'}
        rooms = {'W31S8': home, 'W30S8': dict(corridor), 'W30S9': dict(corridor), 'W31S9': target}
        # W31S8 → W30S8 → W30S9 → W31S9：3 跳（W31S8 的 S 边与 W31S9 的 N 边都是墙，不直接相连）
        orig_connected = plan.connected
        plan.connected = lambda a, ae, b, be: not ({a, b} == {'W31S8', 'W31S9'})
        try:
            self.assertEqual(plan.route_hops('W31S8', 'W31S9', rooms, ME, 3), 3)
            rooms['W30S9']['class'] = 'normal'   # 不是 highway 的 normal 房照旧挡住
            rooms['W30S8']['class'] = 'normal'
            self.assertIsNone(plan.route_hops('W31S8', 'W31S9', rooms, ME, 3))
            rooms['W30S9']['class'] = 'highway'
            rooms['W30S8']['class'] = 'highway'
            rooms['W29S9'] = {'roomStatus': 'normal', 'sources': 2, 'class': 'normal'}   # 墙外目标
            self.assertIsNone(plan.route_hops('W31S8', 'W29S9', rooms, ME, 4))
        finally:
            plan.connected = orig_connected

    def test_collect_masks_constructed_walls_and_status(self):
        class Api:
            def map_stats(self, rooms):
                return {'stats': {r: {'status': 'normal', 'respawnArea': 9999999999999} for r in rooms}}
            def room_objects(self, room):
                return {'objects': [{'_id': str(y), 'type': 'constructedWall', 'x': 23, 'y': y} for y in range(50)]}
            def room_terrain(self, room):
                return '0' * 2500
        entry = intel.collect(Api(), ['W30S9'], 0, tick=TICK)['W30S9']
        self.assertEqual(entry['roomStatus'], 'respawn')
        self.assertTrue(all(entry['terrain'][y * 50 + 23] == '1' for y in range(50)))
        self.assertEqual(directive.slim_intel({'W30S9': entry})['W30S9']['roomStatus'], 'respawn')

    def test_wall_cuts_cross_room_astar(self):
        terrain = ['0'] * 2500
        for y in range(50):
            terrain[y * 50 + 23] = '1'
        rooms = {
            'E1S1': {'terrain': ''.join(terrain), 'spawnPos': {'x': 21, 'y': 48}},
            'E2S1': {'terrain': '0' * 2500, 'controllerPos': {'x': 25, 'y': 25}},
        }
        self.assertIsNone(plan.travel_ticks('E1S1', 'E2S1', rooms, ME, 600))
        rooms['E1S1']['terrain'] = '0' * 2500
        self.assertIsNotNone(plan.travel_ticks('E1S1', 'E2S1', rooms, ME, 600))
