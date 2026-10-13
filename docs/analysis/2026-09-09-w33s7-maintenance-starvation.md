# W33S7 维修饥饿：道路消失、builder 挂机、storage 空（2026-09-09）

用户报告：W33S7 的路消失了很多、房间内很多挂机的、storage 完全没能量；对照 W33S3 有 storage 能量且路完整。
怀疑房间 Memory 坏了，或最近几次部署引入。下面按"先排除 Memory，再定位根因"的顺序记录证据与结论。

## 1. 先排除 Memory 损坏

| 检查 | 结果 |
| --- | --- |
| `Memory.rooms.W33S7.plan` | 完整：`version=wheel-layout-2.1.0`、89 格路、ramparts、links、containers、ext、towers 全在，`made=73456532` |
| `Memory.rooms.W33S7.remotes` | 6 条记录，4 条 enabled（W32S6/W32S7/W33S6/W33S5），2 条 notWhitelisted，sources/spot/containerId/reservation 齐全 |
| `state` / `demand` / `spawnQueue` / `demolition` / `defenseLog` / `crippledLog` | 每 30 tick 更新、数值自洽，没有缺字段或时间戳回退 |
| 与线上对象对照 | 工地 40 个、路 54 条、塔 2 座、link 3 座、容器 3 个——与 plan 对得上（plan 里的路 89 格，房间只剩 54 条） |

**结论：Memory 没坏，重建 Memory 不会改变任何东西**（反而会丢掉 plan、remotes 与 129k tick 的观察数据）。

## 2. 现象量化（用线上 API + 历史快照）

- 路：09-04 12:30 `152` → 09-06 10:54 `118` → 09-08 23:09 快照 `118`（其中 57 条在随后 13.7k tick 内消失）
  → 09-09 15:00 `54`，其中 12 条 < 500 血、最低 100 血。引擎里道路衰减：`ROAD_DECAY_AMOUNT=100`（平地）每
  `ROAD_DECAY_TIME=1000` tick 一次，每次 creep 踩过按身体部件数扣减衰减计时器（`ROAD_WEAROUT=1`/部件）。
  09-08 快照里那些路的血量集中在 1400–2200（28–44%），也就是说它们是一批同期建成、同期开始集体归零的。
- storage：09-06 `30 937` → 09-08 20:07（升 RCL6）`2 059` → 09-09 全天 `0`。
- 挂机：两只 builder 在观察窗口内 0 能量、位置不动（25+ tick）；一只 hauler 0 能量靠 spawn 边站着。
- 对照 W33S3：storage 104 790、130 条路最低 2800 血、0 个工地。

## 3. 根因（四个独立缺陷叠加，全部有线上证据）

### 3.1 builder 对空 storage 永久挂机（`roles/builder.js`）

```js
const src = creep.pos.findClosestByPath(FIND_STRUCTURES, { filter: 容器 ≥50 }) || room.storage;
if (src) { creep.withdraw(src, RESOURCE_ENERGY); ...; return; }   // 空 storage 也是 truthy
```

容器全空（0/10/0）时 `findClosestByPath` 返回 null，`|| room.storage` 把**空 storage**当成可取来源，
`withdraw` 返回 `ERR_NOT_ENOUGH_ENERGY`，函数直接 `return`。于是 builder 每 tick 空转，**永远到不了**后面的
`withdrawRoomSurplus`（spawn/ext 余量）与 `harvestForSite`。实测那一刻 spawn+extension 有 825 能量、容量 2300。

同一窗口的房间建造进度：12 645 tick 只推进 36 691 ≈ **2.9/tick**（两只 builder 的物理上限是 25/tick 级）。

空 storage 只有 W33S7 有（其余房 1.7k–10 万），所以只有它中招——这正是"为什么别的房没事"的答案。

### 3.2 broker 的维修任务池看不见中立建筑（`src/task_broker.js`）

任务池用 `FIND_MY_STRUCTURES` 遍历，而**道路/容器是中立建筑，不在该列表里**（引擎语义）。线上实测
`roomTasks(W33S7)` 的 90 条任务里：0 条路、1 个容器（collect）、5 个己方 rampart 的 repair。
也就是说"烂到 0 就消失"的那一类结构在池子里根本不存在。

