'use strict';
const config = require('config');

function settings() {
    return Object.assign({ interval: 500, lowStorage: 2000, lowRooms: 4, storageDownDays: 2 }, ((config.policy || {}).stage1Fallback) || {});
}

function dayKey(ms) {
    return Math.floor((ms + 9 * 3600000) / 86400000);
}

function gclTotal() {
    const gcl = Game.gcl || {};
    const level = Math.max(1, Number(gcl.level) || 1);
    const mult = typeof GCL_MULTIPLY !== 'undefined' ? GCL_MULTIPLY : 1000000;
    const pow = typeof GCL_POW !== 'undefined' ? GCL_POW : 2.4;
    let sum = Number(gcl.progress) || 0;
    for (let l = 1; l < level; l++) sum += mult * Math.pow(l, pow);
    return Math.round(sum);
}

function snapshot(cfg) {
    let storage = 0;
    let low = 0;
    for (const name of Object.keys(Game.rooms)) {
        const room = Game.rooms[name];
        if (!room.controller || !room.controller.my || !room.storage) continue;
        const e = Number(room.storage.store[RESOURCE_ENERGY] || 0);
        storage += e;
        if (e < cfg.lowStorage) low++;
    }
    return { storage, low, gcl: gclTotal() };
}

function evaluate(days, snap, cfg) {
    const why = [];
    if (snap.low >= cfg.lowRooms) why.push('lowStorage:' + snap.low);
    const n = Math.max(1, Number(cfg.storageDownDays) || 2);
    const done = days.filter((d) => d.end);
    if (done.length >= n + 1) {
        const tail = done.slice(-(n + 1));
        const up = tail.map((d) => d.end.gcl - d.start.gcl);
        const flat = up[up.length - 1] <= up[up.length - 2];
        let down = true;
        for (let i = 1; i < tail.length; i++) if (!(tail[i].end.storage < tail[i - 1].end.storage)) down = false;
        if (flat && down) why.push('flatUpgradeStorageDown');
    }
    return why;
}

function run() {
    const cfg = settings();
    if (!(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    const mem = Memory.policy || (Memory.policy = {});
    const days = Array.isArray(mem.days) ? mem.days : (mem.days = []);
    const snap = snapshot(cfg);
    const day = dayKey(Date.now());
    const last = days[days.length - 1];
    if (!last || last.day !== day) {
        if (last) last.end = last.end || last.latest || snap;
        days.push({ day, start: snap, latest: snap });
        while (days.length > 5) days.shift();
    } else {
        last.latest = snap;
    }
    const why = evaluate(days, snap, cfg);
    const prev = mem.stage1Fallback;
    const met = why.length > 0;
    if (!prev || prev.met !== met || prev.why !== why.join(',')) mem.stage1Fallback = { met, why: why.join(','), at: Game.time, low: snap.low };
    return mem.stage1Fallback;
}

module.exports = { run, evaluate, snapshot, gclTotal, dayKey, settings };
