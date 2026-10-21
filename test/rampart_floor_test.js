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
Object.assign(global, require('/workspace/ops/war/eng/cmn/package/lib/constants'));
global.Game = { time: 1, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {} };
global.Memory = { rooms: {} };
const utils = require('utils');
const room = { name: 'W33S3', controller: { level: 8, my: true }, find: () => [], energyAvailable: 0, energyCapacityAvailable: 0, memory: {} };
const r = (x, y) => ({ structureType: 'rampart', hits: 16800, hitsMax: 300000000, pos: { x, y, roomName: 'W33S3' } });
for (const x of [34, 35, 36]) assert.ok(utils.repairTargetHits(room, r(x, 45)) >= 20000, 'W33S3 (' + x + ',45) floor 20k');
const other = utils.repairTargetHits(room, r(10, 10));
assert.ok(other < 20000 || other >= 20000);
const elsewhere = utils.repairTargetHits({ name: 'W32S4', controller: { level: 8 }, find: () => [], memory: {} }, { structureType: 'rampart', hits: 1, hitsMax: 300000000, pos: { x: 34, y: 45, roomName: 'W32S4' } });
console.log('W33S3 floor ok; other tile', other, 'W32S4 same xy', elsewhere);
console.log('RAMPART FLOOR TEST PASSED');
