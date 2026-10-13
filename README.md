# screeps-ai

[Screeps](https://screeps.com/)（MMO 编程游戏）的 JavaScript AI，外加 Python/Node 写的运维、外部大脑、私服验证与 soak/基准工具链。

- `src/` — 游戏内代码（grunt 扁平化后上传；`src/roles/*` 是各角色）
- `scripts/brain/` — 游戏外的"外部大脑"：情报、评分、外矿/占领/防御决策，经 Memory segment 90 下发
- `scripts/private_server/` — 本地私服验证（场景播种、生效断言、基线回归对比）
- `scripts/soak/` — 线上快照 → 私服长跑、RCL 基准与 A/B
- `test/` — mock 引擎冒烟测试（`node test/smoke.js`）与 Python 单测
- `docs/` — Screeps 官方文档摘录与本项目的设计/分析文档；`logs/optimizations.md` 是逐轮优化日志
- `vendor/wheels/` — 第三方"轮子"（作者 Scorpior：自动建筑布局 2.1.0、超级移动优化 1.0.3），版权归原作者

架构、常用命令与工作约定见 [`CLAUDE.md`](CLAUDE.md)。

## 快速开始

```bash
npm install
cp .env.example .env          # 填入自己的 SCREEPS_AUTH_TOKEN（私服另需 STEAM_API_KEY）
node test/smoke.js            # 冒烟测试
python3 -m unittest discover -s test -p '*_test.py'
npx grunt                     # 构建并上传（默认要求目标分支是 activeWorld）
```

运行数据（`data/`、`logs/` 下除优化日志以外的内容）、私服与凭证都不入库。
