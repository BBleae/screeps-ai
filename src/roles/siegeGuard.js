'use strict';
/**
 * 攻占护卫（siegeGuard）：RANGED_ATTACK + HEAL + MOVE。与破防单位同波集结/推进，进目标房后：
 *   1) 集火敌方战斗 creep（优先带 HEAL/RANGED_ATTACK 的 kiter，其次 ATTACK），保护无攻的 dismantler / downgrader；
 *   2) 敌方战斗单位清完则贴住控制器待命（护住 downgrader）。
 * rangedAttack 与 **heal**（range 1）属不同管线，可同 tick 输出 + 自愈/奶队友；但 **rangedHeal 会顶掉
 * rangedAttack/rangedMassAttack**（引擎表 rangedAttack: ['rangedMassAttack','build','repair','rangedHeal']，
 * 与调用顺序无关），所以开过火的那一 tick 只用 heal，不用 rangedHeal —— 见 src/actions.js。
 * 数量占优时不放风筝：压到 3 格集火 + 持续治疗即可压制 2 只 kiter。目标房开盾即撤回集结点。
 * 目标由 conquest 指令给出（memory.targetRoom / staging / squad / avoid）。
 */
const movement = require('movement');
const conquest = require('conquest');
const boost = require('boost');
const actions = require('actions');

/** 同目标、未孵化中的同波攻城单位（siegeDismantler + siegeGuard，含自己） */
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

/** 集结位：staging 房里面向 target 的那一侧、往里缩 STAGE_OFFSET 格（与 siegeDismantler 一致） */
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

function avoidSet(creep, target) {
    const set = new Set([target]);
    const extra = creep.memory.avoid;
    if (Array.isArray(extra)) for (const r of extra) set.add(r);
    return set;
}

function hasHeal(creep) { return (creep.body || []).some((p) => p.type === HEAL && (p.hits === undefined || p.hits > 0)); }
/** 敌方是否还有**活的**攻击部件（能伤害我方）。部件损毁从身体前段起，残血 kiter 往往攻击部件已废→不再是威胁，不必纠缠 */
function canAttack(creep) {
    return (creep.body || []).some((p) => (p.type === ATTACK || p.type === RANGED_ATTACK) && (p.hits === undefined || p.hits > 0));
}
/** 威胁排序（只算活的部件）：带 HEAL 的 kiter（能续命、最难杀）最优先，其次 RANGED_ATTACK / ATTACK */
function threatScore(creep) {
    let s = 0;
    for (const p of (creep.body || [])) {
        if (p.hits !== undefined && p.hits <= 0) continue;
        if (p.type === HEAL) s += 3;
        else if (p.type === RANGED_ATTACK) s += 2;
        else if (p.type === ATTACK) s += 2;
    }
    return s;
}
/** 敌方是否有**活的近战（ATTACK）**部件：远程单位要躲开近战、保持距离，绝不贴到 range 1 挨打 */
function hasLiveMelee(creep) {
    return (creep.body || []).some((p) => p.type === ATTACK && (p.hits === undefined || p.hits > 0));
}
/** 远离某敌人：朝反方向退 ~3 格（clamp 在房内，避免退到边缘被弹进邻房） */
function fleeFrom(creep, enemy) {
    const ex = (enemy.pos && enemy.pos.x !== undefined) ? enemy.pos.x : creep.pos.x;
    const ey = (enemy.pos && enemy.pos.y !== undefined) ? enemy.pos.y : creep.pos.y;
    const sx = creep.pos.x >= ex ? 1 : -1;
    const sy = creep.pos.y >= ey ? 1 : -1;
    const tx = Math.max(3, Math.min(46, creep.pos.x + sx * 3));
    const ty = Math.max(3, Math.min(46, creep.pos.y + sy * 3));
    movement.go(creep, new RoomPosition(tx, ty, creep.room.name), { range: 0, reusePath: 1 });
}

/** 治疗：优先治最受伤的 range≤3 友军（含自己）。
 *  heal（range 1）与 rangedAttack 不同管线，可同 tick；rangedHeal 会把本 tick 的 rangedAttack/
 *  rangedMassAttack 整个顶掉——破防时塔火 600/tick，队友几乎每 tick 带伤，等于整个护卫编队变成纯奶妈。
 *  所以：开过火的 tick 只在 range 1 用 heal；range 2–3 的伤员改治 range 1 内的次优伤员，
 *  没有就这一 tick 不治（下一 tick 没开火时再补 rangedHeal）。 */
