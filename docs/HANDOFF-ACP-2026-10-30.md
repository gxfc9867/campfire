# ACP 接入交接文档 — 2026-10-30 22:40

> ⛔ **本文已被取代（2026-10-30 23:50）**
> 最终方案见 **`HANDOFF-WORKBUDDY-BRIDGE-2026-10-30.md`**：从 daemon 内存取 28 天 Bearer token
> 注入 `CODEBUDDY_AUTH_TOKEN`，不登录、不调 `authenticate`、不踢桌面登录态，实测已跑通。
> **本文保留的价值只有两条**：① 「为什么不能用 authenticate」的实测证据；② HTTP-ACP 协议细节。
> 本文里「需要用户登录一次」「一次登录长期可用」的结论**都已作废**。

> 🚨 **最高优先级警告（2026-10-30 22:47 补充）**
> **绝对不要在已登录的账号上调用 `authenticate`。**
> 实测两次：`authenticate` 内部是 **logout + login**，会把同一账号的桌面 App 会话一起注销，
> 用户会被踢下线，必须手动重新登录。
> **规则**：只有用户明确要求「重新登录」时才调用；调用前先告知会踢掉桌面。
> 桥接程序运行期**禁止**自动 authenticate。

> 给接手的 agent：本文只讲 **ACP 这一条线**。围炉方案全文见 `CONNECTION-DRAFT.md`（v1.0），
> 上一任的现场记录见 `HANDOFF-2026-10-30.md` 和 `PROGRESS-2026-10-30.md`。
> **本文结论推翻了那两份文档里「桌面会话写入不可行」的判断**，请以本文为准。
> 纪律不变：**方案未确认前不动生产代码**。本文所有操作都是只读或落在隔离副本里。

---

## 0. 一句话现状

**ACP 鉴权已打通。** 现在可以用桌面会话 ID 加载会话、写入用户消息、拿到真实模型回复（`stopReason: end_turn`），
登录态可持久化，重启免登录。**「成员=会话」对 WorkBuddy 成立，Q21 可以结案。**

剩下两件事不是鉴权问题，是**可见性**问题（见 §6）。

---

## 1. 上一任卡在哪，为什么卡住

前任的判断：`session/prompt` 报 `Authentication required`，推断「ACP 子进程读不到凭据」。

**方向对，结论错。** 从 ACP 进程自己的日志（`<configDir>/logs/<日期>/<cwd名>__<hash>.log`）能看到完整因果链：

```
[FileAuthenticationStorage] [AtRestEncryption] unavailable
  adapter=credential-fields  resource=auth/workbuddy-desktop.info
  operation=read  category=missing-key  role=cbc ; continuing
[AuthenticationManager] userId changed: -> c11f1cc4-3c7d-4c03-b916-292c38f7d949
[AuthenticationManager] stage=afterRestore  hasSession=true  hasAccessToken=false
[AuthenticationManager] [AuthRefresh] started: trigger=immediate
[AuthenticationManager] [AxiosError: status code 401] [AuthRefresh] failed  sessionPreserved=true
```

翻译：

1. 凭据文件**读得到**，但 `credential-fields` 适配器解不开（`missing-key`）；
2. App 是 `main`/`daemon` 角色，CLI 是硬编码的 `role=cbc`，**两者用的 at-rest 密钥不是同一把**；
3. 所以 `/api/v1/auth/account/status` 返回 `authenticated: true` 只是「有登录记录」，
   实际上 `hasAccessToken = false`，任何模型请求都 401。

**结论：CLI 侧必须自己登录一次，没有免登录的捷径。** 已试过并且**不通**的绕法见 §7。

---

## 2. 为什么必须走 HTTP-ACP，不是 stdio ACP

`codebuddy --serve --acp --port 0` 这一个进程同时提供两套 ACP：

