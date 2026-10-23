'use strict';
const config = require('config');
const utils = require('utils');
const movement = require('movement');
const wheelLayout = require('wheel_layout');
const visuals = require('visuals');
const logErr = utils.logErr;
const spawnMgr = require('spawn');
const retireMod = require('retire');
const aidMod = require('aid');
const spawnExit = require('spawn_exit');
const layout = require('layout');
const demolition = require('demolition');
require('soak_probe');
const tower = require('tower');
const segMem = require('seg_mem');
const links = require('links');
const remote = require('remote');
const brain = require('brain');
const defense = require('defense');
const expansion = require('expansion');
const conquest = require('conquest');
const industry = require('industry');
const terminalNetwork = require('terminal');
const market = require('market');
const depositMod = require('deposit');
const taskBroker = require('task_broker');
const haulStats = require('haul_stats');
const cpuShed = require('cpu_shed');
const wallFix = require('wallfix');
const pvp = require('pvp');
const cpuRemote = require('cpu_remote');
const cpuGate = require('cpu_gate');
const lootShed = require('loot_shed');
const lastTrip = require('last_trip');
const war = require('war');

const ROLES = {
    harvester: require('roles_harvester'),
    hauler: require('roles_hauler'),
    upgrader: require('roles_upgrader'),
    builder: require('roles_builder'),
    claimer: require('roles_claimer'),
    pioneer: require('roles_pioneer'),
    defender: require('roles_defender'),
    scout: require('roles_scout'),
    remoteMiner: require('roles_remoteMiner'),
    skReaper: require('roles_skReaper'),
    remoteHauler: require('roles_remoteHauler'),
    reserver: require('roles_reserver'),
    courier: require('roles_courier'),
    feeder: require('roles_feeder'),
    operator: require('roles_operator'),
    mineralMiner: require('roles_mineralMiner'),
    labTech: require('roles_labTech'),
    siegeDismantler: require('roles_siegeDismantler'),
    siegeGuard: require('roles_siegeGuard'),
    downgrader: require('roles_downgrader'),
    lootHauler: require('roles_lootHauler'),
    depositMiner: require('roles_depositMiner'),
    depositScout: require('roles_depositScout'),
    wallBreaker: require('roles_wallBreaker'),
    warrior: require('roles_warrior'),
};

function hasBodyPart(creep, type) {
    return (creep.body || []).some((part) => part.type === type && part.hits !== 0);
}

function roleLead(creep, role) {
    const base = config.spawnLead[role] || 0;
    const spawnTime = (creep.body || []).length * 3;
    return Math.max(base, spawnTime + 12);
}

function countReadyRole(room, role) {
    let n = 0;
    for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.home !== room.name || creep.memory.role !== role) continue;
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, role)) continue;
        n++;
    }
    return n;
}

function assessRoomState(room) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const sourceCount = Math.max(1, (mem.sources && mem.sources.length) || room.find(FIND_SOURCES).length || 1);
    const stableHarvesters = Math.min(sourceCount, config.recovery.stableHarvesters);
    const readyHarvesters = countReadyRole(room, 'harvester');
    let emergencyWorkers = 0;
    let readyWorkers = 0;
    for (const creep of Object.values(Game.creeps)) {
        if (creep.memory.home !== room.name || creep.spawning) continue;
        if (!creep.room || creep.room.name !== room.name) continue;
        if (!hasBodyPart(creep, 'work')) continue;
        const ttl = creep.ticksToLive;
        const lead = roleLead(creep, creep.memory.role || 'harvester');
        if (ttl != null && ttl <= lead) continue;
        readyWorkers++;
        if (hasBodyPart(creep, 'carry')) emergencyWorkers++;
    }
    const recovering = readyHarvesters < stableHarvesters;
    const emergencyHarvest = readyHarvesters === 0 &&
        room.energyAvailable < config.recovery.emergencyHarvestBelow &&
        emergencyWorkers > 0;
    const state = {
        at: Game.time,
        sourceCount,
        stableHarvesters,
        readyHarvesters,
        readyWorkers,
        recovering,
        emergencyHarvest,
    };
    mem.state = state;
    return state;
}

function runEmergencyHarvest(creep, room) {
    if (!room) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 25 });
        return;
    }
    if (creep.room.name !== room.name) {
        movement.go(creep, new RoomPosition(25, 25, room.name), { reusePath: 25 });
        return;
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
        });
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, target, { reusePath: 15 });
            return;
        }
    }
    const source = creep.pos.findClosestByPath(FIND_SOURCES);
    if (!source) return;
    if (creep.pos.isNearTo(source.pos)) {
        creep.harvest(source);
    } else {
        movement.go(creep, source, { reusePath: 15 });
    }
}

