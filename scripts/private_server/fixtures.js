'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const UPGRADER_ROUTE = require('../../test/fixtures/upgrader_legacy_spawn_W34S7.json');

const ROOMS = {
    upgraderActualRoute: 'W34S7',
    bootstrap: 'W20N20',
    recovery: 'W30N30',
    logistics: 'W40N40',
    storageConsumer: 'W41N40',
    controllerLinkConsumer: 'W42N40',
    links: 'E20S20',
    blueprint: 'E30S30',
    industry: 'E40S40',
    industryTarget: 'E40S39',
    reserveOrderedHome: 'W63N55',
    reserveOrderedEarly: 'W63N54',
    reserveOrderedTarget: 'W63N53',
    reserveBudgetHome: 'W62N55',
    reserveBudgetTarget: 'W62N53',
    reserveDeadlineHome: 'W61N55',
    reserveDeadlineTarget: 'W61N53',
    reserveHome: 'W58N55',
    reserveTarget: 'W58N53',
    // 路线失配自愈（effects remote.roadTrailReplan）：规划的外矿路线播在没人走的走廊上，满载腿的真实走线应把它替换掉
    roadTrailHome: 'W59N55',
    roadTrailTarget: 'W59N53',
    roadTrailForeign: 'W59N54',   // 房名在 roadTrailHome 的 remotes 里但本房没启用、归本用户另一条记录在跑（配额口径夹具）
    remoteHome: 'W50N50',
    remote: 'W50N49',
    conflict: 'E50S50',
    // conflict 用户的第二房：占下时留着别人的 spawn（线上 2026-10-01 W37S7：Lucas21 的废 spawn 占满 RCL4 配额，我们的 spawn 工地放不出来）
    foreignSpawn: 'E50S51',
    brainHome: 'E11S11',
    brainRemote: 'E11S12',
    brainRemote2: 'E12S11',
    defenseHome: 'E13S13',
    aidHome: 'E15S15',
    aidWeak: 'E15S16',
    aidNew1: 'E14S15',   // 无 spawn 的新房：正西紧邻 E15S15（房间只在正交方向有出口，对角的 E14S16 让 pioneer 出不了母房），离 E15S16 也是 1，同距离按房名归 E15S15
    aidNew2: 'E15S17',   // 无 spawn 的新房，离 E15S16 1、离 E15S15 2 → 归 E15S16
    // 援建安全路线（2026-10-13，seedAidSafeRoute）：三房正西向一列（生成房只有正交出口，上下邻房是墙），母房到弱房直线 2 格，
    // 唯一的路穿过中间的 roadblock——它在 Memory.map 里记成别人占领的房（dangerRooms），援建 creep 走不过去
    aidSafeHome: 'W82S77',
    aidSafeRoadblock: 'W83S77',
    aidSafeFar: 'W84S77',
    // 一次性 storage/terminal 先于道路与 extension（2026-10-13，seedLayoutOneOff）：刚到 RCL6、30 个 extension 已建、还差 10 个，
    // 34 个已开工的路工地占着名额，本房只剩 6 个名额
    layoutOneOff: 'W72N72',
    // 一次性建筑的兜底轮（2026-10-13 复审，seedLayoutLeftover）：只剩 1 个名额、extension 缺但方案位放不出、塔不缺 ⇒ 名额给 terminal
    layoutLeftover: 'W74N74',
    // layoutOneOff 用户的第二房（2026-10-14 复审，同 tick 去重）：RCL6、storage 与 30 个 extension 已建、方案里没有别的位——
    // 早轮放出 terminal 后名额富余，兜底轮按 tick 开头的快照仍"缺 terminal"，旧代码同格重放（拿到 OK、处理器丢掉）并写假的 oneOffLeftover
    layoutDedupe: 'W73N72',
    // terminal 补能 / 终端网络 / 市场（2026-10-13，seedTerminalNetwork）：RCL6、storage 20 万、terminal 播 0 能量——terminal 里的能量只可能是 hauler 从 storage 搬进去的
    terminalHome: 'W86S80',
    terminalMarket: 'W86S81', // 无主 terminal + 一张 U 的买单（私服 NPC 市场的模型）：terminalHome 卖富余矿物的对手方
    // terminal 中段取回（2026-10-13 复审，seedTerminalDrainLow）：storage 富余但低于 terminalDrainStorageBelow、terminal 里 3 万补进去的能量
    terminalDrainLow: 'W89S84',
    terminalPeer: 'W87S80',   // terminalHome 用户的第二房：RCL6、storage 0、terminal 0——终端网络的接收方，hauler 把送来的能量从 terminal 取出
    // 矿物链（2026-10-13，seedLabChain）：RCL7、储备闸开着、四个**空** lab（三连 + 一个孤立的），矿物只在 terminal 里——
    // lab 里出现的任何矿物/产物都只可能是 labTech 搬进去、反应做出来的
    labHome: 'W92S80',
    // labChain 用户的第二房（2026-10-13 矿物调剂）：RCL6、没有 lab、terminal 里 O 6000——labHome 的 O 只播了 600（< mineralWant），
    // 缺的那部分只可能是终端网络的矿物调剂送过去的
    labPeer: 'W93S80',
    // 储备闸关着时的 boost lab 补能（2026-10-13 复审，seedBoostLabGated）：RCL7、storage 7 万（富余且 ≥ terminalFillStorageAbove，但 < storageReserve 10 万），
    // 三连 + 一个孤立的 boost lab（播 XZH2O 600、0 能量）——lab 计划不算，但 boost lab 的能量要照补
    boostLabGated: 'W94S84',
    // 攻城 creep 出发前强化（2026-10-13，seedBoost）：RCL6、一个 lab 播 XZH2O 600 + 能量 2000（没有 storage ⇒ industry 储备闸关着，
    // 没有 labTech、hauler 也不往 lab 补能，lab 里的货只会被 boostCreep 用掉）；一只带 memory.boosts 的 siegeDismantler，目标是正西的中立房
    boostHome: 'W96S85',
    boostTarget: 'W97S85',
    // 大脑掉线时的自治占领兜底（2026-10-13，seedAutoClaim）：母房 + 正南的中立双源房（兜底该挑的）；
    // decoy 不生成，只在 Memory.map 里记成别人的房（房名更小、距离同为 1：兜底若不看 owner 会先挑它）
    // SK 采矿（2026-10-13，config.sk 默认关；夹具用大脑指令 skMining 显式打开）：RCL7 母房 + 正南的 keeper 房（房名 4/4 是 SK 格局，
    // 夹具删掉它的 controller ⇒ 引擎把源的容量设成 4000；两个 lair 各贴一口源，lair0 上播一只在岗 keeper）
    skHome: 'W44S43',
    skRoom: 'W44S44',
    // 同一母房上一条被大脑移出白名单的 SK 外矿（2026-10-13 复审，不生成房间，只在 Memory 里播记录 + 两只 reaper）：
    // 退回 keeperRoom 后 reaper 回家回收，不能被 noteReaperLoss 记成阵亡、把永久停用改写成 skReaperLost
    skDemoted: 'W45S43',
    autoClaimHome: 'W78N72',
    autoClaimTarget: 'W78N71',
    autoClaimDecoy: 'W77N72',
    // 自治占领的 CPU 闸（2026-10-13 复审，seedAutoClaim 的 cpuHeld 变体）：同样掉线一天、同样的合格邻房，但近期 tick 用量远超 limit × 0.8 ⇒ 不挑
    autoClaimCpuHome: 'W80N76',
    autoClaimCpuTarget: 'W80N75',
    storageFed: 'W60N60',   // 升级者贴 storage 取能的房（线上 W31S6/W31S8 的形态）：补给工作带断言的专用场景
    linkDrink: 'W60N61',    // storageFed 用户的第二房：升级者同时贴着 storage（高于底线）与有能量的 ctrl link（线上 W31S6 的形态）
    // storageFed 用户的第三房（2026-10-13）：storage 站位不贴 ctrl link、link 堵满，指定的升级者已经站在 link 旁、脚下是有能量的容器
    linkInPlace: 'W60N62',
    containerGap: 'W30N29', // recovery 用户的第二房：RCL4、容器全没、1 只矿工 recovering——builder 必须进队
    claimBlocked: 'W70N70',
    maintenance: 'W61N60',   // 维修饥饿：空 storage + 40/40 工地名额 + 危急道路（线上 W33S7 2026-09-09 的形态）
    // 纯维修房（维护场景的第二房）：武装的塔 + 没有工地 + 没有危急结构 + 塔射程外的旧路。
    // 旧代码"有能量的塔会修"的守卫在这里返回 false（builderTarget 0，房间一只 builder 都没有），
    // 而塔根本够不着那些路（线上 2026-09-10 W32S4/W31S4/W33S8 都是这个形态）
    repairOnly: 'W61N59',
    claimBlockedTarget: 'W70N69',
    // audit 场景（2026-09-11 全面审计的一批修复，seedAudit）：一个用户三个己方房 + 两个外矿房
    auditHome: 'W64N60',     // W33S7 形态：RCL6、link 供能、storage 0、没有 hauler、link+容器矿工
    auditRemote: 'W64N59',   // auditHome 的外矿（正南）：预定 4998 + 快到期的 reserver
    auditRich: 'W65N60',     // RCL5、storage 15 万（auditHome 正西）
    auditDrop: 'W65N59',     // auditRich 正南：auditHome 名下这条外矿离 auditRich 1 跳、离 auditHome 2 跳
    auditLink: 'W63N60',     // RCL6、storage 站位、贴 ctrl link 的站位格被 lab 占住（auditHome 正东）
    auditZero: 'W62N60',     // RCL5、hauler 在岗但收入 EMA 0.2（按 0 处理）、vital 都满足：非 vital 的 builder 请求守住缩身下限
    // 矿工换代（2026-10-08，seedMinerPair）：RCL7、两个 spawn、源 0 是 link + 容器（5W1C1M 攒批交货）、源 1 是容器（5W3M，寿命 400）。
    // 源 1 的替补孵化那 24 tick 里另一只 spawn 空闲：旧口径把孵化中的替补漏掉、再孵一只同源矿工（线上 26 源 47 只）
    minerPair: 'W69N66',
    auditPocket: 'W63N61',   // RCL6、容量 2300、storage 3000：spawn 正上方是被 extension 围死的出生口袋，空手升级者困在里面（线上 2026-10-08 W31S4）
    auditWalled: 'W62N61',   // RCL6：控制器被一圈墙围死（4 格外），升级者够不着——看门狗连续退役无进度后退避
    // 攻占场景（B0 损失预言机 + 过境避塔）：攻击方母房 → 中立集结 → **敌方过境房（带塔）** → 敌方目标，四房正交纵列（生成房只有正交出口）
    // conquestTransit 夹在集结点与目标之间：波次冲锋必经此房，用来验证 towerAvoidCallback 让队伍贴远缘绕过过境塔
    conquestHome: 'E18S18',
    conquestStaging: 'E18S17',
    conquestTransit: 'E18S16',
    conquestTarget: 'E18S15',
    // keeper 过境场景（VALIDATE_KEEPER 门控）：claimer 从 keeperHome 穿中立的 keeperRoom（带 keeper lair）去占 keeperTarget，
    // 验证 movement.keeperAvoidCallback 让 claimer 贴远缘绕开 lair（Memory.keeperTransit 记最近距离）。纵列，正交相邻。
    keeperHome: 'E22S18',
    keeperRoom: 'E22S17',
    keeperTarget: 'E22S16',
};

