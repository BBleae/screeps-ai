'use strict';
const STAGES = ['wall', 'gather', 'strike', 'loot'];
const NUKER = typeof STRUCTURE_NUKER === 'undefined' ? 'nuker' : STRUCTURE_NUKER;
const RAMPART = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
const G = typeof RESOURCE_GHODIUM === 'undefined' ? 'G' : RESOURCE_GHODIUM;
const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;

function cfg() {
    if (typeof Memory === 'undefined' || !Memory.lootWarLoot) return null;
    const n = Memory.lootWarLoot.nuke;
    return n && typeof n === 'object' && typeof n.room === 'string' ? n : null;
}

function stageOf(n) {
    return n.stage || 'wall';
}

function active(room) {
    const n = cfg();
    return n && n.room === room && STAGES.indexOf(stageOf(n)) >= 0 ? n : null;
}

function dirFor(room) {
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === room && !x.completed) return x;
    return null;
}

function hostile(st) {
    if (!st || st.my) return false;
    try { if (require('utils').isAlly(st)) return false; } catch (e) { }
    return true;
}

function rampartAt(room, x, y) {
    return (room.lookForAt(LOOK_STRUCTURES, x, y) || []).find((s) => s.structureType === RAMPART && hostile(s) && !s.isPublic) || null;
}

function nukerAt(room, x, y) {
    return (room.lookForAt(LOOK_STRUCTURES, x, y) || []).find((s) => s.structureType === NUKER && hostile(s)) || null;
}

function focusLeft(room, d) {
    let n = 0;
    for (const t of (Array.isArray(d.focusTiles) ? d.focusTiles : [])) {
        if (rampartAt(room, t[0], t[1])) n++;
        else if (nukerAt(room, t[0], t[1])) n++;
    }
    return n;
}

function standable(room, x, y) {
    if (x < 1 || x > 48 || y < 1 || y > 48) return false;
    if (room.getTerrain().get(x, y) & TERRAIN_MASK_WALL) return false;
    return !(room.lookForAt(LOOK_STRUCTURES, x, y) || []).some((st) => {
        const t = st.structureType;
        return !(t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER || (t === RAMPART && (st.my || st.isPublic)));
    });
}

function ring(room, x, y, lo, hi) {
    const out = [];
    for (let r = lo; r <= hi; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                if (standable(room, x + dx, y + dy)) out.push([x + dx, y + dy]);
            }
        }
    }
    return out;
}

function tileOf(n, dir) {
    if (Array.isArray(n.tile)) return n.tile;
    const f = dir && Array.isArray(dir.focusTiles) && dir.focusTiles[0];
    return f ? [f[0], f[1]] : null;
}

const planCache = { tick: -1, by: {} };
function plan(room, n, dir) {
    if (planCache.tick !== Game.time) { planCache.tick = Game.time; planCache.by = {}; }
    if (planCache.by[room.name]) return planCache.by[room.name];
    const t = tileOf(n, dir);
    if (!t) return null;
    const adj = ring(room, t[0], t[1], 1, 1);
    const d = Array.isArray(n.dTile) ? n.dTile : null;
    const slots = d ? adj.filter((p) => p[0] !== d[0] || p[1] !== d[1]) : adj.slice(0, Math.max(0, adj.length - 1));
    const outer = ring(room, t[0], t[1], 2, 3);
    const p = {
        t,
        pos: new RoomPosition(t[0], t[1], room.name),
        nuker: nukerAt(room, t[0], t[1]),
        ramp: rampartAt(room, t[0], t[1]),
        adj,
        slots,
        wait: outer.slice(-3),
        queue: outer.slice(0, Math.max(0, outer.length - 3)),
        taken: {},
    };
    planCache.by[room.name] = p;
    return p;
}

function log(n, e, d) {
    const ev = Array.isArray(n.events) ? n.events : (n.events = []);
    ev.push(Object.assign({ t: Game.time, e, room: n.room }, d || {}));
    while (ev.length > 20) ev.shift();
}

