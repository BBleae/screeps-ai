#!/usr/bin/env python3
"""把 data/report/report_data.json 渲染成单文件 HTML 可视化报告（内联 SVG 图表，无外部脚本）。

用法：python3 scripts/report/build_report.py [--data data/report/report_data.json] [--out data/report/report.html]
      [--since '2026-09-02 20:00'] [--until '2026-09-03 07:00']
"""
import argparse
import html
import json
import os
import re
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BATCHES = [
    ('批 0', '外部大脑基础设施', 'done', 'segment 90 指令通道、intel 合并、ack、launchd 每 5 分钟'),
    ('批 1a', '占领与开荒', 'done', 'claimer / pioneer；W34S7 00:55 占领，05:45 spawn 建成并孵出第一只 harvester'),
    ('批 1b', '外矿放宽', 'done', '单源与二跳外矿、白名单驱动，W32S7 在产'),
    ('布局外置', '离线 RCL8 蓝图', 'done', '蓝图随占领指令下发，W34S7 spawn1 定在 (27,18)'),
    ('批 2', 'NPC 防御', 'done', 'defender / core 清剿、塔压制判断、safe mode 兜底'),
    ('批 3', '矿物 · terminal · lab · 市场', 'todo', '未开始；W33S7 要到 RCL6 才有 terminal'),
    ('批 4', 'NPC 军事 · 跨 shard · Power', 'todo', '未开始'),
    ('复核', 'Claude 定时复核', 'todo', '接口已备（brief.md + locks.json + review_prompt.md），未接定时'),
]

REMAINING = [
    ('批 3 资源链', 'mineralHarvester、hauler 非能量层、terminal 投递、lab 反应链、市场；私服 industry 场景扩展。'),
    ('批 4 军事与跨 shard', '只对 NPC 的 squad、power bank、portal 与 InterShardMemory 最小可用。'),
    ('Claude 定时复核', '用 /schedule 每小时读 data/brain/brief.md，按 review_prompt.md 改 locks.json。'),
    ('W33S7 RCL4 建设期经济观察', 'builder 已按收入封顶、hauler 缺编时 spawn 会等能量；需继续观察 storage 建成前 upgrader 供能容器的空置时间。'),
    ('W34S7 RCL1 → RCL2', '新房 spawn 建成后 harvester 已补到位，但 RCL1 编制没有 upgrader，builder 先建容器/道路工地，控制器进度仍为 0/200；可考虑 RCL1 阶段让 builder 先把控制器升到 RCL2 再建工地。'),
    ('CPU bucket 读数摆动', '02:00 起监控到 bucket 在 500–9,900 之间来回跳，而每 tick 用量稳定在 6–13/140；早于本轮改动，疑为官方服的读数问题，建议看官方 CPU 统计页确认。'),
    ('磁盘清理', 'private-server/worlds 约 1.9 GB（135 个验证世界目录，已 gitignore），可整目录删除。'),
]


def esc(text):
    return html.escape(str(text if text is not None else ''))


def parse_epoch(text, fmt='%Y-%m-%d %H:%M'):
    return time.mktime(time.strptime(text, fmt))


def hhmm(epoch):
    return time.strftime('%H:%M', time.localtime(epoch))


def section_time(title):
    match = re.match(r'(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})', title)
    if not match:
        return None, title
    epoch = parse_epoch(match.group(1) + ' ' + match.group(2))
    rest = title[match.end():].strip()
    rest = re.sub(r'^\S*\s*', '', rest, count=1) if rest.startswith('+') or rest.startswith('Z') else rest
    return epoch, rest


def deploys_from_sections(sections):
    deploys = []
    for section in sections:
        epoch, title = section_time(section['title'])
        if epoch is None:
            continue
        for bullet in section['bullets']:
            if not (bullet.startswith('实测') or bullet.startswith('上线')):
                continue
            for match in re.finditer(r'`(\d{13})`', bullet):
                clock = re.match(r'[^`]{0,12}?于 (\d{2}:\d{2})', bullet[match.end():])
                at = epoch
                if clock:
                    at = parse_epoch(time.strftime('%Y-%m-%d ', time.localtime(epoch)) + clock.group(1))
                    if at < epoch - 3600 * 6:
                        at += 86400
                if any(d['version'] == match.group(1) for d in deploys):
                    continue
                deploys.append({'version': match.group(1), 'at': at, 'title': title})
    return deploys


def deploys_from_timeline(timeline):
    seen = {}
    for row in timeline:
        version = str(row.get('version') or '')
        if version and version not in seen:
            seen[version] = row['epoch']
    return seen


