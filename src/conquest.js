'use strict';
const config = require('config');
const { roomDistance } = require('utils');

function settings() {
    return Object.assign({
        dismantlerBudget: 1800,
        downgraderBudget: 1300,
        guardBudget: 2200,
        minCapacity: 1300,
        storageFloor: 15000,
        reformShare: 0.7,
        reformWait: 60,
        towerAvoidRange: 8,
        towerAvoidWeight: 6,
        boosts: { dismantler: [], guard: [] },
        boostMaxWait: 100,
        lootBudget: 1600,
        lootRetreatBelowHalf: true,
    }, config.conquest || {});
}

function directives() {
    const raw = Memory.conquest;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((d) => d && typeof d === 'object' && typeof d.target === 'string' &&
        !d.completed &&
        (d.sponsors === 'all' || (Array.isArray(d.sponsors) && d.sponsors.length)));
}

function directive() {
    const list = directives();
    return list.length ? list[0] : null;
}

function sponsorRooms(d) {
    if (Array.isArray(d.sponsors)) return d.sponsors.slice();
    const cap = settings().minCapacity;
    return Object.values(Game.rooms || {})
        .filter((r) => r.controller && r.controller.my && r.find(FIND_MY_SPAWNS).length &&
            r.energyCapacityAvailable >= cap && r.name !== d.target)
        .map((r) => r.name).sort();
}

function repeatBody(pattern, budget) {
    const cost = pattern.reduce((s, t) => s + BODY_COST[t], 0);
    const maxByBudget = Math.floor(budget / cost);
    const maxByParts = Math.floor(50 / pattern.length);
    const n = Math.max(1, Math.min(maxByBudget, maxByParts));
    const body = [];
    for (const t of pattern) for (let i = 0; i < n; i++) body.push(t);
    return body;
}
const BODY_COST = { move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 };

function holdTile(anchor, name, minRange) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
    const min = Math.max(0, Number(minRange) || 0);
    const cells = [];
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) >= min) cells.push([dx, dy]);
        }
    }
    const [dx, dy] = cells[hash % cells.length];
    const x = Math.max(2, Math.min(47, anchor.x + dx));
    const y = Math.max(2, Math.min(47, anchor.y + dy));
    return new RoomPosition(x, y, anchor.roomName);
}

function laneTile(anchor, name, halfWidth, alongX) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i) + 7) & 0xffff;
    const w = Math.max(1, Number(halfWidth) || 8);
    const base = (hash % (2 * w + 1)) - w;
    const at = (off) => ({
        x: alongX ? Math.max(2, Math.min(47, anchor.x + off)) : anchor.x,
        y: alongX ? anchor.y : Math.max(2, Math.min(47, anchor.y + off)),
    });
    const terrain = (typeof Game !== 'undefined' && Game.map && typeof Game.map.getRoomTerrain === 'function')
        ? Game.map.getRoomTerrain(anchor.roomName) : null;
    const wallMask = (typeof TERRAIN_MASK_WALL === 'undefined') ? 1 : TERRAIN_MASK_WALL;
    let pick = at(base);
    if (terrain) {
        let found = null;
        for (let d = 0; d <= 2 * w && !found; d++) {
            for (const off of (d === 0 ? [base] : [base - d, base + d])) {
                if (off < -w || off > w) continue;
                const p = at(off);
                if ((terrain.get(p.x, p.y) & wallMask) === 0) { found = p; break; }
            }
        }
        if (found) pick = found;
    }
    return new RoomPosition(pick.x, pick.y, anchor.roomName);
}

function boostsFor(role, d) {
    const key = role === 'siegeDismantler' ? 'dismantler' : role === 'siegeGuard' ? 'guard' : null;
    if (!key) return [];
    const source = d && d.boosts && typeof d.boosts === 'object' ? d.boosts : (settings().boosts || {});
    const list = source[key];
    return Array.isArray(list) ? list.filter((compound) => typeof compound === 'string' && compound) : [];
}

function boostingEnabled() {
    const any = (d) => boostsFor('siegeDismantler', d).length > 0 || boostsFor('siegeGuard', d).length > 0;
    if (any(null)) return true;
    return directives().some((d) => d.boosts && typeof d.boosts === 'object' && any(d));
}

