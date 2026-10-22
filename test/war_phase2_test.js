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

global.Game = { time: 1000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {} };
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
global.TOP = 1;
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
RoomPosition.prototype.isNearTo = function (p) { return this.roomName === (p.roomName || this.roomName) && Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= 1; };
RoomPosition.prototype.inRangeTo = function (p, r) { return Math.max(Math.abs(this.x - p.x), Math.abs(this.y - p.y)) <= r; };
RoomPosition.prototype.isEqualTo = function (p) { return this.x === p.x && this.y === p.y && this.roomName === p.roomName; };
RoomPosition.prototype.findClosestByRange = function (list) { return Array.isArray(list) && list.length ? list[0] : null; };

const moves = [];
require.cache[path.join(src, 'movement.js')] = { id: 'movement', filename: path.join(src, 'movement.js'), loaded: true,
  exports: { go(creep, target, opts) {
    moves.push({ name: creep.name, to: target, range: opts && opts.range, t: Game.time });
    if (global.__simMove && creep.pos.roomName === target.roomName) {
      const dx = Math.sign(target.x - creep.pos.x); const dy = Math.sign(target.y - creep.pos.y);
      creep.pos = new RoomPosition(creep.pos.x + dx, creep.pos.y + dy, creep.pos.roomName);
    }
  } } };
require.cache[path.join(src, 'retire.js')] = { id: 'retire', filename: path.join(src, 'retire.js'), loaded: true,
  exports: { retireAtSpawn() {} } };

global.FIND_HOSTILE_CONSTRUCTION_SITES = 'hostileSites'; global.FIND_STRUCTURES = 'structures'; global.FIND_MY_STRUCTURES = 'myStructures'; global.LOOK_STRUCTURES = 'structure';
const war = require('../src/war');
const warrior = require('../src/roles/warrior');

const BODY = {
  attacker: [['tough', 8, 'XGHO2'], ['attack', 17, 'XUH2O'], ['move', 25]],
  healer: [['tough', 10, 'XGHO2'], ['heal', 15, 'XLHO2'], ['move', 25]],
  claimer: [['tough', 10, 'XGHO2'], ['claim', 4], ['move', 14]],
};
const BOOSTS = { attacker: ['XGHO2', 'XUH2O'], healer: ['XGHO2', 'XLHO2'], claimer: ['XGHO2'] };

function mk(name, role, roomName, x, y, ttl, opts) {
  opts = opts || {};
  const body = [];
  for (const [t, n, b] of BODY[role]) for (let i = 0; i < n; i++) body.push({ type: t, hits: 100, boost: opts.unboosted ? undefined : b });
  const c = {
    name, id: name, hits: opts.hits == null ? body.length * 100 : opts.hits, hitsMax: body.length * 100,
    ticksToLive: ttl, spawning: !!opts.spawning, fatigue: 0, body, store: {},
    room: { name: roomName }, pos: new RoomPosition(x, y, roomName), acts: [],
    memory: { role: 'warrior', warRole: role, home: 'W37S5', targetRoom: 'W38S2', boosts: BOOSTS[role].slice(), boostDone: true, slotKey: 'war:' + role + ':0' },
    move(d) { this.acts.push(['move', d, Game.time]); return 0; },
    attack(t) { this.acts.push(['attack', t.id, Game.time]); return 0; },
    heal(t) { this.acts.push(['heal', t.name, Game.time]); return 0; },
    rangedHeal(t) { this.acts.push(['rangedHeal', t.name, Game.time]); return 0; },
    attackController(t) { this.acts.push(['attackController', Game.time]); return 0; },
  };
  Game.creeps[name] = c;
  return c;
}
function place(c, roomName, x, y) { c.room = { name: roomName }; c.pos = new RoomPosition(x, y, roomName); }
BODY.watcher = [['attack', 1], ['move', 1]];
BODY.relief = [['claim', 1], ['move', 2]];
BOOSTS.watcher = [];

