"""Independent outcome checks and durable incident state for sparse live observations.

No snapshot-derived exact profit, exact drop age, or continuous uptime claims.
Rules use stable IDs; missing observations cannot close incidents.
"""
import hashlib
import json
import os
import re
import time


def number(value, default=0):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def active(remote, tick):
    return remote.get('enabled', True) and number(remote.get('suspendedUntil')) <= tick


def prior(mon, history):
    # Prefer a >=30 tick window within this deployment, so a 3-sample burst can
    # compare its endpoints instead of repeatedly comparing two adjacent ticks.
    newest = None
    for row in reversed(history):
        old = row.get('mon') or {}
        if old.get('scriptV') != mon.get('scriptV'):
            break
        delta = number(mon.get('t')) - number(old.get('t'))
        if delta <= 0:
            continue
        if newest is None:
            newest = old
        if delta >= 30:
            return old
    return newest


# bucket 低于这个值，下一次尖峰就可能付不起：引擎在 bucket 用尽后按 cpuLimit 硬切，脚本中途被打断。
CPU_BUCKET_FLOOR = 1000


def cpu_emergency(mon, history, check):
    """Sustained over-limit CPU or a drained bucket.

    The single-tick reading in monitor.py tolerates spikes a healthy bucket can fund;
    this rule looks at the statsTail window (several 30-tick averages written in game),
    so a probe-inflated sample alone cannot raise it. Missing data is not a clean check.
    """
    limit = number(mon.get('cpuLimit'))
    tail = [s for s in mon.get('statsTail') or [] if isinstance(s, dict)]
    cpus = [number(s.get('cpu'), None) for s in tail]
    cpus = [c for c in cpus if c is not None]
    bucket = mon.get('bucket')
    if not limit or not cpus or not isinstance(bucket, (int, float)) or isinstance(bucket, bool):
        return
    average = sum(cpus) / len(cpus)
    # generatePixel 一次扣 10000 bucket：本轮像素增加、且平均 CPU 没超限时，低 bucket 是正在回填，不是透支
    previous = (history[-1].get('mon') or {}) if history else {}
    pixel = (isinstance(mon.get('px'), (int, float)) and isinstance(previous.get('px'), (int, float)) and
             mon['px'] > previous['px'])
    drained = bucket < CPU_BUCKET_FLOOR and not (pixel and average <= limit)
    ticks = [number(s.get('t')) for s in tail if number(s.get('t'))]
    window = f'{min(ticks)}-{max(ticks)}' if ticks else '?'
    check('global', 'cpu-emergency', average > limit or drained,
          f'CPU 紧急：statsTail({window}) 平均 {average:.1f}/{limit}，bucket {bucket}',
          '按 cpuBy/cpuRoles 找增量来源（新外矿、creep 数、寻路），先止血（减外矿/降频）再优化；'
          'bucket 见底时引擎会中途打断 tick', urgent=True)


def relief_hint(room, prev, upgraders, old, now):
    """两次采样同 ID 空载升级者站在 link 迁移目标上、且房间迁移计数增长：是一条线索，不是动作轨迹。

    2026-10-13 起 linkReliefSpot 对已在 link 旁的升级者早返回、原地取能（记 linkReliefInPlace），
    不再给它派位；再出现这个形状说明修复没在线上或回归了。
    """
    if not prev or not old:
        return ''
    current = room.get('linkRelief')
    earlier = prev.get('linkRelief')
    if not isinstance(current, dict) or not isinstance(earlier, dict):
        return ''
    # 两个事件都必须是各自采样时刻 5 tick 内的新鲜记录，坐标在房间内
    for event, tick in [(current, now), (earlier, number(old.get('t')))]:
        if not 0 <= tick - number(event.get('at'), -1e9) <= 5:
            return ''
        if not all(0 <= number(event.get(axis), -1) <= 49 for axis in ('x', 'y')):
            return ''
    if number(current.get('n')) <= number(earlier.get('n')):
        return ''
    target = f"{current['x']},{current['y']}"
    if target != f"{earlier['x']},{earlier['y']}":
        return ''
    prior_workers = {c.get('id'): c for c in old.get('creeps', []) if c.get('id')}
    for creep in upgraders:
        before = prior_workers.get(creep.get('id')) or {}
        if (creep.get('energy') == 0 and before.get('energy') == 0 and
                creep.get('pos') == before.get('pos') == target and
                before.get('role') == 'upgrader' and not before.get('spawning') and
                before.get('room') == before.get('home') == room['name']):
            return (' 两次采样同ID空载且位置等于Link迁移目标，房间迁移计数增长；'
                    '原地迁移应已由linkReliefSpot早返回（linkReliefInPlace）拦下，优先核对线上版本是否含该修复、是否回归。'
                    '该线索不证明区间连续卡死。')
    return ''


