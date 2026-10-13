'use strict';
/**
 * 扩张执行层：外部大脑在指令里给出 claim 目标，这里只负责把它变成孵化需求。
 *   claimer：[CLAIM, MOVE]，占下 controller 即退役；
 *   新房归我方后由轮子规划（layout.run → wheel_layout.generate）给出布局，spawn1 工地放在轮子的第一个 spawn 位；
 *   pioneer：builder 身体，去新房就地采能、建 spawn、升 controller，新房 spawn 建成后转为该房的 builder。
 * 指令里即便带了 spawnPos/plan 也不采用——布局唯一来源是轮子。
 * 没有指令、GCL 无余量、母房能量不足或正在恢复时不产生任何需求。
 * 大脑掉线一整天（config.expansion.autoClaimAfterMs）后退回 autoClaimTarget 的保守兜底，大脑一回来立刻让位。
 */
const config = require('config');
const brain = require('brain');
const retire = require('retire');
const movement = require('movement');
const { makeBody, roomDistance, creepsHomeRole, isRetiring, logErr } = require('utils');

function settings() {
    return Object.assign({ minCapacity: 650, minRcl: 3, pioneers: 2, pioneerBudget: 800,
        autoClaimAfterMs: 24 * 60 * 60 * 1000, autoClaimInterval: 1500, autoClaimRange: 2, autoClaimFreshFor: 20000 }, config.expansion || {});
}

function ownedRoomCount() {
    let n = 0;
    for (const room of Object.values(Game.rooms || {})) {
        if (room.controller && room.controller.my) n++;
    }
    return n;
}

function gclHeadroom() {
    const level = Game.gcl && Number(Game.gcl.level) || 0;
    return level - ownedRoomCount();
}

/** 已有己方房间还没建成 spawn：开荒未完成，同一时间只允许一个占领在途 */
function bootstrapInProgress(exceptRoom) {
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || room.name === exceptRoom) continue;
        if (!room.find(FIND_MY_SPAWNS).length) return room.name;
    }
    return null;
}

/** 别的母房已经在开荒这个房（指令或记忆）：不再重复接管——2026-09-06 线上 W33S8 按指令占 W31S8 后，
 *  W34S7/W35S7 各自"自愈"接管又各派 2 只 pioneer，一个新房挤了 7 只（W35S7 容量 900、4 跳远） */
function sponsoredByAnother(roomName, homeName) {
    for (const name in Memory.rooms || {}) {
        if (name === homeName) continue;
        const expansion = Memory.rooms[name] && Memory.rooms[name].expansion;
        if (expansion && expansion.target === roomName) return true;
    }
    return false;
}

/** 无人接管的孤儿房由离它最近、够格开荒（RCL/容量）的母房接管，同距离按房名；其余母房不凑 */
function closestSponsor(roomName) {
    const cfg = settings();
    let best = null;
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || room.name === roomName) continue;
        if (room.controller.level < cfg.minRcl || room.energyCapacityAvailable < cfg.minCapacity) continue;
        if (!room.find(FIND_MY_SPAWNS).length) continue;
        const distance = roomDistance(room.name, roomName);
        if (!best || distance < best.distance || (distance === best.distance && room.name < best.name)) best = { name: room.name, distance };
    }
    return best ? best.name : null;
}

/**
 * 这个房现在是不是某个母房正在采的外矿（记录启用）。
 * 自治兜底刻意**不**碰它们：外矿已经在产出，把它转成己方房要搭上 claimer + pioneer + 漫长的 RCL 爬升，
 * 期间还丢掉预定带来的 3000 档源容量——这是一笔要全账号视角才算得清的交易，该由外部大脑定价，
 * 不该由一个"大脑掉线了"的兜底盲目做。兜底只负责往**新地盘**长，不停摆就够了。
 * （overmind-absorb 私服 validation-We4zzV：没有这条闸时，兜底把 remote 场景正在采的 W50N49 直接占了，那条外矿记录当场消失）
 */
