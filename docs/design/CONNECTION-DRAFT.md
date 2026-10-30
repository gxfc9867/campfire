# 围炉通用接入草案 v1.3（Channel API + MCP）

> 状态：**M1 / M2 / M3 / M4 / M5 已落地**，178 项测试全绿；剩 M6 收尾与真机验收。
> v1.3 变更：§4.8 错误形状改回扁平（与实现一致，并说明理由）；§8 一致性测试已落地
> （`scripts/conformance.mjs` 24 条，真围炉与 strict mock 均 24/24）；MCP 记忆工具接通 M5。
> v1.2 变更：新增 §7.4（桥是围炉内部模块）、§8.5（合规与免责）、DB 迁移要求。
> v1.1 变更：Q21 改为 token 注入；新增 Q24–Q26。
> v0.8 变更：新增 §12 逆向评估；Q9 修正；Q20 完成真实会话读写验证。

---

## 0. 一句话目标

围炉不做「给每个 agent 写一个适配器」，而是成为**任何 agent 都能接入的群聊内核**：

- 对 agent：**标准接入面**（Channel API）+ **通用工具面**（MCP）；
- 对消息：**记忆主机**（原文 + 摘要 + 向量），agent 只负责出脑子；
- 对渠道：有原生渠道机制的用原生（DSH 插件），没有的走 MCP，再没有的用适配器兜底。

---

## 1. 术语与绑定关系

| 术语 | 含义 |
|---|---|
| **Channel** | 外部接入方在围炉的注册身份，持有 secret 与 scopes |
| **Member** | 群里的参与者（人 / 系统 / agent） |
| **Binding** | `member × chat → 外部会话引用` |
| **External Session** | agent 侧的会话实体（DSH session / WorkBuddy task） |
| **Update** | 可投递事件（消息创建/编辑/删除、成员变动、投递丢弃），带 `updateId` |
| **Cursor** | 成员在某个 chat 上的读取位置 |

**绑定模型（定稿）**：

```jsonc
Binding {
  memberHandle: "ruyi",
  chatId: "*",                 // "*" = 该成员所有会话共用；具体 chatId = 单独隔离
  externalSessionRef: "…",     // agent 侧会话标识，可为 null
  wakeupPolicy: "reply|notify|none",
  invalidAt: null
}
```

- 默认 `chatId = "*"` → **成员:会话 = 1:1**（一个成员一个会话，记性最好）；
- 需要隔离时给某个群单独建 binding → 自动变 1:N；
- 表结构一次到位，将来切换不用改数据。

**用户可见的说明文案**：

> 这个成员在 agent 里对应几个会话？
> - 默认：**一个**（推荐）—— 不管在几个群，agent 都用同一个会话。
> - 进阶：**每个群一个** —— 群之间彻底隔离。
> ⚠️ 默认模式下，A 群聊的内容会出现在 B 群的回复里（同一个脑子）。

---

## 2. 消息模型（全模型）

```jsonc
{
  "id": "msg_01J...",
  "chatId": "main",
  "seq": 128,                    // chat 内单调递增，用作游标与幂等键
  "sender": { "kind": "user|member|system", "handle": "ruyi", "display": "如意" },
  "type": "text|markdown|image|file|audio|video|system",
  "text": "……",
  "attachments": [
    { "id": "att_01J...", "name": "a.png", "mime": "image/png",
      "size": 18342, "sha256": "…", "url": "https://…/s/…", "thumbUrl": "https://…/t/…",
      "width": 800, "height": 600 }
  ],
  "replyTo": "msg_01J...",
  "mentions": ["ruyi", "facai"],
  "createdAt": 1793191265238,
  "editedAt": null,
  "deletedAt": null
}
```

- 类型必须一次定全，否则后续加类型是破坏性变更；
- 附件元数据在消息里，二进制在独立 blob 存储，URL 带签名且可过期；
- 编辑/删除产生独立 update，不静默改历史。

---

## 3. 鉴权模型

三层，统一 `Authorization: Bearer <token>`：

| 层 | 内容 | 用途 |
|---|---|---|
| Channel | `channelId` + `secretHash`（可轮换） | 识别接入方 |
| Member | token 内嵌 `memberHandle` | 以谁的身份说话 |
| Scope | `read:chat:<id>` / `write:chat:<id>` / `memory:read` / `memory:write` / `admin` | 最小权限 |

---

## 4. Channel API v1（HTTP）

前缀 `/v1`，JSON，响应头 `X-Campfire-Api-Version: 1`。

### 4.1 能力协商

```
GET /v1/meta
→ { apiVersion, serverTime, capabilities: {
      messageTypes, cursor: "seq", wakeup: ["none","notify","reply"],
      coalesce: { windowMs, maxItems }, attachments: { maxSize, signedUrlTtl },
      editDelete: true, search: { vector, keyword } } }
```

