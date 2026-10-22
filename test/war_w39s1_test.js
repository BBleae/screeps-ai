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
  }
  return orig.call(this, request, parent, isMain, options);
};

global.Game = { time: 1000, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {} };
global.Memory = {};
global.FIND_STRUCTURES = 'structures';
global.FIND_HOSTILE_CREEPS = 'hostileCreeps';
global.FIND_HOSTILE_CONSTRUCTION_SITES = 'hostileSites';
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_SPAWN = 'spawn';

const war = require('war');

function pos(x, y) { return { x, y }; }
function struct(type, x, y, owner) { return { structureType: type, pos: pos(x, y), my: false, owner: owner ? { username: owner } : undefined }; }

function mockRoom(structs) {
  return {
    name: 'W39S1',
    find(kind) {
      if (kind === 'structures') return structs;
      return [];
    },
  };
}

let pass = 0;
function ok(name) { console.log('OK ' + name); pass++; }

(function forbiddenNeverDismantled() {
  war.state = war.state;
  global.Memory.ags131War = { enabled: true, lootWar: true };
  const enemy = 'sriptulous';
  const structs = [
    struct('storage', 14, 14, enemy),
    struct('terminal', 15, 15, enemy),
    struct('factory', 16, 16, enemy),
    struct('lab', 17, 17, enemy),
    struct('container', 8, 20, enemy),
    struct('link', 13, 14, enemy),
    struct('extension', 20, 13, enemy),
    struct('tower', 16, 12, enemy),
    struct('tower', 14, 4, enemy),
    struct('spawn', 17, 16, enemy),
  ];
  const cfg = war.cfg();
  cfg.target = 'W39S1';
  cfg.lootWar = true;
  cfg.clear = cfg.clear || {};
  cfg.clear.enemy = enemy;
  cfg.clear.types = ['extension', 'link', 'terminal', 'storage', 'container', 'tower', 'spawn', 'factory', 'lab'];
  cfg.clear.structOrder = ['extension', 'terminal', 'storage', 'container', 'link', 'tower', 'spawn'];
  cfg.clear.urgentSites = ['spawn', 'tower'];

  assert.strictEqual(war.lootWar(), true, 'lootWar flag on');
  const scan = war.clearScan(mockRoom(structs));
  const kinds = scan.structs.map((s) => s.structureType).sort();
  assert.deepStrictEqual(kinds, ['spawn', 'tower', 'tower'], 'only tower+spawn kept, resource structures excluded; got ' + kinds.join(','));
  for (const f of war.FORBIDDEN_LOOT) {
    assert.ok(scan.structs.every((s) => s.structureType !== f), f + ' must never be a dismantle target');
  }
  const creep = { pos: pos(29, 3) };
  for (let i = 0; i < 40; i++) {
    const t = war.clearTarget(creep, scan);
    if (!t || t.kind !== 'struct') break;
    assert.ok(war.FORBIDDEN_LOOT.indexOf(t.obj.structureType) < 0, 'clearTarget never returns forbidden: ' + t.obj.structureType);
    creep.pos = pos(t.obj.pos.x, t.obj.pos.y);
    scan.structs = scan.structs.filter((s) => s !== t.obj);
    if (!scan.structs.length) break;
  }
  ok('loot war: storage/terminal/factory/lab/container/link/extension are never dismantle targets, only tower+spawn');
})();

(function nonLootWarUnchanged() {
  global.Memory.ags131War = { enabled: true };
  const cfg = war.cfg();
  cfg.lootWar = false;
  cfg.clear = cfg.clear || {};
  cfg.clear.enemy = 'ags131';
  cfg.clear.types = ['extension', 'link', 'terminal', 'storage', 'container'];
  const structs = [struct('storage', 1, 1, 'ags131'), struct('container', 2, 2, 'ags131')];
  assert.strictEqual(war.lootWar(), false, 'lootWar off for ags131 war');
  const scan = war.clearScan(mockRoom(structs));
  assert.strictEqual(scan.structs.length, 2, 'non-loot war still dismantles storage/container as before');
  ok('non-loot (W38S2) war behaviour unchanged: storage/container still targeted');
})();

