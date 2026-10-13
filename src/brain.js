'use strict';
/**
 * 外部大脑指令消费者。
 * 外部程序（scripts/brain）通过 HTTP API 把情报与规划写进 Memory.brain；游戏内只做三件事：
 *   1. 校验契约（version / issuedAt / ttlMs），坏指令整份忽略并记一次错误，绝不影响经济链；
 *   2. 把 intel 合并进 Memory.map（同房间以 at 更新者为准，标记 source:'external'）；
 *   3. 提供 directive(roomName) 访问器，并写回 ack 让外部知道指令已被读取。
 * 没有指令或指令过期时，各模块退回原有的自治逻辑。
 */
const { logErr } = require('utils');

const CONTRACT_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
// 过期后的宽限：外部大脑断网/失败时，退回"只做出口相邻外矿"的自治逻辑比继续用旧白名单更糟
// （2026-09-04 21:41 本机断网、指令过期 → W34S7 的 4 个外矿与 W33S7 的 2 个二跳外矿全被判 tooFar、远程 creep 退役）。
// 宽限内继续提供指令，只在 Memory.brain.stale 打标；超过宽限才退回自治
const STALE_GRACE_MS = 6 * 60 * 60 * 1000;

const SEGMENT = 90;

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__brainRuntime || (runtimeGlobal.__brainRuntime = {
    rejectedKey: null,
    segmentKey: null,
    activeAt: -1,
    active: null,
});

function segmentKey(raw) {
    // 变更检测：长度 + 首尾片段，避免每 tick 解析几十 KB 的 JSON
    return raw.length + ':' + raw.slice(0, 64) + ':' + raw.slice(-64);
}

/** 外部大脑把完整指令写进 segment 90（console 表达式有 1KB 限制，segment 可到 100KB）；内容变化时解析进 Memory.brain */
function ingestSegment() {
    if (typeof RawMemory === 'undefined' || !RawMemory) return;
    if (typeof RawMemory.setActiveSegments === 'function') RawMemory.setActiveSegments([SEGMENT]);
    const raw = RawMemory.segments && RawMemory.segments[SEGMENT];
    // 引擎在 tick 末尾会把 RawMemory.segments 上存在的每个键原样写回（driver runtime.js），
    // 大脑通过 API 写入的指令若恰好落在本 tick 读取之后就会被旧内容覆盖；读完即删键，本 tick 不再写回
    if (RawMemory.segments && Object.prototype.hasOwnProperty.call(RawMemory.segments, SEGMENT)) delete RawMemory.segments[SEGMENT];
    if (typeof raw !== 'string' || !raw.length) return;
    const key = segmentKey(raw);
    if (runtime.segmentKey === key) return;
    runtime.segmentKey = key;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        logErr('brain.segment', new Error('segment ' + SEGMENT + ' is not JSON: ' + String(error && error.message).slice(0, 80)));
        return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const current = Memory.brain;
    if (current && Number(current.issuedAt) === Number(parsed.issuedAt)) return;
    Memory.brain = parsed;
}

function now() {
    return Date.now();
}

