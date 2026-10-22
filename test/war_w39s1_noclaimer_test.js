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
global.BOTTOM = 5;
const config = require('../src/config');
const warrior = require('../src/roles/warrior');
let pass = 0; const ok = (n) => { console.log('OK ' + n); pass++; };

function body(role) {
  if (role === 'attacker') return [].concat(Array(8).fill({ type: 'tough', boost: 'XGHO2' }), Array(17).fill({ type: 'attack', boost: 'XUH2O' }), Array(25).fill({ type: 'move' }));
  if (role === 'healer') return [].concat(Array(10).fill({ type: 'tough', boost: 'XGHO2' }), Array(15).fill({ type: 'heal', boost: 'XLHO2' }), Array(25).fill({ type: 'move' }));
  return [].concat(Array(10).fill({ type: 'work' }), Array(10).fill({ type: 'move' }));
}
const acts = [];
function mk(name, role, ttl, room, x, y, extra) {
  const hm = role === 'dismantler' ? 2000 : 5000;
  const c = {
    name, id: 'id_' + name, ticksToLive: ttl, hits: hm, hitsMax: hm, fatigue: 0, spawning: false, body: body(role),
    pos: new RoomPosition(x, y, room), room: { name: room },
    memory: Object.assign({ role: 'warrior', warRole: role, home: 'W37S5', targetRoom: 'W39S1', boosts: role === 'dismantler' ? [] : (role === 'attacker' ? ['XGHO2', 'XUH2O'] : ['XGHO2', 'XLHO2']), slotKey: 'war:' + role + ':0', boostDone: true }, extra || {}),
    heal(t) { acts.push([name, 'heal', t.name]); }, rangedHeal(t) { acts.push([name, 'rangedHeal', t.name]); },
    attack(t) { acts.push([name, 'attack', t.id]); }, dismantle(t) { acts.push([name, 'dismantle', t.id]); }, move(d) { acts.push([name, 'move', d]); },
  };
  c.pos.findClosestByRange = RoomPosition.prototype.findClosestByRange;
  return c;
}
function incidentCreeps() {
  Game.creeps = {
    '战猫.healer': mk('战猫.healer', 'healer', 767, 'W39S0', 26, 45),
    '战猫乙.healer': mk('战猫乙.healer', 'healer', 971, 'W39S0', 26, 44, { slotKey: 'war:healer:1' }),
    '战猫甲.attacker': mk('战猫甲.attacker', 'attacker', 848, 'W39S0', 25, 45),
    '战猫丁.dismantler': mk('战猫丁.dismantler', 'dismantler', 904, 'W39S0', 27, 45),
  };
}
const homeRoom = { name: 'W37S5', find: () => [], controller: { my: true } };
function fresh() {
  Game.time = 74490239;
  Memory.lootWarW39S1 = { enabled: true, home: 'W37S5', target: 'W39S1', phase: 'staging', round: 1, costCapTick: 74493500, spend: { energy: 16170, boostEnergy: 1660, boosts: { XGHO2: 1080 }, round: 1 }, events: [], entries: {}, plan: { target: 74490221 } };
  Game.rooms = { W37S5: homeRoom };
  acts.length = 0; moves.length = 0; retired.length = 0;
}

assert.strictEqual(config.war.noClaimer, true, 'no claimer in the war template');
assert.strictEqual(config.war.noRespawn, true, 'no respawn of war creeps');
ok('config: noClaimer + noRespawn, entry tile (27,2)');

(function incidentNoScrap() {
  fresh(); incidentCreeps();
  const d = war.getDemands(homeRoom);
  assert.deepStrictEqual(d, [], 'no new healer/attacker/claimer is requested (no whole-squad respawn)');
  for (const n of Object.keys(Game.creeps)) assert.ok(!Game.creeps[n].memory.retired, n + ' is never retired');
  assert.ok(!Memory.lootWarW39S1.events.some((e) => e.e === 'spawned'), 'nothing spawned');
  ok('incident 74490239 replay: boosted squad kept, nothing retired, no new squad spawned');
})();