function isActiveRemote(roomName) {
    for (const name in Memory.rooms || {}) {
        const remotes = Memory.rooms[name] && Memory.rooms[name].remotes;
        const record = remotes && !Array.isArray(remotes) ? remotes[roomName] : null;
        if (record && record.enabled) return true;
    }
    return false;
}

/** 别的母房有开荒记录（Memory.rooms[*].expansion，不论来自指令还是兜底）：兜底一次只开一个房——
 *  大脑有全账号的 GCL/援建账，兜底没有，并行开荒的弱房会一起饿着 */
function expansionElsewhere(homeName) {
    for (const name in Memory.rooms || {}) {
        if (name === homeName) continue;
        const expansion = Memory.rooms[name] && Memory.rooms[name].expansion;
        if (expansion && expansion.target) return name;
    }
    return null;
}

/** 房间状态（normal/novice/respawn/closed）与母房不同就过不去（新手区/重生区的墙）；地图 API 不可用时放行 */
function sameRoomStatus(a, b) {
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.getRoomStatus !== 'function') return true;
    const left = map.getRoomStatus(a);
    const right = map.getRoomStatus(b);
    return !left || !right || left.status === right.status;
}

/**
 * 兜底的候选门槛（比大脑 plan.usable_for_claim 更严）。cheap=true 是缓存期内的复核：只看会随时间变的情报/归属，
 * 不重算路线与母房资格（那两项每 autoClaimInterval 才在重扫时算一次）。named = 用户在锁里点名的房（不卡双源）。
 */
function autoClaimOk(home, roomName, named, cheap) {
    const cfg = settings();
    if (!roomName || roomName === home.name) return false;
    const info = Memory.map && Memory.map[roomName];
    if (!info || typeof info !== 'object' || info.unreachable) return false;
    if (!(info.at >= 0) || Game.time - info.at > cfg.autoClaimFreshFor) return false;   // 没有/太旧的情报不敢用
    if (!info.controllerId) return false;                                               // 高速路 / 无控制器房
    if (info.class === 'sk' || info.class === 'center' || info.class === 'highway') return false;
    if (info.owner || Number(info.level || 0) > 0) return false;   // 有主：那是攻占（conquest）的事，不是扩张
    if (Number(info.lairs || 0) > 0) return false;                 // SK 房
    if (!named && Number(info.sources || 0) < 2) return false;      // 单源房自治时不占（大脑可以，它有全局账）
    if (info.threat || Number(info.armedHostiles || 0) > 0 || info.invaderCore) return false;
    const me = home.controller && home.controller.owner && home.controller.owner.username;
    const reservation = info.reservation;
    if (reservation && reservation.username && reservation.username !== me && !reservation.mine) return false;   // 别人预定着：会打起来
    const visible = Game.rooms[roomName];
    if (visible && visible.controller && (visible.controller.my || visible.controller.owner)) return false;
    if (sponsoredByAnother(roomName, home.name)) return false;
    if (isActiveRemote(roomName)) return false;
    // 本母房去过、没到（arrivalState/noteStuck 记的失败）：兜底不重试，换下一个候选；到达会清掉记录
    const reach = homeMemory(home).claimReachability;
    if (reach && reach[roomName] && (Number(reach[roomName].failures) > 0 || reach[roomName].suspendedUntil > Game.time)) return false;
    if (cheap) return true;
    const distance = roomDistance(home.name, roomName);
    if (!(distance > 0) || distance > cfg.autoClaimRange) return false;
    if (closestSponsor(roomName) !== home.name) return false;   // 离它最近的够格母房来开（多个母房算出同一结论，不会互抢）
    if (!sameRoomStatus(home.name, roomName)) return false;
    // 不穿 SK/他人占领房也走得到：开荒后援建 creep 走默认避让，SK 环外的新房对它们就是孤岛（movement.safeRouteExists）
    try {
        if (!movement.safeRouteExists(home.name, roomName)) return false;
    } catch (error) {
        logErr('expansion.autoClaim route ' + roomName, error);
        return false;
    }
    return true;
}

