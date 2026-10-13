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
const home = { find: () => [{ pos: { x: 25, y: 25, roomName: 'W33S7' } }], name: 'W33S7', energyCapacityAvailable: 1300,
    controller: { my: true, level: 5, owner: { username: 'me' } } };
const record = { room: 'W32S6', enabled: true, controllerDistance: 79, sources: [],
    reservation: { username: 'me', ticksToEnd: 1, seenAt: 1000 } };
const incumbent = { name: 'old', memory: { home: home.name, role: 'reserver', remoteRoom: record.room } };
let occupants = [incumbent];
const mocks = {
    config,
    brain: { directive: () => null },
    wheel_layout: {}, defense: {},
    utils: { roomPhase: () => 0, roomCoords: utils.roomCoords, roomDistance: () => 2, bodyCost:utils.bodyCost, bodyPartCount: utils.bodyPartCount, isRetiring: () => false, creepsHomeRole: (homeName,role) => occupants.filter(c=>c.memory.role===role) },
};
const context = { module: { exports: {} }, require: (name) => mocks[name],
    FIND_MY_SPAWNS: 'spawns',
    Game: { time: 1000, creeps: { old: incumbent }, map: { describeExits: () => ({}) } },
    Memory: { rooms: { [home.name]: { remoteMemoryVersion: 1, remotes: { [record.room]: record } } } } };
context.global = context;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/remote.js'), 'utf8'), context);
const remote = context.module.exports;
// Real incident: capacity2300, ideal1300, energy1100, old TTL88 and measured controller travel66.
context.Game.time = 77028;
home.energyCapacityAvailable = 2300;
record.controllerDistance = 66;
record.controllerPos = { x: 40, y: 40 };
record.reservation = { username: 'me', ticksToEnd: 1, seenAt: context.Game.time };
incumbent.ticksToLive = 88;
incumbent.pos = { roomName: record.room, x: 40, y: 39 };
incumbent.body = [{type:'claim',hits:100},{type:'move',hits:100}];
const spawnContext = { module: {exports:{}}, require: name => name === 'utils' ? utils : name === 'config' ? config : {}, Game: context.Game };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/spawn.js'), 'utf8') + '\nmodule.exports.requestForTest = demandRequest;', spawnContext);
const demand = () => remote.getDemands(home).find((d) => d.role === 'reserver');
const request = (item) => spawnContext.module.exports.requestForTest(home, item, 'remoteMaintain', config.spawnQueue, {jumpable:true});
const cheapHauler = { key: 'other-remote-hauler', role: 'remoteHauler', priority: 4, ordered: true,
    body: (budget) => budget >= 1100 ? Array(22).fill('carry') : [] };
function schedule({energy=1100,income=20,waited=0,others=[cheapHauler],spawnsFree=1,busySpawnTimes=[]} = {}) {
    const item=demand(), req=request(item);
    return queue.schedule([req,...others], {now:context.Game.time,energy,capacity:home.energyCapacityAvailable,
        income,spawnsFree,busySpawnTimes,since:{[req.key]:context.Game.time-waited}});
}
const threshold = config.remote.reserverDoubleClaimCapacity;
for (const override of [undefined,1300]) {
    if (override === undefined) delete config.remote.reserverDoubleClaimCapacity;
    else config.remote.reserverDoubleClaimCapacity=override;
    const result=schedule();
    assert.strictEqual(result.actions[0].request.role,'reserver','launch the affordable handoff before a same-class hauling job consumes the viable slot');
    assert.strictEqual(utils.bodyCost(result.actions[0].body),650);
    assert(result.actions[0].body.length*3+record.controllerDistance<incumbent.ticksToLive);
    assert.strictEqual(demand().grace,60,'keep grace as original request-age budget');
    assert.strictEqual(request(demand()).neededBy,context.Game.time-3,'absolute safe deadline reaches real demandRequest');
    assert.strictEqual(utils.bodyCost(schedule({energy:1300}).actions[0].body),1300,'full funding always prefers two CLAIM');
}
config.remote.reserverDoubleClaimCapacity=threshold;
incumbent.ticksToLive=120; // deadline now+29; ETA15 and 30 ticks already waited: both deadlines still permit waiting.
const unsafeWait = schedule();
assert.strictEqual(unsafeWait.actions.length,0,'do not wait for double CLAIM while launching a 66-tick job across the 29-tick safe deadline');
assert(unsafeWait.blocked.includes('other-remote-hauler'));
const tickBeforeRefill=context.Game.time;
context.Game.time+=10; incumbent.ticksToLive-=10; record.reservation.seenAt=context.Game.time;
assert.strictEqual(utils.bodyCost(schedule({energy:1300,waited:10}).actions[0].body),1300,'preserved budget permits double CLAIM after its actual ETA');
context.Game.time=tickBeforeRefill; incumbent.ticksToLive=120; record.reservation.seenAt=context.Game.time;
const shortHauler={key:'short',role:'remoteHauler',priority:4,ordered:true,body:()=>Array(4).fill('carry')};
assert.strictEqual(schedule({others:[shortHauler]}).actions[0].request.key,'short','short safe hauling job can use the waiting interval');
assert.strictEqual(schedule({spawnsFree:2}).actions.length,0,'an idle sibling alone does not justify spending the fallback budget');
assert.strictEqual(schedule({spawnsFree:2,income:60}).actions[0].request.key,'other-remote-hauler','spare spawn plus funding by deadline permits parallel hauling');
assert.strictEqual(schedule({busySpawnTimes:[5],income:60}).actions[0].request.key,'other-remote-hauler','earliest existing busy spawn release can preserve deadline');
assert.strictEqual(schedule({busySpawnTimes:[40],income:30}).actions.length,0,'a sibling that releases after deadline cannot make the long job safe');
assert.strictEqual(schedule({spawnsFree:2,income:30}).actions.length,0,'spare slot cannot rely on shrinking while the real queue prefers full funding');
const twin=request(demand()); twin.key+=':second';
assert.strictEqual(schedule({spawnsFree:3,income:30,others:[twin,cheapHauler]}).actions.length,0,
    'two deadlines cannot promise the same 870 energy to two 650 successors');
