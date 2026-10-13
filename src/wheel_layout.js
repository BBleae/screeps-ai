'use strict';

const VERSION = 'wheel-layout-2.1.0';
const COLOURS = {
    黄绿: '#adff2f',
    亮绿: '#40de5a',
    金色: '#ffd700',
    茶色: '#d2b48c',
    桃红: '#f47983',
    亮蓝: '#4169e1',
    暗青: '#008b8b',
    宝蓝: '#4169e1',
};

let upstream = null;

function ensureColours() {
    global.colours = global.colours || {};
    for (const key in COLOURS) {
        if (global.colours[key] == null) global.colours[key] = COLOURS[key];
    }
    return global.colours;
}

function load() {
    if (upstream) return upstream;
    ensureColours();
    require('RoomVisual');
    upstream = require('wheel_layout_planner');
    return upstream;
}

function plan(room, showPlan) {
    return load().plan(room, showPlan);
}

function runPlan(room) {
    return load().runPlan(room);
}

function visualize(roomName) {
    return load().visualizePlan(roomName);
}

function list() {
    return load().listPlanCache();
}

function clear(roomName) {
    return load().clearRoomPlanCache(roomName);
}

function save(roomName) {
    return load().savePlanToMemory(roomName);
}

function types() {
    return {
        spawn: global.STRUCTURE_SPAWN || 'spawn',
        extension: global.STRUCTURE_EXTENSION || 'extension',
        road: global.STRUCTURE_ROAD || 'road',
        wall: global.STRUCTURE_WALL || 'constructedWall',
        rampart: global.STRUCTURE_RAMPART || 'rampart',
        link: global.STRUCTURE_LINK || 'link',
        storage: global.STRUCTURE_STORAGE || 'storage',
        tower: global.STRUCTURE_TOWER || 'tower',
        observer: global.STRUCTURE_OBSERVER || 'observer',
        powerSpawn: global.STRUCTURE_POWER_SPAWN || 'powerSpawn',
        extractor: global.STRUCTURE_EXTRACTOR || 'extractor',
        lab: global.STRUCTURE_LAB || 'lab',
        terminal: global.STRUCTURE_TERMINAL || 'terminal',
        container: global.STRUCTURE_CONTAINER || 'container',
        nuker: global.STRUCTURE_NUKER || 'nuker',
        factory: global.STRUCTURE_FACTORY || 'factory',
    };
}

function clonePos(value) {
    if (!value || !Number.isFinite(+value.x) || !Number.isFinite(+value.y)) return null;
    return { x: +value.x, y: +value.y };
}

function posKey(value) {
    return value.x + '.' + value.y;
}

function distance(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function uniquePositions(values) {
    const result = [];
    const seen = new Set();
    for (const value of values || []) {
        const position = clonePos(value);
        if (!position) continue;
        const key = posKey(position);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(position);
    }
    return result;
}

function rawPositions(raw, type) {
    return uniquePositions(raw && raw[type]);
}

function packed(values) {
    return uniquePositions(values).map((position) => posKey(position)).join(';');
}

function roomFind(room, constantName) {
    const findConstant = global[constantName];
    if (!room || findConstant == null || typeof room.find !== 'function') return [];
    return room.find(findConstant) || [];
}

function closestIndex(values, target, maxRange, used, allowUsed) {
    if (!target) return -1;
    let bestIndex = -1;
    let bestRange = Infinity;
    for (let index = 0; index < values.length; index++) {
        if (!allowUsed && used && used.has(index)) continue;
        const range = distance(values[index], target);
        if (range > maxRange || range >= bestRange) continue;
        bestIndex = index;
        bestRange = range;
    }
    return bestIndex;
}

function classifyWorkPositions(room, workPositions, sources) {
    const used = new Set();
    const result = {};
    const controllerIndex = closestIndex(workPositions, room.controller && room.controller.pos, 2, used, false);
    if (controllerIndex >= 0) {
        result.ctrl = clonePos(workPositions[controllerIndex]);
        used.add(controllerIndex);
    }
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        const index = closestIndex(workPositions, source.pos, 1, used, false);
        if (index < 0) continue;
        result['src' + sourceIndex] = clonePos(workPositions[index]);
        used.add(index);
    }
    const minerals = roomFind(room, 'FIND_MINERALS');
    const mineralIndex = closestIndex(workPositions, minerals[0] && minerals[0].pos, 1, used, false);
    if (mineralIndex >= 0) result.mineral = clonePos(workPositions[mineralIndex]);
    return result;
}