(function unfitIsFlagOnly() {
  fresh(); incidentCreeps();
  config.war.noRespawn = false;
  Game.creeps['战猫.healer'].ticksToLive = 120;
  war.getDemands(homeRoom);
  const h = Game.creeps['战猫.healer'];
  assert.ok(!h.memory.retired, 'unfit healer not retired');
  assert.ok(h.memory.unfit, 'unfit healer flagged for DM');
  assert.ok(Memory.lootWarW39S1.events.some((e) => e.e === 'unfit' && e.d.kept === true), 'unfit event logged with kept:true');
  config.war.noRespawn = true;
  fresh(); incidentCreeps();
  Game.creeps['战猫.healer'].ticksToLive = 200;
  warrior.run(Game.creeps['战猫.healer']);
  assert.ok(!Game.creeps['战猫.healer'].memory.retired && retired.indexOf('战猫.healer') < 0, 'low-TTL healer in staging is flagged, not recycled');
  ok('unfit creeps are flagged (memory.unfit + event) and never auto-recycled');
})();

(function entryWithoutClaimer() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1;
  assert.strictEqual(w.phase, 'assault', 'entry opens without any claimer: ' + w.entryWait);
  assert.strictEqual(w.squad.c, null);
  assert.deepStrictEqual(w.squadBoosted.sort(), ['战猫.healer', '战猫乙.healer', '战猫甲.attacker'].sort());
  assert.ok(w.events.some((e) => e.e === 'attackStart'));
  ok('entry opens with attacker + 2 boosted healers, no claimer gate');
})();

(function entryDeadline() {
  fresh(); incidentCreeps();
  Game.creeps['战猫.healer'].ticksToLive = 249;
  war.tick();
  assert.strictEqual(Memory.lootWarW39S1.phase, 'staging', 'healer under 250 TTL blocks entry');
  assert.strictEqual(Memory.lootWarW39S1.entryWait, 'healers');
  ok('entry blocked once a healer is under the 250 TTL deadline (creeps stay parked)');
})();

(function crossing() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1;
  moves.length = 0;
  warrior.run(Game.creeps['战猫甲.attacker']);
  const am = moves.find((m) => m.name === '战猫甲.attacker');
  assert.ok(am && am.to.room === 'W39S1' && am.to.x === 27 && am.to.y === 2, 'attacker heads for the breach entry tile W39S1 (27,2), west of the breach, not TOP');
  warrior.run(Game.creeps['战猫丁.dismantler']);
  assert.ok(!moves.some((m) => m.name === '战猫丁.dismantler' && m.to.room === 'W39S1'), 'dismantler waits at gather until the attacker is inside');
  const a = Game.creeps['战猫甲.attacker'];
  a.pos = new RoomPosition(27, 2, 'W39S1'); a.room = { name: 'W39S1' };
  moves.length = 0;
  warrior.run(Game.creeps['战猫.healer']);
  const hm = moves.find((m) => m.name === '战猫.healer');
  assert.ok(hm && hm.to.room === 'W39S1', 'healer follows the attacker in');
  warrior.run(Game.creeps['战猫丁.dismantler']);
  const dm = moves.find((m) => m.name === '战猫丁.dismantler');
  assert.ok(dm && dm.to.room === 'W39S1' && dm.to.x === 27 && dm.to.y === 2 && dm.range === 1, 'dismantler follows once attacker is in');
  ok('crossing: attacker leads to (27,2) via BOTTOM exit, healers follow, dismantler after');
})();

function tRoom(opts) {
  const towers = opts.towers || [];
  const spawns = opts.spawns || [];
  return {
    name: 'W39S1', controller: { safeMode: opts.safeMode || 0, owner: { username: 'sriptulous' } },
    find(k) { if (k === 'hostileStructures') return towers; if (k === 'hostileSpawns') return spawns; if (k === 'hostileCreeps') return []; return []; },
    lookForAt(kind, x, y) { return (opts.tiles && opts.tiles[x + ',' + y]) || []; },
  };
}
const ST = (type, x, y) => ({ structureType: type, id: type + x + '_' + y, pos: new RoomPosition(x, y, 'W39S1'), owner: { username: 'sriptulous' } });

