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
    dismantle(t) { this.acts.push(['dismantle', t.id, Game.time]); return 0; },
  };
  Game.creeps[name] = c;
  return c;
}
function place(c, roomName, x, y) { c.room = { name: roomName }; c.pos = new RoomPosition(x, y, roomName); }
BODY.watcher = [['attack', 1], ['move', 1]];
BODY.relief = [['claim', 1], ['move', 2]];
BOOSTS.watcher = [];
BODY.dismantler = [['work', 10], ['move', 10]];
BOOSTS.dismantler = [];
const config = require('../src/config');
const noHome = () => { config.war.clear = Object.assign({}, config.war.clear || {}, { pairHomeAfterSites: false }); };
const yesHome = () => { if (config.war.clear) delete config.war.clear.pairHomeAfterSites; };

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
noHome();
const A = mk('A', 'attacker', 'W38S2', 25, 25, 1000);
const H = mk('H', 'healer', 'W38S2', 25, 26, 1000);
const C = mk('C', 'claimer', 'W38S2', 22, 21, 300);
step();
assert.strictEqual(W().mode, 'clear');
assert.strictEqual(W().claimerUntilCreepsDead, true);
assert.deepStrictEqual(W().phase2, { a: 'A', h: 'H' });
assert.deepStrictEqual(W().clear.left, { creeps: 2, sites: 1, extSites: 2, structs: 44, ext: 40 });
const order = [];
let sim = 0;
global.__simMove = true;
while ((hc.length || hs.some((x) => x.structureType === 'spawn') || st.some((s) => s.structureType !== 'road')) && sim < 3000) {
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
assert.strictEqual(order.filter((k) => k === 'site').length, 1, 'only the spawn site is chased; extension sites ignored');
assert.strictEqual(hs.length, 2, 'extension/road sites left alone');
assert.strictEqual(order.filter((k) => k === 'extension').length, 40);
for (const k of ['link', 'terminal', 'storage', 'container']) assert.ok(order.indexOf(k) >= 0, k);
assert.ok(order.indexOf('rampart') >= 0 && order.indexOf('rampart') < order.indexOf('link'), 'rampart over the link goes first');
assert.strictEqual(st.filter((s) => s.structureType === 'road').length, 2, 'roads untouched');
step();
assert.strictEqual(ev('clearDone').length, 1, 'clearDone once');
assert.strictEqual(W().mode, 'watch');
console.log('OK', order.length, 'actions');

console.log('--- site placed under the attacker: it moves to another site instead of standing on it ---');
reset2();
hc.length = 0;
const A1 = mk('A', 'attacker', 'W38S2', 36, 30, 1000);
mk('H', 'healer', 'W38S2', 36, 31, 1000);
hs = [mine({ id: 'u1', structureType: 'tower', pos: new RoomPosition(36, 30, 'W38S2') }), mine({ id: 'u2', structureType: 'tower', pos: new RoomPosition(29, 31, 'W38S2') })];
step();
assert.ok(moves.some((m) => m.name === 'A' && m.to.x === 29 && m.to.y === 31 && m.range === 0), 'walks to the other site');
hs = [mine({ id: 'u1', structureType: 'tower', pos: new RoomPosition(36, 30, 'W38S2') })];
moves.length = 0; step();
assert.ok(moves.some((m) => m.name === 'A' && m.range === 1), 'only the site under it left -> goes on to structures and comes back later');
console.log('OK');

console.log('--- adjacent site: direct move onto it (no pathing) ---');
reset2();
hc.length = 0;
const Ad = mk('A', 'attacker', 'W38S2', 36, 30, 1000);
mk('H', 'healer', 'W38S2', 35, 30, 1000);
Ad.pos.getDirectionTo = function (p) { return p.x > this.x ? 3 : 7; };
hs = [mine({ id: 'sp', structureType: 'spawn', pos: new RoomPosition(37, 30, 'W38S2') })];
step();
assert.ok(Ad.acts.some((x) => x[0] === 'move' && x[1] === 3), 'creep.move(dir) onto the adjacent spawn site');
console.log('OK');

console.log('--- healer off stomping elsewhere: attacker does not wait for it (no hostile creeps) ---');
reset2();
hc.length = 0;
mk('A', 'attacker', 'W38S2', 20, 20, 1000);
mk('H', 'healer', 'W38S2', 40, 40, 1000);
hs = [mine({ id: 'sp', structureType: 'spawn', pos: new RoomPosition(25, 25, 'W38S2') })];
step();
assert.ok(moves.some((m) => m.name === 'A' && m.to.x === 25 && m.range === 0), 'attacker goes for the site');
console.log('OK');

console.log('--- sites first: spawn site, then tower site, then extension sites; attacker and healer split ---');
reset2();
hc.length = 0;
const As = mk('A', 'attacker', 'W38S2', 25, 25, 1000);
const Hs = mk('H', 'healer', 'W38S2', 25, 26, 1000);
hs = [mine({ id: 'e1', structureType: 'extension', pos: new RoomPosition(26, 26, 'W38S2') }), mine({ id: 't1', structureType: 'tower', pos: new RoomPosition(30, 26, 'W38S2') }), mine({ id: 'sp', structureType: 'spawn', pos: new RoomPosition(37, 30, 'W38S2') })];
step();
assert.strictEqual(war.clearTarget(As, war.clearScan(Game.rooms.W38S2)).obj.id, 'sp', 'spawn site first');
const mA = moves.filter((m) => m.name === 'A').pop(), mH = moves.filter((m) => m.name === 'H').pop();
assert.ok(mA.to.x === 37 && mA.to.y === 30 && mA.range === 0, 'attacker -> spawn site');
assert.ok(mH.to.x === 30 && mH.to.y === 26 && mH.range === 0, 'healer splits -> tower site');
kill(hs, 'sp');
assert.strictEqual(war.clearTarget(As, war.clearScan(Game.rooms.W38S2)).obj.id, 't1', 'then tower site');
Game.time += 500;
assert.strictEqual(war.clearTarget(As, war.clearScan(Game.rooms.W38S2)).kind, 'site', 'sites stay first however long he keeps placing them');
hs.length = 0;
moves.length = 0; step();
assert.ok(!moves.some((m) => m.name === 'H' && m.range === 0), 'no sites -> healer stops stomping, stays with the attacker');
assert.ok(Hs.acts.some((x) => x[0] === 'heal'), 'healer heals again');
console.log('OK');

console.log('--- lock cover: no claimer alive at lockEnd+50 -> relief spawns now ---');
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
mk('C', 'claimer', 'W38S2', 22, 21, 500);
mk('C2', 'claimer', 'W38S4', 5, 4, 400);
Game.rooms.W38S2.controller.upgradeBlocked = 700;
step();
let dd = war.getDemands({ name: 'W37S5' }).filter((x) => x.memory.warRole === 'claimer');
assert.strictEqual(dd.length, 0, 'lock ends in 700: a claimer spawned now would die before it -> wait');
Game.rooms.W38S2.controller.upgradeBlocked = 541;
step();
dd = war.getDemands({ name: 'W37S5' }).filter((x) => x.memory.warRole === 'claimer');
assert.strictEqual(dd.length, 1, 'spawn so it lives to lockEnd+50');
assert.strictEqual(ev('lockCover').length, 1);
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
mk('C', 'claimer', 'W38S2', 22, 21, 590);
Game.rooms.W38S2.controller.upgradeBlocked = 400;
step();
assert.strictEqual(war.getDemands({ name: 'W37S5' }).filter((x) => x.memory.warRole === 'claimer').length, 0, 'claimer alive past lockEnd+50 -> no extra');
console.log('OK');

console.log('--- claimer fires attackController at upgradeBlocked<=1 ---');
reset2();
const Cx = mk('C', 'claimer', 'W38S2', 22, 21, 300);
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
Game.rooms.W38S2.controller.upgradeBlocked = 2; step();
assert.ok(!Cx.acts.some((x) => x[0] === 'attackController'));
Game.rooms.W38S2.controller.upgradeBlocked = 1; step();
assert.ok(Cx.acts.some((x) => x[0] === 'attackController'));
console.log('OK');

console.log('--- watch: only spawn/tower sites trigger a 1MOVE stomper; an enemy creep triggers 1A1M ---');
reset2();
hc.length = 0; hs.length = 0; st.length = 0;
step();
hs.push(mine({ id: 'ex', structureType: 'extension', pos: new RoomPosition(28, 28, 'W38S2') }));
step();
assert.strictEqual(ev('watchTrigger').length, 0, 'extension site ignored');
hs.push(mine({ id: 'tw', structureType: 'tower', pos: new RoomPosition(30, 26, 'W38S2') }));
step();
assert.strictEqual(ev('watchTrigger').length, 1);
assert.strictEqual(ev('watchTrigger')[0].d.why, 'site');
let wd = war.getDemands({ name: 'W37S5' });
assert.strictEqual(wd.length, 1);
assert.deepStrictEqual(wd[0].body(5000), ['move'], 'cheap 1MOVE stomper');
assert.strictEqual(wd[0].memory.watchKind, 'site');
const St = mk('St', 'watcher', 'W37S5', 25, 25, 1500, { spawning: true });
St.body = [{ type: 'move', hits: 100 }]; St.memory.watchKind = 'site'; St.memory.slotKey = 'war:watcher:site';
step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'stomper spawning -> nothing more');
hc.push(mine({ id: 'n1', name: 'n1', pos: new RoomPosition(30, 30, 'W38S2'), body: [{ type: 'carry', hits: 100 }] }));
step();
assert.strictEqual(ev('watchTrigger').length, 2, 'enemy creep -> second trigger');
wd = war.getDemands({ name: 'W37S5' });
assert.strictEqual(wd.length, 1);
assert.deepStrictEqual(wd[0].body(5000), ['attack', 'move'], '1A1M for creeps');
St.spawning = false; place(St, 'W38S2', 29, 27); St.pos.getDirectionTo = () => 2;
step();
assert.ok(St.acts.some((x) => x[0] === 'move'), 'stomper steps onto the tower site');
console.log('OK');

