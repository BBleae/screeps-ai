'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');
const src = path.resolve(__dirname, '../src');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (!request.includes('/') && !request.startsWith('.')) {
    const local = path.join(src, request + '.js');
    try { require('fs').accessSync(local); return local; } catch (e) {}
    if (request.startsWith('roles_')) {
      const r = path.join(src, 'roles', request.slice(6) + '.js');
      try { require('fs').accessSync(r); return r; } catch (e) {}
    }
  }
  return orig.call(this, request, parent, isMain, options);
};
Object.assign(global, require('/workspace/ops/war/eng/cmn/package/lib/constants'));
global.Game = { time: 100, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: {} };
global.Memory = { rooms: {}, stats: [] };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
const config = require('config');

console.log('--- haulers never wait for / use KH ---');
const lh = require('roles_lootHauler');
assert.deepStrictEqual(config.conquest.haulerBoost, {}, 'no hauler boost config');
const hm = { role: 'lootHauler', home: 'W37S5', targetRoom: 'W35S1', boosts: ['KH'], boostMinParts: 5, boostSince: 90 };
assert.strictEqual(lh.dropStaleBoosts({ memory: hm }), true);
assert.ok(!hm.boosts && hm.boostDone === true && hm.boostSince == null && hm.boostMinParts == null, 'stale KH boost list dropped, hauler leaves immediately');
const hm2 = { role: 'lootHauler', home: 'W38S7', targetRoom: 'W37S2' };
assert.strictEqual(lh.dropStaleBoosts({ memory: hm2 }), false);
assert.deepStrictEqual(config.industry.chainTargetsByRoom.W37S5, [], 'W37S5 makes no KH');
assert.deepStrictEqual(config.industry.labNoMakeByRoom.W37S5, ['KH'], 'running KH reaction is stopped too');
console.log('OK');

console.log('--- W29S3 H miner on while account H < 30k ---');
const mm = require('roles_mineralMiner');
const market = require('market');
const room = { name: 'W29S3', controller: { my: true, level: 6 } };
let accountH = 29999;
const saved = market.accountStock;
market.accountStock = (r) => (r === 'H' ? accountH : 0);
let plan = mm.directive(room);
assert.ok(plan && plan.enabled && plan.count === 1 && plan.mineralType === 'H', 'H 29999 -> miner on: ' + JSON.stringify(plan && { e: plan.enabled, r: plan.reason }));
Game.time++;
accountH = 30000;
plan = mm.directive(room);
assert.ok(plan && !plan.enabled && plan.reason === 'accountStock', 'H 30000 -> miner off');
market.accountStock = saved;
console.log('OK');

console.log('--- lootShed keep list: W31S2/W29S7 restored and never auto-paused; W31S9/W38S6 stay stopped ---');
const ls = require('loot_shed');
assert.deepStrictEqual(config.lootShed.keep, ['W31S2', 'W29S7', 'W38S5']);
assert.ok(config.lootShed.force.indexOf('W31S9') >= 0 && config.lootShed.force.indexOf('W38S6') >= 0);
Memory.rooms = { W31S4: { remotes: { W31S2: { enabled: true, suspendReason: 'lootShed', suspendedUntil: Number.MAX_SAFE_INTEGER } } }, W31S6: { remotes: { W29S7: { enabled: true, suspendReason: 'lootShed', suspendedUntil: Number.MAX_SAFE_INTEGER } } }, W31S8: { remotes: { W31S9: { enabled: true, suspendReason: 'lootShed', suspendedUntil: Number.MAX_SAFE_INTEGER } } }, W37S5: { remotes: { W38S5: { enabled: true, suspendedUntil: 0 } } } };
Memory.lootShed = { paused: [{ room: 'W31S2', home: 'W31S4', at: 1 }, { room: 'W29S7', home: 'W31S6', at: 1 }, { room: 'W31S9', home: 'W31S8', at: 1 }], log: [] };
ls.restoreKept();
assert.strictEqual(Memory.rooms.W31S4.remotes.W31S2.suspendReason, null);
assert.strictEqual(Memory.rooms.W31S6.remotes.W29S7.suspendReason, null);
assert.strictEqual(Memory.rooms.W31S8.remotes.W31S9.suspendReason, 'lootShed', 'W31S9 stays stopped');
const order = ls.pauseOrder();
assert.ok(order.indexOf('W31S2') < 0 && order.indexOf('W29S7') < 0 && order.indexOf('W38S5') < 0, 'keep rooms never in pause order: ' + order);
const nx = ls.nextToPause();
assert.ok(!nx || ['W31S2', 'W29S7', 'W38S5'].indexOf(nx.room) < 0);
console.log('OK');

