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
const term = require('terminal');
const ind = require('industry');
const utils = require('utils');
const market = require('market');
const hauler = require('roles_hauler');

const store = (o, free) => Object.assign({ getFreeCapacity: () => (free == null ? 200000 : free) }, o);
const mkRoom = (name, level, term_, stor, structs) => ({ name, controller: { my: true, level }, terminal: { my: true, cooldown: 0, store: store(term_), send: () => OK }, storage: { my: true, store: store(stor) }, find: (k, o) => { const l = structs || []; return o && o.filter ? l.filter(o.filter) : l; } });

console.log('--- market: neverSell and below-minDeal leftovers do not use up scans ---');
{
  const cfg = market.settings();
  assert.ok(cfg.neverSell.indexOf('battery') >= 0, 'battery never sold');
  assert.strictEqual(cfg.keepBy.battery, Infinity);
  const r = mkRoom('W32S4', 7, { battery: 24553, H: 47779, energy: 50000 }, { energy: 50000 });
  const list = market.sellable(r, cfg, null).map((e) => e.resource);
  assert.ok(list.indexOf('battery') < 0, 'battery not sellable: ' + list.join());
}

console.log('--- hauler unstash: several rules per room, first short one wins ---');
{
  assert.ok(Array.isArray(config.hauling.unstash.W37S5));
  assert.deepStrictEqual(config.hauling.unstash.W37S5.map((x) => x.resource), ['K', 'G', 'X']);
  const r = mkRoom('W37S5', 7, { K: 5000, G: 0 }, { K: 140000, G: 12500, X: 3750 });
  let p = hauler.unstashRule(r);
  assert.ok(p && p.res === 'G' && p.short === 8000 && p.have === 12500, JSON.stringify(p));
  r.terminal.store.G = 8000;
  p = hauler.unstashRule(r);
  assert.ok(p && p.res === 'X' && p.short === 4000, JSON.stringify(p));
  r.terminal.store.K = 100;
  p = hauler.unstashRule(r);
  assert.ok(p && p.res === 'K', 'K first');
  const one = mkRoom('W33S7', 8, {}, { L: 900 });
  p = hauler.unstashRule(one);
  assert.ok(p && p.res === 'L' && p.have === 900, 'single object rule still works');
}

console.log('--- battery -> energy in W32S4/W33S3 factories, keep 20k battery ---');
{
  assert.strictEqual(config.industry.batteryRooms.W32S4.keep, 20000);
  assert.strictEqual(config.industry.batteryRooms.W33S3.keep, 20000);
  assert.ok(config.industry.factory.rooms.indexOf('W32S4') < 0);
  const fac = { id: 'f1', structureType: 'factory', my: true, cooldown: 0, store: store({}), produced: [], produce(r) { this.produced.push(r); return OK; } };
  const r = mkRoom('W32S4', 7, { battery: 20000 }, { battery: 172980, energy: 50000 }, [fac]);
  global.Game.rooms = { W32S4: r };
  let p = ind.factoryPlan(r);
  assert.ok(p && p.battery && p.wants.length === 1 && p.wants[0].mineral === 'battery' && p.wants[0].amount === 1000, JSON.stringify(p));
  r.storage.store.battery = 0; r.terminal.store.battery = 20030;
  p = ind.factoryPlan(r);
  assert.strictEqual(p.wants.length, 0, 'only 30 above keep: no fill');
  r.terminal.store.battery = 20300;
  p = ind.factoryPlan(r);
  assert.ok(p.wants.length === 1 && p.wants[0].amount === 300, 'fill only what is above 20k');
  r.terminal.store.battery = 19000;
  p = ind.factoryPlan(r);
  assert.strictEqual(p.wants.length, 0, 'below 20k: untouched');
  fac.store.energy = 1500;
  p = ind.factoryPlan(r);
  assert.ok(p.drains.length === 1 && p.drains[0].mineral === 'energy' && p.drains[0].amount === 1500, 'energy drained out');
  const st = {};
  ind.runBatteryFactory(r, st, fac);
  assert.ok(!fac.produced.length && st.factory.batteryWait, 'no battery in factory: wait');
  fac.store.battery = 50;
  ind.runBatteryFactory(r, st, fac);
  assert.deepStrictEqual(fac.produced, ['energy']);
  assert.ok(Memory.factoryLog.W32S4.energy === 500 && Memory.factoryLog.W32S4.battery === 50);
  fac.cooldown = 5; fac.produced = [];
  ind.runBatteryFactory(r, {}, fac);
  assert.strictEqual(fac.produced.length, 0, 'cooldown');
  const own = mkRoom('W33S8', 8, {}, {}, [fac]);
  assert.strictEqual(ind.batteryFactory(own), null, 'keanium factory rooms unchanged');
  assert.ok(ind.factoryPlan(mkRoom('W31S4', 7, {}, {}, [fac])) === null, 'rooms without batteryRooms: no plan');
}

