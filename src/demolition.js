'use strict';
/** 拆迁调度：规划（轮子方案）确定后，与之冲突的工地和既有建筑在合适的时机拆掉。
 *  - 方案外的工地：立即移除（工地不值钱）。
 *  - 压在规划位上的道路/容器/墙：立即拆（它们不占 RCL 配额，只是挡路）。
 *  - 方案外、占 RCL 配额的结构（extension/塔/lab/link/storage/terminal…）：只在"拆掉后规划位能立刻放出替代工地"
 *    （配额已满且方案内仍有未建位）时拆，一次一个，替代工地建成前不拆下一个。
 *  - 方案外的 spawn：只有方案位上已有建成的 spawn 才拆（RCL7 前只有 1 个配额，拆了全房停摆）。塔同理，保留唯一的塔。
 *  - 方案外的 rampart：从不主动拆（不占位、不占配额），utils.needsRepair 不再维修它，任其衰减；盖在 spawn/塔/storage/terminal 上的例外。
 *  - 敌方遗留、占掉本房配额的结构（打下/占下的房里别人的 spawn/extension/塔…）：引擎 checkControllerAvailability 计数不分主人，
 *    它们让我们连工地都放不出来。只在「全房同类数 ≥ 配额且我们自己的 < 配额」时拆，不看方案、不受恢复期/能量门控
 *    （拆它不花我们任何东西，恰恰是走出恢复期的前提）；有敌对 creep 时 destroy 回 ERR_BUSY，照旧不拆。
 *  每房每 interval tick 评估一次、最多拆 1 个结构；房里有敌对 creep、恢复期或 spawn 能量低于 minEnergy 时不拆。 */
const config = require('config');
const layout = require('layout');
const wheelLayout = require('wheel_layout');
const { logErr, rampartProtectsCore, isRoomPhaseTick } = require('utils');

function settings() {
    return Object.assign({ interval: 25, minEnergy: 300, logSize: 20, batch: 4, keepStoredBelow: 0 }, config.demolition || {});
}

/** 常量可能在测试环境缺失：按名字取，缺了就用回退值 */
function constant(name, fallback) {
    return typeof global[name] !== 'undefined' ? global[name] : fallback;
}

function typeKey(structureType) {
    const keys = {
        [constant('STRUCTURE_SPAWN', 'spawn')]: 'spawn', [constant('STRUCTURE_EXTENSION', 'extension')]: 'extension',
        [constant('STRUCTURE_TOWER', 'tower')]: 'tower', [constant('STRUCTURE_STORAGE', 'storage')]: 'storage',
        [constant('STRUCTURE_LINK', 'link')]: 'link', [constant('STRUCTURE_TERMINAL', 'terminal')]: 'terminal',
        [constant('STRUCTURE_LAB', 'lab')]: 'lab', [constant('STRUCTURE_EXTRACTOR', 'extractor')]: 'extractor',
        [constant('STRUCTURE_OBSERVER', 'observer')]: 'observer', [constant('STRUCTURE_POWER_SPAWN', 'powerSpawn')]: 'powerSpawn',
        [constant('STRUCTURE_NUKER', 'nuker')]: 'nuker', [constant('STRUCTURE_FACTORY', 'factory')]: 'factory',
    };
    return keys[structureType] || null;
}

/** 从不拆的类型：controller / rampart（方案外任其衰减）/ 中立地物 */
const NEVER_TYPES = new Set(['STRUCTURE_CONTROLLER', 'STRUCTURE_RAMPART', 'STRUCTURE_KEEPER_LAIR', 'STRUCTURE_PORTAL', 'STRUCTURE_POWER_BANK', 'STRUCTURE_INVADER_CORE']
    .map((name) => constant(name, name.slice(10).toLowerCase())));

function posKey(pos) {
    return pos.x + '.' + pos.y;
}

/** 规划位索引：格 -> 该格规划的结构类型；类型 -> 规划位列表 */
function planIndex(plan) {
    const at = new Map();
    const byType = new Map();
    for (const entry of wheelLayout.plannedEntries(plan)) {
        const key = posKey(entry.pos);
        if (!at.has(key)) at.set(key, []);
        at.get(key).push(entry.type);
        if (!byType.has(entry.type)) byType.set(entry.type, []);
        byType.get(entry.type).push(entry.pos);
    }
    return { at, byType };
}

