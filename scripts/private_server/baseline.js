'use strict';
/**
 * 基线回归：每次通过的验证把各房的关键指标存到 data/validation/baseline.json（本机、不入库），
 * 下一次验证与之对比——某个场景房原来有 creep 现在一只都没有、原来没错误现在有错误，算引入新 bug（验证失败）；
 * creep 数掉过一半只警告（tick 数与随机性会让数字抖动）。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'validation', 'baseline.json');

function metrics(report) {
    const rooms = {};
    for (const [roomName, memory] of Object.entries(report.rootMemories || {})) {
        const creeps = Object.values((memory && memory.creeps) || {});
        const probeMemory = report.probeMemories && report.probeMemories[roomName];
        const probeRooms = probeMemory && probeMemory._validationRooms;
        const probe = (probeRooms && probeRooms[roomName]) ||
            (probeMemory && probeMemory._validation && probeMemory._validation.room && probeMemory._validation.room.name === roomName
                ? probeMemory._validation.room : null);
        rooms[roomName] = {
            creeps: creeps.filter((item) => !item.home || item.home === roomName).length,
            creepsAll: creeps.length,
            errors: Array.isArray(memory && memory.errors) ? memory.errors.length : null,
            rcl: probe ? probe.rcl : null,
            energy: probe ? probe.energy : null,
        };
    }
    return { at: new Date().toISOString(), rooms };
}

function compare(previous, current) {
    const failures = [];
    const warnings = [];
    if (!previous || !previous.rooms) return { failures, warnings };
    for (const [roomName, before] of Object.entries(previous.rooms)) {
        const after = current.rooms[roomName];
        if (!after) { warnings.push(`${roomName}: 基线里有、本次没有（场景移除？）`); continue; }
        if (before.creepsAll > 0 && after.creepsAll === 0) failures.push(`${roomName}: 基线 ${before.creepsAll} 只 creep，本次 0 只`);
        else if (before.creepsAll > 0 && after.creepsAll < before.creepsAll / 2) warnings.push(`${roomName}: creep ${before.creepsAll} → ${after.creepsAll}`);
        if ((before.errors || 0) === 0 && (after.errors || 0) > 0) failures.push(`${roomName}: 基线无错误，本次 ${after.errors} 条`);
        // RCL 只比播种在 ≥3 的房：bootstrap 场景从 RCL1 起步，700 tick 里到不到 RCL2 取决于每次随机生成的地形（2026-09-06 一轮 2 → 1 误报）
        if (before.rcl != null && after.rcl != null && before.rcl >= 3 && after.rcl < before.rcl) failures.push(`${roomName}: RCL ${before.rcl} → ${after.rcl}`);
        else if (before.rcl != null && after.rcl != null && after.rcl < before.rcl) warnings.push(`${roomName}: RCL ${before.rcl} → ${after.rcl}（起步房，地形随机）`);
    }
    return { failures, warnings };
}

function load(file) {
    const target = file || DEFAULT_PATH;
    if (!fs.existsSync(target)) return null;
    try { return JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { return null; }
}

function save(current, file) {
    const target = file || DEFAULT_PATH;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(current, null, 2));
    return target;
}

module.exports = { DEFAULT_PATH, metrics, compare, load, save };
