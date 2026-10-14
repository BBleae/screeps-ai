'use strict';
/**
 * 主循环：房间调度（spawn/布局/塔/link）+ creep 角色分发 + 内存维护 + 统计。
 * 错误兜底：任何异常进 Memory.errors（console API 可查），单点故障不拖垮整 tick。
 */
const config = require('config');
const utils = require('utils');
const movement = require('movement');
const wheelLayout = require('wheel_layout');
const visuals = require('visuals');
const logErr = utils.logErr;
const spawnMgr = require('spawn');
const retireMod = require('retire');
const aidMod = require('aid');
const spawnExit = require('spawn_exit');
const layout = require('layout');
const demolition = require('demolition');
require('soak_probe');   // 私服 soak 采样用的全局 soakProbe()，线上零开销
const tower = require('tower');
const links = require('links');
const remote = require('remote');
const brain = require('brain');
const defense = require('defense');
const expansion = require('expansion');
const conquest = require('conquest');
const industry = require('industry');
const terminalNetwork = require('terminal');
const market = require('market');
const taskBroker = require('task_broker');
const haulStats = require('haul_stats');
const cpuShed = require('cpu_shed');

const ROLES = {
    harvester: require('roles_harvester'),
    hauler: require('roles_hauler'),
    upgrader: require('roles_upgrader'),
    builder: require('roles_builder'),
    claimer: require('roles_claimer'),
    pioneer: require('roles_pioneer'),
    defender: require('roles_defender'),
    scout: require('roles_scout'),
    remoteMiner: require('roles_remoteMiner'),
    skReaper: require('roles_skReaper'),
    remoteHauler: require('roles_remoteHauler'),
    reserver: require('roles_reserver'),
    courier: require('roles_courier'),
    feeder: require('roles_feeder'),
    operator: require('roles_operator'),
    mineralMiner: require('roles_mineralMiner'),
    labTech: require('roles_labTech'),
    siegeDismantler: require('roles_siegeDismantler'),
    siegeGuard: require('roles_siegeGuard'),
    downgrader: require('roles_downgrader'),
};

function hasBodyPart(creep, type) {
    return (creep.body || []).some((part) => part.type === type && part.hits !== 0);
}

function roleLead(creep, role) {
    const base = config.spawnLead[role] || 0;
    const spawnTime = (creep.body || []).length * 3;
    return Math.max(base, spawnTime + 12);
}

function countReadyRole(room, role) {
    let n = 0;
    for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.home !== room.name || creep.memory.role !== role) continue;
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, role)) continue;
        n++;
    }
    return n;
}

function assessRoomState(room) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const sourceCount = Math.max(1, (mem.sources && mem.sources.length) || room.find(FIND_SOURCES).length || 1);
    const stableHarvesters = Math.min(sourceCount, config.recovery.stableHarvesters);
    const readyHarvesters = countReadyRole(room, 'harvester');
    let emergencyWorkers = 0;
    let readyWorkers = 0;
    for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.home !== room.name || creep.spawning) continue;
        if (!creep.room || creep.room.name !== room.name) continue;
        if (!hasBodyPart(creep, 'work')) continue;
        const ttl = creep.ticksToLive;
        const lead = roleLead(creep, creep.memory.role || 'harvester');
        if (ttl != null && ttl <= lead) continue;
        readyWorkers++;
        if (hasBodyPart(creep, 'carry')) emergencyWorkers++;
    }
    const recovering = readyHarvesters < stableHarvesters;
    const emergencyHarvest = readyHarvesters === 0 &&
        room.energyAvailable < config.recovery.emergencyHarvestBelow &&
        emergencyWorkers > 0;
    const state = {
        at: Game.time,
        sourceCount,
        stableHarvesters,
        readyHarvesters,
        readyWorkers,
        recovering,
        emergencyHarvest,
    };
    mem.state = state;
    return state;
}

function runEmergencyHarvest(creep, room) {
    if (!room) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 25 });
        return;
    }
    if (creep.room.name !== room.name) {
        movement.go(creep, new RoomPosition(25, 25, room.name), { reusePath: 25 });
        return;
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
        });
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, target, { reusePath: 15 });
            return;
        }
    }
    const source = creep.pos.findClosestByPath(FIND_SOURCES);
    if (!source) return;
    if (creep.pos.isNearTo(source.pos)) {
        creep.harvest(source);
    } else {
        movement.go(creep, source, { reusePath: 15 });
    }
}

