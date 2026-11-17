# 围炉接 GPT 桌面端 · 配置码接入流程（2026-11-17）

## 目标

小白能自己走完：不用手改 `.env`、不用懂令牌/会话 ID、不用敲命令。

## 最终方案

**用户只做两步：围炉复制配置码 → GPT 插件粘贴配置码。**

```
围炉（建成员，类型 pull，driver.adapter=codex-desktop）
  └─ 接入向导「生成配置码」按钮
       └─ 配置码 campfire://setup?<base64(JSON{base,token,member})>
            └─ 用户复制
GPT 插件（codex-campfire，已装）
  └─ SessionStart hook 触发 launch.ps1
       ├─ 无配置 → 弹图形配置窗（setup.ps1）：
       │    粘贴配置码 → 从 session_index.jsonl 列会话 → 用户选成员会话
       │    → 自动写 ~/.campfire-codex/.env → 完成
       └─ 有配置 → 无窗口拉起适配器（VBS ws.Run ...,0）
            └─ run.ps1：就绪探测 → 投桌面会话 → read_thread 收回 → 回帖围炉
```

## 改动清单

围炉端（工作区 J:\campfire）：
- `public/index.html` — 接入向导加 `#connect-codex` 块（GPT 专用三步引导）
- `public/js/members.js` — `driver.adapter === 'codex-desktop'` 分支；配置码生成/复制

GPT 插件（`plugins/codex-campfire/`）：
- `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json` — GitHub marketplace 安装
- `hooks/hooks.json` — SessionStart(startup) hook
- `hooks/launch.ps1` — 点火器：无配置弹 setup 窗、有配置无窗口拉适配器、幂等
- `hooks/setup.ps1` — 图形配置窗：粘贴配置码、自动列会话、写 .env
- `adapter/run.ps1` — 适配器（就绪探测、错误日志、外部配置目录）
- `adapter/CampfireCodex.Pipe.dll` — 预编译 Win32 管道 P/Invoke

## 验证结果（2026-11-17）

- 配置码编解码：✅ 前端 Node 编码 / PowerShell 解码一致
- 会话自动枚举：✅ 从 session_index.jsonl 找到会话
- 隐藏 cmd 窗口：✅ VBS `ws.Run ..., 0` 实测无可见窗口且脚本执行
- 幂等点火：✅ 测试中验证过
- E2E 回帖：✅ `-File`（等同用户环境）回 `NODEGRADE_OK`（9 秒）/ `HOSTFULL_OK`（12 秒）
- JS 语法 / PowerShell 语法：✅ 全 0 错误

## 已知坑（已处理/待优化）

- caller 会话不能是当前被 App 打开的：就绪探测会轮换 cfg.caller / cfg.thread 找通的那条
- 桌面刚重启有会话加载窗口：就绪探测最多等 15 秒再开始投递
- 沙箱用 WMI 起的脱离进程连管道会 ACL 失败：环境问题，用户正常终端无此问题
- setup 会话列表混入了 codex_exec 历史会话：待优化过滤（不影响功能，用户能选对即可）

## NAS 部署（2026-11-17 19:30）

- SSH：用户名 `gxfc9867`，私钥 `~/.ssh/cage_nas`（不是 root/dsh 等）
- 部署目录 `/vol2/@appdata/campfire`，容器 `campfire`（image campfire:local，build: .）
- 前端打进镜像（只有 data 目录是挂载卷）→ 更新前端要 scp 文件 + `docker compose build campfire && up -d --force-recreate`
- 备份：`data.bak-20261117-1915`、`public/index.html.bak-20261117-1915`、`members.js.bak-20261117-1915`
- 新前端已上线：配置码按钮 + 「接入哪个 agent」下拉（driver.adapter=codex-desktop 才走 GPT 引导）

## 交互改版（2026-11-17 19:35，按卿要求）

**取消启动自动弹窗**——实测 SessionStart hook 只在开会话时触发，重启桌面不开会话根本不弹；
且卿认为自动弹窗没必要。改为用户主动触发：

