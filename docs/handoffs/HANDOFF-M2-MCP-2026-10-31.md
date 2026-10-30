# HANDOFF — M2 MCP 服务端（2026-10-31）

分支 `feat/m2-mcp`（基于 `main` = `bc99fd1`，已 rebase）｜负责人：恭喜（DSH / NAS）
目录边界：`src/mcp/**`、`test/mcp.test.js`、`docs/design/MCP-TOOLS.md`，外加 `src/server.js` **两行**挂载。

测试：**174 全绿**（主干 152 + 本任务新增 22），`npm run check` 通过。

---

## 1. 做了什么

围炉现在对外是一个 **streamable HTTP 的 MCP server**。任意 MCP 客户端（DSH、MCP Inspector、
脚本）用 Bearer 令牌连上来，就能列会话、读消息、发消息——读写的是和浏览器界面**同一份** SQLite 数据。

两个端点，两种用法：

| 用法 | 地址 | 起法 |
|---|---|---|
| 独立进程 | `http://<host>:8100/mcp` | `node src/mcp/server.js` |
| 挂在主服务上 | `http://<host>:8099/api/mcp` | 主服务启动即有 |

五个工具（`docs/design/MCP-TOOLS.md` 有完整签名与返回）：

| 工具 | 状态 |
|---|---|
| `campfire_list_chats` | ✅ 可用 |
| `campfire_read_messages` | ✅ 可用（cursor 追新 / before 翻旧 / nextCursor 续读） |
| `campfire_send_message` | ✅ 可用（走 `ctx.deliver`，与 UI 同一条投递管线） |
| `campfire_search_memory` | ⚠️ 空实现（M5 做向量检索），返回 `implemented: false` |
| `campfire_get_summary` | ⚠️ 原文摘取（模型摘要在 M5） |

鉴权两种令牌，不需要新建任何表：

- **主人口令**（`data/owner-key.txt` / `OWNER_PASSWORD`）→ 读写全部会话；
- **`<handle>:<成员密钥>`** → 该成员身份，只能碰自己所在的会话（含自己的私聊）。

---

## 2. 怎么验（照抄可跑）

```powershell
cd J:\campfire-m2
node --no-warnings --test          # 174 项
node --no-warnings scripts/check.js # 语法 + 敏感信息扫描
```

手工三步（curl 见 `docs/design/MCP-TOOLS.md` §7.2）：

1. `initialize` 拿 `Mcp-Session-Id`；
2. `tools/list` 应列出 5 个工具；
3. `tools/call` 调 `campfire_list_chats`，应看到「大厅」。

---

## 3. 三个关键决定（都有实测依据）

1. **`server/discover` 探测回 `-32601`，不返回 5xx/401。**
   DSH 用的 MCP SDK 2.2 连上来第一发不是 `initialize`，而是 `server/discover`。
   回 200 + JSON-RPC 错误它会回退到 `initialize`；回 5xx/401 会被判定成服务端坏了，连接直接失败。

2. **协议版本回 `2025-11-25`。**
   这是该 SDK 自己 offer 的版本，且它只接受自己列表里的版本号，回错直接握手失败。

3. **会话「可发但不强制」。**
   实测该客户端在会话失效（404）时**不会**重新握手，而是一直带着旧 id 重试，等于把连接打死。
   本服务端本来没有会话级状态，所以：签发 session 头，但缺失/失效一律按无状态放行。
   规范允许服务端不要求会话，这里选了更可靠的一边。

---

## 4. 边界与未做

- **没碰** `src/routes/`、`src/http/auth.js`；对 `src/server.js` 只加了两行（`import` + `registerMcpRoutes`），
  已用 `git diff` 确认就这两行。
- 附件上传未实现（传 `attachments` 回 `unsupported_type`）；
- `resources` / `prompts` 能力未声明，客户端调这些方法会拿到 `-32601`；
- 独立进程与主服务各开一个 SQLite 连接：WAL 允许并发读，高并发写建议 M3 收编成同进程挂载
  （`createMcpHandler` 已为此准备好，挂载就是复用它）。

---

## 5. 下一步（给如意）

1. **合入**：`feat/m2-mcp` 可直接合 `main`，无冲突面（新目录 + server.js 两行）；
2. **令牌演进**：M1 的 channel token（`cf_…`）落地后，只需改 `src/mcp/auth.js` 的 `identify()`，
   工具实现不用动——现在是「主人口令 / 成员密钥」两种，将来多认一种渠道令牌即可；
3. **挂载收编**：若想让 MCP 也走 `/v1` 的鉴权中间件，把 `registerMcpRoutes` 换成用 channel token 校验。

---

## 6. 文件清单

```
src/mcp/protocol.js   JSON-RPC 词汇表：版本、错误码、报文构造、版本协商
src/mcp/auth.js       Bearer 令牌 → 身份；会话归属判定
src/mcp/tools.js      五个工具的定义（schema）与实现
src/mcp/transport.js  HTTP 语义：请求体、鉴权、会话、分帧、JSON/SSE 回包
src/mcp/server.js     createMcpHandler（可挂载）/ createMcpServer（独立进程）/ CLI
src/mcp/mount.js      把 handler 注册到主服务 Router（/api/mcp）
src/mcp/index.js      对外入口
test/mcp.test.js      22 项：握手 / 会话 / 五工具 / 越权 / 协议错误 / 挂载 / DSH 端到端
docs/design/MCP-TOOLS.md  工具面契约与验收方式
src/server.js         +2 行（import + registerMcpRoutes）
```
