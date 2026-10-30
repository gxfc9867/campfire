# WorkBuddy 桥

> 状态：**核心已实现并有测试覆盖（98 项全绿），尚未接入围炉路由与配置**。
> 方案依据：`docs/design/CONNECTION-DRAFT.md` §7 / §11.4 / §12；现场证据：`docs/handoffs/HANDOFF-WORKBUDDY-BRIDGE-2026-10-30.md`。

## 文件

| 文件 | 职责 |
|---|---|
| `acp-client.js` | HTTP-ACP 客户端：connect / initialize / session/load / session/prompt，SSE 解析与错误码归一 |
| `bridge.js` | 投递编排：同会话串行、load 一次、messageId 去重、失败清缓存；`SessionIndex` 负责同步 `workbuddy.db` |
| `launcher.js` | 起子进程：清理 App 注入的环境变量、注入 token、从 stdout 解析端口 |

## 待接（M3 收尾）

1. 围炉配置项：`tokenFile` / `cliBin` / `configDir` / `dbPath`；
2. 在成员投递链路里调用 `bridge.deliver()`，并把回复写回围炉；
3. 启动时 capability probe：ACP 不可用则降级 automation。

## 职责

把围炉消息投进**用户自建**的 WorkBuddy 桌面会话，并把模型回复取回围炉。

## 边界

| 做 | 不做 |
|---|---|
| 起/管一个 `codebuddy --serve --acp` 子进程 | 不调 `authenticate`（会注销桌面登录态） |
| 用 `CODEBUDDY_AUTH_TOKEN` 注入 token | 不抓内存、不读进程（由用户脚本完成） |
| `session/load` + `session/prompt` | 不 `session/new`（未鉴权，也不进 sessions 表） |
| 写入后同步 `workbuddy.db` 的 `sessions` 表 | 不改 App 的其他表 |
| 同 session 串行、按 messageId 去重 | 不并发写同一 jsonl |

## 配置

```jsonc
{
  "tokenFile": "~/.campfire/secrets/workbuddy-bearer.txt",
  "cliBin": "D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy",
  "configDir": "<隔离副本，projects 为 junction>",
  "dbPath": "~/.workbuddy/workbuddy.db",
  "gatewayPassword": "<本机固定口令>"
}
```

## 计划接口

```js
class WorkBuddyBridge {
  async start()                                  // 起网关，等端口，connect + initialize
  async deliver({ sessionId, cwd, text, messageId })  // load（首次）+ prompt，串行队列
  async stop()                                   // 优雅退出
  async health()                                 // token 是否可用、网关是否活着
}
```

## 必须处理的坑

1. `POST /api/v1/acp` 必须 `Accept: application/json, text/event-stream`（否则 406）；
2. 所有请求带 `acp-connection-id`；
3. 环境里必须先删 `SERVER__PORT`，否则子进程抢 App 端口；
4. `session/load` 的 `cwd` 必须与会话记录一致；
5. 写入后 `UPDATE sessions SET updated_at,last_activity_at,unread`，否则列表不更新；
6. token 28 天过期、失效要显式报错并降级，不静默 refusal。