- `plugin.json` 升 0.2.0：加 `skills: ./skills/` + `interface.defaultPrompt: ["$campfire-setup"]`
- 新增 `skills/campfire-setup/SKILL.md`：用户在对话框输入 `$campfire-setup`（或点插件详情页提示按钮）触发；
  引导用户去围炉拿配置码 → 找到并运行 `hooks/setup.ps1` 弹配置窗 → 成功后运行 `launch.ps1` 点火
- `launch.ps1`：无配置时**静默退出、不弹窗、不拉进程**（实测 stdout 空、进程 0）；
  有配置时静默无窗口拉起（VBS ws.Run ...,0）
- `setup.ps1`：两个弹窗文案重写成小白版（第1步去哪拿配置码，第2步选哪条会话当围炉成员）

验证：无配置不弹窗/不拉进程✅、有配置无窗口点火✅、skill 被 Codex 识别✅、脚本路径正确✅、语法全过✅

## 成员名单缺失导致 @ 旧名（2026-11-18 04:15，卿定位为围炉端 BUG）

卿指出：群成员 @ 其他成员时拿不到最新成员名（恭喜一直在 @`gpt10`，而 gpt10 已删，
gpt 收不到）。确认成立：`/v1/updates` 只返回消息、**不带成员名单**，agent 只能靠自己的
会话历史记名字，成员重建/改名后必然 @ 到旧名。另确认「能正常回复就不需要额外建会话」。

三处修复：
1. **围炉 `/v1/updates` 返回 `members`**：当前群成员的 handle/display/aliases，
   任何接入方每次轮询都能拿到权威名单。
2. **Codex 适配器把它附进投递内容**：`Render-Prompt` 追加一行
   `[群成员：dsh-nas(恭喜), dsh-pc(发财), gpt(gpt)]`——纯事实标注，不加指令。
3. **旧 handle 转别名**：给 `gpt` 加别名 `gpt10,gpt-pc,gpt8,gpt2,gpt-e2e`，
   围炉 `parseTargets` 认别名，所以恭喜即使还 @ 旧名也能正确投递（不用改 DSH 插件）。

**端到端验证**：
```
seq110 @gpt  → seq111 gpt "@主人 收到"
seq112 @gpt10（旧名）→ seq113 gpt "@主人 别名通了"
```
`/v1/updates` 实测返回 `members=[dsh-nas(恭喜), dsh-pc(发财), gpt(gpt, aliases=[gpt10,gpt-pc,…])]`。

## 401 僵尸进程 + 探测打挂服务：两个真 bug（2026-11-18 04:05）

卿反馈「GPT 已经配好了，但围炉没识别到」。查到两个真 bug：

1. **僵尸适配器握旧令牌 → 永久 401**：进程 03:43:19 启动（旧令牌），configure 在 03:43:57
   重写 `.env`（新令牌），但 `launch.ps1` 幂等检查发现旧进程在跑就 `skip` →
   旧进程内存里还是旧令牌，每 4 秒 401，围炉永远显示未接入。
   修：`configure.mjs` 点火前先 `killAdaptersWin()` 杀掉旧进程再启动。
2. **caller 批量探测把桌面 app-tools 服务打到异常态**：原逻辑每条消息前连发 7 次
   `list_threads` 探测 caller → 之后**所有** `tools/call` 都返回 `-32000
   Codex app tool request failed`，连独立探测也失败（重启 ChatGPT 桌面才恢复）。
   修：改惰性选 caller —— 直接用配置里的 `CODEX_CALLER_THREAD_ID` 投递，
   失败才按候选逐个换，每次间隔 800ms；删掉主动 `list_threads` 探测与 `create_thread`。

**端到端验证通过**（宿主启动适配器 + 真实群消息）：
```
[04:02:09] deliver main:104 -> 01a1eb12… (caller=01a1e038)
[04:02:34] main:104 replied: @主人 我收到了
群里 seq 105: gpt → "@主人 我收到了"
```
中文正常、只回一次、自动 @ 发送者，三项全对；`gpt` 成员 presence.reachable=True。

