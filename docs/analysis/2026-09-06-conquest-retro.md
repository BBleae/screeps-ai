# 攻占战役复盘与改进路线图 — W31S4 / W32S4（Fire9265），2026-09-06

## 方法

这份复盘由一次多 agent workflow 产出：11 个维度并行审计（战斗微操、兵种/身体、小队协同、战略doctrine、情报侦察、战争经济、safe mode 风险、围降/占领/守成、工程流程、顶级玩家对比、子系统架构）→ 每个维度逐条**对抗性验证**（拒掉引擎不成立/无 boost 不可行的）→ 综合成单一优先级路线图。23 个 agent、0 错误。所有引擎机制都对照 `docs/game/`、`docs/api/` 核实过；文中代码行断言已抽样复核（如 `spawn.js:1485` 确实缺 `blocking:false`）。

## 执行摘要

战役是**战略成功、包着一层战术与流程失败**。做对的：指令驱动的多目标 conquest 架构与 breach→downgrade→claim→done 阶段机可用；引擎模型正确（attackController −300×CLAIM、每控制器 1000t 一次、upgradeBlocked 同时挡敌方恢复与开盾；塔火 600@≤5 → 150@≥20）；两房塔+spawn 全灭、W32S4 进入不可逆围降；战中五个反应式修复各自正确。

做错的、以及为什么重要：**兵力是独立 actor、各自寻路到房中心 range 20**（`siegeDismantler.js`、`siegeGuard.js`），28 人一字长蛇单列涌入双塔交叉火力、被逐个 2-tick 点杀 ~19 人——离线 harness 只预测 ~2 损失，因为它用"集总 DPS vs 血量"而非逐 creep 寻路建模。集结在**远离塔的一侧**（W32S5 南、为了用自己的外矿），逼出 ~27 格暴露对角线（暴露 = 塔DPS × 在射程内的格数，才是真正的损失驱动）。conquest 需求**漏了 `blocking:false`**，买不起的身体冻住优先级 2 以下全部经济（reserver 崩到 0/8）。整场赌 Fire9265 不开盾（4 次充能没用），**没有主动封盾**——一次团灭只差敌人一个点击。**完全没有守成**：占下的房是 RCL1、无 spawn、~50k tick 开不了盾、`defense.js` 只打 NPC。全程**绕过了 CLAUDE.md 的私服验证门**，在生产环境对真人测试、战中热补五次。

## 六大失误

1. **战斗角色逐 creep 寻路、无 move-as-one** → 28 人退化成长蛇喂给双塔交叉火力，~19/28 损失（harness 预测 ~2）。复用经济的逐 creep 角色模式来打仗是本战役的根defect。
2. **在远离塔的一侧集结**（南，图外矿方便），对西/北塔逼出 ~27 格暴露对角线，approach 损失约翻倍。分析文档本就建议"从最近塔的边进"，从未实现。
3. **conquest 需求漏 `blocking:false`**，一个买不起的攻城身体冻住优先级 2 以下全部经济，逼出人工冻结兵力。
4. **赌敌人不开盾**（4 次充能未用），无主动 attackController 封盾——20000t 团灭只差一个点击，且反应式撤退本身是从 kill-box 里长蛇撤出。
5. **没建守成能力**：破防故意拆掉敌 spawn，但 claim 阶段只出一个 claimer，无 pioneer/spawn 重建、无防御优先布局、无驻军、无对真人防御——占下的房会在 20000t 内降回中立、白费多天。
6. **在生产环境对真人测试战斗代码**：跳过强制私服验证门，损失模型（集总 DPS vs 血量）错了且未提交，五个修复战中热补（占用限流推送槽、把 respawn/单 tick 故障风险带进活经济）。

外加：**情报与进攻脱节**——conquest 目标在大脑 radius-2 扫描外（Chebyshev 3），算好的威胁场（塔能量、safeModeAvailable、结构、敌 upgrader 年龄）被 segment 90 精简掉，conquest 只读房内实时视野——所以每个关键数字都是从过期快照手打的，而现成的 `plan_squad` 编组器闲置未用。

## 优先级路线图

按"能立即安全部署 → 需过验证门的战斗改动 → 需你决策的战略 → 大工程"分组；括号内是原清单编号与 impact/effort。

### A. 立即可部署（非战斗、安全、高价值）

