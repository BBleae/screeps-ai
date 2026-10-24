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
const gate = require('cpu_gate');
const st = (o) => Object.assign({ getUsedCapacity(r) { return r ? this[r] || 0 : 0; }, getFreeCapacity() { return 100000; } }, o);
const R = (name, level, left, storageE, termE) => ({ name, controller: { my: true, level, progressTotal: 10935000, progress: 10935000 - (left || 0) },
  storage: { my: true, store: st({ energy: storageE || 0 }) }, terminal: { my: true, cooldown: 0, store: st({ energy: termE || 0 }), send() { return OK; } },
  find: () => [{ energyCapacity: 3000 }, { energyCapacity: 3000 }] });
const setRooms = (list) => { Game.rooms = {}; list.forEach((r) => { Game.rooms[r.name] = r; }); };

console.log('--- receivers: all RCL7 rooms by remaining progress, no W38S7/W33S3/W31S8 ---');
{
  setRooms([R('W33S3', 8), R('W31S8', 8), R('W38S7', 8), R('W37S7', 7, 9000000), R('W31S4', 7, 1660000), R('W31S6', 7, 1240000), R('W34S7', 7, 4200000)]);
  Game.time++;
  assert.deepStrictEqual(term.rcl7Rooms(), ['W31S6', 'W31S4', 'W34S7', 'W37S7']);
  const pl = term.priorityList(term.settings());
  assert.ok(['W33S3', 'W31S8', 'W38S7'].every((n) => pl.indexOf(n) < 0) && pl[0] === 'W31S6', 'priorityList ' + JSON.stringify(pl));
  const tc = term.settings();
  const rs = [R('W33S7', 8, 0, 90000, 30000), R('W38S7', 8, 0, 30000, 3000), R('W33S3', 8, 0, 20000, 3000), R('W31S4', 7, 1660000, 30000, 5000), R('W31S6', 7, 1240000, 30000, 5000)];
  setRooms(rs);
  Memory.terminalNetwork = {};
  Game.time += 10;
  const s = term.planSenders(rs, tc);
  assert.ok(s && s.from.name === 'W33S7' && s.to.name === 'W31S6', 'W33S7 sends to closest RCL7 ' + JSON.stringify(s && s.to.name));
  const fw = term.forwardRules(tc).filter((f) => f.resource === 'energy');
  assert.ok(fw.length && fw.every((f) => ['W31S4', 'W31S6'].indexOf(f.to) >= 0) && fw[0].to === 'W31S6', 'energy forwards ' + JSON.stringify(fw.map((f) => f.from + '>' + f.to)));
}

console.log('--- XGH2O boost only RCL7 rooms in order W31S4, W31S6, W37S5, W29S3 ---');
{
  setRooms([R('W33S7', 8), R('W31S4', 8), R('W31S6', 7, 1), R('W37S5', 7, 1), R('W29S3', 6)]);
  assert.deepStrictEqual(utils.upgraderBoostRooms(), ['W31S6', 'W37S5', 'W29S3']);
  const tb = require('task_broker');
  assert.ok(tb.upgraderBoostRoom(Game.rooms.W31S6) && !tb.upgraderBoostRoom(Game.rooms.W33S7) && !tb.upgraderBoostRoom(Game.rooms.W31S4));
  assert.ok(config.industry.upgraderBoostByRoom === undefined && JSON.stringify(config.industry.boostCompoundsByRoom.W33S7) === '[]');
  const xf = term.forwardRules(term.settings()).filter((f) => f.resource === 'XGH2O');
  assert.ok(xf.length && xf.every((f) => utils.upgraderBoostRooms().indexOf(f.to) >= 0) && !xf.some((f) => f.to === 'W33S7'), 'XGH2O forwards ' + JSON.stringify(xf.map((f) => f.to)));
}

console.log('--- RCL8 upgraders capped at 15 WORK total ---');
{
  const r8 = R('W32S4', 8, 0, 200000);
  setRooms([r8]);
  Game.time++;
  assert.strictEqual(utils.upgraderWorkCap(r8, {}), 15);
  const r7 = R('W32S4', 7, 1, 200000);
  setRooms([r7]);
  Game.time++;
  assert.ok(utils.upgraderWorkCap(r7, {}) > 15);
}

console.log('--- RCL7 bank room storage > 100k: extra upgraders to 40 WORK unless CPU > 150 twice ---');
{
  const b = R('W34S7', 7, 4200000, 150000);
  setRooms([b]);
  Memory.cpuRoll = { avg: 140, hi: 1 };
  Game.time++;
  assert.strictEqual(utils.upgradeSurplusWork(b, {}), 40);
  Memory.cpuRoll = { avg: 155, hi: 2 };
  Game.time++;
  assert.strictEqual(utils.upgradeSurplusWork(b, {}), 0);
  const kept = { upgradeSurplus: { work: 40, t: 0, at: 0, energy: 150000 } };
  Game.time++;
  assert.strictEqual(utils.upgradeSurplusWork(b, kept), 40);
  const poor = R('W34S7', 7, 1, 90000);
  Memory.cpuRoll = { avg: 140, hi: 0 };
  Game.time++;
  assert.strictEqual(utils.upgradeSurplusWork(poor, {}), 0);
  Memory.cpuRoll = { avg: 151, hi: 1 };
  for (let t = 996; t <= 1000; t++) { Game.time = t; gate.record(160); }
  assert.ok(Memory.cpuRoll.hi === 2 && !gate.cpuCalm(), JSON.stringify(Memory.cpuRoll));
  Game.time = 1010;
  gate.record(-10000);
  assert.ok(Memory.cpuRoll.hi === 0 && gate.cpuCalm(), JSON.stringify(Memory.cpuRoll));
}

console.log('--- battery decompress stops above 300k, resumes below 200k ---');
{
  Memory.rooms = {};
  const made = [];
  const f = { id: 'fac', cooldown: 0, store: st({ battery: 100 }), produce(r) { made.push(r); return OK; } };
  const room = { name: 'W32S4', storage: { my: true, store: st({ energy: 310000 }) } };
  const run = (e) => { room.storage.store.energy = e; const s = {}; ind.runBatteryFactory(room, s, f); return s.factory; };
  assert.ok(run(310000).batteryHold && !made.length);
  assert.ok(run(250000).batteryHold && !made.length);
  assert.ok(!run(190000).batteryHold && made.length === 1);
  assert.ok(!run(250000).batteryHold && made.length === 2);
  assert.ok(ind.batteryHold({ name: 'W32S4', storage: { store: st({ energy: 300001 }) } }) && Memory.rooms.W32S4.batteryHold);
  assert.ok(config.market.neverSell.indexOf('battery') >= 0);
}

console.log('strat_1024b ok');