function classifyLinks(room, linkPositions, storage, work, sources) {
    const result = {};
    const used = new Set();
    let storeIndex = closestIndex(linkPositions, storage, 1, used, false);
    if (storeIndex < 0 && linkPositions.length) storeIndex = 0;
    if (storeIndex >= 0) {
        result.store = clonePos(linkPositions[storeIndex]);
        used.add(storeIndex);
    }

    if (storeIndex >= 0 && work.ctrl && distance(linkPositions[storeIndex], work.ctrl) <= 1) {
        result.ctrl = clonePos(linkPositions[storeIndex]);
    }

    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        let index = closestIndex(linkPositions, work['src' + sourceIndex], 1, used, false);
        if (index < 0) index = closestIndex(linkPositions, sources[sourceIndex].pos, 2, used, false);
        if (index < 0) continue;
        result['src' + sourceIndex] = clonePos(linkPositions[index]);
        used.add(index);
    }

    if (!result.ctrl) {
        let index = closestIndex(linkPositions, work.ctrl, 1, used, false);
        if (index < 0) index = closestIndex(linkPositions, room.controller && room.controller.pos, 3, used, false);
        if (index >= 0) {
            result.ctrl = clonePos(linkPositions[index]);
            used.add(index);
        }
    }

    let auxiliary = 0;
    for (let linkIndex = 0; linkIndex < linkPositions.length; linkIndex++) {
        if (used.has(linkIndex)) continue;
        result['aux' + auxiliary++] = clonePos(linkPositions[linkIndex]);
    }
    if (result.src0) result.src = clonePos(result.src0);
    return result;
}

function cloneRawLayout(raw) {
    const result = {};
    for (const key in raw) {
        result[key] = Array.isArray(raw[key]) ? uniquePositions(raw[key]) : raw[key];
    }
    return result;
}

function normalize(room, raw) {
    if (!room || !raw || typeof raw !== 'object') throw new Error('room and raw layout are required');
    const structureTypes = types();
    const sources = Array.isArray(room.source) ? room.source.slice() : roomFind(room, 'FIND_SOURCES');
    const work = classifyWorkPositions(room, rawPositions(raw, 'work_pos'), sources);
    const containers = classifyWorkPositions(room, rawPositions(raw, structureTypes.container), sources);
    // 轮子只给矿的容器，源/controller 用 link 供能；RCL5 之前没有 link，静态矿工与 upgrader 的容器就放在轮子的工位上
    for (const key of Object.keys(work)) {
        if (key !== 'mineral' && !containers[key] && work[key]) containers[key] = clonePos(work[key]);
    }
    const storage = rawPositions(raw, structureTypes.storage)[0] || null;
    const rawLinks = rawPositions(raw, structureTypes.link);
    const rawSpawns = rawPositions(raw, structureTypes.spawn);
    const builtSpawnKeys = new Set(roomFind(room, 'FIND_MY_SPAWNS').map((item) => posKey(item.pos)));
    const futureSpawns = rawSpawns.filter((position) => !builtSpawnKeys.has(posKey(position)));
    const roads = {};
    const allRoads = packed(rawPositions(raw, structureTypes.road));
    if (allRoads) roads.all = allRoads;

    const structures = {
        factory: rawPositions(raw, structureTypes.factory)[0] || null,
        observer: rawPositions(raw, structureTypes.observer)[0] || null,
        powerSpawn: rawPositions(raw, structureTypes.powerSpawn)[0] || null,
        nuker: rawPositions(raw, structureTypes.nuker)[0] || null,
    };
    const minerals = roomFind(room, 'FIND_MINERALS');
    if (minerals[0]) structures.extractor = clonePos(minerals[0].pos);
    const misc = uniquePositions([
        structures.factory,
        structures.observer,
        structures.powerSpawn,
        structures.nuker,
    ]);

    return {
        version: VERSION,
        wheel: true,
        anchor: clonePos(storage || rawSpawns[0] || { x: 25, y: 25 }),
        made: typeof Game !== 'undefined' ? Game.time : 0,
        sourceIds: sources.map((source) => source.id),
        containers,
        roads,
        ext: rawPositions(raw, structureTypes.extension),
        towers: rawPositions(raw, structureTypes.tower),
        storage,
        terminal: rawPositions(raw, structureTypes.terminal)[0] || null,
        spawns: rawSpawns,
        spawn2: futureSpawns.slice(0, 1),
        spawn3: futureSpawns.slice(1),
        labs: rawPositions(raw, structureTypes.lab),
        links: classifyLinks(room, rawLinks, storage, work, sources),
        misc,
        structures,
        ramparts: rawPositions(raw, structureTypes.rampart),
        walls: rawPositions(raw, structureTypes.wall),
        workPositions: work,
        rawLayout: cloneRawLayout(raw),
    };
}

