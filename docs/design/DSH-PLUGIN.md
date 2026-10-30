# M4 · DSH channel 插件（dsh-campfire）

> 状态：**已完成并本地验收通过**（DSH 0.2.1-rc.5 + mock 围炉，2026-10-31）。
> 归属：发财（本机）。分支 `feat/m4-dsh-plugin`，只动 `plugins/dsh-campfire/**` 与本文件。
> 上位契约：`docs/design/CONNECTION-DRAFT.md` §6.4（来源标记）、§6.5（会话生命周期）、
> §6.8（围炉不拼提示词）、§7（DSH 走自研 channel 插件）、§7.3（会话引用）。

---

## 1. 目标与边界

**做**：把围炉群消息投进 DSH 会话，把会话回复发回围炉；会话在 DSH 里可见、可继续、可复用。

**不做**（明确划出去，避免和 §6.8 打架）：

| 不做 | 为什么 |
|---|---|
| 拼人设 / 记忆 / 上下文 | §6.8：围炉只传信息，上下文归 agent 会话自己 |
| 生成摘要、向量检索 | M5 的事；游标过期时的摘要补齐暂未实现（见 §9） |
| 附件下载与落盘 | 消息里的附件只投递元数据行，v1 不下载二进制 |
| 流式打字机 | 只回最终文本；DSH 侧会话本身仍有流式体验 |
| 自动创建会话的 UI | §7.3 第一版不做「自动拉起」；本插件在收到消息时按需建会话 |

---

## 2. 目录结构

```
plugins/dsh-campfire/
├── index.js                 # 插件入口：inject / apply / 装配与卸载顺序
├── package.json             # bundle 清单（dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml         # 把本插件插进 Loader 的那一行（id: campfire）
├── locale/{en,zh}.json      # Plugin Manager 显示用标题/描述
├── icon.svg                 # 原创图标（篝火）
├── src/
│   ├── config.js            # 配置解析：行内 config > 环境变量 > 配置文件 > 默认值
│   ├── campfire-client.js   # Channel API v1 客户端（零依赖，只用全局 fetch）
│   ├── bindings.js          # 绑定与游标状态文件（原子写）
│   ├── format.js            # 来源标记 / 入站渲染 / 出站整理
│   ├── bridge.js            # 纯逻辑编排：拉流 → 定会话 → 投递 → 回帖 → ack
│   └── dsh-host.js          # 唯一碰 ctx.agents / ctx.sessions / Agent 方法的地方
├── mock-campfire.cjs        # 零依赖 mock 围炉（单测 + 人工验收共用）
└── test/                    # 42 个用例：format / config / client / bridge
```

`docs/probes/campfire-mock.cjs` 是 mock 的 CLI 启动器（人工验收用）。

**分层原则**：`bridge.js` 不认识 DSH，`dsh-host.js` 不认识围炉协议。两边都能单独测：
bridge 用假 host + 真 mock 跑通全链路；dsh-host 的 API 形状集中在 60 行里，DSH 换版本只改这一处。

---

## 3. 数据流

```
围炉 /v1/updates（长轮询）
   │  update{ type, chatId, seq, message, wakeup }
   ▼
bridge.pollChat ──► 过滤（群白名单 / 自己发的 / wakeup=none）
   │
   ├─ 定会话：绑定键 = "*"（成员:会话 1:1）或 chatId（per-chat）
   │     store 有绑定 → agents.get → resume → 同 id 重建 → 换新 id（四级降级）
   │
   ├─ reply  → host.ask()：followup(durable UserMessage) → 等 session/event 的 turn/end
   │             → 取本轮 assistant 文本 → POST /v1/messages（replyTo=原消息）
   │
   └─ notify → host.inject()：进 inbox 不唤醒
   │
   ▼
POST /v1/updates/ack {chat, cursor: seq} → 写本地游标 → 下一条
```

---

## 4. 会话绑定

| 配置 | 绑定键 | 语义 |
|---|---|---|
| `sessionScope: "member"`（默认） | `"*"` | 一个成员一个会话，所有群共用（记性最好，跨群会串味） |
| `sessionScope: "per-chat"` | `chatId` | 每个群一个会话，群之间彻底隔离 |

**打开会话的四级降级**（`bridge.ensureSession` + `dsh-host.openSession`）：

1. `ctx.agents.get(id)` —— 本进程里还活着，直接用；
2. `ctx.agents.resume({ resumeSessionId })` —— 盘上有历史，恢复（`dsh-host` 把失败原因分类成 `not_found / owned / registered / failed`）；
3. 同 id `create` —— `not_found`（盘上确实没有）或 `registered`（刚被别人注册）时重建，**绑定不漂移**；
4. 换新 id `create` —— 上一级也失败（典型：`owned`，别的进程正占着写权限），记 `warn` 并覆盖绑定，对应 §6.5 的 `binding_invalid`。