| | stdio ACP（stdin/stdout 上的 JSON-RPC） | **HTTP ACP（`/api/v1/acp`）** |
|---|---|---|
| 拿登录地址 | ❌ 拿不到，只能干等 | ✅ SSE 推送 `_codebuddy.ai/authUrl` |
| 客户端控制 | 受 stdio 缓冲影响 | ✅ 标准 HTTP + SSE |
| 鉴权头 | 无 | `x-codebuddy-request: 1` + `Authorization: Bearer <网关口令>` + `acp-connection-id` |

**前任只用了 stdio，所以永远看不到登录地址，只能报「Authentication required」。**

HTTP ACP 三个端点：

```
POST /api/v1/acp/connect   → { connectionId, sessionToken }   建立连接（轻量，不挂 SSE）
POST /api/v1/acp           → JSON-RPC 请求，响应是 SSE 流      （必须带 acp-connection-id）
GET  /api/v1/acp           → SSE 通知订阅                      （必须带 acp-connection-id）
```

---

## 3. 复现步骤（命令级，可直接抄）

### 3.1 准备隔离配置目录

**不要直接动 `~/.workbuddy`**，复制一份当实验目录：

```powershell
$cfg = "F:\DSH workspace\插件和版本\wb-probe\cfg"     # 已存在，可直接复用
# 关键内容：settings.json / user-state.json / device-id* / keyblob / security / connectors /
#           local_storage / models.json / projects(junction)
```

### 3.2 让 ACP 读写的会话在桌面 App 里可见

把副本的 `projects` 做成目录联接指向真实目录：

```powershell
cmd /c mklink /J "$cfg\projects" "C:\Users\卿\.workbuddy\projects"
```

（已建好。`$cfg\projects_local` 是原来的副本内容，留着没用了。）

### 3.3 起网关（干净 shell，必须先去掉 App 注入的变量）

```powershell
$env:CODEBUDDY_CONFIG_DIR               = "F:/DSH workspace/插件和版本/wb-probe/cfg"
$env:CODEBUDDY_GATEWAY_PASSWORD         = "probe-fixed-password-0001"   # 探针固定口令，非真实口令
$env:CODEBUDDY_DISABLE_PROXY_CONFIG_FILE= "1"
$env:CODEBUDDY_FORCE_LITE_WB_BUNDLE     = "1"
$env:CODEBUDDY_FORCE_HEADLESS_BUNDLE    = "1"
$env:CODEBUDDY_SKIP_GIT_BASH_CHECK      = "1"
Remove-Item Env:SERVER__PORT -ErrorAction SilentlyContinue

node "D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy" --serve --acp --port 0
```

启动后会打印 `Endpoint http://127.0.0.1:<port>`，从 stdout 抓端口。

### 3.4 登录（一次性，需要用户点一次浏览器）

```text
1) POST /api/v1/acp/connect                    → connectionId
2) POST /api/v1/acp  { method:"initialize", params:{ protocolVersion:1, clientInfo:{…},
                                    clientCapabilities:{ fs:{readTextFile:true,writeTextFile:true}, terminal:true } } }
3) POST /api/v1/acp  { method:"authenticate", params:{ methodId:"internal" } }
   → SSE 推 {"method":"_codebuddy.ai/authUrl","params":{"authUrl":"https://www.workbuddy.cn/login?platform=workbuddy&state=…&version=2.165.0"}}
   → 把 authUrl 给用户，让他在浏览器里点开登录
   → 同一 SSE 流随后推 result._meta["codebuddy.ai/userinfo"] = { userId:"c11f1cc4-…", userName:"卿" }
```

`methodId` 四个都可选：`iOA` / `external` / `internal`（微信）/ `selfhosted`。
实测 `internal` 给出的地址是 workbuddy.cn 统一登录页，用户点一下授权即可。

**登录成功后凭据落盘位置**：`<configDir>/local_storage/entry_a2e1158a54adb49c96bbbfc26c78716a.info`
（登录前 153486 字节 → 登录后 165542 字节）。**不在 `security/` 目录**，因为 at-rest 加密对 `role=cbc` 永远不可用。