**顺带纠正一个此前的误判**：不是"沙箱后台进程连不上管道"，而是**服务被打到异常态**。
服务健康时，`launch.ps1`（WMI 起的脱离进程）完全能正常投递。若以后再遇
`pipe rpc error` / 工具全失败，先重启 ChatGPT 桌面恢复服务，不要盲目改代码。

## 回帖编码/重复投递/@成员 三修复（2026-11-18 03:40）

卿实测反馈两问题：①恭喜给 GPT 的消息在会话里出现 2 次；②GPT 回帖到围炉全是问号。
后又反馈③GPT 回复没 @ 成员，恭喜收不到。三处根因与修复：

1. **中文变问号**（根因）：`Cf-Post`/`Cf-Ack` 用 `Invoke-RestMethod -Body "<字符串>"`，
   PowerShell 5 按系统 ANSI 编码发送、声明却是 UTF-8 → 中文损坏 + 围炉 400。
   修：`[Text.Encoding]::UTF8.GetBytes($body)` + `charset=utf-8`。
   **真实验证**：中文进出围炉一字不差、无问号。
2. **同一条消息投两次**（根因）：回帖失败 → 异常 → 游标不推进 → 整条消息重新拉取并
   重新 `send_message_to_thread` → GPT 收到两次。
   修：投递成功后立刻记进持久化 `.pending.json` 并推进游标；回帖失败只重试回帖、
   绝不再投递；回帖用 `clientMsgId=codex:<updateId>` 幂等。
   **真实验证**：同 clientMsgId 发两次，群里只 1 条。
3. **回复不 @ 人**（根因）：围炉只按正文 `@名字` 决定投递给谁，GPT 回复没写 `@恭喜` 就没人收到。
   修两处：适配器回帖自动加 `@原发送者`（显示名或 handle 已 @ 则不重复加）；
   围炉 `channel-api.js` 的 `/v1/messages` 在带 `replyTo` 时把被回复成员加入投递目标。
   **单元验证**：@ 前缀逻辑 5/5 通过。

附带修复：`Log` 用 `Write-Output` 污染函数返回值（导致 `Resolve-Caller` 返回日志文本
而非会话 id）→ 改 `Write-Host`；caller 探测增加"从 sessions 目录扫 rollout 文件名"的候选
（索引被改坏只剩一条时仍能找到老会话）+ 失败清缓存重探 + 明确提示。

**沙箱限制（非产品问题）**：DSH 沙箱起的脱离进程拿不到桌面管道权限（宿主会话内前台可，
WMI/Start-Process 起的后台不行），因此本机无法端到端验证投递；需由 GPT 自己启动的
适配器（或用户终端）才有效。`create_thread` 各种参数均返回 invalid arguments，自动建
发话口会话暂不可用，仍依赖"桌面里另有第二条会话"。

## 从0复测前清场（2026-11-18 03:00）

卿「清掉，我从0测试」。备份 NAS `data.bak-20261118-0300`（4.2M）。
清：gpt8 成员 purge（1 令牌吊销）、11 条测试消息软删、适配器进程 10400 停、
`~/.campfire-codex` 删（含 .env/日志/launch-hidden.vbs）、临时脚本清。
复查：成员只剩 dsh-nas/dsh-pc、大厅非空消息 0、无配置目录、无残留进程、
插件 0.3.0 在、NAS 前端"一键复制/当前会话"上线、备份在。
桌面会话（你好、围炉等）按卿此前"换干净会话、不动"的选择保留未动。

## 直接接入当前会话（2026-11-18 02:55，卿拍板）

卿读 13 分钟那次接入日志后问「直接接入当前会话不行吗，非另开就接受适配器自建专用会话」。
判断：**直接接入当前会话技术上完全可行**——命名管道方案已验「目标会话正被 App 打开照样写入成功」，
不必新建、不必改名、不必读易脏的 session_index 标题匹配。唯一代价：群消息与当前对话共用上下文（已告知卿）。