// 部署版本标记：grunt file_append 注入 SCRIPT_VERSION，变更时在 console 提示
require('version');
if (!Memory.SCRIPT_VERSION || Memory.SCRIPT_VERSION !== SCRIPT_VERSION) {
    Memory.SCRIPT_VERSION = SCRIPT_VERSION;
    console.log('New code uploaded: ' + SCRIPT_VERSION);
}

module.exports.gcProbeKeys = gcProbeKeys;   // 单测用：gcMemory 只在 501 tick 边界跑，回归不该等 3000 tick
module.exports.pixelGate = pixelGate;
module.exports.sampleStats = sampleStats;   // 单测用：直接采一次样，不必跑整个 loop

// 已解析 Memory 跨 tick 复用。引擎每 tick 把 Memory 装成 getter，首次访问 JSON.parse
// 进 RawMemory._parsed，tick 末从 _parsed stringify 回去（driver runtime.js）。
// 连续 tick 且 isolate 还在时，删掉 getter、把上一 tick 的对象塞回去，跳过 parse。
// 线上实测约 364 KB / 2.755 CPU/tick。RawMemory.set() 会清掉 _parsed，代码里不能调用。
let lastMemory = null;
let lastMemoryTick = -1;
function reuseParsedMemory() {
    if (lastMemory && lastMemoryTick === Game.time - 1) {
        delete global.Memory;
        global.Memory = lastMemory;
        if (typeof RawMemory !== 'undefined' && RawMemory) RawMemory._parsed = lastMemory;
        lastMemory.memReuse = { hit: 1, n: (lastMemory.memReuse && lastMemory.memReuse.n || 0) + 1, at: Game.time };
    } else {
        void (Memory && Memory.creeps);
        lastMemory = (typeof RawMemory !== 'undefined' && RawMemory && RawMemory._parsed) || Memory;
        if (!lastMemory || typeof lastMemory !== 'object') {
            lastMemory = null;
            lastMemoryTick = Game.time;
            return;
        }
        lastMemory.memReuse = { hit: 0, n: (lastMemory.memReuse && lastMemory.memReuse.n) || 0, at: Game.time };
    }
    lastMemoryTick = Game.time;
}

