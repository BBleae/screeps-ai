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
  exports: { go(creep, target, opts) { moves.push({ name: creep.name, to: target, range: opts && opts.range, t: Game.time }); } } };
require.cache[path.join(src, 'retire.js')] = { id: 'retire', filename: path.join(src, 'retire.js'), loaded: true,
  exports: { retireAtSpawn() {} } };

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

let spawnObj, towers;
function targetRoom(blocked) {
  spawnObj = { id: 'sp', pos: new RoomPosition(30, 22, 'W38S2'), structureType: 'spawn' };
  towers = [{ id: 't1', pos: new RoomPosition(30, 26, 'W38S2'), structureType: 'tower' }, { id: 't2', pos: new RoomPosition(39, 27, 'W38S2'), structureType: 'tower' }];
  Game.rooms.W38S2 = {
    name: 'W38S2',
    controller: { id: 'ctl', pos: new RoomPosition(22, 20, 'W38S2'), safeMode: 0, upgradeBlocked: blocked || 0 },
    find: (t) => (t === FIND_HOSTILE_SPAWNS ? [spawnObj] : t === FIND_HOSTILE_STRUCTURES ? towers : []),
  };
}
function reset() {
  Game.time = 1000; Game.creeps = {}; Game.rooms = {}; Game.spawns = {}; Game.cpu.bucket = 10000;
  Memory.ags131War = { enabled: true, phase: 'staging', events: [] };
  Memory.cpuRoll = null;
  moves.length = 0;
  targetRoom(0);
}
function step() {
  Game.time++;
  war.tick();
  for (const n of Object.keys(Game.creeps)) warrior.run(Game.creeps[n]);
}
const W = () => Memory.ags131War;
const ev = (e) => W().events.filter((x) => x.e === e);

console.log('--- switch off ---');
Memory.ags131War = undefined;
assert.strictEqual(war.active(), false);
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), []);
assert.strictEqual(war.lootHaulerCap(14), 14);
console.log('OK');

console.log('--- healer arrives late: attacker waits in W38S3, nobody crosses alone ---');
reset();
const a = mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const h = mk('H', 'healer', 'W38S4', 20, 30, 1300);
const c = mk('C', 'claimer', 'W38S3', 21, 1, 470);
for (let i = 0; i < 20; i++) step();
assert.strictEqual(W().phase, 'staging', 'no entry without healer in W38S3');
assert.strictEqual(W().entryWait, 'notStaged');
assert.ok(!a.acts.some((x) => x[0] === 'move'), 'attacker never steps onto the exit');
assert.ok(!a.acts.some((x) => x[0] === 'attack'));
assert.ok(moves.filter((m) => m.name === 'A').every((m) => m.to.roomName === 'W38S3'), 'attacker only moves inside W38S3');
assert.ok(moves.filter((m) => m.name === 'C').every((m) => m.to.roomName === 'W38S3'), 'claimer holds in W38S3 too');
place(h, 'W38S3', 25, 10);
step();
assert.strictEqual(W().phase, 'staging', 'healer far (>3) -> still staging');
assert.strictEqual(W().entryWait, 'apart');
place(h, 'W38S3', 20, 1);
c.ticksToLive = 395;
step();
assert.strictEqual(W().entryWait, 'claimer', 'claimer TTL < 400 blocks entry');
c.ticksToLive = 450;
step();
assert.strictEqual(W().phase, 'assault', 'all three in W38S3 within 3 tiles -> entry signal');
const entered = ev('entered')[0];
assert.ok(entered && entered.d.c === 'C' && entered.d.cTtl >= 400 && Number.isFinite(entered.d.relief), 'entered records claimer ttl and relief spawn tick');
console.log('OK entry signal at', Game.time, entered.d);

