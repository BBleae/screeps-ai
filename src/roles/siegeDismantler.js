'use strict';
const movement = require('movement');
const retire = require('retire');
const conquest = require('conquest');
const boost = require('boost');

function fastDismantle(creep, target) {
    const m = creep.memory;
    if (!m.tgt || creep.room.name !== target || !m.salvageLoot) return false;
    if (Game.time % 10 === 0 && conquest.retreatFor(target)) { delete m.tgt; return false; }
    if (Game.time - (m.tgtAt || 0) > 100) { delete m.tgt; return false; }
    const obj = Game.getObjectById(m.tgt);
    if (!obj) { delete m.tgt; return false; }
    const rc = creep.dismantle(obj);
    if (rc === OK) return true;
    if (rc === ERR_NOT_IN_RANGE) { approach(creep, obj); return true; }
    delete m.tgt;
    return false;
}

function isBarrier(st) {
    return st.structureType === STRUCTURE_RAMPART ? !st.my : st.structureType === STRUCTURE_WALL;
}

function breachFor(creep, obj) {
    const m = creep.memory;
    if (m.br) {
        const b = Game.getObjectById(m.br);
        if (b && m.brFor === obj.id) return b;
        delete m.br;
        delete m.brAt;
    }
    if (m.brAt && Game.time - m.brAt < 50 && m.brFor === obj.id) return null;
    m.brAt = Game.time;
    m.brFor = obj.id;
    const room = creep.room;
    const res = PathFinder.search(creep.pos, { pos: obj.pos, range: 1 }, {
        maxRooms: 1,
        maxOps: 4000,
        roomCallback: (name) => {
            if (name !== room.name) return false;
            const cm = new PathFinder.CostMatrix();
            for (const st of room.find(FIND_STRUCTURES)) {
                const t = st.structureType;
                if (t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER || (t === STRUCTURE_RAMPART && st.my)) continue;
                cm.set(st.pos.x, st.pos.y, isBarrier(st) ? Math.min(254, 5 + Math.floor(st.hits / 100000)) : 255);
            }
            return cm;
        },
    });
    if (res.incomplete) return null;
    for (const p of res.path) {
        const b = room.lookForAt(LOOK_STRUCTURES, p.x, p.y).find(isBarrier);
        if (b) { m.br = b.id; return b; }
    }
    return null;
}

function approach(creep, obj) {
    if (creep.memory.salvageLoot && obj.pos.roomName === creep.room.name) {
        const b = breachFor(creep, obj);
        if (b) {
            if (creep.dismantle(b) === ERR_NOT_IN_RANGE) movement.go(creep, b, { range: 1, reusePath: 50 });
            return;
        }
    }
    movement.go(creep, obj, { range: 1, reusePath: 50 });
}

function hitTarget(creep, obj) {
    creep.memory.tgt = obj.id;
    creep.memory.tgtAt = Game.time;
    if (creep.dismantle(obj) === ERR_NOT_IN_RANGE) approach(creep, obj);
}

const mateCache = { tick: -1, by: {} };
function squadMates(creep) {
    if (mateCache.tick !== Game.time) { mateCache.tick = Game.time; mateCache.by = {}; }
    const key = creep.memory.targetRoom;
    if (mateCache.by[key]) return mateCache.by[key];
    const out = [];
    for (const name in Game.creeps) {
        const other = Game.creeps[name];
        if (!other.memory) continue;
        const role = other.memory.role;
        if (role !== 'siegeDismantler' && role !== 'siegeGuard') continue;
        if (other.memory.targetRoom !== key) continue;
        if (other.spawning) continue;
        out.push(other);
    }
    mateCache.by[key] = out;
    return out;
}

function hostileStructures(room, type) {
    return room.find(FIND_STRUCTURES).filter((s) => s.structureType === type && s.owner && !s.my && !require('utils').isAlly(s));
}