def assess(mon, history):
    now = number(mon.get('t'))
    old = prior(mon, history)
    dt = now - number((old or {}).get('t')) if old else 0
    previous = {r['name']: r for r in (old or {}).get('rooms', [])}
    findings, checked = [], []
    coverage = {'schema': mon.get('schema'), 'sameVersionTicks': dt,
                'sampling': '离散快照；不能证明区间零断档',
                'economy': '未知：未覆盖所有出生/交付/维护/防御事件，禁止计算线上净利润'}

    def check(scope, rule, condition, message, action, urgent=False, severity=None):
        key = scope + ':' + rule
        checked.append(key)
        if condition:
            findings.append({'key': key, 'scope': scope, 'rule': rule,
                             'message': message, 'action': action,
                             'severity': severity or ('urgent' if urgent else 'investigate')})

    check('monitor', 'coverage', mon.get('schema') != 4,
          '缺少新版供能/路径/地面资源字段', '修复采集并重新采样；不可报告健康')
    last_epoch = number(history[-1].get('sampledAt')) if history else 0
    if not last_epoch and history:
        try:
            last_epoch = time.mktime(time.strptime(history[-1]['at'], '%Y-%m-%d %H:%M:%S'))
        except (KeyError, ValueError):
            pass
    check('monitor', 'cadence', bool(last_epoch and time.time() - last_epoch > 90 * 60),
          '距上次成功采集超过90分钟，监控存在空窗', '核对定时任务执行记录/主机在线情况，补采样并记录空窗')
    check('monitor', 'tick', bool(history and now <= number((history[-1].get('mon') or {}).get('t'))),
          '游戏tick没有前进，可能暂停/回退/重复采样', '检查服务器与探针；不据此关闭旧告警')
    # 固定的覆盖声明，每轮都成立：记为 info（observing），常驻账本但不触发退出码。
    check('monitor', 'economy-coverage', True,
          '线上完整能量账不可用；交付或回收计数不能证明净收益',
          '查看最新固定源码私服账本；异常外矿用同快照连续窗口按真实ID核算出生、交付、维护与防御，记录报告路径',
          severity='info')
    cpu_emergency(mon, history, check)
    for room in mon.get('rooms', []):
        name = room['name']
        prev = previous.get(name)
        workers = [c for c in mon.get('creeps', []) if c.get('home') == name and not c.get('spawning')]
        upgraders = [c for c in workers if c.get('role') == 'upgrader' and c.get('room') == name]
        work = sum(number(c.get('work')) for c in upgraders)
        buffer = number(room.get('storage')) + sum(number((s.get('container') or {}).get('energy')) +
                 number((s.get('link') or {}).get('energy')) for s in room.get('sources', []))
        measured_rate = None
        if prev and dt >= 30 and prev.get('rcl') == room.get('rcl'):
            progress = number(room.get('prog')) - number(prev.get('prog'))
            if progress >= 0:
                measured_rate = progress / dt
        if mon.get('schema') == 4:
            leg = room.get('upgraderLeg')
            # Cache refresh is 100 ticks; a 50-part spawn can occupy another 150.
            # Missing/stale telemetry is not evidence that an old route issue recovered.
            if (work > 0 and isinstance(leg, dict) and isinstance(leg.get('complete'), bool) and
                    0 <= now - number(leg.get('at'), -1e9) <= 300):
                check(name, 'upgrader-route', not leg['complete'] or number(leg.get('ticks'), -1) < 0,
                      '升级者接班完整路线估算不可用；不能用未知路程反复增员',
                      '检查实际孵化器、工作站位、道路/障碍工地及寻路预算；保存实际轨迹，复现后修复')
            wait = room.get('spawnWaiting') or {}
            spawn_waiting = (number(wait.get('cost')) > number(room.get('energy')) and
                             0 <= now - number(wait.get('at')) <= 5)
            # A deliberate spawn reservation is not positive evidence of recovered supply.
            # Defer this rule; queue timeout and development checks still run independently.
            # A walking successor is not a consumer at the controller yet.
            # Unknown positions or an empty station cannot establish recovery.
            ranges_known = all(0 <= number(c.get('ctrlRange'), -1) <= 49 for c in upgraders)
            stationed = [c for c in upgraders if 0 <= number(c.get('ctrlRange'), -1) <= 3]
            station_work = sum(number(c.get('work')) for c in stationed)
            empty_work = sum(number(c.get('work')) for c in stationed if c.get('energy') == 0)
            if not spawn_waiting and ranges_known and station_work > 0:
                check(name, 'supply-mismatch', empty_work >= station_work / 2 and buffer >= 500 and
                      (measured_rate is None or measured_rate < station_work * .5),
                      f'升级范围内空载WORK={empty_work}/{station_work}，可见仓储/源缓存={buffer}；存在供需错位嫌疑',
                      '短窗重复采样，检查取货候选、投递目标、距离、Link/仓库模式及实际升级增量；复现后修复' +
                      relief_hint(room, prev, upgraders, old, now))
            check(name, 'harvest-capacity', any(number(s.get('workDeficit')) > 0 for s in room.get('sources', [])),
                  '源采集WORK低于容量目标，角色存在不代表吞吐充分',
                  '核对替补到位/伤残/路程及源再生前余量，不凭瞬时缺口直接加人')
            budget = (room.get('economy') or {}).get('remoteRoadBudget') or {}
            check(name, 'road-budget', number(budget.get('maxTripSpent')) > 50,
                  f"外矿每趟修路支出记录越界: {budget.get('maxTripSpent')}",
                  '核对版本与记账边界，私服复现预算失效；不得通过清空计数消除告警', urgent=True)
        if prev and dt >= 30 and prev.get('rcl') == room.get('rcl') and 0 < number(room.get('rcl')) < 8:
            delta = number(room.get('prog')) - number(prev.get('prog'))
            if delta >= 0:
                rate = delta / dt
                check(name, 'development-stalled', work > 0 and rate == 0 and dt >= 100,
                      f'同版本{dt}ticks升级无进展，已建/在建工地不屏蔽此项',
                      '核对建设预算与升级目标，检查供能和行走停滞，保存快照复现')
                # WORK is a capacity upper bound; boost and travel are reasons to investigate, not assert a bug.
                check(name, 'upgrade-underuse', work > 0 and rate < work * .35 and buffer >= 1000 and dt >= 100,
                      f'同版本升级{rate:.2f}/tick，当前WORK={work}、缓存={buffer}，吞吐利用偏低',
                      '比较多窗口WORK编制变化/搬运/建设支出；固定快照A/B验证，不把WORK上界当保证产量')
        for remote in room.get('remotes', []):
            scope = name + '/' + remote['room']
            if not active(remote, now):
                # Deliberate suspension retires applicability, not proof the original bug was fixed.
                continue
            if mon.get('schema') != 4:
                continue
            visible = remote.get('visible') is True
            check(scope, 'visibility', not visible,
                  '外矿无当前视野，预定/掉落/容器现状未知', '核对上次情报与在途单位，补可见快照；不得把未知当正常')
            routes = remote.get('routes') or []
            bad = [s.get('id') for s in routes if s.get('incomplete') or number(s.get('version')) < 3 or number(s.get('distance')) <= 0]
            check(scope, 'route', bool(bad) or (bool(routes) and (remote.get('controllerDistanceIncomplete') or
                  number(remote.get('controllerDistanceVersion')) < 3 or number(remote.get('controllerDistance')) <= 0)),
                  f'完整路径/缓存版本不满足要求，源={bad}',
                  '检查跨房探索预算、可达性、缓存重试及版本迁移；复现实际路线，不以人数正常代替可达')
            drop = remote.get('drop') or {}
            check(scope, 'drop-route', bool(routes) and number(drop.get('distanceVersion')) < 3,
                  '卸货目的地路径缓存未迁移', '核对实际卸货房、路径完整性与缓存刷新')
            check(scope, 'road-complete', any(s.get('roadComplete') and number(s.get('roadTiles')) <= 0 for s in routes),
                  '道路标记完成但没有道路路径', '核对全程可见道路，不允许空计划算完成', urgent=True)
            if not visible:
                continue
            reservation = remote.get('reservation') or {}
            mine = reservation.get('username') == mon.get('username') and bool(mon.get('username'))
            remaining = max(0, number(reservation.get('ticksToEnd')) - max(0, now - number(reservation.get('seenAt'), now))) if mine else 0
            reservers = [c for c in workers if c.get('role') == 'reserver' and c.get('remoteRoom') == remote['room']]
            stationed = [c for c in reservers if c.get('room') == remote['room'] and
                          c.get('ctrlRange') is not None and c['ctrlRange'] <= 1 and number(c.get('claim')) > 0]
            # A present CLAIM can sustain a countdown while alive; merely being in the room cannot.
            coverage_ticks = remaining + max([number(c.get('ttl')) for c in stationed] or [0])
            lead = max(50, number(remote.get('controllerDistance'))) + 12 + 60 + 20
            incoming = [c.get('id') or c.get('name') for c in reservers if c not in stationed]
            check(scope, 'reserve-handoff', not remote.get('owner') and coverage_ticks <= lead,
                  f'预定余量{remaining}，有效在岗{len(stationed)}，覆盖估计{coverage_ticks} <= 接班最低预算{lead}ticks；在途{incoming}，需核实交接',
                  '核查队列、实际出生耗时、在途reserver位置/疲劳与到位时刻；预算只是下界，及时复现接班断档', urgent=remaining == 0)
            drops = remote.get('drops') or []
            total = sum(number(d.get('amount')) for d in drops)
            check(scope, 'ground-backlog', total >= 1000,
                  f'地面能量{total}，可能正在运输也可能浪费',
                  '追踪同一资源ID及运输工往返/负载/实际交付，不能把减少全算拾取或把增加全算衰减')
            check(scope, 'container-overflow', any(s.get('containerFree') == 0 for s in routes),
                  '源容器已满，有停采/溢出风险', '检查运输吞吐、可达性、取货优先级及维修预算')
            old_remote = next((x for x in (prev or {}).get('remotes', []) if x.get('room') == remote['room']), None)
            if old_remote and old_remote.get('visible') and dt >= 30:
                ids = {d['id'] for d in old_remote.get('drops') or []}
                retained = sum(number(d.get('amount')) for d in drops if d.get('id') in ids)
                check(scope, 'ground-retained', retained >= 500,
                      f'相隔{dt}ticks仍观察到同ID地面资源共{retained}；可有补充/拾取，非精确年龄',
                      '核对实际拾取与交付；持续两个窗口则做私服运输复现，比较净回流')
    return {'findings': findings, 'checked': checked, 'coverage': coverage}


