# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 项目记忆 — Screeps AI 工作区

本工作区开发 Screeps（MMO 编程游戏）的 JavaScript AI，目标是成为 Screeps 里所有方面都最强的玩家。游戏代码在 `src/`，通过 grunt 上传官方服务器（shard1）；外围是 Python/Node 的运维、外部大脑、私服验证与 soak 工具链。

回答任何 Screeps API 或游戏机制问题前，**先查阅 `docs/`**，不要凭记忆回答 API 细节。

## 常用命令

### 测试与检查（改动游戏代码后全部必跑）

```bash
node test/smoke.js                                        # mock 引擎 + 真实 W33S7 地形的冒烟测试（500+ 断言，单文件顺序执行，无过滤参数）
python3 -m unittest discover -s test -p '*_test.py'      # 外部大脑 / 监控的单测
python3 -m unittest test.brain_test.PlanTest.test_plan_home_shape   # 单个 Python 用例
node test/private_server_run_validation_test.js          # 私服验证脚本自身的单测
node test/conquest_test.js                                # 攻占子系统单测（conquest / siegeDismantler / siegeGuard / downgrader / boost，独立于 smoke）
for f in src/*.js src/roles/*.js; do node --check "$f"; done          # JS 语法
python3 -m py_compile scripts/*.py scripts/brain/*.py scripts/soak/*.py scripts/report/*.py test/*.py   # Python 语法
```

`test/smoke.js` 是一整个脚本：`console.log('== 场景名 ==')` 分段、`assert(cond, msg)` 累计失败数、末尾 exit code。要跑"单个"场景只能临时注释或把场景移到最后，没有 grep 过滤。**新增 `src/` 模块时必须同步加进 `test/smoke.js` 顶部的 `MODULE_MAP`**（扁平模块名 → 源文件），否则冒烟里 `require` 找不到。

### 私服验证（部署前必过）

```bash
bash scripts/private_server/setup.sh                     # 一次性：克隆并安装 screeps 私服到 private-server/server/
node scripts/private_server/run_validation.js            # 新建 validation 世界，播种全部场景，1 ms tick 跑完并断言
node scripts/private_server/run_validation.js --keep-running --game-port 21025   # 留着服务器给 Steam 客户端看（Change server → 127.0.0.1:21025）
```

场景（`scripts/private_server/fixtures.js`）：bootstrap、recovery、logistics、links、blueprint（轮子方案）、industry、remote、conflict（拆迁）、brain（真实跑一轮外部大脑）、defense、aid（同一用户的母房 + 弱房，`roomContextFor` 造第二个房）。断言在 `run_validation.js` 的报告阶段：每房 `Memory.errors` 为空、stats/探针存在（探针按房记在 `Memory._validationRooms[房]`）、各场景特定的 Memory 状态。已有的 validation 世界不会被覆盖，重跑就是新目录。

**通过标准（2026-09-06 起）**：不崩、不报错只是底线，还必须满足两条——(1) **改动生效**：每个游戏代码改动都要在 `scripts/private_server/effects.js` 里有一条生效断言（id/日期/改动说明/check），在私服里观察到新行为（需要新场景就在 `fixtures.js` 播种；报告阶段全部执行，任一未观察到即失败），没有生效断言的改动不算验证通过；(2) **无回归**：与上一次通过的基线（`data/validation/baseline.json`，本机、不入库，`scripts/private_server/baseline.js`）对比，某房 creep 归零、新出错误、RCL 下降算引入新 bug（失败），creep 数掉过半只警告。基础等待之后再多跑 `--effect-ticks`（默认 400）让效果显现。

### Soak 模拟（线上快照 → 私服长跑 → 不变量分析）

```bash
python3 scripts/soak/capture_live.py --rooms W33S7,W34S7,...   # 抓地形/建筑/Memory 到 data/soak/live_snapshot.json
node scripts/soak/soak.js --ticks 3000 --sample 25             # 私服里复现并采样到 data/soak/run-<时间>/samples.jsonl
python3 scripts/soak/analyze.py data/soak/run-<时间>/samples.jsonl   # 按规则（卡死、出口乒乓、工地停滞、能量堆积…）列出可疑区间
```

`src/soak_probe.js` 随 bot 上传，只在私服 console 调 `soakProbe()` 时写 `Memory._soak`，线上零开销。

### RCL 基准（从单 spawn 跑到 RCL8，量每级 tick 数与能量账）

