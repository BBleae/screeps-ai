'use strict';
/**
 * 过道 deposit 采集（2026-10-15，战略猫 phase 1）：只采 config.deposit.types（silicon / mist）。
 *   发现：每 scanEvery tick 扫一遍当前可见的过道房（observer 现在没有：RCL8 才有；视野来自 depositScout 巡逻和路过的 creep），
 *         记进 Memory.deposits.list（按 id，seenTtl 内算"看见过"，cacheTtl 后清掉）。
 *   选房：有 terminal 的己方房，Game.map.findRoute 实际跳数 ≤ maxHops，路线避开 SK 房与别人占领的房（结果缓存 routeTtl）。
 *   开工：deposit 在 seenTtl 内被看见过、lastCooldown ≤ maxCooldown、离消失还够久、房里没有武装敌人才分配；
 *         新分配受 CPU 闸（Memory.stats 近 cpuSamples 条均值 ≤ cpuAvgMax 且 bucket ≥ minBucket）。
 *   采集者（roles/depositMiner）自己采、自己送回母房 terminal，冷却超线 / 有敌人 / 寿命只够回程就收工；产出由 market.js 卖。
 * config.deposit.enabled=false 时整模块不做任何事（存量 creep 回家交货后自毁）。
 * W36S7 复盘（postmortem_W36S7.md）的两条：路线按真实跳数校验；没看见目标不出采集者。
 */
const config = require('config');
const { logErr } = require('utils');

const FIND_DEP = typeof FIND_DEPOSITS !== 'undefined' ? FIND_DEPOSITS : 122;

const DEFAULTS = {
    enabled: true,
    types: ['silicon', 'mist'],
    maxHops: 3,
    maxCooldown: 100,       // lastCooldown 超过它就不再开新采集者、在岗的收工（采一次冷却 ~0.001×总采量^1.2，到 100 时一趟已不划算）
    seenTtl: 1500,          // 多久内被看见过才算数（不对着旧情报出 creep）
    cacheTtl: 20000,        // 情报保留多久
    routeTtl: 20000,
    minDecay: 1500,         // 离消失不足这么多 tick 不开工
    maxActive: 2,           // 同时在采的 deposit 数
    scanEvery: 20,
    cpuAvgMax: 145,
    cpuSamples: 10,
    minBucket: 3000,
    minRcl: 6,
    minBudget: 1950,        // 采集者最少 3 组（9W6C15M）
    maxSets: 5,
    scout: true,            // 一只 1 MOVE 的巡逻侦察（50 能量）
    scoutRevisit: 1500,     // 同一过道房多久重看一次
};

function settings() {
    return Object.assign({}, DEFAULTS, config.deposit || {});
}

function mem() {
    const m = Memory.deposits || (Memory.deposits = {});
    if (!m.list) m.list = {};
    if (!m.routes) m.routes = {};
    if (!m.visits) m.visits = {};
    return m;
}

function parseRoom(name) {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name || '');
    if (!m) return null;
    return { x: Number(m[2]), y: Number(m[4]), name };
}

function isHighway(name) {
    const p = parseRoom(name);
    return !!p && (p.x % 10 === 0 || p.y % 10 === 0);
}

function isKeeperRoom(name) {
    const p = parseRoom(name);
    if (!p) return false;
    const fx = p.x % 10, fy = p.y % 10;
    return fx >= 4 && fx <= 6 && fy >= 4 && fy <= 6 && !(fx === 5 && fy === 5);
}

function myName() {
    for (const n in Game.rooms) {
        const c = Game.rooms[n].controller;
        if (c && c.my && c.owner) return c.owner.username;
    }
    return null;
}

/** 路线上不能走的房：SK 房、别人占领的房（Memory.map 情报）。目标房自己不在此列 */
function blockedRoom(name, target, me) {
    if (name === target) return false;
    if (isKeeperRoom(name)) return true;
    if (require('utils').pvpDangerRoom(name)) return true;   // 10-16：W30S9 / Jumpp 等玩家威胁房
    const info = Memory.map && Memory.map[name];
    if (info && info.owner && info.owner !== me) return true;
    return false;
}

