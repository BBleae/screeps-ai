# 源 link → storage link 枢纽搬运

状态：已验证并部署（2026-09-09，版本 1788886961508；详见 ../../benchmarks/2026-09-09-hub-operator-ab.md）。补齐控制器缓冲及「谁把 store link 倒进 storage」和「hauler 还搬不搬这口源」。已接通仓库且有站位时，控制器缓冲从 400 提到至少一个发送批次（700），避免倒仓后升级者断粮；其它房间仍用原阈值。

## 1. 问题

RCL7 房有源 link + storage 旁的 store link 时：

- 矿工优先 `transfer` 进源 link（`roles/harvester.js`），源容器常年空；
- `links.js` 把源 link 发到 ctrl（保 `linkKeepAt`）再发到 store；
- **没有人从 store link 取走能量**。hauler 的取货池只有容器 / 掉落 / 富余 storage，不会 `withdraw` link；
- store link 800 满仓 → 源 link 发不出去 → 矿工改倒容器或停手 → 房内 hauler 空转（第 6/7 轮 A/B：W33S7 空闲 71–85%），同时链路堵死。

Kalgen 的升级者站在 storage 与 hub link 之间直接喝 link；我们升级者不一定贴着 store link（W34S7 storage 离控制器 5 格），所以不能把倒仓交给升级者。

## 2. 规则

判定 `storeLinkReady`：己方 storage 与己方 `plan.links.store` 切比雪夫距离 ≤ 1，且 RCL ≥ 7（与 `links.run` 何时往 store 发货一致）。

1. **某口源有己方源 link 且 `storeLinkReady`**：hauler / broker 不再取这口源的容器（容器 ≥ `sourceLinkOverflow` 1500 仍收，当溢出保险）。未 link 的源照旧搬。地面掉落仍回收，避免等待溢出阈值时衰减。仅认可 links.run 实际发送的已启用规划 link；没有合法固定站位时保留原运输。
2. **每口源都满足 (1)**（`hubHaulMode`）：hauler 只从 storage 取（不再要求 storage 富余），送到 spawn/ext/塔/工地。storage 取货权重 8。
3. **专职 `operator`**：`storeLinkReady` 且至少一口源已 link 时编制 1。站在同时邻接 storage 与 store link 的一格（避开升级者 storage 站位），只做 store link → storage。store 与 ctrl 是同一座 link 时留下 `linkKeepAt` 给升级者；否则倒空。
4. hauler 底线仍是 `linkFloorMinStore` 2（第 7 轮 A/B：底线 1 会放大零 hauler 窗口并触发 emergencyHarvest）。operator 不替代第 2 只 hauler，只让那 2 只从 storage 真正取到货。

## 3. 身体与孵化

- `8C1M`（450），`operatorMinCarry` 4；预算不够返回空身体等，不缩成 2C。
- 生存档、`vital`：链路堵死等于停收。`recovering` 不清零。TTL 预留与 hauler 同类。
- 不走 task broker。人物名「紫」。

## 4. 验证

- 冒烟：编制 0/1、站位、取/送/退役、link 源容器不进 collect、hub 模式下 storage 取货不看富余。
- 私服 links 场景：store link 播 700，邻格播一只 operator；生效断言看到 `Memory.rooms[房].operator.transferred > 0` 且 store link 低于播下值。
- 私服 A/B：同一快照分叉，看 link 能量均值、hauler 空闲比、storage、CP/收入。有改善才上线。

收尾：hub hauler 仅在有实际用能需求时从 storage 取货；需求临时消失则保留随身能量，避免取出又存回的循环。