```bash
node scripts/soak/rcl_benchmark.js --src-rev <线上提交> --out data/soak/rcl-bench-<名>   # 30 房真实地形只播中立对象，W33S7 (23,21) 一个 300 能量 spawn、空 Memory、GCL 按账号（--gcl 12）；每 50 tick 数据库侧记账，升级 tick 插值；每 5000 tick 跑一轮外部大脑（允许占领，--lock-claim 只测单房）；CLI 挂掉自动重启同一世界，--resume <out> 续跑
python3 scripts/soak/rcl_report.py data/soak/rcl-bench-<名> --out docs/benchmarks/<日期>.md   # 母房每级用时/能量账/三种理论下限与效率/浪费点，账号总 CP 增速曲线、占领时间线、外矿净收益
python3 scripts/soak/rcl_dashboard.py --run data/soak/rcl-bench-<名> --port 8765            # 实时看板 http://127.0.0.1:8765/（标准库 HTTP，增量读 progress.jsonl，5 秒自刷新；/api/state 给 JSON）
python3 scripts/soak/rcl_ab.py data/soak/rcl-fork-<A> data/soak/rcl-fork-<B> --rooms W33S8,W35S7 --out docs/benchmarks/<日期>-ab.md   # 同一快照的分叉对比（--fork-world/--fork-db 各跑一个 rev）：全账号 CP/tick、每房 CP/RCL/storage 起止、重点房 storage 曲线、无 spawn 房的 spawn 工地 vs 道路工地进度
```

账目全部来自 `storage.db`（源 `invaderHarvested` 增量 = 采集，按房分账；用户 `gcl` 点数增量 = 账号总 CP，各房再按控制器进度分账；首次见到的 creep 身体 = 孵化，按角色/母房分账；工地进度 = 建造），不依赖 bot 自报；原始采样几十 MB，已 gitignore，只归档报告到 `docs/benchmarks/`。世界目录名在 `<out>/run.json`，另一会话起私服前先看一眼，别 kill 它。

### 构建与部署

```bash
npx grunt                      # 默认：activeWorld 预检 → clean dist → 扁平化 copy → 注入版本 → 上传 default 分支
npx grunt --ptr=true           # 推到 PTR（跳过 activeWorld 预检）
npx grunt --branch=xxx         # 推到指定分支（预检要求它就是 activeWorld，否则终止）
```

- `src/roles/harvester.js` 被扁平化为 `dist/roles_harvester.js`，所以代码内 `require('roles_harvester')`；`vendor/wheels/` 的两个第三方包也在 Gruntfile 里显式拷入 `dist/`（运行名见 `docs/wheel-integration.md`）。
- `src/version.js` 是空文件，grunt 注入 `global.SCRIPT_VERSION = <时间戳>`；`main.js` 对比 `Memory.SCRIPT_VERSION`，console 出现 "New code uploaded" 即部署生效。
- 凭证在 `.env`（`SCREEPS_AUTH_TOKEN`、私服用 `STEAM_API_KEY`），照 `.env.example` 命名；POST /api/user/code 每天 240 次。推送**整体替换**目标分支。
- **分支陷阱**：游戏运行 `activeWorld` 分支，不一定是 `default`。`GET /api/user/branches` 核对；切换要带全参数 `POST /api/user/set-active-branch {"branch":"default","activeName":"activeWorld"}`。预检是 fail-closed 的，不会自动切分支。

### 线上运维

```bash
bash scripts/api.sh GET /api/user/branches               # token 认证的 curl 封装：METHOD PATH [JSON]
python3 scripts/probe.py rooms.W33S7.state               # 读 shard1 Memory 子树（处理 gz: 前缀）；也可 import：read_memory / console / api
python3 scripts/monitor.py                               # 采集一轮快照追加到 logs/status.jsonl；exit 1 = 本轮新增/升级事件，0 = 无新情况，2 = 未采到
python3 scripts/brain/run.py --homes W33S7 --radius 2 --dry-run   # 外部大脑：只看规划；--write 写 segment 90
open data/brain/dashboard/index.html                     # 监控面板：外部大脑每轮用已读数据更新（零额外 API），各房 CP/ETA、采集 vs 理论上限、维持成本、外矿；改模板后 python3 scripts/brain/dashboard.py 重渲染
python3 scripts/report/collect.py && python3 scripts/report/build_report.py   # 会话数据 → data/report/report.html
cd reference/screeps-docs && git pull && cd - && bash scripts/sync-docs.sh    # 更新 docs/
python3 scripts/observe/run.py all --player Kalgen --self   # 观察顶级玩家：快照 → 摘要 → docs/observe/kalgen.md（launchd 每 6 小时，见 scripts/observe/install_schedule.sh）
```

