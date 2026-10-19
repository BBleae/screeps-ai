'use strict';
const config = require('config');
const brain = require('brain');
const retire = require('retire');
const movement = require('movement');
const { makeBody, roomDistance, creepsHomeRole, isRetiring, logErr } = require('utils');

function settings() {
    return Object.assign({ minCapacity: 650, minRcl: 3, pioneers: 2, pioneerBudget: 800,
        autoClaimAfterMs: 24 * 60 * 60 * 1000, autoClaimInterval: 1500, autoClaimRange: 2, autoClaimFreshFor: 20000 }, config.expansion || {});
}

function ownedRoomCount() {
    let n = 0;
    for (const room of Object.values(Game.rooms || {})) {
        if (room.controller && room.controller.my) n++;
    }
    return n;
}

function gclHeadroom() {
    const level = Game.gcl && Number(Game.gcl.level) || 0;
    return level - ownedRoomCount();
}

function bootstrapInProgress(exceptRoom) {
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || room.name === exceptRoom) continue;
        if (!room.find(FIND_MY_SPAWNS).length) return room.name;
    }
    return null;
}

function sponsoredByAnother(roomName, homeName) {
    for (const name in Memory.rooms || {}) {
        if (name === homeName) continue;
        const expansion = Memory.rooms[name] && Memory.rooms[name].expansion;
        if (expansion && expansion.target === roomName) return true;
    }
    return false;
}

function closestSponsor(roomName) {
    const cfg = settings();
    let best = null;
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || room.name === roomName) continue;
        if (room.controller.level < cfg.minRcl || room.energyCapacityAvailable < cfg.minCapacity) continue;
        if (!room.find(FIND_MY_SPAWNS).length) continue;
        const distance = roomDistance(room.name, roomName);
        if (!best || distance < best.distance || (distance === best.distance && room.name < best.name)) best = { name: room.name, distance };
    }
    return best ? best.name : null;
}

function isActiveRemote(roomName) {
    for (const name in Memory.rooms || {}) {
        const remotes = Memory.rooms[name] && Memory.rooms[name].remotes;
        const record = remotes && !Array.isArray(remotes) ? remotes[roomName] : null;
        if (record && record.enabled) return true;
    }
    return false;
}

function expansionElsewhere(homeName) {
    for (const name in Memory.rooms || {}) {
        if (name === homeName) continue;
        const expansion = Memory.rooms[name] && Memory.rooms[name].expansion;
        if (expansion && expansion.target) return name;
    }
    return null;
}

function sameRoomStatus(a, b) {
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.getRoomStatus !== 'function') return true;
    const left = map.getRoomStatus(a);
    const right = map.getRoomStatus(b);
    return !left || !right || left.status === right.status;
}

function autoClaimOk(home, roomName, named, cheap) {
    const cfg = settings();
    if (!roomName || roomName === home.name) return false;
    const info = Memory.map && Memory.map[roomName];
    if (!info || typeof info !== 'object' || info.unreachable) return false;
    if (!(info.at >= 0) || Game.time - info.at > cfg.autoClaimFreshFor) return false;
    if (!info.controllerId) return false;
    if (info.class === 'sk' || info.class === 'center' || info.class === 'highway') return false;
    if (info.owner || Number(info.level || 0) > 0) return false;
    if (Number(info.lairs || 0) > 0) return false;
    if (!named && Number(info.sources || 0) < 2) return false;
    if (info.threat || Number(info.armedHostiles || 0) > 0 || info.invaderCore) return false;
    const me = home.controller && home.controller.owner && home.controller.owner.username;
    const reservation = info.reservation;
    if (reservation && reservation.username && reservation.username !== me && !reservation.mine) return false;
    const visible = Game.rooms[roomName];
    if (visible && visible.controller && (visible.controller.my || visible.controller.owner)) return false;
    if (sponsoredByAnother(roomName, home.name)) return false;
    if (isActiveRemote(roomName)) return false;
    const reach = homeMemory(home).claimReachability;
    if (reach && reach[roomName] && (Number(reach[roomName].failures) > 0 || reach[roomName].suspendedUntil > Game.time)) return false;
    if (cheap) return true;
    const distance = roomDistance(home.name, roomName);
    if (!(distance > 0) || distance > cfg.autoClaimRange) return false;
    if (closestSponsor(roomName) !== home.name) return false;
    if (!sameRoomStatus(home.name, roomName)) return false;
    try {
        if (!movement.safeRouteExists(home.name, roomName)) return false;
    } catch (error) {
        logErr('expansion.autoClaim route ' + roomName, error);
        return false;
    }
    return true;
}

