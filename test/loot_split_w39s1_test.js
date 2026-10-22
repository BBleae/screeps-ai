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

console.log('--- config: W39S1 loot route = war route, unload W37S5, W38S2/W38S1/W39S1 not hard-avoided ---');
{
  assert.deepStrictEqual(config.lootRoutes.W39S1, config.war.route);
  assert.strictEqual(config.conquest.lootDropFixed.W39S1, 'W37S5');
  for (const r of ['W38S2', 'W38S1', 'W39S1']) assert.ok(config.lootRoutes.hardAvoid.indexOf(r) < 0, r + ' not hard');
  for (const r of ['W38S3', 'W39S2', 'W39S3', 'W39S4', 'W39S5', 'W36S6']) assert.ok(config.lootRoutes.hardAvoid.indexOf(r) >= 0, r + ' still hard');
  assert.deepStrictEqual(config.pvp.dangerRooms, ['W39S1']);
  assert.deepStrictEqual(config.lootRoutes.W37S2.slice(-1), ['W37S2']);
  console.log('OK');
}

console.log('--- old hardAvoid: W39S1 unreachable for haulers (the bug) ---');
{
  const oldHard = new Set(['W38S2', 'W38S3', 'W39S1', 'W39S2', 'W39S3', 'W39S4', 'W39S5', 'W38S1', 'W37S1', 'W36S1', 'W36S2', 'W36S6']);
  const r = findRoute('W39S1', 'W37S5', { routeCallback: (n) => (n !== 'W37S5' && oldHard.has(n) ? Infinity : 1) });
  assert.strictEqual(r, -2, 'with W38S2+W38S1 hard, W39S1 has no route home');
  console.log('OK');
}

console.log('--- new config: finite pathSteps W39S1 <-> W37S5 and dropRoom W37S5 ---');
{
  Game.rooms = { W37S5: ownRoom('W37S5') };
  Memory.lootDrop = {};
  const s = hauler.pathSteps('W39S1', 'W37S5');
  assert.ok(Number.isFinite(s), 'finite steps ' + s);
  const route = findRoute('W39S1', 'W37S5', { routeCallback: (n) => (n !== 'W37S5' && new Set(config.lootRoutes.hardAvoid).has(n) ? Infinity : 1) });
  assert.deepStrictEqual(route.map((x) => x.room), ['W39S0', 'W38S0', 'W38S1', 'W38S2', 'W37S2', 'W37S3', 'W37S4', 'W37S5']);
  for (const r of route.map((x) => x.room)) assert.ok(config.lootRoutes.W39S1.indexOf(r) >= 0, r + ' on war route');
  const creep = { name: 'h1', memory: { role: 'lootHauler', targetRoom: 'W39S1', home: 'W37S7', salvageLoot: true }, room: { name: 'W39S1' }, pos: new RoomPosition(20, 20, 'W39S1') };
  assert.strictEqual(hauler.dropRoom(creep), 'W37S5', 'unloads at W37S5');
  console.log('OK');
}

console.log('--- movement: W39S1 hauler on the route gets an avoid set that leaves the whole war route open ---');
{
  const creep = { name: 'h2', memory: { role: 'lootHauler', targetRoom: 'W39S1' }, pos: new RoomPosition(25, 25, 'W37S5') };
  const set = movement.lootAvoidFor(creep, new RoomPosition(25, 25, 'W39S1'));
  for (const r of config.lootRoutes.W39S1) assert.ok(!set.has(r), r + ' open');
  assert.ok(set.has('W39S2') && set.has('W38S3'), 'side rooms still blocked');
  const r = findRoute('W37S5', 'W39S1', { routeCallback: (n) => (n !== 'W39S1' && set.has(n) ? Infinity : 1) });
  assert.ok(Array.isArray(r) && r[r.length - 1].room === 'W39S1', 'finite route to W39S1');
  const other = { name: 'h3', memory: { role: 'lootHauler', targetRoom: 'W35S1' }, pos: new RoomPosition(25, 25, 'W37S5') };
  const os = movement.lootAvoidFor(other, new RoomPosition(25, 25, 'W35S1'));
  assert.ok(os.has('W39S1') && os.has('W38S2'), 'W35S1 haulers keep off W39S1/W38S2');
  console.log('OK');
}