module.exports.loop = function () {
    const spkT0 = Game.cpu.getUsed();
    spkTick = {}; spkRoom = {};
    reuseParsedMemory();
    // Memory 结构兜底（respawn/手动清空后 Memory 为空对象，缺一崩全 tick）
    Memory.creeps = Memory.creeps || {};
    Memory.rooms = Memory.rooms || {};
    Memory.map = Memory.map || {};
    Memory.errors = Memory.errors || [];

    let shed = null;   // creep 降载/硬停上下文：finally 里要知道这一 tick 有没有硬停
    try {
        cpuProf.ticks++;
        cpuStart();
        try { movement.beginTick(); } catch (e) { logErr('movement.beginTick', e); }
        cpuLap(cpuProf.mod, 'move.begin');
        try { taskBroker.beginTick(); } catch (e) { logErr('taskBroker.beginTick', e); }
        cpuLap(cpuProf.mod, 'broker.begin');
        try { brain.run(); } catch (e) { logErr('brain.run', e); }
        cpuLap(cpuProf.mod, 'brain');
        try { conquest.run(); } catch (e) { logErr('conquest.run', e); }
        cpuLap(cpuProf.mod, 'conquest');
        try { wheelLayout.autoPlannerByFlag(); } catch (e) { logErr('wheel layout flags', e); }
        cpuLap(cpuProf.mod, 'wheel');

        if (Game.time % 501 === 0) gcMemory();
        // 探针残渣（尤其 monitor.py 的 _mon，~260 KB 的 JSON 字符串）每 tick 被引擎序列化一遍：线上实测 stringify 它一项 10 CPU/tick。
        // 每 50 tick 查一次，内容 memoryProbeTtl tick 没变就删
        else if (Game.time % 50 === 0) { try { gcProbeKeys(); } catch (e) { logErr('gcProbeKeys', e); } }
        // 清理死亡 creep 的内存（defender 阵亡记进母房 defenseLog，再看到敌情前不续派）
        for (const name in Memory.creeps) {
            if (Game.creeps[name]) continue;
            try { defense.noteLoss(name, Memory.creeps[name]); } catch (e) { logErr('defense.noteLoss', e); }
            // SK 外矿的 reaper 被打死（不是寿终）：连着死就把这个 keeper 房停一阵（remote.noteReaperLoss，config.sk）
            try { remote.noteReaperLoss(name, Memory.creeps[name]); } catch (e) { logErr('remote.noteReaperLoss', e); }
            delete Memory.creeps[name];
        }

        // 可视化默认关（config.visuals）：诊断走 monitor/probe，不值得每 tick 花 ~10 CPU
        let drawVisuals = false;
        try { drawVisuals = visuals.enabled(); } catch (e) { logErr('visuals.enabled', e); }
        cpuLap(cpuProf.mod, 'memory');
        const sampleRoles = Game.time % ROLE_SAMPLE_EVERY === 0;
        if (sampleRoles) cpuProf.roleTicks++;
        for (const room of Object.values(Game.rooms)) {
            if (!room.controller || !room.controller.my) continue;
            // 房级计时要自己取起点：runRoom 内部的模块级打点会一路推进 cpuMark，
            // 直接 cpuLap 只量到「最后一个模块之后」的那一点点（线上第一版 cpuRooms 因此全是空的）
            const roomStart = Game.cpu.getUsed();
            try { runRoom(room); } catch (e) { logErr('room ' + room.name, e); }
            if (drawVisuals) { try { visuals.render(room); } catch (e) { logErr('visuals ' + room.name, e); } }
            const roomEnd = Game.cpu.getUsed();
            cpuProf.room[room.name] = (cpuProf.room[room.name] || 0) + (roomEnd - roomStart);
            spkRoom[room.name] = roomEnd - roomStart;
            cpuMark = roomEnd;
        }

        // creep 分发（CPU 预算保护，超限暂停低优先级单位）。bucket 健康时上限 limit − cpuReserve、只跳 broker 分数 < 20 的单位（旧行为）；
        // bucket 吃紧时 cpu_shed 把上限压回 limit 以内，并按价值跳"跳一 tick 也安全"的单位（矿工/最后一只 hauler/防御永不跳）
        try { shed = cpuShed.begin(); } catch (e) { logErr('cpuShed.begin', e); shed = { active: false, cap: Game.cpu.limit - config.cpuReserve }; }
        const cpuCap = shed.cap;
        // 分发的阶段级计时（Memory.stats.cpuDispatch）：cpuBy.creeps 是最大的一块，cpuRoles 加起来比它少一截，
        // 差出来的花在排序 / 退役与让路检查 / broker 起止的哪一段。每只 4 次读数：打点是一条链，上一只的 finish 读数就是下一只的起点；
        // 提前 continue 的退役/让路/跳过那点耗时落进下一只的 retire，本来也属于这一段。
        // 比角色计时更稀（cpuProfile.dispatchEvery，每个 stats 窗口一次，2026-10-13 复审）：角色抽样 tick 每只只读 2 次，
        // 阶段链要 4 次、被跳过的也要 1 次，215 只 × 2 次多出的读数每个角色抽样 tick 约 3.9 CPU；降载中也不量（那时每次读数都是从 creep 那里抢的）
        const sampleDisp = sampleRoles && Game.time % DISPATCH_EVERY === DISPATCH_PHASE && !shed.active;
        if (sampleDisp) cpuProf.dispTicks++;
        let mark = sampleDisp ? Game.cpu.getUsed() : 0;
        let creepQueue;
        try { creepQueue = taskBroker.orderCreeps(Object.values(Game.creeps)); }
        catch (e) { logErr('taskBroker.orderCreeps', e); creepQueue = Object.values(Game.creeps); }
        if (shed.active) {
            try { creepQueue = cpuShed.arrange(creepQueue, shed); } catch (e) { logErr('cpuShed.arrange', e); shed.active = false; }
        }
        if (sampleDisp) mark = dispLap('order', mark);
        // tick 内 getUsed 只增不减、cpuCap 不变：一旦越过上限就不必再逐只去问（语义不变，省掉越线之后每只可跳单位的一次读数）。
        // tickLimit 硬停（cpuShed.hardStopNow）不走这个短路，照旧每只现读
        let overBudget = false;
        // 尖峰角色分解（Memory.cpuSpikes[].roles）：常态每 SPK_PROBE 只读一次 getUsed（~215 只 ≈ 14 次），
        // 用量越过 SPK_ARM 之后这一 tick 剩下的 creep 逐只计时（每只 1 次读数，链式），尖峰 tick 才付这笔钱
        spkRoles = {}; spkArm = null;
        let spkHot = false, spkMark = 0, spkRan = 0;
        for (let qi = 0; qi < creepQueue.length; qi++) {
            const creep = creepQueue[qi];
            if (creep.spawning) continue;
            // tickLimit 硬停：再跑下去整个 tick 会被引擎掐掉（所有意图作废），剩下的这一 tick 都不跑，收尾照常
            if (shed.armed && cpuShed.hardStopNow(shed)) {
                let cut = 0;
                for (let rest = qi; rest < creepQueue.length; rest++) if (!creepQueue[rest].spawning) cut++;
                cpuShed.noteHardStop(shed, cut);
                break;
            }
            try {
                // 援建 creep 回不了弱房（没有安全路线）就标记退役，紧接着的 retireReplaced 接手回收（aid.markStranded）
                aidMod.markStranded(creep);
                if (spawnMgr.retireReplaced && spawnMgr.retireReplaced(creep)) continue;
                // 必需部件全阵亡的残废 creep（矿工没 WORK、hauler 没 CARRY…）：宽限后回收退役、编制立刻出替补（retire.retireCrippled）
                if (retireMod.retireCrippled(creep)) continue;
                // 困在出生口袋里的 creep（旧兜底孵进去的，spawn_exit.markPocketTrapped 标记）：贴着的 spawn 当场回收
                if (retireMod.retirePocketTrapped(creep)) continue;
            } catch (e) { logErr('creep retirement ' + creep.name, e); }
            // 出生口让路（spawn_exit.runVacate）：堵着 spawn 出口的 creep 先走开、离开后等到出生完成，这几 tick 不跑角色
            // （operator/feeder 的站位就是出口时，角色逻辑会立刻走回去）。放在 CPU 跳过之前：跳过它 spawn 就继续停工
            try {
                if (spawnExit.runVacate(creep)) { taskBroker.markSkipped(creep, 'vacate'); continue; }
            } catch (e) { logErr('spawnExit.runVacate ' + creep.name, e); }
            // 运输饱和度遥测：在 CPU 跳过之前观察，被跳过的 tick 如实记成 idle
            try { haulStats.observe(creep); } catch (e) { logErr('haulStats.observe ' + creep.name, e); }
            // 先问便宜的"能不能跳"，再取 getUsed：harvester/hauler/upgrader 等不可跳的单位不必每只都读一次 CPU
            const skippable = shed.active ? cpuShed.mayShed(creep, shed) : !taskBroker.shouldRun(creep);
            if (skippable && !overBudget) overBudget = Game.cpu.getUsed() > cpuCap;
            if (sampleDisp) mark = dispLap('retire', mark);
            if (skippable && overBudget) {
                if (shed.active) cpuShed.noteSkip(creep, shed);
                taskBroker.markSkipped(creep, 'cpu');
                continue;
            }
            const home = creep.memory.home && Game.rooms[creep.memory.home];
            const state = home && Memory.rooms[home.name] && Memory.rooms[home.name].state;
            let before = null;
            try { before = taskBroker.startCreep(creep); } catch (e) { logErr('taskBroker.startCreep ' + creep.name, e); }
            if (sampleDisp) mark = dispLap('start', mark);
            if (creep.memory.role !== 'mineralMiner' && state && state.emergencyHarvest && creep.room && creep.room.name === home.name &&
                hasBodyPart(creep, 'work') && hasBodyPart(creep, 'carry')) {
                try { runEmergencyHarvest(creep, home); } catch (e) { logErr('creep emergency ' + creep.name, e); }
                try { taskBroker.finishCreep(creep, before); } catch (e) { logErr('taskBroker.finishCreep ' + creep.name, e); }
                if (sampleDisp) mark = dispLap('run', mark);
                continue;
            }
            const role = ROLES[creep.memory.role];
            if (!role) {
                taskBroker.markSkipped(creep, 'unknown-role');
                continue;
            }
            // 角色级计时：creep 分发是最大的一块，但不知道花在哪个角色上。抽样 tick 才量（见 ROLE_SAMPLE_EVERY）。
            // 只量 role.run：阶段抽样 tick 的起点是 startCreep 之后那次读数，其余抽样 tick 在这里读一次（每只 2 次，与旧代码同价）
            if (sampleRoles && !sampleDisp) mark = Game.cpu.getUsed();
            if (!spkHot && !shed.active && Game.cpu.bucket >= SPK_MIN_BUCKET && (spkRan++) % SPK_PROBE === 0) {
                const u = Game.cpu.getUsed();
                if (u > SPK_ARM) { spkHot = true; spkMark = u; spkArm = { at: Math.round(u * 10) / 10, qi, of: creepQueue.length }; }
            }
            try { role.run(creep); } catch (e) { logErr('creep ' + creep.name, e); }
            if (spkHot) {
                const u = Game.cpu.getUsed(), rn = creep.memory.role;
                const e = spkRoles[rn] || (spkRoles[rn] = [0, 0]);
                e[0] += u - spkMark; e[1]++;
                spkMark = u;
            }
            if (sampleRoles) {
                const now = Game.cpu.getUsed();
                const roleName = creep.memory.role;
                cpuProf.role[roleName] = (cpuProf.role[roleName] || 0) + (now - mark);
                if (sampleDisp) cpuProf.disp.run = (cpuProf.disp.run || 0) + (now - mark);
                mark = now;
            }
            try { taskBroker.finishCreep(creep, before); } catch (e) { logErr('taskBroker.finishCreep ' + creep.name, e); }
            if (sampleDisp) mark = dispLap('finish', mark);
        }
        cpuLap(cpuProf.mod, 'creeps');
        // 市场与终端网络：卖富余矿物、跨房能量均衡（内部按 config.market / config.terminalNetwork 的 interval 降频、bucket < minBucket 不做）；
        // bucket 降载 / 硬停过的 tick 连调用和打点都省掉（降载时这一段的每次 getUsed 都是从 creep 那里抢来的）。
        // 市场在前：同一 terminal 一 tick 只能发一个意图，市场用过的 terminal 终端网络这 tick 不再用
        if (!(shed && (shed.active || shed.stopped))) {
            try { market.run(shed); } catch (e) { logErr('market.run', e); }
            try { terminalNetwork.run(shed); } catch (e) { logErr('terminal.run', e); }
            cpuLap(cpuProf.mod, 'terminal');
        }
        sampleStats();
        try { taskBroker.flush(); } catch (e) { logErr('taskBroker.flush', e); }
        try { haulStats.flush(); } catch (e) { logErr('haulStats.flush', e); }
        cpuLap(cpuProf.mod, 'broker.flush');
        // CPU 桶满（10000）时产出 1 pixel：消耗 bucket CPU，不占本 tick 预算；
        // 失败（无订阅/持有达上限）则降频 10k tick 重试，避免每 tick 空转调用。
        // 只在近期用量明显低于 limit 时才产（pixelGate）：产完 bucket≈0，cpu_shed 立刻进紧急模式，用量贴着 limit 时就会开始跳 creep
        if (Game.cpu.bucket >= 10000 && !(Memory.pixelRetry > Game.time)) {
            let gate = null;
            try { gate = pixelGate(); } catch (e) { logErr('pixelGate', e); }
            if (gate && !gate.ok) {
                // 遥测：放弃的产出机会（私服没有 generatePixel 也照记，生效断言 cpu.pixelGate 靠它观察闸门）
                const log = Memory.pixelGate || (Memory.pixelGate = { skip: 0 });
                log.skip = (Number(log.skip) || 0) + 1;
                log.at = Game.time;
                log.mean = gate.mean;
                log.line = gate.line;
                log.n = gate.n;
            } else if (gate && typeof Game.cpu.generatePixel === 'function') {
                if (Game.cpu.generatePixel() === OK) Memory.pixels = (Memory.pixels || 0) + 1;
                else Memory.pixelRetry = Game.time + 10000;
            }
        }
    } finally {
        try { movement.endTick(); } catch (e) { logErr('movement.endTick', e); }
        cpuLap(cpuProf.mod, 'move.end');
        if (shed && shed.stopped) { try { cpuShed.noteHardStopEnd(shed); } catch (e) { logErr('cpuShed.noteHardStopEnd', e); } }
        // cpu 字段过去在 sampleStats 里取，漏掉了 flush + endTick；改为整个 tick 收尾时回填
        if (pendingStat) { pendingStat.cpu = Math.round(Game.cpu.getUsed() * 10) / 10; pendingStat = null; }
        try { noteSpike(spkT0); } catch (e) { /* 诊断失败不影响主循环 */ }
    }
};

