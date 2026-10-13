# 重生区内可打击目标评估与出兵计划（2026-09-12）

> 用户要求：区内哪些玩家我方实力足够打掉，立即演习并制定出兵计划。优先目标：**W38S5**。
> 全部坐标/血量/储量为 2026-09-12 tick 73,635,484 实拉；可达性按官方地形边缘 + 邻接图计算；破防数字由引擎级确定性模型 + 对抗验证（比对 `@screeps/engine` 源码）得出。

## 战场态势

我方 **BBleae**：GCL 12、10 个 RCL5-6 房（W33S7 RCL6 母房、W33S8 RCL6，其余 RCL5）、**无 labs/terminal（全程无 boost）**、2 个空 claim 位。
重生保护区到期 **2026-10-08 02:45 UTC**（约 26 天）；区内玩家可互打，区外打不进来。**Fire9265 已被清除**，其 W31S4/W32S4 现为我方房。

区内其余玩家（W36S4 的 Invader 是 NPC）：

| 玩家 | 房 | 说明 |
|---|---|---|
| Alepoldar | W34S9(6) W36S9(6) W35S9(5) W36S8(5) W37S9(5) | 正南，最近；**全部无 rampart/wall** |
| G01 | W38S4(6) W38S5(5) W38S6(5) | SK 环后；比 09-07 强了很多 |
| Celr | W39S7(6) W39S8(5) W38S9(4) | Overmind 系；W39S7 是堡垒 |
| sriptulous | W39S1(4) | 偏北，重墙，图上不可达 |

## 硬约束

1. **safe mode 是真正的胜负手，且是敌方的默认反应。** 每个目标 `safeModeAvailable` 2-5、冷却多已过。激活**免费瞬发**（1000 ghodium 早已在 generate 时付过），一旦开盾 20,000 tick 内我方 dismantle 全部 no-op。我方无 boost 的 1:1 身体慢爬，进场前有 ~13 tick telegraph——任何会盯 hostile 的 bot 都来得及按钮。历史上打 Fire9265 时对方没开盾，但那是**赌对方 bot 无 safe-mode 反射**。
2. **SK 环封锁。** 除 Alepoldar 的 W34S9 外，所有目标都要穿 W35S6 + W36S6 两个 Source Keeper 房（每房 4 个 lair），无 boost 过境要预算 1-2 只损耗，须先派探路。
3. **进场几何。** 目标的塔/spawn 多在角落，唯一中立进场边往往离塔很远——长纵深接近在焦点火力下会全灭（见 W38S5 东/西路）。

## 可打击目标排序（无 boost，我方攻城栈）

### 能打（硬件层面）

- **G01 · W38S5（RCL5）——首击，优先**：1 塔(9,36)、storage 0、无 rampart。见下节详解。
- **G01 · W38S4（RCL6）**：1 塔(16,38, 780e)、storage 0、无 rampart。W38S5 拿下后的续攻；南缘进场约 11 格。~1-2 损失破塔。
- **Alepoldar · W36S8(RCL5) / W37S9(RCL5)**：单塔、储近空、无 rampart。可破（损 2-4），但 4-6 跳穿 2 SK。
- **Alepoldar · W36S9(RCL6)**：双塔、储 5907、无 rampart。可破但双塔纵深较硬。
- **Celr · W38S9(RCL4)**：单塔、储 38k，最远（7 跳）。

### 打不动（需 boost / 跳过）

- **Celr · W39S7**：29 rampart(10k+) + 双塔 + 5.3 万储 + 9 工人。堡垒，无 boost 无解。
- **Celr · W39S8**：双塔 + 5 万储 + **活跃近战守卫(7T5A12M)**。
- **G01 · W38S6**：**2 个 10,000,000 血 rampart** 护核（60M+ 拆迁量 = 8 万 tick）。本体啃不动，只能过境。
- **Alepoldar · W34S9**：最近（距 W33S8 仅 2 跳、不经 SK），但双塔 + 从北缘 23 格纵深 → 焦点火力**全灭**，排除。
- **Alepoldar · W35S9**：单塔但 12.8 万储，塔不断粮，较硬。
- **sriptulous · W39S1**：4.35M 墙、偏远、邻接图不可达。

## 优先目标 W38S5 详解

**防御**：1 塔 (9,36) 满能量 1000、spawn (7,40)、30 extension、storage **0**、2 源 2 静态矿工、无 rampart/wall、`safeModeAvailable 4`（冷却已过，可开盾）。塔与 spawn 在**西南角**。

**破防能力（引擎级模型 + 对抗验证，比对 @screeps/engine 源码）**：
- 塔伤按 Chebyshev 距离：≤5 格 600，20 格 150，线性；**13 格 = 360**（不是早期估的 230）。
- storage 0 **不影响**：塔自带 1000 能量 = 100 发，17 tick 的仗只用 ~17 发，**全程满 600 DPS**。断粮不是我们的胜手。
- 1:1 身体平地 1 格/tick；南侧走廊以平地为主（21% 沼泽可绕、无墙挡），慢爬崩溃风险已排除。
- 焦点火力下塔每 tick 只能打死一只、全程约 9000 总伤 = 最多 2-3 杀；击杀前排反而**掩护**了后排，后排满血贴塔 out-DPS 它（一只满血 RCL6 拆迁工单独 4 tick 拆掉 3000 血塔且能活）。

**兵力与损失（entry=南缘 13 格）**：

