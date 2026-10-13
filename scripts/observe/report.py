"""把快照摘要渲染成 Markdown 观察报告（docs/observe/<player>.md）。纯函数，便于测试。"""
import collections


def _fmt(value, digits=1):
    if value is None:
        return '-'
    if isinstance(value, float):
        return ('%%.%df' % digits) % value
    if isinstance(value, int) and abs(value) >= 10000:
        return '{:,}'.format(value)
    return str(value)


def _rates_lines(label, rates):
    if not rates:
        return ['- %s：无数据' % label]
    lines = ['- %s（窗口 %s 分钟 ≈ %s tick）：每房每 tick 采能 %s、控制器 %s、creep %s、建造 %s；'
             '控制器占比 %s、creep 占比 %s、建造占比 %s；每房每小时部件 %s，每部件能量 %s，每千部件损失 %s，power %s' % (
                 label, _fmt(rates.get('windowMinutes')), _fmt(rates.get('ticks')),
                 _fmt(rates.get('harvestPerRoomTick')), _fmt(rates.get('controlPerRoomTick')),
                 _fmt(rates.get('creepsPerRoomTick')), _fmt(rates.get('constructionPerRoomTick')),
                 _fmt(rates.get('controlShare'), 3), _fmt(rates.get('creepShare'), 3),
                 _fmt(rates.get('constructionShare'), 3), _fmt(rates.get('partsPerRoomHour')),
                 _fmt(rates.get('energyPerPart')), _fmt(rates.get('lostPerKParts'), 2),
                 _fmt(rates.get('powerProcessed')))]
    return lines


