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

global.Game = { time: 3000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] }, market: {} };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
const market = require('market');

console.log('--- market: own X budget counts spend booked to the shared ledger earlier today ---');
{
  const cfg = market.settings();
  const day = Math.floor(Date.now() / 86400000);
  Memory.market = { ledger: { day, sold: {}, bought: {}, soldCredits: 0, buyCredits: 391146, energyBuyCredits: 0, energyBuyByRoom: {}, deals: 0, buyBy: { X: 364924, Z: 26222 }, buyOwn: { X: 1044070 } }, orders: {} };
  const led = market.ledger();
  assert.strictEqual(market.ownSpent(led, 'X'), 1408994);
  assert.strictEqual(market.ownSpent(led, 'Z'), 26222);
  assert.strictEqual(market.ownSpent({}, 'X'), 0);
  assert.strictEqual(market.ownBuyLeft(cfg, led, 'X'), 1600000 - 1408994);
  const mk = { credits: 90000000, createOrder: () => OK };
  assert.ok(market.postOrder(cfg, mk, 'buy', 'X', 'W32S4', 379.805, 131).result === OK);
  assert.strictEqual(led.buyOwn.X, 1044070 + Math.round(379.805 * 131 * 1.05));
  assert.strictEqual(led.buyBy.X, 364924);
  assert.strictEqual(led.buyCredits, 391146);
  Memory.market.orders = {};
  led.buyOwn.X = 1600000 - 364924 - 52000;
  assert.strictEqual(market.postOrder(cfg, mk, 'buy', 'X', 'W33S3', 379.805, 131), null, 'shared-ledger X spend counts toward own cap');
  led.buyBy.X = 0;
  assert.ok(market.postOrder(cfg, mk, 'buy', 'X', 'W33S3', 379.805, 131).result === OK, 'same order fits without the earlier spend');
  console.log('OK');
}

console.log('--- market: shared-ledger day then own cap mid-day ---');
{
  const cfg = market.settings();
  const day = Math.floor(Date.now() / 86400000);
  Memory.market = { ledger: { day, sold: {}, bought: {}, soldCredits: 0, buyCredits: 0, energyBuyCredits: 0, energyBuyByRoom: {}, deals: 0 }, orders: {} };
  const led = market.ledger();
  const mk = { credits: 90000000, createOrder: () => OK };
  const saved = cfg.buyBudgetBy;
  cfg.buyBudgetBy = {};
  const shared = cfg.dailyBuyCredits;
  cfg.dailyBuyCredits = 5000000;
  assert.ok(market.postOrder(cfg, mk, 'buy', 'X', 'W32S4', 373.306, 133).result === OK);
  const pre = Math.round(373.306 * 133 * 1.05);
  assert.strictEqual(led.buyBy.X, pre);
  cfg.buyBudgetBy = saved;
  cfg.dailyBuyCredits = shared;
  Memory.market.orders = {};
  assert.strictEqual(market.ownBuyLeft(cfg, led, 'X'), 1600000 - pre);
  assert.ok(market.postOrder(cfg, mk, 'buy', 'X', 'W32S4', 379.805, 131).result === OK);
  assert.strictEqual(market.ownSpent(led, 'X'), pre + Math.round(379.805 * 131 * 1.05));
  console.log('OK');
}
console.log('ALL OK');