function canOverlap(left, right) {
    if (left === right) return true;
    const structureTypes = types();
    if (left === structureTypes.rampart || right === structureTypes.rampart) {
        const other = left === structureTypes.rampart ? right : left;
        return other !== structureTypes.wall;
    }
    return (left === structureTypes.road && right === structureTypes.container) ||
        (left === structureTypes.container && right === structureTypes.road);
}

function plannedEntries(planValue) {
    const structureTypes = types();
    const validTypes = new Set(Object.values(structureTypes));
    const result = [];
    const seen = new Set();
    const add = (type, value) => {
        const position = clonePos(value);
        if (!position) return;
        const key = type + '@' + posKey(position);
        if (seen.has(key)) return;
        seen.add(key);
        result.push({ type, pos: position });
    };
    for (const type in planValue.rawLayout || {}) {
        if (!validTypes.has(type) || !Array.isArray(planValue.rawLayout[type])) continue;
        for (const position of planValue.rawLayout[type]) add(type, position);
    }
    for (const position of planValue.spawns || []) add(structureTypes.spawn, position);
    for (const position of planValue.ext || []) add(structureTypes.extension, position);
    for (const position of planValue.towers || []) add(structureTypes.tower, position);
    for (const position of planValue.labs || []) add(structureTypes.lab, position);
    for (const position of planValue.ramparts || []) add(structureTypes.rampart, position);
    for (const position of planValue.walls || []) add(structureTypes.wall, position);
    add(structureTypes.storage, planValue.storage);
    add(structureTypes.terminal, planValue.terminal);
    for (const position of Object.values(planValue.containers || {})) add(structureTypes.container, position);
    for (const position of Object.values(planValue.links || {})) add(structureTypes.link, position);
    for (const value of Object.values(planValue.roads || {})) {
        if (typeof value !== 'string') continue;
        for (const packedPosition of value.split(';')) {
            const coordinates = packedPosition.split('.');
            if (coordinates.length === 2) add(structureTypes.road, { x: +coordinates[0], y: +coordinates[1] });
        }
    }
    const structureKeys = {
        factory: structureTypes.factory,
        observer: structureTypes.observer,
        powerSpawn: structureTypes.powerSpawn,
        nuker: structureTypes.nuker,
        extractor: structureTypes.extractor,
    };
    for (const key in structureKeys) add(structureKeys[key], planValue.structures && planValue.structures[key]);
    return result;
}