function towerEnergy(t) {
    if (t.store && typeof t.store.getUsedCapacity === 'function') return t.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (typeof t.energy === 'number') return t.energy;
    return 0;
}
const TOWER_MIN_FIRE = (typeof TOWER_ENERGY_COST !== 'undefined') ? TOWER_ENERGY_COST : 10;

const STAGE_OFFSET = 8;
function stagePos(staging, target) {
    const map = (typeof Game !== 'undefined' && Game.map && Game.map.findExit) ? Game.map : null;
    const dir = map ? map.findExit(staging, target) : null;
    const o = STAGE_OFFSET;
    const L = typeof FIND_EXIT_LEFT === 'undefined' ? 7 : FIND_EXIT_LEFT;
    const R = typeof FIND_EXIT_RIGHT === 'undefined' ? 3 : FIND_EXIT_RIGHT;
    const T = typeof FIND_EXIT_TOP === 'undefined' ? 1 : FIND_EXIT_TOP;
    const B = typeof FIND_EXIT_BOTTOM === 'undefined' ? 5 : FIND_EXIT_BOTTOM;
    if (dir === L) return new RoomPosition(o, 25, staging);
    if (dir === R) return new RoomPosition(49 - o, 25, staging);
    if (dir === T) return new RoomPosition(25, o, staging);
    if (dir === B) return new RoomPosition(25, 49 - o, staging);
    return new RoomPosition(25, 25, staging);
}

function avoidSet(creep, target) {
    const set = new Set(movement.civilianDangerRooms());
    set.add(target);
    const extra = creep.memory.avoid;
    if (Array.isArray(extra)) for (const r of extra) set.add(r);
    return set;
}


function lootHoldRun(creep) {
    if (typeof Memory === 'undefined') return false;
    const m = creep.memory;
    if (m.retired) return false;
    const lr = require('config').lootRoutes || {};
    const list = lr[m.targetRoom];
    const back = lr.reentry && lr.reentry[creep.room.name];
    if (back && Array.isArray(list) && list.indexOf(creep.room.name) < 0) {
        movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 50, avoidRooms: new Set(lr.hardAvoid || []) });
        return true;
    }
    const h = Memory.lootHold;
    if (!h || !(h === true || h[m.targetRoom])) return false;
    if (h !== true && h[m.targetRoom] === 'haulers') return false;
    const home = m.home;
    if (!home) return false;
    if (creep.room.name !== home) { movement.go(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 }); return true; }
    const p = creep.pos;
    if (p.x <= 2 || p.x >= 47 || p.y <= 2 || p.y >= 47) movement.go(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 });
    return true;
}

const postCache = { tick: -1, by: {}, q: {} };
function power(c) {
    let n = 0;
    for (const p of c.body || []) {
        if (p.type !== WORK || p.hits === 0) continue;
        const b = p.boost && typeof BOOSTS !== 'undefined' && BOOSTS.work && BOOSTS.work[p.boost];
        n += b && b.dismantle ? b.dismantle : 1;
    }
    return n;
}

function boostedWork(c) {
    return (c.body || []).some((p) => p.type === WORK && p.boost);
}

function claimedStands(target) {
    if (postCache.tick !== Game.time) { postCache.tick = Game.time; postCache.by = {}; postCache.q = {}; }
    if (!postCache.by[target]) {
        const set = new Map();
        const q = new Map();
        for (const n in Game.creeps) {
            const c = Game.creeps[n];
            const m = c.memory;
            if (!m || m.role !== 'siegeDismantler' || m.targetRoom !== target) continue;
            if (m.post) set.set(m.post.s[0] + ',' + m.post.s[1], { name: n, power: power(c) });
            else if (m.q) q.set(m.q[0] + ',' + m.q[1], n);
        }
        postCache.by[target] = set;
        postCache.q[target] = q;
    }
    return postCache.by[target];
}

function barrierAt(room, t) {
    return room.lookForAt(LOOK_STRUCTURES, t[0], t[1]).find(isBarrier) || null;
}

