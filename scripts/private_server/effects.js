'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
/**
 * 生效断言：私服验证通过的标准不只是"不崩、不报错"，每个游戏代码改动都要在私服里观察到新行为（CLAUDE.md 工作约定）。
 * 每条记录 id、日期、改动说明与观察方法；validateReport 全部执行，任一未观察到即验证失败。
 * 新增游戏代码改动时在 EFFECTS 里加一条（需要新场景就在 fixtures.js 里播种），改动上线后可以保留作为回归。
 */

function creepsOf(report, roomName) {
    const memory = report.rootMemories && report.rootMemories[roomName];
    return Object.values((memory && memory.creeps) || {});
}

/** 探针按房记录（Memory._validationRooms[房]）；老格式只有 Memory._validation.room，房名对得上时也认 */
/** 矿物场景失败时分清"钻机孵晚了"与"挖矿出错"：industry 房 spawnLog 里 core:mineralMiner 的孵化 tick，和首轮 industry 大脑的 tick */
function mineralSpawnTiming(report, ROOMS) {
    const root = report.rootMemories && report.rootMemories[ROOMS.industry];
    const log = (root && root.rooms && root.rooms[ROOMS.industry] && root.rooms[ROOMS.industry].spawnLog) || [];
    const spawned = log.filter((entry) => entry && typeof entry.key === 'string' && entry.key.startsWith('core:mineralMiner:'));
    return { minerSpawnLog: spawned, industryBrainAt: report.industryBrainAt != null ? report.industryBrainAt : null };
}

function roomProbe(report, roomName) {
    const memory = report.probeMemories && report.probeMemories[roomName];
    if (!memory) return null;
    const rooms = memory._validationRooms;
    if (rooms && rooms[roomName]) return rooms[roomName];
    const single = memory._validation && memory._validation.room;
    return single && single.name === roomName ? single : null;
}