/** 自治占领的 CPU 余量：bucket ≥ autoClaimMinBucket，且最近 autoClaimCpuSamples 条 Memory.stats 的 tick 用量均值 ≤ limit × autoClaimMaxCpuShare。
 *  还没有 stats（新号/刚上线）时只看 bucket */
function autoClaimCpu(cfg) {
    const bucket = Number(Game.cpu && Game.cpu.bucket);
    const minBucket = Math.max(0, Number(cfg.autoClaimMinBucket) || 0);
    const want = Math.max(1, Math.floor(Number(cfg.autoClaimCpuSamples) || 5));
    const stats = Array.isArray(Memory.stats) ? Memory.stats : [];
    const values = [];
    for (let i = stats.length - 1; i >= 0 && values.length < want; i--) {
        const used = stats[i] && Number(stats[i].cpu);
        if (Number.isFinite(used)) values.push(used);
    }
    const mean = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
    const share = Number(cfg.autoClaimMaxCpuShare);
    const line = Number.isFinite(share) && share > 0 ? Math.round((Number(Game.cpu && Game.cpu.limit) || 0) * share * 10) / 10 : Infinity;
    const ok = !(Number.isFinite(bucket) && bucket < minBucket) && !(mean != null && mean > line);
    return { ok, bucket: Number.isFinite(bucket) ? bucket : null, mean, line: Number.isFinite(line) ? line : null };
}

/**
 * 大脑掉线时的自治占领目标。只在 brain.offlineMs() ≥ autoClaimAfterMs（指令 ttl 到期后一整天）时才走这里；
 * 有可用指令（哪怕它这一轮没给本房 claim）或 Memory.brain 从没出现过都不会到这一步（见 claimTarget）。
 *
 * 候选来源，按大脑留下的意图优先：
 *   1. 最后一份指令里未到期的 <母房>.claim 锁：锁定的房（value.room），或锁定为 null = 这个母房不占；
 *   2. 未到期的账号级 claim.queue 锁（用户点名的占领清单，顺序即优先级）：只从清单里挑，不另起炉灶——GCL 是留给这些房的；
 *   3. 都没有：从 Memory.map 已有的侦察情报里挑，近的优先、同距离按房名。
 * 门槛见 autoClaimOk：双源（点名的房除外）、无主、无 keeper、无敌情、无他人预定、情报新鲜、不是在采的外矿、本房没去失败过、
 * 距离 ≤ autoClaimRange、本房是它最近的够格母房、不穿危险房也走得到。账号里别的母房有开荒在途时不挑。
 * 宁可不占也不占错：占错的代价是 claimer + 2 pioneer 的几千能量，外加一个长期拖后腿的弱房。
 * 结论缓存在 Memory.rooms[母房].autoClaim（room/from/at），每 autoClaimInterval tick 才重扫，缓存期内只复核已挑中的房。
 */