// ---- CPU 尖峰记录（诊断）：整 tick 用量 > SPIKE_LINE 时把这一 tick 的模块/房级分解存进 Memory.cpuSpikes（环形 30 条）----
const SPIKE_LINE = 150;
let spkTick = {}, spkRoom = {}, spkRoles = {}, spkArm = null;
// creep 循环里每 SPK_PROBE 只探一次用量；越过 SPK_ARM 起逐只计时（尖峰线 150 往下留余量，抓到尖峰前的那段爬升）
const SPK_PROBE = 16, SPK_ARM = 100, SPK_MIN_BUCKET = 5000; // 降载中 / bucket 吃紧不计时：那时每次读数都是从 creep 那里抢的
const spkBoot = Game.time;
function noteSpike(t0) {
    const used = Game.cpu.getUsed();
    if (used <= SPIKE_LINE) return;
    const r1 = (o, min) => { const out = {}; for (const k in o) if (o[k] >= min) out[k] = Math.round(o[k] * 10) / 10; return out; };
    const arr = Memory.cpuSpikes || (Memory.cpuSpikes = []);
    arr.push({ t: Game.time, cpu: Math.round(used * 10) / 10, t0: Math.round(t0 * 10) / 10, age: Game.time - spkBoot,
        b: Game.cpu.bucket, n: Object.keys(Game.creeps).length, m: r1(spkTick, 1), r: r1(spkRoom, 3), arm: spkArm, roles: spkRoleDigest() });
    if (arr.length > 30) arr.splice(0, arr.length - 30);
}

