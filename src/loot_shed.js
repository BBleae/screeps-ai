'use strict';
const config = require('config');

function settings() {
    return Object.assign({
        pauseAbove: 150,
        resumeBelow: 140,
        pauseEvery: 50,
        minSamples: 8,
        prefer: ['W38S6', 'W38S5'],
        haulerMinBucket: 3000,
    }, (config.lootShed || {}));
}

function mem() {
    const m = Memory.lootShed || (Memory.lootShed = {});
    if (!Array.isArray(m.paused)) m.paused = [];
    if (!Array.isArray(m.log)) m.log = [];
    return m;
}

function avgN(n) {
    const stats = Array.isArray(Memory.stats) ? Memory.stats : [];
    const recent = stats.slice(-Math.max(1, n)).map((s) => Number(s && s.cpu)).filter((v) => v > 0);
    if (recent.length < Math.min(n, settings().minSamples)) return null;
    return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function salvageDirectives() {
    const raw = Memory.conquest;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return list.filter((d) => d && d.type === 'salvageLoot');
}

function lootRunning() {
    const list = salvageDirectives();
    return list.some((d) => !d.completed && d.phase !== 'done');
}

function lootFinished() {
    const list = salvageDirectives();
    if (!list.length) return !!(Memory.lootShed && Memory.lootShed.startedAt && !lootRunning());
    return list.every((d) => d.completed || d.phase === 'done');
}

function cpuTable() {
    const cr = Memory.cpuRemote || {};
    return (cr.tot && cr.tot.rooms) || (cr.prev && cr.prev.rooms) || {};
}

function roomCpu(name) {
    const v = cpuTable()[name] || {};
    return ['m', 'h', 'r', 'd'].reduce((s, k) => s + (Number(v[k]) || 0), 0);
}

function findHome(remoteRoom) {
    const rooms = Memory.rooms || {};
    for (const home of Object.keys(rooms)) {
        const remotes = rooms[home] && rooms[home].remotes;
        if (remotes && remotes[remoteRoom] && remotes[remoteRoom].enabled !== false) return home;
        if (remotes && remotes[remoteRoom]) return home;
    }
    return null;
}

function alreadyPaused(roomName) {
    return mem().paused.some((p) => p.room === roomName && !p.restoredAt);
}

function activeRemotes() {
    const out = [];
    const rooms = Memory.rooms || {};
    for (const home of Object.keys(rooms)) {
        const remotes = rooms[home] && rooms[home].remotes;
        if (!remotes) continue;
        for (const name of Object.keys(remotes)) {
            const rec = remotes[name];
            if (!rec || rec.enabled === false) continue;
            if (rec.suspendReason === 'lootShed') continue;
            if (Number(rec.suspendedUntil) > Game.time) continue;
            out.push({ home, room: name, cpu: roomCpu(name) });
        }
    }
    return out;
}

function nextToPause() {
    const prefer = settings().prefer || [];
    const active = activeRemotes();
    const byName = {};
    for (const a of active) byName[a.room] = a;
    for (const name of prefer) if (byName[name] && !alreadyPaused(name)) return byName[name];
    const rest = active.filter((a) => prefer.indexOf(a.room) < 0 && !alreadyPaused(a.room)).sort((a, b) => b.cpu - a.cpu || a.room.localeCompare(b.room));
    return rest[0] || null;
}

function pauseRemote(entry) {
    const rooms = Memory.rooms || {};
    const remotes = rooms[entry.home] && rooms[entry.home].remotes;
    const rec = remotes && remotes[entry.room];
    if (!rec) return false;
    const m = mem();
    m.paused.push({
        room: entry.room,
        home: entry.home,
        at: Game.time,
        cpu: entry.cpu,
        prevUntil: Number(rec.suspendedUntil) || 0,
        prevReason: rec.suspendReason || null,
    });
    rec.suspendedUntil = Number.MAX_SAFE_INTEGER;
    rec.suspendReason = 'lootShed';
    m.lastPauseAt = Game.time;
    m.log.push({ at: Game.time, act: 'pause', room: entry.room, home: entry.home, avg10: avgN(10) });
    if (m.log.length > 40) m.log.splice(0, m.log.length - 40);
    return true;
}

function restoreOne(entry) {
    const rooms = Memory.rooms || {};
    const remotes = rooms[entry.home] && rooms[entry.home].remotes;
    const rec = remotes && remotes[entry.room];
    if (rec && rec.suspendReason === 'lootShed') {
        rec.suspendedUntil = 0;
        rec.suspendReason = null;
        rec.enabled = true;
    }
    entry.restoredAt = Game.time;
    const m = mem();
    m.log.push({ at: Game.time, act: 'restore', room: entry.room, home: entry.home, avg10: avgN(10) });
    if (m.log.length > 40) m.log.splice(0, m.log.length - 40);
    if (entry.room === 'W38S6' || entry.room === 'W38S5') {
        const added = Memory.remoteAdded || (Memory.remoteAdded = []);
        added.push({ home: entry.home, room: entry.room, at: Game.time, how: 'lootShedRestore' });
        if (added.length > 30) added.splice(0, added.length - 30);
    }
}

function restoreAll() {
    const m = mem();
    if (m.restoredAt) return;
    const pending = m.paused.filter((p) => !p.restoredAt);
    for (let i = 0; i < pending.length; i++) restoreOne(pending[i]);
    m.restoredAt = Game.time;
    if (m.pixelOff) {
        m.pixelOff = false;
        m.pixelRestoredAt = Game.time;
        Memory.pixel = Memory.pixel || {};
        Memory.pixel.enabled = true;
    }
}

function run() {
    const cfg = settings();
    const m = mem();
    if (lootRunning()) {
        if (!m.startedAt) m.startedAt = Game.time;
        m.pixelOff = true;
        Memory.pixel = Memory.pixel || {};
        Memory.pixel.enabled = false;
        const avg = avgN(10);
        m.avg10 = avg;
        m.at = Game.time;
        if (avg == null) return m;
        if (avg > cfg.pauseAbove) {
            const gap = Number(cfg.pauseEvery) || 50;
            if (!(m.lastPauseAt > 0) || Game.time - m.lastPauseAt >= gap) {
                const next = nextToPause();
                if (next) pauseRemote(next);
            }
        }
        return m;
    }
    if (m.startedAt && lootFinished() && !m.restoredAt) restoreAll();
    return m;
}

function haulerBucketOk() {
    const floor = Number(settings().haulerMinBucket) || 3000;
    return !(Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < floor);
}

function pixelHeld() {
    const m = Memory.lootShed;
    return !!(m && m.pixelOff);
}

module.exports = { run, settings, avgN, lootRunning, lootFinished, haulerBucketOk, pixelHeld, mem, nextToPause, activeRemotes };
