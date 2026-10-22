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

global.Game = { time: 100, cpu: { bucket: 10000, getUsed: () => 0 }, creeps: {}, rooms: {}, spawns: {}, structures: {}, constructionSites: {}, getObjectById: () => null, map: { getRoomLinearDistance: () => 2, findRoute: () => [] } };
global.Memory = { rooms: {}, stats: [], creeps: {} };
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };

const config = require('config');
const remote = require('remote');

console.log('--- config: W38S5 gate 6000/9000 ---');
assert.deepStrictEqual(config.remote.bucketGate, { W38S5: { below: 6000, above: 9000 } });
console.log('OK');

console.log('--- hysteresis: off >=6000, on <6000, stays on until >9000 ---');
{
  const seq = [[9500, false], [6000, false], [5999, true], [7000, true], [9000, true], [9001, false], [8000, false], [5000, true]];
  for (const [b, want] of seq) { Game.time++; Game.cpu.bucket = b; assert.strictEqual(remote.bucketGated('W38S5'), want, 'bucket ' + b); }
  assert.strictEqual(Memory.bucketGate.W38S5.on, true);
  assert.strictEqual(Memory.bucketGate.W38S5.bucket, 5000);
  assert.strictEqual(Memory.bucketGate.W38S5.offBucket, 9001);
  Game.cpu.bucket = 100;
  assert.strictEqual(remote.bucketGated('W38S4'), false, 'other remotes never gated');
  assert.ok(!Memory.bucketGate.W38S4);
  console.log('OK');
}

console.log('--- getDemands drops gated remoteRoom demands (reserver/miner/hauler) only ---');
{
  const src = fs.readFileSync(path.join(src_dir(), 'remote.js'), 'utf8');
  assert.ok(/return demands\.filter\(\(d\) => !\(d\.memory && d\.memory\.remoteRoom && bucketGated\(d\.memory\.remoteRoom\)\)\);\n\}/.test(src));
  const keep = [{ role: 'remoteMiner', memory: { remoteRoom: 'W38S4' } }, { role: 'reserver', memory: { remoteRoom: 'W38S5' } }, { role: 'remoteHauler', memory: { remoteRoom: 'W38S5' } }, { role: 'remoteMiner', memory: { remoteRoom: 'W38S5' } }];
  Memory.bucketGate.W38S5.on = true; Game.cpu.bucket = 7000;
  const out = keep.filter((d) => !(d.memory && d.memory.remoteRoom && remote.bucketGated(d.memory.remoteRoom)));
  assert.deepStrictEqual(out.map((d) => d.memory.remoteRoom), ['W38S4']);
  Game.cpu.bucket = 9500;
  const out2 = keep.filter((d) => !(d.memory && d.memory.remoteRoom && remote.bucketGated(d.memory.remoteRoom)));
  assert.strictEqual(out2.length, 4);
  console.log('OK');
}
function src_dir() { return src; }
console.log('ALL OK');