- **console 结果不直接返回**：`POST /api/user/console` 只回执排队。探针模式：console 里 `Memory._mon = JSON.stringify({...})`，几 tick 后 `probe.py _mon` 读。
- `GET /api/user/memory` 不带 shard 默认 shard0，本账号在 shard1。
- 账号：shard1，母房 W33S7（spawn (23,21)，双源），2026-09-03 起占领 W34S7。当前线上版本以 `logs/optimizations.md` 最新条目和 `Memory.SCRIPT_VERSION` 为准。

## 架构

### Tick 流水线（`src/main.js`）

每个模块调用都包在 `try/catch` 里，异常进 `Memory.errors`（`utils.logErr`），单点故障不拖垮整 tick。loop 顶部统一兜底 `Memory.creeps/rooms/map/errors`（respawn 后 Memory 是 `{}`，任何 `Memory.rooms[x]` 直接访问都会崩）。顺序：

1. `movement.beginTick()` → `taskBroker.beginTick()` → `brain.run()`（读 segment 90 指令）→ `wheelLayout.autoPlannerByFlag()`（RP/VP/SP flag）。
2. 每个己方房 `runRoom`：`assessRoomState`（写 `mem.state`：recovering / emergencyHarvest）→ `remote.run` → `expansion.run` → `spawnMgr.run` → `layout.run`（每 `layoutInterval` tick，按房名错峰）→ `demolition.run` → `tower.run` → `links.run` → RCL6+ `industry.run`（`industry.labPlan` 每房每 tick 一次：lab 分工存 `labRoles` 跨 tick 稳定，反应按 `industry.boostTargets` 自底向上找做得起的那一步（`nextReactionFor`），做不了退回机会主义配对；三连外的 boost lab 攒够 `labBoostStock` 就装一份；`roles/labTech.js` 照计划搬矿（canSpend 闸开着且有活时 opportunistic 孵 1 只），runReaction 只在两个输入都装好时发）；然后 `visuals.render`。
3. creep 分发：`taskBroker.orderCreeps` 排序；CPU 超过 `limit - cpuReserve` 时跳过低价值单位（bucket 吃紧时 `cpu_shed` 降载）；`getUsed` 越过 `Game.cpu.tickLimit − cpuShed.endReserve` 就硬停、剩下的 creep 这一 tick 都不跑（引擎超 tickLimit 会掐掉整个 tick），遥测 `Memory.cpuHardStop` 与 `stats.shed.hard/cut`；`spawnMgr.retireReplaced` 让被大身体替换的旧 creep 退役（退役统一走 `retire.retireAtSpawn`：寿命够就走到全账号最近的 spawn `recycleCreep`，否则 suicide；编制计数用 `utils.isRetiring` 排除退役中的 creep）；必需部件全阵亡的残废 creep（`utils.crippledParts`：矿工没 WORK、hauler 没 CARRY/MOVE、占领没 CLAIM…）由 `retire.retireCrippled` 观察 `retire.crippledGrace` tick（本房塔会治）后标记 `crippled` 同样回收，母房记 `crippledLog`；`emergencyHarvest` 状态下 WORK+CARRY creep 走独占的 `runEmergencyHarvest` 分支，否则按 `creep.memory.role` 派给 `ROLES[role].run`。
4. creep 循环之后（cpu_shed 降载或硬停过的 tick 跳过）`market.run`（`src/market.js`：每 `market.interval` tick 在 storage 富余的房把 terminal 里超过 `keep` 的矿物按别人的买单 `deal` 掉，价格底线 = `getHistory` 近期均价 × `priceFloorShare`，一轮一单、最多 `maxScans` 次 `getAllOrders`，`Memory.market`）→ `terminalNetwork.run`（`src/terminal.js`：每 `terminalNetwork.interval` tick 从 storageRich 且 storage+terminal ≥ `sendAbove` 的房 `terminal.send` 能量到 ≤ `receiveBelow` 的己方房，留 `keep` 与给市场传送费的 `feeReserve`，`Memory.terminalNetwork`；这一轮没有能量要发时改做一笔基础矿调剂：余量 > `mineralKeep + mineralWant` 的 terminal 发给有 ≥ `mineralLabs` 个 lab、这种矿不足 `mineralWant` 的房，`Memory.terminalNetwork.mineral`，市场不卖这些缺着的矿；两者 bucket < 各自 `minBucket` 不做、同一 terminal 一 tick 只用一次）→ `sampleStats`（每 30 tick 写 `Memory.stats`，保留 80 条；角色计时每 `cpuProfile.sampleEvery` tick、分发阶段 `cpuDispatch` 每 `cpuProfile.dispatchEvery` tick 且降载中不量，`cpuSampled` 记两者的抽样数）→ `taskBroker.flush()` → bucket 满且 `Memory.stats` 最近几条用量均值 ≤ `limit × pixel.maxCpuShare` 时 `generatePixel`（否则记 `Memory.pixelGate.skip`，bucket 留作缓冲）→ `finally movement.endTick()`。

