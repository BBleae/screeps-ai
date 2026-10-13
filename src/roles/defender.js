'use strict';
/** 防守单位：去目标房，远程风筝或近战贴脸，清 InvaderCore；无敌情一段时间后走到最近的 spawn 回收退役 */
const movement = require('movement');
const defense = require('defense');
const remote = require('remote');
const retireMod = require('retire');
const actions = require('actions');
const { creepsHomeRole } = require('utils');

function range(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function closest(creep, list) {
    let best = null;
    let bestRange = Infinity;
    for (const item of list) {
        const r = range(creep.pos, item.pos);
        if (r < bestRange) { best = item; bestRange = r; }
    }
    return best;
}

function clamp(value) {
    return Math.max(1, Math.min(48, value));
}

function stepAway(creep, from) {
    const dx = Math.sign(creep.pos.x - from.pos.x) || 1;
    const dy = Math.sign(creep.pos.y - from.pos.y) || 0;
    const target = new RoomPosition(clamp(creep.pos.x + dx * 3), clamp(creep.pos.y + dy * 3), creep.room.name);
    movement.go(creep, target, { range: 0, reusePath: 3 });
}

function fightRanged(creep, hostiles) {
    const target = closest(creep, hostiles);
    const r = range(creep.pos, target.pos);
    // heal 不在任何管线的阻塞列表里，和 rangedAttack/rangedMassAttack 同 tick 白拿（引擎表见 src/actions.js）
    if (creep.hits < creep.hitsMax) { creep.heal(creep); actions.note(creep, 'heal'); }
    const inRange = hostiles.filter((h) => range(creep.pos, h.pos) <= 3);
    if (inRange.length >= 2) { creep.rangedMassAttack(); actions.note(creep, 'rangedMassAttack'); }
    else if (r <= 3) { creep.rangedAttack(target); actions.note(creep, 'rangedAttack'); }
    if (r < 3) stepAway(creep, target);
    else if (r > 3) movement.go(creep, target, { range: 3, reusePath: 5 });
}

function fightMelee(creep, hostiles) {
    const target = closest(creep, hostiles);
    // 近战：heal / rangedHeal 会把 attack 整个顶掉（引擎表 attack: [...,'rangedHeal','heal']），
    // 所以出手的这一 tick 不自疗——伤害是它存在的理由，自疗留给够不到目标的 tick
    const ret = creep.attack(target);
    if (ret === OK) actions.note(creep, 'attack');
    else if (ret === ERR_NOT_IN_RANGE) {
        movement.go(creep, target, { range: 1, reusePath: 5 });
        if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) { creep.heal(creep); actions.note(creep, 'heal'); }
    }
}

function hitStructure(creep, structure) {
    const ranged = creep.memory.style === 'ranged';
    const ret = ranged ? creep.rangedAttack(structure) : creep.attack(structure);
    if (ret === ERR_NOT_IN_RANGE) movement.go(creep, structure, { range: ranged ? 3 : 1, reusePath: 10 });
}

/** 主动退役：标记 retired（main.js 清理内存时不算阵亡，defense.noteLoss；squadMates 不再算它），然后走到最近的 spawn 回收 */
function retire(creep) {
    creep.memory.retired = true;
    retireMod.retireAtSpawn(creep);
}

/** 同一母房、同一目标房、没退役的 defender（含自己；孵化中的不算） */
function squadMates(creep) {
    const out = [];
    for (const other of creepsHomeRole(creep.memory.home, 'defender')) {
        if (other.memory.targetRoom !== creep.memory.targetRoom) continue;
        if (other.spawning || other.memory.retired) continue;
        out.push(other);
    }
    return out;
}

function remoteRecord(creep) {
    const mem = Memory.rooms && Memory.rooms[creep.memory.home];
    return (mem && mem.remotes && mem.remotes[creep.memory.targetRoom]) || null;
}

/** 进了目标房但队友还没到：守在入口附近不推进，射程内的敌人照打、受伤自疗 */
function holdPosition(creep, hostiles) {
    const target = closest(creep, hostiles);
    const r = range(creep.pos, target.pos);
    const wantHeal = creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0;
    if (creep.memory.style === 'ranged') {
        if (r <= 3) { creep.rangedAttack(target); actions.note(creep, 'rangedAttack'); }
        if (wantHeal) { creep.heal(creep); actions.note(creep, 'heal'); }   // heal 不挡 rangedAttack
        if (r < 3) stepAway(creep, target);
    } else if (r <= 1) {
        // 近战出手的 tick 不自疗：heal 会把 attack 顶掉（大脑可以下发带 HEAL 的近战身体）
        creep.attack(target);
        actions.note(creep, 'attack');
    } else if (wantHeal) {
        creep.heal(creep);
        actions.note(creep, 'heal');
    }
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 22, reusePath: 5 });
    }
}

function run(creep) {
    // 退役中：只管走到 spawn 回收，不再看目标房与敌情——否则会因为"不在目标房"又走回外矿，两房之间来回踱步到寿命结束
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    const target = creep.memory.targetRoom || creep.memory.home;
    if (!target) return;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);
    if (creep.room.name !== target) {
        // 成组出发：在家等到全组都孵出来再一起走（组员没齐时威胁已消失就退役），不再一只一只送
        if (squad > 1 && creep.room.name === creep.memory.home && !creep.memory.launched) {
            const mates = squadMates(creep);
            if (mates.length < squad) {
                // 母房现在已经不想为这房出兵（威胁消失 / 大脑改成 avoid / 组员阵亡后等新敌情）：组永远凑不齐，退役
                const home = Game.rooms[creep.memory.home];
                if (home && !defense.planFor(home, target)) { retire(creep); return; }
                const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
                if (anchor && !creep.pos.inRangeTo(anchor.pos, 3)) movement.go(creep, anchor.pos, { range: 3, reusePath: 20 });
                return;
            }
            creep.memory.launched = true;
        }
        movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40 });
        return;
    }
    // 外矿房：把看到的敌情写回外矿记录（画像 / 到期；清场后立刻解除停用）
    const record = remoteRecord(creep);
    if (record && creep.room.name !== creep.memory.home) {
        const home = Game.rooms[creep.memory.home];
        if (home) remote.observe(home, creep.room);
    }
    const hostiles = defense.armedHostiles(creep.room);
    const any = hostiles.length ? hostiles : creep.room.find(FIND_HOSTILE_CREEPS);
    if (any.length) {
        delete creep.memory.idleSince;
        if (squad > 1 && !creep.memory.engaged) {
            if (!creep.memory.arrivedAt) creep.memory.arrivedAt = Game.time;
            const here = squadMates(creep).filter((mate) => mate.room && mate.room.name === creep.room.name).length;
            if (here < squad && Game.time - creep.memory.arrivedAt < defense.settings().squadWait) {
                holdPosition(creep, any);
                return;
            }
            creep.memory.engaged = true;
        }
        if (creep.memory.style === 'ranged') fightRanged(creep, any);
        else fightMelee(creep, any);
        return;
    }
    const core = defense.invaderCore(creep.room);
    if (core) {
        delete creep.memory.idleSince;
        hitStructure(creep, core);
        return;
    }
    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) creep.heal(creep);
    // 站在出口格上不动会被引擎弹回邻房，下一 tick 又走回来——先走进房内再等
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        return;
    }
    // 清场：等一会儿看有没有后续，再去最近的 spawn 回收退役
    if (!creep.memory.idleSince) creep.memory.idleSince = Game.time;
    if (Game.time - creep.memory.idleSince < defense.settings().idleTicks) return;
    retire(creep);
}

module.exports = { run };
