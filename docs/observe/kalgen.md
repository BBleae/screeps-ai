# Kalgen 观察报告

自动生成于 20261013T133956Z（scripts/observe/run.py）。数据全部来自官方只读 API 与公开 room-history。

## 账号
- GCL 53,160,312,912，power 172,701,873；房间 89（shard3 3，shardX 86）。
- 名次：world 榜 2026-10 赛季 rank 0；power 榜 2026-10 赛季 rank 4
- RCL 分布 {7: 1, 8: 88}；每房 creep 均值 8.4（4–28）；spawn 忙碌 76/265。

## 能量与产出速率
- 约 1 小时（窗口 64 分钟 ≈ 1532 tick）：每房每 tick 采能 60.5、控制器 26.1、creep 20.3、建造 4.3；控制器占比 0.432、creep 占比 0.335、建造占比 0.072；每房每小时部件 363.1，每部件能量 80.1，每千部件损失 3.10，power 28,009
- 约 24 小时（窗口 1440 分钟 ≈ 34,464 tick）：每房每 tick 采能 60.1、控制器 26.9、creep 20.2、建造 5.6；控制器占比 0.448、creep 占比 0.337、建造占比 0.094；每房每小时部件 355.5，每部件能量 81.7，每千部件损失 4.01，power 417,079
- 约 8 天（窗口 11,520 分钟 ≈ 275,708 tick）：每房每 tick 采能 57.2、控制器 24.3、creep 19.3、建造 5.5；控制器占比 0.426、creep 占比 0.338、建造占比 0.096；每房每小时部件 339.8，每部件能量 81.6，每千部件损失 4.81，power 3,262,528

我方同口径（对照）：
- 约 1 小时（窗口 64 分钟 ≈ 941 tick）：每房每 tick 采能 35.8、控制器 17.3、creep 14.0、建造 4.4；控制器占比 0.484、creep 占比 0.391、建造占比 0.124；每房每小时部件 169.8，每部件能量 72.8，每千部件损失 0.00，power -
- 约 24 小时（窗口 1440 分钟 ≈ 21,182 tick）：每房每 tick 采能 35.4、控制器 15.4、creep 14.3、建造 5.7；控制器占比 0.436、creep 占比 0.405、建造占比 0.162；每房每小时部件 178.0，每部件能量 70.9，每千部件损失 2.04，power -
- 约 8 天（窗口 11,520 分钟 ≈ 169,453 tick）：每房每 tick 采能 26.8、控制器 12.3、creep 9.9、建造 4.4；控制器占比 0.461、creep 占比 0.372、建造占比 0.163；每房每小时部件 121.8，每部件能量 72.1，每千部件损失 2.16，power -

## 身体原型（角色 → 签名 × 数量）
- eharvest：W10C8M5×155，W10C1M5×43
- lhauler：C32M16×137
- efiller：C16M8×92，C32M16×2
- xboostedUpgrader：W15C16M1×94
- legacyscientist：C8M4×89
- shauler：C32M16×44
- mineralHarvest：W24C12M12×27
- mineralDeliver：C6M3×24
- praiseUpgrader：W45C4M1×15
- llinkUpgrader：W1C16M1×9
- eguardian：M2R1H1×4，M10R5H5×3
- ereserve：M7L7×5
- eworkroad：W6C6M6×3
- wupgrader：W47C2M1×2
- praiseHauler：C32M16×2
- superranged：M25R15H10×1

## 布局与结构
- link 用途分布 {'other': 1, 'edge': 258, 'hub': 87, 'source': 154}（source=距源≤2，hub=距 storage≤2，controller=距控制器≤3，edge=贴房间边）。
- 核心外接矩形面积中位数 80（49–204）；storage→controller 距离中位数 3（最大 4）；storage→源 距离中位数 18（最大 38）。
- storage 能量中位数 219,497（11,742–300,042）；rampart 数中位数 27（最大 96）。
- 角色总数 {'eharvest': 198, 'lhauler': 137, 'efiller': 94, 'xboostedUpgrader': 94, 'legacyscientist': 89, 'shauler': 44, 'mineralHarvest': 27, 'mineralDeliver': 24, 'praiseUpgrader': 15, 'llinkUpgrader': 9, 'eguardian': 7, 'ereserve': 5, 'eworkroad': 3, 'wupgrader': 2, 'praiseHauler': 2, 'superranged': 1}。

## 外矿拓扑（由 creep 名推断）
- 84 个母房有外矿 creep，每母房外矿数均值 2.1（最多 4）。
- E12S12 → E11S12(lhauler1)，E12S13(lhauler1)
- E17N43 → E16N43(lhauler1)，E17N42(lhauler1)，E18N43(lhauler1,eharvest1)
- E1N55 → E1N54(lhauler1)，E2N55(eharvest1)
- E1N57 → E1N56(lhauler1)，E2N57(lhauler2)
- E23N51 → E22N51(lhauler1)，E24N51(lhauler1)
- E23N58 → E22N59(lhauler1,eharvest1)，E23N57(shauler1)，E23N59(lhauler1)
- E27N58 → E27N59(ereserve1)，E28N58(lhauler1)
- E3S42 → E2S42(lhauler1,superranged1)，E3S43(shauler1)，E4S42(lhauler1)，E4S43(lhauler1)
- E5N58 → E4N57(lhauler1)，E6N57(lhauler1)，E6N58(lhauler1,eworkroad1)
- E5S9 → E4S9(lhauler1)，E5S8(shauler1)，E6S9(lhauler1)
- E7N12 → E7N11(shauler2)
- E7S48 → E6S48(lhauler1)，E7S49(lhauler1)，E8S47(lhauler1)

## 抓到的外矿房
- shardX/W51S48（母房 W51S47）：预定剩余 3592，源 2，容器 1170，道路 31，入侵者 0，核心 False，我方 creep {'lhauler': 1, 'eharvest': 1}
- shardX/W52N34（母房 W53N34）：预定剩余 3118，源 2，容器 1740/260，道路 31，入侵者 0，核心 False，我方 creep {'eharvest': 1, 'lhauler': 1}
- shardX/W52N51（母房 W52N52）：预定剩余 1474，源 1，容器 28，道路 24，入侵者 0，核心 False，我方 creep {'eharvest': 1}
- shardX/W52S26（母房 W52S25）：预定剩余 1531，源 2，容器 1290/930，道路 29，入侵者 0，核心 False，我方 creep {'eharvest': 2}
- shardX/W52S45（母房 W52S44）：预定剩余 2605，源 2，容器 710/270，道路 26，入侵者 0，核心 False，我方 creep {'eharvest': 2}
- shardX/W52S47（母房 W51S47）：预定剩余 3347，源 2，容器 0/360，道路 10，入侵者 0，核心 False，我方 creep {'eharvest': 2}

## 100 tick 行为回放
- W15N28（base 83620200，100 tick）：源采集速率 -；spawn 事件 ereserve(needTime 24)，shauler(needTime 144)，efiller(needTime 72)，eharvest(needTime 48)
  - efiller ×3：每 tick 移动 0.331，每 tick 卸货 11.79，卸货对象 {'terminal': 2, 'spawn': 3, 'extension': 18}
  - eharvest ×2：每 tick 移动 0.000，每 tick 卸货 0.00，卸货对象 {}
  - ereserve ×1：每 tick 移动 0.732，每 tick 卸货 0.00，卸货对象 {}
  - legacyscientist ×1：每 tick 移动 0.000，每 tick 卸货 0.00，卸货对象 {}
  - praiseHauler ×2：每 tick 移动 0.535，每 tick 卸货 434.11，卸货对象 {'container': 35, 'none': 16}
  - praiseUpgrader ×15：每 tick 移动 0.002，每 tick 卸货 38.37，卸货对象 {'link': 193, 'none': 60, 'controller': 146, 'container': 540}
  - shauler ×5：每 tick 移动 0.728，每 tick 卸货 15.37，卸货对象 {'terminal': 3, 'spawn': 1, 'storage': 1}
  - wupgrader ×3：每 tick 移动 0.000，每 tick 卸货 20.23，卸货对象 {'storage': 80, 'link': 50}