function healSupport(creep) {
    if (!hasHeal(creep)) return;
    const cand = creep.pos.findInRange(FIND_MY_CREEPS, 3) || [];
    const deficitOf = (c) => (c.hitsMax || 0) - (c.hits || 0);
    let best = null;
    let bestDeficit = 0;
    for (const c of cand) {
        const deficit = deficitOf(c);
        if (deficit > bestDeficit) { bestDeficit = deficit; best = c; }
    }
    if (bestDeficit <= 0) return; // 无受伤友军
    if (creep.pos.getRangeTo(best) <= 1) { creep.heal(best); actions.note(creep, 'heal'); return; }
    // 本 tick 已经开火：rangedHeal 会顶掉那一发，改治贴身的伤员（heal 永不被顶）
    if (actions.wouldVoid(creep, 'rangedHeal')) {
        actions.skipped('rangedHeal');
        let near = null;
        let nearDeficit = 0;
        for (const c of cand) {
            if (creep.pos.getRangeTo(c) > 1) continue;
            const deficit = deficitOf(c);
            if (deficit > nearDeficit) { nearDeficit = deficit; near = c; }
        }
        if (near) { creep.heal(near); actions.note(creep, 'heal'); }
        return;
    }
    creep.rangedHeal(best);
    actions.note(creep, 'rangedHeal');
}

