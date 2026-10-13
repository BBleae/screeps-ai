# 最近提交回归检查（2026-09-08）

范围：`21b1e69..3c4c35f`，最近 10 次提交，19 个文件。核查完整变更片段并沿调用链检查相关实现；没有把这次定向审查说成全仓库逐行审计。

## 已确认问题

**P2：034d521 引入己方预定误判。** `src/roles/downgrader.js` 用 `!reservation.my` 判断敌方，但官方对象只提供 `username/ticksToEnd`。本地引擎 `game/creeps.js` 与 `processor/intents/creeps/attackController.js` 没有拒绝攻击己方预定，会实际扣除其预定时间。`conquest.runOne` 还把所有无主房（包括己方预定）送进 deny，持续孵化压制单位。

待处理补丁（用户要求进攻代码和计划保持原状，因此已撤回工作区实现，不部署）：以 creep.owner.username 识别己方预定并回收现役 downgrader；suppress 指令遇到本账号预定则 completed/done，不再续派 CLAIM/护卫。普通 claim 仍允许占领己方预定房，敌方预定仍保持 deny。

复现：修改实现前，新增用例出现 4 条失败（结束指令、停止孵化、普通/suppress 单位不攻击己方预定）；修复后通过。私服 remote 场景新增己方预定及旧压制单位，`conquest.friendlyReservation` 必须观察到 completedReason=friendlyReservation 和旧单位退出工作。断言自身覆盖不结束指令和不退役两种失败。

## 审查覆盖与边界

- 游戏变更：`src/config.js`、`src/conquest.js`、`src/expansion.js`、`src/layout.js`、`src/main.js`、`src/spawn.js`、`src/roles/{claimer,downgrader,pioneer,siegeGuard}.js`。检查阶段流转、孵化成本/槽位、退役与可达性、死房容器、Memory getter/_parsed 写回、攻击/治疗意图。
- 验证变更：`scripts/private_server/{effects,fixtures,overmind_mimic,run_validation}.js`、`test/{conquest_test,overmind_mimic_test,private_server_run_validation_test,smoke}.js`；`logs/optimizations.md` 用于核对部署记录。
- 注入/XSS/认证/授权/CSRF/密码学：这批游戏改动没有新增网页、认证入口、查询拼接或密钥处理；测试夹具使用既有 literal 序列化。未发现新增相关问题。
- 状态/竞态/资源耗尽：已确认上述预定误判；连续 tick Memory 复用与本地引擎先 loop 后 console 的执行顺序兼容，跳 tick 重解析有回归。大脑使用 segment 90，不走根 Memory API 写入。外部直接替换根 Memory 是否被连续 tick 缓存覆盖没有在官方服务破坏性测试。
- 信息泄漏：这批变更未新增凭证输出；日志仅记录游戏状态。
- 生效验证边界：旧 `conquest.suppressDeny` 在没有未完成 suppress 指令时跳过，其 deny 阶段也不能证明控制器预定已经下降；不能把普通私服全绿当成敌方压制的真实作战收益。Overmind mimic 是局部模型，不能证明 Celr 实际运行该版本。
- 性能/效率边界：短私服运行不能证明 RCL8 长期收益；需要固定源码与大脑版本重跑。旧 88fe9e7 基准 1,208,082 tick、205.3M 采集、约 40% 孵化、32% CP 是旧版测量，不是当前版效率。

## 线上基线

- tick 73555134：版本 1788807277001，10 房，errors=0，武装敌人=0，bucket=5827。
- W32S4 的 idle 告警同 tick 已有 spawnQueue.spawned=[core:hauler:3]；tick 73555195 已 busy，属于意图/当前状态采样时差，不是持续空转。
- W34S7 从长期窗口 10.30 到接下来 61 tick 的 11.80 CP/tick，仍低于历史 18.48；当前外矿关闭、storage 约 3k，需要更长供能/CPU 样本，不直接增孵 upgrader。
- tick 73555195：errors=0、bucket=9315；W31S8 出现 1 个武装敌人，safe mode 冷却中。继续检查防御结果。

## 持续工作

原 `30-screeps` 已被删除；新建本线程 `screeps` 自动化为 ACTIVE，每小时监控；遵守协调锁，单项复现/修复、完整单测与私服生效/基线验证后部署，并做上线复查。以发展速度、能量账和外矿净收益决定优化，不以无报错替代收益证据。

用户最新方向：暂不进攻，保持进攻代码和计划现状。本轮进攻补丁存于 `2026-09-08-friendly-reservation-deferred.patch`，工作区已恢复原版；后续只做发展效率验证和改进。

## 验证结果与当前状态

- 当前原版 `3c4c35f`：smoke、conquest、Overmind mimic、RCL benchmark 单测、验证器自测、147 项 Python、JS/Python 语法和 Grunt 本地打包通过。
- 原版完整私服 `validation-g9Osi6`：ok=true，notificationErrors=0，baselineWarnings=[]。
- 待处理进攻补丁私服 `validation-bDpiZP`：ok=true，notificationErrors=0，baselineWarnings=[]。补丁仍仅归档，按用户要求未提交到游戏源码、未上线。
- 第三次线上采样 W31S8 武装敌人已消失，errors=0。
- 固定版本发展长跑：`data/soak/rcl-bench-3c4c35f-development`，日志 `logs/rcl-bench-3c4c35f-development.log`，源码/大脑固定 `3c4c35f`，每 50k tick 保存快照。由每小时自动化继续观察，尚未宣称达到 RCL8 或获得效率收益。
- 收尾出现外部观察任务对 `docs/observe/kalgen.md` 的修改；保留原样，不纳入本轮提交。
