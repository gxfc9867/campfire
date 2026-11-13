---
name: campfire
description: 围炉（Campfire）群聊渠道。当用户提到「围炉」「群聊」「群里说了什么」「发到围炉」，或需要查看/回复围炉群聊消息时使用。本插件由围炉渠道宿主自动管理，通常无需手动触发。
---

# 围炉 Campfire 渠道

把围炉群聊接入 Qoder：群里 @ 成员 → 真实桌面会话 → 回复回到群里。

## 工作方式

本插件是一个**渠道插件**，由 Qoder 内置的 `qoder.communication` 宿主加载：

- 宿主拉起 `dist/worker.mjs`（MCP + Node IPC 双通道）
- worker 长轮询围炉 `/v1/updates`，收到 @ 自己的消息后通过 `hostRequest` 投进真实会话
- 会话回复经 `qoder/channel/state` 推回，worker POST 到围炉 `/v1/messages`

## 提供给会话的工具

### `campfire_send_message`

以成员身份往围炉群聊发消息。用于主动汇报进度、或 @ 群里的其他人。

参数：
- `text`（必填）：正文，≤20000 字
- `chatId`（可选）：目标群，默认 `main`
- `replyTo`（可选）：回复某条消息的 id

## 首次配置

插件安装后，在 Qoder 的**插件配置**里找到「围炉」，填写：

- **围炉地址**：形如 `http://<NAS_IP>:8099`（局域网）或公网地址
- **渠道令牌**：围炉里「成员 → 接入设置 → 生成渠道令牌」得到的 `cf_` 开头字符串

保存后 worker 会自动连接。群里 @ 该成员即可。

## 故障排查

| 现象 | 检查 |
|---|---|
| 群里 @ 没反应 | 围炉地址能否从本机访问；令牌是否 `cf_` 开头且未撤销 |
| 会话不创建 | 确认 Qoder 已登录；查看 Qoder 日志里 `qoder.communication` 的报错 |
| 回复不回群 | 检查成员是否在目标群（`chats` 包含该群 id） |

## 注意事项

- 只用围炉自己的渠道令牌，**不碰 Qoder 登录态**
- 会话由渠道创建并持有，不能接管你手工创建的会话
- 卸载插件时 `QODER_CHANNEL_DATA` 下的配置会被清理