function openCheck(room, dir, e) {
    if (!Array.isArray(e.open)) return true;
    const key = e.t[0] + ',' + e.t[1];
    const memo = dir.openChk || (dir.openChk = {});
    const c = memo[key];
    if (c && Game.time - c.at < 300) return c.ok;
    const stand = (e.s || [])[0];
    if (!stand) return false;
    const res = PathFinder.search(new RoomPosition(stand[0], stand[1], room.name), { pos: new RoomPosition(e.open[0], e.open[1], room.name), range: 0 }, {
        maxRooms: 1,
        maxOps: 6000,
        roomCallback: (name) => {
            if (name !== room.name) return false;
            const cm = new PathFinder.CostMatrix();
            for (const st of room.find(FIND_STRUCTURES)) {
                const t = st.structureType;
                if (st.pos.x === e.t[0] && st.pos.y === e.t[1]) continue;
                if (t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER || (t === STRUCTURE_RAMPART && st.my)) continue;
                cm.set(st.pos.x, st.pos.y, 255);
            }
            return cm;
        },
    });
    const ok = !res.incomplete;
    memo[key] = { ok, at: Game.time, len: res.path ? res.path.length : 0 };
    return ok;
}

function queueRun(creep, dir, target, open) {
    const m = creep.memory;
    const qs = open ? dir.innerQueue : dir.queue;
    const list = Array.isArray(qs) && qs.length ? qs : null;
    if (open && !list) {
        delete m.q;
        const e = dir.posts.find((x) => Array.isArray(x.after) && x.after.length && x.s && x.s[0]);
        if (!e) return false;
        const wait = new RoomPosition(e.s[0][0], e.s[0][1], target);
        if (creep.pos.getRangeTo(wait) > 2) movement.go(creep, wait, { range: 2, reusePath: 20 });
        return true;
    }
    if (list) {
        claimedStands(target);
        const q = postCache.q[target];
        let spot = m.q && list.some((p) => p[0] === m.q[0] && p[1] === m.q[1]) && q.get(m.q[0] + ',' + m.q[1]) === creep.name ? m.q : null;
        if (!spot) {
            spot = list.find((p) => { const h = q.get(p[0] + ',' + p[1]); return !h || h === creep.name || !Game.creeps[h]; }) || null;
            if (spot) { m.q = [spot[0], spot[1]]; q.set(spot[0] + ',' + spot[1], creep.name); }
        }
        if (spot) {
            if (creep.pos.x !== spot[0] || creep.pos.y !== spot[1]) movement.go(creep, new RoomPosition(spot[0], spot[1], target), { range: 0, reusePath: 20 });
            return true;
        }
    }
    const s0 = dir.posts[0].s && dir.posts[0].s[0];
    if (!s0) return false;
    const wait = new RoomPosition(s0[0], s0[1], target);
    if (creep.pos.getRangeTo(wait) > 3) movement.go(creep, wait, { range: 3, reusePath: 20 });
    return true;
}

function innerOpen(room, dir) {
    return dir.posts.some((e) => Array.isArray(e.after) && e.after.length && e.after.some((t) => !barrierAt(room, t)));
}

const CLEAR_MAX = 10000;
function blocks(st) {
    const t = st.structureType;
    return !(t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER || (t === STRUCTURE_RAMPART && (st.my || st.isPublic)));
}

function clearable(room, st) {
    if (st.my || !st.owner) return false;
    const t = st.structureType;
    if (t === STRUCTURE_RAMPART || t === STRUCTURE_WALL || t === STRUCTURE_STORAGE || t === STRUCTURE_TERMINAL || t === STRUCTURE_FACTORY) return false;
    if (!(st.hits <= CLEAR_MAX)) return false;
    return !room.lookForAt(LOOK_STRUCTURES, st.pos.x, st.pos.y).some((x) => x.structureType === STRUCTURE_RAMPART && !x.my && !x.isPublic);
}

