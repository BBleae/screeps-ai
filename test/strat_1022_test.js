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

console.log('--- W38S6 out of remote planning, W31S9 still held by lootShed ---');
{
  const remote = require('remote');
  assert.ok(remote.cededRoom('W38S6'), 'W38S6 ceded');
  assert.ok(config.remote.ceded.indexOf('W36S7') >= 0 && config.remote.ceded.indexOf('W39S6') >= 0, 'old ceded kept');
  const ls = config.lootShed;
  for (const k of ['prefer', 'force', 'holdRooms', 'restoreLogRooms']) assert.ok((ls[k] || []).indexOf('W38S6') < 0, 'lootShed.' + k + ' has no W38S6');
  assert.ok(ls.force.indexOf('W31S9') >= 0, 'W31S9 still forced paused');
  assert.ok(ls.keep.indexOf('W31S9') < 0, 'W31S9 not kept');
  const unlock = config.wallBreach.unlock.W37S5.rooms.map((e) => e.room);
  assert.deepStrictEqual(unlock, ['W38S4'], 'W38S6 not unlocked as a remote');
  Memory.wallBreach = { done: { 'W38S5:38:18': 1, 'W38S6:30:21': 1, 'W38S6:30:22': 1, 'W38S6:30:23': 1 }, measured: { W37S5: { W38S4: { ok: true }, W38S6: { ok: true } } } };
  assert.ok(require('wall_breach').unlockedRemotes('W37S5').indexOf('W38S6') < 0, 'measured W38S6 no longer whitelisted');
  const home = { name: 'W37S5', controller: { my: true, level: 7 } };
  Memory.rooms.W37S5 = { remotes: { W38S6: { enabled: true, suspendReason: 'lootShed', suspendedUntil: Number.MAX_SAFE_INTEGER }, W38S5: { enabled: true, suspendedUntil: 0 } } };
  try { remote.run(home); } catch (e) { }
  assert.ok(!Memory.rooms.W37S5.remotes.W38S6, 'W38S6 record dropped from W37S5 remotes');
  Memory.lootShed = { paused: [{ room: 'W38S6', home: 'W37S5', at: 1 }], log: [] };
  require('loot_shed').restoreKept && require('loot_shed').restoreKept();
  assert.ok(!Memory.rooms.W37S5.remotes.W38S6, 'lootShed restore does not bring W38S6 back');
  console.log('OK');
}

console.log('--- priorityReceivers: no W37S5/W38S7, RCL8 rooms filtered ---');
{
  const pr = config.terminalNetwork.priorityReceivers;
  assert.ok(pr.indexOf('W37S5') < 0 && pr.indexOf('W38S7') < 0 && pr.indexOf('W32S4') < 0, JSON.stringify(pr));
  const sp = require('fs').readFileSync(path.resolve(__dirname, '../scripts/brain/strategy-params.json'), 'utf8');
  const j = JSON.parse(sp);
  assert.ok(j.energy.priorityReceivers.indexOf('W37S5') < 0 && j.energy.priorityReceivers.indexOf('W38S7') < 0 && j.energy.priorityReceivers.indexOf('W32S4') < 0);
  assert.ok(j.remotes.removed && j.remotes.removed.W38S6, 'strategy-params records W38S6 removed');
  const term = require('terminal');
  const saved = config.terminalNetwork.priorityReceivers;
  config.terminalNetwork.priorityReceivers = ['W32S4', 'W33S3'];
  Game.rooms = { W32S4: { name: 'W32S4', controller: { my: true, level: 8 } }, W33S3: { name: 'W33S3', controller: { my: true, level: 7 } } };
  assert.deepStrictEqual(term.priorityList(), ['W33S3'], 'RCL8 W32S4 dropped even if listed');
  config.terminalNetwork.priorityReceivers = saved;
  console.log('OK');
}