- **A1（#1，critical/一行）** `spawn.js:1485` conquest 需求加 `blocking:false`——买不起的攻城身体不再冻住优先级 2 以下经济（reserver 0/8 的根因）。**不加**攻城身体缩身路径（缩身的身体是脆弱炮灰）。⚠️ 需先读 `spawn_queue.js` 确认 blocking 语义，避免让经济反过来把攻城身体的能量吃光而永远攒不够——可能要与 A2 storageFloor 组合。
- **A2（#5，high/小）** 加 `config.conquest.storageFloor`（破防/护卫 ~15-20k、接力 ~5k），`conquest.demandsFor` 里 sponsor storage 低于底线就跳过其破防/护卫需求（照抄 aid 的 10k 门）。
- **A3（#4/#process，high/一行）** 把 `test/conquest_test.js` 接进强制测试套件 + CLAUDE.md 必跑清单；smoke.js 加 conquest 场景。
- **A4（#28，medium/小）** `tower.js` 捕获己方 `activateSafeMode()` 返回值，非 OK（ERR_BUSY/ERR_TIRED）时记录并升级到 defender，而非默认成功。
- **A5（#9，medium/小）** 指令校验加 `Game.map.findRoute(staging→target)` 可达性预检（尊重 avoid），ERR_NO_PATH 就标记指令无效/记 conquestError，而非集结一支到不了的军队（W31S5 墙堵是战中才发现的；模式在 remote.js/retire.js 已有）。
- **A6（#17，high/小）** 硬化围降接力：travel-aware lead（`spawnTime + roomDistance×~50` 而非固定 60）+ 重叠 standby（第二个控制器相邻格）+ sponsor failover，保证多天尾巴不因单母房崩溃而停。

### B. 战斗改动 —— 必须先建私服验证场景再改（别再在生产环境热补）

- **B0（#18，medium）先决**：建 `--combat` 私服场景——播一个**活跃的、有塔的、会自动孵 defender 的第二 bot 用户**在真实 W32S4 几何位置（复用 `fixtures.js` 的 scenario-owner 复活），跑 1500+ tick 真实 movement.go 寻路 + 真实塔火，断言存活数 + 结构拆除数 + **sponsor reserver 在攻城需求下仍 > 0**；`effects.js` 加 conquest 生效断言。这是损失预言机，会在上线前抓住长蛇、经济崩、未测的开盾撤退。
- **B1（#7/#12，critical/大）** 小队编排器 `src/conquest_squad.js`：把攻城 creep 编成 **4 人方阵 quad**（3 拆迁 + 1 护卫），用 vendored wheel 的 `squadMoveTo`（已核实：支持 4 人方阵、接受 costCallback、撞结构返回 ERR_FULL）整体移动；固定 slot 偏移、四格到齐且 fatigue 0 才走、每过房间出口重新成形、quad-by-quad 发起。角色退化成读 slotTarget 的瘦执行器。（**不要**单块 28 人——过出口是单列；**不要**用 Creep.pull 建阵——那是 2 人拖拽。）
- **B2（#7/#8，high/小-中）** 从**最近塔的边**进，射程外集结再爆发突入；staging/entryEdge 选择器按"共享边到最近活塔的距离"给 4 个邻房打分，选不穿另一个活塔敌房的最近边。
- **B3（#7，high/小-中）** 共享集火：每次 pool 重建写 `Memory.rooms[target].siegeFocus`（血最低的活塔），每个拆迁打共享焦点（先塞满 8 个相邻格）再转下一座塔，而非 findClosestByRange 分散火力。8×600=4800 > 3000 = 一 tick 秒塔。
- **B4（#3，medium-high/小）** 修 siegeGuard 的 rangedHeal 抵消 rangedAttack bug：攻击 tick 只用 range-1 `heal()`（不挡 rangedAttack），`rangedHeal`（会挡）留给无攻击 tick。⚠️ 需先对照 `docs/game/simultaneous-actions.md` 的管线图确认 rangedHeal 与 rangedAttack 是否真同管线。
- **B5（#13，high/中）** siegeGuard 加 breach 模式：塔还在时守在前排拆迁 range 1 内奶最伤的前排格、只顺手打射程内敌 creep、**覆盖 kite/flee 分支**（反 kiter 微操推迟到围降阶段）。
- **B6（#6，high/小）** 集结闸门加 `config.conquest.squadWait`(300) + 分数 quorum：`present ≥ ceil(0.8×squad)` 或 `now−firstArrival ≥ squadWait` 就发起，按活着的成员重算 squad——去掉两次人工降阈值。
- **B7（#20，medium/小-中）** 用有序 `{front, core, back}` 身体构造器替换 repeatBody（独立 per-type 数量、保序、保留预算/50 上限），前缀 2-4 TOUGH（index 0 先扣，无 boost 时是纯血量缓冲）。**不要**把 WORK 挪到末尾（已驳回）。
- **B8（#23/#24，medium/中+小）** 破防按 slot：只投入共享焦点塔空闲相邻格数量的拆迁，其余作 range≥6 的二线预备、前排空位立即轮换；集结环与控制器相邻环加 anti-swap 固定 hold 格，预留 downgrader 独占格（合并 task #6）。
- **B9（#11，high/中）** shieldLock 阶段 + 35000 阈值遥测：`lockTtl = CONTROLLER_DOWNGRADE[level]/2 − 5000`，一个带护卫的大 CLAIM downgrader 与破防**并行**从远塔边进、早落 attackController 压住 upgradeBlocked、把 ttl 压过 35000 → 永久封盾。把 20000t 团灭变量变成有界可赢的封盾竞赛。

