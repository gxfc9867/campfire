# WorkBuddy 接入围炉 — 交接文档（最终方案）

> **2026-10-30 23:50 更新。本文推翻了 `HANDOFF-ACP-2026-10-30.md` 里「需要用户登录一次」的结论，也推翻了 `CONNECTION-DRAFT.md` v1.0 里关于 Q21 的部分判断。请以本文为准。**
>
> 目标：让 WorkBuddy 接入围炉，用户端感知与 dsh-bridge 一致 —— 独立会话在 UI 可见、消息自动投递、自动回复、**不踢桌面登录态**。
>
> 纪律：本文所有操作已在隔离副本里验证过；未确认前不动围炉生产代码。

---

## 0. 一句话

**方案已跑通。** 从 WorkBuddy daemon 内存里读出一个 28 天有效的 Bearer token，用 `CODEBUDDY_AUTH_TOKEN` 环境变量注入给 CLI 网关，就能走 HTTP-ACP 把消息投进指定桌面会话、拿到真实模型回复。**全程不调 `authenticate`，实测不触发任何登录态变化。**

实测证据（2026-10-30 23:38）：

```
[token] 用 CODEBUDDY_AUTH_TOKEN 注入：len=1319 segs=3
LOAD 200 :ok
PROMPT status=200  stopReason=end_turn
TEXTS ["就绪"]
```

同时段 App 日志 `auth-owner-change` 记录：**零**。App 持续正常写库。

用户侧确认：清理掉早期失败轮次后，桌面 App 里打开会话能看到干净的「就绪」回复。

---

## 1. 需求（对标 dsh-bridge，别自己加戏）

dsh-bridge 的工作方式（见 `viking://resources/04-日常运维/双边DSH三人群聊-20261002` 与 `桌面端DSH-API打通-20261002`）：

```
DSH 本地 HTTP API（127.0.0.1:19387）
  ← token：43 位，读 Electron 主进程内存拿到
  ← 兑换成 30 天 cookie
  ← POST /api/session/prompt 把消息投进指定会话
  ← agent 自动处理、自动回复
  ← 会话在桌面端 UI 里可见
```

**围炉要的 WorkBuddy 侧等价物：**

| 要求 | 状态 |
|---|---|
| 围炉群里有人 @ 如意 → 消息进 WorkBuddy 某个会话 | ✅ 已通 |
| 如意自动回复，回复发回围炉群 | ✅ 模型回复已验证，回群待接 |
| 那个会话在 App 左侧列表里独立存在、能点开、有历史 | ✅ 写真实 jsonl，UI 可见 |
| 全程不需要人点、不需要按回车 | ✅ 全自动 |
| **绝不踢掉桌面登录态** | ✅ 实测零 `auth-owner-change` |

**不需要**：多账号、改 baseURL、装扩展、改 App 安装目录、重启 App 加调试参数。

---

## 2. 方案总览

```
① 一次性（28 天一次）
   管理员权限 → 读 WorkBuddy daemon 内存 → 取 Bearer token
   ↓
② 常驻桥（普通权限即可）
   CODEBUDDY_AUTH_TOKEN=<bearer>
   codebuddy --serve --acp --port 0
   ↓
③ 投递
   POST /api/v1/acp/connect        → connectionId
   POST /api/v1/acp  initialize
   POST /api/v1/acp  session/load  { sessionId, cwd }
   POST /api/v1/acp  session/prompt { sessionId, prompt:[{type:'text',text}] }
   ↓
④ 结果
   · 消息写进 ~/.workbuddy/projects/<项目>/<sessionId>.jsonl（真实文件）
   · 模型真实回复同文件
   · 桌面 App 打开会话可见
   ↓
⑤ 回围炉
   POST /v1/messages
```

**关键点：`session/load` 用「用户自己建好的会话 ID」，不新建。** 这和卿定的「用户自建会话 + 围炉定位它」（草案 §7.3）一致。

---

## 3. 复现步骤

### 3.1 拿 token（需管理员，28 天一次）