function autoClaimCpu(cfg) {
    const bucket = Number(Game.cpu && Game.cpu.bucket);
    const minBucket = Math.max(0, Number(cfg.autoClaimMinBucket) || 0);
    const want = Math.max(1, Math.floor(Number(cfg.autoClaimCpuSamples) || 5));
    const stats = Array.isArray(Memory.stats) ? Memory.stats : [];
    const values = [];
    for (let i = stats.length - 1; i >= 0 && values.length < want; i--) {
        const used = stats[i] && Number(stats[i].cpu);
        if (Number.isFinite(used)) values.push(used);
    }
    const mean = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
    const share = Number(cfg.autoClaimMaxCpuShare);
    const line = Number.isFinite(share) && share > 0 ? Math.round((Number(Game.cpu && Game.cpu.limit) || 0) * share * 10) / 10 : Infinity;
    const ok = !(Number.isFinite(bucket) && bucket < minBucket) && !(mean != null && mean > line);
    return { ok, bucket: Number.isFinite(bucket) ? bucket : null, mean, line: Number.isFinite(line) ? line : null };
}

function autoClaimTarget(home) {
    const cfg = settings();
    if (!cfg.autoClaim) return null;
    const mem = homeMemory(home);
    const cache = mem.autoClaim;
    const interval = Math.max(100, Number(cfg.autoClaimInterval) || 1500);
    const fresh = !!cache && cache.at != null && Game.time >= cache.at && Game.time - cache.at < interval;
    if (fresh && cache.room) {
        if (autoClaimOk(home, cache.room, !!cache.named, true) && !expansionElsewhere(home.name)) return { room: cache.room, reason: 'autonomous' };
    } else if (fresh) {
        return null;
    }
    const note = (fields) => { mem.autoClaim = Object.assign({ at: Game.time, room: null }, fields); return null; };
    if (home.controller.level < cfg.minRcl || home.energyCapacityAvailable < cfg.minCapacity) return note({ why: 'home' });
    if (gclHeadroom() <= 0) return note({ why: 'gcl' });
    if (!(mem.expansion && mem.expansion.autonomous)) {
        const cpu = autoClaimCpu(cfg);
        if (!cpu.ok) {
            const held = mem.autoClaimCpuHeld || (mem.autoClaimCpuHeld = { first: Game.time, n: 0 });
            held.n = (Number(held.n) || 0) + 1;
            Object.assign(held, { at: Game.time, bucket: cpu.bucket, mean: cpu.mean, line: cpu.line });
            return note({ why: 'cpu', bucket: cpu.bucket, mean: cpu.mean, line: cpu.line });
        }
    }
    const busy = bootstrapInProgress(null) || expansionElsewhere(home.name);
    if (busy) return note({ why: 'busy:' + busy });
    let candidates;
    let from;
    const homeLock = brain.standingLock(home.name + '.claim');
    const queueLock = brain.standingLock('claim.queue');
    if (homeLock) {
        from = 'lock';
        const room = homeLock.value && typeof homeLock.value === 'object' ? homeLock.value.room : null;
        candidates = typeof room === 'string' ? [room] : [];
    } else if (queueLock && Array.isArray(queueLock.value)) {
        from = 'queue';
        candidates = queueLock.value.filter((room) => typeof room === 'string' && room);
    } else {
        from = 'map';
        candidates = Object.keys(Memory.map || {})
            .map((room) => ({ room, distance: roomDistance(home.name, room) }))
            .filter((entry) => entry.distance > 0 && entry.distance <= cfg.autoClaimRange)
            .sort((a, b) => a.distance - b.distance || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0))
            .map((entry) => entry.room);
    }
    const named = from !== 'map';
    const room = candidates.find((name) => autoClaimOk(home, name, named, false)) || null;
    if (!room) return note({ from, why: 'none' });
    mem.autoClaim = { at: Game.time, room, from, named, distance: roomDistance(home.name, room) };
    mem.autoClaimPicked = { room, from, at: Game.time, distance: mem.autoClaim.distance };
    return { room, reason: 'autonomous' };
}

function claimTarget(home) {
    const claim = brain.get(home.name, 'claim', null);
    if (claim && typeof claim === 'object' && typeof claim.room === 'string') {
        return claim.room === home.name ? null : claim;
    }
    const offline = brain.offlineMs();
    const cfg = settings();
    if (!cfg.autoClaim || offline == null || offline < Math.max(Number(cfg.autoClaimAfterMs) || 0, 1)) return null;
    const auto = autoClaimTarget(home);
    return auto && auto.room !== home.name ? auto : null;
}