### 孵化需求管道（`src/spawn.js` + `src/spawn_queue.js`）

spawn 不按固定 roster 硬算，而是把所有来源的需求统一成请求 `{key, role, priority, grace, body(budget), strategic, jumpable, blocking, opportunistic}` 交给 `spawn_queue.schedule`（纯函数，设计见 `docs/superpowers/specs/2026-09-04-spawn-queue-design.md`）。优先级类：defense → survival（源矿工、第 1 只 hauler、底线 upgrader；核心替补的能量预留紧随其后）→ expansion（claimer/pioneer，一次性且有占领窗口）→ remoteMaintain（容器已建成的外矿的矿工/reserver/hauler 替补）→ development（弹性 hauler/upgrader/builder）→ aid → remote（新外矿开路、矿工换代、弹性矿工）→ opportunistic（富余 upgrader、scout）。队头买不起时用 spawn 能量增速的 EMA 估计多久能攒够：宽限（`config.spawnQueue.grace`，从请求首次出现起算）内攒得够就等并为它保留能量，否则按现有能量缩身（收入 > 0 时至少要容量的一半，外矿/援建这类自带分档的需求改为理想身体成本的一半 `minCostShare`，收入 = 0 是 hauler/矿工全灭的紧急态；收入估计扣掉 spawn 自产、不到 `minIncome` 1/tick 视为 0，生存档等超过 `survivalShrinkAfter` 300 tick 也按现有能量孵）。核心请求等待时挡住外矿等非 strategic 请求，占领/援建/防御是 strategic；生存底线（源矿工、第 1 只 hauler、核心替补预留）是 vital，等能量时连援建也挡；外矿请求 jumpable（买不起不挡同级兄弟）。方案里的源容器/控制器容器缺失时第 1 只 builder 提到生存档（`coreContainerGap`），源容器工地不受 layout 的容器在建配额限制。缩身出来的外矿 creep 占着槽位时，(理想吞吐 − 在岗吞吐) × 剩余 tick ≥ `upgradePayback` × 理想成本就出 opportunistic 的 `upgrade:<slot>` 请求换代，旧的等替换者进外矿房再退役（`retireReplaced`）。恢复期（`state.recovering`）只保留 defense 与核心角色。本房核心角色以 `config.roster[RCL]` 为底线，harvester/hauler/builder/upgrader 再按源吞吐、运输往返距离（含投递停靠开销 `hauling.deliveryStopTicks`，分解在 `Memory.rooms[房].haulModel`）、建设 backlog、控制器容器 EMA 弹性增减，并按 TTL + 孵化时间预补。两类低能量死锁的自恢复（`emergencyHarvest`、150–199 能量的 `[WORK,MOVE]` dropMiner）在 `main.js` 和 `spawn.js` 里，回归在 `test/smoke.js`；静态身体的矿工（`utils.bodyTicksPerTile` > `harvesting.mobileTicksPerTile`）没有容器时不往返送 spawn，而是站在规划位自建容器工地/落地采（`roles/harvester.js`），这种"落地源"在 spawn 里算 hauler 搬运来源；矿工自修容器；`builder`/`upgrader` 在 `recovering` 下不得从 spawn/extension 抽能。遥测：`Memory.rooms[房].spawnQueue`（队头、等待成本/预计可负担 tick/已等待、本 tick 孵化、被挡数量、收入估计）、`spawnWaiting`（hauler 控制器公平规则依赖）。

### 任务 broker（`src/task_broker.js`，详见 `docs/task-broker.md`）

