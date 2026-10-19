'use strict';
const config = require('config');
const brain = require('brain');
const { bodyCost, repeat, roomDistance } = require('utils');
const tower = require('tower');

const ARMED = ['attack', 'ranged_attack', 'heal', 'work', 'claim'];
const INTEL_FRESH_TICKS = 1500;
const ATTACK_POWER = 30;
const RANGED_ATTACK_POWER = 10;
const HEAL_POWER = 12;
const LIFE = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
const BOOSTS = {
    attack: { UH: 2, UH2O: 3, XUH2O: 4 },
    ranged_attack: { KO: 2, KHO2: 3, XKHO2: 4 },
    heal: { LO: 2, LHO2: 3, XLHO2: 4 },
    tough: { GO: 0.7, GHO2: 0.5, XGHO2: 0.3 },
};

function settings() {
    return Object.assign({ minCapacity: 260, idleTicks: 50, maxDefenders: 3, winMargin: 1.5, squadWait: 300, remoteValueShare: 0.5, maxOwnLosses: 2 },
        config.defense || {});
}

function activeParts(creep, type) {
    if (typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(type);
    return (creep.body || []).filter((part) => (part.type || part) === type && part.hits !== 0).length;
}

const COMBAT = ['attack', 'ranged_attack', 'heal'];
const NPC_OWNERS = ['Invader', 'Source Keeper'];

function isArmed(creep, strict) {
    const owner = creep && creep.owner && creep.owner.username;
    const parts = strict && NPC_OWNERS.indexOf(owner) < 0 ? COMBAT : ARMED;
    return parts.some((type) => activeParts(creep, type) > 0);
}

function armedHostiles(room) {
    const own = !!(room && room.controller && room.controller.my);
    return room.find(FIND_HOSTILE_CREEPS).filter((creep) => isArmed(creep, !own));
}

function invaderCore(room) {
    const type = typeof STRUCTURE_INVADER_CORE === 'undefined' ? 'invaderCore' : STRUCTURE_INVADER_CORE;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === type) || null;
}

const helperCache = { t: -1, map: {} };
function towerHelper(roomName) {
    if (helperCache.t !== Game.time) { helperCache.t = Game.time; helperCache.map = {}; }
    if (Object.prototype.hasOwnProperty.call(helperCache.map, roomName)) return helperCache.map[roomName];
    let helper = null;
    const room = Game.rooms[roomName];
    if (room && room.controller && room.controller.my && room.controller.level >= 3) {
        const towers = room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
        const hostiles = armedHostiles(room);
        if (towers.length && hostiles.length && hostiles.every((h) => NPC_OWNERS.indexOf(h.owner && h.owner.username) >= 0) &&
            !tower.towersCanHold(room, towers, hostiles)) {
            for (const creep of Object.values(Game.creeps || {})) {
                const m = creep.memory || {};
                if (m.role === 'defender' && m.targetRoom === roomName && !m.retired && m.home && m.home !== roomName) { helper = m.home; break; }
            }
            if (!helper) {
                const min = Number(settings().helperStorage) || 20000;
                let best = Infinity;
                for (const r of Object.values(Game.rooms || {})) {
                    if (r.name === roomName || !r.controller || !r.controller.my || !r.storage) continue;
                    if (Number(r.storage.store[RESOURCE_ENERGY] || 0) < min || !r.find(FIND_MY_SPAWNS).length) continue;
                    const d = roomDistance(r.name, roomName);
                    if (d < best || (d === best && r.name < helper)) { best = d; helper = r.name; }
                }
            }
            if (helper && typeof Memory !== 'undefined' && Memory.rooms) {
                const log = roomLog(roomName);
                if (!log.helper || log.helper.room !== helper || Game.time - Number(log.helper.at || 0) > 100) log.helper = { room: helper, at: Game.time };
            }
        }
    }
    helperCache.map[roomName] = helper;
    return helper;
}

function closestBase(roomName) {
    let best = null;
    let bestDistance = Infinity;
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || !room.find(FIND_MY_SPAWNS).length) continue;
        const distance = roomDistance(room.name, roomName);
        if (distance < bestDistance) { best = room.name; bestDistance = distance; }
    }
    return best;
}


