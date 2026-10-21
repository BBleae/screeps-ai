'use strict';
function soakProbe() {
    var out = { t: Game.time, cpu: Math.round(Game.cpu.getUsed() * 10) / 10, bucket: Game.cpu.bucket, errN: (Memory.errors || []).length,
        errs: (Memory.errors || []).slice(0, 3).map(function (e) { return e.where + ': ' + e.msg; }), rooms: {}, creeps: [] };
    Object.values(Game.rooms).forEach(function (r) {
        var m = Memory.rooms[r.name] || {};
        var mine = r.controller && r.controller.my;
        var o = { mine: !!mine, rcl: r.controller && r.controller.level, prog: r.controller && r.controller.progress, e: r.energyAvailable, cap: r.energyCapacityAvailable,
            hostiles: r.find(FIND_HOSTILE_CREEPS).length,
            sites: r.find(FIND_MY_CONSTRUCTION_SITES).map(function (s) { return [s.structureType, s.pos.x, s.pos.y, s.progress, s.progressTotal]; }),
            structs: {}, drops: r.find(FIND_DROPPED_RESOURCES).reduce(function (a, d) { return a + d.amount; }, 0),
            ruinEnergy: typeof FIND_RUINS !== 'undefined' ? r.find(FIND_RUINS).reduce(function (a, d) { return a + (d.store && d.store.energy || 0); }, 0) : 0,
            demolition: (m.demolition || []).slice(0, 3), planVer: m.plan && m.plan.version, planError: m.planError || null,
            targets: m.demand && m.demand.targets, state: m.state && { rec: m.state.recovering }, safe: r.controller && r.controller.safeMode,
            dl: m.defenseLog && m.defenseLog.spawned,
            remotes: m.remotes && Object.keys(m.remotes).map(function (k) { var x = m.remotes[k]; return k + ':' + (x.enabled ? 1 : 0) + ':' + (x.suspendReason || '') + ':' + (x.suspendedUntil || 0); }) };
        r.find(FIND_STRUCTURES).forEach(function (s) { o.structs[s.structureType] = (o.structs[s.structureType] || 0) + 1; });
        var cc = m.plan && m.plan.containers;
        if (cc) {
            o.cont = {};
            Object.keys(cc).forEach(function (k) {
                var c = r.lookForAt(LOOK_STRUCTURES, cc[k].x, cc[k].y).filter(function (s) { return s.structureType === STRUCTURE_CONTAINER; })[0];
                o.cont[k] = c ? c.store.energy : null;
            });
        }
        o.storage = r.storage && r.storage.store ? r.storage.store.energy : null;
        var cl = m.plan && m.plan.links;
        if (cl) {
            o.links = {};
            Object.keys(cl).forEach(function (k) {
                var l = r.lookForAt(LOOK_STRUCTURES, cl[k].x, cl[k].y).filter(function (s) { return s.structureType === STRUCTURE_LINK; })[0];
                o.links[k] = l && l.store ? l.store.energy : null;
            });
        }
        out.rooms[r.name] = o;
    });
    Object.values(Game.creeps).forEach(function (c) {
        out.creeps.push([c.name, c.memory.role, c.memory.home, c.room.name, c.pos.x, c.pos.y, c.store.getUsedCapacity ? c.store.getUsedCapacity() : 0,
            c.ticksToLive, c.fatigue, c.memory.remoteRoom || '', c.memory.targetRoom || '']);
    });
    out.spawning = Object.values(Game.spawns).map(function (s) { return s.room.name + ':' + (s.spawning ? s.spawning.name : ''); });
    Memory._soak = out;
    return 1;
}

global.soakProbe = soakProbe;

