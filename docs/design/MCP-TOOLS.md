# MCP 工具面（M2）

> 状态：已实现（2026-10-31）｜分支 `feat/m2-mcp`｜实现目录 `src/mcp/**`
> 上游依据：`docs/design/CONNECTION-DRAFT.md` §5「MCP 面」、`docs/WORKPLAN.md` M2

---

## 1. 一句话

围炉对外暴露一个 **streamable HTTP 的 MCP server**，客户端（DSH、MCP Inspector、任意脚本）
用 Bearer 令牌连上来，就能列会话、读消息、发消息——读写的是和浏览器界面**同一份** SQLite 数据。

MCP 只做请求-响应。**「群里有人说话 → agent 自动响应」不是 MCP 的活**，
那要靠 Channel API 的投递流（§4.2）或 agent 侧的常驻循环。

---

## 2. 端点与传输

| 用法 | 地址 | 起法 |
|---|---|---|
| 独立进程（默认） | `http://<host>:8100/mcp` | `node src/mcp/server.js` |
| 挂到主服务 | `http://<host>:8099/api/mcp` | 主服务启动即有（`src/server.js` 里一行 register） |

环境变量：`MCP_PORT`（默认 8100）、`MCP_HOST`（默认同 `HOST`）、`MCP_PATH`（默认 `/mcp`）。

方法语义（与 MCP 规范一致）：

| 方法 | 行为 |
|---|---|
| `POST` | 发 JSON-RPC 报文。请求回 JSON（或 SSE，见下）；纯通知回 `202` 空体 |
| `GET` | `405`，带 `Allow: POST, DELETE`——本服务端**不提供**服务端主动推送的 SSE 流 |
| `DELETE` | 结束会话，回 `204` |

响应格式选择：客户端 `Accept` **只**要 `text/event-stream` 时回 SSE（单条 `event: message` + `data:`）；
其余情况一律回 `application/json`——能回 JSON 就回 JSON，客户端解析路径最短。

为什么 `GET` 直接 405：围炉的「推送」是长轮询 + 唤醒，属于 Channel API。
挂一条永远不说话的 SSE 只会让客户端以为这里有推送能力，属于骗人。

---

## 3. 鉴权

统一 `Authorization: Bearer <token>`，**两种令牌**，都不需要新表：

| 令牌 | 形态 | 身份 | 能做什么 |
|---|---|---|---|
| 主人口令 | `data/owner-key.txt` 里那串（或 `OWNER_PASSWORD`） | `owner` | 读写**全部**会话 |
| 成员令牌 | `<handle>:<成员密钥>` | 该成员 | 只能读写**自己所在的**会话（含自己的私聊） |

- 成员密钥来自建成员时返回的 `key`（只在创建时明文返回一次，见 `POST /api/members`）；
- 没带令牌 / 令牌不对，一律 `401` + `-32001`，**不区分**两种情况——否则等于告诉攻击者「这把钥匙存在，只是配错了」；
- 越权访问（成员读别人的群）不是协议错误，而是 `result.isError = true` + `code: "forbidden"`，
  这样模型能看到「被拒了」并换策略，而不是整个会话崩掉。

> 契约演进：`CONNECTION-DRAFT.md` §3 设想的是「Channel → Member → Scope」三层令牌体系。
> M2 先把**身份**这一层落地（主人 / 某成员），Scope 用「会话归属」隐式表达；
> 等 M1 的 channel token 稳定后，`src/mcp/auth.js` 的 `identify()` 换成解析渠道令牌即可，
> 工具实现不用动。

---

## 4. 会话与协议版本

- 协议版本：支持 `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05`。
  客户端报的版本在列表里就原样回，否则回服务端最新的 `2025-11-25`；
  请求带 `MCP-Protocol-Version` 头但版本不认识 → `400`（`server/discover` 探测除外）。
- **会话是「可发但不强制」**：`initialize` 的响应会带 `Mcp-Session-Id`，客户端回带就记着，
  但**绝不因为「没带」或「已失效」拒请求**——没带就按无状态处理，失效就当作新请求放行。
  会话空闲 30 分钟回收，`DELETE /mcp` 幂等结束（回 `204`）。

  > 为什么不按规范回 400/404：实测 DSH 的 MCP SDK 2.2 在会话失效时**不会重新握手**，
  > 而是一直带着同一个失效 id 重试，等于把连接永久打死。本服务端本来就没有会话级状态，
  > 放行比严格可靠（规范也允许服务端不要求会话）。

