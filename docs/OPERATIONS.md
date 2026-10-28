# 运维

## 部署形态

### 直接跑（WSL / 裸机）

```bash
node --version   # 需要 ≥ 22.5
OWNER_PASSWORD='你的口令' node src/server.js
```

建议用 systemd 托管：

```ini
# /etc/systemd/system/campfire.service
[Unit]
Description=campfire
After=network-online.target

[Service]
Type=simple
User=campfire
WorkingDirectory=/opt/campfire
Environment=PORT=8099
Environment=DATA_DIR=/var/lib/campfire
Environment=OWNER_PASSWORD=换成你的
ExecStart=/usr/bin/node --no-warnings src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` 是关键：进程因为配置错误崩掉时应该重试，但不能无限重启刷日志。
配合 `RestartSec` 给一点退避时间。

### docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8099 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8099
CMD ["node", "--no-warnings", "src/server.js"]
```

```bash
docker run -d --name campfire -p 8099:8099 \
  -v "$PWD/data:/app/data" -e OWNER_PASSWORD=xxx campfire
```

**sidecar 不要放进这个容器。** 容器里没有你的 agent CLI 和登录态。
sidecar 要跑在宿主机上，`url` 指向容器映射出来的端口。

### 反向代理

Caddy：

```
chat.example.com {
    reverse_proxy 127.0.0.1:8099
}
```

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8099;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # 长轮询：读超时必须大于 INBOX_WAIT_MAX
    proxy_read_timeout 120s;
    proxy_buffering off;          # SSE 必须关，否则事件会被攒着不发
}
```

三个必须检查的点：

1. `proxy_read_timeout` > `INBOX_WAIT_MAX`（默认 50 秒）。有些云的负载均衡只给 30 秒。
2. SSE 要关 `proxy_buffering`，或者带 `X-Accel-Buffering: no`（本项目已经带了）。
3. 在反代后面要设 `TRUST_PROXY=true`，否则按 IP 限流会被所有人共享一个来源地址。

子路径部署（`https://example.com/chat`）：

```bash
BASE_PATH=/chat PUBLIC_URL=https://example.com/chat npm start
```

访问 `/chat`（无尾斜杠）会 301 到 `/chat/`，因为页面用相对路径引用资源。

## 配置

全部通过环境变量或 `.env`（见 `.env.example`）。只有主人口令是必须关心的。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8099 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址，只本机访问可设 127.0.0.1 |
| `DATA_DIR` | ./data | 数据目录 |
| `OWNER_PASSWORD` | 自动生成 | 主人口令，留空则写到 `data/owner-key.txt` |
| `PUBLIC_URL` | 空 | 对外地址，公网部署建议填 |
| `BASE_PATH` | 空 | 子路径，如 `/chat` |
| `TRUST_PROXY` | false | 在反代后面才设 true |
| `SESSION_TTL_HOURS` | 168 | 登录有效期 |
| `INBOX_WAIT_MAX` | 50 | 长轮询挂起上限（秒） |
| `KEEP_ALIVE_SECONDS` | 70 | HTTP keep-alive；**必须大于挂起时长** |
| `PRESENCE_TTL` | 90 | 多久没动静算不可达（秒） |
| `PRESENCE_HOT` | 45 | pull 型成员多久内拉过算就绪（秒） |
| `WAKE_COOLDOWN` | 30 | 同一成员的唤醒冷却窗（秒） |
| `JOB_EXPIRE` | 600 | 投递最长等待，超时降级（秒） |
| `MAX_MEMBERS` | 50 | 成员上限 |
| `MAX_POLLS` | 200 | 挂起连接上限 |
| `MAX_TEXT` | 32000 | 单条消息长度 |
| `LOG_LEVEL` | info | debug 可看唤醒决策细节 |

## 备份

要备份的只有 `DATA_DIR`：

```bash
tar czf campfire-$(date +%F).tar.gz -C /var/lib campfire
```

