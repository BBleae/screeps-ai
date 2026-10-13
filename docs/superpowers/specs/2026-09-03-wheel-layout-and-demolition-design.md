# 轮子布局唯一化与拆迁调度（2026-09-03）

## 背景
- `vendor/wheels/layout-2.1.0/planner.js`（Scorpior 自动建筑布局 2.1.0）自 09-01 起就 vendored 并随包上传，但只挂在 `RP/VP/SP` flag 上手动触发；`wheel_layout.validateExisting` 只要房里有任何不在轮子方案上的现有建筑就整体拒绝采用，而轮子本身从零规划、无视现有建筑，所以对任何已有建筑的房永远走不通。
- 线上两个房用的都是自研的 `src/blueprint.js`（`d1-rcl8-v1`，"借思路不借代码"）和 `layout.plan` 的棋盘格过渡布局。用户要求：布局忠实使用轮子方案，不再自研；规划确定后，任何与规划冲突的工地和现有建筑都必须在合适的时机拆迁。

## 决定（用户已确认默认项）
1. 轮子是唯一规划来源。删除 d1 蓝图与棋盘格过渡布局的使用路径；`wheel_layout.normalize`（轮子输出 → 现有 `plan` 结构）保留，去掉"有冲突就拒绝"的门槛。
2. 在游戏内跑轮子（它依赖引擎的 PathFinder/minCut），每个己方房只跑一次：`Game.cpu.bucket ≥ 5000` 时生成并写入 `Memory.rooms.<房>.plan`（`version: wheel-layout-2.1.0, wheel: true`），失败记 `planError` 并 5000 tick 后重试。原始输出存 `Memory.roomPlanner[房]`（轮子自己的格式，便于 `visualizePlan`）。
3. 新占领的房：claimer 到场获得视野时立即规划，spawn1 取轮子给出的第一个 spawn 位；大脑指令里的 `spawnPos`/`plan` 改为可选（离线跑轮子要重写 PathFinder，不值）。
4. 拆迁调度 `src/demolition.js`：每房每 `config.demolition.interval` tick 评估一次，一次最多拆 1 个；房里有敌对 creep、处于恢复期、或 spawn 能量低于 `minEnergy` 时不拆。规则：
   - 与规划冲突的工地：立即移除（`site.remove()`）。
   - 挡在规划位上的旧道路、容器、墙：立即拆。
   - 方案外的 extension/塔/lab/link/storage/terminal 等占 RCL 配额的：只在"拆掉后规划位能立刻放出替代工地"时拆（即该类型在方案内仍有未建位置且配额已满），一次一个，替代工地建成前不拆下一个。
   - 方案外的 spawn：RCL7 之前只有 1 个 spawn 配额，拆了就是全房停摆——留到 RCL7 先建规划位的 spawn 再拆旧的。塔同理，RCL5 前保留唯一的塔。
   - 方案外的 rampart：停止维修任其衰减，不主动拆（不占位、不占配额）。
   - 每次拆迁写 `Memory.rooms.<房>.demolition`（最近 20 条：tick/类型/位置/原因），监控报出。
5. `layout.place` 照旧按 RCL 配额放工地，但只认轮子方案；`layoutBlocked` 记录保留，`clearBlockingRoads` 策略开关废弃（拆迁调度接管）。

## 验证
- 私服：轮子在引擎里实际执行一次，确认 CPU（单 tick 上限 500）与产出（60 ext、6 tower、10 lab、3 spawn、storage/terminal、work_pos）；用一份真实产出的 JSON 作为 smoke 固定件，测 normalize 与拆迁规则；10 场景验证（blueprint 场景改为断言轮子版本）后上线。
- 线上：W33S7 现有 20 个旧 extension + 旧 spawn 逐步迁到轮子方案；W34S7（RCL2）立即切换。监控新增拆迁日志与 `planError` 告警。

## 不做
- 离线（大脑侧）跑轮子；rampart 主动拆除；RCL7 前动 spawn/唯一的塔。

## 进度（2026-09-03 17:05 JST）
- 已实现并经 smoke（479 断言）/Python（50 用例）验证：`wheel_layout.generate`、`layout.js` 只认轮子、`demolition.js`、扩张改用轮子 spawn 位、大脑删除离线蓝图、监控与私服验证脚本更新。
- 实测 CPU：私服 E11S11 11.7，官方服 W33S7 34.5、W34S7 10.3（单 tick 上限 500）。
- 已上线：版本 1788423118089（17:25 JST，私服第 58 轮）与 1788423430042（矿容器 RCL6 前不放、方案外容器不修；第 59 轮）。两个房在 tick 73456532 同一 tick 采用轮子方案，零错误；首批拆迁：W33S7 拆掉压在规划位上的旧路 (26,26)，W34S7 拆掉挡住核心的旧墙 (29,36)。

## 追加决定（2026-09-03 晚，用户）
- 工地积极放：`maxSites` 20、道路在建 8、rampart 每轮 6；道路先于 extension 放，builder 建造权重道路最高。
- 外矿路径从母房核心跨房一次算出，母房段写进母房 `plan.roads['remote:房:源']`。
- 迁移批量化：同类替代工地允许 4 个同时在建，25 tick 评估一次；零进度的路/rampart 工地算可让出的名额；唯一的塔在 safe mode 可用时直接替换；方案内容器建成后旧容器拆除。spawn 仍留到 RCL7。
- 外矿：大脑上限 4 个；"强邻"只算通过出口连通的邻居（地形推导 `exits`）。
