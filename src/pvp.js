'use strict';
const movement = require('movement');
const utils = require('utils');
const config = require('config');

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

const evadeCache = {};
function invaderThreats(room) {
    const hit = evadeCache[room.name];
    if (hit && hit.at === Game.time) return hit.list;
    const npc = room.find(FIND_HOSTILE_CREEPS, { filter: (h) => h.owner && h.owner.username === 'Invader' });
    const boosted = npc.some((h) => (h.body || []).some((p) => p.boost));
    const list = boosted ? npc.filter((h) => h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0 || h.getActiveBodyparts(WORK) > 0) : [];
    evadeCache[room.name] = { at: Game.time, list };
    return list;
}

const EVADE_SKIP = ['defender', 'siegeGuard', 'siegeDismantler', 'wallBreaker'];
function evadeInvaders(creep) {
    if (!creep.room || creep.spawning || EVADE_SKIP.indexOf(creep.memory.role) >= 0) return false;
    const cfg = (config.pvp && config.pvp.evade) || {};
    if (cfg.enabled === false) return false;
    const range = Number(cfg.range) || 4;
    const threats = invaderThreats(creep.room);
    if (!threats.length || !threats.some((h) => creep.pos.getRangeTo(h) <= range)) return false;
    const res = PathFinder.search(creep.pos, threats.map((h) => ({ pos: h.pos, range: range + 2 })), { flee: true, maxRooms: 1, maxOps: 2000 });
    if (res.path && res.path.length) creep.move(creep.pos.getDirectionTo(res.path[0]));
    const mem = Memory.rooms && (Memory.rooms[creep.room.name] || (Memory.rooms[creep.room.name] = {}));
    if (mem) {
        const prev = mem.evade || {};
        mem.evade = { at: Game.time, n: prev.at === Game.time ? prev.n + 1 : 1, total: (Number(prev.total) || 0) + 1, since: prev.since && Game.time - prev.at <= 50 ? prev.since : Game.time };
    }
    return true;
}

module.exports = { fleeHighThreat, evadeInvaders };
