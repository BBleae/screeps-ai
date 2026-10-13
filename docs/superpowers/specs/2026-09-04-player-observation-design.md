# 顶级玩家持续观察（scripts/observe）设计

日期：2026-09-04。目标玩家：Kalgen（世界 GCL 榜第 1，2025-07 起几乎每月 rank 0；shardX 86 房全 RCL8，shard3 3 房 RCL7/8/8）。

## 目的

长期、低成本地记录并分析一个顶级玩家的公开数据，产出可对照到本仓库代码的"差距 → 改动"清单，而不是一次性的截图式观察。所有情报来自官方只读 HTTP API 和公开的 room-history，不需要对方授权。

## 数据来源（全部已实测可用）

- `GET /api/user/find?username=` → user id、gcl、power。
- `GET /api/user/rooms?id=` → 各 shard 拥有房间。
- `POST /api/game/map-stats {rooms, statName: owner0, shard}` → 每房 RCL / safeMode / 签名。
- `GET /api/game/room-objects?room=&shard=` → 全部对象，含 creep 身体与名字（名字编码了角色、档位、目标房、槽位、孵化 tick）。
- `GET /api/user/stats?id=&interval=8|180|1440` → 全 shard 汇总、滚动窗口。**bin 为 8 分钟**（8≈64 分钟，180≈24 小时，1440≈8 天）；**`creepsProduced` 实际是身体部件数**（能量/部件 ≈ 80，用我方账号校准过）。`shard` 参数无效。
- `GET /api/game/shards/info` → 各 shard 平均 tick 秒数，用于把窗口换算成 tick。
- `GET https://screeps.com/room-history/<shard>/<room>/<tick>.json`（tick 取整百，gzip，落后几百 tick）→ 100 tick 的对象快照 + 逐 tick 差分。用于运动/装卸/孵化节奏分析。
- `GET /api/leaderboard/find?username=&mode=world|power` → 历史名次。

## 结构

```
scripts/observe/
  capture.py   拉取一轮快照到 data/observe/<player>/snapshots/<UTC 时间>/（profile、rooms、mapstats、stats、history、remotes）
  analyze.py   纯函数：creep 名解析、身体签名、link 分类、房间摘要、原型聚合、history 行为指标、外矿拓扑、速率换算、快照差分
  report.py    由 timeline.jsonl + 最新 summary 生成 docs/observe/<player>.md
  run.py       CLI：capture / analyze / report / all；--self 同时记录我方账号同口径指标
  install_schedule.sh  launchd 每 6 小时 all 一轮（label local.screeps-observe）
test/observe_test.py   用裁剪过的真实固定件（test/fixtures/observe_*.json）测 analyze/report
docs/observe/<player>.md            自动生成的观察报告（可提交）
docs/observe/kalgen-learnings.md    人工维护的"观察 → 我们的现状 → 差距 → 改动"清单，按日期追加
data/observe/                       原始快照与 timeline（gitignore）
```

## 每轮预算

全部拥有房（≈89）的 room-objects + 4 个账号级请求 + `--history N`（默认 3）个 history + `--remotes N`（默认 6）个外矿房，约 100 次请求、限速 0.4 s，一轮 ≈ 1 分钟；每 6 小时一轮远低于 API 配额。房间与外矿按排序轮转（游标存 `state.json`），保证长时间内覆盖全部房间。

## 摘要口径（summary.json）

- profile：gcl、power、名次、三种窗口的速率（每房每 tick 采能 / 控制器 / creep 能量 / 建造、部件产量、损失率）。
- room：RCL、结构计数、link 分类（source / hub / edge / controller）、storage/terminal 能量、塔能量、rampart 数与均值、lab 内容、spawn 忙碌数、creep 数与角色计数、身体原型、核心紧凑度（spawn/storage/terminal/lab/tower 外接矩形）、storage→controller/源 距离。
- archetypes：跨房按角色前缀聚合的身体签名分布（如 `shauler: C32M16`）。
- remotes：从 creep 名解析出的母房→外矿映射；抓到的外矿房给出容器、道路数、预定剩余。
- history：每个原型的 100 tick 移动步数、装卸对象（link/storage/spawn/ext/container）、每 tick 传输量；spawn 事件与 needTime；源每 tick 消耗。
- diff：与上一轮相比的房间数、名次、新出现的身体签名、结构类型变化。

## 不做什么

- 不进游戏内代码；不改 `src/`。改动建议只写进 learnings，按仓库既有流程（测试 → 私服 → 部署）单独实施。
- 不抓非公开数据（Memory、console）。