### 4.2 拉取更新（唯一对外新面）

```
GET /v1/updates?chat=main&cursor=120&wait=25&limit=100
→ { updates: [
      { updateId: "main:128",
        type: "message.created|message.edited|message.deleted|chat.updated|member.joined|member.left|delivery.dropped",
        chatId, seq, message, wakeup: "reply|notify|none", replyRequired: true }
    ],
    nextCursor, hasMore, serverTime }
```

- **at-least-once**：同一 `updateId` 可能重复，客户端按 `updateId` 去重（保留 7 天）；
- `cursor` 只管投递；补读历史走 §4.4；
- `wait` 为长轮询秒数，0 表示立即返回；
- 游标过期返回 `cursor_expired`，客户端改走 §4.4 + 摘要补齐。

### 4.3 发送消息

```
POST /v1/messages
{ chatId, text, type, replyTo?, attachments?, clientMsgId }   // clientMsgId 幂等
→ 201 { message }
```

### 4.4 补读历史（不推进投递游标）

```
GET /v1/chats/{chatId}/messages?before=128&after=100&limit=50
```

### 4.5 确认、状态与配额

```
POST /v1/updates/ack   { chat, cursor }
POST /v1/state         { status }
GET  /v1/quota         → { pending, oldestPendingAt, dropped: {count, oldestAt}, limits }
```

### 4.6 记忆与检索

```
GET  /v1/members/{handle}/memory          → { digest, updatedAt }
PUT  /v1/members/{handle}/memory          { digest }
GET  /v1/chats/{chatId}/summary           → { summary, coversUpToSeq, updatedAt }
POST /v1/search                           { query, chatId?, k? } → { hits[] }
```

### 4.7 媒体

```
POST /v1/media   (multipart) → { id, sha256, url, thumbUrl, expiresAt }
GET  /v1/media/{id}
```

### 4.8 错误码

`unauthorized / forbidden / not_found / conflict / rate_limited / payload_too_large / unsupported_type / cursor_expired / binding_invalid / upstream_error`

**定稿形状（v1.3 修正）**：

```json
{ "error": "游标已过期，请从 0 重新拉取", "code": "cursor_expired" }
```

- `code` 是机器可读的稳定枚举，客户端按它分支；
- `error` 是给人看的中文描述，可直接展示；
- **为什么不是嵌套**：围炉现有全部端点（含前端 `public/js/api.js`）都用扁平形状，改成
  `{error:{code,message}}` 要动 20 多处实现和全部老测试，收益只是「看起来更规范」。
  机器码在顶层一样能分支，不需要多一层。
- 客户端**兼容两种**读法（围炉的 DSH 插件已这么做）：优先结构化 `error.code`，退回顶层 `code`。
  这样将来真要换形状，不会把 `cursor_expired` 这类关键码读丢（丢了就没法自动重拉）。

### 4.9 兼容层（旧接口的去向）

- 现有 `/api/agent/inbox|reply|ack`（task 模型：取走即认领、必须签收）**保留为兼容层**；
- 底层只存一份消息；task 接口是「游标之后未 ack 的 update」的一层投影，不维护两套存储；
- **新接入方一律走 §4.2 游标流**。

---

## 5. MCP 面（与 Channel API 同一份数据）

围炉提供 MCP server（streamable HTTP），任意 MCP 客户端可接。

### 5.1 Tools

| 工具 | 签名 | 说明 |
|---|---|---|
| `campfire_list_chats` | `()` | 会话列表（含未读、最后一条） |
| `campfire_read_messages` | `({chatId, cursor?, limit?})` | 读消息，返回 nextCursor |
| `campfire_send_message` | `({chatId, text, replyTo?, attachments?})` | 发言，受 scope 限制 |
| `campfire_search_memory` | `({query, chatId?, k?})` | 向量 + 关键词混合检索 |
| `campfire_get_summary` | `({chatId, since?})` | 滚动摘要快照 |
| `campfire_get_member_memory` | `({handle?})` | 成员记忆 |
| `campfire_list_members` | `({chatId})` | 成员与人设 |
| `campfire_upload_attachment` | `({path\|url, name?})` | 上传附件 |

### 5.2 Resources

`campfire://chats`、`campfire://chat/{chatId}/messages`、`campfire://member/{handle}/memory`、`campfire://chat/{chatId}/summary`

### 5.3 边界

- MCP 是**请求-响应**模型，**没有服务端主动唤醒 agent 的标准能力**；
- 所以「群里有人说话 → agent 自动响应」必须配合 agent 侧的常驻循环或定时任务；
- MCP 负责「读写检索」，Channel API 负责「投递唤醒」，共用同一份数据。

