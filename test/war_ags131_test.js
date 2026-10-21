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

global.Game = { time: 1000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {} };
global.Memory = {};
global.FIND_HOSTILE_SPAWNS = 'hostileSpawns';
global.FIND_HOSTILE_STRUCTURES = 'hostileStructures';
global.FIND_HOSTILE_CREEPS = 'hostileCreeps';
global.FIND_MY_SPAWNS = 'mySpawns';
global.FIND_MY_CREEPS = 'myCreeps';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_CONTROLLER = 'controller';
global.STRUCTURE_SPAWN = 'spawn';
global.ERR_NOT_IN_RANGE = -9;
global.OK = 0;
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.isNearTo = function (p) { return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= 1; };
RoomPosition.prototype.inRangeTo = function (p, r) { return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= r; };
RoomPosition.prototype.isEqualTo = function (p) { return this.x === p.x && this.y === p.y && this.roomName === p.roomName; };

const war = require('../src/war');
const config = require('../src/config');

function mkCreep(name, warRole, roomName, hits, hitsMax, ttl, x, y) {
  const c = {
    name, id: name, hits: hits == null ? 1000 : hits, hitsMax: hitsMax || 1000,
    ticksToLive: ttl == null ? 1500 : ttl, spawning: false,
    room: { name: roomName },
    pos: new RoomPosition(x || 25, y || 25, roomName),
    memory: { role: 'warrior', warRole, home: 'W37S5', targetRoom: 'W38S2', boosts: [], boostDone: true },
    body: [], store: {},
  };
  Game.creeps[name] = c;
  return c;
}

function reset() {
  Game.time = 1000;
  Game.creeps = {};
  Game.rooms = {};
  Game.cpu.bucket = 10000;
  Memory.ags131War = { enabled: true, phase: 'staging', events: [] };
}

console.log('--- war switch off ---');
Memory.ags131War = undefined;
assert.strictEqual(war.active(), false);
assert.deepStrictEqual(war.getDemands({ name: 'W37S5', controller: { my: true }, energyCapacityAvailable: 5600 }), []);
assert.strictEqual(war.lootHaulerCap(14), 14);
console.log('OK switch off: no demands, no loot cut');

console.log('--- staging gate ---');
reset();
war.tick();
assert.strictEqual(Memory.ags131War.phase, 'staging');
mkCreep('a', 'attacker', 'W38S3', 1000, 1000, 1200);
mkCreep('h', 'healer', 'W38S3', 1000, 1000, 1200);
mkCreep('c', 'claimer', 'W38S3', 1000, 1000, 600);
war.tick();
assert.strictEqual(Memory.ags131War.phase, 'assault', 'full squad + healer full + attacker ttl>=900 -> assault');
assert.ok(Memory.ags131War.events.some((e) => e.e === 'entered'));
console.log('OK staging gate enters assault');

console.log('--- ttl gate ---');
reset();
mkCreep('a', 'attacker', 'W38S3', 1000, 1000, 800);
mkCreep('h', 'healer', 'W38S3', 1000, 1000, 1200);
mkCreep('c', 'claimer', 'W38S3', 1000, 1000, 600);
war.tick();
assert.strictEqual(Memory.ags131War.phase, 'staging', 'attacker ttl 800 < 900 stays staging');
console.log('OK ttl gate');

console.log('--- healer hurt gate ---');
reset();
mkCreep('a', 'attacker', 'W38S3', 1000, 1000, 1200);
mkCreep('h', 'healer', 'W38S3', 500, 1000, 1200);
mkCreep('c', 'claimer', 'W38S3', 1000, 1000, 600);
war.tick();
assert.strictEqual(Memory.ags131War.phase, 'staging');
console.log('OK healer must be full HP');

console.log('--- safe mode retreat ---');
reset();
Memory.ags131War.phase = 'assault';
Game.rooms.W38S2 = {
  name: 'W38S2',
  controller: { safeMode: 5000, upgradeBlocked: 0 },
  find: (t) => [],
};
war.tick();
assert.strictEqual(Memory.ags131War.phase, 'safemode');
assert.ok(Memory.ags131War.events.some((e) => e.e === 'safeModeSeen'));
assert.ok(Memory.ags131War.events.some((e) => e.e === 'retreat'));
console.log('OK safeMode -> retreat');

console.log('--- safe mode resume with 500 lead ---');
reset();
Memory.ags131War.phase = 'safemode';
Memory.ags131War.safeModeEnd = 1400;
Game.time = 901; // left=499 < 500
war.tick();
assert.strictEqual(Memory.ags131War.phase, 'staging', 'resume when safeMode left < 500');
console.log('OK resume lead');

console.log('--- lootHauler cut under CPU pressure ---');
reset();
Memory.cpuRoll = { avg: 160, n: 100, at: Game.time };
assert.strictEqual(war.lootHaulerCap(14), 10);
Memory.cpuRoll = { avg: 100, n: 100, at: Game.time };
assert.strictEqual(war.lootHaulerCap(14), 14);
console.log('OK lootHauler 14->10 when avg>=150');

console.log('--- demands when enabled ---');
reset();
const room = { name: 'W37S5', controller: { my: true }, energyCapacityAvailable: 5600 };
const d = war.getDemands(room);
assert.ok(d.some((r) => r.memory.warRole === 'attacker'));
assert.ok(d.some((r) => r.memory.warRole === 'healer'));
assert.ok(d.filter((r) => r.memory.warRole === 'claimer').length >= 1);
Game.cpu.bucket = 4000;
assert.deepStrictEqual(war.getDemands(room), []);
console.log('OK demands + bucket gate');

console.log('--- bodies energy ---');
const bodies = {
  attacker: Array(8).fill('tough').concat(Array(17).fill('attack'), Array(25).fill('move')),
  healer: Array(10).fill('tough').concat(Array(15).fill('heal'), Array(25).fill('move')),
  claimer: Array(10).fill('tough').concat(Array(4).fill('claim'), Array(14).fill('move')),
};
const COST = { tough: 10, attack: 80, heal: 250, claim: 600, move: 50 };
function cost(b) { return b.reduce((s, p) => s + COST[p], 0); }
assert.strictEqual(cost(bodies.attacker), 2690);
assert.strictEqual(cost(bodies.healer), 5100);
assert.strictEqual(cost(bodies.claimer), 3200);
assert.ok(cost(bodies.healer) <= 5600);
console.log('OK body costs', { a: 2690, h: 5100, c: 3200 });

console.log('--- boost amounts ---');
const boost = { attacker: { XGHO2: 8 * 30, XUH2O: 17 * 30 }, healer: { XGHO2: 10 * 30, XLHO2: 15 * 30 }, claimer: { XGHO2: 10 * 30 } };
console.log('OK boosts', boost);
assert.strictEqual(boost.attacker.XGHO2 + boost.healer.XGHO2 + boost.claimer.XGHO2, 840);

console.log('ALL WAR SCENARIO TESTS PASSED');