console.log('--- enemy safe mode: everyone withdraws home, event, no spawns ---');
reset2();
const As2 = mk('A', 'attacker', 'W38S2', 25, 25, 1000);
const Hs2 = mk('H', 'healer', 'W38S2', 25, 26, 1000);
const Cs2 = mk('C', 'claimer', 'W38S2', 22, 21, 100);
step();
Game.rooms.W38S2.controller.safeMode = 19999;
Game.rooms.W38S2.controller.upgradeBlocked = 0;
moves.length = 0;
step();
assert.strictEqual(ev('enemySafeMode').length, 1);
assert.ok(As2.memory.goHome && Hs2.memory.goHome, 'pair goes home to unboost');
assert.ok(moves.some((m) => m.name === 'C' && m.to.roomName === 'W37S5'), 'claimer withdraws');
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'no spawning in enemy safe mode');
console.log('OK');

console.log('--- claimer relief kept until creeps dead AND sites stomped AND 40 extensions gone ---');
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
const C2 = mk('C', 'claimer', 'W38S2', 22, 21, 100);
Game.rooms.W38S2.controller.upgradeBlocked = 0;
step();
const relief = () => war.getDemands({ name: 'W37S5' }).filter((d) => d.memory.warRole === 'claimer');
let d = relief();
assert.strictEqual(d.length, 1, 'relief due (claimer TTL 100)');
assert.deepStrictEqual(d[0].memory.boosts, [], 'relief claimer unboosted');
assert.deepStrictEqual(d[0].body(5000), ['claim', 'move', 'move'], 'cheap relief body');
hc.length = 0; step();
assert.strictEqual(relief().length, 1, 'creeps dead only -> relief continues');
hs = hs.filter((x) => x.structureType !== 'spawn'); step();
assert.strictEqual(relief().length, 1, 'creeps + spawn/tower sites gone, extensions left -> relief continues');
for (let i = st.length - 1; i >= 0; i--) if (st[i].structureType === 'extension') st.splice(i, 1);
step();
assert.ok(hs.some((x) => x.structureType === 'extension'), 'an extension site is still there');
assert.strictEqual(relief().length, 0, 'all three (extension sites do not count) -> relief stops');
assert.strictEqual(ev('reliefStop').length, 1);
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
mk('C', 'claimer', 'W38S2', 22, 21, 100);
Memory.ags131War.claimerUntilCreepsDead = false;
step();
assert.strictEqual(relief().length, 0, 'flag off -> no claimer relief');
reset2();
mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
mk('C', 'claimer', 'W38S2', 22, 21, 100);
Game.rooms.W38S2.controller.upgradeBlocked = 0;
step();
assert.strictEqual(relief().length, 1);
Game.time = 74487499;
step();
assert.strictEqual(W().mode, 'watch', 'hard cap 74487500 -> watch');
assert.strictEqual(ev('hardCap').length, 1);
assert.strictEqual(relief().length, 0, 'hard cap -> relief stops regardless');
assert.ok(Game.creeps.A.memory.goHome, 'pair heads home');
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
assert.strictEqual(W().mode, 'clear', 'pair gone, dismantler still to come -> stays clear');
const dms = war.getDemands({ name: 'W37S5' });
assert.strictEqual(dms.filter((x) => x.memory.warRole === 'attacker' || x.memory.warRole === 'healer').length, 0, 'no new boosted squad');
assert.strictEqual(dms.filter((x) => x.memory.warRole === 'dismantler').length, 1, 'one dismantler instead');
Memory.ags131War.dismantler = { spawned: 'gone' };
step();
assert.strictEqual(W().mode, 'watch', 'pair and dismantler gone with work left -> watch');
assert.strictEqual(ev('clearIncomplete').length, 1);
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