---

## 6. 语义细则

### 6.1 唤醒级别（@ 只是触发，不是记忆边界）

| 级别 | 含义 | 场景 |
|---|---|---|
| `reply` | 必须回复 | 被 @ |
| `notify` | 注入上下文，不要求回复 | 群里其他人说话（**全量，暂不设成本上限**） |
| `none` | 只入库，不注入 | 系统消息、噪音 |

- 服务端给建议，agent 按 `capabilities.wakeup` 决定实际行为；
- DSH 映射：`reply → wakeup:true + steer/followup`；`notify → wakeup:false`（原生「注入不唤醒」）；
- 合并窗口默认 `{ windowMs: 30000, maxItems: 20 }`。

### 6.2 背压与丢弃（定稿）

- per-member 有界队列（默认 1000）；
- 队列满 → **丢最旧**，`reply` 优先保留，**群聊永不因成员离线而阻塞**；
- 丢弃留痕：`quota.dropped` 计数 + 产生 `delivery.dropped` update（让 agent 知道自己漏了）；
- 恢复补投：摘要 + 最近 N 条原文，并明确告知「中间丢了 N 条」。

### 6.3 离线补投

- 不逐条灌；恢复给「滚动摘要 + 最近 N 条原文」（默认 20）；
- 游标过期 → `cursor_expired` → 走摘要路径。

### 6.4 不可信上下文

- 投递内容带来源标记（`[来自围炉/群 main/成员 恭喜]`）；
- 协议要求 agent 侧把消息当**数据**不当指令；DSH 已有同类机制。

### 6.5 会话生命周期

- binding 可失效（会话被删、cwd 变更）→ 标 `binding_invalid`，按策略重建或降级为「只入库」并在 UI 提示。

### 6.6 多 agent 并发

- 一条消息可触发多个成员，各自独立处理；回复按落库顺序呈现；
- 未 @ 消息的上下文注入由 `wakeup` 级别决定，不是全有或全无。

### 6.7 时间基准

- 所有时间以**服务端**为准；客户端时钟偏移不影响正确性（游标用 `seq`，不用时间戳）。

### 6.8 提示词归属（Q9 结案）

- **围炉不拼提示词**：服务端只提供原始消息、可选摘要、可选成员记忆，**不生成「人设+记忆+上下文」的合成提示词**；
- 原 `/api/agent/prompt` 端点**下线**，现有适配器（sidecar / DSH / cbc-gateway）**删除**拼装逻辑；
- 理由：围炉只是信息传递；上下文由 agent 自己的会话承担（成员=会话的直接好处），人设也归 agent 侧；
- 影响：**工作量减少**——适配器只做「收消息 → 投给会话 → 把回复发回来」，不碰提示词工程。

---

## 7. 接入映射

| Agent | 接入面 | 会话绑定 | 唤醒 | 备注 |
|---|---|---|---|---|
| **DSH（恭喜/发财）** | **自研 channel 插件**（不依赖社区 message-hub） | ✅ 每 `chat×member` 一个 session | ✅ `wakeup:true/false` | 会话在 DSH UI 可见 |
| **WorkBuddy（如意）** | **内存 token 注入 + HTTP-ACP**（`CODEBUDDY_AUTH_TOKEN` → `/api/v1/acp`）+ **MCP 工具** | ✅ `session/load` 用桌面会话 ID 附着（写真实 jsonl，UI 可见） | ✅ `session/prompt` 返回 `end_turn`；不触发 `auth-owner-change`（实测） | token 1319 字符 / 28 天（`exp 2026-11-27`）；需管理员权限抓取（Q24） |
| **第三方 bot** | Channel API / 未来 Bot API 兼容层 | 视 agent 能力 | 长轮询 / webhook | |
| **无渠道能力者** | 现有 pull 适配器（兜底） | 适配器自管 | 长轮询 | 保留，不主推 |

### 7.1 寻址能力矩阵（已核实）

| 能力 | DSH | WorkBuddy |
|---|---|---|
| 会话 ID | ✅ | ✅ 明文 UUID（本地 jsonl） |
| 列会话 | ✅ `session/list` | ✅ `GET /api/v1/sessions?cwd=*` |
| 建会话 | ✅ `session/create` | ✅ `--session-id` / gateway jobs |
| **按 ID 投递** | ✅ `session/prompt` | ✅ `POST /api/v1/sessions/{id}/reply`（限活会话） |
| 继承上下文 | ✅ 会话本身 | ✅ `POST /api/v1/jobs {sourceSessionId}` |
| 续跑 | ✅ | ✅ `jobs/resumable`、`jobs/resume` |
| 桌面 UI 可见 | ✅ | ❌（网关与桌面两套库） |