function plannedHere(index, structureType, pos) {
    const types = index.at.get(posKey(pos)) || [];
    return types.includes(structureType);
}

/** 这个格上的既有结构是否挡住了规划的其它结构（rampart 与谁都能共格，道路与容器可共格） */
function blocksPlan(index, structureType, pos) {
    const types = index.at.get(posKey(pos)) || [];
    return types.some((planned) => planned !== structureType && !wheelLayout.canOverlap(structureType, planned));
}

function holdReason(room, mem, cfg) {
    if (room.find(FIND_HOSTILE_CREEPS).length) return 'hostiles';
    if (mem.state && mem.state.recovering) return 'recovering';
    if (room.energyAvailable < cfg.minEnergy) return 'energy';
    return null;
}

function removeOffPlanSites(room, index, log) {
    let removed = 0;
    const rampartType = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
        if (plannedHere(index, site.structureType, site.pos)) continue;
        // 外环推迟期间 layout 给 spawn/塔/storage/terminal 盖的 rampart 工地不在 plan.ramparts 里，但和 utils.needsRepair / offPlanRampart 同一规则：
        // 护核心的不算方案外（线上 2026-09-05 W33S7：layout 每 25 tick 放、这里每 25 tick 拆，(6,40)/(7,41)/(31,26) 来回拉锯）
        if (site.structureType === rampartType && rampartProtectsCore(room, site.pos.x, site.pos.y)) continue;
        if (typeof site.remove === 'function' && site.remove() === OK) {
            removed++;
            log({ type: site.structureType, x: site.pos.x, y: site.pos.y, reason: 'site-off-plan' });
        }
    }
    return removed;
}

/** 方案外、占配额的结构此刻能否拆：配额满 + 方案内还有未建位 + 没有同类工地在建（等它建成） */
function cappedReplaceable(room, index, structureType, allow) {
    const key = typeKey(structureType);
    if (!key || !(allow[key] > 0)) return false;
    const structures = room.find(FIND_STRUCTURES).filter((s) => s.structureType === structureType);
    const allSites = room.find(FIND_MY_CONSTRUCTION_SITES);
    const sites = allSites.filter((s) => s.structureType === structureType);
    // 按批替换：同类替代工地在建数达到 batch 才停手（拆一个等建成再拆下一个太慢：20 个 extension 要 1500+ tick）
    if (sites.length >= settings().batch) return false;
    // 工地名额满时拆了也放不出替代工地，容量白掉：等名额（零进度的路/rampart 工地会被 layout 让出，算作可用）
    if (freeSlots(room) <= 0) return false;
    if (structures.length + sites.length < allow[key]) return false;
    const planned = index.byType.get(structureType) || [];
    const unbuilt = planned.filter((pos) => !layout.structureAt(room, pos.x, pos.y, structureType) &&
        !room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).some((s) => s.structureType === structureType));
    return unbuilt.length > 0;
}

/** 可用工地名额：总名额减在建，零进度的路/rampart/墙工地最多 2 个可被 layout 让出，也算可用 */
function freeSlots(room) {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    const lowTypes = new Set([constant('STRUCTURE_ROAD', 'road'), constant('STRUCTURE_RAMPART', 'rampart'), constant('STRUCTURE_WALL', 'constructedWall')]);
    const yieldable = sites.filter((s) => lowTypes.has(s.structureType) && !(s.progress > 0)).length;
    return (Number(config.maxSites) || 6) - sites.length + Math.min(2, yieldable);
}

function plannedUnbuiltCount(room, index, structureType) {
    return (index.byType.get(structureType) || []).filter((pos) => !layout.structureAt(room, pos.x, pos.y, structureType) &&
        !room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).some((s) => s.structureType === structureType)).length;
}

/** 方案内的源/controller 容器（矿容器除外）是否都已建成：是则方案外的旧容器已无用 */
function plannedContainersBuilt(room, index) {
    const plan = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].plan;
    if (!plan || !plan.containers) return false;
    const keys = Object.keys(plan.containers).filter((key) => key !== 'mineral');
    if (!keys.length) return false;
    return keys.every((key) => {
        const pos = plan.containers[key];
        return pos && layout.structureAt(room, pos.x, pos.y, STRUCTURE_CONTAINER);
    });
}