function validateExisting(room, planValue) {
    const errors = [];
    const structureTypes = types();
    if (!room || !planValue) return { ok: false, errors: ['room and normalized plan are required'] };
    if (!room.controller || !room.controller.my) errors.push('room is not owned');
    if (!planValue.storage) errors.push('missing storage position');
    if (!planValue.terminal) errors.push('missing terminal position');
    if (!planValue.workPositions || !planValue.workPositions.ctrl) errors.push('missing controller work position');
    const sources = roomFind(room, 'FIND_SOURCES');
    for (let index = 0; index < sources.length; index++) {
        if (!planValue.workPositions || !planValue.workPositions['src' + index]) {
            errors.push('missing source work position src' + index);
        }
    }

    const entries = plannedEntries(planValue);
    const plannedAt = {};
    for (const entry of entries) {
        if (entry.pos.x < 1 || entry.pos.x > 48 || entry.pos.y < 1 || entry.pos.y > 48) {
            errors.push(entry.type + ' outside buildable room at ' + posKey(entry.pos));
            continue;
        }
        const key = posKey(entry.pos);
        const previous = plannedAt[key] || (plannedAt[key] = []);
        for (const type of previous) {
            if (!canOverlap(entry.type, type)) errors.push('planned collision at ' + key + ': ' + type + ' vs ' + entry.type);
        }
        previous.push(entry.type);
    }

    const existingAt = {};
    const existingObjects = roomFind(room, 'FIND_STRUCTURES').concat(roomFind(room, 'FIND_CONSTRUCTION_SITES'));
    for (const object of existingObjects) {
        if (!object || !object.pos || !object.structureType) continue;
        const key = posKey(object.pos);
        (existingAt[key] || (existingAt[key] = [])).push(object);
    }
    for (const entry of entries) {
        const key = posKey(entry.pos);
        for (const object of existingAt[key] || []) {
            if (canOverlap(entry.type, object.structureType)) continue;
            errors.push('existing ' + object.structureType + ' conflicts with planned ' + entry.type + ' at ' + key);
        }
    }

    const exactTypes = new Set([
        structureTypes.spawn,
        structureTypes.extension,
        structureTypes.container,
        structureTypes.link,
        structureTypes.storage,
        structureTypes.tower,
        structureTypes.observer,
        structureTypes.powerSpawn,
        structureTypes.extractor,
        structureTypes.lab,
        structureTypes.terminal,
        structureTypes.nuker,
        structureTypes.factory,
    ]);
    const plannedExact = new Set(entries
        .filter((entry) => exactTypes.has(entry.type))
        .map((entry) => entry.type + '@' + posKey(entry.pos)));
    for (const object of existingObjects) {
        if (!object || !object.pos || !exactTypes.has(object.structureType)) continue;
        if (!plannedExact.has(object.structureType + '@' + posKey(object.pos))) {
            errors.push('existing ' + object.structureType + ' is outside wheel plan at ' + posKey(object.pos));
        }
    }
    const uniqueErrors = Array.from(new Set(errors));
    return { ok: uniqueErrors.length === 0, errors: uniqueErrors };
}

function cachedRaw(roomName) {
    const cached = global.roomPlanCache && global.roomPlanCache[roomName];
    if (cached && cached.layout) return cached.layout;
    const saved = typeof Memory !== 'undefined' && Memory.roomPlanner && Memory.roomPlanner[roomName];
    return saved && saved.layout || null;
}

function previousSourceIds(roomMemory) {
    const planIds = roomMemory.plan && roomMemory.plan.sourceIds;
    if (Array.isArray(planIds) && planIds.length) return planIds.slice();
    return Array.isArray(roomMemory.sources) ? roomMemory.sources.slice() : [];
}

