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
const moves = [];
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'movement') return { go: (c, t, o) => { moves.push({ c: c.name, x: t.x, y: t.y, o }); return 0; } };
  return origLoad.call(this, request, parent, isMain);
};
Object.assign(global, require('/workspace/ops/war/eng/cmn/package/lib/constants'));

global.Game = { time: 5000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, objs: {}, map: { getRoomLinearDistance: () => 2, findRoute: () => [] }, market: {} };
Game.getObjectById = (id) => Game.objs[id] || null;
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.getRangeTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return Math.max(Math.abs(p.x - this.x), Math.abs(p.y - this.y)); };
RoomPosition.prototype.inRangeTo = function (a, r) { return this.getRangeTo(a) <= r; };
RoomPosition.prototype.isEqualTo = function (a, b) { const p = typeof a === 'number' ? { x: a, y: b } : (a.pos || a); return p.x === this.x && p.y === this.y; };

const nuke = require('loot_nuke');
const sd = require('roles_siegeDismantler');
const conquest = require('conquest');
const hauler = require('roles_lootHauler');
const split = require('loot_split');

const mkStore = (o, cap) => {
  const s = Object.assign({}, o);
  const used = () => Object.keys(s).filter((k) => typeof s[k] === 'number').reduce((n, k) => n + s[k], 0);
  Object.defineProperty(s, 'getUsedCapacity', { value: (r) => (r ? Number(s[r] || 0) : used()) });
  Object.defineProperty(s, 'getCapacity', { value: () => cap || 1000000 });
  Object.defineProperty(s, 'getFreeCapacity', { value: () => (cap || 1000000) - used() });
  return s;
};
let seq = 0;
function world(name, walls) {
  const st = [];
  const cr = [];
  const ruins = [];
  const wallSet = new Set(walls || []);
  const room = {
    name, st, cr, ruins,
    controller: { my: false, level: 0, owner: undefined },
    getTerrain: () => ({ get: (x, y) => (wallSet.has(x + ',' + y) ? TERRAIN_MASK_WALL : 0) }),
    lookForAt: (t, x, y) => (t === LOOK_STRUCTURES ? st : t === LOOK_CREEPS ? cr : t === LOOK_RUINS ? ruins : []).filter((o) => o.pos.x === x && o.pos.y === y),
    find: (t) => (t === FIND_STRUCTURES || t === FIND_HOSTILE_STRUCTURES ? st : t === FIND_MY_CREEPS ? cr : t === FIND_RUINS ? ruins : []),
  };
  Game.rooms[name] = room;
  return room;
}
function struct(room, type, x, y, extra) {
  const o = Object.assign({ id: 's' + (++seq), structureType: type, pos: new RoomPosition(x, y, room.name), my: false, owner: { username: 'enemy' }, room }, extra || {});
  room.st.push(o);
  Game.objs[o.id] = o;
  return o;
}
function remove(room, o) { room.st.splice(room.st.indexOf(o), 1); delete Game.objs[o.id]; }
const dcalls = [];
function dismantler(room, name, x, y, boosted) {
  const body = [];
  for (let i = 0; i < 25; i++) body.push({ type: WORK, hits: 100, boost: boosted ? 'ZH2O' : undefined });
  for (let i = 0; i < 25; i++) body.push({ type: MOVE, hits: 100 });
  const c = { name, id: 'c' + (++seq), my: true, body, spawning: false, ticksToLive: 1200, memory: { role: 'siegeDismantler', targetRoom: room.name, home: 'W37S5', salvageLoot: true, strongholdLoot: true, boosted: !!boosted }, room, pos: new RoomPosition(x, y, room.name), store: mkStore({}, 0) };
  c.dismantle = (o) => { dcalls.push({ c: name, id: o.id, t: o.structureType }); if (c.pos.getRangeTo(o) > 1) return ERR_NOT_IN_RANGE; o.hits -= sd.power(c) * DISMANTLE_POWER; return OK; };
  Game.creeps[name] = c;
  room.cr.push(c);
  return c;
}
function lhauler(room, name, x, y, mem, store) {
  const c = { name, id: 'h' + (++seq), my: true, body: [], spawning: false, ticksToLive: 1300, memory: Object.assign({ role: 'lootHauler', home: 'W37S5', targetRoom: room.name, salvageLoot: true, lootLock: room.name, state: 'load' }, mem || {}), room, pos: new RoomPosition(x, y, room.name), store: mkStore(store || {}, 1250) };
  c.withdraw = (o, r) => { const a = Math.min(Number(o.store[r] || 0), c.store.getFreeCapacity()); if (!(a > 0)) return ERR_NOT_ENOUGH_RESOURCES; o.store[r] -= a; c.store[r] = (c.store[r] || 0) + a; return OK; };
  Game.creeps[name] = c;
  room.cr.push(c);
  return c;
}
function reset() {
  Game.creeps = {}; Game.rooms = {}; Game.objs = {}; Game.time = 5000; moves.length = 0; dcalls.length = 0;
  Memory.conquest = [];
  Memory.lootWarLoot = { target: 'W39S1', haulers: 0, since: 1 };
  Memory.lootGate = {};
  Memory.cfg = undefined;
}
const dirW35 = (o) => Object.assign({ type: 'salvageLoot', target: 'W35S1', sponsors: ['W37S5'], phase: 'breach', dismantlers: 2, dismantlerHomes: ['W37S5'], focusTiles: [[33, 34]], strictFocus: true, stopHits: 10000, startedAt: 1 }, o || {});
function tick() { Game.time++; }

