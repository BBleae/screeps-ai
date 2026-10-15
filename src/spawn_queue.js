'use strict';
/**
 * spawn 请求队列（纯函数，不碰 Game 对象）：各来源的需求统一成请求，按 (priority, neededBy/seq) 排队；
 * 队头买不起时用能量增速估计"多久能攒够"——截止前能攒够就等并为它保留能量，否则立刻按现有能量缩身。
 * 设计：docs/superpowers/specs/2026-09-04-spawn-queue-design.md。
 *
 * 请求字段：
 *   key          唯一键，跨 tick 稳定（spawn.js 用它记录首次出现的 tick）
 *   role, memory
 *   priority     数字越小越先（config.spawnQueue.classes）
 *   grace        从首次出现起最多为满配等多少 tick，超过就缩身
 *   neededBy     可选绝对截止tick，与since+grace取较早值；不能把当前剩余时间当grace重复扣龄
 *   body(budget) 给定能量预算返回身体，预算不足返回 []；固定身体的请求在预算 ≥ 成本时返回原身体
 *   strategic    队头等待时不被挡（占领 / 援建 / 防御这类一次性投资）
 *   jumpable     自己买不起时不挡同级兄弟，只挡更低的类（外矿：1300 的 reserver 别挡 700 的矿工）
 *   blocking     自己买不起时是否保留能量并挡住后面的非 strategic 请求（默认 true；防御 false）
 *   opportunistic 只在立刻买得起时孵，从不等待（富余 upgrader、scout）
 *   ordered      同级按生产者给的顺序排，而不是按截止时间（防御 / 扩张 / 援建 / 外矿）
 *   reserve      只预留不孵：为即将到期的核心角色替补留住这笔能量（买得起就从预算里扣掉，买不起就当队头等待）
 *   minShare     覆盖 ctx.minShare：缩身下限（容量份额）
 *   minCostShare 缩身下限改按理想身体成本的份额（外矿/援建这类自带分档的需求：0.5 → 1300 的 reserver 可退到 650 的 1 CLAIM，
 *                但 1550 的 hauler 不会缩成 200）；给了就不看容量份额
 *   vital        生存底线（源矿工、第 1 只 hauler、核心替补的能量预留）：它等能量时连 strategic 也挡——线上 W34S7 家里 hauler 死光后
 *                援建请求照样绕过等待把能量花在 W35S7 的 creep 上，收入掉到 5/tick；只有排在它前面的防御不受影响
 */
const { bodyCost } = require('utils');

/** 攒够 delta 能量要多少 tick；income ≤ 0 时永远攒不够 */
function ticksToAfford(delta, income) {
    if (!(delta > 0)) return 0;
    if (!(income > 0)) return Infinity;
    return delta / income;
}

function neededBy(request, since) {
    const graceDeadline = since + Math.max(0, Number(request.grace) || 0);
    return Number.isFinite(request.neededBy) ? Math.min(graceDeadline, request.neededBy) : graceDeadline;
}

/**
 * @param requests 请求数组（生产者顺序即同级默认顺序）
 * @param ctx {now, energy, capacity, income, spawnsFree, busySpawnTimes?:number[], since:{key:tick}, minShare, survivalShrinkAfter}
 * @returns {actions:[{request, body, cost, scaled}], waiting:{key,role,cost,eta,since,neededBy}|null, blocked:[key], reserved:[key]}
 */
