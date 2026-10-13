'use strict';
/**
 * 攻占围降单位（downgrader）：去目标房控制器旁，控制器仍有主、未开盾时 attackController。
 *   引擎语义：每次攻击 −CONTROLLER_CLAIM_DOWNGRADE(300)×CLAIM 部件、控制器进入 1000 tick upgradeBlocked，
 *   期间对方既不能开 safe mode 也不能 upgrade 恢复；CLAIM 部件寿命仅 600 tick，需 conquest 模块接力补员。
 *   控制器降到无主（level 0）后本单位任务完成，退役回收。
 */
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
    // 无主：默认退役（占领交给 claimer）。suppress 时留下拆预定 / 堵在控制器旁防对方再占。
    if (!ctrl.owner) {
        if (!suppress && !enemyReserved) { creep.memory.retired = true; retireMod.retireAtSpawn(creep); return; }
        if (!creep.pos.inRangeTo(ctrl.pos, 1)) { movement.go(creep, ctrl, { range: 1, reusePath: 20 }); return; }
        if (enemyReserved) creep.attackController(ctrl);
        return;
    }
    if (!creep.pos.inRangeTo(ctrl.pos, 1)) { movement.go(creep, ctrl, { range: 1, reusePath: 20 }); return; }
    // safe mode 期间 attackController 无效（引擎 guard），原地等，不空攻
    if (ctrl.safeMode && ctrl.safeMode > 0) return;
    // upgradeBlocked 时返回 ERR_TIRED，引擎自身也是 no-op；直接调用即可
    creep.attackController(ctrl);
}

module.exports = { run };