require('version');
if (!Memory.SCRIPT_VERSION || Memory.SCRIPT_VERSION !== SCRIPT_VERSION) {
    Memory.SCRIPT_VERSION = SCRIPT_VERSION;
    console.log('New code uploaded: ' + SCRIPT_VERSION);
}

module.exports.gcProbeKeys = gcProbeKeys;
module.exports.pixelGate = pixelGate;
module.exports.sampleStats = sampleStats;

let lastMemory = null;
let lastMemoryTick = -1;
function reuseParsedMemory() {
    if (lastMemory && lastMemoryTick === Game.time - 1) {
        delete global.Memory;
        global.Memory = lastMemory;
        if (typeof RawMemory !== 'undefined' && RawMemory) RawMemory._parsed = lastMemory;
        lastMemory.memReuse = { hit: 1, n: (lastMemory.memReuse && lastMemory.memReuse.n || 0) + 1, at: Game.time };
    } else {
        void (Memory && Memory.creeps);
        lastMemory = (typeof RawMemory !== 'undefined' && RawMemory && RawMemory._parsed) || Memory;
        if (!lastMemory || typeof lastMemory !== 'object') {
            lastMemory = null;
            lastMemoryTick = Game.time;
            return;
        }
        lastMemory.memReuse = { hit: 0, n: (lastMemory.memReuse && lastMemory.memReuse.n) || 0, at: Game.time };
    }
    lastMemoryTick = Game.time;
}

try { utils.installAllyFilter(); } catch (e) { logErr('allyFilter', e); }

