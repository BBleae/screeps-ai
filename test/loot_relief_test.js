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

const EXITS = {
  W37S5: ['W38S5', 'W37S4', 'W36S5', 'W37S6'], W38S5: ['W37S5', 'W38S4', 'W38S6', 'W39S5'], W38S4: ['W38S5', 'W37S4', 'W38S3', 'W39S4'],
  W37S4: ['W38S4', 'W37S5', 'W37S3', 'W36S4'], W37S3: ['W37S4', 'W37S2', 'W36S3', 'W38S3'], W37S2: ['W37S3', 'W38S2', 'W37S1', 'W36S2'],
  W38S2: ['W37S2', 'W38S1', 'W38S3', 'W39S2'], W38S1: ['W38S2', 'W38S0', 'W37S1', 'W39S1x'], W38S0: ['W38S1', 'W39S0', 'W37S0'],
  W39S0: ['W38S0', 'W39S1', 'W40S0'], W39S1: ['W39S0'], W38S3: ['W38S2', 'W38S4', 'W37S3', 'W39S3'], W37S1: ['W37S2', 'W38S1', 'W36S1', 'W37S0'],
  W36S1: ['W37S1', 'W36S2', 'W36S0'], W36S2: ['W37S2', 'W36S1', 'W36S3'], W37S0: ['W38S0', 'W37S1', 'W36S0'], W36S0: ['W37S0', 'W36S1'],
  W39S2: ['W38S2', 'W39S3'], W39S3: ['W39S2', 'W38S3', 'W39S4'], W39S4: ['W39S3', 'W38S4', 'W39S5'], W39S5: ['W39S4', 'W38S5'],
  W40S0: ['W39S0'], W36S3: ['W37S3', 'W36S2', 'W36S4'], W36S4: ['W37S4', 'W36S3', 'W36S5'], W36S5: ['W37S5', 'W36S4'], W37S6: ['W37S5'], W38S6: ['W38S5'],
};
function findRoute(from, to, opts) {
  const cb = opts && opts.routeCallback;
  const prev = { [from]: null };
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === to) break;
    for (const n of EXITS[cur] || []) {
      if (n in prev || !EXITS[n]) continue;
      if (cb && cb(n, cur) === Infinity) continue;
      prev[n] = cur;
      q.push(n);
    }
  }
  if (!(to in prev)) return -2;
  const out = [];
  for (let c = to; c !== from; c = prev[c]) out.unshift({ exit: 1, room: c });
  return out;
}

global.Game = { time: 2000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute } };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.getRangeTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y)); };

const config = require('config');
const hauler = require('roles_lootHauler');
const movement = require('movement');
const split = require('loot_split');
const overlay = require('cfg_overlay');

const mkStore = (o, cap) => Object.assign({}, o, {
  getUsedCapacity: () => Object.keys(o).reduce((n, k) => n + o[k], 0),
  getCapacity: () => cap || 1000000,
  getFreeCapacity: () => (cap || 1000000) - Object.keys(o).reduce((n, k) => n + o[k], 0),
});
const ownRoom = (name, used) => ({ name, controller: { my: true, level: 8 }, storage: { pos: new RoomPosition(25, 25, name), store: mkStore({ energy: used || 100000 }) }, find: () => [] });
const utils = require('utils');
const conquest = require('conquest');

function mkCreep(name, mem, ttl, used, room) {
  const c = { name, memory: mem, ticksToLive: ttl, store: mkStore(used ? { energy: used } : {}, 1250), room: { name: room || 'W37S5' }, pos: new RoomPosition(25, 25, room || 'W37S5') };
  Memory.creeps[name] = mem;
  return c;
}
function stepsCache() {
  Memory.lootDrop = { _steps: {
    'W39S1:W37S5': { s: 345, n: 341, ok: 1, at: Game.time }, 'W37S5:W39S1': { s: 341, n: 329, ok: 1, at: Game.time },
    'W37S5:W37S2': { s: 120, n: 110, ok: 1, at: Game.time }, 'W37S2:W37S5': { s: 120, n: 110, ok: 1, at: Game.time },
    'W37S5:W35S1': { s: 200, n: 190, ok: 1, at: Game.time }, 'W35S1:W37S5': { s: 200, n: 190, ok: 1, at: Game.time },
  } };
}
Game.rooms = { W37S5: ownRoom('W37S5'), W39S1: { name: 'W39S1', find: (t) => (t === FIND_STRUCTURES ? [{ structureType: 'storage', store: mkStore({ energy: 900000 }), pos: new RoomPosition(14, 14, 'W39S1') }] : []) } };

