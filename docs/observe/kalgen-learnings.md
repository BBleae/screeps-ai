# 向 Kalgen 学习：观察 → 我们的现状 → 差距 → 改动

人工维护的清单，按日期追加；自动报告在 `docs/observe/kalgen.md`（launchd 每 6 小时重生成，原始快照在 `data/observe/Kalgen/`）。
每条都要有证据（快照/回放里的数字）和对应到本仓库文件的现状，否则不写。

Kalgen 是谁：世界 GCL 榜第 1（2025-07 起每月 rank 0），GCL 4.96e10，89 房（shardX 86 房全 RCL8，shard3 3 房 RCL7/8/8），
power 1.51e8（power 榜第 4）。他的账号规模和我们（3 房，RCL5/4/1，GCL 12）差 4 个数量级，所以要学的是**设计原则和单位经济**，不是照抄 RCL8 的做法。

## 2026-09-04 首轮观察（快照 20260904T082037Z，110 次请求）

### 账号级基准（每房每 tick，以 shardX 平均 2.47 s/tick 换算）

| 指标 | Kalgen（1h / 24h / 8d） | 我们（1h / 24h） |
| --- | --- | --- |
| 采能 | 67 / 71 / 66 | 26 / 21 |
| 进控制器 | 25.5 / 28.5 / 25.1（占采能 38–40%） | 3.8 / 6.6（15–32%） |
| 花在 creep 上 | 22.4 / 23.5 / 21.5（占 33%） | 10.3 / 6.8（33–40%） |
| 建造 | 5.8 / 6.5 / 6.3（占 9%） | 10.4 / 5.3（25–40%） |
| 每房每小时孵出部件 | 370–400 | 90–118 |
| 每部件能量 | 81 | 72–82 |
| 每千部件损失的 creep | 5–7 | 8（24h）/ 58（最近 1h） |

- `creepsProduced` 是**部件数**不是 creep 数（用我方账号校准：29650 能量 / 364 = 81 每部件）。
- 结论：creep 开销占采能 1/3 是顶级玩家的稳态，我们已经在这个区间；差距在采能总量（外矿数）和建造期结束后能否把 40% 交给控制器。
- 需要持续盯的两个比值：creep 占比 ≤ 0.35、每千部件损失 ≤ 10（我们最近 1 小时 58，是外矿 creep 被打死/退役还是 TTL 到期，下一轮用 monitor 的 defenseLog 对照）。

### 房间设计（89 房全部成立的规律）

1. **控制器贴着核心**：storage→controller 切比雪夫距离 2/3/4 的房各 11/35/43，没有一个 >4；spawn 距 storage 1–3。升级者静止站在 storage 与 hub link 之间、控制器射程 3 内，从 storage/link 直接取能——**全账号没有控制器 link、没有控制器容器**，升级这条线零 hauler 往返。
   - 现状：轮子方案 W33S7 storage (31,26) → controller (34,24) 距离 3，W34S7 距离 4，几何上一样；但我们的升级站是控制器容器 (33,25)，距 storage 2，**不相邻**，所以 RCL5 仍靠 hauler 第三层投递喂容器（`src/task_broker.js` deliver tier 3），ctrl link 建成前一直如此。`src/roles/upgrader.js` 已支持"相邻 storage"取能，只是站位选不到相邻格。
   - 差距/改动：storage 建成后把升级站位改成"与 storage 相邻且在控制器射程 3 内"的格。已核对 W33S7 方案：(32,26) 空格，距 storage 1、距 controller 2、同时紧邻 terminal (32,25) 与 store link (32,27)；(31,25) 也空，距 storage 1、距 controller 3、紧邻 ctrl link (32,24)。两格都能让升级者直接从 storage 取能，控制器容器与 ctrl link 都可以省掉，hauler 第三层任务消失。
2. **link 用途**：RCL8 六个 link = 2 个源 link + 1 个 hub link（storage 旁，兼作升级供能）+ 3 个**边缘 link**（贴房间出口）。回放里外矿 hauler（lhauler）走到出口旁一格就把 800 能量卸进边缘 link，从不进基地；hub link 再喂升级者。258 个边缘 link / 89 房。
   - 现状：`plan.links` = store/src0/src1/ctrl（`src/links.js`：RCL5 ctrl+src0，RCL6 +src1，RCL7 +store）。
   - 改动（RCL7/8 规划）：ctrl link 改为紧邻升级站的 hub link；RCL8 多出的 link 放在通向外矿的出口内侧，remoteHauler 目的地改为最近的边缘 link（3% 损耗换掉基地内 20–40 格往返和拥堵）。