const EFFECTS = [
    {
        id:'upgrader.actualSpawnHandoff',since:'2026-09-13',
        change:'heavy upgrader replacement travels from the real spawn and upgrades before incumbent expiry',
        check(report,ROOMS) {
            const t=report.upgraderRoute;
            // 截止 = 播种 tick + 夹具寿命（不是常数 601：播种 tick 偶尔是 2，见 run_validation.prepareUpgraderRoute）
            const ttl=require('../../test/fixtures/upgrader_legacy_spawn_W34S7.json').incumbentTtl;
            if(!t||!Number.isFinite(t.seedTick)||t.oldDiesAt!==t.seedTick+ttl||!t.spawn||t.spawn.x!==27||t.spawn.y!==18||!t.plan||
                t.plan.anchor.x!==27||t.plan.anchor.y!==36||t.plan.roads.ctrl||
                !t.leg||t.leg.complete!==true||!(t.leg.ticks>55)||t.leg.spawns!==1||!(t.leg.goals>0)||
                !t.successorId||t.successorId===t.incumbentId||!Array.isArray(t.body)||t.body.length!==24||
                t.body.filter(p=>p==='work').length!==21||t.body.filter(p=>p==='carry').length!==2||t.body.filter(p=>p==='move').length!==1)
                return {ok:false,why:'actual spawn / heavy body / complete route / unchanged deadline prerequisite missing'};
            const spawn=t.proof&&t.proof.spawn;
            if(!spawn||spawn.key!=='core:upgrader:0'||spawn.cost!==2250||!(spawn.t<t.oldDiesAt)||
                !t.samples.some(s=>s.t>=spawn.t&&s.t<spawn.t+72&&s.creeps.some(c=>c.id===t.successorId&&c.spawning)))
                return {ok:false,why:'actual base upgrader replacement spawn/body evidence missing'};
            const arrived=t.samples.some(s=>s.t<t.oldDiesAt&&s.creeps.some(c=>c.id===t.incumbentId)&&
                s.creeps.some(c=>c.id===t.successorId&&!c.spawning&&c.room===ROOMS.upgraderActualRoute&&
                    Math.max(Math.abs(c.x-31),Math.abs(c.y-40))<=1&&Math.max(Math.abs(c.x-31),Math.abs(c.y-41))<=3));
            const event=t.proof&&t.proof.events&&t.proof.events[t.successorId];
            const oldEvent=t.proof&&t.proof.events&&t.proof.events[t.incumbentId];
            const upgraded=event&&event.observedAt<t.oldDiesAt&&event.event&&event.event.objectId===t.successorId&&event.event.event===9&&event.event.data&&event.event.data.amount>0&&
                oldEvent&&oldEvent.event&&oldEvent.event.objectId===t.incumbentId&&oldEvent.event.event===9&&oldEvent.event.data&&oldEvent.event.data.amount>0;
            // 失败时带上到岗瞬间的诊断（proof.arrival：身上能量、控制器 2 格内容器/link 的能量）与包装补装记录，区分
            // "站位没能量" / "观察包装被 backend 重启冲掉" / 真回归；只用于解释，不改变判定
            const arrival=t.proof&&t.proof.arrival&&t.proof.arrival[t.successorId];
            const reinstalls=(report.wrapperReinstalls||[]).filter(r=>r.name==='upgraderRoute');
            return arrived&&upgraded?{ok:true}:{ok:false,why:'same successor did not arrive and actually upgrade while incumbent lived: '+JSON.stringify({arrived:!!arrived,upgraded:!!upgraded,arrival:arrival||null,reinstalls})};
        },
    },
    {
        id:'remote.orderedReserverDeadline', since:'2026-09-13',
        change:'an earlier remote hauling request cannot occupy the spawn past a later ordered reserver deadline',
        check(report,ROOMS) {
            const test=report.reserveOrdered, e=test&&test.evidence;
            if (!e || !Number.isFinite(test.wantedHaulers) || !(test.initialHaulers>=test.wantedHaulers) ||
                !Number.isFinite(test.wantedCarry) || !(test.initialCarry>=test.wantedCarry) || !(e.haulIndex>=0 && e.haulIndex<e.reserveIndex) || !e.haulOrdered || !e.reserveOrdered ||
                e.haulPriority!==4 || e.reservePriority!==4 || e.energy!==1100 || e.capacity!==1800 ||
                e.haulCost!==1050 || e.haulParts!==20 || !(e.haulSince+e.haulGrace<e.at) ||
                !(e.neededBy-e.at<60) || e.at<test.at || e.at>=test.oldDiesAt ||
                !(e.blocked||[]).includes(e.haulKey) ||
                !(e.actions||[]).some(a=>a.key===e.reserveKey&&a.cost===650&&a.parts===2))
                return {ok:false,why:'real earlier hauling candidate / later deadline / rejection evidence missing: '+JSON.stringify(e)};
            return EFFECTS.find(effect=>effect.id==='remote.affordableReserverDeadline')
                .check({reserveBudget:test},{reserveBudgetTarget:ROOMS.reserveOrderedTarget});
        },
    },

    {
        id: 'remote.affordableReserverDeadline', since: '2026-09-09',
        change: 'one CLAIM handoff reaches the controller before incumbent death when two CLAIM cannot be afforded before the deadline',
        check(report, ROOMS) {
            const test = report.reserveBudget;
            if (!test || test.energy !== 1100 || test.capacity !== 1800 || !(test.initialHaulers >= 3) || test.initialTtl !== test.travel+26 ||
                !test.successorId || test.successorId === test.incumbentId || test.successorClaim !== 1 || test.successorParts !== 2) {
                return {ok:false,why:'affordable deadline prerequisites or actual single CLAIM successor missing: '+JSON.stringify(test)};
            }
            const arrived = test.samples.some(s => s.t >= test.at && s.t < test.oldDiesAt &&
                s.creeps.some(c => c.id === test.incumbentId) &&
                s.creeps.some(c => c.id === test.successorId && c.claim === 1 && !c.spawning && c.room === ROOMS.reserveBudgetTarget &&
                    Math.max(Math.abs(c.x-test.controller.x),Math.abs(c.y-test.controller.y)) <= 1));
            return arrived ? {ok:true} : {ok:false,why:'actual single CLAIM successor did not arrive before incumbent death'};
        },
    },
    {
        id: 'remote.reserverNonPreemptiveHandoff', since: '2026-09-09',
        change: 'affordable reserver replacement precedes a real non-preemptible hauling spawn and reaches the controller before incumbent death',
        check(report, ROOMS) {
            const test = report.reserveDeadline;
            const event = test && test.event;
            if (!test || !event || !test.successorId || event.at < test.at || event.at >= test.oldDiesAt ||
                event.remoteRoom !== ROOMS.reserveDeadlineTarget || event.lead !== test.lead || !(test.initialTtl > test.lead) || test.energy !== 1300 ||
                !event.candidates || !event.candidates.some((o) => ['hauler', 'remoteHauler'].includes(o.role) && o.parts === 26 && o.cost === 1300) || event.blockedTicks !== 78) {
                return { ok: false, why: 'deadline/candidate prerequisites or actual successful handoff spawn missing: ' + JSON.stringify({test, event}) };
            }
            // 到控制器 2 格内即算赶到：随机地形下在岗者可能正好占着后继者寻路终点那一格，wheel 移动库不绕开干活中的 creep，
            // 后继者贴着在岗者等它死（私服 validation-Wmg3Hx：控制器 (7,17)、在岗 (7,16)、后继者 (7,15) 等了 90 tick，旁边 (8,16) 空着）。
            // 这条断言验的是"替补在不可抢占的运输孵化之前孵出、在旧的死前赶到"，交接时差几 tick 不是它管的
            const arrived = (test.samples || []).some((sample) => sample.t < test.oldDiesAt &&
                sample.creeps.some((o) => o.name === 'reserve-incumbent') &&
                sample.creeps.some((o) => o.name === event.name && o.id === test.successorId && !o.spawning && o.room === ROOMS.reserveDeadlineTarget &&
                    Math.max(Math.abs(o.x-test.controller.x), Math.abs(o.y-test.controller.y)) <= 2));
            return arrived ? { ok: true } : { ok: false, why: 'successor was not observed alive next to the controller while incumbent still lived' };
        },
    },
    {
        id: 'remote.salvageBeforeContainer', since: '2026-09-09',
        change: '相邻溢出能量足够装满时优先拾取，下一 tick 验证实际获得能量。',
        check(report, ROOMS) {
            const records = [ROOMS.remoteHome, ROOMS.reserveHome].map((name) => {
                const root = report.rootMemories && report.rootMemories[name];
                return root && root.rooms && root.rooms[name] && root.rooms[name].remoteEnergySalvaged;
            });
            const record = records.find((record) => record && record.amount >= 100);
            return record && record.amount >= 100 && record.n > 0 ? { ok: true } :
                { ok: false, why: '未观察到相邻掉落实际到账: ' + JSON.stringify(record) };
        },
    },
    {
        id: 'remote.roadCoverage', since: '2026-09-09',
        change: 'empty or incompletely paved cross-room routes no longer select road-only hauler bodies',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.reserveHome];
            const home = memory && memory.rooms && memory.rooms[ROOMS.reserveHome];
            const record = home && home.remotes && home.remotes[ROOMS.reserveTarget];
            return record && record.roadCoverageRepair && record.roadCoverageRepair.reason === 'incompleteRoadCoverage'
                ? { ok: true } : { ok: false, why: 'fixture unpaved route was never corrected from roadComplete=true' };
        },
    },
    {
        id: 'remote.routeDistanceRepair', since: '2026-09-09',
        change: 'replan impossible cached source distances using actual route hop budget and global-coordinate fallback',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.reserveHome];
            const home = memory && memory.rooms && memory.rooms[ROOMS.reserveHome];
            const record = home && home.remotes && home.remotes[ROOMS.reserveTarget];
            const repair = record && record.distanceRepair;
            const source = record && (record.sources || []).find((item) => item.id === (repair && repair.source));
            return repair && repair.before === 1 && repair.after > 50 && source && source.distanceVersion === 3 && source.distanceIncomplete === false &&
                record.controllerDistanceVersion === 3 && record.controllerDistanceIncomplete === false && record.drop && record.drop.distanceVersion === 3
                ? { ok: true } : { ok: false, why: 'source/drop cache did not migrate to exploration-budget version 3: ' + JSON.stringify(repair) };
        },
    },
    {
        id: 'remote.reservationLeadGrace', since: '2026-09-09',
        change: 'reserver replacement includes refill grace and the spawn-to-controller geometric distance floor; omitting either queues after tick33',
        check(report) {
            const samples = report.earlyReserve || [];
            const early = samples.find((sample) => sample.offset <= 25 && (sample.creeps || []).some((creep) => creep.name !== 'reserve-incumbent'));
            return early ? { ok: true } : { ok: false, why: 'no replacement CLAIM creep in first 25 ticks: ' + JSON.stringify(samples) };
        },
    },
    {
        id: 'spawn.containerGapBuilder',
        since: '2026-09-07',
        change: '核心容器缺失时 builder 目标至少 1：recovering 不再把 builder 清零，没工地时 hasBuilderWork 也不再挡住 vital builder。88fe9e7 RCL6 己方源利用 83%→69%、建造 15k，是死房容器消失后重建请求进不了队',
        check(report, ROOMS) {
            const memory = report.rootMemories[ROOMS.recovery] || report.rootMemories[ROOMS.containerGap];
            const room = memory && memory.rooms && memory.rooms[ROOMS.containerGap];
            const record = room && room.containerGapBuilder;
            if (!record || !(Number(record.n) > 0)) {
                return { ok: false, why: '核心容器缺失的 recovering 房没有 containerGapBuilder 记录（旧代码 builder 目标是 0）: ' + JSON.stringify(record) };
            }
            const builders = Object.values((memory && memory.creeps) || {}).filter((creep) => creep.role === 'builder' &&
                (creep.home === ROOMS.containerGap || !creep.home));
            const queued = room.spawnSince && room.spawnSince['core:builder:0'] != null;
            if (!builders.length && !queued && !(room.spawnQueue && room.spawnQueue.waiting && String(room.spawnQueue.waiting.key).indexOf('builder') >= 0)) {
                return { ok: false, why: `记了 containerGapBuilder n=${record.n} 但既没有 builder creep 也没有 core:builder:0 在队里` };
            }
            return { ok: true };
        },
    },
    {
        id: 'expansion.unreachableBackoff', since: '2026-09-07',
        change: '墙封死出口时 claimer 超时进入独立冷却，重复指令不再无限续派',
        check(report, ROOMS) {
            const memory = report.rootMemories[ROOMS.claimBlocked];
            const room = memory && memory.rooms && memory.rooms[ROOMS.claimBlocked];
            const record = room && room.claimReachability && room.claimReachability[ROOMS.claimBlockedTarget];
            return record && record.failures === 1 && record.reason === 'unreachable' && record.suspendedUntil > 0 && record.startedAt == null
                ? { ok: true } : { ok: false, why: '封墙占领没有触发首次退避: ' + JSON.stringify(record) };
        },
    },
    {
        id: 'aid.untilCapacity1300',
        since: '2026-09-06',
        change: 'aid.untilCapacity 800 → 1300：800 容量的弱房也受援（弱房 spawn 300 + 10 个 extension = 恰好 800，旧值下 needsAid 的 `capacity >= untilCapacity` 直接返回 false，一只援建 creep 都不会有）',
        check(report, ROOMS) {
            const aided = creepsOf(report, ROOMS.aidHome).filter((memory) => memory.aid === ROOMS.aidHome && memory.home === ROOMS.aidWeak);
            // 只要求"弱房拿到了援建 creep"，不指定角色：容量门槛是 needsAid 的第一道闸，过不了就一只都没有，所以任意角色都能严格区分新旧值。
            // 以前指定必须是 hauler，那是一场抢孵化顺序的赛跑——夹具给弱房播了一只 2 CARRY 的 hauler，`hasHauler` 为真，
            // 援建 hauler 请求的 strategic 就是 false，整个窗口里都排在母房自己的发展档之后，能不能排上全看那一轮母房孵了什么
            // （2026-09-07：连续两轮默认参数下只孵出 courier 而失败，更早几轮通过纯属侥幸）。courier 同样只在 needsAid 通过后才产生
            return aided.length > 0
                ? { ok: true }
                : { ok: false, why: '母房没有为 800 容量的弱房孵出任何援建 creep（needsAid 的容量门槛没放行）' };
        },
    },
    {
        id: 'aid.courier',
        since: '2026-09-06',
        change: 'roles/courier：母房 storage ≥ exportAbove 时派 courier 把能量搬到弱房',
        check(report, ROOMS) {
            const courier = creepsOf(report, ROOMS.aidHome).find((memory) => memory.role === 'courier' &&
                memory.from === ROOMS.aidHome && memory.home === ROOMS.aidWeak);
            if (!courier) return { ok: false, why: '母房 storage 80000 却没有孵出 courier' };
            const probe = roomProbe(report, ROOMS.aidHome);
            const storage = probe && probe.storage;
            if (storage == null) return { ok: false, why: '探针没有母房 storage 能量' };
            return storage < 80000
                ? { ok: true }
                : { ok: false, why: `courier 在编但母房 storage 仍是 ${storage}（没取走能量）` };
        },
    },
    {
        id: 'expansion.concurrentBootstraps',
        since: '2026-09-06',
        change: 'expansion：多个母房并行开荒——没人管的孤儿房先开，别处在开荒不再封死本房的 pioneer',
        check(report, ROOMS) {
            const pioneers = creepsOf(report, ROOMS.aidHome).filter((memory) => memory.role === 'pioneer');
            const targets = new Set(pioneers.map((memory) => memory.targetRoom));
            const missing = [ROOMS.aidNew1, ROOMS.aidNew2].filter((room) => !targets.has(room));
            return missing.length === 0
                ? { ok: true }
                : { ok: false, why: `这些无 spawn 的新房没有 pioneer：${missing.join(',')}（pioneer 目标: ${JSON.stringify([...targets])}）` };
        },
    },
    {
        id: 'aid.requiresSpawn',
        since: '2026-09-06',
        change: 'aid：没有 spawn 的新房不援（矿工落地采、hauler 没处送、builder 不建 spawn，能量白堆）',
        check(report, ROOMS) {
            const wrong = creepsOf(report, ROOMS.aidHome).filter((memory) => memory.aid && (memory.home === ROOMS.aidNew1 || memory.home === ROOMS.aidNew2));
            return wrong.length === 0
                ? { ok: true }
                : { ok: false, why: `无 spawn 的新房收到了援建 creep: ${JSON.stringify(wrong.map((m) => [m.role, m.home]))}` };
        },
    },
    {
        id: 'aid.safeRoute',
        since: '2026-10-13',
        change: 'aid：母房到弱房没有不穿 SK/他人房的路线（movement.safeRouteExists）就不援、记 aidNoRoute；已派出、回不了弱房的援建 creep 由 aid.markStranded 标退役、走回 spawn 回收（线上 2026-09-15 W35S7 → W37S5 只能穿 SK 房：援建矿工在母房原地寻路 18 小时，还占着 W37S5 的矿工编制，两源 0 采集；移植 wip/deploy-20260920 c7cc6f2）',
        check(report, ROOMS) {
            const home = ROOMS.aidSafeHome;
            const far = ROOMS.aidSafeFar;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 aidSafeHome 用户的 Memory（场景没播种？）' };
            const rooms = memory.rooms || {};
            const noRoute = rooms[home] && rooms[home].aidNoRoute;
            if (!noRoute || noRoute.room !== far) return { ok: false, why: '母房没有记下对 aidSafeFar 的"无安全路线"拒援: ' + JSON.stringify(noRoute) };
            const stranded = rooms[far] && rooms[far].aidStranded;
            if (!stranded || stranded.name !== 'aid-safe-stranded-hauler' || stranded.from !== home) {
                return { ok: false, why: '播种的援建 hauler 没有被判定回不去并标退役: ' + JSON.stringify(stranded) };
            }
            const creeps = memory.creeps || {};
            // 回收完成后主循环清掉死 creep 的 Memory；还在就是标了退役却没走去回收（或根本没退役）
            if (creeps['aid-safe-stranded-hauler']) return { ok: false, why: '搁浅的援建 hauler 到结束还在: ' + JSON.stringify(creeps['aid-safe-stranded-hauler']) };
            const sent = Object.entries(creeps).filter(([, creep]) => creep && creep.aid === home && creep.home === far);
            return sent.length === 0
                ? { ok: true, detail: { noRoute, stranded } }
                : { ok: false, why: '母房仍给无安全路线的 aidSafeFar 孵了援建 creep: ' + JSON.stringify(sent.map(([name, creep]) => [name, creep.role])) };
        },
    },
    {
        id: 'broker.terminalFill',
        since: '2026-10-13',
        change: 'task_broker：terminal 进 hauler 投递目标（第 4 层、权重 0.5），只在 storage 富余（storageRich 滞回开）且高于 industry.terminalFillStorageAbove 时补到 terminalTarget。此前投递目标里没有 terminal，终端网络/市场/industry.canSpend 的前提永远不成立（移植 overmind-absorb e4cae2f）',
        check(report, ROOMS) {
            const room = ROOMS.terminalHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 terminalNet 用户的 Memory（场景没播种？）' };
            const fill = ((memory.rooms || {})[room] || {}).terminalFill;
            if (!fill || !(Number(fill.want) > 0)) return { ok: false, why: 'storage 20 万的房里从没出过 terminal 投递任务: ' + JSON.stringify(fill) };
            // 决定性证据：terminal 播的是 0 能量，结束时（加上终端网络已经发出去的量）有能量——只可能是 hauler 搬进去的
            const objects = ((report.terminalNet || {}).rooms || {})[room] || [];
            const terminal = objects.find((o) => o.type === 'terminal');
            const storage = objects.find((o) => o.type === 'storage');
            if (!terminal) return { ok: false, why: 'terminal 不见了（被拆？）: ' + JSON.stringify(objects) };
            const sent = Number(((memory.terminalNetwork || {}).amount) || 0);
            const energy = Number((terminal.store || {}).energy || 0);
            if (!(energy + sent > 0)) return { ok: false, why: '有投递任务但 terminal 里还是 0 能量: ' + JSON.stringify({ fill, terminal, sent }) };
            const fillAbove = Number((require(path.join(ROOT, 'src/config')).industry || {}).terminalFillStorageAbove) || 0;
            const storageEnergy = Number(((storage || {}).store || {}).energy || 0);
            return storageEnergy >= fillAbove * 0.9
                ? { ok: true, detail: { terminal: energy, sent, storage: storageEnergy, fill } }
                : { ok: false, why: '补 terminal 把 storage 抽到了门槛以下: ' + JSON.stringify({ storage: storageEnergy, fillAbove }) };
        },
    },
    {
        id: 'terminal.network',
        since: '2026-10-13',
        change: '终端网络（src/terminal.js，移植 overmind-absorb 2214dcc）：storageRich 且 storage+terminal ≥ 10 万的己方房把 terminal 里的能量瞬时送到 ≤ 2 万的己方房（每 10 tick 一笔，发后留 keep 与 feeReserve；bucket 降载时不做）。此前跨房搬能量只有 courier 走路',
        check(report, ROOMS) {
            const home = ROOMS.terminalHome;
            const peer = ROOMS.terminalPeer;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 terminalNet 用户的 Memory（场景没播种？）' };
            const net = memory.terminalNetwork || {};
            const last = net.last;
            if (!last) return { ok: false, why: '没有 Memory.terminalNetwork.last（一笔都没发；母房 terminal 是不是没被补起来？）' };
            if (last.from !== home || last.to !== peer) return { ok: false, why: '转账方向不对（应为富房 → storage 0 的接收房）: ' + JSON.stringify(last) };
            if (!(Number(net.sent) >= 1 && Number(net.amount) > 0)) return { ok: false, why: '记了 last 但没有一笔成功（terminal.send 返回 ' + last.result + '）: ' + JSON.stringify(net) };
            // 决定性证据：接收房 terminal 的现存 + hauler 已经取走的量 > 0（原始 DB，不看发送方的记账）
            const objects = ((report.terminalNet || {}).rooms || {})[peer] || [];
            const peerTerminal = objects.find((o) => o.type === 'terminal');
            const drained = Number((((memory.rooms || {})[peer] || {}).terminalDrain || {}).amount || 0);
            const landed = Number(((peerTerminal || {}).store || {}).energy || 0) + drained;
            if (!(landed > 0)) return { ok: false, why: '发送方记了 ' + net.amount + '，但接收房 terminal 里没有能量、也没被取过: ' + JSON.stringify(peerTerminal) };
            // 接收房 storage 0：不能反过来给它的 terminal 补能
            const peerFill = ((memory.rooms || {})[peer] || {}).terminalFill;
            return peerFill
                ? { ok: false, why: 'storage 0 的接收房也出了 terminal 补能任务: ' + JSON.stringify(peerFill) }
                : { ok: true, detail: { net, landed } };
        },
    },
    {
        id: 'hauler.terminalDrain',
        since: '2026-10-13',
        change: '终端网络的接收端：storage 不富余（storageRich 滞回关）时 hauler 把 terminal 里的能量取出来（task_broker terminal 取货、只给 hauler），与补能互斥。此前 hauler 不认 terminal 取货，送来的能量只能趴在 terminal 里',
        check(report, ROOMS) {
            const home = ROOMS.terminalHome;
            const peer = ROOMS.terminalPeer;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 terminalNet 用户的 Memory（场景没播种？）' };
            const rooms = memory.rooms || {};
            const drain = (rooms[peer] || {}).terminalDrain;
            if (!drain || !(Number(drain.n) > 0) || !(Number(drain.amount) > 0)) {
                return { ok: false, why: '接收房没有从 terminal 取过能量: ' + JSON.stringify({ drain, net: memory.terminalNetwork }) };
            }
            // storage 20 万的母房从不取 terminal（取了就是补进去又搬出来）
            const homeDrain = (rooms[home] || {}).terminalDrain;
            return homeDrain
                ? { ok: false, why: 'storage 富余的母房也在从 terminal 取货: ' + JSON.stringify(homeDrain) }
                : { ok: true, detail: drain };
        },
    },
    {
        id: 'broker.terminalDrainLow',
        since: '2026-10-13',
        change: 'task_broker：storage 富余滞回还开着、但跌到 industry.terminalDrainStorageBelow（3 万）以下时，hauler 把 terminal 里补进去的能量取回来、只留 terminalNetwork.feeReserve（复审发现）：此时终端网络发不出（storage+terminal < sendAbove）、canSpend 关着，terminal 的能量没有消费方；旧代码要等 storage 跌破 storageFeedBelow 才取，最多 3 万一直锁着',
        check(report, ROOMS) {
            const room = ROOMS.terminalDrainLow;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 terminalDrainLow 用户的 Memory（场景没播种？）' };
            const mem = (memory.rooms || {})[room] || {};
            // 决策：broker 在富余滞回开着时出过留 feeReserve 的 terminal 取货任务（旧代码这时不出任务）
            const low = mem.terminalDrainLow;
            if (!low || !(Number(low.keep) > 0)) return { ok: false, why: 'storage 2 万（富余、低于取回线）时没有出 terminal 取回任务: ' + JSON.stringify({ low, rich: mem.storageRich }) };
            // 行动：hauler 真的按这条任务从 terminal 取了能量（rec.low 只记 drainKeep > 0 的任务）
            const drain = mem.terminalDrain;
            if (!drain || !(Number(drain.low) > 0)) return { ok: false, why: '出了取回任务，但 hauler 没有从 terminal 取过（terminalDrain.low）: ' + JSON.stringify(drain) };
            return { ok: true, detail: { low, drain } };
        },
    },
    {
        id: 'market.sellSurplus',
        since: '2026-10-13',
        change: '市场（src/market.js，移植 overmind-absorb 2133dc2/6112d42）：storage 富余的房把 terminal 里超过 keep 的矿物按别人的买单卖掉（Game.market.deal），价格底线取 getHistory 近期均价 × 0.7，有效价扣掉传送能量；每 100 tick 一笔、bucket 降载时不做。此前矿物只能堆在 terminal 里',
        check(report, ROOMS) {
            const home = ROOMS.terminalHome;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 terminalNet 用户的 Memory（场景没播种？）' };
            const mk = memory.market || {};
            const orders = (report.terminalNet || {}).npcOrders || [];
            // avg 为 null / marketStats 为 0 ⇒ 没有成交史（2026-10-14：backend cron calcMarketStats 清掉了直接播的 market.stats），不是传送费的事
            if (!mk.last) return { ok: false, why: '没有 Memory.market.last（一单都没做；成交史 avg/marketStats 有没有？母房 terminal 有没有被补上传送费？）: '
                + JSON.stringify({ avg: mk.avg, marketStats: (report.terminalNet || {}).marketStats, orders }) };
            if (mk.last.room !== home || mk.last.resource !== 'U') return { ok: false, why: '成交的不是母房 terminal 里富余的 U: ' + JSON.stringify(mk.last) };
            if (!(Number(mk.deals) >= 1)) return { ok: false, why: 'Game.market.deal 没有一次返回 OK: ' + JSON.stringify(mk.last) };
            // 决定性证据：对手方买单的剩余量真的少了（引擎处理了 deal 意图）
            const order = orders[0];
            if (!order) return { ok: false, why: '对手方买单不见了（NPC 市场 cron 把它删了？）' };
            return Number(order.remainingAmount) < Number(order.totalAmount)
                ? { ok: true, detail: { last: mk.last, order } }
                : { ok: false, why: '记了一单 ' + mk.last.amount + ' U，但买单剩余量没变: ' + JSON.stringify(order) };
        },
    },
    {
        id: 'minerals.labChain',
        since: '2026-10-13',
        change: '矿物链打通（移植 overmind-absorb 7f4ab27 / bf11ea0）：industry.labPlan 给出取送计划，spawn 按它孵 labTech（opportunistic），labTech 把矿物从 terminal 装进输入 lab、把产物收回 terminal。过去没有任何角色往 lab 里装货，labs 建好了也永远不反应',
        check(report, ROOMS) {
            const room = ROOMS.labHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 labChain 用户的 Memory（场景没播种？）' };
            const tech = ((memory.rooms || {})[room] || {}).labTech;
            if (!tech || !(Number(tech.loaded) > 0) || !(Number(tech.loadedAmount) > 0)) {
                return { ok: false, why: 'labTech 一次都没往 lab 里装过货: ' + JSON.stringify({ tech, state: ((memory.rooms || {})[room] || {}).industryState }) };
            }
            // 决定性证据：夹具的 lab 全空、哪儿都没播 OH——结束时 lab 或 terminal 里有 OH，只可能是 labTech 装货后反应做出来的
            const objects = ((report.labChain || {}).rooms || {})[room] || [];
            const labs = objects.filter((o) => o.type === 'lab');
            if (labs.length < 4) return { ok: false, why: 'lab 少于播种的 4 个（被拆？）: ' + JSON.stringify(objects) };
            const product = objects.reduce((sum, o) => sum + Number((o.store || {}).OH || 0), 0);
            const loaded = labs.reduce((sum, o) => sum + Number((o.store || {}).H || 0) + Number((o.store || {}).O || 0), 0);
            return product > 0
                ? { ok: true, detail: { tech, product, loaded } }
                : { ok: false, why: 'labTech 装了货但没有任何 OH 产出（反应没跑起来）: ' + JSON.stringify({ tech, labs: labs.map((o) => o.store) }) };
        },
    },
    {
        id: 'industry.reactionChain',
        since: '2026-10-13',
        change: '反应链（移植 overmind-absorb 2d97ab4，Overmind 的 Abathur）：先定目标 boost 化合物（config.industry.boostTargets），再自底向上找「现在就做得起的那一步」；lab 分工存进 labRoles 跨 tick 稳定。此前只会按 lab 里已有的矿物推导（deriveReaction），矿物在 terminal 里时永远推不出',
        check(report, ROOMS) {
            const room = ROOMS.labHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 labChain 用户的 Memory（场景没播种？）' };
            const mem = (memory.rooms || {})[room] || {};
            const step = mem.labRoles && mem.labRoles.step;
            const labs = (mem.industryState || {}).labs || {};
            // terminal 里只有 H/O、boostTargets 第一个是 XZH2O：链上第一步是 OH，而且是为 XZH2O 做的（机会主义配对没有 target）
            if (!step || step.target !== 'XZH2O' || step.product !== 'OH') {
                return { ok: false, why: '没有按目标化合物选出这一步: ' + JSON.stringify({ step, labs }) };
            }
            return labs.target === 'XZH2O' && labs.product === 'OH'
                ? { ok: true, detail: { step, labs } }
                : { ok: false, why: 'industryState 没记下这一批为哪个目标服务: ' + JSON.stringify(labs) };
        },
    },
    {
        id: 'industry.boostLab',
        since: '2026-10-13',
        change: 'boost lab（移植 overmind-absorb 019c5b1）：目标化合物库存攒够 labBoostStock 就让 labTech 装进反应三连之外的一个 lab。强化找的是「已经装着这个化合物的 lab」，而过去产物只会被收回 terminal、没有任何代码往那种 lab 里装货',
        check(report, ROOMS) {
            const room = ROOMS.labHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 labChain 用户的 Memory（场景没播种？）' };
            const roles = ((memory.rooms || {})[room] || {}).labRoles;
            if (!roles || !roles.boost) return { ok: false, why: 'industry 没选出 boost lab: ' + JSON.stringify(roles) };
            const labs = (((report.labChain || {}).rooms || {})[room] || []).filter((o) => o.type === 'lab');
            const boost = labs.find((o) => o.id === roles.boost);
            if (!boost) return { ok: false, why: 'boost lab 不在原始 DB 里: ' + JSON.stringify({ roles, labs: labs.map((o) => o.id) }) };
            const used = (roles.inputs || []).concat(roles.outputs || []);
            if (used.indexOf(roles.boost) >= 0) return { ok: false, why: 'boost lab 和反应三连重叠: ' + JSON.stringify(roles) };
            // XZH2O 只播在 terminal 里：boost lab 装着它 ⇒ labTech 按 boost 需求搬了一趟
            return Number((boost.store || {}).XZH2O || 0) > 0
                ? { ok: true, detail: { boost: boost.store } }
                : { ok: false, why: 'terminal 里有 1500 XZH2O，boost lab 却没装上: ' + JSON.stringify(boost.store) };
        },
    },
    {
        id: 'broker.labEnergy',
        since: '2026-10-13',
        change: 'task_broker：boost lab 进 hauler 投递目标（第 4 层、权重 0.4），只在 storage 富余且高于 terminalFillStorageAbove 时补到 labEnergyTarget；反应三连不补（反应不耗能）。过去投递目标里没有 lab，boostCreep 每部件要的 20 能量永远没有',
        check(report, ROOMS) {
            const room = ROOMS.labHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 labChain 用户的 Memory（场景没播种？）' };
            const mem = (memory.rooms || {})[room] || {};
            const roles = mem.labRoles;
            if (!roles || !roles.boost) return { ok: false, why: '没有 boost lab: ' + JSON.stringify(roles) };
            if (!mem.labEnergy || mem.labEnergy.lab !== roles.boost) return { ok: false, why: '没出过 boost lab 的能量投递任务: ' + JSON.stringify(mem.labEnergy) };
            const labs = (((report.labChain || {}).rooms || {})[room] || []).filter((o) => o.type === 'lab');
            const boost = labs.find((o) => o.id === roles.boost);
            const others = labs.filter((o) => o.id !== roles.boost);
            // 四个 lab 都播 0 能量：boost lab 有能量 ⇒ hauler 送的；反应三连有能量 ⇒ 投递没限定在 boost lab 上
            if (!boost || !(Number((boost.store || {}).energy || 0) > 0)) return { ok: false, why: 'boost lab 还是 0 能量: ' + JSON.stringify(boost) };
            const leaked = others.filter((o) => Number((o.store || {}).energy || 0) > 0);
            return leaked.length === 0
                ? { ok: true, detail: { boost: boost.store.energy, telemetry: mem.labEnergy } }
                : { ok: false, why: '反应三连也被补了能量（能量锁在不耗能的 lab 里）: ' + JSON.stringify(leaked.map((o) => [o.id, o.store.energy])) };
        },
    },
    {
        id: 'broker.labEnergyNeedsBoosts',
        since: '2026-10-14',
        change: 'task_broker：强化没打开（config.conquest.boosts 全空、也没有带 boosts 的生效指令——默认就是这样）时不给 boost lab 补能量（复审发现）：没有任何 creep 会来这个 lab 强化，补进去的 2000 能量永远锁在 lab 里；本该补而没补时记 labEnergyHeld',
        check(report, ROOMS) {
            const room = ROOMS.industry;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 industry 用户的 Memory（场景没播种？）' };
            // 前提：这个用户没有打开强化
            const directives = Array.isArray(memory.conquest) ? memory.conquest : memory.conquest ? [memory.conquest] : [];
            const opened = directives.filter((d) => d && !d.completed && d.boosts && Object.values(d.boosts).some((list) => Array.isArray(list) && list.length));
            if (opened.length) return { ok: false, why: 'industry 用户的指令打开了强化（场景前提不对）: ' + JSON.stringify(opened) };
            const mem = (memory.rooms || {})[room] || {};
            const boostId = mem.labRoles && mem.labRoles.boost;
            if (!boostId) return { ok: false, why: 'industry 房没有 boost lab（前提没摆出来）: ' + JSON.stringify(mem.labRoles || null) };
            // 旧行为：storage 50 万富余 ⇒ 给 boost lab 出补能任务（labEnergy）、hauler 把它补到 labEnergyTarget
            if (mem.labEnergy && mem.labEnergy.lab === boostId) return { ok: false, why: '强化没打开却给 boost lab 出了补能任务: ' + JSON.stringify(mem.labEnergy) };
            const held = mem.labEnergyHeld;
            if (!held || held.lab !== boostId || !(Number(held.want) > 0)) return { ok: false, why: '没有"本该补而没补"的遥测（补能闸没开？）: ' + JSON.stringify({ held: held || null, boostId }) };
            const labs = (((report.labChain || {}).rooms || {})[room] || []).filter((o) => o.type === 'lab');
            const boost = labs.find((o) => o.id === boostId);
            if (!boost) return { ok: false, why: '原始 DB 里找不到 boost lab: ' + JSON.stringify({ boostId, labs: labs.map((o) => o.id) }) };
            const energy = Number((boost.store || {}).energy || 0);
            return energy === 0
                ? { ok: true, detail: { held, boostId } }
                : { ok: false, why: '强化没打开，boost lab 里却有 ' + energy + ' 能量（被补了）' };
        },
    },
    {
        id: 'industry.boostLabGatedEnergy',
        since: '2026-10-13',
        change: 'industry：储备闸（canSpend）关着时不算 lab 计划，但照记 industryState.labs.boostLab（复审发现 3d5d49f 的回归）：task_broker 的 boost lab 补能只认这个 id、闸比储备闸松（富余且 ≥ terminalFillStorageAbove），storage 5–10 万时丢了 id，已装好化合物的 boost lab 就断了能量，boostCreep 失败、化合物进 boostSkip',
        check(report, ROOMS) {
            const room = ROOMS.boostLabGated;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 boostLabGated 用户的 Memory（场景没播种？）' };
            const farLabId = memory._validationBoostGated && memory._validationBoostGated.farLabId;
            const mem = (memory.rooms || {})[room] || {};
            const labsState = (mem.industryState || {}).labs || null;
            // 前提：储备闸确实关着（走的是闸关分支）
            if (!labsState || labsState.gated !== true) return { ok: false, why: 'storage 7 万的房没走储备闸关着的分支: ' + JSON.stringify(labsState) };
            if (!farLabId || labsState.boostLab !== farLabId) return { ok: false, why: '闸关分支没记 boostLab（或不是孤立 lab）: ' + JSON.stringify({ labsState, farLabId }) };
            if (!mem.labEnergy || mem.labEnergy.lab !== farLabId) return { ok: false, why: '没出过 boost lab 的能量投递任务: ' + JSON.stringify(mem.labEnergy) };
            // 原始 DB：四个 lab 都播 0 能量，boost lab 有能量 ⇒ hauler 送的；三连没有
            const labs = (((report.labChain || {}).rooms || {})[room] || []).filter((o) => o.type === 'lab');
            const boost = labs.find((o) => o.id === farLabId);
            if (!boost || !(Number((boost.store || {}).energy || 0) > 0)) return { ok: false, why: 'boost lab 还是 0 能量: ' + JSON.stringify(boost) };
            const leaked = labs.filter((o) => o.id !== farLabId && Number((o.store || {}).energy || 0) > 0);
            return leaked.length === 0
                ? { ok: true, detail: { boost: boost.store, telemetry: mem.labEnergy } }
                : { ok: false, why: '反应三连也被补了能量: ' + JSON.stringify(leaked.map((o) => [o.id, o.store.energy])) };
        },
    },
    {
        id: 'combat.boostBeforeLaunch',
        since: '2026-10-13',
        change: 'boost 流水线（移植 overmind-absorb 79a5ee4 / 6dd5cbb，src/boost.js）：带 memory.boosts 的攻城 creep 离开母房前先走到装着化合物的 lab 旁强化，成功记进母房 boostLog；做不到的项跳过、报错的项记 boostSkip、等满 boostMaxWait 放弃，绝不让整队卡在家里。config.conquest.boosts 默认空 = 关闭（指令 boosts 可单独打开）。过去我们只会读敌人的 boost，自己从来不上',
        check(report, ROOMS) {
            const room = ROOMS.boostHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 boost 用户的 Memory（场景没播种？）' };
            // 证据一（决策事件）：母房 boostLog——被强化的 creep 只活 1500 tick、也可能已经退役回收，日志还在
            const log = ((memory.rooms || {})[room] || {}).boostLog;
            const entry = Array.isArray(log) && log.find((item) => item && item.creep === 'boost-siege' && item.compound === 'XZH2O' && item.part === 'work');
            if (!entry) return { ok: false, why: 'boostLog 里没有 boost-siege 的 XZH2O 强化: ' + JSON.stringify(log) };
            if (Number(entry.parts) !== 3) return { ok: false, why: '3 个 WORK 只强化了 ' + entry.parts + ' 个: ' + JSON.stringify(entry) };
            // 证据二（原始 DB）：夹具没有 storage，lab 的货与能量没有别人会动——XZH2O 正好少 3×30、能量至少少 3×20，只可能是 boostCreep 扣的
            const scene = report.boostScene || {};
            const lab = (scene.labs || [])[0];
            if (!lab) return { ok: false, why: 'boostHome 的 lab 不在原始 DB 里（被拆？）: ' + JSON.stringify(scene) };
            const mineral = Number((lab.store || {}).XZH2O || 0);
            const energy = Number((lab.store || {}).energy || 0);
            if (mineral !== 600 - 90 || energy > 2000 - 60) {
                return { ok: false, why: 'lab 的扣量对不上 3 个 WORK（播 XZH2O 600 / 能量 2000）: ' + JSON.stringify(lab.store) };
            }
            // creep 还在就再看身体：WORK 全上了 XZH2O
            const body = scene.creep && scene.creep.body;
            if (body) {
                const works = body.filter((part) => part.type === 'work');
                if (!works.length || works.some((part) => part.boost !== 'XZH2O')) return { ok: false, why: 'creep 身上的 WORK 没全强化: ' + JSON.stringify(body) };
            }
            return { ok: true, detail: { entry, lab: lab.store, creepRoom: scene.creep && scene.creep.room } };
        },
    },
    {
        id: 'sk.keeperMining',
        since: '2026-10-13',
        change: 'Source Keeper 采矿（移植 overmind-absorb 4dcc63c / ffb9b31 / 67a8baf / e46f060 / 55f98c2，config.sk 默认关，大脑指令 skMining + 外矿白名单才开）：RCL7 起把 keeper 房当特殊外矿（record.sk），先派一只净回血的自愈远程风筝手 skReaper（roles/skReaper.js）站 3 格外杀 keeper，它进房在岗前不为这个房派任何矿工/运输工；矿工 7 WORK、keeper 在 4 格内或 lair 快孵时退到 5 格外；没有 reserver。此前所有带 lair 的房都被永久停用（keeperRoom）',
        check(report, ROOMS) {
            const room = ROOMS.skHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 ValidationSk 的 Memory（场景没播种？）' };
            const record = (((memory.rooms || {})[room] || {}).remotes || {})[ROOMS.skRoom];
            if (!record) return { ok: false, why: `${ROOMS.skRoom} 没被收成外矿（keeper 房仍被永久停用？）` };
            if (!record.sk || !record.enabled) {
                return { ok: false, why: '收了但不是启用的 SK 外矿: ' + JSON.stringify({ sk: record.sk, enabled: record.enabled, reason: record.suspendReason }) };
            }
            // 决策事件一：reaper 到岗前扣住过矿工（开局没有 reaper，这一支必然走到）；之后放开过（skStation.first）
            if (!(Number(record.skWaitReaper) > 0)) return { ok: false, why: '没有 skWaitReaper：getDemands 从没因 reaper 不在岗扣住矿工' };
            const station = record.skStation;
            if (!station || !(Number(station.first) > 0)) return { ok: false, why: 'reaper 从没进房在岗（skStation 空；5000 的身体排不上队？）' };
            // 证据二（原始 DB）：夹具播的那只 keeper 掉血或已从 DB 消失——引擎只在它掉血/死亡时才删掉或换掉它，房里会打它的只有 reaper
            const keeperId = memory._validationSk && memory._validationSk.keeperId;
            const scene = report.skScene || {};
            if (!keeperId || !Array.isArray(scene.keepers)) return { ok: false, why: '缺 keeperId 或 skScene: ' + JSON.stringify({ keeperId, scene }) };
            if (scene.controller) return { ok: false, why: 'keeper 房还有 controller（夹具没删掉，源不是 4000 档）' };
            const seeded = scene.keepers.find((keeper) => keeper.id === String(keeperId));
            if (seeded && !(Number(seeded.hits) < 5000)) {
                return { ok: false, why: 'reaper 在岗但播的 keeper 毫发无伤: ' + JSON.stringify({ keepers: scene.keepers, combat: record.skReaper }) };
            }
            const combat = record.skReaper;
            if (!combat || !(Number(combat.shots) > 0)) return { ok: false, why: 'reaper 没有开过火（skReaper.shots）: ' + JSON.stringify(combat) };
            // 证据三：矿工在 keeper 房里采到了能量，且第一次开采不早于 reaper 到岗（矿工只在 reaper 在岗后才派）
            const harvest = record.skHarvest;
            if (!harvest || !(Number(harvest.n) > 0)) return { ok: false, why: 'reaper 打了 keeper，但矿工没在 keeper 房里采到能量（skHarvest 空）' };
            if (Number(harvest.first) < Number(station.first)) {
                return { ok: false, why: '矿工比 reaper 先开采: ' + JSON.stringify({ harvest, station }) };
            }
            return { ok: true, detail: { combat, harvest, station, seeded: seeded || null, sources: scene.sources, retreat: record.skRetreat || null } };
        },
    },
    {
        id: 'sk.demotedReaperNotLoss',
        since: '2026-10-13',
        change: 'SK 外矿被移出白名单/开关关掉退回 keeperRoom 后，reaper 回家回收或放弃自杀时标 retired，noteReaperLoss 也只记启用中的 SK 外矿（复审发现）：旧代码把这两只当成被打死，连记两次就把永久停用的 keeperRoom 改写成 skReaperLost，syncKeeperRooms 只认 keeperRoom，这个房回到白名单也再升级不回 SK 外矿',
        check(report, ROOMS) {
            const room = ROOMS.skHome;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 ValidationSk 的 Memory（场景没播种？）' };
            const record = (((memory.rooms || {})[room] || {}).remotes || {})[ROOMS.skDemoted];
            if (!record) return { ok: false, why: `${ROOMS.skDemoted} 的外矿记录没了（夹具没播？）` };
            if (record.sk || record.suspendReason !== 'keeperRoom') {
                return { ok: false, why: '移出白名单的 SK 外矿没有停在 keeperRoom: ' + JSON.stringify({ sk: record.sk, reason: record.suspendReason, losses: record.skLosses }) };
            }
            if (record.skLosses) return { ok: false, why: '回收的 reaper 被记成了阵亡: ' + JSON.stringify(record.skLosses) };
            // 行动证据：两只 reaper 都已离世（回收/自杀后 main.js 清内存时走过 noteReaperLoss）；没走完的必须标着 retired
            const names = (memory._validationSk && memory._validationSk.demotedReapers) || [];
            if (names.length !== 2) return { ok: false, why: '_validationSk.demotedReapers 不是两只: ' + JSON.stringify(names) };
            const creeps = memory.creeps || {};
            const alive = names.filter((name) => creeps[name]);
            if (alive.length === names.length) return { ok: false, why: '两只 reaper 都还活着，没走到回收（noteReaperLoss 没机会跑）: ' + JSON.stringify(alive.map((name) => creeps[name])) };
            const notRetired = alive.filter((name) => !creeps[name].retired);
            if (notRetired.length) return { ok: false, why: '还活着的 reaper 没标 retired: ' + JSON.stringify(notRetired) };
            return { ok: true, detail: { reason: record.suspendReason, gone: names.length - alive.length } };
        },
    },
    {
        id: 'expansion.autoClaimOffline',
        since: '2026-10-13',
        change: '大脑掉线时占领不停摆（移植 overmind-absorb a57da2e/b63cc9c）：指令 ttl 到期超过 expansion.autoClaimAfterMs（一天）后，expansion 从 Memory.map 情报（或遗留的 claim.queue / <母房>.claim 锁）里挑一个明显安全的房自治占领——双源、无主、无 keeper/敌情/他人预定、不是在采的外矿、本房没去失败过、距离 ≤ 2、不穿危险房走得到、一次只开一个；有可用指令或从没有 Memory.brain 时绝不出手，大脑回来立刻让位。旧代码掉线后 claimTarget 恒为 null，账号停止长房',
        check(report, ROOMS) {
            const home = ROOMS.autoClaimHome;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 autoClaim 用户的 Memory（场景没播种？）' };
            // 证据一（决策）：兜底挑中了正南的中立房，而不是房名更小、记成别人房的 decoy。
            // 读持久的 autoClaimPicked：占下后缓存复核不过、重扫记 busy:<目标> 会覆盖 autoClaim（2026-10-14 validation-mZRVaL 正确的一轮因此误判）
            const roomMemory = (memory.rooms || {})[home] || {};
            const decision = roomMemory.autoClaimPicked;
            if (!decision || decision.room !== ROOMS.autoClaimTarget || decision.from !== 'map') {
                return { ok: false, why: '掉线兜底没有挑中 ' + ROOMS.autoClaimTarget + '（旧代码掉线后不占房）: ' + JSON.stringify({ picked: decision, autoClaim: roomMemory.autoClaim }) };
            }
            const pickedExpansion = roomMemory.expansion;
            if (!pickedExpansion || pickedExpansion.target !== ROOMS.autoClaimTarget || pickedExpansion.autonomous !== true) {
                return { ok: false, why: '开荒记录不是兜底挑的目标: ' + JSON.stringify(pickedExpansion) };
            }
            // 证据二（行动）：目标房 controller 已归本用户（原始 DB），或还在路上——有 targetRoom 指向它的 claimer/pioneer、开荒记录标着 autonomous
            const scene = report.autoClaimScene || {};
            const travelers = creepsOf(report, home).filter((creep) => creep && creep.targetRoom === ROOMS.autoClaimTarget &&
                (creep.role === 'claimer' || creep.role === 'pioneer'));
            const expansion = roomMemory.expansion;
            const inFlight = travelers.length > 0 && expansion && expansion.target === ROOMS.autoClaimTarget && expansion.autonomous === true;
            if (!scene.owned && !inFlight) {
                return { ok: false, why: '挑中了目标但没去占（controller 不归本用户、也没有在途的 claimer/pioneer）: ' + JSON.stringify({ scene, expansion, travelers }) };
            }
            // 证据三（不越位）：别的场景要么没有 Memory.brain、要么指令有效，一个都不该出现 autoClaim
            for (const [room, other] of Object.entries(report.rootMemories || {})) {
                // autoClaimCpu 用户同样掉线（CPU 闸的场景），它的 autoClaim 是预期内的
                if (!other || other === memory || room === ROOMS.autoClaimCpuHome) continue;
                const leaked = Object.entries(other.rooms || {}).filter(([, entry]) => entry && entry.autoClaim);
                if (leaked.length) return { ok: false, why: room + ' 的用户没有掉线的大脑却跑了自治占领: ' + JSON.stringify(leaked.map(([name, entry]) => [name, entry.autoClaim])) };
            }
            return { ok: true, detail: { decision, owned: !!scene.owned, travelers: travelers.length } };
        },
    },
    {
        id: 'expansion.autoClaimCpuGate',
        since: '2026-10-13',
        change: '自治占领兜底加 CPU 闸（复审发现）：bucket < expansion.autoClaimMinBucket（5000）或最近 5 条 Memory.stats 的 tick 用量均值 > limit × autoClaimMaxCpuShare（0.8）时不挑新房，已在开荒的自治目标照常开完。旧兜底只看 GCL/母房/忙碌，大脑掉线一天后会往一个已经 180/160 的账号再加一个房（2026-10-08 bucket 53 那次就是房涨得比 CPU 快）',
        check(report, ROOMS) {
            const home = ROOMS.autoClaimCpuHome;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 autoClaimCpu 用户的 Memory（场景没播种？）' };
            const roomMemory = (memory.rooms || {})[home] || {};
            // 决策：兜底确实走到了（掉线一天、合格邻房都在），并被 CPU 闸挡下——旧代码直接挑中正南房
            const held = roomMemory.autoClaimCpuHeld;
            if (!held || !(Number(held.n) > 0) || !(Number(held.mean) > Number(held.line))) {
                return { ok: false, why: '近期用量远超线时没有被 CPU 闸挡住（没有 autoClaimCpuHeld）: ' + JSON.stringify({ held, autoClaim: roomMemory.autoClaim }) };
            }
            // 行动：被挡住期间没出发——没有开荒记录，或开荒记录晚于第一次被挡（缓存到期、用量回落后才挑）
            const expansion = roomMemory.expansion;
            if (expansion && expansion.target === ROOMS.autoClaimCpuTarget && !(Number(expansion.since) > Number(held.first))) {
                return { ok: false, why: 'CPU 闸挡住的同时照样开了荒: ' + JSON.stringify({ held, expansion }) };
            }
            const travelers = creepsOf(report, home).filter((creep) => creep && creep.targetRoom === ROOMS.autoClaimCpuTarget &&
                (creep.role === 'claimer' || creep.role === 'pioneer'));
            if (travelers.length && !expansion) return { ok: false, why: '没有开荒记录却有去目标房的 claimer/pioneer: ' + JSON.stringify(travelers) };
            return { ok: true, detail: { held, autoClaim: roomMemory.autoClaim || null, expansion: expansion || null } };
        },
    },
    {
        id: 'industry.labPlanGated',
        since: '2026-10-13',
        change: 'industry：储备闸（canSpend）关着时不算 lab 取送计划（反应不会跑、labTech 也不会孵），state.labs 记 gated。线上大多数 RCL6+ 房 storage≈0，labPlan 每 5 tick 在每个这样的房白算一遍',
        check(report, ROOMS) {
            // terminalPeer：RCL6、storage 0 ⇒ canSpend 永远关着；labHome：储备闸开着 ⇒ 照常出计划
            const peerMem = report.rootMemories && report.rootMemories[ROOMS.terminalHome];
            const gated = (((((peerMem || {}).rooms || {})[ROOMS.terminalPeer] || {}).industryState || {}).labs) || null;
            if (!gated || gated.gated !== true || gated.product != null) return { ok: false, why: 'storage 0 的 RCL6 房没走闸关着的分支: ' + JSON.stringify(gated) };
            const labMem = report.rootMemories && report.rootMemories[ROOMS.labHome];
            const open = (((((labMem || {}).rooms || {})[ROOMS.labHome] || {}).industryState || {}).labs) || null;
            return open && !open.gated && open.product
                ? { ok: true, detail: { gated, open: { product: open.product, target: open.target } } }
                : { ok: false, why: '储备闸开着的 labHome 也被当成闸关着: ' + JSON.stringify(open) };
        },
    },
    {
        id: 'terminal.mineralTransfer',
        since: '2026-10-13',
        change: '终端网络的矿物调剂（移植 overmind-absorb 019c5b1）：能量这一轮没有要发的，就把基础矿从 terminal 里有余量（> mineralKeep + mineralWant）的己方房送到有 lab、缺这种矿（< mineralWant）的己方房；市场不卖缺着的矿。一个房只有一种矿脉，过去反应链在绝大多数房永远卡在「缺基础矿」',
        check(report, ROOMS) {
            const home = ROOMS.labHome;
            const peer = ROOMS.labPeer;
            const memory = report.rootMemories && report.rootMemories[home];
            if (!memory) return { ok: false, why: '没有 labChain 用户的 Memory（场景没播种？）' };
            const mineral = (memory.terminalNetwork || {}).mineral || {};
            const last = mineral.last;
            if (!last || !(Number(mineral.sent) > 0)) return { ok: false, why: '一笔矿物调剂都没做成: ' + JSON.stringify(memory.terminalNetwork) };
            if (last.from !== peer || last.to !== home || last.resource !== 'O') return { ok: false, why: '调剂方向/资源不对: ' + JSON.stringify(last) };
            // 决定性证据（原始 DB）：labHome 只播了 600 O；O 每反应一次换成等量的 OH，所以 labHome 里 O + OH 超过 600 ⇒ 真的收到了；
            // 发送方 terminal 的 O 也真的少了
            const rooms = (report.labChain || {}).rooms || {};
            const sum = (objects, key) => (objects || []).reduce((total, o) => total + Number((o.store || {})[key] || 0), 0);
            const received = sum(rooms[home], 'O') + sum(rooms[home], 'OH');
            const left = sum((rooms[peer] || []).filter((o) => o.type === 'terminal'), 'O');
            return received > 600 && left < 6000
                ? { ok: true, detail: { last, received, left } }
                : { ok: false, why: '记了调剂但 O 没真的过去: ' + JSON.stringify({ received, left, last }) };
        },
    },
    {
        id: 'layout.oneOffBeforeRoads',
        since: '2026-10-13',
        change: 'layout：一次性的 storage/terminal 工地排在道路与 extension 之前（extension 还缺时给它留 1 个名额），lab/factory 仍走 luxuryStorageAbove 门槛（0→RCL8 基准 t=1.16M、六房 RCL7 时全账号 terminal 0 座：terminal 在 RCL6 解锁时 extension 上限同时 +10，名额被道路与新 extension 吃光；移植 overmind-absorb 55183d1/924a8c8）',
        check(report, ROOMS) {
            const room = ROOMS.layoutOneOff;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 layoutOneOff 用户的 Memory（场景没播种？）' };
            const mem = (memory.rooms || {})[room] || {};
            const ahead = mem.oneOffAhead;
            // 旧顺序不写 oneOffAhead：6 个名额全给了 extension，terminal 要等路与 extension 建完才排得上
            if (!ahead || ahead.type !== 'terminal') return { ok: false, why: '刚到 RCL6、名额只剩 6 个时没有提前放出 terminal 工地: ' + JSON.stringify(ahead) };
            if (!(Number(ahead.extNeed) > 0)) return { ok: false, why: 'terminal 提前放出时 extension 已不缺（场景没摆出饥饿窗口）: ' + JSON.stringify(ahead) };
            if (Number(ahead.level) !== 6) return { ok: false, why: '提前放出 terminal 时不是 RCL6: ' + JSON.stringify(ahead) };
            // 奢侈门槛不动：storage 0 时 lab 照样被挡（layout 每轮记 luxuryHeld）
            return mem.luxuryHeld
                ? { ok: true, detail: { ahead, luxuryHeld: mem.luxuryHeld } }
                : { ok: false, why: 'storage 0 时 lab 没有被奢侈门槛挡住（没有 luxuryHeld）' };
        },
    },
    {
        id: 'layout.oneOffLeftover',
        since: '2026-10-13',
        change: 'layout：oneOffBeforeRoads 开着时塔之后照样跑 storage/terminal 的兜底轮（复审发现）：提前那一轮在 extension 还缺时给它留 1 个名额，extension 方案位放不出（被挡等拆迁 / 方案位不够）、塔也不缺时，这个名额旧分支落给 rampart、terminal 永远排不上；旧 main 的顺序本来就把塔之后剩下的名额给 storage/terminal',
        check(report, ROOMS) {
            const room = ROOMS.layoutLeftover;
            const memory = report.rootMemories && report.rootMemories[room];
            if (!memory) return { ok: false, why: '没有 layoutLeftover 用户的 Memory（场景没播种？）' };
            const mem = (memory.rooms || {})[room] || {};
            const leftover = mem.oneOffLeftover;
            if (!leftover || leftover.type !== 'terminal') {
                // 带上规划位：x/y ∈ {1,48} 的位置贴着出口时引擎不给放工地（validation-52vHk6 的 (42,1)），是夹具问题不是代码回归
                const spot = (mem.plan || {}).terminal || null;
                const edge = !!spot && (spot.x <= 1 || spot.x >= 48 || spot.y <= 1 || spot.y >= 48);
                return { ok: false, why: '只剩 1 个名额、extension 放不出、塔不缺时兜底轮没有放出 terminal 工地: ' +
                    JSON.stringify({ leftover, ahead: mem.oneOffAhead || null, planTerminal: spot, edgeTile: edge }) };
            }
            // 同一 tick 早轮已放过：room.find/lookForAt 是 tick 开头的快照，兜底轮再放同一格也会拿到 OK（处理器才丢掉重复），这是假阳性
            const ahead = mem.oneOffAhead;
            if (ahead && ahead.at === leftover.at && ahead.type === leftover.type) {
                return { ok: false, why: '早轮与兜底轮同 tick 重复放同一个一次性工地: ' + JSON.stringify({ leftover, ahead }) };
            }
            if (!(Number(leftover.extNeed) > 0)) return { ok: false, why: '兜底轮放出 terminal 时 extension 已不缺（场景没摆出"留了名额却放不出 extension"）: ' + JSON.stringify(leftover) };
            if (Number(leftover.level) !== 6) return { ok: false, why: '兜底轮放出 terminal 时不是 RCL6: ' + JSON.stringify(leftover) };
            return { ok: true, detail: { leftover, ahead: mem.oneOffAhead || null } };
        },
    },
    {
        id: 'layout.oneOffSameTickDedupe',
        since: '2026-10-14',
        change: 'layout：兜底轮不再重放早轮本 tick 已放出的 storage/terminal（复审发现）：room.find/lookForAt 与 createConstructionSite 的运行时检查只看 tick 开头的对象，早轮放出 terminal 后兜底轮仍"缺 terminal"、同格再放也拿到 OK（处理器才丢掉重复）——白花一个名额（这一轮的 lab/spawn/rampart 少放一个）还写一条同 tick 的假 oneOffLeftover',
        check(report, ROOMS) {
            const room = ROOMS.layoutDedupe;
            const memory = report.rootMemories && report.rootMemories[ROOMS.layoutOneOff];
            if (!memory) return { ok: false, why: '没有 layoutOneOff 用户的 Memory（场景没播种？）' };
            const mem = (memory.rooms || {})[room] || {};
            const ahead = mem.oneOffAhead;
            if (!ahead || ahead.type !== 'terminal' || Number(ahead.level) !== 6) {
                return { ok: false, why: 'layoutDedupe 房早轮没放出 terminal（前提没摆出来）: ' + JSON.stringify({ ahead, planTerminal: (mem.plan || {}).terminal || null }) };
            }
            const leftover = mem.oneOffLeftover;
            // 旧行为：兜底轮同 tick 重放 terminal ⇒ oneOffLeftover 与 oneOffAhead 同 tick、同类型
            if (leftover && leftover.at === ahead.at && leftover.type === ahead.type) {
                return { ok: false, why: '兜底轮同 tick 重放了早轮已放的 terminal: ' + JSON.stringify({ ahead, leftover }) };
            }
            const dedup = mem.oneOffDeduped;
            // 新行为：兜底轮还有名额（budget > 0）时看到早轮放过、跳过并记遥测
            if (!dedup || dedup.type !== 'terminal' || dedup.at !== ahead.at || !(Number(dedup.budget) > 0)) {
                return { ok: false, why: '没有同 tick 去重的遥测（兜底轮没走到跳过分支）: ' + JSON.stringify({ ahead, dedup: dedup || null }) };
            }
            return { ok: true, detail: { ahead, dedup } };
        },
    },
    {
        id: 'upgrade.storageRich',
        since: '2026-09-06',
        change: 'storage ≥ storageFeedAbove 时升级者上限用 maxUpgradersRich（RCL5：3），供给比例按 storage 水位、hauler 从 storage 回流喂控制器容器',
        check(report, ROOMS) {
            const upgraders = creepsOf(report, ROOMS.aidHome).filter((memory) => memory.role === 'upgrader' && memory.home === ROOMS.aidHome);
            const probe = roomProbe(report, ROOMS.aidHome);
            const storage = probe && probe.storage;
            if (storage != null && storage < 20000) return { ok: false, why: `母房 storage 结束时只剩 ${storage}，富余规则没有生效的前提` };
            if (upgraders.length < 3) return { ok: false, why: `母房 storage ${storage} 富余，升级者只有 ${upgraders.length} 只（富余上限 3，旧上限 2）` };
            // storage 的能量真的进了升级（机制闩锁，fixtures.storageUpgradeFeedObserver 逐 tick 读事件日志）：升级者直接从 storage 取、
            // 从 storage 取货的 creep 送进控制器容器/ctrl link、store link → ctrl link，三者合计。
            // 旧判据"末态 storage ≤ 70000"取决于随机地形里 storage 离控制器多远、是 link 还是 storage 供能
            // （validation-jcpzXR 28 格、link 供能只降到 74161；P08lHz 4 格降到 57098），规则同样生效却忽红忽绿。
            // 旧规则下 hauler 只在源容器空了才碰 storage（静态矿工把源容器一直填着）——hauler 喂控制器这条路径是 0；
            // 门槛 STORAGE_FEED_MIN 只要求"不是零星几次"：约一车 1200 CARRY 的货，或 3 只 W15 升级者吃 20 多 tick
            const STORAGE_FEED_MIN = 1000;
            const root = report.rootMemories && report.rootMemories[ROOMS.aidHome];
            const feed = root && root._storageUpgradeFeed;
            if (!feed) return { ok: false, why: `没有 storage → 升级的闩锁（_storageUpgradeFeed 缺失，观察包装没装上或被冲掉：${JSON.stringify((report.wrapperReinstalls || []).filter((r) => r.name === 'storageUpgradeFeed'))}）` };
            const total = (Number(feed.direct) || 0) + (Number(feed.hauled) || 0) + (Number(feed.link) || 0);
            return total >= STORAGE_FEED_MIN
                ? { ok: true, detail: feed }
                : { ok: false, why: `升级者 ${upgraders.length} 只但 storage 进升级的能量只有 ${total}（< ${STORAGE_FEED_MIN}）：${JSON.stringify(feed)}，末态 storage ${storage}` };
        },
    },
    {
        id: 'upgrade.storageFeedBand',
        since: '2026-09-07',
        change: 'controllerFeedStorage 的补给地板改为 max(controllerFeedStorageFloor, upgrading.reserve + controllerFeedStorageBand)：两者原本都是 2000，storage 供能的房补到 2000 就停手，而升级者只取 2000 以上，可取量恒为 0',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.storageFed);
            if (!probe) return { ok: false, why: 'storageFed 场景没有探针' };
            const band = probe.ctrlFeedBand;
            // 看的是决策事件计数，不是期末快照：storage 已在取用底线之上却仍按第三层补——旧代码（地板 = reserve）结构上到不了这里。
            // 末态快照不能用：跑到后面 storage 自然会涨过底线，新旧代码都一样
            if (!band) {
                return { ok: false, why: `storage 供能房从没在 storage ≥ upgrading.reserve 时出过补给任务（旧地板停在 reserve 上；storage 期末 ${probe.storage}）` };
            }
            if (!(Number(band.n) > 0)) return { ok: false, why: `ctrlFeedBand 计数为 ${band.n}` };
            if (!(Number(band.floor) > Number(band.energy))) {
                return { ok: false, why: `记录的地板 ${band.floor} 不高于当时的 storage ${band.energy}` };
            }
            return { ok: true };
        },
    },
    {
        id: 'build.criticalRepairBuilder',
        since: '2026-09-07',
        change: 'spawn.hasBuilderWork：方案内非 rampart 结构掉到维修目标的 criticalRepairShare（0.2）以下时，即使塔有能量也放行一只维修 builder——旧代码"有塔就不为维修孵 builder"会让深坑无人负责',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.storageFed);
            if (!probe) return { ok: false, why: 'storageFed 场景没有探针' };
            const record = probe.criticalRepair;
            // 看决策事件，不看末态：末态里容器可能已被修回危急线之上，新旧代码都不再放行，区分不了
            if (!record) {
                return { ok: false, why: '从没在"有危急结构 + 塔有能量"时把维修算作 builder work（旧代码在这里被塔守卫拦住）' };
            }
            if (!(Number(record.n) > 0)) return { ok: false, why: `criticalRepair 计数为 ${record.n}` };
            // noSites 才严格区分新旧：有工地时旧代码也会返回 true（工地那一支在塔守卫之前）
            if (!record.noSites) {
                return { ok: false, why: `只在有工地时命中过（n=${record.n}），那种状态旧代码同样算 builder work，区分不了新旧` };
            }
            return { ok: true };
        },
    },
    {
        id: 'repair.criticalBeatsRampart',
        since: '2026-09-07',
        change: 'utils.compareRepairTargets（tower.js 与 roles/builder.js 共用）：危急水位的"会消失"结构（容器/道路）排在 rampart 之前，即使 rampart 的比值更低——旧排序只看比值，一个刚重置目标的 rampart 会吃掉全部维修产出',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.storageFed);
            if (!probe) return { ok: false, why: 'storageFed 场景没有探针' };
            const split = probe.repairSplit;
            if (!split || typeof split !== 'object') return { ok: false, why: '探针没记维修分账（旧代码）' };
            const crit = Number(split.crit);
            const ram = Number(split.ram);
            if (!Number.isFinite(crit)) return { ok: false, why: '探针里没有容器血量' };
            // 播下：容器 12000（4.8%）、rampart 10（0.01%）。旧排序比值更低的 rampart 全拿，容器纯衰减到 12000 以下；
            // 新排序容器优先，必须比播下时高。看的是"谁拿到了产出"，不是末态好不好
            if (crit <= 12000) {
                return { ok: false, why: `危急容器没被修：播下 12000 → 结束 ${crit}（rampart 最低 ${ram}，旧排序会把产出全给它）` };
            }
            return { ok: true };
        },
    },
    {
        id: 'build.spawnFirst',
        since: '2026-09-06',
        change: 'spawn 工地永远最先建（builder 排序 -1、broker 建造权重 10），道路等后面',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.aidNew1);
            const sites = probe && probe.sites;
            if (!Array.isArray(sites)) return { ok: false, why: '探针没有新房的工地列表' };
            const spawn = sites.find((site) => site[0] === 'spawn');
            const roads = sites.filter((site) => site[0] === 'road');
            const roadProgress = roads.reduce((sum, site) => sum + Number(site[1] || 0), 0);
            if (!spawn) {
                // spawn 已建成（工地消失）：只要路没有先于它建完就算生效
                return roads.every((site) => Number(site[1] || 0) < Number(site[2] || 0)) || roads.length === 0
                    ? { ok: true }
                    : { ok: false, why: `spawn 建成了但路也先建完了: ${JSON.stringify(roads)}` };
            }
            return Number(spawn[1] || 0) > 0 && Number(spawn[1] || 0) >= roadProgress
                ? { ok: true }
                : { ok: false, why: `spawn 工地 ${spawn[1]}/${spawn[2]}，道路合计 ${roadProgress}（道路排在 spawn 前面）` };
        },
    },
    {
        id: 'remote.dropRoomByPath',
        since: '2026-09-06',
        change: '外矿卸货房按 PathFinder 路径长度选（跳数只筛候选），记录写在 remotes[房].drop',
        check(report, ROOMS) {
            // brain 场景：母房 E11S11 按白名单启用外矿 E12S11（validateReport 已断言 enabled），run() 会给启用记录算 drop
            const memory = report.rootMemories && report.rootMemories[ROOMS.brainHome];
            const record = memory && memory.rooms && memory.rooms[ROOMS.brainHome] && memory.rooms[ROOMS.brainHome].remotes && memory.rooms[ROOMS.brainHome].remotes[ROOMS.brainRemote2];
            if (!record) return { ok: false, why: 'brain 场景没有外矿记录' };
            const drop = record.drop;
            if (!drop || !drop.room) return { ok: false, why: '外矿记录没有 drop（卸货房没算过）' };
            return drop.room === ROOMS.brainHome && drop.at > 0
                ? { ok: true }
                : { ok: false, why: `唯一母房场景里卸货房应是母房，得 ${JSON.stringify(drop)}` };
        },
    },
    {
        id: 'retire.crippled',
        since: '2026-09-06',
        change: 'retire.retireCrippled：必需部件全阵亡的残废 creep 宽限后标记 crippled 回收退役、编制立刻排除（remote 场景母房播一只 CARRY 全 0 血的 hauler）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
            if (!memory) return { ok: false, why: '没有 remote 母房的根 Memory' };
            const log = ((memory.rooms || {})[ROOMS.remoteHome] || {}).crippledLog || [];
            const entry = log.find((item) => item && item.name === 'remote-crippled-hauler');
            if (!entry) return { ok: false, why: `crippledLog 里没有 remote-crippled-hauler（得 ${JSON.stringify(log)}）` };
            if (!(entry.lost || []).includes('carry')) return { ok: false, why: `记录的阵亡部件应含 carry，得 ${JSON.stringify(entry.lost)}` };
            return memory.creeps && memory.creeps['remote-crippled-hauler']
                ? { ok: false, why: '残废 creep 仍在 Memory.creeps 里（没有被回收/自杀）' }
                : { ok: true };
        },
    },
    {
        id: 'storage.collectFallback',
        since: '2026-09-06',
        change: 'storage 富余规则修正：容器供能房里 storage 取货只是源容器空了之后的兜底（权重 6 < 源容器 7、标 rich），阈值滞回记在 Memory.rooms[房].storageRich（logistics 场景播 4 万 storage）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
            const state = memory && memory.rooms && memory.rooms[ROOMS.logistics] && memory.rooms[ROOMS.logistics].storageRich;
            if (!state || state.on !== true) return { ok: false, why: `storage 4 万却没进入富余状态（storageRich: ${JSON.stringify(state)}）` };
            const probe = roomProbe(report, ROOMS.logistics);
            const collect = probe && probe.collect;
            if (!Array.isArray(collect)) return { ok: false, why: `探针没有取货候选（collect: ${JSON.stringify(collect)}）` };
            // 控制器容器已喂到 upgraderFillBelow（80%）以上：富余取货本就不发布（feeder 把容器喂满时探针正好看到这种时刻），没有"压过源容器"可违反
            if (probe.ctrl != null && probe.ctrl >= 1600) return { ok: true };
            const storage = collect.find((item) => item[0] === 'storage');
            const containers = collect.filter((item) => item[0] === 'container');
            if (!storage) return { ok: false, why: `取货候选里没有 storage（${JSON.stringify(collect)}）` };
            if (!storage[3]) return { ok: false, why: `storage 取货没标 rich（控制器容器 ${probe.ctrl}，${JSON.stringify(storage)}）` };
            if (!containers.length) return { ok: false, why: `取货候选里没有容器（${JSON.stringify(collect)}）` };
            const minContainer = Math.min(...containers.map((item) => item[1]));
            return storage[1] < minContainer
                ? { ok: true }
                : { ok: false, why: `storage 取货权重 ${storage[1]} 没有低于容器 ${minContainer}（${JSON.stringify(collect)}）` };
        },
    },
    {
        id: 'remote.unreachableBackoff',
        since: '2026-09-06',
        change: 'remote：不可达指数退避（unreachableCount/unreachableAt 进记录）与试探恢复——remote 场景预置一条曾不可达的记录，creep 看到该房后计数清零',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
            const remotes = memory && memory.rooms && memory.rooms[ROOMS.remoteHome] && memory.rooms[ROOMS.remoteHome].remotes;
            const record = remotes && remotes[ROOMS.remote];
            if (!record) return { ok: false, why: '母房没有外矿记录' };
            if (!(record.unreachableAt > 0)) return { ok: false, why: `预置的 unreachableAt 没有保留（旧代码的记录归一化会丢掉它）：${JSON.stringify(record.unreachableAt)}` };
            if (record.unreachableCount !== 0) return { ok: false, why: `creep 看到该房后 unreachableCount 应清零，得 ${JSON.stringify(record.unreachableCount)}` };
            return record.lastSeen > record.unreachableAt
                ? { ok: true }
                : { ok: false, why: `lastSeen ${record.lastSeen} 不晚于 unreachableAt ${record.unreachableAt}` };
        },
    },
    {
        id: 'remote.containerBeforeRoads',
        since: '2026-09-06',
        change: '外矿容器工地优先：路工地占满 MAX_REMOTE_SITES / 全局名额时撤零进度的路放容器（remote 场景外矿房预置 6 条零进度路工地；旧代码 sites ≥ 6 直接返回，容器永远放不出）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
            const remotes = memory && memory.rooms && memory.rooms[ROOMS.remoteHome] && memory.rooms[ROOMS.remoteHome].remotes;
            const record = remotes && remotes[ROOMS.remote];
            if (!record) return { ok: false, why: '母房没有外矿记录' };
            if (!(record.roadSitesYielded >= 1)) return { ok: false, why: `没有撤过路工地（roadSitesYielded: ${JSON.stringify(record.roadSitesYielded)}，containerBlockedAt: ${JSON.stringify(record.containerBlockedAt)}）` };
            if (!(record.containerSiteAt > 0)) return { ok: false, why: `容器工地没有放出（containerSiteAt: ${JSON.stringify(record.containerSiteAt)}，containerBlockedAt: ${JSON.stringify(record.containerBlockedAt)}）` };
            // 保留线（roadsHeldAt）不在这里断言：它要求 globalSiteCount() ≥ 100 − remoteContainerSiteReserve(98)，
            // 而 Game.constructionSites 只含**有视野**房间的工地，夹具那 94 条占位路在没视野的 industryTarget 里，
            // 于是这个条件在私服里永远不成立——旧代码只在"容器到结束时还没建成"时才碰巧通过（built=false 直接跳过）。
            // 本断言的目的是"容器优先于道路"，前两条已经覆盖（撤过路 + 容器工地放出）。
            return { ok: true };
        },
    },
    {
        id: 'layout.roadsWaitForRcl',
        since: '2026-09-06',
        change: '母房路工地要等 config.roadsMinRcl（3）：RCL1–2 的新房建不动路，零进度的路会占死全账号 100 个名额（线上 W33S3/W31S5 两房 48 条）',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.bootstrap);
            if (!probe) return { ok: false, why: '没有 bootstrap 房（RCL1）的探针' };
            const sites = Array.isArray(probe.sites) ? probe.sites : [];
            const roads = sites.filter((site) => site[0] === 'road');
            if (roads.length) return { ok: false, why: `RCL${probe.rcl} 的房仍放了 ${roads.length} 个道路工地` };
            // 存量也要清（bootstrap 场景播了 4 条规划内的零进度路 + 1 条有进度的）：roadsTrimmed 记清掉的条数，有进度的那条要留下
            const memory = report.rootMemories && report.rootMemories[ROOMS.bootstrap];
            const room = memory && memory.rooms && memory.rooms[ROOMS.bootstrap];
            if (!(room && room.roadsTrimmed >= 1)) return { ok: false, why: `没有清掉改动前放下的存量路工地（roadsTrimmed: ${JSON.stringify(room && room.roadsTrimmed)}）` };
            // 有别的工地才说明 layout 确实在放置（否则"没有路"是因为整个 layout 没跑）
            return sites.length > 0 || probe.rcl >= 3
                ? { ok: true }
                : { ok: false, why: `RCL${probe.rcl} 的房一个工地都没有：无法区分"路被挡住"与"layout 没跑"` };
        },
    },
    {
        id: 'spawn.incomeSmoothing',
        since: '2026-09-06',
        change: 'spawn 收入 EMA 从 0 起按 alpha 收敛（旧代码首个样本直接当 EMA：一车 400 落在首样本就是 400/tick），并记 spawnIncome.starved——有搬运工在岗却把收入估计当 0 的 tick 数',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
            const track = memory && memory.rooms && memory.rooms[ROOMS.logistics] && memory.rooms[ROOMS.logistics].spawnIncome;
            if (!track) return { ok: false, why: '没有 spawnIncome' };
            // 样本数不设门槛：采样按设计只在房间低于满能量时进行（满仓看不到收入），而 logistics 房补满后能不能再掉下来取决于
            // 这一轮孵了什么，跑法不同就会从几百变成 0（2026-09-07 攻占会话用 VALIDATE_CONQUEST + --effect-ticks 800 跑到 n=0）。
            // alpha/门槛的数值行为由冒烟确定性覆盖（一车 400 每 60 tick，EMA 始终在 [1, 13.3]）；这里只验集成事实：
            // 采样跑起来了、且没有出现"有搬运工却把收入当 0"的抖动。线上六个房 n 在 5k–39k、starved 从未出现
            if (!(track.n > 0)) return { ok: false, why: `一个样本都没有（n=${track.n}）：采样根本没跑` };
            // starved 只作诊断、不设门槛：它统计的是既有规则（EMA 低于 minIncome 就当 0，见 3410ba9）触发的次数，本次改动只是加了这个
            // 计数器并把衰减放慢（alpha 0.05 → 0.01 让它更少发生），并没有引入它。清静的夹具房连续几百 tick 收不到货就会把 EMA
            // 衰减到 1 以下（2026-09-07 一轮跑出 82 次），那是夹具的流量，不是回归；线上六个房从未出现过。
            // 遗留问题（值得单独量化）：搬运工都在岗、只是暂时没到货，被归进"矿工/hauler 全灭"的紧急态是同一类判定，语义上不合理
            // 从 0 收敛：n 个样本后 EMA 不可能超过样本最大值，更不可能是"首样本直接赋值"那种一车 400 的尖峰
            const cap = 50;
            return track.ema <= cap
                ? { ok: true }
                : { ok: false, why: `EMA ${track.ema} > ${cap}/tick，超过两源房的物理上限（旧代码首样本直接赋值才会这样）` };
        },
    },
    {
        id: 'feeder.storageToController',
        since: '2026-09-06',
        change: 'roles/feeder：storage 富余且控制器由容器供能的房出一只专职短途搬运工，只跑 storage ↔ 控制器容器（logistics 场景 storage 在控制器容器 3–6 格内）',
        check(report, ROOMS) {
            const feeder = creepsOf(report, ROOMS.logistics).find((memory) => memory.role === 'feeder' && memory.home === ROOMS.logistics);
            if (!feeder) return { ok: false, why: 'storage 4 万且容器供能的房没有孵出 feeder' };
            const probe = roomProbe(report, ROOMS.logistics);
            const storage = probe && probe.storage;
            if (storage == null) return { ok: false, why: '探针没有 storage 能量' };
            // feeder 的本职是把控制器容器喂起来：容器过半（≥ 1000 / 2000）就算生效（hauler 同时往 storage 回库、升级者吃不完时 storage 可能不降反升）；
            // 否则要求 storage 从 40000 至少搬走 1500（没有 feeder 时只动 173，2C1M 的缩身 feeder 只到 39100）。
            // 门槛原为容器 ≥ 1600（80%），2026-09-07 放宽到过半：这条断言在机器负载高时（本机 load 10–13，两个私服并跑）
            // 反复以 1074/1436 之类的读数失败，而同一棵树在空闲时通过——它要守的是"feeder 在编且真的在跑 storage → 容器 这条线"，
            // 不是"900 tick 内搬够多少"。过半仍能区分旧代码：没有 feeder 时容器被升级者吃到近 0（那一版实测只动了 173）
            const ctrl = probe.ctrl;
            if (ctrl != null && ctrl >= 1000) return { ok: true };
            return storage <= 38500
                ? { ok: true }
                : { ok: false, why: `feeder 在编但控制器容器只有 ${ctrl}、storage 仍是 ${storage}（应把容器喂到过半 ≥ 1000 或搬走 ≥ 1500）` };
        },
    },
    {
        id: 'hauling.deliveryStops',
        since: '2026-09-06',
        change: 'hauler 编制模型加投递停靠开销（spawn 份额 × 每车停靠次数 × deliveryStopTicks），分解写在 Memory.rooms[房].haulModel（remote 母房：RCL4、20 个 extension、spawn 持续孵外矿 creep 所以收入 EMA > 0；logistics 房 spawn 常年满、份额为 0 观察不到）',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.remoteHome);
            const model = probe && probe.haulModel;
            if (!model) return { ok: false, why: '探针里没有 haulModel（旧代码不写）' };
            // 期末的停靠项可能是 0（spawn 长期满仓，收入 EMA 衰减到 0）：看本房见过的峰值 maxDeliveryTicks
            const stops = Math.max(Number(model.deliveryTicks) || 0, Number(model.maxDeliveryTicks) || 0);
            if (!(model.production > 0 && stops > 0)) return { ok: false, why: `停靠项没有生效：${JSON.stringify(model)}` };
            return model.demand >= 1 && model.load > 0
                ? { ok: true }
                : { ok: false, why: `模型分解不完整：${JSON.stringify(model)}` };
        },
    },
    {
        id: 'tower.maintenanceBudget',
        since: '2026-09-07',
        change: '房里有破损建筑且塔的能量低于 towerRepairReserve + towerMaintenanceBudget 时，塔补能从第 4 层提到第 3 层（权重 towerMaintenanceWeight）：塔停在储备线上一次也修不动，而第 4 层权重 2 在"控制器容器见底 ⇒ 第 1 层权重 20"的房里永远轮不到，基地一路烂掉。logistics 场景塔播 100、控制器容器播半血：引擎必须记录塔实际花费维修预算并修复源容器',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.logistics);
            const towers = probe && probe.towers;
            if (!Array.isArray(towers) || !towers.length) return { ok: false, why: '探针里没有塔' };
            const repaired = (report.towerMaintenance || []).some(entry => entry &&
                entry.n > 0 && entry.source > 0 && entry.peakBeforeRepair > 500);
            if (!repaired) return { ok: false, why: '没有实际塔维修源容器的引擎记录：' + JSON.stringify(report.towerMaintenance) };
            // 有了预算还要修对东西：源容器播的是 16%（40000），比同场景那条 52% 的路差得多，按比例排序它该先被修
            const src = probe.srcContainerHits;
            if (!Array.isArray(src) || !src.length) return { ok: false, why: '探针没记源容器血量（旧代码）' };
            return src.some((hits) => hits > 40000)
                ? { ok: true }
                : { ok: false, why: `源容器没被修（播下 40000 → ${JSON.stringify(src)}）：塔可能仍按绝对血量先修路` };
        },
    },
    {
        id: 'upgrade.repairStation',
        since: '2026-09-07',
        change: '升级者顺手维修自己的站位容器（低于 upgraderRepairStationBelow 就修一 tick）：容器每 tick 衰减 10 血，修 100 血只要 1 能量，比为维修多养一只 builder 便宜。logistics 场景把控制器容器播成半血，报告时它必须比播下时高',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.logistics);
            const hits = probe && probe.ctrlContainerHits;
            if (hits == null) return { ok: false, why: '探针没记控制器容器血量（旧代码）' };
            const seeded = 125000;   // fixtures.seedLogistics 播下的血量（上限 250000 的一半）
            return hits > seeded
                ? { ok: true }
                : { ok: false, why: `控制器容器没有被修：播下 ${seeded} → 结束 ${hits}（旧代码只会一路衰减）` };
        },
    },
    // 已移除 remote.reserverNoShrink（2026-09-07）：这条规则的前提——"在岗 reserver 还活着时提出换代请求，且母房当下买不起 1300"——
    // 在 remote 场景里无法稳定制造。remoteMaintain 档的请求在核心请求等待期间会被队列整体挡住（spawn_queue 的 blockCore），
    // 等解封时播下的在岗 reserver（寿命 80）已经死了，于是走的是"补空窗允许缩身"的正确分支，断言却按末态身体判失败。
    // 该行为已在 validation-NqJW8k 被真实引擎观察到一次，逻辑由 test/smoke.js 的三条断言精确覆盖（在岗换代拒绝缩身 /
    // 空窗接受缩身 / 容量不足的房照常缩身），线上也已验证（部署后 8 只 reserver 中 6 只为双 CLAIM，W33S6 预定 597 → 1297）。
    // 游戏侧保留 remotes[房].reserverHeld 作为遥测：它回答"这条外矿为什么迟迟没有新 reserver"。
    {
        id: 'hauling.linkFloor',
        since: '2026-09-06',
        change: 'hauler 底线按 link 供能的源下调（每个己方源 link −linkFloorDrop，不低于 linkFloorMin/linkFloorMinStore 2）：RCL7 有 store link 时整源算被搬走，RCL<7 只按升级者 WORK 吃得掉的部分算。links 场景 RCL7、两源 link + ctrl + store link + storage 3 万：RCL 底线 3 → 目标 2，分解在 haulModel.linkFed/linkDrain/floor（旧代码没有 linkDrain、底线 3）',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.links);
            const targets = probe && probe.targets;
            const model = probe && probe.haulModel;
            if (!targets || targets.hauler == null) return { ok: false, why: '探针里没有 hauler 目标' };
            if (!model || model.linkFed == null || model.linkDrain == null) return { ok: false, why: `haulModel 没记 linkFed/linkDrain（旧代码）：${JSON.stringify(model)}` };
            if (model.linkFed !== 2) return { ok: false, why: `两源 link 没被识别为 link 供能：${JSON.stringify(model)}` };
            // 2026-09-12：目标里可能多 1 只临时编制（haulModel.temp：塔告急 / spawn 等补给 / 源容器溢出，按 CARRY 定编），底线本身仍须是 2
            const expected = model.temp ? 3 : 2;
            return targets.hauler === expected && model.floor === 2
                ? { ok: true }
                : { ok: false, why: `link 房 hauler 目标是 ${targets.hauler}（底线 ${model.floor}、临时 ${model.temp || '无'}），期望 ${expected}` };
        },
    },
    {
        id: 'links.operatorToStorage',
        since: '2026-09-08',
        change: 'RCL7 且 store link 贴着 storage 时孵枢纽 operator，把 store link 倒进 storage；源能量不再卡在满仓的 store link 里。links 场景 store link 播 700、邻格播 operator：必须看到 transferred > 0 且 store link 低于播下值',
        check(report, ROOMS) {
            const memory = report.rootMemories[ROOMS.links];
            const operators = creepsOf(report, ROOMS.links).filter((creep) => creep.role === 'operator' &&
                (creep.home === ROOMS.links || !creep.home));
            if (!operators.length) return { ok: false, why: 'links 房没有孵出/播下 operator' };
            const room = memory && memory.rooms && memory.rooms[ROOMS.links];
            const rec = room && room.operator;
            const probe = roomProbe(report, ROOMS.links);
            const storeEnergy = probe && probe.storeLink;
            const transferred = rec && Number(rec.transferred) || 0;
            if (transferred > 0 && (storeEnergy == null || storeEnergy < 700)) return { ok: true };
            return {
                ok: false,
                why: `operator 没把 store link 倒进 storage：transferred=${transferred} storeLink=${storeEnergy} rec=${JSON.stringify(rec)}`,
            };
        },
    },
    {
        id: 'tower.refillBeforeSpawn',
        since: '2026-09-06',
        change: '有敌人或低于维修储备的塔补能提到第 1 层、权重高于 spawn/ext（logistics 场景：spawn 只播 100、塔只播 100，紧急塔必须先补）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
            const room = memory && memory.rooms && memory.rooms[ROOMS.logistics];
            if (!room || !(room.towerFirstAt > 0)) return { ok: false, why: `broker 从未让紧急塔压过有缺口的 spawn/ext（towerFirstAt: ${JSON.stringify(room && room.towerFirstAt)}）` };
            const probe = roomProbe(report, ROOMS.logistics);
            const towers = probe && probe.towers;
            if (!Array.isArray(towers) || !towers.length) return { ok: false, why: '探针里没有塔' };
            // 塔补到储备线后会维修到略低于 500 再等补能（探针抓到过 492）：只要求远高于播的 100
            return towers.some((energy) => energy >= 300)
                ? { ok: true }
                : { ok: false, why: `塔仍低于维修储备附近（播的是 100）：${JSON.stringify(towers)}` };
        },
    },
    {
        id: 'tower.repairKeepsReserve',
        since: '2026-09-06',
        change: '塔的维修/治疗不动用储备（能量 − 10 < towerRepairReserve 就不修），紧急锁存到补到不缺；和平期从已补满跌破储备记 towerBreaches（logistics 场景：塔播 100 补满后要修 spawn 上的 rampart，旧代码修到 492 又变"紧急"）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
            const room = memory && memory.rooms && memory.rooms[ROOMS.logistics];
            if (!room || !(room.towerFirstAt > 0)) return { ok: false, why: `塔从未被紧急补过（towerFirstAt: ${JSON.stringify(room && room.towerFirstAt)}）` };
            const latch = room.towerUrgent;
            if (!latch || !Object.keys(latch).length) return { ok: false, why: '没有 towerUrgent 锁存记录（补能判定没走 utils.towerUrgent）' };
            if (!Object.values(latch).some((value) => value === 0)) return { ok: false, why: `塔补满后锁存从未解除：${JSON.stringify(latch)}` };
            if (room.towerBreaches > 0) return { ok: false, why: `和平期塔跌破储备 ${room.towerBreaches} 次（最近 tick ${room.towerBreachAt}）：维修动了储备` };
            const probe = roomProbe(report, ROOMS.logistics);
            const towers = probe && probe.towers;
            if (!Array.isArray(towers) || !towers.length) return { ok: false, why: '探针里没有塔' };
            return towers.every((energy) => energy >= 500)
                ? { ok: true }
                : { ok: false, why: `结束时有塔低于维修储备 500：${JSON.stringify(towers)}` };
        },
    },
    {
        id: 'layout.linkSitesFirst',
        since: '2026-09-06',
        change: 'link 工地先于道路/extension 放置（blueprint 场景 RCL8 轮子方案从零起步：旧顺序 40 个名额被 24 条路 + 16 个 ext 占满，link 工地从不放出；建造权重由冒烟覆盖，起步期 7 只 creep 建不动 5000 的 link）',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.blueprint);
            if (!probe) return { ok: false, why: '没有 blueprint 房的探针' };
            const sites = Array.isArray(probe.sites) ? probe.sites : [];
            const linkSites = sites.filter((site) => site[0] === 'link');
            const built = Number(probe.links || 0);
            return linkSites.length || built
                ? { ok: true }
                : { ok: false, why: `既没有 link 工地也没有建成的 link（工地: ${JSON.stringify(sites.map((site) => site[0]))}）` };
        },
    },
    {
        id: 'defense.ownLossStreak',
        since: '2026-09-06',
        change: '己方房连续阵亡计数 defenseLog.streak：defender 阵亡 +1、房间清场归零，达到 config.defense.maxOwnLosses（2）后不再续派（2026-09-06 W31S5 对强化 Invader 连送 7 只阵亡 6 只）。defense 场景（E13S13）：Invader 被清后 streak 必须是 0（旧代码没有这个字段）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.defenseHome];
            const room = memory && memory.rooms && memory.rooms[ROOMS.defenseHome];
            const log = room && room.defenseLog;
            if (!log) return { ok: false, why: '没有 defenseLog' };
            if (log.streak == null) return { ok: false, why: `defenseLog 没记 streak（旧代码）：${JSON.stringify(log)}` };
            if (report.hostileCounts && report.hostileCounts[ROOMS.defenseHome] === 0 && log.streak !== 0) {
                return { ok: false, why: `清场后 streak 没归零：${JSON.stringify(log)}` };
            }
            return { ok: true };
        },
    },
    {
        id: 'safeMode.brainDecides',
        since: '2026-09-06',
        change: 'safe mode 由外置大脑决定：brain 场景母房里播一只不能动的玩家重甲 creep（无塔、defense 打不过），旧代码第 1 tick 开盾，新代码等 run.py 的 safeMode=activate 再开并记 brain:<reason>',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.brainHome];
            const log = memory && memory.rooms && memory.rooms[ROOMS.brainHome] && memory.rooms[ROOMS.brainHome].defenseLog;
            const probe = roomProbe(report, ROOMS.brainHome);
            if (!probe || !(probe.safeMode > 0)) return { ok: false, why: `母房没有开 safe mode（探针 safeMode: ${JSON.stringify(probe && probe.safeMode)}）` };
            const record = log && log.safeMode;
            if (!record) return { ok: false, why: 'defenseLog.safeMode 没有记录（旧代码不记，也不看大脑）' };
            return typeof record.by === 'string' && record.by.indexOf('brain:') === 0
                ? { ok: true }
                : { ok: false, why: `开盾的依据不是大脑决定：${JSON.stringify(record)}` };
        },
    },
    {
        id: 'core.roomPhaseSpread',
        since: '2026-09-07',
        change: "周期性工作的房名相位改用整名 hash：旧的 room.name.charCodeAt(3) 对标准房名恒为 'N'/'S'，全部房间同相位、layout/industry/demolition/remote 每轮同 tick 齐发",
        check(report) {
            const interval = require('../../src/config').layoutInterval;
            // rootMemories 按场景房键入，多个场景可能同属一个用户、拿到同一份 Memory —— 按房名去重
            const seen = new Map();
            for (const key of Object.keys(report.rootMemories || {})) {
                const rooms = report.rootMemories[key] && report.rootMemories[key].rooms;
                for (const name of Object.keys(rooms || {})) {
                    const t = rooms[name] && rooms[name].layoutAt;
                    if (typeof t === 'number') seen.set(name, t % interval);
                }
            }
            const at = [...seen.entries()];
            if (at.length < 3) return { ok: false, why: `只有 ${at.length} 个房记录了 layoutAt（旧代码根本不记这个字段）` };
            const phases = new Set(at.map((e) => e[1]));
            // 旧写法只能产出 2 个相位（N 房一个、S 房一个），新 hash 在私服这批房名上散成 9 个
            return phases.size >= 3
                ? { ok: true }
                : { ok: false, why: `${at.length} 个房只散成 ${phases.size} 个相位（旧的 charCodeAt(3) 写法上限就是 2）：${JSON.stringify(at)}` };
        },
    },
    {
        id: 'core.creepIndex',
        since: '2026-09-07',
        change: '每 tick 建一次 creep 倒排索引（utils.creepsHome / creepsHomeRole）替掉 spawn/layout/aid/remote/角色里 20+ 处 Game.creeps 全表遍历，其中 harvester 的两个 helper 原本是 O(creeps²)',
        check(report, ROOMS) {
            const probes = [ROOMS.logistics, ROOMS.links, ROOMS.remoteHome, ROOMS.bootstrap]
                .map((name) => [name, roomProbe(report, name)])
                .filter(([, probe]) => probe);
            if (!probes.length) return { ok: false, why: '没有拿到任何场景房的探针' };
            const bad = probes.filter(([, probe]) => typeof probe.homeIndexed !== 'number');
            if (bad.length) {
                return { ok: false, why: `索引没在跑：${bad.map(([n, p]) => n + '=' + JSON.stringify(p.homeIndexed)).join(', ')}（旧代码没有 utils.creepsHome，探针会拿到 ERR）` };
            }
            const hit = probes.filter(([, probe]) => probe.homeIndexed > 0);
            return hit.length
                ? { ok: true }
                : { ok: false, why: `所有场景房的索引都是空的：${JSON.stringify(probes.map(([n, p]) => [n, p.homeIndexed]))}` };
        },
    },
    {
        id: 'core.visualsGated',
        since: '2026-09-07',
        change: '房间可视化默认关（config.visuals.always=false，showVisuals(n) 临时打开，bucket 低于 minBucket 一律不画）：线上实测每房 0.74–1.22 CPU/tick，10 个房约 10 CPU/tick 花在没人看的图上',
        check(report, ROOMS) {
            const off = roomProbe(report, ROOMS.blueprint);
            if (!off) return { ok: false, why: `没拿到 ${ROOMS.blueprint} 的探针` };
            if (!(off.visualSize === 0 || off.visualSize == null)) {
                return { ok: false, why: `${ROOMS.blueprint} 没开可视化却画了 ${off.visualSize} 字节（门闸没生效）` };
            }
            // 另一边：显式打开的房必须照画，证明关掉的是门闸而不是渲染本身坏了
            const on = [ROOMS.logistics, ROOMS.links, ROOMS.bootstrap, ROOMS.remoteHome]
                .map((name) => [name, roomProbe(report, name)])
                .filter(([, probe]) => probe && typeof probe.visualSize === 'number');
            if (!on.length) return { ok: false, why: '没有任何开了可视化的房拿到 visualSize' };
            return on.some(([, probe]) => probe.visualSize > 0)
                ? { ok: true }
                : { ok: false, why: `showVisuals 打开后仍然一个房都没画：${JSON.stringify(on.map(([n, p]) => [n, p.visualSize]))}` };
        },
    },
    {
        id: 'core.probeKeyGc',
        since: '2026-09-07',
        change: 'Memory 探针残渣回收：内容不再变化的顶层下划线键（monitor 的 _mon 78 KB、remote_roi 的 _roi、临时 _dbg*）按 TTL 删掉，引擎每 tick 都要解析+序列化整个 Memory，线上约 28% 是这种死数据',
        check(report) {
            // 私服跑不满 3000 tick 的 TTL，观察点是登记表本身：旧代码没有 Memory._gcSeen
            const tracked = Object.keys(report.rootMemories || {})
                .map((key) => report.rootMemories[key] && report.rootMemories[key]._gcSeen)
                .filter((seen) => seen && typeof seen === 'object');
            if (!tracked.length) return { ok: false, why: '没有任何用户的 Memory 里有 _gcSeen（回收器没跑）' };
            const withEntries = tracked.filter((seen) => Object.keys(seen).some((k) => seen[k] && typeof seen[k].t === 'number'));
            return withEntries.length
                ? { ok: true }
                : { ok: false, why: `_gcSeen 存在但没登记任何探针键：${JSON.stringify(tracked.slice(0, 2))}` };
        },
    },
    {
        id: 'core.statsPerRoomAndModule',
        since: '2026-09-07',
        change: 'Memory.stats 改为按房名记 [rcl, progress, storage] 并带 cpuBy/cpuRooms 的按模块/按房 CPU 均值；旧版只记 rooms[0] 一个任意房，整条经济序列是死数据，cpu 字段还漏掉了 flush 与 endTick',
        check(report) {
            const entries = [];
            for (const key of Object.keys(report.rootMemories || {})) {
                const stats = report.rootMemories[key] && report.rootMemories[key].stats;
                if (Array.isArray(stats) && stats.length) entries.push(stats[stats.length - 1]);
            }
            if (!entries.length) return { ok: false, why: '没有任何用户写出 Memory.stats' };
            const perRoom = entries.filter((e) => e && e.rooms && typeof e.rooms === 'object' && Object.keys(e.rooms).length);
            if (!perRoom.length) {
                return { ok: false, why: `stats 里没有按房的记录（旧版是顶层 rcl/prog）：${JSON.stringify(entries.slice(0, 2))}` };
            }
            const shaped = perRoom.filter((e) => Object.values(e.rooms).every((v) => Array.isArray(v) && v.length === 3));
            if (!shaped.length) return { ok: false, why: `按房记录的形状不对：${JSON.stringify(perRoom[0].rooms)}` };
            const profiled = perRoom.filter((e) => e.cpuBy && typeof e.cpuBy === 'object' && Object.keys(e.cpuBy).length);
            if (!profiled.length) return { ok: false, why: 'stats 里没有 cpuBy：按模块计时没跑' };
            // 房级计时必须真的记到数：第一版用 cpuLap 记房，被模块级打点推进的 cpuMark 吃光，线上 cpuRooms 全空
            const withRooms = profiled.filter((e) => e.cpuRooms && Object.keys(e.cpuRooms).length);
            return withRooms.length
                ? { ok: true }
                : { ok: false, why: `cpuRooms 是空的（房级计时被模块级打点吃掉）：${JSON.stringify(profiled.map((e) => e.cpuRooms))}` };
        },
    },
    {
        id: 'core.parsedMemoryReuse',
        since: '2026-09-07',
        change: '连续 tick 复用已解析 Memory，跳过 JSON.parse：引擎每 tick 把 Memory 装成 getter，首次访问才 parse 进 RawMemory._parsed；我们在 isolate 还在、时间连续时删掉 getter 把上一 tick 的对象塞回去。线上实测约 364 KB / 2.755 CPU/tick。旧代码没有 Memory.memReuse',
        check(report) {
            const hits = Object.keys(report.rootMemories || {})
                .map((key) => report.rootMemories[key] && report.rootMemories[key].memReuse)
                .filter((row) => row && typeof row.n === 'number');
            if (!hits.length) return { ok: false, why: '没有任何用户的 Memory.memReuse（复用没跑）' };
            const best = hits.reduce((a, b) => (b.n > a.n ? b : a));
            return best.n > 10
                ? { ok: true }
                : { ok: false, why: `复用次数太少（${best.n}），isolate 可能每 tick 重建：${JSON.stringify(best)}` };
        },
    },
    {
        id: 'combat.actionPipelineGuard',
        since: '2026-09-07',
        change: '动作管线守卫（src/actions.js，引擎 processor/intents/creeps/intents.js 的表）：siegeGuard 开火的那一 tick 不再发 rangedHeal（引擎会把整发 rangedAttack 丢掉），近战 defender 出手的 tick 不自疗（heal 会顶掉 attack）',
        check(report, ROOMS) {
            const probes = [ROOMS.defenseHome, ROOMS.logistics, ROOMS.links, ROOMS.bootstrap]
                .map((name) => roomProbe(report, name))
                .filter((probe) => probe && probe.actionGuard);
            if (!probes.length) return { ok: false, why: '没有任何场景房拿到 actionGuard（旧代码没有 actions 模块）' };
            const bad = probes.filter((probe) => typeof probe.actionGuard !== 'object' ||
                !probe.actionGuard.attackBlockedByHeal || !probe.actionGuard.rangedBlockedByRangedHeal);
            if (bad.length) {
                return { ok: false, why: `引擎表没对上：${JSON.stringify(bad.map((p) => p.actionGuard))}` };
            }
            // 攻占场景（VALIDATE_CONQUEST）播种时才有护卫真的开火：那时必须观察到主动放弃的 rangedHeal。
            // skipped 是**每个 bot 自己的**全局累计（actions.js runtime），由该 bot 的探针采集——放弃 rangedHeal 的是**我方**护卫，
            // 所以要读攻击方母房（conquestHome）的探针，不是目标房（敌方）的（敌方没护卫，恒为 0——这是旧断言读错探针的既有 bug）。
            if (!report.conquestStructures) return { ok: true };
            const guardProbe = roomProbe(report, ROOMS.conquestHome);
            const skipped = guardProbe && guardProbe.actionGuard && guardProbe.actionGuard.skipped;
            return skipped && skipped.rangedHeal > 0
                ? { ok: true }
                : { ok: false, why: `攻占场景里我方护卫一次都没有为了保住 rangedAttack 而放弃 rangedHeal（读攻击方 ${ROOMS.conquestHome} 探针）：${JSON.stringify(skipped)}` };
        },
    },
    {
        id: 'minerals.externalDelivery',
        since: '2026-09-09',
        // 2026-10-08 查明：过去在默认 --effect-ticks 400 下确定性失败，原因不是 tick 数而是夹具——industry 房没有 extension，
        // 大脑按容量 300 给出 1W2C2M 的矿工，装满 100 格要约 600 tick，第一次投递落在验证窗口之外。
        // seedIndustry 现在播 2 个满能量 extension（容量 700）。2026-10-14 更正：4W2C3M（装满约 150 tick）只在矿脉 < 26 格时给出，
        // ≥ 26 格大脑给 3W4C4M、装满 200 格约 400 tick；加上首轮大脑在预留窗口之后（t≈211）、零 creep 的房要先自举核心编制，
        // 钻机 t751 才排上孵化（validation-mZRVaL）。现在 run_validation 在恢复模拟前跑首轮 industry 大脑、seedIndustry 播满寿命的核心编制，
        // 第一次投递约在 t520–560。断言仍要求真实投递（delivered > 0），不预装矿物。
        change: 'External mineral directive through HTTP and segment 90, actual cargo delivered to storage',
        check(report, ROOMS) {
            const root = report.rootMemories && report.rootMemories[ROOMS.industry];
            const plan = root && root.brain && root.brain.rooms[ROOMS.industry].mineral;
            const stats = root && root.rooms[ROOMS.industry].mineralStats;
            return plan && plan.enabled && plan.outbound && stats && stats.harvested > 0 && stats.delivered > 0
                ? { ok: true } : { ok: false, why: JSON.stringify({ plan: plan && plan.reason, body: plan && plan.body, returnTicks: plan && plan.returnTicks,
                    stats, ...mineralSpawnTiming(report, ROOMS) }) };
        },
    },
    {
        id: 'minerals.extractorDrone',
        since: '2026-09-07',
        change: '矿物钻机（roles/mineralMiner.js）：RCL6 起自运挖矿脉、送进 terminal。过去我们建 extractor、建矿物容器，然后没有任何代码对 FIND_MINERALS 调过 harvest——矿物是 labs 反应 / boost / 唯一可售商品的入口',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.industry);
            if (!probe) return { ok: false, why: `没拿到 ${ROOMS.industry} 的探针` };
            const mined = probe.mined;
            if (!mined || typeof mined !== 'object') return { ok: false, why: '探针里没有 mined 字段（旧代码没有这条链）' };
            if (!mined.drones) return { ok: false, why: `RCL8 + extractor + terminal 的房里一只钻机都没孵出来：${JSON.stringify({ mined, ...mineralSpawnTiming(report, ROOMS) })}` };
            const got = (mined.terminal || 0) + (mined.storage || 0) + (mined.carried || 0);
            return got > 0
                ? { ok: true }
                : { ok: false, why: `钻机在岗但一个单位的矿物都没挖到：${JSON.stringify({ mined, ...mineralSpawnTiming(report, ROOMS) })}` };
        },
    },
    {
        id: 'layout.labTriple',
        since: '2026-09-07',
        change: 'plan.labs 排序成可反应的三连（layout.normalizeLabPlan）：runReaction 要求两个输入 lab 都在输出 lab 的切比雪夫 2 以内，而 RCL6 只有 3 个 lab 名额；轮子给的顺序是任意的，我们自己的三个方案固定件里有两个的前三个 lab 根本凑不出一组反应',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.industry];
            const plan = memory && memory.rooms && memory.rooms[ROOMS.industry] && memory.rooms[ROOMS.industry].plan;
            const labs = plan && plan.labs;
            if (!Array.isArray(labs) || labs.length < 4) {
                return { ok: false, why: `${ROOMS.industry} 的方案里 lab 少于 4 个，观察不到排序：${JSON.stringify(labs)}` };
            }
            const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
            const head = labs.slice(0, 3);
            const ok = head.some((out, i) => head.every((other, k) => k === i || cheb(out, other) <= 2));
            return ok
                ? { ok: true }
                : { ok: false, why: `前三个 lab 仍然凑不出反应三连（夹具刻意把远处的孤立 lab 放在最前）：${JSON.stringify(head)}` };
        },
    },
    {
        id: 'conquest.stageAndTerminalState',
        since: '2026-09-07',
        change: '攻城两处「白扔 creep」的护栏：集结点等待有 stageWait 上限（波次出发后到达的替补过去会等到寿终），以及占领成功后指令进终态 completed（过去房子一旦易手就自动从 done 翻回 breach、无人下令地重启整波）',
        check(report, ROOMS) {
            // 攻占场景由 VALIDATE_CONQUEST 门控，默认不播种
            if (!report.conquestStructures) return { ok: true };
            const memories = creepsOf(report, ROOMS.conquestHome);
            const siege = memories.filter((m) => m && (m.role === 'siegeDismantler' || m.role === 'siegeGuard'));
            if (!siege.length) return { ok: false, why: '攻占场景里没有攻城 creep 的记忆' };
            if (!siege.some((m) => typeof m.stagedAt === 'number')) {
                return { ok: false, why: `没有任何攻城 creep 记下 stagedAt（旧代码不写这个字段）：${JSON.stringify(siege.slice(0, 3))}` };
            }
            const memory = report.rootMemories && report.rootMemories[ROOMS.conquestHome];
            const raw = memory && memory.conquest;
            const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            const bad = list.filter((d) => d && d.phase === 'done' && d.completed !== true);
            return bad.length
                ? { ok: false, why: `已完成的指令没有进终态：${JSON.stringify(bad)}` }
                : { ok: true };
        },
    },
    {
        id: 'conquest.suppressDeny',
        since: '2026-09-08',
        change: 'conquest.suppress：无主/预定房走 deny（持续 attackController + 可选护卫清工人），不 claim、不 completed；指令可覆盖 storageFloor',
        check(report, ROOMS) {
            const memories = report.rootMemories || {};
            let saw = null;
            for (const memory of Object.values(memories)) {
                const raw = memory && memory.conquest;
                const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
                const hit = list.find((d) => d && d.suppress && !d.completed);
                if (hit) { saw = { dir: hit, creeps: Object.values((memory && memory.creeps) || {}) }; break; }
            }
            if (!saw) return { ok: true }; // 没下 suppress 指令的世界（默认验证）跳过
            if (saw.dir.phase && saw.dir.phase !== 'deny' && saw.dir.phase !== 'downgrade' && saw.dir.phase !== 'breach') {
                return { ok: false, why: `suppress 指令阶段不是 deny/downgrade/breach：${JSON.stringify(saw.dir)}` };
            }
            const dg = saw.creeps.filter((c) => c && c.role === 'downgrader' && c.suppress);
            const queued = saw.dir.phase === 'deny' || saw.dir.phase === 'downgrade';
            if (!dg.length && !queued) {
                return { ok: false, why: `有 suppress 指令但没有 suppress downgrader、阶段也不是 deny/downgrade：${JSON.stringify(saw.dir)}` };
            }
            return { ok: true };
        },
    },
    {
        id: 'demolition.keepsLoadedStore',
        since: '2026-09-07',
        change: '拆迁两处护栏：storage/terminal 里还有资源就不拆（过去它们没有任何特判，直接落进 cappedReplaceable——RCL3 的 allow.storage 是 0，一个方案外的 storage 立刻满足"超配额"条件，连里面的能量一起没了）；己方房里敌方遗留的 rampart/wall 盖在规划位上则要拆（引擎只让 rampart 的主人踩上去，那一格对我们是永久障碍，而 destroy 只要求房间控制器是我们的）',
        check(report, ROOMS) {
            const probe = roomProbe(report, ROOMS.conflict);
            if (!probe) return { ok: false, why: `没拿到 ${ROOMS.conflict} 的探针` };
            if (!Array.isArray(probe.stores)) return { ok: false, why: '探针里没有 stores 字段（旧代码没有这条观察面）' };
            return report.protectedStore && report.protectedStore.resources > 0
                ? { ok: true }
                : { ok: false, why: `原有且仍装着资源的 storage 没保住：${JSON.stringify(report.protectedStore)}` };
        },
    },
    {
        id: 'demolition.hostileQuota',
        since: '2026-10-01',
        change: '占下的房里别人遗留的结构占满本房配额时拆掉（引擎 checkControllerAvailability 计数不分主人），不受恢复期/能量门控；没有我们 spawn 的房先放 spawn 工地、死房也放（线上 W37S7：Lucas21 的废 spawn 占住 RCL4 唯一的 spawn 名额，房间 RCL4 停滞、只靠外援 pioneer 维持）',
        check(report, ROOMS) {
            const list = report.foreignQuota;
            if (!Array.isArray(list)) return { ok: false, why: `报告里没有 foreignQuota（旧 run_validation）：${JSON.stringify(list)}` };
            const mem = report.rootMemories && report.rootMemories[ROOMS.conflict];
            const roomMem = mem && mem.rooms && mem.rooms[ROOMS.foreignSpawn];
            const foreignLeft = list.filter((o) => o.type === 'spawn' && o.user === '2');
            if (foreignLeft.length) return { ok: false, why: `${ROOMS.foreignSpawn} 里别人的 spawn 还在：${JSON.stringify(foreignLeft)}` };
            const logged = ((roomMem && roomMem.demolition) || []).some((e) => e && e.reason === 'hostile-quota' && e.type === 'spawn');
            if (!logged) return { ok: false, why: `demolition 日志里没有 hostile-quota 的 spawn 拆除：${JSON.stringify(roomMem && roomMem.demolition)}` };
            const ours = list.filter((o) => o.user !== '2');
            if (!ours.length) return { ok: false, why: `敌方 spawn 拆掉后没有出现我们的 spawn 工地/建筑：${JSON.stringify(list)}` };
            return { ok: true };
        },
    },
    {
        id: 'layout.blockedOnlyRealConflicts',
        since: '2026-09-07',
        change: 'layoutBlocked 只记真冲突：放置循环会把 plan.ext 整个走一遍，而 structuresCanShare(同类型) 返回 false，于是每个已建成的 extension 都被记成「方案位被旧建筑占住」（线上 W34S7 每轮 20 条自指误报）',
        check(report) {
            const selfRef = [];
            let sawAny = false;
            for (const key of Object.keys(report.rootMemories || {})) {
                const rooms = report.rootMemories[key] && report.rootMemories[key].rooms;
                for (const name of Object.keys(rooms || {})) {
                    const blocked = rooms[name] && rooms[name].layoutBlocked;
                    if (!Array.isArray(blocked)) continue;
                    sawAny = true;
                    for (const entry of blocked) if (entry && entry.type === entry.by) selfRef.push([name, entry]);
                }
            }
            if (selfRef.length) {
                return { ok: false, why: `layoutBlocked 里还有自指条目（已建成却被记成被占住）：${JSON.stringify(selfRef.slice(0, 3))}` };
            }
            // 没有任何房写过 layoutBlocked 也算通过：说明这一轮就是没有冲突（旧代码在有建成 extension 的房里必然会写）
            return { ok: true, why: sawAny ? undefined : undefined };
        },
    },
    {
        id: 'spawn.busyDemandSkip',
        since: '2026-09-07',
        change: 'spawn 全忙时按房错峰降频跑编制推导（只服务于遥测：mem.demand 除监控与探针外没有消费方）。上线后的按模块 CPU 实测 spawn 单项 30.4 CPU/tick（10 个房 × 每 tick 全套推导），这是其中的主体',
        check(report) {
            const skipped = [];
            for (const key of Object.keys(report.rootMemories || {})) {
                const rooms = report.rootMemories[key] && report.rootMemories[key].rooms;
                for (const name of Object.keys(rooms || {})) {
                    const demand = rooms[name] && rooms[name].demand;
                    if (demand && demand.skipped > 0) skipped.push([name, demand.skipped]);
                }
            }
            return skipped.length
                ? { ok: true }
                : { ok: false, why: '没有任何房记录过 demand.skipped（旧代码没有这个字段，也从不跳过）' };
        },
    },
    {
        id: 'remote.staticScanCache',
        since: '2026-09-07',
        change: '外矿每 tick 的静态扫描减半：keeper lair 是永不变的地物，看到一次就记在 record.lairs 上（过去每个可见外矿每 tick 都为它做一次全量 FIND_STRUCTURES）；房间出口 describeExits 永久缓存在 global（withinDistance/isAdjacent 会在每个母房的每个外矿上再问一次）',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
            const remotes = memory && memory.rooms && memory.rooms[ROOMS.remoteHome] && memory.rooms[ROOMS.remoteHome].remotes;
            if (!remotes || !Object.keys(remotes).length) return { ok: false, why: `${ROOMS.remoteHome} 没有外矿记录` };
            const seen = Object.values(remotes).filter((record) => record && typeof record.lairs === 'number');
            return seen.length
                ? { ok: true }
                : { ok: false, why: `没有任何外矿记下 lairs（旧代码每 tick 现扫，不记）：${JSON.stringify(Object.keys(remotes))}` };
        },
    },
    {
        id: 'upgrade.linkSupplySignal',
        since: '2026-09-07',
        change: '控制器由 link 供能的房，升级者供给 EMA 取 ctrl link 而不是那个没人用的容器：升级者直接从 link 取能，容器恒空，旧写法 ratio = max(容器/2000, storage/30000)，线上 W33S7 因此卡在 0.41、raiseAbove 0.7 算术上不可达，RCL5 母房常年只有 1 只 16 WORK 的升级者（CP 已是它物理上限的 96%，而 spawn 收入 EMA 是 56/tick）。行为回归在 test/smoke.js（link 有货 ⇒ 越过 raiseAbove 并加员；link 长期空 ⇒ 跌回去）',
        check(report, ROOMS) {
            // links 场景（E20S20）是 ctrl link 供能的房：驱动 EMA 的信号必须是 link，旧代码连 src 这个字段都没有
            const probe = roomProbe(report, ROOMS.links);
            if (!probe) return { ok: false, why: `没拿到 ${ROOMS.links} 的探针` };
            const supply = probe.upgradeSupply;
            if (!supply || typeof supply.ema !== 'number') {
                return { ok: false, why: `没有 upgradeSupply（得 ${JSON.stringify(supply)}）` };
            }
            if (!supply.src) {
                return { ok: false, why: `供给采样没有记来源（旧代码没有 supply.src）：${JSON.stringify(supply)}` };
            }
            if (typeof probe.ctrlLink !== 'number') {
                return { ok: false, why: `探针没读到 ctrl link（得 ${JSON.stringify(probe.ctrlLink)}）` };
            }
            // link 有货的那一刻，来源必须是 link（而不是那个没人用的容器）；link 空时退回 storage/容器是正常的
            return probe.ctrlLink > 0 ? (supply.src === 'link'
                ? { ok: true }
                : { ok: false, why: `ctrl link 有 ${probe.ctrlLink} 能量，驱动 EMA 的却是 ${supply.src}` })
                : { ok: !!supply.src, why: `ctrl link 当前为空，只校验采样有记来源（${supply.src}）` };
        },
    },
    {
        id: 'industry.labReactionDerived',
        since: '2026-09-07',
        change: 'lab 分工按几何推导（industry.deriveReaction）：两个装着不同矿物、且都在第三个 lab 切比雪夫 2 以内的输入 + 一个能收产物的输出，REACTIONS 里查得到产物就开工。过去 runLabs 要求人手把三个 lab 的 id 填进 Memory.industry.reaction —— labs 建好了也永远不反应',
        check(report, ROOMS) {
            const memory = report.rootMemories && report.rootMemories[ROOMS.industry];
            const state = memory && memory.rooms && memory.rooms[ROOMS.industry] && memory.rooms[ROOMS.industry].industryState;
            const labs = state && state.labs;
            if (!labs) return { ok: false, why: '没有 industryState.labs' };
            if (!labs.derived) {
                return { ok: false, why: `没有推导出 lab 分工（夹具播了 H/O 两个输入 + 一个 2 格内的输出）：${JSON.stringify(labs)}` };
            }
            return labs.derived.product === 'OH'
                ? { ok: true }
                : { ok: false, why: `推导出的产物不是 OH：${JSON.stringify(labs.derived)}` };
        },
    },
    {
        id: 'conquest.breach',
        since: '2026-09-06',
        change: 'conquest 破防（损失预言机 / 战斗改动验证门）：攻击方 siege 从中立集结点突入、拆光敌方目标房的塔+spawn；A1 blocking:false + A2 storageFloor 下攻击方经济不崩',
        check(report, ROOMS) {
            // 攻占场景由 VALIDATE_CONQUEST env 开关门控（默认关，普通 run_validation 不播种、不影响部署门）；未播种就跳过
            if (!report.conquestStructures) return { ok: true };
            const s = report.conquestStructures;
            if (!(s.towers === 0 && s.spawns === 0)) {
                return { ok: false, why: `敌方目标房 ${ROOMS.conquestTarget} 仍有 ${s.towers} 塔 / ${s.spawns} spawn（破防未完成——兵力/tick 预算不足，或战斗代码回归）` };
            }
            // A1/A2：攻城需求不应冻结攻击方经济——静态矿工应存活（经济链未崩）
            const harvesters = creepsOf(report, ROOMS.conquestHome).filter((m) => m.role === 'harvester').length;
            return harvesters >= 2
                ? { ok: true }
                : { ok: false, why: `攻击方经济崩了：harvester ${harvesters} < 2（A1 blocking:false / A2 storageFloor 应保住经济）` };
        },
    },
    {
        id: 'conquest.transitTowerAvoid',
        since: '2026-09-12',
        change: '过境避塔：攻城 siege 冲锋经过带敌塔的过境房（非目标房）时，towerAvoidCallback 给塔周围格子加寻路成本，队伍贴远缘绕过、不再一字长蛇被塔逐个打；recordHostileTowers 把过境时到塔的最近距离记进 Memory.siegeTransit',
        check(report, ROOMS) {
            if (!report.conquestStructures || !ROOMS.conquestTransit) return { ok: true };   // 未播种（无 VALIDATE_CONQUEST / 无过境房）跳过
            const d = report.conquestStructures.transitMinDist;
            if (d == null) {
                return { ok: false, why: `过境避塔遥测缺失：Memory.siegeTransit[${ROOMS.conquestTransit}] 未记录（siege 未过境该房，或 recordHostileTowers 未接线）` };
            }
            return d > 5
                ? { ok: true }
                : { ok: false, why: `过境时贴到了过境塔：到 (25,25) 最近距离 ${d} ≤ 5（进了塔最佳射程 5，towerAvoidCallback 未生效）` };
        },
    },
    {
        id: 'keeperAvoid.transit',
        since: '2026-09-12',
        change: 'SK 环外占领：claimer/pioneer 穿中立 SK 房时，movement.keeperAvoidCallback 给 keeper lair 周围格子加寻路成本、贴远缘绕开杀伤圈（大脑 plan.passable/travel_ticks 用 allow_keeper 同步放开 SK 走廊、A* 绕 lair 估路，让 W37S5/W38S7 这类 SK 环外房可被点名占领）；noteKeeperTransit 把过境时到 lair 的最近距离记进 Memory.keeperTransit',
        check(report, ROOMS) {
            if (!report.keeperTransit || !ROOMS.keeperRoom) return { ok: true };   // 未播种（无 VALIDATE_KEEPER）跳过
            const d = report.keeperTransit.minDist;
            if (d == null) {
                return { ok: false, why: `keeper 过境遥测缺失：Memory.keeperTransit[${ROOMS.keeperRoom}] 未记录（claimer 没进过 keeperRoom，或 noteKeeperTransit 未接线）` };
            }
            return d >= 5
                ? { ok: true }
                : { ok: false, why: `claimer 穿 keeperRoom 时贴到了 lair：到 (25,25) 最近距离 ${d} < 5（进了 keeper 杀伤圈，keeperAvoidCallback 未生效）` };
        },
    },
];

