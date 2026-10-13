'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const config = require('../src/config');
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
    return originalResolve.call(this, ['utils', 'config'].includes(name)
        ? path.join(__dirname, '../src', name + '.js') : name, ...args);
};
const queue = require('../src/spawn_queue');
const utils = require('../src/utils');
Module._resolveFilename = originalResolve;
const home = { find: () => [{ pos: { x: 29, y: 8, roomName: 'W33S3' } }], name: 'W33S3', energyCapacityAvailable: 1300,
    controller: { my: true, level: 5, owner: { username: 'me' } } };
const record = { room: 'W33S1', enabled: true, controllerDistance: 79, sources: [],
    reservation: { username: 'me', ticksToEnd: 1, seenAt: 1000 } };
const incumbent = { name: 'old', memory: { home: home.name, role: 'reserver', remoteRoom: record.room } };
const mocks = {
    config,
    brain: { directive: () => null },
    wheel_layout: {}, defense: {},
    utils: { roomPhase: () => 0, roomCoords: utils.roomCoords, roomDistance: () => 2, isRetiring: () => false, creepsHomeRole: (homeName, role) => role === incumbent.memory.role ? [incumbent] : [] },
};
const context = { module: { exports: {} }, require: (name) => mocks[name],
    FIND_MY_SPAWNS: 'spawns',
    Game: { time: 1000, creeps: { old: incumbent }, map: { describeExits: () => ({}) } },
    Memory: { rooms: { [home.name]: { remoteMemoryVersion: 1, remotes: { [record.room]: record } } } } };
context.global = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/remote.js'), 'utf8'), context);
const remote = context.module.exports;
// Refill takes the entire configured grace; queue really waits and then spawns the full replacement.
for (const grace of [60, 90]) {
    const previous = config.remote.reserverGrace;
    config.remote.reserverGrace = grace;
    const item = remote.getDemands(home).find((d) => d.role === 'reserver');
    config.remote.reserverGrace = previous;
    const request = { key: item.slot, role: item.role, priority: 4, grace: item.grace,
        body: (budget) => budget >= 1300 ? item.body : item.bodyFor(budget) };
    const since = { [item.slot]: 1000 };
    const refill = 1200 / grace;
    assert.strictEqual(queue.schedule([request], { now: 1000, energy: 100, capacity: 1300,
        income: refill, spawnsFree: 1, since }).actions.length, 0, 'queue waits for affordable full body');
    const action = queue.schedule([request], { now: 1000 + grace, energy: 1300,
        capacity: 1300, income: refill, spawnsFree: 1, since }).actions[0];
    assert(action, 'replacement is spawned after refill');
    const arrivalAfterRequest = grace + action.body.length * 3 + record.controllerDistance;
    assert(item.lead >= arrivalAfterRequest + 20,
        'replacement must reach controller before the single-CLAIM incumbent dies, with 20 ticks margin');
    assert.strictEqual(remote.getDemands(home).filter((d) => d.role === 'reserver').length, 1,
        'continuity must not add permanent reserver slots');
}
record.room = 'W33S1';
record.controllerPos = { x: 38, y: 8 };
record.controllerDistance = 59;
const near = remote.getDemands(home).find((d) => d.role === 'reserver');
assert(near.lead >= 60 + 12 + 99 + 20, 'live two-room route cannot use the stale 59-tick cache');
home.find = () => [{ pos: { x: 29, y: 8, roomName: home.name } },
    { pos: { x: 30, y: 40, roomName: home.name } }];
const far = remote.getDemands(home).find((d) => d.role === 'reserver');
assert(far.lead >= 60 + 12 + 131 + 20, 'all possible spawn origins must be covered');
record.controllerDistance = 180;
assert.strictEqual(remote.getDemands(home).find((d) => d.role === 'reserver').lead, 60 + 12 + 180 + 20,
    'never replace a longer measured distance with the geometric lower bound');
// Real PathFinder failure must not make a far delivery room appear shorter than a completed home route.
vm.runInNewContext('module.exports.testRouteLength = routeLength; module.exports.testRefreshDropRoom = refreshDropRoom;', context);
context.PathFinder = { search: (from) => from.roomName === home.name
    ? { incomplete: false, path: Array(100).fill({}) } : { incomplete: true, path: [] } };
home.find = () => [{ pos: { x: 29, y: 8, roomName: home.name } }];
const farHome = { name: 'W32S4', controller: { my: true },
    storage: { pos: { x: 26, y: 14, roomName: 'W32S4' } }, find: () => [] };
