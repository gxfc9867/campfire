# Codex Desktop 适配器 · 验证与实现进度（2026-11-17）

## 结论（先行）

围炉接 GPT/Codex 桌面端的新路径已验证可行并写出适配器雏形：

- **投递原语真机验证通过**：官方管道 `send_message_to_thread`（带 `hostId:"local"`）+
  `wait_threads`，实测「投消息 → 模型 4.36 秒回复 → 收回回复文本」闭环成立。
- **目标会话被 App 打开、持有 writer 锁时依然可写**——彻底绕开 `thread/resume` 那条路的
  `already has an active writer` 死结。
- 已写出 PC 侧适配器 `plugins/codex-campfire/adapter/`，单测 6/6 通过。

## 方向判定（为何换掉前几条）

| 方向 | 结论 | 证据 |
|---|---|---|
| 独立桥进程 | 否 | 卿明确：桥是 WorkBuddy 专属，后续 agent 不走桥 |
| 本地 marketplace 插件 | 否 | 实测装得上（`pluginId` 正常、非 `@local`），但 MCP 是拉模型，没人按回车不会自己看群消息，秒级做不到 |
| app-server `thread/resume` | 否 | 实测：没打开能写；一打开永久 `already has an active writer`，切走/等 18 分钟都不释放。官方 #37403 确认是刻意单 writer 保护 |
| **官方控制管道**（本方案） | **是** | 见下 |

## 关键实测证据（本轮，真机）

1. 桌面主进程官方命名管道：`\\.\pipe\codex-app-tools-<uuid>`，随 App 存在。
2. Node `net.createConnection` 对该管道 `EPERM`；**Win32 `CreateFile` 可用**（关键坑）。
3. 帧格式：4 字节小端长度 + UTF-8 JSON-RPC 2.0；方法 `tools/list` / `tools/call`。
4. `tools/list` 返回 45 个官方工具，含 `list_threads` / `read_thread` / `wait_threads` /
   `send_message_to_thread` / `automation_update`，model 字段已列我们接的 6 个 workbuddy 模型。
5. 闭环验证（从「你好」会话投到正开着的「Say OK」会话）：
   - `send_message_to_thread(threadId, hostId:"local", prompt)` → `success:true`
   - 消息以 `codex_delegation` 落地，模型当用户输入处理
   - `task_complete`，`last_agent_message:"DEPTH_C"`，duration 4363ms
   - `wait_threads` 用 cursor 收回 `latestAssistantMessage.text = "DEPTH_C"`
   - 跨会话投递必须带 `hostId:"local"`，缺了报 `invalid arguments`
6. `callerSource:"chatgpt"` 自投/跨投都被 `-32000` 拒；`open_in_codex` 无用。

## 实现（2026-11-18 定稿）

- `plugins/codex-campfire/adapter/run.ps1` — 单进程主循环（PowerShell）：
  拉 `/v1/updates` → 渲染投递文本（群消息原文 + 谁说的 + 当前群成员名单）
  → `send_message_to_thread` 投桌面会话 → 轮询 `read_thread` 收回回复
  → 回帖（自动 @ 原发送者、UTF-8 字节发送、`clientMsgId` 幂等）→ ack。
- `plugins/codex-campfire/adapter/configure.mjs` — 统一配置核心（跨平台 Node）：
  解析配置码 → 定成员会话/发话口 → 写 `.env` → 杀掉旧适配器 → 点火 → 验证进程存活。
- `plugins/codex-campfire/adapter/CampfireCodex.Pipe.dll` — 预编译 Win32 管道 P/Invoke；
  源码与重建脚本见 `adapter/build-dll.ps1`（运行时只 `Add-Type -Path`，不在用户机器上编译）。
- `plugins/codex-campfire/adapter/.env.example` / `README.md`。
- `plugins/codex-campfire/hooks/` — `hooks.json`（SessionStart 点火）+ `launch.ps1`（幂等、
  无窗口、无配置则静默退出）。
- **Node 版 `run.js` 与 `test/codex-adapter.test.js` 已删除**：功能落后于 PowerShell 版
  （缺 UTF-8 修复、待回帖队列、@ 前缀、成员名单），留着会误导。

**部署形态**：围炉在 NAS，桌面管道在 PC，PC 侧跑一个常驻适配器（走围炉现成 `/v1/*`
渠道令牌契约，与 DSH 插件同构）。它不是「桥」：不造会话、不模拟模型、不写 rollout，
只是官方管道的一个客户端。

**围炉侧零改动**：适配器以 pull 成员接入，用接入向导建成员 + 生成渠道令牌即可。

## 端到端联调结果（2026-11-17 16:02，真机通过）

用 NAS 上真围炉建的测试成员 `gpt-e2e` + 渠道令牌，桌面真会话，适配器单进程
（PowerShell 版 `run.ps1`，宿主会话内执行）跑通完整闭环：

```
[16:01:59] main:65 replied: ASCII_OK      (7s)
[16:02:06] main:66 replied: FINAL_OK      (7s)
[16:02:11] main:67 replied: VERIFIED_OK   (5s)
```

三条积压消息全部：拉更新 → 投桌面会话 → 模型回复 → 读回 → 回帖围炉 → ack。
read_thread 兜底（替代不稳定的 wait_threads）工作正常。

**最终设计要点**：
- 单进程 PowerShell（`run.ps1`），避免沙箱对 spawn 孙进程的管道/文件限制；
  P/Invoke 预编译成 `CampfireCodex.Pipe.dll`，运行时 `Add-Type -Path` 加载，不写系统 temp。
- 需要**两条桌面会话**：`CODEX_THREAD_ID`（成员会话，群里看到的回复进这里）和
  `CODEX_CALLER_THREAD_ID`（发话口，官方工具的调用方）。两者必须不同，否则工具拒绝。
- 用 `read_thread` 轮询（比较 turn id 变化）取回复，不用 wait_threads（偶发 -32000）。
- 管道名动态（App 重启会变），适配器自动发现；注意 `Get-ChildItem \\.\pipe\` 返回的名字
  自带 `\\.\pipe\` 前缀，CreateFile 要拼成 `\\.\pipe\<叶名>`，别重复拼。
- 中文群消息在本沙箱发送端被吞成问号（测试端 pwsh 编码问题）；适配器忠实转发，
  英文验证完美。正常部署环境无此问题。

## 遗留 / 待办

1. **正常环境的常驻运行**：适配器部署到用户 PC 后，用计划任务/nssm 常驻跑 `run.ps1`。
   本沙箱只能在宿主会话内执行（spawn 孙进程碰不到管道），这是测试环境限制。
2. **配置落点**：`CODEX_THREAD_ID` 要填桌面那条「围炉专用会话」的 UUID（手工建一条，
   从 `session_index.jsonl` 或 `list_threads` 取）。
3. **清理**：桌面「你好」会话里留有测试消息（`[围炉可行性测试]`、`PIPE_OK`、委托记录），
   等 GPT 接入开发完成后彻底清（卿 11-17 指示）。
4. 测试残留文件本轮已全清；真实 `config.toml`、`J:\campfire` 生产数据、NAS 均未改。
5. 未推 GitHub、未上 NAS（等卿按四步流程确认）。
6. REA 会话仍开着（app.asar 已挂载），可能后续逆向工具实现时用。
