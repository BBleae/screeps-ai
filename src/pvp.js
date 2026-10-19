'use strict';
const movement = require('movement');
const utils = require('utils');

function fleeHighThreat(creep) {
    const room = creep.room;
    if (!room || (room.controller && room.controller.my)) return false;
    const threats = utils.notePvpThreat(room);
    if (!threats.length) return false;
    const home = creep.memory.home;
    const mem = Memory.pvpFlee || (Memory.pvpFlee = {});
    mem[room.name] = { at: Game.time, user: threats[0].owner.username, n: (Number(mem[room.name] && mem[room.name].n) || 0) + 1 };
    if (home && home !== room.name) movement.go(creep, new RoomPosition(25, 25, home), { range: 20, reusePath: 10 });
    else creep.moveTo(new RoomPosition(25, 25, room.name), { flee: false });
    return true;
}

module.exports = { fleeHighThreat };