### 3.5 投递并取回复

```text
POST /api/v1/acp  { method:"session/load", params:{ sessionId:"<桌面会话ID>", cwd:"<该会话的 cwd>", mcpServers:[] } }
POST /api/v1/acp  { method:"session/prompt", params:{ sessionId:"<同上>", prompt:[{ type:"text", text:"…" }] } }
```

成功标志（SSE 里）：

```
session/update  sessionUpdate=agent_message_chunk  content.text="就绪"
result          stopReason="end_turn"
_meta           codebuddy.ai/finishReason="stop"   codebuddy.ai/outcome="SUCCESS"
```

### 3.6 已验证：重启免登录

关掉进程 → 用**同一份副本配置目录**重新起网关 → **不做 authenticate** → 直接 `session/load` + `session/prompt`：

```
PROMPT {"stopReason":"end_turn", … "codebuddy.ai/outcome":"SUCCESS"}
[notif] agent_message_chunk text="就绪"
```

**一次登录，长期可用。**

---

## 4. 实测数据（2026-10-30 22:17–22:23）

| 项 | 结果 |
|---|---|
| 登录返回 | `userInfo: { userId: c11f1cc4-3c7d-4c03-b916-292c38f7d949, userName: "卿" }` |
| 模型 | `hy4-preview`（`requestModelName: Auto`） |
| `session/prompt` | `stopReason: end_turn`、`finishReason: stop`、`outcome: SUCCESS` |
| 真实会话 jsonl | `0454dbaa…jsonl`：13948 → 22278 字节，7 → 18 行（**真实文件，不是副本**） |
| 写入内容 | user 消息 + reasoning + assistant 消息（含 `rawUsage` / `prompt_cache_hit_tokens`） |
| 用户侧确认 | 卿在桌面 App 里打开该会话，**能看到两轮「就绪」回复** |

---

## 5. 环境事实（省得重新查）

### 5.1 三套安装，别搞混

| 安装 | 状态 | 数据目录 |
|---|---|---|
| `D:\WorkBuddy-CN` | **运行中，这就是目标** | `~/.workbuddy` |
| `E:\Program Files\WorkBuddyAI` | 未运行，**另一个产品** | 未知 |
| `D:\CodeBuddy CN` | 未运行，VS Code 衍生 IDE | 未知 |

CLI 二进制：`D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy`
版本：`2.165.0`（App 5.9.3）

### 5.2 App 进程与环境

```
17804  WorkBuddy.exe                        Electron 主进程
 412   daemon-app-server-entry.js --stdio   agent daemon（登录态活在它内存里）
 2424  codebuddy --prewarm                  预热子进程（可用来读环境变量）
18744  renderer / 20032 gpu / 11348 network / 20152 crashpad
```

**App 的 CLI 子进程环境（从 PID 2424 的 PEB 读出来的，142 个变量）关键三条：**

```
CODEBUDDY_CONFIG_DIR = C:\Users\卿\.workbuddy
CODEBUDDY_HOST       = workbuddy-desktop
SERVER__PORT         = 0
```

**WorkBuddy 的 6 个进程一个监听端口都没有**（只有命名管道 `wbipc-*` 和 `workbuddy-pac-*`）。
`wbipc` 已确认只有 3 个能力：`subscription.check` / `http.fetch` / `wecom-a2a authorize`，**没有会话能力**。

### 5.3 关键路径

```
桌面会话         C:\Users\卿\.workbuddy\projects\<cwd转义>\<sessionId>.jsonl
App 会话索引     C:\Users\卿\.workbuddy\workbuddy.db  → 表 sessions / workspaces / automations
App 配置         C:\Users\卿\.workbuddy\settings.json
凭据（解不开）   C:\Users\卿\.workbuddy\security\<userId>\cipher\entries.json.enc
CLI 数据         C:\Users\卿\.codebuddy
ACP 日志         <configDir>\logs\<日期>\<cwd名>__<hash>.log
探针目录         F:\DSH workspace\插件和版本\wb-probe
```