function prepareHarvesterRemap(room, previousIds, nextIds) {
    if (!nextIds.length) return [];
    const memories = [];
    const seenNames = new Set();
    for (const creep of Object.values(Game.creeps || {})) {
        if (!creep || !creep.memory || creep.memory.home !== room.name || creep.memory.role !== 'harvester') continue;
        memories.push(creep.memory);
        seenNames.add(creep.name);
    }
    for (const spawn of roomFind(room, 'FIND_MY_SPAWNS')) {
        if (!spawn.spawning || seenNames.has(spawn.spawning.name) || !Memory.creeps) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory && memory.home === room.name && memory.role === 'harvester') memories.push(memory);
    }

    return memories.map((memory) => {
        let sourceId = memory.sourceId;
        if (!sourceId && previousIds.length) {
            const oldIndex = Math.max(0, Math.min(memory.sourceIdx || 0, previousIds.length - 1));
            sourceId = previousIds[oldIndex];
        }
        let sourceIdx = nextIds.indexOf(sourceId);
        if (sourceIdx < 0) {
            sourceIdx = Math.max(0, Math.min(memory.sourceIdx || 0, nextIds.length - 1));
            sourceId = nextIds[sourceIdx];
        }
        return {
            memory,
            sourceId,
            sourceIdx,
            previousSourceId: memory.sourceId,
            previousSourceIdx: memory.sourceIdx,
        };
    });
}

function applyHarvesterRemap(updates) {
    for (const update of updates) {
        update.memory.sourceId = update.sourceId;
        update.memory.sourceIdx = update.sourceIdx;
    }
}

function rollbackHarvesterRemap(updates) {
    for (const update of updates) {
        if (update.previousSourceId === undefined) delete update.memory.sourceId;
        else update.memory.sourceId = update.previousSourceId;
        if (update.previousSourceIdx === undefined) delete update.memory.sourceIdx;
        else update.memory.sourceIdx = update.previousSourceIdx;
    }
}

/** 把轮子原始输出采用为房间 plan。现有建筑与方案的冲突不再是拒绝理由（由拆迁调度在合适时机处理），
 *  只把冲突数记进 wheelLayout.conflicts 作诊断。 */
function adoptRaw(room, raw) {
    const roomName = room.name;
    let nextPlan;
    try {
        nextPlan = normalize(room, raw);
    } catch (error) {
        return { ok: false, errors: [error && error.message || String(error)] };
    }
    const diagnostics = validateExisting(room, nextPlan);
    const conflicts = diagnostics.errors.filter((item) => item.startsWith('existing ')).length;

    const previous = Memory.rooms && Memory.rooms[roomName] || {};
    const remap = prepareHarvesterRemap(room, previousSourceIds(previous), nextPlan.sourceIds);
    const adoptedPlan = Object.assign({}, nextPlan);
    delete adoptedPlan.rawLayout;
    const nextMemory = Object.assign({}, previous, {
        plan: adoptedPlan,
        sources: adoptedPlan.sourceIds.slice(),
        wheelLayout: { version: VERSION, adoptedAt: Game.time, conflicts, structural: diagnostics.errors.filter((item) => !item.startsWith('existing ')).slice(0, 10) },
    });
    delete nextMemory.wheelLayoutAttempt;
    delete nextMemory.planError;
    delete nextMemory.blueprintRetry;
    delete nextMemory.blueprintError;
    const rooms = Memory.rooms || {};
    const hadPrevious = Object.prototype.hasOwnProperty.call(rooms, roomName);
    try {
        applyHarvesterRemap(remap);
        rooms[roomName] = nextMemory;
        Memory.rooms = rooms;
    } catch (error) {
        rollbackHarvesterRemap(remap);
        if (hadPrevious) rooms[roomName] = previous;
        else delete rooms[roomName];
        return { ok: false, errors: [error && error.message || String(error)] };
    }
    return { ok: true, errors: [], plan: adoptedPlan, conflicts };
}

function adopt(roomName) {
    const room = typeof Game !== 'undefined' && Game.rooms && Game.rooms[roomName];
    if (!room) return { ok: false, errors: ['room is not visible: ' + roomName] };
    const raw = cachedRaw(roomName);
    if (!raw) return { ok: false, errors: ['wheel layout cache is missing: ' + roomName] };
    return adoptRaw(room, raw);
}

function wheelSettings() {
    const config = require('config');
    return Object.assign({ bucket: 5000, retryTicks: 5000 }, config.wheel || {});
}

