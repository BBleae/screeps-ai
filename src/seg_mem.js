'use strict';

const STATS_SEG = 40;
const ROOM_SEGS = [41, 42, 43, 44, 45, 46];
const OTHER_SEGS = [90, 91];
const SEG_LIMIT = 98000;
const MAX_KEYS = 10;
const COLD = ['plan', 'spawnStallLog', 'spawnLog', 'crippledLog', 'demolition', 'boostLog', 'builderSourceLog', 'haulerSize',
    'minerUpgradeLog', 'reserveLog', 'minerUpgradeUrgent', 'haulerResidual', 'pathRefresh', 'spawnFirst'];
const RR = '_rr';
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const holder = typeof global !== 'undefined' ? global : {};
function freshRuntime() {
    return { mem: null, roomsLoaded: false, statsLoaded: false, wait: 0, gaveUp: false, written: {}, body: {}, pending: {}, queue: [], strs: {},
        assign: {}, flushAt: 0, statsKey: null, statsPending: null };
}
const rt = holder.__segMem || (holder.__segMem = freshRuntime());

function settings() {
    let cfg = null;
    try { cfg = require('config').segMem; } catch (e) { cfg = null; }
    return Object.assign({ enabled: true, flushEvery: 10, maxWrites: 5, waitMax: 5 }, cfg || {});
}

function rawOk() {
    return typeof RawMemory !== 'undefined' && RawMemory && typeof RawMemory === 'object' && RawMemory.segments && typeof RawMemory.segments === 'object';
}

function activeIds() {
    return OTHER_SEGS.concat([STATS_SEG], ROOM_SEGS);
}

function setActive() {
    if (typeof RawMemory !== 'undefined' && RawMemory && typeof RawMemory.setActiveSegments === 'function') RawMemory.setActiveSegments(activeIds());
}

function put(obj, key, value, enumerable) {
    Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: !!enumerable });
}

function hide(obj, key) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && d.enumerable && hasOwn(d, 'value')) put(obj, key, d.value, false);
}

function unhide(obj, key) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && !d.enumerable && hasOwn(d, 'value')) put(obj, key, d.value, true);
}

function state() {
    const st = Memory.segMem && typeof Memory.segMem === 'object' ? Memory.segMem : (Memory.segMem = { v: 1, rooms: 'mem', stats: 'mem' });
    if (st.rooms !== 'seg') st.rooms = 'mem';
    if (st.stats !== 'seg') st.stats = 'mem';
    return st;
}

function off() {
    return !settings().enabled || !!Memory.segMemOff;
}

function sourcesOf(mem) {
    const out = [];
    const remotes = mem && mem.remotes;
    if (!remotes || typeof remotes !== 'object') return out;
    for (const name in remotes) {
        const rec = remotes[name];
        const list = rec && Array.isArray(rec.sources) ? rec.sources : null;
        if (!list) continue;
        for (const s of list) if (s && typeof s === 'object' && s.id) out.push([name, s]);
    }
    return out;
}

function eachCold(mem, fn) {
    for (const k of COLD) if (hasOwn(mem, k)) fn(mem, k);
    for (const [, s] of sourcesOf(mem)) if (hasOwn(s, 'routeRoads')) fn(s, 'routeRoads');
}

function collect(mem) {
    let cold = null;
    for (const k of COLD) {
        if (!hasOwn(mem, k) || mem[k] === undefined) continue;
        (cold || (cold = {}))[k] = mem[k];
    }
    for (const [name, s] of sourcesOf(mem)) {
        if (!hasOwn(s, 'routeRoads') || s.routeRoads === undefined) continue;
        cold = cold || {};
        const rr = cold[RR] || (cold[RR] = {});
        (rr[name] || (rr[name] = {}))[s.id] = s.routeRoads;
    }
    return cold;
}

