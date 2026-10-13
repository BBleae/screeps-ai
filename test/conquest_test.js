'use strict';
/**
 * 攻占子系统单测（独立于 smoke.js，避免与其它 session 的 smoke WIP 纠缠）：
 * 覆盖 conquest.js 的指令校验/身体分档/阶段机/各阶段需求，以及 siegeDismantler / downgrader 角色的关键决策分支。
 * 运行：node test/conquest_test.js
 */
const path = require('path');
const Module = require('module');

// ---- 扁平模块名解析（同 grunt/dist 布局）；movement/retire 用桩替换 ----
const MODULE_MAP = {
    config: 'config.js', utils: 'utils.js', conquest: 'conquest.js', actions: 'actions.js', boost: 'boost.js',
    roles_siegeDismantler: 'roles/siegeDismantler.js', roles_siegeGuard: 'roles/siegeGuard.js', roles_downgrader: 'roles/downgrader.js',
};
const moveCalls = [];
const retireCalls = [];
const MOCK = {
    movement: { go: (creep, target, opts) => { moveCalls.push({ creep: creep.name, x: target.x, y: target.y, room: target.roomName, opts }); return 0; } },
    retire: { retireAtSpawn: (creep) => { retireCalls.push(creep.name); } },
};
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (request, ...rest) {
    if (MODULE_MAP[request]) return origResolve.call(this, path.join(__dirname, '..', 'src', MODULE_MAP[request]), ...rest);
    return origResolve.call(this, request, ...rest);
};
Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(MOCK, request)) return MOCK[request];
    return origLoad.call(this, request, parent, isMain);
};

// ---- Screeps 全局桩 ----
global.STRUCTURE_TOWER = 'tower';
global.STRUCTURE_SPAWN = 'spawn';
global.STRUCTURE_EXTENSION = 'extension';
global.FIND_STRUCTURES = 'find_structures';
global.FIND_MY_SPAWNS = 'find_my_spawns';
global.FIND_HOSTILE_CREEPS = 'find_hostile_creeps';
global.FIND_MY_CREEPS = 'find_my_creeps';
global.ATTACK = 'attack';
global.RANGED_ATTACK = 'ranged_attack';
global.HEAL = 'heal';
global.RESOURCE_ENERGY = 'energy';
global.TOWER_ENERGY_COST = 10;
global.ERR_NOT_IN_RANGE = -9;
global.RoomPosition = function (x, y, roomName) { this.x = x; this.y = y; this.roomName = roomName; };
global.Game = { creeps: {}, rooms: {}, time: 1000 };
global.Memory = {};

const conquest = require('conquest');
const siege = require('roles_siegeDismantler');
const guard = require('roles_siegeGuard');
const downgrader = require('roles_downgrader');

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } }
function reset() { Memory = {}; global.Memory = Memory; Game.creeps = {}; Game.rooms = {}; moveCalls.length = 0; retireCalls.length = 0; require('actions').reset(); }
let Memory = global.Memory;

// 构造一个敌方房视野
function enemyRoom(name, { towers = 0, spawns = 0, owner = 'enemy', my = false, safeMode = null } = {}) {
    const structs = [];
    for (let i = 0; i < towers; i++) structs.push({ structureType: 'tower', owner: { username: 'enemy' }, my: false });
    for (let i = 0; i < spawns; i++) structs.push({ structureType: 'spawn', owner: { username: 'enemy' }, my: false });
    return {
        name,
        controller: { my, owner: owner ? { username: owner } : undefined, safeMode, pos: new RoomPosition(30, 7, name) },
        find: (type) => (type === FIND_STRUCTURES ? structs : []),
    };
}
function myHome(name, cap, storeEnergy) {
    const h = { name, controller: { my: true }, energyCapacityAvailable: cap, find: () => [] };
    if (storeEnergy !== undefined) h.storage = { store: { energy: storeEnergy } };
    return h;
}

console.log('== conquest: 指令缺省时零影响 ==');
reset();
assert(conquest.directive() === null, '无 Memory.conquest 时 directive() 为 null');
assert(conquest.getDemands(myHome('W33S7', 1800)).length === 0, '无指令时 getDemands 返回空');
conquest.run(); // 不应抛
assert(true, 'run() 无指令不抛异常');

console.log('== conquest: 指令校验 ==');
reset();
Memory.conquest = { target: 'W31S4' };
assert(conquest.directive() === null, '缺 sponsors 的指令非法');
Memory.conquest = { target: 'W31S4', sponsors: [] };
assert(conquest.directive() === null, 'sponsors 为空非法');
Memory.conquest = { target: 'W31S4', sponsors: ['W33S7'] };
assert(conquest.directive() !== null, '合法指令被接受');

console.log('== conquest: 身体分档（预算/50 部件封顶）==');
reset();
assert(JSON.stringify(conquest.repeatBody(['work', 'move'], 1800)) ===
    JSON.stringify([...Array(12).fill('work'), ...Array(12).fill('move')]), '1800 预算 → 12 WORK + 12 MOVE');
assert(conquest.repeatBody(['claim', 'move'], 1300).filter((p) => p === 'claim').length === 2, '1300 预算 → 2 CLAIM');
assert(conquest.repeatBody(['work', 'move'], 99999).length === 50, '部件总数封顶 50');

console.log('== conquest: 阶段机（依目标房视野推进）==');
reset();
Memory.conquest = { target: 'W31S4', sponsors: ['W33S7'], dismantlers: 16 };
Game.rooms.W31S4 = enemyRoom('W31S4', { towers: 1, spawns: 1 });
conquest.run();
assert(Memory.conquest.phase === 'breach', '有塔/ spawn → breach');
Game.rooms.W31S4 = enemyRoom('W31S4', { towers: 0, spawns: 0 });
conquest.run();
assert(Memory.conquest.phase === 'downgrade', '塔+spawn 清光 → downgrade');
Game.rooms.W31S4 = enemyRoom('W31S4', { towers: 0, spawns: 0, owner: null });
conquest.run();
assert(Memory.conquest.phase === 'claim', '控制器无主 → claim');
// safeMode 观测（放在占领之前：占下来之后指令进终态，run() 不再碰它）
Game.rooms.W31S4 = enemyRoom('W31S4', { towers: 1, spawns: 1, safeMode: 5000 });
conquest.run();
assert(Memory.conquest.safeMode === 5000, 'run() 记录目标 safeMode 到期 tick');
Game.rooms.W31S4 = enemyRoom('W31S4', { my: true, owner: 'me' });
conquest.run();
assert(Memory.conquest.phase === 'done', '控制器归我 → done');

console.log('== conquest: 各阶段需求 ==');
reset();
Memory.conquest = { target: 'W31S4', sponsors: ['W33S7', 'W34S7'], staging: 'W31S5', dismantlers: 16, downgraders: 2, phase: 'breach' };
let d = conquest.getDemands(myHome('W33S7', 1800));
assert(d.length === 8, 'breach：16 dismantler / 2 母房 → 每房 8（得 ' + d.length + '）');
assert(d[0].role === 'siegeDismantler' && d[0].cls === 'conquest', '需求角色 siegeDismantler、档位 conquest');
assert(d[0].memory.staging === 'W31S5' && d[0].memory.squad === 16, 'memory 带 staging 与全组 squad');
assert(conquest.getDemands(myHome('W35S7', 700)).length === 0, '容量 < minCapacity(800) 的房不出兵');