- W54N53（base 6895400，100 tick）：源采集速率 20；spawn 事件 ereserve(needTime 42)，legacyscientist(needTime 36)
  - efiller ×1：每 tick 移动 0.370，每 tick 卸货 44.50，卸货对象 {'link': 1, 'storage': 5, 'spawn': 7, 'extension': 9}
  - eharvest ×2：每 tick 移动 0.000，每 tick 卸货 9.20，卸货对象 {'link': 8}
  - ereserve ×1：每 tick 移动 0.149，每 tick 卸货 0.00，卸货对象 {}
  - legacyscientist ×2：每 tick 移动 0.099，每 tick 卸货 0.00，卸货对象 {}
  - lhauler ×3：每 tick 移动 0.140，每 tick 卸货 76.05，卸货对象 {'none': 3, 'link': 7}
  - mineralDeliver ×1：每 tick 移动 0.990，每 tick 卸货 0.00，卸货对象 {}
  - mineralHarvest ×1：每 tick 移动 0.000，每 tick 卸货 0.00，卸货对象 {}
  - xboostedUpgrader ×1：每 tick 移动 0.000，每 tick 卸货 82.81，卸货对象 {'link': 88}
- W54N58（base 6895400，100 tick）：源采集速率 -；spawn 事件 eharvest(needTime 48)，efiller(needTime 72)
  - efiller ×2：每 tick 移动 0.075，每 tick 卸货 6.29，卸货对象 {'storage': 2, 'extension': 2, 'spawn': 1}
  - eharvest ×2：每 tick 移动 0.285，每 tick 卸货 0.00，卸货对象 {}
  - legacyscientist ×1：每 tick 移动 0.000，每 tick 卸货 0.00，卸货对象 {}
  - lhauler ×3：每 tick 移动 0.056，每 tick 卸货 56.07，卸货对象 {'link': 6, 'none': 2}
  - shauler ×1：每 tick 移动 0.264，每 tick 卸货 18.39，卸货对象 {'storage': 1}
  - xboostedUpgrader ×1：每 tick 移动 0.000，每 tick 卸货 51.27，卸货对象 {'link': 92}

## 与上一轮的变化
- gcl：{'from': 53135832668, 'to': 53160312912}
- power：{'from': 172563372, 'to': 172701873}
- newSignatures：{'superranged': ['M25R15H10']}