function autoClaimTarget(home) {
    const cfg = settings();
    if (!cfg.autoClaim) return null;
    const mem = homeMemory(home);
    const cache = mem.autoClaim;
    const interval = Math.max(100, Number(cfg.autoClaimInterval) || 1500);
    const fresh = !!cache && cache.at != null && Game.time >= cache.at && Game.time - cache.at < interval;
    if (fresh && cache.room) {
        if (autoClaimOk(home, cache.room, !!cache.named, true) && !expansionElsewhere(home.name)) return { room: cache.room, reason: 'autonomous' };
        // 缓存的目标不再合格（被占/被预定/去失败了…）：当场重扫，别带着坏目标等满一个间隔
    } else if (fresh) {
        return null;   // 上次也没挑出来，别每 tick 重扫
    }
    const note = (fields) => { mem.autoClaim = Object.assign({ at: Game.time, room: null }, fields); return null; };
    if (home.controller.level < cfg.minRcl || home.energyCapacityAvailable < cfg.minCapacity) return note({ why: 'home' });
    if (gclHeadroom() <= 0) return note({ why: 'gcl' });
    // CPU 闸：账号已经吃紧时不替掉线的大脑再加一个房（已在开荒的自治目标照常开完，见 config.expansion.autoClaimMinBucket）
    if (!(mem.expansion && mem.expansion.autonomous)) {
        const cpu = autoClaimCpu(cfg);
        if (!cpu.ok) {
            // 遥测（生效断言 expansion.autoClaimCpuGate）：mem.autoClaim 下一轮重扫会被覆盖，这里单独留一份
            const held = mem.autoClaimCpuHeld || (mem.autoClaimCpuHeld = { first: Game.time, n: 0 });
            held.n = (Number(held.n) || 0) + 1;
            Object.assign(held, { at: Game.time, bucket: cpu.bucket, mean: cpu.mean, line: cpu.line });
            return note({ why: 'cpu', bucket: cpu.bucket, mean: cpu.mean, line: cpu.line });
        }
    }
    // 账号里还有己方房没建成 spawn（不论谁在开荒、有没有人开）或别的母房有开荒记录：先把它开完，兜底一次只开一个房
    const busy = bootstrapInProgress(null) || expansionElsewhere(home.name);
    if (busy) return note({ why: 'busy:' + busy });
    let candidates;
    let from;
    const homeLock = brain.standingLock(home.name + '.claim');
    const queueLock = brain.standingLock('claim.queue');
    if (homeLock) {
        from = 'lock';
        const room = homeLock.value && typeof homeLock.value === 'object' ? homeLock.value.room : null;
        candidates = typeof room === 'string' ? [room] : [];
    } else if (queueLock && Array.isArray(queueLock.value)) {
        from = 'queue';
        candidates = queueLock.value.filter((room) => typeof room === 'string' && room);
    } else {
        from = 'map';
        candidates = Object.keys(Memory.map || {})
            .map((room) => ({ room, distance: roomDistance(home.name, room) }))
            .filter((entry) => entry.distance > 0 && entry.distance <= cfg.autoClaimRange)
            // 近的优先，同距离按房名（确定性：别的母房算出来的顺序一致，不会互抢）
            .sort((a, b) => a.distance - b.distance || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0))
            .map((entry) => entry.room);
    }
    const named = from !== 'map';
    const room = candidates.find((name) => autoClaimOk(home, name, named, false)) || null;
    if (!room) return note({ from, why: 'none' });
    mem.autoClaim = { at: Game.time, room, from, named, distance: roomDistance(home.name, room) };
    // 遥测（生效断言 expansion.autoClaimOffline）：占下后缓存复核失败、重扫会记 busy:<目标> 覆盖 autoClaim，挑中的结论另留一份
    mem.autoClaimPicked = { room, from, at: Game.time, distance: mem.autoClaim.distance };
    return { room, reason: 'autonomous' };
}

function claimTarget(home) {
    const claim = brain.get(home.name, 'claim', null);
    if (claim && typeof claim === 'object' && typeof claim.room === 'string') {
        return claim.room === home.name ? null : claim;
    }
    // 有可用指令但这一轮没给本房 claim：那是大脑的决定，不自作主张；只有掉线够久才退回自治兜底
    const offline = brain.offlineMs();
    const cfg = settings();
    if (!cfg.autoClaim || offline == null || offline < Math.max(Number(cfg.autoClaimAfterMs) || 0, 1)) return null;
    const auto = autoClaimTarget(home);
    return auto && auto.room !== home.name ? auto : null;
}