# ---------- SVG helpers ----------

def scale(v, lo, hi, a, b):
    if hi == lo:
        return a
    return a + (v - lo) / (hi - lo) * (b - a)


def polyline(points, cls, close_area=None):
    if not points:
        return ''
    path = 'M' + ' L'.join('%.1f %.1f' % (x, y) for x, y in points)
    out = '<path class="%s" d="%s" fill="none"/>' % (cls, path)
    if close_area is not None:
        area = path + ' L%.1f %.1f L%.1f %.1f Z' % (points[-1][0], close_area, points[0][0], close_area)
        out = '<path class="%s-area" d="%s"/>' % (cls, area) + out
    return out


def time_axis(x0, x1, y, t0, t1, step=3600):
    ticks = []
    start = t0 - (t0 % 3600) + 3600
    t = start
    while t <= t1:
        x = scale(t, t0, t1, x0, x1)
        ticks.append('<line class="grid" x1="%.1f" y1="%d" x2="%.1f" y2="%d"/>' % (x, 18, x, y))
        ticks.append('<text class="tick" x="%.1f" y="%d" text-anchor="middle">%s</text>' % (x, y + 16, hhmm(t)))
        t += step
    return ''.join(ticks)


def chart_level(timeline, t0, t1, deploys):
    """W33S7 控制器等级（RCL + 进度比例）与 W34S7 spawn 工地进度，共用时间轴。"""
    W, H, L, R, T, B = 900, 260, 52, 52, 18, 40
    x0, x1, yb = L, W - R, H - B
    lvl = []
    site = []
    for row in timeline:
        for room in row['rooms']:
            if room['name'] == 'W33S7' and room.get('rcl') and room.get('total'):
                lvl.append((row['epoch'], room['rcl'] + (room.get('progress') or 0) / float(room['total'])))
            if room['name'] == 'W34S7' and room.get('spawnSite') and room['spawnSite'].get('total'):
                site.append((row['epoch'], (room['spawnSite'].get('progress') or 0) / float(room['spawnSite']['total'])))
    if not lvl:
        return '<p class="muted">没有监控时间线数据。</p>'
    lo, hi = 3.0, 4.2
    pts = [(scale(t, t0, t1, x0, x1), scale(v, lo, hi, yb, T)) for t, v in lvl]
    spts = [(scale(t, t0, t1, x0, x1), scale(v, 0, 1, yb, T)) for t, v in site]
    grid = []
    for v in (3.0, 3.5, 4.0):
        y = scale(v, lo, hi, yb, T)
        grid.append('<line class="grid" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>' % (x0, y, x1, y))
        grid.append('<text class="tick" x="%d" y="%.1f" text-anchor="end">RCL %s</text>' % (x0 - 8, y + 4, ('%g' % v)))
    for v in (0.05, 0.1):
        y = scale(v, 0, 1, yb, T)
        grid.append('<text class="tick violet" x="%d" y="%.1f" text-anchor="start">%d%%</text>' % (x1 + 8, y + 4, v * 100))
    marks = []
    for dep in deploys:
        if t0 <= dep['at'] <= t1:
            x = scale(dep['at'], t0, t1, x0, x1)
            marks.append('<line class="deploy" x1="%.1f" y1="%d" x2="%.1f" y2="%d"><title>%s 上线 %s</title></line>'
                         % (x, T, x, yb, hhmm(dep['at']), esc(dep['title'])))
    end = pts[-1]
    end_label = 'RCL %d · %s/%s' % (int(lvl[-1][1]), format(int(round((lvl[-1][1] % 1) * 405000)), ','), '405,000') \
        if int(lvl[-1][1]) == 4 else 'RCL %.2f' % lvl[-1][1]
    svg = ['<svg viewBox="0 0 %d %d" class="chart" role="img" aria-label="W33S7 控制器等级与 W34S7 spawn 工地进度">' % (W, H)]
    svg.append(time_axis(x0, x1, yb, t0, t1))
    svg.extend(grid)
    svg.extend(marks)
    svg.append(polyline(pts, 'gold', close_area=yb))
    if spts:
        svg.append(polyline(spts, 'violet'))
        svg.append('<circle class="dot violet-dot" cx="%.1f" cy="%.1f" r="3.5"/>' % spts[-1])
        svg.append('<text class="label violet" x="%.1f" y="%.1f" text-anchor="end">W34S7 spawn 工地 %d%%</text>'
                   % (spts[-1][0] - 8, spts[-1][1] - 8, site[-1][1] * 100))
    svg.append('<circle class="dot gold-dot" cx="%.1f" cy="%.1f" r="3.5"/>' % end)
    svg.append('<text class="label gold" x="%.1f" y="%.1f" text-anchor="end">W33S7 %s</text>' % (end[0] - 8, end[1] - 10, esc(end_label)))
    svg.append('</svg>')
    return ''.join(svg)