function fill(mem, cold) {
    let n = 0;
    for (const k of Object.keys(cold)) {
        if (k === RR) continue;
        if (hasOwn(mem, k)) continue;
        put(mem, k, cold[k], false);
        n++;
    }
    const rr = cold[RR];
    if (rr && mem.remotes && typeof mem.remotes === 'object') {
        for (const [name, s] of sourcesOf(mem)) {
            const v = rr[name] && rr[name][s.id];
            if (v === undefined || hasOwn(s, 'routeRoads')) continue;
            put(s, 'routeRoads', v, false);
            n++;
        }
    }
    return n;
}

function parseSeg(raw) {
    if (typeof raw !== 'string' || !raw.length) return null;
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
    } catch (e) {
        return null;
    }
}

function carryFromHeap(prev) {
    const out = { rooms: false, stats: false };
    if (!prev || prev === Memory) return out;
    const oldRooms = prev.rooms;
    if (oldRooms && typeof oldRooms === 'object' && Memory.rooms && typeof Memory.rooms === 'object') {
        for (const name in oldRooms) {
            const mem = Memory.rooms[name];
            if (!mem || typeof mem !== 'object') continue;
            const cold = collect(oldRooms[name] || {});
            if (cold) fill(mem, cold);
        }
        out.rooms = !!rt.roomsLoaded;
    }
    const d = Object.getOwnPropertyDescriptor(prev, 'stats');
    if (d && Array.isArray(d.value)) {
        if (!hasOwn(Memory, 'stats')) put(Memory, 'stats', d.value, false);
        out.stats = !!rt.statsLoaded;
    }
    return out;
}

function restoreRooms(segs) {
    const best = {};
    for (const id of ROOM_SEGS) {
        const v = parseSeg(segs[id]);
        if (!v || !v.rooms || typeof v.rooms !== 'object') continue;
        const t = Number(v.t) || 0;
        for (const name of Object.keys(v.rooms)) {
            if (!best[name] || best[name].t < t) best[name] = { t, id, cold: v.rooms[name] };
        }
    }
    let n = 0;
    const rooms = Memory.rooms || (Memory.rooms = {});
    for (const name of Object.keys(best)) {
        const mem = rooms[name];
        rt.assign[name] = best[name].id;
        if (!mem || typeof mem !== 'object' || !best[name].cold || typeof best[name].cold !== 'object') continue;
        n += fill(mem, best[name].cold);
    }
    return n;
}

function restoreStats(segs) {
    const v = parseSeg(segs[STATS_SEG]);
    const arr = v && Array.isArray(v.stats) ? v.stats : [];
    const cur = Memory.stats;
    if (Array.isArray(cur) && cur.length) {
        const lastT = arr.length ? Number(arr[arr.length - 1].t) || 0 : -1;
        for (const e of cur) if (e && Number(e.t) > lastT) arr.push(e);
        if (arr.length > 40) arr.splice(0, arr.length - 40);
    }
    put(Memory, 'stats', arr, false);
    return arr.length;
}

function allPresent(segs, ids) {
    for (const id of ids) if (!hasOwn(segs, id)) return false;
    return true;
}

function verify(segs, st) {
    for (const key of Object.keys(rt.pending)) {
        const id = Number(key);
        if (!hasOwn(segs, id)) continue;
        const p = rt.pending[key];
        if (segs[id] !== rt.written[id]) {
            if (Game.time - p.at < 3) continue;
            delete rt.pending[key];
            delete rt.written[id];
            delete rt.body[id];
            st.verifyFail = { id, at: Game.time };
            continue;
        }
        delete rt.pending[key];
        if (id === STATS_SEG) {
            if (Array.isArray(Memory.stats)) hide(Memory, 'stats');
            st.stats = 'seg';
            continue;
        }
        let hidden = 0;
        for (const name of p.rooms) {
            const mem = Memory.rooms && Memory.rooms[name];
            if (!mem || typeof mem !== 'object' || rt.assign[name] !== id) continue;
            eachCold(mem, (o, k) => { hide(o, k); hidden++; });
        }
        if (hidden) st.rooms = 'seg';
    }
}