console.log('--- switch off: dis() is plain dismantle, loot_nuke inert ---');
{
  reset();
  const r = world('W35S1');
  const ext = struct(r, STRUCTURE_EXTENSION, 35, 32, { hits: 1000 });
  Memory.conquest = [{ type: 'salvageLoot', target: 'W35S1', sponsors: ['W37S5'], phase: 'breach' }];
  const c = dismantler(r, 'd0', 34, 33, true);
  assert.strictEqual(sd.dis(c, ext), OK);
  assert.strictEqual(dcalls.length, 1);
  assert.strictEqual(nuke.cfg(), null);
  assert.strictEqual(nuke.run(), null);
  const h = lhauler(r, 'h0', 30, 30);
  assert.strictEqual(nuke.haulerRun(h, false), false);
  assert.strictEqual(nuke.active('W35S1'), null);
  const main = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
  assert.ok(main.indexOf("if (Memory.lootWarLoot && Memory.lootWarLoot.nuke) require('loot_nuke').run()") > 0);
  console.log('OK');
}

console.log('--- stopHits: 2 boosted dismantlers same tick hold at >= 10k ---');
{
  reset();
  const r = world('W35S1');
  const ramp = struct(r, STRUCTURE_RAMPART, 33, 34, { hits: 30000 });
  struct(r, STRUCTURE_NUKER, 33, 34, { hits: 1000, store: mkStore({ energy: 300000, G: 5000 }) });
  Memory.conquest = [dirW35()];
  const a = dismantler(r, 'dA', 32, 33, true);
  const b = dismantler(r, 'dB', 34, 33, true);
  assert.strictEqual(sd.power(a) * DISMANTLE_POWER, 3750);
  for (let i = 0; i < 10; i++) { sd.run(a); sd.run(b); tick(); }
  assert.ok(ramp.hits >= 10000, 'hits ' + ramp.hits);
  assert.ok(ramp.hits < 10000 + 3750, 'hits ' + ramp.hits);
  assert.ok(dcalls.every((x) => x.t === STRUCTURE_RAMPART));
  const before = ramp.hits;
  for (let i = 0; i < 5; i++) { sd.run(a); sd.run(b); tick(); }
  assert.strictEqual(ramp.hits, before);
  assert.ok(!a.memory.retired && !b.memory.retired);
  const ds = [dismantler(r, 'd1', 32, 35, true), dismantler(r, 'd2', 34, 35, true), dismantler(r, 'd3', 33, 35, true)];
  ramp.hits = 21000;
  for (const c of ds) sd.run(c);
  assert.ok(ramp.hits >= 10000, 'three ' + ramp.hits);
  console.log('OK');
}

