'use strict';

const REANALYZE = 1500;
const HITS_PER_COST = 100000;
const DISMANTLER_HITS = 4000000;
const DISMANTLER_CREDITS = 1150000;
const OBSTACLES = new Set(typeof OBSTACLE_OBJECT_TYPES !== 'undefined' ? OBSTACLE_OBJECT_TYPES : ['spawn', 'extension', 'constructedWall', 'link', 'storage', 'tower', 'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'nuker', 'factory', 'invaderCore']);

function book(roomName) {
    const all = Memory.lootBlocked || (Memory.lootBlocked = {});
    return all[roomName] || (all[roomName] = { items: {}, at: 0 });
}

function storeOf(obj) {
    const out = {};
    if (obj.store) {
        for (const k in obj.store) if (typeof obj.store[k] === 'number' && obj.store[k] > 0) out[k] = obj.store[k];
    } else if (obj.resourceType) out[obj.resourceType] = Number(obj.amount) || 0;
    return out;
}

function note(roomName, obj) {
    if (!obj || !obj.id || !obj.pos) return;
    const b = book(roomName);
    b.items[obj.id] = { type: obj.structureType || (obj.deathTime != null ? 'tombstone' : obj.destroyTime != null ? 'ruin' : obj.resourceType ? 'dropped' : 'object'), x: obj.pos.x, y: obj.pos.y, store: storeOf(obj), at: Game.time };
}

function priceOf(res) {
    const all = Memory.lootPrice || (Memory.lootPrice = {});
    const day = new Date().toISOString().slice(0, 10);
    const rec = all[res];
    if (rec && rec.day === day) return rec.p;
    let p = 0;
    try {
        const hist = Game.market && typeof Game.market.getHistory === 'function' ? Game.market.getHistory(res) || [] : [];
        let vol = 0;
        let sum = 0;
        for (const h of hist) { const v = Number(h.volume) || 0; vol += v; sum += v * (Number(h.avgPrice) || 0); }
        p = vol > 0 ? sum / vol : 0;
    } catch (e) { p = 0; }
    all[res] = { p, day };
    return p;
}

function valueOf(store) {
    let v = 0;
    for (const k in store) v += (Number(store[k]) || 0) * priceOf(k);
    return v;
}

function breachMatrix(room) {
    const cm = new PathFinder.CostMatrix();
    const hits = {};
    for (const st of room.find(FIND_STRUCTURES)) {
        const x = st.pos.x;
        const y = st.pos.y;
        const breakable = st.structureType === STRUCTURE_WALL || (st.structureType === STRUCTURE_RAMPART && !st.my && !st.isPublic);
        if (breakable) {
            const key = x + ',' + y;
            const rec = hits[key] || (hits[key] = { hits: 0, ids: [] });
            rec.hits += Number(st.hits) || 0;
            rec.ids.push(st.id);
            const c = Math.min(254, Math.max(1, Math.ceil(rec.hits / HITS_PER_COST)));
            if (cm.get(x, y) !== 255) cm.set(x, y, Math.max(cm.get(x, y), c));
        } else if (OBSTACLES.has(st.structureType)) cm.set(x, y, 255);
        else if (st.structureType === STRUCTURE_ROAD && !cm.get(x, y)) cm.set(x, y, 1);
    }
    for (const key in hits) {
        const [x, y] = key.split(',').map(Number);
        const blocked = room.lookForAt ? (room.lookForAt(LOOK_STRUCTURES, x, y) || []).some((s) => OBSTACLES.has(s.structureType) && s.structureType !== STRUCTURE_WALL) : false;
        if (blocked) cm.set(x, y, 255);
    }
    return { cm, hits };
}

function analyze(room, origin) {
    if (!room || !origin) return null;
    const b = book(room.name);
    if (Game.time - (Number(b.at) || 0) < REANALYZE) return null;
    b.at = Game.time;
    const ids = Object.keys(b.items);
    if (!ids.length) { b.routes = []; return b; }
    const { cm, hits } = breachMatrix(room);
    const groups = {};
    for (const id of ids) {
        const obj = Game.getObjectById(id);
        const left = obj ? storeOf(obj) : {};
        if (!obj || !Object.keys(left).length) { delete b.items[id]; continue; }
        b.items[id].store = left;
        const res = PathFinder.search(origin, { pos: obj.pos, range: 1 }, { plainCost: 1, swampCost: 5, maxRooms: 1, maxOps: 8000, roomCallback: (n) => (n === room.name ? cm : false) });
        const walls = [];
        let total = 0;
        for (const p of res.path || []) {
            const h = hits[p.x + ',' + p.y];
            if (!h) continue;
            walls.push({ ids: h.ids, x: p.x, y: p.y, hits: h.hits });
            total += h.hits;
        }
        b.items[id].route = { walls: walls.map((w) => w.ids.join('+')), hits: total, incomplete: !!res.incomplete };
        const key = walls.map((w) => w.ids.join('+')).sort().join('|') || '-';
        const g = groups[key] || (groups[key] = { walls, hits: total, targets: [], store: {} });
        g.targets.push(id);
        for (const k in left) g.store[k] = (g.store[k] || 0) + left[k];
    }
    const keys = Object.keys(groups);
    const routes = [];
    for (const key of keys) {
        const g = groups[key];
        const set = new Set(key === '-' ? [] : key.split('|'));
        const store = Object.assign({}, g.store);
        const targets = g.targets.slice();
        for (const other of keys) {
            if (other === key) continue;
            const os = other === '-' ? [] : other.split('|');
            if (os.length < set.size && os.every((w) => set.has(w))) {
                for (const k in groups[other].store) store[k] = (store[k] || 0) + groups[other].store[k];
                for (const t of groups[other].targets) targets.push(t);
            }
        }
        const value = Math.round(valueOf(store));
        const dismantlers = Math.ceil(g.hits / DISMANTLER_HITS);
        const cost = dismantlers * DISMANTLER_CREDITS;
        routes.push({ walls: g.walls, hits: g.hits, dismantlers, cost, value, ratio: cost > 0 ? Math.round(value / cost * 100) / 100 : null, targets, store });
    }
    routes.sort((a, b2) => (b2.ratio || 0) - (a.ratio || 0));
    b.routes = routes;
    return b;
}

module.exports = { note, analyze, priceOf, valueOf, breachMatrix, book, REANALYZE, DISMANTLER_HITS, DISMANTLER_CREDITS };