def chart_energy(timeline, t0, t1):
    W, H, L, R, T, B = 900, 170, 52, 52, 18, 40
    x0, x1, yb = L, W - R, H - B
    pts = []
    caps = []
    for row in timeline:
        for room in row['rooms']:
            if room['name'] == 'W33S7' and room.get('cap'):
                pts.append((row['epoch'], room.get('energy') or 0))
                caps.append((row['epoch'], room['cap']))
    if not pts:
        return ''
    hi = max(max(c for _, c in caps), 1000)
    p = [(scale(t, t0, t1, x0, x1), scale(v, 0, hi, yb, T)) for t, v in pts]
    c = [(scale(t, t0, t1, x0, x1), scale(v, 0, hi, yb, T)) for t, v in caps]
    grid = []
    for v in (0, 500, 1000):
        if v > hi:
            continue
        y = scale(v, 0, hi, yb, T)
        grid.append('<line class="grid" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>' % (x0, y, x1, y))
        grid.append('<text class="tick" x="%d" y="%.1f" text-anchor="end">%d</text>' % (x0 - 8, y + 4, v))
    svg = ['<svg viewBox="0 0 %d %d" class="chart" role="img" aria-label="W33S7 spawn 与 extension 可用能量">' % (W, H)]
    svg.append(time_axis(x0, x1, yb, t0, t1))
    svg.extend(grid)
    svg.append(polyline(c, 'cap'))
    svg.append(polyline(p, 'gold', close_area=yb))
    svg.append('<text class="label muted" x="%.1f" y="%.1f" text-anchor="end">容量 %d</text>' % (c[-1][0] - 6, c[-1][1] - 6, caps[-1][1]))
    svg.append('</svg>')
    return ''.join(svg)


def chart_roles(timeline, t0, t1):
    """creep 数量堆叠：经济角色 / 扩张与外矿角色 / 防御。"""
    W, H, L, R, T, B = 900, 170, 52, 52, 18, 40
    x0, x1, yb = L, W - R, H - B
    groups = [
        ('经济', ('harvester', 'hauler', 'upgrader', 'builder', 'scout'), 'g-eco'),
        ('外矿', ('reserver', 'remoteMiner', 'remoteHauler'), 'g-remote'),
        ('扩张', ('claimer', 'pioneer'), 'g-expand'),
        ('防御', ('defender',), 'g-def'),
    ]
    rows = [(row['epoch'], row['roles']) for row in timeline if row.get('roles')]
    if not rows:
        return ''
    hi = max(sum(r.values()) for _, r in rows)
    hi = max(hi, 10)
    layers = []
    base = [0] * len(rows)
    for name, keys, cls in groups:
        top = []
        for i, (_, roles) in enumerate(rows):
            top.append(base[i] + sum(roles.get(k, 0) for k in keys))
        upper = [(scale(t, t0, t1, x0, x1), scale(v, 0, hi, yb, T)) for (t, _), v in zip(rows, top)]
        lower = [(scale(t, t0, t1, x0, x1), scale(v, 0, hi, yb, T)) for (t, _), v in zip(rows, base)]
        path = 'M' + ' L'.join('%.1f %.1f' % p for p in upper) + ' L' + ' L'.join('%.1f %.1f' % p for p in reversed(lower)) + ' Z'
        layers.append('<path class="%s" d="%s"><title>%s</title></path>' % (cls, path, name))
        base = top
    grid = []
    for v in (0, 5, 10, 15, 20):
        if v > hi:
            continue
        y = scale(v, 0, hi, yb, T)
        grid.append('<line class="grid" x1="%d" y1="%.1f" x2="%d" y2="%.1f"/>' % (x0, y, x1, y))
        grid.append('<text class="tick" x="%d" y="%.1f" text-anchor="end">%d</text>' % (x0 - 8, y + 4, v))
    legend = ''.join('<span class="lg"><i class="%s"></i>%s</span>' % (cls, name) for name, _, cls in groups)
    svg = ['<svg viewBox="0 0 %d %d" class="chart" role="img" aria-label="creep 数量按角色组堆叠">' % (W, H)]
    svg.append(time_axis(x0, x1, yb, t0, t1))
    svg.extend(grid)
    svg.extend(layers)
    svg.append('</svg>')
    return '<div class="legend">%s</div>' % legend + ''.join(svg)