function standAround(room, t) {
    const terrain = room.getTerrain();
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const x = t[0] + dx;
            const y = t[1] + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
            const sts = room.lookForAt(LOOK_STRUCTURES, x, y).filter(blocks);
            if (sts.length && !sts.every((st) => clearable(room, st))) continue;
            out.push([x, y]);
        }
    }
    return out;
}

function coreBarrierTiles(room, dir) {
    const out = (Array.isArray(dir.lootTiles) ? dir.lootTiles : []).map((p) => [p[0], p[1]]);
    for (const st of room.find(FIND_STRUCTURES)) {
        const t = st.structureType;
        if (st.my || (t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL && t !== STRUCTURE_FACTORY)) continue;
        if (barrierAt(room, [st.pos.x, st.pos.y])) out.push([st.pos.x, st.pos.y]);
    }
    return out;
}

const innerCache = { tick: -1, by: {} };
function innerPosts(room, dir) {
    if (innerCache.tick !== Game.time) { innerCache.tick = Game.time; innerCache.by = {}; }
    if (innerCache.by[room.name]) return innerCache.by[room.name];
    const out = [];
    const seen = new Set();
    const add = (t, s, after) => {
        const key = t[0] + ',' + t[1];
        if (seen.has(key) || !barrierAt(room, t)) return;
        seen.add(key);
        const list = (s || []).map((p) => [p[0], p[1]]);
        for (const p of standAround(room, t)) if (!list.some((q) => q[0] === p[0] && q[1] === p[1])) list.push(p);
        out.push({ t: [t[0], t[1]], s: list, after: Array.isArray(after) && after.length ? after : [[t[0], t[1]]] });
    };
    for (const e of dir.posts) if (Array.isArray(e.after) && e.after.length) add(e.t, e.s, e.after);
    for (const t of coreBarrierTiles(room, dir)) add(t, null, null);
    innerCache.by[room.name] = out;
    return out;
}

function sideRun(creep, posts) {
    const room = creep.room;
    const m = creep.memory;
    let obj = m.side ? Game.getObjectById(m.side) : null;
    if (!obj || !isBarrier(obj)) {
        delete m.side;
        obj = null;
        const seen = new Set(posts.map((e) => e.t[0] + ',' + e.t[1]));
        for (const e of posts) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = e.t[0] + dx;
                    const y = e.t[1] + dy;
                    if (seen.has(x + ',' + y)) continue;
                    const b = barrierAt(room, [x, y]);
                    if (b && (!obj || b.hits < obj.hits)) obj = b;
                }
            }
        }
        if (!obj) return false;
        m.side = obj.id;
    }
    if (creep.dismantle(obj) === ERR_NOT_IN_RANGE) movement.go(creep, obj, { range: 1, reusePath: 20 });
    return true;
}

function strongerWaiting(creep, mine) {
    for (const c of squadMates(creep)) {
        if (c.name === creep.name || c.memory.post || c.memory.retired || !c.room || c.room.name !== creep.room.name) continue;
        if (c.memory.role !== 'siegeDismantler') continue;
        const p = power(c);
        if (p > mine || (p === mine && c.name < creep.name)) return true;
    }
    return false;
}

function releaseSlot(creep) {
    const m = creep.memory;
    const k = String(m.slotKey || '');
    const mt = k.match(/^(siegeBoost|siegeLoot|siege):([^:]+):/);
    if (!mt || !m.targetRoom || mt[2] === m.targetRoom) return false;
    m.slotFrom = k;
    m.slotKey = freeBoostSlot(m.targetRoom) || 'moved:' + m.targetRoom + ':' + creep.name;
    return true;
}