function partList(subject) {
    if (Array.isArray(subject)) return subject.map((part) => (part && part.type ? part : { type: part }));
    return (subject && subject.body) || [];
}

function creepProfile(subject) {
    const live = !Array.isArray(subject) && subject && subject.hits != null;
    let hits = live ? Number(subject.hits) : 0;
    let dps = 0;
    let heal = 0;
    let attack = 0;
    let ranged = 0;
    let move = 0;
    let boosted = false;
    for (const part of partList(subject)) {
        if (!part || part.hits === 0) continue;
        const type = part.type;
        const mult = (part.boost && BOOSTS[type] && BOOSTS[type][part.boost]) || 1;
        if (part.boost) boosted = true;
        const partHits = part.hits == null ? 100 : part.hits;
        if (!live) hits += partHits;
        if (type === 'tough' && mult < 1) hits += partHits * (1 / mult - 1);
        if (type === 'attack') { dps += ATTACK_POWER * mult; attack++; }
        else if (type === 'ranged_attack') { dps += RANGED_ATTACK_POWER * mult; ranged++; }
        else if (type === 'heal') heal += HEAL_POWER * mult;
        else if (type === 'move') move++;
    }
    return { hits, dps, heal, kiter: ranged > 0 && attack === 0 && move > 0, boosted };
}

function hostileProfile(hostiles) {
    const out = { at: Game.time, count: 0, hits: 0, dps: 0, heal: 0, kiters: false, boosted: false, until: Game.time };
    for (const hostile of hostiles || []) {
        const profile = creepProfile(hostile);
        out.count++;
        out.hits += profile.hits;
        out.dps += profile.dps;
        out.heal += profile.heal;
        if (profile.kiter) out.kiters = true;
        if (profile.boosted) out.boosted = true;
        const ttl = Number(hostile.ticksToLive) > 0 ? Number(hostile.ticksToLive) : LIFE;
        out.until = Math.max(out.until, Game.time + ttl);
    }
    out.hits = Math.round(out.hits);
    out.dps = Math.round(out.dps);
    out.heal = Math.round(out.heal);
    return out;
}

function squadProfile(bodies) {
    const out = { hits: 0, dps: 0, heal: 0 };
    for (const body of bodies || []) {
        const profile = creepProfile(body);
        out.hits += profile.hits;
        out.dps += profile.dps;
        out.heal += profile.heal;
    }
    return out;
}

function canBeat(bodies, enemy, margin) {
    if (!enemy || !enemy.count) return true;
    const ours = squadProfile(bodies);
    const factor = margin != null ? Number(margin) : settings().winMargin;
    const enemyNet = ours.dps - enemy.heal;
    if (enemyNet <= 0) return false;
    const killTime = enemy.hits / enemyNet;
    const ourNet = enemy.dps - ours.heal;
    const surviveTime = ourNet <= 0 ? Infinity : ours.hits / ourNet;
    return killTime * factor <= surviveTime;
}

function meleeBody(attack) {
    return repeat('move', attack).concat(repeat('attack', attack));
}

function rangedBody(ranged, heal) {
    return repeat('move', ranged + heal).concat(repeat('ranged_attack', ranged), repeat('heal', heal));
}

function candidates(capacity, style) {
    const list = [];
    if (style !== 'ranged') {
        for (let attack = 2; attack <= 25; attack++) {
            const body = meleeBody(attack);
            const cost = bodyCost(body);
            if (cost > capacity) break;
            list.push({ style: 'melee', body, cost });
        }
    }
    if (style !== 'melee') {
        for (let ranged = 1; ranged <= 25; ranged++) {
            for (let heal = 0; heal <= Math.min(5, ranged); heal++) {
                const body = rangedBody(ranged, heal);
                if (body.length > 50) continue;
                const cost = bodyCost(body);
                if (cost > capacity) continue;
                list.push({ style: 'ranged', body, cost });
            }
        }
    }
    list.sort((left, right) => left.cost - right.cost || left.body.length - right.body.length);
    return list;
}

