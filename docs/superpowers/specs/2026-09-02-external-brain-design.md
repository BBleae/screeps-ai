# 外部大脑与全功能补齐设计

日期：2026-09-02
状态：已确认（姿态：防御优先只打 NPC；运行方式：本机脚本定时 + Claude 定时复核；首个占领目标 W34S7；批次顺序 0→1→2→3→4）

## 1. 背景

线上账号：shard1，GCL 12，只拥有 W33S7（RCL3），140 CPU。周边四个相邻房无主：北 W33S6 单源（L）、东 W32S7 单源（O）、南 W33S8 双源（K，紧邻 W33S9/W32S9 的 RCL8 玩家殖民房）、西 W34S7 双源（L，有残墙）。

现有 bot 是完整的单房经济体（RCL1-8 经济、蓝图、link、恢复、CPU 管理）加相邻双源外矿（RCL4+）。缺失：扩张/占领、防守 creep 与正确的 safe mode、进攻、跨 shard、市场、矿物采集、terminal 搬运（导致 lab/factory/powerSpawn 为死代码）、Power。侦察只探相邻房且 `Memory.map` 无消费方。

已验证的外部通道：
- `GET /api/game/room-objects?room=X&shard=shard1` 无需视野返回任意房间全部对象（含他人 creep 及 body、全部建筑）。
- `POST /api/game/map-stats` 返回房间归属、等级、状态。
- `GET /api/game/room-terrain` 返回地形。
- `POST /api/user/memory {path,value,shard}` 外部写 Memory，几秒内游戏内可读。

## 2. 架构

游戏内只保留 tick 级反应，其余上移到外部：

```
官方/私服 HTTP API ──► scripts/brain（Python）──► Memory.brain 指令 ──► src/brain.js（校验/合并）──► 各模块消费
        ▲                     │
        │                     └──► data/brain/brief.md（给 Claude 定时复核的态势摘要）
        └── 游戏内 Memory.brain.ack / Memory.stats（回执与观测）
```

- **外部情报**（`scripts/brain/intel.py`）：以自有房间为中心拉取 N 圈房间的 map-stats、room-objects、terrain，缓存到 `data/brain/intel/`，转换成 `Memory.map` 同构条目（sources/sourceData/lairs/controllerPos/owner/reservation/mineral/hostiles/armedHostiles/invaderCore/threat，外加 `source: 'external'`、`structures` 摘要、`walls`）。scout creep 逐步退役。
- **外部规划**（`scripts/brain/plan.py`）：房间评分（源数、路程、SK/中心房、邻居归属与等级、威胁）、外矿分配（允许单源与二跳）、占领目标与开荒计划、防御姿态、市场与 lab 反应链（后续批次）、重布局（wheel min-cut 在本地 Node 跑，后续批次）。
- **指令写入**（`scripts/brain/directive.py`）：组装 `Memory.brain` 并通过 `/api/user/memory` 写入；同时输出 `brief.md` 供 Claude 复核。
- **agent 复核**：定时 Claude 会话读 `brief.md` 与 `data/brain/state.json`，可改写目标房、暂停某外矿、调整姿态；改写以同一指令格式落地，确定性脚本不会覆盖 agent 的显式决定（`locks`）。
- **游戏内消费者**（`src/brain.js`）：每 tick 校验 `version`、`issuedAt`、`ttl`；合并 `intel` 进 `Memory.map`；提供 `brain.directive(roomName)` 访问器；写回 `Memory.brain.ack = {tick, issuedAt, applied}`；无指令或过期时各模块退回现有自治逻辑。

### 2.1 指令契约 `Memory.brain`

```
{
  version: 1,
  issuedAt: <unix ms>,            // 外部写入时间
  ttlMs: 1800000,                 // 30 分钟未刷新即过期（游戏内用 Date.now() 判断）
  intel: { <roomName>: <Memory.map 条目> },
  rooms: {
    <homeRoom>: {
      remotes: [<roomName>, ...],           // 批 0：作为候选白名单；批 1：直接分配
      claim: { room, priority } | null,     // 批 1
      posture: 'defend' | 'alert',          // 批 2
      market: [...], labs: {...}            // 批 3
    }
  },
  locks: { <key>: { by: 'agent', until: <unix ms> } },   // agent 的显式决定；账号级 'claim.queue'（value 为房名列表）是用户点名的占领清单，
                                                        // 2026-09-06 起由 plan.assign_claim_queue 落到母房（有主的等无主、最近空闲母房接、一房一目标）
  ack: { tick, issuedAt, applied: [...] }               // 游戏内回写
}
```

