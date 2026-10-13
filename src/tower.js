'use strict';
/** 塔控制：优先攻击敌对 → 治疗伤员 → 修核心建筑（能量 ≥ config.towerRepairReserve 才维修，储备留给防御） */
const { findCached, needsRepair, repairTargetHits, compareRepairTargets } = require('utils');
const config = require('config');
const brain = require('brain');

function safeModeSettings() {
    return Object.assign({ decisionTtl: 600, fallbackCoreShare: 0.5, lastResortCoreShare: 0.3 }, config.safeMode || {});
}

/** 外置大脑的 safe mode 决定（scripts/brain/safemode.py 写在指令 rooms[房].safeMode）：过期（atTick 早于 decisionTtl）当没有 */
function safeModeDecision(room) {
    const decision = brain.get(room.name, 'safeMode', null);
    if (!decision || typeof decision !== 'object' || !decision.action) return null;
    const ttl = Math.max(1, Number(safeModeSettings().decisionTtl) || 600);
    if (decision.atTick != null && Game.time - Number(decision.atTick) > ttl) return null;
    return decision;
}

/** 核心建筑（spawn/塔/storage）有没有掉到 share 以下：游戏内开盾的最后手段只看这个 */
function coreHurt(room, share) {
    const core = room.find(FIND_MY_STRUCTURES, { filter: (s) =>
        s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_STORAGE });
    return core.some((s) => s.hitsMax && s.hits < s.hitsMax * share);
}