def legacy_findings(entry):
    """Keep earlier rules in the same lifecycle; normalize changing numeric evidence."""
    out = []
    for message in entry.get('issues', []):
        if re.search(r'\[[a-z-]+\]', message):
            continue  # structured health finding is already present
        scope = message.split(' ')[0] if re.match(r'^[WE]\d+[NS]\d+ ', message) else 'global'
        label = re.split(r'[:：（(]', message, maxsplit=1)[0]
        key = scope + ':legacy-' + hashlib.sha256(re.sub(r'\d+', '#', label).encode()).hexdigest()[:12]
        out.append({'key': key, 'scope': scope, 'rule': 'legacy', 'message': message,
                    'severity': 'info' if 'safe mode 仍处于激活状态' in message else 'investigate',
                    'action': '重复采样定位原因；保存复现与验证证据，不因下轮未报警直接关闭'})
    return out


def read_state(path):
    if not os.path.exists(path):
        return {'schema': 1, 'incidents': {}}
    with open(path) as stream:
        state = json.load(stream)
    if state.get('schema') != 1 or not isinstance(state.get('incidents'), dict):
        raise ValueError('监控事件账本格式错误；保留原文件等待诊断')
    return state


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + '.tmp'
    with open(temp, 'w') as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
    os.replace(temp, path)


