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
const hauler = require('roles_lootHauler');

console.log('--- lootHauler: unload credited to the room the cargo came from ---');
{
  Memory.lootStats = { v: 2, since: 0, by: {}, hours: [] };
  const store = { energy: 1250, getUsedCapacity: () => store.energy, getFreeCapacity: () => 1250 - store.energy };
  const c = { name: 'h1', memory: { role: 'lootHauler', targetRoom: 'W39S1', home: 'W37S5', tripAt: 2900 }, ticksToLive: 600, store, room: { name: 'W38S1' }, body: [{ type: CARRY }], pos: { x: 25, y: 25 } };
  hauler.track(c);
  assert.strictEqual(c.memory.cf, 'W39S1');
  c.memory.targetRoom = 'W37S2';
  c.room = { name: 'W37S5' };
  hauler.track(c);
  assert.strictEqual(c.memory.cf, 'W39S1', 'retarget keeps cargo origin');
  hauler.noteUnload(c, 'energy', 1250);
  store.energy = 0;
  hauler.track(c);
  assert.strictEqual(c.memory.cf, undefined);
  hauler.noteTrip(c);
  const by = Memory.lootStats.by;
  assert.strictEqual(by.W39S1.amt, 1250);
  assert.strictEqual(by.W39S1.res.energy, 1250);
  assert.strictEqual(by.W39S1.to.W37S5, 1250);
  assert.strictEqual(by.W39S1.trips, 1);
  assert.strictEqual(by.W37S2, undefined);
  assert.strictEqual(c.memory.lastFrom, undefined);
  const h = Memory.lootStats.hours[Memory.lootStats.hours.length - 1];
  assert.strictEqual(h.by.W39S1.energy, 1250);
  store.energy = 1250;
  c.room = { name: 'W37S2' };
  hauler.track(c);
  assert.strictEqual(c.memory.cf, 'W37S2');
  c.room = { name: 'W37S5' };
  hauler.noteUnload(c, 'energy', 1000);
  assert.strictEqual(by.W37S2.amt, 1000);
  assert.strictEqual(by.W39S1.amt, 1250);
  console.log('OK');
}

console.log('--- lootHauler: no origin falls back to targetRoom ---');
{
  Memory.lootStats = { v: 2, since: 0, by: {}, hours: [] };
  const c = { name: 'h2', memory: { role: 'lootHauler', targetRoom: 'W35S1', home: 'W37S5' }, ticksToLive: 900, store: { battery: 50 }, room: { name: 'W37S5' }, body: [] };
  hauler.noteUnload(c, 'battery', 50);
  hauler.noteTrip(c);
  assert.strictEqual(Memory.lootStats.by.W35S1.amt, 50);
  assert.strictEqual(Memory.lootStats.by.W35S1.nonE, 50);
  assert.strictEqual(Memory.lootStats.by.W35S1.trips, 1);
  console.log('OK');
}
console.log('ALL OK');
