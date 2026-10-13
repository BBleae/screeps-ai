'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
let record, stopped = false, moves = [];
const context = {
    module: { exports: {} },
    Game: { rooms: {} }, Memory: { rooms: {} },
    RoomPosition: function(x,y,roomName) { Object.assign(this,{x,y,roomName}); },
    require: name => ({
        movement: { go: (creep,target,options) => moves.push({target,options}) },
        remote: { getRemote: () => record, isSuspended: () => false, noteTravel: () => stopped },
        expansion: {}, retire: {}, utils: {},
    })[name],
};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/roles/reserver.js'),'utf8'),context);
const creep = { memory: { home:'W63N55', remoteRoom:'W63N53' }, room: { name:'W63N55' } };
function destination(value) { record=value; moves=[];context.module.exports.run(creep);return moves[0]; }
let action=destination({room:'W63N53',controllerPos:{x:38,y:14}});
assert.deepStrictEqual(JSON.parse(JSON.stringify(action.target)),{x:38,y:14,roomName:'W63N53'},
    'known remote controller must be the cross-room goal used by the travel estimate');
assert.equal(action.options.range,1);
for (const value of [null,{room:'W63N53'},{room:'W63N53',controllerPos:{x:50,y:14}},
    {room:'W63N53',controllerPos:{x:38.5,y:14}},{room:'W62N53',controllerPos:{x:38,y:14}}]) {
    action=destination(value);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(action.target)),{x:25,y:25,roomName:'W63N53'});
    assert.equal(action.options.range,20,'unknown controller keeps exploration behavior');
}
stopped=true;destination({room:'W63N53',controllerPos:{x:38,y:14}});
assert.equal(moves.length,0,'travel backoff must still stop movement');
console.log('reserver_route_target_test ok');
