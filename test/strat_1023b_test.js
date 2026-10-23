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

global.Game = { time: 3000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] }, market: {} };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };

const config = require('config');
const split = require('loot_split');
const conquest = require('conquest');
const industry = require('industry');
const market = require('market');

const mkStore = (o, cap) => Object.assign({}, o, {
  getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + o[k], 0),
  getCapacity: () => cap || 2500,
  getFreeCapacity: () => (cap || 2500) - Object.keys(o).reduce((n, k) => n + o[k], 0),
});
let seq = 0;
function hauler(name, mem, opt) {
  opt = opt || {};
  const c = { name, memory: Object.assign({ role: 'lootHauler', home: 'W37S5', salvageLoot: true }, mem), ticksToLive: opt.ttl != null ? opt.ttl : 1400, store: mkStore(opt.store || {}), room: { name: opt.room || 'W37S5' }, spawning: false, id: 'c' + (++seq) };
  Game.creeps[name] = c;
  return c;
}
function lootRoom(name, battery, hostiles) {
  const ruins = battery > 0 ? [{ store: mkStore({ battery }), pos: { x: 10, y: 10 } }] : [];
  Game.rooms[name] = { name, find: (t) => (t === FIND_RUINS ? ruins : t === FIND_HOSTILE_CREEPS ? (hostiles || []) : []) };
}
const directives = () => [
  { type: 'salvageLoot', target: 'W35S1', sponsors: ['W37S5'], phase: 'loot', haulers: 12, maxHaulersPerHome: 10, startedAt: 1 },
  { type: 'salvageLoot', target: 'W37S2', sponsors: ['W37S5', 'W37S7'], phase: 'loot', haulers: 2, startedAt: 1 },
];
function reset() {
  Game.creeps = {}; Game.rooms = {}; Game.time = 3000;
  Memory.conquest = directives();
  Memory.lootWarLoot = { target: 'W39S1', haulers: 6, keepOthers: 6, unload: 'W37S5', since: 1, reliefTtl: 300 };
  Memory.lootGate = {};
}
const armed = (user) => ({ owner: { username: user }, body: [{ type: ATTACK, hits: 100 }, { type: MOVE, hits: 100 }] });

console.log('--- haulers:0 means 0 ---');
{
  assert.strictEqual(split.quota(undefined, 8), 8);
  assert.strictEqual(split.quota(null, 8), 8);
  assert.strictEqual(split.quota(0, 8), 0);
  assert.strictEqual(split.quota('0', 8), 0);
  assert.strictEqual(split.quota(5, 8), 5);
  reset();
  Memory.lootWarLoot.haulers = 0;
  for (let i = 0; i < 4; i++) hauler('p' + i, { targetRoom: 'W37S2' });
  const r = split.run(true);
  assert.strictEqual(r.moved, 0);
  assert.ok(Object.values(Game.creeps).every((c) => c.memory.targetRoom === 'W37S2'));
  const war = fs.readFileSync(path.join(src, 'war.js'), 'utf8');
  assert.ok(war.indexOf('Number(sp.haulers) || 8') < 0);
  console.log('OK');
}

console.log('--- lock: pool never picks locked creeps, top up to n, release on battery cleared ---');
{
  reset();
  Memory.lootWarLoot.locks = { W35S1: { n: 6, until: 'battery' } };
  lootRoom('W35S1', 5000);
  for (let i = 0; i < 4; i++) hauler('L' + i, { targetRoom: 'W35S1', w35lock: 100, salvageLoot: undefined });
  hauler('A', { targetRoom: 'W35S1' }, { ttl: 1300 });
  hauler('B', { targetRoom: 'W37S2' }, { ttl: 1450 });
  hauler('C', { targetRoom: 'W39S1', splitFrom: 'W37S2' }, { ttl: 1490, room: 'W39S1' });
  hauler('D', { targetRoom: 'W37S2' }, { ttl: 500 });
  assert.ok(split.pool().every((c) => !c.memory.w35lock && !c.memory.lootLock));
  const r = split.runLocks(Memory.lootWarLoot, split.settings(), split.liveRooms(), Object.values(Game.creeps));
  assert.deepStrictEqual(r.W35S1.added, ['A', 'B']);
  assert.strictEqual(Memory.lootWarLoot.locks.W35S1.have, 6);
  assert.strictEqual(Game.creeps.B.memory.targetRoom, 'W35S1');
  assert.strictEqual(Game.creeps.C.memory.targetRoom, 'W39S1');
  for (let i = 0; i < 4; i++) assert.strictEqual(Game.creeps['L' + i].memory.salvageLoot, true);
  assert.ok(split.pool().every((c) => ['C', 'D'].indexOf(c.name) >= 0));
  delete Game.creeps.L0;
  hauler('E', { targetRoom: 'W37S2', lentFrom: 'W39S1', pausedFrom: 'W39S1' }, { ttl: 1480 });
  split.runLocks(Memory.lootWarLoot, split.settings(), split.liveRooms(), Object.values(Game.creeps));
  assert.strictEqual(Game.creeps.E.memory.lootLock, 'W35S1');
  assert.ok(!Game.creeps.E.memory.lentFrom && !Game.creeps.E.memory.pausedFrom);
  assert.strictEqual(Memory.lootWarLoot.locks.W35S1.have, 6);
  lootRoom('W35S1', 0);
  split.runLocks(Memory.lootWarLoot, split.settings(), split.liveRooms(), Object.values(Game.creeps));
  assert.ok(Memory.lootWarLoot.locks.W35S1.releasedAt);
  assert.ok(Object.values(Game.creeps).every((c) => !c.memory.lootLock && !c.memory.w35lock));
  console.log('OK');
}

