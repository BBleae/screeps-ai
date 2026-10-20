'use strict';
const config = require('config');

const BUCKET = { remoteMiner: 'm', remoteHauler: 'h', reserver: 'r', defender: 'd' };

function windowTicks() {
    const value = Number((config.cpuProfile || {}).remoteWindow);
    return value > 0 ? Math.floor(value) : 1500;
}

function blank(now) {
    return { from: now, ticks: 0, rooms: {}, plan: {}, self: 0, probe: null };
}

function round(table) {
    const out = {};
    for (const key of Object.keys(table)) {
        const value = table[key];
        if (value && typeof value === 'object') out[key] = round(value);
        else out[key] = Math.round(Number(value) * 1000) / 1000;
    }
    return out;
}

function state() {
    const now = Game.time;
    const m = Memory.cpuRemote || (Memory.cpuRemote = { window: windowTicks(), cur: blank(now), prev: null });
    if (!m.cur || typeof m.cur !== 'object') m.cur = blank(now);
    return m;
}

function remoteKey(memory) {
    if (!memory) return 'home';
    if (memory.remoteRoom) return memory.remoteRoom;
    if (memory.role === 'defender' && memory.targetRoom && memory.targetRoom !== memory.home) return memory.targetRoom;
    return 'home';
}

function tick() {
    const start = Game.cpu.getUsed();
    const m = state();
    m.window = windowTicks();
    m.every = Math.max(1, Math.floor(Number((config.cpuProfile || {}).sampleEvery) || 5));
    if (Game.time - m.cur.from >= m.window && m.cur.ticks > 0) {
        const done = m.cur;
        m.prev = { from: done.from, to: Game.time, ticks: done.ticks, rooms: round(done.rooms), plan: round(done.plan),
            self: Math.round(done.self * 1000) / 1000, probe: done.probe };
        m.cur = blank(Game.time);
    }
    const cur = m.cur;
    cur.ticks++;
    if (!cur.probe) cur.probe = { at: Game.time, calls: 0, cpu: 0 };
    cur.self += Game.cpu.getUsed() - start;
    return cur;
}

function note(memory, cpu) {
    const cur = Memory.cpuRemote && Memory.cpuRemote.cur;
    if (!cur || !(cpu > 0)) return;
    const probe = cur.probe && cur.probe.at === Game.time ? cur.probe : null;
    const start = probe ? Game.cpu.getUsed() : 0;
    const key = remoteKey(memory);
    const row = cur.rooms[key] || (cur.rooms[key] = {});
    const bucket = BUCKET[memory && memory.role] || 'o';
    row[bucket] = (row[bucket] || 0) + cpu;
    if (probe) { probe.calls++; probe.cpu += Game.cpu.getUsed() - start; }
}

function notePlan(homeName, cpu) {
    const cur = Memory.cpuRemote && Memory.cpuRemote.cur;
    if (!cur || !homeName || !(cpu > 0)) return;
    cur.plan[homeName] = (cur.plan[homeName] || 0) + cpu;
}

module.exports = { tick, note, notePlan, remoteKey, windowTicks, BUCKET };