EFFECTS.push({
    id: 'hauling.storageConsumerFallback', since: '2026-09-09',
    change: 'Non-Link hauler consumes storage surplus only after other sources are unavailable, delivers to controller and preserves reserve.',
    check(report, ROOMS) {
        const memory = report.rootMemories[ROOMS.storageConsumer];
        const room = memory && memory.rooms && memory.rooms[ROOMS.storageConsumer];
        const hauler = memory && memory.creeps && memory.creeps['storage-consumer-hauler'];
        const probe = roomProbe(report, ROOMS.storageConsumer);
        const progressed = Number(report.storageConsumerProgress) > 0;
        const ok = room && room.storageConsumerFallback >= 50 && hauler && !hauler.hubCargo && progressed && probe.storage >= 2000;
        return { ok: !!ok, why: ok ? null : JSON.stringify({ record: room && room.storageConsumerFallback, hauler, probe }) };
    },
});

EFFECTS.push({
    id: 'hauling.ctrlContainerBesideSource', since: '2026-10-14',
    change: 'hauler.srcIsPlanned：方案的控制器容器即使贴着源也是消费者（validation-52vHk6 W41N40：随机地形把源放在控制器容器旁 1 格，旧的"源旁 1 格"兜底把它认成源容器——consumerTasks/deliverFilter 滤掉、storage 兜底预算 0，hauler 749 tick 全在 park、升级 0）；broker 的溢出判定也先认方案的 srcN 容器',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageConsumer];
        if (!memory) return { ok: false, why: '没有 storageConsumer 用户的 Memory（场景没播种？）' };
        const geom = memory._validationCtrlBesideSource;
        // 前提：夹具确实把源挪到了控制器容器旁（几何没摆出来就不是在测这条改动）
        const d = geom && geom.ctrl && geom.source ? Math.max(Math.abs(geom.ctrl.x - geom.source.x), Math.abs(geom.ctrl.y - geom.source.y)) : null;
        if (d == null || d > 1) return { ok: false, why: '夹具没把源摆到控制器容器旁: ' + JSON.stringify(geom || null) };
        const room = (memory.rooms || {})[ROOMS.storageConsumer] || {};
        const fallback = Number(room.storageConsumerFallback) || 0;
        const progress = Number(report.storageConsumerProgress) || 0;
        const probe = roomProbe(report, ROOMS.storageConsumer);
        // 旧行为：storageConsumerFallback 从没写过、控制器进度 0（hauler 一直 park）
        if (!(fallback >= 50) || !(progress > 0)) return { ok: false, why: '控制器容器贴着源时 storage 兜底没喂它: ' + JSON.stringify({ fallback, progress, geom }) };
        return probe && probe.storage >= 2000
            ? { ok: true, detail: { fallback, progress, geom } }
            : { ok: false, why: 'storage 被取到底线以下: ' + JSON.stringify(probe && probe.storage) };
    },
});

