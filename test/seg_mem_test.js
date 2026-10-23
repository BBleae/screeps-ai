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

const SEG = path.join(src, 'seg_mem.js');
function load() {
  delete require.cache[SEG];
  delete global.__segMem;
  return require('seg_mem');
}

function makeWorld(initialMem) {
  return { mem: JSON.stringify(initialMem), segs: {}, active: [], time: 1000, live: null, saves: 0 };
}

function tick(w, segMem, opts) {
  opts = opts || {};
  w.time += 1;
  global.Game = { time: w.time, cpu: { bucket: 10000, getUsed: () => 0 }, rooms: {}, creeps: {} };
  if (opts.reuse && w.live) global.Memory = w.live;
  else global.Memory = JSON.parse(w.mem);
  let next = null;
  global.RawMemory = { segments: {}, setActiveSegments(ids) { next = ids.slice(); } };
  if (!opts.noSegs) for (const id of w.active) RawMemory.segments[id] = w.segs[id] || '';
  if (opts.extraKeys) for (const id of opts.extraKeys) RawMemory.segments[id] = 'x';
  const ready = segMem.begin();
  if (ready && opts.body) opts.body(Memory);
  if (ready) segMem.flush();
  const keys = Object.keys(RawMemory.segments);
  assert.ok(keys.length <= 10, 'engine refuses more than 10 segment saves (' + keys.length + ')');
  for (const k of keys) { if (!(opts.extraKeys || []).includes(Number(k))) { w.segs[k] = RawMemory.segments[k]; w.saves++; } }
  w.mem = JSON.stringify(Memory);
  w.live = Memory;
  if (next) w.active = next;
  return ready;
}

function sampleMem() {
  const route = { W34S8: 'aaaa'.repeat(50), W33S8: 'bbbb'.repeat(40) };
  return {
    creeps: {},
    rooms: {
      W33S8: { state: { at: 1 }, demand: { hauler: 2 }, plan: { version: 'w', wheel: true, roads: 'x'.repeat(3000) }, spawnLog: [{ t: 1 }],
        spawnStallLog: { n: 3, trapped: { at: 5 } }, crippledLog: [{ t: 2 }],
        remotes: { W34S8: { room: 'W34S8', enabled: true, sources: [{ id: 's1', distance: 40, routeRoads: route }, { id: 's2', distance: 30 }] } } },
      W34S7: { state: { at: 2 }, plan: { version: 'w', wheel: true, roads: 'y'.repeat(2000) }, demolition: [{ t: 9 }] },
      W39S9: { pathRefresh: { n: 1 } },
    },
    stats: Array.from({ length: 10 }, (_, i) => ({ t: 900 + i * 30, cpu: 140 + i, bucket: 9000 })),
    other: { keep: 1 },
  };
}