// 只留 ≥0.5 CPU 的角色：{ role: [cpu, 只数] }，按 CPU 降序
function spkRoleDigest() {
    const out = {};
    Object.keys(spkRoles).sort((a, b) => spkRoles[b][0] - spkRoles[a][0]).forEach(k => {
        const e = spkRoles[k]; if (e[0] >= 0.5) out[k] = [Math.round(e[0] * 10) / 10, e[1]];
    });
    return out;
}

function runRoom(room) {
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    assessRoomState(room);
    cpuLap(cpuProf.mod, 'assess');
    remote.run(room);
    cpuLap(cpuProf.mod, 'remote');
    try { expansion.run(room); } catch (e) { logErr('expansion.run ' + room.name, e); }
    cpuLap(cpuProf.mod, 'expansion');
    spawnMgr.run(room);
    cpuLap(cpuProf.mod, 'spawn');
    // 布局错峰执行（按房名 hash 取相位；曾用 charCodeAt(3)，那一位对所有房恒为 'S'/'N'，等于没错峰）
    if (utils.isRoomPhaseTick(room.name, config.layoutInterval)) { layout.run(room); cpuLap(cpuProf.mod, 'layout'); }
    try { demolition.run(room); } catch (e) { logErr('demolition.run ' + room.name, e); }
    cpuLap(cpuProf.mod, 'demolition');
    tower.run(room);
    links.run(room);
    cpuLap(cpuProf.mod, 'tower+links');
    if (room.controller.level >= 6 && utils.isRoomPhaseTick(room.name, 5)) { industry.run(room); cpuLap(cpuProf.mod, 'industry'); }
}

