'use strict';
const config = require('config');

const FORBIDDEN = /safe_?mode/i;
const state = { at: null, originals: {}, sig: '' };

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
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
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

function apply(force) {
    if (typeof Memory === 'undefined' || typeof Game === 'undefined') return null;
    const reset = state.at === null;
    if (!force && !reset && Game.time - state.at < interval()) return null;
    state.at = Game.time;
    restore();
    const src = Memory.cfg;
    const log = { at: Game.time, reset, applied: [], ignored: [] };
    if (plain(src)) {
        try { merge(config, src, [], log); } catch (e) { log.error = String(e && e.message || e); }
    } else if (src !== undefined) log.ignored.push({ path: '', why: 'type', want: 'object', got: kind(src) });
    Memory.cfgApplied = log;
    const sig = JSON.stringify(log.ignored);
    if (log.ignored.length && sig !== state.sig) {
        try { require('utils').logErr('cfgOverlay', new Error('ignored ' + log.ignored.map((x) => x.path + ':' + x.why).join(','))); } catch (e) { }
    }
    state.sig = sig;
    return log;
}

module.exports = { apply, merge, restore, interval, state, FORBIDDEN };