- **`server/discover` 探测**：新版客户端（DSH 的 SDK 2.2）连上来第一发不是 `initialize`，
  而是 `server/discover`（带 `MCP-Protocol-Version: 2026-07-28`、`MCP-Method: server/discover`）。
  本服务端回 `200` + JSON-RPC 错误 `-32601`，客户端据此回退到 `initialize`——
  **不能回 5xx 或 401/403**，那会被判定成服务端坏了，连接直接失败。

---

## 5. 工具清单

五个工具，`inputSchema` 都是标准 JSON Schema。**M2 只做这五个**，其余（成员记忆、附件上传、
resources / prompts）留到后续里程碑。

### 5.1 `campfire_list_chats`

| 项 | 内容 |
|---|---|
| 入参 | 无（`{}`） |
| 出参 | `{ chats: [...], count }` |
| 每条会话 | `id`、`name`、`kind`（`group`/`dm`）、`peer`、`peerDisplay`、`members[]`、`messageCount`、`unread`、`last`（`seq/sender/text/createdAt` 或 `null`）、`updatedAt` |
| 权限 | 主人看全部；成员只看自己所在的会话 |
| 只读 | 是 |

`unread` 是**主人视角**（成员自己发的也算未读），对成员身份返回 `null`。

### 5.2 `campfire_read_messages`

| 项 | 内容 |
|---|---|
| 入参 | `chatId`（必填）、`cursor?`、`before?`、`limit?`（1–200，默认 50） |
| 出参 | `{ chatId, chatName, messages[], nextCursor, hasMore, direction }` |
| 方向 | 给 `cursor` → 追新（读该 seq **之后**）；给 `before` → 翻旧；都不给 → 最新一页 |
| 消息形状 | `id`、`chatId`、`seq`、`sender:{kind,handle,display}`、`type`、`text`、`replyTo`、`createdAt`、`edited`、`deleted` |
| 权限 | 同 §5.1 |

`nextCursor` 的语义随方向变：追新时是**本页最后一条**的 seq；翻旧时是**本页最旧一条**的 seq。

### 5.3 `campfire_send_message`

| 项 | 内容 |
|---|---|
| 入参 | `chatId`、`text`（必填）、`replyTo?`、`clientMsgId?`、`targets?` |
| 出参 | `{ message, deliveries: [{id, handle, status}] }` |
| 身份 | 主人发 → `sender.kind = "user"`；成员发 → `sender.kind = "member"` |
| 投递 | 走 `ctx.deliver`：落库 → 建投递任务 → 唤醒，和浏览器发消息**同一条管线** |
| 幂等 | 同一发送者 + 同一 `clientMsgId` 只落一条 |
| 约束 | `replyTo` 必须指向**同会话**的消息；`text` 上限 `MAX_TEXT`（默认 32000）；M2 不支持附件（传 `attachments` 回 `unsupported_type`） |

### 5.4 `campfire_search_memory`

| 项 | 内容 |
|---|---|
| 入参 | `query`（必填）、`chatId?`、`k?`（1–50，默认 10） |
| 出参 | `{ query, chatId, k, hits: [], implemented: false, note }` |
| 说明 | **M2 是空实现**，恒返回 0 条命中。返回里显式标 `implemented: false`，客户端可据此降级到 `read_messages` |

向量 + 关键词混合检索在 M5 落地（`CONNECTION-DRAFT.md` §4.6）。

### 5.5 `campfire_get_summary`

| 项 | 内容 |
|---|---|
| 入参 | `chatId`（必填）、`since?`、`limit?`（1–100，默认 30） |
| 出参 | `{ chatId, chatName, fromSeq, toSeq, messageCount, participants[], recent[], summary: null, implemented: false, note }` |
| 说明 | 当前是**原文摘取**：参与人按发言条数排序，`recent` 给最近 10 条的截断正文。模型生成的滚动摘要留到 M5 |

### 5.6 错误语义（重要）

| 情形 | 表现 |
|---|---|
| 工具名不存在 / 参数不是对象 | JSON-RPC 错误 `-32602`（报文有问题） |
| 方法不存在 | JSON-RPC 错误 `-32601` |
| 请求体不是 JSON | HTTP `400` + `-32700` |
| 会话缺失 / 过期 | **不报错**，按无状态放行（见 §4 的取舍说明） |
| 越权、会话不存在、内容过长、附件不支持 | `result.isError = true`，正文是 `{code, message}` |

区分标准：**报文错了**走 JSON-RPC 错误；**调用成功但业务失败**走 `isError`。

---

## 6. 与 Channel API 的边界

| 能力 | 归谁 |
|---|---|
| 读写消息、列会话、检索 | MCP（本文档） |
| 投递 / 唤醒 / 游标 / 幂等 ack | Channel API v1（`CONNECTION-DRAFT.md` §4） |
| 服务端主动推送 | 都不做。MCP 规范没有这个能力，围炉也不打算发明 |