function demand(role, slot, body, memory, lead, priority, d) {
    const boosts = boostsFor(role, d);
    const extra = boosts.length ? { boosts } : {};
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory, extra), lead, priority, cls: 'conquest' };
}

function attachAvoidance(mem, d) {
    if (Array.isArray(d.avoid) && d.avoid.length) mem.avoid = d.avoid;
    if (d.avoidTowers && typeof d.avoidTowers === 'object') mem.avoidTowers = d.avoidTowers;
    return mem;
}

function countHostileCombat(room) {
    const hostiles = (room.find(FIND_HOSTILE_CREEPS) || []);
    let n = 0;
    for (const c of hostiles) {
        const body = c.body || [];
        if (body.some((p) => p.type === ATTACK || p.type === RANGED_ATTACK || p.type === HEAL)) n++;
    }
    return n;
}

function hostileTowersOf(room) {
    return (room.find(FIND_STRUCTURES) || [])
        .filter((s) => s.structureType === STRUCTURE_TOWER && s.owner && !s.my
            && s.pos && typeof s.pos.x === 'number' && typeof s.pos.y === 'number');
}

function recordHostileTowers(room, creep) {
    if (!room || !room.name || !room.controller || typeof room.find !== 'function') return;
    if (typeof Memory === 'undefined') return;
    const store = Memory.siegeTowers || (Memory.siegeTowers = {});
    const prev = store[room.name];
    if (prev && prev.at === Game.time) { noteTransitDist(room, creep, prev.pos); return; }
    const towers = hostileTowersOf(room);
    if (towers.length) {
        const pos = towers.map((t) => [t.pos.x, t.pos.y]);
        store[room.name] = { pos, at: Game.time };
        noteTransitDist(room, creep, pos);
    } else {
        delete store[room.name];
    }
}

function noteTransitDist(room, creep, towerPos) {
    if (!creep || !creep.pos || !creep.memory || room.name === creep.memory.targetRoom) return;
    if (!Array.isArray(towerPos) || !towerPos.length) return;
    let min = Infinity;
    for (const p of towerPos) {
        const d = Math.max(Math.abs(creep.pos.x - p[0]), Math.abs(creep.pos.y - p[1]));
        if (d < min) min = d;
    }
    if (!isFinite(min)) return;
    const t = Memory.siegeTransit || (Memory.siegeTransit = {});
    if (t[room.name] === undefined || min < t[room.name]) t[room.name] = min;
}

const TOWER_CACHE_TTL = 3000;
function knownHostileTowers(roomName, extra) {
    const out = [];
    const seen = new Set();
    const add = (x, y) => { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); out.push({ x, y }); } };
    const room = typeof Game !== 'undefined' && Game.rooms ? Game.rooms[roomName] : null;
    if (room && typeof room.find === 'function') for (const t of hostileTowersOf(room)) add(t.pos.x, t.pos.y);
    const store = typeof Memory !== 'undefined' && Memory.siegeTowers;
    const entry = store && store[roomName];
    if (entry && Array.isArray(entry.pos) && (Game.time - (entry.at || 0)) <= TOWER_CACHE_TTL) {
        for (const p of entry.pos) add(p[0], p[1]);
    }
    if (extra && Array.isArray(extra[roomName])) for (const p of extra[roomName]) add(p[0], p[1]);
    return out;
}

function towerAvoidCallback(targetRoom, extraTowers) {
    const cfg = settings();
    const range = Math.max(1, Number(cfg.towerAvoidRange) || 8);
    const weight = Math.max(1, Number(cfg.towerAvoidWeight) || 6);
    return function (roomName, costMatrix) {
        if (!costMatrix || typeof costMatrix.set !== 'function' || typeof costMatrix.get !== 'function') return costMatrix;
        if (roomName === targetRoom) return costMatrix;
        const towers = knownHostileTowers(roomName, extraTowers);
        if (!towers.length) return costMatrix;
        for (const t of towers) {
            for (let dx = -range; dx <= range; dx++) {
                for (let dy = -range; dy <= range; dy++) {
                    const x = t.x + dx;
                    const y = t.y + dy;
                    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (dist > range) continue;
                    const cur = costMatrix.get(x, y);
                    if (cur >= 255) continue;
                    costMatrix.set(x, y, Math.min(254, cur + (range - dist + 1) * weight));
                }
            }
        }
        return costMatrix;
    };
}