console.log('--- relief threshold = W39S1 round trip + spawn time ---');
{
  stepsCache();
  Memory.lootWarLoot = { target: 'W39S1', haulers: 8, keepOthers: 6, unload: 'W37S5', since: 2000 };
  const r = split.reliefTtl(Memory.lootWarLoot, split.settings());
  assert.strictEqual(r, Math.round(345 * 1.2 + 50 + 341 + 150));
  Memory.lootWarLoot.reliefTtl = 700;
  assert.strictEqual(split.reliefTtl(Memory.lootWarLoot, split.settings()), 700, 'Memory override');
  delete Memory.lootWarLoot.reliefTtl;
  console.log('OK');
}

console.log('--- old W39S1 hauler under relief TTL: a fresh hauler is pulled in early, old one keeps working ---');
{
  stepsCache();
  Game.creeps = {}; Memory.creeps = {};
  for (let i = 0; i < 8; i++) Game.creeps['w' + i] = mkCreep('w' + i, { role: 'lootHauler', home: 'W37S5', targetRoom: 'W39S1', salvageLoot: true, splitFrom: 'W35S1', slotKey: 'split:W39S1:w' + i }, i === 0 ? 900 : 1300, 0, 'W38S2');
  for (let i = 0; i < 3; i++) Game.creeps['f' + i] = mkCreep('f' + i, { role: 'lootHauler', home: 'W37S5', targetRoom: 'W35S1', salvageLoot: true, slotKey: 'loot:W35S1:W37S5:' + i }, 1450 - i, 0);
  Game.creeps.side = mkCreep('side', { role: 'lootHauler', home: 'W31S5', targetRoom: 'W29S4', sideLoot: true }, 1450, 0);
  const r = split.run(true);
  assert.strictEqual(r.moved, 1);
  assert.deepStrictEqual(r.names, ['f0']);
  assert.strictEqual(Game.creeps.w0.memory.targetRoom, 'W39S1', 'old hauler not touched');
  assert.strictEqual(Memory.lootWarLoot.active, 8);
  assert.deepStrictEqual(Memory.lootWarLoot.relief, ['w0']);
  assert.strictEqual(Memory.lootWarLoot.events.slice(-1)[0].e, 'relief');
  assert.strictEqual(split.run(true).moved, 0, 'stable');
  assert.strictEqual(Game.creeps.side.memory.targetRoom, 'W29S4');
  console.log('OK');
}

console.log('--- no relief needed when all TTLs are above the threshold (unchanged behaviour) ---');
{
  Game.creeps = {}; Memory.creeps = {};
  for (let i = 0; i < 8; i++) Game.creeps['w' + i] = mkCreep('w' + i, { role: 'lootHauler', home: 'W37S5', targetRoom: 'W39S1', salvageLoot: true, splitFrom: 'W35S1' }, 1300, 0, 'W38S2');
  Game.creeps.f0 = mkCreep('f0', { role: 'lootHauler', home: 'W37S5', targetRoom: 'W35S1', salvageLoot: true }, 1450, 0);
  assert.strictEqual(split.run(true).moved, 0);
  assert.strictEqual(Game.creeps.f0.memory.targetRoom, 'W35S1');
  console.log('OK');
}

