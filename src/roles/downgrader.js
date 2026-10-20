'use strict';
const movement = require('movement');
const retireMod = require('retire');

function run(creep) {
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    const target = creep.memory.targetRoom;
    if (!target) return;
    if (creep.room.name !== target) {
        movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40 });
        return;
    }
    const ctrl = creep.room.controller;
    if (!ctrl) return;
    if (ctrl.my) { creep.memory.retired = true; retireMod.retireAtSpawn(creep); return; }
    const res = ctrl.reservation;
    const enemyReserved = !!(res && (res.username || res.user) && !res.my);
    const suppress = !!creep.memory.suppress;
    if (!ctrl.owner) {
        if (!suppress && !enemyReserved) { creep.memory.retired = true; retireMod.retireAtSpawn(creep); return; }
        if (!creep.pos.inRangeTo(ctrl.pos, 1)) { movement.go(creep, ctrl, { range: 1, reusePath: 20 }); return; }
        if (enemyReserved) creep.attackController(ctrl);
        return;
    }
    if (!creep.pos.inRangeTo(ctrl.pos, 1)) { movement.go(creep, ctrl, { range: 1, reusePath: 20 }); return; }
    if (ctrl.safeMode && ctrl.safeMode > 0) return;
    creep.attackController(ctrl);
}

module.exports = { run };