function run() {
    skValidateFuseTick();
    for (const d of directives()) runOne(d);
}
function runOne(d) {
    if (d.type === 'strongholdLoot') return runStrongholdLoot(d);
    const room = Game.rooms[d.target];
    if (!room || !room.controller) return;
    const ctrl = room.controller;
    d.safeMode = ctrl.safeMode && ctrl.safeMode > 0 ? ctrl.safeMode : null;
    d.hostiles = countHostileCombat(room);
    if (ctrl.my) {
        d.phase = 'done';
        if (!d.completed) { d.completed = true; d.completedAt = Game.time; }
        return;
    }
    if (!ctrl.owner) {
        d.phase = d.suppress ? 'deny' : 'claim';
        return;
    }
    const towers = room.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_TOWER && s.owner && !s.my);
    const spawns = room.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_SPAWN && s.owner && !s.my);
    if (d.suppress && !towers.length) {
        d.phase = 'downgrade';
        return;
    }
    let alive = 0;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.targetRoom !== d.target) continue;
        if (c.memory.role === 'siegeDismantler' || c.memory.role === 'siegeGuard') alive++;
    }
    d.siegeAlive = alive;
    const breached = !towers.length && !spawns.length;
    if (breached && d.siegeAtBreach == null) d.siegeAtBreach = alive;
    d.phase = breached ? 'downgrade' : 'breach';
}

function militaryCompounds() {
    const set = [];
    for (const d of directives()) {
        if (d.type !== 'strongholdLoot') continue;
        for (const c of boostsFor('siegeDismantler', d).concat(boostsFor('siegeGuard', d))) if (set.indexOf(c) < 0) set.push(c);
    }
    return set;
}
function directiveFor(targetRoom) {
    for (const d of directives()) if (d.target === targetRoom) return d;
    return null;
}
function appliedCompounds(creep) {
    return new Set((creep.body || []).map((p) => p.boost).filter(Boolean));
}
function squadBoostReady(targetRoom) {
    const d = directiveFor(targetRoom);
    if (!d) return { ready: true };
    const want = { siegeDismantler: boostsFor('siegeDismantler', d), siegeGuard: boostsFor('siegeGuard', d) };
    if (!want.siegeDismantler.length && !want.siegeGuard.length) return { ready: true };
    let units = 0;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.targetRoom !== targetRoom) continue;
        const need = want[c.memory.role];
        if (!need || !need.length) continue;
        units++;
        if (c.spawning) return { ready: false, reason: 'boosting:spawning:' + name };
        const have = appliedCompounds(c);
        for (const compound of need) if (!have.has(compound)) return { ready: false, reason: 'boosting:' + name + ':' + compound };
    }
    const expect = (Math.max(0, Number(d.dismantlers) || 0) * (want.siegeDismantler.length ? 1 : 0)) +
        (Math.max(0, Number(d.guards) || 0) * (want.siegeGuard.length ? 1 : 0));
    if (expect > 0 && units < expect) return { ready: false, reason: 'boosting:assembling:' + units + '/' + expect };
    return { ready: true };
}
function boostGateHold(targetRoom) {
    const r = squadBoostReady(targetRoom);
    if (!r.ready) {
        const d = directiveFor(targetRoom);
        if (d) d.waitReason = r.reason;
    } else {
        const d = directiveFor(targetRoom);
        if (d && d.waitReason && String(d.waitReason).indexOf('boosting') === 0) delete d.waitReason;
    }
    return !r.ready;
}

