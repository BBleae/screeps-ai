'use strict';
const config = require('config');

const FORBIDDEN = /safe_?mode/i;
const state = { at: null, originals: {}, sig: '', src: null };
const ROOM = /^[WE]\d+[NS]\d+$/;
const ROOM_LISTS = ['pvp.dangerRooms', 'lootRoutes.hardAvoid'];

function interval() {
    const raw = Number((config.cfgOverlay || {}).interval);
    const n = Number.isFinite(raw) ? raw : 200;
    return Math.min(500, Math.max(100, n));
}

function plain(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function kind(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (plain(v)) {
        const o = {};
        for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = clone(v[k]);
        return o;
    }
    return v;
}

function getPath(obj, parts) {
    let cur = obj;
    for (const p of parts) {
        if (!plain(cur) || !(p in cur)) return { found: false };
        cur = cur[p];
    }
    return { found: true, value: cur };
}

function setPath(obj, parts, value) {
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    const last = parts[parts.length - 1];
    if (value === undefined) delete cur[last];
    else cur[last] = value;
}

function restore() {
    const paths = Object.keys(state.originals).sort((a, b) => b.split('.').length - a.split('.').length);
    for (const path of paths) {
        const rec = state.originals[path];
        const parts = path.split('.');
        const parent = getPath(config, parts.slice(0, -1));
        if (!parent.found || !plain(parent.value)) continue;
        setPath(config, parts, rec.had ? clone(rec.value) : undefined);
    }
    state.originals = {};
}

function remember(parts, target) {
    const path = parts.join('.');
    if (state.originals[path]) return;
    const last = parts[parts.length - 1];
    const had = Object.prototype.hasOwnProperty.call(target, last);
    state.originals[path] = { had, value: had ? clone(target[last]) : undefined };
}

function merge(target, overlay, parts, log) {
    for (const key of Object.keys(overlay)) {
        const here = parts.concat([key]);
        const path = here.join('.');
        if (FORBIDDEN.test(key)) { log.ignored.push({ path, why: 'safeMode' }); continue; }
        const next = overlay[key];
        const has = Object.prototype.hasOwnProperty.call(target, key);
        if (!has) {
            if (!parts.length) { log.ignored.push({ path, why: 'unknownTop' }); continue; }
            if (plain(next) && containsForbidden(next)) { log.ignored.push({ path, why: 'safeMode' }); continue; }
            remember(here, target);
            target[key] = clone(next);
            log.applied.push(path);
            continue;
        }
        const cur = target[key];
        if (plain(cur) && plain(next)) { merge(cur, next, here, log); continue; }
        if (kind(cur) !== kind(next)) { log.ignored.push({ path, why: 'type', want: kind(cur), got: kind(next) }); continue; }
        remember(here, target);
        target[key] = clone(next);
        log.applied.push(path);
    }
}

function containsForbidden(obj) {
    if (!plain(obj)) return false;
    return Object.keys(obj).some((k) => FORBIDDEN.test(k) || containsForbidden(obj[k]));
}

function roomListPaths() {
    const out = ROOM_LISTS.slice();
    const lr = config.lootRoutes;
    if (plain(lr)) for (const k of Object.keys(lr)) if (ROOM.test(k) && Array.isArray(lr[k])) out.push('lootRoutes.' + k);
    return out;
}

function alert(entry) {
    const list = Array.isArray(Memory.cfgAlerts) ? Memory.cfgAlerts : (Memory.cfgAlerts = []);
    list.push(Object.assign({ tick: Game.time }, entry));
    while (list.length > 20) list.shift();
}

function audit(entry) {
    const list = Array.isArray(Memory.cfgAudit) ? Memory.cfgAudit : (Memory.cfgAudit = []);
    list.push(entry);
    while (list.length > 30) list.shift();
}

function invalidateRoutes() {
    if (Memory.lootDrop && typeof Memory.lootDrop === 'object') Memory.lootDrop = {};
    let movement = null;
    try { movement = require('movement'); } catch (e) { }
    if (movement && typeof movement.resetRouteCaches === 'function') { try { movement.resetRouteCaches(); } catch (e) { } }
    const roles = new Set(['lootHauler', 'siegeDismantler', 'siegeGuard']);
    for (const name of Object.keys(Game.creeps || {})) {
        const c = Game.creeps[name];
        const m = c && c.memory;
        if (!m || !roles.has(m.role)) continue;
        delete m._move;
        delete m.gNext;
        if (movement && typeof movement.resetCreepPath === 'function') { try { movement.resetCreepPath(c); } catch (e) { } }
    }
}

function checkRoomLists(log) {
    const sigs = plain(Memory.cfgListSig) ? Memory.cfgListSig : (Memory.cfgListSig = {});
    let changed = false;
    for (const path of roomListPaths()) {
        const parts = path.split('.');
        const parent = getPath(config, parts.slice(0, -1));
        if (!parent.found || !plain(parent.value)) continue;
        const cur = parent.value[parts[parts.length - 1]];
        if (cur === undefined) continue;
        let list = Array.isArray(cur) ? cur : [];
        const bad = Array.isArray(cur) ? cur.filter((r) => typeof r !== 'string' || !ROOM.test(r)) : [cur];
        if (bad.length) {
            list = list.filter((r) => typeof r === 'string' && ROOM.test(r));
            remember(parts, parent.value);
            parent.value[parts[parts.length - 1]] = list.slice();
            log.ignored.push({ path, why: 'badRoom', bad: clone(bad) });
            alert({ path, why: 'badRoom', bad: clone(bad), by: Memory.cfgBy || 'unknown' });
        }
        const sig = JSON.stringify(list);
        const prev = sigs[path];
        if (prev !== undefined && prev !== sig) {
            let old = null;
            try { old = JSON.parse(prev); } catch (e) { }
            audit({ path, by: typeof Memory.cfgBy === 'string' && Memory.cfgBy ? Memory.cfgBy : 'unknown', tick: Game.time, old, new: list.slice() });
            changed = true;
        }
        sigs[path] = sig;
    }
    if (changed) { invalidateRoutes(); log.invalidated = true; }
    return changed;
}

function srcSig() {
    try { return JSON.stringify(Memory.cfg === undefined ? null : Memory.cfg); } catch (e) { return null; }
}

function apply(force) {
    if (typeof Memory === 'undefined' || typeof Game === 'undefined') return null;
    const reset = state.at === null;
    const sig = srcSig();
    const moved = sig !== state.src;
    if (!force && !reset && !moved && Game.time - state.at < interval()) return null;
    state.at = Game.time;
    state.src = sig;
    restore();
    const src = Memory.cfg;
    const log = { at: Game.time, reset, applied: [], ignored: [] };
    if (plain(src)) {
        try { merge(config, src, [], log); } catch (e) { log.error = String(e && e.message || e); }
    } else if (src !== undefined) log.ignored.push({ path: '', why: 'type', want: 'object', got: kind(src) });
    try { checkRoomLists(log); } catch (e) { log.listError = String(e && e.message || e); }
    Memory.cfgApplied = log;
    const isig = JSON.stringify(log.ignored);
    if (log.ignored.length && isig !== state.sig) {
        try { require('utils').logErr('cfgOverlay', new Error('ignored ' + log.ignored.map((x) => x.path + ':' + x.why).join(','))); } catch (e) { }
    }
    state.sig = isig;
    return log;
}

module.exports = { apply, merge, restore, interval, state, FORBIDDEN, checkRoomLists, invalidateRoutes, roomListPaths, ROOM };