# 只有"主动且长期"的停用才算范围已撤销：白名单移除 / 距离过远是大脑或游戏内规划的决定，
# 不会自己恢复；敌情暂停（hostileCreep、suspendedUntil）是临时的，仍等新证据。
RETIRED_REMOTE_REASONS = {'notWhitelisted', 'tooFar'}


def scope_gone(scope, mon):
    """Return why an incident's scope provably no longer exists in this snapshot, else None.

    Only applies to rooms/remotes. A rule that silently stopped running (crash,
    missing field) keeps its incident open: absence of a check is not evidence.
    """
    rooms = {r.get('name'): r for r in mon.get('rooms') or [] if isinstance(r, dict)}
    if mon.get('schema') != 4 or not rooms or not isinstance(scope, str):
        return None  # 空/旧快照不能证明任何东西消失
    if not re.match(r'^[WE]\d+[NS]\d+(/[WE]\d+[NS]\d+)?$', scope):
        return None  # global / monitor / 其他范围永不自动撤销
    home, _, remote_name = scope.partition('/')
    if home not in rooms:
        return 'room-not-owned'
    if not remote_name:
        return None
    remotes = rooms[home].get('remotes')
    if not isinstance(remotes, list):
        return None
    remote = next((x for x in remotes if isinstance(x, dict) and x.get('room') == remote_name), None)
    if remote is None:
        return 'remote-removed'
    if remote.get('enabled') is False and remote.get('suspendReason') in RETIRED_REMOTE_REASONS:
        return 'remote-' + remote['suspendReason']
    return None


