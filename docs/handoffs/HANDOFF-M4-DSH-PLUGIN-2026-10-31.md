# 交接 · M4 DSH channel 插件（2026-10-31）

> 分支 `feat/m4-dsh-plugin`（从 `main` = `a8ba08d` 切）。
> 范围：只动 `plugins/dsh-campfire/**`、`docs/design/DSH-PLUGIN.md`、`docs/probes/campfire-mock.cjs`、本文件。
> 详细设计见 `docs/design/DSH-PLUGIN.md`；本文件只讲「做到哪、怎么验、卡过什么、下一步」。

---

## 1. 一句话结论

M4 完成：**真 DSH 0.2.1-rc.5 装上插件后，一条 mock 围炉消息能建会话、跑模型、把回复发回围炉；
第二条消息复用同一会话；禁用/启用后能补处理消息并 resume 回原会话。** `npm test` 135 项全绿、`npm run check` 通过。

---

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `plugins/dsh-campfire/index.js` | 插件入口（`inject: ['agents','sessions']`、装配/卸载顺序） |
| `plugins/dsh-campfire/src/campfire-client.js` | Channel API v1 客户端（零依赖） |
| `plugins/dsh-campfire/src/bridge.js` | 拉流 → 定会话 → 投递 → 回帖 → ack 的纯逻辑 |
| `plugins/dsh-campfire/src/dsh-host.js` | 唯一碰 `ctx.agents` / `ctx.sessions` / Agent 方法的适配层 |
| `plugins/dsh-campfire/src/{config,bindings,format}.js` | 配置解析 / 绑定与游标状态 / 来源标记 |
| `plugins/dsh-campfire/{package.json,cordis.patch.yml,locale,icon.svg}` | bundle 清单与显示资源 |
| `plugins/dsh-campfire/mock-campfire.cjs` | 零依赖 mock 围炉（676 行，单测 + 人工验收共用） |
| `plugins/dsh-campfire/test/*.test.js` | 42 个用例（format 12 / config 9 / client 8 / bridge 13） |
| `docs/probes/campfire-mock.cjs` | mock 的 CLI 启动器 |
| `docs/design/DSH-PLUGIN.md` | 契约、配置、验收记录、限制、下一步 |

---

## 3. 验收证据（可复现）

环境：DSH 0.2.1-rc.5（`@deepseek-ai/dsh-desktop-runtime`），Windows，Node 24.4.1。

```powershell
# 1) 起 mock
node docs/probes/campfire-mock.cjs --port 8787 --token dev-token --member facai --chat main
# 2) 配置（不进仓库）
#    $DSH_HOME/campfire/config.json: { baseUrl: http://127.0.0.1:8787, token: dev-token,
#      memberHandle: facai, chatIds: ["main"], cwd: <仓库绝对路径> }
# 3) 装插件（tool）
#    plugin_manager action=install_bundle target=J:\campfire-m4\plugins\dsh-campfire
# 4) 造一条被 @ 的消息
#    POST http://127.0.0.1:8787/mock/inject  {"chatId":"main","text":"@facai …","mentions":["facai"]}
# 5) 看回帖
#    GET  http://127.0.0.1:8787/mock/outbox
```

四步验收（实测时间 00:23–00:25）：

| # | 动作 | 结果 |
|---|---|---|
| 1 | 被 @ 的消息 | 新建会话 `campfire-main-8e2672cd-…`；回复回传 mock，`replyTo` 正确 |
| 2 | 第二条消息 | **同一会话**继续（没有第二个会话目录），游标 1→3 |
| 3 | `set_bundle enabled=false` | 停用期间消息无人处理（outbox 不增、游标不动） |
| 4 | `set_bundle enabled=true` | 补处理停用期间的消息，`resume` 命中同一会话，游标 3→5 |

落盘证据：

- 会话日志 `$DSH_HOME/sessions/--J-campfire-m4--/campfire-main-8e2672cd-…/session.v4.jsonl.zstd`
  → 解压后 56 事件、`turn/start`×3、`turn/end`×3、`user/message` 里 3 条 `source=campfire`（含来源标记）
- `$DSH_HOME/campfire/state.json`：`bindings."*".sessionId` 全程未变，`cursors.main` 1→3→5

---

## 4. 卡点与解决（重要，会影响别人装插件）

### 4.1 `install_bundle` 第一次失败：lockfile 供应链策略