function validationProbe(roomName) {
    var r = Game.rooms[roomName];
    var room = null;
    if (r && r.controller && r.controller.my) {
        var defense, aid;
        try { defense = require('defense').getDemands(r).map(function (d) { return d.slot; }); } catch (e) { defense = 'ERR:' + e.message; }
        try { aid = require('aid').getDemands(r).map(function (d) { return d.slot + (d.strategic === false ? '' : '!'); }); } catch (e) { aid = 'ERR:' + e.message; }
        room = {
            name: r.name,
            visualSize: r.visual && r.visual.getSize ? r.visual.getSize() : null,
            energy: r.energyAvailable,
            cap: r.energyCapacityAvailable,
            rcl: r.controller.level,
            storage: r.storage && r.storage.store ? r.storage.store.energy : null,
            ctrl: (function () {
                var plan = Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].plan;
                var spot = plan && plan.containers && plan.containers.ctrl;
                var container = spot && r.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).filter(function (s) { return s.structureType === STRUCTURE_CONTAINER; })[0];
                return container ? container.store.energy : null;
            })(),
            creeps: Object.values(Game.creeps).filter(function (c) { return c.room && c.room.name === roomName; }).map(function (c) {
                var counts = {};
                (c.body || []).forEach(function (part) { var k = (part.type || part).charAt(0).toUpperCase(); counts[k] = (counts[k] || 0) + 1; });
                var body = Object.keys(counts).sort().map(function (k) { return counts[k] + k; }).join('');
                return { name: c.name, role: c.memory && c.memory.role || '', x: c.pos.x, y: c.pos.y, ttl: c.spawning ? null : c.ticksToLive, spawning: !!c.spawning, energy: c.store && c.store.energy || 0, body: body };
            }),
            hostiles: r.find(FIND_HOSTILE_CREEPS).map(function (h) { return [h.owner && h.owner.username, h.pos.x, h.pos.y, h.body.map(function (b) { return b.type; }).join(',')]; }),
            defense: defense,
            aid: aid,
            sites: r.find(FIND_MY_CONSTRUCTION_SITES).map(function (s) { return [s.structureType, s.progress, s.progressTotal]; }),
            spawnQueue: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].spawnQueue || null,
            safeMode: r.controller.safeMode || 0,
            storageRich: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].storageRich || null,
            collect: (function () {
                try {
                    return require('task_broker').roomTasks(r).filter(function (t) { return t.kind === 'collect'; }).map(function (t) {
                        return [t.target.structureType || (t.target.amount != null ? 'drop' : 'other'), t.weight, t.backlog, !!t.rich];
                    });
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            repair: (function () {
                try {
                    return require('task_broker').roomTasks(r).filter(function (t) { return t.kind === 'repair'; }).map(function (t) {
                        return [t.target.structureType || 'other', t.weight, t.backlog];
                    });
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            rampartTarget: (function () {
                try {
                    var rampartType = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
                    var ramparts = r.find(FIND_MY_STRUCTURES).filter(function (s) { return s.structureType === rampartType; });
                    if (!ramparts.length) return null;
                    var utils = require('utils');
                    var mem = Memory.rooms && Memory.rooms[roomName];
                    var settings = require('config').ramparts || {};
                    var flow = Math.max(0, Number(mem && mem.spawnIncome && mem.spawnIncome.ema) || 0);
                    var bank = r.storage && r.storage.store ? Math.max(0, Number(r.storage.store.energy || 0)) / Math.max(1, Number(settings.storageTicks) || 10000) : 0;
                    return { target: utils.repairTargetHits(r, ramparts[0]), count: ramparts.length,
                        budget: Math.max(flow, bank), floor: Number(settings.floorHits) || 0 };
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            srcContainers: (function () {
                var plan = Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].plan;
                var out = [];
                ['src0', 'src1'].forEach(function (key) {
                    var spot = plan && plan.containers && plan.containers[key];
                    var container = spot && r.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).filter(function (s) { return s.structureType === STRUCTURE_CONTAINER; })[0];
                    if (container) out.push(container.store.energy);
                });
                return out;
            })(),
            dropped: r.find(FIND_DROPPED_RESOURCES).reduce(function (sum, d) { return sum + (d.resourceType === RESOURCE_ENERGY ? d.amount : 0); }, 0),
            srcContainerHits: (function () {
                var plan = Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].plan;
                var out = [];
                ['src0', 'src1'].forEach(function (key) {
                    var spot = plan && plan.containers && plan.containers[key];
                    var c = spot && r.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).filter(function (s) { return s.structureType === STRUCTURE_CONTAINER; })[0];
                    if (c) out.push(c.hits);
                });
                return out;
            })(),
            ctrlContainerHits: (function () {
                var plan = Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].plan;
                var spot = plan && plan.containers && plan.containers.ctrl;
                var c = spot && r.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).filter(function (s) { return s.structureType === STRUCTURE_CONTAINER; })[0];
                return c ? c.hits : null;
            })(),
            mined: (function () {
                var m = r.find(FIND_MINERALS)[0];
                var type = m && m.mineralType;
                var carried = 0, drones = 0;
                Object.values(Game.creeps).forEach(function (c) {
                    if (!c.memory || c.memory.role !== 'mineralMiner' || c.memory.home !== roomName) return;
                    drones++;
                    if (type && c.store) carried += c.store[type] || 0;
                });
                return {
                    type: type || null,
                    left: m ? m.mineralAmount : null,
                    terminal: r.terminal && type ? (r.terminal.store[type] || 0) : 0,
                    storage: r.storage && type ? (r.storage.store[type] || 0) : 0,
                    carried: carried,
                    drones: drones,
                };
            })(),
            stores: r.find(FIND_STRUCTURES).filter(function (s) {
                return s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL;
            }).map(function (s) { return [s.structureType, s.store ? s.store.getUsedCapacity() : 0]; }),
            aidExport: (function () {
                try {
                    var u = require('utils');
                    var c = require('config');
                    return u.aidExportLevels ? u.aidExportLevels(c.aid, c.upgrading) : null;
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            upgradeSupply: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].upgradeSupply || null,
            ctrlLink: (function () {
                try {
                    var link = require('links').getLink(r, (Memory.rooms[roomName] || {}).plan || {}, 'ctrl');
                    return link && link.store ? link.store.energy : null;
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            storeLink: (function () {
                try {
                    var link = require('links').storeLinkReady(r, (Memory.rooms[roomName] || {}).plan || {});
                    return link && link.store ? link.store.energy : null;
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            operator: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].operator || null,
            haulModel: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].haulModel || null,
            ctrlFeedBand: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].ctrlFeedBand || null,
            criticalRepair: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].criticalRepair || null,
            repairSplit: (function () {
                try {
                    var out = { crit: null, ram: null };
                    r.find(FIND_STRUCTURES).forEach(function (s) {
                        if (s.hits == null) return;
                        if (s.structureType === STRUCTURE_RAMPART) { if (out.ram == null || s.hits < out.ram) out.ram = s.hits; }
                        else if (s.structureType === STRUCTURE_CONTAINER) { if (out.crit == null || s.hits < out.crit) out.crit = s.hits; }
                    });
                    return out;
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            homeIndexed: (function () {
                try { return require('utils').creepsHome(roomName).length; } catch (e) { return 'ERR:' + e.message; }
            })(),
            actionGuard: (function () {
                try {
                    var mod = require('actions');
                    return { attackBlockedByHeal: mod.BLOCKED_BY.attack.indexOf('heal') >= 0,
                        rangedBlockedByRangedHeal: mod.BLOCKED_BY.rangedAttack.indexOf('rangedHeal') >= 0,
                        skipped: mod.stats() };
                } catch (e) { return 'ERR:' + e.message; }
            })(),
            targets: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].demand && Memory.rooms[roomName].demand.targets || null,
            towers: r.find(FIND_MY_STRUCTURES).filter(function (s) { return s.structureType === STRUCTURE_TOWER; }).map(function (t) { return t.store.energy; }),
            links: r.find(FIND_MY_STRUCTURES).filter(function (s) { return s.structureType === STRUCTURE_LINK; }).length,
            towerFirstAt: Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].towerFirstAt || null,
            remoteDemands: (function () {
                try { return require('remote').getDemands(r).map(function (d) { return d.slot; }); } catch (e) { return 'ERR:' + e.message; }
            })(),
        };
    }
    var v = { t: Game.time, errN: (Memory.errors || []).length, cpu: Game.cpu.getUsed(), cpuLimit: Game.cpu.limit, room: room };
    Memory._validation = v;
    Memory._validationRooms = Memory._validationRooms || {};
    Memory._validationRooms[roomName] = room;
    return 'ok';
}

module.exports = { soakProbe, validationProbe };