## 房间一览
- shard3/W15N28 RCL7：creep 28 {'efiller': 2, 'shauler': 3, 'praiseUpgrader': 15, 'eharvest': 2, 'wupgrader': 2, 'praiseHauler': 2, 'legacyscientist': 1, 'eworkroad': 1}；storage 11,742，terminal 169,771；link {'other': 1, 'edge': 1, 'hub': 1}；塔 6（均 992）；rampart 12（均 5,849,626）；lab 10；spawn 忙 2/3；核心 9x11；storage→ctrl 3
- shard3/W16N28 RCL8：creep 6 {'shauler': 2, 'xboostedUpgrader': 1, 'legacyscientist': 1, 'eharvest': 1, 'efiller': 1}；storage 181,270，terminal 207,568；link {'hub': 1, 'source': 1}；塔 6（均 948）；rampart 14（均 100,355,011）；lab 10；spawn 忙 0/3；核心 13x11；storage→ctrl 4
- shard3/W18N28 RCL8：creep 8 {'shauler': 3, 'efiller': 1, 'legacyscientist': 1, 'eharvest': 2, 'xboostedUpgrader': 1}；storage 156,952，terminal 94,345；link {'hub': 1}；塔 6（均 947）；rampart 11（均 141,539,964）；lab 10；spawn 忙 1/3；核心 8x9；storage→ctrl 4
- shardX/E12S12 RCL8：creep 7 {'eharvest': 2, 'legacyscientist': 1, 'lhauler': 2, 'efiller': 1, 'xboostedUpgrader': 1}；storage 222,754，terminal 103,633；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 900）；rampart 32（均 57,927,512）；lab 10；spawn 忙 0/3；核心 9x8；storage→ctrl 4
- shardX/E17N43 RCL8：creep 9 {'xboostedUpgrader': 2, 'legacyscientist': 1, 'eharvest': 2, 'lhauler': 3, 'efiller': 1}；storage 220,443，terminal 116,900；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 925）；rampart 37（均 50,199,289）；lab 10；spawn 忙 3/3；核心 11x10；storage→ctrl 4
- shardX/E1N55 RCL8：creep 7 {'xboostedUpgrader': 1, 'efiller': 1, 'legacyscientist': 1, 'eharvest': 3, 'lhauler': 1}；storage 89,649，terminal 89,325；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 925）；rampart 28（均 24,918,654）；lab 10；spawn 忙 0/3；核心 13x6；storage→ctrl 4
- shardX/E1N57 RCL8：creep 10 {'efiller': 1, 'mineralHarvest': 1, 'eharvest': 2, 'legacyscientist': 1, 'mineralDeliver': 1, 'xboostedUpgrader': 1, 'lhauler': 3}；storage 220,591，terminal 118,373；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 917）；rampart 35（均 43,278,882）；lab 10；spawn 忙 0/3；核心 8x12；storage→ctrl 4
- shardX/E23N51 RCL8：creep 8 {'efiller': 2, 'legacyscientist': 1, 'lhauler': 2, 'xboostedUpgrader': 1, 'eharvest': 2}；storage 218,837，terminal 109,814；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 888）；rampart 96（均 13,641,846）；lab 10；spawn 忙 1/3；核心 7x11；storage→ctrl 3
- shardX/E23N58 RCL8：creep 9 {'lhauler': 2, 'xboostedUpgrader': 1, 'eharvest': 3, 'shauler': 1, 'legacyscientist': 1, 'efiller': 1}；storage 175,349，terminal 89,508；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 890）；rampart 53（均 13,444,173）；lab 10；spawn 忙 1/3；核心 8x9；storage→ctrl 4
- shardX/E27N58 RCL8：creep 7 {'xboostedUpgrader': 1, 'eharvest': 2, 'lhauler': 1, 'efiller': 1, 'legacyscientist': 1, 'ereserve': 1}；storage 218,143，terminal 117,002；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 838）；rampart 41（均 42,050,579）；lab 10；spawn 忙 1/3；核心 11x7；storage→ctrl 3
- shardX/E3S42 RCL8：creep 11 {'xboostedUpgrader': 2, 'eharvest': 1, 'lhauler': 3, 'efiller': 2, 'shauler': 1, 'legacyscientist': 1, 'superranged': 1}；storage 220,468，terminal 95,880；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 892）；rampart 34（均 48,000,480）；lab 10；spawn 忙 2/3；核心 9x12；storage→ctrl 3
- shardX/E5N58 RCL8：creep 11 {'xboostedUpgrader': 1, 'lhauler': 3, 'eharvest': 2, 'mineralHarvest': 1, 'efiller': 1, 'mineralDeliver': 1, 'legacyscientist': 1, 'eworkroad': 1}；storage 219,992，terminal 119,052；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 937）；rampart 31（均 58,832,455）；lab 10；spawn 忙 1/3；核心 10x7；storage→ctrl 4
- shardX/E5S9 RCL8：creep 8 {'efiller': 1, 'legacyscientist': 1, 'shauler': 1, 'eharvest': 2, 'xboostedUpgrader': 1, 'lhauler': 2}；storage 219,497，terminal 93,850；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 977）；rampart 53（均 34,591,375）；lab 10；spawn 忙 1/3；核心 8x9；storage→ctrl 4
- shardX/E7N12 RCL8：creep 8 {'shauler': 2, 'eharvest': 2, 'xboostedUpgrader': 1, 'mineralHarvest': 1, 'mineralDeliver': 1, 'efiller': 1}；storage 278,758，terminal 89,065；link {'hub': 1, 'source': 1, 'edge': 3}；塔 6（均 890）；rampart 11（均 60,696,074）；lab 10；spawn 忙 1/3；核心 10x7；storage→ctrl 2
- shardX/E7S48 RCL8：creep 8 {'xboostedUpgrader': 1, 'efiller': 1, 'lhauler': 3, 'legacyscientist': 1, 'eharvest': 2}；storage 104,653，terminal 90,239；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 898）；rampart 25（均 36,887,487）；lab 10；spawn 忙 0/3；核心 9x10；storage→ctrl 4
- shardX/E8N36 RCL8：creep 8 {'eharvest': 2, 'lhauler': 2, 'xboostedUpgrader': 1, 'shauler': 1, 'efiller': 1, 'legacyscientist': 1}；storage 106,086，terminal 87,660；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 928）；rampart 22（均 50,123,916）；lab 10；spawn 忙 0/3；核心 6x14；storage→ctrl 4
- shardX/E8N58 RCL8：creep 8 {'legacyscientist': 1, 'lhauler': 3, 'eharvest': 2, 'efiller': 1, 'xboostedUpgrader': 1}；storage 219,239，terminal 90,158；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 913）；rampart 41（均 43,395,291）；lab 10；spawn 忙 1/3；核心 7x8；storage→ctrl 3
- shardX/E8S44 RCL8：creep 7 {'legacyscientist': 1, 'shauler': 1, 'xboostedUpgrader': 1, 'eharvest': 3, 'efiller': 1}；storage 223,245，terminal 98,597；link {'hub': 1, 'source': 1, 'edge': 3}；塔 6（均 912）；rampart 60（均 26,274,097）；lab 10；spawn 忙 0/3；核心 10x8；storage→ctrl 3
- shardX/W11S44 RCL8：creep 5 {'eharvest': 2, 'xboostedUpgrader': 1, 'efiller': 1, 'legacyscientist': 1}；storage 225,752，terminal 87,852；link {'source': 2, 'edge': 3, 'hub': 1}；塔 6（均 888）；rampart 34（均 56,428,927）；lab 10；spawn 忙 0/3；核心 11x12；storage→ctrl 2
- shardX/W12S1 RCL8：creep 10 {'mineralHarvest': 2, 'mineralDeliver': 1, 'legacyscientist': 1, 'lhauler': 2, 'eharvest': 2, 'xboostedUpgrader': 1, 'efiller': 1}；storage 220,502，terminal 103,569；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 890）；rampart 45（均 37,472,948）；lab 10；spawn 忙 1/3；核心 11x7；storage→ctrl 4
- shardX/W12S42 RCL8：creep 8 {'efiller': 1, 'legacyscientist': 1, 'lhauler': 3, 'xboostedUpgrader': 1, 'eharvest': 2}；storage 218,962，terminal 115,111；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 888）；rampart 15（均 100,101,438）；lab 10；spawn 忙 1/3；核心 11x11；storage→ctrl 2
- shardX/W13N35 RCL8：creep 9 {'eharvest': 2, 'mineralHarvest': 1, 'mineralDeliver': 1, 'xboostedUpgrader': 1, 'lhauler': 1, 'efiller': 1, 'legacyscientist': 1, 'eguardian': 1}；storage 220,009，terminal 97,194；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 928）；rampart 37（均 50,277,186）；lab 10；spawn 忙 0/3；核心 7x12；storage→ctrl 3
- shardX/W15S22 RCL8：creep 8 {'xboostedUpgrader': 2, 'shauler': 1, 'legacyscientist': 1, 'eharvest': 3, 'efiller': 1}；storage 225,541，terminal 114,665；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 927）；rampart 17（均 100,102,066）；lab 10；spawn 忙 2/3；核心 11x9；storage→ctrl 3
- shardX/W15S43 RCL8：creep 10 {'lhauler': 2, 'eharvest': 3, 'llinkUpgrader': 1, 'efiller': 1, 'mineralHarvest': 1, 'legacyscientist': 1, 'mineralDeliver': 1}；storage 58,050，terminal 90,020；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 898）；rampart 13（均 65,034,449）；lab 10；spawn 忙 1/3；核心 7x9；storage→ctrl 4
- shardX/W17S28 RCL8：creep 6 {'lhauler': 1, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'eharvest': 1, 'efiller': 1, 'shauler': 1}；storage 300,042，terminal 111,648；link {'hub': 1, 'source': 1, 'edge': 3}；塔 6（均 888）；rampart 36（均 43,392,299）；lab 10；spawn 忙 0/3；核心 6x11；storage→ctrl 3
- shardX/W17S42 RCL8：creep 10 {'xboostedUpgrader': 2, 'lhauler': 3, 'eharvest': 2, 'legacyscientist': 1, 'shauler': 1, 'efiller': 1}；storage 159,217，terminal 90,093；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 968）；rampart 16（均 54,233,551）；lab 10；spawn 忙 2/3；核心 7x9；storage→ctrl 4
- shardX/W18S26 RCL8：creep 6 {'eharvest': 2, 'lhauler': 1, 'xboostedUpgrader': 1, 'efiller': 1, 'legacyscientist': 1}；storage 219,660，terminal 104,737；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 943）；rampart 27（均 87,085,609）；lab 10；spawn 忙 0/3；核心 9x12；storage→ctrl 3
- shardX/W18S4 RCL8：creep 7 {'xboostedUpgrader': 2, 'eharvest': 2, 'lhauler': 1, 'efiller': 1, 'legacyscientist': 1}；storage 219,602，terminal 118,834；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 927）；rampart 46（均 36,533,291）；lab 10；spawn 忙 1/3；核心 9x8；storage→ctrl 4
- shardX/W18S45 RCL8：creep 7 {'shauler': 1, 'lhauler': 1, 'xboostedUpgrader': 1, 'eharvest': 2, 'legacyscientist': 1, 'efiller': 1}；storage 289,938，terminal 103,487；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 942）；rampart 10（均 100,101,051）；lab 10；spawn 忙 0/3；核心 10x14；storage→ctrl 3
- shardX/W22N28 RCL8：creep 9 {'eharvest': 3, 'legacyscientist': 1, 'lhauler': 3, 'xboostedUpgrader': 1, 'efiller': 1}；storage 217,264，terminal 90,188；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 880）；rampart 47（均 36,205,477）；lab 10；spawn 忙 3/3；核心 11x9；storage→ctrl 3
- shardX/W22N44 RCL8：creep 10 {'xboostedUpgrader': 2, 'eharvest': 2, 'lhauler': 4, 'efiller': 1, 'legacyscientist': 1}；storage 220,175，terminal 116,810；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 928）；rampart 39（均 43,906,017）；lab 10；spawn 忙 1/3；核心 8x9；storage→ctrl 4
- shardX/W22S17 RCL8：creep 11 {'xboostedUpgrader': 2, 'lhauler': 2, 'efiller': 1, 'eharvest': 3, 'mineralHarvest': 1, 'legacyscientist': 1, 'mineralDeliver': 1}；storage 197,029，terminal 85,942；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 889）；rampart 14（均 28,550,795）；lab 10；spawn 忙 2/3；核心 7x8；storage→ctrl 3
- shardX/W22S38 RCL8：creep 8 {'lhauler': 1, 'efiller': 1, 'legacyscientist': 1, 'eharvest': 2, 'mineralHarvest': 1, 'llinkUpgrader': 1, 'mineralDeliver': 1}；storage 87,561，terminal 89,607；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 892）；rampart 16（均 54,087,388）；lab 10；spawn 忙 1/3；核心 8x10；storage→ctrl 4
- shardX/W22S54 RCL8：creep 7 {'eharvest': 2, 'efiller': 1, 'shauler': 1, 'xboostedUpgrader': 1, 'legacyscientist': 1, 'lhauler': 1}；storage 221,836，terminal 108,979；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 857）；rampart 33（均 64,312,954）；lab 10；spawn 忙 1/3；核心 9x14；storage→ctrl 4
- shardX/W23N2 RCL8：creep 9 {'eharvest': 2, 'legacyscientist': 1, 'lhauler': 1, 'mineralHarvest': 1, 'efiller': 1, 'xboostedUpgrader': 1, 'mineralDeliver': 1, 'ereserve': 1}；storage 219,217，terminal 114,485；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 878）；rampart 34（均 53,326,357）；lab 10；spawn 忙 0/3；核心 9x10；storage→ctrl 3
- shardX/W23S36 RCL8：creep 15 {'efiller': 1, 'legacyscientist': 1, 'lhauler': 4, 'mineralHarvest': 1, 'eharvest': 4, 'mineralDeliver': 1, 'xboostedUpgrader': 1, 'shauler': 1, 'eguardian': 1}；storage 220,330，terminal 99,358；link {'hub': 1, 'edge': 4, 'source': 1}；塔 6（均 905）；rampart 16（均 100,101,488）；lab 10；spawn 忙 2/3；核心 7x11；storage→ctrl 4
- shardX/W23S59 RCL8：creep 8 {'eharvest': 2, 'legacyscientist': 1, 'lhauler': 2, 'shauler': 1, 'efiller': 1, 'xboostedUpgrader': 1}；storage 221,835，terminal 119,782；link {'hub': 1, 'source': 1, 'edge': 3}；塔 6（均 938）；rampart 32（均 73,103,848）；lab 10；spawn 忙 0/3；核心 7x7；storage→ctrl 4
- shardX/W24S52 RCL8：creep 10 {'lhauler': 2, 'legacyscientist': 1, 'eharvest': 3, 'mineralHarvest': 1, 'mineralDeliver': 1, 'xboostedUpgrader': 1, 'efiller': 1}；storage 219,840，terminal 80,049；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 862）；rampart 12（均 100,102,348）；lab 10；spawn 忙 1/3；核心 9x15；storage→ctrl 2
- shardX/W24S53 RCL8：creep 7 {'xboostedUpgrader': 2, 'shauler': 1, 'efiller': 1, 'legacyscientist': 1, 'eharvest': 2}；storage 186,004，terminal 90,327；link {'hub': 1, 'source': 2, 'edge': 1}；塔 6（均 918）；rampart 11（均 10,285,419）；lab 10；spawn 忙 1/3；核心 8x11；storage→ctrl 4
- shardX/W26N29 RCL8：creep 4 {'eharvest': 1, 'efiller': 1, 'xboostedUpgrader': 1, 'legacyscientist': 1}；storage 220,156，terminal 100,896；link {'edge': 2, 'source': 1, 'hub': 1}；塔 6（均 887）；rampart 12（均 69,206,184）；lab 10；spawn 忙 0/3；核心 10x8；storage→ctrl 3
- shardX/W28S18 RCL8：creep 7 {'xboostedUpgrader': 2, 'eharvest': 3, 'efiller': 1, 'legacyscientist': 1}；storage 181,992，terminal 87,568；link {'hub': 1, 'source': 2, 'edge': 3}；塔 5（均 900）；rampart 48（均 10,063,298）；lab 10；spawn 忙 3/3；核心 11x11；storage→ctrl 2
- shardX/W29N6 RCL8：creep 6 {'efiller': 1, 'legacyscientist': 1, 'eharvest': 2, 'xboostedUpgrader': 1, 'lhauler': 1}；storage 219,038，terminal 52,265；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 908）；rampart 16（均 100,102,264）；lab 10；spawn 忙 1/3；核心 12x7；storage→ctrl 3
- shardX/W2N42 RCL8：creep 6 {'xboostedUpgrader': 1, 'lhauler': 2, 'efiller': 1, 'legacyscientist': 1, 'eharvest': 1}；storage 163,595，terminal 89,550；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 930）；rampart 13（均 18,068,624）；lab 10；spawn 忙 0/3；核心 9x10；storage→ctrl 3
- shardX/W2S12 RCL8：creep 10 {'eharvest': 2, 'lhauler': 2, 'mineralHarvest': 1, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'mineralDeliver': 1, 'shauler': 1, 'efiller': 1}；storage 222,556，terminal 114,534；link {'source': 2, 'edge': 4}；塔 6（均 970）；rampart 31（均 44,809,443）；lab 10；spawn 忙 1/3；核心 7x11；storage→ctrl 4
- shardX/W2S16 RCL8：creep 10 {'lhauler': 3, 'xboostedUpgrader': 1, 'efiller': 1, 'legacyscientist': 1, 'eharvest': 4}；storage 208,969，terminal 69,338；link {'hub': 1, 'source': 1, 'edge': 3}；塔 6（均 928）；rampart 34（均 49,278,995）；lab 10；spawn 忙 2/3；核心 8x9；storage→ctrl 3
- shardX/W31S8 RCL8：creep 9 {'xboostedUpgrader': 2, 'lhauler': 3, 'eharvest': 2, 'efiller': 1, 'legacyscientist': 1}；storage 220,431，terminal 93,990；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 877）；rampart 32（均 54,837,994）；lab 10；spawn 忙 1/3；核心 7x11；storage→ctrl 3
- shardX/W32S44 RCL8：creep 13 {'llinkUpgrader': 1, 'lhauler': 2, 'eharvest': 4, 'mineralHarvest': 1, 'legacyscientist': 1, 'shauler': 2, 'mineralDeliver': 1, 'efiller': 1}；storage 98,203，terminal 90,110；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 907）；rampart 17（均 63,082,906）；lab 10；spawn 忙 1/3；核心 10x10；storage→ctrl 4
- shardX/W33N35 RCL8：creep 8 {'legacyscientist': 1, 'lhauler': 1, 'efiller': 1, 'xboostedUpgrader': 1, 'eharvest': 3, 'eguardian': 1}；storage 219,191，terminal 110,876；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 888）；rampart 42（均 44,476,101）；lab 10；spawn 忙 2/3；核心 12x9；storage→ctrl 3
- shardX/W35N52 RCL8：creep 6 {'efiller': 2, 'legacyscientist': 1, 'eharvest': 2, 'xboostedUpgrader': 1}；storage 218,275，terminal 102,965；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 932）；rampart 43（均 39,203,419）；lab 10；spawn 忙 1/2；核心 9x8；storage→ctrl 4
- shardX/W35S23 RCL8：creep 8 {'legacyscientist': 1, 'eharvest': 3, 'efiller': 1, 'xboostedUpgrader': 1, 'lhauler': 1, 'eguardian': 1}；storage 220,001，terminal 114,921；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 843）；rampart 50（均 43,798,409）；lab 10；spawn 忙 1/3；核心 10x8；storage→ctrl 3
- shardX/W36N59 RCL8：creep 8 {'xboostedUpgrader': 2, 'legacyscientist': 1, 'lhauler': 2, 'efiller': 1, 'eharvest': 2}；storage 219,187，terminal 116,351；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 932）；rampart 17（均 100,100,836）；lab 10；spawn 忙 2/3；核心 10x11；storage→ctrl 3
- shardX/W37N33 RCL8：creep 9 {'efiller': 1, 'eharvest': 4, 'legacyscientist': 1, 'mineralDeliver': 1, 'xboostedUpgrader': 1, 'mineralHarvest': 1}；storage 212,659，terminal 89,886；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 957）；rampart 33（均 56,031,944）；lab 10；spawn 忙 2/3；核心 6x11；storage→ctrl 2
- shardX/W39N53 RCL8：creep 9 {'xboostedUpgrader': 2, 'lhauler': 2, 'eharvest': 3, 'efiller': 1, 'legacyscientist': 1}；storage 219,895，terminal 98,157；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 962）；rampart 28（均 57,924,952）；lab 10；spawn 忙 2/3；核心 10x10；storage→ctrl 4
- shardX/W39N54 RCL8：creep 9 {'eharvest': 4, 'efiller': 1, 'xboostedUpgrader': 1, 'legacyscientist': 1, 'lhauler': 1, 'eguardian': 1}；storage 199,642，terminal 87,309；link {'source': 2, 'hub': 1, 'edge': 3}；塔 6（均 893）；rampart 9（均 11,693,412）；lab 10；spawn 忙 3/3；核心 7x18；storage→ctrl 3
- shardX/W39S47 RCL8：creep 7 {'eharvest': 2, 'llinkUpgrader': 1, 'lhauler': 2, 'efiller': 1, 'legacyscientist': 1}；storage 88,764，terminal 90,661；link {'source': 2, 'edge': 4}；塔 6（均 923）；rampart 11（均 87,218,200）；lab 10；spawn 忙 0/3；核心 9x6；storage→ctrl 3
- shardX/W3S51 RCL8：creep 10 {'mineralHarvest': 2, 'mineralDeliver': 1, 'efiller': 1, 'lhauler': 2, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'eharvest': 2}；storage 174,396，terminal 89,199；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 910）；rampart 16（均 39,555,145）；lab 10；spawn 忙 2/2；核心 9x7；storage→ctrl 4
- shardX/W41S55 RCL8：creep 6 {'xboostedUpgrader': 1, 'legacyscientist': 1, 'lhauler': 1, 'eharvest': 2, 'efiller': 1}；storage 97,652，terminal 89,195；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 958）；rampart 38（均 20,292,154）；lab 10；spawn 忙 0/3；核心 11x12；storage→ctrl 3
- shardX/W42N25 RCL8：creep 7 {'eharvest': 2, 'efiller': 1, 'shauler': 1, 'legacyscientist': 1, 'lhauler': 1, 'xboostedUpgrader': 1}；storage 214,572，terminal 90,041；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 917）；rampart 36（均 46,084,699）；lab 10；spawn 忙 0/3；核心 9x8；storage→ctrl 4
- shardX/W42S38 RCL8：creep 7 {'legacyscientist': 1, 'eharvest': 2, 'lhauler': 1, 'efiller': 1, 'llinkUpgrader': 1, 'shauler': 1}；storage 119,490，terminal 90,571；link {'hub': 1, 'edge': 4}；塔 6（均 868）；rampart 31（均 25,241,634）；lab 10；spawn 忙 0/3；核心 10x8；storage→ctrl 4
- shardX/W42S57 RCL8：creep 8 {'efiller': 1, 'shauler': 1, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'lhauler': 2, 'eharvest': 2}；storage 221,825，terminal 95,349；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 947）；rampart 12（均 100,101,309）；lab 10；spawn 忙 0/3；核心 11x10；storage→ctrl 4
- shardX/W43S31 RCL8：creep 7 {'lhauler': 2, 'legacyscientist': 1, 'eharvest': 2, 'llinkUpgrader': 1, 'efiller': 1}；storage 84,851，terminal 89,697；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 930）；rampart 27（均 11,272,358）；lab 10；spawn 忙 0/3；核心 10x7；storage→ctrl 4
- shardX/W44N7 RCL8：creep 12 {'eharvest': 3, 'xboostedUpgrader': 2, 'shauler': 1, 'lhauler': 2, 'efiller': 1, 'legacyscientist': 1, 'mineralHarvest': 1, 'mineralDeliver': 1}；storage 230,155，terminal 76,900；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 893）；rampart 47（均 36,531,499）；lab 10；spawn 忙 2/3；核心 10x7；storage→ctrl 3
- shardX/W45S57 RCL8：creep 9 {'xboostedUpgrader': 1, 'efiller': 1, 'shauler': 1, 'lhauler': 2, 'eharvest': 2, 'legacyscientist': 1, 'ereserve': 1}；storage 220,929，terminal 111,509；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 867）；rampart 26（均 91,290,516）；lab 10；spawn 忙 1/3；核心 8x7；storage→ctrl 4
- shardX/W46S52 RCL8：creep 9 {'lhauler': 2, 'mineralHarvest': 1, 'eharvest': 2, 'mineralDeliver': 1, 'xboostedUpgrader': 1, 'legacyscientist': 1, 'efiller': 1}；storage 140,626，terminal 90,063；link {'source': 2, 'edge': 3, 'hub': 1}；塔 5（均 920）；rampart 16（均 48,174,064）；lab 10；spawn 忙 0/3；核心 9x7；storage→ctrl 3
- shardX/W48N45 RCL8：creep 7 {'lhauler': 2, 'efiller': 1, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'eharvest': 2}；storage 221,394，terminal 94,527；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 943）；rampart 49（均 33,920,143）；lab 10；spawn 忙 0/3；核心 11x8；storage→ctrl 2
- shardX/W48S12 RCL8：creep 7 {'shauler': 2, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'eharvest': 2, 'efiller': 1}；storage 225,959，terminal 83,971；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 898）；rampart 41（均 40,663,494）；lab 10；spawn 忙 0/3；核心 7x9；storage→ctrl 3
- shardX/W49S58 RCL8：creep 5 {'efiller': 1, 'eharvest': 2, 'legacyscientist': 1, 'xboostedUpgrader': 1}；storage 220,651，terminal 112,412；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 895）；rampart 18（均 100,101,390）；lab 10；spawn 忙 0/3；核心 7x10；storage→ctrl 4
- shardX/W51S47 RCL8：creep 7 {'xboostedUpgrader': 1, 'lhauler': 1, 'eharvest': 2, 'efiller': 1, 'shauler': 1, 'legacyscientist': 1}；storage 100,256，terminal 90,457；link {'source': 2, 'hub': 1, 'edge': 1}；塔 6（均 908）；rampart 17（均 52,939,028）；lab 8；spawn 忙 0/3；核心 8x10；storage→ctrl 3
- shardX/W52N52 RCL8：creep 8 {'lhauler': 2, 'efiller': 1, 'legacyscientist': 1, 'shauler': 1, 'eharvest': 2, 'xboostedUpgrader': 1}；storage 220,018，terminal 111,925；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 905）；rampart 17（均 100,101,907）；lab 10；spawn 忙 0/3；核心 8x12；storage→ctrl 2
- shardX/W52S25 RCL8：creep 7 {'lhauler': 2, 'eharvest': 2, 'efiller': 1, 'legacyscientist': 1, 'xboostedUpgrader': 1}；storage 220,011，terminal 96,841；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 950）；rampart 26（均 73,083,279）；lab 10；spawn 忙 0/3；核心 7x14；storage→ctrl 3
- shardX/W52S44 RCL8：creep 8 {'eharvest': 2, 'lhauler': 1, 'legacyscientist': 1, 'efiller': 1, 'shauler': 1, 'llinkUpgrader': 1, 'ereserve': 1}；storage 104,654，terminal 88,106；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 940）；rampart 16（均 57,253,076）；lab 10；spawn 忙 1/3；核心 9x8；storage→ctrl 4
- shardX/W53N34 RCL8：creep 9 {'xboostedUpgrader': 2, 'eharvest': 3, 'efiller': 1, 'legacyscientist': 1, 'lhauler': 2}；storage 220,369，terminal 100,233；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 897）；rampart 37（均 54,945,933）；lab 10；spawn 忙 1/3；核心 10x7；storage→ctrl 4
- shardX/W53N37 RCL8：creep 13 {'lhauler': 2, 'xboostedUpgrader': 1, 'eharvest': 3, 'shauler': 1, 'mineralHarvest': 1, 'eguardian': 2, 'efiller': 1, 'mineralDeliver': 1, 'legacyscientist': 1}；storage 295,926，terminal 91,878；link {'hub': 1, 'edge': 3, 'source': 1}；塔 6（均 588）；rampart 36（均 54,125,996）；lab 10；spawn 忙 3/3；核心 8x11；storage→ctrl 2
- shardX/W53S7 RCL8：creep 7 {'eharvest': 2, 'shauler': 1, 'xboostedUpgrader': 1, 'lhauler': 1, 'efiller': 1, 'legacyscientist': 1}；storage 195,162，terminal 90,718；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 972）；rampart 33（均 20,649,446）；lab 10；spawn 忙 0/3；核心 8x13；storage→ctrl 4
- shardX/W54N53 RCL8：creep 8 {'mineralHarvest': 1, 'mineralDeliver': 1, 'efiller': 1, 'eharvest': 2, 'xboostedUpgrader': 1, 'lhauler': 1, 'legacyscientist': 1}；storage 220,287，terminal 106,119；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 950）；rampart 16（均 100,099,095）；lab 10；spawn 忙 0/3；核心 9x12；storage→ctrl 3
- shardX/W54N58 RCL8：creep 8 {'legacyscientist': 2, 'lhauler': 2, 'shauler': 1, 'xboostedUpgrader': 1, 'eharvest': 1, 'efiller': 1}；storage 219,895，terminal 107,898；link {'hub': 1, 'edge': 4, 'source': 1}；塔 6（均 900）；rampart 17（均 100,101,319）；lab 10；spawn 忙 2/3；核心 10x8；storage→ctrl 4
- shardX/W57N19 RCL8：creep 9 {'lhauler': 1, 'eharvest': 2, 'efiller': 1, 'legacyscientist': 1, 'mineralHarvest': 1, 'xboostedUpgrader': 1, 'mineralDeliver': 1, 'shauler': 1}；storage 221,926，terminal 84,987；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 863）；rampart 17（均 100,101,599）；lab 10；spawn 忙 1/3；核心 12x8；storage→ctrl 4
- shardX/W58N13 RCL8：creep 10 {'efiller': 2, 'legacyscientist': 1, 'mineralHarvest': 1, 'eharvest': 3, 'mineralDeliver': 1, 'lhauler': 1, 'xboostedUpgrader': 1}；storage 221,402，terminal 122,192；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 892）；rampart 17（均 100,102,054）；lab 10；spawn 忙 2/3；核心 9x11；storage→ctrl 3
- shardX/W58N15 RCL8：creep 10 {'lhauler': 2, 'xboostedUpgrader': 1, 'mineralHarvest': 1, 'mineralDeliver': 1, 'legacyscientist': 1, 'eharvest': 3, 'efiller': 1}；storage 219,509，terminal 90,398；link {'hub': 1, 'edge': 3, 'source': 2}；塔 6（均 883）；rampart 35（均 52,824,151）；lab 10；spawn 忙 0/3；核心 12x9；storage→ctrl 4
- shardX/W58N58 RCL8：creep 9 {'xboostedUpgrader': 2, 'efiller': 1, 'lhauler': 2, 'legacyscientist': 1, 'shauler': 1, 'eharvest': 2}；storage 220,421，terminal 93,361；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 903）；rampart 15（均 100,101,854）；lab 10；spawn 忙 1/3；核心 11x7；storage→ctrl 2
- shardX/W58S45 RCL8：creep 5 {'legacyscientist': 1, 'eharvest': 2, 'xboostedUpgrader': 1, 'efiller': 1}；storage 156,576，terminal 90,062；link {'hub': 1, 'source': 2, 'edge': 2}；塔 6（均 920）；rampart 12（均 79,755,926）；lab 10；spawn 忙 0/3；核心 11x9；storage→ctrl 3
- shardX/W59S41 RCL8：creep 7 {'efiller': 1, 'eharvest': 2, 'llinkUpgrader': 1, 'shauler': 1, 'legacyscientist': 1, 'lhauler': 1}；storage 86,261，terminal 90,744；link {'hub': 1, 'edge': 2, 'source': 2}；塔 6（均 907）；rampart 15（均 69,850,648）；lab 10；spawn 忙 0/3；核心 10x11；storage→ctrl 4
- shardX/W59S48 RCL8：creep 11 {'shauler': 1, 'efiller': 1, 'eharvest': 3, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'lhauler': 3, 'ereserve': 1}；storage 296,248，terminal 90,615；link {'hub': 1, 'edge': 2, 'source': 3}；塔 6（均 952）；rampart 17（均 100,101,430）；lab 10；spawn 忙 1/3；核心 17x12；storage→ctrl 2
- shardX/W5N42 RCL8：creep 7 {'eharvest': 2, 'xboostedUpgrader': 1, 'eworkroad': 1, 'lhauler': 1, 'legacyscientist': 1, 'efiller': 1}；storage 102,954，terminal 90,468；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 933）；rampart 41（均 24,302,400）；lab 10；spawn 忙 0/3；核心 13x7；storage→ctrl 4
- shardX/W6S32 RCL8：creep 6 {'eharvest': 1, 'shauler': 1, 'lhauler': 1, 'efiller': 1, 'legacyscientist': 1, 'xboostedUpgrader': 1}；storage 226,718，terminal 83,921；link {'hub': 1, 'source': 1, 'edge': 4}；塔 6（均 913）；rampart 45（均 37,311,301）；lab 10；spawn 忙 0/3；核心 7x10；storage→ctrl 4
- shardX/W8S54 RCL8：creep 5 {'efiller': 1, 'xboostedUpgrader': 1, 'legacyscientist': 1, 'lhauler': 1, 'eharvest': 1}；storage 172,227，terminal 88,523；link {'hub': 1, 'source': 1, 'edge': 3}；塔 6（均 923）；rampart 17（均 46,493,572）；lab 10；spawn 忙 0/3；核心 10x9；storage→ctrl 3
- shardX/W8S59 RCL8：creep 8 {'eharvest': 2, 'lhauler': 3, 'legacyscientist': 1, 'llinkUpgrader': 1, 'efiller': 1}；storage 86,935，terminal 90,058；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 883）；rampart 8（均 91,741,376）；lab 10；spawn 忙 0/3；核心 8x8；storage→ctrl 4
- shardX/W9N43 RCL8：creep 8 {'efiller': 1, 'eharvest': 2, 'legacyscientist': 1, 'xboostedUpgrader': 1, 'mineralHarvest': 1, 'lhauler': 1, 'mineralDeliver': 1}；storage 220,166，terminal 106,556；link {'hub': 1, 'source': 2, 'edge': 3}；塔 5（均 882）；rampart 26（均 57,092,814）；lab 9；spawn 忙 0/3；核心 8x13；storage→ctrl 4
- shardX/W9S38 RCL8：creep 10 {'mineralHarvest': 2, 'eharvest': 2, 'efiller': 1, 'xboostedUpgrader': 1, 'lhauler': 2, 'mineralDeliver': 1, 'legacyscientist': 1}；storage 218,868，terminal 108,503；link {'hub': 1, 'source': 2, 'edge': 3}；塔 6（均 902）；rampart 44（均 52,640,142）；lab 10；spawn 忙 2/3；核心 8x9；storage→ctrl 3