console.log('--- attacker + healer cross on the same tick, claimer right after ---');
a.acts.length = 0; h.acts.length = 0; c.acts.length = 0;
step();
const aTop = a.acts.filter((x) => x[0] === 'move' && x[1] === TOP);
const hTop = h.acts.filter((x) => x[0] === 'move' && x[1] === TOP);
assert.strictEqual(aTop.length, 1); assert.strictEqual(hTop.length, 1);
assert.strictEqual(aTop[0][2], hTop[0][2], 'same tick');
assert.ok(!c.acts.some((x) => x[0] === 'move'), 'claimer does not take an exit tile that tick');
assert.ok(!moves.some((m) => m.name === 'C' && m.t === Game.time && m.to.roomName === 'W38S2'), 'claimer waits until A+H are inside');
place(a, 'W38S2', 19, 49); place(h, 'W38S2', 20, 49);
moves.length = 0;
step();
assert.ok(moves.some((m) => m.name === 'C' && m.to.roomName === 'W38S2'), 'claimer follows once both are inside');
assert.strictEqual(W().phase, 'assault', 'claimer one tick behind is within grace');
place(c, 'W38S2', 20, 48); place(a, 'W38S2', 19, 47); place(h, 'W38S2', 20, 47);
step();
assert.ok(W().entries.A && W().entries.H && W().entries.C, 'entry ticks recorded per unit');
assert.strictEqual(W().breach, null);
console.log('OK entries', W().entries);

console.log('--- attacker never attacks before upgradeBlocked>0 ---');
place(a, 'W38S2', 29, 22);
place(h, 'W38S2', 27, 21);
place(c, 'W38S2', 25, 21);
a.acts.length = 0;
step();
assert.ok(!a.acts.some((x) => x[0] === 'attack'), 'no attack while unlocked');
Game.rooms.W38S2.controller.upgradeBlocked = 999;
step();
assert.ok(a.acts.some((x) => x[0] === 'attack' && x[1] === 'sp'), 'attacks spawn first once locked');
console.log('OK');

console.log('--- claimer adjacent to controller tries attackController every tick ---');
place(c, 'W38S2', 23, 20);
c.acts.length = 0;
for (let i = 0; i < 3; i++) step();
assert.strictEqual(c.acts.filter((x) => x[0] === 'attackController').length, 3);
console.log('OK');

console.log('--- healer drifts away -> squad auto-retreats after grace ---');
place(h, 'W38S2', 40, 40);
step(); step();
assert.strictEqual(W().phase, 'assault');
step();
assert.strictEqual(W().phase, 'staging', 'apart for 3 ticks -> regroup');
assert.strictEqual(ev('retreat').slice(-1)[0].d.reason, 'apart');
moves.length = 0;
step();
assert.ok(moves.filter((m) => ['A', 'H', 'C'].indexOf(m.name) >= 0).every((m) => m.to.roomName === 'W38S3'), 'everyone heads back to W38S3');
console.log('OK');

console.log('--- dead attacker -> immediate retreat ---');
W().phase = 'assault'; W().squad = { a: 'A', h: 'H', c: 'C' };
place(a, 'W38S2', 29, 22); place(h, 'W38S2', 28, 22);
delete Game.creeps.A;
step();
assert.strictEqual(W().phase, 'staging');
assert.strictEqual(ev('retreat').slice(-1)[0].d.reason, 'attackerDead');
console.log('OK');

console.log('--- split crossing (attacker in, healer out) -> retreat ---');
reset();
const a2 = mk('A', 'attacker', 'W38S2', 19, 47, 1200);
const h2 = mk('H', 'healer', 'W38S3', 20, 2, 1300);
mk('C', 'claimer', 'W38S3', 21, 1, 450);
W().phase = 'assault'; W().squad = { a: 'A', h: 'H', c: 'C' };
step(); step(); step();
assert.strictEqual(W().phase, 'staging');
assert.strictEqual(ev('retreat').slice(-1)[0].d.reason, 'split');
console.log('OK');

