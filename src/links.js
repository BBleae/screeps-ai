'use strict';
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

function storeLinkReady(room, plan) {
    if (!room || !room.storage || room.storage.my === false || !room.storage.pos) return null;
    if (!room.controller || room.controller.level < 7) return null;
    const store = getLink(room, planOf(room, plan), 'store');
    if (!store || !store.my || chebyshev(store.pos, room.storage.pos) > 1) return null;
    return store;
}

function sourceFedToStore(room, plan, source, index) {
    if (!storeLinkReady(room, plan)) return false;
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
    return false;
}

function operatorKeepEnergy(room, plan, store) {
    const ctrl = getLink(room, planOf(room, plan), 'ctrl');
    if (ctrl && store && ctrl.id === store.id) return Math.max(0, Number(config.linkKeepAt) || 0);
    return Math.max(0, Number((config.hauling || {}).operatorKeep) || 0);
}

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

function reverseCtrlFeedAbove() {
    return Math.max(0, Number(config.reverseCtrlFeedAbove) || 0);
}

function storageEnergy(room) {
    const energyKey = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
    return Number(room && room.storage && room.storage.my !== false && room.storage.store && room.storage.store[energyKey]) || 0;
}

function reverseCtrlFeedWanted(room, plan) {
    const floor = reverseCtrlFeedAbove();
    if (!(floor > 0) || !room || !room.storage || room.storage.my === false) return false;
    if (room.controller && room.controller.my && room.controller.level >= 8) return false;
    if (storageEnergy(room) <= floor) return false;
    const resolved = planOf(room, plan);
    const store = storeLinkReady(room, resolved);
    const ctrl = getLink(room, resolved, 'ctrl');
    if (!store || !ctrl || !ctrl.store) return false;
    const energyKey = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
    return Number(ctrl.store.getFreeCapacity(energyKey)) > 0;
}

function run(room) {
    if (room.controller.level < 5) return;
    const plan = (Memory.rooms[room.name] || {}).plan;
    if (!plan || !plan.links) return;
    layout.normalizeLinkPlan(room, plan);
    const ctrl = getLink(room, plan, 'ctrl');
    const store = room.controller.level >= 7 ? getLink(room, plan, 'store') : null;
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
            const mem = Memory.rooms[room.name];
            if (mem) mem.linkHold = { at: Game.time, n: (Number(mem.linkHold && mem.linkHold.n) || 0) + 1 };
        }
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

    if (store && ctrl && reverseCtrlFeedWanted(room, plan) && !(store.cooldown > 0)) {
        const energyKey = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
        const have = Number(store.store[energyKey]) || 0;
        const need = Number(ctrl.store.getFreeCapacity(energyKey)) || 0;
        const minSend = Math.min(Number(config.linkSendAt) || 700, 400);
        if (have >= minSend && need > 0) {
            const amount = Math.min(have, need);
            const ret = store.transferEnergy(ctrl, amount);
            if (ret === OK) {
                const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
                const rec = mem.reverseCtrlFeed || (mem.reverseCtrlFeed = { n: 0, amount: 0 });
                rec.at = Game.time;
                rec.n = (Number(rec.n) || 0) + 1;
                rec.amount = (Number(rec.amount) || 0) + amount;
            }
        }
    }
}

module.exports = {
    run, getLink, senderLinks, sourceLink, storeLinkReady, sourceFedToStore, hubHaulMode,
    skipSourceContainer, skipLinkedDrop, operatorKeepEnergy, operatorStation,
    reverseCtrlFeedWanted, reverseCtrlFeedAbove, storageEnergy,
};