/** 目标房轮子方案给出的 spawn1 位（还没规划时为 null） */
function wheelSpawnPos(roomName) {
    const plan = Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].plan;
    if (!plan || !plan.wheel || !Array.isArray(plan.spawns) || !plan.spawns[0]) return null;
    return { x: plan.spawns[0].x, y: plan.spawns[0].y };
}

function targetStatus(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return { visible: false, mine: false, foreign: false, hasSpawn: false };
    const controller = room.controller;
    const mine = !!(controller && controller.my);
    const foreign = !!(controller && controller.owner && !controller.my);
    const hasSpawn = mine && room.find(FIND_MY_SPAWNS).length > 0;
    return { visible: true, mine, foreign, hasSpawn };
}

// 外矿 reserver 改任 claimer 时至少要有这么多寿命才够走到目标房（reserver 最长 600 tick）
const CLAIM_TRAVEL_LEAD = 100;

/** 母房已有带 CLAIM 部件、寿命够的 reserver 指向目标房（roles/reserver.js 会就地 claim）：不必再孵 claimer */
function claimCapableCreep(home, roomName) {
    for (const creep of creepsHomeRole(home.name, 'reserver')) {
        if (creep.spawning) continue;
        if (creep.memory.remoteRoom !== roomName) continue;
        if (!(creep.body || []).some((part) => part.type === CLAIM && part.hits !== 0)) continue;
        if (creep.ticksToLive != null && creep.ticksToLive <= CLAIM_TRAVEL_LEAD) continue;
        return creep;
    }
    return null;
}

/** bodyFor(budget)：预算不足满配时按预算缩身的身体（spawn 队列在宽限用完后调用）；不给则只能等满配 */
function demand(role, slot, body, memory, lead, priority, bodyFor) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, bodyFor };
}

function homeMemory(home) {
    Memory.rooms = Memory.rooms || {};
    Memory.rooms[home.name] = Memory.rooms[home.name] || {};
    return Memory.rooms[home.name];
}

/** 正在开荒的目标：优先指令里的 claim；指令撤掉后沿用母房记忆，直到新房建成 spawn */
function activeTarget(home) {
    const mem = homeMemory(home);
    const claim = claimTarget(home);
    // 没人管的孤儿房（己方、没 spawn、没有母房在开荒它）且本房是离它最近的够格母房：先把它开完，指令里的新目标往后排——
    // 以前是"有房在开荒就不接受第二个占领"，两个母房各开一房时互相封死（线上 W31S6/W31S8 的 pioneer 到寿命后再没补过）
    const orphan = bootstrapInProgress(home.name);
    const orphanIsMine = !!orphan && !sponsoredByAnother(orphan, home.name) && closestSponsor(orphan) === home.name;
    // 自治兜底挑的、还没占下的目标，兜底不再要它了（大脑回来了且没接着要这个房、或目标不再合格）：作废，在途 claimer/pioneer 退役——
    // 占哪个房是大脑的账，它在线时游戏内不替它多占一个
    if (mem.expansion && mem.expansion.autonomous && (!claim || claim.room !== mem.expansion.target) &&
        !targetStatus(mem.expansion.target).mine) {
        retireTravelers(home, mem.expansion.target);
        delete mem.expansion;
    }
    if (claim && claim.room !== home.name && !(orphanIsMine && orphan !== claim.room)) {
        // spawn 位只认目标房自己的轮子方案（归我方后才会生成）；指令里的 spawnPos/plan 一律忽略
        mem.expansion = { target: claim.room, spawnPos: wheelSpawnPos(claim.room),
            since: mem.expansion && mem.expansion.target === claim.room ? mem.expansion.since : Game.time };
        if (claim.reason === 'autonomous') mem.expansion.autonomous = true;
        return mem.expansion;
    }
    let remembered = mem.expansion;
    if (remembered && remembered.target === home.name) { delete mem.expansion; remembered = null; }
    if (!remembered || !remembered.target) {
        // 自愈：内存丢失/旧版本没记录时，接管任何己方还没 spawn 的房（spawnPos 取自它的 spawn 工地）
        const orphan = bootstrapInProgress(home.name);
        if (!orphan || sponsoredByAnother(orphan, home.name) || closestSponsor(orphan) !== home.name) return null;
        const site = Game.rooms[orphan].find(FIND_MY_CONSTRUCTION_SITES).find((s) => s.structureType === STRUCTURE_SPAWN);
        remembered = { target: orphan, spawnPos: site ? { x: site.pos.x, y: site.pos.y } : null, since: Game.time };
        mem.expansion = remembered;
    }
    const status = targetStatus(remembered.target);
    if (!status.mine || status.hasSpawn) {
        // 目标不再是我方（占领失败/被夺）或已建成 spawn：开荒结束
        delete mem.expansion;
        return null;
    }
    return remembered;
}