console.log('--- watch: exactly one creep per episode ---');
reset2();
hc.length = 0; hs.length = 0; st.length = 0;
step();
hs.push(mine({ id: 'ns', structureType: 'spawn', pos: new RoomPosition(28, 28, 'W38S2') }));
step();
assert.strictEqual(ev('watchTrigger').length, 1);
d = war.getDemands({ name: 'W37S5' });
assert.strictEqual(d.length, 1);
const Wt = mk('Wt', 'watcher', 'W37S5', 25, 25, 1500, { spawning: true });
Wt.memory.watchKind = 'site';
step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'one already spawning');
delete Game.creeps.Wt;
step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'died, same episode -> no second creep');
assert.strictEqual(ev('watchTrigger').length, 1, 'logged once per episode');
hs.length = 0; step();
hs.push(mine({ id: 'ns2', structureType: 'tower', pos: new RoomPosition(28, 28, 'W38S2') }));
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


console.log('--- 11:18 only extension sites: attacker / dismantler go for structures, never the sites ---');
reset2();
noHome();
hc.length = 0;
hs = [mine({ id: 'es1', structureType: 'extension', pos: new RoomPosition(26, 26, 'W38S2') }), mine({ id: 'es2', structureType: 'extension', pos: new RoomPosition(24, 24, 'W38S2') })];
const Ae = mk('A', 'attacker', 'W38S2', 25, 25, 1000);
mk('H', 'healer', 'W38S2', 25, 26, 1000);
step();
let te = war.clearTarget(Ae, war.clearScan(Game.rooms.W38S2));
assert.strictEqual(te.kind, 'struct', 'attacker -> structure');
assert.strictEqual(te.obj.structureType, 'extension');
assert.ok(!moves.some((m) => m.range === 0), 'nobody stomps extension sites');
const De = mk('D', 'dismantler', 'W38S2', 25, 25, 1400);
moves.length = 0; step();
assert.ok(moves.some((m) => m.name === 'D' && m.range === 1 && m.to.y >= 32), 'dismantler heads to an extension structure');
assert.ok(!moves.some((m) => m.name === 'D' && m.range === 0), 'dismantler ignores extension sites');
const cm = { v: {}, get(x, y) { return this.v[x + ',' + y] || 0; }, set(x, y, c) { this.v[x + ',' + y] = c; } };
const goCall = moves.find((m) => m.name === 'D');
assert.ok(goCall, 'moved');
console.log('OK');