> 分水岭不是「有没有 webUI」，也不是「有没有 ID」，而是**有没有把寻址能力开放出来**。

### 7.2 部署支持矩阵（README 需写清）
| 形态 | 支持级别 |
|---|---|
| Docker（NAS / 服务器 / k8s） | ✅ 生产支持 |
| Linux（含 WSL2） | ✅ 生产支持 |
| Windows 原生 | ⚠️ 仅开发调试，不承诺 |
| macOS | ⚠️ 理论可用，未测试 |

网络形态：**默认只做出站**（agent 主动连围炉）；webhook 可选且默认关闭；公网部署必须 TLS；WSL2 注意 IP 会变，docker 访问宿主用 `host.docker.internal`。

### 7.3 成员接入默认流程（手填会话引用）

第一版不做「自动拉起会话」，改为**用户自建、围炉定位**：

1. 用户在 agent 里自己建一个会话（DSH session / WorkBuddy 任务），拿到它的标识（ID / URL）；
2. 在围炉「新建成员」表单里粘贴该标识，作为 `externalSessionRef`；
3. 围炉保存后**立即探测可达性**（按 agent 类型 ping），失败给出明确错误，不许静默；
4. 单聊 / 群聊可各自填不同的会话引用（或留空共用成员默认会话）。

好处：会话天然在 agent UI 可见（Q19）、无「拉起」依赖、信任关系明确。
代价：多一步人工操作；会话被删后 binding 失效，需重新探测 + 提示。
后续进阶：Q18 解决后，加「一键创建会话」替代手填。

**适用性（Q20 实测后）**：

| Agent | 手填成立？ | 说明 |
|---|---|---|
| DSH | ✅ | sessionId 就是会话主键，`session/prompt` 可按 ID 投递 |
| WorkBuddy | ✅ **成立（ACP）** | `HTTP-ACP` 的 `session/load` 用桌面会话 ID 附着，`session/prompt` 写入真实 jsonl（实测 7→18 行，用户 App 内可见两轮回复）。**前提**：用户建的是普通会话（非 automation thread）；写入后需同步 SQLite `sessions` 表（Q22） |

配套交互（已确认）：

- **普通会话 vs automation thread**：`workbuddy.db.sessions.is_background_automation` 为空 = 用户手建的普通会话（可作锚点）；`= 1` = 自动化每次运行生成的一次性会话（`thread_id` 形如 `<automationId>:<时间戳>`，不可作锚点）。

- **必须有「测试连接」**：保存 `externalSessionRef` 时立即探测可达性，失败明确报错；
- **不做失效感知轮询**：会话被删由用户自己知道，链路断了就报错（`binding_invalid`），不做后台重探；
- **`externalSessionRef` 脱敏存储与展示**（同现有成员密钥处理方式）。

### 7.4 桥的归属（定稿）

- 「桥」不是独立项目，是**围炉的内部模块**：`src/bridges/workbuddy/`（HTTP-ACP 客户端 + token 注入 + SQLite 列表同步）。
- 旧的 `adapters/cbc-gateway/` 在 M3 完成后**删除**，不保留双实现。
- 对外只有围炉一个产品，README 不单列"桥"。

---

## 8. 版本与一致性

- URL 版本 `/v1`；字段只增不删，弃用标 `deprecated` 并保留两个 minor；
- **一致性测试（已落地，v1.3）**：`scripts/conformance.mjs`，24 条黑盒用例，覆盖
  meta / auth / stream / send / scope / long-poll / ack / quota。零依赖，对任意实现可跑：

  ```bash
  node scripts/conformance.mjs --base http://host:8099 --owner <主人口令> --member <handle>
  node scripts/conformance.mjs --base http://host:8099 --token <渠道令牌> --chat main
  ```

  给 `--owner` 时自建临时渠道、跑完删测试消息并吊销；输出 JSON 报告，退出码 0/1/2。
  **已通过**：真围炉 24/24、mock 围炉（`--strict`）24/24。
- **mock 的定位**：`plugins/dsh-campfire/mock-campfire.cjs` 默认是宽松测试替身（方便单测），
  加 `--strict` 后按本契约回包，可当「最小参考实现」看。
- **参考客户端**：`plugins/dsh-campfire/src/campfire-client.js`（174 行，零依赖），
  接第三家时可以直接抄。
- **数据库迁移（已落地）**：`src/migrations.js` 用 `PRAGMA user_version` + 顺序迁移，
  v1 的 `channels / channel_cursors` 表和 M5 的 `chat_summaries / message_embeddings` 都走它。

---

## 8.5 合规与免责（定稿）

