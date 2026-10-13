'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
// Exercise the installed driver's serialization, including removeHidden(). A
// plain Object.assign mock misses the leading-underscore field filtering.
const driverFile = path.join(__dirname, '../private-server/server/node_modules/@screeps/driver/lib/bulk.js');
const driverRequire = createRequire(driverFile);
const driverModule = { exports: {} };
let written;
vm.runInNewContext(fs.readFileSync(driverFile, 'utf8'), {
    module: driverModule,
    require: name => name === '@screeps/common' ? {
        storage: { db: { 'rooms.objects': { bulk: async ops => { written = ops; } } } },
    } : driverRequire(name),
});
const hooks = {};
require('../scripts/private_server/validation_mod')({ engine: { on: (name, fn) => { hooks[name] = fn; } } });
const hook = hooks.processObjectIntents;
assert.equal(typeof hook, 'function');
const tower = { _id: 'tower', room: 'W40N40', type: 'tower', store: { energy: 500 }, actionLog: {} };
const objects = { container: { type: 'container', x: 10, y: 10 }, source: { type: 'source', x: 11, y: 10 } };
const bulk = driverModule.exports('rooms.objects');
hook(tower, 'me', { repair: { id: 'container' } }, objects, null, 10, null, bulk);
assert.equal(tower.validationRepairs, undefined, 'a requested but failed repair is not evidence');
tower.actionLog.repair = { x: 10, y: 10 };
hook(tower, 'me', { repair: { id: 'container' } }, objects, null, 11, null, bulk);
assert.deepEqual(tower.validationRepairs, { n: 1, source: 1, peakBeforeRepair: 510, at: 11 });
assert.equal(tower.store.energy, 500, 'instrumentation does not grant energy');
hook(tower, 'me', { repair: { id: 'container' } }, objects, null, 12, null, bulk);
assert.equal(tower.validationRepairs.n, 2);
assert.equal(tower.validationRepairs.source, 2);
bulk.execute().then(() => {
    const write = written.find(op => op.op === 'update' && op.id === 'tower');
    assert(write && write.update.$set.validationRepairs, 'evidence must survive real driver serialization');
    assert.equal(write.update.$set.validationRepairs.n, 2);
    assert.equal(write.update.$set.validationRepairs.source, 2);
    console.log('private engine evidence: actual repair survives driver serialization, no resource mutation');
}).catch(error => { console.error(error); process.exitCode = 1; });