13 分钟根因：上一轮"精确匹配标题『围炉』"的确定性规则引入三坑——
① 用户建的是「围炉会话」差一字就永远匹配不上；
② session_index.jsonl 同一会话新旧两行，脚本按首次去重读到旧标题，GPT 被迫去删用户索引行（高风险）；
③ `--code` 覆盖 `--memberThread` 导致无法显式指定当前会话（真 bug）；
再加 skill 写死"别读脚本/别改代码"，报错时无合规解法，GPT 只能边纠结边绕。

改动：
- `configure.mjs`：删掉按标题匹配，改为"成员会话 = 显式 memberThread（当前会话）否则取列表第一条；
  发话口 = 另一条不同会话；只要两条不同即可"。修 `--code` 覆盖 bug（解析后保留 args.memberThread/senderThread）。
- `SKILL.md`：去掉"须新建命名围炉会话"前置，改为"直接接入当前会话、不新建不改名"；
  让 GPT 查当前会话 id 作 `--memberThread` 传入；明确禁止改会话标题/索引文件。
- 围炉向导：第1步只剩"装插件"，明说"不用新建会话、不用改名，消息进当前这条会话"；
  合成消息改为"帮我把围炉接到当前这条会话"。

验证：`--code`+`--memberThread` 共存时当前会话 id 保留、令牌不丢；全部语法 0 错误；
NAS 页面"不用新建会话/当前这条会话"上线、旧命名要求已删；工作区/缓存三文件一致。

## 接入向导重写：skill 一步接入（2026-11-18 02:20）

卿要求"既然用 skill 让 GPT 自己连，就先讲清怎么用，再把要提供给 GPT 的所有文字
自动生成、一键复制完成连接"。重写 `#connect-codex`：

- 旧界面是"三方式并列 + 配置码单独一块 + 三块复制区"，用户得自己拼"发给 GPT 的话"，
  眼花缭乱。新界面只三步：
  1. 一次性准备（装插件 + 建「围炉」会话）——讲清"只用做一次"
  2. **生成一整段「发给 GPT 的话」**（`$campfire-setup 帮我接入围炉……` + 换行 + 配置码），
     一个「一键复制」按钮复制整段，粘进 GPT 对话框发送即完成
  3. 群里 @ 验证
- 工具表单 / 终端命令收进折叠「其它接入方式（走不通再看）」，不干扰主路径。
- `updateCodexCode()` 从"只生成配置码"改为"生成合成消息"，`copyText(message)` 复制整段。
- SKILL.md 补规则：从整段话里只提取 `campfire://setup?` 开头那一串，忽略前后中文说明，
  原样作 `--code` 参数；避免 AI 面对「说明+配置码」合成消息又去拆字段。

验证：Node 模拟合成消息→提取→解码，base/member/token 与原始完全一致；
NAS 页面「一键复制/发给GPT的话/两步准备/高级折叠」全上线，旧三方式并列已删；
`copyBlock` 点击时读 textContent，动态内容可复制，无绑定时序隐患。
环境：成员 dsh-nas/dsh-pc/gpt4（gpt4 是卿在测成员，未动）、大厅无消息、无配置目录、无进程。

## 真正根因：后端丢弃 adapter 字段（2026-11-18 02:10）

卿反馈"围炉端接入设置界面没看到任何修改"。抓 NAS 实时页面确认前端已部署、
新标记都在，但 gpt3 成员仍显示 DSH 引导。逐层查到 **src/members.js 的 normalizeDriver**：
pull 分支硬编码 `return { type: DRIVER.pull };`，**把前端传来的 driver.adapter 直接丢弃**。
所以不管前端表单怎么选、save 怎么写，存进 members.json 永远是 `{"type":"pull"}`，
openConnect 里 `adapter=''` → 走 renderConnectForDsh。前面几轮全在前端修，漏查了后端。

修：normalizeDriver pull 分支保留白名单 adapter（只认 `codex-desktop`）：
`const adapter = d?.adapter === 'codex-desktop' ? 'codex-desktop' : undefined; return adapter ? {type,adapter} : {type}`。
部署：scp src/members.js 到 NAS + docker compose build/up（备份 members.js.bak-20261118-0210）。

