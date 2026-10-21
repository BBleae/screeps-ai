'use strict';
const config = require('config');

const cache = global.__screepsCache || (global.__screepsCache = { tick: -1, data: {} });
function tickCache() {
    if (cache.tick !== Game.time) { cache.tick = Game.time; cache.data = {}; }
    return cache.data;
}
function cacheKeyFor(opts) {
    if (!opts) return '';
    const filter = typeof opts.filter === 'function' ? opts.filter.toString() : '';
    return JSON.stringify(opts) + '|' + filter;
}

const EMPTY_CREEPS = [];
let creepIndexRecount = false;
function setCreepIndexRecount(on) { creepIndexRecount = !!on; }
function tickMemoOff() { return creepIndexRecount; }
function creepIndex() {
    const c = tickCache();
    let idx = c.__creepIndex;
    if (idx && !creepIndexRecount) return idx;
    const size = Game.creeps ? Object.keys(Game.creeps).length : 0;
    if (!idx || idx.size !== size) {
        idx = { size, byHome: {}, byHomeRole: {} };
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            const memory = creep.memory;
            const home = memory && memory.home;
            if (!home) continue;
            (idx.byHome[home] || (idx.byHome[home] = [])).push(creep);
            const key = home + '|' + (memory.role || '');
            (idx.byHomeRole[key] || (idx.byHomeRole[key] = [])).push(creep);
        }
        c.__creepIndex = idx;
    }
    return idx;
}
function creepsHome(home) { return (home && creepIndex().byHome[home]) || EMPTY_CREEPS; }
function creepsHomeRole(home, role) { return (home && creepIndex().byHomeRole[home + '|' + role]) || EMPTY_CREEPS; }

function findCached(room, kind, opts) {
    const key = room.name + '|' + kind + '|' + cacheKeyFor(opts);
    const c = tickCache();
    if (!(key in c)) c[key] = room.find(kind, opts);
    return c[key];
}

const PART_COST = { move: 50, work: 100, carry: 50, claim: 600, attack: 80, ranged_attack: 150, heal: 250, tough: 10 };
function bodyCost(parts) { return parts.reduce((s, p) => s + PART_COST[p.type || p], 0); }
function repeat(part, n) { const a = []; for (let i = 0; i < n; i++) a.push(part); return a; }
function bodyPartCount(parts, type) {
    let n = 0;
    for (const part of parts || []) {
        if ((part.type || part) !== type) continue;
        if (part.hits != null && part.hits <= 0) continue;
        n++;
    }
    return n;
}
function carryCapacity(parts) { return bodyPartCount(parts, 'carry') * 50; }

function roomCoords(name) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name || '');
    if (!match) return null;
    return {
        x: match[1] === 'W' ? -(Number(match[2]) + 1) : Number(match[2]),
        y: match[3] === 'N' ? -(Number(match[4]) + 1) : Number(match[4]),
    };
}
function roomDistance(a, b) {
    const pa = roomCoords(a);
    const pb = roomCoords(b);
    if (!pa || !pb) return Infinity;
    return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}
function isRetiring(memory) {
    return !!(memory && (memory.retired || memory.bodyUpgradeRetiring || memory.crippled || memory.stuckRetiring || memory.pocketTrapped));
}
const ROLE_ESSENTIAL_PARTS = {
    harvester: ['work'], remoteMiner: ['work'],
    hauler: ['carry', 'move'], remoteHauler: ['carry', 'move'], courier: ['carry', 'move'], feeder: ['carry', 'move'], labTech: ['carry', 'move'],
    operator: ['carry'],
    upgrader: ['work', 'carry'], builder: ['work', 'carry', 'move'], pioneer: ['work', 'carry', 'move'],
    reserver: ['claim', 'move'], claimer: ['claim', 'move'],
    scout: ['move'],
    skReaper: ['heal', 'ranged_attack'],
};
function crippledParts(creep) {
    const memory = creep && creep.memory;
    const essential = memory && ROLE_ESSENTIAL_PARTS[memory.role];
    if (!essential || !Array.isArray(creep.body) || !creep.body.length) return null;
    if (!(creep.hits < creep.hitsMax)) return null;
    const lost = essential.filter((type) => bodyPartCount(creep.body, type) === 0);
    return lost.length ? lost : null;
}
function upgraderBudgetForWork(work) { return Math.max(0, work) * 100 + 150; }
function roomNameAt(x, y) {
    return (x < 0 ? 'W' + (-x - 1) : 'E' + x) + (y < 0 ? 'N' + (-y - 1) : 'S' + y);
}

const bodyMemo = new Map();
function makeBody(role, cap, opts) {
    cap = Math.max(200, cap || 200);
    const key = role + '|' + cap + '|' + (opts ? (opts.maxWork + '|' + opts.move + '|' + opts.carry) : '');
    const hit = bodyMemo.get(key);
    if (hit) return hit.slice();
    const built = makeBodyNow(role, cap, opts);
    if (bodyMemo.size > 2000) bodyMemo.clear();
    bodyMemo.set(key, built.slice());
    return built;
}

function makeBodyNow(role, cap, opts) {
    let parts;
    switch (role) {
        case 'harvester': {
            if (cap < 300) {
                parts = ['work', 'carry', 'move'];
            } else if (cap < 450) {
                parts = ['work', 'work', 'carry', 'move'];
            } else if (cap < 550) {
                parts = ['work', 'work', 'work', 'carry', 'move', 'move'];
            } else if (cap < 600) {
                parts = ['work', 'work', 'work', 'work', 'carry', 'move', 'move'];
            } else {
                parts = ['work', 'work', 'work', 'work', 'work', 'carry', 'move'];
            }
            break;
        }
        case 'staticHarvester': {
            const work = Math.max(1, Math.min(5, Math.floor((cap - 50) / 100)));
            const move = Math.max(1, Math.min(Math.ceil(work / 2), Math.floor((cap - work * 100) / 50)));
            parts = repeat('work', work).concat(repeat('move', move));
            break;
        }
        case 'hauler': {
            const n = Math.max(1, Math.min(16, Math.floor(cap / 150)));
            parts = [];
            for (let i = 0; i < n; i++) parts.push('carry', 'carry', 'move');
            let remainder = cap - bodyCost(parts);
            if (n < 16 && remainder >= 100) {
                parts.push('carry', 'move');
                remainder -= 100;
            }
            if (n < 16 && remainder >= 50 && parts.length < 50) parts.push('move');
            break;
        }
        case 'upgrader': {
            const maxWork = Math.max(1, Number(opts && opts.maxWork) || 15);
            if (cap >= 300 && cap < 350 && maxWork >= 2) {
                parts = ['work', 'work', 'carry', 'move'];
                break;
            }
            const mv = Math.max(1, Math.floor(Number(opts && opts.move) || 1));
            if (mv > 1) {
                let w2 = Math.max(1, Math.min(maxWork, Math.floor((cap - 100 - 50 * mv) / 100), 50 - mv - 2));
                const c2 = Math.max(1, Math.min(4, Math.floor((cap - w2 * 100 - 50 * mv) / 50), 50 - w2 - mv));
                if (w2 * 100 + c2 * 50 + mv * 50 > cap) w2 = Math.max(1, w2 - 1);
                parts = repeat('work', w2).concat(repeat('carry', c2), repeat('move', mv));
                break;
            }
            const w = Math.max(1, Math.min(maxWork, Math.floor((cap - 150) / 100), 47));
            const c = Math.max(1, Math.min(Math.max(2, Math.min(6, Math.floor((cap - 150 - w * 100) / 50))), 50 - w - 1));
            parts = repeat('work', w).concat(repeat('carry', c), ['move']);
            break;
        }
        case 'builder': {
            const n = Math.max(1, Math.min(6, Math.floor(cap / 200)));
            parts = [];
            for (let i = 0; i < n; i++) parts.push('work', 'carry', 'move');
            const remainder = cap - bodyCost(parts);
            if (remainder >= 150 && parts.length + 2 <= 50) parts.push('work', 'move');
            else if (remainder >= 100 && parts.length + 2 <= 50) parts.push('carry', 'move');
            break;
        }
        case 'feeder': {
            let carry = Math.max(2, Math.min(16, Math.floor(Number(opts && opts.carry) || 4)));
            parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2)));
            while (bodyCost(parts) > cap && carry > 2) { carry--; parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2))); }
            break;
        }
        case 'operator': {
            let carry = Math.max(1, Math.min(16, Math.floor(Number(opts && opts.carry) || 8)));
            parts = repeat('carry', carry).concat(['move']);
            while (bodyCost(parts) > cap && carry > 1) { carry--; parts = repeat('carry', carry).concat(['move']); }
            break;
        }
        case 'labTech': {
            let carry = Math.max(2, Math.min(32, Math.floor(Number(opts && opts.carry) || 10)));
            parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2)));
            while (bodyCost(parts) > cap && carry > 2) { carry--; parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2))); }
            break;
        }
        case 'scout':
            parts = ['move', 'move'];
            break;
        case 'remoteMiner': {
            if (cap >= 700) parts = repeat('work', 5).concat(['carry'], repeat('move', 3));
            else if (cap >= 550) parts = repeat('work', 4).concat(['carry'], repeat('move', 2));
            else if (cap >= 500) parts = repeat('work', 3).concat(['carry'], repeat('move', 2));
            else parts = ['work', 'carry', 'move'];
            break;
        }
        case 'remoteHauler': {
            const n = Math.max(1, Math.min(16, Math.floor(cap / 150)));
            parts = [];
            for (let i = 0; i < n; i++) parts.push('carry', 'carry', 'move');
            break;
        }
        case 'reserver': {
            if (cap >= 1300) parts = ['claim', 'claim', 'move', 'move'];
            else if (cap >= 650) parts = ['claim', 'move'];
            else parts = [];
            break;
        }
        default:
            parts = ['work', 'carry', 'move'];
    }
    while (parts.length > 50) parts.pop();
    if (bodyCost(parts) > cap) parts = ['work', 'carry', 'move'];
    return parts;
}