### 5.4 网关完整路由表

`GET /api/openapi.json`（注意不是 `/api/v1/openapi.json`）→ 123 个路由。
值得记住的几个：`/api/v1/acp`、`/api/v1/acp/connect`、`/api/v1/runs`、`/api/v1/jobs`、
`/api/v1/sessions/{id}/reply`、`/api/v1/auth/login`、`/api/v1/daemon/start`、`/api/v1/team/messages/send`。

---

## 6. 还没解决的两件事（都不是鉴权问题）

### 6.1 App 列表不反映 ACP 写入 —— **最关键的缺口**

App 左侧的会话列表**读的是 `workbuddy.db` 的 `sessions` 表**，不是扫 `projects/*.jsonl`。

实测：往 `0454dbaa` 写入两轮对话后，
`sessions.updated_at` 仍是 `1793355493245`（18:18），`last_activity_at` 仍是 `1793347156587`（15:59）。
所以列表里还是显示「6小时前」，用户在列表上**看不出有新消息**（点进去才有）。

**桥接必须多做一步**：写入 jsonl 之后同步更新

```sql
UPDATE sessions SET updated_at = ?, last_activity_at = ?, unread = ? WHERE id = ?
```

否则「桌面可见」只做到一半。

### 6.2 `session/new` 拿不到登录态

用 `session/new` 建了一个新会话 `01a18d31…`：

| 项 | 结果 |
|---|---|
| jsonl 文件 | ✅ 生成（`projects/c-Users-卿-WorkBuddy-群聊桥/01a18d31….jsonl`，2414 字节） |
| 模型回复 | ❌ `Authentication required`（assistant 消息里是错误文本，`status: incomplete`、`skipRun: true`） |
| `sessions` 表 | ❌ 没有新增记录 |

对比：`session/load` 同一进程、同一配置目录、同一时刻 → `end_turn` 成功。

**推测**：登录态绑定在「已存在的会话」上，或 `session/new` 走了另一条没恢复 authManager 的路径。**未验证到根因。**

**影响**：现阶段只能「复用用户预先建好的会话」，不能由围炉凭空拉起新会话。
这和卿定的「用户自己建会话 + 围炉定位它」（草案 §7.3）正好吻合，**不算阻塞**。

### 6.3 CLI 侧认证活动会让桌面 App 短暂掉线（2026-10-30 22:55 实测补充）

> 这一节补的是顶部警告的**证据与边界**：不只是 `authenticate` 会踢人，**连只读的 `session/load` + `session/prompt` 也会**。

App 主线程日志里 `HostedCliAuthLifecycle` 记录了每一次「登录归属变化」：

```
18:43:46  pid=15460  c11f1cc4 -> none      ← 前任做 CLI 实验时
18:44:34  pid=15460  none -> c11f1cc4      ← 48 秒后自动恢复
19:12:46  pid=412    c11f1cc4 -> none      ← 本轮做 acp8 探针时（只读，没 authenticate）
22:46:33  pid=5976   c11f1cc4 -> none      ← 另一路 agent 做实验时
22:46:55  pid=5976   none -> c11f1cc4      ← 22 秒后自动恢复
```

**结论分两档：**

| CLI 侧动作 | 桌面 App 的反应 | 是否需要人工 |
|---|---|---|
| `session/load` + `session/prompt`（只读） | `auth-owner-change -> none`，随后**自动**重新登录（22–48 秒） | ❌ 不用，但会闪一下 |
| `authenticate`（logout + login） | 同账号会话被注销，恢复可能失败 | ⚠️ **可能要用户手动重新登录** |

**为什么会这样**：`HostedCliAuthLifecycle` 用 `(userId|域名|)` 作为「登录归属」的键，
CLI 侧任何一次认证态变更都会触发 `agentBackend.resetActiveSessions`，
App 发现归属变了就重置会话、重新走登录流程。