决定性验证（真实 NAS API）：建带 adapter 的成员 → 读回 `driver={"type":"pull","adapter":"codex-desktop"}`
（修复前只会是 `{"type":"pull"}`）→ purge 探针。前端 save/openConnect/renderConnect 三段链路确认全在。
清掉旧 gpt3（无 adapter 会误导显示 DSH 引导）+ 重建的配置目录。环境恢复：成员只剩 dsh-nas/dsh-pc、
大厅无消息、无配置、无进程、后端工作区与 NAS 一致。

## 读日志后的确定性与"原封不动"改造（2026-11-18 01:50）

卿让读 GPT 接入会话/测试会话的 rollout 思考日志后判断问题。日志结论：
- 链路通（@gpt→456789、@gpt2→789654、01-27 配置一次成功进程 11240），但"小磕绊"在
  ①围炉给"配置码"、skill/MCP 却要"三字段"、AI 每次临场纠结该拆还是该用 --code；
  ②AI 自发的过度核验（读脚本全文/反复查进程日志）；
  ③投递带英文包装语（"[Campfire group...] Do NOT run tools..."），导致 GPT 反复纠结
  "是不是 prompt injection / 我该自称什么 / @gpt2 是不是我"。

卿 4 点指示与落实：
1. **口径不统一是围炉端问题**：确认三层错位——成员 driver.adapter 未落库（走错引导分支）、
   向导主推配置码但 A/B 说明仍讲"三项/三个输入框"、建成员易漏选。修：
   - 三方式文案统一为"只复制配置码整串粘贴"；MCP 表单从三字段改为单"配置码"输入框；
   - skill 收口成"只认配置码、一条 --code 命令、不拆字段不猜不多核验"；
   - openConnect 用 localStorage 记住"接入目标"选择（adapter 没落库也不再每次错回 DSH）。
2. **流程 100% 可靠**：核心改为确定性会话选择——configure.mjs 精确匹配标题「围炉」的会话当
   成员会话（找不到明确报错让用户新建），发话口取另一条不同会话；**不再按 updated_at 猜**
   （实测真实数据里 3 条调试会话都比「你好」新，按时间排序会选错，已否决）。围炉向导加
   "第 0 步：先建一条名叫『围炉』的会话"。验证：模拟数据精确选中「围炉」、不碰调试会话。
3. **去掉提示词包装**：Render-Prompt 改为原封不动投递群消息（仅加"谁说的"事实标注），
   删除英文包装语/Do NOT 指令。验证：输出 `主人: @gpt2 你好，测试，仅回复789654`，无包装。
   （风险已评估：send_message_to_thread 投递的是用户输入，模型不会自动跑工具。）
4. **清残留从0测**：gpt2 成员 purge（3 令牌吊销）、12 条测试消息软删、配置目录删、
   适配器进程停、临时脚本清；备份 data.bak-20261118-0145。桌面「你好」会话不动
   （卿选"换一条干净会话"），从0测试时新建「围炉」会话即可。

环境复查：成员只剩 dsh-nas/dsh-pc、非空消息 0、无配置目录、无进程、插件 0.3.0 在、
NAS 前端第0步+三方式上线、工作区/缓存 configure 一致、skill 无明文地址。

## 卿复测后第二批修复（2026-11-18 01:20）

1. **围炉引导 BUG**：成员 driver 没写 `adapter` 字段（建成员时下拉没选到 GPT），
   导致 openConnect 判断失效、仍显示 DSH 引导。修法：接入向导顶部加「这个成员接到哪里」下拉
   （`connect-target`），用户可现场切换 DSH / GPT 桌面端，change 即重渲染分支。
   即使建成员时没选对，打开接入设置也能纠正。已部署 NAS。
2. **skill/MCP 明文地址**：SKILL.md、mcp/server.mjs、.env.example 里的
   原来的内网地址全改成 `http://<围炉服务器>:8099` 占位举例。
   插件目录 Select-String 复查无明文地址。