console.log('--- strictFocus: never touches extensions or tower ramparts ---');
{
  reset();
  const r = world('W35S1');
  const ext1 = struct(r, STRUCTURE_EXTENSION, 35, 32, { hits: 1000 });
  const ext2 = struct(r, STRUCTURE_EXTENSION, 31, 33, { hits: 1000 });
  struct(r, STRUCTURE_TOWER, 30, 30, { hits: 3000 });
  const tr = struct(r, STRUCTURE_RAMPART, 30, 30, { hits: 50000 });
  struct(r, STRUCTURE_RAMPART, 33, 34, { hits: 30000 });
  const nk = struct(r, STRUCTURE_NUKER, 33, 34, { hits: 1000 });
  Memory.conquest = [dirW35()];
  const a = dismantler(r, 'dA', 32, 33, true);
  for (const o of [ext1, ext2, tr, nk]) assert.strictEqual(sd.dis(a, o), ERR_INVALID_TARGET);
  a.memory.tgt = ext2.id; a.memory.tgtAt = Game.time;
  for (let i = 0; i < 20; i++) { sd.run(a); tick(); }
  assert.ok(dcalls.length > 0 && dcalls.every((x) => x.t === STRUCTURE_RAMPART && x.id !== tr.id));
  assert.strictEqual(ext1.hits, 1000); assert.strictEqual(ext2.hits, 1000); assert.strictEqual(tr.hits, 50000); assert.strictEqual(nk.hits, 1000);
  console.log('OK');
}

console.log('--- conquest: focus keeps directive live, exact dismantler split ---');
{
  reset();
  const r = world('W35S1');
  struct(r, STRUCTURE_NUKER, 33, 34, { hits: 1000, store: mkStore({ energy: 300000, G: 5000 }) });
  struct(r, STRUCTURE_POWER_SPAWN, 20, 20, { hits: 1000, store: mkStore({ energy: 4000 }) });
  assert.deepStrictEqual(conquest.loadTargets(r), []);
  Memory.conquest = [dirW35({ dismantlers: 2 }), dirW35({ target: 'W37S2', sponsors: ['W37S5', 'W37S7'], dismantlers: 3, focusTiles: [[31, 20]] })];
  conquest.run();
  assert.ok(!Memory.conquest[0].completed, 'nuker on focus keeps it live');
  assert.strictEqual(Memory.conquest[0].phase, 'breach');
  const home = (n) => ({ name: n, controller: { my: true, level: 8 }, energyCapacityAvailable: 12900, energyAvailable: 12900, storage: { store: { energy: 500000 } }, find: () => [] });
  Game.rooms.W37S5 = home('W37S5'); Game.rooms.W37S7 = home('W37S7');
  const cnt = (h, t) => conquest.getDemands(Game.rooms[h]).filter((x) => x.memory && x.memory.role === 'siegeDismantler' && x.memory.targetRoom === t).length;
  assert.strictEqual(cnt('W37S5', 'W35S1'), 2);
  assert.strictEqual(cnt('W37S5', 'W37S2'), 3);
  assert.strictEqual(cnt('W37S7', 'W37S2'), 0);
  const dm = conquest.getDemands(Game.rooms.W37S5).find((x) => x.memory && x.memory.role === 'siegeDismantler');
  assert.ok(dm);
  console.log('OK');
}