function planPath(room, from, to) {
    const ret = PathFinder.search(from, { pos: to, range: 1 }, {
        plainCost: 2, swampCost: 8, maxRooms: 1,
    });
    if (ret.incomplete || !ret.path.length) return null;
    return ret.path.map((p) => p.x + '.' + p.y).join(';');
}
function unpackPath(str) {
    return str.split(';').map((s) => { const [x, y] = s.split('.'); return { x: +x, y: +y }; });
}
function packedPathLength(str) { return str ? str.split(';').length : 0; }
function pathLength(from, to, opts) {
    const key = [
        'pathlen',
        from.roomName || '',
        from.x, from.y,
        to.roomName || from.roomName || '',
        to.x, to.y,
        opts && opts.range != null ? opts.range : 1,
    ].join('|');
    const c = tickCache();
    if (c[key] != null) return c[key];
    const ret = PathFinder.search(from, { pos: to, range: opts && opts.range != null ? opts.range : 1 }, Object.assign({
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
    }, opts || {}));
    if (!ret.incomplete && ret.path && ret.path.length) {
        c[key] = ret.path.length;
        return c[key];
    }
    c[key] = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    return c[key];
}

function isWall(room, x, y) {
    return room.getTerrain().get(x, y) === TERRAIN_MASK_WALL;
}
function occupied(room, x, y) {
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    if (structures.some((structure) => structure.structureType !== STRUCTURE_ROAD &&
        structure.structureType !== STRUCTURE_RAMPART)) return true;
    return room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0;
}
function bestAdjacent(near, room, base, taken) {
    let best = null, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = near.x + dx, y = near.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (isWall(room, x, y) || occupied(room, x, y)) continue;
        if (taken && taken.has(x + '.' + y)) continue;
        const d = base ? (x - base.x) ** 2 + (y - base.y) ** 2 : 0;
        if (d < bestD) { bestD = d; best = { x, y }; }
    }
    return best;
}

function countRole(room, role) {
    return creepsHomeRole(room.name, role).length;
}

const energyBudgetCache = { time: -1, rooms: {} };
function roomEnergyBudget(room) {
    if (energyBudgetCache.time !== Game.time) { energyBudgetCache.time = Game.time; energyBudgetCache.rooms = {}; }
    if (energyBudgetCache.rooms[room.name] != null) return energyBudgetCache.rooms[room.name];
    const settings = config.ramparts || {};
    const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const flow = Math.max(0, Number(mem && mem.spawnIncome && mem.spawnIncome.ema) || 0);
    const bankTicks = Math.max(1, Number(settings.storageTicks) || 10000);
    const bank = room.storage && room.storage.my !== false && room.storage.store
        ? Math.max(0, Number(room.storage.store[RESOURCE_ENERGY] || 0)) / bankTicks : 0;
    const budget = Math.max(flow, bank);
    energyBudgetCache.rooms[room.name] = budget;
    return budget;
}

const upgraderWorkCache = { time: -1, rooms: {} };
function upgraderWork(room) {
    if (upgraderWorkCache.time !== Game.time) { upgraderWorkCache.time = Game.time; upgraderWorkCache.rooms = {}; }
    if (upgraderWorkCache.rooms[room.name] != null) return upgraderWorkCache.rooms[room.name];
    let work = 0;
    for (const creep of creepsHomeRole(room.name, 'upgrader')) {
        if (creep.spawning) continue;
        if (isRetiring(creep.memory)) continue;
        work += bodyPartCount(creep.body, 'work');
    }
    if (room.controller && room.controller.level >= 8) work = Math.min(work, 15);
    upgraderWorkCache.rooms[room.name] = work;
    return work;
}

const sourceSupplyCache = { time: -1, rooms: {} };
function sourceSupply(room) {
    if (sourceSupplyCache.time !== Game.time) { sourceSupplyCache.time = Game.time; sourceSupplyCache.rooms = {}; }
    if (sourceSupplyCache.rooms[room.name] != null) return sourceSupplyCache.rooms[room.name];
    const regen = Math.max(1, Number((config.harvesting || {}).regenerationTicks) || 300);
    const kind = typeof FIND_SOURCES === 'undefined' ? 'sources' : FIND_SOURCES;
    const sources = typeof room.find === 'function' ? room.find(kind) || [] : [];
    let supply = 0;
    for (const source of sources) {
        const capacity = Number(source && source.energyCapacity);
        supply += capacity > 0 ? capacity / regen : 10;
    }
    sourceSupplyCache.rooms[room.name] = supply;
    return supply;
}

function upgradeBudgetLow(room, mem) {
    const settings = config.upgrading || {};
    if (!mem) return false;
    const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
    const storage = room && room.storage;
    if (!storage || storage.my === false || !storage.store) { track.low = false; return false; }
    const energy = Number(storage.store[RESOURCE_ENERGY] || 0);
    const lowBelow = Math.max(0, Number(settings.lowBelow) || 0);
    const exitAbove = Math.max(lowBelow, Number(settings.lowExitAbove) || lowBelow);
    if (track.low) {
        if (energy >= exitAbove) track.low = false;
    } else if (energy < lowBelow) {
        track.low = true;
    }
    return !!track.low;
}

function upgradeCompeting(room, mem) {
    const settings = config.upgrading || {};
    const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    const state = mem.state || {};
    const construction = config.construction || {};
    const why = [];
    if (Number(state.builderBacklog) > 0) why.push('backlog');
    if (Number(state.builderRepairDebt) >= Math.max(1, Number(construction.outOfReachMinDebt) || 10000)) why.push('repair');
    if (spawnWaitingFor(room)) why.push('spawn');
    const available = Number(room.energyAvailable);
    const capacity = Number(room.energyCapacityAvailable);
    const unfullShare = Math.max(0, Math.min(1, Number(settings.competeUnfullShare) || 0.8));
    if (available < capacity * unfullShare) {
        if (!(Number(track.unfullSince) > 0)) track.unfullSince = now;
        if (now - Number(track.unfullSince) >= Math.max(1, Number(settings.competeUnfullTicks) || 100)) why.push('unfull');
    } else {
        if (track.unfullSince) track.unfullSince = 0;
        if (available < capacity) {
            const seen = track.unfullIgnored;
            if (!seen || seen.at !== now) track.unfullIgnored = { at: now, n: (Number(seen && seen.n) || 0) + 1 };
        }
    }
    if (why.length) { track.competeAt = now; track.competeWhy = why.join(','); }
    return track.competeAt != null && now - Number(track.competeAt) < Math.max(1, Number(settings.competeHoldTicks) || 300);
}

function bankingWorkCap(room) {
    const share = Number(((config.upgrading || {}).bankRooms || {})[room && room.name]);
    if (!(share > 0 && share < 1)) return null;
    return Math.max(1, Math.floor(sourceSupply(room) * share));
}