> 实测：插件禁用再启用后，第 2 级命中，同一个 sessionId 继续用，历史还在（见 §8 证据）。

---

## 5. 唤醒映射（§6.1）

| 围炉 `wakeup` | DSH 动作 | 会不会真的跑模型 |
|---|---|---|
| `reply`（被 @） | `agent.followup(durableUserMessage)` → 等本轮 `turn/end` | 会 |
| `notify`（别人说话） | `agent.inject(durableUserMessage)` → 只进 inbox | 不会，等下一次被唤醒时一起看到 |
| `none`（系统消息/噪音） | 什么都不做，只 ack | 不会 |

**投递必须是完整 durable `UserMessage`**：`{ id, role: 'user', content: [{type:'text',text}], source: {kind:'campfire'} }`。
纯字符串会被 inbox 的去重逻辑挡掉（`inbox.mutate` 按 message.id 去重），这一点是实测踩出来的。
`source.kind` 用 `campfire` 而不是 `user`——`user` 代表真人输入，混用会污染会话语义。

**拿回复**：监听 `session/event`，`assistant/message` 收文本、`turn/end` 判结束。
一轮里可能有多个 step（工具调用），所以只在 `turn/end` 之后收口；超时（`replyTimeoutMs`，默认 120s）
则 `agent.cancel({kind:'hook'})` 并用已收文本收尾，**不阻塞群**（§6.2）。

---

## 6. 来源标记（§6.4 不可信上下文）

每条入站消息渲染成：

```
[来自围炉/群 main/成员 恭喜] 正文第一行
正文其余行
[附件] a.png (image/png, 18342B) https://…/s/…
```

- 模板可用 `sourceMarker` 改（`{chat}` `{sender}` 占位）；
- 正文超过 20000 字截断并显式标注 `[已截断]`；
- 附件只给元数据行，v1 不下载。

实测落库形态（会话 JSONL 里 `user/message` 的 `source.kind = campfire`）：

```
seq=14 source=campfire :: [来自围炉/群 main/成员 恭喜] @facai ...
seq=31 source=campfire :: [来自围炉/群 main/成员 恭喜] @facai ...
seq=50 source=campfire :: [来自围炉/群 main/成员 恭喜] @facai ...
```

---

## 7. 配置参考

**优先级**：行内 `config`（profile 的 `cordis.patch.yml` 用同 id `campfire` 覆盖）> 环境变量 > 配置文件 > 默认值。
配置文件默认 `$DSH_HOME/campfire/config.json`（不进仓库，适合放 token）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `''` | 围炉地址；**空 = 插件待命不拉流**（安全默认） |
| `token` | `''` | 渠道 token；留空则看 `tokenEnv` / `tokenFile` |
| `tokenEnv` | `CAMPFIRE_TOKEN` | 从环境变量取 token |
| `tokenFile` | `''` | 从文件取 token（支持 `~`，LAYOUT 约定放 `~/.campfire/secrets/`） |
| `memberHandle` | `facai` | 本插件在围炉里的成员 handle（自己发的消息会被跳过） |
| `chatIds` | `['main']` | 要接的群；空数组 = 待命 |
| `sessionScope` | `member` | `member` 或 `per-chat` |
| `wait` | `25` | 长轮询秒数（0–30） |
| `limit` | `100` | 一次最多拉多少条 |
| `replyTimeoutMs` | `120000` | 等一轮跑完的上限 |
| `maxReplyChars` | `8000` | 单条回复字数上限 |
| `sourceMarker` | `[来自围炉/群 {chat}/成员 {sender}]` | 来源标记模板 |
| `cwd` | `''` | 会话工作目录；留空用 DSH 默认目录（**必须是绝对路径**，否则 `sessions.prepare` 抛错） |
| `provider` / `model` / `reasoningEffort` | `''` | 会话模型路由；留空继承 `agentDefaultModel.currentSelection()` |
| `stateFile` | `$DSH_HOME/campfire/state.json` | 绑定与游标 |
| `configFile` | `$DSH_HOME/campfire/config.json` | 配置文件位置 |
| `maxBackoffMs` | `30000` | 拉流失败的最大退避 |
| `logLevel` | `info` | `debug/info/warn/error/silent` |

`describeConfig()` 打的摘要不含 token 明文（只有 `token=已配置/缺失`）。

**状态文件**（`state.json`）：

```json
{
  "version": 1,
  "bindings": { "*": { "sessionId": "campfire-main-…", "chatId": "main", "createdAt": 0, "updatedAt": 0, "lastWakeAt": 0 } },
  "cursors": { "main": 5 }
}
```

写盘是「临时文件 + rename」；文件损坏时按空状态启动并 `warn`，不阻断插件。

---

