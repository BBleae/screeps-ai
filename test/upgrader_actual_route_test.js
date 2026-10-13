'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
let searches = 0, paths = [], structures = [], goalsSeen, ready = [];
const pos = (x,y) => ({x,y,roomName:'W34S7'});
let spawns = [{pos:pos(27,18)}];
let station = {pos:pos(32,40),anchor:{pos:pos(31,40)}};
const terrain = {get:(x,y) => x === 29 ? 2 : 0};
const room = {name:'W34S7',controller:{my:true,level:6,pos:pos(31,41)},getTerrain:()=>terrain,
    find:type=>type===1?spawns:type===2?structures:type===3?[{pos:pos(30,40)}]:type===4?[{pos:pos(32,39)}]:type===5?[{structureType:'extension',pos:pos(32,40)},{structureType:'road',pos:pos(31,39)}]:[]};
const ctx = {module:{exports:{}},Memory:{rooms:{W34S7:{plan:{anchor:pos(27,36)}}}},
    Game:{time:1,rooms:{W34S7:room}},RoomPosition:function(x,y,roomName){Object.assign(this,{x,y,roomName});},
    FIND_MY_SPAWNS:1,FIND_STRUCTURES:2,FIND_SOURCES:3,FIND_MINERALS:4,FIND_CONSTRUCTION_SITES:5,OBSTACLE_OBJECT_TYPES:['extension','spawn'],STRUCTURE_ROAD:'road',STRUCTURE_CONTAINER:'container',STRUCTURE_RAMPART:'rampart',
    TERRAIN_MASK_WALL:1,TERRAIN_MASK_SWAMP:2,
    PathFinder:{CostMatrix:class{constructor(){this.values={};}set(x,y,v){this.values[x+','+y]=v;}get(x,y){return this.values[x+','+y]||0;}},
        search:(origin,goals,opts)=>{searches++;goalsSeen=goals;assert.equal(origin.x,27);assert([18,19].includes(origin.y));
            assert.equal(opts.maxRooms,1);assert(opts.maxOps<=2500);const matrix=opts.roomCallback('W34S7');
            assert.equal(matrix.get(28,18),1);assert.equal(opts.plainCost,2);assert.equal(opts.swampCost,10);assert.equal(matrix.get(30,18),255);
            assert.equal(matrix.get(32,40),255,'wheel avoids extension construction site');
            assert.notEqual(matrix.get(31,39),255,'road site remains passable');
            assert(goals.every(g=>!(g.pos.x===32&&g.pos.y===40)));
            assert.equal(matrix.get(30,40),255,'source tile is blocked');assert.equal(matrix.get(32,39),255,'bare mineral is blocked');
            assert(goals.every(g=>!(g.pos.x===30&&g.pos.y===40)&&!(g.pos.x===32&&g.pos.y===39)));
            return paths.shift()||{incomplete:true,path:[]};}},
    require:name=>name==='config'?{spawnLead:{}}:name==='layout'?{
        upgraderStation:()=>station,atUpgraderStation:(p,s,c)=>Math.max(Math.abs(p.x-s.anchor.pos.x),Math.abs(p.y-s.anchor.pos.y))<=1&&Math.max(Math.abs(p.x-c.pos.x),Math.abs(p.y-c.pos.y))<=3
    }: name==='utils'?{creepsHomeRole:()=>ready,isRetiring:()=>false}: {}};