EFFECTS.push({
    id: 'remote.roadBudgetDelivery', since: '2026-09-09',
    change: 'A remote hauler spends at most 50 energy per road-building trip and then completes a real delivery before resetting its allowance.',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.reserveHome];
        const home = memory && memory.rooms && memory.rooms[ROOMS.reserveHome];
        const record = home && home.remoteRoadBudget;
        // 2026-09-12 起路工地边修边走（remoteHauler.buildMove）：走出工地射程后就不修了，一趟不一定花满 50——
        // 断言守的是"每趟不超过 50、且修过路的那趟真的卸了货才重置"，不再要求恰好花满（原来 maxTripSpent === 50 是站桩修路的结果）
        const ok = record && record.spent > 0 && record.maxTripSpent > 0 && record.maxTripSpent <= 50 &&
            record.deliveredTrips > 0 && record.delivered > 0;
        return { ok: !!ok, why: ok ? null : 'No completed budgeted road trip: ' + JSON.stringify(record) };
    },
});

EFFECTS.push({
    id: 'links.controllerConsumerReserve', since: '2026-09-09',
    change: '无source/store link、无spawn的RCL5孤立场景，只有2600 storage可供能：hauler保留2000储备并喂controller link，必须产生实际CP',
    check(report, ROOMS) {
        const memory = report.rootMemories[ROOMS.controllerLinkConsumer];
        const room = memory && memory.rooms && memory.rooms[ROOMS.controllerLinkConsumer];
        const probe = roomProbe(report, ROOMS.controllerLinkConsumer);
        const ok = room && room.storageConsumerFallback >= 50 && probe && probe.storage >= 2000 &&
            probe.storage < 2600 && probe.links === 1 && Number(report.controllerLinkConsumerProgress) >= 50;
        return { ok: !!ok, why: ok ? null : JSON.stringify({fallback: room && room.storageConsumerFallback, probe, cp: report.controllerLinkConsumerProgress}) };
    },
});