# 不再计入未结的状态：obsolete 只表示适用范围消失，同一规则再次命中即按新事件重开。
CLOSED = ('resolved', 'obsolete')


def alert_reason(item, before, distinct):
    """Why this observation needs attention now, or None for a long-standing, known incident.

    - new: first sighting, or a recurrence after resolved/obsolete (a new episode)
    - escalated: reached 'escalated' for the first time in this episode
    - urgent: an urgent condition that nobody has attached investigation evidence to yet
    Repeated samples of the same tick never alert twice; info findings never alert.
    """
    if not distinct or item.get('severity') == 'info':
        return None
    if before is None or before in CLOSED:
        item.pop('escalatedAt', None)
        item['episodeAt'] = time.time()  # 本次事件开始的墙钟时间；调查笔记早于它的不算认领了这一次
        if item['status'] == 'escalated':
            item['escalatedAt'] = item['lastTick']
        return 'new'
    if item['status'] == 'escalated' and not item.get('escalatedAt'):
        item['escalatedAt'] = item['lastTick']
        # 旧账本里本来就是 escalated 的事件没有 escalatedAt：补记，不当作本轮升级
        if before != 'escalated':
            return 'escalated'
    if item.get('severity') == 'urgent' and not acknowledged(item):
        return 'urgent'
    return None


def acknowledged(item):
    """urgent 事件是否已有属于本次事件的调查笔记（几周前上一次事件的笔记不算）。"""
    notes = [n for n in item.get('investigation') or [] if isinstance(n, dict)]
    if not notes:
        return False
    start = item.get('episodeAt')
    return start is None or max(n.get('at', 0) for n in notes) >= start


