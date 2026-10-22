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

global.Game = { time: 5000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] } };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.getRangeTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y)); };
global.PathFinder = { CostMatrix: function () { this.d = {}; this.get = (x, y) => this.d[x + ',' + y] || 0; this.set = (x, y, v) => { this.d[x + ',' + y] = v; }; }, search: (from, goals) => { const g = Array.isArray(goals) ? goals[0] : goals; return { path: [new RoomPosition(g.pos.x + 1, g.pos.y, g.pos.roomName)], incomplete: false, cost: 1 }; } };

const hauler = require('roles_lootHauler');

const mkStore = (o, cap) => Object.assign({}, o, {
  getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + (typeof o[k] === 'number' ? o[k] : 0), 0),
  getCapacity: () => cap || 1000000,
  getFreeCapacity: () => (cap || 1000000) - Object.keys(o).reduce((n, k) => n + (typeof o[k] === 'number' ? o[k] : 0), 0),
});
const part = (type) => ({ type, hits: 100 });

function scene(hostiles, hostileStructs) {
  const storage = { id: 'st', structureType: 'storage', my: false, owner: { username: 'sriptulous' }, store: mkStore({ energy: 928229 }), pos: new RoomPosition(14, 14, 'W39S1') };
  const room = { name: 'W39S1', find: (t) => {
    if (t === FIND_STRUCTURES) return [storage].concat(hostileStructs);
    if (t === FIND_HOSTILE_STRUCTURES) return hostileStructs;
    if (t === FIND_HOSTILE_CREEPS) return hostiles;
    return [];
  }, lookForAt: () => [], getTerrain: () => ({ get: () => 0 }) };
  storage.room = room;
  const calls = [];
  const creep = { name: 'h', memory: { role: 'lootHauler', targetRoom: 'W39S1', home: 'W37S5', salvageLoot: true }, room, pos: new RoomPosition(15, 14, 'W39S1'), store: mkStore({}, 1250), fatigue: 0,
    withdraw: (o, r) => { calls.push(['withdraw', o.id, r]); return OK; } };
  Game.getObjectById = (id) => (id === 'st' ? storage : null);
  Memory.lootBad = {};
  return { creep, calls };
}
const econ = (name, body) => ({ name, owner: { username: 'sriptulous' }, body: body.map(part), pos: new RoomPosition(17, 15, 'W39S1') });

console.log('--- W39S1: only WORK economy creeps, no towers -> hauler withdraws from storage ---');
{
  const { creep, calls } = scene([econ('Builder1', [WORK, CARRY, MOVE]), econ('Miner1', [WORK, WORK, MOVE]), econ('Upgrader1', [WORK, CARRY, MOVE])], []);
  hauler.loadStep(creep, false);
  assert.deepStrictEqual(calls, [['withdraw', 'st', 'energy']]);
  console.log('OK');
}

console.log('--- WORK creeps with a live hostile tower still park the hauler ---');
{
  const tower = { id: 't', structureType: 'tower', my: false, owner: { username: 'sriptulous' }, pos: new RoomPosition(30, 30, 'W39S1') };
  const { creep, calls } = scene([econ('Builder1', [WORK, CARRY, MOVE])], [tower]);
  hauler.loadStep(creep, false);
  assert.deepStrictEqual(calls, []);
  console.log('OK');
}

console.log('--- armed creep (ATTACK) without towers still parks the hauler ---');
{
  const { creep, calls } = scene([econ('Guard', [ATTACK, MOVE])], []);
  hauler.loadStep(creep, false);
  assert.deepStrictEqual(calls, []);
  console.log('OK');
}
console.log('ALL OK');