const GENERATION = [
    { room: ROOMS.upgraderActualRoute, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    ...['reserveOrderedHome','reserveOrderedEarly','reserveOrderedTarget'].map(key => ({room:ROOMS[key],terrainType:2,swampType:0,sources:2,mineral:'H'})),
    { room: ROOMS.reserveBudgetHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: 'W62N54', terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.reserveBudgetTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.reserveDeadlineHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: 'W61N54', terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.reserveDeadlineTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.storageConsumer, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.controllerLinkConsumer, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.reserveHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: 'W58N54', terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.reserveTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.roadTrailHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: 'W59N54', terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.roadTrailTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.bootstrap, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.recovery, terrainType: 3, swampType: 1, sources: 2, mineral: 'O' },
    { room: ROOMS.logistics, terrainType: 4, swampType: 1, sources: 2, mineral: 'U' },
    { room: ROOMS.links, terrainType: 5, swampType: 2, sources: 2, mineral: 'L' },
    { room: ROOMS.blueprint, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.industry, terrainType: 3, swampType: 0, sources: 2, mineral: 'Z' },
    { room: ROOMS.industryTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.remoteHome, terrainType: 2, swampType: 1, sources: 2, mineral: 'O' },
    { room: ROOMS.remote, terrainType: 2, swampType: 1, sources: 2, mineral: 'U' },
    { room: ROOMS.conflict, terrainType: 6, swampType: 0, sources: 2, mineral: 'L' },
    { room: ROOMS.foreignSpawn, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.brainHome, terrainType: 2, swampType: 1, sources: 2, mineral: 'X' },
    { room: ROOMS.brainRemote, terrainType: 2, swampType: 1, sources: 2, mineral: 'Z' },
    { room: ROOMS.brainRemote2, terrainType: 2, swampType: 1, sources: 2, mineral: 'K' },
    { room: ROOMS.defenseHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.aidHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.aidWeak, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.aidNew1, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.aidNew2, terrainType: 2, swampType: 0, sources: 2, mineral: 'U' },
    { room: ROOMS.aidSafeHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.aidSafeRoadblock, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.aidSafeFar, terrainType: 2, swampType: 0, sources: 2, mineral: 'U' },
    { room: ROOMS.layoutOneOff, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.layoutLeftover, terrainType: 2, swampType: 0, sources: 2, mineral: 'L' },
    { room: ROOMS.layoutDedupe, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.terminalHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.terminalPeer, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.terminalMarket, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.terminalDrainLow, terrainType: 2, swampType: 0, sources: 2, mineral: 'Z' },
    { room: ROOMS.labHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'U' },
    { room: ROOMS.labPeer, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.boostLabGated, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.boostHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'Z' },
    { room: ROOMS.boostTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.skHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.skRoom, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.autoClaimHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.autoClaimTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.autoClaimCpuHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.autoClaimCpuTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.storageFed, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.linkDrink, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.linkInPlace, terrainType: 2, swampType: 0, sources: 2, mineral: 'U' },
    { room: ROOMS.containerGap, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.claimBlocked, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.maintenance, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.repairOnly, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.claimBlockedTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.auditHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.auditRemote, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.auditRich, terrainType: 2, swampType: 0, sources: 2, mineral: 'U' },
    { room: ROOMS.auditDrop, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    { room: ROOMS.auditLink, terrainType: 2, swampType: 0, sources: 2, mineral: 'L' },
    { room: ROOMS.auditZero, terrainType: 2, swampType: 0, sources: 2, mineral: 'Z' },
    { room: ROOMS.minerPair, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
    { room: ROOMS.auditPocket, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
    { room: ROOMS.auditWalled, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
];

// 攻占场景四房（terrainType 2 = 开阔，siege 要能寻路进目标）：由 VALIDATE_CONQUEST env 门控，
// 普通 run_validation（部署门）不生成这些房、世界不变、基线不扰；只在验证战斗改动时用 VALIDATE_CONQUEST=1 生成
if (process.env.VALIDATE_CONQUEST) {
    GENERATION.push(
        { room: ROOMS.conquestHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
        { room: ROOMS.conquestStaging, terrainType: 2, swampType: 0, sources: 2, mineral: 'O' },
        { room: ROOMS.conquestTransit, terrainType: 2, swampType: 0, sources: 2, mineral: 'L' },
        { room: ROOMS.conquestTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    );
}

// keeper 过境场景三房（terrainType 2 = 开阔，claimer 要能绕 lair 寻路）：VALIDATE_KEEPER 门控，默认不生成、基线不扰
if (process.env.VALIDATE_KEEPER) {
    GENERATION.push(
        { room: ROOMS.keeperHome, terrainType: 2, swampType: 0, sources: 2, mineral: 'H' },
        { room: ROOMS.keeperRoom, terrainType: 2, swampType: 0, sources: 2, mineral: 'L' },
        { room: ROOMS.keeperTarget, terrainType: 2, swampType: 0, sources: 2, mineral: 'K' },
    );
}

const USERNAMES = {
    bootstrap: 'ValidationBootstrap',
    recovery: 'ValidationRecovery',
    logistics: 'ValidationLogistics',
    storageConsumer: 'ValidationStorageConsumer',
    controllerLinkConsumer: 'ValidationControllerLinkConsumer',
    upgraderActualRoute: 'ValidationUpgraderActualRoute',
    links: 'ValidationLinks',
    blueprint: 'ValidationBlueprint',
    industry: 'ValidationIndustry',
    reserveOrdered: 'ValidationReserveOrdered',
    reserveBudget: 'ValidationReserveBudget',
    reserveDeadline: 'ValidationReserveDeadline',
    reserveContinuity: 'ValidationReserveContinuity',
    roadTrail: 'ValidationRoadTrail',
    remote: 'ValidationRemote',
    conflict: 'ValidationConflict',
    brain: 'ValidationBrain',
    defense: 'ValidationDefense',
    aid: 'ValidationAid',
    aidSafeRoute: 'ValidationAidSafeRoute',
    layoutOneOff: 'ValidationLayoutOneOff',
    layoutLeftover: 'ValidationLayoutLeftover',
    terminalNet: 'ValidationTerminalNet',
    terminalDrainLow: 'ValidationTerminalDrainLow',
    labChain: 'ValidationLabChain',
    boostLabGated: 'ValidationBoostLabGated',
    boost: 'ValidationBoost',
    sk: 'ValidationSk',
    autoClaim: 'ValidationAutoClaim',
    autoClaimCpu: 'ValidationAutoClaimCpu',
    storageFed: 'ValidationStorageFed',
    claimBlocked: 'ValidationClaimBlocked',
    maintenance: 'ValidationMaintenance',
    audit: 'ValidationAudit',
    minerPair: 'ValidationMinerPair',
    conquest: 'ValidationConquest',
    conquestEnemy: 'ValidationConquestEnemy',
    conquestTransit: 'ValidationConquestTransit',
    keeper: 'ValidationKeeper',
};

const HITS = {
    extension: 1000,
    container: 250000,
    road: 5000,
    tower: 3000,
    storage: 10000,
    link: 1000,
    terminal: 3000,
    lab: 500,
    factory: 1000,
    observer: 500,
    powerSpawn: 5000,
    nuker: 1000,
    extractor: 500,
    rampart: 1,
    constructedWall: 1,
};

const SITE_COST = {
    spawn: 15000,
    extension: 3000,
    container: 5000,
    road: 300,
    tower: 5000,
    storage: 30000,
    link: 5000,
    terminal: 100000,
    lab: 5000,
    factory: 100000,
    observer: 8000,
    powerSpawn: 100000,
    nuker: 100000,
    extractor: 5000,
    rampart: 1,
    constructedWall: 1,
};

const BODY_COST = {
    move: 50,
    work: 100,
    carry: 50,
    claim: 600,
    attack: 80,
    ranged_attack: 150,
    heal: 250,
    tough: 10,
};

const WALL_TERRAIN = '1'.repeat(2500);

const RESOURCE_CAPACITY_TYPES = new Set([
    'spawn', 'extension', 'link', 'tower', 'powerSpawn', 'nuker',
]);
const SCALAR_CAPACITY_TYPES = new Set([
    'container', 'storage', 'terminal', 'factory',
]);
const LAB_MINERAL_CAPACITY = 3000;
const CREEP_OBSTACLE_TYPES = new Set([
    'spawn', 'creep', 'powerCreep', 'source', 'mineral', 'deposit', 'controller',
    'constructedWall', 'extension', 'link', 'storage', 'tower', 'observer',
    'powerSpawn', 'powerBank', 'lab', 'terminal', 'nuker', 'factory', 'invaderCore',
]);
const CREEP_WALKABLE_OVERLAYS = new Set(['road', 'container', 'rampart']);
const GENERATED_ROOM_TIMEOUT_MS = 30000;
const SOURCE_ENERGY = 1500;
const SOURCE_REGEN_TICKS = 300;

function literal(value) {
    return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function roomCoordinates(roomName) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!match) return null;
    return {
        x: match[1] === 'W' ? -Number(match[2]) - 1 : Number(match[2]),
        y: match[3] === 'N' ? -Number(match[4]) - 1 : Number(match[4]),
    };
}

function roomNameFromCoordinates(x, y) {
    if (x < -128 || x > 127 || y < -128 || y > 127) return null;
    return `${x < 0 ? `W${-x - 1}` : `E${x}`}${y < 0 ? `N${-y - 1}` : `S${y}`}`;
}

function neighboringRooms(roomName) {
    const coordinates = roomCoordinates(roomName);
    if (!coordinates) return [];
    return [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
    ].map(([dx, dy]) => roomNameFromCoordinates(coordinates.x + dx, coordinates.y + dy))
        .filter(Boolean);
}

async function ensureTerrainNeighbors(cli) {
    const terrainDocuments = await cli.evaluateJson("storage.db['rooms.terrain'].find()", { timeoutMs: 30000 });
    const compressed = await cli.evaluateJson('storage.env.get(storage.env.keys.TERRAIN_DATA)', { timeoutMs: 30000 });
    const decoded = compressed ? JSON.parse(zlib.inflateSync(Buffer.from(compressed, 'base64'))) : [];
    const terrainByRoom = new Map();
    for (const item of decoded) {
        if (!item || typeof item.room !== 'string' || typeof item.terrain !== 'string' || item.terrain.length !== 2500) continue;
        terrainByRoom.set(item.room, { room: item.room, terrain: item.terrain });
    }
    let added = 0;
    for (const item of terrainDocuments || []) {
        if (!item || typeof item.room !== 'string' || typeof item.terrain !== 'string') continue;
        if (!terrainByRoom.has(item.room)) terrainByRoom.set(item.room, { room: item.room, terrain: item.terrain });
        for (const neighbor of neighboringRooms(item.room)) {
            if (terrainByRoom.has(neighbor)) continue;
            terrainByRoom.set(neighbor, { room: neighbor, terrain: WALL_TERRAIN });
            added++;
        }
    }
    if (added > 0 || terrainByRoom.size !== decoded.length) {
        const next = zlib.deflateSync(JSON.stringify([...terrainByRoom.values()])).toString('base64');
        await cli.evaluateJson(`storage.env.set(storage.env.keys.TERRAIN_DATA,${literal(next)}).then(function(){return true})`,
            { timeoutMs: 30000 });
    }
    return { added, count: terrainByRoom.size };
}

async function generatedRoomSnapshot(cli, roomName) {
    return cli.evaluateJson(
        `Promise.all([storage.db.rooms.findOne({_id:${literal(roomName)}}),storage.db['rooms.terrain'].findOne({room:${literal(roomName)}}),storage.db['rooms.objects'].find({room:${literal(roomName)}})]).then(function(values){var objects=values[2]||[];return {room:!!values[0],terrain:!!(values[1]&&values[1].terrain),controller:objects.some(function(object){return object.type==='controller'}),sources:objects.filter(function(object){return object.type==='source'}).length,mineral:objects.some(function(object){return object.type==='mineral'})};})`,
        { timeoutMs: 30000 });
}

async function repairGeneratedSources(cli, roomName, targetCount) {
    return cli.evaluateJson(
        `(function(){return Promise.all([storage.db['rooms.terrain'].findOne({room:${literal(roomName)}}),storage.db['rooms.objects'].find({room:${literal(roomName)}})]).then(function(values){var terrain=values[0]&&values[0].terrain;var objects=values[1]||[];if(!terrain)return 0;var sources=objects.filter(function(object){return object.type==='source'});var needed=${Number(targetCount)}-sources.length;if(needed<=0)return 0;var occupied={};objects.forEach(function(object){if(object.x!=null&&object.y!=null)occupied[object.x+'.'+object.y]=true;});var candidates=[];for(var y=3;y<=46;y++){for(var x=3;x<=46;x++){var key=x+'.'+y;if(occupied[key]||!(Number(terrain.charAt(y*50+x))&1))continue;var passNearby=false;for(var dy=-1;dy<=1;dy++){for(var dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;if(!(Number(terrain.charAt((y+dy)*50+x+dx))&1)){passNearby=true;break;}}if(passNearby)break;}if(!passNearby)continue;var nearImportant=false;for(var index=0;index<objects.length;index++){var object=objects[index];if((object.type==='source'||object.type==='controller'||object.type==='mineral')&&Math.max(Math.abs(object.x-x),Math.abs(object.y-y))<5){nearImportant=true;break;}}if(nearImportant)continue;candidates.push({x:x,y:y});}}if(candidates.length<needed)throw new Error('Unable to repair generated sources in '+${literal(roomName)});var inserts=candidates.slice(0,needed).map(function(position){return {room:${literal(roomName)},type:'source',x:position.x,y:position.y,energy:${SOURCE_ENERGY},energyCapacity:${SOURCE_ENERGY},ticksToRegeneration:${SOURCE_REGEN_TICKS}};});return storage.db['rooms.objects'].insert(inserts).then(function(){return inserts.length});});})()`,
        { timeoutMs: 30000 });
}

async function waitForGeneratedRoom(cli, spec, timeoutMs) {
    const deadline = Date.now() + Number(timeoutMs || GENERATED_ROOM_TIMEOUT_MS);
    let snapshot = null;
    while (Date.now() < deadline) {
        snapshot = await generatedRoomSnapshot(cli, spec.room);
        const mineralReady = spec.mineral === false || snapshot.mineral;
        if (snapshot.room && snapshot.terrain && snapshot.controller && mineralReady && snapshot.sources >= spec.sources) {
            return snapshot;
        }
        if (snapshot.room && snapshot.terrain && snapshot.sources < spec.sources) {
            await repairGeneratedSources(cli, spec.room, spec.sources);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for generated room ${spec.room}: ${JSON.stringify(snapshot)}`);
}

async function waitForGeneratedRooms(cli, timeoutMs) {
    const deadline = Date.now() + Number(timeoutMs || GENERATED_ROOM_TIMEOUT_MS);
    for (const spec of GENERATION) {
        const remaining = Math.max(1, deadline - Date.now());
        await waitForGeneratedRoom(cli, spec, remaining);
    }
    return true;
}

function chebyshev(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function bodyCost(body) {
    return (body || []).reduce((sum, part) => sum + (BODY_COST[part.type || part] || 0), 0);
}

function nearOrNull(allocator, target, options) {
    try {
        return allocator.near(target, options);
    } catch (error) {
        return null;
    }
}

class PositionAllocator {
    constructor(terrain, objects) {
        this.terrain = terrain || '';
        this.used = new Set();
        for (const object of objects || []) {
            if (object && object.x != null && object.y != null) this.used.add(`${object.x}.${object.y}`);
        }
    }

    wall(x, y) {
        if (x < 1 || x > 48 || y < 1 || y > 48) return true;
        const value = Number(this.terrain.charAt(y * 50 + x)) || 0;
        return (value & 1) !== 0;
    }

    free(x, y) {
        return !this.wall(x, y) && !this.used.has(`${x}.${y}`);
    }

    /** 引擎 utils.checkConstructionSite 的出口边规则：道路/容器以外的建筑落在 x/y ∈ {1,48} 时，贴着的 3 个边格必须全是墙，
     *  否则 Room.createConstructionSite 返回 ERR_INVALID_TARGET（y 的判断覆盖 x 的判断，与引擎一致）。
     *  夹具直接写库的建筑绕得过这条规则，但规划位要交给游戏代码放工地的，必须落在放得出工地的格上
     *  （validation-52vHk6：plan.terminal 落在 (42,1)、上方是出口，兜底轮每轮都放不出、layout.oneOffLeftover 判红） */
    buildable(x, y) {
        const edgeY = y === 1 ? [[x - 1, 0], [x, 0], [x + 1, 0]] : y === 48 ? [[x - 1, 49], [x, 49], [x + 1, 49]] : null;
        const edgeX = x === 1 ? [[0, y - 1], [0, y], [0, y + 1]] : x === 48 ? [[49, y - 1], [49, y], [49, y + 1]] : null;
        const tiles = edgeY || edgeX;
        if (!tiles) return true;
        return tiles.every(([ex, ey]) => ((Number(this.terrain.charAt(ey * 50 + ex)) || 0) & 1) !== 0);
    }

    claim(position) {
        if (!position || !this.free(position.x, position.y)) return null;
        const result = { x: position.x, y: position.y };
        this.used.add(`${result.x}.${result.y}`);
        return result;
    }

    near(target, options) {
        const opts = options || {};
        const minRange = opts.minRange == null ? 1 : opts.minRange;
        const maxRange = opts.maxRange == null ? 12 : opts.maxRange;
        const extra = typeof opts.filter === 'function' ? opts.filter : () => true;
        for (let range = minRange; range <= maxRange; range++) {
            const candidates = [];
            for (let dy = -range; dy <= range; dy++) {
                for (let dx = -range; dx <= range; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
                    const position = { x: target.x + dx, y: target.y + dy };
                    if (!this.free(position.x, position.y) || !extra(position)) continue;
                    // structure: true ⇒ 这个位置之后要由游戏代码放工地（不是道路/容器），只取引擎放得出工地的格
                    if (opts.structure && !this.buildable(position.x, position.y)) continue;
                    candidates.push(position);
                }
            }
            candidates.sort((left, right) => {
                const leftManhattan = Math.abs(left.x - target.x) + Math.abs(left.y - target.y);
                const rightManhattan = Math.abs(right.x - target.x) + Math.abs(right.y - target.y);
                return leftManhattan - rightManhattan || left.y - right.y || left.x - right.x;
            });
            if (candidates.length) return this.claim(candidates[0]);
        }
        throw new Error(`No free position near ${target.x},${target.y}`);
    }
}

async function generateWorld(cli) {
    const fixedFile=process.env.VALIDATION_TERRAIN_FIXTURE;
    const fixed=fixedFile ? JSON.parse(fs.readFileSync(fixedFile,'utf8')).rooms : null;
    await cli.run('system.pauseSimulation()', { timeoutMs: 8000 });
    for (const spec of GENERATION) {
        const exists = await cli.evaluateJson(
            `storage.db.rooms.findOne({_id:${literal(spec.room)}}).then(function(room){return !!room})`);
        if (exists) throw new Error(`Validation room already exists in fresh world: ${spec.room}`);
        const options = {
            terrainType: spec.terrainType,
            swampType: spec.swampType,
            sources: spec.sources,
            mineral: spec.mineral,
            controller: true,
        };
        if (fixed || spec.room === ROOMS.upgraderActualRoute) {
            const seed=spec.room === ROOMS.upgraderActualRoute ? {terrain:UPGRADER_ROUTE.terrain,objects:UPGRADER_ROUTE.neutral} : fixed[spec.room];
            if (!seed || typeof seed.terrain!=='string' || seed.terrain.length!==2500 || !Array.isArray(seed.objects) ||
                seed.objects.filter(o=>o.type==='source').length!==spec.sources ||
                seed.objects.filter(o=>o.type==='controller').length!==1 ||
                seed.objects.some(o=>o.room!==spec.room || !['source','controller','mineral'].includes(o.type) || o.user || o.reservation))
                throw new Error('Invalid neutral terrain fixture for '+spec.room);
            await cli.evaluateJson(`Promise.all([storage.db.rooms.insert({_id:${literal(spec.room)},status:'normal',sourceKeepers:false}),storage.db['rooms.terrain'].insert({room:${literal(spec.room)},type:'terrain',terrain:${literal(seed.terrain)}}),storage.db['rooms.objects'].insert(${literal(seed.objects)})]).then(()=>true)`,{timeoutMs:60000});
        } else await cli.evaluateJson(`map.generateRoom(${literal(spec.room)},${literal(options)})`, { timeoutMs: 60000 });
    }
    await cli.evaluateJson('map.updateTerrainData()', { timeoutMs: 60000 });
    await ensureTerrainNeighbors(cli);
    // 过境房（VALIDATE_CONQUEST）内部固定成全平地，只保留（已与邻房协调好的）边界——保证绕塔通道稳定存在，
    // 让 conquest.transitTowerAvoid 断言确定性（否则随机地形有时把唯一通路挤到塔边，minDist 忽 9 忽 2 假性失败）。
    if (process.env.VALIDATE_CONQUEST && ROOMS.conquestTransit) {
        const cur = await cli.evaluateJson(
            `storage.db['rooms.terrain'].findOne({room:${literal(ROOMS.conquestTransit)}}).then(function(r){return r&&r.terrain})`, { timeoutMs: 30000 });
        if (typeof cur === 'string' && cur.length === 2500) {
            let open = '';
            for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) {
                const border = x === 0 || x === 49 || y === 0 || y === 49;
                open += border ? cur[y * 50 + x] : '0';   // 边界保持不动，内部全开
            }
            await cli.evaluateJson(
                `storage.db['rooms.terrain'].update({room:${literal(ROOMS.conquestTransit)}},{$set:{terrain:${literal(open)}}})`, { timeoutMs: 30000 });
            await cli.evaluateJson('map.updateTerrainData()', { timeoutMs: 60000 });
        }
    }
    await cli.evaluateJson(
        `storage.db.rooms.find({status:'normal'}).then(function(rooms){var names=rooms.map(function(room){return room._id});return Promise.all([storage.env.set(storage.env.keys.ACCESSIBLE_ROOMS,JSON.stringify(names)),storage.env.set(storage.env.keys.ROOM_STATUS_DATA,JSON.stringify({novice:{},respawn:{},closed:{}}))]).then(function(){return names.length})})`,
        { timeoutMs: 30000 });
    await cli.evaluateJson(
        `storage.db.users.find({bot:{$exists:true}}).then(function(users){return Promise.all(users.map(function(user){return storage.db.users.update({_id:user._id},{$set:{active:0,cpu:0}})}))}).then(function(){return true})`,
        { timeoutMs: 30000 });
    await waitForGeneratedRooms(cli);
}

async function spawnBot(cli, scenarioName, roomName) {
    const username = USERNAMES[scenarioName];
    await cli.evaluateJson(
        `bots.spawn('project',${literal(roomName)},{username:${literal(username)},cpu:140,gcl:8}).then(function(){return storage.db.users.findOne({username:${literal(username)}})}).then(function(user){return storage.db.users.update({_id:user._id},{$set:{active:0,cpu:0}})})`,
        { timeoutMs: 30000 });
    const context = await cli.evaluateJson(
        `Promise.all([storage.db.users.findOne({username:${literal(username)}}),storage.db['rooms.terrain'].findOne({room:${literal(roomName)}}),storage.db['rooms.objects'].find({room:${literal(roomName)}}),storage.env.get(storage.env.keys.GAMETIME)]).then(function(values){var user=values[0];return {userId:String(user._id),username:user.username,terrain:values[1].terrain,objects:values[2].map(function(object){return {_id:String(object._id),type:object.type,structureType:object.structureType,x:object.x,y:object.y,name:object.name,user:object.user}}),gameTime:+values[3]}})`,
        { timeoutMs: 30000 });
    const spawn = context.objects.find((object) => object.type === 'spawn' && String(object.user) === context.userId);
    const controller = context.objects.find((object) => object.type === 'controller');
    const sources = context.objects.filter((object) => object.type === 'source')
        .sort((left, right) => String(left._id).localeCompare(String(right._id)));
    const mineral = context.objects.find((object) => object.type === 'mineral');
    if (!spawn || !controller || sources.length !== 2) {
        throw new Error(`Incomplete generated room ${roomName}`);
    }
    return Object.assign(context, {
        scenarioName,
        room: roomName,
        spawn,
        controller,
        sources,
        mineral,
        allocator: new PositionAllocator(context.terrain, context.objects),
        creepPositions: new Set(),
        inserted: [],
        creepMemory: {},
    });
}

async function updateController(cli, context, level) {
    const progressTotals = { 1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 3645000, 7: 10935000, 8: 0 };
    const update = {
        user: context.userId,
        level,
        progress: 0,
        progressTotal: progressTotals[level],
        downgradeTime: context.gameTime + 200000,
        safeMode: null,
        safeModeAvailable: level >= 3 ? 3 : 0,
    };
    await cli.evaluateJson(
        `storage.db['rooms.objects'].update({_id:${literal(context.controller._id)}},{$set:${literal(update)}}).then(function(){return true})`);
    context.rcl = level;
}

async function setSpawnEnergy(cli, context, energy) {
    await cli.evaluateJson(
        `storage.db['rooms.objects'].update({_id:${literal(context.spawn._id)}},{$set:{store:{energy:${Number(energy)}}}}).then(function(){return true})`);
}

function structureDocument(context, type, position, options) {
    const opts = options || {};
    const hits = opts.hits == null ? HITS[type] || 1000 : opts.hits;
    const document = {
        type,
        room: context.room,
        x: position.x,
        y: position.y,
        hits,
        hitsMax: opts.hitsMax == null ? Math.max(hits, HITS[type] || hits) : opts.hitsMax,
    };
    const neutral = type === 'container' || type === 'road' || type === 'constructedWall';
    if (!neutral) document.user = context.userId;
    if (opts.store) document.store = Object.assign({}, opts.store);
    if (opts.capacity) {
        const capacity = Object.assign({}, opts.capacity);
        if (RESOURCE_CAPACITY_TYPES.has(type)) {
            document.storeCapacityResource = capacity;
        } else if (SCALAR_CAPACITY_TYPES.has(type)) {
            document.storeCapacity = opts.storeCapacity == null
                ? Object.values(capacity).reduce((sum, value) => sum + Number(value || 0), 0)
                : Number(opts.storeCapacity);
        } else if (type === 'lab') {
            document.storeCapacityResource = capacity;
            document.storeCapacity = opts.storeCapacity == null
                ? Number(capacity.energy || 0) + Number(opts.mineralCapacity == null ? LAB_MINERAL_CAPACITY : opts.mineralCapacity)
                : Number(opts.storeCapacity);
        }
    }
    if (opts.cooldown != null) document.cooldown = opts.cooldown;
    if (type === 'container') document.decayTime = context.gameTime + 100000;
    if (type === 'rampart') {
        document.hits = opts.hits == null ? 1 : opts.hits;
        document.hitsMax = opts.hitsMax == null ? 300000000 : opts.hitsMax;
        document.isPublic = false;
    }
    if (type === 'extractor') document.cooldown = opts.cooldown || 0;
    return document;
}

async function insertObject(cli, context, document) {
    const result = await cli.evaluateJson(
        `storage.db['rooms.objects'].insert(${literal(document)}).then(function(object){return {_id:String(object._id),type:object.type,x:object.x,y:object.y}})`);
    const record = Object.assign({}, document, result);
    context.inserted.push(record);
    return record;
}

async function addStructure(cli, context, type, position, options) {
    return insertObject(cli, context, structureDocument(context, type, position, options));
}

async function addSite(cli, context, type, position, progress) {
    return insertObject(cli, context, {
        type: 'constructionSite',
        structureType: type,
        room: context.room,
        x: position.x,
        y: position.y,
        user: context.userId,
        progress: Number(progress || 0),
        progressTotal: SITE_COST[type] || 1000,
    });
}

function positionKey(position) {
    return `${position.x}.${position.y}`;
}

function positionObjects(context, position) {
    return (context.objects || []).concat(context.inserted || [])
        .filter((object) => object && object.x === position.x && object.y === position.y);
}

function isCreepPositionValid(context, position) {
    if (!position || !Number.isInteger(position.x) || !Number.isInteger(position.y) ||
        position.x < 0 || position.x > 49 || position.y < 0 || position.y > 49) return false;
    const objects = positionObjects(context, position);
    const hasRoad = objects.some((object) => object.type === 'road');
    if (context.allocator.wall(position.x, position.y) && !hasRoad) return false;
    return objects.every((object) => {
        const type = object.type === 'constructionSite' ? object.structureType : object.type;
        return CREEP_WALKABLE_OVERLAYS.has(type) || !CREEP_OBSTACLE_TYPES.has(type);
    });
}

function claimCreepPosition(context, position) {
    const key = positionKey(position);
    if (context.creepPositions.has(key) || !isCreepPositionValid(context, position)) return null;
    context.creepPositions.add(key);
    return { x: position.x, y: position.y };
}

function creepPosition(context, target, exact) {
    if (exact) {
        const key = positionKey(target);
        if (!context.creepPositions.has(key) && isCreepPositionValid(context, target)) {
            return { x: target.x, y: target.y };
        }
    }
    for (let range = 1; range <= 48; range++) {
        for (let dy = -range; dy <= range; dy++) {
            for (let dx = -range; dx <= range; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
                const position = { x: target.x + dx, y: target.y + dy };
                const key = positionKey(position);
                if (!context.creepPositions.has(key) && isCreepPositionValid(context, position)) {
                    return position;
                }
            }
        }
    }
    throw new Error(`No creep position near ${target.x},${target.y}`);
}

async function addCreep(cli, context, options) {
    const opts = options || {};
    const dead = new Set(opts.dead || []);   // 这些种类的部件播成 0 血（残废 creep 场景；引擎从前往后掉血，0 血部件要排在身体前面）
    const body = (opts.body || ['work', 'carry', 'move']).map((type) => ({ type, hits: dead.has(type) ? 0 : 100 }));
    const carry = body.filter((part) => part.type === 'carry' && part.hits > 0).length;
    const position = opts.position || creepPosition(context, context.spawn, false);
    if (opts.position && (!Number.isInteger(position.x) || !Number.isInteger(position.y) ||
        position.x < 0 || position.x > 49 || position.y < 0 || position.y > 49)) {
        throw new Error(`Invalid creep position ${position && position.x},${position && position.y}`);
    }
    if (!opts.room || opts.room === context.room) {
        if (!claimCreepPosition(context, position)) {
            throw new Error(`Invalid or occupied creep position ${position.x},${position.y}`);
        }
    }
    const document = {
        name: opts.name,
        type: 'creep',
        room: opts.room || context.room,
        x: position.x,
        y: position.y,
        user: opts.user || context.userId,
        body,
        hits: body.reduce((sum, part) => sum + part.hits, 0),
        hitsMax: body.length * 100,
        spawning: false,
        fatigue: 0,
        notifyWhenAttacked: false,
        store: { energy: Math.min(carry * 50, Number(opts.energy || 0)) },
        storeCapacity: carry * 50,
        // ticksToLive：默认按身体给满寿命（CLAIM 600、其余 1500）；显式给出时用它——播"寿命将尽、该换代了"的 creep
        ageTime: context.gameTime + (opts.ticksToLive != null ? Number(opts.ticksToLive)
            : (body.some((part) => part.type === 'claim') ? 600 : 1500)),
    };
    await insertObject(cli, context, document);
    context.creepMemory[opts.name] = Object.assign({ home: context.room, role: opts.role }, opts.memory || {});
    return document;
}

async function addExtensions(cli, context, count, energy) {
    const positions = [];
    const capacity = context.rcl >= 8 ? 200 : context.rcl >= 7 ? 100 : 50;
    for (let index = 0; index < count; index++) {
        // 棋盘格放置：紧挨 spawn 的整圈 extension 会把孵出来的 creep 围死（PathFinder 默认不算建筑，看起来有路其实 moveTo 全是 NO_PATH）
        const position = context.allocator.near(context.spawn, {
            minRange: 2, maxRange: 14, filter: (pos) => (pos.x + pos.y) % 2 === 0,
        });
        positions.push(position);
        await addStructure(cli, context, 'extension', position, {
            store: { energy: Math.min(capacity, energy == null ? capacity : energy) },
            capacity: { energy: capacity },
        });
    }
    return positions;
}

/** options 透传给 structureDocument（hits / hitsMax）。2026-09-07 修：这个形参一直不存在，
 *  而 seedLogistics 从 2026-09-06 起就在传第 5 个实参（源容器 40000、控制器容器 125000），被静默忽略——
 *  容器全部按默认 250000 播下，于是 tower.maintenanceBudget（断言源容器 > 40000）与 upgrade.repairStation
 *  （断言控制器容器 > 125000）都在平凡通过：实际末值 235000–240000 是满血自然衰减的结果，
 *  两条断言从未真正观察到"塔按比例先修容器"和"升级者修站位容器"。 */
async function addEnergyContainer(cli, context, target, energy, options) {
    const position = nearOrNull(context.allocator, target, { minRange: 1, maxRange: 1 }) ||
        nearOrNull(context.allocator, target, { minRange: 1, maxRange: 3 });
    if (!position) {
        throw new Error(`No free container position near ${target.x},${target.y}`);
    }
    const object = await addStructure(cli, context, 'container', position, Object.assign({
        store: { energy: Number(energy || 0) },
        capacity: { energy: 2000 },
    }, options || {}));
    return { position, object };
}

/** 打开强化的最小指令（2026-10-14 复审：task_broker 只在强化打开时给 boost lab 补能量）：带 boosts、0 破防 0 护卫——
 *  conquest.getDemands 对它不出任何孵化需求，目标房没有视野 runOne 也不动它，只让 conquest.boostingEnabled() 为真。
 *  这正是线上打开强化的方式（指令里写 boosts；部署会把 config 重置回默认） */
function boostDirective(home) {
    return { target: 'W99N99', sponsors: [home], dismantlers: 0, guards: 0, boosts: { dismantler: ['XZH2O'], guard: [] } };
}

async function writeMemory(cli, context, memory) {
    const value = Object.assign({}, memory || {});
    value.creeps = Object.assign({}, value.creeps || {}, context.creepMemory);
    await cli.evaluateJson(
        `storage.env.set(storage.env.keys.MEMORY+${literal(context.userId)},${literal(JSON.stringify(value))}).then(function(){return true})`);
    context.initialMemory = value;
}

function emptyPlan(context) {
    return {
        anchor: { x: context.spawn.x, y: context.spawn.y },
        made: context.gameTime,
        sourceIds: context.sources.map((source) => source._id),
        containers: {},
        roads: {},
        ext: [],
        towers: [],
        spawns: [{ x: context.spawn.x, y: context.spawn.y }],
        spawn2: [],
        spawn3: [],
        labs: [],
        links: {},
        structures: {},
        workPositions: {},
    };
}

async function seedUpgraderActualRoute(cli) {
    const context = await spawnBot(cli, 'upgraderActualRoute', ROOMS.upgraderActualRoute);
    await updateController(cli, context, 6);
    // Mineral extraction is outside this handoff scenario; retain its obstacle geometry.
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(context.mineral._id)}},{$set:{mineralAmount:0,nextRegenerationTime:100000}}).then(()=>true)`);
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(context.spawn._id)}},{$set:{x:27,y:18},$merge:{store:{energy:300}}}).then(()=>true)`);
    context.spawn.x=27; context.spawn.y=18;
    const plan=JSON.parse(JSON.stringify(UPGRADER_ROUTE.plan));
    plan.made=context.gameTime;
    for (const object of UPGRADER_ROUTE.structures) {
        if (object.type==='spawn') continue;
        const energy=object.type==='storage' ? 25000 : object.type==='extension' ? 50 :
            object.type==='link' ? 800 : object.type==='container' ? 2000 : object.type==='tower' ? 1000 : 0;
        const capacity={storage:1000000,extension:50,link:800,container:2000,tower:1000}[object.type];
        await addStructure(cli,context,object.type,object,{store:capacity?{energy}:undefined,capacity:capacity?{energy:capacity}:undefined});
    }
    // Storage stays below builderUpgradeAbove: supplied builders must not occupy the upgrader station.
    // Fixed live structures and terrain, while dynamic funding/population are controlled test inputs.
    context.allocator=new PositionAllocator(context.terrain,context.objects.concat(context.inserted));
    for (let i=0;i<context.sources.length;i++) {
        await addCreep(cli,context,{name:'route-core-miner-'+i,role:'harvester',body:['work','work','work','work','work','carry','move'],
            position:plan.containers['src'+i],memory:{sourceIdx:i,sourceId:context.sources[i]._id,staticMiner:true}});
    }
    const count=Number(loadSrcModule('config').hauling.ceil[6]);
    for (let i=0;i<count;i++) await addCreep(cli,context,{name:'route-core-hauler-'+i,role:'hauler',
        body:loadSrcModule('utils').makeBody('hauler',2300),position:creepPosition(context,{x:12,y:30},false)});
    for (let i=0;i<Number(loadSrcModule('config').construction.maxBuilders[6]);i++) await addCreep(cli,context,{name:'route-core-builder-'+i,role:'builder',body:loadSrcModule('utils').makeBody('builder',2300),position:creepPosition(context,{x:12,y:30},false)});
    await addCreep(cli,context,{name:'route-core-feeder',role:'feeder',body:['carry','carry','carry','carry','move','move'],position:creepPosition(context,{x:12,y:30},false)});
    await addCreep(cli,context,{name:'route-core-scout',role:'scout',body:['move'],position:creepPosition(context,{x:12,y:30},false)});
    await addCreep(cli,context,{name:'route-incumbent',role:'upgrader',body:UPGRADER_ROUTE.body,
        position:{x:32,y:40},energy:100,ticksToLive:UPGRADER_ROUTE.incumbentTtl});
    // 播种 tick 单独记下：一期起服到暂停之间引擎偶尔多跑一 tick（validation-2Av9CU 播种时 gameTime=2），incumbent 的 ageTime 是
    // 播种 tick + incumbentTtl，不是常数 601。run_validation.prepareUpgraderRoute 与生效断言按这个值换算，不写死绝对 tick
    await writeMemory(cli,context,{_fixtureSeedAt:context.gameTime,rooms:{[context.room]:{plan,layoutAt:context.gameTime,
        spawnIncome:{at:context.gameTime,energy:2300,ema:20},upgradeSupply:{at:context.gameTime,ema:0,extra:0,changedAt:context.gameTime},
        state:{recovering:false},remotes:{}}},brain:{version:1,issuedAt:Date.now(),ttlMs:86400000,rooms:{[context.room]:{remotes:[],scouts:0}}}});
    return context;
}

/** 测试专用的主循环包装（追加在用户 main 模块末尾，只在私服里装）。backend 重启会从 project-bot 重新加载代码、把包装冲掉
 *  （validation-xKltxj：backend 在 t566–573 崩溃重启后包装没了，之后的升级事件一条都没记），所以每个包装带一个唯一标记，
 *  run_validation.ensureWrappers 按标记检查、丢了就重装。 */
const ROUTE_OBSERVER_MARK = 'const routeObservedLoop';
const FEED_OBSERVER_MARK = 'const feedObservedLoop';
const REPAIR_OBSERVER_MARK = 'const repairObservedLoop';

/** proof.arrival[id]：非 incumbent 的升级者第一次进到控制器 3 格内（能开始升级的那一 tick）时，身上与站位的能量。
 *  validation-xKltxj 的失败只能推测"到岗时站位没能量"，这里把到岗瞬间记下来，下一次失败可以直接解释（不改变前提，不补能量） */
function upgraderActualRouteObserver(roomName) {
    return `
;${ROUTE_OBSERVER_MARK}=module.exports.loop;module.exports.loop=function(){routeObservedLoop();const room=Game.rooms[${JSON.stringify(roomName)}];if(!room)return;const proof=Memory._upgraderRouteProof||(Memory._upgraderRouteProof={events:{}});const home=Memory.rooms&&Memory.rooms[room.name];if(!proof.leg&&home&&home.upgraderLeg)proof.leg=Object.assign({},home.upgraderLeg);if(!proof.spawn&&home&&home.spawnLog){const spawned=home.spawnLog.find(e=>e.key.startsWith('core:upgrader:'));if(spawned)proof.spawn=Object.assign({},spawned);}for(const e of room.getEventLog()){if(e.event!==EVENT_UPGRADE_CONTROLLER)continue;const creep=Game.getObjectById(e.objectId);if(creep&&creep.memory.role==='upgrader'&&!proof.events[e.objectId])proof.events[e.objectId]={observedAt:Game.time,event:e};}try{const ctrl=room.controller;if(!ctrl)return;const arrival=proof.arrival||(proof.arrival={});for(const creep of room.find(FIND_MY_CREEPS)){if(creep.spawning||creep.name==='route-incumbent'||!creep.memory||creep.memory.role!=='upgrader'||arrival[creep.id])continue;if(Math.max(Math.abs(creep.pos.x-ctrl.pos.x),Math.abs(creep.pos.y-ctrl.pos.y))>3)continue;const station=room.find(FIND_STRUCTURES).filter(s=>(s.structureType==='container'||s.structureType==='link')&&Math.max(Math.abs(s.pos.x-ctrl.pos.x),Math.abs(s.pos.y-ctrl.pos.y))<=2).map(s=>[s.structureType,s.pos.x,s.pos.y,s.store?s.store.energy:0]);arrival[creep.id]={t:Game.time,name:creep.name,x:creep.pos.x,y:creep.pos.y,carried:creep.store.energy,station,storage:room.storage?room.storage.store.energy:null,incumbentAlive:!!Game.creeps['route-incumbent']};}}catch(err){proof.arrivalError=String(err&&err.message||err);}};
`;
}

/** upgrade.storageRich 的机制闩锁：storage 的能量真的进了升级。逐 tick 读本房事件日志——
 *  withdraw 记在被取的建筑名下（objectId = storage，data.targetId = creep），transfer 记在 creep 名下。
 *  direct：升级者直接从 storage 取（storage 供能的几何）；hauled：从 storage 取货的 creep 送进控制器容器/ctrl link 的量
 *  （按每只 creep 身上"来自 storage 的货"记账，送去别处——spawn/extension/送回 storage——的先从这笔里扣，宁少记不多记，
 *  不把源容器的货算进来）；link：store link → ctrl link。
 *  末态 storage 水位取决于随机地形里 storage 到控制器的距离（validation-jcpzXR 28 格、link 供能，只降到 74161），不能当判据 */
function storageUpgradeFeedObserver(roomName) {
    return `
;${FEED_OBSERVER_MARK}=module.exports.loop;module.exports.loop=function(){feedObservedLoop();try{const room=Game.rooms[${JSON.stringify(roomName)}];if(!room||!room.storage||!room.controller)return;const rt=global.__feedObserver||(global.__feedObserver={cargo:{}});const rec=Memory._storageUpgradeFeed||(Memory._storageUpgradeFeed={direct:0,hauled:0,link:0,withdrawn:0,total:0});const plan=(Memory.rooms&&Memory.rooms[room.name]&&Memory.rooms[room.name].plan)||{};const spot=plan.containers&&plan.containers.ctrl;const container=spot?room.lookForAt(LOOK_STRUCTURES,spot.x,spot.y).find(s=>s.structureType===STRUCTURE_CONTAINER):null;let ctrlLink=null,storeLink=null;try{ctrlLink=require('links').getLink(room,plan,'ctrl');storeLink=require('links').storeLinkReady(room,plan);}catch(e){}const sinks={};if(container)sinks[container.id]=true;if(ctrlLink)sinks[ctrlLink.id]=true;const storageId=room.storage.id;for(const e of room.getEventLog()){if(e.event!==EVENT_TRANSFER||!e.data||e.data.resourceType!==RESOURCE_ENERGY)continue;const amount=Number(e.data.amount)||0;if(e.objectId===storageId){const creep=Game.getObjectById(e.data.targetId);if(creep&&creep.memory&&creep.memory.role==='upgrader')rec.direct+=amount;else{rt.cargo[e.data.targetId]=(rt.cargo[e.data.targetId]||0)+amount;rec.withdrawn+=amount;}}else if(storeLink&&e.objectId===storeLink.id&&ctrlLink&&e.data.targetId===ctrlLink.id){rec.link+=amount;}else if(rt.cargo[e.objectId]){const cargo=rt.cargo[e.objectId];if(sinks[e.data.targetId]){const credited=Math.min(cargo,amount);rec.hauled+=credited;rt.cargo[e.objectId]=cargo-credited;}else{rt.cargo[e.objectId]=Math.max(0,cargo-amount);}}}const total=rec.direct+rec.hauled+rec.link;if(total!==rec.total){rec.total=total;rec.at=Game.time;if(rec.firstAt==null)rec.firstAt=Game.time;}if(Game.time%100===0)for(const id of Object.keys(rt.cargo))if(!rt.cargo[id]||!Game.getObjectById(id))delete rt.cargo[id];}catch(err){Memory._storageUpgradeFeedError=String(err&&err.message||err);}};
`;
}

/** maintenance.repairPoolNeutral 的闩锁：broker 维修池里第一次出现中立建筑（道路/容器）的那一 tick。
 *  维修池每 tick 现算、不落 Memory，单次中途快照会错过窗口（容器修到 60% 就离池）；闩锁住后不再计算，省 CPU */
function repairPoolNeutralObserver(roomName) {
    return `
;${REPAIR_OBSERVER_MARK}=module.exports.loop;module.exports.loop=function(){repairObservedLoop();try{if(Memory._repairPoolNeutral)return;const room=Game.rooms[${JSON.stringify(roomName)}];if(!room)return;const tasks=require('task_broker').roomTasks(room).filter(t=>t.kind==='repair'&&t.target&&(t.target.structureType===STRUCTURE_ROAD||t.target.structureType===STRUCTURE_CONTAINER));if(tasks.length){const t=tasks[0];Memory._repairPoolNeutral={t:Game.time,type:t.target.structureType,backlog:t.backlog,n:tasks.length,x:t.target.pos.x,y:t.target.pos.y};}}catch(err){Memory._repairPoolNeutralError=String(err&&err.message||err);}};
`;
}

async function seedBootstrap(cli) {
    const context = await spawnBot(cli, 'bootstrap', ROOMS.bootstrap);
    await updateController(cli, context, 1);
    await setSpawnEnergy(cli, context, 300);
    // roadsMinRcl 之前放下的存量路工地（线上 W33S3/W31S5 各 24 条零进度）：RCL1 的房应把零进度的清掉、有进度的留着
    for (let index = 0; index < 5; index++) {
        const position = context.allocator.near(context.spawn, { minRange: 2, maxRange: 8 });
        await insertObject(cli, context, {
            type: 'constructionSite', structureType: 'road', room: context.room, x: position.x, y: position.y,
            user: context.userId, progress: index === 0 ? 120 : 0, progressTotal: SITE_COST.road || 300,
        });
    }
    await writeMemory(cli, context, {});
    return context;
}

async function seedRecovery(cli) {
    const context = await spawnBot(cli, 'recovery', ROOMS.recovery);
    await updateController(cli, context, 2);
    await setSpawnEnergy(cli, context, 175);
    await addCreep(cli, context, {
        name: 'fixture-hauler',
        role: 'hauler',
        body: ['carry', 'carry', 'move'],
        energy: 0,
    });
    const plan = emptyPlan(context);
    // 同一用户第二房：RCL4、核心容器全缺、只有 1 只静态矿工 → recovering。旧代码把 builder 目标清零，
    // 静态矿工没 CARRY 也建不了容器。生效断言看 Memory.rooms[containerGap].containerGapBuilder。
    const gap = await roomContextFor(cli, context, ROOMS.containerGap);
    await updateController(cli, gap, 4);
    const gapSpawnPos = gap.allocator.near(gap.controller, { minRange: 4, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    const gapSpawnDoc = Object.assign(structureDocument(gap, 'spawn', gapSpawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'GapSpawn', spawning: null, notifyWhenAttacked: false });
    gap.spawn = await insertObject(cli, gap, gapSpawnDoc);
    const src0 = gap.allocator.near(gap.sources[0], { minRange: 1, maxRange: 1 });
    const src1 = gap.allocator.near(gap.sources[1], { minRange: 1, maxRange: 1 });
    const ctrlSpot = gap.allocator.near(gap.controller, { minRange: 1, maxRange: 3 });
    await addCreep(cli, gap, {
        name: 'gap-harvester-0',
        role: 'harvester',
        body: ['work', 'work', 'work', 'work', 'work', 'move', 'move', 'move'],
        position: creepPosition(gap, src0, true),
        memory: { sourceIdx: 0, sourceId: gap.sources[0]._id, staticMiner: true, home: ROOMS.containerGap },
    });
    const gapPlan = Object.assign(emptyPlan(gap), { wheel: true, version: 'validation-container-gap' });
    gapPlan.containers.src0 = src0;
    gapPlan.containers.src1 = src1;
    gapPlan.containers.ctrl = ctrlSpot;
    Object.assign(context.creepMemory, gap.creepMemory);
    await writeMemory(cli, context, { rooms: { [context.room]: { plan }, [gap.room]: { plan: gapPlan } } });
    return context;
}

async function seedLogistics(cli) {
    const context = await spawnBot(cli, 'logistics', ROOMS.logistics);
    await updateController(cli, context, 4);
    // spawn 只播 100：让 spawn/ext 一开始就有缺口，下面 100 能量的塔（低于维修储备）必须压过它先补——紧急塔第 1 层的生效断言看 towerFirstAt
    await setSpawnEnergy(cli, context, 100);
    const extensions = await addExtensions(cli, context, 20, 50);
    // 源容器播成 16% 血（40000/250000）：塔按"离维修目标还剩几成"排序时它排第一；按绝对血量排则永远输给
    // 下面那条 2580/5000（52%）的路——线上 W34S7 正是如此，60 处破损里最低的四个全是路，两个源容器一路从 77k 跌到 62k
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 1800, { hits: 40000 }));
    const decayedRoadPos = context.allocator.near(context.spawn, { minRange: 1, maxRange: 3 });
    await addStructure(cli, context, 'road', decayedRoadPos, { hits: 2580, hitsMax: 5000 });
    // 控制器容器播成半血（125000/250000）：容器每 tick 衰减 10 血，没人修就一路烂到消失（线上 W35S7 只剩上限的 7%）；
    // 升级者站在它旁边、手里有能量，修 100 血只要 1 能量——报告时它必须比播下时更高（upgrade.repairStation）
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1800, { hits: 125000 });
    const plan = emptyPlan(context);
    plan.ext = extensions;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;

    for (let index = 0; index < 2; index++) {
        const position = creepPosition(context, sourceContainers[index].position, true);
        await addCreep(cli, context, {
            name: `fixture-harvester-${index}`,
            role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            position,
            memory: { sourceIdx: index, sourceId: context.sources[index]._id },
        });
    }
    // This is a logistics/feeder fixture, not a low-capacity fleet recovery test.
    // Seed the RCL4 fleet at room capacity: 4-CARRY fixtures drove demand to 5
    // and kept feeder behind hauler replacements for the entire 770-tick gate.
    const logisticsHaulerBody = loadSrcModule('utils').makeBody('hauler', 1300);
    for (let index = 0; index < 3; index++) {
        await addCreep(cli, context, {
            name: `fixture-hauler-${index}`,
            role: 'hauler',
            body: logisticsHaulerBody,
        });
    }
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `fixture-upgrader-${index}`,
            role: 'upgrader',
            body: ['work', 'work', 'work', 'carry', 'carry', 'move'],
            position: creepPosition(context, controllerContainer.position, index === 0),
            energy: 100,
        });
    }
    // 富余的 storage（4 万）+ 容器供能的控制器：storage 取货必须只是源容器空了之后的兜底（A/B：压过源容器让矿工溢出衰减、总 CP −5%）。
    // 进方案（plan.storage）并把方案标成轮子产出（plan.wheel）：否则游戏内轮子规划器会另出一份方案，demolition 把播的 storage 当"占配额的方案外建筑"
    // 拆掉换位（第一次验证：第 198 tick cap-replace，4 万能量掉在地上）
    // storage 落点直接按 feeder 的前提条件筛选，而不是"离控制器 5–12 格里随便一格"——否则地形一变断言就误报
    // （2026-09-06 至 07 一晚里 logistics/aid 的三条断言各自在相同游戏代码下失败过，全由随机地形决定）：
    //   ≥ 5 格离控制器：storage 旁若有升级站位，房间会切成"升级者直接从 storage 取"的模式，broker 不喂容器、feeder 目标为 0；
    //   ≤ 12 格离控制器容器：feeder 的判据是 storage → 控制器容器 ≤ upgrading.feederMaxDistance（15），留 3 格余量。
    // 上限原为 9，控制器随机落在房间边角时（validation-fnd8RZ：48,40）5–9 环几乎全在图外，播种直接抛 No free position
    const ctrlContainerPos = controllerContainer.position;
    const feederReach = (pos) => Math.max(Math.abs(pos.x - ctrlContainerPos.x), Math.abs(pos.y - ctrlContainerPos.y)) <= 12;
    const storagePos = context.allocator.near(context.controller, { minRange: 5, maxRange: 12, filter: feederReach });
    if (!feederReach(storagePos)) {
        throw new Error(`logistics storage ${storagePos.x},${storagePos.y} 离控制器容器 ${ctrlContainerPos.x},${ctrlContainerPos.y} 超过 12 格，feeder 断言无法成立`);
    }
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 40000 }, capacity: { energy: 1000000 } });
    plan.storage = storagePos;
    plan.wheel = true;
    // 一座只剩 100 能量的塔（< towerRepairReserve 500）：hauler 应先补它再补 spawn/ext（进方案免得被拆）
    // 奇偶过滤把候选砍一半，spawn 落在边角/被墙包住时 2–5 环可能一个都不剩（validation-td69Rx：spawn 45,34 直接抛 No free position）：
    // 依次放宽——奇偶 2–5 → 奇偶 2–10 → 不挑奇偶 2–10。塔只要在房里且进方案即可，具体格子不影响任何断言
    const towerPos = nearOrNull(context.allocator, context.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 0 }) ||
        nearOrNull(context.allocator, context.spawn, { minRange: 2, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 }) ||
        context.allocator.near(context.spawn, { minRange: 2, maxRange: 10 });
    await addStructure(cli, context, 'tower', towerPos, { store: { energy: 100 }, capacity: { energy: 1000 } });
    plan.towers = [towerPos];
    const rampartSite = await addSite(cli, context, 'rampart', context.spawn, 0);
    // 第二口源播成采空（等 300 tick 再生）：矿工在岗、容器还在，但源没货——broker 不该再按矿工 WORK 报"进账"，
    // 否则 hauler 守着一个永远不涨的容器（生效断言 broker.drySourceNoInflow）
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(String(context.sources[1]._id))}},`
        + `{$set:{energy:0,ticksToRegeneration:${SOURCE_REGEN_TICKS}}}).then(function(){return true})`);
    await writeMemory(cli, context, { rooms: { [context.room]: { plan } } });
    context.expect = { rampartSiteId: rampartSite._id };
    return context;
}

async function seedLinks(cli) {
    const context = await spawnBot(cli, 'links', ROOMS.links);
    // RCL7：有 store link 时源 link 的能量最终进 storage，hauler 底线可到 linkFloorMinStore 1（hauling.linkFloor 生效断言）
    await updateController(cli, context, 7);
    await setSpawnEnergy(cli, context, 300);
    const src0 = context.allocator.near(context.sources[0], { minRange: 1, maxRange: 1 });
    const src1 = context.allocator.near(context.sources[1], { minRange: 1, maxRange: 1 });
    const ctrl = context.allocator.near(context.controller, { minRange: 1, maxRange: 1 });
    const link0 = await addStructure(cli, context, 'link', src0, {
        store: { energy: 800 }, capacity: { energy: 800 }, cooldown: 0,
    });
    const link1 = await addStructure(cli, context, 'link', src1, {
        store: { energy: 800 }, capacity: { energy: 800 }, cooldown: 0,
    });
    const controlLink = await addStructure(cli, context, 'link', ctrl, {
        store: { energy: 0 }, capacity: { energy: 800 }, cooldown: 0,
    });
    const plan = emptyPlan(context);
    plan.wheel = true;
    plan.links = { src: src0, src0, src1, ctrl };
    plan.workPositions.src0 = src0;
    plan.workPositions.src1 = src1;
    plan.workPositions.ctrl = ctrl;
    // storage 3 万（> hasHomeHaulingSource 的 2 万门槛）：两源都由 link 送能的房里 hauler 只剩 storage → spawn/ext 的补给，
    // 编制该由 link 感知的底线（linkFloorMin 2）决定而不是 RCL6 的 3。离控制器 ≥ 5 格，免得切成升级者贴 storage 的站位模式
    // storage 的落点要能同时摆下 store link 与"贴着两者"的 operator 站位：地图边缘（storage 落到 x/y=1）
    // 时 8 邻域里没有合法格，播种会抛错（随机地形下偶发）。先把"有 hub 格"作为选位条件。
    // 只做可行性检查，不 claim 任何格（allocator.near 会占用格子，用它探测会把候选位置全占掉）
    const hubTileFor = (storage) => {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const link = { x: storage.x + dx, y: storage.y + dy };
                if (!context.allocator.free(link.x, link.y)) continue;
                for (let hx = -1; hx <= 1; hx++) {
                    for (let hy = -1; hy <= 1; hy++) {
                        if (!hx && !hy) continue;
                        const hub = { x: link.x + hx, y: link.y + hy };
                        if (Math.max(Math.abs(hub.x - storage.x), Math.abs(hub.y - storage.y)) > 1) continue;
                        if (isCreepPositionValid(context, hub)) return true;
                    }
                }
            }
        }
        return false;
    };
    const storagePos = context.allocator.near(context.controller, { minRange: 5, maxRange: 12, filter: hubTileFor });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 30000 }, capacity: { energy: 1000000 } });
    plan.storage = storagePos;
    const storeLinkPos = context.allocator.near(storagePos, { minRange: 1, maxRange: 1 });
    await addStructure(cli, context, 'link', storeLinkPos, { store: { energy: 700 }, capacity: { energy: 800 }, cooldown: 0 });
    plan.links.store = storeLinkPos;
    let hubPos = null;
    for (let dx = -1; dx <= 1 && !hubPos; dx++) {
        for (let dy = -1; dy <= 1 && !hubPos; dy++) {
            const position = { x: storeLinkPos.x + dx, y: storeLinkPos.y + dy };
            if (Math.max(Math.abs(position.x - storagePos.x), Math.abs(position.y - storagePos.y)) > 1) continue;
            if (isCreepPositionValid(context, position)) hubPos = position;
        }
    }
    if (!hubPos) throw new Error(`No hub tile between storage ${storagePos.x},${storagePos.y} and store link ${storeLinkPos.x},${storeLinkPos.y}`);
    await addCreep(cli, context, {
        name: 'links-operator',
        role: 'operator',
        body: ['carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'carry', 'move'],
        position: hubPos,
        energy: 0,
    });
    await writeMemory(cli, context, { rooms: { [context.room]: { plan } } });
    context.expect = { sourceLinkIds: [link0._id, link1._id], controllerLinkId: controlLink._id };
    return context;
}