function freeBoostSlot(target) {
    let dir = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === target && !x.completed) { dir = x; break; }
    if (!dir || !dir.boostPlan || typeof dir.boostPlan !== 'object') return null;
    const n = Math.max(0, Number(dir.boostPlan.base) || 0);
    const prefix = 'siegeBoost:' + target + ':';
    const held = new Set();
    for (const name in Game.creeps) {
        const k = String((Game.creeps[name].memory || {}).slotKey || '');
        if (k.indexOf(prefix) === 0 && !Game.creeps[name].memory.retired) held.add(k);
    }
    for (let i = 0; i < n; i++) if (!held.has(prefix + i)) return prefix + i;
    return null;
}

function postUsable(room, dir, e, open) {
    if (!barrierAt(room, e.t)) return false;
    const inner = Array.isArray(e.after) && e.after.length;
    if (inner && !open) return false;
    if (!inner && open) return false;
    return openCheck(room, dir, e);
}

function postRun(creep) {
    const m = creep.memory;
    const target = m.targetRoom;
    if (!target || creep.room.name !== target || !m.salvageLoot) return false;
    let dir = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === target && !x.completed) { dir = x; break; }
    if (!dir || !Array.isArray(dir.posts) || !dir.posts.length) { delete m.post; delete m.q; return false; }
    const open = innerOpen(creep.room, dir);
    if (open && !dir.innerOpenAt) dir.innerOpenAt = Game.time;
    const posts = open ? innerPosts(creep.room, dir) : dir.posts;
    let obj = m.post ? barrierAt(creep.room, m.post.t) : null;
    let upgrade = false;
    if (m.post) {
        const e = posts.find((x) => x.t[0] === m.post.t[0] && x.t[1] === m.post.t[1] && (x.s || []).some((p) => p[0] === m.post.s[0] && p[1] === m.post.s[1]));
        if (!obj || !e || !postUsable(creep.room, dir, e, open)) { delete m.post; obj = null; }
        else if (e.side && Game.time % 5 === 0) upgrade = true;
        if (m.post) delete m.side;
    }
    if (!m.post || upgrade) {
        const taken = claimedStands(target);
        const mine = power(creep);
        const held = m.post;
        for (const e of posts) {
            if (upgrade && e.side) continue;
            if (!postUsable(creep.room, dir, e, open)) continue;
            let s = strongerWaiting(creep, mine) ? null : (e.s || []).find((p) => { const h = taken.get(p[0] + ',' + p[1]); return !h || !Game.creeps[h.name]; });
            if (!s) {
                let low = null;
                for (const p of e.s || []) {
                    const h = taken.get(p[0] + ',' + p[1]);
                    if (h && h.name !== creep.name && h.power < mine && (!low || h.power < low.h.power)) low = { p, h };
                }
                if (low) {
                    s = low.p;
                    const hc = Game.creeps[low.h.name];
                    if (hc) { delete hc.memory.post; hc.memory.postBumpedAt = Game.time; }
                }
            }
            if (!s) continue;
            if (held) taken.delete(held.s[0] + ',' + held.s[1]);
            m.post = { t: [e.t[0], e.t[1]], s: [s[0], s[1]] };
            delete m.q;
            taken.set(s[0] + ',' + s[1], { name: creep.name, power: mine });
            obj = barrierAt(creep.room, e.t);
            break;
        }
        if (!m.post && open && dir.sideBarriers && sideRun(creep, posts)) return true;
        if (!m.post) return queueRun(creep, dir, target, open);
        if (upgrade && m.post === held) upgrade = false;
    }
    if (creep.pos.x === m.post.s[0] && creep.pos.y === m.post.s[1]) {
        creep.dismantle(obj);
        return true;
    }
    const sp = new RoomPosition(m.post.s[0], m.post.s[1], target);
    const block = creep.room.lookForAt(LOOK_STRUCTURES, sp.x, sp.y).find(blocks);
    if (block) {
        if (creep.pos.getRangeTo(sp) <= 1) creep.dismantle(block);
        else movement.go(creep, sp, { range: 1, reusePath: 20 });
        return true;
    }
    if (obj && creep.pos.getRangeTo(obj) <= 1) creep.dismantle(obj);
    const key = creep.pos.x + ',' + creep.pos.y;
    if (m.stIdle && m.stIdle.k === key) m.stIdle.n++; else m.stIdle = { k: key, n: 0 };
    if (m.stIdle.n >= 3 && clearToward(creep, sp)) return true;
    movement.go(creep, sp, { range: 0, reusePath: 20 });
    return true;
}