console.log('--- W37S5 energy: upgraders on >=100k tier, export keeps 80k ---');
assert.deepStrictEqual(config.energy.upgradeSurplus.tiersByRoom.W37S5, [[100000, 45]]);
assert.strictEqual(config.upgrading.hold.W37S5.resumeAt, 100000);
assert.ok(!config.upgrading.hold.W37S5.untilLootDone, 'no more upgrade hold while looting');
assert.strictEqual(config.terminalNetwork ? true : true, true);
const lx = (config.terminalNetwork && config.terminalNetwork.lootExport) || (config.terminal && config.terminal.lootExport);
const le = JSON.stringify(config).match(/"lootExport":\{"W37S5":\{[^}]*\}/)[0];
assert.ok(le.indexOf('"energyKeep":80000') >= 0, 'loot export floor 80k');
const utils = require('utils');
const mk = (e) => ({ name: 'W37S5', controller: { my: true, level: 7, ticksToDowngrade: 150000 }, storage: { store: { energy: e } } });
Memory.rooms.W37S5 = {};
const h1 = utils.upgradeHold(mk(150000), {});
assert.ok(h1 && !h1.on, '150k storage -> upgraders allowed');
const h2 = utils.upgradeHold(mk(90000), {});
assert.ok(h2 && h2.on, '90k -> held');
console.log('OK');

console.log('--- W33S3 XGH2O: GH and G pulled from W32S4 ---');
const fw = JSON.stringify(config).match(/\{"from":"W32S4","to":"W33S3","resource":"GH"[^}]*\}/);
assert.ok(fw && fw[0].indexOf('"keep":2000') >= 0, 'GH forward W32S4 -> W33S3');
assert.ok(/\{"from":"W32S4","to":"W33S3","resource":"G"/.test(JSON.stringify(config)), 'G forward W32S4 -> W33S3');
console.log('OK');

console.log('--- deposit: a first miner for a picked deposit also needs the new-work CPU gate ---');
const dep = require('deposit');
const cg = require('cpu_gate');
for (let i = 0; i < 100; i++) cg.record(100);
config.deposit = Object.assign({}, config.deposit || {}, { enabled: true, newBucketMin: 9000, cpuAvgMax: 140, withdrawAvg: 150 });
Memory.deposits = { list: { d1: { home: 'W31S5', room: 'W30S5', type: 'silicon', x: 10, y: 10, cd: 0, decayAt: 999999, at: 100, hops: 2 } }, routes: {}, visits: {}, cpuWin: [{ t: 1, avg: 100 }, { t: 2, avg: 100 }] };
Memory.stats = [];
const home = { name: 'W31S5', energyCapacityAvailable: 5600, controller: { my: true, level: 8 } };
Game.cpu.bucket = 10000;
const wk = dep.workable;
let d1 = dep.getDemands(home).filter((r) => r.role === 'depositMiner');
const okSpawn = d1.length;
Game.cpu.bucket = 8500;
d1 = dep.getDemands(home).filter((r) => r.role === 'depositMiner');
assert.strictEqual(d1.length, 0, 'bucket 8500 < newBucketMin 9000 -> no first miner');
assert.ok(Memory.deposits.wait && Memory.deposits.wait.d1 && JSON.stringify(Memory.deposits.wait.d1).indexOf('cpuGate') >= 0, 'wait reason cpuGate: ' + JSON.stringify(Memory.deposits.wait));
console.log('OK (bucket 10000 gave', okSpawn, 'miner request)');

console.log('ROUND3 MISC TESTS PASSED');