function planSquad(capacity, enemy, cfg) {
    if (!enemy || !enemy.count) return null;
    const options = cfg || settings();
    const list = candidates(capacity, enemy.kiters ? 'ranged' : null);
    let best = null;
    for (let count = 1; count <= Math.max(1, Number(options.maxDefenders) || 1); count++) {
        for (const candidate of list) {
            const bodies = [];
            for (let index = 0; index < count; index++) bodies.push(candidate.body);
            if (!canBeat(bodies, enemy, options.winMargin)) continue;
            const total = candidate.cost * count;
            if (!best || total < best.total) best = { style: candidate.style, body: candidate.body, cost: candidate.cost, count, total };
            break;
        }
    }
    return best;
}

function assemblyLead(plan, home, roomName, mem) {
    const sources = typeof home.find === 'function' ? home.find(FIND_SOURCES).length : 2;
    const fallback = (Number(config.spawnQueue && config.spawnQueue.fallbackIncomePerSource) || 5) * Math.max(1, sources);
    const ema = mem && mem.spawnIncome && Number(mem.spawnIncome.ema);
    const income = Math.max(0.5, ema > 0 ? ema : fallback);
    const spawnTicks = plan.count * plan.body.length * 3;
    const travel = Math.max(1, roomDistance(home.name, roomName)) * 50;
    return Math.ceil(plan.total / income + spawnTicks + travel);
}

function worthFighting(plan, record, profile, cfg, home, roomName, mem) {
    if (!record) return { ok: true, value: Infinity, lead: 0 };
    const sources = Number(record.sourceCount) || (record.sources && record.sources.length) || 1;
    const lead = assemblyLead(plan, home, roomName, mem);
    const remaining = Math.max(0, Number(profile.until || 0) - Game.time - lead);
    const value = Math.round(sources * 10 * remaining * (Number(cfg.remoteValueShare) || 0.5));
    return { ok: plan.total <= value, value, lead };
}

function recordThreat(record, hostiles) {
    if (!record) return null;
    record.threat = hostiles && hostiles.length ? hostileProfile(hostiles) : null;
    return record.threat;
}

function storedProfile(roomName, record) {
    const own = record && record.threat && Number(record.threat.until) > Game.time ? record.threat : null;
    const info = Memory.map && Memory.map[roomName];
    const external = info && info.hostileProfile && Number(info.hostileProfile.until) > Game.time &&
        Game.time - Number(info.hostileProfile.at != null ? info.hostileProfile.at : info.at || 0) <= INTEL_FRESH_TICKS ? info.hostileProfile : null;
    if (own && external) return Number(own.at || 0) >= Number(external.at || 0) ? own : external;
    return own || external;
}

function threatIn(roomName, record) {
    const room = Game.rooms[roomName];
    const keeperRoom = !!(record && record.sk);
    if (room) {
        const hostiles = armedHostiles(room).filter((creep) => !(keeperRoom && creep.owner && creep.owner.username === 'Source Keeper'));
        const profile = hostiles.length ? hostileProfile(hostiles) : null;
        return { visible: true, hostiles, count: hostiles.length, core: !!invaderCore(room), ranged: !!(profile && profile.kiters),
            profile, seenAt: Game.time };
    }
    const info = Memory.map && Memory.map[roomName];
    const fresh = info && Game.time - Number(info.at || 0) <= INTEL_FRESH_TICKS;
    const profile = storedProfile(roomName, record);
    const count = profile ? Number(profile.count) || 0 : (fresh && !keeperRoom ? Number(info.armedHostiles || 0) : 0);
    const core = (fresh && !!info.invaderCore) || (record && record.suspendReason === 'invaderCore');
    const hostile = count > 0 || (record && record.suspendReason === 'hostileCreep' && Number(record.suspendedUntil || 0) > Game.time);
    return { visible: false, hostiles: [], count: hostile ? Math.max(1, count) : 0, core, ranged: !!(profile && profile.kiters),
        profile, seenAt: profile ? Number(profile.at || 0) : (fresh ? Number(info.at || 0) : 0) };
}