structures=[{structureType:'road',pos:pos(28,18)},{structureType:'spawn',pos:pos(30,18)}];
vm.runInNewContext(fs.readFileSync(require.resolve('../src/spawn.js'),'utf8'),ctx);
const body=[...Array(21).fill({type:'work'}),{type:'carry'},{type:'carry'},{type:'move'}];
const creep={body,memory:{home:'W34S7'}};
paths=[{path:[pos(28,18),pos(29,18),pos(30,19),pos(31,39)],incomplete:false}];
const lead=()=>ctx.module.exports.roleLead(creep,'upgrader');
assert.equal(lead(),84+12+115+23+23,'actual spawn route counts built road, swamp and unpaved detour; anchor is not spawn');
assert(goalsSeen.length>1 && goalsSeen.every(g=>g.range===0 && g.pos.y>=39),'search all valid station cells');
lead();ctx.Game.time++;lead();assert.equal(searches,1,'reuse across ticks and creeps');
ctx.Game.time+=100;paths=[{path:[pos(28,18),pos(31,39)],incomplete:false}];
assert.equal(lead(),119);assert.equal(searches,2,'bounded refresh incorporates completed roads');
delete ctx.Game.rooms.W34S7;ctx.Game.time++;
assert.equal(lead(),84,'unknown vision must not invent a handoff deadline');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.ticks,null);
ctx.Game.rooms.W34S7=room;ctx.Game.time+=100;paths=[{path:[pos(28,18)],incomplete:true}];
assert.equal(lead(),84,'incomplete path must not cause early repeated replacement');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.complete,false);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.ticks,null);
ctx.Game.time++;spawns=[{pos:pos(27,18)},{pos:pos(27,19)}];
paths=[{path:[pos(31,39)],incomplete:false},{path:[pos(28,18),pos(31,39)],incomplete:false}];
assert.equal(lead(),119,'spawn count/position invalidates cache immediately; all eligible spawns need sufficient lead');
ctx.Game.time++;const count=searches;
assert.equal(ctx.module.exports.roleLead({body:body.filter(p=>p.type!=='move'),memory:creep.memory},'upgrader'),81);
assert.equal(searches,count,'immobile body is not modeled as one MOVE');
station=null;spawns=[{pos:pos(27,18)}];ctx.Game.time++;paths=[{path:[pos(28,18),pos(31,38)],incomplete:false}];
assert.equal(lead(),119,'visible controller without plan uses valid range3 goals, not unknown-route fallback');
assert(goalsSeen.some(g=>g.pos.y===38),'unplanned room includes controller range3 goals');
assert.equal(ctx.module.exports.roleLead({body,memory:{}},'hauler'),84,'other roles unchanged');
console.log('upgrader_actual_route_test ok');

// Independent grid search: an unplanned controller is reachable only by walking
// around a wall continued by a source and a bare mineral, not through them.
station = null;
spawns = [{pos:pos(1,1)}];
structures = [];
room.controller.pos = pos(7,1);
room.getTerrain = () => ({get:(x,y) => x>10 || y>10 || (x===3 && y<=3) ? 1 : 0});
room.find = type => type===1 ? spawns : type===3 ? [{pos:pos(3,4)}] : type===4 ? [{pos:pos(3,5)}] : [];
let actualPath;
ctx.PathFinder.search = (origin,goals,options) => {
    const matrix=options.roomCallback(origin.roomName), terrain=room.getTerrain();
    const goalSet=new Set(goals.map(g=>g.pos.x+','+g.pos.y));
    const pending=[{x:origin.x,y:origin.y,cost:0,path:[]}], best=new Map();
    while(pending.length){
        pending.sort((a,b)=>a.cost-b.cost);const node=pending.shift(), key=node.x+','+node.y;
        if(best.has(key))continue;best.set(key,node.cost);
        if(goalSet.has(key)){actualPath=node.path;return {path:node.path,incomplete:false};}
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
            const x=node.x+dx,y=node.y+dy;
            if((!dx&&!dy)||x<0||y<0||x>49||y>49||terrain.get(x,y)===1||matrix.get(x,y)===255)continue;
            pending.push({x,y,cost:node.cost+(matrix.get(x,y)||options.plainCost),path:node.path.concat(pos(x,y))});
        }
    }
    return {path:[],incomplete:true};
};
ctx.Game.time++;
assert.equal(lead(),84+7*23,'actual geometry takes seven plain steps around the natural-obstacle barrier');
assert(actualPath.every(p=>!(p.x===3&&p.y<=5)),'route does not cross a source or mineral');
console.log('upgrader_actual_route geometry ok');

// Unknown travel never counts a newborn/young traveller out of the planned population.
const heavyBody=[...Array(30).fill({type:'work'}),{type:'carry'},{type:'carry'},{type:'move'}];
const gridSearch=ctx.PathFinder.search;
ctx.PathFinder.search=()=>({path:[],incomplete:true});ctx.Game.time+=100;
const young={body:heavyBody,memory:{home:'W34S7',role:'upgrader'},ticksToLive:1500};
ready=[young];
assert.equal(ctx.module.exports.roleLead(young,'upgrader'),111);
assert.equal(ctx.module.exports.countReadyRole(room,'upgrader'),1);
young.ticksToLive=1200;
assert.equal(ctx.module.exports.countReadyRole(room,'upgrader'),1,'unknown-route traveller remains counted');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.complete,false);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.ticks,null);

