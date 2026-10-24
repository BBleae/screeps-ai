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

global.Game = { time: 7000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] }, market: {} };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.getRangeTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y)); };

const conquest = require('conquest');
const hauler = require('roles_lootHauler');
const movement = require('movement');
const split = require('loot_split');

const plain = (o) => Object.assign({}, o, { getUsedCapacity: (r) => (r ? o[r] || 0 : Object.keys(o).reduce((n, k) => n + o[k], 0)) });
const P = (x, y, r) => new RoomPosition(x, y, r || 'W35S1');
const bld = (id, type, x, y, store) => ({ id, structureType: type, pos: P(x, y), store: plain(store) });

console.log('--- pickTarget: terminal with minerals ranks before an energy-only storage, even when the storage is closer ---');
{
  const room = { name: 'W35S1' };
  const sto = bld('sto', 'storage', 21, 20, { energy: 800000 });
  const ter = bld('ter', 'terminal', 40, 40, { energy: 20000, KHO2: 5000, UH2O: 3000, ZH2O: 900 });
  const fac = bld('fac', 'factory', 22, 20, { energy: 300 });
  const bat = bld('bat', 'storage', 45, 45, { energy: 100, battery: 40 });
  const t3 = bld('t3', 'terminal', 46, 45, { energy: 100, XUH2O: 10 });
  const ruin = { id: 'ru', pos: P(23, 20), store: plain({ energy: 900 }) };
  const drop = { id: 'dr', pos: P(21, 21), resourceType: 'energy', amount: 30 };
  let list = [];
  const origLT = conquest.loadTargets;
  conquest.loadTargets = () => list;
  const origPF = global.PathFinder;
  global.PathFinder = { search: (from, goals) => { let best = goals[0]; for (const g of goals) if (g.pos.getRangeTo(from) < best.pos.getRangeTo(from)) best = g; return { path: [best.pos], incomplete: false }; } };
  const creep = { name: 'p', memory: { role: 'lootHauler', targetRoom: 'W35S1' }, room, pos: P(20, 20) };
  try {
    Memory.lootBad = {};
    list = [sto, ter];
    assert.strictEqual(hauler.pickTarget(creep).id, 'ter');
    assert.strictEqual(creep.memory.lootTier, 3);
    list = [sto, fac, ter];
    assert.strictEqual(hauler.pickTarget(creep).id, 'ter');
    list = [sto, fac, ruin, drop];
    assert.ok(['sto', 'fac'].indexOf(hauler.pickTarget(creep).id) >= 0, 'energy-only cores still before ruin and drop');
    assert.strictEqual(creep.memory.lootTier, 3);
    list = [sto, ter, bat];
    assert.strictEqual(hauler.pickTarget(creep).id, 'bat', 'storage holding battery beats terminal minerals');
    assert.strictEqual(creep.memory.lootTier, 2);
    list = [sto, ter, bat, t3];
    assert.strictEqual(hauler.pickTarget(creep).id, 't3', 'T3 beats battery and minerals');
    assert.strictEqual(creep.memory.lootTier, 1);
    list = [sto, ter, ruin];
    Memory.lootBad = { W35S1: { ter: Game.time } };
    assert.strictEqual(hauler.pickTarget(creep).id, 'sto', 'terminal blacklisted: storage next');
    Memory.lootBad = {};
    creep.memory.skip = ['ter', Game.time];
    assert.strictEqual(hauler.pickTarget(creep).id, 'sto', 'terminal skipped: storage next');
    delete creep.memory.skip;
    assert.strictEqual(hauler.pickTarget(creep).id, 'ter');
    assert.strictEqual(hauler.loadPick(ter.store), 'KHO2');
    assert.strictEqual(hauler.loadPick(sto.store), 'energy');
  } finally { conquest.loadTargets = origLT; if (origPF) global.PathFinder = origPF; else delete global.PathFinder; }
  console.log('OK');
}

console.log('--- loadStep: approach moves stay inside the room (maxRooms 1) ---');
{
  const room = { name: 'W35S1', find: () => [] };
  const ter = bld('ter', 'terminal', 40, 40, { KHO2: 5000 });
  ter.room = room;
  const origLT = conquest.loadTargets;
  conquest.loadTargets = () => [ter];
  const origPF = global.PathFinder;
  global.PathFinder = { search: (from, goals) => ({ path: [goals[0].pos], incomplete: false }) };
  const origGo = movement.go;
  const calls = [];
  movement.go = (c, t, o) => { calls.push(o); return 0; };
  const origGet = Game.getObjectById;
  Game.getObjectById = (id) => (id === 'ter' ? ter : null);
  try {
    Memory.lootBad = {};
    const creep = { name: 'q', memory: { role: 'lootHauler', targetRoom: 'W35S1', home: 'W37S7' }, room, pos: P(49, 32), fatigue: 0, store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1250 } };
    hauler.loadStep(creep, false);
    assert.ok(calls.length === 1 && calls[0].maxRooms === 1 && calls[0].range === 1);
  } finally { conquest.loadTargets = origLT; movement.go = origGo; Game.getObjectById = origGet; if (origPF) global.PathFinder = origPF; else delete global.PathFinder; }
  console.log('OK');
}