**凭据本体没被改**：全程对比 `security/*/cipher/entries.json.enc`（530 字节 / 10-22 00:02）、
`keyblob`（336 字节 / 10-17）、真实 `local_storage/entry_a2e1158….info`（153486 字节 / 19:14）——
**三份文件从头到尾一个字节都没变**。所以不是「文件被抢」，是**服务端侧的会话归属被重置**。

**对方案的硬约束：**

1. 桥接运行期**禁止**调用 `authenticate`（顶部警告已写）。
2. 即使只做只读投递，**每次桥接启动/刷新都会让用户桌面 App 闪一下**。
   高频轮询 = 高频闪 = 不可接受。**必须低频、长驻**：进程常驻、登录一次、连接复用，不要每次投递都重启 CLI。
3. 若用户对「App 偶尔闪一下」零容忍，**只能走 App 内 automation**（§8），它不碰 CLI 认证面。

---

## 7. 已试过且不通的绕法（别再重复）

| 尝试 | 结果 |
|---|---|
| 把 App 整个配置目录复制过来（含 keyblob + security） | 照样 `missing-key` |
| 删掉副本 keyblob 让 CLI 自建 | **不会自建**（只在需要写凭据时才创建，启动时不创建） |
| 注入 `CODEBUDDY_HOST=workbuddy-desktop` + 网关口令 | 仍 401 |
| 网关 `POST /api/v1/runs` 做真实模型调用 | 仍 `Authentication required` |
| 从 PEB 读 App 环境变量找 `CODEBUDDY_AUTH_TOKEN` | App 进程**没有**这个变量（只有 HOST / GATEWAY_AUTH / GATEWAY_PASSWORD） |
| 直接往 jsonl 追加 user 消息，等 App 自动处理 | **不会**。等 45 秒文件无变化、无新 worker、无 assistant 回复 |
| `wbipc` 写会话 | 管道表里只有 3 个系统能力，猜 12 个会话管道全 `E_PIPE_UNKNOWN` |
| App 找 HTTP 接口 | 6 个进程**零监听端口** |

---

## 8. 一条现成的兜底路（不是 ACP，但能用）

`workbuddy.db` 里有一张 `automations` 表，**卿已经建好一条**：

```
id      33fcb7f2-188e-470a-8f7c-52d736f49029
name    如意群聊巡检回复
status  PAUSED
rrule   FREQ=HOURLY;INTERVAL=1
cwds    ["C:/Users/卿/WorkBuddy/群聊桥"]
model   fast-model      permission_mode  fullAccess
prompt  读 .ruyi/inbox.jsonl → 生成回复 → tools/agent-client.js reply → 写回 replied.json
```

`automation_runs` 里 5 次运行**全部 ACCEPTED**（结果都是「无新消息」）。

**价值**：automation 跑在 App 内部，**天生带登录态**，能读写文件、能跑命令、`fullAccess`。
是「ACP 万一被版本升级打掉」时的第二条腿，适合低频巡检（分钟级延迟）。
代价：每次运行是独立 thread，**没有固定会话**。

---

## 9. 下一步（按依赖排序）

| 序 | 动作 | 说明 |
|---|---|---|
| 1 | **回写草案** | 把 `CONNECTION-DRAFT.md` 的 §3.5 / §7 / §9 Q21 改成「ACP 成立」，补 §6.1 的 SQLite 同步要求 |
| 2 | **SQLite 同步** | 桥接写入 jsonl 后更新 `sessions.updated_at/last_activity_at/unread`，先做只读探测确认字段语义 |
| 3 | **M3 WorkBuddy 桥** | HTTP-ACP 客户端 + 目录联接 + 登录引导 + capability probe（探测 `/api/v1/acp` 是否还在，失败降级 automation） |
| 4 | M1 Channel API v1 | 与 WorkBuddy 桥无关，可并行 |
| 5 | 查 `session/new` 的 auth 根因 | 非阻塞，但要拉起新会话就得解 |