EFFECTS.push({
    id: 'maintenance.builderRescuesCriticalRoad', since: '2026-09-09',
    change: '空 storage 的房里 builder 从 spawn/ext 余量取能（旧代码把空 storage 当可取来源，每 tick withdraw 失败就 return）并先修"会消失的"危急道路再建造',
    check(report, ROOMS) {
        const mt = report.maintenance;
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const seed = memory && memory.rooms && memory.rooms[ROOMS.maintenance] && memory.rooms[ROOMS.maintenance].maintenanceSeed;
        if (!mt || !Array.isArray(mt.roads) || !seed || !seed.farRoad || !seed.tower) {
            return { ok: false, why: 'maintenance 报告或播种位置缺失: ' + JSON.stringify({ mt: !!mt, seed }) };
        }
        // 播种时塔射程（20 格）之外的危急路（60 血）：只有 builder 能修它
        const distance = Math.max(Math.abs(seed.farRoad.x - seed.tower.x), Math.abs(seed.farRoad.y - seed.tower.y));
        const far = mt.roads.find(([x, y]) => x === seed.farRoad.x && y === seed.farRoad.y);
        const roadSites = (mt.sites || []).filter(([type]) => type === 'road').map(([, progress, total]) => [progress, total]);
        const ok = distance > 20 && !!far && far[2] > 200;
        return { ok, why: ok ? null : '播种在塔射程外的危急路（60 血）没有被修：' + JSON.stringify({ distance, far, seed, roadSites }) };
    },
});

EFFECTS.push({
    id: 'maintenance.towerCriticalBudget', since: '2026-09-09',
    change: '射程内有会消失的危急结构时，塔的维修补能提到第 1 层（旧代码塔停在储备线上，tower.js 一次也修不动）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.maintenance];
        const record = room && room.towerCritical;
        const seed = room && room.maintenanceSeed;
        const tower = ((report.maintenance || {}).towers || [])[0];
        const expected = seed && seed.tower ? seed.tower : (tower ? { x: tower[0], y: tower[1] } : null);
        const ok = !!(record && expected && record.x === expected.x && record.y === expected.y);
        return { ok, why: ok ? null : '未观察到塔的危急补能升层: ' + JSON.stringify({ record, expected, tower }) };
    },
});

EFFECTS.push({
    id: 'maintenance.repairPoolNeutral', since: '2026-09-09',
    change: 'broker 的维修任务池覆盖中立建筑（道路/容器）：旧写法用 FIND_MY_STRUCTURES，池里一条路都没有',
    check(report, ROOMS) {
        // 池子里要出现中立建筑（road/container——两者都不在 FIND_MY_STRUCTURES 里，正是旧写法漏掉的那一类）。
        // 具体看到哪一个取决于这一轮谁先被修好：builder 一次维修 500 血、塔 800 血，路很快修满就离开池子，
        // 射程内那个 25 万血的容器则长期留在池里（中途采样实测 backlog 179800）
        // 主判据是逐 tick 闩锁（fixtures.repairPoolNeutralObserver → Memory._repairPoolNeutral）：中途单次快照会错过窗口——
        // 容器修到 60%（towerRepairBelow）就离池，塔被早早补过储备线时快照前就修完了（validation-u84Rjo）。快照仍作旁证
        const root = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const latch = root && root._repairPoolNeutral;
        if (latch && (latch.type === 'road' || latch.type === 'container') && latch.t > 0) return { ok: true, detail: latch };
        const early = report.maintenanceEarly && report.maintenanceEarly.repair;
        const lateRoom = roomProbe(report, ROOMS.maintenance);
        const late = lateRoom && lateRoom.repair;
        const hasNeutral = (list) => Array.isArray(list) && list.some((entry) => entry[0] === 'road' || entry[0] === 'container');
        const ok = hasNeutral(early) || hasNeutral(late);
        return { ok, why: ok ? null : '维修任务池里没有中立建筑（道路/容器）: ' + JSON.stringify({ latch, latchError: root && root._repairPoolNeutralError, early, late }) };
    },
});

EFFECTS.push({
    id: 'maintenance.roadSiteYield', since: '2026-09-09',
    change: '工地名额满且方案里有缺失道路时，零进度的 rampart 工地让位给道路工地（旧代码消失的路永远补不回来）',
    check(report, ROOMS) {
        // 房间里只播了 2 条路（其余 4 格是"方案里有、房间没有"的）。多出来的路只可能来自"名额满时让位放出的路工地"
        // ——名额一直是 40/40，rampart 工地（1 点进度）在 builder 的优先级里排最后、不会自己建完腾名额。
        // 结束时的工地组成不固定（路建完后名额又被外环 rampart 填回），所以断言建成的路数而不是工地快照。
        // 房间播种时 40/40 名额（36 constructedWall + terminal + 3 lab），其中 4 格方案内的路没有结构也没有工地。
        // 只有让位（零进度 wall 工地被清）才能给它们放出名额——所以"这 4 格路最后有结构"就是让位的直接证据。
        const mt = report.maintenance || {};
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const seed = memory && memory.rooms && memory.rooms[ROOMS.maintenance] && memory.rooms[ROOMS.maintenance].maintenanceSeed;
        const missing = (seed && seed.missingRoads) || [];
        if (!missing.length) return { ok: false, why: '播种记录里没有 missingRoads: ' + JSON.stringify(seed) };
        const roads = mt.roads || [];
        const built = missing.filter((pos) => roads.some(([x, y]) => x === pos.x && y === pos.y));
        const sites = mt.sites || [];
        const roadSites = sites.filter(([type]) => type === 'road');
        const pending = missing.filter((pos) => roadSites.some(([, , , x, y]) => x === pos.x && y === pos.y));
        const ok = built.length + pending.length >= missing.length;
        return { ok, why: ok ? null : '方案内缺失的路没有全部放出来/建成: ' + JSON.stringify({ missing, built: built.length, pending: pending.length }) };
    },
});

EFFECTS.push({
    id: 'spawn.criticalBuilderVital', since: '2026-09-09',
    change: '没有 builder 且房里有会消失的危急结构时，第一只 builder 提到生存档（旧代码是发展档，永远排在外矿维护后面）',
    check(report, ROOMS) {
        // storageFed 场景正好是这个形态：两个源容器之一播在 12000/250000（4.8% < criticalRepairShare）、房里没有 builder
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const room = memory && memory.rooms && memory.rooms[ROOMS.storageFed];
        const record = room && room.criticalBuilder;
        const ok = !!(record && record.n > 0);
        return { ok, why: ok ? null : '未观察到危急结构的 vital builder 决策: ' + JSON.stringify(record) };
    },
});

EFFECTS.push({
    id: 'remote.incomeBudgetedStaffing', since: '2026-09-09',
    change: '外矿编制按本房收入预算：每条外矿的摊销成本（矿工 + reserver + 各槽位 hauler 的造价/寿命）按 价值−成本 排序累加，累计超过 收入×upkeepShare 的不在编（旧代码无条件补满整套编制，队列队头永远是买不起的 2250 运输工并挡住发展档，线上 W33S7 因此卡死）',
    check(report, ROOMS) {
        // 预算决策的完整不变量（每个房都要成立）：budget = 收入 × upkeepShare(0.5)；摊销成本超过 budget × upkeepSlack(1.3)
        // 的外矿必须被丢出编制；在编外矿的累计摊销 ≤ budget × 1.3。落选/在编的具体清单随各房收入变化，
        // 所以这里断言"决策规则"而不是某个房的具体结果（具体档位在 test/smoke.js 里用固定收入确定性地断言）。
        const memories = report.rootMemories || {};
        let evaluated = 0;
        let staffedTotal = 0;
        let droppedTotal = 0;
        for (const [roomName, memory] of Object.entries(memories)) {
            const room = memory && memory.rooms && memory.rooms[roomName];
            const staff = room && room.remoteStaff;
            if (!staff) continue;
            // 收入样本不足时不做预算（budget/income 为 null）：那时编制全在，不算"评估过"
            if (staff.income == null || staff.budget == null) {
                if (!Array.isArray(staff.staffed) || staff.staffed.length !== Object.keys(staff.cost || {}).length) {
                    return { ok: false, why: `${roomName} 收入未知时应当不裁编制（全部在编），得 ${JSON.stringify(staff)}` };
                }
                evaluated += Object.keys(staff.cost || {}).length;
                staffedTotal += staff.staffed.length;
                continue;
            }
            const budget = Number(staff.budget);
            const income = Number(staff.income);
            const cost = staff.cost || {};
            if (!Number.isFinite(budget) || !Number.isFinite(income) || budget < 0) {
                return { ok: false, why: `${roomName} 的 remoteStaff 预算/收入不是数字: ${JSON.stringify(staff)}` };
            }
            // 遥测里 income/budget 都四舍五入到 0.1，两者的舍入误差合计可达 0.11
            if (Math.abs(budget - income * 0.5) > 0.11) {
                return { ok: false, why: `${roomName} 的预算不是 收入×0.5（${income} × 0.5，得 ${budget}）: ${JSON.stringify(staff)}` };
            }
            // 2026-09-11 起运回本房、产出 > 摊销的外矿自负盈亏（staff.selfFunded），不受预算约束：不变量只对其余外矿成立，
            // 累计摊销的上限也要加上自负盈亏那部分（它们的摊销照样计入 used）
            const selfFunded = new Set(staff.selfFunded || []);
            let selfFundedUsed = 0;
            for (const [remote, upkeep] of Object.entries(cost)) {
                evaluated++;
                if (selfFunded.has(remote)) {
                    if (staff.staffed.includes(remote)) selfFundedUsed += Number(upkeep) || 0;
                    continue;
                }
                const limit = budget * 1.3 + 1e-9;
                if (Number(upkeep) > limit && !staff.dropped.includes(remote)) {
                    return { ok: false, why: `${roomName} 摊销 ${upkeep}/tick > 预算上限 ${Math.round(limit * 100) / 100}/tick 的 ${remote} 没有丢出编制: ${JSON.stringify(staff)}` };
                }
            }
            if (Number(staff.used) > budget * 1.3 + selfFundedUsed + 0.05) {
                return { ok: false, why: `${roomName} 在编外矿的累计摊销 ${staff.used}/tick 超过预算上限 ${budget}×1.3 + 自负盈亏 ${Math.round(selfFundedUsed * 100) / 100}: ${JSON.stringify(staff)}` };
            }
            staffedTotal += staff.staffed.length;
            droppedTotal += staff.dropped.length;
        }
        if (!evaluated) return { ok: false, why: '没有任何房评估过外矿编制（remoteStaff.cost 全空，预算逻辑没跑）' };
        if (!staffedTotal) return { ok: false, why: '没有任何外矿在编（收入估计或预算算错）' };
        return { ok: true, detail: { evaluated, staffedTotal, droppedTotal } };
    },
});

EFFECTS.push({
    id: 'remote.minerNoGroundOverflow', since: '2026-09-09',
    change: 'remoteMiner 满仓 + 源容器满时停手（引擎的 harvest intent 会把仓溢出的采集直接丢到地上，落地能量每 tick 衰减；旧代码在这条前提上每 tick 丢 10 能量，线上 W32S6/W32S7/W33S6/W33S5 地面各堆 1000–2600）',
    check(report, ROOMS) {
        // fixtures.js 在外矿源 1 播了满容器 + 满仓的 5 WORK 矿工，并把该源的运输槽位距离写成 500 ⇒ 永远没有 hauler 来取，
        // 容器全程满着：旧代码在 ~800 tick 里会把约 8000 能量丢到地上（净堆几千），新代码一滴都不丢
        const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
        const home = memory && memory.rooms && memory.rooms[ROOMS.remoteHome];
        const record = home && home.remotes && home.remotes[ROOMS.remote];
        const overflowed = !!(record && (record.sources || []).some((source) => source && source.distance === 500));
        if (!overflowed) return { ok: false, why: '外矿记录里没有播种的 500 格运输槽位（前提没成立）' };
        const ground = Number(report.remoteGround || 0);
        return ground < 200
            ? { ok: true }
            : { ok: false, why: `外矿房地面仍堆着 ${ground} 能量：满容器下的矿工没有停手（旧代码每 tick 丢一次采集溢出）` };
    },
});

EFFECTS.push({
    id: 'layout.rampartTargetFitsIncome', since: '2026-09-09',
    change: 'RCL6 的 rampart 维修目标从 30 万降到 10 万（30 万 × 84 格外环 = 25M 血 ≈ 25 万能量，远超房收入；rampart 归零只是失去防护、1 能量即可重建）',
    check(report, ROOMS) {
        // maintenance 房在 spawn 上播了一座 15 万血的 rampart：旧目标 30 万时它 needsRepair=true、进 broker 的维修池；
        // 新目标 10 万时 15 万 > 10 万，不进池。池子里出现任何 rampart 都说明目标没降下来。
        const probe = report.maintenanceEarly || roomProbe(report, ROOMS.maintenance);
        const repair = probe && probe.repair;
        if (!Array.isArray(repair)) return { ok: false, why: `没拿到 ${ROOMS.maintenance} 的维修任务池: ${JSON.stringify(repair)}` };
        // 条目是 [类型, 权重, backlog]。只看目标超过 10 万的：旧目标 30 万下那座 15 万血的 backlog 是 15 万；
        // 新建的核心 rampart（1 血、目标 ≤ 10 万、backlog ≤ 10 万）进池是正常的——2026-09-11 起 builder 不再建 terminal/lab
        // （storage 没过奢侈门槛），腾出手把核心 rampart 工地建成，池里就有了 backlog 99999 的新 rampart
        const ramparts = repair.filter((entry) => entry[0] === 'rampart' && Number(entry[2]) > 100000);
        return ramparts.length === 0
            ? { ok: true }
            : { ok: false, why: `15 万血的 rampart 仍在维修池里（目标仍是 30 万）: ${JSON.stringify(ramparts)}` };
    },
});

EFFECTS.push({
    id: 'builder.nearestEnergySource', since: '2026-09-10',
    change: 'builder 的取能点按路径距离选最近（容器/storage/收货 link），不再是"先容器、容器没有才 storage"；取能点近时也不空等投递',
    check(report, ROOMS) {
        // 维护房把 800 能量的 storage 摆在 builder 出生点紧邻格，源容器在十几格外：新的取能点规则（按距离选最近）
        // 必须选 storage；旧代码"先容器、容器没有才 storage"会一直用源容器（builderSource.type 会是 container）
        // 维护房把 800 能量的 storage 摆在 builder 出生点紧邻格，源容器在十几格外：新的取能点规则（按距离选最近）
        // 第一次取能必须选 storage；旧代码"先容器、容器没有才 storage"会一直用源容器（历史里只有 container）
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.maintenance];
        const log = room && room.builderSourceLog;
        if (!Array.isArray(log) || !log.length) return { ok: false, why: '维护房没有 builderSourceLog 遥测（旧代码没有这条）: ' + JSON.stringify(room && room.builderSource) };
        // 用"第一次取能点"判定：环形历史会被后来的取能点顶掉（长跑之后 storage 早被掏空、
        // builder 只剩远处的源容器可选——那是**正确**的最近选择，不是旧代码的"先容器"）
        const first = room && room.builderSourceFirst;
        const pick = first || log[0];
        const ok = !!pick && (pick.type === 'storage' || pick.type === 'link');
        return { ok, why: ok ? null : 'builder 的第一次取能点不是最近的 storage/link: ' + JSON.stringify({ first, log }) };
    },
});

EFFECTS.push({
    id: 'utils.rampartTargetFollowsBudget', since: '2026-09-10',
    change: 'rampart 的维修目标按房间能量收支动态定（预算 × 份额 × 抬升期 ÷ 已建 rampart 数），不再是固定 RCL 表',
    check(report, ROOMS) {
        const probe = report.maintenanceEarly || roomProbe(report, ROOMS.maintenance);
        const info = probe && probe.rampartTarget;
        if (!info || typeof info !== 'object' || typeof info.target !== 'number') {
            return { ok: false, why: '探针里没有 rampartTarget（旧代码没有这条遥测）: ' + JSON.stringify(info) };
        }
        const settings = require(path.join(ROOT, 'src/config')).ramparts || {};
        const perRampart = info.budget * Number(settings.incomeShare) * Number(settings.raiseTicks) * Number(settings.hitsPerEnergy) / Math.max(1, info.count);
        const expected = Math.max(Number(settings.floorHits) || 0, Math.min(100000, perRampart));
        const ok = info.target > 0 && Math.abs(info.target - expected) < 1;
        return { ok, why: ok ? null : 'rampart 目标与能量预算公式不符: ' + JSON.stringify({ info, expected, perRampart }) };
    },
});

EFFECTS.push({
    id: 'upgrader.incomeShare', since: '2026-09-10',
    change: '能量吃紧的房里控制器只吃本地供给的 incomeShare（其余留给搬运/维修/建造），不再是 W20 的大身体把 link 链收入 100% 吃光',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.maintenance];
        const budget = room && room.upgradeBudget;
        if (!budget) return { ok: false, why: '维护房没有 upgradeBudget 遥测（旧代码没有这条）' };
        // 2026-09-11 起限流只在有竞争需求时生效（utils.upgradeCompeting）：维护房开局有路工地，限流生效时的样本在 lastHeld；
        // builder 把工地建完、需求消失后限流会放开，末态不再是限流值
        const track = budget.lastHeld || (budget.cap != null ? budget : null);
        if (!track) return { ok: false, why: '有工地的吃紧房从没限流过: ' + JSON.stringify(budget) };
        const config = require(path.join(ROOT, 'src/config'));
        const share = Number((config.upgrading || {}).incomeShare);
        // 维护房 2 源 × 3000/300 = 20/tick；storage 只播 800 < lowBelow，所以限流必须生效
        const cap = Math.floor(20 * share);
        const ok = budget.low === true && track.cap === cap && track.work > cap && track.duty > 0 && track.duty < 1
            && Math.abs(track.duty - cap / track.work) < 0.01;
        return { ok, why: ok ? null : '控制器取能上限/降频比例与公式不符: ' + JSON.stringify({ budget, track, cap, share }) };
    },
});

EFFECTS.push({
    id: 'builder.feedProspect', since: '2026-09-10',
    change: 'builder 不再为空着手的 hauler 白等投递：房里的 hauler 都没能量、也没认领送它这单时直接自己去取',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.maintenance];
        const track = room && room.builderFeed;
        if (!track) return { ok: false, why: '维护房没有 builderFeed 遥测（旧代码没有这条）' };
        // 维护房只播了 0 能量且退役中的 hauler：旧代码在这些 tick 会原地等（wait），新代码自己去取（self）
        const ok = Number(track.self) > 0;
        return { ok, why: ok ? null : '没有观察到"本来会等但没人会来"的 tick: ' + JSON.stringify(track) };
    },
});

EFFECTS.push({
    id: 'builder.repairSticksToReach', since: '2026-09-10',
    change: 'builder 挑危急结构时先修 3 格内够得着的那一个，不再为"全局比例更好"的目标走 20 格（来回一次只修 1 tick）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.maintenance];
        const seed = room && room.maintenanceSeed;
        const mt = report.maintenance;
        if (!seed || !seed.farRoad || !Array.isArray(mt && mt.roads)) {
            return { ok: false, why: '维护房报告或播种位置缺失: ' + JSON.stringify({ seed: !!seed, roads: !!(mt && mt.roads) }) };
        }
        // 塔射程外的危急路（150 血，>20 格）只有 builder 能救：builder 必须走那一趟，
        // 而不是被"射程内那条 3 格内的路"永久占住（就近优先只是优先，修到危急线以上就重新评估）
        const far = mt.roads.find(([x, y]) => x === seed.farRoad.x && y === seed.farRoad.y);
        const ok = !!far && far[2] > 200;
        return { ok, why: ok ? null : '射程外的危急路没有被修（就近优先把 builder 永久占在近处？）: ' + JSON.stringify({ far, seed: seed.farRoad }) };
    },
});

EFFECTS.push({
    id: 'spawn.repairDemandBuilders', since: '2026-09-10',
    change: '编制把塔射程外的维修债算进 builder 需求侧：塔有能量也只挡住射程内的活（旧代码连射程外一起挡，房间 builder 0 只）',
    check(report, ROOMS) {
        // 纯维修房与维护房是同一个用户（roomContextFor）：report 里只存了维护房那个用户的根 Memory，
        // 从它的 rooms[纯维修房] 里读
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.repairOnly];
        if (!room) return { ok: false, why: '纯维修房没有 Memory（房没跑起来？）: ' + JSON.stringify(Object.keys((memory && memory.rooms) || {})) };
        const state = room.state || {};
        const event = room.outOfReachRepair;
        const target = Number(state.builderTarget || 0);
        // 看决策事件：outOfReachRepair 只在"塔有能量 + 没有工地 + 射程外维修债够量"而放行 builder 时写（旧代码在这里返回 false）。
        // 不看末态 builderTarget：2026-09-11 起射程外的债低于 construction.outOfReachMinDebt（1 万血）不为它常驻 builder，
        // builder 把债修到下限以下后编制归 0 是预期行为（validation-AXhRew：第 890 tick 债 10500 时放行 1497 次，末态债 5000、编制 0）
        const minDebt = Number((require(path.join(ROOT, 'src/config')).construction || {}).outOfReachMinDebt) || 0;
        const ok = !!event && Number(event.n) >= 1 && Number(event.count) >= 1 && Number(event.debt) >= minDebt && Number(event.debt) > 0;
        return { ok, why: ok ? null : '射程外的维修债没有进编制（旧代码在这里 builderTarget=0）: '
            + JSON.stringify({ target, event, minDebt, repairDebt: state.builderRepairDebt, outOfReach: state.builderOutOfReach }) };
    },
});

EFFECTS.push({
    id: 'utils.planOnlyRepair', since: '2026-09-10',
    change: '方案外的旧建筑不再维修（needsRepair 与危急目标共用 plannedStructure，planRoadKeys 不再并入外矿路网的坐标）',
    check(report, ROOMS) {
        // 纯维修房播的 14 条路**在方案里**（plan.roads.all）：它们必须仍在"需要维修"的集合里，
        // 否则就是方案过滤把方案内的路也滤掉了（W33S7 那 3 条撞键旧路才是该被滤掉的那类）
        const memory = report.rootMemories && report.rootMemories[ROOMS.maintenance];
        const room = memory && memory.rooms && memory.rooms[ROOMS.repairOnly];
        const state = (room && room.state) || {};
        // state.builder* 只在 spawn 写需求的 tick 才有（assessRoomState 每 tick 新建 state，spawn 忙时写需求降频）：
        // 末态缺字段不等于没看到（validation-EbXkOa：最后一 tick 没写需求，而 1276 tick 的决策事件还记着 28 处、债 42800）。
        // 决策事件 outOfReachRepair / outOfReachBelowFloor 的 count 就是"射程外需要维修"的结构数，同样能证明方案内的路没被滤掉
        const counted = [room && room.outOfReachRepair, room && room.outOfReachBelowFloor].some((event) => event && Number(event.count) >= 1);
        const ok = Number(state.builderOutOfReach) >= 1 || counted;
        return { ok, why: ok ? null : '纯维修房没看到射程外需要维修的结构（方案内的路被误滤？）: '
            + JSON.stringify({ state, outOfReachRepair: room && room.outOfReachRepair, below: room && room.outOfReachBelowFloor }) };
    },
});

// ---- 2026-09-11 全面审计的一批修复：audit 场景（fixtures.seedAudit），一个用户五个房 ----
function auditMem(report, ROOMS) {
    const memory = report.rootMemories && report.rootMemories[ROOMS.auditHome];
    return (memory && memory.rooms) || {};
}
function auditObjects(report, room) {
    return (report.audit && report.audit[room]) || [];
}
function auditSeedOf(report, ROOMS) {
    const room = auditMem(report, ROOMS)[ROOMS.auditHome];
    return room && room.auditSeed;
}
const at = (pos) => (object) => pos && object.x === pos.x && object.y === pos.y;

EFFECTS.push({
    id: 'audit.remoteLegRepaired', since: '2026-09-11',
    change: 'planRoadKeys 重新收录外矿路线在母房里的那一段（remote:<外矿>:<源> 存的是母房坐标）：这些路恢复维修，不再烂到 0 被 layout 重建',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        if (!seed) return { ok: false, why: 'auditSeed 缺失（audit 场景没播上）' };
        const packed = home.plan && home.plan.roads && home.plan.roads[seed.legKey];
        const tile = seed.legPos.x + '.' + seed.legPos.y;
        if (!packed || !String(packed).split(';').includes(tile)) {
            return { ok: false, why: '前提不成立：母房方案里没有这条外矿路线的母房段 ' + JSON.stringify({ key: seed.legKey, packed }) };
        }
        const road = auditObjects(report, ROOMS.auditHome).find((o) => o.type === 'road' && at(seed.legPos)(o));
        if (!road) return { ok: false, why: '外矿路线母房段的路不见了' };
        return road.hits >= 2800 ? { ok: true, detail: road.hits }
            : { ok: false, why: `外矿路线母房段的路没人修（塔射程内，结束 ${road.hits} 血，播种 2000）` };
    },
});

EFFECTS.push({
    id: 'audit.wallNotCritical', since: '2026-09-11',
    change: 'criticallyDamaged 排除 constructedWall：方案外旧墙不再被当成危急结构吸走 builder 的能量（线上 W34S7 每 tick 2 能量灌墙）',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        if (!seed) return { ok: false, why: 'auditSeed 缺失' };
        const objects = auditObjects(report, ROOMS.auditRich);
        const wall = objects.find((o) => o.type === 'constructedWall' && at(seed.wallPos)(o));
        if (!wall) return { ok: false, why: '前提不成立：富房里没有播种的墙' };
        const site = objects.find((o) => o.type === 'constructionSite' && at(seed.roadSitePos)(o));
        const road = objects.find((o) => o.type === 'road' && at(seed.roadSitePos)(o));
        const built = !!road || (site && Number(site.progress) > 0);
        if (wall.hits !== seed.wallHits) return { ok: false, why: `builder 还在修墙（${seed.wallHits} → ${wall.hits}）` };
        return built ? { ok: true } : { ok: false, why: '墙没被修，但道路工地也没进度（builder 没干活，观察不到）: ' + JSON.stringify(site) };
    },
});

EFFECTS.push({
    id: 'audit.selfFundedStaffed', since: '2026-09-11',
    change: '运回本房且产出 > 摊销的外矿自负盈亏，不受收入预算约束（旧规则收入一掉就裁、形成死亡螺旋）',
    check(report, ROOMS) {
        const rich = auditMem(report, ROOMS)[ROOMS.auditRich] || {};
        const seen = rich.remoteOverBudgetSeen;
        return seen && Array.isArray(seen.rooms) && seen.rooms.length
            ? { ok: true, detail: seen }
            : { ok: false, why: '没有观察到自负盈亏的外矿超预算仍在编: ' + JSON.stringify({ seen, staff: rich.remoteStaff }) };
    },
});

EFFECTS.push({
    id: 'audit.linkHold', since: '2026-09-11',
    change: '没有 store link 时源 link 只在 ctrl link 低于保留线时才补：多余的源收入堵在源 link、溢进源容器给 hauler',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        return home.linkHold && home.linkHold.n > 0 ? { ok: true, detail: home.linkHold }
            : { ok: false, why: 'RCL6 母房的源 link 从来没有按兵不动过: ' + JSON.stringify(home.linkHold) };
    },
});

EFFECTS.push({
    id: 'audit.builderYieldsToSpawn', since: '2026-09-11',
    change: 'spawn 为队头攒能量时 builder/升级者不借 ctrl link、不刮源容器、不抽 spawn/ext 余量',
    check(report, ROOMS) {
        const rooms = auditMem(report, ROOMS);
        const hit = Object.entries(rooms).find(([, room]) => room && room.builderHunger && room.builderHunger.n > 0);
        return hit ? { ok: true, detail: { room: hit[0], hunger: hit[1].builderHunger } }
            : { ok: false, why: 'audit 各房都没有记到 builder 为 spawn 让路' };
    },
});

