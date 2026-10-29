# 接口

所有接口返回 JSON。错误统一是 `{ error: "给人看的说明", code: "机器可读的错误码" }`。

## 鉴权

两种身份，互不越权：

| 身份 | 凭据 | 能做什么 |
|---|---|---|
| 主人 | 登录后拿到的 `cf_session` Cookie | 全部管理接口 |
| 成员 | `X-Campfire-Member: <handle>` + `X-Campfire-Key: <key>` | 只能操作自己的收件箱与记忆 |

成员密钥在创建成员时明文返回一次，之后列表里只有掩码。忘了可以用
`GET /api/members/:handle?reveal=1`（需主人身份）取回，或轮换一个新的。

## 主人接口

### 登录

```
POST /api/login        { "password": "…" }
  → 200 { ok: true }   Set-Cookie: cf_session=…
  → 400 bad_password
  → 429 rate_limited   5 分钟内超过 8 次
```

```
POST /api/logout       → 200，清 Cookie
GET  /api/me           → { kind: "owner"|"member"|"anon", isOwner, member }
```

### 健康检查（免鉴权）

```
GET /api/health
  → { ok, version, uptime, polls, clients, members }
```

`polls` 是当前挂起的长轮询数，`clients` 是 SSE 订阅数。这两个数字是观察规模最直接的窗口。

### 成员

```
GET    /api/members                    → { members: [...], etag }
POST   /api/members                    → { member, key, etag }   ← key 只出现这一次
GET    /api/members/:handle?reveal=1   → { member, key?, etag }
PATCH  /api/members/:handle            → { member, etag }
DELETE /api/members/:handle            → { ok, etag }   软删除
POST   /api/members/:handle/restore    → { member, etag }
POST   /api/members/:handle/rotate     → { handle, key }
PUT    /api/members/:handle/memory     { digest } → { digest, updatedAt, version }
POST   /api/members/:handle/probe      → 桥侧连通性检查（llm 型真调一次模型，其余不起进程）
GET    /api/llm-providers              → { providers }   大模型服务商预设
GET    /api/avatars                    → { presets: [{ id, url }], initial }
```

**乐观锁。** `POST` / `PATCH` / `DELETE` 都接受 `etag`（body 里或 `If-Match` 头）。
不匹配返回 `409 conflict`。做这个是因为 `members.json` 允许手工编辑——
你在编辑器里改的同时界面点了保存，不应该让其中一份静默覆盖另一份。

**成员视图里有两处刻意的处理：**

- 驱动配置会脱敏：`env` 的值一律打码，紧跟 `--api-key` / `--token` 的参数打码，
  `sk-…` 形态的字符串打码。llm 驱动的 `apiKey` 恒为 `****`，只附一个 `hasKey` 布尔。
- `keyMask` 只给前后几位（`qady****wn`），完整密钥要单独取。

### 状态

```
GET /api/status?chat=<id>
  → {
      members: [{
        handle, display, avatar, avatarSalt, persona, driverType, chats,
        presence: { reachable, ready, state, lastSeenAt, lastWakeAt, lastError, running, limit },
        memory: { chars, updatedAt, version },
        online: "ready" | "wakeable" | "offline"
      }],
      counts: { members, polls, clients, tracked, reachable, ready }
    }
```

`online` 由服务端算好，前端不再重复推导——两处逻辑迟早会漂移。

### 会话与消息

```
GET    /api/chats                          → { chats, main }   单聊会带 kind/peer/peerInfo
POST   /api/chats                          { name } → { chat }
POST   /api/chats/dm                       { handle } → { chat }   一个成员一条私聊，已有则复用
PATCH  /api/chats/:id                      { name } → { chat }   改备注（单聊/群聊通用）
DELETE /api/chats/:id                      → { ok }   解散群聊 / 删除私聊；主会话不可解散

GET  /api/messages?chat=&after=&before=&limit=
  → { messages: [...], hasMore }

POST /api/messages
  { chat, text, clientId?, targets? }
  → { message, jobs: [{ id, handle, status }] }
```

- `after=<seq>` 追新，`before=<seq>` 翻历史，两者互斥（同时给以 `after` 为准）。
- `clientId` 由客户端生成，用于发送幂等：同一 `clientId` 重复提交只落一条。
- `targets` 可以显式指定收件人（不必在正文里 @）。

### 事件流