现象：`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，`@michengai/dsh-archive-manager@1.1.19`
发布时间（2026-10-29T16:29Z）晚于 minimumReleaseAge 截止线。**与 M4 无关**，是 profile 既有状态。
处理：重试一次即过（该次运行把 exclude 写进了 `minimumReleaseAgeExclude`）。

### 4.2 第二次失败：`ERR_PNPM_IGNORED_BUILDS`（profile 里的配置残留）

根因：`$DSH_HOME/profiles/desktop/pnpm-workspace.yaml` 的 `allowBuilds` 里有一行**占位文本没填**：

```yaml
allowBuilds:
  dsh-purge@https://codeload.github.com/…/master: set this to true or false
```

pnpm 认为该包构建脚本「未表态」，直接以非零退出，导致任何插件都装不上。
处理（已备份、已改、可回滚）：

- 备份：`pnpm-workspace.yaml.bak-before-campfire-20261031-002331`
- 改动：把上面那行改成 `…: false`（**不执行** dsh-purge 的构建脚本，比 `true` 安全）
- 之后 `install_bundle` 一次成功（`application: applied`）

> 后续任何人在这台机器上装插件再遇到 `ERR_PNPM_IGNORED_BUILDS`，先看这一行。
> 是否真要允许 dsh-purge 的构建脚本，是卿的决定；本次选了「不执行」。

### 4.3 踩坑记录（写进代码注释了，这里只列结论）

1. **投递不能传纯字符串**：inbox 按 `message.id` 去重并把消息当 `user/message` 落盘，必须传完整
   durable `UserMessage`（`{id, role, content, source}`）。
2. **`agentOptions` 不填不会继承默认模型**：loop 会抛 `has no provider/model`。必须显式从
   `ctx.agentDefaultModel.currentSelection()` 取 provider/model 再传。
3. **插件不能 `import '@deepseek-ai/*'`**：bundle 是链接目录安装（`link:J:/…`），裸包名从链接目录解析不到
   （profile 里能 import 的插件都住在 profile 目录内）。所以本插件零 DSH 依赖，全部走 `ctx`。
4. **pwsh 的 `Get-Content/Set-Content` 会把 UTF-8 中文读成 GBK 写坏文件**：改含中文的文件必须用文件写工具。
   本次把 `docs/probes/campfire-mock.cjs` 写坏过一次，已由 mock 作者原样重建。

---

## 5. 给如意（M1）的接口期望

插件按 `docs/design/CONNECTION-DRAFT.md` §4 实现，**与 mock 的差异请以契约为准**；以下是我在 mock 上
额外依赖的、契约里没写死的点（若真围炉不同，改 `campfire-client.js` 一处即可）：

| 点 | 我的用法 |
|---|---|
| `GET /v1/updates` | 参数 `chat` / `cursor` / `wait`(0–30) / `limit`；返回 `{updates,nextCursor,hasMore,serverTime}`；`updateId` 用于去重 |
| `wakeup` | 只认 `reply` / `notify` / `none`；缺省按 `notify` 处理 |
| `POST /v1/messages` | 必须支持 `replyTo` 与 `clientMsgId` 幂等（我用 `campfire-reply:<messageId>` 作幂等键） |
| `POST /v1/updates/ack` | `{chat, cursor}`，我用 update 的 `seq` 作为游标 |
| 错误形状 | `{ error: { code, message, details } }`；`cursor_expired` 我会把游标归零重拉 |
| 鉴权 | `Authorization: Bearer <token>`，一 token = 一成员 |

---

## 6. 下一步

1. M1 合并后用**真围炉**复跑 §3 的四步（插件端预期零改动）。
2. 回帖带 `mentions`（现在只带 `replyTo`）。
3. `coalesce` 合并窗口（§6.1）：现在一条消息一轮，30s 内的连发没有合并。
4. 按成员配 `agentPreset`（`meta.agentPreset`），让不同成员有不同人设。
5. 游标过期时的「摘要 + 最近 N 条」补投（依赖 M5）。
6. 插件当前仍装着并指向 mock（`127.0.0.1:8787`）：mock 没起时会每 30s 退避重试一次（`warn` 日志）。
   不想要噪音就 `set_bundle enabled=false`，或把配置里 `chatIds` 置空。
7. `docs/LAYOUT.md` 的目录职责表还没有 `plugins/` 一行（本次范围不含 LAYOUT，留给合并时补：
   `plugins/` = DSH 侧插件包，不进 `src/`）。

---

## 7. 协作记录

- `dsh-api-scout`：DSH 0.2.1-rc.5 的 Host 插件/Agent API 侦察（create/resume、followup/steer/inject、
  `session/event`、`Config` 用 schemastery、`install_bundle` 生效判定），结论已并入
  `docs/design/DSH-PLUGIN.md` 与 `src/dsh-host.js` 注释。
- `mock-campfire`：`mock-campfire.cjs` + `docs/probes/campfire-mock.cjs`，自带 39 项自测 + 16 项 CLI 冒烟。