function defenderBody(capacity, style) {
    if (style === 'ranged') {
        const ranged = Math.max(1, Math.min(10, Math.floor(capacity * 0.55 / 200)));
        const heal = Math.max(capacity >= 700 ? 1 : 0, Math.min(5, Math.floor(capacity * 0.25 / 300)));
        const body = rangedBody(ranged, heal);
        return bodyCost(body) <= capacity ? body : rangedBody(1, 0);
    }
    const attack = Math.max(2, Math.min(20, Math.floor(capacity / 130)));
    return meleeBody(attack);
}

function demand(role, slot, body, memory, lead, priority, cls) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, cls: cls || 'defense' };
}

function suspendRecord(record, until, reason) {
    if (!record) return;
    if (record.suspendedUntil === Number.MAX_SAFE_INTEGER) return;
    record.suspendedUntil = Math.max(Number(record.suspendedUntil) || 0, Number(until) || 0);
    record.suspendReason = reason || record.suspendReason || 'hostileCreep';
}

function ownRoom(home, roomName) {
    if (roomName === home.name) return true;
    const room = Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my);
}

function evaluate(home, roomName, record, cfg, orders, mem) {
    const capacity = home.energyCapacityAvailable;
    const own = ownRoom(home, roomName);
    const threat = threatIn(roomName, record);
    const out = { threat, own, plan: null, skip: null, wait: false };
    if (roomName === home.name && threat.visible) {
        const towers = home.controller.level >= 3
            ? home.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER }) : [];
        if (towers.length && tower.towersCanHold(home, towers, threat.hostiles)) return out;
    }
    if (threat.count <= 0) return out;
    const order = orders && orders[roomName] && typeof orders[roomName] === 'object' && Number(orders[roomName].until || 0) > Game.time
        ? orders[roomName] : null;
    if (order && order.action === 'avoid') {
        out.skip = { reason: 'brain:' + (order.reason || 'avoid'), until: Number(order.until) };
        return out;
    }
    const loss = (mem && mem.defenseLog && mem.defenseLog.lastLoss) || null;
    if (loss && loss.room === roomName && Number(threat.seenAt || 0) <= Number(loss.at || 0)) { out.wait = true; return out; }
    if (order && order.action === 'fight' && order.squad && Array.isArray(order.squad.body) && order.squad.body.length &&
        bodyCost(order.squad.body) <= capacity) {
        const body = order.squad.body.slice();
        out.plan = { style: order.squad.style || (body.includes('attack') ? 'melee' : 'ranged'), body,
            count: Math.max(1, Math.min(Number(cfg.maxDefenders) || 1, Number(order.squad.count) || 1)), source: 'brain' };
        return out;
    }
    const streak = own ? Number(roomLog(roomName).streak || 0) : 0;
    if (own && streak >= (Number(cfg.maxOwnLosses) || Infinity)) {
        out.skip = { reason: 'losses:' + streak, until: Number(threat.profile && threat.profile.until) || Game.time + CREEP_LIFE_TIME_FALLBACK };
        return out;
    }
    if (!threat.profile) { out.wait = true; return out; }
    const plan = planSquad(capacity, threat.profile, cfg);
    if (!plan) { out.skip = { reason: 'unwinnable', until: Number(threat.profile.until), capacity }; return out; }
    if (!own) {
        const worth = worthFighting(plan, record, threat.profile, cfg, home, roomName, mem);
        if (!worth.ok) {
            out.skip = { reason: 'notWorth:' + plan.total + '>' + worth.value, until: Number(threat.profile.until), lead: worth.lead };
            return out;
        }
    }
    out.plan = Object.assign({ source: 'model' }, plan);
    return out;
}

const CREEP_LIFE_TIME_FALLBACK = 1500;

function roomLog(roomName) {
    if (typeof Memory === 'undefined' || !Memory.rooms) return {};
    const mem = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    return mem.defenseLog || (mem.defenseLog = { spawned: 0 });
}

function remoteRecordOf(home, roomName) {
    const mem = Memory.rooms && Memory.rooms[home.name];
    return (mem && mem.remotes && mem.remotes[roomName]) || null;
}