console.log('--- energy forward: 10-24 to every RCL7 room; amount + cost fits terminal ---');
{
  global.Game.market = { calcTransactionCost: (a) => Math.ceil(a * 0.1) };
  global.Game.rooms = { W32S4: mkRoom('W32S4', 8, { energy: 30000 }, { energy: 70000 }), W31S4: mkRoom('W31S4', 7, { energy: 5000 }, { energy: 60000 }) };
  global.Game.time++;
  const f = term.forwardRules(term.settings()).filter((x) => x.resource === 'energy');
  assert.deepStrictEqual(f.map((x) => x.from + '>' + x.to), ['W32S4>W31S4', 'W33S3>W31S4']);
  let p = term.planForward(f[0], {});
  assert.ok(p && p.amount === 10000 && p.amount + p.cost <= 30000 - 5000, JSON.stringify(p && { a: p.amount, c: p.cost }));
  global.Game.rooms.W32S4.terminal.store.energy = 12000;
  p = term.planForward(f[0], {});
  assert.ok(!p || !p.amount || p.amount + p.cost <= 12000 - 5000, 'energy floor counts the sent energy: ' + JSON.stringify(p && { a: p.amount, c: p.cost }));
  global.Game.rooms.W32S4.terminal.store.energy = 30000; global.Game.rooms.W32S4.storage.store.energy = 25000;
  p = term.planForward(f[0], {});
  assert.ok(!p, 'keep 60k energy in the sender');
  global.Game.rooms.W32S4.storage.store.energy = 70000; global.Game.rooms.W31S4.storage.store.energy = 150000;
  p = term.planForward(f[0], {});
  assert.ok(!p, 'W31S4 at 150k: stop');
}

console.log('--- W37S7 ramparts: repaired from 25k, towers top up to 27k; 20k floor kept ---');
{
  assert.deepStrictEqual(config.rampartGuard.W37S7, { trigger: 25000, to: 27000 });
  const ramp = (x, y, hits, roomName) => ({ id: 'r' + x + '_' + y + roomName, structureType: STRUCTURE_RAMPART, hits, hitsMax: 1000000, my: true, pos: { x, y, roomName } });
  const room = { name: 'W37S7', controller: { my: true, level: 8 }, find: () => [] };
  const g = utils.rampartGuard(room, ramp(4, 23, 24900, 'W37S7'));
  assert.deepStrictEqual(g, { trigger: 25000, to: 27000 });
  assert.strictEqual(utils.rampartGuard({ name: 'W31S4' }, ramp(1, 1, 100, 'W31S4')), null);
  assert.strictEqual(utils.rampartTowerGoal(room, ramp(4, 23, 24900, 'W37S7')), 27000);
  assert.strictEqual(utils.rampartTowerGoal({ name: 'W33S3' }, ramp(34, 45, 100, 'W33S3')), 20000, 'pos floor counts for towers');
  assert.strictEqual(utils.rampartTowerGoal({ name: 'W31S4' }, ramp(1, 1, 100, 'W31S4')), config.towerWallHits);
}
{
  const ramp = (x, y, hits) => ({ id: 'q' + x + '_' + y, structureType: STRUCTURE_RAMPART, hits, hitsMax: 1000000, my: true, pos: { x, y, roomName: 'W37S7' } });
  const list = [ramp(4, 23, 24900), ramp(4, 17, 25700), ramp(4, 19, 19000)];
  const room = { name: 'W37S7', controller: { my: true, level: 8 }, find: (k, o) => (o && o.filter ? list.filter(o.filter) : list), storage: { store: store({ energy: 0 }) } };
  global.Memory.rooms = { W37S7: {} };
  global.Game.rooms = { W37S7: room };
  global.Game.time = 5000;
  assert.strictEqual(utils.needsRepair(room, list[0]), true, '24.9k < 25k: repair');
  assert.strictEqual(utils.needsRepair(room, list[2]), true, '19k: repair');
  assert.strictEqual(utils.needsRepair(room, list[1]), false, '25.7k, not storageRich: wait');
  global.Game.getObjectById = (id) => list.find((s) => s.id === id) || null;
  const tower = require('tower');
  const cands = tower.repairCandidates(room, false).map((s) => s.hits);
  assert.deepStrictEqual(cands.slice().sort((a, b) => a - b), [19000, 24900, 25700], 'one under 25k: towers top all up toward 27k: ' + JSON.stringify(cands));
  assert.ok(global.Memory.rooms.W37S7.rampartGuard.on && global.Memory.rooms.W37S7.rampartGuard.min === 19000);
  list[0].hits = 26000; global.Game.time += 10;
  assert.deepStrictEqual(tower.repairCandidates(room, false).map((s) => s.hits).sort((a, b) => a - b), [19000, 25700, 26000], 'tower keeps going up to 27k');
  list[0].hits = 27000; global.Game.time += 10;
  assert.deepStrictEqual(tower.repairCandidates(room, false).map((s) => s.hits).sort((a, b) => a - b), [19000, 25700], 'stop at 27k');
  list[2].hits = 27000; list[1].hits = 26000; global.Game.time += 10;
  assert.deepStrictEqual(tower.repairCandidates(room, false).map((s) => s.hits), [26000], 'still topping up while one is under 27k');
  list[1].hits = 27000; global.Game.time += 10;
  assert.strictEqual(tower.repairCandidates(room, false).length, 0, 'all at 27k: guard off');
  assert.ok(!global.Memory.rooms.W37S7.rampartGuard, 'guard released');
  list[1].hits = 26000; global.Game.time += 10;
  assert.strictEqual(tower.repairCandidates(room, false).length, 0, '26k with guard off: wait until under 25k');
  list[1].hits = 24999; global.Game.time += 10;
  assert.deepStrictEqual(tower.repairCandidates(room, false).map((s) => s.hits).sort((a, b) => a - b), [24999], 'under 25k: on again');
  const other = [{ id: 'o1', structureType: STRUCTURE_RAMPART, hits: 15000, hitsMax: 1000000, my: true, pos: { x: 2, y: 2, roomName: 'W31S4' } }];
  const r2 = { name: 'W31S4', controller: { my: true, level: 7 }, find: (k, o) => (o && o.filter ? other.filter(o.filter) : other) };
  global.Game.getObjectById = (id) => other.find((s) => s.id === id) || null;
  assert.strictEqual(tower.repairCandidates(r2, false).length, 0, 'other rooms keep the 10k tower cap');
  global.Game.getObjectById = () => null;
}
console.log('ALL OK');
