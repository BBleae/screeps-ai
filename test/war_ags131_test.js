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
  Memory.ags131War = { enabled: true, phase: 'staging', events: [], round: 3 };
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
assert.strictEqual(W().entryWait, 'claimerTtl', 'claimer TTL < 400 blocks entry');
c.ticksToLive = 450;
a.acts.length = 0; h.acts.length = 0; c.acts.length = 0;
step();
assert.strictEqual(W().phase, 'assault', 'all three in W38S3 within 3 tiles -> entry signal');
const entered = ev('entered')[0];
assert.ok(entered && entered.d.c === 'C' && entered.d.cTtl >= 400 && Number.isFinite(entered.d.relief), 'entered records claimer ttl and relief spawn tick');
console.log('OK entry signal at', Game.time, entered.d);

console.log('--- attacker + healer cross on the same tick as the entry signal, claimer right after ---');
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

console.log('--- back-computed spawn timing: order H -> A -> C, all arrive near ONE target entry ---');
reset();
const T = war.timing();
const room = { name: 'W37S5' };
const L = { healer: 150 + T.boost + T.squadToStaging, attacker: 150 + T.boost + T.squadToStaging, claimer: T.claimerSpawn + T.boost + T.claimerToStaging };
const got = {};
let target0 = null;
const virt = {};
for (let i = 0; i < 400; i++) {
  Game.time++;
  for (const n of Object.keys(virt)) {
    const v = virt[n]; const cr = Game.creeps[n];
    if (Game.time >= v.arrive) {
      if (cr.spawning) { cr.spawning = false; const g = war.gatherPos(cr.memory.warRole); place(cr, 'W38S3', g.x, g.y); cr.ticksToLive = v.life - (Game.time - v.born); }
    } else {
      Game.spawns[n] = { spawning: { name: n, remainingTime: v.arrive - Game.time - (cr.memory.warRole === 'claimer' ? T.boost + T.claimerToStaging : T.boost + T.squadToStaging) } };
    }
    if (!cr.spawning) { delete Game.spawns[n]; cr.ticksToLive = v.life - (Game.time - v.born); }
  }
  const dd = war.getDemands(room);
  if (target0 == null) target0 = W().plan.target;
  if (Game.time <= target0) assert.strictEqual(W().plan.target, target0, 'target entry does not drift');
  for (const r of dd) {
    const role = r.memory.warRole;
    assert.ok(!got[role], 'one request per role');
    got[role] = Game.time;
    const n = role.toUpperCase().slice(0, 1);
    const cr = mk(n, role, 'W37S5', 20, 30, 1, { spawning: true });
    const spawnDur = role === 'claimer' ? T.claimerSpawn : 150;
    virt[n] = { arrive: Game.time + L[role], born: Game.time + spawnDur, life: role === 'claimer' ? 600 : 1500 };
    Game.spawns[n] = { spawning: { name: n, remainingTime: spawnDur } };
  }
  if (got.claimer && Game.time > virt.C.arrive) break;
}
assert.ok(got.healer < got.attacker && got.attacker < got.claimer, 'order H -> A -> C: ' + JSON.stringify(got));
for (const r of ['healer', 'attacker', 'claimer']) {
  const arr = got[r] + L[r];
  assert.ok(arr <= target0 && target0 - arr <= 2 * T.orderGap, r + ' arrives ' + arr + ' near target ' + target0);
}
console.log('OK spawn ticks', got, 'target', target0);

console.log('--- all three staged -> entry within 30 ticks (claimer leaves (22,4) for a tile <=1 from the pair) ---');
global.__simMove = true;
reset();
const sa3 = mk('A', 'attacker', 'W38S3', 19, 1, 1300);
const sh3 = mk('H', 'healer', 'W38S3', 20, 1, 1300);
const sc3 = mk('C', 'claimer', 'W38S3', 22, 4, 420);
const t0 = Game.time;
let entT = null;
const laneHits = [];
for (let i = 0; i < 30 && entT == null; i++) {
  step();
  if (sc3.pos.roomName === 'W38S3' && sc3.pos.y <= 1 && (sc3.pos.x === 19 || sc3.pos.x === 20)) laneHits.push(Game.time);
  if (W().phase === 'assault') entT = Game.time;
}
assert.ok(entT != null && entT - t0 <= 30, 'entry within 30 ticks, took ' + (entT - t0));
assert.ok(!laneHits.length, 'claimer never stood on the pair exit lane');
assert.ok(Math.max(Math.abs(sc3.pos.x - 20), Math.abs(sc3.pos.y - 1)) <= 1, 'claimer adjacent to the healer at entry');
assert.ok(sa3.acts.some((x) => x[0] === 'move' && x[2] === entT) && sh3.acts.some((x) => x[0] === 'move' && x[2] === entT), 'A+H cross the same tick');
global.__simMove = false;
console.log('OK entry after', entT - t0, 'ticks; claimer at', sc3.pos.x, sc3.pos.y);