console.log('--- loadStep: no target for 20 ticks -> go home and hold, no re-entry; no jitter before 20 ticks ---');
{
  const room = { name: 'W35S1', find: () => [] };
  const origLT = conquest.loadTargets;
  conquest.loadTargets = () => [];
  const origGo = movement.go;
  const calls = [];
  movement.go = (c, t, o) => { calls.push({ room: t.roomName || (t.pos && t.pos.roomName), o }); return 0; };
  try {
    Memory.lootBad = {};
    delete Memory.conquest;
    const creep = { name: 'r', memory: { role: 'lootHauler', targetRoom: 'W35S1', home: 'W37S7', salvageLoot: true }, room, pos: P(25, 25), fatigue: 0, ticksToLive: 1400, store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1250 } };
    for (let i = 0; i < 20; i++) { Game.time++; hauler.loadStep(creep, false); }
    assert.ok(!creep.memory.idle, 'still parking before 20 ticks');
    assert.strictEqual(calls.length, 0, 'inner tile: no moves');
    Game.time++;
    hauler.loadStep(creep, false);
    assert.ok(creep.memory.idle && creep.memory.idle.room === 'W35S1');
    assert.strictEqual(calls[calls.length - 1].room, 'W37S7', 'heads home');
    const homeRoom = { name: 'W37S7', find: () => [] };
    creep.room = homeRoom;
    creep.pos = P(10, 10, 'W37S7');
    calls.length = 0;
    Game.time++;
    hauler.run(creep);
    assert.strictEqual(calls.length, 0, 'holds at home, does not walk back to the target');
    assert.ok(creep.memory.idle.until > Game.time);
    Game.time += 30;
    hauler.run(creep);
    assert.strictEqual(calls.length, 0);
    Game.time += 40;
    conquest.loadTargets = origLT;
    hauler.run(creep);
    assert.ok(!creep.memory.idle, 'hold ends');
    assert.strictEqual(calls[calls.length - 1].room, 'W35S1', 'then returns to the target room');
    creep.memory.idle = { room: 'W35S1' };
    creep.memory.targetRoom = 'W37S2';
    calls.length = 0;
    hauler.run(creep);
    assert.ok(!creep.memory.idle, 'idle is dropped when the target room changed');
  } finally { conquest.loadTargets = origLT; movement.go = origGo; }
  console.log('OK');
}

console.log('--- loadStep: three stuck rounds in a row -> go home; reaching a target resets the count ---');
{
  const room = { name: 'W35S1', find: () => [] };
  const ter = bld('ter', 'terminal', 40, 40, { KHO2: 5000 });
  const sto = bld('sto', 'storage', 41, 40, { energy: 5000 });
  const byId = { ter, sto };
  const origLT = conquest.loadTargets;
  conquest.loadTargets = () => [ter, sto];
  const origPF = global.PathFinder;
  global.PathFinder = { search: (from, goals) => ({ path: [(Array.isArray(goals) ? goals[0] : goals).pos], incomplete: false }) };
  const origGo = movement.go;
  const calls = [];
  movement.go = (c, t, o) => { calls.push(t.roomName || (t.pos && t.pos.roomName)); return 0; };
  const origGet = Game.getObjectById;
  Game.getObjectById = (id) => byId[id] || null;
  try {
    Memory.lootBad = {};
    const creep = { name: 's', memory: { role: 'lootHauler', targetRoom: 'W35S1', home: 'W37S7', salvageLoot: true }, room, pos: P(49, 32), fatigue: 0, ticksToLive: 1400, store: { getUsedCapacity: () => 0, getFreeCapacity: () => 1250 } };
    let rounds = 0;
    for (let i = 0; i < 200 && !creep.memory.idle; i++) {
      Game.time++;
      const before = creep.memory.stkN || 0;
      hauler.loadStep(creep, false);
      if ((creep.memory.stkN || 0) > before || creep.memory.idle) rounds++;
    }
    assert.strictEqual(rounds, 3);
    assert.ok(creep.memory.idle, 'idle set after the third stuck round');
    assert.ok(!creep.memory.src && !creep.memory.skip && !creep.memory.stk);
    assert.strictEqual(calls[calls.length - 1], 'W37S7');
    delete creep.memory.idle;
    creep.memory.stkN = 2;
    creep.pos = P(39, 40);
    creep.withdraw = () => OK;
    creep.memory.src = 'ter';
    hauler.loadStep(creep, false);
    assert.ok(creep.memory.stkN === undefined, 'arriving next to the target resets the stuck count');
  } finally { conquest.loadTargets = origLT; movement.go = origGo; Game.getObjectById = origGet; if (origPF) global.PathFinder = origPF; else delete global.PathFinder; }
  console.log('OK');
}

