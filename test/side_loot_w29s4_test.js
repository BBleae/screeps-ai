'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const src = path.resolve(__dirname, '../src');
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (!request.includes('/') && !request.startsWith('.')) {
    const local = path.join(src, request + '.js');
    try { fs.accessSync(local); return local; } catch (e) {}
    if (request.startsWith('roles_')) {
      const r = path.join(src, 'roles', request.slice(6) + '.js');
      try { fs.accessSync(r); return r; } catch (e) {}
    }
  }
  return orig.call(this, request, parent, isMain, options);
};
Object.assign(global, require('/workspace/ops/war/eng/cmn/package/lib/constants'));
global.Game = { time: 1000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] } };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.getRangeTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y)); };

const config = require('config');
const side = require('side_loot');
const hauler = require('roles_lootHauler');
const conquest = require('conquest');

const mkStore = (o, cap) => Object.assign({}, o, {
  getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + o[k], 0),
  getCapacity: () => cap || 1000000,
  getFreeCapacity: () => (cap || 1000000) - Object.keys(o).reduce((n, k) => n + o[k], 0),
});
const home = (name, energy, used) => ({ name, energyCapacityAvailable: 5600, controller: { my: true, level: 7 }, storage: { pos: new RoomPosition(36, 22, name), store: mkStore(used != null ? { energy, O: used - energy } : { energy }) }, find: () => [] });

console.log('--- config: W29S4 side loot from W31S5 + W29S3, power > energy > O, unload nearer of the two ---');
{
  const c = config.sideLoot.rooms.W29S4;
  assert.deepStrictEqual(c.homes, { W31S5: 3, W29S3: 3 });
  assert.ok(!('W37S5' in c.homes));
  assert.deepStrictEqual(c.order, ['power', 'energy', 'O']);
  assert.deepStrictEqual(c.unload.slice().sort(), ['W29S3', 'W31S5']);
  assert.deepStrictEqual(c.pauseRemotes, { W29S3: ['W29S2'] });
  assert.ok(!config.conquest.lootDropFixed.W29S4);
  assert.strictEqual(config.conquest.lootHaulerTotal, 14, 'war/loot hauler pool unchanged');
  assert.ok(!(config.lootRoutes || {}).W29S4, 'no strict route list');
  console.log('OK');
}