## 布局示例
shard3/W15N28：

```
   01234567890123456789012345678901234567890123456789
 0 ####                                 #############
 1 ##'       .     .    ''                  '     ###
 2 #''''    ' . '' .  ##''                         ##
 3 #''''   '''.''#.  ####      ''                  ##
 4 #####'  '''.'##'.  ##     '      '    ##     '' ##
 5 ######'''   .'''.     ' ' ''''  '''   ##        ##
 6 #####''''    .'.  ''  '         ''''      #     ##
 7 #### '        .   ''  '         ''''    ' #      #
 8 ##'' '       .       '''       '''''    ''''     #
 9 #    '''     .   '## ''''     '''''  ##          #
10      '''####.''''###  ''''    ' ''  ####    '    #
11   L  L '#####. ' ###     '   '' '   ####'   '    #
12  .kkk  ##### .''####         '''' ' ####' ' '    #
13  kkkk######   . ####         ''''''''###' ' ' '''#
14  .kkk######   '. ###         '''#''''   '     '''#
15  kkkkC####      . ##   '     '''''''          ''##
16  .kkk'####O ' ' .  #   ''     ''  '           ' ##
17  .''.' ##L       .      ''##      ##          ' ##
18  .''..k$kbb ##  .         #     ''### ''   '''' '#
19 #.eeT..MK.b###e.   ''        '''''##  ''   ''''' #
20 #e.e.kT..bb###.e      ##     ''            '#''' #
21 #ee.e##kb.b e.ee   ######   ''             ###'' #
22 #e.e####bb.b.e'e' ######   '''              #'' ##
23 #e.ee###T.K.Teee'######     ''              ''' ##
24 #eekeNee.TeTke#######       '        ' '   '''  ##
25 #  e .e.eee.ee######             ' ' '      ''  ##
26 #  eee'e.eSe  #####'           '''   '''        ##
27 #   e eee.eee e ##''         ##'''              '#
28 #    e  ee. ee    ''  '      ##  '''  ''##    '  #
29 ##       '.##         '      ##'  ''    ### '    #
30 ##       .#####         #####     ''''  ### '''  #
31 ##    '''.######        #####      '''   ## '''' #
32 #   '''''. ######  '      ##        '        ''' #
33 #   '''  . '' ## k                               #
34 ##' ''   . '                    ''' '  ##  ''    #
35 ##'      .                  '' '''#        '''  ##
36 ##''   '.'       ''         '' ''''    '    '' ###
37 ##'     .### ''  ''     ' '#'    '     '    '''x##
38 ##  ''  .#######'' #    ' '####'''     ''    '' ##
39 #   ''  . ######''###  ''  #####''   ' ''     ''##
40 #   '   .  ####''' #   '''  '####   '''''     ' ##
41 #       k ##### ' ## '''    ''##    '''''   '''''#
42 #       .#####     ## '''  '''''     '''     ''''#
43 #       .###'      ###       ''' '    ''#      ''#
44 #       .           #@# ' '' ' ' ' ' ' ###       #
45 #       .           k###  ''       '  ####       #
46 #       .           '###  ''        #######      #
47 #       .'          ''#        '##  #######      #
48 ##      .                      #############    ##
49 ########                  ########################
```