# 待确认告警的上限：心跳长期不来时只保留最近的，防止账本无限增长。
PENDING_ALERT_LIMIT = 200


def add_pending(state, alerts, now):
    """把本轮告警累积进 pendingAlerts，直到真正处理退出码的消费者（每小时心跳）确认。

    launchd 每 30 分钟的 cron 采集与心跳共用同一账本；若告警只记在本轮，cron 先看到的
    新增/升级会被它"花掉"，心跳拿到 0。同一事件同一原因只保留一条（首见 tick + 最近 tick）。
    """
    pending = [a for a in state.get('pendingAlerts') or [] if isinstance(a, dict)]
    index = {(a.get('key'), a.get('reason')): a for a in pending}
    for alert in alerts:
        existing = index.get((alert['key'], alert['reason']))
        if existing:
            existing.update(alert, lastTick=now)
        else:
            record = dict(alert, firstTick=now, lastTick=now)
            pending.append(record)
            index[(alert['key'], alert['reason'])] = record
    state['pendingAlerts'] = pending[-PENDING_ALERT_LIMIT:]


def ack_alerts(path):
    """消费者已看到全部待确认告警：清空 pendingAlerts，返回被确认的条数。"""
    state = read_state(path)
    count = len(state.get('pendingAlerts') or [])
    if count:
        state['pendingAlerts'] = []
        state['lastAck'] = {'at': time.time(), 'alerts': count}
        save_state(path, state)
    return count


def update_state(path, entry):
    state = read_state(path)
    mon, health = entry['mon'], entry['health']
    now, version = mon['t'], mon.get('scriptV')
    findings = health['findings'] + legacy_findings(entry)
    seen = set()
    alerts = []
    for finding in findings:
        key = finding['key']
        seen.add(key)
        item = state['incidents'].get(key, {})
        before = item.get('status')
        if item.get('workStatus') == 'verified' and item.get('status') == 'resolved':
            item['workStatus'] = 'fix-required'  # recurrence needs a new investigation, not an old verification
        distinct = item.get('lastTick') != now or item.get('lastVersion') != version
        count = item.get('observations', 0) + int(distinct)
        item.update(finding, firstTick=item.get('firstTick', now), lastTick=now,
                    lastVersion=version, observations=count, cleanSamples=0,
                    status=('observing' if finding['severity'] == 'info' else
                            'escalated' if count >= 3 or finding['severity'] == 'urgent' else 'investigating'),
                    updatedAt=time.time())
        item.pop('cleanStart', None)
        item.pop('scopeGone', None)
        reason = alert_reason(item, before, distinct)
        if reason:
            alerts.append({'key': key, 'reason': reason, 'severity': item['severity'],
                           'status': item['status'], 'message': item.get('message')})
        state['incidents'][key] = item
    for key, item in state['incidents'].items():
        if key in seen or item.get('status') in CLOSED:
            continue
        # Legacy silence is not coverage. Every structured rule must actually run.
        legacy_covered = (item.get('rule') == 'legacy' and mon.get('schema') == 4 and
                          health['coverage']['sameVersionTicks'] >= 100 and
                          (item.get('scope') == 'global' or item.get('scope') in {r['name'] for r in mon.get('rooms', [])}))
        if key not in health['checked'] and not legacy_covered:
            gone = scope_gone(item.get('scope', key.rsplit(':', 1)[0]), mon)
            if gone and item.get('workStatus') == 'fix-required':
                # 已确认的源码缺陷不随范围消失而出账：代码还在，换个外矿照样会犯。
                item.update(status='awaiting-fix', scopeGone={'tick': now, 'reason': gone})
            elif gone:
                # 范围已被撤销（外矿移出白名单/房间不再归我们）：规则不再适用，不是"已修复"。
                item.update(status='obsolete', resolution={
                    'tick': now, 'version': version, 'reason': 'scope-gone:' + gone})
            else:
                item['status'] = 'awaiting-evidence'
            continue
        if item.get('cleanVersion') != version:
            item.update(cleanSamples=0, cleanStart=now, cleanVersion=version)
        if item.get('cleanTick') != now:
            item['cleanSamples'] = item.get('cleanSamples', 0) + 1
            item['cleanTick'] = now
        item.setdefault('cleanStart', now)
        recovered = item['cleanSamples'] >= 2 and now - item['cleanStart'] >= 30
        item['status'] = ('awaiting-fix' if item.get('workStatus') == 'fix-required' else 'resolved') if recovered else 'recovering'
        if item['status'] == 'resolved':
            item['resolution'] = {'tick': now, 'version': version, 'reason': '同版本两个可比较样本恢复；并非证明所有区间无异常'}
    state['lastSuccess'] = {'tick': now, 'version': version, 'at': time.time()}
    # Successful collection clears transport failure only, never economic incidents.
    state.pop('collectionFailure', None)
    state['summary'] = {'open': sum(i.get('status') not in CLOSED for i in state['incidents'].values()),
                        'escalated': sum(i.get('status') == 'escalated' for i in state['incidents'].values()),
                        'obsolete': sum(i.get('status') == 'obsolete' for i in state['incidents'].values()),
                        'alerts': len(alerts),
                        'file': path}
    # 本轮的新增/升级事件只用于打印；monitor.py 的退出码看累积的 pendingAlerts（未被心跳确认的），
    # 不看历史未结总数。
    state['lastSample'] = {'tick': now, 'version': version, 'alerts': alerts}
    add_pending(state, alerts, now)
    state['summary']['pending'] = len(state['pendingAlerts'])
    save_state(path, state)
    return state


