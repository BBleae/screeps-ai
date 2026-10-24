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
const utils = require('utils');
const term = require('terminal');
const ind = require('industry');
const mk = (o, free) => Object.assign({ getUsedCapacity(r) { return r ? this[r] || 0 : 0; }, getFreeCapacity() { return free == null ? 500000 : free; } }, o);
const R = (name, level, storageE, termE, sfree) => ({ name, controller: { my: true, level, progressTotal: 10935000, progress: 0 },
  storage: { id: 's' + name, my: true, store: mk({ energy: storageE }, sfree) }, terminal: { id: 't' + name, my: true, cooldown: 0, store: mk({ energy: termE }), send() { return OK; } },
  find: () => [{ energyCapacity: 3000 }, { energyCapacity: 3000 }] });
const setRooms = (list) => { Game.rooms = {}; list.forEach((r) => { Game.rooms[r.name] = r; }); };

console.log('--- effective energy: storage + terminal above keep ---');
{
  assert.strictEqual(utils.effectiveEnergy(R('W31S4', 7, 30000, 128000)), 128000);
  assert.strictEqual(utils.effectiveEnergy(R('W37S5', 7, 90000, 30000)), 90000);
  assert.strictEqual(utils.effectiveEnergy(R('W37S5', 7, 90000, 10000)), 90000);
  assert.strictEqual(utils.effectiveEnergy({ name: 'X', storage: { my: true, store: { energy: 5 } } }), 5);
  config.terminalNetwork.terminalFeeReserve.W31S4 = 45000;
  assert.strictEqual(utils.effectiveEnergy(R('W31S4', 7, 30000, 128000)), 30000 + 83000);
  delete config.terminalNetwork.terminalFeeReserve.W31S4;
}

console.log('--- RCL7 bank room: terminal-heavy room reaches the 40 WORK tier ---');
{
  Memory.cpuRoll = { avg: 140, hi: 0 };
  const a = R('W34S7', 7, 51000, 112000);
  setRooms([a]);
  Game.time++;
  assert.strictEqual(utils.upgradeSurplusWork(a, {}), 40);
  const b = R('W34S7', 7, 51000, 30000);
  setRooms([b]);
  Game.time++;
  assert.strictEqual(utils.upgradeSurplusWork(b, {}), 0);
}

console.log('--- upgradeHold follows the effective metric ---');
{
  const prev = config.upgrading.hold.W37S5;
  config.upgrading.hold.W37S5 = { resumeAt: 80000, holdBelow: 65000, smooth: 1 };
  const low = R('W37S5', 7, 50000, 30000);
  Memory.rooms.W37S5 = { upgradeHold: { on: true } };
  assert.strictEqual(utils.upgradeHold(low, Memory.rooms.W37S5).on, true);
  const rich = R('W37S5', 7, 50000, 70000);
  Memory.rooms.W37S5 = { upgradeHold: { on: true } };
  assert.strictEqual(utils.upgradeHold(rich, Memory.rooms.W37S5).on, false);
  config.upgrading.hold.W37S5 = prev;
}

console.log('--- lootExport keep uses the effective metric ---');
{
  const from = R('W37S5', 7, 100000, 30000);
  from.terminal.store.XUH2O = 20000;
  from.storage.store.getCapacity = () => 1000000;
  from.storage.store.getUsedCapacity = function (r) { return r ? this[r] || 0 : 900000; };
  from.controller.level = 7;
  const to = R('W32S4', 8, 100, 0);
  to.terminal.store.getFreeCapacity = () => 200000;
  to.storage.store.getFreeCapacity = () => 900000;
  setRooms([from, to]);
  const saved = config.terminalNetwork.lootExport;
  const cfg = term.settings();
  config.terminalNetwork.lootExport = cfg.lootExport = { W37S5: Object.assign({}, saved.W37S5, { storageAbove: 0.5, energyKeep: 95000, energy: false, t3To: ['W32S4'] }) };
  const p1 = term.planLootExport(cfg);
  assert.ok(p1 && p1.amount > 0, JSON.stringify(p1 && p1.blocked));
  config.terminalNetwork.lootExport.W37S5.energyKeep = 101000;
  const p2 = term.planLootExport(cfg);
  assert.ok(p2 && p2.amount === 0 && p2.blocked === 'energy');
  from.storage.store.energy = 70000;
  from.terminal.store.energy = 90000;
  const p3 = term.planLootExport(cfg);
  config.terminalNetwork.lootExport = saved;
  assert.ok(p3 && p3.amount > 0, 'terminal above keep counts');
}