/** 真实跳数（findRoute），缓存；走不通 / 超过 maxHops 返回 Infinity */
function hops(home, target, cfg) {
    const m = mem();
    const key = home + ':' + target;
    const hit = m.routes[key];
    if (hit && Game.time - hit.at < cfg.routeTtl) return hit.h == null ? Infinity : hit.h;
    let h = null;
    if (Game.map.getRoomLinearDistance(home, target) <= cfg.maxHops) {
        const me = myName();
        const route = Game.map.findRoute(home, target, { routeCallback: (name) => (blockedRoom(name, target, me) ? Infinity : 1) });
        if (Array.isArray(route) && route.length <= cfg.maxHops) h = route.length;
    }
    m.routes[key] = { h, at: Game.time };
    return h == null ? Infinity : h;
}

function homes(cfg) {
    const out = [];
    for (const n in Game.rooms) {
        const r = Game.rooms[n];
        if (!r.controller || !r.controller.my || !r.terminal || (r.controller.level || 0) < cfg.minRcl) continue;
        out.push(r);
    }
    return out;
}

/** 把一个可见房里的 deposit 记进情报（creep 进房 / 扫描时调） */
function note(room) {
    require('utils').notePvpThreat(room);
    if (!room || !isHighway(room.name)) return;
    const cfg = settings();
    const m = mem();
    m.visits[room.name] = Game.time;
    const armed = room.find(FIND_HOSTILE_CREEPS).some((c) => c.body && c.body.some((p) => p.hits > 0 &&
        (p.type === ATTACK || p.type === RANGED_ATTACK)));
    for (const d of room.find(FIND_DEP)) {
        if (cfg.types.indexOf(d.depositType) < 0) continue;
        const prev = m.list[d.id] || {};
        m.list[d.id] = Object.assign(prev, {
            room: room.name, type: d.depositType, x: d.pos.x, y: d.pos.y,
            cd: d.lastCooldown || 0, decayAt: Game.time + (d.ticksToDecay || 0), at: Game.time,
            hostileUntil: armed ? Game.time + 300 : (prev.hostileUntil || 0),
        });
    }
}

function cpuOk(cfg) {
    if (Game.cpu.bucket < cfg.minBucket) return false;
    const stats = Array.isArray(Memory.stats) ? Memory.stats : [];
    const recent = stats.slice(-cfg.cpuSamples).map((s) => Number(s && s.cpu)).filter((v) => v > 0);
    if (!recent.length) return true;
    return recent.reduce((a, b) => a + b, 0) / recent.length <= cfg.cpuAvgMax;
}

/** 这个 deposit 现在值得采（不看分配） */
function workable(d, cfg) {
    return d && cfg.types.indexOf(d.type) >= 0 && Game.time - d.at <= cfg.seenTtl && d.cd <= cfg.maxCooldown &&
        d.decayAt - Game.time >= cfg.minDecay && !(d.hostileUntil > Game.time);
}

/** 每 tick 调一次（内部降频）：扫可见过道房、清过期情报、维护分配 */
function run() {
    const cfg = settings();
    if (!cfg.enabled || Game.time % cfg.scanEvery !== 0) return;
    const m = mem();
    for (const n in Game.rooms) if (isHighway(n)) { try { note(Game.rooms[n]); } catch (e) { logErr('deposit.note ' + n, e); } }
    for (const id in m.list) {
        const d = m.list[id];
        if (Game.time - d.at > cfg.cacheTtl || d.decayAt < Game.time) delete m.list[id];
        else if (d.home && !workable(d, cfg) && Game.time - d.at <= cfg.seenTtl) d.home = null;   // 看得见且已不值得：撤分配
    }
    for (const k in m.routes) if (Game.time - m.routes[k].at > cfg.routeTtl) delete m.routes[k];
    for (const r in m.visits) if (Game.time - m.visits[r] > cfg.cacheTtl) delete m.visits[r];
    let active = Object.values(m.list).filter((d) => d.home).length;
    if (active >= cfg.maxActive || !cpuOk(cfg)) { m.gate = { at: Game.time, active, cpuOk: cpuOk(cfg) }; return; }
    const hs = homes(cfg);
    const candidates = Object.keys(m.list).filter((id) => !m.list[id].home && workable(m.list[id], cfg))
        .sort((a, b) => m.list[a].cd - m.list[b].cd);
    for (const id of candidates) {
        if (active >= cfg.maxActive) break;
        const d = m.list[id];
        let best = null, bestH = Infinity;
        for (const h of hs) {
            if (h.energyCapacityAvailable < cfg.minBudget) continue;
            const n = hops(h.name, d.room, cfg);
            if (n < bestH) { bestH = n; best = h; }
        }
        if (!best) { d.noHome = Game.time; continue; }
        d.home = best.name;
        d.hops = bestH;
        d.assignedAt = Game.time;
        active++;
    }
}

