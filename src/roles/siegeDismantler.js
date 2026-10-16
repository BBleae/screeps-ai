'use strict';
/**
 * 攻占破防单位（siegeDismantler）：母房 → 集结点（房外中立房）成组 → 一起进目标房 → 拆塔（塔全灭后拆 spawn，
 * 再拆 extension 阻断重建）。无 boost 时治疗顶不住塔火，破防靠数量压制 + 爆发拆卸（拆卸 50/WORK）。
 *   - 成组：在集结点等同组全员到齐再一起推进（复用 defender 的 squad/launched 思路）。
 *   - 目标房开 safe mode：立即撤回集结点，不把队伍喂给塔（引擎里开盾期间无法伤害任何结构）。
 *   - 目标由 conquest 模块的指令给出（memory.targetRoom / staging / squad）。
 */
const movement = require('movement');
const retire = require('retire');
const conquest = require('conquest');
const boost = require('boost');

/** 同目标、未孵化中的同波攻城单位（siegeDismantler + siegeGuard，含自己）。squad 阈值含护卫，故两类都要计入。 */
function squadMates(creep) {
    const out = [];
    for (const name in Game.creeps) {
        const other = Game.creeps[name];
        if (!other.memory) continue;
        const role = other.memory.role;
        if (role !== 'siegeDismantler' && role !== 'siegeGuard') continue;
        if (other.memory.targetRoom !== creep.memory.targetRoom) continue;
        if (other.spawning) continue;
        out.push(other);
    }
    return out;
}

/** 房里敌方（有主、非我方）的某类结构 */
function hostileStructures(room, type) {
    return room.find(FIND_STRUCTURES).filter((s) => s.structureType === type && s.owner && !s.my);
}

/** 塔当前能量：有能量的塔才是真威胁；能量为 0 的哑塔打不了人，拆它不如先掐 spawn */
function towerEnergy(t) {
    if (t.store && typeof t.store.getUsedCapacity === 'function') return t.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (typeof t.energy === 'number') return t.energy;
    return 0;
}
const TOWER_MIN_FIRE = (typeof TOWER_ENERGY_COST !== 'undefined') ? TOWER_ENERGY_COST : 10;

/** 集结位：staging 房里面向 target 的那一侧、往里缩 STAGE_OFFSET 格（不踩边缘 → 未发起不会被引擎弹进 target） */
const STAGE_OFFSET = 8;
function stagePos(staging, target) {
    const map = (typeof Game !== 'undefined' && Game.map && Game.map.findExit) ? Game.map : null;
    const dir = map ? map.findExit(staging, target) : null;
    const o = STAGE_OFFSET;
    const L = typeof FIND_EXIT_LEFT === 'undefined' ? 7 : FIND_EXIT_LEFT;
    const R = typeof FIND_EXIT_RIGHT === 'undefined' ? 3 : FIND_EXIT_RIGHT;
    const T = typeof FIND_EXIT_TOP === 'undefined' ? 1 : FIND_EXIT_TOP;
    const B = typeof FIND_EXIT_BOTTOM === 'undefined' ? 5 : FIND_EXIT_BOTTOM;
    if (dir === L) return new RoomPosition(o, 25, staging);
    if (dir === R) return new RoomPosition(49 - o, 25, staging);
    if (dir === T) return new RoomPosition(25, o, staging);
    if (dir === B) return new RoomPosition(25, 49 - o, staging);
    return new RoomPosition(25, 25, staging);
}

/** 去集结点时要绕开的敌方房（含目标）：未发起绝不穿目标房（否则被塔白打）；发起后目的地是目标，不再绕 */
function avoidSet(creep, target) {
    const set = new Set([target]);
    const extra = creep.memory.avoid;
    if (Array.isArray(extra)) for (const r of extra) set.add(r);
    return set;
}