function validate(directive) {
    if (!directive || typeof directive !== 'object') return 'missing';
    if (Number(directive.version) !== CONTRACT_VERSION) return 'version:' + directive.version;
    const issuedAt = Number(directive.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return 'issuedAt';
    if (directive.rooms != null && typeof directive.rooms !== 'object') return 'rooms';
    if (directive.intel != null && typeof directive.intel !== 'object') return 'intel';
    return null;
}

function ttlOf(directive) {
    return Number(directive.ttlMs) > 0 ? Number(directive.ttlMs) : DEFAULT_TTL_MS;
}

function stale(directive) {
    return now() - Number(directive.issuedAt) > ttlOf(directive);
}

function expired(directive) {
    return now() - Number(directive.issuedAt) > ttlOf(directive) + STALE_GRACE_MS;
}

function mergeIntel(intel) {
    if (!intel) return 0;
    Memory.map = Memory.map || {};
    let merged = 0;
    for (const roomName of Object.keys(intel)) {
        const entry = intel[roomName];
        if (!entry || typeof entry !== 'object') continue;
        const existing = Memory.map[roomName];
        const incomingAt = Number(entry.at) || 0;
        if (existing && Number(existing.at || 0) > incomingAt) continue;
        Memory.map[roomName] = Object.assign({}, entry, { source: 'external' });
        merged++;
    }
    return merged;
}

function run() {
    runtime.activeAt = Game.time;
    runtime.active = null;
    try { ingestSegment(); } catch (error) { logErr('brain.ingest', error); }
    const directive = typeof Memory !== 'undefined' ? Memory.brain : null;
    if (!directive) return null;
    const problem = validate(directive);
    if (problem) {
        const key = problem + ':' + directive.issuedAt + ':' + directive.version;
        if (runtime.rejectedKey !== key) {
            runtime.rejectedKey = key;
            logErr('brain.validate', new Error('directive rejected: ' + problem));
        }
        return null;
    }
    // 同一份指令只合并一次情报（ack.issuedAt 记录已处理的版本）
    const ack = directive.ack && directive.ack.issuedAt === directive.issuedAt ? directive.ack : null;
    if (!ack) {
        const merged = mergeIntel(directive.intel);
        directive.ack = { tick: Game.time, issuedAt: directive.issuedAt, applied: ['intel:' + merged] };
    } else {
        ack.tick = Game.time;
    }
    if (expired(directive)) return null;
    if (stale(directive)) directive.stale = true;
    else delete directive.stale;
    runtime.active = directive;
    return directive;
}

function current() {
    if (runtime.activeAt !== Game.time) run();
    return runtime.active;
}

/** 某房间的指令；无指令/过期/坏指令时返回 null，调用方退回自治逻辑 */
function directive(roomName) {
    const active = current();
    if (!active || !active.rooms) return null;
    const entry = active.rooms[roomName];
    return entry && typeof entry === 'object' ? entry : null;
}

/** 单个 key 的指令值，带默认值 */
function get(roomName, key, fallback) {
    const entry = directive(roomName);
    if (!entry || entry[key] === undefined) return fallback;
    return entry[key];
}

/** 当前指令已超过 ttl、正在宽限期内沿用（monitor 据此告警：大脑多久没写了） */
function isStale() {
    const active = current();
    return !!(active && active.stale);
}

/**
 * 现在还有没有可用的指令（ttl 内或宽限期内）。
 * 消费方要区分两种「brain.get 返回 null」：大脑在线但这一项没下指令（听大脑的，别自作主张），
 * 与大脑掉线（该退回自治）。前者 available() 为真，后者为假。
 */
function available() {
    return !!current();
}

/**
 * 大脑掉线多久了（ms，从最后一份指令的 ttl 到期算起）：指令可用时为 0。
 * Memory.brain 根本不存在（这个世界从没接过大脑：新号、私服场景）或 issuedAt 坏掉时返回 null——
 * 「从没有大脑」与「大脑掉线」是两回事，前者不该触发只为掉线准备的兜底（expansion.autoClaim）。
 * 被 validate 拒掉的指令（版本不对等）同样按它的 issuedAt 计：刚写进来的坏指令不算掉线很久。
 */
function offlineMs() {
    if (current()) return 0;
    const last = typeof Memory !== 'undefined' ? Memory.brain : null;
    const issuedAt = Number(last && last.issuedAt);
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) return null;
    return Math.max(0, now() - issuedAt - ttlOf(last));
}

/**
 * 最后一份指令里仍未到期的 agent 锁（locks[key]，自带 until ms）：指令本身过期后锁的意图仍然成立——
 * 用户点名的占领清单（claim.queue）、某母房的 claim 锁，掉线兜底要照着它们来，不能另起炉灶。
 * 没有/已到期返回 null，否则返回 { value }（value 可以是 null，表示"锁定为不要"）。
 */
function standingLock(key) {
    const last = typeof Memory !== 'undefined' ? Memory.brain : null;
    const locks = last && last.locks;
    const lock = locks && typeof locks === 'object' ? locks[key] : null;
    if (!lock || typeof lock !== 'object' || !(Number(lock.until) > now())) return null;
    return { value: lock.value === undefined ? null : lock.value };
}

module.exports = { run, directive, get, isStale, available, offlineMs, standingLock, CONTRACT_VERSION, SEGMENT, STALE_GRACE_MS };