module.exports.loop = function () {
    try { utils.installAllyFilter(); } catch (e) { logErr('allyFilter', e); }
    const spkT0 = Game.cpu.getUsed();
    spkTick = {}; spkRoom = {};
    reuseParsedMemory();
    let segReady = true;
    try { segReady = segMem.begin(); } catch (e) { logErr('segMem.begin', e); }
    if (!segReady) {
        Memory.rooms = Memory.rooms || {};
        for (const name in Game.rooms) {
            const r = Game.rooms[name];
            if (!r.controller || !r.controller.my) continue;
            try { tower.run(r); } catch (e) { logErr('tower.run ' + name, e); }
        }
        return;
    }
    try { require('cfg_overlay').apply(); } catch (e) { logErr('cfgOverlay', e); }
    try { lootShed.run(); } catch (e) { logErr('lootShed', e); }
    try { require('side_loot').run(); } catch (e) { logErr('sideLoot', e); }
    try { require('loot_split').run(); } catch (e) { logErr('lootSplit', e); }
    try { if (Memory.lootWarLoot && Memory.lootWarLoot.nuke) require('loot_nuke').run(); } catch (e) { logErr('lootNuke', e); }
    try { war.tick(); } catch (e) { logErr('war.tick', e); }
    try {
        if (typeof RawMemory !== 'undefined' && RawMemory && typeof RawMemory.setActiveSegments === 'function') {
            RawMemory.setActiveSegments(segMem.activeIds());
        }
    } catch (e) {  }
    Memory.creeps = Memory.creeps || {};
    Memory.rooms = Memory.rooms || {};
    Memory.map = Memory.map || {};
    Memory.errors = Memory.errors || [];
    try { cpuGate.track(); } catch (e) { logErr('cpuGate.track', e); }

    let shed = null;
    try {
        cpuProf.ticks++;
        cpuStart();
        try { movement.beginTick(); } catch (e) { logErr('movement.beginTick', e); }
        cpuLap(cpuProf.mod, 'move.begin');
        try { taskBroker.beginTick(); } catch (e) { logErr('taskBroker.beginTick', e); }
        cpuLap(cpuProf.mod, 'broker.begin');
        try { brain.run(); } catch (e) { logErr('brain.run', e); }
        try { require('policy').run(); } catch (e) { logErr('policy.run', e); }
        cpuLap(cpuProf.mod, 'brain');
        if (!cpuFused('conquest')) {
            try { conquest.run(); } catch (e) { logErr('conquest.run', e); }
        }
        cpuLap(cpuProf.mod, 'conquest');
        if (!cpuFused('wheel')) {
            try { wheelLayout.autoPlannerByFlag(); } catch (e) { logErr('wheel layout flags', e); }
        }
        cpuLap(cpuProf.mod, 'wheel');

        if (Game.time % 501 === 0) gcMemory();
        else if (Game.time % 50 === 0) { try { gcProbeKeys(); } catch (e) { logErr('gcProbeKeys', e); } }
        for (const name in Memory.creeps) {
            if (Game.creeps[name]) continue;
            try { defense.noteLoss(name, Memory.creeps[name]); } catch (e) { logErr('defense.noteLoss', e); }
            try { remote.noteReaperLoss(name, Memory.creeps[name]); } catch (e) { logErr('remote.noteReaperLoss', e); }
            try { ROLES.lootHauler.noteDeath(name, Memory.creeps[name]); } catch (e) { logErr('lootHauler.noteDeath', e); }
            delete Memory.creeps[name];
        }

        let drawVisuals = false;
        try { drawVisuals = visuals.enabled(); } catch (e) { logErr('visuals.enabled', e); }
        cpuLap(cpuProf.mod, 'memory');
        const sampleRoles = Game.time % ROLE_SAMPLE_EVERY === 0;
        if (sampleRoles) cpuProf.roleTicks++;
        if (sampleRoles) { try { cpuRemote.tick(); } catch (e) { logErr('cpuRemote.tick', e); } }
        try { require('utils').noteAggressorsAll(); } catch (e) { logErr('pvp.aggressors', e); }
        try { require('utils').noteAllyDamageAll(); } catch (e) { logErr('ally.damage', e); }
        try { require('utils').ownerCacheObserve(); } catch (e) { logErr('pvp.ownerCache', e); }
        try { require('utils').applyRcl8Auto(); } catch (e) { logErr('rcl8Auto', e); }
        for (const room of Object.values(Game.rooms)) {
            if (!room.controller || !room.controller.my) continue;
            const roomStart = Game.cpu.getUsed();
            try { runRoom(room); } catch (e) { logErr('room ' + room.name, e); }
            if (drawVisuals) { try { visuals.render(room); } catch (e) { logErr('visuals ' + room.name, e); } }
            const roomEnd = Game.cpu.getUsed();
            cpuProf.room[room.name] = (cpuProf.room[room.name] || 0) + (roomEnd - roomStart);
            spkRoom[room.name] = roomEnd - roomStart;
            cpuMark = roomEnd;
        }

        try { shed = cpuShed.begin(); } catch (e) { logErr('cpuShed.begin', e); shed = { active: false, cap: Game.cpu.limit - config.cpuReserve }; }
        const cpuCap = shed.cap;
        const sampleDisp = sampleRoles && Game.time % DISPATCH_EVERY === DISPATCH_PHASE && !shed.active;
        if (sampleDisp) cpuProf.dispTicks++;
        let mark = sampleDisp ? Game.cpu.getUsed() : 0;
        let creepQueue;
        try { creepQueue = taskBroker.orderCreeps(Object.values(Game.creeps)); }
        catch (e) { logErr('taskBroker.orderCreeps', e); creepQueue = Object.values(Game.creeps); }
        if (shed.active) {
            try { creepQueue = cpuShed.arrange(creepQueue, shed); } catch (e) { logErr('cpuShed.arrange', e); shed.active = false; }
        }
        if (sampleDisp) mark = dispLap('order', mark);
        let overBudget = false;
        spkRoles = {}; spkArm = null;
        let spkHot = false, spkMark = 0, spkRan = 0;
        for (const creep of creepQueue) {
            if (creep.spawning || !creep.memory || creep.memory.role !== 'warrior') continue;
            try { ROLES.warrior.run(creep); } catch (e) { logErr('creep ' + creep.name, e); }
        }
        for (let qi = 0; qi < creepQueue.length; qi++) {
            const creep = creepQueue[qi];
            if (creep.spawning) continue;
            if (creep.memory && creep.memory.role === 'warrior') continue;
            if (shed.armed && cpuShed.hardStopNow(shed)) {
                let cut = 0;
                for (let rest = qi; rest < creepQueue.length; rest++) if (!creepQueue[rest].spawning) cut++;
                cpuShed.noteHardStop(shed, cut);
                break;
            }
            try {
                aidMod.markStranded(creep);
                if (spawnMgr.retireReplaced && spawnMgr.retireReplaced(creep)) continue;
                if (retireMod.retireCrippled(creep)) continue;
                if (retireMod.retirePocketTrapped(creep)) continue;
            } catch (e) { logErr('creep retirement ' + creep.name, e); }
            try {
                if (spawnExit.runVacate(creep)) { taskBroker.markSkipped(creep, 'vacate'); continue; }
            } catch (e) { logErr('spawnExit.runVacate ' + creep.name, e); }
            try { haulStats.observe(creep); } catch (e) { logErr('haulStats.observe ' + creep.name, e); }
            const skippable = shed.active ? cpuShed.mayShed(creep, shed) : !taskBroker.shouldRun(creep);
            if (skippable && !overBudget) overBudget = Game.cpu.getUsed() > cpuCap;
            if (sampleDisp) mark = dispLap('retire', mark);
            if (skippable && overBudget) {
                if (shed.active) cpuShed.noteSkip(creep, shed);
                taskBroker.markSkipped(creep, 'cpu');
                continue;
            }
            const home = creep.memory.home && Game.rooms[creep.memory.home];
            const state = home && Memory.rooms[home.name] && Memory.rooms[home.name].state;
            let before = null;
            try { before = taskBroker.startCreep(creep); } catch (e) { logErr('taskBroker.startCreep ' + creep.name, e); }
            if (sampleDisp) mark = dispLap('start', mark);
            if (creep.memory.role !== 'mineralMiner' && state && state.emergencyHarvest && creep.room && creep.room.name === home.name &&
                hasBodyPart(creep, 'work') && hasBodyPart(creep, 'carry')) {
                try { runEmergencyHarvest(creep, home); } catch (e) { logErr('creep emergency ' + creep.name, e); }
                try { taskBroker.finishCreep(creep, before); } catch (e) { logErr('taskBroker.finishCreep ' + creep.name, e); }
                if (sampleDisp) mark = dispLap('run', mark);
                continue;
            }
            const role = ROLES[creep.memory.borrow && !creep.memory.retired ? 'lootHauler' : creep.memory.role];
            if (!role) {
                taskBroker.markSkipped(creep, 'unknown-role');
                continue;
            }
            if (sampleRoles && !sampleDisp) mark = Game.cpu.getUsed();
            if (!spkHot && !shed.active && Game.cpu.bucket >= SPK_MIN_BUCKET && (spkRan++) % SPK_PROBE === 0) {
                const u = Game.cpu.getUsed();
                if (u > SPK_ARM) { spkHot = true; spkMark = u; spkArm = { at: Math.round(u * 10) / 10, qi, of: creepQueue.length }; }
            }
            let fixing = false;
            try { fixing = pvp.evadeInvaders(creep); } catch (e) { logErr('evade ' + creep.name, e); }
            if (!fixing) { try { fixing = wallFix.run(creep); } catch (e) { logErr('wallFix ' + creep.name, e); } }
            if (!fixing) { try { fixing = lastTrip.run(creep) || lastTrip.salvage(creep); } catch (e) { logErr('lastTrip ' + creep.name, e); } }
            if (!fixing) { try { role.run(creep); } catch (e) { logErr('creep ' + creep.name, e); } }
            if (spkHot) {
                const u = Game.cpu.getUsed(), rn = creep.memory.role;
                const e = spkRoles[rn] || (spkRoles[rn] = [0, 0]);
                e[0] += u - spkMark; e[1]++;
                spkMark = u;
            }
            if (sampleRoles) {
                const now = Game.cpu.getUsed();
                const roleName = creep.memory.role;
                cpuProf.role[roleName] = (cpuProf.role[roleName] || 0) + (now - mark);
                const homeName = creep.memory.home;
                if (homeName) cpuProf.home[homeName] = (cpuProf.home[homeName] || 0) + (now - mark);
                const remoteName = creep.memory.remoteRoom;
                if (remoteName) cpuProf.remote[remoteName] = (cpuProf.remote[remoteName] || 0) + (now - mark);
                try { cpuRemote.note(creep.memory, now - mark); } catch (e) { logErr('cpuRemote.note', e); }
                if (sampleDisp) cpuProf.disp.run = (cpuProf.disp.run || 0) + (now - mark);
                mark = now;
            }
            try { taskBroker.finishCreep(creep, before); } catch (e) { logErr('taskBroker.finishCreep ' + creep.name, e); }
            if (sampleDisp) mark = dispLap('finish', mark);
        }
        cpuLap(cpuProf.mod, 'creeps');
        try { market.guardTick(); } catch (e) { logErr('market.guardTick', e); }
        if (!(shed && shed.stopped) && !cpuFused('terminal')) {
            try { market.run(shed); } catch (e) { logErr('market.run', e); }
        }
        if (!(shed && (shed.active || shed.stopped)) && !cpuFused('terminal')) {
            try { terminalNetwork.run(shed); } catch (e) { logErr('terminal.run', e); }
            if (!cpuFused('deposit')) {
                try { depositMod.run(); } catch (e) { logErr('deposit.run', e); }
            }
            cpuLap(cpuProf.mod, 'terminal');
        }
        sampleStats();
        if (Game.time % 30 === 0) {
            try { updateCpuFuse(); } catch (e) { logErr('updateCpuFuse', e); }
        }
        try { taskBroker.flush(); } catch (e) { logErr('taskBroker.flush', e); }
        try { haulStats.flush(); } catch (e) { logErr('haulStats.flush', e); }
        cpuLap(cpuProf.mod, 'broker.flush');
        if (Game.cpu.bucket >= 10000 && !(Memory.pixelRetry > Game.time)) {
            let gate = null;
            try { gate = pixelGate(); } catch (e) { logErr('pixelGate', e); }
            if (gate && !gate.ok) {
                const log = Memory.pixelGate || (Memory.pixelGate = { skip: 0 });
                log.skip = (Number(log.skip) || 0) + 1;
                log.at = Game.time;
                log.mean = gate.mean;
                log.line = gate.line;
                log.n = gate.n;
                log.wait = gate.wait;
            } else if (gate && typeof Game.cpu.generatePixel === 'function') {
                if (Game.cpu.generatePixel() === OK) {
                    Memory.pixels = (Memory.pixels || 0) + 1;
                    cpuGate.notePixel();
                    try { require('market').notePixel(); } catch (e) { logErr('market.notePixel', e); }
                } else Memory.pixelRetry = Game.time + 10000;
            }
        }
    } finally {
        try { movement.endTick(); } catch (e) { logErr('movement.endTick', e); }
        cpuLap(cpuProf.mod, 'move.end');
        if (shed && shed.stopped) { try { cpuShed.noteHardStopEnd(shed); } catch (e) { logErr('cpuShed.noteHardStopEnd', e); } }
        if (pendingStat) {
            pendingStat.cpu = Math.round(Game.cpu.getUsed() * 10) / 10;
            let accounted = 0;
            for (const k in spkTick) accounted += Number(spkTick[k]) || 0;
            pendingStat.unaccounted = Math.round((pendingStat.cpu - accounted) * 10) / 10;
            pendingStat.accounted = Math.round(accounted * 10) / 10;
            pendingStat.t0 = Math.round(spkT0 * 1000) / 1000;
            const diag = Memory.cpuDiag || (Memory.cpuDiag = {});
            diag.unaccounted = pendingStat.unaccounted;
            diag.cpu = pendingStat.cpu;
            diag.at = Game.time;
            pendingStat = null;
        }
        try { noteSpike(spkT0); } catch (e) {  }
        try { cpuGate.record(Game.cpu.getUsed()); } catch (e) {  }
        try { segMem.flush(); } catch (e) { logErr('segMem.flush', e); }
    }
};

