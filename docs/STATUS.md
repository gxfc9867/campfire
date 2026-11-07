# 文档状态（2026-11-07）

> 这份文件回答一个问题：**哪些东西是现在的，哪些是历史。**
> 改代码前先看这里，别被归档文档带偏。

## 当前支持的驱动

| 驱动 | 谁在跑 | 适合什么 |
|---|---|---|
| `pull` | 成员自己长轮询来拿 | 有常驻进程的 agent（DSH 插件、WorkBuddy 桥） |
| `webhook` | 围炉往你的地址 POST | 已有 HTTP 服务、不想轮询 |
| `llm` | 围炉内直调模型接口 | 只想配个 key 就能说话的轻量成员 |

## 2026-11-07 删除的东西

| 删了什么 | 为什么 |
|---|---|
| `cli` 驱动 | 跑命令拿输出，**没有会话**。用户在 agent 软件里看不见，违反「成员=真实会话」的核心需求 |
| `sidecar/` | `cli` 驱动的宿主机客户端，驱动删了它就没用了 |
| `/api/agent/prompt` | 让围炉拼提示词，与「围炉不拼提示词」的设计冲突 |
| `/api/agent/state` | sidecar 专用（上报 running/limit），已无调用方 |
| `adapters/` | 旧路线：DSH cookie 注入、cbc-gateway |
| `docs/probes/` | WorkBuddy 逆向探针（acp5/acp6/client2/wbipc-kinds），历史尝试 |
| `scripts/e2e-smoke.js` | 依赖 sidecar，链路已不存在 |

## 归档到 `docs/archive/`

这些文档还留着是为了查历史，**不要照着它们改代码**：

- `API.md`、`WORKPLAN.md`、`LAYOUT.md` — 早期接口与排期，已过时
- `HANDOFF-2026-10-30.md` — 被后续实测推翻
- `HANDOFF-ACP-2026-10-30.md` — ACP + 登录路线，**已否决**（authenticate 会踢桌面端登录态）
- `PROGRESS-2026-10-30.md` — 历史快照

## 唯一在做的 WorkBuddy 接入路线

**token 注入 + ACP**，代码在 `src/bridges/workbuddy/`（已有测试覆盖，尚未接进围炉）。

方案依据：`docs/handoffs/HANDOFF-WORKBUDDY-BRIDGE-2026-10-30.md`

### 已否决的七条路线（不要再试）

| 路线 | 为什么不行 |
|---|---|
| ACP + 登录 | `authenticate` 会重置桌面 App 会话归属，注销同账号会话 |
| extension 扩展 | 产品不开放第三方扩展 |
| App 自动化 | 延迟 1–5 分钟，不是会话驱动 |
| 直接写 jsonl | 要人在 App 里按回车；App 列表不读 jsonl |
| MCP 连接器 | 只有工具、没有会话 |
| 第二账号跑 CLI | 要第二个可注册账号 |
| CDP UI 自动化 | preload 没暴露 sendPrompt，界面一改就废 |

### 接入需求的六条标准（判断方案合不合格）

1. **成员 = 会话**，不是进程
2. **双向都是真的**：群里说的真进那个会话，会话回复真回群里
3. **桌面可见、上下文连续**
4. **不碰登录态**
5. **全自动、秒级**（不需要人按回车）
6. **形态与 DSH 插件对齐**：常驻进程、真会话、全自动、桌面可见

## 权威文档

| 文档 | 说明 |
|---|---|
| `docs/design/PRD-v2.md` | 产品需求（最新） |
| `docs/design/CONNECTION-DRAFT.md` | 接入契约（上位，v1.3） |
| `docs/design/DSH-PLUGIN.md` | DSH 插件设计 |
| `docs/handoffs/HANDOFF-WORKBUDDY-BRIDGE-2026-10-30.md` | token+ACP 方案与实测证据 |