function bodySummary(creep) {
    const counts = {};
    for (const part of creep.body || []) {
        if (part.hits === 0) continue;
        const key = (part.type || part)[0].toUpperCase();
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.keys(counts).sort().map((key) => counts[key] + key).join('');
}

/** 开盾记录：defenseLog.safeMode = {at, by, hostiles: [[主人, 身体摘要, 血量]]}——事后能复盘是谁触发的 */
/** 开盾失败：记失败码（-4 ERR_BUSY = 别房占着，-11 ERR_TIRED = 冷却，-6 = 没次数），每 tick 覆盖 */
function noteSafeModeError(room, code, why) {
    const mem = Memory.rooms && (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    if (!mem) return;
    const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
    log.safeModeError = { at: Game.time, code, by: why };
}

function noteSafeMode(room, hostiles, why) {
    if (typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
    log.safeMode = { at: Game.time, by: why, hostiles: hostiles.slice(0, 6).map((h) => [h.owner && h.owner.username, bodySummary(h), h.hits]) };
    console.log('[tower] ' + room.name + ' safe mode (' + why + '): ' + JSON.stringify(log.safeMode.hostiles));
}

function run(room) {
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const dangerous = hostiles.some((hostile) =>
        hostile.getActiveBodyparts(ATTACK) > 0 ||
        hostile.getActiveBodyparts(RANGED_ATTACK) > 0 ||
        hostile.getActiveBodyparts(HEAL) > 0 ||
        hostile.getActiveBodyparts(WORK) > 0 ||
        hostile.getActiveBodyparts(CLAIM) > 0
    );
    const towers = room.controller.level >= 3
        ? findCached(room, FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER })
        : [];
    // 开不开盾由外置大脑决定；游戏内只在核心建筑真的掉血时兜底（无决定：fallbackCoreShare；大脑说 hold：lastResortCoreShare）。
    // 以前"有武装敌人且塔压不住就开"让 W31S8 为一只 NPC 入侵者烧掉 70000 tick 的开盾机会
    if (dangerous && !room.controller.safeMode && room.controller.safeModeAvailable > 0) {
        const decision = safeModeDecision(room);
        const settings = safeModeSettings();
        let why = null;
        if (decision && decision.action === 'activate') why = 'brain:' + (decision.reason || 'activate');
        else if (coreHurt(room, decision ? settings.lastResortCoreShare : settings.fallbackCoreShare)) why = (decision ? 'lastResort' : 'fallback') + ':core-hurt';
        if (why) {
            const ret = room.controller.activateSafeMode();
            if (ret === OK) noteSafeMode(room, hostiles, why);
            else noteSafeModeError(room, ret, why);   // ERR_BUSY：同一账号别的房还在 safe mode（2026-09-06 W31S5 vs W31S8）
        }
    }
    if (!towers.length) return;

    for (const t of towers) {
        if (t.store[RESOURCE_ENERGY] <= 0) continue;
        if (hostiles.length) {
            // 先打攻击单位，否则打最近的
            const target = hostiles.find((h) => h.owner.username !== 'Source Keeper' && h.owner.username !== 'Invader' && h.getActiveBodyparts('heal') > 0) ||
                hostiles.sort((a, b) => a.hits - b.hits)[0];
            t.attack(target);
            continue;
        }
        // 和平期动作（治疗/维修）不得动用储备：储备是留给防御的，一次动作 10 能量，动作后仍要 ≥ 储备。以前"≥ 储备就修"会修到 490，
        // broker 把 < 储备判成紧急压过 spawn/ext（线上 2026-09-06 W33S8：塔在 490–510 抖动，唯一的 hauler 满载喂塔、塔每 tick 烧 10，
        // spawn 32/1300、控制器容器 0、地上堆 6.5k），维修消耗只能花储备线以上的部分
        const towerReserve = Number(config.towerRepairReserve) || 500;
        const actionCost = typeof TOWER_ENERGY_COST !== 'undefined' ? TOWER_ENERGY_COST : 10;
        if (t.store[RESOURCE_ENERGY] - actionCost < towerReserve) continue;
        // 治疗
        const injured = creepInjured(room);
        if (injured) { t.heal(injured); continue; }
        // 维修（按"离维修目标还剩几成"排序，rampart 以 RCL 目标封顶，见 utils.repairTargetHits）。
        // 按绝对血量排会让道路永远压过容器：道路上限 5000、容器 250000，一条 2580/5000（52%）的路的绝对血量
        // 永远低于一个 62000/250000（25%）的容器，于是塔一辈子只修路，容器一路烂到消失
        // （线上 2026-09-07 W34S7：60 处破损里最低的四个全是 2580–2600 的道路，两个源容器同时从 77k 跌到 62k）。
        // builder.js 的 damagedStructure 早就是按比例排的，这里对齐它。
        // 射程内（≤ TOWER_FALLOFF_RANGE）优先：引擎里塔的维修量从射程 5 的 800 线性衰减到射程 20 的 200，
        // 射程外恒为 200（20 血/能量，比 builder 的 100 血/能量还差 5 倍）。全局按比例排序会让角落里的塔一直
        // 去修房间另一侧的路（线上 2026-09-09 W33S7：塔在 (6,40)/(7,41)，最低比例的几条路在 (41,33)/(45,31)/(48,29)），
        // 身边的危急路反而没人修。射程内一个都没有时才退回全局。
        const reach = typeof TOWER_FALLOFF_RANGE === 'number' ? TOWER_FALLOFF_RANGE : 20;
        const candidates = room.find(FIND_STRUCTURES, { filter: (s) => needsRepair(room, s) });
        const inReach = candidates.filter((s) => Math.max(Math.abs(s.pos.x - t.pos.x), Math.abs(s.pos.y - t.pos.y)) <= reach);
        const broken = (inReach.length ? inReach : candidates).sort((a, b) => compareRepairTargets(room, a, b))[0];
        if (broken) t.repair(broken);
    }
}

function towerDamageAt(tower, target) {
    // TOWER_POWER_ATTACK 600，距离 ≤5 全额，5..20 线性衰减到 25%
    const range = Math.max(Math.abs(tower.pos.x - target.pos.x), Math.abs(tower.pos.y - target.pos.y));
    if (range <= 5) return 600;
    if (range >= 20) return 150;
    return Math.floor(600 * (1 - 0.75 * (range - 5) / 15));
}

/**
 * 塔是否压得住：有塔且有能量，敌方治疗总量压不过塔对最强目标的伤害，且核心建筑没有掉血过半。
 * 压不住就该开 safe mode，而不是像以前那样"有塔就永远不开"。
 */
function towersCanHold(room, towers, hostiles) {
    const armed = towers.filter((t) => t.store[RESOURCE_ENERGY] >= 10);
    if (!armed.length) return false;
    // 只在有敌人时才走到这里，直接 find 不走缓存（findCached 按 find 类型缓存，不区分 filter）
    const core = room.find(FIND_MY_STRUCTURES, { filter: (s) =>
        s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_STORAGE });
    if (core.some((s) => s.hitsMax && s.hits < s.hitsMax * 0.5)) return false;
    let heal = 0;
    for (const hostile of hostiles) heal += hostile.getActiveBodyparts(HEAL) * 12;
    if (!heal) return true;
    const focus = hostiles.slice().sort((a, b) => b.getActiveBodyparts(HEAL) - a.getActiveBodyparts(HEAL))[0];
    let damage = 0;
    for (const tower of armed) damage += towerDamageAt(tower, focus);
    return heal < damage * 0.9;
}

function creepInjured(room) {
    return room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax }).sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0] || null;
}

module.exports = { run, towersCanHold, towerDamageAt, safeModeDecision, coreHurt };