function clearToward(creep, sp) {
    const room = creep.room;
    const res = PathFinder.search(creep.pos, { pos: sp, range: 0 }, {
        maxRooms: 1,
        maxOps: 4000,
        roomCallback: (name) => {
            if (name !== room.name) return false;
            const cm = new PathFinder.CostMatrix();
            for (const st of room.find(FIND_STRUCTURES)) {
                if (!blocks(st)) continue;
                cm.set(st.pos.x, st.pos.y, clearable(room, st) ? 20 : 255);
            }
            return cm;
        },
    });
    if (res.incomplete || !res.path.length) return false;
    const step = res.path[0];
    const st = room.lookForAt(LOOK_STRUCTURES, step.x, step.y).find(blocks);
    if (st && clearable(room, st)) { creep.dismantle(st); return true; }
    if (!st) { creep.move(creep.pos.getDirectionTo(step)); return true; }
    return false;
}

function retireUnboosted(creep) {
    const m = creep.memory;
    if (m.retired) return false;
    const target = m.targetRoom;
    if (!target || !creep.room || creep.room.name !== target) return false;
    let dir = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === target && !x.completed) { dir = x; break; }
    if (!dir || !dir.retireUnboosted || boostedWork(creep)) return false;
    m.retired = true;
    delete m.post;
    delete m.q;
    return true;
}

function unboostedTimeout(creep) {
    const m = creep.memory;
    if (!m.boostDone || !Array.isArray(m.boosts) || !m.boosts.length || boostedWork(creep)) return false;
    let dir = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === m.targetRoom && !x.completed) { dir = x; break; }
    return !!(dir && dir.retireUnboosted);
}

function bucketHold(creep) {
    const m = creep.memory;
    if (m.retired) return false;
    let dir = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === m.targetRoom && !x.completed) { dir = x; break; }
    const min = dir && Number(dir.dismantleBucketMin);
    if (!(min > 0) || Game.cpu.bucket >= min) { delete m.bucketHold; return false; }
    if (!m.bucketHold) m.bucketHold = Game.time;
    return true;
}

const endCache = { tick: -1, by: {} };
function endCheck(target) {
    if (endCache.tick !== Game.time) { endCache.tick = Game.time; endCache.by = {}; }
    if (target in endCache.by) return endCache.by[target];
    let dir = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === target && !x.completed) { dir = x; break; }
    let out = null;
    if (dir && dir.handoff && (Array.isArray(dir.handoff.tile) || Array.isArray(dir.handoff.tiles))) {
        const h = dir.handoff;
        if (!h.at) {
            const room = Game.rooms[target];
            const tiles = Array.isArray(h.tiles) ? h.tiles : [h.tile];
            if (room && tiles.every((t) => !barrierAt(room, t))) { h.at = Game.time; dir.pauseDismantlerSpawn = true; }
        }
        if (h.at) out = h;
    }
    endCache.by[target] = out;
    return out;
}

function handoff(creep) {
    const m = creep.memory;
    if (m.retired || !m.targetRoom || creep.spawning) return false;
    const h = endCheck(m.targetRoom);
    if (!h) return false;
    const next = h.to;
    let nd = null;
    for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === next && !x.completed) { nd = x; break; }
    if (nd && creep.ticksToLive != null && creep.ticksToLive > (Number(h.minTtl) || 500)) {
        m.handoffFrom = m.targetRoom;
        m.targetRoom = next;
        m.lootTiles = Array.isArray(nd.lootTiles) ? nd.lootTiles.map((p) => [p[0], p[1]]) : [];
        m.squad = 1;
        for (const k of ['post', 'q', 'side', 'tgt', 'pushed', 'enteredAt', 'launched', 'stagedAt', 'idleFocus']) delete m[k];
        releaseSlot(creep);
        return false;
    }
    m.retired = true;
    delete m.post;
    delete m.q;
    return true;
}