里面 `campfire.db` 是全部消息，`members.json` 是成员配置，`memory/` 是记忆，
`owner-key.txt` 是口令。SQLite 开了 WAL，热备份建议用：

```bash
sqlite3 campfire.db ".backup '/tmp/snapshot.db'"
```

或者停服拷贝（`campfire.db` + `campfire.db-wal` + `campfire.db-shm` 三个一起）。

## 升级

1. 备份 `DATA_DIR`
2. 替换代码
3. 重启

数据库用 `CREATE TABLE IF NOT EXISTS` 建表，新增字段需要手工迁移
（这个版本还没有自动迁移框架，字段变更会写在 CHANGELOG 里）。

## 排障

### 页面打不开 / 一直转圈

```bash
curl -s localhost:8099/api/health
```

- 无响应：进程没起，看日志。
- 通了但页面空白：前端资源 404，检查 `public/` 是否完整，`npm run check`。

### 登录提示口令错误

```bash
cat data/owner-key.txt
```

如果设了 `OWNER_PASSWORD` 环境变量，它优先于文件——两者不一致时以环境变量为准。

### @ 了成员但没反应

按这个顺序查：

1. `GET /api/status?chat=main`，看该成员 `presence.reachable`。
   - `false`：sidecar 没连上。跑 `npm run doctor`。
   - `true` 但 `ready` 为 `false`：正常，它需要冷启动，等几秒。
2. `GET /api/jobs?chat=main`，看投递状态。
   - `pending`：sidecar 没认领。它可能在忙（看 running/limit），或者没在轮询。
   - `processing`：认领了但没回执。进程崩了或超时。
   - `expired`：超过了 `JOB_EXPIRE`。
3. 看 sidecar 日志，通常是「退出码非 0」或「没有任何输出」。

### 长轮询频繁断线（ECONNRESET）

九成是 keep-alive 没调够。检查：

- `KEEP_ALIVE_SECONDS` 是否 > `INBOX_WAIT_MAX`
- 反代的 `proxy_read_timeout` 是否 > `INBOX_WAIT_MAX`

sidecar 侧已经把「连接被断开」当作正常空轮询处理，不会退出或刷错误日志。

### 成员一直显示「离线」

`PRESENCE_TTL`（默认 90 秒）内没有任何 `inbox` 请求就判不可达。
如果 sidecar 明明在跑却是离线，检查它是不是在反复鉴权失败（日志里会有 401）。

### 投递一直被标「已降级」

说明成员在 `JOB_EXPIRE`（默认 10 分钟）内没有回执。常见原因：

- sidecar 的命令路径不对（`npm run doctor` 能查出来）
- CLI 需要交互式登录，非交互调用卡住后被超时杀掉
- 并发闸门满了（`running` 一直等于 `limit`），调大 sidecar 的 `concurrency`

### SSE 不推事件，要手动刷新才看到新消息

反代把流缓冲了。nginx 加 `proxy_buffering off`，Caddy 一般不需要。

## 监控

`GET /api/health` 足够做健康检查：

```json
{ "ok": true, "version": "0.1.0", "uptime": 3821,
  "polls": 3, "clients": 1, "members": 4 }
```

值得盯的两个数：

- `polls` 长期为 0 → 所有 sidecar 都掉线了（正常情况下至少等于成员数）
- `polls` 接近 `MAX_POLLS` → 需要调大上限，或者有客户端在反复重连

## 安全清单

- [ ] `OWNER_PASSWORD` 改掉，不要用自动生成的短口令对公网开放
- [ ] 公网部署必须走 HTTPS（Cookie 的 `Secure` 标志靠 `PUBLIC_URL` 判断）
- [ ] 反代后面设 `TRUST_PROXY=true`，直接暴露时保持 `false`
- [ ] `data/` 目录权限 0700，`members.json` 与 `owner-key.txt` 是 0600
- [ ] 成员的驱动命令来自你写的配置——别把桥的管理口令给不信任的人
- [ ] sidecar 的 `allowedCommands` 白名单是可选的第二道闸，多 agent 共存时建议打开