function lockOf(m) {
    return require('loot_split').lockOf(m);
}

const lockCache = { tick: -1, by: {} };
function locked(room) {
    if (lockCache.tick !== Game.time) { lockCache.tick = Game.time; lockCache.by = {}; }
    if (lockCache.by[room]) return lockCache.by[room];
    const out = [];
    for (const name of Object.keys(Game.creeps || {})) {
        const c = Game.creeps[name];
        if (c && c.memory && c.memory.role === 'lootHauler' && lockOf(c.memory) === room && !c.spawning) out.push(c);
    }
    lockCache.by[room] = out;
    return out;
}

function usedOf(c) {
    return c.store && typeof c.store.getUsedCapacity === 'function' ? Number(c.store.getUsedCapacity()) || 0 : 0;
}

function ensureLock(n) {
    const s = Memory.lootWarLoot;
    const locks = s.locks && typeof s.locks === 'object' ? s.locks : (s.locks = {});
    const L = locks[n.room];
    const want = Math.max(1, Number(n.n) || 18);
    if (!L || L.releasedAt || L.until !== 'nuke' || L.n !== want) locks[n.room] = { n: want, until: 'nuke', at: Game.time };
}

function dismantlers(room) {
    return (room.find(FIND_MY_CREEPS) || []).filter((c) => c.memory && c.memory.role === 'siegeDismantler' && !c.memory.retired);
}

function pickDTile(room, p) {
    const sd = require('roles_siegeDismantler');
    let best = null;
    for (const c of dismantlers(room)) {
        if (c.pos.getRangeTo(p.pos) !== 1) continue;
        if (!p.adj.some((q) => q[0] === c.pos.x && q[1] === c.pos.y)) continue;
        const w = sd.power(c);
        if (!best || w > best.w || (w === best.w && c.name < best.c.name)) best = { c, w };
    }
    return best ? [best.c.pos.x, best.c.pos.y] : (p.adj[0] || null);
}

function walled(p, dir, n) {
    if (!p.ramp) return true;
    const stop = Number(dir && dir.stopHits) || 10000;
    return p.ramp.hits <= stop + (Number(n.margin) || 5000);
}

function noteWalls(n) {
    const seen = n.walled || (n.walled = {});
    for (const r of [n.room].concat(Array.isArray(n.order) ? n.order : [])) {
        if (seen[r]) continue;
        const room = Game.rooms[r];
        const d = dirFor(r);
        if (!room || !d || !(Number(d.stopHits) > 0)) continue;
        const t = Array.isArray(d.focusTiles) && d.focusTiles[0];
        if (!t) continue;
        const ramp = rampartAt(room, t[0], t[1]);
        if (ramp && ramp.hits <= Number(d.stopHits) + (Number(n.margin) || 5000)) { seen[r] = Game.time; log(n, 'walled', { at: r, hits: ramp.hits }); }
    }
}

function ready(room, n, p) {
    const sd = require('roles_siegeDismantler');
    const d = n.dTile;
    if (!d || !dismantlers(room).some((c) => c.pos.x === d[0] && c.pos.y === d[1] && sd.power(c) > 0)) return false;
    const mine = locked(n.room);
    const here = mine.filter((c) => c.room && c.room.name === n.room && !usedOf(c));
    for (const s of p.slots) if (!here.some((c) => c.pos.x === s[0] && c.pos.y === s[1])) return false;
    if (here.length >= mine.length) return true;
    return Game.time - (Number(n.gatherAt) || Game.time) >= (Number(n.gatherMax) || 600);
}

function cleanup(n) {
    for (const c of locked(n.room)) {
        const m = c.memory;
        delete m.park; delete m.nukeQ; delete m.onlyRes;
    }
    const s = Memory.lootWarLoot;
    if (s.locks && s.locks[n.room] && !s.locks[n.room].releasedAt) require('loot_split').releaseLock(s, n.room, 'nuke', Object.values(Game.creeps || {}));
    const dir = dirFor(n.room);
    if (dir) { delete dir.dTile; delete dir.dWait; }
}