console.log('--- lock: conquest counts locked creeps without salvageLoot; relieved/finalRun take no slot ---');
{
  reset();
  Memory.cfg = undefined;
  const home = { name: 'W37S5', controller: { my: true, level: 8 }, energyCapacityAvailable: 12900, energyAvailable: 12900, storage: { store: { energy: 500000 } }, find: () => [] };
  Game.rooms.W37S5 = home;
  const cnt = () => conquest.getDemands(home).filter((x) => x.memory && x.memory.role === 'lootHauler' && x.memory.targetRoom === 'W35S1').length;
  const total = config.conquest.lootHaulerTotal;
  for (let i = 0; i < total; i++) hauler('S' + i, { targetRoom: 'W37S2', home: 'W37S7' });
  const base = cnt();
  assert.strictEqual(base, 0);
  for (let i = 0; i < 3; i++) Game.creeps['S' + i].memory.relieved = 100;
  Game.creeps.S3.memory.finalRun = { at: 1 };
  assert.strictEqual(cnt(), 4);
  for (let i = 0; i < 4; i++) hauler('K' + i, { targetRoom: 'W35S1', w35lock: 1, salvageLoot: undefined });
  assert.strictEqual(cnt(), 0);
  console.log('OK');
}

console.log('--- W35S1 empty: haulers retarget to W37S2 ---');
{
  reset();
  Memory.conquest[0].phase = 'done';
  Memory.lootWarLoot.haulers = 0;
  hauler('a', { targetRoom: 'W35S1', lootTiles: [[1, 1]], src: 'x' });
  hauler('b', { targetRoom: 'W39S1', splitFrom: 'W35S1' }, { room: 'W38S2' });
  hauler('s', { targetRoom: 'W35S1', sideLoot: true });
  split.run(true);
  assert.strictEqual(Game.creeps.a.memory.targetRoom, 'W37S2');
  assert.strictEqual(Game.creeps.a.memory.lootTiles, null);
  assert.strictEqual(Game.creeps.a.memory.src, undefined);
  assert.strictEqual(Game.creeps.s.memory.targetRoom, 'W35S1');
  reset();
  Memory.conquest[0].completed = true;
  Memory.lootWarLoot.doneAt = 10;
  hauler('c', { targetRoom: 'W35S1' });
  split.run(true);
  assert.strictEqual(Game.creeps.c.memory.targetRoom, 'W37S2');
  reset();
  Memory.conquest[0].phase = 'done';
  lootRoom('W39S1', 0);
  hauler('d', { targetRoom: 'W39S1', splitFrom: 'W35S1', splitTiles: null }, { room: 'W39S1' });
  split.run(true);
  assert.strictEqual(Game.creeps.d.memory.targetRoom, 'W37S2');
  console.log('OK');
}

