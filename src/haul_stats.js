'use strict';
/**
 * 运输饱和度遥测 v2（只观察、不改行为）：每只运输型 creep 每 tick 按"上一 tick 实际发生了什么"分类计数，
 * 按 母房 × 角色 累加，每 FLUSH_EVERY tick 并入 Memory.haulStats（累计值；A/B 与监控取两次读数的差分）。
 *
 * Screeps 的动作下一 tick 才结算，所以 tick T 开始时看到的位置/载货变化就是 T−1 那一 tick 的结果。
 * v1 计数（按净载货变化分类，保留以便与旧数据衔接）：
 *   idle / idleE / idleL / fat   没挪位且载货不变（空载 / 载货 / 其中被疲劳卡住）
 *   mvE / mvL / lf               挪了位、载货不变（空跑 / 载货行进，lf = Σ 载货率）
 *   ld / ul / ch                 载货增 / 减；同 tick 还挪了位的另记 ch
 *   in / out / cap / cu          装卸量；Σ 容量；所有挪位 tick 的 Σ 载货率
 *   dep / df                     出发（取货后第一个挪位 tick）次数与 Σ 出发装载率
 *   inS / outS / churn           从 storage 取 / 送回 storage / 取出又送回的量
 * v2 新增（净载货变化会把"同 tick 取 + 送"记成原地不动、把"在源旁涓流等货"记成取货，所以另按动作钩子与事件序列计）：
 *   ac / acm / ac0               有 OK 动作（transfer/withdraw/pickup）的 tick；其中同 tick 挪了位的；做了动作但载货没变的（被同 tick 抢先）
 *   ldT / ulT                    按动作钩子计的取货 / 投递 tick（同 tick 又取又送各记一次）
 *   tw / twE                     原地、没满、每 tick 增量不到容量 25% 的取货 tick（在源旁涓流等货）与其所得
 *   mvP / mvU                    空跑 tick 事后归类：下一个事件是连续 ≥ 3 tick 原地空闲 → 走去停车（mvP）；否则有效（mvU）
 *   abL / abE                    载货走了 ≥ 5 格下一个事件却是取货（半途换目标）/ 空载离开卸货点 ≥ 5 格又回到 2 格内、期间没取货（白跑）
 *   lgS / lgD / egS / egD        载货腿 / 空载腿的实际步数与起终点切比雪夫距离（绕路比 = S / D）
 *   dp8                          出发装载率 < 0.8 的次数
 *   idSt / idOv / idWa           空闲 tick 按母房当时的供给分：没货可取 / 全满 / 有货没人搬（最好的一处可取量 ≥ 半车且 spawn/ext/塔有缺口）
 *   lostAge / lostAgeOut / lostN 老死（最后一次看到时寿命将尽）时身上的能量、其中死在己方房外的、次数
 * 房级 _room：ticks；rfN / rfT / rfD（spawn+ext 从 < 90% 补到 ≥ 90% 的次数、耗时、缺口积分）；lkF / lsF（ctrl link / 任一源 link ≥ 780 的 tick）；spW（spawn 在等能量的 tick）
 * 外矿线 _lines[外矿房]（remoteHauler）：t idle tw ac acm dep df out cap lostAge
 * rs / ri：角色代码登记的原因（note）的 tick 数 / 其中 idle 的 tick 数（两版角色代码登记的原因不同，A/B 不直接比）。
 * 只统计连续两 tick 都观察到的样本（CPU 跳过、退役、刚孵出的那一 tick 不算）。
 */

const VERSION = 2;
const CARRIER_ROLES = { hauler: true, remoteHauler: true, feeder: true, courier: true, operator: true };
const FLUSH_EVERY = 30;
const COUNTERS = ['t', 'cap', 'idle', 'idleE', 'idleL', 'fat', 'mvE', 'mvL', 'lf', 'ld', 'ul', 'ch', 'in', 'out',
    'cu', 'dep', 'df', 'inS', 'outS', 'churn',
    'ac', 'acm', 'ac0', 'ldT', 'ulT', 'tw', 'twE', 'mvP', 'mvU', 'abL', 'abE', 'lgS', 'lgD', 'egS', 'egD', 'dp8',
    'idSt', 'idOv', 'idWa', 'lostAge', 'lostAgeOut', 'lostN'];