function lootTilesOf(d, room) {
    if (Array.isArray(d.lootTiles) && d.lootTiles.length) return d.lootTiles.map((p) => [p[0], p[1]]);
    if (!room || typeof room.find !== 'function') return [];
    const type = typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER;
    return (room.find(FIND_STRUCTURES) || [])
        .filter((s) => s.structureType === type && s.store && nonEnergyAmount(s.store) > 0)
        .map((s) => [s.pos.x, s.pos.y]);
}
function nonEnergyAmount(store) {
    if (!store) return 0;
    let n = 0;
    for (const k in store) if (k !== (typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY)) n += Number(store[k]) || 0;
    return n;
}
function tileKey(x, y) { return x + ',' + y; }
function lootRampartTargets(room, tiles) {
    if (!room || typeof room.find !== 'function' || !tiles || !tiles.length) return [];
    const set = new Set(tiles.map((p) => tileKey(p[0], p[1])));
    const type = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
    return (room.find(FIND_STRUCTURES) || []).filter((s) => s.structureType === type && s.owner && !s.my && set.has(tileKey(s.pos.x, s.pos.y)));
}
function lootContainersOf(room, tiles) {
    if (!room || typeof room.find !== 'function' || !tiles || !tiles.length) return [];
    const set = new Set(tiles.map((p) => tileKey(p[0], p[1])));
    const type = typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER;
    return (room.find(FIND_STRUCTURES) || []).filter((s) => s.structureType === type && set.has(tileKey(s.pos.x, s.pos.y)) && s.store && nonEnergyAmount(s.store) > 0);
}
function squadBelowHalf(targetRoom) {
    let hits = 0, max = 0, n = 0;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.targetRoom !== targetRoom || c.memory.role !== 'siegeDismantler' || c.spawning) continue;
        hits += Number(c.hits) || 0; max += Number(c.hitsMax) || 0; n++;
    }
    return n > 0 && max > 0 && hits < max / 2;
}
function retreatFor(targetRoom) {
    for (const d of directives()) if (d.type === 'strongholdLoot' && d.target === targetRoom && d.retreat) return true;
    return false;
}
function runStrongholdLoot(d) {
    const room = Game.rooms[d.target];
    const cfg = settings();
    if (cfg.lootRetreatBelowHalf !== false) d.retreat = squadBelowHalf(d.target);
    if (!room || typeof room.find !== 'function') return;
    const tiles = lootTilesOf(d, room);
    if (tiles.length) d.lootTiles = tiles;
    const use = (Array.isArray(d.lootTiles) && d.lootTiles.length) ? d.lootTiles : tiles;
    const ramparts = lootRampartTargets(room, use);
    const containers = lootContainersOf(room, use);
    d.rampartsLeft = ramparts.length;
    d.lootLeft = containers.reduce((sum, c) => sum + nonEnergyAmount(c.store), 0);
    if (!use.length || (ramparts.length === 0 && containers.length === 0)) {
        d.phase = 'done';
        if (!d.completed) { d.completed = true; d.completedAt = Game.time; }
        return;
    }
    d.phase = ramparts.length ? 'breach' : 'loot';
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const out = [];
    for (const item of skValidateDemands(home)) out.push(item);
    for (const d of directives()) {
        for (const item of demandsFor(d, home)) out.push(item);
    }
    return out;
}