function mkCreep(name, mem, ttl, used) {
  const c = { name, memory: mem, ticksToLive: ttl, store: mkStore(used ? { L: used } : {}, 1250), room: { name: 'W37S5' }, pos: new RoomPosition(25, 25, 'W37S5') };
  Memory.creeps[name] = mem;
  return c;
}

console.log('--- split: nothing before Memory.lootWarLoot; then 8 move to W39S1, sideLoot/pull untouched ---');
{
  Game.creeps = {};
  Memory.creeps = {};
  const names = [];
  for (let i = 0; i < 9; i++) {
    const t = i < 5 ? 'W35S1' : 'W37S2';
    const n = 'c' + i;
    Game.creeps[n] = mkCreep(n, { role: 'lootHauler', home: 'W37S7', targetRoom: t, salvageLoot: true, slotKey: 'loot:' + t + ':W37S7:' + i, lootTiles: [[1, 1]] }, 1400 - i * 10, i === 0 ? 500 : 0);
    names.push(n);
  }
  Game.creeps.old = mkCreep('old', { role: 'lootHauler', home: 'W37S5', targetRoom: 'W37S2', salvageLoot: true, slotKey: 'loot:W37S2:W37S5:9' }, 300, 0);
  Game.creeps.side = mkCreep('side', { role: 'lootHauler', home: 'W31S5', targetRoom: 'W29S4', sideLoot: true }, 1400, 0);
  Game.creeps.pull = mkCreep('pull', { role: 'lootHauler', home: 'W37S7', targetRoom: 'W37S3', pullLoot: true }, 1400, 0);
  delete Memory.lootWarLoot;
  assert.strictEqual(split.run(true), null, 'no split state, no moves');
  assert.ok(Object.values(Game.creeps).every((c) => c.memory.targetRoom !== 'W39S1'));
  Memory.lootWarLoot = { target: 'W39S1', haulers: 8, keepOthers: 6, unload: 'W37S5', since: 2000 };
  Game.rooms.W39S1 = { name: 'W39S1', find: (t) => (t === FIND_STRUCTURES ? [{ structureType: 'storage', store: mkStore({ energy: 900000 }), pos: new RoomPosition(14, 14, 'W39S1') }] : []) };
  const r = split.run(true);
  assert.strictEqual(r.moved, 8);
  const on = Object.values(Game.creeps).filter((c) => c.memory.targetRoom === 'W39S1');
  assert.strictEqual(on.length, 8);
  assert.ok(!on.some((c) => ['old', 'side', 'pull'].indexOf(c.name) >= 0), 'short-TTL, side and pull haulers stay');
  assert.strictEqual(Game.creeps.side.memory.targetRoom, 'W29S4');
  assert.strictEqual(Game.creeps.pull.memory.targetRoom, 'W37S3');
  for (const c of on) {
    assert.ok(c.memory.slotKey.indexOf('split:W39S1:') === 0, 'origin slot freed for refill');
    assert.ok(c.memory.splitFrom === 'W35S1' || c.memory.splitFrom === 'W37S2');
    assert.strictEqual(hauler.dropRoom(c), 'W37S5');
  }
  assert.ok(Game.creeps.c0.memory.targetRoom === 'W39S1' ? Game.creeps.c0.memory.state === 'deliver' : true, 'carrying hauler delivers first');
  assert.strictEqual(split.run(true).moved, 0, 'stable at 8');
  const gone = on[0].name;
  delete Game.creeps[gone];
  const r2 = split.run(true);
  assert.strictEqual(r2.moved, 1, 'tops back up to 8');
  console.log('OK');
}

console.log('--- split: W39S1 empty -> done, haulers sent back to their old piles ---');
{
  Game.rooms.W39S1 = { name: 'W39S1', find: () => [] };
  const r = split.run(true);
  assert.ok(r.done);
  assert.ok(Memory.lootWarLoot.doneAt);
  assert.ok(Object.values(Game.creeps).every((c) => c.memory.targetRoom !== 'W39S1'));
  assert.ok(Object.values(Game.creeps).filter((c) => c.memory.salvageLoot).every((c) => !c.memory.splitFrom));
  assert.strictEqual(split.run(true), null, 'idle after done');
  console.log('OK');
}

console.log('--- war: split after towers+spawn dead; controller lock required only when a claimer is used ---');
{
  const warSrc = fs.readFileSync(path.join(src, 'war.js'), 'utf8');
  assert.ok(/if \(!structsCleared\) return;\s*\n\s*if \(!noClaimer\(\) && !locked\(room\)\) return;/.test(warSrc));
  assert.ok(/lootSplit\(w, room, noClaimer\(\) \? towers\.length === 0 : spawns\.length === 0 && towers\.length === 0\)/.test(warSrc));
  const mainSrc = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
  assert.ok(/require\('loot_split'\)\.run\(\)/.test(mainSrc));
  console.log('OK');
}

