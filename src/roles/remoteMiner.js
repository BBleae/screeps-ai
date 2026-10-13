'use strict';

const movement = require('movement');
const remote = require('remote');
const retireMod = require('retire');

function homeAnchor(room) {
    return room && (room.storage || room.find(FIND_MY_SPAWNS)[0]);
}

function depositTarget(room) {
    if (!room) return null;
    if (room.storage && room.storage.my && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
    return room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => (structure.structureType === STRUCTURE_SPAWN ||
            structure.structureType === STRUCTURE_EXTENSION || structure.structureType === STRUCTURE_CONTAINER) &&
            structure.store && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] || null;
}

function retreat(creep) {
    // 外矿已停用（改派/不可达/被占）：去全账号最近的 spawn 回收退役（retire.js 自己跨房走，不必先回母房），不再占编制发呆
    if (remote.isDisabled(creep.memory.home, creep.memory.remoteRoom) || remote.isUnreachable(creep.memory.home, creep.memory.remoteRoom)) {
        retireMod.retireAtSpawn(creep);
        return;
    }
    const home = Game.rooms[creep.memory.home];
    if (!home) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 30 });
        return;
    }
    if (creep.room.name !== home.name) {
        movement.go(creep, new RoomPosition(25, 25, home.name), { range: 20, reusePath: 30 });
        return;
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const target = depositTarget(home);
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                movement.go(creep, target, { range: 1, reusePath: 20 });
            }
            return;
        }
    }
    const anchor = homeAnchor(home);
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 4)) movement.go(creep, anchor, { range: 4, reusePath: 25 });
}

function sourceObject(room, sourceMemory, sourceIdx) {
    let source = sourceMemory && sourceMemory.id && Game.getObjectById(sourceMemory.id);
    if (source) return source;
    const sources = room.find(FIND_SOURCES).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (sourceMemory && sourceMemory.id) source = sources.find((item) => item.id === sourceMemory.id);
    return source || sources[sourceIdx || 0] || sources[0] || null;
}

function run(creep) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!homeName || !remoteRoom) return;
    if (remote.isSuspended(homeName, remoteRoom)) {
        retreat(creep);
        return;
    }
    if (creep.room.name !== remoteRoom) {
        if (remote.noteTravel(creep)) return;
        movement.go(creep, new RoomPosition(25, 25, remoteRoom), { range: 20, reusePath: 40 });
        return;
    }

    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);
    if (remote.isSuspended(homeName, remoteRoom)) {
        retreat(creep);
        return;
    }
    // SK 外矿（config.sk）：keeper 在 keeperSafeRange 内（或 lair 快孵了）就退到射程外等 reaper 收拾，这一 tick 不采——
    // 矿工没有 HEAL，站在矿位上挨 100/tick 撑不过十几 tick
    if (remote.keeperRetreat(creep)) return;
    const sourceMemory = remote.getSource(homeName, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory || !sourceMemory.spot) return;
    if (!creep.memory.sourceId && sourceMemory.id) creep.memory.sourceId = sourceMemory.id;
    const source = sourceObject(creep.room, sourceMemory, creep.memory.srcIdx);
    if (!source) return;

    const spot = new RoomPosition(sourceMemory.spot.x, sourceMemory.spot.y, remoteRoom);
    if (!creep.pos.isEqualTo(spot.x, spot.y)) {
        movement.go(creep, spot, { range: 0, reusePath: 30 });
        if (creep.pos.isNearTo(source.pos)) remote.noteSkHarvest(creep, creep.harvest(source));
        return;
    }

    const container = creep.room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y)
        .find((structure) => structure.structureType === STRUCTURE_CONTAINER);
    const site = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, spot.x, spot.y)
        .find((constructionSite) => constructionSite.structureType === STRUCTURE_CONTAINER && constructionSite.my !== false);
    if (site) {
        // 地上有能量（容器倒出来的存货、之前的溢出）就同 tick 捡起来：pickup 与 build/harvest 不在同一条管线，
        // 2 WORK 矿工从"build 与 harvest 交替、2 进度/tick"提到 10 进度/tick（线上 W32S7 容器丢失后地上 1969 能量烂光，工地 2896/5000）
        // 同 tick 的动作都按开 tick 时的存量结算：捡起来的能量下一 tick 才能用，这一 tick 用不用 build 看捡之前的存量
        const had = creep.store[RESOURCE_ENERGY];
        const drop = creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            ? creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, { filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })[0] : null;
        if (drop) creep.pickup(drop);
        if (had > 0) {
            creep.build(site);
            if (drop) {
                // 遥测：同 tick 捡 + 建（旧代码只会 build/harvest 交替）
                const record = remote.getRemote(homeName, remoteRoom);
                if (record && (!record.minerPickupBuild || record.minerPickupBuild.at !== Game.time)) {
                    record.minerPickupBuild = { at: Game.time, n: (Number(record.minerPickupBuild && record.minerPickupBuild.n) || 0) + 1 };
                }
            }
        } else remote.noteSkHarvest(creep, creep.harvest(source));
        return;
    }
    if (container && container.hits < container.hitsMax * 0.75 && creep.store[RESOURCE_ENERGY] > 0 && Game.time % 5 === 0) {
        creep.repair(container);
        return;
    }
    if (container && creep.store[RESOURCE_ENERGY] > 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        creep.transfer(container, RESOURCE_ENERGY);
    }
    // 满仓 + 容器满：停手。引擎的 harvest intent 在 creep 仓溢出时把多采的能量直接丢到地上
    // （@screeps/engine processor/intents/creeps/harvest.js：sum > storeCapacity 就走 drop），
    // 而落地能量每 tick 衰减 ceil(amount/1000)（ENERGY_DECAY=1000），容器里的能量不衰减。
    // 线上 2026-09-09 W32S6/W32S7/W33S6/W33S5 的源容器全是 2000/2000、地面还各堆 1000–2600（净增 ~1–2/tick，
    // 与衰减同速）就是这条：运输工跟不上时矿工照样采，多出来的全丢地上烂掉；而 hauler 的 collect 总是先拿容器
    // （容器有能量就不会去捡地上那堆），所以这些落地能量基本等于白丢。停手不损失产量——源停在满能量，
    // 运输工取走容器里的能量后矿工立刻续采。没有容器时（容器烂掉/还没建）仍照旧落地，那是唯一能给 hauler 存货的地方。
    if (container && creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return;
    remote.noteSkHarvest(creep, creep.harvest(source));   // SK 外矿的开采遥测（普通外矿直接返回）
}

module.exports = { run };