function run(creep) {
    const target = creep.memory.targetRoom;
    if (!target) return;
    // 过境避塔：把当前房看到的敌塔位缓存下来，供本波后续 creep 无视野时也能绕塔寻路（并记过境最近距离遥测）
    conquest.recordHostileTowers(creep.room, creep);
    // 破防完成、房里没可拆结构了：退役回收（走到最近 spawn recycle，退回部分能量），不占编制不挂机
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
    // 10-17 strongholdLoot：撤退态（拆墙队总血量 < 一半）→ 全员回集结点/母房，不再拆墙
    if (creep.memory.strongholdLoot && conquest.retreatFor(target)) {
        const back = creep.memory.staging || creep.memory.home || target;
        if (creep.room.name !== back) movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 15 });
        return;
    }
    const staging = creep.memory.staging || target;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);

    if (creep.room.name !== target) {
        // 出发前先强化（src/boost.js，config.conquest.boosts 默认空 = 关闭）：只在母房做，做不到的项跳过、等满 boostMaxWait 放弃，绝不让整队卡在家里
        if (boost.run(creep)) return;
        const avoid = avoidSet(creep, target);
        // 10-17 硬规则：conquest.boosts 未在全队每只身上装齐前，留在母房等待（含本只已装好的也等队友），不去集结点
        if (creep.memory.strongholdLoot && conquest.boostGateHold(target)) {
            if (creep.room.name !== (creep.memory.home || target)) movement.go(creep, new RoomPosition(25, 25, creep.memory.home || target), { range: 20, reusePath: 15 });
            return;
        }
        // 集结：在集结点面向目标的一侧等全组到齐再一起走（未发起时绕开目标房，绝不误入）
        if (squad > 1 && creep.room.name === staging && !creep.memory.launched) {
            if (creep.memory.stagedAt == null) creep.memory.stagedAt = Game.time;
            const here = squadMates(creep).filter((m) => m.room && m.room.name === staging).length;
            // 波次出发后到达的替补只看得见自己（同伴都在目标房里），没有超时就会一直等到寿终
            const stageWait = conquest.settings().stageWait;
            if (here < squad && Game.time - creep.memory.stagedAt < (stageWait == null ? 200 : stageWait)) {
                // 每只等在**自己的**格子（锚点周围散开）：全挤一个锚点时先到的会被后到者穿过、被交通解算反复对调，白烧 CPU
                const spot = conquest.holdTile(stagePos(staging, target), creep.name, 0);
                if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 20, avoidRooms: avoid });
                return;
            }
            creep.memory.launched = true;
        }
        if (squad <= 1 || creep.memory.launched) {
            // 发起总攻：各走各的**进场泳道**（沿目标房入口边横向散开）→ 并行过境、同时抵达；
            // 全体奔同一个目标会走同一条最短路、排成一字长蛇，把塔的杀人窗口拉长近一倍（很多房出口有几十格宽，本可并排过）
            const laneW = conquest.settings().entryLaneWidth;
            const avoidTowers = conquest.towerAvoidCallback(target, creep.memory.avoidTowers);   // 过境房贴远缘绕敌塔（目标房不避）
            if (laneW > 0) {
                const entry = stagePos(target, staging);
                movement.go(creep, conquest.laneTile(entry, creep.name, laneW, entry.x === 25), { range: 5, reusePath: 20, costCallback: avoidTowers });
            } else {
                movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40, costCallback: avoidTowers }); // 旧行为：全体奔房中心（A/B 对照用）
            }
        } else {
            // 尚未发起：走向集结位，途中绕开目标房 + 贴远缘绕敌塔
            movement.go(creep, stagePos(staging, target), { range: 3, reusePath: 40, avoidRooms: avoid, costCallback: conquest.towerAvoidCallback(target, creep.memory.avoidTowers) });
        }
        return;
    }

    // 已进目标房：开盾则撤回集结点
    const ctrl = creep.room.controller;
    if (ctrl && ctrl.safeMode && ctrl.safeMode > 0) {
        creep.memory.launched = false;
        delete creep.memory.pushed;      // 撤退后下次进来要重新聚合
        delete creep.memory.enteredAt;
        movement.go(creep, new RoomPosition(25, 25, staging), { range: 20, reusePath: 15 });
        return;
    }
    // 站在出口格会被弹回邻房：先进房内
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        return;
    }
    // 进目标房后**重新聚合再一起推进**：过房间出口是单列，队伍会被拉成一字长蛇；塔按"射程内有目标的总时长"杀人，
    // 长蛇的尾巴把暴露窗口拉长近一倍。在入口侧（面向集结点的一侧）各自的格子上等，到齐 reformShare 或等满 reformWait 再推进。
    if (!creep.memory.pushed) {
        if (creep.memory.enteredAt == null) creep.memory.enteredAt = Game.time;
        const cfg = conquest.settings();
        const inRoom = Math.max(1, squadMates(creep).filter((m) => m.room && m.room.name === target).length); // 自己就在房里，至少算 1
        // need 不能超过 squad（单只/小队也要能推进，否则永远等不齐、原地挂机）
        const need = Math.min(squad, Math.max(1, Math.ceil(squad * (cfg.reformShare == null ? 0.7 : cfg.reformShare))));
        const waited = Game.time - creep.memory.enteredAt;
        if (inRoom < need && waited < (cfg.reformWait == null ? 60 : cfg.reformWait)) {
            const rally = conquest.holdTile(stagePos(target, staging), creep.name, 0);
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
            return;
        }
        creep.memory.pushed = true;
    }
    // 10-17 strongholdLoot：只拆盖在战利品格上的 rampart，核心和其它 rampart 不碰；拆光即退役
    if (creep.memory.lootTiles) {
        const rr = conquest.lootRampartTargets(creep.room, creep.memory.lootTiles);
        if (!rr.length) { creep.memory.retired = true; retire.retireAtSpawn(creep); return; }
        const lt = rr.reduce((low, t) => (t.hits < low.hits ? t : low), rr[0]);
        if (creep.dismantle(lt) === ERR_NOT_IN_RANGE) movement.go(creep, lt, { range: 1, reusePath: 5 });
        return;
    }
    // 目标优先级：有能量的塔（真威胁）→ spawn（掐断敌方 defender 补充）→ 哑塔 → extension
    const towers = hostileStructures(creep.room, STRUCTURE_TOWER);
    let targets = towers.filter((t) => towerEnergy(t) >= TOWER_MIN_FIRE);
    if (!targets.length) targets = hostileStructures(creep.room, STRUCTURE_SPAWN);
    if (!targets.length) targets = towers; // 剩下的哑塔（打不了人，最后再拆）
    if (!targets.length) targets = hostileStructures(creep.room, STRUCTURE_EXTENSION);
    if (!targets.length) { creep.memory.retired = true; retire.retireAtSpawn(creep); return; }
    delete creep.memory.idle;
    // 共享集火：所有拆迁打当前优先级层里**血最低**的那一个（确定性 → 全体自动集火同一座塔），
    // 而非 findClosestByRange 分散火力。8×600=4800 > 3000 → 贴上后一 tick 秒塔、大幅缩短挨塔火的时间（复盘 B3）
    const tgt = targets.reduce((low, t) => (t.hits < low.hits ? t : low), targets[0]);
    if (creep.dismantle(tgt) === ERR_NOT_IN_RANGE) movement.go(creep, tgt, { range: 1, reusePath: 5 });
}

module.exports = { run, squadMates };
