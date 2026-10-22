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
global.FIND_MY_STRUCTURES = 'myStructures';
global.FIND_STRUCTURES = 'structures';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTENSION = 'extension';
global.STRUCTURE_CONTROLLER = 'controller';
global.STRUCTURE_LAB = 'lab';
global.LOOK_STRUCTURES = 'structure';
global.OK = 0; global.TOP = 1;
global.RoomPosition = function (x, y, rn) { this.x = x; this.y = y; this.roomName = rn; };
RoomPosition.prototype.isNearTo = function (p) { return this.roomName === (p.roomName || this.roomName) && Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= 1; };
RoomPosition.prototype.inRangeTo = function (p, r) { return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= r; };
RoomPosition.prototype.findClosestByRange = function (list) {
  if (typeof list === 'string') return null;
  if (!Array.isArray(list) || !list.length) return null;
  let best = list[0], bd = Infinity;
  for (const o of list) { const d = Math.max(Math.abs(this.x - o.pos.x), Math.abs(this.y - o.pos.y)); if (d < bd) { bd = d; best = o; } }
  return best;
};

const moves = [];
require.cache[path.join(src, 'movement.js')] = { id: 'm', filename: path.join(src, 'movement.js'), loaded: true,
  exports: { go(creep, target, opts) { moves.push({ name: creep.name, to: { x: target.x, y: target.y, room: target.roomName }, range: opts && opts.range }); } } };
require.cache[path.join(src, 'boost.js')] = { id: 'b', filename: path.join(src, 'boost.js'), loaded: true, exports: { run() { return false; } } };
const retired = [];
require.cache[path.join(src, 'retire.js')] = { id: 'r', filename: path.join(src, 'retire.js'), loaded: true, exports: { retireAtSpawn(c) { retired.push(c.name); } } };

const war = require('../src/war');
const config = require('../src/config');
config.war.noClaimer = false; config.war.noRespawn = false; config.war.attackerMinTtl = 800; config.war.healerEntryTtl = 300;
const warrior = require('../src/roles/warrior');

let pass = 0; const ok = (n) => { console.log('OK ' + n); pass++; };

assert.strictEqual(war.lootWar(), true);
assert.strictEqual(config.war.costCapTick, 74493500, 'costCapTick pushed to 74493500');
assert.deepStrictEqual(config.war.dismantler.body.reduce((a, p) => (a[p] = (a[p] || 0) + 1, a), {}), { work: 10, move: 10 }, 'dismantler is 10W10M');
assert.strictEqual(config.warW38S2.costCapTick, 74486500, 'W38S2 costCapTick untouched');
ok('config: costCapTick 74493500, dismantler 10W10M, warW38S2 untouched');

// ---- dismantleTargetLoot ----
function S(type, x, y, extra) { return Object.assign({ structureType: type, id: type + x + '_' + y, pos: new RoomPosition(x, y, 'W39S1') }, extra || {}); }
function mkRoom(tiles, towers, spawns) {
  return {
    name: 'W39S1',
    find(k) { if (k === 'hostileStructures') return towers || []; if (k === 'hostileSpawns') return spawns || []; if (k === 'hostileCreeps') return []; return []; },
    lookForAt(kind, x, y) { return (tiles[x + ',' + y] || []).slice(); },
  };
}
const dCreep = (x, y) => ({ name: 'DIS', id: 'dis1', pos: new RoomPosition(x, y, 'W39S1'), room: { name: 'W39S1' } });

(function breachFirst() {
  const tiles = { '28,2': [S('constructedWall', 28, 2)], '16,12': [S('rampart', 16, 12), S('tower', 16, 12)] };
  const towers = [S('tower', 16, 12)];
  const t = warrior.dismantleTargetLoot(dCreep(29, 3), { breachDone: false }, mkRoom(tiles, towers, []));
  assert.ok(t && t.structureType === 'constructedWall' && t.pos.x === 28 && t.pos.y === 2, 'breach wall (28,2) is dismantled first');
  ok('dismantler targets the breach wall (28,2) first');
})();

(function towerRampartsInOrder() {
  const tiles = { '16,12': [S('rampart', 16, 12), S('tower', 16, 12)], '14,4': [S('rampart', 14, 4), S('tower', 14, 4)] };
  const towers = [S('tower', 16, 12), S('tower', 14, 4)];
  const t = warrior.dismantleTargetLoot(dCreep(20, 20), { breachDone: true }, mkRoom(tiles, towers, []));
  assert.ok(t && t.structureType === 'rampart' && t.pos.x === 16 && t.pos.y === 12, 'after breach, dismantles the rampart over tower (16,12) per towerOrder');
  const tiles2 = { '14,4': [S('rampart', 14, 4), S('tower', 14, 4)] };
  const t2 = warrior.dismantleTargetLoot(dCreep(20, 20), { breachDone: true }, mkRoom(tiles2, [S('tower', 14, 4)], []));
  assert.ok(t2 && t2.structureType === 'rampart' && t2.pos.x === 14 && t2.pos.y === 4, 'then the rampart over tower (14,4)');
  ok('dismantler clears tower ramparts in towerOrder (16,12) then (14,4)');
})();