console.log('--- W39S1 auto pause on armed non-ally, divert en route, resume after 100 quiet ticks ---');
{
  reset();
  lootRoom('W39S1', 9000);
  lootRoom('W39S0', 0, [armed('Alepoldar')]);
  for (let i = 0; i < 3; i++) hauler('w' + i, { targetRoom: 'W39S1', splitFrom: 'W35S1', splitTiles: null }, { room: 'W39S1' });
  hauler('r1', { targetRoom: 'W39S1', splitFrom: 'W35S1', splitTiles: null }, { room: 'W38S1' });
  hauler('r2', { targetRoom: 'W39S1', splitFrom: 'W37S2' }, { room: 'W37S4', store: { battery: 500 } });
  Game.creeps.r2.memory.state = 'deliver';
  for (let i = 0; i < 6; i++) hauler('f' + i, { targetRoom: 'W37S2' });
  let r = split.run(true);
  assert.ok(!r.paused, 'ally does not pause');
  assert.strictEqual(r.moved, 1);
  const pulled = r.names[0];
  lootRoom('W39S0', 0, [armed('Enemy')]);
  Game.time += 5;
  r = split.run(true);
  assert.ok(r.paused);
  assert.ok(Memory.lootWarLoot.pause.on);
  assert.strictEqual(Memory.lootWarLoot.pause.by, 'Enemy');
  assert.strictEqual(Game.creeps.r1.memory.targetRoom, 'W37S2');
  assert.strictEqual(Game.creeps.r1.memory.lentFrom, 'W39S1');
  assert.strictEqual(Game.creeps[pulled].memory.targetRoom === 'W39S1', Game.creeps[pulled].room.name === 'W39S1');
  for (let i = 0; i < 3; i++) assert.strictEqual(Game.creeps['w' + i].memory.targetRoom, 'W39S1');
  assert.strictEqual(Game.creeps.r2.memory.state, 'deliver');
  assert.strictEqual(Game.creeps.r2.memory.targetRoom, 'W37S2');
  delete Game.rooms.W39S0;
  delete Game.rooms.W39S1;
  for (let t = 0; t < 19; t++) { Game.time += 5; r = split.run(true); assert.ok(r.paused, 'still paused at ' + t); }
  assert.ok(Object.values(Game.creeps).filter((c) => c.memory.targetRoom === 'W39S1').every((c) => c.room.name === 'W39S1'));
  Game.time += 5;
  r = split.run(true);
  assert.ok(!r.paused, 'resumed after 100 quiet ticks without vision');
  assert.ok(r.moved > 0);
  lootRoom('W39S0', 0, [armed('Enemy')]);
  Game.time += 5;
  r = split.run(true);
  assert.ok(r.paused);
  assert.strictEqual(Memory.lootWarLoot.pause.mult, 2, 'flap backs off');
  delete Game.rooms.W39S0;
  for (let t = 0; t < 39; t++) { Game.time += 5; r = split.run(true); assert.ok(r.paused, 'backoff hold ' + t); }
  Game.time += 5;
  r = split.run(true);
  assert.ok(!r.paused);
  Game.time += 1;
  lootRoom('W39S1', 9000, [armed('Enemy')]);
  assert.strictEqual(split.run(false), null);
  assert.strictEqual(Memory.lootWarLoot.pause.seen, Game.time, 'off-cycle sighting recorded');
  console.log('OK');
}

console.log('--- relief: old haulers marked relieved, line keeps quota ---');
{
  reset();
  lootRoom('W39S1', 9000);
  for (let i = 0; i < 6; i++) hauler('o' + i, { targetRoom: 'W39S1', splitFrom: 'W37S2' }, { ttl: i < 2 ? 200 : 1300, room: 'W39S1' });
  for (let i = 0; i < 4; i++) hauler('n' + i, { targetRoom: 'W37S2' });
  const r = split.run(true);
  assert.strictEqual(r.moved, 2);
  assert.strictEqual(Game.creeps.o0.memory.relieved, Game.time);
  assert.strictEqual(Memory.lootWarLoot.active, 6);
  reset();
  lootRoom('W39S1', 9000);
  const hz = require('roles_lootHauler');
  const savedFinal = hz.finalRun;
  hauler('x0', { targetRoom: 'W39S1', splitFrom: 'W37S2' }, { ttl: 250, room: 'W38S2' });
  hauler('x1', { targetRoom: 'W39S1', splitFrom: 'W37S2' }, { ttl: 250, room: 'W39S1' });
  for (let i = 0; i < 4; i++) hauler('y' + i, { targetRoom: 'W39S1', splitFrom: 'W37S2' }, { room: 'W39S1' });
  for (let i = 0; i < 4; i++) hauler('z' + i, { targetRoom: 'W37S2' });
  const seenFinal = [];
  hz.finalRun = (c) => { seenFinal.push(c.name); c.memory.finalRun = { at: Game.time }; c.memory.targetRoom = 'W37S2'; delete c.memory.splitFrom; return true; };
  const r2 = split.run(true);
  hz.finalRun = savedFinal;
  assert.deepStrictEqual(seenFinal, ['x0'], 'relieved hauler outside the target leaves the line, the one inside finishes its load');
  assert.strictEqual(r2.moved, 2);
  assert.strictEqual(Memory.lootWarLoot.on, 7);
  assert.strictEqual(Memory.lootWarLoot.active, 6);
  console.log('OK');
}