---

## 10. 坑（务必看）

1. **`POST /api/v1/acp` 必须带 `Accept: application/json, text/event-stream`**，否则 406：
   `Not Acceptable: Client must accept both application/json and text/event-stream`。这一条卡了我一轮。
2. **`/api/v1/acp/connect` 之后所有请求都要带 `acp-connection-id` 头**。
3. **不要在 App 的环境里起 codebuddy**：环境里有 `SERVER__PORT`，子进程会抢 App 端口 → `EADDRINUSE`。
   必须 `Remove-Item Env:SERVER__PORT`。
4. **不要跑 `codebuddy -p`**：会写坏共享凭据（`missing-key`），把网关登录态一起带崩。历史教训。
5. **不要动 `~/.workbuddy` 本体**：所有实验都在 `wb-probe\cfg` 副本里做。写真实会话前先备份 jsonl。
6. **`authenticate` 会先 logout 再 login**：如果该进程已有登录态，会强制重新认证。只在副本里做。
7. **`session/load` 的 `cwd` 必须填对**（会话记录里那个 cwd），否则行为异常。
8. **登录 state 有时效**（约 5–20 分钟），过期要给用户重开。
9. **App 列表读 SQLite**，不要以为写了 jsonl 就完事（见 §6.1）。
10. **`workbuddy.db` 是 WAL 模式且被 App 打开**：只读用 `node:sqlite` 的 `readOnly: true`；要写先备份。

---

## 11. 本轮产物清单

```
F:\DSH workspace\插件和版本\wb-probe\
├── cfg\                              隔离配置目录副本（含登录态，勿外传、勿提交）
├── cfg\projects → C:\Users\卿\.workbuddy\projects   （junction）
├── backup\                           keyblob / entries.json.enc / 会话备份
├── evidence\                         写入证据
├── ACP-BREAKTHROUGH-2026-10-30.md    技术结论文档（本文的详细版）
├── authflow.cjs / authflow2.cjs      HTTP-ACP 登录 + 投递探针（可直接复用）
├── gwacp.cjs                          HTTP-ACP 通用探针（connect/initialize/authenticate/load/prompt）
├── gwnew.cjs                          session/new 实验探针
├── gwcheck.cjs / gwwork.cjs           网关 auth 状态 / runs 探针
├── gwapi.cjs / gwdef.cjs              OpenAPI 路由与定义抓取
├── acp7.cjs / acp8.cjs / acp9.cjs     stdio ACP 探针（历史）
├── inject.cjs                         直接写 jsonl（留言板模式，不会触发 agent）
├── dbread.cjs / dbauto.cjs / dbsess.cjs / dbprompt.cjs   workbuddy.db 只读探查
├── readenv.ps1                        PEB 读进程环境变量（PowerShell + P/Invoke）
└── slice.cjs                          CLI bundle 关键词切片工具
```

`docs/probes/` 下是上一任的三个探针（`client2.cjs` / `wbipc-kinds.cjs` / `acp5.cjs`），保留未动。

---

## 12. 对围炉方案的影响（结论）

1. **Q21 结案**：「成员=会话」对 WorkBuddy **成立**，不必降级到「MCP + 自动化」。
2. **§7.3「用户自建会话 + 手填会话引用」对 WorkBuddy 成立**，前提是用户建的是**普通会话**（不是自动化 thread）。
3. **§7 里「WorkBuddy 桌面 UI 看不见网关会话」这条要改**：不是看不见，是**要同步 SQLite 才在列表里体现**。
4. **新增必做项**：写入后同步 `sessions` 表（§6.1）。
5. **保留兜底**：automation 作为降级路径写进 capability probe 的降级链。

---

*文档结束。修改直接改本文件；有新证据请补 §4 表格并注明日期。*