const SPIKE_LINE = 150;
let spkTick = {}, spkRoom = {}, spkRoles = {}, spkArm = null;
const SPK_PROBE = 16, SPK_ARM = 100, SPK_MIN_BUCKET = 5000;
const spkBoot = Game.time;
const SPIKE_SEG = 91;
const SPIKE_KEEP_MEM = 8;
const SPIKE_BIG_LINE = 190, SPIKE_BIG_KEEP = 20, SPIKE_BIG_TOP = 5;

function noteSpike(t0) {
    const used = Game.cpu.getUsed();
    if (used <= SPIKE_LINE) return;
    const r1 = (o, min) => { const out = {}; for (const k in o) if (o[k] >= min) out[k] = Math.round(o[k] * 10) / 10; return out; };
    const row = { t: Game.time, cpu: Math.round(used * 10) / 10, t0: Math.round(t0 * 10) / 10, age: Game.time - spkBoot,
        b: Game.cpu.bucket, n: Object.keys(Game.creeps).length, m: r1(spkTick, 1), r: r1(spkRoom, 3), arm: spkArm, roles: spkRoleDigest() };
    if (used > SPIKE_BIG_LINE) { try { noteBigSpike(row); } catch (e) {  } }
    const arr = Memory.cpuSpikes || (Memory.cpuSpikes = []);
    arr.push(row);
    if (arr.length > SPIKE_KEEP_MEM) {
        const overflow = arr.splice(0, arr.length - SPIKE_KEEP_MEM);
        try { flushSpikesToSegment(overflow); } catch (e) {  }
    }
}