- WorkBuddy 通道依赖「从本机进程内存读取登录凭据」，属**用户自主操作**，围炉不代为执行、不分发凭据；
- 产品中明确声明：该能力仅用于**用户本人账号**的自建接入，风险（账号安全、协议条款、版本失效）由用户自行承担；
- 仓库与文档**不得包含任何真实 token / 会话内容**；示例一律用占位符；
- 免责声明放在 README「高级用法」章节，接入页首次启用时二次确认。

---

## 9. 未决问题

**已结案**：

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 成员=会话 1:1 还是 1:N | 1:1 默认，`chatId="*"`，可 per-chat 覆盖 |
| Q2 | 游标流 vs task 双模 | 对外只做游标流，task 保留为兼容壳 |
| Q3 | 未 @ 消息注入 + 成本 | 全量 notify，暂不设成本上限，只定合并窗口 |
| Q4 | 摘要由谁生成 | 向量模型只能编码不能生成 → 摘要用外接生成式 LLM（OpenAI 兼容），embedding 单独配置 |
| Q5 | 附件 URL | 签名 URL，默认 1 小时有效 |
| Q6 | 多租户 | ✅ **不做**，单家主；数据结构预留 `ownerId`，以后再说 |
| Q7 | MCP 鉴权 | ✅ **静态密钥**（token），OAuth 以后再说 |
| Q8 | 编辑/删除同步 | 同步，作为独立 update（best-effort） |
| Q9 | 服务端拼提示词 | ✅ **取消**。围炉不拼提示词，`/api/agent/prompt` 下线，现有适配器也改自己拼 |
| Q11 | 死信与人工重投 | ✅ **独立页面**（B 方案） |
| Q13 | 「活会话」限制 | ✅ `live` = 有 writer 持有；`jobs/{id}/reply` 对已退出会话存 pending 并返回 `{delivered,saved,notice}` |
| Q16 | MCP 连接器信任流程 | ✅ 第一版手填参数，不做 OAuth / 深链 |
| Q19 | 会话可见性替代路径 | ✅ 用户自建会话 + 手填会话引用（§7.3） |
| Q20 | 桌面会话与网关库是否互通 | ✅ **实测（用用户新建的会话 `0454dbaa…`）**：把 `CODEBUDDY_CONFIG_DIR` 指向 `~/.workbuddy` 后，`sessions?cwd=*` **能列出该会话**（名称「用户输入数字 123」），`sessions/{id}/replay` **能回放 3 条事件** → **读通**；但 `sessions/{id}/history` 返回 `SESSION_NOT_FOUND`，`sessions/{id}/reply` 返回 `SESSION_FOLLOW_NOT_LIVE` → **写不通** |
| — | reply 队列满 | 丢最旧，群聊永不阻塞 |
| — | 时间基准 | 服务端 |
| — | 数据搬迁 | 数据目录整体可拷 + schema 版本化 |
| — | 部署形态 | Linux/WSL/Docker 生产支持，Windows 仅开发 |

**仍待定 / 推进中**：

| # | 问题 | 说明 |
|---|---|---|
| Q10 | notify 在无唤醒能力 agent 上的降级 | 可能只做「下次一并注入」 |
| Q12 | 记忆三表迁移 | 先留口子，不实现 |
| Q14 | 网关 API 稳定性 | 做 capability probe + 失败降级到 MCP |
| Q15 | 桌面 UI 是否显示网关会话 | 不可见（两套 UI 数据源），但会话文件可读 |
| Q17 | 「拉起会话」 | `POST /api/v1/jobs` 可创建，worker 启动失败（Q18） |
| Q18 | worker 端口冲突 | `EADDRINUSE <gateway port>`，worker 继承父进程端口；待解 |
| **Q21** | 如意最终路线 | ✅ **结案（反转）**：走 **HTTP-ACP**——`/api/v1/acp/connect` → `authenticate`（一次性扫码/浏览器登录）→ `session/load` → `session/prompt`。桌面会话可读可写，登录态持久化，重启免登录。MCP 仍保留作工具面；automation 降级为兜底 |
| **Q22** | App 列表不反映 ACP 写入 | ⚠️ **必做**：App 会话列表读 `workbuddy.db` 的 `sessions` 表，不扫 jsonl。写入后要 `UPDATE sessions SET updated_at, last_activity_at, unread`（先只读确认字段语义；WAL 模式，写前备份） |
| **Q23** | `session/new` 报 Authentication required | ⚠️ 非阻塞：`load` 可用、`new` 不可用，因此只能复用用户预建会话（与 §7.3 一致）。根因未查明 |
| **Q24** | token 获取与轮换 | 🚨 需**管理员权限 + SeDebugPrivilege** 读 daemon 内存（普通权限 `OpenProcess` 返回 5）。Bearer 1319 字符 / 28 天；另有 700 字符 `Offline` token（30 天）**能否换新 Bearer 未验证**。明文 token 落盘需加密/限权 |
| **Q25** | 幂等与超时 | 围炉 at-least-once → 重复 `session/prompt` 会重复回答并污染会话。需按 `messageId` 去重 + prompt 超时/取消；长任务可能数分钟 |
| **Q26** | 产品化门槛 | 普通用户不会开管理员 PowerShell 抓内存；跨平台（mac/Linux）无方案；读进程内存可能违反用户协议。**通用化 v1 不能把它当默认接入方式**，需明确「高级用户自建」定位 |