function plannedBuiltCount(room, index, structureType) {
    return (index.byType.get(structureType) || []).filter((pos) => layout.structureAt(room, pos.x, pos.y, structureType)).length;
}

function pickTarget(room, index) {
    const allow = layout.allowance(room);
    const candidates = [];
    for (const structure of room.find(FIND_STRUCTURES)) {
        const type = structure.structureType;
        // 打下来的房里敌人留下的 rampart：引擎 move.js 只让 rampart 的主人（或 public rampart）踩上去，
        // 所以那一格对我们的 creep 是永久障碍——盖在规划位上就意味着那个工位永远站不了人。
        // 而 destroy() 只要求「房间控制器是我们的」，不要求结构归我们（引擎 structures.js / destroy-structure.js），
        // 拆得掉。demolition 过去两道门都把它挡在外面：NEVER_TYPES 排在 my === false 之前，
        // 而 NEVER_TYPES 的本意只是保护**我们自己的** rampart。按归属判断，不按类型。
        // （注：rampart 并不挡 createConstructionSite——引擎 utils.checkConstructionSite 明确豁免 rampart 和 road，
        //  所以这里修的是「站不上去」，不是「建不了」。）
        if (structure.my === false && (type === STRUCTURE_RAMPART || type === STRUCTURE_WALL) &&
            typeof structure.destroy === 'function' && (index.at.get(posKey(structure.pos)) || []).length > 0) {
            candidates.push({ structure, priority: 0, reason: 'hostile-blocking' });
            continue;
        }
        if (NEVER_TYPES.has(type)) continue;
        if (structure.my === false) continue;
        // storage / terminal 里还有东西就不拆：它们没有任何特判，会直接落进 cappedReplaceable
        // （RCL4+ allow.storage = 1，一个方案外的 storage 就满足配额条件）。拆掉是不可逆的，
        // 而这一格的方案位早晚会腾出来——先把货搬空再说。
        if ((type === STRUCTURE_STORAGE || type === STRUCTURE_TERMINAL) &&
            structure.store && structure.store.getUsedCapacity() > (settings().keepStoredBelow || 0)) continue;
        if (typeof structure.destroy !== 'function') continue;
        if (plannedHere(index, type, structure.pos)) continue;
        if (type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER || type === STRUCTURE_WALL) {
            if (blocksPlan(index, type, structure.pos)) candidates.push({ structure, priority: 0, reason: 'blocking' });
            else if (type === STRUCTURE_CONTAINER && plannedContainersBuilt(room, index)) candidates.push({ structure, priority: 3, reason: 'container-redundant' });
            continue;
        }
        if (type === STRUCTURE_SPAWN) {
            // 方案位上已有建成的 spawn 才拆旧的；否则这是唯一的 spawn
            if (plannedBuiltCount(room, index, STRUCTURE_SPAWN) >= 1) candidates.push({ structure, priority: 1, reason: 'spawn-replaced' });
            continue;
        }
        if (type === STRUCTURE_TOWER) {
            if (plannedBuiltCount(room, index, STRUCTURE_TOWER) >= 1) candidates.push({ structure, priority: 1, reason: 'tower-replaced' });
            // 唯一的塔：safe mode 可用（拆掉到新塔建成之间有兜底）且方案位可放时也直接替换
            else if (room.controller.safeModeAvailable > 0 && !room.controller.safeMode && plannedUnbuiltCount(room, index, STRUCTURE_TOWER) > 0 &&
                freeSlots(room) > 0) candidates.push({ structure, priority: 2, reason: 'tower-replace-safemode' });
            continue;
        }
        if (cappedReplaceable(room, index, type, allow)) candidates.push({ structure, priority: 2, reason: 'cap-replace' });
    }
    candidates.sort((a, b) => a.priority - b.priority || a.structure.id.localeCompare(b.structure.id));
    return candidates[0] || null;
}

/** 敌方遗留、正在占我们配额的结构：全房同类（不分主人，与引擎计数一致）已达配额、而我们自己的还没到。
 *  spawn 排最前（没有 spawn 的房只能靠外援维持），其余按 id 定序。 */
