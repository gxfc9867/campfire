# 围炉 Campfire（campfire-channel）

把**自托管的围炉群聊**接进 Qoder 桌面端：群里 @ 一个成员 → Qoder 自动创建/继续一个真实会话 → 模型回复 → 回复自动回到群里。

## 这是什么类型的插件

**IM 渠道插件**，与官方「企业微信IM」（`wecom-channel`）同构：

- 标准插件包（`.qoder-plugin/plugin.json` + skills）
- 渠道描述符 `im-channel.json`（`category: "im"`，`protocolVersion: 4`）
- 渠道 worker（`dist/worker.mjs`，零依赖单文件），由内置 `qoder.communication` 宿主按标准协议拉起并常驻
- `.mcp.json` 严格遵循渠道宿主的 schema（`${QODER_NODE_RUNTIME}` / `${QODER_PLUGIN_ROOT}` / `${QODER_PLUGIN_DATA}` / `com.qoder/runtimeOwner`）

## 功能

- 群消息 → 真实桌面会话（`create`/`continue`，界面可见，全自动）
- 会话回复 → 自动回群（`watchState` 订阅，turn 结束即回帖）
- 会话内 MCP 工具：`campfire_send_message`（agent 主动发言）、`campfire_configure`（配置）、`campfire_status`（状态）
- 设置界面：连接状态、启用/停用、重连、移除（标准渠道管理协议）

## 前置条件

- Qoder CN 桌面端已登录
- 围炉服务已部署（NAS / 本机 / 服务器），本机可访问
- 围炉里已创建成员并加入目标群，已生成渠道令牌（`cf_` 开头）

## 安装与配置

1. 从 Qoder 市场安装本插件
2. 在任意 Qoder 会话里说「配置围炉」，按提示提供：服务地址、渠道令牌、成员 handle
3. 群里 @ 该成员：Qoder 出现「围炉 · <成员>」会话，回复自动回群（秒级）

## 安全说明

- 只使用用户自己的围炉渠道令牌；**不读取、不复制、不修改 Qoder 登录凭据**
- 令牌与配置仅存储在渠道本地数据目录（`QODER_CHANNEL_DATA`），卸载时清理
- worker 除用户配置的围炉服务器外不访问任何网络地址
- 零第三方依赖；worker 由 Qoder 自带 Node 运行时拉起，不需要用户安装任何运行时
- 渠道会话的工具自动批准范围仅限 `campfire_send_message`（`im-channel.json` 的 `sessionTools.autoApprove`）

## 已知边界

- 会话由渠道创建并持有；不能接管用户在界面手工创建的会话
- 本地 ZIP 安装（`@local`）不会激活渠道（宿主设计如此），只提供技能与 MCP 工具
- 第一阶段不转发会话内的权限/提问交互到群里；渠道会话以全自动模式运行

## 链接

- 围炉项目：https://github.com/gxfc9867/campfire
- 许可：MIT