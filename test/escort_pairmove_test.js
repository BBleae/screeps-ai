'use strict';
const assert = require('assert');
const path = require('path');
const esc = require(path.resolve(__dirname, '../src/roles/escort.js'));

function cheby(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

function step(a, b) {
    const pts = [];
    let x = a[0], y = a[1];
    while (x !== b[0] || y !== b[1]) {
        x += Math.sign(b[0] - x);
        y += Math.sign(b[1] - y);
        pts.push([x, y]);
    }
    return pts;
}

function fill(waypoints) {
    const out = [waypoints[0]];
    for (let i = 1; i < waypoints.length; i++) for (const p of step(waypoints[i - 1], waypoints[i])) out.push(p);
    return out;
}

function tagRoom(room, waypoints, swampSet) {
    return fill(waypoints).map(([x, y]) => ({ room, x, y, swamp: !!(swampSet && swampSet.has(x + ',' + y)) }));
}

function makeRoute() {
    let r = [];
    r = r.concat(tagRoom('W38S1', [[25, 40], [25, 49]]));
    r = r.concat(tagRoom('W38S0', [[25, 0], [25, 4], [30, 12], [45, 30], [45, 49]], new Set(['27,6', '28,7', '29,8', '30,9'])));
    r = r.concat(tagRoom('W39S0', [[45, 0], [40, 10], [30, 30], [26, 49]]));
    const claimer = [[26, 0], [28, 2], [30, 4], [36, 10], [36, 26], [32, 30]];
    r = r.concat(tagRoom('W39S1', claimer, new Set(['34,8', '35,9', '36,10'])));
    return r;
}

function makeAttackerRoute() {
    return tagRoom('W39S1', [[26, 0], [28, 2], [30, 4], [25, 8], [19, 10], [16, 11], [15, 11]], new Set(['27,5', '26,6', '25,8']));
}

const TOWERS = { S: [16, 12], N: [14, 4] };
function towerDmg(d) { if (d <= 5) return 600; if (d >= 20) return 150; return Math.round(600 - (600 - 150) * (d - 5) / 15); }
function tileTowerDmg(room, x, y) {
    if (room !== 'W39S1') return 0;
    let s = 0;
    for (const k of Object.keys(TOWERS)) s += towerDmg(Math.max(Math.abs(x - TOWERS[k][0]), Math.abs(y - TOWERS[k][1])));
    return s;
}

function simPair(route, leaderParts, followerParts, healPerTick, label) {
    const L = { nonMove: leaderParts.nonMove, move: leaderParts.move, idx: 0, fatigue: 0, hits: 1000, hitsMax: 1000 };
    const F = { nonMove: followerParts.nonMove, move: followerParts.move, idx: 0, fatigue: 0, hits: 2500, hitsMax: 2500 };
    let worst = 0;
    let healMisses = 0;
    let towerTicks = 0;
    let entryTicks = 0;
    let transitionSlack = 0;
    const maxTicks = route.length * 6 + 50;
    for (let tick = 0; tick < maxTicks; tick++) {
        const lt = route[L.idx], ft = route[F.idx];
        const sameRoom = lt.room === ft.room;
        const leaderPos = { x: lt.x, y: lt.y, room: lt.room, fatigue: L.fatigue, hits: L.hits, hitsMax: L.hitsMax };
        const followerPos = { x: ft.x, y: ft.y, room: ft.room, fatigue: F.fatigue, hits: F.hits, hitsMax: F.hitsMax };
        const lnext = route[L.idx + 1] || null;
        const leaderNext = lnext ? { x: lnext.x, y: lnext.y } : null;
        const towerHere = tileTowerDmg(lt.room, lt.x, lt.y) > 0;
        const st = {
            leader: leaderPos, follower: followerPos, leaderNext,
            leaderAtDest: L.idx >= route.length - 1,
            inTowerRange: towerHere,
            followerToLeaderDir: sameRoom ? esc.dirBetween(ft.x, ft.y, lt.x, lt.y) : 2,
            followerCanReachEdge: (L.idx - F.idx) <= 1,
            followerNextRoom: lnext && !sameRoom ? lt.room : null,
            followerToward: 2,
        };
        const plan = esc.planPairStep(st);

        if (towerHere) {
            const bothInRoom = lt.room === ft.room;
            if (bothInRoom) {
                towerTicks++;
                if (!plan.heal || plan.heal.kind === 'none' || !plan.heal.target) healMisses++;
            } else {
                entryTicks++;
            }
            const net = Math.max(0, tileTowerDmg(lt.room, lt.x, lt.y) - (bothInRoom ? healPerTick : 0));
            L.hits = L.hits - net;
            assert.ok(L.hits > 0, label + ': leader died under tower fire at tick ' + tick + ' pos ' + lt.x + ',' + lt.y);
            if (L.hits < L.hitsMax && bothInRoom) L.hits = Math.min(L.hitsMax, L.hits + healPerTick);
        }

        const leaderCanMove = !plan.leaderHold && plan.leaderMove !== 0 && L.fatigue === 0 && L.idx < route.length - 1;
        const followerCanMove = plan.followerMove !== 0 && F.fatigue === 0 && F.idx < L.idx;
        if (leaderCanMove) {
            L.idx++;
            const t = route[L.idx];
            L.fatigue = L.nonMove * (t.swamp ? 5 : 1);
        } else {
            L.fatigue = Math.max(0, L.fatigue - L.move * 2);
        }
        if (followerCanMove) {
            F.idx++;
            const t = route[F.idx];
            F.fatigue = F.nonMove * (t.swamp ? 5 : 1);
        } else {
            F.fatigue = Math.max(0, F.fatigue - F.move * 2);
        }

        const idxGap = L.idx - F.idx;
        if (idxGap > worst) worst = idxGap;
        assert.ok(idxGap <= 2, label + ': route-index gap ' + idxGap + ' > 2 at tick ' + tick);
        const la = route[L.idx], fa = route[F.idx];
        if (la.room === fa.room && idxGap <= 1) {
            const d = cheby(la, fa);
            assert.ok(d <= 2, label + ': in-room spatial gap ' + d + ' > 2 at tick ' + tick);
        } else {
            transitionSlack++;
        }
        if (L.idx >= route.length - 1 && F.idx >= L.idx - 1) break;
    }
    assert.ok(L.idx >= route.length - 1, label + ': leader did not reach destination (idx ' + L.idx + '/' + (route.length - 1) + ')');
    assert.strictEqual(healMisses, 0, label + ': missed heal on ' + healMisses + '/' + towerTicks + ' tower-range ticks');
    return { worst, towerTicks, healMisses, transitionSlack, entryTicks };
}

let pass = 0;
function ok(n) { console.log('OK ' + n); pass++; }

(function claimerPair() {
    const route = makeRoute();
    const r = simPair(route, { nonMove: 5, move: 5 }, { nonMove: 25, move: 25 }, 720, 'claimer+healerA');
    assert.ok(r.worst <= 1, 'claimer pair in-room worst gap <=1, got ' + r.worst);
    ok('claimer + healerA: full route W38S1->W38S0->W39S0->W39S1 + breach->controller, healer in range1 and heals 100% of tower ticks (' + r.towerTicks + '), worst in-room gap ' + r.worst);
})();

(function attackerPair() {
    const route = makeAttackerRoute();
    const r = simPair(route, { nonMove: 25, move: 25 }, { nonMove: 25, move: 25 }, 720, 'attacker+healerB');
    assert.ok(r.worst <= 1, 'attacker pair worst gap <=1, got ' + r.worst);
    ok('attacker + healerB: breach->south-tower approach incl. swamp, healer range1, heals 100% of tower ticks (' + r.towerTicks + '), worst gap ' + r.worst);
})();

(function blockedLeaderHolds() {
    const leader = { x: 20, y: 20, room: 'W39S1', fatigue: 0, hits: 1000, hitsMax: 1000 };
    const follower = { x: 23, y: 20, room: 'W39S1', fatigue: 0, hits: 2500, hitsMax: 2500 };
    const plan = esc.planPairStep({ leader, follower, leaderNext: { x: 19, y: 20 }, leaderAtDest: false, inTowerRange: true, followerToLeaderDir: esc.dirBetween(23, 20, 20, 20), followerCanReachEdge: false });
    assert.strictEqual(plan.leaderHold, true, 'leader holds when follower is not adjacent');
    assert.notStrictEqual(plan.followerMove, 0, 'follower moves to close the gap');
    assert.ok(plan.heal && plan.heal.kind !== 'none', 'still heals/pre-heals while regrouping in tower range');
    assert.strictEqual(plan.heal.kind, 'rangedHeal', 'pre-heals via rangedHeal at range 3 while regrouping');
    ok('blocked/behind: leader HOLDS until follower adjacent (no outrunning under tower fire), follower closes gap, pre-heals at range<=3');
})();

(function fatigueGate() {
    const leader = { x: 20, y: 20, room: 'W39S1', fatigue: 0, hits: 1000, hitsMax: 1000 };
    const follower = { x: 21, y: 20, room: 'W39S1', fatigue: 10, hits: 2500, hitsMax: 2500 };
    const plan = esc.planPairStep({ leader, follower, leaderNext: { x: 19, y: 20 }, leaderAtDest: false, inTowerRange: true, followerToLeaderDir: 6, followerCanReachEdge: true });
    assert.strictEqual(plan.leaderHold, true, 'leader waits when follower has fatigue (swamp desync)');
    ok('fatigue sync: leader waits a tick when follower is fatigued (swamp), preventing separation');
})();

(function exitSync() {
    const leader = { x: 25, y: 48, room: 'W38S0', fatigue: 0, hits: 1000, hitsMax: 1000 };
    const follower = { x: 25, y: 46, room: 'W38S0', fatigue: 0, hits: 2500, hitsMax: 2500 };
    const plan = esc.planPairStep({ leader, follower, leaderNext: { x: 25, y: 49 }, leaderAtDest: false, inTowerRange: false, followerToLeaderDir: 1, followerCanReachEdge: false });
    assert.strictEqual(plan.leaderHold, true, 'leader does not cross the room exit until follower can reach the edge together');
    ok('exit sync: leader will not cross a room boundary alone; waits for the follower at the edge');
})();

console.log('ALL ESCORT PAIR-MOVE TESTS PASSED (' + pass + ')');