两者共用同一份存储：MCP 发的消息，浏览器刷新就能看到；浏览器发的消息，MCP 立刻读得到。

---

## 7. 怎么验收

### 7.1 自动化

```bash
node --test test/mcp.test.js     # 20 项：握手 / 会话 / 五个工具 / 越权 / 协议错误 / 挂载
npm test                         # 全量 104 项
npm run check                    # 语法 + 敏感信息扫描
```

### 7.2 手工（curl 三步）

```bash
# 1) 握手，记下响应头里的 Mcp-Session-Id
curl -i -s http://127.0.0.1:8100/mcp \
  -H 'Authorization: Bearer <令牌>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2) 列工具
curl -s http://127.0.0.1:8100/mcp \
  -H 'Authorization: Bearer <令牌>' \
  -H 'Content-Type: application/json' \
  -H 'Mcp-Session-Id: <上一步的会话 id>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) 调工具
curl -s http://127.0.0.1:8100/mcp \
  -H 'Authorization: Bearer <令牌>' \
  -H 'Content-Type: application/json' \
  -H 'Mcp-Session-Id: <会话 id>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"campfire_list_chats","arguments":{}}}'
```

### 7.3 MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Transport 选 Streamable HTTP，URL 填 http://127.0.0.1:8100/mcp
# 在 Headers 里加 Authorization: Bearer <令牌>
```

### 7.4 与 DSH 客户端的兼容性（实测对齐）

DSH 用的是 `@modelcontextprotocol/client` 2.2（官方 TS SDK v2）。对着它的源码和抓包逐条对过：

| DSH 的行为 | 本服务端的应对 |
|---|---|
| 第一发是 `server/discover` 探测（版本头 `2026-07-28`） | 回 `200` + `-32601`，让它回退到 initialize；**不返回 5xx/401** |
| `initialize` 里 `protocolVersion: "2025-11-25"`、`capabilities: {}` | 原样回 `2025-11-25`，声明 `capabilities.tools` |
| `notifications/initialized` 是 **await 的**，状态码决定握手成败 | 回 `202`（规范要求）；客户端因此会再开一条 GET，我们的 GET 回 `405`，它静默忽略 |
| `Accept: application/json, text/event-stream` 两者都给 | 优先回 JSON（解析路径最短），只认 SSE 的客户端才走 SSE |
| 会校验响应的 `Content-Type` | 一律 `application/json; charset=utf-8` |
| 会话失效时**不会**重新握手，会带着旧 id 一直重试 | 会话改为「可发但不强制」，见 §4 |
| 工具名会被包成 `mcp__<serverName>__<name>`（限 64 字符） | 工具名 `campfire_*`，包完最长 39 字符 |
| `instructions` 会注入系统提示（上限 32 KB） | 一句话，远低于上限 |

验收脚本 `test/mcp.test.js` 里的「端到端：按 DSH 的真实握手顺序走一遍」就是照这个序列写的。



| 限制 | 原因 / 去处 |
|---|---|
| 只支持文本消息 | M2 范围；附件在 `CONNECTION-DRAFT.md` §4.7 |
| `search_memory` 空实现 | M5 |
| `get_summary` 只是原文摘取 | M5 |
| 不提供 resources / prompts | M2 只声明 `tools` 能力；客户端调这些方法会拿到 `-32601` |
| 没有 `outputSchema` | 结构化结果放在 `structuredContent` 里，文本版在 `content[0].text`，两条路都能读 |
| 独立进程与主服务各开一个 SQLite 连接 | WAL 允许并发读；高并发写需在 M3 收编成同进程挂载（`createMcpHandler` 已为此准备好） |
| 编辑/删除只有布尔标记 | `store` 目前只在 `meta` 里记标记，精确时间戳等 M1 的 update 日志 |

---

## 9. 代码地图

| 文件 | 职责 |
|---|---|
| `src/mcp/protocol.js` | JSON-RPC 词汇表：版本、错误码、报文构造、版本协商 |
| `src/mcp/auth.js` | Bearer 令牌 → 身份；会话归属判定 |
| `src/mcp/tools.js` | 五个工具的定义（schema）与实现 |
| `src/mcp/transport.js` | HTTP 语义：请求体、鉴权、会话、分帧、JSON/SSE 回包 |
| `src/mcp/server.js` | 组装 `createMcpHandler`（可挂载）/ `createMcpServer`（独立进程）/ CLI |
| `src/mcp/mount.js` | 把 handler 注册到主服务 Router（`/api/mcp`） |
| `src/mcp/index.js` | 对外入口 |

主服务侧只加了**两行**（`src/server.js`）：一行 import、一行 `registerMcpRoutes(router, ctx)`。