(function breachBeforeTowers() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1;
  const wall = ST('constructedWall', 28, 2);
  const room = tRoom({ towers: [ST('tower', 16, 12), ST('tower', 14, 4)], spawns: [ST('spawn', 17, 16)], tiles: { '28,2': [wall] } });
  Game.rooms.W39S1 = room;
  const a = Game.creeps['战猫甲.attacker'];
  a.pos = new RoomPosition(27, 2, 'W39S1'); a.pos.findClosestByRange = RoomPosition.prototype.findClosestByRange; a.room = { name: 'W39S1' };
  const h = Game.creeps['战猫.healer'];
  h.pos = new RoomPosition(26, 2, 'W39S1'); h.room = { name: 'W39S1' };
  acts.length = 0;
  warrior.run(a);
  assert.ok(acts.some((x) => x[0] === '战猫甲.attacker' && x[1] === 'attack' && x[2] === wall.id), 'attacker hits the breach wall first, no waiting for a controller lock');
  w.breachDone = Game.time;
  room.lookForAt = () => [];
  acts.length = 0; moves.length = 0;
  warrior.run(a);
  const mv = moves.find((m) => m.name === '战猫甲.attacker');
  assert.ok(mv && mv.to.x === 16 && mv.to.y === 12, 'after the breach, attacker goes for tower (16,12)');
  ok('attacker: breach wall (28,2) first, then tower (16,12); never waits for a lock');
})();

(function deathWithdraw() {
  fresh(); incidentCreeps();
  war.tick();
  delete Game.creeps['战猫乙.healer'];
  Game.time++;
  war.tick();
  const w = Memory.lootWarW39S1;
  assert.ok(w.withdraw && w.withdraw.why === 'death' && w.withdraw.dead[0] === '战猫乙.healer', 'death of a boosted creep -> withdraw');
  assert.deepStrictEqual(war.getDemands(homeRoom), [], 'no spawns after withdraw');
  moves.length = 0;
  warrior.run(Game.creeps['战猫甲.attacker']);
  const m = moves.find((x) => x.name === '战猫甲.attacker');
  assert.ok(m && m.to.room === 'W37S5', 'boosted creeps head home to W37S5 to unboost');
  Game.time++;
  war.tick();
  assert.strictEqual(w.phase, 'assault');
  assert.ok(!w.events.slice(-1)[0] || w.events.slice(-1)[0].e !== 'entered', 'no re-entry after withdraw');
  ok('any boosted death -> full withdrawal to W37S5 (unboost), spawning stops, no re-entry');
})();

(function safeModeWithdraw() {
  fresh(); incidentCreeps();
  Game.rooms.W39S1 = tRoom({ towers: [ST('tower', 16, 12)], spawns: [ST('spawn', 17, 16)], safeMode: 100 });
  war.tick();
  const w = Memory.lootWarW39S1;
  assert.ok(w.withdraw && w.withdraw.why === 'safemode', 'enemy safe mode -> withdraw');
  assert.notStrictEqual(w.phase, 'assault', 'never enters during enemy safe mode');
  assert.deepStrictEqual(war.getDemands(homeRoom), [], 'spawning stops');
  ok('enemy safe mode -> full withdrawal, spawning stops');
})();

(function lootSplitNoLock() {
  fresh(); incidentCreeps();
  Memory.cfg = { lootRoutes: { hardAvoid: ['W39S1', 'W36S6'] }, pvp: { dangerRooms: ['W39S1'] } };
  Memory.lootDrop = { _steps: { 'W39S1:W37S5': { ok: 0 } }, keep: 1 };
  delete Memory.lootWarLoot;
  const room = tRoom({ towers: [ST('tower', 16, 12)], spawns: [ST('spawn', 17, 16)] });
  Game.rooms.W39S1 = room;
  war.tick();
  const w = Memory.lootWarW39S1;
  w.phase = 'assault';
  room.find = (k) => [];
  Game.time++;
  war.tick();
  assert.ok(w.towersDownAt, 'towersDown stamped');
  assert.ok(Memory.lootWarLoot && Memory.lootWarLoot.target === 'W39S1' && Memory.lootWarLoot.haulers === 8 && Memory.lootWarLoot.keepOthers === 6 && Memory.lootWarLoot.unload === 'W37S5', '8/6 split written without a controller lock');
  assert.deepStrictEqual(Memory.cfg.lootRoutes.hardAvoid, ['W36S6'], 'W39S1 opened for haulers');
  assert.deepStrictEqual(Memory.cfg.pvp.dangerRooms, [], 'W39S1 out of dangerRooms');
  assert.strictEqual(Memory.cfgBy, 'war');
  assert.ok(!Memory.lootDrop._steps && Memory.lootDrop.keep === 1, 'failed route cache cleared');
  ok('towers + spawn dead -> Memory.lootWarLoot 8/6 written (no lock needed), Memory.cfg hardAvoid ["W36S6"], cfgBy war, _steps cleared');
})();