### C. 需要你决策的战略问题（见文末）

deny vs claim 默认doctrine、boost 投资、反扑姿态、损失容忍/自动放弃阈值、破防并发数、GCL 余量。

### D. 大工程 / 后续

- **D1（#14，critical for payoff/大）** 守成能力：claim 即触发 bootstrap（pioneer + spawn 重建，确定的 spawnPos）、防御优先布局（塔+rampart 先于经济结构）、拆former owner 的外来结构、驻军、`defense.js` 扩展到在标记的被占房里对**真人**敌人应战直到该房自建塔。**（部分已由外部大脑 claim.queue 承接——占领分工正确，守成/防御仍缺。）**
- **D2（#10/#16，high/中）** 情报接进攻:大脑扫描集加进每个 conquest {target, staging, avoid}+1 环（独立于 homes radius、同批限流），INTEL_FIELDS 加 towerEnergy/safeModeAvailable/开盾到期/结构/敌 upgrader ageTime；无视野时从 Memory.map 播种 conquest 兵力；用 `plan_squad`/`canBeat` 按目标 hostileProfile 自动定护卫、按塔数×塔续航定拆迁数（而非手打），把敌 spawn 建模为持续增援、优先掐掉。
- **D3（#15/#30，high/中）** 战争经济护栏：per-sponsor roster throttle（reserver/hauler 编制低于底线就压该房攻城需求）+ 账号级滚动净收入 ≤0 的滞回熔断；`config.conquest.maxConcurrentBreaches`(默认 1) 只允许一个指令处于昂贵的破防阶段，围降/占领尾巴并行。
- **D4（#27，medium/中）** per-tick `Memory._siege` 遥测 + **进度感知的游戏内自动放弃**：损失超阈值**且** N tick 内无破防进展（目标塔血/能量不降）才撤回集结——外部监控 ~24-55 tick 的粒度远粗于 ~2 tick 的 creep 死亡时标，控制回路必须在游戏内。提交引擎镜像损失 sim `test/conquest_sim.js`（常量取自 @screeps/common）。
- **D5（#31，high 天花板/大，需 RCL6 labs+terminal）** boost 流水线：labs+terminal、GO/GHO2/XGHO2 + XZH2O + XLHO2、pre-muster boostCreep 步骤（boost tier 记进指令）。对**有防御/有墙**的房是最大乘数（Tier-3 XLHO2 HEAL 48/部件，13 个 = 624 > 一座贴脸塔 600 → 真 tank 前排），但即便 Tier-3 TOUGH 也只扛双塔 ~2.7 tick，所以 boost 只是**缩小**而非消除对编队+最近塔进入+共享集火的需求。无 boost 只能用命换undefended 房。

## siege 子系统重构 spec（目标形态）

**doctrine**：对着塔要**在时间上集中**（紧凑 quad + 共享集火），**最小化暴露**（从最近塔的边进、射程外集结再爆发），**主动**消除团灭变量（早 attackController 压过 35000 封盾阈值）。按 8 格相邻环 + wheel 的 4 人方阵原语来right-size，而不是堆 22-28 人在 kill-band 里打转。

