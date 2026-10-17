'use strict';
/**
 * 集中可调参数。数值依据 docs/api（@screeps/common 常量）：
 * BODYPART_COST、CONTROLLER_STRUCTURES、CONTROLLER_LEVELS、CONTROLLER_MAX_UPGRADE_PER_TICK=15。
 */
module.exports = {
    // 各 RCL 基础人口；harvester/hauler/builder 会在此底线之上按实时吞吐与 backlog 弹性扩缩。
    // RCL3-4 使用双 upgrader，RCL5+ 通常由 link/hauler 供能的单个大 upgrader 即可。
    roster: {
        1: { harvester: 2, upgrader: 1, builder: 1 },
        2: { harvester: 2, hauler: 2, upgrader: 1, builder: 1 },
        3: { harvester: 2, hauler: 3, upgrader: 2, builder: 1 },
        4: { harvester: 2, hauler: 4, upgrader: 2, builder: 1, scout: 1 },
        5: { harvester: 2, hauler: 4, upgrader: 1, builder: 1, scout: 1 },
        6: { harvester: 2, hauler: 5, upgrader: 1, builder: 1, scout: 1 },
        7: { harvester: 2, hauler: 5, upgrader: 1, builder: 1, scout: 1 },
        8: { harvester: 2, hauler: 5, upgrader: 1, builder: 1, scout: 1 },
    },
    // 生存与恢复：先恢复采能链，再恢复升级/建造
    survival: {
        1: { harvester: 1, hauler: 0, upgrader: 0, builder: 0 },
        2: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
        3: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
        4: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
        5: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
        6: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
        7: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
        8: { harvester: 2, hauler: 1, upgrader: 1, builder: 0 },
    },
    recovery: {
        emergencyHarvestBelow: 200,
        emergencyDropMinerAt: 150,
        spawnReserve: 200,
        stableHarvesters: 2,
    },
    harvesting: {
        // spawn → 采集位的路径长度（矿工替补提前量的步行项，spawn.harvestLegTiles）多久重算一次
        legRefreshTicks: 1500,
        regenerationTicks: 300,
        harvestPower: 2,
        defaultCapacity: 3000,
        maxWorkPerSource: 15,
        // 平地每格 > mobileTicksPerTile tick 的矿工身体（5W1C1M = 6）是静态矿工：没有容器/link 时不往返送 spawn（1 MOVE 每格 6 tick，
        // 线上 W33S7 源 (31,12) 容器腐烂后采集率 1.1/tick），而是站在容器规划位上用自己采的能量把容器工地建起来、没有工地就落地采等 hauler 捡；
        // 机动身体（bootstrap 的 2W1C1M）只有房里有 hauler 时才自建容器，否则保留往返送 spawn
        mobileTicksPerTile: 3,
        // 容器缺血 ≥ 一次 repair 的量（WORK × 100）就修一下：每 50 tick 一次、约 2% 采集时间，换容器不再腐烂（线上 W33S7/W34S7 三个容器都烂掉过）
        selfRepairContainer: true,
        // 静态矿工攒批交货：仓里空位 < transferBatchHarvests 次采集量才 transfer 进 link/容器。transfer 先于 harvest 处理，
        // 2 次的余量保证交货那 tick 的采集也装得下；5W1C（每次采 10、仓 50）每 4 tick 交一次 40，省下 3/4 的 transfer intent（约 0.2 CPU 一个）
        transferBatchHarvests: 2,
    },
    hauling: {
        floor: { 1: 0, 2: 1, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3 },
        ceil: { 1: 1, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 8 },
        // 往返里取货 + 投递的周转 tick（2 × 路程 + turnBuffer）。2 → 1（2026-09-12）：core hauler 取货/投递的那一 tick 就挑下一站起步
        // （roles/hauler.js 7faced5，引擎允许 withdraw/transfer 与 move 同 tick），两端各停一拍变成只剩约一拍。先按 1 用，
        // 等遥测 v2 的 acm/ac（动作 tick 里同时挪位的份额）再标定
        turnBuffer: 1,
        minRoundTrip: 6,
        // 无 storage/ctrl link 时约 3/4 的能量要由 hauler 从源直送 controller 容器：按此份额把 spawn→controller 段计入往返
        controllerLegShare: 0.75,
        // 越野与让路损耗：按有效利用率折算所需 hauler 数（投递停靠另算，见下）
        utilization: 0.8,
        // 投递停靠：送进 spawn/extension 的能量每一格 extension 容量（RCL≤6 50、7 100、8 200）要停一次，每停 deliveryStopTicks（转移 + 挪一步）；
        // 份额 = spawn 孵化花费 EMA（spawn.spawnSpendRate）/ 源产出。第 3 轮 A/B（docs/benchmarks/2026-09-06-storage-ab-round3.md）：
        // W33S8 两源离基地 23–37 格、hauler 目标一直 3 只，58% 采样在投递途中、源容器常满溢出（掉落均值 2.7k）——
        // 模型只算 2 × 路程 + 2 tick 周转，一车 800 能量分 16 格投进 extension 的停靠没算。分解写在 Memory.rooms[房].haulModel。
        // 1.5 → 1.1（2026-09-12）：hauler 改成投递成功的那一 tick 就朝下一格 extension 起步（roles/hauler.js 7faced5，transfer 与 move 同 tick、
        // 顺路投递），离线按真实布局重放每停一格实测从 1.42 降到约 1.0；留 0.1 给绕路/让路，等遥测 v2 的 (ulT − acm)/dep 再标定
        deliveryStopTicks: 1.1,
        // spawn 孵化花费 EMA 的窗口（tick）：一代 creep 的寿命——稳态下一代的维持费就是每 tick 花费，窗口短了一只 2400 的 hauler 就把读数顶成锯齿。
        // 以前停靠份额用 spawn 收入 EMA（只在 spawn/ext 没满时采样，是补货时的到货速率）：基准 550k–625k 收入中位是实际花费的 1.4–3.4 倍
        spawnSpendWindow: 1500,
        // link 供能的源不用 hauler 搬：每有一个己方源 link，RCL 底线（floor）减 linkFloorDrop，但不低于 linkFloorMin（storage → spawn/ext 的
        // 补给与塔/工地投递仍要人）。第 5 轮 A/B（docs/benchmarks/2026-09-06-link-ab-round5.md）：RCL6 link 房 hauler 被底线 3 撑在 2.2–2.7 只，
        // 采样里 34–71% 在空闲（忙碌折合 0.6–1.7 只），无 link 的房只空闲 6–18%
        linkFloorDrop: 1,
        linkFloorMin: 2,
        // RCL7 有 store link 时源 link 的能量最终进 storage，hauler 只剩 storage → spawn/ext/塔，看起来底线可以到 1（第 6 轮 A/B：W33S7 1.7 只仍空闲 85%）。
        // 但第 7 轮 A/B 实测底线 1 不划算：W33S7 的 CP/收入只有 38% → 39%（收益在噪声内），却把"零 hauler"窗口从 3 次采样放大到 12 次、
        // 首次出现 2 次 emergencyHarvest，spawn 能量掉到 10–300/5100——第 1 只 hauler 已是生存档且有 TTL 预补，空窗是"唯一一只死亡到替补孵出"
        // 的物理时间（大身体 100 tick 级），加大提前量或加前置条件都消不掉这个单点，只有第 2 只能顶上。留在 2；
        // 等"最后一只 hauler 的替补零空窗"做出来再考虑降到 1。
        // RCL<7 只有 ctrl link 收货，链的吞吐 = 升级者实际 WORK（每 WORK 1/tick），超出的产出堆在源容器里仍要 hauler 搬
        // （第 6 轮 A/B：W31S8 升级 4.6/tick、两源 20/tick 被整源记成 0，hauler 3→2 后源容器 0.6k→1.1k、投递占比 64%、空闲 2%、CP 5.5→5.2）
        linkFloorMinStore: 2,
        // 枢纽搬运工（roles/operator.js）：RCL7 且 store link 贴着 storage、至少一口源已 link 时出 1 只，站在两者之间把 link 倒进 storage。
        // 8C1M=450，一轮 withdraw 400，隔 tick 再 transfer，平均 200/tick，两源 20/tick 够用；store 与 ctrl 同一座时留下 linkKeepAt。
        operators: 1,
        operatorCarry: 8,
        operatorMinCarry: 4,
        operatorKeep: 0,
        // 已接入 store 链的源容器/源旁掉落：hauler 不搬，除非存量达到 overflow（链路堵死时的保险，2000 容量的 75%）
        sourceLinkOverflow: 1500,
        // ---- core hauler 按 CARRY 定编（spawn.estimateHomeHaulerTarget / coreHaulerCarry）----
        // C* = max(模型 + storage 补给, 实测, 补给爆发) 个 CARRY；只数 = 从底线起每只不超过满配的最少只数（不再按在岗平均载量——身体越小只数越多）；
        // 每只 = clamp(ceil(C* ÷ 只数), minBodyCarry[RCL], 满配)。以前每只不小于满配的一半（coreMinBodyShare 0.5）：模型没算的 storage → spawn/ext
        // 靠这一半兜，结果 hub 房（模型 0）两只 16C8M 空闲 60–89%，容器房 RCL5–6 一律 12–16C、装载率 27–44%。
        sizing: {
            // 'measured'：有 haulStats 实测时 C* 取模型/实测/爆发的最大值，实测不足一个窗口时每只不低于满配的 fallbackShare（旧规则）；
            // 'model'：只用模型 + 爆发、每只 ≥ minBodyCarry（不看实测、没有兜底）；'legacy'：每只一直不低于 fallbackShare（A/B 对照）
            mode: 'measured',
            // 实测需求 = 送出/tick（haulStats hauler 桶 out − churn 的差分）× 每趟忙碌 tick（(t − idle) / 出发）÷ (50 × u)：按 75% 忙碌定 CARRY
            u: 0.75,
            // 实测按 hauler-tick 衰减的窗口；累计观察满这么多 hauler-tick 才算实测可用（两只 hauler 约 750 tick）
            window: 1500,
            fallbackShare: 0.5,
            // 每只最少 CARRY：RCL≤6 4（4C2M = 300，一趟装 4 格 50 的 extension）；RCL7 6（extension 100，塔 3 座交战每 tick 耗 30）；
            // RCL8 10（extension 200、3 个 spawn 一次抽空 12900、塔 6 座每 tick 耗 60）。两只 × 最少身体盖得住全部塔持续开火
            // （2×4×50/12≈33 ≥ 2 座 20/tick，2×6 → 50 ≥ 30，2×10 → 83 ≥ 60，按 storage 往返 12 tick 估）
            minBodyCarry: { 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4, 7: 6, 8: 10 },
            // 补给爆发：大身体孵完、spawn/ext 被抽空后多少 tick 内要补满整个容量（C_burst = 容量 × storage 往返 / (50 × refillTicks)，往返含停靠）。
            // 300 ≈ 两只 50 部件 creep 的孵化时间：补满前 spawn 顶多等一只的工夫；storage 富余时能量不是约束、spawn 空等才是，按 refillTicksRich 补
            refillTicks: 300,
            refillTicksRich: 150,
            // 有 storage 但一座 extension/spawn 都没有（方案也没有）时 storage 到补给点的默认距离
            baseDistance: 5,
            // 每只身体的滞回：变大立即生效；变小要离上次改动 ≥ shrinkEvery tick 且至少小 shrinkMin 个 CARRY（RCL / hub 模式 / 定编模式变了就重算）
            shrinkEvery: 1500,
            shrinkMin: 2,
            // 在编 CARRY 比 C* 少 max(2, C* × residualShare) 以上时出一只补差头 core:hauler:x（只数够了、身体偏小：零收入缩身、容量刚涨）
            residualShare: 0.25,
            // 换代门槛：方案身体比在岗的至少大这个份额（且 ≥ 2 CARRY）才换——方案随孵化花费 EMA / 实测漂移，差一两个 CARRY 就换只是把旧身体提前回收
            upgradeCarryStep: 0.25,
            // 临时编制（+1 只，不放大身体）：spawn 等能量超过这么多 tick、而 storage 里的能量够补缺口——补给跟不上
            tempWaitTicks: 100,
        },
        // ---- 单只 hauler 的饱和（roles/hauler.js）----
        // 取货门槛：值得专程跑一趟的最少可取量 = max(pickupMin, min(空位 × pickupShare, pickupMin + pickupPerTile × 路程))。
        // 以前固定 100：1500 容量的 hauler 跑 25 格去拿 150（到达约 400），一趟只运 25%——基准容器房在途装载率 0.34–0.6、
        // 货物行进利用率 0.14–0.28（理想约 0.5），haul 看着 0–2% 空闲，实际一半运力在空跑半车
        pickupMin: 100,
        pickupShare: 0.5,
        pickupPerTile: 25,
        // 急用（spawn 在等买不起的 creep、或 spawn/ext 低于容量的这个份额、或塔紧急/控制器见底）时取货门槛降到 50：宁可小车快送
        urgentSpawnShare: 0.3,
        // 在有进账的源容器旁补满：装到 leaveShare 就走；之前按"进账 × 往返 > 现有载货"判断等比走更划算
        leaveShare: 0.9,
        // 零头：揣着不到容量这个份额、又没有投递目标时去补满，而不是揣着零头发呆
        topUpShare: 0.25,
        // 从 storage 取出的货不回 storage（倒腾保护）；揣了这么多 tick 仍送不出去才允许放回
        storageCargoRelease: 100,
        // W34S7 terminal 被 30 万 ZH2O 塞满（晴猫 16:22）：空闲 hauler 搬进 storage，terminal 留 10 万给卖单
        stash: { W34S7: { resource: 'ZH2O', keep: 100000, storageFree: 50000 } },
        // 反向囤货（2026-10-15 战略猫）：W33S7 storage 的 L 由空闲 hauler 搬进 terminal 到 target，供 terminal 调剂给 lab 房；
        // target 8000 < market.keepBy.L 1 万，市场不会把它卖掉
        unstash: { W33S7: { resource: 'L', target: 8000, terminalFree: 20000 },
            // 10-17 09:xx：W33S3 做 GH 缺 H（库存 0、矿脉没开采），W32S4 的 4.8 万 H 全在 storage，terminal 调剂只看 terminal → 搬 5000 进 terminal，
            // 超出 mineralKeep+mineralWant 的部分自动调给 W33S3；5000 < market.keepBy.H 2 万，不会被卖
            W32S4: { resource: 'H', target: 5000, terminalFree: 20000 } },
        // 溢出：源容器 ≥ spillShare 满、或源旁地上 ≥ spillDrop（每 tick 衰减 ceil(量/1000)），取货权重提到 spillWeight，
        // 同时 storage 的富余回流退回兜底（线上 2026-09-12 W33S3：22 格外的源容器 57% 采样满仓、脚下 3.4k–8.7k 在烂，
        // hauler 被 storage → ctrl link 的回流任务（权重 8）整场吸走，187 tick 没去过一次）
        spillShare: 0.9,
        spillDrop: 500,
        spillWeight: 10,
        // 溢出按源判定、带滞回：进入 ≥ spillShare 满或地上 ≥ spillDrop；退出要容器 < spillExitShare 且地上 < spillExitDrop（取一车就退出会来回切）
        spillExitShare: 0.6,
        spillExitDrop: 200,
    },
    spawnLead: {
        harvester: 18,
        hauler: 24,
        upgrader: 18,
        builder: 18,
        scout: 30,
        feeder: 12,
        operator: 36,
        remoteMiner: 60,
        remoteHauler: 90,
        reserver: 120,
    },
    // 出生口袋：spawn 旁被建筑/墙围死的格（从那格出发连通的可走格 < minTiles）不当出生方向（spawn.spawnDirections → spawnCreep 的 directions）。
    // 引擎（_born-creep.js）按方向 1..8 取第一个空格出生，TOP 最先——线上 2026-10-08 W31S4：Spawn18 (25,16) 正上方 (25,15) 三面是墙、
    // 左右是 extension，孵进去的 creep 一步都走不出来；12W 升级者 慧音甲 在那格空手站到老死（控制器 0 进度 ≥ 650 tick），
    // 之前 47W 的 慧音庚 也在同一格站了整整一生。minTiles 10：基地里真正的通道连着整个房间，几格的死角才是口袋
    // 出口被己方 creep 堵住（spawn_exit.releaseStalledSpawns / runVacate）：引擎只试给定方向、不回退，孵好的 creep 一直卡在 spawn 里。
    // vacateAt 1：remainingTime ≤ 1（这一 tick 末就要出生）且给定方向的可走格全站着 creep、至少一只是自己的，就让其中一只能动的让路
    //   （memory.vacate）——不等第一次出生失败，operator 的站位就是出口时每只新 creep 都要等一次，省掉那 1 tick；
    // vacateHoldTicks 10：让路的 creep 离开后原地等到出生完成，最多 10 tick（出生落在走开当 tick 或下一 tick 末，走回来照样占格）；
    // vacateSearch 3：让路的去处在 3 步内找（不贴着任何己方 spawn、没有 creep），基地里一两步就有空格；
    // stallTicks 5：连续 5 tick 孵好却生不出来（让路的没 MOVE / 找不到去处）才兜底放开别的方向，且只放"现在可走、不是口袋"的方向。
    //   线上 2026-10-08 W34S7：旧兜底放开全部 8 个方向，Spawn21 的替补源矿工孵进 TOP_LEFT (26,33) 口袋被困死（W31S4 5 次、W34S7 3 次）；
    //   宁可 spawn 多等（看门狗、让路兜底）也不往口袋里孵；
    // trappedScanInterval 20：每 20 tick（按房错峰）看一遍口袋格，连续两次扫描站在同一口袋格的己方 creep（旧兜底孵进去的）就地让贴着的 spawn 回收；
    //   口袋只按建成的障碍算（工地 creep 踩得过去：builder 站在只因 extension 工地围成的格里不算困住），两次确认防误回收路过/刚被推进去的 creep
    spawnPocket: { minTiles: 10, stallTicks: 5, vacateAt: 1, vacateHoldTicks: 10, vacateSearch: 3, trappedScanInterval: 20 },
    // 扩张：由外部大脑的 claim 指令触发；母房容量 ≥ minCapacity（[CLAIM,MOVE]=650）且 RCL ≥ minRcl 才孵化
    expansion: {
        minCapacity: 650,
        minRcl: 3,
        pioneers: 2,
        pioneerBudget: 800,
        arrivalTimeout: 650, // CLAIM 寿命 600 + 孵化余量；一个窗口仍无人到达则停止续派
        unreachableTicks: 1500, // 首次失败冷却，后续指数退避
        unreachableMaxTicks: 24000,
        // 大脑掉线时的自治占领兜底（2026-10-13，移植 overmind-absorb a57da2e/b63cc9c）：占领目标本来完全由外部大脑定，
        // 掉线超过宽限（brain.STALE_GRACE_MS 6h）后别的模块都还能降级自转，只有"再占一个房"完全停摆。
        // 默认开，但只在指令 ttl 到期后 autoClaimAfterMs 才接管：本机睡一晚（≤ 12h）不该让游戏内替大脑做账号级决定，
        // 掉一整天才算真掉线；大脑一回来立刻让位（哪怕它这一轮没给 claim——那是它的决定），没占下的自治目标在途 creep 退役。
        // Memory.brain 从没出现过（新号/私服场景）不算掉线、不触发。门槛刻意比大脑严，宁可不占也不占错（见 expansion.autoClaimTarget）
        autoClaim: true,
        autoClaimAfterMs: 24 * 60 * 60 * 1000,   // 低于 STALE_GRACE_MS 时按宽限算：宽限内指令仍可用，本来就轮不到兜底
        autoClaimInterval: 1500,   // 多久重扫一次 Memory.map（扫一次几百条，别每 tick 做）；缓存期内只复核已挑中的房
        autoClaimRange: 2,         // 房间距离上限，与大脑 claimRadius 同（pioneer 支援距离；再远援建也够不着）
        autoClaimFreshFor: 20000,  // 情报超过这么久不敢用（Memory.map 本身也是 20000 tick 老化）
        // CPU 闸（2026-10-13 复审）：多一个房是永久的 CPU 开销（线上 ~160/13 ≈ 12 CPU/房，长到 RCL 中期更多），而兜底时没人复核——
        // 2026-10-08 那次 bucket 掉到 53 就是房/外矿涨得比 CPU 快。bucket 低于 autoClaimMinBucket（半桶，远在 cpuShed.lowBucket 2000 之上）
        // 或最近 autoClaimCpuSamples 条 Memory.stats 的 tick 用量均值超过 limit × autoClaimMaxCpuShare 就不挑新房：
        // 0.8 在 limit 160 时留 32 CPU ≈ 两个房的余量。已经在开荒的自治目标不受这道闸（半路撤掉白扔 claimer/pioneer 的能量）
        autoClaimMinBucket: 5000,
        autoClaimMaxCpuShare: 0.8,
        autoClaimCpuSamples: 5,
    },
    // 攻占（src/conquest.js）：夺取相邻玩家已占房。默认无 Memory.conquest 指令时整块零影响。
    // 破防单位 [WORK,MOVE]×12（1800，600 拆卸/tick）、围降单位 [CLAIM,MOVE]×2（1300，每次 attackController −600）。
    // 无 boost 的破防兵力（部件损毁建模、真实塔目标）：W31S4 单塔 ≈16、W32S4 双塔 ≈22-24；见 docs/analysis/2026-09-06-w31s4-w32s4-conquest.md。
    conquest: {
        dismantlerBudget: 1800,
        downgraderBudget: 1300,
        // 护卫 [RANGED_ATTACK,HEAL,MOVE,MOVE]×n：2200 → 4R+4H+8M（40 ranged/tick、48 heal/tick、满速）；对付目标房内敌方战斗 creep、护住无攻的 downgrader
        guardBudget: 2200,
        // 母房 storage 能量低于此不出破防/护卫（保住本房经济与外矿 reserver）：线上 W32S4 一波集结把全账号 reserver 抽到 0/8，配合 spawn.js 的 blocking:false 一起防经济崩；围降接力不受限（占领必须）。指令可设 storageFloor:0 覆盖。
        storageFloor: 15000,
        // 进场泳道半宽：沿目标房入口边把 creep 横向散开的范围。**默认 0 = 关闭**——B0 私服 A/B 实测（破防瞬间存活/17）：
        //   易场景(塔近入口) 开 11 / 关 11；难场景(塔在远端) 开 6 / 关 7。**没有可测收益**（难场景甚至略低，在噪声内），
        //   而且早期未加地形感知时还造成过一次整队进不了房。理论上"并行过境缩短暴露窗口"成立，但本 harness 量不出来。
        // 保留旋钮与地形感知实现：将来若有更长接近距离的目标或更灵敏的指标，可再评估。
        entryLaneWidth: 0,
        // 进目标房后重新聚合的比例。**默认 0 = 关闭**：B0 实测 + 引擎推算表明"在目标房内等聚合"是有害的——
        // 集结锚点在房内 8 格处，等待期间全程挨塔火（塔在所有距离开火，150–300/tick），等 60 tick 等于白送几只。
        // 队伍在**房外集结点**本来就已聚齐，靠 laneTile 并行泳道过境即可同时抵达，不需要在火力下再集合。
        // 保留这个旋钮：将来若实现"在房外重新聚合"或有 boost tank 顶在前面，可以再打开。
        reformShare: 0,
        reformWait: 60,
        // 房外集结点的等待上限。集结判据是「集结点上的同波同伴数 ≥ squad」，而 squad 是整波的编制数：
        // 波次一旦出发，全体都在目标房里，之后孵出来的替补到了集结点只看见自己（1 < squad），
        // 于是在自己的格子上一直等到寿终——一只 1800 能量的身体白扔。等满 stageWait 就自己出发。
        // 取值要长于「整波孵化 + 走到集结点」的时间，否则第一波会被拆散着送进去。
        stageWait: 200,
        // Boost（src/boost.js，移植 overmind-absorb 79a5ee4）：攻城 creep 离开母房前先到装着化合物的 lab 旁强化。
        // **默认空 = 关闭**：线上大多数 RCL7 房 storage≈0，矿物链（terminal → labTech → 反应 → boost lab）还没真正跑出化合物；
        // 而且强化让 creep 在家多待几十 tick，得先确认这笔时间换得回来。打开方式：指令里写 boosts:{dismantler:['XZH2O']}
        //（整份覆盖这里；部署会把 config 重置回默认，所以别靠改 config 打开），或改这里，如 dismantler: ['XZH2O']、guard: ['XLHO2']
        // 这个开关（或指令 boosts）同时决定 task_broker 给不给 boost lab 补能量：关着时没人来强化，补进去的能量只会锁在 lab 里
        boosts: { dismantler: [], guard: [] },
        // 强化最多在家耗多少 tick（从第一次有做得到的强化算起）：走到母房 lab 旁 ≤ 50 格（满速 1 tick/格）+ 每种化合物 1 tick，
        // 100 留了一倍余量；超时（交通堵住、lab 被抢占）就放弃整份清单直接出发，不让整波在家耗掉寿命
        boostMaxWait: 100,
        // 参与出兵的最低母房容量：800 → W33S7(1800)/W34S7(1300)/W35S7(1150)/W33S8(1100) 都够格；更小的房造的 dismantler WORK 太少、意义有限
        minCapacity: 800,
    },
    // keeper 房过境规避：claimer/pioneer 穿 SK 房时，寻路对 keeper lair 周围 range 格内的格子加成本
    //（movement.keeperAvoidCallback，(range-dist+1)*weight），逼路径贴远缘绕开 keeper 的杀伤圈——
    // keeper 近战 range 1 + 远程 range 3、靠 lair 驻守，脆弱 claimer 贴近必死；2400 血 dismantler 保持距离已实测无伤穿过。
    // 大脑端 plan.travel_ticks 用同半径 keeperAvoidRadius 绕 lair 估路（两边一致）；lair 坐标来自 intel 的 Memory.map[房].lairPos ∪ 房内视野。
    keeperAvoid: { range: 5, weight: 40 },
    // Source Keeper 采矿（2026-10-13 移植自 overmind-absorb 4dcc63c…67a8baf）：SK 房当一种特殊外矿（record.sk），复用 remote.js 的
    // 容器/卸货房/路/hauler 编制，多一只常驻的 skReaper（roles/skReaper.js）杀守卫。**默认关**——它改外矿与孵化需求、把 creep 放到 keeper
    // 旁边，开之前要做同快照 A/B。打开方式：这里 enabled，或大脑指令 rooms[母房].skMining（布尔，优先于这里）；两种都还要求 SK 房在大脑的
    // 外矿白名单里（自治模式永远不收 keeper 房）。引擎里的 keeper（@screeps/engine processor/intents/creeps/keepers/pretick.js）已核对：
    //   身体 17 TOUGH + 13 MOVE + 10 ATTACK + 10 RANGED_ATTACK，5000 血，**没有 HEAL**；AI 只走到自己那口源/矿脉 1 格内然后不动——**不追人**，
    //   只打进入射程的：range 1 挨 300(近战)+100(远程)，range 2–3 只挨 100，range ≥ 4 完全不挨打；lair 在 keeper 掉血/消失时把 nextSpawnTime 设成 300 tick 后。
    // 所以一只 n RANGED + n HEAL + 2n MOVE 站 3 格外单挑就够：每 tick 挨 100、打 10n、自愈 12n，n ≥ 9 净回血。
    sk: {
        enabled: false,
        // RCL7 起：RCL7 的 5600 容量给 11 组（打 110、自愈 132，46 tick 杀一只）；RCL6 的 2300 只够 4 组，自愈 48 < 挨打 100
        minRcl: 7,
        maxRoomsPerHome: 1,
        // reaper 组数上限（每组 RANGED + HEAL + 2 MOVE = 500 能量、4 部件；12 组 = 48 部件，贴 50 上限）
        reaperUnits: 12,
        // 组数下限：自愈 12 × 9 = 108 > keeper 远程 100/tick。买不起这么多组就**不派**（不缩身——自愈不够的 reaper 只是慢性送死），
        // 也不为这个 SK 房出任何别的需求
        reaperMinUnits: 9,
        // 矿工/运输工与 keeper 的最小距离：keeper 远程射程 3，≤ 4 就退（keeper 还会朝自己的源挪一步），退到 5 格外
        keeperSafeRange: 4,
        // reaper 交战/待命时与 keeper（或下一个要孵化的 lair）的距离：恰好在远程射程 3 上，只挨远程不挨近战
        reaperStandoff: 3,
        // lair 离孵化还剩这么多 tick 就提前把附近的矿工/运输工撤开（keeper 就生在 lair 格上）：矿工 1 tick 走 1 格，10 tick 足够退出 4 格
        lairWarnTicks: 10,
        // SK 源 4000（SOURCE_ENERGY_KEEPER_CAPACITY）/ 300 tick = 13.3/tick：remoteMiner 的 5 WORK（10/tick）采不完，7 WORK = 14/tick 刚好盖住
        minerWork: 7,
        // reaper 被打死（不是寿终）lossWindow tick 内达到 maxReaperLosses 次：这个 SK 房停 lossCooldown tick（suspendReason skReaperLost）——
        // 一只 reaper 6000 能量，打不过（多只 keeper 同时贴脸、玩家/入侵者混进来）时别每 300 tick 送一只
        maxReaperLosses: 2,
        lossWindow: 3000,
        lossCooldown: 5000,
        // 10-17 单只验证模式（默认关，10:17 由战略拍板）：只派 1 只 reaper 去 room，把血量/击杀记到 Memory.skReaperValidate
        validate: { enabled: true, home: 'W33S7', room: 'W34S6', units: 12 },   // 10-17 10:26 战略拍板：单只验证模式，只去 W34S6（不去 W36S6）
    },
    // 防御（只对 NPC）：母房容量 ≥ minCapacity 才派 defender；清场后 idleTicks 无敌情回家退役
    defense: {
        minCapacity: 260,
        idleTicks: 50,
        // 一组最多几只 defender：planSquad 从 1 只起找最便宜的能赢编组（线上 2026-09-05：单只 4R1H 对两只强化 Invader 连送 41 次）
        maxDefenders: 3,
        // 打得过的判定：我方击杀时间 × winMargin ≤ 对方击杀我方的时间（同时交换伤害、对方全在射程内的悲观模型，见 defense.canBeat）
        winMargin: 1.5,
        // 进了目标房等队友到齐再推进的最长 tick（入口附近守着，射程内照打）
        squadWait: 300,
        // 外矿防御的经济门槛：编组总成本 ≤ 入侵者剩余寿命内的期望产出（源数 × 10/tick）× remoteValueShare，否则停到入侵者到期
        remoteValueShare: 0.5,
        // 己方房连续阵亡上限：同一波敌人（房里一直有武装敌人）阵亡这么多只后不再续派，直到敌人到期或房间清场（defenseLog.streak 归零）；
        // 大脑 fight 指令可越过。2026-09-06 W31S5：RCL2 无塔、容量 300，对一只强化 Invader（1086 血、80 DPS）连送 7 只 2A2M 阵亡 6 只——
        // 编组模型按"三只同时交换伤害"判能赢，实际每只刚孵出就在 spawn 旁被单杀；本房敌人一直可见，"阵亡后没再看到敌情就不续派"的门永远不闭
        maxOwnLosses: 2,
    },
    // safe mode（src/tower.js）：开不开由外置大脑决定（scripts/brain/safemode.py，指令 rooms[房].safeMode = {action, reason, atTick}），
    // 大脑看得到敌方 body/boost/主人（不需要视野）和别的母房能否及时出兵；游戏内只保留最后手段——核心建筑（spawn/塔/storage）真的掉血才开。
    // decisionTtl：指令里的决定超过这么多 tick 视为过期（guard.py 每 1–2 分钟刷新，run.py 每 5 分钟）；
    // fallbackCoreShare：没有（新鲜）决定时核心建筑血量低于此份额才开；lastResortCoreShare：大脑说 hold 时只有核心建筑掉到这个份额以下才违抗
    // （2026-09-06 W31S8：无塔 RCL2 房被一只 NPC 入侵者触发 safe mode，70000 tick 内再不能开盾，18 tick 后还孵了 2 只 defender）
    // 同一账号同时只能有一房在 safe mode：别房开着时 activateSafeMode 返回 ERR_BUSY（2026-09-06 W31S5：大脑 activate、W31S8 还剩 7600 tick，
    // 开不了），失败码记在 defenseLog.safeModeError，大脑 safemode.py 看到别房开着就给 hold（busy:<房>）
    safeMode: { decisionTtl: 600, fallbackCoreShare: 0.5, lastResortCoreShare: 0.3 },
    // 退役回收（src/retire.js）：走到全账号最近的 spawn 旁 recycleCreep（退 100% × 剩余寿命比例的造价）而不是原地 suicide（只退 20%）。
    // walkShare：走过去的估计 tick < walkShare × 剩余寿命才走，盈亏平衡点是 1 − CREEP_CORPSE_RATE = 0.8；tilesPerRoom：跨房每房按 50 格估路程
    // recheckTicks：走的途中每隔这么多 tick 复核一次剩余寿命够不够走完（估计是平地下限，沼泽/绕路更久），不够就原地 suicide 保住 20%
    // crippledGrace：必需部件全阵亡的残废 creep（utils.crippledParts）先观察这么多 tick 再退役——本房塔没敌人时每 tick 治 200–400 血，几 tick 就能把部件治回来；
    // 外矿房没塔，10 tick 只是采集中断的零头（线上 W32S5 三只残废 creep 本来要占 870 tick 编制）
    retire: { walkShare: 0.8, tilesPerRoom: 50, recheckTicks: 10, crippledGrace: 10 },
    // 打捞：己方房里 tombstone / ruin / 地面上的非能量资源（入侵者阵亡掉的 boost 化合物、拆迁 ruin 里的矿物）由 hauler 主动收进
    // terminal / storage。以前只有被动出口（roles/hauler.js salvageCargo：身上已经有矿物才卸掉），没人专程去捡：
    // 线上 2026-09-12 W35S7 的入侵者 tombstone 掉了 GO 95 / KO 17 / ZH 23 / UH 11（够 boost 4 个 TOUGH + 零头），
    // 250 tick 的 tombstone 寿命里没有任何 creep 认领，衰减成掉落后又每 tick −1 全丢光。
    salvage: {
        enabled: true,
        // 专程跑一趟的最少量 + 每格路程的加价：一个部件的 boost 是 30 单位（LAB_BOOST_MINERAL），所以近处 30 就值得去；
        // 远处按 minAmount + perTile × 路程 涨价，别为 30 单位横穿半个房间。同一格的掉落算一堆（tombstone 衰减后
        // 就是几堆挤在一格，各自达不到门槛的话谁也不会去）
        minAmount: 30,
        perTile: 2,
        // 超过这个路程不专程去（己方房对角线约 70，40 覆盖基地到绝大多数角落）
        maxRange: 40,
        // 认领后多久没捡完就放弃：目标被别人捡走 / 衰减光 / 路被挡死时不要一直挂着
        timeout: 200,
    },
    // 远程采矿：RCL4+ 开启，由 scout 探明后自动纳入（要求无主、无 Keeper 巢穴、双源；keeper 房只走 config.sk 那条闸）
    // 10-16 战略猫：高威胁玩家回避。highThreat 的玩家一露面、或任何玩家的武装 creep 出现过的非己方房，armedMemory tick 内
    // 外矿/deposit 不派人、在场 creep 撤回母房、不在己方房以外和玩家交火；dangerRooms 是手动永久回避（寻路绕开、不做外矿/deposit/防御）
    // 10-17 官方系统号/NPC owner 名单常量：这些 owner 的 creep 一律当 NPC，不记 pvpAggressors、不触发封路（Screeps 是官方系统号 GCL 0，W30S7 的 8 个 NPC 也归它）
    npcOwners: ['Invader', 'Source Keeper', 'Power Bank', 'Screeps'],
    pvp: {
        highThreat: ['Jumpp'],
        blockExclude: [],   // 10-16 战略：这些玩家只记攻击、不触发高速路封路（23:59 Kasami 移出，按通用规则封）
        aggressorTtl: 20000,   // 10-16：Memory.pvpAggressors 里的玩家这么多 tick 没再动手就移除
        highThreatIds: ['5a8a3d2d90d85961a7b853de'],
        armedMemory: 300,   // 10-16 战略猫：威胁离开后再等 300 tick 才恢复
        dangerRooms: [],   // 10-16 晴猫：W30S9 不永久回避，只按 pvpThreat 临时回避
    },
    remote: {
        holdReserver: { W31S9: 20000 },   // 10-16 战略猫：W31S8 storage < 2 万时不派 W31S9 reserver（矿工/hauler 照常），首次到 2 万自动恢复
        // 母房 storage+terminal 低于它时外矿 hauler 按 max(energyAvailable, lowStorageHaulMin) 定身体（remote.haulBudget，2026-10-15）
        // 10-16：饿线（在途 CARRY < 需求一半）的 hauler 需求排到外矿维护档最前（remote.js starvedLine），先只开 W29S3
        starvedHaulFirst: ['W29S3'],
        lowStorageHaulBelow: 5000,
        lowStorageHaulMin: 800,
        // 外矿分配（remote.remoteWhitelist）：数组优先于外部大脑白名单，[] = 不做外矿；没列的母房照旧听大脑/自治。
        // 2026-10-14「挪不加」：W32S4 的 W32S5 → W31S5（相邻）；W33S8 的 W34S8 → W34S7（相邻）；
        // W37S7 的 W37S6 → W37S5（相邻），W37S5 原四个 W38S6/W39S* 路程 ~95–104、全部 unreachable 冷却中，撤掉（W37S5 缺能量的根因：外矿零收入）。
        // W35S7 → W36S7（2 源，invader core ~74333973 到期；W35S8/W36S8 是 Alepoldar 的），W38S7 让出 W38S9 抵名额
        assign: {
            W31S5: ['W32S5'],
            W32S4: ['W33S4', 'W32S6', 'W33S5'],
            W34S7: ['W34S8'],
            W33S8: ['W32S8'],
            W37S5: ['W37S6'],
            W37S7: ['W39S9', 'W39S6'],
            W35S7: [],   // 2026-10-15：W36S7 被 Alepoldar 预定，战略猫决定不争
            W33S7: ['W32S7', 'W33S6'],
            W31S8: ['W31S9', 'W29S9'],
            W31S6: ['W31S7', 'W29S7'],
            W33S3: ['W33S2', 'W32S3', 'W32S2', 'W32S1'],
            W31S4: ['W31S3', 'W31S2', 'W29S2'],
            W38S7: ['W38S8', 'W39S7', 'W39S8'],   // W38S9（1 源 1500）让出名额，抵 W35S7 新开的 W36S7
            W29S3: ['W29S2', 'W29S1', 'W31S1'],
        },
        minRcl: 4,
        maxRooms: { 4: 1, 5: 1, 6: 2, 7: 2, 8: 2 },
        // 外部大脑白名单里的房最远允许两跳；单源房也可作外矿（自治模式仍只收相邻房）
        maxRange: 2,
        minSources: 1,
        hostileSuspend: 150,
        reservationBuffer: 100,
        // reserver 用 [CLAIM×2,MOVE×2]（1300）的最低母房容量：1 CLAIM 只能把预定保持在 1，reserver 一到期预定立刻归零、源掉回 1500 档
        // （线上 W34S8/W32S8 反复如此）；2 CLAIM 每 tick 净攒 1 点，一代攒出几百 tick 缓冲。spawn 队列在 reserverGrace tick 内攒不够
        // 就自动退回 650 的 1 CLAIM，不再有"等满仓"的风险，原 1650 的 20% 余量规则撤销
        reserverDoubleClaimCapacity: 1300,
        reserverGrace: 60,
        // reserver 只在预定余量 ≤ 提前量 + DEMAND_BUFFER + reservationKeep 时才补（不再"有 reserver 活着就按 TTL 链式续派"）：
        // 2 CLAIM 在岗每 tick 净攒 1、离岗每 tick 掉 1，维持水位只要约一半的时间在岗；引擎在 endTime+CLAIM 数 > 5000 时直接拒绝
        // reserve（processor/intents/creeps/reserveController.js），链式续派的 reserver 顶在上限空转——线上 15 只 reserver 里 8.7 只
        // 守在 ≥4500 的外矿上、基准 48% 的 reserver 出生时预定已 ≥3000。reservationKeep 是交接断档的缓冲
        reservationKeep: 1000,
        roadSiteInterval: 17,
        // 外矿路线失配自愈（remote.noteRoadTrail）：路工地按规划路（planRoute 从母房锚点搜、range 1）放，而顺手修路只发生在
        // 满载 hauler 的 3 格射程内；creep 的寻路（movement.go 目标是卸货房房心 range 20）在代价并列的房里会挑另一条走廊，
        // 工地就永远建不起来——线上 W31S9 的 6 个工地零进度挂了 1.45 万 tick，W31S7 / W32S6(0/68) / W31S1(0/22) 同病，
        // 而 1 跳外矿两条线基本重合（W34S8 54/54、W33S4 34/34）。连续 roadTrailLegs 趟满载腿的真实走线落在规划路上的比例
        // 都低于 roadTrailMatchShare，就把实际走线采纳为新的房内路线（旧工地随之成为孤儿，由 pruneOrphanRoadSites 清掉）。
        // 3 趟：偶发的绕路（交通解算让位、卡住重寻路）不会连着三趟都偏，而系统性分叉每趟都偏。
        roadTrailLegs: 3,
        // 走线有一半落在规划路上就算"对上"：沿路让位常偏 1–2 格，不该当成失配
        roadTrailMatchShare: 0.5,
        // 按走线改过一次之后的冷却：路还没铺起来时各趟走线本来就会差几格，连着改只会把工地在相邻走廊之间搬来搬去
        // （私服 validation-jM2cqE 的 900 tick 里同一条外矿改了两次，第二次 29→29 什么也没改善）。
        // 代价不只是白跑：pruneOrphanRoadSites 只清**零进度**的工地，修了一半又被弃用的工地会永久占着
        // 每外矿 6 / 每母房 roadSitesPerHome / 全账号 100 的名额。一个 creep 寿命足够把新走廊的头几格铺出来，
        // 之后路是 cost 1，creep 自然收敛到它上面，走线与规划路就吻合了。
        roadTrailCooldown: 1500,
        // 母房名下所有外矿的路工地总数上限（每个外矿仍最多 6 个在建）：基准里 5 个外矿 × 6 条路长期占 30 个全局名额，采集为 0 的外矿也各占 6
        roadSitesPerHome: 12,
        // 卸货房（record.drop）重算间隔：运输工往全账号路程最短的己方房卸货，hauler 编制按到卸货房的距离算（W31S8 → W33S8 2 跳、→ W33S7 3 跳）
        dropRefreshTicks: 500,
        // 候选卸货房的 storage 比母房多出这么多就不选（能量送去只会躺在富房 storage 里，母房替它养 creep）
        dropRicherMargin: 50000,
        // 外矿运输编制（remote.requiredCarryFor）：往返 = 2 × 路程 + turnTicks + 投递停靠，按利用率折算越野与让路；以前零余量，贴线的外矿容器常年满仓、矿工停手。
        // 投递停靠按卸货房实测（Memory.rooms[卸货房].remoteStop.ema，remoteHauler 卸空时记：进房后除去走到锚点的步数还花的 tick），
        // 样本 ≥ stopMinSamples 才用、夹在 [1, deliveryStopTicks]；deliveryStopTicks 是没有数据时的回退与上限（10 = 旧模型"5 格 extension × 投 + 挪"）。
        // storage / 控制器容器一次卸空的房实测 1–3：短线单 hauler 的规划 CARRY 因此少 10–25%（省下的 tick 以前变成在容器旁涓流等货）
        deliveryStopTicks: 10,
        stopMinSamples: 3,
        // 两端周转：以前 +4（取满那一 tick、投空那一 tick 各站一拍 + 出口格）；remoteHauler 取满 / 投空的那一 tick 就起步之后只剩出口格与让路
        turnTicks: 2,
        haulUtilization: 0.9,
        // remoteHauler 取不满时"等还是走"（roles/remoteHauler.leaveEarly）：进账 × 一趟往返 ≤ 载货就带着现有的货走
        // （等 w tick 多拿 i·w，吞吐 (L+iw)/(T+w) > L/T ⇔ iT > L）。departMinShare 是提前走的最低装载率：没矿工（进账 0）时
        // 也不为几十能量专程跑一趟——1/4 车起步，按 1:1 身体一趟的步行成本约等于 1/4 车的孵化摊销
        departMinShare: 0.25,
        // 外矿 hauler 寿命的最后一趟（roles/remoteHauler.ttlRetire）：卸空时寿命 < 去程 + 回程 + ttlMargin 就回收退役
        // （去/回程用本线实测腿长 EMA，没有就按路程 × 每格 tick；余量盖出口格、沼泽、让路）。退役只在替补已在计划里、或外矿容器放得下
        // (cycle − ttl) × 进账时——否则最后一趟照跑，别让单 hauler 的线溢出。老死只退 0 能量、带货老死在路上的 tombstone 没人捡，
        // 回收退 剩余寿命/1500 × 造价（线上 ttl<80 的外矿 hauler 24% 满载死在中转房/外矿路上，每只每代约 170–340 能量）
        ttlMargin: 20,
        // 在矿位寿命 ≤ 回程 + ttlDepartMargin：带着现有的货走（空手就回收）；连回程都不够就把货倒回容器（或落在矿位旁）
        ttlDepartMargin: 10,
        // 外矿停用剩余 > suspendRetireAfter tick（打不过等入侵者到期、别人预定 ticksToEnd + 100）或 剩余 + 路程 ≥ 寿命：空载 hauler 回收退役
        // （同 reserver.js）。有视野时敌情冷却每 tick 重置为 150（defender 在打），不会触发
        suspendRetireAfter: 300,
        // 母房 storage ≥ spawnCapStorageAbove（< spawnCapStorageBelow 退出）时外矿 creep 最多占 spawn 数 × richSpawnShare 的孵化时间：
        // 能量已经花不完，孵化时间才是瓶颈（线上 W33S3 storage 34 万、单 spawn 80% 被外矿占着，富余升级者排不上）
        spawnCapStorageAbove: 100000,
        spawnCapStorageBelow: 60000,
        richSpawnShare: 0.5,
        // 外矿 creep 在去程连续 stuckTicks tick 原地不动 ⇒ 外矿不可达（无路/被墙堵）：停用并冷却 unreachableTicks，creep 空载退役
        stuckTicks: 60,
        unreachableTicks: 3000,
        // 不可达退避：第 n 次连续不可达冷却 unreachableTicks × 2^(n−1)，封顶 unreachableMaxTicks；有 creep 真正看到该房后计数清零；
        // 冷却到期先只出一只矿工试探，看到该房才放开其余需求（基准 a0d5f74 分叉：四个不可达房每 3000 tick 整套重试一轮，合计白花 3.7/tick）
        unreachableMaxTicks: 24000,
        // 编制预算（remote.staffRemotes）：房只养收入养得起的外矿。每条外矿的摊销成本 = (矿工 + reserver + 各槽位 hauler) 造价 / 各自寿命，
        // 产出只算运回**本房**的能量（卸货房是别的房时记 0）；按 产出 − 成本 从高到低累加，累计 ≤ 本房 spawn 收入 × upkeepShare 的才在编。
        // 依据（线上 2026-09-09 W33S7）：4 条外矿的摊销成本合计 12.8/tick，而房收入只有 8–11/tick，
        // 光 4 个 reserver 就 4.3/tick（每个 650–1300 能量 / 600 tick 寿命）；队列队头永远是买不起的 2250 外矿运输工（等 687 tick 并挡住发展档），
        // 源容器 2000/2000 满、地面能量堆到 1000–2600，storage 停在 197 —— 编制超出收入时不是"排队等能量"，是整房卡死。
        // 0.5：编制摊销只许占收入一半——另一半要留给核心维护（矿工/hauler/升级者/builder 约 4/tick）**和把编制真正建起来的前期成本**。
        // 编制刚好等于收入时房间永远攒不出第一只运输工（摊销账平衡 = 没有余量买新身体），这是死循环的算术形式；
        // 0.5 让 W33S7（收入 10/tick）先只养 1 条最近的外矿（2.7/tick），余量 3.4/tick 在 ~500 tick 内孵出第一只运输工，
        // 收入翻倍后再自动加第二条。
        upkeepShare: 0.5,
        // 已在编的外矿按这个系数放宽（收入抖动时不来回停启；新外矿仍按 1 倍预算进）
        upkeepSlack: 1.3,
    },
    // 援建：容量 ≥ minHomeCapacity 的母房为 maxRange 内、无 storage 且容量 < untilCapacity 的己方房孵满配矿工/hauler/builder（memory.home 指向弱房）
    // untilCapacity 800 → 1300（2026-09-06 用户决定加大援建）：RCL4 的房在 20 个 extension 建完前继续有大 hauler/builder，弱房 storage 能量 < storageBelow 时仍受援；
    // 母房 storage ≥ exportAbove 时派 couriers 只 courier（roles/courier.js）把 storage 能量搬到弱房，storage 只留 exportKeep 给母房自己；
    // 母房单 spawn 的时间才是瓶颈（W33S7 常年 100% 忙），所以 courier/builder 仍是非 strategic，排在母房自己的需求之后
    aid: { untilCapacity: 1300, storageBelow: 10000, minHomeCapacity: 800, maxRange: 2, haulerCarry: 16, builderWork: 5, lead: 200,
        couriers: 1, exportAbove: 10000, exportKeep: 5000, courierBudget: 1600,
        exportAfterTerminal: ['W29S3'],   // 10-16 战略：W29S3 terminal 建成前不派 courier 导出 storage，建成后自动恢复
        // 援建前查"母房到弱房有没有不穿 SK/他人房的路线"（movement.safeRouteExists，aid.needsAid / aid.markStranded）的缓存 tick：
        // 危险房集合随情报慢变、变了缓存立即失效，所以不必每 tick 跑 findRoute；1000 tick ≈ 一只援建 creep 寿命的 2/3，
        // 地形本身不会让一条路"慢慢"断掉，过期重算只是兜底（2026-09-15 W35S7 → W37S5 只能穿 SK 房，援建矿工原地寻路 18 小时）
        routeCacheTicks: 1000 },
    // spawn 请求队列（src/spawn_queue.js，设计见 docs/superpowers/specs/2026-09-04-spawn-queue-design.md）：
    // classes 优先级数值越小越先；grace 是每类请求从首次出现起最多为满配等待的 tick 数，超过就按现有能量缩身；
    // minShare：收入 > 0 时缩身至少要有容量的这个份额（别孵出 200 的 hauler），收入 = 0（hauler/矿工全灭）有多少用多少；
    // 收入用 spawn 能量正增量的 EMA 估计（incomeAlpha），样本不足 incomeSamples 时按每源 fallbackIncomePerSource/tick
    spawnQueue: {
        // remoteMaintain：容器已建成的外矿的矿工/reserver/hauler 替补——每个源 5–10 能量/tick 的收入，排在发展档（第 2/3 只 hauler、builder）
        // 与援建之前：线上两个母房 400 tick 里只孵发展档和援建，8 个外矿的替补等了 278–657 tick，reserver 全部到期、源全掉回 1500 档
        // expansion（claimer + pioneer）是一次性、有占领窗口的投资，排在外矿维护之前（私服 brain 场景：排后面时 claimer 来不及占房）
        // conquest 排在 defense/survival 核心之后、其余一切（扩张/外矿/发展/援建）之前：开战时母房只保自身生存核心与防御，其余孵化全让给攻城
        classes: { defense: 0, survival: 1, conquest: 2, expansion: 3, remoteMaintain: 4, development: 5, aid: 6, remote: 7, opportunistic: 8 },
        // survival 只等 30 tick：源没人挖每 tick 都在损失产出，容量 ≥800 时按当前能量缩身比等满配划算（低容量房 25 tick 内就能攒够，仍会等）
        grace: { defense: 0, survival: 30, expansion: 300, remoteMaintain: 60, conquest: 300, development: 150, aid: 300, remote: 300 },
        // spawn 全忙时，编制推导只服务于遥测（mem.demand 只被监控与探针读）：按房错峰每这么多 tick 刷一次。
        // 上线后的 cpuBy 实测 spawn 单项 30.4 CPU/tick（10 个房 × 每 tick 全套推导），这是其中的主体；1 = 关闭降频
        busyDemandInterval: 7,
        // spawn 有空闲但上一次全量推导什么请求都没有（安静房）时，按房错峰每这么多 tick 才再全量推导一次（spawn.run）。
        // 线上 2026-10-03 spawn 单项均值 42.6/131 CPU，13 个房里 10 个是这个形态；孵化需求的出现靠 creep 到期，提前量都是百 tick 级，
        // 延后几个 tick 无损；恢复期/无在岗工人/房里有敌人不降频。1 = 关闭
        quietDemandInterval: 10,
        waitingDemandInterval: 5,
        starvedStorage: 2000,       // storage 能量低于它算缺能量房：等能量的全量推导间隔拉长到 min(队头 ETA, starvedWaitInterval)
        starvedWaitInterval: 25,   // 队头等能量期间的全量推导间隔（spawn.runQueue）
        minShare: 0.5,
        // 10-16：storage 能量 ≥ 它且没有 builder 时，第 1 只 builder 排在外矿维护（remoteMaintain）前面；0 = 关
        richBuilderStorage: 20000,
        // 自带分档身体（bodyFor）的需求（外矿/援建/开荒）缩身下限改按理想身体成本的份额：1600 容量下 650 的 1 CLAIM 档不被容量一半（800）卡住，
        // 但也不再孵 200–500 的外矿 hauler（线上 W33S6 一只 1 CARRY 的 hauler 占着 19 CARRY 的槽位 1285 tick，9.8/tick 的产出运回不到 1）
        minCostShare: 0.5,
        // 外矿槽位换代：在岗身体的吞吐比理想身体少的部分 × 剩余可用 tick ≥ upgradePayback × 理想身体成本时，能量买得起就孵理想身体替换它
        // （opportunistic，从不等待也不挡人）；旧 creep 等替换者进了外矿房再退役，最多等 upgradeHandover tick
        upgradePayback: 2,
        upgradeHandover: 200,
        // 收入 EMA 的 alpha 与信任门槛：到货是一车一车的（hauler 一趟 400），alpha 0.05 时一车到货 EMA 跳到 20、60 tick 没到货掉到 <1 被当 0，
        // 缩身下限在容量一半与 0 之间翻转（线上 2026-09-06 W33S8：一会儿死等 650、一会儿孵 150 的小身体）；0.01（时间常数 100 tick）下一车只抬 4、
        // 每 tick 衰 1%，间歇到货的估计稳定在均值附近。EMA 从 0 起按 alpha 收敛，样本不足 incomeSamples（≥ 一个时间常数）时按每源 fallback，冷启动不当紧急态
        incomeAlpha: 0.01,
        incomeSamples: 200,
        fallbackIncomePerSource: 5,
        // 收入不到 minIncome/tick 视为 0（紧急态）：EMA 衰减永远不会精确归零，spawn 自产的零头也会留残值，而缩身下限只看"收入 > 0"
        // （RCL 基准：W31S8 丢容器后 EMA 0.1–1，hauler 1800 按容量一半 900 等了 12 万 tick，W33S8/W35S7 同链卡 600 的矿工 / 1250 的升级者）
        minIncome: 1,
        // 生存档请求等了这么久还买不起：不管收入估计，按现有能量孵最小可用身体（hauler [CARRY,MOVE]、矿工 [WORK,CARRY,MOVE]），换代扫描之后再换大
        survivalShrinkAfter: 300,
        // 核心角色（矿工/hauler）距离到期提前量只剩 ≤ 攒够理想身体所需 tick + reserveMargin 时，先把这笔能量预留住并挡住外矿类请求
        reserveMargin: 20,
        // 替补预留最早提前多少 tick 开始（在 reserveMargin 之外）：预留是 vital、会挡住整条队列，低收入房不封顶会冻几百 tick
        reserveMaxLead: 150,
    },
    // hauler 给工地上的 builder 送能量：builder 能量低于容量×builderFeedBelow 时登记投递需求；空载后在工地最多等 builderFeedWait tick
    builderFeedBelow: 0.5,
    builderFeedWait: 30,
    // 无 storage 且容量 < builderSpawnFirstBelow 的房：spawn/ext 未满时 builder 不抢源容器，在工地等投递，最多等 builderFeedMaxWait tick；
    // 房里有闲置能量（见 energySurplus）时不等，自己去取（线上 W33S8：11 个 WORK 的 builder 全 0 能量等了 146 tick，远处源容器 1952、地上 2507）
    builderSpawnFirstBelow: 800,
    builderFeedMaxWait: 50,
    // 取能点（最近的容器/storage/收货 link）就在这么近时，builder 不等 hauler 投递、自己去取：
    // 等投递的上限是 50 tick，走 8 格只要 8 tick。线上 W33S7 的 builder 在工地上空等 50 tick，而 5 格外的 storage
    // 与控制器 link 里都有能量（link 常年 800/800），结果两个 6-WORK builder 只产出约 1 进度/tick。
    builderSelfFetchRange: 8,
    // 房里能量闲置的判定：某个源容器 ≥ containerShare 满，或地上掉落能量 ≥ dropped。闲置时 builder 可自取（含 ≥ ctrlShare 满的控制器容器）、
    // builder 上限 +extraBuilders（线上 W35S7：源容器 2000/2000、地上 5605，2 只 1 WORK 的 builder 对着 5 个 0 进度的 extension 工地，3 只 hauler 满载停着）
    energySurplus: { containerShare: 0.9, dropped: 1000, ctrlShare: 0.75, extraBuilders: 1 },
    // 布局与站点
    // 轮子布局（vendor/wheels/layout-2.1.0）是唯一的规划来源：bucket ≥ bucket 时在游戏内跑一次，失败 retryTicks 后重试
    wheel: { bucket: 5000, retryTicks: 5000 },
    // 拆迁调度（demolition.js）：与轮子方案冲突的工地/建筑在合适时机拆除；每房每 interval tick 最多拆 1 个
    // batch：同类替代工地允许同时在建的数量（extension 等按批替换，而不是拆一个等建成再拆下一个）
    // keepStoredBelow：storage/terminal 里还有超过这么多资源就不拆（拆除不可逆，而方案位早晚会腾出来）
    demolition: { interval: 25, minEnergy: 300, logSize: 20, batch: 4, keepStoredBelow: 0 },
    // 规划来自轮子且是确定的：工地尽量积极放，builder 按 broker 权重逐个建。上限是每玩家 100（所有房 + 外矿 + 扩张共用），
    // 母房只用到 100 − globalSiteReserve，其余留给外矿容器/道路（remote.js 在 ≥100 时停放）和新房 spawn 工地（expansion.js 不检查 ERR_FULL）
    maxSites: 40,
    globalSiteReserve: 12,
    // 每房保底：全局名额（含预留）被外矿路/别的房占满时，本房仍可放到这么多（引擎的 100 上限仍在，放不下就 ERR_FULL）。
    // 基准 88fe9e7 的各房工地序列（data/soak/rcl-bench-88fe9e7/sites_by_room.csv）：健康房开工峰值 29–32、建完归 0，保底 10 足够让 extension/塔先放出来
    siteFloorPerRoom: 10,
    // 全局最后 remoteContainerSiteReserve 个名额只给外矿容器工地：母房保底与外矿路工地都停在 100 − reserve。线上 2026-09-06 W32S8 容器烂掉后，
    // 全账号被四个新房的路工地占到 99–100，remote.js 撤路腾出的名额在下一轮 infraTick（11 tick）前就被"每房保底"的房抢走，撤了 5 条路仍放不出容器
    remoteContainerSiteReserve: 2,
    // 母房路工地要等 RCL：路网数十格、sitePace.roads 允许 24 个同时在建，而 RCL1–2 的新房只有 pioneer/builder 在建 spawn 与 extension，
    // 建不动路。线上 2026-09-06 全账号 100 个名额里 75 个是零进度的路，光 W33S3、W31S5 两个 RCL2 新房就占 48 条，
    // 把外矿容器工地（W32S8）挤了几千 tick。RCL3 起路网才有 hauler 往返量去摊销
    roadsMinRcl: 3,
    // 死房：连续 afterTicks 没有 builder/pioneer 的房不再放新工地，已有工地裁到 keep 个（spawn 与核心容器工地永远保留，其余按进度高的留）。
    // 基准里两个死房各挂 27–30 个没人建的工地 + 外矿路 30 个 ≥ 88 = 100 − 预留，健康房从 140k 起 24 万 tick 放不出一个工地（RCL6 → 7 花了 215k tick）
    deadRoom: { afterTicks: 1500, keep: 5 },
    // 每轮最多新放 / 同时在建的低价值工地数。道路可通行不挡路、每格最多 1500 进度，放宽到 24；
    // extension/lab 等不可通行的工地会被移动轮子当障碍（255），仍只按 RCL 配额放
    sitePace: { roads: 24, ramparts: 6, walls: 2, containers: 2 },
    rampartTowerEnergy: 500,   // 有塔且塔能量 ≥ 此值才放新 rampart 工地：rampart 建成只花 1 能量，之后从 1 血衰减、全靠塔维修，是维修负担不是建造负担
    // min-cut 外环（轮子的 plan.ramparts 全是裸地：W33S7 84 格贴房间边、W34S7 31、W33S8 45）推迟到此 RCL 才放工地，之前只给 spawn/塔/storage/terminal 盖 rampart，
    // 低于此 RCL 时零进度的外环工地由 trimSites 清掉。依据（docs/observe/kalgen-learnings.md）：Kalgen 89 房 2503 个 rampart 里 1570 个压在建筑上，
    // shard3 三房没有一格裸地 rampart；我方 RCL5 外环 84 格 × 每 100 tick 衰减 300 = 每 tick 252 血，塔在射程 ≥20 每 10 能量只修 200 血 ≈ 每 tick 12 能量的固定维护，
    // 且 2026-09-04 线上 47 个零进度外环工地占着全局 100 名额（三房共 78 个工地）
    rampartRingMinRcl: 6,
    // 外环还要过收入门槛：铺完之后的维护是**永久**支出，而收入养不起时半圈 rampart 挡不住人却要付全额维护。
    // 84 格 × 3 血/tick = 252 血/tick；塔在射程 20 外只有 20 血/能量 ⇒ 12.6 能量/tick（builder 100 血/能量只要
    // 2.5 能量/tick，但塔会抢在 builder 之前去修比例最低的那格——外环刚建成时比值 0.001%，塔会一直填）。
    // 按最坏情况（塔修）留 25% 收入：50/tick。低于门槛时 trimSites 清掉零进度的外环工地（有进度的保留），
    // 收入上来再重铺；线上 2026-09-09 W33S7 收入 8–30/tick 波动，30 万/格的目标下 84 格要 25 万能量，远超整房收入。
    rampartRingMinIncome: 50,
    layoutInterval: 11,   // 每隔多少 tick 尝试放工地
    planTtl: 5000,        // 布局方案有效期
    // tower
    towerRepairBelow: 0.6, // 结构血量低于最大值的比例才修
    // 危急水位（utils.criticallyDamaged）：方案内非 rampart 结构低于维修目标的这个比例时，即使塔有能量也放行一只维修 builder。
    // 下面 hasBuilderWork 的"有塔就不为维修孵 builder"守卫管的是日常维修（那是对的：曾为一个掉血容器花 1300 孵整只 builder），
    // 但它管不了深坑——线上 2026-09-07 W35S7 两个源容器 14.3k/25 万 = 5.7%，塔净回填 2.9 血/tick、填满要约 9.3 万 tick ≈ 4 天，
    // 而离归零只剩 1434 tick；creep 修 100 血/能量，塔在 ≥20 格只有 20 血/能量，远端维修 builder 便宜 5 倍。
    // 0.2 只在真正的深坑触发（当时全账号只有 W34S7 src1 11%、W35S7 两个 5.7% 命中，其余房最低 53%）
    criticalRepairShare: 0.2,
    // link：发送方攒到这个数就传
    linkSendAt: 700,
    linkKeepAt: 400,
    // 10-16 战略猫：storage 超过 reverseCtrlFeedAbove 的部分经 store link 反向送给 ctrl link（冲 RCL8）；底线留给救急发送
    reverseCtrlFeedAbove: 30000,
    // builder 可以从控制器/仓库 link 借能，但只在 link 存量 ≥ linkKeepAt + 这个余量时（缓冲留给升级者）。
    // RCL6 没有 store link 时，升级者吃不满的源收入会全部堵在 link 里：线上 W33S7 三座 link 常年 800/800，
    // 而 builder 走 20 格去源容器取 170 能量——那部分能量只有升级者能动，而升级者只要 10/tick。
    linkDrawMargin: 250,
    // 建造者无工地时的兜底：storage 高于此值才转升级
    builderUpgradeAbove: 30000,
    // construction backlog 调度：以一个 source 再生周期为目标窗口，
    // 高价值结构优先，路/墙只作为很弱的建设需求。
    construction: {
        // 无 storage 的房把 storage 工地排在道路前（builder 工地顺序与 broker 建造权重）：RCL4-5 的 storage 是 link 经济、升级站位与
        // hauler 效率的前提，线上 W33S7 的 storage 工地被 3 条规划道路压了一天多（10834/30000 不动）；其它结构仍在道路之后
        storageBeforeRoads: true,
        // layout 把一次性的 storage/terminal 工地放在道路与 extension 之前（extension 还缺时给它留 1 个名额；lab/factory 等仍走下面的奢侈门槛）。
        // 依据：0→RCL8 基准 t=1.16M、六房 RCL7 时全账号 terminal 0 座——terminal 在 RCL6 解锁的那一刻 extension 上限也 +10，
        // 道路 + 新 extension 把名额吃光，terminal 要等 extension 全建完才排得上（overmind-absorb 55183d1/924a8c8；
        // A/B round10：CP 持平、按正确性保留）。false 退回旧顺序（塔之后才放 storage/terminal）
        oneOffBeforeRoads: true,
        // 奢侈建筑（lab/factory/nuker/powerSpawn，utils.luxuryStructure；terminal 不受门槛约束）的经济门槛：storage 能量低于它时不放新工地、
        // builder 不建、不计入 builder 编制。这些建筑在当前代码里没有产出（工业要 storage ≥ 10 万才动用），
        // 线上 W33S7 在 storage 0 时把升级限流让出的能量全灌进了 terminal
        luxuryStorageAbove: 10000,
        // 10-16 战略：W29S3 storage < 3 万时 lab 工地停建（保留不拆）、builder 上限 1（只修路/维护）；回到 3 万自动恢复
        luxuryStorageAboveByRoom: {},
        // 10-16 战略（18:00 拍板）：W29S3 改为 terminal 建成后才恢复 lab（之前是 storage ≥ 3 万）；在此之前 lab 不放不建、builder ≤ 1
        luxuryAfterTerminal: ['W29S3'],
        // 10-16 战略：RCL8 后先不建 nuker / power spawn（第 3 阶段之前）
        deferNuker: true,
        deferPowerSpawn: true,
        // RCL8 建造顺序：extension → 第 3 spawn → lab→10 → tower→6（layout.js 按此错峰）
        rcl8BuildOrder: true,
        // storage 低于此值不建 terminal（10 万进度会抽干升级口粮；W29S3 73k 时工地 0 进度）
        terminalMinStorage: 100000,   // 10-17 10:26 战略：120000 → 100000
        // 塔射程外的维修债（血）低于它时不为维修孵 builder（spawn.hasBuilderWork）：约 100 能量的活不值一只 builder 的摊销
        outOfReachMinDebt: 10000,
        horizon: 300,
        incomeShare: 0.6,     // 收入中可用于建设的份额，决定 builder WORK 上限
        buildDuty: 0.5,       // builder 真正在建造的 tick 比例（其余在取能/往返）
        remoteIncomeFactor: 0.8,   // 有矿工在岗的外矿源按 10×此系数 计入建设收入
        progressPerWork: 5,
        utilization: 0.8,
        maxBuilders: { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8, 8: 8 },
        weights: {
            container: 1,
            extension: 1.1,
            spawn: 1.3,
            tower: 1.2,
            storage: 1.1,
            link: 1,
            terminal: 1.1,
            lab: 0.8,
            observer: 0.6,
            powerSpawn: 0.6,
            nuker: 0.5,
            factory: 0.5,
            road: 0.03,
            rampart: 0.05,
            constructedWall: 0.01,
        },
    },
    // upgrader 供能容器低于此比例时 hauler 优先补
    upgraderFillBelow: 0.8,
    // 控制器容器公平供给：容器低于 starvedBelow 且 spawn 能量 ≥ spawnShare 时，hauler 这一趟先送控制器（否则 spawn 持续忙碌时控制器几百 tick 断粮）
    controllerFeedStarvedBelow: 0.1,
    controllerFeedSpawnShare: 0.5,
    // 升级者由 storage 供能（storage 已建成且有与 storage 相邻、控制器射程 3 内的站位，见 layout.upgraderStorageStations）时不再喂控制器容器：
    // storage 能量低于实际地板（见下面的 controllerFeedStorageBand，不是 controllerFeedStorageFloor 本身）时 hauler 按第三层补，
    // 低于 controllerFeedStorageStarved 且 spawn 能量过半时先送（与容器的公平规则同义）。
    // 依据（docs/observe/kalgen-learnings.md 第 1 条）：Kalgen 89 房 storage→controller 全在 2–4 格，升级者静止在 storage 旁直接取能，全账号没有控制器容器和控制器 link。
    // W33S7 的候选格 (32,26)/(31,25)/(31,27) 都是规划道路，站上去挡一格路但省掉每趟 hauler 的控制器段；W34S7 的 storage 离控制器 5 格，没有候选格，照旧走容器/link
    // 升级者顺手维修自己的站位容器：容器每 500 tick 衰减 5000 血，补满只要 50 能量（1 能量 100 血），
    // 11 WORK 的升级者每 110 tick 花掉 1 tick 就够（约 1% 升级吞吐）——比为维修多养一只 builder（1300 能量 / 1500 tick）便宜得多。
    // 线上 2026-09-07 02:00 时间序列：有空闲 builder 的房在回升（W34S7 79k→84k、W35S7 17k→18k），
    // 没有 builder 的 W33S7（无工地所以 builderTarget 0）与 builder 忙于工地的房一路下跌（W33S7 145k→140k、W31S6 140k→135k），
    // W35S7 三个容器只剩 250k 上限的 7%。低于这个比例就顺手修一 tick
    upgraderRepairStationBelow: 0.9,
    controllerFeedStorageFloor: 2000,
    // 补给地板与升级者取用底线（upgrading.reserve）之间必须留出的工作带：实际地板 = max(floor, reserve + band)。
    // 两者相等时 storage 停在底线上、升级者可取 0，房间升级速率归零（线上 2026-09-07 W31S6 0.00、W31S8 1.62 prog/tick）。
    // 1000 ≈ 一车 hauler 的载量，够 10 WORK 的升级者烧 100 tick，期间第三层投递能补上下一车
    controllerFeedStorageBand: 1000,
    controllerFeedStorageStarved: 500,
    // tower 缺口达到此值才派 hauler 补能（无敌人时）；小缺口留给它自然攒，避免 hauler 为 10 能量跑一趟
    towerRefillAt: 300,
    // 维修预算：塔的能量低于 towerRepairReserve + 这个数、且房里确实有东西要修时，补能从第 4 层（权重 2）提到第 3 层，
    // 权重 towerMaintenanceWeight。否则维修会被升级完全抢占：塔一次动作修 800 血、500 能量能修 4 万血（8 个容器的完整衰减周期），
    // 但它停在储备线上就一次也修不动（tower.js 要求 energy − 10 ≥ towerRepairReserve），而补能任务权重 2 在
    // "控制器容器见底 ⇒ 第 1 层权重 20" 的房里永远轮不到。线上 2026-09-07：全部 10 个塔停在 500–543，
    // 源容器全账号衰减（W35S7 src1 3k、约 300 tick 后消失，W31S4 已有两个容器死掉在重建，每个重建 5000 能量）
    towerMaintenanceBudget: 400,
    towerMaintenanceWeight: 5,
    // 危急结构在塔的射程内时，塔的维修补能提到第 1 层（权重 11 > spawn 的 10）：塔一次动作修 800 血、只花 10 能量，
    // 而"会消失的"容器/道路重建要 300–5000 能量。射程按 TOWER_FALLOFF_RANGE（20）——射程外补了也修不到
    // （线上 2026-09-09 W33S7 两座塔在 (6,40)/(7,41)，大多数道路在房间另一侧）
    towerCriticalRange: 20,
    // 塔的维修储备：能量低于它塔不再维修（留给防御），hauler 也只在低于它（或有敌人）时把塔当第 2 层"大缺口"补；
    // 高于它的缺口是维修消耗，排在控制器容器之后（第 4 层）——线上 W34S7 的塔整天停在 620–690，每趟 hauler 的零头都先喂塔，
    // 控制器容器只靠"见底"公平规则偶尔拿到一车，两只 11 WORK 的升级者只有 9/tick
    // 低于这条线（或房里有敌人）的塔补能是第 1 层、权重高于 spawn/ext：spawn 持续孵化时 spawn/ext 永远有缺口，塔打完入侵者剩 11 能量
    // 会几百 tick 没人补（2026-09-06 W34S7）；高于这条线的缺口只是维修消耗，退到第 4 层
    towerRepairReserve: 500,
    // storage 回库任务（第 4 层）的 backlog 上限：storage 建成时空位 100 万，会把 Memory.taskBroker 的 backlog 遥测撑到 1e6、
    // 并让 ln(backlog) 评分压过同层的工地 builder 补能（线上 2026-09-05 W34S7 storage 建成瞬间 backlog 6368 → 1,008,832）
    storageDeliverBacklogCap: 10000,
    // upgrader 规模：controller 供能容器存量的 EMA 持续偏高（供给 > 消耗）且房间能量满时加一个 upgrader，
    // 持续偏低则退回底线（不主动杀，只是不再补员）；每次调整间隔 changeInterval tick 以免抖动
    upgrading: {
        alpha: 0.02,
        raiseAbove: 0.7,
        lowerBelow: 0.15,
        changeInterval: 300,
        // RCL3 上限 4：3 个 6W upgrader（18 WORK）略低于采集 20 减孵化，换代空档下产出会堆在源头衰减；第 4 个由 EMA 按富余决定
        // RCL2 上限 4：5 个 extension 建完后房间只剩道路可建，20/tick 的产出只有 1 只 3W upgrader 在消化（W34S7 容器满溢、地上堆 3.8k）；
        // 4 只 3W = 12/tick 仍低于 20 减孵化，多出的由 EMA 按容器存量加减
        maxUpgraders: { 1: 1, 2: 4, 3: 4, 4: 3, 5: 2, 6: 2, 7: 2, 8: 1 },
        // storage 富余（≥ storageFeedAbove 进入，滞回到 < storageFeedBelow 才退出，utils.storageRichState）要花在升级上：RCL 基准两轮 A/B 都看到
        // 弱房 storage 攒到 9–12 万却只升 2–6 CP/tick——hauler 取货源容器优先、投递又先喂 spawn/ext，控制器容器长期喂不饱，能量只进 storage 不出。
        // 富余时：控制器容器投递提到第 1 层（权重 9 < spawn 10）、升级者上限用 maxUpgradersRich、hauler 编制按 storageFeedRate 的搬运量加项；
        // storage 取货在容器供能房只是源容器/掉落都没得取时的兜底（权重 6 < 源容器 7）——2026-09-06 A/B（docs/benchmarks/2026-09-06-storage-ab.md）：
        // 取货 storage 压过源容器（8 > 7）把 hauler 从源容器抽走，矿工溢出到地上衰减（W33S8 掉落均值 2.3k → 4.2k），总 CP −5%；升级者数量也不再按
        // storage 水位配（配了没人喂：44–48 WORK 只升 3.6–6/tick），只按控制器容器实际到货的 EMA。link 供能房（线上 W33S7）例外：storage → 控制器 link
        // 是几格短途，取货权重仍 8，实测 10 → 16 CP/tick。无滞回时 storage 在 2 万上下抖动、只花掉增量（A/B 两房最后 2 万 tick 停在 19.0–19.2k）
        // A/B 分支（ab/storage-feed-8000，不合并进 main）：把富余门槛从 20000/10000 降到 8000/4000，保持 2:1 滞回比。
        // 依据：无外矿的房（线上 W35S7、基准 W33S8）收入只有自采 20/tick，storage 常年停在 14–15k、够不到 2 万的门，
        // 于是没有 feeder、没有 storage → 控制器回流，升级者只被喂饱约 37%，能量在仓里趴着。screeps-9e 的五个分叉里
        // "storage ≥ 2 万"的采样占比只有 0–3%，控制器容器均值 17–238（基本是空的）。由 A/B 判决是否并入 main
        storageFeedAbove: 30000,   // 10-16 战略猫：≥3 万开、<1.5 万关（原 8000/4000 让中等库存的房一直 rich，W29S3 10k 仍在花 storage）
        storageFeedBelow: 15000,
        // 专职短途搬运工（roles/feeder.js，spawn.feederTarget）：storage 富余（滞回状态开）且控制器由容器供能、storage 到控制器容器 ≤ feederMaxDistance 格时
        // 出 feeders 只，只跑 storage ↔ 控制器容器；富余关闭就退役回收。第 2 轮 A/B（docs/benchmarks/2026-09-06-storage-ab-round2.md）：兜底取货修正后
        // 总 CP +3.8%，但 W33S8 两源离 storage 23/31 格、hauler 永远有源容器可取，"都没得取才取 storage"一次也轮不到，storage 攒到 17 万、控制器容器
        // 均值 147；storage → 控制器容器只有 6 格，4C/2M ≈ 16/tick，成本 300/1500 tick。feederRate：按这个搬运量配 CARRY（每 50 能量 1 CARRY，按往返格数）
        // feederMinCarry：预算不够 4 CARRY 就不孵（返回空身体让队列等）——私服里队列按现有能量缩身孵出过 2C1M 的 feeder，700 tick 只搬了 900
        feeders: 1, feederMaxDistance: 15, feederRate: 20, feederMinCarry: 4,
        storageFeedRate: 20,
        maxUpgradersRich: { 1: 1, 2: 4, 3: 4, 4: 4, 5: 3, 6: 3, 7: 3, 8: 1 },
        // 无 terminal 的囤能房强制按富余上限孵 upgrader（10-16 W29S3 已移出：外矿全开攒 storage，不再硬冲 RCL7）
        forceRichUpgraders: [],
        // 升级者由 storage 供能时没有容器可看：EMA 改用 storage 能量 / storageFullAt（30k 与 builderUpgradeAbove 同口径，视为"有富余"）
        storageFullAt: 30000,
        // storage 分档（向 Kalgen 学，docs/observe/kalgen-learnings.md 第 3 条：他在 storage 低于 ~1.7e5 时把 RCL8 升级者换成 W1 保级，
        // RCL7 冲级房则用 8 只 W45/W47 直接从 storage 取能）。只对"升级者由 storage 供能"的房生效：
        // storage < lowBelow 进入低档，≥ lowExitAbove 才退出（滞回防换代抖动）；低档只孵 lowBudget 的小身体、不加员；
        // 升级者从 storage 取能只取到 reserve 以上（缓冲要留给 spawn 爆发补员和建造）；
        // 满身体在 RCL8 以下不再封顶 15 WORK（15/tick 只是 RCL8 的引擎上限）：RCL6 得 W21C2M1，RCL7 得 W47C2M1（Kalgen 的 eswithdrawUpgrader）
        // 10-16：storage+terminal < poorBelow 时 upgrader 身体能量上限 = 容量 × poorBudgetShare（穷房别孵 2150）
        poorBelow: 10000,
        poorBudgetShare: 0.5,
        lowBelow: 5000,
        lowExitAbove: 10000,
        lowBudget: 550,
        reserve: 2000,
        // 控制器最多吃本地供给（每口源 10/tick）的这个份额，其余留给搬运/维修/建造。只在能量吃紧（storage < lowBelow）时生效，
        // 富房照常吃满。依据（线上 W33S7 2026-09-10，link 供能、2 源 = 20/tick）：W20C2M1 的升级者把本地收入 100% 吃光，
        // storage 掉到 13、源容器 0/10/0、两只 hauler 空手挂机、builder 走 13 格刮 56 能量、24 个路工地 0 进度；
        // 降额后 link 链堵满，矿工的"link 满了送容器"兜底生效，房间其余部分才有能量（0.6 → 12/tick 给控制器、8/tick 给房间）
        incomeShare: 0.6,
        // 限流只在有竞争需求时生效（utils.upgradeCompeting）：想建的工地、够量的维修债、spawn 在攒能量，或 spawn/ext 连续
        // competeUnfullTicks tick 没补满；最近一次看到需求后 competeHoldTicks 内仍限流（防止放开 → 升级者吃空 → 又限流的来回抖）。
        // 线上 W34S7/W35S7：storage 0/2–3k 在低档停了两万 tick，但 backlog 0、维修债 0、spawn 空闲能量满，限流让出的能量没人要，
        // 上线后进度 12.3→9.5、13.5→10.9 CP/tick
        // 10-16 战略：攒能房的升级者恒吃本地收入的这个份额（utils.bankingWorkCap），其余攒进 storage（W29S3 攒 12 万建 terminal）
        bankRooms: { W29S3: 0.6, W33S8: 0.6, W31S5: 0.6, W32S4: 0.6 },   // 10-17 07:00 战略：W32S4 升级者为主要耗能（20 WORK=20/tick），攒能档让升级封顶本地源供给×0.6（~12 WORK），其余进 storage
        competeUnfullTicks: 100,
        // 低于容量的这个份额才算"没补满"（W34S7 部署后停在 1756/1800、spawn 空闲无请求，照样被 unfull 限流）
        competeUnfullShare: 0.8,
        competeHoldTicks: 300,
        // 卡死看门狗（roles/upgrader.stuckWatchdog）：在母房、离控制器 > 3 格、没有疲劳却原地不动的升级者，连续 stuckRepathTicks tick
        // 就让移动库重算本房路径（一次），连续 stuckRetireTicks tick 就退役（贴着 spawn 直接回收，否则走去回收/走不了就 suicide），
        // 编制计数立刻排除它、替补马上出。线上 2026-10-08 W31S4：慧音甲 困在出生口袋里空手站了 600+ tick，占着唯一的升级者名额，
        // 两只 spawn 空闲 5600 能量却不补人。疲劳 > 0 或位置变了就重新计时（47W 1 MOVE 空载走平地每格 47 tick，有疲劳说明在走）；
        // 300 tick 长于源的再生周期：在空源旁等再生的升级者不会被误杀，而站 300 tick 不动的升级者本来就没有产出
        stuckRepathTicks: 50,
        stuckRetireTicks: 300,
        // 看门狗退避：控制器真的够不着（被墙/建筑围死、站位全被占）时，孵 → 卡 300 tick → 退役 → 再孵是一个没有尽头的循环，
        // 每圈白花一只升级者的身体。连续 stuckBackoffAfter 次退役之间控制器都没有任何进度（等级/progress 不变、RCL8 看降级时间没被推后），
        // 就在 stuckBackoffTicks 内不再退役（卡住的那只留着，编制不出替补），遥测 upgraderStuck.backoffUntil/backoffs/held 给 monitor 与人看。
        // 3 次 ≈ 3 ×（300 卡死 + 孵化/走路）≥ 1000 tick 零进度，不是一时堵路；1500 = 一只 creep 的寿命：退避期间最多一圈，而不是每 ~350 tick 一圈
        stuckBackoffAfter: 3,
        stuckBackoffTicks: 1500,
        // 升级者总 WORK 按可持续供给封顶（utils.upgraderSupplyWork，只对有自己 storage 的房）：本地供给（每口源 10/tick）
        // + storage 超过 lowExitAbove 的部分摊到 storageDrainTicks（一只升级者的寿命 1500）里花完。身体（spawn.upgraderBody 的 maxWork）、
        // 编制（upgraderTarget 的 capCount、coreRequests 的在编 WORK 闸）都按它，不再跟着"有没有竞争需求"的瞬时限流一会儿 Infinity 一会儿 12。
        // 依据（线上 2026-10-08 13 房快照）：限流一放开就孵 W47C2M1（4850），21 只升级者 731 WORK、养身体 51.5 能量/tick，
        // 全账号只升 186 CP/tick——CP 被 ctrl link 的 20/tick 卡死（upgrade.supply=20），留着 20W 身体的 W37S7/W33S7 一样升 17–20 CP/tick；
        // 4850 的大身体一孵就把 5600 容量的房掏到 80% 以下 100+ tick，又触发 unfull 限流，W38S7 4 只 W47 的 duty 只有 0.064。
        // storage 攒起来（收入 > 本地供给时，外矿收入进 storage）封顶自动抬高：storage 4 万 → +20 WORK
        storageDrainTicks: 1500,
        // 升级者换代（spawn.bodyUpgradeCandidates）只在现有身体的 WORK 不到方案身体的这个份额时才做：W12 → W20 这种小差距等自然换代，
        // 不为它提前回收、多占一次 spawn（旧规则下限流一开一关，W12/W20/W47 来回换）；W4 的低档小身体 → W20 照常换
        upgradeWorkShare: 0.5,
    },
    // 后期服务只在储备充足时运行，避免 terminal/lab/factory/power 抽走升级能量
    industry: {
        storageReserve: 100000,
        terminalReserve: 10000,
        // hauler 往 terminal 补能的目标水位（task_broker 第 4 层、权重 0.5，移植 overmind-absorb e4cae2f）：要高于 terminalReserve，
        // 否则 canSpend 门槛正好卡在补给线上、一被取走就锁死消费（supply-floor-vs-draw-reserve 同一类错误）；3 万也够市场传送费与几笔跨房转账
        terminalTarget: 30000,
        // 只有 storage 高于它（且 storageRich 滞回开着）才补，补完 storage 也不低于它：线上 10/14 个房 storage≈0、
        // 富余门槛只有 8000（upgrading.storageFeedAbove），terminal 的能量是工具不是库存，不能从刚攒起来的 storage 里抽走升级的口粮。
        // 5 万 = 终端网络发送方门槛（terminalNetwork.sendAbove 10 万）的一半：够补满 terminal 的房才可能当发送方
        terminalFillStorageAbove: 50000,
        // storage 富余（滞回开着）但跌到它以下时，hauler 把 terminal 里的能量取回来，只留 terminalNetwork.feeReserve（2026-10-13 复审）：
        // 这时 storage+terminal ≤ 3 万 + terminalTarget 3 万 = 6 万，够不着终端网络发送门槛 sendAbove 10 万，canSpend 也要 storage ≥ storageReserve 10 万，
        // terminal 里的能量没有消费方；不取的话要等 storage 跌破 storageFeedBelow 滞回关掉才取，中间 3 万一直锁着。
        // 与补能线 terminalFillStorageAbove 隔开 2 万：补能只动 5 万以上的部分，取回的能量进 storage 也不会立刻又被补进去
        terminalDrainStorageBelow: 30000,
        powerStorageReserve: 300000,
        // ---- 矿物链（industry.labPlan + roles/labTech，移植 overmind-absorb 7f4ab27 / 2d97ab4）----
        // 输入 lab 降到 labMinBatch 以下才补、一次补到 labFill；输出 lab 攒够 labMinBatch 就收回 terminal。
        // 1000 = 一只 20C labTech 一趟的量；500 = 100 次反应（每次 LAB_REACTION_AMOUNT 5），够跑几千 tick，不为零头来回孵
        labMinBatch: 500,
        labFill: 1000,
        // 每房 labTech 数（0 = 关）。canSpend 闸开着（storage ≥ storageReserve、terminal ≥ terminalReserve）且有取送活时才孵，opportunistic 档
        labTechs: 1,
        // labTech 没活干时原地等这么久再退役回收：两批之间的空档通常只有几十 tick，一空就回收会为每一批重孵一只（1500 能量）
        labTechIdleTicks: 100,
        // 想做出来的 boost 化合物，按优先级排；industry 从目标自顶向下拆，找「现在就做得起的那一步」（反应链，Overmind 的 Abathur）。
        // 没有这份清单时 labs 只会「库存里哪两种能反应就做哪种」，产物没有用途。顺序：攻城（拆/治疗）→ 升级 → 移动；
        // 每种攒到 boostGoal 就换下一个——一只 50 部件的 creep 一次最多吃 1500（LAB_BOOST_MINERAL 30 × 50），3000 够两只
        // 2026-10-15 战略猫：升级 boost 优先（排行榜 = GCL），攻城其次
        boostTargets: ['XGH2O'],   // 晴猫 16:22：只做升级链；攻城化合物等第 3 阶段
        // false = 目标链这一步做不了时不做「库存里随便两种能反应」的机会主义反应（以前因此做了 UH）
        labOpportunistic: false,
        // labs 单独的低门槛（反应本身不耗能）：只在 labRooms 里跑、storage 能量 ≥ labStorageReserve、CPU 闸开着（deposit.cpuOk）
        labRooms: ['W32S4', 'W33S3'],
        labStorageReserve: 8000,   // 10-17 03:xx 战略：20000 → 8000，让 W32S4/W33S3 的 lab 恢复（原 20000）
        // lab 房的 upgrader：boost lab 里 XGH2O 够这只的 WORK×30 时先去强化（boost.js），等不到 boostMaxWait 就放弃
        boostUpgraders: true,
        boostGoal: 3000,
        // 目标化合物库存攒够这么多就往 boost lab 装一份（移植 overmind-absorb 019c5b1）；用掉一半再补。
        // 1000 = 一只 50 部件 creep 一次最多吃的 1500 的三分之二，够两三只普通身体
        labBoostStock: 1000,
        // boost lab 的能量水位（task_broker 第 4 层、权重 0.4，只给 boost lab）。反应本身不耗能（引擎 run-reaction 不扣），
        // 但 boostCreep 每部件 20 能量（LAB_BOOST_ENERGY），50 部件一次 1000；2000 是 lab 能量容量上限。
        // 与 terminal 补能同一道闸：storageRich 滞回开着、storage 高于 terminalFillStorageAbove，只动门槛以上那部分
        labEnergyTarget: 2000,
    },
    // 终端网络（src/terminal.js，移植 overmind-absorb 2214dcc）：把能量从富裕的己方房瞬时送到饥饿的己方房。
    // 跨房搬能量原本只有 courier 走路，距离一远几乎不产出；terminal 之间是传送，代价按距离折算（calcTransactionCost）。
    // 保守取值：宁可不发，也不把发送方掏空。发送方还要 storageRich 滞回开着（线上 10/14 个房 storage≈0，它们只会是接收方）
    // 过道 deposit 采集（src/deposit.js，2026-10-15 战略猫）：只 silicon/mist、真实跳数 ≤ 3、lastCooldown > 100 收工、产出进 terminal 由 market 卖。
    // 新开工受 CPU 闸（近 10 条均值 ≤ 145、bucket ≥ 3000）；enabled:false 整模块停（在岗的回家交货自毁）
    deposit: {
        enabled: true,
        types: ['silicon', 'mist'],
        maxHops: 3,
        maxCooldown: 100,
        maxActive: 2,
        cpuAvgMax: 145,
        minBucket: 3000,
        // 10-16：Jumpp 常驻采 deposit 的房，放弃直到护矿小队就绪；hostileUntil 过期后也不再分配
        avoidRooms: ['W30S9'],
        // 10-16 战略：近 pvpSkipTicks 内有他人 pvpFlee/pvpThreat 的 deposit 房一律不派
        pvpSkipTicks: 3000,
        // 10-16 战略：眼下只挖 W30S6（Jumpp 南边避让期）；空数组 = 不限制
        allowRooms: ['W30S6'],
        // 选房偏好：北/西优先（护矿前避开南边 S10 高速路邻居）
        preferNorthWest: true,
    },
    terminalNetwork: {
        enabled: true,
        interval: 10,        // 每 10 tick 最多做一笔（terminal 冷却也是 10）
        sendAbove: 100000,   // 发送方的 storage+terminal 能量要高于它
        receiveBelow: 20000, // 接收方要低于它
        keep: 60000,         // 发出后发送方自己仍要高于这个数
        minSend: 5000,       // 太小的单不值得（传送本身要烧能量）
        // 救急（terminal.planStarving，2026-10-15 战略猫）：名单里的房 storage+terminal < starvingBelow 时按顺序先救，
        // 发送方只要 ≥ starveSendAbove（且 storageRich）、发完留 starveKeep，一笔最多 starveMaxSend
        // 10-16 战略：W33S7 冲线时排第一（升到 8 后 planStarving/hoard 自动跳过 RCL8）；
        // 随后能量倾斜 W32S4/W33S8；勿把已 RCL8 的房加进名单
        priorityReceivers: ['W33S7', 'W32S4', 'W33S8', 'W31S8', 'W35S7', 'W34S7', 'W31S5', 'W37S5'],
        starvingBelow: 10000,
        starvingUntil: { W31S8: 20000, W33S7: 25000, W32S4: 25000, W33S8: 25000 },
        starveMinSend: 2000,          // 10-16：starvingUntil 房救急期间单笔下限（平时 minSend 5000）
        senderTerminalExtra: 10000,   // 10-16：发送房 terminal 常备 储备 + 1 万 可发能量（task_broker.senderFillWant）
        senderStorageFloor: 30000,    // 补 terminal 时 storage 不低于 3 万   // 10-16 战略猫：W31S8 排第一、每轮都送，直到 storage+terminal ≥ 2 万（只按 storage 算的话 terminal 送来的能量被直接取用，会无限送）
        starveSendAbove: 30000,  // 10-16：spawn 卡死救急，发完留 starveKeep
        starveKeep: 20000,  // 10-16：救急发完至少留 2 万
        starveMaxSend: 10000,
        // 囤能外送：必须已有 terminal（W29S3 工地还在 0/10 万，观察猫 11:00：改走本房升级）
        hoardFlush: {
            rooms: [],
            sendAbove: 40000,
            keep: 20000,
            maxSend: 10000,
        },
        // 传送费储备（2026-10-15）：这些房的 terminal 常备这么多能量给市场/调剂付传送费。
        // 先由本房 hauler 从 storage 补（storage 高于 feeReserveStorageFloor 时，不看 storageRich）；storage 也没有就排在救急房之后
        // 用同样的发送方规则从别房送；这份储备不算发送方的富余、也不被 hauler 取回 storage
        terminalFeeReserve: { W34S7: 3000, W32S4: 3000, W33S3: 3000, W33S7: 1000, W31S6: 1000, W33S8: 1000, W37S7: 1000, W29S3: 5000 },   // W33S7：L 调剂给 lab 房的传送费（2000 L ≈ 200 能量）   // 15:01 战略猫：自挂单后对方付传送费，储备降到 3k
        feeReserveStorageFloor: 2000,
        maxSend: 50000,
        // terminal 里留给市场传送费的底（src/market.js 的 deal 从 terminal 扣能量）：5000 矿物发到 10 房外约 1500 能量
        feeReserve: 2000,
        // bucket 低于它不做；cpu_shed 降载中（bucket < cpuShed.lowBucket 2000）也不做。跨房均衡不急，3000 = 降载线上方留一段缓冲
        minBucket: 3000,
        // ---- 矿物调剂（移植 overmind-absorb 019c5b1）：一个房只有一种矿脉，反应要两种输入；能量这一轮没有要发的才轮到它 ----
        minerals: ['H', 'O', 'Z', 'K', 'U', 'L', 'X'],   // 只调基础矿：化合物跟着做它的房走
        mineralKeep: 3000,    // 发送方 terminal 里自己留这么多（= market.keep：一次反应批量 / boost 一队的量级）
        mineralWant: 1000,    // 有 lab 的房（terminal+storage+lab）低于它算缺口 = industry.labFill，够装满一个输入 lab
        mineralMaxSend: 2000, // 一笔最多两个 labFill：缺口房一次补够两批，donor 也不被一个房掏空
        mineralLabs: 3,       // 至少这么多 lab 才算缺口房（反应三连的最低数）：没 lab 的房调过去也只是躺着
    },
    // 市场（src/market.js，移植 overmind-absorb 2133dc2/6112d42）：把 terminal 里用不掉的矿物卖成 credit。只吃别人的买单（无手续费、即时成交），不自己挂单。
    // 价格底线取 Game.market.getHistory 近期均价 × priceFloorShare（Overmind 用的是 2018 年硬编码价格表，早已失真），没有成交史就不卖。
    // 只在 storage 富余（storageRich 滞回开）的房卖：传送费从 terminal 的能量里扣，而 terminal 只在 storage 富余时才会被补能
    market: {
        enabled: true,
        interval: 100,          // 每 100 tick 考虑一次（getAllOrders 是 CPU 3 档）
        cacheTicks: 500,        // getHistory 均价缓存多久（成交史按天更新）
        keep: 3000,             // 每种资源在 terminal 里至少留这么多（一次 lab 反应批量 / boost 一队的量级，后续 labs 要用）
        minDeal: 500,           // 太小的单不值得（传送要烧能量）
        maxDeal: 5000,
        priceFloorShare: 0.7,   // 买单价（扣掉传送折价后）不得低于近期均价的这个份额
        historyDays: 5,
        energyPrice: 0.02,      // 把传送烧掉的能量折成 credit 的换算价，用于比较有效价格
        // bucket 低于它不做（cpu_shed 降载中也不做）：一轮最多 maxScans 次 getAllOrders，每次 CPU 3 档
        minBucket: 5000,
        maxScans: 3,
        tickCpuBudget: 5,             // 10-16：市场单 tick CPU 预算（超了停扫）
        // ---- 2026-10-15 P0 护栏（industry_audit.md，战略猫拍板）----
        priceBand: 0.15,              // 只在近 historyDays 天均价 ±15% 内成交（取代 priceFloorShare）
        anyRoom: true,                // 任何有 terminal 的房都卖富余（不再要求 storageRich；传送费仍须 terminal 付得起）
        keepBy: {
            // labs 链（XGH2O）要用的基础矿与中间产物：lab 房留足、中间产物与目标永不卖
            H: 20000, O: 10000, K: 10000, U: 10000, L: 10000, Z: Infinity, X: Infinity,
            ZK: Infinity, UL: Infinity, G: Infinity, GH: Infinity, OH: Infinity, GH2O: Infinity, XGH2O: Infinity,
            ZH2O: 50000,              // 攻城 boost 备用 5 万（战略猫 15:49），其余慢慢卖
            silicon: 0, mist: 0,      // deposit 产出直接卖（不做 wire）
        },
        dailySellUnits: { ZH2O: 5000 },   // 10-17 10:26 战略：2000 → 5000（W34S7 保留 5 万规则不变）
        creditFloor: 2000000,         // 低于它只卖不买
        // 10-17 军事 boost 买入（strongholdLoot，默认关，10:17 拍板）：买现成化合物送进 room 的 terminal，单独记 ledger.militaryCredits，不占日额度
        militaryBoost: {
            enabled: false,
            room: 'W33S3',
            compounds: ['XZH2O', 'XGHO2', 'XLHO2'],
            amountEach: 3000,          // 每种买到的目标库存量
            budgetEach: 500000,        // 每种的 credits 预算上限（累计，记在 ledger.militaryCredits）
        },
        maxOrderCredits: 50000,       // 单笔上限（买卖都按它截量）
        dailyBuyCredits: 150000,      // 每日买入总额（10-15：20 万 → 50 万；10-16 19:00 战略：能量平衡达标前降到 15 万，lab 恢复后调回 50 万）
        // 分资源份额（10-16）：Z 最多 40%（成交快、曾一个人吃光日额度）；O、X 各预留 20%，Z/U 不得挤占
        buyShare: { cap: {}, reserve: {} },   // 10-16 19:00：只买 Z，O/X 预留取消（原 { cap: { Z: 0.4 }, reserve: { O: 0.2, X: 0.2 } }，lab 恢复后调回）
        // 10-17 03:xx 战略：09:00 JST 后不再买 Z，当天实际日买额 0 → 清空 resources/rooms；原配置记入 pauseNotes.market
        pauseNotes: { market: { buy: { resources: ['Z'], rooms: ['W32S4'] }, at: '2026-10-17', reason: '09:00 JST 后停买 Z，当天日买额 0' } },
        buy: { resources: [], target: 3000, orderAmount: 500, rooms: [] },   // 10-17：清空（停买）；原 ['Z'] × ['W32S4']，见 pauseNotes.market   // 只买 labs 链缺的 Z/X，补到 3000
        // 买能量（战略猫 15:49）：只给 terminalNetwork.priorityReceivers 里 storage+terminal < belowEnergy 的房；
        // 到手单价 = 价格×买量 / (买量 − 传送费能量) ≤ maxEffective；计入 dailyBuyCredits。传送费从接收房 terminal 的能量里扣
        // 直接 deal 买能量只在紧急时（storage+terminal < belowEnergy 3000）；平时走自挂买单（ownOrders.energy）
        // 10-16：普通补能仍要求到手价 ≤15（enabled 默认关）；spawnStuckEmergency 给卡死房开例外：按均价±priceBand 买，每天最多 emergencyDailyEnergy，计入 dailyBuyCredits
        buyEnergy: {
            enabled: false,
            maxEffective: 15,
            belowEnergy: 3000,
            maxAmount: 20000,
            spawnStuckEmergency: true,
            emergencyDailyEnergy: 10000,
            emergencyWaitTicks: 200,
            emergencyOutsideDaily: true,   // 10-16 19:00：救急买能量不占 dailyBuyCredits（只受 emergencyDailyEnergy 1 万能量/天约束），日额度压低后不被误杀
        },
        dealBuyMinerals: false,       // Z/X 不再直接 deal（自挂买单代替）
        // 自挂单（战略猫 16:01）：对方成交时付传送能量。价格 = 近 historyDays 天均价（卖/买都夹在 ±priceBand 内），
        // 每单 expireTicks 到期撤单按最新均价重挂；每房每资源一张；5% 挂单费计入 dailyBuyCredits；买单挂单时按全额预占日额度、撤单退回未成交部分
        ownOrders: {
            enabled: true,
            expireTicks: 3000,
            fee: 0.05,
            minBuyAmount: 100,      // 自挂买单的最小量：X 均价 ~440 时单笔 5 万上限只够 113 个，低于 minDeal 500 永远挂不出
            // 卖单挂单费单独一道日额度（ZH2O 2000 × ~2500 × 5% ≈ 25 万，若并进 dailyBuyCredits 20 万会把买单全挤掉或卖单永远挂不出）；
            // 买单的挂单费计入 dailyBuyCredits
            dailySellFeeCredits: 300000,
            sell: [{ resource: 'ZH2O', room: 'W34S7' }],           // 量 = min(富余, 当日剩余 dailySellUnits)
            buyMinerals: true,                                       // 用 buy.resources/buy.rooms/buy.target
            // 10-17 10:26 战略：重挂能量买单。价格跟市场最高买价但 ≤ maxPrice 45；单独日额度 dailyBuyCredits 200 万（不占普通 buyCredits，记 ledger.energyBuyCredits）；
            // credits < creditFloor 500 万停；只给有 terminal 且 storage+terminal 能量 < below 1 万的房
            energy: {
                rooms: ['W34S7', 'W35S7', 'W37S5', 'W31S5', 'W37S7', 'W31S6'],
                below: 10000,
                followHighestBuy: true,
                maxPrice: 45,
                amount: 4500,
                dailyBuyCredits: 2000000,
                creditFloor: 5000000,
            },
        },
    },
    // CPU 预留（bucket 健康时 creep 循环的上限 = limit − cpuReserve，超了只跳 broker 分数 < 20 的单位，与过去一致）
    // 10-16 战略：塔优先（utils.towerFirstHold）——房里有塔能量 < 门槛时 upgrader/builder 不取能、builder 不修路不建（不孵新 builder），
    // hauler/filler 本来就把 < towerRepairReserve 500 的塔排在 spawn/ext 之前（utils.towerUrgent）。全部到门槛自动恢复；去掉这一项即撤销
    towerFirst: { W31S5: 500 },
    // 10-16 战略全局底线（utils.towerFloorHold）：任何房有塔 < 500 时 upgrader 不取能、控制器供能捷径让位给塔；降级 < 5000 tick 例外
    towerFloor: 500,
    // 10-16 战略：terminal 能量底线（task_broker.terminalFloorWant）——storage ≥ 1 万的房 hauler 把 terminal 补到 1000 付传送费，穷房不补
    terminal: { energyFloor: 1000, energyFloorMinStorage: 10000 },
    towerFloorDowngrade: 5000,
    // 10-16 战略：房里有敌对 creep（NPC invader 或带战斗部件的）时该房 spawn 什么都不孵（utils.spawnPausedByHostile），
    // 也不从任何房为它派 defender；敌人走了/死了自动恢复。去掉房名即撤销
    spawn: { pauseWhileHostile: ['W31S5'] },
    cpuReserve: 15,
    // 细粒度 CPU 计时的抽样（main.js 的 cpuRoles / cpuDispatch、spawn.js 的 cpuSpawn）：每只 creep 每 tick 两次 getUsed()，
    // 132 只 ≈ 2.4 CPU/tick（上线实测 creeps 31.5 → 33.9），诊断不该占经济这么多。每 sampleEvery tick 量一次，
    // 均值按实际采样 tick 数还原；30 tick 一条的 Memory.stats 窗口里仍有 6 个样本。
    cpuProfile: {
        sampleEvery: 5,
        // creep 分发的阶段计时（Memory.stats.cpuDispatch）每这么多 tick 量一次（2026-10-13 复审）：阶段链每只 4 次 getUsed、被跳过的也 1 次，
        // 角色计时只要 2 次；~215 只时每次多出 ~3.9 CPU，按 sampleEvery 5 量就是常驻 +0.8 CPU/tick，而账号已经 180/160 超限。
        // 30 = Memory.stats 窗口长度：每条 stats 一个阶段样本（相位 15，不和 sampleStats 的那一 tick 叠在一起）。应取 sampleEvery 的整数倍
        dispatchEvery: 30,
    },
    // bucket 吃紧时的 creep 降载（src/cpu_shed.js）。线上 2026-10-08：13 房 ~215 creep，cpuBy 合计 145–166 > limit 150，
    // 旧护栏让 harvester/hauler/upgrader 一律照跑、其余分数几乎都 ≥ 20，skippedCpu 全房 0，bucket 以 14–23/tick 往 0 掉；
    // bucket 归零后每个超 limit 的 tick 被引擎整个掐断（finally 里的 movement.endTick 都不跑，那一 tick 全体不动）。
    cpuShed: {
        // < lowBucket 进入降载：与 monitor.py 的 cpu_bucket_ok（2000，"付不起尖峰"的线）一致；线上最大尖峰 236（超 limit ~90），
        // 2000 还够 ~20 次尖峰，此时开始把 tick 花销压回 limit 以内
        lowBucket: 2000,
        // < criticalBucket 进入紧急：约 5 次最坏尖峰，再往下随时归零。另外 generatePixel 刚花掉 10000 后 bucket≈0，
        // 也会短暂落在这里——那时用量本来就低于上限，护栏只多做一次排序、不会跳任何 creep
        criticalBucket: 500,
        // 降载时 creep 循环上限 = limit − lowReserve：循环之后还要花 move.end（实测 13.3）+ broker/haul flush（~1）
        // + cpuBy 之外的 Memory 序列化等（由像素产出率反推 ~7）≈ 22，留 3 余量，整 tick 落在 limit 以内
        lowReserve: 25,
        // 紧急时再多留 10：整 tick 约 limit − 10，bucket 每 tick 回 ~10，500 → 2000 约 150 tick
        criticalReserve: 35,
        // 同一只 creep 最多连续被跳 2 tick，第 3 tick 必跑：可跳的单位至少 1/3 的 tick 在动，不会被饿死，
        // 也避免"被跳 → 位置/能量没变 → 看起来空闲 → 再被跳"的自锁
        maxConsecutive: 2,
        // reserver 只有预定 ≥ 这么多（上限 5000）才算富余可跳：跳一 tick 只少一 tick 的预定增量，离掉预定还有几千 tick
        reserverComfort: 3000,
        // tickLimit 硬停（所有模式）：getUsed > tickLimit − endReserve 就不再跑任何 creep（永不跳的也停），收尾照常。
        // 循环之后还要花：move.end 实测 ~15（cpuBy，lowReserve 那条记的是 13.3）+ cpuBy 之外的 Memory 序列化等 ~7–8
        // + broker/haul flush ~1 + sampleStats ≈ 24，留 6 余量。超过 tickLimit 引擎掐掉整个 tick，少跑尾巴几只远比全丢便宜
        endReserve: 30,
        // 离硬停线还有 ≥ hardStopArm 时循环里不逐只读 getUsed：bucket 满时 tickLimit 500、线 470，循环开始时 getUsed 一般 < 100，
        // 而整个 creep 循环线上最大尖峰也就 ~140（整 tick 236）；bucket 见底时 tickLimit 收到 limit（150）、线 120，必然 armed
        hardStopArm: 250,
    },
    // 10-16 战略：模块窗口均值 > ema×factor 时降频跳过（bucket 满时也启用；creeps/spawn/move 永不熔）
    cpuFuse: {
        enabled: true,
        factor: 3,
        emaAlpha: 0.25,
        minEma: 1.0,            // ema 太小不触发，避免噪声
        skipTicks: 20,          // 熔断后跳过这么多 tick
        // 可熔断的 cpuBy 键 → 主循环里对应的跳过点
        modules: ['terminal', 'deposit', 'demolition', 'expansion', 'wheel', 'conquest'],
    },
    // 产 pixel 的 CPU 闸门（main.js pixelGate）：generatePixel 把 bucket 从 10000 一次花到 ≈0，cpu_shed 当场进紧急模式
    // （creep 循环上限 limit − criticalReserve）。线上 2026-10-08 用量 145–166/150 时产 pixel 等于立刻开始跳 creep、也没有缓冲接尖峰。
    pixel: {
        // 均值取 Memory.stats 最近 5 条（30 tick 一条 ≈ 最近 150 tick），一次尖峰拉不动、持续的高用量躲不过
        samples: 5,
        // 至少 3 条样本才放行：刚 respawn/清过 Memory 时没有证据，先把 bucket 留着
        minSamples: 3,
        // 均值 ≤ limit × 0.75（limit 150 → 112.5）才产：≈ 紧急上限 limit − criticalReserve（115），产完 bucket≈0 时 creep 循环
        // 离紧急上限还差 ~25（循环之后的收尾 ~22 已算在整 tick 里），一只都不跳；bucket 每 tick 回 ≥ 37，~14 tick 出紧急、~55 tick 出降载
        // 2026-10-14 暂停产 pixel：bucket 攒到 1 万以上、外矿和 CPU 稳定一天后再恢复为 0.75
        maxCpuShare: 0,
    },
    // 矿物数量、库存门槛和身体由 scripts/brain/minerals.py 决定。
    // 2026-10-15 战略猫：K 矿只开 W31S6、W33S8、W37S7（大脑已停用，冻结指令里是 enabled:false）。见 roles/mineralMiner.forced
    minerals: { force: { W31S6: true, W33S8: true, W37S7: true }, maxStock: { W33S8: 10000 } },   // maxStock：10-16 战略 W33S8 K 库存 ≥1 万停孵矿物矿工，自动恢复
    // 外部大脑 2026-10-14 停用（晴猫）。retired = true：最后一份指令（issuedAt 10-14 12:00 JST、ttl 7 天）永不过期、不算掉线，
    // 否则 10-21 18:00 JST（ttl + 6h 宽限）起 brain.get 全返回 null：三座 K 矿 + W38S7 的矿全停（mineralMiner 只认指令）、
    // scout 名额从 0 变自治、外矿排序丢失，再过一天 expansion.autoClaim 开始自治占房。游戏内覆盖（remote.assign、minerals.force）照旧优先。
    // 要改回「大脑掉线就退回自治」把它设成 false（2026-10-16 爬爬代码猫，按最保守方案：维持现状）
    brain: { retired: true },
    // Memory 卫生：控制台探针（monitor.py 的 _mon、remote_roi.py 的 _roi、临时 _dbg*）把结果留在
    // Memory 的下划线键里，读取方只删探针源、不删结果。线上实测 359,623 字节的 Memory 里约 102 KB（28%）
    // 是这种死数据，而引擎每 tick 都要把整个 Memory 解析+序列化一遍 —— 这是白付的 CPU。
    memoryProbeTtl: 100,    // 下划线键内容多久没变就回收（约 7 分钟；探针写完几秒内就被读走。2026-10-14：_mon 260 KB 每 30 分钟重写一次、旧 TTL 3000 永远回收不到，序列化白烧 10 CPU/tick）
    // 房间可视化：纯诊断，不是能力。线上实测每房 0.74–1.22 CPU/tick（logs/optimizations.md 2026-09-06 那一轮），
    // 10 个房约 10 CPU/tick，占 140 限额的 7%，而线上诊断本来就走 monitor.py / probe.py / report。
    // 默认不画，控制台 showVisuals(300) 打开 300 tick（要看方案叠加时才付这份钱）。
    visuals: {
        always: false,      // true = 一直画（本地私服/调试用）
        showTicks: 300,     // showVisuals() 不带参数时打开多少 tick
        minBucket: 3000,    // 即使打开，bucket 低于此值也不画：诊断永远不该跟经济抢 CPU
    },
    // 修复血量上限钳制（rampart 实际上限随 RCL 变化，防止浪费）
    rampartRepairCap: 3e6,
    // rampart 维修目标（按 RCL，是**上限**）：早期经济必须优先升级，rampart 只保留能挡住 NPC 骚扰的厚度；
    // tower/builder 都以 min(hitsMax, rampartRepairCap, 本表) 为维修上限，避免每 tick 10 能量修向百万级
    // 轮子方案的 rampart 环有 80+ 格（旧规划只有 2 格），目标按 RCL 压低一档：RCL4 100k×84 格要花 8 万能量、塔连续修一天多。
    // RCL6 从 30 万降到 10 万（与 RCL5 同档）：30 万 × 84 格 = 25M 血 ≈ 25 万能量，是 W33S7 当前收入（8–11/tick）的
    // 二十年量级，填不满的"目标"只会让维修永远排不完；10 万 × 84 = 8.4M 血仍要 8.4 万能量，所以外环另有收入门槛
    // （rampartRingMinIncome）。rampart 归零只是失去防护、1 能量即可重建，目标定高没有收益。
    // 本表现在只是**上限**，实际目标见 config.ramparts（按能量收支动态算）。
    rampartTargetHits: { 1: 0, 2: 5000, 3: 15000, 4: 30000, 5: 100000, 6: 100000, 7: 1000000, 8: 3000000 },
    // rampart 的**动态**维修目标（utils.repairTargetHits）：不再固定修到 RCL 表，而是按房间能量收支定。
    //   目标 = 能量预算 × incomeShare × raiseTicks × hitsPerEnergy ÷ 已建 rampart 数，夹在 floorHits 与 RCL 表之间。
    // 能量预算 = max(spawn 收入 EMA, storage / storageTicks)：EMA 是流量，storage 是存量——spawn/ext 常年满仓的富房
    //   EMA 会衰减到 0（W33S3 有 14 万 storage 而 EMA 接近 0），只看流量会低估；只看存量会把"正在被抽干的仓"当成收入。
    // 系数含义：收入的 incomeShare 份额用于 rampart；允许在 raiseTicks 内把每格抬到目标；塔每能量修 80 血
    //   （builder 是 100，但外环比值最低时塔会先抢，按塔算保守）。15% × 2 万 tick × 80 血/能量 ⇒ 收入 1/tick 能养 24 万血。
    // 依据（线上 2026-09-09/10 W33S7）：84 格 × 10 万血 = 840 万血 ≈ 10.5 万能量，而房间收入 10–30/tick、
    //   同时还有 24 个道路工地与终端/实验室在排队——修满外环等于把道路和容器饿死；rampart 归零只是失去防护、
    //   1 能量即可重建，所以"修到多少"应该由收支决定。收入上来目标自动抬高，掉下去自动回落（EMA 平滑，不会抖）。
    ramparts: {
        incomeShare: 0.15,
        raiseTicks: 20000,
        hitsPerEnergy: 80,
        storageTicks: 10000,
        floorHits: 5000,
    },
};
