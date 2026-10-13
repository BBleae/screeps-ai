'use strict';

try {
    require('RoomVisual');
} catch (error) {
    if (typeof global !== 'undefined') global.__roomVisualLoadError = error && error.message || String(error);
}

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const MAX_ROADS = 250;
// 轮子方案的 rampart 环就有 84 格，加 60 ext + lab/塔/spawn 已超过旧上限 160（storage/terminal/factory 等被挤出列表永远不画）
const MAX_STRUCTURES = 400;
const MAX_WORK_POSITIONS = 32;
const MAX_VISUAL_SIZE = 450000;
// 线上实测每个图元约 0.0012 CPU，整张未建方案约 500 图元；预算按房计，已建成的不画，越建越轻
const CPU_BUDGET = 1.5;
// 每个图元都查 getSize()+getUsed() 的开销比画图本身还大（实测占一半以上），改为每 N 个图元查一次
const CHECK_EVERY = 8;

function constant(name, fallback) {
    return runtimeGlobal[name] == null ? fallback : runtimeGlobal[name];
}

const TYPES = {
    spawn: constant('STRUCTURE_SPAWN', 'spawn'),
    extension: constant('STRUCTURE_EXTENSION', 'extension'),
    road: constant('STRUCTURE_ROAD', 'road'),
    wall: constant('STRUCTURE_WALL', 'constructedWall'),
    rampart: constant('STRUCTURE_RAMPART', 'rampart'),
    link: constant('STRUCTURE_LINK', 'link'),
    storage: constant('STRUCTURE_STORAGE', 'storage'),
    tower: constant('STRUCTURE_TOWER', 'tower'),
    observer: constant('STRUCTURE_OBSERVER', 'observer'),
    powerSpawn: constant('STRUCTURE_POWER_SPAWN', 'powerSpawn'),
    extractor: constant('STRUCTURE_EXTRACTOR', 'extractor'),
    lab: constant('STRUCTURE_LAB', 'lab'),
    terminal: constant('STRUCTURE_TERMINAL', 'terminal'),
    container: constant('STRUCTURE_CONTAINER', 'container'),
    nuker: constant('STRUCTURE_NUKER', 'nuker'),
    factory: constant('STRUCTURE_FACTORY', 'factory'),
};

const STRUCTURE_KEYS = {
    factory: TYPES.factory,
    observer: TYPES.observer,
    powerSpawn: TYPES.powerSpawn,
    nuker: TYPES.nuker,
    extractor: TYPES.extractor,
};
const KNOWN_TYPES = new Set(Object.values(TYPES));

function position(value) {
    if (!value || !Number.isFinite(+value.x) || !Number.isFinite(+value.y)) return null;
    const x = +value.x;
    const y = +value.y;
    if (x < 0 || x > 49 || y < 0 || y > 49) return null;
    return { x, y };
}

function positionKey(value) {
    return value.x + '.' + value.y;
}

function packedPositions(value, add) {
    if (Array.isArray(value)) {
        for (const item of value) if (add(item) === false) break;
        return;
    }
    if (typeof value !== 'string') return;
    for (const item of value.split(';')) {
        const coordinates = item.split('.');
        if (coordinates.length !== 2) continue;
        if (add({ x: +coordinates[0], y: +coordinates[1] }) === false) break;
    }
}

/** 已建成的结构集合（type@x.y）：方案覆盖层只画还没建的，建成即不再画 */
function builtSet(room) {
    const built = new Set();
    if (!room || typeof room.find !== 'function') return built;
    let structures = [];
    try { structures = room.find(constant('FIND_STRUCTURES', 'structures')) || []; } catch (error) { return built; }
    for (const structure of structures) {
        if (!structure || !structure.pos || !structure.structureType) continue;
        built.add(structure.structureType + '@' + positionKey(structure.pos));
    }
    return built;
}

/** 绘制顺序即截断顺序：唯一/高价值结构在前（spawn、storage、terminal、塔、link、容器、lab、factory/powerSpawn/nuker…），
 *  extension 其次，路网和 rampart 环数量最多、最容易被 CPU 预算截掉，放最后。 */