let hc, hs, st, ramps;
const mine = (o) => Object.assign({ my: false, owner: { username: 'ags131' } }, o);
function tgtRoom(blocked) {
  Game.rooms.W38S2 = {
    name: 'W38S2',
    controller: { id: 'ctl', pos: new RoomPosition(22, 20, 'W38S2'), safeMode: 0, upgradeBlocked: blocked || 0 },
    find: (t) => t === FIND_HOSTILE_SPAWNS ? [] : t === FIND_HOSTILE_STRUCTURES ? st.filter((s) => s.owner) : t === FIND_HOSTILE_CREEPS ? hc : t === FIND_HOSTILE_CONSTRUCTION_SITES ? hs : t === FIND_STRUCTURES ? st.concat(ramps) : [],
    lookForAt: (k, x, y) => ramps.filter((r) => r.pos.x === x && r.pos.y === y),
  };
}
const labs = [];
function homeRoom() {
  Game.rooms.W37S5 = { name: 'W37S5', find: (t) => t === 'myStructures' ? labs : t === FIND_MY_SPAWNS ? [{ pos: new RoomPosition(25, 25, 'W37S5') }] : [] };
}
function reset2() {
  Game.time = 2000; Game.creeps = {}; Game.rooms = {}; Game.spawns = {}; Game.cpu.bucket = 10000; Game.structures = {};
  Game.getObjectById = () => null;
  Memory.ags131War = { enabled: true, phase: 'won', events: [], round: 3, spend: { energy: 1000, boostEnergy: 0, boosts: {}, round: 3 }, squad: { a: 'A', h: 'H', c: 'C' } };
  moves.length = 0;
  hc = [mine({ id: 'e1', name: 'w1', pos: new RoomPosition(30, 30, 'W38S2'), body: [{ type: 'work', hits: 100 }] }), mine({ id: 'e2', name: 'w2', pos: new RoomPosition(10, 10, 'W38S2'), body: [{ type: 'carry', hits: 100 }] })];
  hs = [mine({ id: 's1', structureType: 'road', pos: new RoomPosition(10, 45, 'W38S2') }), mine({ id: 's2', structureType: 'extension', pos: new RoomPosition(12, 45, 'W38S2') }), mine({ id: 's3', structureType: 'spawn', pos: new RoomPosition(14, 45, 'W38S2') })];
  st = [];
  for (let i = 0; i < 40; i++) st.push(mine({ id: 'x' + i, structureType: 'extension', pos: new RoomPosition(30 + (i % 8), 32 + Math.floor(i / 8), 'W38S2') }));
  st.push(mine({ id: 'lk', structureType: 'link', pos: new RoomPosition(20, 30, 'W38S2') }));
  st.push(mine({ id: 'tm', structureType: 'terminal', pos: new RoomPosition(21, 30, 'W38S2') }));
  st.push(mine({ id: 'sg', structureType: 'storage', pos: new RoomPosition(22, 30, 'W38S2') }));
  st.push({ id: 'ct', structureType: 'container', pos: new RoomPosition(23, 30, 'W38S2') });
  st.push({ id: 'rd1', structureType: 'road', pos: new RoomPosition(24, 30, 'W38S2') });
  st.push({ id: 'rd2', structureType: 'road', pos: new RoomPosition(25, 30, 'W38S2') });
  ramps = [];
  tgtRoom(900);
  homeRoom();
  labs.length = 0;
}
function step() {
  Game.time++;
  war.tick();
  for (const n of Object.keys(Game.creeps)) warrior.run(Game.creeps[n]);
}
const W = () => Memory.ags131War;
const ev = (e) => W().events.filter((x) => x.e === e);
const kill = (list, id) => { const i = list.findIndex((o) => o.id === id); if (i >= 0) list.splice(i, 1); };