console.log('--- RCL7 energy spill: terminal > 50k drains to 30k into storage ---');
{
  Memory.rooms = {};
  const r = R('W31S4', 7, 30000, 128000);
  const d = ind.terminalSpill(r);
  assert.ok(d && d.mineral === 'energy' && d.toStorage === true && d.labId === 'tW31S4' && d.amount === 98000, JSON.stringify(d));
  assert.ok(Memory.rooms.W31S4.energySpill);
  const mid = R('W31S4', 7, 80000, 40000);
  assert.ok(ind.terminalSpill(mid) && ind.terminalSpill(mid).amount === 10000, 'hysteresis continues');
  const done = R('W31S4', 7, 80000, 30000);
  assert.strictEqual(ind.terminalSpill(done), null);
  assert.strictEqual(Memory.rooms.W31S4.energySpill, undefined);
  assert.strictEqual(ind.terminalSpill(R('W31S4', 7, 80000, 45000)), null, 'below 50k not started');
  assert.strictEqual(ind.terminalSpill(R('W31S4', 7, 30000, 128000, 20000)), null, 'storage full');
  assert.strictEqual(ind.terminalSpill(R('W32S4', 8, 30000, 128000)), null, 'RCL8 untouched');
  assert.strictEqual(ind.terminalSpill(R('W29S3', 6, 30000, 128000)), null, 'RCL6 untouched');
  const plan = ind.techPlan(R('W31S4', 7, 30000, 128000));
  assert.ok(plan && plan.drains.some((x) => x.spill && x.mineral === 'energy'));
}

console.log('--- spill ends where terminal fill starts: no ping-pong ---');
{
  const tb = require('task_broker');
  const until = ind.terminalSpill(R('W31S4', 7, 30000, 128000)).amount;
  assert.strictEqual(128000 - until, config.industry.terminalTarget);
  assert.ok(config.industry.terminalTarget <= 50000);
}

console.log('--- forward energy: combined storage+terminal over the line stops; spill leaves storage >= line - 30k ---');
{
  setRooms([R('W32S4', 8, 500000, 40000), R('W31S4', 7, 30000, 128000), R('W31S6', 7, 120000, 40000), R('W31S5', 7, 120000, 50000), R('W37S7', 7, 60000, 100000)]);
  Game.rooms.W32S4.terminal.store.getFreeCapacity = () => 200000;
  for (const n of ['W31S4', 'W31S6', 'W31S5', 'W37S7']) Game.rooms[n].terminal.store.getFreeCapacity = () => 150000;
  const rule = (to) => term.forwardRules(term.settings()).find((f) => f.from === 'W32S4' && f.resource === 'energy' && f.to === to);
  assert.ok(rule('W31S4') && rule('W31S4').toBelow === 150000 && rule('W31S4').countStorage);
  const plan = (to) => term.planForward(rule(to), {});
  assert.ok(plan('W31S6') === null, 'combined 160k, storage 120k: stop');
  assert.ok(plan('W31S4') === null, 'terminal 128k clogged: no more');
  Game.rooms.W31S5.terminal.store.energy = 40000;
  Game.rooms.W31S5.storage.store.energy = 90000;
  assert.ok(plan('W31S5') && plan('W31S5').amount > 0, 'combined 130k below line');
  Game.rooms.W31S5.storage.store.energy = 95000;
  Game.rooms.W31S5.terminal.store.energy = 55000;
  assert.ok(plan('W31S5') === null, 'combined 150k stops');
}
console.log('strat_1024c OK');
