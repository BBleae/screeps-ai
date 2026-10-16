'use strict';
/**
 * SK 房守卫杀手（skReaper，config.sk，默认关）：站在 keeper 远程射程边缘的自愈风筝手。
 *
 * 引擎里的 Source Keeper 已核对（@screeps/engine processor/intents/creeps/keepers/pretick.js）：
 *   - 身体 17 TOUGH + 13 MOVE + 10 ATTACK + 10 RANGED_ATTACK，5000 血，**没有 HEAL**；
 *   - AI 只走到「自己那口源/矿脉的 1 格内」然后不动——**不追人**；
 *   - 只打进射程的：range 1 = 300(近战) + 100(远程)，range 2–3 = 100，range ≥ 4 = 0；
 *   - lair 在 keeper 掉血或消失的那一刻把 nextSpawnTime 设成 300 tick 后。
 *
 * 所以不需要 boost、也不需要「近战 tank + 奶妈」双人组：n RANGED + n HEAL + 2n MOVE（remote.skReaperBody）站在 3 格外单挑——
 * 每 tick 挨 100、打 10n、自愈 12n，n ≥ 9 净回血。heal 不在动作冲突表里（src/actions.js），rangedAttack + 自愈同 tick 都生效。
 * 没有 keeper 时站到「下一个要孵化的 lair」3 格外，keeper 一出生就开火——争的是矿工的开工时间。
 * 在 SK 房里每 tick remote.observe：它是这个房的常驻视野，记录（lastSeen、容器、敌情）靠它刷新。
 */
const movement = require('movement');
const remote = require('remote');
const actions = require('actions');
const retireMod = require('retire');

/** 房里活着的 keeper */
function keepersIn(room) {
    if (!room) return [];
    return room.find(FIND_HOSTILE_CREEPS).filter((creep) => remote.isKeeper(creep));
}

/** 下一个要孵化的 lair（ticksToSpawn 最小的；都没排上就第一个） */
function nextLair(room) {
    if (!room) return null;
    const lairs = room.find(FIND_STRUCTURES).filter((structure) => structure.structureType === STRUCTURE_KEEPER_LAIR);
    let best = null;
    for (const lair of lairs) {
        if (lair.ticksToSpawn == null) continue;
        if (!best || lair.ticksToSpawn < best.ticksToSpawn) best = lair;
    }
    return best || lairs[0] || null;
}

function rangeBetween(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 站到 anchor 恰好 standoff 格处（已经在就不动）：贴脸多挨 300 近战，远了打不到 */
function holdStandoff(creep, anchorPos, standoff, reusePath) {
    if (rangeBetween(creep.pos, anchorPos) === standoff) return;
    const spot = remote.ringTile(creep.room, anchorPos, standoff, creep.pos);
    if (spot) movement.go(creep, spot, { range: 0, reusePath });
    else movement.go(creep, new RoomPosition(anchorPos.x, anchorPos.y, creep.room.name), { range: standoff, reusePath });
}

function heal(creep) {
    if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
        actions.note(creep, 'heal');
    }
}

/** 交战遥测记在外矿记录上（record.skReaper {first, at, shots, kills}）：私服断言与监控据此看 reaper 真的在打。
 *  击杀：上一 tick 打的那只 keeper 这一 tick 不见了，且它当时只剩不到两 tick 的伤害——lair 到点重生也会删掉旧 keeper，但那只满血 */
function noteCombat(creep, record, target, fired) {
    if (!record) return;
    const log = record.skReaper || (record.skReaper = { first: Game.time, shots: 0, kills: 0 });
    const last = creep.memory.skTarget;
    if (last && (!target || target.id !== last) && !Game.getObjectById(last) &&
        Number(creep.memory.skTargetHits) <= 2 * 10 * Math.max(1, creep.getActiveBodyparts ? creep.getActiveBodyparts(RANGED_ATTACK) : 1)) {
        log.kills = (Number(log.kills) || 0) + 1;
        log.lastKill = Game.time;
    }
    if (fired && target) {
        log.shots = (Number(log.shots) || 0) + 1;
        log.at = Game.time;
        creep.memory.skTarget = target.id;
        creep.memory.skTargetHits = target.hits;
    } else if (!target) {
        delete creep.memory.skTarget;
        delete creep.memory.skTargetHits;
    }
}

function run(creep) {
    const homeName = creep.memory.home;
    const targetRoom = creep.memory.remoteRoom;
    // 寿终 vs 被打死：main.js 清理内存时据此区分（remote.noteReaperLoss 只记被打死的）
    creep.memory.lastTtl = creep.ticksToLive;
    if (!homeName || !targetRoom || remote.isDisabled(homeName, targetRoom) || remote.isUnreachable(homeName, targetRoom)) {
        // 标成退役：外矿被停用/不可达时回收或自杀的 reaper 不是被 keeper 打死的，noteReaperLoss 不能把它记成阵亡
        creep.memory.retired = true;
        retireMod.retireAtSpawn(creep);
        return;
    }
    // 自愈永远先发
    heal(creep);
    // 10-17 验证模式：把本 tick 的血量/所在房/视野内 keeper 数记到 Memory.skReaperValidate（默认关，不改作战逻辑）
    if (creep.memory.validate) {
        const m = Memory.skReaperValidate || (Memory.skReaperValidate = {});
        const rec = m[targetRoom] || (m[targetRoom] = { name: creep.name, spawnedSeen: Game.time, minHits: creep.hits, kills: 0, shots: 0 });
        rec.at = Game.time; rec.room = creep.room.name; rec.hits = creep.hits; rec.hitsMax = creep.hitsMax;
        if (creep.hits < rec.minHits) rec.minHits = creep.hits;
        rec.keepers = creep.room.name === targetRoom ? keepersIn(creep.room).length : null;
    }

    // 10-17 硬规则：若同房有带 boosts 的 strongholdLoot 指令且全队未装齐，skReaper 也留在母房等待
    if (require('conquest').boostGateHold(targetRoom) && creep.room.name !== targetRoom) {
        if (homeName && creep.room.name !== homeName) movement.go(creep, new RoomPosition(25, 25, homeName), { range: 20, reusePath: 20 });
        return;
    }
    if (creep.room.name !== targetRoom) {
        if (remote.noteTravel(creep)) return;
        movement.go(creep, new RoomPosition(25, 25, targetRoom), { range: 20, reusePath: 40 });
        return;
    }
    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);

    const record = remote.getRemote(homeName, targetRoom);
    const standoff = Math.max(1, Number(remote.skSettings().reaperStandoff) || 3);
    const keepers = keepersIn(creep.room);
    if (keepers.length) {
        let target = null;
        let range = Infinity;
        for (const keeper of keepers) {
            const distance = rangeBetween(creep.pos, keeper.pos);
            if (distance < range) { target = keeper; range = distance; }
        }
        let fired = false;
        if (range <= 3) {
            fired = creep.rangedAttack(target) === OK;
            actions.note(creep, 'rangedAttack');
        }
        if (creep.memory.validate && fired) { const rec = Memory.skReaperValidate && Memory.skReaperValidate[targetRoom]; if (rec) rec.shots = (rec.shots || 0) + 1; }
        noteCombat(creep, record, target, fired);
        holdStandoff(creep, target.pos, standoff, 5);
        return;
    }
    noteCombat(creep, record, null, false);
    // 没有 keeper：守在下一个要孵化的 lair 的 standoff 格外
    const lair = nextLair(creep.room);
    if (lair) holdStandoff(creep, lair.pos, standoff, 10);
}

module.exports = { run, keepersIn, nextLair };