function planFor(home, roomName) {
    if (!home || !home.controller || !home.controller.my) return null;
    const cfg = settings();
    if (home.energyCapacityAvailable < cfg.minCapacity) return null;
    const mem = Memory.rooms && Memory.rooms[home.name] || null;
    { const t = Game.rooms[roomName]; if (!(t && t.controller && t.controller.my) && require('utils').pvpDangerRoom(roomName)) return null; }
    const result = evaluate(home, roomName, remoteRecordOf(home, roomName), cfg, brain.get(home.name, 'defense', null), mem);
    if (result.plan) return result.plan;
    return !result.threat.count && result.threat.core ? { style: 'melee', count: 1, core: true } : null;
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const cfg = settings();
    const capacity = home.energyCapacityAvailable;
    if (capacity < cfg.minCapacity) return [];
    const mem = Memory.rooms && (Memory.rooms[home.name] || (Memory.rooms[home.name] = {}));
    const logOf = () => (mem ? (mem.defenseLog || (mem.defenseLog = { spawned: 0 })) : { spawned: 0 });
    const orders = brain.get(home.name, 'defense', null);
    const demands = [];
    let priority = 0;
    const seen = new Set();
    const consider = (roomName, record) => {
        if (seen.has(roomName)) return;
        seen.add(roomName);
        if (require('utils').pausedRoom(roomName)) return;
        { const t = Game.rooms[roomName]; if (!(t && t.controller && t.controller.my) && require('utils').pvpDangerRoom(roomName)) return; }
        const helper = record ? null : towerHelper(roomName);
        if (helper && helper !== home.name) return;
        if (!record && !helper && closestBase(roomName) !== home.name) return;
        if (record && record.enabled && record.staffed === false) return;
        const target = Game.rooms[roomName];
        if (target && target.controller && target.controller.my && target.controller.safeMode > 0) return;
        const result = evaluate(home, roomName, record, cfg, orders, mem);
        const threat = result.threat;
        if (threat.visible && record) recordThreat(record, threat.hostiles);
        if (result.own && threat.visible && threat.count === 0) {
            const log = roomLog(roomName);
            if (log.streak !== 0) log.streak = 0;
        }
        const cls = result.own ? 'defense' : 'remoteMaintain';
        if (result.skip) {
            logOf().skipped = Object.assign({ room: roomName, at: Game.time, count: threat.count }, result.skip);
            suspendRecord(record, result.skip.until, 'hostileCreep');
            return;
        }
        if (result.plan) {
            for (let index = 0; index < result.plan.count; index++) {
                const slot = index === 0 ? 'defender:' + roomName : 'defender:' + roomName + ':' + index;
                demands.push(demand('defender', slot, result.plan.body,
                    { home: home.name, targetRoom: roomName, style: result.plan.style, squad: result.plan.count }, 50, priority++, cls));
            }
            return;
        }
        if (!threat.count && threat.core && !(record && record.sk)) {
            demands.push(demand('defender', 'core:' + roomName, defenderBody(capacity, 'melee'),
                { home: home.name, targetRoom: roomName, style: 'melee' }, 50, priority++, cls));
        }
    };
    consider(home.name, null);
    for (const room of Object.values(Game.rooms || {})) {
        if (room.controller && room.controller.my && room.name !== home.name) consider(room.name, null);
    }
    const remotes = mem && mem.remotes || {};
    for (const [roomName, record] of Object.entries(remotes)) {
        if (record && (record.enabled || record.suspendReason === 'invaderCore' || record.suspendReason === 'hostileCreep')) consider(roomName, record);
    }
    return demands;
}

function noteLoss(name, memory) {
    if (!memory || memory.role !== 'defender' || memory.retired) return false;
    const home = memory.home;
    if (!home || typeof Memory === 'undefined' || !Memory.rooms) return false;
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
    log.losses = (log.losses || 0) + 1;
    log.lastLoss = { at: Game.time, room: memory.targetRoom || home, name, slot: memory.slotKey || null };
    const defended = roomLog(memory.targetRoom || home);
    defended.streak = (Number(defended.streak) || 0) + 1;
    console.log('[defense] ' + home + ' lost defender ' + name + ' in ' + (memory.targetRoom || home));
    return true;
}

module.exports = { towerHelper, getDemands, planFor, defenderBody, threatIn, armedHostiles, invaderCore, settings, creepProfile, hostileProfile,
    canBeat, planSquad, recordThreat, noteLoss, BOOSTS };