(function agedOutNoWithdraw() {
  fresh(); incidentCreeps();
  const keepTtl = config.war.squadHomeTtl; config.war.squadHomeTtl = 0;
  war.tick();
  Game.creeps['战猫.healer'].ticksToLive = 1;
  Game.time++; war.tick();
  delete Game.creeps['战猫.healer'];
  Game.time++; war.tick();
  const w = Memory.lootWarW39S1;
  assert.ok(!w.withdraw, 'old-age expiry is not a combat death');
  assert.ok(w.events.some((e) => e.e === 'agedOut'));
  delete Game.creeps['战猫乙.healer'];
  Game.time++; war.tick();
  assert.ok(w.withdraw && w.withdraw.why === 'death', 'a real death still withdraws');
  config.war.squadHomeTtl = keepTtl;
  ok('old-age expiry logs agedOut without withdrawal; a combat death still withdraws');
})();

(function splitUsesNearestHealer() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1;
  w.squad.h = '战猫乙.healer';
  const a = Game.creeps['战猫甲.attacker'];
  a.pos = new RoomPosition(25, 1, 'W39S1'); a.room = { name: 'W39S1' };
  const h = Game.creeps['战猫.healer'];
  h.pos = new RoomPosition(26, 1, 'W39S1'); h.room = { name: 'W39S1' };
  for (let i = 0; i < 5; i++) { Game.time++; war.tick(); }
  assert.strictEqual(w.phase, 'assault', 'no split regroup while the adjacent healer crossed with the attacker');
  assert.strictEqual(w.squad.h, '战猫.healer', 'escort healer re-pointed to the one actually next to the attacker');
  ok('cohesion follows the healer actually adjacent to the attacker (no split loop when the named healer lags)');
})();

(function healLowestEffective() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1;
  const room = tRoom({ towers: [Object.assign(ST('tower', 16, 12), { store: { energy: 500 } }), Object.assign(ST('tower', 14, 4), { store: { energy: 500 } })], spawns: [ST('spawn', 17, 16)], tiles: { '28,2': [ST('constructedWall', 28, 2)] } });
  Game.rooms.W39S1 = room;
  const place = (n, x, y, hits) => { const c = Game.creeps[n]; c.pos = new RoomPosition(x, y, 'W39S1'); c.room = { name: 'W39S1' }; if (hits != null) c.hits = hits; return c; };
  const a = place('战猫甲.attacker', 27, 1, 5000);
  const h1 = place('战猫.healer', 26, 2, 4748);
  const h2 = place('战猫乙.healer', 26, 1, 5000);
  delete Game.creeps['战猫丁.dismantler'];
  acts.length = 0;
  warrior.run(h2);
  warrior.run(h1);
  const hs = acts.filter((x) => x[1] === 'heal' || x[1] === 'rangedHeal');
  assert.ok(hs.find((x) => x[0] === '战猫乙.healer' && x[1] === 'heal' && x[2] === '战猫.healer'), '乙 heals the hurt healer 战猫, not its fixed partner: ' + JSON.stringify(hs));
  assert.ok(hs.find((x) => x[0] === '战猫.healer' && x[1] === 'heal' && x[2] === '战猫.healer'), '战猫 self-heals when it is the lowest');
  h1.hits = 5000; a.hits = 3000;
  acts.length = 0;
  warrior.run(h1); warrior.run(h2);
  const hs2 = acts.filter((x) => x[1] === 'heal' || x[1] === 'rangedHeal');
  assert.ok(hs2.length === 2 && hs2.every((x) => x[2] === '战猫甲.attacker'), 'both healers focus the attacker when it is lowest: ' + JSON.stringify(hs2));
  a.hits = 2400;
  Game.time++; war.tick();
  assert.strictEqual(w.phase, 'staging', 'a boosted creep under 50% -> pull out of W39S1');
  ok('healers heal the lowest effective-HP squad member (incl. self, predicted tower dmg), no fixed pairing; <50% -> pull out');
})();

