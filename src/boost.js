'use strict';
/**
 * Boost 流水线（移植 overmind-absorb 79a5ee4 / 6dd5cbb，重建在当前 main 上）：出发前把 creep 送到装着化合物的 lab 旁强化。
 * 我们原本只会**读**敌人的 boost（defense.js 的战力公式），自己从来不上。
 *
 * 引擎规则（@screeps/common constants 与 engine/src/game/structures.js）：
 *   - 每个身体部件消耗 LAB_BOOST_MINERAL(30) 化合物 + LAB_BOOST_ENERGY(20) 能量
 *   - creep 必须与 lab **相邻**（range 1）
 *   - 孵化中 boost 已经被移除（2018 年的改动），只能对已出生的 creep 做
 *
 * 用法：给 creep 写 memory.boosts = ['XZH2O', …]（化合物列表；攻城 creep 由 conquest.demand 按指令的 boosts 或 config.conquest.boosts 写入，默认空 = 关闭）。
 * pending(creep) 说明还有做得到的强化没做完；apply(creep) 每 tick 推进一步，返回 true 表示调用方这一 tick 别走。
 * 三道保险，绝不让一队人卡在家里等永远不会来的化合物：
 *   1. 没有对应 lab、货或能量不够 ⇒ 这项算「做不到」，不 pending
 *   2. boostCreep 报 OK/不在射程以外的错（lab 未激活 ERR_RCL_NOT_ENOUGH 等）⇒ 这项记进 memory.boostSkip，不再试
 *   3. 从第一次 pending 起等满 config.conquest.boostMaxWait tick 还没做完 ⇒ memory.boostDone，整份清单放弃
 * 只在母房（memory.home）做：途经别的己方房不绕去它的 lab。
 */
const config = require('config');
const movement = require('movement');

const MINERAL_PER_PART = typeof LAB_BOOST_MINERAL !== 'undefined' ? LAB_BOOST_MINERAL : 30;
const ENERGY_PER_PART = typeof LAB_BOOST_ENERGY !== 'undefined' ? LAB_BOOST_ENERGY : 20;

function maxWait() {
    const value = Number((config.conquest || {}).boostMaxWait);
    return Number.isFinite(value) && value > 0 ? value : 100;
}

/** 这只 creep 还想要的化合物（已经上过的、试过做不了的不再要） */
function wanted(creep) {
    const mem = creep.memory || {};
    const list = Array.isArray(mem.boosts) ? mem.boosts : [];
    if (!list.length || mem.boostDone) return [];
    const applied = new Set((creep.body || []).map((part) => part.boost).filter(Boolean));
    const skipped = new Set(Array.isArray(mem.boostSkip) ? mem.boostSkip : []);
    return list.filter((compound) => !applied.has(compound) && !skipped.has(compound));
}

/** 这个化合物能强化的部件类型（BOOSTS 表反查） */
function partTypeFor(compound) {
    if (typeof BOOSTS === 'undefined' || !BOOSTS) return null;
    for (const partType of Object.keys(BOOSTS)) {
        if (BOOSTS[partType] && BOOSTS[partType][compound]) return partType;
    }
    return null;
}

/** 房里装着这个化合物、且货与能量都够强化 parts 个部件的 lab；industry 选的 boost lab（labRoles.boost）优先，
 *  免得从反应三连的输入 lab 里抽走下一批反应的原料 */
function labFor(room, compound, parts) {
    const need = Math.max(1, parts) * MINERAL_PER_PART;
    const needEnergy = Math.max(1, parts) * ENERGY_PER_PART;
    const labs = room.find(FIND_MY_STRUCTURES).filter((s) => s.structureType === STRUCTURE_LAB);
    const roles = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].labRoles;
    const preferred = roles && roles.boost;
    if (preferred) labs.sort((a, b) => (b.id === preferred) - (a.id === preferred));
    for (const lab of labs) {
        const store = lab.store;
        if (!store) continue;
        if (Number(store[compound] || 0) < need) continue;
        if (Number(store[RESOURCE_ENERGY] || 0) < needEnergy) continue;
        return lab;
    }
    return null;
}

/** 下一项做得到的强化：{ compound, partType, parts, lab }，没有就 null */
function nextJob(creep) {
    const room = creep.room;
    if (!room || !room.controller || !room.controller.my) return null;
    const home = creep.memory && creep.memory.home;
    if (home && room.name !== home) return null;
    for (const compound of wanted(creep)) {
        const partType = partTypeFor(compound);
        if (!partType) continue;
        const parts = (creep.body || []).filter((part) => part.type === partType && !part.boost).length;
        if (!parts) continue;
        const lab = labFor(room, compound, parts);
        if (lab) return { compound, partType, parts, lab };
    }
    return null;
}

/** 还有想要且**做得到**的强化没做完（做不到的项不算，免得整队卡在家里）；等满 boostMaxWait 就整份放弃 */
function pending(creep) {
    const mem = creep.memory || {};
    if (!Array.isArray(mem.boosts) || !mem.boosts.length || mem.boostDone) return false;
    if (!nextJob(creep)) return false;
    if (mem.boostSince == null) mem.boostSince = Game.time;
    if (Game.time - mem.boostSince >= maxWait()) {
        mem.boostDone = true;
        return false;
    }
    return true;
}

/** 记下一次成功的强化（母房 Memory，保留最近 10 条）：被强化的 creep 只活 1500 tick，身体上的 boost 字段随它一起消失，
 *  「这一批强化到底做没做成」事后只能查这里（监控与私服生效断言都读它） */
function noteBoost(creep, compound, partType, parts) {
    if (typeof Memory === 'undefined') return;
    const home = (creep.memory && creep.memory.home) || (creep.room && creep.room.name);
    if (!home) return;
    Memory.rooms = Memory.rooms || {};
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const log = Array.isArray(mem.boostLog) ? mem.boostLog : (mem.boostLog = []);
    log.unshift({ at: Game.time, creep: creep.name, role: creep.memory && creep.memory.role, compound, part: partType, parts, room: creep.room && creep.room.name });
    log.length = Math.min(log.length, 10);
}

/** 推进一步：走到 lab 旁 / 强化。返回 true 表示这一 tick 已经在做（走路或强化），调用方应原地别走 */
function apply(creep) {
    const job = nextJob(creep);
    if (!job) return false;
    const ret = job.lab.boostCreep(creep);
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, job.lab, { range: 1, reusePath: 10 }); return true; }
    if (ret === OK) { noteBoost(creep, job.compound, job.partType, job.parts); return true; }
    // 其它错误（lab 未激活、货刚被搬走…）：这项记成做不了，下一 tick 评估清单里的下一项，不再原地重试同一个
    const mem = creep.memory;
    mem.boostSkip = (Array.isArray(mem.boostSkip) ? mem.boostSkip : []).concat([job.compound]);
    return false;
}

/** 角色入口：清单里还有做得到的强化就推进一步并返回 true（调用方本 tick 直接 return） */
function run(creep) {
    if (!creep.memory || !Array.isArray(creep.memory.boosts) || !creep.memory.boosts.length) return false;
    if (!pending(creep)) return false;
    return apply(creep);
}

module.exports = { wanted, partTypeFor, labFor, nextJob, pending, apply, run, noteBoost, MINERAL_PER_PART, ENERGY_PER_PART };
