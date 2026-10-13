'use strict';
const assert = require('assert');
const mimic = require('../scripts/private_server/overmind_mimic');

function creep(body) {
    return { body: body.map((type) => ({ type, hits: 100 })) };
}

const claimer = creep(['claim', 'move', 'claim', 'move']);
const toughClaim = creep(['tough', 'tough', 'claim', 'move']);
const dismantler = creep(['work', 'move']);
const guard = creep(['ranged_attack', 'heal', 'move', 'move']);
const miner = creep(['work', 'work', 'carry', 'move']);

assert.strictEqual(mimic.dangerousPlayerHostiles([claimer, toughClaim]).length, 0, '纯 CLAIM/TOUGH 对 Overmind 隐形');
assert.strictEqual(mimic.dangerousPlayerHostiles([dismantler, guard]).length, 2, 'WORK 与护卫可见');
assert.strictEqual(mimic.dangerousHostilesInOutpost([miner]).length, 0, '外矿里 WORK 矿工不算 dangerousHostiles');
assert.strictEqual(mimic.dangerousHostilesInOutpost([guard]).length, 1, '外矿里护卫算 dangerousHostiles');

assert.strictEqual(mimic.shouldSafeMode({
    stage: 'pupa', onPublic: true, criticalHurt: false, hostileNearCritical: false, hostileCanReachSpawn: false,
}), false, '只有 CLAIM 在场（无危险玩家）不开盾');
assert.strictEqual(mimic.shouldSafeMode({
    stage: 'pupa', onPublic: true, criticalHurt: false, hostileNearCritical: false, hostileCanReachSpawn: true,
}), true, '危险玩家能走到 spawn → 开盾（W39S8 无墙）');
assert.strictEqual(mimic.shouldSafeMode({
    stage: 'larva', onPublic: true, criticalHurt: true, hostileNearCritical: true, hostileCanReachSpawn: true,
}), false, 'Larva 公开服 handleSafeMode 直接 return');

assert.strictEqual(mimic.outpostDefenseTriggered([claimer]), false, 'CLAIM 不触发外矿 DirectiveOutpostDefense');
assert.strictEqual(mimic.outpostDefenseTriggered([guard]), true, '护卫触发外矿防御');

assert.strictEqual(mimic.towerWouldShoot({ towerDamage: 450, creepDamage: 0, avgHealing: 0 }), true,
    '无治疗的 CLAIM 会被塔打（W39S8）');
assert.strictEqual(mimic.towerWouldShoot({ towerDamage: 0, creepDamage: 0, avgHealing: 0 }), false,
    '无塔的 W38S9：伤害 0，不打');

console.log('overmind_mimic_test ok');
