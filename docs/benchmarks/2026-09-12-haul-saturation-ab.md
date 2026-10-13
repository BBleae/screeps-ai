# 2026-09-12 搬运饱和度：同快照 A/B 与私服验证

目标（用户口径）："搬运工的效率还是太低了……不是只靠堆搬运工数量就行了，必须让每一个搬运工尽可能工作饱和"。
衡量的是**每只搬运工的有效满载 tick**，不是搬运工数量。

## 方法

- 同一线上快照分叉两份私服世界（`scripts/soak/rcl_benchmark.js --fork-world/--fork-db --src-rev`），除代码外完全相同，各跑 2 万 tick。
  - 快照 A：`db-150000.json`（tick 149992，8 房、RCL5–7）。
  - 快照 B：`db-600000.json`（tick 599992，成熟经济，房间大多能量过剩）。
- 运输口径：新加的 `Memory.haulStats`（v2，按 transfer/withdraw/pickup 钩子记账，行为中立）→ `scripts/soak/haul_ab.py --warmup 3000`。
- 经济口径：数据库侧账本（用户 `gcl` 增量 = 全账号 CP）→ `scripts/soak/rcl_ab.py`。
- 遥测本身先独立验证：同一份代码分叉两次（A vs A2）读数差 < 1%，噪声足够小。

## 诊断（v1 遥测，600k 快照）

| 现象 | 读数 | 解释 |
|---|---|---|
| 忙碌率 | 53% | 空等 44%（房里没货可搬），不是"人手不够" |
| 在途装载率 | 0.13 | 车上平均只有 13% 的货 |
| 每 CARRY 每 tick 运量 | 0.29 | 一半的 CARRY 在空跑 |
| 装卸 tick 同时挪位 | 8–12% | 每次停靠白扔 1 tick 多 |

也就是说：瓶颈在"每趟运多少、每 tick 有没有在动"，而不是编制数量。

## 第一批改动（7b1a320 → 06de615）

同 tick 动作 + 移动、按量预留（不再按"槽位"）、取货门槛随路程和容量变化、在有进账的源容器旁补满、
storage 倒腾保护、溢出按源带滞回、升级者先喝 ctrl link、路网变化后刷新寻路缓存。

150k 快照：

| 指标 | 7b1a320 | 06de615 |
|---|---|---|
| 全账号 CP/tick | 111.6 | 116.8（+4.7%） |
| hauler 运量/tick | 118.1 | 130.5（+10.5%） |
| 每 CARRY 每 tick 运量 | 0.60 | 0.67 |
| 倒腾（storage→storage）/tick | 1.45 | 0.45 |
| 装卸同 tick 起步 | 8% | 41% |
| 采集/tick | 218.7 | 219.7 |
| 错误 | 0 | 0 |

600k 快照：CP/tick 94.6 → 94.1（持平），运量 72.1 → 74.4；但暴露出新问题——
park 占空闲从 11% 涨到 60%、倒腾从 0 涨到 1.98/tick：成熟房里"为某个缺口从 storage 取了货、
缺口却已被别人认领"，货被锁在身上 100 tick。这正是第二批修复的对象。

## 第二批改动（对抗审查 + 外矿 + 编制）

45 个代理的对抗审查（每条发现 2 个反驳者）确认 16 条，逐条修掉后又对合并的外矿/编制改动做了第二轮
（6 维度 23 条发现，22 条被反驳，成立的 1 条已修）。落地的行为改动：

1. **干涸的源不算进账**：源采空等再生时，容器旁的矿工 WORK 不再被当作"进账"，到达量按源里还剩多少封顶。
   否则 hauler 揣着半车守在永远不涨的容器边，或在两格之间每 tick 来回跳。
2. **补满目标不粘住**：这一 tick 没在补满容器取货/等候就清掉，不会下一 tick 又被拽回去。
3. **跨房认领不挡本房**：援建 hauler 在路上按 50 格全额预留本房任务，本房 hauler 因此被挡一整趟路；
   现在等它进了房、路程是真的再参与排队。
4. **矿物不再进取货池**，身上已混进矿物的先卸进 terminal/storage（否则永远占着容量）。
5. **storage 零头当场解锁**（< max(50, 25% 容量)），不再揣着 5 能量在 storage 边等满 100 tick。
6. **载着货的不从 storage 补货**：storage 取货只为没人认领的消费者缺口。
7. **需求缓存在有人租下缺口时作废**，并扣掉揣着 storage 货在等缺口的 hauler。
8. **路网签名逐格混合**：原来 Σ cell×K 是线性的，两格一上一下各挪一格就抵消，路网变了却不重算。
9. **外矿运输**：取满/投递的那一 tick 就起步、不站在矿位挡矿工、进账不划算就带半车走、按 TTL 规划最后一趟、
   回家路上顺手建路工地；停用期间作废腿长计时（否则在家挂机的 150 tick 被当成路程，还能跑两趟的 hauler 被判退役）。
10. **编制按 CARRY 定尺寸**：孵化花费 EMA 取代只在补货时采样的收入 EMA，模型/实测/突发三条 C* 取大，
    头数按满配身体折算并带滞回；hub 房把 storage 补给算成 base 项。

## 私服验证（部署门）

`node scripts/private_server/run_validation.js --effect-ticks 900`，世界 `validation-NWlcNk`：

- **126 条生效断言全部观察到**，其中本轮新增：`broker.drySourceNoInflow`、`broker.farClaimIgnored`、
  `hauler.mineralSalvage`、`hauler.storageResidualRelease`、`hauler.loadedSkipsStorage`、
  `hauler.actAndMove`、`hauler.fillAtFedContainer`、`hauler.hubBudgetedWithdraw`、`broker.spillHysteresis`、
  `upgrader.linkBeforeStorage`、`upgrader.linkRelief`、`broker.ctrlLinkSkipAtStorageStation`、
  `movement.pathRefreshOnRoads`、`remoteHauler.*`、`hauling.*`。
- 163 个房 `Memory.errors` 全空，CPU 峰值 17/140，通知错误 0，与基线无回归（`baselineWarnings: []`）。
- 过程中修掉三处验证基础设施问题（证据被同母房另一条外矿覆盖、新分支抢先记到另一个计数器、随机地形让夹具播不下源 link）。

冒烟测试新增 10 条断言，每条都先在改动前的代码上确认会失败。

## 部署

2026-09-12 14:32（tick 73648703）部署到 `default`（activeWorld），版本 **1789191035576**，`Memory.errors` 为空。

线上前 150 tick 的早期读数（窗口很短，仅供参考）：全账号 CP/tick 169.3 → 207.2，CPU 均值 75.9 → 75.4（持平）。

## 待补

- B2 分叉（部署版本，150k/600k）与 A-v2 臂的同快照对比正在跑，结束后补进本文。