console.log('--- round-3 gates: attacker 549/550, healer 449/450, claimer 399/400 ---');
function gateCase(at, ht, ct) {
  reset();
  mk('A', 'attacker', 'W38S3', 19, 1, at);
  mk('H', 'healer', 'W38S3', 20, 1, ht);
  mk('C', 'claimer', 'W38S3', 20, 2, ct);
  W().plan = { reliefSpawn: 2000 };
  return war.entryCheck(W());
}
assert.strictEqual(gateCase(549, 1000, 500).why, 'attackerTtl');
assert.ok(gateCase(550, 1000, 500).ok, 'attacker 550 passes');
assert.strictEqual(gateCase(1000, 449, 500).why, 'healerTtl');
assert.ok(gateCase(1000, 450, 500).ok, 'healer 450 passes');
assert.strictEqual(gateCase(1000, 1000, 399).why, 'claimerTtl');
assert.ok(gateCase(1000, 1000, 400).ok, 'claimer 400 passes');
console.log('OK');

console.log('--- lab gate failure shifts the whole plan, nobody spawns early ---');
reset();
global.FIND_MY_STRUCTURES = 'myStructures';
global.STRUCTURE_LAB = 'lab';
const glabs = [{ id: 'g1', structureType: 'lab', store: { XGHO2: 3000, energy: 2000 } }, { id: 'g2', structureType: 'lab', store: { XUH2O: 510, energy: 2000 } }, { id: 'g3', structureType: 'lab', store: { XLHO2: 0, energy: 2000 } }];
const groom = { name: 'W37S5', find: (t) => (t === 'myStructures' ? glabs : []) };
let gd = war.getDemands(groom);
const tA = W().plan.target;
assert.strictEqual(gd.length, 0, 'XLHO2 missing -> no healer');
for (let i = 0; i < 10; i++) { Game.time++; gd = war.getDemands(groom); assert.strictEqual(gd.length, 0, 'no attacker or claimer jumps the queue'); }
assert.strictEqual(W().plan.target, tA + 10, 'target shifts with the blocked healer');
glabs[2].store.XLHO2 = 450;
Game.time++;
gd = war.getDemands(groom);
assert.deepStrictEqual(gd.map((r) => r.memory.warRole), ['healer']);
console.log('OK');

console.log('--- leftover healer too short-lived for the plan is recycled ---');
reset();
const oldH3 = mk('H0', 'healer', 'W37S5', 20, 30, 120);
war.getDemands({ name: 'W37S5' });
assert.ok(oldH3.memory.retired, 'TTL 120 healer cannot reach entry with 550 -> unfit, recycled');
assert.ok(ev('unfit').some((e) => e.d.name === 'H0'));
reset();
const keepH = mk('H0', 'healer', 'W37S5', 20, 30, 1400);
const kd = war.getDemands({ name: 'W37S5' });
assert.ok(!keepH.memory.retired && !kd.some((r) => r.memory.warRole === 'healer'), 'long-lived leftover healer is reused');
assert.ok(kd.some((r) => r.memory.warRole === 'attacker'), 'attacker next');
console.log('OK');