console.log('--- demands: 3+3 unboosted haulers, conquest class (below survival/defense/war, above remote/development) ---');
{
  Memory.sideLoot = {};
  const d = side.getDemands(home('W31S5', 30000));
  assert.strictEqual(d.length, 3);
  const h3 = Object.assign(home('W29S3', 37000), { energyCapacityAvailable: 2300 });
  const d3 = side.getDemands(h3);
  assert.strictEqual(d3.length, 3);
  assert.ok(d3[0].body.length === 46 && d3[0].body.every((p) => p === 'carry' || p === 'move'), 'W29S3 RCL6: 23C23M');
  for (const x of d.concat(d3)) {
    assert.strictEqual(x.role, 'lootHauler');
    assert.strictEqual(x.cls, 'conquest');
    assert.ok(x.body.every((p) => p === 'carry' || p === 'move'));
    assert.strictEqual(x.memory.targetRoom, 'W29S4');
    assert.strictEqual(x.memory.sideLoot, true);
    assert.ok(!x.memory.salvageLoot && !x.memory.pullLoot && !x.memory.boosts, 'not counted by salvage cap / war split, no boosts');
  }
  assert.strictEqual(d[0].body.length, 50);
  assert.strictEqual(new Set(d.concat(d3).map((x) => x.slot)).size, 6);
  for (const r of ['W37S5', 'W31S4', 'W37S7']) assert.strictEqual(side.getDemands(home(r, 300000)).length, 0, r + ' spawns none');
  const cls = config.spawnQueue.classes;
  assert.ok(cls.conquest > cls.defense && cls.conquest > cls.survival + 0.75, 'below defense and room basics');
  assert.ok(cls.conquest < cls.remote && cls.conquest < cls.remoteMaintain && cls.conquest < cls.development && cls.conquest < cls.opportunistic, 'above remotes and normal tasks');
  const warSrc = fs.readFileSync(path.join(src, 'war.js'), 'utf8');
  assert.ok(/priority: Number\(c\.priority\) != null \? Number\(c\.priority\) : 0/.test(warSrc), 'war requests use priority 0');
  const spawnSrc = fs.readFileSync(path.join(src, 'spawn.js'), 'utf8');
  assert.ok(/sideLootDemands\) if \(unmet\(item\)\) requests\.push\(demandRequest\(room, item, item\.cls \|\| 'conquest'/.test(spawnSrc));
  console.log('OK');
}

console.log('--- W29S3 remotes (W29S2) paused while W29S4 has loot, resume when empty; other homes untouched ---');
{
  Memory.sideLoot = {};
  const dem = [{ role: 'remoteMiner', memory: { home: 'W29S3', remoteRoom: 'W29S2' } }, { role: 'reserver', memory: { home: 'W29S3', remoteRoom: 'W29S2' } }, { role: 'remoteHauler', memory: { home: 'W29S3', remoteRoom: 'W29S2' } }, { role: 'remoteMiner', memory: { home: 'W29S3', remoteRoom: 'W29S9' } }];
  assert.deepStrictEqual(side.filterRemoteDemands('W29S3', dem).map((x) => x.memory.remoteRoom), ['W29S9']);
  assert.strictEqual(side.filterRemoteDemands('W31S4', dem).length, 4, 'other homes keep remotes');
  side.remotePause('W29S4', config.sideLoot.rooms.W29S4);
  assert.deepStrictEqual(Memory.sideLoot.W29S4.remotesPaused, { W29S3: ['W29S2'] });
  assert.ok(Memory.sideLoot.W29S4.events.some((e) => e.e === 'remotesPaused'));
  Memory.sideLoot.W29S4.doneAt = Game.time;
  assert.strictEqual(side.filterRemoteDemands('W29S3', dem).length, 4, 'resumed once W29S4 empty');
  side.remotePause('W29S4', config.sideLoot.rooms.W29S4);
  assert.ok(Memory.sideLoot.W29S4.remotesResumedAt && Memory.sideLoot.W29S4.events.some((e) => e.e === 'remotesResumed'));
  Memory.sideLoot = {};
  console.log('OK');
}

console.log('--- damage: event + 300 tick spawn hold; squad avoidance cost ---');
{
  Memory.sideLoot = {};
  const creep = { name: 'hx', memory: { sideLoot: true, targetRoom: 'W29S4' }, hits: 900, hitsMax: 2500, room: { name: 'W30S4' } };
  assert.ok(side.noteDamage(creep));
  assert.ok(Memory.sideLoot.W29S4.events.some((e) => e.e === 'haulerDamaged' && e.name === 'hx' && e.room === 'W30S4'));
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 0);
  assert.strictEqual(Memory.sideLoot.W29S4.wait, 'damage');
  Game.time += 301;
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 3);
  const squad = [{ owner: { username: 'Kasami' }, pos: { x: 8, y: 40 }, body: [{ type: ATTACK, hits: 100 }] }, { owner: { username: 'Kasami' }, pos: { x: 9, y: 40 }, body: [{ type: HEAL, hits: 100 }] }];
  const r = { name: 'W30S4', find: (t) => t === FIND_HOSTILE_CREEPS ? squad : [] };
  const cb = side.avoidCallback(r, 5);
  const set = {};
  const cm = { get: () => 0, set: (x, y, v) => { set[x + ',' + y] = v; } };
  cb('W30S4', cm);
  assert.strictEqual(set['13,45'], 250); assert.strictEqual(set['3,35'], 250); assert.ok(!set['14,40'], 'only within radius 5 of the armed creep');
  const o = side.moveOpts({ memory: { sideLoot: true, targetRoom: 'W29S4' }, room: r }, { range: 20, reusePath: 20 });
  assert.ok(typeof o.costCallback === 'function' && o.reusePath <= 3);
  const o2 = side.moveOpts({ memory: { targetRoom: 'W37S2' }, room: r }, { range: 1 });
  assert.ok(!o2.costCallback, 'other haulers unchanged');
  Memory.sideLoot = {};
  console.log('OK');
}