function coldView(mem, segMem) {
  const out = {};
  for (const name of Object.keys(mem.rooms)) {
    const r = mem.rooms[name];
    const o = {};
    for (const k of segMem.COLD) if (r[k] !== undefined) o[k] = r[k];
    for (const rn of Object.keys(r.remotes || {})) for (const s of r.remotes[rn].sources || []) if (s.routeRoads !== undefined) o['rr:' + rn + ':' + s.id] = s.routeRoads;
    out[name] = o;
  }
  return JSON.stringify(out);
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  const before = JSON.parse(w.mem);
  const beforeCold = coldView(before, segMem);
  assert.ok(tick(w, segMem), 'first tick with state mem is ready (no segments yet)');
  let saved = JSON.parse(w.mem);
  assert.ok(saved.rooms.W33S8.plan && Array.isArray(saved.stats), 'first tick keeps data in Memory until the segment write is verified');
  assert.ok(w.segs[40] && w.segs[41] !== undefined, 'stats and room segments are written on the first tick');
  assert.ok(tick(w, segMem, { reuse: true }), 'second tick ready');
  saved = JSON.parse(w.mem);
  assert.strictEqual(saved.rooms.W33S8.plan, undefined, 'plan hidden from serialized Memory after verify');
  assert.strictEqual(saved.stats, undefined, 'stats hidden from serialized Memory after verify');
  assert.strictEqual(saved.rooms.W33S8.remotes.W34S8.sources[0].routeRoads, undefined, 'routeRoads hidden');
  assert.deepStrictEqual(saved.rooms.W33S8.demand, { hauler: 2 }, 'hot fields stay in Memory');
  assert.strictEqual(saved.rooms.W33S8.remotes.W34S8.sources[0].distance, 40, 'hot remote fields stay');
  assert.strictEqual(saved.segMem.rooms, 'seg');
  assert.strictEqual(saved.segMem.stats, 'seg');
  assert.ok(saved.other.keep === 1, 'other keys untouched');
  assert.strictEqual(coldView(Memory, segMem), beforeCold, 'live heap still sees every cold field');
  assert.ok(Array.isArray(Memory.stats) && Memory.stats.length === 10, 'Memory.stats readable in heap');
  assert.ok(w.mem.length < JSON.stringify(before).length / 2, 'serialized Memory shrinks (' + w.mem.length + ')');

  tick(w, segMem, { reuse: true, body(m) { m.rooms.W33S8.spawnLog.push({ t: 2 }); m.stats.push({ t: 1300, cpu: 150 }); } });
  assert.ok(JSON.parse(w.segs[40]).stats.some((e) => e.t === 1300), 'new stats entry written to the segment on the same tick');
  for (let i = 0; i < 11; i++) tick(w, segMem, { reuse: true });
  assert.ok(w.segs[41].includes('"t":2') || w.segs[42].includes('"t":2') || Object.values(w.segs).some((s) => s.includes('{"t":1},{"t":2}')), 'spawnLog change flushed within flushEvery ticks');
  const liveCold = coldView(Memory, segMem);

  const segMem2 = load();
  assert.ok(tick(w, segMem2), 'global reset with active segments is ready on the first tick');
  assert.strictEqual(coldView(Memory, segMem2), liveCold, 'global reset restores every cold field from segments');
  assert.ok(Array.isArray(Memory.stats) && Memory.stats.some((e) => e.t === 1300), 'global reset restores stats');
  assert.strictEqual(JSON.parse(w.mem).rooms.W33S8.plan, undefined, 'restored fields stay hidden');
  assert.strictEqual(Object.getOwnPropertyDescriptor(Memory.rooms.W33S8, 'plan').enumerable, false);
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  tick(w, segMem); tick(w, segMem, { reuse: true });
  const liveCold = coldView(Memory, segMem);
  const savedSegs = Object.assign({}, w.segs);
  const segMem2 = load();
  w.active = [];
  let changed = false;
  const r1 = tick(w, segMem2, { body() { changed = true; } });
  assert.strictEqual(r1, false, 'reset with segments not active: tick body skipped');
  assert.ok(!changed, 'body did not run');
  assert.deepStrictEqual(w.segs, savedSegs, 'nothing written to segments while not ready');
  assert.strictEqual(JSON.parse(w.mem).segMem.waiting.n, 1);
  assert.ok(tick(w, segMem2), 'next tick segments present: ready');
  assert.strictEqual(coldView(Memory, segMem2), liveCold, 'restored after one waiting tick');
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  tick(w, segMem); tick(w, segMem, { reuse: true });
  const goodSegs = Object.assign({}, w.segs);
  const segMem2 = load();
  w.active = [];
  let ran = 0;
  for (let i = 0; i < 5; i++) assert.strictEqual(tick(w, segMem2, { noSegs: true }), false, 'waiting tick ' + i);
  assert.ok(tick(w, segMem2, { noSegs: true, body(m) { ran++; m.rooms.W34S7.plan = { version: 'fresh' }; } }), 'gives up after waitMax and runs the tick');
  assert.strictEqual(ran, 1);
  for (const id of [41, 42, 43, 44, 45, 46]) assert.strictEqual(w.segs[id], goodSegs[id], 'segment ' + id + ' not overwritten while rooms not loaded');
  w.active = segMem2.activeIds();
  tick(w, segMem2, { reuse: true });
  assert.strictEqual(Memory.rooms.W34S7.plan.version, 'fresh', 'late restore does not override data written after giving up');
  assert.ok(Memory.rooms.W33S8.plan && Memory.rooms.W33S8.plan.version === 'w', 'late restore fills missing fields');
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  const beforeCold = coldView(JSON.parse(w.mem), segMem);
  tick(w, segMem); tick(w, segMem, { reuse: true });
  const segMem2 = load();
  tick(w, segMem2);
  Memory.segMemOff = 1;
  w.mem = JSON.stringify(Memory);
  tick(w, segMem2, { reuse: true });
  const saved = JSON.parse(w.mem);
  assert.strictEqual(saved.segMem.rooms, 'mem', 'off switch: rooms back to Memory');
  assert.strictEqual(saved.segMem.stats, 'mem');
  assert.ok(Array.isArray(saved.stats) && saved.stats.length === 10, 'off switch: stats serialized again');
  assert.strictEqual(coldView(saved, segMem2), beforeCold, 'off switch: every cold field serialized again (old code can run)');
  const segsAfter = Object.assign({}, w.segs);
  tick(w, segMem2, { reuse: true, body(m) { m.rooms.W33S8.spawnLog.push({ t: 99 }); } });
  for (let i = 0; i < 12; i++) tick(w, segMem2, { reuse: true });
  for (const id of [40, 41, 42, 43, 44, 45, 46]) assert.strictEqual(w.segs[id], segsAfter[id], 'off: no more segment writes');
  assert.ok(JSON.parse(w.mem).rooms.W33S8.spawnLog.some((e) => e.t === 99), 'off: changes go to Memory');
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  tick(w, segMem); tick(w, segMem, { reuse: true });
  const r = Memory.rooms.W33S8.remotes.W34S8;
  const old = r.sources[0];
  r.sources = [{ id: 's1', distance: 41, routeRoads: old.routeRoads }, r.sources[1]];
  tick(w, segMem, { reuse: true });
  assert.strictEqual(JSON.parse(w.mem).rooms.W33S8.remotes.W34S8.sources[0].routeRoads, undefined, 'rebuilt source with the same routeRoads object hidden on the same tick');
  for (let i = 0; i < 12; i++) tick(w, segMem, { reuse: true });
  assert.strictEqual(JSON.parse(w.mem).rooms.W33S8.remotes.W34S8.sources[0].routeRoads, undefined, 'rebuilt source routeRoads hidden again');
  delete Memory.rooms.W34S7.plan;
  Memory.rooms.W34S7.plan = { version: 'again' };
  for (let i = 0; i < 12; i++) tick(w, segMem, { reuse: true });
  assert.strictEqual(JSON.parse(w.mem).rooms.W34S7.plan, undefined, 'deleted then re-created cold field re-hidden');
  const segMem2 = load();
  tick(w, segMem2);
  assert.strictEqual(Memory.rooms.W34S7.plan.version, 'again', 'restore sees re-created field');
  assert.strictEqual(Memory.rooms.W33S8.remotes.W34S8.sources[0].distance, 41);
  assert.ok(Memory.rooms.W33S8.remotes.W34S8.sources[0].routeRoads.W34S8, 'restore routeRoads into rebuilt source by id');
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  tick(w, segMem); tick(w, segMem, { reuse: true });
  const rebuild = (m, rr) => { const r = m.rooms.W33S8.remotes.W34S8; const o = r.sources[0]; r.sources = [{ id: 's1', distance: 40, routeRoads: rr || o.routeRoads }, { id: r.sources[1].id, distance: 30 }]; };
  let leaked = 0;
  for (let i = 0; i < 25; i++) { tick(w, segMem, { reuse: true, body(m) { rebuild(m); } }); if (w.mem.includes('aaaa')) leaked++; }
  assert.strictEqual(leaked, 0, 'visible remote rebuilt every tick: routeRoads never serialized into Memory');
  const fresh = { W34S8: 'cccc'.repeat(30), W33S8: 'dddd'.repeat(30) };
  tick(w, segMem, { reuse: true, body(m) { rebuild(m, fresh); } });
  assert.ok(w.mem.includes('cccc') || Object.values(w.segs).some((x) => x.includes('cccc')), 'new routeRoads object kept in Memory or segment, never only in heap');
  for (let i = 0; i < 15; i++) tick(w, segMem, { reuse: true, body(m) { rebuild(m); } });
  assert.ok(!w.mem.includes('cccc'), 'new routeRoads hidden after its segment write is verified');
  assert.ok(Object.values(w.segs).some((x) => x.includes('cccc')), 'new routeRoads in a room segment');
  const segMem2 = load();
  tick(w, segMem2);
  assert.strictEqual(Memory.rooms.W33S8.remotes.W34S8.sources[0].routeRoads.W34S8, fresh.W34S8, 'global reset restores the rebuilt routeRoads');
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  tick(w, segMem); tick(w, segMem, { reuse: true });
  const prev = Memory;
  Memory.rooms.W33S8.spawnLog.push({ t: 'heap' });
  w.mem = JSON.stringify(Memory);
  tick(w, segMem, { body() {} });
  assert.notStrictEqual(Memory, prev, 'memhack miss gives a fresh Memory object');
  assert.ok(Memory.rooms.W33S8.spawnLog.some((e) => e.t === 'heap'), 'memhack miss carries hidden fields from the heap copy');
  assert.ok(Array.isArray(Memory.stats) && Memory.stats.length === 10, 'memhack miss carries stats');
}

