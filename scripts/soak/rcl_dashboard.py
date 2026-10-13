#!/usr/bin/env python3
"""RCL 基准实时看板：标准库 HTTP 服务，增量读 rcl_benchmark.js 的输出目录，网页每几秒自刷新。

用法：python3 scripts/soak/rcl_dashboard.py [--run data/soak/rcl-bench-<x>] [--port 8765] [--host 127.0.0.1] [--refresh 5]
      默认取 data/soak/ 下最新的 rcl-bench-* 目录。浏览器打开 http://127.0.0.1:8765/

接口：GET /api/state → JSON（运行信息、最新记录、最近窗口速率、ETA、各房状态、阶段表、曲线序列、事件、大脑决策、探针 creep 表）
"""
import argparse
import glob
import json
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)
from scripts.soak import rcl_report as report  # noqa: E402

CONTROLLER_LEVELS = report.CONTROLLER_LEVELS
MAX_POINTS = 600


def latest_run_dir():
    dirs = sorted(glob.glob(os.path.join(ROOT, 'data', 'soak', 'rcl-bench-*')), key=os.path.getmtime)
    return dirs[-1] if dirs else None


def tail_lines(path, n):
    """文件末尾 n 行（小文件直接读；大文件从末尾倒着读块）。"""
    if not os.path.exists(path):
        return []
    size = os.path.getsize(path)
    with open(path, 'rb') as handle:
        block = 65536
        data = b''
        pos = size
        while pos > 0 and data.count(b'\n') <= n:
            step = min(block, pos)
            pos -= step
            handle.seek(pos)
            data = handle.read(step) + data
            if pos == 0:
                break
    lines = [line for line in data.split(b'\n') if line.strip()]
    out = []
    for line in lines[-n:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


class RunReader:
    """增量读取 progress.jsonl（记住文件偏移），其它小文件每次整读。"""

    def __init__(self, run_dir):
        self.run_dir = run_dir
        self.rows = []
        self.offset = 0
        self.partial = b''
        self.lock = threading.Lock()
        self._stage_cache = (None, None)

    def path(self, name):
        return os.path.join(self.run_dir, name)

    def refresh(self):
        path = self.path('progress.jsonl')
        if not os.path.exists(path):
            return
        size = os.path.getsize(path)
        with self.lock:
            if size < self.offset:
                self.rows, self.offset, self.partial = [], 0, b''
            if size == self.offset:
                return
            with open(path, 'rb') as handle:
                handle.seek(self.offset)
                chunk = handle.read()
                self.offset = handle.tell()
            data = self.partial + chunk
            lines = data.split(b'\n')
            self.partial = lines.pop()
            for line in lines:
                if not line.strip():
                    continue
                try:
                    self.rows.append(json.loads(line))
                except ValueError:
                    continue

    def run(self):
        try:
            with open(self.path('run.json'), encoding='utf-8') as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return None

    def levels(self):
        try:
            with open(self.path('levels.json'), encoding='utf-8') as handle:
                return json.load(handle) or []
        except (OSError, ValueError):
            return []

    def events(self, n=60):
        return tail_lines(self.path('events.jsonl'), n)

    def brain_runs(self, n=3):
        return tail_lines(os.path.join(self.path('brain'), 'runs.jsonl'), n)

    def last_probe(self):
        items = tail_lines(self.path('samples.jsonl'), 1)
        return items[-1] if items else None

    def stages(self, run, levels, snapshot_path):
        key = (len(self.rows), len(levels))
        if self._stage_cache[0] == key:
            return self._stage_cache[1]
        try:
            summary = report.summarize(run, self.rows, levels, [], snapshot_path)
            stages = [{k: s[k] for k in ('level', 'tStart', 'tEnd', 'ticks', 'inProgress', 'need', 'progressed', 'cp', 'cpOthers', 'income', 'residual', 'deltaStock',
                                         'harvestRate', 'upgradeRate', 'cpRate', 'potentialRate', 'sourceUtilHome', 'sourceUtilRemote', 'upgradeShare', 'spawnShare',
                                         'buildShare', 'spawnUtil', 'boundHomeOnly', 'boundIncome', 'boundPotential', 'efficiencyHomeOnly', 'efficiencyIncome',
                                         'efficiencyPotential', 'expansionSpend')} for s in summary['stages']]
            for s, full in zip(stages, summary['stages']):
                s['harvest'] = full['acc']['harvest']
                s['harvestRemote'] = full['acc']['harvestRemote']
                s['spawn'] = full['acc']['spawn']
                s['build'] = full['acc']['build']
                s['remote'] = full['remote']
                s['ownedEnd'] = full['ownedEnd']
                s['gclLevelEnd'] = full['gclLevelEnd']
            result = {'stages': stages, 'claims': summary['claims'], 'windows': summary['cpWindows'][-40:]}
        except Exception as error:  # 报告函数对半写的数据可能抛错，看板不能因此挂
            result = {'stages': [], 'claims': [], 'windows': [], 'error': str(error)}
        self._stage_cache = (key, result)
        return result


def rates_between(first, last):
    a, b = first.get('acc', {}), last.get('acc', {})
    ticks = max(1, last['t'] - first['t'])
    home = None
    out = {'ticks': ticks}
    for key in ('harvest', 'harvestHome', 'harvestRemote', 'upgrade', 'spawn', 'build', 'residual'):
        out[key] = (b.get(key, 0) - a.get(key, 0)) / ticks
    return out


def home_upgrade_between(first, last, home):
    a = (first.get('acc', {}).get('upgradeByRoom') or {}).get(home)
    b = (last.get('acc', {}).get('upgradeByRoom') or {}).get(home)
    if a is None or b is None:
        return (last.get('acc', {}).get('upgrade', 0) - first.get('acc', {}).get('upgrade', 0)) / max(1, last['t'] - first['t'])
    return (b - a) / max(1, last['t'] - first['t'])


def row_at_or_before(rows, t):
    lo, hi = 0, len(rows) - 1
    best = rows[0]
    while lo <= hi:
        mid = (lo + hi) // 2
        if rows[mid]['t'] <= t:
            best = rows[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def downsample(rows, start_tick):
    stride = max(1, math.ceil(len(rows) / MAX_POINTS))
    picked = rows[::stride]
    if picked[-1] is not rows[-1]:
        picked.append(rows[-1])
    series = []
    for r in picked:
        st = r.get('stock') or {}
        series.append({
            't': r['t'] - start_tick, 'rcl': r.get('rcl'), 'cp': r.get('acc', {}).get('upgrade', 0), 'gclLevel': r.get('gclLevel'),
            'creeps': r.get('creeps'), 'roles': r.get('roles') or {}, 'rooms': r.get('ownedN', 1),
            'dropped': (st.get('dropped', 0) or 0) + (st.get('droppedRemote', 0) or 0), 'container': (st.get('container', 0) or 0) + (st.get('containerRemote', 0) or 0),
            'storage': st.get('storage', 0) or 0, 'spawnExt': st.get('spawnExt', 0) or 0, 'carried': st.get('carried', 0) or 0, 'tower': st.get('tower', 0) or 0,
            'cpu': r.get('cpu'), 'bucket': r.get('bucket'), 'remotes': len(r.get('remoteRooms') or []),
        })
    return series


def window_rates(rows, start_tick, home, window):
    """按固定 tick 窗口的速率序列（每 tick 的采集/升级/孵化/建造/残差）。"""
    out = []
    if len(rows) < 2:
        return out
    anchor = rows[0]
    for r in rows[1:]:
        if r['t'] - anchor['t'] < window and r is not rows[-1]:
            continue
        rate = rates_between(anchor, r)
        rate['homeUpgrade'] = home_upgrade_between(anchor, r, home)
        rate['t'] = r['t'] - start_tick
        out.append(rate)
        anchor = r
    stride = max(1, math.ceil(len(out) / MAX_POINTS))
    return out[::stride] if stride > 1 else out


def build_state(reader, snapshot_path, refresh_seconds):
    reader.refresh()
    run = reader.run()
    rows = reader.rows
    state = {'now': time.time(), 'refresh': refresh_seconds, 'runDir': reader.run_dir, 'run': run, 'ready': bool(rows and run)}
    if not state['ready']:
        return state
    home = run['args']['home']
    start_tick = run.get('startTick', 0)
    last = rows[-1]
    t = last['t'] - start_tick
    recent = rows[-40:]
    dwall = sum(r.get('dwall') or 0 for r in recent)
    dt = sum(r.get('dt') or 0 for r in recent)
    tps = (dt / (dwall / 1000.0)) if dwall > 0 else None
    w5 = row_at_or_before(rows, last['t'] - 5000)
    w1 = row_at_or_before(rows, last['t'] - 1000)
    rate5 = rates_between(w5, last) if w5 is not last else None
    rate1 = rates_between(w1, last) if w1 is not last else None
    home_rate5 = home_upgrade_between(w5, last, home) if w5 is not last else 0.0
    rcl = last.get('rcl') or 1
    need = CONTROLLER_LEVELS.get(rcl, 0)
    remaining = max(0, need - (last.get('prog') or 0)) if need else 0
    eta_ticks = (remaining / home_rate5) if home_rate5 > 0 and need else None
    remaining8 = sum(CONTROLLER_LEVELS.get(l, 0) for l in range(rcl, 8)) - (last.get('prog') or 0) if rcl < 8 else 0
    eta8_ticks = (remaining8 / home_rate5) if home_rate5 > 0 and rcl < 8 else None
    levels = reader.levels()
    stage_info = reader.stages(run, levels, snapshot_path)
    owned = last.get('owned') or {home: {'rcl': rcl, 'prog': last.get('prog'), 'progTotal': need}}
    rooms_mem = last.get('roomsMem') or {}
    hostiles = {room: users for room, users in (last.get('hostiles') or {}).items() if users.get('2') or any(u not in ('2', '3') for u in users)}
    probe = reader.last_probe()
    creeps = []
    probe_rooms = {}
    if probe:
        for c in probe.get('creeps') or []:
            creeps.append({'name': c[0], 'role': c[1], 'home': c[2], 'room': c[3], 'x': c[4], 'y': c[5], 'carry': c[6], 'ttl': c[7], 'fatigue': c[8], 'remote': c[9] or c[10] or ''})
        for name, r in (probe.get('rooms') or {}).items():
            if not r.get('mine') and not any(c['room'] == name for c in creeps):
                continue
            probe_rooms[name] = {'mine': r.get('mine'), 'rcl': r.get('rcl'), 'e': r.get('e'), 'cap': r.get('cap'), 'hostiles': r.get('hostiles'), 'sites': len(r.get('sites') or []),
                                 'siteTypes': sorted({s[0] for s in (r.get('sites') or [])}), 'drops': r.get('drops'), 'cont': r.get('cont'), 'remotes': r.get('remotes'), 'targets': r.get('targets')}
    state.update({
        'tick': t, 'wallHours': (time.time() * 1000 - run.get('startedAt', time.time() * 1000)) / 3600000.0, 'tps': tps, 'lastWall': last.get('wall'),
        'lastAgeSeconds': time.time() - (last.get('wall') or 0) / 1000.0,
        'rcl': rcl, 'prog': last.get('prog'), 'progTotal': need, 'gcl': last.get('gcl'), 'gclLevel': last.get('gclLevel'), 'cp': last.get('acc', {}).get('upgrade', 0),
        'creeps': last.get('creeps'), 'roles': last.get('roles') or {}, 'stock': last.get('stock') or {}, 'acc': last.get('acc') or {},
        'rate5': rate5, 'rate1': rate1, 'homeRate5': home_rate5,
        'eta': {'levelTicks': eta_ticks, 'levelHours': (eta_ticks / tps / 3600.0) if (eta_ticks is not None and tps) else None,
                'rcl8Ticks': eta8_ticks, 'rcl8Hours': (eta8_ticks / tps / 3600.0) if (eta8_ticks is not None and tps) else None},
        'owned': owned, 'claims': {k: v - start_tick for k, v in (last.get('claims') or {}).items()}, 'spawnBuilt': {k: v - start_tick for k, v in (last.get('spawnBuilt') or {}).items()},
        'remoteRooms': last.get('remoteRooms') or [], 'reservations': last.get('reservations') or [], 'hostiles': hostiles, 'cores': last.get('cores') or [],
        'queue': last.get('queue'), 'state': last.get('state'), 'targets': last.get('targets'), 'expansion': last.get('expansion'), 'remotes': last.get('remotes') or [],
        'roomsMem': {name: {'queue': (rm or {}).get('queue'), 'remotes': (rm or {}).get('remotes'), 'expansion': (rm or {}).get('expansion'), 'targets': (rm or {}).get('targets'),
                            'planVer': (rm or {}).get('planVer'), 'planError': (rm or {}).get('planError')} for name, rm in rooms_mem.items()},
        'brain': last.get('brain'), 'brainRuns': [{'t': b.get('t', 0) - start_tick, 'ms': b.get('ms'), 'plans': (b.get('result') or {}).get('plans'), 'blockers': (b.get('result') or {}).get('blockers'),
                                                    'gcl': (b.get('result') or {}).get('gcl')} for b in reader.brain_runs(3)],
        'errN': last.get('errN'), 'lastErr': last.get('lastErr'), 'cpu': last.get('cpu'), 'bucket': last.get('bucket'), 'memBytes': last.get('memBytes'), 'sitesN': last.get('sitesN'),
        'homeStructs': last.get('homeStructs') or {}, 'homeSources': last.get('homeSources') or [], 'idleSources': last.get('idleSources'),
        'levels': [{'room': lv.get('room', home), 'level': lv['level'], 'tick': lv.get('sinceStart', lv['tick'] - start_tick), 'sincePrev': lv.get('sincePrev')} for lv in levels],
        'events': [e for e in reader.events(80) if e.get('event') != 'levelUp'][-40:],
        'stages': stage_info['stages'], 'claimTimeline': stage_info['claims'], 'windows': stage_info['windows'], 'stageError': stage_info.get('error'),
        'series': downsample(rows, start_tick), 'rates': window_rates(rows, start_tick, home, 1000),
        'probe': {'t': (probe.get('t', 0) - start_tick) if probe else None, 'creeps': creeps, 'rooms': probe_rooms, 'spawning': probe.get('spawning') if probe else None,
                  'errs': probe.get('errs') if probe else None},
    })
    return state


PAGE = r"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>RCL 基准看板</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--muted:#5f6b7a;--line:#e3e7ec;--acc:#2f6fed;--warn:#c9411f;--ok:#1a8f4f}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline}
header .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-right:4px}
header .v{font-weight:600;font-size:15px}
header .stale{color:var(--warn)}
main{padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0}
.card h2{margin:0 0 8px;font-size:13px;color:var(--muted);font-weight:600}
.card.wide{grid-column:1/-1}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:3px 6px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:var(--muted);font-weight:500}
canvas{width:100%;height:220px;display:block}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--muted);margin-top:4px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px}
.kv div:nth-child(odd){color:var(--muted)}
.tag{display:inline-block;padding:0 6px;border-radius:10px;background:#eef2f7;margin:1px 2px;font-size:11px}
.bad{color:var(--warn)} .good{color:var(--ok)}
.scroll{max-height:260px;overflow:auto}
pre{margin:0;white-space:pre-wrap;font-size:11px;color:var(--muted)}
</style></head><body>
<header id="hdr"><span class="v">RCL 基准看板</span><span class="k">加载中…</span></header>
<main>
 <div class="card"><h2>母房 / 各房状态</h2><div id="rooms"></div><div id="eta" style="margin-top:8px"></div></div>
 <div class="card"><h2>最近 5000 tick 的能量流（每 tick）</h2><div id="flow"></div></div>
 <div class="card"><h2>总 CP 与母房 RCL</h2><canvas id="c_cp"></canvas><div class="legend" id="l_cp"></div></div>
 <div class="card"><h2>每 1000 tick 窗口速率（能量/tick）</h2><canvas id="c_rate"></canvas><div class="legend" id="l_rate"></div></div>
 <div class="card"><h2>creep 按角色</h2><canvas id="c_roles"></canvas><div class="legend" id="l_roles"></div></div>
 <div class="card"><h2>库存去向（能量）</h2><canvas id="c_stock"></canvas><div class="legend" id="l_stock"></div></div>
 <div class="card"><h2>CPU / bucket</h2><canvas id="c_cpu"></canvas><div class="legend" id="l_cpu"></div></div>
 <div class="card"><h2>spawn 队列 / 目标 / 外矿 / 大脑</h2><div id="econ"></div></div>
 <div class="card wide"><h2>母房每级阶段（阶段账与下限）</h2><div class="scroll" id="stages"></div></div>
 <div class="card"><h2>升级 / 占领 / 事件</h2><div class="scroll" id="events"></div></div>
 <div class="card"><h2>探针（soakProbe，每 500 tick）</h2><div class="scroll" id="probe"></div></div>
</main>
<script>
const COLORS=['#2f6fed','#e0642f','#1a8f4f','#8b5cf6','#d9a400','#0e9aa7','#c9411f','#6b7280','#a3e635','#f472b6','#14b8a6','#f59e0b'];
const fmt=(v,d=0)=>v==null||Number.isNaN(v)?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d});
const pct=v=>v==null?'—':Math.round(v*100)+'%';
const hrs=h=>h==null?'—':(h<1?Math.round(h*60)+' 分钟':h.toFixed(1)+' 小时');
function drawLines(id,legendId,series,opts={}){
  const c=document.getElementById(id);const dpr=window.devicePixelRatio||1;const W=c.clientWidth,H=c.clientHeight;c.width=W*dpr;c.height=H*dpr;
  const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);
  const pad={l:52,r:opts.right?52:12,t:8,b:22};
  const all=series.flatMap(s=>s.points);if(!all.length)return;
  const xs=all.map(p=>p[0]);const xmin=Math.min(...xs),xmax=Math.max(...xs)||1;
  const left=series.filter(s=>!s.right),right=series.filter(s=>s.right);
  const range=list=>{const ys=list.flatMap(s=>s.points.map(p=>p[1])).filter(v=>v!=null);let lo=Math.min(0,...ys),hi=Math.max(...ys);if(hi===lo)hi=lo+1;return [lo,hi]};
  const [ylo,yhi]=range(left.length?left:series);const [rlo,rhi]=right.length?range(right):[0,1];
  const X=x=>pad.l+(x-xmin)/(xmax-xmin||1)*(W-pad.l-pad.r);const Y=(y,lo,hi)=>pad.t+(1-(y-lo)/(hi-lo))*(H-pad.t-pad.b);
  g.strokeStyle='#e3e7ec';g.fillStyle='#5f6b7a';g.font='10px sans-serif';g.textAlign='right';
  for(let i=0;i<=4;i++){const y=ylo+(yhi-ylo)*i/4;const py=Y(y,ylo,yhi);g.beginPath();g.moveTo(pad.l,py);g.lineTo(W-pad.r,py);g.stroke();g.fillText(fmt(y,Math.abs(yhi)<10?1:0),pad.l-4,py+3);}
  if(right.length){g.textAlign='left';for(let i=0;i<=4;i++){const y=rlo+(rhi-rlo)*i/4;g.fillText(fmt(y,0),W-pad.r+4,Y(y,rlo,rhi)+3);}}
  g.textAlign='center';for(let i=0;i<=5;i++){const x=xmin+(xmax-xmin)*i/5;g.fillText(fmt(x),X(x),H-6);}
  series.forEach((s,i)=>{g.strokeStyle=s.color||COLORS[i%COLORS.length];g.lineWidth=s.width||1.5;g.beginPath();let started=false;
    const lo=s.right?rlo:ylo,hi=s.right?rhi:yhi;
    s.points.forEach(p=>{if(p[1]==null){started=false;return;}const x=X(p[0]),y=Y(p[1],lo,hi);if(!started){g.moveTo(x,y);started=true;}else if(s.step){g.lineTo(x,g._ly??y);g.lineTo(x,y);}else g.lineTo(x,y);g._ly=y;});g.stroke();});
  const L=document.getElementById(legendId);if(L)L.innerHTML=series.map((s,i)=>`<span><i style="background:${s.color||COLORS[i%COLORS.length]}"></i>${s.name}${s.right?'（右轴）':''}</span>`).join('');
}
function render(s){
  const H=document.getElementById('hdr');
  if(!s.ready){H.innerHTML=`<span class="v">RCL 基准看板</span><span class="k">还没有采样记录（${s.runDir}）</span>`;return;}
  const r=s.run,stale=s.lastAgeSeconds>120;
  H.innerHTML=[`<span class="v">RCL 基准 ${r.srcRev||''} <small style="color:#5f6b7a">${(r.srcCommit||'').slice(0,10)} · ${(r.worldDir||'').split('/').pop()}</small></span>`,
   `<span><span class="k">tick</span><span class="v">${fmt(s.tick)}</span></span>`,
   `<span><span class="k">母房</span><span class="v">RCL${s.rcl} ${fmt(s.prog)}/${fmt(s.progTotal)} (${pct(s.progTotal?s.prog/s.progTotal:0)})</span></span>`,
   `<span><span class="k">房数</span><span class="v">${Object.keys(s.owned).length}</span></span>`,
   `<span><span class="k">GCL</span><span class="v">${s.gclLevel} <small>(${fmt(s.gcl)} 点)</small></span></span>`,
   `<span><span class="k">总 CP</span><span class="v">${fmt(s.cp)}</span> <small>${s.rate5?fmt(s.rate5.upgrade,2)+'/tick (5k 窗口)':''}</small></span>`,
   `<span><span class="k">creep</span><span class="v">${s.creeps}</span></span>`,
   `<span><span class="k">速度</span><span class="v">${fmt(s.tps,1)} t/s</span> <small>${hrs(s.wallHours)}</small></span>`,
   `<span><span class="k">CPU</span><span class="v">${fmt(s.cpu,1)}</span> <small>bucket ${fmt(s.bucket)}</small></span>`,
   `<span><span class="k">错误</span><span class="v ${s.errN?'bad':'good'}">${s.errN}</span></span>`,
   `<span class="${stale?'stale':''}"><span class="k">最近采样</span>${Math.round(s.lastAgeSeconds)} 秒前${stale?'（可能已停）':''}</span>`].join('');
  const rooms=Object.entries(s.owned).map(([n,o])=>`<tr><td>${n}${n===r.args.home?' ★':''}</td><td>RCL${o.rcl}</td><td>${fmt(o.prog)}/${fmt(o.progTotal)}</td><td>${pct(o.progTotal?o.prog/o.progTotal:0)}</td><td>${fmt(o.downgradeIn)}</td><td>${fmt(o.safe)}</td><td>${o.spawn||0}/${o.ext||0}/${o.tower||0}/${o.links||0}</td><td>${fmt(o.storage)}</td><td>${s.claims[n]!=null?fmt(s.claims[n]):'开局'}</td><td>${s.spawnBuilt[n]!=null?fmt(s.spawnBuilt[n]):'—'}</td></tr>`).join('');
  document.getElementById('rooms').innerHTML=`<div style="overflow-x:auto"><table><tr><th>房</th><th>RCL</th><th>进度</th><th>%</th><th>降级</th><th>安全</th><th>spawn/ext/塔/link</th><th>storage</th><th>占下</th><th>建 spawn</th></tr>${rooms}</table></div>`+
   `<div style="margin-top:6px">母房源：${s.homeSources.map(x=>`<span class="tag">(${x.x},${x.y}) ${x.energy}/${x.cap}</span>`).join('')} 闲置 ${s.idleSources} · 工地 ${s.sitesN} · 建筑 ${Object.entries(s.homeStructs).map(([k,v])=>k+' '+v).join(', ')}</div>`+
   (Object.keys(s.hostiles).length?`<div class="bad" style="margin-top:4px">敌情：${Object.entries(s.hostiles).map(([k,v])=>k+' '+JSON.stringify(v)).join(' ')}</div>`:'')+
   (s.cores.length?`<div style="margin-top:2px;color:#5f6b7a">Invader core：${s.cores.map(c=>c[0]+' L'+c[1]).join(', ')}</div>`:'');
  document.getElementById('eta').innerHTML=`<div class="kv"><div>本级还需</div><div>${fmt(s.progTotal-s.prog)} 进度，按最近 5000 tick 的母房速率 ${fmt(s.homeRate5,2)}/tick ≈ <b>${fmt(s.eta.levelTicks)} tick / ${hrs(s.eta.levelHours)}</b></div><div>到 RCL8（粗估）</div><div>${fmt(s.eta.rcl8Ticks)} tick / ${hrs(s.eta.rcl8Hours)}（按当前速率线性外推，收入会随等级涨，实际更快）</div></div>`;
  const f=s.rate5,f1=s.rate1;const st=s.stock;
  document.getElementById('flow').innerHTML=f?`<table><tr><th></th><th>5000 tick</th><th>1000 tick</th></tr>`+[['采集（己方房）','harvestHome'],['采集（外矿）','harvestRemote'],['升级（总 CP）','upgrade'],['孵化','spawn'],['建造','build'],['残差（衰减/修理/漏记）','residual']].map(([n,k])=>`<tr><td>${n}</td><td>${fmt(f[k],2)}</td><td>${f1?fmt(f1[k],2):'—'}</td></tr>`).join('')+`</table>`+
   `<div style="margin-top:6px">库存：spawn/ext ${fmt(st.spawnExt)} · 塔 ${fmt(st.tower)} · storage ${fmt(st.storage)} · 容器 ${fmt(st.container)}（外矿 ${fmt(st.containerRemote)}）· 运输中 ${fmt(st.carried)} · <span class="${st.dropped>2000?'bad':''}">地面 ${fmt(st.dropped)}（外矿 ${fmt(st.droppedRemote)}）</span> · 墓碑/废墟 ${fmt((st.tomb||0)+(st.ruin||0))}</div>`+
   `<div style="margin-top:4px;color:#5f6b7a">累计：采集 ${fmt(s.acc.harvest)}（外矿 ${fmt(s.acc.harvestRemote)}）· CP ${fmt(s.acc.upgrade)} · 孵化 ${fmt(s.acc.spawn)}（${s.acc.creeps} 只）· 建造 ${fmt(s.acc.build)}（被拆 ${fmt(s.acc.buildLost)}）· 残差 ${fmt(s.acc.residual)}</div>`+
   `<div style="margin-top:4px;color:#5f6b7a">孵化按角色：${Object.entries(s.acc.spawnByRole||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<span class="tag">${k} ${fmt(v)}</span>`).join('')}</div>`:'（还不够 5000 tick）';
  const ser=s.series;
  drawLines('c_cp','l_cp',[{name:'总 CP',points:ser.map(p=>[p.t,p.cp])},{name:'母房 RCL',points:ser.map(p=>[p.t,p.rcl]),right:true,step:true,color:'#e0642f'},{name:'房数',points:ser.map(p=>[p.t,p.rooms]),right:true,step:true,color:'#1a8f4f'}],{right:true});
  drawLines('c_rate','l_rate',[{name:'采集(己方房)',points:s.rates.map(p=>[p.t,p.harvestHome])},{name:'采集(外矿)',points:s.rates.map(p=>[p.t,p.harvestRemote])},{name:'升级(总 CP)',points:s.rates.map(p=>[p.t,p.upgrade])},{name:'孵化',points:s.rates.map(p=>[p.t,p.spawn])},{name:'建造',points:s.rates.map(p=>[p.t,p.build])},{name:'残差',points:s.rates.map(p=>[p.t,p.residual])}]);
  const roleNames=[...new Set(ser.flatMap(p=>Object.keys(p.roles)))].sort();
  drawLines('c_roles','l_roles',roleNames.map(n=>({name:n,points:ser.map(p=>[p.t,p.roles[n]||0])})).concat([{name:'外矿数',points:ser.map(p=>[p.t,p.remotes]),right:true,step:true,color:'#6b7280'}]),{right:true});
  drawLines('c_stock','l_stock',[{name:'地面',points:ser.map(p=>[p.t,p.dropped])},{name:'容器',points:ser.map(p=>[p.t,p.container])},{name:'storage',points:ser.map(p=>[p.t,p.storage])},{name:'spawn/ext',points:ser.map(p=>[p.t,p.spawnExt])},{name:'运输中',points:ser.map(p=>[p.t,p.carried])},{name:'塔',points:ser.map(p=>[p.t,p.tower])}]);
  drawLines('c_cpu','l_cpu',[{name:'CPU',points:ser.map(p=>[p.t,p.cpu])},{name:'bucket',points:ser.map(p=>[p.t,p.bucket]),right:true,color:'#1a8f4f'}],{right:true});
  const q=s.queue||{};const w=q.waiting;
  let econ=`<div class="kv"><div>队列</div><div>请求 ${q.requests??'—'} · 空闲 ${q.idle??'—'} · 被挡 ${q.blocked??'—'} · 收入估计 ${fmt(q.income,1)} · 本 tick 孵化 ${(q.spawned||[]).join(', ')||'—'}</div><div>队头等待</div><div>${w?`${w.key} 成本 ${w.cost} 预计 ${w.eta} 已等 ${w.waited}`:'—'}</div><div>目标</div><div>${Object.entries(s.targets||{}).map(([k,v])=>k+' '+v).join(', ')||'—'}</div><div>状态</div><div>${s.state?Object.entries(s.state).filter(([k])=>k!=='at').map(([k,v])=>k+'='+JSON.stringify(v)).join(' '):'—'}</div><div>外矿</div><div>${(s.remotes||[]).map(x=>`<span class="tag ${x[1]?'':'bad'}">${x[0]} ${x[1]?'启用':'停用'}${x[2]?' '+x[2]:''}${x[3]?' 预定 '+x[3]:''}</span>`).join('')||'—'}</div><div>占领</div><div>${s.expansion?JSON.stringify(s.expansion):'—'}</div>`;
  const b=s.brain;econ+=`<div>大脑</div><div>${b?`ack ${b.ack===b.issuedAt?'✓':'✗'}${b.stale?' stale':''} · claim ${JSON.stringify(b.claims)} · 白名单 ${Object.entries(b.remotes||{}).map(([h,l])=>h+':'+(l||[]).join('/')).join(' ')}`:'无指令'}</div>`;
  econ+=`<div>最近大脑轮</div><div>${s.brainRuns.map(x=>`t=${fmt(x.t)} ${x.ms}ms plans=${JSON.stringify(x.plans)} ${(x.blockers||[]).length?'blockers='+JSON.stringify(x.blockers):''}`).join('<br>')||'—'}</div></div>`;
  for(const [name,rm] of Object.entries(s.roomsMem||{})){if(name===r.args.home)continue;econ+=`<div style="margin-top:6px"><b>${name}</b> plan ${rm.planVer||'—'}${rm.planError?' <span class=bad>'+rm.planError+'</span>':''} · 队列 ${rm.queue?`${rm.queue.requests} 请求/收入 ${fmt(rm.queue.income,1)}`:'—'} · 外矿 ${(rm.remotes||[]).map(x=>x[0]+(x[1]?'':'(停)')).join(', ')||'—'}</div>`;}
  if(s.lastErr)econ+=`<div class="bad" style="margin-top:6px">最近错误：${JSON.stringify(s.lastErr)}</div>`;
  document.getElementById('econ').innerHTML=econ;
  document.getElementById('stages').innerHTML=(s.stageError?`<div class="bad">${s.stageError}</div>`:'')+`<table><tr><th>RCL</th><th>起</th><th>止</th><th>用时</th><th>需要</th><th>母房升级</th><th>总 CP</th><th>采集</th><th>其中外矿</th><th>孵化</th><th>建造</th><th>残差</th><th>收入/tick</th><th>潜在/tick</th><th>己方源利用</th><th>外矿利用</th><th>升级占比</th><th>孵化占比</th><th>spawn 占用</th><th>下限A</th><th>下限B</th><th>下限C</th><th>效率A</th><th>效率B</th><th>效率C</th><th>外矿净</th></tr>`+
   s.stages.map(x=>`<tr><td>${x.level}${x.inProgress?'（进行中）':''}</td><td>${fmt(x.tStart)}</td><td>${fmt(x.tEnd)}</td><td>${fmt(x.ticks)}</td><td>${fmt(x.need)}</td><td>${fmt(x.progressed)}</td><td>${fmt(x.cp)}</td><td>${fmt(x.harvest)}</td><td>${fmt(x.harvestRemote)}</td><td>${fmt(x.spawn)}</td><td>${fmt(x.build)}</td><td>${fmt(x.residual)}</td><td>${fmt(x.harvestRate,1)}</td><td>${fmt(x.potentialRate,1)}</td><td>${pct(x.sourceUtilHome)}</td><td>${pct(x.sourceUtilRemote)}</td><td>${pct(x.upgradeShare)}</td><td>${pct(x.spawnShare)}</td><td>${pct(x.spawnUtil)}</td><td>${fmt(x.boundHomeOnly)}</td><td>${fmt(x.boundIncome)}</td><td>${fmt(x.boundPotential)}</td><td>${pct(x.efficiencyHomeOnly)}</td><td>${pct(x.efficiencyIncome)}</td><td>${pct(x.efficiencyPotential)}</td><td>${fmt(x.remote&&x.remote.net)}</td></tr>`).join('')+`</table>`+
   (s.windows.length?`<div style="margin-top:6px;color:#5f6b7a">CP 窗口：${s.windows.slice(-8).map(w=>`<span class="tag">${fmt(w.from)}–${fmt(w.to)}: ${fmt(w.cpRate,2)}/tick（母房 ${fmt(w.homeRate,2)}，${w.rooms} 房）</span>`).join('')}</div>`:'');
  const lv=s.levels.slice().reverse().map(x=>`<div>RCL${x.level} <b>${x.room}</b> @ ${fmt(x.tick)}（+${fmt(x.sincePrev)}）</div>`).join('');
  const cl=Object.entries(s.claims).map(([n,t])=>`<div class="good">占下 <b>${n}</b> @ ${fmt(t)}${s.spawnBuilt[n]!=null?'，spawn @ '+fmt(s.spawnBuilt[n]):''}</div>`).join('');
  const ev=s.events.slice().reverse().map(e=>`<div class="${/fail|restart|signal|no-/.test(e.event)?'bad':''}">${e.event} ${e.t!=null?'t='+fmt(e.t-(r.startTick||0)):''} ${e.room||''} ${e.message?e.message.slice(0,140):''} <small>${e.wall?new Date(e.wall).toLocaleTimeString():''}</small></div>`).join('');
  document.getElementById('events').innerHTML=lv+cl+ev||'—';
  const p=s.probe;
  document.getElementById('probe').innerHTML=p&&p.t!=null?`<div>t=${fmt(p.t)} · spawning ${(p.spawning||[]).join(' ')}${p.errs&&p.errs.length?' <span class=bad>'+p.errs.join(' | ')+'</span>':''}</div>`+
   `<div style="margin:4px 0">${Object.entries(p.rooms).map(([n,x])=>`<span class="tag">${n}${x.mine?' ★RCL'+x.rcl:''} ${x.e!=null?x.e+'/'+x.cap:''} 工地 ${x.sites}${x.hostiles?' <b class=bad>敌 '+x.hostiles+'</b>':''} 地面 ${x.drops||0}${x.cont?' 容器 '+Object.entries(x.cont).map(([k,v])=>k+':'+(v==null?'无':v)).join(' '):''}</span>`).join('')}</div>`+
   `<table><tr><th>名字</th><th>角色</th><th>母房</th><th>房</th><th>位置</th><th>携带</th><th>TTL</th><th>目标房</th></tr>${p.creeps.sort((a,b)=>a.role.localeCompare(b.role)||a.name.localeCompare(b.name)).map(c=>`<tr><td>${c.name}</td><td>${c.role}</td><td>${c.home}</td><td>${c.room}</td><td>${c.x},${c.y}</td><td>${c.carry}</td><td>${c.ttl==null?'孵化中':c.ttl}</td><td>${c.remote}</td></tr>`).join('')}</table>`:'（还没有探针）';
}
async function tick(){try{const s=await (await fetch('/api/state',{cache:'no-store'})).json();render(s);document.title=s.ready?`t=${s.tick} RCL${s.rcl} · RCL 基准`:'RCL 基准看板';setTimeout(tick,(s.refresh||5)*1000);}catch(e){document.getElementById('hdr').innerHTML=`<span class="v">RCL 基准看板</span><span class="k bad">取数失败：${e}</span>`;setTimeout(tick,5000);}}
tick();
</script></body></html>
"""


def make_handler(reader, snapshot_path, refresh_seconds):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # 安静
            pass

        def _send(self, status, body, content_type):
            data = body.encode('utf-8') if isinstance(body, str) else body
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split('?', 1)[0]
            if path == '/api/state':
                try:
                    state = build_state(reader, snapshot_path, refresh_seconds)
                    self._send(200, json.dumps(state, ensure_ascii=False), 'application/json; charset=utf-8')
                except Exception as error:  # 半写的行、暂时缺文件都不能让页面死掉
                    self._send(500, json.dumps({'ready': False, 'error': str(error), 'runDir': reader.run_dir}), 'application/json; charset=utf-8')
            elif path in ('/', '/index.html'):
                self._send(200, PAGE, 'text/html; charset=utf-8')
            else:
                self._send(404, 'not found', 'text/plain; charset=utf-8')
    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--run', help='基准输出目录（默认 data/soak/ 下最新的 rcl-bench-*）')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--refresh', type=int, default=5, help='页面刷新秒数')
    parser.add_argument('--snapshot', default=os.path.join(ROOT, 'data', 'soak', 'live_snapshot.json'))
    args = parser.parse_args(argv)
    run_dir = os.path.abspath(args.run) if args.run else latest_run_dir()
    if not run_dir or not os.path.isdir(run_dir):
        print('no benchmark run directory found', file=sys.stderr)
        return 1
    reader = RunReader(run_dir)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(reader, args.snapshot, args.refresh))
    print(f'dashboard for {run_dir} at http://{args.host}:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