function stuckTicks() {
    return Math.max(1, Number((config.remote || {}).stuckTicks) || 60);
}

function liveTravelers(home, roomName, roles) {
    const want = roles || { claimer: true, pioneer: true, reserver: true };
    return Object.values(Game.creeps || {}).filter((c) => c.memory && c.memory.home === home.name &&
        (c.memory.targetRoom === roomName || c.memory.remoteRoom === roomName) &&
        want[c.memory.role] && !c.spawning && !isRetiring(c.memory));
}

function retireTravelers(home, roomName) {
    for (const creep of liveTravelers(home, roomName, { claimer: true, pioneer: true })) {
        creep.memory.retired = true;
        retire.retireAtSpawn(creep);
    }
}

function markUnreachable(home, roomName, reason) {
    const mem = homeMemory(home);
    const records = mem.claimReachability = mem.claimReachability || {};
    const cfg = settings();
    const record = records[roomName] = records[roomName] || { failures: 0 };
    if (!(record.suspendedUntil > Game.time)) {
        record.failures = Math.min((record.failures || 0) + 1, 20);
        record.suspendedUntil = Game.time + Math.min(cfg.unreachableMaxTicks, cfg.unreachableTicks * Math.pow(2, record.failures - 1));
        record.reason = reason || 'unreachable';
        delete record.startedAt;
    }
    retireTravelers(home, roomName);
    return record;
}

/** 去程连续 stuckTicks 格不动（墙封死、ERR_NO_PATH）：立刻记不可达并退役，不必等到 CLAIM 寿命耗尽。 */
function noteStuck(creep) {
    if (!creep || !creep.memory || !creep.pos) return false;
    const homeName = creep.memory.home;
    const roomName = creep.memory.targetRoom;
    if (!homeName || !roomName) return false;
    if (creep.room && creep.room.name === roomName) return false;
    if (isRetiring(creep.memory)) return false;
    const posKey = creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y;
    if (creep.memory._tp === posKey) creep.memory._ts = (creep.memory._ts || 0) + 1;
    else { creep.memory._tp = posKey; creep.memory._ts = 0; }
    if (creep.memory._ts < stuckTicks()) return false;
    creep.memory._ts = 0;
    const home = Game.rooms[homeName];
    if (!home) return false;
    markUnreachable(home, roomName, 'unreachable');
    return true;
}

/** 独立于每 tick 重建的 expansion；重复指令和切换目标不能抹掉失败历史。 */
function arrivalState(home, target) {
    const mem = homeMemory(home);
    const records = mem.claimReachability = mem.claimReachability || {};
    const roomName = target.target;
    const arrived = liveTravelers(home, roomName).some((c) => c.room && c.room.name === roomName);
    if (targetStatus(roomName).mine || arrived) {
        delete records[roomName];
        return { blocked: false, probing: false };
    }
    const cfg = settings();
    const record = records[roomName] = records[roomName] || { failures: 0 };
    if (record.suspendedUntil > Game.time) return { blocked: true, probing: true };
    // 只在确实孵出了 claimer 后计时，母房暂时没能量不能算不可达。退役中的不算在途。
    const traveler = liveTravelers(home, roomName, { claimer: true })[0];
    if (record.startedAt == null && traveler) record.startedAt = Game.time;
    if (record.startedAt != null && Game.time - record.startedAt >= cfg.arrivalTimeout) {
        markUnreachable(home, roomName, 'unreachable');
        return { blocked: true, probing: true };
    }
    return { blocked: false, probing: record.failures > 0 };
}