console.log('--- clear order: creeps, then sites (stomp), then structures; roads untouched ---');
reset2();
const A = mk('A', 'attacker', 'W38S2', 25, 25, 1000);
const H = mk('H', 'healer', 'W38S2', 25, 26, 1000);
const C = mk('C', 'claimer', 'W38S2', 22, 21, 300);
step();
assert.strictEqual(W().mode, 'clear');
assert.strictEqual(W().claimerUntilCreepsDead, true);
assert.deepStrictEqual(W().phase2, { a: 'A', h: 'H' });
assert.deepStrictEqual(W().clear.left, { creeps: 2, sites: 3, structs: 44, ext: 40 });
const order = [];
let sim = 0;
global.__simMove = true;
while ((hc.length || hs.length || st.some((s) => s.structureType !== 'road')) && sim < 3000) {
  sim++;
  A.acts.length = 0;
  step();
  const at = A.acts.find((x) => x[0] === 'attack');
  if (at) {
    const id = at[1];
    if (hc.some((o) => o.id === id)) { order.push('creep'); kill(hc, id); }
    else if (ramps.some((o) => o.id === id)) { order.push('rampart'); kill(ramps, id); }
    else { const o = st.find((x) => x.id === id); assert.ok(o, 'attack target exists ' + id); assert.notStrictEqual(o.structureType, 'road', 'roads never attacked'); order.push(o.structureType); kill(st, id); }
  }
  const onSite = hs.find((s) => s.pos.x === A.pos.x && s.pos.y === A.pos.y);
  if (onSite) { order.push('site'); kill(hs, onSite.id); }
  place(H, A.pos.roomName, A.pos.x, A.pos.y + 1);
  if (sim === 5) ramps.push({ id: 'rp', structureType: 'rampart', my: false, owner: { username: 'ags131' }, pos: new RoomPosition(20, 30, 'W38S2') });
}
global.__simMove = false;
const firstSite = order.indexOf('site'), lastCreep = order.lastIndexOf('creep');
const firstStruct = order.findIndex((k) => k !== 'creep' && k !== 'site');
assert.ok(lastCreep >= 0 && firstSite > lastCreep, 'creeps die before sites are stomped ' + order.slice(0, 6));
assert.ok(firstStruct > order.lastIndexOf('site'), 'sites before structures');
assert.strictEqual(order.filter((k) => k === 'extension').length, 40);
for (const k of ['link', 'terminal', 'storage', 'container']) assert.ok(order.indexOf(k) >= 0, k);
assert.ok(order.indexOf('rampart') >= 0 && order.indexOf('rampart') < order.indexOf('link'), 'rampart over the link goes first');
assert.strictEqual(st.filter((s) => s.structureType === 'road').length, 2, 'roads untouched');
step();
assert.strictEqual(ev('clearDone').length, 1, 'clearDone once');
assert.strictEqual(W().mode, 'watch');
console.log('OK', order.length, 'actions');

console.log('--- claimer relief kept until creeps dead AND sites stomped AND 40 extensions gone ---');
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
const C2 = mk('C', 'claimer', 'W38S2', 22, 21, 100);
step();
const relief = () => war.getDemands({ name: 'W37S5' }).filter((d) => d.memory.warRole === 'claimer');
let d = relief();
assert.strictEqual(d.length, 1, 'relief due (claimer TTL 100)');
assert.deepStrictEqual(d[0].memory.boosts, [], 'relief claimer unboosted');
assert.deepStrictEqual(d[0].body(5000), ['claim', 'move', 'move'], 'cheap relief body');
hc.length = 0; step();
assert.strictEqual(relief().length, 1, 'creeps dead only -> relief continues');
hs.length = 0; step();
assert.strictEqual(relief().length, 1, 'creeps + sites gone, extensions left -> relief continues');
for (let i = st.length - 1; i >= 0; i--) if (st[i].structureType === 'extension') st.splice(i, 1);
step();
assert.strictEqual(relief().length, 0, 'all three -> relief stops');
assert.strictEqual(ev('reliefStop').length, 1);
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
mk('C', 'claimer', 'W38S2', 22, 21, 100);
Memory.ags131War.claimerUntilCreepsDead = false;
step();
assert.strictEqual(relief().length, 0, 'flag off -> no claimer relief');
console.log('OK');