async function seedBlueprint(cli) {
    const context = await spawnBot(cli, 'blueprint', ROOMS.blueprint);
    await updateController(cli, context, 8);
    await setSpawnEnergy(cli, context, 300);
    await writeMemory(cli, context, { rooms: { [context.room]: {} } });
    return context;
}

async function seedIndustry(cli) {
    const context = await spawnBot(cli, 'industry', ROOMS.industry);
    await updateController(cli, context, 8);
    await setSpawnEnergy(cli, context, 300);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 4 });
    const terminalPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 4 });
    const observerPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5 });
    const powerSpawnPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5 });
    const factoryPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5 });
    const nukerPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 6 });
    const storage = await addStructure(cli, context, 'storage', storagePos, {
        store: { energy: 500000 }, capacity: { energy: 1000000 },
    });
    await addStructure(cli, context, 'terminal', terminalPos, {
        store: { energy: 50000 }, capacity: { energy: 300000 }, cooldown: 0,
    });
    const observer = await addStructure(cli, context, 'observer', observerPos);
    const powerSpawn = await addStructure(cli, context, 'powerSpawn', powerSpawnPos, {
        store: { energy: 5000, power: 5 }, capacity: { energy: 5000, power: 100 },
    });
    const factory = await addStructure(cli, context, 'factory', factoryPos, {
        store: { energy: 0 }, capacity: { energy: 50000 }, cooldown: 0,
    });
    const nuker = await addStructure(cli, context, 'nuker', nukerPos, {
        store: { energy: 0, G: 0 }, capacity: { energy: 300000, G: 5000 }, cooldown: 0,
    });
    // lab 位刻意做成「存在合法三连、但顺序是坏的」：一个远处的孤立 lab + 三个互相 ≤2 的簇。
    // plan.labs 写成 [远, 簇A, 簇B, 簇C]，前三个凑不出输出 lab（runReaction 要求两个输入都在 ≤2 内），
    // layout.normalizeLabPlan 必须把簇提到最前——生效断言 layout.labTriple 看的就是这个。
    const labs = [];
    const farLab = await addStructure(cli, context, 'lab', context.allocator.near(context.spawn, { minRange: 8, maxRange: 12 }), {
        store: { energy: 0 }, capacity: { energy: 2000 }, cooldown: 0,
    });
    // 簇心当输出 lab（另外两个都在它的 2 格内，符合 runReaction 的硬条件），两侧装上 H 与 O ⇒ 可合成 OH。
    // industry.deriveReaction 在没有人手配置时就靠这个几何关系认出分工（生效断言 industry.labReactionDerived）
    const clusterAnchor = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5 });
    const clusterLabs = [await addStructure(cli, context, 'lab', clusterAnchor, {
        store: { energy: 2000 }, capacity: { energy: 2000 }, cooldown: 0,
    })];
    const inputMinerals = ['H', 'O'];
    for (let index = 0; index < 2; index++) {
        const position = context.allocator.near(clusterAnchor, { minRange: 1, maxRange: 2 });
        clusterLabs.push(await addStructure(cli, context, 'lab', position, {
            store: { energy: 2000, [inputMinerals[index]]: 3000 },
            capacity: { energy: 2000, [inputMinerals[index]]: 3000 },
            cooldown: 0,
        }));
    }
    labs.push(farLab, ...clusterLabs);
    if (context.mineral) {
        await addStructure(cli, context, 'extractor', { x: context.mineral.x, y: context.mineral.y }, { cooldown: 0 });
    }
    // 2 个满能量的 RCL8 extension（各 200）：大脑按 spawn×300 + extension×200 给矿工定身体（scripts/brain/minerals.py body_for）。
    // 没有 extension 时容量只有 300 → 1W2C2M，100 格要 100 次 × 6 tick = 600 tick 才装满，第一次投递落在 771 tick 的验证窗口之外
    // （minerals.externalDelivery 在每个跑到报告阶段的世界里都确定性失败）。容量 700 时矿脉 < 26 格 → 4W2C3M、装满约 150 tick；
    // ≥ 26 格 → 3W4C4M、装满 200 格约 67 次 × 6 ≈ 400 tick（2026-10-14 更正：随机地形里两种都会出现）。
    // 放在 lab/extractor 之后分配位置，不改动上面 lab 三连的几何；线上没有容量 300 的 RCL6+ 房，这样也更像真实的房
    const extensions = await addExtensions(cli, context, 2);
    // 稳态 RCL8 核心编制（满寿命），照 seedUpgraderActualRoute 的做法：2 只静态矿工（5W1C1M = 容量 700 的理想身体，不出 upgrade:harvester）、
    // hauling.ceil[8] 只 2300 预算的 hauler（只数与 CARRY 都盖住 C*，不出 core:hauler / core:hauler:x）、1 只 700 预算的升级者。
    // 2026-10-14 validation-mZRVaL：零 creep 起步的房要靠落地采把核心编制一只只孵出来（t1/101/251/399/496/584/611/682），
    // 每个核心请求等能量时都挡着后面，opportunistic 的钻机（要满额 700 的大脑身体）到 t751 才轮上、t784 才出生——
    // 矿物场景要观察的是"指令 → 孵钻机 → 采 → 送进 terminal"，不是 RCL8 房从零自举。放在 lab/extractor/extension 之后，不动 lab 三连的几何
    const utilsMod = loadSrcModule('utils');
    for (let i = 0; i < context.sources.length; i++) {
        await addCreep(cli, context, { name: 'industry-core-miner-' + i, role: 'harvester', body: utilsMod.makeBody('harvester', 700),
            position: creepPosition(context, context.sources[i], false),
            memory: { sourceIdx: i, sourceId: context.sources[i]._id, staticMiner: true } });
    }
    const haulerCount = Number(loadSrcModule('config').hauling.ceil[8]);
    for (let i = 0; i < haulerCount; i++) {
        // 分到两个源旁（落地采的取货点），不堆在 spawn / storage 一圈挡钻机出生与出门的路
        await addCreep(cli, context, { name: 'industry-core-hauler-' + i, role: 'hauler', body: utilsMod.makeBody('hauler', 2300),
            position: creepPosition(context, context.sources[i % context.sources.length], false) });
    }
    await addCreep(cli, context, { name: 'industry-core-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 700),
        position: creepPosition(context, context.controller, false) });
    const plan = emptyPlan(context);
    plan.wheel = true;
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.labs = labs.map((lab) => ({ x: lab.x, y: lab.y }));
    plan.structures = {
        observer: observerPos,
        powerSpawn: powerSpawnPos,
        factory: factoryPos,
        nuker: nukerPos,
        extractor: context.mineral && { x: context.mineral.x, y: context.mineral.y },
    };
    await writeMemory(cli, context, {
        rooms: {
            [context.room]: {
                plan,
                industry: { observe: [ROOMS.industryTarget] },
            },
        },
    });
    context.expect = {
        storageId: storage._id,
        observerId: observer._id,
        powerSpawnId: powerSpawn._id,
        factoryId: factory._id,
        nukerId: nuker._id,
    };
    return context;
}

async function seedRemote(cli) {
    const context = await spawnBot(cli, 'remote', ROOMS.remoteHome);
    await updateController(cli, context, 4);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 2000));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1800);
    const plan = emptyPlan(context);
    plan.ext = extensions;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;

    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `remote-home-harvester-${index}`,
            role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id },
        });
        await addCreep(cli, context, {
            name: `remote-home-hauler-${index}`,
            role: 'hauler',
            body: ['carry', 'carry', 'move', 'carry', 'carry', 'move'],
        });
        await addCreep(cli, context, {
            name: `remote-home-upgrader-${index}`,
            role: 'upgrader',
            body: ['work', 'work', 'work', 'carry', 'carry', 'move'],
            position: creepPosition(context, controllerContainer.position, index === 0),
            energy: 100,
        });
    }

    // 在岗的双 CLAIM reserver（寿命将尽，触发换代请求）：换代时母房容量够双 CLAIM 就不许缩身成 1 CLAIM——
    // 1 CLAIM 在岗够把源顶在 3000，但没有缓冲，一死源就掉回 1500 直到替补走完全程（remote.reserverNoShrink）
    await addCreep(cli, context, {
        name: 'remote-reserver',
        role: 'reserver',
        body: ['claim', 'claim', 'move', 'move'],
        room: ROOMS.remote,
        memory: { remoteRoom: ROOMS.remote },
        ticksToLive: 80,
    });

    // 残废 creep（线上 W32S5 被 Invader 打残的阿燐乙）：CARRY 全 0 血的母房 hauler，bot 应在宽限后标记 crippled 回收，而不是让它占编制到老死
    // （不用 remoteHauler：外矿播种时还没登记，remoteHauler 第 1 tick 就走"外矿停用"的既有退役路径，观察不到残废路径）
    await addCreep(cli, context, {
        name: 'remote-crippled-hauler',
        role: 'hauler',
        body: ['carry', 'carry', 'carry', 'carry', 'move', 'move'],
        dead: ['carry'],
    });

    const remoteData = await cli.evaluateJson(
        `Promise.all([storage.db['rooms.terrain'].findOne({room:${literal(ROOMS.remote)}}),storage.db['rooms.objects'].find({room:${literal(ROOMS.remote)}})]).then(function(values){return {terrain:values[0].terrain,objects:values[1].map(function(object){return {_id:String(object._id),type:object.type,x:object.x,y:object.y,energyCapacity:object.energyCapacity}})}})`);
    const remoteSources = remoteData.objects.filter((object) => object.type === 'source')
        .sort((left, right) => String(left._id).localeCompare(String(right._id)));
    const remoteController = remoteData.objects.find((object) => object.type === 'controller');
    const remoteAllocator = new PositionAllocator(remoteData.terrain, remoteData.objects);
    const scoutPosition = remoteAllocator.near(remoteController, { minRange: 2, maxRange: 8 });
    await addCreep(cli, context, {
        name: 'remote-scout',
        role: 'scout',
        body: ['move', 'move'],
        room: ROOMS.remote,
        position: scoutPosition,
        memory: { target: ROOMS.remote },
    });
    // 容器烂掉后留下的零进度路工地（线上 W32S8：6 条 = MAX_REMOTE_SITES 占满，容器工地永远放不出来）：bot 应撤一条路放容器。
    // 离源 ≥ 2 格，不与矿位（源旁 1 格）重叠
    for (let index = 0; index < 6; index++) {
        const position = remoteAllocator.near(remoteSources[0], { minRange: 2, maxRange: 6 });
        await insertObject(cli, context, {
            type: 'constructionSite', structureType: 'road', room: ROOMS.remote, x: position.x, y: position.y,
            user: context.userId, progress: 0, progressTotal: SITE_COST.road || 300,
        });
    }
    // 全账号名额占满（线上 W32S8：四个新房的路工地把账号占到 99–100）：给这个用户在没有它 creep 的房（industryTarget）塞 94 条零进度路工地，
    // 加上外矿的 6 条正好 100——撤路腾出的名额要撑到下一轮 infraTick 容器工地才放得出；容器建成后路也只用保留线以上的名额（remotes[房].roadsHeldAt）
    const fillerData = await cli.evaluateJson(
        `Promise.all([storage.db['rooms.terrain'].findOne({room:${literal(ROOMS.industryTarget)}}),storage.db['rooms.objects'].find({room:${literal(ROOMS.industryTarget)}})]).then(function(values){return {terrain:values[0].terrain,objects:values[1].map(function(object){return {type:object.type,x:object.x,y:object.y}})}})`);
    const fillerAllocator = new PositionAllocator(fillerData.terrain, fillerData.objects);
    for (let index = 0; index < 94; index++) {
        const position = fillerAllocator.near({ x: 25, y: 25 }, { minRange: 1, maxRange: 22 });
        await insertObject(cli, context, {
            type: 'constructionSite', structureType: 'road', room: ROOMS.industryTarget, x: position.x, y: position.y,
            user: context.userId, progress: 0, progressTotal: SITE_COST.road || 300,
        });
    }
    const mapInfo = {
        at: context.gameTime,
        sources: remoteSources.length,
        sourceData: remoteSources.map((source) => ({
            id: source._id,
            x: source.x,
            y: source.y,
            energyCapacity: source.energyCapacity || 1500,
        })),
        lairs: 0,
        controllerId: remoteController._id,
        controllerPos: { x: remoteController.x, y: remoteController.y },
        owner: null,
        reservation: null,
        hostiles: 0,
        armedHostiles: 0,
        invaderCore: false,
        threat: false,
    };
    // 源 1：满容器 + 满仓矿工（线上 W32S6/W32S7/W33S6/W33S5 的形态）。运输槽位距离写成 500 ⇒ 理想身体要 8 槽 × 1550
    // ≈ 1.24 万能量，母房（收入 ~10–20/tick）永远买不起 ⇒ 不会有 hauler 来取，容器一直满着：
    // 这是 remoteMiner「满仓 + 容器满就停手」唯一可观察的前提（有 hauler 时容器会被取空、矿工根本卡不住）。
    // 旧代码在这条前提上每 tick 让引擎把溢出的采集丢到地上（落地能量每 tick 衰减），生效断言 remote.minerNoGroundOverflow 看这个。
    const overflowSpot = creepPosition(context, remoteSources[1], false);
    await insertObject(cli, context, {
        type: 'container', room: ROOMS.remote, x: overflowSpot.x, y: overflowSpot.y,
        user: context.userId, store: { energy: 2000 }, storeCapacity: 2000, hits: 250000, hitsMax: 250000,
        nextDecayTime: context.gameTime + 100,
    });
    await addCreep(cli, context, {
        name: 'remote-miner-overflow',
        role: 'remoteMiner',
        body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'],
        room: ROOMS.remote,
        position: overflowSpot,
        energy: 50,
        memory: { remoteRoom: ROOMS.remote, sourceId: remoteSources[1]._id, srcIdx: 1 },
    });
    await writeMemory(cli, context, {
        rooms: { [context.room]: { plan, remotes: {
            [ROOMS.remote]: {
                // 曾标过一次不可达、冷却即将到期的记录：bot 应在 creep 看到该房后把 unreachableCount 清零并照常开矿
                // （退避/试探恢复见 remote.noteTravel / getDemands；旧代码的记录归一化会把这两个字段丢掉）
                room: ROOMS.remote, enabled: true, suspendReason: 'unreachable', suspendedUntil: context.gameTime + 40,
                unreachableCount: 1, unreachableAt: Math.max(1, context.gameTime - 100),
                sources: [{
                    // 不给 spot：让 refreshVisible 按房间自己算（与未播种时同一条路径，避免动到既有的容器工地行为）
                    id: remoteSources[0]._id, pos: { x: remoteSources[0].x, y: remoteSources[0].y },
                    distance: 40, distanceVersion: 3,
                    energyCapacity: remoteSources[0].energyCapacity || 1500, containerId: null, roadComplete: false,
                }, {
                    id: remoteSources[1]._id, pos: { x: remoteSources[1].x, y: remoteSources[1].y },
                    spot: overflowSpot, distance: 500, distanceVersion: 3,
                    energyCapacity: remoteSources[1].energyCapacity || 1500, containerId: null, roadComplete: false,
                }],
            },
        } } },
        map: { [ROOMS.remote]: mapInfo },
    });
    context.expect = { remoteRoom: ROOMS.remote, remoteSourceIds: remoteSources.map((source) => source._id), overflowSpot };
    return context;
}

async function seedConflict(cli) {
    const context = await spawnBot(cli, 'conflict', ROOMS.conflict);
    await updateController(cli, context, 3);
    await setSpawnEnergy(cli, context, 300);
    const conflictTargets = [
        ['src0', context.sources[0]],
        ['src1', context.sources[1]],
        ['ctrl', context.controller],
    ];
    let conflictKey = null;
    let conflictPos = null;
    for (const [key, target] of conflictTargets) {
        conflictPos = nearOrNull(context.allocator, target, { minRange: 1, maxRange: 1 });
        if (conflictPos) {
            conflictKey = key;
            break;
        }
    }
    if (!conflictPos) throw new Error('Conflict fixture has no buildable adjacent target');
    const conflict = await addStructure(cli, context, 'extension', conflictPos, {
        store: { energy: 50 }, capacity: { energy: 50 },
    });
    const staleRoadPos = context.allocator.near(context.spawn, { minRange: 3, maxRange: 8 });
    const staleRoad = await addSite(cli, context, 'road', staleRoadPos, 100);
    // 方案外、装着能量的 storage：RCL3 的 allow.storage 是 0，旧代码会直接把它当"超配额可替换"拆掉，
    // 连里面的 5000 能量一起没了（生效断言 demolition.keepsLoadedStore）
    const loadedStorePos = context.allocator.near(context.spawn, { minRange: 4, maxRange: 9 });
    const loadedStore = await addStructure(cli, context, 'storage', loadedStorePos, {
        store: { energy: 5000, H: 1 }, capacity: { energy: 1000000 },
    });
    // Energy may be legitimately consumed during the gate; one unit of H keeps
    // the original store loaded, so the assertion still tests the destruction guard.
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(loadedStore._id)}},{$set:{_validationLoadedStore:true}}).then(function(){return true})`);
    const plan = emptyPlan(context);
    plan.containers[conflictKey] = conflictPos;
    if (!plan.containers.src1) plan.containers.src1 = nearOrNull(context.allocator, context.sources[1], { minRange: 1, maxRange: 3 });
    if (!plan.containers.ctrl) plan.containers.ctrl = nearOrNull(context.allocator, context.controller, { minRange: 1, maxRange: 3 });
    if (plan.containers.src0) plan.workPositions.src0 = plan.containers.src0;
    if (plan.containers.src1) plan.workPositions.src1 = plan.containers.src1;
    if (plan.containers.ctrl) plan.workPositions.ctrl = plan.containers.ctrl;
    // 第二房：RCL4、没有我们的 spawn，方案 spawn 位上压着别人（Invader 用户）的 spawn——引擎 checkControllerAvailability
    // 计数不分主人，它占满 spawn 配额。房里没有 creep、state 会是 recovering、spawn 能量 0：旧拆迁门控（恢复期/能量）一律不拆
    const foreign = await roomContextFor(cli, context, ROOMS.foreignSpawn);
    await updateController(cli, foreign, 4);
    const foreignSpawnPos = foreign.allocator.near(foreign.controller, { minRange: 4, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    const foreignSpawnDoc = Object.assign(structureDocument(foreign, 'spawn', foreignSpawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { user: '2', name: 'ValidationForeignSpawn', spawning: null, notifyWhenAttacked: false });
    const foreignSpawn = await insertObject(cli, foreign, foreignSpawnDoc);
    const foreignPlan = Object.assign(emptyPlan(Object.assign({}, foreign, { spawn: foreignSpawnPos })), { wheel: true, version: 'validation-foreign-spawn' });
    await writeMemory(cli, context, { rooms: { [context.room]: { plan }, [foreign.room]: { plan: foreignPlan } } });
    context.expect = {
        foreignSpawnRoom: foreign.room,
        foreignSpawnId: foreignSpawn._id,
        foreignSpawnPosition: foreignSpawnPos,
        conflictStructureId: conflict._id,
        conflictPosition: conflictPos,
        staleRoadSiteId: staleRoad._id,
        loadedStoreId: loadedStore._id,
    };
    return context;
}

/** 外部大脑端到端：RCL4 母房 + 相邻双源房，不放 scout、不预写 Memory.map；情报与外矿分配全部由 scripts/brain 经 HTTP API 提供 */
async function seedBrain(cli) {
    const context = await spawnBot(cli, 'brain', ROOMS.brainHome);
    await updateController(cli, context, 4);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 2000));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1800);
    const plan = emptyPlan(context);
    plan.ext = extensions;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `brain-home-harvester-${index}`,
            role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id },
        });
        await addCreep(cli, context, {
            name: `brain-home-hauler-${index}`,
            role: 'hauler',
            body: ['carry', 'carry', 'move', 'carry', 'carry', 'move'],
        });
        await addCreep(cli, context, {
            name: `brain-home-upgrader-${index}`,
            role: 'upgrader',
            body: ['work', 'work', 'work', 'carry', 'carry', 'move'],
            position: creepPosition(context, controllerContainer.position, index === 0),
            energy: 100,
        });
    }
    // 一只不能动的重甲攻击 creep（归 bootstrap 用户，是"玩家"而非 NPC）：没有塔、defense 打不过它（skip、不出兵）——
    // 旧代码第 1 tick 就开 safe mode；新代码要等外置大脑（run.py 在这个场景里真实跑一轮）的 safeMode 决定：没有别的母房能出兵 → activate
    const raiderUserId = await cli.evaluateJson(
        `storage.db.users.findOne({username:${literal(USERNAMES.bootstrap)}}).then(function(user){return user?String(user._id):null})`);
    if (raiderUserId) {
        await addCreep(cli, context, {
            name: 'brain-home-raider',
            role: 'raider',
            user: raiderUserId,
            body: Array(25).fill('tough').concat(Array(20).fill('attack')),
            position: context.allocator.near(context.spawn, { minRange: 8, maxRange: 14 }),
        });
        delete context.creepMemory['brain-home-raider'];
    }
    await writeMemory(cli, context, {
        rooms: { [context.room]: { plan, remotes: {} } },
        map: {},
    });
    context.expect = { claimRoom: ROOMS.brainRemote, remoteRoom: ROOMS.brainRemote2 };
    return context;
}

/** 防御端到端：RCL3 母房无塔，塞两只 Invader（用户 id 2）近战 creep；bot 应开 safe mode 并派 defender 清场 */
async function seedDefense(cli) {
    const context = await spawnBot(cli, 'defense', ROOMS.defenseHome);
    await updateController(cli, context, 3);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 10, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 1500));
    const plan = emptyPlan(context);
    plan.ext = extensions;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `defense-harvester-${index}`,
            role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'move', 'move', 'move'],
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, {
            name: `defense-hauler-${index}`,
            role: 'hauler',
            body: ['carry', 'carry', 'move', 'carry', 'carry', 'move'],
        });
    }
    // 一座没能量的塔：塔压不住 → defense 要 defender；Invader 放远一些，给 defender 孵化和赶到留时间
    const towerPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 4, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    await addStructure(cli, context, 'tower', towerPos, { store: { energy: 0 }, capacity: { energy: 1000 } });
    plan.towers = [towerPos];
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `invader-${index}`,
            role: 'invader',
            user: '2',
            body: ['attack', 'attack', 'move', 'move'],
            position: context.allocator.near(context.spawn, { minRange: 15, maxRange: 22 }),
        });
    }
    // 没盾可开：否则 bot 立刻开 safe mode，Invader 自行退场，defender 根本轮不到上场
    await cli.evaluateJson(
        `storage.db['rooms.objects'].update({_id:${literal(context.controller._id)}},{$set:{safeModeAvailable:0}}).then(function(){return true})`);
    await writeMemory(cli, context, { rooms: { [context.room]: { plan } } });
    return context;
}

/** 同一用户名下的第二个房（不经 bots.spawn）：拿地形/对象，controller 归该用户，spawn 由调用方插入 */
async function roomContextFor(cli, base, roomName) {
    const context = await cli.evaluateJson(
        `Promise.all([storage.db['rooms.terrain'].findOne({room:${literal(roomName)}}),storage.db['rooms.objects'].find({room:${literal(roomName)}}),storage.env.get(storage.env.keys.GAMETIME)]).then(function(values){return {terrain:values[0].terrain,objects:values[1].map(function(object){return {_id:String(object._id),type:object.type,structureType:object.structureType,x:object.x,y:object.y,name:object.name,user:object.user}}),gameTime:+values[2]}})`,
        { timeoutMs: 30000 });
    const controller = context.objects.find((object) => object.type === 'controller');
    const sources = context.objects.filter((object) => object.type === 'source')
        .sort((left, right) => String(left._id).localeCompare(String(right._id)));
    if (!controller || sources.length !== 2) throw new Error(`Incomplete generated room ${roomName}`);
    return Object.assign(context, {
        scenarioName: base.scenarioName,
        userId: base.userId,
        username: base.username,
        room: roomName,
        spawn: null,
        controller,
        sources,
        mineral: context.objects.find((object) => object.type === 'mineral'),
        allocator: new PositionAllocator(context.terrain, context.objects),
        creepPositions: new Set(),
        inserted: [],
        creepMemory: {},
    });
}

/** 援建场景（2026-09-06 aid.untilCapacity 1300 + courier）：母房 RCL5、1800 容量、storage 30000，相邻弱房 RCL3、800 容量、
 *  hauler 只有 2 CARRY。预期：母房为弱房孵 aid hauler（旧上限 800 不会援 800 容量的房），并派 courier 把 storage 能量搬过去 */
async function seedAid(cli) {
    const context = await spawnBot(cli, 'aid', ROOMS.aidHome);
    await updateController(cli, context, 5);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 30, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 1500));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1500);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    // 8 万：courier 取走一部分、两只 W15 升级者每 tick 从控制器容器吃 30（hauler 从 storage 回流），4 万在 700 tick 内就掉到 19k，
    // 结束时要仍 ≥ upgrading.storageFeedAbove（2 万），富余规则（升级者上限 3）才观察得到
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 80000 }, capacity: { energy: 1000000 } });
    // 播种的布局就是方案（wheel: true）：否则 bot 自己生成轮子方案后，拆迁模块会把不在方案里的 storage/extension 拆掉
    // （2026-09-06 第一版场景：跑到 770 tick 时 storage 没了、容量 1800 → 1600，courier 的前提消失）
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-aid' });
    plan.ext = extensions;
    plan.storage = storagePos;
    // 控制器由 link 供能（线上 W33S7 的形态，RCL5：src0 + ctrl 两个 link）：富余规则要把 storage 能量送进控制器 link
    const srcLinkPos = context.allocator.near(sourceContainers[0].position, { minRange: 1, maxRange: 1 });
    const ctrlLinkPos = context.allocator.near(context.controller, { minRange: 2, maxRange: 2 });
    await addStructure(cli, context, 'link', srcLinkPos, { store: { energy: 0 }, capacity: { energy: 800 }, cooldown: 0 });
    await addStructure(cli, context, 'link', ctrlLinkPos, { store: { energy: 0 }, capacity: { energy: 800 }, cooldown: 0 });
    plan.links = { src: srcLinkPos, src0: srcLinkPos, ctrl: ctrlLinkPos };
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    // 母房编制按 1800 容量的满配身体播种，且数量足够：否则 spawn 忙着换代/补发展档，援建档的 courier 轮不到
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `aid-home-harvester-${index}`,
            role: 'harvester',
            body: utilsMod.makeBody('staticHarvester', 1800),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, {
            name: `aid-home-upgrader-${index}`,
            role: 'upgrader',
            body: utilsMod.makeBody('upgrader', 1800),
            position: creepPosition(context, controllerContainer.position, false),
        });
    }
    for (let index = 0; index < 3; index++) {
        await addCreep(cli, context, { name: `aid-home-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1800) });
    }
    await addCreep(cli, context, { name: 'aid-home-builder', role: 'builder', body: utilsMod.makeBody('builder', 1800) });

    const weak = await roomContextFor(cli, context, ROOMS.aidWeak);
    await updateController(cli, weak, 3);
    const spawnPos = weak.allocator.near(weak.controller, { minRange: 4, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    const spawnDocument = Object.assign(structureDocument(weak, 'spawn', spawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'AidWeakSpawn', spawning: null, notifyWhenAttacked: false });
    weak.spawn = await insertObject(cli, weak, spawnDocument);
    const weakExtensions = await addExtensions(cli, weak, 10, 50);
    const weakContainers = [];
    for (const source of weak.sources) weakContainers.push(await addEnergyContainer(cli, weak, source, 1500));
    const weakControllerContainer = await addEnergyContainer(cli, weak, weak.controller, 500);
    const weakPlan = Object.assign(emptyPlan(weak), { wheel: true, version: 'validation-aid' });
    weakPlan.ext = weakExtensions;
    weakPlan.containers.src0 = weakContainers[0].position;
    weakPlan.containers.src1 = weakContainers[1].position;
    weakPlan.containers.ctrl = weakControllerContainer.position;
    weakPlan.workPositions.src0 = weakContainers[0].position;
    weakPlan.workPositions.src1 = weakContainers[1].position;
    weakPlan.workPositions.ctrl = weakControllerContainer.position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, weak, {
            name: `aid-weak-harvester-${index}`,
            role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'move', 'move', 'move'],
            position: creepPosition(weak, weakContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: weak.sources[index]._id, staticMiner: true },
        });
    }
    // 只有一只 2 CARRY 的 hauler：援建规则要为它补一只像样的（aid.haulerCarry 16）
    await addCreep(cli, weak, { name: 'aid-weak-hauler', role: 'hauler', body: ['carry', 'carry', 'move'] });
    // 还在母房、正走向弱房的援建 hauler（home 指向弱房）：它按 50 格全额预留弱房的任务，
    // 不该把弱房自己的 hauler 挡在源容器外一整趟路（生效断言 broker.farClaimIgnored）
    await addCreep(cli, context, { name: 'aid-transit-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
        memory: { home: weak.room } });
    await addCreep(cli, weak, {
        name: 'aid-weak-upgrader', role: 'upgrader', body: ['work', 'carry', 'move'],
        position: creepPosition(weak, weakControllerContainer.position, false),
    });
    // 两个刚占下的新房（controller 归我方、只有 spawn 工地）由两个母房并行开荒：以前"别处在开荒就不出需求"让两家互相封死，
    // 线上 2026-09-06 W31S6/W31S8 的 pioneer 到寿命后再没补过。预期：两个房都孵出 pioneer；援建不碰没有 spawn 的房
    const rooms = { [context.room]: { plan }, [weak.room]: { plan: weakPlan } };
    const sponsors = { [ROOMS.aidNew1]: context, [ROOMS.aidNew2]: weak };
    for (const [roomName, sponsor] of Object.entries(sponsors)) {
        const fresh = await roomContextFor(cli, context, roomName);
        await updateController(cli, fresh, 1);
        const sitePos = fresh.allocator.near(fresh.controller, { minRange: 3, maxRange: 8, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
        await addSite(cli, fresh, 'spawn', sitePos, 0);
        // 第一个新房再放几条路工地：spawn 工地必须先于道路完成（2026-09-06 用户指令：spawn 建造优先级最高，原来 builder 排序道路在前）
        if (roomName === ROOMS.aidNew1) {
            for (let index = 0; index < 6; index++) {
                const roadPos = fresh.allocator.near(sitePos, { minRange: 1, maxRange: 4 });
                await addSite(cli, fresh, 'road', roadPos, 0);
            }
        }
        rooms[sponsor.room].expansion = { target: roomName, spawnPos: { x: sitePos.x, y: sitePos.y }, since: context.gameTime };
        rooms[roomName] = { sources: fresh.sources.map((source) => source._id) };
    }
    Object.assign(context.creepMemory, weak.creepMemory);
    await writeMemory(cli, context, { rooms });
    context.weak = weak;
    return context;
}

/** 援建安全路线场景（2026-10-13，移植 wip/deploy-20260920 c7cc6f2；线上 2026-09-15 W35S7 → W37S5 只能穿 SK 房）：
 *  母房 RCL3、10 个 extension（容量 800 = minHomeCapacity）、编制齐（不 recovering，spawn 闲着才会问援建）；
 *  弱房 RCL3、只有一个 spawn（容量 300），离母房 2 格——其余援建条件全满足，只差路：中间的 roadblock 在 Memory.map 里是别人的 RCL8 房。
 *  另播一只"已经派出"的援建 hauler（home = 弱房、aid = 母房）站在母房里：它回不去，要被 aid.markStranded 标退役、走到母房 spawn 回收。
 *  RCL3 不出 scout（spawn.targetFor：RCL < 4），没人去刷新 roadblock 的情报；也不开外矿。预期见 effects 的 aid.safeRoute */
async function seedAidSafeRoute(cli) {
    const context = await spawnBot(cli, 'aidSafeRoute', ROOMS.aidSafeHome);
    await updateController(cli, context, 3);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 10, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 1000));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1000);
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-aid-safe-route' });
    plan.ext = extensions;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `aid-safe-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 800),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, { name: `aid-safe-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 800) });
    }
    await addCreep(cli, context, {
        name: 'aid-safe-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 800),
        position: creepPosition(context, controllerContainer.position, false),
    });

    const far = await roomContextFor(cli, context, ROOMS.aidSafeFar);
    await updateController(cli, far, 3);
    const spawnPos = far.allocator.near(far.controller, { minRange: 4, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    far.spawn = await insertObject(cli, far, Object.assign(structureDocument(far, 'spawn', spawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'AidSafeFarSpawn', spawning: null, notifyWhenAttacked: false }));
    const farPlan = Object.assign(emptyPlan(far), { wheel: true, version: 'validation-aid-safe-route' });
    // 已经派出、回不了弱房的援建 hauler：贴着母房 spawn 播（回收不必走路，生效断言看它消失）
    await addCreep(cli, context, {
        name: 'aid-safe-stranded-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 800),
        position: creepPosition(context, context.spawn, false), memory: { home: far.room, aid: context.room },
    });
    await writeMemory(cli, context, {
        rooms: { [context.room]: { plan }, [far.room]: { plan: farPlan, sources: far.sources.map((source) => source._id) } },
        // roadblock 是别人的房（dangerRooms 按 owner 收）：援建角色默认整房避开它，母房 → 弱房再无别的路
        map: { [ROOMS.aidSafeRoadblock]: { class: 'normal', owner: 'ValidationRoadblockOwner', level: 8, towers: 3, at: context.gameTime } },
    });
    context.far = far;
    return context;
}

/** 一次性 storage/terminal 先于道路与 extension（2026-10-13，移植 overmind-absorb 55183d1/924a8c8）：
 *  刚升到 RCL6 的房——RCL5 的 30 个 extension 已建满、方案里还差 10 个；storage 已建但 0 能量（lab 仍被 luxuryStorageAbove 挡住）；
 *  方案里有 terminal 位与 3 个 lab 位；34 个已开工（进度 1）的方案路工地占着名额：maxSites 40 − 34 = 本房只剩 6 个。
 *  旧顺序（道路 → extension → 塔 → storage → terminal）：路已在建 34 ≥ sitePace.roads，6 个名额全给 extension，terminal 排不上；
 *  新顺序：terminal 第一个拿名额（给 extension 留 1 个），记 Memory.rooms[房].oneOffAhead。生效断言 layout.oneOffBeforeRoads */
async function seedLayoutOneOff(cli) {
    const context = await spawnBot(cli, 'layoutOneOff', ROOMS.layoutOneOff);
    await updateController(cli, context, 6);
    await setSpawnEnergy(cli, context, 300);
    const built = await addExtensions(cli, context, 30, 50);
    const missing = [];
    for (let index = 0; index < 10; index++) {
        missing.push(context.allocator.near(context.spawn, { minRange: 2, maxRange: 16, structure: true, filter: (pos) => (pos.x + pos.y) % 2 === 0 }));
    }
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 0));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 0);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 8, structure: true });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 0 }, capacity: { energy: 1000000 } });
    const terminalPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 8, structure: true });
    if (!context.allocator.buildable(terminalPos.x, terminalPos.y)) throw new Error('layoutOneOff fixture: plan.terminal not constructible');
    const labSpots = [];
    for (let index = 0; index < 3; index++) labSpots.push(context.allocator.near(context.spawn, { minRange: 4, maxRange: 10, structure: true }));
    const roadSpots = [];
    for (let index = 0; index < 34; index++) roadSpots.push(context.allocator.near(context.spawn, { minRange: 3, maxRange: 20, filter: (pos) => (pos.x + pos.y) % 2 === 1 }));
    for (const pos of roadSpots) await addSite(cli, context, 'road', pos, 1);
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-layout-oneoff' });
    plan.ext = built.concat(missing);
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.labs = labSpots;
    plan.roads.all = roadSpots.map((pos) => pos.x + '.' + pos.y).join(';');
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `oneoff-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
    }
    await addCreep(cli, context, { name: 'oneoff-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1300) });
    const rooms = { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } };

    // 同 tick 去重（2026-10-14 复审）：第二房 RCL6、spawn + storage + 30 个 extension 已建，方案里只有这 30 个 extension 位、没有路/塔/容器/link 位，
    // storage 0 ⇒ lab 被奢侈门槛挡住。早轮（extension 还缺 10 个、给它留 1 个名额）放出 terminal 后还剩一大把名额，
    // 兜底轮看到的 room.find 是 tick 开头的快照（terminal 仍缺），旧代码同格重放拿到 OK（处理器才丢掉重复），白花一个名额并写同 tick 的 oneOffLeftover。
    // 新代码跳过并记 oneOffDeduped。生效断言 layout.oneOffSameTickDedupe
    const dup = await roomContextFor(cli, context, ROOMS.layoutDedupe);
    await updateController(cli, dup, 6);
    const dupSpawnPos = dup.allocator.near(dup.controller, { minRange: 4, maxRange: 10, structure: true, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    dup.spawn = await insertObject(cli, dup, Object.assign(structureDocument(dup, 'spawn', dupSpawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'LayoutDedupeSpawn', spawning: null, notifyWhenAttacked: false }));
    const dupExtensions = await addExtensions(cli, dup, 30, 50);
    const dupStoragePos = dup.allocator.near(dup.spawn, { minRange: 2, maxRange: 8, structure: true });
    await addStructure(cli, dup, 'storage', dupStoragePos, { store: { energy: 0 }, capacity: { energy: 1000000 } });
    const dupTerminalPos = dup.allocator.near(dup.spawn, { minRange: 2, maxRange: 8, structure: true });
    if (!dup.allocator.buildable(dupTerminalPos.x, dupTerminalPos.y)) throw new Error('layoutDedupe fixture: plan.terminal not constructible');
    const dupPlan = Object.assign(emptyPlan(dup), { wheel: true, version: 'validation-layout-dedupe' });
    dupPlan.spawns = [{ x: dupSpawnPos.x, y: dupSpawnPos.y }];
    dupPlan.anchor = { x: dupSpawnPos.x, y: dupSpawnPos.y };
    dupPlan.ext = dupExtensions;
    dupPlan.storage = dupStoragePos;
    dupPlan.terminal = dupTerminalPos;
    rooms[dup.room] = { plan: dupPlan, sources: dup.sources.map((source) => source._id), builderSeenAt: context.gameTime };
    Object.assign(context.creepMemory, dup.creepMemory);

    await writeMemory(cli, context, { rooms });
    context.expect = { terminalPos, storagePos, missingExt: missing.length, roadSites: roadSpots.length, dedupeTerminalPos: dupTerminalPos };
    return context;
}

/** 一次性建筑的兜底轮（2026-10-13 复审）：oneOffBeforeRoads 开着时，提前那一轮在 extension 还缺时给它留 1 个名额；
 *  若 extension 方案位放不出（这里：方案只有已建的 30 个位，RCL6 上限 40 ⇒ 缺 10 个却一个都放不出）、塔也不缺（2 座已建），
 *  那 1 个名额要在塔之后的兜底轮给 terminal——复审前的分支只在关掉提前时才跑兜底轮，名额落给 rampart，terminal 永远排不上。
 *  39 个已开工（进度 1）的方案路工地占着名额：maxSites 40 − 39 = 本房只剩 1 个；路在建 39 ≥ sitePace.roads，道路不放。
 *  开局不播 builder：第一轮 layout（开局 layoutInterval 内）时名额一定只剩 1 个，之后孵出的 builder 建完路、提前那一轮再放 terminal
 *  也不会写 oneOffLeftover——这条遥测只能来自兜底轮。生效断言 layout.oneOffLeftover */
async function seedLayoutLeftover(cli) {
    const context = await spawnBot(cli, 'layoutLeftover', ROOMS.layoutLeftover);
    await updateController(cli, context, 6);
    await setSpawnEnergy(cli, context, 300);
    const built = await addExtensions(cli, context, 30, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 0));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 0);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 8, structure: true });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 0 }, capacity: { energy: 1000000 } });
    const towers = [];
    for (let index = 0; index < 2; index++) {
        const pos = context.allocator.near(context.spawn, { minRange: 3, maxRange: 8, structure: true });
        towers.push(pos);
        await addStructure(cli, context, 'tower', pos, { store: { energy: 1000 }, capacity: { energy: 1000 } });
    }
    const terminalPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 8, structure: true });
    // 播坏了就当夹具错误报出来，不让它伪装成 layout.oneOffLeftover 的回归
    if (!context.allocator.buildable(terminalPos.x, terminalPos.y)) throw new Error('layoutLeftover fixture: plan.terminal not constructible');
    const roadSpots = [];
    for (let index = 0; index < 39; index++) roadSpots.push(context.allocator.near(context.spawn, { minRange: 3, maxRange: 20, filter: (pos) => (pos.x + pos.y) % 2 === 1 }));
    for (const pos of roadSpots) await addSite(cli, context, 'road', pos, 1);
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-layout-leftover' });
    plan.ext = built;
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.towers = towers;
    plan.roads.all = roadSpots.map((pos) => pos.x + '.' + pos.y).join(';');
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `leftover-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
    }
    await addCreep(cli, context, { name: 'leftover-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1300) });
    await writeMemory(cli, context, {
        rooms: { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } },
    });
    context.expect = { terminalPos, storagePos, roadSites: roadSpots.length };
    return context;
}