function linkSupplyWork(room, m, cfg) {
    const links = m && m.plan && m.plan.links;
    const a = links && links.store;
    const b = links && links.ctrl;
    const cap = Math.max(1, Number(cfg && cfg.linkWorkCap) || 75);
    if (!a || !b) return Math.min(cap, 30);
    const loss = typeof LINK_LOSS_RATIO !== 'undefined' ? LINK_LOSS_RATIO : 0.03;
    const size = typeof LINK_CAPACITY !== 'undefined' ? LINK_CAPACITY : 800;
    const d = Math.max(1, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    return Math.max(1, Math.min(cap, Math.floor(size * (1 - loss) / d)));
}

function upgradeSurplusWork(room, mem) {
    const lx = lootExcessWork(room);
    if (lx != null) return lx;
    const cfg = (config.energy || {}).upgradeSurplus;
    if (!cfg || !room || !Array.isArray(cfg.rooms) || cfg.rooms.indexOf(room.name) < 0) return 0;
    const store = room.storage && room.storage.my !== false && room.storage.store;
    const energy = store ? Number(store[typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy'] || 0) : 0;
    const m = mem || (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    const prev = m.upgradeSurplus;
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    if (prev && prev.t === now) return prev.work;
    const own = room.controller && room.controller.level < 8 && cfg.tiersByRoom && Array.isArray(cfg.tiersByRoom[room.name]) ? cfg.tiersByRoom[room.name] : null;
    const rawTiers = own || (Array.isArray(cfg.tiers) ? cfg.tiers : []);
    const tiers = rawTiers.map(([at, w]) => [at, w === 'link' ? linkSupplyWork(room, m, cfg) : Number(w) || 0]).sort((a, b) => a[0] - b[0]);
    const ownExit = own && cfg.exitBelowByRoom && Number(cfg.exitBelowByRoom[room.name]);
    const exitBelow = Math.max((ownExit > 0 ? ownExit : Number(cfg.exitBelow)) || 0, 0);
    const reserve = Math.max(Number(cfg.reserve) || 0, 0);
    const band = tiers.length ? Math.max(0, tiers[0][0] - exitBelow) : 0;
    const was = prev ? Number(prev.work) || 0 : 0;
    let work = 0;
    for (const [at, w] of tiers) if (energy >= at) work = w;
    if (!work && was && energy >= exitBelow) work = tiers.length ? tiers[0][1] : 0;
    if (was > work && energy >= exitBelow) {
        for (const [at, w] of tiers) if (w === was && energy >= at - band) work = Math.max(work, w);
    }
    if (energy < Math.max(exitBelow, reserve - band)) work = 0;
    if (!prev || prev.work !== work) m.upgradeSurplus = { work, t: now, at: now, energy };
    else { prev.t = now; }
    return work;
}

function surplusBodyPlan(room, tier) {
    const cfg = (config.energy || {}).upgradeSurplus || {};
    const per = Math.max(1, Number(cfg.workPerMove) || 5);
    const cap = Math.max(300, Number(room && room.energyCapacityAvailable) || 300);
    const slots = Math.max(0, Number((cfg.maxCreepsByRoom || {})[room && room.name]) || 0);
    let limit = slots ? 50 : Math.max(1, Number(cfg.maxWorkPerCreep) || 25);
    while (limit > 1 && (limit * 100 + Math.ceil(limit / per) * 50 + 100 > cap || limit + Math.ceil(limit / per) + 2 > 50)) limit--;
    let k = Math.max(1, Math.ceil(tier / limit));
    if (slots) k = Math.min(k, slots);
    const work = Math.min(limit, Math.ceil(tier / k));
    return { work, move: Math.ceil(work / per), slots: slots || null };
}

function upgraderWorkCap(room, mem) {
    const surplus = upgradeSurplusWork(room, mem);
    if (surplus > 0) return surplus;
    const bank = bankingWorkCap(room);
    if (bank != null) return bank;
    if (!upgradeBudgetLow(room, mem)) return Infinity;
    const settings = config.upgrading || {};
    const share = Number(settings.incomeShare);
    if (!Number.isFinite(share) || share <= 0 || share >= 1) return Infinity;
    const track = mem.upgradeSupply;
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    const note = (key) => {
        const entry = track[key];
        if (entry && entry.at === now) return;
        track[key] = { at: now, n: (Number(entry && entry.n) || 0) + 1 };
    };
    if (!upgradeCompeting(room, mem)) { note('capFree'); return Infinity; }
    note('capHeld');
    return Math.max(1, Math.floor(sourceSupply(room) * share));
}

function upgraderSupplyWork(room, mem) {
    const storage = room && room.storage;
    if (!storage || storage.my === false || !storage.store) return null;
    const settings = config.upgrading || {};
    const floor = Math.max(0, Number(settings.lowExitAbove) || 0);
    const drainTicks = Math.max(1, Number(settings.storageDrainTicks) || 1500);
    const tier = upgradeSurplusWork(room, mem);
    if (tier > 0) return room.controller && room.controller.level >= 8 ? Math.min(tier, 15) : tier;
    const surplus = Math.max(0, Number(storage.store[RESOURCE_ENERGY] || 0) - floor) / drainTicks;
    let cap = Math.max(1, Math.ceil(sourceSupply(room)) + Math.floor(surplus));
    if (room.controller && room.controller.level >= 8) cap = Math.min(cap, 15);
    const bank = bankingWorkCap(room);
    if (bank != null) cap = Math.min(cap, bank);
    return cap;
}

const rampartCountCache = { time: -1, rooms: {} };
function rampartCount(room) {
    if (rampartCountCache.time !== Game.time) { rampartCountCache.time = Game.time; rampartCountCache.rooms = {}; }
    if (rampartCountCache.rooms[room.name] != null) return rampartCountCache.rooms[room.name];
    const kind = typeof FIND_MY_STRUCTURES === 'undefined' ? 'myStructures' : FIND_MY_STRUCTURES;
    const rampartType = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
    const count = (room.find(kind) || []).filter((s) => s.structureType === rampartType).length;
    rampartCountCache.rooms[room.name] = Math.max(1, count);
    return rampartCountCache.rooms[room.name];
}

function repairTargetHits(room, structure) {
    if (!structure || structure.hitsMax == null) return 0;
    if (structure.structureType === STRUCTURE_RAMPART) {
        const level = room && room.controller ? Number(room.controller.level) || 0 : 0;
        const table = config.rampartTargetHits || {};
        const byLevel = table[level] == null ? 0 : Number(table[level]) || 0;
        const cap = Math.max(0, Math.min(structure.hitsMax, Number(config.rampartRepairCap) || Infinity, byLevel));
        if (!(cap > 0) || !room || typeof room.find !== 'function') return cap;
        const settings = config.ramparts || {};
        const share = Math.max(0, Number(settings.incomeShare) || 0);
        const raiseTicks = Math.max(0, Number(settings.raiseTicks) || 0);
        const hitsPerEnergy = Math.max(1, Number(settings.hitsPerEnergy) || 80);
        const floorHits = Math.max(0, Number(settings.floorHits) || 0);
        const affordable = roomEnergyBudget(room) * share * raiseTicks * hitsPerEnergy / rampartCount(room);
        const roomFloor = room && config.rampartFloorByRoom ? Math.min(structure.hitsMax, Number(config.rampartFloorByRoom[room.name]) || 0) : 0;
        const posTable = room && config.rampartFloorByPos ? config.rampartFloorByPos[room.name] : null;
        const posFloor = posTable && structure.pos ? Math.min(structure.hitsMax, Number(posTable[structure.pos.x + ',' + structure.pos.y]) || 0) : 0;
        return Math.max(roomFloor, posFloor, Math.max(0, Math.min(cap, Math.max(floorHits, affordable))));
    }
    return structure.hitsMax;
}
function criticallyDamaged(room, structure) {
    if (!structure || structure.hits == null) return false;
    if (structure.structureType === STRUCTURE_RAMPART) return false;
    if (structure.structureType === STRUCTURE_WALL) return false;
    if (!plannedStructure(room, structure)) return false;
    const share = Number(config.criticalRepairShare);
    if (!Number.isFinite(share) || share <= 0) return false;
    const target = repairTargetHits(room, structure);
    return target > 0 && structure.hits < target * share;
}

const criticalRoomCache = { time: -1, rooms: {} };
function hasCriticalStructure(room) {
    if (criticalRoomCache.time !== Game.time) { criticalRoomCache.time = Game.time; criticalRoomCache.rooms = {}; }
    if (criticalRoomCache.rooms[room.name] != null) return criticalRoomCache.rooms[room.name];
    const kind = typeof FIND_STRUCTURES === 'undefined' ? 'structures' : FIND_STRUCTURES;
    const found = findCached(room, kind).some((s) => criticallyDamaged(room, s));
    criticalRoomCache.rooms[room.name] = found;
    return found;
}

function repairPriority(room, structure) {
    return criticallyDamaged(room, structure) ? 0 : 1;
}

function compareRepairTargets(room, a, b) {
    const byClass = repairPriority(room, a) - repairPriority(room, b);
    if (byClass !== 0) return byClass;
    return (a.hits / Math.max(1, repairTargetHits(room, a))) - (b.hits / Math.max(1, repairTargetHits(room, b)));
}

function rampartProtectsCore(room, x, y) {
    if (!room || typeof room.lookForAt !== 'function') return false;
    const types = [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_TERMINAL];
    return (room.lookForAt(LOOK_STRUCTURES, x, y) || []).some((s) => s && s.my !== false && types.includes(s.structureType));
}

const planRoadKeyCache = { time: -1, rooms: {} };
function planRoadKeys(room, plan) {
    if (planRoadKeyCache.time !== Game.time) { planRoadKeyCache.time = Game.time; planRoadKeyCache.rooms = {}; }
    const cacheKey = room.name + '|' + (plan.version || '') + '|' + (plan.made || '');
    if (planRoadKeyCache.rooms[cacheKey]) return planRoadKeyCache.rooms[cacheKey];
    const keys = new Set();
    for (const packed of Object.values(plan.roads || {})) {
        if (typeof packed !== 'string' || !packed) continue;
        for (const point of packed.split(';')) if (point) keys.add(point);
    }
    planRoadKeyCache.rooms[cacheKey] = keys;
    return keys;
}

function plannedStructure(room, structure) {
    if (!structure || !structure.pos) return true;
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room && room.name];
    const plan = mem && mem.plan;
    if (!plan || !plan.wheel) return true;
    if (structure.structureType === STRUCTURE_ROAD) {
        return !plan.roads || planRoadKeys(room, plan).has(structure.pos.x + '.' + structure.pos.y);
    }
    if (structure.structureType === STRUCTURE_CONTAINER) {
        if (!plan.containers) return true;
        return Object.values(plan.containers).some((pos) => pos && pos.x === structure.pos.x && pos.y === structure.pos.y);
    }
    if (structure.structureType === STRUCTURE_RAMPART) {
        if (!Array.isArray(plan.ramparts)) return true;
        return plan.ramparts.some((pos) => pos && pos.x === structure.pos.x && pos.y === structure.pos.y) ||
            rampartProtectsCore(room, structure.pos.x, structure.pos.y);
    }
    return true;
}

const siteTally = { tick: -1 };
function siteSettings() {
    const cfg = config.sites || {};
    const n = (value, fallback) => (value == null || Number.isNaN(Number(value)) ? fallback : Number(value));
    return {
        limit: n(cfg.limit, typeof MAX_CONSTRUCTION_SITES === 'number' ? MAX_CONSTRUCTION_SITES : 100),
        nonRoadPerRoom: n(cfg.nonRoadPerRoom, 5),
        nonRoadMax: n(cfg.nonRoadMax, 60),
        repairReserve: n(cfg.waveRoadReserve, 6),
        lowTypes: Array.isArray(cfg.lowTypes) ? cfg.lowTypes : [STRUCTURE_LAB, STRUCTURE_FACTORY],
        lowAfterRoadBlocked: n(cfg.lowAfterRoadBlocked, 1500),
        lowRooms: Array.isArray(cfg.lowRooms) ? cfg.lowRooms : null,
        labAtRcl8: cfg.labAtRcl8 === true,
        labSpotRooms: cfg.labSpotsByRoom && typeof cfg.labSpotsByRoom === 'object' ? Object.keys(cfg.labSpotsByRoom) : [],
    };
}

function tallySites() {
    if (siteTally.tick === Game.time && siteTally.source === Game.constructionSites) return siteTally;
    if (siteTally.tick >= 0 && typeof Memory !== 'undefined' && Memory) {
        const log = Memory.siteCap || (Memory.siteCap = {});
        Object.assign(log, { at: siteTally.tick, total: siteTally.total, nonRoad: siteTally.nonRoad, blocked: siteTally.blocked });
        if (siteTally.roadBlocked) log.roadBlockedAt = siteTally.tick;
    }
    Object.assign(siteTally, { tick: Game.time, source: Game.constructionSites, total: 0, nonRoad: 0, byRoom: {}, blocked: {}, roadBlocked: false });
    for (const site of Object.values(Game.constructionSites || {})) countSite(site.pos && site.pos.roomName, site.structureType);
    return siteTally;
}

function countSite(roomName, type, delta = 1) {
    siteTally.total += delta;
    if (type === STRUCTURE_ROAD) return;
    siteTally.nonRoad += delta;
    siteTally.byRoom[roomName] = (siteTally.byRoom[roomName] || 0) + delta;
}

function waveRoadsPending() {
    const wave = typeof Memory !== 'undefined' && Memory && Memory.roadWave;
    return !!wave && (wave.active || []).some((key) => {
        const log = (Memory.rooms[String(key).split(':')[0]] || {}).roadWave;
        return log && log.route === key && Number(log.need) > 0;
    });
}

function siteTier(type, wave) {
    if (type === STRUCTURE_ROAD) return wave ? 'wave' : 'road';
    return siteSettings().lowTypes.indexOf(type) >= 0 ? 'low' : 'core';
}

function rcl8Room(roomName) {
    const room = typeof Game !== 'undefined' && Game.rooms && Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my && room.controller.level >= 8);
}

function addOnce(list, value) {
    if (list.indexOf(value) < 0) list.push(value);
}

function applyRcl8Auto() {
    const auto = config.rcl8Auto;
    if (!auto || typeof Game === 'undefined' || !Game.rooms) return 0;
    let applied = 0;
    for (const roomName of Object.keys(auto)) {
        if (!rcl8Room(roomName)) continue;
        const spec = auto[roomName] || {};
        const ind = config.industry || (config.industry = {});
        if (spec.labRoom) {
            addOnce(ind.labRooms || (ind.labRooms = []), roomName);
            addOnce(ind.labFullOutputs || (ind.labFullOutputs = []), roomName);
        }
        if (Array.isArray(spec.chain)) (ind.chainTargetsByRoom || (ind.chainTargetsByRoom = {}))[roomName] = spec.chain.slice();
        if (Array.isArray(spec.noMake)) (ind.labNoMakeByRoom || (ind.labNoMakeByRoom = {}))[roomName] = spec.noMake.slice();
        if (spec.want) {
            const tn = config.terminalNetwork || (config.terminalNetwork = {});
            const want = tn.mineralWantByRoom || (tn.mineralWantByRoom = {});
            want[roomName] = Object.assign({}, want[roomName] || {}, spec.want);
        }
        const b = config.market && config.market.buy;
        if (b && (Array.isArray(spec.buy) || Array.isArray(spec.buyDrop))) {
            const only = b.onlyRooms || (b.onlyRooms = {});
            for (const res of spec.buy || []) {
                addOnce(only[res] || (only[res] = []), roomName);
                addOnce(b.rooms || (b.rooms = []), roomName);
            }
            for (const res of spec.buyDrop || []) {
                if (Array.isArray(only[res])) only[res] = only[res].filter((n) => n !== roomName);
            }
        }
        const mem = Memory.rcl8Auto || (Memory.rcl8Auto = {});
        if (!mem[roomName]) mem[roomName] = Game.time;
        applied++;
    }
    return applied;
}

function rcl8Ready(rooms) {
    return !Array.isArray(rooms) || rooms.every(rcl8Room);
}

function blockedTradeRoom(roomName) {
    if (!roomName) return false;
    const mc = config.market || {};
    if (Array.isArray(mc.blockTradeRooms) && mc.blockTradeRooms.indexOf(roomName) >= 0) return true;
    const learned = typeof Memory !== 'undefined' && Memory.market && Memory.market.blockedRooms;
    if (learned && learned[roomName]) return true;
    const threat = (config.pvp || {}).highThreat || [];
    const oc = typeof Memory !== 'undefined' && Memory.ownerCache && Memory.ownerCache.rooms && Memory.ownerCache.rooms[roomName];
    return !!(oc && threat.indexOf(oc.o) >= 0);
}

function siteAllowed(roomName, type, wave) {
    const cfg = siteSettings();
    const tally = tallySites();
    const tier = siteTier(type, wave);
    if (tally.total >= cfg.limit) return false;
    if (tier === 'wave') return true;
    if (tier === 'road') return tally.total < cfg.limit - cfg.repairReserve;
    if (tally.nonRoad >= cfg.nonRoadMax || (tally.byRoom[roomName] || 0) >= cfg.nonRoadPerRoom) return false;
    if (tier === 'core') return true;
    const isLab = type === (typeof STRUCTURE_LAB === 'undefined' ? 'lab' : STRUCTURE_LAB);
    if (cfg.lowRooms && cfg.lowRooms.indexOf(roomName) < 0 && !(isLab && ((cfg.labAtRcl8 && rcl8Room(roomName)) || cfg.labSpotRooms.indexOf(roomName) >= 0))) return false;
    const roadBlockedAt = Math.max(Number(Memory.siteCap && Memory.siteCap.roadBlockedAt) || 0, tally.roadBlocked ? Game.time : 0);
    return !waveRoadsPending() && Game.time - roadBlockedAt >= cfg.lowAfterRoadBlocked;
}

function placeSite(room, x, y, type, wave) {
    if (!siteAllowed(room.name, type, wave)) {
        const tier = siteTier(type, wave);
        siteTally.blocked[tier] = (siteTally.blocked[tier] || 0) + 1;
        if (tier !== 'core' && tier !== 'low') siteTally.roadBlocked = true;
        return ERR_FULL;
    }
    const ret = room.createConstructionSite(x, y, type);
    if (ret === OK) countSite(room.name, type);
    return ret;
}

function removeSite(site, reason) {
    if (!site || typeof site.remove !== 'function') return false;
    if ((Number(site.progress) || 0) > 0) return false;
    const ret = site.remove();
    const ok = ret == null || ret === OK;
    if (ok && site.pos && siteTally.tick === Game.time && siteTally.source === Game.constructionSites) countSite(site.pos.roomName, site.structureType, -1);
    if (ok && site.pos && typeof Memory !== 'undefined' && Memory) {
        const all = Memory.siteRemovals || (Memory.siteRemovals = {});
        const r = all[site.pos.roomName] || (all[site.pos.roomName] = {});
        r[reason] = (Number(r[reason]) || 0) + 1;
        r.at = Game.time;
    }
    return ok;
}

const armedCache = { time: -1, rooms: {} };
function armedHostiles(room) {
    if (!room || typeof room.find !== 'function') return false;
    if (armedCache.time !== Game.time) { armedCache.time = Game.time; armedCache.rooms = {}; }
    const hit = armedCache.rooms[room.name];
    if (hit !== undefined) return hit;
    const parts = [ATTACK, RANGED_ATTACK, WORK];
    const armed = (room.find(FIND_HOSTILE_CREEPS) || []).some((c) => typeof c.getActiveBodyparts === 'function'
        ? parts.some((p) => c.getActiveBodyparts(p) > 0)
        : (c.body || []).some((b) => b && b.hits !== 0 && parts.includes(b.type || b)));
    armedCache.rooms[room.name] = armed;
    return armed;
}

function wallFloorHits() {
    return Math.max(0, Number(config.towerWallHits) || 0);
}

function rampartRaiseAllowed(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && room && Memory.rooms[room.name];
    return !!(mem && mem.storageRich && mem.storageRich.on) || armedHostiles(room);
}

function needsRepair(room, structure) {
    if (!structure || structure.hits == null || structure.hitsMax == null) return false;
    if (structure.structureType === STRUCTURE_WALL) return false;
    if (!plannedStructure(room, structure)) return false;
    if (structure.structureType === STRUCTURE_RAMPART) {
        if (!(structure.hits < repairTargetHits(room, structure))) return false;
        const floor = wallFloorHits();
        return !(floor > 0) || structure.hits < floor || rampartRaiseAllowed(room);
    }
    return structure.hits < structure.hitsMax * config.towerRepairBelow;
}

function logErr(where, e) {
    if (!Memory.errors) Memory.errors = [];
    Memory.errors.unshift({
        t: Game.time, where,
        msg: (e && e.message) || String(e),
        stack: e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : '',
    });
    Memory.errors.length = Math.min(Memory.errors.length, 20);
    console.log(`<span style="color:red">[ERR] ${where}: ${(e && e.message) || e}</span>`);
}

const ROLE_CHARACTERS = {
    harvester: '穣子',
    hauler: '荷取',
    upgrader: '慧音',
    builder: '霖之助',
    pioneer: '魔理沙',
    claimer: '灵梦',
    reserver: '诹访子',
    scout: '文文',
    defender: '美铃',
    remoteMiner: '勇仪',
    remoteHauler: '阿燐',
    courier: '铃仙',
    feeder: '橙',
    operator: '紫',
    mineralMiner: '雏田',
    labTech: '帕秋莉',
    skReaper: '妹红',
    wallBreaker: '芙兰',
    depositMiner: '萃香',
    depositScout: '琪露诺',
    siegeDismantler: '拆墙',
    warrior: '战猫',
};

const UNNAMED_ROLE_CHARACTER = '妖精';

const NAME_PREFIXES = ['', '小', '幻', '梦', '宵', '绯', '苍', '幽', '隐', '真', '深', '常', '永', '雅', '新'];
const NAME_SUFFIXES = ['', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

let nameFallbackSeq = 0;

function usedNameStems() {
    const used = new Set();
    if (typeof Game !== 'undefined' && Game.creeps) for (const name in Game.creeps) used.add(name.split('.')[0]);
    if (typeof Memory !== 'undefined' && Memory.creeps) for (const name in Memory.creeps) used.add(name.split('.')[0]);
    return used;
}

function roomPhase(name, interval) {
    if (!interval || interval <= 1) return 0;
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
    return hash % interval;
}

function isRoomPhaseTick(name, interval) {
    return Game.time % interval === roomPhase(name, interval);
}

function creepName(role, tag) {
    const base = ROLE_CHARACTERS[role] || UNNAMED_ROLE_CHARACTER;
    const used = usedNameStems();
    const suffix = tag ? '.' + tag : '';
    for (let round = 0; round < 100; round++) {
        const extra = round ? String(round + 1) : '';
        for (const prefix of NAME_PREFIXES) {
            for (const tail of NAME_SUFFIXES) {
                const stem = prefix + base + tail + extra;
                if (!used.has(stem)) return stem + suffix;
            }
        }
    }
    let stem = '';
    for (let attempt = 0; attempt <= used.size; attempt++) {
        stem = base + '_' + Game.time.toString(36) + '_' + (nameFallbackSeq++).toString(36);
        if (!used.has(stem)) break;
    }
    return stem + suffix;
}

function spawnWaitingFor(room) {
    const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const waiting = mem && mem.spawnWaiting;
    if (!waiting || !(waiting.cost > 0)) return false;
    if (typeof Game !== 'undefined' && Game.time - Number(waiting.at || 0) > 5) return false;
    return room.energyAvailable < waiting.cost;
}

function towerUrgent(room, tower, hostile) {
    const store = tower && tower.store;
    if (!store) return !!hostile;
    const energyKey = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
    const energy = Number(store[energyKey]) || 0;
    const reserve = Number(config.towerRepairReserve) || 500;
    const refillAt = Number(config.towerRefillAt) || 300;
    const free = typeof store.getFreeCapacity === 'function' ? Number(store.getFreeCapacity(energyKey)) || 0 : 0;
    const mem = typeof Memory !== 'undefined' && Memory.rooms && room && Memory.rooms[room.name];
    if (!mem) return !!hostile || energy < reserve;
    const latch = mem.towerUrgent || (mem.towerUrgent = {});
    const previous = latch[tower.id];
    if (energy < reserve) {
        if (!(previous > 0)) {
            if (previous === 0 && !hostile) {
                mem.towerBreaches = (Number(mem.towerBreaches) || 0) + 1;
                mem.towerBreachAt = Game.time;
            }
            latch[tower.id] = Game.time;
        }
        return true;
    }
    if (hostile) return true;
    if (previous > 0) {
        if (free < refillAt) { latch[tower.id] = 0; return false; }
        return true;
    }
    return false;
}

function energySurplus(room, opts) {
    if (!room || typeof room.find !== 'function') return false;
    const settings = Object.assign({ containerShare: 0.75, dropped: 1000 }, config.energySurplus || {}, opts || {});
    const plan = (Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].plan) || {};
    const ctrl = plan.containers && plan.containers.ctrl;
    const containers = room.find(FIND_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store }) || [];
    for (const container of containers) {
        if (ctrl && container.pos && container.pos.x === ctrl.x && container.pos.y === ctrl.y) continue;
        const capacity = typeof container.store.getCapacity === 'function' ? container.store.getCapacity(RESOURCE_ENERGY) : 2000;
        if (capacity > 0 && (container.store[RESOURCE_ENERGY] || 0) >= capacity * settings.containerShare) return true;
    }
    let dropped = 0;
    for (const drop of room.find(FIND_DROPPED_RESOURCES) || []) {
        if (drop.resourceType === RESOURCE_ENERGY) dropped += Number(drop.amount) || 0;
    }
    return dropped >= settings.dropped;
}


function bodyTicksPerTile(body) {
    let move = 0;
    let other = 0;
    for (const part of body || []) {
        const type = part && part.type ? part.type : part;
        if (part && part.hits === 0) continue;
        if (type === 'move') move++; else other++;
    }
    if (!move) return Infinity;
    return Math.max(1, Math.ceil(other / move));
}

function aidExportLevels(aidSettings, upgradingSettings) {
    const aid = aidSettings || {};
    const upgrading = upgradingSettings || {};
    const above = Math.max(Number(aid.exportAbove) || 0, Number(upgrading.storageFeedAbove) || 0);
    const keep = Math.max(Number(aid.exportKeep) || 0, Number(upgrading.storageFeedBelow) || 0);
    return { above, keep: Math.min(keep, above) };
}

function storageRichState(room, mem, settings) {
    const store = room && room.storage && room.storage.my !== false && room.storage.store;
    const energy = store ? Number(store.energy || 0) : 0;
    const above = Number(settings && settings.storageFeedAbove) || 20000;
    const below = Math.min(above, Number(settings && settings.storageFeedBelow) || 10000);
    const state = mem ? (mem.storageRich || (mem.storageRich = { on: false, at: -1 })) : null;
    const was = !!(state && state.on);
    const on = energy >= above || (was && energy >= below);
    if (state && on !== was) { state.on = on; state.at = Game.time; }
    return on;
}

const LUXURY_TYPES = new Set(['lab', 'factory', 'nuker', 'powerspawn']);
function luxuryStructure(type) {
    const t = String(type || '').toLowerCase().replace(/^structure_/, '').replace(/_/g, '');
    return LUXURY_TYPES.has(t);
}

function luxuryAllowed(room) {
    const construction = config.construction || {};
    if (room && (construction.luxuryAfterTerminal || []).indexOf(room.name) >= 0) {
        return !!(room.terminal && room.terminal.my !== false);
    }
    const byRoom = construction.luxuryStorageAboveByRoom || {};
    const threshold = Number(room && byRoom[room.name] != null ? byRoom[room.name] : construction.luxuryStorageAbove);
    if (!(threshold > 0)) return true;
    const store = room && room.storage && room.storage.my !== false && room.storage.store;
    const energy = store ? Number(store[typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy'] || 0) : 0;
    return energy >= threshold;
}

function terminalMinStorageFor(room) {
    const c = config.construction || {};
    const global = Number(c.terminalMinStorage) || 0;
    const by = c.terminalMinStorageByRoom || {};
    const hasTerminal = !!(room && room.terminal && room.terminal.my !== false);
    if (!hasTerminal && room && by[room.name] != null) return Number(by[room.name]) || 0;
    return global;
}

function siteWanted(room, site) {
    if (!site) return false;
    if (luxuryStructure(site.structureType) && !luxuryAllowed(room)) return false;
    if (site.structureType === (typeof STRUCTURE_TERMINAL !== 'undefined' ? STRUCTURE_TERMINAL : 'terminal')) {
        const min = terminalMinStorageFor(room);
        if (min > 0) {
            const store = room && room.storage && room.storage.my !== false && room.storage.store;
            const energy = store ? Number(store[typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy'] || 0) : 0;
            if (energy < min) return false;
        }
    }
    return true;
}

const conserveCache = { time: -1, rooms: {} };
function conserving(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    if (conserveCache.time !== Game.time) { conserveCache.time = Game.time; conserveCache.rooms = {}; }
    if (conserveCache.rooms[room.name] !== undefined) return conserveCache.rooms[room.name];
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const energy = (room.storage && room.storage.store ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0) +
        (room.terminal && room.terminal.my !== false && room.terminal.store ? Number(room.terminal.store[RESOURCE_ENERGY] || 0) : 0);
    let waiting = false;
    try { waiting = !!spawnWaitingFor(room); } catch (e) { waiting = false; }
    if (waiting) { if (!mem.spawnWaitSince) mem.spawnWaitSince = Game.time; }
    else if (mem.spawnWaitSince) delete mem.spawnWaitSince;
    const waited = mem.spawnWaitSince ? Game.time - mem.spawnWaitSince : 0;
    const prev = !!(mem.conserve2 && mem.conserve2.on);
    const on = !!room.storage && (prev ? energy < 10000 : (energy < 2000 && waited >= 300));
    if (on !== prev || !mem.conserve2) mem.conserve2 = { on, at: Game.time, energy };
    if (mem.conserve) delete mem.conserve;
    conserveCache.rooms[room.name] = on;
    return on;
}

function towerFloorHold(room) {
    if (!room || typeof room.find !== 'function') return false;
    if (room.controller && Number(room.controller.ticksToDowngrade) < (Number(config.towerFloorDowngrade) || 5000)) return false;
    if (towerFirstHold(room)) return true;
    const floor = config.towerFloor == null ? 500 : Number(config.towerFloor);
    if (!(floor > 0)) return false;
    const kind = typeof FIND_MY_STRUCTURES === 'undefined' ? 'myStructures' : FIND_MY_STRUCTURES;
    const towerType = typeof STRUCTURE_TOWER === 'undefined' ? 'tower' : STRUCTURE_TOWER;
    const key = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
    return (room.find(kind) || []).some((s) => s.structureType === towerType && s.store && Number(s.store[key] || 0) < floor);
}
function pausedRoom(roomName) {
    const list = ((config.spawn || {}).pauseWhileHostile) || [];
    return Array.isArray(list) && list.includes(roomName);
}
function spawnPausedByHostile(room) {
    if (!room || !pausedRoom(room.name) || typeof room.find !== 'function') return 0;
    const kind = typeof FIND_HOSTILE_CREEPS === 'undefined' ? 'hostileCreeps' : FIND_HOSTILE_CREEPS;
    const combat = ['attack', 'ranged_attack', 'heal', 'work', 'claim'];
    return (room.find(kind) || []).filter((c) => (c.owner && c.owner.username === 'Invader') ||
        (c.body || []).some((p) => combat.includes(p.type))).length;
}
const towerFirstCache = { time: -1, rooms: {} };
function towerFirstHold(room) {
    const below = Number(((config.towerFirst) || {})[room && room.name]);
    if (!(below > 0) || typeof room.find !== 'function') return false;
    if (towerFirstCache.time !== Game.time) { towerFirstCache.time = Game.time; towerFirstCache.rooms = {}; }
    if (towerFirstCache.rooms[room.name] != null) return towerFirstCache.rooms[room.name];
    const kind = typeof FIND_MY_STRUCTURES === 'undefined' ? 'myStructures' : FIND_MY_STRUCTURES;
    const towerType = typeof STRUCTURE_TOWER === 'undefined' ? 'tower' : STRUCTURE_TOWER;
    const key = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
    const hold = (room.find(kind) || []).some((s) => s.structureType === towerType && s.store && Number(s.store[key] || 0) < below);
    towerFirstCache.rooms[room.name] = hold;
    return hold;
}

function lootActive(targets) {
    if (!Array.isArray(targets) || !targets.length || typeof Memory === 'undefined') return false;
    const raw = Memory.conquest;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return list.some((d) => d && targets.indexOf(d.target) >= 0 && !d.completed && d.phase !== 'done');
}

function lootHeldRoom(name) {
    const map = (config.terminalNetwork || {}).lootHoldRooms || {};
    return lootActive(map[name]);
}

function lootExcessWork(room) {
    const cfg = (((config.upgrading || {}).hold) || {})[room && room.name];
    if (!cfg || !(Number(cfg.lootFloor) > 0) || !lootActive(cfg.untilLootDone)) return null;
    if (!room.controller || !room.controller.my) return null;
    const key = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
    const energy = Number((room.storage && room.storage.my !== false && room.storage.store && room.storage.store[key]) || 0);
    return Math.max(0, Math.floor((energy - Number(cfg.lootFloor)) / Math.max(1, Number(cfg.lootDrainTicks) || 1500)));
}

function upgradeHold(room, mem) {
    const cfg = (((config.upgrading || {}).hold) || {})[room && room.name];
    if (!cfg || !room.controller || !room.controller.my) return null;
    const m = mem || (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    const key = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
    const energy = Number((room.storage && room.storage.my !== false && room.storage.store && room.storage.store[key]) || 0);
    const prev = m.upgradeHold;
    const resumeAt = Number(cfg.resumeAt) || 10000;
    const holdBelow = Math.min(resumeAt, Number(cfg.holdBelow) || resumeAt);
    const level = holdLevel(m, cfg, energy);
    const looting = lootActive(cfg.untilLootDone);
    const lx = looting ? lootExcessWork(room) : null;
    const on = looting ? !(lx > 0) : ((prev ? !!prev.on : true) ? level < resumeAt : level < holdBelow);
    const table = typeof CONTROLLER_DOWNGRADE !== 'undefined' ? CONTROLLER_DOWNGRADE : {};
    const full = Number(table[room.controller.level]) || 0;
    const ttd = Number(room.controller.ticksToDowngrade);
    const low = full * (Number(cfg.guardLow) || 0.5);
    const high = full * (Number(cfg.guardHigh) || 0.9);
    const guard = on && full > 0 && Number.isFinite(ttd) && (prev && prev.guard ? ttd < high : ttd < low);
    if (!prev || prev.on !== on || prev.guard !== guard || !!prev.looting !== looting) m.upgradeHold = { on, guard, at: Game.time, energy, level, ttd, looting };
    if (looting) m.upgradeHold.lootWork = lx;
    else if (m.upgradeHold.lootWork != null) delete m.upgradeHold.lootWork;
    return m.upgradeHold;
}

function holdLevel(m, cfg, energy) {
    const alpha = Number(cfg.smooth);
    if (!(alpha > 0 && alpha < 1)) return energy;
    const s = m.upgradeHoldLevel;
    if (s && s.t === Game.time) return s.v;
    const v = s && Number.isFinite(s.v) ? s.v + alpha * (energy - s.v) : energy;
    m.upgradeHoldLevel = { v: Math.round(v), t: Game.time };
    return m.upgradeHoldLevel.v;
}

function conserveUpgradeAllowed(room) {
    const c = room && room.controller;
    if (!c || c.ticksToDowngrade == null) return true;
    const full = (typeof CONTROLLER_DOWNGRADE !== 'undefined' && CONTROLLER_DOWNGRADE[c.level]) || 0;
    return !full || c.ticksToDowngrade < full / 2;
}

const PVP_NPC = ['Invader', 'Source Keeper'];
function pvpHostile(creep) {
    const owner = creep && creep.owner && creep.owner.username;
    if (!owner || PVP_NPC.indexOf(owner) >= 0) return false;
    const cfg = config.pvp || {};
    return (cfg.highThreat || []).indexOf(owner) >= 0;
}
const pvpCache = { time: -1, rooms: {} };
function notePvpThreat(room) {
    if (!room) return [];
    if (pvpCache.time !== Game.time) { pvpCache.time = Game.time; pvpCache.rooms = {}; }
    if (pvpCache.rooms[room.name]) return pvpCache.rooms[room.name];
    const own = !!(room.controller && room.controller.my);
    const list = own ? [] : room.find(FIND_HOSTILE_CREEPS).filter(pvpHostile);
    if (list.length) {
        const m = Memory.pvpThreat || (Memory.pvpThreat = {});
        m[room.name] = { until: Game.time + (Number((config.pvp || {}).armedMemory) || 300), user: list[0].owner.username, n: list.length, at: Game.time };
    }
    pvpCache.rooms[room.name] = list;
    return list;
}
const AGGRESSOR_NPC = (config.npcOwners && config.npcOwners.length) ? config.npcOwners : ['Invader', 'Source Keeper', 'Power Bank', 'Screeps'];
const hitsSeen = (typeof global !== 'undefined' ? (global.__pvpHitsSeen || (global.__pvpHitsSeen = {})) : {});
function targetLostHits(target) {
    const prev = hitsSeen[target.id];
    if (prev && prev.t === Game.time - 1) return Number(target.hits) < prev.hits;
    return Number(target.hits) < Number(target.hitsMax);
}
function sampleMyHits(room) {
    for (const c of room.find(FIND_MY_CREEPS) || []) hitsSeen[c.id] = { t: Game.time, hits: Number(c.hits) };
}
function noteAggressors(room) {
    if (!room || typeof room.find !== 'function' || typeof room.getEventLog !== 'function') return 0;
    const hostiles = (room.find(FIND_HOSTILE_CREEPS) || []).filter((c) => c.owner && AGGRESSOR_NPC.indexOf(c.owner.username) < 0);
    if (!hostiles.length) return 0;
    if (!(room.find(FIND_MY_CREEPS) || []).length) return 0;
    const byId = {};
    for (const c of hostiles) byId[c.id] = c.owner.username;
    let added = 0;
    const attackEv = typeof EVENT_ATTACK === 'undefined' ? 1 : EVENT_ATTACK;
    for (const ev of room.getEventLog() || []) {
        if (ev.event !== attackEv || !ev.data || !(Number(ev.data.damage) > 0)) continue;
        const user = byId[ev.objectId];
        if (!user) continue;
        const target = Game.getObjectById(ev.data.targetId);
        if (!target || !(target.my === true)) continue;
        if (!targetLostHits(target)) continue;
        const m = Memory.pvpAggressors || (Memory.pvpAggressors = {});
        const rec = m[user];
        if (!rec) {
            m[user] = { first: Game.time, last: Game.time, n: 1, rooms: [room.name] };
            const note = '[pvp] 新攻击者 ' + user + ' 在 ' + room.name + ' 攻击了 ' + (target.name || target.structureType || ev.data.targetId);
            console.log(note);
            (Memory.pvpAggressorLog || (Memory.pvpAggressorLog = [])).push({ at: Game.time, user, room: room.name, target: target.name || target.structureType || ev.data.targetId });
            if (Memory.pvpAggressorLog.length > 20) Memory.pvpAggressorLog.splice(0, Memory.pvpAggressorLog.length - 20);
            added++;
        } else {
            rec.last = Game.time; rec.n = (Number(rec.n) || 0) + 1;
            if (rec.rooms.indexOf(room.name) < 0) { rec.rooms.push(room.name); if (rec.rooms.length > 10) rec.rooms.shift(); }
        }
    }
    sampleMyHits(room);
    return added;
}
function pvpAggressors() {
    const m = Memory.pvpAggressors;
    if (!m) return [];
    const ttl = Number((config.pvp || {}).aggressorTtl) || 20000;
    const out = [];
    for (const user of Object.keys(m)) {
        if (!m[user] || !(Game.time - Number(m[user].last) < ttl)) { delete m[user]; continue; }
        out.push(user);
    }
    return out;
}

function noteAllyDamage(room) {
    if (!room || typeof room.find !== 'function' || typeof room.getEventLog !== 'function') return 0;
    const allies = allySettings();
    if (!allies.names.length && !allies.ids.length) return 0;
    const hostiles = (room.find(FIND_HOSTILE_CREEPS) || []).filter((c) => isAlly(c));
    if (!hostiles.length) return 0;
    if (!(room.find(FIND_MY_CREEPS) || []).length && !(room.find(FIND_MY_STRUCTURES) || []).length) return 0;
    const byId = {};
    for (const c of hostiles) byId[c.id] = c.owner && c.owner.username;
    let added = 0;
    const attackEv = typeof EVENT_ATTACK === 'undefined' ? 1 : EVENT_ATTACK;
    const atkCtrl = typeof EVENT_ATTACK_CONTROLLER === 'undefined' ? 3 : EVENT_ATTACK_CONTROLLER;
    for (const ev of room.getEventLog() || []) {
        if (ev.event !== attackEv && ev.event !== atkCtrl) continue;
        if (!ev.data || (ev.event === attackEv && !(Number(ev.data.damage) > 0))) continue;
        const user = byId[ev.objectId];
        if (!user) continue;
        const target = Game.getObjectById(ev.data.targetId);
        if (!target || target.my !== true) continue;
        if (ev.event === attackEv && !targetLostHits(target)) continue;
        const alerts = Memory.strategistAlerts || (Memory.strategistAlerts = {});
        const key = 'allyDamage_' + user;
        const prev = alerts[key];
        const throttle = Number((config.allies || {}).alertThrottle) || 200;
        if (prev && prev.clearedAt == null && Game.time - Number(prev.at || 0) < throttle) {
            prev.n = (Number(prev.n) || 0) + 1;
            prev.last = Game.time;
            prev.room = room.name;
            continue;
        }
        alerts[key] = {
            at: Game.time,
            last: Game.time,
            n: 1,
            user,
            room: room.name,
            target: target.name || target.structureType || ev.data.targetId,
            msg: '白名单 ' + user + ' 在 ' + room.name + ' 打了我们的 ' + (target.name || target.structureType || ev.data.targetId) + '（未反击、未解白）',
        };
        console.log('[ally] ' + alerts[key].msg);
        added++;
    }
    sampleMyHits(room);
    return added;
}
function noteAllyDamageAll() {
    for (const room of Object.values(Game.rooms || {})) {
        try { noteAllyDamage(room); } catch (e) { logErr('ally.noteDamage ' + room.name, e); }
    }
}
function noteAggressorsAll() {
    for (const room of Object.values(Game.rooms || {})) {
        try { noteAggressors(room); } catch (e) { logErr('pvp.noteAggressors ' + room.name, e); }
    }
}

function ownerCache() {
    if (typeof Memory === 'undefined' || !Memory) return { rev: 0, rooms: {} };
    let cache = Memory.ownerCache;
    if (!cache || typeof cache !== 'object' || !cache.rooms) {
        cache = Memory.ownerCache = { v: 1, rev: 1, rooms: {}, seededFrom: null };
        const directive = Memory.brain;
        const intel = directive && directive.intel;
        if (intel && typeof intel === 'object') {
            for (const name of Object.keys(intel)) {
                const e = intel[name];
                if (e && e.owner) cache.rooms[name] = { o: e.owner, l: Number(e.level) || 0, t: Number(e.towers) || 0, at: Number(e.at) || 0 };
            }
            cache.seededFrom = 'brain.intel:' + directive.issuedAt;
        }
    }
    return cache;
}
function myName() {
    const spawn = typeof Game !== 'undefined' && Game.spawns ? Object.values(Game.spawns)[0] : null;
    return spawn && spawn.owner && spawn.owner.username || null;
}
function ownerCacheObserve(force) {
    if (typeof Game === 'undefined' || !Game.rooms) return 0;
    const cache = ownerCache();
    const interval = Math.max(1, Number((config.pvp || {}).ownerCacheInterval) || 50);
    const me = myName();
    let changed = 0;
    for (const name of Object.keys(Game.rooms)) {
        if (!force && !isRoomPhaseTick(name, interval)) continue;
        const room = Game.rooms[name];
        const ctrl = room && room.controller;
        if (!ctrl) continue;
        const owner = ctrl.owner && ctrl.owner.username;
        const prev = cache.rooms[name];
        if (owner === me || ctrl.my) {
            if (prev) { delete cache.rooms[name]; changed++; }
            continue;
        }
        const towerType = typeof STRUCTURE_TOWER === 'undefined' ? 'tower' : STRUCTURE_TOWER;
        const towerList = room.find(typeof FIND_HOSTILE_STRUCTURES === 'undefined' ? 'hostileStructures' : FIND_HOSTILE_STRUCTURES).filter((s) => s.structureType === towerType);
        const towers = towerList.length;
        const who = owner || (towers ? (towerList[0].owner && towerList[0].owner.username) || 'Invader' : null);
        if (!who) {
            if (prev) { delete cache.rooms[name]; changed++; }
            continue;
        }
        const level = owner ? Number(ctrl.level) || 0 : 0;
        if (!prev || prev.o !== who || prev.l !== level || prev.t !== towers) changed++;
        cache.rooms[name] = { o: who, l: level, t: towers, at: Game.time };
    }
    if (changed) cache.rev = (Number(cache.rev) || 0) + 1;
    return changed;
}
function allySettings() {
    const a = config.allies || {};
    return { names: Array.isArray(a.names) ? a.names : [], ids: Array.isArray(a.ids) ? a.ids : [], avoidRooms: a.avoidRooms !== false };
}
function isAllyName(name, id) {
    if (!name && !id) return false;
    const a = allySettings();
    return (!!name && a.names.indexOf(name) >= 0) || (!!id && a.ids.indexOf(id) >= 0);
}
function isAlly(obj) {
    if (!obj) return false;
    if (typeof obj === 'string') return isAllyName(obj);
    const owner = obj.owner;
    if (!owner) return false;
    return isAllyName(owner.username, owner.id || owner._id);
}
function allyFindTypes() {
    const out = ['hostileCreeps', 'hostileStructures', 'hostileSpawns', 'hostileConstructionSites', 'hostilePowerCreeps'];
    for (const k of ['FIND_HOSTILE_CREEPS', 'FIND_HOSTILE_STRUCTURES', 'FIND_HOSTILE_SPAWNS', 'FIND_HOSTILE_CONSTRUCTION_SITES', 'FIND_HOSTILE_POWER_CREEPS']) {
        if (typeof global !== 'undefined' && global[k] != null) out.push(global[k]);
    }
    return out;
}
function installAllyFilter() {
    if (typeof Room === 'undefined' || !Room.prototype || typeof Room.prototype.find !== 'function') return false;
    if (Room.prototype.find.__allyWrapped) return true;
    const orig = Room.prototype.find;
    const types = new Set(allyFindTypes());
    const wrapped = function (type, opts) {
        const res = orig.call(this, type, opts);
        if (!types.has(type) || !Array.isArray(res) || !res.length || !allySettings().names.length) return res;
        let hit = false;
        for (let i = 0; i < res.length; i++) if (isAlly(res[i])) { hit = true; break; }
        return hit ? res.filter((o) => !isAlly(o)) : res;
    };
    wrapped.__allyWrapped = true;
    wrapped.__allyOrig = orig;
    Room.prototype.find = wrapped;
    return true;
}
function allyRooms() {
    const cache = ownerCache();
    const out = [];
    for (const name of Object.keys(cache.rooms || {})) {
        const e = cache.rooms[name];
        if (e && isAllyName(e.o)) out.push(name);
    }
    return out;
}
const ownerDangerCache = { rev: -1, me: null, rooms: [] };
function ownerDangerRooms() {
    const cache = ownerCache();
    const me = myName();
    if (ownerDangerCache.rev === cache.rev && ownerDangerCache.me === me && ownerDangerCache.rooms) return ownerDangerCache.rooms;
    const rooms = [];
    for (const name of Object.keys(cache.rooms)) {
        const e = cache.rooms[name];
        if (e && e.o && e.o !== me && (Number(e.t) > 0 || (isAllyName(e.o) && allySettings().avoidRooms))) rooms.push(name);
    }
    ownerDangerCache.rev = cache.rev; ownerDangerCache.me = me; ownerDangerCache.rooms = rooms;
    return rooms;
}

const tempAvoidCache = { tick: -1, rooms: null };
function tempAvoidRooms(fresh) {
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    if (!fresh && tempAvoidCache.tick === now && tempAvoidCache.rooms) return tempAvoidCache.rooms;
    const rooms = new Set();
    const list = (config.pvp || {}).tempAvoid || {};
    const done = (typeof Memory !== 'undefined' && Memory && Memory.tempAvoidDone) || null;
    for (const name of Object.keys(list)) {
        const rule = list[name] || {};
        if (!(Number(rule.until) > now)) continue;
        if (done && done[name]) continue;
        if (rule.untilNoPowerBank) {
            const room = typeof Game !== 'undefined' && Game.rooms && Game.rooms[name];
            const bankType = typeof STRUCTURE_POWER_BANK === 'undefined' ? 'powerBank' : STRUCTURE_POWER_BANK;
            if (room && typeof room.find === 'function' && !room.find(FIND_STRUCTURES).some((s) => s.structureType === bankType)) {
                (Memory.tempAvoidDone || (Memory.tempAvoidDone = {}))[name] = now;
                continue;
            }
        }
        rooms.add(name);
    }
    tempAvoidCache.tick = now; tempAvoidCache.rooms = rooms;
    return rooms;
}

function pvpDangerRoom(name) {
    const cfg = config.pvp || {};
    if ((cfg.dangerRooms || []).indexOf(name) >= 0) return true;
    if (tempAvoidRooms().has(name)) return true;
    const rec = Memory.pvpThreat && Memory.pvpThreat[name];
    if (rec && rec.until > Game.time) return true;
    if (rec && Game.time % 100 === 0) delete Memory.pvpThreat[name];
    return false;
}

module.exports = { setCreepIndexRecount, tickMemoOff,
    allySettings,
    isAllyName,
    isAlly,
    installAllyFilter,
    allyRooms,
    upgradeSurplusWork,
    linkSupplyWork,
    surplusBodyPlan,
    placeSite,
    siteAllowed,
    tallySites,
    terminalMinStorageFor,
    pvpHostile,
    notePvpThreat,
    noteAggressors,
    noteAggressorsAll,
    noteAllyDamage,
    noteAllyDamageAll,
    pvpAggressors,
    pvpDangerRoom,
    tempAvoidRooms,
    ownerCache,
    ownerCacheObserve,
    ownerDangerRooms,
    conserving,
    conserveUpgradeAllowed,
    upgradeHold,
    lootExcessWork,
    rcl8Room,
    rcl8Ready,
    applyRcl8Auto,
    blockedTradeRoom,
    lootActive,
    lootHeldRoom,
    towerFirstHold,
    towerFloorHold,
    spawnPausedByHostile,
    pausedRoom,
    isRetiring,
    luxuryStructure,
    luxuryAllowed,
    siteWanted,
    crippledParts,
    storageRichState,
    aidExportLevels,
    bodyTicksPerTile,
    energySurplus,
    spawnWaitingFor,
    towerUrgent,
    findCached,
    creepsHome,
    creepsHomeRole,
    makeBody,
    bodyCost,
    bodyPartCount,
    carryCapacity,
    roomCoords,
    roomDistance,
    roomNameAt,
    upgraderBudgetForWork,
    upgraderWork,
    sourceSupply,
    upgradeBudgetLow,
    upgraderWorkCap,
    bankingWorkCap,
    upgraderSupplyWork,
    planPath,
    unpackPath,
    packedPathLength,
    pathLength,
    isWall,
    occupied,
    bestAdjacent,
    countRole,
    repeat,
    repairTargetHits,
    planRoadKeys,
    plannedStructure,
    needsRepair,
    armedHostiles,
    removeSite,
    wallFloorHits,
    rampartRaiseAllowed,
    criticallyDamaged,
    hasCriticalStructure,
    compareRepairTargets,
    rampartProtectsCore,
    creepName,
    roomPhase,
    isRoomPhaseTick,
    logErr,
};
