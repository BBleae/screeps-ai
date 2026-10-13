# spawn 请求队列设计

状态：已确认（2026-09-04，用户接受方案）。替换 `src/spawn.js` 里"三个 band + remoteDemands + 五个缩身特判"的调度部分，身体生成与需求估算函数原样保留。

## 1. 问题

2026-09-04 一天内三次同源事故：1300 的 reserver 把 700 的矿工卡在身后上千 tick；1500/1600 的 hauler 替补（成本恰好 = 容量）等 ext 100% 满，期间 `starved` 规则把全部外矿需求挡住，W33S6/W32S7 预定归零、地上堆 7k 能量；hauler 只缺 1 只不触发缩身。根因：

- 优先级隐式（band 顺序 + 列表顺序），一条买不起就阻塞后面所有人；
- "孵什么"和"孵多大"绑死：只有满配一档，缩身靠 `have===0`、缺 ≥2、`spawnStallTicks`、`spawnWaitTicks`、`scaleDownShare` 五个补丁；
- 没有"何时需要"和"何时买得起"的估计，等待是盲目的。

## 2. 模型

所有来源（核心角色、防御、扩张、援建、外矿、富余 upgrader）只产生请求：

```
{ key, role, memory, priority, grace, body(budget) -> [], strategic, jumpable, blocking, opportunistic, ordered }
```

- `key` 跨 tick 稳定；`Memory.rooms[房].spawnSince[key]` 记录首次出现的 tick，`neededBy = since + grace`。
- `body(budget)` 给定预算返回身体（可缩小），预算不足返回 `[]`；固定身体的请求在预算 ≥ 成本时返回原身体。
- 优先级类（`config.spawnQueue.classes`）：defense 0 → survival 1（核心底线：源矿工、第 1 只 hauler、底线 upgrader；核心替补的能量预留请求排 1.5）→ expansion 2（claimer/pioneer：一次性、有占领窗口）→ remoteMaintain 3（容器已建成的外矿的矿工/reserver/hauler 替补：维持收入）→ development 4（弹性 hauler/upgrader/builder）→ aid 5 → remote 6（新外矿的开路、矿工换代与弹性矿工）→ opportunistic 7（EMA 富余 upgrader、scout）。宽限（`grace`）：survival 30（源没人挖每 tick 都在损失，底线 upgrader 例外用 150）、development 150、expansion/aid/remote 300、defense 0。
- 标志：`strategic`（占领/援建/防御：队头等待时不被挡）、`jumpable`（外矿：自己买不起不挡同级兄弟）、`blocking=false`（防御：买不起不为自己保留能量）、`opportunistic`（只在立刻买得起时孵）、`ordered`（同级按生产者顺序而非截止时间）、`vital`（生存底线：源矿工、第 1 只 hauler、核心替补的能量预留——它等能量时连 strategic 也挡；2026-09-05 线上 W34S7 家里 hauler 死光后援建仍绕过等待把能量花在 W35S7 的 creep 上，收入掉到 5/tick）。
- 援建的 `strategic`（2026-09-05 06:30 追加）：只有弱房某个源完全没人挖（该源的援建矿工）或弱房一只 hauler 都没有（援建 hauler）时才是 strategic，能越过母房等能量的发展档；只是身板小的补强和援建 builder 不再 strategic，排在母房自己的 builder/hauler 之后。同一轮把普通 builder 改回默认 `blocking`（以前等能量时不挡外矿/援建）：线上 W33S7 单 spawn 满负荷（4 个外矿 + 援建约占 spawn 时间 100%），builder 1/3 等了十几小时——能量一到 650–700 就被援建/外矿拿走，缩身到 900 也永远够不到，storage 工地停在 10834/30000；而被援建的 W35S7/W33S8 自己的 spawn 空闲、能量满仓、编制超过目标。
- 底线 upgrader 的生存档资格（2026-09-05 08:40 追加）：核心容器缺失（`coreContainerGap` > 0）时底线 upgrader 不进生存档——没有供能来源的升级者卡在队头会挡住重建容器的 vital builder（私服整账号基准：W33S8 容器衰减后 40k tick 收入 0–2、27 个工地没人建、RCL4 降 3）。
- 生存档 builder：方案里有位置却没有建筑的核心容器（源容器且没有源 link、控制器容器且没有 ctrl link 也不由 storage 供能）≥ 1 时，第 1 只 builder 从发展档提到生存档并保留能量（挡非 strategic）；线上 W33S7 三个容器全部衰减、builder 在发展档 727 tick 没排上（外矿维护永远在前，900 的缩身下限攒不到）。配合 `layout.placeSites` 让源容器工地不受容器在建配额（2）限制。

