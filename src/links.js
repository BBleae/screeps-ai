'use strict';
/** link 物流：RCL5 ctrl+src0，RCL6 加 src1，RCL7 加 storage。controller 供给优先，富余才回库。
 *  store link 邻接 storage 时由 roles/operator 倒进仓库，hauler 不再搬已接入这条链的源。 */
const layout = require('layout');
const config = require('config');
const utils = require('utils');

function chebyshev(left, right) {
    if (!left || !right) return 99;
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function planOf(room, plan) {
    if (plan && plan.links) return plan;
    return ((typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room && room.name]) || {}).plan || plan || {};
}

function getLink(room, plan, key) {
    const spot = layout.linkSpot(plan, key);
    if (!spot) return null;
    const link = layout.structureAt(room, spot.x, spot.y, STRUCTURE_LINK);
    return link && link.my && (typeof link.isActive !== 'function' || link.isActive()) ? link : null;
}

/** 源旁的己方 link：规划位优先，否则源 1 格内任意己方 link */
function sourceLink(room, plan, source, index) {
    const spot = layout.linkSpot(plan, index === 1 ? 'src1' : 'src0');
    if (spot) {
        const planned = layout.structureAt(room, spot.x, spot.y, STRUCTURE_LINK);
        if (planned && planned.my) return planned;
    }
    if (!source || !source.pos || typeof room.find !== 'function') return null;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === STRUCTURE_LINK &&
        structure.my && chebyshev(structure.pos, source.pos) <= 1) || null;
}

/** RCL7 且 storage 旁有己方 store link（切比雪夫 ≤ 1）。没有这座接收端时源 link 的溢出仍要 hauler 搬。 */
function storeLinkReady(room, plan) {
    if (!room || !room.storage || room.storage.my === false || !room.storage.pos) return null;
    if (!room.controller || room.controller.level < 7) return null;
    const store = getLink(room, planOf(room, plan), 'store');
    if (!store || !store.my || chebyshev(store.pos, room.storage.pos) > 1) return null;
    return store;
}

function sourceFedToStore(room, plan, source, index) {
    if (!storeLinkReady(room, plan)) return false;
    // Only planned senders participate in run(); a nearby unplanned link is not a route.
    const link = getLink(room, planOf(room, plan), index === 1 ? 'src1' : 'src0');
    if (!link || !link.my) return false;
    if (!operatorStation(room, plan)) return false;
    const level = room.controller && room.controller.level || 0;
    return index === 0 || level >= 6;
}

function sourcesOf(room, plan) {
    const resolved = plan || planOf(room, plan);
    if (typeof layout.resolveSources === 'function') {
        const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || {};
        const list = layout.resolveSources(room, mem, resolved);
        if (list && list.length) return list;
    }
    return typeof room.find === 'function' ? room.find(FIND_SOURCES) || [] : [];
}

/** 每口源都经源 link 进 store link：hauler 只从 storage 取货补给基地 */
function hubHaulMode(room, plan, sources) {
    if (!storeLinkReady(room, plan)) return false;
    const list = sources && sources.length ? sources : sourcesOf(room, plan);
    if (!list.length) return false;
    for (let index = 0; index < list.length; index++) {
        if (!sourceFedToStore(room, plan, list[index], index)) return false;
    }
    return true;
}

function overflowFloor() {
    return Math.max(0, Number((config.hauling || {}).sourceLinkOverflow) || 1500);
}

/** 已接入 store 链的源容器：hauler 不取，除非存量 ≥ overflow（链路堵死时的保险） */
function skipSourceContainer(room, plan, structure) {
    if (!structure || !structure.pos || !storeLinkReady(room, plan)) return false;
    const energy = structure.store ? Number(structure.store[RESOURCE_ENERGY] || 0) : 0;
    if (energy >= overflowFloor()) return false;
    const resolved = planOf(room, plan);
    const containers = resolved.containers || {};
    for (const key of ['src0', 'src1']) {
        const spot = containers[key];
        if (!spot || spot.x !== structure.pos.x || spot.y !== structure.pos.y) continue;
        return sourceFedToStore(room, resolved, null, key === 'src1' ? 1 : 0);
    }
    const list = sourcesOf(room, resolved);
    for (let index = 0; index < list.length; index++) {
        const source = list[index];
        if (!source || !source.pos || chebyshev(source.pos, structure.pos) > 1) continue;
        if (sourceFedToStore(room, resolved, source, index)) return true;
    }
    return false;
}

function skipLinkedDrop(room, plan, drop) {
    // Dropped energy cannot enter a link by itself. Salvage it before decay,
    // including during operator replacement or a full storage interruption.
    return false;
}

/** store 与 ctrl 是同一座 link 时留下升级缓冲，否则倒空 */
function operatorKeepEnergy(room, plan, store) {
    const ctrl = getLink(room, planOf(room, plan), 'ctrl');
    if (ctrl && store && ctrl.id === store.id) return Math.max(0, Number(config.linkKeepAt) || 0);
    return Math.max(0, Number((config.hauling || {}).operatorKeep) || 0);
}