let pendingStat = null;

/** 产 pixel 的 CPU 闸门（config.pixel）：Memory.stats 最近 samples 条整 tick 用量的均值 ≤ limit × maxCpuShare 才放行。
 *  样本不足 minSamples（刚 respawn / Memory 清过）时不放行：没有证据就把 bucket 留作缓冲 */
function pixelGate() {
    const cfg = config.pixel || {};
    const want = Math.max(1, Math.floor(Number(cfg.samples) || 5));
    const stats = Array.isArray(Memory.stats) ? Memory.stats : [];
    const values = [];
    for (let i = stats.length - 1; i >= 0 && values.length < want; i--) {
        const cpu = stats[i] && Number(stats[i].cpu);
        if (Number.isFinite(cpu)) values.push(cpu);
    }
    const line = (Number(Game.cpu.limit) || 0) * (Number(cfg.maxCpuShare) || 0);
    const n = values.length;
    const mean = n ? Math.round(values.reduce((a, b) => a + b, 0) / n * 10) / 10 : null;
    const ok = n >= Math.max(1, Number(cfg.minSamples) || 1) && mean <= line;
    return { ok, mean, line: Math.round(line * 10) / 10, n };
}

function sampleStats() {
    if (Game.time % 30 !== 0) return;
    const rooms = Object.values(Game.rooms).filter((r) => r.controller && r.controller.my);
    if (!rooms.length) return;
    if (!Memory.stats) Memory.stats = [];
    // 过去这里只记 rooms[0]：一份任意挑中的房的 rcl/progress/storage，别的房在这条序列里根本不存在
    // （线上采到的就是 rcl 1 / prog 0 的新房，整条经济序列是死数据）。改为按房名记 [rcl, progress, storage]
    const byRoom = {};
    for (const r of rooms) {
        byRoom[r.name] = [r.controller.level, r.controller.progress, r.storage ? r.storage.store[RESOURCE_ENERGY] : 0];
    }
    const entry = {
        t: Game.time,
        rooms: byRoom,
        creeps: Object.keys(Game.creeps).length,
        cpu: Math.round(Game.cpu.getUsed() * 10) / 10,   // tick 收尾时会回填成含 flush/endTick 的完整值
        bucket: Game.cpu.bucket,
        cpuBy: cpuDigest(cpuProf.mod, cpuProf.ticks),
        cpuRooms: cpuDigest(cpuProf.room, cpuProf.ticks),
        cpuRoles: cpuDigest(cpuProf.role, cpuProf.roleTicks),
        // creep 分发（cpuBy.creeps）按阶段拆开：order 排序/降载重排、retire 退役与让路检查+能不能跳、start/finish broker 起止、run 角色本身。
        // 单项常常不到 cpuDigest 的 0.05 门槛，这里留到 0.001
        cpuDispatch: cpuDigest(cpuProf.disp, cpuProf.dispTicks, 0.001, 1000),
        // 窗口内的抽样 tick 数 [角色, 分发阶段]：阶段计时比角色计时稀（cpuProfile.dispatchEvery），生效断言 cpu.dispatchSparse 看它
        cpuSampled: [cpuProf.roleTicks, cpuProf.dispTicks],
        // bucket 降载遥测：窗口内 low/critical/强制的 tick 数、跳过次数与按角色分布（monitor 的 statsTail 直接带出）
        shed: cpuShed.digest(),
        // spawn 是 cpuBy 里前两大的一块，按阶段拆开（spawn.js 自己累计，抽样 tick 里全部房合计的每 tick 均值）
        cpuSpawn: spawnDigest(),
        // tick 内缓存的命中遥测（窗口内 [调用, 命中]）：srcOrder = layout.resolveSources 的每房每 tick 缓存，
        // workTile = movement.isWorkTile 的每 creep 每 tick 工位 spec（轮子堵车解算与 broker 反复问）
        cache: cacheDigest(),
    };
    cpuProf.mod = {};
    cpuProf.room = {};
    cpuProf.role = {};
    cpuProf.disp = {};
    cpuProf.dispTicks = 0;
    cpuProf.roleTicks = 0;
    cpuProf.ticks = 0;
    Memory.stats.push(entry);
    pendingStat = entry;
    if (Memory.stats.length > 80) Memory.stats.splice(0, Memory.stats.length - 80);
}