console.log('== conquest: storageFloor 门控破防/护卫（保经济） ==');
// 有 storage 且低于底线(15000) → 不出破防；无 storage 的房不受 storageFloor 约束（由 minCapacity 兜底）
assert(conquest.getDemands(myHome('W33S7', 1800, 5000)).length === 0, 'storage 5000 < 15000 → 不出破防（保 reserver）');
assert(conquest.getDemands(myHome('W33S7', 1800, 20000)).length === 8, 'storage 20000 ≥ 15000 → 照常出破防');
assert(conquest.getDemands(myHome('W33S7', 1800)).length === 8, '无 storage 的房不受 storageFloor 约束');

console.log('== conquest: sponsors="all" 自动选所有够格己方房 ==');
{
    Memory.conquest = { target: 'W31S4', sponsors: 'all', staging: 'W31S5', dismantlers: 16, phase: 'breach' };
    Game.rooms = {
        W33S7: { name: 'W33S7', controller: { my: true }, energyCapacityAvailable: 1800, find: () => [{}] },
        W34S7: { name: 'W34S7', controller: { my: true }, energyCapacityAvailable: 1300, find: () => [{}] },
        W35S7: { name: 'W35S7', controller: { my: true }, energyCapacityAvailable: 1150, find: () => [{}] },
        W31S8: { name: 'W31S8', controller: { my: true }, energyCapacityAvailable: 350, find: () => [{}] }, // 太小，排除
        W31S4: { name: 'W31S4', controller: { my: false }, energyCapacityAvailable: 1800, find: () => [{}] }, // 目标房，排除
    };
    assert(conquest.directive() !== null, "sponsors='all' 合法");
    const d33 = conquest.getDemands(Game.rooms.W33S7);
    const d35 = conquest.getDemands(Game.rooms.W35S7);
    const d31 = conquest.getDemands(Game.rooms.W31S8);
    assert(d33.length === Math.ceil(16 / 3), "'all' 下 3 个够格房各分 16/3（得 " + d33.length + '）');
    assert(d35.length > 0, "W35S7(1150≥800) 参与");
    assert(d31.length === 0, 'W31S8(350<800) 不参与');
    Game.rooms = {};
}
// 恢复显式 sponsors 指令（上面的 'all' 块改过 Memory.conquest）
Memory.conquest = { target: 'W31S4', sponsors: ['W33S7', 'W34S7'], staging: 'W31S5', dismantlers: 16, downgraders: 1, phase: 'downgrade' };
const dgClose = conquest.getDemands(myHome('W33S7', 1800)); // W33S7 是离 W31S4 最近的 sponsor
const dgFar = conquest.getDemands(myHome('W34S7', 1300));
assert(dgClose.length === 1 && dgClose[0].role === 'downgrader', 'downgrade：只由最近 sponsor(W33S7) 出 1 downgrader');
assert(dgFar.every((x) => x.role !== 'downgrader'), 'downgrade：非最近 sponsor(W34S7) 不出 downgrader（避免多房抢控制器旁的格子对调）');
assert(dgClose[0].body.filter((p) => p === 'claim').length === 2, 'downgrader 默认身体 2 CLAIM（config 1300）');
// 大体型提速：downgraderBudget 放大 → 更多 CLAIM（attackController 每 1000t 一次、每次 −300×CLAIM，单只 CLAIM 数是唯一提速杠杆）
Memory.conquest.downgraderBudget = 4550;
const dgBig = conquest.getDemands(myHome('W33S7', 5000));
assert(dgBig[0].body.filter((p) => p === 'claim').length === 7, 'downgraderBudget 4550 → 7 CLAIM（1:1 满速）');
delete Memory.conquest.downgraderBudget;
Memory.conquest.phase = 'claim';
const dNear = conquest.getDemands(myHome('W33S7', 1800));
const dFar = conquest.getDemands(myHome('W34S7', 1300));
assert(dNear.length + dFar.length === 1, 'claim：只有离目标最近的 sponsor 出 claimer（避免重复）');
Memory.conquest.noClaim = true;
assert(conquest.getDemands(myHome('W33S7', 1800)).length === 0, 'claim + noClaim → 不孵 claimer（占领交给外部大脑 claim.queue）');
delete Memory.conquest.noClaim;
Memory.conquest.phase = 'done';
assert(conquest.getDemands(myHome('W33S7', 1800)).length === 0, 'done 阶段无需求');

console.log('== siegeDismantler: 目标优先级 塔 > spawn > extension ==');
reset();
Game.creeps = {};
function siegeCreep(roomObj, targetRoom, launched, squad) {
    const c = { name: 'sd1', room: roomObj, pos: { x: 25, y: 25,
        inRangeTo: () => false, findClosestByRange: (list) => list[0] },
        memory: { role: 'siegeDismantler', targetRoom, staging: 'W31S5', launched, squad },
        dismantle: (t) => { c._dismantled = t; return ERR_NOT_IN_RANGE; } };
    return c;
}
function roomWith(structs, safeMode) {
    return { name: 'W31S4', controller: { safeMode: safeMode || null }, find: () => structs };
}
const armedTower = { structureType: 'tower', owner: {}, my: false, store: { getUsedCapacity: () => 500 } };
const dryTower = { structureType: 'tower', owner: {}, my: false, store: { getUsedCapacity: () => 0 } };
{
    const room = roomWith([armedTower, { structureType: 'spawn', owner: {}, my: false }]);
    const c = siegeCreep(room, 'W31S4', true, 1); Game.rooms.W31S4 = room;
    siege.run(c);
    assert(c._dismantled && c._dismantled.structureType === 'tower', '有能量的塔优先拆（真威胁）');
}
{
    // 哑塔（0 能量）在场但先拆 spawn：掐断敌方 defender 补充，别浪费在打不了人的死塔上
    const room = roomWith([dryTower, { structureType: 'spawn', owner: {}, my: false }]);
    const c = siegeCreep(room, 'W31S4', true, 1); Game.rooms.W31S4 = room;
    siege.run(c);
    assert(c._dismantled && c._dismantled.structureType === 'spawn', '哑塔(0 能量)降到 spawn 之后 → 先拆 spawn');
}
{
    // 只剩哑塔和 extension 时才拆哑塔（先于 extension）
    const room = roomWith([dryTower, { structureType: 'extension', owner: {}, my: false }]);
    const c = siegeCreep(room, 'W31S4', true, 1); Game.rooms.W31S4 = room;
    siege.run(c);
    assert(c._dismantled && c._dismantled.structureType === 'tower', '无 spawn 时拆哑塔（先于 extension）');
}
{
    const room = roomWith([{ structureType: 'spawn', owner: {}, my: false }, { structureType: 'extension', owner: {}, my: false }]);
    const c = siegeCreep(room, 'W31S4', true, 1); Game.rooms.W31S4 = room;
    siege.run(c);
    assert(c._dismantled && c._dismantled.structureType === 'spawn', '无塔时拆 spawn（先于 extension）');
}
{
    // 共享集火：两座有能量的塔，所有拆迁打血最低的那座（确定性 → 全体集火）
    const t1 = { structureType: 'tower', owner: {}, my: false, hits: 3000, store: { getUsedCapacity: () => 500 } };
    const t2 = { structureType: 'tower', owner: {}, my: false, hits: 1200, store: { getUsedCapacity: () => 500 } };
    const room = roomWith([t1, t2]);
    const c = siegeCreep(room, 'W31S4', true, 1); Game.rooms.W31S4 = room;
    siege.run(c);
    assert(c._dismantled === t2, '共享集火：两座有能量的塔 → 打血最低的那座（1200 而非 3000）');
}