游戏内约束：校验失败只记 `Memory.errors` 并忽略整份指令，绝不因指令格式错误影响经济链。

## 3. 分批

每批的完成定义：smoke（TDD）通过、Python 单测通过、私服新增行为断言场景通过、部署到 `default`、线上探针验证、记录 `logs/optimizations.md`。

### 批 0 基础设施
1. `src/brain.js`：契约校验、intel 合并（外部条目覆盖更旧的 scout 条目）、访问器、ack。
2. `remote.admitCandidates`：候选来源改为 `Memory.map`（含外部情报）+ 指令白名单；不再要求 scout 探过所有相邻房。
3. `scripts/brain/`：`api.py`（官方与私服两种鉴权、限速、磁盘缓存）、`intel.py`、`plan.py`（房间评分与外矿候选）、`directive.py`、`run.py`（`--dry-run/--write/--server official|private`）、`brief.py`。
4. `test/brain_test.py`（fixture JSON 驱动）、smoke 新增 brain 断言。
5. 私服：`validation_mod.js` 若私服缺 `room-objects` 路由则补一个同形状路由；新增 `brain` 场景：私服起来后运行 Python 大脑对私服拉情报并写指令，断言 bot 在无 scout 的情况下把邻房纳入 remotes。
6. 清理线上 Memory 里的残留探针键。
7. 定时：`scripts/brain/run.py --write` 每 5 分钟（launchd 或 cron），Claude 复核用 `/schedule` 每小时读 brief。

### 批 1 扩张与外矿升级
- `claimer` 角色与开荒 `pioneer`（builder 变体）由母房孵化，目标来自指令 `claim`；GCL 余量检查；新房 spawn 工地放置复用 layout；新房 RCL1-2 期间母房持续送开荒工。
- 外矿放开单源与二跳（路程评分替代"必须相邻"），reserver 与 hauler 数量按路程算。
- 私服：新增 `expansion` 场景（母房 RCL4 + 指令 claim 邻房），断言邻房 controller 变为己方且出现 spawn 工地。

### 批 2 防御

- 2026-09-05 实施。分工：**游戏内**保留每 tick 必须做的——有视野时的评估（己方房、远程 creep/defender 看到的外矿，`defense.planSquad`）、defender 成组出发与入口集结、阵亡记录（`main.js` → `defense.noteLoss` → `defenseLog.losses/lastLoss`）、外矿记录里的敌情画像（`remote.refreshVisible` → `remotes[房].threat`）；**大脑**做不需要视野、不必每 tick 做的——`room-objects` 直接看到敌方 creep 的 body/boost/hits/ageTime，`intel[房].hostileProfile` 下发画像，`combat.plan_defense` 按母房容量（spawn/extension 数推算）给出 `rooms[home].defense = {房: {action: fight|avoid, squad, until, reason}}`，游戏内在 `until` 前优先采用。
- 契约新增字段：`intel[房].hostileProfile`、`rooms[home].defense`；版本号不变（旧游戏代码忽略未知字段）。
- 2026-09-06：safe mode 的决定外置。`scripts/brain/safemode.py` 看敌方 DPS/主人（NPC 或玩家）/强化、本房塔与剩余次数、别的母房能否在救援到达前赶到（孵化 + 每房路程），给出 `rooms[房].safeMode = {action: activate|hold, reason, dps, eta, atTick}`；`run.py` 每轮写，`guard.py`（launchd 每 90 秒）只在决定有变化时修补 segment 里的这一个字段并刷新 `issuedAt`。游戏内 `src/tower.js` 在 `config.safeMode.decisionTtl` tick 内采用，没有（新鲜）决定时只在核心建筑（spawn/塔/storage）掉到 `fallbackCoreShare` 以下才开，大脑说 hold 时只有掉到 `lastResortCoreShare` 才违抗；开盾记 `defenseLog.safeMode`（依据与敌人画像）；`defense.js` 对 safe mode 中的己方房不出 defender。
- 决策规则：打得过（`combat.can_beat`，双方同时交换伤害的悲观模型，`winMargin` 1.5）且值得（编组总成本 ≤ 源数 × 10/tick × 入侵者剩余寿命 × 0.5）才 fight，否则 avoid：游戏内把外矿停到 `until`（Invader 不能离开房间），远程 creep 不再每 150 tick 进去送一次；近期在该房阵亡过则 `winMargin` × 1.25。
- 游戏内没有指令、也没有画像（只有情报计数）时不出兵，等看到成分再决定——这是 2026-09-05 W33S6 事故的直接教训（4R1H 单送、41 次出兵）。