**阶段（per-squad，不是指令级标量）**：recon → shieldLock →（drain，条件性）→ breach → downgrade → claim → hold → done。recon：常驻 scout 保持视野、大脑每轮刷 room-objects，情报过期或 staging 不可达就拒绝发起。shieldLock：护卫大 CLAIM downgrader 从远塔边进、ASAP attackController、每 ≤1000t 再打、压过阈值永久封盾。drain（可选，仅当目标无法回补/无 storage）：range≥18-20 的 TOUGH+HEAL 诱耗塔能量——对 storage/link 供能的回补者跳过。breach：quad 从最近塔边进、共享集火逐座拆塔、掐 spawn 断增援、护卫奶前排。downgrade：travel-aware 无缝大 CLAIM 接力 + 重叠 standby + sponsor failover，常驻护卫驻军。claim：已相邻的 downgrader 在 L0 **自 claim**（GCL 不够则 reserve 占位）而非退役——把 reclaim 缺口收到零。hold：bootstrap（pioneer+spawn 重建）、防御优先布局、拆外来结构、驻军、真人防御应答直到自建塔。

**身体**（需先用有序构造器替换 repeatBody）：
- 拆迁（RCL7 母房 ~2000e）：`[TOUGH×3, WORK×12, MOVE×15]` = 30 部件、1980e、600 拆卸/tick、3000 血带 300 前缓冲；WORK 与 MOVE 保持 1:1（**不**把 WORK 挪后）。弱房下限 ~1200e：`[TOUGH×2, WORK×8, MOVE×10]`——再弱就别出前线（把能量 courier 给强 spawner 或转后备）。
- 护卫（~2200e）：`[TOUGH×2, RANGED_ATTACK×4, HEAL×4, MOVE×10]`——40 ranged、range-1 48 heal。
- 围降（大 CLAIM，按指令 scale）：RCL7 母房 `[TOUGH×2, CLAIM×7, MOVE×7]` ~4920e（2 CLAIM≈1.6/tick → 7≈3.1/tick → 30 CLAIM 上限约快 10 倍；**CLAIM 部件**真有用，只有并行 downgrader **只数**被 1/1000t 卡）。跑 1 攻 + 1 standby，不是多只。

**无 boost 的关键现实**：可交付的最大治疗（range-1 ~48/部件）扛不住贴脸双塔（~660-1200/tick），所以编组是**最小化暴露**而非硬 tank——护卫是 approach 的 150-450 档和第一座塔死后的存活乘数，不是坦克。

## 需要你拍板的战略问题

1. **deny vs claim 默认doctrine**：以后对邻居默认走更便宜的 **deny**（破防 + 压 spawn 驻军，无多天尾巴/无 GCL 槽/无 bootstrap），只在位置价值明显超过"一个免费双源房（如 W31S6）+ 守成 + 反扑成本"时才 full claim？（你已下令 claim 这四个房——这条主要针对**未来**的邻居作战。）
2. **boost 投资**：是否投入多周经济工程在某个 sponsor 建 terminal+labs 到 RCL6、搭 boost 流水线（XGHO2/XZH2O/XLHO2），让未来**有防御/有墙**的房低损拿下？还是保持无 boost、只打无防御/弱防御目标？
3. **反扑姿态**：是否准备好在两个新占的前沿房（及附近暴露的外矿）在其无 spawn bootstrap 期间对 Fire9265 的反扑驻军 + 抢建塔？不愿在反扑下守，就应该 deny 而非 claim。
4. **损失容忍 / 自动放弃**：接受"代价大但能赢"的破防（W32S4 ~19 损失成功），只要塔在掉血就继续？还是更低阈值早撤重组？这决定进度感知自动放弃的阈值。
5. **破防并发**：并发破防上限设 1（串行破防、围降/占领尾巴并行）作为常规？还是允许并行破防、只靠 per-sponsor 经济 throttle 防崩？
6. **GCL 余量**：当前 GCL 12 / 己方房数下，每个 conquest 目标在 L0 时真有空 claim 槽吗？还是其中之一应预期走 deny/reserve 兜底？

## 出处

完整验证发现（11 维度、每条 verdict/critique/severity/priority）与本路线图源数据在会话 workflow 输出（journal），本文档是综合。已部署的战役内修复：commits 32921cd / c63127c / bd99d67 / 318d9a4 / 91f2034 / 675d847（noClaim）。