def record_failure(path, error):
    try:
        state = read_state(path)
    except (ValueError, OSError):
        # Never replace a corrupt ledger with an empty one.
        with open(path + '.failure', 'w') as stream:
            json.dump({'at': time.time(), 'error': error}, stream)
        return
    state['collectionFailure'] = {'at': time.time(), 'error': error, 'status': 'unknown'}
    save_state(path, state)


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Attach investigation evidence without falsely resolving an incident.')
    parser.add_argument('--incident', required=True)
    parser.add_argument('--note', required=True)
    parser.add_argument('--evidence', required=True, help='existing local evidence/report file')
    parser.add_argument('--next-action', required=True)
    disposition = parser.add_mutually_exclusive_group()
    disposition.add_argument('--requires-fix', action='store_true', help='confirmed defect must survive transient recovery')
    disposition.add_argument('--verified-version', help='deployed version with fresh recovery and report evidence')
    args = parser.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, 'logs', 'monitor-incidents.json')
    import fcntl
    with open(os.path.join(root, 'logs', 'monitor.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = read_state(path)
        if args.incident not in state['incidents']:
            parser.error('unknown incident key')
        if not os.path.isfile(args.evidence):
            parser.error('evidence file does not exist')
        item = state['incidents'][args.incident]
        if args.requires_fix:
            item['workStatus'] = 'fix-required'
            if item.get('status') in CLOSED:
                item['status'] = 'awaiting-fix'
        if args.verified_version:
            latest = state.get('lastSuccess') or {}
            if (str(latest.get('version')) != args.verified_version or
                    time.time() - latest.get('at', 0) > 300 or
                    str(item.get('cleanVersion')) != args.verified_version or
                    item.get('cleanSamples', 0) < 2 or
                    item.get('cleanTick', 0) - item.get('cleanStart', 0) < 30):
                parser.error('verified fix requires fresh matching version and two recovered observations at least 30 ticks apart')
            item['workStatus'] = 'verified'
            item['verifiedVersion'] = args.verified_version
            item['status'] = 'resolved'
        item.setdefault('investigation', []).append({'at': time.time(), 'note': args.note,
            'evidence': os.path.abspath(args.evidence), 'nextAction': args.next_action})
        item['investigation'] = item['investigation'][-20:]
        save_state(path, state)
    print('调查证据已记录；恢复仍需新的有效样本')


if __name__ == '__main__':
    main()
