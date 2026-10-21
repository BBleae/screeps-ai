'use strict';

const movement = require('movement');
const remote = require('remote');
const expansion = require('expansion');
const retireMod = require('retire');
const { logErr } = require('utils');

function retreat(creep) {
    if ((remote.isDisabled(creep.memory.home, creep.memory.remoteRoom) || remote.isUnreachable(creep.memory.home, creep.memory.remoteRoom))) {
        retireMod.retireAtSpawn(creep);
        return;
    }
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
    if (require('pvp').fleeHighThreat(creep)) return;
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
