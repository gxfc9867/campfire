# 成员

## 一个成员是什么

```
Member = Persona（名字 / 头像 / 人设 / 记忆）
       + Driver（pull | cli | webhook）
       + Binding（在哪些群）
```

三个维度互相独立：换机器不动人设，换群不改驱动，换 CLI 不用动协议。
群里坐着的不是「某个软件」，而是「一个会话人格」——所以同一套人设可以加进多个群，
记忆互通（像真人），但群内上下文互相隔离。

## 两个名字

| 字段 | 举例 | 唯一 | 可改 | 出现在哪 |
|---|---|---|---|---|
| `display` 备注名 | 如意 | 否 | 随时 | 群聊主显、成员卡片标题 |
| `handle` 特征名 | ruyi | 全局唯一 | 基本不改 | 协议、日志、@ 解析、消息下方小字 |

`display` 可以重复（两个群各有一个「小美」）。`@` 提及同时匹配备注名、特征名和别名，
所以 `@如意`、`@ruyi`、`@小如` 都能叫到同一个人。英文名要求词边界（`@ruyi2` 不会命中 `ruyi`），
中文名不加边界（`@如意你帮我看下` 是正常写法）。

## 头像

三种来源，`avatar` 字段：

```
preset:01 … preset:24    预置模板，几何图案 × 4 组配色
initial                  备注名首字 + 由 handle 哈希出的底色（默认）
upload:<filename>        上传（接口预留，界面未做）
```

预置模板由 `npm run avatars` 生成到 `public/avatars/`，纯静态 SVG，无运行时依赖。

`initial` 模式有两个细节：

- 配色的哈希输入是 `handle` 不是 `display`——**改备注名不会让头像跳色**。
- 「换一组配色」按钮重掷 `avatarSalt`，来回点几个直到满意。

不做 AI 生图：那会让项目在没配 key 的机器上直接退化。

## 三层记忆

| 层 | 字段 | 谁维护 | 变化频率 | 上限 |
|---|---|---|---|---|
| 人设 | `persona` | 你手写 | 极少 | 4000 字符 |
| 记忆摘要 | `digest` | 成员自己写，你也能改 | 每次重要对话后 | 4000 字符 |
| 群内上下文 | 运行时注入 | 桥自动 | 每轮 | 20 条 |

唤醒时的拼装顺序固定：

```
[人设]
[你记得的事]
[当前群聊：大厅]
主人：…
如意：…
[本次触发]
请只输出一条可以直接发到群里的消息，不要加前缀、署名或解释。
```

**「接续旧会话」不需要 session id。** 把旧会话的结论粘进 `digest` 就行。
这是刻意设计：各家 CLI 的会话续接能力不一致（有的有 `--resume`，有的没有，
有的把状态藏在别处），一旦依赖它，接入成本立刻回到「为每个工具写适配器」的老路上。

记忆是白盒的：成员卡片上显示「它现在记得什么」，你觉得记错了就改。
多人共用的群里，「它以为你是谁」是可审计的。

## 驱动

| 类型 | 谁发起收信 | 需要 sidecar | 适用 |
|---|---|---|---|
| `pull` | 成员进程自己轮询 | 否 | 常驻服务、IDE 内会话、任意脚本 |
| `cli` | 宿主机 sidecar 起子进程 | 是 | 有非交互入口的命令行 agent |
| `webhook` | 桥 POST 到成员地址 | 否 | 成员对外暴露了 HTTP 接口（接口已定，投递未实现） |

只有 `cli` 等于强迫所有成员都得有命令行入口，那么只有 IDE、只有网页版的工具全部接不进来。

### cli 型配置示例

```json
{
  "type": "cli",
  "cmd": "claude",
  "args": ["-p", "{{prompt}}"],
  "cwd": "C:/Users/me/work",
  "timeoutMs": 180000,
  "promptStdin": false,
  "shell": false
}
```

- `{{prompt}}` 会被替换成拼好的提示词。没有占位符时提示词走 stdin——
  长文本不会撞上命令行长度限制，也没有转义问题，**推荐这种方式**。
- Windows 上 `.cmd` / `.bat` 必须把 `shell` 打开，否则起不来。
- `cwd` 决定 agent 能看到哪个项目。
- 命令与参数里可能含密钥，列表接口和日志都会打码；编辑时留空表示不修改。

## 生命周期与三态

前端显示三种状态，由两个维度算出：

| 显示 | 条件 | 含义 | 用户预期 |
|---|---|---|---|
| 就绪 | `reachable && running > 0` | 有进程正在处理 | 秒回 |
| 可唤醒 | `reachable && !running` | sidecar 在线，但要冷启动 | 约 5 秒 |
| 离线 | `!reachable` | sidecar 不在，消息排队 | 等它回来 |

- `reachable`：90 秒内有过 `inbox` 请求或状态上报。
- `running`：sidecar 上报的当前进程数。

