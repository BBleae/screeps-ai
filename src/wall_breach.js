'use strict';
/** 无主墙开口（10-17 战略猫拍板）：config.wallBreach.targets 白名单里的坐标，每条墙线只拆最短路径上的 1 段。
 *  - 只对白名单坐标上的 constructedWall 且无 owner 的动手（roles/wallBreaker.js 再核一次），不碰任何有主建筑、玩家或 Invader 的东西；
 *  - 母房（target.home）孵 1 只拆机（WORK/MOVE 对半）；home 等了 fallbackAfter tick 还没孵出来就允许 fallbackHome 孵；
 *  - 拆完（拆机进房看到该坐标已无墙）写 Memory.wallBreach.done[key]，此后不再孵；
 *  - 解锁外矿（config.wallBreach.unlock[母房]）：after 里的墙全拆完后，用 PathFinder 从母房 storage 量到每个源的步数，
 *    全部 ≤ maxSteps 才并入该母房的外矿白名单（remote.remoteWhitelist），超限不开并记 Memory.wallBreach.measured；
 *  - 拆机遇到武装敌人（玩家或 NPC）就撤回母房，fleeTicks 内不再孵、不再进房。 */
const config = require('config');

function settings() {
    return Object.assign({ enabled: false, targets: [], unlock: {}, maxPairs: 10, fallbackAfter: 600, fleeTicks: 300, minBucket: 3000 },
        config.wallBreach || {});
}

function mem() {
    const m = Memory.wallBreach || (Memory.wallBreach = {});
    m.done = m.done || {};
    m.askedAt = m.askedAt || {};
    m.fleeUntil = m.fleeUntil || {};
    return m;
}

function keyOf(target) {
    return target.room + ':' + target.x + ':' + target.y;
}

function isDone(key) {
    return !!(Memory.wallBreach && Memory.wallBreach.done && Memory.wallBreach.done[key]);
}

function pendingTargets() {
    return (settings().targets || []).filter((target) => !isDone(keyOf(target)));
}

function targetByKey(key) {
    return (settings().targets || []).find((target) => keyOf(target) === key) || null;
}

/** 拆机身材：WORK/MOVE 对半（1:1 平地全速），最多 maxPairs 对；买不起 1 对返回 [] */
function breakerBody(budget, maxPairs) {
    const pairs = Math.min(Math.max(0, Number(maxPairs) || 10), Math.floor((Number(budget) || 0) / 150));
    const body = [];
    for (let i = 0; i < pairs; i++) body.push('work');
    for (let i = 0; i < pairs; i++) body.push('move');
    return body;
}

/** 这面墙可以动：constructedWall、没有 owner、不是自己的。roles/wallBreaker 每次 dismantle 前都要过它 */
function allowedWall(structure) {
    if (!structure) return false;
    const wallType = typeof STRUCTURE_WALL === 'undefined' ? 'constructedWall' : STRUCTURE_WALL;
    return structure.structureType === wallType && !structure.owner && structure.my !== true;
}

function fleeing(key) {
    const until = Memory.wallBreach && Memory.wallBreach.fleeUntil && Memory.wallBreach.fleeUntil[key];
    return !!(until && until > Game.time);
}

function getDemands(home) {
    const cfg = settings();
    if (!cfg.enabled || !home || !home.controller || !home.controller.my) return [];
    if (Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < cfg.minBucket) return [];
    const m = mem();
    const out = [];
    for (const target of pendingTargets()) {
        const key = keyOf(target);
        if (fleeing(key) || (m.blocked && m.blocked.key === key)) continue;
        const pvp = Memory.pvpThreat && Memory.pvpThreat[target.room];
        if (pvp && pvp.until > Game.time) continue;
        let mine = target.home === home.name;
        if (mine && !m.askedAt[key]) m.askedAt[key] = Game.time;
        if (!mine && target.fallbackHome === home.name && m.askedAt[key] && Game.time - m.askedAt[key] >= cfg.fallbackAfter) mine = true;
        if (!mine) continue;
        const body = breakerBody(home.energyCapacityAvailable, cfg.maxPairs);
        if (!body.length) continue;
        out.push({ role: 'wallBreaker', slot: 'breach:' + key, body,
            memory: { role: 'wallBreaker', slotKey: 'breach:' + key, home: home.name, breachKey: key },
            lead: 0, priority: 0, bodyFor: (budget) => breakerBody(budget, cfg.maxPairs) });
        break;   // 一次只开一处
    }
    return out;
}

/** 拆机看到坐标上已经没有墙：记完成，并量一次解锁外矿的步数 */
function markDone(key) {
    const m = mem();
    if (m.done[key]) return;
    m.done[key] = Game.time;
    try { measureUnlocks(); } catch (error) { m.measureError = String(error && error.message || error); }
}

function blockingCost(room) {
    const matrix = new PathFinder.CostMatrix();
    for (const structure of room.find(FIND_STRUCTURES)) {
        const type = structure.structureType;
        if (type === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
        else if (type === STRUCTURE_CONTAINER || (type === STRUCTURE_RAMPART && structure.my)) continue;
        else matrix.set(structure.pos.x, structure.pos.y, 255);
    }
    return matrix;
}

/** 解锁条件里的墙全拆完的母房：PathFinder（plain 2 / swamp 8，路 1，只走 home + 解锁房）量 storage → 每个源（range 1）的步数，结果写进
 *  Memory.wallBreach.measured[母房][房] = { steps: [...], ok }。不可见的房按地形算（墙只在拆机所在、可见的房里才挡）。 */
function measureUnlocks() {
    const cfg = settings();
    const m = mem();
    m.measured = m.measured || {};
    for (const homeName in cfg.unlock || {}) {
        const rule = cfg.unlock[homeName];
        if (!(rule.after || []).every(isDone)) continue;
        const home = Game.rooms[homeName];
        if (!home || !home.storage) continue;
        const allowed = new Set([homeName].concat((rule.rooms || []).map((entry) => entry.room), rule.via || []));
        const out = m.measured[homeName] = {};
        for (const entry of rule.rooms || []) {
            const steps = (entry.sources || []).map((source) => {
                const result = PathFinder.search(home.storage.pos, { pos: new RoomPosition(source.x, source.y, entry.room), range: 1 }, {
                    plainCost: 2, swampCost: 8, maxRooms: allowed.size + 1, maxOps: 20000,
                    roomCallback: (roomName) => {
                        if (!allowed.has(roomName)) return false;
                        const room = Game.rooms[roomName];
                        return room ? blockingCost(room) : undefined;
                    },
                });
                return result.incomplete ? null : result.path.length;
            });
            out[entry.room] = { steps, ok: steps.length > 0 && steps.every((n) => n != null && n <= entry.maxSteps), at: Game.time };
        }
    }
}

/** 母房因墙拆完、步数达标而新增的外矿（remote.remoteWhitelist 并入） */
function unlockedRemotes(homeName) {
    const cfg = settings();
    const rule = cfg.unlock && cfg.unlock[homeName];
    if (!rule || !(rule.after || []).every(isDone)) return [];
    const measured = Memory.wallBreach && Memory.wallBreach.measured && Memory.wallBreach.measured[homeName];
    if (!measured) return [];
    return (rule.rooms || []).filter((entry) => measured[entry.room] && measured[entry.room].ok).map((entry) => entry.room);
}

module.exports = { settings, keyOf, isDone, pendingTargets, targetByKey, breakerBody, allowedWall, fleeing, getDemands, markDone,
    measureUnlocks, unlockedRemotes, mem };
