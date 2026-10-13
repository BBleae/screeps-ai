# 外置大脑矿物链验证（2026-09-09）

本轮建立由大脑规划、游戏内执行的房内矿物链：RCL6 Extractor 工地，矿工站位/身体/路线，按库存与能量开关，满载/部分卸载/寿命末期送货，耗尽停采与再生恢复。矿物不参与应急采能量，也不改能量 hauler 的取货类别。

## 本地检查

177 项 Python 测试；完整冒烟；矿工执行器边界/禁止房间扫描与寻路的测试；监控探针执行；征服、外矿预定、storage 消费者和外矿道路预算回归；47 模块打包通过。

## 私服

首轮 validation-tLDqQP：54 项生效断言通过，notificationErrors=0，baselineWarnings=[]。包含通过 HTTP 拉取房间对象、写 segment 90、实际采集并交付的 minerals.externalDelivery。

最终版本长跑 validation-dkGd1L：矿物两项生效通过；t1263 已观测 harvested=132、delivered=100、errors=[]。t1770 完整门的四条经济场景断言失败（upgrade.storageRich、feeder.storageToController、tower.maintenanceBudget、hauling.storageConsumerFallback）；最后一条是无 spawn 隔离 fixture 的 1500 tick 寿命耗尽。该次运行不作为发布通过证据。

同窗口发布复核 validation-DBvY7D（900 effect）：矿物实际 harvested=108、delivered=100（t1221），零运行错误；完整门剩 tower.maintenanceBudget 和 demolition.keepsLoadedStore 两条失败。前者检查期末能量>500而正常维修恰可消耗至500，后者误把能量被搬空当成 storage 消失（实际记录仍有 storage）。该运行不记为发布通过。

修正了私服证据采集而未改变游戏代码：引擎成功维修后累计塔维修、源容器维修次数和维修前能量；conflict 中原 storage 增加1 H保持“有资源”前提并标记其原ID，允许其中能量被正常消费。新断言必须有真实维修事件，并保住原始、仍含资源的 storage。旧式仅有高库存、没有实际维修不再通过。新增单测验证失败意图不计数，插桩不赠送能量。验证 runner 现在在断言前保存完整 validation-report.json，便于复核失败证据。

此后与 Link/预定接班修复统一跑组合门，只有组合门全过才上线；合并时线上代码未改变。最终发布结果由统一发布记录补充。

独立生命周期补测沿用 dkGd1L：tick1939 全过，矿脉坐标(37,42)的天然地形确为 wall；Extractor 工地3fad27079e74cf6由项目产生，builder 完成后的新 Extractor 为0e14270b85e810f；耗尽停采和再生恢复均由真实外部指令生效。已关闭该世界。

生效遥测 harvested/delivered 来自下一 tick 的实际库存差，不能把意图返回 OK 当成采集或交付完成。复测同一世界的额外生命周期步骤会缩短再生等待并把工地进度补到最后一点；工地由项目放置，最后进度仍由真实 builder 完成。

## 线上边界

只读检查 tick73575920：十个自有房，W33S7 RCL6，已有 Extractor/可达路线，因能量低于 10000 被大脑判定暂停开采；其余九房 RCL4–5。未把 radius0 的调试计划写入线上。

矿物决策、配体和路径搜索移到 Python；矿工执行器只做 ID 查询、实时容量/冷却检查和直接移动。未测量账号总体 CPU 降幅，不将其他角色的通用寻路或旧蓝图规划宣称为已外移。