{
  const segMem = load();
  const big = sampleMem();
  big.stats = Array.from({ length: 40 }, (_, i) => ({ t: i, cpu: 1, pad: 'z'.repeat(3000) }));
  const w = makeWorld(big);
  tick(w, segMem);
  assert.ok(w.segs[40].length <= 98000, 'stats segment kept under the limit (' + w.segs[40].length + ')');
  assert.strictEqual(JSON.parse(w.segs[40]).stats.length, Memory.stats.length, 'heap stats trimmed to what fits');
  assert.strictEqual(Memory.stats[Memory.stats.length - 1].t, 39, 'newest entries kept');
}

{
  const segMem = load();
  const big = sampleMem();
  for (let i = 0; i < 40; i++) big.rooms['W1S' + i] = { plan: { pad: 'p'.repeat(18000) } };
  const w = makeWorld(big);
  for (let i = 0; i < 4; i++) tick(w, segMem, { reuse: i > 0 });
  const saved = JSON.parse(w.mem);
  const inMem = Object.keys(saved.rooms).filter((n) => saved.rooms[n].plan);
  assert.ok(inMem.length > 0, 'rooms that do not fit stay in Memory (' + inMem.length + ')');
  for (const id of segMem.ROOM_SEGS) assert.ok(!w.segs[id] || w.segs[id].length <= 98000, 'room segment ' + id + ' under limit');
  const segMem2 = load();
  tick(w, segMem2);
  for (const n of Object.keys(big.rooms)) assert.ok(Memory.rooms[n].plan || !big.rooms[n].plan, 'overflow: no plan lost for ' + n);
}

{
  const segMem = load();
  const w = makeWorld(sampleMem());
  tick(w, segMem, { extraKeys: [91, 95, 96, 97, 98] });
  const n = Object.keys(w.segs).length;
  assert.ok(n <= 5, 'writes capped when other segment keys are present (' + n + ')');
  for (let i = 0; i < 4; i++) tick(w, segMem, { reuse: true });
  assert.ok(Object.keys(w.segs).length >= 2, 'remaining writes drained on later ticks');
}

{
  const segMem = load();
  delete global.RawMemory;
  global.Memory = sampleMem();
  global.Game = { time: 5 };
  assert.strictEqual(segMem.begin(), true, 'no RawMemory: no-op and ready');
  segMem.flush();
  assert.ok(Array.isArray(Memory.stats) && Object.getOwnPropertyDescriptor(Memory, 'stats').enumerable, 'no RawMemory: nothing hidden');
}

console.log('seg_mem_test OK');
