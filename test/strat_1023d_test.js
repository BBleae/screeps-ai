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
global.Game = { time: 1000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: {} };
global.Memory = { rooms: {}, stats: [] };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
const config = require('config');
const hl = require('roles_hauler');
const ok = (c, m) => { assert.ok(c, m); console.log('  ok', m); };
const stx = (o, free) => Object.assign({ getUsedCapacity: () => 0, getFreeCapacity: () => free }, o);

console.log('--- hauler unstashFirst: one hauler takes unstash before collect when the room is calm ---');
ok(config.hauling.unstash.W29S3 === undefined, 'W29S3 rule stays a Memory overlay, not in source config');
ok(JSON.stringify(config.hauling.unstashFirst) === JSON.stringify({ minStorageEnergy: 30000, minFill: 0.8, claimTicks: 100 }), 'config unstashFirst');
config.hauling.unstash.W29S3 = { resource: 'O', target: 14000, terminalFree: 20000 };
const term = { my: true, pos: { x: 10, y: 10, roomName: 'W29S3' }, store: stx({ energy: 30000 }, 269000) };
const stor = { my: true, pos: { x: 12, y: 10, roomName: 'W29S3' }, store: stx({ energy: 52000, O: 178940 }, 700000) };
const r = { name: 'W29S3', terminal: term, storage: stor, energyAvailable: 2300, energyCapacityAvailable: 2300 };
const got = [];
const mk = (name, x) => (Game.creeps[name] = { name, memory: { home: 'W29S3' }, pos: { x, y: 10, roomName: 'W29S3' }, store: stx({}, 450), withdraw: (t, res, n) => { got.push([name, t === stor, res, n]); return OK; } });
const a = mk('a', 13);
const b = mk('b', 11);
let plan = {};
ok(hl.unstashFirst(a, r, { urgent: false }, plan) === true && got[0].join() === 'a,true,O,450' && plan.withdraw, 'calm room: first empty hauler pulls O from storage');
ok(Memory.rooms.W29S3.unstashBy.name === 'a' && Memory.rooms.W29S3.unstashBy.at === 1000, 'claim recorded');
ok(hl.unstashFirst(b, r, { urgent: false }, {}) === false && got.length === 1, 'second hauler keeps doing energy while the claim is fresh');
Game.time = 1050;
a.memory.brokerTask = { kind: 'collect', id: 'x:collect', until: 1060 };
ok(hl.unstashFirst(a, r, { urgent: false }, {}) === true && !a.memory.brokerTask && Memory.rooms.W29S3.unstashBy.at === 1050, 'claimant keeps going, drops its broker lease, claim refreshed');
ok(hl.unstashFirst(a, r, { urgent: true }, {}) === false, 'urgent room (spawn waiting / extensions starving): no early unstash');
r.energyAvailable = 1800;
ok(hl.unstashFirst(a, r, { urgent: false }, {}) === false, 'extensions below 80%: no early unstash');
r.energyAvailable = 2300;
stor.store.energy = 29999;
ok(hl.unstashFirst(a, r, { urgent: false }, {}) === false, 'storage energy below 30000: no early unstash');
stor.store.energy = 52000;
Game.time = 1200;
ok(hl.unstashFirst(b, r, { urgent: false }, {}) === true && Memory.rooms.W29S3.unstashBy.name === 'b', 'stale claim (100 ticks): another hauler can take over');
delete Game.creeps.b;
Game.time = 1201;
ok(hl.unstashFirst(a, r, { urgent: false }, {}) === true && Memory.rooms.W29S3.unstashBy.name === 'a', 'dead claimant: claim moves on at once');
term.store = stx({ energy: 30000, O: 14000 }, 255000);
ok(hl.unstashFirst(a, r, { urgent: false }, {}) === false, 'terminal at target: back to normal hauling');
term.store = stx({ energy: 30000 }, 269000);
const far = mk('far', 40);
Game.time = 1400;
plan = {};
ok(hl.unstashFirst(far, r, { urgent: false }, plan) === true && plan.move === stor, 'not next to storage: walks there');
const other = { name: 'W35S7', terminal: term, storage: stor, energyAvailable: 5600, energyCapacityAvailable: 5600 };
ok(!config.hauling.unstash.W35S7 && hl.unstashFirst(far, other, { urgent: false }, {}) === false, 'rooms without a rule untouched');
const saved = config.hauling.unstashFirst;
delete config.hauling.unstashFirst;
ok(hl.unstashFirst(far, r, { urgent: false }, {}) === false, 'feature off without config');
config.hauling.unstashFirst = saved;
delete config.hauling.unstash.W29S3;
console.log('ALL OK');
