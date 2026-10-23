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

global.Game = { time: 5000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] }, market: {} };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };

const industry = require('industry');
const labTech = require('roles_labTech');

const mkStore = (o, cap) => {
  const s = Object.assign({}, o);
  Object.defineProperty(s, 'getUsedCapacity', { value: () => Object.keys(s).reduce((n, k) => n + s[k], 0) });
  Object.defineProperty(s, 'getCapacity', { value: () => cap });
  Object.defineProperty(s, 'getFreeCapacity', { value: () => cap - s.getUsedCapacity() });
  return s;
};
function room(name, term, stor) {
  const r = { name, terminal: { id: 't' + name, my: true, store: mkStore(term, 300000) }, storage: { id: 's' + name, my: true, store: mkStore(stor, 1000000) } };
  return r;
}
let pass = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok', name); } catch (e) { console.log('  FAIL', name, e.message); process.exitCode = 1; } }

t('spill: terminal 293k with battery biggest → drain battery to storage, amount down to 200k', () => {
  Memory.rooms = {};
  const r = room('W32S4', { battery: 162450, energy: 66372, H: 35825, UL: 29075 }, { energy: 203170 });
  const d = industry.terminalSpill(r);
  assert.ok(d);
  assert.strictEqual(d.mineral, 'battery');
  assert.strictEqual(d.labId, 'tW32S4');
  assert.strictEqual(d.amount, 293722 - 200000);
  assert.strictEqual(d.toStorage, true);
  assert.ok(Memory.rooms.W32S4.terminalSpill);
});

t('spill: energy biggest → energy first', () => {
  Memory.rooms = {};
  const r = room('W33S3', { energy: 136682, battery: 92220, H: 71098 }, { energy: 156145 });
  assert.strictEqual(industry.terminalSpill(r).mineral, 'energy');
});

t('spill: below 250k and not active → nothing', () => {
  Memory.rooms = {};
  const r = room('W31S5', { energy: 100000, battery: 140000 }, {});
  assert.strictEqual(industry.terminalSpill(r), null);
});

t('spill: hysteresis keeps draining between 200k and 250k, stops at 200k', () => {
  Memory.rooms = { W32S4: { terminalSpill: { at: 1 } } };
  const r = room('W32S4', { battery: 150000, energy: 80000 }, {});
  assert.strictEqual(industry.terminalSpill(r).amount, 30000);
  const r2 = room('W32S4', { battery: 130000, energy: 70000 }, {});
  assert.strictEqual(industry.terminalSpill(r2), null);
  assert.strictEqual(Memory.rooms.W32S4.terminalSpill, undefined);
});

t('spill: only battery/energy, other resources never moved', () => {
  Memory.rooms = {};
  const r = room('W32S4', { H: 260000 }, {});
  assert.strictEqual(industry.terminalSpill(r), null);
});

t('spill: storage nearly full → no drain', () => {
  Memory.rooms = {};
  const r = room('W32S4', { battery: 260000 }, { energy: 960000 });
  assert.strictEqual(industry.terminalSpill(r), null);
});

t('spill: Memory.cfg override (enabled false) honoured via config', () => {
  const config = require('config');
  const prev = config.industry.terminalSpill;
  config.industry.terminalSpill = { enabled: false };
  Memory.rooms = {};
  assert.strictEqual(industry.terminalSpill(room('W32S4', { battery: 290000 }, {})), null);
  config.industry.terminalSpill = prev;
});

t('techPlan: spill appended after lab/factory drains', () => {
  Memory.rooms = {};
  const r = room('W32S4', { battery: 290000 }, {});
  r.find = () => [];
  r.controller = { my: true, level: 8 };
  const p = industry.techPlan(r);
  assert.ok(p && p.drains.length >= 1);
  assert.strictEqual(p.drains[p.drains.length - 1].spill, true);
});

t('labTech: spill withdraw then delivers to storage, not back to terminal', () => {
  Memory.rooms = {};
  const r = room('W32S4', { battery: 290000 }, {});
  r.find = () => [];
  r.controller = { my: true, level: 8 };
  Game.rooms = { W32S4: r };
  Game.getObjectById = (id) => (id === 'tW32S4' ? r.terminal : id === 'sW32S4' ? r.storage : null);
  const calls = [];
  const c = { name: 'lt', memory: { role: 'labTech', home: 'W32S4' }, room: r, store: mkStore({}, 1000), pos: {},
    withdraw: (tg, res, amt) => { calls.push(['w', tg.id, res, amt]); c.store[res] = amt; return OK; },
    transfer: (tg, res) => { calls.push(['t', tg.id, res]); delete c.store[res]; return OK; } };
  labTech.run(c);
  assert.deepStrictEqual(calls[0], ['w', 'tW32S4', 'battery', 1000]);
  assert.strictEqual(c.memory.toStorage, true);
  labTech.run(c);
  assert.deepStrictEqual(calls[1], ['t', 'sW32S4', 'battery']);
  assert.strictEqual(c.memory.toStorage, undefined);
});

console.log(pass + ' passed');