function demandsFor(d, home) {
    const sponsors = sponsorRooms(d);
    if (sponsors.indexOf(home.name) < 0) return [];
    if (d.phase === 'done') return [];
    if (d.type === 'strongholdLoot') return strongholdLootDemands(d, home, sponsors);
    const cfg = settings();
    if (home.energyCapacityAvailable < cfg.minCapacity) return [];
    const storeEnergy = (home.storage && home.storage.store) ? (home.storage.store.energy || 0) : 0;
    const floor = d.storageFloor != null ? Number(d.storageFloor) : cfg.storageFloor;
    const storageOk = !floor || !home.storage || storeEnergy >= floor;
    const phase = d.phase || 'breach';
    const staging = d.staging || null;
    const nSponsors = sponsors.length || 1;
    const totalDismantlers = Math.max(0, Number(d.dismantlers) || 0);
    const totalGuards = Math.max(0, Number(d.guards) || 0);
    const squad = Math.max(1, totalDismantlers + totalGuards);
    const demands = [];

    if (phase === 'breach') {
        if (!storageOk) return demands;
        const mem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad }, d);
        const dPer = Math.ceil(totalDismantlers / nSponsors);
        const body = repeatBody(['work', 'move'], Math.min(home.energyCapacityAvailable, cfg.dismantlerBudget));
        for (let i = 0; i < dPer; i++) {
            demands.push(demand('siegeDismantler', 'siege:' + d.target + ':' + home.name + ':' + i, body, mem, 80, i, d));
        }
        const gPer = Math.ceil(totalGuards / nSponsors);
        if (gPer > 0) {
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) {
                demands.push(demand('siegeGuard', 'guard:' + d.target + ':' + home.name + ':' + i, gbody, mem, 85, i, d));
            }
        }
    } else if (phase === 'downgrade') {
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            const nDg = Math.max(1, Number(d.downgraders) || 1);
            const dgBudget = Math.max(650, Number(d.downgraderBudget) || cfg.downgraderBudget);
            const dgbody = repeatBody(['claim', 'move'], Math.min(home.energyCapacityAvailable, dgBudget));
            const dgmem = { home: home.name, targetRoom: d.target };
            if (d.suppress) dgmem.suppress = true;
            for (let i = 0; i < nDg; i++) {
                demands.push(demand('downgrader', 'downgrade:' + d.target + ':' + home.name + ':' + i, dgbody, dgmem, 60, i));
            }
        }
        if (totalGuards > 0 && (Number(d.hostiles) || 0) > 0 && storageOk) {
            const gPer = Math.ceil(totalGuards / nSponsors);
            const gmem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad: 1 }, d);
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) {
                demands.push(demand('siegeGuard', 'guard:' + d.target + ':' + home.name + ':' + i, gbody, gmem, 70, i, d));
            }
        }
    } else if (phase === 'deny') {
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            const nDg = Math.max(1, Number(d.downgraders) || 1);
            const dgBudget = Math.max(650, Number(d.downgraderBudget) || cfg.downgraderBudget);
            const dgbody = repeatBody(['claim', 'move'], Math.min(home.energyCapacityAvailable, dgBudget));
            const dgmem = { home: home.name, targetRoom: d.target, suppress: true };
            for (let i = 0; i < nDg; i++) {
                demands.push(demand('downgrader', 'downgrade:' + d.target + ':' + home.name + ':' + i, dgbody, dgmem, 60, i));
            }
        }
        if (totalGuards > 0 && storageOk) {
            const gPer = Math.ceil(totalGuards / nSponsors);
            const gmem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad: 1, suppress: true }, d);
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) {
                demands.push(demand('siegeGuard', 'guard:' + d.target + ':' + home.name + ':' + i, gbody, gmem, 70, i, d));
            }
        }
    } else if (phase === 'claim') {
        if (d.noClaim) return demands;
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            demands.push(demand('claimer', 'conquer-claim:' + d.target, ['claim', 'move'],
                { home: home.name, targetRoom: d.target }, 100, 0));
        }
    }
    return demands;
}

function skValidateOn(homeName, roomName) {
    const v = (config.sk || {}).validate;
    if (!v || !v.enabled || typeof v.room !== 'string') return false;
    const fuse = typeof Memory !== 'undefined' && Memory ? Memory.skValidateFuse : null;
    if (fuse && fuse.tripped) return false;
    return (homeName === undefined || v.home === homeName) && (roomName === undefined || v.room === roomName);
}

function tripSkValidate(fuse, reason) {
    const v = (config.sk || {}).validate || {};
    fuse.tripped = { at: Game.time, reason, name: fuse.name || null, home: v.home || null, room: v.room || null };
    const msg = '[sk.validate] fuse tripped: ' + reason + ' reaper=' + (fuse.name || '?') + ' ' + (v.home || '?') + '->' + (v.room || '?') + ' tick ' + Game.time + '; validate disabled via Memory.skValidateFuse';
    if (typeof Game !== 'undefined' && typeof Game.notify === 'function') Game.notify(msg);
    require('utils').logErr('sk.validateFuse', new Error(msg));
}

