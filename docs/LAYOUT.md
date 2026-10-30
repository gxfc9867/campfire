# 工程结构与协作约定

> 本文件是目录与协作的唯一准则。新增目录、移动文件、交接工作前先读这里。
> 最后更新：2026-10-30

---

## 1. 目录职责

| 路径 | 放什么 | 不放什么 |
|---|---|---|
| `src/` | 服务端运行代码 | 一次性脚本、探针、文档 |
| `src/routes/` | HTTP 路由（按 API 面拆文件） | 业务逻辑（放同层模块） |
| `src/bridges/` | 外部 agent 桥（每个 agent 一个子目录） | 通用能力（放 `src/` 顶层） |
| `src/drivers/` | 成员驱动（llm / pull / cli / webhook） | 具体 agent 的私有协议 |
| `public/` | 前端（原生 ESM，无构建） | 依赖包 |
| `sidecar/` | 宿主机客户端与自检 | 服务端逻辑 |
| `adapters/` | **历史适配器**（DSH / cbc-gateway），M3 后删除 | 新代码 |
| `scripts/` | 开发脚本（生成 / 检查 / 冒烟） | 运行期依赖 |
| `test/` | 自动化测试，`npm test` 全绿是合入前提 | 手工验证记录 |
| `docs/design/` | 方案、契约、决策记录 | 进度流水 |
| `docs/handoffs/` | 交接文档、进度快照（按日期命名） | 长期方案（放 design） |
| `docs/probes/` | 逆向探针脚本（可复现、**不含凭据**） | 生产代码 |
| `docs/*.md`（根层） | 面向使用者的架构 / 接口 / 运维 / 成员说明 | 内部决策 |

`Dockerfile`、`docker-compose.yml` 保持仓库根（部署工具链惯例）。

---

## 2. 命名规范

| 类型 | 规则 | 例 |
|---|---|---|
| 方案 / 契约 | `docs/design/<主题>-DRAFT.md`，带版本号 | `CONNECTION-DRAFT.md` |
| 交接 | `docs/handoffs/HANDOFF-<主题>-YYYY-MM-DD.md` | `HANDOFF-ACP-2026-10-30.md` |
| 进度 | `docs/handoffs/PROGRESS-YYYY-MM-DD.md` | |
| 探针 | `docs/probes/<对象>-<用途>.cjs` | `wbipc-kinds.cjs` |
| 路由文件 | `src/routes/<api 面>.js` | `channel-api.js` |
| 桥 | `src/bridges/<agent>/` | `src/bridges/workbuddy/` |

文档内引用路径必须写全（`docs/design/...`），不要写相对路径。

---

## 3. 分支与提交

- `main` 永远可运行、测试全绿；
- 一个任务一个分支：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`；
- 提交信息：`<type>(<scope>): <一句话>`，正文写「为什么」；
- 合入前必须：`npm test` 全绿 + `npm run check` 通过。

---

## 4. 多 agent 协作（DSH / 其他 agent）

多个 agent 同时开发时按下面执行，否则必然互相踩：

1. **一人一分支**，不共用工作区；需要并行改同一文件时，先拆任务，不要抢；
2. **契约先行**：跨模块的接口先落到 `docs/design/`，代码按契约实现；
3. **动手前读**：`docs/design/CONNECTION-DRAFT.md` + 最新 `docs/handoffs/`；
4. **验收标准写进任务**：能跑的命令、期望输出，不接受「看起来对了」；
5. **不提交**：token、会话内容、`~/.campfire/secrets` 下任何东西、本地路径相关的临时文件；
6. **探针脚本**可以提交，但必须参数化、默认不指向真实账号。

---

## 5. 敏感数据

| 数据 | 位置 | 规则 |
|---|---|---|
| WorkBuddy Bearer token | `~/.campfire/secrets/workbuddy-bearer.txt` | 仓库外，ACL 仅本人；28 天轮换 |
| Offline token | 同目录 `workbuddy-offline.txt` | 仅用于换新 bearer（待验证） |
| 会话备份 | `~/.campfire/backups/` | 仓库外 |
| 成员密钥 | `data/members.json`（运行时） | 已在 `.gitignore` |

仓库内出现真实 token 视为事故，需立即轮换并清理历史。

---

## 6. 当前阶段

| 里程碑 | 状态 |
|---|---|
| 方案定稿（v1.2） | ✅ |
| M1 Channel API v1 | 未开始 |
| M2 MCP server | 未开始 |
| M3 WorkBuddy 桥（ACP + token 注入 + SQLite 同步） | 未开始 |
| M4 DSH channel 插件 | 未开始（可并行） |
| M5 摘要 / 向量 | 未开始 |
| M6 conformance 套件 | 未开始 |