/** 在游戏内跑轮子并采用为该房唯一的规划。失败（规划器返回 false/抛错）记 planError 并在 retryTicks 后重试。 */
function generate(room, mem) {
    const roomName = room.name;
    const settings = wheelSettings();
    let ok = false;
    let error = null;
    try {
        ok = !!runPlan(roomName);
        if (ok) {
            save(roomName);
            const raw = cachedRaw(roomName);
            if (!raw) throw new Error('wheel layout cache is missing after runPlan');
            const result = adoptRaw(room, raw);
            if (!result.ok) throw new Error(result.errors.join('; '));
            if (mem && Memory.rooms && Memory.rooms[roomName] && mem !== Memory.rooms[roomName]) {
                // 调用方持有旧的内存对象：把新内容同步回去，避免它写回覆盖
                for (const key of Object.keys(mem)) delete mem[key];
                Object.assign(mem, Memory.rooms[roomName]);
                Memory.rooms[roomName] = mem;
            }
            return result;
        }
        error = 'wheel planner returned false (no anchor for the core / room too narrow)';
    } catch (caught) {
        error = (caught && caught.message || String(caught)).slice(0, 300);
    }
    const target = mem || (Memory.rooms[roomName] = Memory.rooms[roomName] || {});
    target.planError = { at: Game.time, message: error, retryAt: Game.time + settings.retryTicks };
    console.log('[WheelLayout] ' + roomName + ' 规划失败: ' + error);
    return { ok: false, errors: [error] };
}

/** 该房现在是否该跑轮子：没有轮子 plan、不在重试冷却期、bucket 够。 */
function shouldGenerate(mem) {
    if (mem && mem.plan && mem.plan.wheel) return false;
    if (mem && mem.planError && mem.planError.retryAt > Game.time) return false;
    const bucket = Game.cpu && Number(Game.cpu.bucket);
    return !(Number.isFinite(bucket) && bucket < wheelSettings().bucket);
}

function runFlag(name, callback) {
    const flag = Game.flags && Game.flags[name];
    if (!flag) return;
    try {
        callback(flag);
    } catch (error) {
        console.log('[WheelLayout] ' + name + ' failed: ' + (error && error.stack || error));
    }
}

function autoPlannerByFlag() {
    runFlag('RP', (flag) => {
        const roomName = flag.pos.roomName;
        if (!runPlan(roomName)) return;
        const room = Game.rooms[roomName];
        const position = flag.pos;
        flag.remove();
        if (room && !(Game.flags && Game.flags.VP)) room.createFlag(position, 'VP');
    });
    runFlag('VP', (flag) => visualize(flag.pos.roomName));
    runFlag('SP', (flag) => {
        const roomName = flag.pos.roomName;
        if (!save(roomName)) return;
        const result = adopt(roomName);
        if (!result.ok) {
            console.log('[WheelLayout] adopt rejected for ' + roomName + ': ' + result.errors.join('; '));
            Memory.rooms = Memory.rooms || {};
            Memory.rooms[roomName] = Memory.rooms[roomName] || {};
            Memory.rooms[roomName].wheelLayoutAttempt = {
                version: VERSION,
                at: Game.time,
                status: 'rejected',
                errors: result.errors.slice(0, 20),
            };
            flag.remove();
            return;
        }
        delete Memory.rooms[roomName].wheelLayoutAttempt;
        flag.remove();
    });
}

const api = {
    VERSION,
    ensureColours,
    plan,
    runPlan,
    visualize,
    visualizePlan: visualize,
    list,
    listPlanCache: list,
    clear,
    clearRoomPlanCache: clear,
    save,
    savePlanToMemory: save,
    normalize,
    validateExisting,
    plannedEntries,
    canOverlap,
    adopt,
    adoptRaw,
    generate,
    shouldGenerate,
    autoPlannerByFlag,
};

global.WheelLayout = api;
global.autoPlannerByFlag = autoPlannerByFlag;
global.RP = plan;
global.runPlan = runPlan;
global.visualizePlan = visualize;
global.listPlanCache = list;
global.clearRoomPlanCache = clear;
global.savePlanToMemory = save;

module.exports = api;