console.log('--- claimer holds next to controller, hits only when unlocked, never claims ---');
reset2();
const C3 = mk('C', 'claimer', 'W38S2', 22, 21, 300);
C3.claimController = () => { throw new Error('claim'); };
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
step();
assert.ok(!C3.acts.some((x) => x[0] === 'attackController'), 'locked -> no hit');
Game.rooms.W38S2.controller.upgradeBlocked = 0;
step();
assert.ok(C3.acts.some((x) => x[0] === 'attackController'), 'lock lapsed -> re-hit');
assert.ok(!moves.some((m) => m.name === 'C'), 'stays put next to controller');
console.log('OK');

console.log('--- attacker TTL<150 goes home, both unboost at a lab, then recycle; labs released ---');
reset2();
const A4 = mk('A', 'attacker', 'W38S2', 25, 25, 160);
const H4 = mk('H', 'healer', 'W38S2', 25, 26, 900);
mk('C', 'claimer', 'W38S2', 22, 21, 300);
step();
assert.strictEqual(W().mode, 'clear');
const room37 = { name: 'W37S5' };
assert.strictEqual(war.labActive(room37), true, 'labs held during clear');
assert.deepStrictEqual(war.labCompounds(), [], 'no boost loading during clear');
for (let i = 0; i < 9; i++) step();
A4.ticksToLive = 149;
step();
assert.ok(A4.memory.goHome && H4.memory.goHome, 'TTL 149 -> both head home');
assert.ok(moves.filter((m) => m.name === 'A').pop().to.roomName === 'W37S5');
const unb = [];
const lab = { id: 'L1', structureType: 'lab', cooldown: 0, pos: new RoomPosition(30, 30, 'W37S5'), unboostCreep(c) { if (this.cooldown) return -11; unb.push(c.name); this.cooldown = 100; for (const p of c.body) delete p.boost; return OK; } };
const lab2 = { id: 'L2', structureType: 'lab', cooldown: 0, pos: new RoomPosition(31, 30, 'W37S5'), unboostCreep: lab.unboostCreep };
labs.push(lab, lab2);
place(A4, 'W37S5', 29, 29); place(H4, 'W37S5', 32, 31);
step();
assert.deepStrictEqual(unb.sort(), ['A', 'H']);
assert.strictEqual(ev('unboosted').length, 2);
assert.deepStrictEqual(W().unboosted.A.returned, { XGHO2: 120, XUH2O: 255 });
assert.deepStrictEqual(W().unboosted.H.returned, { XGHO2: 150, XLHO2: 225 });
assert.deepStrictEqual(W().spend.returned, { XGHO2: 270, XUH2O: 255, XLHO2: 225 });
step();
assert.ok(A4.memory.retired && H4.memory.retired, 'recycled after unboost');
assert.ok(W().labsReleased, 'labs released');
assert.strictEqual(war.labActive(room37), false, 'labs back to reactions');
assert.strictEqual(ev('labsReleased').length, 1);
assert.strictEqual(W().mode, 'watch', 'pair gone with work left -> watch');
assert.strictEqual(ev('clearIncomplete').length, 1);
assert.strictEqual(war.getDemands({ name: 'W37S5' }).filter((x) => x.memory.warRole === 'attacker' || x.memory.warRole === 'healer').length, 0, 'no new squad');
console.log('OK');

console.log('--- one lab on cooldown: second creep waits for a free lab, labs stay held until both unboosted ---');
reset2();
const A5 = mk('A', 'attacker', 'W37S5', 29, 29, 100);
const H5 = mk('H', 'healer', 'W37S5', 29, 31, 100);
A5.memory.goHome = 1; H5.memory.goHome = 1;
const L = { id: 'L1', structureType: 'lab', cooldown: 0, pos: new RoomPosition(30, 30, 'W37S5'), unboostCreep(c) { this.cooldown = 50; for (const p of c.body) delete p.boost; return OK; } };
labs.push(L);
step();
assert.ok(W().unboosted.A && !W().unboosted.H, 'only one lab free');
assert.strictEqual(war.labActive({ name: 'W37S5' }), true, 'still held');
L.cooldown = 0; step(); step();
assert.ok(W().unboosted.H);
assert.strictEqual(war.labActive({ name: 'W37S5' }), false);
console.log('OK');

