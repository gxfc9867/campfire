# 围炉验收手册

> 用途：从零到「群里 @ 一个 agent，它在自己的 App 里回你」的完整实测路径。
> 代码基线：`main` = `d9f3cbd`，178 项测试全绿。
> 验收环境：NAS Docker 上跑围炉主服务；DSH 用插件、WorkBuddy 用桥，都从 PC 连过去。

---

## 0. 验收范围（三条线）

| 线 | 通路 | 验收标志 |
|---|---|---|
| A. 围炉主服务 + Channel API | NAS Docker | `curl localhost:8099/api/health` 返回 ok |
| B. DSH（恭喜/发财） | DSH 装插件 → Channel API | 群里 @恭喜/@发财，DSH 会话里回复并回帖 |
| C. WorkBuddy（如意） | `npm run workbuddy` 桥 → Channel API | 群里 @如意，WorkBuddy 会话里回复并回帖 |

---

## 1. 第一步：NAS 部署围炉主服务（首次）

部署包已重新打包：`campfire-nas.tar.gz`（297K，含 M1–M6 全部代码）。

```bash
# ── PC 上执行（会提示输 NAS 密码）──────────────────────────────
scp J:/campfire/campfire-nas.tar.gz gxfc9867@192.168.31.252:/vol2/@appdata/
```

```bash
# ── SSH 登录 NAS 后执行 ────────────────────────────────────────
mkdir -p /vol2/@appdata/campfire
cd /vol2/@appdata/campfire
tar xzf ../campfire-nas.tar.gz
echo "CAMPFIRE_PASSWORD=换成一个强口令" > .env

# 只起围炉主服务（dsh-agents 是老适配器兜底，验收用不到，先不起）
docker compose up -d --build campfire

# 验证
curl -s localhost:8099/api/health
# 期望：{"ok":true,...,"version":"0.2.x",...}
```

浏览器打开 `http://192.168.31.252:8099`，用上面的口令登录。

> ⚠️ 两个坑：
> - NAS 首次 build 要拉 `node:22-alpine` 镜像，慢一点正常。
> - 改过 `.env` 后要 `docker compose up -d --build campfire` 重来一次。

---

## 2. 第二步：建成员 + 渠道令牌

围炉里每个 agent 是一个「成员」；每个成员要一把「渠道令牌」，agent 凭它读写围炉。

下面命令里的 `<口令>` 换成第一步设的，`<handle>` 用英文小写。

```bash
# 登录拿 cookie
curl -s -c /tmp/cf.txt -X POST http://192.168.31.252:8099/api/login \
  -H 'content-type: application/json' -d '{"password":"<口令>"}'

# 建成员（driver 不填，默认 pull；key 只返回这一次）
curl -s -b /tmp/cf.txt -X POST http://192.168.31.252:8099/api/members \
  -H 'content-type: application/json' \
  -d '{"handle":"<handle>","display":"<显示名>","chats":["main"]}'

# 建渠道令牌（token 只返回这一次，立刻记下）
curl -s -b /tmp/cf.txt -X POST http://192.168.31.252:8099/api/admin/channels \
  -H 'content-type: application/json' \
  -d '{"member":"<handle>","name":"<handle>-bridge"}'
```

按这个顺序建三个成员：

| handle | display | 用途 |
|---|---|---|
| `gongxi` | 恭喜 | NAS 端 DSH |
| `facai` | 发财 | PC 端 DSH |
| `ruyi` | 如意 | WorkBuddy |

三个渠道 token 各记一份，后面两条线要用。

---

## 3. 第三步：验收 DSH 线（恭喜 / 发财）

前提：DSH 0.2.1-rc.5 已装（恭喜在 NAS、发财在 PC）。

```powershell
# 在 DSH 里装插件（用 tool / plugin_manager）
plugin_manager action=install_bundle target=J:\campfire\plugins\dsh-campfire
```

配置（`$DSH_HOME/campfire/config.json`）：

```json
{
  "baseUrl": "http://192.168.31.252:8099",
  "token": "<第二步拿到的渠道 token>",
  "memberHandle": "<gongxi 或 facai>",
  "chatIds": ["main"],
  "cwd": "<DSH 工作区绝对路径>"
}
```

验收动作：围炉 UI 里 @恭喜 或 @发财 发一句话，看它：

1. DSH 里出现/复用会话（来源标记 `campfire`）；
2. 模型回复；
3. 回复回帖到围炉群。

> 发财（PC 端）连 NAS 围炉：`baseUrl` 用 NAS 地址即可，插件主动拉流，不需要隧道。

---

## 4. 第四步：验收 WorkBuddy 线（如意）

前提：Bearer token 文件已就位 `~/.campfire/secrets/workbuddy-bearer.txt`（1319 字符，28 天有效）。

```powershell
# 在 WorkBuddy 里「新建任务」建一个普通会话（不是 automation 跑出来的），
# 从 ~/.workbuddy/projects/<项目>/<sessionId>.jsonl 抄出 sessionId
```

在 `J:\campfire\.env` 写（`.env.example` 有完整注释）：

```ini
CAMPFIRE_BASE_URL=http://192.168.31.252:8099
CAMPFIRE_CHANNEL_TOKEN=<ruyi 的渠道 token>
CAMPFIRE_MEMBER=ruyi
WORKBUDDY_TOKEN_FILE=C:/Users/卿/.campfire/secrets/workbuddy-bearer.txt
WORKBUDDY_SESSION_ID=<新建任务的 sessionId>
WORKBUDDY_CWD=<那个会话的项目目录>
WORKBUDDY_CLI=D:/WorkBuddy-CN/resources/app.asar.unpacked/cli/bin/codebuddy
WORKBUDDY_CONFIG_DIR=C:/Users/卿/.workbuddy
```

起桥：

```bash
cd J:/campfire && npm run workbuddy
```

验收动作：围炉 UI 里 @如意 发一句话，看它：

1. 桥进程日志显示拉取→投递→回帖；
2. WorkBuddy 那个会话里出现回复；
3. 回复回帖到围炉群。

> 桥是独立进程，卡住了 `Ctrl+C` 停掉重来，围炉侧游标在服务端，不会重复。

---

## 5. 常见问题

| 现象 | 排查 |
|---|---|
| health 不通 | 容器没起；`docker compose logs campfire` |
| 登录口令错 | 环境变量 `CAMPFIRE_PASSWORD` 优先于 `data/owner-key.txt`，以 env 为准 |
| @了没反应 | `GET /api/status?chat=main` 看该成员 `presence.reachable`；DSH 插件/桥日志看有没有拉流 |
| 渠道 token 忘了 | 令牌只存 sha256，看不了明文；删了重建：`DELETE /api/admin/channels/:id` 再 POST 建新的 |
| WorkBuddy 回复进错会话 | `WORKBUDDY_SESSION_ID` 抄成 automation 会话了（`is_background_automation=1` 那条），换成「新建任务」建的 |
| 桥提示 token 401 | token 过期（28 天）或渠道被吊销；重新抓 token / 重建渠道 |

---

## 6. 验收后清理

- 验收期发的测试消息：围炉 UI 里删，或 `DELETE /api/messages/:id`；
- 桥进程 `Ctrl+C` 停；
- 想停围炉：`docker compose down`（数据在 `/vol2/@appdata/campfire/data`，不丢）。