shardX/W54N53：

```
   01234567890123456789012345678901234567890123456789
 0 ###############       #########     ##############
 1 #########  ###             ####         #####   ##
 2 ########                    ###          ###     #
 3 ########                    ###              '   #
 4 #########                  ####             ''' ##
 5 ###########                ####              '''##
 6 ############               #####              ' ##
 7 #############               #####                #
 8 #############               ######               #
 9 #############      #         #####               #
10 ###### ######     ##@kL      #####              ##
11 #####   #####     ####.      x####'             ##
12 ####     ###      ####e.Oe. k#####              ##
13          ### .   e####e.e.e.  ####               #
14         ###   .e.e###e.eke. .  ##             '   
15        ###    e.ee##e.e.e.e  .   .            '   
16       ###     .e.eee.e.eee.'  . . .               
17       ##     eeee.S.S.T##ee.'  .   .              
18      ###     ee.eT.k. #### '        ..            
19     ####      .e..k$M.C###ee   #######.           
20     #####    .eebb.Sk .## .   #########.          
21      #####  .  .b.b.BLT.e. .  ######### ......    
22       #### .   e.bbbbT.e.ee    ########.      .   
23       ####.    .b. TTreEe.ee   #######. '      .  
24        ##.    .   .e.Ereee.    ####### .'       . 
25      ....          .eee. ee.   ######## .      L  
26     .              .            #######.          
27  .L.            ###.            ######  .         
28  ..            #####.     ###  ####      . '      
29                #####.    #########        .''     
30 #              #### .    #########        '.      
31 #               ##  .     #########         .     
32 #                   .      #########      ## .    
33 #                   .       #########    #### .   
34 #                   .        ################.    
35 ##                  .            ##########@k     
36 ####                .           ''##########L     
37 #####               .             ##########      
38 ######             .''             ##########    #
39 ######             .          ##    #########    #
40 #####              .         ####    ##  #####  ##
41 ##                '.        #####         ########
42 #                 '.        ######         #######
43 #                  .         #####         #######
44 ##                 .          ###          #######
45 #####              .                       ###  ##
46 ######             . ###                    #    #
47 ########         L . ###                   #     #
48 ##########      k . #####                 ###   ##
49 ############      ################################
```