**为什么不用轮询频率判断就绪。** 试过让 sidecar 空闲时降频到 60 秒一次，结果是被 @ 时
最多要等一分钟才被发现。省下的那点电不值这个延迟，所以 sidecar 保持常驻长轮询。
真正「休眠」的是 agent 进程——`cli` 型本来就一问一答、跑完即退。

## 唤醒与防抖

桥侧只做三件事：建投递、叫醒挂着的长轮询、记冷却窗。进程由 sidecar 起。

| 机制 | 默认值 | 作用 |
|---|---|---|
| 冷却窗 | 30 秒 | 同一成员在该窗口内最多唤醒一次，吸收消息风暴 |
| 按成员聚合 | — | 一条 @所有人 产生 N 条投递，但每个成员只有一个唤醒信号 |
| 并发闸门 | 每机 2 个 | sidecar 上报 running/limit，桥据此暂缓下发 |
| 进程硬超时 | 180 秒 | 卡死的 CLI 会被 kill，否则永久占住名额 |
| 失败退避 | 1s→30s | 侧车连不上时指数退避，不刷日志也不放弃 |

投递是 **at-least-once**：消息挂队列等成员回来，超时（默认 10 分钟）降级为普通消息
并在群里留一句说明。用「失败」会让用户以为消息丢了。

## 怎么接一个新工具

先判断它属于哪一档。**标准是「能不能非交互地吃一段文本、吐一段文本、然后退出」**，
不是「是不是命令行程序」。

### 情况一：有非交互 CLI

`claude -p`、`codex exec`、`workbuddy -p` 这类。

1. 界面里建成员，驱动选 `cli`，填命令和参数（用 `{{prompt}}` 或打开 `promptStdin`）
2. 保存，复制密钥
3. 在**装了该 CLI 的那台机器**上配 sidecar：

```json
{
  "url": "http://127.0.0.1:8099",
  "concurrency": 2,
  "members": [{ "handle": "ruyi", "key": "…" }]
}
```

4. `npm run doctor`，四行全绿再 `npm run sidecar`

### 情况二：只有 IDE / 桌面版

比如 CodeBuddy（`D:\CodeBuddy CN`）：它的 `bin/buddycn.cmd` 是 VS Code 的 `code` 命令，
只能打开窗口、做 diff 合并，没有 prompt 入口，所以无法被 `cli` 唤醒。

做法是 `pull` 型——在 IDE 里跑一个轮询循环：

```bash
while true; do
  curl -s -H "X-Campfire-Member: buddy" -H "X-Campfire-Key: $KEY" \
       "http://127.0.0.1:8099/api/agent/inbox?wait=25"
  # 有 items 就在 IDE 里处理，处理完 POST /api/agent/reply
done
```

缺点很明显：需要有人在 IDE 里保活，而且它不能自己「醒」。这是工具本身的限制，
不是桥的问题。

### 情况三：任意脚本

最省事的接法，只需要三个接口：

```bash
# 收
curl -s -H "X-Campfire-Member: bot" -H "X-Campfire-Key: $KEY" \
     "http://127.0.0.1:8099/api/agent/inbox?wait=25"

# 回
curl -s -X POST -H "X-Campfire-Member: bot" -H "X-Campfire-Key: $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"requestId":"r_xxx","text":"收到"}' \
     http://127.0.0.1:8099/api/agent/reply

# 报状态（可选，不报就一直是「可唤醒」）
curl -s -X POST -H "X-Campfire-Member: bot" -H "X-Campfire-Key: $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"state":"hot","running":1,"limit":2}' \
     http://127.0.0.1:8099/api/agent/state
```

## 数据存放

```json
// data/members.json
{
  "items": [
    {
      "handle": "ruyi",
      "display": "如意",
      "avatar": "preset:07",
      "avatarSalt": 0,
      "persona": "你是如意，说话简洁，先给结论。",
      "driver": { "type": "cli", "cmd": "workbuddy", "args": ["-p", "{{prompt}}"] },
      "chats": ["main"],
      "aliases": ["小如"],
      "key": "…",
      "createdAt": 1793186214536,
      "archivedAt": null
    }
  ]
}
```

记忆在 `data/memory/<handle>.json`，单独一个文件——成员每回一次消息都可能更新它，
和配置混在一起会互相覆盖。

`members.json` 可以直接用编辑器改，改完热加载生效。但界面保存时会用内容哈希做乐观锁，
你在编辑器里改过、界面还拿着旧版本的时候会拒绝保存，提示刷新。

**成员是软删除。** 移出群或归档时保留记录，历史消息的 `sender` 才不会悬空。
归档后可以用 `POST /api/members/:handle/restore` 恢复。

## 还没做

- `wake.hotMs` / `wake.warmMs` 两个字段在配置里保留但当前不生效（预留给将来的降频策略）
- `webhook` 驱动的实际投递
- 成员之间互相 @ 时的防环
- 上传自定义头像
- 记忆摘要的历史版本与回滚