const ROOM_COUNTERS = ['ticks', 'rfN', 'rfT', 'rfD', 'lkF', 'lsF', 'spW'];
const LINE_COUNTERS = ['t', 'idle', 'tw', 'ac', 'acm', 'dep', 'df', 'out', 'cap', 'lostAge'];
const ROUNDED = { lf: true, cu: true, df: true };
const ACT = { transfer: 1, withdraw: 2, pickup: 4 };

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__haulStatsRuntime || (runtimeGlobal.__haulStatsRuntime = { last: {}, acc: {}, gcAt: 0 });
runtime.rooms = runtime.rooms || {};      // 房级累计（本窗口）
runtime.roomState = runtime.roomState || {};   // 房级跨 tick 状态（补能期）
runtime.lines = runtime.lines || {};
runtime.supply = runtime.supply || { tick: -1, rooms: {} };

function isCarrier(creep) {
    return !!(creep && creep.memory && CARRIER_ROLES[creep.memory.role]);
}

function usedOf(store) {
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') {
        const used = Number(store.getUsedCapacity());
        if (Number.isFinite(used)) return used;
    }
    let sum = 0;
    for (const key of Object.keys(store)) if (typeof store[key] === 'number') sum += store[key];
    return sum;
}

function capacityOf(creep) {
    const store = creep.store;
    if (store && typeof store.getCapacity === 'function') {
        const cap = Number(store.getCapacity());
        if (Number.isFinite(cap) && cap > 0) return cap;
    }
    const carry = typeof creep.getActiveBodyparts === 'function' ? creep.getActiveBodyparts(typeof CARRY === 'undefined' ? 'carry' : CARRY)
        : (creep.body || []).filter((part) => (part.type || part) === 'carry' && part.hits !== 0).length;
    return carry * 50;
}

function zeroed(keys) {
    const out = {};
    for (const key of keys) out[key] = 0;
    return out;
}

function bucketFor(home, role) {
    const room = runtime.acc[home] || (runtime.acc[home] = {});
    let bucket = room[role];
    if (!bucket) bucket = room[role] = Object.assign(zeroed(COUNTERS), { rs: {}, ri: {} });
    return bucket;
}

function lineFor(home, remoteRoom) {
    const lines = runtime.lines[home] || (runtime.lines[home] = {});
    return lines[remoteRoom] || (lines[remoteRoom] = zeroed(LINE_COUNTERS));
}

function storageType() {
    return typeof STRUCTURE_STORAGE === 'undefined' ? 'storage' : STRUCTURE_STORAGE;
}