function collect(plan, built) {
    const roads = [];
    const structures = [];
    const ramparts = [];
    const workPositions = [];
    const roadKeys = new Set();
    const structureKeys = new Set();
    const placedKeys = new Set();
    const workKeys = new Set();
    const isBuilt = (type, pos) => built.has(type + '@' + positionKey(pos));
    const addRoad = (value) => {
        if (roads.length >= MAX_ROADS) return false;
        const pos = position(value);
        if (!pos) return true;
        const key = positionKey(pos);
        if (!roadKeys.has(key)) {
            roadKeys.add(key);
            if (!isBuilt(TYPES.road, pos)) roads.push(pos);
        }
        return roads.length < MAX_ROADS;
    };
    const addStructure = (type, value) => {
        if (structures.length + ramparts.length >= MAX_STRUCTURES || !type) return false;
        const pos = position(value);
        if (!pos) return true;
        const key = type + '@' + positionKey(pos);
        if (!structureKeys.has(key)) {
            structureKeys.add(key);
            if (type !== TYPES.rampart) placedKeys.add(positionKey(pos));
            if (!isBuilt(type, pos)) (type === TYPES.rampart ? ramparts : structures).push({ type, pos });
        }
        return structures.length + ramparts.length < MAX_STRUCTURES;
    };
    const addWork = (label, value) => {
        if (workPositions.length >= MAX_WORK_POSITIONS) return false;
        const pos = position(value);
        if (!pos) return true;
        const key = positionKey(pos);
        if (!workKeys.has(key)) {
            workKeys.add(key);
            workPositions.push({ label, pos });
        }
        return workPositions.length < MAX_WORK_POSITIONS;
    };
    const addList = (type, values) => {
        for (const value of values || []) if (addStructure(type, value) === false) break;
    };

    addList(TYPES.spawn, plan.spawns);
    addList(TYPES.spawn, plan.spawn2);
    addList(TYPES.spawn, plan.spawn3);
    addStructure(TYPES.storage, plan.storage);
    addStructure(TYPES.terminal, plan.terminal);
    addList(TYPES.tower, plan.towers);
    for (const value of Object.values(plan.links || {})) addStructure(TYPES.link, value);
    for (const value of Object.values(plan.containers || {})) addStructure(TYPES.container, value);
    addList(TYPES.lab, plan.labs);
    for (const key in plan.structures || {}) {
        const type = STRUCTURE_KEYS[key] || (KNOWN_TYPES.has(key) ? key : null);
        addStructure(type, plan.structures[key]);
    }
    for (const value of plan.misc || []) {
        const pos = position(value);
        if (pos && placedKeys.has(positionKey(pos))) continue;   // 已按 factory/nuker… 画过的位置不再画通用方框
        addStructure('plannedMisc', value);
    }
    addList(TYPES.extension, plan.ext);
    addList(TYPES.wall, plan.walls);
    for (const key in plan.workPositions || {}) addWork(key, plan.workPositions[key]);
    for (const value of Object.values(plan.roads || {})) packedPositions(value, addRoad);
    addList(TYPES.rampart, plan.ramparts);

    const raw = plan.rawLayout || {};
    for (const type in raw) {
        if (type === 'work_pos') {
            for (const value of raw[type] || []) if (addWork('work', value) === false) break;
        } else if (type === TYPES.road) {
            packedPositions(raw[type], addRoad);
        } else if (KNOWN_TYPES.has(type)) {
            addList(type, raw[type]);
        }
    }
    return { roads, structures, ramparts, workPositions };
}

function cpuUsed() {
    if (typeof Game === 'undefined' || !Game.cpu || typeof Game.cpu.getUsed !== 'function') return null;
    try {
        const value = Game.cpu.getUsed();
        return Number.isFinite(+value) ? +value : null;
    } catch (error) {
        return null;
    }
}

function sizeAvailable(visual) {
    if (!visual || typeof visual.getSize !== 'function') return true;
    try {
        const value = +visual.getSize();
        return !Number.isFinite(value) || value < MAX_VISUAL_SIZE;
    } catch (error) {
        return true;
    }
}

function call(visual, method, args) {
    if (!visual || typeof visual[method] !== 'function') return false;
    try {
        visual[method].apply(visual, args);
        return true;
    } catch (error) {
        return false;
    }
}

function drawStructure(visual, entry) {
    if (typeof visual.structure === 'function') {
        if (call(visual, 'structure', [entry.pos.x, entry.pos.y, entry.type, { opacity: 0.45 }])) return;
    }
    if (entry.type === TYPES.road && typeof visual.circle === 'function') {
        call(visual, 'circle', [entry.pos.x, entry.pos.y, { radius: 0.14, fill: '#666666', opacity: 0.55 }]);
        return;
    }
    if (typeof visual.rect === 'function') {
        call(visual, 'rect', [entry.pos.x - 0.36, entry.pos.y - 0.36, 0.72, 0.72, {
            fill: 'transparent', stroke: '#8fbb93', strokeWidth: 0.08, opacity: 0.55,
        }]);
    } else if (typeof visual.circle === 'function') {
        call(visual, 'circle', [entry.pos.x, entry.pos.y, {
            radius: 0.36, fill: 'transparent', stroke: '#8fbb93', opacity: 0.55,
        }]);
    }
}