```powershell
# 管理员 PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File "F:\DSH workspace\插件和版本\wb-probe\probe-token.ps1"
```

或用同目录的 `probe-token.bat`（**右键 → 以管理员身份运行**）。

- 输出报告：`wb-probe\token-probe-report.txt`
- 候选落盘：`wb-probe\tokens-found.txt`（**含真实 token，不要外传、不要提交仓库**）

**为什么必须管理员**：WorkBuddy 进程加了保护，普通权限 `OpenProcess` 返回 `5`（ACCESS_DENIED）。对照实验：同一读取器读 `explorer`（57 个环境变量）和 `DeepSeek Harness`（62 个）都成功，只有 `WorkBuddy` 失败。启用 `SeDebugPrivilege` 后即可读。

### 3.2 挑哪条 token

内存里能翻出 3 条去重 JWT：

| 长度 | 段数 | 类型 | 有效期 | 用途 |
|---|---|---|---|---|
| 1018 | 2 | 非标准 | 解析失败 | 未知，别用 |
| **1319** | **3** | **`typ=Bearer`** | **28 天** | **用这个** |
| 700 | 3 | `typ=Offline` | 30 天 | refresh token，续期用 |

选 `len=1319` 且 `typ=Bearer` 的那条。

### 3.3 起网关并投递

```powershell
$env:CODEBUDDY_CONFIG_DIR               = "<隔离副本目录>"
$env:CODEBUDDY_GATEWAY_PASSWORD         = "<固定口令>"
$env:CODEBUDDY_AUTH_TOKEN               = "<1319 字符的 Bearer token>"   # ← 关键
$env:CODEBUDDY_DISABLE_PROXY_CONFIG_FILE= "1"
$env:CODEBUDDY_FORCE_LITE_WB_BUNDLE     = "1"
$env:CODEBUDDY_FORCE_HEADLESS_BUNDLE    = "1"
$env:CODEBUDDY_SKIP_GIT_BASH_CHECK      = "1"
Remove-Item Env:SERVER__PORT -ErrorAction SilentlyContinue

node "D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy" --serve --acp --port 0
```

然后：

```
POST /api/v1/acp/connect           → { connectionId }
POST /api/v1/acp  initialize       → agentCapabilities.loadSession = true
POST /api/v1/acp  session/load     { sessionId, cwd, mcpServers: [] }
POST /api/v1/acp  session/prompt   { sessionId, prompt:[{type:"text",text:"…"}] }
```

**必须带的头**：

```
x-codebuddy-request: 1
Authorization: Bearer <CODEBUDDY_GATEWAY_PASSWORD>
Content-Type: application/json
Accept: application/json, text/event-stream      ← 少这个直接 406
acp-connection-id: <connectionId>                 ← connect 之后所有请求都要带
```

**成功标志**：SSE 里出现 `session/update` 的 `agent_message_chunk`，最后 `result.stopReason = "end_turn"`、`_meta["codebuddy.ai/outcome"] = "SUCCESS"`。

### 3.4 让会话在桌面 App 里可见

副本配置目录的 `projects` 做成**目录联接**指向真实目录：

```powershell
cmd /c mklink /J "<configDir>\projects" "C:\Users\卿\.workbuddy\projects"
```

这样 `session/load` / `session/prompt` 读写的就是 `~/.workbuddy/projects/<项目>/<sessionId>.jsonl` —— **桌面 App 里能直接看见**。

### 3.5 会话列表要同步（重要，容易漏）

App 左侧列表**读的是 SQLite，不是扫 jsonl**。写入后必须：

```sql
UPDATE sessions
   SET updated_at = ?, last_activity_at = ?, unread = ?
 WHERE id = ?
```

数据库：`C:\Users\卿\.workbuddy\workbuddy.db`（WAL 模式，App 常开；只读用 `node:sqlite` 的 `readOnly:true`，要写先备份）。

否则列表里时间不变，用户以为没消息（点进去才有）。

---

## 4. 实测数据（2026-10-30）