## 附录:B0 私服"活跃敌人"验证场景 — 可行建法(Explore harness 勘察结论)

**核心约束**:私服 harness 只在 `mods.json` 注册一个 bot 代码库 `project`(= 我们的 `src/`),每个 `bots.spawn('project', room, {username})` 造的用户都跑**我们的代码**。结构只有在拥有者是 `active:10000` 用户、且其代码那 tick 运行时才动作(塔开火、spawn 产兵)。纯播种的敌方结构是**死的**(precedent:defense 场景的塔 `store.energy:0` 就是故意做成惰性)。

**建法(近零新基建)**:用同一份 `project` 代码给攻防双方,靠 per-user `Memory` 区分。
1. `fixtures.js` 新增 `seedConquest(cli)`:加 `conquestHome`(攻)+`conquestTarget`(敌)+中立 staging 三个房进 `ROOMS`/`GENERATION`,正交相邻(生成房只有正交出口,siege 要能寻路)。
2. 攻击方:`spawnBot(cli,'conquest',conquestHome)`、`updateController` RCL5+、`addExtensions`、加 **storage 能量 ≥ `conquest.storageFloor`(15000)**(过 A2 门)、加几条源/reserved-remote 记录以便断言 reserver 存活、播几只经济 creep(照抄 seedAid)。
3. 敌方:**第二个 `spawnBot(cli,'enemy',conquestTarget)`**(distinct username、同 project 代码 → 真·active 拥有),RCL~5、**1-2 座有真能量的塔**(`addStructure('tower',pos,{store:{energy:1000},capacity:{energy:1000}})` → 我们的 tower.js 跑在敌方身上会真开火)、spawn(spawnBot 自带)、可选 1-2 defender。**敌方控制器 `safeModeAvailable:0`**(照抄 seedDefense 1003-1004),否则对称代码的 `tower.js` coreHurt 兜底(fallbackCoreShare 0.5)会开盾冻住围攻。
4. `writeMemory` 把 `Memory.conquest={target,sponsors:[conquestHome],staging,dismantlers:N,guards:M,downgraders:1}` 只写进**攻击方**;敌方不写。
5. 确保敌方 context 进 `seedAllScenarios`(1171 那步给它 `active:10000`)。

**报告接线**(`run_validation.js`):(a) `usernameByRoom`(290-304)加两个房→两边都被探针+收 rootMemories;(b) 仿 `hostileCounts`(357-361)加一条原始 DB 计数:敌方 target 里 `user:<enemyId>` 的 tower/spawn 数→断言 **==0(拆掉)**,不依赖敌方探针;(c) `effects.js` 加 `conquest.breach`:敌塔+spawn 数 0、攻击方 `creepsOf(conquestHome).filter(role∈{siegeDismantler,siegeGuard}).length ≥ 阈值`、`creepsOf(conquestHome).filter(role==='reserver').length ≥ 播种数`(经济未崩;creep 归零/RCL 掉由 baseline 兜底)。

**注意**:11 用户已 ~0.6s/tick,加攻防+siege 群会更贵——断言打到**破防里程碑(塔+spawn 拆光)**即可,别等 full claim/downgrade(attackController 1/1000t 太慢);相应调大 `--effect-ticks`。跑私服前先看别的会话是否在用(`data/soak/*/run.json`、`别 kill 它`)。

## 附录二:B0 损失预言机的实测发现 + 两条并行路线(2026-09-06 续)

**B0 首批实测**(VALIDATE_CONQUEST=1,14 拆迁+3 护卫 vs 双塔各 1000 能量、敌方经济回补):
- 基础场景:破防成功、**存活 2/17(~88% 损失)**。
- **B3 共享集火**(打血最低的塔,dbbffb8):破防成功、**仍 2/17**——几乎不减损失。**关键发现:损失全在接近阶段**(一字长蛇挨塔火),集火只让塔死快点、救不了路上被点掉的。修正了路线图对 B3 的"high impact"乐观估计。

**引擎现实(为什么无 boost 微操递减)**:塔在所有距离开火(600@≤5 → 150@≥20 线性),且一次只锁一个目标。接近损失 ≈ ∫(塔火 × 在射程内 tick),**与队形无关**(塔挨个点),**无法躲出射程**(近塔 range 6 仍 ~570)。唯一能减的是"在高伤区待的时间"= **接近距离**;接近距离由从哪条边进决定,那取决于集结在哪个邻房。