(function claimerPathSurvival() {
  const PATH = [[26,0],[27,1],[28,2],[29,3],[30,4],[31,5],[32,6],[33,7],[34,8],[35,9],[36,10],[36,11],[36,12],[36,13],[36,14],[36,15],[36,16],[36,17],[36,18],[36,19],[36,20],[36,21],[36,22],[36,23],[36,24],[36,25],[36,26],[35,27],[34,28],[33,29],[32,30]];
  const TOWERS = { S: [16, 12], N: [14, 4] };
  function cheby(a, b) { return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); }
  function towerDmg(d) { if (d <= 5) return 600; if (d >= 20) return 150; return Math.round(600 - (600 - 150) * (d - 5) / 15); }
  function tileDmg(x, y, alive) {
    let s = 0;
    for (const k of alive) s += towerDmg(cheby([x, y], TOWERS[k]));
    return s;
  }
  function sim(tough, boostedTough, healPerTick, alive) {
    const red = boostedTough ? 0.3 : 1.0;
    let toughEff = (tough * 100) / red;
    let other = 600;
    for (let i = 0; i < PATH.length; i++) {
      let inc = Math.max(0, tileDmg(PATH[i][0], PATH[i][1], alive) - healPerTick);
      if (toughEff > 0) { if (inc <= toughEff) { toughEff -= inc; inc = 0; } else { inc -= toughEff; toughEff = 0; } }
      other -= inc;
      if (other <= 0) return { dead: true, step: i };
    }
    return { dead: false, toughEff, other };
  }
  assert.strictEqual(tileDmg(26, 0, ['S', 'N']), 780, 'both towers at entry = 780/t');
  assert.strictEqual(tileDmg(32, 30, ['S', 'N']), 360, 'both towers at controller stand = 360/t');
  assert.strictEqual(tileDmg(36, 18, ['N']), 150, 'single far tower floor = 150/t');

  assert.ok(sim(0, false, 0, ['S', 'N']).dead, 'bare 1C2M (300hp) dies without heal');
  assert.strictEqual(sim(0, false, 0, ['S', 'N']).step, 0, 'bare claimer dies on the first tile');
  assert.ok(sim(4, true, 0, ['S', 'N']).dead, 'XGHO2 4-TOUGH claimer still dies without heal');
  assert.ok(!sim(4, true, 720, ['S', 'N']).dead, '4T1C5M + one XLHO2 15-HEAL healer (720/t) survives both towers');
  assert.ok(!sim(2, true, 720, ['S', 'N']).dead, 'even 2-TOUGH claimer survives with the escort healer');
  assert.ok(!sim(0, false, 720, ['N']).dead, 'once south tower dies, a bare claimer survives with the healer');

  const total = PATH.reduce((a, p) => a + tileDmg(p[0], p[1], ['S', 'N']), 0);
  assert.strictEqual(total, 12210, 'total both-tower path damage = 12210');
  ok('claimer survival: unescorted claimer dies tile 1; one XLHO2 healer makes the controller run survivable (both towers), model matches plan');
})();

(function budgetRetreat() {
  global.Memory.ags131War = { enabled: true, lootWar: true, round: 1, spend: { energy: 50000, boosts: { XGHO2: 100 } } };
  const cfg = war.cfg();
  cfg.lootWar = true;
  cfg.roundBudget = { energy: 40000, XGHO2: 3000 };
  const w = global.Memory.ags131War;
  war.costCap(w);
  assert.ok(w.costCapped, 'over energy budget -> costCapped set');
  assert.strictEqual(w.costCapped.reason, 'energy', 'retreat reason is energy budget');
  ok('budget retreat: exceeding 40k energy auto-caps the round (retreat)');
})();

(function stopSpawnOnSafeModeAndBudget() {
  const homeRoom = { name: 'W37S5', find() { return []; } };
  Game.cpu.bucket = 10000;
  global.Memory.ags131War = { enabled: true, lootWar: true, phase: 'safemode' };
  assert.deepStrictEqual(war.getDemands(homeRoom), [], 'phase=safemode -> no spawn demands (withdraw/hold)');
  global.Memory.ags131War = { enabled: true, lootWar: true, phase: 'assault', costCapped: { reason: 'energy' } };
  assert.deepStrictEqual(war.getDemands(homeRoom), [], 'over-budget costCapped -> no spawn demands (retreat)');
  ok('stop-spawn: enemy safe mode and budget cap both halt new war creeps (squad withdraws)');
})();

console.log('ALL W39S1 LOOT-WAR TESTS PASSED (' + pass + ')');