function finish(n) {
    cleanup(n);
    log(n, 'done', { gHome: n.gHome || 0, eHome: n.eHome || 0 });
    const next = Array.isArray(n.order) ? n.order.shift() : null;
    const keep = { gFirst: n.gFirst, n: n.n, order: n.order, events: n.events, walled: n.walled, margin: n.margin, gatherMax: n.gatherMax, past: (n.past || []).concat([{ room: n.room, gHome: n.gHome || 0, eHome: n.eHome || 0, at: Game.time }]) };
    for (const k of Object.keys(n)) delete n[k];
    Object.assign(n, keep);
    if (next) { n.room = next; n.stage = 'wall'; n.at = Game.time; log(n, 'next'); }
    else { n.room = keep.past[keep.past.length - 1].room; n.stage = 'done'; }
}

function run() {
    const n = cfg();
    if (!n || stageOf(n) === 'done') return null;
    if (!n.stage) { n.stage = 'wall'; n.at = Game.time; log(n, 'start'); }
    noteWalls(n);
    const room = Game.rooms[n.room];
    const dir = dirFor(n.room);
    if (!room || !dir) return { stage: n.stage, vision: !!room };
    const p = plan(room, n, dir);
    if (!p) return { stage: n.stage };
    if (n.stage === 'wall') {
        if (!walled(p, dir, n) || !p.nuker) return { stage: n.stage };
        n.dTile = pickDTile(room, p);
        delete planCache.by[room.name];
        const q = plan(room, n, dir);
        dir.dTile = n.dTile;
        dir.dWait = q.wait;
        n.stage = 'gather';
        n.gatherAt = Game.time;
        ensureLock(n);
        log(n, 'gather', { slots: q.slots.length });
        return { stage: n.stage };
    }
    if (n.stage === 'gather') {
        ensureLock(n);
        if (!ready(room, n, p)) return { stage: n.stage };
        const k = Math.max(0, Number(n.gFirst == null ? 4 : n.gFirst));
        const firsts = locked(n.room).filter((c) => p.slots.some((s) => c.pos.x === s[0] && c.pos.y === s[1])).sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, k);
        for (const c of firsts) c.memory.onlyRes = [G];
        n.g = firsts.map((c) => c.name);
        dir.finishGo = true;
        dir.nukerGo = true;
        n.stage = 'strike';
        n.strikeAt = Game.time;
        log(n, 'strike', { g: n.g.length });
        return { stage: n.stage };
    }
    if (n.stage === 'strike') {
        ensureLock(n);
        if (p.nuker) return { stage: n.stage };
        const ruin = (room.lookForAt(LOOK_RUINS, p.t[0], p.t[1]) || [])[0] || null;
        n.ruin = ruin ? ruin.id : null;
        n.stage = 'loot';
        n.downAt = Game.time;
        log(n, 'nukerDown', { ruin: !!ruin, g: ruin && ruin.store ? Number(ruin.store[G] || 0) : 0, e: ruin && ruin.store ? Number(ruin.store[ENERGY] || 0) : 0 });
        return { stage: n.stage };
    }
    if (n.stage === 'loot') {
        ensureLock(n);
        const ruin = n.ruin ? Game.getObjectById(n.ruin) : null;
        const gLeft = ruin && ruin.store ? Number(ruin.store[G] || 0) : 0;
        if (!n.gAllAt && !gLeft && !locked(n.room).some((c) => c.memory.onlyRes && Number(c.store[G] || 0) > 0)) { n.gAllAt = Game.time; log(n, 'gHome', { amount: n.gHome || 0 }); }
        if (!ruin || !(usedOf(ruin) > 0)) { finish(n); return { stage: n.stage, done: true }; }
        return { stage: n.stage };
    }
    return { stage: n.stage };
}

function occupied(room, x, y, name) {
    return (room.lookForAt(LOOK_CREEPS, x, y) || []).some((c) => c.name !== name);
}