3. **母房不建容器**：77/89 房容器数为 0。矿工 W10C8M5 直接把能量 transfer 进源 link（回放：每 6 tick 一次 100），没有容器衰减和维修；升级者也不用容器。
   - 现状：src0/src1/ctrl 三个容器是我们 RCL2–5 的物流骨架，合理；差距在 RCL6+ 源 link 建成后容器仍保留。
   - 改动：源 link 建成后不再重放/维修该源容器（`src/layout.js` 的容器配额、`src/demolition.js` 顺手拆），矿工改为 link 直投。
4. **rampart 只护关键建筑**：2503 个 rampart 里 1570 个压在建筑上（塔 519、extension 476、spawn 262、lab 92、terminal 89、storage 89），shard3 三房**没有一格裸地 rampart**；每房中位 27 格，constructedWall 0；RCL8 均值 4.1e7 血。
   - 现状：轮子的 min-cut 防线 W33S7 84 格、W34S7 31 格；RCL5 目标 1e5 血/格（`config.rampartTargetHits`）；今天 W33S7 45 个工地里 32 个是 rampart。84 格 × 每 100 tick 衰减 300 = 每 tick 252 血，塔在射程 ≥20 时每 10 能量只修 200 血，即使全靠塔也是每 tick ≈ 12 能量的固定维护，是一口源的 60%。
   - 改动：`plan.ramparts` 排序改为"压在塔/spawn/storage/terminal/lab/extension 上的先放"，min-cut 外环推迟到 RCL6+ 或 storage ≥ 某阈值；RCL5 只保留关键建筑上的 rampart。
5. **零工地**：89 房 constructionSites 全为 0，道路中位 127 格，外矿道路由 eworkroad（W6C6M6）维护。塔能量均值 912，storage 能量中位 2.2e5，terminal 9.4e4。
6. **3 个 spawn 只忙 45%**、每房 creep 均值 9.1（5–17）：一房只养 2 矿工 + 1 升级者 + 1 filler + 1 lab 搬运，其余全是外矿 creep。我们单 spawn 是当前瓶颈（RCL7 才有 spawn2），所以更要省 spawn 时间（见身体部分的 reserver）。

### 身体与角色（20 种原型，全账号）

| 角色（名字前缀） | 身体 | 数量 | 说明 |
| --- | --- | --- | --- |
| eharvest | W10C8M5（shardX）/ W10C1M5（shard3、外矿） | 221 | 每源 1 只，20/tick 把源 150 tick 采空再等再生；换班空档 ≤150 tick 不损失产量 |
| lhauler / shauler | C32M16（1600 容量，2400 能量） | 214 | 外矿每源 1 只；满载 1600 一趟，卸到边缘 link / storage / spawn |
| efiller | C16M8（800） | 104 | 基地里唯一走动的 creep，每次给 extension 200，回放每 tick 移动 0.37–0.8 |
| xboostedUpgrader | W15C16M1 + XGH2O×15 | 100 | RCL8 上限 15 能量/tick，强化后 30 进度/tick；静止 |
| legacyscientist | C8M4 | 90 | lab 搬运，静止待命 |
| llinkUpgrader | W1C16M1 | 7 | **storage < ~1.7e5 时的降级保级升级者**（强化房 storage 最低 1.1e5、保级房最高 1.67e5，中间有滞回） |
| praiseUpgrader / eswithdrawUpgrader | W45C4M1 ×5 / W47C2M1 ×3 | 9 | RCL7 房 W15N28 用 8 只共 ~370 WORK 冲 RCL8，直接从 storage/terminal 取能（storage 2.8e5） |
| ereserve / hreserve | M7L7（4550） | 9 | ~200 个外矿只养 9 只：一趟把预定顶到 5000 就退场，预定快耗尽再孵 |
| mineralHarvest / mineralDeliver | W24C12M12 / C6M3 | 46 | 矿物专职 |
| eworkroad | W6C6M6 | 8 | 外矿道路建造/维修 |
| eguardian / guardp / guardo | M4R2H2、M5A5 | 少量 | 外矿护卫 |

- 现状对照：矿工 `utils.makeBody('staticHarvester')` 5W3M（650）；hauler CC+M 成对到 48 部件（最大同为 C32M16）；remoteMiner 5W1C3M（700）；reserver 1–2 CLAIM 常驻（`config.remote.reserverDoubleClaimCapacity` 1650）；upgrader WORK 封顶 15（RCL8 以下不该封，已知项）。
- **10 WORK 矿工的账**：比 5W 多 650 能量 / 1500 tick ≈ 0.43/tick，一口源 20/tick 的 2%；我们母房实测 19.5/tick（97.5%），母房不值得换；外矿换班要走 50–150 tick、还常被 Invader 打断，先用外矿房的源能量（是否停在满值）量出空转比例再决定。
- **reserver 的账**：M7L7 一次 4550 能量顶满 5000 tick 预定；我们 2 CLAIM 常驻每 600 tick 1300 能量，折到 5000 tick 是 1.08e4——能量贵 2.4 倍、spawn 时间贵 5 倍。RCL7（容量 5600）起改成大 CLAIM 一次性补满、预定 <1500 才再孵。
- **升级者随 storage 缩放**：有能量就上 W45 冲级（praise），不够就 W1 保级；我们现在按容器 EMA 加减升级者。storage 建成后改为按 storage 能量分档决定 WORK 总数。