console.log('--- stuck detector: all staged, no entry for >150 ticks -> stuck once ---');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1300);
mk('H', 'healer', 'W38S3', 20, 1, 1300);
const stc = mk('C', 'claimer', 'W38S3', 20, 2, 590, { unboosted: true });
for (let i = 0; i < 151; i++) step();
assert.ok(!W().stuck, 'not yet at exactly 150 ticks');
step();
assert.ok(W().stuck && W().stuck.gate === 'claimerTtl' && W().stuck.need === 400, JSON.stringify(W().stuck));
assert.strictEqual(W().stuck.since, 1001);
for (let i = 0; i < 50; i++) step();
assert.strictEqual(ev('stuck').length, 1, 'once per episode');
delete Game.creeps.C;
step();
assert.ok(!W().stuckEp);
console.log('OK', W().stuck);

console.log('--- round restart + budget cap ---');
reset();
W().round = 2; W().costCapped = { at: 900 }; W().spend = { energy: 99999, boostEnergy: 0, boosts: { XGHO2: 9999 } };
step();
assert.strictEqual(W().round, 3);
assert.ok(!W().costCapped, 'restart clears costCapped');
assert.strictEqual(W().costCapTick, 74486500);
assert.strictEqual(W().spend.energy, 0);
assert.ok(ev('restart').length === 1);
W().spend.energy = 29000; W().spend.boostEnergy = 1000;
step();
assert.ok(!W().costCapped, '30000 exactly is not exceeded');
W().spend.boostEnergy = 1001;
step();
assert.strictEqual(W().costCapped.reason, 'energy');
assert.strictEqual(ev('costCap').slice(-1)[0].d.reason, 'energy');
reset();
W().spend = { energy: 0, boostEnergy: 0, boosts: { XGHO2: 2501 } };
const bA = mk('A', 'attacker', 'W38S3', 19, 1, 1300);
moves.length = 0;
step();
assert.strictEqual(W().costCapped.reason, 'XGHO2');
assert.deepStrictEqual(war.getDemands({ name: 'W37S5' }), []);
step();
assert.ok(moves.filter((m) => m.name === 'A').every((m) => m.to.roomName === 'W37S5'), 'go home');
console.log('OK');

console.log('--- relief scheduled while assault; no duplicate while one is at home ---');
reset();
W().phase = 'assault'; W().squad = { a: 'A', h: 'H', c: 'C' };
mk('A', 'attacker', 'W38S2', 29, 22, 1100);
mk('H', 'healer', 'W38S2', 28, 22, 1100);
mk('C', 'claimer', 'W38S2', 23, 20, 450);
let d = war.getDemands(room);
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


console.log('--- healer TTL 445 -> no entry, replacement healer queued once ---');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const hOld = mk('H', 'healer', 'W38S3', 20, 1, 445);
mk('C', 'claimer', 'W38S3', 21, 1, 450);
mk('C0', 'claimer', 'W38S2', 23, 20, 300);
war.tick();
assert.strictEqual(W().phase, 'staging');
assert.strictEqual(W().entryWait, 'healerTtl', 'healer 445 < 450 blocks entry');
let dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 1, 'replacement healer queued');
mk('H2', 'healer', 'W37S5', 17, 33, 1500, { spawning: true, unboosted: true });
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 0, 'no duplicate while replacement spawning');
Game.creeps.H2.spawning = false; Game.creeps.H2.ticksToLive = 1490;
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 0, 'no duplicate once replacement alive');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
mk('H', 'healer', 'W37S5', 20, 20, 700);
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 1, 'healer would arrive with TTL < 550 -> replacement queued before entry');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
dh = war.getDemands(room).filter((r) => r.memory.warRole === 'healer');
assert.strictEqual(dh.length, 1, 'dead healer -> replacement');
reset();
mk('A', 'attacker', 'W38S3', 19, 1, 1200);
const hx = mk('H', 'healer', 'W38S3', 20, 1, 440);
mk('H2', 'healer', 'W38S4', 20, 20, 1400);
step();
assert.ok(hx.memory.retired, 'old healer below 450 retires once a boosted replacement exists');
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
assert.strictEqual(W().phase, 'staging', 'claimer still at (22,4): not adjacent yet');
assert.strictEqual(W().entryWait, 'claimerDist');
const mv = moves.filter((m) => m.name === 'C' && m.t === Game.time).slice(-1)[0];
assert.ok(mv && mv.to.x === 20 && mv.to.y === 2, 'pair at gather -> claimer heads to (20,2), next to them and off their lane');
place(ec, 'W38S3', 20, 2);
step();
assert.strictEqual(W().phase, 'assault', 'entry the tick the claimer is adjacent');
assert.ok(ea.acts.some((x) => x[0] === 'move' && x[2] === Game.time) && eh.acts.some((x) => x[0] === 'move' && x[2] === Game.time), 'A+H step onto the exit the same tick');
assert.ok(!moves.filter((m) => m.name === 'C' && m.t === Game.time).some((m) => m.to.roomName === 'W38S2'), 'claimer still waits while A+H cross');
place(ea, 'W38S2', 19, 49); place(eh, 'W38S2', 20, 49);
step();
assert.ok(moves.filter((m) => m.name === 'C' && m.t === Game.time).some((m) => m.to.roomName === 'W38S2'), 'claimer heads for the exit the tick after A+H crossed');
for (let i = 0; i < 4; i++) { step(); assert.strictEqual(W().phase, 'assault', 'claimer follow grace keeps the squad in'); }
place(ec, 'W38S2', 20, 48);
step();
assert.strictEqual(W().phase, 'assault');
console.log('OK');