console.log('== siegeDismantler: 目标房开盾即撤回集结点 ==');
reset();
{
    const room = roomWith([], 8000);
    const c = siegeCreep(room, 'W31S4', true, 1); Game.rooms.W31S4 = room;
    siege.run(c);
    assert(c.memory.launched === false, '开盾后清 launched（准备重新集结）');
    assert(moveCalls.length && moveCalls[moveCalls.length - 1].room === 'W31S5', '开盾后向集结点 W31S5 撤退');
}

console.log('== siegeDismantler: 集结在面向目标的一侧 + 途中绕开目标房 ==');
reset();
global.FIND_EXIT_LEFT = 7; global.FIND_EXIT_RIGHT = 3; global.FIND_EXIT_TOP = 1; global.FIND_EXIT_BOTTOM = 5;
Game.map = { findExit: () => 7 }; // W30S4 → W31S4 是 LEFT（西侧）
{
    // 在集结房 W30S4、未发起、组未满：走向西侧集结位（x≈8），且 avoidRooms 含目标 + 指令 avoid
    const c = { name: 'sd9', room: { name: 'W30S4' },
        pos: { x: 40, y: 25, inRangeTo: () => false },
        memory: { role: 'siegeDismantler', targetRoom: 'W31S4', staging: 'W30S4', squad: 16, avoid: ['W32S4'] } };
    Game.creeps = { sd9: c }; // 组只有 1 只 < 16 → 等待
    siege.run(c);
    const mv = moveCalls[moveCalls.length - 1];
    assert(mv && mv.room === 'W30S4' && Math.abs(mv.x - 8) <= 2 && Math.abs(mv.y - 25) <= 2,
        '集结位在 W30S4 西侧锚点(8,25)周围各自的格子（散开防抢位），得 ' + (mv && mv.x + ',' + mv.y));
    assert(mv && mv.opts && mv.opts.avoidRooms && mv.opts.avoidRooms.has('W31S4') && mv.opts.avoidRooms.has('W32S4'),
        '去集结点绕开目标 W31S4 与指令 avoid 的 W32S4');
}
Game.map = undefined; Game.creeps = {};

console.log('== downgrader: 有主控制器 attackController；无主则退役 ==');
reset();
function downCreep(room, targetRoom) {
    const c = { name: 'dg1', room: { name: room, controller: null }, memory: { role: 'downgrader', targetRoom },
        pos: { inRangeTo: () => true }, attackController: (ctrl) => { c._attacked = ctrl; return 0; } };
    return c;
}
{
    const c = downCreep('W31S4', 'W31S4');
    c.room.controller = { owner: { username: 'enemy' }, my: false, safeMode: null, pos: {} };
    downgrader.run(c);
    assert(c._attacked, '相邻、有主、未开盾 → attackController');
}
{
    const c = downCreep('W31S4', 'W31S4');
    c.room.controller = { owner: { username: 'enemy' }, my: false, safeMode: 9000, pos: {} };
    downgrader.run(c);
    assert(!c._attacked, '开盾期间不空攻');
}
{
    const c = downCreep('W31S4', 'W31S4');
    c.room.controller = { owner: undefined, my: false, pos: {} };
    downgrader.run(c);
    assert(c.memory.retired && retireCalls.indexOf('dg1') >= 0, '控制器无主 → 标记退役并回收');
}

console.log('== conquest: 多目标（Memory.conquest 为数组，并行）==');
reset();
Memory.conquest = [
    { target: 'W31S4', sponsors: ['W33S7'], downgraders: 1, phase: 'downgrade', hostiles: 0 },
    { target: 'W32S4', sponsors: ['W33S7'], dismantlers: 4, guards: 2, staging: 'W32S5', phase: 'breach' },
];
assert(conquest.directives().length === 2, '数组含两个合法指令');
assert(conquest.directive().target === 'W31S4', 'directive() 返回第一个（向后兼容）');
Memory.conquest = [{ target: 'W31S4', sponsors: ['W33S7'] }, { target: 'W32S4' }];
assert(conquest.directives().length === 1, '缺 sponsors 的项被过滤（只剩 1）');

console.log('== conquest: getDemands 跨目标聚合 ==');
reset();
Memory.conquest = [
    { target: 'W31S4', sponsors: ['W33S7'], downgraders: 1, phase: 'downgrade', hostiles: 0 },
    { target: 'W32S4', sponsors: ['W33S7'], dismantlers: 4, guards: 2, staging: 'W32S5', phase: 'breach' },
];
const agg = conquest.getDemands(myHome('W33S7', 2200));
assert(agg.some((x) => x.role === 'downgrader' && x.memory.targetRoom === 'W31S4'), '含 W31S4 的 downgrader');
assert(agg.filter((x) => x.role === 'siegeDismantler' && x.memory.targetRoom === 'W32S4').length === 4, '含 W32S4 的 4 dismantler');
assert(agg.filter((x) => x.role === 'siegeGuard' && x.memory.targetRoom === 'W32S4').length === 2, '含 W32S4 的 2 guard');
assert(agg.every((x) => x.slot.indexOf('W31S4') >= 0 || x.slot.indexOf('W32S4') >= 0), '各需求 slot 带目标房名（跨目标不撞键）');

console.log('== conquest: breach 阶段护卫身体与同波 squad ==');
reset();
Memory.conquest = { target: 'W32S4', sponsors: ['W33S7'], staging: 'W32S5', dismantlers: 22, guards: 5, avoid: ['W31S4'], phase: 'breach' };
const bd = conquest.getDemands(myHome('W33S7', 2200));
const gd = bd.filter((x) => x.role === 'siegeGuard');
assert(gd.length === 5, 'breach：5 guard（单母房）');
assert(gd[0].body.filter((p) => p === 'ranged_attack').length === 4 && gd[0].body.filter((p) => p === 'heal').length === 4,
    'guard 身体 4 RANGED_ATTACK + 4 HEAL（预算 2200）');
assert(gd[0].memory.squad === 27, 'squad = dismantlers(22) + guards(5) = 27（同波集结）');
assert(gd[0].memory.staging === 'W32S5' && gd[0].memory.avoid && gd[0].memory.avoid.indexOf('W31S4') >= 0, 'guard 带 staging 与 avoid');

console.log('== conquest: 围降期护卫按 hostiles 门控 ==');
reset();
Memory.conquest = { target: 'W32S4', sponsors: ['W33S7'], staging: 'W32S5', dismantlers: 22, guards: 5, downgraders: 2, phase: 'downgrade', hostiles: 2 };
let dd = conquest.getDemands(myHome('W33S7', 2200));
assert(dd.filter((x) => x.role === 'downgrader').length === 2, '围降：2 downgrader');
assert(dd.filter((x) => x.role === 'siegeGuard').length === 5, '敌方战斗 creep 在场(hostiles=2) → 续派 5 guard');
Memory.conquest.hostiles = 0;
dd = conquest.getDemands(myHome('W33S7', 2200));
assert(dd.filter((x) => x.role === 'siegeGuard').length === 0, 'hostiles=0 → 不再派 guard（省兵）');