function skValidateFuseTick() {
    if (!skValidateOn()) return null;
    const v = config.sk.validate;
    const fuse = Memory.skValidateFuse || (Memory.skValidateFuse = {});
    if (!fuse.name) {
        const found = Object.values(Game.creeps || {}).find((c) => c && c.memory && c.memory.role === 'skReaper' && c.memory.validate && c.memory.home === v.home);
        if (!found) return fuse;
        fuse.name = found.name;
        fuse.seenAt = Game.time;
    }
    if (fuse.entered) return fuse;
    const creep = Game.creeps[fuse.name];
    if (!creep) { tripSkValidate(fuse, 'diedBeforeEntry'); return fuse; }
    if (creep.spawning) return fuse;
    if (!fuse.born) fuse.born = Game.time - Math.max(0, 1500 - (Number(creep.ticksToLive) || 1500));
    if (creep.pos && creep.pos.roomName === v.room) { fuse.entered = Game.time; return fuse; }
    const window = Math.max(1, Number(v.entryWindow) || 300);
    if (Game.time - fuse.born >= window) tripSkValidate(fuse, 'noEntryWithin' + window);
    return fuse;
}

function skValidateDemands(home) {
    const v = (config.sk || {}).validate;
    if (!skValidateOn(home.name)) return [];
    if (Memory.skValidateFuse && Memory.skValidateFuse.name) return [];
    const n = Math.max(1, Number(v.units) || 9);
    const body = [];
    for (let i = 0; i < n; i++) body.push('ranged_attack');
    for (let i = 0; i < n; i++) body.push('heal');
    for (let i = 0; i < 2 * n; i++) body.push('move');
    if (body.length > 50) body.length = 50;
    return [{ role: 'skReaper', slot: 'skValidate:' + v.room, body,
        memory: { role: 'skReaper', slotKey: 'skValidate:' + v.room, home: home.name, remoteRoom: v.room, validate: true },
        lead: body.length * 3 + 40, priority: 0, cls: 'conquest' }];
}

function strongholdLootDemands(d, home, sponsors) {
    const cfg = settings();
    if (home.energyCapacityAvailable < cfg.minCapacity) return [];
    if (d.retreat) return [];
    const storeEnergy = (home.storage && home.storage.store) ? (home.storage.store.energy || 0) : 0;
    const floor = d.storageFloor != null ? Number(d.storageFloor) : cfg.storageFloor;
    if (floor && home.storage && storeEnergy < floor) return [];
    const demands = [];
    const nSponsors = sponsors.length || 1;
    const staging = d.staging || null;
    const totalDismantlers = Math.max(0, Number(d.dismantlers) || 0);
    const totalGuards = Math.max(0, Number(d.guards) || 0);
    const totalHaulers = Math.max(0, Number(d.haulers) || 0);
    const squad = Math.max(1, totalDismantlers + totalGuards);
    const lootTiles = Array.isArray(d.lootTiles) ? d.lootTiles : null;
    const phase = d.phase || 'breach';
    if (phase === 'breach') {
        const mem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad, lootTiles, strongholdLoot: true }, d);
        const dPer = Math.ceil(totalDismantlers / nSponsors);
        const body = repeatBody(['work', 'move'], Math.min(home.energyCapacityAvailable, cfg.dismantlerBudget));
        for (let i = 0; i < dPer; i++) demands.push(demand('siegeDismantler', 'siegeLoot:' + d.target + ':' + home.name + ':' + i, body, mem, 80, i, d));
        const gPer = Math.ceil(totalGuards / nSponsors);
        if (gPer > 0) {
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) demands.push(demand('siegeGuard', 'guardLoot:' + d.target + ':' + home.name + ':' + i, gbody, mem, 85, i, d));
        }
    }
    if ((phase === 'loot' || phase === 'breach') && totalHaulers > 0) {
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            const hbody = repeatBody(['carry', 'move'], Math.min(home.energyCapacityAvailable, cfg.lootBudget));
            const hmem = attachAvoidance({ home: home.name, targetRoom: d.target, lootTiles, staging }, d);
            for (let i = 0; i < totalHaulers; i++) demands.push(demand('lootHauler', 'loot:' + d.target + ':' + i, hbody, hmem, 90, i, d));
        }
    }
    return demands;
}

module.exports = { run, getDemands, directive, directives, settings, boostsFor, boostingEnabled, repeatBody, holdTile, laneTile, towerAvoidCallback, recordHostileTowers, knownHostileTowers, lootTilesOf, lootRampartTargets, lootContainersOf, squadBelowHalf, retreatFor, nonEnergyAmount, squadBoostReady, boostGateHold, militaryCompounds, skValidateDemands, skValidateOn, skValidateFuseTick };
