import copy
import json
import os
import sys
import unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from brain import minerals, directive, brief


def fixture():
    return [
        {'_id': 'ctrl', 'type': 'controller', 'user': 'me', 'level': 6, 'x': 40, 'y': 40},
        {'_id': 'min', 'type': 'mineral', 'mineralType': 'H', 'mineralAmount': 70000, 'x': 10, 'y': 10},
        {'_id': 'ext', 'type': 'extractor', 'user': 'me', 'x': 10, 'y': 10},
        {'_id': 'spawn', 'type': 'spawn', 'user': 'me', 'x': 20, 'y': 20},
        {'_id': 'term', 'type': 'terminal', 'user': 'me', 'x': 22, 'y': 20, 'store': {'energy': 20000}},
        {'_id': 'store', 'type': 'storage', 'user': 'me', 'x': 23, 'y': 22, 'store': {'energy': 20000}},
    ]


class Minerals(unittest.TestCase):
    def plan(self, objects=None, terrain=None, **kw):
        return minerals.plan(objects or fixture(), terrain or '0'*2500, 'me', 100, 2300, **kw)

    def test_build_extractor_on_wall_mineral(self):
        objects = [o for o in fixture() if o['_id'] != 'ext']
        terrain = list('0'*2500)
        terrain[510] = '1'
        p = self.plan(objects, ''.join(terrain))
        self.assertTrue(p['build'])
        self.assertEqual(p['pos'], {'x': 10, 'y': 10})
        self.assertEqual(p['reason'], 'extractor')
        self.assertFalse(p['enabled'])

    def test_harvest_and_regeneration(self):
        objects = fixture()
        self.assertTrue(self.plan(objects)['enabled'])
        objects[1]['mineralAmount'] = 0
        objects[1]['nextRegenerationTime'] = 50100
        p = self.plan(objects)
        self.assertEqual(p['reason'], 'depleted')
        self.assertEqual(p['regenerationAt'], 50100)
        objects[1]['mineralAmount'] = 35000
        self.assertTrue(self.plan(objects)['enabled'])

    def test_rcl_owner_stock_energy_and_free_space(self):
        for change, reason in [(lambda o: o[0].update(level=5), 'rcl'),
                               (lambda o: o[0].update(user='other'), 'rcl'),
                               (lambda o: o[4]['store'].update(H=50000), 'stock'),
                               (lambda o: [v['store'].update(energy=0) for v in o if 'store' in v], 'energy'),
                               (lambda o: [v['store'].update(Z=1000000) for v in o if 'store' in v], 'full')]:
            objects = fixture()
            change(objects)
            self.assertEqual(self.plan(objects)['reason'], reason)

    def test_downgrade_keeps_delivery_and_recycle_routes(self):
        objects = fixture()
        objects[0]['level'] = 5
        p = self.plan(objects)
        self.assertFalse(p['enabled'])
        self.assertFalse(p['build'])
        self.assertTrue(p['sinks'])
        self.assertTrue(p['recycle'])

    def test_surrounded_mineral(self):
        objects = fixture()
        for i, (x, y) in enumerate(minerals.adjacent((10, 10))):
            objects.append({'_id': str(i), 'type': 'constructedWall', 'x': x, 'y': y})
        self.assertEqual(self.plan(objects)['reason'], 'unreachable')

    def test_spawn_sealed_off(self):
        objects = fixture()
        # A complete room-spanning wall separates spawn from mineral.
        objects += [{'_id': str(y), 'type': 'constructedWall', 'x': 15, 'y': y} for y in range(1,49)]
        objects[4].update(x=12, y=12)
        objects[5].update(x=12, y=14)
        self.assertEqual(self.plan(objects)['reason'], 'unreachable-spawn')

    def test_routes_reach_mineral_and_both_sinks_without_search(self):
        p = self.plan()
        point = (21, 20)
        def walk(point, route, goal):
            seen = set()
            for _ in range(2500):
                if goal(point):
                    return point
                self.assertNotIn(point, seen)
                seen.add(point)
                direction = route[str(point[0] + point[1]*50)]
                dx, dy = minerals.DIRECTIONS[direction-1]
                point = point[0]+dx, point[1]+dy
            self.fail('route did not terminate')
        stand = walk(point, p['outbound'], lambda point: point == minerals.xy(p['stand']))
        for sink in p['sinks']:
            obj = next(o for o in fixture() if o['_id'] == sink['id'])
            end = walk(stand, sink['path'], lambda pos: max(abs(pos[0]-obj['x']), abs(pos[1]-obj['y'])) == 1)
            walk(end, p['outbound'], lambda pos: pos == stand)
        self.assertLess(len(json.dumps(p)), 15000)

    def test_reported_block_is_avoided_in_new_route(self):
        objects = fixture() + [{'_id': 'creep', 'type': 'creep', 'user': 'me', 'name': 'miner', 'x': 18, 'y': 18}]
        memory = {'miner': {'role': 'mineralMiner', 'mineralBlocked': {'x': 17, 'y': 17}}}
        p = self.plan(objects, creep_memory=memory)
        direction = p['outbound'][str(18 + 18*50)]
        self.assertNotEqual(direction, 8)

    def test_body_budget_and_parts(self):
        for cap in (200, 300, 800, 1800, 3000):
            body = minerals.body_for(cap, 30)
            self.assertLessEqual(len(body), 50)
            self.assertLessEqual(sum(100 if p == 'work' else 50 for p in body), cap)
            self.assertTrue(set(body) == {'work', 'carry', 'move'})

    def test_brief_shows_effective_mineral_status(self):
        text = brief.render({'homes': {'W1N1': {'level': 6, 'plan': {'mineral': {'enabled': True}}}},
                             'directive': {'rooms': {'W1N1': {'mineral': {
                                 'enabled': False, 'reason': 'energy', 'mineralType': 'H'}}}}})
        self.assertIn('房内矿物 H：暂停（先保障能量储备）', text)

    def test_contract_carries_plan_and_rejects_oversize_before_write(self):
        p = self.plan()
        doc = directive.build({'W1N1': {'mineral': p}}, {})
        self.assertEqual(doc['rooms']['W1N1']['mineral'], p)
        with self.assertRaises(ValueError):
            directive.write(None, {'tooBig': 'x'*100000})


if __name__ == '__main__':
    unittest.main()
