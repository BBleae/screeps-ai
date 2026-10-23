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
const config = require('config');
const conquest = require('conquest');
const hauler = require('roles_lootHauler');
const split = require('loot_split');
const sideLoot = require('side_loot');

const restricted = (o) => Object.assign({}, o, { getUsedCapacity: (r) => (r ? o[r] || 0 : null) });
const plain = (o) => Object.assign({}, o, { getUsedCapacity: (r) => (r ? o[r] || 0 : Object.keys(o).reduce((n, k) => n + o[k], 0)) });
const st = (id, type, x, y, store, extra) => Object.assign({ id, structureType: type, pos: new RoomPosition(x, y, 'W29S4'), store }, extra || {});
const mkRoom = (name, structs) => ({ name, find: (t) => (t === FIND_STRUCTURES ? structs : []) });

console.log('--- usedOf: restricted stores (spawn/extension/lab) report null without a resource ---');
{
  assert.strictEqual(conquest.usedOf(restricted({ energy: 300 })), 300);
  assert.strictEqual(conquest.usedOf(restricted({ energy: 0 })), 0);
  assert.strictEqual(conquest.usedOf(plain({ energy: 10, K: 5 })), 15);
  assert.strictEqual(conquest.usedOf(restricted({ energy: 2000, XGH2O: 3000 })), 5000);
  console.log('OK');
}

console.log('--- loadTargets: spawn/extension/tower/link/lab energy counted; nuker/powerSpawn never; per-tile rampart ---');
{
  const s = [
    st('sp', 'spawn', 10, 10, restricted({ energy: 300 })),
    st('e1', 'extension', 11, 10, restricted({ energy: 50 })),
    st('e2', 'extension', 12, 10, restricted({ energy: 50 })),
    st('tw', 'tower', 13, 10, restricted({ energy: 500 })),
    st('ln', 'link', 14, 10, restricted({ energy: 400 })),
    st('lb', 'lab', 15, 10, restricted({ energy: 2000, XGH2O: 3000 })),
    st('nk', 'nuker', 16, 10, restricted({ energy: 300000, G: 5000 })),
    st('ps', 'powerSpawn', 17, 10, restricted({ energy: 5000, power: 100 })),
    st('rp', 'rampart', 13, 10, undefined, { my: false, isPublic: false }),
    st('pub', 'rampart', 14, 10, undefined, { my: false, isPublic: true }),
    st('own', 'extension', 18, 10, restricted({ energy: 50 }), { my: true }),
    st('e0', 'extension', 19, 10, restricted({ energy: 0 })),
  ];
  const ids = conquest.loadTargets(mkRoom('W29S4', s)).map((o) => o.id).sort();
  assert.deepStrictEqual(ids, ['e1', 'e2', 'lb', 'ln', 'sp']);
  console.log('OK');
}

console.log('--- W29S4: side loot observe no longer marks 2,300 energy as done ---');
{
  Memory.sideLoot = { W29S4: { doneAt: 74496163 } };
  const s = [st('sp', 'spawn', 10, 10, restricted({ energy: 300 }))];
  for (let i = 0; i < 40; i++) s.push(st('x' + i, 'extension', 5 + (i % 20), 20 + Math.floor(i / 20), restricted({ energy: 50 })));
  Game.rooms.W29S4 = Object.assign(mkRoom('W29S4', s), { controller: {} });
  const m = sideLoot.observe('W29S4');
  assert.strictEqual(m.total, 2300);
  assert.strictEqual(m.doneAt, undefined);
  delete Game.rooms.W29S4;
  console.log('OK');
}