轻量混合调度：不取代 harvester/远程/link/防御的固定工作位，负责 hauler 的取送目标（deliver 分 4 层：有敌人或低于维修储备 `towerRepairReserve` 的 tower（权重高于 spawn）与 spawn/ext → 工地上缺能的 builder → 控制器容器 → storage/和平期塔的维修补能/工地上能量过半的 builder 补能/terminal（权重 0.5，只在 storageRich 且 storage ≥ `industry.terminalFillStorageAbove` 时补到 `industry.terminalTarget`，`Memory.rooms[房].terminalFill`）/boost lab（权重 0.4，同一道闸，只补 `industryState.labs.boostLab` 那一个到 `industry.labEnergyTarget`，反应三连不补，`Memory.rooms[房].labEnergy`；储备闸关着时 industry 不算 lab 计划但照记 boostLab）；storage 不富余时 terminal 反过来是 hauler 专属取货点（终端网络送来的能量，`terminalDrain`）；富余但 storage 低于 `industry.terminalDrainStorageBelow`（3 万）时也取、只留 `terminalNetwork.feeReserve`（`terminalDrainLow`），两条线之间隔一段，补与取互斥）、builder/upgrader 的空闲 fallback、creep 执行顺序与 CPU 跳过。任务池每 3 tick 重建，目标租约 5 tick，遥测每 30 tick 写 `Memory.taskBroker`。无 storage 的房里"能量闲置"（`utils.energySurplus`：容器 ≥ 90% 满或地上 ≥ 1000）时 builder 不等投递自己去取、builder 上限 +1；容量 < 550 时 builder 先建 extension 再修路。storage 富余（`utils.storageRichState` 滞回）时容器供能房的 storage 取货只是兜底（权重 6 < 源容器 7），另出专职 `feeder`（`roles/feeder.js`，`spawn.feederTarget`：storage 到控制器容器 ≤ `upgrading.feederMaxDistance` 格）只跑 storage ↔ 控制器容器；link 供能房 hauler 直接把 storage 送进控制器 link。

### 布局与拆迁（轮子唯一来源）

- `vendor/wheels/layout-2.1.0`（第三方规划器）经 `src/wheel_layout.js` 包装，在游戏内 bucket ≥ 5000 时每房跑**一次**，规范化后写 `Memory.rooms[房].plan`（`wheel: true`，`containers.src0/src1/ctrl`、`roads`、`links`、`ext`…），原始输出存 `Memory.roomPlanner`。
- `src/layout.js` 只认 plan，按 RCL 配额放工地（`maxSites`、`sitePace`；顺序源容器 → link → storage → terminal → 道路 → extension → 塔 → 提取器 → lab…，link 先于道路/extension 是因为基准里 RCL6 房的名额被 ext 工地占满两万 tick；storage/terminal 提前（`construction.oneOffBeforeRoads`，extension 还缺时给它留 1 个名额，塔之后的兜底轮仍把剩下的名额给它们，`oneOffAhead`/`oneOffLeftover`）是因为 terminal 在 RCL6 解锁时 extension 上限同时 +10、基准里 RCL7 房 terminal 0 座；lab/factory/nuker 仍等 storage 过 `luxuryStorageAbove`，提取器跟大脑的矿物方案），`trimSites` 清漂移工地。工地名额全账号共 100：母房用到 100 − `globalSiteReserve`，但每房保底 `siteFloorPerRoom`（10）不受全局占用影响；连续 `deadRoom.afterTicks` 没有 builder/pioneer 的房是死房——不放新工地、已有工地裁到 `deadRoom.keep` 个（spawn 工地保留），`Memory.rooms[房].builderSeenAt` 记最近一次有 builder 的 tick。
- `src/demolition.js` 把与 plan 冲突的工地/建筑在合适时机拆掉（规则见文件头注释和 `docs/superpowers/specs/2026-09-03-*.md`）；spawn 留到 RCL7，唯一的塔和 rampart 不主动拆。
- 移动统一走 `movement.go()`（`vendor/wheels/movement-1.0.3` 的包装，带路径缓存、卡住检测、tick 末交通解算）；不要直接 `creep.moveTo`。

### 外部大脑（`scripts/brain/` ↔ `src/brain.js`）