console.log('--- squad before claimer: no claimer until A+H fully boosted and standing in W38S3 ---');
reset();
const T = war.timing();
const room = { name: 'W37S5' };
mk('A', 'attacker', 'W38S4', 20, 20, 1300);
mk('H', 'healer', 'W38S5', 20, 20, 1350);
let d = war.getDemands(room);
assert.strictEqual(W().plan.nextClaimerSpawn, null, 'A/H still walking -> no claimer scheduled');
assert.ok(!d.some((r) => r.memory.warRole === 'claimer'), 'A/H not staged -> no claimer');
place(Game.creeps.A, 'W38S3', 19, 1);
d = war.getDemands(room);
assert.ok(!d.some((r) => r.memory.warRole === 'claimer'), 'only attacker staged -> no claimer');
place(Game.creeps.H, 'W38S3', 20, 1);
Game.creeps.H.body.filter((p) => p.type === 'heal').forEach((p) => { p.boost = undefined; });
d = war.getDemands(room);
assert.ok(!d.some((r) => r.memory.warRole === 'claimer'), 'healer staged but not fully boosted -> no claimer');
Game.creeps.H.body.filter((p) => p.type === 'heal').forEach((p) => { p.boost = 'XLHO2'; });
d = war.getDemands(room);
assert.ok(d.some((r) => r.memory.warRole === 'claimer'), 'A+H fully boosted in W38S3 -> claimer now');
assert.strictEqual(W().plan.entry, Game.time + T.claimerSpawn + T.claimerToStaging, 'entry waits for the claimer to arrive');
mk('C', 'claimer', 'W37S5', 20, 30, 1, { spawning: true });
d = war.getDemands(room);
assert.ok(!d.some((r) => r.memory.warRole === 'claimer'), 'claimer spawning -> no duplicate');
reset();
mk('A', 'attacker', 'W37S5', 20, 20, 1490, { unboosted: true });
mk('H', 'healer', 'W37S5', 20, 20, 1490, { unboosted: true });
for (let i = 0; i < 300; i++) { Game.time++; d = war.getDemands(room); assert.ok(!d.some((r) => r.memory.warRole === 'claimer'), 'never a claimer while squad at home/unboosted'); }
const arriveTtl = 600 - T.claimerToStaging;
assert.ok(arriveTtl >= T.entryTtl, 'planned TTL at W38S3 ' + arriveTtl + ' >= 400');
console.log('OK arrive ttl', arriveTtl);

console.log('--- relief scheduled while assault; no duplicate while one is at home ---');
reset();
W().phase = 'assault'; W().squad = { a: 'A', h: 'H', c: 'C' };
mk('A', 'attacker', 'W38S2', 29, 22, 1100);
mk('H', 'healer', 'W38S2', 28, 22, 1100);
mk('C', 'claimer', 'W38S2', 23, 20, 450);
d = war.getDemands(room);
const lead = T.claimerSpawn + T.claimerToStaging + T.toController + T.margin;
assert.strictEqual(W().plan.reliefSpawn, Game.time + 450 - lead);
assert.ok(!d.some((r) => r.memory.warRole === 'claimer'));
Game.time = W().plan.reliefSpawn;
Game.creeps.C.ticksToLive = 450 - (Game.time - 1000);
d = war.getDemands(room);
assert.ok(d.some((r) => r.memory.warRole === 'claimer'), 'relief requested on schedule');
mk('C2', 'claimer', 'W37S5', 20, 30, 590);
d = war.getDemands(room);
assert.ok(!d.some((r) => r.memory.warRole === 'claimer'), 'relief at home -> no second request');
const reliefArrive = W().plan.at - 0;
assert.ok(lead - T.margin < 450, 'relief reaches controller before predecessor dies');
console.log('OK');

console.log('--- paused: no demands, creeps in W38S2 go to W38S3, no boosting ---');
reset();
Memory.ags131War.enabled = false; Memory.ags131War.pausedAt = 999;
const pa = mk('A', 'attacker', 'W38S2', 15, 37, 1100);
const pc = mk('C', 'claimer', 'W37S5', 20, 30, 590, { unboosted: true });
pc.memory.boostDone = false;
assert.deepStrictEqual(war.getDemands(room), []);
step();
assert.ok(moves.some((m) => m.name === 'A' && m.to.roomName === 'W38S3'), 'paused attacker leaves W38S2 to W38S3');
assert.ok(!moves.some((m) => m.name === 'C' && m.to.roomName !== 'W37S5'), 'paused unboosted claimer stays home');
assert.ok(pc.memory.boostSince == null, 'no boosting while paused');
console.log('OK');

console.log('--- unpause from assault forces regroup ---');
reset();
Memory.ags131War.phase = 'assault'; Memory.ags131War.squad = { a: 'A' }; Memory.ags131War.pausedAt = 999;
war.tick();
assert.strictEqual(W().phase, 'staging');
console.log('OK');

console.log('--- safe mode retreat / resume ---');
reset();
W().phase = 'assault'; W().squad = { a: 'A', h: 'H', c: 'C' };
Game.rooms.W38S2.controller.safeMode = 5000;
war.tick();
assert.strictEqual(W().phase, 'safemode');
reset();
W().phase = 'safemode'; W().safeModeEnd = 1400; Game.time = 901;
Game.rooms.W38S2 = undefined;
war.tick();
assert.strictEqual(W().phase, 'staging');
console.log('OK');