function readSpikeSeg() {
    try {
        const raw = RawMemory.segments && RawMemory.segments[SPIKE_SEG];
        if (typeof raw === 'string' && raw.length) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (e) {  }
    return {};
}

function noteBigSpike(row) {
    if (typeof RawMemory === 'undefined' || !RawMemory || !RawMemory.segments || typeof RawMemory.segments[SPIKE_SEG] !== 'string') return;
    const seg = readSpikeSeg();
    const top = Object.keys(row.m || {}).sort((a, b) => row.m[b] - row.m[a]).slice(0, SPIKE_BIG_TOP).map(k => [k, row.m[k]]);
    const big = (Array.isArray(seg.big) ? seg.big : []).concat([{ t: row.t, cpu: row.cpu, b: row.b, n: row.n, top }]).slice(-SPIKE_BIG_KEEP);
    RawMemory.segments[SPIKE_SEG] = JSON.stringify({ spikes: Array.isArray(seg.spikes) ? seg.spikes : [], at: seg.at || Game.time, big });
    const diag = Memory.cpuDiag || (Memory.cpuDiag = {});
    diag.bigSpikeAt = row.t;
    diag.bigSpikeN = big.length;
}

function flushSpikesToSegment(overflow) {
    if (typeof RawMemory === 'undefined' || !RawMemory) return;
    if (typeof RawMemory.setActiveSegments === 'function') RawMemory.setActiveSegments(segMem.activeIds());
    const seg = readSpikeSeg();
    const prev = Array.isArray(seg.spikes) ? seg.spikes : [];
    const spikes = prev.concat(overflow || []).slice(-40);
    RawMemory.segments[SPIKE_SEG] = JSON.stringify({ spikes, at: Game.time, big: Array.isArray(seg.big) ? seg.big : [] });
    const diag = Memory.cpuDiag || (Memory.cpuDiag = {});
    diag.spikesSeg = SPIKE_SEG;
    diag.spikesAt = Game.time;
    diag.spikesN = spikes.length;
}

function spkRoleDigest() {
    const out = {};
    Object.keys(spkRoles).sort((a, b) => spkRoles[b][0] - spkRoles[a][0]).forEach(k => {
        const e = spkRoles[k]; if (e[0] >= 0.5) out[k] = [Math.round(e[0] * 10) / 10, e[1]];
    });
    return out;
}

function runRoom(room) {
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    assessRoomState(room);
    cpuLap(cpuProf.mod, 'assess');
    const remoteFrom = cpuMark;
    remote.run(room);
    cpuLap(cpuProf.mod, 'remote');
    if (Game.time % ROLE_SAMPLE_EVERY === 0) { try { cpuRemote.notePlan(room.name, cpuMark - remoteFrom); } catch (e) { logErr('cpuRemote.notePlan', e); } }
    if (!cpuFused('expansion')) {
        try { expansion.run(room); } catch (e) { logErr('expansion.run ' + room.name, e); }
    }
    cpuLap(cpuProf.mod, 'expansion');
    spawnMgr.run(room);
    cpuLap(cpuProf.mod, 'spawn');
    if (utils.isRoomPhaseTick(room.name, config.layoutInterval)) { layout.run(room); cpuLap(cpuProf.mod, 'layout'); }
    if (!cpuFused('demolition')) {
        try { demolition.run(room); } catch (e) { logErr('demolition.run ' + room.name, e); }
    }
    cpuLap(cpuProf.mod, 'demolition');
    tower.run(room);
    links.run(room);
    cpuLap(cpuProf.mod, 'tower+links');
    if (room.controller.level >= 6 && utils.isRoomPhaseTick(room.name, 5)) { industry.run(room); cpuLap(cpuProf.mod, 'industry'); }
}

let pendingStat = null;

function pixelGate() {
    return cpuGate.pixelReady();
}

function sampleStats() {
    if (Game.time % 30 !== 0) return;
    const rooms = Object.values(Game.rooms).filter((r) => r.controller && r.controller.my);
    if (!rooms.length) return;
    if (!Memory.stats) Memory.stats = [];
    const byRoom = {};
    for (const r of rooms) {
        byRoom[r.name] = [r.controller.level, r.controller.progress, r.storage ? r.storage.store[RESOURCE_ENERGY] : 0];
    }
    const entry = {
        t: Game.time,
        rooms: byRoom,
        creeps: Object.keys(Game.creeps).length,
        cpu: Math.round(Game.cpu.getUsed() * 10) / 10,
        bucket: Game.cpu.bucket,
        cpuBy: cpuDigest(cpuProf.mod, cpuProf.ticks),
        cpuRooms: (Memory.stats.length % 4 === 0) ? cpuDigest(cpuProf.room, cpuProf.ticks) : undefined,
        cpuRoles: (Memory.stats.length % 4 === 0) ? cpuDigest(cpuProf.role, cpuProf.roleTicks) : undefined,
        cpuDispatch: cpuDigest(cpuProf.disp, cpuProf.dispTicks, 0.001, 1000),
        cpuSampled: [cpuProf.roleTicks, cpuProf.dispTicks],
        shed: cpuShed.digest(),
        cpuSpawn: spawnDigest(),
        cache: cacheDigest(),
    };
    try {
        if (typeof RawMemory !== 'undefined' && RawMemory && typeof RawMemory.get === 'function') {
            entry.memBytes = RawMemory.get().length;
            const diag = Memory.cpuDiag || (Memory.cpuDiag = {});
            diag.memBytes = entry.memBytes;
            diag.memAt = Game.time;
        }
    } catch (e) {  }
    try { foldCpuLedger(); } catch (e) { logErr('cpuLedger', e); }
    cpuProf.mod = {};
    cpuProf.room = {};
    cpuProf.role = {};
    cpuProf.home = {};
    cpuProf.remote = {};
    cpuProf.disp = {};
    cpuProf.dispTicks = 0;
    cpuProf.roleTicks = 0;
    cpuProf.ticks = 0;
    Memory.stats.push(entry);
    pendingStat = entry;
    if (Memory.stats.length > 40) Memory.stats.splice(0, Memory.stats.length - 40);
}

function spawnDigest() {
    try { return spawnMgr.cpuDigest(); } catch (e) { logErr('spawn.cpuDigest', e); return {}; }
}

const cacheSeen = {};
function cacheWindow(key, pair) {
    const prev = cacheSeen[key] || [0, 0];
    cacheSeen[key] = pair;
    if (pair[0] < prev[0] || pair[1] < prev[1]) return pair.slice();
    return [pair[0] - prev[0], pair[1] - prev[1]];
}
function cacheDigest() {
    const out = {};
    try {
        const src = layout.sourceOrderStats();
        out.srcOrder = cacheWindow('srcOrder', [Number(src.calls) || 0, Number(src.hits) || 0]);
    } catch (e) { logErr('cacheDigest srcOrder', e); }
    try {
        const move = movement.stats() || {};
        const calls = Number(move.workTileCalls) || 0;
        out.workTile = cacheWindow('workTile', [calls, Math.max(0, calls - (Number(move.workTileComputes) || 0))]);
    } catch (e) { logErr('cacheDigest workTile', e); }
    return out;
}

const KEEP_UNDERSCORE = ['_gcSeen', '_visuals'];

function gcProbeKeys() {
    const ttl = config.memoryProbeTtl;
    if (!(ttl > 0)) return;
    const seen = Memory._gcSeen || (Memory._gcSeen = {});
    for (const key of Object.keys(Memory)) {
        if (key.charCodeAt(0) !== 95 || KEEP_UNDERSCORE.indexOf(key) >= 0) continue;
        const value = Memory[key];
        const size = typeof value === 'string' ? value.length : -1;
        const entry = seen[key];
        if (!entry || entry.n !== size) { seen[key] = { t: Game.time, n: size }; continue; }
        if (Game.time - entry.t > ttl) { delete Memory[key]; delete seen[key]; }
    }
    for (const key of Object.keys(seen)) if (!(key in Memory)) delete seen[key];
}

const ROLE_SAMPLE_EVERY = Math.max(1, Math.floor(Number((config.cpuProfile || {}).sampleEvery) || 5));
const DISPATCH_EVERY = Math.max(1, Math.floor(Number((config.cpuProfile || {}).dispatchEvery) || 30));
const DISPATCH_PHASE = Math.floor(DISPATCH_EVERY / 2 / ROLE_SAMPLE_EVERY) * ROLE_SAMPLE_EVERY;
const cpuProf = { mod: {}, room: {}, role: {}, disp: {}, home: {}, remote: {}, ticks: 0, roleTicks: 0, dispTicks: 0 };
function foldCpuLedger() {
    const led = Memory.cpuLedger || (Memory.cpuLedger = { since: Game.time, sinceMs: Date.now(), ticks: 0, roleTicks: 0, room: {}, home: {}, remote: {} });
    const add = (into, from) => { for (const k of Object.keys(from)) into[k] = Math.round(((into[k] || 0) + from[k]) * 1000) / 1000; };
    add(led.room, cpuProf.room);
    add(led.home, cpuProf.home);
    add(led.remote, cpuProf.remote);
    led.ticks += cpuProf.ticks;
    led.roleTicks += cpuProf.roleTicks;
    led.at = Game.time;
}
let cpuMark = 0;
function cpuStart() { cpuMark = Game.cpu.getUsed(); }
function cpuLap(bucket, label) {
    const now = Game.cpu.getUsed();
    bucket[label] = (bucket[label] || 0) + (now - cpuMark);
    if (bucket === cpuProf.mod) spkTick[label] = (spkTick[label] || 0) + (now - cpuMark);
    cpuMark = now;
}
function cpuDigest(bucket, ticks, min = 0.05, scale = 100) {
    const out = {};
    if (!(ticks > 0)) return out;
    for (const key of Object.keys(bucket)) {
        const avg = bucket[key] / ticks;
        if (avg >= min) out[key] = Math.round(avg * scale) / scale;
    }
    return out;
}
function dispLap(label, since) {
    const now = Game.cpu.getUsed();
    cpuProf.disp[label] = (cpuProf.disp[label] || 0) + (now - since);
    return now;
}

function gcMemory() {
    if (Memory.map) {
        for (const k in Memory.map) {
            if (Game.time - (Memory.map[k].at || 0) > 20000) delete Memory.map[k];
        }
    }
    gcProbeKeys();
    try { pruneRoomLogs(); } catch (e) { logErr('pruneRoomLogs', e); }
    try { prunePvpFlee(); } catch (e) { logErr('prunePvpFlee', e); }
}

const ROOM_LOG_KEYS = ['spawnStallLog', 'spawnLog', 'crippledLog', 'defenseLog', 'reserveLog', 'minerUpgradeLog'];
const ROOM_LOG_KEEP = 8;
function pruneRoomLogs() {
    const rooms = Memory.rooms || {};
    for (const name in rooms) {
        const mem = rooms[name];
        if (!mem || typeof mem !== 'object') continue;
        for (const key of ROOM_LOG_KEYS) {
            const arr = mem[key];
            if (Array.isArray(arr) && arr.length > ROOM_LOG_KEEP) arr.splice(0, arr.length - ROOM_LOG_KEEP);
        }
    }
}

function prunePvpFlee() {
    const mem = Memory.pvpFlee;
    if (!mem) return;
    for (const name of Object.keys(mem)) {
        const at = mem[name] && mem[name].at;
        if (!(at > 0) || Game.time - at > 3000) delete mem[name];
    }
}

function cpuFused(mod) {
    const cfg = config.cpuFuse;
    if (!cfg || !cfg.enabled) return false;
    const fuse = Memory.cpuFuse;
    if (!fuse || !fuse.skipUntil) return false;
    return (Number(fuse.skipUntil[mod]) || 0) > Game.time;
}

function updateCpuFuse() {
    const cfg = config.cpuFuse;
    if (!cfg || !cfg.enabled) return;
    const entry = pendingStat || (Memory.stats && Memory.stats[Memory.stats.length - 1]);
    if (!entry || !entry.cpuBy || entry.t !== Game.time) return;
    const fuse = Memory.cpuFuse || (Memory.cpuFuse = { ema: {}, skipUntil: {} });
    fuse.ema = fuse.ema || {};
    fuse.skipUntil = fuse.skipUntil || {};
    const alpha = Number(cfg.emaAlpha) || 0.25;
    const factor = Number(cfg.factor) || 3;
    const minEma = Number(cfg.minEma) || 1;
    const skipTicks = Number(cfg.skipTicks) || 20;
    const allow = cfg.modules || [];
    for (const mod of allow) {
        const v = Number(entry.cpuBy[mod]);
        if (!(v > 0)) continue;
        const prev = fuse.ema[mod];
        const ema = prev != null ? prev : v;
        if (ema >= minEma && v > factor * ema) {
            fuse.skipUntil[mod] = Game.time + skipTicks;
            fuse.lastTrip = { mod, v, ema: Math.round(ema * 10) / 10, at: Game.time };
        }
        fuse.ema[mod] = Math.round((ema * (1 - alpha) + v * alpha) * 100) / 100;
    }
    fuse.at = Game.time;
}