情报、评分、外矿分配、占领目标、外矿防御的打/避决定在游戏外完成（Python，走官方 HTTP API；`room-objects` 不需要游戏内视野就能看到敌方 creep 的 body/boost/ageTime），结果按契约 `{version:1, issuedAt, ttlMs, intel, rooms:{home:{remotes, claim, scouts, defense, skMining?}}, locks}` 写入 Memory segment 90；`intel[房].hostileProfile` 是敌情画像，`scripts/brain/combat.py` 与 `src/defense.js` 是同一套战力公式。原则：每 tick 必须反应的留在游戏内（有视野时的己方房防御、成组出发、阵亡记录），不需要每 tick 做且能安全外置的放大脑。safe mode 的决定也在大脑（`scripts/brain/safemode.py`：敌方 DPS/主人/强化、本房塔与次数、别的母房能否及时出兵 → `rooms[房].safeMode`；`guard.py` 每 90 秒巡视己方房只修补这一字段），游戏内 `tower.js` 在 `config.safeMode.decisionTtl` 内采用、没有决定时只在核心建筑掉血时兜底，开盾记 `defenseLog.safeMode`，开盾失败记 `defenseLog.safeModeError`（同一账号同时只能一房开盾，别房开着时 ERR_BUSY，大脑对此给 hold busy:<房>），`defense.js` 对 safe mode 中的己方房不出 defender。游戏内 `brain.run()` 校验并合并 `intel` 进 `Memory.map`，写回 `ack`；消费方用 `brain.directive(room)` / `brain.get(room, key, fallback)`，没有指令或过期就退回自治逻辑。`remote.admitCandidates` 用 `remotes` 白名单，`expansion.js` 用 `claim` 孵化 claimer/pioneer。`data/brain/locks.json` 里的 agent 决定覆盖确定性规划；用户点名一批要占的房用账号级锁 `claim.queue`（`plan.assign_claim_queue`：有主的房等无主，无主的分给 claimer 在 `claimTravelTicks`（600）内按地形走得到、容量 ≥ 650 的最近空闲母房，一房一目标，清单未完成时压住自动占领，状态见 `run.log` 的 `claimQueue`）。launchd 定时见 `scripts/brain/install_schedule.sh`。设计文档：`docs/superpowers/specs/2026-09-02-external-brain-design.md`。

### 远程采矿、援建、防御、扩张