(function spawnRampart() {
  const tiles = { '17,16': [S('rampart', 17, 16), S('spawn', 17, 16)] };
  const t = warrior.dismantleTargetLoot(dCreep(20, 20), { breachDone: true }, mkRoom(tiles, [], [S('spawn', 17, 16)]));
  assert.ok(t && t.structureType === 'rampart' && t.pos.x === 17 && t.pos.y === 16, 'dismantles the rampart over the spawn (17,16)');
  ok('dismantler clears the spawn rampart (17,16)');
})();

(function neverLootNeverBareNeverAlly() {
  // breach done, no tower/spawn ramparts; an objective tower (no rampart) exists.
  // Between creep and tower: ramparts sitting on storage/terminal/factory/lab/container/link/extension, plus bare structures. None may be chosen.
  const tiles = {
    '19,20': [S('rampart', 19, 20), S('storage', 19, 20)],
    '20,19': [S('rampart', 20, 19), S('terminal', 20, 19)],
    '20,21': [S('rampart', 20, 21), S('link', 20, 21)],
    '19,19': [S('rampart', 19, 19), S('extension', 19, 19)],
    '21,20': [S('storage', 21, 20)],
    '20,20b': [],
  };
  const towers = [S('tower', 16, 12)]; // no rampart on it -> not dismantlable by dismantler (attacker kills it)
  const t = warrior.dismantleTargetLoot(dCreep(20, 20), { breachDone: true }, mkRoom(tiles, towers, []));
  assert.strictEqual(t, null, 'never dismantles ramparts covering storage/terminal/factory/lab/container/link/extension, never bare structures, never a bare tower');
  // ally rampart on the tower tile must not be targeted
  const prevAllies = config.allies;
  config.allies = { names: ['Alepoldar'] };
  const tilesAlly = { '16,12': [S('rampart', 16, 12, { owner: { username: 'Alepoldar' } }), S('tower', 16, 12)] };
  const t2 = warrior.dismantleTargetLoot(dCreep(15, 11), { breachDone: true }, mkRoom(tilesAlly, [S('tower', 16, 12)], []));
  assert.strictEqual(t2, null, 'an ally (Alepoldar) rampart is never dismantled');
  config.allies = prevAllies;
  ok('dismantler NEVER targets loot-covering ramparts, bare structures, bare towers, or ally ramparts');
})();

(function pathWallCleared() {
  // breach done, objective tower(16,12) no rampart; a plain constructedWall between creep and tower -> cleared
  const tiles = { '19,13': [S('constructedWall', 19, 13)] };
  const t = warrior.dismantleTargetLoot(dCreep(20, 14), { breachDone: true }, mkRoom(tiles, [S('tower', 16, 12)], []));
  assert.ok(t && t.structureType === 'constructedWall' && t.pos.x === 19 && t.pos.y === 13, 'a plain wall blocking the path toward the tower is cleared');
  ok('dismantler clears a plain path-blocking wall toward the objective');
})();

// ---- recycle on towersDown / no targets ----
(function recycle() {
  retired.length = 0;
  const c = { name: 'DIS', id: 'dis1', pos: new RoomPosition(29, 3, 'W39S1'), room: { name: 'W37S5' }, memory: { warRole: 'dismantler', home: 'W37S5' } };
  Game.rooms.W39S1 = mkRoom({}, [], []);
  // towers down -> recycle: at home, retires
  warrior.runDismantlerLoot(c, { phase: 'assault', towersDownAt: 1000 }, Game.rooms.W39S1);
  assert.ok(c.memory.done, 'towersDown stamps done');
  assert.ok(retired.indexOf('DIS') >= 0, 'dismantler at home recycles (retireAtSpawn) once towers fall');
  ok('dismantler recycles after the towers fall');
})();

// ---- entryCheck 2-healer gate (loot war) ----
function wc(name, role, x, y, ttl, opts) {
  opts = opts || {};
  const parts = { attacker: [['tough', 8], ['attack', 17], ['move', 25]], healer: [['tough', 10], ['heal', 15], ['move', 25]], claimer: [['tough', 4], ['claim', 1], ['move', 5]] }[role];
  const body = [];
  const bmap = { attacker: { tough: 'XGHO2', attack: 'XUH2O', move: null }, healer: { tough: 'XGHO2', heal: 'XLHO2', move: null }, claimer: { tough: 'XGHO2', claim: null, move: null } }[role];
  for (const [t, n] of parts) for (let i = 0; i < n; i++) body.push({ type: t, boost: opts.unboosted ? undefined : bmap[t] });
  return {
    name, id: name, hits: body.length * 100, hitsMax: body.length * 100, ticksToLive: ttl, spawning: !!opts.spawning, fatigue: 0, body,
    room: { name: x >= 0 ? (opts.room || 'W39S0') : 'W37S5' }, pos: new RoomPosition(x, y, opts.room || 'W39S0'),
    memory: { role: 'warrior', warRole: role, home: 'W37S5', targetRoom: 'W39S1', boosts: opts.unboosted ? [] : (role === 'claimer' ? ['XGHO2'] : role === 'attacker' ? ['XGHO2', 'XUH2O'] : ['XGHO2', 'XLHO2']), boostDone: true, slotKey: 'war:' + role + ':' + (opts.slot == null ? 0 : opts.slot) },
  };
}