def night_band(t0, t1, deploys, validations):
    """页首的整夜时间尺：部署刻度与验证轮次。"""
    W, H = 900, 64
    x0, x1 = 8, W - 8
    out = ['<svg viewBox="0 0 %d %d" class="band" role="img" aria-label="整夜部署与验证时间尺">' % (W, H)]
    out.append('<line class="axis" x1="%d" y1="40" x2="%d" y2="40"/>' % (x0, x1))
    t = t0 - (t0 % 3600) + 3600
    while t <= t1:
        x = scale(t, t0, t1, x0, x1)
        out.append('<line class="axis" x1="%.1f" y1="36" x2="%.1f" y2="44"/>' % (x, x))
        out.append('<text class="tick" x="%.1f" y="58" text-anchor="middle">%s</text>' % (x, hhmm(t)))
        t += 3600
    for run in validations:
        try:
            at = parse_epoch(run['at'])
        except (ValueError, KeyError):
            continue
        if t0 <= at <= t1:
            x = scale(at, t0, t1, x0, x1)
            cls = 'v-ok' if run.get('ok') else 'v-bad'
            out.append('<rect class="%s" x="%.1f" y="22" width="3" height="8"><title>%s %s</title></rect>' % (cls, x - 1.5, esc(run['name']), '通过' if run.get('ok') else '失败'))
    for dep in deploys:
        if t0 <= dep['at'] <= t1:
            x = scale(dep['at'], t0, t1, x0, x1)
            out.append('<circle class="dep" cx="%.1f" cy="40" r="4"><title>%s 上线：%s</title></circle>' % (x, hhmm(dep['at']), esc(dep['title'])))
    out.append('</svg>')
    return ''.join(out)


# ---------- page ----------

def kpi(label, value, unit='', note=''):
    return ('<div class="kpi"><div class="kpi-label">%s</div><div class="kpi-value">%s<span class="kpi-unit">%s</span></div>'
            '<div class="kpi-note">%s</div></div>' % (esc(label), esc(value), esc(unit), esc(note)))


def room_cards(latest):
    cards = []
    for room in latest.get('rooms', []):
        name = room['name']
        if room.get('spawnSite'):
            site = room['spawnSite']
            pct = 100.0 * (site.get('progress') or 0) / max(site.get('total') or 1, 1)
            body = ('<div class="bar"><span style="width:%.1f%%"></span></div>'
                    '<div class="row"><span>spawn1 工地 (27,18)</span><b class="num">%s / %s</b></div>'
                    '<div class="row"><span>开荒工 pioneer</span><b class="num">%d</b></div>'
                    '<div class="row"><span>蓝图</span><b>d1-rcl8-v1（离线生成）</b></div>'
                    % (pct, format(site.get('progress') or 0, ','), format(site.get('total') or 0, ','), latest['roles'].get('pioneer', 0)))
            head = 'RCL %d · 开荒中' % (room.get('rcl') or 0)
        else:
            pct = 100.0 * (room.get('progress') or 0) / max(room.get('total') or 1, 1)
            remotes = room.get('remotes') or []
            sites = room.get('sites') or {}
            body = ('<div class="bar"><span style="width:%.1f%%"></span></div>'
                    '<div class="row"><span>控制器进度</span><b class="num">%s / %s</b></div>'
                    '<div class="row"><span>spawn + extension 能量</span><b class="num">%s / %s</b></div>'
                    '<div class="row"><span>外矿</span><b>%s</b></div>'
                    '<div class="row"><span>在建工地</span><b class="num">%d 个 · %s / %s</b></div>'
                    % (pct, format(room.get('progress') or 0, ','), format(room.get('total') or 0, ','),
                       room.get('energy'), room.get('cap'), esc('、'.join(remotes) or '无'),
                       sites.get('count', 0), format(sites.get('progress', 0), ','), format(sites.get('total', 0), ',')))
            head = 'RCL %d · 母房' % (room.get('rcl') or 0)
        cards.append('<div class="room"><div class="room-head"><span class="room-name">%s</span><span class="pill">%s</span></div>%s</div>' % (esc(name), esc(head), body))
    return ''.join(cards)


