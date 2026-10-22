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
Object.assign(global, require('/workspace/ops/war/eng/cmn/package/lib/constants'));
global.Game = { time: 100, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: {} };
global.Memory = { rooms: {}, stats: [] };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
const config = require('config');
const term = require('terminal');
const ind = require('industry');
const utils = require('utils');

const store = (o) => Object.assign({ getFreeCapacity: () => 200000 }, o);
const mkRoom = (name, level, term_, stor) => ({ name, controller: { my: true, level }, terminal: { my: true, cooldown: 0, store: store(term_), send: () => OK }, storage: { my: true, store: store(stor) }, find: () => [] });

console.log('--- W38S7 makes G with its existing labs: ZK first, then G, stop at 3000 ---');
{
  global.Game.rooms = { W38S7: mkRoom('W38S7', 8, {}, {}), W32S4: mkRoom('W32S4', 7, {}, {}) };
  utils.applyRcl8Auto();
  assert.deepStrictEqual(config.industry.chainTargetsByRoom.W38S7, ['G']);
  assert.ok(config.industry.labRooms.indexOf('W38S7') >= 0, 'W38S7 labs run at RCL8');
  assert.ok(!utils.lowRoomAllowed('W38S7', true) && config.sites.lowRooms.join() === 'W32S4,W33S3', 'no new lab sites in W38S7');
  assert.ok(config.market.buy.onlyRooms.Z.indexOf('W38S7') >= 0 && config.market.buy.rooms.indexOf('W38S7') >= 0, 'W38S7 buys Z');
  assert.strictEqual(config.market.buy.maxPrice.Z, 60);
  assert.strictEqual(ind.nextReactionFor('G', { K: 5322, UL: 5540 }, 500), null, 'no Z: noStep (live state)');
  const s1 = ind.nextReactionFor('G', { K: 5322, UL: 5540, Z: 2405 }, 500);
  assert.ok(s1 && s1.product === 'ZK', 'Z+K -> ZK first: ' + JSON.stringify(s1));
  const s2 = ind.nextReactionFor('G', { K: 3000, UL: 5540, Z: 0, ZK: 2400 }, 500);
  assert.ok(s2 && s2.product === 'G', 'UL+ZK -> G: ' + JSON.stringify(s2));
  assert.strictEqual(ind.wantedTarget({ G: 2999 }, { chainTargets: ['G'], boostGoal: 3000 }), 'G');
  assert.strictEqual(ind.wantedTarget({ G: 3000 }, { chainTargets: ['G'], boostGoal: 3000 }), null, 'stop at 3000 G');
  console.log('OK');
}

console.log('--- K from W37S5 and Z from W32S4 (after its RCL8) by terminal ---');
{
  const rule = (f, t, r) => config.terminalNetwork.forward.find((x) => x.from === f && x.to === t && x.resource === r);
  const k = rule('W37S5', 'W38S7', 'K');
  assert.ok(k && k.keep >= 20000);
  assert.deepStrictEqual(config.hauling.unstash.W37S5, { resource: 'K', target: 5000, terminalFree: 20000 }, 'W37S5 haulers stage K into the terminal');
  global.Game.rooms = { W37S5: mkRoom('W37S5', 7, { K: 5000, energy: 30000 }, { K: 68438 }), W38S7: mkRoom('W38S7', 8, { K: 2900, energy: 2589 }, {}) };
  let p = term.planForward(k, {});
  assert.ok(p && p.amount === 3000 && p.from.name === 'W37S5', 'W38S7 K 2900 < 5000 -> 3000 K: ' + JSON.stringify(p && p.amount));
  global.Game.rooms.W38S7.terminal.store.K = 5322;
  assert.strictEqual(term.planForward(k, {}), null, 'W38S7 K 5322: no send');
  global.Game.rooms.W38S7.terminal.store.K = 0;
  global.Game.rooms.W37S5.terminal.store.K = 5000; global.Game.rooms.W37S5.storage.store.K = 16000;
  p = term.planForward(k, {});
  assert.ok(p && p.amount === 1000, 'W37S5 keeps 20k K: ' + JSON.stringify(p && p.amount));
  const back = rule('W38S7', 'W37S5', 'K');
  global.Game.rooms.W37S5.storage.store.K = 60000;
  global.Game.rooms.W38S7.terminal.store.K = 9000;
  assert.strictEqual(term.planForward(back, {}), null, 'no K ping-pong back to W37S5');
  const z = rule('W32S4', 'W38S7', 'Z');
  global.Game.rooms = { W32S4: mkRoom('W32S4', 7, { Z: 2405, energy: 30000 }, {}), W38S7: mkRoom('W38S7', 8, { energy: 2589 }, {}) };
  assert.strictEqual(term.planForward(z, {}), null, 'W32S4 still RCL7 (makes G itself): keep its Z');
  global.Game.rooms.W32S4.controller.level = 8;
  p = term.planForward(z, {});
  assert.ok(p && p.amount === 2405, 'W32S4 at RCL8: its idle Z goes to W38S7: ' + JSON.stringify(p && p.amount));
  const g = rule('W38S7', 'W33S3', 'G');
  assert.ok(g && g.toBelow === 3000, 'G onward to W33S3 already live');
  console.log('OK');
}

console.log('--- W37S5 out of W33S7 sender list, starvingUntil 50k ---');
{
  assert.ok(config.terminalNetwork.senders.W33S7.to.indexOf('W37S5') < 0);
  assert.strictEqual(config.terminalNetwork.starvingUntil.W37S5, 50000);
  console.log('OK');
}
console.log('STRAT 1022B TESTS PASSED');
