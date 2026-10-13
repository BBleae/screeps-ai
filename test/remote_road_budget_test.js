'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
function fixture() {
    let buildCalls = 0, moves = 0;
    const road = {structureType: 'road', progress: 0, progressTotal: 300};
    const room = {name: 'R', find: () => [], lookForAt: () => []};
    const creep = {memory: {home: 'H', remoteRoom: 'R', state: 'deliver'}, room, body: [{type: 'work', hits: 100}],
        getActiveBodyparts: () => 1, store: {energy: 600, getFreeCapacity: () => 600 - creep.store.energy},
        pos: {findInRange: (kind, range, options) => kind === 1 ? [road].filter(options.filter) : [], inRangeTo: () => true},
        build: () => { buildCalls++; return 0; }, repair: () => 0, transfer: () => 0};
    const home = {name:'H', find: () => [], storage: {my:true, store:{getFreeCapacity: () => 10000}}};
    const context = {module:{exports:{}}, Game:{time:1,rooms:{}}, Memory:{rooms:{H:{}}},
        RESOURCE_ENERGY:'energy', STRUCTURE_ROAD:'road', STRUCTURE_CONTAINER:'container', STRUCTURE_TOWER:'tower',
        STRUCTURE_SPAWN:'spawn', STRUCTURE_EXTENSION:'extension', FIND_MY_CONSTRUCTION_SITES:1,FIND_STRUCTURES:2,
        FIND_HOSTILE_CREEPS:3, FIND_MY_STRUCTURES:4, WORK:'work', BUILD_POWER:5, OK:0,ERR_NOT_IN_RANGE:-9,
        RoomPosition: function(x,y,r) {this.roomName=r;},
        require: n => ({movement:{go:()=>{moves++;}}, remote:{noteTravel:()=>false,keeperRetreat:()=>false,isSuspended:()=>false,dropRoom:()=> 'H',observe:()=>{},getSource:()=>null},
            layout:{controllerFedByStorage:()=>false}, retire:{},config:{},utils:{towerUrgent:()=>false},task_broker:{controllerFeedMode:()=>null,controllerFeedLink:()=>null,controllerFeedStorage:()=>null}}[n])};
    vm.runInNewContext(fs.readFileSync('src/roles/remoteHauler.js','utf8'),context);
    function tick(actualBuild = 5) { const before=buildCalls;context.module.exports.run(creep);if(buildCalls>before){creep.store.energy-=actualBuild;road.progress+=actualBuild;}context.Game.time++; }
    return {creep,road,home,context,tick,builds:()=>buildCalls,moves:()=>moves};
}
let f=fixture();for(let i=0;i<11;i++)f.tick();
assert.strictEqual(f.builds(),10,'a trip must stop after spending 50 energy on roads');
assert.strictEqual(f.creep.store.energy,550);assert.ok(f.moves()>0);
f.creep.memory.state='collect';f.tick();f.creep.memory.state='deliver';f.tick();
assert.strictEqual(f.builds(),10,'state changes cannot refresh budget');
f.creep.room=f.home;f.context.Game.rooms.H=f.home;f.tick();f.tick();
assert.strictEqual(f.creep.memory.remoteRoadSpent,50,'unexecuted transfer cannot reset budget');
f.creep.store.energy=0;f.tick();
f.creep.room={name:'R',find:()=>[]};f.creep.store.energy=600;f.creep.memory.state='deliver';f.tick();
assert.strictEqual(f.builds(),11,'confirmed delivery starts a new trip budget');
f=fixture();for(let i=0;i<11;i++)f.tick(0);assert.strictEqual(f.builds(),11,'accepted but unexecuted intents do not spend budget');
f=fixture();for(let i=0;i<10;i++)f.tick();f.road.structureType='container';f.tick();assert.strictEqual(f.builds(),11,'critical containers are not road-budgeted');
f=fixture();f.creep.getActiveBodyparts=()=>11;f.tick();assert.strictEqual(f.builds(),0,'one build cannot overshoot remaining road budget');
f=fixture();f.tick();f.context.Game.time+=2;f.tick();
assert.strictEqual(f.creep.memory.remoteRoadSpent,5,'missed immediate sample must conservatively preserve spent budget');
console.log('remote road budget: passed');
