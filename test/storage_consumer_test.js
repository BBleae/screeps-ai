'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
/** roles/hauler 的 storage 消费者兜底：非 hub 房只为真实消费者、只取 storage 高于升级者底线的部分，同 tick 多只 hauler 共用一份预算；
 *  消费者消失后揣着的 storage 货不倒回 storage；有源头能量时先取源头。broker / utils 用最小桩（与新 hauler 的接口一致） */
function scenario({energy = 2059, consumer = true, source = false, link = false, demand = 100, idle = []} = {}) {
    const calls = [];
    const at = (x, y) => ({x, y, roomName: 'W33S3'});
    const storage = {id: 'st', my: true, structureType: 'storage', store: {energy}, pos: at(11, 11)};
    const target = {id: 'sp', structureType: 'spawn', store: {energy: 0, getFreeCapacity: () => 300}, pos: at(20, 20)};
    const container = {id: 'src', structureType: 'container', store: {energy: 200}, pos: at(12, 10)};
    const room = {name: 'W33S3', storage, find: () => [], energyAvailable: 300, energyCapacityAvailable: 300};
    let tasks = [];
    const rebuild = (withConsumer) => {
        tasks = withConsumer ? [{kind: 'deliver', id: 'sp', target, backlog: demand, roles: ['hauler'], tier: 1, weight: 10}] : [];
        if (source) tasks.push({kind: 'collect', id: 'src:collect', target: container, backlog: 200, weight: 7, inflow: 0});
    };
    rebuild(consumer);
    const broker = {roomTasks: () => tasks, pooledTasks: () => tasks, DELIVER_TIERS: [1, 2, 3, 4],
        controllerFeedLink: () => null, controllerFeedStorage: () => null, controllerFeedMode: () => link ? 'link' : null,
        pickTask: (creep, r, filter) => tasks.find((task) => filter(task)) || null,
        availableFor: (task) => task.backlog, consume: () => {}, setProjected: () => {}, waitSpots: () => [], leaseSpot: () => null};
    const context = {module: {exports: {}}, Game: {time: 1, rooms: {W33S3: room}, getObjectById: () => null},
        Memory: {rooms: {W33S3: {plan: {containers: {src0: {x: 12, y: 10}}}}}},
        RESOURCE_ENERGY: 'energy', STRUCTURE_STORAGE: 'storage', STRUCTURE_CONTAINER: 'container', STRUCTURE_TERMINAL: 'terminal',
        STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_TOWER: 'tower', FIND_HOSTILE_CREEPS: 5, FIND_MY_STRUCTURES: 6,
        FIND_STRUCTURES: 1, FIND_DROPPED_RESOURCES: 2, FIND_TOMBSTONES: 3, FIND_MY_SPAWNS: 4, FIND_SOURCES: 7, FIND_MY_CREEPS: 8,
        OK: 0, ERR_NOT_IN_RANGE: -9, require: name => ({config: {upgrading: {reserve: 2000}, hauling: {}}, layout: {},
            movement: {go: () => {}}, task_broker: broker, haul_stats: {note: () => {}},
            links: {hubHaulMode: () => false, skipSourceContainer: () => false, skipLinkedDrop: () => false},
            utils: {logErr: e => {throw e;}, storageRichState: () => false, towerUrgent: () => false, spawnWaitingFor: () => false, findCached: (r, type) => type === 8 ? idle : []}}[name])};
    vm.runInNewContext(fs.readFileSync('src/roles/hauler.js', 'utf8'), context);
    const pos = Object.assign(at(11, 10), {findInRange: () => [], findClosestByPath: () => null, inRangeTo: () => true});
    const creep = {name: 'c1', memory: {home: 'W33S3'}, store: {energy: 0, getFreeCapacity: () => 850}, pos,
        withdraw: (s, r, n) => {calls.push([s === storage ? 'storage' : 'source', n]); return 0;}};
    context.module.exports.run(creep);
    return {calls, creep,
        cancel: () => { rebuild(false); creep.store.energy = 59; creep.store.getFreeCapacity = () => 791; creep.transfer = () => { throw Error('storage cargo returned'); }; context.module.exports.run(creep); },
        run: () => context.module.exports.run({...creep, name: 'c2', memory: {home: 'W33S3'}})};
}
let x = scenario(); assert.deepStrictEqual(x.calls, [['storage', 59]]); assert.strictEqual(x.creep.memory.hubCargo, true);
x.run(); assert.strictEqual(x.calls.length, 1, 'same-tick withdrawals must preserve reserve'); x.cancel();
x = scenario({energy: 3000, demand: 50}); x.run();
assert.deepStrictEqual(x.calls, [['storage', 50]], 'same-tick demand cannot be reserved twice');
assert.deepStrictEqual(scenario({consumer:false}).calls, []);
assert.deepStrictEqual(scenario({energy:2000}).calls, []);
assert.deepStrictEqual(scenario({energy:2049}).calls, []);
assert.deepStrictEqual(scenario({energy:2050}).calls, [['storage', 50]]);
assert.deepStrictEqual(scenario({link:true}).calls, [['storage', 59]], 'link rooms also support real consumers above the reserve');
assert.deepStrictEqual(scenario({source:true}).calls, [['source', 200]], 'adjacent source energy comes before the storage reserve');
const parked = (energy, lease) => ({memory: {role: 'hauler', home: 'W33S3', hubCargo: true, hubCargoAt: 1, brokerTask: lease}, store: {energy}});
assert.deepStrictEqual(scenario({energy: 3000, demand: 300, idle: [parked(100)]}).calls, [['storage', 200]],
    'a parked hauler already holding storage cargo covers part of the gap: withdraw only the rest');
assert.deepStrictEqual(scenario({energy: 3000, idle: [parked(100)]}).calls, [], 'the parked cargo covers the whole gap: no withdraw');
assert.deepStrictEqual(scenario({energy: 3000, demand: 300, idle: [parked(100, {id: 'sp', until: 5})]}).calls, [['storage', 300]],
    'a storage-cargo hauler with a live lease is already counted through its claim, not twice');
console.log('storage consumer fallback: passed');
