# 无仓库 Link 房间的控制器补给（2026-09-09）

## 现场与根因

线上版本1788892689435，W35S7在tick73575939–73575983的44 tick窗口内CP不动、storage7600不动、控制器Link连续采样为空，32 WORK为空。延长到tick73576027后，CP已经增加679，不能据此宣称永久死锁。tick73576181又观察到storage7600、控制器Link为空、孵化池1800/1800、无spawnWaiting，说明存在可以利用的仓库缓冲，不能全部归因于孵化预留。

W32S4同样有空控制器Link和仓库剩余，但较早样本存在spawnWaiting且CP仍增长，需要保留正常孵化优先级。

根因是控制器Link投递依赖storageRich门槛，而上一轮storageConsumerFallback又排除了Link供能房。源Link仍间歇传送，所以升级表现为间断供给，不是永久失效。

## 修复边界

- 没有可用仓库接收Link、已有控制器Link且有在场upgrader时，发布控制器Link缓冲补给需求，目标400能量。
- 控制器缓冲见底、孵化池至少半满且不等待孵化预算时参与优先补给；否则保持普通控制器投递层级。
- 空载hauler仍先收源容器、掉落及遗物；确无可收货物时，才按实际消费者缺口使用仓库2000以上储备，沿用同tick共享预算与禁止回库循环保护。
- hauler与remoteHauler的兜底投递识别控制器Link，不再给已被Link替代的控制器容器填货。
- 已有仓库Link的完整Hub保持原路由；无Link房间继续使用原有消费者逻辑。

## 验证记录

新增冒烟在旧代码下4项失败，候选代码通过，覆盖实际取送、孵化等待、缓冲已满、2000储备、优先收源容器、完整Hub旁路和无upgrader。

新增隔离私服房W42N40：RCL5，独立用户，无spawn、无矿工、源容器为空；storage初始2600，只有一个控制器Link和一个upgrader。必须同时观察到实际取用、仓库不低于2000、实际控制器升级进度，不能仅凭发布任务或creep数量判定通过。

私服650 effect ticks，结束tick1027：

| 版本 | W42N40 Link场景CP | 仓库剩余 | 仓库实际取用 | W41N40 无Link对照CP |
| --- | ---: | ---: | ---: | ---: |
| 旧游戏5e64e30 + 同一测试9b31d22 | 0 | 2600 | 0 | 600 |
| 候选c08b135 | 600 | 2000 | 600 | 600 |

两次独立播种地形，隔离房能量预算与供给条件一致；此对照证明补给路径生效，不用于计算线上整体吞吐百分比。

候选validation-PlT0N4：54项生效断言全过，零错误、零基线警告；旧代码validation-HVCiqE按预期未通过新增Link断言，运行错误为零。旧代码另有既有roadsWaitForRcl断言失败：唯一道路工地progress=120，正是seedBootstrap要求保留的有进度工地，roadsTrimmed=4证明四条零进度道路均清除。这是既有断言与fixture契约不一致，未改道路逻辑或放宽断言；发布仍要求候选完整通过。

本地冒烟、148项Python测试、conquest、验证执行器自测、JS/Python语法检查通过。原始输出和数据库摘录保存在data/validation/controller-link-feed/，完整数据库在对应private-server/worlds/validation-*。

## 联合发布验证

按会话协调，最终统一包含矿物外置大脑执行、reserver非抢占孵化接班保护和三项监控修复。矿物机制与生命周期证据见[矿物报告](../benchmarks/2026-09-09-mineral-brain.md)。组合版179项Python、冒烟、接班/矿物/仓库/外矿道路预算、验证执行器、实际driver证据测试及47模块打包通过。

首轮组合validation-0gMoS0实际观察到：Link场景600CP；矿物harvested161/delivered100；reserver后继在tick141到达控制器旁，旧者到期tick248。原完整门失败两项，均为测试证据问题：实际非抢占候选是26part/1300的remoteHauler而非硬编码hauler；driver会过滤下划线开头的持久化字段，使塔维修计数未保存。分别增加严格的等价搬运候选正反例与真实driver序列化红绿测试后修正，生产代码未改。

随后validation-hUg6tD发现共享private-server软链接使相对mods路径加载main旧钩子，已停止该轮并保留世界。新增真实软链接世界回归先红后绿，将mod路径固定为发起验证worktree的绝对真实路径。

最终标准组合门validation-QTIuVo（900 effect）全部56项生效断言通过，notificationErrors=0、baselineWarnings=[]。Link隔离场景CP=600、storage=2000；矿物实际harvested=119、delivered=100；reserver在tick121实际到达，旧者到期tick213。塔的真实维修记录已持久化，原loaded storage仍保留。

最终验证候选566405b，生产文件SHA与首次组合验证时完全一致；后续只修正测试证据和环境加载路径。完整报告与精简证据位于data/validation/controller-link-feed/release-report.json及release-summary.json。

## 部署

已由干净独立工作树统一上传至default/activeWorld，版本1788897505183，47模块与本地dist逐一一致，Memory.SCRIPT_VERSION已生效。原有34项未提交文件SHA256保持一致。

上线功能探针tick73576913：errors=[]；W35S7控制器Link479、32WORK均非空；W32S4控制器Link794、storageConsumerFallback=1325，已观察到本次仓库兜底实际取用，storage仍5671；W34S7控制器Link308。该单点仅证明版本与行为生效，持续恢复由监控任务三次间隔采样核对。

已用正式解释器、主目录locks执行radius2外部大脑写入（1788897630994，36708字节、无情报阻断）。既有定时writer随后发布1788897635036；独立读取segment90、Memory.brain.issuedAt、ack.issuedAt均为1788897635036，确认当前指令已消费，errors=[]。

W33S7矿物计划version=1，pos=(18,41)、stand=(19,40)，outbound及1个sink完整；因能量策略enabled=false/reason=energy，未强迫开采。持续监控由原监控任务执行三次间隔复查。


## 持续观察项

三次线上采样73576922/945/968中，W35S7 CP共增加514（46tick，11.17/t），storage6976保持不变，后两次ctrlLink为0，尚不能宣称持续恢复。进一步tick73576992看到ctrlLink789；一只hauler带230投递extension，另一只空载并明确选取远源(18,30)容器的140能量，仓库就在(38,20)。因此当前未使用storage是源侧候选优先于闲置兜底的结果，不是新分支缺失或永久死锁。混合Link房的小批量远途取货与运力分配仍由监控任务继续独立采样、对照后再优化，本轮没有抬高仓库取货优先级。W32S4已实际触发兜底、W34S7三采升级30/t、W32S1三采恢复；不把单点Link有能量当作所有房间持续恢复的证明。