---

## 10. 里程碑（草案，未排期）

1. **M1**：Channel API v1（updates / messages / ack / meta / media）+ 鉴权 + 幂等 + 丢弃语义
2. **M2**：MCP server（读 / 检索 / 发送）+ 权限映射
3. **M3**：WorkBuddy 桥（HTTP-ACP 客户端 + 登录引导 + `session/load·prompt` + SQLite 列表同步 + capability probe，失败降级 automation）
4. **M4**：DSH channel 插件（会话绑定 + wakeup 语义）
5. **M5**：滚动摘要 + 向量检索（记忆主机成型）
6. **M6**：一致性测试套件 + 参考客户端
7. **M7**：一键连接（配置分发 + 授权）+ Bot API 兼容层

---

## 11. 实测记录（2026-10-30 17:40，本机）

环境：`codebuddy --serve --port 54600`（`CODEBUDDY_GATEWAY_PASSWORD` 指定口令），账号已登录。

| # | 操作 | 结果 |
|---|---|---|
| 1 | `GET /api/v1/health` | `{status:"ok", platforms:["generic","wecom","wechat-kf"]}` |
| 2 | `GET /api/v1/auth/account/status` | `authenticated:true`，userId `c11f1cc4…` |
| 3 | `GET /api/v1/sessions/live` | `{sessionId:null, writerOccupied:false}` |
| 4 | `POST /api/v1/jobs {prompt,cwd}` | 201，返回 `id` + `sessionId`，state `working` |
| 5 | 20s 后 `GET /api/v1/jobs/{id}` | `failed`，detail「session ended — press enter to restart it」 |
| 6 | `~/.codebuddy/logs/job-<id>.log` | **`Error: listen EADDRINUSE 127.0.0.1:54600`** → worker 抢网关端口 |
| 7 | 重试 `bgIsolation:none` / `permissionMode:dontAsk` / `CODEBUDDY_DAEMON_CONFIGURED_PORT=0` | 同样失败，端口仍是 54600 |
| 8 | `POST /api/v1/jobs` with `bash:true` | ✅ `done`，shell job 正常（说明 worker 机制本身可用，问题只在 agent 会话启动） |
| 9 | `POST /api/v1/jobs/{id}/reply`（对已退出 job） | `{delivered:false, saved:true, notice:"Reply saved — it will be sent when this session starts again"}` |
| 10 | `POST /api/v1/sessions/{id}/reply`（非活会话） | `SESSION_FOLLOW_NOT_LIVE`（错误码明确） |
| 11 | 文件计数（派发前后） | `~/.workbuddy/projects` 25 → 25（无新增）；`~/.codebuddy/projects` 17 → 17；job 数据落在 `~/.codebuddy/jobs/<id>/` |

**结论**：

1. 会话寻址、离线排队、错误上报三条能力**都已验证可用**；
2. 「拉起新会话」受阻于 **worker 端口冲突**（Q18），需找到独立端口配置方式或改走 daemon；
3. 网关会话**不进桌面 UI**（Q15），需求①对如意只能算「会话存在但看不见」（Q19）。

### 11.1 第二轮实测（18:10，Q20 复核）

前置：本机有 3 套安装——`D:\WorkBuddy-CN`（运行中，本对话）、`E:\Program Files\WorkBuddyAI`（未运行）、`D:\CodeBuddy CN`（未运行）。

| # | 操作 | 结果 |
|---|---|---|
| 1 | 桌面 App 监听端口 | 仅 `192.168.31.54:58250`，返回 502，是本地 HTTP 代理（非会话 API） |
| 2 | 复制 `~/.workbuddy/projects/<项目>/*.jsonl` 到临时目录 | 成功（含本对话文件） |
| 3 | 以 `CODEBUDDY_CONFIG_DIR=<临时目录>` 启动网关 | 启动正常 |
| 4 | `GET /api/v1/sessions?cwd=*` | **6 条，其中命中桌面会话 `53672573…`（标题「分析DSH群聊容器运行逻辑」）** |
| 5 | 直接 `POST /sessions/{id}/reply` | `SESSION_FOLLOW_NOT_LIVE`（该会话的 writer 在桌面 App 进程里） |