## 时间线（每轮一行）
- 20260912T013242Z：GCL 50,148,345,483，房 89，每房每 tick 采能 66.0，控制器占比 0.385，每部件能量 79.9
- 20260912T073516Z：GCL 50,168,742,171，房 89，每房每 tick 采能 66.2，控制器占比 0.346，每部件能量 80.4
- 20260912T133747Z：GCL 50,190,386,278，房 89，每房每 tick 采能 60.8，控制器占比 0.370，每部件能量 80.4
- 20260912T194023Z：GCL 50,211,993,651，房 89，每房每 tick 采能 66.3，控制器占比 0.376，每部件能量 81.8
- 20260913T014255Z：GCL 50,233,950,222，房 89，每房每 tick 采能 65.8，控制器占比 0.398，每部件能量 80.2
- 20260913T074530Z：GCL 50,255,491,271，房 89，每房每 tick 采能 59.5，控制器占比 0.383，每部件能量 80.6
- 20260913T154427Z：GCL 50,286,983,912，房 89，每房每 tick 采能 57.1，控制器占比 0.396，每部件能量 81.1
- 20260913T220715Z：GCL 50,311,558,602，房 89，每房每 tick 采能 62.5，控制器占比 0.393，每部件能量 82.2
- 20260914T040959Z：GCL 50,331,718,381，房 89，每房每 tick 采能 59.7，控制器占比 0.329，每部件能量 81.9
- 20260914T101230Z：GCL 50,350,564,731，房 89，每房每 tick 采能 61.0，控制器占比 0.328，每部件能量 81.2
- 20260916T072634Z：GCL 50,478,452,572，房 89，每房每 tick 采能 64.5，控制器占比 0.277，每部件能量 82.1
- 20260919T161747Z：GCL 50,767,956,119，房 89，每房每 tick 采能 56.0，控制器占比 0.408，每部件能量 82.0
- 20260919T222117Z：GCL 50,788,628,273，房 89，每房每 tick 采能 61.9，控制器占比 0.408，每部件能量 82.5
- 20260921T090854Z：GCL 50,912,373,935，房 89，每房每 tick 采能 64.6，控制器占比 0.418，每部件能量 80.0
- 20260921T151250Z：GCL 50,933,432,199，房 89，每房每 tick 采能 59.7，控制器占比 0.410，每部件能量 80.9
- 20260924T045734Z：GCL 51,178,983,618，房 89，每房每 tick 采能 59.8，控制器占比 0.425，每部件能量 80.5
- 20260925T081232Z：GCL 51,300,651,175，房 89，每房每 tick 采能 63.7，控制器占比 0.401，每部件能量 82.1
- 20260925T141536Z：GCL 51,326,565,847，房 89，每房每 tick 采能 66.3，控制器占比 0.430，每部件能量 81.0
- 20260928T112831Z：GCL 51,625,228,240，房 89，每房每 tick 采能 54.6，控制器占比 0.469，每部件能量 81.3
- 20260928T173108Z：GCL 51,648,795,223，房 89，每房每 tick 采能 56.7，控制器占比 0.409，每部件能量 81.9
- 20260928T233343Z：GCL 51,675,963,934，房 89，每房每 tick 采能 60.6，控制器占比 0.480，每部件能量 82.0
- 20260929T170641Z：GCL 51,760,756,904，房 89，每房每 tick 采能 61.9，控制器占比 0.425，每部件能量 81.4
- 20260929T230923Z：GCL 51,790,570,820，房 89，每房每 tick 采能 62.7，控制器占比 0.493，每部件能量 81.4
- 20260930T055937Z：GCL 51,823,199,131，房 89，每房每 tick 采能 64.8，控制器占比 0.455，每部件能量 83.0
- 20260930T140751Z：GCL 51,862,091,110，房 89，每房每 tick 采能 64.4，控制器占比 0.440，每部件能量 81.1
- 20260930T232817Z：GCL 51,906,303,471，房 89，每房每 tick 采能 57.5，控制器占比 0.462，每部件能量 81.5
- 20261001T071123Z：GCL 51,943,504,977，房 89，每房每 tick 采能 66.8，控制器占比 0.450，每部件能量 81.6
- 20261001T172244Z：GCL 51,990,673,251，房 89，每房每 tick 采能 60.7，控制器占比 0.427，每部件能量 79.9
- 20261001T232535Z：GCL 52,018,151,305，房 89，每房每 tick 采能 68.2，控制器占比 0.396，每部件能量 79.9
- 20261002T150146Z：GCL 52,091,098,704，房 89，每房每 tick 采能 64.4，控制器占比 0.437，每部件能量 81.7
- 20261002T210422Z：GCL 52,117,802,706，房 89，每房每 tick 采能 55.8，控制器占比 0.408，每部件能量 81.3
- 20261003T091034Z：GCL 52,171,096,203，房 89，每房每 tick 采能 65.0，控制器占比 0.409，每部件能量 82.6
- 20261003T211447Z：GCL 52,224,744,513，房 89，每房每 tick 采能 60.6，控制器占比 0.400，每部件能量 82.2
- 20261004T092115Z：GCL 52,281,451,962，房 89，每房每 tick 采能 57.1，控制器占比 0.500，每部件能量 82.2
- 20261004T212648Z：GCL 52,336,038,150，房 89，每房每 tick 采能 63.7，控制器占比 0.419，每部件能量 80.2
- 20261005T050516Z：GCL 52,371,758,019，房 89，每房每 tick 采能 59.9，控制器占比 0.468，每部件能量 80.7
- 20261005T131928Z：GCL 52,412,642,754，房 89，每房每 tick 采能 65.3，控制器占比 0.489，每部件能量 81.7
- 20261005T192313Z：GCL 52,440,314,707，房 89，每房每 tick 采能 58.3，控制器占比 0.483，每部件能量 80.8
- 20261006T012625Z：GCL 52,467,504,932，房 89，每房每 tick 采能 63.2，控制器占比 0.455，每部件能量 82.7
- 20261006T125043Z：GCL 52,516,665,489，房 89，每房每 tick 采能 62.0，控制器占比 0.417，每部件能量 81.6
- 20261006T185333Z：GCL 52,541,064,820，房 89，每房每 tick 采能 63.7，控制器占比 0.418，每部件能量 82.3
- 20261007T005620Z：GCL 52,566,335,878，房 89，每房每 tick 采能 57.9，控制器占比 0.438，每部件能量 80.1
- 20261007T075916Z：GCL 52,592,222,526，房 89，每房每 tick 采能 65.2，控制器占比 0.410，每部件能量 82.2
- 20261007T171906Z：GCL 52,628,834,611，房 89，每房每 tick 采能 65.7，控制器占比 0.406，每部件能量 80.8
- 20261007T232159Z：GCL 52,653,261,025，房 89，每房每 tick 采能 57.6，控制器占比 0.422，每部件能量 82.1
- 20261008T070055Z：GCL 52,683,907,064，房 89，每房每 tick 采能 64.4，控制器占比 0.361，每部件能量 80.0
- 20261008T180505Z：GCL 52,725,042,226，房 89，每房每 tick 采能 64.5，控制器占比 0.370，每部件能量 82.1
- 20261009T000748Z：GCL 52,748,263,306，房 89，每房每 tick 采能 64.5，控制器占比 0.412，每部件能量 82.3
- 20261009T061030Z：GCL 52,770,524,520，房 89，每房每 tick 采能 62.7，控制器占比 0.382，每部件能量 80.3
- 20261009T150604Z：GCL 52,805,214,433，房 89，每房每 tick 采能 62.5，控制器占比 0.404，每部件能量 82.4
- 20261011T030200Z：GCL 52,944,832,102，房 89，每房每 tick 采能 72.0，控制器占比 0.435，每部件能量 82.7
- 20261011T090431Z：GCL 52,968,245,410，房 89，每房每 tick 采能 57.9，控制器占比 0.491，每部件能量 81.3
- 20261011T150705Z：GCL 52,990,621,141，房 89，每房每 tick 采能 60.4，控制器占比 0.465，每部件能量 81.2
- 20261011T210936Z：GCL 53,014,200,727，房 89，每房每 tick 采能 59.8，控制器占比 0.475，每部件能量 82.0
- 20261012T031208Z：GCL 53,034,871,474，房 89，每房每 tick 采能 58.0，控制器占比 0.455，每部件能量 80.4
- 20261012T091440Z：GCL 53,057,087,208，房 89，每房每 tick 采能 58.7，控制器占比 0.434，每部件能量 81.5
- 20261012T183133Z：GCL 53,090,738,685，房 89，每房每 tick 采能 64.2，控制器占比 0.464，每部件能量 80.3
- 20261013T003413Z：GCL 53,114,371,929，房 89，每房每 tick 采能 59.1，控制器占比 0.474，每部件能量 81.6
- 20261013T063651Z：GCL 53,135,832,668，房 89，每房每 tick 采能 61.4，控制器占比 0.403，每部件能量 83.5
- 20261013T133956Z：GCL 53,160,312,912，房 89，每房每 tick 采能 60.5，控制器占比 0.432，每部件能量 80.1
