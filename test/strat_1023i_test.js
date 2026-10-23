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
const hauler = require('roles_lootHauler');
const config = require('config');
const mkStore = (o) => Object.assign({}, o, { getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + (typeof o[k] === 'number' ? o[k] : 0), 0), getCapacity: () => 1000000, getFreeCapacity: () => 1000000 });
function setup(roomName) {
  const storage = { id: 'st', structureType: 'storage', owner: { username: 'e' }, store: mkStore({ energy: 195000, H: 5000 }), pos: new RoomPosition(26, 18, roomName) };
  const tomb = { id: 'tb', store: mkStore({ XGHO2: 5 }), pos: new RoomPosition(27, 18, roomName) };
  const drops = [
    { id: 'd1', resourceType: 'energy', amount: 9471, pos: new RoomPosition(30, 19, roomName) },
    { id: 'd2', resourceType: 'energy', amount: 7783, pos: new RoomPosition(30, 20, roomName) },
    { id: 'd3', resourceType: 'energy', amount: 400, pos: new RoomPosition(27, 19, roomName) },
    { id: 'd4', resourceType: 'H', amount: 900, pos: new RoomPosition(27, 17, roomName) },
  ];
  const st = { ruins: [tomb], drops };
  const room = { name: roomName, find: (t) => (t === FIND_STRUCTURES ? [storage] : t === FIND_TOMBSTONES ? st.ruins : t === FIND_DROPPED_RESOURCES ? st.drops : []), lookForAt: () => [], getTerrain: () => ({ get: () => 0 }) };
  const creep = { name: 'h', memory: { role: 'lootHauler', targetRoom: roomName, home: 'W37S5', salvageLoot: true }, room, pos: new RoomPosition(26, 19, roomName) };
  return { creep, st, storage };
}
let n = 0;
function t(name, fn) { fn(); n++; console.log('OK', name); }
t('W37S2: energy drop >500 picked before T3 tombstone and storage, nearest such pile', () => {
  Memory.lootBad = {};
  const { creep } = setup('W37S2');
  const o = hauler.pickTarget(creep);
  assert.ok(o.id === 'd1' || o.id === 'd2', o.id);
  assert.strictEqual(creep.memory.lootTier, 3, 'tier 3 so loadStep keeps walking to it');
});
t('W35S1 also covered', () => {
  Memory.lootBad = {};
  const { creep } = setup('W35S1');
  assert.ok(['d1', 'd2'].indexOf(hauler.pickTarget(creep).id) >= 0);
});
t('pile <=500 or non-energy drop not boosted: T3 tombstone first, then storage', () => {
  Memory.lootBad = {};
  const { creep, st } = setup('W37S2');
  st.drops = st.drops.filter((d) => d.id === 'd3' || d.id === 'd4');
  assert.strictEqual(hauler.pickTarget(creep).id, 'tb');
  st.ruins = [];
  assert.strictEqual(hauler.pickTarget(creep).id, 'st');
});
t('other rooms unchanged: storage/T3 order as before', () => {
  Memory.lootBad = {};
  const { creep, st } = setup('W39S1');
  assert.strictEqual(hauler.pickTarget(creep).id, 'tb');
  st.ruins = [];
  assert.strictEqual(hauler.pickTarget(creep).id, 'st');
});
t('side loot path ignores dropFirst', () => {
  Memory.lootBad = {};
  const { creep } = setup('W37S2');
  creep.memory.sideLoot = true; creep.memory.lootOrder = ['H'];
  assert.notStrictEqual(hauler.pickTarget(creep).id, 'd1');
});
t('config override: rooms [] disables', () => {
  Memory.lootBad = {};
  const prev = config.conquest.dropFirst;
  config.conquest.dropFirst = { rooms: [], min: 500 };
  const { creep } = setup('W37S2');
  assert.strictEqual(hauler.pickTarget(creep).id, 'tb');
  config.conquest.dropFirst = prev;
});
t('dropFirstOf: >500 strictly', () => {
  const { creep } = setup('W37S2');
  const l = hauler.dropFirstOf(creep, [{ resourceType: 'energy', amount: 500 }, { resourceType: 'energy', amount: 501 }]);
  assert.strictEqual(l.length, 1);
});
console.log(n + ' passed');