context.Game.rooms = { [home.name]: home, [farHome.name]: farHome };
context.Game.map.findRoute = () => [{}, {}, {}, {}];
context.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
record.sources = [{ spot: { x: 28, y: 24 } }];
remote.testRefreshDropRoom(home, record);
assert.strictEqual(record.drop.room, home.name, 'incomplete far route must not steal delivery from completed home route');
const lowerBound = remote.testRouteLength(farHome.storage.pos, new context.RoomPosition(28, 24, 'W33S1'), 5);
assert(lowerBound >= 140, 'three-room fallback must respect global tile distance');
let options;
context.PathFinder.search = (from, target, opts) => { options = { target, opts }; return { incomplete: true, path: [] }; };
remote.testRouteLength(farHome.storage.pos, new context.RoomPosition(38, 8, 'W33S1'), 5, 1);
assert.strictEqual(options.target.range, 1, 'controller routes stop adjacent, not on the impassable controller tile');
assert.strictEqual(options.opts.maxRooms, 16, 'room exploration budget includes detours beyond route hop count');
// Migration repairs even a cache above the geometric floor, and failed paths retry only at the refresh interval.
vm.runInNewContext('module.exports.testRefreshVisible = refreshVisible;', context);
Object.assign(context, { FIND_SOURCES: 'sources', FIND_STRUCTURES: 'structures', FIND_HOSTILE_CREEPS: 'hostiles',
    STRUCTURE_KEEPER_LAIR: 'keeperLair', LOOK_STRUCTURES: 'look', STRUCTURE_CONTAINER: 'container', STRUCTURE_ROAD: 'road' });
const observed = { name: 'W33S1', controller: null,
    find: (kind) => kind === 'sources' ? [{ id: 'migrating', pos: { x: 28, y: 24 }, energyCapacity: 3000 }] : [],
    lookForAt: () => [{ structureType: 'container', id: 'container' }] };
const migrating = { room: observed.name, enabled: true, lairs: 0, sources: [{ id: 'migrating',
    pos: { x: 28, y: 24 }, spot: { x: 28, y: 24 }, distance: 150, distanceVersion: 2, distanceIncomplete: false, road: '1.1', routeRoads: { W33S1: '1.1' } }] };
let searches = 0;
context.PathFinder.search = () => { searches++; return { incomplete: true, path: [] }; };
context.Game.time = 1000;
remote.testRefreshVisible(home, migrating, observed);
assert.strictEqual(searches, 1, 'migrate old cache even if it exceeds the geometric lower bound');
assert.strictEqual(migrating.sources[0].distanceVersion, 3);
assert.strictEqual(migrating.sources[0].distanceIncomplete, true);
context.Game.time = 1001;
remote.testRefreshVisible(home, migrating, observed);
assert.strictEqual(searches, 1, 'do not retry expensive incomplete search every tick');
context.Game.time = 1025;
remote.testRefreshVisible(home, migrating, observed);
assert.strictEqual(searches, 2, 'retry incomplete path after 25 ticks');
vm.runInNewContext('module.exports.testRefreshInfrastructure = refreshInfrastructure; module.exports.testPlanRoute = planRoute;', context);
const roads = { sources: [{ id: 'road-source', spot: { x: 10, y: 10 }, road: '', roadComplete: true }] };
remote.testRefreshInfrastructure(observed, roads);
assert.strictEqual(roads.sources[0].roadComplete, false, 'empty road plan must not select road-only hauler bodies');
roads.sources[0].routeRoads = { W33S1: '10.10', W33S2: '20.20' };
observed.lookForAt = () => [{ structureType: 'container', id: 'container' }, { structureType: 'road' }];
remote.testRefreshInfrastructure(observed, roads);
assert.strictEqual(roads.sources[0].roadComplete, false, 'unseen intermediate road coverage is not complete');
context.Game.rooms.W33S2 = { lookForAt: () => [{ structureType: 'road' }] };
remote.testRefreshInfrastructure(observed, roads);
assert.strictEqual(roads.sources[0].roadComplete, true, 'fully observed paved route qualifies for road-efficient bodies');
context.Game.rooms.W33S2.lookForAt = () => [];
remote.testRefreshInfrastructure(observed, roads);
assert.strictEqual(roads.sources[0].roadComplete, false, 'missing intermediate road must revoke road readiness');
context.PathFinder.search = (from, target, opts) => { options = opts; return { incomplete: true, path: [] }; };
remote.testPlanRoute(home, observed, { x: 28, y: 24 });
assert.strictEqual(options.maxRooms, 16, 'road search needs exploration headroom beyond the five-room route');
// Live W33S3 -> W31S1 needs 16 explored rooms despite a four-exit route.
context.PathFinder.search = (from, target, opts) => ({ incomplete: opts.maxRooms < 16,
    path: Array(opts.maxRooms < 16 ? 107 : 150).fill({}) });
assert.strictEqual(remote.testRouteLength(home.find()[0].pos,
    new context.RoomPosition(7, 37, 'W31S1'), 5), 150, 'complete route must replace the too-small exploration fallback');
assert.strictEqual(record.drop.distanceVersion, 3, 'drop metadata identifies the new search budget');
vm.runInNewContext('module.exports.testDropNeedsRefresh = dropNeedsRefresh;', context);
context.Game.time = 1025;
assert.strictEqual(remote.testDropNeedsRefresh(home, { room: record.room, drop: { at: 1025, distance: 60, distanceVersion: 2 } }), true,
    'fresh old-version drop must migrate on its 25-tick phase instead of waiting the full refresh period');
assert.strictEqual(remote.testDropNeedsRefresh(home, { room: record.room, drop: { at: 1025, distanceVersion: 3 } }), false,
    'new-version drop keeps normal refresh cadence');
context.Game.time = 1026;
assert.strictEqual(remote.testDropNeedsRefresh(home, { room: record.room, drop: { at: 1025, distanceVersion: 2 } }), false,
    'old drop migration is staggered rather than all rooms searching in the deployment tick');
console.log('remote_reservation_test ok');