console.log('--- lootHauler cut + bucket gate ---');
reset();
Memory.cpuRoll = { avg: 160 };
assert.strictEqual(war.lootHaulerCap(14), 10);
Memory.cpuRoll = { avg: 100 };
assert.strictEqual(war.lootHaulerCap(14), 14);
Game.cpu.bucket = 4000;
assert.deepStrictEqual(war.getDemands(room), []);
console.log('OK');


console.log('--- healer TTL 495 -> no entry, replacement healer queued once ---');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const hOld = mk('H', 'healer', 'W38S3', 20, 1, 495);
mk('C', 'claimer', 'W38S3', 21, 1, 450);
mk('C0', 'claimer', 'W38S2', 23, 20, 300);
war.tick();
assert.strictEqual(W().phase, 'staging');
assert.strictEqual(W().entryWait, 'healerTtl', 'healer 495 < 500 blocks entry');
let dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 1, 'replacement healer queued');
mk('H2', 'healer', 'W37S5', 17, 33, 1500, { spawning: true, unboosted: true });
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 0, 'no duplicate while replacement spawning');
Game.creeps.H2.spawning = false; Game.creeps.H2.ticksToLive = 1490;
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 0, 'no duplicate once replacement alive');
hOld.ticksToLive = 600;
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
mk('H', 'healer', 'W37S5', 20, 20, 560);
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 1, 'healer would arrive with TTL < 500 -> replacement queued before entry');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 1, 'dead healer -> replacement');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const hx = mk('H', 'healer', 'W38S3', 20, 1, 450);
mk('H2', 'healer', 'W38S4', 20, 20, 1400);
step();
assert.ok(hx.memory.retired, 'old healer below 500 retires once a replacement exists');
console.log('OK');

console.log('--- retired claimers are not entry/relief claimers ---');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
mk('H', 'healer', 'W38S3', 20, 1, 1300);
const cr = mk('C', 'claimer', 'W38S3', 21, 1, 590);
cr.memory.retired = true;
war.tick();
assert.strictEqual(W().entryWait, 'claimer');
assert.ok(war.getDemands(room).some((r) => r.memory.warRole === 'claimer'), 'retired claimer does not block a fresh one');
console.log('OK');

console.log('--- W37S5 labs stay in boost mode until objectivesDown or disabled ---');
reset();
const home5 = { name: 'W37S5' };
for (const ph of ['staging', 'assault', 'safemode']) { W().phase = ph; assert.strictEqual(war.labActive(home5), true, ph); }
assert.ok(war.labCompounds().length === 3);
assert.strictEqual(war.labActive({ name: 'W33S7' }), false);
W().phase = 'won';
assert.strictEqual(war.labActive(home5), false, 'won -> reactions resume');
assert.deepStrictEqual(war.labCompounds(), []);
W().phase = 'staging'; W().enabled = false;
assert.strictEqual(war.labActive(home5), false, 'disabled by us -> reactions resume');
console.log('OK');

console.log('--- controllerHit event when upgradeBlocked first > 0 ---');
reset();
W().phase = 'assault'; W().squad = { a: 'A', h: 'H', c: 'C' };
mk('A', 'attacker', 'W38S2', 25, 21, 1100);
mk('H', 'healer', 'W38S2', 24, 20, 1100);
mk('C', 'claimer', 'W38S2', 23, 20, 400);
step();
assert.strictEqual(ev('controllerHit').length, 0);
Game.rooms.W38S2.controller.upgradeBlocked = 1000;
step();
assert.strictEqual(ev('controllerHit').length, 1);
assert.strictEqual(ev('controllerHit')[0].d.tick, Game.time);
assert.strictEqual(W().firstHit, Game.time);
step();
assert.strictEqual(ev('controllerHit').length, 1, 'logged once per lock');
Game.rooms.W38S2.controller.upgradeBlocked = 0; step();
Game.rooms.W38S2.controller.upgradeBlocked = 1000; step();
assert.strictEqual(ev('controllerHit').length, 2, 're-hit after expiry logged again');
console.log('OK');