## 8. 安装与验收（本地实测记录）

### 8.1 安装

```
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后**不用** `list_plugins` 确认，用 inspect：

```
cordis_inspect_query host / Config / listConfigs  { "name": "campfire-dsh-plugin" }
→ entries: [{ id: "include:campfire", patchId: "campfire", name: "campfire-dsh-plugin", status: "absent" }]
```

`status: absent` = 行已激活但本插件不导出 `Config`（v1 用自带校验，不引 `schemastery` 依赖，
见 §10）。`total: 0` 才是没挂上。

### 8.2 起 mock 围炉

```
node docs/probes/campfire-mock.cjs --port 8787 --token dev-token --member facai --chat main
```

写 `$DSH_HOME/campfire/config.json`：

```json
{ "baseUrl": "http://127.0.0.1:8787", "token": "dev-token", "memberHandle": "facai",
  "chatIds": ["main"], "sessionScope": "member", "cwd": "<仓库绝对路径>" }
```

### 8.3 验收结果（2026-10-31 00:23–00:25，真 DSH 0.2.1-rc.5）

| # | 动作 | 结果 |
|---|---|---|
| 1 | `POST /mock/inject` 一条被 @ 的消息 | 新建会话 `campfire-main-8e2672cd-…`，回复落回 mock，`replyTo` = 原消息 id |
| 2 | 再发一条 | **同一个会话**继续，第二次回复 `replyTo` 正确，游标 1→3 |
| 3 | `set_bundle enabled=false` | 停用后注入的消息无人处理（outbox 不增、游标不动） |
| 4 | `set_bundle enabled=true` | 重新拉起后**补处理**停用期间的消息，仍是同一会话（`resume` 命中），游标 3→5 |

证据：

- 会话日志：`$DSH_HOME/sessions/--J-campfire-m4--/campfire-main-8e2672cd-…/session.v4.jsonl.zstd`
  （解压后 56 个事件、3 个 `turn/start`、3 个 `turn/end`、3 条 `source=campfire` 的 `user/message`）
- 绑定/游标：`$DSH_HOME/campfire/state.json`（`bindings.*.sessionId` 全程未变，`cursors.main` 1→3→5）
- 只有**一个**会话目录 —— 复用而不是重建

---

## 9. 失败与背压

| 情况 | 行为 |
|---|---|
| 单条处理失败（模型报错、会话打不开…） | `error` 日志 + 失败计数，**照样 ack 推进游标**：群聊不能因为一个成员卡住（§6.2） |
| 重复投递同一 `updateId` | 内存去重（保留 500 条）+ 照样 ack，不重复唤醒 |
| 拉流 HTTP 失败 | 指数退避 1s→`maxBackoffMs`，`warn` 日志，不退出 |
| `cursor_expired` | 游标归零重新拉（摘要补齐属 M5，未实现，日志里会写明） |
| 插件卸载 | 逆序收尾：停拉流 → 关客户端 → 释放本插件建的 agent handle（会话历史留在盘上，下次 `resume`） |
| 回复超时 | `agent.cancel` + 用已收文本收尾，照常 ack |

---

## 10. 已知限制（v1）

1. **不导出 `Config` schema**：本插件是链接目录安装（`link:J:/…`），裸 `import '@deepseek-ai/schemastery'`
   从链接目录解析不到，所以走自带校验 + `$DSH_HOME/campfire/config.json`。等打成 npm 包再补 `Config`。
2. **游标过期只重拉**，没有「摘要 + 最近 N 条」补投（M5）。
3. **附件不下载**，只投元数据行。
4. **人设继承部署默认**：新建会话没有 per-agent persona，用的是 profile 的默认 agent preset。
   要给每个成员不同人设，得后续按成员传 `agentPreset`（agent-loop 的 `create` 支持 `meta.agentPreset`）。
5. **只在 Windows + mock 围炉上验过**；真围炉（M1 的 `/v1`）端点和 mock 若有差异，改 `campfire-client.js` 一处即可。
6. **会话随插件卸载而销毁**（DSH 的 handle 语义）：盘上 JSONL 还在，重新启用会 `resume` 回来；
   但如果插件卸载时正好有一轮在跑，那一轮的 `turn/end` 可能没落盘（agent-loop 的已知限制）。

---

## 11. 下一步

1. M1 的 `/v1` 合并后，用真围炉替换 mock 跑一遍 §8.3 的四步（客户端已按契约实现，理论上零改动）。
2. `reply` 支持 `replyTo` 之外的 `mentions` 回填（回帖时带上被回复人的 handle）。
3. 多群并发时的合并窗口（§6.1 `coalesce`）：现在一条消息一轮，30s 窗口内的连发还没合并。
4. 给成员配 `agentPreset`，让「恭喜」「发财」「如意」各自有人设。