/** 同时邻接 storage 与 store link 的可行走格；避开升级者的 storage 站位 */
function operatorStation(room, plan) {
    const storage = room && room.storage;
    const store = storeLinkReady(room, plan);
    if (!storage || !store || !storage.pos || !store.pos) return null;
    const resolved = planOf(room, plan);
    const reserved = {};
    if (typeof layout.upgraderStorageStations === 'function') {
        for (const spot of layout.upgraderStorageStations(room, resolved) || []) {
            if (spot) reserved[spot.x + '.' + spot.y] = true;
        }
    }
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const x = store.pos.x + dx;
            const y = store.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (chebyshev({ x, y }, storage.pos) > 1) continue;
            if (typeof utils.isWall === 'function' && utils.isWall(room, x, y)) continue;
            if (typeof utils.occupied === 'function' && utils.occupied(room, x, y)) continue;
            candidates.push({ x, y, roomName: room.name, upgrader: !!reserved[x + '.' + y] });
        }
    }
    if (!candidates.length) return null;
    candidates.sort((left, right) => (left.upgrader ? 1 : 0) - (right.upgrader ? 1 : 0) || left.y - right.y || left.x - right.x);
    return candidates[0];
}

/** 往控制器/仓库送能的源 link：RCL5 只有 src0，RCL6 起加 src1（同一 link 只算一次）。spawn 给低档升级者定 WORK 下限也用它 */
function senderLinks(room, plan) {
    const senders = [];
    const src0 = getLink(room, plan, 'src0');
    if (src0) senders.push(src0);
    if (room.controller.level >= 6) {
        const src1 = getLink(room, plan, 'src1');
        if (src1 && src1.id !== (src0 && src0.id)) senders.push(src1);
    }
    return senders;
}

function run(room) {
    if (room.controller.level < 5) return;
    const plan = (Memory.rooms[room.name] || {}).plan;
    if (!plan || !plan.links) return;
    layout.normalizeLinkPlan(room, plan);
    const ctrl = getLink(room, plan, 'ctrl');
    const store = room.controller.level >= 7 ? getLink(room, plan, 'store') : null;
    // An actively drained store receiver exposes the gap between source sends.
    // Keep a source batch at the controller before diverting energy to storage.
    const controllerKeep = storeLinkReady(room, plan) && operatorStation(room, plan)
        ? Math.max(config.linkKeepAt, config.linkSendAt) : config.linkKeepAt;
    const senders = senderLinks(room, plan);
    if (!senders.length) return;

    const incoming = {};
    for (const sender of senders) {
        if (sender.cooldown > 0 || sender.store[RESOURCE_ENERGY] < config.linkSendAt) continue;
        const ctrlReserved = incoming[ctrl && ctrl.id] || 0;
        const storeReserved = incoming[store && store.id] || 0;
        const ctrlFree = ctrl ? ctrl.store.getFreeCapacity(RESOURCE_ENERGY) - ctrlReserved : 0;
        const ctrlBuffered = ctrl ? ctrl.store[RESOURCE_ENERGY] + ctrlReserved : 0;
        const storeFree = store ? store.store.getFreeCapacity(RESOURCE_ENERGY) - storeReserved : 0;

        let receiver = null;
        let free = 0;
        if (ctrl && !store && ctrlFree > 0 && ctrlBuffered >= controllerKeep) {
            // 遥测：没有 store link 时源 link 按兵不动（旧代码在这里照样往 ctrl link 送）
            const mem = Memory.rooms[room.name];
            if (mem) mem.linkHold = { at: Game.time, n: (Number(mem.linkHold && mem.linkHold.n) || 0) + 1 };
        }
        // 没有 store link（RCL5–6）时 ctrl link 也只在低于保留线时才补：以前只要它有空位就送，升级者被
        // upgraderWorkCap 限流后吃不完的源收入照样顺着链流进 ctrl link（再被 builder 借走去建 terminal/lab），
        // 源 link 永远堵不满、矿工永远不往源容器溢出，spawn/ext 拿不到一点本地能量（线上 2026-09-11 W33S7：
        // 三座 link 常年压着 ~1900，源容器 0/0，hauler 空手挂机，spawn 收入 7.5 → 0）。
        // 现在超出升级者消耗的部分停在源 link，矿工把它溢进源容器交给 hauler；需求大于供给时照常每批都送。
        if (ctrl && ctrlFree > 0 && (ctrlBuffered < controllerKeep || (store && storeFree <= 0))) {
            receiver = ctrl;
            free = ctrlFree;
        } else if (store && storeFree > 0) {
            receiver = store;
            free = storeFree;
        }
        if (!receiver || free <= 0) continue;
        const amount = Math.min(sender.store[RESOURCE_ENERGY], free);
        const ret = sender.transferEnergy(receiver, amount);
        if (ret === OK) incoming[receiver.id] = (incoming[receiver.id] || 0) + amount;
    }
}

module.exports = {
    run, getLink, senderLinks, sourceLink, storeLinkReady, sourceFedToStore, hubHaulMode,
    skipSourceContainer, skipLinkedDrop, operatorKeepEnergy, operatorStation,
};
