'use strict';
const { logErr } = require('utils');

const CONTRACT_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const STALE_GRACE_MS = 6 * 60 * 60 * 1000;

const SEGMENT = 90;

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__brainRuntime || (runtimeGlobal.__brainRuntime = {
    rejectedKey: null,
    segmentKey: null,
    activeAt: -1,
    active: null,
});

function segmentKey(raw) {
    return raw.length + ':' + raw.slice(0, 64) + ':' + raw.slice(-64);
}

function ingestSegment() {
    if (typeof RawMemory === 'undefined' || !RawMemory) return;
    if (typeof RawMemory.setActiveSegments === 'function') RawMemory.setActiveSegments(require('seg_mem').activeIds());
    if (retired()) return;
    const raw = RawMemory.segments && RawMemory.segments[SEGMENT];
    if (RawMemory.segments && Object.prototype.hasOwnProperty.call(RawMemory.segments, SEGMENT)) delete RawMemory.segments[SEGMENT];
    if (typeof raw !== 'string' || !raw.length) return;
    const key = segmentKey(raw);
    if (runtime.segmentKey === key) return;
    runtime.segmentKey = key;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        logErr('brain.segment', new Error('segment ' + SEGMENT + ' is not JSON: ' + String(error && error.message).slice(0, 80)));
        return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const current = Memory.brain;
    if (current && Number(current.issuedAt) === Number(parsed.issuedAt)) return;
    Memory.brain = parsed;
}

function now() {
    return Date.now();
}

function validate(directive) {
    if (!directive || typeof directive !== 'object') return 'missing';
    if (Number(directive.version) !== CONTRACT_VERSION) return 'version:' + directive.version;
    const issuedAt = Number(directive.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return 'issuedAt';
    if (directive.rooms != null && typeof directive.rooms !== 'object') return 'rooms';
    if (directive.intel != null && typeof directive.intel !== 'object') return 'intel';
    return null;
}

function ttlOf(directive) {
    return Number(directive.ttlMs) > 0 ? Number(directive.ttlMs) : DEFAULT_TTL_MS;
}

function stale(directive) {
    return now() - Number(directive.issuedAt) > ttlOf(directive);
}

function retired() {
    const cfg = require('config').brain;
    return !!(cfg && cfg.retired);
}

function expired(directive) {
    if (retired()) return false;
    return now() - Number(directive.issuedAt) > ttlOf(directive) + STALE_GRACE_MS;
}

function mergeIntel(intel) {
    if (!intel) return 0;
    Memory.map = Memory.map || {};
    let merged = 0;
    for (const roomName of Object.keys(intel)) {
        const entry = intel[roomName];
        if (!entry || typeof entry !== 'object') continue;
        const existing = Memory.map[roomName];
        const incomingAt = Number(entry.at) || 0;
        if (existing && Number(existing.at || 0) > incomingAt) continue;
        Memory.map[roomName] = Object.assign({}, entry, { source: 'external' });
        merged++;
    }
    return merged;
}

function retiredGuard() {
    if (typeof Memory === 'undefined' || !Memory) return;
    if (retired()) {
        if (Memory.brainRetiredAlert) delete Memory.brainRetiredAlert;
        return;
    }
    if (Memory.brainRetiredAlert) return;
    Memory.brainRetiredAlert = { at: Game.time };
    const msg = '[brain] config.brain.retired is missing or false: frozen directive will expire and segment 90 can overwrite Memory.brain (tick ' + Game.time + ')';
    if (typeof Game !== 'undefined' && typeof Game.notify === 'function') Game.notify(msg);
    logErr('brain.retiredGuard', new Error(msg));
}

function run() {
    runtime.activeAt = Game.time;
    runtime.active = null;
    try { retiredGuard(); } catch (error) { logErr('brain.retiredGuard', error); }
    try { ingestSegment(); } catch (error) { logErr('brain.ingest', error); }
    const directive = typeof Memory !== 'undefined' ? Memory.brain : null;
    if (!directive) return null;
    const problem = validate(directive);
    if (problem) {
        const key = problem + ':' + directive.issuedAt + ':' + directive.version;
        if (runtime.rejectedKey !== key) {
            runtime.rejectedKey = key;
            logErr('brain.validate', new Error('directive rejected: ' + problem));
        }
        return null;
    }
    const ack = directive.ack && directive.ack.issuedAt === directive.issuedAt ? directive.ack : null;
    if (!ack) {
        const merged = mergeIntel(directive.intel);
        directive.ack = { tick: Game.time, issuedAt: directive.issuedAt, applied: ['intel:' + merged] };
    } else {
        ack.tick = Game.time;
    }
    if (expired(directive)) return null;
    if (stale(directive)) directive.stale = true;
    else delete directive.stale;
    if (retired()) directive.frozen = true;
    else delete directive.frozen;
    runtime.active = directive;
    return directive;
}

function current() {
    if (runtime.activeAt !== Game.time) run();
    return runtime.active;
}

function directive(roomName) {
    const active = current();
    if (!active || !active.rooms) return null;
    const entry = active.rooms[roomName];
    return entry && typeof entry === 'object' ? entry : null;
}

function get(roomName, key, fallback) {
    const entry = directive(roomName);
    if (!entry || entry[key] === undefined) return fallback;
    return entry[key];
}

function isStale() {
    const active = current();
    return !!(active && active.stale);
}

function available() {
    return !!current();
}

function offlineMs() {
    if (current()) return 0;
    const last = typeof Memory !== 'undefined' ? Memory.brain : null;
    const issuedAt = Number(last && last.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
    return Math.max(0, now() - issuedAt - ttlOf(last));
}

function standingLock(key) {
    const last = typeof Memory !== 'undefined' ? Memory.brain : null;
    const locks = last && last.locks;
    const lock = locks && typeof locks === 'object' ? locks[key] : null;
    if (!lock || typeof lock !== 'object' || !(Number(lock.until) > now())) return null;
    return { value: lock.value === undefined ? null : lock.value };
}

module.exports = { run, retiredGuard, ingestSegment, directive, get, isStale, available, offlineMs, standingLock, retired, CONTRACT_VERSION, SEGMENT, STALE_GRACE_MS };