def batches_html():
    out = []
    for code, name, state, note in BATCHES:
        cls = {'done': 'st-done', 'todo': 'st-todo', 'part': 'st-part'}[state]
        text = {'done': '已上线', 'todo': '未开始', 'part': '部分'}[state]
        out.append('<div class="batch"><span class="batch-code">%s</span><span class="batch-name">%s</span>'
                   '<span class="state %s">%s</span><span class="batch-note">%s</span></div>' % (esc(code), esc(name), cls, text, esc(note)))
    return ''.join(out)


def changes_html(sections, since_epoch):
    items = []
    for section in sections:
        epoch, title = section_time(section['title'])
        if epoch is None or epoch < since_epoch:
            continue
        problem = next((b for b in section['bullets'] if b.startswith('问题')), '')
        change = next((b for b in section['bullets'] if b.startswith('改动')), '')
        live = next((b for b in section['bullets'] if b.startswith('实测') or b.startswith('上线')), '')
        detail = ''.join('<li>%s</li>' % esc(b) for b in section['bullets'])
        items.append('<li class="change"><time>%s</time><div><div class="change-title">%s</div>'
                     '<p>%s</p>%s<details><summary>全部记录</summary><ul>%s</ul></details></div></li>'
                     % (hhmm(epoch), esc(title), esc(problem[:200] + ('…' if len(problem) > 200 else '')),
                        ('<p class="muted">%s</p>' % esc(change[:220] + ('…' if len(change) > 220 else ''))) if change else '',
                        detail))
    return '<ol class="changes">%s</ol>' % ''.join(items)


def validations_html(runs):
    cells = []
    for run in runs:
        cls = 'ok' if run.get('ok') else 'bad'
        title = '%s · %s%s' % (run['name'], run.get('at', ''), (' · ' + run['error']) if run.get('error') else '')
        cells.append('<span class="vcell %s" title="%s">%s</span>' % (cls, esc(title), esc(re.sub(r'\D', '', run['name']) or '?')))
    return '<div class="vgrid">%s</div>' % ''.join(cells)


def commits_html(commits):
    kinds = {}
    for c in commits:
        kind = c['subject'].split(':', 1)[0].split('(')[0].strip() if ':' in c['subject'] else 'other'
        kinds[kind] = kinds.get(kind, 0) + 1
    order = sorted(kinds.items(), key=lambda kv: -kv[1])
    total = max(sum(kinds.values()), 1)
    bars = ''.join('<div class="kbar"><span class="kname">%s</span><span class="ktrack"><i style="width:%.1f%%"></i></span><span class="num">%d</span></div>'
                   % (esc(k), 100.0 * v / total, v) for k, v in order)
    rows = ''.join('<li><time>%s</time><code>%s</code><span>%s</span></li>' % (esc(c['at'][11:]), esc(c['hash']), esc(c['subject']))
                   for c in commits if not c['subject'].startswith('docs'))
    return bars + '<details class="commits"><summary>非文档提交清单（%d 条）</summary><ul>%s</ul></details>' % (
        len([c for c in commits if not c['subject'].startswith('docs')]), rows)


def remaining_html():
    return '<ul class="remaining">%s</ul>' % ''.join('<li><b>%s</b>%s</li>' % (esc(t), esc(d)) for t, d in REMAINING)