function hostileQuotaTarget(room) {
    const allow = layout.allowance(room);
    const total = {};
    const mine = {};
    const foreign = [];
    for (const structure of room.find(FIND_STRUCTURES)) {
        const key = typeKey(structure.structureType);
        if (!key) continue;
        total[key] = (total[key] || 0) + 1;
        if (structure.my === false) foreign.push(structure);
        else mine[key] = (mine[key] || 0) + 1;
    }
    // 引擎口径连工地一起数：我们的替代工地占着的名额也算"我们的"，多配额类型（extension）才能成批替换，而不是拆一个等建成再拆下一个
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
        const key = typeKey(site.structureType);
        if (!key) continue;
        total[key] = (total[key] || 0) + 1;
        mine[key] = (mine[key] || 0) + 1;
    }
    const spawnType = constant('STRUCTURE_SPAWN', 'spawn');
    const keepBelow = settings().keepStoredBelow || 0;
    const blocking = foreign.filter((structure) => {
        const key = typeKey(structure.structureType);
        const cap = allow[key] || 0;
        if (typeof structure.destroy !== 'function' || (total[key] || 0) < cap || (mine[key] || 0) >= cap) return false;
        // 存储型（storage/terminal/lab/factory/nuker/powerSpawn）里还有货就先不拆：没有 rampart 时可以直接取，拆成 ruin 500 tick 就烂掉。
        // spawn/extension/塔的零头能量不值得为它卡住配额
        const stored = structure.store && typeof structure.store.getUsedCapacity === 'function' ? structure.store.getUsedCapacity() : 0;
        const smallStore = key === 'spawn' || key === 'extension' || key === 'tower' || key === 'link';
        return smallStore || stored <= keepBelow;
    });
    blocking.sort((a, b) => (a.structureType === spawnType ? 0 : 1) - (b.structureType === spawnType ? 0 : 1) || a.id.localeCompare(b.id));
    return blocking[0] || null;
}

function run(room) {
    if (!room || !room.controller || !room.controller.my) return;
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!mem) return;
    const cfg = settings();
    if (!isRoomPhaseTick(room.name, cfg.interval)) return;
    const entries = mem.demolition || (mem.demolition = []);
    const log = (entry) => {
        entries.unshift(Object.assign({ t: Game.time }, entry));
        entries.length = Math.min(entries.length, cfg.logSize);
    };
    if (!room.find(FIND_HOSTILE_CREEPS).length) {
        try {
            const foreign = hostileQuotaTarget(room);
            if (foreign && foreign.destroy() === OK) {
                log({ type: foreign.structureType, x: foreign.pos.x, y: foreign.pos.y, reason: 'hostile-quota' });
                console.log('[demolition] ' + room.name + ' 拆除敌方遗留 ' + foreign.structureType + '@' + foreign.pos.x + ',' + foreign.pos.y + '（占满本房配额）');
                return;
            }
        } catch (error) {
            logErr('demolition hostile-quota ' + room.name, error);
        }
    }
    const plan = mem.plan;
    if (!plan || !plan.wheel) return;
    const hold = holdReason(room, mem, cfg);
    if (hold) return;
    let index;
    try {
        index = planIndex(plan);
        removeOffPlanSites(room, index, log);
        const target = pickTarget(room, index);
        if (!target) return;
        const ret = target.structure.destroy();
        if (ret === OK) {
            log({ type: target.structure.structureType, x: target.structure.pos.x, y: target.structure.pos.y, reason: target.reason });
            console.log('[demolition] ' + room.name + ' 拆除 ' + target.structure.structureType + '@' + target.structure.pos.x + ',' + target.structure.pos.y + ' (' + target.reason + ')');
        }
    } catch (error) {
        logErr('demolition ' + room.name, error);
    }
}

/** 方案外的 rampart：不维修（任其衰减）；盖在 spawn/塔/storage/terminal 上的不算方案外（与 utils.needsRepair 同一规则）。 */
function offPlanRampart(room, structure) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    const plan = mem && mem.plan;
    if (!plan || !plan.wheel || !Array.isArray(plan.ramparts)) return false;
    if (rampartProtectsCore(room, structure.pos.x, structure.pos.y)) return false;
    return !plan.ramparts.some((pos) => pos.x === structure.pos.x && pos.y === structure.pos.y);
}

module.exports = { run, settings, planIndex, pickTarget, offPlanRampart };
