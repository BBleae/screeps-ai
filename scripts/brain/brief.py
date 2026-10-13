"""态势摘要：给定时复核的 Claude 会话看的 Markdown。"""
import time


def _fmt_entry(name, entry, home):
    from .intel import room_distance
    if entry.get('unreachable'):
        return '- %s：拉取失败（%s）' % (name, entry.get('error', ''))
    bits = ['%d 源' % entry.get('sources', 0), entry.get('class', 'normal')]
    if entry.get('owner'):
        bits.append('主人 %s RCL%d' % (entry['owner'], entry.get('level', 0)))
    if entry.get('reservation'):
        bits.append('预定 %s 剩 %d' % (entry['reservation'].get('username'), entry['reservation'].get('ticksToEnd', 0)))
    if entry.get('mineral'):
        bits.append('矿 %s' % entry['mineral'])
    if entry.get('armedHostiles'):
        bits.append('武装敌人 %d' % entry['armedHostiles'])
    if entry.get('invaderCore'):
        bits.append('InvaderCore')
    if entry.get('towers'):
        bits.append('塔 %d' % entry['towers'])
    if entry.get('walls'):
        bits.append('墙 %d' % entry['walls'])
    return '- %s（距 %s %d）：%s' % (name, home, room_distance(home, name), '，'.join(bits))


def render(state):
    """state: {'generatedAt', 'tick', 'me', 'gcl', 'homes': {home: {'level', 'plan', 'intel'}}, 'wrote'}"""
    lines = ['# 外部大脑态势摘要', '',
             '生成时间：%s，游戏 tick %s，账号 %s，GCL %s' % (
                 time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(state.get('generatedAt', time.time()))),
                 state.get('tick'), state.get('me'), state.get('gcl')), '']
    directive_rooms = (state.get('directive') or {}).get('rooms') or {}
    locks = (state.get('directive') or {}).get('locks') or {}
    for home, info in state.get('homes', {}).items():
        plan = info.get('plan', {})
        final = directive_rooms.get(home) or {}
        lines.append('## 母房 %s（RCL%s）' % (home, info.get('level')))
        remotes = final.get('remotes') if 'remotes' in final else plan.get('remotes')
        lines.append('- 外矿分配：%s%s' % (', '.join(remotes or []) or '无',
                                        '（locks 覆盖）' if (home + '.remotes') in locks else ''))
        claim = final.get('claim') if 'claim' in final else plan.get('claim')
        lines.append('- 占领目标：%s%s' % ('%s（spawn 位 %s%s）' % (claim['room'], claim.get('spawnPos'),
                                                     '，附 RCL8 蓝图' if claim.get('plan') else '') if claim else '无',
                                          '（locks 覆盖）' if (home + '.claim') in locks else ''))
        blocked = (plan.get('analysis', {}).get('claim') or {}).get('blocked')
        if blocked:
            lines.append('- 脚本判断：暂不开新占领（%s）' % blocked)
        analysis = plan.get('analysis', {})
        ranked = analysis.get('claim', {}).get('ranked') or []
        if ranked:
            lines.append('- 占领候选排序：' + ', '.join('%s(%s)' % (r['room'], r['score']) for r in ranked[:6]))
        taken = analysis.get('remotes', {}).get('takenBy') or {}
        if taken:
            lines.append('- 外矿让给别家：' + ', '.join('%s→%s' % (k, v) for k, v in sorted(taken.items())))
        rejected = analysis.get('remotes', {}).get('rejected') or {}
        if rejected:
            lines.append('- 外矿被拒：' + ', '.join('%s=%s' % (k, v) for k, v in sorted(rejected.items())))
        mineral = final.get('mineral') if 'mineral' in final else plan.get('mineral')
        if mineral:
            reasons = {'rcl': '等级不足', 'energy': '先保障能量储备', 'stock': '库存已足够',
                       'full': '仓库空间不足', 'depleted': '等待矿脉再生', 'extractor': '等待 Extractor 建成',
                       'harvest': '开采', 'unreachable': '矿脉不可达', 'unreachable-spawn': '出生点不可达'}
            lines.append('- 房内矿物 %s：%s（%s）' % (mineral.get('mineralType', ''),
                '开采中' if mineral.get('enabled') else '暂停',
                reasons.get(mineral.get('reason'), mineral.get('reason', '无指令'))))
        safe = plan.get('safeMode')
        if safe and safe.get('action'):
            lines.append('- safe mode：%s（%s，DPS %s）' % (safe.get('action'), safe.get('reason'), safe.get('dps')))
        defense = final.get('defense') if 'defense' in final else plan.get('defense')
        if defense:
            bits = []
            for room, order in sorted(defense.items()):
                squad = order.get('squad') or {}
                body = ''.join('R' if part == 'ranged_attack' else part[0].upper() for part in squad.get('body') or [])
                bits.append('%s=%s%s（%d 敌%s，到 tick %s，%s）' % (
                    room, order.get('action'), '：%d×%s(%d)' % (squad['count'], body, squad['total']) if squad else '',
                    order.get('count', 0), '，强化' if order.get('boosted') else '', order.get('until'), order.get('reason')))
            lines.append('- 防御决定（母房容量 %s）：' % plan.get('capacity') + '；'.join(bits))
        lines.append('')
        lines.append('### 周边情报')
        for name in sorted(info.get('intel', {}), key=lambda n: (info['intel'][n].get('owner') is None, n)):
            lines.append(_fmt_entry(name, info['intel'][name], home))
        lines.append('')
    queue = state.get('claimQueue') or {}
    if queue:
        lines.append('## 占领清单（locks.json claim.queue，按优先顺序）')
        for room, item in queue.items():
            extra = ''
            if item.get('sponsor'):
                extra = '，母房 %s，%s 跳' % (item['sponsor'], item.get('hops'))
            lines.append('- %s：%s%s' % (room, item.get('status'), extra))
        lines.append('')
    lines.append('## 写入')
    lines.append('- %s' % state.get('wrote', '未写入（dry-run）'))
    for blocker in state.get('blockers') or []:
        lines.append('- 阻断：%s' % blocker)
    lines.append('')
    lines.append('复核方式：修改 data/brain/locks.json（如 {"W33S7.claim": {"value": {"room": "W34S7", "priority": 1}, "until": <ms>, "by": "agent"}}），下一轮写入时生效。')
    return '\n'.join(lines)