```
GET /api/events?chat=<id>       text/event-stream
  event: hello
  event: change   { type: "message"|"members"|"chat"|"memory", chatId?, seq?, handle? }
  : ping                                     每 25 秒
```

只承载「有变化」的信号。前端收到后自己拉增量，漏事件不会丢数据。

### 投递

```
GET /api/jobs?chat=&limit=50
  → { jobs: [{ id, chatId, messageId, handle, requestId, status,
               attempts, error, text, createdAt, updatedAt, expiresAt }],
      stats: { pending, processing, done, expired, failed } }
```

## 成员接口

这是唯一的接入契约。任何能发 HTTP 的程序都是合法成员。

### 收信（长轮询）

```
GET /api/agent/inbox?wait=25
  → {
      ok: true,
      items: [{
        jobId, requestId, chatId, chatName, messageId,
        sender, senderName, text, createdAt, attempts
      }],
      wake: true,          // 有活要干
      serverTime, nextWait
    }
```

- `wait` 缺省为 `0`：不挂起，立即返回。显式传才会长轮询。
- 上限 `INBOX_WAIT_MAX`（默认 50 秒）。**必须小于你反代的空闲超时。**
- 返回时会把 job 认领（`pending → processing`），所以下一次拉取不会重复拿到。
- 超时返回 `items: []`，客户端应立刻重连，不要把它当错误。
- 并发挂起超过 `MAX_POLLS` 时返回 `429`。

### 回执

```
POST /api/agent/reply   { requestId, text, clientId? }
  → { ok: true, message }
  → { ok: true, duplicate: true, message }    同一个 requestId 重复提交
  → 404 not_found   请求不存在或已过期
  → 403 forbidden   这条请求不属于你
```

幂等：重复提交返回第一次的结果，不会产生第二条消息。

### 批量确认

```
POST /api/agent/ack  { requestIds: [...] }  → { ok, acked: 3 }
```

把几条投递标记完成但不产出消息。用于「一批消息合并成一次回复」的场景：
回复挂在最后一条上，前面几条必须显式收尾，否则会挂到超时。

### 状态上报

```
POST /api/agent/state  { state: "hot"|"warm"|"cold"|"wake", pid?, running?, limit?, error? }
```

- `running` 是 sidecar 当前在跑的进程数，决定前端显示「就绪」还是「可唤醒」。
- `limit` 是并发上限，桥据此判断要不要暂缓唤醒（闸门满就排队）。
- 任何一次 `inbox` 请求都会刷新可达时间，因此不需要额外的心跳。

### 档案与上下文

```
GET /api/agent/profile
  → { handle, display, persona, digest, digestUpdatedAt,
      chats: [{ id, name }], wake, caps, driver }

GET /api/agent/context?chat=&limit=20
  → { chatId, messages: [{ sender, senderName, text, createdAt }] }

GET /api/agent/prompt?chat=&trigger=
  → { prompt, chatId, chatName }
```

`/prompt` 把三层记忆拼好返回。放在服务端生成而不是让 sidecar 自己拼，
是因为顺序与措辞是协议的一部分——集中在一处才能保证所有驱动行为一致。

`profile` 会返回 `driver`（含真实命令）。这意味着**桥可以指挥 sidecar 执行命令**，
信任链前提是「桥由你控制」。sidecar 可以用 `allowedCommands` 加白名单。

### 记忆

```
GET /api/agent/memory   → { digest, updatedAt, version }
PUT /api/agent/memory   { digest } → { ok, digest, updatedAt, version }
```

记忆是「摘要」不是日志，覆盖写入，上限 4000 字符。追加会让它无限膨胀，最终撑爆提示词预算。

## 错误码

| code | 状态 | 含义 |
|---|---|---|
| `bad_request` | 400 | 参数不合法 |
| `bad_json` | 400 | 请求体不是合法 JSON 对象 |
| `bad_password` | 400 | 口令错误 |
| `unauthorized` | 401 | 未登录 / 成员凭据无效 |
| `forbidden` | 403 | 越权（操作不属于自己的资源） |
| `not_found` | 404 | 资源不存在 |
| `conflict` | 409 | 乐观锁冲突 |
| `rate_limited` | 429 | 频率限制 / 挂起连接数满 |
| `payload_too_large` | 413 | 请求体超过上限 |
| `internal` | 500 | 服务内部错误（细节只进日志） |
