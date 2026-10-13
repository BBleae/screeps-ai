# 外部大脑定时复核（给 Claude 会话的任务说明）

你在 `.` 里，负责复核外部大脑的确定性规划，必要时用 locks 改写决定。姿态：防御优先，只打 NPC，不主动攻击玩家。

每次复核做这些事，结束时用简体中文给出不超过 10 行的结论：

1. 读 `data/brain/brief.md` 与 `data/brain/state.json`（最近一轮的情报、评分、指令、写入结果）。若文件超过 20 分钟没更新，跑 `python3 scripts/brain/run.py --homes W33S7 --radius 2 --prefer-claim W34S7 --write` 再读。
2. 核对游戏内回执：`python3 scripts/probe.py brain` 应看到 `ack.issuedAt` 等于 `state.json` 里 `directive.issuedAt`。不一致说明 bot 没有消费到指令，先查 `Memory.errors`。
3. 评估威胁：周边两圈内是否出现新的武装 creep、InvaderCore、别人的预定或新占领；强邻（RCL≥7）是否向我们靠近。把需要人工关注的写进结论。
4. 评估规划：外矿分配和占领目标是否合理（源数、路程、与强邻的距离、残墙）。如需改写，写 `data/brain/locks.json`，键为 `<母房>.<字段>`（`remotes` / `claim`），带 `until`（毫秒时间戳）与 `by: "agent"`，然后再跑一轮 `--write` 让它生效。不要直接改 Memory。
5. 看 `python3 scripts/monitor.py` 的输出：升级速率、能量、errors。经济异常不在复核范围内改代码，只记录到结论。
6. 不做的事：不改 `src/`，不部署，不 destroy 任何建筑，不发起攻击。需要代码改动时在结论里说明并停止。