**结论**：桌面 App 与 CLI **共用同一套会话文件格式与目录结构**，只差根目录（`~/.workbuddy` vs `~/.codebuddy`）。
→ 读到不难；**写要靠 `--resume <sessionId>` 把 CLI 变成 writer**，再追加消息。
→ 风险：桌面 App 同时写同一 jsonl 会冲突；`-p` 模式的登录态缺陷仍可能挡路（待验）。
→ 临时副本已删除，未触碰真实数据。

### 11.2 第三轮实测（18:18，用户自建会话的真实验证）

对象：用户当日 15:59 在桌面 App 新建的会话 `0454dbaa-cc8e-4992-a801-281391c1774a`（标题「用户输入数字 123」，3 条消息）。

| # | 操作 | 结果 |
|---|---|---|
| 1 | 备份该会话 jsonl 后再操作 | 已备份，验证结束比对：**文件未被修改**，备份已删 |
| 2 | `CODEBUDDY_CONFIG_DIR=~/.workbuddy` 启动网关 | 正常 |
| 3 | `GET /sessions?cwd=*` | 16 条，**命中该会话**（name「用户输入数字 123」, messageCount 3） |
| 4 | `GET /sessions/{id}/replay?cwd=…` | ✅ 返回 `session_info_update` 等事件（3 条） |
| 5 | `GET /sessions/{id}/history` | ❌ `SESSION_NOT_FOUND`（该端点只认网关自有会话） |
| 6 | `POST /sessions/{id}/reply` | ❌ `SESSION_FOLLOW_NOT_LIVE` |
| 7 | 源码阅读（只读） | 桌面 App 主进程内起**同一个 agent daemon**（`bootstrap-daemon-in-main-process.js`）；对外暴露的是**命名管道 + ticket**：`~/.workbuddy/wbipc/endpoint.json` = `{"endpoint":"\\\\.\\pipe\\wbipc-…","ticket":"…"}` |
| 8 | CLI 是否认识该管道 | `wbipc` 在 CLI bundle 中**命中 0** → CLI 不连 App 的 daemon |

**结论**：桌面会话**读得到、写不进**。写入只有两条路：
1. 逆向 `wbipc` 管道协议（framing + 方法名，私有）；
2. 让 CLI 以 `--resume <sessionId>` 成为 writer（`-p` 有登录态缺陷，且会与 App 抢同一 jsonl）。

### 11.3 ACP 打通（22:17–22:23，推翻 §11.2 结论）

**关键认知**：必须用 **HTTP-ACP**（`/api/v1/acp`），不是 stdio ACP——只有 HTTP 侧能用 SSE 推 `_codebuddy.ai/authUrl` 完成登录。

```
POST /api/v1/acp/connect → { connectionId, sessionToken }
POST /api/v1/acp         → JSON-RPC，响应是 SSE（必须带 acp-connection-id，Accept 同时含 json 和 event-stream）
GET  /api/v1/acp         → SSE 通知订阅
```

流程与实测：

| 步骤 | 结果 |
|---|---|
| `initialize` | ✅ `loadSession: true`，authMethods：`iOA` / `external` / `internal` / `selfhosted` |
| `authenticate {methodId:"internal"}` | ✅ SSE 推 `authUrl`（workbuddy.cn 登录页），用户点一下授权 → 推 `userInfo {userId: c11f1cc4…, userName:"卿"}` |
| `session/load {sessionId, cwd}` | ✅ 成功（返回 models/modes） |
| `session/prompt` | ✅ `stopReason:"end_turn"`、`finishReason:"stop"`、`outcome:"SUCCESS"` |
| 真实会话文件 | `0454dbaa…jsonl` 13948 → 22278 字节，7 → 18 行（**真实文件**） |
| 用户确认 | App 内打开该会话可见两轮「就绪」回复 |
| 重启免登录 | ✅ 同一配置目录重启后，不 `authenticate` 直接 load+prompt 成功 |

**但有两个遗留（见 Q22 / Q23）**：

1. App 会话列表读 `workbuddy.db` 的 `sessions` 表，不扫 jsonl → 写入后列表时间不更新，需同步 SQLite；
2. `session/new` 仍报 `Authentication required`（`load` 正常）→ 只能复用用户预建会话。

**为什么上一轮失败**：凭据 `credential-fields` 适配器对 `role=cbc` 永远 `missing-key`（App 是 `main/daemon` 角色），所以 `authenticated:true` 只是「有登录记录」，`hasAccessToken=false`。**CLI 侧必须自己登录一次**，没有免登录捷径。

### 11.4 token 注入方案（23:50，取代「登录一次」）