console.log('--- no squad/claimer respawn after relief stops ---');
reset2();
hc.length = 0; hs.length = 0; st.length = 0;
step();
assert.strictEqual(W().mode, 'watch');
for (let i = 0; i < 50; i++) step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), []);
console.log('OK');

console.log('--- watch: trigger on spawn site / combat creep spawns exactly one cheap creep ---');
reset2();
hc.length = 0; hs.length = 0; st.length = 0;
step();
assert.strictEqual(W().mode, 'watch');
hc.push(mine({ id: 'n1', name: 'n1', pos: new RoomPosition(30, 30, 'W38S2'), body: [{ type: 'carry', hits: 100 }, { type: 'move', hits: 100 }] }));
step();
assert.strictEqual(ev('watchTrigger').length, 0, 'carry/move creep is not a threat');
hs.push(mine({ id: 'ns', structureType: 'spawn', pos: new RoomPosition(28, 28, 'W38S2') }));
step();
assert.strictEqual(ev('watchTrigger').length, 1);
assert.strictEqual(ev('watchTrigger')[0].d.why, 'spawnSite');
d = war.getDemands({ name: 'W37S5' });
assert.strictEqual(d.length, 1);
assert.strictEqual(d[0].memory.warRole, 'watcher');
assert.deepStrictEqual(d[0].body(5000), ['attack', 'move']);
assert.deepStrictEqual(d[0].memory.boosts, []);
const Wt = mk('Wt', 'watcher', 'W37S5', 25, 25, 1500, { spawning: true });
Wt.memory.slotKey = 'war:watcher:0';
step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'one already spawning');
Wt.spawning = false;
delete Game.creeps.Wt;
step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'watcher died, same episode -> no second creep');
assert.strictEqual(ev('watchTrigger').length, 1, 'logged once per episode');
hs.length = 0; hc.length = 0; step();
hc.push(mine({ id: 'k1', name: 'k1', pos: new RoomPosition(30, 30, 'W38S2'), body: [{ type: 'attack', hits: 100 }] }));
step();
assert.strictEqual(ev('watchTrigger').length, 2, 'new episode');
assert.strictEqual(war.getDemands({ name: 'W37S5' }).length, 1);
console.log('OK');

console.log('--- watcher stomps sites and attacks creeps ---');
reset2();
hc.length = 0; st.length = 0;
hs = [mine({ id: 'ns', structureType: 'spawn', pos: new RoomPosition(28, 28, 'W38S2') })];
const W6 = mk('W6', 'watcher', 'W38S2', 25, 25, 1000);
Memory.ags131War.mode = 'watch'; Memory.ags131War.labsReleased = 1;
step();
assert.ok(moves.some((m) => m.name === 'W6' && m.to.x === 28 && m.range === 0), 'walks onto spawn site');
hc.push(mine({ id: 'k2', name: 'k2', pos: new RoomPosition(25, 26, 'W38S2'), body: [{ type: 'attack', hits: 100 }] }));
step();
assert.ok(W6.acts.some((x) => x[0] === 'attack' && x[1] === 'k2'));
console.log('OK');

console.log('--- watch without vision uses the observer every 20 ticks ---');
reset2();
hc.length = 0; hs.length = 0; st.length = 0;
step();
delete Game.rooms.W38S2;
const obs = { id: 'ob', structureType: 'observer', pos: new RoomPosition(25, 25, 'W37S5'), calls: 0, observeRoom(r) { this.calls++; this.room = r; return OK; } };
Game.structures = { ob: obs };
Game.map = { getRoomLinearDistance: () => 3 };
for (let i = 0; i < 40; i++) step();
assert.strictEqual(obs.calls, 2);
assert.strictEqual(obs.room, 'W38S2');
console.log('OK');

console.log('ALL PHASE 2 TESTS PASSED');