/** 母房为扩张要孵化的 creep 需求（与 remote.getDemands 同结构） */
function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const cfg = settings();
    if (home.controller.level < cfg.minRcl || home.energyCapacityAvailable < cfg.minCapacity) return [];
    const target = activeTarget(home);
    if (!target) return [];
    const claim = { room: target.target, spawnPos: target.spawnPos };
    const status = targetStatus(claim.room);
    if (status.foreign) { delete homeMemory(home).expansion; return []; }
    if (!status.mine && gclHeadroom() <= 0) return [];
    if (status.hasSpawn) { delete homeMemory(home).expansion; return []; }
    // 不再因为"别的房也在开荒"就停手：每个母房只有一个开荒目标，多个母房并行开荒是允许的——
    // 2026-09-06 线上 W33S7 → W31S6 与 W33S8 → W31S8 同时开荒，这条门让两家互相封死，7 只 pioneer 到寿命后再没补过，spawn 工地停在 3240/12600
    const reachability = arrivalState(home, target);
    if (reachability.blocked) return [];
    const demands = [];
    let priority = 0;
    // memory.home 必须带上：spawn 的槽位计数按 home + slotKey 匹配，否则每攒够能量就再孵一只
    const memory = { home: home.name, targetRoom: claim.room, spawnPos: claim.spawnPos || null };
    if (!status.mine && !claimCapableCreep(home, claim.room)) {
        demands.push(demand('claimer', 'claimer:' + claim.room, ['claim', 'move'], memory, reachability.probing ? 0 : 100, priority++));
    }
    if (reachability.probing) return demands; // 冷却后只派 claimer，抵达后才恢复 pioneer
    const pioneerBody = makeBody('builder', Math.min(home.energyCapacityAvailable, cfg.pioneerBudget));
    for (let index = 0; index < cfg.pioneers; index++) {
        demands.push(demand('pioneer', 'pioneer:' + claim.room + ':' + index, pioneerBody, memory, 80, priority++,
            (budget) => makeBody('builder', Math.min(budget, cfg.pioneerBudget))));
    }
    return demands;
}

/** 每 tick 的开荒维护：目标房归我方且已有轮子方案后，确保 spawn1 工地在轮子给的位置上 */
function run(home) {
    if (!home || !home.controller || !home.controller.my) return;
    const target = activeTarget(home);
    if (!target || !target.target) return;
    // spawn 在 recovering / 全忙时不调 getDemands；已经派出的 claimer 仍要在这里计时，否则墙封死就无限续命。
    const reachability = arrivalState(home, target);
    if (reachability.blocked) retireTravelers(home, target.target);
    const room = Game.rooms[target.target];
    if (!room || !room.controller || !room.controller.my) return;
    if (room.find(FIND_MY_SPAWNS).length) return;
    const spawnPos = wheelSpawnPos(room.name) || target.spawnPos;
    if (!spawnPos) return;
    const hasSite = room.find(FIND_MY_CONSTRUCTION_SITES).some((site) => site.structureType === STRUCTURE_SPAWN);
    if (!hasSite) room.createConstructionSite(spawnPos.x, spawnPos.y, STRUCTURE_SPAWN);
}

module.exports = { run, getDemands, activeTarget, targetStatus, gclHeadroom, bootstrapInProgress, claimCapableCreep, settings, arrivalState, noteStuck, markUnreachable, autoClaimTarget, claimTarget };