(function ttlHome() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1;
  Game.creeps['战猫.healer'].ticksToLive = 151;
  Game.time++; war.tick();
  assert.ok(!w.withdraw, 'ttl 151 keeps fighting');
  Game.creeps['战猫.healer'].ticksToLive = 150;
  Game.time++; war.tick();
  assert.ok(w.withdraw && w.withdraw.why === 'ttl' && w.withdraw.low[0] === '战猫.healer', 'boosted squad ttl <= squadHomeTtl -> whole squad home');
  moves.length = 0;
  warrior.run(Game.creeps['战猫乙.healer']);
  assert.ok(moves.some((m) => m.name === '战猫乙.healer' && m.to.room === 'W37S5'), 'healthy creeps go home too');
  assert.deepStrictEqual(war.getDemands(homeRoom), []);
  ok('squad ttl <= 150 -> whole squad withdraws to W37S5 to unboost');
})();

(function splitAtTowersDown() {
  fresh(); incidentCreeps();
  Memory.cfg = { lootRoutes: { hardAvoid: ['W39S1', 'W36S6'] } };
  delete Memory.lootWarLoot;
  const spawn = ST('spawn', 17, 16);
  const room = tRoom({ towers: [ST('tower', 16, 12)], spawns: [spawn] });
  Game.rooms.W39S1 = room;
  war.tick();
  room.find = (k) => (k === 'hostileSpawns' ? [spawn] : []);
  Game.time++; war.tick();
  assert.ok(Memory.lootWarLoot && Memory.lootWarLoot.haulers === 8, 'haulers sent when both towers are down even with the spawn alive');
  assert.deepStrictEqual(Memory.cfg.lootRoutes.hardAvoid, ['W36S6']);
  ok('towers down (spawn still up) -> 8/6 split + W39S1 out of hardAvoid');
})();

(function killSupportFirst() {
  fresh(); incidentCreeps();
  war.tick();
  const w = Memory.lootWarW39S1; w.breachDone = Game.time;
  const tw = Object.assign(ST('tower', 14, 4), { store: { energy: 510 } });
  const hc = (name, x, y, parts, energy) => ({ name, id: name, pos: new RoomPosition(x, y, 'W39S1'), owner: { username: 'sriptulous' }, body: parts.map((t) => ({ type: t, hits: 100 })), store: { energy: energy || 0 } });
  const rep = hc('Builder1', 17, 5, ['work', 'carry', 'move'], 50);
  const fill = hc('Harvester1', 16, 6, ['carry', 'move'], 200);
  const far = hc('Miner1', 4, 21, ['work', 'move']);
  const corr = hc('Sneak', 29, 2, ['work', 'move']);
  const ally = Object.assign(hc('Ally1', 15, 5, ['work', 'move']), { owner: { username: 'Alepoldar' } });
  const spMiner = hc('Miner2', 16, 15, ['work', 'move']);
  const spawning = Object.assign(hc('Builder9', 14, 6, ['work', 'carry', 'move']), { spawning: true });
  config.allies = { names: ['Alepoldar'] };
  const room = tRoom({ towers: [tw], spawns: [ST('spawn', 17, 16)] });
  const creeps = [rep, fill, far, corr, ally, spMiner, spawning];
  room.find = (k) => (k === 'hostileStructures' ? [tw] : k === 'hostileSpawns' ? [ST('spawn', 17, 16)] : k === 'hostileCreeps' ? creeps : []);
  const a = Game.creeps['战猫甲.attacker'];
  a.pos = new RoomPosition(13, 5, 'W39S1'); a.pos.findClosestByRange = RoomPosition.prototype.findClosestByRange; a.room = { name: 'W39S1' };
  let t = warrior.lootAttackTarget(a, room);
  assert.strictEqual(t && t.name, 'Harvester1', 'nearest support creep (tower filler) first: ' + (t && t.name));
  creeps.splice(creeps.indexOf(fill), 1);
  t = warrior.lootAttackTarget(a, room);
  assert.strictEqual(t && t.name, 'Builder1', 'then the repairer near the tower');
  creeps.splice(creeps.indexOf(rep), 1);
  t = warrior.lootAttackTarget(a, room);
  assert.ok(t && t.structureType === 'tower', 'far miner, miner by the spawn, spawning creep, corridor creep and ally are ignored; back to the tower');
  ok('noClaimer: kill tower fillers/repairers (WORK near tower/spawn, energy CARRY near tower) before structures; ignore far/corridor/ally creeps');
})();

