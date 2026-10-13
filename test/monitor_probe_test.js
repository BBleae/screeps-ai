'use strict';
// Execute the actual Python-embedded probe, including remote fields, against deterministic game objects.
const assert = require('assert');
const vm = require('vm');
const {execFileSync} = require('child_process');
const probe = execFileSync('python3', ['-c', 'from scripts.monitor import PROBE; print(PROBE)'], {cwd: require('path').resolve(__dirname, '..'), encoding:'utf8'});
const vals = x => Array.isArray(x) ? x : Object.values(x || {});
const fn = f => typeof f === 'function' ? f : x => x[f];
const lodash = {
  map: (x,f) => Object.entries(x || {}).map(([k,v])=>fn(f)(v,Array.isArray(x)?Number(k):k)), filter: (x,f) => vals(x).filter(fn(f)),
  forEach: (x,f) => Object.entries(x || {}).forEach(([k,v])=>f(v,k)),
  values: vals, find: x=>vals(x)[0], some:(x,f)=>vals(x).some(f),
  sum:(x,f)=>vals(x).reduce((a,b)=>a+(f?f(b):b),0),
  reduce:(x,f,start)=>vals(x).reduce(f,start), min:x=>Math.min(...x),
  countBy:(x,f)=>vals(x).reduce((a,b)=>{const k=fn(f)(b);a[k]=(a[k]||0)+1;return a;},{})
};
const ctx = {_:lodash, Memory:{rooms:{}, errors:[]}, Game:{rooms:{},creeps:{},spawns:{},time:100,resources:{},cpu:{bucket:5000,limit:100,tickLimit:500,getUsed:()=>1},getObjectById:()=>null},
  require: name=>name==='remote'?{getDemands:()=>[]} : name==='task_broker'?{controllerFeedMode:()=>null}: {},
  BODYPART_COST:{work:100,move:50,claim:600,carry:50}};
for(const key of ['LOOK_STRUCTURES','WORK','CARRY','MOVE','CLAIM','ATTACK','HEAL','RANGED_ATTACK','RESOURCE_ENERGY','STRUCTURE_LINK','STRUCTURE_CONTAINER','STRUCTURE_TOWER','STRUCTURE_RAMPART','FIND_HOSTILE_CREEPS','FIND_MY_SPAWNS','FIND_STRUCTURES','FIND_MY_STRUCTURES','FIND_SOURCES','FIND_MY_CONSTRUCTION_SITES','FIND_DROPPED_RESOURCES']) ctx[key]=key;
vm.runInNewContext(probe, ctx);
assert.equal(JSON.parse(ctx.Memory._mon).schema,4);
const spawn = {id:'sp',name:'Spawn',owner:{username:'me'},pos:{x:25,y:25},store:{}};
const home = {name:'W1N1', controller:{my:true,level:4,progress:123,progressTotal:40500},energyAvailable:300,energyCapacityAvailable:800,
  find:k=>k==='FIND_MY_SPAWNS'?[spawn]:[],lookForAt:()=>[]};
const remote = {name:'W1N2',controller:{reservation:{username:'me',ticksToEnd:1}},
  find:k=>k==='FIND_DROPPED_RESOURCES'?[{id:'pile',amount:2000,resourceType:'RESOURCE_ENERGY',pos:{x:5,y:6}}]:[]};
ctx.Game.rooms={W1N1:home,W1N2:remote};ctx.Game.spawns={Spawn:spawn};
ctx.Memory.rooms.W1N1={remotes:{W1N2:{enabled:true,controllerDistance:150,controllerDistanceVersion:3,
  reservation:{username:'me',ticksToEnd:5000,seenAt:1},sources:[{id:'source',distance:25,distanceVersion:2,distanceIncomplete:true,roadComplete:true,road:''}]}}};
vm.runInNewContext(probe,ctx);
const mon=JSON.parse(ctx.Memory._mon), r=mon.rooms[0].remotes[0];
assert.equal(mon.username,'me');assert.equal(r.reservation.ticksToEnd,1,'visible controller overrides stale memory');
assert.equal(mon.rooms[0].upgraderLeg,null,'older code without route telemetry is unknown');
assert.equal(mon.rooms[0].linkRelief,null,'absent movement attempt telemetry stays unknown');
assert.equal(mon.rooms[0].linkReliefInPlace,null,'absent in-place refill telemetry stays unknown');
ctx.Memory.rooms.W1N1.linkRelief={at:100,n:1501,x:11,y:42,unrelated:'omit'};
ctx.Memory.rooms.W1N1.linkReliefInPlace={at:99,n:7,unrelated:'omit'};
ctx.Memory.rooms.W1N1.upgraderLeg={at:100,ticks:null,complete:false,spawns:1,goals:0};
vm.runInNewContext(probe,ctx);
assert.deepEqual(JSON.parse(ctx.Memory._mon).rooms[0].upgraderLeg,ctx.Memory.rooms.W1N1.upgraderLeg,
  'failed route estimation remains explicitly unknown in the actual live probe');
assert.deepEqual(JSON.parse(ctx.Memory._mon).rooms[0].linkRelief,{at:100,n:1501,x:11,y:42},
  'actual probe preserves the attempt timestamp, counter and destination only');
assert.deepEqual(JSON.parse(ctx.Memory._mon).rooms[0].linkReliefInPlace,{at:99,n:7},
  'actual probe preserves the in-place refill timestamp and counter only');
assert.equal(r.reservation.seenAt,100);assert.equal(r.drops[0].amount,2000);assert.equal(r.routes[0].incomplete,true);
assert.equal(r.routes[0].roadTiles,0);assert.equal(mon.rooms[0].economy.ledgerComplete,false);
ctx.Memory.rooms.W1N1.remotes.W1N2.sources[0].road = '10.20;11.21';
vm.runInNewContext(probe,ctx);
assert.equal(JSON.parse(ctx.Memory._mon).rooms[0].remotes[0].routes[0].roadTiles,2);
delete ctx.Game.rooms.W1N2;
vm.runInNewContext(probe,ctx);
const unseen=JSON.parse(ctx.Memory._mon).rooms[0].remotes[0];
assert.equal(unseen.visible,false);assert.equal(unseen.drops,null);assert.equal(unseen.reservation.seenAt,1);
const originalFind = home.find;
home.find = k => k==='FIND_MY_CONSTRUCTION_SITES' ? [{id:'lab',structureType:'lab',progress:123,progressTotal:50000,pos:{x:4,y:5}}] : originalFind(k);
vm.runInNewContext(probe,ctx);
assert.equal(JSON.parse(ctx.Memory._mon).rooms[0].sites[0].wanted,null,'unavailable policy stays unknown');
const originalRequire = ctx.require;
ctx.require = name => name==='utils' ? {siteWanted:()=>false} : originalRequire(name);
vm.runInNewContext(probe,ctx);
assert.equal(JSON.parse(ctx.Memory._mon).rooms[0].sites[0].wanted,false,'explicit game policy deferral is observable');
ctx.require = name => name==='utils' ? {siteWanted:()=>true} : originalRequire(name);
vm.runInNewContext(probe,ctx);
assert.equal(JSON.parse(ctx.Memory._mon).rooms[0].sites[0].wanted,true,'active construction resumes observation');
console.log('monitor probe: empty / visible / stale / invisible scenarios passed');
