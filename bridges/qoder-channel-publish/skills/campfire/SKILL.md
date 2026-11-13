---
name: campfire
description: 围炉（Campfire）群聊渠道。当用户提到「围炉」「群聊」「群里说了什么」「发到围炉」「配置围炉」，或需要查看/回复围炉群聊消息时使用。渠道模式下由 qoder.communication 宿主自动管理。
---

# 围炉 Campfire 渠道

把围炉群聊接入 Qoder：群里 @ 成员 → 真实桌面会话 → 回复回到群里。

## 工作方式

本插件是一个**渠道插件**，由 Qoder 内置的 `qoder.communication` 宿主加载（需从市场安装）：

- 宿主拉起 `dist/worker.mjs`（MCP + Node IPC 双通道）
- worker 长轮询围炉 `/v1/updates`，收到 @ 自己的消息后通过 `hostRequest` 投进真实会话
- 会话回复经 `qoder/channel/state` 推回，worker POST 到围炉 `/v1/messages`

## 提供给会话的工具

### `campfire_configure`

配置围炉渠道（首次接入时用）。参数：

- `baseUrl`（必填）：围炉服务地址，如 `https://campfire.example.com`
- `token`（必填）：围炉「成员 → 接入设置 → 生成渠道令牌」得到的 `cf_` 开头字符串
- `member`（必填）：成员 handle，如 `qoder`

**安全要求**：令牌只写入渠道本地配置，不要回显在回复里，不要写进日志或记忆。

### `campfire_status`

查询渠道状态：是否已配置、连接状态、已绑定的会话、配置文件位置。排查问题时先调它。

### `campfire_send_message`

以成员身份往围炉群聊发消息。用于主动汇报进度、或 @ 群里的其他人。

参数：
- `text`（必填）：正文，≤20000 字
- `chatId`（可选）：目标群，默认 `main`
- `replyTo`（可选）：回复某条消息的 id

## 首次配置

1. 在围炉里创建成员（handle 如 `qoder`），加入目标群，生成渠道令牌
2. 在 Qoder 会话里说「配置围炉」，提供地址、令牌、成员名（agent 调用 `campfire_configure`）
3. 群里 @ 该成员验证：Qoder 出现「围炉 · qoder」会话，回复自动回群

设置界面（扩展 → 插件配置 → 围炉）可查看连接状态、启用/停用、重连。

## 故障排查

| 现象 | 检查 |
|---|---|
| 群里 @ 没反应 | 先调 `campfire_status`；围炉地址能否从本机访问；令牌是否 `cf_` 开头且未撤销 |
| 渠道未加载 | 本插件需从**市场**安装才会成为渠道（本地 ZIP 安装只提供技能与工具） |
| 会话不创建 | 确认 Qoder 已登录；查看 Qoder 日志里 `qoder.communication` 的报错 |
| 回复不回群 | 检查成员是否在目标群（`chats` 包含该群 id） |

## 注意事项

- 只用围炉自己的渠道令牌，**不碰 Qoder 登录态**
- 会话由渠道创建并持有，不能接管你手工创建的会话
- 卸载插件时渠道数据目录下的配置会被清理