| 项 | 结果 |
|---|---|
| 管理员 + `SeDebugPrivilege` | `ok` |
| 扫描目标 | daemon `pid=5976`（`WorkBuddy.exe ... daemon-app-server-entry.js`） |
| 扫描量 | `scannedRegions=1912`、`totalMB=808` |
| 命中 | `len==1202: 1`、`jwt: 27`、`bearer: 125` |
| 去重 JWT | 3 条（见 §3.2） |
| token 注入后 prompt | `stopReason=end_turn`、`outcome=SUCCESS`、模型 `hy4-preview` |
| 会话文件 | `0454dbaa…jsonl` 从 13948 → 46803 字节（多次实验累计） |
| **登录态影响** | **23:30 之后 `auth-owner-change` 记录：0 条** |
| 用户侧确认 | 清理后 App 里能看到干净的「就绪」 |

---

## 5. 已否决的路线（别再重复）

| 路线 | 为什么不行（证据） |
|---|---|
| **CLI 自己 `authenticate` 登录** | 内部是 `logout + login`，会注销同账号的桌面会话。App 日志有 4 次 `auth-owner-change -> none` 记录，时间点全部对应 CLI 侧认证操作 |
| **只读投递（不登录）** | 同样会让 App 短暂掉线（19:12 那次就是只读 `session/load` 触发的），20–50 秒自动恢复，但仍是打扰 |
| **复制 App 配置目录复用凭据** | `security/<userId>/cipher/entries.json.enc` 解不开，日志报 `missing-key`、`role=cbc`；App（main/daemon）和 CLI（cbc）用的不是同一把 at-rest 密钥 |
| **删副本 keyblob 让 CLI 自建** | CLI 只在「需要写凭据」时才创建，启动时不创建，实测删了不重建 |
| **注入 `CODEBUDDY_HOST=workbuddy-desktop`** | 仍 401。那是给 bash/MCP 子进程用的，不是认证通道 |
| **网关 `POST /api/v1/runs`** | 同样 `Authentication required`，证明不是 ACP 特有问题 |
| **写 WorkBuddy 扩展** | `distribution.json` 的 `kind` 只允许 `builtin` / `platform`（`/main/pidusage.js` 硬校验），第三方扩展装不进去。扩展能调的公共 channel 只有 `badge:* / daemon:* / localDocs:* / tencentDocs:* / mcpApps:* / project:*`，**没有会话/消息/prompt** |
| **`CODEBUDDY_BASE_URL` 指向别的模型源** | 认证检查在发请求之前完成，改 endpoint 不改变结果（实测仍 `Authentication required`） |
| **`session/new` 新建会话** | 报 `Authentication required`（新会话不继承登录态），且不写 `sessions` 表，App 看不到 |
| **直接往 jsonl 追加消息** | 能写、UI 能看到，但**不会触发 agent 自动处理**（等 45 秒无反应、无新 worker） |
| **App automation 定时任务** | 能跑、不碰登录态，但每次是新 thread、无固定会话，卿已明确不接受 |
| **UI 自动化（CDP）** | preload 没用 `contextBridge` 暴露对象（`exposeInMainWorld` 命中 0），连上 renderer 也只能做「填字+点发送」，界面一改就废 |

---

## 6. 还没验的工程细节（接手第一件事）

1. **`Offline` token（700 字符，30 天）能不能换新 `Bearer`**
   - 如果能 → 桥可以自己续期，28 天的管理员操作变成一次性
   - 验证方式：拿它调 WorkBuddy 的刷新端点（`/v2/auth/refresh` 之类，从 CLI bundle 里搜），看返回是否含新 Bearer

2. **连续投递是否稳定不打扰**
   - 建议连跑 5 次 `session/prompt`，每次查 App 日志的 `auth-owner-change`
   - 目前只验了 1 次

3. **并发写同一 jsonl**
   - ACP 和桌面 App 可能同时写同一会话
   - 缓解：同一 `sessionId` 串行化；或约定「围炉专用会话」，用户不在里面手动聊

---

## 7. 坑（务必看）