function dropOurKeys(segs) {
    for (const id of activeIds()) {
        if (id === 90 || id === 91) continue;
        if (hasOwn(segs, id)) delete segs[id];
    }
}

function unhideAll(st) {
    const rooms = Memory.rooms || {};
    for (const name in rooms) {
        const mem = rooms[name];
        if (mem && typeof mem === 'object') eachCold(mem, unhide);
    }
    if (hasOwn(Memory, 'stats')) unhide(Memory, 'stats');
    st.rooms = 'mem';
    st.stats = 'mem';
    st.off = Game.time;
    rt.pending = {};
    rt.queue = [];
    rt.written = {};
    rt.body = {};
    rt.statsKey = null;
}

function begin() {
    if (typeof Memory === 'undefined' || !Memory) return true;
    if (!rawOk()) return true;
    setActive();
    const segs = RawMemory.segments;
    const st = state();
    if (rt.mem !== Memory) {
        const carried = rt.mem ? carryFromHeap(rt.mem) : { rooms: false, stats: false };
        rt.roomsLoaded = carried.rooms;
        rt.statsLoaded = carried.stats;
        rt.mem = Memory;
        rt.pending = {};
        rt.queue = [];
        rt.statsKey = null;
        rt.written = {};
        rt.body = {};
    }
    if (st.rooms !== 'seg') rt.roomsLoaded = true;
    if (st.stats !== 'seg') rt.statsLoaded = true;
    let ready = true;
    if (!rt.roomsLoaded) {
        if (allPresent(segs, ROOM_SEGS)) {
            st.restored = { at: Game.time, rooms: restoreRooms(segs), wait: rt.wait };
            rt.roomsLoaded = true;
        } else ready = false;
    }
    if (!rt.statsLoaded) {
        if (allPresent(segs, [STATS_SEG])) {
            restoreStats(segs);
            rt.statsLoaded = true;
        } else if (!hasOwn(Memory, 'stats')) ready = false;
    }
    if (!ready) {
        rt.wait++;
        if (rt.wait <= settings().waitMax && !rt.gaveUp) {
            st.waiting = { at: Game.time, n: rt.wait };
            return false;
        }
        if (!rt.gaveUp) {
            rt.gaveUp = true;
            st.gaveUp = Game.time;
        }
    } else {
        rt.wait = 0;
        rt.gaveUp = false;
        if (st.waiting) delete st.waiting;
    }
    if (off()) {
        if (rt.roomsLoaded && rt.statsLoaded && (st.rooms === 'seg' || st.stats === 'seg' || st.off == null)) unhideAll(st);
        dropOurKeys(segs);
        return true;
    }
    if (st.off != null) delete st.off;
    verify(segs, st);
    dropOurKeys(segs);
    return true;
}

function buildRooms() {
    const rooms = Memory.rooms || {};
    const names = Object.keys(rooms).sort();
    const strs = {};
    let total = 0;
    for (const name of names) {
        const mem = rooms[name];
        if (!mem || typeof mem !== 'object') continue;
        const cold = collect(mem);
        if (!cold) continue;
        strs[name] = JSON.stringify(name) + ':' + JSON.stringify(cold);
        total += strs[name].length;
    }
    const used = {};
    for (const id of ROOM_SEGS) used[id] = 40;
    const parts = {};
    for (const id of ROOM_SEGS) parts[id] = [];
    const left = [];
    for (const name of Object.keys(strs)) {
        const id = rt.assign[name];
        if (id && used[id] != null && used[id] + strs[name].length + 1 <= SEG_LIMIT) {
            used[id] += strs[name].length + 1;
            parts[id].push(name);
        } else left.push(name);
    }
    left.sort((a, b) => strs[b].length - strs[a].length);
    const unplaced = [];
    for (const name of left) {
        let pick = null;
        for (const id of ROOM_SEGS) {
            if (used[id] + strs[name].length + 1 > SEG_LIMIT) continue;
            if (pick == null || used[id] < used[pick]) pick = id;
        }
        if (pick == null) { unplaced.push(name); delete rt.assign[name]; continue; }
        used[pick] += strs[name].length + 1;
        parts[pick].push(name);
        rt.assign[name] = pick;
    }
    for (const name of Object.keys(rt.assign)) if (!strs[name]) delete rt.assign[name];
    for (const name of unplaced) {
        const mem = rooms[name];
        if (mem && typeof mem === 'object') eachCold(mem, unhide);
    }
    for (const id of ROOM_SEGS) {
        parts[id].sort();
        const body = parts[id].map((n) => strs[n]).join(',');
        if (rt.body[id] === body && rt.written[id] != null) {
            if (!rt.pending[id] && rt.queue.indexOf(id) < 0) {
                for (const name of parts[id]) eachCold(rooms[name], hide);
            }
            continue;
        }
        rt.body[id] = body;
        rt.strs[id] = { body, rooms: parts[id].slice() };
        if (rt.queue.indexOf(id) < 0) rt.queue.push(id);
    }
    return { total, unplaced: unplaced.length, used };
}