### 物流与行为（100 tick 回放 W18S4 / W18N28 / W16N28 / W15N28）

- 源采集速率恒为 20/tick（10 WORK）；矿工 0 移动；升级者 0 移动、每 tick 15 能量、从 hub link 一次取 ~400。
- efiller 每次卸 200（一个 RCL8 extension），沿 extension 排走；terminal/spawn 也归它。
- shauler 在母房内每 tick 移动 0.75–0.93，卸货对象 spawn/storage/terminal；lhauler 站在出口内一格，卸进边缘 link 后原地等（回放 62 tick 只动 2 步）。
- spawn 的 `directions` 每只 creep 都不同（如 [7,8,6,1,5,2,4,3]），按目的地方向出生。
- lab 全账号都在跑 GH → GH2O → XGH2O（升级强化）链，storage 里各 X 级化合物各 1.7e4–3e4。

### 可行动清单（按收益/成本排序，逐项走 测试 → 私服 → 部署 流程，一次一项）

1. **升级站位改为 storage 相邻格** —— 已实施（2026-09-04 19:2x，提交 5722aab，版本 1788518105738）：`layout.upgraderStorageStations` 选 storage 相邻、控制器射程 3 内的格（W33S7 得 (32,26)/(31,25)/(31,27)，都是规划道路；W34S7 的 storage 离控制器 5 格，没有候选格，照旧走容器/link），升级者以 storage 为锚直接取能；`task_broker.controllerFeedStorage` 取代控制器容器投递（storage < 2000 第三层补、< 500 且 spawn 过半时先送）；spawn 的 hauler 往返不再算控制器段、升级者 EMA 改看 storage 能量 / 30000。W33S7 的 storage 工地 (31,26) 尚未建成（tick 73481114 时 7000/30000），建成后回填：升级者是否挪到 (32,26)、hauler 是否停送 (33,25)、升级速率变化（详见 `logs/optimizations.md` 同日条目）。
2. **rampart 先护建筑、外环推迟** —— 已实施（2026-09-04 18:1x，提交 7be9041，版本 1788512130666）：`config.rampartRingMinRcl=6`，RCL6 前只给 spawn/塔/storage/terminal 盖 rampart，零进度外环工地由 `trimSites` 清掉，核心建筑上的 rampart 按 RCL 目标维修。上线 250 tick 实测：W33S7 工地 42 → 9、W34S7 17 → 2、全局 78 → 36，W33S8 用释放的名额把道路工地从 18 放到 24（详见 `logs/optimizations.md` 同日条目）。
3. **升级者按 storage 能量分档** —— 已实施（2026-09-04 20:0x，提交 e4ef1eb，版本 1788519110574）：只对 storage 供能的房生效，storage < 5000 进低档（550 的 W4C2M1、不加员），≥ 10000 退出（滞回）；升级者从 storage 取能留底 2000；RCL8 以下不封顶 15 WORK（RCL6 W21C2M1、RCL7 W47C2M1，即 Kalgen 的 eswithdrawUpgrader）。与第 1 条一样等 W33S7 storage 建成后回填实测。
4. **测量外矿源空转**：`scripts/monitor.py` 记录外矿源 energy==capacity 的比例，≥10% 再把 remoteMiner 升到 10 WORK（容量 ≥1800）。
5. **RCL7/8 link 规划**：hub link 取代 ctrl link；边缘 link + remoteHauler 就近卸货；源 link 建成后不再保留源容器。
6. **reserver 大 CLAIM 一次性补满**（容量 ≥4550 时）。
7. **持续基准**：每周看 `docs/observe/kalgen.md` 里"我方同口径"一行，creep 占比、每千部件损失、每部件能量三项偏离基准就查原因。

### 长期观察要点（自动报告的 diff 一节会标出）

- `roomsGained`：Kalgen 新占房 → 立刻对该房加密抓 history，记录 RCL1→8 的建造顺序和 creep 编制，这是对我们最有用的样本（当前 89 房全是 RCL7/8，看不到早期）。
- `newSignatures`：新身体签名出现说明他改了代码或进入新阶段。
- 名次/GCL 增速：每轮一行的时间线。
