'use strict';
/**
 * creep 动作管线守卫。
 *
 * 引擎在 tick 末尾按 @screeps/engine processor/intents/creeps/intents.js 的表结算：某个 intent 只要
 * 与它冲突的 intent 在同一 tick 也发了，它就被**整个丢弃**，与代码里的调用顺序无关
 * （docs/game/simultaneous-actions.md：「The sequence of calling commands for different methods in the
 * code is irrelevant, only the aforementioned priorities matter」）。
 *
 * 这张表是**有向**的，不是互斥集合：
 *   - heal 永远执行（不在表里），所以 range 1 的 heal 可以和 rangedAttack 同 tick，白拿；
 *   - rangedHeal 会顶掉 rangedAttack / rangedMassAttack —— 想边打边奶，range 1 用 heal，别用 rangedHeal；
 *   - heal / rangedHeal 还会顶掉 attack：近战奶自己那一 tick 是不出伤害的。
 *
 * 用法：发出动作后 note(creep, 'rangedAttack')，发下一个之前问 wouldVoid(creep, 'rangedHeal')
 * ——「现在发这个，会不会把已经发出去的顶掉」。
 */

// key = 该 intent，value = 只要其中任何一个也发了、key 就被丢弃
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

/** 记下本 tick 已经发出的动作 */
function note(creep, action) {
    const set = issuedSet(creep, true);
    if (set) set[action] = true;
    return action;
}

/** 本 tick 是否已经发过这个动作 */
function issued(creep, action) {
    const set = issuedSet(creep, false);
    return !!(set && set[action]);
}

/** 现在发 action，会不会把本 tick 已经发出的某个动作顶掉（返回被顶掉的那个，没有则 null） */
function wouldVoid(creep, action) {
    const set = issuedSet(creep, false);
    if (!set) return null;
    for (const other of Object.keys(set)) {
        const blockers = BLOCKED_BY[other];
        if (blockers && blockers.indexOf(action) >= 0) return other;
    }
    return null;
}

/** action 本身是否已经被本 tick 发出的动作挡住（发了也不会执行） */
function blocked(creep, action) {
    const blockers = BLOCKED_BY[action];
    if (!blockers) return null;
    const set = issuedSet(creep, false);
    if (!set) return null;
    for (const blocker of blockers) if (set[blocker]) return blocker;
    return null;
}

/** 因为会顶掉已发出的动作而主动放弃的次数（累计在 global 上，不进 Memory）：
 *  私服探针据此观察「守卫在开火的 tick 真的没发 rangedHeal」 */
function skipped(action) {
    runtime.skipped[action] = (runtime.skipped[action] || 0) + 1;
}

function stats() {
    return runtime.skipped;
}

/** 单测用：清掉本 tick 的记录 */
function reset() {
    runtime.tick = -1;
    runtime.byCreep = {};
    runtime.skipped = {};
}

module.exports = { BLOCKED_BY, note, issued, wouldVoid, blocked, skipped, stats, reset };