function wheelSpawnPos(roomName) {
    const plan = Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].plan;
    if (!plan || !plan.wheel || !Array.isArray(plan.spawns) || !plan.spawns[0]) return null;
    return { x: plan.spawns[0].x, y: plan.spawns[0].y };
}

function targetStatus(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return { visible: false, mine: false, foreign: false, hasSpawn: false };
    const controller = room.controller;
    const mine = !!(controller && controller.my);
    const foreign = !!(controller && controller.owner && !controller.my);
    const hasSpawn = mine && room.find(FIND_MY_SPAWNS).length > 0;
    return { visible: true, mine, foreign, hasSpawn };
}

const CLAIM_TRAVEL_LEAD = 100;

function claimCapableCreep(home, roomName) {
    for (const creep of creepsHomeRole(home.name, 'reserver')) {
        if (creep.spawning) continue;
        if (creep.memory.remoteRoom !== roomName) continue;
        if (!(creep.body || []).some((part) => part.type === CLAIM && part.hits !== 0)) continue;
        if (creep.ticksToLive != null && creep.ticksToLive <= CLAIM_TRAVEL_LEAD) continue;
        return creep;
    }
    return null;
}

function demand(role, slot, body, memory, lead, priority, bodyFor) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, bodyFor };
}

function homeMemory(home) {
    Memory.rooms = Memory.rooms || {};
    Memory.rooms[home.name] = Memory.rooms[home.name] || {};
    return Memory.rooms[home.name];
}

function activeTarget(home) {
    const mem = homeMemory(home);
    const claim = claimTarget(home);
    const orphan = bootstrapInProgress(home.name);
    const orphanIsMine = !!orphan && !sponsoredByAnother(orphan, home.name) && closestSponsor(orphan) === home.name;
    if (mem.expansion && mem.expansion.autonomous && (!claim || claim.room !== mem.expansion.target) &&
        !targetStatus(mem.expansion.target).mine) {
        retireTravelers(home, mem.expansion.target);
        delete mem.expansion;
    }
    if (claim && claim.room !== home.name && !(orphanIsMine && orphan !== claim.room)) {
        mem.expansion = { target: claim.room, spawnPos: wheelSpawnPos(claim.room),
            since: mem.expansion && mem.expansion.target === claim.room ? mem.expansion.since : Game.time };
        if (claim.reason === 'autonomous') mem.expansion.autonomous = true;
        return mem.expansion;
    }
    let remembered = mem.expansion;
    if (remembered && remembered.target === home.name) { delete mem.expansion; remembered = null; }
    if (!remembered || !remembered.target) {
        const orphan = bootstrapInProgress(home.name);
        if (!orphan || sponsoredByAnother(orphan, home.name) || closestSponsor(orphan) !== home.name) return null;
        const site = Game.rooms[orphan].find(FIND_MY_CONSTRUCTION_SITES).find((s) => s.structureType === STRUCTURE_SPAWN);
        remembered = { target: orphan, spawnPos: site ? { x: site.pos.x, y: site.pos.y } : null, since: Game.time };
        mem.expansion = remembered;
    }
    const status = targetStatus(remembered.target);
    if (!status.mine || status.hasSpawn) {
        delete mem.expansion;
        return null;
    }
    return remembered;
}

function stuckTicks() {
    return Math.max(1, Number((config.remote || {}).stuckTicks) || 60);
}

function liveTravelers(home, roomName, roles) {
    const want = roles || { claimer: true, pioneer: true, reserver: true };
    return Object.values(Game.creeps || {}).filter((c) => c.memory && c.memory.home === home.name &&
        (c.memory.targetRoom === roomName || c.memory.remoteRoom === roomName) &&
        want[c.memory.role] && !c.spawning && !isRetiring(c.memory));
}

function retireTravelers(home, roomName) {
    for (const creep of liveTravelers(home, roomName, { claimer: true, pioneer: true })) {
        creep.memory.retired = true;
        retire.retireAtSpawn(creep);
    }
}

function markUnreachable(home, roomName, reason) {
    const mem = homeMemory(home);
    const records = mem.claimReachability = mem.claimReachability || {};
    const cfg = settings();
    const record = records[roomName] = records[roomName] || { failures: 0 };
    if (!(record.suspendedUntil > Game.time)) {
        record.failures = Math.min((record.failures || 0) + 1, 20);
        record.suspendedUntil = Game.time + Math.min(cfg.unreachableMaxTicks, cfg.unreachableTicks * Math.pow(2, record.failures - 1));
        record.reason = reason || 'unreachable';
        delete record.startedAt;
    }
    retireTravelers(home, roomName);
    return record;
}