function statsWrite(st) {
    const arr = Memory.stats;
    if (!Array.isArray(arr) || !arr.length) return 0;
    const last = arr[arr.length - 1] || {};
    const key = arr.length + ':' + last.t + ':' + last.cpu;
    if (key === rt.statsKey && rt.written[STATS_SEG] != null) return 0;
    let s = JSON.stringify({ v: 1, t: Game.time, stats: arr });
    while (s.length > SEG_LIMIT && arr.length > 1) {
        arr.shift();
        s = JSON.stringify({ v: 1, t: Game.time, stats: arr });
    }
    if (s.length > SEG_LIMIT) return 0;
    if (!canWrite(STATS_SEG)) return 0;
    RawMemory.segments[STATS_SEG] = s;
    rt.written[STATS_SEG] = s;
    rt.pending[STATS_SEG] = { rooms: [], at: Game.time };
    rt.statsKey = key;
    st.statsBytes = s.length;
    return 1;
}

function canWrite(id) {
    const segs = RawMemory.segments;
    if (hasOwn(segs, id)) return true;
    return Object.keys(segs).length < MAX_KEYS;
}

function drain(budget) {
    let n = 0;
    while (rt.queue.length && n < budget) {
        const id = rt.queue[0];
        if (!canWrite(id)) break;
        rt.queue.shift();
        const p = rt.strs[id];
        if (!p) continue;
        const s = '{"v":1,"t":' + Game.time + ',"rooms":{' + p.body + '}}';
        RawMemory.segments[id] = s;
        rt.written[id] = s;
        rt.pending[id] = { rooms: p.rooms, at: Game.time };
        delete rt.strs[id];
        n++;
    }
    return n;
}

function flush() {
    if (typeof Memory === 'undefined' || !Memory || !rawOk()) return;
    if (off() || rt.mem !== Memory) return;
    const st = state();
    const cfg = settings();
    let writes = 0;
    if (rt.statsLoaded) {
        try { writes += statsWrite(st); } catch (e) { require('utils').logErr('segMem.stats', e); }
    }
    if (rt.roomsLoaded && Game.time >= rt.flushAt) {
        rt.flushAt = Game.time + Math.max(1, Number(cfg.flushEvery) || 10);
        try {
            const b = buildRooms();
            st.coldBytes = b.total;
            st.unplaced = b.unplaced;
            st.flushAt = Game.time;
        } catch (e) { require('utils').logErr('segMem.build', e); }
    }
    if (rt.queue.length) {
        try { drain(Math.max(1, Number(cfg.maxWrites) || 5) - writes); } catch (e) { require('utils').logErr('segMem.drain', e); }
    }
}

module.exports = { begin, flush, activeIds, STATS_SEG, ROOM_SEGS, COLD, _rt: rt, _reset() { Object.assign(rt, freshRuntime()); } };