console.log('--- gates: storage floor, bucket, armed threat, towers, done ---');
{
  Memory.sideLoot = {};
  assert.strictEqual(side.getDemands(home('W31S5', 10000)).length, 0, 'floor');
  assert.strictEqual(Memory.sideLoot.W29S4.wait, 'floor:W31S5');
  Game.cpu.bucket = 3000;
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 0, 'bucket');
  Game.cpu.bucket = 10000;
  const armedCreep = { owner: { username: 'Kasami' }, body: [{ type: ATTACK, hits: 100 }, { type: MOVE, hits: 100 }] };
  const ally = { owner: { username: 'Alepoldar' }, body: [{ type: ATTACK, hits: 100 }] };
  const storage = { structureType: 'storage', pos: new RoomPosition(15, 26, 'W29S4'), store: mkStore({ energy: 67430, power: 1783, O: 179940 }) };
  let hostiles = [armedCreep];
  let towers = [];
  Game.rooms.W29S4 = { name: 'W29S4', controller: { level: 0 }, find: (t) => t === FIND_HOSTILE_CREEPS ? hostiles : t === FIND_HOSTILE_STRUCTURES ? towers : t === FIND_STRUCTURES ? [storage] : [] };
  side.observe('W29S4');
  assert.strictEqual(Memory.sideLoot.W29S4.total, 249153);
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 0, 'armed hostile holds');
  Game.time += 301; hostiles = [ally];
  side.observe('W29S4');
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 3, 'ally is not a threat, hold expired');
  Game.time += 1; towers = [{ structureType: 'tower', store: { energy: 500 } }];
  side.observe('W29S4');
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 0, 'a live tower stops it (war needed)');
  Game.time += 1; towers = []; storage.store = mkStore({});
  side.observe('W29S4');
  assert.ok(Memory.sideLoot.W29S4.doneAt);
  assert.strictEqual(side.getDemands(home('W31S5', 30000)).length, 0, 'done');
  delete Game.rooms.W29S4;
  Memory.sideLoot = {};
  console.log('OK');
}

console.log('--- pick order: power, then energy, then O ---');
{
  const order = config.sideLoot.rooms.W29S4.order;
  const pick = (s) => conquest.salvagePickResource(s, order);
  assert.strictEqual(pick({ energy: 67430, power: 1783, O: 179940 }), 'power');
  assert.strictEqual(pick({ energy: 67430, O: 179940 }), 'energy');
  assert.strictEqual(pick({ O: 179940 }), 'O');
  const st = { power: 1783, O: 179940, energy: 67430 };
  assert.ok(side.orderScore({ store: st }, order) > side.orderScore({ store: { energy: 50 } }, order));
  assert.ok(side.orderScore({ store: { energy: 50 } }, order) > side.orderScore({ store: { O: 10 } }, order));
  console.log('OK');
}

