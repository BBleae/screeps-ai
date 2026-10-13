'use strict';
/** 专职短途搬运工：只在 storage 与控制器容器之间来回（storage 富余且控制器由容器供能的房，spawn.feederTarget 出编制）。
 *  取：storage；送：控制器容器（满了就在旁边等，不占容器格）。富余状态关闭（utils.storageRichState 滞回到 storageFeedBelow 以下）
 *  或 storage/容器没了：卸完手里的能量就退役回收（retire.retireAtSpawn），不占编制。
 *  同 tick 取送 + 起步（引擎允许 withdraw/transfer 与 move 同 tick，射程按 tick 开始时的位置算、store 下一 tick 才变）：
 *  取满的那一 tick 就朝控制器容器走，投空的那一 tick 就回 storage——以前每次取送都停一拍，2d+2 的往返白花 2 tick。
 *  不走 task broker：它的活只有这一条线，broker 的兜底规则（源容器优先）正是它要绕过的 */
const movement = require('movement');
const layout = require('layout');
const config = require('config');
const utils = require('utils');
const retireMod = require('retire');
const haulStats = require('haul_stats');

function ctrlContainer(room) {
    const plan = (Memory.rooms[room.name] || {}).plan;
    const spot = plan && plan.containers && plan.containers.ctrl;
    return spot ? layout.structureAt(room, spot.x, spot.y, STRUCTURE_CONTAINER) : null;
}

function energyOf(target) {
    return target && target.store ? Math.max(0, Number(target.store[RESOURCE_ENERGY]) || 0) : 0;
}

function freeOf(target) {
    return target && target.store && typeof target.store.getFreeCapacity === 'function' ?
        Math.max(0, Number(target.store.getFreeCapacity(RESOURCE_ENERGY)) || 0) : 0;
}

/** 位置齐全时自己查射程（mock 的 transfer/withdraw 不查）；位置不全返回 null，交给引擎返回码 */
function reach(creep, target) {
    const a = creep && creep.pos;
    const b = target && target.pos;
    if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return null;
    if (a.roomName && b.roomName && a.roomName !== b.roomName) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 20 }); return; }
    const storage = room.storage;
    const container = ctrlContainer(room);
    const rich = utils.storageRichState(room, Memory.rooms[room.name] || {}, config.upgrading || {});
    const energy = energyOf(creep);
    const carrying = energy > 0;
    if (!storage || storage.my === false || !container || (!rich && !carrying)) {
        retireMod.retireAtSpawn(creep);
        return;
    }
    if (carrying) {
        const free = freeOf(container);
        if (free <= 0) {
            haulStats.note(creep, 'full');
            if (!creep.pos.inRangeTo(container.pos, 2)) movement.go(creep, container, { range: 2, reusePath: 20 });
            return;
        }
        const range = reach(creep, container);
        if (range != null && range > 1) { movement.go(creep, container, { range: 1, reusePath: 20 }); return; }
        const sent = Math.min(energy, free);   // tick 开始时的数（引擎对 amount + 存量 > 容量直接 ERR_FULL）
        const ret = creep.transfer(container, RESOURCE_ENERGY, sent);
        if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, container, { range: 1, reusePath: 20 }); return; }
        // 投空的那一 tick 就回 storage；富余已经关了就不往回走（下一 tick 空手退役）
        if (ret === OK && energy - sent <= 0 && rich) movement.go(creep, storage, { range: 1, reusePath: 20 });
        return;
    }
    const range = reach(creep, storage);
    if (range != null && range > 1) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    const amount = Math.min(freeOf(creep), energyOf(storage));
    if (amount <= 0) return;
    const ret = creep.withdraw(storage, RESOURCE_ENERGY, amount);
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    // 取货的那一 tick 就朝控制器容器起步（容器满着就去 2 格内等，不占容器格）
    if (ret === OK) movement.go(creep, container, { range: freeOf(container) > 0 ? 1 : 2, reusePath: 20 });
}

module.exports = { run };
