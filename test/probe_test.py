import base64
import gzip
import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

from scripts import probe


class ProbeHttpTest(unittest.TestCase):
    def setUp(self):
        self.token = mock.patch.object(probe, 'TOKEN', 'PRIVATE_TEST_TOKEN')
        self.token.start()
        self.addCleanup(self.token.stop)

    def response(self, body, status=200, returncode=0, stderr=''):
        return SimpleNamespace(stdout=body + '\n' + str(status),
                               returncode=returncode, stderr=stderr)

    def test_success_and_bounded_curl_configuration(self):
        with mock.patch.object(probe.subprocess, 'run', return_value=self.response('{"ok":1}')) as run:
            self.assertEqual(probe.api('GET', '/api/game/time'), {'ok': 1})
        args, kwargs = run.call_args
        self.assertIn('--connect-timeout', args[0])
        self.assertIn('--max-time', args[0])
        self.assertLessEqual(kwargs['timeout'], 60)

    def test_http_error_keeps_status_without_response_or_query(self):
        for status in (429, 503):
            with self.subTest(status=status), mock.patch.object(
                    probe.subprocess, 'run', return_value=self.response('PRIVATE_BODY', status)):
                with self.assertRaises(probe.ApiError) as caught:
                    probe.api('GET', '/api/user/memory?path=PRIVATE_QUERY')
                error = caught.exception
                self.assertEqual(error.status, status)
                self.assertEqual(error.kind, 'http')
                self.assertIn('/api/user/memory', str(error))
                for secret in ('PRIVATE_BODY', 'PRIVATE_QUERY', 'PRIVATE_TEST_TOKEN'):
                    self.assertNotIn(secret, str(error))

    def test_http_200_non_json_is_not_labelled_rate_limit(self):
        with mock.patch.object(probe.subprocess, 'run', return_value=self.response('PRIVATE_HTML')):
            with self.assertRaises(probe.ApiError) as caught:
                probe.api('GET', '/api/user/memory')
        self.assertEqual((caught.exception.status, caught.exception.kind), (200, 'non-json'))
        self.assertNotIn('429', str(caught.exception))
        self.assertNotIn('PRIVATE_HTML', str(caught.exception))

    def test_empty_success_is_unknown_not_empty_state(self):
        with mock.patch.object(probe.subprocess, 'run', return_value=self.response('')):
            with self.assertRaises(probe.ApiError) as caught:
                probe.read_memory('rooms')
        self.assertEqual(caught.exception.kind, 'non-json')

    def test_transport_failure_keeps_exit_code_and_hides_stderr(self):
        with mock.patch.object(probe.subprocess, 'run', return_value=self.response(
                '', 0, returncode=7, stderr='PRIVATE_TEST_TOKEN')):
            with self.assertRaises(probe.ApiError) as caught:
                probe.api('GET', '/api/user/memory')
        self.assertEqual(caught.exception.transport_code, 7)
        self.assertEqual(caught.exception.kind, 'transport')
        self.assertNotIn('PRIVATE_TEST_TOKEN', str(caught.exception))

    def test_timeout_does_not_log_command_or_retry_console_post(self):
        timeout = subprocess.TimeoutExpired(['curl', '-H', 'X-Token: PRIVATE_TEST_TOKEN'], 50)
        with mock.patch.object(probe.subprocess, 'run', side_effect=timeout) as run:
            with self.assertRaises(probe.ApiError) as caught:
                probe.console('PRIVATE_EXPRESSION')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(caught.exception.kind, 'timeout')
        self.assertNotIn('PRIVATE_TEST_TOKEN', str(caught.exception))
        self.assertNotIn('PRIVATE_EXPRESSION', str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_os_failure_has_safe_context(self):
        with mock.patch.object(probe.subprocess, 'run', side_effect=OSError('PRIVATE_PATH')):
            with self.assertRaises(probe.ApiError) as caught:
                probe.api('GET', '/api/game/time')
        self.assertEqual(caught.exception.kind, 'transport')
        self.assertNotIn('PRIVATE_PATH', str(caught.exception))

    def test_api_error_payload_and_invalid_shape_are_safe(self):
        for body, kind in ((json.dumps({'error': 'PRIVATE_BODY'}), 'api'), ('[]', 'shape')):
            with self.subTest(body=body), mock.patch.object(probe.subprocess, 'run',
                                                          return_value=self.response(body)):
                with self.assertRaises(probe.ApiError) as caught:
                    probe.api('GET', '/api/user/memory')
                self.assertEqual(caught.exception.kind, kind)
                self.assertNotIn('PRIVATE_BODY', str(caught.exception))

    def test_memory_values_and_gzip_still_decode(self):
        expected = {'t': 42, 'nonce': 'fresh'}
        compressed = 'gz:' + base64.b64encode(gzip.compress(json.dumps(expected).encode())).decode()
        for raw in (expected, json.dumps(expected), compressed, None):
            with self.subTest(raw=raw), mock.patch.object(probe, 'api', return_value={'data': raw}):
                self.assertEqual(probe.read_memory('_mon'), expected if raw is not None else None)

    def test_malformed_memory_stays_unknown_without_body(self):
        for raw in ('PRIVATE_MEMORY', 'gz:PRIVATE_MEMORY'):
            with self.subTest(raw=raw), mock.patch.object(probe, 'api', return_value={'data': raw}):
                with self.assertRaises(probe.ApiError) as caught:
                    probe.read_memory('_mon')
                self.assertEqual(caught.exception.kind, 'memory-decode')
                self.assertNotIn('PRIVATE_MEMORY', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
