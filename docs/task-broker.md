# Utility Task Broker

任务 broker 是一层轻量的混合调度器，不会取代高吞吐角色的固定工作位。`harvester`、远程采矿、link 路由和防御仍由各自 role 控制；broker 主要负责空闲 fallback、hauler 的来源/投递目标，以及 creep 执行顺序。

## 竞价

每个已拥有房间每 3 tick 重建一次任务池。任务包含补能、取能、建造、维修、采集和升级。候选任务的分数为：

```
roleWeight × taskWeight × (ln(1 + backlog) + 1)
  × ttlUrgency × cpuHeadroom / (distance + 1)
```

其中 `backlog` 是待处理数量，`taskWeight` 表示任务收益/紧迫度，`distance` 是房间内的 Chebyshev 距离。CPU headroom 在每 tick 缓存，目标租约持续 5 tick，避免多个 hauler 同 tick 争抢同一目标。

## 安全边界

- recovering/emergency 状态下，builder/upgrader 不从 spawn、extension 抢能量。
- broker 不可用或目标消失时，role 保留原有兜底路径。
- CPU 超预算时优先跳过低价值单位；harvester、hauler、upgrader 保持运行。
- 容量提升后，常规补员使用 `room.energyCapacityAvailable` 规划身体；旧的小身体在新身体 ready 后发出 `suicide`，避免长期重复人口。

## 观测

每 30 tick 写入 `Memory.taskBroker`，包含房间 backlog、已分配任务、已观察到结果的 `acted`、因游戏时序延后一 tick 才能观察结果的 `deferred`、真正没有意图的 `idle`，以及 CPU 跳过计数。它用于调参和回归观测，不能单独证明理论最优；要比较效率还需同时记录源吞吐、搬运量、spawn busy ratio、升级速率和 bucket 趋势。

## 遥测语义（Memory.taskBroker.rooms[room]）
- `acted`：creep 在本 tick 开始时的位置/能量与上一 tick 相比发生了变化（Screeps 的 action 下一 tick 才结算，所以这是“上一 tick 的动作确实生效”）。
- `deferred`：本 tick 已发出移动/租约/工作位意图但尚未结算。
- `idle`：既无变化也无意图。
- `backlog`：任务池缺口总和；repair 的 rampart 缺口按 `config.rampartTargetHits` 的 RCL 目标计，而非 hitsMax。

## 投递分层（hauler）
deliver 任务带 `tier`，hauler 逐层竞价：高层有可领任务时低层让位，同层内仍按 backlog/距离/收益打分。
1. spawn / extension（孵化优先）。
2. tower，仅当缺口 ≥ `config.towerRefillAt`（300）或房内有敌对 creep；小缺口不派车，避免 hauler 为 10 能量跑一趟并长期被 tower 租约占住。有敌人或塔能量低于 `config.towerRepairReserve`（500，塔停止维修的储备线）时它不在这一层而是第 1 层、权重 11 高于 spawn/ext 的 10（2026-09-06 W34S7：spawn 持续换代身体、spawn/ext 永远有缺口，塔打完入侵者剩 11 能量半小时没人补）；高于储备的缺口是维修消耗，退到第 4 层（权重 2，高于 storage 的 1），排在控制器容器之后——2026-09-06 线上 W34S7 的塔整天停在 620–690，hauler 每趟的零头都先喂塔，控制器容器只靠见底规则拿到能量，22 WORK 的升级者只有 9/tick。
3. controller 供能容器。它是中立建筑，不在 `FIND_MY_STRUCTURES` 里，由 `Memory.rooms[room].plan.containers.ctrl` 显式登记；存量低于 `config.upgraderFillBelow` 才发布；`controllerFeedMode(room)` 返回 'link'（ctrl link 已建成）或 'storage'（storage 站位，升级者直接取）时不发布——这一判定也是 monitor 探针 `upkeep.ctrlFeed` 的来源，两边不会分叉。
4. storage 回库；同层还有"工地上能量过半的 builder 补能"（权重 2）——spawn/塔/控制器都满时，满载的 hauler 与其停在 spawn 旁不如把能量送到工地（2026-09-05 W35S7：三只 hauler 200/200 停着，builder 在工地一格一格用）。builder 能量低于一半时仍是第 2 层（权重 6）。

builder 自己取能的规则（`roles/builder.js`）：无 storage 且容量 < 800 的房，spawn/ext 未满时 builder 不掏源容器、在工地等投递（最多 `builderFeedMaxWait` 50 tick）；但房里有闲置能量（`utils.energySurplus`：某个非控制器容器 ≥ 90% 满，或地上掉落 ≥ 1000）时不等，自己去取——可取非控制器容器、≥ 75% 满的控制器容器、地上 ≥ 100 的能量堆。闲置时 builder 上限也 +1（`config.energySurplus`）。工地顺序：容量 < 550 时 extension 排在道路前；没有 storage 的房 storage 工地排在道路前（`config.construction.storageBeforeRoads`，broker 建造权重同样 8.5 > 道路 8；link 工地 8.7（塔 9 之下、storage 8.5 之上，builder 的 sitePriority 里排在源容器之后），基准 W34S7 的四个 link 工地曾放出后 0 进度 5k tick；2026-09-05 W33S7 的 storage 工地被规划道路压了一天多）。

storage 富余（`utils.storageRichState`：storage ≥ `upgrading.storageFeedAbove` 2 万进入、< `storageFeedBelow` 1 万才退出，状态在 `Memory.rooms[房].storageRich`）时控制器容器/控制器 link 的投递提到第 1 层（权重 9 < spawn 10）；storage 作为取货来源只在富余时发布（任务带 `rich`），容器供能房里权重 6 低于源容器 7——hauler 先竞价源容器/掉落/tombstone，都没得取才取 storage（2026-09-06 A/B：storage 压过源容器把 hauler 抽走，矿工溢出到地上衰减，总 CP −5%，见 `docs/benchmarks/2026-09-06-storage-ab.md`）；link 供能房 storage → 控制器 link 只有几格，权重 8 第一轮就放行。容器供能房里 hauler 永远有源容器可取、兜底轮不到（第 2 轮 A/B：W33S8 storage 攒到 17 万），所以富余且 storage 到控制器容器 ≤ `upgrading.feederMaxDistance` 格时另出一只专职 `feeder`（`roles/feeder.js`，`spawn.feederTarget`）只跑 storage ↔ 控制器容器，不走 broker；富余关闭就退役。

带 `roles` 的任务只对列出的角色开放：ctrl 容器与 storage 投递都只给 hauler，builder/upgrader 手里的能量走升级/建造，不会被吸去搬运。
租约与筛选不匹配时（如 hauler 先问高层）保留租约，交给后续层；过期租约在下次竞价时删除。

## 任务池刷新
任务池仍每 3 tick 重算，但中间 tick 的 deliver/collect 任务会用当前 tick 的对象（`Game.getObjectById`）刷新 backlog：已被填满或取空的目标立刻退出池子，hauler 不会对着满的 spawn 发 transfer。