CSS = r"""
:root{
  --bg:#F4F6F9; --surface:#FFFFFF; --ink:#1A222D; --muted:#5B6675; --line:#D9DEE6; --line-soft:#E8ECF1;
  --gold:#C99700; --gold-fill:#F5C518; --violet:#6F4FE0; --good:#2E9E5B; --warn:#D97706; --crit:#D64545;
  --eco:#C9A227; --remote:#5B8DEF; --expand:#8B6BE8; --def:#D64545;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#12171F; --surface:#1A212B; --ink:#E8EDF3; --muted:#98A4B3; --line:#2C3641; --line-soft:#232C37;
    --gold:#F2C94C; --gold-fill:#F2C94C; --violet:#A28BFF; --good:#4CC474; --warn:#F0A030; --crit:#F06B6B;
    --eco:#E0BE45; --remote:#7AA6FF; --expand:#B39DFF; --def:#F06B6B;
  }
}
:root[data-theme="dark"]{
  --bg:#12171F; --surface:#1A212B; --ink:#E8EDF3; --muted:#98A4B3; --line:#2C3641; --line-soft:#232C37;
  --gold:#F2C94C; --gold-fill:#F2C94C; --violet:#A28BFF; --good:#4CC474; --warn:#F0A030; --crit:#F06B6B;
  --eco:#E0BE45; --remote:#7AA6FF; --expand:#B39DFF; --def:#F06B6B;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.6;font-size:15px}
.page{max-width:960px;margin:0 auto;padding:40px 24px 80px}
h1,h2,h3{font-family:"Noto Serif SC","Songti SC","STSong",serif;font-weight:700;text-wrap:balance;margin:0}
h1{font-size:34px;line-height:1.2}
h2{font-size:22px;margin:0 0 14px}
.eyebrow{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
header{display:grid;gap:10px;margin-bottom:8px}
header p{margin:0;max-width:64ch;color:var(--muted)}
.num,code,time,.kpi-value,.tick,.label{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
section{margin-top:44px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:20px}
.kpi{background:var(--surface);border:1px solid var(--line);padding:14px 16px;display:grid;gap:2px}
.kpi-label{font-size:12px;color:var(--muted);letter-spacing:.04em}
.kpi-value{font-size:26px;line-height:1.1}
.kpi-unit{font-size:12px;color:var(--muted);margin-left:4px}
.kpi-note{font-size:12px;color:var(--muted)}
.band{width:100%;height:auto;display:block;margin-top:14px}
.band .axis{stroke:var(--line);stroke-width:1.5}
.band .dep{fill:var(--gold-fill);stroke:var(--bg);stroke-width:1.5}
.band .v-ok{fill:var(--good)} .band .v-bad{fill:var(--crit)}
.chart{width:100%;height:auto;display:block;background:var(--surface);border:1px solid var(--line)}
.tick{font-size:11px;fill:var(--muted)}
.grid{stroke:var(--line-soft);stroke-width:1}
.deploy{stroke:var(--gold);stroke-width:1;stroke-dasharray:2 3;opacity:.8}
.gold{stroke:var(--gold);stroke-width:2}
.gold-area{fill:var(--gold-fill);opacity:.14}
.violet{stroke:var(--violet);stroke-width:2}
.cap{stroke:var(--muted);stroke-width:1;stroke-dasharray:4 3}
.gold-dot{fill:var(--gold)} .violet-dot{fill:var(--violet)}
text.gold{fill:var(--gold);stroke:none} text.violet{fill:var(--violet);stroke:none} text.muted{fill:var(--muted)}
.label{font-size:11.5px}
.g-eco{fill:var(--eco);opacity:.75} .g-remote{fill:var(--remote);opacity:.8} .g-expand{fill:var(--expand);opacity:.8} .g-def{fill:var(--def);opacity:.85}
.legend{display:flex;gap:16px;font-size:12px;color:var(--muted);margin:0 0 6px}
.lg i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px}
.lg .g-eco{background:var(--eco)} .lg .g-remote{background:var(--remote)} .lg .g-expand{background:var(--expand)} .lg .g-def{background:var(--def)}
.caption{font-size:13px;color:var(--muted);margin:8px 0 0;max-width:70ch}
.rooms{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.room{background:var(--surface);border:1px solid var(--line);padding:16px 18px;display:grid;gap:8px;align-content:start}
.room-head{display:flex;justify-content:space-between;align-items:baseline}
.room-name{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:20px}
.pill{font-size:12px;color:var(--muted);border:1px solid var(--line);padding:1px 8px;border-radius:999px}
.bar{height:6px;background:var(--line-soft);overflow:hidden}
.bar span{display:block;height:100%;background:var(--gold-fill)}
.row{display:flex;justify-content:space-between;gap:12px;font-size:14px}
.row span{color:var(--muted)}
.batches{display:grid;gap:0;border-top:1px solid var(--line)}
.batch{display:grid;grid-template-columns:72px 200px 64px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);align-items:baseline;font-size:14px}
.batch-code{font-family:"JetBrains Mono",ui-monospace,monospace;color:var(--muted)}
.batch-note{color:var(--muted);font-size:13px}
.state{font-size:12px;padding:1px 8px;border-radius:999px;justify-self:start;white-space:nowrap}
.st-done{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
.st-todo{background:color-mix(in srgb,var(--muted) 18%,transparent);color:var(--muted)}
.st-part{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.changes{list-style:none;margin:0;padding:0;border-left:2px solid var(--line);display:grid;gap:18px}
.change{display:grid;grid-template-columns:64px 1fr;gap:10px;padding-left:14px;position:relative}
.change::before{content:"";position:absolute;left:-6px;top:9px;width:8px;height:8px;border-radius:50%;background:var(--gold-fill);border:1px solid var(--bg)}
.change time{color:var(--muted);font-size:13px;padding-top:2px}
.change-title{font-weight:600}
.change p{margin:4px 0 0;font-size:14px;max-width:70ch}
.change details{margin-top:4px;font-size:13px;color:var(--muted)}
.change summary{cursor:pointer}
.change ul{padding-left:18px;margin:6px 0 0}
.vgrid{display:flex;flex-wrap:wrap;gap:6px}
.vcell{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;width:34px;height:28px;display:grid;place-items:center;border:1px solid var(--line)}
.vcell.ok{background:color-mix(in srgb,var(--good) 20%,transparent);color:var(--good)}
.vcell.bad{background:color-mix(in srgb,var(--crit) 20%,transparent);color:var(--crit)}
.kbar{display:grid;grid-template-columns:70px 1fr 40px;gap:10px;align-items:center;font-size:13px;margin:4px 0}
.ktrack{height:8px;background:var(--line-soft)} .ktrack i{display:block;height:100%;background:var(--gold-fill)}
.commits summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:10px}
.commits ul{list-style:none;padding:0;margin:8px 0 0;font-size:13px;display:grid;gap:3px}
.commits li{display:grid;grid-template-columns:48px 70px 1fr;gap:10px}
.commits time,.commits code{color:var(--muted)}
.remaining{padding-left:0;list-style:none;display:grid;gap:10px;max-width:72ch}
.remaining li b{display:block;font-weight:600}
.muted{color:var(--muted)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px}
@media (max-width:700px){.two{grid-template-columns:1fr}.batch{grid-template-columns:60px 1fr 60px;}.batch-note{grid-column:1/-1}.commits li{grid-template-columns:48px 1fr}.commits code{display:none}}
:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
"""


