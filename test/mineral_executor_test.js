'use strict';
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../src/roles/mineralMiner.js'), 'utf8');
function setup() {
    let calls = [];
    const store = (capacity, initial = {}) => {
        const s = Object.assign({}, initial);
        Object.defineProperties(s, {
            getUsedCapacity: { value: () => Object.values(s).reduce((a,b) => a+b,0) },
            getFreeCapacity: { value: () => capacity - s.getUsedCapacity() },
        });
        return s;
    };
    const mineral = { id: 'min', mineralAmount: 1000, pos: { x: 10, y: 10 } };
    const terminal = { id: 'term', my: true, store: store(100, {}), pos: { x: 20, y: 20 } };
    const storage = { id: 'store', my: true, store: store(1000, {}), pos: { x: 22, y: 20 } };
    const extractor = { id: 'ext', my: true, cooldown: 0, isActive: () => true };
    const objects = { min: mineral, term: terminal, store: storage, ext: extractor };
    const room = { name: 'W1N1', controller: { my: true, level: 6 }, find() { throw Error('room scan'); } };
    const plan = { version: 1, enabled: true, count: 1, mineralId: 'min', extractorId: 'ext', mineralType: 'H',
        stand: { x: 11, y: 10 }, maxStock: 50000, reserveFree: 10, returnTicks: 60,
        outbound: { 1021: 8 }, sinks: [{ id: 'term', path: { 511: 4 } }, { id: 'store', path: { 511: 4 } }] };
    const context = { module: { exports: {} }, require: name => {
        assert.equal(name, 'brain'); return { get: () => plan };
    }, Game: { time: 1, rooms: { W1N1: room }, getObjectById: id => objects[id] },
    Memory: { rooms: { W1N1: {} } }, WORK: 'work', OK: 0, ERR_NOT_IN_RANGE: -9 };
    vm.runInNewContext(source, context);
    const creep = { memory: { home: 'W1N1' }, ticksToLive: 1000, store: store(50),
        pos: { x: 11, y: 10, roomName: 'W1N1', isNearTo: () => true },
        getActiveBodyparts: () => 5,
        move: d => calls.push(['move', d]),
        harvest: () => { calls.push(['harvest']); return 0; },
        transfer: target => { calls.push(['transfer', target.id]); return 0; } };
    return { run: () => context.module.exports.run(creep), plan, creep, mineral, terminal, storage, extractor,
        objects, context, calls, room };
}
{
    const f = setup(); f.run(); assert.equal(f.calls[0][0], 'harvest');
    f.extractor.cooldown = 5; f.calls.length = 0; f.run(); assert.equal(f.calls.length, 0);
}
{
    const f = setup(); f.creep.store.H = 48; f.run();
    assert.equal(f.calls[0][0], 'transfer', 'deliver before an overflow harvest');
    f.creep.store.H = 20; f.calls.length = 0; f.context.Game.time++;
    f.run(); assert.equal(f.calls[0][0], 'transfer', 'partial unload stays in delivery state');
    assert.equal(f.context.Memory.rooms.W1N1.mineralStats.delivered, 28, 'measure actual next-tick inventory delta');
}
{
    const f = setup(); f.creep.store.H = 20; f.creep.ticksToLive = 50; f.run();
    assert.equal(f.calls[0][0], 'transfer', 'end of life flushes partial cargo');
}
{
    const f = setup(); f.creep.store.H = 50; f.terminal.store.Z = 100; f.run();
    assert.deepEqual(f.calls[0], ['transfer', 'store'], 'full terminal uses planned storage');
    f.storage.store.Z = 1000; f.calls.length = 0; f.run();
    assert.equal(f.calls.length, 0); assert(!f.creep.memory.retired, 'full sinks retain cargo');
}
{
    const f = setup(); f.mineral.mineralAmount = 0; f.creep.store.H = 20; f.run();
    assert.equal(f.calls[0][0], 'transfer'); f.creep.store.H = 0; f.run(); assert(f.creep.memory.retired);
}
{
    const f = setup(); f.creep.pos.x = 21; f.creep.pos.y = 20; f.run();
    assert.deepEqual(f.calls[0], ['move', 8], 'follow externally computed direction without pathfinding');
    f.calls.length = 0; f.creep.pos.x = 25; f.run(); assert.equal(f.calls.length, 0);
    assert.equal(f.creep.memory.mineralRouteMiss, 1);
}
{
    const f = setup(); f.extractor.isActive = () => false; f.run();
    assert(!f.calls.some(c => c[0] === 'harvest')); assert(f.creep.memory.retired);
}
console.log('mineral executor: lifecycle, cargo, cooldown and no-search checks passed');
{
    const f = setup(); f.creep.pos.x = 21; f.creep.pos.y = 20;
    for (let i = 0; i < 5; i++) { f.context.Game.time++; f.run(); }
    assert.equal(f.calls.length, 3, 'stop submitting blocked move intents');
    assert(f.creep.memory.mineralBlocked);
    f.plan.at = 10; f.run(); assert.equal(f.calls.length, 4, 'new brain route permits another attempt');
}
{
    let placed = 0;
    const context = { module: { exports: {} }, require: name => name === 'utils' ? { isWall: () => true } : {},
        STRUCTURE_ROAD: 'road', STRUCTURE_RAMPART: 'rampart', STRUCTURE_WALL: 'wall', STRUCTURE_CONTAINER: 'container',
        STRUCTURE_EXTRACTOR: 'extractor', LOOK_STRUCTURES: 'structures', LOOK_CONSTRUCTION_SITES: 'sites', OK: 0 };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/layout.js'), 'utf8') + '\nmodule.exports.testSite = trySite;', context);
    const room = { lookForAt: () => [], createConstructionSite: () => { placed++; return 0; } };
    assert(context.module.exports.testSite(room, { x: 10, y: 10 }, 'extractor'));
    assert(!context.module.exports.testSite(room, { x: 10, y: 10 }, 'storage'));
    assert.equal(placed, 1, 'natural-wall exception only applies to extractor');
}
