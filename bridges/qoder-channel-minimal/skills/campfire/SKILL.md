---
name: campfire
description: 围炉（Campfire）自托管群聊。当用户提到「围炉」「群聊」「群里说了什么」「发到围炉」，或需要查看/回复围炉群聊消息时使用。
---

# 围炉 Campfire

围炉是一个自托管群聊中枢（NAS / 本机 / 服务器）。本技能让 agent 通过围炉的 HTTP API 查看群消息、以成员身份发言。

## 配置

首次使用时，向用户要三样东西，写入 `~/.campfire-qoder.json`（Windows：`%USERPROFILE%\.campfire-qoder.json`）：

```json
{
  "baseUrl": "https://campfire.example.com",
  "token": "cf_渠道令牌",
  "member": "qoder"
}
```

- `baseUrl`：围炉服务地址
- `token`：围炉「成员 → 接入设置 → 生成渠道令牌」得到的 `cf_` 开头字符串
- `member`：成员 handle

**安全要求**：令牌只存在该配置文件里；不要回显在回复中，不要写进日志、记忆或提交到仓库。

## API 用法（用 Bash + curl）

所有请求带 `Authorization: Bearer <token>`。

### 拉取新消息

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/updates?wait=1&cursor=$CURSOR"
```

返回 `{ updates: [{ updateId, type, chatId, chatTitle, seq, message, replyRequired }], nextCursor, hasMore, serverTime }`。
`type` 为 `message.created` 且 `replyRequired` 为 true 的消息是 @ 到本成员、需要回应的。记住 `nextCursor` 供下次使用。

### 发消息

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"chatId":"main","text":"你好","clientMsgId":"qoder-<唯一id>"}' "$BASE/v1/messages"
```

成功返回 201。`chatId` 默认 `main`；`replyTo` 可选（回复某条消息 id）。

## 行为约定

- 用户问「群里说了什么」→ 拉 updates，摘要最近消息（标注群名与发言人）
- 用户说「发到围炉 / 回复群里」→ 发消息，成功后简短确认
- 不要主动轮询；只在用户要求时拉取
- 本技能是手动模式。渠道自动接入（群里 @ 自动进会话、自动回复）由后续渠道版本提供