EFFECTS.push({
    id: 'audit.luxuryGate', since: '2026-09-11',
    change: 'lab/factory 等奢侈建筑等 storage 过 luxuryStorageAbove（2026-10-03 起 1 万）再放、再建；terminal 不受门槛约束',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        if (!seed) return { ok: false, why: 'auditSeed 缺失' };
        const objects = auditObjects(report, ROOMS.auditHome);
        if (objects.some((o) => o.type === 'constructionSite' && o.structureType === 'lab')) return { ok: false, why: 'storage 0 时仍放了 lab 工地' };
        return home.luxuryHeld ? { ok: true, detail: home.luxuryHeld } : { ok: false, why: 'layout 没有记下 luxuryHeld（门槛没评估到？）' };
    },
});

EFFECTS.push({
    id: 'audit.terminalUngated', since: '2026-10-03',
    change: 'terminal 不再受 storage 门槛约束：storage 0 的 RCL6 房里已有的 terminal 工地照常被 builder 推进（线上 12 个 RCL7 房 storage 常年 <1 万，terminal 一座没有）',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        if (!seed) return { ok: false, why: 'auditSeed 缺失' };
        const objects = auditObjects(report, ROOMS.auditHome);
        const built = objects.find((o) => o.type === 'terminal' && at(seed.terminalPos)(o));
        if (built) return { ok: true, detail: 'terminal 已建成' };
        const site = objects.find((o) => o.type === 'constructionSite' && o.structureType === 'terminal' && at(seed.terminalPos)(o));
        if (!site) return { ok: false, why: 'terminal 工地与建筑都不见了' };
        return Number(site.progress) > seed.terminalProgress
            ? { ok: true, detail: `${seed.terminalProgress} → ${site.progress}` }
            : { ok: false, why: `storage 0 时 terminal 工地没有推进（${seed.terminalProgress} → ${site.progress}）：门槛仍在挡它？` };
    },
});

EFFECTS.push({
    id: 'spawn.quietDemandSkip', since: '2026-10-03',
    change: 'spawn 有空闲但上一轮全量推导没有任何请求的"安静房"，按房错峰每 quietDemandInterval tick 才全量推导（线上 13 房里 10 房是这个形态，spawn 单项均值 42.6/131 CPU）',
    check(report) {
        const skipped = [];
        for (const key of Object.keys(report.rootMemories || {})) {
            const rooms = report.rootMemories[key] && report.rootMemories[key].rooms;
            for (const name of Object.keys(rooms || {})) {
                const demand = rooms[name] && rooms[name].demand;
                if (demand && demand.quietSkipped > 0) skipped.push([name, demand.quietSkipped]);
            }
        }
        return skipped.length ? { ok: true, detail: skipped.slice(0, 5) }
            : { ok: false, why: '没有任何房记录过 demand.quietSkipped（旧代码没有这个字段，也从不跳过）' };
    },
});

function pocketSeedOf(report, ROOMS) {
    const seed = auditSeedOf(report, ROOMS);
    return seed && seed.pocket;
}

EFFECTS.push({
    id: 'spawn.pocketDirections', since: '2026-10-08',
    change: 'spawn 旁被建筑/墙围死的出生口袋不当出生方向（spawnCreep 带 directions）：线上 2026-10-08 W31S4 的 Spawn18 正上方 (25,15) 孵进去的升级者一步走不出来，空手站到老死、控制器 0 进度',
    check(report, ROOMS) {
        const pocket = pocketSeedOf(report, ROOMS);
        if (!pocket) return { ok: false, why: 'auditSeed.pocket 缺失（seedAuditPocket 没跑？）' };
        const mem = auditMem(report, ROOMS)[ROOMS.auditPocket] || {};
        const log = mem.spawnPocket && mem.spawnPocket[pocket.spawnName];
        if (!log || !Array.isArray(log.pockets) || !log.pockets.includes(1) || !Array.isArray(log.dirs) || !log.dirs.length || log.dirs.includes(1)) {
            return { ok: false, why: 'spawnPocket 遥测没记下 TOP 是口袋、或仍往 TOP 出生（旧代码不看口袋）：' + JSON.stringify(mem.spawnPocket || null) };
        }
        const trapped = auditObjects(report, ROOMS.auditPocket).filter((o) => o.type === 'creep' && at(pocket.pocket)(o) && o.name !== pocket.upgrader);
        if (trapped.length) return { ok: false, why: '口袋格里有新孵的 creep：' + trapped.map((o) => o.name).join(',') };
        const stall = mem.spawnStallLog || {};
        return Number(stall.bornPocket) > 0 ? { ok: false, why: 'spawnStallLog.bornPocket > 0：有卡过的出生落进了口袋：' + JSON.stringify(stall.born || null) }
            : { ok: true, detail: log };
    },
});

EFFECTS.push({
    id: 'spawn.pocketMineralObstacle', since: '2026-10-08',
    change: '出生口袋的 BFS 把源/矿当障碍：过去当可走格，口袋圈上有矿/源时经由它"连通"到外面，被误判成开口照样往口袋里孵',
    check(report, ROOMS) {
        const pocket = pocketSeedOf(report, ROOMS);
        if (!pocket || !pocket.mineral) return { ok: false, why: 'auditSeed.pocket.mineral 缺失（夹具没把矿挪到口袋圈上）：' + JSON.stringify(pocket || null) };
        const mem = auditMem(report, ROOMS)[ROOMS.auditPocket] || {};
        const log = mem.spawnPocket && mem.spawnPocket[pocket.spawnName];
        if (!log || !Array.isArray(log.pockets) || !log.pockets.includes(1)) {
            return { ok: false, why: '口袋圈上有矿时没有把 TOP 判成口袋（旧 BFS 经由矿格连通出去）：' + JSON.stringify(mem.spawnPocket || null) };
        }
        return { ok: true, detail: { mineral: pocket.mineral, log } };
    },
});

EFFECTS.push({
    id: 'upgrader.stuckWatchdog', since: '2026-10-08',
    change: '离控制器 > 3 格、没有疲劳却原地不动的升级者先重算路径、stuckRetireTicks 后退役回收（编制立刻出替补）：线上 W31S4 的 慧音甲 困在口袋里占着唯一名额 600+ tick',
    check(report, ROOMS) {
        // 2026-10-08 起在 auditWalled 观察：auditPocket 里困在口袋的升级者改由 spawn.pocketTrappedRecycle 当场回收，轮不到看门狗
        const seed = (auditSeedOf(report, ROOMS) || {}).walled;
        if (!seed) return { ok: false, why: 'auditSeed.walled 缺失（seedAuditWalled 没跑？）' };
        const mem = auditMem(report, ROOMS)[ROOMS.auditWalled] || {};
        const log = mem.upgraderStuck;
        if (!log || !(Number(log.retire) >= seed.retireSeeded + 1)) return { ok: false, why: '看门狗没有退役过卡死的升级者（旧代码没有看门狗）：' + JSON.stringify(log || null) };
        const still = auditObjects(report, ROOMS.auditWalled).find((o) => o.type === 'creep' && o.name === seed.upgrader);
        return still ? { ok: false, why: '卡死的升级者结束时还在 (' + still.x + ',' + still.y + ')' } : { ok: true, detail: log };
    },
});

EFFECTS.push({
    id: 'upgrader.stuckRepathPerCreep', since: '2026-10-08',
    change: '卡死看门狗的重算只重置这只升级者自己的路径（movement.resetCreepPath）：过去调 invalidateRoom，全房缓存路径作废、当场重建 costMatrix，绕过路网刷新的限频',
    check(report, ROOMS) {
        const mem = auditMem(report, ROOMS)[ROOMS.auditWalled] || {};
        const log = mem.upgraderStuck;
        if (!log || !(Number(log.repath) >= 1)) return { ok: false, why: '看门狗没有走到重算这一步：' + JSON.stringify(log || null) };
        return Number(log.reset) >= 1 ? { ok: true, detail: log }
            : { ok: false, why: '重算时没有按 creep 重置路径（旧代码 invalidateRoom 整房）：' + JSON.stringify(log) };
    },
});

EFFECTS.push({
    id: 'spawn.pocketTrappedRecycle', since: '2026-10-08',
    change: '站在出生口袋里的己方 creep（旧兜底孵进去的，一步都走不出去）由贴着的 spawn 当场回收：线上 W34S7 的替补源矿工被孵进口袋，只能手动 console 回收',
    check(report, ROOMS) {
        const pocket = pocketSeedOf(report, ROOMS);
        if (!pocket) return { ok: false, why: 'auditSeed.pocket 缺失（seedAuditPocket 没跑？）' };
        const mem = auditMem(report, ROOMS)[ROOMS.auditPocket] || {};
        const log = (mem.spawnStallLog || {}).trapped;
        if (!log || !(Number(log.n) >= 1) || log.name !== pocket.upgrader || log.x !== pocket.pocket.x || log.y !== pocket.pocket.y) {
            return { ok: false, why: '没有把口袋里的升级者标记为 pocketTrapped（旧代码不看口袋里的 creep）：' + JSON.stringify(log || null) };
        }
        if (!(Number(log.recycled) >= 1)) return { ok: false, why: '标记了但没有回收：' + JSON.stringify(log) };
        const still = auditObjects(report, ROOMS.auditPocket).find((o) => o.type === 'creep' && o.name === pocket.upgrader);
        return still ? { ok: false, why: '口袋里的升级者结束时还在 (' + still.x + ',' + still.y + ')' } : { ok: true, detail: log };
    },
});

EFFECTS.push({
    id: 'upgrader.stuckBackoff', since: '2026-10-08',
    change: '控制器真的够不着时，看门狗连续 stuckBackoffAfter 次退役之间控制器零进度就退避 stuckBackoffTicks、不再退役：旧代码孵 → 卡 300 tick → 退役 → 再孵没有尽头',
    check(report, ROOMS) {
        const seed = (auditSeedOf(report, ROOMS) || {}).walled;
        if (!seed) return { ok: false, why: 'auditSeed.walled 缺失（seedAuditWalled 没跑？）' };
        const mem = auditMem(report, ROOMS)[ROOMS.auditWalled] || {};
        const log = mem.upgraderStuck;
        // 播了 retireSeeded 次退役 + 控制器标记；真实只该再退役 1 次（够数进退避），之后卡住的替补被留着
        if (!log || !(Number(log.retire) >= seed.retireSeeded + 1)) return { ok: false, why: '播种的卡死升级者没有被退役：' + JSON.stringify(log || null) };
        if (!(Number(log.backoffs) >= 1) || !(Number(log.backoffUntil) > Number(log.backoffAt))) {
            return { ok: false, why: '连续退役零进度后没有进入退避（旧代码没有退避）：' + JSON.stringify(log) };
        }
        if (Number(log.retire) !== seed.retireSeeded + 1) return { ok: false, why: '退避期间还在退役：' + JSON.stringify(log) };
        const still = auditObjects(report, ROOMS.auditWalled).find((o) => o.type === 'creep' && o.name === seed.upgrader);
        return still ? { ok: false, why: '播种的卡死升级者结束时还在 (' + still.x + ',' + still.y + ')' } : { ok: true, detail: log };
    },
});

EFFECTS.push({
    id: 'spawn.exitVacate', since: '2026-10-08',
    change: '孵好的 creep 出不来（避开口袋后的出口全被己方 creep 占住）时让能动的那只让路、等出生完成再回来；兜底只放开非口袋方向：线上 2026-10-08 W34S7 旧兜底放开全部 8 个方向，替补源矿工孵进 TOP_LEFT 口袋被困死',
    check(report, ROOMS) {
        const seed = (auditSeedOf(report, ROOMS) || {}).walled;
        if (!seed || !seed.born || !seed.vacateTile || !seed.pocket) return { ok: false, why: 'auditSeed.walled 缺出口几何（seedAuditWalled 没按 W34S7 形态播？）：' + JSON.stringify(seed || null) };
        const mem = auditMem(report, ROOMS)[ROOMS.auditWalled] || {};
        const log = mem.spawnStallLog || {};
        const vacate = log.vacate;
        if (!vacate || !(Number(vacate.n) >= 1) || !(Number(vacate.moved) >= 1)) {
            return { ok: false, why: '没有让路请求/让路移动（旧代码只会放开方向）：' + JSON.stringify(log) };
        }
        const born = (Array.isArray(log.bornHistory) ? log.bornHistory : []).find((b) => b && b.name === seed.born);
        if (!born) return { ok: false, why: '没有记下播种那只的出生（bornHistory）：' + JSON.stringify(log) };
        if (born.pocket || (born.x === seed.pocket.x && born.y === seed.pocket.y)) return { ok: false, why: '孵进了口袋：' + JSON.stringify(born) };
        if (born.x !== seed.vacateTile.x || born.y !== seed.vacateTile.y || born.vacate !== seed.parked) {
            return { ok: false, why: '没有靠 ' + seed.parked + ' 让路生在 RIGHT ' + JSON.stringify(seed.vacateTile) + '：' + JSON.stringify(born) };
        }
        if (Number(log.bornPocket) > 0) return { ok: false, why: 'bornPocket > 0：' + JSON.stringify(log) };
        if (Array.isArray(log.to) && log.to.includes(8)) return { ok: false, why: '兜底放开了口袋方向 TOP_LEFT：' + JSON.stringify(log) };
        const inPocket = auditObjects(report, ROOMS.auditWalled).filter((o) => o.type === 'creep' && at(seed.pocket)(o));
        if (inPocket.length) return { ok: false, why: '结束时口袋格里有 creep：' + inPocket.map((o) => o.name).join(',') };
        return { ok: true, detail: { vacate, born } };
    },
});

EFFECTS.push({
    id: 'spawn.upgraderSupplyCap', since: '2026-10-08',
    change: '升级者身体与编制按可持续供给（本地 10/tick/源 + storage 富余摊到 1500 tick）封顶，不跟着瞬时限流在 W12 / W47 之间翻（线上 21 只 731 WORK 养身体 51.5/tick，CP 被 ctrl link 20/tick 卡死）',
    check(report, ROOMS) {
        const pocket = pocketSeedOf(report, ROOMS);
        if (!pocket) return { ok: false, why: 'auditSeed.pocket 缺失（seedAuditPocket 没跑？）' };
        const mem = auditMem(report, ROOMS)[ROOMS.auditPocket] || {};
        const sizeCap = mem.upgradeSupply && mem.upgradeSupply.sizeCap;
        // auditPocket：2 源 20/tick、storage 3000 < lowExitAbove → 供给 20；容量 2300 本来能出 W21
        if (!sizeCap || sizeCap.cap !== 20 || !(sizeCap.would > sizeCap.cap)) {
            return { ok: false, why: '没有记下"容量能出更多 WORK、被供给封顶到 20"（旧代码按瞬时限流定身体）：' + JSON.stringify(mem.upgradeSupply || null) };
        }
        const creepMem = (report.rootMemories[ROOMS.auditHome] && report.rootMemories[ROOMS.auditHome].creeps) || {};
        const fat = auditObjects(report, ROOMS.auditPocket).filter((o) => o.type === 'creep' && o.name !== pocket.upgrader &&
            creepMem[o.name] && creepMem[o.name].role === 'upgrader' && (o.body || []).filter((p) => p === 'work').length > sizeCap.cap);
        return fat.length ? { ok: false, why: '新孵的升级者超过供给封顶：' + fat.map((o) => o.name + ' W' + o.body.filter((p) => p === 'work').length).join(',') }
            : { ok: true, detail: sizeCap };
    },
});

EFFECTS.push({
    id: 'audit.reserverByReservation', since: '2026-09-11',
    change: 'reserver 只按预定余量补，预定充足时在岗 reserver 到期也不续派（引擎拒绝把预定推过 5000）',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const record = home.remotes && home.remotes[ROOMS.auditRemote];
        const skip = record && record.reserverSkip;
        return skip && Number(skip.reservation) > 1000 ? { ok: true, detail: skip }
            : { ok: false, why: '预定 4998 + 快到期的 reserver，却没有记下"不续派": ' + JSON.stringify(record && { reserverSkip: record.reserverSkip, reservation: record.reservation }) };
    },
});

EFFECTS.push({
    id: 'audit.dropSkipsRicher', since: '2026-09-11',
    change: '卸货房不选比母房富得多的己方房（能量送去只会躺在富房 storage 里，母房替它养 creep）',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const record = home.remotes && home.remotes[ROOMS.auditDrop];
        const drop = record && record.drop;
        const ok = !!drop && drop.room === ROOMS.auditHome && Array.isArray(drop.skippedRicher) && drop.skippedRicher.includes(ROOMS.auditRich);
        return ok ? { ok: true, detail: drop } : { ok: false, why: '离富房 1 跳的外矿没有跳过富房、卸回母房: ' + JSON.stringify(drop) };
    },
});

EFFECTS.push({
    id: 'audit.selfRegenOnlyBelow300', since: '2026-09-11',
    change: 'spawn 自产只在全房能量 < 300 时扣除：spawn 空而 extension 有货时收入 EMA 照常采样（旧代码冻结）',
    check(report) {
        for (const memory of Object.values(report.rootMemories || {})) {
            for (const [name, room] of Object.entries((memory && memory.rooms) || {})) {
                if (room && room.spawnIncome && Number(room.spawnIncome.noRegen) > 0) return { ok: true, detail: { room: name, noRegen: room.spawnIncome.noRegen } };
            }
        }
        return { ok: false, why: '没有任何房出现过"spawn < 300 但全房 ≥ 300"的采样' };
    },
});

EFFECTS.push({
    id: 'audit.linkMinersNotCarriers', since: '2026-09-11',
    change: '收入估计的搬运者不含只往 link/容器交货的矿工：没有 hauler 时收入归 0，生存档 hauler 立刻按现有能量孵',
    check(report, ROOMS) {
        // 看决策本身：auditHome 的两只 5W1C1M 矿工站在容器 + 源 link 上，带 CARRY 却只往 link/容器交货，不算搬运者（旧代码算）。
        // "收入归 0 → 按现有能量孵"这个后果在这里区分不了：同一房的外矿 hauler 卸货回本房，本来就是搬运者（收入 > 0），
        // 新旧代码都按容量一半等几 tick（validation-Wmg3Hx：第 4 tick 以 1150 孵出）；后果由 test/smoke.js 覆盖
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const decided = home.spawnIncome && home.spawnIncome.minerNotCarrier;
        return decided && decided.n > 0 && decided.miners >= 1 ? { ok: true, detail: decided }
            : { ok: false, why: '没有记到"带 CARRY 的 link/容器矿工不算搬运者": ' + JSON.stringify(home.spawnIncome) };
    },
});

EFFECTS.push({
    id: 'audit.vitalFirst', since: '2026-09-11',
    change: '同一优先级里 vital 请求排在前面、非 vital 队头等能量时不挡 vital：先出现的底线升级者不再挡住第 1 只 hauler',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const first = home.spawnFirst;
        return first && first.key === 'core:hauler:0' ? { ok: true, detail: first }
            : { ok: false, why: '底线升级者请求早出现 1000 tick 时，第一次孵化不是 vital 的 hauler: ' + JSON.stringify({ first, log: home.spawnLog }) };
    },
});

EFFECTS.push({
    id: 'audit.reserveAtAcceptedBody', since: '2026-09-11',
    change: '核心替补预留按替补实际会接受的身体（容量 × minShare）计价、窗口封顶，不再按满容量理想身体冻结队列',
    check(report, ROOMS) {
        const rich = auditMem(report, ROOMS)[ROOMS.auditRich] || {};
        const log = rich.reserveLog && rich.reserveLog.hauler;
        // 2026-09-11 第二批起理想身体本身按运量定（spawn.coreHaulerCarry），cost 可能等于 ideal；要看的是预留不超过容量 × minShare
        const minShare = Number((require(path.join(ROOT, 'src/config')).spawnQueue || {}).minShare) || 0.5;
        return log && Number(log.cost) > 0 && Number(log.cost) <= Math.ceil(Number(log.capacity) * minShare) ? { ok: true, detail: log }
            : { ok: false, why: '寿命将尽的 hauler 没有按容量一半预留替补: ' + JSON.stringify(rich.reserveLog) };
    },
});

EFFECTS.push({
    id: 'audit.upgraderCapCount', since: '2026-09-11',
    change: '升级限流生效时升级者数量按 上限 ÷ 每只 WORK 封顶（每只已按上限配 W12，第 2 只只会把 duty 摊到 0.5）',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const supply = home.upgradeSupply || {};
        const target = home.demand && home.demand.targets && home.demand.targets.upgrader;
        const ok = supply.capCount === 1 && target === 1 && Number(supply.extra) >= 1;
        return ok ? { ok: true, detail: { capCount: supply.capCount, target, extra: supply.extra } }
            : { ok: false, why: '限流（W12 上限）下升级者目标没有封顶为 1: ' + JSON.stringify({ supply, target }) };
    },
});

EFFECTS.push({
    id: 'audit.outOfReachDebtFloor', since: '2026-09-11',
    change: '塔射程外的维修债低于 outOfReachMinDebt（1 万血）时不为它常驻 builder',
    check(report, ROOMS) {
        // 决策事件：没有工地、没有危急结构、塔有能量、射程外有维修债但低于下限时 hasBuilderWork 返回 false（旧规则返回 true 并常驻一只 builder）。
        // 只看结束态不行：link 房的塔会把射程外那两条路修到 60%，结束时债已经是 0
        const link = auditMem(report, ROOMS)[ROOMS.auditLink] || {};
        const event = link.outOfReachBelowFloor;
        return event && Number(event.count) >= 1 && Number(event.debt) > 0 && Number(event.debt) < 10000
            ? { ok: true, detail: event }
            : { ok: false, why: '没有记到"射程外小额维修债不孵 builder"的决策: ' + JSON.stringify({ event, state: link.state }) };
    },
});

EFFECTS.push({
    id: 'audit.upgraderLinkSide', since: '2026-09-11',
    change: 'storage 站位喝不到能量时升级者去 ctrl link 旁的空格，不再守着空站位等 hauler（线上 W33S7 升级者空转约 3 成）',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const link = auditMem(report, ROOMS)[ROOMS.auditLink] || {};
        if (!seed) return { ok: false, why: 'auditSeed 缺失' };
        const labs = auditObjects(report, ROOMS.auditLink).filter((o) => o.type === 'lab');
        if (labs.length < seed.linkGeom.labs.length) return { ok: false, why: '前提不成立：贴 link 的站位格上的 lab 不见了' };
        // 2026-09-12：ctrl link 堵在 linkKeepAt 以上时，同样"去 link 旁喝"的新分支（upgrader.linkRelief）先命中，
        // 记的是 linkRelief。夹具把 ctrl link 播成 800/800，所以两条分支都可能先发生——观察面是一样的：
        // 升级者到了 link 旁的空格，而不是守着喝不到的 storage 站位
        const rec = link.upgraderLinkSide || link.linkRelief;
        return rec && rec.n > 0 ? { ok: true, detail: { upgraderLinkSide: link.upgraderLinkSide, linkRelief: link.linkRelief } }
            : { ok: false, why: 'storage 站位喝不到能量时升级者没有去 ctrl link 旁: ' + JSON.stringify({ side: link.upgraderLinkSide, relief: link.linkRelief }) };
    },
});

EFFECTS.push({
    id: 'audit.zeroIncomeVitalOnly', since: '2026-09-11',
    change: '收入为 0 时只有 vital 请求"有多少用多少"，非 vital 请求守正常缩身下限（旧规则缩成最小身体占槽 1500 tick）',
    check(report, ROOMS) {
        const zero = auditMem(report, ROOMS)[ROOMS.auditZero] || {};
        const held = zero.zeroIncomeHeld;
        // 只看核心请求（援建/外矿/扩张自带"理想成本一半"的缩身下限，收入为 0 时照样按那个下限孵，不是这条改动管的）
        const small = (zero.spawnLog || []).filter((entry) => entry && entry.scaled && /^core:/.test(entry.key) && !/^core:(hauler:0|harvester)/.test(entry.key) && Number(entry.cost) < 900);
        if (small.length) return { ok: false, why: '收入为 0 时孵出了非 vital 的小身体: ' + JSON.stringify(small) };
        return held && held.n > 0 ? { ok: true, detail: held } : { ok: false, why: '没有记到收入为 0 时非 vital 请求守下限: ' + JSON.stringify({ held, spawnIncome: zero.spawnIncome, queue: zero.spawnQueue }) };
    },
});

EFFECTS.push({
    id: 'audit.remoteSpawnCap', since: '2026-09-11',
    change: 'storage ≥ 10 万时外矿按孵化时间封顶（spawn 数 × 0.5），富余升级者提到发展档',
    check(report, ROOMS) {
        const rich = auditMem(report, ROOMS)[ROOMS.auditRich] || {};
        const seen = rich.remoteSpawnCappedSeen;
        return rich.remoteSpawnCapped === true && seen && seen.rooms && seen.rooms.length && Number(seen.used) <= Number(seen.cap) * 1.1 + 1e-9
            ? { ok: true, detail: seen }
            : { ok: false, why: 'storage 15 万的房没有按孵化时间裁外矿: ' + JSON.stringify({ capped: rich.remoteSpawnCapped, seen, staff: rich.remoteStaff }) };
    },
});

EFFECTS.push({
    id: 'audit.remoteMinerFiveMove', since: '2026-09-11',
    change: '路线没铺完的外矿矿工给 5W1C5M（平地 1 tick/格），替补提前量按 1 tick/格算才成立；编制账按源逐个计矿工',
    check(report) {
        const roles = {};
        for (const memory of Object.values(report.rootMemories || {})) {
            for (const [name, creep] of Object.entries((memory && memory.creeps) || {})) roles[name] = creep && creep.role;
        }
        const miners = [];
        for (const objects of Object.values(report.audit || {})) {
            for (const o of objects || []) {
                if (o.type !== 'creep' || roles[o.name] !== 'remoteMiner' || !Array.isArray(o.body)) continue;
                const count = (type) => o.body.filter((part) => part === type).length;
                miners.push({ name: o.name, work: count('work'), move: count('move') });
            }
        }
        const fast = miners.find((m) => m.work === 5 && m.move === 5);
        return fast ? { ok: true, detail: fast }
            : { ok: false, why: '没有看到 5W1C5M 的外矿矿工（外矿场景/audit 外矿的路都没铺完）: ' + JSON.stringify(miners) };
    },
});

EFFECTS.push({
    id: 'audit.harvesterWalkLead', since: '2026-09-11',
    change: '矿工替补提前量加上 spawn → 采集位的步行时间（按真实路径，算上不可通行建筑）；就绪判定仍用孵化提前量',
    check(report) {
        for (const memory of Object.values(report.rootMemories || {})) {
            for (const [name, room] of Object.entries((memory && memory.rooms) || {})) {
                const early = room && room.harvesterEarlyReplace;
                if (early && Number(early.ttl) > Number(early.lead) && Number(early.ttl) <= Number(early.replaceLead)) return { ok: true, detail: { room: name, early } };
            }
        }
        return { ok: false, why: '没有观察到"只因步行时间才提前出的矿工替补"（audit 富房的矿工寿命播 200，应在窗口内进入这个区间）' };
    },
});

EFFECTS.push({
    id: 'audit.remoteHaulNeedAndResidual', since: '2026-09-11',
    change: '外矿运输编制算上投递停靠与利用率；缩身 hauler 占满槽位、母房买不起理想身体时补一只按缺口封顶的 hauler',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const record = home.remotes && home.remotes[ROOMS.auditRemote];
        const source = record && (record.sources || []).find((s) => s && s.containerId);
        if (!source) return { ok: false, why: '前提不成立：audit 外矿没有带容器的源 ' + JSON.stringify(record && record.sources) };
        const rate = Math.max(5, (source.energyCapacity || 1500) / 300);
        const distance = source.distance || 50;
        const oldNeed = Math.max(1, Math.ceil(rate * (distance * 2 + 4) / 50));
        if (!(Number(source.haulNeed) > oldNeed)) return { ok: false, why: `运输需求没有算上停靠与利用率（haulNeed ${source.haulNeed}，零余量公式 ${oldNeed}）` };
        const seen = record.residualSeen;
        return seen && Number(seen.gap) >= 4 ? { ok: true, detail: { haulNeed: source.haulNeed, residual: seen } }
            : { ok: false, why: '4 CARRY 的缩身 hauler 占着槽 0，却没有出补差槽: ' + JSON.stringify(seen) };
    },
});

EFFECTS.push({
    id: 'audit.upgradeCapNeedsDemand', since: '2026-09-11',
    change: '升级限流只在有竞争需求（工地/维修债/spawn 等能量/spawn+ext 持续不满）时生效：storage 吃紧但能量没人要的房不再把控制器压到 60%（线上 W34S7/W35S7 −2.5 CP/tick）',
    check(report, ROOMS) {
        const link = auditMem(report, ROOMS)[ROOMS.auditLink] || {};
        const supply = link.upgradeSupply || {};
        // auditLink：storage 0（吃紧）、没有工地、塔射程外只有两条 1000 缺口的路（< outOfReachMinDebt）、开局 spawn/ext 满。
        // capFree 只在吃紧档里写（utils.upgraderWorkCap），末态 storage 可能已经攒过 lowExitAbove，不再看 low
        return supply.capFree && supply.capFree.n > 0 ? { ok: true, detail: { capFree: supply.capFree, capHeld: supply.capHeld, why: supply.competeWhy } }
            : { ok: false, why: '吃紧但没有竞争需求时仍然限流（没有 capFree）: ' + JSON.stringify(supply) };
    },
});

EFFECTS.push({
    id: 'audit.coreHaulerSized', since: '2026-09-11',
    // 2026-09-12 改为按 CARRY 定编的不变量（spawn.estimateHomeHaulerTarget）：原公式"max(满配 × coreMinBodyShare, need ÷ 编制只数)"随
    // coreMinBodyShare 删掉了——现在只数按满配身体算、每只 = clamp(ceil(C* ÷ 只数), minBodyCarry[RCL], 满配) 再过滞回，满配一半只是没有实测时的兜底。
    // 仍然要看到至少一个房的 hauler 小于满配（旧的旧代码一律满配）
    change: 'core hauler 按 CARRY 方案定尺寸：请求时记下只数 heads、每只下限 min、定编模式 mode；每只在 [min, 满配] 之内、只数 × 每只盖得住 C*，没有实测（fallback）时不低于满配一半，不再一律按容量顶格',
    check(report, ROOMS) {
        const rooms = auditMem(report, ROOMS);
        const sizing = (require(path.join(ROOT, 'src/config')).hauling || {}).sizing || {};
        const fallbackShare = Number(sizing.fallbackShare) || 0.5;
        const seen = [];
        for (const name of [ROOMS.auditHome, ROOMS.auditRich, ROOMS.auditLink, ROOMS.auditZero]) {
            const size = rooms[name] && rooms[name].haulerSize;
            if (!size) continue;
            seen.push(Object.assign({ room: name }, size));
            if (size.need == null) continue;   // 没有运量信号的房：满配（旧行为）
            if (!(size.heads > 0) || !(size.min > 0) || !size.mode) return { ok: false, why: `${name} 的尺寸记录没有 heads/min/mode（旧代码）: ` + JSON.stringify(size) };
            if (size.parts > size.full || size.parts < Math.min(size.min, size.full)) return { ok: false, why: `${name} 的每只 CARRY 出了 [min, 满配]: ` + JSON.stringify(size) };
            if (size.parts < size.full && size.heads * size.parts < Number(size.need) - 0.05) return { ok: false, why: `${name} 只数 × 每只盖不住 C*: ` + JSON.stringify(size) };
            if (size.mode === 'fallback' && size.parts < Math.min(size.full, Math.ceil(size.full * fallbackShare))) {
                return { ok: false, why: `${name} 没有实测却低于满配 ${fallbackShare} 的兜底: ` + JSON.stringify(size) };
            }
        }
        const sized = seen.filter((size) => size.need != null && size.parts < size.full);
        return sized.length ? { ok: true, detail: sized }
            : { ok: false, why: '没有一个房的 core hauler 按运量缩小（旧代码一律满配；或运量都超过满配——那就是前提不成立）: ' + JSON.stringify(seen) };
    },
});