// ---- siegeGuard 角色决策 ----
function guardCreep(roomName, targetRoom, hostiles, myCreeps) {
    const room = {
        name: roomName,
        controller: { safeMode: null, pos: new RoomPosition(30, 7, roomName) },
        find: (type) => (type === FIND_HOSTILE_CREEPS ? hostiles : []),
    };
    const c = {
        name: 'g1', room,
        hits: 1000, hitsMax: 1000, body: [{ type: 'ranged_attack' }, { type: 'heal' }, { type: 'move' }],
        pos: {
            x: 25, y: 25,
            getRangeTo: (o) => (o && o._range !== undefined ? o._range : 3),
            inRangeTo: () => true,
            findClosestByRange: (list) => list[0],
            findInRange: (type) => (type === FIND_MY_CREEPS ? (myCreeps || []) : []),
        },
        memory: { role: 'siegeGuard', targetRoom, staging: 'W32S5', launched: true, squad: 1 },
        rangedAttack: (t) => { c._ra = t; return 0; },
        rangedMassAttack: () => { c._mass = true; return 0; },
        heal: (t) => { c._heal = t; return 0; },
        rangedHeal: (t) => { c._rheal = t; return 0; },
    };
    return c;
}

console.log('== siegeGuard: 集火优先带 HEAL 的 kiter > ranged > 忽略 worker ==');
reset();
{
    const worker = { _range: 1, body: [{ type: 'work' }, { type: 'carry' }, { type: 'move' }], hits: 1000, hitsMax: 1000 };
    const rangedK = { _range: 2, body: [{ type: 'ranged_attack' }, { type: 'ranged_attack' }, { type: 'move' }], hits: 1200, hitsMax: 1200 };
    const healK = { _range: 2, body: [{ type: 'ranged_attack' }, { type: 'heal' }, { type: 'move' }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [worker, rangedK, healK]);
    guard.run(c);
    assert(c._ra === healK, '集火带 HEAL 的 kiter（威胁分最高）');
}

console.log('== siegeGuard: 同 tick rangedAttack 输出 + heal 奶受伤友军 ==');
reset();
{
    const wounded = { hits: 400, hitsMax: 1000, _range: 1, body: [{ type: 'work' }] };
    const kiter = { _range: 2, body: [{ type: 'ranged_attack' }, { type: 'heal' }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [kiter], [wounded]);
    guard.run(c);
    assert(c._ra === kiter, 'rangedAttack 敌方 kiter');
    assert(c._heal === wounded, '同 tick heal 受伤友军（不同管线，可并行）');
}

console.log('== siegeGuard: 开过火的 tick 不发 rangedHeal（引擎会把 rangedAttack 整个丢掉）==');
reset();
{
    // 引擎表 rangedAttack: ['rangedMassAttack','build','repair','rangedHeal']，与调用顺序无关：
    // 同 tick 发了 rangedHeal，这一发 rangedAttack 就没了。破防时塔火 600/tick，队友几乎每 tick 带伤，
    // 旧写法等于整个护卫编队在最关键的那些 tick 里退化成纯奶妈。
    const far = { hits: 400, hitsMax: 1000, _range: 3, body: [{ type: 'work' }] };
    const kiter = { _range: 2, body: [{ type: 'ranged_attack' }, { type: 'heal' }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [kiter], [far]);
    guard.run(c);
    assert(c._ra === kiter, '照常开火');
    assert(c._rheal === undefined, '射程 2–3 的伤员这一 tick 不用 rangedHeal（否则那发 rangedAttack 会被丢弃）');
    assert(c._heal === undefined, '身边没有 range 1 的伤员，就这一 tick 不治');
}
reset();
{
    // 同时有远伤员和贴身伤员：开火后改治贴身那个（heal 永不被顶）
    const far = { hits: 100, hitsMax: 1000, _range: 3, body: [{ type: 'work' }] };
    const near = { hits: 900, hitsMax: 1000, _range: 1, body: [{ type: 'work' }] };
    const kiter = { _range: 2, body: [{ type: 'ranged_attack' }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [kiter], [far, near]);
    guard.run(c);
    assert(c._ra === kiter && c._rheal === undefined, '开火保住，不发 rangedHeal');
    assert(c._heal === near, '改治贴身的次优伤员');
}
reset();
{
    // 没开火的 tick：rangedHeal 照发（没有东西会被顶掉）
    const far = { hits: 400, hitsMax: 1000, _range: 3, body: [{ type: 'work' }] };
    const c = guardCreep('W32S4', 'W32S4', [], [far]);
    c.pos.inRangeTo = () => true;
    guard.run(c);
    assert(c._ra === undefined && c._rheal === far, '没有敌人可打时照常 rangedHeal 远处伤员');
}

console.log('== siegeGuard: 无敌人 → 贴控制器护住 downgrader ==');
reset();
{
    const c = guardCreep('W32S4', 'W32S4', []);
    c.pos.inRangeTo = () => false; // 不在控制器旁 → 移过去
    guard.run(c);
    const idleMv = moveCalls[moveCalls.length - 1];
    const cheb = idleMv ? Math.max(Math.abs(idleMv.x - 30), Math.abs(idleMv.y - 7)) : -1;
    assert(idleMv && idleMv.room === 'W32S4' && cheb === 2,
        '无敌人 → 待命在控制器(30,7)周围各自的格子、且避开相邻格(留给 downgrader)，得 ' + (idleMv && idleMv.x + ',' + idleMv.y));
}

console.log('== siegeGuard: 目标房开盾即撤回集结点 ==');
reset();
{
    const c = guardCreep('W32S4', 'W32S4', []);
    c.room.controller.safeMode = 5000;
    guard.run(c);
    assert(c.memory.launched === false, '开盾 → 清 launched（准备重新集结）');
    assert(moveCalls[moveCalls.length - 1].room === 'W32S5', '开盾 → 撤回集结点 W32S5');
}

console.log('== siegeGuard: 集结按 dismantler+guard 合计到齐才发起 ==');
reset();
global.FIND_EXIT_LEFT = 7; global.FIND_EXIT_RIGHT = 3; global.FIND_EXIT_TOP = 1; global.FIND_EXIT_BOTTOM = 5;
Game.map = { findExit: () => 7 }; // W32S5 → W32S4 = LEFT（西侧）
{
    const g = {
        name: 'g9', room: { name: 'W32S5' },
        hits: 1000, hitsMax: 1000, body: [{ type: 'ranged_attack' }, { type: 'heal' }, { type: 'move' }],
        pos: { x: 40, y: 25, inRangeTo: () => false, findInRange: () => [] },
        memory: { role: 'siegeGuard', targetRoom: 'W32S4', staging: 'W32S5', squad: 3 },
    };
    const sdA = { name: 'sdA', room: { name: 'W32S5' }, memory: { role: 'siegeDismantler', targetRoom: 'W32S4' } };
    Game.creeps = { g9: g, sdA: sdA }; // 合计 2 < squad 3 → 等待
    guard.run(g);
    const mv = moveCalls[moveCalls.length - 1];
    assert(mv && mv.room === 'W32S5' && Math.abs(mv.x - 8) <= 2 && Math.abs(mv.y - 25) <= 2,
        'guard 等在 W32S5 西侧锚点周围各自的格子（组未满等待），得 ' + (mv && mv.x + ',' + mv.y));
    assert(!g.memory.launched, '组未满不发起');
    const sdB = { name: 'sdB', room: { name: 'W32S5' }, memory: { role: 'siegeDismantler', targetRoom: 'W32S4' } };
    Game.creeps.sdB = sdB; // 合计 3 ≥ squad 3
    guard.run(g);
    assert(g.memory.launched === true, 'dismantler+guard 合计到齐(3) → 发起总攻');
}

console.log('== 攻占指令的终态：占下来之后不会因为房子易手自己重新开战 ==');
reset();
{
    const target = 'W32S4';
    Memory.conquest = [{ target, sponsors: ['W33S7'], dismantlers: 4, guards: 4 }];
    // 占下来：phase=done 并打上终态标记
    Game.rooms[target] = { name: target, controller: { my: true, level: 1, owner: { username: 'me' }, safeMode: null },
        find: () => [] };
    conquest.run();
    const d = Memory.conquest[0];
    assert(d.phase === 'done' && d.completed === true && typeof d.completedAt === 'number',
        '占下后写终态（得 ' + JSON.stringify(d) + '）');
    assert(conquest.getDemands({ name: 'W33S7', controller: { my: true } }).length === 0, '终态后不再出兵');
    // 房子易手：旧代码会把 phase 翻回 breach 并重新拉起整波
    Game.rooms[target] = { name: target, controller: { my: false, owner: { username: 'enemy' }, safeMode: null },
        find: () => [] };
    conquest.run();
    assert(Memory.conquest[0].phase === 'done', '房子易手后阶段仍是 done，不自动重新开战');
    assert(conquest.getDemands({ name: 'W33S7', controller: { my: true } }).length === 0, '易手后依然不出兵（要重打得由人重新下令）');
    delete Game.rooms[target];
}

console.log('== 集结点超时：波次已出发后到达的替补不再等到寿终 ==');
reset();
global.FIND_EXIT_LEFT = 7; global.FIND_EXIT_RIGHT = 3; global.FIND_EXIT_TOP = 1; global.FIND_EXIT_BOTTOM = 5;
Game.map = { findExit: () => 7 };
{
    // 集结判据是「集结点上的同伴数 ≥ squad」，而 squad 是整波编制数。第一波出发后全体都在目标房里，
    // 之后孵出来的替补到集结点只看见自己（1 < 3），旧代码会让它在自己的格子上一直等到寿命结束。
    const stageWait = require('config').conquest.stageWait;
    const lone = {
        name: 'late1', room: { name: 'W32S5' },
        hits: 1000, hitsMax: 1000, body: [{ type: 'ranged_attack' }, { type: 'heal' }, { type: 'move' }],
        pos: { x: 40, y: 25, inRangeTo: () => false, findInRange: () => [] },
        memory: { role: 'siegeGuard', targetRoom: 'W32S4', staging: 'W32S5', squad: 3 },
    };
    Game.creeps = { late1: lone };
    guard.run(lone);
    assert(lone.memory.stagedAt === Game.time, '第一次到集结点记下时间');
    assert(!lone.memory.launched, '刚到时照常等（可能同波的人还在路上）');
    Game.time += stageWait + 1;
    guard.run(lone);
    assert(lone.memory.launched === true, '等满 stageWait 后自己出发（得 ' + JSON.stringify(lone.memory) + '）');
    // 拆迁工同理
    const lateD = {
        name: 'late2', room: { name: 'W32S5' },
        hits: 1000, hitsMax: 1000, body: [{ type: 'work' }, { type: 'move' }],
        pos: { x: 40, y: 25, inRangeTo: () => false, findClosestByRange: () => null },
        memory: { role: 'siegeDismantler', targetRoom: 'W32S4', staging: 'W32S5', squad: 3 },
    };
    Game.creeps = { late2: lateD };
    siege.run(lateD);
    assert(!lateD.memory.launched && lateD.memory.stagedAt != null, '拆迁工刚到也照常等');
    Game.time += stageWait + 1;
    siege.run(lateD);
    assert(lateD.memory.launched === true, '拆迁工等满 stageWait 后也自己出发');
}
Game.map = undefined; Game.creeps = {};

console.log('== siegeDismantler: 破防完成无可拆结构 → 退役（不挂机） ==');
reset();
{
    const room = { name: 'W32S4', controller: { safeMode: null }, find: () => [] }; // 塔/spawn/ext 全拆光
    const c = {
        name: 'sdDone', room,
        pos: { x: 20, y: 20, inRangeTo: () => true, findClosestByRange: (l) => l[0] },
        memory: { role: 'siegeDismantler', targetRoom: 'W32S4', staging: 'W32S5', launched: true, squad: 1 },
        dismantle: () => 0,
    };
    Game.rooms.W32S4 = room;
    siege.run(c);
    assert(c.memory.retired === true && retireCalls.indexOf('sdDone') >= 0, '无可拆结构 → 标记退役并回收（修挂机）');
}

console.log('== siegeGuard: 打废攻击部件的残血敌人不再是威胁 ==');
reset();
{
    const defanged = { _range: 2, body: [{ type: 'ranged_attack', hits: 0 }, { type: 'move', hits: 100 }], hits: 200, hitsMax: 1200 };
    const live = { _range: 3, body: [{ type: 'ranged_attack', hits: 100 }, { type: 'move', hits: 100 }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [defanged, live]);
    guard.run(c);
    assert(c._ra === live, '集火还有活攻击部件的敌人，忽略已打废的（ranged 部件 hits=0）');
}

console.log('== siegeGuard: 保持距离/风筝（站桩输出、出射程才靠、不贴近战） ==');
reset();
{
    // range 3 纯 ranged 敌人、无近战 → 站桩输出，不主动前压到 range 1
    const kiter = { _range: 3, body: [{ type: 'ranged_attack', hits: 100 }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [kiter]);
    guard.run(c);
    assert(c._ra === kiter, 'range 3 ranged 敌人 → rangedAttack');
    assert(moveCalls.length === 0, 'range≤3 且无近战 → 站桩，不主动贴上去');
}
reset();
{
    // 目标在射程外(range 5)、无近战 → 靠到 range 3（不贴身）
    const kiter = { _range: 5, body: [{ type: 'ranged_attack', hits: 100 }], hits: 1200, hitsMax: 1200 };
    const c = guardCreep('W32S4', 'W32S4', [kiter]);
    guard.run(c);
    assert(!c._ra, 'range 5 出射程 → 不射');
    assert(moveCalls.length === 1 && moveCalls[0].opts && moveCalls[0].opts.range === 3, '出射程 → 靠到 range 3');
}
reset();
{
    // 活着的近战(ATTACK)单位在 3 格内 → 拉开风筝（朝反方向退），绝不贴上去挨近战
    const meleeE = { _range: 2, pos: { x: 20, y: 25 }, body: [{ type: 'attack', hits: 100 }], hits: 1000, hitsMax: 1000 };
    const c = guardCreep('W32S4', 'W32S4', [meleeE]); // guard 在 (25,25)，近战在西侧
    guard.run(c);
    assert(c._ra === meleeE, '射程内仍输出');
    const mv = moveCalls[moveCalls.length - 1];
    assert(mv && mv.x > 25, '近战贴近(≤3) → 朝反方向拉开（东退 x>25）');
}

console.log('== siegeGuard: 无可攻击敌人 → heal 优先，不追无害敌人 ==');
reset();
{
    const harmless = { _range: 5, body: [{ type: 'work', hits: 100 }, { type: 'carry', hits: 100 }], hits: 500, hitsMax: 1000 };
    const wounded = { hits: 300, hitsMax: 1000, _range: 1, body: [{ type: 'work' }] };
    const c = guardCreep('W32S4', 'W32S4', [harmless], [wounded]);
    c.pos.inRangeTo = () => true;
    guard.run(c);
    assert(c._heal === wounded, '无威胁 → 治疗受伤友军（heal 优先）');
    assert(moveCalls.length === 0, '不移动追击无害敌人（5 格外的 worker）');
}

console.log('== conquest: holdTile 散开(防抢位) / laneTile 进场泳道(并行过境) ==');
{
    const anchor = new RoomPosition(25, 8, 'W32S5');
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => 'creep-' + n);
    const holds = new Set(names.map((n) => { const p = conquest.holdTile(anchor, n, 0); return p.x + ',' + p.y; }));
    assert(holds.size >= 4, '8 只 creep 的 holdTile 散到多个不同格子（得 ' + holds.size + ' 个，避免全挤锚点被交通解算对调）');
    const one = conquest.holdTile(anchor, 'creep-a', 0);
    assert(one.roomName === 'W32S5' && Math.abs(one.x - 25) <= 2 && Math.abs(one.y - 8) <= 2, 'holdTile 落在锚点 ±2 内');
    const far = conquest.holdTile(anchor, 'creep-a', 2);
    assert(Math.max(Math.abs(far.x - 25), Math.abs(far.y - 8)) >= 2, 'minRange=2 → 避开锚点相邻格（留给 downgrader 独占）');
    const lanes = new Set(names.map((n) => { const p = conquest.laneTile(anchor, n, 10, true); return p.x + ',' + p.y; }));
    assert(lanes.size >= 4, '8 只 creep 的进场泳道散到多条（得 ' + lanes.size + ' 条，并行过境不排长蛇）');
    const lane = conquest.laneTile(anchor, 'creep-a', 10, true);
    assert(lane.y === 8 && Math.abs(lane.x - 25) <= 10, '沿 x 轴散开时 y 不变、横向不超过 halfWidth');
}

console.log('== siegeDismantler: 房内聚合默认关闭(在塔火下干等=白送)，旋钮打开才生效 ==');
reset();
{
    const cfgMod = require('config');
    const room = roomWith([{ structureType: 'tower', owner: {}, my: false, hits: 3000, store: { getUsedCapacity: () => 500 } }]);
    Game.rooms.W31S4 = room;
    const c = siegeCreep(room, 'W31S4', true, 10);
    siege.run(c);
    assert(c._dismantled && c._dismantled.structureType === 'tower', 'reformShare=0(默认) → 进房直接推进拆塔，不在塔火下等聚合');
    const saved = cfgMod.conquest.reformShare;
    cfgMod.conquest.reformShare = 0.7;
    const c2 = siegeCreep(room, 'W31S4', true, 10);
    siege.run(c2);
    assert(!c2._dismantled, 'reformShare=0.7(打开) → 未到齐时先聚合、不推进');
    cfgMod.conquest.reformShare = saved;
}

console.log('== conquest: suppress 无主走 deny，不 completed；对方再占回到 breach ==');
reset();
{
    Memory.conquest = { target: 'W38S9', sponsors: ['W35S7'], suppress: true, downgraders: 1, noClaim: true };
    Game.rooms.W38S9 = enemyRoom('W38S9', { towers: 0, spawns: 0, owner: null });
    conquest.run();
    assert(Memory.conquest.phase === 'deny' && !Memory.conquest.completed,
        'suppress + 无主 → deny 且不 completed（得 ' + JSON.stringify({ phase: Memory.conquest.phase, completed: Memory.conquest.completed }) + '）');
    const denyDemands = conquest.getDemands(myHome('W35S7', 1300));
    assert(denyDemands.some((item) => item.role === 'downgrader' && item.memory.suppress),
        'deny：最近 sponsor 出 suppress downgrader（得 ' + JSON.stringify(denyDemands.map((item) => [item.role, item.memory && item.memory.suppress])) + '）');
    Game.rooms.W38S9 = enemyRoom('W38S9', { towers: 0, spawns: 1, owner: 'Celr' });
    conquest.run();
    assert(Memory.conquest.phase === 'downgrade', 'suppress 无塔即使有 spawn 也围降，不翻 breach（得 ' + Memory.conquest.phase + '）');
    Game.rooms.W38S9 = enemyRoom('W38S9', { towers: 1, spawns: 1, owner: 'Celr' });
    conquest.run();
    assert(Memory.conquest.phase === 'breach', 'suppress 有塔 → breach（得 ' + Memory.conquest.phase + '）');
}

console.log('== conquest: 指令 storageFloor=0 覆盖默认底线 ==');
reset();
{
    Memory.conquest = { target: 'W39S8', sponsors: ['W35S7'], dismantlers: 4, phase: 'breach', storageFloor: 0 };
    const low = conquest.getDemands(myHome('W35S7', 1300, 5000));
    assert(low.some((item) => item.role === 'siegeDismantler'),
        'storageFloor:0 时 storage 5000 仍出破防（得 ' + low.length + '）');
}

console.log('== downgrader: suppress 拆预定，无主无预定则留下不退役 ==');
reset();
{
    const c = downCreep('W38S7', 'W38S7');
    c.memory.suppress = true;
    c.room.controller = { owner: undefined, my: false, reservation: { username: 'Celr', ticksToEnd: 2000 }, pos: {} };
    downgrader.run(c);
    assert(c._attacked && !c.memory.retired, 'suppress + 敌方预定 → attackController（得 ' + JSON.stringify({ attacked: !!c._attacked, retired: c.memory.retired }) + '）');
}
{
    const c = downCreep('W38S7', 'W38S7');
    c.memory.suppress = true;
    c.room.controller = { owner: undefined, my: false, pos: {} };
    downgrader.run(c);
    assert(!c.memory.retired && !c._attacked, 'suppress + 无主无预定 → 留下堵门，不退役');
}

console.log('== Overmind dangerousPlayerHostiles：纯 CLAIM 对 DEFCON/safe mode/外矿防御隐形 ==');
{
    // Overmind Room.prototype.dangerousPlayerHostiles：ATTACK/WORK/RANGED_ATTACK/HEAL 才算。
    // 0.5.2 Overseer.handleSafeMode / handleOutpostDefense 都读这个列表。
    function overmindDangerous(body) {
        return body.some((part) => part === 'attack' || part === 'work' || part === 'ranged_attack' || part === 'heal');
    }
    assert(!overmindDangerous(['claim', 'move', 'claim', 'move']), '2C2M downgrader 对 Overmind 隐形');
    assert(!overmindDangerous(['tough', 'tough', 'claim', 'move']), 'TOUGH+CLAIM 也对 Overmind 隐形（塔仍会打）');
    assert(overmindDangerous(['work', 'move']), 'WORK 矿工/拆迁对 Overmind 可见，会触发 SM 和外矿防御');
    assert(overmindDangerous(['ranged_attack', 'heal', 'move', 'move']), '护卫对 Overmind 可见');
}

console.log('== siegeGuard: suppress 追打无攻工人 ==');
reset();
{
    const worker = {
        name: 'miner', hits: 1000, hitsMax: 1000, x: 20, y: 20, roomName: 'W38S8',
        body: [{ type: 'work', hits: 100 }, { type: 'move', hits: 100 }],
        pos: { x: 20, y: 20, roomName: 'W38S8' },
        getActiveBodyparts: (part) => (part === 'work' ? 1 : part === 'move' ? 1 : 0),
    };
    const room = {
        name: 'W38S8',
        controller: { my: false, safeMode: null, pos: new RoomPosition(25, 25, 'W38S8') },
        find: (type) => (type === FIND_HOSTILE_CREEPS ? [worker] : type === FIND_MY_CREEPS ? [] : []),
    };
    const c = {
        name: 'sg-sup', room, pos: { x: 10, y: 10, getRangeTo: () => 8, inRangeTo: () => false },
        memory: { role: 'siegeGuard', targetRoom: 'W38S8', suppress: true, squad: 1, launched: true },
        body: [{ type: 'ranged_attack' }, { type: 'heal' }, { type: 'move' }, { type: 'move' }],
        rangedAttack: (t) => { c._shot = t; return 0; },
        heal: () => 0,
        rangedHeal: () => 0,
    };
    Game.rooms.W38S8 = room;
    Game.creeps = { 'sg-sup': c };
    worker.pos.getRangeTo = () => 8;
    c.pos.getRangeTo = (t) => (t === worker || (t && t.name === 'miner') ? 8 : 8);
    c.pos.findClosestByRange = (list) => (list && list[0]) || worker;
    c.pos.findInRange = () => [];
    guard.run(c);
    assert(moveCalls.length && moveCalls[moveCalls.length - 1].x === 20,
        'suppress：没有战斗 creep 时仍追工人（得 ' + JSON.stringify(moveCalls[moveCalls.length - 1]) + '）');
}

// ---- 过境避塔：costCallback + 敌塔位缓存 ----
function costMatrix() {
    const data = {};
    return { get: (x, y) => data[x + ',' + y] || 0, set: (x, y, v) => { data[x + ',' + y] = v; } };
}
function towerRoom(name, tx, ty) {
    return {
        name,
        controller: { my: false, owner: { username: 'enemy' } },
        find: (type) => (type === FIND_STRUCTURES
            ? [{ structureType: 'tower', owner: { username: 'enemy' }, my: false, pos: { x: tx, y: ty } }] : []),
    };
}

console.log('== conquest: 过境避塔 costCallback ==');
reset();
Game.rooms = { W38S6: towerRoom('W38S6', 22, 29), W38S5: towerRoom('W38S5', 9, 36) };
const cb = conquest.towerAvoidCallback('W38S5');   // 目标 W38S5，过境 W38S6
const cmTransit = costMatrix();
cb('W38S6', cmTransit);
assert(cmTransit.get(22, 29) > cmTransit.get(24, 29) && cmTransit.get(24, 29) > 0, '过境房：越靠近塔成本越高');
assert(cmTransit.get(22, 39) === 0 && cmTransit.get(5, 5) === 0, '过境房：塔 8 格外不加成本');
const cmTarget = costMatrix();
cb('W38S5', cmTarget);
assert(cmTarget.get(9, 36) === 0 && cmTarget.get(10, 36) === 0, '目标房：不给塔加成本（要贴塔拆掉）');
const cmWall = costMatrix();
cmWall.set(22, 29, 255);
cb('W38S6', cmWall);
assert(cmWall.get(22, 29) === 255, '墙/不可走格（255）保持不变');
// 指令声明的塔位（extraTowers）：无视野、无缓存时也能绕（首次寻路即避塔的关键）
reset();
Game.rooms = {};   // 完全无视野
const cbDecl = conquest.towerAvoidCallback('W38S5', { W38S6: [[22, 29]] });
const cmDecl = costMatrix();
cbDecl('W38S6', cmDecl);
assert(cmDecl.get(22, 29) > 0 && cmDecl.get(22, 39) === 0, '指令声明的过境塔位：无视野也加成本、8 格外不加');
const known2 = conquest.knownHostileTowers('W38S6', { W38S6: [[22, 29]] });
assert(known2.length === 1 && known2[0].x === 22, '无视野时 knownHostileTowers 采用指令声明的塔位');

console.log('== conquest: 敌塔位缓存（视野∪缓存）==');
reset();
Game.time = 2000;
Game.rooms = { W38S6: towerRoom('W38S6', 22, 29) };
conquest.recordHostileTowers(Game.rooms.W38S6);
assert(Memory.siegeTowers && Memory.siegeTowers.W38S6 && Memory.siegeTowers.W38S6.pos[0][0] === 22
    && Memory.siegeTowers.W38S6.pos[0][1] === 29, 'recordHostileTowers 把敌塔位写入 Memory.siegeTowers');
delete Game.rooms.W38S6;   // 失去视野
const known = conquest.knownHostileTowers('W38S6');
assert(known.length === 1 && known[0].x === 22 && known[0].y === 29, '无视野时 knownHostileTowers 退回缓存');
Game.time = 2001;
Game.rooms.W38S6 = { name: 'W38S6', controller: { my: false }, find: () => [] };   // 有视野、无塔
conquest.recordHostileTowers(Game.rooms.W38S6);
assert(!Memory.siegeTowers.W38S6, '有视野且无敌塔 → 清掉旧缓存');
Game.time = 1000;

console.log('== boost（2026-10-13，移植 overmind-absorb 79a5ee4/6dd5cbb）：攻城 creep 出发前在母房 lab 旁强化，默认关闭 ==');
reset();
global.STRUCTURE_LAB = 'lab';
global.FIND_MY_STRUCTURES = 'find_my_structures';
global.OK = 0;
global.ERR_RCL_NOT_ENOUGH = -14;
global.BOOSTS = { work: { XZH2O: { dismantle: 4 } }, heal: { XLHO2: { heal: 4, rangedHeal: 4 } } };
{
    const cfg = require('config').conquest;
    // 需求接线：默认 config 空 ⇒ 攻城 creep 的 memory 里没有 boosts（行为与移植前完全一致）
    assert(Array.isArray(cfg.boosts.dismantler) && cfg.boosts.dismantler.length === 0 && cfg.boosts.guard.length === 0, 'config.conquest.boosts 默认空 = 关闭');
    Memory.conquest = { target: 'W31S4', sponsors: ['W33S7'], dismantlers: 1, guards: 1, phase: 'breach' };
    Game.rooms.W31S4 = enemyRoom('W31S4', { towers: 1, spawns: 1 });
    let ds = conquest.getDemands(myHome('W33S7', 2300, 50000));
    assert(ds.length === 2 && ds.every((d) => d.memory.boosts === undefined), '默认关闭：破防/护卫需求都不带 boosts');
    // 打开 config：两类攻城角色各带自己的清单，围降者不带
    const saved = cfg.boosts;
    cfg.boosts = { dismantler: ['XZH2O'], guard: ['XLHO2'] };
    ds = conquest.getDemands(myHome('W33S7', 2300, 50000));
    const dm = ds.find((d) => d.role === 'siegeDismantler');
    const gd = ds.find((d) => d.role === 'siegeGuard');
    assert(dm && JSON.stringify(dm.memory.boosts) === '["XZH2O"]' && gd && JSON.stringify(gd.memory.boosts) === '["XLHO2"]', 'config 打开 ⇒ dismantler/guard 各带各的化合物');
    assert(dm.memory.boosts !== cfg.boosts.dismantler, '写进 memory 的是副本（creep 改不到 config）');
    // 指令 boosts 整份覆盖 config（部署会把 config 重置回默认，所以打仗时写在指令里）
    Memory.conquest.boosts = { dismantler: ['XZH2O'] };
    ds = conquest.getDemands(myHome('W33S7', 2300, 50000));
    assert(ds.find((d) => d.role === 'siegeDismantler').memory.boosts[0] === 'XZH2O' && ds.find((d) => d.role === 'siegeGuard').memory.boosts === undefined,
        '指令 boosts 覆盖 config：没写 guard ⇒ 护卫不强化');
    cfg.boosts = saved;
    Memory.conquest.boosts = { guard: ['XLHO2'] };
    ds = conquest.getDemands(myHome('W33S7', 2300, 50000));
    assert(ds.find((d) => d.role === 'siegeGuard').memory.boosts[0] === 'XLHO2', 'config 关着时指令也能单独打开');
    assert(conquest.boostsFor('downgrader', Memory.conquest).length === 0, '围降者不在 boost 范围内');
}
// 母房里的 siegeDismantler：有装着 XZH2O + 能量的 lab ⇒ 先强化，不去集结点
function boostLab(store, id) {
    const lab = { id: id || 'lab1', structureType: 'lab', store, boosted: [], ret: OK };
    lab.boostCreep = (creep) => {
        lab.boosted.push(creep.name);
        if (lab.ret === OK) creep.body.forEach((p) => { if (p.type === 'work' && !p.boost) p.boost = 'XZH2O'; });
        return lab.ret;
    };
    return lab;
}
function homeWithLabs(labs) {
    return { name: 'W33S7', controller: { my: true }, find: (type) => (type === FIND_MY_STRUCTURES ? labs : []) };
}
function boostSiege(room, extra) {
    return {
        name: 'bs1', room, body: [{ type: 'work' }, { type: 'work' }, { type: 'move' }, { type: 'move' }],
        hits: 400, hitsMax: 400,
        pos: { x: 25, y: 25, inRangeTo: () => false, findClosestByRange: () => null, findInRange: () => [] },
        memory: Object.assign({ role: 'siegeDismantler', home: 'W33S7', targetRoom: 'W31S4', staging: 'W31S5', squad: 1, boosts: ['XZH2O'] }, extra || {}),
        dismantle: () => 0,
    };
}
{
    reset();
    Game.time = 1000;
    const lab = boostLab({ energy: 2000, XZH2O: 600 });
    const room = homeWithLabs([lab]);
    Game.rooms.W33S7 = room;
    const c = boostSiege(room);
    Game.creeps = { bs1: c };
    lab.ret = ERR_NOT_IN_RANGE;
    siege.run(c);
    assert(moveCalls.length === 1 && moveCalls[0].x === undefined && lab.boosted.length === 1, '不相邻 ⇒ 走向 lab（不去集结点/目标房）');
    assert(c.memory.boostSince === 1000, '第一次 pending 记下开始时间');
    moveCalls.length = 0;
    lab.ret = OK;
    Game.time = 1005;
    siege.run(c);
    assert(moveCalls.length === 0 && c.body.filter((p) => p.boost === 'XZH2O').length === 2, '相邻 ⇒ boostCreep 成功、本 tick 原地');
    assert(Memory.rooms && Memory.rooms.W33S7 && Memory.rooms.W33S7.boostLog && Memory.rooms.W33S7.boostLog[0].compound === 'XZH2O'
        && Memory.rooms.W33S7.boostLog[0].part === 'work' && Memory.rooms.W33S7.boostLog[0].parts === 2, '成功的强化记进母房 boostLog（化合物/部件/个数）');
    Game.time = 1006;
    siege.run(c);
    assert(lab.boosted.length === 2 && moveCalls.length === 1 && moveCalls[0].room === 'W31S4', '强化完 ⇒ 照常出发（squad 1 直奔目标房）');
}
{
    // 默认关闭：creep 没带 boosts ⇒ 一眼都不看 lab
    reset();
    const lab = boostLab({ energy: 2000, XZH2O: 600 });
    const room = homeWithLabs([lab]);
    Game.rooms.W33S7 = room;
    const c = boostSiege(room, { boosts: undefined });
    Game.creeps = { bs1: c };
    siege.run(c);
    assert(lab.boosted.length === 0 && moveCalls.length === 1 && moveCalls[0].room === 'W31S4', '没带 boosts 的攻城 creep 行为不变');
}
{
    // 货/能量不够、lab 报错、等太久：都不把 creep 留在家里
    reset();
    const lab = boostLab({ energy: 2000, XZH2O: 30 });   // 2 个 WORK 要 60
    const room = homeWithLabs([lab]);
    Game.rooms.W33S7 = room;
    const c = boostSiege(room);
    Game.creeps = { bs1: c };
    siege.run(c);
    assert(lab.boosted.length === 0 && moveCalls.length === 1, '化合物不够 ⇒ 跳过，直接出发');
    moveCalls.length = 0;
    lab.store.XZH2O = 600; lab.store.energy = 10;
    siege.run(c);
    assert(lab.boosted.length === 0 && moveCalls.length === 1, 'lab 能量不够 ⇒ 也跳过');
    moveCalls.length = 0;
    lab.store.energy = 2000;
    lab.ret = ERR_RCL_NOT_ENOUGH;   // lab 未激活
    siege.run(c);
    assert(lab.boosted.length === 1 && c.memory.boostSkip && c.memory.boostSkip[0] === 'XZH2O', 'boostCreep 报错 ⇒ 这项记进 boostSkip');
    moveCalls.length = 0;
    siege.run(c);
    assert(lab.boosted.length === 1 && moveCalls.length === 1, '记过 boostSkip 的项不再重试，creep 出发');
    // 等满 boostMaxWait（例如交通堵在 lab 前）：整份清单放弃
    const c2 = boostSiege(room, { boostSince: Game.time - require('config').conquest.boostMaxWait });
    c2.name = 'bs2';
    Game.creeps = { bs2: c2 };
    lab.ret = ERR_NOT_IN_RANGE;
    moveCalls.length = 0;
    siege.run(c2);
    assert(c2.memory.boostDone === true && moveCalls.length === 1 && moveCalls[0].room === 'W31S4', '等满 boostMaxWait ⇒ boostDone，直接出发');
    // 不在母房（途经别的己方房）：不绕去它的 lab
    const other = { name: 'W32S5', controller: { my: true }, find: (type) => (type === FIND_MY_STRUCTURES ? [lab] : []) };
    const c3 = boostSiege(other);
    c3.name = 'bs3';
    Game.creeps = { bs3: c3 };
    lab.boosted.length = 0;
    siege.run(c3);
    assert(lab.boosted.length === 0, '只在 memory.home 那个房强化');
}
{
    // siegeGuard 同一钩子：HEAL 部件吃 XLHO2
    reset();
    const lab = { id: 'lg', structureType: 'lab', store: { energy: 2000, XLHO2: 600 }, boosted: 0,
        boostCreep: (creep) => { lab.boosted++; creep.body.forEach((p) => { if (p.type === 'heal') p.boost = 'XLHO2'; }); return OK; } };
    const room = homeWithLabs([lab]);
    Game.rooms.W33S7 = room;
    const g = {
        name: 'bg1', room, hits: 1000, hitsMax: 1000,
        body: [{ type: 'ranged_attack' }, { type: 'heal' }, { type: 'move' }, { type: 'move' }],
        pos: { x: 25, y: 25, inRangeTo: () => false, findInRange: () => [] },
        memory: { role: 'siegeGuard', home: 'W33S7', targetRoom: 'W31S4', staging: 'W31S5', squad: 1, boosts: ['XLHO2'] },
    };
    Game.creeps = { bg1: g };
    guard.run(g);
    assert(lab.boosted === 1 && moveCalls.length === 0 && g.body[1].boost === 'XLHO2', 'siegeGuard 出发前也先强化 HEAL');
    guard.run(g);
    assert(lab.boosted === 1 && moveCalls.length === 1, 'siegeGuard 强化完照常出发');
}
delete global.BOOSTS;
Game.time = 1000;

console.log(failures ? `\nFAILED: ${failures} 断言未通过` : '\n全部通过');
process.exit(failures ? 1 : 0);