function scene() {
  reset();
  const walls = [];
  const r = world('W37S2', walls);
  for (const [x, y] of [[30, 19], [31, 19], [32, 19], [30, 20]]) struct(r, STRUCTURE_WALL, x, y, { hits: 1e6 });
  const ramp = struct(r, STRUCTURE_RAMPART, 31, 20, { hits: 14000 });
  const nk = struct(r, STRUCTURE_NUKER, 31, 20, { hits: 1000, store: mkStore({ energy: 300000, G: 5000 }) });
  const ext = struct(r, STRUCTURE_EXTENSION, 33, 21, { hits: 1000 });
  Memory.conquest = [dirW35({ target: 'W37S2', dismantlers: 3, focusTiles: [[31, 20]] })];
  return { r, ramp, nk, ext };
}

console.log('--- nuke order: wall -> gather; no final hit until 3 slots full and all locked haulers here ---');
let S;
{
  S = scene();
  const { r, ramp, nk } = S;
  Memory.lootWarLoot.nuke = { room: 'W37S2', stage: 'wall', gFirst: 4, n: 6 };
  const a = dismantler(r, 'dA', 32, 21, true);
  const b = dismantler(r, 'dB', 30, 21, true);
  const c = dismantler(r, 'dC', 31, 21, true);
  ramp.hits = 30000;
  nuke.run();
  assert.strictEqual(Memory.lootWarLoot.nuke.stage, 'wall');
  ramp.hits = 14000;
  nuke.run();
  const n = Memory.lootWarLoot.nuke;
  assert.strictEqual(n.stage, 'gather');
  assert.deepStrictEqual(Memory.lootWarLoot.locks.W37S2.until, 'nuke');
  assert.strictEqual(Memory.lootWarLoot.locks.W37S2.n, 6);
  const p = nuke.plan(r, n, Memory.conquest[0]);
  assert.strictEqual(p.adj.length, 4);
  assert.strictEqual(p.slots.length, 3);
  const d = Memory.conquest[0];
  assert.ok(Array.isArray(d.dTile) && !d.finishGo && !d.nukerGo);
  for (let i = 0; i < 4; i++) { sd.run(a); sd.run(b); sd.run(c); tick(); }
  assert.ok(ramp.hits >= 10000);
  assert.strictEqual(nk.hits, 1000);
  const hs = [];
  for (let i = 0; i < 6; i++) hs.push(lhauler(r, 'H' + i, 25 + i, 25));
  const far = lhauler(r, 'Hfar', 25, 25); far.room = { name: 'W37S3' }; far.pos = new RoomPosition(25, 25, 'W37S3'); r.cr.splice(r.cr.indexOf(far), 1);
  Memory.lootWarLoot.nuke.n = 7; Memory.lootWarLoot.locks.W37S2.n = 7;
  assert.deepStrictEqual(d.dTile, [a.pos.x, a.pos.y]);
  assert.ok(moves.some((m) => m.c === 'dB' && d.dWait.some((w) => w[0] === m.x && w[1] === m.y)));
  b.pos = new RoomPosition(d.dWait[0][0], d.dWait[0][1], 'W37S2');
  c.pos = new RoomPosition(d.dWait[1][0], d.dWait[1][1], 'W37S2');
  for (const h of hs) assert.strictEqual(nuke.haulerRun(h, false), true);
  const parks = hs.filter((h) => h.memory.park).map((h) => h.memory.park.join(','));
  assert.strictEqual(parks.length, 3);
  assert.strictEqual(new Set(parks).size, 3);
  assert.ok(parks.indexOf(d.dTile.join(',')) < 0);
  for (const h of hs) { const s = h.memory.park || h.memory.nukeQ; h.pos = new RoomPosition(s[0], s[1], 'W37S2'); }
  const lead = a;
  tick();
  nuke.run();
  assert.strictEqual(n.stage, 'gather', 'one locked hauler still away');
  assert.ok(!d.finishGo);
  far.room = r; far.pos = new RoomPosition(28, 28, 'W37S2'); r.cr.push(far);
  tick();
  nuke.run();
  assert.strictEqual(n.stage, 'strike');
  assert.ok(d.finishGo && d.nukerGo);
  assert.strictEqual(n.g.length, 3);
  const onlyG = Object.values(Game.creeps).filter((x) => x.memory.onlyRes);
  assert.strictEqual(onlyG.length, 3);
  assert.ok(onlyG.every((x) => x.memory.onlyRes[0] === 'G' && x.memory.park));
  dcalls.length = 0;
  for (let i = 0; i < 6 && Game.objs[nk.id]; i++) {
    for (const x of [a, b, c]) sd.run(x);
    if (ramp.hits <= 0 && Game.objs[ramp.id]) { remove(r, ramp); const rr = { id: 'ruinR', pos: new RoomPosition(ramp.pos.x, ramp.pos.y, 'W37S2'), structure: { structureType: STRUCTURE_RAMPART }, store: mkStore({}) }; r.ruins.push(rr); Game.objs.ruinR = rr; }
    if (nk.hits <= 0 && Game.objs[nk.id]) { remove(r, nk); const ru = { id: 'ruin1', pos: new RoomPosition(31, 20, 'W37S2'), structure: { structureType: STRUCTURE_NUKER }, store: mkStore({ energy: 300000, G: 5000 }) }; r.ruins.push(ru); Game.objs.ruin1 = ru; }
    tick();
  }
  assert.ok(!Game.objs[nk.id], 'nuker down');
  assert.ok(dcalls.every((x) => x.c === lead.name), 'only lead hits');
  assert.ok(dcalls.every((x) => x.t === STRUCTURE_RAMPART || x.t === STRUCTURE_NUKER));
  assert.strictEqual(S.ext.hits, 1000);
  console.log('OK');
}

