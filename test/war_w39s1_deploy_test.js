'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');
const src = path.resolve(__dirname, '../src');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, p, i, o) {
  if (!r.includes('/') && !r.startsWith('.')) {
    const l = path.join(src, r + '.js');
    try { require('fs').accessSync(l); return l; } catch (e) {}
    if (r.startsWith('roles_')) { const q = path.join(src, 'roles', r.slice(6) + '.js'); try { require('fs').accessSync(q); return q; } catch (e) {} }
  }
  return orig.call(this, r, p, i, o);
};

global.Game = { time: 1000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {} };
global.Memory = {};
global.FIND_HOSTILE_SPAWNS = 'hostileSpawns';
global.FIND_HOSTILE_STRUCTURES = 'hostileStructures';
global.FIND_HOSTILE_CREEPS = 'hostileCreeps';
global.FIND_MY_SPAWNS = 'mySpawns';
global.FIND_MY_CREEPS = 'myCreeps';
global.FIND_STRUCTURES = 'structures';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_CONTROLLER = 'controller';
global.RoomPosition = function (x, y, rn) { this.x = x; this.y = y; this.roomName = rn; };
RoomPosition.prototype.isNearTo = function (p) { return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= 1; };
RoomPosition.prototype.inRangeTo = function (p, r) { return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= r; };
RoomPosition.prototype.findClosestByRange = function (list) {
  if (!Array.isArray(list) || !list.length) return null;
  let best = list[0], bd = Infinity;
  for (const o of list) { const d = Math.max(Math.abs(this.x - o.pos.x), Math.abs(this.y - o.pos.y)); if (d < bd) { bd = d; best = o; } }
  return best;
};

Module._resolveFilename = Module._resolveFilename;
require.cache[path.join(src, 'movement.js')] = { id: 'm', filename: path.join(src, 'movement.js'), loaded: true, exports: { go() {} } };
require.cache[path.join(src, 'boost.js')] = { id: 'b', filename: path.join(src, 'boost.js'), loaded: true, exports: {} };
require.cache[path.join(src, 'retire.js')] = { id: 'r', filename: path.join(src, 'retire.js'), loaded: true, exports: { retireAtSpawn() {} } };

const config = require('../src/config');
config.war.noClaimer = false; config.war.noRespawn = false; config.war.attackerMinTtl = 800; config.war.healerEntryTtl = 300;
const war = require('../src/war');
const warrior = require('../src/roles/warrior');

function st(type, x, y, owner) { return { structureType: type, id: type + x + '_' + y, pos: new RoomPosition(x, y, 'W39S1'), owner: { username: owner || 'sriptulous' } }; }
function creepH(x, y, owner) { return { id: 'hc' + x + y, pos: new RoomPosition(x, y, 'W39S1'), owner: { username: owner || 'sriptulous' } }; }

function roomWith(structs, spawns, creeps) {
  return {
    name: 'W39S1',
    find(k) {
      if (k === 'hostileStructures') return structs || [];
      if (k === 'hostileSpawns') return spawns || [];
      if (k === 'hostileCreeps') return creeps || [];
      return [];
    },
  };
}

let pass = 0; const ok = (n) => { console.log('OK ' + n); pass++; };

assert.strictEqual(war.lootWar(), true, 'config.war is the loot war');
assert.strictEqual(war.memKey(), 'lootWarW39S1', 'memKey is lootWarW39S1');

(function attackerNeverHitsLoot() {
  const loot = [
    st('storage', 14, 14), st('terminal', 15, 15), st('factory', 16, 16), st('lab', 17, 17),
    st('container', 8, 20), st('link', 13, 14), st('extension', 20, 13), st('extension', 20, 14),
  ];
  const creep = { pos: new RoomPosition(14, 13, 'W39S1') };
  const t = warrior.lootAttackTarget(creep, roomWith(loot, [], []));
  assert.strictEqual(t, null, 'with every tower/spawn/creep gone and loot adjacent, attacker target is null (never the loot)');
  const loot2 = loot.concat([creepH(14, 15)]);
  const t2 = warrior.lootAttackTarget(creep, roomWith(loot, [], [creepH(14, 15)]));
  assert.ok(t2 && t2.id && t2.id.indexOf('hc') === 0, 'once structures down, hostile creeps are targeted (not loot)');
  ok('attacker NEVER targets storage/terminal/factory/lab/container/link/extension even adjacent with all towers dead; kills creeps instead');
})();