function spot(creep, p) {
    const m = creep.memory;
    const room = creep.room;
    const has = m.park && p.slots.some((s) => s[0] === m.park[0] && s[1] === m.park[1]);
    const hk = has ? m.park[0] + ',' + m.park[1] : null;
    if (has && !occupied(room, m.park[0], m.park[1], creep.name) && (!p.taken[hk] || p.taken[hk] === creep.name)) {
        p.taken[m.park[0] + ',' + m.park[1]] = creep.name;
        return m.park;
    }
    for (const s of p.slots) {
        const k = s[0] + ',' + s[1];
        if (p.taken[k] && p.taken[k] !== creep.name) continue;
        if (occupied(room, s[0], s[1], creep.name)) continue;
        p.taken[k] = creep.name;
        m.park = [s[0], s[1]];
        delete m.nukeQ;
        return m.park;
    }
    delete m.park;
    if (!p.queue.length) return null;
    const names = locked(room.name).map((c) => c.name).sort();
    const i = Math.max(0, names.indexOf(creep.name));
    m.nukeQ = p.queue[i % p.queue.length];
    return m.nukeQ;
}

function stand(creep, p) {
    const s = spot(creep, p);
    if (!s) return;
    if (creep.pos.x !== s[0] || creep.pos.y !== s[1]) require('movement').go(creep, new RoomPosition(s[0], s[1], creep.room.name), { range: 0, reusePath: 5 });
}

function haulerRun(creep, carrying) {
    const n = cfg();
    if (!n) return false;
    const m = creep.memory;
    const st = stageOf(n);
    if (n.room !== m.targetRoom || STAGES.indexOf(st) < 1 || lockOf(m) !== n.room) return false;
    if (creep.room.name !== n.room || m.dying || m.state === 'deliver') return false;
    const dir = dirFor(n.room);
    if (!dir) return false;
    const p = plan(creep.room, n, dir);
    if (!p) return false;
    if (st === 'gather' || st === 'strike') {
        if (carrying) { m.state = 'deliver'; return true; }
        stand(creep, p);
        return true;
    }
    const ruin = n.ruin ? Game.getObjectById(n.ruin) : null;
    if (!ruin || !ruin.store) { delete m.park; delete m.nukeQ; delete m.onlyRes; return false; }
    const gLeft = Number(ruin.store[G] || 0);
    const eLeft = Number(ruin.store[ENERGY] || 0);
    const free = creep.store && typeof creep.store.getFreeCapacity === 'function' ? Number(creep.store.getFreeCapacity()) || 0 : 0;
    if (carrying && free <= 0) { m.state = 'deliver'; return true; }
    let res = null;
    if (m.onlyRes) {
        if (gLeft > 0) res = G;
        else { delete m.onlyRes; if (carrying) { m.state = 'deliver'; return true; } }
    }
    if (!res) res = gLeft > 0 && !locked(n.room).some((c) => c.memory.onlyRes) ? G : (eLeft > 0 ? ENERGY : (gLeft > 0 ? G : null));
    if (!res) { delete m.park; delete m.nukeQ; if (carrying) { m.state = 'deliver'; return true; } return false; }
    if (creep.pos.getRangeTo(ruin) <= 1) {
        creep.withdraw(ruin, res);
        return true;
    }
    stand(creep, p);
    return true;
}

function noteUnload(creep, res, amount) {
    const n = cfg();
    if (!n || !(amount > 0)) return;
    const m = creep.memory;
    if (lockOf(m) !== n.room && m.cf !== n.room) return;
    if (STAGES.indexOf(stageOf(n)) < 3) return;
    if (res === G) n.gHome = (n.gHome || 0) + amount;
    else if (res === ENERGY) n.eHome = (n.eHome || 0) + amount;
}

module.exports = { cfg, active, run, plan, haulerRun, noteUnload, focusLeft, rampartAt, nukerAt, ready, spot, stageOf, dirFor };