console.log('--- loot: first haulers G only, rest energy; unload counts; done releases lock ---');
{
  const { r } = S;
  const n = Memory.lootWarLoot.nuke;
  nuke.run();
  assert.strictEqual(n.stage, 'loot');
  assert.strictEqual(n.ruin, 'ruin1');
  const ru = Game.objs.ruin1;
  const all = Object.values(Game.creeps).filter((x) => x.memory.role === 'lootHauler');
  for (const h of all) nuke.haulerRun(h, false);
  const gs = all.filter((h) => h.memory.onlyRes);
  for (const h of gs) assert.ok(Number(h.store.G) > 0 && !(Number(h.store.energy) > 0), h.name + ' G only');
  assert.strictEqual(ru.store.G, 5000 - gs.reduce((s, h) => s + h.store.G, 0));
  assert.ok(all.filter((h) => !h.memory.onlyRes).every((h) => !(h.store.getUsedCapacity() > 0)), 'queue waits while G haulers hold slots');
  for (const h of gs) { h.store.G = 1250; nuke.haulerRun(h, true); assert.strictEqual(h.memory.state, 'deliver'); r.cr.splice(r.cr.indexOf(h), 1); h.room = { name: 'W37S3' }; h.pos = new RoomPosition(25, 25, 'W37S3'); }
  ru.store.G = 0;
  const rest = all.filter((h) => !h.memory.onlyRes);
  for (const h of rest) nuke.haulerRun(h, false);
  for (const h of rest) if (h.memory.park) h.pos = new RoomPosition(h.memory.park[0], h.memory.park[1], 'W37S2');
  tick();
  for (const h of rest) nuke.haulerRun(h, false);
  const es = rest.filter((h) => Number(h.store.energy) > 0);
  assert.strictEqual(es.length, 3);
  for (const h of es) assert.ok(!(Number(h.store.G) > 0));
  for (const h of es) { nuke.haulerRun(h, true); assert.strictEqual(h.memory.state, 'deliver'); }
  assert.strictEqual(require('config').conquest.lootDropFixed.W37S2, 'W37S5');
  assert.strictEqual(require('config').conquest.lootDropFixed.W35S1, 'W37S5');
  const ln = fs.readFileSync(path.join(src, 'roles/lootHauler.js'), 'utf8');
  assert.ok(ln.indexOf("require('loot_nuke').noteUnload(creep, res, got)") > 0);
  assert.ok(fs.readFileSync(path.join(src, 'loot_nuke.js'), 'utf8').indexOf('transfer') < 0, 'no ruinToStorage');
  nuke.noteUnload(gs[0], 'G', 1250);
  nuke.noteUnload(es[0], 'energy', 1250);
  assert.strictEqual(n.gHome, 1250);
  assert.strictEqual(n.eHome, 1250);
  ru.store.G = 0; ru.store.energy = 0;
  for (const h of gs) h.store.G = 0;
  nuke.run();
  assert.strictEqual(n.stage, 'done');
  assert.ok(Memory.lootWarLoot.locks.W37S2.releasedAt);
  assert.ok(Object.values(Game.creeps).every((x) => !x.memory.lootLock && !x.memory.onlyRes && !x.memory.park));
  assert.ok(n.events.some((e) => e.e === 'gHome') && n.events.some((e) => e.e === 'done') && n.events.some((e) => e.e === 'strike'));
  assert.ok(!Memory.conquest[0].dTile);
  console.log('OK');
}

