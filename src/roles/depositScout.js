'use strict';
/** deposit 巡逻侦察（src/deposit.js）：1 MOVE，在母房 maxHops 内的过道房之间轮流看一眼，进房就记情报 */
const movement = require('movement');
const deposit = require('deposit');

function run(creep) {
    const cfg = deposit.settings();
    if (require('pvp').fleeHighThreat(creep)) return;   // 10-16：Jumpp/武装玩家 → 撤回母房
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