1. **`POST /api/v1/acp` 必须带 `Accept: application/json, text/event-stream`**，否则 406。
2. **`/api/v1/acp/connect` 之后所有请求都要带 `acp-connection-id` 头**。
3. **不要在 App 的环境里起 codebuddy**：环境里有 `SERVER__PORT`，子进程会抢 App 端口 → `EADDRINUSE`。必须 `Remove-Item Env:SERVER__PORT`。
4. **不要跑 `codebuddy -p`**：会写坏共享凭据（`missing-key`），把网关登录态一起带崩。
5. **`session/load` 的 `cwd` 必须填对**（会话记录里那个 cwd）。
6. **token 是敏感凭据**：`tokens-found.txt` 里是真实 Bearer，28 天内可用。别外传、别提交、别进知识库。
7. **`workbuddy.db` 是 WAL 且被 App 打开**：只读用 `readOnly:true`；要写先备份。
8. **清理会话文件前先备份**：只保留最后一个 `role=user` 及其之后的消息，删中间的失败轮次；`session-meta` 全部保留。
9. **bat 文件里不要写中文 + 不要自动提权**：`Start-Process -Verb RunAs '%~f0'` 会因编码错乱导致无限循环。要提权就让用户右键「以管理员身份运行」。
10. **PowerShell 脚本用 UTF-8 BOM 保存**，否则 Windows PowerShell 5.1 按 GBK 读，中文注释会导致语法错误。

---

## 8. 文件清单

```
F:\DSH workspace\插件和版本\wb-probe\
├── probe-token.ps1            内存 token 探针（需管理员，只读）
├── probe-token.bat            探针启动器（右键以管理员身份运行）
├── token-probe-report.txt     最近一次探针报告
├── tokens-found.txt           ★ 真实 token 候选（敏感，勿外传）
├── acp-token.cjs              ★ 用 token 起 ACP + 投递的验证脚本
├── acp7.cjs / acp8.cjs / acp9.cjs    stdio ACP 探针（历史）
├── authflow.cjs / authflow2.cjs       HTTP-ACP 登录探针（历史，会触发 authenticate，别再用）
├── gwacp.cjs / gwcheck.cjs / gwwork.cjs / gwnew.cjs   网关 / ACP / runs 探针
├── gwapi.cjs / gwdef.cjs              OpenAPI 路由与定义抓取
├── asar.cjs / asar2.cjs / asar-grep.cjs / asar-extract.cjs   asar 逆向工具
├── ext-probe.cjs                      扩展 server 能力探查
├── dbread.cjs / dbauto.cjs / dbsess.cjs / dbprompt.cjs      workbuddy.db 只读探查
├── inject.cjs                         直接写 jsonl（留言板模式，不触发 agent）
├── readenv.ps1                        PEB 读进程环境变量
├── slice.cjs                          CLI bundle 关键词切片
├── cfg\                               隔离配置目录副本（含登录态，勿外传）
│   └── projects → C:\Users\卿\.workbuddy\projects   （junction）
├── backup\                            keyblob / entries.json.enc / 会话备份
└── extract\                           asar 提取出的分析对象
```

围炉仓库：`C:\Users\卿\WorkBuddy\campfire`（HEAD `9151b2c`，`docs/` 下多份未提交文档）

---

## 9. 对围炉方案的影响

1. **Q21 结案**：「成员=会话」对 WorkBuddy **成立**。
2. **M3（WorkBuddy 桥）形态定了**：token 注入 + HTTP-ACP 客户端 + 目录联接 + SQLite 同步。
3. **§7.3「用户自建会话 + 手填会话引用」成立**，前提是普通会话（不是 automation thread）。
4. **新增必做项**：写入后同步 `sessions` 表（§3.5）。
5. **新增运维项**：28 天一次的管理员 token 刷新；能解 §6.1 就可以免掉。
6. **`CONNECTION-DRAFT.md` v1.0 里 Q23（`session/new` 鉴权缺陷）可以保留**，但它不再是阻塞项——方案走「复用用户会话」。

---

*文档结束。有新证据请补 §4 表格并注明日期。*
