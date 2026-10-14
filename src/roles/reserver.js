'use strict';

const movement = require('movement');
const remote = require('remote');
const expansion = require('expansion');
const retireMod = require('retire');
const { logErr } = require('utils');

function retreat(creep) {
    // 退役检查排在"先回母房"之前：retire.js 自己会走到全账号最近的 spawn（母房没有 spawn 时也不会在出口格来回踱步）
    // 外矿已停用（改派/不可达/被占）：去 spawn 回收退役，不再占编制发呆
    if ((remote.isDisabled(creep.memory.home, creep.memory.remoteRoom) || remote.isUnreachable(creep.memory.home, creep.memory.remoteRoom))) {
        retireMod.retireAtSpawn(creep);
        return;
    }
    // 停用剩余时间比寿命还长（打不过的入侵者要等到期）：回收退役，别在 spawn 旁挂机到死（线上 2026-09-05 W33S6 的 reserver）
    if (creep.ticksToLive != null && remote.suspensionLeft(creep.memory.home, creep.memory.remoteRoom) >= creep.ticksToLive) {
        retireMod.retireAtSpawn(creep);
        return;
    }
    const home = Game.rooms[creep.memory.home];
    if (!home || creep.room.name !== home.name) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 30 });
        return;
    }
    const anchor = home.storage || home.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 4)) movement.go(creep, anchor, { range: 4, reusePath: 25 });
}

/** 外矿变成母房的占领目标：reserver 和 claimer 用的都是 CLAIM 部件，就地 claim 省一只 650 的 claimer 和一趟路。
 *  必须排在"外矿停用就退役"之前：占领指令一来白名单就剔除该房，否则站在目标房里的 reserver 会先回家自杀
 *  （线上 2026-09-04 15:33 W33S8：reserver 退役的同时新孵 claimer 走同一条路）。占下即退役。 */
function claimDuty(creep) {
    const mem = Memory.rooms && Memory.rooms[creep.memory.home];
    const target = mem && mem.expansion && mem.expansion.target;
    if (!target || target !== creep.memory.remoteRoom) return false;
    if (creep.room.name !== target) {
        movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40 });
        return true;
    }
    const controller = creep.room.controller;
    if (!controller) return false;
    if (controller.my) {
        creep.suicide();
        return true;
    }
    if (controller.owner || expansion.gclHeadroom() <= 0) return false;
    const ret = creep.claimController(controller);
    if (ret === ERR_NOT_IN_RANGE) movement.go(creep, controller, { range: 1, reusePath: 25 });
    else if (ret === ERR_GCL_NOT_ENOUGH) logErr('reserver claim ' + target, new Error('GCL not enough'));
    return true;
}

function run(creep) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!homeName || !remoteRoom) return;
    if (claimDuty(creep)) return;
    const clearing = !!(remote.canClearReservation && remote.canClearReservation(homeName, remoteRoom));
    if (!clearing && remote.isSuspended(homeName, remoteRoom)) {
        retreat(creep);
        return;
    }
    if (creep.room.name !== remoteRoom) {
        if (remote.noteTravel(creep)) return;
        const record = remote.getRemote(homeName, remoteRoom);
        const pos = record && record.room === remoteRoom && record.controllerPos;
        const known = pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) &&
            pos.x >= 0 && pos.x < 50 && pos.y >= 0 && pos.y < 50;
        // Match the controller travel estimate instead of first detouring toward the room centre.
        const target = known ? new RoomPosition(pos.x, pos.y, remoteRoom) : new RoomPosition(25, 25, remoteRoom);
        movement.go(creep, target, { range: known ? 1 : 20, reusePath: 40 });
        return;
    }

    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);
    if (remote.canClearReservation && remote.canClearReservation(homeName, remoteRoom)) {
        const ctl = creep.room.controller;
        if (ctl && ctl.reservation && ctl.reservation.username === 'Invader') {
            const r = creep.attackController(ctl);
            if (r === ERR_NOT_IN_RANGE) movement.go(creep, ctl, { range: 1, reusePath: 25 });
            return;
        }
    }
    if (remote.isSuspended(homeName, remoteRoom)) {
        retreat(creep);
        return;
    }
    const controller = creep.room.controller;
    if (controller && controller.my) {
        // 外矿已是己方房间（刚占下）：预定无意义，直接退役，别走回家再等停用
        creep.suicide();
        return;
    }
    if (!controller || controller.owner) {
        retreat(creep);
        return;
    }
    const result = creep.reserveController(controller);
    if (result === ERR_NOT_IN_RANGE) movement.go(creep, controller, { range: 1, reusePath: 25 });
}

module.exports = { run };