function schedule(requests, ctx) {
    const since = ctx.since || {};
    const entries = (requests || []).map((request, seq) => ({
        request,
        seq,
        since: since[request.key] != null ? Number(since[request.key]) : ctx.now,
    }));
    for (const entry of entries) entry.neededBy = neededBy(entry.request, entry.since);
    // 同一优先级里 vital 在前：生存档的底线 upgrader 不是 vital，它先出现就会按截止时间排到后死的第 1 只 hauler 前面，
    // 买不起时再用 blockCore 把 hauler 挡住（基准 61b4caf：W34S7/W31S6 队头 core:upgrader:0 等 1400–2000 tick，房里 0 只 hauler）
    entries.sort((left, right) =>
        (left.request.priority - right.request.priority) ||
        ((right.request.vital ? 1 : 0) - (left.request.vital ? 1 : 0)) ||
        ((left.request.ordered || right.request.ordered) ? 0 : (left.neededBy - right.neededBy)) ||
        (left.seq - right.seq));

    let budget = Number(ctx.energy) || 0;
    /* eslint-disable-next-line no-unused-vars */
    let free = Number(ctx.spawnsFree) || 0;
    const capacity = Number(ctx.capacity) || 0;
    const income = Number(ctx.income) || 0;
    const minShare = ctx.minShare == null ? 0.5 : Number(ctx.minShare);
    const survivalShrinkAfter = ctx.survivalShrinkAfter == null ? Infinity : Number(ctx.survivalShrinkAfter);
    const actions = [];
    const blocked = [];
    const reserved = [];
    let waiting = null;
    // An earlier remote's ordered hauler may precede a due reserver from another room.
    // Collect the whole queue before allowing any hauling action to occupy a spawn.
    const deadlineRequests = entries.map(entry => entry.request).filter(request =>
        request.role === 'reserver' && Number.isFinite(request.neededBy) && !request.opportunistic && !request.reserve);
    // Jumpable hauling may use a refill interval only if it leaves both a spawn slot
    // and enough projected energy for full reserver bodies by their absolute deadlines.
    function safeHaulingAction(request, body, cost) {
        if (request.role !== 'hauler' && request.role !== 'remoteHauler') return true;
        const releases = (ctx.busySpawnTimes || []).filter((ticks) => Number.isFinite(ticks) && ticks >= 0)
            .concat(actions.map((action) => action.body.length * 3), body.length * 3);
        for (let idle = 1; idle < free; idle++) releases.push(0);
        let projected = budget - cost;
        let elapsed = 0;
        // Keep the real queue order, including producer-ordered remote requests.
        for (const pending of deadlineRequests) {
            if (actions.some(action => action.request === pending)) continue;
            if (request.vital || request.priority < pending.priority) continue;
            const remaining = pending.neededBy - ctx.now;
            // If even the fallback is unaffordable after its deadline, do not freeze recovery hauling.
            const currentFallback = pending.body(budget) || [];
            if (remaining < 0 && (!currentFallback.length || bodyCost(currentFallback) > budget)) continue;
            const ideal = pending.body(capacity) || [];
            const idealCost = bodyCost(ideal);
            // The real queue prefers a fully funded body. Prove admission safe with
            // that cost rather than promising a cheaper body the queue may never choose.
            const required = idealCost;
            releases.sort((a, b) => a - b);
            const start = Math.max(elapsed, releases[0],
                elapsed + Math.ceil(ticksToAfford(required - projected, income)));
            if (!ideal.length || start > remaining || required > capacity) return false;
            projected = Math.min(capacity, projected + Math.max(0, income) * (start - elapsed)) - idealCost;
            elapsed = start;
            releases[0] = start + ideal.length * 3;
        }
        return true;
    }
    let blockAll = false;        // 一条 strategic 请求在等：后面的全挡（占领等能量时援建也不插队）
    let blockCore = false;       // 一条核心请求在等：后面的非 strategic 请求被挡，strategic 的穿过去
    let blockBelow = Infinity;   // jumpable 请求在等：只挡优先级数值更大的（更低的类）

    function isEconomyRole(role) {
        return role === 'harvester' || role === 'hauler' || role === 'remoteHarvester' || role === 'remoteHauler';
    }
    for (const entry of entries) {
        if (free <= 0) break;
        const request = entry.request;
        // 10-16 战略猫：凡是 harvester/hauler（含 upgrade:harvester、外矿）都算经济 creep——blockCore / jumpable 的队头都不能把它挡在 upgrader 后面
        const economy = isEconomyRole(request.role);
        // 非 vital 的核心请求在等能量（blockCore）时不挡 vital：生存底线不能排在别人的等待后面
        if (blockAll || (blockCore && !request.strategic && !request.vital && !economy) || (request.priority > blockBelow && !economy)) {
            blocked.push(request.key);
            continue;
        }
        if (request.reserve > 0) {
            if (request.reserve <= budget) {
                budget -= request.reserve;
                reserved.push(request.key);
                continue;
            }
            const reserveEta = ticksToAfford(request.reserve - budget, income);
            if (!waiting) {
                waiting = {
                    key: request.key,
                    role: request.role,
                    cost: request.reserve,
                    eta: Number.isFinite(reserveEta) ? Math.ceil(reserveEta) : null,
                    since: entry.since,
                    neededBy: entry.neededBy,
                };
            }
            if (request.blocking !== false) {
                if (request.vital || request.strategic) blockAll = true;
                else blockCore = true;
            }
            continue;
        }
        const ideal = request.body(capacity) || [];
        if (!ideal.length) continue;
        const idealCost = bodyCost(ideal);
        if (idealCost <= budget) {
            if (!safeHaulingAction(request, ideal, idealCost)) { blocked.push(request.key); continue; }
            actions.push({ request, body: ideal, cost: idealCost, scaled: false });
            budget -= idealCost;
            free--;
            continue;
        }
        if (request.opportunistic) continue;
        const eta = ticksToAfford(idealCost - budget, income);
        let chosen = null;
        if (ctx.now + eta > entry.neededBy) {
            // 截止前攒不够：缩身。收入为 0 是紧急态（hauler / 矿工全灭），有多少用多少；否则至少要有容量的 minShare
            // （请求可自带 minShare：外矿 reserver 的 1 CLAIM 档 650 在 1600 容量下被 800 的下限卡了 300 tick）
            const share = request.minShare != null ? Number(request.minShare) : minShare;
            const byCost = request.minCostShare != null ? idealCost * Number(request.minCostShare) : null;
            // 生存档（vital）等了 survivalShrinkAfter tick 还买不起：收入估计说什么都不再信，按现有能量孵最小可用身体——估计错了也不能让房间等死
            const stuck = !!request.vital && ctx.now - entry.since >= survivalShrinkAfter;
            // 收入为 0 的"有多少用多少"只给 vital（hauler/矿工全灭的紧急态）：非 vital 的请求在那时缩成最小身体，只会占住槽位 1500 tick——
            // 线上 2026-09-11 W33S7 的第 2 只 hauler 位被 200 能量的 2C2M 占住、builder 成了 1W1C1M，真正的替补再也排不上
            const floor = (income > 0 || !request.vital) && !stuck ? (byCost != null ? Math.min(idealCost, byCost) : Math.min(idealCost, capacity * share)) : 0;
            if (budget >= floor) {
                const scaled = request.body(budget) || [];
                const cost = scaled.length ? bodyCost(scaled) : Infinity;
                if (scaled.length && cost <= budget) chosen = { body: scaled, cost };
            }
        }
        if (chosen) {
            if (!safeHaulingAction(request, chosen.body, chosen.cost)) { blocked.push(request.key); continue; }
            actions.push({ request, body: chosen.body, cost: chosen.cost, scaled: true });
            budget -= chosen.cost;
            free--;
            continue;
        }
        if (!waiting) {
            waiting = {
                key: request.key,
                role: request.role,
                cost: idealCost,
                eta: Number.isFinite(eta) ? Math.ceil(eta) : null,
                since: entry.since,
                neededBy: entry.neededBy,
            };
        }
        if (request.blocking !== false) {
            if (request.vital) blockAll = true;
            // 10-16 战略猫：队头非经济 creep 等了 ≥200 tick，让后面更便宜的经济 creep 插队（不再 blockCore）
            else if (request.jumpable || (ctx.now - entry.since >= 200 &&
                (request.role === 'upgrader' || request.role === 'builder' || request.role === 'labTech' || request.role === 'scout'))) {
                blockBelow = Math.min(blockBelow, request.priority);
            } else if (request.strategic) blockAll = true;
            else blockCore = true;
        }
    }
    return { actions, waiting, blocked, reserved };
}

module.exports = { schedule, ticksToAfford };