console.log('--- XGH2O rate cap 300/1500 ---');
{
  assert.deepStrictEqual(config.industry.productRate.XGH2O, { amount: 300, ticks: 1500 });
  Game.time = 10000;
  delete Memory.labRate;
  const room = { name: 'W33S3', terminal: { store: {} } };
  const mem = {};
  for (let i = 0; i < 59; i++) industry.noteLabUse('W33S3', 'GH2O', 'X', 'XGH2O');
  assert.ok(!industry.heldProducts(room, mem).has('XGH2O'));
  industry.noteLabUse('W32S4', 'GH2O', 'X', 'XGH2O');
  assert.strictEqual(Memory.labRate.XGH2O.made, 300);
  assert.ok(industry.heldProducts(room, mem).has('XGH2O'));
  Game.time = 11499;
  assert.ok(industry.heldProducts(room, mem).has('XGH2O'));
  Game.time = 11500;
  assert.ok(!industry.heldProducts(room, mem).has('XGH2O'));
  industry.noteLabUse('W33S3', 'GH2O', 'X', 'XGH2O');
  assert.deepStrictEqual(Memory.labRate.XGH2O, { start: 11500, made: 5 });
  console.log('OK');
}

console.log('--- market: OH floor 10k in lab rooms, X own budget 1.6M and max 400 ---');
{
  const m = config.market;
  assert.strictEqual(m.keepByRoom.W32S4.OH, 10000);
  assert.strictEqual(m.keepByRoom.W33S3.OH, 10000);
  assert.strictEqual(m.keepByRoom.W37S5.OH, undefined);
  assert.strictEqual(m.buy.maxPrice.X, 400);
  assert.strictEqual(m.buyBudgetBy.X, 1600000);
  assert.strictEqual(m.dailyBuyCredits, 500000);
  assert.ok(!('X' in m.buyShare.reserve));
  assert.ok(config.lootRoutes.hardAvoid.indexOf('W36S2') >= 0 && config.lootRoutes.hardAvoid.indexOf('W37S1') >= 0);
  const cfg = market.settings();
  assert.strictEqual(market.buyCap(cfg, 'X'), 400);
  Memory.market = { ledger: { day: Math.floor(Date.now() / 86400000), sold: {}, bought: {}, soldCredits: 0, buyCredits: 499000, energyBuyCredits: 0, energyBuyByRoom: {}, deals: 0, buyOwn: { X: 100000 } }, orders: {} };
  const led = market.ledger();
  assert.strictEqual(market.ownBuyLeft(cfg, led, 'X'), 1500000);
  assert.strictEqual(market.ownBuyLeft(cfg, led, 'O'), null);
  const room = (name, store) => ({ name, terminal: { store, my: true }, storage: { store: {} } });
  const has = (list, res) => (list.find((x) => x.resource === res) || {}).amount || 0;
  Game.rooms = {};
  assert.strictEqual(has(market.sellable(room('W32S4', { OH: 9000 }), cfg), 'OH'), 0);
  assert.strictEqual(has(market.sellable(room('W33S3', { OH: 10000 }), cfg), 'OH'), 0);
  const up = has(market.sellable(room('W33S3', { OH: 12000 }), cfg), 'OH');
  assert.ok(up > 0 && up <= 2000, 'above floor sells at most the excess ' + up);
  assert.ok(has(market.sellable(room('W37S7', { OH: 9000 }), cfg), 'OH') > 2000, 'other rooms unchanged');
  const mk = { credits: 5000000, createOrder: () => OK };
  const rx = market.postOrder(cfg, mk, 'buy', 'X', 'W32S4', 300, 150);
  assert.ok(rx && rx.result === OK);
  assert.strictEqual(led.buyCredits, 499000);
  assert.strictEqual(led.buyOwn.X, 100000 + Math.round(45000 * 1.05));
  assert.strictEqual(Memory.market.orders['buy:W32S4:X'].own, true);
  assert.strictEqual(market.postOrder(cfg, mk, 'buy', 'O', 'W32S4', 30, 100), null, 'shared budget still applies to O');
  led.buyOwn.X = 1590000;
  assert.strictEqual(market.postOrder(cfg, mk, 'buy', 'X', 'W33S3', 300, 150), null, 'X capped by own budget');
  console.log('OK');
}
console.log('ALL OK');
