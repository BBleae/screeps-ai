#!/usr/bin/env python3
"""Screeps HTTP API 小工具库 + CLI。

CLI 用法: python3 scripts/probe.py [memory_path]   （默认 _probe）
库用法:   from probe import read_memory, console, api
"""
import json, sys, os, base64, gzip, subprocess, zlib
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_token():
    """环境变量优先，其次 .env；都没有时为空串（只 import 模块的单测不需要凭证，真正调 API 时才会被拒）。"""
    token = os.environ.get('SCREEPS_AUTH_TOKEN', '').strip()
    if token:
        return token
    try:
        with open(os.path.join(ROOT, '.env')) as handle:
            for line in handle:
                if line.startswith('SCREEPS_AUTH_TOKEN'):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return ''


TOKEN = _load_token()
SHARD = 'shard1'


class ApiError(RuntimeError):
    """Safe diagnostics only: never include a token, response body or curl command."""
    def __init__(self, method, path, kind, status=None, transport_code=None):
        self.method = method
        self.endpoint = urlsplit(path).path
        self.kind = kind
        self.status = status
        self.transport_code = transport_code
        detail = '%s %s: %s' % (method, self.endpoint, kind)
        if status is not None:
            detail += ' HTTP %d' % status
        if transport_code is not None:
            detail += ' curl exit %d' % transport_code
        super().__init__(detail)


def api(method, path, body=None):
    """调用 Screeps HTTP API（token 认证）。返回解析后的 JSON。"""
    # Keep status separate from the body even for non-JSON rate-limit/proxy replies.
    # Do not retry console POSTs: an uncertain acknowledgement may already be queued.
    cmd = ['curl', '--silent', '--show-error', '--connect-timeout', '10',
           '--max-time', '45', '--write-out', '\n%{http_code}',
           '-X', method, '-H', 'X-Token: ' + TOKEN]
    if body is not None:
        cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    cmd.append('https://screeps.com' + path)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=50)
    except subprocess.TimeoutExpired:
        # TimeoutExpired.__str__ includes the full command and its token header.
        raise ApiError(method, path, 'timeout') from None
    except OSError:
        raise ApiError(method, path, 'transport') from None
    out, separator, status_text = result.stdout.rpartition('\n')
    status = int(status_text) if separator and len(status_text) == 3 and status_text.isdigit() else None
    if status == 0:
        status = None
    if result.returncode:
        raise ApiError(method, path, 'transport', status, result.returncode)
    if status is None:
        raise ApiError(method, path, 'missing-status')
    if not 200 <= status < 300:
        raise ApiError(method, path, 'http', status)
    try:
        payload = json.loads(out)
    except (ValueError, TypeError):
        raise ApiError(method, path, 'non-json', status) from None
    if not isinstance(payload, dict):
        raise ApiError(method, path, 'shape', status)
    if payload.get('error'):
        raise ApiError(method, path, 'api', status)
    return payload


def read_memory(path):
    """读 shard1 的 Memory 子树，自动处理 gz: 前缀（gzip+base64）。"""
    d = api('GET', f'/api/user/memory?path={path}&shard={SHARD}')
    raw = d.get('data')
    try:
        if isinstance(raw, str) and raw.startswith('gz:'):
            raw = gzip.decompress(base64.b64decode(raw[3:])).decode()
        return json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, OSError, EOFError, zlib.error):
        raise ApiError('GET', '/api/user/memory', 'memory-decode') from None


def console(expression):
    """POST console 表达式（结果不直接返回——写 Memory 后用 read_memory 取）。"""
    return api('POST', '/api/user/console', {'expression': expression, 'shard': SHARD})


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else '_probe'
    val = read_memory(path)
    print(json.dumps(val, ensure_ascii=False, indent=1) if val is not None else '{"missing": true}')