(function towerThenSpawnThenCreep() {
  const creep = { pos: new RoomPosition(26, 0, 'W39S1') };
  const towers = [st('tower', 14, 4), st('tower', 16, 12)];
  const spawn = [st('spawn', 17, 16)];
  const loot = [st('storage', 14, 14), st('extension', 20, 13)];
  let t = warrior.lootAttackTarget(creep, roomWith(towers.concat(loot), spawn, [creepH(20, 20)]));
  assert.deepStrictEqual([t.pos.x, t.pos.y], [16, 12], 'first target is south tower (16,12) per towerOrder, before spawn/creeps');
  t = warrior.lootAttackTarget(creep, roomWith([st('tower', 14, 4)].concat(loot), spawn, [creepH(20, 20)]));
  assert.deepStrictEqual([t.pos.x, t.pos.y], [14, 4], 'then north tower (14,4)');
  t = warrior.lootAttackTarget(creep, roomWith(loot, spawn, [creepH(20, 20)]));
  assert.deepStrictEqual([t.pos.x, t.pos.y], [17, 16], 'towers gone -> spawn (17,16), before creeps');
  t = warrior.lootAttackTarget(creep, roomWith(loot, [], [creepH(20, 20)]));
  assert.deepStrictEqual([t.pos.x, t.pos.y], [20, 20], 'towers+spawn gone -> hostile creep');
  ok('loot targeting order: tower(16,12) -> tower(14,4) -> spawn(17,16) -> hostile creeps; loot never chosen');
})();

(function neverAlly() {
  const creep = { pos: new RoomPosition(10, 10, 'W39S1') };
  const t = warrior.lootAttackTarget(creep, roomWith([st('tower', 14, 4, 'Alepoldar')], [], [creepH(11, 11, 'Alepoldar')]));
  assert.strictEqual(t, null, 'Alepoldar (ally) structures and creeps are never targeted');
  ok('ally guard: Alepoldar towers/creeps never targeted');
})();

(function twoHealerAssignment() {
  const a = { name: 'ATK', id: 'a1', pos: new RoomPosition(15, 11, 'W39S1'), spawning: false, memory: { role: 'warrior', warRole: 'attacker', targetRoom: 'W39S1' }, room: { name: 'W39S1' } };
  const c = { name: 'CLM', id: 'c1', pos: new RoomPosition(32, 30, 'W39S1'), spawning: false, memory: { role: 'warrior', warRole: 'claimer', targetRoom: 'W39S1' }, room: { name: 'W39S1' } };
  const hA = { name: 'HA', id: 'h_aaa', pos: new RoomPosition(32, 29, 'W39S1'), spawning: false, memory: { role: 'warrior', warRole: 'healer', targetRoom: 'W39S1' }, room: { name: 'W39S1' } };
  const hB = { name: 'HB', id: 'h_bbb', pos: new RoomPosition(15, 12, 'W39S1'), spawning: false, memory: { role: 'warrior', warRole: 'healer', targetRoom: 'W39S1' }, room: { name: 'W39S1' } };
  Game.creeps = { ATK: a, CLM: c, HA: hA, HB: hB };
  Game.rooms.W39S1 = { name: 'W39S1', controller: { pos: new RoomPosition(31, 31, 'W39S1'), upgradeBlocked: 500, my: false }, find() { return []; } };
  global.Memory.lootWarW39S1 = { enabled: true, phase: 'assault', squad: { a: 'ATK', h: 'HB', c: 'CLM' } };
  const w = global.Memory.lootWarW39S1;
  const room = Game.rooms.W39S1;
  const leadOfB = warrior.escortLeaderFor(hB, w, room);
  const leadOfA = warrior.escortLeaderFor(hA, w, room);
  assert.strictEqual(leadOfB.name, 'ATK', 'healer id-sorted[0] escorts the attacker');
  assert.strictEqual(leadOfA.name, 'CLM', 'healer id-sorted[1] escorts the claimer');
  assert.strictEqual(warrior.escortHealerFor(a, w, room).name, 'HB', 'attacker <- healerB');
  assert.strictEqual(warrior.escortHealerFor(c, w, room).name, 'HA', 'claimer <- healerA');
  a.fatigue = 0; hB.fatigue = 0;
  assert.strictEqual(warrior.escortReady(a, hB), true, 'attacker ready when healerB adjacent & rested');
  hB.pos = new RoomPosition(10, 10, 'W39S1');
  assert.strictEqual(warrior.escortReady(a, hB), false, 'leader holds when its healer is not adjacent');
  hB.pos = new RoomPosition(15, 12, 'W39S1'); hB.fatigue = 5;
  assert.strictEqual(warrior.escortReady(a, hB), false, 'leader holds when its healer is fatigued');
  ok('two-healer escort: A<->claimer, B<->attacker; leader holds unless its own healer is adjacent and rested');
})();