console.log('--- W32S4 at RCL8: XGH2O chain, labs up to 10, upgrader <= 15 WORK ---');
{
  const utils = require('utils');
  const W32S4 = { name: 'W32S4', controller: { my: true, level: 7 }, storage: { my: true, store: { energy: 900000 } }, energyCapacityAvailable: 5600, find: () => [] };
  Game.rooms = { W32S4 };
  const before = JSON.stringify(config.industry.chainTargetsByRoom.W32S4);
  utils.applyRcl8Auto();
  assert.strictEqual(JSON.stringify(config.industry.chainTargetsByRoom.W32S4), before, 'RCL7: unchanged');
  W32S4.controller.level = 8;
  utils.applyRcl8Auto();
  assert.deepStrictEqual(config.industry.chainTargetsByRoom.W32S4, ['XGH2O', 'GH2O']);
  assert.ok(config.industry.labNoMakeByRoom.W32S4.indexOf('G') >= 0);
  assert.ok(config.industry.labRooms.indexOf('W32S4') >= 0 && config.industry.labRooms.indexOf('W33S3') >= 0);
  assert.ok(utils.lowRoomAllowed('W32S4', true), 'W32S4 labs allowed');
  assert.ok(!utils.lowRoomAllowed('W38S7', true), 'W38S7 stays out of lab-site rooms');
  Memory.rooms.W32S4 = {};
  const w = utils.upgraderSupplyWork(W32S4, Memory.rooms.W32S4);
  assert.ok(w != null && w <= 15, 'RCL8 upgrade work cap 15, got ' + w);
  console.log('OK');
}

console.log('--- W38S7 -> W33S3 G forward exists ---');
{
  const rule = config.terminalNetwork.forward.find((r) => r.from === 'W38S7' && r.to === 'W33S3' && r.resource === 'G');
  assert.ok(rule && rule.toBelow >= 1000, JSON.stringify(rule));
  console.log('OK');
}

console.log('--- deposit hold: last two raw avg10 readings > 150 stop miners even right after a deploy ---');
{
  const dep = require('deposit');
  const cg = require('cpu_gate');
  cg.reset();
  for (let i = 0; i < 100; i++) cg.record(100);
  config.deposit = Object.assign({}, config.deposit, { enabled: true, newBucketMin: 9000, cpuAvgMax: 152, withdrawAvg: 150 });
  Game.cpu.bucket = 10000;
  Game.rooms = {};
  Memory.stats = [];
  Memory.deposits = { list: { d1: { home: 'W31S5', room: 'W30S5', type: 'silicon', x: 10, y: 10, cd: 0, decayAt: 99999999, at: 100, hops: 1 } }, routes: {}, visits: {} };
  const push = (t, cpu) => { Memory.stats.push({ t, cpu }); if (Memory.stats.length > 40) Memory.stats.shift(); };
  const r0950 = [202.2, 137.3, 122.1, 148.4, 153.2, 156.5, 128.3, 168.5, 234.1, 174.2];
  const r1058 = [132.4, 120.7, 114.8, 149.7, 151.9, 202.8, 160.8, 155.9, 157.1, 188.2];
  let t = 74462580;
  for (const c of r0950) { t += 30; push(t, c); }
  Memory.lootShed = { boots: [74462700, 74463700], paused: [], log: [] };
  Game.time = t;
  assert.strictEqual(dep.cpuHold(), false, 'one reading only');
  for (t = 74462880; t <= 74463570; t += 30) push(t, 130);
  t = 74463570;
  for (const c of r1058) { t += 30; push(t, c); }
  Memory.lootShed.boots = [74462700, 74463720];
  assert.ok(require('loot_shed').avgClean(10) < 150, 'warmup-cleaned avg10 hides the spike: ' + require('loot_shed').avgClean(10));
  Game.time = t;
  const miner = { memory: { role: 'depositMiner', depositId: 'd1', home: 'W31S5' }, ticksToLive: 1000 };
  Game.creeps = { m1: miner };
  const held = dep.cpuHold();
  assert.strictEqual(held, true, '10-21 readings 162.5 / 153.4 must hold: ' + JSON.stringify(Memory.deposits.cpuWin));
  assert.ok(Memory.deposits.cpuWin.every((w) => w.avg > 150), 'raw avg10 recorded, not warmup-cleaned');
  assert.strictEqual(miner.memory.done, true, 'W30S5 miner withdrawn');
  Game.creeps = {};
  const home = { name: 'W31S5', energyCapacityAvailable: 5600, controller: { my: true, level: 7 } };
  assert.strictEqual(dep.getDemands(home).filter((r) => r.role === 'depositMiner').length, 0, 'no new 萃香 while held');
  t += 300; push(t, 140); for (let i = 0; i < 9; i++) { t += 30; push(t, 140); }
  Game.time = t;
  assert.strictEqual(dep.cpuHold(), false, 'reading back <= 150 releases');
  assert.ok(Memory.deposits.cpuHoldLast, 'release recorded');
  console.log('OK');
}

console.log('STRAT 1022 TESTS PASSED');