def build(data, since, until):
    t0 = parse_epoch(since)
    t1 = parse_epoch(until)
    timeline = [r for r in data['timeline'] if t0 <= r['epoch'] <= t1 + 3600]
    latest = timeline[-1] if timeline else {'rooms': [], 'roles': {}}
    deploys = deploys_from_sections(data['sections'])
    seen = deploys_from_timeline(timeline)
    known = {d['version'] for d in deploys}
    for version, at in seen.items():
        if version not in known and at >= t0:
            deploys.append({'version': version, 'at': at, 'title': '版本 ' + version})
    deploys.sort(key=lambda d: d['at'])
    validations = [v for v in data['validations'] if v.get('at') and parse_epoch(v['at']) >= t0 - 1800]
    v_ok = sum(1 for v in validations if v.get('ok'))
    commits = data['commits']
    errors_total = sum(r.get('errors') or 0 for r in timeline)
    home = next((r for r in latest['rooms'] if r['name'] == 'W33S7'), {})
    rcl_change = None
    first_home = next((rm for row in timeline for rm in row['rooms'] if rm['name'] == 'W33S7'), None)
    if first_home and home:
        rcl_change = '%d → %d' % (first_home.get('rcl') or 0, home.get('rcl') or 0)
    cpu_avg = sum(r.get('cpu') or 0 for r in timeline) / max(len(timeline), 1)

    parts = []
    parts.append('<title>W33S7 夜航报告</title><meta name="description" content="Screeps shard1 W33S7 一夜的部署、扩张与验证记录">')
    parts.append('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700&family=Noto+Sans+SC:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap">')
    parts.append('<style>%s</style>' % CSS)
    parts.append('<div class="page">')
    parts.append('<header><div class="eyebrow">shard1 · %s · GCL %s · %s 至 %s JST</div>' % (
        esc((data.get('brain') or {}).get('me') or 'BBleae'), esc((data.get('brain') or {}).get('gcl') or ''), since[5:], until[5:]))
    parts.append('<h1>W33S7 夜航报告</h1>')
    parts.append('<p>从接手到东京时间 07:00 的全部工作：把侦察、规划、蓝图搬到游戏外的「外部大脑」，'
                 '按批次补齐占领、外矿、防御，并把每一版都过私服验证后推到线上。</p>')
    parts.append(night_band(t0, t1, deploys, validations))
    parts.append('<p class="caption">时间尺上的圆点是上线的版本（悬停看标题），上方短条是私服验证轮次（绿通过、红失败）。</p></header>')

    parts.append('<section><div class="kpis">')
    parts.append(kpi('W33S7 控制器', rcl_change or ('RCL %s' % home.get('rcl')), '', '02:20 升到 RCL4'))
    parts.append(kpi('拥有房间', '%d' % len(latest['rooms']), '间', 'W34S7 于 00:55 占领'))
    parts.append(kpi('上线版本', '%d' % len(deploys), '次', '全部经私服验证'))
    parts.append(kpi('私服验证', '%d / %d' % (v_ok, len(validations)), '通过', '10 个场景 × 1400 tick'))
    parts.append(kpi('测试', '%d + %d' % (data['tests']['smokeAsserts'], data['tests']['pythonTests']), '', 'smoke 断言 + Python 用例'))
    parts.append(kpi('线上错误', '%d' % errors_total, '条', '监控采样 %d 次 · CPU 均 %.1f/140' % (len(timeline), cpu_avg)))
    parts.append('</div></section>')

    parts.append('<section><h2>控制器与开荒进度</h2>')
    parts.append(chart_level(timeline, t0, t1, deploys))
    parts.append('<p class="caption">金色是 W33S7 的控制器等级（RCL + 当前进度占比，RCL4 需要 405,000 点），紫色是 W34S7 spawn1 工地的完成度（15,000 点）。虚线竖线是上线时刻。</p>')
    parts.append('<h3 style="margin-top:22px;font-size:16px">spawn 与 extension 可用能量</h3>')
    parts.append(chart_energy(timeline, t0, t1))
    parts.append('<p class="caption">RCL4 后容量从 800 升到 950；建设期能量长期贴地，是 builder 与外矿/开荒孵化同时抢能量的结果，后半夜已把 builder 按收入封顶。</p>')
    parts.append('<h3 style="margin-top:22px;font-size:16px">creep 编制</h3>')
    parts.append(chart_roles(timeline, t0, t1))
    parts.append('</section>')

    parts.append('<section><h2>房间现状</h2><div class="rooms">%s</div></section>' % room_cards(latest))

    parts.append('<section><h2>批次完成度</h2><div class="batches">%s</div></section>' % batches_html())

    brain = data.get('brain') or {}
    if brain:
        homes = brain.get('homes') or {}
        lines = []
        for name, info in homes.items():
            lines.append('<div class="row"><span>%s（RCL %s）</span><b>外矿 %s · 占领 %s · %s</b></div>' % (
                esc(name), esc(info.get('level')), esc('、'.join(info.get('remotes') or []) or '无'),
                esc(info.get('claim') or '无'), esc(info.get('blocked') or '可占领')))
        parts.append('<section><h2>外部大脑最近一轮</h2><div class="room">'
                     '<div class="row"><span>游戏 tick</span><b class="num">%s</b></div>'
                     '<div class="row"><span>情报房间</span><b class="num">%s</b></div>%s'
                     '<div class="row"><span>写入</span><b>%s</b></div>'
                     '<div class="row"><span>API 调用</span><b class="num">%s</b></div></div>'
                     '<p class="caption">大脑每 5 分钟由 launchd 运行一次，把情报与指令写进 memory segment 90；游戏内只校验、合并并回执，指令过期时自动回退到自治逻辑。</p></section>'
                     % (esc(brain.get('tick')), esc(max((i.get('intelRooms') or 0) for i in homes.values()) if homes else 0),
                        ''.join(lines), esc(brain.get('wrote')), esc(brain.get('apiCalls'))))

    parts.append('<section><h2>改动时间线</h2>%s</section>' % changes_html(data['sections'], t0))

    parts.append('<section class="two"><div><h2>私服验证</h2>%s<p class="caption">每轮跑 10 个场景（经济、恢复、蓝图、外矿、大脑、占领、防御等），断言行为而不只是「不崩」。</p></div>'
                 '<div><h2>提交</h2>%s</div></section>' % (validations_html(validations), commits_html(commits)))

    parts.append('<section><h2>遗留事项</h2>%s</section>' % remaining_html())
    parts.append('<p class="caption" style="margin-top:40px">生成于 %s JST · 数据来自 logs/status.jsonl、logs/optimizations.md、git log 与私服验证日志。</p>' % esc(data.get('generatedAt')))
    parts.append('</div>')
    return '\n'.join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', default=os.path.join(ROOT, 'data', 'report', 'report_data.json'))
    parser.add_argument('--out', default=os.path.join(ROOT, 'data', 'report', 'report.html'))
    parser.add_argument('--since', default='2026-09-02 20:00')
    parser.add_argument('--until', default='2026-09-03 07:00')
    args = parser.parse_args()
    data = json.load(open(args.data))
    page = build(data, args.since, args.until)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as handle:
        handle.write(page)
    print(json.dumps({'out': args.out, 'bytes': len(page.encode())}))


if __name__ == '__main__':
    main()