console.log('--- lab-sufficiency gate: per-role amounts + lab energy, cumulative for everyone still to spawn ---');
reset();
global.FIND_MY_STRUCTURES = 'myStructures';
global.STRUCTURE_LAB = 'lab';
const lab = (id, store) => ({ id, structureType: 'lab', store });
const labs = [lab('l1', { XGHO2: 539, energy: 2000 }), lab('l2', { XUH2O: 510, energy: 2000 }), lab('l3', { XLHO2: 0, energy: 2000 })];
const homeRoom = { name: 'W37S5', find: (t) => (t === 'myStructures' ? labs : []) };
mk('H', 'healer', 'W37S5', 20, 30, 1400);
let dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'attacker'), 'XGHO2 539 < 240+300 (attacker+claimer still to come) -> no attacker');
labs[0].store.XGHO2 = 540;
dd = war.getDemands(homeRoom);
assert.ok(dd.some((r) => r.memory.warRole === 'attacker'), 'XUH2O 510 + XGHO2 540 -> attacker');
labs[1].store.energy = 339;
dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'attacker'), 'lab energy 339 < 17*20 -> no attacker');
assert.strictEqual(W().labGate.attacker, false);
labs[1].store.XUH2O = 509; labs[1].store.energy = 2000;
dd = war.getDemands(homeRoom);
assert.ok(!dd.some((r) => r.memory.warRole === 'attacker'), 'XUH2O 509 -> no attacker');
reset();
const hlabs = [lab('l1', { XGHO2: 840, energy: 2000 }), lab('l2', { XUH2O: 510, energy: 2000 }), lab('l3', { XLHO2: 449, energy: 2000 })];
const hroom = { name: 'W37S5', find: (t) => (t === 'myStructures' ? hlabs : []) };
dd = war.getDemands(hroom);
assert.ok(!dd.length, 'XLHO2 449 < 450 -> no healer');
hlabs[2].store.XLHO2 = 450; hlabs[0].store.XGHO2 = 839;
dd = war.getDemands(hroom);
assert.ok(!dd.length, 'XGHO2 839 < 300+240+300 -> no healer (whole plan shifts)');
hlabs[0].store.XGHO2 = 840;
dd = war.getDemands(hroom);
assert.deepStrictEqual(dd.map((r) => r.memory.warRole), ['healer']);
reset();
const clabs = [lab('l1', { XGHO2: 299, energy: 2000 })];
const croom = { name: 'W37S5', find: (t) => (t === 'myStructures' ? clabs : []) };
mk('A', 'attacker', 'W38S3', 19, 1, 1300);
mk('H', 'healer', 'W38S3', 20, 1, 1300);
dd = war.getDemands(croom);
assert.ok(!dd.some((r) => r.memory.warRole === 'claimer'), 'claimer gated on XGHO2 300');
clabs[0].store.XGHO2 = 300;
dd = war.getDemands(croom);
assert.ok(dd.some((r) => r.memory.warRole === 'claimer'));
console.log('OK');

console.log('--- healer retire only for a fully boosted replacement ---');
reset();
const oldH = mk('H', 'healer', 'W38S3', 20, 1, 449);
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
