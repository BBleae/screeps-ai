'use strict';

const DIRS = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];
const DIR_CODE = [1, 2, 3, 4, 5, 6, 7, 8];

function cheby(ax, ay, bx, by) {
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function dirBetween(fx, fy, tx, ty) {
    const dx = Math.sign(tx - fx);
    const dy = Math.sign(ty - fy);
    for (let i = 0; i < DIRS.length; i++) {
        if (DIRS[i][0] === dx && DIRS[i][1] === dy) return DIR_CODE[i];
    }
    return 0;
}

function onEdge(x, y) {
    return x === 0 || x === 49 || y === 0 || y === 49;
}

function healPlan(leader, follower, inTowerRange) {
    const cands = [];
    if (leader) cands.push(leader);
    if (follower) cands.push(follower);
    const hurt = cands.filter((c) => c.hits < c.hitsMax);
    let target = null;
    if (hurt.length) {
        hurt.sort((a, b) => (a.hits / a.hitsMax) - (b.hits / b.hitsMax));
        target = hurt[0];
    } else if (inTowerRange && leader) {
        target = leader;
    } else {
        target = follower || leader;
    }
    if (!target) return null;
    const d = cheby(follower.x, follower.y, target.x, target.y);
    if (target.room !== follower.room) return { kind: 'none', target: null };
    if (d <= 1) return { kind: 'heal', target };
    if (d <= 3) return { kind: 'rangedHeal', target };
    return { kind: 'none', target };
}

function planPairStep(st) {
    const leader = st.leader;
    const follower = st.follower;
    const out = { leaderMove: 0, followerMove: 0, heal: null, leaderHold: false };

    out.heal = healPlan(leader, follower, !!st.inTowerRange);

    if (!leader || !follower) return out;
    if (leader.room !== follower.room) {
        if (st.followerNextRoom === leader.room && typeof st.followerToward === 'number') {
            out.followerMove = st.followerToward;
        } else if (typeof st.followerToLeaderDir === 'number') {
            out.followerMove = st.followerToLeaderDir;
        }
        out.leaderHold = true;
        return out;
    }

    const adjacent = cheby(leader.x, leader.y, follower.x, follower.y) <= 1;
    const bothRested = (leader.fatigue || 0) === 0 && (follower.fatigue || 0) === 0;
    const atDest = !!st.leaderAtDest;

    if (atDest) {
        out.leaderHold = true;
        if (!adjacent && typeof st.followerToLeaderDir === 'number') out.followerMove = st.followerToLeaderDir;
        return out;
    }

    const leaderNext = st.leaderNext;
    const crossingExit = !!leaderNext && onEdge(leaderNext.x, leaderNext.y);

    if (!adjacent || !bothRested) {
        out.leaderHold = true;
        if ((follower.fatigue || 0) === 0 && typeof st.followerToLeaderDir === 'number') {
            out.followerMove = st.followerToLeaderDir;
        }
        return out;
    }

    if (crossingExit && !st.followerCanReachEdge) {
        out.leaderHold = true;
        if (typeof st.followerToLeaderDir === 'number') out.followerMove = st.followerToLeaderDir;
        return out;
    }

    if (leaderNext) {
        out.leaderMove = dirBetween(leader.x, leader.y, leaderNext.x, leaderNext.y);
        out.followerMove = dirBetween(follower.x, follower.y, leader.x, leader.y);
        if (out.followerMove === 0 && typeof st.followerToLeaderDir === 'number') out.followerMove = st.followerToLeaderDir;
    }
    return out;
}

module.exports = { planPairStep, healPlan, dirBetween, cheby, onEdge, DIRS, DIR_CODE };
