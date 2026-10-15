'use strict';
/** 10-16 战略猫：高威胁玩家回避（见 config.pvp）。外矿/deposit/远征 creep 在非己方房看到 Jumpp 或武装玩家 creep：立刻撤回母房，不还手 */
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
