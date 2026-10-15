'use strict';
/** 过道 deposit 采集者（src/deposit.js）：自己采、自己送回母房 terminal。
 *  收工条件：deposit 不见了 / lastCooldown > maxCooldown / 房里有武装敌人 / 模块关了 / 寿命只够回程（ttl < 去程实测 + 30） */
const movement = require('movement');
const deposit = require('deposit');

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
    if (require('pvp').fleeHighThreat(creep)) return;   // 10-16：Jumpp/武装玩家 → 撤回母房
    const m = creep.memory;
    const info = Memory.deposits && Memory.deposits.list && Memory.deposits.list[m.depositId];
    const travel = m.travel || 150;
    if (!cfg.enabled || !info) m.done = true;
    if (!m.done && creep.ticksToLive < travel + 30) m.done = true;
    if (m.done || m.state === 'deliver') {
        goHome(creep);
        if (m.state === 'deliver' && creep.store.getUsedCapacity() === 0 && !m.done) m.state = 'harvest';
        return;
    }
    if (creep.room.name !== m.depositRoom) {
        movement.go(creep, new RoomPosition(info.x, info.y, m.depositRoom), { range: 1, reusePath: 50 });
        return;
    }
    if (m.travel == null) m.travel = 1500 - creep.ticksToLive - creep.body.length * 3;
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
