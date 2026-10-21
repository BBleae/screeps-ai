'use strict';
const movement = require('movement');
const expansion = require('expansion');
const retire = require('retire');
const { logErr } = require('utils');

function run(creep) {
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
    const target = creep.memory.targetRoom;
    if (!target) return;
    if (creep.room.name !== target) {
        if (expansion.noteStuck(creep)) return;
        movement.noteKeeperTransit(creep);
        movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40,
            avoidRooms: movement.hostileTerritoryRooms(), costCallback: movement.keeperAvoidCallback() });
        return;
    }
    const controller = creep.room.controller;
    if (!controller) return;
    if (controller.my) {
        creep.suicide();
        return;
    }
    if (controller.owner) {
        logErr('claimer ' + target, new Error('controller owned by ' + controller.owner.username));
        creep.suicide();
        return;
    }
    const ret = creep.claimController(controller);
    if (ret === ERR_NOT_IN_RANGE) movement.go(creep, controller, { range: 1, reusePath: 25 });
    else if (ret === ERR_GCL_NOT_ENOUGH) logErr('claimer ' + target, new Error('GCL not enough'));
}

module.exports = { run };