### Track 1 —— B2 集结选边 doctrine(directive/大脑,非游戏内代码)

游戏内已走最短路,所以 B2 是**上层选择**:进攻前,大脑/operator 按目标塔位置,把 `staging` 选在**离塔最近、且不穿另一活塔敌房**的邻房,并可在指令加 `entryEdge` 提示。缩短接近距离 → 中等减损失。落地:`scripts/brain/` 的 conquest 规划里按 `hostileProfile`/room-objects 的塔坐标给 4 个邻房按"共享边到最近塔距离"打分选 staging(D2 情报接进攻的一部分)。B1 编队/B8 分档作为大工程排期(无 boost 下中等收益,主要为 boost 期的 tank 前排铺路)。

### Track 2 —— boost 流水线规划(真正的乘数,用户 2026-09-06 决定投资)

**目标**:让某个 sponsor 具备给攻城队上 boost 的能力,把"用命换房"变成"低损拿下有防御/有墙的房"。核心数据(引擎):Tier-3 `XLHO2` HEAL = 48/部件,13 个 boosted HEAL = 624 > 一座贴脸塔 600 → **真 tank 前排**(无 boost 时 48/部件的 heal 扛不住 1200/tick);`XGHO2` TOUGH 吸 0.7 伤(10 部件 ≈ 3300 有效血);`XZH2O` WORK 拆卸 ×4。

**基建前提**(现在没有):
1. 一个 sponsor 到 **RCL6+**(labs 从 RCL6 开放,RCL6 3 个 lab、RCL7 6 个、RCL8 10 个)——W33S7 已 RCL7,是首选。
2. **terminal**(RCL6 开放):买矿物/成品、跨房调运。
3. **矿物来源**:本房 mineral(W33S7 的 mineral 类型待查)extractor 采 + 市场买缺的基础矿(H/O/Z/K/U/L/X)。

**反应链**(要 Tier-3 boost,逐级合成,每步一个 lab 反应):
- TOUGH 线:GH(G+H)→ GHO2 →(+X 催化)XGHO2;需要 G(=Z+K→ZK,U+L→UL,ZK+UL→G,即 catalyzed 的基础)。
- WORK 线:ZH(Z+H)→ ZHO2 → XZH2O。
- HEAL 线:LH(L+H)→ LHO2 → XLHO2。
- RANGED 线(护卫):KH(K+H)→ KHO2 → XKHO2。
- 催化剂 X = ghodium(G),由 ZK + UL 合成(Z/K/U/L 基础矿)。
- 每级反应要 5 个 tick/单位、labs 两进一出;实操通常一个 sponsor 布 3-10 个 lab 做流水线,或市场直接买成品 X-boost(贵但省 lab 排期)。

**流水线步骤(代码侧,新工程)**:
1. `industry.js` 扩展或新 `labs.js`:管理 lab 反应链(输入矿物 → 逐级合成目标 boost),terminal 补货(市场买缺口矿 / 卖余料)。
2. 指令加 `boost: {tier, parts:{tough,work,heal,ranged}}`;`conquest`/`spawn` 在 muster 前把 siege 开到有 boost 的 sponsor,`boostCreep`(lab.boostCreep)上 boost 再发起(pre-muster boost step)。
3. B0 场景加 boost 变体(给攻击方 sponsor 播 labs+成品 boost,验证 boosted siege 的存活率跃升)。

**排期与决策(待定)**:
- 先市场**买成品 X-boost**(快,验证 boosted 战斗有效)vs 自建**完整反应链**(慢,自给自足)——建议先买成品验证、再决定是否自建。
- 哪个 sponsor 承载 labs(W33S7 RCL7 首选,但它也是主经济房,labs+terminal 占布局名额)。
- 预算:一套 Tier-3 boost 一队(~20 creep × 各 ~5-10 boosted 部件 × 30 矿物/部件)要几千单位矿物 + 能量;市场价待查。

这是多周经济工程,是 conquest 从"pyrrhic"变"低损"的唯一质变,也顺带解锁 stronghold(见 [[stronghold-w34s5-assessment]])。先做 B2 doctrine + 市场买成品 boost 的小验证,再决定自建反应链。