/** terminal 补能 + 终端网络 + 市场（2026-10-13，移植 overmind-absorb e4cae2f / 2214dcc / 2133dc2）：RCL6、storage 20 万（远高于 industry.terminalFillStorageAbove）、
 *  terminal 播 0 能量；同一用户的第二房 terminalPeer 是接收方（见下）。投递目标里原本没有 terminal：旧代码下它一辈子是 0（终端网络/市场/industry 的前提永不成立），
 *  新代码下 hauler 从富余 storage 搬进去。生效断言 broker.terminalFill 读原始 DB 里的 terminal 能量 */
/** terminal 中段取回（2026-10-13 复审）：RCL6、storage 2 万（高于 storageFeedAbove，富余滞回开着；低于 industry.terminalDrainStorageBelow 3 万）、
 *  terminal 播 3 万能量（= terminalTarget：storage 曾过 5 万时补进去的），账号里只有这一个 terminal、没有矿物——没有任何消费方。
 *  旧代码只在富余滞回关掉（storage < storageFeedBelow）时取 terminal，这 3 万要等 storage 用光才回得来；
 *  新代码 hauler 取回、只留 terminalNetwork.feeReserve。生效断言 broker.terminalDrainLow */
async function seedTerminalDrainLow(cli) {
    const context = await spawnBot(cli, 'terminalDrainLow', ROOMS.terminalDrainLow);
    await updateController(cli, context, 6);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 100);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 500));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1500);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 20000 }, capacity: { energy: 1000000 } });
    const terminalPos = context.allocator.near(storagePos, { minRange: 2, maxRange: 3, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    await addStructure(cli, context, 'terminal', terminalPos, { store: { energy: 30000 }, capacity: { energy: 300000 }, cooldown: 0 });
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-terminal-drain-low' });
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `terminal-drain-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, { name: `terminal-drain-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
            position: creepPosition(context, terminalPos, false) });
    }
    await addCreep(cli, context, {
        name: 'terminal-drain-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1300),
        position: creepPosition(context, controllerContainer.position, false),
    });
    await writeMemory(cli, context, {
        rooms: { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime,
            storageRich: { on: true, at: context.gameTime } } },
    });
    context.expect = { storage: 20000, terminal: 30000 };
    return context;
}

async function seedTerminalNetwork(cli) {
    const context = await spawnBot(cli, 'terminalNet', ROOMS.terminalHome);
    await updateController(cli, context, 6);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 100);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 500));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1500);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    const storage = await addStructure(cli, context, 'storage', storagePos, { store: { energy: 200000 }, capacity: { energy: 1000000 } });
    const terminalPos = context.allocator.near(storagePos, { minRange: 2, maxRange: 3, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    // U 8000（> market.keep 3000，且这一房的矿脉是 H、没有别的代码动 U）：市场要有"用不掉的矿物"才会去成交
    const terminal = await addStructure(cli, context, 'terminal', terminalPos, { store: { energy: 0, U: 8000 }, capacity: { energy: 300000 }, cooldown: 0 });
    // 播种的布局就是方案（wheel: true）：否则 bot 自己生成轮子方案后拆迁会把不在方案里的 storage/terminal 拆掉
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-terminal-net' });
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `terminal-net-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, { name: `terminal-net-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
            position: creepPosition(context, storagePos, false) });
    }
    await addCreep(cli, context, {
        name: 'terminal-net-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1300),
        position: creepPosition(context, controllerContainer.position, false),
    });
    const rooms = { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } };

    // 终端网络的接收方（2026-10-13，移植 overmind-absorb 2214dcc）：同一用户的第二房，storage 0 + terminal 0 ≤ receiveBelow。
    // 母房 storage 20 万 ≥ sendAbove，但 terminal 播 0：一笔 terminal.send 要先等 hauler 把 terminal 补到 minSend + 传送费 + feeReserve 以上，
    // 于是这条链的每一环（补能 → 发送 → 接收方取出）都是玩法自己走出来的，不靠夹具播的 terminal 能量
    const peer = await roomContextFor(cli, context, ROOMS.terminalPeer);
    await updateController(cli, peer, 6);
    const peerSpawnPos = peer.allocator.near(peer.controller, { minRange: 4, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    peer.spawn = await insertObject(cli, peer, Object.assign(structureDocument(peer, 'spawn', peerSpawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'TerminalPeerSpawn', spawning: null, notifyWhenAttacked: false }));
    const peerExtensions = await addExtensions(cli, peer, 10, 0);
    const peerStoragePos = peer.allocator.near(peer.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    await addStructure(cli, peer, 'storage', peerStoragePos, { store: { energy: 0 }, capacity: { energy: 1000000 } });
    const peerTerminalPos = peer.allocator.near(peerStoragePos, { minRange: 2, maxRange: 3, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    const peerTerminal = await addStructure(cli, peer, 'terminal', peerTerminalPos, { store: { energy: 0 }, capacity: { energy: 300000 }, cooldown: 0 });
    const peerPlan = Object.assign(emptyPlan(peer), { wheel: true, version: 'validation-terminal-peer' });
    peerPlan.spawns = [{ x: peerSpawnPos.x, y: peerSpawnPos.y }];
    peerPlan.anchor = { x: peerSpawnPos.x, y: peerSpawnPos.y };
    peerPlan.ext = peerExtensions;
    peerPlan.storage = peerStoragePos;
    peerPlan.terminal = peerTerminalPos;
    await addCreep(cli, peer, { name: 'terminal-peer-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 800),
        position: creepPosition(peer, peerTerminalPos, false), memory: { home: peer.room } });
    Object.assign(context.creepMemory, peer.creepMemory);
    rooms[peer.room] = { plan: peerPlan, sources: peer.sources.map((source) => source._id), builderSeenAt: context.gameTime };

    // 市场的对手方（2026-10-13，移植 overmind-absorb 2133dc2/6112d42）：无主 terminal + 一张确定的 U 买单。私服 NPC 市场就是这个模型
    // （backend cronjobs 对 {type:'terminal', user:null} 的房生成买卖单），把 nextNpcMarketOrder 推远，免得 cron 把它删掉重播。
    // 传送费从母房 terminal 的能量里扣——那份能量也只可能是 hauler 补进去的
    const npc = await roomContextFor(cli, context, ROOMS.terminalMarket);
    const npcTerminalPos = npc.allocator.near(npc.controller, { minRange: 2, maxRange: 6 });
    await insertObject(cli, npc, { type: 'terminal', room: npc.room, x: npcTerminalPos.x, y: npcTerminalPos.y,
        hits: 3000, hitsMax: 3000, store: { energy: 0 }, storeCapacity: 300000 });
    // DB 里的 price 是 ×1000 的（engine game/market.js 读出来再 /1000）：1000 ⇒ 单价 1.0
    const npcOrder = await cli.evaluateJson(`storage.db['market.orders'].insert(${literal({
        created: 0, createdTimestamp: 0, active: true, type: 'buy',
        amount: 6000, remainingAmount: 6000, totalAmount: 6000,
        resourceType: 'U', price: 1000, roomName: npc.room,
    })}).then(function(o){return String(o._id)})`);
    await cli.evaluateJson(
        `storage.db.rooms.update({_id:${literal(npc.room)}},{$set:{nextNpcMarketOrder:${literal(context.gameTime + 1000000)}}}).then(function(){return true})`);
    // 成交史：价格底线 = 近期均价 × priceFloorShare，没有成交史就一单都不做（这也是线上的正确行为）。
    // backend cron calcMarketStats 在每次 backend 启动的第一轮就跑：market.stats.removeWhere({}) 后只从 14 天内的
    // users.money{type:'market.sell'} 重算（avgPrice = Σchange / Σamount）。phaseTwo 从种子库重启服务器，直接插进 market.stats 的
    // 成交史在恢复模拟前就被清空，getHistory('U') 恒为 {}、market.run 每轮 avg == null 跳过（2026-10-14 validation-mZRVaL）。
    // 所以把成交史播在 cron 重算的来源里：5 天、每天一笔 20000 U × 1.0 的 NPC 成交 ⇒ 重算出 5 行 avgPrice 1。
    // date 用 ISO 字符串：cron 的 {$gt: new Date()} 经 storage RPC 的 JSON 变成 ISO 字符串，lokijs 对两个非数字按字典序比较；
    // 存成数字的话 Number 对上 NaN 恒为"不大于"，一行都查不到。日期按 CLI 求值时的真实时钟算（cron 的 14 天窗口看的是 Date.now()）
    for (let day = 1; day <= 5; day++) {
        await cli.evaluateJson(`storage.db['users.money'].insert({date: new Date(Date.now() - ${day} * 86400000).toISOString(), tick: 0,`
            + ` user: 'validation-market-history', type: 'market.sell', balance: 0, change: 20000, market: ${literal({
                resourceType: 'U', roomName: npc.room, targetRoomName: npc.room, price: 1, npc: true, owner: null,
                dealer: 'validation-market-history', amount: 20000,
            })}}).then(function(){return true})`);
    }
    // 种子期（seed server 不跑 tick）与 cron 跑之前也有成交史；seeded 标记让 run_validation 认得出 cron 是否已经重算过（见 waitMarketHistory）
    for (let day = 1; day <= 5; day++) {
        await cli.evaluateJson(`storage.db['market.stats'].insert(${literal({
            resourceType: 'U', date: `2026-10-0${day}`, transactions: 200, volume: 100000, avgPrice: 1, stddevPrice: 0.05, seeded: true,
        })}).then(function(){return true})`);
    }

    await writeMemory(cli, context, { rooms });
    context.expect = { storageId: storage._id, terminalId: terminal._id, terminalPos, storagePos, peerTerminalId: peerTerminal._id, npcOrder };
    context.peer = peer;
    return context;
}

/** 矿物链（2026-10-13，移植 overmind-absorb 7f4ab27 / bf11ea0 / 2d97ab4）：RCL7、storage 20 万、terminal 2 万能量（industry.canSpend 的储备闸开着）
 *  + H/O 各 3000；四个 lab 全空、0 能量：一个簇（簇心 + 两个 ≤2 格的邻居）+ 一个远处的孤立 lab。
 *  不播 labTech、lab 里不播矿物：industry 要按目标 XZH2O 的反应链自己选出 OH 这一步，spawn 要按取送计划孵出 labTech，
 *  labTech 要把 H/O 从 terminal 装进输入 lab，反应才跑得起来——结束时 lab/terminal 里的 OH 只可能是这条链走出来的。
 *  （fixture-validated-capabilities：旧夹具把 H/O 直接播进输入 lab，deriveReaction 先命中，labTech 与反应链都观察不到） */
/** 储备闸关着时 boost lab 照样补能（2026-10-13 复审，3d5d49f 的回归）：RCL7、storage 7 万（storageRich 开着、高于 terminalFillStorageAbove 5 万，
 *  低于 industry.storageReserve 10 万 ⇒ canSpend 关着）、terminal 3 万（= terminalTarget，不出补能任务）；三个挨着的空 lab + 一个离簇心 ≥ 4 格的孤立 lab（进不了三连 ⇒ 当 boost lab），
 *  它播 XZH2O 600、0 能量（已经装好化合物、等着强化）。四个 lab 都 0 能量：boost lab 有能量只可能是 hauler 按 boost lab 投递任务送来的。
 *  3d5d49f 的闸关分支不写 industryState.labs.boostLab ⇒ labEnergyWant 恒 0、boost lab 一辈子 0 能量。生效断言 industry.boostLabGatedEnergy */
async function seedBoostLabGated(cli) {
    const utilsMod = loadSrcModule('utils');
    const context = await spawnBot(cli, 'boostLabGated', ROOMS.boostLabGated);
    await updateController(cli, context, 7);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 100);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 500));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1500);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 70000 }, capacity: { energy: 1000000 } });
    const terminalPos = context.allocator.near(storagePos, { minRange: 2, maxRange: 3, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    // terminal 播满 terminalTarget 3 万：没有 terminal 补能任务和 boost lab 抢 storage 门槛以上那 2 万（terminal 权重 0.5 高于 lab 的 0.4）
    await addStructure(cli, context, 'terminal', terminalPos, { store: { energy: 30000 }, capacity: { energy: 300000 }, cooldown: 0 });
    const emptyLab = { store: { energy: 0 }, capacity: { energy: 2000 }, cooldown: 0 };
    const clusterAnchor = context.allocator.near(context.spawn, { minRange: 4, maxRange: 8 });
    const cluster = [await addStructure(cli, context, 'lab', clusterAnchor, emptyLab)];
    const clusterPos = [clusterAnchor];
    for (let index = 0; index < 2; index++) {
        const position = context.allocator.near(clusterAnchor, { minRange: 1, maxRange: 2 });
        clusterPos.push(position);
        cluster.push(await addStructure(cli, context, 'lab', position, emptyLab));
    }
    const farPos = context.allocator.near(context.spawn, { minRange: 8, maxRange: 14,
        filter: (pos) => clusterPos.every((p) => Math.max(Math.abs(p.x - pos.x), Math.abs(p.y - pos.y)) >= 4) });
    const farLab = await addStructure(cli, context, 'lab', farPos, { store: { energy: 0, XZH2O: 600 }, capacity: { energy: 2000 }, cooldown: 0 });
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-boost-lab-gated' });
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.labs = clusterPos.concat([farPos]).map((pos) => ({ x: pos.x, y: pos.y }));
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `boost-gated-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, { name: `boost-gated-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
            position: creepPosition(context, storagePos, false) });
    }
    await addCreep(cli, context, {
        name: 'boost-gated-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1300),
        position: creepPosition(context, controllerContainer.position, false),
    });
    await writeMemory(cli, context, {
        _validationBoostGated: { farLabId: String(farLab._id) },
        // boost lab 装着 XZH2O 等着强化：强化得打开，否则 task_broker 不给它补能量（broker.labEnergyNeedsBoosts）
        conquest: [boostDirective(context.room)],
        rooms: { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } },
    });
    context.expect = { farLabId: String(farLab._id) };
    return context;
}

async function seedLabChain(cli) {
    const utilsMod = loadSrcModule('utils');
    const context = await spawnBot(cli, 'labChain', ROOMS.labHome);
    await updateController(cli, context, 7);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 100);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 500));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1500);
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    const storage = await addStructure(cli, context, 'storage', storagePos, { store: { energy: 200000 }, capacity: { energy: 1000000 } });
    const terminalPos = context.allocator.near(storagePos, { minRange: 2, maxRange: 3, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    const terminal = await addStructure(cli, context, 'terminal', terminalPos, {
        // XZH2O 1500 ≥ labBoostStock（2026-10-13 boost lab）：只播在 terminal 里，boost lab 里出现的 XZH2O 只可能是 labTech 装进去的。
        // O 只播 600：够第一批反应（≥ labMinBatch 500），但低于 terminalNetwork.mineralWant 1000——labPeer 的 O 要靠矿物调剂送过来
        store: { energy: 20000, H: 3000, O: 600, XZH2O: 1500 }, capacity: { energy: 300000 }, cooldown: 0,
    });
    // 第二个 spawn（RCL7 允许 2 个）：labTech 是 opportunistic，只靠一个 spawn 会排在富余 storage 引出的一串发展档后面
    const spawn2Pos = context.allocator.near(context.spawn, { minRange: 3, maxRange: 6, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    await insertObject(cli, context, Object.assign(structureDocument(context, 'spawn', spawn2Pos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'LabChainSpawn2', spawning: null, notifyWhenAttacked: false }));
    const emptyLab = { store: { energy: 0 }, capacity: { energy: 2000 }, cooldown: 0 };
    const clusterAnchor = context.allocator.near(context.spawn, { minRange: 4, maxRange: 8 });
    const cluster = [await addStructure(cli, context, 'lab', clusterAnchor, emptyLab)];
    const clusterPos = [clusterAnchor];
    for (let index = 0; index < 2; index++) {
        const position = context.allocator.near(clusterAnchor, { minRange: 1, maxRange: 2 });
        clusterPos.push(position);
        cluster.push(await addStructure(cli, context, 'lab', position, emptyLab));
    }
    // 孤立的 lab：离簇心 ≥ 4 格，进不了任何三连 ⇒ industry 选它当 boost lab；0 能量，它的能量只可能是 hauler 按 boost lab 投递任务送来的
    const farPos = context.allocator.near(context.spawn, { minRange: 8, maxRange: 14,
        filter: (pos) => clusterPos.every((p) => Math.max(Math.abs(p.x - pos.x), Math.abs(p.y - pos.y)) >= 4) });
    const farLab = await addStructure(cli, context, 'lab', farPos, emptyLab);
    // 播种的布局就是方案（wheel: true）：否则 bot 自己生成轮子方案后拆迁会把不在方案里的 storage/terminal/lab 拆掉
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-lab-chain' });
    plan.spawns = [{ x: context.spawn.x, y: context.spawn.y }, { x: spawn2Pos.x, y: spawn2Pos.y }];
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.terminal = terminalPos;
    plan.labs = clusterPos.concat([farPos]).map((pos) => ({ x: pos.x, y: pos.y }));
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `lab-chain-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, { name: `lab-chain-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
            position: creepPosition(context, storagePos, false) });
    }
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `lab-chain-upgrader-${index}`, role: 'upgrader', body: utilsMod.makeBody('upgrader', 2300),
            position: creepPosition(context, controllerContainer.position, false),
        });
    }
    const rooms = { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } };

    // 矿物调剂的发送方（2026-10-13，移植 overmind-absorb 019c5b1）：同一用户的第二房，RCL6、没有 lab（不算缺口房）、terminal 里 O 6000
    // （> mineralKeep + mineralWant）+ 5000 能量付传送费。storage 6 万 + terminal 5000：高于 terminalNetwork.receiveBelow（不是能量接收方），
    // 低于 sendAbove（不是能量发送方）——这一对房之间没有能量要调，矿物调剂才轮得到
    const peer = await roomContextFor(cli, context, ROOMS.labPeer);
    await updateController(cli, peer, 6);
    const peerSpawnPos = peer.allocator.near(peer.controller, { minRange: 4, maxRange: 10, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    peer.spawn = await insertObject(cli, peer, Object.assign(structureDocument(peer, 'spawn', peerSpawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'LabPeerSpawn', spawning: null, notifyWhenAttacked: false }));
    const peerStoragePos = peer.allocator.near(peer.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    await addStructure(cli, peer, 'storage', peerStoragePos, { store: { energy: 60000 }, capacity: { energy: 1000000 } });
    const peerTerminalPos = peer.allocator.near(peerStoragePos, { minRange: 2, maxRange: 3, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    const peerTerminal = await addStructure(cli, peer, 'terminal', peerTerminalPos, { store: { energy: 5000, O: 6000 }, capacity: { energy: 300000 }, cooldown: 0 });
    const peerPlan = Object.assign(emptyPlan(peer), { wheel: true, version: 'validation-lab-peer' });
    peerPlan.spawns = [{ x: peerSpawnPos.x, y: peerSpawnPos.y }];
    peerPlan.anchor = { x: peerSpawnPos.x, y: peerSpawnPos.y };
    peerPlan.storage = peerStoragePos;
    peerPlan.terminal = peerTerminalPos;
    rooms[peer.room] = { plan: peerPlan, sources: peer.sources.map((source) => source._id), builderSeenAt: context.gameTime };
    Object.assign(context.creepMemory, peer.creepMemory);

    // 强化打开（broker.labEnergy 要观察 boost lab 补能；强化关着时 task_broker 不补，见 broker.labEnergyNeedsBoosts）
    await writeMemory(cli, context, { rooms, conquest: [boostDirective(context.room)] });
    context.expect = { storageId: storage._id, terminalId: terminal._id, labIds: cluster.map((lab) => lab._id), farLabId: farLab._id, peerTerminalId: peerTerminal._id };
    context.peer = peer;
    return context;
}

/** 攻城 creep 出发前强化（2026-10-13，移植 overmind-absorb 79a5ee4 / 6dd5cbb）：RCL6、一个 lab 播 XZH2O 600 + 能量 2000。
 *  config.conquest.boosts 默认空 = 关闭，所以这里直接给 siegeDismantler 的 memory 写 boosts（打开后 conquest.demand 写的就是这个字段）。
 *  没有 storage/terminal ⇒ industry 储备闸关着：不算 lab 计划、不孵 labTech、hauler 不往 lab 补能——lab 里的 XZH2O/能量只会被 boostCreep 扣掉。
 *  dismantler 播在 spawn 旁、不贴 lab：要先走过去再强化；强化完照常出发去正西的中立房 boostTarget，那里没有可拆的敌方建筑 ⇒ 退役回母房回收。
 *  预期见 effects 的 combat.boostBeforeLaunch（母房 boostLog + 原始 DB 里 lab 少了 3 个 WORK 的 90 XZH2O / 60 能量） */
async function seedBoost(cli) {
    const context = await spawnBot(cli, 'boost', ROOMS.boostHome);
    await updateController(cli, context, 6);
    await setSpawnEnergy(cli, context, 300);
    const labPos = context.allocator.near(context.spawn, { minRange: 4, maxRange: 7 });
    const lab = await addStructure(cli, context, 'lab', labPos, { store: { energy: 2000, XZH2O: 600 }, capacity: { energy: 2000 }, cooldown: 0 });
    // 播种的布局就是方案（wheel: true）：否则 bot 自己生成轮子方案后拆迁会把不在方案里的 lab 拆掉
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-boost' });
    plan.labs = [{ x: labPos.x, y: labPos.y }];
    await addCreep(cli, context, {
        name: 'boost-siege', role: 'siegeDismantler', body: ['work', 'work', 'work', 'move', 'move', 'move'],
        memory: { targetRoom: ROOMS.boostTarget, squad: 1, boosts: ['XZH2O'] },
    });
    await writeMemory(cli, context, { rooms: { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } } });
    context.expect = { labId: lab._id, seeded: { XZH2O: 600, energy: 2000 }, parts: 3 };
    return context;
}

/** Source Keeper 采矿（2026-10-13，移植 overmind-absorb 4dcc63c / ffb9b31 / 67a8baf / e46f060 / 55f98c2）：
 *  config.sk 默认关，这里用一份有效的大脑指令打开：rooms[母房] = { remotes: [keeper 房], skMining: true }——SK 房只在大脑白名单点名时收。
 *  母房 RCL7、2 个 spawn、50 个 extension 播满（5300 容量 ⇒ reaper 10 组：打 100、自愈 120 > keeper 的 100，正好过 reaperMinUnits 9），
 *  storage 3 万让 hauler 能很快把 extension 补回来；roster[7] 的核心编制（2 只容器矿工 + 5 只 hauler + builder + upgrader）全播齐，
 *  孵化队列里在 reaper（新外矿 = remote 档）前面的只剩换代，reaper 一开局就排得上。
 *  keeper 房：删掉 controller（真 SK 房没有；引擎随即把源容量设成 SOURCE_ENERGY_KEEPER_CAPACITY 4000），两个 keeperLair（user '3'）各贴一口源
 *  （keeper AI 认 5 格内的源），lair0 上播一只在岗 keeper——名字必须是 'Keeper' + lair 的 _id（引擎 keeper-lairs/tick.js 按名字认它），
 *  身体照抄引擎：17 TOUGH + 13 MOVE + 10 ATTACK + 10 RANGED_ATTACK、5000 血。lair1 没有 keeper：引擎第一 tick 就给它排 300 tick 后孵化。
 *  这只 keeper 的 _id 记在 bot Memory._validationSk.keeperId：引擎只在它掉血（hits < 5000 才排重生）或死掉时才删掉/换掉它，
 *  而房里会打它的只有 reaper——它从 DB 里消失或掉血就是 reaper 真的打了。
 *  预期见 effects 的 sk.keeperMining：收成 SK 外矿、reaper 到岗前扣住矿工（skWaitReaper）、reaper 打掉 keeper、矿工在 reaper 到岗后采到能量（skHarvest） */
async function seedSk(cli) {
    const utilsMod = loadSrcModule('utils');
    const context = await spawnBot(cli, 'sk', ROOMS.skHome);
    await updateController(cli, context, 7);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 50, 100);
    const secondSpawnPos = context.allocator.near(context.spawn, { minRange: 3, maxRange: 8, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    await insertObject(cli, context, Object.assign(structureDocument(context, 'spawn', secondSpawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'SkSpawn2', spawning: null, notifyWhenAttacked: false }));
    const storagePos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 5 });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 30000 }, capacity: { energy: 1000000 } });
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 1000));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1500);
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-sk' });
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.spawns = [{ x: context.spawn.x, y: context.spawn.y }, { x: secondSpawnPos.x, y: secondSpawnPos.y }];
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `sk-home-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 800),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
    }
    for (let index = 0; index < 5; index++) {
        await addCreep(cli, context, { name: `sk-home-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1200) });
    }
    await addCreep(cli, context, { name: 'sk-home-builder', role: 'builder', body: utilsMod.makeBody('builder', 1200) });
    await addCreep(cli, context, {
        name: 'sk-home-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1500),
        position: creepPosition(context, controllerContainer.position, true),
    });

    // keeper 房：删 controller、两个 lair 各贴一口源、lair0 上一只在岗 keeper
    const keeperRoom = await roomContextFor(cli, context, ROOMS.skRoom);
    await cli.evaluateJson(
        `storage.db['rooms.objects'].removeWhere({room:${literal(ROOMS.skRoom)},type:'controller'}).then(function(){return true})`,
        { timeoutMs: 30000 });
    const lairs = [];
    for (const source of keeperRoom.sources) {
        const position = nearOrNull(keeperRoom.allocator, source, { minRange: 2, maxRange: 3 }) ||
            keeperRoom.allocator.near(source, { minRange: 1, maxRange: 4 });
        lairs.push(await insertObject(cli, keeperRoom, {
            type: 'keeperLair', room: ROOMS.skRoom, x: position.x, y: position.y, user: '3', hits: 0, hitsMax: 0,
        }));
    }
    const keeperBody = []
        .concat(Array.from({ length: 17 }, () => ({ type: 'tough', hits: 100 })))
        .concat(Array.from({ length: 13 }, () => ({ type: 'move', hits: 100 })))
        .concat(Array.from({ length: 10 }, () => ({ type: 'attack', hits: 100 })))
        .concat(Array.from({ length: 10 }, () => ({ type: 'ranged_attack', hits: 100 })));
    const keeper = await insertObject(cli, keeperRoom, {
        type: 'creep', name: 'Keeper' + lairs[0]._id, room: ROOMS.skRoom, x: lairs[0].x, y: lairs[0].y, user: '3',
        body: keeperBody, hits: 5000, hitsMax: 5000, spawning: false, fatigue: 0,
        store: { energy: 0 }, storeCapacity: 0, notifyWhenAttacked: false,
    });

    // 被移出白名单的 SK 外矿（skDemoted）：上一轮还是启用的 SK 外矿，两只在家的 reaper 还挂着它（寿命满、lastTtl 1500）。
    // 大脑这份指令的白名单里没有它 ⇒ syncKeeperRooms 退回 keeperRoom 永久停用 ⇒ reaper 走回 spawn 回收。
    // 旧代码：reaper 退役不标 retired，回收后 main.js 清内存时 noteReaperLoss 把两只都记成阵亡 ⇒ suspendReason 被改写成 skReaperLost
    const demotedReapers = ['sk-demoted-reaper-0', 'sk-demoted-reaper-1'];
    for (const name of demotedReapers) {
        await addCreep(cli, context, { name, role: 'skReaper', body: ['ranged_attack', 'heal', 'move', 'move'],
            memory: { remoteRoom: ROOMS.skDemoted, lastTtl: 1500 } });
    }
    await writeMemory(cli, context, {
        _validationSk: { keeperId: keeper._id, lairIds: lairs.map((lair) => lair._id), seededAt: context.gameTime, demotedReapers },
        map: {
            [ROOMS.skRoom]: {
                at: context.gameTime, source: 'scout', sources: 2, lairs: lairs.length, owner: null, controllerId: null, controllerPos: null,
                // scout 不分主人：keeper 也算进 armedHostiles/threat（admitCandidates 对 keeper 房只看 invaderCore）
                armedHostiles: 1, threat: true, invaderCore: false,
                lairPos: lairs.map((lair) => ({ x: lair.x, y: lair.y })),
                sourceData: keeperRoom.sources.map((source) => ({ id: source._id, x: source.x, y: source.y, energyCapacity: 4000 })),
            },
        },
        rooms: { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime,
            remotes: { [ROOMS.skDemoted]: { room: ROOMS.skDemoted, enabled: true, sk: true, lairs: 2, sourceCount: 2, suspendedUntil: 0,
                suspendReason: null, sources: [], reservation: { username: null, ticksToEnd: 0, seenAt: 0 } } } } },
        brain: { version: 1, issuedAt: Date.now(), ttlMs: 86400000,
            rooms: { [context.room]: { remotes: [ROOMS.skRoom], skMining: true, scouts: 0 } } },
    });
    context.expect = { keeperId: keeper._id, lairIds: lairs.map((lair) => lair._id), keeperRoom: ROOMS.skRoom };
    return context;
}

