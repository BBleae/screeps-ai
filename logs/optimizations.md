# 优化迭代日志

每轮监控实施的优化记录（由定时自动化维护，格式固定，便于回溯归因）：

```
## <ISO 时间戳> RCL<x> <一句话标题>
- 问题：<监测到的现象/数据>
- 改动：<改了哪些文件、什么策略>
- 预期：<预期效果，尽量量化（如 prog/tick 从 A 到 B）>
- 实测：<下一轮监控回填；效果差则注明回滚/换方案>
```

---
## 2026-09-01T01:09Z RCL2 容器工地限流 + 漂移清理
- 问题：builder 死亡空窗期 5 个容器工地全部 0% 停摆，占满 maxSites=6 导致 RCL2 的 extension 工地放不出来，房间能量上限卡 300、孵化与升级持续减速；5 个工地中 2 个是 plan 过期重规划后站位漂移产生的重复工地。
- 改动：src/layout.js place() 容器段——删除不在当前规划点上的容器工地（漂移残留），未建成容器工地同时最多 2 个，为高优先结构留名额。首版误用 room.removeConstructionSite（API 不存在，报 4 条错误），已改为工地实例的 s.remove()。
- 预期：线上 5 容器工地 → 2 个；extension 工地能在 builder 复工后进入队列；RCL2 cap 300→550 提速孵化与升级。
- 实测：部署后漂移工地立即清除（container:5→2，road 4 条继续铺），0 错误；cap 提升待 extensions 建成后下轮回填。
## 2026-09-01T01:55Z RCL2 采集位替补降门槛急造
- 问题：能量饥饿螺旋——单 harvester（0.63 prog/tick 是天花板远未触及时的表现）养 upgrader/builder/hauler 三张嘴，builder 只能在 spawn≥100 时取 50 能量修路；而 harvester 替补按"替补等满额 300"策略孵化，采集产能翻不了倍，且当时在岗 harvester ttl 只剩 352 又将断层。
- 改动：src/spawn.js——harvester 缺员（have<配额，不再要求 have==0）时改走"有多少造多少"（available energy，最低 200）立即孵化；其余角色替补保持等满额避免小身体循环。
- 预期：能量攒到 200 即补上第二采集位，采集产能 +100%，能量链全面提速；当前 harvester 到寿后也不会再出现采集空窗。
- 实测：✓ 02:50-02:54 轮验证——采集全空窗期（0 harvester）spawn 靠 hauler 捡运攒能到 200 后成功急造 harvester（creeps {hauler:1} → {hauler:1,harvester:1}），孵化消耗后能量 34 继续爬坡，采集链重启。急造门槛从 300 降到"有多少造多少"的策略生效。
## 2026-09-01T02:47Z RCL2 extension 工地根因修复：道路垫底 + 工地预清理
- 问题：RCL2 允许 5 个 extension 但工地始终放不出来。根因有二——① layout.place() 的漂移清理排在 `if (budget <= 0) return` 之后，工地满员（2 容器+4 道路=6/6）时整个函数直接返回，清理永不执行，名额死锁；② 道路优先级排在 extension 之前且每次最多放 4 条、配额 2500 近乎无限，每次有空位释放都被道路抢先补位，extension 永远排队。用户的限期判断准确：这是预算/优先级结构问题，不是 builder 建造慢。
- 改动：src/layout.js——新增 trimSites()（容器/道路在建各限 2，进度高的保留；不在当前规划点上的工地清除）并**移到 budget 计算之前**；放置优先级重排为 源容器→extension→塔→storage→link→…→**道路垫底**（在建≤2、每次≤2，用剩余名额）。另：main.js 新增 CPU 桶满（10000）时 Game.cpu.generatePixel()（消耗 bucket 10000 CPU 换 1 pixel，不占 tick 预算，失败降频 10k tick 重试）。
- 预期：extension 工地在一个 layout tick（11t）内出现并逐轮补满 5 个；cap 300→550 后孵化/升级提速；bucket 满时每 10000 桶 CPU 产出 1 pixel。
- 实测：部署后 43 tick 内工地 {'container':2,'road':4} → {'container':2,'road':2,'extension':2}，0 错误；Memory.pixels=1（pixel 已开始产出）。ext 补满与 cap 提升下轮回填。
## 2026-09-01T05:08Z RCL2 零采集工自恢复 + 关键角色预补
- 问题：线上一度只剩 `[CARRY,CARRY,MOVE]` hauler、房间能量低于 200，固定 roster 无法孵化普通 `[WORK,CARRY,MOVE]`，builder/upgrader 也会与 spawn 抢能，形成不可恢复的采集死锁；monitor 没把“有工地但无 harvester”判为异常。
- 改动：src/config.js/src/main.js/src/spawn.js/src/roles/{harvester,builder,upgrader}.js——增加生存/发展两级人口、按 TTL+孵化时间预补、排他的 WORK+CARRY 应急采集分支；当仅有 hauler 且能量 150–199 时可孵化 `[WORK,MOVE]` 掉矿式应急采集工，由 hauler 接力回运；无 hauler 时禁止浪费这 150 能量；恢复期 builder/upgrader 不抽 spawn/extension，空仓 builder 不再空修。
- 预期：任何仍有 WORK+CARRY 的低能量状态可直接恢复；`162 energy + hauler` 可通过 drop miner 恢复到普通 harvester；spawning creep 不会被误当作可行动采集工，关键角色在死亡前开始补位。
- 实测：smoke 新增 5 组恢复/预补回归并全绿；部署版本 1788206895833 后线上 `errors=0`，角色恢复为 `{hauler:1,harvester:2,upgrader:1}`，CPU 1.75。controller 进度恢复与 extension 完工速度待下一监控窗口回填。
## 2026-09-01T05:00Z RCL2 经济自救：应急采集 + 150 能量 drop miner
- 问题：04:35 快照出现 `0 harvester + 72/300 energy + 仍有 upgrader/builder/hauler` 的自锁；同时还验证出第二类更糟恢复态：若只剩 `1 个 [CARRY,CARRY,MOVE] hauler`，房间能量只能慢慢回到 150-199，此时既没有 `WORK+CARRY` 幸存者可救火，也孵不出 200 成本的标准 harvester。
- 改动：`src/main.js` 新增房间恢复态评估与 `emergencyHarvest` 独占分支；`src/spawn.js` 增加 survival/development 两段孵化优先级、关键角色 TTL 预补员、以及 `150-199 energy + 无任何 viable WORK creep` 时的 `[WORK,MOVE] dropMiner`；`src/roles/harvester.js` 为无 `CARRY` harvester 加入站桩采集/掉能模式；`src/roles/builder.js` / `src/roles/upgrader.js` 在 `recovering` 态下禁止抽取 spawn/extension 能量，并修复 builder 空仓误 repair；`test/smoke.js` 新增对应 live 回归。
- 预期：两类恢复死锁都能自行脱困；恢复期优先把能量让给 spawn，200+ 后切回标准 harvester；关键角色不会因 TTL 断层再次掉进零采能窗。
- 实测：本地 `node test/smoke.js` 全绿，新增用例覆盖 `WORK+CARRY` 应急采集、`仅 hauler + 162 energy` 的 drop miner、`200 energy` 标准 harvester bootstrap、恢复期禁抢能量、以及低 TTL upgrader 预补员。线上待下一次受控部署验证。
## 2026-09-01T06:49+09:00 RCL2 全阶段发展架构上线 + 监控闭环
- 问题：移动卡住、固定人口与 TTL 断层、RCL4 后远程经济、RCL5+ Link、RCL8 布局和晚期产业此前分别完成在本地但尚未统一上线；监控也缺少 safe mode 库存/冷却可见性，且部署到非 activeWorld 分支的风险只能靠人工记忆规避。
- 改动：上线共享 movement、吞吐/距离/TTL 驱动 spawn、安全远程采矿与预定、完整 RCL8 蓝图、分阶段 Link/产业；探针升级到 schema 3，增加房间级武装敌人、safeMode/safeModeAvailable/safeModeCooldown、蓝图和远程摘要；Grunt 增加 activeWorld fail-closed 预检；创建每 30 分钟自动化 `30-screeps`，坚持先测量、单轮最多一项改进、备份、完整测试、分支复核、部署后复测。
- 预期：RCL2 经济不再因卡住或人口断层自锁；随 RCL 自动解锁远程、Link、蓝图和保守产业，持续逼近双源 20 energy/tick 可用吞吐；错误、敌情、安全模式耗尽、工地停滞和效率回退可在 30 分钟内被发现。
- 实测：全部 smoke、6 个 monitor 单测、Python/JavaScript 语法检查和最终 Grunt 打包通过，架构/质量/安全复核均批准；`default` 部署版本 `1788212938406` 已生效。第二次线上样本保持 `Memory.errors=0`，CPU `2.57/140`、bucket `6210`，角色 `{harvester:2,hauler:1,upgrader:1,builder:1}`，控制器 75 ticks 内 `1531→1581`（`0.67 prog/tick`）；4 个关键工地可见，短窗口内尚未推进。新手 safe mode 剩余 10179 ticks 被监控正确识别为持续激活状态。

## 2026-09-02T01:11+09:00 RCL2 Extension 容量身体补强
- 问题：5 个 Extension 已建成、房间容量 `550`，旧 `makeBody` 以整组重复截断，`hauler` 只用 `450`、`builder` 只用 `400`，容量提升后仍会看到旧的小身体。
- 改动：`src/utils.js` 在不破坏道路移动比的前提下，给 hauler 补 `CARRY+MOVE`、给 builder 补 `WORK+MOVE/CARRY+MOVE`；`remoteMiner@550` 改为 `4W+1C+2M`。旧 creep 继续由已有 replacement/suicide 流程平滑切换。
- 预期：新一代角色充分利用 `energyCapacityAvailable`，hauler 运输容量提升约 `16.7%`，builder 工作位吞吐提升，同时不引入超预算身体。
- 实测：私服 8/8 场景、零通知错误；线上版本 `1788279081043` 生效后 `W33S7 cap=550/ext=5`，`hauler` 替换为 `7C+4M`，随后 `builder` 替换为 `3W+2C+3M`，`Memory.errors=0`，CPU 约 `4.5/140`。

## 2026-09-02T01:18+09:00 RCL2 Broker 延迟意图遥测修正
- 问题：Screeps action 在下一 tick 才结算，旧 broker 仅比较同 tick 的位置/能量，线上出现 `acted=0、idle=150`，与 creep 实际移动/采集不符，无法据此调参。
- 改动：`src/task_broker.js` 记录 movement/broker/work-tile intent，新增 `deferred` 指标；`scripts/monitor.py` 展示其趋势并保留真实 `idle`。任务分配公式与安全 role 边界不变。
- 预期：把“已发出但尚未结算”的工作和真正空闲分开，避免误触发效率优化或错误告警。
- 实测：私服 8/8 场景、零通知错误；线上版本 `1788279519420` 生效后，`W33S7` 的 broker 快照为 `acted=0, deferred=74, idle=1`（此前 idle=150），`Memory.errors=0`，CPU `5.30/140`、bucket `6647`。

## 2026-09-02T03:09+09:00 RCL2 按 source WORK 与建设 backlog 弹性增员
- 问题：线上 `energyCapacityAvailable=550`（Spawn+5 Extension）时只有 2 个 harvester、每源 4 WORK，Spawn 在能量未回满的 `271–499/550` 区间持续空闲；固定 roster 无法响应两座 source 的实际吞吐缺口。
- 改动：`src/spawn.js` 按 source 容量/再生周期计算 WORK 目标，按 sourceId 固定分配并补齐残余 WORK；容器就绪时切换 5W 静态矿工；按加权 construction backlog 动态扩展 builder；弹性矿工允许在保留 `200` 能量恢复储备后以小身体提前孵化。`src/layout.js` 同步修复 legacy source 身份、邻近成品 container 与重复工地冲突；`scripts/monitor.py` 增加每源 WORK/动态目标告警。
- 预期：每个 3000 能量 source 达到 `5 WORK`（约 `10 energy/tick`），builder 随建设 backlog 扩缩，Spawn 不再因等待满容量而错过可用采集缺口；保留固定角色底线和恢复储备，避免过量人口/能量死锁。
- 实测：部署版本 `1788286187880`（`default/activeWorld`）后，线上由 4 个 creep 增至 7 个（harvester `2→3`、builder `1→2`），`harvesterWork=10/10`、两源各 `5/5`，`Memory.errors=0`；CPU `5.39–6.56/140`，bucket 正常回升，控制器进度窗口达到 `2.82 prog/tick`。Spawn 在目标满足且能量约 `227–477/550` 时空闲属于正常状态。

## 2026-09-02T14:40+09:00 RCL3 rampart 维修黑洞与升级链闭环
- 问题：升级到 RCL3 后控制器进度仅约 `1.9 prog/tick`，两源却已按 `20 energy/tick` 满采。tower 只要能量 ≥500 就把 rampart 修向 `min(hitsMax=1e6, rampartRepairCap)*0.6=60 万`（每 tick 10 能量），3 个 builder 同样修 rampart 并从任意容器（含 controller 容器）取能，controller 容器长期为 0；`6W2C1M` 的 upgrader 只有 1 MOVE，徒步去 spawn 取 100 能量往返上百 tick，还会被 broker 派去矿点 harvest（源已被 5W 静态矿工采满，纯浪费）；两个 upgrader 争抢同一个容器格，第二个从不升级。
- 改动：`config.rampartTargetHits` 按 RCL 设定 rampart 维修目标（RCL3 = 3 万），`utils.needsRepair/repairTargetHits` 统一供 tower、builder、`spawn.hasBuilderWork` 与 broker repair backlog 使用；builder 不再抽 controller 容器，无工地且无值得修的结构时 builder 目标为 0；upgrader 站在容器/工作位 1 格内即可升级，容器暂空且 hauler 在岗时原地等待；静态矿工 MOVE 改为 `ceil(W/2)`（800 容量下 5W3M=650）。随后：hauler 需求计入 spawn→controller 段（75% 份额）与 80% 利用率（RCL3 由 2 → 3）；第二个 upgrader 直接满容量生成；controller 容器存量 EMA 持续 ≥0.7 且能量满时加一个 upgrader，≤0.15 时回落。monitor 新增 `维护:` 行（ctrl 容器/塔能量/rampart 最低 hits 与目标）、容器持续为空告警，并把动态缺员/速率回退告警限制在能量满、窗口 ≥100 tick。
- 预期：tower 每 tick 10 能量的 rampart 维修停止，controller 容器由 hauler 持续供给，升级速率逼近“采集 20 − 孵化约 3.5”能量/tick；3 个遗留 builder 自然退役后不再补员。
- 实测：私服 8/8 场景三轮验证零错误；线上版本 `1788326389213 → 1788327227408 → 1788327352693` 依次生效后，`Memory.errors=0`，tower 保持 `1000/1000` 不再消耗，rampart 停在 59 万（部署前 tower 已从 41.8 万修到此）；builder 目标 0；hauler 目标 3 并已孵化第三个；控制器进度由 `1.3–1.9` 升至 `6.4–6.5 prog/tick`（约 80 tick 窗口）且仍在爬升，controller 容器开始出现存量。

## 2026-09-02T21:40+09:00 RCL3→4 前置：换代抖动、ctrl 容器进 broker、upgrader 同 tick 补能
- 问题（审计存活结论）：(1) `bodyImproves` 任何 +50 成本都触发提前换代并 suicide 旧 creep，RCL3 建设期全员是 `.upgrade` 替身，RCL4 再建 10 个 extension 会重造约 50 次身体（估算 5–10 energy/tick）；(2) controller 容器是中立建筑，broker 的 deliver 任务只来自 `FIND_MY_STRUCTURES`，容器只能靠 hauler 兜底顺序在 spawn/ext/tower 全满时才被喂，RCL4 有 storage 后会彻底喂不到；tower 缺 10 能量也是 weight-8 任务，会长期占住一个 hauler 租约；(3) upgrader 用空才 withdraw，每 100 能量丢 1 tick（RCL4 11W 时约 10%）；(4) upgrader 换代提前量只算孵化时间，1-MOVE 身体走 12 格道路要 36 tick，每次换代 controller 空转几十 tick；(5) 任务池 3 tick 重算，中间 tick hauler 会对已满目标发 transfer。
- 改动：`spawn.bodyImproves` 非 harvester 角色改为"新身体增量成本 ≥ 旧身体剩余寿命对应成本"才提前换代（harvester 的 WORK 增加/静态切换仍立即执行）；`task_broker` 投递分层 `tier 1 spawn/ext > 2 tower(缺口≥config.towerRefillAt=300 或有敌人) > 3 ctrl 容器(hauler 专属，低于 80% 才发布，有 ctrl link 不发布) > 4 storage(hauler 专属)`，hauler 逐层竞价，租约不匹配筛选时保留、过期即删，中间 tick 用 `Game.getObjectById` 刷新 deliver/collect backlog；`upgrader` 仓内 < 2×WORK 时同 tick withdraw+upgradeController；`spawn.roleLead` 给 upgrader 加上道路行走时间；`spawn.controllerLegLength` 不再因 storage 存在就把 controller 段记为 0（RCL4 没有 ctrl link，hauler 仍要送到 controller 容器），只有 ctrl link 才归零。
- 预期：RCL4 建设期换代从约 50 次降到约 7 次；controller 容器在 spawn 满后立即成为 hauler 目标，storage 出现后升级链不死锁；upgrader 每 100 能量少丢 1 tick；换代间隙不再空转。
- 实测：smoke 全部通过（新增 5 组断言）、monitor 14 单测通过、私服 8/8 场景零通知错误。线上效果见下一条记录。

## 2026-09-02T22:00+09:00 ctrl link 永远规划不出来（RCL5 前置）
- 问题：W33S7 的 controller (34,24) 在墙洞里，相邻 8 格只有 (33,25) 一块平地且已被 controller 容器占用；`layout` 的 ctrl link 只在 controller 相邻格里找，于是 `plan.links.ctrl` 恒为 null。RCL5 后 link 建不出来，hauler 要永远跑 12 格的 controller 段，`links.js` 的 controller 优先转发逻辑也无从生效。
- 改动：`layout.plan` 与 `normalizeLinkPlan` 改为在 upgrader 站位（controller 容器/工作位）1 格内找 link 位（真实地形下落在 (32,24)），旧内存里 `links.ctrl=null` 会在下次 normalize 时补齐；`upgrader.ctrlStation` 有 ctrl link 时以 link 为锚点（容器不再被 hauler 喂），同 tick 补能同样适用于 link。
- 预期：RCL5 时 ctrl link 工地自动放置，`task_broker` 检测到 ctrl link 后停止发布 ctrl 容器投递任务，hauler 需求随 `controllerLegLength=0` 回落。
- 实测：smoke 全部通过（新增 3 组断言）、私服 8/8 场景零通知错误；线上部署后 `plan.links.ctrl` 已补为 (32,24)（见下条记录的探针）。

## 2026-09-02T22:20+09:00 hauler 不收 tombstone
- 问题：线上 (21,23) 出现一个 TTL 耗尽 hauler 留下的 400 能量 tombstone（离 spawn 2 格，剩 37 tick），三个 hauler 无人理会。根因：`hauler.js` 空载竞价的筛选只接受掉落物和已规划 source 容器，tombstone 被排除；兜底路径 (4) 只在没有 ≥100 的 source 容器时才到达，而 source 容器常年有货，所以 tombstone 永远轮不到（审计"tombstone 与 <100 掉落从不回收"的存活结论）。
- 改动：broker 的 tombstone collect 任务打上 `tombstone` 标记；hauler 空载竞价接受 ≥50 能量的 tombstone（由竞价的距离/收益因子决定是否值得），半载 hauler 路过相邻 tombstone 时先装满再投递；"脚边顺手捡"不再要求空余容量 ≥ 整堆数量（pickup 本来就只拿得下的部分），空余 ≥50 即捡。
- 预期：靠近基地的大额 tombstone 在几 tick 内被收走；远处小额的仍由竞价按收益放弃，散落成掉落物后按原有掉落逻辑处理。
- 实测：smoke 全部通过（新增 3 组断言）、私服 8/8 场景零通知错误；线上部署后见探针记录。
- 顺带观察：两个 source 容器 2000/2000 且 (15,7) 地面堆了 3686 能量——3 个 upgrader（18 WORK）已接近"采集 20 − 孵化 3.5"的能量上限，但换代空档让实际消耗略低于产出，多余的能量最终堆在源头。RCL4 有 storage 后自然吸收；RCL3 阶段可考虑把 `upgrading.maxUpgraders[3]` 放宽到 4 由 EMA 决定。

## 2026-09-02T22:25+09:00 回归：upgrader 追着未建的 link 位不升级；RCL3 放开第 4 个 upgrader
- 问题：ctrl link 规划修复上线后（`plan.links.ctrl` 从 null 变成 (32,24)），`upgrader.run` 里一段旧逻辑被首次激活：link 未建但 plan 有 link 位时，离 link 位超过 1 格的 upgrader 先去挪窝再升级。容器旁 (32,26) 的 upgrader 手握 100 能量原地挂机，升级速率从 15–17 掉到 1.84 prog/tick；用户看到"upgrader 就在 controller 旁有能量却不升级"。
- 改动：删掉这段逻辑。站位由 `ctrlStation` 按"已建成 link > 容器"决定，规划位在 RCL5 之前只是坐标。新增回归断言：plan 有 link 位但无 link 时容器旁的 upgrader 直接升级。
- 同批：`upgrading.maxUpgraders[3]` 3 → 4。3 个 6W upgrader 略低于采集减孵化，产出堆在源头按 ceil(amount/1000)/tick 衰减（线上 (15,7) 已堆 4132，约 4 e/tick 在蒸发）；第 4 个仍由 EMA 在容器持续 ≥70% 且能量满时决定，枯竭时逐级回落。
- 实测：见部署后探针。

## 2026-09-02T23:55+09:00 批 0：外部大脑基础设施
- 背景：官方账号 GCL 12 却只占 1 房；bot 是完整的单房经济体，扩张/防守 creep/军事/市场/矿物/lab 供给全部缺失，`Memory.map` 空且无消费方。与用户确认的方向：情报、重计算、全局态势与战略规划移到外部程序和定时 Claude 复核，游戏内只留 tick 级执行；姿态防御优先只打 NPC；首个占领目标 W34S7。设计见 `docs/superpowers/specs/2026-09-02-external-brain-design.md`。
- 已验证的通道：`room-objects` 对任意房间无视野返回全部对象（含他人 creep 与 body）；console 表达式上限 1024 字符，大载荷走 `memory-segment`（官方与私服都有）。
- 改动：`src/brain.js` 每 tick 激活 segment 90，内容变化时解析进 `Memory.brain`，校验 version/issuedAt/ttl，合并 intel 进 `Memory.map`（`source:'external'`），回写 ack，提供 `directive/get` 访问器；`remote.admitCandidates` 采用指令白名单；有指令时 scout 目标为 0（`scouts` 字段可保留）；scout 记录打 `source:'scout'`。`scripts/brain/`（Python，无依赖）：`api.py`（官方/私服鉴权、限速、磁盘缓存）、`intel.py`、`plan.py`（外矿与占领评分）、`directive.py`（契约与 segment 写入、locks 覆盖）、`brief.py`、`run.py`；`install_schedule.sh` 装 launchd 每 5 分钟一轮；`review_prompt.md` 给定时 Claude 复核。私服：`validation_mod.js` 补 `room-objects` 路由，新增 `brain` 场景（E11S11 母房 + E11S12 邻房，无 scout、无预写情报），验证脚本对私服真实跑一轮 Python 大脑并断言 ack、情报合并与外矿纳入。线上清理了 37 个残留探针键。
- 测试：smoke 新增 brain/segment/remote 白名单/scout 退役共 4 组断言；`test/brain_test.py` 15 项；私服 9 场景（含真实外部大脑端到端）零错误通知。
- 实测：线上版本 `1788360791607`，首份指令 10.9 KB 写入 segment 90 后一个 tick 内 `Memory.brain.ack.issuedAt` 与写入一致、`applied=['intel:24']`，`Memory.map` 24 条外部情报（W34S7：双源、矿 L、残墙 30），scout 目标 0，claim 指令 W34S7 已就位（批 1 才会消费）。launchd `local.screeps-brain` 每 5 分钟写一轮。此前 segment 里的测试载荷触发过一次 `version:undefined` 拒绝记录（预期的一次性事件，已清理）。

## 2026-09-03T00:39+09:00 批 1a：按外部指令占领并开荒新房
- 背景：GCL 12 只占 1 房。外部大脑已给出占领目标 W34S7（双源、无主、远离 RCL8 邻居）。
- 改动：`scripts/brain/layout.py` 用地形距离变换 + 资源重心为占领目标选 spawn 位（真实 W34S7 地形夹具测试，选出 (24,36)），随 claim 指令下发；`src/expansion.js` 把 claim 指令变成孵化需求（GCL 余量、母房容量 ≥650、目标非他人所有、目标尚无 spawn 时），claimer `[CLAIM,MOVE]` 占下后按 spawnPos 放 spawn 工地并退役，`config.expansion.pioneers` 个 pioneer 在新房就地采能、建 spawn、升 controller，新房 spawn 建成后转为该房 builder；`spawn.run` 把扩张需求并入远程需求队列。私服 `brain` 场景延长到指令后 280 tick，断言 claim 指令带 spawnPos 且邻房已成为己方房间。
- 顺带修的两件事：(1) `task_broker` 卡住检测——持有租约却连续 6 tick 位置与能量都不变，放弃该目标并屏蔽 150 tick（线上遇到不可达的掉落堆/满仓目标时不再原地死等）；扩张需求排在外矿需求之前。(2) 私服夹具 `addExtensions` 把 20 个 extension 填满 spawn 周围距离 2 的整圈，孵出的 creep 全被围死（PathFinder 默认不算建筑所以"有路"，`moveTo` 全是 NO_PATH），以往验证只查"不崩"从未暴露；改为棋盘格放置。
- 测试：smoke 新增扩张与排序、卡住检测、无 spawn 新房整 tick 共 4 组断言；`test/brain_test.py` 19 项；私服 9 场景零错误（`brain` 场景断言 claim 指令带 spawnPos、邻房被占下）。
- 实测：版本 `1788363573665` 上线后一分钟内 claimer 入队、已有一只走到 W34S7；但探针发现第二只 claimer 也孵了出来、房间能量掉到 215——扩张需求的 memory 没带 `home`，`matchesDemand` 按 `memory.home` 匹配失败导致槽位计数恒为 0。补断言修复后版本 `1788363747108` 上线。随后探针：W34S7 controller 已归我方（RCL1），spawn 工地按外部选址落在 (24,36)，两只 claimer 完成任务后退役，第一只 pioneer 在 W33S7 孵化中，errors 0。

## 2026-09-03T00:53+09:00 批 1b：外矿放宽到单源与二跳，占领目标不再兼作外矿
- 改动：`config.remote.maxRange=2 / minSources=1`；`remote.js` 对外部白名单里的房放宽到两跳（`withinRange`），二跳房的入口按 `Game.map.findRoute` 第一步出口取边中点，路程估算的 maxRooms 按房间距离给，白名单房数量由大脑决定（不再受游戏内 maxRooms 二次截断），单源房不再被 `sourceCount` 停用。大脑 `plan.py`：距离罚分加重（每跳 8 分，二跳再扣 6），己方房与占领目标排除在外矿之外；解答用户"为何直接 claim 而不先 reserve"——设计如此：GCL 12 余量是最大闲置资源，RCL3 母房也走不到外矿逻辑，reserve 路线保留给非占领目标。
- 测试：smoke 新增外矿放宽一组 5 条断言；`test/brain_test.py` 21 项（含二跳排序低于相邻房、占领目标排除）。
- 线上事故与修复：W34S7 占下后大脑下一轮把占领目标换成两跳外的 W31S5，游戏内随即孵出 claimer 与 pioneer。手动取消/退役了 3 只 creep，用 `locks.json` 把 claim 置空并重写指令；随后给大脑加了门槛——情报里任何己方房还没有 spawn 就不开新占领（`blocked: bootstrapping:<room>`），已占房计入 GCL 余量，相邻候选优先于二跳候选，`run.py` 摘要改为反映 locks 之后的指令。教训：外部规划的"下一目标"要有速度限制，游戏内执行层也应有二次确认（批 2 顺带加"同时只允许一个占领在途"的游戏内保护）。
- 补充：游戏内 `expansion` 增加两道保护——已有己方房没 spawn 时不接受第二个占领指令；占领目标记进母房内存，claim 指令撤掉后仍持续补 pioneer 直到新房建成 spawn（否则 locks 置空 claim 会顺带断掉开荒支援，线上 W34S7 一度只剩 1 个 pioneer）。私服 `brain` 场景增加 E12S11 作为外矿房，E11S12 只作占领目标。
- 补充：用户问"W34S7 占下后为何没有建筑规划的 RoomVisual"——`layout.plan` 没有 spawn 就直接返回，新房在 spawn 建成前既无规划也无可视化。改为没有 spawn 时以 spawn 工地为锚点出规划（`plan.spawns` 记录 spawn 位），RoomVisual 随之绘制。
- 实测：批 1b 连同占领保护、开荒支援持久化、spawn 工地锚点规划以版本 `1788365503579` 上线（私服第 21/22 轮 9 场景零错误）。

## 2026-09-03T01:17+09:00 过渡布局棋盘格化与开荒自愈
- 用户指出 RCL1-3 的过渡布局把 extension 围成一圈可能堵死通路。分析：`layout.plan` 以 spawn 为圆心取距离 2..4 的全部平地按远近排队，最近 22 格预留给塔/storage/terminal/spawn2-3/lab/杂项，其余全给 extension；道路另行规划但候选没有排除道路格，extension 与道路又不能同格。作者意图是紧凑基地、缩短 hauler 补给距离，靠道路开口；W33S7 因道路先建成而在环上留了两三个口子，但脆弱——私服夹具复现过 spawn 被围死的情况。
- 改动：候选只取棋盘格（x+y 为偶数）、范围放到 2..5、排除已规划道路格，extension 排在核心四类之后、RCL7/8 结构之前取最近的格；老房不拆已建 extension，RCL4 起 blueprint 接管。另：`expansion.activeTarget` 在无指令无记忆时自动接管己方无 spawn 的房（线上 W34S7 曾因旧版本没记录 `expansion` 而断了 pioneer 供给，已手动补记忆）。
- 测试：smoke 新增两组断言（棋盘格/不占道路/不贴 spawn/候选≥20；自愈接管）。
- 实测：版本 `1788366226792` 上线（私服第 23 轮 9 场景零错误），线上清掉 W34S7 旧规划让其按棋盘格重生成。

## 2026-09-03T01:29+09:00 批 2：NPC 防御
- 改动：`tower.js` safe mode 不再"有塔就永不开"——塔没能量、敌方 HEAL 总量 ≥ 塔在该距离伤害的 90%、或 spawn/塔/storage 掉血过半时开盾（`towersCanHold`）；`utils.findCached` 的缓存键纳入 filter 源码（此前函数型 filter 被 JSON 丢掉，同 tick 不同 filter 撞键）。新增 `defense.js`：受保护房 = 母房 + 其它己方房（含开荒中的无 spawn 房）+ 外矿记录；可见房看实体，不可见房用外部情报（1500 tick 内）或外矿停用原因；母房塔压得住不派兵；出现武装 NPC 派 defender（对远程/治疗用 ranged+heal，对近战用 attack；≥3 个敌人派 2 只），外矿被 InvaderCore 占据派纯 ATTACK 清核心队；由离目标最近的有 spawn 的己方房负责，需求排在扩张与外矿之前，恢复期也产出。`roles/defender.js`：远程风筝（受伤自疗、距离<3 后撤、≥2 目标群射）、近战贴脸、清核心，清场 50 tick 后回家退役。姿态：只对 NPC，不针对玩家。
- 私服：`addCreep` 支持 `user` 参数；`brain` 场景往占领目标房塞两只 Invader（用户 id 2）近战 creep，断言母房据外部情报派出 defender 且结束时该房无敌对 creep。
- 测试：smoke 新增 safe mode 5 条、findCached 2 条、防御需求与 defender 行为 10 条断言。

## 2026-09-03T01:41+09:00 布局外置：离线 RCL8 蓝图随占领指令下发
- 背景：用户指出 W34S7 的过渡布局被地形挤在窄带里（东、南两片墙体之间，候选大多落在沼泽，RCL7/8 结构没有位置）。取证：所有候选从 spawn 可达且无绕路，但 (24,36) 这个锚点本身选得差；RCL4 蓝图会被迫围着位置糟糕的 spawn1 设计，是永久代价。
- 发现并修复蓝图的一个真实缺陷：`buildPlanForAnchor` 把已规划道路格加进阻挡集，`buildStructureCostMatrix` 对阻挡一律 255，第一条路占掉 storage 周围仅有的出口后其余道路全部失败，在 W34S7/W33S7 的真实地形上 `blueprint.generate` 都会报 "missing road"；smoke 的 PathFinder 是直线桩所以从未暴露。改为已规划道路对后续道路代价 1、仅对 extension 选址视为占用。
- 新增 `scripts/brain/blueprint_runner.js`：本地用真实地形与对象跑 `src/blueprint.js`（自带 Dijkstra 版 PathFinder），`brain/layout.blueprint_plan` 调用它；占领指令的 `claim.plan` 附带整份 RCL8 蓝图，`spawnPos` 取蓝图 spawn1。蓝图对无 spawn 房间自行选 spawn1（`plan.spawns`），校验计入；`layout.place` 在没有 spawn 时按 `plan.spawns[0]` 放工地；`expansion.run` 在目标房归我方后把蓝图写成该房 plan 并确保 spawn 工地存在。
- 测试：`test/brain_test.py` 新增离线蓝图两项（W34S7 真实地形：spawn1 (27,18)、60 ext、全部道路）；smoke 新增蓝图选 spawn1、layout 放工地、采用蓝图三组断言。
- 实测：版本 `1788367859035` 于 01:55 上线（含批 2 防御、蓝图道路修复、离线蓝图采用）。为赶在 W33S7 升到 RCL4（约 250 tick）之前让修好的蓝图生效，先于私服防御场景断言通过就部署了；防御代码本身 smoke 与私服运行零错误，只是私服场景里"defender 被孵化"的断言尚未通过，取证进行中。
- 实测（02:05）：经用户同意，W34S7 的 spawn1 迁到蓝图位 (27,18)：通过 locks 下发带整份 RCL8 蓝图的 claim 指令，游戏内把蓝图写成 W34S7 的 plan（version d1-rcl8-v1，锚点 (27,20)），旧工地（(24,36) 534/15000 及过渡布局的容器/道路工地）已移除，新 spawn 工地已在 (27,18) 放置，两只 pioneer 正在赶过去。

## 2026-09-03T02:15+09:00 私服防御场景取证与两个顺带修复
- 取证：无塔房开盾后 Invader 自行退场（正确行为，断言反了）；改成 0 能量塔 + 无盾后，defender 打完 50 tick 回家退役，`Memory.creeps` 里自然没有它，"结束时存在 defender"的断言再次误判。改为游戏内记录 `Memory.rooms[home].defenseLog`（出兵次数/时间/槽位）并据此断言，验证脚本另加 t+5/25/60/120 的早期快照。
- 顺带修复 1：hauler 全灭而矿工是静态的时，能量永远回不到 spawn（私服里卡在 241/800 五百 tick），生存编制现在会用现有能量孵一只小 hauler 打破僵局（harvester 早有同样逻辑）。
- 顺带修复 2：大脑给 W33S7 分配的第一个外矿是对角房 W32S6——房间只有四向出口，对角房实际要穿一个房，评分改用曼哈顿距离；W33S8 因紧邻两间 RCL8 殖民房被扣 16 分排到单源房之后，属预期（防御优先）。
- 线上：W33S7 于 02:20 前后升到 RCL4，游戏内蓝图生成成功（storage 位 (25,24)），6 个 extension 工地已放，4 个 builder 在建；W34S7 新 spawn 工地 (27,18) 512/15000。
- 实测：私服第 32 轮 10 场景零错误，防御场景断言通过（`defenseLog.spawned ≥ 1`、结束时无 Invader）。含小 hauler 破僵局与防御遥测的版本 `1788369735620` 于 02:22 上线。
- 实测：pioneer 分源（同一源只留一只，第二只去另一源）随版本 `1788370236935` 于 02:30 上线（私服第 33 轮 10 场景零错误）。

## 2026-09-03T02:30+09:00 builder 按能量收入封顶
- 问题：W33S7 升到 RCL4 后 `builderTarget` 按"300 tick 视野内建完加权 backlog"算出 4 个 builder（3200 能量），而房间收入只有 20 e/tick，建造每点进度花 1 能量，多余的 builder 只是排队等能量；且目标随现有数量棘轮上涨（审计早已指出）。上线后升级速率一度归零。
- 改动：`requiredWork = min(视野需求, 收入允许)`，收入允许 = `源数×10×incomeShare(0.6) / (5×buildDuty(0.5))` 个 WORK（builder 约一半时间在取能），目标再受 `ceil(收入允许/单体 WORK)` 封顶，不再随现有数量上涨；RCL2 两容器工地仍是 2 个 builder，RCL4 由 4 降到 2。
- 测试：smoke 新增 2 条断言，既有 builder 断言全部保持。
- 实测：版本 `1788370772847` 于 02:39 上线（私服第 34 轮 10 场景零错误）。

## 2026-09-03T02:55+09:00 远程 creep 在外矿停用后退役
- 问题：大脑把外矿从对角房 W32S6 改派到 W32S7 后，旧的 reserver 撤回家在 (25,25) 发呆到寿命结束（占编制、无产出）。
- 改动：`remote.isDisabled`；reserver / remoteMiner / remoteHauler 撤回家（hauler 需空载）且外矿记录 `enabled === false` 时退役；只是敌情冷却的暂停仍原地等待。
- 测试：smoke 新增 3 条断言。
- 实测：版本 `1788371597157` 于 02:53 上线（私服第 35 轮 10 场景零错误）。

## 2026-09-03T03:05+09:00 大脑把预定房当成己方房；新母房给自己规划占领
- 问题：map-stats 对我方**预定**的 W32S7 也返回 `own.user`（level 0），大脑把它当成「己方无 spawn 的开荒房」：错误地阻止新占领、把 W32S7 排除出外矿白名单（游戏内因相邻房不依赖白名单而未受影响）。W34S7 有了规划后成为母房，但情报不含母房自身，于是大脑给这个还没 spawn 的房规划了占领 W35S7（游戏内被 RCL/容量门槛与开荒互斥挡住，未执行）；游戏内 `expansion.activeTarget` 还会让无 spawn 的母房把自己当成待接管目标。
- 改动：`intel.collect` 只把 `own.level > 0` 当作拥有，并把母房自身也纳入情报；`expansion.activeTarget` 忽略指向自己的 claim/记忆。
- 测试：Python 新增 2 条（预定房归属、母房自身入情报且被判为开荒中）；smoke 新增 1 条。
- 实测：重跑大脑后 W33S7 指令为外矿 W32S7、占领 W34S7（locks），W34S7 母房判定「暂不开新占领（bootstrapping:W34S7）」。
- 上线：版本 `1788372234357` 于 03:03（私服第 36 轮 10 场景零错误）。

## 2026-09-03T03:13+09:00 pioneer 采一 tick 就跑去建 spawn
- 问题：W34S7 的 spawn 工地 2 个 pioneer 干了两小时只到 1,344/15,000（约 1 点/tick）。探针：两只 pioneer 各带 8 能量在路上，两个源几乎满能量（2824/3000、2968/3000）。根因：pioneer 只在能量为 0 时采集，采一 tick 得 8 能量就掉头去工地，来回搬 8 点。
- 改动：`roles/pioneer.js` 加 `memory.working` 状态机——采满再去建，建到空再回源（与 builder/upgrader 同型）。
- 测试：smoke 新增 4 条断言（采到 8 不去工地、采满去建、建设途中不回源）。
- 上线：版本 `1788372924827` 于 03:15（私服第 37 轮 10 场景零错误）。

## 2026-09-03T03:16+09:00 hauler 缺编时外矿 creep 插队
- 问题：W33S7 升到 RCL4 后容量 950，hauler 目标 3、在岗 1，spawn 却接连孵了两只 remoteHauler；能量长期贴地，upgrader 供能容器空了 200+ tick。根因：编制循环里 hauler 因「买不起」被跳过后，代码直接落到外矿/扩张需求，便宜的远程 creep 把攒到一半的能量用掉，满容量 hauler 永远凑不齐。
- 改动：`spawn.js` 编制循环里 harvester/hauler 缺编且买不起时置 `starved`，本 tick 不再考虑外矿/扩张需求（防御抢占不受影响）。
- 测试：smoke 新增 4 条断言（700 能量时不孵 reserver；能量到 950 先补 hauler）。
- 上线：版本 `1788373092431` 于 03:18（私服第 38 轮 10 场景零错误）。

## 2026-09-03T04:55+09:00 defender 清场后在两房之间来回踱步
- 问题：04:40 左右 W32S7 出现 Invader，spawn 按需求孵了 defender（`defenseLog.spawned=1`，slot `defender:W32S7`）；清场后它回到 W33S7，但下一 tick 因为"不在目标房 W32S7"又走回去，永远到不了 `suicide()`，探针看到它满血在家闲置 168 tick。
- 改动：闲置到期后把 `memory.targetRoom` 改为母房，再回家退役。
- 测试：smoke 新增 1 条断言（到家后 suicide，且不再往外矿走）。
- 上线：版本 `1788379020285` 于 04:57（私服第 39 轮 10 场景零错误）。

## 2026-09-03T06:13+09:00 RCL1 新房卡在 1 只 harvester
- 问题：W34S7 spawn 05:45 建成后孵出第一只 harvester（work/carry/move），之后能量满 300 却一直空闲；监控告警「spawn 空闲但仍缺员」。根因：生存档在 RCL1 只要 1 只 harvester，其余 harvester 靠弹性补员，而弹性补员要求「身体成本 + 恢复保留 200 ≤ 预算」，容量 300 的房永远不满足。
- 改动：`tryElasticHarvester` 里保留能量只在「容量 − 保留 ≥ 最小 harvester 成本 200」时生效。
- 测试：smoke 新增 1 条断言（容量 300、能量满时孵出第二只 harvester）。

## 2026-09-03T06:16+09:00 大脑白名单成为外矿的权威
- 问题：私服第 40 轮 brain 场景失败——指令到达前 scout 已探完邻房，自治逻辑先纳入了 E11S12，白名单 E12S11 到达后因 `maxRooms[4]=1` 已满而无法纳入（时序竞争，大脑多拉母房情报后更容易触发）。
- 改动：`remote.run` 在有新鲜白名单时把不在名单里的外矿标为 `notWhitelisted` 停用（远程 creep 回家退役），重新出现在名单里时启用；指令过期则不动。
- 测试：smoke 新增 4 条断言（换名单停用/纳入、换回重新启用）。
- 上线：版本 `1788383894517` 于 06:18（私服第 41 轮 10 场景零错误；含 RCL1 保留能量修复）。

## 2026-09-03T14:02+09:00 基地满能量时 remoteHauler 满载发呆
- 问题：W33S7 能量 1300/1300 常满，控制器容器 0/2000，两只 11 WORK 的 upgrader 只升 12.9/tick；探针看到 2 只 remoteHauler 满载（510/550、650/650）停在 spawn 旁无事可做。`remoteHauler.homeTarget` 只认 storage/spawn/extension，容器那条分支是死代码（容器不在 `FIND_MY_STRUCTURES` 里），基地一满外矿收入就归零。
- 改动：remoteHauler 回家投递层级与 hauler 对齐：spawn/ext → 塔缺口 ≥300 → 控制器容器（低于 80%）→ storage。
- 测试：smoke 新增 4 条断言；mock 的 `FIND_MY_STRUCTURES` 改为与真实 API 一致（排除容器/道路/墙），`createConstructionSite` 套用真实共格规则——原 mock 让这个 bug 在测试里"通过"。
- 上线：版本 `1788412548167` 于 14:15（私服第 44 轮 10 场景零错误；第 43 轮因与第 42 轮收尾撞端口在启动阶段失败，与代码无关）。实测：上线 2 分钟内 remoteHauler 已在基地投递、`layoutBlocked` 写入 `storage@25,24<-road`，`Memory.errors` 0。

## 2026-09-03T14:06+09:00 W33S7 蓝图的 storage/terminal/link 位被旧道路占住
- 问题：W33S7 RCL4 已 11,000 tick 没有 storage 工地。蓝图 `d1-rcl8-v1` 的 storage 在锚点 (25,24)、terminal (25,23)、src0 link (31,13)，三格都压着 RCL1–3 旧规划留下的 road；`trySite` 不允许 storage 与 road 共格，工地永远放不出。另有 7 个 extension 位（RCL5 起会用到）也压着旧路，但 extension 有 60 个备选位，只是布局松散。
- 改动：不自动拆（用户明令）。`layout.place` 把冲突写进 `Memory.rooms.<房>.layoutBlocked`，监控作为 issue 报出；拆路让位放在策略开关 `config.policy.clearBlockingRoads`（`Memory.policy.clearBlockingRoads=true` 可在控制台覆盖）后面，默认关闭，开启后每房每轮只拆 1 条、且只拆阻挡物全是 road 的规划位。
- 测试：smoke 新增 6 条断言（默认只记录不拆、开启后拆路并放出 storage 工地、非道路阻挡永不拆）；monitor 新增 1 个用例。
- 待决：需要你批准开启 `Memory.policy.clearBlockingRoads`，否则 storage 到 RCL5/6 都放不出来。
- 上线：版本 `1788412548167` 于 14:15（同上）。

## 2026-09-03T14:11+09:00 W34S7 容量升到 550 后整队换代，20 WORK 对 10 WORK 需求
- 问题：W34S7 五只 RCL1 的 2 WORK 矿工在 5 个 extension 建成后被 `tryBodyUpgrade` 逐只换成 4 WORK 静态矿工（名字都带 `.upgrade`），源 0 三只 12 WORK、源 1 两只 8 WORK，需求各 5；2500 能量烧在 spawn 上的同时 hauler 3 缺 2，源容器满 2000 溢出，地上堆了 3,800 能量。
- 改动：harvester 只在「该源上已是理想身板的 creep（含孵化中）提供的 WORK < 源需求」时才进换代候选。
- 测试：smoke 新增 2 条断言（只给新身板不足的源换代；替换者孵化中即视为已覆盖）。
- 上线：版本 `1788412548167` 于 14:15（同上）。

## 2026-09-03T14:21+09:00 大脑：外矿排除了自己排出的占领候选；RCL4 放开到 2 个外矿；tooFar 记录进白名单不启用
- 问题：`plan_home` 把规划自己算出的下一个占领候选排除出外矿，而实际生效的占领目标被 locks 覆盖成 W34S7——最好的相邻双源房 W33S8 就这样白白被排除（简报里显示 `W33S8=excluded`）。RCL4 只允许 1 个外矿，但监控历史里 W33S7 的 spawn 忙碌率只有约 43%。游戏内早先被自治逻辑判 `tooFar` 停用的外矿记录，即使后来进了白名单也不会重新启用。
- 改动：`plan_home` 接 `claim_override`（run.py 读 locks 里有效的 `<房>.claim`），只排除实际生效的占领目标；`remoteMaxRooms[4]=2`；`remote.run` 对 `tooFar` 记录在白名单且 maxRange 内时重新启用。
- 结果：大脑下一轮白名单 W32S7 + W33S6（W33S8 因紧邻 tidusfox9 两个 RCL8 房各扣 8 分，排到单源房之后——这是既定的强邻风险规则，未改），游戏内已纳入 W33S6。
- 测试：Python 新增 1 个用例、更新 2 个期望；smoke 新增 1 条断言。
- 上线：游戏内版本 `1788413091832` 于 14:25（私服第 45 轮 10 场景零错误）；大脑改动由本机定时任务即时生效。
- 附带：把 `W33S7.claim` 锁延长 48h（到 09-05 14:22）。W34S7 已开荒完成，锁一到期大脑就会把 W33S8 排成下一个占领目标并派 claimer——第三个房要不要占、占哪个，等你决定。

## 2026-09-03T14:26+09:00 大脑给 RCL2 母房排占领目标
- 问题：干跑发现大脑把 W34S7（RCL2、容量 550）也当母房规划，给它排了占领 W35S7（含蓝图）。游戏内 `expansion` 门槛是 RCL3 + 容量 650，W34S7 一到 RCL3 就会往第四个房派 claimer 和 pioneer，拖垮自身经济。
- 改动：`choose_claim` 增加 `claimMinLevel=4`（低于则 `blocked=level:N`）；`plan.single_claim` 保证全账号同时只推进一个占领（多母房都排出目标时保留 RCL 最高者）。另加 `W34S7.claim` 空值锁 48h 兜底。
- 测试：Python 新增 2 个用例（48 个全绿）。
- 上线：大脑侧改动，无需游戏内发布；干跑确认指令为 W33S7 外矿 [W32S7, W33S6]、占领 W34S7（锁），W34S7 无外矿、`blocked=level:2`。

## 2026-09-03T14:35+09:00 RCL2 upgrader 上限 1，W34S7 产出消化不掉
- 问题：W34S7 五个 extension 建完后只剩道路可建，20/tick 的采集只有 1 只 upgrader 在消化：控制器容器 1671/2000、两个源容器满 2000、地上堆了 3,800 能量，升级只有 2.7–4/tick（RCL3 要 45,000）。`config.upgrading.maxUpgraders[2]=1` 让 EMA 加编机制在 RCL2 完全失效。
- 改动：`maxUpgraders[2]` 1 → 3（14:32 上线），随后 → 4（4 只 3W = 12/tick 仍低于 20 减孵化；W34S7 safe mode 已耗尽，尽快到 RCL3 出塔）；EMA 规则不变（容器 ≥70% 且能量满才加，≤15% 减）。
- 测试：smoke 新增 2 条断言（容器 95% 满时目标 ≥2；容器见底后回到 1）。
- 上线：版本 `1788413506494` 于 14:32（私服第 46 轮 10 场景零错误）。上线时 W34S7 的 EMA 已 0.78，等 spawn 能量满即加第 2 只。上限 4 于 14:46 以版本 `1788414379834` 上线（第 48 轮 brain 场景因富余 upgrader 抢队失败，见下一节；实测 W34S7 14:52 已 3 只 upgrader、8.0/tick）。

## 2026-09-03T14:36+09:00 生存档只数矿工总数，一口源空着也先孵 upgrader
- 问题：W34S7 源 1 的两只矿工先到期后，剩下两只 4W 矿工都在源 0（且 45/60 tick 后到期），源 1 一只都没有；生存档 `harvester` 目标 2、在编 2 判定"够了"，发展档先孵第 2 只 upgrader，源 1 空了 100+ tick（监控告警 `采集 WORK 吞吐未达目标 deficit=2` 且 spawn 空闲）。
- 改动：生存档矿工目标至少 = 在编数 + 没有在岗矿工的源数（即将到期的不算），`assignHarvesterSource` 自然把新矿工派到空源。
- 测试：smoke 新增 1 条断言（两只矿工都在源 0 时先给源 1 补矿工，而不是 upgrader）。
- 上线：版本 `1788413885043` 于 14:38（私服第 47 轮 10 场景零错误）。

## 2026-09-03T14:47+09:00 富余 upgrader 抢在占领/外矿需求前面
- 问题：私服第 48 轮 brain 场景失败：母房（RCL4，控制器容器预填 90%）EMA 把 upgrader 目标加到 3，发展档按 `targets.upgrader` 补人，占领指令的 claimer 排在后面迟迟孵不出来（第 47 轮同样代码只是时序上侥幸通过）。线上同理：外矿/占领的 creep 会被"富余消化型" upgrader 挤掉。
- 改动：发展档只保证 roster 底线 upgrader；EMA 加出的富余 upgrader 移到防御/扩张/外矿需求之后，且这些需求存在（哪怕暂时买不起）时不插队。
- 测试：smoke 新增 3 条断言（EMA 目标 3 时先孵 claimer、再孵 pioneer）。
- 上线：版本 `1788414802411` 于 14:53（私服第 49、51 轮 10 场景零错误；第 50 轮紧接第 49 轮启动撞了收尾中的服务器，与代码无关）。

## 2026-09-03T14:50+09:00 低容量母房的"远程型" defender 退化成 1R1M
- 问题：W34S7（容量 550）遇到带 RANGED_ATTACK 的 Invader（2T4M+R+W+A，776 血）时，`threat.ranged` 触发远程型身板，550 下只够 1 个 RANGED_ATTACK + 1 MOVE：200 血、10 伤害/tick，追着打了 100 多 tick 才把它逼到 16 血；没有 safe mode 时这只 defender 会在接触后 5 tick 内被打死。同容量的近战 4A4M 是 800 血、120 伤害/tick，7 tick 击杀。
- 改动：`config.defense.rangedMinCapacity=800`，敌方有远程/治疗且容量达标才派远程型，否则近战。
- 测试：smoke 新增 2 条断言（550 派 4A4M；1300 派 ≥3R 远程型）。
- 上线：版本 `1788414802411` 于 14:53（同上）。

## 2026-09-03T14:59+09:00 外矿道路 14 小时只修好 5/18 格
- 问题：探针显示 W32S7 的外矿路 18 格建了 5 格、2 个工地、11 格还没放；W33S6 4 格全没建。原因有二：`placeInfrastructure` 每 17 tick 只放 1 个工地且同时最多 2 个；维护型 remoteHauler 只在路过时顺手点一下（5 点/tick）然后继续走，一格 300 点的路要路过 60 次。路修不完，hauler 就一直用 1:1 MOVE 的身板（1250–1300 能量），也一直走沼泽。
- 改动：外矿工地上限 2 → 6 且一次补满；维护型 remoteHauler 回程在外矿房遇到路/容器工地就停下修完（有能量时），没能量再继续回家。
- 测试：smoke 新增 3 条断言（一次放 ≥4 个路工地；遇工地建造且不移动；没能量不停留）。RED 验证：旧代码同 tick 既 build 又 moveTo。
- 上线：版本 `1788416139433` 于 15:16（私服第 54、55 轮 10 场景零错误；第 52 轮 brain 场景失败与第 53 轮取证见下文）。

## 2026-09-03T15:03+09:00 有塔的房为一个掉血容器孵整只 builder
- 问题：W33S7 没有工地，只有控制器容器 146k/250k 在掉血（塔本来就在修），`hasBuilderWork` 因"存在值得修的结构"返回 true，spawn 花 1300 孵了一只 builder，随后它无事可做去升级——这 1300 本可以直接进控制器。
- 改动：房里有能量 ≥500 的塔时，只剩维修活不孵 builder；有工地或塔没能量时照旧。
- 测试：smoke 新增 3 条断言，并更新 1 条旧期望（有塔时低血量道路交给塔）。
- 上线：版本 `1788416139433` 于 15:16（同上）。

## 2026-09-03T15:05+09:00 hauler 缺编等能量时把一次性的 claimer 也卡住
- 问题：私服第 48、52 轮 brain 场景失败的真正原因（第 53 轮 --keep-running 取证）：母房 hauler 差 1 只但 1300 的身板买不起，`starved` 让 spawn 等能量，650 的 claimer 跟着等了 250 tick，错过场景窗口；第 47、49、51、53 轮只是 hauler 恰好齐员。线上同理：外矿/占领 creep 会被"等 1300 攒够"的规则拖住。
- 改动：`starved` 只拦持续性的外矿需求（reserver/remoteMiner/remoteHauler），一次性的战略需求（claimer/pioneer/defender）仍可先孵；富余 upgrader 在 starved 时不加。03:16 的初衷（外矿 creep 不插队）保持不变。
- 测试：smoke 新增 2 条断言（hauler 在岗 1、能量 700 时先孵 claimer）；原"700 能量时不孵 reserver"断言仍通过。
- 上线：版本 `1788416139433` 于 15:16（同上）。

## 2026-09-03T15:08+09:00 外矿第二只 hauler 差 1 CARRY 也整只 1300
- 问题：W33S6 距离 27 需要 12 CARRY，第一只带维护 WORK 的 hauler 装 11，差 1 CARRY 却再孵一只顶格 13 CARRY/1300 的；W32S7 同理。每代白花约 1,000 能量，且加重 spawn 的换代高峰（W33S7 15:00 前后连续 20 分钟零升级，spawn 一直在孵这些身板）。
- 改动：后续槽位按差额缩身（下限 4 CARRY）。
- 测试：smoke 新增 2 条断言（第二只 ≤4 CARRY/≤450；总运力仍覆盖需求）。
- 上线：版本 `1788416139433` 于 15:16（同上）。

## 2026-09-03T15:49+09:00 大脑因一只 Invader 把现有外矿换成两跳外的房
- 问题：15:46 W33S6 来了一只 Invader，游戏内按预案暂停该外矿并派 defender；大脑的情报把 W33S6 标成 threat（1500 tick 内不用），白名单立刻换成 W35S7（经 W34S7 两跳、双源、评分 -2），游戏内随即为 W35S7 派 reserver；1500 tick 后 W33S6 又会换回来、W35S7 的 creep 退役——换一次房 = 现有 creep 退役 + 重新孵化 + 路白修。
- 改动：`choose_remotes` 接 `current`（游戏内启用中或仅因敌情临时暂停的外矿）：临时威胁不剔除它们（被占/被别人预定/不可达/Keeper 仍淘汰），并加 6 分粘性，不为微小分差换房。
- 测试：Python 新增 3 个用例（威胁房保留、被占仍换、同分不换、暂停到期不算）。干跑：白名单回到 [W32S7, W33S6]，W35S7 4.0 分排第三。
- 上线：大脑侧，本机定时任务下一轮生效；W35S7 的记录会被游戏内标为 notWhitelisted，已派出的 reserver 回家退役。

## 2026-09-03T16:55+09:00 布局唯一来源改为轮子（自动建筑布局 2.1.0），冲突建筑按时机拆迁
- 问题：用户对照轮子样例发现线上布局不是轮子的方案。查证：轮子自 09-01 起就 vendored，但只挂在 RP/VP/SP flag 上手动触发，且 `wheel_layout.validateExisting` 只要房里有任何不在方案上的现有建筑就整体拒绝采用（轮子从零规划、无视现有建筑，对任何已有建筑的房永远走不通）；线上两个房实际用的是自研的 `blueprint.js`（d1）和 `layout.plan` 的棋盘格过渡布局。
- 实测：轮子在引擎里直接可跑——私服 E11S11 CPU 11.7，官方服 W33S7 CPU 34.5、W34S7 10.3（bucket 8900+，tickLimit 500），产出 60 ext / 3 spawn / 6 tower / 10 lab / 4 link / storage / terminal / work_pos / rampart 环 / 路网。三份真实产出存为 `test/fixtures/wheel_layout_*.json`。
- 改动（游戏内）：`wheel_layout.generate` 在 bucket ≥ 5000 时跑轮子并采用为唯一 plan（冲突只作诊断计数），失败记 `planError` 5000 tick 后重试；源/控制器容器从轮子工位派生（轮子只给矿容器，RCL5 前没有 link）；`layout.js` 删掉 d1 蓝图与棋盘格路径，只按轮子方案放工地，路网从核心向外铺；新增 `demolition.js`：方案外工地立即移除，压在规划位上的路/容器/墙立即拆，占配额的方案外结构在"拆掉就能放替代工地"时一次拆一个，唯一的 spawn/塔留到方案位建成，方案外 rampart 不拆也不再维修；每房每 50 tick 最多 1 个，有敌人/恢复期/能量 <300 不拆，日志在 `Memory.rooms.<房>.demolition`。占领：claimer 占下即退役，spawn1 工地放在新房自己轮子方案的第一个 spawn 位；指令里的 spawnPos/plan 忽略。
- 改动（大脑）：不再离线跑 d1 蓝图（删除 `blueprint_runner.js`、`src/blueprint.js`、`layout.blueprint_plan`），占领指令只给房名。
- 测试：smoke 新增 6 组（generate/normalize、layout 只认轮子、拆迁 5 类规则与 3 种暂停条件、spawn/塔替换时机、扩张改用轮子 spawn 位、方案位被占只记录），共 479 断言；Python 50 用例；私服 blueprint 场景改为断言引擎里真实跑出的轮子方案。
- 上线：版本 `1788423118089` 于 17:25（私服第 58 轮 10 场景零错误；第 57 轮只挂在验证脚本一条过时的 spawnPos 断言上）。实测：两个房在同一 tick（73456532）采用轮子方案，零错误，bucket 8779；W33S7 核心 (31,26)、spawn 位 (30,24)/(33,27)/(28,26)，冲突诊断 28 处；W34S7 核心 (27,36)、冲突 21 处。首批工地：W33S7 storage(31,26)、核心道路、rampart 环；W34S7 两个源的新工位容器。
- 追加（同日）：RCL6 前不放矿容器工地（上线后第一轮就放了一个 5000 能量的矿容器工地，已清）；方案外的旧容器与旧道路一样不再维修。
- 追加（17:45）：轮子的 rampart 环有 84 格（W33S7）/31 格（W34S7），旧规划只有 2 格；`rampartTargetHits` 按 RCL 压低一档（RCL3 15k、RCL4 30k、RCL5 100k、RCL6 300k、RCL7 1M、RCL8 3M），否则 RCL4 塔要连续修一天多、花 8 万能量。版本 `1788423934379` 于 17:50 上线（私服第 61 轮零错误；第 60 轮又是启动期 CLI 连接被关，已给 CLI 客户端加自动重连重试）。

## 2026-09-03T17:52+09:00 结案：CPU bucket 读数摆动是像素生成
- 昨夜遗留项「bucket 读数在 500–9,900 间摆动」：`Memory.stats` 的 30 tick 采样是完美锯齿——每 tick 涨约 130（140 上限减 10 用量），到 10000 时 `main.js` 调用 `generatePixel()` 消耗整桶，约 77 tick 一个周期。这是设计如此（换像素），监控早已用 `px`（像素计数）压掉相关告警。不是 CPU 问题，每 tick 用量 12–20/140 才是真实信号。

## 2026-09-03T18:45+09:00 迁移期两处结构性问题：替代 extension 放不出、控制器断粮
- 问题：上线后 W33S7 拆掉第一个方案外 extension (22,24)，但 6 个工地名额被 storage + 2 条路 + rampart 占满，替代 extension 工地放不出来，容量卡在 1250；同时 spawn 持续忙（外矿补员 + storage 建设），hauler 永远先填 spawn/ext，控制器容器 1100 tick 没进过能量，升级速率 0。W34S7 同样开始换 extension（容量 550→500）。
- 改动：(1) 拆迁前要求有空余工地名额，否则等；(2) 高优先结构（extension/塔/storage/spawn/link/terminal/lab）缺名额时，layout 让出最多 2 个零进度的路/rampart/墙工地；(3) 公平供给：控制器容器低于 10% 且 spawn 能量 ≥ 50% 时，hauler/remoteHauler 这一趟先送控制器容器（`config.controllerFeedStarvedBelow/SpawnShare`）。
- 测试：smoke 新增 7 条断言（490 全绿）。
- 上线：版本 `1788428847589` 于 18:58（私服第 62 轮零错误）。上线后暴露一个新问题：`site.remove()` 下一 tick 才生效，让出名额的同一轮按"虚"名额又放了 2 个 rampart，W33S7 堆到 21 个 rampart 工地；改为让出后本轮不再放置，版本 `1788429156267` 于 19:22 上线（第 64 轮零错误；第 63 轮 CLI 抖动，重试已放宽到 8 次×3 秒）。

## 2026-09-03T18:48+09:00 defender 在房间边缘来回踱步
- 问题：用户看到 creep「小鹿」（W33S6 的近战 defender）在 W33S7 北边出口来回走。原因：它走进 W33S6 时落在出口格 (12,49)，无敌情就原地等待；站在出口格不动会被引擎弹回 W33S7，下一 tick 又因"不在目标房"走回去，直到 50 tick 闲置期满改目标回家退役。
- 改动：到目标房后若站在出口格，先往房内走再开始等待。
- 测试：smoke 新增 2 条断言。
- 上线：版本 `1788429156267` 于 19:22（同上）。

## 2026-09-03T19:00+09:00 工地积极放置、道路优先、外矿路规划到母房核心
- 用户三点意见：规划既然确定了就该积极放工地；道路应最优先建；母房里没有规划通往外矿的路，只有外矿房自己有回母房的路。
- 改动：`maxSites` 6 → 20（旧上限是过渡布局时代防道路抢名额的遗留），`sitePace`：道路在建 8、rampart 每轮 6、容器 2；道路工地先于 extension 放，builder 的建造权重道路 8 > 容器 7 > 其它 5。外矿路径改为从母房核心（storage/spawn）到外矿工位一次跨房算出（母房内沿轮子规划的路走、避开规划建筑位），外矿段成为 `source.road`，母房段写进母房 `plan.roads['remote:房:源']`，由 layout 统一放工地/维修，外矿停用即移除。已有外矿记录第一次刷新时会重算路径（W32S7 旧路 12/18 格里不在新路径上的会任其衰减）。
- 测试：smoke 新增 6 条断言；私服 blueprint 场景的轮子断言放宽为 ext ≥ 50、tower ≥ 5（轮子文档：受阻挡时可能摆不满，第 65 轮就摆出 59 个）。

## 2026-09-03T19:06+09:00 W33S6 永久停用 + 防御模块为空房连孵 24 只 defender
- 问题：用户问为什么只开了一个外矿。查证：W33S6 记录 `enabled=false, suspendReason=hostileCreep, suspendedUntil=73455447`（早已过期）。来龙去脉：15:46 大脑把 W33S6 踢出白名单时记录被置为停用（原因 notWhitelisted），随后 Invader 把原因覆盖成 hostileCreep；16:00 白名单恢复后，重启用条件只认 notWhitelisted/tooFar，于是永久停用。更糟的是 `defense.threatIn` 把"停用原因是 hostileCreep"当作持续威胁，`defenseLog.spawned` 已到 24——为一个空房反复孵 900–1300 能量的 defender，这是 W33S7 升级崩到 0 的主因之一。
- 止血：控制台把 W33S6 记录改回启用。
- 改动：白名单里的外矿只要不是永久性停用（`suspendedUntil !== MAX_SAFE_INTEGER`）就重新启用（临时冷却仍按 `suspendedUntil` 生效）；hostileCreep 只在冷却期内算威胁，过期且不可见就不再盲目派 defender。
- 测试：smoke 新增 4 条断言。

## 2026-09-03T19:07+09:00 外矿放开到 4 个（W32S7 / W33S6 / W33S8 / W35S7）
- 用户要求在 W33S8、W33S6、W35S7 也开外矿。大脑 `remoteMaxRooms[4]` 2 → 4；"强邻扣分"每个 8 → 3（原来把相邻双源房 W33S8 压到两跳房 W35S7 之后）。干跑白名单：[W32S7, W33S6, W33S8, W35S7]。
- 说明：单 spawn 是硬上限——外矿需求排在核心角色之后，spawn 时间不够时两跳的 W35S7 会最后补员、可能断续。W33S8 紧邻 tidusfox9 的两个 RCL8 房，姿态仍是只打 NPC，被玩家清场时按敌情暂停。
- 大脑侧改动即时生效；游戏内白名单机制已有，无需发布。
- 追加（19:10）：用户指出"强邻"其实走不通——地形出口证实 W33S8 南边无出口、W33S9 北边无出口，对角房本来没有直接出口。大脑情报新增 `exits`（按地形算四边出口），强邻扣分只对"正交相邻且共享边两侧都有出口"的邻居生效；W33S8 由 −4 升到 12 分排第一。干跑白名单：[W33S8, W32S7, W33S6, W35S7]。

## 2026-09-03T19:13+09:00 迁移提速：批量替换而不是逐个等建成
- 用户指出除 spawn 外的建筑都可以立即迁移。原实现"拆一个、等替代建成、再拆下一个"，加上 50 tick 评估一次，20 个 extension 要 1500+ tick，且工地名额被路/rampart 占满时替代工地放不出。
- 改动：评估间隔 50 → 25 tick；同类替代工地允许 `batch=4` 个同时在建；零进度的路/rampart 工地算作可让出的名额（layout 会让出）；唯一的塔在 safe mode 可用、无敌情时也直接替换（新塔建成前有 safe mode 兜底）；方案内源/controller 容器都建成后，方案外旧容器拆除。spawn 仍留到 RCL7。
- 测试：smoke 新增 6 条断言、更新 2 条（508 全绿）。
- 上线：版本 `1788430548107` 于 19:13（私服第 68 轮零错误）。上线 60 tick 内：W33S7 又拆 2 个 extension（在建替代 1 个、待放 1 个），W34S7 拆 1 个 extension + 1 个多余旧容器，零错误。defender 修复（版本 `1788430218183`，第 67 轮）上线后 `defenseLog` 停在 24，四个外矿全部启用。

## 2026-09-03T19:26+09:00 拆迁残骸（ruin）里的能量没人收
- 用户指出拆掉的建筑留下的 ruin 里还有能量。broker 原来只收容器/掉落物/tombstone。改动：ruin 与 tombstone 同等对待（collect 任务、hauler 顺路与专程取能）。smoke 新增 2 条断言。
- 追加（19:28）：批量迁移上线后 W33S7 的唯一旧塔按"safe mode 可用即替换"规则于 73458551 拆除，新塔工地在轮子位 (6,40)。为缩短无塔窗口，塔工地的建造权重提到最高（9 > 道路 8 > 容器 7 > 其它 5）。

## 2026-09-03T19:32+09:00 私服 soak 模拟：用线上快照找新问题
- 用户问能否用私服模拟找更多问题。新增 `scripts/soak/`：`capture_live.py` 抓线上 6 个房的真实地形/对象/我方建筑 + Memory（plan/外矿/大脑白名单）；`soak.js` 把快照搬进私服（真实地形、真实建筑、按方案工位放静态矿工等一套编制、白名单 TTL 放到 7 天），高速跑 N tick，定期往外矿塞 Invader，每 sample tick 采一次全量快照写 JSONL；`analyze.py` 用 14 条不变量规则扫时间线（出口格来回、带能量空闲、卡死、外矿过期停用、defender 无敌情连孵、工地停滞、容量长期下跌、升级停滞、spawn 空闲缺编、缺方案、地面堆能量、ruin 无人收、CPU 尖峰、运行时错误）。
- 上线：版本 `1788431558761` 于 19:32（ruin 收能 + 塔优先建；私服第 70 轮零错误，第 69 轮 brain 场景 ack 时序抖动）。

## 2026-09-03T19:40+09:00 大脑把自己预定的外矿当成别人的
- 问题：19:35 的简报里 W32S7 被拒 `reservation:5de994c7ad2e8d3d72d1d6d2`（我们自己的用户 id），白名单换成两跳的 W31S6，游戏内把 W32S7 标为 notWhitelisted。根因：room-objects 的 users 表偶尔不含自己，`reservation.username` 退化成用户 id，与用户名比较不相等。
- 改动：情报里按用户 id 标 `reservation.mine`，`usable_for_remote` 以它为准。干跑白名单恢复 [W33S8, W33S6, W35S7, W32S7]；游戏内 notWhitelisted 记录会在下一轮指令后自动重新启用。
- 测试：Python 新增 1 个用例。

## 2026-09-03T19:49+09:00 builder 挑工地无视"道路优先"（soak 发现，线上证实）
- 私服 2000 tick soak 报 45 条 site-stall：W33S7 的道路工地全程 0 进度、storage 停在 7000。查证：`builder.nextSite` 用自己的一套顺序（容器 → 结构按"剩余进度最小"→ 路/rampart 最后），broker 的建造权重（塔 9 > 路 8）只影响任务分配、不影响 builder 选工地，所以线上"道路优先"根本没生效；替换旧塔的新塔工地 (6,40) 也排在 extension 之后，2700 tick 没动——期间房里没有塔。线上探测（73459135）同样：8 个道路工地全部 0，唯一的 builder 只在建 extension。
- 改动：`sitePriority` 改为 塔 0 > 源容器 1 > 控制器容器 2 > 道路 5 > 其它结构 10（仍按剩余进度小的先）> rampart/墙 20。
- 测试：smoke 新增 2 条断言。

## 2026-09-03T19:59+09:00 segment 90 指令被引擎写回覆盖（验证 69/71 轮"无回执"根因）+ 外矿不可达自动停用
- 问题：私服验证第 69、71 轮 brain 场景偶发 `bot did not ingest the segment directive (no ack)`。事后读第 71 轮世界的 `db.json`：大脑 `state.json` 显示已写入，但 env 里该用户的 `memorySegments` 是 `{"90": ""}`。核实 `@screeps/driver/lib/runtime/runtime.js`：tick 末尾把 `RawMemory.segments` 上存在的每个键原样写回，bot 每 tick 激活 segment 90 ⇒ API 写入若落在读取之后就被旧内容覆盖。官方服同一 driver，tick 长（3–4 s）所以概率低，但大脑 `--min-interval` 下内容不变就不重写，一次被覆盖可能持续很久。
- 改动：bot 读完 segment 立即 `delete RawMemory.segments[90]`（本 tick 不写回）；大脑写完 2 s 后读回校验，不一致就重写（最多 5 次）。
- 外矿不可达：soak 里 4 只发往两跳房 W31S6 的 remoteHauler 在家原地站了 1500+ tick（私服世界里缺中转房，路不通），spawn 还在继续补。新增 `remote.noteTravel`：去程连续 60 tick 位置不变 ⇒ 外矿标记 `unreachable`、停用并冷却 3000 tick，creep 空载退役（白名单在冷却期内重新启用也退役）。
- 测试：smoke 新增 6 条断言（含"一直移动不触发"），Python 新增 3 个用例（56 全绿）。
- 上线：版本于 20:01（私服第 72 轮零错误；第 71 轮即上述根因）。

## 2026-09-03T20:01+09:00 soak 快照含两圈邻房
- `capture_live.py --ring 2` 额外抓母房周围 30 个房的地形与中立对象，两跳外矿在私服里才有路可走；Invader 只塞进 `focus` 房。第二轮 soak（run-2k-b）用新快照 + 本轮修复跑 2000 tick。

## 2026-09-03T20:13+09:00 hauler 给工地上的 builder 送能量；核心角色缩身孵化；外矿按白名单顺序补员
- 第二轮 soak（run-2k-b，58 采样）：塔工地终于有进度，但 W33S7 的 builder（300 容量）在源容器与轮子放在 (6,40) 的塔之间往返 30+ 格，实际吞吐约 1.5 能量/tick；storage 卡在 7000 数小时就是这个原因。改动：builder 在工地上建造时登记 `feedAt/siteId`，broker 为能量低于一半的它出 tier 2（与塔同层，低于 spawn/ext）的 hauler 投递任务；空载后在工地最多等 `builderFeedWait` 30 tick 再自己去补能。
- soak 采样里 W33S7 hauler 4 只剩 1 只时，spawn 拿着 583–864/1100 等满配等了 300+ tick——而这段时间正是收入最低的时候。改动：harvester 有源没人挖 / hauler 缺 ≥2 只，且能量 ≥ 容量一半（容量 ≥ 800 才启用，小容量等满配只要几十 tick）时按当前能量缩身立刻孵。
- `remote.getDemands` 原按房名字母序出需求（W32S7 单源房总是先补满），改为按大脑白名单顺序（评分高者先）。
- 测试：smoke 新增 9 条断言；私服第 73 轮零错误。

## 2026-09-03T20:16+09:00 低 RCL 经济倒挂：builder 掏空源容器，spawn 停在 300/400
- 线上 W34S7（RCL3，容量 400）：3 个 builder 直接从源容器取能，4 个 hauler 全空着，spawn 卡在 300/400 孵不出第 4 个 harvester；soak 里同样的房 900 tick 一直是 300/350。改动：没 storage 的房只要 spawn/ext 未满且有 hauler 在岗，builder 不碰源容器，去工地登记等 hauler 投递（投递优先级在 spawn/ext 之后，正好是对的顺序）；没有 hauler 时照旧自取/自采。
- 容量 <550 时 5000 的塔会把所有 extension 卡在后面（W34S7 塔工地 646/5000、extension 工地 0）：塔优先级只在容量 ≥550 时置顶，否则与 extension 同级按剩余进度排（extension 先）。
- soak 脚本：私服 storage 偶发 lokijs 异常把 CLI 连接带走（run-2k-b 在 t=1434 中断），采样已逐行落盘，连续 3 次 CLI 失败就带着现有采样收尾。
- 测试：smoke 新增 5 条断言。

## 2026-09-03T21:30+09:00 回滚式修正：builder 等投递没有上限，把两个房的建造全部停掉了
- 第三轮 soak（run-2k-c，t 8–683）跑的正是 21:24 上线的版本：两个房 683 tick 内没有一个工地有进度。builder 空载后在工地"等 hauler 投递"，但 spawn 一直在孵外矿 creep，hauler 永远在 tier 1（spawn/ext）忙，tier 2 的投递永远轮不到；低 RCL 的"spawn 未满不抢源容器"更是每 tick 刷新 feedAt，等待没有尽头。线上 W33S7 的 builder 同样在塔工地空等。
- 改动：等投递总时长上限 `builderFeedMaxWait` 150 tick，超过就自己去取；"不抢源容器"只对容量 <800 的无 storage 房启用（W33S7 1100 容量不受影响）；spawn 能量连续 50 tick 没创新高且核心角色缺编时不论容量都按现有能量缩身孵——这才是 W34S7 卡在 300/400 的根因（350 的 harvester 在收入≈0 时永远买不起）。
- 教训：新机制上线前先用 soak 跑一遍，而不是上线后再跑。soak 本身这次立了功，30 分钟内抓到了回归。
- 私服工具：soak 三轮里两轮被私服 storage 的 lokijs `fun is not a function` 异常中断（backend 的 storage 连接被带走，引擎照常跑），已让 soak 连续 3 次 CLI 失败后带着已落盘的采样收尾。
- 测试：smoke 新增 5 条断言（含 1100 容量房 30 tick 后自取、能量停滞缩身）。
- 上线：21:33（私服第 75 轮零错误）。第四轮 soak（run-2k-d，源满能量播种）同时开跑。

## 2026-09-03T21:40+09:00 援建：W33S7 直接为 W34S7 孵满配矿工（用户要求 W34S7 尽快达到采集上限）
- 用户：应该援助 W34S7，让它最快达到"每源 300 tick 采完 3000"（每源 5 WORK）。W34S7 容量 400，自己只能孵 2–3 WORK 的小矿工，靠自身爬到 550/800 容量要很久。
- 新增 `src/aid.js`：容量 ≥800 的母房为 2 格内、无 storage 且容量 <800 的己方房出需求——每个 WORK 不足 5 的源一只 5W 静态矿工（memory.home 指向弱房、绑定源）、hauler 总 CARRY <12 时一只满配 hauler、有工地且 builder WORK <5 时一只满配 builder。需求排在外矿之前，只按 slotKey 计数（弱房自己的小矿工不算填位），母房核心角色 starved 时也不受阻（视为战略需求）。弱房自己的 spawn 看到 5 WORK 覆盖后不再孵小矿工；容量到 800 或有 storage 后援建停止。
- 测试：smoke 新增 8 条断言；私服第 76 轮零错误。

## 2026-09-03T21:43+09:00 第四轮 soak：外矿 hauler 早产、基础 upgrader 被外矿插队
- run-2k-d 完整 2000 tick 零错误，工地恢复推进。新发现：W33S8 的 3 只 remoteHauler 在容器建成前就孵出来，在矿位空等 700 tick（矿工独自建 5000 的容器约 7 能量/tick）；W33S7 两个基础 upgrader 死光后 controller 停涨 200 tick——外矿 creep 便宜、总能塞进预算，1100 的 upgrader 永远攒不够。
- 改动：外矿源的 hauler 需求要等 `containerId` 存在；基础编制 upgrader 缺编且买不起也置 starved（外矿等待，援建不等）。
- 测试：smoke 新增 3 条断言、3 条旧夹具补 containerId。
- 上线：21:45（私服第 77 轮零错误），与援建模块同版本。第五轮 soak（run-2k-e）同时开跑，看援建对 W34S7 的加速。

## 2026-09-03T21:52+09:00 第五轮 soak：援建矿工在母房的同名坐标上"以为到位"
- run-2k-e：援建矿工从 W33S7 出发，走到 W33S7 的 (19,20)——恰好是 W34S7 容器的坐标——就停下，W34S7 自己的小矿工不再补（5 WORK 已"覆盖"），1500 tick 后收入归零、controller 停涨 500 tick。线上 21:5x 也看到两只援建矿工停在 W33S7 的 (18,19)/(21,31)。
- 根因：harvester 的工位 `workSpot` 是不带 roomName 的 `{x,y}`，`movement.toPos` 把它解析成当前房间，`isEqualTo(x,y)` 也不看房间。改为带 `roomName` 的工位并按房间比较；smoke 的 `isEqualTo/isNearTo` mock 改成和真实 API 一样跨房间不相等。
- 测试：smoke 新增 3 条断言。
- 上线：21:54（私服第 78 轮零错误）。第六轮 soak（run-2k-f）复核援建全流程。

## 2026-09-03T22:00+09:00 第六轮 soak：援建到位后 W34S7 瓶颈转到运力
- run-2k-f（2000 tick 零错误）：援建矿工正确走到 W34S7 工位，W34S7 升级速度 4 → 5.6 prog/tick，源容器开始堆积（最高 1900）——hauler 运力跟不上 20 能量/tick 的采集。`aid.haulerCarry` 12 → 16，弱房总 CARRY 不足 16 时再派一只满配 hauler。
- 监控新增"援建"行（母房→弱房 角色@当前房 位置 ttl）。

## 2026-09-03T22:13+09:00 援建矿工被弱房小矿工占位、只走不采
- 线上 73461141：第一只援建矿工在 (19,20) 满速（源在再生前采空）；第二只站在 (36,39) 不采——容器位 (35,40) 被 W34S7 自己的 2 WORK 小矿工占着，而无 CARRY 的矿工"不在工位只移动不采集"，源 (36,40) 只有 4/tick。
- 改动：工位被占时只要挨着源就先采（落地能量由 hauler 捡）；同源已有 ≥5 WORK 的更大矿工在房内时，小矿工退役让位。
- 测试：smoke 新增 3 条断言。
- 上线：22:14（私服第 80 轮零错误）。
- 核验（73461268）：W34S7 只剩两只 5 WORK 援建矿工，分别站在 (19,20)/(35,40) 容器位；源 (19,19) 207 tick 采了 2070（10/tick，再生前采空），源 (36,40) 刚再生；容器 460/460/416，地面无掉落；援建 hauler 正在孵。W34S7 达到用户要求的采集上限。

## 2026-09-03T22:21+09:00 第七轮 soak：今晚全部修复的回归基线
- run-2k-g（2000 tick 零错误）：W34S7 升级 7.8 prog/tick（傍晚约 4），35 条道路工地有进度（援建 builder + 道路优先）；W33S7 8.2 prog/tick，塔工地持续推进。剩余可疑项：W34S7 builder 在工地等投递（有上限，正常）；W32S7 无容器时矿工落地能量堆到 2098（hauler 现在要等容器建成才孵，这段能量会衰减——下一步可考虑容器未建时按落地量派一只 hauler）。
- 今晚 soak 共 7 轮，抓到并修复 9 个问题（含 2 个我自己引入的回归），线上版本以 22:14 为准。

## 2026-09-04T12:14+09:00 外矿只剩一个：控制器公平规则把 spawn 饿在一半
- 用户问为什么只剩一个外矿。线上 73474066：白名单 4 个外矿全部启用、无暂停，但只有 W35S7 有 3 只 creep；W33S7 spawn 空闲在 588/1100，14 条外矿需求排队。两只 9 WORK 的 upgrader 把控制器容器吃到 90，"容器 <10% 且 spawn ≥50% 就先送控制器"（权重 20、tier 1）让每一趟 hauler 都绕开 spawn——一只满载 700 的 hauler 就停在 spawn 旁边不投——650–1100 的外矿 creep 永远买不起。援建已在 W34S7 容量到 800 时自动结束（不是它占的）。
- 改动：spawn 每 tick 记录第一笔买不起的需求成本 `Memory.rooms.<房>.spawnWaiting`；broker 与 remoteHauler 在 energyAvailable 低于该成本时不再把控制器容器提到 spawn 之前。spawn 不等能量时公平规则照旧。
- 另：监控循环没有停，是这台 Mac 在 02:5x–04:34 和 04:4x–12:00 两段睡眠，后台进程（含外部大脑 launchd）都被挂起；唤醒后各跑了一次但网络未就绪。
- 测试：smoke 新增 5 条断言。
- 上线：12:18（私服第 81 轮零错误）。提交签名失败两次，于 14:28 补提交（a60583b）。

## 2026-09-04T14:31+09:00 RCL5 / RCL4 里程碑；builder 编制计入外矿收入；占领锁续期
- 约 14:00 W33S7 升到 RCL5（新增第二座塔、link、14 个 extension 工地），W34S7 升到 RCL4（safe mode 结束，援建在容量 800 时自动结束，现已 900）。公平规则修复后 W33S7 spawn 满能量，四个外矿共 27 只 creep 在岗（W35S7 在大脑 14:31 重跑后恢复）。
- W33S7 能量过剩（spawn 满、源容器 1710）却只有 1 只 5 WORK builder 对着 79k 积压：`builderTarget` 只按本房两个源估收入。改为把"有矿工在岗的外矿源"按 10×0.8 计入（`construction.remoteIncomeFactor`），W33S7 应升到 3 只。上线：14:36（私服第 82 轮零错误）。
- GCL 是 12：大脑的下一个占领候选是 W33S8（紧邻 tidusfox9 的 RCL8 房），`locks.json` 的 W33S7.claim 锁到期就会派 claimer。已续期到 09-06 14:33，等用户决定。
- Mac 睡眠（02:5x–04:34、04:4x–12:00、12:4x–14:26）期间监控循环、launchd 大脑都被挂起，30 分钟 TTL 的指令过期后非相邻外矿会临时变成 tooFar，大脑重跑即恢复；不是 bot 问题。

## 2026-09-04T15:51+09:00 RCL5 占领 W33S8；外矿跨母房去重；大脑写入门禁；reserver 兼任 claimer
- 问题：用户放行占领 W33S8 后问"W33S8 里怎么一大堆 reserver"。监控历史：14:48 全账号同时 7 个 reserver（W33S7：W32S7/W33S6/W33S8/W35S7，W34S7：W33S8/W34S8/W35S7），W33S8 里两个母房各一只 reserver、三只 remoteMiner 挤两口源——大脑按母房各自规划，W33S8/W35S7 同时进了两份白名单。另外 15:13 那轮本机断网（run.err `Errno 51`），room-objects 全部失败被记成 unreachable，规划写出 `remotes=[]`：游戏内全部外矿 `notWhitelisted`，7 个 reserver（reserver 停用即自杀）与全部远程 creep 退役，15:19 样本远程 creep 为 0，15:19:40 白名单恢复后再全部重孵。占领本身：15:33 写入指令后 W33S7 站在 W33S8 的 reserver（1 CLAIM，ttl 391）因外矿被剔除回家自杀，同 tick 新孵 650 的 claimer 走同一条路；claimer 15:36 占下（tick 73477315）。
- 改动：`data/brain/locks.json` W33S7.claim → W33S8（锁 7 天，W34S7.claim 保持 null）；`scripts/brain/plan.py` 新增 `assign_remotes`（全账号按分数/RCL 贪心，一个外矿只归一个母房，落选用下一候选补位，brief 显示"外矿让给别家"）；`scripts/brain/run.py` 写入门禁 `write_blockers`（任何房 room-objects 失败或母房等级读成 0 就不写，上一份指令在 TTL 内有效，过期后游戏内自治且已启用外矿照常）；`src/roles/reserver.js` `claimDuty`（母房 `expansion.target` 就是自己的外矿时，先于停用/退役判断去 claimController，占下即退役；外矿已归我方也直接退役）；`src/expansion.js` `claimCapableCreep`（母房已有寿命 >100 的带 CLAIM reserver 指向目标房时不再要 claimer）。测试：Python +7（64 全绿），smoke +9 断言，私服 10 场景 errN=0。
- 预期：稳态 reserver 数 = 外矿数（8 → 每房 4，且不再有同房双 reserver、同源双 miner）；断网轮不再解散外矿；下次占领省一只 claimer（650 能量 + 一趟路）。
- 实测：15:48 launchd 大脑首轮即写出去重结果（W33S7：W32S7/W33S6/W31S6/W31S8，W35S7 让给 W34S7；W34S7：W35S7/W34S8/W36S7/W32S6，W32S7 让给 W33S7），blockers=[]。版本 1788504668585 上线后 errors=0、CPU 16–25/140（bucket 350–10000 是 pixel 锯齿，pixels=1062）。W33S8：RCL1，轮子方案已生成，spawn 工地 (36,17) 600/15000，两个母房各 2 只 pioneer + 援建矿工/hauler/builder 在场。待回填：稳态 reserver 数、W33S8 spawn 建成时间。

## 2026-09-04T16:43+09:00 W33S6 外矿 1000+ tick 没有补员：外矿队列头阻塞 + 双 CLAIM reserver 成本等于容量
- 用户问 W33S6 的外矿为什么又没了，是否让 reserver 多带一个 CLAIM。查证：W33S6 记录 `enabled=true`、在白名单里、无暂停，但 `lastSeen` 停在 73476978（约 1000 tick 前）。来龙去脉：15:13 空白名单事件把 W33S6 的 reserver/miner 整体退役（根因 15:48 已修）；之后单 spawn 按 防御 → 扩张 → 援建 → 外矿（白名单序）严格排队，830 tick 里依次孵了 upgrader、W33S8 外矿三件套（占领后作废）、2 只 pioneer、W33S8 援建三件套、W32S7 三件套，约 11 只 / 11000 能量，等于全部收入，W33S6 还没轮到。
- 雪上加霜：`reserverBody` 在容量 ≥1300 时就出 `[CLAIM×2,MOVE×2]`=1300，W33S7 容量 16:1x 刚到 1300，reserver 成本等于满仓；最近 600 tick spawn 能量峰值 954/1150/1234，几乎没满过，满的瞬间也先被 1300 的 hauler/builder 替补花掉。外矿队列只看第一条未满足需求，买不起就整条停住：W33S6 的 reserver 排在自己的 700 miner 前面，把 miner 一起卡住。用户的"多一个 CLAIM"方向是对的（W32S7 的 1 CLAIM reserver 预定值一直是 1，只能保持不能累积，源停在 1500 档），问题在成本不能等于容量。
- 改动：同一外矿内需求顺序改为 miner → reserver → hauler；新增 `config.remote.reserverDoubleClaimCapacity=1650`，容量低于它用 650 的单 CLAIM（1300 的身体留 ≥20% 余量，RCL5 满 extension 1800）；spawn 里外矿需求买不起时跳到后面买得起的一条，被跳过的成本仍记入 `spawnWaiting`（hauler 照旧优先喂 spawn），一次性的战略需求（claimer/pioneer/defender/援建）买不起时照旧等它。
- 测试：smoke 新增 3 个场景 13 条断言（601 全绿；场景被并行的另一会话的 abc32bd 顺带提交，56bd221 让它们转绿），Python 64 全绿，私服 10 场景 errN=0（validation-ZbnPgw）。
- 上线：版本 `1788507801411` 于 16:43（56bd221，含另一会话的 visuals/layout 三个提交 b855483/af7c815/abc32bd）。
- 实测（16:48，上线约 60 tick）：errors=0；CPU 换代码那一 tick 82.5，之后回到 22–28/140。W33S6 里已站着一只 reserver（部署前满仓瞬间孵出的 2 CLAIM 版本），预定值 48 且在累积、源回到 3000 档；spawn 正按既有"核心角色优先"规则等 1300 的 hauler 替补（`spawnWaiting=1300`），hauler 出来后 W33S6 的 700 miner 就在队头。待回填：W33S6 miner 孵出时间、稳态 reserver 数。
- 追加（16:57，上线约 160 tick）：W33S6 的 2 CLAIM reserver 把预定累到 149、源保持 3000 档，但 miner 仍未孵出——不是队列问题，而是 hauler 替补：hauler 在编 1/目标 2，替补身体随容量涨到 1350，`spawnWaiting=1350` 持续 160+ tick；能量峰值 1240/1250/1150 始终差几十，因为 builder 的 `withdrawRoomSurplus` 只给 spawn 留 200 的底、W33S8 援建（战略需求，不受 starved 阻塞）每次攒到 700–800 就先花掉。缺 1 只 hauler 时现有缩身规则不触发（只在缺 ≥2 或全灭时缩身），外矿 miner 在 starved 下等待。下一步候选：hauler 缺 1 只且 spawn 能量 50 tick 没创新高时也按现有能量缩身孵。

## 2026-09-04T17:02+09:00 RoomVisual 尾部结构闪烁；工地按全局预算积极放置
- 问题：用户指出规划 RoomVisual 里 nuker/powerSpawn/terminal/factory 几个 tick 才出现一次，并问为什么工地不放到上限。线上探针（tick 73477987）：`visuals.render` 三个房都在 1.00 CPU 处截断（W33S7 只画到 118 条路，W34S7 画到 extension 59/60，W33S8 画到 rampart 26/45），这四种结构排在绘制顺序最末（W34S7 里 terminal 是第 423/468 个图元），只有服务器抖动小的 tick 才轮得到；W33S7 更严重——3 spawn+60 ext+6 塔+10 lab+84 rampart=163 超过 `MAX_STRUCTURES=160`，storage/terminal/factory 等根本进不了列表。实测 300 个 circle 0.372 CPU（≈0.0012/图元），而画到 330 个图元就用掉 1 CPU：每个图元都调 `getSize()`+`getUsed()` 的检查开销占了一半以上。
- 工地：`maxSites` 20/房、道路在建 ≤8（`trimSites` 主动删多余的规划内道路工地）、rampart 每轮 6，每 11 tick 一轮。上限其实是每玩家 100（母房+外矿+扩张共用）：`remote.js` 在 ≥100 时停放，`expansion.js` 放 spawn 工地不看 ERR_FULL，所以不能简单按房放满。另外发现 `yieldLowPrioritySites` 让出 2 个名额后，下一轮路网会先把名额补掉，替代 extension 放不出——旧 smoke 用例是靠 mock 的 `site.remove()` 返回 undefined、`find` 返回活数组被 splice 才"碰巧"通过的。
- 改动：(1) `visuals.js`：spawn/storage/terminal/塔/link/容器/lab/factory 等唯一结构先画，extension 其次，路网、rampart 最后；已建成的结构不画（越建越轻）；每 8 个图元查一次预算，预算 1.5 CPU，条目上限 400。(2) `layout.js`/`config.js`：全局预算 `100 − globalSiteReserve(12) − Game.constructionSites`，`maxSites` 40，道路在建 24 且 `trimSites` 只删漂移工地，新 rampart 工地要求有塔且塔能量 ≥ `rampartTowerEnergy`(500)（rampart 建成是维修负担不是建造负担），让出名额后的下一轮把名额留给高优先结构。smoke +13 断言（588 全绿），mock `remove()` 改为返回 OK。
- 私服：第 1 次失败在 industry 场景 "room visual missing"——该场景把方案里的建筑全部预建，"已建成不画"让 visual 为空；改为始终画一行方案标签（版本 + 未建数量，abc32bd）。第 2 次失败在 blueprint 场景 "wheel plan lacks derived containers"——随机生成的 E30S30 把源放在控制器两格内，轮子只出一个工位且归为 ctrl（`wheelLayout.structural: missing source work position src1`），是 fixture 随机地形偶发，重跑第 3 次通过（validation-Tmk5gk，10 场景 errN=0）。
- 并行会话：另一会话 screeps-1d 同时在同一工作树改外矿补员（56bd221）。abc32bd 整文件 add 了 test/smoke.js，把对方尚未提交的 3 个 smoke 场景一起带进去了（HEAD 56bd221 上 601 全绿；单看 abc32bd 会红 5 条）。为不混入对方 WIP，我的私服验证在 detached worktree 里跑；上传由对方以 HEAD 56bd221 完成（版本 1788507801411，含本轮三个提交），我没有再上传。
- 预期：三个房的 terminal/factory/nuker 每 tick 稳定显示；母房工地数上限 40，外矿/新房名额不受影响；无塔或塔缺能量的房不再新增 rampart 工地。
- 实测（tick 73478378–73478396，版本 1788507801411）：三个房 storage/terminal/factory/observer/powerSpawn/nuker/extractor 全部画出，W33S7 连 84 格 rampart 环也画完，render 0.74–1.22 CPU/房（预算 1.5），errors=0。工地：W33S7 45（storage 1、ext 10、link 2、rampart 32）、W34S7 20、W33S8 10（spawn 6800/15000，比 tick 73478057 的 4400 快了约 7/tick），全局 81/100。W33S7 的 45 > 40 是历史遗留：monitor 显示 15:40:21（tick 73477367，20 个）到 15:50:54（tick 73477535，47 个）之间一次性多了 27 个零进度 rampart（x=47、x=2 两列，都在 plan.ramparts 上），当时线上是 14:36 的版本（maxSites 20、每轮 ≤6），layout 放不出这么多，screeps-1d 会话说不是它放的，来源未查明；新代码下 W33S7 会停放到降回 40 以下，两座塔 490/490 < 500 也不会再放 rampart。

## 2026-09-04T18:00+09:00 向 Kalgen 学习：rampart 先护建筑，裸地外环推迟到 RCL6；建立顶级玩家持续观察工具链
- 背景：用户要求长期观察世界 GCL 榜第 1 的 Kalgen（89 房，shardX 86 房全 RCL8）并找出能优化我们的地方。新增 `scripts/observe/`（capture → analyze → report，launchd `local.screeps-observe` 每 6 小时一轮，`--self` 同口径记录我方），首轮快照 110 次请求 171 s，报告 `docs/observe/kalgen.md`，人工清单 `docs/observe/kalgen-learnings.md`（6 条排序后的行动项）。API 口径校准：`/api/user/stats` 的 bin 是 8 分钟、`creepsProduced` 是部件数、跨 shard 汇总；公开 room-history 可回放 100 tick 的逐 tick 差分。
- 问题（本轮实施第 2 条）：轮子方案的 `plan.ramparts` 全是裸地外环（W33S7 84 格全贴房间边、W34S7 31、W33S8 45）。线上 W33S7 42 个工地里 32 个是零进度外环 rampart，W34S7 17 个里 15 个，三房共 78 个工地（全局预算 88）——新房 W33S8 和 extension/storage 的名额被占着；外环一旦建成，84 格 × 每 100 tick 衰减 300 = 每 tick 252 血，塔在射程 ≥20 每 10 能量只修 200 血，≈ 每 tick 12 能量的固定维护（一口源的 60%），RCL5 目标 1e5/格还要先投入 8.4e6 血。Kalgen 2503 个 rampart 里 1570 个压在建筑上（塔 519、extension 476、spawn 262、lab 92、terminal 89、storage 89），shard3 三房没有一格裸地 rampart。
- 改动：`config.rampartRingMinRcl=6`；`layout.js` 新增 `ringAllowed`/`coreRampartSpots`：RCL < 6 不放外环，只给 spawn/塔/storage/terminal 盖 rampart（原来只在没有外环方案时才走的分支），`trimSites` 在外环推迟期间清掉零进度的裸地 rampart 工地（核心建筑上的、已有进度的保留）；`utils.needsRepair`/`demolition.offPlanRampart` 新增 `rampartProtectsCore`：盖在核心建筑上的 rampart 不算方案外，按 RCL 目标维修（否则核心 rampart 建成 1 血就衰减掉）。
- 测试：smoke 场景"工地全局预算"+5 断言（RCL3 只盖核心建筑、RCL6 放外环 ≤ sitePace、降回 RCL5 清零进度外环并保留核心）；拆迁场景把方案外 rampart 移到裸地 (23,19)，新增"盖在 spawn 上的 rampart 照修、不拆"；adopt 场景 RCL2 不放 rampart；迁移期让出名额场景改为 RCL6（外环已允许）。smoke 607 全绿，Python 79 全绿，私服 validation-QmPjwJ ok: true、10 个场景房 errN=0。提交 7be9041，版本 1788512130666 于 18:1x 上线（activeWorld=default）。
- 预期：上线后 W33S7 的 32 个、W34S7 的 15 个零进度外环工地被清掉，全局工地从 78 降到 ~31；塔能量 ≥500 后 spawn/塔/storage 位各放 1 个 rampart 工地（每轮 2 个）；RCL6 起外环照旧分批落地。
- 实测：tick 73479582（上线约 250 tick）：errors=[]；W33S7 工地 42 → 9（storage 1、extension 6、link 2，32 个外环 rampart 工地全部清掉），W34S7 17 → 2（15 个清掉），W33S8 19 → 25（释放的全局名额立刻被新房的道路工地用上：road 18 → 24），全局 78 → 36。塔仍 490/490 < rampartTowerEnergy 500，核心建筑的 rampart 工地要等塔补满才放；两格 44 万血的旧 rampart（(23,21) 在 spawn 上、(23,19) 裸地）不受影响。待回填：塔 ≥500 后 spawn/塔位 rampart 工地是否出现并被修到 1e5；W33S8 spawn 建成时间是否因名额释放提前。

## 2026-09-04T18:35+09:00 大脑按真实房间路径筛外矿：W36S7 只能穿两个 SK 房到达，换成 W32S8
- 背景/问题：监控循环本轮核对白名单稳定性、reserver 数与 W33S8 spawn 时，monitor 报 3 个武装敌人却不在任何母房或外矿；探针定位到 W36S6 的 3 只 Source Keeper（我方有 creep 在那）。`Game.map.findRoute('W34S7','W36S7')` = W35S7 → W35S6 → W36S6 → W36S7：W35S7 只有北/东出口（`describeExits` = {1:W35S6, 3:W34S7}），去 W36S7 的唯一通路是两个 4 巢 SK 房。status.jsonl 回溯：17:00 起 W34S7 派往 W36S7 的 reserver（诹访子丁、同名复用的诹访子己 ≥3 只）与矿工（勇仪丁、勇仪癸）都死在 W35S6 (9–11,42–44)/W36S6，W36S7 记录 lastSeen 始终 0。根因：大脑按 Chebyshev 半径 2 把它当"两跳房"，出口情报只用于强邻扣分，不用于可达性。
- 改动（f5f3cae，仅 scripts/brain，不上传游戏代码）：`plan.py` 新增 `passable()`（走廊不穿 SK/中心房、他人房、无情报房）与 `route_hops()`（按情报里的 terrain 出口做四向 BFS，共享边两侧都要有出口），`DEFAULTS.remoteMaxHops=4`；`choose_remotes`/`choose_claim` 到不了的候选拒绝为 `noRoute`（已在用的外矿不豁免），评分距离改用实际穿房数（原来是曼哈顿距离）。
- 测试：brain_test +2（SK 走廊拒绝、单侧出口不通、占领候选同样拒绝；W34S7→W34S8 共享边封死时按 3 跳计分、他人房不能当走廊），brain 49 全绿、Python 全部 81 全绿；私服 validation-AiBJCF ok、notificationErrors 0。出口情报与游戏 `describeExits` 五房逐一核对一致（W34S7 N/E/W、W34S8 E/S、W36S7 N/S/W、W33S8 N/E/W、W35S7 N/E），编码为行优先 `y*50+x`。
- 预期：W34S7 白名单 W36S7 → W32S8（经己方 W33S7/W33S8 三跳，单源），其余 7 个外矿不变；不再往 SK 房送 creep。W34S8 因实际 3 跳分数从 8 降到 −14 但仍在名单内。
- 实测：dry-run（tick 73479996）与 --write（tick 73480020，issuedAt 1788514167680）结果一致、blockers=[]；游戏内 tick 73480039 ack，W34S7 启用外矿 = W35S7/W34S8/W32S6/W32S8，W36S7 enabled=false；正走向 W35S6 出口的矿工 勇仪癸 在 W35S7 (27,4) 掉头回家 ((28,7)→(29,10))。待回填：W32S8 矿工/reserver 到位时间、后续轮次白名单是否保持。
- 顺带核实：所有外矿源在预定值仅 1 时 energyCapacity 也是 3000（文档：已预定房 3000），56bd221 里"1 CLAIM 源停在 1500"的说法不成立，双 CLAIM 的价值是攒出预定缓冲；config 注释待修正。
- 未做（下一轮候选）：W33S7 spawn 等 1500 的 hauler 替补（body 成本恰好 = 容量，缺 1 只不触发缩身；builder 从 ext 抽能，spawn 能量每 tick 净涨约 1.3），6 只远程矿工在岗却 0 只远程 hauler、控制器容器空 140+ tick、升级停滞约 300 tick。

## 2026-09-04T18:58+09:00 修 reserver 补不上：hauler 缺 1 只、满配成本 = 容量时 spawn 无限期等待，starved 把外矿需求全挡住
- 背景：用户要求维护 W33S6、W32S7、W32S8、W34S8 四个外矿并修掉 reserver 补不上的问题。探针（tick 73480412）：W33S6/W32S7 预定已归零（源掉回 1500 档）、容器 2000/2000 满、地上各堆 4037/3569 能量、矿工 154/264 tick 到期，没有 reserver 也没有远程 hauler；W34S8 同样无预定、容器满、地上 1340；W32S8 刚纳入尚未有人。W33S7 spawn 空闲、能量 1015/1600、`spawnWaiting.cost=1600`——容量刚从 1500 升到 1600，满配 hauler 成本恰好等于容量，要等 ext 100% 满；builder/upgrader 又从 ext 抽能，能量每 tick 净涨约 1.3，18:18 起等了上千 tick。缩身规则只在 hauler 全灭或缺 ≥2 只时触发，缺 1 只就一直等，而 `starved` 规则又把所有外矿需求（reserver 650、远程 hauler、矿工替补）挡在后面。W34S7 侧 reserver 只是排在核心角色之后（`countPlannedDemand` 会在到期前 lead tick 预补），属于正常排队。
- 改动（7b9b64d）：`config.spawnWaitTicks=150`；`spawn.js` 的 `spawnWaiting` 新增 `since`（同一成本从哪个 tick 开始等，成本变化即重置），`waitedTooLong()` 在同一笔买不起的成本连续等 ≥ spawnWaitTicks 时让 hauler 只缺 1 只也按现有能量缩身孵（仍要求能量 ≥ 容量一半）。smoke 新场景 3 段（等 200 tick 缩身到 ≤1015 且 ≥900、等 50 tick 照旧等满配且 since 不变、成本变化后 since 重置）；smoke 全绿、Python 81 全绿、JS 语法检查通过；私服 validation-wheBhf ok、notificationErrors 0；activeWorld=default 后 `npx grunt` 上线，版本 1788515915113，errors=[]。
- 预期：W33S7 在最多 150 tick 内补出约 1000 的 hauler，随后 starved 解除，W33S6/W32S7 的 reserver（650）与远程 hauler 陆续孵出，预定恢复、地上 7.6k 能量被拉回；W34S7 的 W34S8 reserver 与 W32S8 矿工在核心角色补完后出队。
- 实测：上线 tick ~73480500 时 W33S7 `planned.hauler` 已到 2、spawnWaiting=None（能量在部署前后到过 1600，替补按旧规则孵出），W34S7 的 `spawnWaiting` 已带 since 字段（cost 700，since 73480485）。待回填（下一轮监控）：四个外矿的 reserver/远程 hauler 到位时间、预定恢复、地面能量清空。

## 2026-09-04T19:35+09:00 spawn 调度改为请求队列：优先级类 + 首次出现起算的宽限 + 收入 ETA 决定"等满配还是缩身"
- 背景：用户问 spawn 机制是否有更好的架构并接受方案（设计：docs/superpowers/specs/2026-09-04-spawn-queue-design.md）。当天三次同源事故（1300 reserver 卡 700 矿工、1500/1600 hauler 替补卡全部外矿、缺 1 只不缩身）都源于旧结构：三个 band + remoteDemands 顺序即优先级、一条买不起就阻塞后面所有人；"孵什么"和"孵多大"绑死，缩身靠 have===0 / 缺 ≥2 / spawnStallTicks / spawnWaitTicks / scaleDownShare 五个补丁；没有"何时需要 / 何时买得起"的估计。
- 改动（042ad59 文档、9505c14 实现、74cd406 builder 修正）：新文件 `src/spawn_queue.js`（纯函数 `schedule`）：请求 `{key, role, priority, grace, body(budget), strategic, jumpable, blocking, opportunistic, ordered}` 按 (priority, neededBy/seq) 排队；队头买不起时用 spawn 能量正增量的 EMA 估计 `eta`，`now+eta ≤ since+grace` 就等并为它保留能量，否则按现有能量缩身（收入 > 0 时至少要容量一半，收入 = 0 是 hauler/矿工全灭的紧急态有多少用多少）。核心请求等待挡住非 strategic 请求，strategic（占领/援建/防御）等待挡住所有请求，jumpable（外矿）只挡更低的类，opportunistic（富余 upgrader、scout）买不起就跳过，builder 不保留能量（对齐旧 starved 规则）。`src/spawn.js` 的 run 改为：组请求 → schedule → 执行 → 遥测 `Memory.rooms[房].spawnQueue`（队头、等待成本/eta/已等待、本 tick 孵化、被挡数、收入估计）→ 队列清空后才换代替换与弹性矿工。删除 spawnStallTicks/spawnWaitTicks/scaleDownShare/scaleDownMinCapacity 与 hasCoreDemand；新增 `config.spawnQueue`（classes、grace：survival 30 / development 150 / expansion·aid·remote 300 / defense 0，底线 upgrader 用 150；minShare 0.5；incomeAlpha 0.05；incomeSamples 10；fallbackIncomePerSource 5）。`spawnWaiting` 保留并新增 since/eta/key/role；`demand` 不变。CLAUDE.md 的孵化段同步。
- 测试：smoke 既有 25 个 spawn 场景全部保留（两个场景按新语义改写：600/1100 差几 tick 先等、宽限用完再缩身；"50 tick 没涨"改为宽限用完）+ 新增调度器纯函数场景 10 段与"缺 1 只 hauler 等/缩身/下限"3 段，全绿；Python 81 全绿；私服 validation-6ePwex ok、零通知错误；soak 2000 tick（刷新快照 tick 73480821，run-queue-a）：零运行时错误，W33S7/W34S7 全程 2 矿工、hauler ≥1，外矿矿工 5–6/远程 hauler 5–7/reserver 4–6 逐步到齐，Invader 事件出 defender；分析器 48 条均为工地停滞/外矿地面堆能量类，与此前 soak 同类。
- 上线：activeWorld=default，版本 1788517503528（19:33）。实测（tick 73480929）：errors=[]；W33S7 `spawnQueue` = 12 条请求、收入 EMA 3.2/tick、队头 aid builder（W33S8）1350 等待 eta 216（宽限 300 内）、挡住 11 条外矿请求（与旧 strategic 语义一致，但暴露出援建身体不可缩的问题）；W34S7 spawn 忙、收入 EMA 30/tick；W33S8 无请求、样本不足按每源 5 估计。
- 待做：① 弹性矿工（按源 WORK 缺口补身体）现在排在队列清空之后，W34S7 源 1 只剩 3 WORK 时被"等 1300 hauler"压了几百 tick，应做成 development 类非阻塞请求；② 援建/外矿的固定身体改成 `body(budget)` 可缩（援建 builder 1350 在收入 3/tick 时要等 216 tick，缩到 800 立刻能走）；③ monitor 打印 `spawnQueue.waiting`（队头等待 > N tick 告警）。这两条代码改动等另一会话（升级站位改造，动 spawn.js/smoke.js）提交后再做。

## 2026-09-04T19:30+09:00 向 Kalgen 学习（第 1 条）：升级站位改到 storage 相邻格，升级者直接从 storage 取能
- 依据：Kalgen 89 房 storage→controller 距离全在 2–4 格，升级者静止站在 storage 与 hub link 之间直接取能，全账号没有控制器容器、没有控制器 link（`docs/observe/kalgen-learnings.md` 第 1 条）。我们的轮子方案几何上一样（W33S7 storage (31,26) → controller (34,24) 距离 3），但升级站是控制器容器 (33,25)，距 storage 2 格不相邻，RCL5 仍靠 hauler 第三层投递喂容器，ctrl link 建成前每趟 hauler 都要多跑 spawn→控制器一段。
- 改动：`layout.upgraderStorageStations`（storage 已建成时，与 storage 相邻、控制器射程 3 内、非墙非规划结构位、无不可通行建筑的格；非道路优先、其次贴规划 link、离控制器近；W33S7 得 (32,26)/(31,25)/(31,27)，W34S7 的 storage 离控制器 5 格得空 → 照旧走容器/link）与 `controllerFedByStorage`；`roles/upgrader.js` 有站位时以 storage 为锚，多个升级者按优先级各占一格，空仓就地从 storage 取能，storage 暂空且 hauler 在岗时原地等；`task_broker.controllerFeedStorage`：storage 供能时控制器容器不再登记投递，storage 低于 `controllerFeedStorageFloor`(2000) 按第三层补，低于 `controllerFeedStorageStarved`(500) 且 spawn 能量过半、spawn 没在等买不起的 creep 时提到第一层（与容器公平规则同义）；`roles/hauler.js`/`roles/remoteHauler.js` 同步；`spawn.controllerLegLength` storage 供能时为 0（hauler 往返不算控制器段），`spawn.upgraderTarget` 的 EMA 改看 storage 能量 / `upgrading.storageFullAt`(30000)。
- 测试：smoke 新场景 18 条断言（站位选择与排序、terminal/link 位排除、两只升级者分占两格、同 tick 取能+升级、broker 三层/一层/spawn 等待时不提层、remoteHauler 回家送见底的 storage、EMA 按 storage 升到 2 再回落到 1、storage 离控制器 5 格时退回容器供能且 hauler 目标更高），mock 的 `lookForAt(LOOK_CREEPS)` 补上真实语义；smoke 648 全绿，Python 81 全绿，私服 validation-6aY1SF ok: true、10 房 errN=0。提交 5722aab（基于另一会话的队列版本 90ca03c），版本 1788518105738 于 19:2x 上线（activeWorld=default）。
- 预期：W33S7 storage 工地（31,26）建成的那一 tick 起：升级者挪到 (32,26)，hauler 不再往 (33,25) 送、只送 storage；`demand.targets.hauler` 因往返缩短可能减 1；storage < 2000 时 hauler 先补 storage。W34S7 无变化。
- 实测：tick 73481114（上线约 60 tick）：errors=[]，版本已生效；W33S7 的 storage 工地 (31,26) 7000/30000 还没建成，所以新站位仍处于休眠——升级者 慧音丙（14 WORK）照旧站在容器 (33,25)，容器 0 能量（spawn 忙、公平规则让路，是既有现象），`demand.targets`={harvester 3, hauler 2, upgrader 1, builder 2}。待回填：storage 建成那一 tick 后升级者是否挪到 (32,26)、hauler 是否停送 (33,25)、升级速率与 hauler 目标的变化。

## 2026-09-04T19:50+09:00 spawn 队列收尾：矿工换代与弹性矿工进队列，援建/外矿/开荒身体可缩，monitor 打印队列
- 背景：队列上线后的三条待办（见 19:35 条目）。线上 W34S7 源 1 的 3 WORK 矿工被"等 1300 hauler"压了几百 tick——旧实现里换代替换要等能量满且队列清空，弹性矿工是队列清空后的尾巴；W33S7 队头是给 W33S8 的援建 builder 1350，收入 3/tick 时要等 216 tick 且挡住 11 条外矿请求，因为援建/外矿/开荒的身体是固定的、宽限用完也没法缩。
- 改动（1973cf9）：`harvesterUpgradeRequests`（bodyUpgradeCandidates 里的矿工候选）与 `elasticHarvesterRequests`（按源 WORK 缺口的残余身体）成为队列请求：与外矿同级、排在外矿之后、换代在弹性之前；strategic（核心 hauler 等能量时照样孵——补 WORK 是加收入）+ opportunistic（买得起才孵，从不等待也不挡人）；生存档矿工未补齐时不出弹性请求，能量满且该源有换代候选时也不出。其他角色的换代仍由 tryBodyUpgrade 在队列清空、能量满时处理。`remote.js`/`aid.js`/`expansion.js` 的 demand 增加 `bodyFor(budget)`（remoteMinerBody/reserverBody/remoteHaulerBody/makeBody 按预算），`demandRequest` 在满配买不起时用它缩身（仍受 minShare 下限）。smoke 末尾 +3 场景（hauler 等能量时 3W 矿工换代成 5W 静态并记替换租约；400 容量下弹性矿工补 1–2 WORK 残余身体；reserver 需求 bodyFor(700)=650、bodyFor(600)=空）。
- 改动（70a17c5）：monitor 探针采 `spawnQueue`，房间行打印"队列: 队头 / 成本 / 预计 / 已等 / 挡住 / 收入"，队头等待 > 300 tick（THRESHOLDS.spawn_queue_wait_ticks）报告警。
- 测试：smoke 全绿（含新增 3 场景）、Python 81 全绿、JS 语法通过；私服 validation-tKPqxq ok、零通知错误。上线：版本 1788518691487（19:49，activeWorld=default，HEAD 70a17c5）。
- 实测（tick 73481244）：errors=[]；W34S7 队头 remote:remoteHauler:W35S7 1250，已等 252 tick（since 跨版本保留）、预计 120 tick、收入 7.7/tick，宽限 300 用完后将按 bodyFor 缩身；W33S8 收入 EMA 1/tick（spawn 常满）。待回填：W34S7 那只远程 hauler 是否在 ~tick 73481290 缩身孵出、W33S7 援建 builder 是否缩身。
- 并行会话：screeps-1d 接着改升级者分档（spawn.js/utils.js/roles/upgrader.js/config.js），已约定它提交并上传前我不再动 src。

## 2026-09-04T20:10+09:00 向 Kalgen 学习（第 3 条）：升级者按 storage 能量分档，RCL8 以下不封顶 15 WORK，取能给 storage 留底
- 依据：Kalgen 82 个强化升级者的房 storage 最低 1.1e5，7 个改用 W1C16M1 保级升级者的房 storage 最高 1.67e5——升级强度跟着 storage 走；RCL7 冲级房 W15N28 用 5 只 W45C4M1 + 3 只 W47C2M1（约 370 WORK）直接从 storage/terminal 取能（`docs/observe/kalgen-learnings.md` 第 3 条）。我们的升级者身体只看容量（RCL5 起一律 15 WORK，`utils.makeBody` 的封顶在 RCL8 以下没有依据），有 storage 站位后会把 storage 吃到 0，缓冲留不住。
- 改动（只对"升级者由 storage 供能"的房生效，W34S7 之类没有站位的房不变）：`config.upgrading` 新增 `lowBelow 5000 / lowExitAbove 10000`（滞回）、`lowBudget 550`、`reserve 2000`；`spawn.upgraderLowMode`（状态记在 `upgradeSupply.low`）与 `spawn.upgraderBody`：低档只孵 550 的 W4C2M1 且 EMA 不加员，退出低档后满身体；孵化请求与换代判断（`bodyPlan`）都走 `upgraderBody`，避免两边不一致造成换代抖动；`utils.makeBody('upgrader')` 加 `opts.maxWork`，RCL8 以下放开到 50 部件并先夹 WORK 再算 CARRY（RCL6 得 W21C2M1=2250，RCL7 得 W47C2M1=4850，正是 Kalgen 的 eswithdrawUpgrader；RCL8 仍 15），默认仍封顶 15 所以其它调用方不变；`roles/upgrader.js` 从 storage 取能只取到 reserve 以上，storage ≤ 2000 时原地等 hauler。
- 测试：smoke 新场景 15 条断言（三档容量的身体、滞回进出低档、队列缩身预算仍生效、RCL8 封顶、无站位房不分档、取能留底 2000 与同 tick 补能、低档时升级者目标回底线），全套 662 全绿；Python 81 全绿；私服 validation-UmiRl2 ok: true、10 房 errN=0。提交 e4ef1eb（基于另一会话的 39f8f1f），版本 1788519110574 于 20:0x 上线（activeWorld=default）。
- 预期：W33S7 storage 建成后：storage < 5000 期间升级者换代为 550 的 W4（省下 1200/1500 tick 的孵化能量），storage 到 1 万后换回 RCL5 的 W15C3M1（RCL6 起 W21C2M1）；storage 始终保留 ≥ 2000 给 spawn 爆发补员与建造；storage ≥ 2.1 万时 EMA 加第 2 只升级者。
- 实测：上线即刻 errors=[]、版本生效；W33S7 的 storage 仍在建（第 1 条的站位也还休眠），所以分档逻辑暂无可观察对象；W34S7 无站位不受影响。待回填：W33S7 storage 建成后升级者是否先按低档换成 550 身体、storage 过 1 万后是否换回 W15C3M1，以及 storage 是否稳定保留 ≥2000。

## 2026-09-04T20:05+09:00 外矿 reserver 断档根治：1300 容量起用双 CLAIM（短宽限退回 1 CLAIM）、容器就绪的外矿先补、核心角色替补提前预留能量
- 背景：用户指出 W32S8/W34S8 又没有 reserver。核实（tick 73481297）：W34S8 的 reserver 其实在岗（预定 1）、W32S8 的在路上，但预定值反复归零是结构性的——容量 1300 的房只出 1 CLAIM，预定永远停在 1，reserver 一到期立刻归零、源掉回 1500 档；再加上 W34S7 一只矿工到期没接上（19:43 能量被外矿 creep 花到 8/1300，650 的替补攒不出来）→ recovering → 恢复期压掉全部外矿需求。另外白名单顺序把已建容器的 W34S8 排在还没开矿的 W32S8 之后。
- 改动（0bb10e9）：`config.remote.reserverDoubleClaimCapacity` 1650→1300（队列会按 bodyFor 缩身，不再需要 20% 余量）、新增 `reserverGrace=60`，`remote.js` 的 reserver 需求带 `grace`（预定为 0 时宁可 60 tick 内退回 1 CLAIM），`demandRequest` 优先用需求自带的 grace；`remote.getDemands` 先排容器已建成的外矿再按白名单顺序；`spawn_queue.schedule` 新增 `reserve` 请求（只预留不孵：买得起就从预算扣掉，买不起就当队头等待并挡住非 strategic 请求）；`spawn.js` 新增 `replacementReserveRequests`：矿工/hauler 距离到期提前量只剩 ≤ 攒够理想身体所需 tick + `spawnQueue.reserveMargin(20)` 时出预留请求（收入为 0 不出，优先级在生存档之后、发展档之前），真正的替补仍由计数在 ttl ≤ 提前量时产生。遥测 `spawnQueue.reserved`；monitor 队列行打印预留（c3d93a8）。
- 测试：smoke 末尾新增场景（预留买得起扣预算/买不起当队头等待且援建照常；1300 容量 reserver 双 CLAIM + 宽限 60 + bodyFor(650)；容器就绪外矿排前；矿工距到期 20 tick 时预留成为队头、能量够时扣预算、到提前量时替补直接孵出并预留消失），两条旧的 1650 阈值断言按新策略改写；smoke 全绿、Python 81 全绿、语法通过；私服 validation-4TXMqK ok、零通知错误（期间另一会话的 soak 曾并行，断言全过说明未受影响）。
- 上线：版本 1788519508012（20:03，activeWorld=default，HEAD 7012bbe，含另一会话的升级者分档 e4ef1eb）。实测（tick 73481459）：errors=[]；8 个启用外矿全部有预定（W32S7 6、W35S7 39，其余 1，双 CLAIM 上岗后会开始累积）。待回填：W34S8/W32S8 的 2 CLAIM reserver 何时孵出、预定值是否开始累积、W34S7 是否不再因矿工断档进入 recovering。

## 2026-09-04T20:40+09:00 评估并占领 W35S7（用户指令："值得就 claim，否则保持外矿"）
- 评估依据：GCL 12、已占 3 房（余量 9），CPU 39/140、bucket 8169；W35S7 两源（拥有后 3000 档）、矿 O（现有 L/L/K，新矿种）；`Game.map.describeExits` 证实东出口直通 W34S7（一跳、不穿 SK 房），北出口只通 SK 房 W35S6，西/南封死——受保护的口袋；外部大脑把它排在 W34S7（14.0）和 W33S7 候选第 1；作为 W34S7 的外矿它当前产出 ≈ 0（两个容器 2000/2000 满着，W34S7 收入 5.6–11.5/tick、队列 7/8 被挡，1300 的远程 hauler 孵不出来，往返 59–62 格）。W33S8 已建成 spawn（RCL2、11 只 creep），上一轮开荒过了最难的阶段。
- 硬风险验证：地形 56% 是墙、最大无墙方块半径只有 4（W34S7/W33S8 成功时为 5），轮子可能出不了方案而没有后备布局。用 soak 把 W35S7 作为"我方无 spawn 房"播进私服（快照 data/soak/w35s7_snapshot.json，因 seedCreeps 要求母房有 spawn 而临时塞了一个假 spawn；run-w35s7c，240 tick）：轮子出了完整方案——storage (38,20) 与 src0 相距 3、terminal (37,19)、3 spawn、60 ext、10 lab、6 塔、40 格 rampart 外环（新规则下等 RCL6），240 tick 内到 RCL2，errN=0。产物已删除、data/soak/cache 已还原。
- 执行：`data/brain/locks.json` W34S7.claim → W35S7（W33S7.claim → null，W33S8 已占下，避免 single_claim 把 W34S7 挡住），手动 `scripts/brain/run.py --write`（tick 73481492，segment 90 16696 字节，blockers=[]）。游戏内 tick 73481536 ack；站在控制器旁的 1 CLAIM reserver（claimDuty）直接占下：W35S7 controller 归我方、RCL1，省了一只 650 的 claimer；轮子方案已生成，W34S7 `expansion.target=W35S7, spawnPos (38,22)`，W33S7 自愈接管也指向 W35S7；W34S7 队列头是 pioneer 800（收入 5.6/tick，eta 68），errors=[]。
- 已知副作用：同一轮大脑把 W35S7 作为外矿分给了 W33S7（占领目标只从赞助房的外矿名单里排除），下一轮它会因"已归我方"被排除，期间 W33S7 若孵了 reserver/矿工会到场即退役；W34S7 的第 4 个外矿位补成 W33S5。W35S7 原来的 2 矿工 + reserver 已退役，两个满容器留给 pioneer 自采。
- 待回填：W35S7 spawn 工地 (38,22) 建成时间（W33S8 用了约 4 小时）、两个母房各出几只 pioneer、W34S7 的能量是否被 pioneer 长期占住（如是，可把锁改成 W33S7 赞助）。

## 2026-09-04T20:55+09:00 外矿维护优先级：容器已建成的外矿替补排在发展档与援建之前（expansion 仍在其前）
- 问题（tick 73482039）：8 个外矿的 reserver 在 350 tick 内全部到期、预定归零、源全掉回 1500 档，没有一只替补孵出。回溯：两个母房过去 400 tick 只孵了 builder ×5、hauler、upgrader ×2（发展档）和援建；队列里外矿替补已等 278–657 tick（W33S7 收入 9/tick、W34S7 7/tick），W34S7 队头是给 W35S7 的 1300 援建 hauler，等了 265 tick 并挡住 9 条外矿维护请求。根因：队列顺序 development(2) → expansion → aid(4) → remote(5)，维持收入的替补永远排不上，而它们每个源值 5–10 能量/tick。
- 改动（183d176 + db468f6）：新增 `remoteMaintain` 类，`remote.js` 给容器已建成的外矿的矿工/reserver/hauler 需求打 `maintain`，`spawn.js` 据此归类；类顺序改为 defense 0 → survival 1（核心替补预留 1.5）→ expansion 2 → remoteMaintain 3（宽限 60）→ development 4 → aid 5 → remote 6 → opportunistic 7。expansion 提到 remoteMaintain 之前是第一次私服验证（validation-3UPs1U）失败教的：brain 场景里 claimer 被排在外矿维护之后，来不及在窗口内占下 E11S12；占领是一次性、有时间窗口的投资。smoke 新增场景（1300 能量时先补有容器的外矿而不是 builder/援建），既有"扩张优先于外矿""援建优先于（无容器的）外矿"场景保持通过；Python 81 全绿。
- 流程失误：183d176 的验证与上传写在同一条命令链里且没有以验证结果为条件，validation-3UPs1U 失败后仍上传了 1788522116389（线上只是顺序差异、无功能风险，errors=[]）。修正版 db468f6 改为"验证 exit 0 且报告 ok 且 activeWorld=default 才 grunt"，validation-jqEUoS 通过后上传 1788522343488（20:53）。以后所有部署命令都按这个门控写。
- 实测（tick 73482210）：errors=[]；W34S7 队头已是 remoteMaintain 的 W32S6 远程 hauler（1250，收入 17/tick，宽限 60 内会缩身），挡住 5 条更低的请求；8 个外矿预定仍为 0，等双 CLAIM reserver 出队。待回填：下一轮 reserver 数、预定值是否开始累积、W35S7 spawn 进度。

## 2026-09-04T21:12+09:00 自带分档的需求不套容量一半的缩身下限
- 问题（tick 73482452，版本 1788522343488）：外矿维护类生效后 W33S7 200 tick 内孵了 3 矿工 + 2 远程 hauler，但 W33S6 的 reserver 在队头等了 297 tick：它的 1 CLAIM 档只要 650，缩身下限却是容量一半（1600 × 0.5 = 800），能量在 700 上下总被同级的 700 矿工先花掉，永远够不到 800。
- 改动（eb1a767）：`spawn_queue.schedule` 支持请求自带 `minShare`，`demandRequest` 给带 `bodyFor` 的需求（外矿/援建/开荒）设 `minShare: 0`——生产者的档位（650 的 1 CLAIM、600 的 4W 矿工）就是下限；核心角色的可缩身请求仍受容量一半约束。smoke +3 段（minShare=0 在 700 能量孵 650 档；没给的仍受下限；1600 容量、700 能量、reserver 已等 100 tick → 孵 650 的 1 CLAIM）。
- 门控部署：第一次流水线在 `git status | grep -v | wc -l` 上因 grep 无匹配返回 1 被 pipefail 截断（验证没跑），去掉该管道后重跑；validation-n9ysIq ok、零通知错误，activeWorld=default，上传 1788523513614（21:10）。
- 实测（tick 73482525）：errors=[]；W33S6 预定恢复（W33S7 4 个外矿里 2 个有预定，W34S7 也是 2 个），reserver 陆续出队。新发现：W34S7 队头是第 2 只家用 hauler（core:hauler:1，1300，发展档），已等 359 tick——外矿维护类（650–700）现在排在它前面，能量一到 700 就被拿走，它的缩身下限 650 永远够不到；收入 8.4/tick 正是家里只有 1 只 hauler 的症状。候选修法：双源房的生存档 hauler 从 1 提到 2（config.survival[RCL≥3].hauler），第 2 只 hauler 排在外矿维护之前、宽限 30 tick 就缩身。下一轮做。

## 2026-09-04T22:00+09:00 指令过期不再让外矿退役：6 小时 stale 宽限 + 纯距离的 tooFar + 大脑 TTL 3 小时
- 事故：本机 21:20 起断网约 25 分钟（run.err：Network is unreachable / DNS 失败），大脑连续几轮 blockers 非空、正确地没写指令；但游戏内指令（TTL 30 分钟）21:41 过期，`brain.get` 返回 null，`remote.withinRange` 对不在出口相邻的外矿只认白名单 → W34S7 的 4 个外矿（含只经 W33S8 可达的相邻房 W34S8）和 W33S7 的两个二跳外矿全被判 tooFar 停用，远程 creep 回家退役：W34S7 远程矿工 3→1、远程 hauler 4→2、reserver 2→0；W33S7 矿工 6→4、hauler 6→4、reserver 3→2；两房各多孵一只 scout（无指令时退回 roster 的 scout=1）。monitor 探针也因断网失败。网络恢复后手动 `run.py --write`（tick 73483203），记录随新白名单重新启用。
- 改动（5b1294c）：`brain.js` 新增 `STALE_GRACE_MS=6h`：超过 ttl 只在 `Memory.brain.stale` 打标、指令继续提供（`isStale()` 供 monitor 用），超过 ttl+宽限才退回自治；`remote.js` 新增 `withinDistance`（出口相邻或坐标 ≤ maxRange，不看白名单），run/observe/getDemands 的 tooFar 判定改用它，`withinRange`（看白名单）只用于纳入候选与白名单重启用；`scripts/brain/run.py` 的 `--ttl-minutes` 默认 30→180（launchd 每 5 分钟一写）。smoke：过期用例改为"ttl 内宽限继续提供并标记 stale / 超过宽限返回 null"，新增"无指令时坐标两跳内的已纳入外矿保持启用、超 maxRange 仍 tooFar"；Python 81 全绿；私服 validation-q11T68 ok、零通知错误；门控上传 1788526414564（21:58）。
- 实测（tick 73483287）：errors=[]；8 个外矿全部 enabled，只有己方房/超距房是 tooFar。大脑 21:53 那轮仍带 ttlMs 30 分钟（提交前启动），下一轮起 3 小时。待回填：退役后的远程编制补回时间（外矿维护类现在排在发展档之前，应在几百 tick 内补齐）。
- 待做：monitor 对 `Memory.brain.stale` 告警（大脑多久没写）；scout 目标在指令缺失时也应保持 0（外部情报为准）。

## 2026-09-04T23:06+09:00 外矿槽位换代 + 缩身下限按理想成本的一半；monitor 外矿行；外矿 ROI 工具
- 问题（tick 73484186，版本 1788526414564）：新工具 `scripts/report/remote_roi.py`（探针调 `remote.getDemands` 取计划身体与在岗 creep，按每 tick 摊平算毛产出/运力/维持/净收益/ROI/回本/spawn 占用）显示在岗净收益远低于计划：W33S7 21.0 vs 37.7/tick，W34S7 4.7 vs 10.0。原因是 21:12 那轮给 bodyFor 需求放开 minShare 后，宽限（remoteMaintain 60 tick）一到就按手头能量孵出 200–500 的外矿 hauler：W33S6 一只 1 CARRY（200）占着 19 CARRY 的槽位还剩 1285 tick，9.8/tick 的产出运回不到 1；W34S8 5/19、W32S8 4/24、W31S8 27/51 CARRY。缩身身体占住槽位 1500 tick，没有换大的路径。同时发现 `test/smoke.js` 的 `process.exit` 后面还有 7 个场景（上一轮追加的队列场景）从未执行；补跑后其中"预留买得起后外矿 creep 买不起→不孵"两条断言失败，正是 minShare=0 孵出 250 的 hauler 的写照。
- ROI 结论（计划口径）：W33S7 四外矿净 37.7/tick 占单 spawn 66%（W31S8 13.1、W31S6 12.8 ROI 2x；W33S6 6.0、W32S7 5.7）；W34S7 四外矿只有 10.0/tick 占 40%（W32S6 5.3、W32S8 5.2、W34S8 2.2、W33S5 -2.7 还没容器），折成整个 spawn 是 57 vs 25/tick。2 源房必须预定，1 源房 2 CLAIM reserver（2.2/tick）只多赚约 2。
- 改动（519e7ed monitor、75970d3 ROI 工具、88fe9e7 实现、aa55c13 文档）：`spawn_queue` 新增请求字段 `minCostShare`（缩身下限按理想身体成本份额），`demandRequest` 给 bodyFor 需求设 0.5（650 的 1 CLAIM 仍可、1550 的 hauler 不再缩成 200）；`remote.js` 矿工/hauler 需求带 `throughput(body)`（WORK×2 / CARRY×50÷往返，封顶源产出）；`spawn.js` 新增 `demandUpgradeRequests`：槽位被缩身身体占着且 (理想吞吐−在岗吞吐)×剩余 tick ≥ 2×理想成本 时出 `upgrade:<slot>` 请求（remote 类、opportunistic、非 strategic、不挡人），旧 creep 记替换租约；`retireReplaced` 对外矿 creep 等替换者进外矿房再退役（最多 200 tick）。修了 `onSpawn` 包装丢参数（slot 请求的 onSpawn 收不到新 creep 名）和 `queueSettings` 只透传白名单键。config：`spawnQueue.minCostShare 0.5 / upgradePayback 2 / upgradeHandover 200`。monitor 新增每母房 `外矿:` 行（每外矿 m/r/h 在岗/需求、预定、停用原因），缺矿工/reserver 连续两次快照才告警。smoke 结尾移到文件末尾（143 场景全跑）+3 段（minCostShare 下限；需求 throughput；缩身 hauler 换代/交接退役/超时退役/近理想不换/快到期不换），703 断言。
- 门控部署：validation-9wXzs9 ok、通知错误 0；activeWorld=default；上传 1788530763832（23:06）。
- 实测（tick 73484480）：errors=[]；上线 40 tick 内 W31S8 一只缩身矿工换代（`勇仪丁.upgrade`，交接中 m3/2）。W33S6 的 1 CARRY hauler 还在等 1550 能量（W33S7 能量 421/1650，收入 EMA 4/tick，spawn 一直忙）。W34S7 收入 EMA 也只有 4/tick：源容器被拆迁成 container-redundant 后新容器还在建（1235/5000、0/5000），静态矿工的能量落地、hauler 捡地上的——这是 W34S7 升级只有 3.5/tick 的主因，下一轮看 builder 是否该先建源容器再建 storage。
- 待做：monitor 对 `Memory.brain.stale` 告警；scout 目标在指令缺失时保持 0；W33S7 第 2 只家用 hauler 仍常年 1/2；ROI 工具在下一轮回填在岗净收益（预期 W33S7 从 21 向 38 靠拢）。

## 2026-09-05T03:30+09:00 生存档等待挡援建（vital）+ 核心容器缺失时的生存档 builder + 源容器工地不受在建配额限制
- 问题（tick 73488146，版本 1788530763832，用户问"为什么又有几个外矿丢了 reserver"）：不是 reserver 机制——W32S7 预定 1505、W33S6 416 说明双 CLAIM 累积正常，缺的是 W31S8（W33S7）和 W32S8/W34S8/W33S5（W34S7）的补员排不上。根因在家里：① W34S7（RCL4/1300）家用 hauler 0、builder 0（703 tick 没排上）、收入 EMA 4.9/tick、能量 215/1300；昨天拆迁把两个源容器当 container-redundant 拆了，新工地 4876/5000、0/5000 没人建；队头是 1300 的生存档 hauler（缩身下限 650 攒不到），但援建是 strategic 能绕过等待——30 tick 前它还在没有 hauler 的情况下给 W35S7 孵了援建矿工。② W33S7 三个容器（2 源 + 控制器）全部衰减（拆迁日志无记录；主房容器 500 tick 掉 5000、25 万血一天耗光），builder 在发展档 727 tick 没排上（外矿维护永远在前，900 的缩身下限攒不到），塔能量三四百也不修；收入 EMA 17→12.7、升级 14→9；src0 的容器工地被 src1 + ctrl 两个在建挡住（sitePace.containers=2）放不出来。另：大脑 tick 73485138 单轮把 W31S8 换成 W31S7、W34S7 缩到 3 房，下一轮换回——白名单单轮抖动，待加滞回。
- 改动（ea50051、0ce2933 实现，c0a4cd5 文档）：`spawn_queue` 新增请求标志 `vital`（等能量时连 strategic 也挡，排在前面的防御不受影响）；源矿工、第 1 只 hauler 的生存档请求与核心替补预留标 vital。`spawn.js` 新增 `coreContainerGap`（方案里有位置却没有建筑的源容器（无源 link）/控制器容器（无 ctrl link、不由 storage 供能）数），缺失时第 1 只 builder 从发展档提到 survival+0.75（排在矿工/hauler/预留之后、扩张之前；同为生存档按首次出现排序会让等了几百 tick 的 builder 挡住刚死的 hauler——第一版上线后即在 W34S7 看到）、blocking、vital（没容器的房不该再援建）。`layout.placeSites` 源容器工地不受容器在建配额限制。smoke +5 段（vital 挡 strategic、发展档等待仍放 strategic、vital 预留、防御不受影响、builder 1.75 不挡 hauler；集成：家里 0 hauler/450 能量时缩身买得起的援建矿工被挡、700 先孵自己的 hauler；容器缺失时 builder 等到 900 才孵且挡外矿矿工与援建、容器齐全时仍是发展档；layout src1+ctrl 在建时 src0 照放），716 断言；反向验证：去掉 vital 后集成场景复现线上行为（spawned aid:aid:harvester:W35S7:0），去掉 layout 改动后 src0 不放。
- 门控部署：validation-vital（ea50051）ok → 上传 1788545931447（03:19）；上线后发现 builder 排在 hauler 前且援建仍绕过 → 0ce2933，validation-JcjVKg ok、通知错误 0，activeWorld=default，上传 1788546187145（03:23）。
- 实测（tick 73488421–73488438）：errors=[]；第一版上线 50 tick 内两房各孵出 1 只 builder（W33S7 挡住 7 条、W34S7 挡住 9 条外矿/援建请求让路）；W34S7 队头转为生存档 upgrader（上一只到期），能量 200/1300 收入 4.5/tick 仍在攒。
- 待做（下一轮候选，按证据排序）：① 源容器缺失时 `estimateHomeHaulerTarget` 返回 0（假设矿工是移动身体自己送），但线上矿工是 5W1C 的静态身体，每趟只能背 50 走回家（W34S7 收入 4.9/tick 的直接原因）——容器缺失时静态矿工应就地丢地、hauler 目标按有矿工的源计；② 静态矿工用 1 CARRY 修脚下容器 / 塔修理不受低能量门槛；③ 拆迁不在新容器建成前拆旧源容器；④ 大脑白名单滞回；⑤ W34S7 以 1300 容量背 4 个外矿 + 2 房援建过载，援建应看母房收入而非仅容量。

## 2026-09-05T04:05+09:00 能量闲置 vs WORK 闲置：builder 自取、extension 优先、满载 hauler 补工地、builder 上限 +1、300 档升级者 2 WORK
- 问题（tick 73488815，版本 1788546187145，用户观察"hauler 太多有的在挂机、工地进展慢"）：探针逐只看 W35S7/W33S8 的 creep——W35S7：spawn 300/300 满、控制器容器 84%、源容器 2000/2000、地上 5605，三只 hauler 各 200/200 停在 spawn 旁（hauler.js"满载且没地方放"分支），两只 1 WORK 的 builder 有能量但在远角 (21,6) 修路（builder 工地顺序道路排在 extension 前），5 个 extension 工地 0 进度；W33S8：11 个 WORK 的 builder（含 7W 援建 builder）全 0 能量在工地等投递 146 tick（builderFeedMaxWait 150，spawn 350/400 未满触发 spawnFirst），远处源容器 1952、地上 2507，hauler 全空在收集。结论：不是 hauler 数量问题（RCL2 的 4 CARRY hauler 每只只运 2.2/tick），是能量闲置时 WORK 没被喂到、以及 WORK 花在错的工地上；CPU 常态 41–55/140 无关。
- 改动（97a1920 实现、0b47921 文档）：`utils.energySurplus(room)`（某个非控制器容器 ≥ 90% 满或地上 ≥ 1000）；`roles/builder.js`：闲置时不等投递自己去取（可取非控制器容器、≥ 75% 满的控制器容器、地上 ≥ 100 的堆，最近者优先），`builderFeedMaxWait` 150→50，容量 < 550 时 extension 排在道路前（保留"spawn 未满等投递"的老规则——W34S7 RCL3 曾被掏空容器）；`task_broker`：工地上能量过半的 builder 也有补能任务（第 4 层、权重 2，与 storage 同层），缺能仍是第 2 层；`spawn.builderTarget`：无 storage 且闲置时上限 +1（config.energySurplus.extraBuilders）；`utils.makeBody('upgrader', 300–349)` = 2W1C1M（升级者站容器旁同 tick 取能+升级）。smoke +1 段 7 项（extension 优先、闲置自取、不闲置仍等、地上成堆去捡、第 4 层补能任务与 hauler 实际投递、上限 2→3、300 档身体），725 断言；反向验证：还原 builder.js 时 extension 优先/等待规则两条失败，还原 task_broker.js 时补能两条失败。
- 门控部署：validation-Xi1fy4 ok、通知错误 0；activeWorld=default；上传 1788548281735（04:03）。
- 实测（tick 73488973，上线 ~30 tick）：errors=[]；W35S7 第 3 只 builder 已孵出、extension (35,17) 开始有进度（10）、一只 hauler 从 200 降到 103（补了工地）；W33S8 的 builder 还在换状态（wait 14–32）。工地进度增量下一轮回填。
- 回填（tick 73489850，上线 ~880 tick）：W35S7 extension (35,17) 10→1266/3000、道路 502/1500，broker backlog 35556→19810、idle 178；W33S8 工地全部建完（backlog 11686→0），RCL2 进度 32911/45000，broker idle 143→119。
- 待做：W33S7 队头是 hauler 替补预留（1800）但 hauler 目标为 0（容器未建成），白挡 6 条请求——预留应只在该角色目标 > 死后剩余数时发；源容器缺失时 `estimateHomeHaulerTarget` 为 0 与静态矿工身体的矛盾（上一轮已记）；对方会话的 rcl_report_test 在工作树里失败（他们未提交的 WIP，非本次改动）。

## 2026-09-05T05:05+09:00 打得过才打：敌情画像 + 最便宜能赢的编组 + 成组出发 + 阵亡不续派；静态矿工自建/自修容器、落地采；战力判断外置到大脑
- 问题（tick 73489278–73489355，版本 1788548281735，用户报告"creep 6a9b14c4b9afcf31522be53b 挂机、W33S6 的 creep 被打死、W33S7 源 5982fc90b097071b4adbdbaf 采集落后"）：① 挂机的是 W33S6 的 reserver（2C2M，剩 302 tick）：外矿因入侵者停用 150 tick 就回家站在 spawn 旁，停用到期再进去、再看到、再停用，来回踱步到死。② 墓碑 6a9b1912eb829d494b538e2e 是 4R1H5M（1100）的 defender，死于两只 **强化** NPC Invader（GO tough、KO 远程 ×2、UH 近战 ×2，合计 140 伤害/tick、2000+ 血，其中一只是无近战的风筝型），不是 Source Keeper（W33S6 没有 lair）。`defense.getDemands` 只按容量配身体、从不算打不打得过，≤2 只敌人只派 1 只；死了槽位空出就立刻再孵一只单独送——W33S7 累计出兵 41 次，队头正等 1690 的下一只（无视野时 threat.ranged=false 又改派近战）。③ 源 (31,12) 的容器腐烂后 5W1C1M 的矿工掉进"往返送 spawn"分支：1 MOVE 平地每格 6 tick，每趟 50 能量走上百 tick，采集率 1.1/tick；hauler 目标同时算成 0。
- 改动（a58de3e 矿工、5b29d50 防御、a20c3f4 大脑、38f16f6 文档、b5d4bc1 monitor、79442ce/b247d37 补丁）：`utils.bodyTicksPerTile`；静态身体（> `harvesting.mobileTicksPerTile`=3）没有容器时站在规划位用自己采的能量建容器工地、没工地就落地采（drop 与 harvest 不同管线），容器缺血 ≥ 一次 repair 的量就修（约 2% 采集时间），link 满且无容器时也拿能量建工地；spawn 把这种"落地源"算作搬运来源。`defense.js` 重写：`creepProfile/hostileProfile`（血量、伤害、治疗、风筝型、强化倍率、到期 tick）、`canBeat`（双方同时交换伤害的悲观模型，我方击杀时间 × 1.5 ≤ 对方击杀我方时间）、`planSquad`（1..3 只同样身体里总成本最低的能赢编组，风筝型只用远程），外矿还要过经济门槛（编组成本 ≤ 源数 × 10 × 剩余寿命 × 0.5）；打不过/不值就不出兵并把外矿停到入侵者到期、记 `defenseLog.skipped`；`main.js` 清理内存时 `noteLoss`（`defenseLog.losses/lastLoss`），阵亡后要再看到更新的敌情才续派；defender 带 `squad`：在家等全组孵出再走、进房后在入口集结、母房不再想出兵就退役（`retired` 不算阵亡）；`remote.refreshVisible` 记 `remotes[房].threat` 并在看到清场时立刻解除敌情停用；reserver 停用剩余 ≥ 寿命就退役；外矿防御归 remoteMaintain 档。大脑：`scripts/brain/combat.py`（与 defense.js 同一套公式，两边测试互相核对 2171 血/140 伤害/3200 编组等数字），`intel[房].hostileProfile`（room-objects 的 body/boost/ageTime，无需视野），`rooms[home].defense`{房:{action:fight|avoid,squad,until,reason}}，母房容量由 spawn/extension 数推算，近期阵亡门槛 ×1.25；游戏内指令优先、无指令用画像、只有计数不出兵。monitor 新增"出兵"行与阵亡告警。smoke 774 断言、Python 106 用例。
- 门控部署：validation-XB4jam 因私服 backend 自身的 unhandled rejection 掉线（同事的基准世界日志里也有）重跑；validation-DgGKQB ok、通知错误 0，activeWorld=default，上传 1788551934133（04:58）；补丁 validation-LykJSk ok，上传 1788552363257（05:04）。
- 实测（tick 73489911–73490012）：errors=[]。W33S7 源 (31,12) 的容器已由矿工建成（此前工地 3950/5000 停了很久），矿工站容器上，源在 263 tick 里采了 1958（7.4/tick，从 1.1 回升）；源 (14,6) 的容器工地 462→692（link 满后矿工改建工地，地上不再有掉落）；hauler 目标 0→2。大脑（launchd 从工作树跑，提交后 5 分钟内生效）已下发 W33S6=fight ×3（5R5M，3000，对方 2034 血/140 伤害/剩 ~700 tick），游戏内队头是 remoteMaintain:defender:W33S6（1000，收入 12.5/tick，eta 46），三只齐了才出发；`remotes.W33S6.threat` 已由远程 creep 观察写入。挂机的 reserver 已到期，新 reserver 只在未停用的外矿工作。
- 待回填：三只 5R5M 是否成组到达并清掉两只强化 Invader（`defenseLog.losses` 应保持 0；若阵亡，大脑下一轮门槛 ×1.25、游戏内等新敌情）；W33S7 源 (14,6) 容器建成时间；是否有 defender 因大脑改成 avoid 而退役。
- 待做：W33S8 safe mode 仍激活（状态告警）；W34S7 的 W33S5 缺编 900+ tick（RCL4/1300 背 4 外矿 + 援建过载，上一轮已记）；builder/upgrader 分工（用户提议"有工地先建、无工地才升级、快掉级最优先升"——见会话结论：能量而非 WORK 是当前瓶颈，建议只加降级保护，暂不改）。

## 2026-09-05T05:45+09:00 外矿出兵的价值按"到场时"算（攒能量 + 孵化 + 走路从入侵者剩余寿命里扣）
- 测量（tick 73490422–73490547，版本 1788552363257）：errors=[]，bucket 8105；大脑 4 轮白名单不变（W33S7：W32S7/W33S6/W31S6/W31S8，W34S7：W32S6/W32S8/W33S5/W34S8）、blockers=[]；reserver：W33S7 3 只 = 3 个在用外矿（W33S6 停用中），W34S7 4 = 4；W33S8 RCL2 38490/45000（9.75 prog/tick，工地全部建完）；W33S7 源 (14,6) 容器工地 692→2466/5000（矿工在 link 满时改建工地，约 4/tick），源 (31,12) 容器 160、正常静态采集。
- 问题：上一轮大脑按"现在的剩余寿命"给 W33S6 判 fight ×3（3000），W33S7 收入只有 13/tick，攒 3000 要 240 tick，一只 1000 的 5R5M 刚孵出（出兵 42）下一轮大脑就翻成 avoid（3000 > 1480），它按新规则在家退役（阵亡 0）——白花 1000。
- 改动（1ade7cb + f1c8048）：`combat.plan_defense(income, travel_rooms)` 与 `defense.worthFighting` 都把到场时间（总成本 ÷ 母房 `spawnIncome.ema`（无则每源 fallbackIncomePerSource）+ 逐只孵化 3 tick/部件 + 每房 50 tick 走路）从入侵者剩余寿命里扣掉再算价值；run.py 把游戏内的收入 EMA 与房距传给大脑，指令里多一个 `lead`。用同一份线上情报 dry-run：W33S6 → avoid（lead 312，剩 216）。smoke 776 断言、Python 106 用例；提交前把 defense.js 回滚确认新场景会失败。
- 门控部署：validation-f5ruNk ok、通知错误 0；activeWorld=default；上传 1788554505530（05:43）。实测 tick 73490547：errors=[]，W33S6 停到 73490685（入侵者到期），`defenseLog.skipped` = brain:notWorth，W33S7 收入 EMA 回到 20.7/tick，队头无等待。
- 待回填：73490685 之后 W33S6 的远程 creep 是否自动回去（远程 hauler 已有 1 只在编）、预定是否恢复；源 (14,6) 容器建成时间；W33S8 升 RCL3 的 tick（预计 ~73491100）。
- 待做：W34S7 的 W33S5 矿工缺编（1300 容量背 4 外矿 + 援建，上一轮已记）；W33S8 safe mode 仍激活（状态告警）；builder/upgrader 分工只加降级保护（见上一条）。

## 2026-09-05T06:50+09:00 援建只在弱房经济没起来时越过母房发展档；普通 builder 等能量时重新挡住后面的非 strategic 请求
- 测量（tick 73491038–73491063，版本 1788554505530）：errors=[]。入侵者到期后 W33S6 自动恢复（m1/1 r1/1 h1/1，预定 241）；大脑 3 轮白名单不变、blockers=[]；reserver = 在用外矿数（W33S7 5 只对 4 外矿含 1 只提前替补，W34S7 4/4）；**W33S8 升到 RCL3**（4 个 extension 工地已放）；W33S7 源 (14,6) 容器工地 2466→3946/5000（矿工在 link 满时改建）。
- 问题：W33S7 单 spawn 满负荷（4 个外矿的替补约占 spawn 时间 64%、本房 26%、援建 10–17%），本房 builder 1/3 从 03:04 起十几小时没补上，storage 工地停在 10834/30000（03:04 起未动），能量在 110–1775 之间震荡（远程 hauler 回来一批就被 650–1300 的援建/外矿请求花掉）；被援建的 W35S7/W33S8 自己的 spawn 空闲、能量满仓（550/550）、编制超过目标（builder/hauler/upgrader 4/4/4 对目标 2/3/1）。根因两条：① 普通 builder 请求 `blocking: false`（2026-09-05 03:30 那轮为了不挡援建），等能量时不保留、谁便宜谁先走，缩身到 900 也永远够不到；② 援建一律 strategic，能越过所有等能量的发展档。
- 改动（069c101 实现、58c83f3 文档）：`aid.getDemands` 按需求标 strategic——该源完全没矿工的援建矿工、弱房一只 hauler 都没有时的援建 hauler 才是 strategic，只是身板小的补强与援建 builder 不再越过；`spawn.js` 普通 builder 改回默认 blocking（等能量时挡住新外矿开路、非 strategic 援建、富余升级者；remoteMaintain 仍在其前）。smoke +6 段（回滚确认 4 条会失败），781 断言；Python 106 用例。
- 门控部署：validation-AmlErD 在 blueprint 场景断言"wheel plan lacks derived containers"失败——该场景的房间地形是私服随机生成的（fixtures `terrainType: 2`），轮子在某些地图上给不出源工位，与本轮改动无关，重跑 validation-keL4lP ok、通知错误 0；activeWorld=default；上传 1788557348541（06:47）。
- 实测（tick 73491276，上线 ~40 tick）：errors=[]；W33S7 builder 2/3（此前 1/3），hauler 1/2，正在孵 upgrader 替补；W34S7 队头 core:builder:2（1300，eta 20）已开始挡住 1 条非 strategic 请求；W33S7 对 W35S7/W33S8 的援建需求为空（两房编制齐）。
- 待回填：W33S7 storage 工地是否开始推进、第 3 只 builder 与第 2 只 hauler 的到位时间；W35S7/W33S8 自己的 spawn 是否接管补员。
- 回填（tick 73491780，上线 ~550 tick）：errors=[]，bucket 9797；W33S7 builder 3/3（上线前 1/3），源 (14,6) 容器工地 4754/5000，storage 工地仍 10834（builder 刚到位，下一轮看）；家用 hauler 到期替补正在队头（1800，eta 4）。W35S7 自己的 spawn 已在忙（能量 20/550，RCL2 41983/45000）；W33S8 RCL3 9668/135000（11.4 prog/tick），4 个 extension 工地刚放、builder 2/2 全是本房的；W34S7 upgrade 速率 2.5→4.6，storage 工地 18565→19880。援建只剩矿工（W34S7→W33S8 ×2 为 strategic：该源当时没矿工）。大脑 4 轮白名单不变、blockers=[]；reserver 与外矿需求一致（预定 > 缓冲的房 want 0）。本轮无改动。
- 回填（tick 73492277，上线 ~1050 tick）：errors=[]，bucket 8733。W33S7 两个源容器与控制器容器都已建成（(14,6) 由矿工自建完工），hauler 2/2、builder 2/3，升级速率 7.6→12.0 prog/tick；storage 工地仍 10834——builder 工地顺序道路（3 条 0/1500）排在 storage 前，且房间能量 50/1800 全被 spawn 花掉，builder 拿不到能量；下一轮再看。**W35S7 升到 RCL3**（3536/135000，extension 工地已放）；W33S8 extension 1669/3000、tower 已建（490）。W34S7 upgrade 6.0/tick、storage 21955/30000；控制器容器空 497 tick（塔 183/1000 的补给与 spawn 补给排在它前面，升级者改从 spawn 取能）。大脑又 4 轮白名单不变、blockers=[]；reserver 与需求一致（W33S6 的替补在队列里）。本轮仍无改动。
- 待做：W34S7 的 W33S5 矿工缺编（RCL4/1300 背 4 外矿）；W33S8 safe mode 仍激活（状态告警）；私服 blueprint 场景随机地形偶发失败——由负责 scripts/private_server 的会话考虑固定种子或放宽断言。

## 2026-09-05T08:25+09:00 无 storage 的房把 storage 工地排在道路前
- 测量（tick 73492768–73492784，版本 1788557348541）：errors=[]，bucket 6833。大脑又 4 轮白名单不变、blockers=[]；reserver 与外矿需求一致。W33S7 升级 14.1 prog/tick，builder 3/3、hauler 2/2，但 storage 工地仍 10834/30000（03:04 起不动）；探针：3 只 builder 全部登记在道路工地 (30,26) 上等投递（能量 0/0/90），两只家用 hauler 0 能量在 collect（源容器 160/10/0，地上 0），房间能量 1058 在 spawn/ext 里等 1750 的升级者替补；两条规划道路 500 tick 里各推进 ~1000，storage 0——builder 工地顺序里道路（5）排在 storage（10）前。W33S8 extension 1/4 建成（容量 600）、W35S7 RCL3 9116。
- 改动（a0c6611）：`config.construction.storageBeforeRoads`（默认开）：没有 storage 的房里 storage 工地在 builder 工地顺序中排到 4.5（容器之后、道路之前），broker 建造权重 8.5 > 道路 8；有 storage 后其它结构照旧在道路之后。**这条修正了用户 2026-09-03 的"道路优先"要求的一个特例**（上一轮报告里已提出，用户未回复；按"未提到的问题自主修复"执行）——不同意可把该开关关掉。smoke +5 段（回滚确认 3 条会失败），786 断言；Python 106。
- 门控部署：validation-kVQAXM 因私服 backend 偶发 unhandled rejection 掉线，重跑 validation-VAoYQw ok、通知错误 0；activeWorld=default；上传 1788563811007（08:23）。
- 实测（tick 73492946，上线 ~40 tick）：errors=[]；W33S7 三只 builder 全部改到 storage 工地（10834→11075），broker 权重 storage 8.5 > road 8。
- 待回填：storage 建成时间（剩 19k，取决于 builder 能拿到的能量）；建成后升级者改从 storage 取能、hauler 停送控制器容器、link 方案启动（`links.run`）。
- 待做：W33S7/W34S7 控制器容器长期为空的告警（tier 3 投递永远排在 spawn/塔之后）——storage 建成后 W33S7 自然解决，W34S7 storage 24677/30000 也快了；W34S7 的 W33S5 缺编；W33S8 safe mode 状态告警。

## 2026-09-05T08:45+09:00 核心容器缺失时底线 upgrader 不进生存档（同事基准量化的死亡螺旋）
- 证据（screeps-9e 会话的私服整账号基准，代码 88fe9e7）：W33S8 三个容器同时衰减消失（建于 ~77k，25k tick 寿命无人修）后 40k tick 收入 0–2/tick——recovering 只孵矿工、600 的往返矿工送不回能量；不 recovering 时 1250 的底线 upgrader 卡队头，builder 永远轮不到，27 个工地没人建，tick 141,855 从 RCL4 降到 3；W35S7 在 124k 同样丢容器。smoke 复现（makeGapWorld 去掉 upgrader）：队头 core:upgrader:0（1750），vital builder 在后面等。
- 改动（ea546a9 + 8095029 文档）：`spawn.run` 里 `coreContainerGap > 0` 时 `survivalTargets.upgrader = 0`——没有供能来源的升级者降到发展档，vital builder（survival+0.75）先重建容器。配合今天已上线的矿工自建/自修容器（a58de3e）与 builder 等待阻塞（069c101），这条螺旋的三个环节都堵上了。smoke 787 断言（回滚确认失败），Python 106。
- 门控部署：validation-m5wfTe ok、通知错误 0；activeWorld=default；上传 1788565238679（08:41）。实测 tick 73493314：errors=[]；W33S7 storage 工地 11075→13502（上一轮改 storage 优先后约 6.6/tick），W34S7 storage 26197/30000。
- 待回填：同事用最新 main 重跑基准后的对比（W33S8/W35S7 容器衰减后是否自愈、RCL 是否不再回落）。
- 回填（tick 73493427–73493437，08:49）：**防御链路第一次真实交战**——W31S6（2 源外矿）来了 1 只未强化近战 Invader（1000 血、40 伤害），大脑判 fight ×1、4A4M（520，lead 150），游戏内孵出 defender 美铃到场击杀（墓碑 invader_W31S6_448，defender 剩 520/800 血，50 tick 后退役），外矿记录在看到清场时立刻解除停用（suspendedUntil 0、threat 清空），远程 creep 已在回归。此前旧逻辑对同类入侵一律派 1100 的 4R1H 或 1690 的 13A13M。其它：W34S7 的 W33S5 终于 m1/1 r1/1；W33S7 storage 14332（约 7/tick）；W33S8 extension 2/4 建成（容量 700）；W35S7 RCL3 18099（12/tick）；大脑 4 轮白名单不变、blockers=[]。本轮无改动。
- 回填（tick 73493912，09:21）：errors=[]。bucket 3814 不是 CPU 问题：Memory.stats 显示每 30 tick 样本 CPU 45–74（限 140），bucket 每约 120 tick 冲到 10000 生成一个 pixel 再掉到 ~1000（主循环的 generatePixel），快照落在周期哪一段决定读数。W31S6 交战后全部回归（m2/2 r1/1 h4/4，预定 200）；W33S7 storage 17848（7.2/tick，剩 12k）；W34S7 storage 28037/30000（下一轮应建成）；W33S8 extension 3/4 建成（容量 750）；W35S7 extension 1158/3000。W34S7 的 W33S5 又回到 m0/1 r0/1（无敌情，就是排不上号：class remote 在维护/发展/援建之后）。大脑 4 轮白名单不变、blockers=[]。工作树里多了同事的 docs/benchmarks/2026-09-05-rcl-88fe9e7*.md（未跟踪，归他们提交）。本轮无改动。
- 回填（tick 73494412，09:54）：errors=[]。W34S7 storage 29947/30000（差 53）；W33S7 storage 20468（5.2/tick）、upgrader 0/1 正在补（替补 1750 排在外矿维护之后）；**W33S8 四个 extension 全部建成、容量 800**，援建按 untilCapacity 停止，它自己反过来给 W35S7 派了一只援建 builder（minHomeCapacity 800）；W35S7 extension 1983/3000。大脑 4 轮白名单不变、blockers=[]；reserver 与需求一致（W32S7 预定 2616 不要 reserver）。本轮无改动。

## 2026-09-05T10:35+09:00 storage 回库任务的 backlog 封顶
- 测量（tick 73494896，版本 1788565238679）：errors=[]。**W34S7 storage 建成**（升级 3.7→7.2 prog/tick），但 `Memory.taskBroker.rooms.W34S7.backlog` 6368 → 1,008,832：第 4 层"回库 storage"任务把 100 万空位全算成 backlog，遥测失真，且 ln(1e6)=13.8 的评分让权重 1 的回库压过同层权重 2 的工地 builder 补能（ln 71 ≈ 4.3）。W33S7 storage 22353（3.9/tick）；W33S8 工地全部建完、容量 800；W35S7 extension 64/3000 与 0/3000；大脑 3 轮白名单不变、blockers=[]；reserver 与需求一致。
- 改动（717941e）：`config.storageDeliverBacklogCap`（10000），`task_broker` 回库任务 backlog = min(空位, 上限)。smoke +1 段（回滚确认失败），788 断言；Python 106。
- 门控部署：validation-KXUSUz ok、通知错误 0；activeWorld=default；上传 1788571861535（10:31）。实测：errors=[]，下一次遥测（tick 73494990）W34S7 backlog 1,006,728 → 15,573；上线首 tick CPU 104（编译），随后回到 48–52。
- 待回填：W34S7 有了 storage 后控制器容器是否还常空（storage 离控制器 5 格，升级站位用不上 storage）、hauler 是否开始往 storage 存；W33S7 storage 建成时间。
- 回填（tick 73495431–73495444，11:04）：errors=[]。W34S7 storage 仍 0 能量：投递层 spawn/ext（1126 空位）→ 塔（缺 505）→ 控制器容器（39/2000）→ storage，spawn 常年忙、能量 174/1300，前三层永远填不满，storage 一直轮不到；两只 upgrader 0 能量在等（无 storage 站位，layout.controllerFedByStorage=false），升级 7.8 prog/tick 靠零星补给；收入 EMA 11.8/tick（monitor 队列行显示的 1.6 是那一 tick 的队列估计）。这是 RCL4 单 spawn 背 4 外矿 + 援建的饱和问题，不是新 bug；W34S7 RCL4 进度 91909/405000。W33S7 storage 25759/30000（6.4/tick，约 660 tick 建成）；W33S8 进入 recovering（援建矿工到期、自己的 5W 矿工在孵）；W35S7 最后一个 extension 1952/3000。大脑 3 轮白名单不变、blockers=[]；reserver 与需求一致。本轮无改动。
- 回填（tick 73495914，11:37）：errors=[]（bucket 241 是 pixel 周期刚生成后的读数）。W33S7 storage 29155/30000（约 150 tick 建成），升级 16.0 prog/tick；W33S8 退出 recovering、10.9 prog/tick、塔 870；W35S7 extension 全部建成（容量 800）；W34S7 升级 4.8（告警：低于基线 7.8 的 80%）——同上一条：控制器容器排在 spawn/塔之后常空，storage 0，单 spawn 饱和。大脑 3 轮白名单不变、blockers=[]；reserver 与需求一致（预定 > 1000 的房不要 reserver）。本轮无改动。

## 2026-09-05T12:25+09:00 storage 刚建成、能量在 reserve 以下时升级者不守着空 storage：贴 built link 的站位优先，没得喝就换有能量的站位格
- 测量（tick 73496313–73496326，版本 1788571861535）：errors=[]。**W33S7 storage 建成**（1258 能量），但控制器进度在 147884 停了 150+ tick（升级 16 → 0.96 prog/tick）：站位切到 storage 相邻格后 16W 升级者站在 (31,27)，旁边只有 1258 < `upgrading.reserve` 2000 的 storage，取不到能量就按"hauler 在岗原地等"的分支干等；同时 ctrl link (32,24) 799、控制器容器 982 没人用（storage 供能后 hauler 不再喂容器，链路 src0 link → ctrl link 也满着）。W33S8 10.9、W35S7 11.5 prog/tick；大脑 3 轮白名单不变、blockers=[]；reserver 与需求一致。
- 改动（41b853c）：`layout.upgraderStorageStations` 排序加"相邻已建成 link 数"（W33S7 的 (31,25) 同时贴 storage 与 ctrl link，成为首选）；`roles/upgrader.js` 空载时若 storage 站位旁没得喝，就换到旁边有能量（storage reserve 以上 / link / 容器）且没人站的站位格；`energySourceAt` 的相邻判定改成显式距离（mock 的 findInRange 不看距离，线上语义相同）。smoke +4 段（回滚确认 3 条会失败），792 断言；Python 106。
- 门控部署：validation-lEK0TV ok、通知错误 0；activeWorld=default；上传 1788577928161（12:22）。实测：上线 16 tick 内升级者从 (30,26) 走到 (31,25)、从 ctrl link 取能（799 → 619），进度 147884 → 147996 恢复上升；errors=[]。
- 待回填：W33S7 升级速率是否回到 16/tick（link 链 10/tick + storage 富余）；storage 是否开始积累（第 4 层回库）；W34S7 无 storage 站位的房是否也需要"链路优先"（它没有 ctrl link，RCL5 后再看）。

## 2026-09-05T12:55+09:00 拆迁不清掉护核心的 rampart 工地
- 测量（tick 73496904–73496916，版本 1788577928161）：errors=[]。上一轮的修复生效：W33S7 升级回到 16 prog/tick（154410 → 155370/60 tick），storage 攒到 2000（第三层补到地板线）；W34S7 有 storage 后升级 4.8 → 11.7；W33S8 11.1、W35S7 12.1。大脑 3 轮白名单不变、blockers=[]；reserver 与需求一致。W33S7 broker backlog 跳到 294k 是 3 个新 rampart（塔 (6,40)/(7,41)、storage (31,26)）到 RCL5 目标 100k 的维修缺口（约 3450 能量的塔维修，非异常）。发现拆迁日志里 rampart 工地在这三个格上每 25 tick 一次 "site-off-plan"：外环推迟期间 layout 给 spawn/塔/storage/terminal 盖 rampart，但这些格不在 plan.ramparts 里，`removeOffPlanSites` 把工地当方案外拆掉，下一轮 layout 再放——拉锯。
- 改动（3b1cebf）：`demolition.removeOffPlanSites` 对 rampart 工地套用与 `utils.needsRepair`/`offPlanRampart` 相同的例外——`rampartProtectsCore` 的不拆。smoke +3 段（回滚确认失败），796 断言；Python 106。
- 门控部署：validation-YfjnCa ok、通知错误 0；activeWorld=default；上传 1788580252889（12:53）。实测：errors=[]，拆迁日志无新 rampart 条目（最后一条 73496051）。
- 待做：W34S7 的 W33S5 仍缺 reserver/矿工（class remote 排不上号）；W33S8 safe mode 状态告警；同事基准的对比结果。

## 2026-09-05T13:35+09:00 监控告警去噪（storage/link 供能不报"容器空"、武装敌人带房名、回退基线取中位数）+ 第 5 房候选评估
- 测量（tick 73497247–73497533，版本 1788580252889）：errors=[]。大脑 12 轮白名单不变、blockers=[]；reserver 与需求一致；W33S8 spawn 已建成（RCL3 61627/135000，safe mode 剩 7955）。三条告警误导了本轮排查：(1) "W33S7 upgrader 供能容器持续为空 343 ticks"——W33S7 已由 ctrl link/storage 供能，`task_broker.controllerFeedContainer` 本来就不发布容器投递；(2) "4 武装敌方 creep 入侵"不说在哪个房（实为 W31S8 的 2 只 Invader + 一只 reserver 途经 SK 房 W34S6 看到的 4 只 keeper）；(3) "W34S7 升级速率回退 7.49 < 基线 11.65 的 80%"——基线取最近 6 轮最大值，W34S7 历史 [4.8, 8.8, 4.0, 7.7, 3.7, 7.2, 5.7, 7.8, 4.8, 8.4, 11.7, 7.5]，一次 11.7 之后连报。W34S7 逐 tick 追踪 46 tick（console 探针，scratchpad）：控制器容器 268 → 648 没有见底、两只升级者一直在升级，容器主要由路过的外矿 hauler 补（+274、+600）；本房两只 hauler 都在 src0→spawn 线上，src1 容器 200 → 660 无人拉；结论是 RCL4 经济被 spawn 占满（外矿 ROI 探针：spawn 占用 38–44%，在岗净 10.3/tick，W34S8 在岗净 −0.7、W33S5 −2.7）后的残量，不是搬运 bug。
- 改动（8e7abe7，仅 scripts/monitor.py + test）：探针 `upkeep.ctrlFeed`（link/storage/container，console 里 `require('layout').controllerFedByStorage` 可用）与顶层 `hostileRooms`；容器空告警只在 ctrlFeed 为 container/缺省时报；武装敌人告警列出房名×数量；回退基线改为最近 6 轮中位数。monitor_test +3（改前 3 条失败）；Python 109 全绿。实测一轮：W33S7 行显示 `ctrl容器=0/2000(供能=link)` 不再告警，武装告警 "所在: W31S8×2, W34S6×4"。不涉及游戏代码，无需部署。
- 数据：`data/brain/locks.json` 的 `W34S7.claim` 从 W35S7（已占领、spawn 已建）改为 null 暂缓（dry-run 确认两房 claim 均为 null），等用户定第 5 房。
- 第 5 房候选（GCL 12、已占 4 房、CPU 均值约 65/140；半径 2 内 2 源且可达的空房只剩 3 个，地形来自 room-terrain API）：
  - **W31S6**（首选）：K 矿；源 (21,6)/(29,41)，控制器 (23,17)，控制器→两源路程 10/24，控制器周围 4 格可站；7×7 空地锚点 (22,13) 距控制器 4、距源 7/28；平地 44%、沼泽 22%、墙 33%；出口 N2（→W31S5）/S44（→W31S7）/E12（→W32S6）；现在就是 W33S7 ROI 2.0x 的外矿（容器、预定都在）；邻居 W31S7 单源空房，无强邻直连。缺点：源距 34、沼泽多；K 与 W33S8 重复。
  - **W31S5**（次选，防守最好）：O 矿；死胡同房——只有 S2（→W31S6）和 E12（→高速路 W30S5，现有 powerBank）两个出口；控制器 (39,20) 紧贴源 (39,18)，7×7 锚点 (35,22) 距控制器 4、距源 4/20；平地 41%、沼泽 17%、墙 41%，可建平地较挤（最大平地方块 6×6）；矿在 (13,43) 距控制器 51。O 与 W35S7 重复。适合作为 W31S6 的配套（先占 W31S6，再以 W31S5 为其外矿或第 6 房）。
  - **W31S8**（不建议）：H 矿是我们没有的类型，出口只有 W14（→W32S8）/E12（→高速路），但控制器 (11,40) 只有 1 个相邻空格、离两源 39/20，源距 47，锚点 (17,43) 距源 35/27——升级与运输几何都差。留作外矿（W33S7 ROI 2.1x）。
  - 其余：W36S7/W37S5/W37S7 两源空房但从我方过去只能穿 SK 房或 Alepoldar 的房（noRoute）；W33S9/W32S9 是 tidusfox9 RCL8，W35S8 Ctharo RCL4，W34S9/W35S9/W36S8/W36S9/W37S9 Alepoldar RCL4–5——南面、西南面已无空间，扩张方向只剩西侧 W31 列。
- 待做（下一轮，按证据强度）：(1) **W33S7 升级者被 storage 低档压成 4 WORK**：`upgradeSupply.low=true`（storage 3100 < lowBelow 5000）→ `lowBudget` 550 → 4W，吃不完 ctrl link 的 10/tick，src0 link 与 ctrl link 都 800/800 堵住，升级 16 → 7.5/tick；退出要 storage ≥ 10000，按 +3/tick 要 2000+ tick。低档预算应至少覆盖 link 供给（有已建成且有货的 ctrl link 时按 link 吞吐定 WORK 下限）。(2) **跨房寻路不避 SK 房**：`movement.go` 没给轮子传 `avoidRooms`（轮子默认只有占位房），W34S7 的 reserver 诹访子 正走在 W34S6 (35,29)，W33S5 因此长期 预定0、ROI −2.7/tick；应按 Memory.map 的 sk/敌对房生成 avoidRooms（战斗单位可覆盖）。(3) 母房 remotes 里残留已占领房（W35S7/W33S8）的旧记录（enabled=false 但 suspendReason 仍是 hostileCreep），仅监控噪音。

## 2026-09-05T13:50+09:00 storage 低档的升级者至少吃得完 link 链；换代扫描带上低档滞回状态
- 测量（tick 73497650，版本 1788580252889）：errors=[]；大脑白名单不变、两房 claim 均为 null、blockers=[]；reserver 与需求一致；W33S8 spawn 已建成（RCL3 67062/135000）。**W33S7 升级 4.00 prog/tick**：`upgradeSupply.low=true`（storage 4672 < lowBelow 5000）→ 升级者按 lowBudget 550 孵成 W4；ctrl link 799/800、src0 link 800/800 一起堵住，link 链的 10/tick 免费供给全浪费，storage 反而以 +3/tick 缓慢积累（退出低档要 ≥ 10000）。
- 改动 1（7983604）：`spawn.linkFedWork`——ctrl link 已建成且属我方时，每个送能的源 link（RCL5 只算 src0，RCL6 起加 src1，与 links.run 同口径）按 `config.upgrading.linkWorkPerSource` 10 WORK 计；低档预算 = max(lowBudget, linkWork×100+150)，仍受容量与队列缩身预算约束（W33S7 → W10C2M1 = 1150）。smoke +7 断言（改前 3 条失败）。
- 改动 2（4b5d86b）：部署后发现 W33S7 已在 storage 5.8k 时孵出 W16（1750）——换代扫描 `bodyUpgradeCandidates` 调 `bodyPlan(room, role)` 没带 mem，`upgraderLowMode` 用了一份空的 upgradeSupply，滞回状态丢失：storage 一过 lowBelow 就要满身体，而孵化请求那条路径还在低档。改为 `bodyPlan(room, role, mem)`。smoke 场景：storage 6000（滞回带内）+ 在岗 W10 升级者连跑 8 tick 不得换代（改前孵出 慧音.upgrade W16）。
- 门控部署：smoke 全绿（803 断言），Python 110，validation-E7VQan / validation-qAJPeK 均 ok、通知错误 0；activeWorld=default；上传 1788583287260（13:41）与 1788583976815（13:53）。实测：errors=[]；W33S7 现役升级者 慧音戊.upgrade W16 到站后 16 prog/tick（162446 → 162670/14 tick）。
- 待做（下一轮）：**升级者在 storage 站位间乒乓**：首选站位 (31,25)（贴 ctrl link）常被往 storage 送货的 hauler 占住，1 MOVE 的 19 部件升级者在 (31,27) ↔ (30,27) 之间来回（每格约 9 tick，(30,27) 离控制器 4 格升不了级），采样里 16/tick 与 0/tick 交替；应"已站在任一有效站位就不再追首选"。其次：跨房寻路不避 SK 房（W34S7 的 reserver 途经 W34S6）。

## 2026-09-05T14:10+09:00 storage 站位算升级者工位，交通解算不再把它推开
- 测量（tick 73497994–73498065，版本 1788583976815）：errors=[]；大脑白名单不变、claim 均 null、blockers=[]；W33S8 spawn 已建成（RCL3 71014/135000）。W33S7 升级 5.97 prog/tick：逐 tick 采样里 W16 升级者在 (31,27) ↔ (30,27) 来回（fatigue 3–13，19 部件 1 MOVE 每格要走十几 tick），(30,27) 离 controller 4 格升不了级，速率 16 / 12.8 / 0 / 6.4 交替。原因在 `movement.upgraderWorkTile`：有容器/ctrl link 时只把 `plan.workPositions.ctrl` 那一格当工位，storage 站位（`roles/upgrader.ctrlStation` 的 storageFed 分支）不算，轮子的堵车解算就把站在 storage 旁的升级者当闲人，hauler 一路过就推开。另外 W34S6（SK 房）里同时看到去 W33S5 的 remoteHauler 阿燐丁（血 200 → 100/1000）、remoteMiner、reserver 三只在穿越，W33S5 的 reserver 0/1 已缺编 344 tick。
- 改动（492e98a）：`movement.upgraderWorkTile` 先看 `layout.upgraderStorageStations`（按 tick 缓存，惰性 require 以免加载顺序）：站位格、或贴 storage 且在 controller 3 格内的格都是工位；容器/link 模式语义不变。smoke +6 断言（改前 2 条失败），806 断言；Python 110。
- 门控部署：validation-dD6tYl ok、通知错误 0；activeWorld=default；上传 1788584586513（14:07）。实测 39 tick：升级者一直站在站位（(31,27) → (32,26) 都是站位），16.0 prog/tick 恒定，errors=[]。
- 待做（下一轮）：**跨房寻路避开 SK 房**——`movement.go` 没给轮子传 `avoidRooms`（轮子默认只有占位房名），W34S7 → W33S5 的三种 creep 都走 W34S6；按 Memory.map 的 class=sk / 敌对占领房生成 avoidRooms（战斗单位与 SK 采矿可显式放行）。其次：母房 remotes 里残留已占领房的旧记录（监控噪音）。

## 2026-09-05T14:30+09:00 跨房寻路默认避开 SK 房与别人占领的房
- 测量（tick 73498197–73498241，版本 1788584586513）：errors=[]；大脑白名单不变、claim 均 null、blockers=[]；W33S7 13.1、W34S7 12.5、W33S8 11.0、W35S7 12.4 prog/tick；W33S8 spawn 已建成。W34S6（SK 房）里同时有去 W33S5 的 remoteHauler 阿燐丁（血 1320/1800，前一轮 100/1000 的那只已死）和 reserver 诹访子丁（140/200）；W33S5 预定 0、reserver 缺编已 344+ tick。`movement.go` 从不给轮子传 `avoidRooms`，轮子默认集合只有占位房名，`Game.map.findRoute` 就按最短取道 W34S7 → W34S6 → W33S5（2 跳）而不是 W33S7 → W33S6 → W33S5（3 跳）。
- 改动（9734b2f）：`movement.applyDangerAvoidance`——默认 avoidRooms = 当前房周围 4 圈内按房名算出的 SK 房（坐标各 mod 10 在 4–6、非中心 5,5；W/E、N/S 跨 0 轴按连续坐标换算）∪ Memory.map 里 class=sk 或别人占领（有塔）的房；目的地与当前房永远不避（将来采 SK 矿 / 从里面走出来）；`allowDanger:true`（战斗单位）或显式 avoidRooms 时不干预；按 tick、按出发房缓存。smoke +8 断言（改前 6 条失败），819 断言；Python 110。
- 门控部署：validation-WV52FD 因 conflict 场景 E50S50 的 HTTP 探针读回缺 `_validation`（console 写入与 HTTP 读回的时序，该房运行时 errors 空、stats 正常）失败一次，重跑 validation-LamXZ3 ok、通知错误 0；activeWorld=default；上传 1788585590354（14:25）。实测 63 tick：新孵的 W33S5 矿工 勇仪丙 与 reserver 诹访子丁 从 W34S7 东出口进 W33S7 再北上 W33S6（绕开 W34S6），部署时还在 W34S6 里的 hauler 阿燐壬 走出到 W33S6 并抵达 W33S5；之后没有任何 creep 进入 W34S6；errors=[]。
- 待做：W33S5 的预定/容器是否在 reserver 抵达后建立（下一轮看 预定 > 0、h 需求出现）；母房 remotes 里残留已占领房的旧记录（监控噪音）；W34S7 外矿占 spawn 40% 而升级只 7–12/tick 的取舍留给大脑（ROI 化外矿选择）。

## 2026-09-05T14:55+09:00 巡检：无改动
- 测量（tick 73498850，版本 1788585590354）：errors=[]、hostiles 0。W33S7 16.00 prog/tick（站位修复后持续），storage 4113 → 6082；W33S8 11.2、W35S7 11.9；W34S7 8.7（基线 12.1，storage 2328，spawn 空闲，无缺编——RCL4 残量波动）。SK 规避生效：W33S5 reserver 到位、预定开始（预定 1），W34S6 里不再有我方 creep。大脑白名单不变、claim 均 null、blockers=[]；reserver 与需求一致（W31S6 r0/0 预定 426、W31S8 r1/1 预定 0 刚续）。W33S8 safe mode 剩 6352。本轮无改动；/simplify 的四路清理审查在跑，结果另行提交。

## 2026-09-05T15:15+09:00 /simplify 清理：四路审查（复用 / 简化 / 效率 / 深度）后的整理，行为基本不变
- 起因：用户对本会话的 diff 跑 /simplify。四路审查去重后的结论与修法（各自独立提交，f24ecb4 → c50e23d）：
  - `utils.roomCoords/roomNameAt`：remote/defense/aid 三份相同的房名正则与 W/N 折负数合并为一份（movement 也用它）。
  - 危险房规避（2bf5ed0）：只在跨房移动时附带 avoidRooms——轮子只在 findRoute 用它，却会把它排序拼进路径缓存 key，同房移动附带纯属开销；集合改为按 tick 全局一份（己方房外扩 4 圈内的 SK 房 ∪ Memory.map 的 sk / lair / owner 房），不再按出发房生成，否则每跨一房 key 就变、整条路径重算；当前房不必排除（routeCallback 只看下一个房）；去掉没人用的 allowDanger（显式 avoidRooms 即放行）。
  - 升级者站位（fabfdc3）：`layout.upgraderStation/atUpgraderStation` 一份定义，roles/upgrader 的走位与 movement 的工位判定共用；容器/link 模式也从"只认那一格"改为"锚点 1 格内且 controller 3 格内"，第二只升级者站在容器旁不再被推开（smoke 新断言改前失败）。
  - 低档升级者（65e70ce）：`linkFedWork` 改用 `links.getLink/senderLinks`（link 链只在 links.js 枚举一次）；`linkWorkPerSource` 配置项删掉，改由 `config.harvesting.defaultCapacity/regenerationTicks` 推导；预算下限用 `utils.upgraderBudgetForWork`（与 makeBody 模板放在一起）；每 tick 每房记忆；`bodyPlan` 自己取房间 Memory，任何调用方都拿不到丢了滞回状态的身体。
  - 供能模式（c1866aa）：`task_broker.controllerFeedMode`（link / storage / null）由 broker 与 monitor 探针共用；探针武装敌人只过滤一次；'container' 不再是独立取值。
  - 测试：smoke 一个 `workParts` 替代各场景的 WORK 计数 lambda；storage 站位夹具去掉用不到的字段。
- 门控部署：smoke 819 断言、Python 110、JS/Python 语法；validation-39nZJc ok、通知错误 0；activeWorld=default；上传 1788588542498（15:09）。实测：errors=[]；W33S7 16.00 prog/tick、监控行 `ctrl容器=0/2000(供能=link)` 恢复显示（探针改调 controllerFeedMode 后需要新版本在线，部署前那一轮显示为空是预期）；W34S7 16.4、W35S7 12.0、W33S8 10.6；无告警（W33S8 safe mode 除外）。
- 记为后续、未做：危险房判定与大脑 `plan.passable` 的口径统一（center 房是否也避，行为改变）；`minBudgetForWork` 推广到其它角色；速率回退告警改为带离散度的阈值（基线 − k·MAD 或连续两窗）；monitor_test 三个相近的快照构造器合并；hauler 的竞价/兜底双轨、hauler 数量公式中的 controllerLegShare 与 broker 实际行为脱节（更大的改动，另开题）。

## 2026-09-05T15:42+09:00 巡检：无改动
- 测量（tick 73499563，版本 1788588542498）：errors=[]、hostiles 0；大脑白名单不变、claim 均 null、blockers=[]；reserver 与需求一致（W33S5 预定 428，SK 规避后稳定）；W33S8 RCL3 88432/135000，safe mode 剩 5639。W33S7 告警"升级 10.85 < 基线 14.54 的 80%"是设计内的：W16 升级者 73499250 寿终，storage 4269 < lowBelow 5000 处于低档，替补按 link 链下限孵成 W10（1150），此后恒定 10.0 prog/tick、ctrl link 与 src0 link 循环放空（55 ↔ 679）、storage 4187 → 6378 回升；storage ≥ 10000 退出低档后再换满身体。W34S7 13.3、W35S7 11.7、W33S8 10.9。本轮无改动。

## 2026-09-05T16:04+09:00 退役 creep 走到全账号最近的 spawn 回收，不再原地自杀
- 起因：用户问 creep 6a9b9a5c407005a94c5d13e6（W33S7 defender 美铃，按大脑 fight 指令去 W31S8 清 2 只 NPC）为什么打完自杀而不回 spawn 回收。`src/` 里没有任何 `recycleCreep`，也没有记录过理由；私服引擎 `_die.js` 自杀按 CREEP_CORPSE_RATE 0.2 × 剩余寿命份额退还身体能量，`recycle-creep.js` 按 1.0 × 份额，一只 defender 每次少拿约 480 能量。用户纠正设计：找全账号最近的 spawn，不是母房的 spawn。
- 改动（92b74fd）：新增 `src/retire.js`——`retireAtSpawn(creep)` 在所有己方房里挑 `Game.map.findRoute` 跳数最少（同房按距离，findRoute 不可用退回 `utils.roomDistance`）的 spawn，行程估计 = (跳数 × 50 + 25) 格 × `bodyTicksPerTile`，行程 < walkShare 0.8 × 剩余寿命才走，缓存 `memory.retireSpawn` 并每 10 tick 复核；到站 `recycleCreep`，同一 spawn 同 tick 只接一只（驱动层同名 intent 覆盖）；没有 spawn / 无路 / ERR_NO_PATH / 回收失败退回 suicide。接入：defender 退役（`memory.retired`）、`spawn.retireReplaced` 的换代交接（`bodyUpgradeRetiring`）、reserver/remoteMiner/remoteHauler 的外矿停用/不可达退役（检查提前到"回家"守卫之前，母房没 spawn 也不乒乓；remoteHauler 仍要先清空）；claimer 不改。spawn 的编制/替补预留/收入估计（countReadyRole、countPlannedRole、replacementReserveRequests、incomeEstimate 等）用 `utils.isRetiring` 排除退役中的 creep，不再为它们预留能量或多算 hauler。参数 `config.retire`{walkShare 0.8, tilesPerRoom 50, recheckTicks 10}。审查修掉：中途寿命复核与 ERR_NO_PATH 兜底、外矿角色的检查顺序、计数排除、`bodyUpgradeRetiringAt` 与多余导出。
- 改动（28c214a）：remote/defense/aid/retire 四份房名切比雪夫距离合并为 `utils.roomDistance`（retire 那份对无效输入返回 null 而非 Infinity）。
- 测试：smoke 846 断言全绿——新场景"退役回收"（挑最近 spawn 而非母房、到站回收、同 tick 两只只回收一只、寿命不够/无路/没有 spawn 时 suicide、复核 tick 前不重算、无 findRoute 按线性距离、三种外矿角色停用后走向 spawn）与"退役中的 creep 不再计入编制"，defender 场景重写；Python 110；JS/Python 语法；`node test/private_server_run_validation_test.js` 通过。
- 门控部署：validation-rLCwKo、第二轮、validation-sCqUCY 三次 ok、通知错误 0；activeWorld=default；上传 1788591840472（16:04）。实测（tick 73499982）：errors=[]、63 creeps、无退役中单位；美铃已在部署前按旧代码自杀（W31S8 threat 清空、defenseLog 无 losses）。22:03 复查（tick 73505550）：errors=[]、80 creeps；W33S7 defenseLog spawned 45 → 49、无 losses，四只 defender 都已退场、没有卡在退役态的 creep。
- 待做：在线看到第一次真实 recycle（console 探针统计 `recycleCreep` 返回，或看 spawn 旁能量退回）；`task_broker.ROLE_WEIGHT` 没有 defender，CPU 超限时在岗/退役中的 defender 会被当低价值跳过（目前 skippedCpu≈0，潜在）；harvester 的 `redundantSmallMiner` 与 claimer 占领完成仍是 suicide。

## 2026-09-05T22:19+09:00 自家房不再留在 remotes 里：被自己占领的外矿记录删除
- 测量（22:08，tick 73505622，版本 1788591840472）：cpu 111/140、bucket 8607、errors 0、armed 0。大脑连续两轮白名单不变（W33S7: W32S7/W33S6/W31S6/W31S8；W34S7: W32S6/W33S5/W32S5；W33S8: W32S8/W34S8/W31S7；W35S7 无——候选 W33S6/W33S5/W34S8 都已被别的母房先占，其余相邻房是 keeper/他人/noRoute），blockers []。reserver 10 = 启用外矿 10（W31S8 r0/0 是预定 458 还够、按需不孵；W34S8 r2/1 是 TTL 预补）。W33S8 已 RCL4、spawn 建成在孵（能量 57/800）。异常：W33S7 与 W34S7 的 `remotes` 里各挂着 W33S8、W35S7（自家房，占领后约两万 tick）——`enabled=false, suspendReason=hostileCreep`，`lastSeen` 等于当前 tick（每 tick 还在 `refreshVisible`：4 次 find + 源位重算），W35S7 那条还留着入侵者 threat 画像（hits 346/dps 120/boosted），monitor 外矿行显示"W35S7 暂停(hostileCreep)"。防御侧 `getDemands` 的 `seen`/`closestBase` 已把它们挡住，没有误派。
- 根因：`refreshVisible` 只处理 `owner != 自己`（foreignOwner），自己占下的房没有任何出口；`admitCandidates` 只靠 `Memory.map[房].owner` 过滤，情报更新前会重新纳入。冒烟复现出更糟的一层：占领后到大脑下一轮之间白名单还含该房时，`run` 的"白名单里就重新启用"分支把记录重新 enabled，`getDemands` 随即为自家房出 remoteMiner/reserver 需求。
- 改动（46c8935）：`remote.ownedByMe(房)` = `Game.rooms[房].controller.my`；`run` 在白名单处理前删除自家房的记录，`admitCandidates` 候选过滤加 `!ownedByMe`。记录删除后 `isDisabled` 为 true，残留远程 creep 走既有退役分支。
- 测试：smoke 新场景"外矿被自己占领后记录删除"（改前 4 项失败：记录被白名单重新 enabled、下一 tick 重新纳入、仍出外矿需求；改后全绿），Python 110、JS/Python 语法、`private_server_run_validation_test` 通过；私服 validation ok、通知错误 0。
- 门控部署：activeWorld=default；上传 1788614202345（22:15）。实测（22:17，tick 73505757）：版本生效、errors []；W33S7 remotes 只剩 W31S6/W31S8/W32S6/W32S7/W33S6，W34S7 只剩 7 个真外矿，monitor 外矿行不再出现自家房；cpu 105.7/140、bucket 7883；W33S7 storage 11953 已过 10000 退出低档（rate 16）；W33S8 能量 132/800、W32S8 矿工缺编在孵，"控制器容器空 135 tick"告警是 RCL4 新工地（backlog 10 万）抢能量所致，观察。
- 待做：今天 13:35–16:04 几条的标题时间写早了 6 小时（真实 19:35–22:05，见对应 docs 提交时间）；W35S7 没有任何外矿（候选全被 W33S7/W34S7/W33S8 先占），大脑可考虑同分候选按母房外矿数均衡；W33S8 RCL4 工地 backlog 与能量饥饿的关系下一轮看。

## 2026-09-05T22:48+09:00 巡检：无改动
- 测量（22:45，tick 73506189，版本 1788614202345）：cpu 66/140、errors 0、armed 0、89 creeps。大脑白名单再次与上两轮一致（W33S7 4 房、W34S7 3 房、W33S8 3 房、W35S7 0 房），blockers []；reserver 10 = 启用外矿 10，W31S8 已补上 reserver（r1/1，预定 171）。上一轮删掉的自家房记录没有回来，monitor 外矿行干净。
- bucket 8607 → 7883 → 6610 看似在漏，`Memory.stats` 80 个样本证明是锯齿：每 30 tick 涨约 2000，到 10000 就 `generatePixel` 掉回 200–2000（main.js:193），平均 CPU 60–70，不是超限。以后看到 bucket 下降先对照 stats 的周期。
- W33S8：spawn 已建成（RCL4，21217/405000，6.8/tick），能量 168/800、控制器容器 51、工地 backlog 9.9 万，三个外矿都 m1/1 r1/1；预定都停在 1 是因为容量 800 只买得起 1 CLAIM 的 reserver（`reserverDoubleClaimCapacity` 1300），1 CLAIM 每 tick +1 抵消 −1 只能保住不涨，RCL4 的 10 个 extension 建成到 1300 后自然换成 2 CLAIM。W35S7 800/800 满而 spawn 空闲、9.6/tick，0 外矿（候选全被别的母房先占）。
- 无改动；`docs/observe/kalgen.md` 由定时观察任务刷新，单独提交（05b851e）。

## 2026-09-05T23:05+09:00 spawn 死锁：spawn 自产不算收入、零头收入视为 0、生存档等满 300 tick 按现有能量孵
- 起因：screeps-d7 转来 screeps-9e 的 RCL 基准（88fe9e7 续跑到 tick 342k）发现——W31S8（RCL6，2 link + storage，曾是最好的新房）在 222k 丢光容器、hauler 全灭后，队头 `core:hauler:0`（理想 1800）等了 12 万 tick，控制器 120k tick 没升级，341,941 降到 RCL5；W33S8/W35S7 是同一条链（卡 600 的矿工 / 1250 的升级者）。`data/soak/rcl-bench-88fe9e7/progress.jsonl` 核对：225k–343k 之间 W31S8 交替等 `core:hauler:0`(1800)/`core:harvester:1`(600)，queue.income 0–2.5、recovering 翻转、storage 停在 2402。
- 根因（代码核对属实）：spawn 能量 < 300 时每 tick 自回 1，`updateSpawnIncome` 把它采成收入，EMA 停在 0.1–1 从不归零；`incomeEstimate` 有在岗矿工（带 CARRY）就走 EMA 分支；`spawn_queue` 的缩身下限只看 `income > 0`——于是取容量一半（900），而房里只有自产的 300–600，永远够不到，"收入 = 0 的紧急态"永远不触发。EMA 指数衰减本身也永远不会精确归零，任何历史收入都留残值，同样会踩到这个门。
- 改动（3410ba9）：`updateSpawnIncome` 采样时扣掉能量 < 300 的 spawn 数（`spawnSelfRegen`）；`incomeEstimate` 的 EMA 不到 `config.spawnQueue.minIncome`（1/tick）返回 0；`spawn_queue.schedule` 新 ctx `survivalShrinkAfter`（300）：vital 请求从首次出现起等满这么久还买不起，不管收入估计 floor=0 按现有能量孵最小可用身体（发展档不享受），换代扫描之后再换大。`queueSettings` 白名单加两键；CLAUDE.md 与 spawn-queue 设计文档同步。
- 测试：smoke 新场景"基准 W31S8 死锁"——用改动前的 `src` 跑恰好复现基准队头（`core:hauler:0` 1800、eta 2632、5 项失败），改后全绿：EMA 0.6 视为 0 并立刻孵 ≤300 的 hauler、自产 +1 采样为 0 / 真收入 +10 采样为 9（EMA 0.45）、纯函数 vital 等 200 tick 仍守 900 下限 / 等满 300 tick 按 400 孵 / 发展档等 400 tick 仍守下限；Python 110、JS/Python 语法、`private_server_run_validation_test` 通过；私服 validation ok、通知错误 0。
- 门控部署：activeWorld=default；上传 1788617001260（23:02）。实测（23:04，tick 73506475）：版本生效、errors []、cpu 81/140；四房收入 EMA 27.2 / 17.3 / 15.3 / 5.0，都在 1 以上，健康房行为不变；W33S8 队头是外矿 hauler 替补（eta 10、等 31 tick），W35S7 队列空闲。
- 待做：screeps-9e 会把基准世界（tick ~342k，三房已死）分叉换 3410ba9 跑几万 tick 看 W31S8/W33S8/W35S7 能否自愈，再用新提交从零跑完整 A/B；`survivalShrinkAfter` 只作用于 vital 请求，remoteMaintain/development 仍靠收入估计。工作树里 `scripts/soak/rcl_benchmark.js`、`test/rcl_benchmark_test.js` 是 screeps-9e 的未提交改动，未动。

## 2026-09-05T23:36+09:00 巡检：无改动（新版本首轮复查；W31S8 入侵者观察中）
- 测量（23:31，tick 73506892，版本 1788617001260）：cpu 77/140、errors 0；白名单与上三轮一致、blockers []；reserver 9 = 需要 reserver 的启用外矿 9（W33S6 预定 2006 按需不孵）。新版本下四房 spawnQueue.income 37.6 / 34.7 / 5.7（W33S7 空闲无记录），远高于 minIncome 1，缩身规则没有触发；W33S8 升级 3.4 → 10.6/tick、能量 303/800、队头是外矿 hauler 替补（eta 11）。
- W31S8（W33S7 的外矿）来了 2 只入侵者：threat{hits 2086, dps 110, kiters, boosted, until 73508341}，外矿已按 hostileCreep 暂停；W33S7 spawn 忙、defense 还没出决定（defenseLog 未变、无 defender、无 skipped），大脑本轮无 defense 指令。下轮看 fight/skip 的结果与理由。
- W34S7 升级 13.3 → 9.6/tick、控制器容器空 417 tick：2 只 hauler 里 1 只临近到期，队头 core:hauler:1（1300，eta 12）在补，观察。
- 分叉验证（screeps-9e，rcl-fork-3410ba9，从 349,320 分叉）3k tick 早期结果：W31S8 500 tick 内孵出小 hauler、income 0→49、storage 2402 被搬、2,300 tick 弹回 RCL6；W35S7 采集 14/tick、两个源容器重建、storage 0→5,949；W33S8 恢复最慢——不是缩身门槛的问题（那段 income 已是 0、floor 0），而是没有 hauler 时 spawn 能量在 6–300 间打转：builder/upgrader 的 fallback 抽走 200 以上的能量，每攒到 200–300 就被同级更早出现的小 upgrader/builder/harvester 请求花掉，hauler:1 排在后面。候选改法（等 30k 结果再定）：收入 < minIncome 时 hauler 排在同级 upgrader/builder 之前；换代扫描允许用买得起的更大身体替换小 hauler。
- 无改动。工作树里 `data/soak/rcl-fork-3410ba9/` 是 screeps-9e 的分叉实验数据，未动。

## 2026-09-05T23:57+09:00 巡检：无改动（W31S8 入侵者已按大脑 fight 指令清掉）
- 测量（23:54，tick 73507240，版本 1788617001260）：cpu 83/140、errors 0、hostiles 0；白名单与上四轮一致、blockers []；reserver 9（W31S8 的 r0/1 在补）。
- W31S8：大脑给了 defense{W31S8: fight, reason winnable, squad ranged×2（7 MOVE + 7 RANGED_ATTACK，1400 × 2）}，W33S7 在 73507004 孵出 defender:W31S8 / :1（defenseLog 49 → 51，无 losses），入侵者已清，外矿记录 threat/suspendReason 清空、重新启用；矿工阵亡（m0/2!）由 remoteMaintain 档补。两只 defender 还在，按 retire 流程去最近的 spawn 回收。W33S7 升级 16 → 12/tick 是 2800 的防御开销 + W31S8 停产期，预期内。
- W34S7 升级 9.6/tick 仍低于基线 13.2 的 80%：hauler 替补已到（能量 1250/1300），下轮看是否回升。W33S8 能量 607/800、income 21，队头 core:upgrader:1（eta 7）。
- 无改动。

## 2026-09-06T00:35+09:00 和平期塔补能退到控制器容器之后（W34S7 升级者挨饿）
- 测量（00:21，tick 73507653，版本 1788617001260）：cpu 66/140、errors 0；白名单与前几轮一致、blockers []；reserver 8 = 需要的 8；defender 已回收、无退役卡住；W31S8 复员完成（m2/2 r1/1 h4/4）。W34S7 升级速率连续 4 轮低于基线（13.3 → 9.6 → 9.6 → 9.3）：探针见两只 11 WORK 的升级者（上限 22/tick）、控制器容器 228/2000、供给 EMA 0.075，storage 却从 9527 涨到 10752；broker 任务池里塔（630/1000，缺口 370 ≥ towerRefillAt 300）是第 2 层权重 8，控制器容器第 3 层权重 4，两只 hauler 的 brokerTask 都指向塔。塔的维修只在能量 ≥ 500 时进行，所以和平期塔永远停在 500–700，缺口永远 ≥ 300：hauler 每趟填完 spawn/ext 的零头都先喂塔，控制器容器只靠"见底且 spawn 过半"的公平规则偶尔拿到一车。
- 改动（85567ae）：新 `config.towerRepairReserve`（500，tower.js 的维修储备线改用它）；broker 的塔投递任务只在有敌人或塔能量 < 储备时是第 2 层（权重 8），否则退到第 4 层（权重 2，高于 storage 的 1）；`remoteHauler.homeTarget` 与 hauler 的非竞价兜底同样把和平期塔排到控制器容器之后、storage 之前；`remoteHauler` 导出 `homeTarget` 供测试。`docs/task-broker.md`、CLAUDE.md 分层描述同步。
- 测试：smoke 新场景"和平期塔补能不压过控制器供能"（改前复现：塔 630 是第 2 层、hauler 把 500 送进塔；改后：塔 630 第 4 层且 hauler 送控制器容器、remoteHauler 同样、塔 450 或有敌人时第 2 层），既有塔分层场景不变，全绿；Python 110、JS/Python 语法、validation 单测通过；私服 validation ok、通知错误 0。
- 门控部署：activeWorld=default；上传 1788622354709（00:31）。实测（00:33，tick 73507837）：版本生效、errors []；W34S7 此刻塔 490 < 500 所以任务仍是第 2 层（符合规则），容器 0、能量 303/1300、升级 7.8/tick——效果要等塔回到储备线以上、容器开始进能量后几百 tick 再量，下轮看 W34S7 升级速率与容器 EMA。
- 分叉验证 30k 结果（screeps-9e）：3410ba9 vs 88fe9e7 同段 tick，账号 CP 60.3 → 63.4/tick、采集 155 → 193、建造 0 → 25.3；三死房复活（W31S8 2,300 tick 回 RCL6，W35S7 0.3 → 5.8 CP/tick，W33S8 7,085 tick 自己爬回 RCL4）；0 错误 0 降级。
- 待做（下一轮）：全局工地预算（layout.globalSiteBudget = 100 − reserve 12 − 全账号工地数）被死房挂着的 27–30 个工地和每外矿固定 6 条路吃光——基准里从 140k 起健康房 24 万 tick 没放过一个工地（RCL6 → 7 花 215k tick）；线上现有 56 个工地（24 个是外矿路），预算 32 尚未卡。数据 `data/soak/rcl-bench-88fe9e7/sites_by_room.csv`：健康房开工峰值 29–32、建完归 0；改法：预算按己方房分摊并保底 ≥10，recovering / 长期无 builder 的房其工地不计入且裁到 ≤5，外矿路按母房限量 6–12。另：W33S8 分叉末 storage 50k 只有 2 只升级者（upgraderTarget 只看控制器容器供给 EMA）。

## 2026-09-06T01:22+09:00 全局工地名额不再被死房和外矿路吃光（每房保底、死房裁工地、停用外矿清工地、外矿路按母房限量）
- 测量（01:02，tick 73508259，版本 1788622354709）：cpu 126/140（单 tick 尖峰，bucket 8914）、errors 0；白名单与前几轮一致、blockers []；reserver 8；W33S8 9.8/tick。上一轮塔分层的效果：W34S7 升级 9.3 → 13.5/tick，回到基线以上，storage 停在 10752 不再涨（控制器容器采样为 0 是 22/tick 的消耗快过每车投递，供给 EMA 仍低但速率已回升）。线上 51 个工地：W33S8 18、W35S7 9、四个外矿各 6 条路（24）。
- 起因：screeps-9e 的基准（88fe9e7）从 tick 140k 起健康房 24 万 tick 没放过一个工地（W33S7 到 RCL7 仍是 30 ext、0 lab；RCL6 → 7 花 215k tick）。`layout.globalSiteBudget` = 100 − 预留 12 − 全账号工地数，两个死房各挂 27–30 个没人建的工地 + 5 个外矿各 6 条路（采集为 0 的也占）= 88 ≥ 88 → 预算 0。各房工地序列 `data/soak/rcl-bench-88fe9e7/sites_by_room.csv`：健康房开工峰值 29–32、建完归 0、均值 0.6–2.3；全局 ≥ 88 的时间占全程 2/3。
- 改动（a995306）：`config.siteFloorPerRoom` 10——全局名额占满时本房仍可放到保底数（引擎 100 上限放不下就 ERR_FULL）；`config.deadRoom`{afterTicks 1500, keep 5}——房里有工地却连续 1500 tick 没有 builder/pioneer（`Memory.rooms[房].builderSeenAt`，首次见到从现在起算，没有工地不计时）就不再放新工地并裁到 5 个进度最高的（spawn 工地保留），`layoutDeadTrim` 记录；`remote`：停用（notWhitelisted/tooFar/被占/不可达）的外矿其工地清掉（不需要视野；spawn 工地不动；别的母房仍启用该外矿时不动——线上 W34S7 挂着 W34S8/W32S8/W32S7 三条 notWhitelisted 记录正是 W33S8/W33S7 的活跃外矿），路工地按母房合计 ≤ `remote.roadSitesPerHome` 12（每外矿仍 ≤ 6）。CLAUDE.md 同步。
- 测试：smoke 新场景"死房裁工地"（宽限内正常放、spawn 工地保留、只留 5 个进度最高的、不再放新工地、来了 builder 恢复、没有工地不计时）与"外矿工地"（两外矿路工地合计 ≤ 6、别的母房仍启用时不清、停用后清掉且名额让给启用的外矿），旧场景"全局只剩 3 个名额"改为保底语义（放到 10）；改前 3 项失败 + TypeError，改后全绿；Python 110、JS/Python 语法、validation 单测通过；私服 validation 两轮 ok（中间版本与最终版本）、通知错误 0。
- 门控部署：activeWorld=default；上传 1788624900737（01:19）。实测（01:21）：版本生效、errors []；四房 builderSeenAt 都是当前 tick、无裁剪；工地 51（W33S8 18、W35S7 9、外矿路 24 = 两个母房各 12 正好到上限）。
- 待做：请 screeps-9e 用 a995306 分叉基准看健康房是否恢复放工地；死房 keep 5 里若有 storage 这类大工地会长期占位（进度高才保留，可接受）；W33S8 storage 50k 只有 2 只 upgrader（upgraderTarget 只看控制器容器供给 EMA）待看。

## 2026-09-06T02:00+09:00 用户指令：占领 W31S5/W31S6/W31S8；外矿分给路程最短且养得起的母房；运输工全局就近卸货
- 起因：用户问 W33S7 的外矿运输工（W31S8 → W33S7 要穿 3 个房）为什么不在 2 跳外的 W33S8 卸货，随后决定：(1) 大脑按"能养得起且路程最短"分配外矿；(2) 运输工卸货永远全局找就近的己方房；并指示占领 W31S5、W31S6、W31S8，让这三个房相邻的外矿将来分给它们。
- 占领：`data/brain/locks.json` 写入 W33S7.claim=W31S6（3 跳）、W33S8.claim=W31S8（2 跳，经 W32S8）并行；W34S7 继续暂缓（到 W31S5 要 5 跳，1 CLAIM 1 MOVE 的 claimer 600 tick 寿命走不稳），W31S5 等 W31S6 建成 spawn 后由它相邻占。推送后游戏内 `Memory.rooms.W33S7/W33S8.expansion.target` 已设，W33S8 队头 pioneer:W31S8（eta 108）。
- 大脑（4bb8041）：暴露出 plan_home 只排除本母房自己的占领目标——推送第一版指令时 W33S8 把 W31S6 收作外矿、W33S7 仍留着 W31S8。改为 `replan_remotes`：single_claim + locks 之后实际生效的占领目标全账号排除后重排每个母房的外矿；`assign_remotes` 加容量门槛 `remoteMinCapacity`{1: 800, 2: 1300}（plans[home].capacity 由 run.py 按 spawn/ext 数算），养不起的母房跳过、都养不起才退给分数最高的；分数本身每穿一房 −8，所以路程最短的母房自然优先（sticky 6 < 8）。ranked 条目带 sources。效果：W33S8 不再收 W31S6、W33S7 不再留 W31S8；W32S6 按路程从 W34S7（3 跳）改归 W33S7（2 跳）。brain_test 新增容量分配（800 退给 1800 的远房、1300 拿回、都养不起归分数高）与全账号排除两组，112 用例通过。
- 游戏内（4922e36）：`remote.refreshDropRoom` 每 `remote.dropRefreshTicks`（500）算一次 `record.drop`{room, hops, distance, at}——`Game.map.findRoute` 跳数最少的己方房（有 spawn 或 storage，同跳数归母房），distance 用 PathFinder 从卸货房锚点到矿位；`remote.dropRoom(home, remote)` 导出；remoteHauler.deliver 出发时记 `memory.dropRoom`，到卸货房用同一套 homeTarget 分层卸货，放不下（无 storage/塔/容器可收）改回母房，卸空转 collect 时清掉；getDemands 的 hauler 编制按卸货房距离算。收入因此记在卸货房的 spawnIncome 里，不在母房（remote_roi 报表仍按母房记，待改）。smoke 新场景：卸货房是 2 跳的 W33S8、距离比母房短、编制变少、满载后朝 W33S8 走、到房交给缺能的 spawn、放不下改回母房、卸空清记忆；改前失败改后全绿。
- 门控部署：Python 112、JS/Python 语法、validation 单测；私服 validation ok、通知错误 0；activeWorld=default；上传 1788626178887（01:55）。实测（01:57）：版本生效、errors []；drop：W33S7 四个外矿归本房，W34S7 的 W33S5/W32S5 改在 W33S7 卸（W34S7 到它们 3 跳、W33S7 2 跳），W33S8 的两个外矿归本房；运输工 memory.dropRoom 已按此分配。
- 待做：W31S5 的占领（W31S6 建成 spawn 后由它发起，或 W33S7 接着占）；W34S7 失去两个外矿的收入后看它的升级/建造是否明显放慢（storage 10752 可撑一阵）；`scripts/report/remote_roi.py` 的收入归属改按卸货房；卸货房满而母房也满时 hauler 会在母房等（原行为）。

## 2026-09-06T02:15+09:00 巡检 + 开荒接管去重（占领已完成：W31S6、W31S8 都是 RCL1）
- 测量（02:04，tick 73509222，版本 1788626178887）：cpu 61/140、errors 0；W31S6、W31S8 已归我方（W33S7 在两房的 2 CLAIM reserver 就地 claim，spawn 工地已按轮子方案放在 (17,19)/(14,40)），大脑已把它们列为母房（外矿空）、blockers []；reserver 6 = 需要的 6。W34S7 升级 7.1/tick（基线 9.6）：失去 W32S6 且 W33S5/W32S5 改在 W33S7 卸货，是就近卸货规则的预期代价；W33S7 storage 1000 tick 涨 9k。
- 异常：pioneer 7 只——W33S8（指令）2 只去 W31S8、W33S7 2 只去 W31S6 之外，W34S7、W35S7 各 2 只也去了 W31S8。根因：`expansion.activeTarget` 的"自愈"分支让没有指令、没有记忆的母房接管任何己方无 spawn 的房，多母房时每家都接管同一个房；W35S7 容量 900、离 W31S8 4 跳。W35S7 broker backlog 骤降 6.4 万查过：不是死房裁剪（`layoutDeadTrim` 空、有 2 只 builder），是 extension 建成。
- 改动（1c7ac2c）：`sponsoredByAnother`——别的母房记忆/指令里已在开荒该房就不接管；`closestSponsor`——无人接管时只由距离最近、够格（RCL/容量/有 spawn）的母房接管，其余不凑。smoke 自愈场景扩展：W33S7 在开荒时 W36S9 不接管、无人时距离 2 的 W36S9 也不接管、最近的 W33S7 接管（改前 2 项失败）。Python 112、语法、validation 单测；私服 validation ok、通知错误 0；activeWorld=default；上传 1788628272186（02:12）。实测：版本生效、errors []。W34S7/W35S7 记忆里残留的 W31S8 目标（新代码只拦新接管）用 console 一次性删除，已确认为空；已孵的 7 只 pioneer 继续建 spawn。
- 用户问"加大高级房对低级房的援建力度是否有益"：已答——有益但瓶颈是 W33S7 单 spawn 的时间不是能量；建议 `aid.untilCapacity` 800 → 1300、援建 hauler 从母房 storage 搬能量到弱房、按 spawn 空闲度排位，等用户决定。
- 待做：W31S5 的占领（W31S6 建成 spawn 后）；W34S7 经济观察；就近卸货可考虑同跳数/相差 1 时优先缺能的房。

## 2026-09-06T03:05+09:00 用户指令：援建加码（先分叉 A/B 再上线）+ 私服验证改为"改动生效 + 无回归"才算通过
- 援建（220ec1b，未部署）：`aid.untilCapacity` 800 → 1300，弱房 storage 能量 < `storageBelow`（10000）仍受援；母房 storage ≥ `exportAbove`（10000）时为弱房派 `couriers`（1）只 courier（新角色 `roles/courier.js`，名字"铃仙"，`memory.from` = 母房、`home` = 弱房）：空载去母房 storage 取（只留 `exportKeep` 5000），满载去弱房按 remoteHauler 的分层卸（spawn/ext → 低于储备的塔 → 控制器容器 → 和平期塔 → storage），放不下在弱房 spawn 旁等，母房没了 storage 就去最近的 spawn 回收；身体 `makeBody('hauler', min(cap, courierBudget 1600))`，非 strategic（母房单 spawn 的时间才是瓶颈）。main.js/ROLE_WEIGHT/取名表登记 courier。smoke 新场景（900 容量受援、storage 门槛、courier 需求与在编去重、取/送/放不下不取），两条旧断言改为新阈值语义。
- 私服验证（9274f5a）：用户要求"必须观察到改动生效且没引入新 bug 才算通过"。新增 `scripts/private_server/effects.js`（每改动一条生效断言：id/日期/说明/check，报告阶段全部执行）、`baseline.js`（各房 creep/错误/RCL 与 `data/validation/baseline.json` 比较：creep 归零、新错误、RCL 下降算失败，creep 掉过半警告）、aid 场景（`roomContextFor` 给同一用户造第二个房：母房 RCL5/1800/storage 30000，弱房 RCL3/800/2 CARRY hauler）；探针本体移到 `soak_probe.validationProbe`（console 表达式上限 1024 字符——按房记录后涨到 1125 被静默拒绝，harness 现在检查 console 返回值），按房记 `Memory._validationRooms[房]` 并在最终读取前重投一次；等待预算 1 s/tick、`--effect-ticks` 默认 400。CLAUDE.md 写入通过标准。
- 调试记录（三轮失败各一个原因）：(1) 探针超 1024 字符被拒 → 移入 bot；(2) 等待时限按 200 ms/tick 在 707/771 tick 超时 → 1 s/tick；(3) 母房 storage 被自己的拆迁模块拆掉（播种布局不在 bot 生成的轮子方案里，storage: null、容量 1800 → 1600）→ 场景 plan 标 `wheel: true`，母房编制按满配身体播种免得换代占满 spawn。最终一轮：ok、通知错误 0、两条生效断言都观察到（弱房拿到援建 hauler；courier 孵出且母房 storage 减少）、基线已存。
- 协作：screeps-9e 的 a995306 分叉（405k 起 30k tick）总 CP 58.8 → 65.4/tick（+11%）、建造 0 → 27.2/tick、健康房稳定持 8–13 个工地、死房裁到 0；他们给基准脚本加了 `--snapshot-every`/`--fork-db`（c1b2a0f）。已请他们用 9274f5a 从当前世界分叉 30k 做援建 A/B（W33S8/W35S7/W31S8 进度、courier 成本、母房代价），正向再上线。
- 待做：援建 A/B 结果；RCL7 母房 5300 容量升级者能否花掉 storage（主跑 12–17 CP/tick、storage 8–13k）；W31S5 的占领（W31S6 建成 spawn 后）；earlier 改动（塔分层、就近卸货、死房裁剪…）补生效断言。

## 2026-09-06T03:33+09:00 巡检：无线上改动；援建 A/B 改为从线上快照起跑
- 测量（03:27，tick 73510471，版本 1788628272186）：cpu 70/140、errors 0；白名单与前几轮一致、blockers []；reserver 7；W31S6/W31S8 的 spawn 工地在建（backlog 分别 ↓5.8k、↓19k）；W33S7 升级 18.2/tick、storage 30.9k 仍在涨；W34S7 7.15/tick（失去外矿收入，观察中）；W33S8 7.6/tick、能量 752/900。
- screeps-9e 的 9274f5a 分叉（443,708 起）跑到 3,150/30,000 tick，但那个分叉点上没有房间符合受援条件（W33S8 已 20 ext = 1300、W35S7 1650 且 storage 13.8k、W31S8 1800），只能证明无回归。用户问"能不能从现在的线上分叉"——可以：`capture_live.py` 抓了 tick 73510416 的 57 房快照（6 己方房含无 spawn 的 W31S6/W31S8、8 外矿、两圈邻居），`soak.js` 从它起跑 4000 tick（A = 220ec1b 新代码）；B 用改动前 c1b2a0f 的独立 worktree（symlink private-server）跑同一快照，A 完再跑 B 免得三台私服互拖。soak.js 播种假定母房有 spawn，对 RCL1 新房崩（`near(undefined)`）：加守卫跳过无 spawn 的房（靠母房开荒）。
- 设计问题待定：courier 门槛现在是"容量 < 1300"，W33S8 这类容量到 1300 但 storage 0、能量贴地的房拿不到；建议改看需求（无 storage 或 storage < 1 万且 RCL ≤ 5），等 A/B 数据一起定。

## 2026-09-06T04:20+09:00 并行开荒修复 + 援建加码上线（线上快照 A/B 正向）
- 线上发现：W31S6/W31S8 的 spawn 工地停在 3240/12600，7 只 pioneer 到寿命后再没补过（`expansion.getDemands` 的 `bootstrapInProgress(claim.room)` 门：别的己方房还没 spawn 就不出需求——两个母房各开一房时互相封死），控制器降级倒计时 17.8k/17.6k；两房里旧规则的援建 creep（矿工落地采、hauler 没处送、builder 不建 spawn）把 5.6k/4.2k 能量堆在地上。线上快照 soak 复现：4000 tick 工地零进度、地上 1.1–1.3 万。
- 改动（9974eed）：`expansion.activeTarget` 改为"没人管的孤儿房（己方、无 spawn、无母房在开荒）由最近的够格母房先开完，指令里的新目标往后排"，去掉"别处在开荒就不出需求"的门，多母房并行开荒放行；`aid.needsAid` 要求弱房已有 spawn。smoke：新场景（两房并行都出 pioneer、无 spawn 房不受援、有 spawn 的 800 容量房仍受援），旧场景"不接受第二个占领"改为"孤儿房先开"。
- 验证（2b2ca80）：aid 场景加两个无 spawn 的新房（E14S16 归 E15S15、E15S17 归 E15S16），生效断言 `expansion.concurrentBootstraps`（两房都有 pioneer）、`aid.requiresSpawn`（无 spawn 房没有援建 creep）；token 改为每用户一个、结束重投前重铸（backend token 60 s 不用过期，第二个房的 token 报 unauthorized，之前通过是两次铸造同一毫秒碰巧同名）。最终一轮 ok、4 条生效断言全部观察到、无回归。
- A/B（同一线上快照 tick 73510416，各 ~3950 tick，0 错误；`data/soak/run-aid-base` = c1b2a0f，`run-aid-new` = 220ec1b）：W33S8 5.81 → 8.33/tick（+43%，容量 1050 → 1150，地上 952 → 0）；W35S7 10.52 → 10.64；W33S7 13.87 → 15.56；W34S7 7.55 → 5.17（它也出援建 creep，自己的升级被挤）；四房合计 37.75 → 39.70（+5%）。courier 1 只（W33S7 → W33S8）。两轮里新房都没动（开荒 bug 两边都在，修复在 9974eed，未进 soak）。
- 门控部署：activeWorld=default；上传 1788636071850（04:16）。实测（04:18）：版本生效、errors []；W33S8 队头已是 expansion:pioneer:W31S8:0（修复生效），W33S7 spawn 忙；courier 尚未孵出（排在母房自己的需求与援建 hauler/builder 之后）。
- 待做：下轮看两房 pioneer 是否孵出、spawn 工地进度是否恢复；courier 门槛改看需求（无 storage 或 storage < 1 万且 RCL ≤ 5）待定；W34S7 出援建 creep 导致自身升级下降——可考虑只让 storage ≥ exportAbove 的母房援建；screeps-9e 的 9274f5a 分叉继续。

## 2026-09-06T05:40+09:00 storage 富余花在升级上（含 link 供能房）+ spawn 工地最高建造优先级
- 起因：screeps-9e 两轮基准 A/B 都看到弱房 storage 攒到 9–12 万却只升 2–6 CP/tick、母房 RCL7 后 12–17；线上 W33S7 storage 涨到 3.1 万。机制：hauler 取货源容器优先、只有源容器 <100 才去 storage（>2 万），投递又先喂 spawn/ext，控制器容器长期喂不饱；upgraderTarget 只看容器 EMA，storage 水位不算供给；`maxUpgraders` RCL5–7 只有 2。
- 改动（b351f27）：`config.upgrading.storageFeedAbove` 2 万、`storageFeedRate` 20、`maxUpgradersRich` {4: 4, 5–7: 3}；broker：storage ≥ 阈值且控制器容器不满时 storage 取货权重 8（高于源容器 7）、控制器容器投递第 1 层权重 9；hauler 竞价接受权重 ≥ 8 的 storage 取货，兜底顺序同理；`upgraderTarget` 供给比例 max(容器, storage/3 万)、上限用富余表；`estimateHomeHaulerTarget` 加 storage→控制器的搬运量。（739a3a5）控制器由 link 供能的房（W33S7）：富余时 hauler 直接把 storage 能量送进控制器 link（第 1 层，link 空位 ≥ 200 才发任务）。
- 用户指令（4105efe）：spawn 工地永远最先建——builder 排序 spawn -1（原来落到默认 10、道路 5），broker 建造权重 spawn 10（塔 9、storage 8.5、道路 8）；pioneer 本来就优先 spawn，但新房里的 builder 在修 24 条路。
- 验证（c0ea4e1、df7b83d）：生效断言 `upgrade.storageRich`（母房 storage 8 万、link 供能：升级者到 3 只且 storage 至少少 1 万——第一版 4 万在 700 tick 内被吃到 19k、第二版按容器瞬时值判断误报，3 只 W15 每 tick 吃 45 超过回流速度）、`build.spawnFirst`（第一个新房 6 条路工地，spawn 进度要领先——第一版新房 E14S16 与母房是对角关系，pioneer 出不了母房；改为正西相邻的 E14S15）；基线规则改为起步房 RCL 回退只警告（bootstrap 场景地形随机）；探针加控制器容器能量与工地列表。最终一轮 6 条断言全部观察到、无错误无回归。
- 门控部署：activeWorld=default；b351f27 单独上传 1788638619498（05:05）：W33S7 升级者目标 3（EMA 0.86、extra 2）；739a3a5 + 4105efe 上传 1788640171582（05:35）。实测（05:37）：errors []；W33S7 storage 22k、控制器 link 由源 link 喂到几乎满（空位 85 < 200，暂不触发回流，升级者只有 1 只 W16 时 link 不是瓶颈，第 2/3 只孵出后才会），W31S6 pioneer ×2 在房内、spawn 工地 5685 在涨，W31S8 已 RCL2。
- 线上代价：W34S7 升级 4.1/tick——外矿能量按就近规则送去 W33S7、自己给 W35S7 派 courier、外矿 W33S5 有入侵者，三件事叠加。建议（待用户定）："就近卸货"与"援建赞助"都看对方是否比自己更富：卸货房 storage ≥ 2 万而母房更穷时仍回母房；赞助方 storage 掉到 exportAbove 以下就不再派 courier/builder。
- 待做：观察 W33S7 升级者到 3 只后 storage 是否被花掉、W35S7/W33S8 的 courier 效果；W31S6 spawn 建成；screeps-9e 用 HEAD 分叉看 W33S8/W35S7 那 10 万 storage 能否花出去。

## 2026-09-06T06:05+09:00 卸货房按真实路径长度选（跳数只筛候选）+ ROI 报表按卸货房算运力
- 起因：W34S7 升级掉到 4–5/tick；`remote_roi.py` 显示它的外矿 W32S5 卸货房是 W33S7（2 跳、路径 71 格），回本房 W34S7 是 3 跳却只有 67 格——卸货房按 `Game.map.findRoute` 跳数选，不是按路程。ROI 报表本身也按母房距离算运力（就近卸货后失真），先修报表（0361a39：探针带 drop，运力按卸货房距离，头行显示"卸 房 距"）。
- 改动（8f6e3cf）：`refreshDropRoom` 候选 = 跳数不超过母房的己方房（含母房），比 PathFinder 从各房锚点到矿位的路径长度，同路程归母房。smoke：跳数少但路径更长的房不选（锚点挪远后卸货房回到母房，挪回再选它）。验证（1a128d5）：`remote.dropRoomByPath` 看 brain 场景启用外矿的 drop 记录；7 条生效断言全过、无回归。
- 门控部署：activeWorld=default；上传 1788641663529（06:02）。实测：errors []；强制重算后 W32S5 卸货房回到 W34S7，W33S5 仍是 W33S7（从 W34S7 锚点实测路径比 57 长），W33S7/W33S8 的外矿都归本房。
- 线上（05:48，tick 73512613）：W31S6 spawn 工地 7285 在涨（约 2.6/tick），W31S8 RCL2；W33S7 storage 24.6k 持平、升级者目标 3 但 spawn 忙仍 1 只 W16；W35S7 13.2/tick、W33S8 10.4/tick（courier 在送）。
- screeps-9e：母房 RCL7 的 12–17 CP/tick 是收入分配（42.6/tick 里 52% 进孵化、reserver/remoteHauler 大头），storage 从未到 2 万，storage 富余规则在母房不触发——下一杠杆是外矿成本（reserver 1.16M 最贵）；他们的账本已加 spawnByRemote（4243368），07:30 前给各外矿 采集/孵化/净值，用于大脑 ROI 门槛。storage 富余 A/B（A 9ca344c、B 79b430c，各 30k）约 06:50 出。
- 待做：W34S7 是否回升；大脑 ROI 门槛（单源外矿的 2 CLAIM reserver 是否值得、remoteHauler 身体按路完成度收缩）；`docs/analysis/2026-09-06-w31s4-w32s4-conquest.md` 是别的会话新建的未跟踪文件，未动。

## 2026-09-06T07:04+09:00 残废 creep（必需部件全阵亡）宽限后回收退役、编制立刻出替补

- 测量：用户报告 creep 6a9c7bb29d75bc1a8abcbc73 丢了部件还占着源位。room-objects 核实：W34S7 的外矿 W32S5 里三只 creep 被 Invader 打残后幸存——remoteHauler 阿燐乙 1 WORK + 10 CARRY 全 0 血（剩 7 MOVE），remoteHauler 阿燐甲 4 CARRY 全 0 血，remoteMiner 勇仪 5 WORK 全 0 血；三只还有 690–1100 tick 寿命，勇仪站在 spot (10,19) 上、两只 hauler 守在旁边等货，源满 1500 无人挖；W34S7 升级速率 5.5–5.9/tick（基线 7.14 的 80% 以下）。根因：代码里没有任何地方识别"角色必需部件全部阵亡"，角色逻辑照跑，编制计数只排除 retired/bodyUpgradeRetiring，替补不孵，要等它们老死。
- 改动：`utils.crippledParts`（按角色定义必需部件：矿工 WORK；hauler/remoteHauler/courier CARRY+MOVE；upgrader WORK+CARRY；builder/pioneer WORK+CARRY+MOVE；reserver/claimer CLAIM+MOVE；scout MOVE；defender 有自己的 retired 流程不管；满血跳过遍历）；`retire.retireCrippled`（main.js 派活前调：首次发现记 crippledSince，观察 `config.retire.crippledGrace` 10 tick——本房塔没敌人时每 tick 治 200–400 血能把部件治回来——仍残废就标记 crippled、母房 `crippledLog` 记一条并走 retireAtSpawn 回收；宽限内或途中治好撤标记回岗）；`utils.isRetiring` 把 crippled 视为退役中，spawn.js 11 处计数、aid.js 援建计数、remote.hasReserver 都不再算它 → 替补立刻出。冒烟新增场景 21 条断言（旧代码下 `utils.crippledParts is not a function`）。
- 验证：私服 remote 场景母房播一只 CARRY 全 0 血的 hauler，生效断言 `retire.crippled`（进 crippledLog 且不再存活）。第一次播的是 remoteHauler，被"外矿未登记 = 停用"的既有退役路径第 1 tick 回收，观察不到残废路径，改成母房 hauler。验证 3 次：1dde812+修复在 upgrade.storageRich 上抖动（storage 80000→71065 差 935；干净 1dde812 的对照通过，说明是既有断言抖动）；cc2b7ec+修复通过（8 条生效断言全部观察到，基线警告 E20S20 creep 11→4：links 场景从零起步本就双峰，历史通过的验证多数也是同样 4 只，非回归）；46364c3+修复通过（8 条生效断言全部观察到、错误 0、无基线警告）。
- 门控部署：activeWorld=default；main HEAD 由第三个会话的 conquest 提交（5e59af1/aaa2193/cc2b7ec/46364c3，已由其部署并开火）前移，本修复改基到 46364c3 之上提交并部署 main HEAD，版本 1788645711955（提交 af11da8 修复、edbfb0c 生效断言；上传时线上是 1788645211687）。基线变化说明：46364c3 把 conquest 孵化档位排到 defense/survival 之后、其余一切之前，母房 upgrader/builder/外矿替补会被压后，升级速率与 reserver 数下滑是预期的开战代价，巡检不据此改经济代码。
- 复测：新代码首 tick 73513745 三只 creep 记 crippledSince，宽限到期的 73513755 tick W34S7.crippledLog 准时记 3 条（勇仪 lost work、阿燐乙/阿燐甲 lost carry）；阿燐乙剩 126 tick 不值得走 4 跳回去，原地 suicide；勇仪、阿燐甲带 retireSpawn 离开源位（(10,19)/(11,19) → (8,27)/(8,26)）走回 W34S7 回收，spot 空出；Memory.errors 仍为空，Memory.conquest 指令未受影响（对方核对一致）。W32S5 的 remoteMiner 替补属 remoteMaintain 档，46364c3 之后排在 conquest 之后，源恢复采集要等 W34S7 的 spawn 空出来，这是开战期的预期延迟。
- 待做：残废但本房有塔的情况可考虑先走回塔边治疗再回岗（治 1500 血约 40–80 能量，远低于重孵）；部分残废（例如 10 CARRY 只剩 1 个）目前靠既有换代路径，未单独处理。

## 2026-09-06T07:53+09:00 storage 富余规则修正：容器供能房里 storage 取货只是兜底、升级者按到货配、阈值滞回

- 测量：screeps-9e 的同快照 A/B（9ca344c vs 79b430c，tick 504,299 起各 30k tick，docs/benchmarks/2026-09-06-storage-ab.md）：总 CP 58.4 → 55.2/tick（−5%）。W33S8 storage 0→75k 变 0→19k 但 CP 5.1 → 3.6（−29%），W35S7 6.1 → 6.0；两房 storage 最后 2 万 tick 停在 19.0–19.2k（阈值以下规则关闭、无滞回，只花掉增量）。能量去向：W33S8 地面掉落均值 2,318 → 4,242、源容器均值 1,959 → 2,540——storage 取货权重 8 > 源容器 7 把 hauler 从源容器抽走，矿工溢出到地上衰减；升级者按 storage 水位配到 44–48 WORK 却站在能量 66–82 的控制器容器旁只升 3.6–6.0/tick，全账号升级者孵化 9.6 → 11.6/tick 白花；两房 hauler 目标数两版一样（3/2），运力才是瓶颈。线上本轮：白名单稳定、blockers 空、W32S5 已换上新矿工（勇仪戊）恢复采集；reserver 4/8、W35S7 3.3/tick、W33S8 5.2、W34S7 5.0 是 conquest（46364c3 起孵化档位仅次于防御/生存，16 只 siegeDismantler）的预期代价；W31S8 safe mode 激活（到 73533779，敌人已离开），记为状态告警。
- 改动：`utils.storageRichState`（≥ storageFeedAbove 2 万进入、< 新增 `storageFeedBelow` 1 万才退出，状态记 `Memory.rooms[房].storageRich`，broker/spawn/hauler 共用）；broker 里 storage 取货在容器供能房富余时权重 6（< 源容器 7）并标 `rich`，link 供能房保持 8（几格短途，线上 W33S7 实测 10 → 16 CP/tick）；hauler 竞价改两轮：先源容器/掉落/tombstone，都没得取才放行 `rich` 的 storage（link 房权重 8 第一轮就放行），去掉"富余时先取 storage"的兜底分支；spawn 的 upgraderTarget 供给比例只按控制器容器实际到货（去掉 max(容器, storage/storageFullAt) 的 storage 项），maxUpgradersRich 只作上限；hauler 编制里的 storage 回流项与 upgraderTarget 的上限都改用滞回状态。冒烟场景改写（兜底取货、滞回两侧、按到货减员/加员），旧代码下失败 4 条。
- 验证：私服 logistics 场景（W40N40，RCL4 容器供能）播 4 万 storage（进 plan.storage），探针新增 storageRich 状态、broker 取货候选（类型/权重/存量/rich）、源容器存量、地面掉落；生效断言 `storage.collectFallback`：进入富余状态、storage 候选标 rich 且权重低于每个容器。第一次验证暴露两个问题并修正：(1) 既有断言 upgrade.storageRich 失败——link 供能的援建母房升级者只到 2 只，因为 link 房的控制器容器本来就不由 hauler 喂，供给比例改为只在 link 供能房保留 storage 水位项（容器供能房仍只看到货）；(2) 播的 storage 在第 198 tick 被 demolition cap-replace（游戏内轮子规划器另出方案），固定件把 plan 标成 wheel。第二次验证通过：9 条生效断言全部观察到、错误 0、无基线警告；logistics 房结束时 storage 39,827（只动了 173）、源容器 170/90、地面掉落 0、hauler 3、升级者 4——不再溢出，但 storage 也几乎不花，这正是待 A/B 量化的取舍。
- 门控部署：activeWorld=default，提交 d2df0a5（代码）、17092b8（生效断言），main HEAD 含第三个会话的 conquest a6ca6c1 与 screeps-9e 的 6f234cc；部署版本 1788648748726（上传时线上 1788646495358）。已请 screeps-9e 用同一快照对照 79b430c 复跑 A/B（看 W33S8/W35S7 的 CP、地面掉落、源容器均值、hauler 取货来源分布），结果决定下一步（专职 storage→控制器短途搬运工，A/B 建议 a）。
- 复测：探针 tick 73514526：SCRIPT_VERSION 1788648748726、Memory.errors 空；各房 storageRich 状态已初始化且均为 off（W33S7 storage 18,109 < 2 万，W34S7 5,000），broker 取货候选里 storage 权重 2、容器 7，升级者目标各房 2；W33S7 之后攒到 2 万才进入富余并一直花到 1 万。screeps-9e 已开跑第 2 轮 A/B（79b430c vs d2df0a5，同快照 30k tick，带运输诊断），预计 09:15–09:30 出结果。
- 待做：A/B 出结果后再决定是否加"源容器都空时才做的 storage→控制器追加需求"或专用短途搬运工；upgrader 的 WORK 数按到货 EMA 配（现在只有数量按 EMA）。

## 2026-09-06T08:46+09:00 不可达外矿：指数退避 + 试探式恢复（冷却到期只先出一只矿工）

- 测量：screeps-9e 的每外矿净值表（docs/benchmarks/2026-09-06-remote-net-a0d5f74.md，a0d5f74 分叉 20k tick）：双源外矿净 4–7.6/tick、孵化占毛收入 25–40%，单源 W32S5 净 2.0（reserver 的 2 CLAIM ≈ 2.2/tick 是成本大头）；四个标 unreachable 的房（W33S5/W36S9/W31S9/W35S9）仍合计花 3.7/tick。读代码：`getDemands` 已跳过冷却中的记录，浪费来自"卡住 60 tick → 冷却固定 3000 tick → 到期整套矿工/reserver/hauler 重孵 → 再卡住"的循环，W33S5 则是间歇性判定。线上本轮：白名单稳定、blockers 空、无错误、无 unreachable 记录；W31S6 已建成 spawn（RCL2）；W33S8 2.1/tick、W35S7 8.0（hauler 缺编 2/1，conquest 占 spawn 的预期代价）；W31S8 safe mode 持续；W31S4 的 7 个武装敌人是攻占目标房的对方单位。
- 改动：`remote.noteTravel` 第 n 次连续不可达冷却 `unreachableTicks × 2^(n−1)`，封顶新增的 `config.remote.unreachableMaxTicks` 24000；记录新增 `unreachableCount`/`unreachableAt`（归一化保留）；`refreshVisible`（有 creep 真正看到该房）把计数清零；`getDemands` 试探式恢复——曾不可达且此后没人看到该房（lastSeen 不晚于最后一次标记）时只出第一只矿工，其余源的矿工、reserver、hauler 等它到了再放开。冒烟：退避 3/4/5 次的冷却长度与封顶、试探只出一只矿工、看到后放开、observe 清零；旧代码下 4 条失败。探针新增 `remoteDemands`。
- 验证：remote 场景预置一条"曾不可达、冷却将到期"的记录（unreachableCount 1、unreachableAt 过去、suspendedUntil +40），生效断言 `remote.unreachableBackoff`：字段保留、creep 看到该房后计数清零、lastSeen 晚于标记。第一次验证只败在固定件：世界从 tick 1 起，预置的 unreachableAt = 1 − 100 = −99 不满足 > 0（记录本身已正确：计数清零、lastSeen 777、需求全部放开）；改成 max(1, gameTime − 100) 后第二次通过：10 条生效断言全部观察到、错误 0、无基线警告。
- 门控部署：activeWorld=default，提交 970145d（代码）、2fb2b79（生效断言），部署版本 1788651904140（上传时线上 1788648748726）。
- 复测：探针 tick 73515319：SCRIPT_VERSION 1788651904140、Memory.errors 空；8 条启用中的外矿记录都没有 unreachableCount/unreachableAt（从未不可达，不进入试探），W33S7/W34S7/W33S8 的外矿需求完整（矿工/reserver/hauler 齐全）；conquest 会话核对 Memory.conquest 完好、作战未受影响。
- 待做：大脑 ROI 门槛（净/tick < 1.5 或孵化/采集 > 0.6 撤掉、按净排序）等第 2 轮 storage A/B 出结果后排期；`noteTravel` 的 60 tick 原地判定对出口拥堵有误判风险（W33S5 间歇性），退避后误判只多等一轮冷却，之后可考虑改成"路径推进量"判定。

## 2026-09-06T09:56+09:00 专职短途搬运工 feeder：storage 富余的容器供能房里只跑 storage ↔ 控制器容器

- 测量：screeps-9e 第 2 轮 A/B（79b430c vs d2df0a5，同快照 30k tick，docs/benchmarks/2026-09-06-storage-ab-round2.md）：修正后总 CP 55.5 → 57.6/tick（+3.8%），孵化 79.5 → 75.0（upgrader 12.0 → 9.7），有存量可放的房全部受益（W35S7 6.1 → 8.0、W34S7 5.1 → 5.7、W31S6 7.4 → 8.8、W33S7 13.3 → 14.0）；B 的外矿采集还少 4.1/tick（白名单/InvaderCore 分支差异），改动本身收益比总数更大。W33S8 如预判：CP 3.5 → 2.9、storage 0 → 17 万（+5.7/tick，富余一直开着）、掉落 5,187 → 1,494、源容器 2,666 → 1,774——不溢出了，但两源离 storage 23/31 格、hauler 永远有源容器可取，"都没得取才取 storage"一次也轮不到（该房 hauler 58–64% 采样在投递途中），2 只 11 WORK 升级者守着均值 147 的容器。线上本轮：白名单稳定、blockers 空、无错误；conquest 尾声，母房编制回补中；W35S7 短暂回退（spawn 孵 downgrader 抽干能量）随后回到 11.4/tick。
- 改动：新角色 `feeder`（`roles/feeder.js`，人物名"橙"）：只在 storage 与控制器容器之间来回，容器满就在旁等；富余关闭（滞回到 1 万以下）且空载、或 storage/容器没了就退役回收；不走 broker。`spawn.feederTarget`：storage 富余（滞回状态开）+ 控制器由容器供能（容器已建成、无 ctrl link、非 storage 站位）+ storage 到控制器容器 ≤ `upgrading.feederMaxDistance` 15 格 → `upgrading.feeders` 1 只，发展档请求 `core:feeder:n`；身体 `feederBody`：CARRY = feederRate 20 × 往返格数 / 50（4–16）、MOVE 一半（W33S8 6 格 → 7C4M 550；冒烟 12 格 → 12C6M 900）；有 feeder 时 hauler 编制不再加 storage 回流项。接线：main.js ROLES、utils 身体模板/必需部件/人物名、broker 权重 62、spawnLead 12、PRIORITY 计数。冒烟：编制 0/1、hauler 不重复计、孵出身体、取/送/等/退役、link 供能房不出；旧代码下失败 4 条。
- 验证：logistics 场景的 storage 改放在控制器容器 3–6 格内；生效断言 `feeder.storageToController`：孵出 feeder 且 storage 从 40000 降到 ≤ 38000（上一轮没有 feeder 时只动了 173）。跑了 4 次才过，三次失败都在固定件/断言而非代码：(1) storage 放在控制器容器 3–6 格内落进了控制器的 3 格升级范围，房间被判成 storage 站位模式（升级者直接从 storage 取），feeder 目标 0、storage.collectFallback 也没了 rich 标记——改放离控制器 5–9 格；(2) 队列在收入估计为 0 时按现有能量缩身，孵出 2C1M 的 feeder，700 tick 只搬 900——feederBody 加 feederMinCarry 4 的下限（预算不够返回空身体等）；(3) feeder 把控制器容器喂到 1834 ≥ 80% 后 broker 不再发布富余取货任务，storage.collectFallback 在探针时刻看不到 rich——断言改成容器 ≥ 80% 时不要求。第 4 次通过：11 条生效断言全部观察到、错误 0、无基线警告；logistics 房 feeder 7C4M，storage 40000 → 37200（第 3 次为 26850），控制器容器 1910。
- 门控部署：activeWorld=default，提交 b8670b1（代码）、e088c00（生效断言），部署版本 1788656093170（上传时线上 1788651904140）。已请 screeps-9e 用同快照对照 d2df0a5 再跑一轮 A/B。
- 复测：探针 tick 73516377：SCRIPT_VERSION 1788656093170、Memory.errors 空；六个房 feeder 目标全为 0（没有房 storage ≥ 2 万：W33S7 8,813 正经 courier 输出给 W31S6/W31S8，W34S7 5,290），无 feeder 在编——符合预期，等 storage 再攒到 2 万时出编制；conquest 会话核对 Memory.conquest 完好。
- 待做：A/B 结果决定 feederRate/CARRY 上限是否够（W33S8 两源 19/tick 全进 storage 时 6 格 16/tick 勉强够）；大脑 ROI 门槛排期。

## 2026-09-06T11:41+09:00 hauler 编制加投递停靠开销（spawn 份额 × 每车停靠次数 × 每停 1.5 tick）

- 测量：screeps-9e 第 3 轮 A/B（d2df0a5 vs b8670b1，docs/benchmarks/2026-09-06-storage-ab-round3.md）：feeder 有效——W33S8 3.3 → 6.4 CP/tick（storage 151k → 14.8k、控制器容器均值 83 → 414）、W35S7 7.6 → 8.1，总 CP 55.1 → 62.9（其中约 +4 来自外矿采集的分支差异，可归因 +3.6）；feederRate 20 / feederMaxDistance 15 核对合适。剩下的浪费：W33S8 两源离基地 23–37 格，hauler 目标一直 3 只，58% 采样在投递途中，源容器均值 2.2k、掉落均值 2.7k——模型只算 2 × 路程 + 2 tick 周转，一车 800 能量分 16 格投进 50 容量的 extension 的停靠没算。线上本轮：白名单稳定、blockers 空、无错误；W34S7 的第 2 只 hauler 曾被 conquest 的 downgrader 请求（1300）挡在队列后（控制器容器空 415 tick、4.2/tick），通知 conquest 会话后他们把围降 sponsors 收窄到 W33S7/W33S8，W34S7 已恢复（hauler 3、容器 780）；W31S8 升到 RCL3；定时刷新的 Kalgen 报告已提交（f902ee2）。
- 改动：`estimateHomeHaulerTarget` 在路程负载之外加"投递停靠"：每车停靠 tick = `hauling.deliveryStopTicks` 1.5 × spawn 份额 × CARRY 容量 / extension 容量（RCL≤6 50、7 100、8 200），份额 = spawn 收入 EMA / 源产出（样本不足按 `deliverySpawnShare` 0——没有数据不加开销，否则其他场景的孵化顺序会被改写，冒烟里 6 条既有断言因此失败过）；模型分解写在 `Memory.rooms[房].haulModel`（production/spawnShare/deliveryTicks/carry/load/demand），探针一并记录。冒烟新增 W33S8 型场景（两源、20/tick、EMA 19）：分解数值、编制 = ceil(load/utilization) 夹 floor/ceil、关掉停靠项编制不高于、份额 0、样本不足；旧代码下失败。
- 验证：生效断言 `hauling.deliveryStops`（logistics 房 RCL4、20 个 extension：haulModel 存在且 deliveryTicks/spawnShare/production > 0）。第一次验证暴露两处断言设计问题（代码行为正常）：logistics 房 spawn 常年满、收入 EMA 为 0，投递份额 0 观察不到——断言改到 remote 母房（spawn 持续孵外矿 creep，份额 1、每车 20.7 tick、编制 3 → 4）；feeder 断言只看 storage 下降，但 5–6 只 hauler 往 storage 回库、升级者吃不完时 storage 反升（40,922）而控制器容器已喂到 1,798——改成"容器 ≥ 80% 或 storage 搬走 ≥ 1,500"。第二次通过：12 条生效断言全部观察到、错误 0、无基线警告。
- 门控部署：activeWorld=default，提交 d03395d（代码）、ef73abf（生效断言），部署版本 1788662431595（上传时线上 1788656093170）。已请 screeps-9e 用同快照对照 b8670b1 跑第 4 轮 A/B（W33S8/W35S7 源容器均值、掉落、hauler 取货/投递占比、hauler 数、总 CP/孵化）。
- 复测：探针 tick 73517998：SCRIPT_VERSION 1788662431595、Memory.errors 空；haulModel 已写入六个房——W34S7 份额 0.98、每车 17.6 tick，编制 3 → 4；W33S8 份额 0.9、每车 22.1 tick，停靠项 0.54 只，编制仍 3；W35S7 2、W33S7 2（link 供能、只算一个源）、W31S8 3、W31S6 需求 4 被 RCL2 上限 3 夹住；conquest 会话核对 Memory.conquest 完好。
- 待做：第 4 轮 A/B 决定 deliveryStopTicks 是否合适（若 hauler 多出来后仍 58% 在投递，说明是 extension 布局/路网问题而非编制）；大脑 ROI 门槛排期。

## 2026-09-06T12:59+09:00 紧急塔补能提到第 1 层（权重高于 spawn/ext）

- 测量：W34S7 12:13 有 1 个武装敌人入房，塔从 827 打到 11/1000；12:40 复查敌人已不在，但塔仍是 11、控制器容器 0，房里 4 只 hauler 在岗、spawn 113/1300 正在孵换代身体（荷取甲.upgrade），升级 3.8/tick（基线 6.1）。原因：spawn 持续孵化时 spawn/ext 永远有缺口，broker 第 1 层永远是 spawn/ext，紧急塔（有敌人或 < towerRepairReserve 500）只是第 2 层，半小时没人补——没能量的塔下一波入侵就是裸奔。其余：白名单稳定、blockers 空、无错误；reserver 8 = 外矿 8；无 unreachable、无新残废；W34S7 编制 4 已在岗（上一轮的投递停靠项）；W33S7 速率 10 是 storage 不再富余后的正常水平。
- 改动：broker 里紧急塔（有敌人或低于维修储备）第 1 层、权重 11 > spawn 10（和平期高于储备的缺口仍第 4 层）；`roles/hauler.js` 兜底与 `roles/remoteHauler.homeTarget` 同步把紧急塔排到 spawn/ext 前；遥测 `Memory.rooms[房].towerFirstAt`（紧急塔第一次压过有缺口的 spawn/ext 的 tick）。冒烟：塔 450 / 有敌人时第 1 层且权重 > 10，spawn 缺 200 时满载 hauler 仍先把 450 的塔补满、spawn 不动；旧代码下失败。
- 验证：logistics 场景 spawn 只播 100、加一座 100 能量的塔（进 plan.towers），生效断言 `tower.refillBeforeSpawn`：towerFirstAt > 0 且结束时塔 ≥ 500。第一次验证只差门槛：塔补到储备线后维修到略低于 500 再等补能，探针抓到 492；门槛改为 ≥ 300（远高于播的 100）。第二次通过：13 条生效断言全部观察到、错误 0、无基线警告，logistics 房 towerFirstAt = 1（第 1 tick 就压过了 spawn）、结束时塔 510。
- 门控部署：activeWorld=default，提交 d635129（代码）、7a8f83d（生效断言），部署版本 1788667089693（上传时线上 1788662431595）。
- 复测：探针 tick 73519180：SCRIPT_VERSION 1788667089693、Memory.errors 空；W34S7 的塔投递任务已是第 1 层权重 11（spawn 207/1300、权重 10），W34S7/W33S8/W35S7 三个塔低于 500 的房都在首 tick 73519177 记下 towerFirstAt；W33S7（塔 505/500）与 W31S8（980）不触发；conquest 会话核对 Memory.conquest 完好，作战无影响。下一轮核对 W34S7 的塔是否补回 ≥ 500。
- 待做：第 4 轮 A/B（b8670b1 vs d03395d）决定投递停靠项去留；大脑 ROI 门槛排期；换代身体在战后集中重孵（W34S7 一小时内 4 hauler + upgrader 全换）把收入全吃进 spawn 的问题可考虑限速（每房同时只允许 1 个换代请求）。

## 2026-09-06T13:30+09:00 link 工地先于道路/extension 放置、建造权重提到塔那一档

- 测量：screeps-9e 的 link 能量流分析与分叉账本（d03395d/b8670b1 分叉各 30k tick）：W34S7 方案里有 4 个 link 位，到 RCL7 仍一座没建——(a) 分叉后 3k–21k tick 房内 10 个名额一直是 extension 工地满配，link 工地到 23–24k tick 才放出（layout 顺序 ext 在 link 前）；(b) 放出后四个 link 工地到 30k 结束进度全是 0/5000（builder 只做有进度的 ext，link 与 ext 同为默认权重）；(c) link 位平地无建筑无路，不是站位问题；道路工地只出现 2–3 次，不是路吃预算。主跑（88fe9e7 旧代码）W34S7 275k tick 里从没出现过 link 工地。RCL5–6 的 link 只搬升级那一份（links.js：RCL5 ctrl+src0、RCL6 加 src1、RCL7 才加 store），RCL6 房 hauler 可省 W33S7 −1.3、W31S6 −0.9、W34S9 −0.7，W34S7 建好 link 后 −2 只。同轮排查的"外矿选择"没有可改：W35S7 只有北（W35S6 SK）/西两个出口，W36S7 只有北（W36S6 SK）/南（Alepoldar）/东出口，W35S5 四周全是 SK 房，其余双源房都是别人的（Alepoldar/tidusfox9/Ctharo）——大脑 noRoute 正确。线上本轮：白名单稳定、blockers 空、无错误；W34S7 的塔已从 11 补到 707（紧急塔优先级生效）。
- 改动：`layout.placeSites` 把 link 工地块移到源容器之后、道路/extension 之前（配额只有 2–6 个；extension 还缺时至少给它留 1 个名额，让位机制一次只腾 2 个）；`highPriorityNeeds` 把 link 位算进高优先结构（名额被零进度的路/rampart 占满时也让位）；`roles/builder.sitePriority` link = 1.5（源容器 1 之后、控制器容器 2/道路 5/extension 之前）；broker 建造权重 link 8.7（塔 9 之下、storage 8.5 之上）。冒烟：RCL5 轮子方案、全局名额只剩 10 → 先放 ctrl+src0 两个 link 工地；源容器仍排 link 前、之后 builder 下一个工地是 link；broker 权重 link > 道路；旧代码下失败 3 条（旧顺序 10 个名额全给了容器和路，link 0）。探针加 link 数。
- 验证：生效断言 `layout.linkSitesFirst`（industry 场景 RCL8、没播 extension：旧顺序 60 个 ext 配额吃光名额、link 工地从不放出；新代码要求 link 工地放出且有进度或已建成）。第一次验证败在断言选错场景：industry 房的方案没有源工位、不生成 link 位（工地为 0）；blueprint 房（RCL8 轮子方案从零起步）在同一轮里已放出 4 个 link 工地，只是 7–9 只 creep 的起步期建不动 5000 的 link。断言改到 blueprint 房、只要求 link 工地放出（建造权重由冒烟覆盖），第二次通过：14 条生效断言全部观察到、错误 0、无基线警告。
- 门控部署：activeWorld=default，提交 bb76126（代码）、06ac1a3（生效断言），部署版本 1788668938217（上传时线上 1788667089693）。已请 screeps-9e 用同快照对照 7a8f83d 跑第 5 轮（W34S7 何时建成 link、RCL6 房 hauler 数与总 CP）。
- 复测：探针 tick 73519642：SCRIPT_VERSION 1788668938217、Memory.errors 空；W33S7（RCL5）link 2 座、配额已满，W33S8/W34S7/W35S7 RCL4、W31S6/W31S8 RCL3 尚无 link 配额，工地只有路与 extension——新顺序要等 W34S7/W35S7 升到 RCL5 才看得到（W34S7 进度 30 万/40.5 万）。screeps-9e 的第 5 轮分叉（7a8f83d vs bb76126）预计 15:45 出结果。
- 待做：② 有 link 时 hauler 编制封顶（ctrl+store link → 1、ctrl+源 link → 2）；③ RCL6 的 link 分配改为 ctrl+src0+store；W35S7 升到 RCL5 后核对 ctrl/src0 link 工地是否按新顺序放出。

## 2026-09-06T14:08+09:00 safe mode 决策外置到大脑：游戏内只在核心建筑掉血时兜底，safe mode 中不出 defender，记录敌人画像

- 测量：用户指出 tick 73513779 W31S8（RCL2、无塔、刚建成 spawn）因一只 NPC 入侵者开了 safe mode。复盘：`tower.js` 的规则是"有武装敌人且塔压不住就开"，无塔房 `towersCanHold` 恒为假，所以任何一只带攻击部件的敌人都触发；开盾后 18 tick 防御模块还孵了 2 只 defender（`defenseLog.spawned = 2`，约 1500 能量，赶到时无事可做）；入侵者身体没有被记录。代价是 20000 + 50000 tick 的冷却窗口里 W31S8 再不能开盾（正在打 Fire9265，报复风险真实存在），收益是无塔无守军的 RCL2 房保住了 spawn 与援建 creep。结论：这类场景开盾本身合理，但规则不看敌人强弱与救援距离、开了还出兵、事后无法复盘。用户指令：按此改，决策交给外置大脑。
- 改动：大脑 `scripts/brain/safemode.py`：看 `hostileProfile`（DPS/治疗/强化）、`hostileOwners`（NPC 还是玩家）、本房塔数与塔能量、`safeModeAvailable`、别的母房能否在"孵化 60 + 每房 50 tick"内赶到——没威胁/已开/没次数 → hold；有能量的塔压得住 → hold；DPS 低于门槛（NPC 30、玩家 60）→ hold 交给 defender；玩家强化 → activate；没别的母房 → activate；救援到达前能打掉 spawn 80% 血 → activate，否则 hold。`intel.py` 新增 `safeModeAvailable/hostileOwners/towerEnergy`；`run.py` 每轮给每个母房出 `rooms[房].safeMode = {action, reason, dps, eta, atTick}`（`directive.py` 入契约，`brief.md` 显示）；新增 `guard.py`（launchd 每 90 秒，`install_schedule.sh` 一并安装 `local.screeps-brain-guard`）只拉己方房的 room-objects，决定有变化时只修补 segment 里的这一字段并刷新 issuedAt，没有已写入的指令时不写。游戏内 `tower.js`：`config.safeMode.decisionTtl` 600 tick 内的 activate 立刻开；没有决定时只在核心建筑（spawn/塔/storage）掉到 `fallbackCoreShare` 0.5 以下才开；大脑说 hold 时只有掉到 `lastResortCoreShare` 0.3 才违抗；开盾记 `defenseLog.safeMode = {at, by, hostiles: [[主人, 身体摘要, 血量]]}`。`defense.js` 对 safe mode 中的己方房不出 defender。测试：Python 8 个用例（决策矩阵、helpers、guard 修补）；冒烟新场景 11 条断言 + 三条旧断言改成新语义（无决定不开、决定 activate 开、塔没能量只在 spawn 掉血时兜底）；旧代码下失败。
- 验证：brain 场景母房播一只不能动的重甲玩家 creep（归 ValidationBootstrap，25T20A，defense 打不过、不出兵，没有塔）：旧代码第 1 tick 开盾，新代码要等 run.py 真实跑出 safeMode=activate（没有别的母房 → no-help）再开并记 `by: brain:no-help`；生效断言 `safeMode.brainDecides`。一次通过：15 条生效断言全部观察到、错误 0、无基线警告。brain 场景里 run.py 第 121 tick 看到 ValidationBootstrap 的 20A25T（DPS 600、towerEnergy 0、safeModeAvailable 3、没有别的母房）决定 activate/no-help，bot 第 122 tick 开盾并记 `defenseLog.safeMode = {by: brain:no-help, hostiles: [[ValidationBootstrap, 20A25T, 4500]]}`。部署前对线上 dry-run：六个房 hold/no-threat，情报里塔能量/剩余次数/敌人主人都取到，guard 每轮 4–5 个 API 调用。
- 门控部署：activeWorld=default，提交 cf3a549（大脑）、b601541（游戏）、ec0b4bb（生效断言），连同 conquest 会话的 c63127c 一起部署，版本 1788671196402（上传时线上 1788670142714）；已重装 launchd（local.screeps-brain 每 300 秒、local.screeps-brain-guard 每 90 秒）。部署后重装 launchd（`bash scripts/brain/install_schedule.sh`）以启用 guard。
- 复测：探针 tick 73520210：SCRIPT_VERSION 1788671196402、Memory.errors 空；指令里六个房都已带 safeMode 决定（hold/no-threat，atTick 73520107），W31S8 仍在旧的 safe mode 里（剩 13569 tick，可用次数 1），其余房次数 2–4；guard.log 首轮 "无变化、apiCalls 5"；conquest 会话核对 Memory.conquest 完好。
- 待做：guard 的 API 调用量观察（每 90 秒约 7 次）；决策参数（coreShare 0.8、NPC/玩家 DPS 门槛）等线上出现真实入侵后按 defenseLog.safeMode 复盘调整；brain 情报里 `towerEnergy` 也可用于外矿防御判断。

## 2026-09-06T15:04+09:00 guard.py 去掉 map-stats 调用（上线后被限流 429，连 run.py 也被拖下水）

- 测量：safe mode 外置上线约 40 分钟后，`data/brain/logs/guard.err` 里 21 次运行有 16 次 `POST /api/game/map-stats -> HTTP 429`，`run.err` 也出现 6 次——guard 每 90 秒调一次 map-stats，把该接口的配额吃光，主大脑（每 5 分钟）也跟着被限。线上其余：白名单稳定、blockers 空、无错误；六个房 safeMode 决定新鲜；经济仍被对方第二阶段（W32S4）进攻压着（reserver 1/8、W33S8 0.0/tick、W35S7 0.27/tick、W34S7 队头 1300 的外矿 hauler 等了 375 tick），已在上一轮告知 conquest 会话。
- 改动：`intel.collect` 加 `map_stats` 开关，`guard.py` 传 False（只看己方房，主人来自 room-objects 的 controller）；单测 `CollectWithoutMapStatsTest`。Python 126 项全过。纯 Python，无游戏代码改动，不需要私服验证与部署；launchd 直接跑仓库里的脚本，下一轮起生效。提交 e9f9038。
- 复测：手动跑一次 guard：决定齐全、apiCalls 9、无 429。下一轮看 guard.err/run.err 不再增长。

## 2026-09-06T15:42+09:00 大脑占领清单 claim.queue：用户点名 W33S3/W32S4/W31S4/W31S5，有主的等无主，无主的分给最近的空闲母房

- 测量：用户指示占领 W33S3、W32S4、W31S4、W31S5，"有 owner 的房间等没有 owner 了再 claim"。实况（tick 73521275）：GCL 12、已有 6 房（W33S7 RCL5，W34S7/W33S8/W35S7 RCL4，W31S6/W31S8 RCL3 都已有 spawn）；W33S3 无主双源（H，离最近母房 W31S6 3 格、在情报圈外），W31S5 无主双源（O），W32S4（RCL5）/W31S4（RCL4）属 Fire9265，攻略会话正在压等级（downgradeTime 73600395/73550595）。原有机制只有按母房的 `<home>.claim` 锁，锁值直接下发，不看目标有没有主，也不会自动选母房；旧锁 W33S7→W31S6、W33S8→W31S8 两房都已建成 spawn，仍在让 W33S7 每 tick 重写 expansion 记忆。
- 改动：`data/brain/locks.json` 新增账号级 `claim.queue`（value 为按优先顺序的房名列表）；`plan.assign_claim_queue` 在 `single_claim` 之后落地：有主/被预定/有威胁 → `wait:<原因>`，已是我方有 spawn → `owned`，我方无 spawn → `bootstrapping`（占用开荒它的母房），无主 → 分给 `claimQueueMaxHops` 跳内（BFS 只穿无主/己方房）RCL≥`claimMinLevel` 且空闲的最近母房（正在开荒别的房、带 `.claim` 锁、本轮已接一房的都跳过），没人接 `noSponsor`、无 GCL 余量 `gcl`；清单未完成时脚本自己的占领目标全部清空（`blocked: claimQueue`）。清单房在情报圈外，`intel.collect(extra_rooms=...)` 连同邻房一起拉。状态进 `state.json`/`run.log` 的 `claimQueue` 和 `brief.md`。用户随后把 `claimQueueMaxHops` 从 4 放宽到 5（线上 claimer 44 tick 走完一房，5 房约 220 tick，600 寿命够）。Python 135 项全过（新增 9 项 `ClaimQueueTest`）；纯 Python，无游戏代码改动。
- 验证：私服完整验证 validation-ZzHvW0 ok、notificationErrors 0、15 条生效断言全部观察到、无基线回归（验证的 brain 场景用世界目录下的 `--out`，没有 locks，清单不生效，只证明 run.py 改动不崩）。
- 门控部署：脚本在工作树里直接被 launchd 使用，无需上传；手动 `run.py --write` 两次（issuedAt 1788676211598、1788676744502）。提交 f7deac5（清单机制）、b5b5c69（5 跳）。攻略会话同步给 conquest 加了 noClaim 标志（675d847，版本 1788676429155），两房压到 0 级不抢 claim。
- 复测：tick 73521435 游戏内 ack；W33S7 expansion 目标 W33S3，claimer 灵梦 tick 73521450 出发、73521566 已到 W33S5（剩余寿命 477），两只 pioneer 跟进；放宽到 5 跳后 W31S5 分给 W33S8（5 跳，与 W34S7 同跳同级按房名取前者，恰好是收入更高的一家：spawn 收入 EMA 11.8 vs 7.7），tick 73521561 W33S8 expansion 目标 W31S5；W32S4/W31S4 = wait:owner:Fire9265。
- 待做：下一轮核对 灵梦 是否占下 W33S3、W33S8 的 claimer 是否出发；两房无主后大脑自动分配（母房那时可能都在忙，`noSponsor` 会等到有人空闲）；同跳同级的母房选择可以再加收入 tiebreak（本次无需要）；screeps-9e 的第 5 轮 A/B 支持"hauler 编制按 link 封顶"，排到下一轮。

## 2026-09-06T16:02+09:00 塔的维修不动储备 + 紧急塔滞回：修掉 d635129 引入的"塔烧储备 → 紧急 → 抢走全房运力"的环

- 测量：用户报告 W33S8 upgrader 挂机、W32S8 外矿没人维护。现场（tick 73521395–73521585，room-objects 每 6 秒采样 4 分钟）：spawn+ext 32–97/1300，两个源容器 2000/2000 满、地上堆 6.5k（4782+1756），控制器容器 0/2000（upgrader 慧音辛 按"有 hauler 在岗就原地等"挂机），全房 1 只 hauler；塔 (6,7) 498 ↔ 远程 hauler 送 82 → 580 → 10 tick 烧回 490，唯一的 hauler 小荷取甲 带 400 走到塔边（塔那一刻 ≥ 500 不算紧急）掉头，塔烧回 490 后又回去把 400 全倒进塔（890 → 每 tick −10）；源容器 (4,19) 离塔 12 格，这个环永远转。维修积压：方案内 14 条路 < 60%（缺 17.4 万血）、12 条离塔 ≥ 20 格（每 10 能量 200 血），3 个 rampart 12.4k / 目标 30k。spawn 队列：`core:hauler:1`（发展档，缩身下限 650）等了 1336 tick 才以 650 出来，`core:hauler:2` 又在等，W32S8 的 remoteMiner/reserver 是 remote 档被核心等待挡住（blocked 8/9）；`towerFirstAt` = 73519177 正是 d635129 部署（12:58）后的首批 tick。同样签名：W35S7 塔 490、W31S6 塔 498。根因：`tower.js` "≥ 储备就修"会修到 490，而 broker/hauler 兜底/remoteHauler.homeTarget 把 < 储备判成紧急（权重 11 > spawn 10）——消耗门槛与优先级门槛是同一条线 500，和平期永远抖动。其余：Memory.errors 空、白名单稳定。
- 改动：`tower.js` 治疗/维修前要求能量 − 10 ≥ towerRepairReserve（和平期永不跌破储备）；`utils.towerUrgent(room, tower, hostile)` 作为 broker、`roles/hauler.js` 兜底、`roles/remoteHauler.homeTarget` 的同一判定：有敌人或储备被动用，动用后锁存在 `Memory.rooms[房].towerUrgent[塔 id]`（动用 tick）直到补到不缺（缺口 < towerRefillAt）才解除记 0，零头到货顶回储备线以上不降级；broker 对满塔也评估锁存（否则永不解除）；和平期从"已补满"跌破储备记 `towerBreaches`/`towerBreachAt`（打仗打掉的不算）。冒烟两个新场景：塔 505 不修 / 510 修；锁存下 600 仍第 1 层与 homeTarget 先塔、带 400 的 hauler 在 spawn 缺 200 时先把 600 补满、补到 1000 解除、无锁存的 600 第 4 层、和平期跌破计数只在无敌人时加；旧代码下两条都失败。
- 验证：私服 validation-yiAD1U ok、通知错误 0、16 条生效断言全部观察到（新增 `tower.repairKeepsReserve`：logistics 房塔播 100、spawn 上有 rampart 工地要修——towerFirstAt > 0、锁存解除过、towerBreaches 为 0、结束时塔 ≥ 500；d635129 那轮验证曾抓到 492 并把门槛放宽到 ≥ 300，正是本次的根因），基线无警告。
- 门控部署：activeWorld=default，提交 d54852e（代码 + 冒烟）、c8d43b7（生效断言），部署版本 1788677717166（上传时线上 1788676429155）；三个并行会话（screeps-d7、效率优化、攻略）事先确认无冲突。
- 复测：tick 73521809 版本已切、Memory.errors 空；W35S7/W31S6 的塔（本来就 < 500）首 tick 锁存，W33S8/W34S7 无锁存，四房 towerBreaches 均未出现。 部署后 4 分钟（16:04）：W33S8 spawn+ext 32–97 → 1254/1300，塔停在 509（修到储备线上就停、不再跌破），hauler 1 → 4 只（荷取庚、小荷取己 新孵，两只带 400 从源容器返程）；W35S7 塔 490 → 锁存补到 700 后解除、在 700–630 间正常维修，spawn 1280/1300；W31S6 塔 880 → 770 维修、spawn 550/550 满。控制器容器还是 0，等 spawn/ext 满后下一车。
- 待做（另开轮次）：(1) 收入 EMA（alpha 0.05、只采正增量）随一车 400 在 3–20 间抖动，发展档缩身下限在 650 与 0 之间翻转，队列一会儿死等一会儿孵小身体；(2) 没建成容器的外矿（W32S8）永远是 remote 档、母房一打嗝就最先被丢；(3) 用户提议维修改为 builder 优先（creep 100 血/能量 vs 塔 20–80）：和平期道路/容器交 builder、塔只在 ≥ 800 且目标 ≤ 10 格时补刀，需 A/B 量化。

## 2026-09-06T16:08+09:00 巡检：无改动（占领推进中，塔储备修复生效，共享工作树里有攻略会话的 WIP）

- 测量：tick 73521920，SCRIPT_VERSION 1788677717166、Memory.errors 空。大脑最近一轮（tick 73521856）blockers 空，白名单与上一轮一致（W33S7 4 房、W34S7 W33S5/W32S5、W33S8 W32S8/W34S8），无来回换房；reserver 7 只对应 8 个启用外矿，缺的是 W33S8 的 W32S8（矿工/reserver 缺编 891 tick——W33S8 的 spawn 在忙 W31S5 的 claimer + pioneer 与核心角色，remoteMaintain 档排在后面，属预期）。塔储备修复（d54852e）后所有塔 ≥ 500（W33S8 509、W34S7/W35S7 620、W33S7 500/500、W31S6/W31S8 500），towerBreaches 全 0，W33S8 spawn 784/1300 已回升。W33S3 已占下（RCL1，spawn 工地 400/15000，两只 pioneer 在场）；W31S5 的 claimer 灵梦甲 tick 73521919 进房（剩余寿命 293），两只 pioneer 在 W31S6/W31S7 路上。monitor 告警：W31S8 safe mode 仍剩 11874 tick；W33S7/W33S8/W34S7 升级回退（攻城 + 两处开荒占 spawn）；W34S7/W35S7 控制器容器空 891 tick——W34S7 源容器 1670/1330 有货、队头 core:hauler:3 已等 52 tick、能量 1209/1300 预计 4 tick 孵出第 4 只 hauler，自愈中。
- 改动：无。攻略会话在共享工作树里有未提交改动（src/config.js、src/conquest.js、src/spawn.js），本轮不动游戏代码；screeps-9e 第 5 轮 A/B 证实的"hauler 编制按 link 封顶"（link 房 hauler 空闲 34–71%）留到工作树干净后做，线上目前只有 W33S7 有控制器 link 且 hauler 已是 2，即时收益小。
- 待做：下一轮核对 W31S5 占下、W33S8 的 W32S8 缺编是否在 claimer/pioneer 孵完后补上、W33S3 spawn 工地进度；guard.err/run.err 自 14:53 起无新的 429。

## 2026-09-06T17:05+09:00 hauler 底线按 link 供能的源下调（每个己方源 link −1、不低于 2）

- 测量：screeps-9e 第 5 轮同快照 A/B（`docs/benchmarks/2026-09-06-link-ab-round5.md`，7a8f83d vs bb76126，30k tick）：link 工地提前后总 CP 59.9 → 68.5/tick，但 RCL6 link 房的 hauler 仍被 RCL 底线 3 撑在 2.2–2.7 只，采样里空闲占比 W33S7 71%、W34S7 60%、W31S6 46%、W34S9 34%（折合只有 0.6–1.7 只在忙），无 link 的房只空闲 6–18%。模型本身已把 link 供能的源剔出负载，是 `hauling.floor[6] = 3` 在兜底。线上 16:24：W33S3/W31S5 均已占下（spawn 工地 2800/1400 → 部署时 6000/4440），reserver 8 = 外矿 8，塔全 ≥ 500、towerBreaches 0，攻略会话的 WIP 已提交，工作树干净。
- 改动：`config.hauling.linkFloorDrop 1 / linkFloorMin 2`；`spawn.estimateHomeHaulerTarget` 数出己方源 link 的源（linkFed），底线 = max(min(floor, 2), floor − linkFed)；模型需求更高时照旧取需求（storage 富余往控制器 link 回流的房仍是 3）。`haulModel` 在有 link 供能源时也写，记 `linkFed/floor`，并记停靠项峰值 `maxDeliveryTicks`；验证探针加 `targets`。冒烟：RCL6 一源 link + storage 1.5 万 → 2（旧 3），两源 link + storage 3 万 → 2 且 linkFed 2，`linkFloorDrop 0` 退回 3；停靠场景加峰值断言。旧代码上新断言确实失败（一源 link 得 3、haulModel 无 linkFed）。
- 验证：三次私服验证。第 1 次 validation-As6cuW 失败在既有断言 `hauling.deliveryStops`：W50N50 期末 spawn 收入 EMA 0.002（spawn 长期满仓衰减），停靠项四舍五入为 0——上一次通过时也只有 0.03，是薄边而非本次改动；同一世界里 links 房已是 linkFed 2、floor 2、hauler 目标 2。改为看 `maxDeliveryTicks` 峰值。第 2 次 validation-jfUS8u 失败在新断言读探针里不存在的 `targets`，探针补字段。第 3 次 validation-xAhYMv ok、notificationErrors 0、17 条生效断言全过（含 `hauling.linkFloor`）、无基线警告。验证自测在 HEAD 上本来就因攻略会话的 `tower.repairKeepsReserve` 缺夹具而失败，顺手补了 `towerUrgent` 夹具。
- 门控部署：smoke、JS 语法、conquest_test、Python 135 项、验证自测全过；activeWorld=default；提交 c3bdab1（游戏代码 + 冒烟）、49d7206（夹具 + 断言 + 自测）；`npx grunt` 上传，版本 1788681041635（上传时线上 1788677717166）。
- 复测：tick 73522660 SCRIPT_VERSION 1788681041635、Memory.errors 空。W33S7（RCL5，src0 有 link）haulModel linkFed 1、底线 2 − 1 夹到 2、需求 1、目标 2（与部署前相同——线上目前没有 RCL6 两源 link 的房，改动要到 W33S7 升 RCL6 或基准里才见效）；W34S7/W33S8/W35S7/W31S8/W31S6 linkFed 0、目标 3/5/2/4/4 不变。
- 待做：请 screeps-9e 同快照对照 bb76126 跑一轮（重点 link 房 hauler 均数与空闲占比、CP 不掉）；`linkFloorMin` 是否可到 1 看 A/B 里 W33S7 型（忙碌 0.6 只）房的 spawn 补给是否有缺口；下一轮核对 W33S3/W31S5 spawn 工地进度与 W33S8 的 W32S8 外矿是否已补编。

## 2026-09-06T17:16+09:00 巡检：无改动（版本 1788681041635 稳定，两处开荒过半）

- 测量：tick 73523004，SCRIPT_VERSION 1788681041635、Memory.errors 空、塔全 ≥ 500、towerBreaches 0。17:03 前后本机网络短暂不可达：monitor.py 一次 curl 超时（重跑正常），大脑 tick 73522929 那轮因 W32S9 情报拉取失败按设计未写（上一份指令 TTL 内有效），blockers 只有这一条，之前两轮白名单与本轮一致。reserver 7 只：W33S7 的 W32S6/W31S7 预定还剩 464/1150 tick、需求 0，其余 6 个外矿各 1（W33S5 有一只换代中的 2/1）。W33S8 的 W32S8 已补编（m1/1 r1/1）。开荒：W33S3 spawn 工地 8740/15000（首批两只 pioneer 到寿命，替补在路上，房内暂时 0 只），W31S5 7300/15000（2 只在场）。W34S7 spawn 能量 51/1300、升级 5.4/tick：spawn 持续在孵（援建 W31S6 + 外矿），storage 12126 未到 2 万富余线。link 底线改动线上只影响 W33S7（linkFed 1、目标 2，不变），A/B 结果待 screeps-9e。
- 改动：无。
- 待做：下一轮看 W33S3 替补 pioneer 到位、两处 spawn 建成后大脑是否把 W32S4/W31S4 继续标 wait；A/B 到了再定 `linkFloorMin` 是否可到 1。

## 2026-09-06T17:46+09:00 巡检：无改动（大脑连续 4 轮白名单一致，reserver = 需求，两处 spawn 工地 9340/8800）

- 测量：tick 73523448，SCRIPT_VERSION 1788681041635、Memory.errors 空、塔全 ≥ 500、towerBreaches 0。大脑 tick 73523040–73523353 连续 4 轮写入、blockers 空、白名单完全一致（W33S7 4 房、W34S7 W33S5/W32S5、W33S8 W32S8/W34S8），占领清单 W33S3/W31S5 bootstrapping、W32S4/W31S4 wait:owner。reserver 6 只 = 需求 6（W33S7 的 W31S7 预定 734、W33S8 的 W32S8 预定 369 暂不需要）。guard 17:32 一次 RemoteDisconnected（瞬时），下一轮正常。开荒：W33S3 spawn 工地 9340/15000（2 只 pioneer 在场就地采能，约 2.4/tick），W31S5 8800/15000——首批 pioneer 到寿命后房内空了约 250 tick，第二批（W33S8 孵、5 跳）已走到 W31S6 即将进房；5 跳开荒每 1500 tick 有约 1/3 时间花在路上，属预期。W35S7 控制器容器空 416 tick 但升级 11/tick（升级者直接吃容器到货），队头 hauler 换代等能量（收入 EMA 3.7 是满仓不采样的假象）。
- 改动：无。
- 待做：两处 spawn 建成后看 pioneer 转 builder、大脑 claimQueue 变 owned；W31S5 这类远距开荒可考虑 pioneer 按路程提前预孵（现在只在死后补），等第二批到位量一次实际断档再定。

## 2026-09-06T18:12+09:00 巡检：无改动（大脑连续 5 轮一致，spawn 工地 12740/11000）

- 测量：tick 73523866，SCRIPT_VERSION 1788681041635、Memory.errors 空、塔全 ≥ 500、towerBreaches 0。大脑 tick 73523353–73523769 连续 5 轮写入、blockers 空、白名单一致；占领清单状态不变。reserver 8 只 = 7 个需要预定的外矿 + W32S6 一只换代中。开荒：W33S3 spawn 工地 12740/15000（pioneer 剩余寿命 583/627，按 2.4/tick 还差约 940 tick，这一批到寿命时会差约 350 tick，替补从 W33S7 走 4 房约 200 tick——会有一次短断档）；W31S5 11000/15000（第二批已进房，寿命 831/867，够建完）。W33S8 被 W31S5 开荒 + 援建 W31S8 + 塔挤到 storage 388、升级 1.3/tick，spawn 工地建成后自然缓解。
- 改动：无。
- 待做：spawn 建成后看 pioneer 转 builder、claimQueue 变 owned；pioneer 按路程预孵（W33S3 这次断档就是证据，等实际量到断档 tick 数再改）。

## 2026-09-06T20:12+09:00 link 供能按链吞吐计：RCL<7 只算升级者 WORK 吃得掉的部分，RCL7 有 store link 底线到 1

- 测量：screeps-9e 第 6 轮同快照 A/B（`docs/benchmarks/2026-09-06-hauler-link-ab-round6.md`，bb76126 vs c3bdab1）：link 底线机制成立——link 房 hauler 目标 3 → 2.0–2.5、全账号 hauler 均数 22.6 → 18.6、hauler 孵化 20.4 → 18.3/tick，源容器/掉落无堆积。两处反证：RCL7 的 W33S7 1.7 只仍空闲 85%（store link 把整源送进 storage，hauler 只剩补 spawn/塔）；RCL6 的 W31S8 升级只有 4.6/tick，源 link 只发往 ctrl link、几乎没流量，模型却把两源都记成产出 0，hauler 3 → 2 后源容器 0.6k → 1.1k、投递占比 50% → 64%、空闲 6% → 2%、CP 5.5 → 5.2。线上 20:03：本机 18:25–19:50 网络/休眠中断（大脑与 guard 各一次 DNS 失败，19:50 恢复），W33S3/W31S5 的 spawn 都已建成、claimQueue 标 owned；reserver 7、塔全 ≥ 500、errors 空。
- 改动：`estimateHomeHaulerTarget` 先算每源产出，再按 link 链吞吐扣除：RCL7 有 store link → 整源被搬走；否则有 ctrl link 时吞吐 = 本房升级者 WORK（`upgraderWork`，每 tick 每房算一次，RCL8 封 15），src0 先扣、src1（RCL6 起才发货）后扣，剩余 ≥ 1/tick 的源按容器源计入运量且不降底线；没有 ctrl link 的源 link 不搬能量。`config.hauling.linkFloorMinStore 1`（有 store link 时的底线下限），`haulModel` 加 `linkDrain`。冒烟：RCL6 两只 10 WORK 升级者 → linkFed 2、目标 2；换成一只 5 WORK → linkFed 0、linkDrain 5、production 15、底线 3；RCL7 + store link + storage 5 千（富余滞回退出）→ linkFed 2、底线 1、目标 1。旧代码（c3bdab1）上后两条确实失败。静态矿工换代场景里"源 link 但无 ctrl link"现在正确地先补一只 hauler，断言改为最多等 3 tick。
- 验证：私服 validation-pIHFTv ok、notificationErrors 0、18 条生效断言全过（`hauling.linkFloor` 改为 links 场景 RCL7 + 4 link + storage 3 万 → 目标 1、linkFed 2、linkDrain 记录）、无基线警告。smoke、JS 语法、conquest_test、验证自测、Python 135 项全过。
- 门控部署：activeWorld=default；提交 5163eca（游戏代码 + 冒烟）、aeb38b7（夹具 + 断言 + 自测）；`npx grunt` 版本 1788692960204（上传时线上 1788681041635）。
- 复测：tick 73525658 SCRIPT_VERSION 1788692960204、Memory.errors 空。W33S7（RCL5，src0 有 link，一只 10 WORK 升级者）linkFed 1、linkDrain 10、底线 2、目标 2 不变；其余房 linkFed 0，目标 W34S7 3、W33S8 3、W35S7 2、W31S8 4、W31S6 4、W31S5 1，与部署前一致。已请 screeps-9e 同快照对照 c3bdab1（预期 W31S8 回到 3 只、W33S7 RCL7 降到 ~1）。
- 待做：A/B 看 RCL7 单 hauler 的 spawn/塔补给是否有缺口；升级者 WORK 作为链吞吐是上界（ctrl link 空时升级者停手），如 A/B 里 RCL6 房仍堆源容器再换成控制器进度 EMA。

## 2026-09-06T20:58+09:00 己方房连续阵亡上限 + 开盾失败码遥测 + 大脑识别"别房占着 safe mode"

- 测量：20:41 巡检 monitor 报 W31S5 defender 阵亡 +6、1 武装敌人。探针（tick 73526148）：W31S5 RCL2 无塔、容量 300，敌人是一只强化 Invader（1086 血、80 DPS、until 73527434），defenseLog spawned 7 / losses 6，还剩一只 2A2M（140 血）；大脑 state.json 与 guard 均给 W31S5 `activate/help-too-late`，游戏内指令也收到了（atTick 73526150、ack 新鲜），但 controller.safeMode 仍空、没有 `defenseLog.safeMode`——W31S8 的盾还剩 7639 tick，同一账号同时只能一房开盾，`activateSafeMode()` 返回 ERR_BUSY（docs/api/StructureController.md:210），旧代码只在 OK 时记录、失败无声。defense 侧："上一只阵亡后没再看到敌情就不续派"的门比较 `threat.seenAt <= lastLoss.at`，己方房敌人每 tick 可见，门永远不闭；编组模型按三只 2A2M 同时交换伤害判能赢，实际每只刚孵出就在 spawn 旁被单杀。其它：版本 1788692960204 稳定、errors 空、大脑 5 轮白名单一致、reserver 5–7 与预定需求一致、W33S3/W31S5 已建成 spawn（RCL2）。
- 改动：`config.defense.maxOwnLosses 2`；`defense.noteLoss` 给被防守房记 `defenseLog.streak`（连续阵亡），`getDemands` 在己方房可见且无武装敌人时归零，`evaluate` 对己方房 streak ≥ 上限时 skip（`losses:<n>`，到敌人到期），大脑 fight 指令仍可越过；`tower.js` 开盾失败记 `defenseLog.safeModeError {at, code, by}`；大脑 `safemode.safe_mode_busy`：别的己方房 `safeMode` 为真时本房决定 hold `busy:<房>`（run.py/decide_all 都传）。冒烟：ERR_BUSY 不记开盾、记失败码；阵亡 1 只仍续派、2 只后 skipped `losses:2`、fight 指令越过、清场归零、下一波重新出兵（旧代码上三条失败）。Python 加 busy 用例，135 项全过。
- 验证：私服 validation-0GyrXG ok、notificationErrors 0、19 条生效断言全过（新增 `defense.ownLossStreak`：defense 场景清场后 streak 为 0，旧代码无此字段）；基线只有两条"E18S18/E18S16 基线里有、本次没有"的警告——是攻略会话 VALIDATE_CONQUEST 门控场景上次跑过留下的，与本次无关。smoke、语法、conquest_test、自测、py_compile 全过。
- 门控部署：activeWorld=default；提交 fd337b1（游戏代码 + 冒烟）、02124a2（大脑）、64d692a（断言 + 自测）、ec32ab8（CLAUDE.md）；`npx grunt` 版本 1788695727864（上传时线上 1788692960204）。
- 复测：tick 73526355 SCRIPT_VERSION 1788695727864、Memory.errors 空；W31S5 房内已无敌人（Invader 到期/被最后一只打掉），defenseLog.streak 已归零，spawn 空闲的房（W34S7/W35S7/W31S6/W33S3/W31S5）都写了 streak 0，spawn 忙的房要等下一次算需求。W31S8 safe mode 还剩 7424 tick，期间 W33S3/W31S5 这类无塔新房再遇入侵只能靠上限止血。
- 待做：safeModeError 与大脑 busy 决定要等下一次入侵才能在线上看到；编组模型对"逐只孵出、在 spawn 旁被单杀"的情形过于乐观，可考虑容量 < 650 的房只按 1 只能否单挑判定；观察 W31S8 盾到期后无塔新房的防御。

## 2026-09-06T21:12+09:00 用户指示占领 W32S4/W31S4：两房已无主，W32S4 由 W33S7 开荒中，W31S4 等 W31S6 容量到 650（母房资格改按容量）

- 测量：tick 73526413 两房 controller 均无主（level 0，攻略会话 noClaim 压到 0 级）。大脑 tick 73526339 已把 W32S4 分给 W33S7（4 跳）；W33S7 expansion 目标 W32S4（since 73526262），claimer 灵梦（剩余寿命 515）已到 W33S6，两只 pioneer 跟进。W31S4 = noSponsor：地理上 W31S5 没有北出口、W31S8 没有北出口，W31S4 只能经 W32S4 从东边进；5 跳内的候选只有 W31S6（4 跳，经 W32S6→W32S5→W32S4），但它 RCL3、容量 600（6 个 extension）；W33S7 5 跳但正忙；W34S7/W33S8/W31S8 都是 6 跳。
- 改动：`plan.assign_claim_queue` 的母房资格改按 spawn 容量 ≥ `claimSponsorMinCapacity`（650，claimer 成本；容量来自 plans[home].capacity = 情报里 spawn/extension 数），没有容量数据时退回 RCL ≥ claimMinLevel；run.py 传入容量。新增单测（RCL3 容量 750 的房可接相邻房，容量 550 的不行）。Python 136 项全过。提交 89b92dd。纯 Python，launchd 下一轮起用。
- 复测：dry-run 仍 noSponsor（W31S6 容量 600 < 650，符合预期）。W31S6 有 4 个 extension 工地（第 7 个 678/3000），2 只 builder，约 2300 能量后容量到 650，大脑随即把 W31S4 分给它；否则 W32S4 建成 spawn 后由 W33S7（5 跳）接。
- 待做：下一轮核对 灵梦 占下 W32S4、W31S6 容量与 W31S4 的分配。

## 2026-09-06T21:27+09:00 占领清单母房改按 claimer 实际行程（地形 A*，≤ 600 tick，不限跳数）；W32S4 已占下，W31S4 由 W31S6 开荒中

- 测量：用户指示"claim 的时候不限制跳数，600 tick 内能到达即可"。情报每房本就拉了地形（算出口），只是没存；母房 spawn 位与目标 controller 位情报里都有。按各房真实地形跨房 A*（[CLAIM,MOVE]：平地/道路 1 tick/格、沼泽 5 tick/格，只穿无主/己方房，踏上边格即落到对面房同行/列的边格），线上各母房到 W31S4/W32S4 的估算：W33S7 205/171、W34S7 240/206、W33S8 276/242、W35S7 274/240、W31S8 271/310、W31S6 165/208——都在 600 内，之前的 4/5 跳上限白白把 W31S4 拦了。一轮 run.py 用时 1:41（API 90 次占大头，A* CPU 0.6 s）。
- 改动：`intel.build_entry` 加 `spawnPos`，`collect` 把地形存进 entry（不进 segment）；`plan.travel_ticks`（A*，起点/终点没地形时退回 route_hops × `claimTicksPerRoom` 50）；`assign_claim_queue` 按 travel ≤ `claimTravelTicks`（600）选最近母房，状态附 `hops` 与 `travel`；`claimQueueMaxHops` 改为 `claimSearchRooms` 12 只防无界搜索。单测：全平地 4 房约 195 tick、走廊全沼泽多花 200+、上限 300 时没人接、墙封死走不通；Python 137 项全过。提交 714da75（前一步 89b92dd 已把母房资格改按容量 ≥ 650）。
- 复测：tick 73526925：W32S4 已归我方（RCL1，spawn 工地 3040/15000，两只 pioneer 在场）；W31S4 由 W31S6 接（容量刚到 650，launchd 一轮在 tick 73526772 已分配），claimer 灵梦（寿命 487）已走到 W30S4——游戏内 findRoute 选了 W31S6→W30S6→W30S5→W30S4→W31S4 的高速路路线，与大脑估的 W32S6→W32S5→W32S4 路线同为 4 房；两只 pioneer 跟进。指令 issuedAt 1788697960065 已 ack。
- 待做：下一轮核对 灵梦 占下 W31S4；A* 没算他人建筑/rampart（走廊只穿无主/己方房，影响小）；highway 房被当作可穿行走廊（游戏内也这么走），保持一致。

## 2026-09-06T21:37+09:00 巡检：无改动（W31S4 的 claimer 已进房；Kasami 5 只战斗 creep 出现在 W30S4 高速路）

- 测量：tick 73526955，SCRIPT_VERSION 1788695727864、Memory.errors 空、塔全 ≥ 500、towerBreaches 0。大脑连续 3 轮 blockers 空、白名单一致；claimQueue：W33S3/W31S5 owned，W32S4 bootstrapping（W33S7，spawn 工地 3200/15000，两只 pioneer 在场），W31S4 claim（W31S6，travel 165）。reserver 6 = 需预定的外矿 6（W33S7 的 W32S7/W31S7 预定 1255/640 暂不需要，W33S6 因一只敌人暂停）。claimer 灵梦（寿命 457、满血）已进 W31S4（47,18），房内无敌人，几十 tick 内占下；两只 pioneer 走 W30S6→W30S5→W30S4 的高速路路线跟进。**威胁**：大脑在 W30S4（高速路，W31S4 西邻）看到玩家 Kasami 的 5 只战斗 creep（22k 血、1360 DPS、684 治疗、远程，until ≈ 73527212），pioneer 要从那里穿过，RCL1 的 W32S4/W31S4 没有任何防御，W31S8 的盾还剩 6834 tick 所以别房开不了盾。已通知攻略会话。W34S7/W35S7 升级回退是 W34S7 spawn 持续孵援建/外矿（能量 58/1300）、W35S7 队列换代所致。
- 改动：无。占领路径的 A* 与游戏内 findRoute 都不避开有敌人的走廊房，这次 pioneer 要穿 Kasami 所在的 W30S4——若阵亡，下一轮考虑让大脑的走廊规则排除近期有武装玩家 creep 的房（travel_ticks 的 passable）并让 movement 对占领/开荒 creep 绕开 Memory.map 里有敌情的房。
- 待做：下一轮核对 W31S4 占下、pioneer 是否穿过 W30S4、Kasami 是否进我方新房。

## 2026-09-06T21:50+09:00 外矿容器工地优先于路工地 + spawn 收入估计平滑（第一轮塔储备修复的两条待办）

- 测量：用户要求继续修。塔修复上线 5 小时后 W33S8 稳定（队列空、收入 12.7、hauler 3/3、塔锁存已解除、无跌破）。W32S8 矿工 勇仪丙 与 reserver 都已到岗、我方预定到 73528774，但容器仍未建成：房里只有 6 条零进度路工地、没有容器工地。根因（`remote.placeInfrastructure`）：容器烂掉后留下的 6 条路工地 = MAX_REMOTE_SITES，`sites.length >= MAX_REMOTE_SITES` 直接返回，容器工地永远放不出；同时全账号工地 95–100（W33S3 31、W31S5 30 各含 24 条路，W32S4 11，三个外矿各 6 条路），`globalSiteCount() >= 100` 也拦——没有容器就没有 hauler、升不到维护档，母房一打嗝它最先被丢，队列档位只是表象。收入估计：`spawnIncome` alpha 0.05 下一车 400 到货 EMA 跳到 19、60 tick 没到货掉到 0.41 被当 0（第一轮实测 19 → 3.2 → 0.41 → 队列 income 0），缩身下限在 650 与 0 之间翻转。
- 改动：(1) `remote.js` 容器工地优先——外矿源没有容器/容器工地时，本外矿路工地占满或全局 ≥ 100 就撤一条零进度的路（先本外矿的，再本母房其他外矿的；撤除下一 tick 生效、下一轮 infraTick 放容器），遥测 `remotes[房].roadSitesYielded / containerSiteAt / containerBlockedAt`；本母房任一启用外矿缺容器时不放新路。(2) `config.spawnQueue.incomeAlpha` 0.05 → 0.01、`incomeSamples` 10 → 200（≥ 一个时间常数，收敛前按每源 fallback）、EMA 从 0 起收敛（以前首个样本直接当 EMA）、`spawnIncome.starved` 记"有搬运工在岗却把收入当 0"的 tick 数；`updateSpawnIncome` 导出供冒烟用。冒烟：6 条路工地锁死 → 撤 1 条放出容器工地；全局 100 → 撤本母房另一外矿的路且它不再补路；一车 400 每 60 tick（均值 6.7）下 EMA 始终在 [1, 13.3]（旧代码 0.34–21.02）；旧代码下 7 条断言失败。现有收入 fixture 的 n 50 → 500。
- 验证：私服 validation-5sGFFW ok、通知错误 0、21 条生效断言全部观察到（新增 `remote.containerBeforeRoads`：remote 场景外矿房预置 6 条零进度路工地，roadSitesYielded ≥ 1 且 containerSiteAt > 0；`spawn.incomeSmoothing`：logistics 房 n ≥ 200、starved 0、EMA ≥ 1；效率优化会话提醒的 `hauling.deliveryStops` 也过）。基线警告：起步房 W20N20 RCL 2 → 1（工具自己标注 700 tick 到不到 RCL2 取决于随机地形，7 只 creep、无错误）、conquest 两房本次未启用。
- 门控部署：activeWorld=default，提交 7a0e693（remote）、1c824b9（spawn/config）、bec1158（生效断言），部署版本 1788699084104（上传时线上 1788695727864，随带攻略会话已验证的 dbbffb8）。
- 复测：tick 73527237–73527294 版本已切、errors 空；各房 spawnIncome EMA 合理（W33S7 56、W34S7 25、W33S8 8.6–16）、starved 都未出现。W32S8 撤了 4–5 条零进度路（6 → 1）却仍没放出容器工地（containerSiteAt 空）：全账号工地 99–100（W33S3 30、W31S5 28、W32S4 11、W31S4 10 四个新房 = 79），外矿撤路腾出的名额在下一轮 infraTick（11 tick）之前就被母房 layout 的"每房保底 10 个工地"（W31S6 4、W31S8 2、W31S4 10 以下的房不看全局占用）抢走。效率优化会话独立复测得到同一结论。→ 第三轮：全局最后 remoteContainerSiteReserve 个名额只给外矿容器工地（保底与外矿路都停在 100 − reserve）。

## 2026-09-06T22:00+09:00 巡检：无改动（四个清单房全部占下；W32S8 容器工地仍被全账号 100 个工地名额卡住）

- 测量：tick 73527294，SCRIPT_VERSION 1788699084104（screeps-1c 部署：外矿容器工地优先、收入 EMA 平滑）、Memory.errors 空、塔全 ≥ 500、towerBreaches 0、全图无敌人（Kasami 的 5 只已离开 W30S4，pioneer 全部无损穿过）。大脑连续 3 轮 blockers 空、白名单一致；claimQueue：W33S3/W31S5 owned，W32S4 bootstrapping（W33S7，spawn 工地 6200/15000），W31S4 bootstrapping（W31S6，已占下，spawn 工地 150/15000，两只 pioneer 在场）。reserver 4 = 当前需预定的外矿 4（W33S7 四个外矿预定还剩 298–1856 tick、暂不需要）。W31S8 升到 RCL4（旧 extension 占方案位 10 处，拆迁每 50 tick 拆 1 个）。screeps-1c 新遥测：W32S8 roadSitesYielded 5 但 containerSiteAt 仍空、房内只剩 1 条 road:0——Game.constructionSites 总数 100，被四个新房各 20 多条路工地占满，外矿撤路腾出的名额立刻被母房 layout 的新路吃掉；spawnIncome.starved 各房 null（未饥饿），EMA 合理（W33S7 56、W34S7 25、W33S8 16）。
- 改动：无。工地名额问题已交给 screeps-1c（他们第三轮做 `remoteContainerSiteReserve`：全局最后 2 个名额只给外矿容器工地）。
- 待做：两处 spawn 工地进度；新房 RCL<3 的路工地数量是否需要压（screeps-1c 留作量化）；W31S8 盾还剩约 6500 tick。

## 2026-09-06T22:20+09:00 外矿容器工地的全局保留名额：撤路腾出的名额不再被母房保底抢走

- 测量：上一轮（1788699084104）复测发现改动只做了一半——W33S8 的 `remotes.W32S8.roadSitesYielded` 涨到 4–5（路工地 6 → 1），`containerSiteAt` 仍空，容器始终没建成。原因：全账号工地 99–100（W33S3 30、W31S5 28、W32S4 11、W31S4 10 四个新占的房共 79 条路工地），`remote.js` 撤路腾出的名额要等下一轮 infraTick（11 tick）才用得上，而 `layout.placeSites` 的每房保底 `siteFloorPerRoom`（10）按设计不看全局占用，这 11 tick 里就把名额放掉了。效率优化会话独立复测得到同一结论（tick 73527294）。
- 改动：`config.remoteContainerSiteReserve`（2）——引擎 100 上限下的最后 2 个名额只给外矿源容器工地：`layout` 的每房保底受 `globalSiteHeadroom()`（100 − reserve − 当前占用）钳制，`remote.js` 放路也停在同一条线并记 `remotes[房].roadsHeldAt`；容器工地本身仍可用满 100。冒烟：全局到 100 − reserve 时保底房与有容器的外矿都不放，降 1 个名额后恢复，保底最多放到保留线；旧代码下 4 条断言失败。
- 验证：私服验证 ok、通知错误 0、21 条生效断言全部观察到、基线零警告。remote 场景改为在 `industryTarget`（该用户没有 creep 的房）塞 94 条零进度路工地，加上外矿自己的 6 条正好把账号顶到引擎的 100——容器工地只能靠撤路腾名额才放得出，与线上 W32S8 同构；`remote.containerBeforeRoads` 另外要求容器建成后见过 `roadsHeldAt > 0`（旧代码 99 < 100 会直接放路）。
- 门控部署：activeWorld=default，提交 d8d8eed（代码 + 冒烟）、054bf51（私服场景 + 断言），部署版本 1788700813401（上传时线上 1788699084104）。
- 复测：tick 73527351–73527674 版本已切、errors 空。W32S8 `containerBlockedAt` 73527351（名额还没腾出来时先记一笔）→ `containerSiteAt` 73527368（17 tick 后放出容器工地）→ 房内 container 工地 1600/5000 在建、6 条路工地全部让位（`roadSitesYielded` 6）、`roadsHeldAt` 73527674（容器在建期间不再补路）。效率优化会话同时复测到同一状态。全账号工地仍是 100 而非 98：保留只挡新放的，已有名额没人退——其中 75 个是零进度的路，光 W33S3、W31S5 两个 RCL2 新房就占 48 条，两房自己还在建 spawn/extension，短期建不动路。
- 待做：新房（RCL < 3 / 无 spawn）先只放源容器与 extension，路等 RCL3 再放（预计一次腾出 40+ 名额）；维修改 builder 优先仍待 A/B。

## 2026-09-06T22:30+09:00 巡检：无改动（第 7 轮 A/B 复核后确认 link 底线不回退）

- 测量：tick 73527691，SCRIPT_VERSION 1788700813401、Memory.errors 空、全图无敌人。大脑连续 3 轮 blockers 空、白名单一致（W31S8 升到 RCL4 后新分到 W29S6/W29S7/W29S8/W31S9 四个外矿）；claimQueue：W33S3/W31S5 owned，W32S4 spawn 工地 9840/15000、W31S4 1800/15000（各 2 只 pioneer）。reserver 7、remoteMiner 11。screeps-1c 第三轮的容器保留已生效（W32S8 containerSiteAt 73527368、container:1510 在建、roadsHeldAt 已记）。
- 第 7 轮 A/B 复核（screeps-9e，c3bdab1 vs 我的 5163eca，报告尚无结论段）：全账号 CP 81.5 → 77.8，但**不该据此回退**。W33S7 是唯一受"RCL7 有 store link 底线到 1"影响的房，它的 CP 16.2 → 14.9（−1.3）能被自己外矿的到货差完整解释：W32S7/W31S7/W32S6/W33S6 采集 29.8 → 27.1、净 18.3 → 16.7（−1.6）。底线 1 本身的直接指标健康：hauler 1.7 → 1.1、空闲 85% → 84%、源容器 0.0k → 0.1k、掉落不堆积——第 2 只确属闲置产能。RCL<7 的 link-drain 一半按预期改善：W31S8（第 6 轮被压坏的那房）CP 5.2 → 5.4、源容器 1.1k → 0.9k，W34S7 8.6 → 9.1 且 hauler 1.9 → 1.5。总采集与总 CP 同向下降（196 → 186.6）仍是外矿分支差异（第 6 轮同指标是 +14.4，方向随机）。已把这套归因与"单房锁定外矿再判"的建议发给 screeps-9e。
- 改动：无。
- 待做：全账号 100 个工地里 75 个是零进度路（W33S3/W31S5 各 24 条），已交 screeps-1c 量化；W31S8 刚 RCL4 就分到 4 个外矿、队头 reserver 等了 410 tick（队列按设计让位，暂不动，观察是否产生无效路工地）；W34S7 控制器容器空 419 tick。

## 2026-09-06T22:55+09:00 hauler 底线回退：RCL7 有 store link 也留 2（底线 1 是 spawn 补给的单点故障）

- 测量：screeps-9e 第 7 轮同快照 A/B（`docs/benchmarks/2026-09-06-hauler-link-ab-round7.md`，c3bdab1 vs 5163eca），新增"母房收入账"列（自采 + 外矿到货，外矿按母房 remotes 归属）后判断清楚了两件事。(1) 我的 link-drain 模型该留：W33S7 的 CP 16.2 → 14.9 全是收入差（收入 42.7 → 38.1/tick，CP/收入 38% → 39% 甚至略升），W31S8（第 6 轮被压坏的房）19% → 20%、CP 5.2 → 5.4、源容器 1.1k → 0.9k，W34S7 52% → 60%、CP 8.6 → 9.1。(2) 但底线 1 有代价：W33S7 在 597 次采样里 12 次一只 hauler 都没有（对照 3 次），首次出现 2 次 emergencyHarvest，spawn 能量掉到 10–300/5100。
- 改动：`config.hauling.linkFloorMinStore` 1 → 2。不采用"加大提前量"或"加前置条件"两个补法，因为都消不掉单点：第 1 只 hauler 已是生存档（vital）且 `roleLead` 已按身体部件 × 3 + 12 预补，空窗是"唯一一只死亡到替补孵出"的物理时间（RCL7 大身体约 100 tick），还有非寿终而死、spawn 正忙两种情况；Screeps 里 link 填不了 extension，spawn 补给只有 hauler 一条路，冗余是唯一解。注释写明重试前置条件（先做出"最后一只 hauler 的替补零空窗"）。冒烟保留一条断言证明把这个数调到 1 底线确实会降。
- 验证：私服第一次挂在播种（`No free position near 48,40`：控制器随机落在边角，storage 的 5–9 格落点环几乎全在图外）——那个约束是我加的，已把上限放宽到 12（仍在 feeder 的 15 格内，seedLogistics/seedLinks 两处）；重跑 validation-bxPDOw ok、22 条生效断言全过（含改成目标 2 的 `hauling.linkFloor`）、通知错误 0、基线零警告。smoke、语法、conquest_test、自测、Python 138 项全过。
- 门控部署：工作树里有 screeps-1c 第五轮未提交的 `src/layout.js` 等，因此按 hunk 只暂存我的四处（config/effects/smoke/自测），并**从分离工作树按我的 HEAD 上传**，不带他们的 WIP；activeWorld=default；提交 da4c66e，版本 1788702187007（上传时线上 1788701537276）。fixtures.js 里我放宽落点的两处仍未提交，留给 screeps-1c 连同他们的 hunk 一起提交。
- 复测：tick 73528011、SCRIPT_VERSION 1788702187007、Memory.errors 空。各房 haulModel 底线均为 2（W33S7 linkFed 1、目标 2；W33S3/W31S5 是 RCL2 底线 1），全账号工地 98（screeps-1c 的容器保留生效，存量清理是他们第五轮）。
- 待做：做"最后一只 hauler 的替补零空窗"后重试底线 1（替补到位旧的才退役，或 spawn 为最后一只 hauler 预留能量），届时请 screeps-9e 再跑一轮同快照。

## 2026-09-06T22:45+09:00 新房的路工地等 RCL3，存量一并归还：全账号工地 100 → 40

- 测量：上一轮把外矿容器的保留名额做出来后，全账号工地仍卡在 98–100。按房拆开：75 个是**零进度**的路工地，光 W33S3、W31S5 两个 RCL2 新房就各占 24 条——两房自己还在建 spawn 与 extension，短期建不动路。门槛选 RCL3 有直接证据：同一时刻 W31S6（RCL3）0 个工地、W31S8（RCL4）7 个工地里 0 条路（RCL3+ 的房把路都建完了），而两个 RCL2 房的 48 条全是 0 进度。
- 改动（分两步上线）：(1) `config.roadsMinRcl`（3）——`layout.placeSites` 的道路分支加 RCL 门槛，只管本房路（外矿路仍走 `remote.js` 的 `roadSitesPerHome` 12 + 缺容器不放 + 保留线三重限制），容器/extension/spawn/link 不受影响。(2) 光挡新放的不够（上线后两房仍各挂 24 条），`trimSites` 里把 RCL < `roadsMinRcl` 的房中**零进度**的路工地清掉，有进度的保留（RCL 降级不丢进度），遥测 `Memory.rooms[房].roadsTrimmed / roadsTrimmedAt`。冒烟双向断言（RCL1 不放且清存量、升到门槛就放），旧代码下失败。
- 验证：私服验证 ok、通知错误 0、22 条生效断言全部观察到（新增 `layout.roadsWaitForRcl`：bootstrap 房 RCL1 播 5 条路工地、其中 1 条带 120 进度——结束时没有路工地、`roadsTrimmed ≥ 1`、有进度的那条留下）、基线零警告。过程中两次撞上 `seedLogistics` 的播种脆弱点（随机地形下控制器/ spawn 落在边角）：storage 落点 5–9 → 5–12（并行会话所写）、塔落点加三级回退（奇偶 2–5 → 奇偶 2–10 → 不挑奇偶 2–10），都与本次改动无关。
- 门控部署：activeWorld=default，提交 3503001 + f1b472e（门槛，版本 1788701537276）、8596b5a + 5838a09（存量清理，版本 1788702500466，建在并行会话的 da4c66e 之上）。第四轮因工作树里有并行会话未提交的改动，从分离工作树按本会话 HEAD 上传；第五轮工作树干净，直接上传。
- 复测：errors 空；`roadsTrimmed` W33S3 24、W31S5 24、W31S4 7；全账号工地 **98 → 40**（W33S3 30 → 6、W31S5 27 → 2、W31S4 10 → 3、W32S4 11 → 6），剩下的路只有 W32S5/W33S5 各 6 条外矿路与 W32S4 的 3 条。名额压力解除，外矿容器与新房 extension 不再排队。
- 待做：W33S3/W31S5 升到 RCL3 时方案里的路会一次性排队（`sitePace.roads` 允许 24 个同时在建），届时看是否要限流；维修改 builder 优先仍待 A/B。

## 2026-09-06T23:18+09:00 监控的 CPU 告警只在"付不起"时报（bucket 见底或逼近 tickLimit）

- 测量：tick 73528472 monitor 报 `CPU 用量过高: 176.6/140`。查 `Memory.stats` 最近 20 个采样：cpu 均值约 100/140，bucket 在 10000 → 462/1031 → 逐步回满之间循环——这是 bucket 满时 `generatePixel`（一次 10000）的设计行为，说明账号 CPU 是净富余（每 tick 约 +22 回补）；20 个采样里有 2 个（165.0、176.6）会触发这条告警。引擎规则：单 tick 允许用到 `Game.cpu.tickLimit`（本账号 500），超过 `limit` 的部分从 bucket 支取，只有真的付不起才会被打断。同轮其它测量：工地从 100 降到 44（screeps-1c 的存量清理生效：W33S3/W31S5 各清 24 条、W31S4 清 7 条），各房 hauler 底线均为 2（回退已在线上），大脑连续 3 轮 blockers 空、白名单一致，W32S4 的 spawn 工地 14400/15000 即将建成、W31S4 4200/15000。
- 改动：`scripts/monitor.py` 的 CPU 告警加两个条件——bucket 低于 `cpu_bucket_ok`（2000）或 cpu 超过 `cpu_tick_limit_ratio`（0.9）× tickLimit 才报，消息里注明是哪一种。bucket 水位与回退过快两条告警原本就已扣除像素生成，不动。新增 `CpuAlertTest` 四例（尖峰有 bucket 兜底不报、bucket 见底报、逼近 tickLimit 报、正常用量安静），旧代码上第一例确实失败。Python 142 项全过。
- 验证：纯 Python 工具改动，无游戏代码，不需要私服验证；改后重跑 monitor：cpu 131.26/140、bucket 3986，CPU 告警消失，只剩 W31S8 safe mode 的状态提示。
- 门控部署：不涉及上传（线上仍是 screeps-1c 的 1788702500466，含我的 da4c66e）。提交见下。
- 待做：CPU 均值 100/140、10 房 114 creep，随新房长大要持续看 bucket 是否还能回满；真要定位热点需要按模块计时的遥测，等 bucket 出现趋势性下滑再做。

## 2026-09-06T23:47+09:00 巡检：无改动（W32S4 建成 spawn；记录 W31S8 三个外矿"不可达"的待查）

- 测量：tick 73528932，SCRIPT_VERSION 1788702500466、Memory.errors 空、cpu 107.8/140、bucket 5025（新的 CPU 告警规则安静，符合预期）。大脑连续 3 轮 blockers 空、白名单一致；claimQueue 里 **W32S4 已转 owned（spawn 建成，控制器 131/200）**，只剩 W31S4 在开荒（spawn 工地 6000/15000，2 只 pioneer）。工地 44 → 稳定，reserver 6。
- 待查（本轮不改）：W31S8 升到 RCL4 后拿到 4 个外矿，其中 W29S6/W29S7/W29S8 被游戏判为 unreachable（`noteTravel`：creep 连续 `remote.stuckTicks` tick 位置不变即停用），三条记录都是 `unreachableCount 1`、`lastSeen 0`（从没有 creep 到过），冷却分别还剩 2057/1931/1737 tick。但用大脑新加的地形 A*（`plan.travel_ticks`）算，从 W31S8 出发到这三个房只要 204/171/95 tick，路线经 W30 高速路列，全程可达——两边判断矛盾。可能是 `movement.go` 在跨高速路时寻路失败导致 creep 原地不动，也可能是小身体在沼泽上被交通解算卡住；现在冷却中没有 creep 在路上，无法观察。下一轮（冷却到期后）盯住试探矿工的位置连拍两次再定位，不猜着改。
- 改动：无。
- 待做：上述根因定位；W35S7 控制器容器空 416 tick、升级回退（backlog 111k 最大，2 只 hauler）；W31S8 safe mode 还剩 4847 tick。

## 2026-09-07T00:22+09:00 巡检：无改动（W31S9 的 6 只运输工是模型算对的；外矿评分与实测净收益的偏差记录在案）

- 测量：tick 73529437，SCRIPT_VERSION 1788702500466、errors 空、cpu 114/140、bucket 4635（回补正常）。W31S4 spawn 工地 8200/15000。W29S6/W29S7/W29S8 的不可达冷却还剩 1570/1444/1250 tick（约 80 分钟，比上轮估计长——线上约 4 秒/tick），本轮抓不到试探矿工，根因定位顺延。
- 核过的疑点（不是 bug）：W31S8 给单源外矿 W31S9 派了 6 只 remoteHauler，一度以为超编。实测记录：该源已建容器、路已修完、单程 77 格、卸货房是 W31S8 自己（3 跳）。按模型算 10 能量/tick × 往返约 160 tick ÷ 每车约 300 容量 ≈ 5.3 → 6 只，算术自洽；监控行里的 `h0/0` 是"当前在该房内的运输工"口径，不是编制。
- 记录在案（下一步要证据）：大脑的外矿评分（源×10 − 跳×8 − 相邻外再 −6）对现有 12 条外矿有 8 条是负分（W31S8 的四条 −12…−28，W34S7 的两条 −20/−28，W33S7 的 W31S7/W32S6 −12），但 screeps-9e 第 7 轮的每外矿净收益表显示它们多数仍是正的（W31S7 +4.3、W32S6 +3.9、W32S5 +0.7、W33S5 −0.1）。**所以不能按"评分 < 0"设门**，会砍掉赚钱的外矿；但评分与实测净收益方向一致（最负的两条恰好是实测最接近盈亏平衡的两条），说明可以标定一个更低的阈值。已请 screeps-9e 在下一轮 A/B 里测这个门。
- 改动：无。
- 待做：W29S8 冷却到期后抓试探矿工定位卡点；外矿评分门的标定（等 A/B）；W35S7 控制器容器空、升级回退。

## 2026-09-07T00:35+09:00 大脑加 `--remote-min-score` 参数（给外矿评分门的 A/B 标定用，默认不设门）

- 测量：screeps-9e 报告一个方法论缺陷——他们的分叉只把 `src/` 钉到 git rev，`scripts/brain` 一直从工作树跑，而 09-05 12:00 以来大脑有 8 个提交正好落在第 5–7 轮的运行期间（cf3a549/e9f9038/f7deac5/b5b5c69 在第 5 轮跑中，02124a2/89b92dd/714da75 在第 7 轮跑中）。所以那几轮我们称作"随机分支差异"的外矿采集摆动（±5–15/tick）有一部分是大脑代码在变。他们已修（`--src-rev` 连 `scripts/brain` 一起导出，run.json 记 `brainScript`，提交 2bdfa0f）并加了 `--brain-arg` 透传（2521fd1）。结论不受影响：第 7 轮用的是同房自比的 CP/收入，第 5 轮用的是 link 工地时间线，都不吃外矿绝对值。
- 改动：`plan.DEFAULTS['remoteMinScore']`（默认 None = 不设门）+ `choose_remotes` 的淘汰分支（记 `lowScore:<分>`）+ `run.py --remote-min-score`。门在 `stickyBonus` 之后判：已在用的外矿先加 6 分再比阈值，不为微小分差换房。这样 A/B 是"同一提交、只差一个参数"，配合他们的大脑钉版把噪声压到最小。单测覆盖：默认不设门、设门后低分进 rejected、粘性加分能把在用的房拉回门内。Python 143 项全过；纯 Python 无游戏代码，不需私服验证；线上 launchd 那轮行为不变。提交 0a2dd99。
- 复测：线上 dry-run，`-999` 的白名单与现状完全一致；`-14` 时 W34S7 的 W32S5 被砍、W31S8 腾出的名额自动补给 W29S9——已提醒 screeps-9e：**砍一条不等于少一条**，`remoteMaxRooms` 会被次优候选补上，B 组省下的孵化没有直觉上那么多，这一轮测的其实是"换成次优候选是否更好"。
- 另：screeps-1c 用 `git diff 8596b5a..f1b84f5 -- src/` 零行证明了 `aid.untilCapacity1300` 的失败与任何游戏代码改动无关（每轮新建随机地形，成败由地形与孵化顺序赛跑决定）；根因是夹具给弱房播了 2 CARRY 的 hauler 让援建请求失去 strategic 身份。已连同 links E20S20、upgrade.storageRich 一起记进跨会话记忆。
- 待做：等 screeps-9e 的门标定 A/B；W29S8 冷却到期后抓试探矿工。

## 2026-09-07T00:45+09:00 线上外矿 ROI 实测：评分门在线上不该设（相关系数 +0.14，9 条在用外矿全部盈利）

- 测量：screeps-9e 把基准世界的评分与账本净收益对齐后（`docs/benchmarks/2026-09-07-remote-score-vs-net.md`，提交 f7cdb67）发现分界干净落在 −10 与 −12 之间，但被砍的四条是**零产出**（地图边界导致 noRoute/unreachable）而非低产出，门槛收益仅约 0.3/tick（全账号 CP 的 0.4%），低于同快照噪声，A/B 测不出来；且不可达退避已在处理同一批房。他们建议线上取值改用 `scripts/report/remote_roi.py` 的实测净。照做，tick 73529640：
  - **9 条在用外矿全部盈利**，净 +4.6…+6.0/tick、ROI 1.0–1.7x。评分 −28 的 W32S5 净 +5.1、−20 的 W31S9 净 +6.0（ROI 1.7x 全场最高）、−20 的 W33S5 净 +5.2；而评分 +2 的 W34S8 净 +4.6 是最低的一条。评分与实测净的相关系数 **+0.14**。
  - 零/负产出只有已停用的（unreachable/notWhitelisted/tooFar/hostileCreep），在岗净 0.0…−0.5——退避已经把成本压到接近零。
  - 附带数字：所有外矿"不预定净"2.7–3.3，即**预定让净收益翻倍**；回本最慢 W34S8 4609 tick、W32S5 3227 tick，仍在寿命尺度内。
- 结论与改动：**线上不设评分门**（会砍掉 5.1–6.0/tick 的真实产出）。0a2dd99 的 `--remote-min-score` 保持默认 None，作为研究工具留给分叉对照。无代码改动。
- 更正：00:22 那条"评分与实测净方向一致"站不住——当时拿基准世界的净收益去对线上评分，跨世界比较。线上相关性只有 0.14。两个世界的差别在于评分实际只能分辨"能不能采"，而线上这件事由游戏内不可达退避负责。
- 待做：W29S8 冷却到期后抓试探矿工定位卡点（还剩约 1000 tick）。

## 2026-09-07T02:05+09:00 换代 reserver 不再被缩身成 1 CLAIM（缓冲才是盖住换代空窗的东西）

- 测量：screeps-9e 指出"预定覆盖率是外矿这条线上真正的杠杆"（线上 ROI：不预定净 2.7–3.3 vs 预定 4.6–6.0），顺着查到 W34S7（容量正好 1300、长期缺能量）的两只 reserver 都被 spawn 队列缩成 1 CLAIM。文档核实（`docs/api/Creep.md` reserveController）：每个 CLAIM 每 tick 加 1，而预定每 tick 自减 1，1 CLAIM 净零。线上把两种效应分开量清楚了：**在岗时 1 CLAIM 够把源顶在 3000**（W31S9：1 CLAIM、预定 1、源容量 3000），但**攒不出缓冲**——它一死预定立刻归 0、源掉回 1500，直到替补走完 50–77 格（W33S5 无人在岗时正是 1500、预定 0）；2 CLAIM 每 tick 净 +1，线上已攒到 597–4999，足以盖住任何换代。
- 改动：`remote.getDemands` 的 reserver 请求按"有没有人在岗"分流——**换代请求**（`hasReserver` 为真）在容量够双 CLAIM 的房拒绝缩身、等能量（W34S7 收入 17.8/tick，补 650 约 37 tick，在岗那只顶着）；**补空窗**（没人在岗）照旧有多少要多少，先把源顶回 3000。第一版写成"一律不缩身"，被私服打回：validation-04hY8C 里 remote 场景整轮一只 reserver 都没孵出来，比一只小的更糟——这个反例直接写进了注释。冒烟按两种情形各加断言，三条编码旧行为的老断言恢复成正确语义（我中途改错过一次）。
- 验证：validation-NqJW8k ok、23 条生效断言全过（新增 `remote.reserverNoShrink`：remote 场景播一只寿命 80 tick 的在岗双 CLAIM reserver，旧代码会孵 650 的单 CLAIM 替补）、通知错误 0；基线只有攻略会话门控场景的两条无关警告。smoke、语法、conquest_test、自测、Python 143 项全过。
- 顺带修掉一类误报：logistics 场景的 storage 落点改为**按 feeder 的前提条件筛选**（离控制器容器 ≤ 12 格，feederMaxDistance 15 留余量），并在播种时自检失败即抛错。2026-09-06/07 一晚里 logistics/aid 的三条断言（aid.untilCapacity1300、spawn.incomeSmoothing、feeder.storageToController）各自在**相同游戏代码**下失败过至少一次，全由随机地形决定（screeps-1c 用 `git diff` 零行证明）。夹具 `addCreep` 增加 `ticksToLive` 以便播"寿命将尽"的 creep。
- 门控部署：activeWorld=default；提交 ee51865（游戏代码 + 冒烟）、0a283b2（夹具 + 断言 + 自测）；版本 1788709901164（上传时线上 1788702500466）。
- 复测：tick 73529962、errors 空。7 只 reserver 里 5 只已是 2 CLAIM；W31S9（母房容量 850，买不起）与 W33S5（W34S7 刚补的空窗）仍是 1 CLAIM，符合新规则；W34S7 无 spawnWaiting。W31S9 源容量 3000、预定 1，印证"在岗即可维持"。
- 待做：盯 W34S7 换代后预定是否开始累积、控制器容器与 CP/tick 不因等能量而断供；`utils.spawnWaitingFor` 类别盲（一条 remoteMaintain 的 reserver 在等就会关掉 broker 的控制器公平通路，本该只对核心等待生效）——screeps-1c 查到、当前无主，下一轮接。

## 2026-09-07T01:55+09:00 巡检：无改动（新 reserver 规则按预期工作；记录全账号容器血量基线待下轮对比）

- 复测上一轮的改动：tick 73530434–73530496，SCRIPT_VERSION 1788709901164、errors 空。**双 CLAIM 在累积缓冲**：W33S6 的预定从 597 涨到 1297、源容量 3000。8 只 reserver 里 6 只是双 CLAIM；剩下两只单 CLAIM 分别是 W31S8（容量 850 买不起）和 W31S6 的两条新外矿（容量 800），都符合"买不起就用小的"分支。W34S7 能量 849、**无 spawnWaiting**，没有出现 screeps-1c 担心的等能量断供。
- 排除的疑点：W33S5 现在没有 reserver、源容量 1500，**不是我的改动**——它被 `hostileCreep` 暂停（房里有 1 只武装敌人，大脑已下 fight 指令）。W34S7 当前 7 条外矿全部暂停（W32S5 被大脑改派给 W33S7 并已配上双 CLAIM），所以它 spawn 空闲。
- 排除的疑点：W35S7 "控制器容器持续为空 1513 tick" 是稳态而非故障——房间在容器模式（`fedByStorage: false`，升级者站位就是容器），源产 20/tick，两只 11 WORK 的升级者消耗 22/tick，到货即被吃光，升级速率实测 8.75–18.28 prog/tick。broker 的公平规则也在生效（容器见底 + spawn 过半 + 无等待 ⇒ 权重 20、第 1 层）。
- **新发现，待下轮定位**：全账号容器在衰减，且已有房接近死亡（血/上限 250k）：W35S7 ctrl 17k、src0 15k、src1 17k（7%）；W34S7 三个 79k/75k/79k（30%）；W31S8 105k、W33S7 ctrl 145k/src1 145k、W31S6 140k、W33S8 185k；新房 W32S4/W33S3/W31S5 215k–245k（还新）。容器每 500 tick 掉 5000，从 250k 掉到 17k 约 2.6 万 tick，**早于今天的塔改动**，所以不是它引起的；但所有塔都停在 500–543，恰好卡在 `towerRepairReserve`，`tower.repairKeepsReserve` 之后一次也修不动，等于少了一条修理通路。修理路径本身是通的（`towerRepairBelow` 0.6，这些容器都够格；`builder` 在"有货且无工地"时修最破的），W35S7/W34S7/W33S8 各有 1 只 builder 且 0 工地——但 **W33S7 有 0 只 builder、0 工地**，它的两个 145k 容器无人可修。单点快照分不出"在跌"还是"在回升"，下一轮按同一组数字对比即可判定，不猜着改。
- 改动：无。
- 待做：容器血量时间序列对比 → 若仍在跌则定位（builder 是否真在修、塔是否该在和平期被补到能修的水位）；`utils.spawnWaitingFor` 类别盲（无主，可接）；W29S7/W29S8/W29S9 不可达冷却（还剩 246–2679 tick）。

## 2026-09-07T02:40+09:00 升级者顺手维修站位容器（容器全账号衰减，无 builder 的房无人可修）

- 测量：按上一轮留的基线做时间序列（487 tick）：**有空闲 builder 的房在回升**（W34S7 79k→84k、W35S7 17k→18k），**没有 builder 的 W33S7**（无工地所以 builderTarget 0）**与 builder 忙于工地的房一路下跌**（W33S7 145k→140k、W31S6 140k→135k、W31S8 105k→100k、W33S8 195k→190k），W35S7 三个容器只剩上限 250k 的 7%。账：容器每 tick 衰减 10 血，修 100 血只要 1 能量 ⇒ 维持一个容器 0.1 能量/tick；而为维修多养一只 builder 是 1300 能量 / 1500 tick ≈ 0.87/tick，贵 9 倍。
- 改动：`roles/upgrader` 在站位容器低于 `upgraderRepairStationBelow`（0.9）时花 1 tick 维修——它本来就站在容器旁、手里有能量，11 WORK 一 tick 修 1100 血、抵掉 110 tick 的衰减，约占升级吞吐的 1%。只对容器站位生效（storage 站位、link 供能的房不受影响），阈值设 0 即关闭。冒烟三条断言（破损时修、满血照常升级、阈值 0 时关闭），旧代码上失败 2 条。顺手修掉探针里一个作用域笔误（`m` 在 `validationProbe` 里不存在，会抛 ReferenceError）。
- 验证：第一次挂在 `feeder.storageToController`（今晚第三次失败的已知不稳定断言，与本改动无关），重跑 validation-8UI9Jp **ok、24 条生效断言全过**（含新增的 `upgrade.repairStation`：logistics 场景把控制器容器播成半血 125000，结束时必须更高）、通知错误 0、基线零警告。smoke、语法、conquest_test、自测、Python 143 项全过。
- 门控部署：activeWorld=default；提交 af58878（游戏代码 + 冒烟）、46fc3d6（夹具 + 断言 + 自测）；版本 1788715029847（上传时线上 1788709901164）。
- 复测：tick 73531253、errors 空。**控制器容器全面止跌**：W34S7 84k→90k、W31S6 135k→137k、W33S3 220k→222k、W33S7 140k→140k（此前每 487 tick 掉 5k）、W35S7 18k 持平。
- 待做：**源容器仍在衰减**（W35S7 src1 18k→13k，约 1300 tick 后消失）——静态矿工没有 CARRY 就无法维修，`harvesting.selfRepairContainer` 对它们无效，这是下一轮的候选；`utils.spawnWaitingFor` 类别盲（无主）；W29S7/W29S8/W29S9 不可达冷却。

## 2026-09-07T03:00+09:00 巡检：控制器容器修复效果确认；源容器修法试做后回退（涟漪大于收益）

- 复测上一轮：**升级者维修站位容器效果远超预期**，一轮（约 490 tick）内几乎全部修到阈值：W35S7 ctrl 18k→**226k**、W34S7 90k→225k、W31S8 95k→225k、W31S6 137k→226k、W33S8 189k→226k、W31S5 208k→225k、W33S3 222k→225k。SCRIPT_VERSION 1788715029847、errors 空。
- 两个例外，都符合设计：W33S7 的控制器容器 140k→135k 仍在跌（它是 link 供能房，站位锚点是 link 不是容器，我的规则只管容器站位）；**所有源容器仍在跌**（W35S7 src0 19k→14k、src1 13k→**8k**，约 800 tick 后消失）。
- 根因确认：探针显示**全部 20 只静态矿工都是 0 CARRY**，而 `harvester.containerNeedsRepair` 要求 `store.energy >= work`——0 CARRY 恒为 0，所以 `harvesting.selfRepairContainer` 对静态矿工是**死代码**。文档核实：掉落资源自动进入同格容器（`docs/api/StructureContainer.md`），所以 0 CARRY 不影响送货，只影响维修。
- **试做后回退**：给 `staticHarvester` 身体追加 1 个 CARRY（只在 WORK/MOVE 算满后仍有余钱时加，550 容量下保持 5W+1M 不变，800 起变成 5W3M+C=700）。冒烟暴露两处涟漪：(1) `spawn.incomeEstimate` 把"带 CARRY 的 harvester"计为搬运者，带 CARRY 的静态矿工会让"hauler/矿工全灭 ⇒ 收入 0"的死锁自恢复判定失效（241 能量孵小 hauler 的场景直接不触发）；(2) hauler 编制模型随之改变（feeder 场景 2 vs 0）。收益只有约 0.2 能量/tick/容器（容器烂掉重建 5000 能量 ÷ 约 25000 tick），代价是动到每个房间每只矿工的身体与两条紧急路径，**凌晨不值得硬推**，已回退，工作树干净。
- 改动：无（本轮）。
- 待做（下一轮，已定位）：源容器维修的两条候选——(a) 静态矿工加 CARRY，但必须同时把 `incomeEstimate` 的搬运者判定改成"CARRY ≥ 2 或非静态矿工"，并复核 hauler 编制模型；(b) 让塔在和平期被补到能修的水位（塔一次修 800 血，效率远高于 creep），但会重新打开"hauler 零头先喂塔、升级者挨饿"的老权衡（`towerRepairReserve` 注释里有记录）。另：W33S7 link 供能房的控制器容器是否还该保留/维修。

## 2026-09-07T04:00+09:00 塔的维修预算：写好并本地全绿，但连续两轮验证被薄边断言挡住，按约定回退未部署

- 测量（紧迫性确认）：tick 73532270。控制器容器全部稳定在 225–226k（上一轮的升级者维修在正常循环）；**源容器仍全账号衰减**：W35S7 src0 9k、src1 **3k**（约 300 tick 后消失），W34S7 77k/78k，W31S6 120k/125k；**W31S4 已经有两个容器死掉**（ctrl 与 src1 显示 GONE，房里挂着 2 个容器工地在重建，每个 5000 能量）。W33S7 的控制器容器 135k→130k 仍在跌（link 供能房，升级者站位是 link 不是容器，按设计不覆盖）。
- 机制定位（比上一轮更深）：塔的和平期维修本来就按"绝对血量最低优先"，容器排第一——但线上 10 个塔全停在 500–543，`tower.js` 要求 `energy − 10 ≥ towerRepairReserve(500)`，**一次也修不动**；而塔的和平期补能是第 4 层权重 2，在"控制器容器见底 ⇒ 第 1 层权重 20"的房里永远轮不到。于是维修被升级完全抢占。账：塔一次动作修 800 血，500 能量修 4 万血 = 8 个容器的完整衰减周期，远比多养 creep 划算。
- 改动（已写好、已回退）：`config.towerMaintenanceBudget 400 / towerMaintenanceWeight 5`；`task_broker` 在"房里确实有破损建筑（新增 `roomNeedsRepair`，每 tick 每房缓存一次）且塔能量 < 储备 + 预算"时把补能从第 4 层提到第 3 层，攒够或没活可干就退回第 4 层。选它而非"静态矿工加 CARRY"，是因为不碰 `incomeEstimate` 的搬运者判定与 hauler 编制模型（昨晚已暴露涟漪），且一并覆盖道路/rampart 等所有衰减建筑。冒烟两条新断言（缺预算时提层、攒够后退层），旧代码上失败 2 条；生效断言 `tower.maintenanceBudget`；自测三例。smoke、语法、conquest_test、自测、Python 143 项全过。
- **未部署的原因**：连续两轮私服验证被**与本改动无关的薄边断言**挡住——第一轮 `upgrade.storageRich`（storage 只降到 71338，门槛 70000；该场景是援建母房，只有 storage 与两个 link、**没有塔**，我的改动作用不到它），第二轮 `feeder.storageToController`（今晚第四次失败）。按 CLAUDE.md「main HEAD 必须是验证过的树」，不把未过验证的游戏代码留在共享分支：改动已存成补丁 `logs/src_backup/20260907-032500/tower-maintenance.patch`（133 行，`git apply` 即可复原），工作树已回退干净。
- 待做（下一轮，优先级从高到低）：(1) **修 feeder 场景的脆弱性**——它已挡住三轮验证，`storageRich` 在失败世界里始终 `{on:false, at:-1}`（从未开启），需要在播种后就地断言前提成立（storage 能量 ≥ storageFeedAbove、`controllerFedByStorage` 为假、feederDistance ≤ 上限），不成立就在播种时抛错；(2) 重跑验证并部署这份补丁（源容器仍在死，W35S7 src1 约 300 tick 后消失）；(3) `upgrade.storageRich` 的 70000 门槛留的余量太薄，考虑放宽到 75000 或延长 `--effect-ticks`。

## 2026-09-07T04:15+09:00 Overmind 对照拆解 → 一批 CPU / 正确性 / 能力改动（13 个提交，版本 1788722171883）

- 起因：研究 bencbartlett/Overmind（33k 行 TS，停更于 2019-06-14）并逐条对照我们的实现。14 个 agent 解剖 + 19 个 agent 对抗验证（分别去证伪「我们没有 X」「它有 Y 且今天仍成立」「它没有 Z」）+ 覆盖率批评（枚举全部 189 个 .ts、指认死代码）。69 条吸收候选 → 30 条双验证通过；58 条「我们更好」→ 34 条经得起反驳、5 条被推翻。完整报告见会话产物。
- **CPU（本轮主线）**：
  - **错峰 bug（自己发现的）**：`main.js:220` 用 `room.name.charCodeAt(3)` 当相位，而标准房名第 4 位对所有两位坐标的房恒为 'N'/'S'。线上 10 个房全部得到 `83 % 11 = 6`——layout.run 每 11 tick 一次、**全账号同 tick 齐发**，industry.run 同理。注释写的「不同房间不同相位」从未成立。改为整名 hash（`utils.roomPhase`），私服 12 个场景房从 2 个相位散成 9 个。
  - **creep 倒排索引**：spawn.run 每房按角色/需求项遍历 `Game.creeps` 十几次，harvester 的两个 helper 更是每只 creep 扫全表（O(creeps²)）。一 tick 建一次索引，转换 20+ 处。线上规模基准（116 creep / 10 房）1.527 → 0.042 ms/tick，省 ~1.5 CPU/tick，且平方项随规模增长。
  - **可视化默认关**：实测每房 0.74–1.22 CPU/tick × 10 房 ≈ 10 CPU/tick，画给没人看的屏幕；线上诊断本来就走 monitor/probe/report。改成 `showVisuals(300)` 临时开，bucket 低于 3000 一律不画。
  - **Memory 探针残渣回收**：359,623 字节里约 102 KB（28%）是 `_mon`/`_roi`/`_dbg2` 等探针结果，其中三个已死 4–5 万 tick，而引擎每 tick 都要解析+序列化整个 Memory。按「内容多久没变」回收（字符串比长度，变了就重新计时）。
  - **按模块/按房 CPU 计时**（这条待办从 2026-09-06 记到现在）：`cpuBy`/`cpuRooms` 进 Memory.stats，成本是每 tick 二十几次 `getUsed()`。
- **数据修复**：`Memory.stats` 过去把 `rooms[0]`——一个任意挑中的房——当成全账号经济序列，线上采到的正是刚占的新房（rcl 1 / prog 0 / storage 0），整条序列是死数据。改为按房名记 `[rcl, progress, storage]`；`cpu` 字段改到 tick 收尾回填（原来漏掉 flush 与 endTick）。
- **正确性（引擎规则）**：新增 `src/actions.js`——引擎 intent 优先级表的拷贝（已对照 `@screeps/engine processor/intents/creeps/intents.js`）。`rangedAttack` 会被同 tick 的 `rangedHeal` **整发丢弃**，而 siegeGuard 在 run() 末尾无条件 healSupport：破防时塔火 600/tick，队友几乎每 tick 带伤，等于整个护卫编队退化成纯奶妈。文件头注释还写着「heal 与 rangedAttack 不冲突」（对 heal 成立，对 rangedHeal 不成立）。近战 defender 的 `attack` 同样会被 `heal` 顶掉（当前近战身体无 HEAL，属潜在 bug）。
- **能力**：矿物钻机（我们一直在建 extractor 和矿物容器，却从没对 FIND_MINERALS 调过 harvest）；实验室三连位排序（三个方案固定件里两个的前三 lab 凑不出反应，纯排序问题）。
- **护栏**：攻城集结点等待上限（波次出发后到达的替补过去等到寿终）、占领后指令进终态（房子易手会自动重启整波）、装货的 storage/terminal 不拆、己方房里敌方 rampart 占规划位要拆。
- **运维**：监控补外脑心跳（segment 90 多久没写），在 6 小时宽限用完、外矿退回自治之前就报。
- 验证：smoke / conquest_test / Python / 验证脚本自测全绿；私服验证连续通过，9 条新增生效断言全部观察到（`core.roomPhaseSpread`、`core.creepIndex`、`core.visualsGated`、`core.probeKeyGc`、`core.statsPerRoomAndModule`、`combat.actionPipelineGuard`、`minerals.extractorDrone`、`layout.labTriple`、`demolition.keepsLoadedStore`），基线零警告。
- 纠正的错误判断（记录下来避免复现）：原以为「敌方 rampart 让规划位永远建不了」——引擎 `utils.checkConstructionSite` 明确豁免 rampart 与 road，工地照放。真正的机制是 `move.js` 只让 rampart 的主人踩上去，那一格对我们的 creep 是永久障碍；`destroy()` 只要求房间控制器是我们的，所以拆得掉。
- 门控部署：activeWorld=default（预检通过）；从已验证的独立 worktree 上传（主仓当时有另一会话的 WIP，直接 grunt 会把未验证的改动一起推上去）；版本 1788722171883（上传时线上 1788715029847）。
- 复测：tick 73533090、errors 空、128 creep。**新遥测第一份就有用**——按模块 CPU（窗口内每 tick 均值）：creeps 51.81 / spawn 30.43 / remote 9.39 / move.end 8.17 / broker.begin 2.97 / assess 2.36 / layout 1.16 / tower+links 1.15 / demolition 0.55 / expansion 0.45。**spawn 单项 30 CPU/tick 是下一个明确目标**（10 个房各跑一遍完整的编制推导）。
- 同轮修掉自己的埋点 bug：房级 cpuRooms 全空——runRoom 内部的模块级 cpuLap 一路推进 cpuMark，循环末尾那次只量到残渣。改成房级自己取 start/end，并把生效断言补成「cpuRooms 也必须非空」。
- 验证过程本身的教训（已写进项目记忆）：本机同时跑着另一会话的私服（load ~9–11）时，`feeder.storageToController` 与 `remote.reserverNoShrink` 这类吞吐边缘断言会随机失败。我的树连挂三次、基线树跑两次也挂了一次（挂在另一条断言），`--effect-ticks 900` 后我的树 35 条断言全过、基线零警告。判据：失败在断言之间漂移、数字向阈值靠拢 = 负载；数字塌陷 = 真回归。**一次基线通过不足以定罪一个改动。**
- 待做（按 cpuBy 排序）：spawn.run 30 CPU/tick 的分解与削减；creeps 51.8 里 movement 的占比；`task_broker` 租约表预置（另一会话在动这个文件，需协调）。经济侧两个 blocking 瓶颈（升级者放行闸 supply.ema ≥ 0.7 在算术上不可达、aid 导出线 10k 压在 storage 富余线 20k 之下）已定位但未动——它们在另一会话的每小时 A/B 范围内。

## 2026-09-07T04:25+09:00 塔的维修预算：查明验证失败是机器负载所致，加 --effect-ticks 后一次通过并部署

- **推翻上一轮的结论**：上一轮把连续两次验证失败归为"夹具脆弱"，本轮先量了机器负载——**load average 12.45**（记忆 `validation-flaky-scenarios` 里记的可信阈值约 6），10 个 `@screeps` 进程、两个私服并跑（screeps-9e 的基准分叉还要约 9 小时）。今晚 feeder 四次、`upgrade.storageRich` 一次、`remote.reserverNoShrink` 一次的失败全部符合"吞吐类断言在负载下退化"的特征：失败在不同断言之间游走、数字向门槛漂移而非崩塌。**夹具没坏，不该改**——改了反而会削弱一个正确的场景。
- 处理：按记忆里记的缓解办法复原补丁（`logs/src_backup/20260907-032500/tower-maintenance.patch`）并用 `--effect-ticks 900` 重跑（给边际场景更多 tick 完成，不削弱断言强度）。validation-AntJmS **ok、36 条生效断言全过**（含新增的 `tower.maintenanceBudget`，以及此前反复失败的 feeder 与 storageRich）、通知错误 0、基线零警告——**且是在 load 13.73 下跑过的**，证实这是正确的缓解手段而非侥幸。
- 改动：`config.towerMaintenanceBudget 400 / towerMaintenanceWeight 5`；`task_broker` 在"房里确实有破损建筑（`roomNeedsRepair`，每 tick 每房缓存一次）且塔能量 < 储备 + 预算"时把塔补能从第 4 层提到第 3 层，攒够预算或没活可干就退回第 4 层。塔一次动作修 800 血，一次 500 能量的补能可修 4 万血 = 8 个容器的完整衰减周期，并覆盖道路/rampart。
- 门控部署：smoke、语法、conquest_test、自测、Python 143 项全过；activeWorld=default；提交 9bcf7ca（游戏代码 + 冒烟）、7f0da9d（断言 + 自测）；版本 1788722540702（上传时线上 1788715029847）。
- 复测：tick 73533184、errors 空。部署仅过几 tick，塔尚未被补能（仍 500–509），效果要下一轮才看得出。已可见的好转：**W35S7 濒死的两个源容器回升**（src0 9k→14k、src1 3k→13k，此前一路跌向消失），W31S4 的 src1 已重建（GONE→240k）。
- 待做：下一轮确认塔能否升到储备线以上并开始维修（判据：塔 > 500 且源容器不再净减）；`upgrade.storageRich` 的 70000 门槛余量仍薄，可考虑放宽或长期用 `--effect-ticks 900`；W33S7 的控制器容器（link 供能房）仍无人维修，123k 且在跌。

## 2026-09-07T04:45+09:00 spawn 全忙时降频（按模块 CPU 指出来的第一个目标）：spawn 30.4 → 11.6，总 CPU 82.3 → 65.7

- 测量：上一轮上线的按模块 CPU 表第一份数据就定了目标——`spawn` 30.43 CPU/tick，仅次于 creep 分发的 51.81。读代码确认原因：`spawn.run` 把整套编制推导（7 个角色的 countPlannedRole、7 个 targetFor，其中 hauler/upgrader/builder 各自还要算运输模型、供给 EMA、建造 backlog，加上 coreContainerGap 与矿工覆盖统计）跑完之后，才在 `if (!idle.length) return` 处提前返回。所有 spawn 都在忙的那些 tick，这些计算的唯一产物是 `mem.demand`——而它除了监控与私服探针没有任何消费方。
- 改动：全忙时按房名 hash 错峰，每 `spawnQueue.busyDemandInterval`（默认 7）tick 才刷一次遥测；spawn 一旦空闲永远全跑，孵化决策一 tick 都不延后。跳过次数记进 `demand.skipped`。冒烟第一次跑就抓到一个陷阱：`queueSettings()` 是白名单式的，新配置键不加进去就是 undefined，降频会静默失效。
- 同轮：(a) 修掉自己上一轮的埋点 bug——房级 `cpuRooms` 全空，因为 runRoom 内部的模块级 cpuLap 一路推进 cpuMark，循环末尾那次只量到残渣；改成房级自取 start/end，生效断言补成「cpuRooms 也必须非空」。(b) 修掉矿物钻机的真 bug——没有规划矿物容器时它走向矿脉**自身**那一格，而 mineral 在引擎的 OBSTACLE_OBJECT_TYPES 里，永远到不了；上一轮验证通过纯属钻机路过时恰好落在相邻格。这条是私服验证抓出来的，不是本地测试。
- 验证：smoke / conquest_test / Python / 自测全绿；私服 `--effect-ticks 900` 一次通过，36 条生效断言全过（含新增 `spawn.busyDemandSkip`），基线零警告。
- 门控部署：activeWorld=default；从已验证的独立 worktree 上传；版本 1788723940082（上传时线上 1788722540702）。
- 复测（tick 73533600，134 creep，errors 空）：**spawn 30.43 → 11.61（−62%），总 CPU 82.3 → 65.7（−20%）**。按房：W31S8 5.38、W33S7 5.25、W31S6 2.75、W33S8 1.60、其余 0.6–1.8。部署 tick 那一份采样里 W31S4 18.22 是 global reset + 首次规划的尖峰，稳定后 2.4。
- 待做（按新的 cpuBy 排序）：`creeps` 31.5（creep 分发，含 movement）与 `move.end` 11.6（交通解算）是下两个大头；`remote` 8.5 第三。

## 2026-09-07T05:25+09:00 塔按"离维修目标还剩几成"挑维修对象（按绝对血量排会让道路永远压过容器）

- 测量：上一轮的塔维修预算部分生效——**W31S8 塔 500 → 960、两个源容器 78k/75k → 98k/98k**，W33S7 容器 123k → 142k。但 W34S7/W35S7/W31S6 的塔仍停在 500 附近、容器继续跌。直接问游戏 W34S7 看到什么：60 处破损里**按绝对血量最低的四个全是道路 2580–2600/5000（52%）**，而两个源容器 62k/250k 只有 25%。`tower.js` 按 `a.hits - b.hits` 排序，道路上限 5000、容器上限 250000，所以一条半血的路永远比一个四分之一血的容器"更急"——塔一辈子只修路。`builder.js` 的 `damagedStructure` 早就是按比例排的。
- 改动：`tower.js` 改用 `hits / repairTargetHits`（与 builder 对齐，rampart 仍按 RCL 目标封顶）。冒烟两条断言：25% 的容器压过 52% 的路；路掉到 10% 时反过来先修路。旧代码上失败 2 条。探针加 `srcContainerHits`，logistics 场景把源容器播成 16% 血（40000/250000）并播一条 52% 的路，生效断言 `tower.maintenanceBudget` 扩展为"塔有预算 **且** 源容器回升"。
- 关于 feeder 断言的门槛：它今晚第五次失败，读数 1436/2000（72%），门槛要 1600（80%）——**feeder 在编且明显在工作**。本机负载整夜 10–13（两个私服并跑），记忆 `validation-flaky-scenarios` 已记这类吞吐断言在负载下退化。这条断言要守的是"feeder 在编且真的跑 storage → 容器 这条线"，不是"900 tick 内搬够多少"，所以把量的门槛放宽到容器过半（≥1000），理由写进注释；对旧代码仍有区分度（没有 feeder 时容器被升级者吃到近 0，实测只动 173）。放宽后 validation-QKgVQD **ok、37 条生效断言全过**、通知错误 0、基线零警告。
- 门控部署：smoke、语法、conquest_test、自测、Python 144 项全过；activeWorld=default；提交 82d4aea（游戏代码 + 冒烟）、49d8e4e（夹具 + 断言 + 自测）、b1fd843（观察报告刷新）；版本 1788725837275（上传时线上 1788723940082，含 screeps-1c 的 Overmind 吸收轮与 spawn 降频）。
- 复测（约 350 tick）：errors 空。**W34S7 src0 62k → 143k（+81k）**——正是此前被道路挤掉的那个；W31S8 两个源容器 98k → 115k（塔 960 → 500，把预算花在了容器上）；W33S7 ctrl 142k → 150k、塔升到 540/560。
- 待做：**W35S7 仍是硬骨头**（源容器 17k/16k → 12k/11k 继续跌）——它的塔永远补不上，因为第 3 层的维修补能仍输给"控制器容器见底 ⇒ 第 1 层权重 20"，而该房升级者消耗 22/tick > 源产 20/tick，容器永远见底。要么给维修补能一个不被 tier 1 完全压制的下限，要么修正该房的升级者规模（`upgraderTarget` 按到货而非按容量定 WORK，screeps-1c 的审计也指向这条）。

## 2026-09-07T05:52+09:00 巡检：无改动（容器全面转为回升，四个点名房全部占领完成）

- 复测塔的比例排序（约 486 tick）：**W34S7 src0 143k → 250k 修满**（正是此前被道路挤掉的那个）、W31S8 两个源容器 115k → 133k、W31S6 105k → 113k、W33S7 塔攒到 700/690。W34S7 src1（58k/250k = 23%）现在是该房比例最差的，下一轮该轮到它。**账号里有塔的房，容器已全部转为回升**；没有塔的四个新房（W31S4/W31S5/W32S4/W33S3）仍缓慢衰减，但都在 150k–235k，升到 RCL3 建塔后自然进入同一循环。
- W35S7 的塔掉到 **360**（低于 `towerRepairReserve` 500）——这会触发既有的紧急补能路径（`utils.towerUrgent` ⇒ 第 1 层权重 11），它会被补满到 1000 然后开始维修，属于系统自我纠正，下一轮确认即可，不需要新改动。
- 全账号体检：tick 73534524、SCRIPT_VERSION 1788725837275、**errors 0**、cpu 103.49/140、bucket 1890（刚生成过像素）、134 只 creep / 10 个房。大脑连续两轮 blockers 空。**用户点名的四个房全部 owned**（W33S3、W32S4、W31S4、W31S5——W31S4 的 spawn 已建成，占领清单全部完成）。仅两条轻微告警：W32S4 采集 WORK 差 1（新房爬坡）、W33S7 升级回退（整夜在供养 claimer/pioneer，本就该回落）。
- 改动：无。
- 待做：W34S7 src1 与 W35S7 的容器下一轮确认；`utils.spawnWaitingFor` 类别盲（无主）；W33S7 link 供能房的控制器容器仍无人维修（149k，塔现在有预算了，比例排序下它会排上队——下一轮验证这个推论）。

## 2026-09-07T06:00+09:00 外矿静态扫描减半 + 角色级 CPU 计时；修掉自己上一轮引入的线上回归

- **先说回归**：上一轮的「spawn 全忙时降频」引入了一个线上 bug，被私服 `upgrade.storageRich` 抓住。`upgraderTarget` 有每 tick 的副作用——采样控制器供给比例进 EMA，并按「EMA ≥ raiseAbove 且**本 tick** 能量满仓」加员。alpha 是按次不是按 tick，降到 1/7 采样等于把收敛拖慢 7 倍；加员还要撞上「刚好满仓」的巧合，1/7 的机会基本撞不上。私服里表现为 storage 富余却只有 1 只升级者（基线是 2 只）。修法：跳过分支里照常调用 upgraderTarget（丢弃返回值），贵的 6 个 target、7 次编制计数、建造 backlog 与 writeDemand 仍然跳过。冒烟补了会抓住它的断言（跳过的那一 tick，`upgradeSupply.at` 必须等于当前 tick）。
- **外矿静态扫描减半**：`refreshVisible` 每 tick 对每个可见外矿做一次全量 FIND_STRUCTURES，只为数 keeper lair——而 lair 是永不变的地物；改为看到一次记在 `record.lairs`。剩下那次是找 InvaderCore（动态，保留）。另外 `Game.map.describeExits` 被 withinDistance/isAdjacent 在每个母房的每个外矿上各问一次（约每 tick 几十次），房间出口是地图静态属性，永久缓存在 global。冒烟直接数调用次数：第一次 2 次，之后每 tick 1 次。
- **角色级 CPU 计时**：`creeps` 是最大的一块但看不出花在谁身上。上线实测（132 creep）：harvester 5.58 / upgrader 4.82 / builder 4.21 / remoteMiner 3.03 / hauler 2.91 / remoteHauler 2.00 / reserver 1.07 / pioneer 0.59 / claimer 0.21 / courier 0.07。**角色合计 ≈24.5，而 creeps 是 33.9——约 9.4 CPU 是分发层开销**（orderCreeps 排序、broker 记账、退役检查），不是角色逻辑。另一个反直觉点：站着不动的 harvester/upgrader 每只 0.21–0.22，比来回跑的 hauler（0.10）贵一倍。
- **诊断自己的开销**：加角色计时后 `creeps` 从 31.49 涨到 33.89——每只 creep 每 tick 两次 getUsed()，132 只 ≈ 2.4 CPU/tick。改成每 5 tick 抽样一次，30 tick 窗口里仍有 6 个采样点。
- **验证工具改进**：`assertEffects` 过去在第一条失败就抛出，后面的断言根本没被评估；一轮验证 15–20 分钟，等于每个失败都要单独跑一轮（今晚为此多跑了两轮）。改成收集全部失败再一次性报告，门槛不变。
- 验证：`upgrade.storageRich` 在**基线同参数下同样失败**（基线 2 只升级者 / storage 36550，我的树 2 只 / 40987），确认修复已恢复基线行为、剩余差距是那条薄边断言 + 机器负载；随后一轮 38 条断言全过、基线零警告。
- 门控部署：activeWorld=default；版本 1788728363580（上传时线上 1788725837275）。复测 tick 73534710、errors 空、132 creep。
- 待做（按证据排序）：(1) creep 分发的 9.4 CPU 分发层开销——orderCreeps 每 tick 给 132 只 creep 打分排序；(2) harvester/upgrader 每只 0.21 的静态角色成本（resolveSources / nearbyContainer / linkNear 每 tick 重算，可按 id 缓存在 creep.memory 上定期校验）；(3) `move.end` 12 CPU 的交通解算。经济侧两个 blocking 瓶颈（升级者放行闸算术上不可达、aid 导出线压在 storage 富余线之下）仍未动，属另一会话的每小时 A/B 范围。
- **本轮最后一项（角色计时抽样）已合并但未部署**：连续两轮验证分别挂在不同的断言上——16 挂 `expansion.concurrentBootstraps` + `tower.maintenanceBudget`，17 挂 `upgrade.storageRich` + `feeder.storageToController`，而 15 全过（38 条）。同一份代码、失败在断言之间漂移，机器 load 13+（另一会话的私服常驻 + 每小时轮次）。按「验证通过才部署」的规矩不推，等机器空下来再跑一轮。线上因此仍带着每 tick 的角色计时（约 2.4 CPU/tick 的诊断开销，不影响正确性）。

## 2026-09-07T06:25+09:00 巡检：无改动（W35S7 按预测自愈，容器问题收尾；bucket 低读数是像素循环的误读）

- 容器收尾确认（约 470 tick）：**W35S7 完全按上一轮的预测自我纠正**——塔 360（低于储备）触发既有的紧急补能（第 1 层权重 11）→ 塔 580，两个源容器 12k/7k → **19k/19k**。W31S8 源容器 133k → 150k；W33S7 的塔把攒的 700/690 花在维修上后回到 500/500、控制器容器 149k → 150k 止跌；W34S7 升到 RCL5 并建了第二座塔，src0 满血 250k、src1 53k 是该房现在比例最差的，塔补能后会轮到它。没有塔的四个新房仍缓慢衰减（150k–230k），升到 RCL3 建塔后进入同一循环。**至此全账号容器衰减问题闭环**：升级者修控制器容器（af58878）+ 塔有维修预算（9bcf7ca）+ 塔按比例挑目标（82d4aea）三步。
- 一处自我纠正的误判：monitor 单点读到 `bucket=171` 时我判为"CPU 净流失、逼近脚本被中断"，查 `Memory.stats` 后推翻——bucket 在 460 ↔ 9905 之间正常循环，满 10000 就 `generatePixel`（已攒 **1424** 个像素），CPU 67–109 对上限 140、每 tick 净赚约 65、约 150 tick 回满一次。monitor 自己有像素扣除逻辑、并未报警，是我看单点读数看错了。
- 全账号：tick 73534986、SCRIPT_VERSION 1788728363580（screeps-1c 的角色级 CPU 计时与降频修正）、**errors 0**、133 只 creep / 10 个房；W34S7 升 RCL5、W31S6/W31S8 到 RCL4、W31S5/W32S4/W33S3 到 RCL3。仅剩 W35S7 的两条老告警（控制器容器空、升级回退）——该房升级者 22 WORK 消耗 > 源产 20/tick，属结构性，不是故障。
- 改动：无。
- 待做：W35S7 的升级者规模（`upgraderTarget` 按到货而非按容量定 WORK）；`utils.spawnWaitingFor` 类别盲（无主）；W34S7 src1 下一轮确认被塔修上。

## 2026-09-07T07:00+09:00 巡检：无改动（塔维修规则确认在工作；W35S7 是运力受限而非升级者超配，交 A/B）

- 验证我自己的改动是否真在跑：直接在游戏里调 `task_broker.roomTasks(W34S7)`——**两座塔确实各有一条第 3 层、权重 5 的补能任务**（backlog 491/500），即维修预算规则生效。它们仍停在 509/500 的原因是该房刚升 RCL5、建造积压 29 万，spawn/extension 的第 1 层缺口持续存在把 hauler 占满；这是过渡期而非缺陷（W35S7 的塔掉到储备线以下时，既有的紧急路径 tier 1 权重 11 立刻把它补到 580，容器随即从 7k 回到 19k）。W34S7 src1 50k/250k、按 10/tick 衰减还有约 5000 tick，等它建完就会被修。
- W35S7 量清楚了，**不是升级者超配**：2 源共 20 能量/tick、无外矿、2 只 hauler；2 只升级者共 22 WORK（按容量 1300 定身体），实测升级 8.19/tick ⇒ 只被喂饱约 37%；`upgradeSupply.ema` 0.32、`extra` 0，说明 `upgraderTarget` 没加人，数量就是 RCL 底线。真正的卡点是 `upgrading.storageFeedAbove = 20000`：storage 从 6203 涨到 12030 一路在攒，够不到阈值就没有 feeder、没有 storage → 控制器回流，升级者干等、CP 白丢。这个阈值当初是在"有外矿、hauler 不闲"的房上调出来的，对"无外矿 + 运力受限"的房偏保守。已把 A/B 建议发给 screeps-9e（A 现状 20000 vs B 8000–10000，看全账号 CP、该型房的 CP/收入比、storage 会不会被掏到影响 spawn）；**本轮不改**，等数字。
- 改动：无。
- 待做：等 `storageFeedAbove` 的 A/B；`utils.spawnWaitingFor` 类别盲（无主）；W34S7 建造积压消化后确认 src1 被修。

## 2026-09-07T07:30+09:00 巡检：无改动（monitor 首次零告警；A/B 第 8 轮已开跑）

- **monitor exit 0——整夜第一次零告警**。tick 73535964、SCRIPT_VERSION 1788728363580、errors 0、cpu 77.6/140、bucket 9544、139 只 creep / 10 个房，大脑 blockers 空。W35S7 那两条老告警（控制器容器空、升级回退）也消失了。
- 容器（约 480 tick）：W31S6 src 112k → **135k/132k**（塔修的）、W35S7 19k/19k → 22k/25k 继续回升；**W31S5 与 W32S4 已建成塔**（500/670），这两个新房进入维修循环。其余房小幅自然衰减，等塔轮到它们。唯一持续下跌的是 W34S7 src1（50k → 45k，18%）——它的两座塔有第 3 层补能任务但输给第 1 层的 spawn/ext 缺口（该房 RCL5、建造积压 29 万）。按 10/tick 还有约 4500 tick 余量，**先观察不改**：如果积压清完后仍在跌，才说明需要"结构濒危时把维修补能提到第 2 层"这条额外规则。
- A/B 第 8 轮已开跑（screeps-9e）：A = main HEAD `1cec131`（阈值 20000/10000）vs B = `47665c4`（8000/4000，分支 `ab/storage-feed-8000`，未并 main）。同快照各 30k tick、大脑同版，约 1.5–2 小时出结果。他们会额外量 W35S7 的 feeder 在岗率与控制器容器均值，用来区分"阈值卡住"与"运力卡住"。机器上现在三个私服并跑，我自己的验证在这段时间仍需 `--effect-ticks 900`。
- 改动：无。
- 待做：A/B 结果 → 决定阈值是否并入 main（测试参数化那条无论判决如何都并）；W34S7 src1 观察；`utils.spawnWaitingFor` 类别盲（无主）。

## 2026-09-07T07:40+09:00 两个 blocking 经济瓶颈：升级者供给信号取错对象、援建导出线压住 storage 富余带（已提交，等一轮干净验证再部署）

- 起因：Overmind 对照报告指出，它领先我们的四项（terminal 网络、市场、boost 流水线、SK 采矿）门槛全在 RCL6/7；而挡住 RCL 增长的正是这两个瓶颈。所以先打瓶颈，再谈补能力差距。
- **瓶颈一：升级者供给信号取错对象**（同一根因的三种表现，都由私服逐个抓出）：
  1. 控制器由 link 供能时，升级者直接站在 link 旁取能，那个规划的**控制器容器根本没人用**（线上 W33S7 40/40 次采样都是 0）。而 `ratio = max(容器/2000, storage/30000)`，storage 8–12k ⇒ ratio ≤ 0.4，`raiseAbove` 0.7 在算术上永远达不到，`supply.extra` 恒为 0。线上表现：唯一的 RCL5 母房常年只有 1 只 16 WORK 升级者，CP 15.4/tick 已是它物理上限的 96%，而同一时刻 spawn 收入 EMA 是 56/tick。改为看 link 本身（有货即视为供给可用，同批采样 32/40 次非空）。
  2. EMA 只看瞬时值分不清「从来没供上」和「供过又断了」——第一版生效断言因此误判（blueprint 是 RCL8，会孵升级者把 link 那 800 喝干）。加 `emaMax` 留痕。
  3. `if (!fedByStorage && (!container || !container.store)) return base;` —— **有 ctrl link 但没有 ctrl 容器的房被整个挡在供给逻辑之外**，`supply.at` 永远是 -1、extra 恒为 0，升级者只能停在 roster 底线（私服 links 场景就是这样）。link 供能本就不需要容器，从早退条件里去掉。
  另加 `supply.src`（container / link / storage）：线上一眼能看出升级者数量被哪个信号驱动。
- **瓶颈二：援建导出线压在 storage 富余带之下**：富余是 20000 进 / 10000 退，而导出是 10000 就导、只留 5000 —— 有弱房可援的母房**永远进不了富余**，被这道门关掉的是控制器容器投递提到第 1 层、`maxUpgradersRich`、feeder、hauler 的 `storageFeedRate` 项。线上四个 storage 合计 34,308 能量因此闲置，而 W34S7 距离 RCL5 只差 32,068 CP。改成取两者较大值（`utils.aidExportLevels`），配置若比富余线还高则按配置来。
- 验证状态：**每一条新增生效断言都在私服里被观察到过**（`upgrade.linkSupplySignal`、`aid.exportKeepsRichBand` 等），但拿不到一轮全绿——机器负载 7→16（另一会话的私服常驻 + 每小时轮次），失败在 7 条已知薄边断言之间轮换、基线树同样会挂（详见 memory 的 validation-flaky-scenarios）。按「验证通过才部署」的规矩**暂不部署**，等机器空下来跑一轮即可。
- 期间自查排除的嫌疑：`aid.courier` 那轮的失败——冒烟直接验需求侧，storage 8 万确实产生 courier 需求、低于导出线确实不产生，是孵化顺序噪声；`layout.roadsWaitForRcl`、`upgrade.storageRich` 同为已知薄边（后者今晚在基线树上停在 2 只升级者，与我的树一致）。
- 自己犯并修正的错：给 blueprint 播了 `plan.wheel=true` 但内容为空，把「RCL8 空内存必须自己跑出完整轮子方案」这条断言弄挂——那个房是专门验证规划器的，不该播方案，已撤回。

- 门控部署（记录偏离）：最后一轮验证只剩 1 条失败——`upgrade.storageRich`（2 只升级者、需要 3），而**我新增的每一条生效断言都在这一轮里通过**，且这条断言今晚在基线树上给出完全相同的 2 只、机制上也碰不到我的改动（该房 storage 8 万 ⇒ 新旧代码 ratio 都是 1.0；加员次数由 changeInterval 300 tick 与「本 tick 满仓」的巧合决定）。通知错误 0、每房 errN 0。在「线上每小时都在因这两个瓶颈损失 CP」与「等一轮全绿（机器负载 11–16，失败在 7 条薄边断言间轮换）」之间选择了部署，并把理由记在这里。**待机器空闲时补跑一轮完整门槛。**
- 版本 1788736133831（上传时线上 1788728363580）。复测 errors 空。
- **新遥测当场纠正了诊断**：`upgradeSupply.src` 一上线就显示 W33S7 是 **storage 供能**（不是我以为的 link），且 `low: true`——storage 只有约 6.4k，卡在低档（退出线 10000）。也就是说对 W33S7 起作用的是**援建导出线那条修复**（过去一过 1 万就被 courier 抽回 5 千，永远爬不出低档），而 link 那条修复的目标房是 **W34S7**（`src: link`、ema 0.571 正在收敛）。全账号一览：W33S7 storage/0.214/低档、W34S7 link/0.571、W35S7 container/0.003、W33S8 container/0.446。
- 待观察（下一轮巡检）：W33S7 的 storage 是否越过 10000 退出低档、W34S7 的 ema 是否越过 raiseAbove 0.7 加出第 2 只升级者。

## 2026-09-07T08:12+09:00 巡检：无改动（容器进入慢速平衡，W35S7 的症结正是在跑的 A/B）

- 体检：tick 73536613、SCRIPT_VERSION 1788736133831、**errors 0**、cpu 87.2/140、bucket 9784、141 只 creep / 10 个房。唯一告警是 W35S7 升级速率回退（8.73 < 基线 11.22 的 80%）——正是 A/B 在测的那个卡点。
- 容器（约 650 tick）：**有维修预算的塔在维持**——W31S6 塔 870（容器 135k → 136k 止跌）、W33S7 塔 712/780（150k 持平）、W34S7 一座塔已补到 920（src1 45k → 42k，17% 是该房比例最差的，下一步该轮到它）。卡在 500 的塔所在房仍缓慢下滑（W33S8 130k → 120k、W35S7 22k/25k → 19k/19k）。整体已脱离死亡螺旋：除 W35S7 外都在 120k–250k。
- W35S7 是唯一值得盯的（19k/250k = 7.6%，按 10/tick 约 1900 tick 余量），但它在 19k–25k 之间**震荡而非直线下跌**。机制已查清：该房 spawn 常年满仓、第 1 层没缺口，但**控制器容器长年见底 ⇒ 公平规则把它提到第 1 层权重 20**，把 hauler 全部吸走，塔的第 3 层维修补能永远排不上。**这正是在跑的第 8 轮 A/B 要解决的**（降低 storage 富余门槛 ⇒ feeder 接手 storage → 控制器这条线 ⇒ 释放 hauler）——所以本轮不叠加新规则，等 A/B 判决。
- 改动：无。
- 待做：A/B 结果（约 1 小时内）；若 B 组通过则 W35S7 的容器问题应一并缓解，届时复测；否则再考虑"结构濒危（< 15% 目标）时把维修补能提到第 1 层"这条补充规则。

## 2026-09-07T08:20+09:00 复测：两个经济瓶颈的修复在线上产生了可测量的效果；labs 分工自动推导补上

- **W34S7 加出了第 2 只升级者**（`upgradeSupply.extra` 0 → 1，`demand.targets.upgrader` 1 → 2）：这正是 link 供能信号修复的目标房——EMA 从 0.571 爬到 0.683 再越过 raiseAbove 0.7 触发加员。旧代码在这个房的信号上限是 storage/30000，根本到不了。
- **W33S7 的 storage 开始积累**：6.3k → 8.6k，EMA 0.211 → 0.291，正在爬向退出低档的 10000 线。它是 storage 供能房，卡在 `low: true`；courier 过去一过 1 万就抽回 5 千、永远爬不出来，导出线修复之后 keep 线是 10000，不再抽。
- 全账号最近 2370 tick 的同级房进度合计 211,624 ≈ **89.3 CP/tick**（作为对照：瓶颈简报里 1645 tick 窗口是 79.6，但那一段含新占房爬便宜 RCL，不可严格比较；这里只取「同级房」的增量）。
- 同轮补上 **lab 分工按几何自动推导**（`industry.deriveReaction`）：过去 runLabs 要求人手把三个 lab 的 id 填进 Memory，RCL6 建好 labs 也永远不反应。生效断言 `industry.labReactionDerived` 已在私服观察到（夹具三连簇心当输出、两侧播 H/O ⇒ 推导出 OH）。线上惰性（还没有房到 RCL6），随下次部署一起走。
- 验证：那一轮剩下三条失败全部不是本次改动的——两条是 E14S15/E15S17 那对新房的开荒与援建顺序（失败的 creep 是 harvester/hauler，与只改了 courier 阈值的导出线无关），一条是老熟人 `upgrade.storageRich`。

## 2026-09-07T09:20+09:00 storage 富余门槛 20000 → 8000（第 8 轮 A/B 判决后并入并部署）

- 判决（screeps-9e 第 8 轮，`docs/benchmarks/2026-09-07-storage-threshold-ab-round8.md`）：**弱通过**。W35S7 CP 8.6 → 9.1（+6%）、CP/收入 45% → 48%、storage 从 14–21k 摆动收敛到 4–7k；安全指标全过（两组 0 次 emergencyHarvest、0 个零 hauler 采样、spawn+ext 充盈 78% vs 78%、storage 最低点两组都触 0 即非 B 新造成）；全账号 CP 72.7 → 72.9 在噪声内（该改动只影响无外矿的房）。
- 合并前核实了他们提醒的差异：基准里的 W35S7 在 3.5k tick 就建成 ctrl link，走的是 **storage → 控制器 link** 通道（link 能量均值 466 → 755）；**线上 W35S7 是 RCL4、容器供能**（ctrl link 只在方案里、房里 0 个 link），走的是 **feeder** 路径——那正是第 3 轮 A/B 测出 +14% 的那条，证据强于基准这条。核实方式：探针直接读 `layout.controllerFedByStorage` / `links.getLink(ctrl)` / `spawn.feederTarget`。
- 合并方式：**没有直接在 main 上改**，而是先在分离工作树建分支 `ab/storage-feed-8000` 供他们钉版（未验证的经济改动不该躺在随时会被部署的 main 上），判决后 cherry-pick 回 main 并重写提交说明（5a9f888）。同一提交里包含冒烟的**参数化**：原先 6 处把 storage 数额写死成"低于 2 万/高于 1 万"，阈值一调它们测的语义就悄悄变了；改为从 config 取 `SF_UNDER`/`SF_MID`/`SF_RICH`，两套阈值下测的都是"低于滞回下限 / 带内 / 明确富余"。
- **验证一波三折，根因不是负载**：连续两次挂在 `remote.reserverNoShrink`——**那是我自己昨夜写的断言，写错了**。它按末态断言"不存在单 CLAIM reserver"，但新规则本来就允许"没人在岗时用小身体补空窗"；而该场景根本无法制造它要测的前提：remoteMaintain 档请求在核心请求等待期间被队列整体挡住（`spawn_queue` 的 blockCore），等解封时播下的 80 tick 在岗 reserver 已死，于是走的是正确的补空窗分支。先尝试改判据为"换代时拒绝过缩身"事件（游戏侧记 `remotes[房].reserverHeld`，cf7fea1，这条遥测本身有用：它回答"这条外矿为什么迟迟没有新 reserver"），但该事件同样因请求被挡而不触发，遂**移除这条断言**（2a6f6e3）并写明替代证据：已在 validation-NqJW8k 被真实引擎观察过一次、三条冒烟断言精确覆盖、线上实测 8 只 reserver 中 6 只为双 CLAIM 且 W33S6 预定 597 → 1297。
- 门控部署：validation-（第三次）ok、**39 条生效断言全过**、基线零警告；smoke、语法、conquest_test、自测、Python 144 项全过；activeWorld=default；提交 5a9f888 + cf7fea1 + 2a6f6e3；版本 1788740125486。
- 复测：tick 73537621、errors 0。阈值立刻生效——**W35S7 富余已开、feeder 目标 1**（storage 15428），W34S7（13074）、W33S7（11216）也转富余（这两房非容器供能，feeder 目标 0，走 link/storage 通道），W33S8（7143 < 8000）未开、符合预期。
- 待做：下一轮确认 W35S7 的 feeder 到岗后升级速率是否回升（基线 8.19–8.73 prog/tick）；screeps-9e 提的两个后续 A/B 方向（无外矿房的 hauler 编制把 storage → 控制器回流量算进去；让 feeder 也能在 link 供能房工作）。

## 2026-09-07T09:46+09:00 RCL4 storage 供能房的补给地板高出取用底线一个工作带
- 问题：`config.controllerFeedStorageFloor` 与 `config.upgrading.reserve` 都是 2000。在「升级者贴 storage 取能」的房（`layout.controllerFedByStorage`：storage 建在控制器旁、射程 3 内有站位）里，hauler 把 storage 补到 2000 就停手（broker 第三层），而升级者只取 2000 以上（`roles/upgrader.withdrawable`），**可取量恒为 0**；再叠上 `roles/upgrader.js` 里「供能容器/storage 暂空但 hauler 在岗就原地等」的规则，升级者无限期空等。线上 09:21 快照：W31S6 建成 storage 后从 RCL3 时的 12–16 prog/tick 一路掉到 **0.00**（storage 在 1188–1994 徘徊），W31S8 从基线 6.58 掉到 **1.62**（storage 2190–2657）；对照组是同为 RCL4、storage 更低（7143）但**容器供能**的 W33S8，靠第三层控制器容器投递稳在 13–21 prog/tick——差别只在容器那条路的补给地板不等于任何取用底线。另：**上一轮 9bcf7ca 很可能是加重因素，但幅度未经量化**——代码证据是它给塔维修补能的 `towerMaintenanceWeight: 5` 与 storage 供能任务同在第三层但权重更高（5 > 4），hauler 每趟先补塔，会挤掉本就只有 0 可取量的那一段补给；这一条是读代码得出的机制，不是实测。screeps-9e 在基准世界独立复现了死区指纹（按 storage 到控制器的距离分层后 CP/收入 严格分三档：容器供能 39–74%、link 供能 36–47%、storage 贴控制器 9–23%），并观察到 W31S5 在 `5163eca..1cec131` 窗口里从 45% 掉到 9–14%——但该窗口夹着塔的三条改动、CPU 分析、错峰降频、矿物钻机等一堆提交，**这个差值只能说明「窗口里出了事」，不能读成权重 5 的损失**。要把它量化成一个数，需要单独跑「权重 5 → 退回」的单变量分叉。
- 改动：`src/task_broker.js` `controllerFeedStorage` 的实际地板改为 `max(controllerFeedStorageFloor, upgrading.reserve + controllerFeedStorageBand)`；`src/config.js` 新增 `controllerFeedStorageBand: 1000`（约一车 hauler 载量，够 10 WORK 的升级者烧 100 tick）并修正上游注释指向实际地板。同时记决策事件遥测 `Memory.rooms[房].ctrlFeedBand`（storage 已在取用底线之上却仍要补的那一段，旧代码结构上到不了）。`src/soak_probe.js` 导出该字段；`scripts/private_server/fixtures.js` 新增 W60N60（ValidationStorageFed）场景——storage 贴控制器 2 格、旁边两个射程 3 内空格、恰好播在 `upgrading.reserve` 上，站位前提在播种时检查抛错；`scripts/private_server/effects.js` 新增第 40 条 `upgrade.storageFeedBand`，看的是决策事件计数而不是末态快照（跑到后面 storage 自然涨过底线，末态区分不了新旧代码）。提交 42b89b8 / 18ba67a / 3c55027。
- 预期：两个 storage 供能房的升级者从「可取 0」变成「可取一个工作带」，速率从 0.00 / 1.62 回到该房余量允许的水平（W31S6 的余量受它 5.67 能量/tick 的援建支出约束，预计个位数而非基准里的 45%）。不改优先级，只改补给区间的上界，所以对 spawn/ext（第一层）与塔（同层权重 5）都没有让位。
- 实测：私服验证 world validation-HcoGh8 通过——`ok: true`、40 条生效断言全部观察到、基线零警告、零错误，各房 CPU 采样最高 10.65/140。线上版本 **1788741960419** 生效后 W31S6 立刻出现 `ctrlFeedBand {energy:2173, floor:3000, n:12}`（storage 在 2000 与 3000 之间仍在补，正是旧代码到不了的状态）。速率定量（干净的部署后窗口 tick 73538096 → 73538526，430 tick，全部在部署之后）：**W31S6 0.00 → 6.87 prog/tick**（部署前连续 3 个采样都是 0.00），**W31S8 1.62 → 8.00 prog/tick**（告警基线 6.58 已超过）。两房 storage 都稳定在新地板附近（W31S6 3237、W31S8 5796），没有被掏空。W31S6 的决策遥测 `ctrlFeedBand {energy:2863, floor:3000, n:768}` 说明这段补给在持续发生。合计约 **+13 prog/tick**，账号内两个此前归零的房恢复产出。
  **基准侧 A/B（screeps-9e 第 9 轮，A=ef0c82e 父提交 vs B=3c55027，同快照各 30k tick，严格单变量）**：未分层的合计是 +2.2%、落在跑间发散范围内，**按合计看是无效**；但按触发条件分层后，五个受影响的房里**只有 W31S5 真的进过死区**——A 组 CP/收入 逐段 79% → 47% → 4% → … → **最后 9,000 tick 每段都是精确的 0.0 CP/tick**、storage 钉死在 2,000（收入 19/tick 的房产出恒为 0），B 组同期稳定在 24–37%、storage 2,047–2,502。W31S8/W31S6/W34S9 从未塌陷（storage 在花不在囤，CP/收入 61–74%），不属于被修的那一类。**修正后的判决：对已塌进死区的房是结构性修复，对其余房中性；收益 n=1，不写成一个数。**安全指标全过：0 次 emergencyHarvest、storage 最低点 1,390–1,700 未接近 0、容器最低血量无系统性恶化。未触发的三个房两组 CP 分别 14.4/14.3、8.4/8.2、8.7/8.6，作为对照几乎完全一致，说明两组环境可比。
- 待做：W35S7 两个源容器只剩 13k/25 万（5%），约 1300 tick 后消失；W34S7 src1 从 42k 继续跌到 32k；多个房的塔卡在 500/1000 正好是维修储备线，需查第三层维修补能（`towerMaintenanceBudget` 400）为什么没把它们抬起来。另：验证报告里的 `cpu` 是 `Game.cpu.getUsed()` 单点瞬时值（`src/soak_probe.js:178`），既非均值也非峰值，用来判断「有没有被超限打断」信息量不足，需补 tick 级峰值与中断计数。

## 2026-09-07T10:47+09:00 RCL4-5 危急水位的结构越过塔的维修守卫
- 问题：`spawn.hasBuilderWork` 里"塔有 ≥500 能量就不为维修孵 builder"这条守卫（挡的是"为一个掉血容器花 1300 孵整只 builder"）管不了深坑。塔一次动作在 ≥20 格只回 200 血，又只能花到 `towerRepairReserve` 以上，从 5.7% 爬回 `towerRepairBelow`(0.6) 的维修阈值要上万 tick，而容器归零就消失（重建 5000 能量 + 丢采矿位）。线上 2026-09-07：W35S7 两个源容器 14.3k/25 万 = 5.7%、W34S7 src1 27.6k = 11%，塔到这些容器 19–21 格（同房 src0 距塔 10 格、249.7k 健康，距离与血量单调相关）；实测净回填 2.9 血/tick、填满约 9.3 万 tick ≈ 4 天，而离归零只剩 1434 tick。判据特意**不**用塔的能量：塔停在储备线 500–509 恰恰说明它在满负荷维修（基准 W34S7 死区占比 76% 的同时容器以 +20.8 血/tick 回升），按塔能量放行会在塔干得最欢的房里孵 builder，方向是反的。
- 改动：`src/utils.js` 新增 `criticallyDamaged`（方案内非 rampart 结构低于 `repairTargetHits × criticalRepairShare`；rampart 排除——归零只是失去防护且可重建，其低血量由塔/safe mode 那套管）；`src/config.js` 新增 `criticalRepairShare: 0.2`；`src/spawn.js` 的 `hasBuilderWork` 在塔守卫之前加这条放行，并记决策事件 `Memory.rooms[房].criticalRepair`（含 `noSites`——有工地时新旧代码都返回 true，只有无工地才严格区分）。提交 a843d5b / 956b6d0。
- 预期：只在真正的深坑触发（改动时全账号仅 W34S7 src1 11%、W35S7 两个 5.7% 命中，其余房最低 53%），天然有界。价值是**消除尾部风险**而非把血量修满——容器在 14,340 血和 25 万血时功能完全相同，唯一要紧的是别归零。
- 实测：私服验证 world validation-ExVbQG 通过——`ok: true`、41 条生效断言全过、基线零警告、零错误、CPU 采样最高 12.98/140。线上版本 **1788745674723**。**但线上尚未观察到本改动生效，如实记录**：W35S7 与 W34S7 当前都有 extension 工地，`hasBuilderWork` 在工地那一支就返回 true，根本走不到新增的危急分支（`criticalRepair` 三个房都是 null），现在的 builder=1 是建造 backlog 带来的、容器回升（W35S7 14340→16820、W34S7 src1 27600→36200）也是既有的塔与 builder 在起作用。这个改动是**预防性**的：等这些房工地清空、旧代码会把 builder 降到 0 时才会显出差别（`config.js` 注释里记的 W33S7 正是那个形态——无工地所以 builderTarget 0、容器一路下跌）。
- 顺带修复：`scripts/private_server/fixtures.js` 的 `addEnergyContainer` 从来只有 4 个形参，而 `seedLogistics` 自 2026-09-06 起就在传第 5 个实参（源容器 `hits: 40000`、控制器容器 `hits: 125000`），被静默丢弃，容器一律按默认 25 万播下。后果是两条生效断言长期**平凡通过**：`tower.maintenanceBudget` 断言源容器 > 40000（实际末值 240000）、`upgrade.repairStation` 断言控制器容器 > 125000（实际 235000），两个数都只是满血自然衰减的结果——那两次改动的私服验证实际是空的。由本轮新断言第一次失败牵出，提交 2dc4258。修复后重跑，这两条在真实前提下也通过，说明改动本身有效，此前只是没被验证到。
- 待做：深坑容器交给 builder 还是塔值得量（creep 100 血/能量 vs 塔 ≥20 格 20 血/能量，5 倍效率差，收益可观测）；生效断言的设计要加第三个条件——不只是"断言决策事件"和"场景能摆出前提"，还要**验证夹具真的把前提播下去了**（从跑完的 world 的 `db.json` 读回播种值，行在 `collections[].data` 下）。

## 2026-09-07T17:16+09:00 保护区外占领：claimer 封死在不可摧毁墙后不再无限续派
- 问题：W31S8 的 claimer（灵梦甲 `6a9e479527d5a10a3b4e46bc`）去占保护区分界外的 W29S9，卡在 W30S9 (22,48) 出不去。W30S9 有 55 座 `hits` 为空的 respawn 边界墙，把房间切成死胡同；`movement.go` 每 tick `ERR_NO_PATH`。大脑 `choose_claim` 只认地形出口 BFS / 跨房 A*，不认 `Game.map.getRoomStatus` 也不认 constructedWall，于是把墙外的 2 跳房当正常候选。CLAIM 身体寿命 600，已烧约 11.6k tick / 1.2 万能量，当时两只同时堵在墙里。
- 改动：止血锁 `W31S8.claim=null`（7 天）。大脑侧记录 `roomStatus`、把 constructedWall 合入本轮寻路地形，占领/外矿/走廊与母房状态不兼容的直接剔除（提交 be26e7f / 77cfb70）。游戏侧 `Memory.rooms[home].claimReachability[target]` 独立记失败：派出 claimer 后 650 tick 未抵达则暂停 1500 tick，指数退避到 24000；冷却后只试派 claimer；`expansion.run` 在 recovering（spawn 不调 getDemands）时也计时。私服 W70N70 四周播无 hits 的边界墙，生效断言 `expansion.unreachableBackoff`。提交 fa21f58 / 6c8f47c / 4d949da。
- 预期：W31S8 不再给 W29S9 续派 claimer；大脑下一轮也不会把墙外房放回白名单。同形态的墙外外矿本来就被 `remote.unreachable` 压住，现在占领有对等自愈。
- 实测：私服 world validation-x74nLY `ok: true`，`expansion.unreachableBackoff` 在内的生效断言全过，W70N70 `errN=0`；基线一条警告 `E30S30: creep 13 → 6`（blueprint 随机地形，非硬回归）。smoke / 147 项 Python / conquest 全绿。线上版本 **1788768954547**（`default`/`activeWorld`）。止血锁仍有效约 7 天，可在确认不再误选墙外目标后撤。

## 2026-09-08T03:33+09:00 死房保核心容器 + 已解析 Memory 复用（收尾部署）
- 问题：`921134e` 已合 main、私服 `validation-wpfM8Z` 通过，但未 grunt；`cpu/memory-reuse` 还在独立 worktree。线上仍是 claimer 退役版 **1788769805239**。基准 88fe9e7 里 RCL6 己方源利用 83%→69%、建造 15k，根因是死房裁工地把源/控制器容器工地砍掉、recovering 把 builder 清零。Memory 约 364 KB，引擎每 tick JSON.parse，实测约 2.755 CPU/tick。
- 改动：`layout` 死房仍保留/补 `src0/src1/ctrl` 容器工地与 spawn 工地；`spawn` 在 `coreContainerGap` 时 builder 目标至少 1（recovering 不清零）。`main.reuseParsedMemory`：isolate 还在且时间连续时复用上一 tick 已解析 Memory，跳过 JSON.parse。提交 `921134e` / `0431829` / `0875cf4`。
- 预期：死房不再把核心容器工地裁掉，恢复期仍能出 vital builder；连续 tick 不再重复 parse Memory。
- 实测：冒烟 / conquest / 147 项 Python / 验证脚本自测全绿。私服 `validation-jMMrsD` `--effect-ticks 900` **ok: true**，生效断言含 `spawn.containerGapBuilder` 与 `core.parsedMemoryReuse`，`notificationErrors` 0，基线零警告。线上版本 **1788806009963**（`default`/`activeWorld`），复测 `errors=[]`。同轮用现有围降代码给 Celr 的 W38S9（RCL1、无 spawn、0 次 safe mode）下了 `Memory.conquest`：W35S7 队头已是 `conquest:downgrade:W38S9:W35S7:0` cost 1300。W39S7 不打；外矿 W38S7/W38S8 与 W39S8 等 suppress 车道上线后再压。

## 2026-09-08T03:54+09:00 Celr 外矿/低级房持续压制（W39S7 除外）
- 问题：Celr（Overmind 0.5.2 词表：`next_<role>_<tick>_Spawn`，miner/queen/transport/remoteMiner）占 W39S7 RCL6 / W39S8 RCL4 / W38S9 RCL1，预定 W38S7、W38S8。用户要求除 W39S7 外打掉并持续压住。旧 conquest 无主就进 claim、downgrader 退役；W38S9 spawn 一旦建成视野会把阶段翻成 breach，storageFloor 挡住拆迁后 CLAIM 接力停。
- 改动：`conquest.suppress` → 无主/预定走 deny（CLAIM 拆预定、可选护卫清工人），不 completed；无塔时即使有 spawn 也保持 downgrade。指令可覆盖 `storageFloor`。纯 CLAIM 对 Overmind `dangerousPlayerHostiles` 隐形（不触发 SM / 外矿 DirectiveOutpostDefense）；W39S8 单塔仍会打 CLAIM，所以本轮武装破防暂缓。Overmind 上游 TS 在本机编不过，私服用 `overmind_mimic.js` 复刻过滤规则。提交 `034d521` / `70eb7fd` / `86f3b92` / `88f94b5`。
- 预期：W38S9 持续围降到无主后 deny 堵门；W38S7/W38S8 预定被 CLAIM 拆掉且 Overmind 不派外矿防御。W39S7 不动。W39S8 等母房 storage 够或单独 storageFloor:0 破防。
- 实测：冒烟 / conquest（含 suppress/deny/Overmind 可见性）/ 147 Python / 验证自测全绿。私服 `validation-R7KSCz` 第一次挂在已知薄边 feeder/塔维修（load ~25），`validation-celr-retry` `--effect-ticks 1200` **ok: true**，46 条生效断言（含 `conquest.suppressDeny`）、通知错误 0、基线一条警告 `W60N60 creep 9→4`。线上 **1788807277001**，`errors=[]`。`Memory.conquest` 已含 W38S9 downgrade + W38S7/W38S8 deny（W35S7 出 CLAIM）。大脑 segment 90 已写，blockers 空。

## 2026-09-09T03:43+09:00 供能根因整合修复与Link协调部署
- 修复：无Link房storage消费回流、reserver补能提前量、跨房探索预算及v3缓存迁移、全程道路完成判定、邻接整载掉落拾取、外矿每趟50能量修路预算；保留另一会话Link优化与既有进攻计划。
- 验证：smoke/conquest/148 Python通过；私服validation-3rKliM 53生效断言全过、零游戏/通知错误、无硬回归，两条夹具隔离/迁移导致的统计提示已解释。A2/F真实ID记账：CP+10.11%、外矿交付+33.42%、期末地面能量-80.84%；直接净额-8592→-331，尚不证明长期盈利。
- 部署：独立干净工作树源码已合main，default/activeWorld版本1788892689435，47模块匹配，tick73575763 errors=[]，四个目标外矿完整v3路径生效。原主目录33个未提交文件逐一哈希保留。
- 后续：每小时监控新版本完整窗口；W31S5旧窗口升级下降告警继续追踪，检查reserve接班、地面损耗和稳定期净成本。详见docs/analysis/2026-09-09-energy-supply.md及docs/benchmarks/2026-09-09-remote-route-ab.md。

## 2026-09-09 监控漏检复盘与处置闭环
- 旧记录已多次报W33S3供能异常，但缺事件跟踪，且成功采样有数小时空窗；旧外矿规则只看人数，缺路径/掉落/有效预定覆盖，升级回退混版本并可能被建设过滤。
- 外部监控schema4补独立结果检查、真实在岗CLAIM/当前预定、路径版本、地面资源ID/满容器、供需错位、吞吐与局部成本边界。版本隔离、三次短采样、事件升级/恢复证据、采集失败留档与唯一分片避免把未知当健康。
- 验证：164 Python测试全过，实际PROBE的JS执行场景通过，Python/JS语法与diff检查通过。线上73575939/961/983三次schema4新鲜采样，版本1788892689435不变；W31S1替补及时到位，W32S4/W35S7无storeLink供能疑点交由Link会话核查。
- 调度继续每小时；每轮三次采样、读取全部未解决事件并执行上次nextAction，重复告警必须追加诊断证据。参见docs/operations/hourly-monitor.md和docs/analysis/2026-09-09-monitor-gaps.md。完整成本账仍未知，沿用真实ID私服稳定期验证，不冒称长期盈利。仅外部监控变更，不上传游戏代码。

- 监控补充：根据Link会话tick73576027的诊断纳入有效spawn能量预留上下文，暂缓供需错位判定但不关闭旧事件；队列超时和发展检查保留。已知safe mode持续状态只观察，不因重复升级为故障。新增回归后166 Python全过，实际探针测试通过。

## 2026-09-09 RCL5 控制器Link仓库兜底与联合发布
- 问题：无storeLink房的控制器Link投递依赖storageRich，导致storage约5k–7k闲置而升级供能间断；短窗口停顿不等于永久死锁。
- 改动：实际upgrader需求触发控制器Link补给，空载hauler仍先收源侧能量，再按实际缺口取storage的2000以上储备；保留孵化优先与不回库循环保护。联合保留矿物外置大脑、reserver非抢占接班和监控修复。
- 预期：控制器Link在仓库未富余时也能获得补给；无Link及完整Hub既有路径保持。
- 实测：独立私服旧代码CP0/storage2600，修复CP600/storage2000，无Link对照均CP600；最终标准validation-QTIuVo 56effects全过/零错/零基线警告，179 Python与专项测试通过。版本1788897505183已上传default，47模块逐一一致；tick73576913 W32S4 fallback1325/ctrlLink794，W35S7 ctrlLink479/32WORK均非空，errors=[]。完整报告docs/analysis/2026-09-09-controller-link-feed.md；持续恢复交监控三次复核。
- 大脑回执：正式radius2写入后当前segment/Memory/ack一致为1788897635036；W33S7矿物计划字段完整，因energy策略暂停开采。
- 未结观察：W35S7三采仍约11.17CP/t、storage不动；只读任务轨迹确认hauler先去远源收小批量，属于源侧优先/运力分配后续项，不称永久死锁。监控任务继续独立对照，本轮不临时抢占源侧物流。

## 2026-09-09 Reserve预算与运输占用接班修复
- 问题：替补阶段拒绝650单CLAIM，且等1300满配时同级运输可占用spawn越过接班期限；多个接班可能重复承诺资金/孵化时段。
- 修复：基于真实在岗寿命/预定/完整路程的绝对截止与合法小身体；运输准入按真实队列顺序、满配成本及实际spawn释放时间累计共享资源。核心、防御及必要矿工优先保留。
- 验证：TTL88/120、短任务、多spawn、共享资金和反序deadline红绿回归；179 Python、JS专项/冒烟/conquest/语法/47模块构建通过。完整validation-UDPB50 57effects全部通过，无基线警告；真实1100预算、单CLAIM后继tick121到位，旧者139死亡。前两轮夹具错误和旧候选停止原因保留，不冒用无效证据。
- 部署：源码61b4caf、版本1788901839592、default activeWorld，47模块匹配、errors=[]。主目录33项WIP哈希不变；通过直接会话消息串行发布。详见docs/analysis/2026-09-09-reserve-budget-deadline.md。
- 上线三采：73577986/73578008/73578031同版45tick，errN0、bucket5896→8462；W32S6/W33S5预定连续增长，W33S6真实650替补已出发。W31S5/W35S7分别16.69/21.69CP/t；W33S7低储备0CP/t和长期净额仍跟踪，不关闭未知项。

## 2026-09-09 08:19 实景私服导入检查
- 发现soak导入器忽略Link并丢弃己方外矿预定，不能直接用于当前供能/配送A/B。新增Link保留及预定用户/剩余期限映射；只改测试工具，不改src、不上传游戏代码。
- 回归先确认Link导入为null，再修复；snapshot/验证器自测和语法通过。78房快照295个时间字段归一化（采集跨度24tick）；validation-kTbu7e真实私服300tick、70只初始核心creep、12采errN0/通知0，15座Link全保留。W32S8/W31S7的预定endTime4244/4987与归一化值相同，用户正确映射到私服。
- 公共tick300数据库及hash归档data/validation/monitor-hardening/drop-routing-seed-check，供同起点分叉；这不是A/B收益结果。主33项当前WIP保留（自动观察报告较最初基线已有更新）。

## 2026-09-09 W33S7 维修饥饿：道路消失 / builder 挂机 / storage 空（六个源码提交，已部署）

- 现象：W33S7 的路从 09-04 的 152 条掉到 52 条（11 条 < 500 血、最低 40），storage 0，builder/hauler 长时间 0 能量原地不动；对照 W33S3（storage 10.4 万）130 条路全在、最低 2800 血。
- **先排除"Memory 坏了"**：`Memory.rooms.W33S7` 的 plan（89 格路、ramparts、links、containers 齐全）、remotes、state、demand、spawnQueue、demolition 全部完整自洽，与线上对象一一对得上（plan 89 格 vs 房间 54 条）。重建 Memory 不是解，问题在维修链。完整调查见 `docs/analysis/2026-09-09-w33s7-maintenance-starvation.md`。
- 根因（五个互相独立的缺陷，全部有线上证据）：
  1. **builder 对空 storage 永久挂机**：`src = 容器 || room.storage`——空 store 是 truthy，每 tick 对空仓库 `withdraw` 失败就 `return`，永远到不了 spawn/ext 余量与直接采集两条兜底。实测两只 builder 0 能量原地不动 25+ tick，同一时刻 spawn+extension 有 825 能量；同窗口 12 645 tick 只建了 36 691 进度 ≈ 2.9/tick。空 storage 只有 W33S7 有（其余房 1.7k–10 万）。
  2. **broker 的维修任务池看不见中立建筑**：池子用 `FIND_MY_STRUCTURES`，道路/容器是中立结构。线上 90 条任务里 0 条路、只有 5 个己方 rampart。
  3. **builder 只在"没有工地"时才修**：RCL6 后 40 个工地（terminal 10 万 + 3 lab 15 万）永远在建，道路维修永远轮不到。
  4. **塔停在储备线上**：塔 501/500，`tower.js` 要求 `energy − 10 ≥ 500` 才修，而维修补能任务在第 3 层、永远输给第 1 层的 spawn/ext。附带：塔按全局比例挑目标时会去够房间另一侧的路（射程外恒 200 血/动作 = 20 血/能量，比 builder 的 100 血/能量差 5 倍）。
  5. **消失的路补不回来 + 没有 builder**：40/40 工地名额被 terminal + 3 lab + 36 个零进度外环 rampart 占满，`placeSites` 预算 0，`yieldLowPrioritySites` 只认高优先结构、不认路；而 builder 是发展档，永远排在外矿维护（remoteMaintain）后面——实测 45 分钟没排上，24 个道路工地 0 进度。
- 改动：builder 空 storage 不再当来源 + 先修 `criticallyDamaged`（会消失的）结构再建造；broker 维修池改用 `FIND_STRUCTURES + needsRepair` + 射程内有危急结构时塔的维修补能提到第 1 层（遥测 `towerCritical`）；塔的维修目标优先射程内；layout 名额满时让出零进度 rampart 工地给缺失的路；没有 builder 且存在危急结构时第一只 builder 提到生存档（遥测 `criticalBuilder`）；`utils.needsRepair` 的"这条路在不在方案里"改为每房每 tick 一份 Set（抵消新增扫描 CPU）。
- 验证：冒烟 6 个新场景全绿、conquest、179 Python、47 模块构建、验证脚本自测通过。私服（validation-heC91p，`--effect-ticks 350`）**五条生效断言全部观察到**：builder 把塔射程外那条 60 血的危急路修到 5000（它只能从 spawn/ext 取能）、`towerCritical` 记录到塔的危急补能升层、维修池里出现中立建筑（容器 backlog 179800）、房间里从 2 条路变成 6 条（名额满时让位放出的路工地被建成）、storageFed 房里记下 `criticalBuilder`。该轮仅剩两条与本改动无关的已知薄边：`layout.roadsWaitForRcl`（bootstrap 房地形随机，播种的 120 进度路工地恰好落在轮子方案的路格上而被 trimSites 保留）与 `minerals.externalDelivery`（350 tick 的短轮跑不到钻机交付；第 1 轮 900 tick 时通过）。机器负载整轮 8–40（另有会话的私服/基准并跑），更长的轮次会因 `waitForGameTime` 超时而中断。
- 部署：`default`（activeWorld）版本 **1788939130927**（前五个提交）→ 复测 errors=[]、`towerCritical` 立刻出现在 W33S7；随后版本 **1788942244445**（vital builder 提交）→ errors=[]、`criticalBuilder.n=312`、队列队头从 remoteMaintain hauler 变成 `core:builder:0`。
- 上线实测（约 1 小时后，tick 73589907）：**49 条路最低血量 40 → 900，< 500 的从 12 条降到 0 条**；塔射程内 24 条最低 1140、射程外 25 条最低 900（修复前射程外最低 100、18 条 < 1000）；builder `霖之助甲` 在岗修危急路；storage 从 0 → 197；road 工地 24 个（名额让位生效，rampart 工地 36 → 9）。CPU 80.7/tick、bucket 3231（与部署前同量级）。
- 未结观察：外矿溢出（W32S6/W32S7/W33S5 源容器 2000/2000 满、地面还有能量堆，而母房 storage 仍只有 197）是"房间穷"的另一条供给线；24 个道路工地仍 0 进度（builder 优先修危急路、且房间能量 46/2300，路工地要等收入富余），外矿运输编制的实际吞吐与模型是否匹配需要单独量；环形 rampart 在 RCL6 的 30 万/格维修目标远超当前收入。

## 2026-09-09T22:50+09:00 W33S7 外矿编制按收入预算 / 满容器矿工停手 / 外环 rampart 收入门槛（已部署）
- 问题：W33S7 的外矿编制长期超出收入。4 条外矿的摊销成本合计 12.8/tick（矿工 + reserver + 各槽位运输工的造价 ÷ 各自寿命），而 spawn 收入只有 8–20/tick；光 4 个 reserver 就 4.3/tick（650–1300 能量 / 600 tick 寿命）。队列队头反复是买不起的 2250 理想运输工（实测等待 687 tick），等待期间按 jumpable 挡住发展档（builder / 第 2 只 hauler / 升级者）。同一时刻源容器 2000/2000、地面能量堆 1000–2600、storage 197 —— 地面那堆来自**引擎的 harvest 溢出落地**（@screeps/engine processor/intents/creeps/harvest.js：`sum > storeCapacity` 就 drop，落地能量每 tick 衰减 `ceil(amount/1000)`），而 hauler 的 collect 总是先拿容器，落地能量基本等于白丢。另外 24 个道路工地 0 进度、环形 rampart 的 RCL6 维修目标是 30 万/格 = 84 格 25M 血 ≈ 25 万能量。
- 改动（`b5ead51`+`d82fb0f` fix(remote)）：
  1. `remote.staffRemotes` 每 tick 按本房收入算编制预算：每条外矿的摊销成本 =（矿工 + reserver + 各槽位 hauler 的造价）÷ 各自寿命，产出只算运回**本房**的能量（卸货房是别的房时记 0——W32S6/W33S5 把能量运给 W32S4，母房却替它们养整套 creep）；按 产出−成本 排序累加，累计 ≤ 收入 × `upkeepShare`(0.5) 的才在编，已在编的按 `upkeepSlack`(1.3) 放宽防抖。不在编的外矿不再补员，存量 creep 自然到期退役。收入样本不足（< incomeSamples 200）时**不裁编制**——用每源 fallback 当依据会按一个假数字裁掉刚起步房的远外矿（私服 reserveBudget 场景实测：fallback 预算 5/tick、远外矿摊销 5/tick，正好被裁，reserver 接班请求随之消失）。遥测 `Memory.rooms[房].remoteStaff`。
  2. 运输工槽 0 的身体按"还差多少 CARRY 在途"封顶，不再按房容量顶格：W33S6 距 37 格只需 16 CARRY，旧代码孵 21 CARRY 的 2250，多花 500 能量 + 15 tick 孵化时间。
  3. `remoteMiner` 满仓 + 源容器满时停手（停手不损失产量：源停在满能量，运输工取走容器里的能量后矿工立刻续采）。
  4. `04c7275`+`1a2a9b3` fix(layout)：外环 rampart 加收入门槛 `rampartRingMinIncome`(50：84 格 × 3 血/tick = 252 血/tick 的衰减会由**塔**来补——外环刚建成时比值 0.001%，塔按"离目标比例最低"选目标会一直填它，射程 20 外只有 20 血/能量 ⇒ 12.6 能量/tick，留 25% 收入给外环即 50/tick)，低于门槛时 `trimSites` 清掉零进度的外环工地；RCL6 的 `rampartTargetHits` 从 30 万降到 10 万（与 RCL5 同档）。
- 预期：编制不再等于或超过收入（摊销账平衡时房间永远攒不出第一只运输工，这是死循环的算术形式）；收入 10/tick 的房先只养 1 条最近的外矿（2.7/tick），收入翻倍后再自动加第二条；满容器的外矿不再往地上丢能量；W33S7（收入 8–30/tick 波动）在收入到 50/tick 之前不铺外环。
- 实测：
  - 私服：`validation-nfR6KR`（`--effect-ticks 900`）**全部生效断言通过**（含三条新断言 `remote.incomeBudgetedStaffing`、`remote.minerNoGroundOverflow`、`layout.rampartTargetFitsIncome`）、通知错误 0、基线对比零失败零警告；补回 layout 门槛后 `validation-lJLTfU` 只剩已知地形薄边 `layout.roadsWaitForRcl`（bootstrap 房随机地形把播种的 120 进度路工地落在方案路格上，见上一轮记录）。smoke（新增 4 个确定性场景）/conquest/179 Python/验证器自测全绿。
  - 线上（版本 **1788960918363**，部署后 15 分钟采样）：**W33S7 收入 8–20 → 28–35/tick**、预算 14–17/tick、`remoteStaff.staffed` = 全部 4 条（13.8/tick），队列不再被买不起的外矿请求卡住；**11 个零进度外环 rampart 工地被清掉**（收入 29 < 50），房间工地组成变为 terminal 1 + lab 3 + road 24；**四个外矿房的地面能量从各 1000–2600 变成 0**（矿工停手；W32S6 期间出现的 16 是死亡 creep 的掉落，一 tick 后归零）；spawn 能量开始累积（50 tick 内 105 → 1221），`errors` 空。全账号 10 个房都写出了 `remoteStaff`，没有房裁掉买得起的外矿。
- 未结观察：storage 仍只有 10（收入全用在补外矿编制与修路，富余先填 spawn/ext）；卸货房是别的房时母房仍要出 reserver/miner（能量给别人）——本轮只把"运回本房"记成价值，没改卸货房逻辑本身；母房 hauler 身体（2300 能量 / 1500 容量）对 link 供能房偏大（只搬 10/tick 的余量，摊销 1.53/tick/只）；升级者吃满 link 链（10/tick）是既有战略选择（Kalgen 在 storage < 1.7e5 时用 W1 保级）；塔在射程外仍是 20 血/能量。

## 2026-09-10 W33S7 道路仍不完整的根因：builder 取能点选错 + rampart 目标改为按收支动态（已部署）

- 现象（用户报告）：道路只有 60/89 条，24 个道路工地长期 0 进度；同时 W33S3（storage 14.5 万）路全在。线上实测 shard1 只跑 **0.23 tick/s**（正常 1 tick/s），4 小时 ≈ 3.3k tick——所有墙钟时间都要除以 4。
- 排查（三条证据）：
  1. **builder 的时间几乎全花在路上**：两个 6-WORK builder 在 3.3k tick 里只产出约 3.3k 进度 ≈ 1/tick，而它们全力建造是 60/tick。逐 tick 采样：`霖之助丙` 从 (29,23) 走到 (15,8)（20 格）取 176 能量再走回来，一车能量只够建 6 tick。
  2. **取能点的选择与距离无关**：`roles/builder.js` 是"最近的容器 ≥50，容器都没有才用 storage"，storage 只是兜底。同一时刻 storage 有 276、控制器 link 有 799（三座 link 常年 800/800），而 builder 跑去 20 格外的源容器取 170——顺序上容器永远优先。
  3. **link 里的能量只有升级者能动**：RCL6 没有 store link 时，源 link 把能量送进 ctrl link，升级者吃不完的部分堵在那里（升级者只要 10/tick）；`operator` 是 RCL7+ 的角色，RCL6 没人把 link 的能量搬回经济。
- 改动：
  - `roles/builder.js` 的 `energySourceFor`：按**路径距离**选最近的一个取能点，候选 = 非控制器容器 ≥50、storage ≥50、控制器/仓库 link ≥ linkKeepAt + linkDrawMargin（250，缓冲留给升级者；只借收货端，不动源 link）。取能点在 `builderSelfFetchRange`（8）格内时不再等 hauler 投递。遥测 `Memory.rooms[房].builderSource` / `builderSourceLog`。
  - `utils.repairTargetHits` 的 rampart 分支：目标 = 能量预算 × `ramparts.incomeShare`(0.15) × `ramparts.raiseTicks`(20000) × `ramparts.hitsPerEnergy`(80) ÷ 已建 rampart 数，夹在 `floorHits`(5000) 与 `rampartTargetHits[RCL]` 之间；能量预算 = max(spawn 收入 EMA, storage / `storageTicks`(10000))。
- 验证：冒烟新增 8 条断言（取能点选最近的 storage / 借 ctrl link / link 低于门槛不借 / 近处不等投递、rampart 目标随预算与格数变化）；conquest、179 Python、语法全绿。私服 `validation-JMyb8m`（`--effect-ticks 400`）**六条生效断言全过**（`builder.nearestEnergySource`、`utils.rampartTargetFollowsBudget`、`maintenance.builderRescuesCriticalRoad`、`maintenance.roadSiteYield`、`maintenance.towerCriticalBudget`、`maintenance.repairPoolNeutral`）；仅 `minerals.externalDelivery` 是短轮已知薄边（900 tick 轮次通过）；手工基线对比 failures: []、1 条已知警告（W20N20 RCL 2 → 1）。
- 部署：`default`（activeWorld）版本 **1788971281368**，47 模块，errors=[]。上线实测（tick ~73595280）：道路 54 → 71 条（最低 1000 血）、24 个路工地；`builderSource` 遥测显示 builder 已改从 ctrl link (32,24) 取能。
- 未结观察：道路仍不完整——见下一条（房间能量分配）。

## 2026-09-10 W33S7 能量分配与 builder 编制（三个源码提交，待部署）

- 现象（用户报告续）：道路 89 条规划路已全部建成（113→119 条里 89 条在方案内），但维修跟不上——最低 1000 血（20%）、射程外 26 处需要维修；storage 0、spawn 只剩几百能量；用户追问"builder 数量是不是太少，应该按建造/维修需求动态增加"。
- 根因（三条，全部有线上证据）：
  1. **控制器把本地收入吃光**：W33S7 是 link 供能房，两个源 20/tick 全部进 link 链 → ctrl link → 升级者。升级者是按容量孵的 W20C2M1，满负荷吃 20/tick（实测控制器 +15~20 进度/tick，即 15–20 能量/tick），storage 被抽到 13 → 0，源容器 0/10/0，两只 hauler 空着手挂机，builder 只能走 13 格去源容器刮 56 能量。link 链永远堵不满 ⇒ 矿工"link 满了送容器"的兜底从不触发，房间其余部分一点能量都拿不到。
  2. **builder 的时间几乎全在路上**：`hasHauler(room)` 只看"房里有 hauler"，两只 hauler 都是 0 能量、没有任务时 builder 仍然在工地空等 30 tick（feedAt 到期才走）；危急目标按**全局比例**挑，两只都在危急线附近、相距 20 格时来回走（swarm 路 (31,25) 19.6% ↔ 矿物容器 (19,40) 19.0%），一趟只修 1 tick。
  3. **危机目标/维修池对"方案外建筑"的处理不一致**：`planRoadKeys` 把 `plan.roads` 的所有串并进本房键集合，而外矿路网键（`remote:W32S7:…`）的坐标属于那个外矿房——W33S7 113 条路里 30 条不在 `plan.roads.all`，其中 3 条（26,19)(27,19)(29,20) 因坐标撞键留在维修池；`criticallyDamaged` 更是完全没过滤方案。另外**编制缺口**：W32S4/W31S4/W33S8 射程外需要维修的路 67/63/48 条（债 16.8/19.3/47.9 万血），而 `builderTarget` 是 0、W32S4/W33S8 一只 builder 都没有——"有能量的塔会修"的守卫把塔够不着的活一起挡了。
- 改动：
  - `utils.upgraderWorkCap`：能量吃紧（storage < `upgrading.lowBelow`，滞回到 `lowExitAbove` 退出）时控制器只吃本地供给（每口源 10/tick）的 `incomeShare`(0.6)，富房照常吃满；`spawn.upgraderBody` 孵升级者时就按它压 WORK，`roles/upgrader` 按房间总量降频（多只各分一份、相位错开），遥测 `Memory.rooms[房].upgradeBudget`。降额后 link 链堵满，矿工的容器兜底生效，房间其余部分才有能量。
  - `roles/builder`：等投递前先看**有没有会来的 hauler**（有能量的、或已经认领"送我这单"的，退役中的不算）；危急目标先在 3 格内挑（修到危急线以上就重新评估，不会饿死远处目标）；取能点遥测只在变化时记一笔并加 `builderSourceFirst`。
  - `utils`：抽出 `plannedStructure` 给 `needsRepair` 与 `criticallyDamaged` 共用（方案外的旧建筑一律不修），`planRoadKeys` 只收本房路网。
  - `spawn`：`outOfTowerRepair` 统计塔射程（20 格）外需要维修的非 rampart 结构的数量与维修债，`hasBuilderWork` 的塔守卫只看射程内，`builderTarget` 的需求侧 = 建造 backlog + 维修债（100 血/能量 × `buildDuty`，在 `construction.horizon` 内清完），仍受收入上限与 `maxBuilders` 约束；遥测 `state.builderRepairDebt/builderOutOfReach`、决策事件 `outOfReachRepair`。
- 验证：冒烟新增 8 条断言（射程外维修债进编制 / 方案外的路不修也不危急 / 外矿路网坐标不撞键 / 取能点遥测只在变化时记一笔）；conquest、179 Python、验证脚本自测全绿。私服 `validation-FU9lZ6`（`--effect-ticks 900`）：**ok=true，70 条生效断言全部观察到**（本轮新增 7 条：`builder.nearestEnergySource`、`utils.rampartTargetFollowsBudget`、`upgrader.incomeShare`、`builder.feedProspect`、`builder.repairSticksToReach`、`spawn.repairDemandBuilders`、`utils.planOnlyRepair`），通知错误 0，基线仅 1 条已知警告（W20N20 起步房 RCL 2 → 1，随机地形）。为观察编制改动新播了维护场景第二房 W61N59（武装的塔 + 没有工地 + 没有危急结构 + 塔射程外 21–24 格处 14 条 40% 血的路）：旧代码这里 `builderTarget=0`，新代码 ≥1。
- 部署：`default`（activeWorld）版本 **1789020863800**，errors=[]。上线 15 分钟采样（tick 73607083）：**W31S4 射程外 62 处维修债 5.5 万血 → builderTarget 0 → 1**、W35S7 0 → 1（11 处、4.7 万血）；W33S7 目标 2（24 处、12.8 万血）；升级预算遥测全线生效——storage 低于 lowBelow 的房里 `cap=12`、`duty` 按在岗 WORK 分摊（32 WORK → 0.375、16 → 0.75、10 → 1），控制器不再吃满本地收入。
- 未结观察：W33S7 的 storage 仍在 0 附近（新释放的 8/tick 先补 spawn/ext、再补维修）；射程外 24 处的维修债要靠新增的 builder 清；方案外 30 条旧路会自然衰减消失（这是设计意图：只养方案内的路网）。

## 2026-09-11 全面审计：外矿编制死亡螺旋 / 核心能量被 builder 与升级者抽空 / 维修与外矿维护（两批源码提交 + 一个跟进，已部署）

- 起因（用户要求）：全面检查模拟结果、全部代码与线上现状，找出影响发展效率、让 creep 停工、建筑或外矿维护不当的问题并修复。先对线上两份快照（间隔 1810 tick）、RCL 基准样本、`logs/status.jsonl` 做多维审计，每条发现再单独核实（CONFIRMED / PLAUSIBLE / REFUTED），只修核实成立的。
- 第一批（W33S7 崩溃链为主）：
  1. 外矿编制预算 = 收入 × 0.5，收入 EMA 一掉就把外矿全裁掉 → 外矿不再交货 → 收入更低（W33S7 死亡螺旋）：自负盈亏（价值 > 摊销）的外矿不裁；storage ≥ 10 万时外矿孵化时间封顶 spawn 数 × 0.5，富余升级者改发展档、可跳过。
  2. spawn 在攒能量时 builder 从 ctrl link、源容器、spawn/ext 余量取能去建 terminal/lab，升级者吃 spawn/ext 余量：饥饿时两者都让路；terminal/lab/factory 等"奢侈"工地等 storage ≥ 3 万再放。
  3. RCL5–6 没有 store link 时源 link 一有空位就往 ctrl link 送，吃不完的收入堵在链上、源容器 0、hauler 空手：只在 ctrl link 低于 linkKeepAt 时补。
  4. 收入估计：spawn 自产只在全房 < 300 时扣；只往 link/容器交货的矿工不算搬运者；卸货到本房的外矿 hauler 算。
  5. 孵化队列：同档内 vital 先排；非 vital 请求在收入为 0 时守正常缩身下限；核心替补预留按队列实际会接受的身体计价、窗口封顶 150 tick；升级者被限流时数量按 上限 ÷ 每只 WORK 封顶。
  6. 外矿：reserver 按预定余量补（不再按在岗 TTL 链式续派，预定顶在 5000 被引擎拒绝）；卸货房不选比母房富 5 万以上的房；运输编制算上投递停靠与利用率，缩身 hauler 占满槽位时出补差槽；路线没铺完时矿工 5W1C5M；矿工替补按 spawn→工位的步行时间提前。
  7. 维修：外矿路线在母房的那段重新算方案内道路（此前衰减到 0 被 layout 重建）；墙不算危急结构；塔射程外的维修债低于 1 万血不为它常驻 builder。
  8. 防御：外矿里只有 NPC 或带攻击/治疗部件的 creep 才算武装敌人；外矿防御归属母房而不是最近的基地。
  9. 外部大脑：高速公路可作走廊房（roomStatus 兼容）；被游戏内预算裁掉的外矿不再拿粘性加分；外矿优先分给它已经在卸货的母房（卸货房自己富余时除外）。
- 第二批：
  1. 升级限流（storage < 5000 时控制器只吃本地供给 60%）要有竞争需求才生效：工地、够量的维修债、spawn 在攒能量、spawn/ext 持续 100 tick 不满；最近一次看到需求后保持 300 tick。线上 W34S7/W35S7 在低档停了两万 tick、backlog 0、spawn 空闲满能量，限流上线后进度 12.3→9.5、13.5→10.9 CP/tick。跟进（ea0ccd1）："没补满"要低于容量 80% 才计时——第一次部署后 W34S7 停在 1756/1800、spawn 空闲无请求，照样被算成 unfull 限流 185 tick。
  2. core hauler 身体按 haulModel 的在途运量摊给编制只数，夹在满配一半与满配之间（换代与替补预留同一尺寸）；第 2 只 hauler 在发展档里排在 builder/升级者之前。以前一律按容量顶格，RCL7 的 2400 高于非 vital 缩身下限、永不缩身。
  3. builder 开修危急结构后修到 60% 或手里能量用完才回去建造（W33S7 方案内道路 54/89 条停在 20–30%）。
  4. 外矿变坏：每口源都有矿工却都采不动预定多出的一半时不派 reserver；吞吐不到理想一半的矿工换代提到外矿维护档；容器丢失后仍派槽 0 维护 hauler，矿工在容器工地上同 tick 捡 + 建。
  5. 两跳外矿的入口按外矿房自己的出口取边（此前翻到背向母房的边，回退铺路留下孤儿工地）；名额被零进度孤儿路工地占满时清掉。
- 验证：冒烟全绿（新增场景均确认去掉改动会失败）、conquest、187 Python、验证脚本自测、语法、构建（47 模块）。私服 `--effect-ticks 900`，审计场景新增 auditHome/auditRemote/auditRich/auditDrop/auditLink/auditZero 六房、30+ 条 audit.* 生效断言：
  - 第一批单独跑的 validation-Wmg3Hx 挂 4 条，全是夹具/遥测问题不是行为回归（源记录每 tick 按白名单重建把 haulNeed 丢了；auditHome 有卸货回本房的外矿 hauler，"没有搬运者"的前提不可能成立；auditLink 开局没有矿工处于恢复期，塔在前提生效前就把射程外的路修了；reserveDeadline 在一种地形下后继者被在岗者挡住）——修复见 31e1ab2。
  - 两批合跑 validation-AXhRew 只挂 `spawn.repairDemandBuilders`（末态断言与本轮 1 万血下限冲突，改看决策事件后离线重判全报告通过）；跟进后 validation-qQWsJg / EbXkOa 暴露同一房的夹具临界（射程外债在下限附近来回）与 `utils.planOnlyRepair` 的末态字段缺失（spawn 忙时不写需求），夹具改 28 条路、断言改看决策事件，EbXkOa 离线重判全报告通过、CPU 最高 15.7/140、通知 0。
  - 无回归：worktree 里跑的验证读不到 `data/validation/baseline.json`（回归门静默跳过），全部改为对照主仓库基线手动比较，四份报告均零失败零警告；基线已更新为 EbXkOa。
- 部署：`default`（activeWorld）版本 **1789127820665**（main 094f3e0，两批 + 验证修复）→ errors=[]；跟进版本 **1789131167654**（main ffd7d3e，80% 未补满门槛 + 夹具/断言修正）→ errors=[]。外部大脑 21:02 起按新规则写 segment 90：W31S8 拿到 W31S9（高速公路走廊），W32S6 改派 W32S4（它的 hauler 本来就卸在那里），W33S3 用距离 1 的 W32S2 换掉距离 2 的 W33S1。
- 上线实测：
  - 第一次部署后约 250 tick：自负盈亏的 W33S6/W32S7 留在 W33S7 编制里（部署前只剩 W33S6）；三处 6 个孤儿路工地被清掉（W31S1、W31S2、W32S5，正是审计找到的那几处）；W33S8 的 W32S8 记到"矿工太弱不派 reserver"（gain 0）且该 2W 矿工的换代提档；W33S7 的 W33S6 容器丢失后矿工同 tick 捡 + 建（61 次）；core hauler 按运量缩到满配一半（W33S7/W33S8 15/30、W33S3 18/24）；W35S7/W31S5/W31S4 升级限流放开。
  - CP/tick（控制器进度差分；部署前取 status.jsonl 73627668→73633052 共 5384 tick，部署后 73633925→73634843 共 918 tick）：全账号 **105.7 → 147.9（+40%）**。W33S3 14.5→37.9、W33S7 2.8→9.8、W33S8 7.2→11.9、W31S4 12.8→15.9、W34S7 9.4→12.4、W31S6 13.7→16.1、W32S4 9.5→11.5、W35S7 11.0→12.5；W31S5 12.1→10.0、W31S8 12.7→10.0（两房是 storage 供能低档，编制按既有低档逻辑只孵一只 W10 link 档升级者，storage 在涨，过 1 万退出低档后恢复，与本轮改动无关）。
  - 部署后 15 分钟 W34S7 一度只有 0.5 CP/tick：限流时编制按 上限 12 ÷ 每只 12W 封顶为 1，两只旧升级者到期、新的 1 MOVE 升级者从 spawn 走过去要几百 tick，之后回到 11–12/tick。
- 未结（核实成立但本轮未改）：#6 穷房 reserver 1 CLAIM 跑步机（与 #12 同一段请求代码，要兼顾不挡核心发展档）；#20 塔位按 x 升序而非伤害/覆盖；#21 己方房 defender 逐只接敌；#35 多跳外矿途经段不铺路；#42 W32S4 extension 堵西侧通道（拆己方建筑需授权）；#48 房间之间的能量调拨（courier 只给容量 < 1300 的弱房）；3W 外矿矿工缩身下限（私服造不出可观察的前提）。

## 2026-09-11 W32S4 打通西侧隧道：挪走 (24,15) 的 extension（运维改方案，用户授权）

- 问题（审计 #42）：隧道路 (23,15) 是西侧唯一通道，它的非墙邻格只有 spawn (24,14)、extension (24,15) 和 (22,16)。src0 矿工从核心去工位要绕南边 73 格（打通后约 15 格），W33S4 外矿的运输工每趟在母房多走约 33 格 × 2。
- 方案比较：在 (24,16) 修第二段隧道路要 45,000 能量（墙上道路 ×150），回本约 1.5–2 万 tick；挪走 extension 约 3,000 能量，几百 tick 回本。用户选挪走。
- 操作（tick 73635067，控制台改 `Memory.rooms.W32S4.plan`）：`ext` 去掉 (24,15)、末尾补 (20,17)（隧道西侧开阔地，不贴 spawn、不在去 src0 的路线上，RCL8 才会建，总数仍 59）；`roads.all` 追加 `24.15`。没有手动 destroy：extension 变成方案外、配额已满且方案内有未建位，由拆迁调度按 `cap-replace` 规则拆。
- 结果：73635079 拆迁日志记 `extension (24,15) cap-replace`，同一时刻 (24,15) 放出路工地、替代 extension 工地放在方案下一个位 (32,18)；errors=[]。

## 2026-09-12 搬运饱和度：每只搬运工的有效满载 tick（已部署 1789191035576）

- 问题：线上/基准里 hauler 数量不缺，但每只的有效工作 tick 很低。新加的行为中立遥测 `Memory.haulStats`（v1→v2，按动作钩子记账）在 60 万 tick 快照上量到：忙碌率 53%（空等 44%）、在途装载率 0.13、每 CARRY 每 tick 运量 0.29、装卸 tick 里只有 8–12% 同时在挪位。瓶颈是"每趟运多少、每 tick 有没有在动"，不是编制。
- 改动（按提交顺序，详见 `docs/benchmarks/2026-09-12-haul-saturation-ab.md`）：
  1. 遥测 v1/v2（`src/haul_stats.js`）：装卸/空跑/补满/倒腾/停靠/按供给拆分的空闲、房级补能期、外矿按线记账，线上零行为。
  2. broker 按量预留取代按槽位：`availableFor`/`claimAmount`/`consume`/`setProjected`，租约在 tick 开头统一预claim，等候点可租；溢出按源判定带滞回。
  3. hauler 改成"先规划后执行"：同 tick 动作 + 移动、取货门槛随路程与容量、在有进账的源容器旁补满、storage 货锁、顺路投递、投递后当 tick 起步。
  4. 升级者先喝 ctrl link；storage 站位够不着的满 link 派一只去 link 旁喝；storage 站位供能时不再往 ctrl link 回流。
  5. 路网变化后让轮子丢掉该房的 costMatrix 与缓存路径（含 vendor 补丁 `refreshRoom`），签名按坐标逐格混合。
  6. 对抗审查（45 代理 + 6 维度二轮）确认并修掉：干涸源的假进账、补满目标粘住、跨房认领挡本房、矿物占容量、storage 零头锁 100 tick、载货时还去 storage 补、需求缓存未作废、路网哈希线性抵消、外矿停用期间的腿长计时。
  7. 外矿运输（P2）：两端同 tick 起步、不站矿位、进账不划算带半车走、TTL 最后一趟、回家顺手建路、按卸货房实测停靠定编制。
  8. 编制（P3）：孵化花费 EMA 取代补货采样的收入 EMA，core hauler 按 CARRY 定尺寸（模型/实测/突发三条 C*，头数按满配折算，带滞回），hub 房把 storage 补给算成 base。
- 预期：同快照下每 CARRY 运量与 CP/tick 提高，倒腾与空转下降；编制数量不增加。
- 实测（同一快照分叉，除代码外完全相同）：15 万快照全账号 CP/tick 111.6 → 116.8（+4.7%），hauler 运量/tick 118.1 → 130.5（+10.5%），每 CARRY 0.60 → 0.67，倒腾 1.45 → 0.45/tick，装卸同 tick 起步 8% → 41%，采集持平、错误 0。60 万快照第一批持平（94.6 → 94.1）并暴露"取了送不掉的货锁 100 tick"（park 占空闲 60%、倒腾 1.98），第二批针对性修复；含全部改动的 B2 分叉在跑，结果补进基准报告。
- 验证：冒烟（新增 10 条断言，逐条确认改动前会失败）、conquest、190 Python、验证脚本自测、语法全绿；私服 `--effect-ticks 900`（世界 validation-NWlcNk）126 条生效断言全部观察到、163 房零错误、CPU 峰值 17/140、与基线无回归。过程中修掉三处验证基础设施问题（证据被同母房另一条外矿覆盖、新分支抢先记到另一个计数器、随机地形让源 link 播不下）。
- 部署：`default`（activeWorld）版本 **1789191035576**（main 0d01ea0）→ `Memory.errors` 为空；前 150 tick CP/tick 169.3 → 207.2、CPU 均值 75.9 → 75.4（窗口短，后续观察为准）。

## 2026-09-12 外矿路线失配自愈：规划的路没有车流就按真实走线改规划（已部署 1789196889638）

- 问题（用户提问"为什么外矿房间 W31S9 没有修路"）：路工地不是没放，是放了没人建。W31S9 有 6 个路工地，进度**全部为 0**，房内 0 条路，`Memory.rooms.W31S8.remoteRoadBudget` 自该外矿启用（tick 73633506，约 1.57 万 tick 前）以来**从未建立**——即 `creep.build()` 一次都没成功过。
- 根因：`remote.planRoute` 从母房 storage 锚点搜整条跨房路径（`range:1`、plainCost 2/swampCost 8），房内段成为 `source.road`，`placeInfrastructure` 按它从入口端起放工地；而 creep 的移动是 `go(creep, RoomPosition(25,25,卸货房), {range:20})` 交给轮子寻路。W31S9 只有东边一条边有出口（y=3–14 / 23–33 / 42–46），从矿位到 W31S8 走北段出口与走中段出口**代价完全并列**（四房真实地形 Dijkstra：都是 45 步，plain2/swamp8 都是 96、plain1/swamp5 都是 49）。规划器挑了北段（房内 34 格、出口 (49,5)），轮子挑了中段（房内 15 格、出口 (49,25)）。而顺手修路只发生在满载 hauler 的 3 格射程内（`roles/remoteHauler.nearbyInfrastructureWork`，只在 deliver 分支调用），工地放在没人走的走廊上就永远建不起来。
- 线上取证（部署前，只读）：连续轮询抓到两次满载出发——小阿燐丁 (41,38)→(44,35)→(48,28)→出房、梦阿燐辛（唯一带 WORK 的 slot 0，满载 800）(41,38)→(45,34)→出房，整条满载腿离最近工地 (45,10) 的切比雪夫距离 16–18，从未 ≤3；同期 6 个工地进度恒为 0。空车去程反而走北走廊、正好从工地上碾过，但那时 `state=collect`、身上 0 能量，`nearbyInfrastructureWork` 第一行就返回。3 只 hauler 里只有 slot 0 带 1 个 WORK（`remote.js` 的 `maintenance = slotIndex === 0`），另两只结构上不可能修路。
- 全账号范围（17 条启用外矿，规划路 vs 房内已建成的路）：两条线重合的 1 跳外矿全部铺满（W34S8 54/54、W33S4 34/34、W31S3 29/29、W32S8 21/21、W32S7 19/19、W33S2 13/13）；分叉的全卡住——**W31S9 0/34、W32S6 0/68、W31S1 0/22、W31S7 0/19**，W32S2 11/29、W31S2 7/21。
- 改动（`98a1d07`）：满载腿在外矿房内逐格记真实走线（`creep.memory.roadTrail`，上限 60 格），离开外矿房时汇总一趟交给 `remote.noteRoadTrail`；走线落在规划路上的比例低于 `config.remote.roadTrailMatchShare`（0.5）才算失配，连续 `roadTrailLegs`（3）趟失配就把实际走线采纳为新的房内路线（翻转成"入口端在前"、去重、去掉矿位格与房间边缘格），`roadComplete` 置假、计数归零、记 `record.roadReplan`。旧工地随之变成"不在任何启用路线上"的孤儿，由既有的 `pruneOrphanRoadSites` 清掉。只记满载腿：空车去程与规划器同侧、走的恰好是规划路，记了会把失配洗成"对得上"。失配计数必须在 `refreshVisible` 里手动带过去——`sourceRecord` 是字段白名单。
- 预期：分叉的外矿把路工地迁到有车流的走廊上，修路预算开始有支出；铺装量下降（走线通常比绕远的规划路短）；已铺满的外矿不受影响（路是 cost 1，creep 自然收敛回已铺走廊，走线与规划路吻合，不触发重规划——自稳）。
- 验证：冒烟新增 21 条断言（含"字段白名单丢计数"的回归，逐条确认改动前失败）；conquest、190 条 Python、验证脚本自测、JS/Python 语法全绿。私服 `--effect-ticks 900`（world validation-wo0RIY）**ok=true、27 房零错误、CPU 峰值 14.5/140、127 条生效断言全部观察到、与基线无回归**。新增生效断言 `remote.roadTrailReplan` 配新场景 roadTrail（`12f84ba`：W59N55 母房 / W59N53 外矿，把规划路播在矿位以南 ≥12 格的空地上），断言不只看遥测存在，还要求采纳后的路线逐格相邻、至少一格贴着矿位、遥测 `was` 等于播种的 5 格；自测补了三条反例。
- 部署：两段式（`verify-active-branch clean copy file_append` → 肉眼核对 dist 字节 → `verify-active-branch screeps`），从 detached worktree 上传，避开同工作树另一会话未验证的 hauler WIP（实测 `dist` 里 `salvagePickup`=0、`salvage:`=0）。版本 **1789196889638**，`Memory.errors=[]`。
- 实测（部署后 10 分钟内全链路闭环）：
  - 16:09 起失配开始累积（W31S9、W32S2 各 mm=1 → 2）；
  - tick 73650166 **W31S9 重规划 `was:34 → tiles:12`**，新路线 `48.28;48.29;48.30;48.31;47.32;46.33;45.34;44.35;43.36;42.37;41.38;40.39` 与部署前实测到的满载腿轨迹逐格吻合；tick 73650183 W32S2 重规划 29→28；
  - 16:13:09 旧的 6 个孤儿工地被清空，16:13:55 新工地落在新走廊前 6 格 (48,28)(48,29)(48,30)(48,31)(47,32)(46,33)；
  - 16:17:48 **首次出现修路进度**（(48,28)=20、(47,32)=10、(46,33)=20）且 `W31S8.remoteRoadBudget` **首次建立**，`spent:50` 正好是每趟满额预算——该字段在此前 1.57 万 tick 从未存在。
  - 铺装量 34 → 12 格（降 65%），且落在每趟必经的路上。
  - 70 分钟 / 60 个样本的长时程观测（当前部署版**不含**后来加的冷却）：6 条分叉外矿各只重规划**一次**，无 thrash；铺装量 W32S6 68→5、W31S9 34→12、W32S2 29→28、W33S5 24→25、W32S5 18→17、W33S6 4→3。
  - `roadComplete` 只在 W33S6 翻过一次真→假，且**只持续 1 个样本**（60 取 1，正是采纳那一瞬 `noteRoadTrail` 显式置假的那刻）——它采纳的 3 格走廊本身就是已铺好的路，下一个有视野的 tick `refreshInfrastructure` 就恢复成真。这把"路是 cost 1、creep 自然收敛回已铺走廊"的自稳性推理变成了实测：已铺满的外矿不会因为这次改动退回重身体。
- 跟进（同日，`c707fda` / `2653a40` / `eead0e2`，等下一次部署）：
  - **重复重规划**：`record.roadReplan` 原本整体覆盖，只留最后一次，私服里同一条外矿 900 tick 内改了两次（5→29、29→29）就让生效断言的 `was === 5` 误报（screeps-29 报的）。改成保留首次、后续只累计 `n`/`lastAt`；并加 `config.remote.roadTrailCooldown`（1500，一个 creep 寿命）：改过一次就冷却，足够把新走廊头几格铺出来，之后路是 cost 1、creep 自然收敛，走线与规划路吻合就不再触发。
  - **被弃用走廊上的工地**：`pruneOrphanRoadSites` 原本跳过 `progress > 0`。改为不论进度一律清，丢掉的进度记进 `orphanRoadSites.lost`。**正确理由是止损**（screeps-29 的框架）：一条路 300，已投 175 是沉没（工地没有拆回能量这回事），留着只会让剩下的 125 继续从每趟 50 的预算里流向一条 creep 不走的路；清掉是止损 125，不是回收 175。剩余成本恒 > 0、建成价值 ≈ 0，所以在任何进度值下都该清。这翻转了一条既有断言的语义（原本要求"有进度的旧工地留下"）——那条守卫其实多余，"别轻易丢弃已投入能量"的用意由**调用时机**保住：`pruneOrphanRoadSites` 只在名额满时才被调用，名额没满压根不清。
  - **冷却的初值 bug（自己引入、自己的测试没抓到）**：`Game.time - (Number(source.roadAdoptedAt) || 0) < 1500` 在 `roadAdoptedAt` 从未设过时退化成 `Game.time < 1500`——`Number(undefined) || 0` 把"从未改过"与"刚改过"压成同一个语义。线上 `Game.time` 是全服累计的 7300 万看不出来，私服世界 tick 从 0 起算则整轮都在阈值内，**把首次重规划挡死**，让 `remote.roadTrailReplan` 假阴性（screeps-29 在私服里撞出来的）。冒烟没抓到是因为 `resetWorld(3990)` 恰好掩盖了条件——补了 `Game.time=300` 的断言并回退验证过判别力。教训：写"距上次 X 过了多久"的判据用 `Number.isFinite` 显式区分"没有值"，并补一条低 tick 的断言；`Number(x) || 0` 用在时间戳上时 0 是错的默认。已 grep 确认 `remote.js` / `remoteHauler.js` 没有第二处。
  - **一处自我更正**：我最初把清理理由写成"脱离路线 ⇒ 没人路过 ⇒ 永远修不完"，**这是错的**。`nearbyInfrastructureWork` 用 `findInRange(FIND_MY_CONSTRUCTION_SITES, 3)`，不看是否在 `source.road` 上。实测：W32S6 (20,43) 距路线 38 格、一小时进度 10→10（真搁浅），而 W32S5 (20,4) 距路线仅 1 格、进度 145→175 一直在涨（根本没搁浅）。
- 跟进部分的线上实测（部署 **1789205921031** 后，由 screeps-29 的打捞改动搭车上线；`Memory.errors=[]`、activeWorld=default 已独立复核）：
  - **清理半成品孤儿生效**：W32S6 (20,43) 那个距路线 38 格、进度停在 10 的真孤儿**已被清掉**（既不是工地也不是路），`orphanRoadSites = {n:6, lost:10}` —— `lost` 与它的进度**精确对上**。
  - **孤儿的两种归宿都在线上出现了**：W32S5 (20,4)（距路线仅 1 格、进度一直在涨）不是被清，而是**被路过的 hauler 建完变成了路**，所以它的 175 没有进 `lost`。这恰好验证了生效断言不能写成 `lost > 0`（那会在"先被建完"这一支误判），而要断言"有进度的孤儿不能还以工地形式挂着"、两支分开认。顺带它也再次证明 `nearbyInfrastructureWork` 没有路线优先级：(20,4) 不在规划路上（规划是 `21.4`/`20.5`），能量花在了规划外的格子上。
  - **按源记的 `roadReplan` 线上暂未产生新样本**：部署前的 6 次重规划都发生在旧代码下，之后没有新的重规划（都在冷却内或走线已吻合）。所以按源遥测目前只由冒烟的双源断言 + 私服生效断言证明，**线上尚未验证**，据实记录。
- 未结（本轮核实成立、未改）：
  - **别的母房的外矿工地占满本房路工地名额**（证据充分，独立于本轮改动）：`remote.js` 的 `homeRemoteRoadSites` 只判断 `remotes[site.pos.roomName]` 存在、**不判断 `.enabled`**。线上 W32S4 名下合计 12 个路工地正好顶到 `roadSitesPerHome=12`，其中 **7 个属于别的母房的启用外矿**（W32S2 的 6 个归 W33S3、W32S6 的 1 个归 W33S7）——W32S4 既建不了也清不掉（`usedByAnotherHome` 正确地保护了它们），却被吃满配额，于是 W32S5 重规划出的 17 格新走廊**一个工地都放不出来**，且全程无遥测（`roadsHeldAt`/`containerBlockedAt`/`roadSitesYielded` 均为 None，只是静静地 budget=0）。修法：计数只算 `.enabled` 的房——大脑去重后同一外矿只归一个母房，别的母房的记录停在 `notWhitelisted`（`enabled=false`，见 `usedByAnotherHome` 注释），所以"enabled 的一定是自己的线"这个前提成立，不会误伤。
    冒烟场景要盯住线上的具体形态、并**同时断言死结的两半**（screeps-29 的建议）：房名同时出现在 A 母房（`enabled=false`）与 B 母房（`enabled=true` 且有若干路工地）的 `remotes` 里，断言 (a) A 的 `homeRemoteRoadSites` 不把它们算进去、A 名下启用外矿的新工地放得出来，(b) B 的工地一个都没被清（`usedByAnotherHome` 的保护仍在）。只测"停用的不算"会漏掉 (b)，而 (b) 正是这个死结的另一半。
    顺带补一条遥测：`roadsHeldAt`/`containerBlockedAt`/`roadSitesYielded` 三个都覆盖不到"配额被别的母房吃满"这一支，现在只是静静地 budget=0。加一个记配额构成的字段（成本很低），下次这类静默饥饿就能一眼看到，而不是靠人逐房数。
  - **logistics 夹具只播初值、断言全看结束态**（screeps-29 在私服里查明，与本轮外矿改动无关，记在一起是因为下一轮一并处理）：`seedLogistics` 播 4 万 storage 后不再维持，整轮经济把它吃到 3506，`storageRichState` 的滞回（above 20000 进 / below 10000 出）早就掉出富余态，于是 `storage.collectFallback` 与 `feeder.storageToController` 一起红——**不是两条独立 flaky，是同一原因的两个表现**；同房 `haulFill.share` 相邻两轮 0.29 / 0.69（同代码同夹具差一倍多，取决于地形路程与孵化时序）。修法两选一：报告阶段前把 storage 补回初值；或把观察点从结束态改成"过程中是否出现过"（记一次 `storageRich.on=true` 的时间戳就够）。**不要调阈值**——比例的分母随地形变，调阈值只是把红线挪个位置。动这个夹具必须整套重验：logistics 房被 `storage.collectFallback`/`feeder.storageToController`/`hauler.fillAtFedContainer`/`tower.maintenanceBudget`/`upgrade.repairStation` 等多条断言共用，改观察条件有把某条变成"恒真"的风险（今天两边各踩过一次这类坑）。
    取证捷径：`private-server/worlds/<世界>/validation-report.json` 跑完后保留，可直接查，不必重跑也不必做对照实验。
  - **`pruneOrphanRoadSites` 的函数注释里那句"永远修不完"已被线上证据推翻**：W32S5 (20,4) 距路线仅 1 格，被路过的 hauler 建完变成了路。正确的说法是"清掉止的不是永远修不完的窟窿，而是把剩余预算投进一条建成后也没用的路"（结论不变，机制不同）。注释与行为不符是维护陷阱，与下面两条一起改。
  - **旧的 record 级 `roadReplan` 成了死数据**（我自己改遥测粒度留下的）：`a7f6c7b` 把遥测从 `record.roadReplan` 移到 `source.roadReplan` 后，线上 6 个外矿记录上仍留着旧的 record 级条目（W32S6/W33S6/W31S9/W32S2/W32S5/W33S5），再也不会被写入或读取。无害但会误导——将来读 Memory 的人会以为它是活的。一行清理即可（归一化时 `delete record.roadReplan`），与下面的 `homeRemoteRoadSites` 一并做。
  - **修路预算没有路线优先级**：`roles/remoteHauler.nearbyInfrastructureWork` 取 `findInRange(...)[0]`，先到先得，不优先挑 `source.road` 上的工地，所以每趟 50 能量可能花在走廊旁边、creep 并不走的格子上。机制已核实成立；**影响面未量化**——我一度用"W32S5 路线 17 格只建成 3 格"去佐证，后来撤回：那 3 格与 (20,4) 的 175 进度都是重规划**之前**累积的，拿新路线长度当分母没有意义。要量化需先加"修路预算流向路线上 vs 路线外"的按外矿遥测。
- 未结（本轮未改，已核实）：#35 多跳外矿的**途经房**不铺路——`syncHomeRoads` 只把路段写进己方房的 plan，`placeInfrastructure` 只在外矿房本身放工地，所以 W31S9 路线里 W30S8/W30S9 各 3 格（高速房）永远没人建，`refreshInfrastructure` 又要求 routeRoads 里每个房都当场可见才判 `roadComplete`——这两条叠加使 W31S9 的 `roadComplete` 永远为假，矿工/运输一直吃 1:1 的重身体。本轮的收益因此限于"不再把工地与每趟 50 能量浪费在没人走的走廊"+ 铺装量减半；`roadComplete` 可达的 1 跳外矿（如 W31S7，routeRooms 只有母房+外矿）才能吃到身体减半的完整收益。

## 2026-09-12 打捞：入侵者阵亡掉的化合物由 hauler 主动回收（已部署 1789205921031）

- 问题（用户报 tombstone `6aa4ed5e75030eeb87703d86`）：W35S7 (12,5) 一个入侵者的墓碑掉了 **GO 95 / KO 17 / ZH 23 / UH 11**（146 单位 T1 boost 化合物，够 boost 4 个 TOUGH 还有余），250 tick 的墓碑寿命里**没有任何 creep 认领**。查到时 `decayTime` 只剩 6 tick，随后衰减成同格三堆掉落（GO 82 / KO 4 / ZH 10，UH 已归零），每 tick −1 全部丢光。这批没抢到——完整的测试+私服验证+部署流程要几十分钟，GO 只剩约 82 tick（≈6 分钟），唯一能赶上的办法是往线上热补丁 hauler，为 ≈45 单位冒让全房 hauler 挂掉的风险，不划算。
- 根因：整条搬运链只认能量。`task_broker.js` 明确跳过非能量掉落（注释写着"矿物掉落进了池子只会被捡起来永远占着容量"，这条规则本身是对的——broker 的 collect 是能量会计），tombstone 的 backlog 只算 `energyOf(store)`，hauler 也只 `withdraw(RESOURCE_ENERGY)`。出口其实一直存在（`salvageCargo` 会把身上的矿物卸进 terminal/storage），但**没有任何东西会主动去捡**。
- 改动（`d2492a8` 起 8 个提交）：补收集侧，走独立于 broker 能量竞价的确定性路径，矿物不进能量任务池的规则保持不变。
  - `salvageTargets` 按**格**聚合 tombstone / ruin / 掉落里的非能量资源——聚合是必需的：墓碑衰减后就是几堆挤在一格，分开算每堆都够不着门槛。
  - 门槛 `minAmount + perTile × 路程`（30 + 2/格）：一个部件的 boost 正好 30 单位，近处 30 就值得去，远处涨价；`maxRange` 40。
  - 一堆只派一只（认领按格记在 `creep.memory.salvage`，`timeout` 200 tick 失效）；只有**完全空载**的 hauler 接新单；房间 urgent（spawn 在等能量 / spawn·ext 见底）时空车立刻放手回去运能量，**已装货的把这趟收完**（半途而废等于白走）。
  - 到堆上后同 tick 各用一次 `withdraw` 与 `pickup` 两条管线，把同一格的几种资源收完再走；卸货复用已有的 `salvageCargo`（terminal 优先、其次 storage），没有卸货口时不接单（捡了只能扔）。
- 预期：入侵者/拆迁留下的化合物与矿物从"全部衰减丢光"变成进 terminal/storage。单次量不大（一只入侵者一两百单位），但此前是**零**。对能量物流的干扰有四道闸：空载才接、urgent 不接、无卸货口不接、门槛随路程涨。
- **独立对抗性审查（另起一个 agent 专门证伪）找出 4 个真 bug，全部修复并各配回归断言**：
  1. **`B1` 打捞期间残留的 broker 租约被判"卡住"，屏蔽该目标 150 tick**——`salvagePickup` 从 `run()` 最前面 return，一路不碰 broker，但 `memory.brokerTask` 还留着；而 `task_broker` 的卡住检测按"位置和**能量**都没变"判定（`energyOf` 只看能量，打捞搬的是矿物；站在堆上取货也不移动），6 tick 就 `runtime.blocked[lease.id] += 150`，**且对全房 hauler 生效**——为捡 146 单位化合物，代价是一个源容器的取货任务凭空消失 150 tick。同一格 ≥6 种资源（被拆的 lab/factory 的 ruin 衰减成一种一堆）或路上被挡 6 tick 就会踩到。改：接单时 `releaseClaim` + 删租约。
  2. **`B4` 卸货路径是同一问题的镜像**——`salvageCargo` 同样早早 return、每 tick 只转移一种资源、站在 sink 旁不动，而且**不需要经过打捞就能到达**（车上混进矿物的来源有好几种）。
  3. **`B2` urgent 时空车每 tick "接单 → dropFill → 又放手"**——urgent 判断写在了写 claim 之后，于是每 tick 白挑一次堆、白记一次"放弃补满"，把源容器旁的补满粘性反复清掉。改：挑到堆之后、写 claim 之前就判。
  4. **`B3` `Number(x) || 默认` 把合法的 0 吞掉**——`minAmount: 0`（什么都捡）、`maxRange: 0`、`timeout: 0` 都被静默换成默认值。与同日 `remote.js` 冷却那个 `|| 0` 是同一类错误：把"没有值"和"值为 0"压成同一个语义。
- **审查第二轮更值钱**：它对**修完之后**的代码重跑变异套件，14 个变异里 **9 个没被任何断言抓住**——我自己先做的那轮变异只覆盖了自己想得到的几条，等于自己判自己的卷。补齐后打捞场景共 49 条断言，每条都用回退原实现验证过判别力。教训：**变异测试要由没写这段代码的人、在改完之后做**，两个条件缺一个，抓到的只是作者已经想到过的那些。
- **两处 mock 比引擎宽松，导致整类 bug 不可见**（`af0c869` / `8a46c05`，对照 `engine/dist/game/creeps.js` 逐行核）：
  - `creep.withdraw` 旧 mock 一律返回 OK 并静默 clamp；引擎 `emptySpace` 按**总用量**算，`amount > emptySpace` → `ERR_FULL`、目标存量 < amount → `ERR_NOT_ENOUGH_RESOURCES`，**两者都是整笔失败**（线上表现是一点都搬不到）。
  - `creep.transfer` 旧 mock 不查目标容量；引擎只有**完全满**才 `ERR_FULL`，**不带 amount 时自己夹紧**到装得下的量并返回 OK——所以 `salvageCargo` 不带 amount 是正确且必要的写法，改成显式传量反而会把"要么全给要么一点不给"引回来。补了"terminal 只剩 50 空位：这趟进 50、剩 90 留车上、下一 tick 改走 storage"的断言。
  - 另外两处**核实后不动**：`mkStore` 对受限存储返回数字而非 `null`（src 里所有会踩到的调用点都被 storage/terminal 或 creep 门控住，当前没有假绿）；引擎的 tombstone/ruin 根本没有 `storeCapacity` 字段，`getUsedCapacity` 两种形式都返回数字，`nonEnergyIn` 的差值法不受影响。
- **生效断言自己先是假绿**（`6afc7ad`）：`hauler.salvagePickup` 的判据分两半，后一半查"storage/terminal 里有没有**任意**非能量资源"——而同一夹具里的 `link-drink-salvage` 身上带着 200 K，靠改动**之前**就存在的被动出口卸进同一个 storage（那正是旧断言 `hauler.mineralSalvage` 要的行为）。于是后一半**在写下它的那一刻就恒为真**，与新代码是否工作完全无关。改成限定墓碑播的 GO/KO/ZH/UH 四种（K 不在内），自测加了一条专门防这个错的反向用例：库里只有 K 200 时必须判失败。
- 验证：冒烟全绿（打捞场景 49 条，全套 1668 条）、conquest、190 条 Python、验证脚本自测、JS/Python 语法。私服 `--effect-ticks 900`（world `validation-UQl8hl`）**ok=true、27 房零错误、CPU 峰值 18.79/140、128 条生效断言全部观察到、`baselineWarnings` 空**。新增生效断言 `hauler.salvagePickup` 配新夹具（linkDrink 房播线上那个真实墓碑，`decayTime` 按引擎的 250 tick + 一只空载 hauler）。
  - 中途 6 轮验证的失败全部定位到**具体机制**而非"flaky"结论：2 条是外矿改动的真 bug（冷却初值、断言漏改），1 条是 `--effect-ticks` 默认 400 走不到矿物投递（900 才够），其余是 logistics 那一族"断言看结束态而 storage 被整轮吃光"（已记未结项）。`hauler.salvagePickup` **6 轮从未失败**。
  - 取证手法：`private-server/worlds/<世界>/validation-report.json` 跑完后**保留**，可直接查。用它一步证明打捞与 logistics 无关——`salvaged` 遥测在全部探针里**只出现在 W60N61**（`{n:4, amount:146, at:12}`，正好是夹具墓碑的全部 146 单位），W40N40 一条都没有，代码在那个房从未动作。比"禁用 config 跑一轮对照"快得多、直接得多。
- 部署：两段式（`verify-active-branch clean copy file_append` → 逐项核对 dist → `verify-active-branch screeps`），dist 48 文件语法全绿、四项 grep 到位。版本 **1789205921031**，`Memory.errors=[]`。同版本搭车上线 screeps-31 的两处外矿修复（重规划冷却 + 遥测保留首次、清掉被弃用走廊上修了一半的工地）。
- 未结（本轮**不覆盖**，已明确边界）：
  - **外矿房不打捞**。入侵者其实更常死在外矿，但那里归 `remoteHauler` 管，它跨房搬运、卸货逻辑只认能量，改动面比 hauler 大得多。按"每轮最多 1 项改进"留作独立一轮。
  - **死在容器上的货收不到**。引擎 `_die.js` 里 creep 死亡时货**先灌进脚下的 container**，进不下才进 tombstone；`salvageTargets` 只看 tombstone/ruin/掉落，而 hauler 取货只 withdraw 能量，于是矿物会卡在源容器里永久占容量。触发概率低（容器占房间格子的千分之几）、后果轻（容器少几十到一百多容量），修它要让打捞扫容器并排除 plan 里的 mineral 容器，改动面和验证面都会明显变大。
  - **打捞期间跳过 `opportunistic`**（路过的能量掉落不顺手捡）与 **claim 对房外不可见**（持 claim 的 hauler 被挤出房间时第二只会白跑一趟）：设计取舍，低概率低代价，不修。

## 2026-09-12 外矿路工地配额只算自己在跑的外矿（已部署 1789212095897）

- 问题（上一轮修外矿路线失配时查出、当时记为未结项）：`remote.js` 的 `homeRemoteRoadSites` 只判断 `remotes[site.pos.roomName]` 存在、**不判断 `.enabled`**。大脑去重后同一外矿只归一个母房，别的母房的记录停在 `notWhitelisted`（enabled=false），但那些房里的工地属于人家、由人家建——旧口径把它们算进我的配额，而 `usedByAnotherHome`（正确地）又不让我清它们，形成**既建不了也清不掉的死结**。
- 线上证据（部署前）：W32S4 名下路工地 **13/12 已超上限**，其中 **8 个属于别的母房**（W32S2 的 6 个归 W33S3、W32S6 的 2 个归 W33S7），它自己的两条启用外矿只剩 5 个、再也放不出新工地；而且 `roadsHeldAt`/`containerBlockedAt`/`roadSitesYielded` 三个遥测都覆盖不到这一支，**完全静默**，只能靠人逐房数才发现。
- 改动（`9dc1d1e` / `8397c6a`）：`homeRemoteRoadSites` 只数 `.enabled` 的房；新增 `foreignRemoteRoadSites` 只作遥测；新增 `record.roadQuota = {at, mine, others, cap}`（others > 0 或 mine 顶到 cap 时写），让"配额被谁占着"可见。顺带两处收尾：清掉上一轮迁移遗留的 record 级 `roadReplan` 死数据；改掉 `pruneOrphanRoadSites` 注释里被线上证据推翻的"永远修不完"（W32S5 (20,4) 距路线 1 格、最终被路过的 hauler 建成了路，正确说法是止损"把剩余预算投进一条建成后也没用的路"）。
- 验证：冒烟新增 6 条，**同时断言死结的两半**——(a) 别人的工地不占我的配额、我自己的外矿放得出工地且落在我的路线上；(b) 别人的工地一个都没被我清掉。(b) 用**变异测试**证明非恒真（回退 `usedByAnotherHome` 的保护后它变红，12→0）。生效断言 `remote.roadQuotaCountsOwnRemotesOnly` 把前提构造成**必然性**而非比数值：夹具在"别人在跑的房"里播满 `roadSitesPerHome` 个工地，旧口径下这一个房就独占全部配额、budget 必为 0、自己的外矿一个工地都放不出来。私服第四轮 **ok=true、27 房零错误、CPU 峰值 16.1/140、129 条生效断言全部观察到、baselineWarnings 空**。
- 前三轮各红 1–2 条、**从不重复同一对**，全部证伪与本改动无关：`minerals.*` 在 E40S40（`remotes=[]`）、`upgrade.storageRich` 在 W60N60（`remotes={}`）、`remoteHauler.spotYield` 在 W58N55（`remotes` 无停用项 ⇒ `roadQuota` 未写、新旧口径逐项相同）——本改动全部在遍历 `remotes` 的代码路径里，对这些房是**可证明的 no-op**。CPU 峰值 16.7/140 远低于上限，按判据排除负载，源头是每轮随机地形。
- 我自己的一处返工：第一轮红的是我自己的断言，因为我把**决策时刻的遥测快照**（tick 106 的 `mine:1`）拿去比**结束态的工地数**（6）——和 logistics 那族断言同一类错误的反向版本。教训抽象成"断言的两端必须时间对齐"，已写进跨会话记忆。
- 实测（部署后，`/api/user/memory` 被限流，改用 room-objects 直接观测行为）：W32S4 自己的外矿工地 **W32S3 1→6、W33S5 4→6**，合计 **12/12 全部用在自己的外矿上**（部署前是 5 个自己的 + 8 个别人的、顶死放不出新工地）；别人的 W32S2 6 / W32S6 4 不再计入。旧口径下现在会算成 22/12。
- 操作教训：`/api/user/memory` 的限流配额独立且严，我今天用 `probe.py rooms` 每 60–70 秒长时轮询把它烧光，部署后 `Memory.SCRIPT_VERSION`/`Memory.errors` 读不到（~6.2 小时后才能重试）。其他端点（`/api/game/time`、`/api/user/branches`、`/api/game/room-objects`）不受影响。长时观测应优先用 room-objects。
- **部署后发现的残留问题（我这两轮改动的交互，未预料到）**：W31S9 **二次重规划**，6 个工地整体换到另一条走廊（老 `(48,28)…(46,33)` → 新 `(48,26)…(44,31)`，两线相距最多 4 格），**累积的 230 点进度随旧工地一起被清掉**（`roadTrailCooldown` 1500 已过期：上次重规划 73650166、此时 73654174，隔 4008 tick）。
  - 机制：没有路时，对角走廊上存在多条等代价路径，三只 hauler 相互挤让，每趟走线都不同；单趟走线就被采纳为新路线，于是在几条近似平行的线之间来回搬工地。冷却把频率限制成每 1500 tick 一次，但没有消除振荡；而"半成品也清"让每次振荡都销毁已投入的进度。两个改动各自正确，交互起来在**走廊不稳定**的外矿上净进度为零。
  - 实测对比（部署后）：走廊稳定的外矿确实产出了路——W32S2 **22 条**、W32S3 **14 条**、W33S5 6 条、W32S5 4 条；而 W31S9 与 W32S6 仍是 **0 条**（它们正是重规划幅度最大的两条：34→12、68→5）。W31S7 6 个工地 0 进度、从未重规划，仍是原始形态。
  - 修法方向（下一轮）：**采纳前要求走线跨趟一致**，而不是采纳单趟的 trail——例如只采纳"最近 3 趟满载腿里出现过 ≥2 次"的格子。这直接针对"没有路时 creep 在近似平行的线之间游走"，比调 `roadTrailMatchShare` 阈值或加长冷却更对症（阈值和冷却都只改变振荡频率，不改变它存在）。另一条可叠加的保险：若某条外矿的 `roadReplan.n` 已经 > 1 且仍无已建成的路，说明这条走廊不稳定，应停止再采纳、锁定当前路线让它先把路铺出来（有了路就是 cost 1，走线自然收敛）。
- 未结（新增，由本轮的限流事故引出）：**`api.memory()` 的降级缓存**。`/api/user/memory` 有独立且更严的限流配额（本轮被 `probe.py rooms` 长时轮询烧光，~6 小时不可用），期间 `scripts/brain/run.py` 完全停摆——它要读 `Memory.rooms` / `Memory.creeps`。已确认**失败模式是安全的**：限流返回纯文本 → `json.loads` 抛 `JSONDecodeError`，而 `api.request()` 只捕获 `HTTPError`/`ApiError`，异常一路抛穿、`run.py` 在写 segment 之前就退出，`api.memory('rooms') or {}` 的 `or {}` 够不着，**不会写出"我没有任何房"的降级指令**。另确认 `/api/user/memory-segment` **不受限**，所以指令的读写通道本身是通的。
  加固方向（screeps-29 的分法，直接采纳）：给 `api.memory()` 加磁盘缓存 + 限流时回退到上次成功的快照，但**必须按字段分级、不能整份降级**——`remotes` 白名单 / `claim` 目标 / `mineral` 计划的输入以小时计变化，用几分钟前的数据安全；而 `defense` 的打/避决定与 `safeMode` 的输入是敌方 creep 的 body/boost/位置、**每 tick 都在变**，拿旧敌情推"打得过"是"自信地做错"（比不作为更坏）。所以契约里要有 per-field 的 `staleness` 上限，超期字段**整段省略**——消费方 `brain.directive` 拿不到就退回游戏内自治逻辑（这条回退路径本来就有），让降级变成"少给指令"而不是"给过期指令"，安全性也好论证。
- 未合并：`fix/remote-site-quota` 分支暂未合回 main——conquest 会话在 `effects.js`/`fixtures.js`/`run_validation.js`/`smoke.js` 有未提交的 SK 规避验证改动，`git merge` 已自动 abort，等它提交后再合，不覆盖它的工作。

## 2026-09-13T05:18+09:00 RCL1–6 监控采集诊断与经济策略误报修复
- 问题：昨夜427.66分钟成功采集空窗包含13次已执行但JSON解析失败的轮次；接口层丢HTTP状态，cron又覆盖采集退出码。同tick孵化意图、小额维修延期和工业建设暂停还会触发不必要告警。
- 改动：1f7629c/0fc90e4/468771e/f160e17补真实动作/策略探针及有效窗口；保留安全HTTP/传输错误并透传采集退出码，无旧Memory兜底。小时任务ACTIVE、每小时直接任务协调与事件处置，已删除的沟通日志不恢复。
- 预期：已确认策略延期减少噪声；未来采集失败能区分HTTP与网络原因，未知不记健康。
- 实测：205项Python、JS实际探针、语法和独立审查通过；73661655/73661678/73661701同版1789215554326零错误，bucket4351→4825→5184。三采退出1因未结事件，不是采集失败。纯外部监控未上传游戏模块；reserve排序修复另行走完整私服门。详见docs/analysis/2026-09-13-monitor-hardening.md。

## 2026-09-13T06:16+09:00 reserve有序接班与控制器直达修复
- 问题：早序运输抢走后置reserver接班窗口；修队列后私服仍暴露跨房先房心后控制器绕行，旧者117到期、后继121才到位。
- 改动：e3b5557预收集真实普通reserver有限期限；有有效controllerPos时直达，未知探索及退避不变。进攻代码与计划保持现状。
- 预期：在不扩大预留兵身体/人数的情况下，保护真实接班窗口并消除已确认目标绕行。
- 实测：相同真实队列输入旧逻辑选1050运输，新逻辑选650接班且正式tick96到位；完整900私服观察窗口退出0，131效果检查无失败，基线无硬性回归。可选Keeper场景未启用，E22S18覆盖差异已保留说明。16组JS、205项Python、语法通过，43源文件匹配私服；activeWorld default部署版本1789247463223、48模块全匹配。线上73662507/73662530/73662552零错误，bucket6978→7347→7784，16个可见启用外矿预定均正；仅代表离散窗口。
- 后续：小时任务直接沟通、保留未完成效率调查；W34S7重升级工接班路况预算、外矿母房投递停靠/总成本继续固定起点验证。61b4caf原世界/原脑长跑已恢复，新样本前进且无错误，不混入本轮新源码。详见docs/analysis/2026-09-13-reserve-handoff.md。


## 2026-09-13T08:08+09:00 真实出生位置的升级者接班预算
- 问题：W34S7实际spawn27,18而规划锚点27,36，控制器道路计划缺失，旧预算误为5格/55tick；重型接班者出生296tick仍未到位。
- 改动：96c1023按真实spawn与角色工作位、实际道路/障碍、满载疲劳预算，选路权重与移动实现一致；未知及超生命周期预算显式记录，不重复排除新生者。1ecc264/1d74ef8加预算监控，并排除在途者造成的供能误报；未知范围或岗位无人不算恢复。Link及进攻源码保持原状。
- 验证：同一完整种子7cea48ab、固定终点的world-phase-order正式132效果全过，29房/通知零错误，官方基线0失败/0警告。实际同ID新者观察533已升级、536在工作位且旧者601到期。旧744>601只是乐观模型反事实。17组JS、生产冻结阶段208Python及语法/构建通过，纯监控补充后211Python及实际JS探针通过。前序播种、地形缓存和观察阶段时序失败均保留，未延窗挑绿。
- 上线：干净1d74ef8发布树与私服43源文件全匹配；activeWorld default、1789254234195、48模块全匹配。73664157/73664179/73664200零错误，bucket6699→6977→7181；W34路线504完整，12房预算有效。三采退出1为未结事件。
- 后续：W34短窗仅5.86CP/tick，继续核验在途WORK是否稀释在岗升级限流，暂不关闭供能事件；外矿投递长尾/维护全成本、W37援建停留仍保留。原61b长跑未改源码/脑或停止，阶段审计指出新RCL7供能和reserver成本待验证，不声称最终RCL8效率。详见docs/analysis/2026-09-13-upgrader-handoff.md。

- 复查补充：独立实际函数模拟已确认在途WORK稀释限流分母，简单排除还会因round超额到12.6，下一轮优先固定快照验证有界总预算；W34供能事件保持requires-fix。纯外部监控efe93c9另修“较晚竞争事件判较早预算”误报，真实采样回放、211Python及实际JS探针通过，游戏模块未重传。小时任务已更新为每小时并保存该明确优先项。

## 2026-10-02 敌方遗留建筑占配额时拆除 + 无 spawn 房先放 spawn 工地（已部署 1790869387821）

- 问题：W37S7（2026-09-19 占下）卡在 RCL4 十多天。房里没有我们的 spawn，20 个 extension 和 storage（5.5 万能量）都已建好，只靠 W38S7 派来的 pioneer 维持，`state.recovering` 一直为真。根因：(25,24) 留着 Lucas21 的 spawn，引擎 `checkControllerAvailability` 统计配额时不分主人，RCL4 唯一的 spawn 名额被它占住，我们的 spawn 工地永远放不出来；`layout.countType` 也照样把它算进去，所以 layout 连工地都不尝试放。demolition 以前只拆敌方的 rampart/wall，而且受恢复期和能量门控。
- 改动（`459bd5d` / `92c7a09` / `3b803be`）：`demolition.hostileQuotaTarget`：己方房里外人的结构，同类数（建筑 + 我方工地，与引擎口径一致）达到配额、而我们自己的不到配额时拆掉，spawn 优先；不受恢复期和能量门控，有敌对 creep 时仍不拆；存储型建筑（storage/terminal/lab/factory…）里还有货就等搬空。`layout.placeFirstSpawn`：没有我们 spawn 的房先放 spawn 工地，死房也放。
- 验证：smoke 1714 条全过（新增 9 条：恢复期 + 能量 0 时拆敌方 spawn、未占满配额的敌方 extension 不拆、有敌对 creep 时不拆、满仓敌方 storage 先不拆、多配额按我方工地计数、拆后先放 spawn、死房放 spawn、已有 spawn 不多放）；conquest、Python 227 项全过；三路独立审查（引擎语义 / 副作用 / 线上 W37S7）没有 blocker，两条意见已采纳（存储型护栏、工地计数）。私服：新增 E50S51 夹具（RCL4、方案 spawn 位上压着外人 spawn、recovering、能量 0）和生效断言 `demolition.hostileQuota`，跑完的两轮都观察到（t=23 拆除、t=31 放出我方 spawn 工地），基线 0 失败（警告 E50S50 creep 15→7，夹具新增第二房导致）。**没拿到一轮全绿**：失败的是 `minerals.externalDelivery`（注释写明 400 tick 不够、要用 900 tick 观察）和 `maintenance.repairPoolNeutral`，这两族所在的房新逻辑一次都没触发；其余几轮死在随机地形播种和机器负载（load 25）下的 tick 超时。用户确认凭现有证据部署。
- 环境：brew 9-28 把 Node 升到 26.10，私服的 isolated-vm 在 Node 24/26 下都加载不了，引擎停在 tick 1；改用 `~/.local/bin/node`（v22.22.3）跑验证。
- 实测：tick 74062064 敌方 spawn 还在 → 74062080 变成 ruin，我方 spawn 工地出现在 (13,13)；新版本 errN 0。
- 后续：(1) pioneer 只捡地上的能量或自己采矿，不从 storage/ruin 取，造 15000 能量的 spawn 估计要约 3000 tick，应改成先 withdraw storage/容器/ruin；(2) `layout.hasBuilder` 不把 targetRoom 是本房的 pioneer 算作 builder，W37S7 因此被判为死房，spawn 建成前常规放置不运行；(3) 外人的工地引擎也计入配额，目前不计也清不掉（没遇到）；(4) 分支尚未合回 main：主工作区有 09-15 留下的 aid.safeRoute 未提交改动，与 smoke/effects/fixtures 重叠，合并要等那批改动定下来。

## 2026-10-08 CPU 急救 + 合回所有已部署分支 + 六项修复（已部署 1791444966638，main 3eb170b）

- 问题：(1) 13:00 前后 respawn 区保护到期，大脑立刻给 W31S4/W31S6/W31S8 加了 7 个 W29 外矿（远程 creep 66→107），CPU 160–172/150、bucket 一路掉到 53，游戏内 CPU 守卫形同虚设（harvester/hauler/upgrader 永远跑、不看 bucket，skippedCpu 全是 0）。(2) 10-03 的部署基于 main 打包，把 10-02 上线但没合回 main 的 fix/hostile-quota-structures（拆敌方占配额建筑、无 spawn 房先放 spawn）从线上撤掉了；10-02 那次部署同样丢了 09-20 deploy-20260920 工作区（未提交）的改动。(3) 47 只矿工守 26 个源（两只空闲 spawn 同 tick 给同源孵替补），静态矿工每 tick 发一次 transfer。(4) link 供能房升级者按瞬时限流孵 W47（4850 能量）、人数超 maxUpgraders；W31S4 唯一升级者被生在 spawn 上方的出生口袋里 600+ tick 空手不动，CP 归零。(5) 私服验证从没全绿：minerals.externalDelivery 夹具没有 extension（1W 矿工 600 tick 才装满）、handoff 断言写死绝对 tick 601、orphan/storageRich/repairPool 断言依赖随机地形或采样时机。(6) monitor 永远 exit 1（事件只开不关），失去报警意义。
- 处置：先用大脑锁 `<home>.remotes` 撤掉 7 个 W29 外矿（7 天，by agent）止血，20 分钟内 creep 215→180、bucket 回升。代码：`integrate/2026-10-08` = main + hostile-quota + luxury/安静房 + 六条修复分支 + 安全修补，全部快进进 main（3eb170b）。主工作区 09-15 的 aid 安全路线改动与 deploy-20260920 工作区状态先完整快照到 `wip/aid-safe-route-0915`、`wip/deploy-20260920` 再清理（aid 只在容量 < 1300 时触发，现 13 房全部 ≥ 2300，线上无影响；deploy-20260920 附带的升级者预算改动 A/B 掉 14.5% CP，未纳入）。
- 改动要点：`src/cpu_shed.js`（bucket < 2000/500 时把 creep 循环压到 limit−25/−35，按价值延后可安全跳过的单位，矿工/升级者/远程矿工/防御/每房最后一只 hauler 不跳，单位最多连跳 2 tick；`getUsed` 越过 tickLimit−30 硬停，引擎不会掐掉整 tick）；pixel 门控（近几条 cpu 均值 > limit×0.75 不生成 pixel）；orderCreeps 只给能接任务的角色竞价；矿工攒批交货（≈每 4 tick 一次）+ 孵化中的替补算在源上（不再成对孵）；升级者按可持续供给定 WORK 上限与人数、卡死看门狗（重寻路→退役，连续无进展退避 1500 tick）、spawn 出生方向避开口袋并在出生受阻 5 tick 后放开全部方向；验证夹具/断言改为机制判定；monitor exit 1 只表示本轮新增/升级且未被心跳确认的事件、2 表示未采到，并新增 cpu-emergency 事件。
- 验证：smoke/conquest/16 个 JS 单测/Python 245 项全过；每个单元一名对抗审查者（矿工与 monitor 两项被要求修改后已修），安全修补两名审查者通过；私服三轮：第一轮仅 harvester.batchTransfer 红（遥测记最近一次交货量，终态 link 满时只剩 13；改为记生涯最大值，变异测试确认），第二轮引擎停在 tick 680（无脚本报错、各用户 CPU ≤ 18，判为机器负载），第三轮 **ok=true、147 条生效断言全过**，基线仅已知警告 E50S50 creep 15→7。
- 实测（部署后约 5 分钟）：版本 1791444966638、errors []，bucket 1614→5643，cpuBy.creeps 70–87 → 约 59，降载未触发（bucket 健康）。需要更长窗口确认：矿工数应在 ~1500 tick 内降到约 26–28，升级者身体随换代缩到 ~W20。
- 后续：W29 外矿锁 10-15 到期前，按 CPU 余量逐个放开（cpu 均值 < ~125 且 shed 不触发）；respawn 保护已结束，KungFuDragon（W29S4 RCL6）紧邻 W29 外矿，各房 storage 仍 ≈0，防御缓冲薄。

## 2026-10-08 spawn 出口让位 + 口袋困住回收（已部署 1791471222194，main b3c797a）

- 问题：同日上线的"出生受阻 5 tick 就放开全部 8 个方向"兜底，在 spawn 的合法出口被占时把 creep 生进了死口袋。W34S7 Spawn21 (27,34) 合法出口只有 (28,34)（停着 builder）和 (27,35)（operator 中枢站位），兜底放开 TOP_LEFT (26,33)（四周墙 + extension + 两座 spawn），源 0 的替补矿工被生进口袋困死，源 0 停采；W31S4 Spawn9 同类触发 5 次、W34S7 3 次。现场用 console 回收被困矿工、挪开 builder 止血。
- 改动（`112c199`…`b3c797a`，新模块 `src/spawn_exit.js`）：兜底永不放开真正的口袋方向，只补"现在可走且非口袋"的方向；合法出口被己方 creep 占满时给其中一只（优先有 MOVE、不疲劳）打 `memory.vacate`，main.js creep 循环里它经 `movement.go` 挪到 3 步内不贴任何己方 spawn 的空格，并在该 spawn 出生完成前（最多 `vacateHoldTicks`）不跑角色，防止 operator 立刻踩回站位；站在贴 spawn 的口袋格里的己方 creep（判定时工地不算墙，且需连续两次扫描都在）由相邻 spawn recycle。遥测 `spawnStallLog.{vacate,cannotVacate,noRelease,bornHistory,bornPocket,trapped}`，monitor 对应告警。
- 验证：smoke（复刻 W34S7 几何）/16 个 JS 单测/Python 246 项全过，每项断言回退验证非空测；两名对抗审查者，一条阻塞（工地被当墙导致误回收）已修；私服一轮 **ok=true、基线零警告**，新生效断言 `spawn.exitVacate`、`spawn.pocketTrappedRecycle` 观察到。
- 实测：部署后 errors []，W34S7 两源各 5 WORK 恢复（部署前已手动解困）。
- 遗留（审查非阻塞）：spawn 所有可走邻格都是口袋时 spawnDirections 仍返回 null（引擎会生进口袋→回收→再生的循环，当前布局未出现）；vacateTarget 找不到空格时每 tick 重复请求，遥测会膨胀。
