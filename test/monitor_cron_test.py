import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class MonitorCronExitTest(unittest.TestCase):
    def test_collector_exit_survives_watch_and_log_rotation(self):
        script = Path(__file__).resolve().parents[1] / 'scripts' / 'monitor_cron.sh'
        for status in (0, 1, 2):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'scripts').mkdir()
                (root / 'logs').mkdir()
                shutil.copyfile(script, root / 'scripts' / script.name)
                fake_python = root / 'python'
                fake_python.write_text('#!/bin/sh\ncase "$1" in\n'
                                       'scripts/monitor.py) echo "collector-ran $2"; exit "$COLLECTOR_EXIT";;\n'
                                       'scripts/watch_rooms.py) echo watch-ran; exit 9;;\n'
                                       '*) exit 99;;\nesac\n')
                fake_python.chmod(0o700)
                env = dict(os.environ, SCREEPS_MONITOR_PYTHON=str(fake_python), COLLECTOR_EXIT=str(status))
                completed = subprocess.run(['bash', str(root / 'scripts' / script.name)],
                                           env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(completed.returncode, status)
                self.assertIn('monitor exit=' + str(status), (root / 'logs/monitor.log').read_text())
                self.assertIn('watch-ran', (root / 'logs/watch.log').read_text())
                # cron 只记账不确认告警，留给每小时心跳消费
                self.assertIn('collector-ran --no-ack', (root / 'logs/monitor.log').read_text())


if __name__ == '__main__':
    unittest.main()