| 兵力 | 塔倒 | 损失 | 破防后存活 |
|---|---|---|---|
| 6× RCL5 [W12M12] | ~17t | 3 | 3 |
| 8× 混合(3 RCL5 + …) | ~16-17t | 2-3 | 5-6 |

spawn 在塔倒后 ~4-9 tick 补掉（5000 血 / 存活拆迁工）。**推荐 8 只**给 W38S6 过境余量。

**进场路线（关键）**：只有**南路可行**。东路(40格,经中立 W37S5)、西路(16格穿沼泽)在真引擎焦点火力下**全灭**。南路 13 格进场，但唯一入口必须**穿过 G01 的 W38S6**（塔在(22,29)中心、**当前只有 2 点能量=干枯**、但有 11 万储量可回充）。过境沿 W38S6 北缘走、距其塔 ≥24 格（150 伤区）：塔干枯则近乎免费，回充则每 tick 150、约十几 tick 过境——**W38S6 塔能量是开火 go/no-go**。
- 集结点：**W37S6**（中立，W38S6 东邻，经 SK 到达）。
- avoid 需允许 W38S6 过境（否则自动避让会把队伍推去东路 → 全灭），须私服/探路核实寻路真的走南路。

**兵力来源**（就近）：W35S7(RCL5, 5 跳) + W34S7(RCL5, 6 跳) + W33S7(RCL6 母房)。dPer=ceil(8/3)=3 → W35S7 3、W34S7 3、W33S7 2。身体：RCL5 [W12M12]=1800e，RCL6 [W15M15]=2250e。总 ~13,500e。

## 出兵前置条件（开火前必须满足）

1. **攒库（当前最大阻断项）**：sponsor storage 现均约 2000（全账号 ~8.7k），远低于 `conquest.storageFloor 15000`。8 只波次每房需 ~4-5k，须先把 W35S7/W34S7/W33S7 各攒到 ≥6k（或指令 `storageFloor:0` 覆盖 + 接受从收入慢孵，但有抽干 reserver 的风险——W32S4 前车之鉴）。**建议攒库，勿覆盖。**
2. **W38S6 塔能量复查**：开火前 `room-objects W38S6`，塔能量应仍 ≈0。若已回充 → 过境代价升高，改期或加兵。
3. **safeModeAvailable 复查**：W38S5 开火前确认仍可开盾 → 明确这是一次 safe-mode 试探（见中止条件）。
4. **SK 走廊探路**：先派 1 只 [MOVE×5] 探子走 W35S7→W35S6→W36S6→W37S6 同一码路径，活着到 W37S6 才放大波；死在 SK → 先做 lair 规避。
5. **CPU**：均值 ≤120、bucket ≥5000；开火期间关 generatePixel（`Memory.pixelRetry = Game.time + 100000`）。
6. **清残留指令**：当前 `Memory.conquest` 有 W31S4/W32S4 两条 `completed:true` 旧指令，开火前清空重写。

## 指令（攒库 + 复查通过后粘贴）

```js
Memory.conquest = [{ target: 'W38S5', sponsors: ['W35S7','W34S7','W33S7'], staging: 'W37S6',
  dismantlers: 8, guards: 0, downgraders: 0, downgraderBudget: 1300,
  avoid: ['W38S4','W34S4','W34S5','W34S6','W35S4','W36S4','W36S5'], noClaim: true, phase: 'breach' }];
```
- `guards: 0`（W38S5 内无战斗单位）。`downgraders: 0` + 破防即删指令（`nDg=max(1,0)=1` 会孵一只到不了的 downgrader）。
- `noClaim: true`：deny，不占（2 个 GCL 位留给免费中立 2 源房更值）。
- avoid **故意省掉 W35S6/W36S6/W38S6**：接受 2 SK 短走廊 + W38S6 南路过境。开火前须私服/探路确认寻路走南路而非东路。

## 经济护栏与中止条件

- `Memory.conquest` 数组长度恒为 1（getDemands 把每条指令摊给每个 sponsor，两条 = 双倍占槽）。sponsors 永远显式数组，不用 `'all'`。
- 熔断（触发即 `Memory.conquest = []`）：任一 sponsor 的 reserver 掉到 0（W32S4 特征）；账号总 storage < 5k；任一 sponsor storage < 2k；SK 过境损失 > 2；CPU 均值 > 135 持续 30 采样。
- **safe mode 分支**：若 W38S5 开盾 → siegeDismantler 自动撤回集结点，须**同 tick 手动 `Memory.conquest = []`** 让幸存者回收，别在集结点等到寿终。开盾即说明 G01 有反射 → **W38S4 暂缓**（它还有 5 层盾），把这轮能量转投 W33S7 RCL6（labs 是唯一质变）。
- W38S5 破防成功、G01 未开盾 → 记录，storage 恢复后再考虑 W38S4（同样是 safe-mode 赌注，独立的 5 层）。

## 战略判断

W38S5 denial 花 ~13,500e + 2-3 只 creep，**不得地、不得能量、不得 GCL**——本质是攻城栈的实弹演练 + 迟滞邻居 + safe-mode 反射探测。同样的能量投进 W33S7 的 RCL6（→ terminal + labs → boost）是唯一能解锁 Celr 堡垒和一切设防目标的路。**建议：把 W38S5 当作低成本 safe-mode 探针来打（对方开盾我们只亏一趟路），而非领土目标；2 个 GCL 位留给免费中立 2 源房。**