function minerBody(budget, cfg) {
    const set = ['work', 'work', 'work', 'carry', 'carry', 'move', 'move', 'move', 'move', 'move'];   // 650
    const n = Math.min(cfg.maxSets, Math.floor(budget / 650));
    if (n < 3) return [];
    const body = [];
    for (const type of ['work', 'carry', 'move']) for (let i = 0; i < n; i++) for (const p of set) if (p === type) body.push(p);
    return body;
}

/** 巡逻侦察的母房：有候选过道房的第一个 terminal 房（按名排序，确定性），整账号只一只 */
function scoutHome(cfg) {
    const hs = homes(cfg).map((r) => r.name).sort();
    return hs.length ? hs[0] : null;
}

/** 某母房 maxHops 内（线性距离）的过道房，按上次看见的时间排，最久没看的在前；只保留真实路线可达的 */
function patrolTargets(home, cfg) {
    const p = parseRoom(home);
    if (!p) return [];
    const m = mem();
    const out = [];
    const ew = home[0], ns = /[NS]/.exec(home)[0];
    for (let dx = -cfg.maxHops; dx <= cfg.maxHops; dx++) for (let dy = -cfg.maxHops; dy <= cfg.maxHops; dy++) {
        const x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0) continue;
        const name = ew + x + ns + y;
        if (!isHighway(name)) continue;
        if (Game.time - (m.visits[name] || 0) < cfg.scoutRevisit) continue;
        if (hops(home, name, cfg) === Infinity) continue;
        out.push(name);
    }
    return out.sort((a, b) => (m.visits[a] || 0) - (m.visits[b] || 0));
}

function getDemands(home) {
    const cfg = settings();
    if (!cfg.enabled || !home || !home.controller || !home.controller.my) return [];
    const out = [];
    if (Game.cpu.bucket < cfg.minBucket) return out;
    const m = Memory.deposits;
    if (m && m.list) {
        for (const id in m.list) {
            const d = m.list[id];
            if (d.home !== home.name || !workable(d, cfg)) continue;
            const body = minerBody(home.energyCapacityAvailable, cfg);
            if (!body.length) continue;
            out.push({ role: 'depositMiner', slot: 'deposit:' + id, body,
                memory: { role: 'depositMiner', slotKey: 'deposit:' + id, home: home.name, depositId: id, depositRoom: d.room },
                lead: body.length * 3 + (d.hops || 3) * 50, priority: 0, cls: 'opportunistic',
                bodyFor: (b) => minerBody(b, cfg) });
        }
    }
    if (cfg.scout && scoutHome(cfg) === home.name && cpuOk(cfg) && patrolTargets(home.name, cfg).length) {
        out.push({ role: 'depositScout', slot: 'depositScout', body: ['move'],
            memory: { role: 'depositScout', slotKey: 'depositScout', home: home.name }, lead: 0, priority: 1, cls: 'opportunistic' });
    }
    return out;
}

module.exports = { settings, run, note, hops, workable, cpuOk, minerBody, patrolTargets, getDemands, isHighway, isKeeperRoom, scoutHome };
