'use strict';
const movement = require('movement');
const deposit = require('deposit');
const TRAVEL_FIX_AT = 74450900;

function goHome(creep) {
    const home = Game.rooms[creep.memory.home];
    const terminal = home && home.terminal;
    if (!terminal) return;
    if (creep.store.getUsedCapacity() === 0) {
        if (creep.memory.done) creep.suicide();
        return;
    }
    for (const type in creep.store) {
        const r = creep.transfer(terminal, type);
        if (r === ERR_NOT_IN_RANGE) movement.go(creep, terminal, { range: 1, reusePath: 40 });
        return;
    }
}

function run(creep) {
    const cfg = deposit.settings();
    if (require('pvp').fleeHighThreat(creep)) return;
    const m = creep.memory;
    const info = Memory.deposits && Memory.deposits.list && Memory.deposits.list[m.depositId];
    const threat = info ? deposit.threatNear(m.depositRoom, cfg) : null;
    if (threat) {
        m.retreat = { at: Game.time, room: threat.room, why: threat.why };
        if (creep.store.getUsedCapacity() > 0) goHome(creep);
        else if (creep.room.name !== m.home) movement.go(creep, new RoomPosition(25, 25, m.home), { range: 20, reusePath: 20 });
        return;
    }
    const travel = m.travel || 150;
    if (!cfg.enabled || !info) m.done = true;
    if (!m.done && creep.ticksToLive < travel + (Number(cfg.returnMargin) || 50)) m.done = true;
    if (m.done || m.state === 'deliver') {
        goHome(creep);
        if (m.state === 'deliver' && creep.store.getUsedCapacity() === 0 && !m.done) m.state = 'harvest';
        return;
    }
    if (creep.room.name !== m.depositRoom) {
        movement.go(creep, new RoomPosition(info.x, info.y, m.depositRoom), { range: 1, reusePath: 50 });
        return;
    }
    const pl = Number(info && info.pathLen) || 0;
    if (m.travel == null) {
        const path = info && Number(info.pathLen);
        const measured = Math.max(0, 1500 - creep.ticksToLive);
        m.travel = path > 0 ? Math.max(path, measured) : Math.max(measured, Number(cfg.minTravel) || 80);
        m.travelAt = Game.time;
    } else if (!(m.travelAt >= TRAVEL_FIX_AT) || m.travel < pl) {
        m.travel = Math.max(m.travel, pl, Number(cfg.minTravel) || 80);
        m.travelAt = Game.time;
    }
    if (Game.time % 10 === 0) deposit.note(creep.room);
    const target = Game.getObjectById(m.depositId);
    const fresh = Memory.deposits.list[m.depositId];
    if (!target || !fresh || fresh.cd > cfg.maxCooldown || fresh.hostileUntil > Game.time) {
        m.done = true;
        goHome(creep);
        return;
    }
    if (creep.store.getFreeCapacity() < creep.getActiveBodyparts(WORK)) { m.state = 'deliver'; goHome(creep); return; }
    if (!creep.pos.isNearTo(target)) { movement.go(creep, target, { range: 1, reusePath: 20 }); return; }
    if (!(target.cooldown > 0)) creep.harvest(target);
}

module.exports = { run };
