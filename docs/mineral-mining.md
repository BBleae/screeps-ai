# 房内 Mineral / Extractor

矿物链由 `scripts/brain/minerals.py` 决策，经 segment 90 下发到
`Memory.brain.rooms[room].mineral`。不为矿物提供游戏内自治规划或离线替代方案。
运行现有 `scripts/brain/run.py --write` 即会给 RCL6+ 自有房生成矿物指令。

大脑读取房间对象、地形和矿工 Memory，在本机完成：

- 检查 RCL、归属、Extractor、可达性、矿脉余量、仓库空间及库存。
- 选择可达矿工站位，绕开矿脉本身、天然墙、阻挡建筑及建筑工地。
- 计算从出生位置到矿脉、从矿脉到 terminal/storage、以及回收的方向表。
- 枚举 WORK/CARRY/MOVE 配比，按采集与往返耗时选择身体，单体预算不超过 3000。
- 停采条件消失或矿脉再生后，重新发出开采指令。

默认每房最多一只自运矿工。目标矿物库存 50000、仓库总能量至少 10000、
空闲空间预留 5000（大脑还预留一只矿工的最大装载量）。这些策略参数集中在
`minerals.DEFAULTS`，不在游戏内重复评估身体和路线。

游戏内仍核查实时 RCL、Extractor 是否有效、实际冷却、矿脉余量、库存和空余容量，
防止两轮大脑之间状态变化造成无效采集。按对象 ID 获取目标，不扫描房间；
沿稀疏方向表调用 `creep.move`，不调用 PathFinder。路线外的位置写入
`creep.memory.mineralRouteMiss`，下一轮大脑会根据矿工实际位置补充路径。连续三次移动未前进时，停止重复提交移动，
记录阻挡格交给大脑绕行。矿工不参与通用应急采能量。

Extractor 由现有施工队列在 RCL6 起放置，坐标来自大脑。矿脉可能在天然墙上，
因此 Extractor 不使用普通建筑的天然墙排除条件，最终合法性由引擎判断。
沿用已有房间蓝图和工地预算；不为自运矿工新建无必要的矿物容器。

矿工装不下下一次产量时先卸货；部分卸货后继续卸，不折返。terminal 满后使用
指令中的 storage。寿命接近返程所需时间时提前送出剩余矿物。耗尽或指令停采时，
有货先卸、空手回收（交付已有货物可能略高于目标库存）；所有目的地都满时保留货物等待空间，不带货回收。

`Memory.rooms[room].mineralStats.harvested/delivered` 是下一 tick 根据携带量实际变化
累计的矿物数量，不把 API 返回 OK 当成已生效。私服完整门增加
`minerals.externalDelivery`：真实 HTTP 获取对象并写 segment，要求实际采集且入库。

## 验证

```sh
node test/smoke.js
node test/mineral_executor_test.js
python3 -m unittest discover -s test -p '*_test.py'
node scripts/private_server/run_validation.js --effect-ticks 900
```

既有大脑已承担情报、外矿分配、扩张和防御决策。本次把矿物链的所有新增规划放到
外部；其他经济角色、通用交通、旧蓝图生成和每 tick 的即时动作仍在游戏内执行。
这不是把整个机器人迁移到外部运行，也不把未测量的总 CPU 降幅作为交付结论。

附加生命周期验证（仅针对 `--keep-running` 留下的可丢弃私服世界）：

```sh
node scripts/private_server/mineral_lifecycle.js CLI_PORT GAME_PORT OUTPUT_DIR
```

该脚本会人为加速再生，并把项目实际放出的 Extractor 工地进度补到最后一点，
再由真实 builder 完成。它只连接本机明确给出的私服端口，验证完成后应关闭测试世界。