(function clearModeNoClaimers() {
  fresh(); incidentCreeps();
  const w = Memory.lootWarW39S1;
  w.mode = 'watch'; w.phase = 'won'; w.clear = { left: { creeps: 10, sites: 0, sitesLive: 0, extSites: 0, structs: 0, ext: 0 } };
  delete w.claimerUntilCreepsDead;
  assert.strictEqual(war.reliefOn(w), false, 'relief claimers off in noClaimer mode even if claimerUntilCreepsDead is unset');
  const d = war.getDemands(homeRoom);
  assert.ok(!d.some((r) => r.memory && r.memory.warRole === 'claimer'), 'no relief CLAIM creep requested in clear/watch mode');
  retired.length = 0;
  const cl = mk('战猫庚.claimer', 'claimer', 577, 'W38S5', 2, 17);
  cl.body = [{ type: 'claim' }, { type: 'move' }, { type: 'move' }];
  let attacked = false; cl.attackController = () => { attacked = true; };
  Game.creeps[cl.name] = cl;
  warrior.run(cl);
  assert.ok(cl.memory.retired && retired.indexOf(cl.name) >= 0 && !attacked, 'a live claimer is sent to recycle and never attackControllers');
  ok('clear/watch mode: no relief claimers, existing claimers recycle, never attackController');
})();

(function clearOrderBuildersFirst() {
  const hc = (name, x, y, parts) => ({ name, id: name, pos: new RoomPosition(x, y, 'W39S1'), owner: { username: 'sriptulous' }, body: parts.map((t) => ({ type: t })) });
  const up = hc('Upgrader1', 13, 6, ['work', 'carry', 'move']);
  const mi = hc('Miner1', 13, 7, ['work', 'move']);
  const bu = hc('Builder2', 30, 30, ['work', 'carry', 'move']);
  const ma = hc('Maintenance3', 31, 31, ['work', 'carry', 'move']);
  const a = { pos: new RoomPosition(13, 5, 'W39S1') };
  let t = war.clearTarget(a, { creeps: [up, mi, bu, ma], sites: [], liveSites: [], structs: [] });
  assert.strictEqual(t.obj.name, 'Builder2', 'Builder/Maintenance first even when farther');
  t = war.clearTarget(a, { creeps: [up, mi], sites: [], liveSites: [], structs: [] });
  assert.strictEqual(t.obj.name, 'Upgrader1', 'then the nearest economy creep');
  ok('clear order: Builder*/Maintenance* before other economy creeps');
})();

(function watcherSitesOnly() {
  fresh(); incidentCreeps();
  const w = Memory.lootWarW39S1; w.mode = 'watch'; w.phase = 'won';
  const site = { id: 's1', structureType: 'tower', progress: 10, pos: new RoomPosition(20, 20, 'W39S1'), owner: { username: 'sriptulous' } };
  const foe = { name: 'Upgrader1', pos: new RoomPosition(11, 10, 'W39S1'), owner: { username: 'sriptulous' }, body: [{ type: 'work' }] };
  Game.rooms.W39S1 = { name: 'W39S1', controller: {}, find: (k) => (k === 'hostileCreeps' ? [foe] : k === 'hostileSites' ? [site] : []), lookForAt: () => [] };
  const wt = mk('战猫戊.watcher', 'watcher', 1300, 'W39S1', 10, 10);
  wt.body = [{ type: 'attack' }, { type: 'move' }];
  let hit = false; wt.attack = () => { hit = true; };
  moves.length = 0;
  warrior.run(wt);
  assert.ok(!hit, 'watcher never attacks creeps in noClaimer mode');
  assert.ok(moves.some((m) => m.name === '战猫戊.watcher' && m.to.x === 20 && m.to.y === 20), 'watcher heads for the tower site to stomp it');
  ok('watcher only stomps spawn/tower sites in noClaimer mode');
})();

console.log('ALL W39S1 NO-CLAIMER TESTS PASSED (' + pass + ')');