function noteStuck(creep) {
    if (!creep || !creep.memory || !creep.pos) return false;
    const homeName = creep.memory.home;
    const roomName = creep.memory.targetRoom;
    if (!homeName || !roomName) return false;
    if (creep.room && creep.room.name === roomName) return false;
    if (isRetiring(creep.memory)) return false;
    const posKey = creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y;
    if (creep.memory._tp === posKey) creep.memory._ts = (creep.memory._ts || 0) + 1;
    else { creep.memory._tp = posKey; creep.memory._ts = 0; }
    if (creep.memory._ts < stuckTicks()) return false;
    creep.memory._ts = 0;
    const home = Game.rooms[homeName];
    if (!home) return false;
    markUnreachable(home, roomName, 'unreachable');
    return true;
}

function arrivalState(home, target) {
    const mem = homeMemory(home);
    const records = mem.claimReachability = mem.claimReachability || {};
    const roomName = target.target;
    const arrived = liveTravelers(home, roomName).some((c) => c.room && c.room.name === roomName);
    if (targetStatus(roomName).mine || arrived) {
        delete records[roomName];
        return { blocked: false, probing: false };
    }
    const cfg = settings();
    const record = records[roomName] = records[roomName] || { failures: 0 };
    if (record.suspendedUntil > Game.time) return { blocked: true, probing: true };
    const traveler = liveTravelers(home, roomName, { claimer: true })[0];
    if (record.startedAt == null && traveler) record.startedAt = Game.time;
    if (record.startedAt != null && Game.time - record.startedAt >= cfg.arrivalTimeout) {
        markUnreachable(home, roomName, 'unreachable');
        return { blocked: true, probing: true };
    }
    return { blocked: false, probing: record.failures > 0 };
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const cfg = settings();
    if (home.controller.level < cfg.minRcl || home.energyCapacityAvailable < cfg.minCapacity) return [];
    const target = activeTarget(home);
    if (!target) return [];
    const claim = { room: target.target, spawnPos: target.spawnPos };
    const status = targetStatus(claim.room);
    if (status.foreign) { delete homeMemory(home).expansion; return []; }
    if (!status.mine && gclHeadroom() <= 0) return [];
    if (status.hasSpawn) { delete homeMemory(home).expansion; return []; }
    const reachability = arrivalState(home, target);
    if (reachability.blocked) return [];
    const demands = [];
    let priority = 0;
    const memory = { home: home.name, targetRoom: claim.room, spawnPos: claim.spawnPos || null };
    if (!status.mine && !claimCapableCreep(home, claim.room)) {
        demands.push(demand('claimer', 'claimer:' + claim.room, ['claim', 'move'], memory, reachability.probing ? 0 : 100, priority++));
    }
    if (reachability.probing) return demands;
    const pioneerBody = makeBody('builder', Math.min(home.energyCapacityAvailable, cfg.pioneerBudget));
    for (let index = 0; index < cfg.pioneers; index++) {
        demands.push(demand('pioneer', 'pioneer:' + claim.room + ':' + index, pioneerBody, memory, 80, priority++,
            (budget) => makeBody('builder', Math.min(budget, cfg.pioneerBudget))));
    }
    return demands;
}

function run(home) {
    if (!home || !home.controller || !home.controller.my) return;
    const target = activeTarget(home);
    if (!target || !target.target) return;
    const reachability = arrivalState(home, target);
    if (reachability.blocked) retireTravelers(home, target.target);
    const room = Game.rooms[target.target];
    if (!room || !room.controller || !room.controller.my) return;
    if (room.find(FIND_MY_SPAWNS).length) return;
    const spawnPos = wheelSpawnPos(room.name) || target.spawnPos;
    if (!spawnPos) return;
    const hasSite = room.find(FIND_MY_CONSTRUCTION_SITES).some((site) => site.structureType === STRUCTURE_SPAWN);
    if (!hasSite) room.createConstructionSite(spawnPos.x, spawnPos.y, STRUCTURE_SPAWN);
}

module.exports = { run, getDemands, activeTarget, targetStatus, gclHeadroom, bootstrapInProgress, claimCapableCreep, settings, arrivalState, noteStuck, markUnreachable, autoClaimTarget, claimTarget };