function run(creep) {
    if (handoff(creep)) { retire.retireAtSpawn(creep); return; }
    releaseSlot(creep);
    retireUnboosted(creep);
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
    if (bucketHold(creep)) return;
    if (lootHoldRun(creep)) return;
    if (require('roles_lootHauler').gateHold(creep)) return;
    if (postRun(creep)) return;
    const target = creep.memory.targetRoom;
    if (!target) return;
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
    if (fastDismantle(creep, target)) return;
    if (!(creep.memory._rtAt > Game.time - 10)) { creep.memory._rtAt = Game.time; conquest.recordHostileTowers(creep.room, creep); }
    if (creep.memory.strongholdLoot && conquest.retreatFor(target)) {
        const back = creep.memory.staging || creep.memory.home || target;
        if (creep.room.name !== back) movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 15 });
        return;
    }
    const staging = creep.memory.staging || target;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);

    if (creep.room.name !== target) {
        if (boost.run(creep)) return;
        if (unboostedTimeout(creep)) { creep.memory.retired = true; retire.retireAtSpawn(creep); return; }
        const avoid = avoidSet(creep, target);
        if (creep.memory.strongholdLoot && conquest.boostGateHold(target)) {
            if (creep.room.name !== (creep.memory.home || target)) movement.go(creep, new RoomPosition(25, 25, creep.memory.home || target), { range: 20, reusePath: 15 });
            return;
        }
        if (squad > 1 && creep.room.name === staging && !creep.memory.launched) {
            if (creep.memory.stagedAt == null) creep.memory.stagedAt = Game.time;
            const here = squadMates(creep).filter((m) => m.room && m.room.name === staging).length;
            const stageWait = conquest.settings().stageWait;
            if (here < squad && Game.time - creep.memory.stagedAt < (stageWait == null ? 200 : stageWait)) {
                const spot = conquest.holdTile(stagePos(staging, target), creep.name, 0);
                if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 20, avoidRooms: avoid });
                return;
            }
            creep.memory.launched = true;
        }
        if (squad <= 1 || creep.memory.launched || staging === target) {
            const laneW = conquest.settings().entryLaneWidth;
            const avoidTowers = creep.memory.salvageLoot ? undefined : conquest.towerAvoidCallback(target, creep.memory.avoidTowers);
            if (laneW > 0) {
                const entry = stagePos(target, staging);
                movement.go(creep, conquest.laneTile(entry, creep.name, laneW, entry.x === 25), { range: 5, reusePath: 20, costCallback: avoidTowers });
            } else {
                movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40, costCallback: avoidTowers });
            }
        } else {
            movement.go(creep, stagePos(staging, target), { range: 3, reusePath: 40, avoidRooms: avoid, costCallback: creep.memory.salvageLoot ? undefined : conquest.towerAvoidCallback(target, creep.memory.avoidTowers) });
        }
        return;
    }

    const ctrl = creep.room.controller;
    if (ctrl && ctrl.safeMode && ctrl.safeMode > 0) {
        creep.memory.launched = false;
        delete creep.memory.pushed;
        delete creep.memory.enteredAt;
        movement.go(creep, new RoomPosition(25, 25, staging), { range: 20, reusePath: 15 });
        return;
    }
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        return;
    }
    if (!creep.memory.pushed) {
        if (creep.memory.enteredAt == null) creep.memory.enteredAt = Game.time;
        const cfg = conquest.settings();
        const inRoom = Math.max(1, squadMates(creep).filter((m) => m.room && m.room.name === target).length);
        const need = Math.min(squad, Math.max(1, Math.ceil(squad * (cfg.reformShare == null ? 0.7 : cfg.reformShare))));
        const waited = Game.time - creep.memory.enteredAt;
        if (inRoom < need && waited < (cfg.reformWait == null ? 60 : cfg.reformWait)) {
            const rally = conquest.holdTile(stagePos(target, staging), creep.name, 0);
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
            return;
        }
        creep.memory.pushed = true;
    }
    if (creep.memory.lootTiles || creep.memory.salvageLoot) {
        if (creep.memory.salvageLoot && conquest.retreatFor(target)) {
            const back = creep.memory.staging || creep.memory.home || target;
            if (creep.room.name !== back) movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 15 });
            return;
        }
        let dir = null;
        for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === target && !x.completed) { dir = x; break; }
        const focus = dir && Array.isArray(dir.focusTiles) && dir.focusTiles.length ? dir.focusTiles : null;
        let tiles = focus || creep.memory.lootTiles || [];
        let rr = tiles.length ? conquest.lootRampartTargets(creep.room, tiles) : [];
        if (!rr.length && focus && Array.isArray(creep.memory.lootTiles) && creep.memory.lootTiles.length) {
            tiles = creep.memory.lootTiles;
            rr = conquest.lootRampartTargets(creep.room, tiles);
        }
        if (rr.length) {
            if (creep.memory.salvageLoot && tiles.length) {
                const order = new Map(tiles.map((p, i) => [p[0] + ',' + p[1], i]));
                const rank = (t) => { const k = t.pos.x + ',' + t.pos.y; return order.has(k) ? order.get(k) : 99; };
                rr = rr.slice().sort((a, b) => rank(a) - rank(b) || a.hits - b.hits);
            } else {
                rr = [rr.reduce((low, t) => (t.hits < low.hits ? t : low), rr[0])];
            }
            hitTarget(creep, rr[0]);
            return;
        }
        if (focus && creep.memory.salvageLoot) { creep.memory.idleFocus = Game.time; return; }
        if (creep.memory.salvageLoot) {
            let directive = null;
            const raw = Memory.conquest;
            const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            for (const x of list) if (x && x.target === target && !x.completed) { directive = x; break; }
            const structs = conquest.salvageStructures(creep.room, directive || { lootOpen: true, structures: ['storage', 'terminal', 'factory'], skipTypes: ['nuker'] });
            if (structs.length) {
                hitTarget(creep, structs[0]);
                return;
            }
            if (directive && directive.openWall) {
                const here = creep.room.lookForAt(LOOK_STRUCTURES, directive.openWall.x, directive.openWall.y) || [];
                const wall = here.find((s) => s.structureType === STRUCTURE_WALL || s.structureType === 'constructedWall');
                if (wall) {
                    hitTarget(creep, wall);
                    return;
                }
            }
            creep.memory.retired = true; retire.retireAtSpawn(creep); return;
        }
        creep.memory.retired = true; retire.retireAtSpawn(creep); return;
    }
    const towers = hostileStructures(creep.room, STRUCTURE_TOWER);
    let targets = towers.filter((t) => towerEnergy(t) >= TOWER_MIN_FIRE);
    if (!targets.length) targets = hostileStructures(creep.room, STRUCTURE_SPAWN);
    if (!targets.length) targets = towers;
    if (!targets.length) targets = hostileStructures(creep.room, STRUCTURE_EXTENSION);
    if (!targets.length) { creep.memory.retired = true; retire.retireAtSpawn(creep); return; }
    delete creep.memory.idle;
    const tgt = targets.reduce((low, t) => (t.hits < low.hits ? t : low), targets[0]);
    if (creep.dismantle(tgt) === ERR_NOT_IN_RANGE) movement.go(creep, tgt, { range: 1, reusePath: 5 });
}

module.exports = { run, squadMates, power, openCheck, innerPosts, standAround, sideRun, unboostedTimeout, bucketHold, releaseSlot, strongerWaiting, handoff, freeBoostSlot, clearToward };