function spawnDigest() {
    try { return spawnMgr.cpuDigest(); } catch (e) { logErr('spawn.cpuDigest', e); return {}; }
}

// ---- tick 内缓存的命中遥测 ----
// 各模块只记进程内累计计数（global 重置时归零），这里按 sampleStats 窗口取差值；差值为负说明中间重置过，取当前值
const cacheSeen = {};
function cacheWindow(key, pair) {
    const prev = cacheSeen[key] || [0, 0];
    cacheSeen[key] = pair;
    if (pair[0] < prev[0] || pair[1] < prev[1]) return pair.slice();
    return [pair[0] - prev[0], pair[1] - prev[1]];
}
function cacheDigest() {
    const out = {};
    try {
        const src = layout.sourceOrderStats();
        out.srcOrder = cacheWindow('srcOrder', [Number(src.calls) || 0, Number(src.hits) || 0]);
    } catch (e) { logErr('cacheDigest srcOrder', e); }
    try {
        const move = movement.stats() || {};
        const calls = Number(move.workTileCalls) || 0;
        // 工位判定记的是 [调用, 重算]，换成 [调用, 命中] 与 srcOrder 同一口径
        out.workTile = cacheWindow('workTile', [calls, Math.max(0, calls - (Number(move.workTileComputes) || 0))]);
    } catch (e) { logErr('cacheDigest workTile', e); }
    return out;
}