function cheb(ax, ay, bx, by) {
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** 目标分类：storage 单独计（倒腾检测），其余只区分建筑类型/掉落/creep */
function targetKind(target) {
    if (!target) return null;
    if (target.structureType) return target.structureType;
    if (target.resourceType != null && target.amount != null) return 'drop';
    if (target.deathTime != null || target.ticksToDecay != null) return 'tomb';
    if (target.body) return 'creep';
    return 'other';
}

/** 取送动作登记（本 tick 的状态上）：observe 在下一 tick 按载货变化把量记到 storage 进/出上，并记动作位掩码 */
function noteAction(creep, kind, target) {
    const state = creep && runtime.last[creep.name];
    if (!state || typeof Game === 'undefined' || state.t !== Game.time) return;
    const type = targetKind(target);
    if (kind === 'transfer') state.to = type;
    else state.from = type;
    state.act |= ACT[kind] || 0;
}

/** 房间当时的供给与缺口（每房每 tick 一次）：最好的一处可取量（源容器 / 源旁掉落 / storage 高于升级者底线的部分）、spawn+ext+塔的缺口 */
function roomSupply(room) {
    if (runtime.supply.tick !== Game.time) { runtime.supply.tick = Game.time; runtime.supply.rooms = {}; }
    const cached = runtime.supply.rooms[room.name];
    if (cached) return cached;
    const energyKey = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
    const findStructures = typeof FIND_STRUCTURES === 'undefined' ? 'structures' : FIND_STRUCTURES;
    const structures = typeof room.find === 'function' ? room.find(findStructures) || [] : [];
    const sources = typeof room.find === 'function' ? room.find(typeof FIND_SOURCES === 'undefined' ? 'sources' : FIND_SOURCES) || [] : [];
    const drops = typeof room.find === 'function' ? room.find(typeof FIND_DROPPED_RESOURCES === 'undefined' ? 'droppedResources' : FIND_DROPPED_RESOURCES) || [] : [];
    const nearSource = (pos) => pos && sources.some((source) => source.pos && cheb(source.pos.x, source.pos.y, pos.x, pos.y) <= 2);
    let supply = 0;
    let towerGap = 0;
    for (const s of structures) {
        const type = s.structureType;
        if (type === (typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER) && s.store && nearSource(s.pos)) {
            supply = Math.max(supply, Number(s.store[energyKey]) || 0);
        } else if (type === (typeof STRUCTURE_TOWER === 'undefined' ? 'tower' : STRUCTURE_TOWER) && s.my !== false && s.store &&
            typeof s.store.getFreeCapacity === 'function') {
            const free = Number(s.store.getFreeCapacity(energyKey)) || 0;
            if (free >= 300) towerGap += free;
        }
    }
    for (const drop of drops) if (drop.resourceType === energyKey && nearSource(drop.pos)) supply = Math.max(supply, Number(drop.amount) || 0);
    if (room.storage && room.storage.my !== false && room.storage.store) supply = Math.max(supply, (Number(room.storage.store[energyKey]) || 0) - 2000);
    const deficit = Math.max(0, (Number(room.energyCapacityAvailable) || 0) - (Number(room.energyAvailable) || 0)) + towerGap;
    const out = { supply, deficit };
    runtime.supply.rooms[room.name] = out;
    return out;
}

function linkEnergyAt(room, spot) {
    if (!spot || typeof room.lookForAt !== 'function') return null;
    const look = typeof LOOK_STRUCTURES === 'undefined' ? 'structure' : LOOK_STRUCTURES;
    const link = (room.lookForAt(look, spot.x, spot.y) || []).find((s) => s.structureType === (typeof STRUCTURE_LINK === 'undefined' ? 'link' : STRUCTURE_LINK));
    return link && link.store ? Number(link.store[typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY]) || 0 : null;
}

/** 房级（每个有运输 creep 的母房每 tick 一次）：spawn+ext 补能期、link 满着的 tick、spawn 在等能量的 tick */
function roomTick(room) {
    const acc = runtime.rooms[room.name] || (runtime.rooms[room.name] = zeroed(ROOM_COUNTERS));
    const st = runtime.roomState[room.name] || (runtime.roomState[room.name] = { seen: -1, start: null, deficit: 0 });
    if (st.seen === Game.time) return;
    st.seen = Game.time;
    acc.ticks++;
    const capacity = Number(room.energyCapacityAvailable) || 0;
    const available = Number(room.energyAvailable) || 0;
    if (capacity > 0 && available < capacity * 0.9) {
        if (st.start == null) { st.start = Game.time; st.deficit = 0; }
        st.deficit += capacity - available;
    } else if (st.start != null) {
        acc.rfN++;
        acc.rfT += Game.time - st.start;
        acc.rfD += st.deficit;
        st.start = null;
        st.deficit = 0;
    }
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = mem && mem.plan;
    const linkSpots = plan && plan.links;
    if (linkSpots) {
        const ctrl = linkEnergyAt(room, linkSpots.ctrl);
        if (ctrl != null && ctrl >= 780) acc.lkF++;
        if (['src0', 'src1', 'src'].some((key) => { const e = linkEnergyAt(room, linkSpots[key]); return e != null && e >= 780; })) acc.lsF++;
    }
    const waiting = mem && mem.spawnWaiting;
    if (waiting && waiting.cost > 0 && Game.time - Number(waiting.at || 0) <= 5 && available < waiting.cost) acc.spW++;
}

/** 每只 creep 每 tick 在角色代码执行前调用一次：记下本 tick 开始时的状态，并给上一 tick 的活动分类 */
function observe(creep) {
    if (!isCarrier(creep) || creep.spawning || !creep.pos) return;
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    const used = usedOf(creep.store);
    const prev = runtime.last[creep.name];
    const consecutive = !!prev && prev.t === now - 1 && prev.cap > 0;
    const home = (creep.memory && creep.memory.home) || creep.pos.roomName || '?';
    const role = creep.memory.role;
    const state = {
        t: now, x: creep.pos.x, y: creep.pos.y, r: creep.pos.roomName, e: used,
        cap: capacityOf(creep), fat: Number(creep.fatigue) || 0, why: null, to: null, from: null, act: 0,
        ttl: creep.ticksToLive == null ? null : Number(creep.ticksToLive), home, role,
        remote: role === 'remoteHauler' ? creep.memory.remoteRoom || null : null,
        // 货物来源（storage / other）跟着货走：空了就清
        src: used > 0 && prev ? prev.src || null : null, cls: null,
        tr: prev && prev.tr ? prev.tr : { run: 0, park: 0, idle: 0, leg: null, eleg: null },
    };
    runtime.last[creep.name] = state;
    const homeRoom = typeof Game !== 'undefined' && Game.rooms ? Game.rooms[home] : null;
    if (homeRoom) roomTick(homeRoom);
    if (!consecutive) { state.tr = { run: 0, park: 0, idle: 0, leg: null, eleg: null }; return; }
    const bucket = bucketFor(home, role);
    const line = state.remote ? lineFor(home, state.remote) : null;
    const tr = state.tr;
    const moved = prev.x !== state.x || prev.y !== state.y || prev.r !== state.r;
    const delta = used - prev.e;
    const fill = Math.min(1, prev.e / prev.cap);
    bucket.t++;
    bucket.cap += prev.cap;
    if (line) { line.t++; line.cap += prev.cap; }
    let idle = false;
    let cls;
    if (delta > 0) {
        cls = 'ld';
        bucket.ld++;
        bucket.in += delta;
        if (moved) bucket.ch++;
        const fromStorage = prev.from === storageType();
        if (fromStorage) bucket.inS += delta;
        // 混装：只要装过 storage 的货就按 storage 算（倒腾检测宁可多算）
        state.src = fromStorage || prev.src === 'storage' ? 'storage' : 'other';
        if (!moved && delta < prev.cap * 0.25 && used < prev.cap) {
            bucket.tw++;
            bucket.twE += delta;
            if (line) line.tw++;
        }
    } else if (delta < 0) {
        cls = 'ul';
        bucket.ul++;
        bucket.out -= delta;
        if (line) line.out -= delta;
        if (moved) bucket.ch++;
        if (prev.to === storageType()) {
            bucket.outS -= delta;
            if (prev.src === 'storage') bucket.churn -= delta;
        }
    } else if (moved) {
        cls = prev.e > 0 ? 'mvL' : 'mvE';
        if (prev.e > 0) { bucket.mvL++; bucket.lf += fill; } else bucket.mvE++;
    } else {
        cls = 'idle';
        idle = true;
        bucket.idle++;
        if (line) line.idle++;
        if (prev.e > 0) bucket.idleL++; else bucket.idleE++;
        if (prev.fat > 0) bucket.fat++;
        if (homeRoom) {
            const supply = roomSupply(homeRoom);
            if (supply.deficit <= 0) bucket.idOv++;
            else if (supply.supply >= prev.cap * 0.5) bucket.idWa++;
            else bucket.idSt++;
        }
    }
    // 动作钩子：有 OK 动作的 tick、其中同 tick 挪位的、做了却没变化的；取/送 tick 各自计
    const act = prev.act || 0;
    if (act) {
        bucket.ac++;
        if (line) line.ac++;
        if (moved) { bucket.acm++; if (line) line.acm++; }
        if (delta === 0) bucket.ac0++;
        if (act & (ACT.withdraw | ACT.pickup)) bucket.ldT++;
        if (act & ACT.transfer) bucket.ulT++;
    }
    if (moved) {
        bucket.cu += fill;
        // 出发：取货之后第一个挪了位的 tick（连续取货只算最后一次之后的出发）
        if (prev.cls === 'ld' && cls !== 'ld') {
            bucket.dep++;
            bucket.df += fill;
            if (fill < 0.8) bucket.dp8++;
            if (line) { line.dep++; line.df += fill; }
            tr.leg = { x: prev.x, y: prev.y, r: prev.r, steps: 0 };
        }
    }
    // 载货腿：出发 → 下一次投递（步数 vs 起终点距离）；半途又去取货且已走 ≥ 5 格 = 换了目标
    if (tr.leg) {
        if (moved && prev.e > 0) tr.leg.steps++;
        if (cls === 'ul' || (act & ACT.transfer)) {
            if (tr.leg.r === prev.r) { bucket.lgS += tr.leg.steps; bucket.lgD += cheb(tr.leg.x, tr.leg.y, prev.x, prev.y); }
            tr.leg = null;
        } else if (cls === 'ld' && tr.leg.steps >= 5) {
            bucket.abL++;
            tr.leg = null;
        }
    }
    // 空载腿：投空 → 下一次取货；空载走出 ≥ 5 格又回到起点 2 格内、期间没取货 = 白跑
    if (cls === 'ul' && used === 0) tr.eleg = { x: prev.x, y: prev.y, r: prev.r, steps: 0, far: 0 };
    else if (tr.eleg) {
        if (cls === 'mvE') {
            tr.eleg.steps++;
            if (state.r === tr.eleg.r) {
                const d = cheb(tr.eleg.x, tr.eleg.y, state.x, state.y);
                if (d > tr.eleg.far) tr.eleg.far = d;
                if (tr.eleg.far >= 5 && d <= 2) { bucket.abE++; tr.eleg = null; }
            } else tr.eleg.far = Math.max(tr.eleg.far, 50);
        } else if (cls === 'ld') {
            if (tr.eleg.r === prev.r) { bucket.egS += tr.eleg.steps; bucket.egD += cheb(tr.eleg.x, tr.eleg.y, prev.x, prev.y); }
            tr.eleg = null;
        }
    }
    // 空跑事后归类：一段空跑之后连续原地 ≥ 3 tick = 走去停车；接着取货 / 别的事 = 有效
    if (cls === 'mvE') {
        tr.run++;
        tr.idle = 0;
    } else if (idle && prev.e === 0) {
        if (tr.run > 0) { tr.park += tr.run; tr.run = 0; }
        tr.idle++;
        if (tr.idle >= 3 && tr.park > 0) { bucket.mvP += tr.park; tr.park = 0; }
    } else {
        if (tr.run + tr.park > 0) bucket.mvU += tr.run + tr.park;
        tr.run = 0;
        tr.park = 0;
        tr.idle = 0;
    }
    state.cls = cls;
    if (prev.why) {
        bucket.rs[prev.why] = (bucket.rs[prev.why] || 0) + 1;
        if (idle) bucket.ri[prev.why] = (bucket.ri[prev.why] || 0) + 1;
    }
}

/** 角色代码登记本 tick 的"为什么没在干活"（park / full / wait / retreat…）；observe 在下一 tick 把它记到分类上 */
function note(creep, why) {
    const state = creep && runtime.last[creep.name];
    if (state && typeof Game !== 'undefined' && state.t === Game.time && !state.why) state.why = why;
}

function mergeInto(target, source, keys) {
    for (const key of keys) target[key] = (Number(target[key]) || 0) + (Number(source[key]) || 0);
    for (const field of ['rs', 'ri']) {
        if (!source[field]) continue;
        const into = target[field] || (target[field] = {});
        for (const [key, value] of Object.entries(source[field] || {})) into[key] = (into[key] || 0) + value;
    }
    for (const key of Object.keys(ROUNDED)) if (key in target) target[key] = Math.round(target[key] * 100) / 100;
}

function ownedRoom(name) {
    const room = typeof Game !== 'undefined' && Game.rooms ? Game.rooms[name] : null;
    return !!(room && room.controller && room.controller.my);
}

/** 老死带货：上次看到时寿命已尽（≤ 离上次观察的 tick 数 + 1）且身上有货的死亡 creep */
function settleDeaths() {
    for (const name of Object.keys(runtime.last)) {
        if (Game.creeps && Game.creeps[name]) continue;
        const last = runtime.last[name];
        delete runtime.last[name];
        if (!last || !(last.e > 0) || last.ttl == null) continue;
        if (last.ttl > Game.time - last.t + 1) continue;   // 还有寿命却消失了：回收 / 战死，不算老死
        const bucket = bucketFor(last.home || last.r || '?', last.role || '?');
        bucket.lostAge += last.e;
        bucket.lostN++;
        if (!ownedRoom(last.r)) bucket.lostAgeOut += last.e;
        if (last.remote) lineFor(last.home || '?', last.remote).lostAge += last.e;
    }
}

function flush() {
    if (typeof Game === 'undefined' || typeof Memory === 'undefined') return;
    if (Game.time % FLUSH_EVERY !== 0) return;
    settleDeaths();
    const stats = Memory.haulStats && Memory.haulStats.v === VERSION ? Memory.haulStats : (Memory.haulStats = { v: VERSION, since: Game.time, rooms: {} });
    const window = {};
    for (const [home, roles] of Object.entries(runtime.acc)) {
        const room = stats.rooms[home] || (stats.rooms[home] = {});
        for (const [role, bucket] of Object.entries(roles)) {
            if (!bucket.t && !bucket.lostN) continue;
            mergeInto(room[role] || (room[role] = {}), bucket, COUNTERS);
            (window[home] || (window[home] = {}))[role] = { t: bucket.t, idle: bucket.idle, cap: bucket.cap, out: bucket.out };
        }
    }
    for (const [home, acc] of Object.entries(runtime.rooms)) {
        if (!acc.ticks) continue;
        const room = stats.rooms[home] || (stats.rooms[home] = {});
        mergeInto(room._room || (room._room = {}), acc, ROOM_COUNTERS);
    }
    for (const [home, lines] of Object.entries(runtime.lines)) {
        const room = stats.rooms[home] || (stats.rooms[home] = {});
        const into = room._lines || (room._lines = {});
        for (const [remoteRoom, line] of Object.entries(lines)) {
            if (!line.t && !line.lostAge) continue;
            mergeInto(into[remoteRoom] || (into[remoteRoom] = {}), line, LINE_COUNTERS);
        }
    }
    stats.t = Game.time;
    stats.last = window;
    runtime.acc = {};
    runtime.rooms = {};
    runtime.lines = {};
}

/** 只记录的原型包装：运输型 creep 的 transfer/withdraw/pickup 返回 OK 时登记目标类型与动作位（每个全局只装一次，原样返回） */
function installActionHooks() {
    if (typeof Creep === 'undefined' || !Creep.prototype) return;
    const okCode = typeof OK === 'undefined' ? 0 : OK;
    for (const kind of ['transfer', 'withdraw', 'pickup']) {
        const flag = '__haulStatsHook_' + kind;
        const original = Creep.prototype[kind];
        if (typeof original !== 'function' || original[flag]) continue;
        const hooked = function (target, ...rest) {
            const result = original.call(this, target, ...rest);
            if (result === okCode && isCarrier(this)) {
                try { noteAction(this, kind, target); } catch (error) { /* 遥测不影响动作 */ }
            }
            return result;
        };
        hooked[flag] = true;
        Creep.prototype[kind] = hooked;
    }
}
installActionHooks();

module.exports = { observe, note, noteAction, flush, isCarrier, installActionHooks, CARRIER_ROLES, COUNTERS, ROOM_COUNTERS, LINE_COUNTERS, VERSION, _runtime: runtime };