def render_markdown(summary, timeline=None, ascii_maps=None, max_rooms=100):
    profile = summary.get('profile') or {}
    aggregate = summary.get('aggregate') or {}
    lines = ['# %s 观察报告' % summary.get('player'), '',
             '自动生成于 %s（scripts/observe/run.py）。数据全部来自官方只读 API 与公开 room-history。' % summary.get('capturedAt'),
             '']
    lines.append('## 账号')
    ranks = profile.get('ranks') or {}
    lines.append('- GCL %s，power %s；房间 %s（%s）。' % (
        _fmt(profile.get('gcl')), _fmt(profile.get('power')), _fmt(profile.get('rooms')),
        '，'.join('%s %d' % (shard, len(rooms)) for shard, rooms in (profile.get('roomsByShard') or {}).items())))
    if ranks:
        lines.append('- 名次：' + '；'.join('%s 榜 %s 赛季 rank %s' % (mode, r.get('season'), r.get('rank'))
                                            for mode, r in ranks.items()))
    if aggregate:
        lines.append('- RCL 分布 %s；每房 creep 均值 %s（%s–%s）；spawn 忙碌 %s/%s。' % (
            aggregate.get('rcl'), _fmt(aggregate.get('creepsPerRoom', {}).get('mean')),
            _fmt(aggregate.get('creepsPerRoom', {}).get('min')), _fmt(aggregate.get('creepsPerRoom', {}).get('max')),
            _fmt(aggregate.get('spawnsBusy')), _fmt(aggregate.get('spawnsTotal'))))
    lines.append('')

    lines.append('## 能量与产出速率')
    for interval, label in (('8', '约 1 小时'), ('180', '约 24 小时'), ('1440', '约 8 天')):
        lines.extend(_rates_lines(label, (summary.get('rates') or {}).get(interval)))
    if summary.get('selfRates'):
        lines.append('')
        lines.append('我方同口径（对照）：')
        for interval, label in (('8', '约 1 小时'), ('180', '约 24 小时'), ('1440', '约 8 天')):
            lines.extend(_rates_lines(label, (summary.get('selfRates') or {}).get(interval)))
    lines.append('')

    lines.append('## 身体原型（角色 → 签名 × 数量）')
    for role, sigs in sorted((summary.get('archetypes') or {}).items(), key=lambda kv: -sum(kv[1].values())):
        lines.append('- %s：%s' % (role, '，'.join('%s×%d' % (sig, n) for sig, n in list(sigs.items())[:6])))
    lines.append('')

    if aggregate:
        lines.append('## 布局与结构')
        lines.append('- link 用途分布 %s（source=距源≤2，hub=距 storage≤2，controller=距控制器≤3，edge=贴房间边）。' % (
            aggregate.get('linkKinds')))
        lines.append('- 核心外接矩形面积中位数 %s（%s–%s）；storage→controller 距离中位数 %s（最大 %s）；'
                     'storage→源 距离中位数 %s（最大 %s）。' % (
                         _fmt((aggregate.get('coreArea') or {}).get('median')),
                         _fmt((aggregate.get('coreArea') or {}).get('min')),
                         _fmt((aggregate.get('coreArea') or {}).get('max')),
                         _fmt((aggregate.get('storageToController') or {}).get('median')),
                         _fmt((aggregate.get('storageToController') or {}).get('max')),
                         _fmt((aggregate.get('storageToSource') or {}).get('median')),
                         _fmt((aggregate.get('storageToSource') or {}).get('max'))))
        lines.append('- storage 能量中位数 %s（%s–%s）；rampart 数中位数 %s（最大 %s）。' % (
            _fmt((aggregate.get('storageEnergy') or {}).get('median')),
            _fmt((aggregate.get('storageEnergy') or {}).get('min')),
            _fmt((aggregate.get('storageEnergy') or {}).get('max')),
            _fmt((aggregate.get('ramparts') or {}).get('median')), _fmt((aggregate.get('ramparts') or {}).get('max'))))
        lines.append('- 角色总数 %s。' % aggregate.get('rolesTotal'))
        lines.append('')

    remotes = summary.get('remotes') or {}
    if remotes:
        lines.append('## 外矿拓扑（由 creep 名推断）')
        counts = [len(v) for v in remotes.values()]
        lines.append('- %d 个母房有外矿 creep，每母房外矿数均值 %.1f（最多 %d）。' % (
            len(remotes), sum(counts) / float(len(counts)), max(counts)))
        for home, targets in sorted(remotes.items())[:12]:
            lines.append('- %s → %s' % (home, '，'.join('%s(%s)' % (room, ','.join('%s%d' % (r, n) for r, n in roles.items()))
                                                     for room, roles in sorted(targets.items()))))
        lines.append('')
    remote_rooms = summary.get('remoteRooms') or []
    if remote_rooms:
        lines.append('## 抓到的外矿房')
        for rr in remote_rooms:
            lines.append('- %s/%s（母房 %s）：预定剩余 %s，源 %d，容器 %s，道路 %d，入侵者 %d，核心 %s，我方 creep %s' % (
                rr.get('shard'), rr.get('room'), rr.get('home'), _fmt(rr.get('reservationLeft')),
                len(rr.get('sources') or []),
                '/'.join(str(c.get('energy')) for c in rr.get('containers') or []) or '无',
                rr.get('roads') or 0, rr.get('invaders') or 0, rr.get('invaderCore'),
                (rr.get('creeps') or {}).get('roles')))
        lines.append('')

    histories = summary.get('history') or []
    if histories:
        lines.append('## 100 tick 行为回放')
        for hist in histories:
            lines.append('- %s（base %s，%s tick）：源采集速率 %s；spawn 事件 %s' % (
                hist.get('room'), hist.get('base'), hist.get('ticks'),
                '/'.join(str(v) for v in (hist.get('sourceHarvestPerTick') or {}).values()) or '-',
                '，'.join('%s(needTime %s)' % (e.get('role'), e.get('needTime')) for e in hist.get('spawnEvents') or [])
                or '无'))
            for role, stat in sorted((hist.get('roles') or {}).items()):
                lines.append('  - %s ×%d：每 tick 移动 %s，每 tick 卸货 %s，卸货对象 %s' % (
                    role, stat.get('creeps'), _fmt(stat.get('movesPerTick'), 3), _fmt(stat.get('unloadedPerTick'), 2),
                    stat.get('unloadTargets')))
        lines.append('')

    diff = summary.get('diff') or {}
    if diff and not diff.get('first'):
        lines.append('## 与上一轮的变化')
        for key, value in diff.items():
            lines.append('- %s：%s' % (key, value))
        lines.append('')

    rooms = summary.get('roomList') or []
    if rooms:
        lines.append('## 房间一览')
        for room in rooms[:max_rooms]:
            structures = room.get('structures') or {}
            lines.append('- %s/%s RCL%s：creep %d %s；storage %s，terminal %s；link %s；塔 %d（均 %s）；'
                         'rampart %d（均 %s）；lab %d；spawn 忙 %d/%d；核心 %sx%s；storage→ctrl %s' % (
                             room.get('shard'), room.get('room'), room.get('rcl'), room['creeps']['count'],
                             room['creeps']['roles'], _fmt(room.get('storageEnergy')), _fmt(room.get('terminalEnergy')),
                             room.get('linkKinds'), room['towers']['n'], _fmt(room['towers']['energyMean']),
                             room['ramparts']['n'], _fmt(room['ramparts']['hitsMean']), room['labs']['n'],
                             room['spawns']['busy'], room['spawns']['n'],
                             (room.get('core') or {}).get('w'), (room.get('core') or {}).get('h'),
                             _fmt((room.get('distances') or {}).get('storageToController'))))
        lines.append('')

    if ascii_maps:
        lines.append('## 布局示例')
        for key, text in ascii_maps.items():
            lines.append('%s：' % key)
            lines.append('')
            lines.append('```')
            lines.append(text)
            lines.append('```')
            lines.append('')

    if timeline:
        lines.append('## 时间线（每轮一行）')
        for entry in timeline[-60:]:
            lines.append('- %s：GCL %s，房 %s，每房每 tick 采能 %s，控制器占比 %s，每部件能量 %s' % (
                entry.get('capturedAt'), _fmt(entry.get('gcl')), _fmt(entry.get('rooms')),
                _fmt(entry.get('harvestPerRoomTick')), _fmt(entry.get('controlShare'), 3),
                _fmt(entry.get('energyPerPart'))))
        lines.append('')
    return '\n'.join(lines)


def timeline_entry(summary):
    rates = (summary.get('rates') or {}).get('8') or {}
    profile = summary.get('profile') or {}
    return {'capturedAt': summary.get('capturedAt'), 'gcl': profile.get('gcl'), 'power': profile.get('power'),
            'rooms': profile.get('rooms'), 'rank': ((profile.get('ranks') or {}).get('world') or {}).get('rank'),
            'harvestPerRoomTick': rates.get('harvestPerRoomTick'), 'controlShare': rates.get('controlShare'),
            'creepShare': rates.get('creepShare'), 'energyPerPart': rates.get('energyPerPart'),
            'partsPerRoomHour': rates.get('partsPerRoomHour'),
            'creepsPerRoom': ((summary.get('aggregate') or {}).get('creepsPerRoom') or {}).get('mean'),
            'archetypeCount': sum(len(v) for v in (summary.get('archetypes') or {}).values())}


def role_totals(summary):
    totals = collections.Counter()
    for room in summary.get('roomList') or []:
        totals.update(room['creeps']['roles'])
    return dict(totals.most_common())