console.log('--- stale assault without entry signal -> back to staging, nobody crosses ---');
reset();
W().phase = 'assault';
const sa = mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const sh = mk('H', 'healer', 'W38S3', 20, 1, 1300);
step();
assert.strictEqual(W().phase, 'staging');
assert.strictEqual(ev('retreat').slice(-1)[0].d.reason, 'noSquad');
assert.ok(!sa.acts.some((x) => x[0] === 'move') && !sh.acts.some((x) => x[0] === 'move'));
console.log('OK');


console.log('--- Memory.ags131War.recycle list retires claimers and they are not counted ---');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
mk('H', 'healer', 'W38S3', 20, 1, 1300);
const rc = mk('C', 'claimer', 'W38S3', 21, 1, 590);
W().recycle = ['C'];
step();
assert.ok(rc.memory.retired, 'listed claimer marked retired');
assert.strictEqual(war.liveWar('claimer').length, 0);
assert.strictEqual(W().entryWait, 'claimer');
assert.ok(ev('recycle').length === 1);
assert.ok(!W().recycle, 'handled entry removed from the list');
console.log('OK');

console.log('--- recycle-by-name regression: a new creep reusing a recycled name is NOT recycled ---');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
mk('H', 'healer', 'W38S3', 20, 1, 1300);
W().recycle = ['GoneC', { id: 'oldId', name: 'C' }];
step();
assert.ok(!W().recycle, 'stale names/ids with no creep are dropped');
const fresh = mk('C', 'claimer', 'W37S5', 20, 30, 590);
fresh.id = 'newId';
for (let i = 0; i < 90; i++) step();
assert.ok(!fresh.memory.retired, 'fresh claimer with a reused name survives 90 ticks');
assert.strictEqual(ev('recycle').length, 0);
W().recycle = [{ id: 'newId', name: 'C' }];
Game.getObjectById = (id) => Object.values(Game.creeps).find((c) => c.id === id) || null;
step();
assert.ok(fresh.memory.retired, 'id entry retires exactly that creep');
assert.ok(!W().recycle);
delete Game.getObjectById;
console.log('OK');

console.log('--- exit tiles not blocked: waiting claimers stay >=3 tiles from the edge, off (18..21,1) ---');
reset();
mk('A', 'attacker', 'W38S4', 20, 20, 1300);
mk('H', 'healer', 'W38S4', 21, 20, 1300);
const wc1 = mk('C', 'claimer', 'W38S4', 22, 20, 590);
const wc2 = mk('C2', 'claimer', 'W38S4', 23, 20, 590);
for (let i = 0; i < 10; i++) step();
const cm = moves.filter((m) => m.name === 'C' || m.name === 'C2');
assert.ok(cm.length > 0);
assert.ok(cm.every((m) => m.to.roomName === 'W38S3' && m.to.y >= 3), 'claimer wait targets are >=3 tiles from the edge');
assert.ok(cm.every((m) => !(m.to.y <= 1 && m.to.x >= 18 && m.to.x <= 21)), 'never the exit lane');
const g = war.gatherPos('claimer');
assert.ok(Math.max(Math.abs(g.x - 19), Math.abs(g.y - 1)) <= 3 && Math.max(Math.abs(g.x - 20), Math.abs(g.y - 1)) <= 3, 'wait tile within 3 of A and H gathers (entry check)');
reset();
const ea = mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const eh = mk('H', 'healer', 'W38S3', 20, 1, 1300);
const ec = mk('C', 'claimer', 'W38S3', g.x, g.y, 590);
W().plan = null;
step();
assert.strictEqual(W().phase, 'assault', 'entry signal with claimer at its wait tile');
step();
assert.ok(ea.acts.some((x) => x[0] === 'move') && eh.acts.some((x) => x[0] === 'move'), 'A+H step onto the exit');
assert.ok(!moves.filter((m) => m.name === 'C' && m.t === Game.time).some((m) => m.to.roomName === 'W38S2'), 'claimer still waits while A+H cross');
place(ea, 'W38S2', 19, 49); place(eh, 'W38S2', 20, 49);
step();
assert.ok(moves.filter((m) => m.name === 'C' && m.t === Game.time).some((m) => m.to.roomName === 'W38S2'), 'claimer heads for the exit the tick after A+H crossed');
for (let i = 0; i < 4; i++) { step(); assert.strictEqual(W().phase, 'assault', 'claimer follow grace keeps the squad in'); }
place(ec, 'W38S2', 20, 48);
step();
assert.strictEqual(W().phase, 'assault');
console.log('OK');