// Preferred exact spot takes a different corridor before first entering any valid station tile.
ctx.PathFinder.search=gridSearch;
spawns=[{pos:pos(5,10)}];
station={pos:pos(11,11),spots:[pos(11,11),pos(11,11)],anchor:{pos:pos(10,10)}};
room.controller.pos=pos(10,13);
room.getTerrain=()=>({get:(x,y)=>x>20||y>20||(x===10&&y>=1&&y<=13)||(x===9&&y===11)?1:0});
room.find=type=>type===1?spawns:[];
ctx.Game.time++;
assert.equal(lead(),84+8*23,'follow exact preferred corridor until first valid station tile, not nearest-goal shortcut');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.searches,2,'duplicate preferred coordinates are searched only once');
assert(ctx.Memory.rooms.W34S7.upgraderLeg.ops<=7500);
station.pos=pos(9,10);station.spots=[pos(9,10)];ctx.Game.time++;
assert.equal(lead(),84+4*23,'preferred point changes invalidate cache even with unchanged anchor');
console.log('upgrader preferred route and unknown handoff ok');
spawns=[{pos:pos(5,10)},{pos:pos(5,10)}];ctx.Game.time++;
lead();
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.ops,7500,'all branch searches share one bounded budget');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.searches,3);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.ticks,null,'budget exhaustion is unknown, not a partial optimistic route');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.complete,false);
// A physically complete route can still be impossible to hand over within one lifetime.
station=null;spawns=[{pos:pos(1,1)}];room.controller.pos=pos(10,4);
room.getTerrain=()=>({get:(x,y)=>x===4&&y<=26?1:0});
ctx.PathFinder.search=gridSearch;ctx.Game.time+=100;
young.ticksToLive=1500;
assert.equal(ctx.module.exports.roleLead(young,'upgrader'),111,'lifetime-infeasible complete route cannot uncount a newborn');
assert.equal(ctx.module.exports.countReadyRole(room,'upgrader'),1);
young.ticksToLive=1200;assert.equal(ctx.module.exports.countReadyRole(room,'upgrader'),1);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.reason,'lifetime');
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.pathTicks,46*32);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.ticks,null);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.complete,false);
// A long but feasible route still supplies its full handoff lead, without an arbitrary cap.
room.getTerrain=()=>({get:(x,y)=>x===4&&y<=16?1:0});ctx.Game.time+=100;
const feasible=ctx.module.exports.roleLead(young,'upgrader');
assert(feasible>700&&feasible<1500);
assert.equal(feasible,111+ctx.Memory.rooms.W34S7.upgraderLeg.ticks);
assert.equal(ctx.Memory.rooms.W34S7.upgraderLeg.complete,true);
console.log('upgrader lifetime feasibility ok');

// Route selection follows wheel weights, while travel counts full-body fatigue.
// A long road corridor beats the short plain corridor in wheel's cost model.
station={pos:pos(40,5),anchor:{pos:pos(40,5)}};
spawns=[{pos:pos(5,5)}];room.controller.pos=pos(43,5);
const roadCells=new Set(),openCells=new Set();
for(let x=5;x<=40;x++){openCells.add(x+',5');roadCells.add(x+',20');}
for(let y=6;y<=20;y++)roadCells.add('5,'+y);
for(let y=5;y<=20;y++)roadCells.add('40,'+y);
for(const cell of roadCells)openCells.add(cell);
room.getTerrain=()=>({get:(x,y)=>openCells.has(x+','+y)?0:1});
room.find=type=>type===1?spawns:type===2?Array.from(roadCells,cell=>{
    const [x,y]=cell.split(',').map(Number);return {structureType:'road',pos:pos(x,y)};
}):[];
ctx.Game.time+=100;
const small={body:[{type:'work'},{type:'work'},{type:'carry'},{type:'move'}],memory:{home:'W34S7'}};
assert.equal(ctx.module.exports.roleLead(small,'upgrader'),24+62*2,
    'wheel chooses road corridor; count fatigue only to first legal station tile');
console.log('upgrader route weights match wheel defaults');
