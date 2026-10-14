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

    // 和平期的维修候选 / 伤员每房每 tick 只算一次（以前每座塔各扫一遍全房结构：一次 ~0.25 CPU，全账号 ~20 座塔）。
    // 候选列表放 heap 缓存 REPAIR_SCAN_TTL tick（结构掉血很慢），每 tick 只按 id 取回、用缓存的维修目标复核
    let injured;
    let repairList;
    for (const t of towers) {
        if (t.store[RESOURCE_ENERGY] <= 0) continue;
        if (hostiles.length) {
            // 先打攻击单位，否则打最近的
            const target = hostiles.find((h) => h.owner.username !== 'Source Keeper' && h.owner.username !== 'Invader' && h.getActiveBodyparts('heal') > 0) ||
                hostiles.sort((a, b) => a.hits - b.hits)[0];
            t.attack(target);
            continue;
        }
        // 和平期动作（治疗/维修）不得动用储备（见 git 历史：W33S8 塔在 490–510 抖动的事故），维修只花储备线以上的部分
        const towerReserve = Number(config.towerRepairReserve) || 500;
        const actionCost = typeof TOWER_ENERGY_COST !== 'undefined' ? TOWER_ENERGY_COST : 10;
        if (t.store[RESOURCE_ENERGY] - actionCost < towerReserve) continue;
        if (injured === undefined) injured = creepInjured(room);
        if (injured) { t.heal(injured); continue; }
        // 维修：按"离维修目标还剩几成"排序（utils.compareRepairTargets），射程内（≤ TOWER_FALLOFF_RANGE）优先，一个都没有才退回全局
        if (repairList === undefined) repairList = repairCandidates(room);
        if (!repairList.length) continue;
        const reach = typeof TOWER_FALLOFF_RANGE === 'number' ? TOWER_FALLOFF_RANGE : 20;
        const broken = repairList.find((s) => Math.max(Math.abs(s.pos.x - t.pos.x), Math.abs(s.pos.y - t.pos.y)) <= reach) || repairList[0];
        if (broken) t.repair(broken);
    }
}

const REPAIR_SCAN_TTL = 10;
const repairCache = {};
/** 本房按优先级排好序的维修目标（仍需维修的）。全房扫描每 REPAIR_SCAN_TTL tick 一次，中间按 id 复核血量 */
function repairCandidates(room) {
    let entry = repairCache[room.name];
    if (!entry || Game.time - entry.at >= REPAIR_SCAN_TTL || Game.time < entry.at) {
        const found = room.find(FIND_STRUCTURES, { filter: (s) => needsRepair(room, s) })
            .sort((a, b) => compareRepairTargets(room, a, b));
        entry = repairCache[room.name] = {
            at: Game.time,
            items: found.map((s) => ({ id: s.id, goal: s.structureType === STRUCTURE_RAMPART ? repairTargetHits(room, s) : s.hitsMax * config.towerRepairBelow })),
        };
    }
    const out = [];
    for (const item of entry.items) {
        const s = Game.getObjectById(item.id);
        if (s && s.hits < item.goal) out.push(s);
    }
    return out;
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

function resetCache() { for (const k of Object.keys(repairCache)) delete repairCache[k]; }

module.exports = { run, resetCache, towersCanHold, towerDamageAt, safeModeDecision, coreHurt };