同一种"需求"接口，各自独立模块：`remote.js`（RCL4+，外矿记录在 `Memory.rooms[home].remotes[房]`，含 sources/spot/containerId/reservation/suspendedUntil/threat，武装敌人暂停、不可达冷却（连续不可达指数退避到 `remote.unreachableMaxTicks`，冷却到期先只出一只矿工试探，有 creep 看到该房才放开其余需求并清零计数）；看到房间已清场立刻解除敌情停用；停用的外矿其工地全部清掉，路工地按母房合计不超过 `remote.roadSitesPerHome`；运输工满载后往全账号路程最短的己方房卸货（`record.drop`，`remote.dropRoom`，每 `dropRefreshTicks` 重算，卸货房放不下再退回母房），hauler 编制按到卸货房的距离算——收入因此记在卸货房的 spawn 收入里，不在母房；Source Keeper 房是一种特殊外矿 `record.sk`（**默认关**：`config.sk.enabled` 或大脑指令 `rooms[母房].skMining` 打开，且要 RCL ≥ `sk.minRcl` 7、房在大脑外矿白名单里，自治模式不碰 keeper 房；不许开时记录退回永久停用的 `keeperRoom`）：先孵一只不缩身的自愈远程风筝手 `skReaper`（`roles/skReaper.js`，n RANGED + 2n MOVE + n HEAL，组数 < `reaperMinUnits` 就不派），它进房在岗前不为这个房出任何矿工/运输工；7 WORK 矿工、没有 reserver；矿工/运输工在 keeper `keeperSafeRange` 内或 lair `lairWarnTicks` 内要孵时退到射程外（`remote.keeperRetreat`）；reaper 被打死 `maxReaperLosses` 次停 `lossCooldown`（`skReaperLost`；退役回收的 reaper 标 `retired` 不算，已退回 `keeperRoom` 的房不记账）；defense 不把 SK 外矿里的 keeper 当敌情；遥测 `skWaitReaper`/`skStation`/`skReaper`/`skHarvest`/`skRetreat`/`skLosses`）、`aid.js`（强母房为容量 < `aid.untilCapacity`（1300）且 storage 能量 < `storageBelow` 的弱房孵满配 creep，`memory.home` 指向弱房；只在弱房经济没起来时（某源没矿工/没 hauler，`shortHanded`）是 strategic 越过母房等能量的发展档，否则排在母房自己的 builder/hauler 之后；母房 storage ≥ `exportAbove` 时另派 `courier`（`roles/courier.js`，`memory.from` = 母房）把 storage 能量搬到弱房，只留 `exportKeep`；母房到弱房没有不穿 SK/他人房的路线（`movement.safeRouteExists`，与援建角色默认移动同一套 `dangerRooms`，按 `aid.routeCacheTicks` 缓存、危险房集合变化即失效）就不援、记 `aidNoRoute`，已派出却回不去的援建 creep 由 `aid.markStranded` 标退役回收、记 `aidStranded`）、`defense.js`（只打 NPC；**打得过才打**：敌情画像 `hostileProfile`{hits/dps/heal/kiters/boosted/until} 由远程 creep/defender 观察写进 `remotes[房].threat`、或来自大脑情报 `Memory.map[房].hostileProfile`，`planSquad` 用"双方同时交换伤害"的悲观模型找最便宜的能赢编组（1..`maxDefenders` 只同样身体，风筝型只用远程），外矿还要过经济门槛 `remoteValueShare`；打不过就把外矿停到入侵者到期并记 `defenseLog.skipped`；defender 阵亡由 `main.js` 记 `defenseLog.losses/lastLoss`，再看到更新的敌情前不续派；己方房敌人一直可见所以另有连续阵亡上限 `defense.maxOwnLosses`（被防守房 `defenseLog.streak`，清场归零，大脑 fight 指令可越过）；defender 成组：在家等全组孵出再走、进目标房先在入口集结；大脑指令 `rooms[home].defense`{房:{action:fight|avoid,squad,until}} 在 until 前优先；塔压不住才派 defender，InvaderCore 派清核心队；己方房防御是 defense 档、外矿防御是 remoteMaintain 档）、`expansion.js`（claimer 占下即退役，pioneer 就地建 spawn 后转 builder；大脑掉线兜底 `autoClaimTarget`：只在 `brain.offlineMs()`（最后一份指令 ttl 到期后的时长，从没有 `Memory.brain` 时为 null、不触发）≥ `expansion.autoClaimAfterMs`（一天）时启用，有可用指令哪怕没给 claim 也不出手；候选先照最后一份指令里未到期的 `<母房>.claim` / `claim.queue` 锁（`brain.standingLock`），否则按距离扫 `Memory.map`，门槛比大脑严（双源、无主、无 keeper/敌情/他人预定、不是在采的外矿、本房没去失败过、≤ `autoClaimRange`、本房是最近的够格母房、`movement.safeRouteExists`），账号里一次只开一个；CPU 吃紧（bucket < `autoClaimMinBucket` 或近期 `Memory.stats` 用量均值 > limit × `autoClaimMaxCpuShare`）不挑新房、记 `autoClaimCpuHeld`，已在开荒的照常开完；结论缓存在 `Memory.rooms[母房].autoClaim`；开荒记录标 `autonomous`，大脑回来没接着要这个房就作废、在途 claimer/pioneer 退役；`remote.admitCandidates` 不收任何母房的开荒目标）。攻城 creep 出发前强化（`src/boost.js`，**默认关闭**：`config.conquest.boosts` 空，`Memory.conquest` 指令的 `boosts`{dismantler,guard} 可整份覆盖打开）：`conquest.demand` 把化合物清单写进 siegeDismantler/siegeGuard 的 `memory.boosts`，它们在母房里先走到装着该化合物且能量够的 lab（优先 industry 的 `labRoles.boost`）`boostCreep`；做不到的项跳过、报错的项记 `boostSkip`、等满 `conquest.boostMaxWait` 整份放弃（`boostDone`），成功记母房 `boostLog`（最近 10 条）。**改战力公式必须同时改 `scripts/brain/combat.py`**（两边测试互相核对数字）。

### Memory 布局速查

`Memory.rooms[房]`：`sources`、`plan`、`state`、`demand`（spawn 目标）、`storageRich`（storage 富余滞回状态）、`remotes`（每房含 `threat` 敌情画像）、`expansion`、`spawnWaiting`、`demolition`（最近 20 条）、`defenseLog`（spawned/lastSlot/losses/lastLoss/skipped/safeMode）、`crippledLog`（最近 20 条残废退役）、`terminalFill`/`terminalDrain`、`labRoles`（lab 分工 + 当前反应步 `step`）/`labTech`/`labEnergy`、`boostLog`（最近 10 次成功强化）、`layoutBlocked`、`planError`。全局：`Memory.map`（侦察/外部情报，20k tick 老化）、`Memory.brain`、`Memory.market`、`Memory.terminalNetwork`、`Memory.stats`、`Memory.taskBroker`、`Memory.errors`、`Memory.roomPlanner`。creep：`role`、`home`、`sourceId/sourceIdx`、`staticMiner`、`remoteRoom`、`brokerTask`、`bodyUpgrade*`、`crippled/crippledSince`。所有可调参数集中在 `src/config.js`，每项都有注释说明依据。

### 测试基础设施

