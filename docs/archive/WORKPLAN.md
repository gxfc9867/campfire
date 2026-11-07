# 分工与排期（2026-10-31）

> 依据：`docs/design/CONNECTION-DRAFT.md` v1.2。规则见 `docs/LAYOUT.md`。
> 原则：**一人一分支、一人一片目录、契约先行、验收可跑**。

---

## 1. 角色与归属

| 角色 | 在哪 | 负责 | 分支 |
|---|---|---|---|
| **如意**（WorkBuddy） | 本机 | M1 Channel API 主干、契约维护、代码评审、合并 | `feat/m1-channel-api` |
| **恭喜**（DSH，NAS） | NAS | M2 MCP server | `feat/m2-mcp` |
| **发财**（DSH，PC） | 本机 | M4 DSH channel 插件 | `feat/m4-dsh-plugin` |

**跨目录改动**（同时碰 `src/http/` 与 `src/routes/`）必须先跟如意说，避免冲突。

---

## 2. 任务清单

### M1 — Channel API v1（如意）

| 项 | 内容 |
|---|---|
| 分支 | `feat/m1-channel-api`（从 `main` 切） |
| 目录 | `src/migrations.js`、`src/channels.js`、`src/routes/channel-api.js`、`src/http/auth.js`、`src/server.js`、`test/channel-api.test.js` |
| 交付 | `GET /v1/meta`、`GET /v1/updates`、`POST /v1/messages`、`POST /v1/updates/ack`、`GET /v1/quota`；`user_version` 迁移框架；channel token（一 token = 一成员） |
| 验收 | `npm test` 全绿（含新增用例）；`curl` 能拉流、发消息、ack；老接口 84 项不回归 |
| 依赖 | 无 |

### M2 — MCP server（恭喜）

| 项 | 内容 |
|---|---|
| 分支 | `feat/m2-mcp` |
| 目录 | `src/mcp/**`、`test/mcp.test.js`、`docs/design/MCP-TOOLS.md` |
| 交付 | streamable HTTP MCP server；工具：`campfire_list_chats` / `campfire_read_messages` / `campfire_send_message` / `campfire_search_memory`（先返回空实现）/ `campfire_get_summary`；Bearer token 鉴权 |
| 验收 | MCP Inspector 或脚本能列出工具并成功调用前三个；`npm test` 新增用例绿 |
| 依赖 | 复用 `store`（只读为主）；**不改** `src/routes/`、`src/http/auth.js` |

### M4 — DSH channel 插件（发财）

| 项 | 内容 |
|---|---|
| 分支 | `feat/m4-dsh-plugin` |
| 目录 | `plugins/dsh-campfire/**`、`docs/design/DSH-PLUGIN.md` |
| 交付 | DSH 插件：`inject: ['agents','sessions']`；每个 `围炉群×成员` 绑定一个 session；`wakeup` 按 `reply/notify` 映射；注入内容带来源标记 |
| 验收 | 本地 DSH `0.2.1-rc.5` 装插件后：模拟一条围炉消息 → 产生/复用 session → 模型回复 → 回传 mock 围炉；`dsh plugin` 启停正常 |
| 依赖 | 围炉 API 未就绪时用 `docs/probes/` 里的 mock；**不改** `src/` |

---

## 3. 里程碑顺序

```
M1（如意）  ─┬─→ M2（恭喜，可并行，独立目录）
             └─→ M4（发财，可并行，独立目录）
                   ↓
              M3 WorkBuddy 桥（如意，依赖 M1 的 /v1/messages）
                   ↓
              M5 摘要/向量 → M6 conformance
```

M3 依赖 M1 的发送接口与 §11.4 的 token 通道；M4 不依赖 M1（用 mock）。

---

## 4. 协作规则（硬性）

1. **开工前**读：`docs/LAYOUT.md` → `docs/design/CONNECTION-DRAFT.md` → 本文件；
2. **一分支一任务**，合入前 rebase 到最新 `main`；
3. **不改别人的文件**：需要改就发消息，由归属人改；
4. **提交前**必须跑：`npm test` + `npm run check`，全绿才能提；
5. **每日收工**在 `docs/handoffs/` 追加一条进度（做了什么、卡在哪、下一步）；
6. **禁止提交**：token、会话内容、`~/.campfire/secrets/`、本地绝对路径配置；
7. **契约变更**（字段、端点、语义）先改 `docs/design/CONNECTION-DRAFT.md`，再改代码。

---

## 5. 仓库访问

| 角色 | 方式 |
|---|---|
| 如意 / 发财 | 本机 `J:\campfire`（同一份，直接开工） |
| 恭喜（NAS） | 需要能拉到仓库：① 推分支到 GitHub 后 clone；② 或把仓库同步到 NAS |

> 若只在本机协作，可不推 GitHub；NAS 参与则必须先推分支。

---

## 6. 第一周目标

1. M1 合并到 `main`，`/v1` 能跑通一条完整链路（发消息 → 拉流 → ack）；
2. M2 能在 MCP Inspector 里调通 3 个工具；
3. M4 插件能在本地 DSH 里收到一条 mock 围炉消息并回复；
4. 三方各写一份 `docs/handoffs/HANDOFF-<主题>-2026-11-XX.md`。