/** 大脑掉线时的自治占领兜底（2026-10-13，移植 overmind-absorb a57da2e/b63cc9c）：RCL4、800 容量（spawn + 10 个 extension 播满）、
 *  核心编制齐（两只容器矿工 + 两只 hauler + upgrader），claimer 的 650 能量一开局就够。
 *  Memory.brain 是一份 ttl 到期两天的旧指令（大脑掉线超过 expansion.autoClaimAfterMs 一天）；Memory.map 只播两条情报：
 *  正南的 autoClaimTarget（真实生成的双源中立房、controllerId 是真的、情报新鲜）与正东的 autoClaimDecoy（不生成，记成别人的房，
 *  房名更小、距离同为 1——兜底不看 owner 就会先挑它）。四个相邻房没有全探明，外矿的自治收房不起步、不会抢走目标。
 *  预期：Memory.rooms[母房].autoClaim.room = 正南房（from: map），孵出 targetRoom 为它的 claimer，多半已经占下；
 *  别的场景（没有 Memory.brain 或指令有效）一个都不该出现 autoClaim。生效断言 expansion.autoClaimOffline。
 *  opts.cpuHeld（2026-10-13 复审，autoClaimCpu 用户）：同一套掉线 + 合格邻房，但播 5 条远超 limit 的近期用量 ⇒ CPU 闸挡住，生效断言 expansion.autoClaimCpuGate */
async function seedAutoClaim(cli, opts = {}) {
    const homeRoom = opts.home || ROOMS.autoClaimHome;
    const targetRoom = opts.target || ROOMS.autoClaimTarget;
    const context = await spawnBot(cli, opts.scenario || 'autoClaim', homeRoom);
    await updateController(cli, context, 4);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 10, 50);
    const sourceContainers = [];
    for (const source of context.sources) sourceContainers.push(await addEnergyContainer(cli, context, source, 1000));
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 1000);
    const plan = Object.assign(emptyPlan(context), { wheel: true, version: 'validation-auto-claim' });
    plan.ext = extensions;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `auto-claim-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 800),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, { name: `auto-claim-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 800) });
    }
    await addCreep(cli, context, {
        name: 'auto-claim-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 800),
        position: creepPosition(context, controllerContainer.position, false),
    });
    const target = await roomContextFor(cli, context, targetRoom);
    const ttlMs = 30 * 60 * 1000;
    const map = {
        [targetRoom]: {
            at: context.gameTime, source: 'scout', sources: 2, lairs: 0,
            sourceData: target.sources.map((source) => ({ id: source._id, x: source.x, y: source.y, energyCapacity: 3000 })),
            controllerId: target.controller._id, controllerPos: { x: target.controller.x, y: target.controller.y },
            owner: null, reservation: null, hostiles: 0, armedHostiles: 0, invaderCore: false, threat: false,
        },
    };
    if (!opts.cpuHeld) {
        map[ROOMS.autoClaimDecoy] = {
            at: context.gameTime, source: 'scout', sources: 2, lairs: 0, controllerId: 'validation-auto-claim-decoy',
            owner: 'ValidationAutoClaimDecoyOwner', level: 4, reservation: null, hostiles: 0, armedHostiles: 0, invaderCore: false, threat: false,
        };
    }
    await writeMemory(cli, context, {
        rooms: { [context.room]: { plan, sources: context.sources.map((source) => source._id), builderSeenAt: context.gameTime } },
        // cpuHeld 变体：近期 5 条整 tick 用量 1000（远超 limit 140 × autoClaimMaxCpuShare 0.8）——账号已经被 CPU 卡着，兜底不该再加房。
        // 第一次重扫就记 why 'cpu' 并缓存 autoClaimInterval（1500）tick；之后真实低用量把均值拉回线下，缓存到期才会再挑
        stats: opts.cpuHeld ? [1000, 1000, 1000, 1000, 1000].map((cpu, i) => ({ t: context.gameTime - 150 + i * 30, cpu, bucket: 10000 })) : undefined,
        // 大脑掉线：最后一份指令 ttl 到期两天（> autoClaimAfterMs 一天），没有未到期的锁
        brain: { version: 1, issuedAt: Date.now() - ttlMs - 2 * 24 * 60 * 60 * 1000, ttlMs, rooms: { [context.room]: { remotes: [], scouts: 0 } } },
        map,
    });
    // CPU 闸的 bucket 一半（autoClaimMinBucket 5000）：两个变体都播满，差别只在近期用量
    await cli.evaluateJson(
        `storage.db.users.update({_id:${literal(context.userId)}},{$set:{cpuAvailable:10000}}).then(function(){return true})`,
        { timeoutMs: 30000 });
    context.target = target;
    return context;
}

/** 在 node 里加载游戏内的扁平模块（utils 会 require('config')）：临时把裸模块名映射到 src/<name>.js */
function loadSrcModule(name) {
    const Module = require('module');
    const srcRoot = path.join(__dirname, '..', '..', 'src');
    const original = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (/^[a-z_]+$/.test(request) && fs.existsSync(path.join(srcRoot, request + '.js'))) return original.call(this, path.join(srcRoot, request + '.js'), ...rest);
        return original.call(this, request, ...rest);
    };
    try { return require(path.join(srcRoot, name + '.js')); } finally { Module._resolveFilename = original; }
}

/** 攻占场景（复盘 B0 损失预言机 / 战斗改动验证门）：攻击方母房 conquestHome（RCL5、storage ≥ storageFloor）拿到
 *  Memory.conquest 指令去破防敌方 conquestTarget——一个**第二个真·active 用户**（跑同一份 project 代码，只是不写指令，
 *  于是自然用 tower.js 开火、defense.js 反应），有 2 座**有能量的塔**、spawn、经济、controller safeModeAvailable:0（防对称代码兜底开盾冻住围攻）。
 *  中立 conquestStaging 在两者之间集结。预期：敌塔+spawn 被拆光（破防成功）、攻击方经济不崩（A1 blocking:false / A2 storageFloor）。
 *  断言在 run_validation.js/effects.js（敌塔+spawn 原始 DB 计数归零、攻击方核心 creep 存活）。 */
