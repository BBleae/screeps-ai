'use strict';
const { bodyCost } = require('utils');

function ticksToAfford(delta, income) {
    if (!(delta > 0)) return 0;
    if (!(income > 0)) return Infinity;
    return delta / income;
}

function neededBy(request, since) {
    const graceDeadline = since + Math.max(0, Number(request.grace) || 0);
    return Number.isFinite(request.neededBy) ? Math.min(graceDeadline, request.neededBy) : graceDeadline;
}

function schedule(requests, ctx) {
    const since = ctx.since || {};
    const entries = (requests || []).map((request, seq) => ({
        request,
        seq,
        since: since[request.key] != null ? Number(since[request.key]) : ctx.now,
    }));
    for (const entry of entries) entry.neededBy = neededBy(entry.request, entry.since);
    entries.sort((left, right) =>
        (left.request.priority - right.request.priority) ||
        ((right.request.vital ? 1 : 0) - (left.request.vital ? 1 : 0)) ||
        ((left.request.ordered || right.request.ordered) ? 0 : (left.neededBy - right.neededBy)) ||
        (left.seq - right.seq));

    let budget = Number(ctx.energy) || 0;
    let free = Number(ctx.spawnsFree) || 0;
    const capacity = Number(ctx.capacity) || 0;
    const income = Number(ctx.income) || 0;
    const minShare = ctx.minShare == null ? 0.5 : Number(ctx.minShare);
    const survivalShrinkAfter = ctx.survivalShrinkAfter == null ? Infinity : Number(ctx.survivalShrinkAfter);
    const actions = [];
    const blocked = [];
    const reserved = [];
    let waiting = null;
    const deadlineRequests = entries.map(entry => entry.request).filter(request =>
        request.role === 'reserver' && Number.isFinite(request.neededBy) && !request.opportunistic && !request.reserve);
    function safeHaulingAction(request, body, cost) {
        if (request.role !== 'hauler' && request.role !== 'remoteHauler') return true;
        const releases = (ctx.busySpawnTimes || []).filter((ticks) => Number.isFinite(ticks) && ticks >= 0)
            .concat(actions.map((action) => action.body.length * 3), body.length * 3);
        for (let idle = 1; idle < free; idle++) releases.push(0);
        let projected = budget - cost;
        let elapsed = 0;
        for (const pending of deadlineRequests) {
            if (actions.some(action => action.request === pending)) continue;
            if (request.vital || request.priority < pending.priority) continue;
            const remaining = pending.neededBy - ctx.now;
            const currentFallback = pending.body(budget) || [];
            if (remaining < 0 && (!currentFallback.length || bodyCost(currentFallback) > budget)) continue;
            const ideal = pending.body(capacity) || [];
            const idealCost = bodyCost(ideal);
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
    let blockAll = false;
    let blockCore = false;
    let blockBelow = Infinity;

    function isEconomyRole(role) {
        return role === 'harvester' || role === 'hauler' || role === 'remoteHarvester' || role === 'remoteHauler';
    }
    for (const entry of entries) {
        if (free <= 0) break;
        const request = entry.request;
        const economy = isEconomyRole(request.role);
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
            const share = request.minShare != null ? Number(request.minShare) : minShare;
            const byCost = request.minCostShare != null ? idealCost * Number(request.minCostShare) : null;
            const stuck = !!request.vital && ctx.now - entry.since >= survivalShrinkAfter;
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