console.log('--- 11:18 attacker stomps the spawn site then goes home; healer goes home too ---');
reset2();
yesHome();
hc.length = 0;
hs = [mine({ id: 'sp7', structureType: 'spawn', pos: new RoomPosition(37, 30, 'W38S2') }), mine({ id: 'ex7', structureType: 'extension', pos: new RoomPosition(30, 30, 'W38S2') })];
const A7 = mk('A', 'attacker', 'W38S2', 36, 30, 160);
const H7 = mk('H', 'healer', 'W38S2', 35, 30, 700);
A7.pos.getDirectionTo = () => 3;
step();
assert.ok(A7.acts.some((x) => x[0] === 'move' && x[1] === 3), 'stomps (37,30) first');
assert.ok(!A7.memory.goHome);
kill(hs, 'sp7');
step();
assert.ok(A7.memory.goHome, 'no spawn/tower sites left -> attacker home');
step();
assert.ok(H7.memory.goHome, 'healer follows home');
console.log('OK');

console.log('--- 11:18 dismantler: one 10W10M unboosted, order ext > terminal > storage > container > link, no roads ---');
reset2();
hc.length = 0; hs.length = 0;
mk('C', 'claimer', 'W38S2', 22, 21, 500);
step();
let dq = war.getDemands({ name: 'W37S5' }).filter((x) => x.memory.warRole === 'dismantler');
assert.strictEqual(dq.length, 1);
assert.deepStrictEqual(dq[0].body(5600), ['work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', 'move', 'move', 'move', 'move', 'move', 'move', 'move', 'move', 'move', 'move']);
assert.strictEqual(dq[0].body(5600).reduce((t, p) => t + ({ work: 100, move: 50 })[p], 0), 1500);
assert.deepStrictEqual(dq[0].memory.boosts, []);
const D8 = mk('D', 'dismantler', 'W38S2', 30, 31, 1400);
step();
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }).filter((x) => x.memory.warRole === 'dismantler'), [], 'only one');
assert.strictEqual(W().dismantler.spawned, 'D');
global.__simMove = true;
const dorder = [];
for (let i = 0; i < 400 && st.some((x) => x.structureType !== 'road'); i++) {
  D8.acts.length = 0;
  step();
  const dd2 = D8.acts.find((x) => x[0] === 'dismantle');
  if (dd2) { const o = st.find((x) => x.id === dd2[1]); assert.ok(o); assert.notStrictEqual(o.structureType, 'road'); dorder.push(o.structureType); kill(st, o.id); }
}
global.__simMove = false;
const firstNonExt = dorder.findIndex((k) => k !== 'extension');
assert.strictEqual(firstNonExt, 40, 'all extensions first');
assert.deepStrictEqual(dorder.slice(40), ['terminal', 'storage', 'container', 'link']);
assert.strictEqual(st.length, 2, 'roads left');
step();
assert.ok(D8.memory.retired, 'done -> recycle');
console.log('OK');