EFFECTS.push({
    id: 'audit.builderRepairHold', since: '2026-09-11',
    change: 'builder 开修危急结构后修到普通维修线（towerRepairBelow 60%）或能量用完才回去建造，不再修过 20% 一点就走（线上 W33S7 方案内道路 54/89 条停在 20–30%）',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const rich = auditMem(report, ROOMS)[ROOMS.auditRich] || {};
        if (!seed || !seed.damagedRoadPos) return { ok: false, why: 'auditSeed 缺少 damagedRoadPos' };
        const road = auditObjects(report, ROOMS.auditRich).find((o) => o.type === 'road' && at(seed.damagedRoadPos)(o));
        if (!road) return { ok: false, why: '播下的 750/5000 危急道路不见了: ' + JSON.stringify(seed.damagedRoadPos) };
        const hold = rich.builderRepairHold;
        // 5000 上限 × 60% = 3000，跑完约 1300 tick 最多再衰减 200；旧代码修到 ~1350（刚过 20%）就回去建造
        return hold && hold.n > 0 && Number(road.hits) >= 2700 ? { ok: true, detail: { hold, hits: road.hits } }
            : { ok: false, why: '危急道路只修过危急线就被放下: ' + JSON.stringify({ hold, hits: road.hits }) };
    },
});

EFFECTS.push({
    id: 'audit.upgradeCapNearFull', since: '2026-09-11',
    change: '升级限流的"spawn/ext 没补满"要低于容量的 competeUnfullShare（80%）才计时；差几十能量不算竞争（线上 W34S7 1756/1800、spawn 空闲无请求，被限流 185 tick）',
    check(report, ROOMS) {
        const rooms = auditMem(report, ROOMS);
        const seen = [ROOMS.auditLink, ROOMS.auditHome, ROOMS.auditZero, ROOMS.auditRich]
            .map((name) => ({ room: name, ignored: rooms[name] && rooms[name].upgradeSupply && rooms[name].upgradeSupply.unfullIgnored }))
            .filter((entry) => entry.ignored && entry.ignored.n > 0);
        return seen.length ? { ok: true, detail: seen }
            : { ok: false, why: '吃紧的审计房里没有记到"没满但在份额以上、不算竞争"的 tick（旧规则只要没满就计时）' };
    },
});

function auditDropRecord(report, ROOMS) {
    const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
    return (home.remotes && home.remotes[ROOMS.auditDrop]) || null;
}

EFFECTS.push({
    id: 'audit.reserverNeedsMiner', since: '2026-09-11',
    change: '每口源都有矿工、却都采不动预定多出的一半（2 WORK 只采 4 < 未预定的 5）时不派 reserver（线上 W32S7 四代 2W 矿工配着 reserver，每条约 1.1–2.2/tick 白花）',
    check(report, ROOMS) {
        const record = auditDropRecord(report, ROOMS);
        if (!record) return { ok: false, why: 'auditHome 没有 auditDrop 外矿记录' };
        const weak = record.reserverWeakMiner;
        return weak && weak.n > 0 && Number(weak.gain) < 1 ? { ok: true, detail: weak }
            : { ok: false, why: '两只 2 WORK 矿工在岗、预定 800 该续派时没有记"矿工太弱不派": ' + JSON.stringify({ weak, reservation: record.reservation }) };
    },
});

EFFECTS.push({
    id: 'audit.minerUpgradeUrgent', since: '2026-09-11',
    change: '在岗吞吐不到理想一半的外矿矿工换代提到外矿维护档、等能量但不挡人（以前是机会档，排在所有发展/外矿请求之后，穷房几代都轮不到）',
    check(report, ROOMS) {
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        // 同一个母房的两条外矿都可能提档，单条 minerUpgradeUrgent 会被后来的覆盖：按槽位在日志里找 auditDrop 那条
        const events = (home.minerUpgradeLog || []).concat(home.minerUpgradeUrgent ? [home.minerUpgradeUrgent] : []);
        const urgent = events.find((entry) => entry && String(entry.slot).indexOf('remoteMiner:' + ROOMS.auditDrop + ':') === 0 &&
            Number(entry.rate) < Number(entry.ideal) * 0.5);
        return urgent ? { ok: true, detail: { urgent, spawned: (home.spawnLog || []).filter((entry) => /^upgrade:remoteMiner:/.test(entry.key)) } }
            : { ok: false, why: '2 WORK 外矿矿工的换代没有提档: ' + JSON.stringify(events) };
    },
});

EFFECTS.push({
    id: 'audit.lostContainerHauler', since: '2026-09-11',
    change: '外矿容器丢了（上次在、这次没了）仍出槽 0 的维护 hauler（带 WORK，捡掉落、建容器）；以前没有 containerId 就一只 hauler 都不出，地上的存货烂光',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const record = auditDropRecord(report, ROOMS);
        if (!seed || !seed.dropLost || !record) return { ok: false, why: 'auditSeed.dropLost 或 auditDrop 记录缺失' };
        const lost = record.containerLostHaul;
        return lost && lost.source === seed.dropLost.source ? { ok: true, detail: lost }
            : { ok: false, why: '丢了容器的源没有出维护 hauler: ' + JSON.stringify({ lost, sources: record.sources }) };
    },
});

EFFECTS.push({
    id: 'audit.minerPickupBuild', since: '2026-09-11',
    change: '外矿矿工站在容器工地上、脚下有掉落时同 tick 捡 + 建（pickup 与 build 不同管线）：2 WORK 从 2 进度/tick 提到 10',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const record = auditDropRecord(report, ROOMS);
        if (!seed || !seed.dropLost || !record) return { ok: false, why: 'auditSeed.dropLost 或 auditDrop 记录缺失' };
        const done = record.minerPickupBuild;
        const objects = auditObjects(report, ROOMS.auditDrop);
        const site = objects.find((o) => o.type === 'constructionSite' && at(seed.dropLost.spot)(o));
        const built = objects.find((o) => o.type === 'container' && at(seed.dropLost.spot)(o));
        const progressed = !!built || (site && Number(site.progress) > 1000);
        return done && done.n > 0 && progressed ? { ok: true, detail: { done, site: site && site.progress, built: !!built } }
            : { ok: false, why: '没有观察到同 tick 捡 + 建: ' + JSON.stringify({ done, site, built: !!built }) };
    },
});

EFFECTS.push({
    id: 'audit.remoteEntryTowardHome', since: '2026-09-11',
    change: '两跳外矿"朝母房的入口"按外矿房自己的出口取边（findRoute 从外矿出发）；以前套了邻房视角的 edgePosition，翻到背向母房的那条边',
    check(report, ROOMS) {
        const record = auditDropRecord(report, ROOMS);
        const entry = record && record.entry;
        // auditDrop 在 auditHome 的西南：朝母房的是东边 x=49（经 auditRemote）或北边 y=0（经 auditRich）；旧代码给西边 x=0 或南边 y=49
        const ok = !!entry && (entry.x === 49 || entry.y === 0);
        return ok ? { ok: true, detail: entry } : { ok: false, why: '入口不在朝母房的边上: ' + JSON.stringify(entry) };
    },
});

EFFECTS.push({
    id: 'audit.orphanRoadSitesPruned', since: '2026-09-11',
    change: '外矿名额被不在任何启用路线上的路工地占满时清掉它们（线上 W31S1/W31S2 各 6 个孤儿、W32S4 名下 12/12，路线上的工地放不出来）。2026-09-12 起修了一半的也清（止损：剩余成本会继续从每趟 50 的修路预算里抽走，去建一条 creep 不走的路）',
    check(report, ROOMS) {
        const seed = auditSeedOf(report, ROOMS);
        const home = auditMem(report, ROOMS)[ROOMS.auditHome] || {};
        const record = home.remotes && home.remotes[ROOMS.auditRemote];
        if (!seed || !seed.orphanPos || !record) return { ok: false, why: 'auditSeed.orphanPos 或 auditRemote 记录缺失' };
        const objects = auditObjects(report, ROOMS.auditRemote);
        const roadSite = (pos) => objects.find((o) => o.type === 'constructionSite' && o.structureType === 'road' && at(pos)(o));
        // "孤儿"按生产规则（remote.pruneOrphanRoadSites）算：所有母房的所有启用外矿，本房的 source.road 加上任何外矿经过本房的
        // routeRoads[本房]。只看 auditRemote 自己的路线会把别的外矿的过境路当孤儿——validation-VoKyKM 里 auditDrop 两跳的路线
        // 正好穿过三个播种的"孤儿"格，游戏正确地留下了它们，断言却判红
        const wanted = new Set();
        const homes = auditMem(report, ROOMS);
        for (const homeName of Object.keys(homes)) {
            const remotes = (homes[homeName] && homes[homeName].remotes) || {};
            for (const name of Object.keys(remotes)) {
                const other = remotes[name];
                if (!other || !other.enabled) continue;
                for (const source of other.sources || []) {
                    const packed = [source.routeRoads && source.routeRoads[ROOMS.auditRemote]];
                    if (name === ROOMS.auditRemote) packed.push(source.road);
                    for (const value of packed) for (const key of String(value || '').split(';')) if (key) wanted.add(key);
                }
            }
        }
        // 防同义反复：镜像生产规则之后，如果播种的零进度工地全落在启用路线上，"没有孤儿留下"就是平凡成立的。
        // 至少要有 ORPHAN_MIN 个真正不在任何启用路线上的，这条断言才是在观察清理行为（不够就是夹具前提不成立，判红）
        const ORPHAN_MIN = 3;
        const trulyOrphaned = seed.orphanPos.filter((pos) => !wanted.has(pos.x + '.' + pos.y));
        if (trulyOrphaned.length < ORPHAN_MIN) {
            return { ok: false, why: `夹具前提不成立：播种的 ${seed.orphanPos.length} 个零进度路工地只有 ${trulyOrphaned.length} 个不在任何启用路线上（至少要 ${ORPHAN_MIN}）: ` + JSON.stringify(trulyOrphaned) };
        }
        const left = trulyOrphaned.filter((pos) => { const site = roadSite(pos); return site && !(Number(site.progress) > 0); });
        // 有进度的那个孤儿有两种归宿，取决于谁先：被清掉（lost 记下丢掉的进度），或被路过的 hauler 顺手建完变成路
        // （nearbyInfrastructureWork 的 findInRange 不看是否在路线上）。所以既不能断言"它还在"（旧语义），
        // 也不能简单反转成"它没了"——那会在"先被建完"那一支误判。真正的不变量是：**它不能还以工地的形式挂着**。
        const keptSite = roadSite(seed.orphanKept);
        const keptRoad = objects.find((o) => o.type === 'road' && at(seed.orphanKept)(o));
        const pruned = record.orphanRoadSites;
        if (!pruned || !(pruned.n > 0)) return { ok: false, why: '名额被 6 个零进度孤儿占满却没有清: ' + JSON.stringify({ pruned, left }) };
        if (left.length) return { ok: false, why: '还有零进度孤儿没清: ' + JSON.stringify(left) };
        if (keptSite) return { ok: false, why: '有进度的孤儿还挂着工地（既没被清也没被建完）: ' + JSON.stringify({ pos: seed.orphanKept, progress: keptSite.progress, pruned }) };
        if (!keptRoad && !(pruned.lost > 0)) return { ok: false, why: '有进度的孤儿被清了却没记进 orphanRoadSites.lost: ' + JSON.stringify(pruned) };
        return { ok: true, detail: { pruned, builtInstead: !!keptRoad } };
    },
});

EFFECTS.push({
    id: 'haulStats.telemetry', since: '2026-09-12',
    change: 'src/haul_stats.js：运输型 creep 每 tick 按上一 tick 的位置/载货变化分类（空等/满等/空跑/载货行进/装卸/同 tick 挪位），按母房 × 角色累计进 Memory.haulStats',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
        const stats = memory && memory.haulStats;
        const bucket = stats && stats.v >= 1 && stats.rooms && stats.rooms[ROOMS.logistics] && stats.rooms[ROOMS.logistics].hauler;
        if (!bucket || !(bucket.t > 0)) return { ok: false, why: 'logistics 房没有 hauler 的饱和度计数: ' + JSON.stringify(stats && stats.rooms && stats.rooms[ROOMS.logistics]) };
        // 分类必须自洽：每个观察 tick 恰好落进 idle / 空跑 / 载货行进 / 取货 / 投递 之一；有搬运就一定有装与卸
        const parts = ['idle', 'mvE', 'mvL', 'ld', 'ul'].reduce((sum, key) => sum + (Number(bucket[key]) || 0), 0);
        const ok = parts === bucket.t && bucket.idle === bucket.idleE + bucket.idleL && bucket.in > 0 && bucket.out > 0 && bucket.cap > 0;
        if (!ok) return { ok: false, why: '计数不自洽: ' + JSON.stringify(bucket) };
        // v2（2026-09-12）：按动作钩子计的动作 tick、空闲按供给拆分（母房可见时三类之和 = idle）、房级补能期
        const room = stats.rooms[ROOMS.logistics]._room;
        const split = (Number(bucket.idSt) || 0) + (Number(bucket.idOv) || 0) + (Number(bucket.idWa) || 0);
        const v2 = stats.v === 2 && bucket.ac > 0 && split === bucket.idle && room && room.ticks > 0;
        return v2 ? { ok: true, detail: { t: bucket.t, ac: bucket.ac, acm: bucket.acm, split, room } } :
            { ok: false, why: 'v2 计数缺失或不自洽: ' + JSON.stringify({ v: stats.v, ac: bucket.ac, split, idle: bucket.idle, room }) };
    },
});

EFFECTS.push({
    id: 'hauler.actAndMove', since: '2026-09-12',
    change: 'roles/hauler：投递/取货成功的那一 tick 就挑下一站起步（引擎允许 transfer/withdraw/pickup 与 move 同 tick），以前每次动作都停一拍',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
        const bucket = memory && memory.haulStats && memory.haulStats.rooms && memory.haulStats.rooms[ROOMS.logistics] &&
            memory.haulStats.rooms[ROOMS.logistics].hauler;
        const acts = bucket ? (Number(bucket.ld) || 0) + (Number(bucket.ul) || 0) : 0;
        if (!bucket || acts < 20) return { ok: false, why: 'logistics 房 hauler 的装卸次数太少，无从判断: ' + JSON.stringify(bucket) };
        // 旧代码的装卸 tick 几乎从不同时挪位（fork 实测 5–6%，只有被别的 creep 推开时才会）；同 tick 起步后大多数装卸 tick 都在走
        const share = (Number(bucket.ch) || 0) / acts;
        return share >= 0.3 ? { ok: true, detail: { share, acts } } : { ok: false, why: '装卸同时挪位只占 ' + share.toFixed(2) + '（' + JSON.stringify(bucket) + '）' };
    },
});

EFFECTS.push({
    id: 'hauler.fillAtFedContainer', since: '2026-09-12',
    change: 'roles/hauler：没有值得跑的取货时去有矿工进账的源容器旁等满（按"进账 × 往返 > 载货"决定等还是走），不再揣着 100 能量来回跑',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.logistics] && memory.rooms[ROOMS.logistics].haulFill;
        if (!rec || !(rec.start > 0)) return { ok: false, why: 'logistics 房没有 hauler 进入补满: ' + JSON.stringify(rec) };
        return rec.left > 0 && rec.share >= 0.3 ? { ok: true, detail: rec } : { ok: false, why: '补满后没有带着像样的货离开: ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'upgrader.linkBeforeStorage', since: '2026-09-12',
    change: 'roles/upgrader：同时贴着 ctrl link 与 storage 时先喝 link（以前按 find 顺序可能一直喝 storage，ctrl link 满着堵死整条 link 链，源头产出全靠 hauler 手搬）；storage 站位里贴着已建成 link 的格排第一',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.linkDrink] && memory.rooms[ROOMS.linkDrink].upgraderDrink;
        return rec && rec.linkOverStorage > 0 ? { ok: true, detail: rec } :
            { ok: false, why: 'linkDrink 房的升级者从没在"link 与 storage 都取得到"时选 link: ' + JSON.stringify(rec) };
    },
});

// ---- 2026-09-12 core hauler 按 CARRY 定编（P3：spawn.estimateHomeHaulerTarget / coreHaulerCarry）----
EFFECTS.push({
    id: 'hauling.spawnSpend', since: '2026-09-12',
    change: 'spawn 孵化花费 EMA（Memory.rooms[房].spawnSpend）：本房 spawn 每开孵一只就记下身体成本、读数按 tick 衰减；hauler 模型的投递停靠份额 = 花费 / 产出，不再用只在补货时采样的 spawnIncome（实际花费的 1.4–3.4 倍，份额贴着 1）。remote 母房 W50N50 持续孵外矿 creep',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
        const room = memory && memory.rooms && memory.rooms[ROOMS.remoteHome];
        const track = room && room.spawnSpend;
        if (!track || !(Number(track.n) > 0) || !(Number(track.ema) > 0)) return { ok: false, why: '没有孵化花费记账（旧代码没有 spawnSpend）: ' + JSON.stringify(track) };
        const probe = roomProbe(report, ROOMS.remoteHome);
        const model = (probe && probe.haulModel) || room.haulModel;
        if (!model || model.spend == null || !(Number(model.production) > 0)) return { ok: false, why: 'haulModel 没记 spend 或没有源产出: ' + JSON.stringify(model) };
        const share = Math.min(1, Number(model.spend) / Number(model.production));
        return Math.abs(share - Number(model.spawnShare)) <= 0.011
            ? { ok: true, detail: { track, spend: model.spend, share: model.spawnShare } }
            : { ok: false, why: '停靠份额不是 花费 / 产出: ' + JSON.stringify(model) };
    },
});

EFFECTS.push({
    id: 'movement.pathRefreshOnRoads', since: '2026-09-12',
    change: 'movement：房间路网签名（道路数 / 障碍建筑）变了就让轮子丢掉该房的 costMatrix 与缓存路径（以前己方房在一个 global 里从不过期，新修的路 creep 看不见、烂掉的路还照走）',
    check(report, ROOMS) {
        // 维修场景（W61N60）会把让位出来的道路工地建成（maintenance.roadSiteYield）；其它场景房建路/拆建筑也算
        const hits = [];
        for (const memory of Object.values(report.rootMemories || {})) {
            for (const [name, room] of Object.entries((memory && memory.rooms) || {})) {
                if (room && room.pathRefresh && room.pathRefresh.n > 0 && room.pathRefresh.regen > 0) hits.push([name, room.pathRefresh.n, room.pathRefresh.regen]);
            }
        }
        // regen：可见房当场重建了 costMatrix（refreshRoom 补丁）——只删不建的话，重建之前算出的跨房路径对这个房只看地形
        return hits.length ? { ok: true, detail: hits } : { ok: false, why: '没有任何房在路网变化后重算过路径并重建 costMatrix（pathRefresh.regen）' };
    },
});

// ---- 外矿运输饱和（2026-09-12，roles/remoteHauler / feeder / courier / remote 编制）----
// 外矿 hauler 的母房：reserve* 三个场景（两跳外矿、开局在矿位旁的两只满配 hauler + 源 3000 的掉落 + 路工地）、remote、audit
function remoteHaulHomes(ROOMS) {
    return [ROOMS.reserveHome, ROOMS.reserveDeadlineHome, ROOMS.reserveBudgetHome, ROOMS.remoteHome, ROOMS.auditHome].filter(Boolean);
}
function homeRoomMemory(report, roomName) {
    const memory = report.rootMemories && report.rootMemories[roomName];
    return (memory && memory.rooms && memory.rooms[roomName]) || null;
}

EFFECTS.push({
    id: 'remoteHauler.actAndMove', since: '2026-09-12',
    change: 'roles/remoteHauler：取满（或按规则提前走）的那一 tick 就起步回家、每次投递同 tick 朝下一站或外矿走（引擎允许 transfer/withdraw/pickup 与 move 同 tick）；以前取货 / 投递那一 tick 从不移动',
    check(report, ROOMS) {
        // remoteHaulAct {ac, acm}：ac = 结束一次停靠的动作 tick（取满出发、每次投递；在容器旁涓流装货的 tick 不算），acm = 其中同 tick 发出了移动的。
        // 旧代码没有这份遥测；它的这类 tick 只有被别的 creep 推开时才会挪位
        let ac = 0;
        let acm = 0;
        const per = {};
        for (const name of remoteHaulHomes(ROOMS)) {
            const act = (homeRoomMemory(report, name) || {}).remoteHaulAct;
            if (!act) continue;
            ac += Number(act.ac) || 0;
            acm += Number(act.acm) || 0;
            per[name] = act;
        }
        if (ac < 10) return { ok: false, why: '外矿 hauler 结束停靠的动作 tick 太少（< 10），无从判断: ' + JSON.stringify(per) };
        const share = acm / ac;
        return share >= 0.3 ? { ok: true, detail: { share: Math.round(share * 100) / 100, ac, per } }
            : { ok: false, why: '结束停靠的动作 tick 里同 tick 起步只占 ' + share.toFixed(2) + ': ' + JSON.stringify(per) };
    },
});

EFFECTS.push({
    id: 'broker.ctrlLinkSkipAtStorageStation', since: '2026-09-12',
    change: 'task_broker：升级者站在 storage 旁且 storage 在底线 + 工作带以上时，不再把 storage 的能量搬进 ctrl link（升级者自己喝得到 storage，搬进去只会把 link 顶满、源 link 停发）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.linkDrink] && memory.rooms[ROOMS.linkDrink].ctrlLinkFeedSkip;
        return rec && rec.n > 0 ? { ok: true, detail: rec } : { ok: false, why: 'linkDrink 房（storage 5 万、storage 站位、ctrl link 被喝出空位）没有跳过 ctrl link 的富余回流: ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'remoteHauler.roadBuildMoves', since: '2026-09-12',
    change: 'roles/remoteHauler：回程在外矿房里修路工地的那一 tick 照走（build 与 move 不同管线），只有容器工地才站着建；以前修路时站着不动（每趟最多 10 tick）',
    check(report, ROOMS) {
        // reserve* 场景在每只开局 hauler 旁 1–2 格播了 600 进度的路工地：取满出发后第一 tick 就在射程内
        const seen = remoteHaulHomes(ROOMS).map((name) => ({ room: name, buildMove: Number(((homeRoomMemory(report, name) || {}).remoteHaul || {}).buildMove) || 0 }))
            .filter((entry) => entry.buildMove > 0);
        return seen.length ? { ok: true, detail: seen } : { ok: false, why: '没有观察到"修路同 tick 照走"（remoteHaul.buildMove）' };
    },
});

EFFECTS.push({
    id: 'hauler.hubBudgetedWithdraw', since: '2026-09-12',
    change: 'roles/hauler：hub 房从 storage 也只取还没人认领的消费者缺口（以前按满载取，多出来的揣满 100 tick 再退回 storage）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.links];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.links] && memory.rooms[ROOMS.links].hubBudgetedWithdraw;
        return rec && rec.n > 0 && rec.amount > 0 ? { ok: true, detail: rec } : { ok: false, why: 'links 场景（RCL7 hub）没有按缺口从 storage 取货: ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'remote.roadQuotaCountsOwnRemotesOnly', since: '2026-09-12',
    change: 'remote：母房的路工地配额只算自己在跑（enabled）的外矿。旧代码 homeRemoteRoadSites 只判房名在不在 remotes 里，别的母房仍启用的外矿工地会吃满我的配额，而 usedByAnotherHome 又不让我清它们——既建不了也清不掉（线上 W32S4 名下 13/12 超上限、8 个属于别的母房，自己的外矿再也放不出工地，全程无遥测）',
    check(report, ROOMS) {
        // 夹具在 roadTrailForeign 里播满 roadSitesPerHome 个本用户的路工地，并让本用户另一条记录在跑那个房。
        // 旧口径下这一个房就独占本母房全部配额 ⇒ budget 必为 0 ⇒ 自己的外矿一个工地都放不出来；新口径只数启用外矿 ⇒ 照常放。
        // 断言因此只看**结果**（自己的外矿有没有工地），不拿决策时刻的遥测快照去比结束态——后者正是 logistics 那族断言脆弱的原因。
        const home = homeRoomMemory(report, ROOMS.roadTrailHome);
        const record = home && home.remotes && home.remotes[ROOMS.roadTrailTarget];
        const quota = record && record.roadQuota;
        if (!quota) return { ok: false, why: '没有 roadQuota 遥测（配额被占满仍然是静默的）: ' + JSON.stringify(record && Object.keys(record)) };
        const roadSites = (roomName) => (auditObjects(report, roomName) || [])
            .filter((o) => o.type === 'constructionSite' && o.structureType === 'road').length;
        const foreign = roadSites(ROOMS.roadTrailForeign);
        if (!(foreign >= quota.cap)) {
            return { ok: false, why: '夹具没摆出"别人的工地独占旧配额"的前提（旧口径不会被饿死，断言证明不了什么）: ' +
                JSON.stringify({ foreignRoom: ROOMS.roadTrailForeign, foreign, quota }) };
        }
        if (!(quota.others >= quota.cap)) {
            return { ok: false, why: 'others 没把别人占着的工地算进去，遥测看不出配额被谁占着: ' + JSON.stringify({ quota, foreign }) };
        }
        const own = roadSites(ROOMS.roadTrailTarget);
        if (!(own > 0)) {
            return { ok: false, why: '别人的工地占满旧配额时，我自己的外矿仍然一个工地都没放出来（配额口径没改对）: ' +
                JSON.stringify({ quota, foreign, own }) };
        }
        return { ok: true, detail: { quota, foreign, own } };
    },
});

EFFECTS.push({
    id: 'remote.roadTrailReplan', since: '2026-09-12',
    change: 'remote/remoteHauler：规划的外矿路线没有车流时，按满载腿的真实走线改规划。旧代码路工地按规划路放、顺手修路只在满载 hauler 的 3 格射程内发生，规划路与实走走廊分叉的房里工地进度永远是 0（线上 W31S9 的 6 个工地挂了 1.45 万 tick，W31S7 0/19、W32S6 0/68、W31S1 0/22）',
    check(report, ROOMS) {
        // 夹具（fixtures seedReserveContinuity 的 roadTrail 变体）把规划路播在矿位以南 ≥ 12 格的空地上：
        // 母房在正北，满载腿一律往北走，那条假路线永远进不了 build 的 3 格射程。观察 bot 是否把它换成真实走线。
        const home = homeRoomMemory(report, ROOMS.roadTrailHome);
        const record = home && home.remotes && home.remotes[ROOMS.roadTrailTarget];
        // 遥测记在 source 上（与冷却 source.roadAdoptedAt 同粒度）：双源外矿两个源各自独立改，按 record 记会把
        // 两个源的事混成一条（2026-09-12 私服里就这样让断言拿 A 源的 lastTiles 去比 B 源的路）
        const source = (record.sources || []).find((item) => item && item.roadReplan);
        const replan = source && source.roadReplan;
        if (!replan) return { ok: false, why: '没有观察到 roadReplan（规划路一直没被替换）: ' + JSON.stringify(record && record.sources) };
        const tiles = String(source.road || '').split(';').filter(Boolean)
            .map((tile) => tile.split('.').map(Number));
        if (tiles.length < 3) return { ok: false, why: '采纳后的路线太短: ' + JSON.stringify(source.road) };
        // roadReplan 保留的是**首次**那条（remote.noteRoadTrail：后续只累计 n/lastAt），所以 was 永远是播种的 5 格；
        // 若哪天又被改成整体覆盖，这里会重新变成"改了两次就误报"的脆弱断言——那说明遥测语义退化了，该红
        if (replan.was !== 5) return { ok: false, why: '首次重规划的 was 不是播种的 5 格（遥测被后续覆盖了？）: ' + JSON.stringify(replan) };
        if (!replan.n) return { ok: false, why: '重规划遥测缺次数 n: ' + JSON.stringify(replan) };
        // 只校验首次那条：它才是"从播种的假路线换过来了"的证据。lastTiles 只当排查线索不参与校验——
        // 观察窗口比冷却长时这个源可能又改过，当前 road 属于最近一次，拿首次的 tiles 去比会误判
        if (replan.n === 1 && replan.tiles !== tiles.length) {
            return { ok: false, why: '首次重规划的 tiles 与当前路线长度对不上: ' + JSON.stringify(replan) + ' road=' + source.road };
        }
        // 采纳的必须是真走过的路：逐格相邻（creep 一 tick 一格走出来的），且至少有一格贴着矿位——
        // 播种的假路线离矿位 ≥ 12 格，光靠夹具摆不出这个结果
        const spot = source.spot || {};
        const contiguous = tiles.every((tile, index) => index === 0 ||
            Math.max(Math.abs(tile[0] - tiles[index - 1][0]), Math.abs(tile[1] - tiles[index - 1][1])) <= 1);
        const nearSpot = tiles.some((tile) => Math.max(Math.abs(tile[0] - spot.x), Math.abs(tile[1] - spot.y)) <= 2);
        if (!contiguous) return { ok: false, why: '采纳的路线不连续，不像是走出来的: ' + source.road };
        if (!nearSpot) return { ok: false, why: '采纳的路线没有一格贴着矿位（' + JSON.stringify(spot) + '）: ' + source.road };
        return { ok: true, detail: { replan, road: source.road, spot } };
    },
});

EFFECTS.push({
    id: 'remoteHauler.spotYield', since: '2026-09-12',
    change: 'roles/remoteHauler：站在矿位（矿工的容器格）上等货时让到相邻空格，等货点是贴着矿位而不是矿位本身；以前 hauler 停在容器格上、矿工进不去，容器零进账（线上 W32S1 4 只 hauler 零交付）',
    check(report, ROOMS) {
        // reserveContinuity 本体场景：一只 hauler 播在矿位（容器格，容器 100）上、矿工在旁边一格。让位（stepOff）之后它装着 > 100 的货出发
        // （yieldDepart / yieldLoad）——多出来的只能是矿工进了矿位、往容器里采的；旧代码它一直站在矿位上，没有这些事件
        const haul = (homeRoomMemory(report, ROOMS.reserveHome) || {}).remoteHaul || {};
        const ok = Number(haul.stepOff) >= 1 && Number(haul.yieldDepart) >= 1 && Number(haul.yieldLoad) > 100;
        return ok ? { ok: true, detail: { stepOff: haul.stepOff, yieldDepart: haul.yieldDepart, yieldLoad: haul.yieldLoad } }
            : { ok: false, why: '矿位上的 hauler 没有让位、或让位后容器没有进账（yieldLoad ≤ 播种的 100）: ' + JSON.stringify(haul) };
    },
});

EFFECTS.push({
    id: 'hauling.hubBaseRefill', since: '2026-09-12',
    change: 'hub 房（RCL7 store link 贴 storage + operator 站位）源产出为 0，旧模型运量 0、两只 hauler 只靠满配一半撑着；现在孵化花费从 storage 补给的那部分算成 storage 补给项（base），hauler 请求按它定尺寸。links 场景 E20S20',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.links];
        const room = memory && memory.rooms && memory.rooms[ROOMS.links];
        const size = room && room.haulerSize;
        if (!size) return { ok: false, why: 'links 房没有 core hauler 请求的尺寸记录' };
        return size.production === 0 && Number(size.base) > 0 && size.heads > 0
            ? { ok: true, detail: size }
            : { ok: false, why: 'hub 房的请求没有 storage 补给项（旧代码模型 0）: ' + JSON.stringify(size) };
    },
});

EFFECTS.push({
    id: 'remoteHauler.ttlRetire', since: '2026-09-12',
    change: 'roles/remoteHauler：卸空时寿命不够 去程 + 回程 + 20（实测腿长或路程估算）且替补已在计划里 / 外矿容器放得下这段空档，就去 spawn 回收退役；以前照样出发，老死在路上（带货的 tombstone 没人捡、回收退款归零）',
    check(report, ROOMS) {
        // reserveContinuity 本体场景在母房播了一只带 100 能量、寿命 150 的外矿 hauler（两跳外矿，修正后的路程 100+ 格）
        const ttl = (homeRoomMemory(report, ROOMS.reserveHome) || {}).remoteTtl || {};
        return Number(ttl.retire) >= 1 ? { ok: true, detail: ttl } : { ok: false, why: '寿命将尽的外矿 hauler 卸空后没有退役: ' + JSON.stringify(ttl) };
    },
});