### 批 3 资源链
- `mineralHarvester`、hauler 的非能量资源与 terminal 投递层、lab 反应链（外部规划反应树）、boost 供给、市场（外部定价与订单选择，游戏内 `deal`）。
- 私服：扩展 industry 场景，断言 terminal 有矿物、lab 产出化合物。

### 批 4 军事与跨 shard（只对 NPC）
- squad（dismantle/attack/heal）清剿 invader core 与无主残留建筑；power bank；portal 与 InterShardMemory 的最小可用（发现 portal、跨 shard 保活）。

## 4. 测试策略
- smoke：每个新模块的纯逻辑断言。
- Python 单测：情报转换、评分、指令组装用固定 JSON fixture。
- 私服：行为断言（不再只是"不崩"）。外部大脑对私服跑一遍是端到端验证。
- 线上：部署后用 `scripts/monitor.py` 与 `Memory._probe` 探针核对。

## 5. 风险与边界
- 官方 API 有限速：情报拉取按圈分批、磁盘缓存、每 5 分钟一轮；失败退避。
- 指令过期或缺失时游戏内必须仍能自治运行（现有行为不变）。
- 不主动攻击玩家；不自动 destroy/dismantle 己方建筑。
- 每批独立部署、独立验证，回归立即回滚到上一个版本。

## 6. 进度（2026-09-03 14:40 JST）
- 批 0、1a、1b、2 已上线并经私服 10 场景验证；布局外置（离线 RCL8 蓝图随占领指令下发）已提前完成并用于 W34S7。
- 线上：W33S7 RCL4（游戏内蓝图生成成功，首个外矿 W32S7），W34S7 已占领，spawn1 在蓝图位 (27,18) 建设中。
- 03:00–05:00 的线上取证修复：大脑把预定房（map-stats `own.level 0`）当成己方房、情报不含母房自身（无 spawn 的新母房被规划占领）；pioneer 采一 tick 就去建（工地 1 点/tick → 5 点/tick）；hauler 缺编时外矿 creep 插队；defender 清场后在两房之间来回踱步。均经私服 10 场景验证后上线。
- 14:00–14:40 追加：remoteHauler 投递层级对齐 hauler（基地满时外矿收入曾归零）；蓝图结构位被旧道路占住只记录不拆（`layoutBlocked` + 策略开关 `clearBlockingRoads`，默认关）；harvester 换代在源 WORK 已被新身板覆盖时停止；RCL2 upgrader 上限放开给 EMA。大脑：只排除实际生效的占领目标、RCL4 允许 2 个外矿（W32S7 + W33S6）、母房 RCL≥4 才能发起占领、全账号同时只推进一个占领；`W33S7.claim`/`W34S7.claim` 两把锁把下一次自动占领（候选 W33S8）压到用户决定为止。
- 待用户决定：是否开启 `Memory.policy.clearBlockingRoads`（W33S7 的 storage/terminal/link 位压在旧路上）；第三个房要不要占、占哪个（大脑候选 W33S8 紧邻 tidusfox9 两个 RCL8 房）。
- 未做：批 3（矿物/terminal/lab/市场）、批 4（NPC 军事/跨 shard/Power）、Claude 定时复核的自动化（接口已备好：`data/brain/brief.md` + `locks.json` + `scripts/brain/review_prompt.md`）。