console.log('--- 11:18 dismantler stomps spawn/tower sites near its path only, retreats on combat creep / safe mode ---');
reset2();
hc.length = 0;
hs = [mine({ id: 'far', structureType: 'spawn', pos: new RoomPosition(5, 5, 'W38S2') })];
mk('C', 'claimer', 'W38S2', 22, 21, 500);
const D9 = mk('D', 'dismantler', 'W38S2', 30, 31, 1400);
step();
assert.ok(!moves.some((m) => m.name === 'D' && m.range === 0), 'far spawn site ignored');
hs.push(mine({ id: 'near', structureType: 'tower', pos: new RoomPosition(32, 31, 'W38S2') }));
moves.length = 0; step();
assert.ok(moves.some((m) => m.name === 'D' && m.range === 0 && m.to.x === 32), 'near tower site stomped');
hs.length = 0;
hc.push(mine({ id: 'k9', name: 'k9', pos: new RoomPosition(10, 10, 'W38S2'), body: [{ type: 'attack', hits: 100 }] }));
moves.length = 0; step();
assert.ok(moves.some((m) => m.name === 'D' && m.to.roomName === 'W37S5'), 'combat creep -> retreat home');
hc.length = 0;
moves.length = 0; step();
assert.ok(!moves.some((m) => m.name === 'D' && m.to.roomName === 'W37S5'), 'threat gone -> back to work');
Game.rooms.W38S2.controller.safeMode = 5000;
moves.length = 0; step();
assert.ok(moves.some((m) => m.name === 'D' && m.to.roomName === 'W37S5'), 'enemy safe mode -> home');
console.log('OK');

console.log('--- site avoid costCallback marks extension sites, not spawn/tower ---');
{
  reset2();
  hc.length = 0;
  hs = [mine({ id: 'e', structureType: 'extension', pos: new RoomPosition(10, 10, 'W38S2') }), mine({ id: 't', structureType: 'tower', pos: new RoomPosition(11, 11, 'W38S2') })];
  Memory.ags131War.mode = 'clear';
  const D0 = mk('D', 'dismantler', 'W38S2', 10, 40, 1400);
  let captured = null;
  const mv = require.cache[path.join(src, 'movement.js')].exports;
  const og = mv.go;
  mv.go = (c, t, o) => { captured = o; };
  step();
  mv.go = og;
  assert.ok(captured && typeof captured.costCallback === 'function', JSON.stringify([captured, W().mode, D0.acts, D0.memory]));
  const cm2 = { v: {}, get(x, y) { return this.v[x + ',' + y] || 0; }, set(x, y, c) { this.v[x + ',' + y] = c; } };
  captured.costCallback('W38S2', cm2);
  assert.strictEqual(cm2.get(10, 10), 60);
  assert.strictEqual(cm2.get(11, 11), 0);
}
console.log('OK');

console.log('ALL PHASE 2 TESTS PASSED');