console.log('--- pickTarget: storage/terminal/factory before spawn/extension/tower/link/lab; T3 and battery first ---');
{
  const room = { name: 'W37S2' };
  const P = (x, y) => new RoomPosition(x, y, 'W37S2');
  const sto = { id: 'sto', structureType: 'storage', pos: P(30, 30), store: plain({ energy: 9000 }) };
  const fac = { id: 'fac', structureType: 'factory', pos: P(31, 30), store: plain({ energy: 100 }) };
  const ext = { id: 'ext', structureType: 'extension', pos: P(21, 20), store: restricted({ energy: 50 }) };
  const lab = { id: 'lab', structureType: 'lab', pos: P(22, 20), store: restricted({ energy: 100, XGH2O: 500 }) };
  const ruin = { id: 'ru', pos: P(23, 20), store: plain({ battery: 50 }) };
  let list = [];
  const orig = conquest.loadTargets;
  conquest.loadTargets = () => list;
  const seen = [];
  global.PathFinder = { search: (from, goals) => { seen.push(goals.length); return { path: [goals[0].pos], incomplete: false }; } };
  const creep = { name: 'p', memory: { role: 'lootHauler', targetRoom: 'W37S2' }, room, pos: P(20, 20) };
  try {
    list = [ext, sto, fac];
    assert.strictEqual(hauler.pickTarget(creep).id, 'sto');
    assert.strictEqual(creep.memory.lootTier, 3);
    list = [ext, lab];
    assert.ok(['ext', 'lab'].indexOf(hauler.pickTarget(creep).id) >= 0);
    assert.strictEqual(creep.memory.lootTier, 5);
    list = [ext, fac];
    assert.strictEqual(hauler.pickTarget(creep).id, 'fac');
    list = [ext, sto, ruin];
    assert.strictEqual(hauler.pickTarget(creep).id, 'ru');
    assert.strictEqual(creep.memory.lootTier, 2);
    assert.strictEqual(hauler.loadPick(lab.store), 'XGH2O');
  } finally { conquest.loadTargets = orig; delete global.PathFinder; }
  console.log('OK');
}

