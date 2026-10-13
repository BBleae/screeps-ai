'use strict';
/**
 * Overmind 0.5.2（bencbartlett/Overmind @ 5eca49a）战斗可见性 / safe mode / 塔开火的纯函数复刻。
 * 2019 的 TS 在本机 node 20 + 现代 @types 下编不过（tsc 2.9 撞 console / undici），所以演习用这份而不是原仓库。
 *
 * 对照：
 * - src/prototypes/Room.ts dangerousPlayerHostiles / dangerousHostiles
 * - src/Overseer.ts handleSafeMode / handleOutpostDefense
 * - src/hiveClusters/sporeCrawler.ts tower targeting
 *
 * 线上 Celr creep 名是 next_<role>_<tick>_SpawnN，角色词 miner/queen/transport/remoteMiner
 * 是 Overmind 词表（vanilla hatchery 是 role_i）。当 Overmind 用。
 */

function active(creep, type) {
    return (creep.body || []).some((p) => {
        const t = p.type || p;
        const hits = p.hits;
        return t === type && (hits === undefined || hits > 0);
    });
}

/** Room.prototype.dangerousPlayerHostiles（己方房）：ATTACK / WORK / RANGED_ATTACK / HEAL */
function dangerousPlayerHostiles(creeps) {
    return (creeps || []).filter((c) => active(c, 'attack') || active(c, 'work') ||
        active(c, 'ranged_attack') || active(c, 'heal'));
}

/** 外矿 dangerousHostiles：不算 WORK（Overmind 在非己方房里不把 WORK 当危险） */
function dangerousHostilesInOutpost(creeps) {
    return (creeps || []).filter((c) => active(c, 'attack') || active(c, 'ranged_attack') || active(c, 'heal'));
}

/**
 * Overseer.handleSafeMode：Larva+公开服直接 return。
 * 否则 (spawn/storage/terminal 掉血 且 危险玩家 2 格内) 或 (危险玩家能走到 spawn)。
 * 纯 CLAIM/MOVE/TOUGH 不在 dangerousPlayerHostiles 里 → 不触发。
 */
function shouldSafeMode({ stage, onPublic, criticalHurt, hostileNearCritical, hostileCanReachSpawn }) {
    if (stage === 'larva' && onPublic) return false;
    if (criticalHurt && hostileNearCritical) return true;
    if (hostileCanReachSpawn) return true;
    return false;
}

function outpostDefenseTriggered(playerHostiles) {
    return dangerousPlayerHostiles(playerHostiles).length > 0;
}

/**
 * sporeCrawler：damageTaken * multiplier > avgHealing 才打。
 * 无 HEAL 的 CLAIM 的 avgHealing=0，塔会打（W39S8 单塔，CLAIM 会被打死；W38S9 无塔）。
 */
function towerWouldShoot({ towerDamage, creepDamage, damageMultiplier, avgHealing }) {
    const damageTaken = (Number(towerDamage) || 0) + (Number(creepDamage) || 0);
    const mult = damageMultiplier == null ? 1 : Number(damageMultiplier);
    return damageTaken * mult > (Number(avgHealing) || 0);
}

module.exports = {
    dangerousPlayerHostiles,
    dangerousHostilesInOutpost,
    shouldSafeMode,
    outpostDefenseTriggered,
    towerWouldShoot,
    active,
};
