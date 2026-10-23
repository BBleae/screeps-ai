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
global.Game = { time: 5000, cpu: { bucket: 10000, getUsed: () => 0, limit: 300 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: (id) => byId[id] || null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] }, market: {} };
global.Memory = { rooms: {}, stats: [] };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
const byId = {};
const config = require('config');
const ind = require('industry');
const store = (o) => Object.assign({ getFreeCapacity: () => 200000, getUsedCapacity: () => 0 }, o);
const lab = (id, x, st) => (byId[id] = { id, structureType: STRUCTURE_LAB, my: true, pos: new RoomPosition(x, 20, 'W33S3'), cooldown: 0, store: store(st || {}) });
const mk = (name, t, labs) => { const r = { name, controller: { my: true, level: 8 }, terminal: { my: true, cooldown: 0, store: store(t) }, storage: { my: true, store: store({}) }, find: (k, o) => (o && o.filter ? labs.filter(o.filter) : labs) }; Game.rooms[name] = r; return r; };
const plan = (r) => { Game.time++; return ind.labPlan(r); };
const ok = (c, m) => { assert.ok(c, m); console.log('  ok', m); };

console.log('--- OH stock goal 10k in W32S4/W33S3, after the GH chain, O kept at 3000 ---');
assert.deepStrictEqual(config.industry.labStockGoal.W32S4.OH, { to: 10000, keep: { O: 3000, H: 5000 } });
assert.deepStrictEqual(config.industry.labStockGoal.W33S3.OH, { to: 10000, keep: { O: 3000, H: 5000 } });
{
  Memory.rooms = { W33S3: { productHold: { OH: 1 } } };
  const r = mk('W33S3', { H: 30000, O: 3930, OH: 3820, G: 3490, X: 0 }, [lab('a', 10), lab('b', 11), lab('c', 12)]);
  let p = plan(r);
  ok(p && p.product === 'GH', 'G and H in stock: GH chain first (got ' + (p && p.product) + ')');
  r.terminal.store.G = 0;
  Memory.rooms.W33S3 = { productHold: { OH: 1 } };
  p = plan(r);
  ok(p && p.product === 'OH', 'no G: OH goal runs although old productHold was set (got ' + (p && p.product) + ')');
  r.terminal.store.O = 3400;
  Memory.rooms.W33S3 = {};
  p = plan(r);
  ok(!p || p.product !== 'OH', 'O 3400 < keep 3000 + 500: no fresh OH (got ' + (p && p.product) + ')');
  r.terminal.store.O = 20000; r.terminal.store.OH = 10000;
  Memory.rooms.W33S3 = {};
  p = plan(r);
  ok(!p || p.product !== 'OH', 'OH at 10k: stop (got ' + (p && p.product) + ')');
  ok(ind.heldProducts(r, {}).has('OH'), 'OH held at 10k');
}
{
  Memory.rooms = {};
  const r = mk('W33S3', { H: 30000, O: 20000, OH: 4000, G: 0 }, [lab('d', 10, { O: 1000 }), lab('e', 11, { H: 1000 }), lab('f', 12, { OH: 100 })]);
  let p = plan(r);
  ok(p && p.product === 'OH', 'loaded O/H labs keep making OH while below goal (got ' + (p && p.product) + ')');
  r.terminal.store.G = 3000;
  p = plan(r);
  ok(p && p.product === 'GH', 'G arrives: running OH yields to the GH chain (got ' + (p && p.product) + ')');
  r.terminal.store.G = 0; r.terminal.store.O = 2004;
  p = plan(r);
  ok(!p || p.product !== 'OH', 'running OH stops at the O keep floor (terminal 2004 + lab 1000) (got ' + (p && p.product) + ')');
}
{
  Memory.rooms = { W38S7: { productHold: { OH: 1 } } };
  const r = mk('W38S7', { H: 30000, O: 20000, OH: 6000 }, [lab('g', 10), lab('h', 11), lab('i', 12)]);
  ok(ind.heldProducts(r, Memory.rooms.W38S7).has('OH'), 'rooms without a goal keep the old productHold');
  ok(Object.keys(ind.stockGoals(r)).length === 0, 'no goal outside W32S4/W33S3');
}
console.log('ALL OK');
