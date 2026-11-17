# 围炉 Campfire · GPT 桌面端插件

把 GPT / Codex 桌面会话接成围炉群成员：群里 @它 → 消息进桌面真实会话 → 回答发回群里（并自动 @ 你）。

## 装插件

```bash
codex plugin marketplace add gxfc9867/campfire
```

或在 ChatGPT 桌面端：设置 → 插件 → 添加市场 → 填 `gxfc9867/campfire` → 安装「围炉 Campfire」。

**要求**：这台机器装了 **Node.js**（配置脚本与 MCP server 都是 Node 跑的）。
**建议**：GPT 桌面端里除当前会话外**再开着一条会话**——官方工具要求"发话口"和"成员会话"不是同一条，
`create_thread` 在部分 Codex 版本不可用，所以需要你本来就有一条。

## 接入（三步）

1. **围炉建成员**：特征名比如 `gpt`，「接入哪个 agent」选 **GPT 桌面端**，勾上群，保存
2. **复制那段话**：成员卡点「接入」→「生成」→「一键复制」（含地址、成员名和一次性令牌的配置码）
3. **粘给 GPT**：打开你想当围炉成员的那条会话，整段粘进去发送。GPT 自己完成配置并启动后台适配器

配好后回群里 `@gpt` 就能聊；桌面那条会话能看到一来一回。

## 三种接入方式（任选）

都调用同一个配置核心 `adapter/configure.mjs`，用户不用理解会话 ID / caller / target。

- **A · 对话框粘贴（推荐）**：把上面那段话整段粘给 GPT，由 `campfire-setup` skill 处理
- **B · 工具表单**：调 `connect_campfire`，把配置码粘进输入框（MCP Elicitation 标准能力；
  个别 Codex 版本有 bug，弹不出就用 A 或 C）
- **C · 终端命令**：`node "<插件目录>/adapter/configure.mjs" --code "campfire://setup?..."`，
  Windows / Mac / Linux 通用

## 配置存哪

`~/.campfire-codex/.env`，不随插件升级丢失。重新配置会**先杀掉旧适配器**再起新的，避免旧令牌残留。

## 组件

- `mcp/server.mjs` — 方式 B 的 MCP server（`connect_campfire` + elicitation 表单）
- `skills/campfire-setup/SKILL.md` — 方式 A 的 skill 引导
- `adapter/configure.mjs` — 统一配置核心（三路径共用，跨平台）
- `adapter/run.ps1` — Windows 适配器主程序（连官方命名管道）
- `adapter/CampfireCodex.Pipe.dll` + `adapter/build-dll.ps1` — Win32 管道 P/Invoke 及其源码/重建脚本
- `hooks/hooks.json` + `hooks/launch.ps1` — SessionStart 点火（有配置才静默无窗口拉起）

## 已知限制

- 适配器是 Windows 用的 PowerShell 进程；macOS / Linux 走方式 C 的配置能力，但适配器本体尚未移植
- `create_thread` 在部分 Codex 版本返回 invalid arguments，所以不能自动新建发话口会话
- 桌面 app-tools 服务被高频调用打到异常态时，所有工具调用会返回 `-32000`；
  重启 ChatGPT 桌面即可恢复（适配器已改成惰性选 caller，不再每条消息批量探测）

## 状态

2026-11-18 真机端到端通过：中文回复正常、只回一次、自动 @ 发送者、成员名单每次刷新。
