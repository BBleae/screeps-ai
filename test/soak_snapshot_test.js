'use strict';
const assert = require('assert');
const {objectDocument} = require('../scripts/soak/soak');
const doc = objectDocument('W33S7', {type:'link',x:16,y:8,hits:875,store:{energy:631},cooldown:2}, 'private-user', 1);
assert(doc, 'snapshot links must not disappear');
assert.equal(doc.user, 'private-user');
assert.equal(doc.store.energy,631);
assert.equal(doc.storeCapacityResource.energy,800);
assert.equal(doc.cooldown,2);
assert.equal(doc.hits,875);
assert.equal(doc.x,16);
assert.equal(doc.y,8);
assert.equal(objectDocument('W33S7',{type:'link',x:1,y:2},'u',1).store.energy,0);
console.log('soak_snapshot_test ok');

const {snapshotReservation} = require('../scripts/soak/soak');
assert.deepEqual(snapshotReservation({reservation:{user:'live',endTime:1210}}, {me:'live',tick:1000}, 'private', 5), {user:'private',endTime:215});
assert.equal(snapshotReservation({reservation:{user:'live',endTime:999}}, {me:'live',tick:1000}, 'private', 5),null);
assert.equal(snapshotReservation({reservation:{user:'foreign',endTime:1210}}, {me:'live',tick:1000}, 'private', 5),null);