async function seedConquest(cli) {
    const utilsMod = loadSrcModule('utils');
    // ---- 攻击方 ----
    const home = await spawnBot(cli, 'conquest', ROOMS.conquestHome);
    await updateController(cli, home, 5);
    await setSpawnEnergy(cli, home, 300);
    const extensions = await addExtensions(cli, home, 30, 50);
    const sourceContainers = [];
    for (const source of home.sources) sourceContainers.push(await addEnergyContainer(cli, home, source, 1500));
    const controllerContainer = await addEnergyContainer(cli, home, home.controller, 1500);
    const storagePos = home.allocator.near(home.spawn, { minRange: 2, maxRange: 5, filter: (pos) => (pos.x + pos.y) % 2 === 1 });
    // storage 能量高于 storageFloor(15000)：攻城需求才被允许（A2），同时验证 A1 下经济不被冻结
    await addStructure(cli, home, 'storage', storagePos, { store: { energy: 30000 }, capacity: { energy: 1000000 } });
    const plan = Object.assign(emptyPlan(home), { wheel: true, version: 'validation-conquest' });
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.workPositions.ctrl = controllerContainer.position;
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, home, {
            name: `conquest-harvester-${index}`, role: 'harvester',
            body: utilsMod.makeBody('staticHarvester', 1800),
            position: creepPosition(home, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: home.sources[index]._id, staticMiner: true },
        });
    }
    for (let index = 0; index < 3; index++) {
        await addCreep(cli, home, { name: `conquest-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1800) });
    }
    await addCreep(cli, home, {
        name: 'conquest-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1800),
        position: creepPosition(home, controllerContainer.position, false),
    });

    // ---- 敌方（第二个真·active 用户，拥有 conquestTarget 的 spawn/controller）----
    const enemy = await spawnBot(cli, 'conquestEnemy', ROOMS.conquestTarget);
    await updateController(cli, enemy, 5);
    await setSpawnEnergy(cli, enemy, 300);
    const enemyExtensions = await addExtensions(cli, enemy, 20, 50);
    const enemyContainers = [];
    for (const source of enemy.sources) enemyContainers.push(await addEnergyContainer(cli, enemy, source, 1500));
    const enemyCtrlContainer = await addEnergyContainer(cli, enemy, enemy.controller, 1000);
    // 2 座有真能量的塔：我们的 tower.js 跑在敌方身上会真的对我方 siege 开火（tower.js 对玩家敌人照打）
    const towerPositions = [];
    for (let index = 0; index < 2; index++) {
        // 塔放在**远离入口**的一侧（攻击方从南边 conquestStaging 进 → 塔放北），复现线上 W32S4 那种"塔在对角、
        // 要横穿全房"的难情形；放在 spawn 旁的旧版接近距离太短，损失天然低、量不出战术改动的差别
        const towerPos = enemy.allocator.near({ x: 25, y: 8 }, { minRange: index * 4 + 1, maxRange: index * 4 + 7, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
        towerPositions.push(towerPos);
        await addStructure(cli, enemy, 'tower', towerPos, { store: { energy: 1000 }, capacity: { energy: 1000 } });
    }
    const enemyPlan = Object.assign(emptyPlan(enemy), { wheel: true, version: 'validation-conquest-enemy' });
    enemyPlan.ext = enemyExtensions;
    enemyPlan.towers = towerPositions;
    enemyPlan.containers.src0 = enemyContainers[0].position;
    enemyPlan.containers.src1 = enemyContainers[1].position;
    enemyPlan.containers.ctrl = enemyCtrlContainer.position;
    enemyPlan.workPositions.src0 = enemyContainers[0].position;
    enemyPlan.workPositions.src1 = enemyContainers[1].position;
    enemyPlan.workPositions.ctrl = enemyCtrlContainer.position;
    // 敌方经济 creep：有能量收入才能回补塔（否则塔火几十发就耗尽，测不出真实破防代价）
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, enemy, {
            name: `conquest-enemy-harvester-${index}`, role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'move', 'move', 'move'],
            position: creepPosition(enemy, enemyContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: enemy.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, enemy, { name: `conquest-enemy-hauler-${index}`, role: 'hauler', body: ['carry', 'carry', 'move', 'carry', 'carry', 'move'] });
    }
    // 敌方控制器不能开盾：否则对称代码的 tower.js coreHurt 兜底会开 safe mode 冻住围攻（precedent: seedDefense）
    await cli.evaluateJson(
        `storage.db['rooms.objects'].update({_id:${literal(enemy.controller._id)}},{$set:{safeModeAvailable:0}}).then(function(){return true})`);
    await writeMemory(cli, enemy, { rooms: { [enemy.room]: { plan: enemyPlan } } });

    // ---- 过境房（conquestTransit，独立敌方用户）：夹在集结点与目标之间，房中心一座敌塔。 ----
    // 冲锋 staging → target 必经此房；towerAvoidCallback 应让队伍贴远缘绕过 (25,25) 的塔，Memory.siegeTransit 记下最近距离。
    // 该用户 inactive（不跑代码，塔不开火）——过境避塔是**几何**行为（按塔位加寻路成本），不依赖塔是否开火即可验证。
    const transit = await spawnBot(cli, 'conquestTransit', ROOMS.conquestTransit);
    await updateController(cli, transit, 5);
    await setSpawnEnergy(cli, transit, 300);
    await addStructure(cli, transit, 'tower', { x: 25, y: 25 }, { store: { energy: 1000 }, capacity: { energy: 1000 } });

    // 目标房核心处放一只**静止的敌方远程 creep**（属 inactive 的 transit 用户 → 不跑代码、只是站着挨打）：给 siegeGuard 一个
    // "有活攻击部件"的威胁去开火——护卫开火的那 tick 才会为保 rangedAttack 放弃 rangedHeal（combat.actionPipelineGuard 的攻占分支）。
    // 过去夹具敌方只有经济 creep、护卫无仗可打，这条断言在攻占场景恒不满足（既有缺口）。TOUGH×18 撑十几 tick，够观察到跳过。
    const guardBaitBody = [];
    for (let i = 0; i < 18; i++) guardBaitBody.push('tough');
    for (let i = 0; i < 5; i++) guardBaitBody.push('ranged_attack');
    for (let i = 0; i < 2; i++) guardBaitBody.push('move');
    await addCreep(cli, transit, {
        name: 'conquest-target-guardbait', role: 'defender', room: ROOMS.conquestTarget,
        position: enemy.allocator.near({ x: 25, y: 8 }, { minRange: 3, maxRange: 8 }), body: guardBaitBody,
        memory: { role: 'defender' },
    });

    // ---- 预置一波 siege 在集结点 ----
    // 单 spawn 逐个孵 10 个 24-部件身体要 ~700 tick、超预算；直接在集结点预置整波（launched=false、squad 齐 → 首 tick 即发起），
    // 测的是 approach 破防阶段的损失（复盘核心）。slotKey 对齐 conquest 需求，spawn 不会重复孵。
    const dismantlerBody = [];
    for (let i = 0; i < 12; i++) dismantlerBody.push('work');
    for (let i = 0; i < 12; i++) dismantlerBody.push('move');
    const guardBody = [];
    for (let i = 0; i < 4; i++) guardBody.push('ranged_attack');
    for (let i = 0; i < 4; i++) guardBody.push('heal');
    for (let i = 0; i < 8; i++) guardBody.push('move');
    // 参考实战：破双塔（各 1000 能量、敌方经济回补）需 ~13 拆迁才能在损失后仍有足够贴塔；14+3 给余量确保破防完成
    const N_DIS = 14;
    const N_GUARD = 3;
    const SQUAD = N_DIS + N_GUARD;
    // avoidTowers：把过境房 (conquestTransit) 的塔位 (25,25) 声明给攻城单位，首次寻路即绕塔（复现操作者按侦察填塔位的用法）
    const siegeMemBase = { targetRoom: enemy.room, staging: ROOMS.conquestStaging, squad: SQUAD, launched: false,
        avoidTowers: { [ROOMS.conquestTransit]: [[25, 25]] } };
    let slot = 0;
    const placeAt = () => ({ x: 20 + (slot % 6), y: 7 + Math.floor(slot / 6) });
    for (let i = 0; i < N_DIS; i++) {
        await addCreep(cli, home, {
            name: `conquest-siege-${i}`, role: 'siegeDismantler', room: ROOMS.conquestStaging,
            position: placeAt(), body: dismantlerBody,
            memory: Object.assign({ slotKey: `siege:${enemy.room}:${home.room}:${i}` }, siegeMemBase),
        });
        slot++;
    }
    for (let i = 0; i < N_GUARD; i++) {
        await addCreep(cli, home, {
            name: `conquest-guard-${i}`, role: 'siegeGuard', room: ROOMS.conquestStaging,
            position: placeAt(), body: guardBody,
            memory: Object.assign({ slotKey: `guard:${enemy.room}:${home.room}:${i}` }, siegeMemBase),
        });
        slot++;
    }

    // ---- 攻击方指令：破防 conquestTarget，中立 conquestStaging 集结。noClaim（占领不在 B0 断言范围，attackController 1/1000t 太慢）----
    await writeMemory(cli, home, {
        rooms: { [home.room]: { plan } },
        conquest: [{ target: enemy.room, sponsors: [home.room], staging: ROOMS.conquestStaging, dismantlers: N_DIS, guards: N_GUARD, downgraders: 1, noClaim: true, avoidTowers: { [ROOMS.conquestTransit]: [[25, 25]] } }],
    });
    home.enemy = enemy;
    home.enemyUserId = enemy.userId;
    home.enemyTowerCount = towerPositions.length;
    return home;
}

/** keeper 过境场景：claimer 从 keeperHome 穿**中立的** keeperRoom（房中心一座 keeper lair）去占 keeperTarget。
 *  验证 movement.keeperAvoidCallback 让 claimer 贴远缘绕开 lair 的杀伤圈（不是绕 lair 那一格，而是保持 ≥ range 距离），
 *  Memory.keeperTransit[keeperRoom] 记下过境时到 lair 的最近距离。keeperRoom 房名非 SK（E22S17），引擎不刷真 keeper，
 *  lair 只是惰性障碍——过境避让是**几何**行为（按 lair 位加寻路成本），不依赖真 keeper 即可验证；且中立房无 controller owner，
 *  hostileTerritoryRooms 不会整房避开它，claimer 得以进入。 */
async function seedKeeperTransit(cli) {
    const utilsMod = loadSrcModule('utils');
    const home = await spawnBot(cli, 'keeper', ROOMS.keeperHome);
    await updateController(cli, home, 4);
    await setSpawnEnergy(cli, home, 300);
    const containers = [];
    for (const source of home.sources) containers.push(await addEnergyContainer(cli, home, source, 1500));
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, home, {
            name: `keeper-harvester-${index}`, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 800),
            position: creepPosition(home, containers[index].position, true),
            memory: { sourceIdx: index, sourceId: home.sources[index]._id, staticMiner: true },
        });
    }
    await addCreep(cli, home, { name: 'keeper-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 800) });
    const plan = Object.assign(emptyPlan(home), { wheel: true, version: 'validation-keeper' });
    plan.containers.src0 = containers[0].position;
    plan.containers.src1 = containers[1].position;
    plan.workPositions.src0 = containers[0].position;
    plan.workPositions.src1 = containers[1].position;

    // 中立 keeperRoom 房中心一座 keeper lair（无 user，直接插 rooms.objects）。放在 claimer 纵向穿房的自然路径正中：
    // 无规避会贴到 dist≈1，有规避应把路径推到 ≥ range 外。
    const lairPos = { x: 25, y: 25 };
    await cli.evaluateJson(
        `storage.db['rooms.objects'].insert({room:${literal(ROOMS.keeperRoom)},type:'keeperLair',x:${lairPos.x},y:${lairPos.y}}).then(function(){return true})`,
        { timeoutMs: 30000 });

    // 预置 claimer：target=keeperTarget，穿 keeperRoom；开阔地 [claim,move,move] 1 格/tick
    await addCreep(cli, home, {
        name: 'keeper-claimer', role: 'claimer', body: ['claim', 'move', 'move'],
        memory: { role: 'claimer', targetRoom: ROOMS.keeperTarget },
    });

    // 攻击方 Memory：home plan + 声明 keeperRoom 的 lairPos（class=sk），让 claimer 首次寻路（进房前无视野时）即绕 lair。
    // at:1 在从 0 起算的私服里不会被 20000-tick 老化剔除。
    await writeMemory(cli, home, {
        rooms: { [home.room]: { plan } },
        map: { [ROOMS.keeperRoom]: { class: 'sk', lairs: 1, lairPos: [{ x: lairPos.x, y: lairPos.y }], at: 1 } },
    });
    home.keeperRoom = ROOMS.keeperRoom;
    home.lairPos = lairPos;
    return home;
}

/** storage 供能的房（线上 W31S6/W31S8 的形态：storage 贴着控制器，升级者站在 storage 旁直接取能，没有控制器容器）。
 *  storage 恰好播在升级者的取用底线 upgrading.reserve 上——这正是死区：升级者只取底线以上，hauler 的补给旧规则也停在同一个数，
 *  于是可取量恒为 0，升级者按"hauler 在岗就原地等"无限期空等（线上 W31S6 12–16 → 0.00 prog/tick、W31S8 6.58 → 1.62）。
 *  新规则的补给地板 = reserve + controllerFeedStorageBand，broker 在 storage ≥ reserve 时仍出第三层补给任务并记 ctrlFeedBand。 */
async function seedStorageFed(cli) {
    const context = await spawnBot(cli, 'storageFed', ROOMS.storageFed);
    await updateController(cli, context, 5);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 50);
    // 源容器之一播成危急水位（12000 / 25 万 = 4.8% < criticalRepairShare 0.2）：配上下面那座满能量的塔，
    // 这正是旧代码"有塔就不为维修孵 builder"会拦住、新代码放行的状态（生效断言 build.criticalRepairBuilder 看这个决策事件）
    const sourceContainers = [];
    for (let i = 0; i < context.sources.length; i++) {
        sourceContainers.push(await addEnergyContainer(cli, context, context.sources[i], 1800, i === 0 ? { hits: 12000 } : {}));
    }
    // storage 必须落在控制器 2 格内，且至少有两个"与 storage 相邻、控制器射程 3 内"的空格——
    // 否则 layout.upgraderStorageStations 返回 []，房间根本不是 storage 供能，断言的前提不成立。
    // 前提在播种时就检查并抛错（随机地形下宁可播种失败，也不要让断言在报告阶段以"没观察到"的形式误报）
    const controller = context.controller;
    const allocator = context.allocator;
    const stationCount = (pos) => {
        let free = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const x = pos.x + dx;
                const y = pos.y + dy;
                if (!allocator.free(x, y)) continue;
                if (Math.max(Math.abs(x - controller.x), Math.abs(y - controller.y)) > 3) continue;
                free++;
            }
        }
        return free;
    };
    const storagePos = context.allocator.near(controller, { minRange: 2, maxRange: 2, filter: (pos) => stationCount(pos) >= 2 });
    if (stationCount(storagePos) < 2) {
        throw new Error(`storageFed storage ${storagePos.x},${storagePos.y} 旁没有两个控制器射程 3 内的空格，升级者站位不成立`);
    }
    const reserve = Number((loadSrcModule('config').upgrading || {}).reserve) || 2000;
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: reserve }, capacity: { energy: 1000000 } });
    // 满能量的 ctrl link，但不贴任何 storage 站位格（线上 W31S5/W31S8 的形态：站位 0/55、2/48 采样贴着 ctrl link，link 常年堵满）：
    // 生效断言 upgrader.linkRelief 看"派一只升级者去 link 旁喝"的决策事件。link 旁要有控制器 3 格内、不是站位的空地
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const stationTiles = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const t = { x: storagePos.x + dx, y: storagePos.y + dy };
        if ((dx || dy) && allocator.free(t.x, t.y) && cheb(t, controller) <= 3) stationTiles.push(t);
    }
    const reliefLinkPos = nearOrNull(allocator, controller, { minRange: 2, maxRange: 4, filter: (pos) => {
        if (stationTiles.some((t) => cheb(t, pos) <= 1) || cheb(pos, storagePos) <= 1) return false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const q = { x: pos.x + dx, y: pos.y + dy };
            if ((dx || dy) && allocator.free(q.x, q.y) && cheb(q, controller) <= 3 && !stationTiles.some((t) => t.x === q.x && t.y === q.y)) return true;
        }
        return false;
    } });
    // 随机地形下可能摆不出这种几何：不摆 link，生效断言会以"没有 ctrl link"的原因失败（与代码无关，重跑换地形）
    if (reliefLinkPos) await addStructure(cli, context, 'link', reliefLinkPos, { store: { energy: 800 }, capacity: { energy: 800 }, cooldown: 0 });
    // 播的布局就是方案（wheel: true），否则拆迁模块会把方案外的 storage/extension 拆掉。
    // 不播 containers.ctrl：storage 供能的房不用控制器容器，留着只会让 layout 去放一个工地
    const plan = emptyPlan(context);
    plan.wheel = true;
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.links = reliefLinkPos ? { ctrl: reliefLinkPos } : {};
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `sf-harvester-${index}`,
            role: 'harvester',
            body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
        await addCreep(cli, context, {
            name: `sf-upgrader-${index}`,
            role: 'upgrader',
            body: utilsMod.makeBody('upgrader', 1300),
            position: creepPosition(context, storagePos, index === 0),
        });
    }
    for (let index = 0; index < 3; index++) {
        await addCreep(cli, context, { name: `sf-hauler-${index}`, role: 'hauler', body: utilsMod.makeBody('hauler', 1300) });
    }
    // 满能量的塔（进方案免得被拆）：旧代码里它会压住"只剩维修活时的 builder"，所以是断言的前提
    const towerPos = nearOrNull(context.allocator, context.spawn, { minRange: 2, maxRange: 6 }) ||
        context.allocator.near(context.spawn, { minRange: 2, maxRange: 10 });
    await addStructure(cli, context, 'tower', towerPos, { store: { energy: 1000 }, capacity: { energy: 1000 } });
    plan.towers = [towerPos];
    // 一座比值远低于危急容器的 rampart（10 血 / RCL5 目标 10 万 = 0.01%，容器是 4.8%）：
    // 旧排序只看比值，塔与 builder 会把全部维修产出投给它，容器纯衰减；新排序把"会消失"的危急容器排到它前面。
    // 线上 2026-09-07 的自然对照：W35S7 rampart 3.40% < 容器 4.73% ⇒ 715 tick 里 rampart +8600、容器 −10000（零维修）
    const rampartPos = nearOrNull(context.allocator, context.spawn, { minRange: 2, maxRange: 6 }) ||
        context.allocator.near(context.spawn, { minRange: 2, maxRange: 10 });
    await addStructure(cli, context, 'rampart', rampartPos, { hits: 10, hitsMax: 3000000 });
    plan.ramparts = [rampartPos];
    const drinkPlan = await seedLinkDrink(cli, context, utilsMod);
    Object.assign(context.creepMemory, drinkPlan.creepMemory);
    const inPlacePlan = await seedLinkInPlace(cli, context, utilsMod);
    Object.assign(context.creepMemory, inPlacePlan.creepMemory);
    await writeMemory(cli, context, { rooms: { [context.room]: { plan }, [ROOMS.linkDrink]: { plan: drinkPlan.plan },
        [ROOMS.linkInPlace]: { plan: inPlacePlan.plan } } });
    context.expect = { storagePos, reserve, criticalContainer: sourceContainers[0].position, linkDrink: drinkPlan.expect, linkInPlace: inPlacePlan.expect };
    return context;
}

/** storageFed 用户的第二房（RCL6）：storage 5 万（远高于升级者底线）+ 满能量的 ctrl link，升级者站在同时贴着两者的格上。
 *  旧代码一次 find 取"link 或 storage"里 find 顺序靠前的那个，贴着两者也可能一直喝 storage、ctrl link 永远满着（线上 W31S6）；
 *  生效断言 upgrader.linkBeforeStorage 看决策事件 upgraderDrink.linkOverStorage（两者都取得到时选了 link）。
 *  storage 先于 link 播种（find 顺序靠前），这正是旧代码会选 storage 的前提 */
async function seedLinkDrink(cli, base, utilsMod) {
    const drink = await roomContextFor(cli, base, ROOMS.linkDrink);
    await updateController(cli, drink, 6);
    const ctrl = drink.controller;
    const allocator = drink.allocator;
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    let layoutFound = null;
    for (let dy = -2; dy <= 2 && !layoutFound; dy++) {
        for (let dx = -2; dx <= 2 && !layoutFound; dx++) {
            const storagePos = { x: ctrl.x + dx, y: ctrl.y + dy };
            if (cheb(storagePos, ctrl) !== 2 || !allocator.free(storagePos.x, storagePos.y)) continue;
            for (let sy = -1; sy <= 1 && !layoutFound; sy++) {
                for (let sx = -1; sx <= 1 && !layoutFound; sx++) {
                    const station = { x: storagePos.x + sx, y: storagePos.y + sy };
                    if ((!sx && !sy) || !allocator.free(station.x, station.y) || cheb(station, ctrl) > 3) continue;
                    for (let ly = -1; ly <= 1 && !layoutFound; ly++) {
                        for (let lx = -1; lx <= 1 && !layoutFound; lx++) {
                            const linkPos = { x: station.x + lx, y: station.y + ly };
                            if ((!lx && !ly) || cheb(linkPos, storagePos) === 0 || !allocator.free(linkPos.x, linkPos.y)) continue;
                            layoutFound = { storagePos, station, linkPos };
                        }
                    }
                }
            }
        }
    }
    if (!layoutFound) throw new Error(`linkDrink: 控制器 ${ctrl.x},${ctrl.y} 旁摆不下 storage + 站位 + ctrl link`);
    const { storagePos, station, linkPos } = layoutFound;
    for (const pos of [storagePos, station, linkPos]) allocator.claim(pos);
    await addStructure(cli, drink, 'storage', storagePos, { store: { energy: 50000 }, capacity: { energy: 1000000 } });
    await addStructure(cli, drink, 'link', linkPos, { store: { energy: 800 }, capacity: { energy: 800 }, cooldown: 0 });
    const spawnPos = allocator.near(ctrl, { minRange: 5, maxRange: 12, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    drink.spawn = await insertObject(cli, drink, Object.assign(structureDocument(drink, 'spawn', spawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'LinkDrinkSpawn', spawning: null, notifyWhenAttacked: false }));
    await addCreep(cli, drink, {
        name: 'link-drink-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1300),
        position: station, memory: { home: ROOMS.linkDrink },
    });
    // 身上混进 200 K 的 hauler（旧版本会把地上的矿物当取货目标捡走）：新代码先把它卸进 storage，不再一辈子占着容量
    await addCreep(cli, drink, {
        name: 'link-drink-salvage', role: 'hauler', body: ['carry', 'carry', 'carry', 'carry', 'move', 'move'],
        position: allocator.near(storagePos, { minRange: 1, maxRange: 2 }), memory: { home: ROOMS.linkDrink },
    });
    await cli.evaluateJson(`storage.db['rooms.objects'].update({room:${literal(ROOMS.linkDrink)},type:'creep',name:'link-drink-salvage'},{$set:{store:{energy:0,K:200}}}).then(function(){return true})`);
    // 揣着 storage 零头（20 能量）又被货锁锁住的 hauler：房里没有消费者缺口（spawn 满、ctrl link 满），
    // 旧代码要揣到 storageCargoRelease（100 tick）才放手，新代码当场解锁去补满
    await addCreep(cli, drink, {
        name: 'link-drink-residual', role: 'hauler', body: ['carry', 'carry', 'move'], energy: 20,
        position: allocator.near(storagePos, { minRange: 1, maxRange: 2 }),
        memory: { home: ROOMS.linkDrink, hubCargo: true, hubCargoAt: drink.gameTime },
    });
    // 入侵者阵亡现场：线上 2026-09-12 W35S7 (12,5) 的真实 tombstone（GO 95 / KO 17 / ZH 23 / UH 11，
    // 250 tick 寿命里没人认领，衰减成同格四堆掉落后全丢光）。新代码要有一只空载 hauler 主动跑过去收进 storage
    const tombPos = allocator.near(storagePos, { minRange: 6, maxRange: 11 });
    allocator.claim(tombPos);
    await insertObject(cli, drink, {
        type: 'tombstone', room: drink.room, x: tombPos.x, y: tombPos.y,
        user: '2', deathTime: drink.gameTime, decayTime: drink.gameTime + 250,
        creepId: '6aa4ed45f9d9e5564f5b4c0a', creepName: 'invader_validation', creepTicksToLive: 1494,
        creepBody: [].concat(
            new Array(16).fill('tough'), new Array(25).fill('move'),
            new Array(3).fill('ranged_attack'), new Array(4).fill('work'), ['attack', 'attack'],
        ).map((type) => ({ type, hits: 100 })),
        creepSaying: null,
        store: { energy: 0, GO: 95, KO: 17, ZH: 23, UH: 11 },
    });
    await addCreep(cli, drink, {
        name: 'link-drink-scavenger', role: 'hauler', body: ['carry', 'carry', 'carry', 'carry', 'move', 'move'],
        position: allocator.near(storagePos, { minRange: 1, maxRange: 3 }), memory: { home: ROOMS.linkDrink },
    });
    const plan = Object.assign(emptyPlan(drink), { wheel: true, version: 'validation-link-drink' });
    plan.storage = storagePos;
    plan.links = { ctrl: linkPos };
    return { plan, creepMemory: drink.creepMemory, expect: { storagePos, station, linkPos, tombPos } };
}

/** storageFed 用户的第三房（2026-10-13，RCL6）：storage 站位全都不贴 ctrl link、ctrl link 800（≥ linkKeepAt），
 *  唯一的升级者空手站在 link 旁、控制器 3 格内的一格上，脚下是一个 2000 能量的容器（energySourceAt 里容器先于 link）。
 *  旧代码的 linkReliefSpot 照样给它派 link 旁的位，它原地/来回"移动"、从不 withdraw，贴着控制器看门狗也不管；
 *  生效断言 upgrader.linkReliefInPlace 看"已在 link 旁 → 不再派位"的决策事件。
 *  方案里不写 containers：plannedContainersBuilt 为假，这只方案外的容器不会被当成多余拆掉 */
async function seedLinkInPlace(cli, base, utilsMod) {
    const room = await roomContextFor(cli, base, ROOMS.linkInPlace);
    await updateController(cli, room, 6);
    const ctrl = room.controller;
    const allocator = room.allocator;
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const free = (pos) => pos.x >= 2 && pos.x <= 47 && pos.y >= 2 && pos.y <= 47 && allocator.free(pos.x, pos.y);
    const around = (pos) => { const out = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push({ x: pos.x + dx, y: pos.y + dy }); return out; };
    let geom = null;
    for (let dy = -2; dy <= 2 && !geom; dy++) for (let dx = -2; dx <= 2 && !geom; dx++) {
        const storagePos = { x: ctrl.x + dx, y: ctrl.y + dy };
        if (cheb(storagePos, ctrl) !== 2 || !free(storagePos)) continue;
        for (let ly = -4; ly <= 4 && !geom; ly++) for (let lx = -4; lx <= 4 && !geom; lx++) {
            const linkPos = { x: ctrl.x + lx, y: ctrl.y + ly };
            if (!free(linkPos) || cheb(linkPos, storagePos) <= 1) continue;
            // storage 站位格：storage 旁、控制器 3 格内、不是 link 格（与 layout.upgraderStorageStations 同口径）
            const stations = around(storagePos).filter((t) => free(t) && cheb(t, ctrl) <= 3 && !(t.x === linkPos.x && t.y === linkPos.y));
            if (!stations.length || stations.some((t) => cheb(t, linkPos) <= 1)) continue;
            const side = around(linkPos).find((t) => free(t) && cheb(t, ctrl) <= 3 && cheb(t, storagePos) > 1);
            if (side) geom = { storagePos, linkPos, side };
        }
    }
    if (!geom) throw new Error(`linkInPlace: 控制器 ${ctrl.x},${ctrl.y} 旁摆不下"站位不贴 link + link 旁有空格"的几何（随机地形），重跑验证`);
    const { storagePos, linkPos, side } = geom;
    for (const pos of [storagePos, linkPos, side]) allocator.claim(pos);
    await addStructure(cli, room, 'storage', storagePos, { store: { energy: 50000 }, capacity: { energy: 1000000 } });
    await addStructure(cli, room, 'link', linkPos, { store: { energy: 800 }, capacity: { energy: 800 }, cooldown: 0 });
    await addStructure(cli, room, 'container', side, { store: { energy: 2000 }, capacity: { energy: 2000 }, hits: 250000, hitsMax: 250000 });
    const spawnPos = allocator.near(ctrl, { minRange: 5, maxRange: 12, filter: (pos) => (pos.x + pos.y) % 2 === 0 });
    room.spawn = await insertObject(cli, room, Object.assign(structureDocument(room, 'spawn', spawnPos,
        { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }), { name: 'LinkInPlaceSpawn', spawning: null, notifyWhenAttacked: false }));
    // 名字排在 spawn 之后孵出的升级者前面（linkReliefSpot 只派名字最小的在岗升级者）
    await addCreep(cli, room, {
        name: 'a-link-inplace-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1300),
        position: side, memory: { home: ROOMS.linkInPlace },
    });
    const plan = Object.assign(emptyPlan(room), { wheel: true, version: 'validation-link-in-place' });
    plan.storage = storagePos;
    plan.links = { ctrl: linkPos };
    return { plan, creepMemory: room.creepMemory, expect: { storagePos, linkPos, side } };
}

/** 边界墙封死出口：claimer 出不了母房。不复用 storageFed——那是整套 RCL5 经济，多一个重用户会拖慢其它场景。
 *  spawn 在 recovering 时不调 expansion.getDemands，所以计时靠 expansion.run；这里只播一只 claimer、不播矿工。 */
async function seedClaimBlocked(cli) {
    const context = await spawnBot(cli, 'claimBlocked', ROOMS.claimBlocked);
    await updateController(cli, context, 4);
    await setSpawnEnergy(cli, context, 0);
    const occupied = new Set();
    for (const object of (context.objects || []).concat(context.inserted || [])) {
        if (object && object.x != null && object.y != null) occupied.add(object.x + '.' + object.y);
    }
    const walls = [];
    for (let x = 0; x < 50; x++) {
        for (const y of [0, 49]) {
            if (!occupied.has(x + '.' + y)) walls.push({ x, y });
        }
    }
    for (let y = 1; y < 49; y++) {
        for (const x of [0, 49]) {
            if (!occupied.has(x + '.' + y)) walls.push({ x, y });
        }
    }
    // 不可摧毁墙没有 hits（docs/api/StructureWall.md）。structureDocument 会把 hits:null 当成缺省 1000。
    const docs = walls.map((pos) => ({ type: 'constructedWall', room: context.room, x: pos.x, y: pos.y }));
    await cli.evaluateJson(
        `Promise.all(${literal(docs)}.map(function(doc){return storage.db['rooms.objects'].insert(doc)})).then(function(){return true})`,
        { timeoutMs: 30000 });
    await addCreep(cli, context, {
        name: 'blocked-claimer',
        role: 'claimer',
        body: ['claim', 'move'],
        memory: { targetRoom: ROOMS.claimBlockedTarget, slotKey: 'claimer:' + ROOMS.claimBlockedTarget },
    });
    // cpu.shedCritical（2026-10-08）：强制紧急降载 + cap 0（CPU 再低也算超上限），观察 cpu_shed 的分发——
    // scout 被跳、两只空闲 hauler 每 tick 最多跳一只（最后一只能跑的 hauler 永远执行）、claimer 从不被跳（占领超时退避照常触发）。
    // 封墙房里没有能量也没有别的活，跳过不会扰动这里的 expansion.unreachableBackoff 断言
    await addCreep(cli, context, { name: 'shed-scout', role: 'scout', body: ['move'] });
    await addCreep(cli, context, { name: 'shed-hauler-a', role: 'hauler', body: ['carry', 'carry', 'move'] });
    await addCreep(cli, context, { name: 'shed-hauler-b', role: 'hauler', body: ['carry', 'carry', 'move'] });
    const plan = emptyPlan(context);
    plan.wheel = true;
    await writeMemory(cli, context, {
        // cpu.tickLimitHardStop（2026-10-08）：开局 30 tick 硬停线强制为 0——一只 creep 都不跑（claimer 也停），收尾照常。
        // 私服的 tickLimit 是整个 bucket，真实的线碰不到；30 tick 后恢复，上面的降载与占领退避断言照常观察
        cpuShedForce: { mode: 'critical', cap: 0, until: context.gameTime + 1000000, stop: 0, stopUntil: context.gameTime + 30 },
        // cpu.pixelGate（2026-10-08）：近期 5 条整 tick 用量 150（> 140 × 0.75），bucket 播满 10000——桶满但不该产 pixel。
        // 采样每 30 tick 追加一条真实低用量，约 60 tick 后均值落回闸门以下（私服没有 generatePixel，之后什么也不发生）
        stats: [150, 150, 150, 150, 150].map((cpu, i) => ({ t: context.gameTime - 150 + i * 30, cpu, bucket: 10000 })),
        rooms: { [context.room]: { plan } },
        brain: {
            version: 1,
            issuedAt: Date.now(),
            ttlMs: 86400000,
            rooms: { [context.room]: { claim: { room: ROOMS.claimBlockedTarget }, remotes: [], scouts: 0 } },
        },
    });
    await cli.evaluateJson(
        `storage.db.users.update({_id:${literal(context.userId)}},{$set:{cpuAvailable:10000}}).then(function(){return true})`,
        { timeoutMs: 30000 });
    return context;
}

/** 维修饥饿（线上 2026-09-09 W33S7 的形态）：RCL6、storage 空、spawn+extension 有能量、40/40 工地名额被零进度
 *  rampart 占满、方案里还有没建成的路、一条危急道路在塔射程内、一条在射程外。
 *  四个生效断言的观察面：
 *   - builder 从 spawn/ext 余量取到能（空 storage 旧写法会让它每 tick 对着空仓库空转）→ 射程外的危急路被修
 *   - builder 先修"会消失的"危急路再建造（旧代码有工地就只建造）
 *   - 射程内有危急结构时塔的维修补能提到第 1 层（Memory.rooms[房].towerCritical）
 *   - 名额满时零进度 rampart 工地让给方案里缺失的路（出现道路工地、rampart 工地减少）
 *  房间没有建造活以外的工地：lab/terminal 工地是 5 万–10 万进度，builder 在 effectTicks 内建不完，
 *  于是房间一直停在 40 个名额上——道路工地只可能来自"让位"，不可能来自"rampart 建完腾出名额"。 */
async function seedMaintenance(cli) {
    const context = await spawnBot(cli, 'maintenance', ROOMS.maintenance);
    await updateController(cli, context, 6);
    await setSpawnEnergy(cli, context, 300);
    const extensions = await addExtensions(cli, context, 20, 50);
    // storage 播 800 能量、摆在 builder 出生点的紧邻格：新的取能点规则（按距离选最近）必须选它，
    // 而不是十几格外的源容器——旧代码是"先容器、容器没有才 storage"，永远轮不到它（生效断言 builder.nearestEnergySource）
    const builderSpot = context.allocator.near(context.spawn, { minRange: 4, maxRange: 6 });
    const storagePos = context.allocator.near(builderSpot, { minRange: 1, maxRange: 1 });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: 800 }, capacity: { energy: 1000000 } });
    const sourceContainers = [];
    for (let index = 0; index < context.sources.length; index++) {
        sourceContainers.push(await addEnergyContainer(cli, context, context.sources[index], 0));
    }
    // 塔停在储备线上（500/1000）：tower.js 要求 energy - 10 >= towerRepairReserve 才修，所以它一次也修不动
    const towerPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 6 });
    await addStructure(cli, context, 'tower', towerPos, { store: { energy: 500 }, capacity: { energy: 1000 } });
    // 射程内的危急路（100/5000 = 2% < criticalRepairShare）与射程外（> 20 格）的危急路（60/5000 = 1.2%，比例更低）：
    // builder 先修比例更低的那条（射程外，塔够不到优先级），塔修射程内那条
    const nearRoadPos = context.allocator.near(towerPos, { minRange: 1, maxRange: 4 });
    const farRoadPos = context.allocator.near(towerPos, { minRange: 24, maxRange: 30 });
    // 播 250 / 150 血：新建的道路在第一个 tick 会掉 100 血（引擎 roads/tick.js 对没有 nextDecayTime 的路立刻衰减一次），
    // 播 100/60 会在第 1 tick 就消失；250/150 掉完仍 < 20%（危急线 1000），且比值低于下面的 tank（4.8%），
    // builder 会先修它们
    await addStructure(cli, context, 'road', nearRoadPos, { hits: 250, hitsMax: 5000 });
    await addStructure(cli, context, 'road', farRoadPos, { hits: 150, hitsMax: 5000 });
    // 射程内的危急容器（12000/250000 = 4.8%）：塔的维修预算会被它吃住一段时间。注意它**不会**整轮留在维修池里：
    // utils.needsRepair 按 hits < hitsMax × towerRepairBelow（0.6）判定，修到 15 万血（不是补满）就离开池子；
    // hauler 早早把塔补到储备线以上时，中途那一次快照前容器和路就都修过线了（validation-u84Rjo：快照里只剩 rampart）。
    // 所以生效断言 maintenance.repairPoolNeutral 不再靠单次快照，而是看测试专用的逐 tick 闩锁
    // （repairPoolNeutralObserver → Memory._repairPoolNeutral：池里第一次出现道路/容器的那一 tick）
    const tankPos = context.allocator.near(towerPos, { minRange: 2, maxRange: 8 });
    await addStructure(cli, context, 'container', tankPos, { hits: 12000, hitsMax: 250000, store: { energy: 0 } });
    // 控制器 link（收货端，800/800）：RCL6 没有 store link 时升级者吃不满的源收入会堵在这里，
    // builder 的取能点选择现在把它算作候选（只借收货端，不动源 link）。生效断言 builder.nearestEnergySource
    // 看它有没有被 builder 借走——没有任何别的代码会动这座 link 的能量。
    const ctrlLinkPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 6 });
    await addStructure(cli, context, 'link', ctrlLinkPos, { store: { energy: 800 }, capacity: { energy: 800 } });
    // 方案里另外 4 格路没有结构也没有工地 → 缺失道路，触发"让位"
    const missingRoads = [];
    for (let index = 0; index < 4; index++) {
        missingRoads.push(context.allocator.near(context.spawn, { minRange: 2 + index, maxRange: 2 + index }));
    }
    const plan = emptyPlan(context);
    plan.wheel = true;
    plan.ext = extensions;
    plan.storage = storagePos;
    plan.towers = [towerPos];
    plan.containers.src0 = sourceContainers[0].position;
    plan.containers.src1 = sourceContainers[1].position;
    plan.workPositions.src0 = sourceContainers[0].position;
    plan.workPositions.src1 = sourceContainers[1].position;
    plan.links.ctrl = ctrlLinkPos;
    plan.roads.all = [nearRoadPos, farRoadPos, ...missingRoads].map((pos) => pos.x + '.' + pos.y).join(';');
    plan.containers.spare = tankPos;   // 只是让 needsRepair 认它（placeSites 只放 src0/src1/ctrl）
    // 40 个名额：36 个零进度外环 rampart 工地 + terminal + 3 lab（进度 5 万–10 万，effectTicks 内建不完）
    const rampartSpots = [];
    for (let index = 0; index < 36; index++) {
        const pos = context.allocator.near(context.spawn, { minRange: 8 + Math.floor(index / 12), maxRange: 8 + Math.floor(index / 12) });
        rampartSpots.push(pos);
    }
    plan.ramparts = rampartSpots;
    const terminalPos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 6 });
    plan.terminal = terminalPos;
    const labSpots = [];
    for (let index = 0; index < 3; index++) {
        labSpots.push(context.allocator.near(context.spawn, { minRange: 4 + index, maxRange: 4 + index }));
    }
    plan.labs = labSpots;
    // 用 constructedWall 工地而不是 rampart：外环 rampart 现在要过收入门槛（rampartRingMinIncome），
    // 这个房的收入养不起外环，零进度的 rampart 工地会被 trimSites 清掉、让位逻辑就没有对象可测了。
    // 让位逻辑（yieldRampartSitesForRoads）本来就同时认 rampart 与 wall 工地，场景意图不变。
    plan.walls = rampartSpots;
    for (const pos of rampartSpots) await addSite(cli, context, 'constructedWall', pos, 0);
    await addSite(cli, context, 'terminal', terminalPos, 0);
    for (const pos of labSpots) await addSite(cli, context, 'lab', pos, 0);
    // 压在 spawn 上的 15 万血 rampart：RCL6 的维修目标从 30 万降到 10 万之后它不再进维修池
    // （旧目标 30 万时 needsRepair 为真；生效断言 layout.rampartTargetFitsIncome 看维修池里有没有 rampart）
    await addStructure(cli, context, 'rampart', context.spawn, { hits: 150000 });
    const utilsMod = loadSrcModule('utils');
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, {
            name: `mt-harvester-${index}`,
            role: 'harvester',
            body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(context, sourceContainers[index].position, true),
            memory: { sourceIdx: index, sourceId: context.sources[index]._id, staticMiner: true },
        });
    }
    // 0 能量的 builder：它必须先取到能量（空 storage 取不到 → 旧代码在这里永久挂机）
    await addCreep(cli, context, {
        name: 'mt-builder',
        role: 'builder',
        body: utilsMod.makeBody('builder', 1300),
        position: creepPosition(context, builderSpot, false),
    });
    // 满载 hauler 站在塔边：塔的维修补能提到第 1 层后，这车能量会先给塔（旧代码给 spawn/ext）。
    // 2026-09-10 起播 0 能量 + retired：builder 的"等投递"现在要求房里有真会来投递的 hauler（有能量的、
    // 或已经认领了送它这单的），空手/退役中的 hauler 不该让 builder 白等——生效断言 builder.feedProspect
    // 看 builderFeed.self（旧代码只数"房里有几只 hauler"，这只会让它白等 30 tick）。
    await addCreep(cli, context, {
        name: 'mt-hauler',
        role: 'hauler',
        body: utilsMod.makeBody('hauler', 1300),
        energy: 0,
        memory: { retired: true },
        position: creepPosition(context, towerPos, false),
    });
    // 大身体升级者站在控制器 link 边：storage 只播 800（< upgrading.lowBelow 5000），
    // 升级预算应把控制器压到本地供给的 incomeShare（2 源 20/tick × 0.6 = W12），
    // 遥测 Memory.rooms[房].upgradeBudget（生效断言 upgrader.incomeShare）
    await addCreep(cli, context, {
        name: 'mt-upgrader',
        role: 'upgrader',
        body: utilsMod.makeBody('upgrader', 2300, { maxWork: 50 }),
        position: creepPosition(context, ctrlLinkPos, false),
    });
    // 远处的路工地（进度 200/300，剩余最少 → nextSite 选它）+ 站在工地边的 0 能量 builder，
    // feedAt 播成"刚刚在工地上用完能量"：房里的 hauler 都不会来投递，所以它必须立刻自己去取，
    // 而不是原地等 30 tick（生效断言 builder.feedProspect 看 builderFeed.self）。
    // 工地离 storage/link 都在 8 格以上（builderSelfFetchRange），否则它会走"取能点很近就自己去取"那条路，
    // 观察不到"等投递"这个判断。
    const farSitePos = context.allocator.near(context.spawn, { minRange: 16, maxRange: 20 });
    await addSite(cli, context, 'road', farSitePos, 200);
    await addCreep(cli, context, {
        name: 'mt-builder2',
        role: 'builder',
        body: utilsMod.makeBody('builder', 1300),
        position: creepPosition(context, farSitePos, false),
        memory: { feedAt: context.gameTime },
    });
    // 第二房：纯维修（武装的塔 + 没有工地 + 没有危急结构 + 塔射程外的旧路），
    // 生效断言 spawn.repairDemandBuilders 看它的 builderTarget（旧代码 0，新代码 ≥1）
    const repairOnly = await roomContextFor(cli, context, ROOMS.repairOnly);
    await updateController(cli, repairOnly, 5);
    const roSpawnPos = repairOnly.allocator.near(repairOnly.controller, { minRange: 4, maxRange: 10 });
    repairOnly.spawn = await insertObject(cli, repairOnly, Object.assign(
        structureDocument(repairOnly, 'spawn', roSpawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'RepairOnlySpawn', spawning: null, notifyWhenAttacked: false }));
    // 武装的塔：≥500 能量 ⇒ 旧代码的"有能量的塔会修"守卫生效
    const roTowerPos = repairOnly.allocator.near(roSpawnPos, { minRange: 2, maxRange: 6 });
    await addStructure(cli, repairOnly, 'tower', roTowerPos, { store: { energy: 1000 }, capacity: { energy: 1000 } });
    // 塔射程（20 格）外的旧路 24% 血：需要维修（< 60%）但不危急（> 20%），塔又够不着。
    // 必须写进 plan.roads：方案外的旧路按新规则不修（utils.plannedStructure），那样就测不到这里要测的东西了。
    // 2026-09-11 起射程外维修债要 ≥ construction.outOfReachMinDebt（1 万血）才为它孵 builder。决策事件 outOfReachRepair 只在
    // "没有工地"时写，而到那时债已经被修掉不少：开局 recovering 期间塔射程内没活、会退回全局去修这些路（储备线以上约 500 能量 ≈ 1 万血），
    // 核心 rampart 工地期间 builder 也会顺手修。14 条 × 1800 ≈ 2.5 万时在下限附近来回（validation-AXhRew 过、下一轮随机地形没过），
    // 改成 28 条 ≈ 5 万
    const roRoads = [];
    for (let index = 0; index < 28; index++) {
        // 相对**塔**取位（不是 spawn）：allocator 取的是最近空闲格，相对 spawn 的 22 格可能正好朝着塔的方向、实际只有 16 格——那样塔就够得着了。
        // 塔贴着房间边时 21–24 格的环里放不下 28 条（validation-hRIaXP：塔在 (4,41)），放宽到 35 格；至少要 14 条
        const pos = nearOrNull(repairOnly.allocator, roTowerPos, { minRange: 21, maxRange: 35 });
        if (!pos) break;
        roRoads.push(await addStructure(cli, repairOnly, 'road', pos, { hits: 1200, hitsMax: 5000 }));
    }
    if (roRoads.length < 14) throw new Error('repairOnly: 塔射程外只放下 ' + roRoads.length + ' 条路（随机地形），重跑验证');
    const roPlan = emptyPlan(repairOnly);
    roPlan.wheel = true;
    roPlan.version = 'validation-repair-only';
    roPlan.towers = [roTowerPos];
    roPlan.roads.all = roRoads.map((pos) => pos.x + '.' + pos.y).join(';');
    // 一只矿工：给这一房视野（Game.rooms 里有它的 creep 才会跑 runRoom），顺便让房不算死房
    const roSource = repairOnly.allocator.near(repairOnly.sources[0], { minRange: 1, maxRange: 1 });
    await addCreep(cli, repairOnly, {
        name: 'ro-harvester-0',
        role: 'harvester',
        body: utilsMod.makeBody('harvester', 300),
        position: creepPosition(repairOnly, roSource, true),
        memory: { sourceIdx: 0, sourceId: repairOnly.sources[0]._id, home: ROOMS.repairOnly },
    });
    Object.assign(context.creepMemory, repairOnly.creepMemory);
    // writeMemory 是整棵 Memory 的覆盖写：两房必须在同一次调用里写，否则后一次会把前一房清掉
    await writeMemory(cli, context, { rooms: {
        [context.room]: { plan, maintenanceSeed: { nearRoad: nearRoadPos, farRoad: farRoadPos, tower: towerPos, ctrlLink: ctrlLinkPos, missingRoads } },
        [repairOnly.room]: { plan: roPlan },
    } });
    context.maintenance = { nearRoad: nearRoadPos, farRoad: farRoadPos, tower: towerPos, ctrlLink: ctrlLinkPos, ramparts: rampartSpots };
    context.repairOnly = { tower: roTowerPos, roads: roRoads };
    return context;
}

async function seedReserveContinuity(cli, options = {}) {
    const homeName = options.home || ROOMS.reserveHome;
    const targetName = options.target || ROOMS.reserveTarget;
    const context = await spawnBot(cli, options.scenario || 'reserveContinuity', homeName);
    await updateController(cli, context, options.budgetDeadline ? 5 : 4);
    await setSpawnEnergy(cli, context, 300);
    const plan = emptyPlan(context);
    plan.ext = await addExtensions(cli, context, options.budgetDeadline ? 30 : 20, 50);
    for (let index = 0; index < 2; index++) {
        const source = context.sources[index];
        const container = await addEnergyContainer(cli, context, source, 2000);
        plan.containers['src' + index] = container.position;
        plan.workPositions['src' + index] = container.position;
        await addCreep(cli, context, { name: 'reserve-core-miner-' + index, role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            position: creepPosition(context, container.position, true), memory: { sourceIdx: index, sourceId: source._id } });
    }
    const controllerContainer = await addEnergyContainer(cli, context, context.controller, 2000);
    plan.containers.ctrl = controllerContainer.position;
    plan.workPositions.ctrl = controllerContainer.position;
    // Budget tests isolate remote competition: random home geometry can require more
    // than three haulers. Seed the current bounded fleet ceiling with full-capacity
    // bodies, then verify actual production targets and total CARRY before activation.
    const coreHaulers = options.budgetDeadline ? Number(loadSrcModule('config').hauling.ceil[5]) : 3;
    for (let index = 0; index < coreHaulers; index++) {
        await addCreep(cli, context, { name: 'reserve-core-hauler-' + index, role: 'hauler',
            body: loadSrcModule('utils').makeBody('hauler', options.budgetDeadline ? 1800 : 1300),
            // deadline 场景要一个"非抢占的运输孵化"占住 spawn：把最后一只 hauler 的寿命压到 roleLead 以下，
            // 队列必须补一只同规格（26 部件 / 1300）的 hauler——reserver 的接班请求要在它之前排上。
            // 随机地形会让 demand.targets.hauler 在 2–5 之间跳，靠"编制缺员"来造这条需求是不可复现的。
            ticksToLive: options.deadline && !options.budgetDeadline && index === 2 ? 20 : undefined });
    }
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, { name: 'reserve-core-upgrader-' + index, role: 'upgrader',
            body: ['work', 'work', 'work', 'work', 'work', 'work', 'carry', 'carry', 'move', 'move'],
            position: creepPosition(context, controllerContainer.position, index === 0), energy: 100 });
    }
    await addCreep(cli, context, { name: 'reserve-core-feeder', role: 'feeder', body: ['carry', 'carry', 'move'] });
    await addCreep(cli, context, { name: 'reserve-core-builder', role: 'builder',
        body: ['work', 'work', 'work', 'carry', 'carry', 'carry', 'move', 'move', 'move'] });
    const data = await cli.evaluateJson(`Promise.all([storage.db['rooms.terrain'].findOne({room:${literal(targetName)}}),storage.db['rooms.objects'].find({room:${literal(targetName)}})]).then(function(v){return {terrain:v[0].terrain,objects:v[1]}})`);
    const allocator = new PositionAllocator(data.terrain, data.objects);
    const controller = data.objects.find((o) => o.type === 'controller');
    const minimumTravel = Math.max(Math.abs(controller.x - context.spawn.x),
        Math.abs(100 + controller.y - context.spawn.y)) - 1;
    const cachedTravel = Math.max(1, minimumTravel - 60);
    const incumbentTtl = cachedTravel + 12 + 60 + 20 + 33;
    // Either missing grace OR trusting the under-estimated cache queues after tick33; both fixes queue immediately.
    await addCreep(cli, context, { name: 'reserve-incumbent', role: 'reserver', body: ['claim', 'move'],
        room: targetName, position: allocator.near(controller, { minRange: 1, maxRange: 1 }),
        ticksToLive: options.deadline ? 500 : incumbentTtl, memory: { remoteRoom: targetName, slotKey: 'reserver:' + targetName } });
    const sources = [];
    const sourceObjects = data.objects.filter((o) => o.type === 'source');
    // 让位夹具（effects remoteHauler.spotYield，只播在本体场景，deadline/budget 变体不动）：一个源的 hauler 站在矿位（容器格）上、
    // 容器只有 100（装不满它）、矿工在旁边一格等着进矿位、没有掉落——旧代码 hauler 取了 100 就站在矿位上等货，矿工永远进不去、
    // 容器零进账（线上 W32S1：4 只 hauler 187 tick 零交付）；新代码同 tick 取货 + 让开，矿工进位后容器有了进账，hauler 装满出发。
    // 矿位周围至少要两格空地（矿工一格、让位一格）：随机地形下挑一个满足的源，都不满足就在播种时抛错（别让断言以"没观察到"误报）
    const base = !options.scenario;
    const presetSpots = base ? sourceObjects.map((source) => allocator.near(source, { minRange: 1, maxRange: 1 })) : null;
    let yieldIndex = -1;
    if (base) {
        const freeAround = (pos) => {
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && allocator.free(pos.x + dx, pos.y + dy)) n++;
            return n;
        };
        for (let index = presetSpots.length - 1; index >= 0 && yieldIndex < 0; index--) if (freeAround(presetSpots[index]) >= 2) yieldIndex = index;
        if (yieldIndex < 0) throw new Error(`reserveContinuity: ${targetName} 没有矿位周围留得出两格空地（矿工一格、让位一格），spotYield 夹具不成立——随机地形，重跑验证`);
    }
    for (let index = 0; index < sourceObjects.length; index++) {
        const source = sourceObjects[index];
        const spot = presetSpots ? presetSpots[index] : allocator.near(source, { minRange: 1, maxRange: 1 });
        const yieldSpot = index === yieldIndex;
        const container = await insertObject(cli, context, { type: 'container', room: targetName,
            x: spot.x, y: spot.y, hits: 250000, hitsMax: 250000, store: { energy: yieldSpot ? 100 : 500 }, storeCapacity: 2000,
            nextDecayTime: context.gameTime + 5000 });
        const id = String(source._id);
        sources.push({ id, pos: { x: source.x, y: source.y }, spot, distance: 1,
            energyCapacity: 3000, containerId: String(container._id), roadComplete: true, road: '' });
        const minerPosition = yieldSpot
            ? (nearOrNull(allocator, spot, { minRange: 1, maxRange: 1, filter: (pos) => chebyshev(pos, source) <= 1 }) ||
                allocator.near(spot, { minRange: 1, maxRange: 1 }))
            : spot;
        await addCreep(cli, context, { name: 'reserve-remote-miner-' + id, role: 'remoteMiner',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'],
            room: targetName, position: minerPosition,
            memory: { remoteRoom: targetName, sourceId: id, slotKey: 'remoteMiner:' + targetName + ':' + id } });
        if (!yieldSpot) await insertObject(cli, context, { type: 'energy', room: targetName, x: spot.x, y: spot.y, energy: 3000, resourceType: 'energy' });
        const haulerPosition = yieldSpot ? spot : allocator.near(spot, { minRange: 1, maxRange: 1 });
        const roadPosition = allocator.near(haulerPosition, yieldSpot ? { minRange: 2, maxRange: 3 } : { minRange: 1, maxRange: 2 });
        // 连续施工足以吞掉整趟货的路工地：预算须到 50 后让运输工离开并完成投递。
        await insertObject(cli, context, { type: 'constructionSite', structureType: 'road',
            room: targetName, x: roadPosition.x, y: roadPosition.y, user: context.userId,
            progress: 0, progressTotal: 600 });
        await addCreep(cli, context, { name: 'reserve-remote-hauler-' + id, role: 'remoteHauler',
            body: ['work'].concat(Array(24).fill('carry'), Array(13).fill('move')),
            room: targetName, position: haulerPosition,
            memory: { remoteRoom: targetName, sourceId: id, haulSlot: 0,
                slotKey: 'remoteHauler:' + targetName + ':' + id + ':0' } });
        if (yieldSpot) context.spotYield = { source: id, spot, container: 100 };
    }
    if (options.roadTrail) {
        // 路线失配夹具（effects remote.roadTrailReplan）：把"规划的房内路线"播在没人走的走廊上，复现线上 W31S9 的形态——
        // 规划器（remote.planRoute 从母房锚点搜）和 creep 的寻路（目标是卸货房房心 range 20）在代价并列时各挑一条走廊，
        // 路工地按规划路放、而顺手修路只在满载 hauler 的 3 格射程内发生，工地进度就永远是 0。
        // 母房在正北，满载腿一律往北走：所以只挑"不在矿位以北、且离矿位 ≥ 12 格"的空地当假路线，保证它永远进不了射程。
        // 同时播 routeRoads：否则 refreshVisible 会因为 routeRoads 缺失重跑 planRoute，把假路线换成真规划路，夹具就不成立了。
        const bogusRoad = (spot) => {
            const usable = (pos) => pos.x > 0 && pos.x < 49 && pos.y > 0 && pos.y < 49 &&
                allocator.free(pos.x, pos.y) && pos.y >= spot.y && chebyshev(pos, spot) >= 12;
            let anchor = null;
            for (let y = 48; y > 0 && !anchor; y--) for (let x = 1; x < 49 && !anchor; x++) if (usable({ x, y })) anchor = { x, y };
            if (!anchor) return null;
            const tiles = [anchor];
            while (tiles.length < 5) {
                const cur = tiles[tiles.length - 1];
                const next = [{ x: cur.x + 1, y: cur.y }, { x: cur.x - 1, y: cur.y }, { x: cur.x, y: cur.y - 1 },
                    { x: cur.x + 1, y: cur.y - 1 }, { x: cur.x - 1, y: cur.y - 1 }]
                    .find((pos) => usable(pos) && !tiles.some((tile) => tile.x === pos.x && tile.y === pos.y));
                if (!next) break;
                tiles.push(next);
            }
            return tiles.length >= 3 ? tiles.map((tile) => tile.x + '.' + tile.y).join(';') : null;
        };
        for (const source of sources) {
            const road = bogusRoad(source.spot);
            if (!road) throw new Error(`roadTrail: ${targetName} 的矿位 ${source.spot.x},${source.spot.y} 附近找不到"离矿位 ≥ 12 格且不在它北边"的空地，播不出没人走的走廊——随机地形，重跑验证`);
            source.road = road;
            source.roadComplete = false;
            source.routeRoads = { [targetName]: road };
            // 连续失配的计数本身由冒烟覆盖（21 条断言）；验证的 tick 预算装不下三趟满载往返，这里播到阈值前一趟，
            // 要观察的是"真实走线被逐格记下 → 离房汇总 → 与规划路比对 → 采纳"这条完整的在线路径。
            source.roadMismatch = 2;
        }
        context.roadTrailSeed = sources.map((source) => ({ id: source.id, road: source.road, spot: source.spot }));
        // 配额口径夹具（effects remote.roadQuotaCountsOwnRemotesOnly）：本母房 remotes 里有一个**停用**的房名，
        // 而它归本用户的另一条记录在跑（usedByAnotherHome），房里有本用户的路工地。旧代码 homeRemoteRoadSites
        // 只判房名在不在 remotes 里，会把这些工地算进本房配额（线上 W32S4 因此 13/12 超限、自己的外矿放不出工地）。
        // 第二个"母房"用 Memory 记录模拟即可：usedByAnotherHome 与计数读的都只是 Memory，不要求那个房被拥有；
        // 这样 trimRemoteSites 也不会把这些工地当成自己的残留清掉（否则 others 会归零，夹具就不成立）。
        const foreignRoom = ROOMS.roadTrailForeign;
        // 播满 roadSitesPerHome 个：这样**旧口径**下本母房的配额被这一个房独占，budget 必为 0、自己的外矿一个工地都放不出来；
        // 新口径只数启用外矿，budget 照常。断言因此可以只看"我自己的外矿有没有工地"这个**结果**，
        // 不必拿决策时刻的遥测快照去比结束态（那正是 logistics 那族断言脆弱的原因）
        const foreignCap = Math.max(1, Number((loadSrcModule('config').remote || {}).roadSitesPerHome) || 12);
        const foreignSites = [];
        for (let i = 0; i < foreignCap; i++) {
            const pos = { x: 10 + (i % 20), y: 20 + Math.floor(i / 20) };
            await insertObject(cli, context, { type: 'constructionSite', structureType: 'road', room: foreignRoom,
                x: pos.x, y: pos.y, user: context.userId, progress: 0, progressTotal: SITE_COST.road || 300 });
            foreignSites.push(pos.x + '.' + pos.y);
        }
        context.roadQuotaSeed = { foreignRoom, foreignSites, cap: foreignCap };
    }
    if (base) {
        // 寿命的最后一趟夹具（effects remoteHauler.ttlRetire）：母房里一只带 100 能量、只剩 150 tick 的外矿 hauler（没有槽位，
        // 替补不在计划里）——卸空时 去程 + 回程（修正后的路程 ~100+ 格）+ 20 远大于 150、外矿容器放得下这段空档的进账，应回收退役
        await addCreep(cli, context, { name: 'reserve-remote-hauler-ttl', role: 'remoteHauler', body: ['carry', 'carry', 'move', 'move'],
            energy: 100, ticksToLive: 150, memory: { remoteRoom: targetName, sourceId: sources[0].id, state: 'deliver' } });
    }
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(String(controller._id))}},{$set:{reservation:{user:${literal(context.userId)},endTime:${context.gameTime + 1}}}}).then(function(){return true})`);
    const memoryRooms = { [context.room]: { plan, remoteMemoryVersion: 1,
        remotes: { [targetName]: { room: targetName, enabled: true, lastSeen: context.gameTime,
            controllerId: String(controller._id), controllerPos: { x: controller.x, y: controller.y }, controllerDistance: cachedTravel,
            sources, reservation: { username: context.username, ticksToEnd: 1, seenAt: context.gameTime } } } } };
    if (context.roadQuotaSeed) {
        // 本母房 remotes 里多一个**停用**的房名（大脑白名单里没有它，run() 会把它标成 notWhitelisted 并保持停用）
        memoryRooms[context.room].remotes[context.roadQuotaSeed.foreignRoom] = {
            room: context.roadQuotaSeed.foreignRoom, enabled: false, suspendReason: 'notWhitelisted', sourceCount: 1, sources: [] };
        // 本用户的另一条记录仍在跑它（usedByAnotherHome 读的就是这个），所以 trimRemoteSites 不会清那些工地
        memoryRooms[context.roadQuotaSeed.foreignRoom + '-owner'] = { remoteMemoryVersion: 1,
            remotes: { [context.roadQuotaSeed.foreignRoom]: { room: context.roadQuotaSeed.foreignRoom, enabled: true, sourceCount: 1, sources: [] } } };
    }
    await writeMemory(cli, context, { rooms: memoryRooms,
        brain: { version: 1, issuedAt: Date.now(), ttlMs: 86400000,
            rooms: { [context.room]: { remotes: [targetName], scouts: 0 } } } });
    if (options.deadline) {
        // Measure using this user's production remote.run before an energy-starved spawn can start.
        await cli.evaluateJson(`Promise.all([storage.db['rooms.objects'].update({user:${literal(context.userId)},room:${literal(homeName)},type:{$in:['spawn','extension']}},{$merge:{store:{energy:0}}}),storage.db['rooms.objects'].update({room:${literal(homeName)},type:'container'},{$merge:{store:{energy:0}}}),storage.db['rooms.objects'].removeWhere({user:${literal(context.userId)},name:{$in:${literal(options.budgetDeadline ? [] : ['reserve-core-hauler-1','reserve-core-hauler-2'])}}})]).then(function(){return true})`);
    }
    return context;
}


function reserveOrderedObserver(homeName,earlyRoom,targetRoom) {
    return `
const observeSchedule = module.exports.schedule;
module.exports.schedule = function(requests, ctx) {
    const haulIndex=requests.findIndex(r=>r.role==='remoteHauler'&&r.memory&&r.memory.remoteRoom===${literal(earlyRoom)});
    const reserveIndex=requests.findIndex(r=>r.role==='reserver'&&r.memory&&r.memory.remoteRoom===${literal(targetRoom)});
    if (!Memory._reserveOrderedInitialized && ctx.energy===1100 && haulIndex>=0 && reserveIndex>haulIndex) {
        ctx.since[requests[haulIndex].key]=ctx.now-61;
        Memory.rooms[${literal(homeName)}].spawnSince[requests[haulIndex].key]=ctx.now-61;
        Memory._reserveOrderedInitialized=true;
    }
    const result = observeSchedule(requests,ctx);
    if (Memory._reserveOrderedInitialized && !Memory._reserveOrderedEvidence) {
        const haulIndex=requests.findIndex(r=>r.role==='remoteHauler'&&r.memory&&r.memory.remoteRoom===${literal(earlyRoom)});
        const reserveIndex=requests.findIndex(r=>r.role==='reserver'&&r.memory&&r.memory.remoteRoom===${literal(targetRoom)});
        if (haulIndex>=0&&reserveIndex>=0) {
            const haul=requests[haulIndex], reserve=requests[reserveIndex], body=haul.body(ctx.energy);
            Memory._reserveOrderedEvidence={at:ctx.now,haulIndex,reserveIndex,haulKey:haul.key,reserveKey:reserve.key,
                context:Object.assign({},ctx,{since:Object.assign({},ctx.since)}),
                requests:requests.map(r=>Object.assign({},r,{item:undefined,memory:undefined,body:undefined,
                    idealBody:typeof r.body==='function'?r.body(ctx.capacity):[],availableBody:typeof r.body==='function'?r.body(ctx.energy):[]})),
                haulPriority:haul.priority,reservePriority:reserve.priority,haulOrdered:haul.ordered,reserveOrdered:reserve.ordered,
                energy:ctx.energy,capacity:ctx.capacity,haulCost:require('utils').bodyCost(body),haulParts:body.length,
                haulSince:ctx.since[haul.key],haulGrace:haul.grace,neededBy:reserve.neededBy,
                blocked:result.blocked,actions:result.actions.map(a=>({key:a.request.key,cost:a.cost,parts:a.body.length}))};
        }
    }
    return result;
};`;
}

async function seedReserveOrdered(cli) {
    const context = await seedReserveContinuity(cli, {home:ROOMS.reserveOrderedHome,target:ROOMS.reserveOrderedTarget,
        scenario:'reserveOrdered',deadline:true,budgetDeadline:true});
    const room = ROOMS.reserveOrderedEarly;
    const data = await cli.evaluateJson(`Promise.all([storage.db['rooms.terrain'].findOne({room:${literal(room)}}),storage.db['rooms.objects'].find({room:${literal(room)}})]).then(v=>({terrain:v[0].terrain,objects:v[1]}))`);
    const allocator = new PositionAllocator(data.terrain, data.objects);
    const controller = data.objects.find(o=>o.type==='controller');
    const sources = [];
    for (const source of data.objects.filter(o=>o.type==='source')) {
        const spot = allocator.near(source,{minRange:1,maxRange:1});
        const container = await insertObject(cli,context,{type:'container',room,x:spot.x,y:spot.y,hits:250000,hitsMax:250000,
            store:{energy:500},storeCapacity:2000,nextDecayTime:context.gameTime+5000});
        const id = String(source._id);
        sources.push({id,pos:{x:source.x,y:source.y},spot,distance:50,energyCapacity:3000,containerId:String(container._id),roadComplete:false});
        await addCreep(cli,context,{name:'ordered-miner-'+id,role:'remoteMiner',room,position:spot,
            body:['work','work','work','work','work','carry','move','move','move'],
            memory:{remoteRoom:room,sourceId:id,slotKey:'remoteMiner:'+room+':'+id}});
    }
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(String(controller._id))}},{$set:{reservation:{user:${literal(context.userId)},endTime:${context.gameTime+4500}}}}).then(()=>true)`);
    const memory = context.initialMemory;
    memory.rooms[context.room].remotes[room]={room,enabled:true,lastSeen:context.gameTime,controllerId:String(controller._id),
        controllerPos:{x:controller.x,y:controller.y},sources,reservation:{username:context.username,ticksToEnd:4500,seenAt:context.gameTime}};
    memory.brain.rooms[context.room].remotes=[room,ROOMS.reserveOrderedTarget];
    await writeMemory(cli,context,memory);
    return context;
}


// A separate user prevents aid from replacing the storage-only supply condition.
async function seedStorageConsumer(cli, linkConsumer = false) {
    const key = linkConsumer ? 'controllerLinkConsumer' : 'storageConsumer';
    const context = await spawnBot(cli, key, ROOMS[key]);
    await cli.evaluateJson(`storage.db['rooms.objects'].removeWhere({_id:${literal(context.spawn._id)}}).then(function(){return true})`);
    await updateController(cli, context, linkConsumer ? 5 : 4);
    const reserve = Number((loadSrcModule('config').upgrading || {}).reserve) || 2000;
    const storagePos = context.allocator.near(context.controller, { minRange: 6, maxRange: 10 });
    await addStructure(cli, context, 'storage', storagePos, { store: { energy: reserve + 600 }, capacity: { energy: 1000000 } });
    const ctrl = await addEnergyContainer(cli, context, context.controller, 0);
    context.spawn = storagePos; // planned anchor only; no spawning or free spawn regeneration
    const plan = emptyPlan(context);
    plan.wheel = true;
    plan.storage = storagePos;
    plan.spawns = [];
    // Full extensions keep the isolated upgrader out of emergency harvest; no spawn can consume them.
    const emergencyFloor = Number((loadSrcModule('config').recovery || {}).emergencyHarvestBelow) || 200;
    plan.ext = await addExtensions(cli, context, Math.ceil(emergencyFloor / 50), 50);
    plan.containers.ctrl = ctrl.position;
    plan.workPositions.ctrl = ctrl.position;
    // 控制器容器贴着源（2026-10-14，validation-52vHk6 W41N40 的随机地形）：把离控制器最近的源挪到控制器容器旁 1 格，
    // 每轮都覆盖这种几何——旧 hauler.srcIsPlanned 的"源旁 1 格"兜底把方案的 ctrl 容器认成源容器，hauler 整局 park、升级 0。
    // 生效断言 hauling.ctrlContainerBesideSource（hauling.storageConsumerFallback 照旧）
    let besideSource = null;
    if (!linkConsumer) {
        const source = context.sources.slice().sort((a, b) => chebyshev(a, context.controller) - chebyshev(b, context.controller))[0];
        const spot = nearOrNull(context.allocator, ctrl.position, { minRange: 1, maxRange: 1,
            filter: (pos) => chebyshev(pos, context.controller) >= 1 && chebyshev(pos, storagePos) >= 3 });
        if (!spot) throw new Error('storageConsumer fixture: no free tile next to the controller container for the source');
        await cli.evaluateJson(
            `storage.db['rooms.objects'].update({_id:${literal(String(source._id))}},{$set:{x:${spot.x},y:${spot.y}}}).then(function(){return true})`);
        source.x = spot.x;
        source.y = spot.y;
        besideSource = { ctrl: { x: ctrl.position.x, y: ctrl.position.y }, source: { x: spot.x, y: spot.y }, sourceId: String(source._id) };
    }
    if (linkConsumer) {
        const linkPos = context.allocator.near(ctrl.position, { minRange: 1, maxRange: 1 });
        await addStructure(cli, context, 'link', linkPos, { store: { energy: 0 }, capacity: { energy: 800 } });
        plan.links = { ctrl: linkPos };
    }
    for (let i = 0; i < context.sources.length; i++) {
        const source = await addEnergyContainer(cli, context, context.sources[i], 0);
        plan.containers['src' + i] = source.position;
    }
    await addCreep(cli, context, { name: 'storage-consumer-hauler', role: 'hauler',
        body: ['carry', 'carry', 'carry', 'carry', 'move', 'move'], position: creepPosition(context, storagePos, false) });
    await addCreep(cli, context, { name: 'storage-consumer-upgrader', role: 'upgrader',
        body: ['work', 'carry', 'move'], position: creepPosition(context, ctrl.position, true) });
    await writeMemory(cli, context, Object.assign({ rooms: { [context.room]: { plan } } },
        besideSource ? { _validationCtrlBesideSource: besideSource } : {}));
    return context;
}

/** 出生口袋（auditPocket，线上 2026-10-08 W31S4 的形态）：RCL6、40 个满能量 extension（容量 2300）、storage 3000（吃紧档）、两只容器静态矿工 + 1 只 hauler。
 *  spawn 正上方的格 T 除了 spawn 那一面，其余 7 个邻格全是 extension 或地形墙——引擎按方向 1..8 出生、TOP 最先，旧代码孵出来的 creep 第一只就进 T 再也出不来。
 *  T 里预先困着一只空手的 12W6C1M 升级者（线上 慧音甲 的身体），离控制器 > 3 格。观察面：
 *   - spawn.pocketDirections：spawnPocket 遥测记下 TOP 是口袋，结束态 T 里没有任何新孵的 creep
 *   - spawn.pocketTrappedRecycle：困住的升级者连续两轮扫描（trappedScanInterval）都在口袋格后被 spawn_exit.markPocketTrapped 标记、贴着的 spawn 当场回收，spawnStallLog.trapped 遥测
 *     （原先由看门狗 stuckRetireTicks 后才退役，upgrader.stuckWatchdog 改在 auditWalled 观察）
 *   - spawn.upgraderSupplyCap：容量 2300 能出 W21，但 2 源本地供给 20/tick、storage 在 lowExitAbove 以下，升级者身体按供给封顶 W20 */
async function seedAuditPocket(cli, home, utilsMod) {
    const pk = await roomContextFor(cli, home, ROOMS.auditPocket);
    await updateController(cli, pk, 6);
    const free = (x, y) => pk.allocator.free(x, y);
    const wall = (x, y) => pk.allocator.wall(x, y);
    let geom = null;
    for (let y = 8; y <= 41 && !geom; y++) for (let x = 6; x <= 43 && !geom; x++) {
        const S = { x, y };
        const T = { x, y: y - 1 };
        if (!free(S.x, S.y) || !free(T.x, T.y) || chebyshev(S, pk.controller) < 7 || chebyshev(T, pk.controller) < 6) continue;
        // 下方三格 + 再下一格开阔：spawn 还有正常出口（新代码往这里出生）
        if (![-1, 0, 1].every((dx) => free(x + dx, y + 1)) || !free(x, y + 2) || !free(x - 1, y + 2) || !free(x + 1, y + 2)) continue;
        // T 的其余 7 个邻格：地形墙照用，空格放 extension；有别的东西（源/矿/控制器）就换位置
        const ring = [];
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
            if (!dx && !dy) continue;
            const t = { x: T.x + dx, y: T.y + dy };
            if (t.x === S.x && t.y === S.y) continue;
            if (wall(t.x, t.y)) continue;
            if (!free(t.x, t.y)) { ok = false; continue; }
            ring.push(t);
        }
        if (ok && ring.length >= 3) geom = { S, T, ring };
    }
    if (!geom) throw new Error('audit: auditPocket 找不到出生口袋几何（随机地形），重跑验证');
    pk.allocator.claim(geom.S);
    pk.allocator.claim(geom.T);
    pk.spawn = await insertObject(cli, pk, Object.assign(
        structureDocument(pk, 'spawn', geom.S, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'AuditPocketSpawn', spawning: null, notifyWhenAttacked: false }));
    // 下方出口那几格先占住，别被后面的 extension / 容器堵上
    const exits = [-1, 0, 1].map((dx) => pk.allocator.claim({ x: geom.S.x + dx, y: geom.S.y + 1 })).filter(Boolean);
    const ext = [];
    // spawn.pocketMineralObstacle（2026-10-08）：口袋圈上的一格放矿（把房里的矿挪过来）——矿是障碍，旧 BFS 当可走格，
    // 口袋经由矿格"连通"到外面就被误判成开口、照样往 TOP 出生
    let mineralAt = null;
    for (const t of geom.ring) {
        pk.allocator.claim(t);
        if (!mineralAt && pk.mineral) {
            await cli.evaluateJson(
                `storage.db['rooms.objects'].update({_id:${literal(pk.mineral._id)}},{$set:{x:${t.x},y:${t.y}}}).then(function(){return true})`);
            mineralAt = t;
            continue;
        }
        await addStructure(cli, pk, 'extension', t, { store: { energy: 50 }, capacity: { energy: 50 } });
        ext.push(t);
    }
    for (const t of await addExtensions(cli, pk, 40 - ext.length, 50)) ext.push(t);
    const pkContainers = {};
    for (let index = 0; index < 2; index++) {
        const source = pk.sources[index];
        const container = await addEnergyContainer(cli, pk, source, 0);
        pkContainers['src' + index] = container.position;
        await addCreep(cli, pk, { name: 'audit-pocket-miner-' + index, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(pk, container.position, true), memory: { home: pk.room, sourceIdx: index, sourceId: source._id, staticMiner: true } });
    }
    const storagePos = pk.allocator.near(pk.spawn, { minRange: 3, maxRange: 10, filter: (pos) => chebyshev(pos, pk.controller) >= 5 });
    await addStructure(cli, pk, 'storage', storagePos, { store: { energy: 3000 }, capacity: { energy: 1000000 } });
    await addCreep(cli, pk, { name: 'audit-pocket-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
        position: creepPosition(pk, storagePos, false), memory: { home: pk.room } });
    const body = [].concat(Array(12).fill('work'), Array(6).fill('carry'), ['move']);
    await addCreep(cli, pk, { name: 'audit-pocket-upgrader', role: 'upgrader', body, position: geom.T, energy: 0, memory: { home: pk.room } });
    const pkPlan = emptyPlan(pk);
    pkPlan.wheel = true;
    pkPlan.version = 'validation-audit-pocket';
    pkPlan.ext = ext;
    pkPlan.storage = storagePos;
    pkPlan.containers = Object.assign({}, pkPlan.containers, pkContainers);
    pkPlan.workPositions = Object.assign({}, pkPlan.workPositions, pkContainers);
    return { context: pk, plan: pkPlan, seed: { room: pk.room, spawn: geom.S, pocket: geom.T, exits, spawnName: 'AuditPocketSpawn', upgrader: 'audit-pocket-upgrader', storage: storagePos, mineral: mineralAt } };
}

/** 控制器够不着（auditWalled，upgrader.stuckBackoff）：控制器挪到开阔处、chebyshev 4 格一圈全是墙——升级者到不了 3 格射程。
 *  RCL6、30 个空 extension（容量 1800，不触发 aid）、storage 3000、两只容器静态矿工 + 1 只 hauler（不进恢复期/应急采集）。
 *  一只满能量的升级者贴着墙圈外，creep.memory.upStuck 播成"已原地不动 stuckRetireTicks − 20 tick、重算过一次"；
 *  Memory.rooms[房].upgraderStuck 播成"已连续 stuckBackoffAfter − 1 次退役、控制器标记 {l:6, p:0}"（真跑两圈要 700+ tick，验证窗口不够）。
 *  预期：~20 tick 后它退役，连续计数到 stuckBackoffAfter → 进入退避；之后孵出来的升级者同样卡在墙外，退避期内不退役。
 *  upStuck 不带 repath：看门狗先重算一次（upgrader.stuckRepathPerCreep）再退役（upgrader.stuckWatchdog）——这两条原先在 auditPocket 观察，
 *  那只困在口袋里的升级者现在被 spawn.pocketTrappedRecycle 当场回收，轮不到看门狗。
 *  spawn 按线上 W34S7 Spawn21 的几何摆（spawn.exitVacate）：TOP_LEFT 是真口袋，出口只剩 RIGHT/BOTTOM、都站着停着的 creep，
 *  spawn 里一只孵好的 hauler——RIGHT 上那只（有 MOVE）让路，hauler 生在 RIGHT，口袋永远空着 */
async function seedAuditWalled(cli, home, utilsMod) {
    const wl = await roomContextFor(cli, home, ROOMS.auditWalled);
    const settings = loadSrcModule('config').upgrading || {};
    // 控制器挪到 5 格内全是空地/地形墙、离边 ≥ 6 的格（墙圈不碰出口、不圈住源/矿/别的对象）
    let ctrl = null;
    for (let y = 7; y <= 42 && !ctrl; y++) for (let x = 7; x <= 42 && !ctrl; x++) {
        if (!wl.allocator.free(x, y)) continue;
        let ok = true;
        for (let dy = -5; dy <= 5 && ok; dy++) for (let dx = -5; dx <= 5 && ok; dx++) {
            const tx = x + dx, ty = y + dy;
            if (!wl.allocator.free(tx, ty) && !wl.allocator.wall(tx, ty)) ok = false;
        }
        if (ok) ctrl = { x, y };
    }
    if (!ctrl) throw new Error('audit: auditWalled 找不到能围墙的控制器位置（随机地形），重跑验证');
    await cli.evaluateJson(
        `storage.db['rooms.objects'].update({_id:${literal(wl.controller._id)}},{$set:{x:${ctrl.x},y:${ctrl.y}}}).then(function(){return true})`);
    wl.allocator.claim(ctrl);
    wl.controller = Object.assign({}, wl.controller, ctrl);
    await updateController(cli, wl, 6);
    const ring = [];
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 4) continue;
        const t = { x: ctrl.x + dx, y: ctrl.y + dy };
        if (wl.allocator.wall(t.x, t.y)) continue;
        if (wl.allocator.claim(t)) ring.push(t);
    }
    // 不可摧毁墙（没有 hits），同 seedClaimBlocked
    await cli.evaluateJson(
        `Promise.all(${literal(ring.map((t) => ({ type: 'constructedWall', room: wl.room, x: t.x, y: t.y })))}.map(function(doc){return storage.db['rooms.objects'].insert(doc)})).then(function(){return true})`,
        { timeoutMs: 30000 });
    // spawn.exitVacate（2026-10-08，线上 W34S7 Spawn21 的形态）：spawn S 周围 5×5 全空，按线上几何摆——
    //   TOP_LEFT P (-1,-1) 是真口袋：(-2,-2)(-1,-2)(0,-2) 和 TOP (0,-1) 是墙、(-2,-1)(-2,0) 和 LEFT (-1,0) 是 extension（线上 LEFT 是第二只 spawn）；
    //   TOP_RIGHT、BOTTOM_RIGHT、BOTTOM_LEFT 是 extension；只剩 RIGHT R、BOTTOM B 两个出口。
    // spawn 里有一只孵好的 creep，spawning.directions = [RIGHT, BOTTOM]；R 上停着一只有 MOVE 的 creep（线上停着的 builder），
    // B 上停着一只没有 MOVE 的（线上 operator 站在枢纽位，没 MOVE 是为了让它永远不走、确定性地只剩 R 一条路）。两只都是未知角色 parked，
    // 角色逻辑从不挪它们。旧代码：stallTicks 后放开全部 8 个方向，TOP 是墙、下一个空格就是 P——孵进口袋困死；
    // 新代码：remainingTime ≤ 1 时让 R 上的那只让路，生在 R，P 永远空着
    const near5 = (pos) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!wl.allocator.free(pos.x + dx, pos.y + dy)) return false; return true; };
    const spawnPos = wl.allocator.near(ctrl, { minRange: 9, maxRange: 18, filter: (pos) => chebyshev(pos, ctrl) >= 9 && near5(pos) });
    const rel = (dx, dy) => ({ x: spawnPos.x + dx, y: spawnPos.y + dy });
    const pocketTile = rel(-1, -1);
    const exitR = rel(1, 0);
    const exitB = rel(0, 1);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) wl.allocator.claim(rel(dx, dy));
    const exitWalls = [rel(-2, -2), rel(-1, -2), rel(0, -2), rel(0, -1)];
    await cli.evaluateJson(
        `Promise.all(${literal(exitWalls.map((t) => ({ type: 'constructedWall', room: wl.room, x: t.x, y: t.y })))}.map(function(doc){return storage.db['rooms.objects'].insert(doc)})).then(function(){return true})`,
        { timeoutMs: 30000 });
    const exitExt = [rel(-2, -1), rel(-2, 0), rel(-1, 0), rel(1, -1), rel(1, 1), rel(-1, 1)];
    for (const t of exitExt) await addStructure(cli, wl, 'extension', t, { store: { energy: 0 }, capacity: { energy: 50 } });
    // P 不放 creep（别的播种也别占），R/B 的 creep 下面播
    wl.creepPositions.add(pocketTile.x + '.' + pocketTile.y);
    const bornName = 'audit-walled-born';
    wl.spawn = await insertObject(cli, wl, Object.assign(
        structureDocument(wl, 'spawn', spawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'AuditWalledSpawn', notifyWhenAttacked: false,
            spawning: { name: bornName, needTime: 6, spawnTime: wl.gameTime + 1, directions: [3, 5] } }));
    await insertObject(cli, wl, { name: bornName, type: 'creep', room: wl.room, x: spawnPos.x, y: spawnPos.y, user: wl.userId,
        body: [{ type: 'carry', hits: 100 }, { type: 'move', hits: 100 }], hits: 200, hitsMax: 200, spawning: true, fatigue: 0,
        notifyWhenAttacked: false, store: { energy: 0 }, storeCapacity: 50 });
    wl.creepMemory[bornName] = { home: wl.room, role: 'hauler' };
    await addCreep(cli, wl, { name: 'audit-walled-parked', role: 'parked', body: ['carry', 'move'], position: exitR, memory: { home: wl.room } });
    await addCreep(cli, wl, { name: 'audit-walled-anchor', role: 'parked', body: ['carry'], position: exitB, memory: { home: wl.room } });
    const ext = exitExt.concat(await addExtensions(cli, wl, 30 - exitExt.length, 0));
    const wlContainers = {};
    for (let index = 0; index < 2; index++) {
        const source = wl.sources[index];
        const container = await addEnergyContainer(cli, wl, source, 0);
        wlContainers['src' + index] = container.position;
        await addCreep(cli, wl, { name: 'audit-walled-miner-' + index, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(wl, container.position, true), memory: { home: wl.room, sourceIdx: index, sourceId: source._id, staticMiner: true } });
    }
    const storagePos = wl.allocator.near(wl.spawn, { minRange: 2, maxRange: 8, filter: (pos) => chebyshev(pos, ctrl) >= 6 });
    await addStructure(cli, wl, 'storage', storagePos, { store: { energy: 3000 }, capacity: { energy: 1000000 } });
    await addCreep(cli, wl, { name: 'audit-walled-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1300),
        position: creepPosition(wl, storagePos, false), memory: { home: wl.room } });
    // 卡在墙圈外的升级者：满能量（直奔控制器，不先去取能）
    const upPos = wl.allocator.near(ctrl, { minRange: 5, maxRange: 5 });
    const retireTicks = Number(settings.stuckRetireTicks) || 300;
    const body = [].concat(Array(10).fill('work'), Array(2).fill('carry'), ['move', 'move']);
    await addCreep(cli, wl, { name: 'audit-walled-upgrader', role: 'upgrader', body, position: upPos, energy: 100,
        memory: { home: wl.room, upStuck: { x: upPos.x, y: upPos.y, t: wl.gameTime - (retireTicks - 20) } } });
    const after = Math.max(2, Number(settings.stuckBackoffAfter) || 3);
    const upgraderStuck = { streak: after - 1, mark: { l: 6, p: 0 }, retire: after - 1, at: wl.gameTime - 400, action: 'retire' };
    const wlPlan = emptyPlan(wl);
    wlPlan.wheel = true;
    wlPlan.version = 'validation-audit-walled';
    wlPlan.ext = ext;
    wlPlan.storage = storagePos;
    wlPlan.containers = Object.assign({}, wlPlan.containers, wlContainers);
    wlPlan.workPositions = Object.assign({}, wlPlan.workPositions, wlContainers);
    return { context: wl, plan: wlPlan, memory: { upgraderStuck },
        seed: { room: wl.room, controller: ctrl, ring: ring.length, spawn: spawnPos, spawnName: 'AuditWalledSpawn', upgrader: 'audit-walled-upgrader', retireSeeded: after - 1,
            born: bornName, exits: [3, 5], vacateTile: exitR, anchorTile: exitB, pocket: pocketTile, parked: 'audit-walled-parked', anchor: 'audit-walled-anchor' } };
}

/** audit 场景（2026-09-11 全面审计的一批修复）：一个用户三个己方房 + 两个外矿房，每条改动一个观察面（effects.js 的 audit.*）。
 *  auditHome（线上 W33S7 的形态）：RCL6、link 供能（storage 离控制器 ≥ 5 格，没有 storage 站位）、storage 0、没有 hauler、
 *    两只只往 link/容器交货的 5W1C1M 矿工、spawn+ext 1100/2300、收入 EMA 7.46（旧代码把 link 矿工当搬运者）、
 *    底线升级者请求 1000 tick 前就出现了（spawnSince）、升级供给 EMA 1 + extra 1、带 150 能量的 builder 贴着 1000 进度的 terminal 工地、
 *    武装塔射程内一条 40% 的路——它是外矿路线在母房里的那一段（remote:auditRemote:<源>）。
 *  auditRemote：auditHome 的外矿（预定 4998 + 寿命 40 的 2 CLAIM reserver 在控制器旁）。
 *  auditDrop：auditHome 名下（停用中、不出 creep）的外矿，离 auditRich 1 跳、离 auditHome 2 跳：auditRich 比母房富 15 万。
 *  auditRich：RCL5、storage 15 万、收入 EMA 3、4 条停用中（不出 creep）的双源外矿记录（孵化时间上限、自负盈亏超预算）；
 *    带 200 能量的 builder 贴着一面 1200 万血的方案外旧墙和一个道路工地；寿命将尽的 hauler（替补预留窗口）。
 *  auditLink：RCL6、storage 0 离控制器 2 格、ctrl link 800 离 storage 2 格、贴 link 的 storage 站位格全被 lab 占住、
 *    空载升级者 + 空手 hauler；武装塔 + 射程外两条 40% 的路（维修债 ≈ 2000 < outOfReachMinDebt），核心建筑上预先盖满血 rampart（全程没有工地）。 */
async function seedAudit(cli) {
    const utilsMod = loadSrcModule('utils');
    const home = await spawnBot(cli, 'audit', ROOMS.auditHome);
    await updateController(cli, home, 6);
    await setSpawnEnergy(cli, home, 300);
    const plan = emptyPlan(home);
    plan.wheel = true;
    plan.version = 'validation-audit';
    plan.ext = (await addExtensions(cli, home, 16, 50)).concat(await addExtensions(cli, home, 24, 0));
    for (let index = 0; index < 2; index++) {
        const source = home.sources[index];
        const container = await addEnergyContainer(cli, home, source, 0);
        plan.containers['src' + index] = container.position;
        plan.workPositions['src' + index] = container.position;
        // 源 link 只要在源 2 格内（links.js 的判定）且挨着容器最好；地形随机，贴源又贴容器的空格常常一个都没有
        // （三轮验证里两轮在这里抛 No free position），逐级放宽：贴源且贴容器 → 源 2 格内且贴容器 → 源 2 格内
        const linkPos = nearOrNull(home.allocator, source, { minRange: 1, maxRange: 1, filter: (pos) => chebyshev(pos, container.position) <= 1 }) ||
            nearOrNull(home.allocator, source, { minRange: 1, maxRange: 2, filter: (pos) => chebyshev(pos, container.position) <= 1 }) ||
            home.allocator.near(source, { minRange: 1, maxRange: 2 });
        await addStructure(cli, home, 'link', linkPos, { store: { energy: 0 }, capacity: { energy: 800 } });
        plan.links['src' + index] = linkPos;
        await addCreep(cli, home, { name: 'audit-miner-' + index, role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            position: creepPosition(home, container.position, true),
            memory: { sourceIdx: index, sourceId: source._id, staticMiner: true } });
    }
    const ctrlLinkPos = home.allocator.near(home.controller, { minRange: 1, maxRange: 2 });
    await addStructure(cli, home, 'link', ctrlLinkPos, { store: { energy: 400 }, capacity: { energy: 800 } });
    plan.links.ctrl = ctrlLinkPos;
    const storagePos = home.allocator.near(home.spawn, { minRange: 3, maxRange: 12, filter: (pos) => chebyshev(pos, home.controller) >= 5 });
    await addStructure(cli, home, 'storage', storagePos, { store: { energy: 0 }, capacity: { energy: 1000000 } });
    plan.storage = storagePos;
    const towerPos = home.allocator.near(home.spawn, { minRange: 2, maxRange: 6 });
    await addStructure(cli, home, 'tower', towerPos, { store: { energy: 1000 }, capacity: { energy: 1000 } });
    plan.towers = [towerPos];
    const terminalPos = home.allocator.near(home.spawn, { minRange: 3, maxRange: 10, filter: (pos) => chebyshev(pos, home.controller) >= 4 });
    plan.terminal = terminalPos;
    await addSite(cli, home, 'terminal', terminalPos, 1000);
    await addCreep(cli, home, { name: 'audit-builder', role: 'builder', body: utilsMod.makeBody('builder', 1300),
        position: creepPosition(home, terminalPos, false), energy: 150 });
    const legPos = home.allocator.near(towerPos, { minRange: 3, maxRange: 6 });
    await addStructure(cli, home, 'road', legPos, { hits: 2000, hitsMax: 5000 });

    const remote = await roomContextFor(cli, home, ROOMS.auditRemote);
    const rSource = remote.sources[0];
    const rSpot = remote.allocator.near(rSource, { minRange: 1, maxRange: 1 });
    const rContainer = await insertObject(cli, remote, { type: 'container', room: remote.room, x: rSpot.x, y: rSpot.y,
        hits: 250000, hitsMax: 250000, store: { energy: 500 }, storeCapacity: 2000, nextDecayTime: remote.gameTime + 5000 });
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${literal(String(remote.controller._id))}},{$set:{reservation:{user:${literal(home.userId)},endTime:${remote.gameTime + 4998}}}}).then(function(){return true})`);
    await addCreep(cli, remote, { name: 'audit-reserver', role: 'reserver', body: ['claim', 'claim', 'move', 'move'],
        position: remote.allocator.near(remote.controller, { minRange: 1, maxRange: 1 }), ticksToLive: 40,
        memory: { home: home.room, remoteRoom: remote.room, slotKey: 'reserver:' + remote.room } });
    // 缩身的 4 CARRY hauler 占着槽 0（需求约 17 CARRY）、母房买不起理想身体：应当出补差槽（remote.residualHaulerDemand）
    await addCreep(cli, remote, { name: 'audit-remote-hauler', role: 'remoteHauler', body: ['carry', 'carry', 'carry', 'carry', 'move', 'move', 'move', 'move'],
        position: remote.allocator.near(rSpot, { minRange: 1, maxRange: 2 }),
        memory: { home: home.room, remoteRoom: remote.room, sourceId: String(rSource._id), haulSlot: 0,
            slotKey: 'remoteHauler:' + remote.room + ':' + String(rSource._id) + ':0', state: 'collect' } });
    // 寻路失败回退时铺下、之后成了孤儿的零进度路工地（线上 W31S1/W31S2 各 6 个）：本外矿名额（MAX_REMOTE_SITES 6）被占满时清掉
    // （remote.pruneOrphanRoadSites，遥测 remotes[外矿].orphanRoadSites）；另有一个已有进度的旧工地，不该动
    // 孤儿格优先放在控制器的东南半平面：auditDrop（本房正西）→ 本房 → auditHome（本房正北）的过境路线从西边进、北边出，
    // validation-VoKyKM 里它正好穿过西北侧的 3 个"孤儿"，生产规则正确地留下了它们（它们在启用路线上）。生效断言按生产规则
    // 认孤儿并要求至少 3 个真孤儿，所以夹具要尽量让播种的格子避开这条后来才规划的路线；半平面放不下才退回不加限制
    const awayFromTransit = (pos) => pos.x + pos.y >= remote.controller.x + remote.controller.y;
    const orphanPos = [];
    for (let index = 0; index < 6; index++) {
        const pos = nearOrNull(remote.allocator, remote.controller, { minRange: 3, maxRange: 9, filter: awayFromTransit }) ||
            remote.allocator.near(remote.controller, { minRange: 3, maxRange: 9 });
        await insertObject(cli, remote, { type: 'constructionSite', structureType: 'road', room: remote.room, x: pos.x, y: pos.y,
            user: home.userId, progress: 0, progressTotal: 300 });
        orphanPos.push(pos);
    }
    const orphanKept = remote.allocator.near(remote.controller, { minRange: 3, maxRange: 9 });
    await insertObject(cli, remote, { type: 'constructionSite', structureType: 'road', room: remote.room, x: orphanKept.x, y: orphanKept.y,
        user: home.userId, progress: 100, progressTotal: 300 });
    const legKey = 'remote:' + remote.room + ':' + String(rSource._id);
    plan.roads = { all: '', [legKey]: legPos.x + '.' + legPos.y };
    const remoteRecord = {
        room: remote.room, enabled: true, lastSeen: remote.gameTime,
        controllerId: String(remote.controller._id), controllerPos: { x: remote.controller.x, y: remote.controller.y }, controllerDistance: 30,
        sources: [{ id: String(rSource._id), pos: { x: rSource.x, y: rSource.y }, spot: rSpot, distance: 30, distanceVersion: 3,
            energyCapacity: 3000, containerId: String(rContainer._id), roadComplete: false, road: '',
            routeRoads: { [home.room]: legPos.x + '.' + legPos.y, [remote.room]: '' } }],
        reservation: { username: home.username, ticksToEnd: 4998, seenAt: remote.gameTime },
        drop: { room: home.room, hops: 1, at: remote.gameTime, distanceVersion: 3, distance: null },
    };
    // auditDrop：一条"变坏了"的外矿（离母房两跳、离 auditRich 一跳）。两口源都只有 2 WORK 的缩身矿工，预定只剩 800（该续派 reserver 了），
    // 源 B 的容器丢了（记录里还留着旧 containerId，矿位上只剩 1000/5000 的容器工地和 800 能量的掉落）：
    //  - 不派 reserver：矿工采不动预定多出的一半（remote.reserveGain）→ remotes[drop].reserverWeakMiner
    //  - 两只 2W 矿工的换代是外矿维护档、非机会档（spawn.demandUpgradeRequests）→ auditHome.minerUpgradeUrgent
    //  - 丢了容器的源照出槽 0 维护 hauler → containerLostHaul；源 B 的矿工在工地上同 tick 捡 + 建 → minerPickupBuild
    //  - 朝母房的入口按外矿房自己的出口取边（remote.entryPosition）→ record.entry
    //  - 卸货房不选比母房富得多的 auditRich（audit.dropSkipsRicher）
    const drop = await roomContextFor(cli, home, ROOMS.auditDrop);
    const [dA, dB] = drop.sources;
    const dSpotA = drop.allocator.near(dA, { minRange: 1, maxRange: 1 });
    const dSpotB = drop.allocator.near(dB, { minRange: 1, maxRange: 1 });
    const dContainerA = await insertObject(cli, drop, { type: 'container', room: drop.room, x: dSpotA.x, y: dSpotA.y,
        hits: 250000, hitsMax: 250000, store: { energy: 0 }, storeCapacity: 2000, nextDecayTime: drop.gameTime + 5000 });
    await insertObject(cli, drop, { type: 'constructionSite', structureType: 'container', room: drop.room, x: dSpotB.x, y: dSpotB.y,
        user: home.userId, progress: 1000, progressTotal: 5000 });
    await insertObject(cli, drop, { type: 'energy', room: drop.room, x: dSpotB.x, y: dSpotB.y, energy: 800, resourceType: 'energy' });
    await cli.evaluateJson(`Promise.all([storage.db['rooms.objects'].update({_id:${literal(String(drop.controller._id))}},{$set:{reservation:{user:${literal(home.userId)},endTime:${drop.gameTime + 800}}}}),`
        + `storage.db['rooms.objects'].update({room:${literal(drop.room)},type:'source'},{$set:{energyCapacity:3000,energy:3000}},{multi:true})]).then(function(){return true})`);
    for (const [source, spot, tag] of [[dA, dSpotA, 'a'], [dB, dSpotB, 'b']]) {
        await addCreep(cli, drop, { name: 'audit-drop-miner-' + tag, role: 'remoteMiner', body: ['work', 'work', 'carry', 'move', 'move'],
            position: spot, energy: tag === 'b' ? 50 : 0,
            memory: { home: home.room, remoteRoom: drop.room, sourceId: String(source._id), slotKey: 'remoteMiner:' + drop.room + ':' + String(source._id) } });
    }
    const dropRecord = { room: drop.room, enabled: true, lastSeen: drop.gameTime,
        controllerId: String(drop.controller._id), controllerPos: { x: drop.controller.x, y: drop.controller.y }, controllerDistance: 60,
        sources: [
            { id: String(dA._id), pos: { x: dA.x, y: dA.y }, spot: dSpotA, distance: 60, distanceVersion: 3,
                energyCapacity: 3000, containerId: String(dContainerA._id), roadComplete: false, road: '' },
            { id: String(dB._id), pos: { x: dB.x, y: dB.y }, spot: dSpotB, distance: 60, distanceVersion: 3,
                energyCapacity: 3000, containerId: 'audit-lost-container', roadComplete: false, road: '' }],
        reservation: { username: home.username, ticksToEnd: 800, seenAt: drop.gameTime } };

    const rich = await roomContextFor(cli, home, ROOMS.auditRich);
    await updateController(cli, rich, 5);
    const kSpawnPos = rich.allocator.near(rich.controller, { minRange: 4, maxRange: 10 });
    rich.spawn = await insertObject(cli, rich, Object.assign(
        structureDocument(rich, 'spawn', kSpawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'AuditRichSpawn', spawning: null, notifyWhenAttacked: false }));
    const kPlan = emptyPlan(rich);
    kPlan.wheel = true;
    kPlan.version = 'validation-audit-rich';
    kPlan.ext = (await addExtensions(cli, rich, 2, 50)).concat(await addExtensions(cli, rich, 28, 0));
    const kStorage = rich.allocator.near(rich.spawn, { minRange: 2, maxRange: 6 });
    await addStructure(cli, rich, 'storage', kStorage, { store: { energy: 150000 }, capacity: { energy: 1000000 } });
    kPlan.storage = kStorage;
    for (let index = 0; index < 2; index++) {
        const source = rich.sources[index];
        const container = await addEnergyContainer(cli, rich, source, 500);
        kPlan.containers['src' + index] = container.position;
        kPlan.workPositions['src' + index] = container.position;
        // 源 1 的矿工寿命只剩 200：验证窗口里它会进入"只因步行时间才提前出替补"的区间（spawn.replaceLead，遥测 harvesterEarlyReplace）
        await addCreep(cli, rich, { name: 'audit-rich-miner-' + index, role: 'harvester',
            body: utilsMod.makeBody('staticHarvester', 1800), ticksToLive: index === 1 ? 200 : undefined,
            position: creepPosition(rich, container.position, true), memory: { home: rich.room, sourceIdx: index, sourceId: source._id, staticMiner: true } });
    }
    // 寿命将尽的 hauler：离提前量约 140 tick，按收入 3/tick 攒不够——替补预留要按实际会接受的身体（容量一半 900）计，不是满容量 1800
    await addCreep(cli, rich, { name: 'audit-rich-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1800), ticksToLive: 250,
        memory: { home: rich.room } });
    const kBuilderPos = rich.allocator.near(rich.spawn, { minRange: 5, maxRange: 10 });
    const kWallPos = rich.allocator.near(kBuilderPos, { minRange: 1, maxRange: 2 });
    await addStructure(cli, rich, 'constructedWall', kWallPos, { hits: 11954101, hitsMax: 300000000 });
    const kRoadPos = rich.allocator.near(kBuilderPos, { minRange: 1, maxRange: 2 });
    await addSite(cli, rich, 'road', kRoadPos, 0);
    // 方案内的路烂到 15%（危急线 20% 以下）贴着 builder：旧代码修到 20% 以上一点就回去建造，新代码接着修到普通维修线 60%（builder.repairHold）
    const kDamagedPos = rich.allocator.near(kBuilderPos, { minRange: 1, maxRange: 2 });
    await addStructure(cli, rich, 'road', kDamagedPos, { hits: 750, hitsMax: 5000 });
    kPlan.roads = { all: [kRoadPos, kDamagedPos].map((pos) => pos.x + '.' + pos.y).join(';') };
    await addCreep(cli, rich, { name: 'audit-rich-builder', role: 'builder', body: utilsMod.makeBody('builder', 1300),
        position: creepPosition(rich, kBuilderPos, true), energy: 200, memory: { home: rich.room } });
    const fakeRemote = (name, idx, distance) => ({ room: name, enabled: true, suspendedUntil: rich.gameTime + 10000000, suspendReason: 'validation',
        sourceCount: 2, sources: [0, 1].map((k) => ({ id: 'auditFake' + idx + k, pos: { x: 10 + 20 * k, y: 10 }, distance, distanceVersion: 3,
            energyCapacity: 3000, containerId: 'auditFakeC' + idx + k, roadComplete: false, road: '' })),
        drop: { room: rich.room, hops: 1, at: rich.gameTime, distanceVersion: 3, distance: null } });
    const richRemotes = {};
    ['W66N60', 'W65N61', 'W66N61', 'W66N59'].forEach((name, idx) => { richRemotes[name] = fakeRemote(name, idx, 80 + idx * 20); });

    const link = await roomContextFor(cli, home, ROOMS.auditLink);
    await updateController(cli, link, 6);
    const lSpawnPos = link.allocator.near(link.controller, { minRange: 6, maxRange: 12 });
    link.spawn = await insertObject(cli, link, Object.assign(
        structureDocument(link, 'spawn', lSpawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'AuditLinkSpawn', spawning: null, notifyWhenAttacked: false }));
    // 容量补到 1300（aid.untilCapacity）：容量 300 的房会被同一用户的其它房当弱房援建，援建 creep 会修掉射程外的路、搅乱观察面
    const lExt = await addExtensions(cli, link, 20, 50);
    // 找一组几何：storage 离控制器 2 格、ctrl link 离控制器 ≤ 2 且离 storage 恰好 2 格；贴 link 的 storage 站位格 ≤ 3 个（全放 lab），
    // 另有 ≥ 1 个不贴 link 的站位格（升级者站这里），link 旁还有 ≥ 1 个不是站位格的空格（新代码去这里喝）
    const C = link.controller;
    const free = (pos) => link.allocator.free(pos.x, pos.y);
    const around = (pos) => { const out = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) out.push({ x: pos.x + dx, y: pos.y + dy }); return out; };
    let geom = null;
    for (let r = 2; r <= 2 && !geom; r++) {
        for (let dy = -r; dy <= r && !geom; dy++) for (let dx = -r; dx <= r && !geom; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const st = { x: C.x + dx, y: C.y + dy };
            if (!free(st)) continue;
            for (let ly = -2; ly <= 2 && !geom; ly++) for (let lx = -2; lx <= 2 && !geom; lx++) {
                const lk = { x: C.x + lx, y: C.y + ly };
                if ((!lx && !ly) || !free(lk) || chebyshev(lk, st) !== 2) continue;
                const stations = around(st).filter((t) => free(t) && chebyshev(t, C) <= 3 && !(t.x === lk.x && t.y === lk.y));
                const linkAdj = stations.filter((t) => chebyshev(t, lk) <= 1);
                const others = stations.filter((t) => chebyshev(t, lk) > 1);
                const side = around(lk).filter((t) => free(t) && chebyshev(t, C) <= 3 && chebyshev(t, st) > 1);
                if (linkAdj.length >= 1 && linkAdj.length <= 3 && others.length >= 1 && side.length >= 1) geom = { st, lk, linkAdj, others, side };
            }
        }
    }
    if (!geom) throw new Error('audit: auditLink 找不到 storage/link 站位几何（随机地形），重跑验证');
    link.allocator.claim(geom.st);
    link.allocator.claim(geom.lk);
    await addStructure(cli, link, 'storage', geom.st, { store: { energy: 0 }, capacity: { energy: 1000000 } });
    await addStructure(cli, link, 'link', geom.lk, { store: { energy: 800 }, capacity: { energy: 800 } });
    for (const t of geom.linkAdj) { link.allocator.claim(t); await addStructure(cli, link, 'lab', t, { store: { energy: 0 }, capacity: { energy: 2000 } }); }
    const lTowerPos = link.allocator.near(link.spawn, { minRange: 2, maxRange: 5 });
    await addStructure(cli, link, 'tower', lTowerPos, { store: { energy: 1000 }, capacity: { energy: 1000 } });
    const lRoads = [];
    for (let index = 0; index < 2; index++) {
        const pos = link.allocator.near(lTowerPos, { minRange: 21, maxRange: 24 });
        await addStructure(cli, link, 'road', pos, { hits: 2000, hitsMax: 5000 });
        lRoads.push(pos);
    }
    // 核心建筑（spawn/塔/storage）上预先盖满血 rampart：layout 没有核心 rampart 工地可放，全程没有工地
    for (const pos of [lSpawnPos, lTowerPos, geom.st]) await addStructure(cli, link, 'rampart', pos, { hits: 150000 });
    // 两口源各一只容器静态矿工：开局就不在恢复期（没有矿工的房 spawn 只补核心、不算 builder 编制，等恢复完塔早把射程外那两条路
    // 修到 60% 了——validation-ywVOBb/Wmg3Hx 里 outOfReachBelowFloor 一次都没记到，就是这个原因）
    const lContainers = {};
    for (let index = 0; index < 2; index++) {
        const source = link.sources[index];
        const container = await addEnergyContainer(cli, link, source, 0);
        lContainers['src' + index] = container.position;
        await addCreep(cli, link, { name: 'audit-link-miner-' + index, role: 'harvester', body: utilsMod.makeBody('staticHarvester', 1300),
            position: creepPosition(link, container.position, true), memory: { home: link.room, sourceIdx: index, sourceId: source._id, staticMiner: true } });
    }
    const lUpPos = creepPosition(link, geom.others[0], true);
    await addCreep(cli, link, { name: 'audit-link-upgrader', role: 'upgrader', body: ['work', 'work', 'carry', 'move'], position: lUpPos, memory: { home: link.room } });
    await addCreep(cli, link, { name: 'audit-link-hauler', role: 'hauler', body: ['carry', 'carry', 'move', 'move'], memory: { home: link.room } });
    const lPlan = emptyPlan(link);
    lPlan.wheel = true;
    lPlan.version = 'validation-audit-link';
    lPlan.ext = lExt;
    lPlan.storage = geom.st;
    lPlan.links = { ctrl: geom.lk };
    lPlan.labs = geom.linkAdj;
    lPlan.towers = [lTowerPos];
    lPlan.containers = Object.assign({}, lPlan.containers, lContainers);
    lPlan.workPositions = Object.assign({}, lPlan.workPositions, lContainers);
    lPlan.roads = { all: lRoads.map((pos) => pos.x + '.' + pos.y).join(';') };

    // auditZero：hauler 在岗、收入 EMA 0.2（< minIncome 按 0 处理）、spawn+ext 600/1800、矿工/hauler/升级者都在（vital 满足），
    // 一个道路工地 → 第一只 builder 是发展档（非 vital）。旧规则收入 0 时一律缩到现有能量，开局就孵一只 600 的小 builder
    const zero = await roomContextFor(cli, home, ROOMS.auditZero);
    await updateController(cli, zero, 5);
    const zSpawnPos = zero.allocator.near(zero.controller, { minRange: 4, maxRange: 10 });
    zero.spawn = await insertObject(cli, zero, Object.assign(
        structureDocument(zero, 'spawn', zSpawnPos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'AuditZeroSpawn', spawning: null, notifyWhenAttacked: false }));
    const zPlan = emptyPlan(zero);
    zPlan.wheel = true;
    zPlan.version = 'validation-audit-zero';
    zPlan.ext = (await addExtensions(cli, zero, 6, 50)).concat(await addExtensions(cli, zero, 24, 0));
    for (let index = 0; index < 2; index++) {
        const source = zero.sources[index];
        const container = await addEnergyContainer(cli, zero, source, 0);
        zPlan.containers['src' + index] = container.position;
        zPlan.workPositions['src' + index] = container.position;
        await addCreep(cli, zero, { name: 'audit-zero-miner-' + index, role: 'harvester',
            body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move'],
            position: creepPosition(zero, container.position, true), memory: { home: zero.room, sourceIdx: index, sourceId: source._id, staticMiner: true } });
    }
    await addCreep(cli, zero, { name: 'audit-zero-hauler', role: 'hauler', body: utilsMod.makeBody('hauler', 1800), memory: { home: zero.room } });
    await addCreep(cli, zero, { name: 'audit-zero-upgrader', role: 'upgrader', body: ['work', 'work', 'carry', 'move'], memory: { home: zero.room } });
    const zRoadPos = zero.allocator.near(zero.spawn, { minRange: 3, maxRange: 6 });
    zPlan.roads = { all: zRoadPos.x + '.' + zRoadPos.y };
    await addSite(cli, zero, 'road', zRoadPos, 0);

    const pocket = await seedAuditPocket(cli, home, utilsMod);
    const walled = await seedAuditWalled(cli, home, utilsMod);
    for (const ctx of [remote, drop, rich, link, zero, pocket.context, walled.context]) Object.assign(home.creepMemory, ctx.creepMemory);
    // core hauler 实测定尺寸（hauling.measuredSize）：播一个窗口的 haulStats（上一段 900 tick、1800 hauler-tick：送出 7200 → 8/tick，
    // 忙碌 900 / 出发 45 → 每趟 20 tick）和 haulCtl 的基线，第一次算编制就有实测（线上要攒 ≥ 1500 hauler-tick，验证窗口里攒不够）。
    // auditHome 是 link 供能房（RCL6、容量 2300、满配 30C）：实测 8 × 20 ÷ 37.5 ≈ 4.3 CARRY，每只由模型/实测定、应远低于满配一半 15。
    // 之后真实的 flush 在这份计数上累加，haulCtl.meas.n 超过播下的 1800 才算真实遥测也进来了
    const haulSeed = { room: home.room, n: 1800 };
    const haulStatsSince = home.gameTime - 2000;
    const seed = { at: home.gameTime, legPos, legKey, terminalPos, terminalProgress: 1000, remote: remote.room, drop: drop.room, rich: rich.room, link: link.room, zero: zero.room,
        wallPos: kWallPos, wallHits: 11954101, roadSitePos: kRoadPos, damagedRoadPos: kDamagedPos, linkGeom: { storage: geom.st, link: geom.lk, labs: geom.linkAdj, upgrader: lUpPos, side: geom.side },
        linkRoads: lRoads, linkTower: lTowerPos, orphanPos, orphanKept, dropLost: { source: String(dB._id), spot: dSpotB }, haulSeed, pocket: pocket.seed, walled: walled.seed };
    await writeMemory(cli, home, { haulStats: { v: 1, since: haulStatsSince, t: home.gameTime - 1,
        rooms: { [home.room]: { hauler: { t: haulSeed.n, idle: 900, out: 7200, churn: 0, dep: 45 } } } }, rooms: {
        [home.room]: { plan, remoteMemoryVersion: 1, auditSeed: seed,
            spawnIncome: { ema: 7.46, n: 1000, last: 1100, at: home.gameTime - 5 },
            spawnSince: { 'core:upgrader:0': home.gameTime - 1000 },
            upgradeSupply: { ema: 1, extra: 1, at: -1, changedAt: -1 },
            haulCtl: { base: { v: 1, since: haulStatsSince, at: home.gameTime - 901, t: 0, idle: 0, out: 0, churn: 0, dep: 0 } },
            remotes: { [remote.room]: remoteRecord, [drop.room]: dropRecord } },
        [rich.room]: { plan: kPlan, remoteMemoryVersion: 1, spawnIncome: { ema: 3, n: 1000, last: 400, at: rich.gameTime - 5 }, remotes: richRemotes },
        [link.room]: { plan: lPlan },
        [zero.room]: { plan: zPlan, spawnIncome: { ema: 0.2, n: 1000, last: 600, at: zero.gameTime - 5 } },
        [pocket.context.room]: { plan: pocket.plan },
        [walled.context.room]: Object.assign({ plan: walled.plan }, walled.memory),
    } });
    home.audit = seed;
    return home;
}