console.log('--- final run: split hauler too short for W39S1 goes to the shorter fitting salvage room, not the spawn ---');
{
  stepsCache();
  const dirs = [{ type: 'salvageLoot', target: 'W37S2' }, { type: 'salvageLoot', target: 'W35S1' }];
  const orig = conquest.directives;
  conquest.directives = () => dirs;
  const mk = (ttl) => ({ name: 'x', ticksToLive: ttl, room: { name: 'W37S5' }, pos: new RoomPosition(25, 25, 'W37S5'), memory: { role: 'lootHauler', home: 'W37S5', targetRoom: 'W39S1', salvageLoot: true, splitFrom: 'W35S1', splitTiles: [[1, 2]], splitAt: 10, src: 'a', drop: 'W37S5' } });
  const a = mk(700);
  assert.strictEqual(hauler.finalRun(a), true);
  assert.strictEqual(a.memory.targetRoom, 'W37S2', 'W37S2 is the cheaper trip that fits');
  assert.ok(a.memory.finalRun && a.memory.finalRun.from === 'W39S1' && a.memory.finalRun.to === 'W37S2');
  assert.ok(!a.memory.splitFrom && !a.memory.src && !a.memory.drop);
  assert.strictEqual(a.memory.lootTiles, null);
  assert.strictEqual(hauler.finalRun(a), false, 'only one final run');
  const b = mk(200);
  assert.strictEqual(hauler.finalRun(b), false, 'not even W37S2 fits -> retire as before');
  assert.strictEqual(b.memory.targetRoom, 'W39S1');
  dirs.shift();
  const c = mk(700);
  assert.strictEqual(hauler.finalRun(c), true);
  assert.strictEqual(c.memory.targetRoom, 'W35S1');
  assert.deepStrictEqual(c.memory.lootTiles, [[1, 2]], 'origin tiles restored');
  dirs.length = 0;
  assert.strictEqual(hauler.finalRun(mk(1200)), false, 'no live salvage room');
  conquest.directives = orig;
  const lhSrc = fs.readFileSync(path.join(src, 'roles/lootHauler.js'), 'utf8');
  assert.ok(lhSrc.includes("if (due === 'retire' && !(creep.memory.splitFrom && finalRun(creep))) { retireMod.retireAtSpawn(creep); return; }"));
  console.log('OK');
}

console.log('--- config: memoryProbeTtl 20, W37S7 (47,10) 20k floor ---');
{
  assert.strictEqual(config.memoryProbeTtl, 20);
  assert.strictEqual(config.rampartFloorByPos.W37S7['47,10'], 20000);
  assert.strictEqual(config.rampartFloorByPos.W33S3['47,12'], 20000);
  console.log('OK');
}

console.log('--- needsRepair: pos floor lifts a rampart over the 10k tower floor without raising the rest ---');
{
  Memory.rooms = { W37S7: { storageRich: { on: false } } };
  const room = { name: 'W37S7', controller: { level: 7, my: true }, find: () => [] };
  const rp = (x, y, hits) => ({ structureType: STRUCTURE_RAMPART, hits, hitsMax: 10000000, pos: { x, y } });
  const guard = config.rampartGuard;
  config.rampartGuard = {};
  assert.strictEqual(utils.needsRepair(room, rp(47, 10, 18261)), true);
  assert.strictEqual(utils.needsRepair(room, rp(47, 10, 20500)), false, 'stops at 20k');
  assert.strictEqual(utils.needsRepair(room, rp(47, 11, 18261)), false, 'other ramparts still wait for 10k');
  assert.strictEqual(utils.needsRepair(room, rp(47, 11, 9000)), true);
  config.rampartGuard = guard;
  const w37 = { name: 'W37S7', controller: { level: 7, my: true }, find: () => [] };
  assert.strictEqual(utils.needsRepair(w37, rp(47, 10, 20500)), true, 'W37S7 repairs from 25k');
  assert.strictEqual(utils.needsRepair(w37, rp(4, 23, 24999)), true, 'W37S7 any rampart under 25k');
  assert.strictEqual(utils.needsRepair(w37, rp(4, 23, 25500)), false, 'W37S7 25.5k waits');
  console.log('OK');
}
console.log('ALL OK');