function connectRoads(visual, roads, canContinue) {
    if (typeof visual.line !== 'function') return;
    const keys = new Set(roads.map(positionKey));
    const directions = [[1, 0], [0, 1], [1, 1], [-1, 1]];
    for (const road of roads) {
        for (const direction of directions) {
            const x = road.x + direction[0];
            const y = road.y + direction[1];
            if (!keys.has(x + '.' + y)) continue;
            call(visual, 'line', [road.x, road.y, x, y, { color: '#666666', width: 0.28, opacity: 0.5 }]);
            if (!canContinue()) return;
        }
    }
}

function drawWorkPosition(visual, entry) {
    if (typeof visual.circle === 'function') {
        call(visual, 'circle', [entry.pos.x, entry.pos.y, {
            radius: 0.24, fill: 'transparent', stroke: '#40e0d0', strokeWidth: 0.08, opacity: 0.9,
        }]);
    }
    if (typeof visual.text === 'function') {
        const label = entry.label === 'work' ? 'W' : String(entry.label).replace('src', 'S').replace('ctrl', 'C').slice(0, 3);
        call(visual, 'text', [label, entry.pos.x, entry.pos.y + 0.12, { color: '#40e0d0', font: 0.28, opacity: 0.9 }]);
    }
}

function visualFor(room) {
    const Visual = runtimeGlobal.RoomVisual;
    if (typeof Visual === 'function') {
        try { return new Visual(room.name); } catch (error) {
            return room && room.visual && typeof room.visual === 'object' ? room.visual : null;
        }
    }
    return room && room.visual && typeof room.visual === 'object' ? room.visual : null;
}

function render(room) {
    if (!room || !room.name || typeof Memory === 'undefined' || !Memory.rooms) return false;
    const plan = Memory.rooms[room.name] && Memory.rooms[room.name].plan;
    if (!plan) return false;
    const visual = visualFor(room);
    if (!visual) return false;

    const startedAt = cpuUsed();
    let calls = 0;
    let allowed = true;
    const canContinue = () => {
        if (!allowed) return false;
        if (++calls % CHECK_EVERY !== 0) return true;
        if (!sizeAvailable(visual)) { allowed = false; return false; }
        const current = cpuUsed();
        allowed = startedAt == null || current == null || current - startedAt < CPU_BUDGET;
        return allowed;
    };
    const data = collect(plan, builtSet(room));
    // 方案标签始终画（版本 + 未建数量）：全部建成的房也有 visual，私服验证以"房间 visual 存在"作为 render 跑通的不变量
    const remaining = data.structures.length + data.roads.length + data.ramparts.length;
    call(visual, 'text', ['规划 ' + (plan.version || '?') + ' · 未建 ' + remaining, 1, 1.4, { align: 'left', font: 0.5, color: '#8fbb93', opacity: 0.6 }]);
    for (const entry of data.structures) {
        if (!canContinue()) return true;
        drawStructure(visual, entry);
    }
    for (const entry of data.workPositions) {
        if (!canContinue()) return true;
        drawWorkPosition(visual, entry);
    }
    for (const road of data.roads) {
        if (!canContinue()) return true;
        drawStructure(visual, { type: TYPES.road, pos: road });
    }
    connectRoads(visual, data.roads, canContinue);
    for (const entry of data.ramparts) {
        if (!canContinue()) return true;
        drawStructure(visual, entry);
    }
    return true;
}

/** 本 tick 要不要画：默认关（纯诊断，见 config.visuals），showVisuals(n) 临时打开，bucket 低于阈值时一律不画。
 *  main.js 每 tick 只问一次，不进 runRoom 的每房循环。 */
function enabled() {
    let cfg = {};
    try { cfg = require('config').visuals || {}; } catch (error) { cfg = {}; }
    if (typeof Memory === 'undefined') return cfg.always === true;
    const until = Memory._visuals && Memory._visuals.until;
    const on = cfg.always === true || (typeof until === 'number' && until > Game.time);
    if (!on) return false;
    const bucket = Game.cpu && Game.cpu.bucket;
    return typeof bucket !== 'number' || bucket >= (cfg.minBucket || 0);
}

/** 控制台开关：showVisuals(300) 打开 300 tick。私服验证也用它，好让渲染路径继续被覆盖。 */
function show(ticks) {
    let fallback = 300;
    try { fallback = require('config').visuals.showTicks || 300; } catch (error) { fallback = 300; }
    const n = Math.max(1, Math.floor(Number(ticks) || fallback));
    if (typeof Memory !== 'undefined') Memory._visuals = { t: Game.time, until: Game.time + n };
    return 'visuals on for ' + n + ' ticks';
}
if (typeof global !== 'undefined') global.showVisuals = show;

module.exports = { render, enabled, show };
