import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scripts'))
os.environ.setdefault('SCREEPS_TOKEN', 'x')
import monitor


class ProbeCleanupTest(unittest.TestCase):
    def run_snapshot(self, reply):
        sent = []
        clock = [0.0]

        def fake_console(expr):
            sent.append(expr)
            return {}

        def fake_read(path):
            if path == '_mon':
                return reply(sent)
            if path == 'stats':
                return [{'t': i, 'cpu': 100 + i, 'bucket': 9000, 'creeps': 200, 'cpuBy': {'x': 1}} for i in range(8)]
            if path == 'taskBroker.rooms':
                return {'W1N1': {'backlog': 3}}
            return None

        def fake_time():
            clock[0] += 5
            return clock[0]

        with mock.patch.object(monitor, 'console', fake_console), mock.patch.object(monitor, 'read_memory', fake_read), \
                mock.patch.object(monitor.time, 'sleep', lambda s: None), mock.patch.object(monitor.time, 'time', fake_time):
            try:
                return monitor.snapshot(), sent, None
            except RuntimeError as e:
                return None, sent, e

    def test_success_deletes_and_reads_tails_from_memory(self):
        def reply(sent):
            nonce = [e for e in sent if e.startswith('Memory._monProbe_')][0].split('=')[0].split('_monProbe_')[1]
            return json.dumps({'schema': 4, 'nonce': nonce})
        mon, sent, err = self.run_snapshot(reply)
        self.assertIsNone(err)
        self.assertIn('delete Memory._mon', sent[-1])
        self.assertEqual(len(mon['statsTail']), 5)
        self.assertEqual(set(mon['statsTail'][0]), {'t', 'cpu', 'bucket', 'creeps'})
        self.assertEqual(mon['taskBroker'], {'rooms': {'W1N1': {'backlog': 3}}})
        self.assertNotIn('statsTail', monitor.PROBE)
        self.assertNotIn('taskBroker', monitor.PROBE)

    def test_timeout_still_deletes_after_60s(self):
        mon, sent, err = self.run_snapshot(lambda sent: None)
        self.assertIsNotNone(err)
        self.assertIn('delete Memory._mon', sent[-1])
        self.assertIn('delete Memory._monProbe_', sent[-1])
        self.assertTrue(any('eval(Memory._monProbe_' in e for e in sent))


if __name__ == '__main__':
    unittest.main()