assert.strictEqual(schedule({spawnsFree:3,income:60,others:[twin,cheapHauler]}).actions.length,0,
    'full-body preference must not spend 1300 at tick22 after promising two 650 replacements');
const earlier={...twin,key:twin.key+':earlier',neededBy:context.Game.time+20};
assert.strictEqual(schedule({spawnsFree:3,income:100,others:[earlier,cheapHauler]}).actions.length,0,
    'admission must preserve ordered queue order instead of moving the earlier deadline ahead');
const tight=request(demand()); tight.key+=':tight'; tight.neededBy=context.Game.time+9;
const tight2={...tight,key:tight.key+':second'};
assert.strictEqual(queue.schedule([tight,tight2,cheapHauler],{now:context.Game.time,energy:1100,capacity:2300,
    income:200,spawnsFree:1,busySpawnTimes:[5]}).actions.length,0,
    'two successors cannot reuse the same sibling spawn release before deadline');
const incomeMiner={key:'income-miner',role:'remoteMiner',priority:4,ordered:true,body:()=>Array(22).fill('carry')};
assert.strictEqual(schedule({others:[incomeMiner]}).actions[0].request.key,'income-miner','necessary miner income keeps existing priority despite spawn duration');
const waiting=schedule({energy:1000,income:20,waited:30,others:[]});
assert.strictEqual(waiting.actions.length,0,'already waited time must not be subtracted twice from remaining safe wait');
assert.strictEqual(waiting.waiting.neededBy,context.Game.time+29);
assert.strictEqual(utils.bodyCost(schedule({energy:1000,income:20,waited:70,others:[]}).actions[0].body),650,'absolute deadline must not extend expired original grace');
record.reservation.ticksToEnd=500;
assert.strictEqual(demand().bodyFor(1100).length,0,'reserve buffer keeps ordinary two-CLAIM replacement policy');
record.reservation.ticksToEnd=1;
incumbent.ticksToLive=88;
const incoming={name:'in-transit',ticksToLive:529,body:incumbent.body,pos:{roomName:home.name,x:10,y:10},memory:incumbent.memory};
occupants=[incumbent,incoming];
assert.strictEqual(demand().neededBy,context.Game.time-3,'in-transit replacement is not controller coverage');
incoming.pos={roomName:record.room,x:10,y:10};
assert.strictEqual(demand().neededBy,context.Game.time-3,'being in remote room but away from controller does not extend coverage');
occupants=[incoming];
assert.strictEqual(demand().neededBy,undefined,'no real on-controller incumbent means no claimed coverage deadline');
occupants=[incumbent];
const miner={key:'miner',role:'remoteMiner',priority:4,ordered:true,body:b=>b>=350?['work','work','carry','move','move']:[]};
assert.strictEqual(schedule({energy:500,others:[miner]}).actions[0].request.role,'remoteMiner','unaffordable single CLAIM must not block same-class miner income');
for (const [role,priority] of [['defender',0],['harvester',1]]) {
    const higher={key:role,role,priority,body:()=>['work','carry','move']};
    assert.strictEqual(schedule({others:[higher]}).actions[0].request.role,role,'defense and survival remain higher priority');
}
// Production getDemands orders one remote's hauling before later remotes' reservers.
occupants=[incumbent]; incumbent.ticksToLive=113; home.energyCapacityAvailable=1800;
record.reservation.ticksToEnd=5;
record.sources=[{id:'later-source',containerId:'later-container',distance:66,energyCapacity:3000}];
const earlyRoom='W32S7';
context.Memory.rooms[home.name].remotes[earlyRoom]={room:earlyRoom,enabled:true,
    sources:[{id:'early-source',containerId:'early-container',distance:50,energyCapacity:3000,roadComplete:false}],
    reservation:{username:'me',ticksToEnd:4000,seenAt:context.Game.time}};