// 游戏内自己在用的下划线键：不回收
const KEEP_UNDERSCORE = ['_gcSeen', '_visuals'];

/** 探针残渣回收：控制台探针把结果留在 Memory 的下划线键里（线上 _mon 78 KB、_roi 13 KB、_dbg2/_dq/_probe2
 *  几 KB，合计约 28% 的 Memory），读取方只删探针源不删结果，于是每 tick 都在解析/序列化早已死掉的数据。
 *  按"内容多久没变"回收：字符串比长度，对象只看在不在——探针写完几秒内就被读走，TTL 3000 tick 远够。 */
function gcProbeKeys() {
    const ttl = config.memoryProbeTtl;
    if (!(ttl > 0)) return;
    const seen = Memory._gcSeen || (Memory._gcSeen = {});
    for (const key of Object.keys(Memory)) {
        if (key.charCodeAt(0) !== 95 || KEEP_UNDERSCORE.indexOf(key) >= 0) continue;
        const value = Memory[key];
        const size = typeof value === 'string' ? value.length : -1;
        const entry = seen[key];
        if (!entry || entry.n !== size) { seen[key] = { t: Game.time, n: size }; continue; }
        if (Game.time - entry.t > ttl) { delete Memory[key]; delete seen[key]; }
    }
    for (const key of Object.keys(seen)) if (!(key in Memory)) delete seen[key];
}

// ---- 按模块 / 按房的 CPU 计时 ----
// 「真要定位热点需要按模块计时的遥测」——这条待办从 2026-09-06 记到现在，没有它任何 CPU 改动都只能靠猜。
// 成本是每 tick 二十几次 Game.cpu.getUsed()（各约 0.0002 CPU），窗口内累加，随 Memory.stats 每 30 tick 落一次。
// 角色级计时按 tick 抽样：每只 creep 每 tick 两次 getUsed()，132 只 ≈ 2.4 CPU/tick（上线实测 creeps 31.5 → 33.9）。
// 诊断不该占经济这么多，改成每 ROLE_SAMPLE_EVERY tick 量一次，均值按实际采样 tick 数还原（与 spawn 的 cpuSpawn 同一节奏）。
const ROLE_SAMPLE_EVERY = Math.max(1, Math.floor(Number((config.cpuProfile || {}).sampleEvery) || 5));
// 分发阶段计时每 DISPATCH_EVERY tick 一次，落在角色抽样 tick 上（相位取到 ROLE_SAMPLE_EVERY 的整数倍，避开 sampleStats 的 %30 那一 tick）
const DISPATCH_EVERY = Math.max(1, Math.floor(Number((config.cpuProfile || {}).dispatchEvery) || 30));
const DISPATCH_PHASE = Math.floor(DISPATCH_EVERY / 2 / ROLE_SAMPLE_EVERY) * ROLE_SAMPLE_EVERY;
const cpuProf = { mod: {}, room: {}, role: {}, disp: {}, ticks: 0, roleTicks: 0, dispTicks: 0 };
let cpuMark = 0;
function cpuStart() { cpuMark = Game.cpu.getUsed(); }
function cpuLap(bucket, label) {
    const now = Game.cpu.getUsed();
    bucket[label] = (bucket[label] || 0) + (now - cpuMark);
    if (bucket === cpuProf.mod) spkTick[label] = (spkTick[label] || 0) + (now - cpuMark);
    cpuMark = now;
}
/** 窗口内每 tick 的均值，默认只留 ≥ 0.05 CPU 的项（更小的落在计时噪声里），两位小数 */
function cpuDigest(bucket, ticks, min = 0.05, scale = 100) {
    const out = {};
    if (!(ticks > 0)) return out;
    for (const key of Object.keys(bucket)) {
        const avg = bucket[key] / ticks;
        if (avg >= min) out[key] = Math.round(avg * scale) / scale;
    }
    return out;
}
/** 分发阶段打点：把 since 到现在记进 cpuProf.disp[label]，返回新的起点 */
function dispLap(label, since) {
    const now = Game.cpu.getUsed();
    cpuProf.disp[label] = (cpuProf.disp[label] || 0) + (now - since);
    return now;
}

function gcMemory() {
    // 侦察数据老化（20k tick 后允许重探）
    if (Memory.map) {
        for (const k in Memory.map) {
            if (Game.time - (Memory.map[k].at || 0) > 20000) delete Memory.map[k];
        }
    }
    gcProbeKeys();
}