3. **测试现场已清**：gpt 成员 purge（3 令牌吊销）、82 条测试消息软删、配置目录删、
   适配器进程停（pid 13296）、临时脚本清；备份 data.bak-20261118-0120。
   环境复查：成员只剩 dsh-nas/dsh-pc、非空消息 0、无进程、无配置、插件在、NAS 引导下拉上线。

## 用户实测后的优化（2026-11-18 01:00，卿反馈"通了但过程曲折、耗时长、GPT 改了代码"）

用户用方式 A 实测：链路通了（adapter.log: `main:82 replied: 456789`），但 GPT 被迫现场调试两处 bug，
耗时半小时。**根因：交付源码有两个真 bug，且修复只在插件缓存里，重装修复全丢。**

GPT 现场修的两处（已从缓存回灌工作区源码）：
1. `configure.mjs` 用了 CommonJS `__dirname`（ESM 里报错）→ 改 `path.dirname(fileURLToPath(import.meta.url))`
2. `launch.ps1` 生成的 `.vbs` 无 BOM → WSH 按 ANSI 读，中文用户名路径失效 → 改 `[Text.Encoding]::Unicode`（UTF-16 LE 带 BOM）

本次新增优化（防再次假成功/拖慢）：
- `configure.mjs` 点火后**轮询验证适配器进程真存活**（最多 10 秒），失败明确报错并指向 ignite.log，不再"假成功"
- 去掉启动时 `Wait-ThreadsReady 15000` 的阻塞空等（notLoaded 是启动瞬态，投递本身有重试；实测去掉后照样回帖）
- 所有 ps1 补回 BOM（edit 操作会丢 BOM，导致 PowerShell 5 中文注释引号解析错乱——本次又踩一次，已固化检查）

验证：两处修复已回灌且与缓存 md5 一致；进程存活检测逻辑实测准确识别 PID；全部语法 0 错误；BOM 全 EF-BB-BF。
仍需横评：三条路径都应在干净环境各跑一次，确认无其它隐蔽 bug。

## 三路径接入重构（2026-11-18，按卿"三条都做、用户任选"要求）

卿否掉单一路径，要求三种都做、能连上就是好方法。统一底座：
- `adapter/configure.mjs`（跨平台 Node）接收 base/token/member（或配置码）→ 自动从
  `session_index.jsonl` 选两条会话 → 写 `~/.campfire-codex/.env` → Windows 上调 launch.ps1 点火。
  支持 `CAMPFIRE_CONFIG_DIR` 覆盖配置目录。三路径共用它，避免重复。

三条路径：
- **A 对话框**：`skills/campfire-setup/SKILL.md` 重写——明确让用户给三个确定字段（不让 AI 猜字符串），
  再 `node configure.mjs --base --token --member`。
- **B 表单**：`mcp/server.mjs`（plugin.json 加 `mcpServers: ./.mcp.json`）——工具 `connect_campfire`
  调用时发 `elicitation/create` 三字段表单，填完调 configure。跨平台标准能力；
  ⚠️ Codex 有个别已知 bug（#35947/#41797），弹不出就用 A/C。
- **C 命令**：围炉 GPT 向导生成跨平台 `node configure.mjs --code "campfire://setup?..."`，用户终端粘贴。

前端 NAS 向导重做为"三方式任选+一键复制"；插件升 0.3.0（含 mcp/skill/configure）。

验证：MCP 握手/工具列表/elicitation 表单请求✅、skill 三字段✅、configure 编解码+选会话✅、NAS 前端三方式✅。
（沙箱 node 孙进程写文件 EPERM 是已知环境限制，真实环境无）

## 现场状态（已清干净，等卿从0测）

8 项复查全过：
- 围炉成员只剩 dsh-nas / dsh-pc（gpt-e2e 已 purge，含 9 个令牌吊销）
- 测试消息 seq 60-81 全软删（正文清空）
- 用户配置目录 `~/.campfire-codex` 不存在
- 无残留适配器进程
- 插件已装 `codex-campfire@campfire`（config 备份 `config.toml.bak-ignite-20261117`）
- NAS 新前端已生效、备份在
- 没推 GitHub 源码（只更新了 NAS 运行的前端）