console.log('--- cfg overlay: room lists validated, audited, caches invalidated ---');
{
  const base = { dangerRooms: config.pvp.dangerRooms.slice(), hardAvoid: config.lootRoutes.hardAvoid.slice(), W37S2: config.lootRoutes.W37S2.slice(), gates: JSON.parse(JSON.stringify(config.lootRoutes.gates)) };
  overlay.state.at = null;
  Memory.cfg = undefined;
  delete Memory.cfgListSig; delete Memory.cfgAudit; delete Memory.cfgAlerts;
  Game.time = 3000;
  overlay.apply();
  assert.ok(Memory.cfgListSig['lootRoutes.hardAvoid']);
  assert.ok(!Memory.cfgAudit, 'first sight records, no audit');
  Memory.lootDrop = { _steps: { 'W39S1:W37S5': { s: Infinity, ok: 0, at: 2990 } } };
  Game.creeps = { h: { name: 'h', memory: { role: 'lootHauler', _move: { x: 1 }, gNext: { a: 1 } } } };
  Memory.cfgBy = 'strategist';
  Memory.cfg = { lootRoutes: { hardAvoid: ['W39S1', 'W36S6', 'bogus', 7] }, pvp: { dangerRooms: ['W39S1'] } };
  Game.time = 3001;
  const log = overlay.apply();
  assert.ok(log, 'applies on the tick Memory.cfg changes, not 200 ticks later');
  assert.deepStrictEqual(config.lootRoutes.hardAvoid, ['W39S1', 'W36S6'], 'invalid entries dropped');
  assert.deepStrictEqual(config.lootRoutes.W37S2, base.W37S2, 'sibling routes untouched');
  assert.deepStrictEqual(config.lootRoutes.gates, base.gates, 'gates untouched');
  assert.ok(Memory.cfgAlerts && Memory.cfgAlerts[0].why === 'badRoom' && Memory.cfgAlerts[0].bad.length === 2);
  const a = Memory.cfgAudit.find((x) => x.path === 'lootRoutes.hardAvoid');
  assert.ok(a && a.by === 'strategist' && a.tick === 3001);
  assert.deepStrictEqual(a.old, base.hardAvoid);
  assert.deepStrictEqual(a.new, ['W39S1', 'W36S6']);
  assert.deepStrictEqual(Memory.lootDrop, {}, 'step cache cleared');
  assert.ok(!Game.creeps.h.memory._move && !Game.creeps.h.memory.gNext, 'creep route caches cleared');
  const probe = () => movement.lootAvoidFor({ name: 'x', memory: { role: 'lootHauler', targetRoom: 'W35S1' }, pos: new RoomPosition(25, 25, 'W37S5') }, new RoomPosition(25, 25, 'W35S1'));
  assert.ok(!probe().has('W37S3'));
  Memory.cfg = { lootRoutes: { hardAvoid: ['W39S1', 'W36S6', 'W37S3'] }, pvp: { dangerRooms: ['W39S1'] } };
  Game.time = 3001.5;
  overlay.apply();
  assert.ok(probe().has('W37S3'), 'movement avoid cache rebuilt with new hardAvoid');
  Memory.cfg = { pvp: { dangerRooms: 'W38S2' } };
  Game.time = 3002;
  overlay.apply();
  assert.ok(Array.isArray(config.pvp.dangerRooms), 'wrong type never breaks pathing');
  Memory.cfg = undefined;
  Game.time = 3003;
  overlay.apply();
  assert.deepStrictEqual(config.lootRoutes.hardAvoid, base.hardAvoid, 'restored to config.js defaults');
  assert.deepStrictEqual(config.pvp.dangerRooms, base.dangerRooms);
  assert.strictEqual(Memory.cfgAudit.filter((x) => x.path === 'lootRoutes.hardAvoid').length, 3);
  const audits = Memory.cfgAudit.length;
  Game.time = 3300;
  overlay.apply();
  assert.strictEqual(Memory.cfgAudit.length, audits, 'no audit when unchanged');
  console.log('OK');
}
console.log('loot_split_w39s1_test: all OK');