- `test/smoke.js` 自己 mock Screeps 全局（常量、RoomPosition、Creep、RoomVisual、PathFinder…）并用 `test/terrain_W33S7.json` 真实地形；轮子的真实输出作为固定件在 `test/fixtures/wheel_layout_*.json`。
- `test/brain_test.py`、`test/monitor_test.py` 直接 `from scripts import ...`。
- 私服验证在 `private-server/`（gitignored）；`scripts/private_server/server_process.js` 管进程，`fixtures.js` 播种，`validation_mod.js` 是私服 mod。

## 参考文档（`docs/`，从 `reference/screeps-docs/` 提取）

- `docs/game/`：`game-loop.md`（tick 与执行时序，关键）、`cpu-limit.md`（写代码前必读）、`simultaneous-actions.md`（同 tick 多动作规则）、`creeps.md`、`control.md`、`defense.md`、`invaders.md`、`resources.md`、`market.md`、`power.md`、`global-objects.md`、`commit.md`、`auth-tokens.md`、`respawn.md`，以及 `contributed/`（原型修改、缓存、grunt 工作流）。
- `docs/api/`：53 个类的完整 API（`Game`、`Creep`、`Room`、`RoomPosition`、`Structure*`、`PathFinder`、`Market`、`Map`、`Cpu`、`RawMemory`、`RoomVisual`、`constants.md`…），继承链在 `inherited/`。
- 项目自己的文档：`docs/task-broker.md`、`docs/wheel-integration.md`、`docs/superpowers/specs/`（设计决策）、`logs/optimizations.md`（每轮优化的问题/改动/预期/实测日志，格式固定）、`docs/observe/`（顶级玩家观察：`kalgen.md` 自动报告，`kalgen-learnings.md` 人工维护的"观察 → 现状 → 差距 → 改动"清单，改经济/布局代码前先看）。

核心规则速记：动作下一 tick 才生效；每 creep 每 tick 一个非移动动作 + 移动；`Memory` 每 tick 序列化，大数据用 `RawMemory` 分段；超 CPU 限制会中断脚本。

## Git 工作流（强制）

- `main` 分支；开始任何改动前先 `git status --short`，不得覆盖或混入用户已有的未提交改动。
- 每完成一个可独立描述、可独立验证的逻辑步骤，就只暂存该步骤涉及的文件并立即提交；禁止把多个无关步骤堆到一个提交里。
- 提交前检查 staged diff，运行与该步骤风险相称的测试；游戏代码必须满足下面的完整验证要求。
- 提交信息用简洁的 Conventional Commit 风格（`fix:` / `feat:` / `docs:` / `chore:` / 模块名前缀如 `spawn:`）。
- 任务结束前必须确保 `git status --porcelain` 无输出；测试失败或存在无法归属的改动时，不得继续叠加变更或部署，保留证据并报告阻塞。
- 无交互环境下无法调用本机 SSH 签名时，可对当次提交用 `git -c commit.gpgsign=false commit ...`；不得修改全局 Git 身份或签名配置。

## 已安排任务与运维约定

- Codex heartbeat `screeps`「每小时监控并迭代 Screeps 发展效率」每 1 小时先测量再决策。无证据改进则不改、不部署；只有本地趋势不足以定位异常或需验证假设时，才按需用 monitor/probe/只读 API 拉线上信息。每轮最多 1 项改进：工作树干净 → 备份到 `logs/src_backup/<时间戳>/` → 完整测试 → 按逻辑步骤提交 → 重查 `activeWorld` 后部署 → 复测 → 单独提交 `logs/optimizations.md` → 工作树干净。新手期 safe mode 激活是需记录的状态告警，不能仅因此改代码。
- `scripts/monitor.py` 探针 schema 4：RCL/进度/角色/工地/敌情/安全模式/方案/远程/援建/CPU/错误，过滤 MOVE-only 敌人与工地队列误报；`logs/status.jsonl` 超 8 MB 只留最近 1000 条。

## 工作约定

- 改动游戏代码后至少跑：`node test/smoke.js`、`node test/conquest_test.js`（改动 conquest/攻城相关时）、`python3 -m unittest discover -s test -p '*_test.py'`、JS/Python 语法检查、最终 `npx grunt` 打包；全绿且重新确认 `activeWorld` 后才可部署。
- 必须在本地私有服务器模拟验证通过，并在本地服务器模拟各种可能出现的边界情况；验证通过后才部署到线上。**私服验证通过 = 既有断言全过 + 本次改动的生效断言（`scripts/private_server/effects.js`）观察到新行为 + 与上次基线无回归**；每个游戏代码改动都要先加生效断言再跑验证。
- `.env` / `.env.example` 存放凭证相关配置，凭证绝不提交（已在 `.gitignore`）。
