# W34S5 四级 Stronghold：打赢并搬回战利品的最低要求（私服模拟，2026-09-06）

结论先行：**现在（全账号最高 RCL5、单 creep 1800 能量、无 lab/terminal）打不了；不加 boost 任何 RCL 都打不了；最低可行配置是 RCL7 经济 + 约 4,800 单位 T3 boost 的 7~8 人小队 + 1 个诱饵 creep，私服里零损耗 900 tick 内击杀核心。** 战利品坍塌时会被删除，没有"等它塌了再捡"的路。

## 1. 目标（线上 tick 73,511,056）

- W34S5 是 Source Keeper 房，(41,28) 一座 4 级 Stronghold（`bunker4`）：InvaderCore 100k 血，25 道 rampart 各 100 万血，4 座塔各 1000 能量，另有 4 个 keeper。
- 守卫全 boost：2 个 25×RANGED（KHO2，单发 750）、1 个 25×ATTACK（UH2O，近战 2250）、1 个修理工（15×WORK XLH2O，每 tick 修 3000）。
- 容器战利品 33,745 单位：keanium_bar 12,356、battery 7,804、zynthium_bar 5,943、purifier 3,519、oxidant 1,644、ghodium_melt 1,158、lemergium_bar 1,067、reductant 254。核心死后其废墟按 `silicon` 奖励表再出一批 wire/switch/transistor 等，私服两次分别为 16,232 与 18,072 单位。
- 坍塌 tick 73,550,061，距今约 39,000 tick（shard1 约 3.5 s/tick ≈ 38 小时）。

## 2. 引擎规则（读 `@screeps/engine` 源码核实，官服同源）

1. 4 级核心每 tick 100% 给能量 ≤20 的塔补满，塔打不空。
2. 守卫只在 rampart 上走，rampart 上的 creep 对攻击/RMA 免疫，永远打不到；阵亡 100 tick 内重孵（带 boost）。
3. 塔和守卫每 tick 集火"预计受伤最高"的敌方 creep（塔按距离衰减 + 3 格内远程 + 1 格内近战），并列取房间对象创建顺序靠前者。**除集火目标外别人不挨打**。
4. 修理工每 tick 只修列表里第一道受损 rampart，3000/tick；核心自己的 rampart 排第一。
5. 近战守卫站在"第一个敌方 creep 相邻 rampart 里顺序最靠前的一道"；远程守卫站在"第一个敌方 creep 3 格内顺序最靠前的 rampart"，该格不可达（塔/核心）就在旁边游走并 RMA 溅射。
6. 被打掉的建筑留废墟，废墟保留到坍塌时刻；**坍塌时所有 Stronghold 对象直接删除，无废墟**。
7. rampart 下的容器不能 withdraw。核心死后塔与守卫失去指令，全部停摆（私服核实：塔能量冻结不再开火）。
8. 同 tick 互斥：`heal` 挡 `dismantle`/`attack`，`rangedHeal` 挡 `rangedAttack`；`rangedAttack`+`heal` 可并存。
9. 核心 rampart 只能从 3 格内远程打；核心四周是塔和内圈 rampart，拆墙路线最后一段只有 1 个站位，不如远程。

## 3. 地形与站位

南面 y=31 行 (39..43,31) 是唯一贴近的 3 格射击行（北面 y=25、东面 x=44 也可但在 keeper 旁）。任何射击位都相邻外圈 rampart，近战 2250 躲不掉；坦克站 (42,31) 承受 塔 2400 + 近战 2250（+ 远程 1500）。

诱饵：一个先于小队孵出的 1×MOVE creep，从东面（W35S5 无 keeper 的扇区中心房）进入停在 (42,23)。因为它是房间对象顺序里第一个敌人，两个远程守卫会被钉在 (39,26)/(43,26) 角上一枪不发；坦克实际只吃 4650。没有诱饵时核心 rampart 一破，远程守卫游走到我方队列旁 RMA 溅射，8 人队在核心剩 28k 时全灭。

## 4. 模拟结果（私服逐对象镜像线上，专用攻城 bot，1500 tick = creep 寿命）

| 配置 | 人数 | 能量 | T3 boost 单位 | 结果 |
|---|---|---|---|---|
| 坦克 + 3 治疗 + 4 远程（RCL7 身体）| 8 | 38,540 | 5,370 | 核心 909 tick 击杀，零损耗 |
| 坦克 + 2 治疗 + 4 远程 | 7 | 33,140 | 4,830 | 核心 892 tick 击杀，零损耗（**最低**）|
| 坦克 + 1 治疗 + 4 远程 | 6 | 27,740 | 4,290 | 坦克接近阶段死亡 |
| 坦克 + 3 治疗 + 3 远程 | 7 | 33,540 | 4,620 | DPS 3,240 < 修 3,000 + 余量，寿命耗尽 |
| 坦克 + 3 治疗 + 5 远程 | 9 | 43,540 | 6,120 | 550 tick 击杀 |
| RCL8 紧凑队（自带治疗的远程手）| 6 | 35,390 | 8,250 | 754 tick 击杀 |
| 同上换 T2 boost | 8 | 38,540 | 5,370（T2）| 坦克 55 tick 死亡 |
| RCL8 不 boost | 8 | 44,000 | 0 | 进房 50 tick 内全灭 |

最低配置身体：坦克 19×TOUGH(XGHO2)+6×RANGED(XKHO2)+25×MOVE（2,340）；治疗 18×MOVE+18×HEAL(XLHO2)（5,400，MOVE 在前保住 HEAL）；远程 25×MOVE+25×RANGED(XKHO2)（5,000）；诱饵 1×MOVE。数学：坦克有效伤害 4650×0.3=1,395/tick，2 个贴身治疗 1,728；DPS 4×1000+240=4,240，扣修 3,000 净 1,240，核心 rampart 100 万 ≈ 800 tick，再 100k 核心 24 tick。

## 5. 搬运

- 私服量得 W34S7 storage ↔ W34S5 南容器往返约 245 tick；18×CARRY 的 hauler 每趟 900，6 只每趟 5,400。总量约 5 万单位 ≈ 9 只 hauler 生命周期（约 16k 能量），完全在坍塌前完成。
- 核心死后无抵抗：幸存远程手（还剩 ~600 tick）先打开 (41,30) 和 (41,29)（每道约 240 tick），之后不 boost 的 12×WORK 拆墙工每只 600/tick 慢慢开东、北、西容器与核心废墟通道（共 6 道，约 2~3 个生命周期）。东容器从 (44,27) 拆/取可避开 keeper。
- 拿回来的是商品条和电子件，**没有 terminal 卖不掉**，只能压在 storage。

## 6. 对现状的判断

- 必须 RCL6 才有 terminal（买 boost、卖战利品）和 3 个 lab（正好 XGHO2/XKHO2/XLHO2 三种）；身体 5,000~5,400 需要 RCL7；RCL5 尺寸的替代队（11 个 9×RANGED 远程 + 5 个 6×HEAL 治疗 + 坦克）理论上可行且 boost 更少（约 4,500 单位），但仍需 RCL6 的 lab/terminal 和几百万信用买 T3。
- W33S7 现在 RCL5 进度 360k/1.2M，38 小时内到不了 RCL6，更买不起约 4,800 单位 T3。**这次放弃**；把方案留给下一座 Stronghold（每个扇区 75k tick 出一次）。

## 7. 模拟工具

一次性 harness 在会话 scratchpad `sh/`（`sim.js` 建世界/镜像/采样，`bot/main.js` 攻城 bot，`configs/*.json`）；如需保留可移入 `scripts/private_server/stronghold/`。