**做法**：管理员权限读 daemon 内存拿到 1319 字符 Bearer → `CODEBUDDY_AUTH_TOKEN` 注入 CLI → HTTP-ACP 投递。**不调 `authenticate`，不触发登录态变化。**

我方独立复验（23:48）：

| 项 | 结果 |
|---|---|
| token 元数据（不打印内容） | `len=1319`、`RS256`、`sub=c11f1c…`、`iat 2026-10-30`、**`exp 2026-11-27`** |
| `session/load` | 200 |
| `session/prompt` | 200，`stopReason=end_turn`，**4354ms** |
| App 登录态 | 日志无新增 `auth-owner-change`（最后一次是 22:46 用户手动登录） |

配套仍需：`projects` 目录联接指向真实目录、写入后同步 `workbuddy.db` 的 `sessions` 表（Q22）。

**代价**：token 28 天到期；抓取需管理员权限；明文 token 是账号级凭据（泄露=接管）。

---

## 12. 逆向评估：桌面会话写入（wbipc）

### 12.1 协议事实（源码只读）

| 项 | 事实 |
|---|---|
| 传输 | Windows 命名管道 `\\.\pipe\wbipc-<hash>`；Unix 为 `<runtime>/wbipc/b-<hash>.sock` |
| 发现 | `~/.workbuddy/wbipc/endpoint.json` → `{endpoint, ticket}` |
| 帧格式 | **4 字节大端长度前缀 + JSON**（`readUInt32BE` / `writeUInt32BE`） |
| 限制 | 单帧上限 1 MB，默认超时 5s |
| 方法命名 | `broker/GetPipe`、`broker/ListPipes`、`$/cancel`（LSP 风格） |
| 错误码 | `E_TICKET_INVALID`、`E_PROTOCOL_MISMATCH`、`E_METHOD_UNKNOWN`、`E_NOT_DECLARED`、`E_CONSENT_REQUIRED`、`E_POLICY_DENIED`、`E_TIMEOUT`… |
| 权限模型 | 方法需**声明**（declared），部分操作需**用户同意**（consent） |

### 12.2 实测结果（18:30，已跑通握手）

自己实现了 wbipc 客户端（`~/.workbuddy/wbipc/endpoint.json` + HMAC 握手），验证过程：

| 步骤 | 结果 |
|---|---|
| 连接命名管道 + JSON-line 帧 | ✅ 通 |
| `session_hello`（`protocol 1`、`client_nonce`、`ticket_id = sha256(ticket).hex.slice(0,16)`） | ✅ 收到 `session_challenge` |
| 校验 `server_proof = HMAC-SHA256(ticket, transcript)` | ✅ **校验通过** |
| 回 `session_prove` | ✅ 收到 `session_hello_ack`（epoch、max_inflight=8） |
| 枚举管道 | **只有 3 个**：`wb.entitlement` / `wb.request` / `wb.wecom-a2a` |
| 枚举方法 | `subscription.check` / `http.fetch` / `authorize` |
| 换 client.kind（renderer/desktop/cli/main/app/ui/trusted/codebuddy） | 管道列表**不变** |
| 猜测会话管道（`wb.sessions`、`wb.session`、`wb.agent`、`wb.chat`、`wb.task`、`wb.jobs` 等 12 个） | 全部 `E_PIPE_UNKNOWN` |

**结论：wbipc 是「能力代理」，不是「应用控制面」。桌面会话没有对外写入通道。**

### 12.3 结论

| 路线 | 判定 |
|---|---|
| **HTTP-ACP（`/api/v1/acp`）** | ✅ **可行**（§11.3）：`session/load` + `session/prompt` 实测写入真实会话，`end_turn` |
| wbipc 写入桌面会话 | ❌ **不可行**（管道表里没有会话能力，且不受 client.kind 影响） |
| `sessions/{id}/reply` | ❌ 需 writer（`SESSION_FOLLOW_NOT_LIVE`） |
| `--resume` 抢 writer | ⚠️ 理论可行，但 `-p` 有登录态缺陷 + 与 App 抢同一 jsonl |
| Electron CDP / UI 自动化 | ⚠️ 不需要了（ACP 已覆盖） |

### 12.4 不逆向的替代（官方面，零风险）

| 方案 | 效果 | 代价 |
|---|---|---|
| 围炉 MCP + 用户手动触发 | 如意可读写围炉，无会话 | 需人说话才动 |
| 围炉 MCP + WorkBuddy 内置「自动化」定时任务 | 半自动：定时任务里调 MCP 拉消息、回消息，产生真实可见会话 | 分钟级延迟；要用户建自动化 |
| 等官方开放会话接口 | 最干净 | 时间不可控 |

---

*草案结束。修改直接改本文件；未决问题解决后在 §9 标注结论与日期。*