console.log('--- finalRun runs at most once per creep (no repeated re-entry) ---');
{
  Game.creeps = {};
  Memory.conquest = [{ type: 'salvageLoot', target: 'W35S1', sponsors: ['W37S5'], phase: 'loot' }];
  const c = { name: 'f', ticksToLive: 900, room: { name: 'W37S5' }, pos: P(25, 25, 'W37S5'), store: { getUsedCapacity: () => 0 }, memory: { role: 'lootHauler', home: 'W37S5', targetRoom: 'W39S1', splitFrom: 'W39S1', salvageLoot: true, src: 'x', skip: ['y', 1], stkN: 2, idle: { room: 'W39S1' } } };
  assert.strictEqual(hauler.finalRun(c), true);
  assert.strictEqual(c.memory.targetRoom, 'W35S1');
  assert.ok(c.memory.stkN === undefined && c.memory.idle === undefined && c.memory.src === undefined);
  c.memory.targetRoom = 'W39S1';
  assert.strictEqual(hauler.finalRun(c), false, 'second call is a no-op');
  assert.strictEqual(c.memory.targetRoom, 'W39S1');
  delete Memory.conquest;
  console.log('OK');
}

console.log('--- runLocks: a lock never takes haulers whose target is the W39S1 split room ---');
{
  const mkStore = (o) => Object.assign({}, o, { getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + o[k], 0) });
  const mk = (name, mem, ttl) => { Game.creeps[name] = { name, memory: Object.assign({ role: 'lootHauler', home: 'W37S5', salvageLoot: true }, mem), ticksToLive: ttl == null ? 1400 : ttl, store: mkStore({}), room: { name: 'W37S5' }, spawning: false }; };
  Game.creeps = {};
  Game.rooms = { W35S1: { name: 'W35S1', find: (t) => (t === FIND_RUINS ? [{ store: mkStore({ battery: 5 }), pos: { x: 1, y: 1 } }] : []) } };
  Memory.conquest = [{ type: 'salvageLoot', target: 'W35S1', sponsors: ['W37S5'], phase: 'loot' }, { type: 'salvageLoot', target: 'W39S1', sponsors: ['W37S5'], phase: 'loot' }];
  Memory.lootWarLoot = { target: 'W39S1', haulers: 3, keepOthers: 6, unload: 'W37S5', since: 1, locks: { W35S1: { n: 5, until: 'ore' } } };
  mk('w1', { targetRoom: 'W39S1', splitFrom: 'W35S1', slotKey: 'split:W39S1:w1' }, 1490);
  mk('w2', { targetRoom: 'W39S1', splitFrom: 'W37S2', slotKey: 'split:W39S1:w2' }, 1480);
  mk('w3', { targetRoom: 'W39S1', slotKey: 'loot:W39S1:W37S5:0' }, 1470);
  mk('a', { targetRoom: 'W35S1' }, 1300);
  mk('b', { targetRoom: 'W37S2' }, 1200);
  const r = split.runLocks(Memory.lootWarLoot, split.settings(), split.liveRooms(), Object.values(Game.creeps));
  assert.deepStrictEqual(r.W35S1.added.sort(), ['a', 'b']);
  for (const n of ['w1', 'w2', 'w3']) assert.ok(!Game.creeps[n].memory.lootLock && Game.creeps[n].memory.targetRoom === 'W39S1', n + ' untouched');
  assert.strictEqual(Memory.lootWarLoot.locks.W35S1.have, 2);
  Game.time += 5;
  split.runLocks(Memory.lootWarLoot, split.settings(), split.liveRooms(), Object.values(Game.creeps));
  for (const n of ['w1', 'w2', 'w3']) assert.ok(!Game.creeps[n].memory.lootLock, n + ' still untouched on later rounds');
  Memory.lootWarLoot.doneAt = Game.time;
  split.runLocks(Memory.lootWarLoot, split.settings(), split.liveRooms(), Object.values(Game.creeps));
  assert.strictEqual(Object.values(Game.creeps).filter((c) => c.memory.lootLock).length, 5, 'W39S1 op done: its haulers may be locked again');
  delete Memory.conquest;
  delete Memory.lootWarLoot;
  console.log('OK');
}
console.log('strat_1025a ok');