console.log('--- hauler run: withdraws power first from storage over a nearer extension, never dismantles ---');
{
  const storage = { id: 'st', structureType: 'storage', pos: new RoomPosition(15, 26, 'W29S4'), store: mkStore({ energy: 67430, power: 1783, O: 179940 }) };
  const ext = { id: 'ex', structureType: 'extension', pos: new RoomPosition(11, 22, 'W29S4'), store: mkStore({ energy: 50 }) };
  const room = { name: 'W29S4', controller: { level: 0 }, getTerrain: () => ({ get: () => 0 }), lookForAt: () => [],
    find: (t) => t === FIND_STRUCTURES ? [storage, ext] : [] };
  storage.room = room; ext.room = room;
  Game.rooms = { W29S4: room };
  Game.getObjectById = (id) => ({ st: storage, ex: ext })[id] || null;
  global.PathFinder = { CostMatrix: function () { this.get = () => 0; this.set = () => {}; },
    search: (from, goals) => { const g = Array.isArray(goals) ? goals : [goals]; const near = g.slice().sort((a, b) => from.getRangeTo(a.pos) - from.getRangeTo(b.pos))[0]; return { path: [near.pos], incomplete: false, cost: 1 }; } };
  const calls = [];
  const creep = { name: 'h1', memory: { role: 'lootHauler', home: 'W31S5', targetRoom: 'W29S4', sideLoot: true, lootOrder: ['power', 'energy', 'O'] },
    pos: new RoomPosition(10, 21, 'W29S4'), room, ticksToLive: 1400, fatigue: 0,
    store: mkStore({}, 1250), body: [],
    withdraw: (o, r) => { calls.push(['withdraw', o.id, r]); return OK; }, pickup: () => OK,
    dismantle: () => { calls.push(['dismantle']); return OK; } };
  const obj = hauler.pickTarget(creep);
  assert.strictEqual(obj && obj.id, 'st', 'storage with power beats nearer extension');
  creep.pos = new RoomPosition(15, 25, 'W29S4');
  hauler.loadStep(creep, false);
  assert.deepStrictEqual(calls[0], ['withdraw', 'st', 'power']);
  assert.ok(!calls.some((c) => c[0] === 'dismantle'));
  storage.store = mkStore({ energy: 67430, O: 179940 });
  calls.length = 0; delete creep.memory.src;
  hauler.loadStep(creep, false);
  assert.deepStrictEqual(calls[0], ['withdraw', 'st', 'energy']);
  assert.strictEqual(hauler.loadPick({ energy: 10, O: 999999 }, ['power', 'energy', 'O']), 'energy');
  assert.strictEqual(hauler.loadPick({ energy: 10, O: 999999 }), 'O', 'old loot rooms unchanged');
  for (const f of ['side_loot.js', 'roles/lootHauler.js']) assert.ok(!/\.dismantle\(/.test(fs.readFileSync(path.join(src, f), 'utf8')), f + ' has no dismantle');
  console.log('OK');
}

console.log('--- unload: nearer of W31S5/W29S3 with space, else nearest with space ---');
{
  Game.rooms = { W31S5: home('W31S5', 30000), W29S3: home('W29S3', 37000), W31S4: home('W31S4', 14000) };
  const creep = { memory: { role: 'lootHauler', home: 'W29S3', targetRoom: 'W29S4', sideLoot: true } };
  Memory.lootDrop = { _steps: { 'W29S4:W31S5': { s: 79, n: 79, ok: 1, at: Game.time }, 'W29S4:W29S3': { s: 82, n: 82, ok: 1, at: Game.time } } };
  assert.strictEqual(hauler.dropRoom(creep), 'W31S5', 'nearer');
  Game.rooms.W31S5 = home('W31S5', 30000, 950000);
  assert.strictEqual(hauler.dropRoom(creep), 'W29S3', 'W31S5 full -> W29S3');
  Game.rooms.W29S3 = home('W29S3', 30000, 950000);
  Memory.lootDrop.W29S4 = { v: 3, at: Game.time, list: [['W31S5', 79, 1], ['W29S3', 82, 1], ['W31S4', 88, 1]] };
  assert.strictEqual(hauler.dropRoom(creep), 'W31S4', 'both full -> nearest with space');
  delete Memory.lootDrop;
  console.log('OK');
}

console.log('--- empty target: no pull reassignment, retire when done ---');
{
  const room = { name: 'W29S4', controller: { level: 0 }, find: () => [] };
  Game.rooms = { W29S4: room };
  Memory.lootBad = {};
  let retired = 0;
  const retire = require('retire');
  const origR = retire.retireAtSpawn;
  retire.retireAtSpawn = () => { retired++; };
  const origPull = conquest.pullDirective;
  conquest.pullDirective = () => ({ target: 'W37S2', pull: ['x'] });
  Memory.sideLoot = { W29S4: { doneAt: Game.time } };
  const creep = { name: 'h2', memory: { role: 'lootHauler', home: 'W31S5', targetRoom: 'W29S4', sideLoot: true, lootOrder: ['power', 'energy', 'O'] },
    pos: new RoomPosition(25, 25, 'W29S4'), room, store: mkStore({}, 1250) };
  hauler.loadStep(creep, false);
  assert.strictEqual(creep.memory.targetRoom, 'W29S4', 'never pulled to another loot room');
  assert.strictEqual(retired, 1);
  retire.retireAtSpawn = origR; conquest.pullDirective = origPull;
  console.log('OK');
}
console.log('ALL OK');