/** 矿工换代不成对（spawn.harvesterAssignmentStats 把孵化中的矿工算在源上）+ 矿工攒批交货（roles/harvester）。
 *  RCL7、两个 spawn、容量 2600 满仓；源 0：容器 + 贴着容器的 link，5W1C1M 矿工站容器上（有 link 时身体带 CARRY，交货进 link/容器）；
 *  源 1：只有容器，5W3M 静态矿工寿命 400——验证窗口中段进入替补提前量，替补孵化的 24 tick 里另一个 spawn 空闲。
 *  hauler/升级者预先播满，免得开局的大身体把第二个 spawn 占住、观察不到"空闲 spawn + 孵化中替补"这一刻 */
async function seedMinerPair(cli) {
    const utilsMod = loadSrcModule('utils');
    const context = await spawnBot(cli, 'minerPair', ROOMS.minerPair);
    await updateController(cli, context, 7);
    await setSpawnEnergy(cli, context, 300);
    const plan = emptyPlan(context);
    plan.wheel = true;
    plan.version = 'validation-miner-pair';
    const spawn2Pos = context.allocator.near(context.spawn, { minRange: 2, maxRange: 6 });
    await insertObject(cli, context, Object.assign(
        structureDocument(context, 'spawn', spawn2Pos, { store: { energy: 300 }, capacity: { energy: 300 }, hits: 5000, hitsMax: 5000 }),
        { name: 'MinerPairSpawn2', spawning: null, notifyWhenAttacked: false }));
    plan.spawns.push(spawn2Pos);
    plan.ext = await addExtensions(cli, context, 20, 100);   // 容量 300×2 + 20×100 = 2600，满仓
    await cli.evaluateJson(`storage.db['rooms.objects'].update({room:${literal(context.room)},type:'source'},{$set:{energyCapacity:3000,energy:3000}},{multi:true}).then(function(){return true})`);
    for (let index = 0; index < 2; index++) {
        const source = context.sources[index];
        const container = await addEnergyContainer(cli, context, source, 0);
        plan.containers['src' + index] = container.position;
        plan.workPositions['src' + index] = container.position;
        if (index === 0) {
            const linkPos = context.allocator.near(container.position, { minRange: 1, maxRange: 1 });
            await addStructure(cli, context, 'link', linkPos, { store: { energy: 0 }, capacity: { energy: 800 }, cooldown: 0 });
            plan.links.src0 = linkPos;
            plan.links.src = linkPos;
        }
        await addCreep(cli, context, { name: 'miner-pair-miner-' + index, role: 'harvester',
            body: index === 0 ? utilsMod.makeBody('harvester', 2600) : utilsMod.makeBody('staticHarvester', 2600),
            ticksToLive: index === 1 ? 400 : undefined,
            position: creepPosition(context, container.position, true),
            memory: Object.assign({ home: context.room, sourceIdx: index, sourceId: source._id }, index === 1 ? { staticMiner: true } : {}) });
    }
    for (let index = 0; index < 2; index++) {
        await addCreep(cli, context, { name: 'miner-pair-hauler-' + index, role: 'hauler', body: utilsMod.makeBody('hauler', 1300), memory: { home: context.room } });
    }
    await addCreep(cli, context, { name: 'miner-pair-upgrader', role: 'upgrader', body: utilsMod.makeBody('upgrader', 1300), memory: { home: context.room } });
    await writeMemory(cli, context, { rooms: { [context.room]: { plan } } });
    return context;
}