(function entryGate() {
  Game.time = 2000;
  Memory.lootWarW39S1 = { enabled: true, phase: 'staging', plan: { reliefSpawn: 2500 } };
  const w = Memory.lootWarW39S1;
  const a = wc('A', 'attacker', 25, 45, 1200);
  const h1 = wc('H1', 'healer', 26, 45, 1300, { slot: 'n' });
  const c = wc('C', 'claimer', 26, 45, 800);
  Game.creeps = { A: a, H1: h1, C: c };
  let chk = war.entryCheck(w);
  assert.ok(!chk.ok && chk.why === 'healers' && chk.need === 2, 'loot-war entry blocked with only ONE healer (need 2): ' + JSON.stringify(chk));
  const h2 = wc('H2', 'healer', 27, 45, 1300, { slot: 1 });
  Game.creeps.H2 = h2;
  chk = war.entryCheck(w);
  assert.ok(chk.ok === true, 'loot-war entry proceeds once TWO boosted healthy healers are staged: ' + JSON.stringify(chk));
  ok('entry requires TWO healers staged (A escorts claimer, B escorts attacker) plus attacker and claimer');
})();

// ---- staging demands: 2nd healer + unboosted dismantler ----
function labRoom() {
  const labs = [];
  for (let i = 0; i < 6; i++) labs.push({ structureType: 'lab', id: 'lab' + i, store: { XGHO2: 9000, XLHO2: 9000, XUH2O: 9000, XZH2O: 9000, energy: 9000 }, pos: new RoomPosition(30 + i, 30, 'W37S5') });
  return {
    name: 'W37S5',
    find(k) { if (k === 'myStructures') return labs; return []; },
    controller: { my: true, level: 8 },
  };
}

(function stagingExtras() {
  Game.time = 3000;
  Memory.lootWarW39S1 = { enabled: true, phase: 'staging', seen: { spawn: 1, towers: 2 } };
  const w = Memory.lootWarW39S1;
  const a = wc('A', 'attacker', 25, 45, 1200, { slot: 0 });
  const h1 = wc('H1', 'healer', 26, 45, 1300, { slot: 'n' });
  const c = wc('C', 'claimer', 24, 45, 800, { slot: 0 });
  Game.creeps = { A: a, H1: h1, C: c };
  const dem = war.getDemands(labRoom());
  const keys = dem.map((d) => d.key);
  assert.ok(keys.indexOf('war:healer:1') >= 0, 'a SECOND healer (war:healer:1) is requested in staging: ' + JSON.stringify(keys));
  assert.ok(keys.indexOf('war:dismantler:0') >= 0, 'the breach dismantler (war:dismantler:0) is requested in staging: ' + JSON.stringify(keys));
  const dd = dem.find((d) => d.key === 'war:dismantler:0');
  assert.deepStrictEqual(dd.memory.boosts, [], 'dismantler is requested UNBOOSTED (boosts: [])');
  const body = dd.body(100000);
  assert.deepStrictEqual(body.reduce((x, p) => (x[p] = (x[p] || 0) + 1, x), {}), { work: 10, move: 10 }, 'dismantler body is 10W10M');
  ok('staging requests a 2nd healer and an unboosted 10W10M breach dismantler');
})();

(function noDismantlerAfterBreach() {
  Game.time = 3100;
  Memory.lootWarW39S1 = { enabled: true, phase: 'staging', breachDone: 3050, seen: { spawn: 1, towers: 2 } };
  const a = wc('A', 'attacker', 25, 45, 1200, { slot: 0 });
  const h1 = wc('H1', 'healer', 26, 45, 1300, { slot: 'n' });
  const h2 = wc('H2', 'healer', 27, 45, 1300, { slot: 1 });
  const c = wc('C', 'claimer', 24, 45, 800, { slot: 0 });
  Game.creeps = { A: a, H1: h1, H2: h2, C: c };
  const dem = war.getDemands(labRoom());
  const keys = dem.map((d) => d.key);
  assert.ok(keys.indexOf('war:dismantler:0') < 0, 'no dismantler requested once breach is done');
  assert.ok(keys.indexOf('war:healer:1') < 0, 'no 3rd healer requested (already 2)');
  ok('dismantler is not requested after the breach is done; healers cap at 2');
})();

console.log('ALL W39S1 SQUAD TESTS PASSED (' + pass + ')');
