# 外部大脑（scripts/brain）

设计见 `docs/superpowers/specs/2026-09-02-external-brain-design.md`。游戏内只保留 tick 级反应，情报、评分、规划在这里完成，结果通过 Memory segment 90 投递给 `src/brain.js`。

## 一轮做什么

1. `intel.collect`：以母房为中心拉取 `--radius` 圈房间的 `map-stats`（归属）与 `room-objects`（全部对象，含他人 creep 与 body），转成 `Memory.map` 同构条目并缓存到 `data/brain/cache/`。
2. `plan.plan_home`：外矿候选评分与分配（按 RCL 上限）、占领候选与目标（按 GCL 余量，`--prefer-claim` 可指定）；`layout.choose_spawn_pos` 用地形距离变换为占领目标选 spawn 位并随 claim 指令下发；`combat.plan_defense` 对有武装敌人的外矿给出打/避决定。
3. `directive.build/write`：组装契约（`version/issuedAt/ttlMs/intel/rooms/locks`）写入 segment 90；`data/brain/locks.json` 里的 agent 决定会覆盖确定性规划。
4. 输出 `data/brain/state.json`（完整状态）与 `data/brain/brief.md`（给 Claude 复核的摘要）。
5. `dashboard.update`（只记 launchd 那种完整轮次：官方服务器、母房自动识别、非 `--dry-run`）：用本轮已读的 Memory 与 room-objects 缓存追加一条快照，重写监控面板（见下）。

## 监控面板

`open data/brain/dashboard/index.html`：账号 GCL / CP、每个房的升级进度与 ETA、能量采集 vs 理论上限、creep 维持成本、storage、外矿明细与告警。页面数据内嵌，在下一轮大脑写完后自动重载；超过 15 分钟没更新标红（外部大脑停了）。

- 零额外 API：Memory.rooms / Memory.creeps / GCL 点数是 run.py 本来就读的；room-objects 只读 intel.collect 本轮写的缓存（`ScreepsApi.cached_room_objects`，不发请求）。
- 历史在 `data/brain/dashboard/history.jsonl`（累计计数器，保留 7 天），`latest.json` 是最新一条完整快照；速率按 1h / 6h / 24h 窗口从计数器差值算。
- 口径：理论上限 = 源 max(容量, 3000)/300；实际采集 = 源 `invaderHarvested` 增量（值变小 = Invader 清零）；维持成本 = 视野圈内我方 creep 身体成本 / 寿命（外矿 creep 记外矿，援建记出钱的母房）；CP 用控制器 progress，账号用 GCL 点数。详见 `dashboard.py` 文件头。
- 改了模板或口径后 `python3 scripts/brain/dashboard.py` 按已有历史重新渲染；`run.py --no-dashboard` 关闭；私服轮次（`--server private`）、手动指定 `--homes` 子集、`--dry-run` 都不记——所以用 `BRAIN_HOMES=... install_schedule.sh` 装的定时任务（plist 带 `--homes`）不会更新面板，保持母房自动识别即可。

## 用法

```bash
# 只看结果，不写入
python3 scripts/brain/run.py --homes W33S7 --radius 2 --prefer-claim W34S7 --dry-run
# 写入官方服务器（token 来自 .env 的 SCREEPS_AUTH_TOKEN）
python3 scripts/brain/run.py --homes W33S7 --radius 2 --prefer-claim W34S7 --write
# 对私服（验证脚本会自动这样调用）
python3 scripts/brain/run.py --server private --base-url http://127.0.0.1:21025 --username ValidationBrain --token <t> --homes E11S11 --radius 1 --write
```

## 定时

`bash scripts/brain/install_schedule.sh` 安装 launchd 代理，每 5 分钟跑一轮 `--write`，日志在 `data/brain/logs/`。卸载：`bash scripts/brain/install_schedule.sh uninstall`。

Claude 定时复核：读取 `data/brain/brief.md` 与 `state.json`，如需改写决定，写 `data/brain/locks.json`，例如：

```json
{ "W33S7.claim": { "value": { "room": "W34S7", "priority": 1 }, "until": 1790000000000, "by": "agent" } }
```

用户点名一批要占的房时用账号级的 `claim.queue`（顺序即优先级），`plan.assign_claim_queue` 每轮把它落到母房上：

```json
{ "claim.queue": { "value": ["W33S3", "W32S4", "W31S4", "W31S5"], "until": 1790000000000, "by": "agent" } }
```