async function seedAllScenarios(cli) {
    await cli.run('system.pauseSimulation()', { timeoutMs: 8000 });
    const contexts = {};
    contexts.upgraderActualRoute = await seedUpgraderActualRoute(cli);
    contexts.bootstrap = await seedBootstrap(cli);
    contexts.recovery = await seedRecovery(cli);
    contexts.logistics = await seedLogistics(cli);
    contexts.storageConsumer = await seedStorageConsumer(cli);
    contexts.controllerLinkConsumer = await seedStorageConsumer(cli, true);
    contexts.links = await seedLinks(cli);
    contexts.blueprint = await seedBlueprint(cli);
    contexts.industry = await seedIndustry(cli);
    contexts.remote = await seedRemote(cli);
    contexts.reserveContinuity = await seedReserveContinuity(cli);
    contexts.roadTrail = await seedReserveContinuity(cli, { home: ROOMS.roadTrailHome, target: ROOMS.roadTrailTarget, scenario: 'roadTrail', roadTrail: true });
    contexts.reserveDeadline = await seedReserveContinuity(cli, { home: ROOMS.reserveDeadlineHome, target: ROOMS.reserveDeadlineTarget, scenario: 'reserveDeadline', deadline: true });
    contexts.reserveOrdered = await seedReserveOrdered(cli);
    contexts.reserveBudget = await seedReserveContinuity(cli, { home: ROOMS.reserveBudgetHome, target: ROOMS.reserveBudgetTarget, scenario: 'reserveBudget', deadline: true, budgetDeadline: true });
    contexts.conflict = await seedConflict(cli);
    contexts.brain = await seedBrain(cli);
    contexts.defense = await seedDefense(cli);
    contexts.aid = await seedAid(cli);
    contexts.aidSafeRoute = await seedAidSafeRoute(cli);
    contexts.layoutOneOff = await seedLayoutOneOff(cli);
    contexts.layoutLeftover = await seedLayoutLeftover(cli);
    contexts.terminalNet = await seedTerminalNetwork(cli);
    contexts.terminalDrainLow = await seedTerminalDrainLow(cli);
    contexts.labChain = await seedLabChain(cli);
    contexts.boostLabGated = await seedBoostLabGated(cli);
    contexts.boost = await seedBoost(cli);
    contexts.sk = await seedSk(cli);
    contexts.autoClaim = await seedAutoClaim(cli);
    contexts.autoClaimCpu = await seedAutoClaim(cli, { scenario: 'autoClaimCpu', home: ROOMS.autoClaimCpuHome, target: ROOMS.autoClaimCpuTarget, cpuHeld: true });
    contexts.storageFed = await seedStorageFed(cli);
    contexts.claimBlocked = await seedClaimBlocked(cli);
    contexts.maintenance = await seedMaintenance(cli);
    contexts.audit = await seedAudit(cli);
    contexts.minerPair = await seedMinerPair(cli);
    // 攻占场景（B0 损失预言机）默认不播种：它多 15+ 用户 + siege 战斗、重且慢，只在 VALIDATE_CONQUEST=1 时验证战斗改动，
    // 普通 run_validation（部署门）不受影响。攻防双方 userId 都要收进 contexts 才会被下面统一激活
    if (process.env.VALIDATE_CONQUEST) {
        contexts.conquest = await seedConquest(cli);
        contexts.conquestEnemy = contexts.conquest.enemy;
    }
    // keeper 过境场景（默认不播种，只在 VALIDATE_KEEPER=1 验证 keeperAvoidCallback 时用）：轻量，1 只 claimer 穿中立 SK 房
    if (process.env.VALIDATE_KEEPER) {
        contexts.keeper = await seedKeeperTransit(cli);
    }
    const userIds = Object.values(contexts).map((context) => context.userId);
    await cli.evaluateJson(
        `Promise.all(${literal(userIds)}.map(function(userId){return storage.db.users.update({_id:userId},{$set:{active:10000,cpu:140}})})).then(function(){return true})`,
        { timeoutMs: 30000 });
    return contexts;
}

module.exports = {
    BODY_COST,
    GENERATION,
    ROOMS,
    USERNAMES,
    PositionAllocator,
    addCreep,
    addEnergyContainer,
    addExtensions,
    addSite,
    addStructure,
    bodyCost,
    chebyshev,
    generateWorld,
    literal,
    seedAid,
    seedAidSafeRoute,
    seedLayoutOneOff,
    seedTerminalNetwork,
    seedLabChain,
    seedBoost,
    seedAutoClaim,
    seedMaintenance,
    seedAudit,
    seedMinerPair,
    setSpawnEnergy,
    seedAllScenarios,
    reserveOrderedObserver,
    upgraderActualRouteObserver,
    storageUpgradeFeedObserver,
    repairPoolNeutralObserver,
    ROUTE_OBSERVER_MARK,
    FEED_OBSERVER_MARK,
    REPAIR_OBSERVER_MARK,
    UPGRADER_ROUTE,
    ensureTerrainNeighbors,
    spawnBot,
    neighboringRooms,
    roomCoordinates,
    roomNameFromCoordinates,
    waitForGeneratedRoom,
    waitForGeneratedRooms,
    repairGeneratedSources,
    structureDocument,
    updateController,
    writeMemory,
};