## 3. 调度（`src/spawn_queue.js`，纯函数）

按 `(priority, ordered ? seq : neededBy, seq)` 排序后逐条处理，能量预算与空闲 spawn 数在同一 tick 内共享：

1. 满配买得起 → 孵满配。
2. 买不起：用能量增速估计 `eta = (idealCost − energy) / income`。`now + eta ≤ neededBy` → 等（第一条等待的请求写进 `spawnWaiting`；核心请求等待时挡住后面非 `strategic` 的请求，`strategic` 请求等待时挡住后面所有请求（占领等能量时援建也不插队），`jumpable` 只挡更低的类）。
3. 截止已过或 `income = 0`：按现有能量缩身（`income > 0` 时要求预算 ≥ 容量 × `minShare`，避免孵出 200 的 hauler；`income = 0` 是 hauler 全灭/矿工全灭的紧急态，有多少用多少）。收入估计扣掉 spawn 自产（能量 < 300 的 spawn 每 tick 自回 1），且不到 `minIncome`（1/tick）视为 0：EMA 指数衰减永远不会精确归零，2026-09-05 的 RCL 基准里 W31S8 丢光容器、hauler 全灭后 EMA 靠自产停在 0.1–1，1800 的 hauler 按容量一半（900）等了 12 万 tick，房间从 RCL6 降到 5（W33S8/W35S7 同链卡 600 的矿工 / 1250 的升级者）。兜底：生存档（vital）请求等了 `survivalShrinkAfter`（300）tick 还买不起，不管收入估计，按现有能量孵最小可用身体，之后由换代扫描换大。自带分档身体（`bodyFor`）的需求（外矿/援建/开荒）改按理想身体成本的份额 `minCostShare`（0.5）：1300 的 reserver 可退到 650 的 1 CLAIM，但 1550 的 hauler 不会缩成 200（2026-09-04 线上：W33S6 一只 1 CARRY 的 hauler 占着 19 CARRY 的槽位 1285 tick，9.8/tick 的产出运回不到 1）。
4. `opportunistic` 买不起直接跳过。

收入估计 `incomeEstimate`：没有在岗矿工 → 0；静态矿工且没有 hauler → 0；否则用 `spawnIncome` EMA（每 tick 采样 spawn 能量的正增量，满仓不采样），样本不足用 `fallbackIncomePerSource × 源数`。

队列处理完后才轮到换代替换（`tryBodyUpgrade`）与弹性矿工（`tryElasticHarvester`），条件不变：能量满且没有未满足的非 opportunistic 请求。

外矿槽位换代（`demandUpgradeRequests`，2026-09-04 追加）：缩身出来的身体会占住槽位 1500 tick，没有换大的路径。外矿需求自带 `throughput(body)`（矿工 = WORK×2、hauler = CARRY×50/往返，都封顶源产出），(理想吞吐 − 在岗吞吐) × 剩余可用 tick ≥ `upgradePayback`(2) × 理想身体成本 时，出一条 `upgrade:<slot>` 请求：remote 类、opportunistic、非 strategic、不挡人——理想身体买得起才孵，核心角色等能量时让路。旧 creep 记 `bodyUpgradePending`，`retireReplaced` 等替换者进了外矿房再让它退役（最多等 `upgradeHandover` 200 tick）。reserver 没有 throughput，1 CLAIM 不会被换成 2 CLAIM。

## 4. 保留与删除

- 保留：`Memory.rooms[房].demand`（monitor 依赖）、`spawnWaiting`（hauler 控制器公平规则依赖，新增 `since/eta/key`）、drop miner 紧急态、`countPlannedDemand` 的 TTL 预补、换代替换、弹性矿工、`retireReplaced`。
- 删除：`spawnStallTicks`、`spawnWaitTicks`、`scaleDownShare`、`scaleDownMinCapacity` 与对应代码、`hasCoreDemand`。
- 新增遥测 `Memory.rooms[房].spawnQueue`：队头、等待成本/预计可负担 tick/已等待、本 tick 孵化、被挡数量、收入估计。

## 5. 验证

smoke：调度器纯函数场景（截止内等待、截止过缩身、income=0 立即缩身、strategic 穿越阻塞、jumpable 不挡兄弟、opportunistic 不等待、minShare 下限）+ 既有 20 余个 spawn 场景全绿；Python 单测；私服 validation 全场景；上线后探针核对 `spawnQueue`。