mocks.brain.directive=()=>({remotes:[earlyRoom,record.room]});
occupants.push({memory:{home:home.name,role:'remoteMiner',remoteRoom:record.room,sourceId:'later-source'},body:Array(5).fill({type:'work',hits:100}),ticksToLive:1000});
const orderedDemands=remote.getDemands(home).filter(d=>d.role==='reserver'||(d.role==='remoteHauler'&&d.memory.remoteRoom===earlyRoom&&d.memory.haulSlot===0));
assert.deepStrictEqual(Array.from(orderedDemands,d=>d.role),['remoteHauler','reserver'],'use actual producer order, not hand-arranged requests');
const orderedRequests=orderedDemands.map(request);
const orderedContext={now:context.Game.time,energy:1100,capacity:1800,income:20,spawnsFree:1,
    since:{[orderedRequests[0].key]:context.Game.time-61}};
const orderedResult=queue.schedule(orderedRequests,orderedContext);
assert(!orderedResult.actions.some(a=>a.request.role==='remoteHauler'),'due later reserver must veto an earlier 60-tick hauling candidate');
assert(orderedResult.blocked.includes(orderedRequests[0].key));
const afterSpawn=queue.schedule([orderedRequests[1],shortHauler],{...orderedContext,energy:1500,spawnsFree:2});
assert.deepStrictEqual(afterSpawn.actions.map(a=>a.request.role),['reserver','remoteHauler'],'already admitted reserver must not reserve a second body budget');
const recoveryHaul={...shortHauler,key:'recovery-haul'};
const expired={...orderedRequests[1],neededBy:context.Game.time-1};
assert.strictEqual(queue.schedule([recoveryHaul,expired],{...orderedContext,energy:500,income:0}).actions[0].request.key,
    recoveryHaul.key,'later expired and unaffordable reserver cannot freeze recovery hauling');
const optional={...orderedRequests[1],opportunistic:true};
assert.strictEqual(queue.schedule([cheapHauler,optional],orderedContext).actions[0].request.key,cheapHauler.key,
    'optional forecasts do not reserve future funding');
// The private observer initializes only request age inside the live engine Memory.
// A pre-existing parsed Memory object therefore cannot erase the activation.
incumbent.ticksToLive=87;
const dueRequests=[orderedRequests[0],request(demand())];
const observerMemory={rooms:{[home.name]:{spawnSince:{}}}};
const observerContext={module:{exports:{schedule:queue.schedule}},Memory:observerMemory,require:()=>utils};
vm.runInNewContext(require('../scripts/private_server/fixtures').reserveOrderedObserver(home.name,earlyRoom,record.room),observerContext);
const fixtureContext={...orderedContext,since:{}};
const observed=observerContext.module.exports.schedule(dueRequests,fixtureContext);
assert(observerMemory._reserveOrderedInitialized,'fixture activates within actual scheduler context');
assert.strictEqual(fixtureContext.since[dueRequests[0].key],context.Game.time-61);
assert.strictEqual(observed.actions[0].request.role,'reserver');
assert.strictEqual(observerMemory._reserveOrderedEvidence.haulCost,1050);
assert.strictEqual(observerMemory._reserveOrderedEvidence.haulParts,20);
const frozen=observerMemory._reserveOrderedEvidence;
observerContext.module.exports.schedule(dueRequests,{...fixtureContext,now:context.Game.time+1});
assert.strictEqual(observerMemory._reserveOrderedEvidence,frozen,'later loops cannot replace the first observed decision');
console.log('reserver_affordable_handoff_test ok');
