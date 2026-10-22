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

global.Game = { time: 5000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 8, findRoute: () => new Array(8).fill({ exit: 1, room: 'X' }) } };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.getRangeTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y)); };
RoomPosition.prototype.isNearTo = function (p) { return this.roomName === (p.roomName || (p.pos && p.pos.roomName)) && this.getRangeTo(p) <= 1; };
global.PathFinder = { CostMatrix: function () { this.d = {}; this.get = (x, y) => this.d[x + ',' + y] || 0; this.set = (x, y, v) => { this.d[x + ',' + y] = v; }; }, search: (from, goals) => { const gs = Array.isArray(goals) ? goals : [goals]; let g = gs[0]; for (const x of gs) if (from.getRangeTo(x.pos) < from.getRangeTo(g.pos)) g = x; return { path: [new RoomPosition(g.pos.x + 1, g.pos.y, g.pos.roomName)], incomplete: false, cost: 1 }; } };

const movement = require('movement');
const retire = require('retire');
const hauler = require('roles_lootHauler');

const spawn = { id: 'sp', pos: new RoomPosition(20, 20, 'W37S5'), recycleCreep: () => OK };
Game.rooms.W37S5 = { name: 'W37S5', controller: { my: true }, find: (t) => (t === FIND_MY_SPAWNS ? [spawn] : []) };
Game.getObjectById = (id) => (id === 'sp' ? spawn : null);
let moves = 0;
movement.go = () => { moves++; return OK; };

function mk(name, ttl, boost) {
  let died = 0;
  const body = [{ type: HEAL, hits: 100, boost: boost || undefined }, { type: MOVE, hits: 100 }];
  const c = { name, memory: { role: 'warrior' }, ticksToLive: ttl, body, pos: new RoomPosition(25, 25, 'W39S1'), spawning: false, suicide: () => { died++; return OK; } };
  return { c, died: () => died };
}

console.log('--- unboosted creep that cannot walk home still suicides (unchanged) ---');
{
  const { c, died } = mk('u', 130, null);
  assert.strictEqual(retire.retireAtSpawn(c), 'suicide');
  assert.strictEqual(died(), 1);
  console.log('OK');
}

console.log('--- boosted creep never suicides: walks home even when TTL looks short ---');
{
  moves = 0;
  const { c, died } = mk('b', 130, 'XLHO2');
  const r = retire.retireAtSpawn(c);
  assert.strictEqual(r, 'walk');
  assert.strictEqual(died(), 0);
  assert.strictEqual(moves, 1);
  Game.time += 20;
  assert.strictEqual(retire.retireAtSpawn(c), 'walk', 'recheck keeps walking');
  assert.strictEqual(died(), 0);
  console.log('OK');
}

console.log('--- boosted creep with enough TTL walks home and recycles at the spawn ---');
{
  const { c, died } = mk('b2', 900, 'XGHO2');
  assert.strictEqual(retire.retireAtSpawn(c), 'walk');
  c.pos = new RoomPosition(21, 20, 'W37S5');
  Game.time += 1;
  assert.strictEqual(retire.retireAtSpawn(c), 'recycle');
  assert.strictEqual(died(), 0);
  console.log('OK');
}

console.log('--- boosted creep with a failed recycle holds instead of suiciding ---');
{
  spawn.recycleCreep = () => ERR_BUSY;
  const { c, died } = mk('b3', 900, 'XGHO2');
  c.pos = new RoomPosition(21, 20, 'W37S5');
  Game.time += 1;
  assert.strictEqual(retire.retireAtSpawn(c), 'hold');
  assert.strictEqual(died(), 0);
  spawn.recycleCreep = () => OK;
  console.log('OK');
}

const mkStore = (o, cap) => Object.assign({}, o, {
  getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + (typeof o[k] === 'number' ? o[k] : 0), 0),
  getCapacity: () => cap || 1000000,
  getFreeCapacity: () => (cap || 1000000) - Object.keys(o).reduce((n, k) => n + (typeof o[k] === 'number' ? o[k] : 0), 0),
});

console.log('--- salvage hauler: storage before nearer energy containers/extensions; T3 still first ---');
{
  const storage = { id: 'st', structureType: 'storage', owner: { username: 'e' }, store: mkStore({ energy: 900000 }), pos: new RoomPosition(14, 14, 'W39S1') };
  const cont = { id: 'ct', structureType: 'container', store: mkStore({ energy: 1900 }), pos: new RoomPosition(8, 20, 'W39S1') };
  const ext = { id: 'ex', structureType: 'extension', owner: { username: 'e' }, store: mkStore({ energy: 50 }), pos: new RoomPosition(9, 18, 'W39S1') };
  const tomb = { id: 'tb', store: mkStore({ XGHO2: 5 }), pos: new RoomPosition(30, 30, 'W39S1') };
  let ruins = [];
  const room = { name: 'W39S1', find: (t) => (t === FIND_STRUCTURES ? [storage, cont, ext] : t === FIND_TOMBSTONES ? ruins : []), lookForAt: () => [], getTerrain: () => ({ get: () => 0 }) };
  const creep = { name: 'h', memory: { role: 'lootHauler', targetRoom: 'W39S1', home: 'W37S5', salvageLoot: true }, room, pos: new RoomPosition(8, 19, 'W39S1') };
  Memory.lootBad = {};
  assert.strictEqual(hauler.pickTarget(creep).id, 'st', 'storage first though container is adjacent');
  ruins = [tomb];
  assert.strictEqual(hauler.pickTarget(creep).id, 'tb', 'T3 tombstone still beats storage');
  ruins = [];
  storage.store = mkStore({});
  room.find = (t) => (t === FIND_STRUCTURES ? [cont, ext] : []);
  assert.strictEqual(hauler.pickTarget(creep).id, 'ct', 'falls back to nearest other energy');
  creep.memory = { role: 'lootHauler', targetRoom: 'W29S4', home: 'W31S5', sideLoot: true, lootOrder: ['power', 'energy'] };
  room.find = (t) => (t === FIND_STRUCTURES ? [storage, cont, ext] : []);
  storage.store = mkStore({ energy: 900000 });
  assert.ok(hauler.pickTarget(creep), 'side loot path unchanged');
  console.log('OK');
}
console.log('ALL OK');
