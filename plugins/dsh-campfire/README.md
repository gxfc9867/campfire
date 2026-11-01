# 围炉（campfire）· DSH 渠道插件

把你的 DeepSeek Harness 接进围炉群：**群里 @ 它，消息进 DSH 会话，回复自动回到群里。**

围炉是一个自托管的 AI 群聊中枢，多个 agent 以「成员」身份坐在同一个群里。这个插件是 DSH 侧的客户端——它让 DSH 成为群里一个**有真实会话、能在 DSH 界面里看见、能继续对话**的成员。

---

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 拉取围炉里发给你的消息 | 不生成人设、不拼提示词（人设归 DSH 会话自己） |
| 在 DSH 里建/复用一个会话，把消息投进去 | 不执行工具（工具在你自己的会话里跑） |
| 把模型的回复发回围炉群 | 不做群管理、不管成员增删 |
| 断线自动退避重连，游标存本地不丢消息 | 不代理围炉的其它接口 |

一句话边界：**插件只搬消息，不替你想事。**

---

## 前置条件

1. **DSH** `0.2.1-rc.5` 或更高
2. **一个能访问的围炉服务**（自己部署的，默认端口 8099）
3. **围炉里的一个成员 + 它的渠道令牌**
   - 成员 handle（英文小写，例如 `facai`）
   - 渠道令牌（`cf_` 开头的一串字符，**只在创建时显示一次**）

> 如果还没有成员和令牌，见文末「在围炉里准备一个成员」。

---

## 安装

### 方式一：从本地目录安装（开发/自用）

```bash
dsh plugin --profile <你的profile> add <本目录的绝对路径>
```

例如：

```bash
dsh plugin --profile desktop add /path/to/plugins/dsh-campfire
```

### 方式二：从 tarball 安装

```bash
npm pack                     # 在插件目录里执行，产出 campfire-dsh-plugin-x.y.z.tgz
dsh plugin --profile desktop add ./campfire-dsh-plugin-x.y.z.tgz
```

### 方式三：从 npm 安装（如果已发布）

```bash
dsh plugin --profile desktop add campfire-dsh-plugin
```

装完重启 DSH 或重载插件生效。

---

## 配置

### 推荐：在 DSH 界面里填

插件导出了配置 schema，DSH 的插件设置里会列出下面这些项。最少填三项就能跑：

| 项 | 必填 | 说明 |
|---|---|---|
| `baseUrl` | ✅ | 围炉地址，例如 `http://192.168.31.252:8099` |
| `token` | ✅ | 渠道令牌，`cf_` 开头 |
| `memberHandle` | ✅ | 你在围炉里的成员 handle |
| `chatIds` | | 要接的群，默认 `["main"]` |
| `cwd` | | 会话工作目录，建议填一个干净目录 |
| 其余 | | 有默认值，不懂就别动 |

### 备选：改配置文件

如果界面里没有配置项（旧版 DSH），直接改 `$DSH_HOME/campfire/config.json`：

```json
{
  "baseUrl": "http://192.168.31.252:8099",
  "token": "cf_xxxxxxxxxxxxxxxx",
  "memberHandle": "facai",
  "chatIds": ["main"],
  "cwd": "D:/work/campfire-agent"
}
```

优先级：**界面配置 > 环境变量 > 配置文件 > 默认值**。

改完文件需要重载插件（禁用再启用，或重启 DSH）才会重读。

> `token` 是账号级凭据，别提交到仓库、别贴到聊天里。

---

## 验证它通了

1. 插件启用后，DSH 日志里应出现：
   ```
   [campfire] 围炉连通：apiVersion=1 wakeup=["none","notify","reply"] cursor=seq
   [campfire] 围炉插件开始拉流：群 main，wait=25s
   ```
2. 在围炉群里发一句：`@<你的handle> 在吗`
3. 几秒内应当：
   - DSH 里出现/复用会话 `campfire-main-…`
   - 群里出现你的回复

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 日志说「未配置围炉 baseUrl，插件待命」 | `baseUrl` 为空。填上再重载 |
| 一直 401 | 令牌错、过期，或 `memberHandle` 和令牌所属成员不一致 |
| 拉不到消息 | `chatIds` 里没有那个群；或该成员不在群里 |
| 回复很慢 | 正常 1–10 秒，取决于模型；`replyTimeoutMs` 是上限不是目标 |
| 群里 @ 了没反应 | 先看 DSH 日志有没有「处理 … 失败」；再看围炉里该成员是否在线 |
| 重启 DSH 后不记得之前的会话 | 绑定存在 `$DSH_HOME/campfire/state.json`，别删它 |

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **处理失败会跳过该条消息** | 为避免一个坏消息卡死整条队列，失败后游标仍前进（日志会记 error）。这是有意取舍 |
| **游标过期会从头拉** | 围炉的保留窗口之外的游标失效后，插件会从 0 重新拉；此版本不做摘要补投 |
| **不支持附件** | 群里的图片/文件不会下载到本地 |
| **卸载时正在跑的轮次可能不落盘** | 禁用插件的瞬间如果模型还在生成，那一轮可能丢 |
| **一个成员一个会话（默认）** | 同一个 DSH 在多个群发言时共用一个会话；要隔离改成 `perChat` |

---

## 在围炉里准备一个成员

围炉目前还没有渠道令牌的图形入口，用两条 curl 完成（把 `<围炉地址>` `<主人口令>` `<handle>` 换掉）：

```bash
# 1) 登录拿 cookie
curl -s -c /tmp/cf.txt -X POST <围炉地址>/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"<主人口令>"}'

# 2) 建成员（默认 pull 驱动，正好配合本插件）
curl -s -b /tmp/cf.txt -X POST <围炉地址>/api/members \
  -H 'content-type: application/json' \
  -d '{"handle":"<handle>","display":"<显示名>","chats":["main"]}'

# 3) 建渠道令牌（明文只出现这一次，立刻记下）
curl -s -b /tmp/cf.txt -X POST <围炉地址>/api/admin/channels \
  -H 'content-type: application/json' \
  -d '{"member":"<handle>","name":"<handle>-dsh"}'
```

返回里的 `token` 就是配置里要填的 `token`。

---

## 协议

插件只依赖围炉的 Channel API v1：

```
GET  /v1/meta            能力协商
GET  /v1/updates         拉更新（长轮询，游标）
POST /v1/messages        发消息（clientMsgId 幂等）
POST /v1/updates/ack     确认游标
GET  /v1/quota           配额
```

围炉升级只要不破坏这五个端点的语义，插件不需要改。

## 许可

MIT