### 3.3 builder 只在没有工地时才维修（`roles/builder.js`）

```js
if (hasLoad && site) { build; return; }        // 有工地就永远建造
if (hasLoad && !site) { damagedStructure() }   // 只有工地全清空才轮得到维修
```

W33S7 在 09-08 20:07 升 RCL6 后一次放出 terminal（10 万）+ 3 个 lab（15 万）+ 外环 rampart 工地，
40 个工地从此没有清空过——道路维修的需求存在（60 条路全部低于 60%），但没有任何 builder 会去做。

### 3.4 塔停在储备线上，维修补能永远排不上（`src/task_broker.js` + `src/tower.js`）

- `tower.js` 要求 `energy − 10 ≥ towerRepairReserve(500)` 才维修；两座塔正好是 `501/500`，一次也修不动。
- broker 有"维修预算"机制（补到储备 + 400 提到第 3 层），但第 3 层**永远输给第 1 层的 spawn/ext**：
  spawn 持续孵化时 spawn/ext 永远有缺口（实测 37 条第 1 层任务在队）。
- 附带：塔按"离维修目标还剩几成"全局排序时，会一直去够房间另一侧的路。引擎里塔的维修量从射程 5 的
  800 线性衰减到射程 20 的 200，射程外恒为 200（20 血/能量，比 builder 的 100 血/能量还差 5 倍）。
  W33S7 的塔在 `(6,40)/(7,41)`，比例最低的几条路在 `(41,33)/(45,31)/(48,29)`。

### 3.5 消失的路补不回来（`src/layout.js`）

房间 40/40 工地名额被 terminal + 3 lab + 36 个零进度外环 rampart 占满（`config.maxSites=40`），
`placeSites` 的 `budget = min(maxSites - own, ...) = 0`，于是**道路工地一个也放不出来**；
`yieldLowPrioritySites` 只在"高优先结构（extension/塔/storage/terminal/lab/spawn/link）配额未满"时让位，
**不认道路**。方案里 89 格路只剩 54 条，消失的 34 格无法重建。

## 4. 修复

| 提交 | 改动 |
| --- | --- |
| `bc8c68d` | builder：storage 只有 ≥50 能量才算可取来源；否则落到 spawn/ext 余量 → 直接采集。有载时先修 `criticallyDamaged`（会消失的）结构再建造，修回 20% 即回建造 |
| `d0f52a8` | broker：维修池改用 `FIND_STRUCTURES + needsRepair`（方案外的旧路/旧容器仍不修、rampart 仍按 RCL 封顶）；射程内（`towerCriticalRange`）有危急结构时塔的维修补能提到第 1 层（权重 11 > spawn 10），补到储备 + 预算即降回，遥测 `Memory.rooms[房].towerCritical` |
| `3c5b871` | tower：维修目标优先射程内，射程内没有才退回全局 |
| `231a8c3` | layout：名额满且方案里有未建成的路时，让出最多 2 个零进度 rampart/wall 工地（核心建筑上的保留） |
| `79a70c5` | utils：`needsRepair` 的"这条路在不在方案里"由每路扫 5 个 packed 串改为每房每 tick 一份 Set（tower.js 每座塔每 tick 全房过滤一次），抵消新增扫描的 CPU |

预期（可量化）：W33S7 的 60 条路总维修需求约 18 万血，塔 800 血/动作、builder 100 血/能量；
修一条 60 血的路到满只要 49 能量，而重建要 300–1500 能量。道路恢复到 89 格后，hauler 往返的 MOVE 消耗减半。

## 5. 未结观察（本轮不改，留给下一轮）

- **外矿溢出**：W32S6/W32S7/W33S5 的源容器 2000/2000 满、地面还有能量堆，而 W33S7 storage 为 0。
  外矿运输编制（`remote.js` 的 `requiredCarry = rate × (距离×2+4) / 50`）与实际吞吐是否匹配需要单独量，
  这是"房间穷"的另一条供给线。
- 环形 rampart 的维修目标（RCL6 = 30 万/格 × 36 格）远超当前收入，是否该在 RCL6 就铺外环、还是等
  storage 稳定后再铺，值得用基准 A/B 量。
- 塔的维修在射程外仍按 200 血/动作执行；是否需要"射程外干脆不修（交给 builder）"的硬规则，需要数据。
