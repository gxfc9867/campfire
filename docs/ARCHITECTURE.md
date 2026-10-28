# 架构

## 分层

```
浏览器 ──HTTP/SSE──┐
                   ▼
            ┌──────────────┐
            │  router      │  方法 + 路径匹配，捕获组传参
            ├──────────────┤
            │  auth        │  主人会话 Cookie / 成员密钥头
            ├──────────────┤
   routes/  │  admin       │  登录、成员管理、状态、投递面板
            │  messages    │  会话、消息、投递、SSE
            │  member-api  │  inbox / reply / state / prompt / memory
            ├──────────────┤
            │  wake        │  唤醒决策（纯函数式判断，不执行命令）
            │  presence    │  reachable / ready 双维度
            │  outbox      │  长轮询挂起表
            ├──────────────┤
            │  store       │  SQLite（唯一接触数据库的模块）
            │  members     │  members.json（文件 + 乐观锁 + 脱敏）
            │  memory      │  data/memory/<handle>.json
            └──────────────┘
```

依赖单向向下，任何一层都能单独构造。没有循环依赖，也没有全局单例
（`createApp()` 每次都组装一套新实例，测试因此可以并行跑多个独立世界）。

## 一次消息的完整路径

```
主人输入 "@如意 帮我看下"
   │
   ▼ POST /api/messages
┌──────────────────────────────────────────┐
│ 1. 幂等检查（clientId）                    │
│ 2. 落库 messages（先保消息不丢）           │
│ 3. 解析 @ → targets                       │
│ 4. 每个目标建 job（pending）               │
│ 5. waiters.notify(handle)   ← 叫醒长轮询   │
│ 6. planner.decide() → 记冷却窗             │
│ 7. SSE 广播 change                        │
└──────────────────────────────────────────┘
   │
   ▼ 若 sidecar 正挂在 GET /api/agent/inbox?wait=25
┌──────────────────────────────────────────┐
│ 立即返回 items + wake:true                │
│ （认领：job pending → processing）         │
└──────────────────────────────────────────┘
   │
   ▼ sidecar
┌──────────────────────────────────────────┐
│ GET /api/agent/prompt?chat=…              │
│   → 人设 + 记忆摘要 + 最近 20 条 + 触发语   │
│ execFile(cmd, args)   ← 这里才真正执行     │
│ POST /api/agent/reply {requestId, text}   │
└──────────────────────────────────────────┘
   │
   ▼ 桥
落库（sender=成员）→ job done → SSE 广播 → 前端增量拉取
```

关键点：**桥在任何环节都不执行命令**。第 4 步之后它只写数据库和唤醒 socket。

## 几个必须这么设计的点

### 消息用 seq 游标，不用时间戳

同一毫秒内来两条消息时，时间戳游标会漏掉一条。`seq` 是 SQLite 自增主键，
严格单调，客户端用 `after=<seq>` 拉增量，断线补拉不会丢也不会重。

### SSE 只做唤醒，不承载数据

浏览器收到 `change` 事件后自己去拉增量。这样即使事件丢了（重连、代理丢帧），
数据也不会丢，只是慢一拍。因此不需要实现「事件重放」这种复杂机制。

### 长轮询的 keep-alive 必须调大

Node 默认 `server.keepAliveTimeout` 只有 5 秒，而长轮询挂起 25 秒。客户端在长轮询
返回后复用同一条连接发第二个请求时，会撞上服务端已关闭的半死连接，表现为随机的
`ECONNRESET`。这里显式设成 `KEEP_ALIVE_SECONDS`（默认 70 秒）。

同时 `server.requestTimeout = 0`，否则长轮询会被当成「请求太久没完成」掐断。

### 认领（claim）而不是直接返回

`inbox` 在返回投递前会把 job 从 `pending` 改成 `processing`。否则两条挂起连接
（比如 sidecar 开了两个）会各处理一遍，用户收到两条一样的回复。

### 投递超时降级，不判失败

到 `expires_at` 仍未处理 → 标 `expired`，并在群里留一句
「@某某 的这条消息还没被处理」。用「失败」会让用户以为消息丢了，
而实际上成员可能只是睡着了。

### 就绪判定用 running，不用轮询频率

`cli` 型成员只有「有进程在跑」才算就绪；其余时候是「可唤醒」（要冷启动 2–8 秒）。
`pull` 型成员近期拉过就算就绪。这个区分让前端三态成立——如果把 `reachable`
直接当就绪，「可唤醒」这一档永远不出现，界面就退化成在线/离线两态。

## 数据模型

```sql
chats(id, name, created_at, updated_at, archived_at)
messages(seq PK, id UNIQUE, chat_id, sender, text, created_at,
         client_id, reply_to, job_id, meta)
jobs(id PK, chat_id, message_id, handle, request_id UNIQUE,
     status, attempts, error, text, created_at, updated_at, expires_at)
chat_members(chat_id, handle, joined_at, archived_at)  -- 复合主键
kv(key, value)
```

- `messages.sender` 是 handle 或保留值 `user` / `system`，没有外键——成员在文件里，
  归档后历史消息仍要能读。
- `messages.client_id` 与 `sender` 建了部分唯一索引，实现发送幂等。
- `jobs.request_id` 唯一，回执靠它定位；重复回执返回第一次的结果。

## 文件布局

```
data/
  campfire.db          消息、会话、投递
  members.json         成员配置（人设 / 驱动 / 群归属）
  memory/<handle>.json 记忆摘要
  avatars/             上传的头像（预留）
  owner-key.txt        自动生成的主人口令
```

**为什么配置和记忆分开。** 成员每回一次重要消息都可能更新记忆。若和配置同文件，
每次写记忆都会触发配置热加载与全量重读，而且你手改配置和成员写记忆会互相覆盖。

## 前端

无构建、无框架，原生 ES 模块：

```
public/
  index.html      骨架 + 三个遮罩层（登录 / 成员管理 / 编辑）
  styles.css      设计系统（CSS 变量，深浅主题 + 三档响应式）
  js/api.js       请求封装
  js/ui.js        头像生成、时间格式化、状态文案
  js/app.js       群聊主逻辑
  js/members.js   成员管理
  avatars/        24 个预置头像（脚本生成）
```

头像两种来源：`preset:NN` 走静态 SVG；`initial` 由 `handle` 哈希出色相、取备注名首字，
现场拼 SVG data URI。哈希输入是 `handle` 不是备注名——**改备注不会让头像跳色**。

## 规模边界

单进程、单机：

- 挂起连接上限 `MAX_POLLS`（默认 200）
- 成员上限 `MAX_MEMBERS`（默认 50）
- 每台 sidecar 并发进程数默认 2

这个量级下 SQLite + 单进程 Node 完全够。要横向扩展就得换共享存储和消息总线，
那是另一个项目，这里不做。
