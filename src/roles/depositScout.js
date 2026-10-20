'use strict';
const movement = require('movement');
const deposit = require('deposit');

function run(creep) {
    const cfg = deposit.settings();
    if (require('pvp').fleeHighThreat(creep)) return;
    if (!cfg.enabled) { creep.suicide(); return; }
    const m = creep.memory;
    if (deposit.isHighway(creep.room.name)) deposit.note(creep.room);
    if (!m.target || creep.room.name === m.target) {
        const list = deposit.patrolTargets(m.home, cfg).filter((n) => n !== creep.room.name);
        m.target = list[0] || null;
        if (!m.target) return;
    }
    movement.go(creep, new RoomPosition(25, 25, m.target), { range: 20, reusePath: 50 });
}

module.exports = { run };