EFFECTS.push({
    id: 'broker.spillHysteresis', since: '2026-09-12',
    change: 'task_broker：溢出按源判定并带滞回（进入 ≥ 90% 满 / 地上 ≥ 500，退出 < 60% 且地上 < 200），溢出源只放一只 hauler；以前整房开关、取一车就退出',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
        const room = memory && memory.rooms && memory.rooms[ROOMS.logistics];
        const flips = room ? Number(room.spillFlips) || 0 : 0;
        // logistics 的源容器播成 1800/2000：第一次重建任务池就进入溢出（至少 1 次切换）；有滞回时一场验证只该切换几次，
        // 没有滞回则每取一车切一次（1800 → 取 1000 → 退出 → 进账回到 1800 → 进入…）
        if (flips < 1) return { ok: false, why: 'logistics 房没有进入过溢出（源容器播成 90% 满）: ' + JSON.stringify(room && room.spill) };
        return flips <= 12 ? { ok: true, detail: { flips } } : { ok: false, why: '溢出状态切换 ' + flips + ' 次，滞回没起作用' };
    },
});

EFFECTS.push({
    id: 'hauling.tempHead', since: '2026-09-12',
    change: '临时编制：源容器 ≥ 90% 满（搬不过来）时 hauler 目标临时 +1、每只大小不变（不把临时需求做进身体，免得换代锁死成大身体）。remote 母房 W50N50 的两个源容器播成 2000 满仓',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.remoteHome];
        const room = memory && memory.rooms && memory.rooms[ROOMS.remoteHome];
        const temp = room && room.haulTemp;
        return temp && Number(temp.overflow) > 0
            ? { ok: true, detail: temp }
            : { ok: false, why: '满仓的源容器没有触发临时编制（旧代码没有 haulTemp）: ' + JSON.stringify(temp) };
    },
});

EFFECTS.push({
    id: 'upgrader.linkRelief', since: '2026-09-12',
    change: 'roles/upgrader：storage 站位全都不贴 ctrl link、link 堵在缓冲线以上时，派一只升级者空手时去 link 旁喝（以前 link 常年满着、源 link 停发，源头产出全靠 hauler 手搬）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.storageFed] && memory.rooms[ROOMS.storageFed].linkRelief;
        return rec && rec.n > 0 ? { ok: true, detail: rec } : { ok: false, why: 'storageFed 房（满 ctrl link 不贴站位格）没有派升级者去 link 旁: ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'upgrader.linkReliefInPlace', since: '2026-10-13',
    change: 'roles/upgrader：被派去 ctrl link 旁喝的升级者已经站在 link 旁时不再派位，交给常规补能就地取（身边是容器时 energySourceAt 选容器，旧代码照样派位、原地"移动"从不 withdraw，空手站到死；wip 768f2a1）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.linkInPlace] && memory.rooms[ROOMS.linkInPlace].linkReliefInPlace;
        if (!rec || !(rec.n > 0)) return { ok: false, why: 'linkInPlace 房（升级者空手站在 ctrl link 旁的容器上、link 800）没有记到"已在 link 旁不再派位": ' + JSON.stringify(rec) };
        // 结果面（2026-10-13 复审）：决策之后就地真的取到了能量（withdraw 返回 OK 才记）——只看 n 的话，卡住空手的升级者每 tick 都 n++，反而更"通过"
        if (!(Number(rec.drank) > 0)) return { ok: false, why: '判了"已在 link 旁"却一次都没就地取到能量（drank 0，仍是空手站着）: ' + JSON.stringify(rec) };
        // 卡住时 n 每 tick +1；正常时每次空手才判一次（取满后边升级边就地补，很少再空手）
        const span = Number(rec.at) - Number(rec.first) + 1;
        if (!(span > 0) || Number(rec.n) * 3 > span + 3) {
            return { ok: false, why: '"已在 link 旁"判得太频（像每 tick 都空手）: ' + JSON.stringify({ rec, span }) };
        }
        return { ok: true, detail: rec };
    },
});

EFFECTS.push({
    id: 'broker.drySourceNoInflow', since: '2026-09-12',
    change: 'task_broker：源采空（等再生）时源容器的"进账"按 0 算、到达量按源里还剩多少封顶；以前只看矿工 WORK，hauler 会揣着货守在永远不涨的容器边、在两格之间来回跳',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.logistics] && memory.rooms[ROOMS.logistics].haulInflowDry;
        return rec && rec.n > 0 ? { ok: true, detail: rec } :
            { ok: false, why: 'logistics 房（第二口源播成采空、矿工在岗）没有观察到"采空不算进账": ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'broker.farClaimIgnored', since: '2026-09-12',
    change: 'task_broker：还在别的房间的认领者（援建 hauler 在路上、按 50 格全额预留）不再挡住本房 hauler 竞价本房的任务，等它进了房再排队',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.aidHome];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.aidWeak] && memory.rooms[ROOMS.aidWeak].brokerFarClaims;
        return rec && rec.n > 0 ? { ok: true, detail: rec } :
            { ok: false, why: 'aid 弱房没有观察到"跨房认领者不参与本房排队"（母房播了一只 home 指向弱房的援建 hauler）: ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'hauler.mineralSalvage', since: '2026-09-12',
    change: 'roles/hauler：矿物掉落不再进取货池；身上已经混进矿物的先卸进 terminal/storage（以前捡了永远卸不掉，装满就一辈子停着，编制里还算一只）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const rec = memory && memory.rooms && memory.rooms[ROOMS.linkDrink] && memory.rooms[ROOMS.linkDrink].haulSalvage;
        return rec && rec.n > 0 ? { ok: true, detail: rec } :
            { ok: false, why: 'linkDrink 房播的"身上 200 K"的 hauler 没有把矿物卸掉: ' + JSON.stringify(rec) };
    },
});

EFFECTS.push({
    id: 'hauler.salvagePickup', since: '2026-09-12',
    change: 'roles/hauler：主动打捞入侵者阵亡掉的化合物（以前只有被动出口，没人去捡，tombstone 250 tick 后衰减成掉落全丢光）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.storageFed];
        const room = memory && memory.rooms && memory.rooms[ROOMS.linkDrink];
        const rec = room && room.salvaged;
        if (!rec || !(rec.n > 0) || !(rec.amount > 0)) {
            return { ok: false, why: 'linkDrink 房播的入侵者 tombstone（GO 95/KO 17/ZH 23/UH 11）没有被主动打捞: ' + JSON.stringify(rec) };
        }
        // 光"捡起来"不算：化合物要真的落进 storage/terminal，否则只是换个地方占容量。
        // 判据必须限定成 tombstone 播的这四种：同一个房里的 link-drink-salvage 身上带着 200 K，它走的是改动**之前**
        // 就存在的被动出口（salvageCargo，旧断言 hauler.mineralSalvage 要的正是那个行为）。只查"有没有任意非能量
        // 资源"的话这一半恒为真，跟新代码是否工作完全无关——夹具摆好了前提，断言却没验到真东西
        const seededTypes = ['GO', 'KO', 'ZH', 'UH'];
        const sinks = (report.salvageSink && report.salvageSink.sinks) || [];
        const landed = sinks.map((sink) => {
            const got = {};
            for (const key of seededTypes) if (Number((sink.store || {})[key]) > 0) got[key] = sink.store[key];
            return Object.keys(got).length ? got : null;
        }).filter(Boolean);
        return landed.length ? { ok: true, detail: { salvaged: rec, sink: landed, left: report.salvageSink } }
            : { ok: false, why: '打捞到了 ' + JSON.stringify(rec) + ' 但 storage/terminal 里没有 tombstone 播的 GO/KO/ZH/UH（K 不算，那是被动出口卸的）: ' + JSON.stringify(report.salvageSink) };
    },
});

EFFECTS.push({
    id: 'hauler.storageResidualRelease', since: '2026-09-12',
    change: 'roles/hauler：揣着的 storage 货只剩零头又没消费者时当场解锁（以前锁到 storageCargoRelease 100 tick，hauler 就在 storage 边上干等）',
    check(report, ROOMS) {
        const hits = [];
        for (const [probe, memory] of Object.entries(report.rootMemories || {})) {
            for (const [room, mem] of Object.entries((memory && memory.rooms) || {})) {
                const rec = mem && mem.haulCargoRelease;
                if (rec && rec.n > 0) hits.push({ probe, room, n: rec.n });
            }
        }
        return hits.length ? { ok: true, detail: hits } :
            { ok: false, why: '没有任何房观察到 storage 零头解锁（linkDrink 播了一只揣着 20 能量、货锁锁着的 hauler）' };
    },
});

EFFECTS.push({
    id: 'hauler.loadedSkipsStorage', since: '2026-09-12',
    change: 'roles/hauler：身上已有货的不再从 storage 补（storage 取货只为没人认领的消费者缺口；以前在源容器补满的 hauler 会被 storage 的富余取货拉走，揣着源头的货跑一趟又倒回去）',
    check(report, ROOMS) {
        const hits = [];
        for (const [probe, memory] of Object.entries(report.rootMemories || {})) {
            for (const [room, mem] of Object.entries((memory && memory.rooms) || {})) {
                const rec = mem && mem.haulLoadedStorageSkip;
                if (rec && rec.n > 0) hits.push({ probe, room, n: rec.n });
            }
        }
        return hits.length ? { ok: true, detail: hits } :
            { ok: false, why: '没有任何房观察到"载着货的 hauler 被挡在 storage 取货之外"' };
    },
});

EFFECTS.push({
    id: 'hauling.measuredSize', since: '2026-09-12',
    change: 'core hauler 实测定尺寸：haulStats 的送出/tick × 每趟忙碌 tick ÷ (50 × 0.75) 进 C* = max(模型, 实测, 补给爆发)，实测满一个窗口后每只可以低于满配一半（旧下限）。audit 场景给 auditHome 播了一个窗口的实测（8/tick、每趟 20 tick），之后真实 flush 的差分接着累进',
    check(report, ROOMS) {
        const rooms = auditMem(report, ROOMS);
        const seed = auditSeedOf(report, ROOMS) || {};
        const seeded = (seed.haulSeed && Number(seed.haulSeed.n)) || 0;
        const seen = [];
        for (const name of [ROOMS.auditHome, ROOMS.auditRich, ROOMS.auditLink, ROOMS.auditZero]) {
            const room = rooms[name] || {};
            const ctl = room.haulCtl;
            if (!ctl) continue;
            const below = (ctl.decisions || []).filter((d) => d && d.mode === 'measured' && Number(d.per) < Math.ceil(Number(d.full) * 0.5));
            const real = ctl.meas && Number(ctl.meas.n) > (name === (seed.haulSeed && seed.haulSeed.room) ? seeded : 0);
            seen.push({ room: name, below: below.length, n: ctl.meas && ctl.meas.n, emergency: !!(room.state && room.state.emergencyHarvest) });
            if (below.length && real && !(room.state && room.state.emergencyHarvest)) return { ok: true, detail: { room: name, decision: below[below.length - 1], meas: ctl.meas } };
        }
        return { ok: false, why: '没有按实测低于满配一半的定尺寸决策（或只有播下的窗口、没有真实 flush 进来，或房间进了 emergencyHarvest）: ' + JSON.stringify(seen) };
    },
});

EFFECTS.push({
    id: 'remote.measuredStops', since: '2026-09-12',
    change: 'remote.requiredCarryFor：外矿运输编制的投递停靠按卸货房实测（Memory.rooms[卸货房].remoteStop，remoteHauler 卸空时记，夹在 [1,10]、没数据按 10），周转 +4 → +2；槽位、补差槽、编制账、换代吞吐同一个函数',
    check(report, ROOMS) {
        const cap = Number((require(path.join(ROOT, 'src/config')).remote || {}).deliveryStopTicks) || 10;
        const seen = [];
        for (const name of remoteHaulHomes(ROOMS)) {
            const room = homeRoomMemory(report, name) || {};
            const stop = room.remoteStop;
            if (!stop || !(Number(stop.n) >= 1) || !Number.isFinite(Number(stop.ema))) continue;
            const stops = [];
            for (const record of Object.values(room.remotes || {})) {
                for (const source of (record && record.sources) || []) if (source && source.haulStops != null) stops.push(Number(source.haulStops));
            }
            seen.push({ room: name, stop, haulStops: stops });
            if (stops.some((value) => value >= 1 && value <= cap)) return { ok: true, detail: seen };
        }
        return { ok: false, why: '没有卸货房记下投递停靠实测、或编制没有报出它用的停靠: ' + JSON.stringify(seen) };
    },
});

EFFECTS.push({
    id: 'spawn.harvesterSpawningCovers', since: '2026-10-08',
    change: 'spawn.harvesterAssignmentStats 把孵化中的矿工算在它的源上：替补孵化期间另一只空闲 spawn 不再把源当成没人覆盖、成对孵同源矿工（线上 26 源 47 只 5W）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.minerPair];
        const room = memory && memory.rooms && memory.rooms[ROOMS.minerPair];
        const cover = room && room.harvesterSpawnCover;
        // 前提：源 1 的替补在孵、另一只 spawn 空闲（旧口径在这一刻会出第二只同源矿工的生存档请求）
        if (!cover || !(Number(cover.idle) >= 1) || !(Number(cover.n) >= 1)) {
            return { ok: false, why: '没有观察到"源只靠孵化中的矿工覆盖 + 空闲 spawn"（minerPair 源 1 矿工寿命 400 应在窗口中段换代）: ' + JSON.stringify(cover) };
        }
        const spawned = ((room && room.spawnLog) || []).filter((entry) => entry && /^core:harvester/.test(entry.key)).map((entry) => Number(entry.t)).sort((a, b) => a - b);
        for (let i = 1; i < spawned.length; i++) {
            if (spawned[i] - spawned[i - 1] <= 30) return { ok: false, why: '两只矿工在 ' + (spawned[i] - spawned[i - 1]) + ' tick 内先后孵出（成对）: ' + JSON.stringify(room.spawnLog) };
        }
        const perSource = {};
        for (const creep of creepsOf(report, ROOMS.minerPair)) {
            if (!creep || creep.role !== 'harvester' || creep.home !== ROOMS.minerPair) continue;
            const key = String(creep.sourceId != null ? creep.sourceId : creep.sourceIdx);
            perSource[key] = (perSource[key] || 0) + 1;
        }
        // 结束态才是判据（spawnLog 只留 10 条，成对的两条在报告前早被后续孵化挤掉）：源 1 寿命 400 的老矿工在报告时（约 770 tick）早已老死，
        // 两个源各一只满配 5W 就够采满 3000/300 tick，所以每源恰好 1 只；旧口径成对孵出的两只替补都还活着 → 源 1 有 2 只
        if (Object.values(perSource).some((n) => n > 1)) return { ok: false, why: '同源矿工超过 1 只（成对孵化的残留）: ' + JSON.stringify(perSource) };
        if (Object.keys(perSource).length < 2) return { ok: false, why: '结束时不是两个源各有矿工（换代没接上？）: ' + JSON.stringify(perSource) };
        return { ok: true, detail: { cover, spawned, perSource } };
    },
});

EFFECTS.push({
    id: 'harvester.batchTransfer', since: '2026-10-08',
    change: 'roles/harvester：仓里空位 < 2 次采集量才把能量整批交进 link/容器（5W1C 每 4 tick 交 40），省下 3/4 的 transfer intent；link-only 工位 link 满时装不下就不采',
    check(report, ROOMS) {
        const miners = creepsOf(report, ROOMS.minerPair).filter((creep) => creep && creep.role === 'harvester' && creep.home === ROOMS.minerPair);
        // xferBatch 是生涯最大单次交货量：终态 link/容器满时的小额补交不会把它拉低
        const batched = miners.filter((creep) => Number(creep.xferBatch) >= 20);
        // 旧行为：5W 每 tick 采 10、每 tick 交 10，交货量永远 ≤ 一次采集
        return batched.length ? { ok: true, detail: batched.map((creep) => creep.xferBatch) }
            : { ok: false, why: 'minerPair 的 link/容器矿工没有整批交货（xferBatch ≥ 20）: ' + JSON.stringify(miners.map((creep) => creep.xferBatch)) };
    },
});

function assertEffects(report, ROOMS, assert) {
    const results = [];
    for (const effect of EFFECTS) {
        let detail;
        try {
            detail = effect.check(report, ROOMS) || { ok: false, why: 'check 没有返回结果' };
        } catch (error) {
            detail = { ok: false, why: `check 抛错: ${error && error.message}` };
        }
        results.push({ id: effect.id, ok: !!detail.ok, why: detail.why || null });
        assert(detail.ok, `改动未观察到生效 [${effect.id}] ${effect.change}: ${detail.why}`);
    }
    return results;
}

EFFECTS.push({
    id: 'cpu.shedCritical', since: '2026-10-08',
    change: 'cpu_shed：bucket 吃紧（或 Memory.cpuShedForce）时 creep 循环压回 limit 以内、按价值跳可安全跳过的单位——旧护栏下 harvester/hauler/upgrader 一律照跑、其余分数几乎都 ≥ 20，线上 cpuBy 145–166 > 150 时 skippedCpu 全房 0',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.claimBlocked];
        const entries = ((memory && memory.stats) || []).map((entry) => entry && entry.shed).filter(Boolean);
        if (!entries.length) return { ok: false, why: 'claimBlocked 的 Memory.stats 没有 shed 遥测（旧代码不记）' };
        const sum = { ticks: 0, crit: 0, forced: 0, skip: 0, roles: {} };
        for (const shed of entries) {
            for (const key of ['ticks', 'crit', 'forced', 'skip']) sum[key] += Number(shed[key]) || 0;
            for (const [role, n] of Object.entries(shed.roles || {})) sum.roles[role] = (sum.roles[role] || 0) + (Number(n) || 0);
        }
        if (!(sum.forced > 0 && sum.crit > 0)) return { ok: false, why: '强制紧急降载没有生效: ' + JSON.stringify(sum) };
        if (!(sum.roles.scout > 0)) return { ok: false, why: 'scout 一次都没被跳: ' + JSON.stringify(sum) };
        if (sum.roles.claimer || sum.roles.harvester || sum.roles.defender) return { ok: false, why: '不可跳的单位被跳了: ' + JSON.stringify(sum.roles) };
        // 两只 hauler 每 tick 最多跳一只（最后一只能跑的永远执行）：跳过次数不超过降载 tick 数。
        // 不要求 hauler 一定被跳——spawn 回能后房里会起经济，hauler 忙起来就不是"空闲"，那是对的
        if ((sum.roles.hauler || 0) > sum.crit) return { ok: false, why: 'hauler 跳过次数超过紧急 tick 数（某 tick 两只都被跳）: ' + JSON.stringify(sum) };
        // 同一只最多连跳 maxConsecutive tick：scout 的跳过次数不超过紧急 tick 数的 2/3（取整余量 +1/窗口）
        if (sum.roles.scout > Math.ceil(sum.crit * 2 / 3) + entries.length) return { ok: false, why: 'scout 被连续跳太多 tick（会被饿死）: ' + JSON.stringify(sum) };
        return { ok: true, detail: sum };
    },
});

EFFECTS.push({
    id: 'cpu.tickLimitHardStop', since: '2026-10-08',
    change: 'creep 循环越过 tickLimit − endReserve 就不再跑任何 creep（永不跳的也停）、收尾照常：旧护栏从不看 tickLimit，bucket≈0 时永不跳的单位能把 tick 推过它，引擎掐掉整个 tick（全部意图作废）',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.claimBlocked];
        const entries = ((memory && memory.stats) || []).map((entry) => entry && entry.shed).filter(Boolean);
        const sum = { hard: 0, cut: 0, hardEnd: 0 };
        for (const shed of entries) for (const key of Object.keys(sum)) sum[key] += Number(shed[key]) || 0;
        // 夹具：Memory.cpuShedForce.stop = 0 持续开局 30 tick（私服的 tickLimit 是整个 bucket，碰不到）——那段时间 claimer 也不该跑
        if (!(sum.hard > 0)) return { ok: false, why: 'stats.shed 没有硬停记录（旧代码不看 tickLimit/不硬停）: ' + JSON.stringify(sum) };
        if (!(sum.cut >= sum.hard)) return { ok: false, why: '硬停 tick 里没砍掉任何 creep: ' + JSON.stringify(sum) };
        // digest 在 sampleStats（endTick 之前），采样 tick 的 hardEnd 落进下一个窗口：总和最多差 1
        if (!(sum.hardEnd >= sum.hard - 1 && sum.hardEnd > 0)) return { ok: false, why: '硬停后的收尾（movement.endTick）没跑完: ' + JSON.stringify(sum) };
        const log = memory && memory.cpuHardStop;
        if (!log || !(Number(log.n) >= 1) || !(Number(log.at) > 0)) return { ok: false, why: 'Memory.cpuHardStop 缺失: ' + JSON.stringify(log || null) };
        return { ok: true, detail: Object.assign(sum, { last: log }) };
    },
});

EFFECTS.push({
    id: 'cpu.pixelGate', since: '2026-10-08',
    change: '只在近期整 tick 用量均值 ≤ limit × pixel.maxCpuShare 时产 pixel：产完 bucket≈0，cpu_shed 当场进紧急模式，用量贴着 limit（线上 145–166/150）时就开始跳 creep',
    check(report, ROOMS) {
        const memory = report.rootMemories && report.rootMemories[ROOMS.claimBlocked];
        const log = memory && memory.pixelGate;
        // 夹具：bucket 播满、Memory.stats 播 5 条 150 的用量（limit 140）
        if (!log || !(Number(log.skip) >= 1)) return { ok: false, why: '桶满且近期用量高时没有记下放弃产 pixel（旧代码桶满就产）: ' + JSON.stringify(log || null) };
        if (!(Number(log.mean) > Number(log.line))) return { ok: false, why: '放弃时的均值没有高于闸门: ' + JSON.stringify(log) };
        return { ok: true, detail: log };
    },
});

// ---- CPU 微优化（2026-10-13，从 overmind-absorb 重做到当前 main）：看缓存命中与阶段计时的遥测，并核对缓存没把行为弄坏 ----
/** 某用户 Memory.stats 里某个字段的全部非空取值 */
function statsField(report, roomName, pick) {
    const memory = report.rootMemories && report.rootMemories[roomName];
    return ((memory && memory.stats) || []).map((entry) => entry && pick(entry)).filter((value) => value != null);
}

EFFECTS.push({
    id: 'cpu.sourceOrderCache', since: '2026-10-13',
    change: 'layout.resolveSources 每房每 tick 只解析一次：同一 tick 里每只矿工、spawn 四处、links、layout 都要它，每次 find + 排序 + Set 构造外加扫一遍本房 creep；副作用在 tick 内幂等，所以缓存不改变行为',
    check(report, ROOMS) {
        const windows = statsField(report, ROOMS.logistics, (entry) => entry.cache && entry.cache.srcOrder);
        if (!windows.length) return { ok: false, why: 'logistics 的 Memory.stats 没有 cache.srcOrder（旧代码不缓存也不记）' };
        const sum = [0, 0];
        for (const pair of windows) {
            if (!Array.isArray(pair) || pair.length !== 2) return { ok: false, why: 'cache.srcOrder 形状不对: ' + JSON.stringify(pair) };
            sum[0] += Number(pair[0]) || 0;
            sum[1] += Number(pair[1]) || 0;
        }
        if (!(sum[1] > 0)) return { ok: false, why: '一次都没命中（每只矿工每 tick 各调一次，应当大多命中）: ' + JSON.stringify(sum) };
        if (!(sum[1] < sum[0])) return { ok: false, why: '命中数不小于调用数（每房每 tick 至少要真算一次）: ' + JSON.stringify(sum) };
        // 缓存没吃掉副作用：源顺序仍写在母房 Memory，矿工的 sourceId 都落在上面
        const memory = report.rootMemories && report.rootMemories[ROOMS.logistics];
        const ids = memory && memory.rooms && memory.rooms[ROOMS.logistics] && memory.rooms[ROOMS.logistics].sources;
        if (!Array.isArray(ids) || !ids.length) return { ok: false, why: '母房 Memory 里没有源顺序（resolveSources 的写回被缓存吃掉？）' };
        const harvesters = creepsOf(report, ROOMS.logistics).filter((creep) => creep && creep.role === 'harvester' && creep.home === ROOMS.logistics);
        const stray = harvesters.filter((creep) => !creep.sourceId || ids.indexOf(creep.sourceId) < 0);
        if (!harvesters.length || stray.length) {
            return { ok: false, why: `矿工 ${harvesters.length} 只，sourceId 不在源顺序 ${JSON.stringify(ids)} 上的 ${stray.length} 只` };
        }
        return { ok: true, detail: { calls: sum[0], hits: sum[1], harvesters: harvesters.length } };
    },
});

EFFECTS.push({
    id: 'cpu.workTileCache', since: '2026-10-13',
    change: 'movement.isWorkTile 按 creep 每 tick 只算一次贵的那一半（找源/工位/lookForAt 容器与 link/升级者锚点）：轮子堵车解算为「挡路 creep × 8 个候选格」反复调它、broker 每只矿工/升级者再问一次；空载、满仓、外矿停用这些 tick 内会变的项仍逐次判定',
    check(report) {
        // 全部用户合计：哪个场景出现堵车解算由地形决定，不绑定单个房；每个用户的每个窗口各自核对口径
        const sum = [0, 0];
        let windows = 0;
        for (const key of Object.keys(report.rootMemories || {})) {
            for (const pair of statsField(report, key, (entry) => entry.cache && entry.cache.workTile)) {
                if (!Array.isArray(pair) || pair.length !== 2 || !(Number(pair[1]) <= Number(pair[0]))) {
                    return { ok: false, why: key + ' 的 cache.workTile 形状/口径不对（命中不能多于调用）: ' + JSON.stringify(pair) };
                }
                windows++;
                sum[0] += Number(pair[0]) || 0;
                sum[1] += Number(pair[1]) || 0;
            }
        }
        if (!windows) return { ok: false, why: '没有任何用户的 Memory.stats 带 cache.workTile（旧代码不缓存也不记）' };
        if (!(sum[0] > 0)) return { ok: false, why: '工位判定一次都没被调用（矿工/升级者都没跑？）: ' + JSON.stringify(sum) };
        if (!(sum[1] > 0)) return { ok: false, why: '工位判定一次都没命中缓存（每只每 tick 都重算）: ' + JSON.stringify(sum) };
        if (!(sum[1] < sum[0])) return { ok: false, why: '命中数不小于调用数（每只每 tick 至少要真算一次）: ' + JSON.stringify(sum) };
        return { ok: true, detail: { calls: sum[0], hits: sum[1], windows } };
    },
});

EFFECTS.push({
    id: 'cpu.spawnPhases', since: '2026-10-13',
    change: 'spawn 阶段级 CPU 计时（Memory.stats.cpuSpawn）：cpuBy 里 spawn 是前两大的一块（线上 2026-10-03 均值 42.6）但只有总数；按 pre/busy/quiet/counts/demands/backlog/targets/write/requests/schedule/exec 拆开，只在 cpuProfile.sampleEvery 的抽样 tick 量',
    check(report, ROOMS) {
        const entries = statsField(report, ROOMS.logistics, (entry) => entry.cpuSpawn);
        if (!entries.length) return { ok: false, why: 'logistics 的 Memory.stats 没有 cpuSpawn（旧代码不拆阶段）' };
        const known = ['pre', 'busy', 'quiet', 'counts', 'demands', 'backlog', 'targets', 'write', 'requests', 'schedule', 'exec'];
        const seen = {};
        for (const phases of entries) {
            for (const [key, value] of Object.entries(phases || {})) {
                if (known.indexOf(key) < 0 || !Number.isFinite(Number(value)) || Number(value) < 0) {
                    return { ok: false, why: 'cpuSpawn 有未知阶段或非法值: ' + JSON.stringify(phases) };
                }
                seen[key] = (seen[key] || 0) + Number(value);
            }
        }
        // 每次 run 都过 pre；之后要么全量推导（targets），要么走忙/安静的降频分支
        if (!(seen.pre > 0)) return { ok: false, why: '没有一个窗口记到 pre 阶段: ' + JSON.stringify(seen) };
        if (!(seen.targets > 0 || seen.busy > 0 || seen.quiet > 0)) return { ok: false, why: 'pre 之后的阶段一段都没记到: ' + JSON.stringify(seen) };
        return { ok: true, detail: seen };
    },
});

EFFECTS.push({
    id: 'cpu.dispatchPhases', since: '2026-10-13',
    change: 'creep 分发的阶段级 CPU 计时（Memory.stats.cpuDispatch：order/retire/start/run/finish，阶段抽样 tick 才量（复审后为每 30 tick 一次，见 cpu.dispatchSparse），每只 4 次读数连成一条链）；越过 creep 循环上限后不再逐只重问 getUsed（tickLimit 硬停照旧每只现读）',
    check(report, ROOMS) {
        const entries = statsField(report, ROOMS.logistics, (entry) => entry.cpuDispatch);
        if (!entries.length) return { ok: false, why: 'logistics 的 Memory.stats 没有 cpuDispatch（旧代码只有 cpuBy.creeps 总数）' };
        const known = ['order', 'retire', 'start', 'run', 'finish'];
        const seen = {};
        for (const phases of entries) {
            for (const [key, value] of Object.entries(phases || {})) {
                if (known.indexOf(key) < 0 || !Number.isFinite(Number(value)) || Number(value) < 0) {
                    return { ok: false, why: 'cpuDispatch 有未知阶段或非法值: ' + JSON.stringify(phases) };
                }
                seen[key] = (seen[key] || 0) + Number(value);
            }
        }
        // logistics 一直有矿工/hauler/升级者在跑：角色本身与 broker 起点必有耗时
        if (!(seen.run > 0 && seen.start > 0)) return { ok: false, why: 'run/start 阶段没记到: ' + JSON.stringify(seen) };
        // 角色级计时没被打点链弄坏
        const roles = statsField(report, ROOMS.logistics, (entry) => entry.cpuRoles).filter((value) => Object.keys(value || {}).length);
        if (!roles.length) return { ok: false, why: 'cpuRoles 全空（角色级计时被分发打点吃掉）' };
        return { ok: true, detail: seen };
    },
});

EFFECTS.push({
    id: 'cpu.dispatchSparse', since: '2026-10-13',
    change: 'creep 分发的阶段计时改成每 cpuProfile.dispatchEvery（30）tick 一次、降载中不量（复审发现：阶段链每只 4 次 getUsed，跟着角色计时每 5 tick 量一次，~215 只时常驻 +0.8 CPU/tick，账号已 180/160 超限）；其余角色抽样 tick 每只仍是 2 次读数',
    check(report, ROOMS) {
        const entries = statsField(report, ROOMS.logistics, (entry) => entry.cpuSampled);
        if (!entries.length) return { ok: false, why: 'logistics 的 Memory.stats 没有 cpuSampled（旧代码阶段计时跟角色计时同频）' };
        // 完整窗口（角色抽样 ≥ 6 tick = 30/5）：阶段只量 1 次；任何窗口阶段抽样都不超过角色抽样、也不超过 1 次
        const bad = entries.filter((pair) => !Array.isArray(pair) || !(Number(pair[1]) <= 1) || Number(pair[1]) > Number(pair[0]));
        if (bad.length) return { ok: false, why: '有窗口的分发阶段抽样超过 1 次或多于角色抽样: ' + JSON.stringify(bad.slice(0, 5)) };
        const full = entries.filter((pair) => Number(pair[0]) >= 6);
        if (!full.length) return { ok: false, why: '没有完整的 stats 窗口: ' + JSON.stringify(entries.slice(0, 5)) };
        if (!full.some((pair) => Number(pair[1]) === 1)) return { ok: false, why: '完整窗口里一次阶段抽样都没有（降载一直开着？）: ' + JSON.stringify(full.slice(0, 5)) };
        return { ok: true, detail: { windows: entries.length, full: full.length, sample: full[0] } };
    },
});

module.exports = { EFFECTS, assertEffects, creepsOf, roomProbe };