(function lootSplitGate() {
  global.Memory.lootWarW39S1 = { enabled: true, phase: 'assault' };
  const w = global.Memory.lootWarW39S1;
  delete Memory.lootWarLoot;
  const lockedRoom = { name: 'W39S1', controller: { pos: new RoomPosition(31, 31, 'W39S1'), upgradeBlocked: 900, my: false }, find() { return []; } };
  const openRoom = { name: 'W39S1', controller: { pos: new RoomPosition(31, 31, 'W39S1'), upgradeBlocked: 0, my: false }, find() { return []; } };
  war.lootSplit(w, lockedRoom, false);
  assert.ok(!Memory.lootWarLoot, 'no split while structures still standing');
  war.lootSplit(w, openRoom, true);
  assert.ok(!Memory.lootWarLoot && !w.lootSplitDone, 'no split while controller not locked');
  war.lootSplit(w, lockedRoom, true);
  assert.ok(Memory.lootWarLoot, 'split fires only when towers+spawn dead AND controller locked');
  assert.strictEqual(Memory.lootWarLoot.haulers, 8, '8 haulers to W39S1');
  assert.strictEqual(Memory.lootWarLoot.keepOthers, 6, '6 stay on the other piles');
  assert.strictEqual(Memory.lootWarLoot.unload, 'W37S5', 'unload to W37S5');
  assert.strictEqual(Memory.lootWarLoot.target, 'W39S1', 'target W39S1');
  ok('hauler 8/6 split fires only after towers+spawn dead AND controller locked; sets haulers 8 / keepOthers 6 / unload W37S5');
})();

(function towersDownEvent() {
  global.Memory.lootWarW39S1 = { enabled: true, phase: 'assault', events: [], seen: { spawn: 1, towers: 2 } };
  const w = global.Memory.lootWarW39S1;
  Game.rooms.W39S1 = { name: 'W39S1', controller: { safeMode: 0, upgradeBlocked: 0, pos: new RoomPosition(31, 31, 'W39S1') }, find(k) { return k === 'hostileSpawns' ? [st('spawn', 17, 16)] : []; } };
  war.observe(w);
  assert.ok(w.events.some((e) => e.e === 'towersDown'), 'towersDown event emitted when towers reach 0');
  assert.ok(w.towersDownAt, 'towersDownAt stamped once');
  ok('event: towersDown emitted when the last tower falls');
})();

(function archiveUntouched() {
  global.Memory.ags131War = { enabled: true, phase: 'watch', archiveMarker: true };
  global.Memory.lootWarW39S1 = { enabled: true, phase: 'assault' };
  const w = war.state();
  assert.ok(w && w.phase === 'assault', 'state() reads lootWarW39S1 via memKey');
  assert.ok(Memory.ags131War.archiveMarker === true, 'Memory.ags131War archive is never read/overwritten by the loot war');
  ok('memKey archive: loot war uses Memory.lootWarW39S1; the W38S2 Memory.ags131War is left intact');
})();

console.log('ALL W39S1 DEPLOY TESTS PASSED (' + pass + ')');
