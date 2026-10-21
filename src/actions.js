'use strict';

const BLOCKED_BY = {
    rangedHeal: ['heal'],
    attackController: ['rangedHeal', 'heal'],
    dismantle: ['attackController', 'rangedHeal', 'heal'],
    repair: ['dismantle', 'attackController', 'rangedHeal', 'heal'],
    build: ['repair', 'dismantle', 'attackController', 'rangedHeal', 'heal'],
    attack: ['build', 'repair', 'dismantle', 'attackController', 'rangedHeal', 'heal'],
    harvest: ['attack', 'build', 'repair', 'dismantle', 'attackController', 'rangedHeal', 'heal'],
    rangedMassAttack: ['build', 'repair', 'rangedHeal'],
    rangedAttack: ['rangedMassAttack', 'build', 'repair', 'rangedHeal'],
};

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__actionRuntime || (runtimeGlobal.__actionRuntime = { tick: -1, byCreep: {}, skipped: {} });
if (!runtime.skipped) runtime.skipped = {};

function table() {
    if (runtime.tick !== Game.time) { runtime.tick = Game.time; runtime.byCreep = {}; }
    return runtime.byCreep;
}

function issuedSet(creep, create) {
    const all = table();
    const name = creep && creep.name;
    if (!name) return null;
    if (!all[name] && create) all[name] = {};
    return all[name] || null;
}

function note(creep, action) {
    const set = issuedSet(creep, true);
    if (set) set[action] = true;
    return action;
}

function issued(creep, action) {
    const set = issuedSet(creep, false);
    return !!(set && set[action]);
}

function wouldVoid(creep, action) {
    const set = issuedSet(creep, false);
    if (!set) return null;
    for (const other of Object.keys(set)) {
        const blockers = BLOCKED_BY[other];
        if (blockers && blockers.indexOf(action) >= 0) return other;
    }
    return null;
}

function blocked(creep, action) {
    const blockers = BLOCKED_BY[action];
    if (!blockers) return null;
    const set = issuedSet(creep, false);
    if (!set) return null;
    for (const blocker of blockers) if (set[blocker]) return blocker;
    return null;
}

function skipped(action) {
    runtime.skipped[action] = (runtime.skipped[action] || 0) + 1;
}

function stats() {
    return runtime.skipped;
}

function reset() {
    runtime.tick = -1;
    runtime.byCreep = {};
    runtime.skipped = {};
}

module.exports = { BLOCKED_BY, note, issued, wouldVoid, blocked, skipped, stats, reset };