- 有主/被预定/有威胁的房 `wait:<原因>`，等它无主再占；已是我方且有 spawn 的 `owned`；我方但没 spawn 的 `bootstrapping`。
- 无主的房分给 claimer 走得到（按各房真实地形跨房 A*，平地 1 tick/格、沼泽 5 tick/格，母房 spawn → 目标 controller 旁 ≤ `claimTravelTicks` 600，只穿无主/己方房；没有地形数据时按每房 `claimTicksPerRoom` 50 估）且最近、孵得出 claimer（spawn 容量 ≥ `claimSponsorMinCapacity` 650，按情报里的 spawn/extension 数算；没有容量数据时退回 RCL ≥ `claimMinLevel`）的空闲母房；母房一次只开一房（正在开荒别的房、带 `<home>.claim` 锁、本轮已接一房的都跳过），没人接是 `noSponsor`，GCL 无余量是 `gcl`。清单房可以在情报圈之外，`intel.collect(extra_rooms=...)` 连同邻房一起拉。
- 清单还有未完成的房时，脚本自己排的占领目标一律清空（`analysis.claim.blocked = 'claimQueue'`）；全部 `owned` 后恢复自动占领。状态在 `state.json`/`run.log` 的 `claimQueue` 与 `brief.md` 的"占领清单"段。

## 游戏内契约

`src/brain.js` 每 tick 激活 segment 90，内容变化时解析进 `Memory.brain`，校验 `version === 1` 与 `issuedAt + ttlMs`，把 `intel` 合并进 `Memory.map`（以 `at` 更新者为准，标记 `source: 'external'`），并写回 `Memory.brain.ack`。消费方通过 `brain.directive(room)` / `brain.get(room, key, fallback)` 读取；没有指令或过期时退回自治逻辑。

## 测试

- `python3 -m unittest test.brain_test`
- `node test/smoke.js`（含 brain 与 remote 白名单断言）
- `node scripts/private_server/run_validation.js`（`brain` 场景对私服跑一轮真实的外部大脑）

## 指令字段（rooms[home]）

- `remotes`：外矿白名单（游戏内 `remote.admitCandidates` 采用）。
- `claim`：`{room, priority, spawnPos}`，游戏内 `src/expansion.js` 据此孵化 claimer 与 pioneer；GCL 无余量、目标已有 spawn 或被他人占领时自动不产生需求。
- `scouts`：默认 0（情报由外部提供），需要时可设 1 保留 scout。
- `defense`：`{房: {action: 'fight'|'avoid', until, reason, squad?: {count, body, style, cost, total}}}`（`combat.plan_defense`）。对当前外矿 + 白名单里有武装敌人的房，按母房容量（spawn/extension 数推算）用与 `src/defense.js` 相同的战力模型找最便宜的能赢编组；不值（编组总成本 > 源数 × 10/tick × **到场后**入侵者剩余寿命 × `remoteValueShare`，到场 = 按母房 `spawnIncome.ema` 攒够成本 + 逐只孵化 + 每房 50 tick 走路）或打不过就 `avoid`。游戏内 `defense.getDemands` 在 `until` 前优先采用；近期在该房阵亡过（`Memory.rooms[home].defenseLog.lastLoss`）时门槛抬高 `lossMarginFactor`。

## 情报字段补充

- `hostileProfile`：`{at, count, hits, dps, heal, kiters, boosted, until}`——武装敌人的画像（强化按 BOOSTS 倍率折算，`until` 取 `ageTime` 最晚者）。游戏内没有视野时 `defense.threatIn` 用它评估。

## 战力模型

`combat.py` 与 `src/defense.js` 是同一套公式（改一处必须改另一处，`test/brain_test.py` 的 CombatTest 与 `test/smoke.js` 的出兵评估场景互相核对数字）：双方同时交换伤害、对方全部在射程内，我方击杀时间 × `winMargin`(1.5) ≤ 对方击杀我方的时间；风筝型（只有远程、无近战）在场只考虑远程编组；编组 1..`maxDefenders`(3) 只同样的身体，取总成本最低者。


## 保护区与不可达目标

情报从 map-stats 的 `novice/respawnArea/openTime/status` 归一化为 `roomStatus`（与游戏 `Game.map.getRoomStatus` 的状态名一致），随 segment 下发。候选房及中间走廊必须与母房状态兼容；closed 一律不通。建筑墙位置合入本轮寻路地形，不污染静态地形缓存。自动占领、占领清单和外矿都检查实际跨房路径，避免房间出口存在但房内被墙切开的误判。

游戏侧 `Memory.rooms[home].claimReachability[target]` 独立保存失败历史：实际派出 claimer 后 650 tick 仍无人抵达，暂停该目标全部扩张需求 1500 tick，连续失败翻倍至 24000 tick。冷却后只试派 claimer，抵达后才恢复 pioneer；重复指令不会清掉冷却，目标已归我方也会解除退避。