console.log('--- haulSlots: locked/diverted creeps do not leave their old slots refillable ---');
{
  Game.creeps = {};
  const mk = (name, key, mem, ttl) => { Game.creeps[name] = { name, ticksToLive: ttl == null ? 1200 : ttl, memory: Object.assign({ role: 'lootHauler', home: 'W38S7', slotKey: key }, mem || {}) }; };
  mk('a', 'loot:W35S1:W38S7:0', { targetRoom: 'W35S1' });
  mk('b', 'loot:W35S1:W38S7:2', { targetRoom: 'W35S1' });
  mk('c', 'loot:W35S1:W38S7:4', { targetRoom: 'W35S1' }, 50);
  mk('d', 'loot:W35S1:W38S7:5', { targetRoom: 'W35S1', retired: true });
  mk('e', 'split:W39S1:e', { targetRoom: 'W35S1', lootLock: 'W35S1' });
  mk('f', 'loot:W37S2:W38S7:1', { targetRoom: 'W35S1' });
  mk('g', 'loot:W35S1:W37S5:1', { targetRoom: 'W35S1', home: 'W37S5' });
  assert.deepStrictEqual(conquest.haulSlots('W35S1', 'W38S7', 6, 0), [0, 2]);
  assert.deepStrictEqual(conquest.haulSlots('W35S1', 'W38S7', 6, 1), [0, 1, 2]);
  assert.deepStrictEqual(conquest.haulSlots('W35S1', 'W38S7', 6, 9), [0, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(conquest.haulSlots('W35S1', 'W38S7', 2, 0), [0]);
  assert.deepStrictEqual(conquest.haulSlots('W35S1', 'W38S7', 0, 5), []);
  Game.creeps = {};
  for (let i = 0; i < 25; i++) mk('z' + i, i < 6 ? 'split:W39S1:z' + i : 'loot:W35S1:W38S7:' + (i - 6), { targetRoom: 'W35S1', lootLock: i < 6 ? 'W35S1' : undefined });
  assert.strictEqual(conquest.haulSlots('W35S1', 'W38S7', 10, 0).length, 10);
  assert.deepStrictEqual(conquest.haulSlots('W35S1', 'W38S7', 10, 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  console.log('OK');
}

const mkHauler = (name, mem, ttl) => ({ name, ticksToLive: ttl, store: plain({}), room: { name: 'W37S5' }, pos: new RoomPosition(25, 25, 'W37S5'), memory: Object.assign({ role: 'lootHauler', home: 'W37S7', salvageLoot: true }, mem) });

console.log('--- W39S1 paused: quota lent to W37S2, returned to W39S1 on resume ---');
{
  const origDir = conquest.directives;
  conquest.directives = () => ['W35S1', 'W37S2', 'W39S1'].map((target) => ({ type: 'salvageLoot', target }));
  try {
    Game.creeps = {};
    Game.rooms = {};
    const names = [];
    for (let i = 0; i < 8; i++) { const n = 'p' + i; Game.creeps[n] = mkHauler(n, { targetRoom: 'W35S1', slotKey: 'loot:W35S1:W37S7:' + i }, 1490 - i); names.push(n); }
    for (let i = 0; i < 2; i++) { const n = 'w' + i; Game.creeps[n] = mkHauler(n, { targetRoom: 'W39S1', splitFrom: 'W35S1' }, 1400); }
    for (let i = 0; i < 6; i++) { const n = 'L' + i; Game.creeps[n] = mkHauler(n, { targetRoom: 'W35S1', lootLock: 'W35S1' }, 1450); }
    Game.time = 6000;
    Memory.lootWarLoot = { target: 'W39S1', haulers: 6, events: [], locks: { W35S1: { n: 6, until: 'ore' } }, pause: { on: true, seen: 5990, at: 5950 } };
    const r = split.run(true);
    assert.ok(r.paused);
    assert.strictEqual(r.lent.to, 'W37S2');
    assert.strictEqual(r.lent.n, 6);
    const lent = Object.values(Game.creeps).filter((c) => c.memory.lentFrom === 'W39S1');
    assert.strictEqual(lent.length, 6);
    assert.ok(lent.every((c) => c.memory.targetRoom === 'W37S2'));
    assert.ok(Game.creeps.w0.memory.lentFrom === 'W39S1' && Game.creeps.w0.memory.splitFrom === undefined);
    assert.ok(Object.values(Game.creeps).filter((c) => c.memory.lootLock).every((c) => c.memory.targetRoom === 'W35S1' && !c.memory.lentFrom));
    const again = split.run(true);
    assert.strictEqual(again.lent.n, 6);
    assert.strictEqual((again.lent.moved || []).length, 0);
    Game.time = 6100;
    const back = split.run(true);
    assert.strictEqual(back.moved, 6);
    const on = Object.values(Game.creeps).filter((c) => c.memory.targetRoom === 'W39S1');
    assert.strictEqual(on.length, 6);
    assert.ok(on.every((c) => !c.memory.lentFrom));
    assert.deepStrictEqual(on.map((c) => c.name).sort(), lent.map((c) => c.name).sort());
    assert.strictEqual(Object.values(Game.creeps).filter((c) => c.memory.lentFrom).length, 0);
  } finally { conquest.directives = origDir; }
  console.log('OK');
}

console.log('--- borrow: remote hauler loots W29S4 without a spawn, then returns exactly as it was ---');
{
  Game.time = 7000;
  Game.creeps = {};
  Memory.sideLoot = { W29S4: {} };
  const mem = { role: 'remoteHauler', home: 'W29S3', remoteRoom: 'W29S2', slotKey: 'remoteHauler:W29S2:abc:0', state: 'pickup' };
  const held = {};
  const store = plain(held);
  Game.creeps.r = { name: 'r', ticksToLive: 1400, store, memory: mem, room: { name: 'W29S3' }, pos: new RoomPosition(25, 25, 'W29S3') };
  assert.strictEqual(hauler.borrowCreep('r', 'W29S4', 1200), true);
  assert.strictEqual(hauler.borrowCreep('r', 'W29S4', 1200), false);
  const m = Game.creeps.r.memory;
  assert.strictEqual(m.role, 'remoteHauler');
  assert.strictEqual(m.targetRoom, 'W29S4');
  assert.strictEqual(m.sideLoot, true);
  assert.deepStrictEqual(m.lootOrder, config.sideLoot.rooms.W29S4.order);
  assert.strictEqual(m.state, undefined);
  assert.strictEqual(hauler.borrowDone(Game.creeps.r), false);
  m.src = 'x'; m.cf = 'W29S4'; m.state = 'deliver';
  Memory.sideLoot.W29S4.doneAt = 7100;
  assert.strictEqual(hauler.borrowDone(Game.creeps.r), true);
  hauler.giveBack(Game.creeps.r);
  assert.deepStrictEqual(Game.creeps.r.memory, { role: 'remoteHauler', home: 'W29S3', remoteRoom: 'W29S2', slotKey: 'remoteHauler:W29S2:abc:0', state: 'pickup' });
  assert.strictEqual(hauler.borrowCreep('nobody', 'W29S4'), false);
  delete Memory.sideLoot.W29S4.doneAt;
  hauler.borrowCreep('r', 'W29S4', 100);
  Game.time = 7200;
  assert.strictEqual(hauler.borrowDone(Game.creeps.r), true);
  held.energy = 500;
  assert.strictEqual(hauler.borrowDone(Game.creeps.r), false);
  console.log('OK');
}

console.log('--- W37S5: battery only to W32S4/W33S3, energy floor kept ---');
{
  const r = config.terminalNetwork.lootExport.W37S5;
  assert.deepStrictEqual(r.batteryTo, ['W32S4', 'W33S3']);
  assert.strictEqual(r.receiverTerminalFree, 20000);
  assert.strictEqual(r.energyKeep, 80000);
  console.log('OK');
}
console.log('ALL OK');