console.log('--- lab-sufficiency gate: no attacker/healer/claimer spawn until the labs hold full boosts + energy ---');
reset();
global.FIND_MY_STRUCTURES = 'myStructures';
global.STRUCTURE_LAB = 'lab';
const lab = (id, store) => ({ id, structureType: 'lab', store });
const labs = [lab('l1', { XGHO2: 239, energy: 2000 }), lab('l2', { XUH2O: 510, energy: 2000 }), lab('l3', { XLHO2: 449, energy: 2000 })];
const homeRoom = { name: 'W37S5', find: (t) => (t === 'myStructures' ? labs : []) };
let dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'attacker'), 'XGHO2 239 < 240 -> no attacker');
assert.ok(!dd.some((r) => r.memory.warRole === 'healer'), 'no healer');
labs[0].store.XGHO2 = 240;
dd = war.getDemands(homeRoom);
assert.ok(dd.some((r) => r.memory.warRole === 'attacker'), 'XUH2O 510 + XGHO2 240 -> attacker');
assert.ok(!dd.some((r) => r.memory.warRole === 'healer'), 'XGHO2 240 < 300 -> still no healer');
labs[0].store.XGHO2 = 300;
dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'healer'), 'XLHO2 449 < 450 -> no healer');
labs[2].store.XLHO2 = 450;
dd = war.getDemands(homeRoom);
assert.ok(dd.some((r) => r.memory.warRole === 'healer'), 'XGHO2 300 + XLHO2 450 -> healer');
labs[1].store.energy = 339;
dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'attacker'), 'lab energy 339 < 17*20 -> no attacker');
assert.strictEqual(W().labGate.attacker, false);
labs[1].store.energy = 2000;
mk('A', 'attacker', 'W38S3', 19, 1, 1300);
mk('H', 'healer', 'W38S3', 20, 1, 1300);
labs[0].store.XGHO2 = 299;
dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'claimer'), 'claimer also gated on XGHO2 300');
labs[0].store.XGHO2 = 300;
dd = war.getDemands(homeRoom);
assert.ok(dd.some((r) => r.memory.warRole === 'claimer'));
console.log('OK');

console.log('--- healer retire only for a fully boosted replacement ---');
reset();
const oldH = mk('H', 'healer', 'W38S3', 20, 1, 499);
const newH = mk('H2', 'healer', 'W37S5', 20, 30, 1400, { unboosted: true });
newH.memory.boostDone = false;
step();
assert.ok(!oldH.memory.retired, 'unboosted replacement -> keep the boosted healer');
newH.body.forEach((p) => { if (p.type === 'heal') p.boost = 'XLHO2'; if (p.type === 'tough') p.boost = 'XGHO2'; });
step();
assert.ok(oldH.memory.retired, 'boosted replacement -> old healer retires');
console.log('OK');

console.log('--- cost cap: no controllerHit by costCapTick -> pause spawns, retreat home, log spend ---');
reset();
W().costCapTick = 1005;
const ca = mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const ch = mk('H', 'healer', 'W38S3', 20, 1, 1300);
mk('C', 'claimer', 'W38S3', 22, 4, 590);
for (let i = 0; i < 3; i++) step();
assert.ok(!W().costCapped);
assert.ok(W().spend.energy > 0 && W().spend.boosts.XGHO2 === (8 + 10 + 10) * 30, 'spend tracks body energy and boost minerals');
for (let i = 0; i < 5; i++) step();
assert.ok(W().costCapped, 'capped at costCapTick');
assert.strictEqual(W().enabled, true, 'enabled stays');
assert.strictEqual(ev('costCap').length, 1);
assert.ok(ev('costCap')[0].d.spend.boosts.XUH2O === 17 * 30);
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), [], 'no spawns after cap');
assert.strictEqual(war.labActive({ name: 'W37S5' }), false, 'labs released after cap');
moves.length = 0;
step();
assert.ok(moves.filter((m) => m.name === 'A').every((m) => m.to.roomName === 'W37S5'), 'units retreat home');
assert.ok(!ca.acts.some((x) => x[0] === 'move' && x[2] === Game.time));
reset();
W().costCapTick = 1002; W().firstHit = 1001;
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
for (let i = 0; i < 5; i++) step();
assert.ok(!W().costCapped, 'controllerHit before cap -> no cap');
console.log('OK');

console.log('ALL WAR SCENARIO TESTS PASSED');
