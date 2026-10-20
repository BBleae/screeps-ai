'use strict';
const config = require('config');

const ring = { buf: [], i: 0, sum: 0, size: 0 };

function settings() {
    return Object.assign({ enabled: false, maxAvgCpu: 150, window: 100, holdUntilBucket: 9000, refillWindow: 3000, keepRefill: 10 }, config.pixel || {});
}

function windowSize() {
    return Math.max(1, Math.floor(Number(settings().window) || 100));
}

function record(used) {
    const v = Number(used);
    if (!Number.isFinite(v)) return;
    const size = windowSize();
    if (ring.size !== size) { ring.buf = []; ring.i = 0; ring.sum = 0; ring.size = size; }
    if (ring.buf.length < size) { ring.buf.push(v); ring.sum += v; }
    else { ring.sum += v - ring.buf[ring.i]; ring.buf[ring.i] = v; ring.i = (ring.i + 1) % size; }
    if (typeof Game !== 'undefined' && Game.time % 10 === 0) {
        const a = rollingAvg();
        Memory.cpuRoll = { avg: a.avg, n: a.n, at: Game.time };
    }
}

function rollingAvg() {
    const n = ring.buf.length;
    return { avg: n ? Math.round(ring.sum / n * 10) / 10 : null, n, full: n >= windowSize() };
}

function avgOk(max) {
    const a = rollingAvg();
    return a.full && a.avg != null && a.avg <= Number(max);
}

function reset() {
    ring.buf = []; ring.i = 0; ring.sum = 0; ring.size = 0;
}

function track() {
    const fill = Memory.pixelFill;
    if (!fill) return null;
    const cfg = settings();
    const bucket = Number(Game.cpu && Game.cpu.bucket);
    if (!fill.at9k && bucket >= Number(cfg.holdUntilBucket)) fill.at9k = Game.time;
    if (bucket >= 10000) {
        const log = Array.isArray(Memory.pixelRefill) ? Memory.pixelRefill : (Memory.pixelRefill = []);
        log.push({ at: fill.at, ticks: Game.time - fill.at, to9k: fill.at9k ? fill.at9k - fill.at : null });
        while (log.length > Math.max(1, Number(cfg.keepRefill) || 10)) log.shift();
        delete Memory.pixelFill;
        return null;
    }
    if (!fill.expired && Game.time - fill.at > Number(cfg.refillWindow)) fill.expired = Game.time;
    return fill;
}

function notePixel() {
    Memory.pixelAt = Game.time;
    Memory.pixelFill = { at: Game.time };
}

function refilling() {
    const fill = typeof Memory !== 'undefined' ? Memory.pixelFill : null;
    return !!fill && !fill.expired;
}

function newWorkHeld() {
    const fill = typeof Memory !== 'undefined' ? Memory.pixelFill : null;
    return !!fill && !fill.at9k;
}

function pixelReady() {
    const cfg = settings();
    const a = rollingAvg();
    const bucket = Number(Game.cpu && Game.cpu.bucket);
    const ok = cfg.enabled === true && bucket >= 10000 && a.full && a.avg != null && a.avg < Number(cfg.maxAvgCpu);
    return { ok, mean: a.avg, n: a.n, line: Number(cfg.maxAvgCpu), bucket };
}

module.exports = { settings, record, rollingAvg, avgOk, reset, track, notePixel, refilling, newWorkHeld, pixelReady };
