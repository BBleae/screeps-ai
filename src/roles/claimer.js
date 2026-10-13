'use strict';
/** 占领工：走到目标房 claim controller，占下即退役（spawn 工地由新房自己的轮子方案决定，见 expansion.run） */
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
        movement.noteKeeperTransit(creep);   // 遥测：记录穿 SK 房时到 lair 的最近距离（私服断言用）
        // 允许穿 SK 房（只避他人占领房）+ 保持离 keeper lair 距离，去 SK 环外的目标房（如 W37S5/W38S7）占领
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