console.log('--- order: next room only after first done ---');
{
  S = scene();
  Memory.lootWarLoot.nuke = { room: 'W35S1', stage: 'wall', gFirst: 4, n: 18, order: ['W37S2'] };
  nuke.run();
  assert.strictEqual(Memory.lootWarLoot.nuke.room, 'W35S1');
  assert.ok(!Memory.lootWarLoot.locks || !Memory.lootWarLoot.locks.W37S2);
  assert.ok(!Memory.conquest[0].dTile);
  console.log('OK');
}

console.log('--- strict: stale handoff/posts never retire boosted dismantlers ---');
{
  reset();
  const r = world('W35S1');
  struct(r, STRUCTURE_RAMPART, 33, 34, { hits: 10500 });
  struct(r, STRUCTURE_NUKER, 33, 34, { hits: 1000 });
  Memory.conquest = [dirW35({ handoff: { tiles: [[33, 34]], to: null, at: 1 }, posts: [[32, 33]] })];
  const a = dismantler(r, 'dA', 32, 33, true);
  for (let i = 0; i < 5; i++) { sd.run(a); tick(); }
  assert.ok(!a.memory.retired);
  assert.strictEqual(dcalls.length, 0);
  console.log('OK');
}

console.log('--- relock: locked empty hauler in an active nuke room is not retired by ttlCheck; lock clears retire marks ---');
{
  reset();
  const r = world('W37S2');
  Memory.lootWarLoot.nuke = { room: 'W37S2', stage: 'strike', gFirst: 4, n: 4 };
  const h = lhauler(r, 'hR', 30, 30, { retireSpawn: 'sp1', retireCheckAt: 4990, retired: true });
  h.ticksToLive = 60;
  const free = lhauler(r, 'hF', 31, 30, { lootLock: undefined });
  free.ticksToLive = 60;
  assert.strictEqual(hauler.ttlCheck(free, false), 'retire', 'unlocked short-TTL empty hauler still retires');
  assert.strictEqual(hauler.ttlCheck(h, false), null, 'locked empty hauler in the nuke room keeps waiting');
  h.ticksToLive = 40;
  assert.strictEqual(hauler.ttlCheck(h, false), 'retire', 'too short even to stay: retire');
  h.ticksToLive = 60;
  Memory.lootWarLoot.locks = { W37S2: { n: 4, until: 'nuke', at: 1 } };
  split.runLocks(Memory.lootWarLoot, {}, new Set(['W37S2']), Object.values(Game.creeps));
  assert.ok(!h.memory.retireSpawn && !h.memory.retired && !h.memory.retireCheckAt, 'runLocks clears retire marks of locked haulers');
  Memory.lootWarLoot.nuke.stage = 'done';
  assert.strictEqual(hauler.ttlCheck(h, false), 'retire', 'after the nuke op ends the normal TTL rule applies');
  console.log('OK');
}

console.log('ALL OK');