function run(creep) {
    const target = creep.memory.targetRoom;
    if (require('pvp').fleeHighThreat(creep)) return;   // 10-16：Jumpp/武装玩家 → 撤回母房
    if (!target) return;
    conquest.recordHostileTowers(creep.room, creep);   // 过境避塔：缓存看到的敌塔位供本波无视野时绕塔（并记过境最近距离遥测）
    const staging = creep.memory.staging || target;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);

    // 未到目标房：集结 / 行军（与 siegeDismantler 同逻辑），途中持续自愈
    if (creep.room.name !== target) {
        // 出发前先强化（与 siegeDismantler 同逻辑，src/boost.js）：只在母房做，做不到就跳过
        if (boost.run(creep)) return;
        // 10-17 硬规则：全队 boost 未装齐前留在母房等待（含本只已装好的）
        if (conquest.boostGateHold(target)) {
            if (creep.room.name !== (creep.memory.home || target)) movement.go(creep, new RoomPosition(25, 25, creep.memory.home || target), { range: 20, reusePath: 15 });
            healSupport(creep);
            return;
        }
        const avoid = avoidSet(creep, target);
        if (squad > 1 && creep.room.name === staging && !creep.memory.launched) {
            if (creep.memory.stagedAt == null) creep.memory.stagedAt = Game.time;
            const here = squadMates(creep).filter((m) => m.room && m.room.name === staging).length;
            const stageWait = conquest.settings().stageWait;
            // 波次出发后到达的替补只看得见自己（同伴都在目标房里），没有超时就会一直等到寿终
            if (here < squad && Game.time - creep.memory.stagedAt < (stageWait == null ? 200 : stageWait)) {
                // 每只等在自己的格子（散开），避免全挤一个锚点被交通解算反复对调烧 CPU
                const spot = conquest.holdTile(stagePos(staging, target), creep.name, 0);
                if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 20, avoidRooms: avoid });
                healSupport(creep);
                return;
            }
            creep.memory.launched = true;
        }
        if (squad <= 1 || creep.memory.launched) {
            // 进场泳道：沿入口边散开并行过境（与 siegeDismantler 同步），不排一字长蛇
            const laneW = conquest.settings().entryLaneWidth;
            const avoidTowers = conquest.towerAvoidCallback(target, creep.memory.avoidTowers);   // 过境房贴远缘绕敌塔（目标房不避）
            if (laneW > 0) {
                const entry = stagePos(target, staging);
                movement.go(creep, conquest.laneTile(entry, creep.name, laneW, entry.x === 25), { range: 5, reusePath: 20, costCallback: avoidTowers });
            } else {
                movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40, costCallback: avoidTowers }); // 旧行为：全体奔房中心（A/B 对照用）
            }
        } else {
            movement.go(creep, stagePos(staging, target), { range: 3, reusePath: 40, avoidRooms: avoid, costCallback: conquest.towerAvoidCallback(target, creep.memory.avoidTowers) });
        }
        healSupport(creep);
        return;
    }

    // 已进目标房：开盾则撤回集结点（塔照打，不硬抗）
    const ctrl = creep.room.controller;
    if (ctrl && ctrl.safeMode && ctrl.safeMode > 0) {
        creep.memory.launched = false;
        delete creep.memory.pushed;      // 撤退后下次进来要重新聚合
        delete creep.memory.enteredAt;
        movement.go(creep, new RoomPosition(25, 25, staging), { range: 20, reusePath: 15 });
        healSupport(creep);
        return;
    }
    // 站在出口格会被弹回邻房：先进房内
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        healSupport(creep);
        return;
    }

    // 进目标房后与拆迁**同步重新聚合**再推进（护卫是边打边等，不像拆迁那样纯等）：
    // 并行过境后仍可能散开，聚合能缩短塔"射程内有目标"的总时长
    let reforming = false;
    if (!creep.memory.pushed) {
        if (creep.memory.enteredAt == null) creep.memory.enteredAt = Game.time;
        const cfg = conquest.settings();
        const inRoom = Math.max(1, squadMates(creep).filter((m) => m.room && m.room.name === target).length); // 自己就在房里，至少算 1
        // need 不能超过 squad（单只/小队也要能推进，否则永远等不齐、原地挂机）
        const need = Math.min(squad, Math.max(1, Math.ceil(squad * (cfg.reformShare == null ? 0.7 : cfg.reformShare))));
        if (inRoom < need && Game.time - creep.memory.enteredAt < (cfg.reformWait == null ? 60 : cfg.reformWait)) reforming = true;
        else creep.memory.pushed = true;
    }
    const rallySpot = () => conquest.holdTile(stagePos(target, staging), creep.name, 0);

    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS) || [];
    // 只把**还能攻击我方**的敌人当威胁：打废攻击部件的残血敌人不再纠缠，自动转下一个更优先目标
    const threats = hostiles.filter(canAttack).sort((a, b) => threatScore(b) - threatScore(a));
    if (threats.length) {
        // 集火威胁分最高者（同分取最近）；走 A：每 tick 一边 rangedAttack 一边朝目标推进
        // （rangedAttack 与 move 不同管线，可同 tick，追得上同速 kiter，不再"射一发退一步"）
        const topScore = threatScore(threats[0]);
        const top = threats.filter((c) => threatScore(c) === topScore);
        const tgt = creep.pos.findClosestByRange(top) || top[0];
        const range = creep.pos.getRangeTo(tgt);
        const adj = hostiles.filter((h) => creep.pos.getRangeTo(h) <= 1).length;
        if (range <= 3) {
            if (adj >= 2) { creep.rangedMassAttack(); actions.note(creep, 'rangedMassAttack'); }
            else { creep.rangedAttack(tgt); actions.note(creep, 'rangedAttack'); }
        }
        // 远程走位：保持距离、别贴近战。活着的近战（ATTACK）单位在 3 格内 → 拉开风筝；
        // 目标在射程外 → 靠到 range 3（不贴身）；否则站在 range≤3 站桩持续输出，绝不主动贴到 range 1。
        const melee = hostiles.filter(hasLiveMelee);
        const nearMelee = melee.length ? creep.pos.findClosestByRange(melee) : null;
        if (nearMelee && creep.pos.getRangeTo(nearMelee) <= 3) {
            fleeFrom(creep, nearMelee);
        } else if (reforming) {
            // 聚合中：不追击，站在入口侧自己的格子上边打边等（射程内照样输出）
            const rally = rallySpot();
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
        } else if (range > 3) {
            movement.go(creep, tgt, { range: 3, reusePath: 2 });
        }
    } else {
        // 场上没有能攻击我方的敌人 → heal 优先（伤员由 healSupport 每 tick 处理），不追无害敌人；
        // 无伤员则贴控制器待命护住 downgrader，顺手打射程内的无害敌 creep（清 upgrader 加速围降，但不移动追击）
        // suppress：外矿/低级房压制，工人和 reserver 就是目标，要追着打掉
        const wounded = (creep.pos.findInRange(FIND_MY_CREEPS, 3) || []).some((c) => (c.hitsMax || 0) > (c.hits || 0));
        if (creep.memory.suppress && hostiles.length && !wounded && !reforming) {
            const tgt = creep.pos.findClosestByRange(hostiles) || hostiles[0];
            const range = creep.pos.getRangeTo(tgt);
            if (range <= 3) { creep.rangedAttack(tgt); actions.note(creep, 'rangedAttack'); }
            if (range > 1) movement.go(creep, tgt.pos || tgt, { range: 1, reusePath: 2 });
        } else if (reforming) {
            const rally = rallySpot();
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
        } else if (!wounded && ctrl) {
            // 待命环：散到控制器周围**各自的**格子，且避开控制器相邻格（留给 downgrader 独占，别把它挤走/对调）
            const spot = conquest.holdTile(ctrl.pos, creep.name, 2);
            if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 10 });
        }
        const near = creep.pos.findClosestByRange(hostiles);
        if (near && creep.pos.getRangeTo(near) <= 3) { creep.rangedAttack(near); actions.note(creep, 'rangedAttack'); }
    }
    healSupport(creep);
}

module.exports = { run, squadMates, threatScore };
